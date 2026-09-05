/**
 * Paid read-aloud: quote → BRC-100 wallet payment → synthesis. The Resemble key
 * never reaches the browser; we only talk to `/api/tts/*`.
 */

export { renderPlainText as stripMarkdown } from './markdown';
import {
  WalletUnavailableError,
  describeTtsError,
  encodeWalletTx,
  friendlyTtsError,
  type TtsFriendlyError,
} from './ttsErrors';
export {
  WalletUnavailableError,
  describeTtsError,
  encodeWalletTx,
  friendlyTtsError,
  type TtsFriendlyError,
};

export type TtsDisabledReason = 'not-configured' | 'credit-exhausted' | 'low-balance';

export interface TtsStatus {
  enabled: boolean;
  reason: TtsDisabledReason | null;
  maxChars: number;
  bsvUsd: number;
  satsPerThousandChars: number;
  estimatedSecondsPerThousandChars: number;
}

export interface TtsQuote {
  quoteId: string;
  chars: number;
  satoshis: number;
  treasuryAddress: string;
  expiresAt: number;
}

export type TtsProgress = 'paying' | 'synthesising';

const DISABLED_REASONS = new Set<TtsDisabledReason>([
  'not-configured',
  'credit-exhausted',
  'low-balance',
]);

const TXID_RE = /^[0-9a-fA-F]{64}$/;

type StatusListener = (status: TtsStatus | null) => void;

const listeners = new Set<StatusListener>();
let statusPromise: Promise<TtsStatus | null> | null = null;
let statusGeneration = 0;

