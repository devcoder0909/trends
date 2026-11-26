/**
 * LLM content generation, multi-model fallback (Workers AI -> Gemini),
 * strict JSON parsing, grounding verification, deterministic repair & failsafe.
 */

import { BANNED_PHRASES, classifyCategory, isSensitive, findSensitiveMatch } from './config.js';

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

const WORKERS_AI_MODELS = [
  '@cf/meta/llama-4-scout-17b-16e-instruct',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/google/gemma-4-26b-a4b-it',
  '@cf/meta/llama-3.1-8b-instruct-fast',
];

const GEMINI_FALLBACK_MODELS = [
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
];

// Cached per Worker isolate to avoid wasting subrequests rediscovering working models
let cachedAiModel = null;
let cachedGeminiModel = null;
let cachedGeminiModelList = null;
let cachedGeminiListExp = 0;

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
  'NHL', 'NCAA', 'FIFA', 'UEFA', 'UFC', 'F1', 'CBS', 'NBC', 'ABC', 'FOX',
  'ESPN', 'CNN', 'BBC', 'AP', 'HBO', 'PS5', 'GTA', 'DLC',
]);

const SKIP_PROPER_WORDS = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'their', 'there', 'here', 'what',
  'when', 'where', 'why', 'how', 'who', 'while', 'which', 'after', 'before',
  'during', 'reported', 'confirmed', 'unconfirmed', 'according', 'officials',
  'experts', 'analysts', 'residents', 'investors', 'viewers', 'fans', 'players',
  'users', 'customers', 'readers', 'search', 'trends', 'american', 'british',
  'canadian', 'european', 'australian', 'english', 'spanish', 'french', 'global',
  'national', 'federal', 'united', 'states', 'uk', 'usa', 'us', 'black', 'friday',
  'cyber', 'thanksgiving', 'christmas', 'easter', 'monday', 'tuesday', 'wednesday',
  'thursday', 'friday', 'saturday', 'sunday', 'january', 'february', 'march',
  'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november',
  'december', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept',
  'oct', 'nov', 'dec', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun',
  // Common institutional & sports generic nouns in capitalized phrases
  'university', 'ministry', 'department', 'association', 'associations', 'government',
  'committee', 'commission', 'police', 'hospital', 'airport', 'court', 'senate',
  'parliament', 'league', 'division', 'conference', 'championship', 'stadium',
  'arena', 'team', 'club', 'series', 'show', 'network', 'channel', 'service',
  'company', 'corp', 'inc', 'ltd', 'news', 'wire', 'media', 'press', 'report',
  'reports', 'update', 'updates', 'game', 'games', 'match', 'day', 'today', 'tonight',
]);

export const countWords = text =>
  String(text || '').trim().split(/\s+/).filter(Boolean).length;

function countSentences(text) {
  const cleaned = String(text || '')
    .replace(/\b(?:U\.S\.A|U\.S|U\.K|Dr|Mr|Mrs|Ms|St|Mt|Jr|Sr|Inc|Co|Corp|Ltd|vs|v|No|a\.m|p\.m|e\.g|i\.e|Jan|Feb|Mar|Apr|Aug|Sep|Sept|Oct|Nov|Dec)\./gi, '$1')
    .replace(/(\d)\.(\d)/g, '$1$2');
  const parts = cleaned.split(/[.!?]+(?:\s+|$)/).map(s => s.trim()).filter(Boolean);
  return parts.length;
}

function firstSentence(text) {
  const raw = String(text || '').trim();
  const protectedText = raw
    .replace(/\b(U\.S\.A|U\.S|U\.K|Dr|Mr|Mrs|Ms|St|Mt|Jr|Sr|Inc|Co|Corp|Ltd|vs|v|No|a\.m|p\.m|e\.g|i\.e|Jan|Feb|Mar|Apr|Aug|Sep|Sept|Oct|Nov|Dec)\./gi, '$1\u0000')
    .replace(/(\d)\.(\d)/g, '$1\u0000$2');
  const idx = protectedText.search(/[.!?](?:\s+|$)/);
  const slice = idx >= 0 ? raw.slice(0, idx + 1) : raw;
  return slice.replace(/\u0000/g, '.').trim();
}

