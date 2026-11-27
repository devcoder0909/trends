/**
 * SEO endpoints & instant indexing:
 * - XML Sitemap with <image:image>, 48h Google News Sitemap, rich RSS 2.0 (<content:encoded> & <media:content>)
 * - Search & AI-Search friendly robots.txt + dynamic /llms.txt
 * - IndexNow (Bing, Yandex, DuckDuckGo), WebSub (Google PubSubHubbub), Google Indexing API v3
 */

import { slugify, NAV_CATEGORIES } from './render.js';
import { stripInlineSourceTags } from './config.js';

const esc = s => String(s || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const timeoutSig = (ms = 7000) =>
  (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);

let cachedGoogleToken = null;
let cachedGoogleTokenExp = 0;

export function sitemapXml(posts, siteUrl) {
  let x = '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">';
  const latestMod = posts[0] ? (posts[0].updated_at || posts[0].created_at) : '';
  x += `<url><loc>${siteUrl}/</loc>${latestMod ? `<lastmod>${esc(latestMod)}</lastmod>` : ''}<changefreq>always</changefreq><priority>1.0</priority><image:image><image:loc>${siteUrl}/og.png</image:loc><image:title>Trending Now</image:title></image:image></url>`;
  x += `<url><loc>${siteUrl}/about</loc><priority>0.3</priority></url>`;

  const catLatest = new Map();
  for (const p of posts) {
    const cSlug = slugify(p.category || 'News');
    const mod = p.updated_at || p.created_at;
    if (!catLatest.has(cSlug) || mod > catLatest.get(cSlug)) catLatest.set(cSlug, mod);
  }
  for (const [cSlug, mod] of catLatest) {
    x += `<url><loc>${siteUrl}/c/${esc(cSlug)}</loc><lastmod>${esc(mod)}</lastmod><changefreq>hourly</changefreq><priority>0.7</priority></url>`;
  }

  for (const p of posts) {
    const lastmod = p.updated_at || p.created_at;
    const priority = p.extended ? '0.9' : '0.8';
    const imgLoc = `${siteUrl}/i/${esc(p.slug)}.jpg`;
    x += `<url><loc>${siteUrl}/p/${esc(p.slug)}</loc><lastmod>${esc(lastmod)}</lastmod><priority>${priority}</priority><image:image><image:loc>${esc(imgLoc)}</image:loc><image:title>${esc(p.title)}</image:title></image:image></url>`;
  }
  return x + '</urlset>';
}

export function newsSitemapXml(posts, siteUrl, siteName = 'Trending Now', nowMs = Date.now()) {
  const cutoffMs = nowMs - 48 * 3600_000;
  let x = '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">';
  let count = 0;
  for (const p of posts) {
    if (Date.parse(p.created_at) < cutoffMs) continue;
    x += `<url><loc>${siteUrl}/p/${esc(p.slug)}</loc><news:news><news:publication><news:name>${esc(siteName)}</news:name><news:language>en</news:language></news:publication><news:publication_date>${esc(p.created_at)}</news:publication_date><news:title>${esc(p.title)}</news:title></news:news><image:image><image:loc>${siteUrl}/i/${esc(p.slug)}.jpg</image:loc><image:title>${esc(p.title)}</image:title></image:image></url>`;
    count++;
  }
  if (count === 0) {
    x += `<url><loc>${siteUrl}/</loc><lastmod>${new Date(nowMs).toISOString()}</lastmod></url>`;
  }
  return x + '</urlset>';
}

export const robotsTxt = siteUrl => [
  'User-agent: *',
  'Allow: /',
  'Disallow: /search',
  'Content-Signal: search=yes, ai-input=yes',
  '',
  'User-agent: Googlebot',
  'Allow: /',
  '',
  'User-agent: Googlebot-News',
  'Allow: /',
  '',
  'User-agent: Googlebot-Image',
  'Allow: /',
  '',
  'User-agent: OAI-SearchBot',
  'Allow: /',
  'Content-Signal: search=yes, ai-input=yes',
  '',
  'User-agent: Claude-SearchBot',
  'Allow: /',
  'Content-Signal: search=yes, ai-input=yes',
  '',
  'User-agent: PerplexityBot',
  'Allow: /',
  'Content-Signal: search=yes, ai-input=yes',
  '',
  'User-agent: Applebot',
  'Allow: /',
  '',
  'User-agent: Bingbot',
  'Allow: /',
  '',
  `Sitemap: ${siteUrl}/sitemap.xml`,
  `Sitemap: ${siteUrl}/news-sitemap.xml`,
  '',
].join('\n');

export function llmsTxt(posts, siteUrl, siteName = 'Trending Now') {
  const lines = [
    `# ${siteName}`,
    '',
    `> Real-time source-grounded factual briefings on trending search topics across sports, tech, business, science, entertainment, and news. Updated every minute from verified public outlets.`,
    '',
    '## Feeds & Sitemaps',
    `- [XML Sitemap](${siteUrl}/sitemap.xml): All live briefings and category hubs`,
    `- [Google News Sitemap](${siteUrl}/news-sitemap.xml): Breaking briefings from the last 48 hours`,
    `- [RSS 2.0 Feed](${siteUrl}/rss.xml): Full factual briefing stream`,
    '',
    '## Categories',
    ...NAV_CATEGORIES.map(c => `- [${c}](${siteUrl}/c/${slugify(c)}): Latest verified ${c.toLowerCase()} briefings`),
    '',
    '## Latest Live Briefings',
    ...posts.slice(0, 20).map(p => `- [${p.title}](${siteUrl}/p/${p.slug}): ${stripInlineSourceTags(p.summary || p.what_happened || '', p.sources)}`),
    '',
  ];
  return lines.join('\n');
}

export function rssFeed(posts, siteUrl, siteName = 'Trending Now') {
  let x = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>${esc(siteName)}</title><link>${siteUrl}</link><atom:link rel="hub" href="https://pubsubhubbub.appspot.com/"/><atom:link rel="self" type="application/rss+xml" href="${siteUrl}/rss.xml"/><description>Live factual trending topic summaries verified across multiple public news sources</description><language>en</language>`;
  for (const p of posts) {
    const pub = new Date(p.updated_at || p.created_at).toUTCString();
    const desc = stripInlineSourceTags(p.summary || p.body || '', p.sources);
    const whatHappened = stripInlineSourceTags(p.what_happened || '', p.sources);
    const whyTrending = stripInlineSourceTags(p.why_trending || '', p.sources);
    const cat = esc(p.category || 'News');
    const imgUrl = `${siteUrl}/i/${esc(p.slug)}.jpg`;
    let facts = [];
    try { facts = (JSON.parse(p.key_facts || p.bullets || '[]') || []).map(f => stripInlineSourceTags(f, p.sources)).filter(Boolean); } catch {}
    const fullHtml = `<p>${esc(desc)}</p>${whatHappened ? `<p>${esc(whatHappened)}</p>` : ''}${whyTrending ? `<p>${esc(whyTrending)}</p>` : ''}${facts.length ? `<ul>${facts.map(f => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}<p>Sources: ${esc(p.sources || '')}</p>`;
    x += `<item><title>${esc(p.title)}</title><link>${siteUrl}/p/${esc(p.slug)}</link><guid>${siteUrl}/p/${esc(p.slug)}</guid><category>${cat}</category><pubDate>${pub}</pubDate><description>${esc(desc)}</description><content:encoded><![CDATA[${fullHtml.replace(/\]\]>/g, ']]&gt;')}]]></content:encoded><media:content url="${esc(imgUrl)}" medium="image"/><enclosure url="${esc(imgUrl)}" type="image/jpeg" length="8000"/></item>`;
  }
  return x + '</channel></rss>';
}

export async function pingIndexNow(env, urls) {
  const uniqueUrls = [...new Set(urls)].filter(Boolean);
  const host = String(env.SITE_HOST || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (!env.INDEXNOW_KEY || !host || !uniqueUrls.length || String(env.DEV_MODE || '').toLowerCase() === 'true') {
    return { skipped: true };
  }
  const urlList = uniqueUrls.slice(0, 10_000);
  const payload = JSON.stringify({
    host,
    key: env.INDEXNOW_KEY,
    keyLocation: `https://${host}/${env.INDEXNOW_KEY}.txt`,
    urlList,
  });
  for (const endpoint of ['https://api.indexnow.org/indexnow', 'https://www.bing.com/indexnow']) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        signal: timeoutSig(7000),
        body: payload,
      });
      if (res.ok) return { ok: true, status: res.status, count: urlList.length };
      if (res.status !== 429 && res.status < 500) {
        console.error('IndexNow HTTP', res.status);
        return { ok: false, status: res.status, count: urlList.length };
      }
    } catch (err) {
      console.error('IndexNow error:', err.message);
    }
  }
  return { ok: false, status: 429, count: urlList.length };
}

