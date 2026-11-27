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

const STREAM_SPAM_RE = /\[free!*\]|\bfree\s+live\s+stream\b|\breddit\s+streams?\b|\bwatch\s+online\s+free\b|\bcrackstreams\b|\bstreameast\b|\b123movies\b/i;
const NON_ENGLISH_HEADLINE_RE = /(?:^|\s)(?:en vivo|minuto a minuto|posibles alineaciones|última hora|cómo ver|dónde ver|cuándo juegan|partido de hoy|noticias de hoy|a qué hora)(?:\s|$)|[¿¡]/i;
const NON_LATIN_SCRIPT_RE = /[\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Devanagari}\p{Script=Thai}\p{Script=Hebrew}\p{Script=Greek}]/gu;

function isEnglishHeadline(text) {
  const s = String(text || '').trim();
  if (!s || NON_ENGLISH_HEADLINE_RE.test(s)) return false;
  const letters = s.match(/\p{L}/gu) || [];
  if (!letters.length) return true;
  const nonLatin = s.match(NON_LATIN_SCRIPT_RE) || [];
  return nonLatin.length / letters.length < 0.2;
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
    const rawImg = xmlTag(block, 'ht:picture');
    const imageSource = stripHtml(xmlTag(block, 'ht:picture_source'));
    const imageUrl = (rawImg && !STREAM_SPAM_RE.test(`${rawImg} ${imageSource}`)) ? rawImg : '';
    const newsItems = [];
    const niRe = /<ht:news_item>([\s\S]*?)<\/ht:news_item>/g;
    let ni;
    while ((ni = niRe.exec(block))) {
      const niTitle = stripHtml(xmlTag(ni[1], 'ht:news_item_title'));
      const niSnippet = stripHtml(xmlTag(ni[1], 'ht:news_item_snippet'));
      const niSource = stripHtml(xmlTag(ni[1], 'ht:news_item_source'));
      const niUrl = xmlTag(ni[1], 'ht:news_item_url');
      if ((niTitle || niSnippet) && !STREAM_SPAM_RE.test(niTitle) && isEnglishHeadline(`${niTitle} ${niSnippet}`)) {
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
    if (title && source && !STREAM_SPAM_RE.test(title) && isEnglishHeadline(`${title} ${snippet}`)) {
      items.push({ title, snippet, source, url: link, pubDate });
    }
  }

  // Sort most recent first, cap at limit
  items.sort((a, b) => (Date.parse(b.pubDate || '') || 0) - (Date.parse(a.pubDate || '') || 0));
  return items.slice(0, limit);
}

const ENGLISH_NEWS_GEOS = new Set(['US', 'GB', 'CA', 'AU', 'IN', 'IE', 'NZ', 'SG', 'ZA']);

const NON_PHOTO_IMG_RE = /\b(logo|icon|favicon|avatar|badge|placeholder|default[-_]?(?:og|image)|1x1|pixel|spacer|sprite|branding)\b|\.(?:svg|ico|gif)(?:\?|$)/i;

export function extractOgMetaImage(html, pageUrl = '') {
  const m =
    html.match(/<meta[^>]+(?:property=["']og:image(?::secure_url)?["']|name=["']twitter:image(?::src)?["'])[^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property=["']og:image(?::secure_url)?["']|name=["']twitter:image(?::src)?["'])/i) ||
    html.match(/<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i) ||
    html.match(/"image"\s*:\s*(?:\{\s*[^}]*"url"\s*:\s*"([^"]+)"|\[\s*"([^"]+)"|"([^"]+)")/i);
  if (!m) return '';
  let raw = decodeEntities(m[1] || m[2] || m[3] || '').trim();
  if (!raw) return '';
  try {
    if (pageUrl) raw = new URL(raw, pageUrl).toString();
  } catch { return ''; }
  raw = raw.replace(/^http:\/\//i, 'https://');
  if (!/^https:\/\//i.test(raw) || NON_PHOTO_IMG_RE.test(raw)) return '';
  return raw;
}

const normEntityTokens = s => String(s || '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/\([^)]*\)/g, ' ')
  .toLowerCase()
  .replace(/[^a-z0-9\s]/g, ' ')
  .split(/\s+/)
  .filter(w => w.length >= 2 && !['the', 'news', 'today', 'update', 'updates', 'live'].includes(w));

/**
 * Fallback to exact-entity Wikimedia Commons photo (>= 600px JPEG/PNG/WEBP)
 * when publisher pages return 403/bot-challenges or only opaque redirect links exist.
 */
export async function fetchWikiEntityImage(topic) {
  const topicWords = normEntityTokens(topic);
  if (!topicWords.length || topicWords.length > 5) return null;
  try {
    const api = `https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(topic)}&gsrlimit=2&prop=pageimages&piprop=thumbnail|original&pithumbsize=1200&format=json&origin=*`;
    const res = await fetch(api, {
      headers: { 'User-Agent': 'TrendingNowBot/1.0 (+https://trendingrightnow.online/about)' },
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(4000) : undefined,
    });
    if (!res.ok) return null;
    const data = await res.json();
    const pages = Object.values(data?.query?.pages || {}).sort((a, b) => (a.index || 9) - (b.index || 9));
    for (const page of pages) {
      const titleWords = normEntityTokens(page.title);
      if (!titleWords.length) continue;
      const overlap = topicWords.filter(w => titleWords.includes(w)).length;
      const ratio = overlap / Math.max(topicWords.length, titleWords.length);
      if (overlap < topicWords.length || ratio < 0.7) continue;
      const thumb = page.thumbnail;
      const orig = page.original;
      const picked = (thumb?.source && (thumb.width || 0) >= 600) ? thumb : ((orig?.source && (orig.width || 0) >= 600) ? orig : null);
      if (!picked?.source) continue;
      const cleanUrl = picked.source.replace(/^http:\/\//i, 'https://');
      if (!/^https:\/\//i.test(cleanUrl) || NON_PHOTO_IMG_RE.test(cleanUrl)) continue;
      if (!/\.(?:jpe?g|png|webp)(?:\?|$)/i.test(cleanUrl)) continue;
      return { imageUrl: cleanUrl, imageSource: 'Wikimedia Commons' };
    }
  } catch { /* ignore Wiki API timeouts */ }
  return null;
}

/**
 * Resolve a real high-resolution photograph (>= 12 KB) directly from publisher article URLs
 * (supporting relative/late head meta tags) or exact-match Wikimedia Commons failsafe.
 */
export async function extractHighResSourceImage(sourceUrls = [], topic = '') {
  const candidates = (Array.isArray(sourceUrls) ? sourceUrls : [])
    .filter(s => s && s.url && /^https?:\/\//i.test(s.url) && !/news\.google\.com\/rss\/articles\//i.test(s.url))
    .slice(0, 6);

  for (const src of candidates) {
    try {
      const res = await fetch(src.url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml',
        },
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(4000) : undefined,
      });
      if (!res.ok) continue;
      const reader = res.body?.getReader?.();
      let html = '';
      let imgUrl = '';
      if (reader) {
        const dec = new TextDecoder();
        while (html.length < 262144) {
          const { value, done } = await reader.read();
          if (done) break;
          html += dec.decode(value, { stream: true });
          if (html.length >= 256) imgUrl = extractOgMetaImage(html, res.url || src.url);
          if (imgUrl || html.includes('</head>')) break;
        }
        reader.cancel().catch(() => {});
      } else {
        html = (await res.text()).slice(0, 262144);
        imgUrl = extractOgMetaImage(html, res.url || src.url);
      }

      if (!imgUrl) imgUrl = extractOgMetaImage(html, res.url || src.url);
      if (!imgUrl) continue;

      const imgRes = await fetch(imgUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(4000) : undefined,
      }).catch(() => null);

      if (imgRes && imgRes.ok) {
        const ct = imgRes.headers.get('content-type') || '';
        const lenHeader = Number(imgRes.headers.get('content-length') || 0);
        let sizeOk = lenHeader >= 12000;
        if (!lenHeader && ct.startsWith('image/') && !ct.includes('svg')) {
          const ir = imgRes.body?.getReader?.();
          let got = 0;
          if (ir) {
            while (got < 12000) {
              const { value, done } = await ir.read();
              if (done) break;
              got += value?.length || 0;
            }
            ir.cancel().catch(() => {});
          } else {
            got = (await imgRes.arrayBuffer()).byteLength;
          }
          sizeOk = got >= 12000;
        } else {
          imgRes.body?.cancel?.().catch(() => {});
        }
        if (ct.startsWith('image/') && !ct.includes('svg') && sizeOk) {
          return { imageUrl: imgUrl, imageSource: src.name || '' };
        }
      }
    } catch { /* try next publisher */ }
  }
  return topic ? await fetchWikiEntityImage(topic) : null;
}

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

const CATEGORY_TRAFFIC_WEIGHTS = {
  Entertainment: 30_000,
  Sports: 22_000,
  Gaming: 20_000,
  Tech: 16_000,
  News: 8_000,
  Holidays: 5_000,
  Weather: 5_000,
  Science: 4_000,
  Business: -10_000,
};

const VIRAL_INTEREST_RE = /\b(viral|celebrity|dating|engaged|engagement|wedding|split|divorce|breakup|feud|drama|controversy|backlash|apology|interview|podcast|trailer|premiere|finale|cast|casting|actor|actress|singer|rapper|influencer|youtuber|streamer|net worth|contract|trade|record|reveal|spotted|reaction|fans react|reunion|box office|netflix|spotify|tiktok|rumor)\b/i;
const BORING_CORPORATE_RE = /\b(weighted index|stock index|nifty|sensex|asx|ftse|nikkei|bond yield|basis point|treasury yield|quarterly filing|dividend|share price|shareholder|holiday hours|store hours|opening hours|bank holiday|wind project|battery project|project abandonment|tariff schedule|exchange rate|ppi|cpi)\b/i;
const CONSUMER_BUSINESS_RE = /\b(black friday|cyber monday|deal|sale|discount|iphone|apple|tesla|amazon|netflix|bitcoin|crypto|ai|layoffs)\b/i;

/**
 * Deduplicate across geos and rank candidate topics by approx_traffic (with US lead weight),
 * multi-outlet breadth, and high-CTR viral entertainment/sports/pop-culture priority.
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
      const combined = `${c.title} ${text}`;
      const category = classifyCategory(c.title, text);
      const outletCount = new Set((c.newsItems || []).map(n => n.source).filter(Boolean)).size;
      const usMultiplier = c.geo === 'US' ? 1.5 : 1.0;
      const traffic = Math.round((c.approxTraffic || 0) * usMultiplier);
      let intentBonus = CATEGORY_TRAFFIC_WEIGHTS[category] ?? 0;
      if (category === 'Business' && CONSUMER_BUSINESS_RE.test(combined)) intentBonus = 12_000;
      if (VIRAL_INTEREST_RE.test(combined)) intentBonus += 45_000;
      if (BORING_CORPORATE_RE.test(combined) && (c.approxTraffic || 0) < 200_000) intentBonus -= 45_000;
      const score = traffic + outletCount * 10_000 + intentBonus;
      return { ...c, category, score };
    })
    .sort((a, b) => b.score - a.score);
}
