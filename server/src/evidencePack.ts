/**
 * Pure packing for MCP hits before they become the evidence block.
 *
 * Broad questions are searched lexically, so the top of the list is whatever has the
 * keyword in its title: a run of one series, and the same essay twice (principle card
 * plus essay summary). These helpers collapse that, strip the YAML the principle
 * excerpts open with, and spread the remaining slots across themes. Protocol-fact and
 * builder questions do not come through here for diversification — the caller keeps
 * them in rank order.
 */

import { extractKeywords } from './queryUnderstanding.js';

/** A hit the packer can dedupe, group and rotate. Extra fields are preserved. */
export interface EvidenceRecord {
  id: string;
  kind?: string;
  locator?: string;
  title?: string;
  excerpt?: string;
  date?: string;
  era?: string;
  themes?: string[];
  url?: string;
}

export interface ParsedMatter {
  prose: string;
  title?: string;
  date?: string;
  era?: string;
  slug?: string;
  themes: string[];
  source?: string;
}

export interface DedupeResult<T extends EvidenceRecord> {
  hits: T[];
  /** Dropped id or locator → id of the hit that absorbed it. */
  aliases: Map<string, string>;
}

export interface EvidenceAngle<T extends EvidenceRecord = EvidenceRecord> {
  id: string;
  label: string;
  hit: T;
}

export interface PackedEvidence<T extends EvidenceRecord> {
  hits: T[];
  /** One-line angle the evidence block leads with, when there was a real choice. */
  leadAngle?: string;
}

/** Fuller core text fetched for the entries that will actually be shown. */
export const ENRICH_TOP_N = 4;
export const ENRICH_TIMEOUT_MS = 2_500;
/** Per-entry model budget: inside the 900–1,400 band, and inside MAX_EXCERPT_CHARS. */
export const RICH_EXCERPT_CHARS = 1_200;
/**
 * Developer depth only. Spec bodies are sliced to this so field order, byte order
 * and sibling ordering in the stored text can reach the model. Essays stay on
 * RICH_EXCERPT_CHARS. Beginner and standard do not use it.
 */
export const DEVELOPER_SPEC_EXCERPT_CHARS = 2_000;
/** Theme tag for Satoshi's own 2008–2011 hits. Diversification must not thin this cluster. */
export const PRIMARY_RECORD_THEME = 'primary record';

const THEME_CAP = 2;
const SERIES_CAP = 2;
const MAX_ANGLES = 4;
/** At or below this, diversification would only reshuffle a handful of hits. */
const FEW_CANDIDATES = 3;
const CACHE_TEXT_MAX = 8_000;
const DEFAULT_CACHE_MAX = 200;
const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000;

const MATTER_KEYS = ['title', 'date', 'published', 'pubdate', 'era', 'slug', 'themes', 'source', 'subtitle', 'author'];

/**
 * Topic words that match almost every Bitcoin hit. They retrieve the set; they must
 * not exempt a hit from the theme cap, or "What is Bitcoin?" could never diversify.
 * A hit is protected only when it shares a more specific question term — the same
 * term list extractKeywords / investigateEngages use, minus these.
 */
const GENERIC_TOPIC = new Set([
  'bitcoin', 'bitcoins', 'bsv', 'satoshi', 'satoshis', 'blockchain', 'blockchains',
  'money', 'cash', 'coin', 'coins', 'crypto', 'currency', 'network', 'block', 'blocks',
  'chain', 'peer', 'electronic', 'digital', 'system', 'protocol', 'transaction', 'transactions',
]);

const SERIES_STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'what', 'how', 'why', 'are', 'was',
  'bitcoin', 'bitcoins', 'bsv', 'satoshi',
]);

function cleanScalar(value: string): string {
  const t = value.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1).trim();
  }
  return t;
}

function looksLikeFrontMatter(body: string): boolean {
  return new RegExp(`(?:^|\\s)(?:${MATTER_KEYS.join('|')}):`, 'i').test(body);
}

export function parseThemeList(raw: string | undefined): string[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  const inner = trimmed.startsWith('[') ? trimmed.replace(/^\[/, '').replace(/\]\s*$/, '') : trimmed;
  const seen = new Set<string>();
  const themes: string[] = [];
  for (const part of inner.split(/[,;]/)) {
    const theme = cleanScalar(part).toLowerCase();
    if (!theme || theme.length > 80 || seen.has(theme)) continue;
    seen.add(theme);
    themes.push(theme);
  }
  return themes;
}

function normaliseDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const iso = /(\d{4}-\d{2}-\d{2})/.exec(raw);
  return iso?.[1];
}

function parseYamlBlock(block: string, fields: Record<string, string>): void {
  const lines = block.split('\n');
  let listKey: string | null = null;
  const list: string[] = [];
  const flush = () => {
    if (listKey && list.length > 0) fields[listKey] = list.join(', ');
    list.length = 0;
    listKey = null;
  };
  for (const line of lines) {
    const item = /^\s*-\s+(.+?)\s*$/.exec(line);
    if (item?.[1] && listKey) {
      list.push(cleanScalar(item[1]));
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv?.[1]) continue;
    flush();
    const key = kv[1].toLowerCase();
    const value = (kv[2] ?? '').trim();
    if (!value) {
      listKey = key;
      continue;
    }
    fields[key] = cleanScalar(value);
  }
  flush();
}

function parseCollapsedBlock(body: string, fields: Record<string, string>): void {
  const keyRe = new RegExp(`\\b(${MATTER_KEYS.join('|')}):`, 'gi');
  const marks: { key: string; valueStart: number; keyStart: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = keyRe.exec(body))) {
    const key = match[1];
    if (!key) continue;
    marks.push({ key: key.toLowerCase(), valueStart: match.index + match[0].length, keyStart: match.index });
  }
  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i];
    const next = marks[i + 1];
    if (!mark) continue;
    const end = next ? next.keyStart : body.length;
    fields[mark.key] = cleanScalar(body.slice(mark.valueStart, end));
  }
}

/**
 * Remove a leading `--- … ---` block and the `# Title — core principles` heading,
 * and keep the title, date, era and themes that were inside it.
 * Idempotent on prose that has already been stripped.
 */
