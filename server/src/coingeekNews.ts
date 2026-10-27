/**
 * Pinned CoinGeek news. Loaded from data/coingeek-news.json (written by
 * scripts/fetch-coingeek.mjs) and searched locally. Nothing here touches the network.
 *
 * `SourceClass` lives in orchestrate.ts, which is updated separately. Add:
 *   export type SourceClass = 'satoshi-primary' | 'spec' | 'later-commentary' | 'historical-record' | 'news';
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import MiniSearch from 'minisearch';
import { htmlToText } from './htmlText.js';

/** Citation.sourceClass value. Assignable once orchestrate.ts includes `'news'`. */
export const NEWS_SOURCE_CLASS = 'news' as const;

/** At most this many news citations on one answer. */
export const NEWS_CITATION_CAP = 4;

export const RECENCY_HALF_LIFE_MONTHS = 12;

export type NewsFreshness = 'current' | 'ageing' | 'dated';

export interface NewsItem {
  id: string;
  url: string;
  title: string;
  date: string;
  modified?: string;
  categories?: string[];
  tags?: string[];
  excerpt: string;
}

export interface NewsPin {
  source: string;
  fetchedAt: string;
  counts: { items: number; fetched?: number };
  oldest?: string | null;
  newest?: string | null;
  method?: 'wp-rest' | 'rss-sitemap' | string;
  months?: number;
  complete?: boolean;
  requests?: number;
}

export interface NewsFile {
  pin?: NewsPin;
  items: NewsItem[];
}

export interface NewsHit {
  id: string;
  url: string;
  title: string;
  date: string;
  excerpt: string;
  ageMonths: number;
  freshness: NewsFreshness;
}

export interface NewsCitation {
  label: string;
  title: string;
  url: string;
  excerpt: string;
  date: string;
  sourceClass: typeof NEWS_SOURCE_CLASS;
}

/**
 * Fixed instruction for the prompt builder. News is time-sensitive reporting,
 * not protocol fact, and older items must not be stated in the present tense.
 */
export const NEWS_PROVENANCE_NOTE =
  'This is third-party news reporting from CoinGeek (coingeek.com), an outlet with a BSV-aligned editorial stance. It is time-sensitive. Attribute it (\'CoinGeek reported in March 2024 that…\'); never present it as settled protocol fact or as your own knowledge. Where it conflicts with the specification or the primary record, the specification or primary record wins. For older items, say plainly that circumstances may have changed, and do not state them in the present tense. Never use news for protocol mechanics. Use it only for events, announcements, partnerships, adoption, legal or regulatory developments, and ecosystem context.';

const EXCERPT_MAX = 400;
const MIN_SCORE = 1.2;
const CANDIDATE_POOL = 24;
const UNKNOWN_AGE_MONTHS = 120;

const UK_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

const STOP_WORDS = new Set(
  (
    'a,an,and,are,as,at,be,been,but,by,for,from,had,has,have,he,her,his,how,i,if,in,into,is,it,its,' +
    'me,my,not,of,on,or,so,that,the,their,them,they,this,to,was,we,were,what,when,which,who,why,will,' +
    'with,you,your,do,does,did,can,could,should,would,there,here,than,then,too,very,just,about,again,' +
    'once,such,no,nor,only,own,same,some,any,all,each,other,more,most,much,many,up,down,out,off,am,' +
    'always,meant,mean,means,intended,intend,supposed,really,actually,original,originally,ever,never,' +
    'still,even,say,said,tell,told,know,known,want,wanted,like,may,might,must,shall,thing,things,way,' +
    'make,made,take,get,got,news,latest,recent,recently,update,updates,reported,reporting,article,articles'
  ).split(','),
);

const TOPIC_STOP = new Set([
  ...STOP_WORDS,
  'bitcoin',
  'coingeek',
  'bsv',
  'says',
  'after',
  'over',
  'under',
  'into',
  'week',
  'year',
]);

