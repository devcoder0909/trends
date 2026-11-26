/**
 * Zero-budget Social Auto-Publisher:
 * - Free native APIs: Facebook Page (Meta Graph API), Bluesky (AT Protocol + link cards),
 *   Telegram Channel, Mastodon, Discord, Webhook (n8n/custom)
 * - Optional X (Twitter v2 OAuth 1.0a HMAC-SHA1) when X credentials are configured
 */

import { stripInlineSourceTags } from './config.js';

const timeoutSig = (ms = 7000) =>
  (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);

let bskySession = null;
let bskySessionExp = 0;

export function __resetSocialState() {
  bskySession = null;
  bskySessionExp = 0;
}

const encRfc3986 = str =>
  encodeURIComponent(String(str || ''))
    .replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

const cleanHashtag = s =>
  String(s || '')
    .replace(/ø/gi, 'o')
    .replace(/æ/gi, 'ae')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 3)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('')
    .slice(0, 24);

/**
 * Format concise social status with guaranteed intact URL and clean hashtags.
 */
export function formatSocialPost(post, siteUrl, maxChars = 280) {
  const url = `${siteUrl}/p/${post.slug}`;
  const imageUrl = `${siteUrl}/i/${post.slug}.jpg`;
  const tags = [...new Set([
    post.category ? `#${cleanHashtag(post.category)}` : '',
    post.topic ? `#${cleanHashtag(post.topic)}` : '',
    '#TrendingNow',
  ].filter(t => t.length > 2))].slice(0, 3);
  const tagLine = tags.join(' ');
  const tail = `\n\n${tagLine}\n${url}`;
  const budget = Math.max(40, maxChars - tail.length);

  const rawTitle = String(post.title || '').trim();
  const rawSummary = String(post.summary || '').trim();
  let lead = rawSummary ? `${rawTitle}\n\n${rawSummary}` : rawTitle;
  if (lead.length > budget) {
    lead = rawTitle.length <= budget
      ? rawTitle
      : `${rawTitle.slice(0, Math.max(12, budget - 3)).replace(/\s+\S*$/, '')}...`;
  }

  return {
    text: `${lead}${tail}`,
    title: rawTitle,
    summary: rawSummary,
    url,
    imageUrl,
    tags,
  };
}

function buildBskyFacets(text, url) {
  const enc = new TextEncoder();
  const facets = [];
  const urlStart = text.indexOf(url);
  if (urlStart >= 0) {
    const byteStart = enc.encode(text.slice(0, urlStart)).length;
    const byteEnd = byteStart + enc.encode(url).length;
    facets.push({
      index: { byteStart, byteEnd },
      features: [{ $type: 'app.bsky.richtext.facet#link', uri: url }],
    });
  }
  const tagRe = /(^|\s)(#[A-Za-z][A-Za-z0-9_]{1,30})/g;
  let m;
  while ((m = tagRe.exec(text))) {
    const startIdx = m.index + m[1].length;
    const tag = m[2];
    const byteStart = enc.encode(text.slice(0, startIdx)).length;
    const byteEnd = byteStart + enc.encode(tag).length;
    facets.push({
      index: { byteStart, byteEnd },
      features: [{ $type: 'app.bsky.richtext.facet#tag', tag: tag.slice(1) }],
    });
  }
  return facets;
}

async function getBlueskySession(env, budget) {
  const now = Date.now();
  if (bskySession && now < bskySessionExp) return bskySession;
  if (budget && budget.remaining() <= 1) return null;
  if (budget) budget.spend(1);

  const pds = (env.BLUESKY_PDS || 'https://bsky.social').replace(/\/+$/, '');
  const res = await fetch(`${pds}/xrpc/com.atproto.server.createSession`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: timeoutSig(7000),
    body: JSON.stringify({
      identifier: env.BLUESKY_HANDLE,
      password: env.BLUESKY_APP_PASSWORD,
    }),
  });
  if (!res.ok) throw new Error(`Bluesky auth HTTP ${res.status}`);
  bskySession = await res.json();
  bskySessionExp = now + 50 * 60_000;
  return bskySession;
}

