/**
 * Short-input search expansions.
 *
 * Questions of a few content words often miss the index because the user wrote
 * "op return" or "merkle" and the documents say "OP_RETURN" or "Merkle proof".
 * A cheap model may suggest up to four search phrases and a short intent label
 * before retrieval. The phrases are extra queries only: they are never written
 * into the evidence, the citations, or the answer-cache key. Any timeout, missing
 * key, or unparseable reply leaves retrieval exactly as it was.
 *
 * The answer cache stays keyed by the question alone (see answerCacheKeyForTurn).
 * Phrase text is cached separately, the same way a rewrite is, so a repeat does
 * not call the model again and does not fork the answer cache.
 */

import { isBareOffTopicShape } from './bareInput.js';
import { AnswerCache } from './cache.js';
import { looksLikeAppDirectoryQuestion } from './bsvRadar.js';
import { looksLikeNewsQuestion } from './coingeekNews.js';
import { isIdentityQuestion, isTimecoinQuestion } from './curatedReference.js';
import { hasProtocolId, rewriteCacheKey, shouldSkipRewrite } from './queryUnderstanding.js';
import { contentTokens, isNamedSpecLookup } from './retrievalShape.js';

/** Wall-clock cap. Past this, retrieval proceeds with no expansion. */
export const SHORT_EXPANSION_TIMEOUT_MS = 2_000;

const MAX_CONTENT_TOKENS = 6;
const MAX_PHRASES = 4;
const MAX_PHRASE_WORDS = 10;
const MAX_PHRASE_CHARS = 80;
const MAX_INTENT_CHARS = 48;
const MAX_QUESTION_CHARS = 400;
const MAX_PRIOR_CHARS = 200;

const WORD = /[A-Za-z0-9]+(?:[_-][A-Za-z0-9]+)*/g;

/** A ticker or a contested label the user did not write. Those are claims, not search terms. */
const CHAIN_CLAIM =
  /\b(?:btc|bch|bsv|bitcoin\s+cash|bitcoin\s+sv|bitcoin\s+core)\b/i;
const CONTESTED_CLAIM = /\b(?:hijack(?:ed|ing)?|scam|ponzi|fraud|craig\s+wright)\b/i;

const SYSTEM = [
  'You suggest search phrases for a Bitcoin document index: Satoshi Nakamoto\'s 2008–2011 posts, later essays, and the protocol record (BRCs, Script, SDK). You never answer the question.',
  'Reply with ONLY one JSON object, no markdown:',
  '{"phrases":["<search phrase>"],"intent":"<two to six words>"}',
  'Rules:',
  '- phrases: at most 4 short phrases a source document would actually contain. Synonyms and technical spellings are welcome.',
  '- Each phrase is plain words, at most 8 words. No sentences and no claims.',
  '- Do not assert which chain is the real one. Do not add BTC, BCH, BSV, hijack, scam, fraud, or ponzi unless the user already used that word.',
  '- If nothing in the index would help, return {"phrases":[],"intent":"unrelated"}.',
  '- intent is a short label of the likely need. It is not searched and it is not an answer.',
].join('\n');

export interface ShortExpansionRequest {
  system: string;
  userContent: string;
}

export type ShortExpansionModel = (request: ShortExpansionRequest) => Promise<string | null>;

export type ShortExpansionStatus = 'skipped' | 'cache' | 'ok' | 'empty' | 'discarded' | 'timeout';

export interface ShortExpansionOutcome {
  phrases: string[];
  status: ShortExpansionStatus;
}

/**
 * Spaced opcodes ("op return") are not a protocol id — the id form is OP_RETURN —
 * and the bare-input guard would otherwise treat them as an unknown noun. They are
 * the case the expansion is for. A lone word such as "sourdough" stays with the guard.
 */
function isSpacedOpcode(question: string): boolean {
  return /\bop\s+[a-z0-9]{2,}\b/i.test(question);
}

/** True when this message is short enough, and not already classified, to spend a model call. */
export function shouldRequestShortExpansion(question: string): boolean {
  const q = question.trim();
  if (!q) return false;
  if (shouldSkipRewrite(q)) return false;
  if (hasProtocolId(q) || isNamedSpecLookup(q)) return false;
  if (isTimecoinQuestion(q) || isIdentityQuestion(q)) return false;
  if (looksLikeNewsQuestion(q) || looksLikeAppDirectoryQuestion(q)) return false;
  if (isBareOffTopicShape(q) && !isSpacedOpcode(q)) return false;
  const count = contentTokens(q).length;
  return count > 0 && count <= MAX_CONTENT_TOKENS;
}

/** No keys, an image, or a squeezed breaker: do not call. */
export function shouldRunShortExpansion(input: {
  question: string;
  hasKeys: boolean;
  hasImage?: boolean;
  constrained?: boolean;
}): boolean {
  if (!input.hasKeys || input.hasImage || input.constrained) return false;
  return shouldRequestShortExpansion(input.question);
}

/**
 * The answer cache key is the question alone. Expansion phrases must not be
 * appended: they are model output, and the existing key already covers repeat asks.
 */
