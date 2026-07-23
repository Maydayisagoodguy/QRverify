'use strict';

const { verifyResultToken } = require('../../services/qrgen');

module.exports = async function resultApiRoutes(fastify) {
  fastify.get('/r', async (request, reply) => {
    const { t } = request.query;
    const data = verifyResultToken(t);
    if (!data) {
      return reply.code(401).send({ error: 'Invalid or expired token', code: 'TOKEN_INVALID' });
    }
    return { status: data.status, scans: data.scans, remark: data.remark };
  });
};
