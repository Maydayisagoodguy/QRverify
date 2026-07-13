'use strict';

const { createClient } = require('@supabase/supabase-js');
const config = require('../config');

const db = createClient(config.supabaseUrl, config.supabaseServiceKey, {
  auth: { persistSession: false },
});

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
  const { error } = await db.from('products').update({ is_active: false }).eq('serial', serial);
  if (error) throw error;
}

async function deactivateByBatch(batchCode) {
  const { error } = await db.from('products').update({ is_active: false }).eq('batch_code', batchCode);
  if (error) throw error;
}

async function getBatchProducts(batchCode) {
  const { data, error } = await db
    .from('products')
    .select('serial, product_name, batch_code, qr_url:serial')
    .eq('batch_code', batchCode);
  if (error) throw error;
  return data || [];
}

// ── Scan logs ─────────────────────────────────────────────────────

async function logScan({ serial, ip, country, city, lat, lng, userAgent, result, flagReason }) {
  const { data, error } = await db.from('scan_logs').insert({
    serial,
    ip,
    country:     country || null,
    city:        city || null,
    lat:         lat || null,
    lng:         lng || null,
    user_agent:  userAgent || null,
    result,
    flag_reason: flagReason || null,
  }).select('id').single();
  if (error) throw error;
  return data;
}

async function getScanHistory(serial, limit = 10) {
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
    .select(`
      id, serial, scanned_at, ip, country, city, result, flag_reason, user_agent,
      products!inner(product_name, batch_code)
    `)
    .order('scanned_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (result)    q = q.eq('result', result);
  if (batchCode) q = q.eq('products.batch_code', batchCode);
  if (from)      q = q.gte('scanned_at', from);
  if (to)        q = q.lte('scanned_at', to);

  const { data, error } = await q;
  if (error) throw error;
  return data || [];
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
  const { error } = await db.from('alerts').update({ resolved: true }).eq('id', id);
  if (error) throw error;
}

// ── Batches ───────────────────────────────────────────────────────

async function getBatches() {
  const { data, error } = await db.rpc('get_batch_summary');
  if (error) {
    // Fallback: manual query
    const { data: products, error: pe } = await db
      .from('products')
      .select('batch_code, product_name, created_at, is_active')
      .order('created_at', { ascending: false });
    if (pe) throw pe;

    const map = new Map();
    for (const p of products || []) {
      if (!map.has(p.batch_code)) {
        map.set(p.batch_code, {
          batch_code:   p.batch_code,
          product_name: p.product_name,
          total:        0,
          active:       0,
          created_at:   p.created_at,
        });
      }
      const b = map.get(p.batch_code);
      b.total++;
      if (p.is_active) b.active++;
    }
    return Array.from(map.values());
  }
  return data || [];
}

async function getBatchProductsForExport(batchCode) {
  const { data, error } = await db
    .from('products')
    .select('serial, hmac, product_name, batch_code')
    .eq('batch_code', batchCode);
  if (error) throw error;
  return data || [];
}

// ── Analytics ─────────────────────────────────────────────────────

async function getAnalyticsSummary() {
  const [total, verified, warning, fake, activeAlerts] = await Promise.all([
    db.from('scan_logs').select('id', { count: 'exact', head: true }),
    db.from('scan_logs').select('id', { count: 'exact', head: true }).eq('result', 'verified'),
    db.from('scan_logs').select('id', { count: 'exact', head: true }).eq('result', 'warning'),
    db.from('scan_logs').select('id', { count: 'exact', head: true }).eq('result', 'fake'),
    db.from('alerts').select('id', { count: 'exact', head: true }).eq('resolved', false),
  ]);

  return {
    total:        total.count || 0,
    verified:     verified.count || 0,
    warning:      warning.count || 0,
    fake:         fake.count || 0,
    activeAlerts: activeAlerts.count || 0,
  };
}

async function getMapData(limit = 500) {
  const { data, error } = await db
    .from('scan_logs')
    .select('lat, lng, result, country, city, scanned_at')
    .not('lat', 'is', null)
    .order('scanned_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

module.exports = {
  getProduct,
  insertProducts,
  deactivateBySerial,
  deactivateByBatch,
  getBatchProducts,
  getBatchProductsForExport,
  logScan,
  getScanHistory,
  getScanLogs,
  createAlert,
  getAlerts,
  resolveAlert,
  getBatches,
  getAnalyticsSummary,
  getMapData,
};
