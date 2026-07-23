# QRverify — Project Context
**Company:** First Molecule  
**Last updated:** 2026-07-23  
**Repo:** https://github.com/Maydayisagoodguy/QRverify  
**Live:** Render (free tier — must upgrade before go-live)

---

## What this product does

Anti-counterfeiting QR code system. Admin generates batches of unique serials, prints them on physical products as QR codes (PDF stickers). Consumer scans QR → server verifies HMAC → shows Verified / Duplicate / Fake screen.

---

## Tech stack

| Layer | Technology |
|---|---|
| Backend | Node.js 20 + Fastify v5 |
| Database | Supabase (PostgreSQL) |
| Hosting | Render (free tier — upgrade to Starter $7/mo before go-live) |
| PDF/QR | pdfkit (pure JS, no Puppeteer) |
| Geo lookup | geoip-lite (offline, no API call) |
| VPN detection | vpn.js + IPInfo.io (optional) |
| Rate limiting | Upstash Redis |
| Email alerts | Resend |
| Auth | HMAC-SHA256 (serial verification), ADMIN_API_KEY header (admin — currently NOT wired, user decision) |

---

## Environment variables required

```
HMAC_SECRET           — used to generate and verify QR HMACs
ADMIN_API_KEY         — admin key (exists in config but adminAuth.js is NOT wired into routes — user's decision)
SUPABASE_URL
SUPABASE_SERVICE_KEY
VERIFY_BASE_URL       — e.g. https://yourapp.onrender.com
SERIAL_PREFIX         — default: FM0
RESEND_API_KEY        — for fraud alert emails
ALERT_EMAIL           — recipient of fraud alerts
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
NODE_ENV=production
```

---

## Serial format

`FM0` (3-char prefix) + `XX` (2-digit HMAC batch tag, 10–99) + `NNNNN` (5-digit seq starting at 10001) = 10 chars total  
Example: `FM05710001`  
- Prefix comes from `SERIAL_PREFIX` env var
- Batch tag is `HMAC-SHA256(batchCode, HMAC_SECRET)` truncated to 2 decimal digits (10–99)
- Seq starts at `getMaxSeq(batchCode) + 1` so re-generating a batch appends, never overwrites

---

## File structure

```
src/
  app.js                    — Fastify server, all route registrations, health endpoint
  config.js                 — env var loading, fails hard on missing vars
  db/
    index.js                — ALL database functions (single source of truth for DB access)
    schema.sql              — base schema (NOTE: missing columns — see below)
  middleware/
    adminAuth.js            — HMAC key check middleware (written but NOT wired into any route)
    rateLimit.js            — Upstash Redis rate limiting (verifyRateLimit, adminRateLimit, strictRateLimit)
  routes/
    consumer/
      verify.js             — GET /v/:serial?h=HMAC — main QR scan endpoint
      product.js            — GET /api/product/:serial — product info for result page
    admin/
      generate.js           — POST /admin/generate — create batch + serials in DB
      serials.js            — batch detail, remark, scan-limit routes
      batches.js            — batch list, recall, etc.
      scans.js              — recent scan logs
      alerts.js             — fraud alerts CRUD
      analytics.js          — dashboard stats, map data, geo summary
      config.js             — admin config key/value
      upload.js             — UNUSED (Excel upload removed by user decision)
  services/
    qrgen.js                — processForm() serial generation, buildPDF() sticker PDF, verifyHMAC()
    geoip.js                — offline IP → country/city/lat/lng
    vpn.js                  — VPN/proxy detection via IPInfo.io
    mailer.js               — Resend email for fraud alerts

public/
  admin/
    index.html              — Main admin dashboard
    batch-detail.html       — Per-batch page (remarks, scan limits, serials)
    upload.html             — Upload page (legacy, not actively used)
  result.html               — Consumer verification result page
  assets/
    logo.png                — First Molecule logo (603×512px white BG PNG)
```

---

## Database schema — LIVE vs schema.sql

**schema.sql is missing these columns** (they exist in the live DB but not in the file — Problem 7 from audit):

