'use strict';

const crypto      = require('crypto');
const QRCode      = require('qrcode');
const PDFDocument = require('pdfkit');
const XLSX        = require('xlsx');
const config      = require('../config');

const REQUIRED_COLS = ['batch_code', 'quantity'];

// ── Serial number design ──────────────────────────────────────────────────────
//
// Format: {PREFIX 3}{BATCH_TAG 2}{SEQ_CODE 5}  = 10 chars, always
//
//   PREFIX    = config.serialPrefix (e.g. "FM0") — brand identifier
//   BATCH_TAG = 2-digit (10–99) HMAC fingerprint of the batch code
//               → same batch always gets same tag; visually groups all products
//                 of one batch (e.g. all "FM071…" serials = BATCH-TEST-001)
//   SEQ_CODE  = 5-digit sequential number: 10001 + (seq - 1) = 10001–99999
//               → seq 1 = 10001, seq 2 = 10002, … seq 1000 = 11000
//               → no leading zeros; person pasting stickers sees clear order
//               → admin selects "seq 1 to 1000" from DB for any batch
//
// Examples for BATCH-TEST-001 (tag = 18):
//   seq 1    → FM0181000 1  → FM01810001
//   seq 10   → FM01810010
//   seq 1000 → FM01811000

// 2-digit batch tag (10–99) — deterministic from batch code + HMAC secret
function batchTag(batchCode) {
  const h = crypto.createHmac('sha256', config.hmacSecret)
    .update(`bt:${batchCode}`).digest();
  return String(10 + (h.readUInt32BE(0) % 90));
}

// 5-digit sequential code: starts at 10001, increments by 1, no leading zeros
function seqCode(seq) {
  return String(10000 + seq); // seq 1 → 10001, seq 89999 → 99999
}

// formatSeq: admin-facing display of raw seq number
function formatSeq(seq) {
  return String(seq);
}

