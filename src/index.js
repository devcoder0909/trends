/**
 * Ephemeral Trend Site — Worker Entry Point
 * Cloudflare Workers + D1 + Workers AI (Gemini fallback)
 *
 * - Fetches Google Trends RSS + Google News RSS every minute via cron
 * - Grounds every post in >= 2 distinct news outlets, validates & fact-checks
 * - Tiered lifetime: 48h base, extended to 7 days on search-engine human traffic
 * - Full 7-day cleanup across topics, seen_topics, and rejected tables
 * - Programmatic SEO: BreadcrumbList, NewsArticle, ItemList, category hubs, IndexNow
 */

import { getSettings, isSensitive, normalizeHost, PREFERRED_CATEGORIES } from './config.js';
import { parseTrendsRSS, fetchGoogleNews, mergeSources, rankTopics } from './rss.js';
import { generateAndValidatePost, buildUpdateFromFreshSources } from './content.js';
import { shouldCountSearchHit, recordSearchHit, processExpirationsAndExtensions } from './lifetime.js';
import { slugify, homePage, categoryPage, postPage, aboutPage, gonePage, endedPage } from './render.js';
import { sitemapXml, newsSitemapXml, robotsTxt, rssFeed, pingIndexNow } from './seo.js';

const MAX_TOPICS_PER_TICK = 4; // stays well below Cloudflare's 50 subrequest limit

const isoNow = () => new Date().toISOString();
const todayStr = () => isoNow().slice(0, 10);

const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

const SEO_INDEX_HEADERS = {
  ...SECURITY_HEADERS,
  'Cache-Control': 'public, s-maxage=60, max-age=30, stale-while-revalidate=300',
  'X-Robots-Tag': 'index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1',
};

