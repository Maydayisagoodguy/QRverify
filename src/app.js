'use strict';

require('dotenv').config();

// Polyfill WebSocket for Node.js < 21 (required by @supabase/realtime-js)
if (!globalThis.WebSocket) {
  globalThis.WebSocket = require('ws');
}

const path = require('path');
const fs   = require('fs');
const fastify = require('fastify')({ logger: true, trustProxy: true });
const config  = require('./config');

// ── Inject admin key into HTML at serve time (no manual login needed) ──
function injectKey(file) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');
  return html.replace(
    '</head>',
    `<script>window.__ADMIN_KEY__=${JSON.stringify(config.adminApiKey)};</script></head>`
  );
}

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
fastify.get('/',             async (req, reply) => reply.redirect('/admin'));
fastify.get('/admin',        async (req, reply) => reply.redirect('/admin/'));
fastify.get('/admin/',       async (req, reply) => reply.type('text/html').send(injectKey('admin/index.html')));
fastify.get('/admin/upload', async (req, reply) => reply.type('text/html').send(injectKey('admin/upload.html')));
fastify.get('/result/:serial', async (req, reply) => reply.sendFile('result.html'));

// ── API routes ────────────────────────────────────────────────────
fastify.register(require('./routes/consumer/verify'),  { prefix: '/v' });
fastify.register(require('./routes/consumer/product'), { prefix: '/api' });
fastify.register(require('./routes/admin/upload'),     { prefix: '/admin' });
fastify.register(require('./routes/admin/batches'),    { prefix: '/admin' });
fastify.register(require('./routes/admin/scans'),      { prefix: '/admin' });
fastify.register(require('./routes/admin/alerts'),     { prefix: '/admin' });
fastify.register(require('./routes/admin/analytics'),  { prefix: '/admin' });

// ── Health check ──────────────────────────────────────────────────
fastify.get('/health', async () => ({ status: 'ok', ts: new Date().toISOString() }));

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
