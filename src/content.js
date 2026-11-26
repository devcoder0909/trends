/**
 * LLM content generation, strict JSON parsing, grounding verification,
 * quality gate (max 2 retries), and post-level update generation.
 */

import { BANNED_PHRASES, classifyCategory, isSensitive, findSensitiveMatch } from './config.js';

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

const MONTH_NAMES = [
  ['jan', 'january'], ['feb', 'february'], ['mar', 'march'], ['apr', 'april'],
  ['may', 'may'], ['jun', 'june'], ['jul', 'july'], ['aug', 'august'],
  ['sep', 'september'], ['oct', 'october'], ['nov', 'november'], ['dec', 'december'],
];
const DAY_NAMES = [
  ['mon', 'monday'], ['tue', 'tuesday'], ['wed', 'wednesday'], ['thu', 'thursday'],
  ['fri', 'friday'], ['sat', 'saturday'], ['sun', 'sunday'],
];
const COMMON_ACRONYMS = new Set([
  'US', 'U.S', 'UK', 'U.K', 'EU', 'UN', 'AI', 'TV', 'CEO', 'CFO', 'CTO',
  'AM', 'PM', 'UTC', 'GMT', 'EST', 'EDT', 'PST', 'PDT', 'CST', 'CDT',
  'RSS', 'JSON', 'URL', 'GDP', 'SEC', 'FDA', 'NASA', 'NFL', 'NBA', 'MLB',
  'NHL', 'FIFA', 'UEFA', 'UFC', 'F1',
]);

export const countWords = text =>
  String(text || '').trim().split(/\s+/).filter(Boolean).length;

function countSentences(text) {
  const cleaned = String(text || '')
    .replace(/\b(?:U\.S|U\.K|Dr|Mr|Mrs|Ms|St|vs|No|Jan|Feb|Mar|Apr|Aug|Sep|Sept|Oct|Nov|Dec)\./gi, '$1')
    .replace(/(\d)\.(\d)/g, '$1$2');
  const parts = cleaned.split(/[.!?]+(?:\s+|$)/).map(s => s.trim()).filter(Boolean);
  return parts.length;
}

/**
 * Expand pubDates so "Nov 26, 2026" allows "November 26, 2026" in grounding checks.
 */
export function buildSourceCorpus(topic, sources) {
  const chunks = [topic];
  for (const s of sources) {
    chunks.push(s.title || '', s.snippet || '', s.source || '', s.pubDate || '');
    if (s.pubDate) {
      const d = new Date(s.pubDate);
      if (!Number.isNaN(d.getTime())) {
        const m = MONTH_NAMES[d.getUTCMonth()];
        const wd = DAY_NAMES[(d.getUTCDay() + 6) % 7];
        chunks.push(
          `${m[0]} ${m[1]} ${wd[0]} ${wd[1]} ${d.getUTCDate()} ${d.getUTCFullYear()}`
        );
      }
    }
  }
  return chunks.join(' \n ');
}

function extractNumericTokens(text) {
  const matches = String(text || '').match(/\d+(?:,\d{3})*(?:\.\d+)?/g) || [];
  const tokens = new Set();
  for (const raw of matches) {
    const clean = raw.replace(/,/g, '');
    tokens.add(clean);
    for (const part of clean.split('.')) {
      if (part) tokens.add(part);
    }
  }
  return tokens;
}

