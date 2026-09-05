/**
 * Offline eval harness for the Ask Satoshi answer pipeline. Replicates the /api/chat
 * handler in src/index.ts faithfully, minus HTTP/SSE: query understanding → grounding
 * (MCP → corpus → curated reference) → grounded runChain answer → rubric assertions.
 *
 * Usage (from server/):
 *   npx tsx scripts/eval.ts                      # run all cases in eval-questions.json
 *   npx tsx scripts/eval.ts --only id1,id2       # run a subset
 *   npx tsx scripts/eval.ts --out <path>         # override the report path
 *
 * The five `builder` cases encode DESIRED future behaviour and may fail; the seven
 * non-builder guards encode CURRENT behaviour and must pass. The exit code is driven
 * by the guards alone: 0 when every guard passes, 1 otherwise.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Mirror src/index.ts exactly: repo-root .env first, then server/.env overriding.
// From server/scripts, '../../.env' is the repo root and '../.env' is server/ — the
// same targets index.ts resolves from server/src.
dotenv.config({ path: resolve(__dirname, '../../.env') });
dotenv.config({ path: resolve(__dirname, '../.env'), override: true });

import { Breaker } from '../src/breaker.js';
import { loadCuratedReference } from '../src/curatedReference.js';
import { runChain } from '../src/llm.js';
import { McpBridge } from '../src/mcp.js';
import { eligibleTiers, evidenceBudgetFor, type ProviderKeys } from '../src/models.config.js';
import {
  buildSystemPrompt,
  buildUserContent,
  groundQuestion,
  pickStyleSeed,
  questionClass,
  type Grounding,
} from '../src/orchestrate.js';
import {
  buildQueryUnderstandingRequest,
  parseQueryUnderstanding,
  shouldSkipRewrite,
  type QueryUnderstanding,
} from '../src/queryUnderstanding.js';
import { loadCorpus, type SatoshiCorpus } from '../src/satoshiCorpus.js';
import type { CuratedReference } from '../src/curatedReference.js';

/** Same bound as index.ts: the rewrite gates grounding, so it must stay cheap. */
const REWRITE_TIMEOUT_MS = 6_000;

// ---------------------------------------------------------------------------
// Case file + report shapes
// ---------------------------------------------------------------------------

interface Expectation {
  mustMention: string[];
  mustNotMention: string[];
  minChars: number;
  builder: boolean;
}

interface EvalCase {
  id: string;
  question: string;
  expect: Expectation;
}

interface AssertionResult {
  kind: 'mustMention' | 'mustNotMention' | 'minChars' | 'grounding' | 'error';
  target: string;
  pass: boolean;
  detail: string;
}

interface CaseResult {
  id: string;
  question: string;
  builder: boolean;
  pass: boolean;
  assertions: AssertionResult[];
  failedAssertions: string[];
  tierId: string | null;
  mode: Grounding['mode'] | null;
  citations: number;
  /** True when the evidence block carries the IMPLEMENTATION OPTIONS section. */
  optionsSection: boolean;
  answerChars: number;
  durationMs: number;
  answer: string;
  error?: string;
}

interface EvalReport {
  ranAt: string;
  cases: CaseResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    builderPassed: number;
    builderTotal: number;
    guardPassed: number;
    guardTotal: number;
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { only: string[] | null; out: string } {
  let only: string[] | null = null;
  let out = resolve(__dirname, 'eval-report.json');
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--only') {
      const v = argv[++i];
      if (v) only = v.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a.startsWith('--only=')) {
      only = a.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a === '--out') {
      const v = argv[++i];
      if (v) out = resolve(process.cwd(), v);
    } else if (a.startsWith('--out=')) {
      out = resolve(process.cwd(), a.slice('--out='.length));
    }
  }
  return { only, out };
}

