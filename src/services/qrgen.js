'use strict';

const crypto      = require('crypto');
const QRCode      = require('qrcode');
const PDFDocument = require('pdfkit');
const XLSX        = require('xlsx');
const config      = require('../config');

const REQUIRED_COLS = ['batch_code', 'quantity'];

// ── Serial number design ──────────────────────────────────────────────────────
//
// Format: {PREFIX 2}{BATCH_TAG 2}{LOCAL_SEQ 6}  = 10 chars, always
//
//   PREFIX    = config.serialPrefix (e.g. "FM") — brand identifier
//   BATCH_TAG = 2 random uppercase letters (AA–ZZ), unique per batch
//               → randomly assigned at first QR generation for a batch
//               → stored in batches.batch_tag column
//               → 26×26 = 676 possible tags → 675,999,324 max unique serials
//   LOCAL_SEQ = 6-digit counter within the batch (000001–999999)
//               → unique only within the batch namespace (batch_tag guarantees global uniqueness)
//               → starts at 000001, max 999999
//
// Examples for BATCH-TEST-001 (tag = AB):
//   unit 1 → FMAB000001
//   unit 2 → FMAB000002
//   unit 1000 → FMAB001000

// formatSeq: admin-facing display of the local seq number
function formatSeq(seq) {
  return String(seq);
}

// batchTag: 2 random uppercase letters — assigned externally (see db.getOrAssignBatchTag)
// localSeq: integer 1–999999 within the batch
function buildSerial(batchTag, localSeq) {
  return `${config.serialPrefix}${batchTag}${String(localSeq).padStart(6, '0')}`;
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

// Draw QR code as PDF vector paths — same H error correction, ~100x faster than PNG encoding.
// Eliminates per-QR async image rendering; makes large batches feasible on free Render.
// MARGIN=2 matches the quiet zone the original PNG (margin:1) provided for reliable scanning.
function drawQRVector(doc, url, x, y, size) {
  const qr      = QRCode.create(url, { errorCorrectionLevel: 'H' });
  const modules = qr.modules;
  const count   = modules.size;
  const MARGIN  = 2;                         // quiet-zone modules
  const cell    = size / (count + 2 * MARGIN);
  const ox      = x + MARGIN * cell;
  const oy      = y + MARGIN * cell;

  doc.save();
  doc.rect(x, y, size, size).fill('#FFFFFF'); // white background incl. quiet zone
  doc.fillColor('#000000');
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (modules.get(r, c)) {
        doc.rect(ox + c * cell, oy + r * cell, cell, cell).fill();
      }
    }
  }
  doc.restore();
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
const BGPNL  = '#F7F7F7';
const DIV_C  = '#E0E0E0';

const LOGO_PATH = require('path').join(__dirname, '../../public/assets/logo.png');