/** Protocol mechanics. These questions are not answered from news, even if they also say "latest". */
const MECHANICS =
  /\b(?:brc[-\s]?\d+|opcodes?|op_[a-z0-9]+|merkle|spv|simplified\s+payment\s+verification|scripts?|sighash|utxos?|nsequence|nlocktime|proof[- ]of[- ]work|block\s+headers?|block\s+size|block\s+reward|difficulty\s+adjustment|halving|nonce|coinbase\s+transaction|locking\s+script|unlocking\s+script|double[- ]spend|ecdsa|schnorr)\b/i;

const IDENTITY =
  /\bwho(?:\s+is|\s+was|'s|’s)\s+satoshi\b|\bsatoshi(?:'s|’s|s)?\s+identity\b|\bwho\s+created\s+bitcoin\b|\bwho\s+(?:really\s+)?wrote\s+the\s+white\s?paper\b|\bare\s+you\s+satoshi\b/i;

const PRIMARY_RECORD =
  /\bwhat\s+did\s+satoshi\b|\bsatoshi\s+(?:say|said|write|wrote|post|posted|email|emailed)\b/i;

const STRONG_NEWS =
  /\b(?:latest|news|recently|recent|this\s+year|last\s+year|announcements?|announced|partnerships?|partnered|lawsuits?|sued|suing|launches?|launched|launching|who\s+is\s+using|adoption|adopted|adopting|regulations?|regulatory|court|ruling|rulings|what\s+happened)\b/i;

const NAMED =
  /\b(?:teranode|hand\s?cash|relayx|centbee|taal|nchain|mintblue|twetch|rock\s?wallet|money\s?button|kronoverse|hodlocker|unbounded\s+capital|bsv\s+association)\b/i;

const ACTIVITY =
  /\b(?:using|uses|used|launch\w*|announc\w*|partner\w*|adopt\w*|integrat\w*|acquir\w*|hired|hiring|sued|suing|lawsuit|unveiled|mainnet|funding|invested|investment)\b/i;

const RECENT_YEAR = /\b(?:201[5-9]|202\d|2030)\b/;

interface IndexedNews {
  id: string;
  title: string;
  excerpt: string;
  tags: string;
}

export interface ScoredNews {
  item: NewsItem;
  relevance: number;
}

function processTerm(term: string): string | null {
  const token = term.toLowerCase();
  if (STOP_WORDS.has(token)) return null;
  if (token.length === 1 && !/\d/.test(token)) return null;
  return token;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asTermList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const terms = value
    .filter((term): term is string => typeof term === 'string')
    .map((term) => term.trim())
    .filter((term) => term.length > 0 && term.length <= 80)
    .slice(0, 24);
  return terms.length > 0 ? terms : undefined;
}

/** Sentence-boundary clip. Mirrors scripts/fetch-coingeek.mjs so a long pinned excerpt cannot reach the prompt. */
function clipPlain(text: string, max = EXCERPT_MAX): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  let cut = -1;
  const end = Math.min(clean.length, max);
  for (let i = 0; i < end; i += 1) {
    const ch = clean[i];
    if (ch !== '.' && ch !== '!' && ch !== '?') continue;
    const prev = i > 0 ? clean[i - 1] : '';
    if (ch === '.' && prev && /\d/.test(prev)) continue;
    const next = i + 1 < clean.length ? clean[i + 1] : ' ';
    if (i + 1 < clean.length && next && !/\s/.test(next)) continue;
    if (i + 1 > max) continue;
    cut = i + 1;
  }
  if (cut >= 40) return clean.slice(0, cut).trim();
  const space = clean.lastIndexOf(' ', max);
  return (space >= 40 ? clean.slice(0, space) : clean.slice(0, max)).trim();
}

function sanitiseItem(row: unknown): NewsItem | null {
  if (!row || typeof row !== 'object') return null;
  const rec = row as Record<string, unknown>;
  const id = asString(rec.id);
  const url = asString(rec.url);
  const title = clipPlain(htmlToText(asString(rec.title)), 240);
  const date = asString(rec.date);
  const excerpt = clipPlain(htmlToText(asString(rec.excerpt)));
  if (!id || !url || !title || !date || !excerpt) return null;
  if (Number.isNaN(Date.parse(date))) return null;
  const item: NewsItem = { id, url, title, date, excerpt };
  const modified = asString(rec.modified);
  if (modified && !Number.isNaN(Date.parse(modified))) item.modified = modified;
  const categories = asTermList(rec.categories);
  const tags = asTermList(rec.tags);
  if (categories) item.categories = categories;
  if (tags) item.tags = tags;
  return item;
}

