/**
 * Configuration, blocklists, category rules, and environment settings.
 */

export const BLOCKLIST = [
  // Deaths & tragedies
  'death', 'died', 'dies', 'dead', 'killed', 'killing', 'murder', 'homicide',
  'manslaughter', 'suicide', 'fatal', 'fatality', 'obituary', 'funeral',
  'passed away', 'tragedy', 'mass shooting', 'shooting', 'stabbing', 'drowned',
  'plane crash', 'car crash',
  // Accidents
  'accident', 'derailment', 'pileup', 'explosion', 'building collapse',
  // Crimes & lawsuits involving private people
  'rape', 'assault', 'abuse', 'molest', 'kidnap', 'hostage', 'terrorist',
  'lawsuit', 'sued', 'indicted', 'arrested', 'charged with', 'convicted', 'sentenced',
  // Minors
  'minor', 'child abuse', 'underage', 'juvenile', 'school shooting', 'teenager arrested',
  // Unverified health claims
  'miracle cure', 'cures cancer', 'weight loss pill', 'detox cure', 'anti-aging cure',
  // Adult content
  'porn', 'xxx', 'nsfw', 'onlyfans', 'erotic', 'nude', 'sex tape', 'adult film',
  // Election misinformation risk
  'election fraud', 'rigged election', 'stolen election', 'ballot stuffing',
  'fake ballots', 'voting machine hacked',
];

export const BANNED_PHRASES = [
  "you won't believe", 'you wont believe', 'shocking', 'mind-blowing',
  'mind blowing', 'jaw-dropping', 'in conclusion', 'as an ai',
  'ai-generated', 'language model', 'click here', 'subscribe now',
];

