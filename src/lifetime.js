/**
 * Tiered post lifetime: search-traction detection, bot filtering,
 * 48h -> 7-day extension, and expiration cleanup.
 */

const KNOWN_BOT_RE = new RegExp(
  [
    'bot', 'crawl', 'spider', 'slurp', 'googlebot', 'bingbot', 'duckduckbot',
    'yandex', 'baidu', 'applebot', 'ahrefs', 'semrush', 'mj12bot', 'dotbot',
    'petalbot', 'bytespider', 'gptbot', 'claudebot', 'perplexitybot', 'ccbot',
    'mediapartners', 'adsbot', 'bingpreview', 'facebookexternalhit', 'facebot',
    'twitterbot', 'linkedinbot', 'slackbot', 'whatsapp', 'telegrambot',
    'discordbot', 'lighthouse', 'pagespeed', 'headless', 'puppeteer',
    'playwright', 'selenium', 'phantom', 'python-requests', 'go-http-client',
  ].join('|'),
  'i'
);

const SEARCH_REFERRER_RE = /(?:^|\.)(google|bing|duckduckgo)\./i;

/**
 * Check if Referer header comes from Google, Bing, or DuckDuckGo.
 */
export function isSearchReferrer(referer) {
  if (!referer) return false;
  try {
    const host = new URL(referer).hostname;
    return SEARCH_REFERRER_RE.test(host);
  } catch {
    return /(?:^|\/\/|\.)(google|bing|duckduckgo)\./i.test(referer);
  }
}

export function isKnownBot(userAgent) {
  if (!userAgent) return false;
  return KNOWN_BOT_RE.test(userAgent);
}

/**
 * Count hit only if GET + search-engine Referer + non-bot User-Agent.
 */
export function shouldCountSearchHit(request) {
  if (!request || request.method !== 'GET') return false;
  const referer = request.headers.get('referer') || '';
  const ua = request.headers.get('user-agent') || '';
  return isSearchReferrer(referer) && !isKnownBot(ua);
}

/**
 * Record a search-referred human hit without storing IP or personal data.
 * If slug is provided, updates that post; if null (home page), updates live posts.
 */
export async function recordSearchHit(db, slug, nowIso) {
  if (slug) {
    await db.prepare(
      "UPDATE topics SET search_hits = search_hits + 1, last_search_hit_at = ? WHERE slug = ? AND status = 'published' AND expires_at > ?"
    ).bind(nowIso, slug, nowIso).run();
    return;
  }
  await db.prepare(
    "UPDATE topics SET search_hits = search_hits + 1, last_search_hit_at = ? WHERE status = 'published' AND expires_at > ?"
  ).bind(nowIso, nowIso).run();
}

/**
 * Evaluate extensions BEFORE deleting expired posts:
 * - Posts with search_hits >= extendMinHits and extended = 0 get extended to created_at + extendedTtlHours
 * - Posts whose current expires_at < nowIso are deleted
 * Returns { extendedSlugs, deletedSlugs }
 */
export async function processExpirationsAndExtensions(db, nowIso, settings) {
  const { extendMinHits, baseTtlHours, extendedTtlHours } = settings;
  const nowMs = Date.parse(nowIso);

  // 1. Find candidates eligible for extension before deleting expired posts
  const candidates = (await db.prepare(
    "SELECT id, slug, created_at, expires_at, search_hits, last_search_hit_at FROM topics WHERE status = 'published' AND extended = 0 AND search_hits >= ?"
  ).bind(extendMinHits).all()).results || [];

  const extendedSlugs = [];
  for (const post of candidates) {
    const createdMs = Date.parse(post.created_at);
    const baseWindowEndMs = createdMs + baseTtlHours * 3600_000;
    const hitMs = post.last_search_hit_at ? Date.parse(post.last_search_hit_at) : createdMs;

    // Require search traction within its first BASE_TTL_HOURS
    if (hitMs <= baseWindowEndMs) {
      const newExpiresIso = new Date(createdMs + extendedTtlHours * 3600_000).toISOString();
      await db.prepare(
        'UPDATE topics SET expires_at = ?, extended = 1 WHERE id = ?'
      ).bind(newExpiresIso, post.id).run();
      extendedSlugs.push(post.slug);
    }
  }

  // 2. Delete only posts whose current expires_at has passed
  const expired = (await db.prepare(
    'SELECT slug FROM topics WHERE expires_at < ?'
  ).bind(nowIso).all()).results || [];

  if (expired.length) {
    await db.prepare('DELETE FROM topics WHERE expires_at < ?').bind(nowIso).run();
  }

  // Note: also clean up any queued posts past expires_at
  return {
    extendedSlugs,
    deletedSlugs: expired.map(r => r.slug),
    nowMs,
  };
}
