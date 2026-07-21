'use strict';

const adminAuth = require('../../middleware/adminAuth');
const { adminRateLimit } = require('../../middleware/rateLimit');
const db        = require('../../db');

module.exports = async function serialRoutes(fastify) {

  // GET /admin/batches/:code — batch detail + stats
  fastify.get('/batches/:code', {
    preHandler: [adminRateLimit, adminAuth],
  }, async (request, reply) => {
    const { code } = request.params;
    const detail = await db.getBatchDetail(code);
    if (!detail) return reply.code(404).send({ error: 'Batch not found', code: 'NOT_FOUND' });
    return detail;
  });

  // GET /admin/batches/:code/serials — list all serials with scan count + remark
  fastify.get('/batches/:code/serials', {
    preHandler: [adminRateLimit, adminAuth],
  }, async (request, reply) => {
    const { code } = request.params;
    const { remark } = request.query;
    try {
      return await db.getSerialsByBatch(code, { remarkFilter: remark || null });
    } catch (err) {
      request.log.error({ err }, 'getSerialsByBatch failed');
      return reply.code(500).send({ error: 'Database error', code: 'DB_ERROR' });
    }
  });

  // GET /admin/batches/:code/remarks — distinct remark values for dropdown
  fastify.get('/batches/:code/remarks', {
    preHandler: [adminRateLimit, adminAuth],
  }, async (request, reply) => {
    const { code } = request.params;
    try {
      return await db.getDistinctRemarks(code);
    } catch (err) {
      request.log.error({ err }, 'getDistinctRemarks failed');
      return reply.code(500).send({ error: 'Database error', code: 'DB_ERROR' });
    }
  });

  // POST /admin/batches/:code/serials/remark — apply remark to a seq range
  fastify.post('/batches/:code/serials/remark', {
    preHandler: [adminRateLimit, adminAuth],
  }, async (request, reply) => {
    const { code }                    = request.params;
    const { from_seq, to_seq, remark } = request.body || {};

    if (!from_seq || !to_seq || !remark) {
      return reply.code(400).send({ error: 'from_seq, to_seq and remark are required', code: 'MISSING_PARAM' });
    }
    if (Number(from_seq) > Number(to_seq)) {
      return reply.code(400).send({ error: 'from_seq must be ≤ to_seq', code: 'INVALID_RANGE' });
    }
    if (String(remark).trim().length === 0) {
      return reply.code(400).send({ error: 'remark cannot be empty', code: 'EMPTY_REMARK' });
    }

    try {
      await db.applyRemarkToRange(code, Number(from_seq), Number(to_seq), String(remark).trim());
    } catch (err) {
      request.log.error({ err }, 'applyRemarkToRange failed');
      return reply.code(500).send({ error: 'Database error', code: 'DB_ERROR' });
    }

    db.logAuditAction('ADD_REMARK', 'batch', code, { from_seq, to_seq, remark }).catch(() => {});
    return { success: true };
  });

  // DELETE /admin/batches/:code/serials/remark — clear remark for a seq range
  fastify.delete('/batches/:code/serials/remark', {
    preHandler: [adminRateLimit, adminAuth],
  }, async (request, reply) => {
    const { code }              = request.params;
    const { from_seq, to_seq }  = request.body || {};

    if (!from_seq || !to_seq) {
      return reply.code(400).send({ error: 'from_seq and to_seq are required', code: 'MISSING_PARAM' });
    }

    try {
      await db.clearRemarkRange(code, Number(from_seq), Number(to_seq));
    } catch (err) {
      request.log.error({ err }, 'clearRemarkRange failed');
      return reply.code(500).send({ error: 'Database error', code: 'DB_ERROR' });
    }

    db.logAuditAction('CLEAR_REMARK', 'batch', code, { from_seq, to_seq }).catch(() => {});
    return { success: true };
  });

};
