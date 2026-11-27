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
  'across news news',
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
  ['Tech', /\b(ai|artificial intelligence|apple|google|microsoft|meta|openai|nvidia|tesla|iphone|android|macbook|software|outage|(?:server|site|app|network|system)\s+down|chip|semiconductor|cybersecurity|ios|windows|pixel|chatgpt|gemini|youtube tv|youtube|tiktok|instagram|cloud|vibe coding|cyber|hack)\b/gi],
  ['Entertainment', /\b(movie|film|box office|trailer|netflix|disney|hbo|max|prime video|paramount|cbs|nbc|abc|bbc|series|season|episode|album|song|concert|tour|singer|actor|actress|oscar|grammy|emmy|tv show|premiere|cast|sequel|directed|director|filming|sci-fi|documentary|comedy|comedian|hollywood|celebrity|chef|masterchef|kitchen|reality tv|full house|paw patrol)\b/gi],
  ['Business', /\b(earnings|revenue|quarterly|profit|stock|stock market|shares|nasdaq|dow|nyse|wall street|ipo|merger|acquisition|ceo|chief executive|layoffs|fed|federal reserve|interest rate|inflation|gdp|sec|market cap|dividend|earnings beat|tariff|tariffs|trade|economy|bitcoin|crypto|retail|walmart|amazon|target|black friday)\b/gi],
  ['Science', /\b(nasa|spacex|space|mars|moon|planet|orbital|asteroid|eclipse|telescope|jwst|scientists|research|study|discovery|rocket|orbit|physics|archaeology|fossil|spacecraft|crater)\b/gi],
  ['Weather', /\b(hurricanes?|tornadoe?s?|storms?|blizzards?|floods?|flooding|rain(?:fall)?|heatwaves?|heat waves?|wildfires?|earthquakes?|tsunamis?|advisory|forecasts?|weather|snowstorms?|cyclones?|typhoons?|winds|landslides?|evacuations?)\b/gi],
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
  'US', 'UK', 'EU', 'UN', 'UAE', 'USA', 'AI', 'TV', 'QB', 'RB', 'WR', 'CEO', 'CFO', 'CTO',
  'GDP', 'SEC', 'FDA', 'NASA', 'ECB', 'IMF', 'WHO', 'CDC', 'DOJ', 'FBI', 'CIA', 'IRS', 'GOP', 'DNC',
  'NFL', 'NBA', 'MLB', 'NHL', 'NCAA', 'FIFA', 'UEFA', 'UFC', 'F1', 'IPL', 'WWE', 'ESPN',
  'BBC', 'CNN', 'CBS', 'NBC', 'ABC', 'FOX', 'HBO', 'WSJ',
  'SAP', 'JD', 'IBM', 'AMD', 'AWS', 'EV', 'IPO', 'ETF', 'RTX', 'PS5', 'GTA', 'DLC', 'IOS', 'PC',
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

/**
 * Remove inline [Outlet], (Outlet), and attribution filler from content prose & bullets
 * while preserving the dedicated Sources section untouched.
 */
export function stripInlineSourceTags(text, sourcesInput = '') {
  let out = String(text || '')
    .replace(/\s*\[[^\]\r\n]{2,64}\](?:\s*([.!?,;:]))?/g, (_, p) => (p || ''))
    .replace(/\s{2,}/g, ' ')
    .trim();

  const sourceList = (Array.isArray(sourcesInput)
    ? sourcesInput
    : String(sourcesInput || '').split(','))
    .map(s => String(s || '').trim())
    .filter(s => s.length >= 2)
    .sort((a, b) => b.length - a.length);

  if (sourceList.length) {
    const alt = sourceList.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    out = out
      .replace(new RegExp(`\\s*(?:\\((?:${alt})\\)|[—–|\\-]\\s*(?:${alt}))\\s*([.!?,;:])?`, 'gi'), (_, p) => (p || ''))
      .replace(new RegExp(`(?:^|[.!?]\\s+)According to (?:${alt}),?\\s+`, 'gi'), m => (m.startsWith('.') || m.startsWith('!') || m.startsWith('?') ? `${m[0]} ` : ''))
      .replace(new RegExp(`(?:^|[.!?]\\s+)Separate coverage from (?:${alt}|outlets) noted (?:that\\s+)?`, 'gi'), m => (m.startsWith('.') || m.startsWith('!') || m.startsWith('?') ? `${m[0]} ` : ''))
      .replace(new RegExp(`\\s+following recent reports from (?:${alt})(?:\\s+and\\s+(?:${alt}|media sources))?`, 'gi'), ' following recent public developments');
  }

  out = out
    .replace(/\bacross news news\b/gi, 'across current news')
    .replace(/\.{2,}/g, '.')
    .replace(/\s+([.!?,;:])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (out) out = out.charAt(0).toUpperCase() + out.slice(1);
  return out;
}

export function getSettings(env = {}) {
  const maxDaily = Math.max(1, Number(env.MAX_DAILY || 200));
  const maxHourly = Math.max(1, Number(env.MAX_HOURLY || Math.ceil(maxDaily / 24)));
  const publishGapMins = Math.max(0, Number(env.PUBLISH_GAP_MINS ?? 6));
  return {
    maxDaily,
    maxHourly,
    publishGapMins,
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
