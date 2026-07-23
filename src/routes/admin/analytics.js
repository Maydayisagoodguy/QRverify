'use strict';

const { adminRateLimit } = require('../../middleware/rateLimit');
const db = require('../../db');

module.exports = async function analyticsRoutes(fastify) {

  fastify.get('/analytics', { preHandler: [adminRateLimit] }, async () => {
    return db.getAnalyticsSummary();
  });

  fastify.get('/analytics/map-data', { preHandler: [adminRateLimit] }, async (request) => {
    const { limit = '500', batch = '' } = request.query;
    return db.getMapData(Math.min(parseInt(limit, 10) || 500, 2000), batch || null);
  });

  fastify.get('/analytics/geo', { preHandler: [adminRateLimit] }, async (request) => {
    const { batch } = request.query;
    return db.getGeoSummary(batch || null);
  });

  fastify.get('/analytics/isp', { preHandler: [adminRateLimit] }, async () => {
    return db.getISPSummary();
  });

  fastify.get('/analytics/batches', { preHandler: [adminRateLimit] }, async () => {
    return db.getBatchScanSummary();
  });

  fastify.get('/analytics/serials', { preHandler: [adminRateLimit] }, async (request, reply) => {
    const { batch, limit = '30' } = request.query;
    if (!batch) return reply.code(400).send({ error: 'batch query param required', code: 'MISSING_PARAM' });
    return db.getTopScannedSerials(batch, Math.min(parseInt(limit, 10) || 30, 100));
  });

  fastify.get('/analytics/network', { preHandler: [adminRateLimit] }, async (request, reply) => {
    const { batch } = request.query;
    if (!batch) return reply.code(400).send({ error: 'batch query param required', code: 'MISSING_PARAM' });
    return db.getSerialNetworkData(batch);
  });
};
