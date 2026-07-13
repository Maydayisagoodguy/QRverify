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

    const { products, warnings } = result;
    if (!products.length) {
      return reply.code(400).send({ error: 'No valid rows found in Excel', code: 'EMPTY', warnings });
    }

    // Bulk insert into Supabase
    try {
      await db.insertProducts(products);
    } catch (err) {
      request.log.error({ err }, 'DB insert failed');
      return reply.code(500).send({ error: 'Database error during insert', code: 'DB_ERROR' });
    }

    // Group by batch for response
    const batches = {};
    for (const p of products) {
      if (!batches[p.batch_code]) {
        batches[p.batch_code] = { batch_code: p.batch_code, product_name: p.product_name, count: 0 };
      }
      batches[p.batch_code].count++;
    }

    return {
      success:  true,
      total:    products.length,
      batches:  Object.values(batches),
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

    // buildZip pipes directly to reply.raw and finalizes
    await buildZip(products, reply);
  });

};
