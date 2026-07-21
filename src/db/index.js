'use strict';

const { createClient } = require('@supabase/supabase-js');
const config = require('../config');

const db = createClient(config.supabaseUrl, config.supabaseServiceKey, {
  auth: { persistSession: false },
});

// ── Batches ───────────────────────────────────────────────────────

async function upsertBatch({ batchCode, productName, manufacturer, countryOfOrigin, distributor, regionExpected, productImageUrl, targetCountry }) {
  const { error } = await db.from('batches').upsert({
    batch_code:         batchCode,
    product_name:       productName,
    manufacturer:       manufacturer || null,
    country_of_origin:  countryOfOrigin || null,
    distributor:        distributor || null,
    region_expected:    regionExpected || null,
    product_image_url:  productImageUrl || null,
    target_country:     targetCountry || null,
  }, { onConflict: 'batch_code', ignoreDuplicates: false });
  if (error) throw error;
}

async function getBatches() {
  const { data: rows, error } = await db
    .from('batches')
    .select('batch_code, product_name, total_units, active_units, created_at, status, target_country')
    .order('created_at', { ascending: false });
  if (error) throw error;
  if (!rows?.length) return [];

  // Enrich with scan counts using two-query pattern
  const { data: products } = await db
    .from('products')
    .select('batch_code, serial')
    .in('batch_code', rows.map(r => r.batch_code));

  const serialToBatch = {};
  for (const p of (products || [])) serialToBatch[p.serial] = p.batch_code;

  const allSerials = Object.keys(serialToBatch);
  const batchScanCount = {};
  if (allSerials.length) {
    const { data: scanRows } = await db
      .from('scan_logs')
      .select('serial')
      .in('serial', allSerials);
    for (const s of (scanRows || [])) {
      const bc = serialToBatch[s.serial];
      if (bc) batchScanCount[bc] = (batchScanCount[bc] || 0) + 1;
    }
  }

  return rows.map(r => ({
    batch_code:     r.batch_code,
    product_name:   r.product_name,
    total:          r.total_units,
    active:         r.active_units,
    created_at:     r.created_at,
    status:         r.status,
    target_country: r.target_country || null,
    scans:          batchScanCount[r.batch_code] || 0,
  }));
}

// ── Products ──────────────────────────────────────────────────────

async function getProduct(serial) {
  const { data, error } = await db.from('products').select('*').eq('serial', serial).single();
  if (error && error.code !== 'PGRST116') throw error;
  return data;
}

async function insertProducts(products) {
  const { error } = await db.from('products').insert(products);
  if (error) throw error;
}

async function deactivateBySerial(serial) {
  const { error } = await db
    .from('products')
    .update({ is_active: false, recalled_at: new Date().toISOString() })
    .eq('serial', serial);
  if (error) throw error;
}

async function deactivateByBatch(batchCode) {
  const { error } = await db
    .from('products')
    .update({ is_active: false, recalled_at: new Date().toISOString() })
    .eq('batch_code', batchCode);
  if (error) throw error;
}

async function getBatchProducts(batchCode) {
  const { data, error } = await db
    .from('products')
    .select('serial, product_name, batch_code')
    .eq('batch_code', batchCode);
  if (error) throw error;
  return data || [];
}

async function getBatchProductsForExport(batchCode) {
  const { data, error } = await db
    .from('products')
    .select('serial, hmac, seq, product_name, batch_code')
    .eq('batch_code', batchCode)
    .order('seq', { ascending: true })
    .limit(100000);
  if (error) throw error;
  return data || [];
}

