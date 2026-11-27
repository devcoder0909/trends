/**
 * LLM content generation, multi-model fallback (Workers AI -> Gemini),
 * strict JSON parsing, grounding verification, deterministic repair & failsafe.
 */

import { BANNED_PHRASES, classifyCategory, isSensitive, findSensitiveMatch, formatDisplayTopic, stripInlineSourceTags } from './config.js';

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

// Ultra-efficient quantized models (~11-13 Neurons/article vs ~55-120 on 17B/70B)
const WORKERS_AI_MODELS = [
  '@cf/meta/llama-3.1-8b-instruct-fp8-fast',
  '@cf/meta/llama-3.2-3b-instruct',
  '@cf/meta/llama-3.1-8b-instruct-fast',
];

const GEMINI_FALLBACK_MODELS = [
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
];

// Isolate-level caches & free-tier quota circuit breakers
let cachedAiModel = null;
let cachedGeminiModel = null;
let cachedGeminiModelList = null;
let cachedGeminiListExp = 0;
let workersAiBlockedUntil = 0;
const geminiBlockedUntil = new Map();
const openaiBlockedUntil = new Map();

const nextUtcMidnightMs = (nowMs = Date.now()) => {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 1, 0);
};

export function __resetAiCooldowns() {
  cachedAiModel = null;
  cachedGeminiModel = null;
  cachedGeminiModelList = null;
  cachedGeminiListExp = 0;
  workersAiBlockedUntil = 0;
  geminiBlockedUntil.clear();
  openaiBlockedUntil.clear();
}

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
  const validOutlets = sources.map(s => (s.source || '').trim()).filter(Boolean);
  const cleanText = s => stripInlineSourceTags(stripBreaking(s), validOutlets);

  out.title = cleanText(out.title);
  if (out.title.length > 60 && out.title.length <= 75) {
    const clipped = out.title.slice(0, 59).replace(/\s+\S*$/, '').replace(/[,;:\-–\s]+$/, '');
    if (clipped.length >= 25) out.title = clipped;
  }

  out.summary = cleanText(out.summary);
  if (countSentences(out.summary) > 1) {
    const one = firstSentence(out.summary);
    if (countWords(one) >= 5) out.summary = one;
  }
  out.what_happened = cleanText(out.what_happened);
  out.why_trending = cleanText(out.why_trending);
  out.what_to_know_next = cleanText(out.what_to_know_next);

  if (countWords(out.summary) > 29 && out.what_happened) {
    const lead = firstSentence(out.what_happened);
    if (countWords(lead) >= 5 && countWords(lead) <= 29) out.summary = lead;
  }

  if (Array.isArray(out.key_facts)) {
    out.key_facts = out.key_facts.map(f => cleanText(f)).filter(Boolean);
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

  const outletNames = sources.map(s => (s.source || '').trim()).filter(Boolean);
  const cleanSummary = stripInlineSourceTags(summary, outletNames);
  const cleanWhat = stripInlineSourceTags(whatHappened, outletNames);
  const cleanWhy = stripInlineSourceTags(whyTrending, outletNames);
  const cleanNext = stripInlineSourceTags(whatNext, outletNames);
  const normalizedFacts = keyFacts.map(f => stripInlineSourceTags(f, outletNames)).filter(Boolean);

  if (normalizedFacts.length < 3 || normalizedFacts.length > 5) {
    return { ok: false, reason: `key_facts must have 3-5 items (got ${normalizedFacts.length})` };
  }

  const bodyText = [cleanSummary, cleanWhat, cleanWhy, ...normalizedFacts, cleanNext].join(' ');
  const totalWords = countWords(bodyText);
  if (totalWords < minWords || totalWords > 520) {
    return { ok: false, reason: `word count ${totalWords} out of range (${minWords}-520)` };
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
      summary: cleanSummary,
      what_happened: cleanWhat,
      why_trending: cleanWhy,
      key_facts: normalizedFacts,
      what_to_know_next: cleanNext,
      also_searched: groundedAlso,
    },
  };
}

