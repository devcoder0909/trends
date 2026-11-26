# Deploy Guide — Ephemeral Trend Site

Zero-cost auto-publishing trend site on Cloudflare Workers.
Publishes Google Trends summaries, auto-deletes after 48 hours.

---

## Prerequisites

- **Node.js 18+** — [download](https://nodejs.org)
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

The output shows something like:

```
database_id = "abc123-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

**Copy that `database_id`** and paste it into `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "trends-db"
database_id = "abc123-xxxx-xxxx-xxxx-xxxxxxxxxxxx"  # ← your ID here
```

---

## Step 4 · Initialize the Database Schema

```bash
npm run db:init
```

This creates the `topics` and `seen_topics` tables in your remote D1 database.

---

## Step 5 · Configure Environment Variables

Edit `wrangler.toml` → `[vars]` section:

| Variable | What to set | Example |
|---|---|---|
| `SITE_HOST` | Your domain (no `https://`) | `trends.example.com` |
| `CONTACT_EMAIL` | Your contact email | `you@example.com` |
| `GEO_LIST` | Comma-separated country codes | `US,GB,IN` |
| `INDEXNOW_KEY` | Random 32-char hex string (see below) | `a1b2c3d4e5f6...` |

Generate your IndexNow key:

```bash
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
```

Paste the output as `INDEXNOW_KEY` in `wrangler.toml`.

---

## Step 6 · Set Gemini API Key (optional fallback)

Get a free API key from [Google AI Studio](https://aistudio.google.com/apikey), then:

```bash
npx wrangler secret put GEMINI_API_KEY
```

Paste your key when prompted. This is used only if Workers AI quota runs out.

---

## Step 7 · Deploy

```bash
npm run deploy
# or: npx wrangler deploy
```

Your site is live at `https://trends.YOUR-SUBDOMAIN.workers.dev`.

---

## Step 8 · Attach Your Custom Domain

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com) → **Workers & Pages**
2. Click your `trends` worker → **Settings** → **Domains & Routes**
3. Click **Add** → **Custom Domain**
4. Enter your domain (e.g., `trends.example.com`)
5. Cloudflare auto-configures DNS — wait for it to show "Active"

> **Note:** Your domain must already be on Cloudflare DNS. If it isn't, add it
> under **Websites** in the dashboard and update your registrar's nameservers.

---

## Step 9 · Verify the Cron Trigger

1. In the dashboard: **Workers & Pages** → `trends` → **Settings** → **Triggers**
2. Under "Cron Triggers", confirm `* * * * *` is listed
3. Wait 1-2 minutes, then visit your site — posts should start appearing

---

## Step 10 · Set the Kill Switch

After your first deploy, set `SITE_END_AT` to 48 hours from now:

```bash
node -e "console.log(new Date(Date.now() + 48*3600*1000).toISOString())"
```

Add the output to `wrangler.toml`:

```toml
[vars]
SITE_END_AT = "2024-12-01T12:00:00.000Z"   # ← paste the timestamp
```

Then redeploy:

```bash
npm run deploy
```

After this time, the worker stops fetching trends and serves a "site ended" page.

---

## Step 11 · Submit Sitemaps

### Google Search Console

1. Go to [Google Search Console](https://search.google.com/search-console)
2. Add your property → choose **URL prefix** → enter `https://trends.example.com`
3. Verify ownership (Cloudflare DNS method is easiest)
4. Go to **Sitemaps** → submit:
   - `https://trends.example.com/sitemap.xml`
   - `https://trends.example.com/news-sitemap.xml`

### Bing Webmaster Tools

1. Go to [Bing Webmaster Tools](https://www.bing.com/webmasters)
2. Add your site → verify via DNS
3. Go to **Sitemaps** → submit:
   - `https://trends.example.com/sitemap.xml`

> IndexNow also auto-pings Bing, Yandex, and others every time a post is
> published or removed — no manual submission needed after the initial setup.

---

## Local Testing

### 1. Create `.dev.vars`

```bash
copy .dev.vars.example .dev.vars
```

Edit `.dev.vars` and set `DEV_MODE=true`. Optionally add your Gemini key.

### 2. Initialize Local Database

```bash
npm run db:init:local
```

### 3. Run the Dev Server

```bash
npm run dev
```

Visit [http://localhost:8787](http://localhost:8787).

### 4. Trigger the Cron Manually

In a separate terminal:

```bash
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
```

This simulates a cron tick. Refresh the page to see mock posts appear.

In dev mode:
- RSS data comes from a built-in mock feed (3 sample topics)
- Content is generated from templates (no LLM calls)
- IndexNow pings are skipped

---

## Supported Endpoints

| Path | Description |
|---|---|
| `/` | Home page — all live posts, newest first |
| `/p/{slug}` | Individual post with related trends |
| `/about` | Disclosure and contact info |
| `/sitemap.xml` | XML sitemap of live posts |
| `/news-sitemap.xml` | Google News sitemap |
| `/robots.txt` | Crawl directives + sitemap locations |
| `/rss.xml` | RSS 2.0 feed |
| `/{INDEXNOW_KEY}.txt` | IndexNow verification file |

---

## Troubleshooting

| Problem | Solution |
|---|---|
| No posts appearing | Check cron trigger is set. Try `curl localhost:8787/__scheduled` locally. |
| "AI unavailable" errors | Workers AI free quota may be exhausted. Set `GEMINI_API_KEY` as fallback. |
| Posts not being indexed | Verify IndexNow key file at `/{key}.txt`. Check sitemap in Search Console. |
| Domain not connecting | Ensure domain is on Cloudflare DNS and custom domain is "Active" in dashboard. |
| Want to change countries | Update `GEO_LIST` in `wrangler.toml` and redeploy. |

---

## Cost

**\$0.** Everything runs on Cloudflare's free tier:
- Workers: 100,000 requests/day
- D1: 5 million rows read, 100K writes/day
- Workers AI: free-tier models
- Cron: included
- IndexNow: free, no signup
