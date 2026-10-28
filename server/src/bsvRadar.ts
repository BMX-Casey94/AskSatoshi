/**
 * Pinned BSV Radar app directory. Loaded from data/bsvradar-apps.json (written by
 * scripts/fetch-bsvradar.mjs) and searched locally. Nothing here touches the network.
 *
 * Listing is not endorsement, and a catalogue date is not proof an app is running.
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import MiniSearch from 'minisearch';

/** Citation.sourceClass value. orchestrate.ts includes `'directory'`. */
export const DIRECTORY_SOURCE_CLASS = 'directory' as const;

/** At most this many directory citations on one answer. */
export const DIRECTORY_CITATION_CAP = 8;

/**
 * Exact sentence on every catalogue answer.
 * Keep in sync with scripts/fetch-bsvradar.mjs.
 */
export const CATALOGUE_CAVEAT =
  'BSV Radar is a partial, community catalogue; listing is not endorsement; status may be out of date.';

/**
 * Standing instruction for the prompt. The catalogue is a partial community list.
 * It must not be spoken as a complete set, an endorsement, or an uptime check.
 */
export const DIRECTORY_PROVENANCE_NOTE =
  'Say that this is a partial list. Never claim the catalogue is complete. Never endorse an app. Never state that an app is currently operational. Present between three and six listings, each by name with one plain line on what it is for and its link; naming a listing is reporting the catalogue, not endorsing it. The date on a row is the catalogue\'s own date for that listing, not a release date and not evidence the service is running. Do not treat the catalogue\'s platform label as a device or store list. Prefer the bsvradar.com link when you cite a listing.';

export const DIRECTORY_EVIDENCE_HEADER =
  'APP DIRECTORY (BSV Radar — partial community catalogue, listing is not endorsement, status may be out of date):';

const STALE_SNAPSHOT_DAYS = 14;

const UK_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

const STOP_WORDS = new Set(
  (
    'a,an,and,are,as,at,be,been,but,by,for,from,had,has,have,he,her,his,how,i,if,in,into,is,it,its,' +
    'me,my,not,of,on,or,so,that,the,their,them,they,this,to,was,we,were,what,when,which,who,why,will,' +
    'with,you,your,do,does,did,can,could,should,would,there,here,than,then,too,very,just,about,' +
    'any,all,each,some,please,show,list,listed,exist,exists,available,catalogue,catalog,directory,' +
    'app,apps,dapp,dapps,bsv,bitcoin,sv,radar,using,use,called,named'
  ).split(','),
);

/** Words that name a catalogue category. Dropped from the topical query so "what wallets exist" browses that category. */
const CATEGORY_WORDS = new Set([
  'wallet', 'wallets', 'game', 'games', 'gaming', 'marketplace', 'marketplaces',
  'explorer', 'explorers', 'exchange', 'exchanges', 'collectible', 'collectibles',
  'nft', 'nfts', 'education', 'enterprise', 'finance', 'media', 'productivity',
  'social', 'block', 'blocks',
]);

/** Kind words are not a search topic. "What SDKs exist?" browses building blocks instead of searching for the word "sdks". */
const KIND_WORDS = new Set([
  'sdk', 'sdks', 'library', 'libraries', 'building',
  'organisation', 'organisations', 'organization', 'organizations',
]);

const BUILDER_QUESTION =
  /\bhow\s+(?:do|can|could|should|would|to)\s+i?\s*(?:build|create|make|write|develop|implement|code)\b|\bhow\s+to\s+(?:build|create|make|write|develop|implement|code)\b|\b(?:build|create|write|develop|implement|code)\s+(?:me\s+)?(?:an?\s+|my\s+|the\s+)?(?:new\s+)?(?:bsv\s+|bitcoin(?:\s+sv)?\s+)?(?:apps?|dapps?|wallets?|games?|marketplaces?|sdks?|librar(?:y|ies))\b/i;

