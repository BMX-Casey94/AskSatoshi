/**
 * Witty, Satoshi-flavoured error taxonomy. Every failure the user can hit maps to a
 * typed code with first-person copy — never a bare stack trace or "500".
 */

export type ErrorCode =
  | 'EXHAUSTED'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'PROVIDER_ERROR'
  | 'MCP_UNAVAILABLE'
  | 'BAD_INPUT'
  | 'IMAGE_REJECTED'
  | 'VISION_UNAVAILABLE'
  | 'NO_KNOWLEDGE';

export interface WittyError {
  code: ErrorCode;
  message: string;
  retryAfter?: string;
}

export const WITTY: Record<ErrorCode, string> = {
  EXHAUSTED:
    'Satoshi is currently sleeping — even the creator of Bitcoin needs his eight hours. He will be back once the free quotas reset.',
  RATE_LIMITED:
    'Easy there — blocks only arrive every ten minutes, and I need a breather too. Give it a moment.',
  TIMEOUT:
    'My connection dropped — rather ironic for someone who designed a network that never goes down. Do try again.',
  PROVIDER_ERROR:
    'Something upstream has gone pear-shaped. Not a reorg, just a hiccup — try again in a moment.',
  MCP_UNAVAILABLE:
    'My reference library is temporarily off the shelf. Ask me again in a moment.',
  BAD_INPUT: 'That message does not parse — keep it under 8,000 characters and on the rails.',
  IMAGE_REJECTED:
    'That image is heavier than a full block. Keep it under 4 MB — PNG, JPEG or WebP only.',
  VISION_UNAVAILABLE:
    'My eyes are tired today — the vision-capable models are all resting. Ask me without the image, or try again later.',
  NO_KNOWLEDGE:
    "I dug through my old posts and emails and found nothing on that. Try me on Bitcoin's design, Script, SPV, or the BRCs.",
};

/**
 * Rotating first-person lines for the no-knowledge case, so a run of unanswered
 * questions doesn't read as a stuck record. The client/server picks one per answer.
 * Every variant stays fail-closed: it admits the gap and points back to what the
 * knowledgebase actually covers, never bluffing an answer.
 */
export const NO_KNOWLEDGE_LINES: string[] = [
  "I dug through my old posts and emails and found nothing on that. Try me on Bitcoin's design, Script, SPV, or the BRCs.",
  "That one's not in my writings or the protocol record I have here. Bitcoin's design, Script, SPV, or the BRCs are firmer ground.",
  "Nothing in the archive or the spec corpus touches that, I'm afraid. Ask me about Bitcoin's design, Script, SPV, or the BRCs.",
  "I've nothing on record for that — my posts, emails and the protocol specs are silent on it. Bitcoin's design, Script, SPV, or the BRCs I can speak to.",
  "That falls outside what I wrote down and what's pinned in the spec record. Happier to talk Bitcoin's design, Script, SPV, or the BRCs.",
];

/** Deterministically pick a no-knowledge line, varying per question so repeats differ. */
export function noKnowledgeLine(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return NO_KNOWLEDGE_LINES[h % NO_KNOWLEDGE_LINES.length] ?? WITTY.NO_KNOWLEDGE;
}

/** Rotating banner lines for the all-quotas-spent "asleep" state (client picks/rotates). */
export const SLEEP_LINES: string[] = [
  'Satoshi is currently sleeping — even the creator of Bitcoin needs his eight hours.',
  'Satoshi has grown tired of answering questions today. The difficulty adjusts; so must his diary.',
  'Satoshi has gone mining for the day. He resurfaces when the free quotas reset.',
];

export function witty(code: ErrorCode, retryAfter?: string): WittyError {
  return retryAfter ? { code, message: WITTY[code], retryAfter } : { code, message: WITTY[code] };
}

/** Thrown through the chain/orchestrator and serialised to the client as a witty error event. */
export class WittyException extends Error {
  constructor(public readonly wittyError: WittyError) {
    super(wittyError.message);
    this.name = 'WittyException';
  }
}

/** Classify a provider failure so the chain knows whether to retry, fail over, or sleep. */
export type FailureClass = 'day' | 'minute' | 'transient' | 'auth' | 'bad-request';

export function classifyProviderError(err: unknown): FailureClass {
  const status = extractStatus(err);
  const message = extractMessage(err).toLowerCase();

  if (status === 401 || status === 403) return 'auth';
  if (status === 400 || status === 404 || status === 422) return 'bad-request';
  if (status === 429) {
    // Daily-quota language differs per provider; anything else 429 is a per-minute cap.
    if (/daily|per day|rpd|requests per day|quota|tokens per day|tpd/.test(message)) return 'day';
    return 'minute';
  }
  if (status !== undefined && [408, 409, 425, 500, 502, 503, 504, 529].includes(status)) {
    return 'transient';
  }
  if (
    /timeout|timed out|etimedout|econnreset|econnaborted|socket hang up|aborted|fetch failed|network/.test(
      message,
    )
  ) {
    return 'transient';
  }
  // Unknown errors are treated as transient: fail over, but never mark a tier dead.
  return 'transient';
}

function extractStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as Record<string, unknown>;
  if (typeof e.status === 'number') return e.status;
  if (typeof e.statusCode === 'number') return e.statusCode;
  const response = e.response as Record<string, unknown> | undefined;
  if (response && typeof response.status === 'number') return response.status;
  return undefined;
}

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null) {
    const e = err as Record<string, unknown>;
    const error = e.error as Record<string, unknown> | undefined;
    if (error && typeof error.message === 'string') return error.message;
    if (typeof e.message === 'string') return e.message;
  }
  return String(err);
}

/** Best-effort extraction of a provider's retry-after hint, in milliseconds. */
export function retryAfterMs(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as Record<string, unknown>;
  const headers = (e.headers ?? (e.response as Record<string, unknown> | undefined)?.headers) as
    | Record<string, unknown>
    | undefined;
  if (!headers) return undefined;
  const raw =
    headers['retry-after'] ?? headers['x-ratelimit-reset-requests'] ?? headers['x-ratelimit-reset'];
  if (raw === undefined) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) {
    // x-ratelimit-reset may be an epoch timestamp rather than a delta.
    const ms = seconds * 1000;
    return ms > Date.now() ? ms - Date.now() : ms;
  }
  return undefined;
}
