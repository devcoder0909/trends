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
import { handleFetch, handleScheduled } from '../src/index.js';
import { processExpirationsAndExtensions } from '../src/lifetime.js';
import { getSettings } from '../src/config.js';

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
    extRow.extended === 1 && extHoursLeft >= 118 && extRes.status === 200 && cycle.extendedSlugs.includes('google-hit-post') && extHtml.includes('Expires in'),
    `extended=${extRow.extended}, hoursLeft=${extHoursLeft}, status=${extRes.status}`
  );

  // Sitemaps & category hub check: extended >48h old post MUST be in sitemap.xml and /c/tech, NOT in news-sitemap.xml
  const smXml = await (await handleFetch(new Request('https://trends.example.com/sitemap.xml'), env, ctx)).text();
  const nsmXml = await (await handleFetch(new Request('https://trends.example.com/news-sitemap.xml'), env, ctx)).text();
  const catRes = await handleFetch(new Request('https://trends.example.com/c/tech'), env, ctx);
  const catHtml = await catRes.text();
  record(
    'Sitemap keeps extended post & /c/tech hub; news-sitemap limits to 48h',
    smXml.includes('/p/google-hit-post') && smXml.includes('/c/tech') && !nsmXml.includes('/p/google-hit-post') && catRes.status === 200 && catHtml.includes('google-hit-post'),
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

  const failed = results.filter(r => !r.ok).length;
  console.log(`\nTotal failures: ${failed}`);
  process.exit(failed ? 1 : 0);
}

run();
