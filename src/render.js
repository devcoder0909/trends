/**
 * Server-rendered HTML templates, inline CSS (< 1.5KB), JSON-LD schemas,
 * category hubs, dark mode, relative timestamps, and ultra-SEO markup.
 */

export const esc = s => String(s || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

export const slugify = s =>
  String(s || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);

// Inline CSS (~1,190 bytes < 1.5KB) — 680px width, 18px font, 1.6 line-height, dark mode
export const CSS = `*{margin:0;padding:0;box-sizing:border-box}body{font:18px/1.6 system-ui,-apple-system,sans-serif;max-width:680px;margin:0 auto;padding:1.25rem 1rem;color:#111;background:#fff}h1{font-size:1.55rem;line-height:1.25;margin:.35rem 0 .6rem}h2{font-size:1.2rem;line-height:1.3;margin:.9rem 0 .35rem}h3{font-size:1.05rem;margin:1.1rem 0 .4rem}p{margin:.6rem 0}ul{padding-left:1.3rem;margin:.5rem 0}li{margin:.3rem 0}a{color:#0b57d0}a:visited{color:#681da8}.meta,.s,time{color:#555;font-size:.85rem}.cat{display:inline-block;font-size:.75rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:#444;border:1px solid #ccc;border-radius:3px;padding:0 .35rem;text-decoration:none}.sum{font-weight:600}.upd{border-left:3px solid #0b57d0;padding-left:.65rem;font-size:.95rem}article{margin:1.5rem 0;padding-bottom:1.4rem;border-bottom:1px solid #e5e5e5}nav{margin:1.2rem 0}footer{margin-top:2rem;padding-top:1rem;border-top:1px solid #ddd;font-size:.82rem;color:#555}@media(prefers-color-scheme:dark){body{background:#121212;color:#eaeaea}a{color:#8ab4f8}a:visited{color:#c58af9}.meta,.s,time,footer{color:#aaa}.cat{color:#ccc;border-color:#555}article{border-color:#2c2c2c}footer{border-color:#333}.upd{border-color:#8ab4f8}}`;

export function timeAgo(iso, nowMs = Date.now()) {
  const diffSec = Math.max(0, Math.floor((nowMs - Date.parse(iso)) / 1000));
  if (diffSec < 60) return 'just now';
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function expiresInLabel(expiresIso, nowMs = Date.now()) {
  const hours = Math.max(1, Math.ceil((Date.parse(expiresIso) - nowMs) / 3600_000));
  return `Expires in ${hours} hour${hours === 1 ? '' : 's'}`;
}

function parseJsonField(raw, fallback) {
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw || '') ?? fallback; } catch { return fallback; }
}

/**
 * Build optimal 120-158 char meta description from summary + lead context.
 */
export function buildMetaDescription(post) {
  const summary = String(post.summary || post.body || post.title || '').trim();
  const what = String(post.what_happened || '').trim();
  let combined = summary;
  if (combined.length < 120 && what && !what.startsWith(summary)) {
    combined = `${summary} ${what}`.replace(/\s+/g, ' ').trim();
  }
  if (combined.length <= 158) return combined;
  return combined.slice(0, 154).replace(/\s+\S*$/, '').replace(/[,;:\s]+$/, '') + '...';
}

function hreflangLinks(canon, geos = []) {
  if (!geos || geos.length <= 1) return '';
  return geos
    .map(g => `<link rel="alternate" hreflang="en-${esc(g.toLowerCase())}" href="${canon}">`)
    .join('') + `<link rel="alternate" hreflang="x-default" href="${canon}">`;
}

