/**
 * Server-rendered HTML templates, inline CSS (< 1.5KB), JSON-LD schemas,
 * pagination, search, progressive back bar, and Google News dark cluster UI.
 */

export const PER_PAGE = 10;

export const NAV_CATEGORIES = [
  'News', 'Sports', 'Tech', 'Business', 'Entertainment', 'Science', 'Gaming', 'Weather', 'Holidays',
];

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
export const CSS = `*{margin:0;padding:0}body{font:15px/1.4 system-ui;background:#202124}body,.b,h2 a,.sum,.bt,input{color:#e8eaed}.m,.t a{color:#9aa0a6}a,.b b,.k,.t .on,a:hover{color:#8ab4f8}p,ul,h1,h2{margin:4px 0}p,ul{color:#bdc1c6}a{text-decoration:none}h1,h2{font-weight:500}h1,.b{font-size:19px}h2{font-size:16px}ul{padding-left:16px}.w{max-width:820px;margin:0 auto;padding:8px}header{border-bottom:1px solid #3c4043}header .w{padding-bottom:0}.f,.t,.bt{display:flex;align-items:center}.f{flex-wrap:wrap;gap:6px}.b{margin-right:auto}.b,.k,.bt.on{font-weight:600}.qf{flex:1 1 12em;padding:2px 2px 2px 10px}input{flex:1;width:0;border:0;background:0;font-size:16px;outline:0}.qf:focus-within,a.bt:hover{border-color:#8ab4f8}.t{gap:14px;overflow:auto;scrollbar-width:none}.t a{white-space:nowrap;padding:7px 0;border-bottom:3px solid transparent}.t .on,.t a:hover{border-color:#8ab4f8}h1 i{padding:5px;border-radius:5px;background:#5bb974}.m{font-size:12px}.bt{justify-content:center;min-height:34px;padding:0 12px;font-size:13px;background:#303134;border-radius:99px;cursor:pointer}.bt,.c{border:1px solid #3c4043}.bt.on{background:#8ab4f8;color:#202124;border:0}.pg{justify-content:center}.c{background:#292a2d;border-radius:14px;padding:12px;margin:8px 0}.sum,.u{border-left:2px solid #8ab4f8;padding-left:8px}.u{border-color:#fdd663}.d{border-top:1px solid #3c4043;padding-top:8px}.p{margin-top:8px}@media(min-width:640px){.r{display:grid;grid-template-columns:6fr 5fr;gap:12px}.d{border:0;border-left:1px solid #3c4043;padding:0 0 0 12px}}`;

export const BACK_SCRIPT = `document.querySelectorAll('[data-bk]').forEach(function(a){a.addEventListener('click',function(e){try{if(document.referrer&&new URL(document.referrer).origin===location.origin&&history.length>1){e.preventDefault();history.back()}}catch(x){}})})`;
export const BACK_SCRIPT_HASH = 'sha256-gYnBAx/IGgY222gaMwV06vj32azHtsaxP2c3Mm8K7EY=';

export function paginate(items, rawPage = 1, perPage = PER_PAGE) {
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / perPage));
  const parsed = Number.parseInt(String(rawPage), 10);
  const page = Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
  const clamped = Math.min(page, totalPages);
  const offset = (clamped - 1) * perPage;
  const slice = items.slice(offset, offset + perPage);
  return {
    items: slice,
    page: clamped,
    requestedPage: page,
    totalPages,
    totalItems,
    start: totalItems ? offset + 1 : 0,
    end: offset + slice.length,
  };
}

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
  const why = String(post.why_trending || '').trim();
  let combined = summary;
  if (combined.length < 120 && what && !what.startsWith(summary)) {
    combined = `${combined} ${what}`.replace(/\s+/g, ' ').trim();
  }
  if (combined.length < 120 && why) {
    combined = `${combined} ${why}`.replace(/\s+/g, ' ').trim();
  }
  if (combined.length <= 158) return combined;
  return combined.slice(0, 154).replace(/\s+\S*$/, '').replace(/[,;:\s]+$/, '') + '...';
}

function clampTitle(raw, maxLen = 60) {
  const s = String(raw || '').trim();
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3).replace(/\s+\S*$/, '') + '...';
}

