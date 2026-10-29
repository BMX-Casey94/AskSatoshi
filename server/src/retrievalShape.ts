/**
 * Question-shape classifier and citation relevance for retrieval.
 *
 * Slot mix follows the question (mechanism, named spec, concept, Satoshi's own
 * words, scaling, builder). It is not one global order. A citation is kept when
 * its title shares a distinctive content word with the question. Domain words
 * that show up in a large share of the pinned corpus and the protocol index do
 * not count on their own once a sharper word is present. A question whose only
 * subject is one of those words ("Bitcoin", "blocks") still grounds. A common
 * English verb does not qualify a code symbol, and it does not qualify a
 * primary source from the body alone — "happened" in an unrelated mail, or
 * "Stop" as an exported method, is not the subject.
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isImplementationQuestion, isScalingQuestion } from './curatedReference.js';
import { phraseExpansionQueries } from './queryUnderstanding.js';

export type RetrievalShape =
  | 'mechanism'
  | 'named-spec'
  | 'concept'
  | 'satoshi-quote'
  | 'scaling'
  | 'builder'
  | 'general';

export type GateSource = 'satoshi-primary' | 'spec' | 'later-commentary' | 'internal';

export interface SlotBudget {
  essay: number;
  spec: number;
  primary: number;
  specLeads: boolean;
  primaryLeads: boolean;
  /** brc/doc before symbol/example/test. */
  rankSpecs: boolean;
  /** A promoted spec must contain the subject in its title. Standard mechanism only. */
  subjectConstrained: boolean;
}

/** Mirrors isConceptualQuestion in orchestrate.ts — keep the two in step. */
const CONCEPTUAL =
  /\b(why|meant|intended|original|vision|philosophy|design|always|hijack|co-?opt|satoshi|believe|think|opinion|compare|compares|compared|comparing|comparable|comparison|versus|vs|similar|similarity|difference|differences)\b/i;

const CONTESTED =
  /\b(hijack|co-?opt|original vision|meant to|intended to|always (meant|supposed)|stolen|taken over|true bitcoin|should bitcoin|ought)\b/i;

const TECHNICAL_SUBJECT =
  /\b(merkle|utxo|coinbase|opcode|opcodes|script|hash|signature|private|public|address|mining|miner|miners|block|transaction|transactions|spend|spending|output|input|header|nonce|difficulty|wallet|node|peer|proof|branch|inclusion|op_return|spv|beef|key|keys)\b/i;

const SATOSHI_QUOTE =
  /\bwhat did (?:satoshi|you) (?:say|write|post|state|claim)\b|\bwhat (?:has|did) satoshi (?:say|write|post|state|claim)\b/i;

const NAMED_SPEC_ID = /\b(?:BRC-?\d+s?|BEEF)\b/i;

/**
 * Domain nouns that may be generic, but only after document frequency admits them.
 * A candidate below the cutoff stays specific (merkle, utxo, ponzi). The stem
 * "nod" is the tokenizer's form of "nodes".
 */
const DOMAIN_CANDIDATES = [
  'bitcoin', 'btc', 'bsv', 'blockchain', 'block', 'chain', 'coin', 'money', 'cash',
  'transaction', 'network', 'protocol', 'node', 'nod', 'payment', 'system', 'crypto',
  'cryptocurrency',
] as const;

/**
 * The author name is a question frame, the way "you" is, but titles rarely contain
 * it — posts are titled "Re: …" and signed at the bottom — so title frequency
 * understates it. It is generic when the index actually contains it.
 */
const AUTHOR_FRAME = ['satoshi', 'nakamoto'] as const;

/**
 * Used when the corpus and the protocol index cannot be read. Same closed set the
 * frequency rule is aimed at, so a missing file does not open every title.
 */
const FALLBACK_GENERIC = new Set<string>([...DOMAIN_CANDIDATES, ...AUTHOR_FRAME]);

/**
 * Common English verbs. Overlap on one of these is not a subject match for a code
 * symbol ("Stop" the exported method) and is not enough to cite a primary whose
 * title never says the word. Stems are the forms contentTokens emits ("stopped"
 * still matches "stop" through the prefix check).
 */
