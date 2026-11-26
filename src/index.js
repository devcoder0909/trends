/**
 * Ephemeral Trend Site — Worker Entry Point
 * Cloudflare Workers + D1 + Workers AI (Gemini fallback)
 *
 * - Fetches Google Trends RSS + Google News RSS every minute via cron
 * - Grounds every post in >= 2 distinct news outlets, validates & fact-checks
 * - Tiered lifetime: 48h base, extended to 7 days on search-engine human traffic
 * - Auto-deletes expired content, returns 410 Gone, pings IndexNow
 * - Zero client JS, inline CSS (<1.5KB), no images, no analytics
 */

import { getSettings, isSensitive, normalizeHost } from './config.js';
import { parseTrendsRSS, fetchGoogleNews, mergeSources, rankTopics } from './rss.js';
import { generateAndValidatePost, buildUpdateFromFreshSources } from './content.js';
import { shouldCountSearchHit, recordSearchHit, processExpirationsAndExtensions } from './lifetime.js';
import { slugify, homePage, postPage, aboutPage, gonePage, endedPage } from './render.js';
import { sitemapXml, newsSitemapXml, robotsTxt, rssFeed, pingIndexNow } from './seo.js';

const isoNow = () => new Date().toISOString();
const todayStr = () => isoNow().slice(0, 10);

