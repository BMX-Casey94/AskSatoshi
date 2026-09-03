import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { QUOTE_TTL_MS, createTtsStore } from './store.js';

const dirs: string[] = [];

async function tmpStorePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tts-store-'));
  dirs.push(dir);
  return join(dir, 'tts-purchases.json');
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('TtsStore', () => {
  it('creates a quoted purchase and looks it up by quote id and record id', async () => {
    const store = createTtsStore(await tmpStorePath());
    const rec = store.createQuote({ chars: 1500, satoshis: 996000 });
    expect(rec.id).toMatch(/^p_[A-Za-z0-9_-]+$/);
    expect(rec.quoteId).toMatch(/^q_[A-Za-z0-9_-]+$/);
    expect(rec.status).toBe('quoted');
    expect(rec.txid).toBeNull();
    expect(rec.chars).toBe(1500);
    expect(rec.satoshis).toBe(996000);
    expect(store.getByQuoteId(rec.quoteId)?.id).toBe(rec.id);
    expect(store.getById(rec.id)?.quoteId).toBe(rec.quoteId);
  });

  it('marks paid, delivered, failed and refunded, and finds a purchase by txid', async () => {
    const store = createTtsStore(await tmpStorePath());
    const rec = store.createQuote({ chars: 100, satoshis: 500 });
    const txid = 'a'.repeat(64);
    store.markPaid(rec.id, txid);
    expect(store.getById(rec.id)?.status).toBe('paid');
    expect(store.getByTxid(txid)?.id).toBe(rec.id);

    store.markDelivered(rec.id, `${rec.id}.mp3`, 12.5);
    expect(store.getById(rec.id)?.status).toBe('delivered');
    expect(store.getById(rec.id)?.audioFile).toBe(`${rec.id}.mp3`);
    expect(store.getById(rec.id)?.durationSeconds).toBe(12.5);

    const failed = store.createQuote({ chars: 100, satoshis: 500 });
    store.markFailed(failed.id);
    expect(store.getById(failed.id)?.status).toBe('failed');

    const refunded = store.createQuote({ chars: 100, satoshis: 500 });
    store.markRefunded(refunded.id, 'b'.repeat(64));
    expect(store.getById(refunded.id)?.status).toBe('refunded');
    expect(store.getById(refunded.id)?.refundTxid).toBe('b'.repeat(64));
  });

  it('persists mutations to disk and reloads them from a new instance', async () => {
    const path = await tmpStorePath();
    const store = createTtsStore(path);
    const rec = store.createQuote({ chars: 200, satoshis: 900 });
    store.markPaid(rec.id, 'c'.repeat(64));

    const raw = JSON.parse(await readFile(path, 'utf8')) as { purchases: { id: string }[] };
    expect(raw.purchases.some((p) => p.id === rec.id)).toBe(true);

    const reloaded = createTtsStore(path);
    const again = reloaded.getById(rec.id);
    expect(again?.status).toBe('paid');
    expect(again?.txid).toBe('c'.repeat(64));
    expect(again?.chars).toBe(200);
  });

  it('exposes QUOTE_TTL_MS as ten minutes for expiry checks at use time', () => {
    expect(QUOTE_TTL_MS).toBe(10 * 60 * 1000);
  });
});