const BLOCKLIST_REGEXES = BLOCKLIST.map(term => {
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${esc}\\b`, 'i');
});

export function findSensitiveMatch(text) {
  const input = String(text || '');
  for (let i = 0; i < BLOCKLIST.length; i++) {
    if (BLOCKLIST_REGEXES[i].test(input)) return BLOCKLIST[i];
  }
  return null;
}

export const isSensitive = text => findSensitiveMatch(text) !== null;

// Category definitions ordered for informational intent classification
export const CATEGORY_RULES = [
  ['Sports', /\b(nba|nfl|mlb|nhl|fifa|uefa|ncaa|premier league|champions league|europa league|conference league|world cup|olympics|playoffs|finals|match|stadium|goal|touchdown|quarterback|running back|wide receiver|fumble|fumbles|coach|tournament|championship|grand prix|ufc|tennis|cricket|golf|league|football|basketball|baseball|soccer|hockey|bears|lions|chiefs|eagles|cowboys|lakers|celtics|arsenal|chelsea|liverpool|real madrid|barcelona|dazn)\b/gi],
  ['Gaming', /\b(playstation|ps5|xbox|nintendo|switch|steam|video game|game release|dlc|esports|rpg|fps|minecraft|fortnite|gta|grand theft auto|rockstar|elden ring|zelda|pokemon|patch notes|60 fps)\b/gi],
  ['Tech', /\b(ai|artificial intelligence|apple|google|microsoft|meta|openai|nvidia|tesla|iphone|android|macbook|software|app|outage|down|server|chip|semiconductor|cybersecurity|ios|windows|pixel|chatgpt|gemini|youtube tv|youtube|tiktok|instagram|streaming|cloud|vibe coding|cyber|hack)\b/gi],
  ['Entertainment', /\b(movie|film|box office|trailer|netflix|disney|hbo|max|prime video|paramount|cbs|nbc|abc|series|season|episode|album|song|concert|tour|singer|actor|actress|oscar|grammy|emmy|tv show|premiere|cast|sequel|directed|director|filming|sci-fi|chef|masterchef|kitchen|reality tv|full house|paw patrol)\b/gi],
  ['Business', /\b(earnings|revenue|quarterly|profit|stock|stock market|shares|nasdaq|dow|nyse|wall street|ipo|merger|acquisition|ceo|chief executive|layoffs|fed|federal reserve|interest rate|inflation|gdp|sec|market cap|dividend|earnings beat|tariff|tariffs|trade|economy|bitcoin|crypto|retail|walmart|amazon|target|black friday)\b/gi],
  ['Science', /\b(nasa|spacex|space|mars|moon|planet|orbital|asteroid|eclipse|telescope|jwst|scientists|research|study|discovery|rocket|orbit|physics|archaeology|fossil|spacecraft|crater)\b/gi],
  ['Weather', /\b(hurricane|tornado|storm|blizzard|flood|heatwave|heat wave|wildfire|earthquake|tsunami|advisory|forecast|weather|snowstorm|cyclone|typhoon|winds)\b/gi],
  ['Holidays', /\b(holiday|thanksgiving|christmas|easter|memorial day|labor day|independence day|new year|bank holiday|halloween|diwali|eid|festival)\b/gi],
];

export const PREFERRED_CATEGORIES = new Set(CATEGORY_RULES.map(([name]) => name));

export function classifyCategory(topic, contextText = '') {
  const combined = `${topic} ${contextText}`;
  let best = 'News';
  let bestHits = 0;
  for (const [name, re] of CATEGORY_RULES) {
    const matches = combined.match(re);
    const hits = matches ? matches.length : 0;
    if (hits > bestHits) {
      bestHits = hits;
      best = name;
    }
  }
  return best;
}

export const normalizeHost = raw =>
  String(raw || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');

const DISPLAY_ACRONYMS = new Set([
  'US', 'UK', 'EU', 'UN', 'AI', 'TV', 'QB', 'RB', 'WR', 'CEO', 'CFO', 'CTO',
  'GDP', 'SEC', 'FDA', 'NASA', 'NFL', 'NBA', 'MLB', 'NHL', 'NCAA', 'FIFA',
  'UEFA', 'UFC', 'F1', 'IPL', 'WWE', 'PS5', 'GTA', 'DLC', 'IOS', 'PC',
]);
const MINOR_WORDS = new Set(['a', 'an', 'the', 'and', 'or', 'for', 'of', 'in', 'on', 'at', 'to', 'vs', 'v', 'with', 'over', 'by']);

/**
 * Format raw lowercase Google Trends queries into readable editorial Title Case
 * while preserving uppercase acronyms (NFL, AI, QB, US) and existing mixed-case brands.
 */
export function formatDisplayTopic(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/[A-Z]/.test(s) && /[a-z]/.test(s)) return s;
  const words = s.split(/\s+/);
  return words.map((w, i) => {
    const bare = w.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    if (DISPLAY_ACRONYMS.has(bare)) return w.toUpperCase();
    const low = w.toLowerCase();
    if (i > 0 && i < words.length - 1 && MINOR_WORDS.has(low)) return low;
    return low.charAt(0).toUpperCase() + low.slice(1);
  }).join(' ');
}

export function getSettings(env = {}) {
  return {
    maxDaily: Math.max(1, Number(env.MAX_DAILY || 200)),
    baseTtlHours: Math.max(1, Number(env.BASE_TTL_HOURS || 48)),
    extendedTtlHours: Math.max(1, Number(env.EXTENDED_TTL_HOURS || 168)),
    extendMinHits: Math.max(1, Number(env.EXTEND_MIN_HITS || 1)),
    holdMaxMinutes: Math.max(1, Number(env.HOLD_MAX_MINUTES || 30)),
    seenTtlDays: 7,
    siteHost: normalizeHost(env.SITE_HOST) || 'trends.example.com',
    siteName: env.SITE_NAME || 'Trending Now',
    contactEmail: env.CONTACT_EMAIL || 'admin@example.com',
    geos: (env.GEO_LIST || 'US,GB,CA,AU,IN')
      .split(',')
      .map(g => g.trim().toUpperCase())
      .filter(Boolean),
    devMode: String(env.DEV_MODE || '').toLowerCase() === 'true',
  };
}