function extractProperNames(text) {
  const names = [];
  // Multi-word capitalized phrases (e.g. "Taylor Swift", "Pacific Northwest")
  const multiRe = /\b([A-Z][a-zA-Z0-9'’-]+(?:\s+[A-Z][a-zA-Z0-9'’-]+)+)\b/g;
  let m;
  while ((m = multiRe.exec(text))) {
    names.push(m[1]);
  }
  // Mid-sentence single capitalized words (preceded by lowercase word + space)
  const midRe = /[a-z0-9,)\]]\s+([A-Z][a-zA-Z0-9'’-]{2,})\b/g;
  while ((m = midRe.exec(text))) {
    names.push(m[1]);
  }
  return names;
}

const SKIP_PROPER_WORDS = new Set([
  'the', 'this', 'that', 'these', 'those', 'their', 'there', 'here', 'what',
  'when', 'where', 'why', 'how', 'who', 'while', 'which', 'after', 'before',
  'during', 'reported', 'confirmed', 'unconfirmed', 'according', 'officials',
  'experts', 'analysts', 'residents', 'investors', 'viewers', 'fans', 'players',
  'users', 'customers', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday',
  'saturday', 'sunday', 'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun',
]);

/**
 * Validate draft structure, word count, banned phrases, duplicates,
 * and deterministic grounding of numbers, dates, and proper names.
 */
export function validateDraft(draft, topic, sources, existingTitles = new Set()) {
  if (!draft || typeof draft !== 'object') return { ok: false, reason: 'missing JSON object' };

  const title = String(draft.title || '').trim();
  const summary = String(draft.summary || '').trim();
  const whatHappened = String(draft.what_happened || '').trim();
  const whyTrending = String(draft.why_trending || '').trim();
  const keyFacts = Array.isArray(draft.key_facts) ? draft.key_facts.map(x => String(x || '').trim()).filter(Boolean) : [];
  const whatNext = String(draft.what_to_know_next || '').trim();
  const alsoSearched = Array.isArray(draft.also_searched) ? draft.also_searched.map(x => String(x || '').trim()).filter(Boolean) : [];

  if (!title) return { ok: false, reason: 'missing title' };
  if (title.length > 60) return { ok: false, reason: `title exceeds 60 chars (${title.length})` };
  if (existingTitles.has(title.toLowerCase())) return { ok: false, reason: 'duplicate title of live post' };

  if (!summary) return { ok: false, reason: 'missing summary' };
  const summaryWords = countWords(summary);
  if (summaryWords > 30) return { ok: false, reason: `summary exceeds 30 words (${summaryWords})` };
  if (countSentences(summary) > 1) return { ok: false, reason: 'summary must be one sentence' };

  if (!whatHappened || !whyTrending || !whatNext) {
    return { ok: false, reason: 'missing required narrative sections' };
  }
  if (keyFacts.length < 3 || keyFacts.length > 5) {
    return { ok: false, reason: `key_facts must have 3-5 items (got ${keyFacts.length})` };
  }

  // Require bracketed outlet attribution on each bullet
  const validOutlets = sources.map(s => (s.source || '').toLowerCase()).filter(Boolean);
  for (const fact of keyFacts) {
    const bracket = fact.match(/\[([^\]]+)\]/);
    if (!bracket) return { ok: false, reason: 'key_facts bullet missing [Outlet] attribution' };
    const outletName = bracket[1].toLowerCase();
    if (!validOutlets.some(o => o.includes(outletName) || outletName.includes(o))) {
      return { ok: false, reason: `unrecognized outlet in bullet: [${bracket[1]}]` };
    }
  }

  const bodyText = [summary, whatHappened, whyTrending, ...keyFacts, whatNext].join(' ');
  const totalWords = countWords(bodyText);
  if (totalWords < 150 || totalWords > 250) {
    return { ok: false, reason: `word count ${totalWords} out of range (150-250)` };
  }

  const fullText = `${title} ${bodyText}`;
  if (EMOJI_RE.test(fullText)) return { ok: false, reason: 'contains emojis' };

  const lowerFull = fullText.toLowerCase();
  for (const phrase of BANNED_PHRASES) {
    if (lowerFull.includes(phrase)) return { ok: false, reason: `banned phrase: "${phrase}"` };
  }

  const sourceCorpus = buildSourceCorpus(topic, sources);
  const lowerCorpus = sourceCorpus.toLowerCase();

  if (/\bbreaking\b/i.test(fullText) && !/\bbreaking\b/i.test(sourceCorpus)) {
    return { ok: false, reason: 'banned phrase "breaking" not present in sources' };
  }

  // Verify numbers and dates appear in source corpus
  const sourceNums = extractNumericTokens(sourceCorpus);
  const draftNums = extractNumericTokens(fullText);
  for (const num of draftNums) {
    if (!sourceNums.has(num)) {
      return { ok: false, reason: `unsupported number/date: ${num}` };
    }
  }

  // Verify month & weekday names appear in source corpus
  for (const [abbr, full] of [...MONTH_NAMES, ...DAY_NAMES]) {
    const re = new RegExp(`\\b(${abbr}|${full})\\b`, 'i');
    if (re.test(fullText) && !re.test(sourceCorpus)) {
      return { ok: false, reason: `unsupported date term: ${full}` };
    }
  }

  // Verify proper names in body appear in source corpus
  for (const candidate of extractProperNames(bodyText)) {
    const clean = candidate.replace(/['’]s$/i, '');
    if (COMMON_ACRONYMS.has(clean.toUpperCase())) continue;
    const words = clean.split(/\s+/);
    if (words.length === 1 && SKIP_PROPER_WORDS.has(clean.toLowerCase())) continue;

    // Check full phrase first, then individual non-stopword tokens
    if (lowerCorpus.includes(clean.toLowerCase())) continue;
    const missingToken = words.find(w => {
      const lw = w.toLowerCase().replace(/[^a-z0-9]/g, '');
      return lw.length > 2 && !SKIP_PROPER_WORDS.has(lw) && !COMMON_ACRONYMS.has(w.toUpperCase()) && !lowerCorpus.includes(lw);
    });
    if (missingToken) {
      return { ok: false, reason: `unsupported name/entity: "${clean}"` };
    }
  }

  // Verify also_searched has up to 3 relevant phrases grounded in source text
  const groundedAlso = alsoSearched
    .filter(p => p.split(/\s+/).some(w => w.length > 2 && lowerCorpus.includes(w.toLowerCase())))
    .slice(0, 3);

  const category = classifyCategory(topic, sourceCorpus);
  return {
    ok: true,
    post: {
      title,
      category: draft.category || category,
      summary,
      what_happened: whatHappened,
      why_trending: whyTrending,
      key_facts: keyFacts,
      what_to_know_next: whatNext,
      also_searched: groundedAlso,
    },
  };
}

export function buildWriterPrompt(topic, category, sources, feedback = '') {
  const formattedSources = sources
    .slice(0, 8)
    .map(s => {
      const time = s.pubDate ? ` | ${s.pubDate}` : '';
      const snip = s.snippet ? ` — ${s.snippet}` : '';
      return `• [${s.source}${time}] ${s.title}${snip}`;
    })
    .join('\n');

  const feedbackBlock = feedback ? `\nIMPORTANT FIX FOR RETRY: Previous draft was rejected because: ${feedback}\n` : '';

  return `You are a neutral news editor writing a factual summary for "${topic}" (category: ${category}).
Use ONLY facts, names, dates, and numbers from these source headlines and snippets. NEVER invent facts or outside details.

SOURCES:
${formattedSources}
${feedbackBlock}
WRITING RULES:
1. Grade 8 reading level, short clear sentences, no hype, no clickbait, no emojis, no filler intros, no "in conclusion".
2. Do NOT mention being an AI. Do NOT use "shocking", "you won't believe", or "breaking" (unless "breaking" is in the sources).
3. Define who or what "${topic}" is in the first sentence of what_happened (e.g., full name and role, or which meaning applies if ambiguous).
4. Use exact dates, times, and numbers from sources. If sources disagree or details are unconfirmed, write "reported but not confirmed".
5. Total length across summary + what_happened + why_trending + key_facts + what_to_know_next MUST be 150 to 250 words.

OUTPUT ONLY VALID JSON (no markdown fences):
{
  "title": "<under 60 chars, plain language, includes ${topic} and intent like 'Why Is X Trending?' or match/release/outage pattern>",
  "category": "${category}",
  "summary": "<ONE single sentence, max 30 words, directly answering what happened>",
  "what_happened": "<2-3 short sentences covering who, what, when, where>",
  "why_trending": "<1-2 sentences explaining why people are searching now>",
  "key_facts": ["<single verifiable fact [Outlet Name]>", "<fact 2 [Outlet Name]>", "<fact 3 [Outlet Name]>"],
  "what_to_know_next": "<1-2 sentences on upcoming date, next step, or what remains unconfirmed>",
  "also_searched": ["<related phrase 1 from sources>", "<related phrase 2>", "<related phrase 3>"]
}`;
}

export async function callLLM(env, prompt) {
  let text = '';
  try {
    if (!env.AI) throw new Error('Workers AI binding unavailable');
    const res = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 700,
    });
    text = res.response || '';
  } catch (err) {
    if (!env.GEMINI_API_KEY) throw err;
    const model = env.GEMINI_MODEL || 'gemini-2.0-flash-lite';
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      }
    );
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
    const json = await res.json();
    text = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }
  return text;
}

