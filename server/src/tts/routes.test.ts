import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadTtsConfig } from './config.js';
import { QUOTE_TTL_MS, createTtsStore, type TtsStore } from './store.js';
import { createTtsState, type TtsState } from './state.js';
import { TtsCreditExhaustedError, TtsSynthError } from './resemble.js';
import { createTtsRouter, type TtsRouterDeps } from './routes.js';

const RAW_TX = '0100000001' + '00'.repeat(36) + '6a' + '47' + '30' + '44' + '02' + '20' + '01'.repeat(32) + '02' + '20' + '02'.repeat(32) + '41' + '21' + '03' + '03'.repeat(32) + 'ffffffff' + '01' + 'e803000000000000' + '1976a91489abcdef0123456789abcdef0123456789abcdef88ac' + '00000000';
const TXID = 'ab'.repeat(32);
const TXID2 = 'cd'.repeat(32);

interface LiveApp {
  url: string;
  server: Server;
  store: TtsStore;
  state: TtsState;
  synthesize: ReturnType<typeof vi.fn>;
  verifyPayment: ReturnType<typeof vi.fn>;
  buildRefundTx: ReturnType<typeof vi.fn>;
  broadcastTx: ReturnType<typeof vi.fn>;
  audioDir: string;
}

const apps: LiveApp[] = [];
const dirs: string[] = [];

async function tmpDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function baseConfig() {
  return loadTtsConfig({
    RESEMBLE_API_KEY: 'rk_test',
    RESEMBLE_VOICE_UUID: 'voice',
    TREASURY_WIF: 'L5EY1SbTvvPNSdCYQe1EJHfXCBBT4PmnF6CDbzCm9iifZptUvDGB',
    TTS_ADMIN_TOKEN: 'admin-secret',
    TTS_MAX_CHARS: '12000',
  });
}

async function startApp(overrides: Partial<TtsRouterDeps> = {}): Promise<LiveApp> {
  const dir = await tmpDir('tts-routes-');
  const store = overrides.store ?? createTtsStore(join(dir, 'purchases.json'));
  const state = overrides.state ?? createTtsState(join(dir, 'state.json'));
  const audioDir = overrides.audioDir ?? join(dir, 'audio');
  const synthesize = vi.fn(async () => ({ audio: Buffer.from('ID3fake'), durationSeconds: 1.5 }));
  const verifyPayment = vi.fn(async () => ({
    ok: true as const,
    txid: TXID,
    receivedSats: 1000,
    voutIndex: 0,
    senderScriptHex: '76a91400112233445566778899aabbccddeeff0011223388ac',
  }));
  const buildRefundTx = vi.fn(async () => '00refund');
  const broadcastTx = vi.fn(async () => 'ef'.repeat(32));

  const deps: TtsRouterDeps = {
    config: baseConfig(),
    store,
    state,
    audioDir,
    fetchBsvUsd: async () => ({ rate: 20, source: 'whatsonchain' }),
    quoteSatoshis: (chars, rate) => Math.ceil(chars * 10 * rate),
    satsPerThousand: (rate) => Math.ceil(1000 * 10 * rate),
    resemble: { synthesize, getWalletBalanceDollars: async () => 9, getWallet: async () => ({ balanceDollars: 9, lowBalance: false }) },
    treasury: {
      address: '1TreasuryAddressxxxxxxxxxxxxxxxxx',
      lockingScriptHex: '76a91489abcdef0123456789abcdef0123456789abcdef88ac',
      verifyPayment,
      buildRefundTx,
      broadcastTx,
    },
    ...overrides,
  };

  const app = express();
  app.use(express.json());
  app.use('/api/tts', createTtsRouter(deps));

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  const live: LiveApp = {
    url: `http://127.0.0.1:${addr.port}`,
    server,
    store,
    state,
    synthesize,
    verifyPayment,
    buildRefundTx,
    broadcastTx,
    audioDir,
  };
  apps.push(live);
  return live;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => new Promise<void>((resolve) => a.server.close(() => resolve()))));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('GET /api/tts/status', () => {
  it('returns the enabled status shape', async () => {
    const { url } = await startApp();
    const res = await fetch(`${url}/api/tts/status`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      enabled: true,
      reason: null,
      maxChars: 12_000,
      bsvUsd: 20,
      satsPerThousandChars: 200_000,
      estimatedSecondsPerThousandChars: 60,
    });
  });

  it('reports not-configured and kill-switch reasons', async () => {
    const unconfigured = await startApp({
      config: loadTtsConfig({}),
      treasury: null,
      resemble: null,
    });
    const off = await fetch(`${unconfigured.url}/api/tts/status`);
    expect(await off.json()).toMatchObject({ enabled: false, reason: 'not-configured' });

    const dir = await tmpDir('tts-kill-');
    const state = createTtsState(join(dir, 'state.json'));
    state.disable('credit-exhausted');
    const killed = await startApp({ state });
    const res = await fetch(`${killed.url}/api/tts/status`);
    expect(await res.json()).toMatchObject({ enabled: false, reason: 'credit-exhausted' });
  });
});