function sanitiseItems(raw: unknown): NewsItem[] {
  if (!Array.isArray(raw)) return [];
  const out: NewsItem[] = [];
  const seen = new Set<string>();
  for (const row of raw) {
    const item = sanitiseItem(row);
    if (!item || seen.has(item.id) || seen.has(item.url)) continue;
    seen.add(item.id);
    seen.add(item.url);
    out.push(item);
  }
  return out;
}

/** Whole calendar months between an ISO timestamp and `now`, in UTC. Unparseable dates are treated as old. */
export function ageMonths(iso: string, now: Date): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return UNKNOWN_AGE_MONTHS;
  const published = new Date(ms);
  let months =
    (now.getUTCFullYear() - published.getUTCFullYear()) * 12 +
    (now.getUTCMonth() - published.getUTCMonth());
  if (now.getUTCDate() < published.getUTCDate()) months -= 1;
  return Math.max(0, months);
}

/** current ≤6 months, ageing 6–18 months, dated after that. */
export function freshnessFor(months: number): NewsFreshness {
  if (!Number.isFinite(months) || months > 18) return 'dated';
  if (months <= 6) return 'current';
  return 'ageing';
}

/** Half-life decay. Equal relevance therefore ranks a newer article above an older one. */
export function recencyWeight(months: number, halfLife = RECENCY_HALF_LIFE_MONTHS): number {
  if (!Number.isFinite(months) || months <= 0) return 1;
  const life = halfLife > 0 ? halfLife : RECENCY_HALF_LIFE_MONTHS;
  return 2 ** (-months / life);
}

function topicTokens(title: string): string[] {
  const seen = new Set<string>();
  for (const token of title.toLowerCase().split(/[^a-z0-9]+/)) {
    if (token.length <= 3 || TOPIC_STOP.has(token) || seen.has(token)) continue;
    seen.add(token);
  }
  return [...seen];
}

/** True when two headlines are about the same story, so the newer one should win. */
export function sameNewsTopic(a: string, b: string): boolean {
  const left = topicTokens(a);
  const right = topicTokens(b);
  if (left.length === 0 || right.length === 0) return false;
  const rightSet = new Set(right);
  let shared = 0;
  for (const token of left) {
    if (rightSet.has(token)) shared += 1;
  }
  if (shared < 2) return false;
  const union = new Set([...left, ...right]).size;
  const jaccard = shared / union;
  const contain = shared / Math.min(left.length, right.length);
  if (shared >= 3 && contain >= 0.8) return true;
  return jaccard >= 0.6;
}

function dateMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

function toHit(item: NewsItem, months: number): NewsHit {
  return {
    id: item.id,
    url: item.url,
    title: item.title,
    date: item.date,
    excerpt: item.excerpt,
    ageMonths: months,
    freshness: freshnessFor(months),
  };
}

/**
 * Rank already-scored articles. Relevance is multiplied by the recency weight,
 * then a newer article replaces an older one on the same topic.
 */
export function rankNewsHits(scored: readonly ScoredNews[], now: Date, limit = NEWS_CITATION_CAP): NewsHit[] {
  const cap = Math.min(NEWS_CITATION_CAP, Math.max(0, limit));
  if (cap === 0) return [];
  const ranked = scored
    .filter((row) => row.relevance > 0 && row.item)
    .map((row) => {
      const months = ageMonths(row.item.date, now);
      return { item: row.item, months, rank: row.relevance * recencyWeight(months) };
    })
    .sort((a, b) => b.rank - a.rank || dateMs(b.item.date) - dateMs(a.item.date));

  const kept: { item: NewsItem; months: number; rank: number }[] = [];
  for (const hit of ranked) {
    const twinIndex = kept.findIndex((existing) => sameNewsTopic(existing.item.title, hit.item.title));
    if (twinIndex < 0) {
      kept.push(hit);
      continue;
    }
    const twin = kept[twinIndex];
    if (twin && dateMs(hit.item.date) > dateMs(twin.item.date)) kept[twinIndex] = hit;
  }
  kept.sort((a, b) => b.rank - a.rank || dateMs(b.item.date) - dateMs(a.item.date));
  return kept.slice(0, cap).map((hit) => toHit(hit.item, hit.months));
}