export function parseLeadingMatter(text: string): ParsedMatter {
  const fields: Record<string, string> = {};
  let t = text.replace(/\r/g, '').replace(/^\uFEFF/, '').trimStart();

  const yaml = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(t);
  if (yaml && looksLikeFrontMatter(yaml[1] ?? '')) {
    parseYamlBlock(yaml[1] ?? '', fields);
    t = t.slice(yaml[0].length).trimStart();
  } else {
    const collapsed = /^---\s+([\s\S]*?)\s+---\s*/.exec(t);
    if (collapsed && looksLikeFrontMatter(collapsed[1] ?? '')) {
      parseCollapsedBlock(collapsed[1] ?? '', fields);
      t = t.slice(collapsed[0].length).trimStart();
    }
  }

  // The heading boilerplate sits on one line. Do not consume a later sentence that
  // happens to say "core principles" — on a collapsed excerpt that sentence follows
  // the heading on the same line, so the match stops at the boilerplate words.
  t = t.replace(/^#\s+[^\n]{0,200}?\bcore principles\b\s*/i, '');
  t = t.replace(/^#\s+[^\n]*\n+/, '');

  const meta = /^((?:\*\*(?:Date|URL|Subtitle|Author|Era|Source):\*\*[^\n]*\n+)+)/i.exec(t);
  if (meta?.[1]) {
    const dateLine = /\*\*Date:\*\*\s*([^\n*]+)/i.exec(meta[1]);
    if (dateLine?.[1] && !fields.date) fields.date = dateLine[1].trim();
    const eraLine = /\*\*Era:\*\*\s*([^\n*]+)/i.exec(meta[1]);
    if (eraLine?.[1] && !fields.era) fields.era = eraLine[1].trim();
    t = t.slice(meta[1].length);
  }

  const title = cleanScalar(fields.title ?? '');
  const era = cleanScalar(fields.era ?? '');
  const slug = cleanScalar(fields.slug ?? '');
  const source = cleanScalar(fields.source ?? '');
  return {
    prose: t.trim(),
    title: title || undefined,
    date: normaliseDate(fields.date || fields.published || fields.pubdate),
    era: era || undefined,
    slug: slug || undefined,
    themes: parseThemeList(fields.themes),
    source: source || undefined,
  };
}

function decodeSlug(slug: string): string {
  try {
    return decodeURIComponent(slug);
  } catch {
    return slug;
  }
}

/** `principle:<era>:<slug>` and `essay:<era>:<slug>` (and their locators) share this key. */
export function evidencePairKey(hit: EvidenceRecord): string | undefined {
  const id = /^(?:principle|essay):([^:]+):(.+)$/i.exec(hit.id.trim());
  if (id?.[1] && id[2]) return `${id[1].toLowerCase()}:${decodeSlug(id[2]).toLowerCase()}`;
  const locator = hit.locator ?? '';
  const essay = /^csw:\/\/essay\/(medium|substack)\/(.+)$/i.exec(locator);
  if (essay?.[1] && essay[2]) return `${essay[1].toLowerCase()}:${decodeSlug(essay[2]).toLowerCase()}`;
  const principle = /^education\/(medium|substack)--(.+)\.md$/i.exec(locator);
  if (principle?.[1] && principle[2]) return `${principle[1].toLowerCase()}:${decodeSlug(principle[2]).toLowerCase()}`;
  return undefined;
}

function essayLike(hit: EvidenceRecord): boolean {
  const kind = hit.kind?.toLowerCase();
  if (kind === 'essay' || kind === 'principle') return true;
  return evidencePairKey(hit) !== undefined;
}

export function titleKey(title: string | undefined): string | undefined {
  if (!title) return undefined;
  const normalised = title
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return normalised || undefined;
}

function stemWord(word: string): string {
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('es')) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/** Title-series prefix: "Tax and Bitcoin" and "Taxing Bitcoin" share `tax`. */
export function seriesKey(title: string | undefined): string | undefined {
  if (!title) return undefined;
  const head = title.split(/\s+[—–]\s+|\s+-\s+|:\s+/)[0] ?? title;
  const words = head
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(stemWord)
    .filter((word) => word.length > 2 && !SERIES_STOP.has(word));
  if (words.length === 0) return undefined;
  return words.slice(0, 2).join('-');
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

function normSentence(sentence: string): string {
  return sentence.toLowerCase().replace(/\s+/g, ' ').replace(/[.!?,;:]+$/g, '').trim();
}

function contentTokens(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 4));
}

function contentDiffersMaterially(a: string, b: string): boolean {
  const left = contentTokens(a);
  const right = contentTokens(b);
  if (left.size === 0 || right.size === 0) return false;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;
  const containment = shared / Math.min(left.size, right.size);
  const jaccard = shared / (left.size + right.size - shared);
  return containment < 0.82 && jaccard < 0.72;
}

function datesDifferMaterially(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return a.slice(0, 10) !== b.slice(0, 10);
}

/** Keep the richer prose, and append sentences the richer one does not already say. */
export function mergeDistinctProse(a: string | undefined, b: string | undefined): string {
  const left = (a ?? '').trim();
  const right = (b ?? '').trim();
  if (!left) return right;
  if (!right) return left;
  if (left.includes(right)) return left;
  if (right.includes(left)) return right;
  const base = left.length >= right.length ? left : right;
  const extra = left.length >= right.length ? right : left;
  const seen = new Set(sentences(base).map(normSentence));
  const baseLower = base.toLowerCase();
  const added = sentences(extra).filter((sentence) => {
    const key = normSentence(sentence);
    if (!key || seen.has(key)) return false;
    if (baseLower.includes(sentence.toLowerCase())) return false;
    seen.add(key);
    return true;
  });
  if (added.length === 0) return base;
  return `${base} ${added.join(' ')}`.trim();
}

function withMatter<T extends EvidenceRecord>(hit: T): T {
  const parsed = parseLeadingMatter(hit.excerpt ?? '');
  const themes = hit.themes?.length ? hit.themes.map((theme) => theme.toLowerCase()) : parsed.themes;
  return {
    ...hit,
    excerpt: parsed.prose,
    title: hit.title || parsed.title,
    date: hit.date || parsed.date,
    era: hit.era || parsed.era,
    themes,
  };
}

function mergeRecords<T extends EvidenceRecord>(a: T, b: T): T {
  const proseA = a.excerpt ?? '';
  const proseB = b.excerpt ?? '';
  const richer = proseB.trim().length > proseA.trim().length ? b : a;
  return {
    ...a,
    excerpt: mergeDistinctProse(proseA, proseB),
    title: a.title || b.title,
    date: a.date || b.date,
    era: a.era || b.era,
    themes: [...new Set([...(a.themes ?? []), ...(b.themes ?? [])])],
    locator: richer.locator ?? a.locator,
    url: a.url || b.url,
    kind: a.kind || b.kind,
  };
}

/**
 * Collapse principle/essay pairs into one hit, and collapse exact-duplicate titles
 * when the posts are not materially different in date or wording. Rank order of the
 * first copy is kept; the text kept is the richer one.
 */
export function dedupeEvidenceHits<T extends EvidenceRecord>(hits: T[]): DedupeResult<T> {
  const result: T[] = [];
  const aliases = new Map<string, string>();
  const pairIndex = new Map<string, number>();
  const titleIndex = new Map<string, number>();
  const remember = (hit: EvidenceRecord, keptId: string) => {
    if (hit.id && hit.id !== keptId) aliases.set(hit.id, keptId);
    if (hit.locator && hit.locator !== keptId) aliases.set(hit.locator, keptId);
  };

  for (const raw of hits) {
    const hit = withMatter(raw);
    const pair = evidencePairKey(hit);
    if (pair && pairIndex.has(pair)) {
      const index = pairIndex.get(pair)!;
      const kept = result[index];
      if (kept) {
        result[index] = mergeRecords(kept, hit);
        remember(hit, kept.id);
      }
      continue;
    }
    const titled = essayLike(hit) ? titleKey(hit.title) : undefined;
    if (titled && titleIndex.has(titled)) {
      const index = titleIndex.get(titled)!;
      const prev = result[index];
      if (
        prev &&
        essayLike(prev) &&
        !datesDifferMaterially(prev.date, hit.date) &&
        !contentDiffersMaterially(prev.excerpt ?? '', hit.excerpt ?? '')
      ) {
        result[index] = mergeRecords(prev, hit);
        if (pair) pairIndex.set(pair, index);
        remember(hit, prev.id);
        continue;
      }
    }
    const index = result.length;
    result.push(hit);
    if (pair) pairIndex.set(pair, index);
    if (titled && !titleIndex.has(titled)) titleIndex.set(titled, index);
  }
  return { hits: result, aliases };
}

/** Question terms worth protecting from the theme cap. Generic topic words do not count. */
export function distinctiveTerms(question: string): string[] {
  const raw = extractKeywords(question) ?? question;
  return raw
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 2 && !GENERIC_TOPIC.has(word));
}