/**
 * Second LLM pass: verifies every number, date, and name is supported by sources.
 */
async function verifyWithLLM(env, draft, topic, sources) {
  const sourceList = sources.slice(0, 8).map(s => `[${s.source} | ${s.pubDate || ''}] ${s.title} ${s.snippet || ''}`).join('\n');
  const prompt = `Fact-check this draft about "${topic}" strictly against the SOURCES below.
Check whether EVERY number, date, time, and proper name in the draft appears in the SOURCES.

SOURCES:
${sourceList}

DRAFT:
${JSON.stringify(draft)}

Reply ONLY with valid JSON:
{"ok":true} if every number, date, and name is supported by the sources, or {"ok":false,"reason":"<specific unsupported item>"} if anything is invented.`;

  try {
    const raw = await callLLM(env, prompt);
    const parsed = JSON.parse((raw.match(/\{[\s\S]*\}/) || ['{}'])[0]);
    if (parsed.ok === false) return { ok: false, reason: parsed.reason || 'failed LLM fact-check' };
    return { ok: true };
  } catch {
    // Fall back to deterministic check if verifier LLM quota is exhausted
    return { ok: true };
  }
}

/**
 * Deterministic grounded mock generator for DEV_MODE and offline test suite.
 * Builds a 160-200 word structured JSON post strictly from the input sources.
 */
