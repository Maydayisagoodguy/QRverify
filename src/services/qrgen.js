'use strict';

const crypto  = require('crypto');
const QRCode  = require('qrcode');
const XLSX    = require('xlsx');
const { v4: uuidv4 } = require('uuid');
const archiver = require('archiver');
const config  = require('../config');

const REQUIRED_COLS = ['product_name', 'batch_code', 'serial_prefix', 'quantity'];

function generateSerial(prefix) {
  return `${prefix}-${uuidv4().replace(/-/g, '').slice(0, 24)}`;
}

function generateHMAC(serial) {
  return crypto
    .createHmac('sha256', config.hmacSecret)
    .update(serial)
    .digest('hex')
    .slice(0, 16);
}

function verifyHMAC(serial, providedHmac) {
  const expected = Buffer.from(generateHMAC(serial));
  const provided  = Buffer.from(providedHmac);
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(expected, provided);
}

function buildURL(serial, hmac) {
  return `${config.verifyBaseUrl}/v/${serial}?h=${hmac}`;
}

async function generateQRPng(url) {
  return QRCode.toBuffer(url, { type: 'png', width: 300, errorCorrectionLevel: 'H' });
}

async function processExcel(fileBuffer) {
  const workbook = XLSX.read(fileBuffer, { type: 'buffer', cellDates: true });
  const sheet    = workbook.Sheets[workbook.SheetNames[0]];
  const rows     = XLSX.utils.sheet_to_json(sheet);

  if (!rows.length) throw new Error('Excel file is empty');

  const warnings  = [];
  const products  = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2; // header is row 1

    const missing = REQUIRED_COLS.filter(c => !row[c]);
    if (missing.length) {
      warnings.push(`Row ${rowNum}: skipped — missing: ${missing.join(', ')}`);
      continue;
    }

    const quantity = parseInt(row.quantity, 10);
    if (!quantity || quantity < 1 || quantity > 10000) {
      warnings.push(`Row ${rowNum}: skipped — invalid quantity (${row.quantity})`);
      continue;
    }

    for (let j = 0; j < quantity; j++) {
      const serial = generateSerial(String(row.serial_prefix).trim().toUpperCase());
      const hmac   = generateHMAC(serial);
      products.push({
        serial,
        hmac,
        batch_code:         String(row.batch_code).trim(),
        product_name:       String(row.product_name).trim(),
        manufacturer:       row.manufacturer ? String(row.manufacturer).trim() : null,
        country_of_origin:  row.country_of_origin ? String(row.country_of_origin).trim() : null,
        manufacturing_date: row.manufacturing_date || null,
        expiry_date:        row.expiry_date || null,
        product_image_url:  row.product_image_url || null,
        distributor:        row.distributor || null,
        region_expected:    row.region || null,
      });
    }
  }

  return { products, warnings };
}

async function buildZip(products, reply) {
  const archive = archiver('zip', { zlib: { level: 6 } });

  reply.raw.setHeader('Content-Type', 'application/zip');
  reply.raw.setHeader(
    'Content-Disposition',
    `attachment; filename="${products[0]?.batch_code || 'batch'}-qrcodes.zip"`
  );

  archive.pipe(reply.raw);

  // CSV manifest
  const csvLines = ['serial,qr_url,batch_code,product_name'];
  for (const p of products) {
    const url = buildURL(p.serial, p.hmac);
    csvLines.push(`${p.serial},${url},${p.batch_code},${p.product_name}`);
  }
  archive.append(csvLines.join('\n'), { name: 'serials.csv' });

  // QR PNGs (batched to avoid OOM on 5000+ codes)
  const BATCH = 50;
  for (let i = 0; i < products.length; i += BATCH) {
    const chunk = products.slice(i, i + BATCH);
    const pngs  = await Promise.all(
      chunk.map(p => generateQRPng(buildURL(p.serial, p.hmac)))
    );
    pngs.forEach((buf, idx) => {
      archive.append(buf, { name: `${chunk[idx].serial}.png` });
    });
  }

  await archive.finalize();
}

module.exports = { processExcel, buildZip, generateHMAC, verifyHMAC, buildURL };
