import { describe, expect, it, vi } from 'vitest';
import { P2PKH, PrivateKey, Transaction } from '@bsv/sdk';
import { REFUND_FEE_SATS, buildRefundTx, treasuryFromWif, verifyPayment } from './treasury.js';

const TREASURY_KEY = PrivateKey.fromRandom();
const TREASURY = treasuryFromWif(TREASURY_KEY.toWif());
const SENDER_KEY = PrivateKey.fromRandom();
const SENDER_SCRIPT = new P2PKH().lock(SENDER_KEY.toPublicKey().toAddress()).toHex();

/** Build a real signed tx paying the treasury, with the source tx embedded. */
async function makePayment(satoshis: number): Promise<string> {
  const sourceTx = new Transaction();
  sourceTx.addInput({
    sourceTXID: '00'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScriptTemplate: new P2PKH().unlock(SENDER_KEY, 'all', false, 100_000, new P2PKH().lock(SENDER_KEY.toPublicKey().toAddress())),
  });
  sourceTx.addOutput({ lockingScript: new P2PKH().lock(SENDER_KEY.toPublicKey().toAddress()), satoshis: 100_000 });
  await sourceTx.sign();

  const tx = new Transaction();
  tx.addInput({
    sourceTransaction: sourceTx,
    sourceOutputIndex: 0,
    unlockingScriptTemplate: new P2PKH().unlock(SENDER_KEY, 'all', false, 100_000, sourceTx.outputs[0]!.lockingScript),
  });
  tx.addOutput({ lockingScript: new P2PKH().lock(TREASURY.address), satoshis });
  await tx.sign();
  return tx.toHex();
}

describe('verifyPayment', () => {
  it('accepts a raw tx paying the treasury and returns the sender script', async () => {
    const raw = await makePayment(7_500);
    const parsed = Transaction.fromHex(raw);
    const embedded = parsed.inputs[0]?.sourceTransaction?.outputs[0]?.lockingScript.toHex() ?? '';
    const broadcast = vi.fn(async () => new Response(JSON.stringify({ txid: 'ab'.repeat(32) }), { status: 200 }));
    const result = await verifyPayment({
      rawTx: raw,
      expectedSats: 7_500,
      treasuryScriptHex: TREASURY.lockingScriptHex,
      fetchFn: broadcast,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.receivedSats).toBe(7_500);
      expect(result.voutIndex).toBe(0);
      expect(result.senderScriptHex).toBe(embedded);
      expect(result.txid).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(broadcast).toHaveBeenCalledOnce();
  });

  it('rejects an underpaid tx', async () => {
    const raw = await makePayment(1_000);
    const result = await verifyPayment({
      rawTx: raw,
      expectedSats: 7_500,
      treasuryScriptHex: TREASURY.lockingScriptHex,
      fetchFn: vi.fn(),
    });
    expect(result).toEqual({ ok: false, reason: 'underpaid' });
  });

  it('rejects a tx that does not pay the treasury', async () => {
    const other = PrivateKey.fromRandom();
    const sourceTx = new Transaction();
    sourceTx.addInput({
      sourceTXID: '00'.repeat(32),
      sourceOutputIndex: 0,
      unlockingScriptTemplate: new P2PKH().unlock(SENDER_KEY, 'all', false, 100_000, new P2PKH().lock(SENDER_KEY.toPublicKey().toAddress())),
    });
    sourceTx.addOutput({ lockingScript: new P2PKH().lock(SENDER_KEY.toPublicKey().toAddress()), satoshis: 100_000 });
    await sourceTx.sign();
    const tx = new Transaction();
    tx.addInput({
      sourceTransaction: sourceTx,
      sourceOutputIndex: 0,
      unlockingScriptTemplate: new P2PKH().unlock(SENDER_KEY, 'all', false, 100_000, sourceTx.outputs[0]!.lockingScript),
    });
    tx.addOutput({ lockingScript: new P2PKH().lock(other.toPublicKey().toAddress()), satoshis: 7_500 });
    await tx.sign();

    const result = await verifyPayment({
      rawTx: tx.toHex(),
      expectedSats: 7_500,
      treasuryScriptHex: TREASURY.lockingScriptHex,
      fetchFn: vi.fn(),
    });
    expect(result).toEqual({ ok: false, reason: 'wrong-destination' });
  });

  it('rejects malformed hex', async () => {
    const result = await verifyPayment({
      rawTx: 'not-hex',
      expectedSats: 7_500,
      treasuryScriptHex: TREASURY.lockingScriptHex,
      fetchFn: vi.fn(),
    });
    expect(result).toEqual({ ok: false, reason: 'invalid-tx' });
  });

  it('returns broadcast-failed when the explorer rejects the tx', async () => {
    const raw = await makePayment(7_500);
    const broadcast = vi.fn(async () => new Response('bad tx', { status: 400 }));
    const result = await verifyPayment({
      rawTx: raw,
      expectedSats: 7_500,
      treasuryScriptHex: TREASURY.lockingScriptHex,
      fetchFn: broadcast,
    });
    expect(result).toEqual({ ok: false, reason: 'broadcast-failed' });
  });
});

describe('treasuryFromWif and buildRefundTx', () => {
  it('derives a P2PKH address and locking script from a WIF', () => {
    const key = PrivateKey.fromRandom();
    const ident = treasuryFromWif(key.toWif());
    expect(ident.address).toMatch(/^[13][A-HJ-NP-Za-km-z1-9]{24,33}$/);
    expect(ident.lockingScriptHex).toMatch(/^76a914[0-9a-f]{40}88ac$/);
    expect(ident.key.toWif()).toBe(key.toWif());
  });

  it('builds a signed 1-in/1-out refund and skips dust', async () => {
    const key = PrivateKey.fromRandom();
    const sender = new P2PKH().lock(PrivateKey.fromRandom().toAddress()).toHex();
    const hex = await buildRefundTx({
      paymentTxid: 'aa'.repeat(32),
      voutIndex: 0,
      receivedSats: 10_000,
      senderScriptHex: sender,
      treasuryKey: key,
    });
    expect(hex).toMatch(/^[0-9a-f]+$/);
    expect(hex!.length).toBeGreaterThan(200);

    const dust = await buildRefundTx({
      paymentTxid: 'aa'.repeat(32),
      voutIndex: 0,
      receivedSats: REFUND_FEE_SATS,
      senderScriptHex: sender,
      treasuryKey: key,
    });
    expect(dust).toBeNull();
  });
});
