/**
 * Server-rendered HTML templates, inline CSS (< 1.5KB), JSON-LD schemas,
 * category hubs, relative timestamps, and Google News dark cluster UI.
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

// Inline CSS (< 1.5KB) — Google News dark theme (#202124 / #292a2d / #8ab4f8)
export const CSS = `*{margin:0;padding:0;box-sizing:border-box}body{font:15px/1.45 system-ui,sans-serif;color:#e8eaed;background:#202124}header,article{border-bottom:1px solid #3c4043}header{padding:.5rem 1rem 0}.w,main,footer{max-width:780px;margin:0 auto}main,footer{padding:.7rem}.b{font-size:1.2rem;font-weight:600}.b,h2 a,nav a,.p,.sum{color:#e8eaed}.b b,.k,a,.t a.on,.t a:hover,h2 a:hover{color:#8ab4f8}.t{display:flex;flex-wrap:wrap;gap:0 .9rem;margin-top:.3rem;font-size:.82rem}.t a{color:#9aa0a6;padding:.3rem 0;border-bottom:3px solid transparent}.t a.on,.t a:hover{border-color:#8ab4f8}.hd i{width:10px;height:10px;border-radius:5px;background:#5bb974;display:inline-block;margin-right:.4rem}.c{background:#292a2d;border-radius:14px;padding:.15rem .95rem;margin-bottom:.7rem}article{padding:.65rem 0}article:last-child{border:0}h1,h2,.hd{font-weight:500;margin:.18rem 0 .35rem}h1,.hd{font-size:1.24rem}h2{font-size:1.04rem}p,ul{margin:.3rem 0;color:#bdc1c6}ul{padding-left:1.1rem}li{margin:.15rem 0}a{text-decoration:none}.m,.s,.sec,footer{color:#9aa0a6;font-size:.78rem}.sec{text-transform:uppercase;margin:.55rem 0 .2rem}.k{font-weight:600}.sum,.u{border-left:2px solid #8ab4f8;padding-left:.5rem}.u{border-color:#fdd663;font-size:.88rem}.p{display:block;text-align:center;background:#303134;border:1px solid #3c4043;border-radius:99px;padding:.28rem;margin-top:.5rem;font-size:.8rem}@media(min-width:640px){.r{display:grid;grid-template-columns:1.2fr 1fr;gap:.9rem}.d{border-left:1px solid #3c4043;padding-left:.85rem}}`;

export function timeAgo(iso, nowMs = Date.now()) {
  const diffSec = Math.max(0, Math.floor((nowMs - Date.parse(iso)) / 1000));
  if (diffSec < 60) return 'just now';
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
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
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>${esc(title)}</title><meta name="description" content="${esc(desc)}"><link rel="canonical" href="${canon}">${hreflangLinks(canon, geos)}<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${canon}"><meta property="og:type" content="${ogType}"><meta name="twitter:card" content="summary"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}"><link rel="alternate" type="application/rss+xml" title="RSS" href="/rss.xml"><link rel="sitemap" type="application/xml" title="Sitemap" href="/sitemap.xml">${extra}<style>${CSS}</style></head><body>`;
}

function siteHeader(siteName, activeTab = 'home') {
  const parts = String(siteName || 'Trending Now').trim().split(/\s+/);
  const brandHtml = parts.length > 1
    ? `<b>${esc(parts[0])}</b> ${esc(parts.slice(1).join(' '))}`
    : `<b>${esc(siteName)}</b>`;
  const cats = ['Sports', 'Tech', 'Entertainment', 'Business', 'Science', 'Weather', 'Gaming'];
  const tab = (slug, label, href) =>
    `<a${activeTab === slug ? ' class="on"' : ''} href="${href}">${label}</a>`;
  const navLinks = tab('home', 'Home', '/') + cats.map(c => tab(slugify(c), c, `/c/${slugify(c)}`)).join('');
  return `<header><div class="w"><a class="b" href="/">${brandHtml}</a><div class="t" role="navigation" aria-label="Categories">${navLinks}</div></div></header>`;
}

function htmlFoot(email) {
  return `<footer><p>Factual briefings from public news sources · <a href="mailto:${esc(email)}">${esc(email)}</a> · <a href="/about">About</a> · <a href="/rss.xml">RSS</a> · <a href="/sitemap.xml">Sitemap</a></p></footer></body></html>`;
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
    return `<h2 class="sec">Sources</h2><ul>${items}</ul>`;
  }
  return `<p class="s"><strong>Sources:</strong> ${esc(post.sources)}</p>`;
}

function renderClusterArticle(p, livePosts, nowMs, showCategory = true) {
  const cat = p.category || 'News';
  const catSlug = slugify(cat);
  const relTime = timeAgo(p.created_at, nowMs);
  const summary = p.summary || '';
  const whatHappened = p.what_happened || p.body || '';
  const whyTrending = p.why_trending || '';
  const keyFacts = parseJsonField(p.key_facts || p.bullets, []);
  const whatNext = p.what_to_know_next || '';
  const updates = parseJsonField(p.updates_json, []);
  const alsoMatches = findMatchingLiveLinks(p, livePosts);

  let left = '';
  left += `<p class="m">${showCategory ? `<a class="k" href="/c/${esc(catSlug)}">${esc(cat)}</a> · ` : ''}<time datetime="${esc(p.created_at)}">${relTime}</time>`;
  if (p.updated_at && p.updated_at !== p.created_at) left += ` · Updated ${timeAgo(p.updated_at, nowMs)}`;
  left += `</p><h2><a href="/p/${esc(p.slug)}">${esc(p.title)}</a></h2>`;
  if (summary) left += `<p class="sum">${esc(summary)}</p>`;
  if (whatHappened) left += `<p>${esc(whatHappened)}</p>`;
  if (whyTrending) left += `<p>${esc(whyTrending)}</p>`;
  if (whatNext) left += `<p>${esc(whatNext)}</p>`;
  for (const u of updates) {
    left += `<p class="u"><strong>Update (${timeAgo(u.time, nowMs)}):</strong> ${esc(u.text)}</p>`;
  }

  let right = '';
  if (keyFacts.length) {
    right += '<h2 class="sec" style="margin-top:0">Key facts &amp; perspectives</h2><ul>' +
      keyFacts.map(f => `<li>${esc(f)}</li>`).join('') + '</ul>';
  }
  if (alsoMatches.length) {
    const links = alsoMatches.map(m => `<a href="/p/${esc(m.slug)}">${esc(m.phrase)}</a>`).join(' · ');
    right += `<p class="s"><strong>Related:</strong> ${links}</p>`;
  }
  right += renderSourcesList(p, false);

  return `<article id="${esc(p.slug)}"><div class="r"><div>${left}</div><div class="d">${right}</div></div><a class="p" href="/p/${esc(p.slug)}">See full briefing &amp; sources</a></article>`;
}

function renderPostBody(post, livePosts, nowMs) {
  const summary = post.summary || '';
  const whatHappened = post.what_happened || post.body || '';
  const whyTrending = post.why_trending || '';
  const keyFacts = parseJsonField(post.key_facts || post.bullets, []);
  const whatNext = post.what_to_know_next || '';
  const updates = parseJsonField(post.updates_json, []);
  const alsoMatches = findMatchingLiveLinks(post, livePosts);

  let h = '';
  if (summary) h += `<p class="sum">${esc(summary)}</p>`;
  if (whatHappened) h += '<h2 class="sec">What Happened</h2>' + `<p>${esc(whatHappened)}</p>`;
  if (whyTrending) h += `<h2 class="sec">Why ${esc(post.topic || 'This')} Is Trending</h2><p>${esc(whyTrending)}</p>`;
  if (keyFacts.length) h += '<h2 class="sec">Key Facts</h2><ul>' + keyFacts.map(f => `<li>${esc(f)}</li>`).join('') + '</ul>';
  if (whatNext) h += `<h2 class="sec">What to Know Next</h2><p>${esc(whatNext)}</p>`;
  for (const u of updates) h += `<p class="u"><strong>Update (${timeAgo(u.time, nowMs)}):</strong> ${esc(u.text)}</p>`;
  if (alsoMatches.length) {
    const links = alsoMatches.map(m => `<a href="/p/${esc(m.slug)}">${esc(m.phrase)}</a>`).join(' · ');
    h += `<p class="s"><strong>Related:</strong> ${links}</p>`;
  }
  h += renderSourcesList(post, true);
  return h;
}

export function homePage(posts, settings, siteUrl, nowMs = Date.now()) {
  const desc = 'Live factual briefings on trending topics, updated every minute from verified news sources.';
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
    `${settings.siteName} — Live Factual Trend Briefings`,
    desc,
    `${siteUrl}/`,
    settings.geos,
    `<script type="application/ld+json">${ld}</script>`,
    'website'
  );
  h += siteHeader(settings.siteName, 'home') + '<main><h1 class="hd"><i></i>Top stories</h1><div class="c">';
  for (const p of posts) h += renderClusterArticle(p, posts, nowMs, true);
  if (!posts.length) h += '<article><p>No active briefings right now. Check back shortly.</p></article>';
  return h + '</div></main>' + htmlFoot(settings.contactEmail);
}

export function categoryPage(categoryName, posts, settings, siteUrl, nowMs = Date.now()) {
  const catSlug = slugify(categoryName);
  const canon = `${siteUrl}/c/${catSlug}`;
  const desc = `Latest live ${categoryName.toLowerCase()} briefings from verified news outlets, updated every minute on ${settings.siteName}.`;
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
  h += siteHeader(settings.siteName, catSlug) + `<main><h1 class="hd"><i></i>${esc(categoryName)}</h1><div class="c">`;
  for (const p of posts) h += renderClusterArticle(p, posts, nowMs, false);
  if (!posts.length) h += `<article><p>No active ${esc(categoryName.toLowerCase())} briefings right now. <a href="/">View Top stories</a>.</p></article>`;
  return h + `</div><p class="s"><a href="/">← Back to Top stories</a></p></main>` + htmlFoot(settings.contactEmail);
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
  h += siteHeader(settings.siteName, catSlug);
  h += `<main><div class="c"><article id="${esc(post.slug)}">`;
  h += `<p class="m"><a class="k" href="/c/${esc(catSlug)}">${esc(cat)}</a> · Published <time datetime="${esc(post.created_at)}">${timeAgo(post.created_at, nowMs)}</time>`;
  if (post.updated_at && post.updated_at !== post.created_at) {
    h += ` · Updated <time datetime="${esc(post.updated_at)}">${timeAgo(post.updated_at, nowMs)}</time>`;
  }
  h += `</p>`;
  h += `<h1>${esc(post.title)}</h1>`;
  h += renderPostBody(post, livePosts, nowMs);
  h += `</article></div>`;

  if (related.length) {
    h += '<nav class="c"><h2 class="sec">More trending now</h2><ul>';
    for (const r of related) {
      const rCat = r.category || 'News';
      h += `<li><a class="k" href="/c/${esc(slugify(rCat))}">${esc(rCat)}</a> · <a href="/p/${esc(r.slug)}">${esc(r.title)}</a></li>`;
    }
    h += '</ul></nav>';
  }
  h += `<p class="s"><a href="/">← Back to Top stories</a></p></main>` + htmlFoot(settings.contactEmail);
  return h;
}

export function aboutPage(settings, siteUrl) {
  return htmlHead(
    `About — ${settings.siteName}`,
    'How this real-time, source-grounded trend briefing site verifies public news reports.',
    `${siteUrl}/about`,
    settings.geos,
    '',
    'website'
  ) +
    siteHeader(settings.siteName, '') +
    `<main><div class="c"><article><h1>About ${esc(settings.siteName)}</h1>` +
    `<p>This site publishes short, factual briefings on trending search topics using only headlines and snippets from public news feeds.</p>` +
    `<ul><li>Every fact, number, and date is checked against listed news outlets before publishing.</li>` +
    `<li>Briefings rotate automatically as trends evolve.</li>` +
    `<li>Sensitive topics, rumors, and single-outlet stories are filtered out.</li>` +
    `<li>No personal data, IP addresses, ads, or analytics scripts are used.</li>` +
    `<li>Contact: <a href="mailto:${esc(settings.contactEmail)}">${esc(settings.contactEmail)}</a></li></ul></article></div>` +
    `<p class="s"><a href="/">← Back to Top stories</a></p></main>` +
    htmlFoot(settings.contactEmail);
}

export const gonePage = () =>
  `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><meta name="robots" content="noindex,follow"><title>Post Expired</title><style>${CSS}</style></head><body><main><div class="c"><article><h1>This briefing is no longer active</h1><p>This story has rotated out of the current trending window.</p><p><a href="/">← View Top stories</a></p></article></div></main></body></html>`;

export const endedPage = () =>
  `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><meta name="robots" content="noindex"><title>Site Ended</title><style>${CSS}</style></head><body><main><div class="c"><article><h1>This site has ended</h1><p>This trend site has concluded its run.</p></article></div></main></body></html>`;