/**
 * True when the hit shares a specific subject term with the question (the same
 * overlap investigateEngages uses), so a diversity cap must not drop it.
 */
export function hitDirectlyEngages(question: string, hit: EvidenceRecord): boolean {
  const terms = distinctiveTerms(question);
  if (terms.length === 0) return false;
  const haystack = `${hit.title ?? ''} ${hit.excerpt ?? ''} ${hit.locator ?? ''} ${hit.id}`.toLowerCase();
  return terms.some((term) => haystack.includes(term));
}

function aboutCluster(question: string, label: string | undefined): boolean {
  if (!label) return false;
  const asked = question.toLowerCase();
  const parts = label
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !GENERIC_TOPIC.has(word) && !SERIES_STOP.has(word));
  if (parts.length === 0) return false;
  return parts.some((part) => asked.includes(part));
}

/** Historian retrieval tags Satoshi's own dated writings as this cluster. */
export function isPrimaryRecord(hit: EvidenceRecord): boolean {
  if (hit.kind?.toLowerCase() === 'satoshi-primary') return true;
  return (hit.themes ?? []).some((theme) => theme.toLowerCase().trim() === PRIMARY_RECORD_THEME);
}

function clusterId(hit: EvidenceRecord): string {
  if (isPrimaryRecord(hit)) return 'primary-record';
  const theme = hit.themes?.[0]?.toLowerCase().trim();
  if (theme) return `theme:${theme}`;
  const series = seriesKey(hit.title);
  if (series) return `series:${series}`;
  const title = titleKey(hit.title);
  if (title) return `title:${title}`;
  return `id:${hit.id}`;
}

function angleLabel(hit: EvidenceRecord): string {
  const theme = hit.themes?.[0]?.replace(/[-_]+/g, ' ').trim();
  const title = hit.title?.replace(/\s+/g, ' ').trim();
  if (theme && title) return `${theme} — ${title}`;
  return title || theme || hit.id;
}

/**
 * Walk in rank order. Keep the highest-ranked hit of each theme and series, allow
 * at most two from a cluster, and never drop a hit that engages a specific question
 * term. A question that is itself about that theme or series is not capped.
 * Hits in the primary-record cluster are kept in full — that cluster is separate
 * from theme and series caps.
 */
