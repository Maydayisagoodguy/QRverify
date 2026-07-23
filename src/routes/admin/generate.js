'use strict';

const crypto = require('crypto');
const { adminRateLimit } = require('../../middleware/rateLimit');
const db = require('../../db');
const { processForm } = require('../../services/qrgen');

// In-memory job store — safe for single-instance Render deployment
const jobs = new Map();
function scheduleCleanup(jobId) {
  setTimeout(() => jobs.delete(jobId), 5 * 60 * 1000);
}

// Max serials per batch: seqCode(89999) = 10000+89999 = 99999 (5 digits)
// seqCode(90000) = 100000 (6 digits) — breaks the serial format
const MAX_SEQ_PER_BATCH = 89999;

module.exports = async function generateRoutes(fastify) {

  // ── POST /admin/generate — validate + kick off background job ─────
  fastify.post('/generate', { preHandler: [adminRateLimit] }, async (request, reply) => {
    const { batch_code, quantity, product_name, target_country } = request.body || {};

    if (!batch_code || !quantity) {
      return reply.code(400).send({ error: 'batch_code and quantity are required', code: 'MISSING_PARAM' });
    }

    const qty = parseInt(quantity, 10);
    if (!qty || qty < 1) {
      return reply.code(400).send({ error: 'quantity must be at least 1', code: 'INVALID_PARAM' });
    }

    let startSeq;
    try {
      startSeq = (await db.getMaxSeq(batch_code)) + 1;
    } catch (err) {
      request.log.error({ err }, 'getMaxSeq failed');
      return reply.code(500).send({ error: 'Database error', code: 'DB_ERROR' });
    }

    if (startSeq + qty - 1 > MAX_SEQ_PER_BATCH) {
      const remaining = Math.max(0, MAX_SEQ_PER_BATCH - startSeq + 1);
      return reply.code(400).send({
        error: `This batch can only hold ${remaining.toLocaleString()} more serials (max 89,999 per batch code). Use a different batch code for additional units.`,
        code: 'BATCH_CAPACITY_EXCEEDED',
      });
    }

    let batchMeta, products;
    try {
      ({ batchMeta, products } = processForm({
        batchCode:     batch_code,
        quantity:      qty,
        productName:   product_name   || null,
        targetCountry: target_country || null,
        startSeq,
      }));
    } catch (err) {
      return reply.code(400).send({ error: err.message, code: 'INVALID_PARAM' });
    }

    try {
      await db.upsertBatch(batchMeta);
    } catch (err) {
      request.log.error({ err }, 'Batch upsert failed');
      return reply.code(500).send({ error: 'Database error creating batch', code: 'DB_ERROR' });
    }

    // Create job entry
    const jobId = crypto.randomUUID();
    const job = {
      status:    'running',
      done:      0,
      total:     products.length,
      result:    null,
      error:     null,
      listeners: new Set(),
    };
    jobs.set(jobId, job);
    scheduleCleanup(jobId);

    const emit = (data) => {
      for (const send of job.listeners) {
        try { send(data); } catch {}
      }
    };

    // Background insertion — non-blocking
    db.insertProducts(products, (inserted, total) => {
      job.done = inserted;
      emit({ type: 'progress', done: inserted, total });
    }).then(() => {
      job.status = 'done';
      job.result = {
        success:    true,
        batch_code: batchMeta.batchCode,
        count:      products.length,
        from_seq:   startSeq,
        to_seq:     startSeq + products.length - 1,
      };
      emit({ type: 'done', result: job.result });
      db.logAuditAction('GENERATE_BATCH', 'batch', batch_code, {
        quantity: products.length,
        from_seq: startSeq,
        to_seq:   startSeq + products.length - 1,
        productName: batchMeta.productName,
      }).catch(() => {});
    }).catch((err) => {
      request.log.error({ err }, 'Product insert failed');
      job.status = 'error';
      job.error  = err.message || 'Database error inserting serials';
      emit({ type: 'error', message: job.error });
    });

    return { jobId, total: products.length };
  });

  // ── GET /admin/generate/progress/:jobId — SSE stream ─────────────
  fastify.get('/generate/progress/:jobId', async (request, reply) => {
    const job = jobs.get(request.params.jobId);
    if (!job) {
      return reply.code(404).send({ error: 'Job not found or expired', code: 'JOB_NOT_FOUND' });
    }

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type':      'text/event-stream',
      'Cache-Control':     'no-cache, no-transform',
      'Connection':        'keep-alive',
      'X-Accel-Buffering': 'no', // disable Nginx/Render buffering
    });

    const send = (data) => {
      try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
    };

    // Deliver current state immediately if already finished
    if (job.status === 'done') {
      send({ type: 'done', result: job.result });
      res.end();
      return;
    }
    if (job.status === 'error') {
      send({ type: 'error', message: job.error });
      res.end();
      return;
    }

    // Send current snapshot so client can render partial progress
    send({ type: 'progress', done: job.done, total: job.total });

    job.listeners.add(send);

    // Heartbeat every 20s — prevents proxy/Render from killing idle stream
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
};
