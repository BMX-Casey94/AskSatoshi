/**
 * Bare off-topic inputs ("Sourdough", "Pizza") never reach the model.
 *
 * A single unrelated word has no verb and no record, but with a model available the
 * chat route still calls it under the NO RECORD block. The model then invents a
 * Bitcoin lesson. This module answers those inputs with a short in-voice
 * clarification: no provider call, no citations, no review, no cache. The caller
 * flags the turn the same way as other ungrounded replies (`general: true`).
 *
 * Recognition uses the classifiers retrieval already has (protocol ids, timecoin,
 * scaling, generic Bitcoin vocabulary, head compounds, title overlap). It does not
 * keep a list of foods or other off-topic words.
 */

import {
  isIdentityQuestion,
  isImplementationQuestion,
  isScalingQuestion,
  isTimecoinQuestion,
} from './curatedReference.js';
import type { Grounding } from './orchestrate.js';
import { extractKeywords, hasProtocolId, headNounQuery, shouldSkipRewrite, supplementaryQueries } from './queryUnderstanding.js';
import {
  classifyRetrieval,
  isMechanismRetrieval,
  isNamedSpecLookup,
  isSatoshiQuoteQuestion,
  sharesSubject,
  subjectTerms,
} from './retrievalShape.js';

const MAX_TOKENS = 3;

/**
 * Mirrors TECHNICAL_SUBJECT in retrievalShape.ts. That pattern is not exported;
 * a lone "opcode" or "Script" must still count as a Bitcoin term when the index
 * returns nothing. Plural "blocks" / "wallets" is reduced by one trailing s first.
 */
const TECHNICAL_SUBJECT =
  /\b(merkle|utxo|coinbase|opcode|opcodes|script|hash|signature|private|public|address|mining|miner|miners|block|transaction|transactions|spend|spending|output|input|header|nonce|difficulty|wallet|node|peer|proof|branch|inclusion|op_return|spv|beef|key|keys)\b/i;

/** Question words and auxiliaries. A lexical verb in a three-word remark is still a fragment. */
const QUESTION_CUE =
  /[?]|\b(?:what|why|how|who|when|where|which|whose|whom|is|are|was|were|am|do|does|did|can|could|should|would|will|shall|has|have|had|tell|explain|describe|define|compare|mean|means|meant)\b/i;

export interface BareInputOptions {
  /** An attached image is the question; the vision path must still run. */
  hasImage?: boolean;
  /** A short follow-up needs the previous turn. Do not treat it as a new topic. */
  followUp?: boolean;
}

const NONE: Grounding = { mode: 'none', evidenceText: '', citations: [] };

function bareTokens(text: string): string[] {
  return text
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter((token) => token.length > 0);
}

/** Courtesies the rewrite pass already skips. Protocol ids are not courtesies. */
function isCourtesy(text: string): boolean {
  return shouldSkipRewrite(text) && !hasProtocolId(text);
}

function mentionsTechnicalSubject(text: string): boolean {
  if (TECHNICAL_SUBJECT.test(text)) return true;
  const deplural = text.replace(/\b([A-Za-z]{4,})s\b/g, '$1');
  return deplural !== text && TECHNICAL_SUBJECT.test(deplural);
}

