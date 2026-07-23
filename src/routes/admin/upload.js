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

    // Global seq counter — guarantees serial uniqueness across all batches
    let globalSeq;
    try {
      globalSeq = await db.getMaxGlobalSeq();
    } catch (err) {
      request.log.error({ err }, 'getMaxGlobalSeq failed');
      return reply.code(500).send({ error: 'Database error', code: 'DB_ERROR' });
    }

    for (const p of products) {
      globalSeq++;
      p.seq    = globalSeq;
      p.serial = buildSerial(p.batch_code, globalSeq);
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
        from_seq:     bp[0]?.seq || 0,
        to_seq:       bp[bp.length - 1]?.seq || 0,
      });
    }

    return { success: true, total: products.length, batches: batchSummary, warnings };
  });

  // Old direct-download route replaced by SSE job flow in pdf.js
  // Returning 410 Gone so any cached links fail fast instead of hanging
  fastify.get('/batches/:code/export', async (request, reply) => {
    return reply.code(410).send({
      error: 'This endpoint is no longer available. Use the Download PDF button on the batch page.',
      code: 'GONE',
    });
  });

};