async function postToBluesky(env, item, budget) {
  if (!env.BLUESKY_HANDLE || !env.BLUESKY_APP_PASSWORD) return;
  if (budget && budget.remaining() <= 1) return;
  const pds = (env.BLUESKY_PDS || 'https://bsky.social').replace(/\/+$/, '');
  const sess = await getBlueskySession(env, budget);
  if (!sess) return;
  if (budget) budget.spend(1);

  const payload = {
    repo: sess.did,
    collection: 'app.bsky.feed.post',
    record: {
      $type: 'app.bsky.feed.post',
      text: item.text,
      createdAt: new Date().toISOString(),
      langs: ['en'],
      facets: buildBskyFacets(item.text, item.url),
      embed: {
        $type: 'app.bsky.embed.external',
        external: {
          uri: item.url,
          title: item.title,
          description: item.summary || item.title,
        },
      },
    },
  };

  let res = await fetch(`${pds}/xrpc/com.atproto.repo.createRecord`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${sess.accessJwt}`,
    },
    signal: timeoutSig(7000),
    body: JSON.stringify(payload),
  });
  if (res.status === 401) {
    bskySession = null;
    bskySessionExp = 0;
  }
  if (!res.ok) throw new Error(`Bluesky post HTTP ${res.status}`);
}

async function postToTelegram(env, item, budget) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHANNEL_ID) return;
  if (budget && budget.remaining() <= 1) return;
  if (budget) budget.spend(1);

  const escTg = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const caption = `<b>${escTg(item.title)}</b>\n\n${escTg(item.summary)}\n\n${escTg(item.tags.join(' '))}\n<a href="${escTg(item.url)}">Read full briefing</a>`;
  const replyMarkup = {
    inline_keyboard: [[{ text: 'Read Full Briefing ->', url: item.url }]],
  };

  const base = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
  const res = await fetch(`${base}/sendPhoto`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: timeoutSig(7000),
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHANNEL_ID,
      photo: item.imageUrl,
      caption: caption.slice(0, 1024),
      parse_mode: 'HTML',
      reply_markup: replyMarkup,
    }),
  });
  if (!res.ok && (!budget || budget.remaining() > 1)) {
    if (budget) budget.spend(1);
    const fallback = await fetch(`${base}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: timeoutSig(7000),
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHANNEL_ID,
        text: caption,
        parse_mode: 'HTML',
        reply_markup: replyMarkup,
      }),
    });
    if (!fallback.ok) throw new Error(`Telegram HTTP ${fallback.status}`);
  }
}

async function postToMastodon(env, item, budget) {
  if (!env.MASTODON_INSTANCE || !env.MASTODON_TOKEN) return;
  if (budget && budget.remaining() <= 1) return;
  if (budget) budget.spend(1);

  const base = env.MASTODON_INSTANCE.replace(/\/+$/, '');
  const status = formatSocialPost({ slug: item.slug, ...item }, item.siteUrl, 480).text;
  const res = await fetch(`${base}/api/v1/statuses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.MASTODON_TOKEN}`,
    },
    signal: timeoutSig(7000),
    body: JSON.stringify({ status, visibility: 'public' }),
  });
  if (!res.ok) throw new Error(`Mastodon HTTP ${res.status}`);
}

async function postToDiscord(env, item, budget) {
  if (!env.DISCORD_WEBHOOK_URL) return;
  if (budget && budget.remaining() <= 1) return;
  if (budget) budget.spend(1);

  const res = await fetch(env.DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: timeoutSig(7000),
    body: JSON.stringify({
      embeds: [{
        title: item.title,
        url: item.url,
        description: `${item.summary}\n\n${item.tags.join(' ')}`,
        image: { url: item.imageUrl },
        color: 0x8ab4f8,
        footer: { text: 'Trending Now' },
      }],
    }),
  });
  if (!res.ok) throw new Error(`Discord HTTP ${res.status}`);
}

async function postToWebhook(env, item, post, budget) {
  if (!env.SOCIAL_WEBHOOK_URL) return;
  if (budget && budget.remaining() <= 1) return;
  if (budget) budget.spend(1);

  const headers = { 'Content-Type': 'application/json' };
  if (env.SOCIAL_WEBHOOK_SECRET) headers['X-Webhook-Secret'] = env.SOCIAL_WEBHOOK_SECRET;
  const res = await fetch(env.SOCIAL_WEBHOOK_URL, {
    method: 'POST',
    headers,
    signal: timeoutSig(7000),
    body: JSON.stringify({
      title: item.title,
      summary: item.summary,
      url: item.url,
      imageUrl: item.imageUrl,
      category: post.category || 'News',
      topic: post.topic || '',
      hashtags: item.tags,
      publishedAt: new Date().toISOString(),
    }),
  });
  if (!res.ok) throw new Error(`Webhook HTTP ${res.status}`);
}

export async function signOAuth1Header(method, endpoint, { consumerKey, consumerSecret, accessToken, accessSecret }) {
  const oauth = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: crypto.randomUUID().replace(/-/g, ''),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: accessToken,
    oauth_version: '1.0',
  };
  const paramStr = Object.keys(oauth)
    .sort()
    .map(k => `${encRfc3986(k)}=${encRfc3986(oauth[k])}`)
    .join('&');
  const baseStr = `${method.toUpperCase()}&${encRfc3986(endpoint)}&${encRfc3986(paramStr)}`;
  const signingKey = `${encRfc3986(consumerSecret)}&${encRfc3986(accessSecret)}`;

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signingKey),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(baseStr));
  let bin = '';
  for (const b of new Uint8Array(sigBuf)) bin += String.fromCharCode(b);
  oauth.oauth_signature = btoa(bin);

  return 'OAuth ' + Object.keys(oauth)
    .sort()
    .map(k => `${encRfc3986(k)}="${encRfc3986(oauth[k])}"`)
    .join(', ');
}

