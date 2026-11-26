/**
 * Ephemeral Trend Site
 * Cloudflare Workers + D1 + Workers AI (Gemini fallback)
 *
 * - Fetches Google Trends RSS every minute via cron
 * - Generates factual summaries with LLM for new topics only
 * - Auto-deletes all content after 48 hours
 * - Full programmatic SEO: sitemaps, JSON-LD, IndexNow, OG tags
 * - Zero client JS, inline CSS, no images, no external assets
 */

// ══════════════════════════════════════════════════════════════
//  CONFIGURATION
// ══════════════════════════════════════════════════════════════

const BLOCKLIST = [
  'death','died','killed','killing','murder','suicide','shooting','rape',
  'assault','abuse','molest','child abuse','porn','xxx','nsfw','fatal',
  'mass shooting','terrorist','hostage','kidnap',
];
const MAX_DAILY   = 40;            // max posts per calendar day
const TTL_MS      = 48 * 3600_000; // post lifetime: 48 hours
const SEEN_TTL_MS = 7 * 86400_000; // dedup memory: 7 days

// Inline CSS — ~480 bytes, well under 1 KB
const CSS = `*{margin:0;padding:0;box-sizing:border-box}body{font:1rem/1.6 system-ui,sans-serif;max-width:42rem;margin:0 auto;padding:1rem;color:#1a1a1a}h1{font-size:1.4rem;margin-bottom:.8rem}h2{font-size:1.15rem;margin:1.2rem 0 .4rem}h3{font-size:1rem;margin:1rem 0 .3rem}a{color:#1a0dab}time{color:#555;font-size:.85rem}ul{padding-left:1.2rem}li{margin:.25rem 0}.s{color:#555;font-size:.85rem;margin-top:.4rem}footer{margin-top:2rem;padding-top:1rem;border-top:1px solid #ddd;font-size:.78rem;color:#777}article{margin:1.2rem 0;padding-bottom:1.2rem;border-bottom:1px solid #eee}nav{margin:1rem 0}`;

// ══════════════════════════════════════════════════════════════
//  UTILITIES
// ══════════════════════════════════════════════════════════════

const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const slugify = s => s.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,80);
const isSensitive = t => { const l = t.toLowerCase(); return BLOCKLIST.some(w => l.includes(w)); };
const isoNow = () => new Date().toISOString();
const todayStr = () => isoNow().slice(0,10);

const htmlRes = (body, status = 200, extra = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html;charset=utf-8', ...extra } });
const textRes = body => new Response(body, { headers: { 'Content-Type': 'text/plain' } });
const xmlRes  = body => new Response(body, { headers: { 'Content-Type': 'application/xml;charset=utf-8' } });

// ══════════════════════════════════════════════════════════════
//  RSS PARSER (regex-based, zero dependencies)
// ══════════════════════════════════════════════════════════════

/** Extract text content from an XML tag, handling optional CDATA wrappers */
function xmlTag(xml, name) {
  const cdata = new RegExp(`<${name}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${name}>`);
  const plain = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`);
  return (xml.match(cdata) || xml.match(plain) || [])[1]?.trim() || '';
}

/** Parse Google Trends RSS → [{title, newsItems: [{title, snippet, source}]}] */
function parseRSS(xml) {
  const items = [], re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml))) {
    const block = m[1], title = xmlTag(block, 'title'), newsItems = [];
    const niRe = /<ht:news_item>([\s\S]*?)<\/ht:news_item>/g;
    let ni;
    while ((ni = niRe.exec(block)))
      newsItems.push({
        title:   xmlTag(ni[1], 'ht:news_item_title'),
        snippet: xmlTag(ni[1], 'ht:news_item_snippet'),
        source:  xmlTag(ni[1], 'ht:news_item_source'),
      });
    if (title && newsItems.length) items.push({ title, newsItems });
  }
  return items;
}

// ══════════════════════════════════════════════════════════════
//  CONTENT GENERATION (Workers AI → Gemini fallback)
// ══════════════════════════════════════════════════════════════

const PROMPT = (topic, snippets) =>
  `Write a brief factual summary about "${topic}" based ONLY on these news reports:\n${snippets}\n\n` +
  `Rules:\n- 120-180 words total\n- Neutral, factual tone — no opinions, no invented facts\n` +
  `- Output ONLY valid JSON (no markdown fences, no extra text):\n` +
  `{"title":"<headline under 55 chars>","body":"<one paragraph>","bullets":["<fact 1>","<fact 2>","<fact 3>"]}`;

async function generate(env, topic, newsItems) {
  const snippets = newsItems.slice(0,5).map(n => `• ${n.title} (${n.source}): ${n.snippet}`).join('\n');
  const sources  = [...new Set(newsItems.map(n => n.source))].filter(Boolean).join(', ');
  const prompt   = PROMPT(topic, snippets);
  let text = '';

  try { // Workers AI (primary)
    const r = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [{ role: 'user', content: prompt }], max_tokens: 512,
    });
    text = r.response || '';
  } catch (err) { // Gemini free API (fallback)
    if (!env.GEMINI_API_KEY) throw err;
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${env.GEMINI_API_KEY}`,
      { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ contents:[{ parts:[{ text: prompt }] }] }) });
    const j = await r.json();
    text = j.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  const parsed = JSON.parse((text.match(/\{[\s\S]*\}/) || ['{}'])[0]);
  if (!parsed.title || !parsed.body) throw new Error('Invalid LLM JSON');
  return { title: parsed.title.slice(0,55), body: parsed.body,
    bullets: (parsed.bullets||[]).slice(0,3), sources };
}