export function formatUkNewsDate(iso: string): string | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const date = new Date(ms);
  const month = UK_MONTHS[date.getUTCMonth()];
  if (!month) return null;
  return `${date.getUTCDate()} ${month} ${date.getUTCFullYear()}`;
}

/** Bracketed dateline. The staleness clause is only added for ageing and dated items. */
export function newsDateline(hit: Pick<NewsHit, 'date' | 'ageMonths' | 'freshness'>): string {
  const when = formatUkNewsDate(hit.date);
  if (!when) return '[News — CoinGeek, date unknown — may be out of date]';
  const ago =
    hit.ageMonths <= 0
      ? 'reported this month'
      : hit.ageMonths === 1
        ? 'reported 1 month ago'
        : `reported ${hit.ageMonths} months ago`;
  const caveat = hit.freshness === 'current' ? '' : ' — may be out of date';
  return `[News — CoinGeek, ${when}, ${ago}${caveat}]`;
}

/** Evidence block. Every item carries an explicit dated label. */
export function renderNewsEvidence(hits: readonly NewsHit[]): string {
  return hits
    .slice(0, NEWS_CITATION_CAP)
    .map((hit) => `${newsDateline(hit)}\n${hit.title}\n${hit.excerpt}\n${hit.url}`)
    .join('\n\n');
}

export function newsCitations(hits: readonly NewsHit[]): NewsCitation[] {
  return hits.slice(0, NEWS_CITATION_CAP).map((hit) => ({
    label: hit.title,
    title: hit.title,
    url: hit.url,
    excerpt: hit.excerpt,
    date: hit.date,
    sourceClass: NEWS_SOURCE_CLASS,
  }));
}

/**
 * Conservative: false unless the question is about events, announcements, adoption
 * or named product activity. Protocol mechanics and identity questions are never news.
 */
export function looksLikeNewsQuestion(question: string): boolean {
  const q = question.trim();
  if (!q) return false;
  if (IDENTITY.test(q) || PRIMARY_RECORD.test(q) || MECHANICS.test(q)) return false;
  if (STRONG_NEWS.test(q)) return true;
  const named = NAMED.test(q);
  const activity = ACTIVITY.test(q);
  if (named && activity) return true;
  if (named && /\b(?:doing|up to|working on)\b/i.test(q)) return true;
  if (RECENT_YEAR.test(q) && activity) return true;
  return false;
}

export class CoinGeekNews {
  private readonly mini: MiniSearch<IndexedNews>;
  private readonly byId = new Map<string, NewsItem>();

  constructor(
    items: readonly NewsItem[],
    private readonly clock: () => Date = () => new Date(),
  ) {
    const docs: IndexedNews[] = [];
    for (const raw of items) {
      const item = sanitiseItem(raw);
      if (!item || this.byId.has(item.id)) continue;
      this.byId.set(item.id, item);
      docs.push({
        id: item.id,
        title: item.title,
        excerpt: item.excerpt,
        tags: [...(item.categories ?? []), ...(item.tags ?? [])].join(' '),
      });
    }
    this.mini = new MiniSearch<IndexedNews>({
      fields: ['title', 'excerpt', 'tags'],
      storeFields: ['id'],
      processTerm,
      searchOptions: {
        boost: { title: 4, tags: 2 },
        prefix: true,
        fuzzy: 0.1,
      },
    });
    this.mini.addAll(docs);
  }

  search(question: string, limit = NEWS_CITATION_CAP): NewsHit[] {
    return rankNewsHits(this.collect(question), this.clock(), limit);
  }

