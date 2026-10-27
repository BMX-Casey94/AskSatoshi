/**
 * Citation detail panel. On desktop it docks to the side of the chat column; on
 * narrow screens it becomes a bottom sheet. Shows the source title, optional
 * date (Quoted remarks), a sanitised markdown excerpt, and an "Open original"
 * link when a real URL exists. Internal-only sources are shown with a note.
 *
 * When the answer has several sources, full-width Previous/Next buttons pin to
 * the panel's top and bottom. Switching flows the content vertically like a
 * scroll: up towards the higher-numbered source, down towards the lower one.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Citation } from '../types';
import { renderMarkdown } from '../lib/markdown';
import { Link } from '../lib/router';
import { sourceHostLabel } from '../lib/sourceOrigin';
import { excerptToMarkdown } from '../lib/sourceText';
import { COPIED_NOTICE_MS, copyText, formatUkDate, markdownToPlainText, timelineHref } from '../lib/share';
import { ChevronDownIcon, ChevronUpIcon, CloseIcon, ExternalLinkIcon } from './icons';
import '../answerActions.css';

interface Props {
  /** The answer's source list plus the 1-based number to show; null closes the panel. */
  open: { citations: Citation[]; index: number } | null;
  onClose: () => void;
  /** Ask to show another 1-based source number from the same list. */
  onNavigate: (index: number) => void;
}

/** Keep in sync with the cite-swap keyframe durations in styles.css. */
const SWAP_OUT_MS = 160;
const SWAP_IN_MS = 220;

