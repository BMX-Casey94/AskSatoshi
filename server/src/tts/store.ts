/**
 * JSON-file purchase store. Loaded into memory at boot and persisted on every
 * mutation via a temp-file + rename so a crash mid-write cannot truncate the ledger.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const QUOTE_TTL_MS = 10 * 60 * 1000;

export type PurchaseStatus = 'quoted' | 'paid' | 'delivered' | 'refunded' | 'failed';

export interface Purchase {
  id: string;
  quoteId: string;
  txid: string | null;
  chars: number;
  satoshis: number;
  status: PurchaseStatus;
  audioFile: string | null;
  durationSeconds: number | null;
  refundTxid: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface TtsStore {
  createQuote(input: { chars: number; satoshis: number }): Purchase;
  getByQuoteId(id: string): Purchase | undefined;
  getByTxid(txid: string): Purchase | undefined;
  getById(id: string): Purchase | undefined;
  markPaid(id: string, txid: string): Purchase;
  markDelivered(id: string, audioFile: string, durationSeconds: number): Purchase;
  markFailed(id: string): Purchase;
  markRefunded(id: string, refundTxid: string): Purchase;
}

const DEFAULT_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../data/runtime/tts-purchases.json');

function randomId(prefix: 'p' | 'q'): string {
  return `${prefix}_${randomBytes(12).toString('base64url')}`;
}

function atomicWrite(filePath: string, contents: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, contents, 'utf8');
  try {
    renameSync(tmp, filePath);
  } catch {
    // Windows cannot rename over an existing destination; replace then rename.
    if (existsSync(filePath)) unlinkSync(filePath);
    renameSync(tmp, filePath);
  }
}

interface DiskShape {
  purchases: Purchase[];
}

export function createTtsStore(filePath: string = DEFAULT_PATH): TtsStore {
  const byId = new Map<string, Purchase>();
  const byQuoteId = new Map<string, string>();
  const byTxid = new Map<string, string>();

  const persist = () => {
    const disk: DiskShape = { purchases: [...byId.values()] };
    atomicWrite(filePath, JSON.stringify(disk, null, 2));
  };

  const load = () => {
    if (!existsSync(filePath)) return;
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf8')) as DiskShape;
      for (const rec of raw.purchases ?? []) {
        byId.set(rec.id, rec);
        byQuoteId.set(rec.quoteId, rec.id);
        if (rec.txid) byTxid.set(rec.txid, rec.id);
      }
    } catch (err) {
      console.warn('[tts] purchase store unreadable; starting empty:', err instanceof Error ? err.message : err);
    }
  };

  const must = (id: string): Purchase => {
    const rec = byId.get(id);
    if (!rec) throw new Error(`unknown purchase ${id}`);
    return rec;
  };

  const touch = (rec: Purchase, patch: Partial<Purchase>): Purchase => {
    const next = { ...rec, ...patch, updatedAt: Date.now() };
    byId.set(rec.id, next);
    persist();
    return next;
  };

  load();

  return {
    createQuote({ chars, satoshis }) {
      const now = Date.now();
      const rec: Purchase = {
        id: randomId('p'),
        quoteId: randomId('q'),
        txid: null,
        chars,
        satoshis,
        status: 'quoted',
        audioFile: null,
        durationSeconds: null,
        refundTxid: null,
        createdAt: now,
        updatedAt: now,
      };
      byId.set(rec.id, rec);
      byQuoteId.set(rec.quoteId, rec.id);
      persist();
      return rec;
    },
    getByQuoteId(id) {
      const pid = byQuoteId.get(id);
      return pid ? byId.get(pid) : undefined;
    },
    getByTxid(txid) {
      const pid = byTxid.get(txid);
      return pid ? byId.get(pid) : undefined;
    },
    getById(id) {
      return byId.get(id);
    },
    markPaid(id, txid) {
      const rec = must(id);
      byTxid.set(txid, rec.id);
      return touch(rec, { status: 'paid', txid });
    },
    markDelivered(id, audioFile, durationSeconds) {
      return touch(must(id), { status: 'delivered', audioFile, durationSeconds });
    },
    markFailed(id) {
      return touch(must(id), { status: 'failed' });
    },
    markRefunded(id, refundTxid) {
      return touch(must(id), { status: 'refunded', refundTxid });
    },
  };
}
