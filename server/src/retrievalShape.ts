/**
 * Question-shape classifier and citation relevance for retrieval.
 *
 * Slot mix follows the question (mechanism, named spec, concept, Satoshi's own
 * words, scaling, builder). It is not one global order. Title overlap keeps a
 * citation only when it shares a content word with the question, so a France or
 * sourdough question cannot be answered from an unrelated Bitcoin post.
 */

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
 * Words that almost every Bitcoin title shares. When the question also has a
 * more specific word, these do not by themselves make a title relevant.
 */
const GENERIC = new Set([
  'bitcoin', 'bitcoins', 'btc', 'bsv', 'satoshi', 'nakamoto', 'blockchain', 'block', 'chain',
  'coin', 'coins', 'transaction', 'transactions', 'network', 'payment', 'payments', 'system',
  'protocol', 'crypto', 'cryptocurrency',
]);

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
  // "double-spending" is the subject. "spend" on its own matches spend-policy specs.
  if (terms.includes('double')) terms = terms.filter((term) => term !== 'spend');
  const specific = terms.filter((term) => !GENERIC.has(term));
  // "block" is generic next to a sharper word, except in "block size", where a title
  // that says "block" is the subject and a title that only says "scaling" is not.
  if (/\bblock\s+size\b/i.test(expanded) && terms.includes('block') && !specific.includes('block')) {
    specific.unshift('block');
  }
  if (specific.length > 0) return { terms: specific, specific: true };
  return { terms, specific: false };
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

/**
 * True when `text` shares a subject word with the question.
 * A question with no specific word ("What is Bitcoin?") does not reject titles:
 * the whole record is about that topic, and theme packing already spreads it.
 */
export function sharesSubject(question: string, text: string): boolean {
  const { terms, specific } = subjectTerms(question);
  if (!text.trim()) return false;
  if (!specific) return true;
  if (terms.length === 0) return false;
  const hay = tokenSet(text);
  return terms.some((term) => hayHas(hay, term));
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
): boolean {
  const blob = `${hit.title ?? ''} ${hit.locator ?? ''} ${hit.url ?? ''}`;
  if (shape === 'builder' && /brc-?100|\b0100\.md\b/i.test(blob)) return true;
  if (shape === 'named-spec') {
    if (source !== 'satoshi-primary') return true;
    const body = `${hit.title ?? ''} ${hit.text ?? ''} ${hit.excerpt ?? ''} ${hit.locator ?? ''}`.toLowerCase();
    return namedSpecIds(question).some((id) => body.includes(id));
  }
  if (hit.title && sharesSubject(question, hit.title)) return true;
  if (source === 'satoshi-primary') {
    const { terms } = subjectTerms(question);
    // "block" is kept so a title that says "block" can match a block-size question.
    // A primary body is full of the word "block"; the sharper term has to appear too.
    const sharp = terms.includes('size') || terms.includes('1mb') ? terms.filter((term) => term !== 'block') : terms;
    const hay = tokenSet(`${hit.title ?? ''} ${hit.text ?? ''} ${hit.excerpt ?? ''}`);
    return sharp.some((term) => hayHas(hay, term));
  }
  if (!hit.url) {
    return sharesSubject(question, `${hit.locator ?? ''} ${hit.excerpt ?? ''} ${hit.text ?? ''}`);
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