const SATOSHI_RECORD =
  /\bwhat\s+did\s+satoshi\b|\bsatoshi\s+(?:say|said|write|wrote|post|posted)\b|\bwho(?:\s+is|\s+was|'s|’s)\s+satoshi\b/i;

const RADAR_NAME = /\bbsv\s*radar\b|\bbsvradar(?:\.com)?\b/i;

const LISTING_NOUN =
  '(?:apps?|dapps?|wallets?|games?|gaming|marketplaces?|exchanges?|explorers?|collectibles?|nfts?)';

const CHAIN = '(?:bsv|bitcoin\\s+sv|bitcoin)';

const DIRECTORY_PATTERNS: readonly RegExp[] = [
  new RegExp(`\\b(?:is|are)\\s+there\\s+(?:an?|any)\\b[\\s\\S]{0,80}\\b${LISTING_NOUN}\\b(?!\\s+of\\b)`, 'i'),
  new RegExp(`\\b${LISTING_NOUN}\\b[\\s\\S]{0,80}\\b(?:exist|exists)\\b`, 'i'),
  new RegExp(
    `\\b(?:what|which)\\s+(?:${CHAIN}\\s+)?${LISTING_NOUN}\\s+(?:exist|exists|are\\s+there|are\\s+available|are\\s+on|are\\s+listed)\\b`,
    'i',
  ),
  new RegExp(`\\blist\\s+(?:me\\s+|the\\s+|all\\s+|some\\s+)*(?:${CHAIN}\\s+)?${LISTING_NOUN}\\b`, 'i'),
  new RegExp(`\\bshow\\s+me\\s+(?:the\\s+|all\\s+|some\\s+)*(?:${CHAIN}\\s+)?${LISTING_NOUN}\\b`, 'i'),
  new RegExp(`\\b${LISTING_NOUN}\\s+(?:on|for)\\s+${CHAIN}\\b`, 'i'),
  new RegExp(`\\bany\\s+(?:${CHAIN}\\s+)?${LISTING_NOUN}\\b`, 'i'),
  new RegExp(`\\b(?:an?|any)\\s+${LISTING_NOUN}\\s+for\\b`, 'i'),
];

const LISTING_CUE =
  /\b(?:exist|exists|available|listed|catalogue|catalog|directory|list|show|any|are\s+there|is\s+there)\b/i;

/** Recommendation phrasing: "name some good BSV apps", "which apps should I try on BSV". */
const RECO_CUE =
  /\b(?:name|recommend|suggest|examples?\s+of|good|best|top|popular|favou?rite|notable|worth\s+(?:trying|using|a\s+look)|should\s+i\s+(?:try|use)|can\s+you\s+(?:name|recommend|suggest))\b/i;
const CHAIN_ANY = new RegExp(`\\b${CHAIN}\\b`, 'i');

const CHAIN_NOUN = new RegExp(`\\b${CHAIN}\\s+${LISTING_NOUN}\\b`, 'i');

const BLOCK_NOUN = /\b(?:sdks?|libraries|library|building\s+blocks?)\b/i;
const ORG_NOUN = /\b(?:organisations?|organizations?)\b/i;
const APP_NOUN = new RegExp(`\\b${LISTING_NOUN}\\b`, 'i');
const ASK_CUE = /\b(?:what|which|list|show|any|exist|exists|available|is\s+there|are\s+there)\b/i;

const CATEGORY_PATTERNS: readonly { pattern: RegExp; category: string }[] = [
  { pattern: /\bwallets?\b/i, category: 'Wallets' },
  { pattern: /\bgames?\b|\bgaming\b/i, category: 'Gaming' },
  { pattern: /\bmarketplaces?\b/i, category: 'Marketplaces' },
  { pattern: /\b(?:block\s+)?explorers?\b/i, category: 'Block explorers' },
  { pattern: /\bexchanges?\b/i, category: 'Exchanges' },
  { pattern: /\bcollectibles?\b|\bnfts?\b/i, category: 'Collectibles' },
  { pattern: /\beducation\b/i, category: 'Education' },
  { pattern: /\benterprise\b/i, category: 'Enterprise' },
  { pattern: /\bfinance\b/i, category: 'Finance' },
  { pattern: /\bmedia\b/i, category: 'Media' },
  { pattern: /\bproductivity\b/i, category: 'Productivity' },
  { pattern: /\bsocial\b/i, category: 'Social' },
];

const MIN_SCORE = 1;
const SLUG = /^[a-z0-9][a-z0-9-]{0,180}$/;

export type DirectoryKind = 'app' | 'block' | 'organisation';

export interface DirectoryApp {
  id: string;
  name: string;
  category: string;
  summary: string;
  url?: string;
  radarUrl: string;
  platform?: string;
  tags: string[];
  lastUpdated?: string;
  firstSeen?: string;
}

export interface DirectoryBlock {
  id: string;
  name: string;
  category: string;
  summary: string;
  url?: string;
  radarUrl: string;
  tags: string[];
  docs?: string;
  maturity?: string;
  license?: string;
  maintainer?: string;
  version?: string;
  lastUpdated?: string;
  firstSeen?: string;
}

export interface DirectoryOrg {
  id: string;
  name: string;
  radarUrl: string;
  apps?: number;
  blocks?: number;
  firstSeen?: string;
}

export interface DirectoryPin {
  source?: string;
  sourceClass?: string;
  fetchedAt?: string;
  sourceFileDate?: string | null;
  method?: string;
  counts?: { apps?: number; categories?: number; blocks?: number; organisations?: number };
  caveat?: string;
}

export interface DirectoryFile {
  pin?: DirectoryPin;
  items?: unknown;
  blocks?: unknown;
  organisations?: unknown;
}

export interface DirectoryHit {
  kind: DirectoryKind;
  id: string;
  name: string;
  category: string;
  summary: string;
  url?: string;
  radarUrl: string;
  lastUpdated?: string;
}

export interface DirectoryCitation {
  label: string;
  title: string;
  url: string;
  excerpt: string;
  date?: string;
  sourceClass: typeof DIRECTORY_SOURCE_CLASS;
}

export interface DirectoryMeta {
  fetchedAt?: string;
  sourceFileDate?: string;
}

export interface DirectorySource {
  searchAll(queries: readonly string[], limit?: number): DirectoryHit[];
  meta: DirectoryMeta;
  now(): Date;
}

interface IndexedEntry {
  id: string;
  name: string;
  category: string;
  summary: string;
  tags: string;
}

interface Ranked {
  hit: DirectoryHit;
  score: number;
}

type SearchPlan =
  | { mode: 'category'; category: string; kinds: DirectoryKind[] }
  | { mode: 'spread'; kinds: DirectoryKind[]; category: string | null }
  | { mode: 'search'; kinds: DirectoryKind[]; category: string | null };

function processTerm(term: string): string | null {
  const token = term.toLowerCase();
  if (STOP_WORDS.has(token) || CATEGORY_WORDS.has(token)) return null;
  if (token.length === 1 && !/\d/.test(token)) return null;
  return token;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const tag = raw.trim();
    if (!tag || tag.length > 80) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= 24) break;
  }
  return out;
}

