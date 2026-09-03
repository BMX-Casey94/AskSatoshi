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
