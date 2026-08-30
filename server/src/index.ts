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
import { Breaker } from './breaker.js';
import { AnswerCache } from './cache.js';
import { SLEEP_LINES, WITTY, witty, WittyException, type ErrorCode } from './errors.js';
import { runChain, type ChainRequest } from './llm.js';
import { McpBridge } from './mcp.js';
import { configuredTiers, type ProviderKeys } from './models.config.js';
import {
  buildSystemPrompt,
  buildUserContent,
  groundQuestion,
  pickStyleSeed,
  questionClass,
} from './orchestrate.js';
import { loadCorpus } from './satoshiCorpus.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Prefer the repo-root .env (documented location); allow server/.env to override.
dotenv.config({ path: resolve(__dirname, '../../.env') });
dotenv.config({ path: resolve(__dirname, '../.env'), override: true });

const PORT = Number(process.env.PORT ?? 8787);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN ?? 'http://localhost:5173')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const MAX_HISTORY_MESSAGES = 10;
const MAX_HISTORY_CHARS = 12_000;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/** Max length of a single user message. Generous — Gemini's context window is huge. */
const MAX_QUESTION_CHARS = 8_000;

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
const mcp = new McpBridge();
const corpus = loadCorpus();

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
app.use(
  helmet({
    // Content-Security-Policy: the SPA is self-contained (bundled JS/CSS, no CDN), so we
    // can run a strict policy. Images may be blob:/data: (local previews + inline assets);
    // the API is same-origin. No inline scripts or eval — React's production build needs neither.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"], // Vite injects critical CSS; React inline styles
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: null, // allow plain http on localhost dev
      },
    },
    crossOriginEmbedderPolicy: false, // would break blob: image previews
  }),
);
app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json({ limit: '8mb' }));

const wittyRateMessage = { error: { code: 'RATE_LIMITED', message: WITTY.RATE_LIMITED } };
const minuteLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: wittyRateMessage,
});
const dayLimiter = rateLimit({
  windowMs: 24 * 3_600_000,
  limit: 40,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: wittyRateMessage,
});

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
  res.json({ ok: true, mcp: mcp.connected, corpus: corpus !== null });
});

// ---------------------------------------------------------------------------
// Chat (SSE)
// ---------------------------------------------------------------------------

function sseWrite(res: express.Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

app.post('/api/chat', minuteLimiter, dayLimiter, async (req, res) => {
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

  // If the MCP child is still waking up, tell the client and give it a short window
  // before we fall back to the corpus. This keeps the first answer after idle grounded
  // without ever hanging the request.
  if (!mcp.connected) {
    sseWrite(res, 'status', { phase: 'warming' });
    await mcp.waitUntilConnected();
  }

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
    const retrievalQuery = contextualQuery(question, priorUser);
    const grounding = await groundQuestion(retrievalQuery, { mcp, corpus });
    if (grounding.mode === 'none') {
      sseWrite(res, 'delta', { text: WITTY.NO_KNOWLEDGE });
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

    const result = await runChain(
      {
        system: buildSystemPrompt(grounding.mode, grounding, {
          questionClass: questionClass(question),
          styleSeed: pickStyleSeed(),
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

    if (cacheable) {
      cache.set(question, { text: result.text, mode: grounding.mode, citations: grounding.citations });
    }
    sseWrite(res, 'meta', { mode: grounding.mode, citations: grounding.citations, tier: result.tierId });
    sseWrite(res, 'done', {});
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

// On Vercel the module is imported as a function handler — listening is the platform's
// job. Everywhere else (npm start, tsx dev) we bind the port ourselves.
if (!process.env.VERCEL) {
  const httpServer = app.listen(PORT, () => {
    const tiers = configuredTiers(keys).map((t) => t.id);
    console.log(`[ask-satoshi] listening on :${PORT}`);
    console.log(`[ask-satoshi] model tiers configured: ${tiers.length > 0 ? tiers.join(', ') : 'NONE (set API keys in .env)'}`);
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
