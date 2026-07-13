'use strict';

const adminAuth = require('../../middleware/adminAuth');
const db        = require('../../db');

module.exports = async function analyticsRoutes(fastify) {

  fastify.get('/analytics', { preHandler: [adminAuth] }, async () => {
    return db.getAnalyticsSummary();
  });

  fastify.get('/analytics/map-data', { preHandler: [adminAuth] }, async (request) => {
    const { limit = '500' } = request.query;
    return db.getMapData(Math.min(parseInt(limit, 10) || 500, 2000));
  });
};