| Table | Missing column | Type | Notes |
|---|---|---|---|
| products | seq | INTEGER | sequential number within batch |
| products | remark | TEXT | admin label e.g. "Dealer A — Kerala" |
| products | remark_updated_at | TIMESTAMPTZ | when remark was last set |
| products | scan_limit | INTEGER | per-serial override scan limit |
| batches | scan_limit | INTEGER | default scan limit for whole batch |
| batches | target_country | TEXT | expected country for geo checks |
| — | config table | — | key/value store used by getConfigValue/setConfigValue |

**alert_type CHECK constraint is also missing** `MULTI_IP_SCAN` and `SUSPECTED_PROXY` — these alert types are created in verify.js but the DB constraint rejects them silently. Fix: run migration to add them.

**Full table chain:**
```
batches (batch_code UNIQUE PK)
  └── products (serial UNIQUE, batch_code FK → batches)
        └── scan_logs (serial TEXT — NO FK, intentional, allows fake serials to be logged)
              └── alerts (serial TEXT, batch_code TEXT — no FK, free text)
```

**Triggers in DB:**
- `trg_update_batch_counts` — auto-updates `batches.total_units` and `batches.active_units` on INSERT/UPDATE of `products.is_active`
- `trg_batches_updated_at` — auto-sets `batches.updated_at = now()` on update

---

## Supabase RPC functions (must exist in DB)

### Already in schema.sql (run once at setup):
- `get_analytics_summary()` — dashboard stat cards
- `get_batch_summary()` — batch list
- `update_batch_counts()` trigger function

### MUST CREATE — not yet in schema.sql or DB:

**Run this in Supabase SQL Editor:**

```sql
CREATE OR REPLACE FUNCTION get_batch_map_data(p_batch_code TEXT, p_limit INT DEFAULT 5000)
RETURNS TABLE (
  serial       TEXT,
  lat          DOUBLE PRECISION,
  lng          DOUBLE PRECISION,
  result       TEXT,
  country      TEXT,
  city         TEXT,
  scanned_at   TIMESTAMPTZ,
  product_name TEXT,
  batch_code   TEXT
)
LANGUAGE sql STABLE AS $$
  SELECT
    sl.serial, sl.lat, sl.lng, sl.result,
    sl.country, sl.city, sl.scanned_at,
    p.product_name, p.batch_code
  FROM scan_logs sl
  JOIN products p ON p.serial = sl.serial
  WHERE p.batch_code = p_batch_code
    AND sl.lat IS NOT NULL
  ORDER BY sl.scanned_at DESC
  LIMIT p_limit;
$$;
```

**Why:** Map batch filter uses `db.rpc('get_batch_map_data')` to avoid PostgREST URL length limits that break when a batch has 1000+ serials. Without this function, selecting a large batch on the map will error.

---

## All working features (DO NOT break)

- QR generation: `POST /admin/generate` → processForm() → insertProducts() → returns batch_code + seq range
- PDF sticker generation: buildPDF() in qrgen.js — logo centered, "SCAN TO VERIFY" in red, no "GENUINE PRODUCT" text, no verify URL
- QR scan / verification: `GET /v/:serial?h=HMAC` → HMAC check → DB lookup → geo + VPN check → log scan → redirect to /result/:serial?status=...
- Duplicate detection: scan count per serial, device token tracking, multi-IP detection
- Remark logic: admin labels a range of serials (e.g. seq 1–500 → "Dealer Kerala")
- Scan limit logic: per-batch default or per-serial override, admin sets via batch-detail page
- Fraud alerts: auto-created on duplicate/suspicious scans, email sent via Resend
- Dashboard analytics: global stats + per-batch stats when batch selected
- Map: global last-500 scans on load; batch selected → fetches ALL geo scans for that batch via RPC (up to 5000 shown)
- Map filters: by result type (verified/warning/fake) and by country
- Batch detail page: serial list, remark assignment, scan limit setting, serial ranges
- Admin refresh button: resets all filters to default
- Result page: Verified / Warning (duplicate) / Fake — no report button, no "GENUINE PRODUCT", no footer logo