function clampMeta(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= 158) return s;
  return s.slice(0, 154).replace(/\s+\S*$/, '').replace(/[,;:\s]+$/, '') + '...';
}

function hreflangLinks(canon, geos = []) {
  if (!geos || geos.length <= 1) return '';
  return geos
    .map(g => `<link rel="alternate" hreflang="en-${esc(g.toLowerCase())}" href="${canon}">`)
    .join('') + `<link rel="alternate" hreflang="x-default" href="${canon}">`;
}

function htmlHead(title, desc, canon, geos = [], extra = '', ogType = 'article', ogImage = '', noindex = false) {
  const canonTag = (!noindex && canon) ? `<link rel="canonical" href="${canon}">${hreflangLinks(canon, geos)}` : '';
  const robotsTag = noindex
    ? '<meta name="robots" content="noindex, follow">'
    : '<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1">';
  const imgUrl = ogImage || (canon ? `${new URL(canon).origin}/og.png` : '/og.png');
  const ogUrl = canon ? `<meta property="og:url" content="${canon}">` : '';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>${esc(title)}</title><meta name="description" content="${esc(desc)}">${robotsTag}${canonTag}<link rel="icon" type="image/svg+xml" href="/favicon.svg"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">${ogUrl}<meta property="og:type" content="${ogType}"><meta property="og:image" content="${esc(imgUrl)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${esc(imgUrl)}"><link rel="alternate" type="application/rss+xml" title="RSS" href="/rss.xml"><link rel="sitemap" type="application/xml" title="Sitemap" href="/sitemap.xml">${extra}<style>${CSS}</style></head><body>`;
}

function siteHeader(siteName, activeTab = 'home', searchQuery = '') {
  const parts = String(siteName || 'Trending Now').trim().split(/\s+/);
  const brandHtml = parts.length > 1
    ? `<b>${esc(parts[0])}</b> ${esc(parts.slice(1).join(' '))}`
    : `<b>${esc(siteName)}</b>`;
  const tab = (slug, label, href) =>
    `<a${activeTab === slug ? ' class="on"' : ''} href="${href}">${label}</a>`;
  const navLinks = tab('home', 'Home', '/') + NAV_CATEGORIES.map(c => tab(slugify(c), c, `/c/${slugify(c)}`)).join('');
  return `<header><div class="w"><div class="f"><a class="b" href="/">${brandHtml}</a><form class="f bt qf" action="/search" method="GET" role="search"><input type="search" name="q" value="${esc(searchQuery)}" placeholder="Search topics, news &amp; sources..." aria-label="Search topics, news and sources" required><button class="bt on" type="submit">Search</button></form></div><nav class="t" aria-label="Categories">${navLinks}</nav></div></header>`;
}

function htmlFoot(email) {
  return `<footer class="w m"><p>Factual briefings from public news sources · <a href="mailto:${esc(email)}">${esc(email)}</a> · <a href="/about">About</a> · <a href="/search">Search</a> · <a href="/rss.xml">RSS</a> · <a href="/sitemap.xml">Sitemap</a></p></footer><script>${BACK_SCRIPT}</script></body></html>`;
}

function renderBackBar(crumbs = [], currentLabel = '', backHref = '/') {
  const links = crumbs
    .map(c => `<a href="${esc(c.href)}">${esc(c.label)}</a>`)
    .concat(currentLabel ? [`<span>${esc(currentLabel)}</span>`] : [])
    .join(' <span>/</span> ');
  return `<nav class="f m" aria-label="Breadcrumb"><a class="bt" href="${esc(backHref)}" data-bk="1">&larr; Back</a>${links ? `<div>${links}</div>` : ''}</nav>`;
}

export function renderPagination(urlForPage, page, totalPages) {
  if (totalPages <= 1) return '';
  const items = [];
  if (page > 1) {
    items.push(`<a class="bt" href="${esc(urlForPage(page - 1))}" rel="prev">&larr; Prev</a>`);
  } else {
    items.push('<span class="bt m" aria-disabled="true">&larr; Prev</span>');
  }

  const pages = new Set([1, totalPages]);
  for (let i = Math.max(1, page - 1); i <= Math.min(totalPages, page + 1); i++) pages.add(i);
  const sorted = [...pages].sort((a, b) => a - b);

  let prev = 0;
  for (const p of sorted) {
    if (prev && p - prev > 1) items.push('<span class="m">…</span>');
    if (p === page) {
      items.push(`<span class="bt on" aria-current="page">${p}</span>`);
    } else {
      items.push(`<a class="bt" href="${esc(urlForPage(p))}">${p}</a>`);
    }
    prev = p;
  }

  if (page < totalPages) {
    items.push(`<a class="bt" href="${esc(urlForPage(page + 1))}" rel="next">Next &rarr;</a>`);
  } else {
    items.push('<span class="bt m" aria-disabled="true">Next &rarr;</span>');
  }

  return `<nav class="f pg" aria-label="Pagination">${items.join('')}</nav>`;
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
  return `<p class="m"><strong>Sources:</strong> ${esc(post.sources)}</p>`;
}

/**
 * Compact Google News cluster card for feed lists (Home, Category, Search).
 * Avoids dumping full multi-paragraph essays onto list pages; links cleanly to /p/:slug.
 */
function renderStoryCard(p, livePosts, nowMs, showCategory = true) {
  const cat = p.category || 'News';
  const catSlug = slugify(cat);
  const relTime = timeAgo(p.created_at, nowMs);
  const lead = p.summary || p.what_happened || p.body || '';
  const keyFacts = parseJsonField(p.key_facts || p.bullets, []).slice(0, 3);
  const updates = parseJsonField(p.updates_json, []);
  const latestUpdate = updates[updates.length - 1];
  const alsoMatches = findMatchingLiveLinks(p, livePosts);

  let left = `<p class="m">${showCategory ? `<a class="k" href="/c/${esc(catSlug)}">${esc(cat)}</a> · ` : ''}<time datetime="${esc(p.created_at)}">${relTime}</time>`;
  if (p.updated_at && p.updated_at !== p.created_at) left += ` · Updated ${timeAgo(p.updated_at, nowMs)}`;
  left += `</p><h2><a href="/p/${esc(p.slug)}">${esc(p.title)}</a></h2>`;
  if (lead) left += `<p class="sum">${esc(lead)}</p>`;
  if (latestUpdate) {
    left += `<p class="u"><strong>Update (${timeAgo(latestUpdate.time, nowMs)}):</strong> ${esc(latestUpdate.text)}</p>`;
  }
  if (p.sources) left += `<p class="m"><strong>Sources:</strong> ${esc(p.sources)}</p>`;

  let right = '';
  if (keyFacts.length) {
    right += '<p class="m"><strong>Key facts &amp; perspectives</strong></p><ul>' +
      keyFacts.map(f => `<li>${esc(f)}</li>`).join('') + '</ul>';
  }
  if (alsoMatches.length) {
    const links = alsoMatches.map(m => `<a href="/p/${esc(m.slug)}">${esc(m.phrase)}</a>`).join(' · ');
    right += `<p class="m"><strong>Related:</strong> ${links}</p>`;
  }

  return `<article class="c" id="${esc(p.slug)}"><div class="r"><div>${left}</div>${right ? `<div class="d">${right}</div>` : ''}</div><a class="bt p" href="/p/${esc(p.slug)}">Full briefing &amp; sources</a></article>`;
}

function renderPostBody(post, livePosts, nowMs) {
  const summary = post.summary || '';
  const whatHappened = post.what_happened || post.body || '';
  const whyTrending = post.why_trending || '';
  const keyFacts = parseJsonField(post.key_facts || post.bullets, []);
  const whatNext = post.what_to_know_next || '';
  const updates = parseJsonField(post.updates_json, []);
  const alsoSearched = parseJsonField(post.also_searched, []);
  const alsoMatches = findMatchingLiveLinks(post, livePosts);

  let h = '';
  if (summary) h += `<p class="sum">${esc(summary)}</p>`;
  if (whatHappened) h += '<h2>What Happened</h2>' + `<p>${esc(whatHappened)}</p>`;
  if (whyTrending) h += `<h2>Why ${esc(post.topic || 'This')} Is Trending</h2><p>${esc(whyTrending)}</p>`;
  if (keyFacts.length) h += '<h2>Key Facts</h2><ul>' + keyFacts.map(f => `<li>${esc(f)}</li>`).join('') + '</ul>';
  if (whatNext) h += `<h2>What to Know Next</h2><p>${esc(whatNext)}</p>`;
  for (const u of updates) h += `<p class="u"><strong>Update (${timeAgo(u.time, nowMs)}):</strong> ${esc(u.text)}</p>`;

  const matchedPhrases = new Set(alsoMatches.map(m => m.phrase.toLowerCase()));
  const searchSuggestions = alsoSearched.filter(p => p && !matchedPhrases.has(String(p).toLowerCase())).slice(0, 4);

  if (alsoMatches.length || searchSuggestions.length) {
    h += '<div class="f" style="margin:10px 0"><span class="m">Explore:</span>';
    for (const m of alsoMatches) {
      h += `<a class="bt" href="/p/${esc(m.slug)}">${esc(m.phrase)}</a>`;
    }
    for (const q of searchSuggestions) {
      h += `<a class="bt" href="/search?q=${encodeURIComponent(q)}">${esc(q)}</a>`;
    }
    h += '</div>';
  }
  h += renderSourcesList(post, true);
  return h;
}

export function homePage(posts, settings, siteUrl, nowMs = Date.now(), rawPage = 1) {
  const pg = paginate(posts, rawPage, PER_PAGE);
  const canon = pg.page > 1 ? `${siteUrl}/page/${pg.page}` : `${siteUrl}/`;
  const title = pg.page > 1
    ? clampTitle(`Top Stories Page ${pg.page} of ${pg.totalPages} — ${settings.siteName}`)
    : clampTitle(`${settings.siteName} — Live Factual Trend Briefings`);
  const desc = pg.page > 1
    ? clampMeta(`Page ${pg.page} of ${pg.totalPages}: Real-time factual briefings on trending news across sports, tech, business, and science, verified across multiple outlets.`)
    : clampMeta('Real-time factual briefings on top trending stories in sports, tech, business, and world news, sourced from multiple outlets and updated every minute.');

  const ld = [
    {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: settings.siteName,
      url: `${siteUrl}/`,
      description: desc,
      inLanguage: 'en',
      potentialAction: {
        '@type': 'SearchAction',
        target: `${siteUrl}/search?q={search_term_string}`,
        'query-input': 'required name=search_term_string',
      },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      itemListElement: pg.items.map((p, i) => ({
        '@type': 'ListItem',
        position: pg.start + i,
        url: `${siteUrl}/p/${p.slug}`,
        name: p.title,
      })),
    },
  ];
  if (pg.page > 1) {
    ld.push({
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: `${siteUrl}/` },
        { '@type': 'ListItem', position: 2, name: `Page ${pg.page}`, item: canon },
      ],
    });
  }

  const ldTag = `<script type="application/ld+json">${JSON.stringify(ld).replace(/<\//g, '<\\/')}</script>`;
  let h = htmlHead(title, desc, canon, settings.geos, ldTag, 'website', `${siteUrl}/og.png`);
  h += siteHeader(settings.siteName, 'home') + '<main class="w">';
  if (pg.page > 1) h += renderBackBar([{ label: 'Home', href: '/' }], `Page ${pg.page}`, '/');
  h += `<h1 class="f"><i></i>Top stories${pg.page > 1 ? ` · Page ${pg.page}` : ''}</h1>`;
  if (pg.totalItems) {
    h += `<p class="m">Showing ${pg.start}&ndash;${pg.end} of ${pg.totalItems} live briefings · Page ${pg.page} of ${pg.totalPages}</p>`;
  }
  for (const p of pg.items) h += renderStoryCard(p, posts, nowMs, true);
  if (!pg.items.length) h += '<article class="c"><p>No active briefings right now. Check back shortly.</p></article>';
  h += renderPagination(n => (n <= 1 ? '/' : `/page/${n}`), pg.page, pg.totalPages);
  return h + '</main>' + htmlFoot(settings.contactEmail);
}

