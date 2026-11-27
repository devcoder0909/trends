/**
 * `npm run test:content`
 * Runs 10 mock topics (sports, tech, movie, weather, ambiguous name,
 * business, science, gaming, sensitive, single-source) through the full
 * pipeline and verifies quality-gate rejections.
 */

import { generateAndValidatePost, validateDraft, callLLM, __resetAiCooldowns } from '../src/content.js';
import { formatSocialPost, formatFacebookPost, formatTelegramPost, publishToSocial, signOAuth1Header, __resetSocialState } from '../src/social.js';
import { classifyCategory, formatDisplayTopic, stripInlineSourceTags } from '../src/config.js';
import { rankTopics, parseGoogleNewsRSS, extractOgMetaImage, extractHighResSourceImage, fetchWikiEntityImage } from '../src/rss.js';
import { buildMetaDescription, slugify, CSS } from '../src/render.js';
import { isNearDuplicateTopic } from '../src/index.js';

const NOW = 'Thu, 26 Nov 2026 14:00:00 GMT';

const MOCK_TOPICS = [
  {
    expect: 'PASS',
    label: 'Sports',
    topic: 'Arsenal vs Chelsea',
    approxTraffic: 500000,
    sources: [
      { title: 'Arsenal Beats Chelsea 2-1 at Emirates Stadium', snippet: 'Bukayo Saka scored the winning goal in the 78th minute during the Premier League match.', source: 'BBC Sport', url: 'https://example.com/1', pubDate: NOW },
      { title: 'Chelsea Falls 2-1 as Arsenal Climbs Table', snippet: 'Arsenal moved to 34 points after Thursday match in London.', source: 'ESPN', url: 'https://example.com/2', pubDate: NOW },
    ],
  },
  {
    expect: 'PASS',
    label: 'Tech',
    topic: 'Apple M5 MacBook',
    approxTraffic: 300000,
    sources: [
      { title: 'Apple Announces M5 MacBook Pro With 24-Hour Battery', snippet: 'The new M5 MacBook laptop starts at $1599 and ships on December 4.', source: 'The Verge', url: 'https://example.com/3', pubDate: NOW },
      { title: 'Apple Unveils M5 Chip Architecture for MacBook', snippet: 'Benchmarks show 20 percent faster neural processing compared to M4.', source: 'TechCrunch', url: 'https://example.com/4', pubDate: NOW },
    ],
  },
  {
    expect: 'PASS',
    label: 'Movie',
    topic: 'Dune Messiah',
    approxTraffic: 250000,
    sources: [
      { title: 'Dune Messiah Sets December 18 Release Date', snippet: 'Warner Bros confirmed the sci-fi sequel directed by Denis Villeneuve.', source: 'Variety', url: 'https://example.com/5', pubDate: NOW },
      { title: 'Timothee Chalamet Returns for Dune Messiah Filming', snippet: 'Production wrapped after five months on location.', source: 'Hollywood Reporter', url: 'https://example.com/6', pubDate: NOW },
    ],
  },
  {
    expect: 'PASS',
    label: 'Weather',
    topic: 'Storm Elena',
    approxTraffic: 400000,
    sources: [
      { title: 'Storm Elena Brings 60 mph Winds to Gulf Coast', snippet: 'National Weather Service issued coastal flood advisories through Friday.', source: 'Weather Channel', url: 'https://example.com/7', pubDate: NOW },
      { title: 'Airlines Cancel 120 Flights Ahead of Storm Elena', snippet: 'Heavy rain and gusts are expected across coastal counties overnight.', source: 'AP News', url: 'https://example.com/8', pubDate: NOW },
    ],
  },
  {
    expect: 'PASS',
    label: 'Ambiguous Name',
    topic: 'Mercury',
    approxTraffic: 180000,
    sources: [
      { title: 'NASA Probe Captures New Crater Map of Planet Mercury', snippet: 'Scientists observed bright mineral deposits across the northern basin of Mercury, the innermost planet.', source: 'Space.com', url: 'https://example.com/9', pubDate: NOW },
      { title: 'Mercury Orbital Survey Reveals Ice Shadows in Polar Craters', snippet: 'Researchers confirmed new thermal readings from the spacecraft around planet Mercury.', source: 'Reuters', url: 'https://example.com/10', pubDate: NOW },
    ],
  },
  {
    expect: 'PASS',
    label: 'Business',
    topic: 'Nvidia Q3 Earnings',
    approxTraffic: 350000,
    sources: [
      { title: 'Nvidia Reports $35 Billion Quarterly Revenue', snippet: 'Data center chip sales rose 94 percent year over year.', source: 'CNBC', url: 'https://example.com/11', pubDate: NOW },
      { title: 'Nvidia Shares Move Higher After Q3 Earnings Beat', snippet: 'Chief executive Jensen Huang cited steady cloud demand for Blackwell chips.', source: 'Bloomberg', url: 'https://example.com/12', pubDate: NOW },
    ],
  },
  {
    expect: 'PASS',
    label: 'Science',
    topic: 'Artemis Launch Window',
    approxTraffic: 150000,
    sources: [
      { title: 'NASA Sets New Artemis Lunar Mission Launch Window', snippet: 'Engineers completed fuel tank pressure tests at Kennedy Space Center.', source: 'NASA Watch', url: 'https://example.com/13', pubDate: NOW },
      { title: 'Artemis Crew Prepares for Four-Day Orbit Test', snippet: 'Flight directors scheduled a dress rehearsal ahead of liftoff.', source: 'CNN', url: 'https://example.com/14', pubDate: NOW },
    ],
  },
  {
    expect: 'PASS',
    label: 'Gaming',
    topic: 'Zelda Switch 2 Edition',
    approxTraffic: 220000,
    sources: [
      { title: 'Nintendo Previews Zelda Switch 2 Edition at 60 FPS', snippet: 'The upgraded edition adds faster loading and higher resolution textures.', source: 'IGN', url: 'https://example.com/15', pubDate: NOW },
      { title: 'Zelda Switch 2 Edition Launches Alongside Hardware', snippet: 'Nintendo confirmed existing save files transfer directly.', source: 'GameSpot', url: 'https://example.com/16', pubDate: NOW },
    ],
  },
  {
    expect: 'REJECT',
    label: 'Sensitive Topic',
    topic: 'Highway Pileup Death Toll',
    approxTraffic: 900000,
    sources: [
      { title: 'Three Killed in Multi-Vehicle Highway Accident', snippet: 'Local police confirmed a fatal crash on the interstate.', source: 'Local News', url: 'https://example.com/17', pubDate: NOW },
      { title: 'Interstate Closed After Deadly Pileup', snippet: 'Emergency crews remained on scene.', source: 'Regional Wire', url: 'https://example.com/18', pubDate: NOW },
    ],
  },
  {
    expect: 'REJECT',
    label: 'Single Source',
    topic: 'Oakwood Harvest Fair',
    approxTraffic: 20000,
    sources: [
      { title: 'Oakwood Harvest Fair Opens This Weekend With 15 Vendors', snippet: 'Town organizers announced Saturday hours from 9 AM to 5 PM.', source: 'Oakwood Gazette', url: 'https://example.com/19', pubDate: NOW },
    ],
  },
];

