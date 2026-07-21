'use strict';

const { adminRateLimit } = require('../../middleware/rateLimit');
const db = require('../../db');

module.exports = async function serialRoutes(fastify) {

  fastify.get('/batches/:code', {
    preHandler: [adminRateLimit],
  }, async (request, reply) => {
    const { code } = request.params;
    const detail = await db.getBatchDetail(code);
    if (!detail) return reply.code(404).send({ error: 'Batch not found', code: 'NOT_FOUND' });
    return detail;
  });

  fastify.get('/batches/:code/serials', {
    preHandler: [adminRateLimit],
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

  fastify.get('/batches/:code/remarks', {
    preHandler: [adminRateLimit],
  }, async (request, reply) => {
    const { code } = request.params;
    try {
      return await db.getDistinctRemarks(code);
    } catch (err) {
      request.log.error({ err }, 'getDistinctRemarks failed');
      return reply.code(500).send({ error: 'Database error', code: 'DB_ERROR' });
    }
  });

  fastify.post('/batches/:code/serials/remark', {
    preHandler: [adminRateLimit],
  }, async (request, reply) => {
    const { code }                     = request.params;
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

  fastify.get('/batches/:code/serial-limits', {
    preHandler: [adminRateLimit],
  }, async (request, reply) => {
    const { code } = request.params;
    try {
      return await db.getSerialLimitGroups(code);
    } catch (err) {
      request.log.error({ err }, 'getSerialLimitGroups failed');
      return reply.code(500).send({ error: 'Database error', code: 'DB_ERROR' });
    }
  });

  fastify.post('/batches/:code/serials/scan-limit', {
    preHandler: [adminRateLimit],
  }, async (request, reply) => {
    const { code }                    = request.params;
    const { from_seq, to_seq, limit } = request.body || {};

    if (!from_seq || !to_seq || limit === undefined) {
      return reply.code(400).send({ error: 'from_seq, to_seq and limit are required', code: 'MISSING_PARAM' });
    }
    if (Number(from_seq) > Number(to_seq)) {
      return reply.code(400).send({ error: 'from_seq must be ≤ to_seq', code: 'INVALID_RANGE' });
    }
    const num = parseInt(limit, 10);
    if (isNaN(num) || num < 1 || num > 999) {
      return reply.code(400).send({ error: 'limit must be 1–999', code: 'INVALID_VALUE' });
    }

    try {
      await db.setScanLimitForRange(code, Number(from_seq), Number(to_seq), num);
    } catch (err) {
      request.log.error({ err }, 'setScanLimitForRange failed');
      return reply.code(500).send({ error: 'Database error', code: 'DB_ERROR' });
    }

    db.logAuditAction('SET_SERIAL_SCAN_LIMIT', 'batch', code, { from_seq, to_seq, limit: num }).catch(() => {});
    return { success: true };
  });

  fastify.delete('/batches/:code/serials/scan-limit', {
    preHandler: [adminRateLimit],
  }, async (request, reply) => {
    const { code }             = request.params;
    const { from_seq, to_seq } = request.body || {};

    if (!from_seq || !to_seq) {
      return reply.code(400).send({ error: 'from_seq and to_seq are required', code: 'MISSING_PARAM' });
    }

    try {
      await db.clearScanLimitForRange(code, Number(from_seq), Number(to_seq));
    } catch (err) {
      request.log.error({ err }, 'clearScanLimitForRange failed');
      return reply.code(500).send({ error: 'Database error', code: 'DB_ERROR' });
    }

    db.logAuditAction('CLEAR_SERIAL_SCAN_LIMIT', 'batch', code, { from_seq, to_seq }).catch(() => {});
    return { success: true };
  });

  fastify.delete('/batches/:code/serials/remark', {
    preHandler: [adminRateLimit],
  }, async (request, reply) => {
    const { code }             = request.params;
    const { from_seq, to_seq } = request.body || {};

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