---

## Fixes applied this session

| Fix | Files changed |
|---|---|
| Logo correctly sized + centered in PDF sticker | src/services/qrgen.js |
| Removed "GENUINE PRODUCT", verify URL from sticker | src/services/qrgen.js |
| Removed report button + modal from result.html | public/result.html |
| Removed footer logo (was causing grey box) | public/result.html |
| Map dots filter when batch selected in panel | public/admin/index.html |
| Refresh button resets all filters | public/admin/index.html |
| Seq inputs show live serial hint in label | public/admin/batch-detail.html |
| Scan limits page shows full serial numbers | public/admin/batch-detail.html + src/db/index.js |
| Removed example placeholders from batch-detail form | public/admin/batch-detail.html |
| Map batch filter fetches all batch scans from DB (not JS filter of 500 cached) | src/db/index.js, src/routes/admin/analytics.js, public/admin/index.html |
| insertProducts chunked at 500 rows, 5 parallel — handles 100k serials | src/db/index.js |
| GET /health pings Supabase to keep both services warm | src/app.js |
| getMapData batch path uses RPC instead of .in() to avoid URL limits | src/db/index.js |

---

## Infrastructure — action required before go-live

| Action | Who | Cost |
|---|---|---|
| Upgrade Render Free → Starter | Owner action in Render dashboard | $7/mo |
| Upgrade Supabase Free → Pro | Owner action in Supabase dashboard | $25/mo |
| Run `get_batch_map_data` SQL in Supabase SQL Editor | Owner — SQL is above | $0 |
| Set up UptimeRobot to ping `GET /health` every 5 min | Owner — uptimerobot.com | $0 |
| Set `NODE_ENV=production` in Render env vars | Owner | $0 |

**Supabase Free pauses DB after 7 days idle — this breaks QR scanning. Must upgrade to Pro.**  
**Render Free sleeps after 15 min idle — first scan after idle gets a 30s cold start. Must upgrade to Starter.**

---

## User decisions (do not override)

- Excel upload removed — admin generates QR codes via form (quantity + batch details), not Excel
- Admin panel has NO authentication wired — `adminAuth.js` exists but user chose not to use it
- No "GENUINE PRODUCT" text on stickers
- No verify URL on stickers
- No report button on result page
- No complex infrastructure (no Cloudflare Workers rewrite, no job queues for now)
- Long-term hosting consideration: DigitalOcean Bangalore ($20/mo) for lower India latency — not yet migrated

---

## Known gaps (not yet fixed)

| # | Issue | Risk |
|---|---|---|
| P2 | Verified screen can be faked via `?status=verified` URL param | High — anyone can fake a verified result |
| P5 | `MULTI_IP_SCAN` and `SUSPECTED_PROXY` alerts silently fail DB constraint | Fraud detection partially broken |
| P6 | Re-uploading same batch can create duplicate serials (no idempotency check) | Medium |
| P7 | schema.sql missing 6 columns + config table — clean redeploy would fail | Medium |
| P8 | `xlsx` package (CVE-2023-30533) still in package.json — but Excel upload is removed so not a trigger path | Low (unused) |
| P12 | XSS: alert details rendered as raw HTML in admin dashboard | Low (admin-only) |

---

## Key architectural decisions

- `scan_logs.serial` has NO foreign key to `products.serial` — intentional. Allows logging scan attempts for fake/invalid serials without constraint violations.
- `batches.total_units` and `active_units` are maintained by DB trigger, not application code.
- All DB access goes through `src/db/index.js` — routes never query Supabase directly.
- Map data: global view = last 500 scans (no filter). Batch view = all geo scans for that batch via RPC (capped at 5000 for browser performance).
- Rate limiting: `verifyRateLimit` on scan endpoint, `adminRateLimit` on all admin routes.
- geoip-lite is offline — no external API call on the scan hot path. IPInfo.io is only called for VPN detection (optional, metered).
