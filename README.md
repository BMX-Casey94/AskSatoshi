# Ask Satoshi

A free, no-sign-up, ChatGPT-style chatbot that answers Bitcoin questions in the voice of
Satoshi Nakamoto — grounded first in the [BSV-AIO-MCP](https://github.com/BMX-Casey94/BSV-AIO-MCP)
knowledge server (BRCs, Script opcodes, BEEF, Rúnar, the Tier 0 SDKs and the essay corpus),
and falling back to Satoshi's actual historical forum posts and e-mails (pinned from the
[Nakamoto Institute](https://satoshi.nakamotoinstitute.org) archive) when the MCP cannot answer.

Chats are stored **only** in your browser's `localStorage`. There are no accounts, no
server-side chat logs, and no tracking.

## Architecture

```
Browser (Vite + React)                Node.js backend (Express)
┌──────────────────────────┐          ┌────────────────────────────────────────┐
│ Landing / chat UI        │  SSE     │ POST /api/chat                         │
│ localStorage threads     │ ◀──────▶ │   └─▶ orchestrator                     │
│ dictation, image attach  │          │         ├─▶ BSV-AIO-MCP (stdio child)  │
└──────────────────────────┘          │         ├─▶ Satoshi corpus (BM25)      │
                                      │         ├─▶ Curated reference (BM25):  │
                                      │         │   identity / scaling /       │
                                      │         │   implementation records     │
                                      │         └─▶ LLM chain, in order:       │
                                      │             OpenRouter paid primary:   │
                                      │             gemini-3.1-flash-lite →    │
                                      │             deepseek-v4-flash          │
                                      │             Gemini 3.6/3.5 (free)      │
                                      │             Groq gpt-oss-120b (free)   │
                                      │             OpenRouter :free           │
                                      │             then critic (fail-open)    │
                                      │             may send a revision event  │
                                      │ GET /api/status (awake / asleep)       │
                                      └────────────────────────────────────────┘
```

The MCP server is stdio-only, so the backend starts it as a child process and speaks to it
with the official MCP SDK. On a long-running host that child stays up. On Vercel it is
started when an instance wakes and is gone again after idle — when it is not ready, answers
fall back to Satoshi's own writings. All model API keys stay server-side.

Three curated reference files under `server/data/` anchor specific topics whatever the
retrieval path returns: `identity-dossier.json` (third-party testimony, documented events
and public curiosities bearing on the Satoshi identity question — identity answers are
grounded here, never in "possession of a key is proof" logic) and `scaling-record.json`
(the demonstrated-capacity record for scaling/Teranode questions: the 1M TPS sustained
trial and the 79.09 billion TPS fleet measurement, always quoted with conditions) and
`implementation-record.json` (the BSV-only builder stack: BRC-100, native script,
OP_RETURN, SPV/BEEF, `@bsv/sdk` and a BitGenius.net pointer, plus a decision table that
prefers the native opcode for simple builds and escalates to a contract language only
when the question outgrows m-of-n — Taproot/SegWit/Lightning are never prescribed as
something to implement).
Conceptual questions are blended essay-first: the later essays and article summaries are
the primary lens, with the 2008–2011 posts and e-mails seasoning the answer.
Builder questions retrieve an option set of protocol primitives (with a second hop for
specs the commentary named), prepend that decision table, and answer with one firm
recommendation plus the condition under which an alternative wins. Compiler frontends
(Rúnar, sCrypt) are implementations of a listed primitive, not rivals to it. After the
answer streams, a fail-open critic may replace it with a `revision` event if the draft
is factually off, prescribes forbidden technology, or picks a weaker primitive than the
table's default.

## Setup

Requires **Node.js 22**.

```bash
npm install
npm run fetch-corpus   # pins Satoshi's posts/emails into server/data/satoshi-corpus.json
cp .env.example .env   # then add your keys
npm run dev            # server on :8787, client on :5173
```

The primary chain runs on a funded OpenRouter key (pennies per answer); Gemini and Groq
free keys (no card required) add overflow capacity, and OpenRouter `:free` models are the
last resort:

| Provider | Where | Powers |
|---|---|---|
| OpenRouter (primary) | https://openrouter.ai/keys | Paid: `google/gemini-3.1-flash-lite` (vision) → `deepseek/deepseek-v4-flash`. An unfunded key still serves the `:free` overflow models — 50 req/day, 1,000/day after a one-time $10 top-up |
| Google AI Studio | https://aistudio.google.com/apikey | Free overflow: `gemini-3.6-flash` → `gemini-3.5-flash` (vision + streaming) |
| Groq | https://console.groq.com/keys | Free overflow: `openai/gpt-oss-120b` (text), `qwen/qwen3.6-27b` (vision turns) |

The app runs with any subset of keys; with none it still answers from cache/corpus misses
gracefully (and tells the user Satoshi is sleeping).

## When every quota is spent

A circuit breaker tracks each model tier's quota state. When all configured tiers are
exhausted, `GET /api/status` reports `asleep` with a `retryAfter` timestamp, the composer
disables itself, and the UI shows a witty "Satoshi is sleeping" banner until quotas reset
(midnight Pacific for Gemini, UTC for Groq/OpenRouter). The client polls and wakes up
automatically.

## Production

```bash
npm install   # workspaces: installs server + client together
npm run build # server → server/dist, client → repo-root public/
npm start     # serves public/ and the API from one Node process
```

### Rate limiting

With the paid OpenRouter primary active there are no per-user quota caps. A generous
per-IP burst limit on `POST /api/chat` (default 60 req/min) remains purely to blunt
scripted abuse of the paid key — no ordinary conversation will approach it. Set
`RATE_LIMIT_PER_MIN` to tune it or `0` to disable it entirely. Behind a reverse proxy,
`TRUST_PROXY=1` ensures the limit keys on real client addresses rather than the proxy's.

### Vercel

The repo deploys to Vercel as-is: the client builds into `public/` (served by Vercel's CDN)
and the Express app is default-exported from the root `index.js`, which Vercel runs as a
single function on Fluid compute. `vercel.json` pins the Express framework (and looks for
the entry at the repo root, not inside `public/`) so `/api/*` is not swallowed by a
Vite/SPA fallback. Import the repo at vercel.com/new and set your keys under Project →
Environment Variables (`GEMINI_API_KEY`, `GROQ_API_KEY`, optional `OPENROUTER_API_KEY`).
`TRUST_PROXY` is handled automatically.

Caveats of the serverless model:

- **The BSV knowledge helper does not run reliably here.** It is a stdio child process that
  builds a SQLite index on boot, but serverless instances freeze between requests, so its
  startup handshake never completes — `/api/health` reports `mcp:false`. Technical questions
  (BRCs, Teranode, Script) then fall back to Satoshi's own posts and e-mails, which do not
  cover them. **Use a long-running host (below) if you want the full knowledge base.**
- The burst rate limit, the quota breaker and the answer cache are in-memory, so they
  apply per function instance rather than globally.
- Function duration caps apply to chat streams (plan-dependent).

### Long-running host (guaranteed MCP) — recommended

The BSV knowledge helper is a stdio child process that builds a SQLite index on boot.
Serverless platforms freeze instances between requests, so the child's startup handshake
can never reliably complete — on Vercel the MCP stays down (`/api/health` reports
`mcp:false`) and every technical question falls back to Satoshi's corpus. **For the full
knowledge base, run it on a long-running host.**

A ready-made bundle for **AlmaLinux 9 + systemd + Caddy** (automatic HTTPS, everything on
one origin) lives in [`deploy/`](deploy/):

```bash
sudo bash deploy/setup.sh    # installs Node 22 + Caddy, builds, configures systemd + TLS
```

See [deploy/RUNBOOK.md](deploy/RUNBOOK.md) for the full guide (DNS, `.env`, verification).
The app binds `127.0.0.1` behind Caddy, runs as an unprivileged user, and keeps the MCP
index at `BSV_AIO_DB_PATH` so it survives reboots.

For other hosts (Railway, Render, Fly, a different VPS distro): `npm install`,
`npm run build`, `npm start`, with `ALLOWED_ORIGIN` set to your public origin,
`TRUST_PROXY=1` when behind a proxy, and optionally `HOST` and `BSV_AIO_DB_PATH`.

## Privacy notes

- Chats never leave the browser except as a single question to `/api/chat`; nothing is
  persisted server-side.
- The primary chain runs on paid OpenRouter models; all OpenRouter traffic passes through
  the upstream model providers (Google, DeepSeek, NVIDIA, Z.ai), whose own logging policies
  apply. Free-tier Gemini overflow may be used by Google to improve its products; Groq does
  not train on API traffic. Never paste private keys or seed phrases into any chatbot — the
  app warns users who try.

## Development

```bash
npm run test         # vitest suite (routing, errors, breaker, corpus, cache)
npm run typecheck    # tsc --noEmit on both workspaces
npm run fetch-corpus # re-pin the Satoshi corpus (records the upstream commit SHA)
```

Prompt or retrieval changes: from `server/`, `npx tsx scripts/eval.ts` runs the live
pipeline against a 12-question rubric (needs API keys; keep the builder cases and the
non-builder guards green).

Model IDs are pinned in `server/src/models.config.ts` — free catalogues churn, so if a model
is sunset, swap the ID there and redeploy.
