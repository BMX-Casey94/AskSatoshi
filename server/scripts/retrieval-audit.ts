/**
 * Offline retrieval audit. No LLM calls.
 *
 * Connects the real bsv-aio-mcp child the same way src/index.ts does (McpBridge
 * after the repo-root .env), loads the pinned Satoshi corpus and curated reference,
 * and runs groundQuestion for a fixed question set. "standard" is the production
 * default: AnswerDepth has no standard member, so the plan omits depth. Eight
 * questions are also run at developer and historian.
 *
 * Usage (from server/):
 *   npx tsx scripts/retrieval-audit.ts
 *
 * Writes the full results to <repo>/.research-tmp/retrieval-audit.json.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Same targets as src/index.ts, which resolves .env from server/src.
dotenv.config({ path: resolve(__dirname, '../../.env') });
dotenv.config({ path: resolve(__dirname, '../.env'), override: true });

import { loadCuratedReference } from '../src/curatedReference.js';
import type { AnswerDepth } from '../src/chatRequest.js';
import { McpBridge, resolveMcpEntry } from '../src/mcp.js';
import {
  groundQuestion,
  locatorToUrl,
  type Citation,
  type Grounding,
} from '../src/orchestrate.js';
import { PROTOCOL_ID_SOURCE } from '../src/queryUnderstanding.js';
import { loadCorpus } from '../src/satoshiCorpus.js';

const THIN_CHARS = 1_500;
const REPORT_PATH = resolve(__dirname, '../../.research-tmp/retrieval-audit.json');

/** Kinds the technical tier searches. An essay mislabelled sourceClass "spec" is not one of these. */
const TECH_KINDS = new Set(['brc', 'symbol', 'test', 'example', 'doc', 'wiki', 'web', 'live', 'capability']);
const ESSAY_KINDS = new Set(['essay', 'principle', 'contradiction']);

/**
 * Conversational frame words. A content word is anything left. Mirrors the
 * keyword stop list so the TITLE-MISMATCH flag uses the same notion of "content"
 * the retriever does, including "bitcoin" when the question says it.
 */
const CONTENT_STOP = new Set(
  (
    'a,an,and,are,as,at,be,been,but,by,can,could,did,do,does,for,from,had,has,have,he,her,his,how,i,if,in,into,is,it,its,me,my,of,on,or,so,tell,that,the,their,them,they,this,to,was,we,were,what,when,which,who,why,will,with,you,your,about,know,known,want,wanted,like,show,explain,describe,give,say,said,please,thanks,thank,' +
    'not,there,here,than,then,too,very,just,again,once,such,no,nor,only,own,same,some,any,all'
  ).split(','),
);

type Category =
  | 'concept'
  | 'mechanism'
  | 'spec'
  | 'history'
  | 'contested'
  | 'scaling'
  | 'builder'
  | 'beginner'
  | 'outside';

interface AuditQuestion {
  id: string;
  category: Category;
  question: string;
  /** Mechanism and spec lookups should surface a technical-tier source. */
  expectsSpec: boolean;
  /** Also run developer and historian. */
  multiDepth: boolean;
}

