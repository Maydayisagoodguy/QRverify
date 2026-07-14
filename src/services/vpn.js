'use strict';

const http = require('http');

// ip-api.com free tier — 45 req/min, no registration needed
// hosting:true means the IP belongs to a datacenter, VPN provider, or cloud host
function checkIP(ip) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: 'ip-api.com',
      path: `/json/${encodeURIComponent(ip)}?fields=status,isp,org,hosting`,
      method:   'GET',
      timeout:  2000,
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          const d = JSON.parse(raw);
          if (d.status !== 'success') { resolve(null); return; }
          resolve({ isp: d.isp || null, org: d.org || null, isDatacenter: d.hosting === true });
        } catch { resolve(null); }
      });
    });
    req.on('error',   () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

module.exports = { checkIP };