export function diversifyEvidenceHits<T extends EvidenceRecord>(hits: T[], question: string): T[] {
  const themeCount = new Map<string, number>();
  const seriesCount = new Map<string, number>();
  const kept: T[] = [];
  for (const hit of hits) {
    if (isPrimaryRecord(hit)) {
      kept.push(hit);
      continue;
    }
    const theme = hit.themes?.[0]?.toLowerCase().trim();
    const series = seriesKey(hit.title);
    const protectedHit = hitDirectlyEngages(question, hit);
    const themeOpen = !theme || aboutCluster(question, theme) || (themeCount.get(theme) ?? 0) < THEME_CAP;
    const seriesOpen = !series || aboutCluster(question, series) || (seriesCount.get(series) ?? 0) < SERIES_CAP;
    if (!protectedHit && (!themeOpen || !seriesOpen)) continue;
    kept.push(hit);
    if (theme) themeCount.set(theme, (themeCount.get(theme) ?? 0) + 1);
    if (series) seriesCount.set(series, (seriesCount.get(series) ?? 0) + 1);
  }
  return kept;
}

export function deriveAngles<T extends EvidenceRecord>(hits: T[], limit = MAX_ANGLES): EvidenceAngle<T>[] {
  const angles: EvidenceAngle<T>[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    const id = clusterId(hit);
    if (seen.has(id)) continue;
    seen.add(id);
    angles.push({ id, label: angleLabel(hit), hit });
    if (angles.length >= limit) break;
  }
  return angles;
}

/** Deterministic when `rng` is injected. `rng` returns a value in [0, 1), as Math.random does. */
export function pickAngleSeed<T>(angles: readonly T[], rng: () => number = Math.random): T | undefined {
  if (angles.length === 0) return undefined;
  const raw = rng();
  const unit = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 0.999999999) : 0;
  const index = Math.min(angles.length - 1, Math.floor(unit * angles.length));
  return angles[index];
}

function selectFinal<T extends EvidenceRecord>(diverse: T[], lead: T, question: string, limit: number): T[] {
  const chosen: T[] = [lead];
  const chosenIds = new Set<string>([lead.id]);
  const seenCluster = new Set<string>([clusterId(lead)]);
  const take = (hit: T) => {
    if (chosenIds.has(hit.id) || chosen.length >= limit) return;
    chosenIds.add(hit.id);
    chosen.push(hit);
  };
  for (const hit of diverse) {
    if (chosen.length >= limit) break;
    if (chosenIds.has(hit.id)) continue;
    const cluster = clusterId(hit);
    if (seenCluster.has(cluster)) continue;
    seenCluster.add(cluster);
    take(hit);
  }
  for (const hit of diverse) {
    if (chosen.length >= limit) break;
    take(hit);
  }
  if (chosen.length >= limit) {
    for (const hit of diverse) {
      if (!hitDirectlyEngages(question, hit) || chosenIds.has(hit.id)) continue;
      let replaceAt = -1;
      for (let i = chosen.length - 1; i >= 1; i--) {
        const current = chosen[i];
        if (current && !hitDirectlyEngages(question, current)) {
          replaceAt = i;
          break;
        }
      }
      if (replaceAt < 0) continue;
      const removed = chosen[replaceAt];
      if (!removed) continue;
      chosenIds.delete(removed.id);
      chosen[replaceAt] = hit;
      chosenIds.add(hit.id);
    }
  }
  return retainPrimaryRecord(chosen, diverse, limit);
}

/**
 * The primary-record cluster is not a theme to thin. If the limit would leave one out,
 * evict a later non-primary; if every slot is already primary, keep the extra hit.
 */
function retainPrimaryRecord<T extends EvidenceRecord>(chosen: T[], diverse: T[], limit: number): T[] {
  const chosenIds = new Set(chosen.map((hit) => hit.id));
  for (const hit of diverse) {
    if (!isPrimaryRecord(hit) || chosenIds.has(hit.id)) continue;
    if (chosen.length < limit) {
      chosen.push(hit);
      chosenIds.add(hit.id);
      continue;
    }
    let replaceAt = -1;
    for (let i = chosen.length - 1; i >= 1; i--) {
      const current = chosen[i];
      if (current && !isPrimaryRecord(current)) {
        replaceAt = i;
        break;
      }
    }
    if (replaceAt < 0 && chosen[0] && !isPrimaryRecord(chosen[0])) replaceAt = 0;
    if (replaceAt < 0) {
      chosen.push(hit);
      chosenIds.add(hit.id);
      continue;
    }
    const removed = chosen[replaceAt];
    if (!removed) continue;
    chosenIds.delete(removed.id);
    chosen[replaceAt] = hit;
    chosenIds.add(hit.id);
  }
  return chosen;
}

