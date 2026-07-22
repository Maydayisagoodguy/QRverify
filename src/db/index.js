'use strict';

const { createClient } = require('@supabase/supabase-js');
const config = require('../config');

const db = createClient(config.supabaseUrl, config.supabaseServiceKey, {
  auth: { persistSession: false },
});

// ── Config ────────────────────────────────────────────────────────

let _configCache = {};
let _configFetchedAt = 0;

async function getConfigValue(key, fallback = null) {
  const now = Date.now();
  if (now - _configFetchedAt > 60000) {
    const { data } = await db.from('config').select('key, value');
    _configCache = Object.fromEntries((data || []).map(r => [r.key, r.value]));
    _configFetchedAt = now;
  }
  const v = _configCache[key];
  return v !== undefined ? v : fallback;
}

async function setConfigValue(key, value) {
  const { error } = await db.from('config').upsert(
    { key, value: String(value), updated_at: new Date().toISOString() },
    { onConflict: 'key' }
  );
  if (error) throw error;
  _configCache[key] = String(value);
  _configFetchedAt = 0; // force refresh next call
}

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
    .select('batch_code, product_name, total_units, active_units, created_at, status, target_country, scan_limit')
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
    scan_limit:     r.scan_limit ?? null,
    scans:          batchScanCount[r.batch_code] || 0,
  }));
}

