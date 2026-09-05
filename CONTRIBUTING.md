# Contributing to Ask Satoshi

Thanks for your interest. This is a small, focused project — contributions that keep it
simple, accurate and fast are welcome.

## Ground rules

- **No accounts, no fees, no tracking.** The app is deliberately account-free. Please don't
  propose server-side user storage, analytics beacons, or paywalls.
- **Accuracy over fluency.** Answers must stay grounded in the cited evidence. Changes that
  make the persona sound nicer but invent claims will not be merged.
- **Client privacy is a feature.** Chats live only in `localStorage`. Keep it that way.

## Getting started

```bash
npm install           # workspaces: installs server + client together
cp .env.example .env  # add your own free API keys (Gemini / Groq / OpenRouter)
npm run fetch-corpus  # pin the Satoshi writings corpus
npm run dev           # run server (:8787) + client (:5173)
```

## Before you open a PR

```bash
npm run typecheck     # both packages must typecheck
npm test              # server test suite must pass
npm run build         # must build cleanly
```

- Keep changes focused; one concern per PR.
- Match the existing code style (TypeScript, ESM, no unnecessary dependencies).
- British English in user-facing copy; no emojis in the UI.
- Never commit `.env` or real API keys — `.env.example` documents the required variables.
- Prompt, critic or retrieval changes: from `server/`, run `npx tsx scripts/eval.ts`
  (needs API keys) and keep the 12-case rubric green.

## Reporting issues

Open a GitHub issue with: what you asked, what you expected, what you got, and (if relevant)
which sources were cited. Screenshots help for UI bugs.

## A note on the persona

The chatbot speaks in Satoshi's voice but is an AI grounded in cited sources. Contributions
should preserve that honesty — the UI must never imply it is the real Satoshi Nakamoto.