export async function pingWebSub(env, siteUrl) {
  if (String(env.DEV_MODE || '').toLowerCase() === 'true') return { skipped: true };
  try {
    const res = await fetch('https://pubsubhubbub.appspot.com/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: timeoutSig(7000),
      body: `hub.mode=publish&hub.url=${encodeURIComponent(`${siteUrl}/rss.xml`)}`,
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
}

function b64url(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getGoogleAccessToken(serviceAccountJson) {
  const nowSec = Math.floor(Date.now() / 1000);
  if (cachedGoogleToken && nowSec < cachedGoogleTokenExp - 60) return cachedGoogleToken;

  const sa = typeof serviceAccountJson === 'string' ? JSON.parse(serviceAccountJson) : serviceAccountJson;
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/indexing',
    aud: 'https://oauth2.googleapis.com/token',
    iat: nowSec,
    exp: nowSec + 3600,
  }));

  const pemBody = sa.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  const binary = atob(pemBody);
  const keyBytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) keyBytes[i] = binary.charCodeAt(i);

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    keyBytes.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const unsigned = `${header}.${claim}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${b64url(sig)}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    signal: timeoutSig(7000),
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${encodeURIComponent(jwt)}`,
  });
  if (!res.ok) throw new Error(`Google OAuth HTTP ${res.status}`);
  const data = await res.json();
  cachedGoogleToken = data.access_token;
  cachedGoogleTokenExp = nowSec + (data.expires_in || 3600);
  return cachedGoogleToken;
}