async function getMaxSeq(batchCode) {
  const { data, error } = await db
    .from('products')
    .select('seq')
    .eq('batch_code', batchCode)
    .order('seq', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data?.seq || 0;
}

async function getSerialsByBatch(batchCode, { remarkFilter } = {}) {
  let q = db
    .from('products')
    .select('seq, serial, is_active, remark, remark_updated_at')
    .eq('batch_code', batchCode)
    .order('seq', { ascending: true })
    .limit(100000);

  if (remarkFilter) q = q.eq('remark', remarkFilter);

  const { data, error } = await q;
  if (error) throw error;
  const rows = data || [];
  if (!rows.length) return rows;

  // Enrich with scan count per serial
  const serials = rows.map(r => r.serial);
  const { data: scanRows } = await db
    .from('scan_logs')
    .select('serial')
    .in('serial', serials);

  const scanCount = {};
  for (const s of (scanRows || [])) {
    scanCount[s.serial] = (scanCount[s.serial] || 0) + 1;
  }

  return rows.map(r => ({
    seq:                r.seq,
    serial:             r.serial,
    is_active:          r.is_active,
    remark:             r.remark || null,
    remark_updated_at:  r.remark_updated_at || null,
    scan_count:         scanCount[r.serial] || 0,
  }));
}

async function applyRemarkToRange(batchCode, fromSeq, toSeq, remarkText) {
  const { error } = await db
    .from('products')
    .update({
      remark:             remarkText,
      remark_updated_at:  new Date().toISOString(),
    })
    .eq('batch_code', batchCode)
    .gte('seq', fromSeq)
    .lte('seq', toSeq);
  if (error) throw error;
}

async function clearRemarkRange(batchCode, fromSeq, toSeq) {
  const { error } = await db
    .from('products')
    .update({ remark: null, remark_updated_at: null })
    .eq('batch_code', batchCode)
    .gte('seq', fromSeq)
    .lte('seq', toSeq);
  if (error) throw error;
}

async function getDistinctRemarks(batchCode) {
  const { data, error } = await db
    .from('products')
    .select('remark')
    .eq('batch_code', batchCode)
    .not('remark', 'is', null)
    .neq('remark', '');
  if (error) throw error;
  const distinct = [...new Set((data || []).map(r => r.remark))].filter(Boolean);
  return distinct;
}

async function getBatchDetail(batchCode) {
  const [batchRes, statsRes] = await Promise.all([
    db.from('batches').select('*').eq('batch_code', batchCode).maybeSingle(),
    db.from('products').select('seq, serial, remark').eq('batch_code', batchCode).limit(100000),
  ]);
  if (batchRes.error) throw batchRes.error;
  if (statsRes.error) throw statsRes.error;

  const batch    = batchRes.data;
  const products = statsRes.data || [];
  if (!batch) return null;

  const serials = products.map(p => p.serial);
  let totalScans = 0;
  if (serials.length) {
    const { count } = await db
      .from('scan_logs')
      .select('id', { count: 'exact', head: true })
      .in('serial', serials);
    totalScans = count || 0;
  }

  const remarkCount = new Set(products.map(p => p.remark).filter(Boolean)).size;

  return {
    batch,
    stats: {
      total:       products.length,
      totalScans,
      remarkCount,
      maxSeq:      products.length ? Math.max(...products.map(p => p.seq || 0)) : 0,
    },
  };
}

// ── Scan logs ─────────────────────────────────────────────────────

async function logScan({ serial, ip, country, city, lat, lng, userAgent, deviceToken, result, flagReason, isp }) {
  const { data, error } = await db.from('scan_logs').insert({
    serial,
    ip,
    country:      country || null,
    city:         city || null,
    lat:          lat || null,
    lng:          lng || null,
    user_agent:   userAgent || null,
    device_token: deviceToken || null,
    result,
    flag_reason:  flagReason || null,
    isp:          isp || null,
  }).select('id').single();
  if (error) throw error;
  return data;
}

async function getScanHistory(serial, limit = 50) {
  const { data, error } = await db
    .from('scan_logs')
    .select('*')
    .eq('serial', serial)
    .order('scanned_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

async function getScanLogs({ result, batchCode, from, to, limit = 100, offset = 0 }) {
  let q = db
    .from('scan_logs')
    .select('id, serial, scanned_at, ip, country, city, result, flag_reason, user_agent')
    .order('scanned_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (result) q = q.eq('result', result);
  if (from)   q = q.gte('scanned_at', from);
  if (to)     q = q.lte('scanned_at', to);

  const { data, error } = await q;
  if (error) throw error;

  const rows = data || [];
  if (!rows.length) return rows;

  // Enrich with product info (no FK join — allows fake/invalid serials)
  const serials = [...new Set(rows.map(r => r.serial))];
  const { data: prods } = await db
    .from('products')
    .select('serial, product_name, batch_code')
    .in('serial', serials);

  const prodMap = Object.fromEntries((prods || []).map(p => [p.serial, p]));
  const enriched = rows.map(r => ({ ...r, products: prodMap[r.serial] || null }));

  return batchCode
    ? enriched.filter(r => r.products?.batch_code === batchCode)
    : enriched;
}

// ── Alerts ────────────────────────────────────────────────────────

async function createAlert({ serial, batchCode, alertType, severity, details }) {
  const { error } = await db.from('alerts').insert({
    serial,
    batch_code:  batchCode,
    alert_type:  alertType,
    severity,
    details,
  });
  if (error) throw error;
}

async function getAlerts({ resolved, severity, limit = 50, offset = 0 } = {}) {
  let q = db
    .from('alerts')
    .select('*')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (resolved !== undefined) q = q.eq('resolved', resolved);
  if (severity)               q = q.eq('severity', severity);

  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

async function resolveAlert(id) {
  const { error } = await db.from('alerts').update({
    resolved:    true,
    resolved_at: new Date().toISOString(),
  }).eq('id', id);
  if (error) throw error;
}

// ── Consumer reports ──────────────────────────────────────────────

async function createReport({ serial, batchCode, reporterIp, reporterCountry, message }) {
  const { error } = await db.from('consumer_reports').insert({
    serial,
    batch_code:       batchCode || null,
    reporter_ip:      reporterIp || null,
    reporter_country: reporterCountry || null,
    message:          message || null,
  });
  if (error) throw error;
}

async function getReports({ status, limit = 50, offset = 0 } = {}) {
  let q = db
    .from('consumer_reports')
    .select('*')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) q = q.eq('status', status);

  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

// ── Audit log ─────────────────────────────────────────────────────

async function logAuditAction(action, targetType, targetId, details) {
  const { error } = await db.from('admin_audit_log').insert({
    action,
    target_type: targetType || null,
    target_id:   String(targetId || ''),
    details:     details || null,
  });
  if (error) {
    // Audit failures are non-fatal — log but don't throw
    console.error('[audit] logAuditAction failed:', error.message);
  }
}

// ── Analytics ─────────────────────────────────────────────────────

async function getAnalyticsSummary() {
  // Single DB round-trip via SQL function (replaces 5 parallel COUNT queries)
  const { data, error } = await db.rpc('get_analytics_summary');
  if (!error && data && data[0]) {
    const r = data[0];
    return {
      total:        Number(r.total)        || 0,
      verified:     Number(r.verified)     || 0,
      warning:      Number(r.warning)      || 0,
      fake:         Number(r.fake)         || 0,
      inactive:     Number(r.inactive)     || 0,
      activeAlerts: Number(r.active_alerts) || 0,
      totalBatches: Number(r.total_batches) || 0,
    };
  }

  // Fallback: 5 parallel COUNT queries (if RPC not yet created in Supabase)
  const [total, verified, warning, fake, activeAlerts] = await Promise.all([
    db.from('scan_logs').select('id', { count: 'exact', head: true }),
    db.from('scan_logs').select('id', { count: 'exact', head: true }).eq('result', 'verified'),
    db.from('scan_logs').select('id', { count: 'exact', head: true }).eq('result', 'warning'),
    db.from('scan_logs').select('id', { count: 'exact', head: true }).eq('result', 'fake'),
    db.from('alerts').select('id', { count: 'exact', head: true }).eq('resolved', false),
  ]);

  return {
    total:        total.count        || 0,
    verified:     verified.count     || 0,
    warning:      warning.count      || 0,
    fake:         fake.count         || 0,
    activeAlerts: activeAlerts.count || 0,
    totalBatches: 0,
  };
}

async function getISPSummary() {
  const { data, error } = await db
    .from('scan_logs')
    .select('isp, result')
    .not('isp', 'is', null);
  if (error) throw error;

  const map = {};
  for (const row of (data || [])) {
    const key = row.isp;
    if (!map[key]) map[key] = { isp: key, verified: 0, warning: 0, fake: 0, inactive: 0, total: 0 };
    map[key][row.result] = (map[key][row.result] || 0) + 1;
    map[key].total++;
  }
  return Object.values(map).sort((a, b) => b.total - a.total);
}

async function getGeoSummary() {
  const { data, error } = await db
    .from('scan_logs')
    .select('country, result')
    .not('country', 'is', null);
  if (error) throw error;

  const map = {};
  for (const row of (data || [])) {
    const c = row.country;
    if (!map[c]) map[c] = { country: c, verified: 0, warning: 0, fake: 0, inactive: 0, total: 0 };
    map[c][row.result] = (map[c][row.result] || 0) + 1;
    map[c].total++;
  }
  return Object.values(map).sort((a, b) => b.total - a.total);
}

async function getMapData(limit = 500) {
  const { data, error } = await db
    .from('scan_logs')
    .select('serial, lat, lng, result, country, city, scanned_at')
    .not('lat', 'is', null)
    .order('scanned_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  const rows = data || [];
  if (!rows.length) return rows;

  // Enrich with product info — two-query pattern, no FK needed
  const serials = [...new Set(rows.map(r => r.serial))];
  const { data: prods } = await db
    .from('products')
    .select('serial, product_name, batch_code')
    .in('serial', serials);

  const prodMap = Object.fromEntries((prods || []).map(p => [p.serial, p]));
  return rows.map(r => ({
    ...r,
    product_name: prodMap[r.serial]?.product_name || null,
    batch_code:   prodMap[r.serial]?.batch_code   || null,
  }));
}

module.exports = {
  // Batches
  upsertBatch,
  getBatches,
  // Products
  getProduct,
  insertProducts,
  deactivateBySerial,
  deactivateByBatch,
  getBatchProducts,
  getBatchProductsForExport,
  getMaxSeq,
  getSerialsByBatch,
  applyRemarkToRange,
  clearRemarkRange,
  getDistinctRemarks,
  getBatchDetail,
  // Scan logs
  logScan,
  getScanHistory,
  getScanLogs,
  // Alerts
  createAlert,
  getAlerts,
  resolveAlert,
  // Consumer reports
  createReport,
  getReports,
  // Audit
  logAuditAction,
  // Analytics
  getAnalyticsSummary,
  getISPSummary,
  getGeoSummary,
  getMapData,
};
