'use strict';

const { Redis } = require('@upstash/redis');
const config = require('../config');

let redis;
function getRedis() {
  if (!redis && config.upstashRedisUrl && config.upstashRedisToken) {
    redis = new Redis({ url: config.upstashRedisUrl, token: config.upstashRedisToken });
  }
  return redis;
}

// Sliding window: max 20 scan requests per minute per IP
async function verifyRateLimit(request, reply) {
  const client = getRedis();
  if (!client) return; // Skip if Redis not configured (dev mode)

  const ip  = request.ip || 'unknown';
  const key = `rl:verify:${ip}`;

  try {
    const count = await client.incr(key);
    if (count === 1) await client.expire(key, 60);
    if (count > 20) {
      return reply.code(429).send({ error: 'Rate limit exceeded', code: 'RATE_LIMITED' });
    }
  } catch (err) {
    // Fail open — don't block users if Redis is down
    request.log.warn({ err }, 'Rate limit check failed');
  }
}

// Stricter limit for bulk operations: 5 per minute per IP (bot detection)
async function strictRateLimit(request, reply) {
  const client = getRedis();
  if (!client) return;

  const ip  = request.ip || 'unknown';
  const key = `rl:strict:${ip}`;

  try {
    const count = await client.incr(key);
    if (count === 1) await client.expire(key, 60);
    if (count > 5) {
      return reply.code(429).send({ error: 'Rate limit exceeded', code: 'RATE_LIMITED' });
    }
  } catch (err) {
    request.log.warn({ err }, 'Rate limit check failed');
  }
}

// Admin endpoints: 60 req/min per IP
async function adminRateLimit(request, reply) {
  const client = getRedis();
  if (!client) return;

  const ip  = request.ip || 'unknown';
  const key = `rl:admin:${ip}`;

  try {
    const count = await client.incr(key);
    if (count === 1) await client.expire(key, 60);
    if (count > 60) {
      return reply.code(429).send({ error: 'Rate limit exceeded', code: 'RATE_LIMITED' });
    }
  } catch (err) {
    request.log.warn({ err }, 'Admin rate limit check failed');
  }
}

module.exports = { verifyRateLimit, strictRateLimit, adminRateLimit };