function drawSticker(doc, sx, sy, product, url) {
  const DIV_X = sx + 172;
  const RX    = DIV_X + 12;
  const RW    = STK_W - 172 - 12 - 10;

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
  drawQRVector(doc, url, qrX, qrY, QR_S);

  // ── Batch code below QR (serial stays encoded in the QR, just not printed) ──
  doc.font('Courier-Bold').fontSize(7.5)
    .fillColor('#333333')
    .text(product.batch_code, sx, sy + 150, { width: 172, align: 'center' });

  // ── Vertical divider ──────────────────────────────────────────────────────
  doc.save()
    .moveTo(DIV_X, sy + 12)
    .lineTo(DIV_X, sy + STK_H - 12)
    .lineWidth(0.6).strokeColor(DIV_C).stroke()
    .restore();

  // ── Logo — correctly centered (logo ratio 1.178, height-constrained) ───────
  // fit:[80,68] renders at 80×68pt; center = RX + (RW-80)/2
  const LOGO_RENDER_W = 80;
  const logoX = RX + (RW - LOGO_RENDER_W) / 2;
  doc.image(LOGO_PATH, logoX, sy + 6, { fit: [LOGO_RENDER_W, 68] });

  // Divider 1
  doc.save().moveTo(RX, sy + 80).lineTo(sx + STK_W - 10, sy + 80)
    .lineWidth(0.5).strokeColor('#E5E5E5').stroke().restore();

  // ── Scan CTA — prominent heading ──────────────────────────────────────────
  doc.font('Helvetica-Bold').fontSize(14).fillColor(RED)
    .text('SCAN TO VERIFY', RX, sy + 88, { width: RW, align: 'center' });

  doc.font('Helvetica').fontSize(8).fillColor(LTGRAY)
    .text('A U T H E N T I C I T Y', RX, sy + 107, { width: RW, align: 'center' });

  doc.font('Helvetica').fontSize(7.5).fillColor(GRAY)
    .text(
      'Point your camera at the QR code\nto confirm this product is 100% genuine.',
      RX, sy + 122, { width: RW, align: 'center', lineGap: 2.5 }
    );

  // Divider 2
  doc.save().moveTo(RX, sy + 156).lineTo(sx + STK_W - 10, sy + 156)
    .lineWidth(0.5).strokeColor('#EEEEEE').stroke().restore();

  // ── Authenticity note ─────────────────────────────────────────────────────
  doc.font('Helvetica').fontSize(6).fillColor(LTGRAY)
    .text(
      'Tamper-evident QR seal by First Molecule Quality Control',
      RX, sy + 163, { width: RW, align: 'center' }
    );

  // ── Cut marks ─────────────────────────────────────────────────────────────
  const CM = 5;
  for (const [cx, cy] of [[sx, sy], [sx + STK_W, sy], [sx, sy + STK_H], [sx + STK_W, sy + STK_H]]) {
    doc.save()
      .moveTo(cx - CM, cy).lineTo(cx + CM, cy)
      .moveTo(cx, cy - CM).lineTo(cx, cy + CM)
      .lineWidth(0.4).strokeColor('#CCCCCC').stroke()
      .restore();
  }
}

// onProgress(done, total) — called after every 10 stickers so caller can stream progress
async function buildPDF(products, onProgress) {
  const doc    = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: true });
  const chunks = [];

  doc.on('data', c => chunks.push(c));

  // Vector QR — synchronous, no PNG encoding, ~100x faster than toBuffer().
  // Yield every 50 stickers to keep the Node event loop free for other requests.
  for (let i = 0; i < products.length; i++) {
    const p   = products[i];
    const pos = i % PER_PG;
    if (i > 0 && pos === 0) doc.addPage();
    drawSticker(doc, STK_X, STK_Y0 + pos * (STK_H + GAP), p, buildURL(p.serial, p.hmac));

    if ((i + 1) % 50 === 0) {
      if (onProgress) onProgress(i + 1, products.length);
      await new Promise(r => setImmediate(r));
    }
  }

  // Final progress tick for any remainder
  if (onProgress) onProgress(products.length, products.length);

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

// batchTag: 2 uppercase letters (e.g. 'AB') — caller must obtain via db.getOrAssignBatchTag
// startSeq: first local seq for this generation run (1 if new batch, maxExistingSeq+1 otherwise)
function processForm({ batchCode, batchTag, quantity, productName, targetCountry, startSeq }) {
  batchCode = String(batchCode).trim().toUpperCase();
  quantity  = parseInt(quantity, 10);
  startSeq  = parseInt(startSeq, 10) || 1;

  if (!batchCode)          throw new Error('batch_code is required');
  if (!batchTag || batchTag.length !== 2) throw new Error('batchTag is required (2 uppercase letters)');
  if (!quantity || quantity < 1) throw new Error('quantity must be at least 1');
  if (startSeq + quantity - 1 > 999999) throw new Error('Batch would exceed 999,999 serials per tag');

  const name = productName ? String(productName).trim() : '';   // blank when no product name given

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
    const serial = buildSerial(batchTag, seq);
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

function generateResultToken({ serial, status, scans, remark }) {
  const payload = Buffer.from(JSON.stringify({
    s: serial,
    r: status,
    c: scans,
    k: remark || null,
    e: Date.now() + 60_000,
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', config.hmacSecret)
    .update(payload).digest('hex').slice(0, 32);
  return `${payload}.${sig}`;
}

function verifyResultToken(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot === -1) return null;
  const payload  = token.slice(0, dot);
  const sig      = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', config.hmacSecret)
    .update(payload).digest('hex').slice(0, 32);
  if (sig.length !== expected.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch { return null; }
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString()); }
  catch { return null; }
  if (!data.e || Date.now() > data.e) return null;
  return { serial: data.s, status: data.r, scans: data.c ?? 0, remark: data.k || null };
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
  generateResultToken,
  verifyResultToken,
};