const QUESTIONS: AuditQuestion[] = [
  { id: 'c01', category: 'concept', question: 'Why does Bitcoin need proof of work?', expectsSpec: false, multiDepth: true },
  { id: 'c02', category: 'concept', question: 'Why does Bitcoin not use a trusted third party?', expectsSpec: false, multiDepth: false },
  { id: 'c03', category: 'concept', question: 'What was Bitcoin meant to be?', expectsSpec: false, multiDepth: false },
  { id: 'c04', category: 'concept', question: 'Why is there a fixed supply of coins?', expectsSpec: false, multiDepth: false },
  { id: 'c05', category: 'concept', question: 'Why did you leave Bitcoin?', expectsSpec: false, multiDepth: false },

  { id: 'm01', category: 'mechanism', question: 'How does SPV work?', expectsSpec: true, multiDepth: true },
  { id: 'm02', category: 'mechanism', question: 'How does a Merkle branch prove inclusion?', expectsSpec: true, multiDepth: true },
  { id: 'm03', category: 'mechanism', question: 'What is a UTXO?', expectsSpec: true, multiDepth: false },
  { id: 'm04', category: 'mechanism', question: 'What does OP_RETURN do?', expectsSpec: true, multiDepth: false },
  { id: 'm05', category: 'mechanism', question: 'How does a coinbase transaction create new coins?', expectsSpec: true, multiDepth: false },
  { id: 'm06', category: 'mechanism', question: 'How is double-spending prevented?', expectsSpec: true, multiDepth: false },
  { id: 'm07', category: 'mechanism', question: 'What is simplified payment verification?', expectsSpec: true, multiDepth: false },

  { id: 's01', category: 'spec', question: 'What is BRC-100?', expectsSpec: true, multiDepth: true },
  { id: 's02', category: 'spec', question: 'What is BEEF?', expectsSpec: true, multiDepth: false },
  { id: 's03', category: 'spec', question: 'What is BRC-62?', expectsSpec: true, multiDepth: false },

  { id: 'h01', category: 'history', question: 'What did Satoshi say about the 1MB limit?', expectsSpec: false, multiDepth: true },
  { id: 'h02', category: 'history', question: 'What did Satoshi write about transaction fees?', expectsSpec: false, multiDepth: false },
  { id: 'h03', category: 'history', question: 'What was the genesis block coinbase message?', expectsSpec: false, multiDepth: false },
  { id: 'h04', category: 'history', question: 'When did Satoshi stop posting?', expectsSpec: false, multiDepth: false },

  { id: 'k01', category: 'contested', question: 'Was Bitcoin hijacked?', expectsSpec: false, multiDepth: true },
  { id: 'k02', category: 'contested', question: "Was Bitcoin's original vision abandoned?", expectsSpec: false, multiDepth: false },
  { id: 'k03', category: 'contested', question: 'Did someone co-opt Bitcoin?', expectsSpec: false, multiDepth: false },

  { id: 'g01', category: 'scaling', question: 'Can Bitcoin scale on-chain?', expectsSpec: false, multiDepth: false },
  { id: 'g02', category: 'scaling', question: 'What throughput has Teranode demonstrated?', expectsSpec: false, multiDepth: false },
  { id: 'g03', category: 'scaling', question: 'Was the block size always meant to stay small?', expectsSpec: false, multiDepth: false },

  { id: 'b01', category: 'builder', question: 'How do I build a wallet application?', expectsSpec: false, multiDepth: true },
  { id: 'b02', category: 'builder', question: 'How should I implement an on-chain charity platform?', expectsSpec: false, multiDepth: false },
  { id: 'b03', category: 'builder', question: 'What stack should I use to build a multisig treasury?', expectsSpec: false, multiDepth: false },

  { id: 'n01', category: 'beginner', question: 'What is a blockchain?', expectsSpec: false, multiDepth: false },
  { id: 'n02', category: 'beginner', question: 'What is a private key?', expectsSpec: false, multiDepth: false },
  { id: 'n03', category: 'beginner', question: 'Can Bitcoin be hacked?', expectsSpec: false, multiDepth: false },
  { id: 'n04', category: 'beginner', question: 'How are coins created?', expectsSpec: false, multiDepth: false },
  { id: 'n05', category: 'beginner', question: 'What is a Bitcoin address?', expectsSpec: false, multiDepth: false },
  { id: 'n06', category: 'beginner', question: 'What is mining?', expectsSpec: false, multiDepth: false },

  { id: 'o01', category: 'outside', question: 'What is a hash function?', expectsSpec: false, multiDepth: true },
  { id: 'o02', category: 'outside', question: 'How does public-key cryptography work?', expectsSpec: false, multiDepth: false },
  { id: 'o03', category: 'outside', question: 'Who invented the telephone?', expectsSpec: false, multiDepth: false },
  { id: 'o04', category: 'outside', question: 'What is the capital of France?', expectsSpec: false, multiDepth: false },
  { id: 'o05', category: 'outside', question: 'How do I bake sourdough bread?', expectsSpec: false, multiDepth: false },
  { id: 'o06', category: 'outside', question: 'What is photosynthesis?', expectsSpec: false, multiDepth: false },
];

