'use strict';

const adminAuth = require('../../middleware/adminAuth');
const { adminRateLimit } = require('../../middleware/rateLimit');
const db        = require('../../db');

module.exports = async function analyticsRoutes(fastify) {

  fastify.get('/analytics', { preHandler: [adminRateLimit, adminAuth] }, async () => {
    return db.getAnalyticsSummary();
  });

  fastify.get('/analytics/map-data', { preHandler: [adminRateLimit, adminAuth] }, async (request) => {
    const { limit = '500' } = request.query;
    return db.getMapData(Math.min(parseInt(limit, 10) || 500, 2000));
  });

  fastify.get('/analytics/geo', { preHandler: [adminRateLimit, adminAuth] }, async () => {
    return db.getGeoSummary();
  });

  fastify.get('/analytics/isp', { preHandler: [adminRateLimit, adminAuth] }, async () => {
    return db.getISPSummary();
  });

  fastify.get('/analytics/batches', { preHandler: [adminRateLimit, adminAuth] }, async () => {
    return db.getBatchScanSummary();
  });

  fastify.get('/analytics/serials', { preHandler: [adminRateLimit, adminAuth] }, async (request, reply) => {
    const { batch, limit = '30' } = request.query;
    if (!batch) return reply.code(400).send({ error: 'batch query param required', code: 'MISSING_PARAM' });
    return db.getTopScannedSerials(batch, Math.min(parseInt(limit, 10) || 30, 100));
  });
};
