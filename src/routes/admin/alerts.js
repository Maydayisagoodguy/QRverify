'use strict';

const adminAuth = require('../../middleware/adminAuth');
const db        = require('../../db');

module.exports = async function alertRoutes(fastify) {

  fastify.get('/alerts', { preHandler: [adminAuth] }, async (request) => {
    const { resolved, severity, limit = '50', offset = '0' } = request.query;
    return db.getAlerts({
      resolved:  resolved !== undefined ? resolved === 'true' : undefined,
      severity:  severity || undefined,
      limit:     Math.min(parseInt(limit, 10) || 50, 200),
      offset:    parseInt(offset, 10) || 0,
    });
  });

  fastify.post('/alerts/:id/resolve', { preHandler: [adminAuth] }, async (request) => {
    const { id } = request.params;
    await db.resolveAlert(id);
    db.logAuditAction('RESOLVE_ALERT', 'alert', id, null).catch(() => {});
    return { success: true };
  });
};
