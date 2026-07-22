'use strict';

const { adminRateLimit } = require('../../middleware/rateLimit');
const db = require('../../db');
const { processExcel, buildPDF, buildSerial, generateHMAC, formatSeq } = require('../../services/qrgen');

module.exports = async function uploadRoutes(fastify) {

  fastify.post('/upload', {
    preHandler: [adminRateLimit],
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

    for (const batchMeta of batches.values()) {
      try {
        await db.upsertBatch(batchMeta);
      } catch (err) {
        request.log.error({ err }, 'Batch upsert failed');
        return reply.code(500).send({ error: 'Database error creating batch', code: 'DB_ERROR' });
      }
    }

    const batchMaxSeq     = {};
    const batchRelCounter = {};
    for (const [code] of batches) {
      batchMaxSeq[code] = await db.getMaxSeq(code);
    }

    for (const p of products) {
      const code = p.batch_code;
      batchRelCounter[code] = (batchRelCounter[code] || 0) + 1;
      const finalSeq = batchMaxSeq[code] + batchRelCounter[code];
      p.seq    = finalSeq;
      p.serial = buildSerial(code, finalSeq);
      p.hmac   = generateHMAC(p.serial);
      delete p._relSeq;
    }

    try {
      await db.insertProducts(products);
    } catch (err) {
      request.log.error({ err }, 'Product insert failed');
      return reply.code(500).send({ error: 'Database error during insert', code: 'DB_ERROR' });
    }

    for (const batchMeta of batches.values()) {
      db.logAuditAction('UPLOAD_BATCH', 'batch', batchMeta.batchCode, {
        totalUnits: products.filter(p => p.batch_code === batchMeta.batchCode).length,
        productName: batchMeta.productName,
      }).catch(() => {});
    }

    const batchSummary = [];
    for (const [code, meta] of batches) {
      const bp = products.filter(p => p.batch_code === code);
      batchSummary.push({
        batch_code:   code,
        product_name: meta.productName,
        count:        bp.length,
        from_seq:     formatSeq(bp[0]?.seq || 0),
        to_seq:       formatSeq(bp[bp.length - 1]?.seq || 0),
      });
    }

    return { success: true, total: products.length, batches: batchSummary, warnings };
  });

  fastify.get('/batches/:code/export', {
    preHandler: [adminRateLimit],
  }, async (request, reply) => {
    const { code } = request.params;
    const products = await db.getBatchProductsForExport(code);
    if (!products.length) {
      return reply.code(404).send({ error: 'Batch not found or empty', code: 'NOT_FOUND' });
    }

    const buffer = await buildPDF(products);
    return reply
      .type('application/pdf')
      .header('Content-Disposition', `attachment; filename="${code}-stickers.pdf"`)
      .send(buffer);
  });

};
