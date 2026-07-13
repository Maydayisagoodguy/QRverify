'use strict';

const geoip = require('geoip-lite');

function lookupIP(ip) {
  if (!ip || ip === '127.0.0.1' || ip === '::1') {
    return { country: null, city: null, lat: null, lng: null };
  }

  // Strip IPv6 prefix if present
  const cleanIp = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  const geo = geoip.lookup(cleanIp);

  if (!geo) return { country: null, city: null, lat: null, lng: null };

  return {
    country: geo.country || null,
    city:    geo.city    || null,
    lat:     geo.ll?.[0] || null,
    lng:     geo.ll?.[1] || null,
  };
}

module.exports = { lookupIP };