async function getBatchById(batchCode) {
  const { data, error } = await db
    .from('batches')
    .select('batch_code, product_name, scan_limit, target_country')
    .eq('batch_code', batchCode)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function setScanLimitForBatch(batchCode, limit) {
  const { error } = await db
    .from('batches')
    .update({ scan_limit: limit })
    .eq('batch_code', batchCode);
  if (error) throw error;
}

async function setScanLimitForRange(batchCode, fromSeq, toSeq, limit) {
  const { error } = await db
    .from('products')
    .update({ scan_limit: limit })
    .eq('batch_code', batchCode)
    .gte('seq', fromSeq)
    .lte('seq', toSeq);
  if (error) throw error;
}

async function clearScanLimitForRange(batchCode, fromSeq, toSeq) {
  const { error } = await db
    .from('products')
    .update({ scan_limit: null })
    .eq('batch_code', batchCode)
    .gte('seq', fromSeq)
    .lte('seq', toSeq);
  if (error) throw error;
}

async function getSerialOverrideCounts() {
  const { data, error } = await db
    .from('products')
    .select('batch_code, scan_limit')
    .not('scan_limit', 'is', null);
  if (error) throw error;
  const counts = {};
  for (const r of (data || [])) {
    counts[r.batch_code] = (counts[r.batch_code] || 0) + 1;
  }
  return counts;
}

async function getSerialLimitGroups(batchCode) {
  const [limitRes, prefixRes] = await Promise.all([
    db.from('products')
      .select('seq, scan_limit')
      .eq('batch_code', batchCode)
      .not('scan_limit', 'is', null)
      .order('seq', { ascending: true }),
    db.from('products')
      .select('serial')
      .eq('batch_code', batchCode)
      .order('seq', { ascending: true })
      .limit(1),
  ]);
  if (limitRes.error) throw limitRes.error;

  const rows = limitRes.data || [];
  const firstSerial = prefixRes.data?.[0]?.serial || '';
  const serialPrefix = firstSerial.length >= 5 ? firstSerial.slice(0, 5) : '';

  if (!rows.length) return { groups: [], serialPrefix };

  // Collapse consecutive same-limit seqs into ranges
  const groups = [];
  let cur = null;
  for (const r of rows) {
    if (!cur || cur.limit !== r.scan_limit || cur.toSeq + 1 !== r.seq) {
      cur = { fromSeq: r.seq, toSeq: r.seq, limit: r.scan_limit, count: 1 };
      groups.push(cur);
    } else {
      cur.toSeq = r.seq;
      cur.count++;
    }
  }
  return { groups, serialPrefix };
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
    .select('seq, serial, is_active, remark, remark_updated_at, scan_limit')
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
    scan_limit:         r.scan_limit ?? null,
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
  let totalScans = 0, verified = 0, warning = 0, fake = 0, activeAlerts = 0;

  if (serials.length) {
    const [totalRes, verifiedRes, warningRes, fakeRes, alertRes] = await Promise.all([
      db.from('scan_logs').select('id', { count: 'exact', head: true }).in('serial', serials),
      db.from('scan_logs').select('id', { count: 'exact', head: true }).in('serial', serials).eq('result', 'verified'),
      db.from('scan_logs').select('id', { count: 'exact', head: true }).in('serial', serials).eq('result', 'warning'),
      db.from('scan_logs').select('id', { count: 'exact', head: true }).in('serial', serials).eq('result', 'fake'),
      db.from('alerts').select('id', { count: 'exact', head: true }).eq('batch_code', batchCode).eq('resolved', false),
    ]);
    totalScans   = totalRes.count   || 0;
    verified     = verifiedRes.count || 0;
    warning      = warningRes.count  || 0;
    fake         = fakeRes.count     || 0;
    activeAlerts = alertRes.count    || 0;
  }

  const remarkCount = new Set(products.map(p => p.remark).filter(Boolean)).size;

  return {
    batch,
    stats: {
      total:        products.length,
      totalScans,
      verified,
      warning,
      fake,
      activeAlerts,
      remarkCount,
      maxSeq:       products.length ? Math.max(...products.map(p => p.seq || 0)) : 0,
      scan_limit:   batch.scan_limit ?? null,
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

async function getAlerts({ resolved, severity, batchCode, limit = 50, offset = 0 } = {}) {
  let q = db
    .from('alerts')
    .select('*')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (resolved !== undefined) q = q.eq('resolved', resolved);
  if (severity)               q = q.eq('severity', severity);
  if (batchCode)              q = q.eq('batch_code', batchCode);

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

async function getBatchScanSummary() {
  const [scanRes, prodRes, batchRes] = await Promise.all([
    db.from('scan_logs').select('serial, result'),
    db.from('products').select('serial, batch_code, product_name'),
    db.from('batches').select('batch_code, scan_limit'),
  ]);

  const prodMap   = Object.fromEntries((prodRes.data || []).map(p => [p.serial, p]));
  const batchLimits = Object.fromEntries((batchRes.data || []).map(b => [b.batch_code, b.scan_limit]));

  const map = {};
  for (const s of (scanRes.data || [])) {
    const prod = prodMap[s.serial];
    if (!prod) continue;
    const bc = prod.batch_code;
    if (!map[bc]) map[bc] = { batch_code: bc, product_name: prod.product_name, scan_limit: batchLimits[bc] ?? null, verified: 0, warning: 0, fake: 0, inactive: 0, total: 0 };
    map[bc][s.result] = (map[bc][s.result] || 0) + 1;
    map[bc].total++;
  }
  return Object.values(map).sort((a, b) => b.total - a.total);
}

async function getTopScannedSerials(batchCode, limit = 30) {
  const { data: prods, error: pErr } = await db
    .from('products')
    .select('serial, seq, remark, scan_limit, product_name')
    .eq('batch_code', batchCode);
  if (pErr) throw pErr;
  if (!prods?.length) return [];

  const serials = prods.map(p => p.serial);
  const { data: scanRows } = await db
    .from('scan_logs')
    .select('serial, result')
    .in('serial', serials);

  const scanMap = {};
  for (const s of (scanRows || [])) {
    if (!scanMap[s.serial]) scanMap[s.serial] = { verified: 0, warning: 0, fake: 0, inactive: 0, total: 0 };
    scanMap[s.serial][s.result] = (scanMap[s.serial][s.result] || 0) + 1;
    scanMap[s.serial].total++;
  }

  return prods
    .filter(p => scanMap[p.serial])
    .map(p => ({ serial: p.serial, seq: p.seq, remark: p.remark, scan_limit: p.scan_limit, ...scanMap[p.serial] }))
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}

async function getSerialNetworkData(batchCode) {
  const { data: prods, error: pErr } = await db
    .from('products')
    .select('serial, seq')
    .eq('batch_code', batchCode)
    .order('seq', { ascending: true })
    .limit(100000);
  if (pErr) throw pErr;
  if (!prods?.length) return [];

  const serials = prods.map(p => p.serial);
  const seqMap  = Object.fromEntries(prods.map(p => [p.serial, p.seq]));

  const { data: scans, error: sErr } = await db
    .from('scan_logs')
    .select('serial, ip, isp, country, city, result, scanned_at')
    .in('serial', serials)
    .order('scanned_at', { ascending: false })
    .limit(10000);
  if (sErr) throw sErr;

  const serialMap = {};
  for (const s of (scans || [])) {
    if (!serialMap[s.serial]) serialMap[s.serial] = [];
    serialMap[s.serial].push({
      ip:         s.ip         || null,
      isp:        s.isp        || null,
      country:    s.country    || null,
      city:       s.city       || null,
      result:     s.result,
      scanned_at: s.scanned_at,
    });
  }

  return Object.entries(serialMap)
    .map(([serial, scanList]) => ({
      serial,
      seq:        seqMap[serial] ?? null,
      scan_count: scanList.length,
      scans:      scanList,
    }))
    .sort((a, b) => (a.seq ?? 999999) - (b.seq ?? 999999));
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
  // Config
  getConfigValue,
  setConfigValue,
  // Batches
  upsertBatch,
  getBatches,
  getBatchById,
  setScanLimitForBatch,
  setScanLimitForRange,
  clearScanLimitForRange,
  getSerialLimitGroups,
  getSerialOverrideCounts,
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
  getBatchScanSummary,
  getTopScannedSerials,
  getSerialNetworkData,
};
