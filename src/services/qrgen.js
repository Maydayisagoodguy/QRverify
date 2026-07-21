'use strict';

const crypto          = require('crypto');
const { PassThrough } = require('stream');
const QRCode          = require('qrcode');
const XLSX            = require('xlsx');
const archiver        = require('archiver');
const config          = require('../config');

const REQUIRED_COLS = ['batch_code', 'quantity'];

function formatSeq(seq) {
  return String(seq).padStart(5, '0');
}

function buildSerial(batchCode, seq) {
  return `${batchCode}-${formatSeq(seq)}`;
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

async function generateQRDataURL(url) {
  return QRCode.toDataURL(url, {
    type:                 'png',
    width:                440,
    margin:               1,
    errorCorrectionLevel: 'H',
    color: { dark: '#000000', light: '#FFFFFF' },
  });
}

async function generateSVGLabel(serial, seq, hmac) {
  const url      = buildURL(serial, hmac);
  const qrData   = await generateQRDataURL(url);
  const seqStr   = formatSeq(seq);
  const verifyAt = config.verifyBaseUrl.replace(/^https?:\/\//, '');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     width="6in" height="2.5in" viewBox="0 0 600 250">
  <rect width="600" height="250" fill="#FFFFFF"/>
  <rect x="0.75" y="0.75" width="598.5" height="248.5" fill="none" stroke="#CCCCCC" stroke-width="1.5"/>

  <!-- Left panel: QR code -->
  <rect x="0" y="0" width="250" height="250" fill="#F8F8F8"/>
  <image xlink:href="${qrData}" x="13" y="13" width="224" height="224"/>
  <text x="125" y="246" text-anchor="middle"
        font-family="Courier New, Courier, monospace"
        font-size="10.5" font-weight="bold" fill="#333333" letter-spacing="2">${seqStr}</text>

  <!-- Divider -->
  <line x1="250" y1="12" x2="250" y2="238" stroke="#DDDDDD" stroke-width="1"/>

  <!-- Right panel -->
  <text x="270" y="44"
        font-family="Arial, Helvetica, sans-serif"
        font-size="14.5" font-weight="bold" fill="#111111" letter-spacing="1.2">FIRST MOLECULE</text>
  <line x1="268" y1="54" x2="592" y2="54" stroke="#EEEEEE" stroke-width="0.75"/>

  <text x="270" y="82"
        font-family="Arial, Helvetica, sans-serif"
        font-size="11.5" font-weight="600" fill="#B81F24">&#x25B6; Scan to Verify</text>
  <text x="270" y="98"
        font-family="Arial, Helvetica, sans-serif"
        font-size="9.5" fill="#777777">Point your camera at the QR code to check authenticity</text>

  <line x1="268" y1="111" x2="592" y2="111" stroke="#EEEEEE" stroke-width="0.75"/>

  <text x="270" y="138"
        font-family="Arial, Helvetica, sans-serif"
        font-size="8.5" fill="#AAAAAA" letter-spacing="1.5">SERIAL NUMBER</text>
  <text x="270" y="172"
        font-family="Courier New, Courier, monospace"
        font-size="26" font-weight="bold" fill="#111111" letter-spacing="4">${seqStr}</text>

  <line x1="268" y1="188" x2="592" y2="188" stroke="#EEEEEE" stroke-width="0.75"/>

  <text x="270" y="210"
        font-family="Arial, Helvetica, sans-serif"
        font-size="8" fill="#BBBBBB">Verify at: ${verifyAt}</text>
  <text x="270" y="226"
        font-family="Arial, Helvetica, sans-serif"
        font-size="7.5" fill="#DDDDDD">${serial}</text>
</svg>`;
}

async function processExcel(fileBuffer) {
  const workbook = XLSX.read(fileBuffer, { type: 'buffer', cellDates: true });
  const sheet    = workbook.Sheets[workbook.SheetNames[0]];
  const rows     = XLSX.utils.sheet_to_json(sheet);

  if (!rows.length) throw new Error('Excel file is empty');

  const warnings      = [];
  const products      = [];
  const batchMap      = new Map();
  const batchSeqCount = new Map();

  for (let i = 0; i < rows.length; i++) {
    const row    = rows[i];
    const rowNum = i + 2;

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

    const batchCode   = String(row.batch_code).trim().toUpperCase();
    const productName = row.product_name ? String(row.product_name).trim() : batchCode;

    batchMap.set(batchCode, {
      batchCode,
      productName,
      manufacturer:    row.manufacturer      ? String(row.manufacturer).trim()      : null,
      countryOfOrigin: row.country_of_origin  ? String(row.country_of_origin).trim() : null,
      distributor:     row.distributor        ? String(row.distributor).trim()       : null,
      regionExpected:  row.region             ? String(row.region).trim()            : null,
      productImageUrl: row.product_image_url  || null,
      targetCountry:   row.target_country     ? String(row.target_country).trim()   : null,
    });

    for (let j = 0; j < quantity; j++) {
      const relSeq = (batchSeqCount.get(batchCode) || 0) + 1;
      batchSeqCount.set(batchCode, relSeq);
      products.push({
        _relSeq:            relSeq,
        serial:             null, // filled after DB offset in route
        hmac:               null,
        seq:                relSeq,
        batch_code:         batchCode,
        product_name:       productName,
        manufacturing_date: row.manufacturing_date || null,
        expiry_date:        row.expiry_date        || null,
      });
    }
  }

  return { batches: batchMap, products, warnings };
}

// Generate QR without Excel — called from /admin/generate
function processForm({ batchCode, quantity, productName, targetCountry, startSeq }) {
  batchCode = String(batchCode).trim().toUpperCase();
  quantity  = parseInt(quantity, 10);
  startSeq  = parseInt(startSeq, 10) || 1;

  if (!batchCode)                                    throw new Error('batch_code is required');
  if (!quantity || quantity < 1 || quantity > 10000) throw new Error('quantity must be 1–10000');

  const name = productName ? String(productName).trim() : batchCode;

  const batchMeta = {
    batchCode,
    productName:     name,
    manufacturer:    null,
    countryOfOrigin: null,
    distributor:     null,
    regionExpected:  null,
    productImageUrl: null,
    targetCountry:   targetCountry ? String(targetCountry).trim() : null,
  };

  const products = [];
  for (let i = 0; i < quantity; i++) {
    const seq    = startSeq + i;
    const serial = buildSerial(batchCode, seq);
    const hmac   = generateHMAC(serial);
    products.push({
      serial,
      hmac,
      seq,
      batch_code:         batchCode,
      product_name:       name,
      manufacturing_date: null,
      expiry_date:        null,
    });
  }

  return { batchMeta, products };
}

async function buildZip(products) {
  const BATCH      = 20;
  const svgEntries = [];

  for (let i = 0; i < products.length; i += BATCH) {
    const chunk = products.slice(i, i + BATCH);
    const svgs  = await Promise.all(
      chunk.map(p => generateSVGLabel(p.serial, p.seq, p.hmac))
    );
    svgs.forEach((svg, idx) => svgEntries.push({
      name: `${formatSeq(chunk[idx].seq)}.svg`,
      svg,
    }));
  }

  const csvLines = ['seq,serial,qr_url,batch_code,product_name'];
  for (const p of products) {
    const url = buildURL(p.serial, p.hmac);
    csvLines.push(`${formatSeq(p.seq)},${p.serial},${url},${p.batch_code},${p.product_name || ''}`);
  }

  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 6 } });
    const pass    = new PassThrough();
    const chunks  = [];
    const timer   = setTimeout(() => reject(new Error('ZIP generation timed out')), 60000);

    pass.on('data',  c   => chunks.push(c));
    pass.on('end',   ()  => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
    pass.on('error', err => { clearTimeout(timer); reject(err); });
    archive.on('error', err => { clearTimeout(timer); reject(err); });

    archive.pipe(pass);
    archive.append(csvLines.join('\n'), { name: 'serials.csv' });
    for (const { name, svg } of svgEntries) {
      archive.append(svg, { name });
    }
    archive.finalize();
  });
}

module.exports = { processExcel, processForm, buildZip, generateHMAC, verifyHMAC, buildURL, buildSerial, formatSeq };
