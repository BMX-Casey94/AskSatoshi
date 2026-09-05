/**
 * Paid "Read aloud" control for a finished assistant message. Hidden when TTS is
 * disabled, the text is empty, or it exceeds the server's character cap.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { CloseIcon, SpeakerIcon } from './icons';
import { renderPlainText } from '../lib/markdown';
import {
  describeTtsError,
  getTtsStatus,
  payAndSpeak,
  requestQuote,
  subscribeTtsStatus,
  type TtsQuote,
  type TtsStatus,
} from '../lib/tts';
import { ReadAloudPayModal } from './ReadAloudPayModal';
import { ReadAloudPlayer } from './ReadAloudPlayer';

interface Props {
  text: string;
}

type Phase = 'idle' | 'quoting' | 'confirm' | 'paying' | 'synthesising' | 'ready';

interface ErrorState {
  message: string;
  refunded: boolean;
  refundTxid?: string;
}

export function ReadAloudButton({ text }: Props) {
  const [status, setStatus] = useState<TtsStatus | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [quote, setQuote] = useState<TtsQuote | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [error, setError] = useState<ErrorState | null>(null);
  const [busy, setBusy] = useState(false);

  const aliveRef = useRef(true);
  const busyRef = useRef(false);
  const speakerRef = useRef<HTMLButtonElement>(null);

  const plain = useMemo(() => renderPlainText(text), [text]);

  useEffect(() => {
    aliveRef.current = true;
    void getTtsStatus().then((next) => {
      if (aliveRef.current) setStatus(next);
    });
    const unsubscribe = subscribeTtsStatus((next) => {
      if (aliveRef.current) setStatus(next);
    });
    return () => {
      aliveRef.current = false;
      unsubscribe();
    };
  }, []);

  const resetToIdle = () => {
    setPhase('idle');
    setQuote(null);
    setBusy(false);
    busyRef.current = false;
  };

  const beginQuote = async () => {
    if (busyRef.current || phase !== 'idle') return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setPhase('quoting');
    try {
      const nextQuote = await requestQuote(plain.length);
      if (!aliveRef.current) return;
      setQuote(nextQuote);
      setPhase('confirm');
    } catch (err) {
      if (!aliveRef.current) return;
      setError(describeTtsError(err));
      setPhase('idle');
      setQuote(null);
    } finally {
      busyRef.current = false;
      if (aliveRef.current) setBusy(false);
    }
  };

  const cancelConfirm = () => {
    if (phase !== 'confirm') return;
    resetToIdle();
  };

  const confirmPay = async () => {
    if (busyRef.current || phase !== 'confirm' || !quote) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setPhase('paying');
    try {
      const { audioUrl: url } = await payAndSpeak(plain, quote, (next) => {
        if (aliveRef.current) setPhase(next);
      });
      if (!aliveRef.current) return;
      setAudioUrl(url);
      setPhase('ready');
      setQuote(null);
    } catch (err) {
      if (!aliveRef.current) return;
      setError(describeTtsError(err));
      resetToIdle();
    } finally {
      busyRef.current = false;
      if (aliveRef.current) setBusy(false);
    }
  };

  if (!status?.enabled) return null;
  if (!plain || plain.length > status.maxChars) return null;

  if (phase === 'ready' && audioUrl) {
    return (
      <div className="read-aloud">
        <ReadAloudPlayer src={audioUrl} />
      </div>
    );
  }

  const inFlight = busy || phase === 'quoting' || phase === 'paying' || phase === 'synthesising';

  return (
    <div className="read-aloud">
      {phase === 'paying' ? (
        <span className="read-aloud-status" role="status">
          Check your wallet…
        </span>
      ) : phase === 'synthesising' ? (
        <span className="read-aloud-status" role="status">
          Synthesising audio…
        </span>
      ) : phase === 'quoting' ? (
        <span className="read-aloud-status" role="status">
          Getting a price…
        </span>
      ) : (
        <button
          ref={speakerRef}
          type="button"
          className="read-aloud-btn"
          onClick={() => void beginQuote()}
          disabled={inFlight || phase === 'confirm'}
          aria-label="Listen to this answer"
          title="Listen to this answer"
        >
          <SpeakerIcon size={14} />
        </button>
      )}
      {error && (
        <div className="read-aloud-error-box" role="alert">
          <div className="read-aloud-error-body">
            <p className="read-aloud-error-title">Could not read this aloud</p>
            <p className="read-aloud-error-text">{error.message}</p>
            {error.refunded && (
              <span className="read-aloud-error-refunded">Refund sent — check your wallet in a few seconds</span>
            )}
            {error.refundTxid && (
              <p className="read-aloud-error-txid">Refund transaction: {error.refundTxid}</p>
            )}
          </div>
          <button
            type="button"
            className="icon-btn read-aloud-error-dismiss"
            onClick={() => setError(null)}
            aria-label="Dismiss error"
            title="Dismiss"
          >
            <CloseIcon size={14} />
          </button>
        </div>
      )}
      {phase === 'confirm' && quote && (
        <ReadAloudPayModal
          quote={quote}
          status={status}
          onCancel={cancelConfirm}
          onConfirm={() => void confirmPay()}
          returnFocusRef={speakerRef}
        />
      )}
    </div>
  );
}