type DepthLabel = 'standard' | AnswerDepth;

interface SeenHit {
  kind?: string;
  title?: string;
  locator?: string;
  url?: string;
}

interface ObservedCall {
  tool: 'search_knowledge' | 'investigate';
  query: string;
  kinds?: string[];
  hitCount: number;
  top: { title: string; kind: string; locator: string }[];
}

interface SelectedSource {
  order: number;
  title: string;
  kind: string;
  sourceClass: string;
  url?: string;
}

interface AuditRun {
  id: string;
  category: Category;
  question: string;
  depth: DepthLabel;
  expectsSpec: boolean;
  mode: Grounding['mode'] | 'error';
  citationCount: number;
  evidenceChars: number;
  flags: string[];
  sources: SelectedSource[];
  sharedTitleWords: string[];
  distinctiveSharedWords: string[];
  specLeads: boolean;
  evidenceRefHighWater: number;
  evidenceHead: string;
  leadAngle?: string;
  observedCalls: ObservedCall[];
  durationMs: number;
  evidenceText: string;
  error?: string;
}

/** Fixed seed so broad-question lead rotation does not change between runs. */
const AUDIT_RNG = (): number => 0;

function contentWords(question: string): string[] {
  const ids = question.match(new RegExp(`\\b${PROTOCOL_ID_SOURCE}\\b`, 'gi')) ?? [];
  const rough = question
    .replace(/[?!.,;:"'’"()[\]{}]/g, ' ')
    .split(/\s+/)
    .flatMap((token) => {
      if (/^BRC-?\d+s?$/i.test(token) || /^OP_[A-Z0-9_]+$/i.test(token)) return [token];
      return token.split(/[/-]+/);
    });
  const words = rough.filter((word) => {
    const low = word.toLowerCase();
    if (!low || CONTENT_STOP.has(low)) return false;
    return low.length > 2 || ids.some((id) => id.toLowerCase() === low);
  });
  return [...new Set([...ids, ...words].map((word) => word.toLowerCase()))];
}

/** Generic tokens that almost every Bitcoin title shares. Diagnostic only — not the flag. */
const GENERIC_TITLE_WORDS = new Set([
  'bitcoin',
  'bitcoins',
  'btc',
  'bsv',
  'satoshi',
  'nakamoto',
  'blockchain',
  'block',
  'chain',
  'coin',
  'coins',
]);

function titleHasWord(title: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, 'i').test(title);
}

function sharedWords(question: string, sources: SelectedSource[], generic: boolean): string[] {
  const words = contentWords(question).filter((word) => generic || !GENERIC_TITLE_WORDS.has(word));
  const found = new Set<string>();
  for (const source of sources) {
    const title = source.title;
    if (!title) continue;
    for (const word of words) {
      if (titleHasWord(title, word)) found.add(word);
    }
  }
  return [...found];
}

function corpusKind(citation: Citation): string | undefined {
  const label = citation.label ?? '';
  if (/^E-mail\b/i.test(label)) return 'email';
  if (/^Forum post\b/i.test(label)) return 'post';
  if (/^Quote\b/i.test(label) || citation.title === 'A historical quote from Satoshi') return 'quote';
  return undefined;
}

function hitsOf(payload: unknown): Record<string, unknown>[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const hits = (payload as Record<string, unknown>).hits;
  return Array.isArray(hits) ? (hits as Record<string, unknown>[]) : [];
}

function pushHit(into: SeenHit[], hit: Record<string, unknown>): void {
  const locator = typeof hit.locator === 'string' ? hit.locator : undefined;
  into.push({
    kind: typeof hit.kind === 'string' ? hit.kind.toLowerCase() : undefined,
    title: typeof hit.title === 'string' ? hit.title : undefined,
    locator,
    url: locator ? locatorToUrl(locator) : undefined,
  });
}