function asCount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100_000) return undefined;
  return value;
}

function validDay(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  if (Number.isNaN(ms)) return '';
  return new Date(ms).toISOString().slice(0, 10) === value ? value : '';
}

function radarSlug(url: string, section: 'apps' | 'blocks' | 'orgs'): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return '';
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (host !== 'bsvradar.com') return '';
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts[0] !== section) return '';
    const slug = decodeURIComponent(parts[1] ?? '').toLowerCase();
    return SLUG.test(slug) ? slug : '';
  } catch {
    return '';
  }
}

function externalUrl(value: string): string {
  if (!value) return '';
  if (/^https:\/\//i.test(value) || /^http:\/\//i.test(value)) return value;
  return '';
}

function sanitiseApp(row: unknown): DirectoryApp | null {
  if (!row || typeof row !== 'object') return null;
  const rec = row as Record<string, unknown>;
  const radarUrl = asString(rec.radarUrl);
  const id = asString(rec.id);
  const slug = radarSlug(radarUrl, 'apps');
  const name = asString(rec.name);
  if (!id || id !== slug || !name || !SLUG.test(id)) return null;
  const item: DirectoryApp = {
    id,
    name,
    category: asString(rec.category),
    summary: asString(rec.summary),
    radarUrl: `https://bsvradar.com/apps/${id}`,
    tags: asTags(rec.tags),
  };
  const url = externalUrl(asString(rec.url));
  if (url) item.url = url;
  const platform = asString(rec.platform);
  if (platform) item.platform = platform;
  const lastUpdated = validDay(asString(rec.lastUpdated));
  if (lastUpdated) item.lastUpdated = lastUpdated;
  const firstSeen = validDay(asString(rec.firstSeen));
  if (firstSeen) item.firstSeen = firstSeen;
  return item;
}

function sanitiseBlock(row: unknown): DirectoryBlock | null {
  if (!row || typeof row !== 'object') return null;
  const rec = row as Record<string, unknown>;
  const radarUrl = asString(rec.radarUrl);
  const id = asString(rec.id);
  const slug = radarSlug(radarUrl, 'blocks');
  const name = asString(rec.name);
  if (!id || id !== slug || !name || !SLUG.test(id)) return null;
  const block: DirectoryBlock = {
    id,
    name,
    category: asString(rec.category),
    summary: asString(rec.summary),
    radarUrl: `https://bsvradar.com/blocks/${id}`,
    tags: asTags(rec.tags),
  };
  const url = externalUrl(asString(rec.url));
  if (url) block.url = url;
  const docs = externalUrl(asString(rec.docs));
  if (docs) block.docs = docs;
  for (const key of ['maturity', 'license', 'maintainer', 'version'] as const) {
    const value = asString(rec[key]);
    if (value) block[key] = value;
  }
  const lastUpdated = validDay(asString(rec.lastUpdated));
  if (lastUpdated) block.lastUpdated = lastUpdated;
  const firstSeen = validDay(asString(rec.firstSeen));
  if (firstSeen) block.firstSeen = firstSeen;
  return block;
}

function sanitiseOrg(row: unknown): DirectoryOrg | null {
  if (!row || typeof row !== 'object') return null;
  const rec = row as Record<string, unknown>;
  const radarUrl = asString(rec.radarUrl);
  const id = asString(rec.id);
  const slug = radarSlug(radarUrl, 'orgs');
  const name = asString(rec.name);
  if (!id || id !== slug || !name || !SLUG.test(id)) return null;
  const org: DirectoryOrg = { id, name, radarUrl: `https://bsvradar.com/orgs/${id}` };
  const apps = asCount(rec.apps);
  const blocks = asCount(rec.blocks);
  if (apps !== undefined) org.apps = apps;
  if (blocks !== undefined) org.blocks = blocks;
  const firstSeen = validDay(asString(rec.firstSeen));
  if (firstSeen) org.firstSeen = firstSeen;
  return org;
}

function dedupe<T extends { id: string }>(rows: readonly T[]): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

function orgSummary(org: DirectoryOrg): string {
  const parts: string[] = [];
  if (org.apps !== undefined) parts.push(`${org.apps} ${org.apps === 1 ? 'app' : 'apps'}`);
  if (org.blocks !== undefined) parts.push(`${org.blocks} ${org.blocks === 1 ? 'building block' : 'building blocks'}`);
  if (parts.length === 0) return 'Organisation listed in the BSV Radar catalogue.';
  return parts.join(', ');
}

function appHit(item: DirectoryApp): DirectoryHit {
  const hit: DirectoryHit = {
    kind: 'app',
    id: item.id,
    name: item.name,
    category: item.category,
    summary: item.summary,
    radarUrl: item.radarUrl,
  };
  if (item.url) hit.url = item.url;
  if (item.lastUpdated) hit.lastUpdated = item.lastUpdated;
  return hit;
}

function blockHit(item: DirectoryBlock): DirectoryHit {
  const hit: DirectoryHit = {
    kind: 'block',
    id: item.id,
    name: item.name,
    category: item.category,
    summary: item.summary,
    radarUrl: item.radarUrl,
  };
  if (item.url) hit.url = item.url;
  if (item.lastUpdated) hit.lastUpdated = item.lastUpdated;
  return hit;
}

function orgHit(item: DirectoryOrg): DirectoryHit {
  return {
    kind: 'organisation',
    id: item.id,
    name: item.name,
    category: 'Organisation',
    summary: orgSummary(item),
    radarUrl: item.radarUrl,
  };
}

function kindsFor(question: string): DirectoryKind[] {
  const blocks = BLOCK_NOUN.test(question);
  const orgs = ORG_NOUN.test(question);
  const apps = APP_NOUN.test(question);
  const kinds: DirectoryKind[] = [];
  if (apps || (!blocks && !orgs)) kinds.push('app');
  if (blocks) kinds.push('block');
  if (orgs) kinds.push('organisation');
  return kinds;
}

function soleCategory(question: string): string | null {
  const found = new Set<string>();
  for (const row of CATEGORY_PATTERNS) {
    if (row.pattern.test(question)) found.add(row.category);
  }
  if (found.size !== 1) return null;
  return [...found][0] ?? null;
}

function topicTokens(question: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of question.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw || raw.length <= 1) continue;
    if (STOP_WORDS.has(raw) || CATEGORY_WORDS.has(raw) || KIND_WORDS.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name, 'en');
}