export function categoryPage(categoryName, posts, settings, siteUrl, nowMs = Date.now(), rawPage = 1) {
  const catSlug = slugify(categoryName);
  const pg = paginate(posts, rawPage, PER_PAGE);
  const canon = pg.page > 1 ? `${siteUrl}/c/${catSlug}/page/${pg.page}` : `${siteUrl}/c/${catSlug}`;
  const catLower = categoryName.toLowerCase();
  const desc = pg.page > 1
    ? clampMeta(`Page ${pg.page} of ${pg.totalPages}: Live ${catLower} trend briefings verified across multiple news outlets, with factual summaries and key takeaways.`)
    : clampMeta(`Live ${catLower} trend briefings verified across multiple trusted news outlets and updated every minute on ${settings.siteName}. Read summaries and key facts.`);
  const title = pg.page > 1
    ? clampTitle(`${categoryName} Page ${pg.page} of ${pg.totalPages} — ${settings.siteName}`)
    : clampTitle(`${categoryName} News & Briefings — ${settings.siteName}`);

  const breadcrumbItems = [
    { '@type': 'ListItem', position: 1, name: 'Home', item: `${siteUrl}/` },
    { '@type': 'ListItem', position: 2, name: categoryName, item: `${siteUrl}/c/${catSlug}` },
  ];
  if (pg.page > 1) {
    breadcrumbItems.push({ '@type': 'ListItem', position: 3, name: `Page ${pg.page}`, item: canon });
  }

  const ld = JSON.stringify([
    {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: `${categoryName} Trends`,
      url: canon,
      description: desc,
      inLanguage: 'en',
    },
    { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: breadcrumbItems },
    {
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      itemListElement: pg.items.map((p, i) => ({
        '@type': 'ListItem',
        position: pg.start + i,
        url: `${siteUrl}/p/${p.slug}`,
        name: p.title,
      })),
    },
  ]).replace(/<\//g, '<\\/');

  let h = htmlHead(title, desc, canon, settings.geos, `<script type="application/ld+json">${ld}</script>`, 'website', `${siteUrl}/og.png`);
  h += siteHeader(settings.siteName, catSlug) + '<main class="w">';
  const crumbs = pg.page > 1
    ? [{ label: 'Home', href: '/' }, { label: categoryName, href: `/c/${catSlug}` }]
    : [{ label: 'Home', href: '/' }];
  h += renderBackBar(crumbs, pg.page > 1 ? `Page ${pg.page}` : categoryName, pg.page > 1 ? `/c/${catSlug}` : '/');
  h += `<h1 class="f"><i></i>${esc(categoryName)}${pg.page > 1 ? ` · Page ${pg.page}` : ''}</h1>`;
  if (pg.totalItems) {
    h += `<p class="m">Showing ${pg.start}&ndash;${pg.end} of ${pg.totalItems} ${esc(catLower)} briefings · Page ${pg.page} of ${pg.totalPages}</p>`;
  }
  for (const p of pg.items) h += renderStoryCard(p, posts, nowMs, false);
  if (!pg.items.length) h += `<article class="c"><p>No active ${esc(catLower)} briefings right now. <a href="/">View Top stories</a>.</p></article>`;
  h += renderPagination(n => (n <= 1 ? `/c/${catSlug}` : `/c/${catSlug}/page/${n}`), pg.page, pg.totalPages);
  return h + '</main>' + htmlFoot(settings.contactEmail);
}

export function searchPage({ query = '', cat = '', page = 1, results = [], allLive = [] }, settings, siteUrl, nowMs = Date.now()) {
  const cleanQ = String(query || '').trim();
  const cleanCat = slugify(cat || '');
  const pg = paginate(results, page, PER_PAGE);
  const title = clampTitle(cleanQ ? `Search: ${cleanQ} — ${settings.siteName}` : `Search Briefings — ${settings.siteName}`);
  const desc = clampMeta(`Search live factual trend briefings across news, sports, tech, business, and science on ${settings.siteName}.`);

  const searchUrl = (n = 1, catOverride = cleanCat) => {
    const params = new URLSearchParams();
    if (cleanQ) params.set('q', cleanQ);
    if (catOverride) params.set('cat', catOverride);
    if (n > 1) params.set('page', String(n));
    const qs = params.toString();
    return qs ? `/search?${qs}` : '/search';
  };

  let h = htmlHead(title, desc, `${siteUrl}/search`, settings.geos, '', 'website', `${siteUrl}/og.png`, true);
  h += siteHeader(settings.siteName, '', cleanQ) + '<main class="w">';
  h += renderBackBar([{ label: 'Home', href: '/' }], cleanQ ? `Search: ${cleanQ}` : 'Search', '/');
  h += `<h1 class="f"><i></i>${cleanQ ? `Results for "${esc(cleanQ)}"` : 'Search live briefings'}</h1>`;

  // Category filter pills within search
  const activeCats = [...new Set(allLive.map(p => p.category || 'News'))];
  if (activeCats.length) {
    h += '<div class="f" style="margin:6px 0">';
    h += `<a class="bt${!cleanCat ? ' on' : ''}" href="${esc(searchUrl(1, ''))}">All</a>`;
    for (const c of activeCats.slice(0, 8)) {
      const cSlug = slugify(c);
      h += `<a class="bt${cleanCat === cSlug ? ' on' : ''}" href="${esc(searchUrl(1, cSlug))}">${esc(c)}</a>`;
    }
    h += '</div>';
  }

  if (cleanQ) {
    h += `<p class="m">${pg.totalItems} matching ${pg.totalItems === 1 ? 'briefing' : 'briefings'}${pg.totalPages > 1 ? ` · Page ${pg.page} of ${pg.totalPages}` : ''}</p>`;
    for (const p of pg.items) h += renderStoryCard(p, allLive, nowMs, true);
    if (!pg.items.length) {
      h += '<article class="c"><p>No live briefings matched your query.</p>';
      if (allLive.length) {
        h += '<p class="m">Try searching one of today\'s trending topics:</p><div class="f" style="margin-top:6px">';
        for (const t of allLive.slice(0, 5)) {
          h += `<a class="bt" href="/search?q=${encodeURIComponent(t.topic || t.title)}">${esc(t.topic || t.title)}</a>`;
        }
        h += '</div>';
      }
      h += '</article>';
    }
    h += renderPagination(n => searchUrl(n, cleanCat), pg.page, pg.totalPages);
  } else {
    const shown = cleanCat ? allLive.filter(p => slugify(p.category || 'News') === cleanCat) : allLive;
    const latest = shown.slice(0, 5);
    h += '<p class="m">Enter a keyword above or browse recent live topics below:</p>';
    for (const p of latest) h += renderStoryCard(p, allLive, nowMs, true);
  }

  return h + '</main>' + htmlFoot(settings.contactEmail);
}

export function postPage(post, related, livePosts, settings, siteUrl, nowMs = Date.now()) {
  const cat = post.category || 'News';
  const catSlug = slugify(cat);
  const desc = buildMetaDescription(post);
  const title = clampTitle(post.title);
  const canon = `${siteUrl}/p/${post.slug}`;
  const ogImg = `${siteUrl}/og/${post.slug}.png`;
  const dateModified = post.updated_at || post.created_at;
  const keywords = [post.topic, cat, ...parseJsonField(post.also_searched, [])].filter(Boolean).join(', ');

  const newsLd = {
    '@context': 'https://schema.org',
    '@type': 'NewsArticle',
    headline: post.title,
    datePublished: post.created_at,
    dateModified,
    description: desc,
    image: [{ '@type': 'ImageObject', url: ogImg, width: 1200, height: 630 }],
    articleSection: cat,
    keywords,
    inLanguage: 'en',
    isAccessibleForFree: true,
    speakable: { '@type': 'SpeakableSpecification', cssSelector: ['h1', '.sum'] },
    mainEntityOfPage: canon,
    author: { '@type': 'Organization', name: settings.siteName, url: siteUrl },
    publisher: {
      '@type': 'Organization',
      name: settings.siteName,
      url: siteUrl,
      logo: { '@type': 'ImageObject', url: `${siteUrl}/og.png`, width: 1200, height: 630 },
    },
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

  let h = htmlHead(title, desc, canon, settings.geos, ldScripts, 'article', ogImg);
  h += siteHeader(settings.siteName, catSlug) + '<main class="w">';
  h += renderBackBar(
    [{ label: 'Home', href: '/' }, { label: cat, href: `/c/${catSlug}` }],
    clampTitle(post.title, 36),
    `/c/${catSlug}`
  );
  h += `<article class="c" id="${esc(post.slug)}">`;
  h += `<p class="m"><a class="k" href="/c/${esc(catSlug)}">${esc(cat)}</a> · Published <time datetime="${esc(post.created_at)}">${timeAgo(post.created_at, nowMs)}</time>`;
  if (post.updated_at && post.updated_at !== post.created_at) {
    h += ` · Updated <time datetime="${esc(post.updated_at)}">${timeAgo(post.updated_at, nowMs)}</time>`;
  }
  h += `</p>`;
  h += `<h1>${esc(post.title)}</h1>`;
  h += renderPostBody(post, livePosts, nowMs);
  h += `</article>`;

  if (related.length) {
    h += '<nav class="c" aria-label="Related briefings"><p class="m"><strong>More trending now</strong></p><ul>';
    for (const r of related) {
      const rCat = r.category || 'News';
      h += `<li><a class="k" href="/c/${esc(slugify(rCat))}">${esc(rCat)}</a> · <a href="/p/${esc(r.slug)}">${esc(r.title)}</a></li>`;
    }
    h += '</ul></nav>';
  }
  h += `<div class="f"><a class="bt" href="/" data-bk="1">&larr; Back</a><a class="bt" href="/c/${esc(catSlug)}">More ${esc(cat)}</a><a class="bt" href="/">Top stories</a></div></main>` + htmlFoot(settings.contactEmail);
  return h;
}

export function aboutPage(settings, siteUrl) {
  return htmlHead(
    `About — ${settings.siteName}`,
    clampMeta(`Learn how ${settings.siteName} verifies real-time public news feeds, grounds facts across multiple outlets, and maintains transparent editorial standards.`),
    `${siteUrl}/about`,
    settings.geos,
    '',
    'website',
    `${siteUrl}/og.png`
  ) +
    siteHeader(settings.siteName, '') +
    `<main class="w">` +
    renderBackBar([{ label: 'Home', href: '/' }], 'About', '/') +
    `<article class="c"><h1>About ${esc(settings.siteName)}</h1>` +
    `<p>This site publishes short, factual briefings on trending search topics using only headlines and snippets from public news feeds.</p>` +
    `<ul><li>Every fact, number, and date is checked against listed news outlets before publishing.</li>` +
    `<li>Briefings rotate automatically as trends evolve.</li>` +
    `<li>Sensitive topics, rumors, and single-outlet stories are filtered out.</li>` +
    `<li>No personal data, IP addresses, ads, or third-party tracking scripts are used.</li>` +
    `<li>Contact: <a href="mailto:${esc(settings.contactEmail)}">${esc(settings.contactEmail)}</a></li></ul></article>` +
    `<div class="f"><a class="bt" href="/" data-bk="1">&larr; Back</a><a class="bt" href="/">Top stories</a></div></main>` +
    htmlFoot(settings.contactEmail);
}

export function notFoundPage(settings, siteUrl) {
  return htmlHead(
    `Page Not Found — ${settings.siteName}`,
    clampMeta(`The requested page could not be found on ${settings.siteName}. Browse top live trending briefings or search by topic.`),
    '',
    [],
    '',
    'website',
    `${siteUrl}/og.png`,
    true
  ) +
    siteHeader(settings.siteName, '') +
    `<main class="w">` +
    renderBackBar([{ label: 'Home', href: '/' }], 'Not Found', '/') +
    `<article class="c"><h1>Page not found</h1><p>This URL has no active briefings right now. Browse Top stories or search for another topic.</p>` +
    `<div class="f" style="margin-top:8px"><a class="bt on" href="/">Top stories</a><a class="bt" href="/search">Search briefings</a></div></article></main>` +
    htmlFoot(settings.contactEmail);
}

export const gonePage = (siteUrl = '') =>
  `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><meta name="robots" content="noindex,follow"><title>Post Expired</title><link rel="icon" type="image/svg+xml" href="/favicon.svg"><style>${CSS}</style></head><body><main class="w"><div class="f m"><a class="bt" href="/" data-bk="1">&larr; Back</a></div><article class="c"><h1>This briefing is no longer active</h1><p>This story has rotated out of the current trending window.</p><p style="margin-top:8px"><a class="bt on" href="${esc(siteUrl || '/')}">View Top stories</a></p></article></main><script>${BACK_SCRIPT}</script></body></html>`;

export const endedPage = () =>
  `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><meta name="robots" content="noindex"><title>Site Ended</title><style>${CSS}</style></head><body><main class="w"><article class="c"><h1>This site has ended</h1><p>This trend site has concluded its run.</p></article></main></body></html>`;
