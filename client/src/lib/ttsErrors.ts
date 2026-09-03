/**
 * Browser-safe TTS helpers with no fetch/window dependency so they can be
 * unit-tested from the server Vitest suite.
 */

export class WalletUnavailableError extends Error {
  readonly name = 'WalletUnavailableError';
  constructor(message = 'No BRC-100 wallet is available. Open a compatible wallet and try again.') {
    super(message);
  }
}

export interface TtsFriendlyError {
  message: string;
  refunded: boolean;
  refundTxid?: string;
}

function errorField(err: unknown, key: 'code' | 'reason' | 'refundTxid'): string {
  if (err && typeof err === 'object' && key in err) {
    const value = (err as Record<string, unknown>)[key];
    if (typeof value === 'string') return value;
  }
  return '';
}

function paymentInvalidMessage(reason: string): string {
  switch (reason) {
    case 'underpaid':
      return 'The payment was below the quoted amount, so the audio was not generated. If the satoshis left your wallet they are held by the treasury and will be refunded to the same wallet — they should appear within a few seconds as a 0-conf transaction.';
    case 'wrong-destination':
      return 'The payment did not arrive at our treasury address, so we cannot refund it from here. Check the transaction in your wallet.';
    case 'broadcast-failed':
      return 'Your wallet sent the payment but we could not confirm it on the network. If the satoshis have left your wallet they are held by the treasury. Try again in a moment; if the audio still does not appear, a refund will be sent to the same wallet within a few minutes.';
    case 'invalid-tx':
    default:
      return 'We could not read the payment transaction, so the audio was not generated. Your wallet may already have sent the satoshis. We cannot refund this automatically — please contact us with the transaction id from your wallet and we will return them.';
  }
}

export function friendlyTtsError(err: unknown): string {
  if (err instanceof WalletUnavailableError) return err.message;
  if (err instanceof Error) {
    if (err.message === 'Payment cancelled — nothing was charged.') return err.message;
    const code = errorField(err, 'code');
    const refunded = 'refunded' in err && err.refunded === true;
    switch (code) {
      case 'TTS_BAD_INPUT':
        return err.message || 'That text could not be synthesised.';
      case 'TTS_PAYMENT_INVALID':
        return paymentInvalidMessage(errorField(err, 'reason'));
      case 'TTS_QUOTE_UNKNOWN':
        return 'That price quote was not recognised. Please try again.';
      case 'TTS_TX_REUSED':
        return 'That payment has already been used.';
      case 'TTS_QUOTE_USED':
        return 'This quote has already been used. Please try again.';
      case 'TTS_QUOTE_EXPIRED':
        return 'The quote expired. Please try again.';
      case 'TTS_DISABLED':
        return 'Text transcription is currently unavailable.';
      case 'TTS_CREDIT_EXHAUSTED':
        return refunded
          ? 'Text transcription is temporarily unavailable — credits are exhausted. Your payment has been refunded to the same wallet and should appear within a few seconds as a 0-conf transaction. The small miner fee is not returned.'
          : 'Text transcription is temporarily unavailable — credits are exhausted. If satoshis have left your wallet they are held by the treasury — contact us with your transaction id and we will return them.';
      case 'TTS_SYNTH_FAILED':
        return refunded
          ? 'We could not generate the audio. Your payment has been refunded to the same wallet and should appear within a few seconds as a 0-conf transaction. The small miner fee is not returned.'
          : 'We could not generate the audio or send the refund automatically. Your satoshis are held by the treasury — contact us with your transaction id and we will return them.';
      default:
        return err.message || 'Something went wrong. Please try again.';
    }
  }
  return 'Something went wrong. Please try again.';
}

export function describeTtsError(err: unknown): TtsFriendlyError {
  const refunded = err instanceof Error && 'refunded' in err && err.refunded === true;
  const refundTxid = errorField(err, 'refundTxid') || undefined;
  return { message: friendlyTtsError(err), refunded, refundTxid };
}

/** Turn a BRC-100 createAction `tx` (Atomic BEEF bytes or hex) into hex. */
export function encodeWalletTx(tx: unknown): string | null {
  if (typeof tx === 'string') {
    const hex = tx.trim();
    return /^[0-9a-fA-F]+$/.test(hex) && hex.length % 2 === 0 && hex.length > 0 ? hex : null;
  }
  if (tx instanceof Uint8Array) {
    return Array.from(tx, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  if (ArrayBuffer.isView(tx)) {
    const view = new Uint8Array(tx.buffer, tx.byteOffset, tx.byteLength);
    return Array.from(view, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  if (Array.isArray(tx)) {
    if (!tx.every((n) => typeof n === 'number' && Number.isInteger(n))) return null;
    return tx.map((b) => (Number(b) & 0xff).toString(16).padStart(2, '0')).join('');
  }
  return null;
}