function htmlHead(title, desc, canon, geos = [], extra = '', ogType = 'article') {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><meta name="description" content="${esc(desc)}"><link rel="canonical" href="${canon}">${hreflangLinks(canon, geos)}<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${canon}"><meta property="og:type" content="${ogType}"><meta name="twitter:card" content="summary"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}"><link rel="alternate" type="application/rss+xml" title="RSS" href="/rss.xml"><link rel="sitemap" type="application/xml" title="Sitemap" href="/sitemap.xml">${extra}<style>${CSS}</style></head><body>`;
}

function htmlFoot(email) {
  return `<footer><p>Auto-generated summaries from public trend data. Sources listed. Content expires after 48 hours unless extended by search demand.</p><p>Contact: <a href="mailto:${esc(email)}">${esc(email)}</a> · <a href="/about">About</a> · <a href="/rss.xml">RSS</a> · <a href="/sitemap.xml">Sitemap</a></p></footer></body></html>`;
}

function findMatchingLiveLinks(post, livePosts) {
  const phrases = parseJsonField(post.also_searched, []);
  const matches = [];
  const usedSlugs = new Set([post.slug]);

  for (const phrase of phrases) {
    const words = String(phrase).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2);
    if (!words.length) continue;
    const hit = livePosts.find(other => {
      if (usedSlugs.has(other.slug)) return false;
      const hay = `${other.topic} ${other.title} ${other.slug}`.toLowerCase();
      return hay.includes(phrase.toLowerCase()) || words.filter(w => hay.includes(w)).length >= Math.min(2, words.length);
    });
    if (hit) {
      usedSlugs.add(hit.slug);
      matches.push({ phrase, slug: hit.slug, title: hit.title });
    }
  }
  return matches;
}

function renderSourcesList(post, linkOut = true) {
  const sourceObjs = parseJsonField(post.source_urls, []);
  if (sourceObjs.length && linkOut) {
    const items = sourceObjs
      .map(s => {
        const label = s.title ? `${esc(s.name)} — ${esc(s.title)}` : esc(s.name);
        return s.url
          ? `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${label}</a></li>`
          : `<li>${label}</li>`;
      })
      .join('');
    return `<h2>Sources</h2><ul>${items}</ul>`;
  }
  return `<p class="s"><strong>Sources:</strong> ${esc(post.sources)}</p>`;
}

function renderPostBody(post, livePosts, nowMs, { isHome = false } = {}) {
  const summary = post.summary || '';
  const whatHappened = post.what_happened || post.body || '';
  const whyTrending = post.why_trending || '';
  const keyFacts = parseJsonField(post.key_facts || post.bullets, []);
  const whatNext = post.what_to_know_next || '';
  const updates = parseJsonField(post.updates_json, []);
  const alsoMatches = findMatchingLiveLinks(post, livePosts);

  let h = '';
  if (summary) h += `<p class="sum">${esc(summary)}</p>`;
  if (whatHappened) {
    if (!isHome) h += '<h2>What Happened</h2>';
    h += `<p>${esc(whatHappened)}</p>`;
  }
  if (whyTrending) {
    if (!isHome) h += '<h2>Why It Is Trending</h2>';
    h += `<p>${esc(whyTrending)}</p>`;
  }
  if (keyFacts.length) {
    if (!isHome) h += '<h2>Key Facts</h2>';
    h += '<ul>' + keyFacts.map(f => `<li>${esc(f)}</li>`).join('') + '</ul>';
  }
  if (whatNext) {
    if (!isHome) h += '<h2>What to Know Next</h2>';
    h += `<p>${esc(whatNext)}</p>`;
  }
  for (const u of updates) {
    h += `<p class="upd"><strong>Update (${timeAgo(u.time, nowMs)}):</strong> ${esc(u.text)}</p>`;
  }
  if (alsoMatches.length) {
    const links = alsoMatches.map(m => `<a href="/p/${esc(m.slug)}">${esc(m.phrase)}</a>`).join(' · ');
    h += `<p class="s"><strong>Related searches:</strong> ${links}</p>`;
  }
  h += renderSourcesList(post, !isHome);
  return h;
}

export function homePage(posts, settings, siteUrl, nowMs = Date.now()) {
  const desc = 'Live factual summaries of trending topics, updated every minute from verified public news sources and auto-cleaned after 48 hours.';
  const ld = JSON.stringify([
    {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: settings.siteName,
      url: `${siteUrl}/`,
      description: desc,
      inLanguage: 'en',
    },
    {
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      itemListElement: posts.map((p, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        url: `${siteUrl}/p/${p.slug}`,
        name: p.title,
      })),
    },
  ]).replace(/<\//g, '<\\/');

  let h = htmlHead(
    `${settings.siteName} — Live Factual Trend Summaries`,
    desc,
    `${siteUrl}/`,
    settings.geos,
    `<script type="application/ld+json">${ld}</script>`,
    'website'
  );
  h += `<header><h1><a href="/" style="color:inherit;text-decoration:none">${esc(settings.siteName)}</a></h1><p class="meta">${esc(desc)}</p></header><main>`;

  for (const p of posts) {
    const cat = p.category || 'News';
    const catSlug = slugify(cat);
    const relTime = timeAgo(p.created_at, nowMs);
    h += `<article id="${esc(p.slug)}">`;
    h += `<a class="cat" href="/c/${esc(catSlug)}">${esc(cat)}</a>`;
    h += `<h2><a href="/p/${esc(p.slug)}">${esc(p.title)}</a></h2>`;
    h += `<p class="meta"><time datetime="${esc(p.created_at)}">${relTime}</time>`;
    if (p.updated_at && p.updated_at !== p.created_at) {
      h += ` · Updated ${timeAgo(p.updated_at, nowMs)}`;
    }
    h += `</p>`;
    h += renderPostBody(p, posts, nowMs, { isHome: true });
    h += `</article>`;
  }

  if (!posts.length) h += '<p>No active trends right now. Check back soon.</p>';
  return h + '</main>' + htmlFoot(settings.contactEmail);
}

export function categoryPage(categoryName, posts, settings, siteUrl, nowMs = Date.now()) {
  const catSlug = slugify(categoryName);
  const canon = `${siteUrl}/c/${catSlug}`;
  const desc = `Latest live ${categoryName.toLowerCase()} trend summaries from verified news outlets, updated every minute on ${settings.siteName}.`;
  const title = `${categoryName} Trends — ${settings.siteName}`.slice(0, 60);

  const ld = JSON.stringify([
    {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: `${categoryName} Trends`,
      url: canon,
      description: desc,
      inLanguage: 'en',
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: `${siteUrl}/` },
        { '@type': 'ListItem', position: 2, name: categoryName, item: canon },
      ],
    },
    {
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      itemListElement: posts.map((p, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        url: `${siteUrl}/p/${p.slug}`,
        name: p.title,
      })),
    },
  ]).replace(/<\//g, '<\\/');

  let h = htmlHead(title, desc, canon, settings.geos, `<script type="application/ld+json">${ld}</script>`, 'website');
  h += `<main><p><a href="/">← All Trends</a></p><h1>${esc(categoryName)} Trends</h1><p class="meta">${esc(desc)}</p>`;
  for (const p of posts) {
    h += `<article id="${esc(p.slug)}"><h2><a href="/p/${esc(p.slug)}">${esc(p.title)}</a></h2>`;
    h += `<p class="meta"><time datetime="${esc(p.created_at)}">${timeAgo(p.created_at, nowMs)}</time></p>`;
    h += renderPostBody(p, posts, nowMs, { isHome: true });
    h += `</article>`;
  }
  if (!posts.length) h += `<p>No active ${esc(categoryName.toLowerCase())} trends right now. <a href="/">View all trends</a>.</p>`;
  return h + `<p><a href="/">← Back to all trends</a></p></main>` + htmlFoot(settings.contactEmail);
}

export function postPage(post, related, livePosts, settings, siteUrl, nowMs = Date.now()) {
  const cat = post.category || 'News';
  const catSlug = slugify(cat);
  const desc = buildMetaDescription(post);
  const title = post.title.length <= 60 ? post.title : post.title.slice(0, 57).replace(/\s+\S*$/, '') + '...';
  const canon = `${siteUrl}/p/${post.slug}`;
  const dateModified = post.updated_at || post.created_at;
  const keywords = [post.topic, cat, ...parseJsonField(post.also_searched, [])].filter(Boolean).join(', ');

  const newsLd = {
    '@context': 'https://schema.org',
    '@type': 'NewsArticle',
    headline: post.title,
    datePublished: post.created_at,
    dateModified,
    description: desc,
    articleSection: cat,
    keywords,
    inLanguage: 'en',
    isAccessibleForFree: true,
    speakable: { '@type': 'SpeakableSpecification', cssSelector: ['h1', '.sum'] },
    mainEntityOfPage: canon,
    author: { '@type': 'Organization', name: settings.siteName, url: siteUrl },
    publisher: { '@type': 'Organization', name: settings.siteName, url: siteUrl },
  };
  const breadcrumbLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${siteUrl}/` },
      { '@type': 'ListItem', position: 2, name: cat, item: `${siteUrl}/c/${catSlug}` },
      { '@type': 'ListItem', position: 3, name: post.title, item: canon },
    ],
  };

  const ldScripts = `<script type="application/ld+json">${JSON.stringify([newsLd, breadcrumbLd]).replace(/<\//g, '<\\/')}</script>`;

  let h = htmlHead(title, desc, canon, settings.geos, ldScripts);
  h += `<main><p><a href="/">← All Trends</a> · <a href="/c/${esc(catSlug)}">${esc(cat)}</a></p>`;
  h += `<article id="${esc(post.slug)}">`;
  h += `<a class="cat" href="/c/${esc(catSlug)}">${esc(cat)}</a>`;
  h += `<h1>${esc(post.title)}</h1>`;
  h += `<p class="meta">Published <time datetime="${esc(post.created_at)}">${timeAgo(post.created_at, nowMs)}</time>`;
  if (post.updated_at && post.updated_at !== post.created_at) {
    h += ` · Updated <time datetime="${esc(post.updated_at)}">${timeAgo(post.updated_at, nowMs)}</time>`;
  }
  h += ` · ${expiresInLabel(post.expires_at, nowMs)}</p>`;
  h += renderPostBody(post, livePosts, nowMs, { isHome: false });
  h += `</article>`;

  if (related.length) {
    h += '<nav><h2>More trending now</h2><ul>';
    for (const r of related) {
      const rCat = r.category || 'News';
      h += `<li><a class="cat" href="/c/${esc(slugify(rCat))}">${esc(rCat)}</a> <a href="/p/${esc(r.slug)}">${esc(r.title)}</a></li>`;
    }
    h += '</ul></nav>';
  }
  h += `<p><a href="/">← Back to all trends</a></p></main>` + htmlFoot(settings.contactEmail);
  return h;
}

