/**
 * Treasury wallet: derive the P2PKH receive address from TREASURY_WIF, verify a
 * user payment from its raw transaction or Atomic BEEF, broadcast the subject
 * transaction to WhatsOnChain, and build a 1-in/1-out refund back to the sender.
 * BRC-100 wallets return Atomic BEEF and often broadcast before we do.
 */

import { LockingScript, P2PKH, PrivateKey, Transaction } from '@bsv/sdk';

export const REFUND_FEE_SATS = 250;

const WOC_BROADCAST = 'https://api.whatsonchain.com/v1/bsv/main/tx/raw';
const ATOMIC_BEEF_PREFIX = '01010101';
const BEEF_MAGIC = '0100beef';
const ALREADY_ON_NETWORK =
  /already[- ]?(known|exists|in(?: the)? mempool)|txn-already-known|duplicate[- ]tx/i;

export interface TreasuryIdentity {
  key: PrivateKey;
  address: string;
  lockingScriptHex: string;
}

export type PaymentFailReason = 'invalid-tx' | 'underpaid' | 'wrong-destination' | 'broadcast-failed';

export type VerifyPaymentResult =
  | { ok: true; txid: string; receivedSats: number; voutIndex: number; senderScriptHex: string }
  | { ok: false; reason: PaymentFailReason };

export function treasuryFromWif(wif: string): TreasuryIdentity {
  const key = PrivateKey.fromWif(wif);
  const address = key.toPublicKey().toAddress();
  const lockingScriptHex = new P2PKH().lock(address).toHex();
  return { key, address, lockingScriptHex };
}

function hexToBytes(hex: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(Number.parseInt(hex.slice(i, i + 2), 16));
  }
  return bytes;
}

function reject(reason: PaymentFailReason, detail?: string): VerifyPaymentResult {
  console.warn(`[tts] payment rejected: ${reason}${detail ? ` (${detail})` : ''}`);
  return { ok: false, reason };
}

/** BRC-100 wallets return Atomic BEEF; some also send raw hex, BEEF, or EF. */
export function parsePaymentTx(hex: string): Transaction {
  const clean = hex.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(clean) || clean.length % 2 !== 0) {
    throw new Error('not hex');
  }
  const bytes = hexToBytes(clean);

  if (clean.startsWith(ATOMIC_BEEF_PREFIX)) {
    return Transaction.fromAtomicBEEF(bytes);
  }
  if (clean.startsWith(BEEF_MAGIC)) {
    return Transaction.fromHexBEEF(clean);
  }

  try {
    return Transaction.fromHex(clean);
  } catch (rawErr) {
    try {
      return Transaction.fromAtomicBEEF(bytes);
    } catch {
      try {
        return Transaction.fromHexBEEF(clean);
      } catch {
        try {
          return Transaction.fromHexEF(clean);
        } catch {
          throw rawErr instanceof Error ? rawErr : new Error('invalid-tx');
        }
      }
    }
  }
}

export function isAlreadyOnNetwork(status: number, body: string): boolean {
  if (status >= 200 && status < 300) return false;
  return ALREADY_ON_NETWORK.test(body);
}

/**
 * Decode the payment (raw hex or Atomic BEEF), confirm it pays the treasury at
 * least the quoted amount, then broadcast the raw subject transaction. A
 * wallet that already pushed the same tx is treated as paid.
 */
export async function verifyPayment(opts: {
  rawTx: string;
  expectedSats: number;
  treasuryScriptHex: string;
  fetchFn?: typeof fetch;
}): Promise<VerifyPaymentResult> {
  let tx: Transaction;
  try {
    tx = parsePaymentTx(opts.rawTx);
  } catch (err) {
    return reject('invalid-tx', err instanceof Error ? err.message : undefined);
  }

  const dest = opts.treasuryScriptHex.toLowerCase();
  const matchIndex = tx.outputs.findIndex((o) => o.lockingScript.toHex().toLowerCase() === dest);
  if (matchIndex < 0) return reject('wrong-destination');

  const match = tx.outputs[matchIndex]!;
  const receivedSats = match.satoshis ?? 0;
  if (receivedSats < opts.expectedSats) return reject('underpaid');

  const senderScriptHex =
    tx.inputs[0]?.sourceTransaction?.outputs[tx.inputs[0]!.sourceOutputIndex]?.lockingScript.toHex() ?? '';

  const txid = tx.id('hex');
  const rawHex = tx.toHex();
  try {
    await broadcastTx(rawHex, opts.fetchFn);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isAlreadyOnNetwork(400, message)) {
      console.info('[tts] payment already on the network:', txid);
      return { ok: true, txid, receivedSats, voutIndex: matchIndex, senderScriptHex };
    }
    console.warn('[tts] broadcast failed:', message);
    return reject('broadcast-failed', message);
  }

  return { ok: true, txid, receivedSats, voutIndex: matchIndex, senderScriptHex };
}

export async function buildRefundTx(opts: {
  paymentTxid: string;
  voutIndex: number;
  receivedSats: number;
  senderScriptHex: string;
  treasuryKey: PrivateKey;
}): Promise<string | null> {
  const refundSats = opts.receivedSats - REFUND_FEE_SATS;
  if (refundSats <= 0) {
    console.warn('[tts] refund skipped: output would be dust');
    return null;
  }

  const treasuryScript = new P2PKH().lock(opts.treasuryKey.toPublicKey().toAddress());
  const tx = new Transaction();
  tx.addInput({
    sourceTXID: opts.paymentTxid,
    sourceOutputIndex: opts.voutIndex,
    unlockingScriptTemplate: new P2PKH().unlock(
      opts.treasuryKey,
      'all',
      false,
      opts.receivedSats,
      treasuryScript,
    ),
  });
  tx.addOutput({
    lockingScript: LockingScript.fromHex(opts.senderScriptHex),
    satoshis: refundSats,
  });
  await tx.sign();
  return tx.toHex();
}

export async function broadcastTx(rawHex: string, fetchFn: typeof fetch = fetch): Promise<string> {
  const res = await fetchFn(WOC_BROADCAST, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txhex: rawHex }),
  });
  const text = await res.text();
  if (!res.ok) {
    if (isAlreadyOnNetwork(res.status, text)) {
      return text.trim().replace(/^"|"$/g, '') || 'already-known';
    }
    throw new Error(`broadcast failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const trimmed = text.trim().replace(/^"|"$/g, '');
  try {
    const json = JSON.parse(text) as { txid?: string } | string;
    if (typeof json === 'string' && /^[0-9a-fA-F]{64}$/.test(json)) return json;
    if (typeof json === 'object' && json && typeof json.txid === 'string') return json.txid;
  } catch {
    if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return trimmed;
  }
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return trimmed;
  throw new Error(`broadcast returned unexpected body: ${text.slice(0, 200)}`);
}