export function extractJsonObject(raw) {
  if (raw && typeof raw === 'object') return raw;
  const cleaned = String(raw || '')
    .replace(/```json\s*/gi, '')
    .replace(/```/g, '')
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON object in LLM response');
  return JSON.parse(match[0]);
}

function extractAiText(res) {
  if (!res) return '';
  if (typeof res === 'string') return res;
  if (typeof res.response === 'string') return res.response;
  if (res.response && typeof res.response === 'object') return JSON.stringify(res.response);
  if (Array.isArray(res.choices)) return res.choices[0]?.message?.content || '';
  return '';
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
        chunks.push(`${m[0]} ${m[1]} ${wd[0]} ${wd[1]} ${d.getUTCDate()} ${d.getUTCFullYear()}`);
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
  const multiRe = /\b([A-Z][a-zA-Z0-9'’-]+(?:\s+[A-Z][a-zA-Z0-9'’-]+)+)\b/g;
  let m;
  while ((m = multiRe.exec(text))) names.push(m[1]);
  return names;
}

function hasContextMonth(fullText, abbr, full) {
  if (abbr !== 'may') {
    const capAbbr = abbr[0].toUpperCase() + abbr.slice(1);
    const capFull = full[0].toUpperCase() + full.slice(1);
    return new RegExp(`\\b(${capAbbr}|${capFull})\\b`).test(fullText);
  }
  // Only match capitalized "May" when used as a calendar date/month (never English modal verb "Officials may...")
  return /\b(?:(?:in|during|until|through|by|since|from|before|after|of)\s+May|May\s+(?:\d{1,2}|20\d{2})|\d{1,2}\s+May)\b/.test(fullText);
}

/**
 * Deterministic pre-validation cleanup: strips clickbait prefixes, normalizes bullet attributions,
 * ensures single-sentence summary when possible, and safely tightens title > 60 only in generator repair.
 */
function repairDraft(draft, topic, sources) {
  if (!draft || typeof draft !== 'object') return draft;
  const out = { ...draft };
  const stripBreaking = s => String(s || '').replace(/^breaking(?:\s+news)?[:!\s-]+/i, '').trim();

  out.title = stripBreaking(out.title);
  if (out.title.length > 60 && out.title.length <= 75) {
    const clipped = out.title.slice(0, 59).replace(/\s+\S*$/, '').replace(/[,;:\-–\s]+$/, '');
    if (clipped.length >= 25) out.title = clipped;
  }

  out.summary = stripBreaking(out.summary);
  if (countSentences(out.summary) > 1) {
    const one = firstSentence(out.summary);
    if (countWords(one) >= 8) out.summary = one;
  }

  const validOutlets = sources.map(s => (s.source || '').trim()).filter(Boolean);
  if (Array.isArray(out.key_facts)) {
    out.key_facts = out.key_facts.map(f => {
      let fact = stripBreaking(f);
      if (!/\[[^\]]+\]/.test(fact) && !/\(([^)]+)\)\s*\.?$/.test(fact)) {
        const lower = fact.toLowerCase();
        const hit = validOutlets.find(o => lower.includes(o.toLowerCase()));
        if (hit) fact = `${fact.replace(/[.!?]+$/, '')} [${hit}].`;
      }
      return fact;
    });
  }
  return out;
}

/**
 * Validate draft structure, word count, banned phrases, duplicates,
 * and deterministic grounding of numbers, dates, and proper names.
 */
