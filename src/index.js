/**
 * Ephemeral Trend Site — Worker Entry Point
 * Cloudflare Workers + D1 + Workers AI (Gemini fallback)
 *
 * - Fetches Google Trends RSS + Google News RSS every minute via cron
 * - Grounds every post in >= 2 distinct news outlets, validates & fact-checks
 * - Tiered lifetime: 48h base, extended to 7 days on search-engine human traffic
 * - Full 7-day cleanup across topics, seen_topics, and rejected tables
 * - Programmatic SEO: BreadcrumbList, NewsArticle, ItemList, SearchAction,
 *   paginated hubs, OG PNGs, IndexNow, WebSub, and Google Indexing API v3
 */

import { getSettings, isSensitive, normalizeHost, PREFERRED_CATEGORIES } from './config.js';
import { parseTrendsRSS, fetchGoogleNews, mergeSources, rankTopics, extractHighResSourceImage } from './rss.js';
import { generateAndValidatePost, buildUpdateFromFreshSources } from './content.js';
import { shouldCountSearchHit, recordSearchHit, processExpirationsAndExtensions } from './lifetime.js';
import {
  PER_PAGE, BACK_SCRIPT_HASH, SWG_SCRIPT_HASH, slugify,
  homePage, categoryPage, searchPage, postPage, aboutPage, notFoundPage, gonePage, endedPage,
} from './render.js';
import { sitemapXml, newsSitemapXml, robotsTxt, llmsTxt, rssFeed, pingIndexNow, pingWebSub, pingGoogleIndexing } from './seo.js';
import { publishToSocial } from './social.js';
import { FAVICON_SVG, getLogoPngBytes } from './logo.js';
import { generateOgPng } from './og.js';

const MAX_TOPICS_PER_TICK = 3; // balanced throughput well below Cloudflare's 50-subrequest limit

const timeoutSig = (ms = 7000) =>
  (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);

const createBudget = (max = 42) => {
  let used = 0;
  return {
    spend(n = 1) { used += n; },
    remaining() { return Math.max(0, max - used); },
  };
};

const EDGE_CACHE_VER = '?__v=7';

async function purgeEdgePaths(siteHost, paths) {
  const edgeCache = typeof caches !== 'undefined' && caches.default ? caches.default : null;
  if (!edgeCache || !siteHost || !paths.length) return;
  await Promise.allSettled(
    [...new Set(paths)].map(p => edgeCache.delete(new Request(`https://${siteHost}${p}${EDGE_CACHE_VER}`, { method: 'GET' })))
  );
}

const isoNow = () => new Date().toISOString();
const todayStr = () => isoNow().slice(0, 10);

const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Content-Security-Policy': `default-src 'self' https://*.google.com https://www.gstatic.com; style-src 'self' 'unsafe-inline' https://news.google.com https://www.gstatic.com https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com https://www.gstatic.com data:; script-src 'self' '${BACK_SCRIPT_HASH}' '${SWG_SCRIPT_HASH}' https://news.google.com https://*.google.com https://www.gstatic.com; img-src 'self' https: data:; object-src 'none'; frame-src https://news.google.com https://*.google.com; connect-src 'self' https://news.google.com https://*.google.com https://www.gstatic.com; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

const SEO_INDEX_HEADERS = {
  ...SECURITY_HEADERS,
  'Cache-Control': 'public, s-maxage=180, max-age=30, stale-while-revalidate=600',
  'X-Robots-Tag': 'index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1',
};

const htmlRes = (body, status = 200, extra = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html;charset=utf-8', ...SECURITY_HEADERS, ...extra } });
const textRes = (body, status = 200) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain;charset=utf-8', ...SECURITY_HEADERS } });
const xmlRes = body =>
  new Response(body, { headers: { 'Content-Type': 'application/xml;charset=utf-8', 'Cache-Control': 'public, s-maxage=120, max-age=30, stale-while-revalidate=300', ...SECURITY_HEADERS } });

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
 * Parameterized D1 search across title, topic, summary, body, sources, and related queries.
 * Ranks exact/title matches highest before recency.
 */
async function searchLivePosts(db, nowIso, rawQuery, catSlug = '') {
  const clean = String(rawQuery || '').trim();
  const terms = clean.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 4);
  if (!terms.length) return [];

  const escLike = t => `%${t.replace(/[\\%_]/g, '\\$&')}%`;
  const clauses = [];
  const binds = [nowIso];

  for (const t of terms) {
    const pat = escLike(t);
    clauses.push("(LOWER(title) LIKE ? ESCAPE '\\' OR LOWER(topic) LIKE ? ESCAPE '\\' OR LOWER(summary) LIKE ? ESCAPE '\\' OR LOWER(what_happened) LIKE ? ESCAPE '\\' OR LOWER(sources) LIKE ? ESCAPE '\\' OR LOWER(also_searched) LIKE ? ESCAPE '\\')");
    binds.push(pat, pat, pat, pat, pat, pat);
  }

  const sql = `SELECT * FROM topics WHERE status = 'published' AND expires_at > ? AND ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT 150`;
  let rows = (await db.prepare(sql).bind(...binds).all()).results || [];

  if (catSlug) {
    rows = rows.filter(r => slugify(r.category || 'News') === catSlug);
  }

  const phrase = clean.toLowerCase();
  const scored = rows.map(r => {
    const tLow = String(r.title || '').toLowerCase();
    const topLow = String(r.topic || '').toLowerCase();
    const srcLow = `${r.sources || ''} ${r.category || ''}`.toLowerCase();
    const bodyLow = `${r.summary || ''} ${r.what_happened || ''} ${r.also_searched || ''}`.toLowerCase();
    let score = 0;
    if (tLow.includes(phrase)) score += 40;
    if (topLow.includes(phrase)) score += 30;
    for (const term of terms) {
      if (tLow.includes(term)) score += 12;
      if (topLow.includes(term)) score += 8;
      if (srcLow.includes(term)) score += 5;
      if (bodyLow.includes(term)) score += 2;
    }
    return { row: r, score, ts: Date.parse(r.created_at) || 0 };
  });

  scored.sort((a, b) => (b.score - a.score) || (b.ts - a.ts));
  return scored.map(x => x.row);
}

