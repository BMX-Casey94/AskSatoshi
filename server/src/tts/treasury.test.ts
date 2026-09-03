import { describe, expect, it, vi } from 'vitest';
import { P2PKH, PrivateKey } from '@bsv/sdk';
import { REFUND_FEE_SATS, buildRefundTx, treasuryFromWif, verifyPayment } from './treasury.js';

const TREASURY_SCRIPT = '76a91489abcdef0123456789abcdef0123456789abcdef88ac';
const SENDER_SCRIPT = '76a91400112233445566778899aabbccddeeff0011223388ac';
const PAYMENT_TXID = 'aa'.repeat(32);
const SOURCE_TXID = 'bb'.repeat(32);

function wocTx(txid: string, vouts: { value: number; hex: string }[], vin = [{ txid: SOURCE_TXID, vout: 0 }]) {
  return {
    txid,
    vin,
    vout: vouts.map((v) => ({
      value: v.value,
      scriptPubKey: { hex: v.hex, addresses: ['1Fake'] },
    })),
  };
}

function fetchMap(routes: Record<string, unknown | number>): typeof fetch {
  return async (input) => {
    const url = String(input);
    const match = Object.entries(routes).find(([key]) => url.includes(key));
    if (!match) return new Response('missing', { status: 404 });
    const body = match[1];
    if (typeof body === 'number') return new Response('err', { status: body });
    return new Response(JSON.stringify(body), { status: 200 });
  };
}

describe('verifyPayment', () => {
  it('accepts a treasury output at or above the expected sats and extracts the sender script', async () => {
    const fetchFn = fetchMap({
      [`/tx/${PAYMENT_TXID}`]: wocTx(PAYMENT_TXID, [{ value: 0.000075, hex: TREASURY_SCRIPT }]),
      [`/tx/${SOURCE_TXID}`]: wocTx(SOURCE_TXID, [{ value: 0.001, hex: SENDER_SCRIPT }]),
    });
    const result = await verifyPayment({
      txid: PAYMENT_TXID,
      expectedSats: 7500,
      treasuryScriptHex: TREASURY_SCRIPT,
      fetchFn,
    });
    expect(result).toEqual({
      ok: true,
      receivedSats: 7500,
      voutIndex: 0,
      senderScriptHex: SENDER_SCRIPT,
    });
  });

  it('returns underpaid when the treasury output is below the expected sats', async () => {
    const fetchFn = fetchMap({
      [`/tx/${PAYMENT_TXID}`]: wocTx(PAYMENT_TXID, [{ value: 0.00001, hex: TREASURY_SCRIPT }]),
      [`/tx/${SOURCE_TXID}`]: wocTx(SOURCE_TXID, [{ value: 0.001, hex: SENDER_SCRIPT }]),
    });
    const result = await verifyPayment({
      txid: PAYMENT_TXID,
      expectedSats: 7500,
      treasuryScriptHex: TREASURY_SCRIPT,
      fetchFn,
    });
    expect(result).toEqual({ ok: false, reason: 'underpaid' });
  });

  it('returns wrong-destination when no output pays the treasury script', async () => {
    const fetchFn = fetchMap({
      [`/tx/${PAYMENT_TXID}`]: wocTx(PAYMENT_TXID, [{ value: 0.000075, hex: '76a914ffffffffffffffffffffffffffffffffffffffff88ac' }]),
    });
    const result = await verifyPayment({
      txid: PAYMENT_TXID,
      expectedSats: 7500,
      treasuryScriptHex: TREASURY_SCRIPT,
      fetchFn,
    });
    expect(result).toEqual({ ok: false, reason: 'wrong-destination' });
  });

  it('returns not-found when WhatsOnChain has no such transaction', async () => {
    vi.useFakeTimers();
    try {
      const fetchFn = fetchMap({ [`/tx/${PAYMENT_TXID}`]: 404 });
      const promise = verifyPayment({
        txid: PAYMENT_TXID,
        expectedSats: 7500,
        treasuryScriptHex: TREASURY_SCRIPT,
        fetchFn,
      });
      await vi.runAllTimersAsync();
      const result = await promise;
      expect(result).toEqual({ ok: false, reason: 'not-found' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a not-found payment until it appears on the explorer', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const fetchFn: typeof fetch = async (input) => {
        calls += 1;
        if (calls < 3) return new Response('missing', { status: 404 });
        return new Response(
          JSON.stringify(
            wocTx(PAYMENT_TXID, [{ value: 0.000075, hex: TREASURY_SCRIPT }], [{ txid: SOURCE_TXID, vout: 0 }]),
          ),
          { status: 200 },
        );
      };
      const promise = verifyPayment({
        txid: PAYMENT_TXID,
        expectedSats: 7500,
        treasuryScriptHex: TREASURY_SCRIPT,
        fetchFn,
      });
      await vi.runAllTimersAsync();
      const result = await promise;
      expect(calls).toBe(4); // 2 misses + payment hit + sender-script lookup
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.receivedSats).toBe(7500);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns lookup-failed when the explorer request errors', async () => {
    const fetchFn = async () => {
      throw new Error('network down');
    };
    const result = await verifyPayment({
      txid: PAYMENT_TXID,
      expectedSats: 7500,
      treasuryScriptHex: TREASURY_SCRIPT,
      fetchFn,
    });
    expect(result).toEqual({ ok: false, reason: 'lookup-failed' });
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
      paymentTxid: PAYMENT_TXID,
      voutIndex: 0,
      receivedSats: 10_000,
      senderScriptHex: sender,
      treasuryKey: key,
    });
    expect(hex).toMatch(/^[0-9a-f]+$/);
    expect(hex!.length).toBeGreaterThan(200);

    const dust = await buildRefundTx({
      paymentTxid: PAYMENT_TXID,
      voutIndex: 0,
      receivedSats: REFUND_FEE_SATS,
      senderScriptHex: sender,
      treasuryKey: key,
    });
    expect(dust).toBeNull();
  });
});
