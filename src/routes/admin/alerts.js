'use strict';

const { adminRateLimit } = require('../../middleware/rateLimit');
const db = require('../../db');

module.exports = async function alertRoutes(fastify) {

  // List alerts — filterable by batch, serial, alert type, severity, resolved state
  fastify.get('/alerts', { preHandler: [adminRateLimit] }, async (request) => {
    const { resolved, severity, batch, serial, type, limit = '50', offset = '0' } = request.query;
    return db.getAlerts({
      resolved:  resolved !== undefined ? resolved === 'true' : undefined,
      severity:  severity   || undefined,
      batchCode: batch      || undefined,
      serial:    serial     || undefined,
      alertType: type       || undefined,
      limit:     Math.min(parseInt(limit, 10) || 50, 200),
      offset:    parseInt(offset, 10) || 0,
    });
  });

  // Resolve a single alert by ID
  fastify.post('/alerts/:id/resolve', { preHandler: [adminRateLimit] }, async (request) => {
    const { id } = request.params;
    await db.resolveAlert(id);
    db.logAuditAction('RESOLVE_ALERT', 'alert', id, null).catch(() => {});
    return { success: true };
  });

  // Dismiss all unresolved alerts for a specific serial (ignore this QR)
  fastify.post('/alerts/resolve-by-serial', { preHandler: [adminRateLimit] }, async (request, reply) => {
    const { serial } = request.body || {};
    if (!serial) return reply.code(400).send({ error: 'serial is required', code: 'MISSING_PARAM' });
    await db.resolveAlertsBySerial(serial);
    db.logAuditAction('DISMISS_SERIAL_ALERTS', 'serial', serial, null).catch(() => {});
    return { success: true };
  });

  // Dismiss all unresolved alerts for an entire batch
  fastify.post('/alerts/resolve-by-batch', { preHandler: [adminRateLimit] }, async (request, reply) => {
    const { batch_code } = request.body || {};
    if (!batch_code) return reply.code(400).send({ error: 'batch_code is required', code: 'MISSING_PARAM' });
    await db.resolveAlertsByBatch(batch_code);
    db.logAuditAction('DISMISS_BATCH_ALERTS', 'batch', batch_code, null).catch(() => {});
    return { success: true };
  });
};