function summariseCall(
  tool: ObservedCall['tool'],
  query: string,
  kinds: string[] | undefined,
  payload: unknown,
): ObservedCall {
  const hits = hitsOf(payload);
  return {
    tool,
    query,
    ...(kinds ? { kinds } : {}),
    hitCount: hits.length,
    top: hits.slice(0, 5).map((hit) => ({
      title: typeof hit.title === 'string' ? hit.title : '',
      kind: typeof hit.kind === 'string' ? hit.kind : '',
      locator: typeof hit.locator === 'string' ? hit.locator : '',
    })),
  };
}

function instrument(mcp: McpBridge): {
  reset: () => void;
  calls: () => ObservedCall[];
  kindFor: (citation: Citation) => string;
} {
  const seen: SeenHit[] = [];
  const calls: ObservedCall[] = [];
  const originalSearch = mcp.searchKnowledge.bind(mcp);
  const originalInvestigate = mcp.investigate.bind(mcp);

  mcp.searchKnowledge = async (query, filters, limit) => {
    const result = await originalSearch(query, filters, limit);
    for (const hit of hitsOf(result)) pushHit(seen, hit);
    calls.push(summariseCall('search_knowledge', query, filters?.kind, result));
    return result;
  };
  mcp.investigate = async (question, context) => {
    const result = await originalInvestigate(question, context);
    for (const hit of hitsOf(result)) pushHit(seen, hit);
    calls.push(summariseCall('investigate', question, undefined, result));
    return result;
  };

  const kindFor = (citation: Citation): string => {
    const fromCorpus = corpusKind(citation);
    if (citation.sourceClass === 'satoshi-primary') return fromCorpus ?? 'primary';
    const title = (citation.title ?? '').trim().toLowerCase();
    const url = citation.url;
    const matches = seen.filter((hit) => {
      if (url && hit.url && hit.url === url) return true;
      if (title && hit.title && hit.title.trim().toLowerCase() === title) return true;
      return false;
    });
    const titled = matches.filter((hit) => title && hit.title && hit.title.trim().toLowerCase() === title);
    const pool = titled.length > 0 ? titled : matches;
    const kinds = [...new Set(pool.map((hit) => hit.kind).filter((kind): kind is string => Boolean(kind)))];
    if (kinds.length === 1) return kinds[0]!;
    if (kinds.length > 1) {
      if (citation.sourceClass === 'later-commentary') {
        const essay = kinds.find((kind) => ESSAY_KINDS.has(kind));
        if (essay) return essay;
      }
      if (citation.sourceClass === 'spec') {
        const tech = kinds.find((kind) => TECH_KINDS.has(kind));
        if (tech) return tech;
      }
      return kinds.join('+');
    }
    if (citation.sourceClass === 'historical-record') return 'curated';
    if (fromCorpus) return fromCorpus;
    return 'unknown';
  };

  return {
    reset: () => {
      seen.length = 0;
      calls.length = 0;
    },
    calls: () => calls.map((call) => ({ ...call, top: call.top.map((row) => ({ ...row })) })),
    kindFor,
  };
}

function sourceIsSpec(source: SelectedSource): boolean {
  const kind = source.kind.toLowerCase();
  if (TECH_KINDS.has(kind)) return true;
  // A merged kind list still counts when a technical kind is in it.
  if (kind.split('+').some((part) => TECH_KINDS.has(part))) return true;
  if (source.sourceClass === 'spec' && (kind === 'unknown' || kind === 'curated')) return true;
  return false;
}

function sourceIsEssay(source: SelectedSource): boolean {
  const parts = source.kind.toLowerCase().split('+');
  if (parts.some((part) => ESSAY_KINDS.has(part)) && !parts.some((part) => TECH_KINDS.has(part))) return true;
  if (source.sourceClass === 'later-commentary' && (source.kind === 'unknown' || parts.every((part) => ESSAY_KINDS.has(part) || part === 'unknown'))) {
    return true;
  }
  return false;
}

