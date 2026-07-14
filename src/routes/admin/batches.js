'use strict';

const adminAuth = require('../../middleware/adminAuth');
const { adminRateLimit } = require('../../middleware/rateLimit');
const db        = require('../../db');

module.exports = async function batchRoutes(fastify) {

  fastify.get('/batches', { preHandler: [adminRateLimit, adminAuth] }, async () => {
    return db.getBatches();
  });

  fastify.post('/products/deactivate', { preHandler: [adminRateLimit, adminAuth] }, async (request, reply) => {
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