export function buildWriterPrompt(topic, category, sources, feedback = '') {
  const displayTopic = formatDisplayTopic(topic) || topic;
  const formattedSources = sources
    .slice(0, 6)
    .map(s => {
      const time = s.pubDate ? ` | ${s.pubDate.slice(0, 22)}` : '';
      const rawSnip = (s.snippet || '').trim();
      const snip = rawSnip ? ` — ${rawSnip.slice(0, 160)}` : '';
      return `• [${s.source}${time}] ${s.title}${snip}`;
    })
    .join('\n');

  const feedbackBlock = feedback
    ? `\nFIX: ${feedback}\n`
    : '';

  return `Senior digital ${category} journalist writing a crisp, human-sounding AP/entertainment newsroom story about "${displayTopic}".
ONLY use facts, names, dates, and numbers printed verbatim in SOURCES. Never invent years, parent companies, quotes, or unverified claims.

SOURCES:
${formattedSources}
${feedbackBlock}
STYLE & SEO RULES:
1. Natural, readable human journalism (active voice, varied sentence rhythm, Grade 8 clarity). NEVER use clickbait, emojis, "breaking" (unless in SOURCES), "in conclusion", "drew widespread attention", "climbed rapidly", "closely monitoring the situation", or "readers are searching".
2. NEVER include [Source Name], parenthetical outlet tags, or "According to <Outlet>" in title, summary, what_happened, why_trending, key_facts, or what_to_know_next — outlets appear separately in Sources.
3. Total 240-360 words across all fields (min 190, max 460).
4. Front-load "${displayTopic}" naturally in the headline and opening summary for Google News & Search ranking.

JSON ONLY:
{
  "title": "<compelling active-voice news headline <=58 chars leading with ${displayTopic}>",
  "category": "${category}",
  "summary": "<ONE punchy standfirst sentence, 18-28 words, stating the exact news hook>",
  "what_happened": "<TWO crisp paragraphs separated by \\n\\n (105-155 words total, 5-6 sentences) covering who, what, when, where, and confirmed details>",
  "why_trending": "<2-3 engaging sentences (55-85 words) explaining why fans, audiences, or the public are reacting right now without mentioning search volume or trends>",
  "key_facts": ["<distinct fact 1>", "<distinct fact 2>", "<distinct fact 3>", "<distinct fact 4>"],
  "what_to_know_next": "<2 concrete sentences (35-55 words) on upcoming dates, next match/release/schedule, or open questions>",
  "also_searched": ["<natural query 1>", "<natural query 2>", "<natural query 3>", "<natural query 4>"]
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
 * Smart free-tier router:
 * 1. Gemini Free (1,000 RPD on Flash-Lite, 0 Workers AI Neurons)
 * 2. Optional Free OpenAI-Compatible Endpoints (NVIDIA NIM, Mistral Free, OpenRouter :free, Cerebras, Custom URL)
 * 3. Lightweight quantized Workers AI (@cf/meta/llama-3.1-8b-instruct-fp8-fast / 3.2-3b) within 10k Neurons/day
 * 4. Isolate quota circuit-breakers prevent retrying exhausted providers
 */
export async function callLLM(env, prompt, budget = null) {
  const errors = [];
  const nowMs = Date.now();
  const canCall = () => !budget || budget.remaining() > 0;

  const tryOpenAICompatible = async (name, endpoint, apiKey, model, extraHeaders = {}) => {
    if (!apiKey || !endpoint || !canCall()) return null;
    if ((openaiBlockedUntil.get(name) || 0) > nowMs) return null;
    if (budget) budget.spend(1);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          ...extraHeaders,
        },
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(9000) : undefined,
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          max_tokens: 900,
        }),
      });
      if (!res.ok) {
        errors.push(`${name} ${model}: HTTP ${res.status}`);
        if ([401, 402, 403, 404, 410, 429].includes(res.status)) {
          openaiBlockedUntil.set(name, nowMs + (res.status === 429 ? 15 * 60_000 : 6 * 3600_000));
        }
        return null;
      }
      const json = await res.json();
      const text = json.choices?.[0]?.message?.content || '';
      if (text) return text;
      errors.push(`${name} ${model}: empty text`);
    } catch (err) {
      errors.push(`${name} ${model}: ${err.message}`);
      if (/too many subrequests/i.test(err.message)) {
        const fatal = new Error(errors.join('; '));
        fatal.fatalSubrequest = true;
        throw fatal;
      }
    }
    return null;
  };

  const tryGemini = async () => {
    if (!env.GEMINI_API_KEY || !canCall()) return null;
    const staticModels = [...new Set([env.GEMINI_MODEL, cachedGeminiModel, ...GEMINI_FALLBACK_MODELS].filter(Boolean))];
    let activeModels = staticModels.filter(m => (geminiBlockedUntil.get(m) || 0) <= nowMs);
    if (!activeModels.length && canCall()) {
      const discovered = await discoverGeminiModels(env);
      activeModels = discovered.filter(m => (geminiBlockedUntil.get(m) || 0) <= nowMs);
    }
    for (const model of activeModels.slice(0, 2)) {
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
              generationConfig: { responseMimeType: 'application/json', temperature: 0.3, maxOutputTokens: 900 },
            }),
          }
        );
        if (!res.ok) {
          errors.push(`Gemini ${model}: HTTP ${res.status}`);
          if (res.status === 429 || res.status === 403 || res.status === 404) {
            geminiBlockedUntil.set(model, Date.now() + (res.status === 404 ? 6 * 3600_000 : 15 * 60_000));
            if (model === cachedGeminiModel) cachedGeminiModel = null;
          }
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
    return null;
  };

  const tryWorkersAi = async () => {
    if (!env.AI) {
      errors.push('Workers AI binding missing');
      return null;
    }
    if (nowMs < workersAiBlockedUntil) {
      errors.push('Workers AI daily neuron quota cooled down until UTC reset');
      return null;
    }
    if (!canCall()) return null;

    const aiModels = [...new Set([env.AI_MODEL, cachedAiModel, ...WORKERS_AI_MODELS].filter(Boolean))].slice(0, 2);
    for (const model of aiModels) {
      if (!canCall()) break;
      if (budget) budget.spend(1);
      try {
        const res = await env.AI.run(model, {
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 760,
          temperature: 0.3,
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
        if (/4006|10,000 neurons|daily free allocation|quota/i.test(err.message)) {
          workersAiBlockedUntil = nextUtcMidnightMs(nowMs);
          if (model === cachedAiModel) cachedAiModel = null;
          break;
        }
        if (model === cachedAiModel) cachedAiModel = null;
      }
    }
    return null;
  };

  // Prefer Gemini Free first, then optional OpenAI-compatible free providers, then light Workers AI
  const primaryText = await tryGemini();
  if (primaryText) return primaryText;

  const extraProviders = [
    ['nvidia', 'https://integrate.api.nvidia.com/v1/chat/completions', env.NVIDIA_API_KEY, env.NVIDIA_MODEL || 'nvidia/nemotron-3.5-bolt-e4b'],
    ['mistral', 'https://api.mistral.ai/v1/chat/completions', env.MISTRAL_API_KEY, env.MISTRAL_MODEL || 'mistral-small-latest'],
    ['openrouter', 'https://openrouter.ai/api/v1/chat/completions', env.OPENROUTER_API_KEY, env.OPENROUTER_MODEL || 'openrouter/free', { 'X-Title': 'Trending Now' }],
    ['cerebras', 'https://api.cerebras.ai/v1/chat/completions', env.CEREBRAS_API_KEY, env.CEREBRAS_MODEL || 'llama3.1-8b'],
    ['custom', env.CUSTOM_AI_URL, env.CUSTOM_AI_KEY, env.CUSTOM_AI_MODEL || 'gpt-4o-mini'],
  ];
  for (const [name, url, key, model, headers] of extraProviders) {
    const out = await tryOpenAICompatible(name, url, key, model, headers);
    if (out) return out;
  }

  const aiText = await tryWorkersAi();
  if (aiText) return aiText;

  if (!env.GEMINI_API_KEY) {
    errors.push('Gemini key unset');
  }
  if (!canCall()) {
    const fatal = new Error(errors.join('; ') || 'Subrequest budget reserved');
    fatal.fatalSubrequest = true;
    throw fatal;
  }
  throw new Error(errors.join('; ') || 'LLM unavailable');
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
  const displayTopic = formatDisplayTopic(topic) || topic;
  const s = sources.filter(x => x && x.title && x.source);
  const primary = s[0] || {};
  const secondary = s[1] || primary;
  const tertiary = s[2] || secondary;
  const fourth = s[3] || tertiary;

  const clean = txt => String(txt || '').replace(/[.!?]+$/, '').trim();
  const s1 = clean(primary.title) || displayTopic;
  const s2 = clean(secondary.title) || displayTopic;
  const s3 = clean(tertiary.title) || displayTopic;
  const s4 = clean(fourth.snippet || fourth.title) || displayTopic;
  const catArea = category === 'News' ? 'current headlines' : `${category.toLowerCase()} coverage`;

  const isMatchResult = category === 'Sports' && /\b(vs\.?|beats|defeats|win|wins|score|match|game)\b/i.test(`${topic} ${s1}`);
  const titleTemplates = {
    Sports: isMatchResult ? `${displayTopic}: Match Result, Score and Recap` : `${displayTopic}: Latest ${category} News and Context`,
    Tech: `${displayTopic}: Key Tech Details and Status`,
    Entertainment: `${displayTopic}: Latest Film and TV Update`,
    Weather: `${displayTopic}: Forecast, Alerts and Impact`,
    Science: `${displayTopic}: Key Findings and Status`,
    Business: /\bearnings\b/i.test(displayTopic) ? `${displayTopic} Report and Market Impact` : `${displayTopic}: Market Reaction and Key Details`,
    Gaming: `${displayTopic}: Release Details and Patch Status`,
    Holidays: `${displayTopic}: Schedule and Public Guide`,
    News: `${displayTopic}: Key Facts and Recent Updates`,
  };
  let title = (s1.length >= 24 && s1.length <= 58 && s1.toLowerCase().includes(displayTopic.toLowerCase()))
    ? s1
    : (titleTemplates[category] || `${displayTopic}: Key Facts and Recent Updates`);
  if (title.length > 60) {
    title = `${displayTopic.slice(0, 38)} — Key Updates`.slice(0, 60).trim();
    if (title.length > 60) title = displayTopic.slice(0, 60).trim();
  }

  const summaryRaw = `${displayTopic} sparked fresh conversation across ${catArea} following recent public reports and verified updates.`;
  const trimmedSummary = countWords(summaryRaw) > 28
    ? `${displayTopic} drew fresh public attention following confirmed updates.`
    : summaryRaw;

  const snip1 = clean(primary.snippet) ? `${clean(primary.snippet)}.` : '';
  const snip2 = clean(secondary.snippet) && clean(secondary.snippet) !== clean(primary.snippet) ? `${clean(secondary.snippet)}.` : '';
  const snip3 = clean(tertiary.snippet) && clean(tertiary.snippet) !== clean(secondary.snippet) ? `${clean(tertiary.snippet)}.` : '';

  const what_happened = [
    `${displayTopic} moved into the spotlight across ${catArea} following coordinated reports from major news outlets. ${s1}. ${snip1}`.replace(/\s+/g, ' ').trim(),
    [
      s2 !== s1 ? `Follow-up reporting detailed that ${s2}.` : `Journalists also confirmed new context surrounding ${displayTopic}.`,
      snip2 || `Coverage highlights verified facts already available in public releases and official briefings.`,
    ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim(),
  ].filter(Boolean).join('\n\n');

  const why_trending = [
    `Public interest around ${displayTopic} accelerated as audiences weighed in on ${s3 !== s1 ? s3.toLowerCase() : displayTopic}.`,
    snip3 || (s4 !== s3 ? `Additional commentary focused on ${s4}.` : `Ongoing discussion reflects strong public curiosity around verified developments and next steps.`),
  ].join(' ').replace(/\s+/g, ' ').trim();

  const bulletsRaw = [
    `${s1}.`,
    s2 !== s1 ? `${s2}.` : '',
    `${clean(tertiary.snippet) || s3}.`,
    s.length >= 4 && s4 !== s3 ? `${s4}.` : '',
  ].filter(Boolean);
  const bullets = [...new Set(bulletsRaw)].slice(0, 5);
  while (bullets.length < 3) bullets.push(`${displayTopic} coverage remains active across ${catArea}.`);

  const what_to_know_next = `Further official statements and scheduled updates on ${displayTopic} are awaited as public information develops. Readers should verify timing changes directly against primary announcements.`;

  const also_searched = [
    `${displayTopic} update`,
    `${displayTopic} explained`,
    s1.split(/\s+/).slice(0, 4).join(' '),
    s2.split(/\s+/).slice(0, 4).join(' '),
  ];

  return {
    title,
    category,
    summary: trimmedSummary,
    what_happened,
    why_trending,
    key_facts: bullets,
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

  // Up to 2 LLM attempts (attempt 2 fixes any single-shot validation miss with feedback before grounded failsafe)
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
        break;
      }
      continue;
    }

    const reqMinWords = !useMock && typeof options.customGenerator !== 'function' ? 185 : 120;
    const check = validateDraft(draft, topic, sources, existingTitles, { minWords: reqMinWords });
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
      text: `${newest.title.replace(/[.!?]+$/, '')}.`,
    },
    mergedSources,
  };
}
