'use strict';

const adminAuth = require('../../middleware/adminAuth');
const db        = require('../../db');

module.exports = async function batchRoutes(fastify) {

  fastify.get('/batches', { preHandler: [adminAuth] }, async () => {
    return db.getBatches();
  });

  fastify.post('/products/deactivate', { preHandler: [adminAuth] }, async (request, reply) => {
    const { serial, batch_code } = request.body || {};

    if (serial)     await db.deactivateBySerial(serial);
    else if (batch_code) await db.deactivateByBatch(batch_code);
    else return reply.code(400).send({ error: 'Provide serial or batch_code', code: 'MISSING_PARAM' });

    return { success: true };
  });
};