function flagsFor(question: AuditQuestion, grounding: Grounding, sources: SelectedSource[]): string[] {
  const flags: string[] = [];
  if (grounding.mode === 'none') flags.push('NONE');
  if (grounding.evidenceText.length < THIN_CHARS) flags.push('THIN');
  if (question.expectsSpec && !sources.some(sourceIsSpec)) flags.push('NO-SPEC-FOR-MECHANISM');
  if (sources.length > 0 && sources.every(sourceIsEssay)) flags.push('ESSAY-ONLY');
  const words = contentWords(question.question);
  const shares = sources.some((source) => words.some((word) => titleHasWord(source.title, word)));
  if (sources.length > 0 && words.length > 0 && !shares) flags.push('TITLE-MISMATCH');
  return flags;
}

function evidenceHead(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > 180 ? `${collapsed.slice(0, 180)}…` : collapsed;
}

function evidenceRefHighWater(text: string): number {
  let high = 0;
  for (const match of text.matchAll(/\[(\d+)\]/g)) {
    const n = Number(match[1]);
    if (n > high) high = n;
  }
  return high;
}

function selectSources(citations: Citation[], kindFor: (citation: Citation) => string): SelectedSource[] {
  return citations.map((citation, index) => ({
    order: index + 1,
    title: citation.title?.trim() || citation.label?.trim() || '(untitled)',
    kind: kindFor(citation),
    sourceClass: citation.sourceClass ?? 'unknown',
    ...(citation.url ? { url: citation.url } : {}),
  }));
}

async function runOne(
  question: AuditQuestion,
  depth: DepthLabel,
  deps: { mcp: McpBridge; corpus: ReturnType<typeof loadCorpus>; curated: ReturnType<typeof loadCuratedReference> },
  tape: ReturnType<typeof instrument>,
): Promise<AuditRun> {
  tape.reset();
  const started = Date.now();
  try {
    const grounding = await groundQuestion(
      question.question,
      deps,
      {
        originalQuestion: question.question,
        rng: AUDIT_RNG,
        ...(depth === 'standard' ? {} : { depth }),
      },
    );
    const sources = selectSources(grounding.citations, tape.kindFor);
    const shared = sharedWords(question.question, sources, true);
    return {
      id: question.id,
      category: question.category,
      question: question.question,
      depth,
      expectsSpec: question.expectsSpec,
      mode: grounding.mode,
      citationCount: sources.length,
      evidenceChars: grounding.evidenceText.length,
      flags: flagsFor(question, grounding, sources),
      sources,
      sharedTitleWords: shared,
      distinctiveSharedWords: shared.filter((word) => !GENERIC_TITLE_WORDS.has(word)),
      specLeads: sources.length > 0 && sourceIsSpec(sources[0]!),
      evidenceRefHighWater: evidenceRefHighWater(grounding.evidenceText),
      evidenceHead: evidenceHead(grounding.evidenceText),
      ...(grounding.leadAngle ? { leadAngle: grounding.leadAngle } : {}),
      observedCalls: tape.calls(),
      durationMs: Date.now() - started,
      evidenceText: grounding.evidenceText,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      id: question.id,
      category: question.category,
      question: question.question,
      depth,
      expectsSpec: question.expectsSpec,
      mode: 'error',
      citationCount: 0,
      evidenceChars: 0,
      flags: ['NONE', 'THIN'],
      sources: [],
      sharedTitleWords: [],
      distinctiveSharedWords: [],
      specLeads: false,
      evidenceRefHighWater: 0,
      evidenceHead: '',
      observedCalls: tape.calls(),
      durationMs: Date.now() - started,
      evidenceText: '',
      error: message,
    };
  }
}

function formatSource(source: SelectedSource): string {
  const title = source.title.length > 96 ? `${source.title.slice(0, 96)}…` : source.title;
  return `  ${source.order}. ${source.sourceClass}/${source.kind} — ${title}`;
}

function printRun(run: AuditRun, index: number, total: number): void {
  const flags = run.flags.length > 0 ? run.flags.join(',') : '-';
  console.log(
    `\n[${index}/${total}] ${run.id} ${run.depth}  mode=${run.mode}  cites=${run.citationCount}  chars=${run.evidenceChars}  flags=${flags}`,
  );
  console.log(`  ${run.question}`);
  if (run.sources.length === 0) console.log('  (no selected sources)');
  for (const source of run.sources) console.log(formatSource(source));
  if (run.error) console.log(`  error: ${run.error}`);
}

