'use strict';

const https = require('https');

// Known datacenter, cloud host, and VPN provider org name keywords
// IPInfo free tier returns org field like "AS16509 Amazon.com, Inc."
const DATACENTER_KEYWORDS = [
  'amazon', 'aws', 'google cloud', 'microsoft azure', 'azure',
  'digitalocean', 'linode', 'akamai', 'cloudflare', 'fastly',
  'hetzner', 'ovh', 'vultr', 'leaseweb', 'rackspace',
  'ibm cloud', 'oracle cloud', 'alibaba cloud', 'tencent cloud',
  'scaleway', 'choopa', 'quadranet', 'psychz',
  'nordvpn', 'expressvpn', 'mullvad', 'private internet access',
  'protonvpn', 'ipvanish', 'surfshark', 'cyberghost', 'purevpn',
  'hosting', 'datacenter', 'data center', 'colocation',
];

function isDatacenterOrg(org) {
  if (!org) return false;
  const lower = org.toLowerCase();
  return DATACENTER_KEYWORDS.some(kw => lower.includes(kw));
}

function checkIP(ip) {
  const token = process.env.IPINFO_TOKEN;
  if (!token) return Promise.resolve(null); // fails open if token not configured

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'ipinfo.io',
      path:     `/${encodeURIComponent(ip)}/json?token=${token}`,
      method:   'GET',
      timeout:  2000,
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          const d = JSON.parse(raw);
          const org = d.org || null;
          resolve({ isp: org, org, isDatacenter: isDatacenterOrg(org) });
        } catch { resolve(null); }
      });
    });
    req.on('error',   () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

module.exports = { checkIP };
