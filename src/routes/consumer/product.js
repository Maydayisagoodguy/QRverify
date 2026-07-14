'use strict';

const db = require('../../db');

module.exports = async function productRoutes(fastify) {

  // Public API — returns safe product details for the result page
  // Serial is a random UUID, so enumeration is infeasible
  fastify.get('/product/:serial', async (request, reply) => {
    const { serial } = request.params;

    const product = await db.getProduct(serial);
    if (!product) return reply.code(404).send({ error: 'Product not found', code: 'NOT_FOUND' });

    // Validate image URL — only allow https:// to prevent javascript: or data: URIs
    let safeImageUrl = null;
    if (product.product_image_url) {
      try {
        const u = new URL(product.product_image_url);
        if (u.protocol === 'https:') safeImageUrl = product.product_image_url;
      } catch { /* invalid URL — drop it */ }
    }

    // Return only safe, display-relevant fields
    return {
      product_name:       product.product_name,
      batch_code:         product.batch_code,
      manufacturer:       product.manufacturer,
      country_of_origin:  product.country_of_origin,
      manufacturing_date: product.manufacturing_date,
      expiry_date:        product.expiry_date,
      product_image_url:  safeImageUrl,
      distributor:        product.distributor,
      is_active:          product.is_active,
    };
  });
};