const COMMON_VERBS = new Set([
  'stop', 'happen', 'disappear', 'leave', 'left', 'go', 'gone', 'went', 'come', 'get',
  'take', 'see', 'think', 'start', 'try', 'put', 'let', 'keep', 'look', 'find', 'give',
  'quit', 'move', 'turn', 'run', 'call', 'ask', 'seem', 'begin', 'end', 'help',
]);

/** Share of documents a domain candidate must reach before it stops being distinctive. */
const GENERIC_SHARE = 0.02;
const GENERIC_MIN_DOCS = 8;

const CONTENT_STOP = new Set(
  (
    'a,an,and,are,as,at,be,been,but,by,can,could,did,do,does,for,from,had,has,have,he,her,his,how,i,if,in,into,is,it,its,me,my,of,on,or,so,tell,that,the,their,them,they,this,to,was,we,were,what,when,which,who,why,will,with,you,your,about,know,known,want,wanted,like,show,explain,describe,give,say,said,please,thanks,thank,' +
    'not,there,here,than,then,too,very,just,again,once,such,no,nor,only,own,same,some,any,all,' +
    'prove,proves,proving,create,creates,creating,created,prevent,prevents,prevented,shows,need,needs,work,works,make,makes,made,stay,stays,mean,means,meant,include,included,includes,using,used,use,new,one,also,into,' +
    'invent,invented,invents,write,wrote,written,post,posted,state,stated,claim,claimed,limit,limits'
  ).split(','),
);

const TOKEN = /BRC-?\d+s?|OP_[A-Za-z0-9_]+|[A-Za-z0-9]+/gi;

export function stemLight(word: string): string {
  const brc = /^brc-?(\d+)s?$/i.exec(word);
  if (brc) return `brc-${brc[1]}`;
  let w = word.toLowerCase();
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith('es')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  return w;
}

export function contentTokens(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of text.matchAll(TOKEN)) {
    const raw = match[0];
    const low = raw.toLowerCase();
    if (CONTENT_STOP.has(low)) continue;
    const stemmed = stemLight(raw);
    if (!stemmed || CONTENT_STOP.has(stemmed)) continue;
    if (stemmed.length < 3 && !/^brc-\d+$/.test(stemmed)) continue;
    if (seen.has(stemmed)) continue;
    seen.add(stemmed);
    out.push(stemmed);
  }
  return out;
}

interface TitleLexicon {
  docCount: number;
  freq: Map<string, number>;
  generic: Set<string>;
}

let lexiconCache: TitleLexicon | undefined;

function countFrequencies(texts: readonly string[]): Map<string, number> {
  const freq = new Map<string, number>();
  for (const text of texts) {
    for (const term of new Set(contentTokens(text))) {
      freq.set(term, (freq.get(term) ?? 0) + 1);
    }
  }
  return freq;
}

/**
 * Admit a domain candidate only when it appears in at least 2% of documents
 * (and at least 8). Author-frame names are admitted whenever the index contains
 * them at all. Everything else — merkle, utxo, ponzi, scheme — stays specific.
 */
export function deriveDomainGenerics(freq: Map<string, number>, docCount: number): Set<string> {
  const cutoff = Math.max(GENERIC_MIN_DOCS, Math.floor(docCount * GENERIC_SHARE));
  const generic = new Set<string>();
  for (const term of DOMAIN_CANDIDATES) {
    if ((freq.get(term) ?? 0) >= cutoff) generic.add(term);
  }
  for (const name of AUTHOR_FRAME) {
    if ((freq.get(name) ?? 0) > 0) generic.add(name);
  }
  return generic;
}

/**
 * A word the index has never seen ("ponzi") is the subject. A companion the index
 * uses often ("scheme" inside "URI-scheme") does not count in its place.
 * A word the index does contain — even a rarer one, such as "tps", "app", or
 * "wide" — does not erase the other subject words. The title may use those.
 * `pinned` terms, such as "block" inside "block size", are never dropped.
 */