/**
 * Notify Google Search Indexing API v3 when GOOGLE_INDEXING_KEY secret is set.
 * Runs concurrently for instant notification velocity.
 */
export async function pingGoogleIndexing(env, urls, type = 'URL_UPDATED') {
  const uniqueUrls = [...new Set(urls)].filter(Boolean);
  const filtered = type === 'URL_UPDATED' ? uniqueUrls.filter(u => u.includes('/p/')) : uniqueUrls;
  const targets = filtered.slice(0, 10);
  if (!env.GOOGLE_INDEXING_KEY || !targets.length || String(env.DEV_MODE || '').toLowerCase() === 'true') {
    return { skipped: true };
  }
  let okCount = 0;
  let failCount = 0;
  let lastStatus = 0;
  let lastError = '';
  try {
    const token = await getGoogleAccessToken(env.GOOGLE_INDEXING_KEY);
    await Promise.allSettled(
      targets.map(async url => {
        const res = await fetch('https://indexing.googleapis.com/v3/urlNotifications:publish', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          signal: timeoutSig(7000),
          body: JSON.stringify({ url, type }),
        });
        lastStatus = res.status;
        if (res.ok) {
          okCount++;
        } else {
          failCount++;
          lastError = (await res.text()).slice(0, 200);
          console.error('Google Indexing HTTP', res.status, url, lastError);
        }
      })
    );
  } catch (err) {
    failCount = targets.length;
    lastError = String(err.message || err).slice(0, 200);
    console.error('Google Indexing error:', err.message);
  }
  return { okCount, failCount, lastStatus, lastError, sent: targets.length };
}
