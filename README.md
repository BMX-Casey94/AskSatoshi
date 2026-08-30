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
                                      │         └─▶ LLM chain:               │
                                      │             gemini-3.6-flash          │
                                      │             gemini-3.5-flash          │
                                      │             Groq gpt-oss-120b         │
                                      │             OpenRouter :free (opt.)   │
                                      │ GET /api/status (awake / asleep)      │
                                      └────────────────────────────────────────┘
```

The MCP server is stdio-only, so the backend starts it as a child process and speaks to it
with the official MCP SDK. On a long-running host that child stays up. On Vercel it is
started when an instance wakes and is gone again after idle — when it is not ready, answers
fall back to Satoshi's own writings. All model API keys stay server-side.

## Setup

Requires **Node.js 22**.

```bash
npm install
npm run fetch-corpus   # pins Satoshi's posts/emails into server/data/satoshi-corpus.json
cp .env.example .env   # then add your keys
npm run dev            # server on :8787, client on :5173
```

Free API keys (no card required for either):

| Provider | Where | Powers |
|---|---|---|
| Google AI Studio | https://aistudio.google.com/apikey | `gemini-3.6-flash` → `gemini-3.5-flash` → `gemini-2.5-flash` (vision + streaming) |
| Groq | https://console.groq.com/keys | `openai/gpt-oss-120b` (text), `qwen/qwen3.6-27b` (vision turns) |
| OpenRouter (optional) | https://openrouter.ai/keys | `:free` third tier — 50 req/day unfunded, 1,000/day after a one-time $10 top-up |

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
- Rate limits, the quota breaker and the answer cache are in-memory, so they apply per
  function instance rather than globally.
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
- Free-tier Gemini traffic may be used by Google to improve its products; OpenRouter `:free`
  traffic may be logged by the upstream provider (NVIDIA/Google). Groq does not train on API
  traffic. Never paste private keys or seed phrases into any chatbot — the app warns users
  who try.

## Development

```bash
npm run test         # vitest suite (routing, errors, breaker, corpus, cache)
npm run typecheck    # tsc --noEmit on both workspaces
npm run fetch-corpus # re-pin the Satoshi corpus (records the upstream commit SHA)
```

Model IDs are pinned in `server/src/models.config.ts` — free catalogues churn, so if a model
is sunset, swap the ID there and redeploy.