export function dominateTerms(
  terms: readonly string[],
  freq: Map<string, number>,
  pinned: readonly string[] = [],
): string[] {
  const pin = new Set(pinned);
  const floating = terms.filter((term) => !pin.has(term));
  if (floating.length <= 1) return [...terms];
  const absent = floating.some((term) => (freq.get(term) ?? 0) === 0);
  if (!absent) return [...terms];
  const kept = new Set(floating.filter((term) => (freq.get(term) ?? 0) < GENERIC_MIN_DOCS));
  return terms.filter((term) => pin.has(term) || kept.has(term));
}

function loadLexiconTexts(): string[] {
  const texts: string[] = [];
  try {
    const corpusPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'satoshi-corpus.json');
    const corpus = JSON.parse(readFileSync(corpusPath, 'utf8')) as {
      documents?: { title?: string; text?: string }[];
    };
    for (const doc of corpus.documents ?? []) {
      const blob = `${doc.title ?? ''}\n${doc.text ?? ''}`.trim();
      if (blob) texts.push(blob);
    }
  } catch {
    // Corpus missing: the fallback generic set is used below.
  }
  try {
    const require = createRequire(import.meta.url);
    const pkgDir = dirname(require.resolve('bsv-aio-mcp/package.json'));
    const edu = JSON.parse(readFileSync(join(pkgDir, 'data', 'education_index.json'), 'utf8')) as {
      essays?: { title?: string; verdict?: string }[];
    };
    for (const essay of edu.essays ?? []) {
      if (essay.verdict === 'DROP' || !essay.title) continue;
      texts.push(essay.title);
    }
    const brc = JSON.parse(readFileSync(join(pkgDir, 'reference', 'brc_index.json'), 'utf8')) as {
      brcs?: { title?: string }[];
    };
    for (const row of brc.brcs ?? []) {
      if (row.title) texts.push(row.title);
    }
  } catch {
    // Protocol package missing: corpus frequencies still stand.
  }
  return texts;
}

function buildLexicon(texts: readonly string[], forceDerive: boolean): TitleLexicon {
  const freq = countFrequencies(texts);
  if (!forceDerive && texts.length < 30) {
    return { docCount: texts.length, freq, generic: new Set(FALLBACK_GENERIC) };
  }
  return { docCount: texts.length, freq, generic: deriveDomainGenerics(freq, Math.max(texts.length, 1)) };
}

function lexicon(): TitleLexicon {
  if (!lexiconCache) lexiconCache = buildLexicon(loadLexiconTexts(), false);
  return lexiconCache;
}

/** Installed domain generics, derived from the pinned corpus and the protocol index. */
export function domainGenericTerms(): ReadonlySet<string> {
  return lexicon().generic;
}

/**
 * Tests inject a small document set so frequency rules can be checked without the
 * live index. `null` clears the override and the next call reloads the real files.
 */
export function useTestLexicon(texts: readonly string[] | null): void {
  lexiconCache = texts === null ? undefined : buildLexicon(texts, true);
}

/** Subject terms the title must share. Generic Bitcoin words drop out when a sharper word exists. */
export function subjectTerms(question: string): { terms: string[]; specific: boolean } {
  const expansions = phraseExpansionQueries(question);
  const expanded = `${question} ${expansions.join(' ')}`;
  let terms = contentTokens(expanded);
  // "leave" is the user's verb. The document says "withdrew". Keeping "leave" would
  // match the white paper's "nodes can leave and rejoin".
  if (expansions.some((item) => item.toLowerCase() === 'withdrew')) {
    terms = terms.filter((term) => term !== 'leave' && term !== 'left');
  }
  // "co-opt" tokenises as "opt". The card says "hijacked", and "opt" would
  // match an unrelated option.
  if (expansions.some((item) => item.toLowerCase() === 'hijacked')) {
    terms = terms.filter((term) => term !== 'opt' && term !== 'coopt');
  }
  // "double-spending" is the subject. "spend" on its own matches spend-policy specs.
  if (terms.includes('double')) terms = terms.filter((term) => term !== 'spend');
  const generic = lexicon().generic;
  const specific = terms.filter((term) => !generic.has(term));
  // "block" is generic next to a sharper word, except in "block size", where a title
  // that says "block" is the subject and a title that only says "scaling" is not.
  if (/\bblock\s+size\b/i.test(expanded) && terms.includes('block') && !specific.includes('block')) {
    specific.unshift('block');
  }
  if (specific.length > 0) return { terms: specific, specific: true };
  return { terms, specific: false };
}

