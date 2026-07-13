-- Run this once in your Supabase SQL editor (Database → SQL Editor → New query)

-- Products — one row per physical product unit
CREATE TABLE IF NOT EXISTS products (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  serial            TEXT UNIQUE NOT NULL,
  hmac              TEXT NOT NULL,
  batch_code        TEXT NOT NULL,
  product_name      TEXT NOT NULL,
  manufacturer      TEXT,
  country_of_origin TEXT,
  manufacturing_date DATE,
  expiry_date        DATE,
  product_image_url  TEXT,
  distributor        TEXT,
  region_expected    TEXT,
  is_active          BOOLEAN DEFAULT true,
  created_at         TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS products_serial_idx     ON products(serial);
CREATE INDEX IF NOT EXISTS products_batch_idx      ON products(batch_code);
CREATE INDEX IF NOT EXISTS products_active_idx     ON products(is_active);

-- Scan logs — every scan attempt, good or bad
CREATE TABLE IF NOT EXISTS scan_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  serial      TEXT NOT NULL,
  scanned_at  TIMESTAMPTZ DEFAULT now(),
  ip          TEXT,
  country     TEXT,
  city        TEXT,
  lat         DOUBLE PRECISION,
  lng         DOUBLE PRECISION,
  user_agent  TEXT,
  result      TEXT NOT NULL,
  flag_reason TEXT
);

CREATE INDEX IF NOT EXISTS scan_logs_serial_idx    ON scan_logs(serial);
CREATE INDEX IF NOT EXISTS scan_logs_at_idx        ON scan_logs(scanned_at DESC);
CREATE INDEX IF NOT EXISTS scan_logs_result_idx    ON scan_logs(result);

-- Alerts — fired when something suspicious happens
CREATE TABLE IF NOT EXISTS alerts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  serial      TEXT,
  batch_code  TEXT,
  alert_type  TEXT NOT NULL,
  severity    TEXT NOT NULL,
  details     JSONB,
  created_at  TIMESTAMPTZ DEFAULT now(),
  resolved    BOOLEAN DEFAULT false
);

CREATE INDEX IF NOT EXISTS alerts_resolved_idx     ON alerts(resolved);
CREATE INDEX IF NOT EXISTS alerts_created_idx      ON alerts(created_at DESC);
CREATE INDEX IF NOT EXISTS alerts_severity_idx     ON alerts(severity);
