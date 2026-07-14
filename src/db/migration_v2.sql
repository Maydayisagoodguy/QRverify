-- ============================================================
-- QR Verify System — Migration v2
-- Run this in Supabase SQL Editor on the EXISTING production DB.
-- All statements are safe to re-run (idempotent).
-- ============================================================

-- ── 1. New table: batches ────────────────────────────────────────
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


-- ── 2. New table: consumer_reports ──────────────────────────────
CREATE TABLE IF NOT EXISTS consumer_reports (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  serial           TEXT        NOT NULL,
  batch_code       TEXT,
  reporter_ip      TEXT,
  reporter_country TEXT,
  message          TEXT,
  status           TEXT        NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending', 'reviewed', 'actioned', 'dismissed')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS reports_serial_idx  ON consumer_reports(serial);
CREATE INDEX IF NOT EXISTS reports_status_idx  ON consumer_reports(status);
CREATE INDEX IF NOT EXISTS reports_created_idx ON consumer_reports(created_at DESC);


-- ── 3. New table: admin_audit_log ────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  action       TEXT        NOT NULL,
  target_type  TEXT,
  target_id    TEXT,
  details      JSONB,
  performed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_action_idx ON admin_audit_log(action);
CREATE INDEX IF NOT EXISTS audit_time_idx   ON admin_audit_log(performed_at DESC);


-- ── 4. Alter existing: alerts — add resolved_at, resolved_by ────
ALTER TABLE alerts
  ADD COLUMN IF NOT EXISTS resolved_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resolved_by  TEXT;


-- ── 5. Alter existing: products — add recalled_at ────────────────
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS recalled_at TIMESTAMPTZ;


-- ── 6. Alter existing: scan_logs — add device_token ─────────────
ALTER TABLE scan_logs
  ADD COLUMN IF NOT EXISTS device_token TEXT;


-- ── 7. New composite indexes on existing tables ──────────────────
-- Replaces the old single-column serial index with composite
CREATE INDEX IF NOT EXISTS scan_logs_serial_time_idx ON scan_logs(serial, scanned_at DESC);
CREATE INDEX IF NOT EXISTS scan_logs_ip_idx          ON scan_logs(ip) WHERE ip IS NOT NULL;
CREATE INDEX IF NOT EXISTS scan_logs_geo_idx         ON scan_logs(lat, lng) WHERE lat IS NOT NULL;

CREATE INDEX IF NOT EXISTS alerts_serial_idx      ON alerts(serial) WHERE serial IS NOT NULL;
CREATE INDEX IF NOT EXISTS alerts_batch_idx       ON alerts(batch_code) WHERE batch_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS alerts_unresolved_sev  ON alerts(severity, created_at DESC) WHERE resolved = false;

-- Drop the redundant products_serial_idx (serial UNIQUE already creates an implicit index)
DROP INDEX IF EXISTS products_serial_idx;


-- ── 8. Backfill batches from existing products ───────────────────
-- Inserts one row per unique batch_code found in products.
-- Safe to re-run — uses ON CONFLICT DO NOTHING.
INSERT INTO batches (batch_code, product_name, total_units, active_units, created_at)
SELECT
  batch_code,
  product_name,
  COUNT(*)                                           AS total_units,
  COUNT(*) FILTER (WHERE is_active = true)           AS active_units,
  MIN(created_at)                                    AS created_at
FROM products
GROUP BY batch_code, product_name
ON CONFLICT (batch_code) DO NOTHING;


-- ── 9. Function: get_analytics_summary (replaces 5 COUNT queries) ─
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
    COUNT(*)                                              AS total,
    COUNT(*) FILTER (WHERE result = 'verified')          AS verified,
    COUNT(*) FILTER (WHERE result = 'warning')           AS warning,
    COUNT(*) FILTER (WHERE result = 'fake')              AS fake,
    COUNT(*) FILTER (WHERE result = 'inactive')          AS inactive,
    (SELECT COUNT(*) FROM alerts  WHERE resolved = false) AS active_alerts,
    (SELECT COUNT(*) FROM batches)                       AS total_batches
  FROM scan_logs;
$$;


-- ── 10. Function: get_batch_summary (reads from batches table) ───
CREATE OR REPLACE FUNCTION get_batch_summary()
RETURNS TABLE (
  batch_code    TEXT,
  product_name  TEXT,
  total         BIGINT,
  active        BIGINT,
  created_at    TIMESTAMPTZ,
  status        TEXT
)
LANGUAGE sql STABLE AS $$
  SELECT
    b.batch_code,
    b.product_name,
    b.total_units   AS total,
    b.active_units  AS active,
    b.created_at,
    b.status
  FROM batches b
  ORDER BY b.created_at DESC;
$$;


-- ── 11. Trigger: auto-update batches counts on product change ────
CREATE OR REPLACE FUNCTION update_batch_counts()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE batches
    SET total_units  = total_units + 1,
        active_units = active_units + (CASE WHEN NEW.is_active THEN 1 ELSE 0 END),
        updated_at   = now()
    WHERE batch_code = NEW.batch_code;

  ELSIF TG_OP = 'UPDATE' AND OLD.is_active IS DISTINCT FROM NEW.is_active THEN
    UPDATE batches
    SET active_units = GREATEST(0, active_units + (CASE WHEN NEW.is_active THEN 1 ELSE -1 END)),
        updated_at   = now(),
        recalled_at  = CASE
                         WHEN NOT NEW.is_active AND recalled_at IS NULL THEN now()
                         ELSE recalled_at
                       END,
        status       = CASE
                         WHEN GREATEST(0, active_units + (CASE WHEN NEW.is_active THEN 1 ELSE -1 END)) = 0
                           THEN 'recalled'
                         WHEN GREATEST(0, active_units + (CASE WHEN NEW.is_active THEN 1 ELSE -1 END)) = total_units
                           THEN 'active'
                         ELSE 'partial'
                       END
    WHERE batch_code = NEW.batch_code;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_update_batch_counts ON products;
CREATE TRIGGER trg_update_batch_counts
AFTER INSERT OR UPDATE OF is_active ON products
FOR EACH ROW EXECUTE FUNCTION update_batch_counts();


-- ── 12. Function: set_updated_at ────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_batches_updated_at ON batches;
CREATE TRIGGER trg_batches_updated_at
BEFORE UPDATE ON batches
FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── 13. Row Level Security on new tables ────────────────────────
ALTER TABLE batches           ENABLE ROW LEVEL SECURITY;
ALTER TABLE consumer_reports  ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_audit_log   ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "deny_anon" ON batches          FOR ALL TO anon USING (false);
  CREATE POLICY "deny_anon" ON consumer_reports FOR ALL TO anon USING (false);
  CREATE POLICY "deny_anon" ON admin_audit_log  FOR ALL TO anon USING (false);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