export interface OverlapDecision {
  /** Terms a title may match on. */
  required: string[];
  /**
   * The question's only subjects are generic domain words ("What is Bitcoin?",
   * "blocks"). Any retrieved title may ground; the search itself is already
   * about that subject.
   */
  open: boolean;
}

/** Which terms are allowed to count as title overlap for this question. */
export function overlapTerms(question: string): OverlapDecision {
  const { terms, specific } = subjectTerms(question);
  if (!specific) {
    return { required: terms, open: terms.length > 0 };
  }
  const topical = terms.filter((term) => !COMMON_VERBS.has(term));
  if (topical.length > 0) return { required: topical, open: false };
  // Only a verb is left ("stop", "disappear"). Also allow the generic subject
  // the question actually names ("satoshi"), so a post titled with that name
  // still qualifies and a title that only uses the verb does not have to.
  const index = lexicon();
  const expanded = `${question} ${phraseExpansionQueries(question).join(' ')}`;
  const genericSubjects = contentTokens(expanded).filter((term) => index.generic.has(term));
  return { required: [...new Set([...terms, ...genericSubjects])], open: false };
}

/** Stems of whitespace-separated words. A word that itself splits into several tokens (URI-scheme, including a dash that is not an ASCII hyphen) does not contribute those pieces. */
function wholeWordStems(text: string): Set<string> {
  const stems = new Set<string>();
  for (const word of text.split(/\s+/)) {
    const pieces = contentTokens(word);
    const only = pieces.length === 1 ? pieces[0] : undefined;
    if (!only) continue;
    stems.add(only);
  }
  return stems;
}

function substantiveHits(terms: readonly string[], text: string): string[] {
  const all = tokenSet(text);
  const whole = wholeWordStems(text);
  const freq = lexicon().freq;
  const found = terms.filter((term) => hayHas(all, term));
  const missingRarer = terms.some((term) => {
    if (hayHas(all, term)) return false;
    const df = freq.get(term) ?? 0;
    return found.some((other) => (freq.get(other) ?? 0) > df && !hayHas(whole, other));
  });
  if (!missingRarer) return found;
  return found.filter((term) => hayHas(whole, term));
}

/**
 * "scheme" inside "URI-scheme" is not the word "scheme". It must not satisfy a
 * question that also asks about a rarer word the title does not contain ("ponzi").
 * A hyphenated subject the question actually uses ("Double-Spend") still counts,
 * because nothing rarer is missing.
 */
function countedTerms(question: string, text: string): string[] {
  return substantiveHits(overlapTerms(question).required, text);
}

function tokenSet(text: string): Set<string> {
  return new Set(contentTokens(text));
}

function hayHas(hay: Set<string>, term: string): boolean {
  const stemmed = stemLight(term);
  if (hay.has(stemmed)) return true;
  if (stemmed.length < 4) return false;
  for (const other of hay) {
    if (other.length < 4) continue;
    const [shorter, longer] = stemmed.length <= other.length ? [stemmed, other] : [other, stemmed];
    if (!longer.startsWith(shorter)) continue;
    const gap = longer.length - shorter.length;
    // scale/scaling (a short inflection). block/blockchain is not an inflection.
    // multisig/multisignature is a real prefix of a longer form of the same word.
    if (gap <= 3) return true;
    if (shorter.length >= 6 && gap <= 8) return true;
  }
  return false;
}

function matchedTerms(question: string, text: string): string[] {
  return countedTerms(question, text);
}

/**
 * True when `text` shares a subject word with the question.
 * A question with no specific word ("What is Bitcoin?") does not reject titles:
 * the whole record is about that topic, and theme packing already spreads it.
 * A sharper word, when the question has one, has to appear; a high-frequency
 * domain word left over from the question does not satisfy that on its own.
 */
export function sharesSubject(question: string, text: string): boolean {
  if (!text.trim()) return false;
  const decision = overlapTerms(question);
  if (decision.open) return true;
  if (decision.required.length === 0) return false;
  return matchedTerms(question, text).length > 0;
}

