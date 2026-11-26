# Deploy Guide — Ephemeral Trend Site

Zero-cost auto-publishing trend site on Cloudflare Workers.
Publishes source-grounded Google Trends + Google News summaries. Posts expire after **48 hours** by default, or **7 days** if they receive organic search traffic within their first 48 hours.

---

## Prerequisites

- **Node.js 22+** (Node 24 recommended for local `node:sqlite` tests) — [download](https://nodejs.org)
- **Cloudflare account** (free) — [sign up](https://dash.cloudflare.com/sign-up)
- **Domain** pointed to Cloudflare DNS (optional — works on `*.workers.dev` too)

---

## Step 1 · Install Dependencies

```bash
cd trends
npm install
```

This installs `wrangler` (Cloudflare's CLI) as a dev dependency.

---

## Step 2 · Login to Cloudflare

```bash
npx wrangler login
```

A browser window opens. Authorize Wrangler to access your account.

---

## Step 3 · Create the D1 Database

```bash
npx wrangler d1 create trends-db
```

Copy the `database_id` from the output and paste it into `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "trends-db"
database_id = "abc123-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

---

## Step 4 · Initialize (or Migrate) the Database Schema

### Fresh installation

```bash
npm run db:init
```

### Upgrading an existing database (keeps all existing data)

If you already deployed an earlier version of `trends-db`, run the `ALTER TABLE` migrations instead of recreating the database:

```bash
# If upgrading from v1 (initial schema):
npx wrangler d1 execute trends-db --remote --file=migrations/001_quality_upgrade.sql

# Add tiered post lifetime columns (search_hits, extended, last_search_hit_at):
npx wrangler d1 execute trends-db --remote --file=migrations/002_tiered_lifetime.sql
```

Or run the individual `ALTER TABLE` statements directly via CLI:

```bash
npx wrangler d1 execute trends-db --remote --command="ALTER TABLE topics ADD COLUMN search_hits INTEGER NOT NULL DEFAULT 0; ALTER TABLE topics ADD COLUMN extended INTEGER NOT NULL DEFAULT 0; ALTER TABLE topics ADD COLUMN last_search_hit_at TEXT;"
```

For local D1 testing, replace `--remote` with `--local`.

---

## Step 5 · Configure Environment Variables

Edit `wrangler.toml` → `[vars]`:

| Variable | What to set | Default / Example |
|---|---|---|
| `SITE_HOST` | Your domain (no `https://`) | `trends.example.com` |
| `SITE_NAME` | Site & JSON-LD publisher name | `Trending Now` |
| `CONTACT_EMAIL` | Your contact email (E-E-A-T footer & `/about`) | `you@example.com` |
| `GEO_LIST` | Comma-separated country codes (`hreflang` activates when >1) | `US,GB,CA,AU,IN` |
| `MAX_DAILY` | Daily published post cap | `60` |
| `INDEXNOW_KEY` | Random 32-char hex string | `a1b2c3d4...` |
| `BASE_TTL_HOURS` | Default post lifetime in hours | `48` |
| `EXTENDED_TTL_HOURS` | Extended lifetime in hours (7 days = 168) | `168` |
| `EXTEND_MIN_HITS` | Human search-engine visits in first 48h to trigger extension | `1` |
| `SITE_END_AT` | Optional ISO timestamp to stop fetching new topics | `2026-12-01T00:00:00Z` |

Generate your IndexNow key:

```bash
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
```

---

## Step 6 · Set Gemini API Key (free fallback)

Get a free API key from [Google AI Studio](https://aistudio.google.com/apikey), then:

```bash
npx wrangler secret put GEMINI_API_KEY
```

This is used automatically if Workers AI quota runs out.

---

## Step 7 · Deploy

```bash
npm run deploy
```

Your site is live at `https://trends.YOUR-SUBDOMAIN.workers.dev`.

---

## Step 8 · Attach Your Custom Domain

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com) → **Workers & Pages**
2. Click your `trends` worker → **Settings** → **Domains & Routes**
3. Click **Add** → **Custom Domain**
4. Enter your domain (e.g., `trends.example.com`)
5. Cloudflare auto-configures DNS — wait for status **Active**

---

## Step 9 · Verify the Cron Trigger

1. In the dashboard: **Workers & Pages** → `trends` → **Settings** → **Triggers**
2. Confirm `* * * * *` is active under **Cron Triggers**
3. Wait 1–2 minutes and refresh `/` — high-traffic topics with at least 2 distinct outlets will publish automatically

To review topics rejected by the sensitivity filter, single-source timeout, or quality gate:

```bash
npx wrangler d1 execute trends-db --remote --command="SELECT topic, reason, details, rejected_at FROM rejected ORDER BY rejected_at DESC LIMIT 25;"
```

---

## Step 10 · Kill Switch Behavior (`SITE_END_AT`)

When `SITE_END_AT` is set and the timestamp passes:

1. **New fetching stops**: the cron job stops fetching Google Trends / Google News RSS and stops publishing new or queued topics.
2. **Live & extended posts keep serving**: existing posts (including those extended to 7 days via search traction) stay live until their own `expires_at` passes, and continue expiring cleanly one by one.
3. **Full 410 shutdown**: once all remaining posts pass their `expires_at`, every URL returns **HTTP 410 Gone** (`This site has ended`), while `/{INDEXNOW_KEY}.txt` remains readable so IndexNow can verify final removal pings.

Generate a timestamp 48 hours from now:

```bash
node -e "console.log(new Date(Date.now() + 48*3600*1000).toISOString())"
```

---

## Step 11 · Submit Sitemaps

### Google Search Console

1. Go to [Google Search Console](https://search.google.com/search-console)
2. Add your property → **URL prefix** → `https://trends.example.com`
3. Verify ownership via Cloudflare DNS
4. Go to **Sitemaps** and submit:
   - `https://trends.example.com/sitemap.xml` (all live posts, including 7-day extended posts)
   - `https://trends.example.com/news-sitemap.xml` (last 48 hours only)

### Bing Webmaster Tools

1. Go to [Bing Webmaster Tools](https://www.bing.com/webmasters)
2. Add your site → verify via DNS
3. Submit `https://trends.example.com/sitemap.xml`
4. IndexNow automatically notifies Bing and partner engines whenever posts are published, updated, extended, or deleted.

---

## Local Testing & Verification

### Automated Pipeline & Lifetime Tests

```bash
npm run test:content     # Runs 10 mock topics + quality gate checks (PASS / REJECT)
npm run test:lifetime    # Simulates 0-hit 48h expiry, 3-hit 7-day extension, bot filter, and SITE_END_AT
```

### Local Dev Server

```bash
copy .dev.vars.example .dev.vars
npm run db:init:local
npm run dev
```

Trigger a local cron tick in another terminal:

```bash
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
```

---

## Scaling & High-Traffic Guide (100K+ to 1M+/day)

- **Free Tier Limits**: Cloudflare Workers Free includes **100,000 Worker requests/day** and D1 Free includes **5M row reads/day**.
- **Edge Caching (`caches.default`)**: The Worker caches 200 responses at the edge (`s-maxage=60`) so repeated hits avoid D1 reads while still recording search-engine referrals asynchronously.
- **Scaling Beyond 100K/day on Cloudflare**:
  1. Enable **Always Use HTTPS** (SSL/TLS → Edge Certificates) and add a **Redirect Rule** from `www.trendingrightnow.online/*` → `https://trendingrightnow.online/$1` (301).
  2. Add a **Cloudflare Cache Rule** (`Caching → Cache Rules`) matching `trendingrightnow.online/*` (excluding `/{INDEXNOW_KEY}.txt`) with **Eligible for cache** and **Edge TTL = Respect origin** (`60s`) so Cloudflare's CDN serves traffic spikes before Worker quota is used.
  3. Upgrade to **Workers Paid ($5/month)** if uncached dynamic requests exceed 100,000/day (includes 10M requests/month + higher D1/Workers AI capacity).

---

## Cost

**\$0.** Runs entirely within Cloudflare's free tier (Workers, Cron, D1, Workers AI) with Gemini free API fallback and IndexNow.
