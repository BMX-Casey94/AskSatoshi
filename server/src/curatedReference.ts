/**
 * Curated reference material: the identity dossier (third-party testimony, documented
 * events and public curiosities bearing on the Satoshi identity question) and the
 * demonstrated-capacity record for scaling/Teranode questions.
 *
 * Both are pinned JSON under data/, loaded once at boot and searched locally with
 * BM25 (minisearch) — no network access at runtime, fail-open when absent (the
 * orchestrator simply falls back to the MCP/corpus path).
 *
 * The dossier is internal reference material: it names names and states the record
 * plainly. The persona layer decides what the model may say aloud (never a living
 * candidate's name); this module's only job is faithful retrieval.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import MiniSearch from 'minisearch';

export type DossierCategory =
  | 'testimony'
  | 'private-signing'
  | 'doxxing-2015'
  | 'early-record'
  | 'curiosity'
  | 'legal-record'
  | 'commentary';

export interface DossierEntry {
  id: string;
  category: DossierCategory;
  title: string;
  /** ISO date (YYYY-MM-DD) when known. */
  date?: string;
  /** Real, clickable web URL. Entries without one are evidence-only, never cited. */
  url?: string;
  text: string;
  /** Cornerstone entries are always included for identity questions, regardless of BM25. */
  pin?: boolean;
}

export interface ScalingRecord {
  evidenceText: string;
  citations: { label: string; title?: string; url?: string; excerpt?: string }[];
}

/** Same shape as the scaling record — a pinned evidence block with optional citations. */
export type ImplementationRecord = ScalingRecord;

interface DossierFile {
  entries?: DossierEntry[];
}

interface ScalingFile {
  evidenceText?: string;
  citations?: ScalingRecord['citations'];
}

/** Minimum BM25 score to treat a dossier hit as relevant; below this we fail closed. */
const MIN_SCORE = 2;

/**
 * Identity questions: about WHO Satoshi is, not about things named after him.
 * "What is a satoshi?" (the unit) or "How do private keys work?" must not trigger
 * the dossier — the patterns below require an identity cue, a named candidate, or a
 * direct who-are-you framing.
 */
const IDENTITY_STRONG =
  /\b(craig|wright|nakamoto|csw|1csw|doxx(?:ed|ing)?|unmask(?:ed|ing)?|pseudonym(?:ous)?|real (?:name|identity)|true identity)\b/i;
const IDENTITY_SATOSHI_CUE =
  /\b(who|whose|real|really|actually|identity|person|people|man|woman|group|prove|proof|claim(?:s|ed|ing)?|believe|alive|dead|reveal(?:ed)?|anonymous|anonymity|names?|human|individual)\b/i;
const IDENTITY_WHO_FRAME =
  /\bwho\b[^.?!]{0,60}\b(are|r)\s+(you|u)\b|\bwho\b[^.?!]{0,80}\b(invented|created|wrote|designed|made|built|authored)\b[^.?!]{0,40}\b(bitcoin|white\s?paper|whitepaper)\b|\b(are|were)\s+(you|u)\b[^.?!]{0,40}\b(satoshi|the creator|the author|the inventor)\b/i;

