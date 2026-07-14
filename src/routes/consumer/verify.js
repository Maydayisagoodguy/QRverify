'use strict';

const db             = require('../../db');
const { verifyHMAC } = require('../../services/qrgen');
const { lookupIP }   = require('../../services/geoip');
const { sendAlertEmail } = require('../../services/mailer');
const { verifyRateLimit } = require('../../middleware/rateLimit');

// Returns true only for real public routable IPs
function isPublicIP(ip) {
  if (!ip) return false;
  const clean = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (clean === '127.0.0.1' || clean === '::1') return false;
  const parts = clean.split('.').map(Number);
  if (parts.length !== 4) return false;
  if (parts[0] === 10) return false;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return false;
  if (parts[0] === 192 && parts[1] === 168) return false;
  if (parts[0] === 169 && parts[1] === 254) return false;
  return true;
}

// Fire-and-forget scan log — never blocks or crashes the verify flow
async function safeLogScan(data, logger) {
  try {
    await db.logScan(data);
  } catch (err) {
    logger.error({ err }, 'logScan failed — scan not recorded');
  }
}

module.exports = async function verifyRoutes(fastify) {

  fastify.get('/:serial', {
    preHandler: [verifyRateLimit],
  }, async (request, reply) => {
    const { serial } = request.params;
    const { h: hmac } = request.query;
    const ip        = request.ip;
    const userAgent = request.headers['user-agent'] || '';

    // Geo-lookup first — so ALL scan types (fake, inactive, verified) get location data
    const { country, city, lat, lng } = lookupIP(ip);
    const hasRealIP = isPublicIP(ip);

    // 1. Validate HMAC
    if (!hmac || !verifyHMAC(serial, hmac)) {
      await safeLogScan({ serial, ip, country, city, lat, lng, userAgent, result: 'fake', flagReason: 'INVALID_HMAC' }, request.log);
      return reply.redirect(`/result/${encodeURIComponent(serial)}?status=fake`);
    }

    // 2. Look up product
    let product;
    try {
      product = await db.getProduct(serial);
    } catch (err) {
      request.log.error({ err }, 'DB error on product lookup');
      return reply.code(503).send({ error: 'Service temporarily unavailable', code: 'DB_ERROR' });
    }

    if (!product) {
      await safeLogScan({ serial, ip, country, city, lat, lng, userAgent, result: 'fake', flagReason: 'SERIAL_NOT_FOUND' }, request.log);
      return reply.redirect(`/result/${encodeURIComponent(serial)}?status=fake`);
    }

    // 3. Check if recalled
    if (!product.is_active) {
      await safeLogScan({ serial, ip, country, city, lat, lng, userAgent, result: 'inactive', flagReason: 'PRODUCT_RECALLED' }, request.log);
      return reply.redirect(`/result/${encodeURIComponent(serial)}?status=inactive`);
    }

    // 4. Fetch scan history
    let history = [];
    try {
      history = await db.getScanHistory(serial, 50);
    } catch (err) {
      request.log.error({ err }, 'getScanHistory failed — skipping fraud check');
    }

    let result     = 'verified';
    let flagReason = null;
    const alerts   = [];

    // 5. Fraud detection — only on real public IPs
    if (hasRealIP && history.length > 0) {
      const sameIPScans     = history.filter(s => s.ip === ip);
      const differentIPScans = history.filter(s => s.ip && s.ip !== ip);

      // Rule A: same IP can scan max 2 times — 3rd scan onwards = warning
      if (sameIPScans.length >= 2) {
        result     = 'warning';
        flagReason = 'SCAN_LIMIT_EXCEEDED';
        alerts.push({
          type: 'SCAN_LIMIT_EXCEEDED', severity: 'medium',
          details: { ip, country, city, scanCount: sameIPScans.length + 1, serial },
        });
      }

      // Rule B: any different IP has ever scanned this serial = counterfeit risk
      if (differentIPScans.length > 0) {
        result     = 'warning';
        flagReason = flagReason || 'ALREADY_SCANNED_BY_DIFFERENT_IP';
        const original = differentIPScans[differentIPScans.length - 1]; // oldest different-IP scan
        alerts.push({
          type: 'DUPLICATE_SCAN', severity: 'high',
          details: {
            currentIP: ip, currentCountry: country, currentCity: city,
            originalIP: original.ip, originalCountry: original.country,
            originalCity: original.city, originalAt: original.scanned_at,
            totalOtherIPs: new Set(differentIPScans.map(s => s.ip)).size,
          },
        });
      }

      // Rule C: 5+ unique IPs = mass clone operation
      const uniqueIPs = new Set(history.map(s => s.ip).filter(Boolean));
      uniqueIPs.add(ip);
      if (uniqueIPs.size >= 5) {
        flagReason = 'MASS_CLONE';
        alerts.push({
          type: 'MASS_CLONE', severity: 'critical',
          details: { uniqueIPCount: uniqueIPs.size, serial, batchCode: product.batch_code },
        });
      }

      // Rule E: 5+ total scans = high scan volume alert
      const totalScans = history.length + 1;
      if (totalScans >= 5) {
        alerts.push({
          type: 'HIGH_SCAN_COUNT', severity: 'high',
          details: { totalScans, serial, batchCode: product.batch_code, ip, country },
        });
      }

      // Rule D: same serial scanned from 2+ countries today = geo anomaly
      if (country) {
        const today = new Date();
        const todayCountries = new Set(
          history
            .filter(s => {
              const d = new Date(s.scanned_at);
              return d.getFullYear() === today.getFullYear()
                && d.getMonth() === today.getMonth()
                && d.getDate() === today.getDate();
            })
            .map(s => s.country)
            .filter(Boolean)
        );
        todayCountries.add(country);
        if (todayCountries.size >= 2) {
          alerts.push({
            type: 'GEO_ANOMALY', severity: 'critical',
            details: { countries: [...todayCountries], serial },
          });
        }
      }
    }

    // 6. Log this scan (non-blocking)
    await safeLogScan({ serial, ip, country, city, lat, lng, userAgent, result, flagReason }, request.log);

    // 7. Persist alerts + email on critical
    for (const a of alerts) {
      try {
        await db.createAlert({
          serial,
          batchCode: product.batch_code,
          alertType: a.type,
          severity:  a.severity,
          details:   a.details,
        });
        if (a.severity === 'critical') {
          sendAlertEmail(a.type, a.severity, a.details).catch(() => {});
        }
      } catch (err) {
        request.log.error({ err }, `createAlert failed for ${a.type}`);
      }
    }

    // 8. Redirect to result — pass previous scan count for display
    const prevScans = history.length;
    return reply.redirect(`/result/${encodeURIComponent(serial)}?status=${result}&scans=${prevScans}`);
  });
};