export function subscribeTtsStatus(listener: StatusListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emitTtsStatus(status: TtsStatus | null): void {
  for (const listener of listeners) listener(status);
}

function parseStatus(body: unknown): TtsStatus | null {
  if (!body || typeof body !== 'object') return null;
  const o = body as Record<string, unknown>;
  if (typeof o.enabled !== 'boolean') return null;
  if (typeof o.maxChars !== 'number' || !Number.isFinite(o.maxChars)) return null;
  if (typeof o.bsvUsd !== 'number' || !Number.isFinite(o.bsvUsd)) return null;
  if (typeof o.satsPerThousandChars !== 'number' || !Number.isFinite(o.satsPerThousandChars)) return null;
  if (
    typeof o.estimatedSecondsPerThousandChars !== 'number' ||
    !Number.isFinite(o.estimatedSecondsPerThousandChars)
  ) {
    return null;
  }
  let reason: TtsDisabledReason | null = null;
  if (o.reason !== null && o.reason !== undefined) {
    if (typeof o.reason !== 'string' || !DISABLED_REASONS.has(o.reason as TtsDisabledReason)) {
      return null;
    }
    reason = o.reason as TtsDisabledReason;
  }
  return {
    enabled: o.enabled,
    reason,
    maxChars: o.maxChars,
    bsvUsd: o.bsvUsd,
    satsPerThousandChars: o.satsPerThousandChars,
    estimatedSecondsPerThousandChars: o.estimatedSecondsPerThousandChars,
  };
}

async function fetchTtsStatus(): Promise<TtsStatus | null> {
  try {
    const res = await fetch('/api/tts/status');
    if (!res.ok) return null;
    return parseStatus(await res.json());
  } catch {
    return null;
  }
}

function loadTtsStatus(force: boolean): Promise<TtsStatus | null> {
  if (!statusPromise || force) {
    const generation = ++statusGeneration;
    statusPromise = fetchTtsStatus().then((status) => {
      if (generation === statusGeneration) emitTtsStatus(status);
      return status;
    });
  }
  return statusPromise;
}

/** Cached for the page lifetime — one network fetch unless {@link refreshTtsStatus} is called. */
export function getTtsStatus(): Promise<TtsStatus | null> {
  return loadTtsStatus(false);
}

/** Refetch after the server reports TTS is disabled or credits are exhausted. */
export function refreshTtsStatus(): Promise<TtsStatus | null> {
  return loadTtsStatus(true);
}

function parseQuote(body: unknown): TtsQuote | null {
  if (!body || typeof body !== 'object') return null;
  const o = body as Record<string, unknown>;
  if (typeof o.quoteId !== 'string' || o.quoteId.length === 0) return null;
  if (typeof o.chars !== 'number' || !Number.isInteger(o.chars) || o.chars < 0) return null;
  if (typeof o.satoshis !== 'number' || !Number.isInteger(o.satoshis) || o.satoshis < 1) return null;
  if (typeof o.treasuryAddress !== 'string' || o.treasuryAddress.length === 0) return null;
  if (typeof o.expiresAt !== 'number' || !Number.isFinite(o.expiresAt)) return null;
  return {
    quoteId: o.quoteId,
    chars: o.chars,
    satoshis: o.satoshis,
    treasuryAddress: o.treasuryAddress,
    expiresAt: o.expiresAt,
  };
}

interface ApiErrorShape {
  code: string;
  message: string;
  refunded?: boolean;
  reason?: string;
  refundTxid?: string;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseApiError(body: unknown, fallbackCode: string, fallbackMessage: string): ApiErrorShape {
  if (body && typeof body === 'object') {
    const error = (body as { error?: unknown }).error;
    if (error && typeof error === 'object') {
      const o = error as Record<string, unknown>;
      return {
        code: typeof o.code === 'string' && o.code.length > 0 ? o.code : fallbackCode,
        message: typeof o.message === 'string' && o.message.length > 0 ? o.message : fallbackMessage,
        refunded: o.refunded === true ? true : undefined,
        reason: asOptionalString(o.reason),
        refundTxid: asOptionalString(o.refundTxid),
      };
    }
  }
  return { code: fallbackCode, message: fallbackMessage };
}

class CodedError extends Error {
  readonly code: string;
  readonly refunded?: boolean;
  readonly reason?: string;
  readonly refundTxid?: string;
  constructor(
    code: string,
    message: string,
    extra?: boolean | { refunded?: boolean; reason?: string; refundTxid?: string },
  ) {
    super(message);
    this.name = 'TtsApiError';
    this.code = code;
    if (typeof extra === 'boolean') {
      this.refunded = extra;
    } else {
      this.refunded = extra?.refunded;
      this.reason = extra?.reason;
      this.refundTxid = extra?.refundTxid;
    }
  }
}

export async function requestQuote(chars: number): Promise<TtsQuote> {
  let res: Response;
  try {
    res = await fetch('/api/tts/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chars }),
    });
  } catch {
    throw new Error('Could not reach the read-aloud service. Please try again.');
  }

  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    const parsed = parseApiError(body, 'TTS_QUOTE_FAILED', 'Could not price this reading. Please try again.');
    if (parsed.code === 'TTS_DISABLED' || parsed.code === 'TTS_CREDIT_EXHAUSTED') {
      void refreshTtsStatus();
    }
    throw new CodedError(parsed.code, parsed.message, {
      refunded: parsed.refunded,
      reason: parsed.reason,
      refundTxid: parsed.refundTxid,
    });
  }

  const quote = parseQuote(await res.json());
  if (!quote) throw new Error('The price quote was malformed. Please try again.');
  return quote;
}

function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === 'string') return code;
    if (typeof code === 'number') return String(code);
  }
  return '';
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function isPaymentCancelled(err: unknown): boolean {
  const code = errorCode(err).toUpperCase();
  if (
    code === 'USER_REJECTED' ||
    code === 'USER_CANCELLED' ||
    code === 'USER_CANCELED' ||
    code === 'DENIED' ||
    code === 'CANCELLED' ||
    code === 'CANCELED'
  ) {
    return true;
  }
  const lower = errorMessage(err).toLowerCase();
  return (
    lower.includes('user rejected') ||
    lower.includes('user cancelled') ||
    lower.includes('user canceled') ||
    lower.includes('user declined') ||
    lower.includes('payment cancelled') ||
    lower.includes('payment canceled') ||
    lower.includes('action was cancelled') ||
    lower.includes('action was canceled') ||
    lower.includes('request denied')
  );
}

