/**
 * Themed payment confirmation for read-aloud. Visual language matches the
 * history drawer: overlay, Satoshi hero, faded divider, then the quote details.
 */

import { useEffect, useId, useRef, type RefObject } from 'react';
import type { TtsQuote, TtsStatus } from '../lib/tts';
import { CloseIcon } from './icons';

interface Props {
  quote: TtsQuote;
  status: TtsStatus;
  onCancel: () => void;
  onConfirm: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

function formatSats(satoshis: number): string {
  return satoshis.toLocaleString('en-GB');
}

function formatUsd(satoshis: number, bsvUsd: number): string {
  const usd = (satoshis / 100_000_000) * bsvUsd;
  if (!Number.isFinite(usd) || usd <= 0) return '';
  const digits = usd < 0.01 ? 3 : 2;
  return `≈ $${usd.toFixed(digits)}`;
}

function formatEstimatedLength(chars: number, secondsPerThousand: number): string {
  const raw = (chars / 1000) * secondsPerThousand;
  const seconds = Math.max(1, Math.round(raw));
  if (seconds < 60) return `~${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `~${minutes}m 0s` : `~${minutes}m ${rest}s`;
}

export function ReadAloudPayModal({ quote, status, onCancel, onConfirm, returnFocusRef }: Props) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const confirmedRef = useRef(false);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useEffect(() => {
    confirmedRef.current = false;
    const panel = panelRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    confirmRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCancelRef.current();
        return;
      }
      if (event.key !== 'Tab' || !panel) return;
      const nodes = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => !el.hasAttribute('disabled') && el.tabIndex !== -1,
      );
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (!confirmedRef.current) {
        returnFocusRef.current?.focus();
      }
    };
  }, [returnFocusRef]);

  const usd = formatUsd(quote.satoshis, status.bsvUsd);
  const length = formatEstimatedLength(quote.chars, status.estimatedSecondsPerThousandChars);

  return (
    <div
      className="drawer-overlay read-aloud-modal-overlay"
      onClick={onCancel}
      role="presentation"
    >
      <div
        ref={panelRef}
        className="read-aloud-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="icon-btn drawer-close"
          onClick={onCancel}
          aria-label="Cancel payment"
        >
          <CloseIcon size={18} />
        </button>
        <div className="drawer-hero" aria-hidden="true">
          <img
            src="/Satoshi_Hero_Image_2.webp"
            alt=""
            className="drawer-hero-img"
            draggable={false}
          />
        </div>
        <div className="drawer-divider" role="presentation" />
        <h2 id={titleId} className="read-aloud-modal-title">
          Confirm payment
        </h2>
        <dl className="read-aloud-modal-details">
          <div className="read-aloud-modal-row">
            <dt>Purchase</dt>
            <dd>Text-to-speech transcription</dd>
          </div>
          <div className="read-aloud-modal-row">
            <dt>Characters</dt>
            <dd>{quote.chars.toLocaleString('en-GB')}</dd>
          </div>
          <div className="read-aloud-modal-row">
            <dt>Estimated length</dt>
            <dd>{length}</dd>
          </div>
          <div className="read-aloud-modal-row">
            <dt>Price</dt>
            <dd>
              {formatSats(quote.satoshis)} sats
              {usd && <span className="read-aloud-modal-usd">{usd}</span>}
            </dd>
          </div>
        </dl>
        <p className="drawer-note read-aloud-modal-note">
          Payment is taken from your BSV wallet (BRC-100).
        </p>
        <div className="read-aloud-modal-actions">
          <button type="button" className="read-aloud-modal-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            className="read-aloud-modal-confirm"
            onClick={() => {
              confirmedRef.current = true;
              onConfirm();
            }}
          >
            Confirm &amp; pay
          </button>
        </div>
      </div>
    </div>
  );
}
