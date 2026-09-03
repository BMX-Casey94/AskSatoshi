/**
 * Paid TTS HTTP API. Deps are injected so tests can stub pricing, Resemble, treasury,
 * store and kill-switch without touching the real runtime directory or network.
 */

import { timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { isTtsConfigured, type TtsConfig } from './config.js';
import type { BsvUsdQuote } from './pricing.js';
import { TtsCreditExhaustedError } from './resemble.js';
import { QUOTE_TTL_MS, type Purchase, type TtsStore } from './store.js';
import type { TtsState } from './state.js';

export interface TtsRouterDeps {
  config: TtsConfig;
  store: TtsStore;
  state: TtsState;
  audioDir: string;
  fetchBsvUsd: (fetchFn?: typeof fetch, now?: number) => Promise<BsvUsdQuote>;
  quoteSatoshis: (chars: number, bsvUsd: number) => number;
  satsPerThousand: (bsvUsd: number) => number;
  resemble: {
    synthesize(text: string): Promise<{ audio: Buffer; durationSeconds: number }>;
    getWalletBalanceDollars?(): Promise<number | null>;
    getWallet?(): Promise<{ balanceDollars: number; lowBalance: boolean } | null>;
  } | null;
  treasury: {
    address: string;
    lockingScriptHex: string;
    verifyPayment(opts: {
      rawTx: string;
      expectedSats: number;
      treasuryScriptHex: string;
    }): Promise<
      | { ok: true; txid: string; receivedSats: number; voutIndex: number; senderScriptHex: string }
      | { ok: false; reason: string }
    >;
    buildRefundTx(opts: {
      paymentTxid: string;
      voutIndex: number;
      receivedSats: number;
      senderScriptHex: string;
      treasuryKey?: unknown;
    }): Promise<string | null>;
    broadcastTx(rawHex: string): Promise<string>;
    key?: unknown;
  } | null;
  now?: () => number;
}

const AUDIO_ID = /^p_[A-Za-z0-9_-]+$/;
const AUDIO_DOWNLOAD_NAME = 'ask-satoshi-read-aloud.mp3';

function wantsAudioDownload(query: Request['query']): boolean {
  const raw = query.download;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === '1' || value === 'true';
}

function audioContentDisposition(download: boolean): string {
  const kind = download ? 'attachment' : 'inline';
  return `${kind}; filename="${AUDIO_DOWNLOAD_NAME}"`;
}

function jsonError(
  res: Response,
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): void {
  res.status(status).json({ error: { code, message, ...extra } });
}

function bearerToken(req: Request): string {
  const header = req.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() ?? '';
}

/** Constant-time compare; length mismatch still runs a dummy compare. */
function tokenEquals(provided: string, expected: string): boolean {
  if (!expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function createTtsRouter(deps: TtsRouterDeps): Router {
  const router = Router();
  mkdirSync(deps.audioDir, { recursive: true });

  const now = () => (deps.now ? deps.now() : Date.now());

  const feature = () => {
    if (!isTtsConfigured(deps.config) || !deps.treasury || !deps.resemble) {
      return { enabled: false as const, reason: 'not-configured' as const };
    }
    const st = deps.state.getState();
    if (st.disabled) return { enabled: false as const, reason: st.reason };
    return { enabled: true as const, reason: null };
  };

  router.use(
    rateLimit({
      windowMs: 60_000,
      limit: 20,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: { error: { code: 'RATE_LIMITED', message: 'Too many TTS requests. Please wait a moment.' } },
    }),
  );

  const quoteBody = z.object({
    chars: z.number().int().min(1).max(deps.config.maxChars),
  });

  const speakBody = z.object({
    quoteId: z.string().min(1),
    rawTx: z.string().min(1).max(1_000_000),
    text: z.string().min(1).max(deps.config.maxChars),
  });

  router.get('/status', async (_req, res) => {
    const { enabled, reason } = feature();
    const { rate } = await deps.fetchBsvUsd();
    res.json({
      enabled,
      reason,
      maxChars: deps.config.maxChars,
      bsvUsd: rate,
      satsPerThousandChars: deps.satsPerThousand(rate),
      estimatedSecondsPerThousandChars: 60,
    });
  });

  router.post('/quote', async (req, res) => {
    if (!feature().enabled) {
      jsonError(res, 503, 'TTS_DISABLED', 'Text-to-speech is temporarily unavailable.');
      return;
    }
    const parsed = quoteBody.safeParse(req.body);
    if (!parsed.success) {
      jsonError(res, 400, 'TTS_BAD_INPUT', 'Character count is missing or out of range.');
      return;
    }
    const { rate } = await deps.fetchBsvUsd();
    const satoshis = deps.quoteSatoshis(parsed.data.chars, rate);
    const rec = deps.store.createQuote({ chars: parsed.data.chars, satoshis });
    res.json({
      quoteId: rec.quoteId,
      chars: rec.chars,
      satoshis: rec.satoshis,
      treasuryAddress: deps.treasury!.address,
      expiresAt: rec.createdAt + QUOTE_TTL_MS,
    });
  });

  router.post('/speak', async (req, res) => {
    try {
      await handleSpeak(req, res);
    } catch (err) {
      console.error('[tts] unexpected speak error:', err instanceof Error ? err.message : err);
      if (!res.headersSent) {
        jsonError(res, 502, 'TTS_SYNTH_FAILED', 'Speech synthesis failed.');
      }
    }
  });

  async function handleSpeak(req: Request, res: Response): Promise<void> {
    const parsed = speakBody.safeParse(req.body);
    if (!parsed.success) {
      jsonError(res, 400, 'TTS_BAD_INPUT', 'quoteId, rawTx and text are required and must be valid.');
      return;
    }
    const { quoteId, rawTx, text } = parsed.data;
    const quote = deps.store.getByQuoteId(quoteId);
    if (!quote) {
      jsonError(res, 404, 'TTS_QUOTE_UNKNOWN', 'Unknown quote.');
      return;
    }
    if (quote.status === 'delivered') {
      res.json(deliveredBody(quote));
      return;
    }
    if (quote.status !== 'quoted') {
      jsonError(res, 409, 'TTS_QUOTE_USED', 'This quote has already been used.');
      return;
    }
    if (now() > quote.createdAt + QUOTE_TTL_MS) {
      jsonError(res, 410, 'TTS_QUOTE_EXPIRED', 'This quote has expired. Please request a new one.');
      return;
    }
    if (text.length !== quote.chars) {
      jsonError(res, 400, 'TTS_BAD_INPUT', 'Text length does not match the quoted character count.');
      return;
    }
    if (deps.state.getState().disabled || !deps.resemble || !deps.treasury) {
      jsonError(res, 503, 'TTS_DISABLED', 'Text-to-speech is temporarily unavailable.');
      return;
    }

    const payment = await deps.treasury.verifyPayment({
      rawTx,
      expectedSats: quote.satoshis,
      treasuryScriptHex: deps.treasury.lockingScriptHex,
    });
    if (!payment.ok) {
      console.warn(`[tts] payment rejected: ${payment.reason} quote=${quoteId}`);
      jsonError(res, 402, 'TTS_PAYMENT_INVALID', 'Payment could not be verified.', { reason: payment.reason });
      return;
    }
    if (deps.store.getByTxid(payment.txid)) {
      jsonError(res, 409, 'TTS_TX_REUSED', 'This payment has already been used.');
      return;
    }

    deps.store.markPaid(quote.id, payment.txid);

    try {
      const synth = await deps.resemble.synthesize(text);
      const audioFile = `${quote.id}.mp3`;
      writeFileSync(join(deps.audioDir, audioFile), synth.audio);
      const delivered = deps.store.markDelivered(quote.id, audioFile, synth.durationSeconds);
      res.json(deliveredBody(delivered));
    } catch (err) {
      const refund = await attemptRefund(quote.id, payment.txid, payment);
      if (err instanceof TtsCreditExhaustedError) {
        deps.state.disable('credit-exhausted');
        jsonError(res, 503, 'TTS_CREDIT_EXHAUSTED', 'The speech service is out of credit.', {
          refunded: refund.refunded,
          ...(refund.refundTxid ? { refundTxid: refund.refundTxid } : {}),
        });
        return;
      }
      jsonError(res, 502, 'TTS_SYNTH_FAILED', 'Speech synthesis failed.', {
        refunded: refund.refunded,
        ...(refund.refundTxid ? { refundTxid: refund.refundTxid } : {}),
      });
    }
  }

  async function attemptRefund(
    purchaseId: string,
    paymentTxid: string,
    payment: { receivedSats: number; voutIndex: number; senderScriptHex: string },
  ): Promise<{ refunded: boolean; refundTxid?: string }> {
    if (!deps.treasury) return { refunded: false };
    if (!payment.senderScriptHex) {
      console.error('[tts] refund skipped: sender script unknown; manual refund needed');
      deps.store.markFailed(purchaseId);
      return { refunded: false };
    }
    try {
      const raw = await deps.treasury.buildRefundTx({
        paymentTxid,
        voutIndex: payment.voutIndex,
        receivedSats: payment.receivedSats,
        senderScriptHex: payment.senderScriptHex,
        treasuryKey: deps.treasury.key,
      });
      if (!raw) {
        deps.store.markFailed(purchaseId);
        return { refunded: false };
      }
      const refundTxid = await deps.treasury.broadcastTx(raw);
      deps.store.markRefunded(purchaseId, refundTxid);
      return { refunded: true, refundTxid };
    } catch (err) {
      console.error(
        '[tts] refund failed; manual refund needed',
        err instanceof Error ? err.message : err,
      );
      deps.store.markFailed(purchaseId);
      return { refunded: false };
    }
  }

  function deliveredBody(quote: Purchase) {
    return {
      purchaseId: quote.id,
      audioUrl: `/api/tts/audio/${quote.id}`,
      durationSeconds: quote.durationSeconds,
    };
  }

  router.get('/audio/:purchaseId', (req, res) => {
    const purchaseId = req.params.purchaseId ?? '';
    if (!AUDIO_ID.test(purchaseId)) {
      jsonError(res, 404, 'TTS_NOT_FOUND', 'Audio not found.');
      return;
    }
    const rec = deps.store.getById(purchaseId);
    if (!rec || rec.status !== 'delivered' || !rec.audioFile) {
      jsonError(res, 404, 'TTS_NOT_FOUND', 'Audio not found.');
      return;
    }
    const filePath = join(deps.audioDir, rec.audioFile);
    if (!existsSync(filePath)) {
      jsonError(res, 404, 'TTS_NOT_FOUND', 'Audio not found.');
      return;
    }
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.setHeader('Content-Disposition', audioContentDisposition(wantsAudioDownload(req.query)));
    createReadStream(filePath).pipe(res);
  });

  router.post('/admin/enable', (req, res) => {
    if (!tokenEquals(bearerToken(req), deps.config.adminToken)) {
      jsonError(res, 403, 'TTS_FORBIDDEN', 'Unauthorised.');
      return;
    }
    deps.state.enable();
    res.json({ enabled: true });
  });

  return router;
}
