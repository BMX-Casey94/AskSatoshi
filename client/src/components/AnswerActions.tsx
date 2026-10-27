/**
 * Actions under a finished assistant answer: copy, share, and a thumbs rating.
 * Presentational — the parent owns persistence and sending.
 */

import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { GroundingMode, Message } from '../types';
import { messagesToMarkdown } from '../lib/exportThread';
import {
  COPIED_NOTICE_MS,
  buildTweetExcerpt,
  copyText,
  formatAnswerWithSources,
  markdownToPlainText,
  shareSheetText,
  xIntentUrl,
} from '../lib/share';
import '../answerActions.css';

const PROVENANCE: Record<Exclude<GroundingMode, 'none'>, { label: string; tip: string }> = {
  corpus: {
    label: "Answered from Satoshi's own words",
    tip: "Drawn from Satoshi Nakamoto's white paper, forum posts and e-mails.",
  },
  mcp: {
    label: 'Answered from the protocol record (BRCs, Script, SDK)',
    tip: 'Drawn from the Bitcoin protocol specifications, BRCs, Script and the SDK.',
  },
  reference: {
    label: 'Answered from the curated historical record',
    tip: 'Drawn from the curated historical record of the period.',
  },
};

export function ProvenanceBadge({ mode }: { mode?: GroundingMode }) {
  if (!mode || mode === 'none') return null;
  const info = PROVENANCE[mode];
  if (!info) return null;
  return (
    <span className="provenance-badge" tabIndex={0} data-tip={info.tip} aria-label={`${info.label}. ${info.tip}`}>
      {info.label}
    </span>
  );
}

interface Props {
  message: Message;
  question: string;
  messages: Message[];
  onRate?: (id: string, rating: 'up' | 'down') => void;
}

function isAbort(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'name' in err && (err as { name: string }).name === 'AbortError';
}

function ThumbIcon({ down = false }: { down?: boolean }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={down ? { transform: 'rotate(180deg)' } : undefined}
    >
      <path d="M8 11v10" />
      <path d="M8 11h3.2a2 2 0 0 0 1.8-1.1L16 4.5A2.2 2.2 0 0 1 18.6 7L17 11h3.2a2 2 0 0 1 2 2.4l-1.2 7.2A2 2 0 0 1 19 22H8" />
    </svg>
  );
}