function normalisedTerms(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The retriever already rewrites this into a known subject (NAR → Network Access
 * Rules, "1mb" → block size, "leave" → withdrew). A head-noun fallback that only
 * repeats the user's own word ("sourdough" from "sourdough bread recipe") is not
 * one of those rewrites. Punctuation is ignored, so "Sourdough." is not an expansion.
 */
function retrieverKnowsSubject(text: string): boolean {
  const keywords = extractKeywords(text);
  const own = normalisedTerms(text);
  if (keywords && normalisedTerms(keywords) !== own && keywords.length > text.trim().length) return true;
  const owns = new Set(own.split(' ').filter(Boolean));
  const known = (query: string): boolean => {
    const key = normalisedTerms(query);
    return key.length > 0 && key !== own && !owns.has(key);
  };
  if (supplementaryQueries(text).some(known)) return true;
  return known(headNounQuery(`${text} notes`) ?? '');
}

/**
 * True when the fragment is already a Bitcoin/BSV subject under the existing
 * classifiers, so a short query such as "UTXO" or "blocks" is answered normally.
 */
export function isRecognisedBitcoinFragment(text: string): boolean {
  if (hasProtocolId(text)) return true;
  if (isTimecoinQuestion(text)) return true;
  if (isScalingQuestion(text)) return true;
  if (isIdentityQuestion(text)) return true;
  if (isImplementationQuestion(text)) return true;
  if (isNamedSpecLookup(text)) return true;
  if (isSatoshiQuoteQuestion(text)) return true;
  if (isMechanismRetrieval(text)) return true;
  if (classifyRetrieval(text) !== 'general') return true;
  if (mentionsTechnicalSubject(text)) return true;
  const { terms, specific } = subjectTerms(text);
  if (terms.length > 0 && !specific) return true;
  return retrieverKnowsSubject(text);
}

/** Shape only: a short non-question that is not a greeting, an image, or a Bitcoin term. */
export function isBareOffTopicShape(question: string, options: BareInputOptions = {}): boolean {
  if (options.hasImage || options.followUp) return false;
  const text = question.trim();
  if (!text || isCourtesy(text)) return false;
  const tokens = bareTokens(text);
  if (tokens.length === 0 || tokens.length > MAX_TOKENS) return false;
  if (QUESTION_CUE.test(text)) return false;
  if (isRecognisedBitcoinFragment(text)) return false;
  return true;
}

/**
 * Title overlap with the user's own subject. A non-specific question ("Bitcoin",
 * "blocks") treats any retrieved record as relevant. A question with no content
 * word ("ok") does not: the gate fail-opens and would otherwise keep every title.
 */
export function hasRelevantGrounding(question: string, grounding: Grounding = NONE): boolean {
  if (grounding.mode === 'none') return false;
  if (!grounding.evidenceText.trim() && grounding.citations.length === 0) return false;
  const { terms, specific } = subjectTerms(question);
  if (terms.length === 0) return false;
  if (!specific) return true;
  const titles = grounding.citations.map((citation) => `${citation.title ?? ''} ${citation.label ?? ''}`).join(' ');
  if (titles.trim() && sharesSubject(question, titles)) return true;
  if (grounding.citations.length === 0 && sharesSubject(question, grounding.evidenceText)) return true;
  return false;
}

function topicPhrase(raw: string): string {
  const cleaned = raw
    .replace(/[^\p{L}\p{N}\s'’-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || 'that';
}

function leading(topic: string): string {
  return topic.charAt(0).toUpperCase() + topic.slice(1);
}

/** Varied in-voice clarifications. The subject is the user's words; the question asks which they meant. */
const CLARIFICATIONS: readonly ((topic: string) => string)[] = [
  (topic) =>
    `${leading(topic)} isn't something the record covers. Did you mean to ask about that, or about Bitcoin?`,
  (topic) =>
    `I've nothing on ${topic} in the writings or the protocol record. Were you asking about it, or about Bitcoin?`,
  (topic) => `That isn't in the record I keep. Did you want to ask about ${topic}, or about Bitcoin?`,
  (topic) => `${leading(topic)} doesn't appear in what I have here. A question about it, or about Bitcoin?`,
];

function clarificationLine(question: string): string {
  const topic = topicPhrase(question);
  let hash = 0;
  const seed = topic.toLowerCase();
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  const line = CLARIFICATIONS[hash % CLARIFICATIONS.length];
  if (line) return line(topic);
  return `${leading(topic)} isn't something the record covers. Did you mean to ask about that, or about Bitcoin?`;
}

/**
 * The reply to send instead of calling the model, or null when this input should
 * follow the normal grounded path.
 */
export function bareInputClarification(
  question: string,
  grounding: Grounding = NONE,
  options: BareInputOptions = {},
): string | null {
  if (!isBareOffTopicShape(question, options)) return null;
  if (hasRelevantGrounding(question, grounding)) return null;
  return clarificationLine(question);
}
