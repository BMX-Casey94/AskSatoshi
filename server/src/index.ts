/**
 * Ask Satoshi — API server. Serves the chat endpoint (SSE), the awake/asleep status
 * endpoint, and the built client in production. No accounts, no chat persistence:
 * the only state held server-side is the quota breaker and the answer cache.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import {
  buildCritiqueRequest,
  buildRevisionRequest,
  forbiddenTechLint,
  parseCritique,
} from './answerCritique.js';
import { Breaker } from './breaker.js';
import { AnswerCache } from './cache.js';
import { noKnowledgeLine, SLEEP_LINES, WITTY, witty, WittyException, type ErrorCode } from './errors.js';
import { runChain, type ChainRequest } from './llm.js';
import { McpBridge } from './mcp.js';
import { configuredTiers, eligibleTiers, evidenceBudgetFor, type ProviderKeys } from './models.config.js';
import {
  buildCitationFilter,
  buildSystemPrompt,
  buildUserContent,
  filterUnusedCitations,
  groundQuestion,
  parseCitationFilter,
  pickInvitationSeed,
  pickStyleSeed,
  questionClass,
} from './orchestrate.js';
import {
  buildQueryUnderstandingRequest,
  parseQueryUnderstanding,
  rewriteCacheKey,
  RewriteCache,
  shouldSkipRewrite,
  type QueryUnderstanding,
} from './queryUnderstanding.js';
import { getActivity } from './satoshiActivity.js';
import { helmetOptions } from './security.js';
import { loadCorpus } from './satoshiCorpus.js';
import { loadCuratedReference } from './curatedReference.js';
import { assembleTts, ttsStartupLine } from './tts/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Prefer the repo-root .env (documented location); allow server/.env to override.
dotenv.config({ path: resolve(__dirname, '../../.env') });
dotenv.config({ path: resolve(__dirname, '../.env'), override: true });

const PORT = Number(process.env.PORT ?? 8787);
// Bind address. Default 0.0.0.0 (all interfaces) preserves direct-hosting behaviour;
// set HOST=127.0.0.1 when behind a same-host reverse proxy (Caddy/nginx) so the app
// port is unreachable from the public internet except through the proxy's TLS.
const HOST = process.env.HOST ?? '0.0.0.0';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN ?? 'http://localhost:5173')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const MAX_HISTORY_MESSAGES = 10;
const MAX_HISTORY_CHARS = 12_000;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/** Max length of a single user message. Generous — Gemini's context window is huge. */
const MAX_QUESTION_CHARS = 8_000;
/**
 * Bound on the query-understanding pass. It gates grounding, so it must stay cheap:
 * on timeout the request fails open to the deterministic regex path below.
 */
const REWRITE_TIMEOUT_MS = 6_000;
/**
 * Bounds on the post-answer review pass. The answer is already with the user when
 * these run, so they only delay stream close — but a hung provider must never hold
 * the connection. Both fail open to the original answer.
 */
const CRITIQUE_TIMEOUT_MS = 8_000;
const REVISION_TIMEOUT_MS = 20_000;
/** Answers shorter than this have nothing worth reviewing (courtesies, one-liners). */
const MIN_REVIEWABLE_ANSWER_CHARS = 300;

/** Heuristic: is this message a short follow-up that needs the prior question for context? */
function isFollowUp(text: string): boolean {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 6) return false;
  return /\b(it|that|this|they|them|he|she|why|how|what about|and|but|so|more|else|again)\b/i.test(text);
}

/** Build a standalone retrieval query: follow-ups are anchored to the previous user question. */
function contextualQuery(question: string, priorUser: string | undefined): string {
  if (!priorUser || !isFollowUp(question)) return question;
  return `${priorUser} — ${question}`;
}

const keys: ProviderKeys = {
  gemini: process.env.GEMINI_API_KEY || undefined,
  groq: process.env.GROQ_API_KEY || undefined,
  openrouter: process.env.OPENROUTER_API_KEY || undefined,
};

const breaker = new Breaker();
const cache = new AnswerCache();
const rewriteCache = new RewriteCache();
const mcp = new McpBridge();
const corpus = loadCorpus();
const curated = loadCuratedReference();
const tts = assembleTts();