describe('POST /api/tts/quote', () => {
  it('returns a quote for a valid character count', async () => {
    const { url } = await startApp();
    const res = await fetch(`${url}/api/tts/quote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chars: 1500 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      quoteId: string;
      chars: number;
      satoshis: number;
      treasuryAddress: string;
      expiresAt: number;
    };
    expect(body.quoteId).toMatch(/^q_/);
    expect(body.chars).toBe(1500);
    expect(body.satoshis).toBe(300_000);
    expect(body.treasuryAddress).toBe('1TreasuryAddressxxxxxxxxxxxxxxxxx');
    expect(body.expiresAt).toBeGreaterThan(Date.now());
  });

  it('rejects invalid chars and disabled quotes', async () => {
    const live = await startApp();
    const bad = await fetch(`${live.url}/api/tts/quote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chars: 0 }),
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: 'TTS_BAD_INPUT' } });

    live.state.disable('low-balance');
    const disabled = await fetch(`${live.url}/api/tts/quote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chars: 100 }),
    });
    expect(disabled.status).toBe(503);
    expect(await disabled.json()).toMatchObject({ error: { code: 'TTS_DISABLED' } });
  });
});

describe('POST /api/tts/speak', () => {
  async function quoted(live: LiveApp, chars = 5, text = 'hello') {
    const rec = live.store.createQuote({ chars, satoshis: 1000 });
    return { rec, text };
  }

  it('rejects unknown, expired and already-used quotes', async () => {
    const live = await startApp();
    const unknown = await fetch(`${live.url}/api/tts/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quoteId: 'q_missing', rawTx: RAW_TX, text: 'hello' }),
    });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: { code: 'TTS_QUOTE_UNKNOWN' } });

    const { rec } = await quoted(live);
    live.store.markFailed(rec.id);
    const used = await fetch(`${live.url}/api/tts/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quoteId: rec.quoteId, rawTx: RAW_TX, text: 'hello' }),
    });
    expect(used.status).toBe(409);
    expect(await used.json()).toMatchObject({ error: { code: 'TTS_QUOTE_USED' } });

    const expiredLive = await startApp({ now: () => Date.now() + QUOTE_TTL_MS + 1_000 });
    const exp = expiredLive.store.createQuote({ chars: 5, satoshis: 1000 });
    const expired = await fetch(`${expiredLive.url}/api/tts/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quoteId: exp.quoteId, rawTx: RAW_TX, text: 'hello' }),
    });
    expect(expired.status).toBe(410);
    expect(await expired.json()).toMatchObject({ error: { code: 'TTS_QUOTE_EXPIRED' } });
  });

  it('rejects a text length that does not match the quoted chars', async () => {
    const live = await startApp();
    const { rec } = await quoted(live, 5, 'hello');
    const res = await fetch(`${live.url}/api/tts/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quoteId: rec.quoteId, rawTx: RAW_TX, text: 'nope' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'TTS_BAD_INPUT' } });
    expect(live.synthesize).not.toHaveBeenCalled();
  });

  it('rejects a reused payment transaction', async () => {
    const live = await startApp();
    const first = live.store.createQuote({ chars: 5, satoshis: 1000 });
    live.store.markPaid(first.id, TXID);
    const second = live.store.createQuote({ chars: 5, satoshis: 1000 });
    const res = await fetch(`${live.url}/api/tts/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quoteId: second.quoteId, rawTx: RAW_TX, text: 'hello' }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'TTS_TX_REUSED' } });
  });

  it('returns 503 when the kill switch is on, after quote checks', async () => {
    const live = await startApp();
    const { rec } = await quoted(live);
    live.state.disable('low-balance');
    const res = await fetch(`${live.url}/api/tts/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quoteId: rec.quoteId, rawTx: RAW_TX, text: 'hello' }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: 'TTS_DISABLED' } });
  });

  it('returns 402 with the verifyPayment reason when the payment is invalid', async () => {
    const live = await startApp();
    live.verifyPayment.mockResolvedValueOnce({ ok: false, reason: 'underpaid' });
    const { rec } = await quoted(live);
    const res = await fetch(`${live.url}/api/tts/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quoteId: rec.quoteId, rawTx: RAW_TX, text: 'hello' }),
    });
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ error: { code: 'TTS_PAYMENT_INVALID', reason: 'underpaid' } });
  });

  it('synthesises, writes audio and returns the audio URL on a valid payment', async () => {
    const live = await startApp();
    const { rec } = await quoted(live);
    const res = await fetch(`${live.url}/api/tts/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quoteId: rec.quoteId, rawTx: RAW_TX, text: 'hello' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { purchaseId: string; audioUrl: string; durationSeconds: number };
    expect(body.purchaseId).toBe(rec.id);
    expect(body.audioUrl).toBe(`/api/tts/audio/${rec.id}`);
    expect(body.durationSeconds).toBe(1.5);
    expect(live.store.getById(rec.id)?.status).toBe('delivered');

    const audio = await fetch(`${live.url}${body.audioUrl}`);
    expect(audio.status).toBe(200);
    expect(audio.headers.get('content-type')).toMatch(/audio\/mpeg/);
    expect(audio.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(Buffer.from(await audio.arrayBuffer()).toString()).toBe('ID3fake');
  });

  it('is idempotent for an already-delivered quote and does not re-synthesise', async () => {
    const live = await startApp();
    const { rec } = await quoted(live);
    await writeFile(join(live.audioDir, `${rec.id}.mp3`), 'ID3fake');
    live.store.markPaid(rec.id, TXID);
    live.store.markDelivered(rec.id, `${rec.id}.mp3`, 3);
    const res = await fetch(`${live.url}/api/tts/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quoteId: rec.quoteId, rawTx: RAW_TX, text: 'hello' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      purchaseId: rec.id,
      audioUrl: `/api/tts/audio/${rec.id}`,
      durationSeconds: 3,
    });
    expect(live.synthesize).not.toHaveBeenCalled();
    expect(live.verifyPayment).not.toHaveBeenCalled();
  });

  it('disables and refunds when Resemble returns 402 credits exhausted', async () => {
    const live = await startApp();
    live.synthesize.mockRejectedValueOnce(new TtsCreditExhaustedError());
    const { rec } = await quoted(live);
    const res = await fetch(`${live.url}/api/tts/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quoteId: rec.quoteId, rawTx: RAW_TX, text: 'hello' }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      error: { code: 'TTS_CREDIT_EXHAUSTED', refunded: true, refundTxid: 'ef'.repeat(32) },
    });
    expect(live.state.getState()).toMatchObject({ disabled: true, reason: 'credit-exhausted' });
    expect(live.store.getById(rec.id)?.status).toBe('refunded');
  });

  it('refunds and returns 502 on other synthesis failures, and reports refunded:false if broadcast fails', async () => {
    const live = await startApp();
    live.synthesize.mockRejectedValueOnce(new TtsSynthError('boom', { status: 500 }));
    const { rec } = await quoted(live);
    const res = await fetch(`${live.url}/api/tts/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quoteId: rec.quoteId, rawTx: RAW_TX, text: 'hello' }),
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: { code: 'TTS_SYNTH_FAILED', refunded: true } });

    const failing = await startApp();
    failing.synthesize.mockRejectedValueOnce(new TtsSynthError('boom'));
    failing.broadcastTx.mockRejectedValueOnce(new Error('broadcast down'));
    const rec2 = failing.store.createQuote({ chars: 5, satoshis: 1000 });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res2 = await fetch(`${failing.url}/api/tts/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quoteId: rec2.quoteId, rawTx: RAW_TX, text: 'hello' }),
    });
    expect(res2.status).toBe(502);
    expect(await res2.json()).toMatchObject({ error: { code: 'TTS_SYNTH_FAILED', refunded: false } });
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('does not build a refund when the sender script is unknown', async () => {
    const live = await startApp();
    live.synthesize.mockRejectedValueOnce(new TtsSynthError('boom'));
    live.verifyPayment.mockResolvedValueOnce({
      ok: true as const,
      receivedSats: 1000,
      voutIndex: 0,
      senderScriptHex: '',
    });
    const { rec } = await quoted(live);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await fetch(`${live.url}/api/tts/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quoteId: rec.quoteId, rawTx: RAW_TX, text: 'hello' }),
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: { code: 'TTS_SYNTH_FAILED', refunded: false } });
    expect(live.buildRefundTx).not.toHaveBeenCalled();
    expect(live.store.getById(rec.id)?.status).toBe('failed');
    errSpy.mockRestore();
  });
});

