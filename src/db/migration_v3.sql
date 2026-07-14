-- Migration v3: add ISP column to scan_logs
-- Run this in Supabase SQL Editor once

ALTER TABLE scan_logs ADD COLUMN IF NOT EXISTS isp TEXT;