interface FlagCounts {
  questions: number;
  THIN: number;
  NONE: number;
  'ESSAY-ONLY': number;
  'NO-SPEC-FOR-MECHANISM': number;
  'TITLE-MISMATCH': number;
  clean: number;
}

function countFlags(runs: AuditRun[]): FlagCounts {
  const has = (flag: string) => runs.filter((run) => run.flags.includes(flag)).length;
  return {
    questions: runs.length,
    THIN: has('THIN'),
    NONE: has('NONE'),
    'ESSAY-ONLY': has('ESSAY-ONLY'),
    'NO-SPEC-FOR-MECHANISM': has('NO-SPEC-FOR-MECHANISM'),
    'TITLE-MISMATCH': has('TITLE-MISMATCH'),
    clean: runs.filter((run) => run.flags.length === 0).length,
  };
}

function severity(run: AuditRun): number {
  let score = 0;
  if (run.flags.includes('NONE') || run.mode === 'error') score += 1000;
  else if (run.flags.includes('THIN')) score += 400;
  if (run.flags.includes('TITLE-MISMATCH')) score += 350;
  if (run.flags.includes('NO-SPEC-FOR-MECHANISM')) score += 300;
  if (run.flags.includes('ESSAY-ONLY')) score += 250;
  if (run.expectsSpec && run.sources.length > 0 && !run.specLeads && run.sources.some(sourceIsSpec)) score += 80;
  if (run.sources.length > 0 && run.distinctiveSharedWords.length === 0 && !run.flags.includes('NONE')) score += 60;
  if (!run.flags.includes('NONE')) score += Math.max(0, THIN_CHARS - run.evidenceChars) / 50;
  return score;
}