export function mockGenerate(topic, category, sources) {
  const primary = sources[0] || {};
  const secondary = sources[1] || primary;
  const tertiary = sources[2] || secondary;

  const titleTemplates = {
    Sports: `${topic} Match Result and Latest Score`,
    Tech: `${topic} Announcement: Key Details and Status`,
    Entertainment: `${topic} Release Details and Updates`,
    Weather: `${topic} Weather Forecast and Advisories`,
    Science: `${topic} Mission Findings and Latest Update`,
    Business: /\bearnings\b/i.test(topic) ? `${topic} Report and Market Reaction` : `${topic} Earnings Report and Market Reaction`,
    Gaming: `${topic} Game Release Date and Details`,
    Holidays: `${topic} Holiday Schedule and Key Details`,
    News: `Why Is ${topic} Trending? What Happened`,
  };
  let title = titleTemplates[category] || `Why Is ${topic} Trending? What Happened`;
  if (title.length > 60) title = `${topic.slice(0, 40)} — Latest Update`.slice(0, 60);

  const s1 = primary.title || topic;
  const s2 = secondary.title || topic;
  const s3 = tertiary.title || topic;

  const summary = `${topic} is trending after ${primary.source || 'news outlets'} reported that ${s1.toLowerCase().replace(/[.!?]+$/, '')}.`;
  const trimmedSummary = countWords(summary) > 28
    ? `${topic} is trending following new reports from ${primary.source || 'news outlets'} and ${secondary.source || 'other media'}.`
    : summary;

  const what_happened = `${topic}, covered in recent ${category.toLowerCase()} reports, became the focus of widespread coverage on recent news wires. According to ${primary.source || 'reports'}, ${s1}. ${primary.snippet ? primary.snippet.replace(/[.!?]+$/, '') + '.' : ''} Additional reporting from ${secondary.source || 'media outlets'} noted that ${s2.replace(/[.!?]+$/, '')}.`.replace(/\s+/g, ' ').trim();

  const why_trending = `Public interest in ${topic} surged quickly after multiple outlets published simultaneous updates on the topic. Readers are searching for confirmed details, timelines, and verified reporting from primary news sources.`;

  const key_facts = [
    `${s1.replace(/[.!?]+$/, '')} [${primary.source || 'News'}].`,
    `${s2.replace(/[.!?]+$/, '')} [${secondary.source || primary.source || 'News'}].`,
    `${(tertiary.snippet || s3).replace(/[.!?]+$/, '')} [${tertiary.source || secondary.source || 'News'}].`,
  ];

  const what_to_know_next = `Further official details and follow-up updates on ${topic} remain reported as developments continue. Any unconfirmed details outside these published reports have not been verified by official statements yet.`;

  const also_searched = [
    `${topic} update`,
    s1.split(/\s+/).slice(0, 4).join(' '),
    s2.split(/\s+/).slice(0, 4).join(' '),
  ];

  return {
    title,
    category,
    summary: trimmedSummary,
    what_happened,
    why_trending,
    key_facts,
    what_to_know_next,
    also_searched,
  };
}

