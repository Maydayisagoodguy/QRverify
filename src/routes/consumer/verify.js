'use strict';

const db             = require('../../db');
const { verifyHMAC } = require('../../services/qrgen');
const { lookupIP }   = require('../../services/geoip');
const { checkIP }    = require('../../services/vpn');
const { sendAlertEmail } = require('../../services/mailer');
const { verifyRateLimit } = require('../../middleware/rateLimit');

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

    if (!serial || serial.length > 200) {
      return reply.redirect('/result/invalid?status=fake');
    }
    if (!hmac || hmac.length !== 16 || !/^[0-9a-f]+$/i.test(hmac)) {
      await safeLogScan({ serial: serial.slice(0, 200), ip, country: null, city: null, lat: null, lng: null, userAgent, result: 'fake', flagReason: 'INVALID_HMAC_FORMAT' }, request.log);
      return reply.redirect(`/result/${encodeURIComponent(serial.slice(0, 200))}?status=fake`);
    }

    const { country, city, lat, lng } = lookupIP(ip);
    const hasRealIP = isPublicIP(ip);
    const vpnPromise = hasRealIP ? checkIP(ip) : Promise.resolve(null);

    // 1. Validate HMAC
    if (!verifyHMAC(serial, hmac)) {
      await safeLogScan({ serial, ip, country, city, lat, lng, userAgent, result: 'fake', flagReason: 'INVALID_HMAC' }, request.log);
      return reply.redirect(`/result/${encodeURIComponent(serial)}?status=fake`);
    }

    // 2. Fetch product + VPN check in parallel
    let product, vpnInfo;
    try {
      [product, vpnInfo] = await Promise.all([db.getProduct(serial), vpnPromise]);
    } catch (err) {
      request.log.error({ err }, 'DB error on product lookup');
      return reply.code(503).send({ error: 'Service temporarily unavailable', code: 'DB_ERROR' });
    }

    if (!product) {
      await safeLogScan({ serial, ip, country, city, lat, lng, userAgent, result: 'fake', flagReason: 'SERIAL_NOT_FOUND', isp: vpnInfo?.isp || null }, request.log);
      return reply.redirect(`/result/${encodeURIComponent(serial)}?status=fake`);
    }

    if (!product.is_active) {
      await safeLogScan({ serial, ip, country, city, lat, lng, userAgent, result: 'inactive', flagReason: 'PRODUCT_RECALLED', isp: vpnInfo?.isp || null }, request.log);
      return reply.redirect(`/result/${encodeURIComponent(serial)}?status=inactive`);
    }

    // 3. Fetch history + batch data + global config in parallel
    let history = [], batchData = null, globalLimitStr = '1';
    try {
      [history, batchData, globalLimitStr] = await Promise.all([
        db.getScanHistory(serial, 100),
        db.getBatchById(product.batch_code),
        db.getConfigValue('scan_limit_default', '1'),
      ]);
    } catch (err) {
      request.log.error({ err }, 'History/batch/config fetch failed — skipping fraud check');
    }

    // 4. Resolve effective scan limit (serial → batch → global)
    const globalLimit    = parseInt(globalLimitStr || '1', 10) || 1;
    const effectiveLimit = product.scan_limit ?? batchData?.scan_limit ?? globalLimit;
    const prevScans      = history.length; // scans logged BEFORE this one

    let result     = 'verified';
    let flagReason = null;
    const alerts   = [];

    // 5. Result = purely scan count vs. limit
    if (prevScans >= effectiveLimit) {
      result     = 'warning';
      flagReason = 'SCAN_LIMIT_EXCEEDED';
      alerts.push({
        type: 'SCAN_LIMIT_EXCEEDED', severity: 'medium',
        details: { prevScans, limit: effectiveLimit, ip, country, city, serial },
      });
    }

    // 6. Fraud detection for admin alerts — never changes consumer result
    if (hasRealIP && history.length > 0) {
      const differentIPScans = history.filter(s => s.ip && s.ip !== ip);

      if (differentIPScans.length > 0) {
        const original = differentIPScans[differentIPScans.length - 1];
        alerts.push({
          type: 'MULTI_IP_SCAN', severity: result === 'warning' ? 'high' : 'medium',
          details: {
            currentIP: ip, currentCountry: country, currentCity: city,
            originalIP: original.ip, originalCountry: original.country,
            originalCity: original.city, originalAt: original.scanned_at,
            totalOtherIPs: new Set(differentIPScans.map(s => s.ip)).size,
          },
        });
      }

      const uniqueIPs = new Set(history.map(s => s.ip).filter(Boolean));
      uniqueIPs.add(ip);
      if (uniqueIPs.size >= 5) {
        alerts.push({
          type: 'MASS_CLONE', severity: 'critical',
          details: { uniqueIPCount: uniqueIPs.size, serial, batchCode: product.batch_code },
        });
      }

      if (history.length + 1 >= 10) {
        alerts.push({
          type: 'HIGH_SCAN_COUNT', severity: 'high',
          details: { totalScans: history.length + 1, serial, batchCode: product.batch_code, ip, country },
        });
      }

      if (vpnInfo && vpnInfo.isDatacenter) {
        alerts.push({
          type: 'SUSPECTED_PROXY', severity: 'high',
          details: { ip, isp: vpnInfo.isp, org: vpnInfo.org, country, serial, batchCode: product.batch_code },
        });
      }

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

    // 7. Log this scan (non-blocking)
    await safeLogScan({ serial, ip, country, city, lat, lng, userAgent, result, flagReason, isp: vpnInfo?.isp || null }, request.log);

    // 8. Persist alerts + email on critical
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

    // 9. Redirect to result
    const remark = product.remark ? `&remark=${encodeURIComponent(product.remark)}` : '';
    return reply.redirect(`/result/${encodeURIComponent(serial)}?status=${result}&scans=${prevScans}${remark}`);
  });
};
