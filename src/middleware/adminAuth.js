'use strict';

const config = require('../config');

async function adminAuth(request, reply) {
  const key = request.headers['x-admin-key'];
  if (!key || key !== config.adminApiKey) {
    return reply.code(401).send({ error: 'Unauthorized', code: 'INVALID_KEY' });
  }
}

module.exports = adminAuth;
