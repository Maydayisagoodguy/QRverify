'use strict';

const { adminRateLimit } = require('../../middleware/rateLimit');
const db = require('../../db');

module.exports = async function batchRoutes(fastify) {

  fastify.get('/batches', { preHandler: [adminRateLimit] }, async () => {
    return db.getBatches();
  });

  // Paginated batch list for the Batches page (search + 20/page)
  fastify.get('/batches/page', { preHandler: [adminRateLimit] }, async (request, reply) => {
    const { page = '1', limit = '20', search = '' } = request.query;
    const pg  = Math.max(1, parseInt(page, 10) || 1);
    const lim = Math.min(Math.max(1, parseInt(limit, 10) || 20), 100);
    try {
      return await db.getBatchesPage({ page: pg, limit: lim, search: search.trim() || null });
    } catch (err) {
      request.log.error({ err }, 'getBatchesPage failed');
      return reply.code(500).send({ error: 'Database error', code: 'DB_ERROR' });
    }
  });

  // Suggest the next professional batch code (FM-YYYYMM-NNN) for the Generate modal
  fastify.get('/batches/suggest-code', { preHandler: [adminRateLimit] }, async (request, reply) => {
    try {
      return { code: await db.suggestNextBatchCode() };
    } catch (err) {
      request.log.error({ err }, 'suggestNextBatchCode failed');
      return reply.code(500).send({ error: 'Database error', code: 'DB_ERROR' });
    }
  });

  // Distinct remarks across all batches, with the batches + serial counts carrying each
  fastify.get('/remarks-summary', { preHandler: [adminRateLimit] }, async (request, reply) => {
    try {
      return await db.getRemarksSummary();
    } catch (err) {
      request.log.error({ err }, 'getRemarksSummary failed');
      return reply.code(500).send({ error: 'Database error', code: 'DB_ERROR' });
    }
  });

  fastify.post('/products/deactivate', { preHandler: [adminRateLimit] }, async (request, reply) => {
    const { serial, batch_code } = request.body || {};

    if (serial) {
      await db.deactivateBySerial(serial);
      db.logAuditAction('RECALL_PRODUCT', 'product', serial, null).catch(() => {});
    } else if (batch_code) {
      await db.deactivateByBatch(batch_code);
      db.logAuditAction('RECALL_BATCH', 'batch', batch_code, null).catch(() => {});
    } else {
      return reply.code(400).send({ error: 'Provide serial or batch_code', code: 'MISSING_PARAM' });
    }

    return { success: true };
  });
};