/**
 * Full pipeline for a single topic:
 * 1. Blocklist check (topic + headlines + snippets)
 * 2. Minimum 2 distinct outlets check
 * 3. Generate + quality gate with up to 2 retries
 */
export async function generateAndValidatePost(env, topicObj, existingTitles = new Set(), options = {}) {
  const { topic, sources = [] } = topicObj;
  const combinedSourceText = [topic, ...sources.map(s => `${s.title} ${s.snippet}`)].join(' ');

  const sensitiveTerm = findSensitiveMatch(combinedSourceText);
  if (sensitiveTerm) {
    return { ok: false, code: 'sensitive', reason: `blocked sensitive keyword: "${sensitiveTerm}"` };
  }

  const distinctOutlets = [...new Set(sources.map(s => (s.source || '').trim()).filter(Boolean))];
  if (distinctOutlets.length < 2) {
    return {
      ok: false,
      code: 'single_source',
      reason: `requires at least 2 distinct outlets (found ${distinctOutlets.length})`,
    };
  }

  const category = classifyCategory(topic, combinedSourceText);
  const useMock = options.forceMock || String(env?.DEV_MODE || '').toLowerCase() === 'true';
  let feedback = '';
  let lastReason = 'validation failed';

  for (let attempt = 0; attempt < 3; attempt++) {
    let draft;
    try {
      if (typeof options.customGenerator === 'function') {
        draft = await options.customGenerator(topic, category, sources, attempt, feedback);
      } else if (useMock) {
        draft = mockGenerate(topic, category, sources);
      } else {
        const raw = await callLLM(env, buildWriterPrompt(topic, category, sources, feedback));
        draft = JSON.parse((raw.match(/\{[\s\S]*\}/) || ['{}'])[0]);
      }
    } catch (err) {
      lastReason = `generation error: ${err.message}`;
      feedback = lastReason;
      continue;
    }

    const check = validateDraft(draft, topic, sources, existingTitles);
    if (!check.ok) {
      lastReason = check.reason;
      feedback = check.reason;
      continue;
    }

    if (!useMock && !options.skipLlmVerifier) {
      const llmCheck = await verifyWithLLM(env, check.post, topic, sources);
      if (!llmCheck.ok) {
        lastReason = llmCheck.reason;
        feedback = llmCheck.reason;
        continue;
      }
    }

    return { ok: true, post: check.post };
  }

  return { ok: false, code: 'quality_gate', reason: lastReason };
}

/**
 * Detect new headlines for an existing live post without rewriting the body.
 */
export function buildUpdateFromFreshSources(existingSourceUrls = [], freshSources = [], nowIso) {
  const known = new Set(
    existingSourceUrls.flatMap(s => [
      (s.url || '').trim().toLowerCase(),
      (s.title || '').trim().toLowerCase(),
    ]).filter(Boolean)
  );

  const unseen = freshSources.filter(s => {
    if (!s.title || !s.source) return false;
    if (isSensitive(`${s.title} ${s.snippet || ''}`)) return false;
    const u = (s.url || '').trim().toLowerCase();
    const t = (s.title || '').trim().toLowerCase();
    return (!u || !known.has(u)) && !known.has(t);
  });

  if (!unseen.length) return { updated: false };

  const newest = unseen[0];
  const mergedSources = [...existingSourceUrls];
  for (const item of unseen.slice(0, 3)) {
    mergedSources.push({ name: item.source, url: item.url || '', title: item.title });
  }

  return {
    updated: true,
    updateEntry: {
      time: nowIso,
      text: `${newest.title.replace(/[.!?]+$/, '')} [${newest.source}].`,
    },
    mergedSources,
  };
}
