/**
 * `npm run test:lifetime`
 * Simulates tiered post lifetime against an in-memory SQLite D1 shim:
 * 1. Post with 0 search hits -> deleted at 48h -> 410 Gone
 * 2. Post with 3 Google-referred human hits -> extended to 7 days -> 200 at 49h, excluded from news-sitemap, included in sitemap.xml
 * 3. Bot hits (Googlebot / bingbot) -> ignored -> deleted at 48h
 * 4. SITE_END_AT -> stops fetching new topics, keeps serving extended post until 7d expires, then 410 everywhere
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { handleFetch, handleScheduled, canSendWebhookNow, getPublishAllowance } from '../src/index.js';
import { processExpirationsAndExtensions } from '../src/lifetime.js';
import { getSettings } from '../src/config.js';
import { parseTrendsRSS } from '../src/rss.js';
import { PILLAR_GUIDES } from '../src/pillars.js';

/** Minimal D1-compatible wrapper backed by Node's built-in node:sqlite */
function createD1Shim(sqlFile) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(fs.readFileSync(sqlFile, 'utf8'));

  const wrap = (sql, params = []) => ({
    bind(...args) {
      return wrap(sql, args);
    },
    async run() {
      const stmt = sqlite.prepare(sql);
      const info = stmt.run(...params);
      return { success: true, meta: info };
    },
    async first() {
      const stmt = sqlite.prepare(sql);
      return stmt.get(...params) || null;
    },
    async all() {
      const stmt = sqlite.prepare(sql);
      return { results: stmt.all(...params) };
    },
    _exec() {
      return sqlite.prepare(sql).run(...params);
    },
  });

  return {
    sqlite,
    prepare(sql) {
      return wrap(sql);
    },
    async batch(stmts) {
      return stmts.map(s => s._exec());
    },
  };
}

function makeCtx() {
  const pending = [];
  return {
    waitUntil(p) { pending.push(p); },
    async flush() { await Promise.all(pending); pending.length = 0; },
  };
}

function insertPost(db, { slug, title, createdAt, expiresAt, category = 'Tech' }) {
  db.sqlite.prepare(
    `INSERT INTO topics (slug, title, body, summary, what_happened, why_trending, key_facts, what_to_know_next, also_searched, bullets, sources, source_urls, category, topic, geo, status, created_at, updated_at, expires_at)
     VALUES (?, ?, 'Body text.', 'Summary sentence.', 'What happened text.', 'Why trending text.', '["Fact [BBC]","Fact [CNN]","Fact [AP]"]', 'What next text.', '[]', '[]', 'BBC, CNN', '[]', ?, ?, 'US', 'published', ?, ?, ?)`
  ).run(slug, title, category, title, createdAt, createdAt, expiresAt);
  db.sqlite.prepare('INSERT INTO seen_topics (topic_hash, slug, seen_at) VALUES (?, ?, ?)').run(slug, slug, createdAt);
}