  /** Best score per article across several phrasings, then one recency ranking. */
  searchAll(queries: readonly string[], limit = NEWS_CITATION_CAP): NewsHit[] {
    const best = new Map<string, ScoredNews>();
    for (const query of queries) {
      for (const row of this.collect(query)) {
        const prev = best.get(row.item.id);
        if (!prev || row.relevance > prev.relevance) best.set(row.item.id, row);
      }
    }
    return rankNewsHits([...best.values()], this.clock(), limit);
  }

  private collect(query: string): ScoredNews[] {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const hits = this.mini.search(trimmed);
    const top = hits[0]?.score ?? 0;
    if (top <= 0) return [];
    const floor = Math.max(MIN_SCORE, top * 0.3);
    const scored: ScoredNews[] = [];
    for (const hit of hits) {
      if (hit.score < floor) continue;
      const item = this.byId.get(String(hit.id));
      if (!item) continue;
      scored.push({ item, relevance: hit.score });
      if (scored.length >= CANDIDATE_POOL) break;
    }
    return scored;
  }
}

let memo: { mtimeMs: number; value: CoinGeekNews } | null = null;

function defaultNewsPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'coingeek-news.json');
}

function readNews(explicitPath: string | undefined, clock: () => Date): CoinGeekNews | null {
  let raw: string;
  if (explicitPath) {
    if (!existsSync(explicitPath)) {
      console.warn(`[news] ${explicitPath} not found — run \`npm run fetch-news\`. News fallback disabled.`);
      return null;
    }
    raw = readFileSync(explicitPath, 'utf8');
  } else {
    // Literal join() relative to this module so the file tracer can see the snapshot.
    const newsPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'coingeek-news.json');
    if (!existsSync(newsPath)) {
      console.warn(`[news] ${newsPath} not found — run \`npm run fetch-news\`. News fallback disabled.`);
      return null;
    }
    raw = readFileSync(newsPath, 'utf8');
  }
  try {
    const parsed = JSON.parse(raw) as Partial<NewsFile>;
    const items = sanitiseItems(parsed.items);
    if (items.length === 0) {
      console.warn('[news] news file has no usable articles — news fallback disabled.');
      return null;
    }
    console.log(`[news] loaded ${items.length} articles (pin ${parsed.pin?.fetchedAt ?? 'unknown'})`);
    return new CoinGeekNews(items, clock);
  } catch (err) {
    console.warn('[news] failed to parse news file:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Load the pinned snapshot. Missing or corrupt files return null — chat must
 * keep working without news. The default path is memoised until the file changes.
 */
export function loadCoinGeekNews(explicitPath?: string, clock: () => Date = () => new Date()): CoinGeekNews | null {
  if (!explicitPath && memo) {
    try {
      if (statSync(defaultNewsPath()).mtimeMs === memo.mtimeMs) return memo.value;
    } catch {
      memo = null;
      return null;
    }
  }
  const loaded = readNews(explicitPath, clock);
  if (!explicitPath && loaded) {
    try {
      memo = { mtimeMs: statSync(defaultNewsPath()).mtimeMs, value: loaded };
    } catch {
      memo = null;
    }
  }
  return loaded;
}

const PIN_PROBE_BYTES = 8_192;

/** ISO time from pin.fetchedAt, without reading the article list. */
export function newsFetchedAt(explicitPath?: string): string | undefined {
  const newsPath = explicitPath ?? defaultNewsPath();
  let fd: number | undefined;
  try {
    fd = openSync(newsPath, 'r');
    const buf = Buffer.alloc(PIN_PROBE_BYTES);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const head = buf.subarray(0, n).toString('utf8');
    const itemsAt = head.indexOf('"items"');
    const pinHead = itemsAt >= 0 ? head.slice(0, itemsAt) : head;
    const match = pinHead.match(/"fetchedAt"\s*:\s*"([^"\\]+)"/);
    const raw = match?.[1];
    if (!raw) return undefined;
    const ms = Date.parse(raw);
    if (Number.isNaN(ms)) return undefined;
    return new Date(ms).toISOString();
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