/**
 * Diversify, then lead with one theme cluster. No-op (same array, no angle) when
 * there are too few hits to choose among, or fewer than two distinct angles.
 */
export function packBroadEvidence<T extends EvidenceRecord>(
  hits: T[],
  question: string,
  rng?: () => number,
  opts?: { limit?: number },
): PackedEvidence<T> {
  if (hits.length <= FEW_CANDIDATES) return { hits };
  const diverse = diversifyEvidenceHits(hits, question);
  if (diverse.length <= 1) return { hits: diverse };
  const angles = deriveAngles(diverse, MAX_ANGLES);
  if (angles.length < 2) return { hits: diverse };
  const picked = pickAngleSeed(angles, rng);
  if (!picked) return { hits: diverse };
  const limit = opts?.limit ?? diverse.length;
  return {
    hits: selectFinal(diverse, picked.hit, question, Math.max(1, limit)),
    leadAngle: picked.label,
  };
}

export interface LocatorCache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  clear(): void;
}

export function createLocatorCache<T>(opts?: {
  max?: number;
  ttlMs?: number;
  now?: () => number;
}): LocatorCache<T> {
  const max = opts?.max ?? DEFAULT_CACHE_MAX;
  const ttlMs = opts?.ttlMs ?? DEFAULT_CACHE_TTL_MS;
  const now = opts?.now ?? (() => Date.now());
  const map = new Map<string, { value: T; at: number }>();
  return {
    get(key) {
      const row = map.get(key);
      if (!row) return undefined;
      if (now() - row.at > ttlMs) {
        map.delete(key);
        return undefined;
      }
      map.delete(key);
      map.set(key, row);
      return row.value;
    },
    set(key, value) {
      if (map.has(key)) map.delete(key);
      map.set(key, { value, at: now() });
      while (map.size > max) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    },
    clear() {
      map.clear();
    },
  };
}

export interface RicherSource {
  prose: string;
  title?: string;
  date?: string;
  era?: string;
  themes: string[];
}

const defaultSourceCache = createLocatorCache<RicherSource>();

export function clearLocatorCache(): void {
  defaultSourceCache.clear();
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * Fetch one document's core text. Fail-open: a timeout, a throw, or an empty body
 * returns undefined so the caller keeps the excerpt it already has. Successful
 * reads are cached by locator.
 */
export async function loadRicherSource(
  locator: string,
  load: (locator: string) => Promise<string | undefined>,
  opts?: { timeoutMs?: number; cache?: LocatorCache<RicherSource> },
): Promise<RicherSource | undefined> {
  const key = locator.trim();
  if (!key) return undefined;
  const cache = opts?.cache ?? defaultSourceCache;
  const cached = cache.get(key);
  if (cached) return cached;
  try {
    const pending = load(key);
    const text = opts?.timeoutMs !== undefined ? await withTimeout(pending, opts.timeoutMs) : await pending;
    if (typeof text !== 'string' || !text.trim()) return undefined;
    const parsed = parseLeadingMatter(text);
    const prose = parsed.prose.trim();
    if (!prose) return undefined;
    const source: RicherSource = {
      prose: prose.length > CACHE_TEXT_MAX ? prose.slice(0, CACHE_TEXT_MAX) : prose,
      title: parsed.title,
      date: parsed.date,
      era: parsed.era,
      themes: parsed.themes,
    };
    cache.set(key, source);
    return source;
  } catch {
    return undefined;
  }
}

/** Prose-only view of {@link loadRicherSource}, for callers that already hold the metadata. */
export async function loadRicherBody(
  locator: string,
  load: (locator: string) => Promise<string | undefined>,
  opts?: { timeoutMs?: number; cache?: LocatorCache<RicherSource> },
): Promise<string | undefined> {
  const source = await loadRicherSource(locator, load, opts);
  return source?.prose;
}
