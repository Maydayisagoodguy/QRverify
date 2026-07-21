'use strict';

require('dotenv').config();

// Polyfill WebSocket for Node.js < 21 (required by @supabase/realtime-js)
if (!globalThis.WebSocket) {
  globalThis.WebSocket = require('ws');
}

const path    = require('path');
const config  = require('./config');
const fastify = require('fastify')({ logger: true, trustProxy: true });

// ── Security headers ──────────────────────────────────────────────
fastify.register(require('@fastify/helmet'), {
  contentSecurityPolicy: {
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'", "'unsafe-inline'", 'https://unpkg.com'],
      styleSrc:       ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://unpkg.com'],
      fontSrc:        ["'self'", 'https://fonts.gstatic.com'],
      imgSrc:         ["'self'", 'data:', 'https:', 'blob:'],
      connectSrc:     ["'self'", 'https://fonts.googleapis.com', 'https://fonts.gstatic.com', 'https://unpkg.com'],
      scriptSrcAttr:  ["'unsafe-inline'"],
      frameSrc:       ["'none'"],
      objectSrc:      ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  crossOriginEmbedderPolicy: false,  // needed for Leaflet map tiles
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  frameguard: { action: 'deny' },
  xContentTypeOptions: true,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
});

// ── Plugins ───────────────────────────────────────────────────────
fastify.register(require('@fastify/static'), {
  root:   path.join(__dirname, '..', 'public'),
  prefix: '/',
  decorateReply: true,
});

fastify.register(require('@fastify/multipart'), {
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

// ── HTML page routes ──────────────────────────────────────────────
fastify.get('/', async (req, reply) => reply.redirect('/admin'));
fastify.get('/admin', async (req, reply) => reply.redirect('/admin/'));

fastify.get('/admin/', async (req, reply) => reply.sendFile('admin/index.html'));
fastify.get('/admin/upload', async (req, reply) => reply.sendFile('admin/upload.html'));
fastify.get('/admin/batch/:code', async (req, reply) => reply.sendFile('admin/batch-detail.html'));

// Consumer result page — tell crawlers/bots not to index these
fastify.get('/result/:serial', async (req, reply) => {
  reply.header('X-Robots-Tag', 'noindex, nofollow, noarchive');
  return reply.sendFile('result.html');
});

// ── API routes ────────────────────────────────────────────────────
fastify.register(require('./routes/consumer/verify'),  { prefix: '/v' });
fastify.register(require('./routes/consumer/product'), { prefix: '/api' });
fastify.register(require('./routes/admin/upload'),     { prefix: '/admin' });
fastify.register(require('./routes/admin/generate'),   { prefix: '/admin' });
fastify.register(require('./routes/admin/serials'),    { prefix: '/admin' });
fastify.register(require('./routes/admin/batches'),    { prefix: '/admin' });
fastify.register(require('./routes/admin/scans'),      { prefix: '/admin' });
fastify.register(require('./routes/admin/alerts'),     { prefix: '/admin' });
fastify.register(require('./routes/admin/analytics'),  { prefix: '/admin' });
fastify.register(require('./routes/admin/config'),     { prefix: '/admin' });

// ── Health check ──────────────────────────────────────────────────
fastify.get('/health', async () => ({ status: 'ok' }));

// ── Error handler ─────────────────────────────────────────────────
fastify.setErrorHandler((err, request, reply) => {
  request.log.error({ err }, 'Unhandled error');
  reply.code(err.statusCode || 500).send({
    error: config.nodeEnv === 'production' ? 'Internal server error' : err.message,
    code: 'SERVER_ERROR',
  });
});

// ── Start ─────────────────────────────────────────────────────────
fastify.listen({ port: config.port, host: '0.0.0.0' }, (err) => {
  if (err) { fastify.log.error(err); process.exit(1); }
});
