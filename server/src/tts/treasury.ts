/**
 * Treasury wallet: derive the P2PKH receive address from TREASURY_WIF, verify a
 * user payment on WhatsOnChain (0-conf is deliberate — amounts are under a dollar),
 * and build a 1-in/1-out refund back to the sender's locking script.
 */

import { LockingScript, P2PKH, PrivateKey, Transaction } from '@bsv/sdk';

export const REFUND_FEE_SATS = 250;

const WOC_TX = (txid: string) => `https://api.whatsonchain.com/v1/bsv/main/tx/${txid}`;
const WOC_BROADCAST = 'https://api.whatsonchain.com/v1/bsv/main/tx/raw';

export interface TreasuryIdentity {
  key: PrivateKey;
  address: string;
  lockingScriptHex: string;
}

export type PaymentFailReason = 'not-found' | 'underpaid' | 'wrong-destination' | 'lookup-failed';

export type VerifyPaymentResult =
  | { ok: true; receivedSats: number; voutIndex: number; senderScriptHex: string }
  | { ok: false; reason: PaymentFailReason };

interface WocVout {
  value?: number;
  scriptPubKey?: { hex?: string; addresses?: string[] };
}

interface WocVin {
  txid?: string;
  vout?: number;
}

interface WocTx {
  txid?: string;
  vin?: WocVin[];
  vout?: WocVout[];
}

export function treasuryFromWif(wif: string): TreasuryIdentity {
  const key = PrivateKey.fromWif(wif);
  const address = key.toPublicKey().toAddress();
  const lockingScriptHex = new P2PKH().lock(address).toHex();
  return { key, address, lockingScriptHex };
}

async function fetchTx(txid: string, fetchFn: typeof fetch): Promise<{ status: number; json: WocTx | null }> {
  const res = await fetchFn(WOC_TX(txid));
  if (!res.ok) return { status: res.status, json: null };
  try {
    return { status: res.status, json: (await res.json()) as WocTx };
  } catch {
    return { status: res.status, json: null };
  }
}

function bsvToSats(value: number): number {
  return Math.round(value * 1e8);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** How many times to retry a 404 before declaring the payment missing. */
const PAYMENT_LOOKUP_RETRIES = 3;
/** Delay between retries — mempool propagation to the explorer is not instant. */
const PAYMENT_LOOKUP_RETRY_MS = 2_000;

export async function verifyPayment(opts: {
  txid: string;
  expectedSats: number;
  treasuryScriptHex: string;
  fetchFn?: typeof fetch;
}): Promise<VerifyPaymentResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  let payment: { status: number; json: WocTx | null } | null = null;
  for (let attempt = 0; attempt < PAYMENT_LOOKUP_RETRIES; attempt++) {
    try {
      payment = await fetchTx(opts.txid, fetchFn);
    } catch (err) {
      console.warn('[tts] payment lookup failed:', err instanceof Error ? err.message : err);
      return { ok: false, reason: 'lookup-failed' };
    }

    if (payment.status === 404 || (payment.status >= 200 && payment.status < 300 && !payment.json)) {
      if (attempt < PAYMENT_LOOKUP_RETRIES - 1) {
        console.info(`[tts] payment ${opts.txid} not yet on explorer; retrying (${attempt + 1}/${PAYMENT_LOOKUP_RETRIES})`);
        await sleep(PAYMENT_LOOKUP_RETRY_MS);
        continue;
      }
      console.warn(`[tts] payment ${opts.txid} not found on explorer after ${PAYMENT_LOOKUP_RETRIES} attempts`);
      return { ok: false, reason: 'not-found' };
    }
    if (!payment.json || payment.status >= 400) {
      return { ok: false, reason: payment.status === 404 ? 'not-found' : 'lookup-failed' };
    }
    break;
  }
  if (!payment?.json) {
    return { ok: false, reason: 'lookup-failed' };
  }

  const vouts = payment.json.vout ?? [];
  const dest = opts.treasuryScriptHex.toLowerCase();
  const matchIndex = vouts.findIndex((v) => (v.scriptPubKey?.hex ?? '').toLowerCase() === dest);
  if (matchIndex < 0) return { ok: false, reason: 'wrong-destination' };

  const match = vouts[matchIndex]!;
  const receivedSats = bsvToSats(Number(match.value ?? 0));
  if (receivedSats < opts.expectedSats) return { ok: false, reason: 'underpaid' };

  const vin0 = payment.json.vin?.[0];
  let senderScriptHex = '';
  if (vin0?.txid) {
    try {
      const source = await fetchTx(vin0.txid, fetchFn);
      const srcVout = source.json?.vout?.[vin0.vout ?? 0];
      senderScriptHex = srcVout?.scriptPubKey?.hex ?? '';
    } catch (err) {
      console.warn('[tts] sender-script lookup failed:', err instanceof Error ? err.message : err);
    }
  }

  return { ok: true, receivedSats, voutIndex: matchIndex, senderScriptHex };
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
