/**
 * SEO endpoints: XML Sitemap (posts + category hubs), 48h Google News Sitemap,
 * robots.txt, RSS 2.0, and IndexNow.
 */

import { slugify } from './render.js';

const esc = s => String(s || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

export function sitemapXml(posts, siteUrl) {
  let x = '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">';
  const latestMod = posts[0] ? (posts[0].updated_at || posts[0].created_at) : '';
  x += `<url><loc>${siteUrl}/</loc>${latestMod ? `<lastmod>${esc(latestMod)}</lastmod>` : ''}<changefreq>always</changefreq><priority>1.0</priority></url>`;
  x += `<url><loc>${siteUrl}/about</loc><priority>0.3</priority></url>`;

  // Include active category hubs with accurate lastmod
  const catLatest = new Map();
  for (const p of posts) {
    const cSlug = slugify(p.category || 'News');
    const mod = p.updated_at || p.created_at;
    if (!catLatest.has(cSlug) || mod > catLatest.get(cSlug)) {
      catLatest.set(cSlug, mod);
    }
  }
  for (const [cSlug, mod] of catLatest) {
    x += `<url><loc>${siteUrl}/c/${esc(cSlug)}</loc><lastmod>${esc(mod)}</lastmod><changefreq>hourly</changefreq><priority>0.7</priority></url>`;
  }

  for (const p of posts) {
    const lastmod = p.updated_at || p.created_at;
    const priority = p.extended ? '0.9' : '0.8';
    x += `<url><loc>${siteUrl}/p/${esc(p.slug)}</loc><lastmod>${esc(lastmod)}</lastmod><priority>${priority}</priority></url>`;
  }
  return x + '</urlset>';
}

/**
 * Google News sitemap — strictly limited to posts created in the last 48 hours.
 */
export function newsSitemapXml(posts, siteUrl, siteName = 'Trending Now', nowMs = Date.now()) {
  const cutoffMs = nowMs - 48 * 3600_000;
  let x = '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">';
  for (const p of posts) {
    if (Date.parse(p.created_at) < cutoffMs) continue;
    let kw = [p.category || 'News'];
    try { kw = [...kw, ...(JSON.parse(p.also_searched || '[]') || [])]; } catch {}
    const kwStr = [...new Set(kw)].filter(Boolean).slice(0, 5).join(', ');
    x += `<url><loc>${siteUrl}/p/${esc(p.slug)}</loc><news:news><news:publication><news:name>${esc(siteName)}</news:name><news:language>en</news:language></news:publication><news:publication_date>${esc(p.created_at)}</news:publication_date><news:title>${esc(p.title)}</news:title>${kwStr ? `<news:keywords>${esc(kwStr)}</news:keywords>` : ''}</news:news></url>`;
  }
  return x + '</urlset>';
}

export const robotsTxt = siteUrl =>
  `User-agent: *\nAllow: /\n\nSitemap: ${siteUrl}/sitemap.xml\nSitemap: ${siteUrl}/news-sitemap.xml\n`;

export function rssFeed(posts, siteUrl, siteName = 'Trending Now') {
  let x = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${esc(siteName)}</title><link>${siteUrl}</link><description>Live factual trending topic summaries</description>`;
  for (const p of posts) {
    const pub = new Date(p.updated_at || p.created_at).toUTCString();
    const desc = p.summary || p.body || '';
    x += `<item><title>${esc(p.title)}</title><link>${siteUrl}/p/${esc(p.slug)}</link><guid>${siteUrl}/p/${esc(p.slug)}</guid><pubDate>${pub}</pubDate><description>${esc(desc)}</description></item>`;
  }
  return x + '</channel></rss>';
}

export async function pingIndexNow(env, urls) {
  const uniqueUrls = [...new Set(urls)].filter(Boolean);
  const host = String(env.SITE_HOST || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (!env.INDEXNOW_KEY || !host || !uniqueUrls.length || String(env.DEV_MODE || '').toLowerCase() === 'true') return;
  try {
    await fetch('https://api.indexnow.org/indexnow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host,
        key: env.INDEXNOW_KEY,
        keyLocation: `https://${host}/${env.INDEXNOW_KEY}.txt`,
        urlList: uniqueUrls.slice(0, 10_000),
      }),
    });
  } catch { /* best-effort */ }
}
