'use strict';

const { adminRateLimit } = require('../../middleware/rateLimit');
const db = require('../../db');

module.exports = async function scanRoutes(fastify) {

  fastify.get('/scans', { preHandler: [adminRateLimit] }, async (request) => {
    const { result, batch, from, to, limit = '100', offset = '0', sort, dir } = request.query;
    return db.getScanLogs({
      result:    result || undefined,
      batchCode: batch  || undefined,
      from:      from   || undefined,
      to:        to     || undefined,
      limit:     Math.min(parseInt(limit, 10) || 100, 500),
      offset:    parseInt(offset, 10) || 0,
      sort:      sort   || undefined,
      dir:       dir    || undefined,
    });
  });
};