export function validateDraft(draft, topic, sources, existingTitles = new Set(), { minWords = 120 } = {}) {
  if (!draft || typeof draft !== 'object') return { ok: false, reason: 'missing JSON object' };

  const title = String(draft.title || '').trim();
  const summary = String(draft.summary || '').trim();
  const whatHappened = String(draft.what_happened || '').trim();
  const whyTrending = String(draft.why_trending || '').trim();
  const keyFacts = Array.isArray(draft.key_facts)
    ? draft.key_facts.map(x => String(x || '').trim()).filter(Boolean)
    : [];
  const whatNext = String(draft.what_to_know_next || '').trim();
  const alsoSearched = Array.isArray(draft.also_searched)
    ? draft.also_searched.map(x => String(x || '').trim()).filter(Boolean)
    : [];

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

  const validOutlets = sources.map(s => (s.source || '').toLowerCase()).filter(Boolean);
  const normalizedFacts = keyFacts.map(fact => {
    if (/\[[^\]]+\]/.test(fact)) return fact;
    const paren = fact.match(/\(([^)]+)\)\s*\.?$/);
    if (paren) {
      const candidate = paren[1].trim().toLowerCase();
      if (validOutlets.some(o => o.includes(candidate) || candidate.includes(o))) {
        return fact.replace(/\(([^)]+)\)(\s*\.?)$/, '[$1]$2');
      }
    }
    return fact;
  });

  for (const fact of normalizedFacts) {
    const bracket = fact.match(/\[([^\]]+)\]/);
    if (!bracket) return { ok: false, reason: 'key_facts bullet missing [Outlet] attribution' };
    const outletName = bracket[1].toLowerCase();
    if (!validOutlets.some(o => o.includes(outletName) || outletName.includes(o))) {
      return { ok: false, reason: `unrecognized outlet in bullet: [${bracket[1]}]` };
    }
  }

  const bodyText = [summary, whatHappened, whyTrending, ...normalizedFacts, whatNext].join(' ');
  const totalWords = countWords(bodyText);
  if (totalWords < minWords || totalWords > 280) {
    return { ok: false, reason: `word count ${totalWords} out of range (${minWords}-280)` };
  }

  const fullText = `${title} ${bodyText}`;
  if (EMOJI_RE.test(fullText)) return { ok: false, reason: 'contains emojis' };

  const lowerFull = fullText.toLowerCase();
  for (const phrase of BANNED_PHRASES) {
    if (lowerFull.includes(phrase)) return { ok: false, reason: `banned phrase: "${phrase}"` };
  }

  const sourceCorpus = buildSourceCorpus(topic, sources);
  const lowerCorpus = sourceCorpus.toLowerCase();

  // Reject ungrounded standalone "breaking", while allowing natural English compounds like "record-breaking"
  if (/(?<!-)\bbreaking\b(?!-)/i.test(fullText) && !/\bbreaking\b/i.test(sourceCorpus)) {
    return { ok: false, reason: 'banned phrase "breaking" not present in sources' };
  }

  const sourceNums = extractNumericTokens(sourceCorpus);
  const draftNums = extractNumericTokens(fullText);
  for (const num of draftNums) {
    if (!sourceNums.has(num)) {
      return { ok: false, reason: `unsupported number/date: ${num}` };
    }
  }

  for (const [abbr, full] of [...MONTH_NAMES, ...DAY_NAMES]) {
    if (hasContextMonth(fullText, abbr, full) && !new RegExp(`\\b(${abbr}|${full})\\b`, 'i').test(sourceCorpus)) {
      return { ok: false, reason: `unsupported date term: ${full}` };
    }
  }

  for (const candidate of extractProperNames(bodyText)) {
    const clean = candidate.replace(/['’]s$/i, '');
    if (COMMON_ACRONYMS.has(clean.toUpperCase())) continue;
    const words = clean.split(/\s+/);
    if (words.length === 1 && SKIP_PROPER_WORDS.has(clean.toLowerCase())) continue;
    if (lowerCorpus.includes(clean.toLowerCase())) continue;
    const missingToken = words.find(w => {
      const lw = w.replace(/['’]s$/i, '').toLowerCase().replace(/[^a-z0-9]/g, '');
      return lw.length > 2 && !SKIP_PROPER_WORDS.has(lw) && !COMMON_ACRONYMS.has(w.toUpperCase()) && !lowerCorpus.includes(lw);
    });
    if (missingToken) {
      return { ok: false, reason: `unsupported name/entity: "${clean}"` };
    }
  }

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
      key_facts: normalizedFacts,
      what_to_know_next: whatNext,
      also_searched: groundedAlso,
    },
  };
}

export function buildWriterPrompt(topic, category, sources, feedback = '') {
  const formattedSources = sources
    .slice(0, 10)
    .map(s => {
      const time = s.pubDate ? ` | ${s.pubDate}` : '';
      const snip = s.snippet ? ` — ${s.snippet}` : '';
      return `• [${s.source}${time}] ${s.title}${snip}`;
    })
    .join('\n');

  const feedbackBlock = feedback
    ? `\nIMPORTANT FIX FOR RETRY: Previous draft failed validation because: ${feedback}. Fix this exact issue cleanly.\n`
    : '';

  return `You are a neutral news editor writing a factual briefing for "${topic}" (category: ${category}).
Use ONLY facts, names, organizations, dates, and numbers printed verbatim in SOURCES below. NEVER add release years, historical trivia, parent companies, expanded acronyms (like UEFA/UGA), or facts from memory.

SOURCES:
${formattedSources}
${feedbackBlock}
WRITING RULES:
1. Write EVERY JSON value in clear English (Grade 8 reading level), even if a headline uses another language. No hype, no clickbait, no emojis, no "in conclusion", no "as an AI".
2. NEVER write "breaking" unless that exact word appears in SOURCES. Never write "shocking" or "you won't believe".
3. Define who or what "${topic}" is in the first sentence of what_happened using ONLY facts from SOURCES.
4. Target 165 to 225 words total across summary + what_happened + why_trending + key_facts + what_to_know_next (minimum 120 words, maximum 260 words).
5. Write summary as EXACTLY ONE crisp sentence (15-26 words) that directly answers why "${topic}" is trending.
6. EVERY bullet in key_facts MUST end with the exact source outlet name inside square brackets, like: "Team A won 2-1 in London [ESPN]."

OUTPUT ONLY VALID JSON (no markdown fences):
{
  "title": "<STRICTLY <= 55 chars, plain search-intent headline including ${topic}>",
  "category": "${category}",
  "summary": "<ONE single sentence, 15-26 words>",
  "what_happened": "<3 concise sentences (55-80 words) covering who, what, when, where>",
  "why_trending": "<2 sentences (30-45 words) explaining current search interest>",
  "key_facts": ["<fact 1 [Outlet]>", "<fact 2 [Outlet]>", "<fact 3 [Outlet]>", "<fact 4 [Outlet]>"],
  "what_to_know_next": "<1-2 sentences (25-40 words) on upcoming timing or unconfirmed details>",
  "also_searched": ["<related query 1 from sources>", "<related query 2>", "<related query 3>"]
}`;
}

async function discoverGeminiModels(env) {
  const nowMs = Date.now();
  if (cachedGeminiModelList && nowMs < cachedGeminiListExp) {
    return cachedGeminiModelList;
  }

  const candidates = [];
  if (env.GEMINI_MODEL) candidates.push(env.GEMINI_MODEL);
  if (cachedGeminiModel) candidates.push(cachedGeminiModel);

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${env.GEMINI_API_KEY}`, {
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined,
    });
    if (res.ok) {
      const data = await res.json();
      const models = (data.models || [])
        .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map(m => m.name.replace(/^models\//, ''))
        .filter(name => /gemini.*flash/i.test(name) && !/thinking|image|tts|audio|live|2\.0-flash-exp/i.test(name));
      models.sort((a, b) => {
        const score = n => (n.includes('flash-lite') ? 2 : 1) + (n.includes('2.5') ? 4 : n.includes('3') ? 6 : 0);
        return score(b) - score(a);
      });
      for (const m of models) {
        if (!candidates.includes(m)) candidates.push(m);
      }
    }
  } catch { /* fall back to static list */ }

  for (const m of GEMINI_FALLBACK_MODELS) {
    if (!candidates.includes(m)) candidates.push(m);
  }
  cachedGeminiModelList = candidates.slice(0, 4);
  cachedGeminiListExp = nowMs + 6 * 3600_000;
  return cachedGeminiModelList;
}

/**
 * Call Workers AI with isolate-level caching and fast subrequest circuit-breaking,
 * falling back seamlessly to Gemini free API.
 */
export async function callLLM(env, prompt, budget = null) {
  const errors = [];
  const canCall = () => !budget || budget.remaining() > 0;

  if (env.AI && canCall()) {
    // Only try cached model first, or max 2 models per invocation to protect Cloudflare's 50-subrequest limit
    const aiModels = [...new Set([env.AI_MODEL, cachedAiModel, ...WORKERS_AI_MODELS].filter(Boolean))].slice(0, 2);
    for (const model of aiModels) {
      if (!canCall()) break;
      if (budget) budget.spend(1);
      try {
        const res = await env.AI.run(model, {
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 750,
          temperature: 0.2,
        });
        const text = extractAiText(res);
        if (text) {
          cachedAiModel = model;
          return text;
        }
        errors.push(`${model}: empty response`);
      } catch (err) {
        errors.push(`${model}: ${err.message}`);
        if (/too many subrequests/i.test(err.message)) {
          const fatal = new Error(errors.join('; '));
          fatal.fatalSubrequest = true;
          throw fatal;
        }
        if (model === cachedAiModel) cachedAiModel = null;
      }
    }
  } else if (!env.AI) {
    errors.push('Workers AI binding missing');
  }

  if (!env.GEMINI_API_KEY) {
    throw new Error(`LLM unavailable (${errors.join('; ')})`);
  }
  if (!canCall()) {
    const fatal = new Error('Subrequest budget reserved');
    fatal.fatalSubrequest = true;
    throw fatal;
  }

  const geminiModels = await discoverGeminiModels(env);
  for (const model of geminiModels.slice(0, 2)) {
    if (!canCall()) break;
    if (budget) budget.spend(1);
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined,
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
          }),
        }
      );
      if (!res.ok) {
        errors.push(`Gemini ${model}: HTTP ${res.status}`);
        if (model === cachedGeminiModel) cachedGeminiModel = null;
        continue;
      }
      const json = await res.json();
      const text = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (text) {
        cachedGeminiModel = model;
        return text;
      }
      errors.push(`Gemini ${model}: empty text`);
    } catch (err) {
      errors.push(`Gemini ${model}: ${err.message}`);
      if (/too many subrequests/i.test(err.message)) {
        const fatal = new Error(errors.join('; '));
        fatal.fatalSubrequest = true;
        throw fatal;
      }
    }
  }

  throw new Error(errors.join('; '));
}

async function verifyWithLLM(env, draft, topic, sources, budget = null) {
  if (budget && budget.remaining() <= 2) return { ok: true };
  const sourceList = sources
    .slice(0, 8)
    .map(s => `[${s.source} | ${s.pubDate || ''}] ${s.title} ${s.snippet || ''}`)
    .join('\n');
  const prompt = `Fact-check this draft about "${topic}" strictly against SOURCES.
Verify EVERY number, date, time, and proper name in the draft appears in SOURCES.

SOURCES:
${sourceList}

DRAFT:
${JSON.stringify(draft)}

Reply ONLY with JSON: {"ok":true} or {"ok":false,"reason":"<unsupported item>"}`;

  try {
    const raw = await callLLM(env, prompt, budget);
    const parsed = extractJsonObject(raw);
    if (parsed.ok === false) return { ok: false, reason: parsed.reason || 'failed LLM fact-check' };
    return { ok: true };
  } catch {
    return { ok: true };
  }
}

/**
 * Deterministic grounded synthesis from verified multi-outlet RSS headlines & snippets.
 * Used in DEV_MODE and as an unbreakable failsafe when LLM infra hits quotas/limits.
 */
export function mockGenerate(topic, category, sources) {
  const s = sources.filter(x => x && x.title && x.source);
  const primary = s[0] || {};
  const secondary = s[1] || primary;
  const tertiary = s[2] || secondary;
  const fourth = s[3] || tertiary;

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
  if (title.length > 60) {
    title = `${topic.slice(0, 40)} — Latest Update`.slice(0, 60);
    if (title.length > 60) title = topic.slice(0, 60).trim();
  }

  const s1 = (primary.title || topic).replace(/[.!?]+$/, '');
  const s2 = (secondary.title || topic).replace(/[.!?]+$/, '');
  const s3 = (tertiary.title || topic).replace(/[.!?]+$/, '');
  const s4 = (fourth.snippet || fourth.title || topic).replace(/[.!?]+$/, '');

  const summary = `${topic} is trending following recent reports from ${primary.source || 'news outlets'} and ${secondary.source || 'media sources'}.`;
  const trimmedSummary = countWords(summary) > 28
    ? `${topic} is trending across multiple verified news outlets.`
    : summary;

  const snip1 = primary.snippet ? `${primary.snippet.replace(/[.!?]+$/, '')}.` : '';
  const snip2 = secondary.snippet ? `${secondary.snippet.replace(/[.!?]+$/, '')}.` : '';

  const what_happened = `${topic} drew widespread ${category.toLowerCase()} coverage across major news feeds as new updates appeared online. According to ${primary.source || 'reports'}, ${s1}. ${snip1} Separate coverage from ${secondary.source || 'outlets'} noted that ${s2}. ${snip2}`.replace(/\s+/g, ' ').trim();

  const why_trending = `Search interest around ${topic} climbed rapidly after several news publishers released simultaneous updates and reporting on the story. Readers are looking for confirmed timelines, verified details, and primary coverage from listed news outlets.`;

  const bulletsRaw = [
    `${s1} [${primary.source || 'News'}].`,
    `${s2} [${secondary.source || primary.source || 'News'}].`,
    `${(tertiary.snippet || s3).replace(/[.!?]+$/, '')} [${tertiary.source || secondary.source || 'News'}].`,
  ];
  if (s.length >= 4 && s4 !== s3) {
    bulletsRaw.push(`${s4} [${fourth.source || tertiary.source || 'News'}].`);
  }

  const what_to_know_next = `Further official details and follow-up updates on ${topic} remain reported as developments continue. Any unverified claims outside these cited news outlets have not been officially confirmed yet.`;

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
    key_facts: bulletsRaw,
    what_to_know_next,
    also_searched,
  };
}

/**
 * Full pipeline for a single topic:
 * - Tries LLM writer up to 2 attempts with targeted repair & validation
 * - Falls back to deterministic multi-outlet synthesis when LLM hits infra/quota errors
 *   so verified >= 2 outlet stories never get dropped
 * - Returns ok: false with code sensitive | single_source | quality_gate for rejections
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
  const budget = options.budget || null;
  let feedback = '';
  let lastReason = 'validation failed';
  let infraFailures = 0;

  // Keep LLM attempts to 2 (saves subrequests cleanly) unless deterministic customGenerator test
  const maxAttempts = typeof options.customGenerator === 'function' ? 3 : 2;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let draft;
    try {
      if (typeof options.customGenerator === 'function') {
        draft = await options.customGenerator(topic, category, sources, attempt, feedback);
      } else if (useMock) {
        draft = mockGenerate(topic, category, sources);
      } else {
        const raw = await callLLM(env, buildWriterPrompt(topic, category, sources, feedback), budget);
        draft = repairDraft(extractJsonObject(raw), topic, sources);
      }
    } catch (err) {
      lastReason = `generation error: ${err.message}`;
      feedback = lastReason;
      if (err.fatalSubrequest) {
        infraFailures++;
        break;
      }
      if (/HTTP \d+|unavailable|subrequests|timeout/i.test(err.message)) {
        infraFailures++;
        if (infraFailures >= 2) break;
      }
      continue;
    }

    const check = validateDraft(draft, topic, sources, existingTitles, { minWords: 120 });
    if (!check.ok) {
      lastReason = check.reason;
      feedback = check.reason;
      continue;
    }

    if (!useMock && !options.skipLlmVerifier && !options.customGenerator) {
      const llmCheck = await verifyWithLLM(env, check.post, topic, sources, budget);
      if (!llmCheck.ok) {
        lastReason = llmCheck.reason;
        feedback = llmCheck.reason;
        continue;
      }
    }

    return { ok: true, post: check.post };
  }

  // Deterministic grounded failsafe when LLM infra fails (unless custom test generator is used)
  if (!useMock && typeof options.customGenerator !== 'function' && options.allowGroundedFallback !== false) {
    const groundedDraft = mockGenerate(topic, category, sources);
    const groundedCheck = validateDraft(groundedDraft, topic, sources, existingTitles, { minWords: 110 });
    if (groundedCheck.ok) {
      return { ok: true, post: groundedCheck.post, usedFallback: true };
    }
  }

  return { ok: false, code: infraFailures ? 'infra_error' : 'quality_gate', reason: lastReason };
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