function isWalletUnavailable(err: unknown): boolean {
  if (err instanceof WalletUnavailableError) return true;
  const lower = errorMessage(err).toLowerCase();
  return (
    lower.includes('no wallet') ||
    lower.includes('wallet not') ||
    lower.includes('failed to connect') ||
    lower.includes('could not connect') ||
    lower.includes('unable to connect') ||
    lower.includes('not available') ||
    lower.includes('no provider') ||
    lower.includes('wallet is required') ||
    lower.includes('substrate')
  );
}

async function payWithWallet(quote: TtsQuote): Promise<string> {
  if (Date.now() >= quote.expiresAt) {
    throw new CodedError('TTS_QUOTE_EXPIRED', 'The quote expired. Please try again.');
  }

  const { WalletClient, P2PKH } = await import('@bsv/sdk');

  let wallet: InstanceType<typeof WalletClient>;
  try {
    wallet = new WalletClient('auto');
  } catch {
    throw new WalletUnavailableError();
  }

  let lockingScript: string;
  try {
    lockingScript = new P2PKH().lock(quote.treasuryAddress).toHex();
  } catch {
    throw new Error('The treasury address on this quote is not valid. Please try again.');
  }

  let rawTx: string | undefined;
  try {
    const result = await wallet.createAction({
      description: 'Ask Satoshi — read aloud',
      outputs: [
        {
          satoshis: quote.satoshis,
          lockingScript,
          outputDescription: 'Read-aloud synthesis',
        },
      ],
    });
    rawTx = encodeWalletTx(result.tx) ?? undefined;
  } catch (err) {
    if (isPaymentCancelled(err)) {
      throw new Error('Payment cancelled — nothing was charged.');
    }
    if (isWalletUnavailable(err)) {
      throw new WalletUnavailableError();
    }
    throw new Error(friendlyTtsError(err));
  }

  if (!rawTx || !/^[0-9a-fA-F]+$/.test(rawTx)) {
    throw new Error('The wallet did not return a signed transaction. Nothing further was submitted.');
  }
  return rawTx;
}

function isSafeAudioUrl(url: string): boolean {
  if (url.startsWith('/api/tts/audio/')) return true;
  try {
    const parsed = new URL(url, window.location.origin);
    return parsed.origin === window.location.origin && parsed.pathname.startsWith('/api/tts/audio/');
  } catch {
    return false;
  }
}

async function submitSpeak(text: string, quote: TtsQuote, rawTx: string): Promise<{ audioUrl: string }> {
  let res: Response;
  try {
    res = await fetch('/api/tts/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quoteId: quote.quoteId, rawTx, text }),
    });
  } catch {
    throw new Error('Paid, but could not reach the synthesis service. Please contact support with your transaction id.');
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (!res.ok) {
    const parsed = parseApiError(body, 'TTS_SPEAK_FAILED', 'Synthesis failed. Please try again.');
    if (parsed.code === 'TTS_DISABLED' || parsed.code === 'TTS_CREDIT_EXHAUSTED') {
      void refreshTtsStatus();
    }
    throw new CodedError(parsed.code, parsed.message, {
      refunded: parsed.refunded,
      reason: parsed.reason,
      refundTxid: parsed.refundTxid,
    });
  }

  if (!body || typeof body !== 'object') {
    throw new Error('Synthesis finished but the response was malformed.');
  }
  const audioUrl = (body as { audioUrl?: unknown }).audioUrl;
  if (typeof audioUrl !== 'string' || !isSafeAudioUrl(audioUrl)) {
    throw new Error('Synthesis finished but the audio address was not valid.');
  }
  return { audioUrl };
}

export async function payAndSpeak(
  text: string,
  quote: TtsQuote,
  onProgress?: (phase: TtsProgress) => void,
): Promise<{ audioUrl: string }> {
  onProgress?.('paying');
  const rawTx = await payWithWallet(quote);
  onProgress?.('synthesising');
  return submitSpeak(text, quote, rawTx);
}
