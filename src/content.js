/**
 * LLM content generation, multi-model fallback (Workers AI -> Gemini),
 * strict JSON parsing, grounding verification, and post-level updates.
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

const SKIP_PROPER_WORDS = new Set([
  'the', 'this', 'that', 'these', 'those', 'their', 'there', 'here', 'what',
  'when', 'where', 'why', 'how', 'who', 'while', 'which', 'after', 'before',
  'during', 'reported', 'confirmed', 'unconfirmed', 'according', 'officials',
  'experts', 'analysts', 'residents', 'investors', 'viewers', 'fans', 'players',
  'users', 'customers', 'readers', 'search', 'trends', 'american', 'british',
  'canadian', 'european', 'australian', 'english', 'spanish', 'global',
  'national', 'federal', 'united', 'states', 'black', 'friday', 'cyber',
  'thanksgiving', 'christmas', 'easter', 'monday', 'tuesday', 'wednesday',
  'thursday', 'friday', 'saturday', 'sunday', 'january', 'february', 'march',
  'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november',
  'december', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept',
  'oct', 'nov', 'dec', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun',
]);

export const countWords = text =>
  String(text || '').trim().split(/\s+/).filter(Boolean).length;

function countSentences(text) {
  const cleaned = String(text || '')
    .replace(/\b(?:U\.S\.A|U\.S|U\.K|Dr|Mr|Mrs|Ms|St|Jr|Sr|Inc|Co|Corp|Ltd|vs|No|a\.m|p\.m|e\.g|i\.e|Jan|Feb|Mar|Apr|Aug|Sep|Sept|Oct|Nov|Dec)\./gi, '$1')
    .replace(/(\d)\.(\d)/g, '$1$2');
  const parts = cleaned.split(/[.!?]+(?:\s+|$)/).map(s => s.trim()).filter(Boolean);
  return parts.length;
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

/**
 * Validate draft structure, word count, banned phrases, duplicates,
 * and deterministic grounding of numbers, dates, and proper names.
 */