/** "Wallets" matches a block category such as "Wallets & Identity > …". */
function blockMatchesCategory(blockCategory: string, appCategory: string): boolean {
  const hay = blockCategory.toLowerCase();
  const full = appCategory.toLowerCase();
  const stem = full.replace(/s$/, '');
  return hay.includes(full) || (stem.length >= 4 && hay.includes(stem));
}

function formatUkDay(iso: string): string | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const date = new Date(ms);
  const month = UK_MONTHS[date.getUTCMonth()];
  if (!month) return null;
  return `${date.getUTCDate()} ${month} ${date.getUTCFullYear()}`;
}

function catalogueDay(day: string): string {
  const uk = formatUkDay(`${day}T00:00:00.000Z`);
  return uk ?? day;
}

/**
 * Conservative: true for "what apps exist", "is there an app for…", "list BSV apps",
 * and mentions of BSV Radar. How-to-build questions stay with the implementation record.
 */
export function looksLikeAppDirectoryQuestion(question: string): boolean {
  const q = question.trim();
  if (!q) return false;
  if (BUILDER_QUESTION.test(q)) return false;
  if (RADAR_NAME.test(q)) return true;
  if (SATOSHI_RECORD.test(q)) return false;
  if (DIRECTORY_PATTERNS.some((pattern) => pattern.test(q))) return true;
  if (CHAIN_NOUN.test(q) && LISTING_CUE.test(q)) return true;
  if (RECO_CUE.test(q) && APP_NOUN.test(q) && CHAIN_ANY.test(q)) return true;
  if (BLOCK_NOUN.test(q) && ASK_CUE.test(q)) return true;
  if (ORG_NOUN.test(q) && ASK_CUE.test(q)) return true;
  return false;
}

