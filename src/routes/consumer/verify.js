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

    // 4. Geo-lookup — real IP only available with trustProxy:true on Render
    const { country, city, lat, lng } = lookupIP(ip);
    const hasRealIP = Boolean(ip && ip !== '127.0.0.1' && ip !== '::1' && !ip.startsWith('::ffff:127.'));

    // 5. Fetch scan history
    const history = await db.getScanHistory(serial, 50);

    let result     = 'verified';
    let flagReason = null;
    const alerts   = [];

    // Only run fraud detection when we have a real routable IP
    if (hasRealIP && history.length > 0) {
      const prevScans    = history.filter(s => s.ip && s.ip !== ip);
      const latestSame   = history.find(s => s.ip === ip);
      const minsElapsed  = latestSame
        ? (Date.now() - new Date(latestSame.scanned_at)) / 60000
        : Infinity;

      // Someone with a DIFFERENT IP has scanned this serial before
      if (prevScans.length > 0 && minsElapsed > 60) {
        result     = 'warning';
        flagReason = 'ALREADY_SCANNED_ELSEWHERE';
        const prev = prevScans[0];
        alerts.push({
          type: 'DUPLICATE_SCAN', severity: 'high',
          details: {
            currentIP: ip, currentCountry: country, currentCity: city,
            prevIP: prev.ip, prevCountry: prev.country, prevCity: prev.city,
            prevAt: prev.scanned_at,
          },
        });
      }

      // Mass clone: 5+ unique IPs scanned this serial
      const uniqueIPs = new Set(history.map(s => s.ip).filter(Boolean));
      uniqueIPs.add(ip);
      if (uniqueIPs.size >= 5) {
        result     = 'warning';
        flagReason = 'MASS_CLONE';
        alerts.push({
          type: 'MASS_CLONE', severity: 'critical',
          details: { uniqueIPCount: uniqueIPs.size, serial, batchCode: product.batch_code },
        });
      }

      // Geo-anomaly: same serial scanned from 2+ countries today
      if (country) {
        const today = new Date();
        const todayScans = history.filter(s => {
          const d = new Date(s.scanned_at);
          return d.getFullYear() === today.getFullYear()
            && d.getMonth() === today.getMonth()
            && d.getDate() === today.getDate();
        });
        const countries = new Set(todayScans.map(s => s.country).filter(Boolean));
        countries.add(country);
        if (countries.size >= 2) {
          alerts.push({
            type: 'GEO_ANOMALY', severity: 'critical',
            details: { countries: [...countries], serial },
          });
        }
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
