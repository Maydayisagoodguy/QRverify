'use strict';

const { adminRateLimit } = require('../../middleware/rateLimit');
const db = require('../../db');
const { processForm } = require('../../services/qrgen');

module.exports = async function generateRoutes(fastify) {

  fastify.post('/generate', { preHandler: [adminRateLimit] }, async (request, reply) => {
    const { batch_code, quantity, product_name, target_country } = request.body || {};

    if (!batch_code || !quantity) {
      return reply.code(400).send({ error: 'batch_code and quantity are required', code: 'MISSING_PARAM' });
    }

    let startSeq;
    try {
      startSeq = (await db.getMaxSeq(batch_code)) + 1;
    } catch (err) {
      request.log.error({ err }, 'getMaxSeq failed');
      return reply.code(500).send({ error: 'Database error', code: 'DB_ERROR' });
    }

    let batchMeta, products;
    try {
      ({ batchMeta, products } = processForm({
        batchCode:     batch_code,
        quantity,
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

    try {
      await db.insertProducts(products);
    } catch (err) {
      request.log.error({ err }, 'Product insert failed');
      return reply.code(500).send({ error: 'Database error inserting serials', code: 'DB_ERROR' });
    }

    db.logAuditAction('GENERATE_BATCH', 'batch', batch_code, {
      quantity:    products.length,
      from_seq:    startSeq,
      to_seq:      startSeq + products.length - 1,
      productName: batchMeta.productName,
    }).catch(() => {});

    return {
      success:    true,
      batch_code: batchMeta.batchCode,
      count:      products.length,
      from_seq:   startSeq,
      to_seq:     startSeq + products.length - 1,
    };
  });

};