/** Dev mode: deterministic mock content, no LLM calls */
function mockGenerate(topic) {
  return {
    title: `${topic} — Latest Updates`.slice(0,55),
    body: `Here is a summary about ${topic}. This content is auto-generated for local testing and would normally contain factual information sourced from news reports in the Google Trends RSS feed.`,
    bullets: [`Key development regarding ${topic}`, `Industry reaction to ${topic}`, `What experts say about ${topic}`],
    sources: 'Mock News, Test Wire',
  };
}

// ══════════════════════════════════════════════════════════════
//  INDEXNOW (ping on publish and delete)
// ══════════════════════════════════════════════════════════════

async function pingIndexNow(env, urls) {
  if (!env.INDEXNOW_KEY || !urls.length || env.DEV_MODE) return;
  try {
    await fetch('https://api.indexnow.org/indexnow', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host: env.SITE_HOST, key: env.INDEXNOW_KEY,
        keyLocation: `https://${env.SITE_HOST}/${env.INDEXNOW_KEY}.txt`,
        urlList: urls.slice(0, 10_000),
      }),
    });
  } catch { /* best-effort, failures are non-critical */ }
}

// ══════════════════════════════════════════════════════════════
//  HTML RENDERING (server-side, zero client JS)
// ══════════════════════════════════════════════════════════════