/**
 * Append a short factual "Update" line for live posts (including extended posts)
 * when fresh headlines appear, update dateModified, and ping IndexNow once.
 */
async function updateLiveTopics(db, env, settings, siteUrl, nowIso, budget) {
  if (settings.devMode || budget.remaining() < 16) return [];
  const checkCutoff = new Date(Date.now() - 30 * 60_000).toISOString();
  const recentCutoff = new Date(Date.now() - 24 * 3600_000).toISOString();
  const candidates = (await db.prepare(
    "SELECT id, slug, topic, geo, source_urls, updates_json, update_pinged FROM topics WHERE status = 'published' AND expires_at > ? AND created_at >= ? AND (last_checked_at IS NULL OR last_checked_at < ?) ORDER BY COALESCE(last_checked_at, '') ASC LIMIT 1"
  ).bind(nowIso, recentCutoff, checkCutoff).all()).results || [];

  const updatedUrls = [];
  for (const post of candidates) {
    budget.spend(1);
    const fresh = await fetchGoogleNews(post.topic, post.geo || 'US');
    let existingUrls = [];
    let existingUpdates = [];
    try { existingUrls = JSON.parse(post.source_urls || '[]'); } catch { }
    try { existingUpdates = JSON.parse(post.updates_json || '[]'); } catch { }

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

  return updatedUrls;
}

/**
 * Upgrade 1 live post per idle cron tick from empty/thumbnail images to a verified high-res
 * publisher or Wikimedia Commons photograph, tracking checked slugs in social_state without schema changes.
 */
async function enrichWeakPostImages(db, settings, siteUrl, nowIso, budget) {
  if (settings.devMode || budget.remaining() < 24) return { updatedUrls: [], purgePaths: [] };
  let checked = [];
  try {
    const row = await db.prepare("SELECT v FROM social_state WHERE k = 'img_checked_slugs'").first();
    checked = JSON.parse(row?.v || '[]');
    if (!Array.isArray(checked)) checked = [];
  } catch { checked = []; }

  const weak = (await db.prepare(
    "SELECT id, slug, topic, category, source_urls, image_url, image_source FROM topics WHERE status = 'published' AND expires_at > ? AND (image_url = '' OR image_url LIKE '%encrypted-tbn%' OR image_url LIKE '%trendingrightnow.online%') ORDER BY created_at DESC LIMIT 80"
  ).bind(nowIso).all()).results || [];
  if (!weak.length) return { updatedUrls: [], purgePaths: [] };

  const checkedSet = new Set(checked);
  let target = weak.find(p => !checkedSet.has(p.slug));
  if (!target) {
    checked = [];
    target = weak[0];
  }

  let srcArr = [];
  try { srcArr = JSON.parse(target.source_urls || '[]') || []; } catch { }
  budget.spend(8);
  const hiRes = await extractHighResSourceImage(srcArr, target.topic);

  const nextChecked = [...checked.filter(s => s !== target.slug), target.slug].slice(-180);
  await db.prepare('INSERT INTO social_state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    .bind('img_checked_slugs', JSON.stringify(nextChecked)).run().catch(() => { });

  if (hiRes?.imageUrl && hiRes.imageUrl !== target.image_url) {
    await db.prepare('UPDATE topics SET image_url = ?, image_source = ?, updated_at = ? WHERE id = ?')
      .bind(hiRes.imageUrl, hiRes.imageSource || target.image_source || '', nowIso, target.id).run();
    const catPath = `/c/${slugify(target.category || 'News')}`;
    return {
      updatedUrls: [`${siteUrl}/p/${target.slug}`],
      purgePaths: [`/p/${target.slug}`, `/i/${target.slug}.jpg`, '/', catPath, '/sitemap.xml', '/news-sitemap.xml', '/rss.xml', `${catPath}/rss.xml`],
    };
  }
  return { updatedUrls: [], purgePaths: [] };
}

/**
 * Enforce 24-hour even publishing across all timezones (~9/hr, >=6m apart)
 * so daily quota doesn't exhaust in a few hours around midnight UTC.
 */
export async function getPublishAllowance(db, settings, nowMs = Date.now()) {
  const iso = new Date(nowMs).toISOString();
  const dayPrefix = `${iso.slice(0, 10)}%`;
  const hourPrefix = `${iso.slice(0, 13)}%`;

  const row = await db.prepare(
    `SELECT
       COUNT(*) AS day_cnt,
       SUM(CASE WHEN created_at LIKE ? THEN 1 ELSE 0 END) AS hour_cnt,
       MAX(created_at) AS latest_at
     FROM topics
     WHERE status = 'published' AND created_at LIKE ?`
  ).bind(hourPrefix, dayPrefix).first();

  const dayCount = Number(row?.day_cnt || 0);
  const hourCount = Number(row?.hour_cnt || 0);
  if (dayCount >= settings.maxDaily) {
    return { canPublish: false, reason: 'daily_cap', dayCount, hourCount };
  }
  if (!settings.devMode && hourCount >= settings.maxHourly) {
    return { canPublish: false, reason: 'hourly_cap', dayCount, hourCount };
  }
  if (!settings.devMode && settings.publishGapMins > 0 && row?.latest_at) {
    const elapsedMs = nowMs - Date.parse(row.latest_at);
    if (Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs < settings.publishGapMins * 60_000) {
      return { canPublish: false, reason: 'spacing', dayCount, hourCount };
    }
  }
  return { canPublish: true, reason: 'ok', dayCount, hourCount };
}

export async function canSendWebhookNow(db, env, nowMs = Date.now()) {
  if (!env.SOCIAL_WEBHOOK_URL) return false;
  const gapMins = Math.max(0, Number(env.WEBHOOK_MIN_GAP_MINS ?? 90));
  if (gapMins === 0) return true;
  try {
    const row = await db.prepare("SELECT v FROM social_state WHERE k = 'webhook_last_at'").first();
    const lastMs = row?.v ? Date.parse(row.v) : 0;
    return !lastMs || (nowMs - lastMs) >= gapMins * 60_000;
  } catch {
    return true;
  }
}

async function markWebhookSent(db, nowIso) {
  try {
    await db.prepare("INSERT OR REPLACE INTO social_state (k, v) VALUES ('webhook_last_at', ?)").bind(nowIso).run();
  } catch { /* ignore if migration not yet applied */ }
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
  const budget = createBudget(42); // reserves 8+ subrequests below Cloudflare's 50 limit

  // 1. Evaluate tiered extensions BEFORE deleting expired posts
  const { extendedSlugs, deletedSlugs } = await processExpirationsAndExtensions(db, now, settings);
  if (extendedSlugs.length) {
    const extUrls = extendedSlugs.map(s => `${siteUrl}/p/${s}`);
    budget.spend(1);
    await pingIndexNow(env, extUrls);
  }
  if (deletedSlugs.length) {
    const delUrls = deletedSlugs.map(s => `${siteUrl}/p/${s}`);
    budget.spend(Math.min(10, delUrls.length) + 2);
    await Promise.allSettled([
      pingIndexNow(env, delUrls),
      pingGoogleIndexing(env, delUrls, 'URL_DELETED'),
    ]);
  }

  // Hourly 7-day table cleanup (and always on termination/dev) to avoid 1,440 daily scans on D1 free tier
  const isCleanupTick = isSiteEnded || settings.devMode || new Date().getUTCMinutes() === 0;
  if (isCleanupTick) {
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
  }

  if (isSiteEnded) return;

  // 3. Enforce 24h even pacing (~8/hr, >=7m apart) and promote max 1 queued topic per paced slot
  const allowance = await getPublishAllowance(db, settings, Date.now());
  let count = allowance.dayCount;
  let canPublishNow = allowance.canPublish;

  // 2. Check recent (<24h) live posts for fresh headlines every 5m or during publish slots (saves 80% D1/RSS overhead)
  const shouldRunUpdates = settings.devMode || canPublishNow || (new Date().getUTCMinutes() % 5 === 0);
  const updatedUrls = shouldRunUpdates ? await updateLiveTopics(db, env, settings, siteUrl, now, budget) : [];
  const imgEnriched = (!settings.devMode && !canPublishNow)
    ? await enrichWeakPostImages(db, settings, siteUrl, now, budget)
    : { updatedUrls: [], purgePaths: [] };

  const promotedUrls = [];
  const newUrls = [];
  const publishedPosts = [];
  const touchedCats = new Set();

  if (canPublishNow) {
    const queuedLimit = settings.devMode ? Math.max(1, settings.maxDaily - count) : 1;
    const queued = (await db.prepare(
      "SELECT id, slug, title, summary, key_facts, category, topic, sources, approx_traffic FROM topics WHERE status = 'queued' ORDER BY approx_traffic DESC, created_at DESC LIMIT ?"
    ).bind(queuedLimit).all()).results || [];
    for (const q of queued) {
      const pubAt = isoNow();
      const pubExp = new Date(Date.now() + settings.baseTtlHours * 3600_000).toISOString();
      await db.prepare(
        "UPDATE topics SET status = 'published', created_at = ?, updated_at = ?, expires_at = ? WHERE id = ?"
      ).bind(pubAt, pubAt, pubExp, q.id).run();
      const catPath = `/c/${slugify(q.category || 'News')}`;
      touchedCats.add(catPath);
      promotedUrls.push(`${siteUrl}/p/${q.slug}`, `${siteUrl}${catPath}`, `${siteUrl}/`);
      let facts = [];
      try { facts = JSON.parse(q.key_facts || '[]') || []; } catch { }
      publishedPosts.push({
        slug: q.slug,
        title: q.title,
        summary: q.summary,
        key_facts: facts,
        category: q.category,
        topic: q.topic,
        sources: q.sources,
        approxTraffic: q.approx_traffic || 0,
      });
      count++;
      if (!settings.devMode && settings.publishGapMins > 0) canPublishNow = false;
    }
  }

  // Only fetch Trends RSS, Google News & AI during an open publish slot (cuts idle API/D1 usage ~80%)
  const shouldFetchNew = settings.devMode || canPublishNow;

  if (shouldFetchNew) {
    // 4. Fetch Trends RSS — always fetch primary geo (US) + rotate 2 secondary geos per minute
    let tickGeos = settings.geos;
    if (!settings.devMode && settings.geos.length > 3) {
      const primaryGeo = settings.geos[0];
      const secondary = settings.geos.slice(1);
      const rot = (Math.floor(Date.now() / 60_000) * 2) % secondary.length;
      tickGeos = [primaryGeo, secondary[rot], secondary[(rot + 1) % secondary.length]];
    }

    const rawCandidates = [];
    for (const geo of tickGeos) {
      let xml = '';
      if (settings.devMode) {
        xml = MOCK_RSS;
      } else {
        if (budget.remaining() <= 10) break;
        budget.spend(1);
        try {
          const res = await fetch(`https://trends.google.com/trending/rss?geo=${geo}`, {
            headers: { 'User-Agent': 'TrendBot/1.0' },
            signal: timeoutSig(7000),
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
        try { trendsItems = JSON.parse(p.source_json || '[]'); } catch { }
        rawCandidates.push({ title: p.topic, approxTraffic: p.approx_traffic, newsItems: trendsItems, geo: p.geo });
      }
    }

    const ranked = rankTopics(rawCandidates);

    const liveRows = (await db.prepare(
      "SELECT id, slug, title, topic, image_url FROM topics WHERE status = 'published' AND expires_at > ?"
    ).bind(now).all()).results || [];
    const liveTitles = new Set(liveRows.map(r => r.title.toLowerCase()));
    const liveBySlug = new Map(liveRows.map(r => [r.slug, r]));
    const seenSet = new Set(
      ((await db.prepare('SELECT topic_hash FROM seen_topics').all()).results || []).map(r => r.topic_hash)
    );

    for (const item of ranked) {
      const slugKey = slugify(item.title);
      const existing = liveBySlug.get(slugKey);
      if (existing && !existing.image_url && item.imageUrl) {
        await db.prepare('UPDATE topics SET image_url = ?, image_source = ? WHERE id = ?')
          .bind(item.imageUrl, item.imageSource || '', existing.id)
          .run();
        existing.image_url = item.imageUrl;
      }
    }

    let processedThisTick = 0;

    for (const item of ranked) {
      const hash = slugify(item.title);
      if (!hash || seenSet.has(hash)) continue;

      if (isNearDuplicateTopic(item.title, liveRows)) {
        await logRejected(db, hash, item.title, item.geo, 'duplicate_topic', 'Near-duplicate of live post');
        await markSeen(db, hash, hash, now);
        seenSet.add(hash);
        await db.prepare('DELETE FROM pending_topics WHERE topic_hash = ?').bind(hash).run();
        continue;
      }

      const earlyText = [item.title, ...(item.newsItems || []).map(n => `${n.title} ${n.snippet}`)].join(' ');
      if (isSensitive(earlyText)) {
        await logRejected(db, hash, item.title, item.geo, 'sensitive', 'Matched blocklist in Trends RSS');
        await markSeen(db, hash, hash, now);
        seenSet.add(hash);
        await db.prepare('DELETE FROM pending_topics WHERE topic_hash = ?').bind(hash).run();
        continue;
      }

      // Backoff recent pending retries by 90s so we don't spin on the same topic back-to-back
      const pend = pendingMap.get(hash);
      if (pend && pend.last_tried_at && Date.now() - Date.parse(pend.last_tried_at) < 90_000) {
        continue;
      }

      if (processedThisTick >= MAX_TOPICS_PER_TICK) break;
      if (!settings.devMode && budget.remaining() <= 10) break; // reserve remaining subrequests strictly for indexing
      processedThisTick++;

      if (!settings.devMode) budget.spend(1);
      const googleNewsItems = settings.devMode
        ? (MOCK_GOOGLE_NEWS[hash] || [])
        : await fetchGoogleNews(item.title, item.geo || 'US');

      const merged = mergeSources(item.newsItems, googleNewsItems);

      if (merged.distinctOutlets.length < 2) {
        if (!pend) {
          await db.prepare(
            'INSERT OR IGNORE INTO pending_topics (topic_hash, topic, geo, approx_traffic, source_json, first_seen_at, last_tried_at, retry_count) VALUES (?, ?, ?, ?, ?, ?, ?, 0)'
          ).bind(hash, item.title, item.geo, item.approxTraffic || 0, JSON.stringify(item.newsItems || []), now, now).run();
        } else {
          await db.prepare('UPDATE pending_topics SET last_tried_at = ? WHERE topic_hash = ?').bind(now, hash).run();
        }
        continue;
      }

      const result = await generateAndValidatePost(
        env,
        { topic: item.title, sources: merged.items },
        liveTitles,
        { skipLlmVerifier: true, budget }
      );

      if (!result.ok) {
        const retries = (pend?.retry_count || 0) + 1;
        await logRejected(db, hash, item.title, item.geo, result.code, result.reason);
        if (result.code === 'sensitive' || result.code === 'duplicate_topic' || (result.code === 'quality_gate' && retries >= 3)) {
          await markSeen(db, hash, hash, now);
          seenSet.add(hash);
          await db.prepare('DELETE FROM pending_topics WHERE topic_hash = ?').bind(hash).run();
        } else if (!pend) {
          await db.prepare(
            'INSERT OR IGNORE INTO pending_topics (topic_hash, topic, geo, approx_traffic, source_json, first_seen_at, last_tried_at, retry_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(hash, item.title, item.geo, item.approxTraffic || 0, JSON.stringify(item.newsItems || []), now, now, retries).run();
        } else {
          await db.prepare('UPDATE pending_topics SET last_tried_at = ?, retry_count = ? WHERE topic_hash = ?').bind(now, retries, hash).run();
        }
        continue;
      }

      const post = result.post;
      const created = isoNow();
      const expires = new Date(Date.now() + settings.baseTtlHours * 3600_000).toISOString();
      const status = count >= settings.maxDaily ? 'queued' : 'published';
      const sourcesCsv = merged.distinctOutlets.join(', ');
      let resolvedImgUrl = item.imageUrl || '';
      let resolvedImgSource = item.imageSource || '';
      if (!settings.devMode && budget.remaining() >= 6 && (merged.sourceUrls.length || item.title)) {
        budget.spend(2);
        const hiRes = await extractHighResSourceImage(merged.sourceUrls, item.title);
        if (hiRes?.imageUrl) {
          resolvedImgUrl = hiRes.imageUrl;
          resolvedImgSource = hiRes.imageSource || resolvedImgSource;
        }
      }

      try {
        await db.batch([
          db.prepare(
            `INSERT INTO topics (
              slug, title, body, summary, what_happened, why_trending, key_facts,
              what_to_know_next, also_searched, bullets, sources, source_urls,
              image_url, image_source, category, topic, geo, status, approx_traffic, created_at, updated_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            hash, post.title, post.what_happened, post.summary, post.what_happened,
            post.why_trending, JSON.stringify(post.key_facts), post.what_to_know_next,
            JSON.stringify(post.also_searched), JSON.stringify(post.key_facts),
            sourcesCsv, JSON.stringify(merged.sourceUrls),
            resolvedImgUrl, resolvedImgSource, post.category,
            item.title, item.geo, status, item.approxTraffic || 0, created, created, expires
          ),
          db.prepare('INSERT OR IGNORE INTO seen_topics (topic_hash, slug, seen_at) VALUES (?, ?, ?)')
            .bind(hash, hash, created),
          db.prepare('DELETE FROM pending_topics WHERE topic_hash = ?').bind(hash),
        ]);

        seenSet.add(hash);
        liveTitles.add(post.title.toLowerCase());
        liveRows.push({ title: post.title, topic: item.title });
        if (status === 'published') {
          const catPath = `/c/${slugify(post.category || 'News')}`;
          touchedCats.add(catPath);
          touchedCats.add(`${catPath}/rss.xml`);
          newUrls.push(`${siteUrl}/p/${hash}`, `${siteUrl}${catPath}`, `${siteUrl}/`);
          publishedPosts.push({
            slug: hash,
            title: post.title,
            summary: post.summary,
            key_facts: post.key_facts,
            category: post.category,
            topic: item.title,
            sources: sourcesCsv,
            approxTraffic: item.approxTraffic || 0,
            usedFallback: Boolean(result.usedFallback),
            fallbackReason: result.reason || '',
          });
          count++;
          if (!settings.devMode && settings.publishGapMins > 0) break;
        }
      } catch { /* duplicate slug — skip gracefully */ }
    }
  }

  const postPings = [...new Set([...newUrls, ...promotedUrls].filter(u => u.includes('/p/')))];
  const indexNowBatch = [...new Set([...newUrls, ...updatedUrls, ...imgEnriched.updatedUrls, ...promotedUrls])];
  const updatedPaths = updatedUrls.map(u => {
    try { return new URL(u).pathname; } catch { return ''; }
  }).filter(Boolean);

  if (indexNowBatch.length) {
    const topPost = publishedPosts[0];
    const isViralShareable = topPost && (
      ['Entertainment', 'Sports', 'Gaming', 'Tech', 'Holidays', 'Weather', 'Science', 'News'].includes(topPost.category || 'News') ||
      (topPost.approxTraffic || 0) >= 50_000
    );
    const allowWebhook = Boolean(isViralShareable && await canSendWebhookNow(db, env));
    const socialTask = publishToSocial(env, publishedPosts, siteUrl, budget, { allowWebhook })
      .then(async res => {
        if (allowWebhook && res.find(r => r.platform === 'webhook')?.ok) {
          await markWebhookSent(db, isoNow());
        }
        return res;
      });
    const [idxRes, webSubRes, gIdxRes] = await Promise.allSettled([
      pingIndexNow(env, indexNowBatch),
      pingWebSub(env, siteUrl),
      pingGoogleIndexing(env, postPings, 'URL_UPDATED'),
      socialTask,
      purgeEdgePaths(settings.siteHost, ['/', '/sitemap.xml', '/news-sitemap.xml', '/rss.xml', '/llms.txt', ...touchedCats, ...updatedPaths, ...imgEnriched.purgePaths]),
    ]);
    try {
      const keyName = postPings.length ? 'indexing_telemetry' : 'update_indexing_telemetry';
      const val = JSON.stringify({
        at: isoNow(),
        indexNow: idxRes.status === 'fulfilled' ? idxRes.value : { error: idxRes.reason?.message },
        webSub: webSubRes.status === 'fulfilled' ? webSubRes.value : { error: webSubRes.reason?.message },
        google: gIdxRes.status === 'fulfilled' ? gIdxRes.value : { error: gIdxRes.reason?.message },
        llmFallback: publishedPosts[0]?.usedFallback || false,
        llmReason: publishedPosts[0]?.fallbackReason?.slice(0, 140) || '',
        urls: postPings.slice(0, 5),
      }).slice(0, 1000);
      await db.prepare('INSERT INTO social_state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(keyName, val).run();
    } catch { }
  }
}

// ══════════════════════════════════════════════════════════════
//  FETCH HANDLER — routes all HTTP requests
// ══════════════════════════════════════════════════════════════

const redirect301 = dest =>
  new Response(null, { status: 301, headers: { Location: dest, 'Cache-Control': 'public, max-age=3600', ...SECURITY_HEADERS } });

export async function handleFetch(request, env, ctx) {
  const settings = getSettings(env);
  const url = new URL(request.url);
  const hostNorm = normalizeHost(env.SITE_HOST) || url.host;
  const canonicalHost = hostNorm.split(':')[0].toLowerCase();
  const reqHost = url.hostname.toLowerCase();

  // Enforce single-hop 301 canonical apex host (www -> apex) + HTTPS redirect on custom domains
  if (reqHost !== 'localhost' && reqHost !== '127.0.0.1') {
    if (env.SITE_HOST && !canonicalHost.startsWith('www.') && reqHost === `www.${canonicalHost}`) {
      return redirect301(`https://${hostNorm}${url.pathname}${url.search}`);
    }
    if (url.protocol === 'http:') {
      return redirect301(`https://${url.host}${url.pathname}${url.search}`);
    }
  }

  const siteUrl = `https://${hostNorm}`;
  const path = url.pathname;
  const db = env.DB;
  const now = isoNow();
  const nowMs = Date.parse(now);

  if (path === `/${env.INDEXNOW_KEY || '_'}.txt`) return textRes(env.INDEXNOW_KEY || '');
  if (path === '/robots.txt') return textRes(robotsTxt(siteUrl));

  if (path === '/favicon.svg' || path === '/favicon.ico') {
    return new Response(FAVICON_SVG, {
      headers: {
        'Content-Type': 'image/svg+xml;charset=utf-8',
        'Cache-Control': 'public, max-age=86400',
        ...SECURITY_HEADERS,
      },
    });
  }

  if (path === '/logo.png' || path === '/apple-touch-icon.png') {
    return new Response(getLogoPngBytes(), {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, s-maxage=604800, max-age=86400',
        ...SECURITY_HEADERS,
      },
    });
  }

  const isSiteEnded = Boolean(env.SITE_END_AT && nowMs > Date.parse(env.SITE_END_AT));
  if (isSiteEnded) {
    const liveCount = (await db.prepare(
      "SELECT COUNT(*) as c FROM topics WHERE status = 'published' AND expires_at > ?"
    ).bind(now).first())?.c || 0;
    if (liveCount === 0) return htmlRes(endedPage(), 410, { 'X-Robots-Tag': 'noindex' });
  }

  // Canonical query redirects for pagination (?page=1 -> /, ?page=N -> /page/N)
  if (path === '/' && url.searchParams.has('page')) {
    const qPage = Number.parseInt(url.searchParams.get('page') || '1', 10);
    const dest = qPage > 1 ? `${siteUrl}/page/${qPage}` : `${siteUrl}/`;
    return Response.redirect(dest, 301);
  }
  if (path === '/page/1' || path === '/page/1/') {
    return Response.redirect(`${siteUrl}/`, 301);
  }

  // Edge Cache API for clean cacheable GET requests (never cache /search queries under path key)
  const edgeCache = typeof caches !== 'undefined' && caches.default ? caches.default : null;
  const isCacheableGet = request.method === 'GET' && !isSiteEnded && (
    (path === '/' && !url.searchParams.has('page')) ||
    path.startsWith('/page/') ||
    path === '/about' ||
    path === '/sitemap.xml' ||
    path === '/news-sitemap.xml' ||
    path === '/rss.xml' ||
    path === '/llms.txt' ||
    path === '/og.png' ||
    path.startsWith('/og/') ||
    path.startsWith('/i/') ||
    (path.startsWith('/c/') && !url.searchParams.has('page')) ||
    path.startsWith('/p/')
  );
  const cacheKey = isCacheableGet ? new Request(`https://${url.host}${path}${EDGE_CACHE_VER}`, { method: 'GET' }) : null;

  if (edgeCache && cacheKey) {
    const cached = await edgeCache.match(cacheKey);
    if (cached) {
      if ((path === '/' || path.startsWith('/page/') || path.startsWith('/c/') || path.startsWith('/p/')) &&
        shouldCountSearchHit(request) && ctx?.waitUntil) {
        const slug = path.startsWith('/p/') ? path.slice(3).replace(/\/+$/, '') : null;
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

  if (path === '/og.png') {
    const png = await generateOgPng({ siteName: settings.siteName, host: hostNorm });
    return cacheAndReturn(new Response(png, {
      headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, s-maxage=86400, max-age=3600', ...SECURITY_HEADERS },
    }));
  }

  const imgProxyMatch = path.match(/^\/i\/([a-z0-9-]+)\.(?:jpg|jpeg|png)$/i);
  if (imgProxyMatch) {
    const slug = imgProxyMatch[1].toLowerCase();
    const post = await db.prepare(
      "SELECT id, title, topic, category, image_url, image_source, source_urls FROM topics WHERE slug = ? AND status = 'published' AND expires_at > ?"
    ).bind(slug, now).first();
    if (!post) return new Response('Not Found', { status: 404, headers: SECURITY_HEADERS });

    const candidateUrls = [];
    if (!settings.devMode && (post.source_urls || post.topic) && (!post.image_url || /encrypted-tbn\d*\.gstatic\.com|trendingrightnow\.online/i.test(post.image_url))) {
      let srcArr = [];
      try { srcArr = JSON.parse(post.source_urls || '[]') || []; } catch { }
      const hiRes = await extractHighResSourceImage(srcArr, post.topic);
      if (hiRes?.imageUrl) {
        candidateUrls.push(hiRes.imageUrl);
        if (hiRes.imageUrl !== post.image_url) {
          const upd = db.prepare('UPDATE topics SET image_url = ?, image_source = ? WHERE id = ?')
            .bind(hiRes.imageUrl, hiRes.imageSource || post.image_source || '', post.id).run().catch(() => { });
          if (ctx?.waitUntil) ctx.waitUntil(upd); else await upd;
        }
      }
    }
    if (post.image_url) candidateUrls.push(post.image_url);

    for (const imgSrc of candidateUrls) {
      try {
        const up = await fetch(imgSrc, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: timeoutSig(6000),
        });
        const ct = up.headers.get('content-type') || '';
        if (up.ok && ct.startsWith('image/')) {
          return cacheAndReturn(new Response(up.body, {
            headers: {
              'Content-Type': ct,
              'Cache-Control': 'public, s-maxage=86400, max-age=3600, stale-while-revalidate=86400',
              'X-Robots-Tag': 'index, max-image-preview:large',
              ...SECURITY_HEADERS,
            },
          }));
        }
      } catch { /* try next candidate or fall through to PNG card */ }
    }

    const png = await generateOgPng({
      title: post.title,
      category: post.category,
      siteName: settings.siteName,
      host: hostNorm,
    });
    return cacheAndReturn(new Response(png, {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, s-maxage=3600, max-age=600',
        'X-Robots-Tag': 'index, max-image-preview:large',
        ...SECURITY_HEADERS,
      },
    }));
  }

  const ogPostMatch = path.match(/^\/og\/([a-z0-9-]+)\.png$/i);
  if (ogPostMatch) {
    const slug = ogPostMatch[1].toLowerCase();
    const post = await db.prepare(
      "SELECT title, category FROM topics WHERE slug = ? AND status = 'published' AND expires_at > ?"
    ).bind(slug, now).first();
    const png = await generateOgPng({
      title: post ? post.title : 'Live Factual Trend Briefings',
      category: post ? post.category : 'Top Stories',
      siteName: settings.siteName,
      host: hostNorm,
    });
    return cacheAndReturn(new Response(png, {
      headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, s-maxage=3600, max-age=600', ...SECURITY_HEADERS },
    }));
  }

  if (path === '/about') return cacheAndReturn(htmlRes(aboutPage(settings, siteUrl), 200, SEO_INDEX_HEADERS));

  // Targeted projections & SQL-level filters cut D1 row reads by ~75% across routes
  const liveSummary = async () => (await db.prepare(
    "SELECT slug, title, summary, key_facts, updates_json, also_searched, sources, category, topic, geo, created_at, updated_at, expires_at, extended, image_url, image_source FROM topics WHERE status = 'published' AND expires_at > ? ORDER BY created_at DESC"
  ).bind(now).all()).results || [];

  const liveCategory = async catName => (await db.prepare(
    "SELECT slug, title, summary, key_facts, updates_json, also_searched, sources, category, topic, geo, created_at, updated_at, expires_at, extended, image_url, image_source FROM topics WHERE status = 'published' AND category = ? AND expires_at > ? ORDER BY created_at DESC"
  ).bind(catName, now).all()).results || [];

  const liveSitemap = async () => (await db.prepare(
    "SELECT slug, title, category, created_at, updated_at, extended FROM topics WHERE status = 'published' AND expires_at > ? ORDER BY created_at DESC"
  ).bind(now).all()).results || [];

  const liveNewsSitemap = async () => {
    const cutoff48h = new Date(nowMs - 48 * 3600_000).toISOString();
    return (await db.prepare(
      "SELECT slug, title, category, created_at FROM topics WHERE status = 'published' AND expires_at > ? AND created_at >= ? ORDER BY created_at DESC"
    ).bind(now, cutoff48h).all()).results || [];
  };

  const liveLlms = async () => (await db.prepare(
    "SELECT slug, title, summary, category, created_at FROM topics WHERE status = 'published' AND expires_at > ? ORDER BY created_at DESC LIMIT 60"
  ).bind(now).all()).results || [];

  const liveRelated = async () => (await db.prepare(
    "SELECT slug, title, topic, category, created_at, also_searched FROM topics WHERE status = 'published' AND expires_at > ? ORDER BY created_at DESC LIMIT 160"
  ).bind(now).all()).results || [];

  const liveRss = async () => (await db.prepare(
    "SELECT slug, title, summary, what_happened, why_trending, key_facts, sources, category, created_at, updated_at FROM topics WHERE status = 'published' AND expires_at > ? ORDER BY created_at DESC LIMIT 50"
  ).bind(now).all()).results || [];

  const liveCategoryRss = async catName => (await db.prepare(
    "SELECT slug, title, summary, what_happened, why_trending, key_facts, sources, category, created_at, updated_at FROM topics WHERE status = 'published' AND category = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 50"
  ).bind(catName, now).all()).results || [];

  if (path === '/sitemap.xml') return cacheAndReturn(xmlRes(sitemapXml(await liveSitemap(), siteUrl)));
  if (path === '/news-sitemap.xml') return cacheAndReturn(xmlRes(newsSitemapXml(await liveNewsSitemap(), siteUrl, settings.siteName, nowMs)));
  if (path === '/rss.xml') return cacheAndReturn(xmlRes(rssFeed(await liveRss(), siteUrl, settings.siteName)));
  const catRssMatch = path.match(/^\/c\/([a-z0-9-]+)\/rss\.xml$/i);
  if (catRssMatch) {
    const catSlug = catRssMatch[1].toLowerCase();
    const knownNames = [...new Set([...PREFERRED_CATEGORIES, 'News'])];
    const catName = knownNames.find(c => slugify(c) === catSlug);
    if (!catName) return htmlRes(notFoundPage(settings, siteUrl), 404, { 'X-Robots-Tag': 'noindex, follow' });
    const rows = await liveCategoryRss(catName);
    return cacheAndReturn(xmlRes(rssFeed(rows, siteUrl, settings.siteName, `${settings.siteName} — ${catName}`, `/c/${catSlug}/rss.xml`)));
  }
  if (path === '/llms.txt') {
    return cacheAndReturn(new Response(llmsTxt(await liveLlms(), siteUrl, settings.siteName), {
      headers: {
        'Content-Type': 'text/plain;charset=utf-8',
        'Cache-Control': 'public, s-maxage=120, max-age=30, stale-while-revalidate=300',
        ...SECURITY_HEADERS,
      },
    }));
  }

  // Home page (page 1) and paginated home (/page/2, /page/3, ...)
  const homePageMatch = path === '/' ? [null, '1'] : path.match(/^\/page\/(\d+)\/?$/);
  if (homePageMatch) {
    const pageNum = Number.parseInt(homePageMatch[1], 10);
    if (!Number.isFinite(pageNum) || pageNum < 1) return Response.redirect(`${siteUrl}/`, 301);

    const posts = await liveSummary();
    const totalPages = Math.max(1, Math.ceil(posts.length / PER_PAGE));
    if (pageNum > totalPages) {
      return htmlRes(notFoundPage(settings, siteUrl), 404, { 'X-Robots-Tag': 'noindex, follow' });
    }

    if (shouldCountSearchHit(request) && ctx?.waitUntil) {
      ctx.waitUntil(recordSearchHit(db, null, now));
    }
    const lastMod = posts[0] ? new Date(posts[0].updated_at || posts[0].created_at).toUTCString() : new Date(nowMs).toUTCString();
    return cacheAndReturn(htmlRes(homePage(posts, settings, siteUrl, nowMs, pageNum), 200, {
      ...SEO_INDEX_HEADERS,
      'Last-Modified': lastMod,
    }));
  }

  // Category hub pages (/c/{category} & /c/{category}/page/{n})
  const catMatch = path.match(/^\/c\/([a-z0-9-]+)(?:\/page\/(\d+))?\/?$/i);
  if (catMatch) {
    const catSlug = catMatch[1].toLowerCase();
    if (url.searchParams.has('page')) {
      const qPage = Number.parseInt(url.searchParams.get('page') || '1', 10);
      return Response.redirect(qPage > 1 ? `${siteUrl}/c/${catSlug}/page/${qPage}` : `${siteUrl}/c/${catSlug}`, 301);
    }
    if (catMatch[2] === '1' || catMatch[2] === '0') {
      return Response.redirect(`${siteUrl}/c/${catSlug}`, 301);
    }

    const knownNames = [...PREFERRED_CATEGORIES, 'News'];
    const catName = knownNames.find(c => slugify(c) === catSlug);
    if (!catName) {
      return htmlRes(notFoundPage(settings, siteUrl), 404, { 'X-Robots-Tag': 'noindex, follow' });
    }

    const filtered = await liveCategory(catName);
    const pageNum = catMatch[2] ? Number.parseInt(catMatch[2], 10) : 1;
    const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
    if (pageNum > totalPages) {
      return htmlRes(notFoundPage(settings, siteUrl), 404, { 'X-Robots-Tag': 'noindex, follow' });
    }

    if (shouldCountSearchHit(request) && ctx?.waitUntil) {
      ctx.waitUntil(recordSearchHit(db, null, now));
    }
    const headers = filtered.length
      ? SEO_INDEX_HEADERS
      : { ...SECURITY_HEADERS, 'Cache-Control': 'public, s-maxage=60, max-age=30', 'X-Robots-Tag': 'noindex, follow' };
    return cacheAndReturn(htmlRes(categoryPage(catName, filtered, settings, siteUrl, nowMs, pageNum), 200, headers));
  }

  // Live search endpoint (/search?q=...&cat=...&page=...)
  if (path === '/search' || path === '/search/') {
    const query = (url.searchParams.get('q') || '').trim().slice(0, 120);
    const cat = slugify(url.searchParams.get('cat') || '');
    const page = Math.max(1, Number.parseInt(url.searchParams.get('page') || '1', 10) || 1);
    const allLive = await liveSummary();
    const results = query
      ? await searchLivePosts(db, now, query, cat)
      : (cat ? allLive.filter(p => slugify(p.category || 'News') === cat) : []);
    return htmlRes(searchPage({ query, cat, page, results, allLive }, settings, siteUrl, nowMs), 200, {
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex, follow',
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
      const allLive = await liveRelated();
      const others = allLive.filter(p => p.slug !== slug);
      const sameCat = others.filter(p => (p.category || 'News') === (post.category || 'News'));
      const diffCat = others.filter(p => (p.category || 'News') !== (post.category || 'News'));
      // Mix 3 newest same-category siblings + 3 deeper rotated siblings so older posts never become crawl orphans
      const deeper = sameCat.slice(3);
      const seed = [...slug].reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
      const deepPicks = deeper.length <= 3
        ? deeper
        : [0, 1, 2].map(i => deeper[(seed + i * 7) % deeper.length]);
      const pool = sameCat.length >= 2
        ? [...sameCat.slice(0, 3), ...deepPicks, ...sameCat, ...diffCat]
        : [...sameCat, ...diffCat];
      const seenRel = new Set();
      const related = [];
      for (const item of pool) {
        if (!item || seenRel.has(item.slug)) continue;
        seenRel.add(item.slug);
        related.push(item);
        if (related.length >= 6) break;
      }

      return cacheAndReturn(htmlRes(postPage(post, related, allLive, settings, siteUrl, nowMs), 200, {
        ...SEO_INDEX_HEADERS,
        'Last-Modified': new Date(post.updated_at || post.created_at).toUTCString(),
      }));
    }

    const wasSeen = await db.prepare('SELECT 1 FROM seen_topics WHERE slug = ?').bind(slug).first();
    return htmlRes(gonePage(siteUrl), (wasSeen || isSiteEnded) ? 410 : 404, { 'X-Robots-Tag': 'noindex, follow' });
  }

  return htmlRes(notFoundPage(settings, siteUrl), 404, { 'X-Robots-Tag': 'noindex, follow' });
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
