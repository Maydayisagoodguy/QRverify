-- ============================================================
-- QR Verify System — Production Database Schema
-- Run once in Supabase SQL Editor
-- ============================================================

-- ── Extensions ───────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";


-- ── ENUMS ────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE scan_result  AS ENUM ('verified', 'warning', 'fake', 'inactive');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE alert_severity AS ENUM ('critical', 'high', 'medium', 'low');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE alert_type_enum AS ENUM (
    'DUPLICATE_SCAN',
    'SCAN_LIMIT_EXCEEDED',
    'MASS_CLONE',
    'GEO_ANOMALY',
    'HIGH_SCAN_COUNT',
    'PRODUCT_RECALLED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ── TABLE: batches ───────────────────────────────────────────────
-- One row per batch upload. Normalizes data shared by all units.
CREATE TABLE IF NOT EXISTS batches (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_code          TEXT        UNIQUE NOT NULL,
  product_name        TEXT        NOT NULL,
  manufacturer        TEXT,
  country_of_origin   TEXT,
  distributor         TEXT,
  region_expected     TEXT,
  product_image_url   TEXT,
  total_units         INTEGER     NOT NULL DEFAULT 0,
  active_units        INTEGER     NOT NULL DEFAULT 0,
  status              TEXT        NOT NULL DEFAULT 'active'
                                  CHECK (status IN ('active', 'recalled', 'partial')),
  recalled_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS batches_batch_code_idx ON batches(batch_code);
CREATE INDEX IF NOT EXISTS batches_status_idx     ON batches(status);
CREATE INDEX IF NOT EXISTS batches_created_idx    ON batches(created_at DESC);


-- ── TABLE: products ──────────────────────────────────────────────
-- One row per physical product unit (one QR code = one row)
CREATE TABLE IF NOT EXISTS products (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  serial              TEXT        UNIQUE NOT NULL,
  hmac                TEXT        NOT NULL,
  batch_code          TEXT        NOT NULL
                                  REFERENCES batches(batch_code) ON DELETE RESTRICT,
  -- Denormalized for fast verify lookup (avoids JOIN on hot path)
  product_name        TEXT        NOT NULL,
  manufacturing_date  DATE,
  expiry_date         DATE,
  is_active           BOOLEAN     NOT NULL DEFAULT true,
  recalled_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- serial has UNIQUE — Postgres creates implicit index, no need to add another
CREATE INDEX IF NOT EXISTS products_batch_idx      ON products(batch_code);
CREATE INDEX IF NOT EXISTS products_active_idx     ON products(is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS products_expiry_idx     ON products(expiry_date) WHERE expiry_date IS NOT NULL;


-- ── TABLE: scan_logs ─────────────────────────────────────────────
-- Every scan attempt, successful or not. Immutable — never update rows.
CREATE TABLE IF NOT EXISTS scan_logs (
  id          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  serial      TEXT          NOT NULL,
  scanned_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
  ip          TEXT,
  country     TEXT,
  city        TEXT,
  lat         DOUBLE PRECISION,
  lng         DOUBLE PRECISION,
  user_agent  TEXT,
  device_token TEXT,                    -- localStorage fingerprint token
  result      TEXT          NOT NULL
              CHECK (result IN ('verified', 'warning', 'fake', 'inactive')),
  flag_reason TEXT
);

-- Composite index for the most common query: getScanHistory(serial)
CREATE INDEX IF NOT EXISTS scan_logs_serial_time_idx ON scan_logs(serial, scanned_at DESC);
CREATE INDEX IF NOT EXISTS scan_logs_at_idx          ON scan_logs(scanned_at DESC);
CREATE INDEX IF NOT EXISTS scan_logs_result_idx      ON scan_logs(result);
CREATE INDEX IF NOT EXISTS scan_logs_ip_idx          ON scan_logs(ip) WHERE ip IS NOT NULL;
-- Partial index: only rows with geo data (for map queries)
CREATE INDEX IF NOT EXISTS scan_logs_geo_idx         ON scan_logs(lat, lng) WHERE lat IS NOT NULL;


-- ── TABLE: alerts ────────────────────────────────────────────────
-- Fraud alerts. Created automatically by verify pipeline.
CREATE TABLE IF NOT EXISTS alerts (
  id           UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  serial       TEXT,
  batch_code   TEXT,
  alert_type   TEXT          NOT NULL
               CHECK (alert_type IN (
                 'DUPLICATE_SCAN', 'SCAN_LIMIT_EXCEEDED', 'MASS_CLONE',
                 'GEO_ANOMALY', 'HIGH_SCAN_COUNT', 'PRODUCT_RECALLED',
                 'MULTI_IP_SCAN', 'SUSPECTED_PROXY'
               )),
  severity     TEXT          NOT NULL
               CHECK (severity IN ('critical', 'high', 'medium', 'low')),
  details      JSONB,
  resolved     BOOLEAN       NOT NULL DEFAULT false,
  resolved_at  TIMESTAMPTZ,
  resolved_by  TEXT,                   -- admin identifier when resolved
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS alerts_resolved_idx    ON alerts(resolved) WHERE resolved = false;
CREATE INDEX IF NOT EXISTS alerts_severity_idx    ON alerts(severity);
CREATE INDEX IF NOT EXISTS alerts_created_idx     ON alerts(created_at DESC);
CREATE INDEX IF NOT EXISTS alerts_serial_idx      ON alerts(serial) WHERE serial IS NOT NULL;
CREATE INDEX IF NOT EXISTS alerts_batch_idx       ON alerts(batch_code) WHERE batch_code IS NOT NULL;
-- Composite: most common dashboard query
CREATE INDEX IF NOT EXISTS alerts_unresolved_sev  ON alerts(severity, created_at DESC) WHERE resolved = false;


-- ── TABLE: consumer_reports ──────────────────────────────────────
-- When a consumer taps "Report this product" on the result page.
CREATE TABLE IF NOT EXISTS consumer_reports (
  id           UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  serial       TEXT          NOT NULL,
  batch_code   TEXT,
  reporter_ip  TEXT,
  reporter_country TEXT,
  message      TEXT,
  status       TEXT          NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'reviewed', 'actioned', 'dismissed')),
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  reviewed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS reports_serial_idx  ON consumer_reports(serial);
CREATE INDEX IF NOT EXISTS reports_status_idx  ON consumer_reports(status);
CREATE INDEX IF NOT EXISTS reports_created_idx ON consumer_reports(created_at DESC);


-- ── TABLE: admin_audit_log ───────────────────────────────────────
-- Tracks every admin action for compliance and accountability.
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  action      TEXT          NOT NULL,   -- 'RECALL_BATCH', 'RESOLVE_ALERT', 'UPLOAD_BATCH'
  target_type TEXT,                      -- 'batch', 'alert', 'product'
  target_id   TEXT,                      -- batch_code, alert id, etc.
  details     JSONB,
  performed_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_action_idx  ON admin_audit_log(action);
CREATE INDEX IF NOT EXISTS audit_time_idx    ON admin_audit_log(performed_at DESC);


-- ── FUNCTION: get_batch_summary ──────────────────────────────────
-- Called by getBatches(). Single efficient query, no full table scan.
CREATE OR REPLACE FUNCTION get_batch_summary()
RETURNS TABLE (
  batch_code    TEXT,
  product_name  TEXT,
  total         BIGINT,
  active        BIGINT,
  created_at    TIMESTAMPTZ
)
LANGUAGE sql STABLE AS $$
  SELECT
    b.batch_code,
    b.product_name,
    b.total_units   AS total,
    b.active_units  AS active,
    b.created_at
  FROM batches b
  ORDER BY b.created_at DESC;
$$;


-- ── FUNCTION: get_analytics_summary ─────────────────────────────
-- Single query for dashboard stats (replaces 5 separate COUNT queries).
CREATE OR REPLACE FUNCTION get_analytics_summary()
RETURNS TABLE (
  total         BIGINT,
  verified      BIGINT,
  warning       BIGINT,
  fake          BIGINT,
  inactive      BIGINT,
  active_alerts BIGINT,
  total_batches BIGINT
)
LANGUAGE sql STABLE AS $$
  SELECT
    COUNT(*)                                          AS total,
    COUNT(*) FILTER (WHERE result = 'verified')      AS verified,
    COUNT(*) FILTER (WHERE result = 'warning')       AS warning,
    COUNT(*) FILTER (WHERE result = 'fake')          AS fake,
    COUNT(*) FILTER (WHERE result = 'inactive')      AS inactive,
    (SELECT COUNT(*) FROM alerts  WHERE resolved = false) AS active_alerts,
    (SELECT COUNT(*) FROM batches)                   AS total_batches
  FROM scan_logs;
$$;


-- ── FUNCTION: update_batch_counts ───────────────────────────────
-- Keeps batches.total_units and active_units in sync automatically.
CREATE OR REPLACE FUNCTION update_batch_counts()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE batches
    SET total_units  = total_units + 1,
        active_units = active_units + (CASE WHEN NEW.is_active THEN 1 ELSE 0 END),
        updated_at   = now()
    WHERE batch_code = NEW.batch_code;

  ELSIF TG_OP = 'UPDATE' AND OLD.is_active != NEW.is_active THEN
    UPDATE batches
    SET active_units = active_units + (CASE WHEN NEW.is_active THEN 1 ELSE -1 END),
        updated_at   = now(),
        recalled_at  = CASE WHEN NOT NEW.is_active AND recalled_at IS NULL THEN now() ELSE recalled_at END,
        status       = CASE
                         WHEN active_units + (CASE WHEN NEW.is_active THEN 1 ELSE -1 END) = 0          THEN 'recalled'
                         WHEN active_units + (CASE WHEN NEW.is_active THEN 1 ELSE -1 END) = total_units THEN 'active'
                         ELSE 'partial'
                       END
    WHERE batch_code = NEW.batch_code;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER trg_update_batch_counts
AFTER INSERT OR UPDATE OF is_active ON products
FOR EACH ROW EXECUTE FUNCTION update_batch_counts();


-- ── FUNCTION: set_updated_at ────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER trg_batches_updated_at
BEFORE UPDATE ON batches
FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── ROW LEVEL SECURITY ───────────────────────────────────────────
-- Supabase: service role key bypasses RLS — safe for server-side use.
-- Enabling RLS prevents accidental public exposure via anon key.
ALTER TABLE products          ENABLE ROW LEVEL SECURITY;
ALTER TABLE batches           ENABLE ROW LEVEL SECURITY;
ALTER TABLE scan_logs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerts            ENABLE ROW LEVEL SECURITY;
ALTER TABLE consumer_reports  ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_audit_log   ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS automatically (no policy needed for it).
-- Deny all access via anon/public key:
DO $$ BEGIN
  CREATE POLICY "deny_anon" ON products         FOR ALL TO anon USING (false);
  CREATE POLICY "deny_anon" ON batches          FOR ALL TO anon USING (false);
  CREATE POLICY "deny_anon" ON scan_logs        FOR ALL TO anon USING (false);
  CREATE POLICY "deny_anon" ON alerts           FOR ALL TO anon USING (false);
  CREATE POLICY "deny_anon" ON consumer_reports FOR ALL TO anon USING (false);
  CREATE POLICY "deny_anon" ON admin_audit_log  FOR ALL TO anon USING (false);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