async function run() {
  let failures = 0;
  const existingTitles = new Set();

  // Verify ranking places high-traffic multi-source topics above low-traffic ones
  const ranked = rankTopics(MOCK_TOPICS.map(t => ({ title: t.topic, approxTraffic: t.approxTraffic, newsItems: t.sources, geo: 'US' })));
  if (ranked[0].title !== 'Highway Pileup Death Toll' || ranked[ranked.length - 1].title !== 'Oakwood Harvest Fair') {
    console.error('FAIL: topic ranking order unexpected');
    failures++;
  }
  const multiGeo = rankTopics([
    { title: 'Global Event', approxTraffic: 100000, geo: 'GB', newsItems: [{ title: 'A', source: 'BBC', snippet: '' }] },
    { title: 'Global Event', approxTraffic: 100000, geo: 'US', newsItems: [{ title: 'B', source: 'CNN', snippet: '' }] },
  ]);
  if (multiGeo.length !== 1 || multiGeo[0].geo !== 'US' || multiGeo[0].approxTraffic !== 200000) {
    console.error('FAIL: multi-geo merge/US priority unexpected');
    failures++;
  }

  console.log('=== CONTENT PIPELINE TEST (10 MOCK TOPICS) ===\n');
  for (const item of MOCK_TOPICS) {
    const res = await generateAndValidatePost(
      { DEV_MODE: 'true' },
      { topic: item.topic, sources: item.sources },
      existingTitles,
      { forceMock: true }
    );
    const actual = res.ok ? 'PASS' : 'REJECT';
    const matched = actual === item.expect;
    if (!matched) failures++;

    if (res.ok) {
      existingTitles.add(res.post.title.toLowerCase());
      console.log(`[${actual}] (${item.label}) ${item.topic} -> "${res.post.title}" [${res.post.category}]`);
    } else {
      console.log(`[${actual}] (${item.label}) ${item.topic} -> Reason: ${res.reason}`);
    }
    if (!matched) {
      console.error(`  ^ ERROR: Expected ${item.expect}, got ${actual}`);
    }
  }

  // Extra quality-gate verification checks
  console.log('\n=== QUALITY GATE CHECKS ===\n');
  const baseTopic = MOCK_TOPICS[0];
  const validRes = await generateAndValidatePost(
    { DEV_MODE: 'true' },
    { topic: baseTopic.topic, sources: baseTopic.sources },
    new Set(),
    { forceMock: true }
  );
  const baseDraft = validRes.post;

  const badCases = [
    ['Unsupported number (999)', { ...baseDraft, what_happened: baseDraft.what_happened + ' Over 999 fans cheered loudly.' }],
    ['Unsupported proper name', { ...baseDraft, what_happened: baseDraft.what_happened + ' Coach Marcus Vance celebrated afterward.' }],
    ['Banned phrase "shocking"', { ...baseDraft, why_trending: 'This shocking outcome drew widespread reaction across sports media outlets while supporters reviewed key moments from the London match.' }],
    ['Banned phrase "breaking" not in sources', { ...baseDraft, title: 'Breaking Arsenal vs Chelsea Score' }],
    ['Title > 60 chars', { ...baseDraft, title: 'Arsenal vs Chelsea Match Result and Complete Detailed Postgame Analysis Report' }],
    ['Word count too short', { ...baseDraft, what_happened: 'Arsenal won.', why_trending: 'Fans watched.', key_facts: ['A [BBC Sport]', 'B [ESPN]', 'C [BBC Sport]'], what_to_know_next: 'More later.' }],
    ['Duplicate live title', baseDraft, new Set([baseDraft.title.toLowerCase()])],
  ];

  for (const [name, draft, dupTitles = new Set()] of badCases) {
    const check = validateDraft(draft, baseTopic.topic, baseTopic.sources, dupTitles);
    if (!check.ok) {
      console.log(`[REJECT] ${name} -> ${check.reason}`);
    } else {
      console.error(`[FAIL] ${name} -> Expected REJECT but passed`);
      failures++;
    }
  }

  // Resilience regression checks (prevent past production false positives & test grounded fallback)
  const mayVerbDraft = {
    ...baseDraft,
    why_trending: 'Officials may confirm schedule details as supporters review key moments from the Premier League match in London.',
    what_to_know_next: 'Record-breaking viewership may continue ahead of upcoming Arsenal and Chelsea fixtures this weekend.',
  };
  const mayCheck = validateDraft(mayVerbDraft, baseTopic.topic, baseTopic.sources, new Set());
  if (!mayCheck.ok) {
    console.error(`[FAIL] Modal verb "may" + hyphenated "record-breaking" -> ${mayCheck.reason}`);
    failures++;
  } else {
    console.log('[PASS] Modal verb "may" & compound "record-breaking" allowed without false positive');
  }

  const mayDateBad = {
    ...baseDraft,
    what_happened: baseDraft.what_happened + ' A May 5 replay was noted by reporters.',
  };
  if (validateDraft(mayDateBad, baseTopic.topic, baseTopic.sources, new Set()).ok) {
    console.error('[FAIL] Ungrounded calendar date "May 5" should reject');
    failures++;
  } else {
    console.log('[REJECT] Ungrounded calendar date "May 5" properly rejected');
  }

  const instDraft = {
    ...baseDraft,
    why_trending: 'The University and The UK Ministry watched Premier League reaction in London after Arsenal played Chelsea.',
  };
  const instCheck = validateDraft(instDraft, baseTopic.topic, baseTopic.sources, new Set());
  if (!instCheck.ok) {
    console.error(`[FAIL] Institutional noun phrase check -> ${instCheck.reason}`);
    failures++;
  } else {
    console.log('[PASS] Institutional generic noun phrases allowed without false positive');
  }

  const fallbackRes = await generateAndValidatePost(
    { AI: { run() { throw new Error('Too many subrequests by single Worker invocation.'); } } },
    { topic: baseTopic.topic, sources: baseTopic.sources },
    new Set()
  );
  if (!fallbackRes.ok || !fallbackRes.usedFallback) {
    console.error('[FAIL] Deterministic multi-outlet fallback did not recover from LLM infra error');
    failures++;
  } else {
    console.log('[PASS] Deterministic multi-outlet failsafe recovered verified topic from LLM infra failure');
  }

  // Verify SEO meta description length (120-158 chars), slugify, CSS size, and near-duplicate filter
  const metaDesc = buildMetaDescription(baseDraft);
  if (metaDesc.length < 120 || metaDesc.length > 158) {
    console.error(`[FAIL] Meta description length ${metaDesc.length} not in 120-158`);
    failures++;
  } else {
    console.log(`[PASS] Meta description length ${metaDesc.length} chars (120-158)`);
  }
  if (slugify("d'andre swift") !== 'dandre-swift') {
    console.error('[FAIL] slugify apostrophe handling');
    failures++;
  }
  const cssBytes = Buffer.byteLength(CSS, 'utf8');
  if (cssBytes >= 1536) {
    console.error(`[FAIL] CSS ${cssBytes} bytes >= 1536`);
    failures++;
  } else {
    console.log(`[PASS] CSS size ${cssBytes} bytes (< 1536)`);
  }
  if (!isNearDuplicateTopic('nba games', [{ topic: 'nba games today', title: 'NBA Games Today' }]) ||
      isNearDuplicateTopic('apple macbook', [{ topic: 'nba games today', title: 'NBA Games Today' }])) {
    console.error('[FAIL] Near-duplicate detection check failed');
    failures++;
  } else {
    console.log('[PASS] Near-duplicate topic detection verified');
  }

  // Verify free-tier AI routing (Gemini-first + 4006 Workers AI circuit breaker) & Display Topic Title Case
  if (formatDisplayTopic('derrick moore') !== 'Derrick Moore' ||
      formatDisplayTopic('bears qb') !== 'Bears QB' ||
      formatDisplayTopic('nfl') !== 'NFL') {
    console.error('[FAIL] formatDisplayTopic title casing check failed');
    failures++;
  } else {
    console.log('[PASS] formatDisplayTopic preserves acronyms & Title Cases lowercase trends');
  }

  __resetAiCooldowns();
  let aiCalls = 0;
  let workersAiCallsAfter4006 = 0;
  try {
    await callLLM({
      AI: {
        run() {
          workersAiCallsAfter4006++;
          throw new Error('4006: you have used up your daily free allocation of 10,000 neurons');
        },
      },
    }, 'test');
  } catch {}
  try {
    await callLLM({
      AI: {
        run() {
          aiCalls++;
          return { response: 'should be skipped by cooldown' };
        },
      },
    }, 'test');
  } catch {}
  if (workersAiCallsAfter4006 !== 1 || aiCalls !== 0) {
    console.error(`[FAIL] Workers AI 4006 circuit breaker expected 1 then 0 calls, got ${workersAiCallsAfter4006}, ${aiCalls}`);
    failures++;
  } else {
    console.log('[PASS] Workers AI 4006 daily quota circuit breaker stops wasted subrequests');
  }
  __resetAiCooldowns();

  // Verify OpenAI-compatible additional free AI endpoint routing (e.g. NVIDIA NIM) + 429 cooldown failover
  const origFetch = globalThis.fetch;
  const hitUrls = [];
  try {
    globalThis.fetch = async (url, init) => {
      hitUrls.push(String(url));
      if (String(url).includes('nvidia.com')) {
        return new Response('rate limit', { status: 429 });
      }
      if (String(url).includes('mistral.ai')) {
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true, did: 'did:plc:test', accessJwt: 'jwt123' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const aiOut = await callLLM({ NVIDIA_API_KEY: 'nv-test', MISTRAL_API_KEY: 'ms-test' }, 'test');
    const aiOut2 = await callLLM({ NVIDIA_API_KEY: 'nv-test', MISTRAL_API_KEY: 'ms-test' }, 'test2');
    const nvidiaCalls = hitUrls.filter(u => u.includes('nvidia.com')).length;
    const mistralCalls = hitUrls.filter(u => u.includes('mistral.ai')).length;
    if (aiOut !== '{"ok":true}' || aiOut2 !== '{"ok":true}' || nvidiaCalls !== 1 || mistralCalls !== 2) {
      console.error(`[FAIL] OpenAI-compat routing/cooldown unexpected: nv=${nvidiaCalls}, ms=${mistralCalls}`);
      failures++;
    } else {
      console.log('[PASS] NVIDIA/Mistral OpenAI-compat free routing & 429 cooldown failover verified');
    }

    // Verify zero-budget social formatting, Bluesky facets, Telegram/Mastodon/Discord/Webhook/X publishing
    __resetSocialState();
    const longFormatted = formatSocialPost({
      slug: 'arsenal-vs-chelsea',
      title: 'Arsenal vs Chelsea Match Result and Latest Score With Extra Long Text',
      summary: 'A'.repeat(280),
      category: 'Sports',
      topic: 'arsenal vs chelsea',
    }, 'https://trends.example.com', 280);
    if (!longFormatted.text.endsWith('https://trends.example.com/p/arsenal-vs-chelsea') || longFormatted.text.length > 280) {
      console.error('[FAIL] formatSocialPost exceeded limit or clipped URL');
      failures++;
    } else {
      console.log('[PASS] formatSocialPost preserves URL within 280-char limit');
    }

    const socialRequests = [];
    globalThis.fetch = async (url, init) => {
      socialRequests.push({ url: String(url), headers: init?.headers || {}, body: init?.body });
      return new Response(JSON.stringify({ did: 'did:plc:test', accessJwt: 'jwt-bsky' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const oauthSig = await signOAuth1Header('POST', 'https://api.x.com/2/tweets', {
      consumerKey: 'ck', consumerSecret: 'cs', accessToken: 'at', accessSecret: 'as',
    });
    const fbFormatted = formatFacebookPost({
      slug: 'arsenal-vs-chelsea',
      title: 'Arsenal vs Chelsea Match Result',
      summary: 'Arsenal moved top with a 2-1 win [ESPN].',
      key_facts: ['Bukayo Saka scored in minute 78 [BBC Sport].', 'Arsenal reached 34 points [ESPN].'],
      category: 'Sports',
      topic: 'arsenal vs chelsea',
    }, 'https://trends.example.com');
    const fbClean = fbFormatted.link === 'https://trends.example.com/p/arsenal-vs-chelsea' &&
      fbFormatted.message.includes('[SPORTS BRIEFING]') &&
      fbFormatted.message.includes('Key takeaways:') &&
      !fbFormatted.message.includes('[ESPN]') &&
      !fbFormatted.message.includes('[BBC Sport]');

    const tgFormatted = formatTelegramPost({
      slug: 'arsenal-vs-chelsea',
      title: 'Arsenal vs Chelsea Match Result',
      summary: 'Arsenal moved top with a 2-1 win [ESPN].',
      key_facts: ['Bukayo Saka scored in minute 78 [BBC Sport].', 'Arsenal reached 34 points [ESPN].'],
      category: 'Sports',
      topic: 'arsenal vs chelsea',
      sources: 'ESPN, BBC Sport',
    }, 'https://trends.example.com');
    const tgClean = tgFormatted.caption.includes('<b>[SPORTS] Arsenal vs Chelsea Match Result</b>') &&
      tgFormatted.caption.includes('• Bukayo Saka scored') &&
      !tgFormatted.caption.includes('[ESPN]') &&
      tgFormatted.caption.length <= 1024 &&
      tgFormatted.replyMarkup.inline_keyboard[0][0].url === 'https://trends.example.com/p/arsenal-vs-chelsea';

    const pubResults = await publishToSocial({
      FB_PAGE_ID: '1234567890',
      FB_PAGE_TOKEN: 'fb-tok',
      BLUESKY_HANDLE: 'trends.bsky.social',
      BLUESKY_APP_PASSWORD: 'app-pw',
      TELEGRAM_BOT_TOKEN: '123:abc',
      TELEGRAM_CHANNEL_ID: '@trends_ch',
      MASTODON_INSTANCE: 'https://mastodon.social',
      MASTODON_TOKEN: 'm-tok',
      DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/a',
      SOCIAL_WEBHOOK_URL: 'https://hooks.example.com/social',
      X_CONSUMER_KEY: 'ck',
      X_CONSUMER_SECRET: 'cs',
      X_ACCESS_TOKEN: 'at',
      X_ACCESS_SECRET: 'as',
    }, [
      {
        slug: 'arsenal-vs-chelsea',
        title: 'Arsenal vs Chelsea',
        summary: 'Summary line.',
        key_facts: ['Fact 1', 'Fact 2'],
        category: 'Sports',
        topic: 'arsenal vs chelsea',
      },
      {
        slug: 'apple-m5-macbook',
        title: 'Apple M5 MacBook',
        summary: 'Summary line 2.',
        key_facts: ['Fact A', 'Fact B'],
        category: 'Tech',
        topic: 'apple m5 macbook',
      },
    ], 'https://trends.example.com', null, { force: true });
    const allOk = pubResults.length === 14 && pubResults.every(r => r.ok);
    const hasFacet = socialRequests.some(r => r.url.includes('createRecord') && String(r.body).includes('app.bsky.richtext.facet#link'));
    const hasFbFeed = socialRequests.some(r => r.url.includes('graph.facebook.com/') && r.url.includes('/1234567890/feed'));
    const webhookCalls = socialRequests.filter(r => r.url.includes('hooks.example.com/social'));
    const hasWebhookFbMsg = webhookCalls.length === 1 && String(webhookCalls[0].body).includes('facebookMessage');
    if (!allOk || !hasFacet || !hasFbFeed || !hasWebhookFbMsg || !fbClean || !tgClean || !oauthSig.startsWith('OAuth ')) {
      console.error(`[FAIL] publishToSocial results=${JSON.stringify(pubResults)}, hasFacet=${hasFacet}, hasFbFeed=${hasFbFeed}, webhookCalls=${webhookCalls.length}, fbClean=${fbClean}, tgClean=${tgClean}`);
      failures++;
    } else {
      console.log('[PASS] Multi-platform zero-budget social publish (Facebook Page, Bluesky, Telegram, Mastodon, Discord, Webhook [1/tick], X) verified');
    }
  } finally {
    globalThis.fetch = origFetch;
    __resetAiCooldowns();
    __resetSocialState();
  }

  // Verify inline [Outlet] / attribution stripping in content prose & bullets while preserving subjects
  const c1 = stripInlineSourceTags(
    'The Bureau of Meteorology issued a severe weather update on Thursday, November 26, 2026 [The Bureau of Meteorology]',
    'The Bureau of Meteorology, Bendigo Advertiser, News24'
  );
  const c2 = stripInlineSourceTags(
    'Tropical moisture is fueling wild conditions across parts of central Australia [News24]',
    'The Bureau of Meteorology, Bendigo Advertiser, News24'
  );
  const c3 = stripInlineSourceTags(
    'Another storm is forecast to hit, bringing more heavy rain to the region [Bendigo Advertiser]',
    'The Bureau of Meteorology, Bendigo Advertiser, News24'
  );
  const noInlineMock = validRes.ok &&
    !validRes.post.summary.includes('BBC Sport') &&
    !validRes.post.what_happened.includes('ESPN') &&
    validRes.post.key_facts.every(f => !/\[[^\]]+\]/.test(f));
  if (c1 !== 'The Bureau of Meteorology issued a severe weather update on Thursday, November 26, 2026' ||
      c2 !== 'Tropical moisture is fueling wild conditions across parts of central Australia' ||
      c3 !== 'Another storm is forecast to hit, bringing more heavy rain to the region' ||
      !noInlineMock) {
    console.error(`[FAIL] Inline source tag restriction failed: c1="${c1}", noInlineMock=${noInlineMock}`);
    failures++;
  } else {
    console.log('[PASS] Inline [Outlet] & prose source attribution stripped cleanly across articles & bullets');
  }

  const gnewsClean = parseGoogleNewsRSS(
    '<rss><channel><item><title>[FREE!!] Lyon vs Lillestrom Live - Spam</title><source>Spam</source><link>https://spam.example</link></item><item><title>Lyon Faces Lillestrom in Europa League - BBC Sport</title><source>BBC Sport</source><link>https://bbc.example</link></item></channel></rss>'
  );
  const cleanTagPost = formatSocialPost({ slug: 'lyon-lillestrom', title: 'Lyon vs Lillestrøm', summary: 'Match preview.', category: 'Sports', topic: 'lyon lillestrøm' }, 'https://trends.example.com');
  if (slugify('Lyon - Lillestrøm') !== 'lyon-lillestrom' ||
      gnewsClean.length !== 1 ||
      gnewsClean[0].source !== 'BBC Sport' ||
      !cleanTagPost.tags.includes('#LyonLillestrom')) {
    console.error(`[FAIL] SEO slugify/transliteration or RSS stream-spam filter check failed: slug=${slugify('Lyon - Lillestrøm')}, news=${gnewsClean.length}`);
    failures++;
  } else {
    console.log('[PASS] Accented SEO slugs/hashtags & [FREE!!] RSS stream-spam filtering verified');
  }

  // Verify improved category routing & late-head/Wikimedia image extraction
  const catPutin = classifyCategory('putin news', 'Zelensky questioned Trump comments in a BBC interview about Putin and Russia.');
  const catPga = classifyCategory('pga tour', 'PGA Tour shifts focus to Farmers Insurance Skins Game.');
  const catMarc = classifyCategory('marc marquez', 'MotoGP champion Marc Marquez confirmed his retirement after the finale.');
  const relOg = extractOgMetaImage('<meta property="og:image" content="//cdn.example.com/photo/hero.jpg">', 'https://news.example.com/story');
  let lateHeadOk = false;
  let wikiStrictOk = false;
  const origImgFetch = globalThis.fetch;
  try {
    globalThis.fetch = async url => {
      const u = String(url);
      if (u === 'https://pub.example.com/story') {
        return new Response(`<html><head>${' '.repeat(70000)}<meta property="og:image" content="/assets/lead-photo.jpg"></head></html>`, {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
      }
      if (u === 'https://pub.example.com/assets/lead-photo.jpg') {
        return new Response(new Uint8Array(15000), {
          status: 200,
          headers: { 'Content-Type': 'image/jpeg', 'Content-Length': '15000' },
        });
      }
      if (u.includes('en.wikipedia.org')) {
        return new Response(JSON.stringify({
          query: {
            pages: {
              '1': { index: 0, title: 'Marc Márquez', thumbnail: { source: 'https://upload.wikimedia.org/m.jpg', width: 1200, height: 800 } },
              '2': { index: 1, title: 'Unrelated Federal Breach', thumbnail: { source: 'https://upload.wikimedia.org/bad.jpg', width: 1200, height: 800 } },
            },
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('', { status: 404 });
    };
    const hiResLate = await extractHighResSourceImage([{ name: 'Pub', url: 'https://pub.example.com/story' }], 'story');
    const wikiHit = await fetchWikiEntityImage('marc marquez');
    const wikiMiss = await fetchWikiEntityImage('us air force cloud one breach');
    lateHeadOk = hiResLate?.imageUrl === 'https://pub.example.com/assets/lead-photo.jpg' && hiResLate?.imageSource === 'Pub';
    wikiStrictOk = wikiHit?.imageUrl === 'https://upload.wikimedia.org/m.jpg' && wikiMiss === null;
  } finally {
    globalThis.fetch = origImgFetch;
  }
  if (catPutin !== 'News' || catPga !== 'Sports' || catMarc !== 'Sports' ||
      relOg !== 'https://cdn.example.com/photo/hero.jpg' || !lateHeadOk || !wikiStrictOk) {
    console.error(`[FAIL] Taxonomy/Image upgrades failed: putin=${catPutin}, pga=${catPga}, marc=${catMarc}, relOg=${relOg}, late=${lateHeadOk}, wiki=${wikiStrictOk}`);
    failures++;
  } else {
    console.log('[PASS] Political News taxonomy, Sports taxonomy & 256KB/Wiki high-res photo extraction verified');
  }

  console.log(`\nTotal failures: ${failures}`);
  process.exit(failures ? 1 : 0);
}

run();