function buildSerial(batchCode, seq) {
  return `${config.serialPrefix}${batchTag(batchCode)}${seqCode(seq)}`;
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

async function generateQRBuffer(url) {
  return QRCode.toBuffer(url, {
    type:                 'png',
    width:                440,
    margin:               1,
    errorCorrectionLevel: 'H',
    color: { dark: '#000000', light: '#FFFFFF' },
  });
}

// ── PDF sticker generation ────────────────────────────────────────────────────
//
// Page:    A4  (595.28 × 841.89 pt)
// Sticker: 6in × 2.5in  (432 × 180 pt)
// Layout:  4 stickers per page, vertically centered with 15pt gaps
//
//  LEFT  (0–170):  gray bg, QR image, serial below
//  RIGHT (175–432): FM badge, "FIRST MOLECULE", scan CTA, verify URL

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const STK_W  = 432;   // 6 in
const STK_H  = 180;   // 2.5 in
const STK_X  = (PAGE_W - STK_W) / 2;
const GAP    = 18;
const PER_PG = 4;
const BLOCK_H = PER_PG * STK_H + (PER_PG - 1) * GAP;
const STK_Y0  = (PAGE_H - BLOCK_H) / 2;

const RED    = '#B81F24';
const DARK   = '#111111';
const GRAY   = '#666666';
const LTGRAY = '#AAAAAA';
const GREEN  = '#22C55E';
const BGPNL  = '#F7F7F7';
const DIV_C  = '#E0E0E0';

function drawSticker(doc, sx, sy, product, qrBuf) {
  const DIV_X = sx + 172;
  const RX    = DIV_X + 12;
  const RW    = STK_W - 172 - 12 - 10;  // right panel usable width

  // ── Outer border ──────────────────────────────────────────────────────────
  doc.save()
    .rect(sx, sy, STK_W, STK_H)
    .lineWidth(0.75).strokeColor(DIV_C).stroke()
    .restore();

  // ── Left panel background ─────────────────────────────────────────────────
  doc.save()
    .rect(sx, sy, 172, STK_H)
    .fillColor(BGPNL).fill()
    .restore();

  // ── QR code ───────────────────────────────────────────────────────────────
  const QR_S = 130;
  const qrX  = sx + (172 - QR_S) / 2;
  const qrY  = sy + 12;
  doc.image(qrBuf, qrX, qrY, { width: QR_S, height: QR_S });

  // ── Serial below QR ───────────────────────────────────────────────────────
  doc.font('Courier-Bold').fontSize(7.5)
    .fillColor('#333333')
    .text(product.serial, sx, sy + 150, { width: 172, align: 'center' });

  // ── Vertical divider ──────────────────────────────────────────────────────
  doc.save()
    .moveTo(DIV_X, sy + 12)
    .lineTo(DIV_X, sy + STK_H - 12)
    .lineWidth(0.6).strokeColor(DIV_C).stroke()
    .restore();

  // ── FM badge (red circle with white "FM") ─────────────────────────────────
  const bCX = RX + 13;
  const bCY = sy + 26;
  doc.save().circle(bCX, bCY, 13).fillColor(RED).fill().restore();
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#FFFFFF')
    .text('FM', bCX - 7.5, bCY - 5, { lineBreak: false });

  // ── FIRST MOLECULE heading ────────────────────────────────────────────────
  doc.font('Helvetica-Bold').fontSize(10.5).fillColor(DARK)
    .text('FIRST MOLECULE', RX + 30, sy + 17, { width: RW - 30, lineBreak: false });

  doc.font('Helvetica').fontSize(6.5).fillColor(LTGRAY)
    .text('Premium Quality Products', RX + 30, sy + 31, { width: RW - 30, lineBreak: false });

  // Divider 1
  doc.save().moveTo(RX, sy + 44).lineTo(sx + STK_W - 10, sy + 44)
    .lineWidth(0.5).strokeColor('#EEEEEE').stroke().restore();

  // ── Scan to Verify ────────────────────────────────────────────────────────
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(RED)
    .text('> Scan to Verify Authenticity', RX, sy + 51, { width: RW });

  doc.font('Helvetica').fontSize(7).fillColor(GRAY)
    .text(
      'Point your camera at the QR code to confirm\nthis product is 100% genuine.',
      RX, sy + 65, { width: RW, lineGap: 1 }
    );

  // Divider 2
  doc.save().moveTo(RX, sy + 100).lineTo(sx + STK_W - 10, sy + 100)
    .lineWidth(0.5).strokeColor('#EEEEEE').stroke().restore();

  // ── Quality mark ──────────────────────────────────────────────────────────
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(GREEN)
    .text('GENUINE PRODUCT', RX, sy + 107, { lineBreak: false });

  doc.font('Helvetica').fontSize(6.5).fillColor(GRAY)
    .text(
      'Tamper-evident QR authentication by\nFirst Molecule Quality Control.',
      RX, sy + 119, { width: RW, lineGap: 1 }
    );

  // Divider 3
  doc.save().moveTo(RX, sy + 150).lineTo(sx + STK_W - 10, sy + 150)
    .lineWidth(0.5).strokeColor('#EEEEEE').stroke().restore();

  // ── Verify URL footer ─────────────────────────────────────────────────────
  const verifyAt = config.verifyBaseUrl.replace(/^https?:\/\//, '');
  doc.font('Courier').fontSize(6.5).fillColor(LTGRAY)
    .text(`Verify at: ${verifyAt}`, RX, sy + 157, { width: RW });

  // ── Cut marks at sticker corners ──────────────────────────────────────────
  const CM = 5;
  for (const [cx, cy] of [[sx, sy], [sx + STK_W, sy], [sx, sy + STK_H], [sx + STK_W, sy + STK_H]]) {
    doc.save()
      .moveTo(cx - CM, cy).lineTo(cx + CM, cy)
      .moveTo(cx, cy - CM).lineTo(cx, cy + CM)
      .lineWidth(0.4).strokeColor('#CCCCCC').stroke()
      .restore();
  }
}

async function buildPDF(products) {
  const BATCH = 20;
  const items  = [];

  for (let i = 0; i < products.length; i += BATCH) {
    const chunk = products.slice(i, i + BATCH);
    const bufs  = await Promise.all(
      chunk.map(p => generateQRBuffer(buildURL(p.serial, p.hmac)))
    );
    bufs.forEach((buf, idx) => items.push({ product: chunk[idx], qrBuf: buf }));
  }

  const doc    = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: true });
  const chunks = [];
  doc.on('data', c => chunks.push(c));

  items.forEach(({ product, qrBuf }, i) => {
    const pos = i % PER_PG;
    if (i > 0 && pos === 0) doc.addPage();
    const sy = STK_Y0 + pos * (STK_H + GAP);
    drawSticker(doc, STK_X, sy, product, qrBuf);
  });

  return new Promise((resolve, reject) => {
    doc.on('end',   () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

// ── Excel processing ──────────────────────────────────────────────────────────

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
        serial:             null,
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

module.exports = {
  processExcel,
  processForm,
  buildPDF,
  generateHMAC,
  verifyHMAC,
  buildURL,
  buildSerial,
  formatSeq,
};