function loadCases(): EvalCase[] {
  const path = resolve(__dirname, 'eval-questions.json');
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!Array.isArray(raw)) throw new Error(`${path} must contain a JSON array`);
  return raw.map((entry, i) => {
    const c = entry as Partial<EvalCase>;
    if (typeof c.id !== 'string' || typeof c.question !== 'string') {
      throw new Error(`case #${i + 1} in ${path} is missing id/question`);
    }
    const e = (c.expect ?? {}) as Partial<Expectation>;
    return {
      id: c.id,
      question: c.question,
      expect: {
        mustMention: Array.isArray(e.mustMention) ? e.mustMention : [],
        mustNotMention: Array.isArray(e.mustNotMention) ? e.mustNotMention : [],
        minChars: typeof e.minChars === 'number' ? e.minChars : 0,
        builder: e.builder === true,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Pipeline context shared across cases
// ---------------------------------------------------------------------------

interface Pipeline {
  keys: ProviderKeys;
  breaker: Breaker;
  mcp: McpBridge | null;
  corpus: SatoshiCorpus | null;
  curated: CuratedReference | null;
}

/**
 * Query-understanding pass, mirroring index.ts: skipped for courtesies and strong
 * protocol identifiers, bounded by a tight timeout, fail-open on any error. (The
 * production handler's constrained-mode skip and rewrite cache are request-serving
 * concerns; each eval question is asked once, so they are omitted here.)
 */
async function understand(question: string, p: Pipeline): Promise<QueryUnderstanding | undefined> {
  if (shouldSkipRewrite(question)) return undefined;
  try {
    const req = buildQueryUnderstandingRequest(question, []);
    const res = await Promise.race([
      runChain(
        { system: req.system, history: [], userContent: req.userContent },
        { keys: p.keys, breaker: p.breaker, onDelta: () => undefined },
      ).catch(() => null),
      new Promise<null>((resolveRace) => setTimeout(() => resolveRace(null), REWRITE_TIMEOUT_MS)),
    ]);
    if (!res) return undefined;
    return parseQueryUnderstanding(res.text, question);
  } catch {
    return undefined;
  }
}

async function runCase(c: EvalCase, p: Pipeline): Promise<CaseResult> {
  const started = Date.now();
  const assertions: AssertionResult[] = [];
  let tierId: string | null = null;
  let mode: Grounding['mode'] | null = null;
  let citations = 0;
  let optionsSection = false;
  let answer = '';
  let error: string | undefined;

  try {
    // a/b. Query understanding, then grounding on the (possibly rewritten) query.
    const understanding = await understand(c.question, p);
    const retrievalQuery = understanding?.query ?? c.question;
    const grounding = await groundQuestion(
      retrievalQuery,
      { mcp: p.mcp, corpus: p.corpus, curated: p.curated },
      { variants: understanding?.variants, originalQuestion: c.question },
    );
    mode = grounding.mode;
    citations = grounding.citations.length;
    optionsSection = grounding.evidenceText.includes('IMPLEMENTATION OPTIONS');

    // c. Fail closed, exactly like production's no-knowledge reply.
    if (grounding.mode === 'none') {
      assertions.push({
        kind: 'grounding',
        target: 'mode != none',
        pass: false,
        detail: 'no grounding (production would answer with the no-knowledge line)',
      });
    } else {
      // d. Answer on the first usable tier, with the same prompt assembly as the handler.
      const firstUsable = eligibleTiers(p.keys, false).find((t) => p.breaker.isUsable(t.id));
      const result = await runChain(
        {
          system: buildSystemPrompt(grounding.mode, grounding, {
            questionClass: questionClass(c.question),
            styleSeed: pickStyleSeed(),
            evidenceChars: evidenceBudgetFor(firstUsable),
          }),
          history: [],
          userContent: buildUserContent(c.question, grounding),
        },
        { keys: p.keys, breaker: p.breaker, onDelta: () => undefined },
      );
      tierId = result.tierId;
      answer = result.text;

      // e. Rubric assertions (case-insensitive substring; minChars on trimmed length).
      const lower = answer.toLowerCase();
      for (const m of c.expect.mustMention) {
        const pass = lower.includes(m.toLowerCase());
        assertions.push({
          kind: 'mustMention',
          target: m,
          pass,
          detail: pass ? `mentions "${m}"` : `answer never mentions "${m}"`,
        });
      }
      for (const m of c.expect.mustNotMention) {
        const pass = !lower.includes(m.toLowerCase());
        assertions.push({
          kind: 'mustNotMention',
          target: m,
          pass,
          detail: pass ? `avoids "${m}"` : `forbidden mention of "${m}"`,
        });
      }
      if (c.expect.minChars > 0) {
        const trimmed = answer.trim().length;
        const pass = trimmed >= c.expect.minChars;
        assertions.push({
          kind: 'minChars',
          target: String(c.expect.minChars),
          pass,
          detail: pass ? `${trimmed} chars >= ${c.expect.minChars}` : `${trimmed} chars < ${c.expect.minChars}`,
        });
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    assertions.push({ kind: 'error', target: 'no exception', pass: false, detail: error.slice(0, 300) });
  }

  const failedAssertions = assertions.filter((a) => !a.pass).map((a) => `${a.kind}(${a.target}): ${a.detail}`);
  return {
    id: c.id,
    question: c.question,
    builder: c.expect.builder,
    pass: failedAssertions.length === 0,
    assertions,
    failedAssertions,
    tierId,
    mode,
    citations,
    optionsSection,
    answerChars: answer.trim().length,
    durationMs: Date.now() - started,
    answer,
    ...(error ? { error } : {}),
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function printTable(results: CaseResult[]): void {
  const rows = results.map((r) => [
    r.id,
    r.pass ? 'PASS' : 'FAIL',
    r.tierId ?? '-',
    r.mode ?? '-',
    r.optionsSection ? 'yes' : 'no',
    r.failedAssertions.length ? r.failedAssertions.join('; ') : '-',
  ]);
  const header = ['id', 'status', 'tier', 'mode', 'options', 'failed assertions'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cols: string[]) => cols.map((col, i) => (col ?? '').padEnd(widths[i]!)).join('  ');
  console.log(`\n${line(header)}`);
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(r));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const { only, out } = parseArgs(process.argv.slice(2));

  const keys: ProviderKeys = {
    gemini: process.env.GEMINI_API_KEY || undefined,
    groq: process.env.GROQ_API_KEY || undefined,
    openrouter: process.env.OPENROUTER_API_KEY || undefined,
  };
  const configured = (['gemini', 'groq', 'openrouter'] as const).filter((k) => keys[k]);
  if (configured.length === 0) {
    console.error(
      '[eval] No provider API keys found. Expected GEMINI_API_KEY / GROQ_API_KEY / ' +
        'OPENROUTER_API_KEY in the repo-root .env or server/.env — refusing to run.',
    );
    return 1;
  }
  console.log(`[eval] providers configured: ${configured.join(', ')}`);

  let cases = loadCases();
  if (only) {
    const known = new Set(cases.map((c) => c.id));
    const missing = only.filter((id) => !known.has(id));
    if (missing.length > 0) console.warn(`[eval] unknown --only id(s) ignored: ${missing.join(', ')}`);
    cases = cases.filter((c) => only.includes(c.id));
  }
  if (cases.length === 0) {
    console.error('[eval] no cases to run.');
    return 1;
  }

  const pipeline: Pipeline = {
    keys,
    breaker: new Breaker(),
    mcp: null,
    corpus: loadCorpus(),
    curated: loadCuratedReference(),
  };

  const bridge = new McpBridge();
  try {
    console.log('[eval] connecting MCP child (first boot can take minutes — SQLite ingest)…');
    await bridge.connect();
    pipeline.mcp = bridge;
    console.log('[eval] MCP connected.');
  } catch (err) {
    console.warn(
      `[eval] MCP connect failed — grounding degrades to corpus: ${err instanceof Error ? err.message : err}`,
    );
  }

  const runStarted = Date.now();
  const results: CaseResult[] = [];
  try {
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i]!;
      console.log(`\n[${i + 1}/${cases.length}] ${c.id} — "${c.question}"`);
      const result = await runCase(c, pipeline);
      results.push(result);
      console.log(
        `    ${result.pass ? 'PASS' : 'FAIL'} in ${(result.durationMs / 1000).toFixed(1)}s` +
          ` — tier=${result.tierId ?? '-'} mode=${result.mode ?? '-'} options=${result.optionsSection ? 'yes' : 'no'}` +
          (result.failedAssertions.length ? ` — failed: ${result.failedAssertions.join('; ')}` : ''),
      );
    }
  } finally {
    await bridge.close().catch(() => undefined);
  }

  printTable(results);

  const builderResults = results.filter((r) => r.builder);
  const guardResults = results.filter((r) => !r.builder);
  const report: EvalReport = {
    ranAt: new Date().toISOString(),
    cases: results,
    summary: {
      total: results.length,
      passed: results.filter((r) => r.pass).length,
      failed: results.filter((r) => !r.pass).length,
      builderPassed: builderResults.filter((r) => r.pass).length,
      builderTotal: builderResults.length,
      guardPassed: guardResults.filter((r) => r.pass).length,
      guardTotal: guardResults.length,
    },
  };
  writeFileSync(out, JSON.stringify(report, null, 2));

  const s = report.summary;
  console.log(
    `\n[eval] ${s.passed}/${s.total} passed in ${((Date.now() - runStarted) / 1000).toFixed(0)}s` +
      ` — guards ${s.guardPassed}/${s.guardTotal}, builder aspirations ${s.builderPassed}/${s.builderTotal}`,
  );
  console.log(`[eval] report written to ${out}`);

  const failedGuards = s.guardTotal - s.guardPassed;
  return failedGuards > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[eval] fatal:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