export function CitationPanel({ open, onClose, onNavigate }: Props) {
  // `shown` trails `open` while the outgoing source animates away.
  const [shown, setShown] = useState(open);
  const [swapStage, setSwapStage] = useState<'idle' | 'out' | 'in'>('idle');
  const shownRef = useRef(shown);
  const dirRef = useRef<'next' | 'prev'>('next');
  const timerRef = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  useEffect(() => {
    if (!open) {
      shownRef.current = null;
      setShown(null);
      setSwapStage('idle');
      return;
    }
    const current = shownRef.current;
    if (!current || current.index === open.index) {
      shownRef.current = open;
      setShown(open);
      return;
    }
    // Direction comes from the source numbers, not the button that was pressed.
    dirRef.current = open.index > current.index ? 'next' : 'prev';
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      shownRef.current = open;
      setShown(open);
      return;
    }
    setSwapStage('out');
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      shownRef.current = open;
      setShown(open);
      setSwapStage('in');
      timerRef.current = window.setTimeout(() => setSwapStage('idle'), SWAP_IN_MS);
    }, SWAP_OUT_MS);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'ArrowLeft' && open.index > 1) {
        onNavigate(open.index - 1);
      } else if (e.key === 'ArrowRight' && open.index < open.citations.length) {
        onNavigate(open.index + 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, onNavigate]);

  const [quoteNotice, setQuoteNotice] = useState('');
  const quoteTimerRef = useRef<number | undefined>(undefined);
  const openExcerpt = open ? open.citations[open.index - 1]?.excerpt : undefined;

  useEffect(() => () => window.clearTimeout(quoteTimerRef.current), []);

  useEffect(() => {
    setQuoteNotice('');
    window.clearTimeout(quoteTimerRef.current);
  }, [open?.index, openExcerpt]);

  const shownCitation = shown ? shown.citations[shown.index - 1] : undefined;
  const excerptHtml = useMemo(
    () =>
      shownCitation?.excerpt ? renderMarkdown(excerptToMarkdown(shownCitation.excerpt)) : '',
    [shownCitation?.excerpt],
  );

  if (!open || !shown || !shownCitation) return null;

  // Buttons track the live target (open), so rapid clicks chain correctly and
  // the buttons disappear the moment an end of the list is reached.
  const total = open.citations.length;
  const canPrev = open.index > 1;
  const canNext = open.index < total;
  const swapClass = swapStage === 'idle' ? '' : ` cite-panel-body--${swapStage}-${dirRef.current}`;
  const { index } = shown;
  const title = shownCitation.title ?? shownCitation.label;
  const dateLabel = shownCitation.date ? formatUkDate(shownCitation.date) : null;
  const originLabel = shownCitation.url ? sourceHostLabel(shownCitation.url) : null;
  const showOriginal = shownCitation.sourceClass === 'satoshi-primary' && Boolean(excerptHtml);
  const showTimeline =
    shownCitation.sourceClass === 'satoshi-primary' && Boolean(shownCitation.date?.trim());

  const copyQuote = () => {
    const excerpt = shownCitation.excerpt;
    if (!excerpt) return;
    const plain = markdownToPlainText(excerptToMarkdown(excerpt));
    void copyText(plain).then((ok) => {
      setQuoteNotice(ok ? 'Copied' : "Couldn't copy that");
      window.clearTimeout(quoteTimerRef.current);
      quoteTimerRef.current = window.setTimeout(() => setQuoteNotice(''), COPIED_NOTICE_MS);
    });
  };

  return (
    <>
      <div className="cite-overlay" onClick={onClose} aria-hidden="true" />
      <aside
        className="cite-panel"
        role="dialog"
        aria-modal="true"
        aria-label={`Source ${index} of ${total}`}
      >
        {canPrev && (
          <button
            type="button"
            className="cite-nav cite-nav--prev"
            onClick={() => onNavigate(open.index - 1)}
          >
            <ChevronUpIcon size={16} />
            <span>Previous Source</span>
            <span className="cite-nav-num">Source {open.index - 1}</span>
          </button>
        )}
        <div className={`cite-panel-body${swapClass}`}>
          <div className="cite-panel-head">
            <span className="cite-panel-num">
              Source {index}
              {total > 1 ? ` of ${total}` : ''}
            </span>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close source">
              <CloseIcon size={18} />
            </button>
          </div>
          {showOriginal ? (
            <figure className="cite-original">
              <figcaption className="cite-original-kicker">In the original words</figcaption>
              {dateLabel && <p className="cite-panel-date">{dateLabel}</p>}
              <h3 className="cite-original-title">{title}</h3>
              <blockquote
                className="cite-panel-excerpt cite-panel-excerpt--original"
                // Sanitised by DOMPurify inside renderMarkdown.
                dangerouslySetInnerHTML={{ __html: excerptHtml }}
              />
              <div className="cite-original-actions">
                <button type="button" className="answer-action" onClick={copyQuote} aria-label="Copy quote">
                  Copy quote
                </button>
                <span className="answer-confirm" role="status" aria-live="polite" aria-atomic="true">
                  {quoteNotice}
                </span>
              </div>
            </figure>
          ) : (
            <>
              <h3 className="cite-panel-title">{title}</h3>
              {dateLabel && <p className="cite-panel-date">{dateLabel}</p>}
              {excerptHtml && (
                <blockquote
                  className="cite-panel-excerpt"
                  // Sanitised by DOMPurify inside renderMarkdown.
                  dangerouslySetInnerHTML={{ __html: excerptHtml }}
                />
              )}
            </>
          )}
          {showTimeline && (
            <Link href={timelineHref(shownCitation.date)} className="cite-timeline-link">
              See where this sits on the timeline
            </Link>
          )}
          {shownCitation.url ? (
            <div className="cite-panel-open-row">
              <a
                className="cite-panel-open"
                href={shownCitation.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open original <ExternalLinkIcon size={14} />
              </a>
              {originLabel && <span className="cite-panel-origin">({originLabel})</span>}
            </div>
          ) : (
            <p className="cite-panel-plain">
              From the pinned knowledge snapshot — no public link available.
            </p>
          )}
        </div>
        {canNext && (
          <button
            type="button"
            className="cite-nav cite-nav--next"
            onClick={() => onNavigate(open.index + 1)}
          >
            <ChevronDownIcon size={16} />
            <span>Next Source</span>
            <span className="cite-nav-num">Source {open.index + 1}</span>
          </button>
        )}
      </aside>
    </>
  );
}
