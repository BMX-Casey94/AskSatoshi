/**
 * Landing-page questions. A session seed shuffles the pool; the last four are
 * remembered so two page loads in a row never show the same set.
 * Nothing here is sent off the device — the chosen question is only submitted
 * when the visitor picks it.
 */

export const SUGGESTION_POOL: readonly string[] = [
  'What problem does the white paper say a peer-to-peer network has to solve before electronic cash can work?',
  'How does the white paper decide which chain of blocks is the valid one?',
  'What does the white paper say a timestamp server is for?',
  'How does the white paper describe checking a payment without storing the whole chain?',
  'When does the white paper say simplified payment verification is no longer enough?',
  'How does a Merkle branch show that a transaction was included in a block?',
  'Why does the white paper say proof-of-work difficulty has to adjust?',
  'What did Satoshi write about nodes leaving the network and rejoining later?',
  'How did Satoshi reply to the double-spending objection on the cryptography mailing list?',
  'What did Satoshi write about the Byzantine Generals\' Problem?',
  'What did the January 2009 release announcement say Bitcoin was?',
  'How is the coin supply described in Satoshi\'s early writing?',
  'What does the genesis block\'s coinbase text record, and what does it not establish?',
  'What can the 2008–2010 writings tell a reader who sets authorship aside?',
  'How does a locking script differ from the unlocking script that spends it?',
  'What does OP_CHECKSIG check before an output may be spent?',
  'What does it mean to call Bitcoin Script a predicate?',
  'Why did the early Bitcoin client stop accepting some opcodes?',
  'How can a transaction carry data without creating a spendable output?',
  'What can a wallet still check when the blocks themselves are too large to keep?',
  'What is Teranode meant to change about validating a large volume of transactions?',
  'Why do overlay services sit beside the consensus rules rather than inside them?',
  'How does BRC-100 represent token state?',
  'How is publishing a BRC different from changing Bitcoin\'s consensus rules?',
  'What do Craig Wright\'s later essays say a Bitcoin ledger is for?',
  'How do Craig Wright\'s later essays describe Script, as distinct from a virtual machine?',
  'How can a server confirm a payment with a Merkle proof?',
  'What belongs in a transaction when you are building an application, and what should stay off the ledger?',
  'How do you tie an invoice to a transaction output so the payment can be checked?',
  'What privacy model does the white paper contrast with a bank that knows its customers?',
];

const SEED_KEY = 'ask-satoshi:suggestions:seed';
const NONCE_KEY = 'ask-satoshi:suggestions:nonce';
const LAST_KEY = 'ask-satoshi:suggestions:last';

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Session storage when the browser allows it; local storage only as a fallback. */
export interface SuggestionStores {
  session: KeyValueStore | null;
  local: KeyValueStore | null;
}

export interface SuggestionDraw {
  questions: string[];
  /** Nonce that produced `questions`. Persist it so the next draw starts after it. */
  nonce: number;
}

export interface SuggestionPlan extends SuggestionDraw {
  seed: number;
}

let pageEntropy: number | null = null;

/** Stable for this page load, including React Strict Mode's extra initializer call. */
export function pageLoadEntropy(): number {
  if (pageEntropy === null) {
    pageEntropy = Math.floor(Math.random() * 0x1_0000_0000);
  }
  return pageEntropy;
}

export function browserSuggestionStores(): SuggestionStores {
  return {
    session: wrapStorage(() => globalThis.sessionStorage),
    local: wrapStorage(() => globalThis.localStorage),
  };
}

function wrapStorage(get: () => Storage): KeyValueStore | null {
  try {
    const store = get();
    if (!store || typeof store.getItem !== 'function' || typeof store.setItem !== 'function') return null;
    return store;
  } catch {
    return null;
  }
}

function uniquePool(pool: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of pool) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const other = new Set(b);
  return a.every((item) => other.has(item));
}

