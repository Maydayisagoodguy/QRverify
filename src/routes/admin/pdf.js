'use strict';

const crypto = require('crypto');
const { adminRateLimit } = require('../../middleware/rateLimit');
const db = require('../../db');
const { buildPDF } = require('../../services/qrgen');

// In-memory PDF job store — single Render instance, 10 min TTL
const pdfJobs = new Map();
function scheduleCleanup(jobId) {
  setTimeout(() => pdfJobs.delete(jobId), 10 * 60 * 1000);
}

module.exports = async function pdfRoutes(fastify) {

  // ── POST /admin/pdf/start/:code — kick off background PDF generation ──
  fastify.post('/pdf/start/:code', { preHandler: [adminRateLimit] }, async (request, reply) => {
    const { code } = request.params;

    let products;
    try {
      products = await db.getBatchProductsForExport(code);
    } catch (err) {
      request.log.error({ err }, 'getBatchProductsForExport failed');
      return reply.code(500).send({ error: 'Database error', code: 'DB_ERROR' });
    }
    if (!products || !products.length) {
      return reply.code(404).send({ error: 'Batch not found or empty', code: 'NOT_FOUND' });
    }

    const jobId = crypto.randomUUID();
    const job = {
      status:    'running',
      done:      0,
      total:     products.length,
      buffer:    null,
      error:     null,
      batchCode: code,
      listeners: new Set(),
    };
    pdfJobs.set(jobId, job);
    scheduleCleanup(jobId);

    const emit = (data) => {
      for (const send of job.listeners) {
        try { send(data); } catch {}
      }
    };

    // Background PDF generation — non-blocking
    buildPDF(products, (done, total) => {
      job.done = done;
      emit({ type: 'progress', done, total });
    }).then((buffer) => {
      job.status = 'done';
      job.buffer = buffer;
      emit({ type: 'done', jobId });
    }).catch((err) => {
      request.log.error({ err }, 'PDF job failed');
      job.status = 'error';
      job.error  = err.message || 'PDF generation failed';
      emit({ type: 'error', message: job.error });
    });

    return { jobId, total: products.length };
  });

  // ── GET /admin/pdf/progress/:jobId — SSE progress stream ─────────────
  fastify.get('/pdf/progress/:jobId', async (request, reply) => {
    const job = pdfJobs.get(request.params.jobId);
    if (!job) {
      return reply.code(404).send({ error: 'Job not found or expired', code: 'JOB_NOT_FOUND' });
    }

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type':      'text/event-stream',
      'Cache-Control':     'no-cache, no-transform',
      'Connection':        'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (data) => {
      try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
    };

    if (job.status === 'done') {
      send({ type: 'done', jobId: request.params.jobId });
      res.end();
      return;
    }
    if (job.status === 'error') {
      send({ type: 'error', message: job.error });
      res.end();
      return;
    }

    send({ type: 'progress', done: job.done, total: job.total });
    job.listeners.add(send);

    const heartbeat = setInterval(() => {
      try { res.write(': heartbeat\n\n'); } catch { clearInterval(heartbeat); }
    }, 20000);

    request.raw.on('close', () => {
      clearInterval(heartbeat);
      job.listeners.delete(send);
      try { res.end(); } catch {}
    });

    await new Promise(resolve => request.raw.on('close', resolve));
  });

  // ── GET /admin/pdf/download/:jobId — serve completed PDF ─────────────
  fastify.get('/pdf/download/:jobId', { preHandler: [adminRateLimit] }, async (request, reply) => {
    const { jobId } = request.params;
    const job = pdfJobs.get(jobId);
    if (!job || job.status !== 'done' || !job.buffer) {
      return reply.code(404).send({ error: 'PDF not ready or expired', code: 'NOT_READY' });
    }

    return reply
      .type('application/pdf')
      .header('Content-Disposition', `attachment; filename="${job.batchCode}-stickers.pdf"`)
      .header('Content-Length', String(job.buffer.length))
      .send(job.buffer);
  });
};