function asQueries(retrievedBy?: string | readonly string[]): string[] {
  if (!retrievedBy) return [];
  const list = typeof retrievedBy === 'string' ? [retrievedBy] : retrievedBy;
  return list.map((query) => query.trim()).filter(Boolean);
}

/**
 * Terms in `text` that a retrieval query contributes beyond the question.
 * Generic domain words do not count. A companion the question-side gate already
 * dropped ("scheme" beside an unseen "ponzi") does not count either, so a
 * rewrite cannot put an unrelated title back. A word the question never used
 * ("alert" in a rewrite of "that warning") does count: that is the query which
 * retrieved the hit.
 */
function retrievedMatchTerms(question: string, retrievedBy: string | readonly string[] | undefined, text: string): string[] {
  if (!text.trim()) return [];
  const generic = lexicon().generic;
  const decision = overlapTerms(question);
  const allowed = new Set(decision.required);
  const questionTerms = new Set(subjectTerms(question).terms);
  const asked = question.trim().toLowerCase();
  const matched = new Set<string>();
  for (const query of asQueries(retrievedBy)) {
    if (query.toLowerCase() === asked) continue;
    const specific = contentTokens(query).filter((term) => !generic.has(term));
    const here = substantiveHits(specific, text);
    if (here.length === 0) continue;
    const weak = !decision.open && here.every((term) => questionTerms.has(term) && !allowed.has(term));
    if (weak) continue;
    for (const term of here) matched.add(term);
  }
  return [...matched];
}

/**
 * A primary may match on its body for a real subject ("merkle" in a post whose
 * title is "Re: …"). A common verb or a generic domain word in the body is not
 * a subject: "what happened" and a signature "Satoshi" appear in unrelated mail.
 */
function primaryBodyQualifies(question: string, hit: GateHit): boolean {
  const decision = overlapTerms(question);
  const hay = tokenSet(`${hit.title ?? ''} ${hit.text ?? ''} ${hit.excerpt ?? ''}`);
  if (decision.open) {
    const { terms } = subjectTerms(question);
    return terms.length === 0 || terms.some((term) => hayHas(hay, term));
  }
  const generic = lexicon().generic;
  const freq = lexicon().freq;
  let sharp = decision.required.filter((term) => !COMMON_VERBS.has(term) && !generic.has(term));
  if (sharp.includes('size') || sharp.includes('1mb')) sharp = sharp.filter((term) => term !== 'block');
  // A word the index has never seen ("ponzi") has to appear in the writing. A common
  // companion in the body ("scheme" in a URI-scheme thread) does not stand in for it.
  const unseen = sharp.filter((term) => (freq.get(term) ?? 0) === 0);
  if (unseen.length > 0) sharp = unseen;
  if (sharp.length === 0) return false;
  const blob = `${hit.title ?? ''} ${hit.text ?? ''} ${hit.excerpt ?? ''}`;
  return substantiveHits(sharp, blob).length > 0;
}

function namedSpecIds(question: string): string[] {
  const ids = question.match(/\bBRC-?\d+s?|\bBEEF\b/gi) ?? [];
  return [...new Set(ids.map((id) => {
    const brc = /^BRC-?(\d+)s?$/i.exec(id);
    return brc ? `brc-${brc[1]}` : id.toLowerCase();
  }))];
}

export function isSatoshiQuoteQuestion(q: string): boolean {
  return SATOSHI_QUOTE.test(q);
}

export function isNamedSpecLookup(q: string): boolean {
  if (/\bwhy\b/i.test(q)) return false;
  if (!NAMED_SPEC_ID.test(q)) return false;
  if (/\b(compare|versus|vs\.?|difference|between)\b/i.test(q)) return false;
  return /\b(what|explain|describe|define|tell|how|which)\b/i.test(q) || q.trim().split(/\s+/).length <= 4;
}