/**
 * When a warm-up wait last timed out. A child that cannot come up (e.g. a frozen
 * serverless invocation) must not tax every chat request with the warm-up wait —
 * after a miss we go straight to the corpus for a minute before trying again.
 */
let warmupMissedAt = 0;
const WARMUP_SKIP_MS = 60_000;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const imageSchema = z.object({
  data: z
    .string()
    .max(6_000_000)
    .regex(/^[A-Za-z0-9+/=\r\n]+$/, 'invalid base64'),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
});

// User messages are capped; assistant history turns are longer (full answers), so
// they get a higher ceiling. The 2,000-char user cap is enforced on the latest turn.
const chatBodySchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().min(1).max(MAX_QUESTION_CHARS),
      }),
    )
    .min(1)
    .max(40),
  image: imageSchema.optional(),
});

// ---------------------------------------------------------------------------
// App wiring
// ---------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');
// Vercel always sits behind its proxy; elsewhere TRUST_PROXY=1 opts in explicitly.
app.set('trust proxy', process.env.TRUST_PROXY === '1' || process.env.VERCEL ? 1 : false);
// Security headers (CSP included) live in security.ts — the connect-src list there
// is what lets desktop browsers reach BRC-100 wallets on localhost.
app.use(helmet(helmetOptions));
app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json({ limit: '8mb' }));

// Anti-abuse burst ceiling only. The paid OpenRouter primary carries the traffic now,
// so the old free-quota guards (10/min, 40/day per IP) are gone; what remains is a
// generous per-IP limit no human chatter will hit, to blunt scripted spend against
// the paid key. RATE_LIMIT_PER_MIN overrides the default; 0 disables it entirely.
const parsedBurstLimit = Number(process.env.RATE_LIMIT_PER_MIN || 60);
const BURST_LIMIT_PER_MIN =
  Number.isFinite(parsedBurstLimit) && parsedBurstLimit >= 0 ? parsedBurstLimit : 60;
const burstLimiter = rateLimit({
  windowMs: 60_000,
  limit: BURST_LIMIT_PER_MIN,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: WITTY.RATE_LIMITED } },
});
const chatGuards: express.RequestHandler[] = BURST_LIMIT_PER_MIN > 0 ? [burstLimiter] : [];

// ---------------------------------------------------------------------------
// Status + health
// ---------------------------------------------------------------------------

function serviceStatus() {
  const ids = configuredTiers(keys).map((t) => t.id);
  const st = breaker.status(ids);
  return { ...st, sleepLines: SLEEP_LINES };
}

app.get('/api/status', (_req, res) => {
  res.json(serviceStatus());
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    mcp: mcp.connected,
    corpus: corpus !== null,
    curated: curated !== null,
    // Diagnostic only — helps explain a down MCP on serverless without leaking internals.
    mcpError: mcp.connected ? null : mcp.lastConnectError,
  });
});

app.get('/api/satoshi-activity', (_req, res) => {
  res.json(getActivity());
});

// ---------------------------------------------------------------------------
// Chat (SSE)
// ---------------------------------------------------------------------------

