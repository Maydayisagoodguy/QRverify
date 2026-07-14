'use strict';

const adminAuth = require('../../middleware/adminAuth');
const db        = require('../../db');
const { processExcel, buildZip } = require('../../services/qrgen');

module.exports = async function uploadRoutes(fastify) {

  // POST /admin/upload — accepts multipart Excel file
  fastify.post('/upload', {
    preHandler: [adminAuth],
  }, async (request, reply) => {
    const data = await request.file();
    if (!data) return reply.code(400).send({ error: 'No file uploaded', code: 'NO_FILE' });

    const ext = data.filename.split('.').pop().toLowerCase();
    if (!['xlsx', 'xls'].includes(ext)) {
      return reply.code(400).send({ error: 'Only .xlsx and .xls files accepted', code: 'INVALID_TYPE' });
    }

    const chunks = [];
    for await (const chunk of data.file) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    let result;
    try {
      result = await processExcel(buffer);
    } catch (err) {
      return reply.code(400).send({ error: err.message, code: 'PARSE_ERROR' });
    }

    const { batches, products, warnings } = result;
    if (!products.length) {
      return reply.code(400).send({ error: 'No valid rows found in Excel', code: 'EMPTY', warnings });
    }

    // 1. Upsert batch rows first (products FK references batch_code)
    for (const batchMeta of batches.values()) {
      try {
        await db.upsertBatch(batchMeta);
      } catch (err) {
        request.log.error({ err }, 'Batch upsert failed');
        return reply.code(500).send({ error: 'Database error creating batch', code: 'DB_ERROR' });
      }
    }

    // 2. Bulk insert products
    try {
      await db.insertProducts(products);
    } catch (err) {
      request.log.error({ err }, 'Product insert failed');
      return reply.code(500).send({ error: 'Database error during insert', code: 'DB_ERROR' });
    }

    // 3. Log the upload action for audit trail
    for (const batchMeta of batches.values()) {
      db.logAuditAction('UPLOAD_BATCH', 'batch', batchMeta.batchCode, {
        totalUnits: products.filter(p => p.batch_code === batchMeta.batchCode).length,
        productName: batchMeta.productName,
      }).catch(() => {});
    }

    // Summary for response
    const batchSummary = [];
    for (const [code, meta] of batches) {
      batchSummary.push({
        batch_code:   code,
        product_name: meta.productName,
        count:        products.filter(p => p.batch_code === code).length,
      });
    }

    return {
      success:  true,
      total:    products.length,
      batches:  batchSummary,
      warnings,
    };
  });

  // GET /admin/batches/:code/export — stream ZIP of QR PNGs
  fastify.get('/batches/:code/export', {
    preHandler: [adminAuth],
  }, async (request, reply) => {
    const { code } = request.params;

    const products = await db.getBatchProductsForExport(code);
    if (!products.length) {
      return reply.code(404).send({ error: 'Batch not found or empty', code: 'NOT_FOUND' });
    }

    await buildZip(products, reply);
  });

};
