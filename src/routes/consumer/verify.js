'use strict';

const db          = require('../../db');
const { verifyHMAC } = require('../../services/qrgen');
const { lookupIP }   = require('../../services/geoip');
const { sendAlertEmail } = require('../../services/mailer');
const { verifyRateLimit, strictRateLimit } = require('../../middleware/rateLimit');

module.exports = async function verifyRoutes(fastify) {

  fastify.get('/:serial', {
    preHandler: [verifyRateLimit],
  }, async (request, reply) => {
    const { serial } = request.params;
    const { h: hmac } = request.query;
    const ip          = request.ip;
    const userAgent   = request.headers['user-agent'] || '';

    // 1. Validate HMAC
    if (!hmac || !verifyHMAC(serial, hmac)) {
      await db.logScan({ serial, ip, userAgent, result: 'fake', flagReason: 'INVALID_HMAC' });
      return reply.redirect(`/result/${encodeURIComponent(serial)}?status=fake&reason=invalid_signature`);
    }

    // 2. Check serial exists
    let product;
    try {
      product = await db.getProduct(serial);
    } catch (err) {
      request.log.error({ err }, 'DB error on product lookup');
      return reply.code(503).send({ error: 'Service unavailable', code: 'DB_ERROR' });
    }

    if (!product) {
      await db.logScan({ serial, ip, userAgent, result: 'fake', flagReason: 'SERIAL_NOT_FOUND' });
      return reply.redirect(`/result/${encodeURIComponent(serial)}?status=fake&reason=unknown_serial`);
    }

    // 3. Check if recalled
    if (!product.is_active) {
      await db.logScan({ serial, ip, userAgent, result: 'inactive', flagReason: 'PRODUCT_RECALLED' });
      return reply.redirect(`/result/${encodeURIComponent(serial)}?status=inactive`);
    }

    // 4. Geo-lookup
    const { country, city, lat, lng } = lookupIP(ip);

    // 5. Fetch scan history
    const history = await db.getScanHistory(serial, 20);

    let result     = 'verified';
    let flagReason = null;
    const alerts   = [];

    if (history.length > 0) {
      const first        = history[history.length - 1]; // oldest
      const sameIP       = first.ip === ip;
      const minsElapsed  = (Date.now() - new Date(first.scanned_at)) / 60000;

      // Same person rescanning within 1 hour — OK
      if (!(sameIP && minsElapsed < 60)) {
        const sameLocation = first.country === country && first.city === city;
        if (!sameLocation || !sameIP) {
          result     = 'warning';
          flagReason = 'ALREADY_SCANNED_ELSEWHERE';
          alerts.push({
            type: 'DUPLICATE_SCAN', severity: 'high',
            details: { ip, country, city, firstScan: { ip: first.ip, country: first.country, city: first.city, at: first.scanned_at } },
          });
        }
      }

      // Mass clone: 3+ unique IPs
      const uniqueIPs = new Set(history.map(s => s.ip));
      if (!uniqueIPs.has(ip)) uniqueIPs.add(ip);
      if (uniqueIPs.size >= 3) {
        result     = 'warning';
        flagReason = 'MASS_CLONE';
        alerts.push({
          type: 'MASS_CLONE', severity: 'critical',
          details: { uniqueIPCount: uniqueIPs.size, serial, batchCode: product.batch_code },
        });
      }

      // Same serial, two different countries in one day
      const todayScans  = history.filter(s => {
        const d = new Date(s.scanned_at);
        const n = new Date();
        return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
      });
      const countries = new Set(todayScans.map(s => s.country).filter(Boolean));
      if (country) countries.add(country);
      if (countries.size >= 2) {
        alerts.push({
          type: 'GEO_ANOMALY', severity: 'critical',
          details: { countries: [...countries], serial },
        });
      }
    }

    // 6. Bot detection: same IP scanning 20+ different serials in 1 min
    // (handled by rate limiter — already done above)

    // 7. Log scan
    await db.logScan({ serial, ip, country, city, lat, lng, userAgent, result, flagReason });

    // 8. Create alerts + send email for critical
    for (const a of alerts) {
      await db.createAlert({
        serial,
        batchCode:  product.batch_code,
        alertType:  a.type,
        severity:   a.severity,
        details:    a.details,
      });
      if (a.severity === 'critical') {
        sendAlertEmail(a.type, a.severity, a.details).catch(() => {});
      }
    }

    // 9. Redirect to result page
    return reply.redirect(`/result/${encodeURIComponent(serial)}?status=${result}`);
  });
};
