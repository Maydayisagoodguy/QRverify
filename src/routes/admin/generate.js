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

// Max per single request — admin can run multiple requests for larger quantities
const MAX_PER_REQUEST = 100000;

module.exports = async function generateRoutes(fastify) {

  // ── POST /admin/generate — validate + kick off background job ─────
  fastify.post('/generate', { preHandler: [adminRateLimit] }, async (request, reply) => {
    const { batch_code, quantity, product_name, target_country, require_new } = request.body || {};

    if (!batch_code || !quantity) {
      return reply.code(400).send({ error: 'batch_code and quantity are required', code: 'MISSING_PARAM' });
    }

    // New-batch creation (from the Batches page) must not collide with an existing code.
    // Adding units from a batch's own page omits require_new, so appending stays allowed.
    if (require_new) {
      try {
        if (await db.batchExists(String(batch_code).trim().toUpperCase())) {
          return reply.code(409).send({
            error: 'A batch with this code already exists. Choose a different code, or add units from that batch’s page.',
            code: 'DUPLICATE_BATCH',
          });
        }
      } catch (err) {
        request.log.error({ err }, 'batchExists check failed');
        return reply.code(500).send({ error: 'Database error', code: 'DB_ERROR' });
      }
    }

    const qty = parseInt(quantity, 10);
    if (!qty || qty < 1) {
      return reply.code(400).send({ error: 'quantity must be at least 1', code: 'INVALID_PARAM' });
    }
    if (qty > MAX_PER_REQUEST) {
      return reply.code(400).send({
        error: `Maximum ${MAX_PER_REQUEST.toLocaleString()} QR codes per request. Submit multiple requests for larger quantities.`,
        code: 'QUANTITY_TOO_LARGE',
      });
    }

    let batchTag, startSeq;
    try {
      await db.upsertBatch({
        batchCode: batch_code,
        productName: product_name || null,
        manufacturer: null, countryOfOrigin: null, distributor: null,
        regionExpected: null, productImageUrl: null,
        targetCountry: target_country || null,
      });
      [batchTag, startSeq] = await Promise.all([
        db.getOrAssignBatchTag(batch_code),
        db.getMaxBatchSeq(batch_code).then(m => m + 1),
      ]);
    } catch (err) {
      request.log.error({ err }, 'batch setup failed');
      return reply.code(500).send({ error: 'Database error', code: 'DB_ERROR' });
    }

    let batchMeta, products;
    try {
      ({ batchMeta, products } = processForm({
        batchCode:     batch_code,
        batchTag,
        quantity:      qty,
        productName:   product_name   || null,
        targetCountry: target_country || null,
        startSeq,
      }));
    } catch (err) {
      return reply.code(400).send({ error: err.message, code: 'INVALID_PARAM' });
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
