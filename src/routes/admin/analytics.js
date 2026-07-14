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
};