export function answerCacheKeyForTurn(question: string, _phrases: readonly string[] = []): string {
  return AnswerCache.key(question);
}

export function buildShortExpansionRequest(question: string, priorUser?: string): ShortExpansionRequest {
  const asked = question.replace(/\s+/g, ' ').trim().slice(0, MAX_QUESTION_CHARS);
  const prior = priorUser?.replace(/\s+/g, ' ').trim().slice(0, MAX_PRIOR_CHARS);
  const userContent = prior
    ? `Previous user message (context only):\n${prior}\n\nLatest user message:\n${asked}`
    : asked;
  return { system: SYSTEM, userContent };
}

function plainWords(raw: string): string {
  return (raw.match(WORD) ?? []).join(' ');
}

function mentionsNew(pattern: RegExp, phrase: string, question: string): boolean {
  const found = phrase.match(pattern);
  if (!found) return false;
  return !question.toLowerCase().includes(found[0].toLowerCase());
}

/** Drop a phrase that adds a chain ticker or a contested claim the user did not write. */
export function introducesChainClaim(phrase: string, question: string): boolean {
  return mentionsNew(CHAIN_CLAIM, phrase, question) || mentionsNew(CONTESTED_CLAIM, phrase, question);
}

function cleanPhrase(raw: string, question: string, seen: Set<string>): string | undefined {
  const phrase = plainWords(raw).slice(0, MAX_PHRASE_CHARS).trim();
  const words = phrase.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > MAX_PHRASE_WORDS) return undefined;
  if (phrase.length < 3) return undefined;
  if (introducesChainClaim(phrase, question)) return undefined;
  const key = phrase.toLowerCase();
  if (seen.has(key)) return undefined;
  seen.add(key);
  return phrase;
}

/**
 * Parse the model's JSON. Undefined means the reply is unusable and the caller
 * must keep the deterministic queries. An empty phrase list with a valid label
 * is a successful "nothing to add".
 */
export function parseShortExpansion(
  reply: string,
  question: string,
): { phrases: string[]; intent: string } | undefined {
  const match = /\{[\s\S]*\}/.exec(reply);
  if (!match) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0].replace(/[\r\n\t]+/g, ' '));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.intent !== 'string' || !Array.isArray(obj.phrases)) return undefined;
  const intent = plainWords(obj.intent).slice(0, MAX_INTENT_CHARS).trim();
  if (intent.length < 2) return undefined;
  const seen = new Set<string>([plainWords(question).toLowerCase()]);
  const phrases: string[] = [];
  for (const raw of obj.phrases) {
    if (typeof raw !== 'string') continue;
    const phrase = cleanPhrase(raw, question, seen);
    if (!phrase) continue;
    phrases.push(phrase);
    if (phrases.length >= MAX_PHRASES) break;
  }
  return { phrases, intent };
}

/** Existing queries first, then expansions, case-insensitive, capped. */
export function mergeRetrievalQueries(
  existing: readonly string[],
  extra: readonly string[],
  cap = 8,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...existing, ...extra]) {
    const trimmed = raw.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= cap) break;
  }
  return out;
}

/** LRU of accepted phrase lists. Failures are not stored, so a later ask can try again. */
export class ShortExpansionCache {
  private readonly map = new Map<string, { phrases: string[]; ts: number }>();

  constructor(
    private readonly max = 200,
    private readonly ttlMs = 6 * 3_600_000,
  ) {}

  get(key: string): string[] | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.ts > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.phrases;
  }

  set(key: string, phrases: string[]): void {
    this.map.delete(key);
    this.map.set(key, { phrases, ts: Date.now() });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}

export async function expandShortQuery(
  question: string,
  model: ShortExpansionModel,
  opts?: {
    timeoutMs?: number;
    priorUser?: string;
    cache?: ShortExpansionCache;
    hasKeys?: boolean;
    hasImage?: boolean;
    constrained?: boolean;
    /** Called when the wait ends without a reply, so the provider request can be cancelled. */
    abort?: () => void;
  },
): Promise<ShortExpansionOutcome> {
  const enabled = shouldRunShortExpansion({
    question,
    hasKeys: opts?.hasKeys ?? true,
    hasImage: opts?.hasImage,
    constrained: opts?.constrained,
  });
  if (!enabled) return { phrases: [], status: 'skipped' };

  const cacheKey = rewriteCacheKey(question, opts?.priorUser);
  const cached = opts?.cache?.get(cacheKey);
  if (cached) return { phrases: cached, status: 'cache' };

  const timeoutMs = opts?.timeoutMs ?? SHORT_EXPANSION_TIMEOUT_MS;
  const request = buildShortExpansionRequest(question, opts?.priorUser);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    const reply = await Promise.race([model(request).catch(() => null), timeout]);
    if (!reply) {
      opts?.abort?.();
      return { phrases: [], status: 'timeout' };
    }
    const parsed = parseShortExpansion(reply, question);
    if (!parsed) return { phrases: [], status: 'discarded' };
    opts?.cache?.set(cacheKey, parsed.phrases);
    return { phrases: parsed.phrases, status: parsed.phrases.length > 0 ? 'ok' : 'empty' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
