# QR Verify — Setup Guide
### From zero to production in ~20 minutes

---

## Step 1 — Generate your secret keys

```bash
npm run keygen
```

Copy the two values it prints. You'll need them in steps 3–5.

---

## Step 2 — Supabase (database)

1. Go to [supabase.com](https://supabase.com) → **New project**
2. Choose a name, set a database password, pick a region close to your users
3. Wait ~2 min for the project to spin up
4. Go to **SQL Editor** → **New query**
5. Paste the entire contents of `src/db/schema.sql` → click **Run**
6. Go to **Project Settings → API**
   - Copy **Project URL** → this is your `SUPABASE_URL`
   - Copy **service_role** key (under "Project API keys") → this is your `SUPABASE_SERVICE_KEY`
   - ⚠️ Never expose the service_role key in browser code

---

## Step 3 — Upstash Redis (rate limiting)

1. Go to [upstash.com](https://upstash.com) → **Create Database**
2. Choose **Redis**, pick a region, click **Create**
3. Click your database → **REST API** tab
4. Copy:
   - **UPSTASH_REDIS_REST_URL**
   - **UPSTASH_REDIS_REST_TOKEN**

> Rate limiting works without Redis in development (it gracefully skips). Only required in production.

---

## Step 4 — Resend (email alerts)

1. Go to [resend.com](https://resend.com) → sign up free
2. **API Keys** → **Create API Key** → copy it → `RESEND_API_KEY`
3. Set `ALERT_EMAIL` to the address where you want fraud alerts sent
4. Verify your sending domain (or use `onboarding@resend.dev` for testing)

> Optional — the app works without this. You just won't get email alerts.

---

## Step 5 — Local development

```bash
cd qr-verify-system
npm install

# Copy the example env file
cp .env.example .env
```

Edit `.env` and fill in all values from steps 1–4:

```env
PORT=3000
NODE_ENV=development
VERIFY_BASE_URL=http://localhost:3000

HMAC_SECRET=<from keygen>
ADMIN_API_KEY=<from keygen>

SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key

UPSTASH_REDIS_REST_URL=https://your-db.upstash.io
UPSTASH_REDIS_REST_TOKEN=your-token

RESEND_API_KEY=re_xxxx
ALERT_EMAIL=you@example.com
```

Start the server:

```bash
npm run dev
```

Open:
- **Admin**: http://localhost:3000/admin  (use your `ADMIN_API_KEY` to log in)
- **Verify** (test): http://localhost:3000/v/TEST-serial?h=invalid (should show Fake)

---

## Step 6 — Render (production deploy)

1. Push your project to a **GitHub repo** (public or private)

2. Go to [render.com](https://render.com) → **New → Web Service**

3. Connect your GitHub repo

4. Render auto-detects `render.yaml` — confirm the settings:
   - **Build command**: `npm install`
   - **Start command**: `node src/app.js`
   - **Node version**: 22

5. Go to **Environment** → add all env vars from your `.env`:
   - `HMAC_SECRET`
   - `ADMIN_API_KEY`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_KEY`
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
   - `RESEND_API_KEY`
   - `ALERT_EMAIL`
   - `NODE_ENV` = `production`
   - `VERIFY_BASE_URL` = `https://your-app.onrender.com`

6. Click **Create Web Service** — Render builds and deploys automatically

7. Your app is live at `https://your-app-name.onrender.com`

---

## Step 7 — Custom domains (optional)

In Render → your service → **Settings → Custom Domains**:

- Add `verify.yourdomain.com` → set as CNAME to your Render URL
- Add `admin.yourdomain.com` → same CNAME

Both point to the same service. Update `VERIFY_BASE_URL` to your verify domain.

---

## Step 8 — Test the full pipeline

1. **Admin**: Go to `/admin/upload` → upload the sample Excel below → download ZIP
2. **Print**: Put a QR sticker on a box
3. **Scan**: Scan the QR with your phone camera
4. **Verify page**: Should show green "Authentic Product ✓"
5. **Scan again** from a different network: Should show yellow warning
6. **Admin**: Check Alerts section → you should see a `DUPLICATE_SCAN` alert

### Sample Excel (create this as test.xlsx)

| product_name | batch_code | serial_prefix | quantity | manufacturing_date | expiry_date | manufacturer | country_of_origin |
|---|---|---|---|---|---|---|---|
| Test Product | BATCH-TEST-001 | TEST | 5 | 2025-01-01 | 2027-01-01 | Test Co. | India |

---

## Architecture summary

```
Consumer scans QR
       ↓
GET /v/:serial?h=<hmac>
       ↓
1. HMAC validated (crypto.timingSafeEqual)
2. Serial looked up in Supabase
3. Scan history checked
4. Geo-IP resolved (offline)
5. Fraud rules applied
6. Scan logged
7. Alert created if flagged
8. Redirect → /result/:serial?status=...
       ↓
result.html loads product from /api/product/:serial
       ↓
Consumer sees: ✅ Verified / ⚠️ Warning / ❌ Fake / 🚫 Recalled
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| 401 on admin routes | Check `ADMIN_API_KEY` matches what you enter in the UI |
| DB errors on upload | Check `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`, run schema.sql |
| Rate limit errors | Check Upstash credentials, or set `NODE_ENV=development` to skip |
| QR codes show Fake | `VERIFY_BASE_URL` must exactly match the domain in the QR URL |
| ZIP download hangs | Large batches (1000+) take 10–30s — this is normal |