function hitLine(hit: DirectoryHit): string {
  const bits = [`${hit.name} (${hit.category || 'Uncategorised'})`];
  if (hit.summary) bits.push(hit.summary);
  if (hit.url) bits.push(hit.url);
  bits.push(`catalogue page ${hit.radarUrl}`);
  if (hit.lastUpdated) bits.push(`catalogue date ${catalogueDay(hit.lastUpdated)}`);
  return bits.join(' — ');
}

/** Evidence rows. The caveat and the model instruction are added by the grounding helper. */
export function renderDirectoryEvidence(hits: readonly DirectoryHit[], meta: DirectoryMeta, now: Date): string {
  const lines: string[] = [];
  const taken = formatUkDay(meta.fetchedAt ?? '');
  const fileDate = meta.sourceFileDate ? catalogueDay(meta.sourceFileDate) : '';
  if (taken && fileDate) lines.push(`Snapshot taken ${taken}. Catalogue file date ${fileDate}.`);
  else if (taken) lines.push(`Snapshot taken ${taken}.`);
  else if (fileDate) lines.push(`Catalogue file date ${fileDate}.`);
  const fetchedMs = Date.parse(meta.fetchedAt ?? '');
  if (!Number.isNaN(fetchedMs) && now.getTime() - fetchedMs > STALE_SNAPSHOT_DAYS * 86_400_000) {
    lines.push('This snapshot is more than 14 days old and may be behind the live directory.');
  }
  for (const hit of hits.slice(0, DIRECTORY_CITATION_CAP)) lines.push(hitLine(hit));
  return lines.join('\n');
}