async function postToX(env, item, budget) {
  if (!env.X_CONSUMER_KEY || !env.X_CONSUMER_SECRET || !env.X_ACCESS_TOKEN || !env.X_ACCESS_SECRET) return;
  if (budget && budget.remaining() <= 1) return;
  if (budget) budget.spend(1);

  const endpoint = 'https://api.x.com/2/tweets';
  const authHeader = await signOAuth1Header('POST', endpoint, {
    consumerKey: env.X_CONSUMER_KEY,
    consumerSecret: env.X_CONSUMER_SECRET,
    accessToken: env.X_ACCESS_TOKEN,
    accessSecret: env.X_ACCESS_SECRET,
  });
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader,
    },
    signal: timeoutSig(7000),
    body: JSON.stringify({ text: formatSocialPost({ slug: item.slug, ...item }, item.siteUrl, 275).text }),
  });
  if (!res.ok) throw new Error(`X HTTP ${res.status}`);
}

/**
 * Format an engaging, scannable Facebook Page post designed for high click-through
 * paired with Facebook's clickable 1200x630 Open Graph link card preview.
 */
export function formatFacebookPost(post, siteUrl) {
  const formatted = formatSocialPost(post, siteUrl, 295);
  const catLabel = String(post.category || 'News').toUpperCase();
  const title = stripInlineSourceTags(formatted.title);
  const summary = stripInlineSourceTags(formatted.summary);

  let rawFacts = post.key_facts;
  if (typeof rawFacts === 'string') {
    try { rawFacts = JSON.parse(rawFacts); } catch { rawFacts = []; }
  }
  const bullets = Array.isArray(rawFacts)
    ? rawFacts.map(f => stripInlineSourceTags(f)).filter(Boolean).slice(0, 2)
    : [];

  const lines = [`[${catLabel} BRIEFING] ${title}`];
  if (summary) lines.push('', summary);
  if (bullets.length) {
    lines.push('', 'Key takeaways:', ...bullets.map(b => `• ${b}`));
  }
  lines.push('', `Read the full briefing & timeline:`, formatted.url);
  if (formatted.tags.length) lines.push('', formatted.tags.join(' '));

  return {
    message: lines.join('\n'),
    link: formatted.url,
  };
}

async function postToFacebook(env, post, siteUrl, budget) {
  if (!env.FB_PAGE_ID || !env.FB_PAGE_TOKEN) return;
  if (budget && budget.remaining() <= 1) return;
  if (budget) budget.spend(1);

  const ver = (env.FB_GRAPH_VERSION || 'v22.0').replace(/^\/+|\/+$/g, '');
  const fbPost = formatFacebookPost(post, siteUrl);
  const res = await fetch(`https://graph.facebook.com/${ver}/${encodeURIComponent(env.FB_PAGE_ID)}/feed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: timeoutSig(7000),
    body: JSON.stringify({
      message: fbPost.message,
      link: fbPost.link,
      access_token: env.FB_PAGE_TOKEN,
    }),
  });
  if (!res.ok) throw new Error(`Facebook HTTP ${res.status}`);
}

/**
 * Broadcast newly published trending stories (max 2 per tick) across all configured
 * zero-budget social platforms without interrupting indexing on any channel failure.
 */
export async function publishToSocial(env, posts, siteUrl, budget = null, { force = false } = {}) {
  if (!posts?.length) return [];
  if (!force && String(env?.DEV_MODE || '').toLowerCase() === 'true') return [];

  const hasAnyTarget = Boolean(
    (env.FB_PAGE_ID && env.FB_PAGE_TOKEN) ||
    (env.BLUESKY_HANDLE && env.BLUESKY_APP_PASSWORD) ||
    (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHANNEL_ID) ||
    (env.MASTODON_INSTANCE && env.MASTODON_TOKEN) ||
    env.DISCORD_WEBHOOK_URL ||
    env.SOCIAL_WEBHOOK_URL ||
    (env.X_CONSUMER_KEY && env.X_ACCESS_TOKEN)
  );
  if (!hasAnyTarget) return [];

  const results = [];
  for (const post of posts.slice(0, 2)) {
    const formatted = formatSocialPost(post, siteUrl, 295);
    const item = { ...formatted, slug: post.slug, siteUrl };
    const tasks = [
      ['facebook', () => postToFacebook(env, post, siteUrl, budget)],
      ['bluesky', () => postToBluesky(env, item, budget)],
      ['telegram', () => postToTelegram(env, item, budget)],
      ['mastodon', () => postToMastodon(env, item, budget)],
      ['discord', () => postToDiscord(env, item, budget)],
      ['webhook', () => postToWebhook(env, item, post, budget)],
      ['x', () => postToX(env, item, budget)],
    ];
    const settled = await Promise.allSettled(tasks.map(([, fn]) => fn()));
    settled.forEach((s, i) => {
      if (s.status === 'rejected') {
        console.error(`Social ${tasks[i][0]} error:`, s.reason?.message || s.reason);
      }
      results.push({ slug: post.slug, platform: tasks[i][0], ok: s.status === 'fulfilled' });
    });
  }
  return results;
}
