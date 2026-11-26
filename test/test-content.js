/**
 * `npm run test:content`
 * Runs 10 mock topics (sports, tech, movie, weather, ambiguous name,
 * business, science, gaming, sensitive, single-source) through the full
 * pipeline and verifies quality-gate rejections.
 */

import { generateAndValidatePost, validateDraft } from '../src/content.js';
import { rankTopics } from '../src/rss.js';
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

  console.log(`\nTotal failures: ${failures}`);
  process.exit(failures ? 1 : 0);
}

run();
