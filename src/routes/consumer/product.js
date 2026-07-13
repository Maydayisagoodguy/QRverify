'use strict';

const db = require('../../db');

module.exports = async function productRoutes(fastify) {

  // Public API — returns safe product details for the result page
  // Serial is a random UUID, so enumeration is infeasible
  fastify.get('/product/:serial', async (request, reply) => {
    const { serial } = request.params;

    const product = await db.getProduct(serial);
    if (!product) return reply.code(404).send({ error: 'Product not found', code: 'NOT_FOUND' });

    // Return only safe, display-relevant fields
    return {
      product_name:       product.product_name,
      batch_code:         product.batch_code,
      manufacturer:       product.manufacturer,
      country_of_origin:  product.country_of_origin,
      manufacturing_date: product.manufacturing_date,
      expiry_date:        product.expiry_date,
      product_image_url:  product.product_image_url,
      distributor:        product.distributor,
      is_active:          product.is_active,
    };
  });
};