function sseWrite(res: express.Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

app.post('/api/chat', chatGuards, async (req: express.Request, res: express.Response) => {
  const parsed = chatBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: witty('BAD_INPUT') });
    return;
  }
  const { messages, image } = parsed.data;

  if (image && Buffer.byteLength(image.data, 'base64') > MAX_IMAGE_BYTES) {
    res.status(400).json({ error: witty('IMAGE_REJECTED') });
    return;
  }

  const question = messages[messages.length - 1]?.content ?? '';
  if (!question.trim() || question.length > MAX_QUESTION_CHARS) {
    res.status(400).json({ error: witty('BAD_INPUT') });
    return;
  }

  // Asleep before we spend anything.
  const preStatus = serviceStatus();
  if (preStatus.state === 'asleep') {
    res.status(503).json({ error: witty('EXHAUSTED', preStatus.retryAfter) });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const controller = new AbortController();
  req.on('close', () => controller.abort());
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
  const finish = () => {
    clearInterval(heartbeat);
    res.end();
  };

  const sendError = (code: ErrorCode, retryAfter?: string) => {
    sseWrite(res, 'error', witty(code, retryAfter));
    finish();
  };

  // Prior user question (for contextualising follow-ups) and whether this is a
  // standalone question we may safely cache.
  const priorMessages = messages.slice(0, -1);
  const priorUser = [...priorMessages].reverse().find((m) => m.role === 'user')?.content;
  const standalone = !isFollowUp(question) || priorMessages.length === 0;
  // Contested/opinion questions are never cached as oracles — each ask gets a fresh,
  // freshly-grounded answer rather than the first visitor's phrasing served for hours.
  const cacheable = standalone && !image && questionClass(question) !== 'contested';
  // If this thread already asked the same question, bypass the cache so the user gets a
  // freshly-phrased answer rather than a byte-identical repeat.
  const alreadyAskedInThread = priorMessages.some(
    (m) => m.role === 'user' && AnswerCache.key(m.content) === AnswerCache.key(question),
  );
  const serveFromCache = cacheable && !alreadyAskedInThread;

  try {
    // 1. Cache first — identical standalone questions cost nothing. Follow-ups and
    //    same-thread repeats are never served from cache.
    if (serveFromCache) {
      const cached = cache.get(question);
      if (cached) {
        sseWrite(res, 'delta', { text: cached.text });
        sseWrite(res, 'meta', { mode: cached.mode, citations: cached.citations, cached: true });
        sseWrite(res, 'done', {});
        finish();
        return;
      }
    }

    // 2. Ground the question: MCP snapshot, then Satoshi's own writings. Follow-ups
    //    are retrieved against a contextualised query so pronouns resolve correctly.
    //    If the MCP child is still waking up, tell the client and give it a short window
    //    first — this keeps the first answer after idle grounded without ever hanging
    //    the request. Cached answers above never pay the wait, and a recently timed-out
    //    warm-up is not retried for a minute (see WARMUP_SKIP_MS).
    if (!mcp.connected && Date.now() - warmupMissedAt > WARMUP_SKIP_MS) {
      sseWrite(res, 'status', { phase: 'warming' });
      if (await mcp.waitUntilConnected()) warmupMissedAt = 0;
      else warmupMissedAt = Date.now();
      // Warm-up is over: hand the client back to its normal progress cycle so the
      // warm-up line never outlives the actual wait.
      sseWrite(res, 'status', { phase: 'grounding' });
    }

    // 2a. Query understanding: one small structured pass turns the latest message (plus
    //     the recent conversation) into a standalone retrieval query and a few variant
    //     phrasings in document vocabulary. Retrieval is lexical on both sides (SQLite
    //     FTS in the MCP, BM25 in the corpus), so this bridges the vocabulary gap —
    //     "why did you leave Bitcoin" reaches the essay that says "withdrew from public
    //     view", and "NAR/DAR" reaches "Network Access Rules (NAR)". Best-effort and
    //     fail-open: skipped for strong protocol identifiers and courtesies, cached per
    //     question+context, bounded by a tight timeout; any failure falls back to the
    //     deterministic regex contextualiser.
    const hasKeys = !!(keys.gemini || keys.groq || keys.openrouter);
    // Constrained mode: when two or fewer tiers can take a request right now, spend the
    // scarce quota on the answer alone and skip the auxiliary rewrite/filter calls.
    // Those calls are fail-open enhancements — under a rate squeeze they only multiply
    // token burn and push the answer itself over the per-minute cap.
    const tierIds = configuredTiers(keys).map((t) => t.id);
    const constrained = hasKeys && breaker.usableCount(tierIds) <= 2;
    if (constrained) {
      console.info(
        `[chat] constrained mode (${breaker.usableCount(tierIds)}/${tierIds.length} tiers usable) — skipping rewrite and citation filter`,
      );
    }
    let understanding: QueryUnderstanding | undefined;
    if (hasKeys && !image && !constrained && !shouldSkipRewrite(question)) {
      const cacheKey = rewriteCacheKey(question, priorUser);
      understanding = rewriteCache.get(cacheKey);
      if (!understanding) {
        const rewriteReq = buildQueryUnderstandingRequest(question, priorMessages);
        const rewriteRes = await Promise.race([
          runChain(
            { system: rewriteReq.system, history: [], userContent: rewriteReq.userContent },
            { keys, breaker, signal: controller.signal, onDelta: () => undefined },
          ).catch(() => null),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), REWRITE_TIMEOUT_MS)),
        ]);
        if (rewriteRes) {
          understanding = parseQueryUnderstanding(rewriteRes.text, question, priorUser);
          if (understanding) rewriteCache.set(cacheKey, understanding);
        }
        // Dev-visible trace for tuning the pass: what the question became for retrieval,
        // or why the pass produced nothing (timeout/provider error vs. discarded reply).
        if (understanding) {
          console.info(
            `[rewrite] "${question.slice(0, 80)}" → "${understanding.query}"` +
              (understanding.variants.length ? ` | variants: ${understanding.variants.join(' ‖ ')}` : '') +
              (understanding.followUp ? ' | followUp' : ''),
          );
        } else if (rewriteRes) {
          console.info(
            `[rewrite] discarded "${question.slice(0, 60)}" ← ${rewriteRes.text.replace(/\s+/g, ' ').slice(0, 240)}`,
          );
        } else {
          console.info(`[rewrite] no reply (timeout or provider error) for "${question.slice(0, 60)}"`);
        }
      }
    }

    const retrievalQuery = understanding?.query ?? contextualQuery(question, priorUser);
    const grounding = await groundQuestion(retrievalQuery, { mcp, corpus, curated }, {
      variants: understanding?.variants,
      originalQuestion: question,
      // investigate resolves follow-up references when given the prior turn as context —
      // but only forward it when this message actually is a follow-up, or unrelated
      // prior context would pollute a standalone question's retrieval.
      context: priorUser && (!standalone || understanding?.followUp) ? priorUser : undefined,
    });
    if (grounding.mode === 'none') {
      sseWrite(res, 'delta', { text: noKnowledgeLine(question) });
      sseWrite(res, 'meta', { mode: 'none', citations: [] });
      sseWrite(res, 'done', {});
      finish();
      return;
    }

    // 3. Trim history to stay well under the tightest free-tier TPM (Groq: 8K).
    //    Walk newest-first for the budget, then send chronologically (user/assistant
    //    alternating). Strip stale [n] markers — they referenced a previous turn's sources.
    const stripCites = (s: string) => s.replace(/\[\d{1,2}\]/g, '').replace(/ {2,}/g, ' ');
    const windowed = messages.slice(-MAX_HISTORY_MESSAGES - 1, -1);
    const picked: ChainRequest['history'] = [];
    let chars = 0;
    for (let i = windowed.length - 1; i >= 0; i--) {
      const m = windowed[i]!;
      if (chars + m.content.length > MAX_HISTORY_CHARS) break;
      picked.unshift({ role: m.role, content: stripCites(m.content) });
      chars += m.content.length;
    }

    // Run a strict citation relevance filter in parallel with the answer — it needs only
    // the question and candidate citations, so it adds no latency. Word-sense false
    // positives (a logo post matching "scaling" in the image sense) survive lexical
    // retrieval; this semantic pass rejects them. Best-effort: any error, timeout, or
    // garbled reply fails open to the unfiltered list.
    const filterReq = buildCitationFilter(question, grounding.citations);
    const filterPromise: Promise<{ text: string } | null> =
      filterReq && hasKeys && !image && !constrained
        ? runChain(
            { system: filterReq.system, history: [], userContent: filterReq.userContent },
            { keys, breaker, signal: controller.signal, onDelta: () => undefined },
          ).catch(() => null)
        : Promise.resolve(null);

    // Trim the evidence block when the request is headed for a free tier, so the whole
    // grounded prompt fits under that tier's per-minute token ceiling. Paid tiers (the
    // funded OpenRouter primary) have a 1M context and get the full evidence.
    const firstUsable = eligibleTiers(keys, !!image).find((t) => breaker.isUsable(t.id));
    const evidenceBudget = evidenceBudgetFor(firstUsable);
    // One style seed and one invitation seed for the answer AND any later revision of
    // it — fresh seeds would shift the voice instructions while the revision is told to
    // keep the same voice.
    const styleSeed = pickStyleSeed();
    const invitationSeed = pickInvitationSeed();
    const result = await runChain(
      {
        system: buildSystemPrompt(grounding.mode, grounding, {
          questionClass: questionClass(question),
          styleSeed,
          invitationSeed,
          evidenceChars: evidenceBudget,
        }),
        history: picked,
        userContent: buildUserContent(question, grounding),
        image,
      },
      {
        keys,
        breaker,
        signal: controller.signal,
        onDelta: (text) => sseWrite(res, 'delta', { text }),
      },
    );

    // The filter started in parallel, so by now it is almost always done; the 8s race is
    // just a safety bound so a hung filter never delays the citations.
    const filterRes = await Promise.race([
      filterPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 8_000)),
    ]);
    let citations = grounding.citations;
    if (filterRes) {
      const keep = parseCitationFilter(filterRes.text, citations.length);
      // Apply only a parseable, non-empty result. An empty/all-rejected or garbled result
      // fails open — a grounded answer must have drawn on something, so an empty filter
      // result is treated as a filter miss, not a reason to show zero sources.
      if (keep && keep.length > 0) citations = keep.map((i) => citations[i]!).filter(Boolean);
    }
    // Usage floor: relevance to the question is not usage in the answer. Drop sources
    // the written answer does not reflect (deterministic, fail-open — see the function).
    citations = filterUnusedCitations(result.text, citations);

    sseWrite(res, 'meta', { mode: grounding.mode, citations, tier: result.tierId });
    sseWrite(res, 'done', {});

    // 5. Adversarial review (stream-then-revise). The answer is already with the
    //    user; a reviewer pass now checks it against the evidence — factual fidelity,
    //    forbidden technology, and (for builder questions) whether the best-fit
    //    primitive was chosen — and a revise verdict triggers one rewrite, delivered
    //    as a `revision` event that replaces the streamed text. Fail-open throughout:
    //    any error, timeout or garbled reply ships the original answer. Skipped where
    //    there is nothing worth checking (ungrounded, image, constrained, or trivially
    //    short answers) so the review never burns quota needed by answers.
    let finalText = result.text;
    let finalCitations = citations;
    // (mode 'none' never reaches here — the no-knowledge branch returned already.)
    const reviewable =
      hasKeys && !constrained && !image && result.text.trim().length >= MIN_REVIEWABLE_ANSWER_CHARS;
    if (reviewable) {
      try {
        // Deterministic observability signal alongside the model review — a lint hit
        // is not itself a verdict (mentioning Lightning as critique is legitimate).
        const lint = forbiddenTechLint(result.text);
        if (lint.length > 0) console.info(`[chat] forbidden-tech lint: ${lint.join(', ')}`);

        // The reviewer judges the answer against the evidence AS THE ANSWER MODEL SAW
        // it (same free-tier trim) — flagging an omission against evidence the writer
        // never received would produce unfair revisions.
        const answerEvidence =
          evidenceBudget !== undefined && grounding.evidenceText.length > evidenceBudget
            ? `${grounding.evidenceText.slice(0, evidenceBudget)}…`
            : grounding.evidenceText;
        const cReq = buildCritiqueRequest(question, answerEvidence, result.text);
        let critiqueErr: unknown;
        const cRes = await Promise.race([
          runChain(
            { system: cReq.system, history: [], userContent: cReq.userContent },
            { keys, breaker, signal: controller.signal, onDelta: () => undefined },
          ).catch((e: unknown) => {
            critiqueErr = e;
            return null;
          }),
          new Promise<null>((resolveRace) =>
            setTimeout(() => {
              critiqueErr = critiqueErr ?? new Error(`critique timed out after ${CRITIQUE_TIMEOUT_MS}ms`);
              resolveRace(null);
            }, CRITIQUE_TIMEOUT_MS),
          ),
        ]);
        const critique = cRes ? parseCritique(cRes.text) : undefined;
        if (!critique) {
          const why = cRes
            ? `unparseable reply: ${cRes.text.slice(0, 120).replace(/\s+/g, ' ')}`
            : `call failed: ${critiqueErr instanceof Error ? critiqueErr.message : String(critiqueErr)}`;
          console.info(`[chat] critique: unavailable (${why}) — original answer stands`);
        } else if (critique.verdict === 'pass') {
          console.info('[chat] critique: pass');
        }
        if (critique?.verdict === 'revise') {
          console.info(
            `[chat] critique: revise (${critique.kind ?? 'unclassified'}) — ${critique.issues.join('; ')}`,
          );
          const rReq = buildRevisionRequest(question, result.text, critique);
          const rRes = await Promise.race([
            runChain(
              {
                // Same persona prompt the answer was written under — the revision must
                // stay in voice and grounded in the same evidence.
                system: buildSystemPrompt(grounding.mode, grounding, {
                  questionClass: questionClass(question),
                  styleSeed,
                  invitationSeed,
                  evidenceChars: evidenceBudget,
                }),
                history: picked,
                userContent: rReq.userContent,
              },
              { keys, breaker, signal: controller.signal, onDelta: () => undefined },
            ).catch(() => null),
            new Promise<null>((resolveRace) => setTimeout(() => resolveRace(null), REVISION_TIMEOUT_MS)),
          ]);
          const revised = rRes?.text.trim();
          // Guard: an empty or drastically truncated revision is never an improvement.
          if (revised && revised.length >= Math.floor(result.text.trim().length * 0.5)) {
            finalText = revised;
            // The usage floor was applied to the draft; re-run it against the revision
            // so the sources shown (and cached) match the text actually displayed.
            finalCitations = filterUnusedCitations(finalText, citations);
            sseWrite(res, 'revision', { text: finalText, citations: finalCitations });
          }
        }
      } catch (reviewErr) {
        // Fail open: the original answer stands.
        console.warn('[chat] critique failed:', reviewErr instanceof Error ? reviewErr.message : reviewErr);
      }
    }

    // A message the understanding pass flagged as a follow-up is never cached as a
    // standalone oracle: its answer only makes sense against this conversation. The
    // write happens after the review pass so future visitors are served the revised
    // answer, not the pre-review draft.
    if (cacheable && !understanding?.followUp) {
      cache.set(question, { text: finalText, mode: grounding.mode, citations: finalCitations });
    }
    finish();
  } catch (err) {
    if (err instanceof WittyException) {
      sendError(err.wittyError.code, err.wittyError.retryAfter);
      return;
    }
    if (err instanceof Error && err.message === 'CLIENT_DISCONNECTED') {
      finish();
      return;
    }
    console.error('[chat] unexpected error:', err);
    sendError('PROVIDER_ERROR');
  }
});