function htmlHead(title, desc, canon, extra = '') {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><meta name="description" content="${esc(desc)}"><link rel="canonical" href="${canon}"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${canon}"><meta property="og:type" content="article"><meta name="twitter:card" content="summary"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}"><link rel="alternate" type="application/rss+xml" title="RSS" href="/rss.xml">${extra}<style>${CSS}</style></head><body>`;
}

function htmlFoot(email) {
  return `<footer><p>Auto-generated summaries from public trend data. Sources listed. Content expires after 48 hours.</p><p>Contact: <a href="mailto:${esc(email)}">${esc(email)}</a> · <a href="/about">About</a> · <a href="/rss.xml">RSS</a></p></footer></body></html>`;
}

function renderArticle(p, linkTitle = true) {
  const ts = new Date(p.created_at).toUTCString();
  const h2 = linkTitle ? `<a href="/p/${esc(p.slug)}">${esc(p.title)}</a>` : esc(p.title);
  let h = `<article id="${esc(p.slug)}"><h2>${h2}</h2><time datetime="${esc(p.created_at)}">${ts}</time><p>${esc(p.body)}</p><ul>`;
  for (const b of JSON.parse(p.bullets)) h += `<li>${esc(b)}</li>`;
  return h + `</ul><p class="s">Sources: ${esc(p.sources)}</p></article>`;
}

function homePage(posts, siteUrl, email) {
  const desc = 'Live trending topic summaries, updated every minute. Auto-generated from public data.';
  const ld = JSON.stringify({ '@context':'https://schema.org', '@type':'ItemList',
    itemListElement: posts.map((p,i) => ({ '@type':'ListItem', position: i+1,
      url:`${siteUrl}/p/${p.slug}`, name: p.title }))
  }).replace(/<\//g, '<\\/');
  let h = htmlHead('Trending Now — Latest Trends', desc, `${siteUrl}/`,
    `<script type="application/ld+json">${ld}</script>`);
  h += `<header><h1><a href="/" style="color:inherit;text-decoration:none">Trending Now</a></h1><p>${esc(desc)}</p></header><main>`;
  for (const p of posts) h += renderArticle(p);
  if (!posts.length) h += '<p>No trends right now. Check back soon.</p>';
  return h + '</main>' + htmlFoot(email);
}

function postPage(post, related, siteUrl, email) {
  const desc  = post.body.length > 150 ? post.body.slice(0,147) + '...' : post.body;
  const sfx   = ' — Latest';
  const title = post.title.length + sfx.length <= 60 ? post.title + sfx : post.title.slice(0,60);
  const canon = `${siteUrl}/p/${post.slug}`;
  const ld = JSON.stringify({ '@context':'https://schema.org', '@type':'NewsArticle',
    headline: post.title, datePublished: post.created_at, dateModified: post.created_at,
    description: desc, mainEntityOfPage: canon,
    author:{ '@type':'Organization', name:'Trending Now' },
    publisher:{ '@type':'Organization', name:'Trending Now' }
  }).replace(/<\//g, '<\\/');
  let h = htmlHead(title, desc, canon, `<script type="application/ld+json">${ld}</script>`);
  h += `<main><p><a href="/">← All Trends</a></p>` + renderArticle(post, false);
  if (related.length) {
    h += '<nav><h3>Related Trends</h3><ul>';
    for (const r of related) h += `<li><a href="/p/${esc(r.slug)}">${esc(r.title)}</a></li>`;
    h += '</ul></nav>';
  }
  return h + '</main>' + htmlFoot(email);
}

function aboutPage(siteUrl, email) {
  return htmlHead('About — Trending Now', 'About this auto-generated trend site.', `${siteUrl}/about`) +
    `<main><p><a href="/">← Home</a></p><h1>About Trending Now</h1>` +
    `<p>This site automatically publishes short, factual summaries of publicly trending topics. ` +
    `Each summary is AI-generated using only facts from news reports in the Google Trends RSS feed.</p>` +
    `<ul><li>Content is auto-generated and expires after 48 hours.</li>` +
    `<li>No editorial oversight — summaries are AI-written from public data.</li>` +
    `<li>Sources are listed with every post.</li>` +
    `<li>No personal data is collected. No cookies.</li>` +
    `<li>Contact: <a href="mailto:${esc(email)}">${esc(email)}</a></li></ul></main>` + htmlFoot(email);
}

const gonePage = () => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Post Expired</title><style>${CSS}</style></head><body><main><h1>This post has expired</h1><p>Content on this site is automatically removed after 48 hours.</p><p><a href="/">← View current trends</a></p></main></body></html>`;

const endedPage = () => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Site Ended</title><style>${CSS}</style></head><body><main><h1>This site has ended</h1><p>This experimental trend site has concluded its run. All content has been removed.</p></main></body></html>`;

// ══════════════════════════════════════════════════════════════
//  SEO ENDPOINTS (sitemaps, robots, RSS feed)
// ══════════════════════════════════════════════════════════════

function sitemapXml(posts, u) {
  let x = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;
  x += `<url><loc>${u}/</loc><changefreq>always</changefreq><priority>1.0</priority></url>`;
  x += `<url><loc>${u}/about</loc><priority>0.3</priority></url>`;
  for (const p of posts) x += `<url><loc>${u}/p/${p.slug}</loc><lastmod>${p.created_at}</lastmod><priority>0.8</priority></url>`;
  return x + '</urlset>';
}

function newsSitemapXml(posts, u) {
  let x = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">`;
  for (const p of posts)
    x += `<url><loc>${u}/p/${p.slug}</loc><news:news><news:publication><news:name>Trending Now</news:name><news:language>en</news:language></news:publication><news:publication_date>${p.created_at}</news:publication_date><news:title>${esc(p.title)}</news:title></news:news></url>`;
  return x + '</urlset>';
}

const robotsTxt = u => `User-agent: *\nAllow: /\n\nSitemap: ${u}/sitemap.xml\nSitemap: ${u}/news-sitemap.xml\n`;