const htmlRes = (body, status = 200, extra = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html;charset=utf-8', ...SECURITY_HEADERS, ...extra } });
const textRes = (body, status = 200) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain;charset=utf-8', ...SECURITY_HEADERS } });
const xmlRes = body =>
  new Response(body, { headers: { 'Content-Type': 'application/xml;charset=utf-8', 'Cache-Control': 'public, s-maxage=60, max-age=30', ...SECURITY_HEADERS } });

async function logRejected(db, hash, topic, geo, reason, details = '') {
  await db.prepare(
    'INSERT INTO rejected (topic_hash, topic, geo, reason, details, rejected_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(hash, topic, geo, reason, String(details).slice(0, 500), isoNow()).run();
}

async function markSeen(db, hash, slug, nowIso) {
  await db.prepare(
    'INSERT OR IGNORE INTO seen_topics (topic_hash, slug, seen_at) VALUES (?, ?, ?)'
  ).bind(hash, slug, nowIso).run();
}

/**
 * Prevent near-duplicate posts (e.g. "nba games" vs "nba games today").
 */
export function isNearDuplicateTopic(candidateTopic, liveTopics = []) {
  const tokenize = s =>
    String(s || '')
      .toLowerCase()
      .replace(/['’]/g, '')
      .split(/[^a-z0-9]+/)
      .filter(w => w.length > 2 && !['the', 'and', 'for', 'with', 'what', 'why', 'how', 'today', 'latest', 'news'].includes(w));

  const candWords = tokenize(candidateTopic);
  if (!candWords.length) return false;

  for (const row of liveTopics) {
    const existingWords = new Set(tokenize(row.topic || row.title));
    if (!existingWords.size) continue;
    const overlap = candWords.filter(w => existingWords.has(w)).length;
    const ratio = overlap / Math.min(candWords.length, existingWords.size);
    if (overlap >= 2 && ratio >= 0.75) return true;
    if (candWords.length === 1 && existingWords.size === 1 && overlap === 1) return true;
  }
  return false;
}

/**
 * Append a short factual "Update" line for live posts (including extended posts)
 * when fresh headlines appear, update dateModified, and ping IndexNow once.
 */
async function updateLiveTopics(db, env, settings, siteUrl, nowIso) {
  if (settings.devMode) return;
  const checkCutoff = new Date(Date.now() - 30 * 60_000).toISOString();
  const candidates = (await db.prepare(
    "SELECT id, slug, topic, geo, source_urls, updates_json, update_pinged FROM topics WHERE status = 'published' AND expires_at > ? AND (last_checked_at IS NULL OR last_checked_at < ?) ORDER BY COALESCE(last_checked_at, '') ASC LIMIT 2"
  ).bind(nowIso, checkCutoff).all()).results || [];

  const updatedUrls = [];
  for (const post of candidates) {
    const fresh = await fetchGoogleNews(post.topic, post.geo || 'US');
    let existingUrls = [];
    let existingUpdates = [];
    try { existingUrls = JSON.parse(post.source_urls || '[]'); } catch {}
    try { existingUpdates = JSON.parse(post.updates_json || '[]'); } catch {}

    const res = buildUpdateFromFreshSources(existingUrls, fresh, nowIso);
    if (res.updated) {
      const nextUpdates = [...existingUpdates, res.updateEntry].slice(-5);
      const nextSourcesStr = [...new Set(res.mergedSources.map(s => s.name))].join(', ');
      await db.prepare(
        'UPDATE topics SET updates_json = ?, source_urls = ?, sources = ?, updated_at = ?, last_checked_at = ?, update_pinged = 1 WHERE id = ?'
      ).bind(
        JSON.stringify(nextUpdates),
        JSON.stringify(res.mergedSources),
        nextSourcesStr,
        nowIso,
        nowIso,
        post.id
      ).run();
      if (!post.update_pinged) updatedUrls.push(`${siteUrl}/p/${post.slug}`);
    } else {
      await db.prepare('UPDATE topics SET last_checked_at = ? WHERE id = ?').bind(nowIso, post.id).run();
    }
  }

  if (updatedUrls.length) await pingIndexNow(env, updatedUrls);
}

// ══════════════════════════════════════════════════════════════
//  CRON HANDLER — runs every minute
// ══════════════════════════════════════════════════════════════

export async function handleScheduled(env) {
  const settings = getSettings(env);
  const db = env.DB;
  const now = isoNow();
  const siteUrl = `https://${settings.siteHost}`;
  const isSiteEnded = Boolean(env.SITE_END_AT && new Date() > new Date(env.SITE_END_AT));

  // 1. Evaluate tiered extensions BEFORE deleting expired posts
  const { extendedSlugs, deletedSlugs } = await processExpirationsAndExtensions(db, now, settings);
  if (extendedSlugs.length) await pingIndexNow(env, extendedSlugs.map(s => `${siteUrl}/p/${s}`));
  if (deletedSlugs.length) await pingIndexNow(env, deletedSlugs.map(s => `${siteUrl}/p/${s}`));

  // Full 7-day cleanup across dedup, timed-out holds, stale queue, and rejected log
  const sevenDaysAgo = new Date(Date.now() - settings.seenTtlDays * 86400_000).toISOString();
  const holdCutoff = new Date(Date.now() - settings.holdMaxMinutes * 60_000).toISOString();
  const queueCutoff = new Date(Date.now() - 12 * 3600_000).toISOString();

  const expiredHolds = (await db.prepare(
    'SELECT topic_hash, topic, geo FROM pending_topics WHERE first_seen_at < ?'
  ).bind(holdCutoff).all()).results || [];
  for (const h of expiredHolds) {
    await logRejected(db, h.topic_hash, h.topic, h.geo, 'single_source_timeout', 'Held 30m without 2 distinct outlets');
    await markSeen(db, h.topic_hash, h.topic_hash, now);
  }

  await db.batch([
    db.prepare('DELETE FROM seen_topics WHERE seen_at < ?').bind(sevenDaysAgo),
    db.prepare('DELETE FROM rejected WHERE rejected_at < ?').bind(sevenDaysAgo),
    db.prepare('DELETE FROM pending_topics WHERE first_seen_at < ?').bind(holdCutoff),
    db.prepare("DELETE FROM topics WHERE status = 'queued' AND created_at < ?").bind(queueCutoff),
  ]);

  if (isSiteEnded) return;

  // 2. Check existing live posts (including extended posts) for new headlines
  await updateLiveTopics(db, env, settings, siteUrl, now);

  // 3. Count today's published posts & promote queued topics if under daily cap
  let count = (await db.prepare(
    "SELECT COUNT(*) as c FROM topics WHERE status = 'published' AND created_at LIKE ?"
  ).bind(todayStr() + '%').first())?.c || 0;

  if (count < settings.maxDaily) {
    const queued = (await db.prepare(
      "SELECT id, slug FROM topics WHERE status = 'queued' ORDER BY created_at LIMIT ?"
    ).bind(settings.maxDaily - count).all()).results || [];
    const promotedUrls = [];
    for (const q of queued) {
      await db.prepare("UPDATE topics SET status = 'published' WHERE id = ?").bind(q.id).run();
      promotedUrls.push(`${siteUrl}/p/${q.slug}`);
      count++;
    }
    if (promotedUrls.length) await pingIndexNow(env, promotedUrls);
  }

  // 4. Fetch Trends RSS across configured geos and collect new candidates
  const rawCandidates = [];
  for (const geo of settings.geos) {
    let xml = '';
    if (settings.devMode) {
      xml = MOCK_RSS;
    } else {
      try {
        const res = await fetch(`https://trends.google.com/trending/rss?geo=${geo}`, {
          headers: { 'User-Agent': 'TrendBot/1.0' },
        });
        if (!res.ok) continue;
        xml = await res.text();
      } catch {
        continue;
      }
    }
    for (const item of parseTrendsRSS(xml)) {
      rawCandidates.push({ ...item, geo });
    }
  }

  const pendingRows = (await db.prepare('SELECT * FROM pending_topics').all()).results || [];
  const pendingMap = new Map(pendingRows.map(r => [r.topic_hash, r]));
  for (const p of pendingRows) {
    if (!rawCandidates.some(c => slugify(c.title) === p.topic_hash)) {
      let trendsItems = [];
      try { trendsItems = JSON.parse(p.source_json || '[]'); } catch {}
      rawCandidates.push({ title: p.topic, approxTraffic: p.approx_traffic, newsItems: trendsItems, geo: p.geo });
    }
  }

  const ranked = rankTopics(rawCandidates);

  const liveRows = (await db.prepare(
    "SELECT title, topic FROM topics WHERE status = 'published' AND expires_at > ?"
  ).bind(now).all()).results || [];
  const liveTitles = new Set(liveRows.map(r => r.title.toLowerCase()));

  const newUrls = [];
  let processedThisTick = 0;

  for (const item of ranked) {
    const hash = slugify(item.title);
    if (!hash) continue;

    if (await db.prepare('SELECT 1 FROM seen_topics WHERE topic_hash = ?').bind(hash).first()) continue;

    if (isNearDuplicateTopic(item.title, liveRows)) {
      await logRejected(db, hash, item.title, item.geo, 'duplicate_topic', 'Near-duplicate of live post');
      await markSeen(db, hash, hash, now);
      await db.prepare('DELETE FROM pending_topics WHERE topic_hash = ?').bind(hash).run();
      continue;
    }

    const earlyText = [item.title, ...(item.newsItems || []).map(n => `${n.title} ${n.snippet}`)].join(' ');
    if (isSensitive(earlyText)) {
      await logRejected(db, hash, item.title, item.geo, 'sensitive', 'Matched blocklist in Trends RSS');
      await markSeen(db, hash, hash, now);
      await db.prepare('DELETE FROM pending_topics WHERE topic_hash = ?').bind(hash).run();
      continue;
    }

    if (processedThisTick >= MAX_TOPICS_PER_TICK) break;
    processedThisTick++;

    const googleNewsItems = settings.devMode
      ? (MOCK_GOOGLE_NEWS[hash] || [])
      : await fetchGoogleNews(item.title, item.geo || 'US');

    const merged = mergeSources(item.newsItems, googleNewsItems);

    if (merged.distinctOutlets.length < 2) {
      if (!pendingMap.has(hash)) {
        await db.prepare(
          'INSERT OR IGNORE INTO pending_topics (topic_hash, topic, geo, approx_traffic, source_json, first_seen_at, last_tried_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(hash, item.title, item.geo, item.approxTraffic || 0, JSON.stringify(item.newsItems || []), now, now).run();
      } else {
        await db.prepare('UPDATE pending_topics SET last_tried_at = ? WHERE topic_hash = ?').bind(now, hash).run();
      }
      continue;
    }

    // Skip second LLM verifier pass on last topic if near subrequest ceiling to ensure safe execution
    const result = await generateAndValidatePost(
      env,
      { topic: item.title, sources: merged.items },
      liveTitles,
      { skipLlmVerifier: processedThisTick > 2 }
    );

    if (!result.ok) {
      await logRejected(db, hash, item.title, item.geo, result.code, result.reason);
      // Do NOT blacklist on transient infra errors so it retries on the next cron tick
      if (result.code !== 'infra_error') {
        await markSeen(db, hash, hash, now);
        await db.prepare('DELETE FROM pending_topics WHERE topic_hash = ?').bind(hash).run();
      }
      continue;
    }

    const post = result.post;
    const created = isoNow();
    const expires = new Date(Date.now() + settings.baseTtlHours * 3600_000).toISOString();
    const status = count >= settings.maxDaily ? 'queued' : 'published';
    const sourcesCsv = merged.distinctOutlets.join(', ');

    try {
      await db.batch([
        db.prepare(
          `INSERT INTO topics (
            slug, title, body, summary, what_happened, why_trending, key_facts,
            what_to_know_next, also_searched, bullets, sources, source_urls,
            category, topic, geo, status, approx_traffic, created_at, updated_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          hash, post.title, post.what_happened, post.summary, post.what_happened,
          post.why_trending, JSON.stringify(post.key_facts), post.what_to_know_next,
          JSON.stringify(post.also_searched), JSON.stringify(post.key_facts),
          sourcesCsv, JSON.stringify(merged.sourceUrls), post.category,
          item.title, item.geo, status, item.approxTraffic || 0, created, created, expires
        ),
        db.prepare('INSERT OR IGNORE INTO seen_topics (topic_hash, slug, seen_at) VALUES (?, ?, ?)')
          .bind(hash, hash, created),
        db.prepare('DELETE FROM pending_topics WHERE topic_hash = ?').bind(hash),
      ]);

      liveTitles.add(post.title.toLowerCase());
      liveRows.push({ title: post.title, topic: item.title });
      if (status === 'published') {
        newUrls.push(`${siteUrl}/p/${hash}`, `${siteUrl}/c/${slugify(post.category || 'News')}`, `${siteUrl}/`);
        count++;
      }
    } catch { /* duplicate slug — skip gracefully */ }
  }

  if (newUrls.length) await pingIndexNow(env, newUrls);
}

// ══════════════════════════════════════════════════════════════
//  FETCH HANDLER — routes all HTTP requests
// ══════════════════════════════════════════════════════════════

export async function handleFetch(request, env, ctx) {
  const settings = getSettings(env);
  const url = new URL(request.url);

  // Enforce HTTPS redirect on live custom domains
  if (url.protocol === 'http:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    return Response.redirect(`https://${url.host}${url.pathname}${url.search}`, 301);
  }

  const siteUrl = `https://${normalizeHost(env.SITE_HOST) || url.host}`;
  const path = url.pathname;
  const db = env.DB;
  const now = isoNow();
  const nowMs = Date.parse(now);

  if (path === `/${env.INDEXNOW_KEY || '_'}.txt`) return textRes(env.INDEXNOW_KEY || '');
  if (path === '/robots.txt') return textRes(robotsTxt(siteUrl));

  const isSiteEnded = Boolean(env.SITE_END_AT && nowMs > Date.parse(env.SITE_END_AT));
  if (isSiteEnded) {
    const liveCount = (await db.prepare(
      "SELECT COUNT(*) as c FROM topics WHERE status = 'published' AND expires_at > ?"
    ).bind(now).first())?.c || 0;
    if (liveCount === 0) return htmlRes(endedPage(), 410, { 'X-Robots-Tag': 'noindex' });
  }

  // Edge Cache API for GET requests (keeps D1 reads near zero under traffic spikes)
  const edgeCache = typeof caches !== 'undefined' && caches.default ? caches.default : null;
  const isCacheableGet = request.method === 'GET' && !isSiteEnded &&
    (path === '/' || path === '/about' || path === '/sitemap.xml' || path === '/news-sitemap.xml' ||
     path === '/rss.xml' || path.startsWith('/c/') || path.startsWith('/p/'));
  const cacheKey = isCacheableGet ? new Request(`https://${url.host}${path}`, { method: 'GET' }) : null;

  if (edgeCache && cacheKey) {
    const cached = await edgeCache.match(cacheKey);
    if (cached) {
      if ((path === '/' || path.startsWith('/p/')) && shouldCountSearchHit(request) && ctx?.waitUntil) {
        const slug = path === '/' ? null : path.slice(3).replace(/\/+$/, '');
        ctx.waitUntil(recordSearchHit(db, slug, now));
      }
      return cached;
    }
  }

  const cacheAndReturn = res => {
    if (edgeCache && cacheKey && res.status === 200 && ctx?.waitUntil) {
      ctx.waitUntil(edgeCache.put(cacheKey, res.clone()));
    }
    return res;
  };

  if (path === '/about') return cacheAndReturn(htmlRes(aboutPage(settings, siteUrl), 200, SEO_INDEX_HEADERS));

  const live = async () => (await db.prepare(
    "SELECT * FROM topics WHERE status = 'published' AND expires_at > ? ORDER BY created_at DESC"
  ).bind(now).all()).results || [];

  if (path === '/sitemap.xml') return cacheAndReturn(xmlRes(sitemapXml(await live(), siteUrl)));
  if (path === '/news-sitemap.xml') return cacheAndReturn(xmlRes(newsSitemapXml(await live(), siteUrl, settings.siteName, nowMs)));
  if (path === '/rss.xml') return cacheAndReturn(xmlRes(rssFeed(await live(), siteUrl, settings.siteName)));

  // Home page — all live posts in full, cached 60s at edge
  if (path === '/') {
    if (shouldCountSearchHit(request) && ctx?.waitUntil) {
      ctx.waitUntil(recordSearchHit(db, null, now));
    }
    const posts = await live();
    const lastMod = posts[0] ? new Date(posts[0].updated_at || posts[0].created_at).toUTCString() : new Date(nowMs).toUTCString();
    return cacheAndReturn(htmlRes(homePage(posts, settings, siteUrl, nowMs), 200, {
      ...SEO_INDEX_HEADERS,
      'Last-Modified': lastMod,
    }));
  }

  // Category hub pages (/c/{category}) for clean BreadcrumbList & hub-and-spoke SEO
  if (path.startsWith('/c/')) {
    const catSlug = path.slice(3).replace(/\/+$/, '').toLowerCase();
    const knownNames = [...PREFERRED_CATEGORIES, 'News'];
    const catName = knownNames.find(c => slugify(c) === catSlug);
    if (!catName) return new Response('Not Found', { status: 404, headers: SECURITY_HEADERS });

    const allLive = await live();
    const filtered = allLive.filter(p => slugify(p.category || 'News') === catSlug);
    const headers = filtered.length
      ? SEO_INDEX_HEADERS
      : { ...SECURITY_HEADERS, 'Cache-Control': 'public, s-maxage=60, max-age=30', 'X-Robots-Tag': 'noindex, follow' };
    return cacheAndReturn(htmlRes(categoryPage(catName, filtered, settings, siteUrl, nowMs), 200, headers));
  }

  // Individual post page
  if (path.startsWith('/p/')) {
    const slug = path.slice(3).replace(/\/+$/, '');
    const post = await db.prepare(
      "SELECT * FROM topics WHERE slug = ? AND status = 'published' AND expires_at > ?"
    ).bind(slug, now).first();

    if (post) {
      if (shouldCountSearchHit(request) && ctx?.waitUntil) {
        ctx.waitUntil(recordSearchHit(db, slug, now));
      }
      const allLive = await live();
      const others = allLive.filter(p => p.slug !== slug);
      const sameCat = others.filter(p => (p.category || 'News') === (post.category || 'News'));
      const diffCat = others.filter(p => (p.category || 'News') !== (post.category || 'News'));
      const related = [...sameCat, ...diffCat].slice(0, 6);

      return cacheAndReturn(htmlRes(postPage(post, related, allLive, settings, siteUrl, nowMs), 200, {
        ...SEO_INDEX_HEADERS,
        'Last-Modified': new Date(post.updated_at || post.created_at).toUTCString(),
      }));
    }

    const wasSeen = await db.prepare('SELECT 1 FROM seen_topics WHERE slug = ?').bind(slug).first();
    return htmlRes(gonePage(), (wasSeen || isSiteEnded) ? 410 : 404, { 'X-Robots-Tag': 'noindex, follow' });
  }

  return new Response('Not Found', { status: 404, headers: SECURITY_HEADERS });
}

// ══════════════════════════════════════════════════════════════
//  MOCK RSS (used only when DEV_MODE=true)
// ══════════════════════════════════════════════════════════════

const MOCK_RSS = `<?xml version="1.0"?>
<rss xmlns:ht="https://trends.google.com/trends/trendingsearches/daily" version="2.0">
<channel><title>Mock Trends</title>
<item><title>AI Model Launch 2026</title><ht:approx_traffic>200,000+</ht:approx_traffic>
<ht:news_item><ht:news_item_title>Tech Giant Unveils Open Reasoning Model</ht:news_item_title>
<ht:news_item_snippet>The company released benchmarks showing faster code generation and lower API pricing.</ht:news_item_snippet>
<ht:news_item_source>Tech Daily</ht:news_item_source>
<ht:news_item_url>https://example.com/tech-daily-ai</ht:news_item_url></ht:news_item>
<ht:news_item><ht:news_item_title>Developers React to New AI Model Release</ht:news_item_title>
<ht:news_item_snippet>Engineers welcomed lower inference costs and expanded context limits.</ht:news_item_snippet>
<ht:news_item_source>Wire Report</ht:news_item_source>
<ht:news_item_url>https://example.com/wire-ai</ht:news_item_url></ht:news_item></item>
<item><title>Premier League Final</title><ht:approx_traffic>500,000+</ht:approx_traffic>
<ht:news_item><ht:news_item_title>Arsenal Beats Chelsea 2-1 in Thrilling Match</ht:news_item_title>
<ht:news_item_snippet>Two second-half goals secured three points for Arsenal in London.</ht:news_item_snippet>
<ht:news_item_source>Sports Wire</ht:news_item_source>
<ht:news_item_url>https://example.com/sports-wire</ht:news_item_url></ht:news_item></item>
</channel></rss>`;

const MOCK_GOOGLE_NEWS = {
  'premier-league-final': [
    {
      title: 'Arsenal Extends Lead After 2-1 Victory Over Chelsea',
      snippet: 'Manager praised the defense after holding off late pressure.',
      source: 'BBC Sport',
      url: 'https://example.com/bbc-arsenal',
      pubDate: new Date().toUTCString(),
    },
  ],
};

export default {
  fetch: handleFetch,
  scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(env));
  },
};