app.use('/api/tts', tts.router);

// ---------------------------------------------------------------------------
// Static client (production build)
// ---------------------------------------------------------------------------

// The client builds into the repo-root public/ folder. On Vercel this whole block is
// inert (the CDN serves public/ before requests reach the function); it exists so
// `npm start` keeps serving the SPA on long-running hosts and locally.
const clientDist = join(__dirname, '..', '..', 'public');
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  // Express 5 / path-to-regexp v8: '*' is invalid; a bare middleware is the SPA fallback.
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
    res.sendFile(join(clientDist, 'index.html'));
  });
}

// Last: turn body-parser SyntaxErrors (and anything else uncaught) into witty JSON
// instead of Express's default HTML stack page.
app.use(
  (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof SyntaxError) {
      res.status(400).json({ error: witty('BAD_INPUT') });
      return;
    }
    console.error('[http] unhandled error:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: witty('PROVIDER_ERROR') });
  },
);

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

mcp.connect().catch((err) => {
  console.warn('[mcp] initial connect failed (will retry in background):', err instanceof Error ? err.message : err);
});
console.info(ttsStartupLine(tts));

// On Vercel the module is imported as a function handler — listening is the platform's
// job. Everywhere else (npm start, tsx dev) we bind the port ourselves.
if (!process.env.VERCEL) {
  const httpServer = app.listen(PORT, HOST, () => {
    const tiers = configuredTiers(keys).map((t) => t.id);
    console.log(`[ask-satoshi] listening on ${HOST}:${PORT}`);
    console.log(`[ask-satoshi] model tiers configured: ${tiers.length > 0 ? tiers.join(', ') : 'NONE (set API keys in .env)'}`);
    // Per-provider presence (never the key values) so an empty/misread .env is obvious
    // in the journal. The VPS failure mode is exactly this: keys present in the file
    // but not reaching the process.
    const presence = (['gemini', 'groq', 'openrouter'] as const)
      .map((p) => `${p}=${keys[p] ? 'set' : 'MISSING'}`)
      .join(' ');
    console.log(`[ask-satoshi] provider keys: ${presence}`);
  });

  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[ask-satoshi] port ${PORT} is already in use — stop the other process or set PORT in .env`);
    } else {
      console.error('[ask-satoshi] failed to listen:', err.message);
    }
    process.exit(1);
  });

  process.on('SIGTERM', () => void mcp.close());
  process.on('SIGINT', () => void mcp.close());
}

export default app;
