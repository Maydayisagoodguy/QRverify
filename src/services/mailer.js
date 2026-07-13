'use strict';

const { Resend } = require('resend');
const config = require('../config');

let resend;
function getResend() {
  if (!resend && config.resendApiKey) resend = new Resend(config.resendApiKey);
  return resend;
}

const SEVERITY_COLOR = {
  critical: '#DC2626',
  high:     '#D97706',
  medium:   '#2563EB',
  low:      '#16A34A',
};

async function sendAlertEmail(alertType, severity, details) {
  if (!config.alertEmail || !config.resendApiKey) return;

  const client = getResend();
  const color  = SEVERITY_COLOR[severity] || '#6B7280';

  await client.emails.send({
    from:    'QR Verify <alerts@yourdomain.com>',
    to:      config.alertEmail,
    subject: `[${severity.toUpperCase()}] QR Verify Alert — ${alertType}`,
    html: `
      <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:32px;">
        <div style="border-left:4px solid ${color};padding-left:16px;margin-bottom:24px;">
          <p style="margin:0;font-size:12px;color:#6B7280;text-transform:uppercase;letter-spacing:0.05em;">${severity}</p>
          <h1 style="margin:4px 0 0;font-size:20px;color:#171747;">${alertType}</h1>
        </div>
        <table style="width:100%;border-collapse:collapse;">
          ${Object.entries(details || {}).map(([k, v]) => `
            <tr>
              <td style="padding:8px 0;font-size:13px;color:#6E708B;white-space:nowrap;padding-right:16px;">${k}</td>
              <td style="padding:8px 0;font-size:13px;color:#171747;">${typeof v === 'object' ? JSON.stringify(v) : v}</td>
            </tr>
          `).join('')}
        </table>
        <p style="margin-top:32px;font-size:12px;color:#9CA3AF;">QR Verify System — automated alert</p>
      </div>
    `,
  }).catch(err => console.error('Resend error:', err.message));
}

module.exports = { sendAlertEmail };
