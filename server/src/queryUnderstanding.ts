/**
 * Query understanding: a small structured LLM pass that turns the latest user message
 * (plus the recent conversation) into retrieval-ready queries BEFORE grounding runs.
 *
 * Why this exists: the knowledge base is searched lexically (SQLite FTS with AND-first
 * semantics on the MCP side, BM25 on the local corpus side), so a question fails when
 * its vocabulary doesn't meet the documents' vocabulary — "why did you leave Bitcoin"
 * never reaches the essay that says "withdrew from public view, rather disillusioned",
 * and "NAR/DAR" never reaches the essay that spells out "Network Access Rules (NAR)".
 *
 * The pass returns a standalone, context-resolved query plus a few alternative
 * phrasings in document vocabulary (multi-query retrieval). Everything here is pure
 * and fail-open: a malformed or unanchored model reply is discarded and the caller
 * falls back to the deterministic regex path. The module never calls a provider —
 * index.ts owns the runChain invocation, mirroring the citation filter's precedent.
 */

import { AnswerCache } from './cache.js';

export interface QueryUnderstanding {
  /** Standalone, context-resolved retrieval query. */
  query: string;
  /** Alternative phrasings in the vocabulary a source document would use. */
  variants: string[];
  /** True when the message only makes sense via the conversation — never cache those answers as standalone. */
  followUp: boolean;
}

/**
 * Protocol/spec identifiers that already retrieve perfectly on their own. Shared with
 * the orchestrator's keyword extractor so both paths recognise the same strong signals.
 */
export const PROTOCOL_ID_SOURCE =
  '(?:BRC-?\\d+s?|OP_[A-Z0-9_]+|BEEF|SPV|UTXO|Rúnar|Runar|SDK|TS-?stack|Arc(?:ade)?|WoC)';

export function hasProtocolId(question: string): boolean {
  return new RegExp(`\\b${PROTOCOL_ID_SOURCE}\\b`, 'i').test(question);
}

/**
 * Coined ecosystem acronyms the snapshot spells out in full. The FTS layer needs the
 * expansion: "NAR/DAR" alone matches nothing, because the essays tokenise as
 * "network access rules" / "digital asset recovery". Append-only — the acronym stays.
 */
const TERM_EXPANSIONS: [RegExp, string][] = [
  [/\bNAR\b/i, 'Network Access Rules'],
  [/\bDAR\b/i, 'Digital Asset Recovery'],
];

export function expandTerms(text: string): string {
  let out = text;
  for (const [pattern, expansion] of TERM_EXPANSIONS) {
    if (pattern.test(out) && !out.toLowerCase().includes(expansion.toLowerCase())) {
      out = `${out} ${expansion}`;
    }
  }
  return out;
}

/** Anaphora and back-references that mean "this message needs the conversation". */
const FOLLOW_UP_REFERENCE =
  /\b(it|that|this|they|them|those|these|he|she|him|her|both|same)\b|\bwhat about\b|\bthe two\b/i;

/** Whole-message pleasantries — a rewrite would add latency and quota spend for nothing. */
const COURTESY =
  /^(?:hi|hiya|hello|hey|yo|morning|afternoon|evening|thanks|thank you|cheers|ta|ok|okay|great|nice|cool|lovely|interesting|wow|lol|haha|bye|goodbye|noted|fair enough)\b[\s\w'’.,!-]*$/i;

/**
 * When is the understanding pass NOT worth the latency/quota? Bare courtesies, and
 * standalone questions that already carry a strong protocol identifier — the
 * deterministic path retrieves those perfectly today.
 */
export function shouldSkipRewrite(question: string): boolean {
  const q = question.trim();
  if (!q) return true;
  if (q.split(/\s+/).length <= 8 && !q.includes('?') && COURTESY.test(q)) return true;
  return hasProtocolId(q) && !FOLLOW_UP_REFERENCE.test(q);
}

const QUERY_UNDERSTANDING_SYSTEM = [
  "You are the query-understanding stage of a retrieval system over a pinned Bitcoin knowledge base: Satoshi Nakamoto's 2008–2011 posts and emails, the later essay corpus of Bitcoin's designer (Medium/Substack), and the BSV protocol record (BRCs, Script opcodes, SDK and academy docs).",
  'Given the latest user message and the recent conversation, produce search queries that retrieve the right source documents. You never answer the question.',
  'Rules:',
  '- Resolve pronouns and references ("it", "that", "the two", "he") against the conversation so "query" stands alone.',
  '- Keep the user\'s subject terms verbatim in "query" — names, nouns, verbs and protocol identifiers (BRC-100, OP_CHECKSIG, BEEF) must survive unchanged.',
  '- Expand known acronyms by appending the full term (NAR → Network Access Rules, DAR → Digital Asset Recovery, SPV → Simplified Payment Verification). Keep the acronym too. Never invent an expansion you are unsure of.',
  '- Strip conversational padding (please, can you tell me, thanks).',
  '- "variants": up to 3 alternative phrasings of the same need, using the vocabulary a source document would actually use — technical terms, historical descriptions, synonyms. Documents rarely say "leave" or "move on"; they say "withdrew from public view", "departure", "disillusioned". Variants may drop the user\'s wording entirely.',
  '- Keep each variant TIGHT: 3 to 8 content words, no stopwords. The search is AND-first, so a single word that does not appear in the target document kills the whole variant. Short and dense beats long and descriptive.',
  '- Variants must differ from "query" and from each other. Bare search phrases — no questions, no padding, no punctuation flourish.',
  'Reply with ONLY a JSON object on one line, no prose, no markdown fences:',
  '{"query": "<standalone query>", "variants": ["<phrasing>", ...], "followup": <true if the message only makes sense via the conversation, else false>}',
].join('\n');

const MAX_HISTORY_MESSAGES = 4;
const MAX_HISTORY_CHARS = 400;

export function buildQueryUnderstandingRequest(
  question: string,
  history: { role: 'user' | 'assistant'; content: string }[],
): { system: string; userContent: string } {
  const lines = history.slice(-MAX_HISTORY_MESSAGES).map((m) => {
    const speaker = m.role === 'assistant' ? 'Satoshi' : 'User';
    const text = m.content.replace(/\s+/g, ' ').trim();
    return `${speaker}: ${text.length > MAX_HISTORY_CHARS ? `${text.slice(0, MAX_HISTORY_CHARS)}…` : text}`;
  });
  const userContent = [
    ...(lines.length ? ['Conversation (oldest first):', ...lines, ''] : []),
    'Latest user message:',
    question,
  ].join('\n');
  return { system: QUERY_UNDERSTANDING_SYSTEM, userContent };
}

const MAX_QUERY_CHARS = 320;
const MAX_VARIANTS = 3;

/**
 * Stopwords for the anchor guard below. The guard exists to catch a catastrophic
 * rewrite (a model that invents an unrelated topic), not to enforce overlap — the
 * whole point of the pass is bridging vocabulary, so only genuinely shared subject
 * tokens count.
 */
const GUARD_STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'then', 'than', 'them', 'they',
  'have', 'has', 'had', 'you', 'your', 'yours', 'what', 'when', 'where', 'which', 'who',
  'whom', 'why', 'how', 'are', 'was', 'were', 'will', 'would', 'could', 'should', 'does',
  'did', 'done', 'about', 'into', 'but', 'not', 'all', 'any', 'can', 'our', 'out', 'per',
  'say', 'she', 'him', 'his', 'her', 'its', 'too', 'use', 'used', 'via',
]);

