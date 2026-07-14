'use strict';

const crypto = require('crypto');
const config = require('../config');

// Timing-safe comparison — prevents key length leakage via response time
function safeCompare(a, b) {
  try {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ba.length !== bb.length) {
      // Compare anyway to avoid early-exit timing leak
      crypto.timingSafeEqual(ba, Buffer.alloc(ba.length));
      return false;
    }
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

async function adminAuth(request, reply) {
  const key = request.headers['x-admin-key'];
  if (!key || !safeCompare(key, config.adminApiKey)) {
    return reply.code(401).send({ error: 'Unauthorized', code: 'INVALID_KEY' });
  }
}

module.exports = adminAuth;