export function validateDraft(draft, topic, sources, existingTitles = new Set(), { minWords = 150 } = {}) {
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
  if (totalWords < minWords || totalWords > 250) {
    return { ok: false, reason: `word count ${totalWords} out of range (${minWords}-250)` };
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

  const sourceNums = extractNumericTokens(sourceCorpus);
  const draftNums = extractNumericTokens(fullText);
  for (const num of draftNums) {
    if (!sourceNums.has(num)) {
      return { ok: false, reason: `unsupported number/date: ${num}` };
    }
  }

  for (const [abbr, full] of [...MONTH_NAMES, ...DAY_NAMES]) {
    const capAbbr = abbr[0].toUpperCase() + abbr.slice(1);
    const capFull = full[0].toUpperCase() + full.slice(1);
    const re = new RegExp(`\\b(${capAbbr}|${capFull})\\b`);
    if (re.test(fullText) && !new RegExp(`\\b(${capAbbr}|${capFull})\\b`, 'i').test(sourceCorpus)) {
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
      const lw = w.toLowerCase().replace(/[^a-z0-9]/g, '');
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
    ? `\nIMPORTANT FIX FOR RETRY: Previous draft failed validation because: ${feedback}. Fix this exact issue (remove unprinted numbers, expand/trim to 180-220 words, keep title <= 55 chars, keep summary to 1 sentence, and end every bullet with [Outlet Name]).\n`
    : '';

  return `You are a neutral news editor writing a factual briefing for "${topic}" (category: ${category}).
Use ONLY facts, names, dates, and numbers explicitly present in SOURCES below. NEVER invent facts, stats, ages, or details.

SOURCES:
${formattedSources}
${feedbackBlock}
WRITING RULES:
1. Grade 8 reading level, short clear sentences, no hype, no clickbait, no emojis, no filler intros, no "in conclusion".
2. Do NOT mention being an AI. Do NOT use "shocking", "you won't believe", or "breaking" (unless "breaking" is in SOURCES).
3. Define who or what "${topic}" is in the first sentence of what_happened (full name + role, or clarify which meaning applies).
4. Use exact dates, times, and numbers from SOURCES. If details are unconfirmed or sources differ, write "reported but not confirmed".
5. Target 185 to 225 words total across summary + what_happened + why_trending + key_facts + what_to_know_next (MUST be 150-250 words — write 4 detailed key_facts bullets so it easily clears 175 words).
6. EVERY bullet in key_facts MUST end with the source outlet name inside square brackets, like: "Team A won 2-1 in London [ESPN]."

OUTPUT ONLY VALID JSON (no markdown fences):
{
  "title": "<STRICTLY under 56 chars, plain language, includes ${topic} and search intent>",
  "category": "${category}",
  "summary": "<ONE single sentence, 20-28 words, directly answering what happened>",
  "what_happened": "<3 short sentences (60-80 words) covering who, what, when, where>",
  "why_trending": "<2 sentences (35-45 words) explaining why people are searching now>",
  "key_facts": ["<fact 1 [Outlet Name]>", "<fact 2 [Outlet Name]>", "<fact 3 [Outlet Name]>", "<fact 4 [Outlet Name]>"],
  "what_to_know_next": "<1-2 sentences (25-40 words) on upcoming date, next step, or what remains unconfirmed>",
  "also_searched": ["<related phrase 1 from sources>", "<related phrase 2>", "<related phrase 3>"]
}`;
}

async function discoverGeminiModels(env) {
  const candidates = [];
  if (env.GEMINI_MODEL) candidates.push(env.GEMINI_MODEL);
  if (cachedGeminiModel) candidates.push(cachedGeminiModel);

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${env.GEMINI_API_KEY}`);
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
  return candidates.slice(0, 4);
}

/**
 * Call Workers AI across active models, falling back to Gemini free API.
 */
export async function callLLM(env, prompt) {
  const errors = [];

  if (env.AI) {
    const aiModels = [...new Set([env.AI_MODEL, cachedAiModel, ...WORKERS_AI_MODELS].filter(Boolean))];
    for (const model of aiModels) {
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
        if (model === cachedAiModel) cachedAiModel = null;
      }
    }
  } else {
    errors.push('Workers AI binding missing');
  }

  if (!env.GEMINI_API_KEY) {
    throw new Error(`LLM unavailable (${errors.join('; ')})`);
  }

  const geminiModels = await discoverGeminiModels(env);
  for (const model of geminiModels) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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
    }
  }

  throw new Error(errors.join('; '));
}

async function verifyWithLLM(env, draft, topic, sources) {
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
    const raw = await callLLM(env, prompt);
    const parsed = extractJsonObject(raw);
    if (parsed.ok === false) return { ok: false, reason: parsed.reason || 'failed LLM fact-check' };
    return { ok: true };
  } catch {
    return { ok: true };
  }
}

/**
 * Deterministic grounded mock generator for DEV_MODE and offline test suite.
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
 * - Returns infra_error when LLM service fails so topic is NOT permanently blacklisted
 * - Returns ok: false with code sensitive | single_source | quality_gate for content rejections
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
  let infraFailures = 0;

  for (let attempt = 0; attempt < 3; attempt++) {
    let draft;
    try {
      if (typeof options.customGenerator === 'function') {
        draft = await options.customGenerator(topic, category, sources, attempt, feedback);
      } else if (useMock) {
        draft = mockGenerate(topic, category, sources);
      } else {
        const raw = await callLLM(env, buildWriterPrompt(topic, category, sources, feedback));
        draft = extractJsonObject(raw);
      }
    } catch (err) {
      lastReason = `generation error: ${err.message}`;
      feedback = lastReason;
      if (/HTTP \d+|unavailable|subrequests|timeout/i.test(err.message)) {
        infraFailures++;
        if (infraFailures >= 2) {
          return { ok: false, code: 'infra_error', reason: lastReason };
        }
      }
      continue;
    }

    const minWords = attempt < 2 ? 150 : 110;
    const check = validateDraft(draft, topic, sources, existingTitles, { minWords });
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