export function directoryCitations(hits: readonly DirectoryHit[]): DirectoryCitation[] {
  return hits.slice(0, DIRECTORY_CITATION_CAP).map((hit) => {
    const citation: DirectoryCitation = {
      label: hit.name,
      title: hit.name,
      url: hit.radarUrl,
      excerpt: hit.summary || 'No description in the BSV Radar catalogue.',
      sourceClass: DIRECTORY_SOURCE_CLASS,
    };
    if (hit.lastUpdated) citation.date = hit.lastUpdated;
    return citation;
  });
}

export class BsvRadarDirectory implements DirectorySource {
  readonly meta: DirectoryMeta;
  private readonly apps: DirectoryApp[];
  private readonly blocks: DirectoryBlock[];
  private readonly orgs: DirectoryOrg[];
  private readonly hits = new Map<string, DirectoryHit>();
  private readonly mini: MiniSearch<IndexedEntry>;

  constructor(
    file: DirectoryFile,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.apps = dedupe((Array.isArray(file.items) ? file.items : []).map(sanitiseApp).filter((row): row is DirectoryApp => row !== null));
    this.blocks = dedupe((Array.isArray(file.blocks) ? file.blocks : []).map(sanitiseBlock).filter((row): row is DirectoryBlock => row !== null));
    this.orgs = dedupe((Array.isArray(file.organisations) ? file.organisations : []).map(sanitiseOrg).filter((row): row is DirectoryOrg => row !== null));
    const fetchedAt = asString(file.pin?.fetchedAt);
    const sourceFileDate = validDay(asString(file.pin?.sourceFileDate));
    this.meta = {};
    if (fetchedAt && !Number.isNaN(Date.parse(fetchedAt))) this.meta.fetchedAt = new Date(fetchedAt).toISOString();
    if (sourceFileDate) this.meta.sourceFileDate = sourceFileDate;

    const docs: IndexedEntry[] = [];
    for (const app of this.apps) {
      const hit = appHit(app);
      this.hits.set(`app:${app.id}`, hit);
      docs.push({ id: `app:${app.id}`, name: app.name, category: app.category, summary: app.summary, tags: app.tags.join(' ') });
    }
    for (const block of this.blocks) {
      const hit = blockHit(block);
      this.hits.set(`block:${block.id}`, hit);
      docs.push({
        id: `block:${block.id}`,
        name: block.name,
        category: block.category,
        summary: block.summary,
        tags: block.tags.join(' '),
      });
    }
    for (const org of this.orgs) {
      const hit = orgHit(org);
      this.hits.set(`organisation:${org.id}`, hit);
      docs.push({
        id: `organisation:${org.id}`,
        name: org.name,
        category: 'Organisation',
        summary: hit.summary,
        tags: '',
      });
    }
    this.mini = new MiniSearch<IndexedEntry>({
      fields: ['name', 'category', 'summary', 'tags'],
      storeFields: ['id'],
      processTerm,
      searchOptions: {
        boost: { name: 5, category: 3, tags: 2, summary: 1 },
        prefix: true,
        fuzzy: 0.1,
      },
    });
    this.mini.addAll(docs);
  }

  now(): Date {
    return this.clock();
  }

  search(question: string, limit = DIRECTORY_CITATION_CAP): DirectoryHit[] {
    return this.searchAll([question], limit);
  }

  /** Category and kind come from the first query. Later phrasings only add search matches. */
  searchAll(queries: readonly string[], limit = DIRECTORY_CITATION_CAP): DirectoryHit[] {
    const cap = Math.min(DIRECTORY_CITATION_CAP, Math.max(0, limit));
    if (cap === 0) return [];
    const cleaned = [...new Set(queries.map((query) => query.trim()).filter(Boolean))].slice(0, 3);
    const primary = cleaned[0] ?? '';
    if (!primary) return [];
    const plan = this.plan(primary);
    if (plan.mode === 'category') return this.categorySample(plan.category, cap);
    if (plan.mode === 'spread') return this.spread(plan.kinds, plan.category, cap);
    const best = new Map<string, Ranked>();
    for (const query of cleaned) {
      for (const row of this.rankTopics(topicTokens(query), plan.kinds, plan.category)) {
        const key = `${row.hit.kind}:${row.hit.id}`;
        const prev = best.get(key);
        if (!prev || row.score > prev.score) best.set(key, row);
      }
    }
    return [...best.values()]
      .sort((a, b) => b.score - a.score || byName(a.hit, b.hit))
      .slice(0, cap)
      .map((row) => row.hit);
  }

