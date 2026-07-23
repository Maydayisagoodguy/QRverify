'use strict';

const { adminRateLimit } = require('../../middleware/rateLimit');
const db = require('../../db');

module.exports = async function configRoutes(fastify) {

  fastify.get('/config', { preHandler: [adminRateLimit] }, async () => {
    const [scanLimitStr, batches] = await Promise.all([
      db.getConfigValue('scan_limit_default', '1'),
      db.getBatches(),
    ]);
    // Count overrides per batch (exact head-counts — avoids the 1000-row cap)
    const overrideCount = await db.getSerialOverrideCounts(batches.map(b => b.batch_code));

    return {
      scan_limit_default: parseInt(scanLimitStr || '1', 10) || 1,
      batches: batches.map(b => ({
        batch_code:       b.batch_code,
        product_name:     b.product_name,
        total:            b.total,
        scan_limit:       b.scan_limit ?? null,
        serial_overrides: overrideCount[b.batch_code] || 0,
      })),
    };
  });

  fastify.post('/config', { preHandler: [adminRateLimit] }, async (request, reply) => {
    const { key, value } = request.body || {};
    if (!key || value === undefined) {
      return reply.code(400).send({ error: 'key and value required', code: 'MISSING_PARAM' });
    }
    const allowed = ['scan_limit_default'];
    if (!allowed.includes(key)) {
      return reply.code(400).send({ error: 'Unknown config key', code: 'INVALID_KEY' });
    }
    const num = parseInt(value, 10);
    if (isNaN(num) || num < 1 || num > 999) {
      return reply.code(400).send({ error: 'Value must be 1–999', code: 'INVALID_VALUE' });
    }
    await db.setConfigValue(key, String(num));
    db.logAuditAction('SET_CONFIG', 'config', key, { value: num }).catch(() => {});
    return { success: true, key, value: num };
  });

  fastify.patch('/batches/:code/scan-limit', { preHandler: [adminRateLimit] }, async (request, reply) => {
    const { code } = request.params;
    const { scan_limit } = request.body || {};

    if (scan_limit === null || scan_limit === undefined || scan_limit === '') {
      await db.setScanLimitForBatch(code, null);
      db.logAuditAction('SET_BATCH_SCAN_LIMIT', 'batch', code, { scan_limit: null }).catch(() => {});
      return { success: true, batch_code: code, scan_limit: null };
    }

    const num = parseInt(scan_limit, 10);
    if (isNaN(num) || num < 1 || num > 999) {
      return reply.code(400).send({ error: 'Scan limit must be 1–999', code: 'INVALID_VALUE' });
    }

    await db.setScanLimitForBatch(code, num);
    db.logAuditAction('SET_BATCH_SCAN_LIMIT', 'batch', code, { scan_limit: num }).catch(() => {});
    return { success: true, batch_code: code, scan_limit: num };
  });
};