describe('GET /api/tts/audio/:purchaseId and admin enable', () => {
  it('404s unknown, invalid or undelivered audio ids', async () => {
    const live = await startApp();
    const rec = live.store.createQuote({ chars: 5, satoshis: 1 });
    const bad = await fetch(`${live.url}/api/tts/audio/not-an-id`);
    expect(bad.status).toBe(404);
    const missing = await fetch(`${live.url}/api/tts/audio/${rec.id}`);
    expect(missing.status).toBe(404);
  });

  it('serves delivered audio inline, or as a named attachment when download=1', async () => {
    const live = await startApp();
    const rec = live.store.createQuote({ chars: 5, satoshis: 1 });
    await writeFile(join(live.audioDir, `${rec.id}.mp3`), 'ID3fake');
    live.store.markPaid(rec.id, TXID);
    live.store.markDelivered(rec.id, `${rec.id}.mp3`, 1.5);

    const headerText = (headers: Headers, name: string): string => {
      const value = headers.get(name);
      return typeof value === 'string' ? value : JSON.stringify(value ?? '');
    };

    const inline = await fetch(`${live.url}/api/tts/audio/${rec.id}`);
    expect(inline.status).toBe(200);
    expect(inline.headers.get('content-type')).toMatch(/audio\/mpeg/);
    expect(headerText(inline.headers, 'content-disposition')).toMatch(/inline/i);
    expect(headerText(inline.headers, 'content-disposition')).not.toMatch(/attachment/i);

    const download = await fetch(`${live.url}/api/tts/audio/${rec.id}?download=1`);
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toMatch(/audio\/mpeg/);
    expect(headerText(download.headers, 'content-disposition')).toMatch(/attachment/i);
    expect(headerText(download.headers, 'content-disposition')).toMatch(/ask-satoshi-read-aloud\.mp3/i);
    expect(Buffer.from(await download.arrayBuffer()).toString()).toBe('ID3fake');
  });

  it('re-enables via bearer admin token and rejects a bad token', async () => {
    const live = await startApp();
    live.state.disable('credit-exhausted');
    const denied = await fetch(`${live.url}/api/tts/admin/enable`, {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong' },
    });
    expect(denied.status).toBe(403);

    const ok = await fetch(`${live.url}/api/tts/admin/enable`, {
      method: 'POST',
      headers: { Authorization: 'Bearer admin-secret' },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ enabled: true });
    expect(live.state.getState().disabled).toBe(false);
  });
});
