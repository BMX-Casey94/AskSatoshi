/**
 * ChatGPT-style message column: user messages as right-aligned bubbles, assistant
 * messages full-width with sanitised markdown and citation chips. Auto-scrolls
 * unless the user has scrolled up; offers a scroll-to-bottom pill.
 */

import { useEffect, useRef, useState } from 'react';
import type { Citation, Message, SourceClass } from '../types';
import { renderMarkdown } from '../lib/markdown';
import { TypingIndicator } from './TypingIndicator';
import { CitationPanel } from './CitationPanel';
import { BookIcon } from './icons';

const SOURCE_CLASS_LABEL: Record<SourceClass, string> = {
  'satoshi-primary': 'Satoshi 2008–11',
  spec: 'Spec',
  'later-commentary': 'Later commentary',
};

interface Props {
  messages: Message[];
  awaitingFirstToken: boolean;
  chatPhase: 'warming' | 'typing';
  onRetry?: (failedAssistantId: string) => void;
  sending?: boolean;
}

export function MessageList({ messages, awaitingFirstToken, chatPhase, onRetry, sending }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const [openCite, setOpenCite] = useState<{ citation: Citation; index: number } | null>(null);

  useEffect(() => {
    if (!pinned) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, awaitingFirstToken, pinned]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setPinned(distanceFromBottom < 80);
  };

  return (
    <div className="messages" ref={scrollRef} onScroll={handleScroll}>
      <div className="messages-column">
        {messages.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="msg-row msg-row--user">
              <div className="msg-bubble msg-bubble--user">{m.content}</div>
            </div>
          ) : (
            <div key={m.id} className="msg-row msg-row--assistant">
              {m.errorCode ? (
                <div className="msg-error">
                  <span className="msg-error-text">{m.content}</span>
                  {onRetry && !sending && m.errorCode !== 'EXHAUSTED' && (
                    <button
                      type="button"
                      className="msg-error-retry"
                      onClick={() => onRetry(m.id)}
                    >
                      Try again
                    </button>
                  )}
                </div>
              ) : (
                <>
                  <div
                    className={`msg-assistant${m.streaming ? ' msg-assistant--streaming' : ''}`}
                    // Sanitised by DOMPurify inside renderMarkdown.
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }}
                  />
                  {m.citations && m.citations.length > 0 && (
                    <div className="sources">
                      <span className="sources-label">
                        <BookIcon size={13} /> Sources
                      </span>
                      <ol className="sources-list">
                        {m.citations.map((c, i) => {
                          const label = c.title ?? c.label;
                          return (
                            <li key={`${m.id}-cite-${i}`} className="source-item">
                              <button
                                type="button"
                                className="source-link"
                                onClick={() => setOpenCite({ citation: c, index: i + 1 })}
                              >
                                {c.sourceClass && (
                                  <span className={`source-chip source-chip--${c.sourceClass}`}>
                                    {SOURCE_CLASS_LABEL[c.sourceClass]}
                                  </span>
                                )}
                                <span className="source-title">{label}</span>
                              </button>
                            </li>
                          );
                        })}
                      </ol>
                    </div>
                  )}
                </>
              )}
            </div>
          ),
        )}
        {awaitingFirstToken && <TypingIndicator phase={chatPhase} />}
      </div>
      <CitationPanel open={openCite} onClose={() => setOpenCite(null)} />
      {!pinned && (
        <button
          type="button"
          className="scroll-pill"
          onClick={() => {
            setPinned(true);
            scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
          }}
        >
          ↓ Scroll to bottom
        </button>
      )}
    </div>
  );
}
