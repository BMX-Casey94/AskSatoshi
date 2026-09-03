/**
 * Treasury wallet: derive the P2PKH receive address from TREASURY_WIF, verify a
 * user payment from its raw transaction, broadcast it to WhatsOnChain, and build
 * a 1-in/1-out refund back to the sender's locking script. The server broadcasts
 * so the user is never waiting on wallet-to-explorer propagation.
 */

import { LockingScript, P2PKH, PrivateKey, Transaction } from '@bsv/sdk';

export const REFUND_FEE_SATS = 250;

const WOC_BROADCAST = 'https://api.whatsonchain.com/v1/bsv/main/tx/raw';

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

/**
 * Decode the raw transaction, confirm it pays the treasury at least the quoted
 * amount, then broadcast it. No explorer lookup — the server is the first to
 * know the tx exists, so the user gets their audio as soon as synthesis returns.
 */
export async function verifyPayment(opts: {
  rawTx: string;
  expectedSats: number;
  treasuryScriptHex: string;
  fetchFn?: typeof fetch;
}): Promise<VerifyPaymentResult> {
  let tx: Transaction;
  try {
    tx = Transaction.fromHex(opts.rawTx);
  } catch {
    return { ok: false, reason: 'invalid-tx' };
  }

  const dest = opts.treasuryScriptHex.toLowerCase();
  const matchIndex = tx.outputs.findIndex((o) => o.lockingScript.toHex().toLowerCase() === dest);
  if (matchIndex < 0) return { ok: false, reason: 'wrong-destination' };

  const match = tx.outputs[matchIndex]!;
  const receivedSats = match.satoshis ?? 0;
  if (receivedSats < opts.expectedSats) return { ok: false, reason: 'underpaid' };

  const senderScriptHex = tx.inputs[0]?.sourceTransaction?.outputs[tx.inputs[0]!.sourceOutputIndex]?.lockingScript.toHex() ?? '';

  const txid = tx.id('hex');
  try {
    await broadcastTx(opts.rawTx, opts.fetchFn);
  } catch (err) {
    console.warn('[tts] broadcast failed:', err instanceof Error ? err.message : err);
    return { ok: false, reason: 'broadcast-failed' };
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