export function aboutPage(settings, siteUrl) {
  return htmlHead(
    `About — ${settings.siteName}`,
    'How this ephemeral, source-grounded trend summary site works and verifies every public news claim.',
    `${siteUrl}/about`,
    settings.geos,
    '',
    'website'
  ) +
    `<main><p><a href="/">← All Trends</a></p><h1>About ${esc(settings.siteName)}</h1>` +
    `<p>This site publishes short, factual summaries of trending search topics using only headlines and snippets from Google Trends and Google News RSS feeds.</p>` +
    `<ul><li>Every fact, number, and date is checked against listed news outlets before publishing.</li>` +
    `<li>Posts expire automatically after 48 hours unless readers from search engines show ongoing interest (extended up to 7 days, then deleted).</li>` +
    `<li>Sensitive topics, rumors, and single-outlet stories are filtered out.</li>` +
    `<li>No personal data, IP addresses, ads, or analytics scripts are used.</li>` +
    `<li>Contact: <a href="mailto:${esc(settings.contactEmail)}">${esc(settings.contactEmail)}</a></li></ul></main>` +
    htmlFoot(settings.contactEmail);
}

export const gonePage = () =>
  `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,follow"><title>Post Expired</title><style>${CSS}</style></head><body><main><h1>This post has expired</h1><p>Content on this site is automatically removed after its lifetime ends.</p><p><a href="/">← View current trends</a></p></main></body></html>`;

export const endedPage = () =>
  `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Site Ended</title><style>${CSS}</style></head><body><main><h1>This site has ended</h1><p>This ephemeral trend site has concluded its run and all posts have expired.</p></main></body></html>`;