/** mulberry32 — small, deterministic, good enough for a four-item shuffle. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mixSeed(seed: number, nonce: number): number {
  let x = (seed ^ Math.imul(nonce >>> 0, 0x9e3779b1)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

function shuffle(items: readonly string[], seed: number): string[] {
  const copy = [...items];
  const random = mulberry32(seed);
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const current = copy[i];
    const swap = copy[j];
    if (current === undefined || swap === undefined) continue;
    copy[i] = swap;
    copy[j] = current;
  }
  return copy;
}

/**
 * Pick `count` distinct questions. Same seed and nonce always return the same
 * draw. When `previous` is the draw that nonce would have produced, the nonce
 * advances until the set differs, or a leftover question is swapped in.
 */
export function pickSuggestions(
  pool: readonly string[],
  count: number,
  seed: number,
  nonce: number,
  previous: readonly string[] | null,
): SuggestionDraw {
  const unique = uniquePool(pool);
  const size = Math.max(0, Math.min(unique.length, Math.floor(count)));
  let n = Number.isFinite(nonce) ? nonce >>> 0 : 0;
  if (size === 0) return { questions: [], nonce: n };

  const drawAt = (value: number) => shuffle(unique, mixSeed(seed >>> 0, value)).slice(0, size);
  let chosen = drawAt(n);
  for (let attempt = 0; attempt < 48 && previous && sameMembers(chosen, previous); attempt++) {
    n = (n + 1) >>> 0;
    chosen = drawAt(n);
  }
  if (previous && sameMembers(chosen, previous)) {
    const unused = unique.find((item) => !chosen.includes(item));
    if (unused) chosen = [unused, ...chosen.slice(0, size - 1)];
  }
  return { questions: chosen, nonce: n };
}

/** A question from the pool that is not on screen. Null when none remain. */
export function surpriseQuestion(
  pool: readonly string[],
  shown: readonly string[],
  random: () => number,
): string | null {
  const visible = new Set(shown);
  const candidates = uniquePool(pool).filter((item) => !visible.has(item));
  if (candidates.length === 0) return null;
  const unit = random();
  const index = Math.min(candidates.length - 1, Math.max(0, Math.floor(unit * candidates.length)));
  return candidates[index] ?? null;
}

function readKey(stores: SuggestionStores, key: string): string | null {
  if (stores.session) {
    try {
      return stores.session.getItem(key);
    } catch {
      // Session storage is blocked; local storage is the fallback.
    }
  }
  if (stores.local) {
    try {
      return stores.local.getItem(key);
    } catch {
      return null;
    }
  }
  return null;
}

function writeKey(stores: SuggestionStores, key: string, value: string): void {
  if (stores.session) {
    try {
      stores.session.setItem(key, value);
      return;
    } catch {
      // Fall through and try local storage.
    }
  }
  if (stores.local) {
    try {
      stores.local.setItem(key, value);
    } catch {
      // The draw still works for this page; the next load may repeat it.
    }
  }
}

function readSeed(stores: SuggestionStores): number | null {
  const raw = readKey(stores, SEED_KEY);
  if (raw === null || raw === '') return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) return null;
  return value;
}

function readNonce(stores: SuggestionStores): number {
  const raw = readKey(stores, NONCE_KEY);
  if (raw === null || raw === '') return 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 1_000_000_000) return 0;
  return value;
}

function readLast(stores: SuggestionStores): string[] | null {
  const raw = readKey(stores, LAST_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Read the session shuffle and choose the next four. Does not write. */
export function planSuggestionDraw(
  pool: readonly string[],
  count: number,
  stores: SuggestionStores,
  entropy: number,
): SuggestionPlan {
  const seed = readSeed(stores) ?? (entropy >>> 0);
  const draw = pickSuggestions(pool, count, seed, readNonce(stores) + 1, readLast(stores));
  return { seed, nonce: draw.nonce, questions: draw.questions };
}

/** Remember the seed, nonce and last set. Failures are ignored. */
export function commitSuggestionDraw(stores: SuggestionStores, plan: SuggestionPlan): void {
  writeKey(stores, SEED_KEY, String(plan.seed >>> 0));
  writeKey(stores, NONCE_KEY, String(plan.nonce >>> 0));
  try {
    writeKey(stores, LAST_KEY, JSON.stringify(plan.questions));
  } catch {
    // JSON.stringify does not throw on an array of strings; this is a backstop.
  }
}