const htmlRes = (body, status = 200, extra = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html;charset=utf-8', ...extra } });
const textRes = (body, status = 200) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain;charset=utf-8' } });
const xmlRes = body =>
  new Response(body, { headers: { 'Content-Type': 'application/xml;charset=utf-8' } });

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
 * Append a short factual "Update" line for live posts (including extended posts)
 * when fresh headlines appear, update dateModified, and ping IndexNow once.
 */
async function updateLiveTopics(db, env, settings, siteUrl, nowIso) {
  if (settings.devMode) return;
  const checkCutoff = new Date(Date.now() - 30 * 60_000).toISOString();
  const candidates = (await db.prepare(
    "SELECT id, slug, topic, source_urls, updates_json, update_pinged FROM topics WHERE status = 'published' AND expires_at > ? AND (last_checked_at IS NULL OR last_checked_at < ?) ORDER BY COALESCE(last_checked_at, '') ASC LIMIT 5"
  ).bind(nowIso, checkCutoff).all()).results || [];

  const updatedUrls = [];
  for (const post of candidates) {
    const fresh = await fetchGoogleNews(post.topic);
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
  if (extendedSlugs.length) {
    await pingIndexNow(env, extendedSlugs.map(s => `${siteUrl}/p/${s}`));
  }
  if (deletedSlugs.length) {
    await pingIndexNow(env, deletedSlugs.map(s => `${siteUrl}/p/${s}`));
  }

  // Clean up stale dedup memory, timed-out held topics, and stale queue entries
  const seenCutoff = new Date(Date.now() - settings.seenTtlDays * 86400_000).toISOString();
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
    db.prepare('DELETE FROM seen_topics WHERE seen_at < ?').bind(seenCutoff),
    db.prepare('DELETE FROM pending_topics WHERE first_seen_at < ?').bind(holdCutoff),
    db.prepare("DELETE FROM topics WHERE status = 'queued' AND created_at < ?").bind(queueCutoff),
  ]);

  // Kill switch: stop fetching new topics after SITE_END_AT; live posts remain until their own expires_at
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

  // Include held pending topics for retry
  const pendingRows = (await db.prepare('SELECT * FROM pending_topics').all()).results || [];
  const pendingMap = new Map(pendingRows.map(r => [r.topic_hash, r]));
  for (const p of pendingRows) {
    if (!rawCandidates.some(c => slugify(c.title) === p.topic_hash)) {
      let trendsItems = [];
      try { trendsItems = JSON.parse(p.source_json || '[]'); } catch {}
      rawCandidates.push({ title: p.topic, approxTraffic: p.approx_traffic, newsItems: trendsItems, geo: p.geo });
    }
  }

  // Rank candidates by approx_traffic, source count, and informational category
  const ranked = rankTopics(rawCandidates);

  // Track existing live titles to prevent duplicates
  const liveTitles = new Set(
    ((await db.prepare("SELECT title FROM topics WHERE status = 'published' AND expires_at > ?").bind(now).all()).results || [])
      .map(r => r.title.toLowerCase())
  );

  const newUrls = [];
  let gnewsLookups = 0;

  for (const item of ranked) {
    const hash = slugify(item.title);
    if (!hash) continue;

    // Skip already processed topics
    if (await db.prepare('SELECT 1 FROM seen_topics WHERE topic_hash = ?').bind(hash).first()) continue;

    // Early sensitive filter before external fetch
    const earlyText = [item.title, ...(item.newsItems || []).map(n => `${n.title} ${n.snippet}`)].join(' ');
    if (isSensitive(earlyText)) {
      await logRejected(db, hash, item.title, item.geo, 'sensitive', 'Matched blocklist in Trends RSS');
      await markSeen(db, hash, hash, now);
      await db.prepare('DELETE FROM pending_topics WHERE topic_hash = ?').bind(hash).run();
      continue;
    }

    // Cap Google News RSS subrequests per cron run (stays well under 50 subrequest limit)
    if (gnewsLookups >= 12) break;
    gnewsLookups++;

    const googleNewsItems = settings.devMode
      ? (MOCK_GOOGLE_NEWS[hash] || [])
      : await fetchGoogleNews(item.title);

    const merged = mergeSources(item.newsItems, googleNewsItems);

    // Hold for up to 30 min if fewer than 2 distinct outlets
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

    // Run writer + quality gate + fact-check verifier (max 2 retries)
    const result = await generateAndValidatePost(
      env,
      { topic: item.title, sources: merged.items },
      liveTitles
    );

    if (!result.ok) {
      await logRejected(db, hash, item.title, item.geo, result.code, result.reason);
      await markSeen(db, hash, hash, now);
      await db.prepare('DELETE FROM pending_topics WHERE topic_hash = ?').bind(hash).run();
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
      if (status === 'published') {
        newUrls.push(`${siteUrl}/p/${hash}`);
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
  const siteUrl = `https://${normalizeHost(env.SITE_HOST) || url.host}`;
  const path = url.pathname;
  const db = env.DB;
  const now = isoNow();
  const nowMs = Date.parse(now);

  // Keep IndexNow key verifiable even after SITE_END_AT
  if (path === `/${env.INDEXNOW_KEY || '_'}.txt`) return textRes(env.INDEXNOW_KEY || '');

  const isSiteEnded = Boolean(env.SITE_END_AT && nowMs > Date.parse(env.SITE_END_AT));
  if (isSiteEnded) {
    const liveCount = (await db.prepare(
      "SELECT COUNT(*) as c FROM topics WHERE status = 'published' AND expires_at > ?"
    ).bind(now).first())?.c || 0;
    if (liveCount === 0) {
      return htmlRes(endedPage(), 410);
    }
  }

  if (path === '/robots.txt') return textRes(robotsTxt(siteUrl));
  if (path === '/about') return htmlRes(aboutPage(settings, siteUrl));

  const live = async () => (await db.prepare(
    "SELECT * FROM topics WHERE status = 'published' AND expires_at > ? ORDER BY created_at DESC"
  ).bind(now).all()).results || [];

  if (path === '/sitemap.xml') return xmlRes(sitemapXml(await live(), siteUrl));
  if (path === '/news-sitemap.xml') return xmlRes(newsSitemapXml(await live(), siteUrl, settings.siteName, nowMs));
  if (path === '/rss.xml') return xmlRes(rssFeed(await live(), siteUrl, settings.siteName));

  // Home page — all live posts in full, cached 60s at edge
  if (path === '/') {
    if (shouldCountSearchHit(request) && ctx?.waitUntil) {
      ctx.waitUntil(recordSearchHit(db, null, now));
    }
    return htmlRes(homePage(await live(), settings, siteUrl, nowMs), 200, {
      'Cache-Control': 'public, s-maxage=60, max-age=30',
    });
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

      return htmlRes(postPage(post, related, allLive, settings, siteUrl, nowMs), 200, {
        'Cache-Control': 'public, s-maxage=60, max-age=30',
      });
    }

    const wasSeen = await db.prepare('SELECT 1 FROM seen_topics WHERE slug = ?').bind(slug).first();
    return htmlRes(gonePage(), (wasSeen || isSiteEnded) ? 410 : 404);
  }

  return new Response('Not Found', { status: 404 });
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
