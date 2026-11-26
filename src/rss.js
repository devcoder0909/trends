/**
 * RSS parsing, Google News grounding, and topic ranking.
 * Zero dependencies — uses lightweight XML regex extraction.
 */

import { classifyCategory, PREFERRED_CATEGORIES } from './config.js';

const ENTITY_MAP = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

export function decodeEntities(str) {
  return String(str || '')
    .replace(/&([a-z]+);/gi, (m, name) => ENTITY_MAP[name.toLowerCase()] ?? m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

export function stripHtml(str) {
  return decodeEntities(String(str || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

export function xmlTag(xml, name) {
  const cdata = new RegExp(`<${name}(?:\\s[^>]*)?><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${name}>`, 'i');
  const plain = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i');
  const raw = (xml.match(cdata) || xml.match(plain) || [])[1] || '';
  return decodeEntities(raw.trim());
}

export function parseApproxTraffic(raw) {
  const s = String(raw || '').toUpperCase().replace(/[,+\s]/g, '');
  const m = s.match(/^(\d+(?:\.\d+)?)([KM])?$/);
  if (!m) return 0;
  const num = parseFloat(m[1]);
  if (m[2] === 'M') return Math.round(num * 1_000_000);
  if (m[2] === 'K') return Math.round(num * 1_000);
  return Math.round(num);
}

/**
 * Parse Google Trends daily RSS.
 * Returns [{ title, approxTraffic, pubDate, newsItems: [{ title, snippet, source, url, pubDate }] }]
 */
export function parseTrendsRSS(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml))) {
    const block = m[1];
    const title = stripHtml(xmlTag(block, 'title'));
    if (!title) continue;

    const approxTraffic = parseApproxTraffic(xmlTag(block, 'ht:approx_traffic'));
    const itemPubDate = xmlTag(block, 'pubDate');
    const imageUrl = xmlTag(block, 'ht:picture');
    const imageSource = stripHtml(xmlTag(block, 'ht:picture_source'));
    const newsItems = [];
    const niRe = /<ht:news_item>([\s\S]*?)<\/ht:news_item>/g;
    let ni;
    while ((ni = niRe.exec(block))) {
      const niTitle = stripHtml(xmlTag(ni[1], 'ht:news_item_title'));
      const niSnippet = stripHtml(xmlTag(ni[1], 'ht:news_item_snippet'));
      const niSource = stripHtml(xmlTag(ni[1], 'ht:news_item_source'));
      const niUrl = xmlTag(ni[1], 'ht:news_item_url');
      if (niTitle || niSnippet) {
        newsItems.push({
          title: niTitle,
          snippet: niSnippet,
          source: niSource,
          url: niUrl,
          pubDate: itemPubDate,
        });
      }
    }
    items.push({ title, approxTraffic, pubDate: itemPubDate, imageUrl, imageSource, newsItems });
  }
  return items;
}

/**
 * Parse Google News search RSS.
 * Collects up to 8 recent headlines with outlet name, publish time, and link.
 */
export function parseGoogleNewsRSS(xml, limit = 8) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml))) {
    const block = m[1];
    const rawTitle = stripHtml(xmlTag(block, 'title'));
    const link = xmlTag(block, 'link');
    const pubDate = xmlTag(block, 'pubDate');
    let source = stripHtml(xmlTag(block, 'source'));
    let title = rawTitle;

    // Google News titles often end with " - Outlet Name"
    const dashIdx = rawTitle.lastIndexOf(' - ');
    if (dashIdx > 0) {
      const suffix = rawTitle.slice(dashIdx + 3).trim();
      if (!source) source = suffix;
      if (source && suffix.toLowerCase() === source.toLowerCase()) {
        title = rawTitle.slice(0, dashIdx).trim();
      }
    }

    const rawDesc = stripHtml(xmlTag(block, 'description'));
    const snippet = rawDesc && !rawDesc.toLowerCase().startsWith(title.toLowerCase()) ? rawDesc : '';
    const isStreamSpam = /\[free!*\]|\bfree\s+live\s+stream\b|\breddit\s+streams?\b|\bwatch\s+online\s+free\b/i.test(title);

    if (title && source && !isStreamSpam) {
      items.push({ title, snippet, source, url: link, pubDate });
    }
  }

  // Sort most recent first, cap at limit
  items.sort((a, b) => (Date.parse(b.pubDate || '') || 0) - (Date.parse(a.pubDate || '') || 0));
  return items.slice(0, limit);
}

