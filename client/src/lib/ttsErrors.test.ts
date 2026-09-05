import { describe, expect, it } from 'vitest';
import { describeTtsError, encodeWalletTx, friendlyTtsError } from './ttsErrors';

class CodedError extends Error {
  readonly code: string;
  readonly refunded?: boolean;
  readonly reason?: string;
  readonly refundTxid?: string;
  constructor(code: string, message: string, extra: { refunded?: boolean; reason?: string; refundTxid?: string } = {}) {
    super(message);
    this.name = 'TtsApiError';
    this.code = code;
    this.refunded = extra.refunded;
    this.reason = extra.reason;
    this.refundTxid = extra.refundTxid;
  }
}

describe('encodeWalletTx', () => {
  it('encodes number[], Uint8Array and hex strings', () => {
    expect(encodeWalletTx([1, 1, 1, 1, 255])).toBe('01010101ff');
    expect(encodeWalletTx(Uint8Array.from([1, 1, 1, 1, 255]))).toBe('01010101ff');
    expect(encodeWalletTx('01010101FF')).toBe('01010101FF');
  });

  it('rejects objects, odd-length hex and non-byte arrays', () => {
    expect(encodeWalletTx({ tx: [1] })).toBeNull();
    expect(encodeWalletTx('abc')).toBeNull();
    expect(encodeWalletTx([1.5, 2])).toBeNull();
    expect(encodeWalletTx(undefined)).toBeNull();
  });
});

describe('friendlyTtsError refund copy', () => {
  it('never claims nothing was charged when a payment could not be verified', () => {
    const message = friendlyTtsError(
      new CodedError('TTS_PAYMENT_INVALID', 'Payment could not be verified.', { reason: 'invalid-tx' }),
    );
    expect(message.toLowerCase()).not.toContain('nothing was charged');
    expect(message.toLowerCase()).toContain('contact us');
    expect(message.toLowerCase()).toContain('transaction id');
  });

  it('explains an immediate 0-conf refund after a failed synthesis', () => {
    const message = friendlyTtsError(
      new CodedError('TTS_SYNTH_FAILED', 'Speech synthesis failed.', { refunded: true }),
    );
    expect(message.toLowerCase()).toContain('refunded');
    expect(message.toLowerCase()).toContain('few seconds');
    expect(message.toLowerCase()).toContain('0-conf');
  });

  it('tells the user the treasury still holds the sats when a refund could not be sent', () => {
    const message = friendlyTtsError(
      new CodedError('TTS_SYNTH_FAILED', 'Speech synthesis failed.', { refunded: false }),
    );
    expect(message.toLowerCase()).toContain('treasury');
    expect(message.toLowerCase()).toContain('contact us');
  });

  it('surfaces the refund txid when the server returned one', () => {
    const described = describeTtsError(
      new CodedError('TTS_SYNTH_FAILED', 'Speech synthesis failed.', {
        refunded: true,
        refundTxid: 'ab'.repeat(32),
      }),
    );
    expect(described.refunded).toBe(true);
    expect(described.refundTxid).toBe('ab'.repeat(32));
  });
});

const WALLET_INSUFFICIENT_FUNDS_JSON =
  '{"call":"createAction","args":{"description":"Ask Satoshi — read aloud","outputs":[{"satoshis":1151414,"lockingScript":"76a91479efbd2c9ee11080c9272b452bf8e19e5905376188ac","outputDescription":"Read-aloud synthesis"}]},"message":"RPC Error: Insufficient funds in the available inputs to cover the cost of the required outputs and the transaction fee (1147613 more satoshis are needed, for a total of 1151890), plus whatever would be required in order to pay the fee to unlock and spend the outputs used to provide the additional satoshis."}';

function expectNoTechnicalLeak(message: string): void {
  expect(message).not.toMatch(/[{[]/);
  expect(message.toLowerCase()).not.toContain('lockingScript'.toLowerCase());
  expect(message.toLowerCase()).not.toContain('createaction');
  expect(message.toLowerCase()).not.toContain('rpc error');
  expect(message).not.toMatch(/76a914[0-9a-fA-F]+88ac/);
}

describe('friendlyTtsError wallet dumps', () => {
  it('turns an insufficient-funds createAction JSON dump into a top-up prompt', () => {
    const message = friendlyTtsError(new Error(WALLET_INSUFFICIENT_FUNDS_JSON));
    expect(message.toLowerCase()).toContain('enough satoshis');
    expect(message).toContain('1,151,890');
    expect(message.toLowerCase()).toContain('top up');
    expectNoTechnicalLeak(message);
  });

  it('humanises a plain RPC insufficient-funds string', () => {
    const message = friendlyTtsError(
      new Error(
        'RPC Error: Insufficient funds in the available inputs to cover the cost of the required outputs and the transaction fee',
      ),
    );
    expect(message.toLowerCase()).toContain('enough satoshis');
    expect(message.toLowerCase()).toContain('top up');
    expectNoTechnicalLeak(message);
  });

  it('does not show raw wallet JSON for an unclassified RPC failure', () => {
    const message = friendlyTtsError(
      new Error(
        '{"call":"createAction","args":{"description":"Ask Satoshi — read aloud"},"message":"RPC Error: transaction rejected by mempool policy"}',
      ),
    );
    expect(message.toLowerCase()).toContain('wallet');
    expect(message.toLowerCase()).toContain('try again');
    expectNoTechnicalLeak(message);
  });

  it('humanises a wallet error object that was never wrapped in Error', () => {
    const message = friendlyTtsError({
      call: 'createAction',
      message: 'RPC Error: Insufficient funds (200 more satoshis are needed, for a total of 5000)',
    });
    expect(message.toLowerCase()).toContain('enough satoshis');
    expect(message).toContain('5,000');
    expectNoTechnicalLeak(message);
  });

  it('leaves already-friendly wallet copy alone', () => {
    const original = 'The treasury address on this quote is not valid. Please try again.';
    expect(friendlyTtsError(new Error(original))).toBe(original);
  });

  it('explains a double-spend style wallet failure without leaking RPC wording', () => {
    const message = friendlyTtsError(
      new Error('{"call":"createAction","message":"RPC Error: transaction was a double spend"}'),
    );
    expect(message.toLowerCase()).toContain('already');
    expectNoTechnicalLeak(message);
  });
});