export function AnswerActions({ message, question, messages, onRate }: Props) {
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const focusMenuOnOpen = useRef(false);
  const timerRef = useRef<number | undefined>(undefined);
  const [menuOpen, setMenuOpen] = useState(false);
  const [notice, setNotice] = useState('');

  const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  const showNotice = (text: string) => {
    setNotice(text);
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setNotice(''), COPIED_NOTICE_MS);
  };

  const confirmCopy = (text: string) => {
    void copyText(text).then((ok) => {
      showNotice(ok ? 'Copied' : "Couldn't copy that");
    });
  };

  const placeMenu = () => {
    const button = buttonRef.current;
    const menu = menuRef.current;
    if (!button || !menu) return;
    const margin = 8;
    const rect = button.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    let top = rect.bottom + 6;
    let left = rect.left;
    if (top + menuRect.height > window.innerHeight - margin) {
      top = Math.max(margin, rect.top - menuRect.height - 6);
    }
    if (left + menuRect.width > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - margin - menuRect.width);
    }
    menu.style.top = `${Math.round(top)}px`;
    menu.style.left = `${Math.round(left)}px`;
    menu.style.visibility = 'visible';
  };

  useLayoutEffect(() => {
    if (!menuOpen) return;
    placeMenu();
    if (focusMenuOnOpen.current) {
      focusMenuOnOpen.current = false;
      menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    }
    const onMove = () => placeMenu();
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [menuOpen, canNativeShare]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setMenuOpen(false);
      buttonRef.current?.focus();
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target)) return;
      if (buttonRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [menuOpen]);

  const plain = () => markdownToPlainText(message.content);

  const shareToX = () => {
    const href = xIntentUrl(buildTweetExcerpt(question, plain()), window.location.origin);
    const tab = window.open(href, '_blank', 'noopener,noreferrer');
    if (tab) tab.opener = null;
    setMenuOpen(false);
  };

  const shareVia = () => {
    setMenuOpen(false);
    if (typeof navigator.share !== 'function') {
      showNotice("Couldn't share that");
      return;
    }
    void navigator.share({ text: shareSheetText(question, plain()), url: window.location.origin }).catch((err: unknown) => {
      if (isAbort(err)) return;
      showNotice("Couldn't share that");
    });
  };

  const copyThread = () => {
    setMenuOpen(false);
    const firstQuestion = messages
      .find((item) => item.role === 'user')
      ?.content.trim()
      .replace(/\s+/g, ' ');
    const title = !firstQuestion
      ? 'Ask Satoshi'
      : firstQuestion.length > 56
        ? `${firstQuestion.slice(0, 56)}…`
        : firstQuestion;
    const updatedAt = messages.reduce((max, item) => Math.max(max, item.ts), 0) || Date.now();
    confirmCopy(messagesToMarkdown(messages, { title, updatedAt }));
  };

  const onMenuKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const next = current < 0 ? 0 : (current + 1) % items.length;
      items[next]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      const prev = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
      items[prev]?.focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      items[items.length - 1]?.focus();
    } else if (event.key === 'Tab') {
      setMenuOpen(false);
    }
  };

  const rate = (rating: 'up' | 'down') => {
    if (message.rating === rating) return;
    onRate?.(message.id, rating);
  };

  const helpfulLabel = message.rating === 'up' ? 'Marked as helpful' : 'Mark this answer as helpful';
  const unhelpfulLabel = message.rating === 'down' ? 'Marked as unhelpful' : 'Mark this answer as unhelpful';

  const menu = menuOpen
    ? createPortal(
        <div
          ref={menuRef}
          id={menuId}
          className="answer-share-menu"
          role="menu"
          aria-label="Share this answer"
          style={{ visibility: 'hidden' }}
          onKeyDown={onMenuKey}
        >
          <button type="button" className="answer-share-item" role="menuitem" onClick={shareToX}>
            Share to X
          </button>
          {canNativeShare && (
            <button type="button" className="answer-share-item" role="menuitem" onClick={shareVia}>
              Share via…
            </button>
          )}
          <button type="button" className="answer-share-item" role="menuitem" onClick={copyThread}>
            Copy thread as Markdown
          </button>
        </div>,
        document.body,
      )
    : null;

  return (
    <div className="answer-actions" role="group" aria-label="Answer actions">
      <button
        type="button"
        className="answer-action"
        onClick={() => confirmCopy(plain())}
        aria-label="Copy answer"
      >
        Copy answer
      </button>
      <button
        type="button"
        className="answer-action"
        onClick={() =>
          confirmCopy(formatAnswerWithSources(message.content, message.citations ?? [], window.location.origin))
        }
        aria-label="Copy answer with sources"
      >
        Copy with sources
      </button>
      <div className="answer-share">
        <button
          ref={buttonRef}
          type="button"
          className="answer-action"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-controls={menuId}
          aria-label="Share this answer"
          onClick={() => setMenuOpen((open) => !open)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              if (!menuOpen) {
                focusMenuOnOpen.current = true;
                setMenuOpen(true);
              } else {
                menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
              }
            }
          }}
        >
          Share
        </button>
        {menu}
      </div>
      <button
        type="button"
        className="answer-action answer-action--icon"
        aria-pressed={message.rating === 'up'}
        aria-label={helpfulLabel}
        title={helpfulLabel}
        onClick={() => rate('up')}
      >
        <ThumbIcon />
      </button>
      <button
        type="button"
        className="answer-action answer-action--icon"
        aria-pressed={message.rating === 'down'}
        aria-label={unhelpfulLabel}
        title={unhelpfulLabel}
        onClick={() => rate('down')}
      >
        <ThumbIcon down />
      </button>
      <span className="answer-confirm" role="status" aria-live="polite" aria-atomic="true">
        {notice}
      </span>
    </div>
  );
}