const ENGLISH_NEWS_GEOS = new Set(['US', 'GB', 'CA', 'AU', 'IN', 'IE', 'NZ', 'SG', 'ZA']);

/**
 * Fetch Google News RSS localized to geo (English edition), falling back to US.
 */
export async function fetchGoogleNews(topic, geo = 'US') {
  const g = ENGLISH_NEWS_GEOS.has(String(geo || '').toUpperCase()) ? geo.toUpperCase() : 'US';
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(topic)}&hl=en-${g}&gl=${g}&ceid=${g}:en`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'TrendBot/1.0' },
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(7000) : undefined,
    });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseGoogleNewsRSS(xml, 12);
  } catch {
    return [];
  }
}

/**
 * Merge Trends news items with Google News items, deduplicate, and compute distinct outlets.
 */
export function mergeSources(trendsItems = [], googleNewsItems = []) {
  const merged = [];
  const seenKeys = new Set();

  for (const item of [...trendsItems, ...googleNewsItems]) {
    if (!item || !item.title) continue;
    const normTitle = item.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!normTitle || seenKeys.has(normTitle)) continue;
    seenKeys.add(normTitle);
    merged.push({
      title: item.title,
      snippet: item.snippet || '',
      source: (item.source || '').trim(),
      url: (item.url || '').trim(),
      pubDate: (item.pubDate || '').trim(),
    });
  }

  const distinctOutlets = [...new Set(merged.map(x => x.source).filter(Boolean))];
  const sourceUrls = [];
  const seenOutlets = new Set();
  for (const item of merged) {
    if (!item.source) continue;
    const key = item.source.toLowerCase();
    if (!seenOutlets.has(key)) {
      seenOutlets.add(key);
      sourceUrls.push({ name: item.source, url: item.url || '', title: item.title });
    }
  }

  return { items: merged.slice(0, 12), distinctOutlets, sourceUrls };
}

/**
 * Deduplicate across geos and rank candidate topics by approx_traffic (with US lead weight),
 * number of sources, and informational category intent.
 */
export function rankTopics(candidates) {
  const bySlug = new Map();
  for (const c of candidates) {
    const key = String(c.title || '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!key) continue;
    const prev = bySlug.get(key);
    if (!prev) {
      bySlug.set(key, { ...c, newsItems: [...(c.newsItems || [])] });
    } else {
      // Combine multi-country volume & news items; prefer US geo label when US matches
      prev.approxTraffic = (prev.approxTraffic || 0) + (c.approxTraffic || 0);
      prev.newsItems = [...prev.newsItems, ...(c.newsItems || [])];
      if (!prev.imageUrl && c.imageUrl) {
        prev.imageUrl = c.imageUrl;
        prev.imageSource = c.imageSource || '';
      }
      if (c.geo === 'US') {
        prev.geo = 'US';
        if (c.imageUrl) {
          prev.imageUrl = c.imageUrl;
          prev.imageSource = c.imageSource || '';
        }
      }
    }
  }

  return [...bySlug.values()]
    .map(c => {
      const text = (c.newsItems || []).map(n => `${n.title} ${n.snippet}`).join(' ');
      const category = classifyCategory(c.title, text);
      const outletCount = new Set((c.newsItems || []).map(n => n.source).filter(Boolean)).size;
      const usMultiplier = c.geo === 'US' ? 1.5 : 1.0;
      const traffic = Math.round((c.approxTraffic || 0) * usMultiplier);
      const intentBonus = PREFERRED_CATEGORIES.has(category) ? 5000 : 0;
      const score = traffic + outletCount * 10_000 + intentBonus;
      return { ...c, category, score };
    })
    .sort((a, b) => b.score - a.score);
}