async function main(): Promise<number> {
  let entry: string;
  try {
    entry = resolveMcpEntry();
  } catch (err) {
    console.error(
      `[retrieval-audit] Could not resolve the bsv-aio-mcp entry point. ${err instanceof Error ? err.message : err}`,
    );
    console.error('[retrieval-audit] Tried require.resolve("bsv-aio-mcp/package.json") from server/src, then the package bin and server/dist/index.mjs.');
    return 1;
  }

  const mcp = new McpBridge();
  console.log(`[retrieval-audit] connecting MCP child: ${entry}`);
  console.log('[retrieval-audit] first boot builds the SQLite index and can take several minutes.');
  const connectStarted = Date.now();
  try {
    await mcp.connect();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[retrieval-audit] MCP connect failed. Grounding was not run.');
    console.error(`[retrieval-audit] entry: ${entry}`);
    console.error(`[retrieval-audit] error: ${message}`);
    if (mcp.lastConnectError && mcp.lastConnectError !== message) {
      console.error(`[retrieval-audit] lastConnectError: ${mcp.lastConnectError}`);
    }
    console.error(
      '[retrieval-audit] Tried McpBridge.connect() exactly as src/index.ts does (node + the resolved entry, BSV_AIO_DB_PATH / BSV_AIO_ROOT forwarded when set). No BSV_AIO_DB_PATH was required; the child defaults to a temp index.',
    );
    await mcp.close().catch(() => undefined);
    return 1;
  }
  if (!mcp.connected) {
    console.error('[retrieval-audit] McpBridge.connect() returned but connected is false.');
    console.error(`[retrieval-audit] lastConnectError: ${mcp.lastConnectError ?? '(none)'}`);
    await mcp.close().catch(() => undefined);
    return 1;
  }
  console.log(`[retrieval-audit] MCP connected in ${((Date.now() - connectStarted) / 1000).toFixed(1)}s.`);

  const corpus = loadCorpus();
  const curated = loadCuratedReference();
  if (!corpus) console.warn('[retrieval-audit] Satoshi corpus failed to load — corpus fallback will be empty.');
  if (!curated) console.warn('[retrieval-audit] Curated reference failed to load — dossier, scaling and implementation records will be absent.');

  const tape = instrument(mcp);
  const jobs: { question: AuditQuestion; depth: DepthLabel }[] = [];
  for (const question of QUESTIONS) {
    jobs.push({ question, depth: 'standard' });
    if (question.multiDepth) {
      jobs.push({ question, depth: 'developer' });
      jobs.push({ question, depth: 'historian' });
    }
  }

  const runs: AuditRun[] = [];
  const deps = { mcp, corpus, curated };
  try {
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i]!;
      const run = await runOne(job.question, job.depth, deps, tape);
      runs.push(run);
      printRun(run, i + 1, jobs.length);
    }
  } finally {
    await mcp.close().catch(() => undefined);
  }

  const standard = runs.filter((run) => run.depth === 'standard');
  const standardCounts = countFlags(standard);
  const allCounts = countFlags(runs);
  const byCategory: Record<string, FlagCounts> = {};
  for (const category of [...new Set(standard.map((run) => run.category))]) {
    byCategory[category] = countFlags(standard.filter((run) => run.category === category));
  }

  const worst = [...standard].sort((a, b) => severity(b) - severity(a) || a.evidenceChars - b.evidenceChars).slice(0, 10);

  const multiIds = QUESTIONS.filter((question) => question.multiDepth).map((question) => question.id);
  const depthCompare = multiIds.map((id) => {
    const rows = runs.filter((run) => run.id === id);
    const pick = (depth: DepthLabel) => rows.find((run) => run.depth === depth);
    const brief = (run: AuditRun | undefined) =>
      run
        ? {
            flags: run.flags,
            mode: run.mode,
            cites: run.citationCount,
            chars: run.evidenceChars,
            lead: run.sources[0] ? `${run.sources[0].sourceClass}/${run.sources[0].kind}: ${run.sources[0].title}` : null,
          }
        : null;
    return {
      id,
      question: rows[0]?.question ?? id,
      standard: brief(pick('standard')),
      developer: brief(pick('developer')),
      historian: brief(pick('historian')),
    };
  });

  const expectsSpec = standard.filter((run) => run.expectsSpec);
  const specSummary = {
    expectsSpec: expectsSpec.length,
    noSpecFlag: expectsSpec.filter((run) => run.flags.includes('NO-SPEC-FOR-MECHANISM')).length,
    specLeads: expectsSpec.filter((run) => run.specLeads).length,
    specPresentButNotLeading: expectsSpec.filter((run) => !run.specLeads && run.sources.some(sourceIsSpec)).length,
  };

  const report = {
    ranAt: new Date().toISOString(),
    mcpEntry: entry,
    corpusLoaded: corpus !== null,
    curatedLoaded: curated !== null,
    note: 'standard omits RetrievalPlan.depth, which is the production default. No query-understanding LLM pass was run, so there are no rewrite variants.',
    questions: QUESTIONS.length,
    runs: runs.length,
    standardCounts,
    allRunCounts: allCounts,
    byCategory,
    specSummary,
    worst: worst.map((run) => ({
      id: run.id,
      question: run.question,
      category: run.category,
      severity: severity(run),
      flags: run.flags,
      mode: run.mode,
      citationCount: run.citationCount,
      evidenceChars: run.evidenceChars,
      sources: run.sources,
    })),
    depthCompare,
    results: runs,
  };

  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  console.log('\n=== standard-depth flag counts (one row per question) ===');
  console.log(JSON.stringify(standardCounts, null, 2));
  console.log('\n=== by category ===');
  console.log(JSON.stringify(byCategory, null, 2));
  console.log('\n=== spec-expectation summary ===');
  console.log(JSON.stringify(specSummary, null, 2));
  console.log('\n=== 10 worst (standard) ===');
  for (const run of worst) {
    console.log(
      `${run.id}  sev=${severity(run)}  flags=${run.flags.join(',') || '-'}  chars=${run.evidenceChars}  ${run.question}`,
    );
    for (const source of run.sources) console.log(formatSource(source));
  }
  console.log(`\n[retrieval-audit] wrote ${REPORT_PATH}`);
  console.log('AUDIT_DONE');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[retrieval-audit] unexpected failure:', err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
  });
