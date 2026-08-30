/**
 * Citation detail panel. On desktop it docks to the side of the chat column; on
 * narrow screens it becomes a bottom sheet. Shows the source title, optional
 * date (Quoted remarks), a sanitised markdown excerpt, and an "Open original"
 * link when a real URL exists. Internal-only sources are shown with a note.
 */

import { useEffect, useMemo } from 'react';
import type { Citation } from '../types';
import { renderMarkdown } from '../lib/markdown';
import { CloseIcon, ExternalLinkIcon } from './icons';

interface Props {
  /** The citation to show, plus its 1-based number; null closes the panel. */
  open: { citation: Citation; index: number } | null;
  onClose: () => void;
}

/** Format an ISO / YYYY-MM-DD date for UK display (e.g. 11 December 2010). */
function formatCitationDate(iso: string): string | null {
  const dayOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const d = dayOnly
    ? new Date(Date.UTC(Number(dayOnly[1]), Number(dayOnly[2]) - 1, Number(dayOnly[3])))
    : new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function CitationPanel({ open, onClose }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const excerptHtml = useMemo(
    () => (open?.citation.excerpt ? renderMarkdown(open.citation.excerpt) : ''),
    [open?.citation.excerpt],
  );

  if (!open) return null;
  const { citation, index } = open;
  const title = citation.title ?? citation.label;
  const dateLabel = citation.date ? formatCitationDate(citation.date) : null;

  return (
    <>
      <div className="cite-overlay" onClick={onClose} aria-hidden="true" />
      <aside className="cite-panel" role="dialog" aria-modal="true" aria-label={`Source ${index}`}>
        <div className="cite-panel-head">
          <span className="cite-panel-num">Source {index}</span>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close source">
            <CloseIcon size={18} />
          </button>
        </div>
        <h3 className="cite-panel-title">{title}</h3>
        {dateLabel && <p className="cite-panel-date">{dateLabel}</p>}
        {excerptHtml && (
          <blockquote
            className="cite-panel-excerpt"
            // Sanitised by DOMPurify inside renderMarkdown.
            dangerouslySetInnerHTML={{ __html: excerptHtml }}
          />
        )}
        {citation.url ? (
          <a className="cite-panel-open" href={citation.url} target="_blank" rel="noopener noreferrer">
            Open original <ExternalLinkIcon size={14} />
          </a>
        ) : (
          <p className="cite-panel-plain">From the pinned knowledge snapshot — no public link available.</p>
        )}
      </aside>
    </>
  );
}