function rssFeed(posts, u) {
  let x = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Trending Now</title><link>${u}</link><description>Live trending topic summaries</description>`;
  for (const p of posts)
    x += `<item><title>${esc(p.title)}</title><link>${u}/p/${p.slug}</link><guid>${u}/p/${p.slug}</guid><pubDate>${new Date(p.created_at).toUTCString()}</pubDate><description>${esc(p.body)}</description></item>`;
  return x + '</channel></rss>';
}

// ══════════════════════════════════════════════════════════════
//  CRON HANDLER — runs every minute
// ══════════════════════════════════════════════════════════════

async function handleScheduled(env) {
  // Kill switch: stop all activity after SITE_END_AT
  if (env.SITE_END_AT && new Date() > new Date(env.SITE_END_AT)) return;

  const db = env.DB, now = isoNow(), siteUrl = `https://${env.SITE_HOST}`;
  const seenCutoff  = new Date(Date.now() - SEEN_TTL_MS).toISOString();
  const queueCutoff = new Date(Date.now() - 12 * 3600_000).toISOString();

  // 1. Batch cleanup: get expired slugs, then delete expired + stale data
  const expired = (await db.prepare(
    'SELECT slug FROM topics WHERE expires_at < ?'
  ).bind(now).all()).results;

  await db.batch([
    db.prepare('DELETE FROM topics WHERE expires_at < ?').bind(now),
    db.prepare('DELETE FROM seen_topics WHERE seen_at < ?').bind(seenCutoff),
    db.prepare("DELETE FROM topics WHERE status='queued' AND created_at < ?").bind(queueCutoff),
  ]);

  // Notify IndexNow about removed URLs
  if (expired.length)
    await pingIndexNow(env, expired.map(r => `${siteUrl}/p/${r.slug}`));

  // 2. Count today's published posts and promote queued if under cap
  let count = (await db.prepare(
    "SELECT COUNT(*) as c FROM topics WHERE status='published' AND created_at LIKE ?"
  ).bind(todayStr() + '%').first())?.c || 0;

  if (count < MAX_DAILY) {
    const queued = (await db.prepare(
      "SELECT id FROM topics WHERE status='queued' ORDER BY created_at LIMIT ?"
    ).bind(MAX_DAILY - count).all()).results;
    for (const q of queued) {
      await db.prepare("UPDATE topics SET status='published' WHERE id=?").bind(q.id).run();
      count++;
    }
  }

  // 3. Fetch RSS for each geo, process only NEW topics
  const geos = (env.GEO_LIST || 'US').split(',').map(g => g.trim()).filter(Boolean);
  const newUrls = [];

  for (const geo of geos) {
    let xml;
    if (env.DEV_MODE) { xml = MOCK_RSS; }
    else {
      try {
        const r = await fetch(`https://trends.google.com/trending/rss?geo=${geo}`,
          { headers: { 'User-Agent': 'TrendBot/1.0' } });
        if (!r.ok) continue;
        xml = await r.text();
      } catch { continue; }
    }

    for (const item of parseRSS(xml)) {
      const hash = slugify(item.title);

      // Skip duplicates
      if (await db.prepare('SELECT 1 FROM seen_topics WHERE topic_hash=?').bind(hash).first()) continue;
      // Skip sensitive content
      if (isSensitive(item.title)) continue;
      if (item.newsItems.some(n => isSensitive(n.title + ' ' + n.snippet))) continue;

      // Generate article content via LLM
      let content;
      try { content = env.DEV_MODE ? mockGenerate(item.title) : await generate(env, item.title, item.newsItems); }
      catch (e) { console.error('LLM failed:', item.title, e.message); continue; }

      const slug    = slugify(item.title);
      const created = isoNow();
      const expires = new Date(Date.now() + TTL_MS).toISOString();
      const status  = count >= MAX_DAILY ? 'queued' : 'published';

      try {
        await db.batch([
          db.prepare('INSERT INTO topics (slug,title,body,bullets,sources,topic,geo,status,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
            .bind(slug, content.title, content.body, JSON.stringify(content.bullets), content.sources, item.title, geo, status, created, expires),
          db.prepare('INSERT OR IGNORE INTO seen_topics (topic_hash,slug,seen_at) VALUES (?,?,?)')
            .bind(hash, slug, created),
        ]);
        if (status === 'published') { newUrls.push(`${siteUrl}/p/${slug}`); count++; }
      } catch { /* duplicate slug — skip gracefully */ }
    }
  }

  if (newUrls.length) await pingIndexNow(env, newUrls);
}

// ══════════════════════════════════════════════════════════════
//  FETCH HANDLER — routes all HTTP requests
// ══════════════════════════════════════════════════════════════

async function handleFetch(request, env) {
  const url     = new URL(request.url);
  const siteUrl = `https://${env.SITE_HOST || url.host}`;
  const email   = env.CONTACT_EMAIL || 'admin@example.com';
  const path    = url.pathname;

  // Kill switch: serve "ended" page, 410 for post URLs
  if (env.SITE_END_AT && new Date() > new Date(env.SITE_END_AT))
    return htmlRes(endedPage(), path.startsWith('/p/') ? 410 : 200);

  // Static text routes (no DB query needed)
  if (path === '/robots.txt')                    return textRes(robotsTxt(siteUrl));
  if (path === `/${env.INDEXNOW_KEY || '_'}.txt`) return textRes(env.INDEXNOW_KEY || '');
  if (path === '/about')                         return htmlRes(aboutPage(siteUrl, email));

  const db  = env.DB, now = isoNow();
  const live = async () => (await db.prepare(
    "SELECT * FROM topics WHERE status='published' AND expires_at > ? ORDER BY created_at DESC"
  ).bind(now).all()).results;

  if (path === '/sitemap.xml')      return xmlRes(sitemapXml(await live(), siteUrl));
  if (path === '/news-sitemap.xml') return xmlRes(newsSitemapXml(await live(), siteUrl));
  if (path === '/rss.xml')          return xmlRes(rssFeed(await live(), siteUrl));

  // Home page — all live posts in full, cached 60s at edge
  if (path === '/')
    return htmlRes(homePage(await live(), siteUrl, email), 200,
      { 'Cache-Control': 'public, s-maxage=60, max-age=30' });

  // Individual post page
  if (path.startsWith('/p/')) {
    const slug = path.slice(3).replace(/\/+$/, '');
    const post = await db.prepare(
      "SELECT * FROM topics WHERE slug=? AND status='published' AND expires_at > ?"
    ).bind(slug, now).first();

    if (post) {
      const related = (await db.prepare(
        "SELECT slug,title FROM topics WHERE slug!=? AND status='published' AND expires_at>? ORDER BY RANDOM() LIMIT 5"
      ).bind(slug, now).all()).results;
      return htmlRes(postPage(post, related, siteUrl, email), 200,
        { 'Cache-Control': 'public, s-maxage=60, max-age=30' });
    }
    // Known expired slug → 410 Gone; unknown → 404
    const wasSeen = await db.prepare('SELECT 1 FROM seen_topics WHERE slug=?').bind(slug).first();
    return htmlRes(gonePage(), wasSeen ? 410 : 404);
  }

  return new Response('Not Found', { status: 404 });
}

// ══════════════════════════════════════════════════════════════
//  MOCK RSS (used only when DEV_MODE env var is set)
// ══════════════════════════════════════════════════════════════

const MOCK_RSS = `<?xml version="1.0"?>
<rss xmlns:ht="https://trends.google.com/trends/trendingsearches/daily" version="2.0">
<channel><title>Mock Trends</title>
<item><title>AI Breakthrough 2024</title>
<ht:news_item><ht:news_item_title>Major AI Company Announces New Model</ht:news_item_title>
<ht:news_item_snippet>A leading tech company unveiled its latest AI model today with significant improvements in reasoning.</ht:news_item_snippet>
<ht:news_item_source>Tech Daily</ht:news_item_source></ht:news_item>
<ht:news_item><ht:news_item_title>Industry Reacts to AI News</ht:news_item_title>
<ht:news_item_snippet>Experts weigh in on the implications of the new technology for the industry.</ht:news_item_snippet>
<ht:news_item_source>Wire Report</ht:news_item_source></ht:news_item></item>
<item><title>Mars Mission Update</title>
<ht:news_item><ht:news_item_title>NASA Shares New Mars Rover Data</ht:news_item_title>
<ht:news_item_snippet>The latest data from Mars reveals interesting geological formations near the crater.</ht:news_item_snippet>
<ht:news_item_source>Space News</ht:news_item_source></ht:news_item></item>
<item><title>World Cup Qualifiers</title>
<ht:news_item><ht:news_item_title>Surprising Upsets in Qualifiers</ht:news_item_title>
<ht:news_item_snippet>Several underdog teams secured victories in last night's qualification matches.</ht:news_item_snippet>
<ht:news_item_source>Sports Wire</ht:news_item_source></ht:news_item>
<ht:news_item><ht:news_item_title>Star Player Scores Hat Trick</ht:news_item_title>
<ht:news_item_snippet>The forward scored three goals to lead the team to a decisive victory.</ht:news_item_snippet>
<ht:news_item_source>ESPN</ht:news_item_source></ht:news_item></item>
</channel></rss>`;

// ══════════════════════════════════════════════════════════════
//  EXPORT
// ══════════════════════════════════════════════════════════════

export default {
  fetch: handleFetch,
  scheduled(event, env, ctx) { ctx.waitUntil(handleScheduled(env)); },
};