function anchorTokens(text: string): Set<string> {
  const tokens = new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !GUARD_STOP.has(t)),
  );
  // Acronyms the user actually wrote (NAR, DAR, SPV) count as anchors even when short.
  for (const m of text.matchAll(/\b[A-Z0-9]{2,}\b/g)) tokens.add(m[0].toLowerCase());
  return tokens;
}

function sharesAnchor(query: string, question: string, context?: string): boolean {
  const anchors = anchorTokens(`${question} ${context ?? ''}`);
  return [...anchorTokens(query)].some((t) => anchors.has(t));
}

/**
 * Parse the model's reply into a QueryUnderstanding. Returns undefined on any
 * deviation — missing/oversized query, unparseable JSON, or a rewrite that shares no
 * vocabulary with the question and conversation — so the caller fails open.
 */
export function parseQueryUnderstanding(
  reply: string,
  question: string,
  context?: string,
): QueryUnderstanding | undefined {
  const match = /\{[\s\S]*\}/.exec(reply);
  if (!match) return undefined;
  let parsed: unknown;
  try {
    // Models sometimes emit raw newlines/tabs inside JSON strings, which strict
    // JSON.parse rejects. They are insignificant between tokens and safely become
    // spaces inside string values.
    parsed = JSON.parse(match[0].replace(/[\r\n\t]+/g, ' '));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;
  const query = typeof obj.query === 'string' ? obj.query.replace(/\s+/g, ' ').trim() : '';
  if (query.length < 3 || query.length > MAX_QUERY_CHARS) return undefined;
  if (!sharesAnchor(query, question, context)) return undefined;
  const seen = new Set<string>([query.toLowerCase()]);
  const variants: string[] = [];
  if (Array.isArray(obj.variants)) {
    for (const raw of obj.variants) {
      if (typeof raw !== 'string') continue;
      const clean = raw.replace(/\s+/g, ' ').trim();
      if (clean.length < 3 || clean.length > MAX_QUERY_CHARS) continue;
      const key = clean.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      variants.push(clean);
      if (variants.length >= MAX_VARIANTS) break;
    }
  }
  return { query, variants, followUp: obj.followup === true };
}

/** Cache key for a rewrite: the question plus the prior turn it was resolved against. */
export function rewriteCacheKey(question: string, priorUser?: string): string {
  return `${priorUser ? `${AnswerCache.key(priorUser)} » ` : ''}${AnswerCache.key(question)}`;
}

/**
 * In-memory LRU for rewrites, keyed by rewriteCacheKey. Same restart-safe rationale as
 * the answer cache: losing it just means one extra understanding call per question.
 */
export class RewriteCache {
  private readonly map = new Map<string, { value: QueryUnderstanding; ts: number }>();

  constructor(
    private readonly max = 200,
    private readonly ttlMs = 6 * 3_600_000,
  ) {}

  get(key: string): QueryUnderstanding | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.ts > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: QueryUnderstanding): void {
    this.map.delete(key);
    this.map.set(key, { value, ts: Date.now() });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}