export function isIdentityQuestion(q: string): boolean {
  if (IDENTITY_STRONG.test(q)) return true;
  if (/\bsatoshi('?s)?\b/i.test(q) && IDENTITY_SATOSHI_CUE.test(q)) return true;
  return IDENTITY_WHO_FRAME.test(q);
}

/**
 * Scaling/throughput questions. Word-sense guard: "scaling" a logo, icon or image is
 * not network throughput (the citation filter has long made the same distinction).
 */
const SCALING_TERM =
  /\b(scal(?:e|es|ed|ing|ability)|teranode|tps|transactions per second|throughput|block\s?size|big blocks?|small blocks?|gigablock|terabyte|gigabyte|megabyte|million tps|billion|visa|mastercard|capacity|on-?chain scaling|unbounded)\b/i;
const SCALING_FALSE_FRIEND = /\b(logo|icon|image|pixel|font|avatar|ui|ux|display|screen|resize|resolution)\b/i;

export function isScalingQuestion(q: string): boolean {
  return SCALING_TERM.test(q) && !SCALING_FALSE_FRIEND.test(q);
}

/**
 * Implementation / "how do I build this" questions. These must be answered from the
 * BRC record (especially BRC-100) and the later essays — never with Taproot, SegWit
 * or Lightning as something to implement. Critique of those terms is a different
 * question and must not match here.
 */
const IMPLEMENTATION_BUILD =
  /\b(implement|implementation|build(?:ing)?|develop(?:ing|ment)|application|\bapps?\b|platform|dapp|integrat(?:e|ion)|architect(?:ure)?|what (?:would|should|do) (?:you|i) (?:use|choose|recommend|implement|build)|how (?:do|would|can|should) i\b.{0,80}\b(?:build|implement|create|make|write|code|develop|integrate)|recommend (?:for|to)|stack to use|on-?chain (?:app|application|charity|platform))\b/i;
const IMPLEMENTATION_CRITIQUE_ONLY =
  /\b(what is|what's|whats|explain|why (?:is|was|did|does)|critique|problem with|wrong with|history of)\b.{0,40}\b(taproot|segwit|segregated witness|lightning|bip-?14[01]|bip-?341|sidechain|rollup)\b/i;

export function isImplementationQuestion(q: string): boolean {
  if (IMPLEMENTATION_CRITIQUE_ONLY.test(q)) return false;
  return IMPLEMENTATION_BUILD.test(q);
}

/** Tech-retrieval hint so builder questions hit BRC-100 / SPV rather than a BTC prior. */
export const IMPLEMENTATION_TECH_QUERY = 'BRC-100 BRC-62 OP_RETURN SPV wallet overlay SDK';

export class CuratedReference {
  private readonly mini: MiniSearch<DossierEntry>;
  private readonly all: DossierEntry[];
  private readonly pinned: DossierEntry[];
  readonly scaling: ScalingRecord | null;
  readonly implementation: ImplementationRecord | null;

  constructor(
    entries: DossierEntry[],
    scaling: ScalingRecord | null,
    implementation: ImplementationRecord | null = null,
  ) {
    this.all = entries;
    this.pinned = entries.filter((e) => e.pin);
    this.scaling = scaling;
    this.implementation = implementation;
    this.mini = new MiniSearch<DossierEntry>({
      fields: ['title', 'text', 'category'],
      storeFields: ['id', 'category', 'title', 'date', 'url', 'text', 'pin'],
      searchOptions: { boost: { title: 3 }, prefix: true, fuzzy: 0.1 },
    });
    this.mini.addAll(entries);
  }

  /**
   * Dossier entries relevant to an identity question: pinned cornerstones first, then
   * BM25 hits with a category-diversity pass so one theme (e.g. testimony) cannot
   * crowd out the doxxing record, the early record, or the curiosities. Every entry is
   * on-topic by construction, so non-hits still rank (after hits) — an identity question
   * with thin lexical overlap must not starve the answer of the record.
   */
  searchDossier(question: string, limit = 6): DossierEntry[] {
    const raw = this.mini.search(question);
    const top = raw[0]?.score ?? 0;
    const hits = raw
      .filter((h) => h.score >= Math.max(MIN_SCORE, top * 0.2))
      .map((h) => ({
        id: String(h.id),
        category: h.category as DossierCategory,
        title: String(h.title),
        date: h.date ? String(h.date) : undefined,
        url: h.url ? String(h.url) : undefined,
        text: String(h.text),
      }));
    const hitIds = new Set(hits.map((h) => h.id));
    const ranked = [...hits, ...this.all.filter((e) => !hitIds.has(e.id))];

    const picked: DossierEntry[] = [];
    const seen = new Set<string>();
    const push = (e: DossierEntry) => {
      if (picked.length >= limit || seen.has(e.id)) return;
      seen.add(e.id);
      picked.push(e);
    };

    for (const e of this.pinned) push(e);
    // Diversity pass: best-ranked entry per category not already pinned.
    const categories = new Set<DossierCategory>(this.pinned.map((e) => e.category));
    for (const e of ranked) {
      if (categories.has(e.category)) continue;
      categories.add(e.category);
      push(e);
    }
    // Fill any remaining slots by rank.
    for (const e of ranked) push(e);
    return picked;
  }
}

function parseDossier(raw: string): DossierEntry[] {
  const parsed = JSON.parse(raw) as DossierFile;
  if (!Array.isArray(parsed.entries)) return [];
  return parsed.entries.filter(
    (e): e is DossierEntry =>
      typeof e === 'object' &&
      e !== null &&
      typeof e.id === 'string' &&
      typeof e.title === 'string' &&
      typeof e.text === 'string' &&
      typeof e.category === 'string',
  );
}

function parseScaling(raw: string): ScalingRecord | null {
  const parsed = JSON.parse(raw) as ScalingFile;
  if (typeof parsed.evidenceText !== 'string' || !parsed.evidenceText.trim()) return null;
  return {
    evidenceText: parsed.evidenceText,
    citations: Array.isArray(parsed.citations)
      ? parsed.citations.filter((c) => typeof c === 'object' && c !== null && typeof (c as { label?: unknown }).label === 'string')
      : [],
  };
}

/**
 * Load the pinned reference files; returns null (fail-open) when absent or invalid.
 * The default branch reads via a const assigned from a literal join() relative to this
 * module — the one pattern Vercel's file tracer (@vercel/nft) can resolve statically,
 * so the JSON is bundled into the serverless function.
 */
function loadPinnedJson(path: string, label: string): ScalingRecord | null {
  if (!existsSync(path)) return null;
  try {
    return parseScaling(readFileSync(path, 'utf8'));
  } catch (err) {
    console.warn(`[curated] failed to parse ${label}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

export function loadCuratedReference(
  dossierPath?: string,
  scalingPath?: string,
  implementationPath?: string,
): CuratedReference | null {
  let entries: DossierEntry[] = [];
  let scaling: ScalingRecord | null = null;
  let implementation: ImplementationRecord | null = null;

  if (dossierPath || scalingPath || implementationPath) {
    if (dossierPath && existsSync(dossierPath)) {
      try {
        entries = parseDossier(readFileSync(dossierPath, 'utf8'));
      } catch (err) {
        console.warn('[curated] failed to parse identity dossier:', err instanceof Error ? err.message : err);
      }
    }
    if (scalingPath) scaling = loadPinnedJson(scalingPath, 'scaling record');
    if (implementationPath) implementation = loadPinnedJson(implementationPath, 'implementation record');
  } else {
    const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
    const dossierFile = join(dataDir, 'identity-dossier.json');
    const scalingFile = join(dataDir, 'scaling-record.json');
    const implementationFile = join(dataDir, 'implementation-record.json');
    if (existsSync(dossierFile)) {
      try {
        entries = parseDossier(readFileSync(dossierFile, 'utf8'));
      } catch (err) {
        console.warn('[curated] failed to parse identity dossier:', err instanceof Error ? err.message : err);
      }
    } else {
      console.warn(`[curated] ${dossierFile} not found — identity dossier disabled.`);
    }
    scaling = loadPinnedJson(scalingFile, 'scaling record');
    if (!scaling) console.warn(`[curated] ${scalingFile} not found — scaling record disabled.`);
    implementation = loadPinnedJson(implementationFile, 'implementation record');
    if (!implementation) console.warn(`[curated] ${implementationFile} not found — implementation record disabled.`);
  }

  if (entries.length === 0 && !scaling && !implementation) return null;
  console.log(
    `[curated] loaded ${entries.length} dossier entries${scaling ? ' + scaling record' : ''}${implementation ? ' + implementation record' : ''}`,
  );
  return new CuratedReference(entries, scaling, implementation);
}