async function run() {
  const results = [];
  const record = (name, ok, detail = '') => {
    results.push({ name, ok, detail });
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  };

  // Verify migration 002 runs cleanly on a v1 table without losing data
  try {
    const migDb = new DatabaseSync(':memory:');
    migDb.exec(`
      CREATE TABLE topics (id INTEGER PRIMARY KEY, slug TEXT, title TEXT, body TEXT, bullets TEXT, sources TEXT, topic TEXT, geo TEXT, status TEXT, created_at TEXT, expires_at TEXT);
      INSERT INTO topics (slug, title, body, bullets, sources, topic, geo, status, created_at, expires_at) VALUES ('old-post', 'Old', 'B', '[]', 'BBC', 'Old', 'US', 'published', '2026-11-24T00:00:00Z', '2026-11-26T00:00:00Z');
    `);
    migDb.exec(fs.readFileSync('migrations/002_tiered_lifetime.sql', 'utf8'));
    const row = migDb.prepare('SELECT slug, search_hits, extended, last_search_hit_at FROM topics WHERE slug = ?').get('old-post');
    assert.equal(row.slug, 'old-post');
    assert.equal(row.search_hits, 0);
    assert.equal(row.extended, 0);
    record('Migration 002 preserves existing rows', true);
  } catch (err) {
    record('Migration 002 preserves existing rows', false, err.message);
  }

  const db = createD1Shim('schema.sql');
  const env = {
    DB: db,
    SITE_HOST: 'trends.example.com',
    CONTACT_EMAIL: 'you@example.com',
    BASE_TTL_HOURS: '48',
    EXTENDED_TTL_HOURS: '168',
    EXTEND_MIN_HITS: '1',
    DEV_MODE: 'true',
  };
  const settings = getSettings(env);

  const nowMs = Date.now();
  const created49hAgo = new Date(nowMs - 49 * 3600_000).toISOString();
  const expires1hAgo = new Date(nowMs - 1 * 3600_000).toISOString();
  const created10hAgo = new Date(nowMs - 10 * 3600_000).toISOString();
  const expires38hFuture = new Date(nowMs + 38 * 3600_000).toISOString();

  // Seed posts
  insertPost(db, { slug: 'zero-hit-post', title: 'Zero Hit Topic', createdAt: created49hAgo, expiresAt: expires1hAgo });
  insertPost(db, { slug: 'bot-only-post', title: 'Bot Only Topic', createdAt: created10hAgo, expiresAt: expires38hFuture });
  insertPost(db, { slug: 'google-hit-post', title: 'Popular Google Topic', createdAt: created10hAgo, expiresAt: expires38hFuture });

  // Case 1: Bot hits must be ignored
  const ctx = makeCtx();
  await handleFetch(new Request('https://trends.example.com/p/bot-only-post', {
    method: 'GET',
    headers: { 'Referer': 'https://www.google.com/search?q=bot', 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
  }), env, ctx);
  await handleFetch(new Request('https://trends.example.com/p/bot-only-post', {
    method: 'GET',
    headers: { 'Referer': 'https://www.bing.com/search?q=bot', 'User-Agent': 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)' },
  }), env, ctx);
  await ctx.flush();

  const botRow = await db.prepare('SELECT search_hits FROM topics WHERE slug = ?').bind('bot-only-post').first();
  record('Bot hits ignored (Googlebot & bingbot)', botRow.search_hits === 0, `search_hits=${botRow.search_hits}`);

  // Case 2: 3 Google-referred human hits increment search_hits without storing personal data
  for (let i = 0; i < 3; i++) {
    await handleFetch(new Request('https://trends.example.com/p/google-hit-post', {
      method: 'GET',
      headers: { 'Referer': 'https://www.google.com/', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0' },
    }), env, ctx);
  }
  await ctx.flush();

  const popRow = await db.prepare('SELECT search_hits, last_search_hit_at FROM topics WHERE slug = ?').bind('google-hit-post').first();
  record('3 Google-referred human hits counted', popRow.search_hits === 3 && Boolean(popRow.last_search_hit_at), `search_hits=${popRow.search_hits}`);

  // Home page Bing-referred human hit should also count on live posts
  await handleFetch(new Request('https://trends.example.com/', {
    method: 'GET',
    headers: { 'Referer': 'https://www.bing.com/search?q=trends', 'User-Agent': 'Mozilla/5.0 Chrome/130.0' },
  }), env, ctx);
  await ctx.flush();
  const homeHitRow = await db.prepare('SELECT search_hits FROM topics WHERE slug = ?').bind('google-hit-post').first();
  record('Home page search hit increments live post count', homeHitRow.search_hits === 4, `search_hits=${homeHitRow.search_hits}`);

  // Age bot-only-post & google-hit-post past 48h (49h old, with hit recorded at hour 10) and run expiration/extension
  const created49 = new Date(nowMs - 49 * 3600_000).toISOString();
  const hitAtHour10 = new Date(nowMs - 39 * 3600_000).toISOString();
  const expiredAt48 = new Date(nowMs - 1 * 3600_000).toISOString();
  db.sqlite.prepare('UPDATE topics SET created_at = ?, expires_at = ? WHERE slug = ?').run(created49, expiredAt48, 'bot-only-post');
  db.sqlite.prepare('UPDATE topics SET created_at = ?, expires_at = ?, last_search_hit_at = ? WHERE slug = ?').run(created49, expiredAt48, hitAtHour10, 'google-hit-post');

  const cycle = await processExpirationsAndExtensions(db, new Date(nowMs).toISOString(), settings);

  // Zero-hit and bot-only posts should be deleted -> 410 Gone
  const zeroRes = await handleFetch(new Request('https://trends.example.com/p/zero-hit-post'), env, ctx);
  const botRes = await handleFetch(new Request('https://trends.example.com/p/bot-only-post'), env, ctx);
  record('0-hit post deleted at 48h and returns 410', zeroRes.status === 410 && cycle.deletedSlugs.includes('zero-hit-post'), `status=${zeroRes.status}`);
  record('Bot-hit-only post deleted at 48h and returns 410', botRes.status === 410 && cycle.deletedSlugs.includes('bot-only-post'), `status=${botRes.status}`);

  // Google-hit post should be extended to 7 days (168h) -> 200 OK
  const extRow = await db.prepare('SELECT extended, expires_at FROM topics WHERE slug = ?').bind('google-hit-post').first();
  const extHoursLeft = Math.round((Date.parse(extRow.expires_at) - nowMs) / 3600_000);
  const extRes = await handleFetch(new Request('https://trends.example.com/p/google-hit-post'), env, ctx);
  const extHtml = await extRes.text();
  record(
    '3-hit post extended to 7 days and stays live at 49h',
    extRow.extended === 1 && extHoursLeft >= 118 && extRes.status === 200 && cycle.extendedSlugs.includes('google-hit-post') && !extHtml.includes('Expires in'),
    `extended=${extRow.extended}, hoursLeft=${extHoursLeft}, status=${extRes.status}`
  );

  // Sitemaps & category hub check: extended >48h old post MUST be in sitemap.xml and /c/tech, NOT in news-sitemap.xml
  const smXml = await (await handleFetch(new Request('https://trends.example.com/sitemap.xml'), env, ctx)).text();
  const nsmXml = await (await handleFetch(new Request('https://trends.example.com/news-sitemap.xml'), env, ctx)).text();
  const catRes = await handleFetch(new Request('https://trends.example.com/c/tech'), env, ctx);
  const catHtml = await catRes.text();
  record(
    'Sitemap keeps extended post & /c/tech hub; news-sitemap limits to 48h',
    smXml.includes('/p/google-hit-post') && smXml.includes('/c/tech') && !nsmXml.includes('/p/google-hit-post') && nsmXml.includes('<url>') && catRes.status === 200 && catHtml.includes('google-hit-post'),
    `catStatus=${catRes.status}`
  );

  // 7-day cleanup check: old seen_topics & rejected rows (>7 days) are purged by handleScheduled
  const old8d = new Date(nowMs - 8 * 86400_000).toISOString();
  db.sqlite.prepare('INSERT INTO rejected (topic_hash, topic, geo, reason, details, rejected_at) VALUES (?, ?, ?, ?, ?, ?)').run('old-rej', 'Old Rej', 'US', 'sensitive', '', old8d);
  db.sqlite.prepare('INSERT INTO seen_topics (topic_hash, slug, seen_at) VALUES (?, ?, ?)').run('old-seen', 'old-seen', old8d);
  await handleScheduled({ ...env, SITE_END_AT: new Date(nowMs - 1000).toISOString() });
  const oldRejLeft = db.sqlite.prepare('SELECT COUNT(*) as c FROM rejected WHERE topic_hash = ?').get('old-rej').c;
  const oldSeenLeft = db.sqlite.prepare('SELECT COUNT(*) as c FROM seen_topics WHERE topic_hash = ?').get('old-seen').c;
  record('7-day cleanup purges old rejected & seen_topics rows', oldRejLeft === 0 && oldSeenLeft === 0, `rej=${oldRejLeft}, seen=${oldSeenLeft}`);

  // Case 4: Kill switch SITE_END_AT — keeps serving extended post until its 7-day expires_at, then 410 everything
  const endedEnv = { ...env, SITE_END_AT: new Date(nowMs - 3600_000).toISOString() };
  const liveAfterEnd = await handleFetch(new Request('https://trends.example.com/p/google-hit-post'), endedEnv, ctx);
  const homeAfterEnd = await handleFetch(new Request('https://trends.example.com/'), endedEnv, ctx);
  record(
    'SITE_END_AT keeps serving live extended post until expires_at',
    liveAfterEnd.status === 200 && homeAfterEnd.status === 200,
    `post=${liveAfterEnd.status}, home=${homeAfterEnd.status}`
  );

  // Fast-forward past 7 days (169h) -> delete -> 410 everything
  const futureAfter7d = new Date(nowMs + 125 * 3600_000).toISOString();
  await processExpirationsAndExtensions(db, futureAfter7d, settings);
  const homeDead = await handleFetch(new Request('https://trends.example.com/'), endedEnv, ctx);
  const postDead = await handleFetch(new Request('https://trends.example.com/p/google-hit-post'), endedEnv, ctx);
  record(
    'After extended post expires past SITE_END_AT, everything returns 410',
    homeDead.status === 410 && postDead.status === 410,
    `home=${homeDead.status}, post=${postDead.status}`
  );

  // Case 5: Pagination, Search, Back Button, Redirects, OG PNG & Favicon
  const uiDb = createD1Shim('schema.sql');
  const uiEnv = { ...env, DB: uiDb };
  for (let i = 1; i <= 15; i++) {
    const cAt = new Date(nowMs - (16 - i) * 60_000).toISOString();
    const eAt = new Date(nowMs + 40 * 3600_000).toISOString();
    insertPost(uiDb, {
      slug: `topic-${i}`,
      title: `Trending Topic Number ${i} Update`,
      createdAt: cAt,
      expiresAt: eAt,
      category: i <= 12 ? 'Tech' : 'Sports',
    });
  }

  const pg1Res = await handleFetch(new Request('https://trends.example.com/'), uiEnv, ctx);
  const pg1Html = await pg1Res.text();
  const pg1Cards = (pg1Html.match(/<article class="c"/g) || []).length;
  const pg2Res = await handleFetch(new Request('https://trends.example.com/page/2'), uiEnv, ctx);
  const pg2Html = await pg2Res.text();
  const pg2Cards = (pg2Html.match(/<article class="c"/g) || []).length;
  const pg9Res = await handleFetch(new Request('https://trends.example.com/page/9'), uiEnv, ctx);

  record(
    'Pagination splits 15 posts into 10 on page 1, 5 on page 2, 404 out-of-range',
    pg1Res.status === 200 && pg1Cards === 10 && pg2Res.status === 200 && pg2Cards === 5 &&
    pg2Html.includes('data-bk="1"') && pg2Html.includes('<link rel="canonical" href="https://trends.example.com/page/2">') &&
    pg9Res.status === 404,
    `pg1=${pg1Cards}, pg2=${pg2Cards}, pg9=${pg9Res.status}`
  );

  const r1 = await handleFetch(new Request('https://trends.example.com/?page=2'), uiEnv, ctx);
  const r2 = await handleFetch(new Request('https://trends.example.com/page/1'), uiEnv, ctx);
  const r3 = await handleFetch(new Request('https://trends.example.com/c/tech?page=2'), uiEnv, ctx);
  const r4 = await handleFetch(new Request('https://trends.example.com/c/tech/page/1'), uiEnv, ctx);
  record(
    'Pagination canonical 301 redirects (?page=N, /page/1, /c/cat/page/1)',
    r1.status === 301 && r1.headers.get('location') === 'https://trends.example.com/page/2' &&
    r2.status === 301 && r2.headers.get('location') === 'https://trends.example.com/' &&
    r3.status === 301 && r3.headers.get('location') === 'https://trends.example.com/c/tech/page/2' &&
    r4.status === 301 && r4.headers.get('location') === 'https://trends.example.com/c/tech',
    `statuses=${r1.status},${r2.status},${r3.status},${r4.status}`
  );

  const catPg2Res = await handleFetch(new Request('https://trends.example.com/c/tech/page/2'), uiEnv, ctx);
  const catPg2Html = await catPg2Res.text();
  record(
    'Category pagination serves remaining 2 Tech cards on /c/tech/page/2',
    catPg2Res.status === 200 && (catPg2Html.match(/<article class="c"/g) || []).length === 2,
    `status=${catPg2Res.status}`
  );

  const searchHitRes = await handleFetch(new Request('https://trends.example.com/search?q=Number+14'), uiEnv, ctx);
  const searchHitHtml = await searchHitRes.text();
  const searchMissRes = await handleFetch(new Request('https://trends.example.com/search?q=zzzznone'), uiEnv, ctx);
  const searchMissHtml = await searchMissRes.text();
  record(
    'Search returns ranked results, noindex header, back bar & zero-result suggestions',
    searchHitRes.status === 200 &&
    (searchHitRes.headers.get('x-robots-tag') || '').includes('noindex') &&
    searchHitHtml.includes('topic-14') &&
    searchHitHtml.includes('data-bk="1"') &&
    (searchHitRes.headers.get('content-security-policy') || '').includes("form-action 'self'") &&
    searchMissRes.status === 200 &&
    searchMissHtml.includes('Try searching one of today'),
    `hit=${searchHitRes.status}, miss=${searchMissRes.status}`
  );

  const ogRes = await handleFetch(new Request('https://trends.example.com/og.png'), uiEnv, ctx);
  const ogBytes = new Uint8Array(await ogRes.arrayBuffer());
  const ogPostRes = await handleFetch(new Request('https://trends.example.com/og/topic-14.png'), uiEnv, ctx);
  const favRes = await handleFetch(new Request('https://trends.example.com/favicon.svg'), uiEnv, ctx);
  const logoRes = await handleFetch(new Request('https://trends.example.com/logo.png'), uiEnv, ctx);
  const logoBytes = new Uint8Array(await logoRes.arrayBuffer());
  const touchRes = await handleFetch(new Request('https://trends.example.com/apple-touch-icon.png'), uiEnv, ctx);
  record(
    'OG PNG (/og.png, /og/:slug.png), brand /logo.png & /favicon.svg serve valid assets',
    ogRes.status === 200 && ogRes.headers.get('content-type') === 'image/png' &&
    ogBytes[0] === 137 && ogBytes[1] === 80 && ogBytes[2] === 78 && ogBytes[3] === 71 &&
    logoRes.status === 200 && logoRes.headers.get('content-type') === 'image/png' &&
    logoBytes[0] === 137 && logoBytes[1] === 80 && logoBytes[2] === 78 && logoBytes[3] === 71 &&
    touchRes.status === 200 && touchRes.headers.get('content-type') === 'image/png' &&
    ogPostRes.status === 200 && ogPostRes.headers.get('content-type') === 'image/png' &&
    favRes.status === 200 && (favRes.headers.get('content-type') || '').includes('svg'),
    `og=${ogBytes.length}B, logo=${logoBytes.length}B, postOg=${ogPostRes.status}, fav=${favRes.status}`
  );

  // Case 6: First-party indexable images (/i/:slug.jpg), uniform 16:9 cards, SwG snippet & CSP
  const rssParsed = parseTrendsRSS(
    `<rss xmlns:ht="https://trends.google.com/trending/rss"><channel><item><title>Sample Photo Story</title><ht:approx_traffic>50,000+</ht:approx_traffic><ht:picture>https://encrypted-tbn0.gstatic.com/images?q=tbn:TESTPIC</ht:picture><ht:picture_source>AP News</ht:picture_source></item></channel></rss>`
  );
  uiDb.sqlite.prepare('UPDATE topics SET image_url = ?, image_source = ? WHERE slug = ?').run(
    'https://encrypted-tbn0.gstatic.com/images?q=tbn:TESTPIC', 'AP News', 'topic-15'
  );
  uiDb.sqlite.prepare('UPDATE topics SET image_url = ? WHERE slug = ?').run('', 'topic-13');
  const imgHomeRes = await handleFetch(new Request('https://trends.example.com/'), uiEnv, ctx);
  const imgHomeHtml = await imgHomeRes.text();
  const imgTags = imgHomeHtml.match(/<img\b[^>]*>/g) || [];
  const imgPostRes = await handleFetch(new Request('https://trends.example.com/p/topic-15'), uiEnv, ctx);
  const imgPostHtml = await imgPostRes.text();
  const imgProxyRes = await handleFetch(new Request('https://trends.example.com/i/topic-13.jpg'), uiEnv, ctx);
  const imgProxyMissing = await handleFetch(new Request('https://trends.example.com/i/does-not-exist.jpg'), uiEnv, ctx);
  const cspHeader = imgPostRes.headers.get('content-security-policy') || '';
  record(
    'First-party indexable /i/:slug.jpg images, uniform 10/10 16:9 cards & SwG CAowzZvEDA:openaccess',
    rssParsed.length === 1 && rssParsed[0].imageUrl.includes('TESTPIC') && rssParsed[0].imageSource === 'AP News' &&
    imgTags.length === 10 && imgTags.every(t => t.includes('src="/i/') && t.includes('width="320" height="180"')) &&
    !imgTags[0].includes('loading="lazy"') && imgTags[1].includes('loading="lazy"') &&
    imgProxyRes.status === 200 && (imgProxyRes.headers.get('content-type') || '').startsWith('image/') &&
    imgProxyMissing.status === 404 &&
    imgPostHtml.includes('Image: AP News') &&
    imgPostHtml.includes('https://news.google.com/swg/js/v1/swg-basic.js') &&
    imgPostHtml.includes('CAowzZvEDA:openaccess') &&
    cspHeader.includes('https://news.google.com') &&
    !imgHomeHtml.includes('body,.b,.sum,.bt,input{') === false,
    `imgs=${imgTags.length}, proxy=${imgProxyRes.status}, missing=${imgProxyMissing.status}`
  );

  // Case 7: GEO, AI Search Crawlers, llms.txt, first-party <image:image> sitemap, rich RSS & NewsMediaOrganization schema
  const robotsText = await (await handleFetch(new Request('https://trends.example.com/robots.txt'), uiEnv, ctx)).text();
  const llmsRes = await handleFetch(new Request('https://trends.example.com/llms.txt'), uiEnv, ctx);
  const llmsText = await llmsRes.text();
  const uiSitemap = await (await handleFetch(new Request('https://trends.example.com/sitemap.xml'), uiEnv, ctx)).text();
  const uiRss = await (await handleFetch(new Request('https://trends.example.com/rss.xml'), uiEnv, ctx)).text();
  const wwwHttps = await handleFetch(new Request('https://www.trends.example.com/p/topic-15?ref=1'), uiEnv, ctx);
  const wwwHttp = await handleFetch(new Request('http://www.trends.example.com/robots.txt'), uiEnv, ctx);
  record(
    'robots.txt AI bots, /llms.txt, own-domain /i/*.jpg sitemap/RSS, NewsMediaOrganization & www->apex 301',
    robotsText.includes('Googlebot-Image') && robotsText.includes('OAI-SearchBot') &&
    robotsText.includes('Claude-SearchBot') && robotsText.includes('PerplexityBot') &&
    llmsRes.status === 200 && llmsText.includes('# Trending Now') && llmsText.includes('/p/topic-15') &&
    uiSitemap.includes('xmlns:image=') && uiSitemap.includes('<image:loc>https://trends.example.com/i/topic-15.jpg</image:loc>') &&
    uiRss.includes('<content:encoded>') && uiRss.includes('https://trends.example.com/i/topic-15.jpg') &&
    imgPostHtml.includes('NewsMediaOrganization') &&
    imgPostHtml.includes('/logo.png') &&
    imgPostHtml.includes('viewBox="0 0 100 100"') &&
    imgHomeHtml.includes('<a class="b f" href="/">') &&
    imgPostHtml.includes('<section id="facts">') && imgPostHtml.includes('<section id="sources">') &&
    imgPostHtml.includes('<div class="r g">') && imgHomeHtml.includes('grid-template-columns:5fr 7fr') &&
    cspHeader.includes("object-src 'none'") &&
    wwwHttps.status === 301 && wwwHttps.headers.get('location') === 'https://trends.example.com/p/topic-15?ref=1' &&
    wwwHttp.status === 301 && wwwHttp.headers.get('location') === 'https://trends.example.com/robots.txt' &&
    Boolean(wwwHttps.headers.get('strict-transport-security')),
    `llms=${llmsRes.status}, www301=${wwwHttps.status}/${wwwHttp.status}`
  );

  // Case 8: D1 free-tier write cap (stops updating after 5 hits / extended=1) & Discover 1200px image + Title Case H2
  uiDb.sqlite.prepare("UPDATE topics SET topic = 'shein', title = 'Shein Consumer Settlement' WHERE slug = 'topic-15'").run();
  for (let i = 0; i < 8; i++) {
    await handleFetch(new Request('https://trends.example.com/p/topic-15', {
      method: 'GET',
      headers: { Referer: 'https://www.google.com/', 'User-Agent': 'Mozilla/5.0 Chrome/131.0' },
    }), uiEnv, ctx);
  }
  await ctx.flush();
  const cappedHits = uiDb.sqlite.prepare("SELECT search_hits FROM topics WHERE slug = 'topic-15'").get().search_hits;
  const sheinHtml = await (await handleFetch(new Request('https://trends.example.com/p/topic-15'), uiEnv, ctx)).text();
  record(
    'D1 hit writes cap at 5/post for free tier, H2 topic title-cased & Discover 1200px image first',
    cappedHits === 5 &&
    sheinHtml.includes('<h2>Why Shein Is Trending</h2>') &&
    sheinHtml.includes('"width":1200,"height":630'),
    `cappedHits=${cappedHits}`
  );

  // Case 9: Render-time inline [Outlet] stripping, Silo clustering, rel=prev/next, category pillar intro & LCP fetchpriority
  uiDb.sqlite.prepare(
    `UPDATE topics SET summary = ?, what_happened = ?, key_facts = ?, also_searched = ?, sources = ? WHERE slug = 'topic-12'`
  ).run(
    'Tropical weather systems expanded inland [News24].',
    'According to Bendigo Advertiser, heavy rain hit central areas.',
    JSON.stringify([
      'The Bureau of Meteorology issued a severe weather update on Thursday, November 26, 2026 [The Bureau of Meteorology]',
      'Tropical moisture is fueling wild conditions across parts of central Australia [News24]',
      'Another storm is forecast to hit, bringing more heavy rain to the region [Bendigo Advertiser]',
    ]),
    JSON.stringify(['central australia storm', 'storm forecast']),
    'The Bureau of Meteorology, Bendigo Advertiser, News24'
  );
  const pg1SiloHtml = await (await handleFetch(new Request('https://trends.example.com/'), uiEnv, ctx)).text();
  const pg2SiloHtml = await (await handleFetch(new Request('https://trends.example.com/page/2'), uiEnv, ctx)).text();
  const techHubHtml = await (await handleFetch(new Request('https://trends.example.com/c/tech'), uiEnv, ctx)).text();
  const cleanPostHtml = await (await handleFetch(new Request('https://trends.example.com/p/topic-12'), uiEnv, ctx)).text();
  record(
    'Clean content without inline [Outlet] tags, Tech Silo clustering, rel=prev/next & LCP fetchpriority=high',
    !cleanPostHtml.includes('[News24]') &&
    !cleanPostHtml.includes('[Bendigo Advertiser]') &&
    !cleanPostHtml.includes('[The Bureau of Meteorology]') &&
    !cleanPostHtml.includes('According to Bendigo Advertiser') &&
    cleanPostHtml.includes('Sources:</strong> The Bureau of Meteorology, Bendigo Advertiser, News24') &&
    cleanPostHtml.includes('fetchpriority="high"') &&
    cleanPostHtml.includes('More in Tech') &&
    cleanPostHtml.includes('rel="nofollow"') &&
    pg1SiloHtml.includes('<link rel="next" href="https://trends.example.com/page/2">') &&
    pg1SiloHtml.includes('fetchpriority="high"') &&
    pg2SiloHtml.includes('<link rel="prev" href="https://trends.example.com/">') &&
    techHubHtml.includes('Live tech coverage hub tracking verified updates') &&
    techHubHtml.includes('/c/tech/rss.xml') &&
    cleanPostHtml.includes('og:image:alt'),
    'verified'
  );

  // Case 9b: Per-category RSS feed (/c/:cat/rss.xml) + isBasedOn JSON-LD
  uiDb.sqlite.prepare("UPDATE topics SET source_urls = ? WHERE slug = 'topic-15'").run(
    JSON.stringify([{ name: 'BBC', url: 'https://example.com/bbc', title: 'Story' }])
  );
  const sheinSrcHtml = await (await handleFetch(new Request('https://trends.example.com/p/topic-15'), uiEnv, ctx)).text();
  const catRssRes = await handleFetch(new Request('https://trends.example.com/c/tech/rss.xml'), uiEnv, ctx);
  const catRssXml = await catRssRes.text();
  record(
    'Category RSS (/c/tech/rss.xml) & NewsArticle isBasedOn JSON-LD',
    catRssRes.status === 200 &&
    (catRssRes.headers.get('content-type') || '').includes('xml') &&
    catRssXml.includes('<title>Trending Now — Tech</title>') &&
    catRssXml.includes('/c/tech/rss.xml') &&
    catRssXml.includes('/p/topic-12') &&
    !catRssXml.includes('/p/topic-15') &&
    sheinSrcHtml.includes('"isBasedOn":["https://example.com/bbc"]'),
    `status=${catRssRes.status}`
  );

  // Case 10: Webhook free-tier pacing (allows first post, blocks within 90m gap, allows after 90m)
  const whEnv = { SOCIAL_WEBHOOK_URL: 'https://hook.example.com/test', WEBHOOK_MIN_GAP_MINS: '90' };
  const wh1 = await canSendWebhookNow(uiDb, whEnv, nowMs);
  await uiDb.prepare("INSERT OR REPLACE INTO social_state (k, v) VALUES ('webhook_last_at', ?)").bind(new Date(nowMs).toISOString()).run();
  const wh2 = await canSendWebhookNow(uiDb, whEnv, nowMs + 30 * 60_000);
  const wh3 = await canSendWebhookNow(uiDb, whEnv, nowMs + 95 * 60_000);
  record('Webhook free-tier pacing blocks bursts <90m and allows after 90m', wh1 && !wh2 && wh3, `w1=${wh1}, w2=${wh2}, w3=${wh3}`);

  // Case 11: 24-hour even publishing allowance (spacing 6m, hourly cap 9, daily cap)
  const paceDb = createD1Shim('schema.sql');
  const paceSettings = getSettings({ MAX_DAILY: '200', MAX_HOURLY: '9', PUBLISH_GAP_MINS: '6' });
  const baseHourMs = Date.UTC(2026, 10, 27, 10, 0, 0);
  for (let i = 0; i < 8; i++) {
    const tIso = new Date(baseHourMs + i * 6 * 60_000).toISOString();
    insertPost(paceDb, { slug: `pace-${i}`, title: `Pace Story ${i}`, createdAt: tIso, expiresAt: new Date(baseHourMs + 48 * 3600_000).toISOString() });
  }
  const pTooSoon = await getPublishAllowance(paceDb, paceSettings, baseHourMs + 45 * 60_000); // 3m after last post
  const pAllowed9th = await getPublishAllowance(paceDb, paceSettings, baseHourMs + 49 * 60_000); // 7m after 8th post
  insertPost(paceDb, { slug: 'pace-8', title: 'Pace Story 8', createdAt: new Date(baseHourMs + 49 * 60_000).toISOString(), expiresAt: new Date(baseHourMs + 48 * 3600_000).toISOString() });
  const pHourFull = await getPublishAllowance(paceDb, paceSettings, baseHourMs + 57 * 60_000); // 9th done -> hour full
  const pNextHour = await getPublishAllowance(paceDb, paceSettings, baseHourMs + 65 * 60_000); // next hour 11:05 -> open
  record(
    '24h pacing blocks <6m bursts & 9/hr hourly saturation, opens next hour',
    !pTooSoon.canPublish && pTooSoon.reason === 'spacing' &&
    pAllowed9th.canPublish &&
    !pHourFull.canPublish && pHourFull.reason === 'hourly_cap' &&
    pNextHour.canPublish,
    `soon=${pTooSoon.reason}, ok9=${pAllowed9th.canPublish}, full=${pHourFull.reason}, nextHr=${pNextHour.canPublish}`
  );

  // Case 12: Permanent Pillar Guides (/guides, /guides/:slug, /img/guides/:slug.jpg, static assets & bidirectional Hub-and-Spoke links)
  const guidesIdxRes = await handleFetch(new Request('https://trends.example.com/guides'), uiEnv, ctx);
  const guidesIdxHtml = await guidesIdxRes.text();
  const pillarRes = await handleFetch(new Request('https://trends.example.com/guides/sports-injury-reports-explained'), uiEnv, ctx);
  const pillarHtml = await pillarRes.text();
  const pillarMissingRes = await handleFetch(new Request('https://trends.example.com/guides/nonexistent-guide'), uiEnv, ctx);
  const pillarImgRes = await handleFetch(new Request('https://trends.example.com/img/guides/sports-injury-reports-explained.jpg'), uiEnv, ctx);
  const sportsHubHtml = await (await handleFetch(new Request('https://trends.example.com/c/sports'), uiEnv, ctx)).text();
  const sportsSpokeHtml = await (await handleFetch(new Request('https://trends.example.com/p/topic-14'), uiEnv, ctx)).text();
  const guidesSitemap = await (await handleFetch(new Request('https://trends.example.com/sitemap.xml'), uiEnv, ctx)).text();
  const guidesLlms = await (await handleFetch(new Request('https://trends.example.com/llms.txt'), uiEnv, ctx)).text();
  const metaGateOk = PILLAR_GUIDES.length >= 6 && PILLAR_GUIDES.every(g =>
    g.title.length >= 30 && g.title.length <= 60 &&
    g.metaDesc.length >= 120 && g.metaDesc.length <= 158 &&
    fs.existsSync(`public${g.image}`) && fs.statSync(`public${g.image}`).size > 10_000
  );
  record(
    'Permanent Pillar Guides: /guides, /guides/:slug, /img/guides/*.jpg assets, sitemap & Hub-Spoke links',
    metaGateOk &&
    guidesIdxRes.status === 200 &&
    guidesIdxHtml.includes('/guides/sports-injury-reports-explained') &&
    guidesIdxHtml.includes('/guides/gold-silver-vs-crypto-market-drivers') &&
    pillarRes.status === 200 &&
    pillarHtml.includes('FAQPage') &&
    pillarHtml.includes('ItemList') &&
    pillarHtml.includes('<table') &&
    pillarHtml.includes('/p/topic-14') &&
    pillarHtml.includes('og:image:width" content="1200"') &&
    pillarHtml.includes('og:image:height" content="675"') &&
    pillarMissingRes.status === 404 &&
    pillarImgRes.status === 200 &&
    sportsHubHtml.includes('/guides/sports-injury-reports-explained') &&
    sportsSpokeHtml.includes('/guides/sports-injury-reports-explained') &&
    guidesSitemap.includes('<loc>https://trends.example.com/guides/sports-injury-reports-explained</loc>') &&
    guidesSitemap.includes('<priority>0.95</priority>') &&
    guidesLlms.includes('## Permanent Pillar Guides'),
    `guides=${PILLAR_GUIDES.length}, img=${pillarImgRes.status}, miss=${pillarMissingRes.status}`
  );

  const failed = results.filter(r => !r.ok).length;
  console.log(`\nTotal failures: ${failed}`);
  process.exit(failed ? 1 : 0);
}

run();
