import { useId, useState } from 'react';

/**
 * Standing AI disclosure. The one-line summary is always visible beneath the composer;
 * the "?" button expands the detail in place (no modal, no focus trap, works with a
 * keyboard and a screen reader via aria-expanded / aria-controls).
 */
export function AiNotice({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div className={`ai-notice${className ? ` ${className}` : ''}`}>
      <p className="ai-notice-line">
        AI recreation of Satoshi's voice, not Satoshi. Answers can be wrong.
        <button
          type="button"
          className="ai-notice-toggle"
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={open ? 'Hide details about this AI service' : 'Show details about this AI service'}
          onClick={() => setOpen((v) => !v)}
        >
          ?
        </button>
      </p>
      {open && (
        <div id={panelId} className="ai-notice-panel" role="note">
          <p>
            Ask Satoshi is a fun, curiosity-driven tool, not a source of facts or advice. It is an
            AI language model that writes in Satoshi Nakamoto's voice, grounded in his 2008–2011
            writings, the BSV protocol record, curated reference files, essays by Dr Craig Wright
            and others, and dated news reporting from outlets such as CoinGeek. It is a recreation
            and is not written by, or endorsed by, Satoshi.
          </p>
          <p>
            Answers can be incomplete, mistaken or reflect the editorial view of their sources.
            Check anything important against the cited sources. Where the record is disputed, such
            as who Satoshi was, it says so.
          </p>
          <p>
            What you type, and any image you attach, is sent to third-party AI providers to produce
            the answer, so avoid sharing personal or sensitive information. There are no accounts;
            your chats are kept only in this browser.
          </p>
        </div>
      )}
    </div>
  );
}