  private plan(question: string): SearchPlan {
    const kinds = kindsFor(question);
    const category = soleCategory(question);
    const topics = topicTokens(question);
    if (topics.length === 0 && category && kinds.includes('app') && kinds.length === 1) {
      return { mode: 'category', category, kinds };
    }
    if (topics.length === 0) return { mode: 'spread', kinds, category };
    return { mode: 'search', kinds, category };
  }

  private categorySample(category: string, cap: number): DirectoryHit[] {
    // Feed order within the category. The catalogue lists a category in its own order;
    // we do not re-rank by rating.
    return this.apps
      .filter((item) => item.category === category)
      .slice(0, cap)
      .map(appHit);
  }

  private spread(kinds: readonly DirectoryKind[], category: string | null, cap: number): DirectoryHit[] {
    const picked: DirectoryHit[] = [];
    const seen = new Set<string>();
    const push = (hits: readonly DirectoryHit[]) => {
      for (const hit of hits) {
        if (picked.length >= cap) return;
        const key = `${hit.kind}:${hit.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        picked.push(hit);
      }
    };
    // SDK and organisation questions lead with those listings. A plain app list does not.
    const leadWithApps = kinds.length === 1 && kinds[0] === 'app';
    const blocks = kinds.includes('block') ? this.blockSample(category, cap) : [];
    const orgs = kinds.includes('organisation') ? this.orgs.slice(0, cap).map(orgHit) : [];
    const apps = kinds.includes('app')
      ? category
        ? this.categorySample(category, cap)
        : this.spreadApps(cap)
      : [];
    if (leadWithApps) push(apps);
    else {
      push(blocks);
      push(orgs);
      push(apps);
    }
    return picked;
  }

  /** One block from each group (the text before ">"), catalogue order inside the group. */
  private blockSample(category: string | null, cap: number): DirectoryHit[] {
    const rows = this.blocks.filter((item) => !category || blockMatchesCategory(item.category, category));
    if (category) return rows.slice(0, cap).map(blockHit);
    const byGroup = new Map<string, DirectoryBlock[]>();
    for (const block of rows) {
      const group = (block.category.split('>')[0] ?? block.category).trim() || 'Other';
      const list = byGroup.get(group) ?? [];
      list.push(block);
      byGroup.set(group, list);
    }
    const groups = [...byGroup.keys()].sort((a, b) => {
      const diff = (byGroup.get(b)?.length ?? 0) - (byGroup.get(a)?.length ?? 0);
      if (diff !== 0) return diff;
      return a.localeCompare(b, 'en');
    });
    const picked: DirectoryHit[] = [];
    let round = 0;
    while (picked.length < cap) {
      let added = false;
      for (const group of groups) {
        const item = byGroup.get(group)?.[round];
        if (!item) continue;
        picked.push(blockHit(item));
        added = true;
        if (picked.length >= cap) break;
      }
      if (!added) break;
      round += 1;
    }
    return picked;
  }

  /** One app from each category, largest categories first, then a second pass. Catalogue order within a category. */
  private spreadApps(cap: number): DirectoryHit[] {
    const byCat = new Map<string, DirectoryApp[]>();
    for (const app of this.apps) {
      const list = byCat.get(app.category) ?? [];
      list.push(app);
      byCat.set(app.category, list);
    }
    const categories = [...byCat.keys()].sort((a, b) => {
      const diff = (byCat.get(b)?.length ?? 0) - (byCat.get(a)?.length ?? 0);
      if (diff !== 0) return diff;
      return a.localeCompare(b, 'en');
    });
    const picked: DirectoryHit[] = [];
    let round = 0;
    while (picked.length < cap) {
      let added = false;
      for (const category of categories) {
        const item = byCat.get(category)?.[round];
        if (!item) continue;
        picked.push(appHit(item));
        added = true;
        if (picked.length >= cap) break;
      }
      if (!added) break;
      round += 1;
    }
    return picked;
  }

  private rankTopics(topics: readonly string[], kinds: readonly DirectoryKind[], category: string | null): Ranked[] {
    const ranked = this.collect(topics, kinds, category);
    if (ranked.length > 0 || !category) return ranked;
    return this.collect(topics, kinds, null);
  }

  private collect(tokens: readonly string[], kinds: readonly DirectoryKind[], category: string | null): Ranked[] {
    if (tokens.length === 0) return [];
    const found = this.mini.search(tokens.join(' '));
    const top = found[0]?.score ?? 0;
    if (top <= 0) return [];
    const floor = Math.max(MIN_SCORE, top * 0.35);
    const allowed = new Set(kinds);
    const ranked: Ranked[] = [];
    for (const row of found) {
      if (row.score < floor) continue;
      const hit = this.hits.get(String(row.id));
      if (!hit || !allowed.has(hit.kind)) continue;
      if (category && hit.kind === 'app' && hit.category !== category) continue;
      ranked.push({ hit, score: row.score });
      if (ranked.length >= 24) break;
    }
    return ranked;
  }
}

let memo: { mtimeMs: number; value: BsvRadarDirectory } | null = null;

function defaultDirectoryPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'bsvradar-apps.json');
}

function usable(file: DirectoryFile): boolean {
  const apps = Array.isArray(file.items) ? file.items.some((row) => sanitiseApp(row)) : false;
  const blocks = Array.isArray(file.blocks) ? file.blocks.some((row) => sanitiseBlock(row)) : false;
  const orgs = Array.isArray(file.organisations) ? file.organisations.some((row) => sanitiseOrg(row)) : false;
  return apps || blocks || orgs;
}

function readDirectory(explicitPath: string | undefined, clock: () => Date): BsvRadarDirectory | null {
  let raw: string;
  if (explicitPath) {
    if (!existsSync(explicitPath)) {
      console.warn(`[directory] ${explicitPath} not found — run \`npm run fetch-bsvradar\`. Directory fallback disabled.`);
      return null;
    }
    raw = readFileSync(explicitPath, 'utf8');
  } else {
    const directoryPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'bsvradar-apps.json');
    if (!existsSync(directoryPath)) {
      console.warn(`[directory] ${directoryPath} not found — run \`npm run fetch-bsvradar\`. Directory fallback disabled.`);
      return null;
    }
    raw = readFileSync(directoryPath, 'utf8');
  }
  try {
    const parsed = JSON.parse(raw) as DirectoryFile;
    if (!usable(parsed)) {
      console.warn('[directory] directory file has no usable listings — directory fallback disabled.');
      return null;
    }
    const loaded = new BsvRadarDirectory(parsed, clock);
    const apps = Array.isArray(parsed.items) ? parsed.items.length : 0;
    console.log(`[directory] loaded ${apps} apps (pin ${parsed.pin?.fetchedAt ?? 'unknown'})`);
    return loaded;
  } catch (err) {
    console.warn('[directory] failed to parse directory file:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Load the pinned snapshot. Missing or corrupt files return null — chat must
 * keep working without the catalogue. The default path is memoised until the file changes.
 */
export function loadBsvRadar(explicitPath?: string, clock: () => Date = () => new Date()): BsvRadarDirectory | null {
  if (!explicitPath && memo) {
    try {
      if (statSync(defaultDirectoryPath()).mtimeMs === memo.mtimeMs) return memo.value;
    } catch {
      memo = null;
      return null;
    }
  }
  const loaded = readDirectory(explicitPath, clock);
  if (!explicitPath && loaded) {
    try {
      memo = { mtimeMs: statSync(defaultDirectoryPath()).mtimeMs, value: loaded };
    } catch {
      memo = null;
    }
  }
  return loaded;
}

const PIN_PROBE_BYTES = 8_192;

/** ISO time from pin.fetchedAt, without reading the catalogue. */
export function directoryFetchedAt(explicitPath?: string): string | undefined {
  const directoryPath = explicitPath ?? defaultDirectoryPath();
  let fd: number | undefined;
  try {
    fd = openSync(directoryPath, 'r');
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