export function isMechanismRetrieval(q: string): boolean {
  if (/\bwhy\b/i.test(q)) return false;
  if (/\bhow\b/i.test(q)) return true;
  if (/\bwhat(?:\s+does|\s+do)\b/i.test(q)) return true;
  if (/\bwhat(?:\s+is|\s+are|'s)\b/i.test(q) && (TECHNICAL_SUBJECT.test(q) || /\bsimplified\s+payment\s+verification\b/i.test(q))) return true;
  return false;
}

/** Primitive a builder question names, so its spec keeps a citation slot beside BRC-100. */
export function namedPrimitivePattern(question: string): RegExp | undefined {
  if (/\b(multisig|multi-?sig|multi-?signature|treasury|trustees?|shared control|escrow)\b/i.test(question)) {
    return /multisig|checkmultisig|treasury|escrow|locktime|\bcltv\b/i;
  }
  if (/\b(charity|donat(?:e|ion|ions)?|receipts?)\b/i.test(question)) {
    return /op_return|charity|donat|receipt/i;
  }
  if (/\b(micropayment|paid api|402)\b/i.test(question)) return /brc-?121|\b402\b|micropayment/i;
  if (/\b(log[\s-]?in|sign[\s-]?in|authentication)\b/i.test(question)) return /brc-?138|identity/i;
  if (/\b(exchange|dex|trading|marketplace)\b/i.test(question)) return /brc-?79|exchange/i;
  if (/\bwallet\b/i.test(question)) return /wallet|brc-?100/i;
  return undefined;
}

export function classifyRetrieval(q: string): RetrievalShape {
  const text = q.trim();
  if (!text) return 'general';
  if (isImplementationQuestion(text)) return 'builder';
  if (isSatoshiQuoteQuestion(text)) return 'satoshi-quote';
  if (isNamedSpecLookup(text)) return 'named-spec';
  if (isScalingQuestion(text)) return 'scaling';
  if (isMechanismRetrieval(text)) return 'mechanism';
  if (CONCEPTUAL.test(text) || CONTESTED.test(text)) return 'concept';
  return 'general';
}

export function slotBudget(shape: RetrievalShape, depth?: 'beginner' | 'developer' | 'historian'): SlotBudget {
  if (shape === 'satoshi-quote') {
    return {
      essay: 2, spec: 0, primary: 3, specLeads: false, primaryLeads: true, rankSpecs: false, subjectConstrained: false,
    };
  }
  if (depth === 'historian' && shape !== 'builder') {
    return {
      essay: 4, spec: 2, primary: 3, specLeads: false, primaryLeads: true, rankSpecs: false, subjectConstrained: false,
    };
  }
  if (depth === 'developer' && shape !== 'builder') {
    return {
      essay: 2, spec: 4, primary: 1, specLeads: true, primaryLeads: false, rankSpecs: true, subjectConstrained: false,
    };
  }
  switch (shape) {
    case 'mechanism':
      return {
        essay: 1, spec: 3, primary: 1, specLeads: true, primaryLeads: false, rankSpecs: true, subjectConstrained: true,
      };
    case 'named-spec':
      // Essays stay in the evidence (a stubbed fact question still shows rank order).
      // The citation panel prefers the spec tier because specLeads is set.
      return {
        essay: 4, spec: 4, primary: 1, specLeads: true, primaryLeads: false, rankSpecs: true, subjectConstrained: false,
      };
    case 'concept':
      return {
        essay: 3, spec: 1, primary: 1, specLeads: false, primaryLeads: false, rankSpecs: false, subjectConstrained: false,
      };
    case 'scaling':
      return {
        essay: 4, spec: 1, primary: 0, specLeads: false, primaryLeads: false, rankSpecs: false, subjectConstrained: false,
      };
    case 'builder':
      return {
        essay: 3, spec: 2, primary: 1, specLeads: false, primaryLeads: false, rankSpecs: false, subjectConstrained: false,
      };
    default:
      return {
        essay: 4, spec: 2, primary: 1, specLeads: false, primaryLeads: false, rankSpecs: false, subjectConstrained: false,
      };
  }
}

export interface GateHit {
  title?: string;
  locator?: string;
  excerpt?: string;
  text?: string;
  url?: string;
  /** Index kind, when the caller has it. Code kinds lose a verb-only overlap. */
  kind?: string;
}

/**
 * Whether a hit may be cited or kept. Named-spec lookups keep spec and essay hits
 * (the BRC-100 title often omits the id). Primaries still have to contain the id,
 * so "10038" is not a BRC-100 source. Builder BRC-100 is always kept. An internal
 * hit with no public URL may match on its locator or excerpt.
 */
export function hitQualifies(
  question: string,
  hit: GateHit,
  shape: RetrievalShape,
  source: GateSource,
  retrievedBy?: string | readonly string[],
): boolean {
  const blob = `${hit.title ?? ''} ${hit.locator ?? ''} ${hit.url ?? ''}`;
  if (shape === 'builder' && /brc-?100|\b0100\.md\b/i.test(blob)) return true;
  if (shape === 'named-spec') {
    if (source !== 'satoshi-primary') return true;
    const body = `${hit.title ?? ''} ${hit.text ?? ''} ${hit.excerpt ?? ''} ${hit.locator ?? ''}`.toLowerCase();
    return namedSpecIds(question).some((id) => body.includes(id));
  }
  const viaQuestion = Boolean(hit.title && sharesSubject(question, hit.title));
  const viaQuery = hit.title ? retrievedMatchTerms(question, retrievedBy, hit.title) : [];
  if (viaQuestion || viaQuery.length > 0) {
    // A common verb is not a subject. "Stop" the exported method, a mail whose
    // body says "disappear", and an essay titled only with that verb ("Tollkeepers
    // Disappear", "can not stop debt") are not the question. A title that also
    // names the person ("Satoshi NEVER Posted") still matches on that name.
    const matched = viaQuestion && hit.title ? matchedTerms(question, hit.title) : viaQuery;
    if (!overlapTerms(question).open && matched.length > 0 && matched.every((term) => COMMON_VERBS.has(term))) {
      return false;
    }
    return true;
  }
  if (source === 'satoshi-primary') return primaryBodyQualifies(question, hit);
  if (!hit.url) {
    const blob = `${hit.locator ?? ''} ${hit.excerpt ?? ''} ${hit.text ?? ''}`;
    if (!sharesSubject(question, blob)) return false;
    // An internal card is kept when its snippet shares the subject ("hijacked"
    // under a title that says "direction change"). A snippet that only shares a
    // common verb ("disappearing" inside an unrelated finding) does not.
    if (overlapTerms(question).open) return true;
    const matched = matchedTerms(question, blob);
    if (matched.length > 0 && matched.every((term) => COMMON_VERBS.has(term))) return false;
    return true;
  }
  return false;
}

export interface LeadCitation {
  title?: string;
  label?: string;
  url?: string;
}

/**
 * When the two collectors disagree, lead with the citation whose title shares a
 * subject word, then round-robin. When they agree, or both titles qualify, keep
 * search order and append investigate.
 */
export function mergeCollectorCitations<T extends LeadCitation>(
  search: T[],
  investigate: T[],
  question: string,
): { citations: T[]; investigateFirst: boolean } {
  const share = (citation: T | undefined): boolean => {
    if (!citation) return false;
    const { specific } = subjectTerms(question);
    if (!specific) return true;
    return sharesSubject(question, `${citation.title ?? ''} ${citation.label ?? ''}`);
  };
  const keyOf = (citation: T): string => (citation.url || `${citation.title ?? ''}|${citation.label ?? ''}`).toLowerCase();
  const left = search[0];
  const right = investigate[0];
  const disagree = Boolean(left && right && keyOf(left) !== keyOf(right));
  const investigateFirst = Boolean(disagree && share(right) && left && !share(left));
  if (!investigateFirst) {
    const seen = new Set(search.map(keyOf));
    const extra = investigate.filter((citation) => {
      const key = keyOf(citation);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { citations: [...search, ...extra], investigateFirst: false };
  }
  const first = investigate;
  const second = search;
  const seen = new Set<string>();
  const out: T[] = [];
  const push = (citation: T | undefined) => {
    if (!citation) return;
    const key = keyOf(citation);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(citation);
  };
  const n = Math.max(first.length, second.length);
  for (let i = 0; i < n; i++) {
    push(first[i]);
    push(second[i]);
  }
  return { citations: out, investigateFirst: true };
}
