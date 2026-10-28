/**
 * Message column. A loaded thread opens at the bottom. Sending a message scrolls
 * that bubble toward the top and leaves it there when the answer arrives, so a
 * long answer is read from the top. If the reader has moved away from the bottom,
 * nothing is auto-scrolled.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent } from 'react';
import type { Citation, Message, SourceClass } from '../types';
import { renderMarkdown } from '../lib/markdown';
import { answerProvenance } from '../lib/provenance';
import { TypingIndicator } from './TypingIndicator';
import { CitationPanel } from './CitationPanel';
import { ReadAloudButton } from './ReadAloudButton';
import { AnswerActions, ProvenanceBadge } from './AnswerActions';
import { FollowUps } from './FollowUps';
import { BookIcon } from './icons';
import '../answerActions.css';

const SOURCE_CLASS_LABEL: Record<SourceClass, string> = {
  'satoshi-primary': 'Satoshi 2008–11',
  spec: 'Spec',
  'later-commentary': 'Later commentary',
  'historical-record': 'Historical record',
  news: 'News (CoinGeek)',
  directory: 'App directory',
};

const NEAR_BOTTOM = 80;

interface Props {
  messages: Message[];
  awaitingFirstToken: boolean;
  chatPhase: 'warming' | 'typing' | 'reviewing';
  onRetry?: (failedAssistantId: string) => void;
  sending?: boolean;
  /** Persist a thumb rating. Wired by the parent; clicking the current rating again does nothing. */
  onRate?: (id: string, rating: 'up' | 'down') => void;
  /** Ask a follow-up question as a new turn. */
  onAsk?: (question: string) => void;
  /** In-memory previews for user messages sent with an image this session. */
  userImageUrls?: Readonly<Record<string, string>>;
}

interface ScrollSnapshot {
  ids: string[];
  ready: boolean;
  assistantChars: number;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function distanceFromBottom(el: HTMLElement): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

function isIdPrefix(prefix: string[], full: string[]): boolean {
  if (full.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (full[i] !== prefix[i]) return false;
  }
  return true;
}

function lastByRole(messages: Message[], role: Message['role']): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === role) return message;
  }
  return undefined;
}

function precedingQuestion(messages: Message[], index: number): string {
  for (let i = index - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === 'user') return message.content;
  }
  return '';
}

/** Latest finished answer. A still-streaming reply hides older chips. */
function latestFinishedAssistantId(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== 'assistant') continue;
    if (message.streaming || message.errorCode || message.content.trim().length === 0) return undefined;
    return message.id;
  }
  return undefined;
}

function tailStartIndex(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') return i;
  }
  return 0;
}

function messageSelector(id: string): string {
  const escaped =
    typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(id)
      : id.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `[data-msg-id="${escaped}"]`;
}

function syncTailSpacer(
  open: boolean,
  scroller: HTMLElement | null,
  content: HTMLElement | null,
  spacer: HTMLElement | null,
): void {
  if (!spacer) return;
  if (!open || !scroller || !content) {
    spacer.style.height = '0px';
    return;
  }
  // Extra pixels so scroll-margin can still park the user bubble at the top.
  const needed = Math.max(0, scroller.clientHeight - content.offsetHeight + 16);
  spacer.style.height = `${needed}px`;
}

function nodesToPlain(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? '').replace(/\u00a0/g, ' ');
  if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
    let text = '';
    node.childNodes.forEach((child) => {
      text += nodesToPlain(child);
    });
    return text;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node as HTMLElement;
  const tag = el.tagName;
  if (tag === 'BR') return '\n';
  let inner = '';
  el.childNodes.forEach((child) => {
    inner += nodesToPlain(child);
  });
  if (tag === 'LI') {
    const line = inner.replace(/\s+/g, ' ').trim();
    return line ? `\n${line}\n` : '';
  }
  if (tag === 'PRE') return `\n${inner.replace(/\s+$/g, '')}\n`;
  if (
    tag === 'P' ||
    tag === 'H1' ||
    tag === 'H2' ||
    tag === 'H3' ||
    tag === 'H4' ||
    tag === 'H5' ||
    tag === 'H6' ||
    tag === 'BLOCKQUOTE' ||
    tag === 'TR'
  ) {
    const line = inner.replace(/[ \t]+\n/g, '\n').trim();
    return line ? `\n${line}\n` : '';
  }
  if (tag === 'UL' || tag === 'OL' || tag === 'DIV' || tag === 'SECTION') {
    const line = inner.trim();
    return line ? `\n${line}\n` : '';
  }
  return inner;
}

function selectionPlainText(container: HTMLElement): string | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;
  const fragment = range.cloneContents();
  const walked = nodesToPlain(fragment)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const fallback = selection.toString().replace(/\u00a0/g, ' ').trim();
  return walked || fallback || null;
}

export function MessageList({
  messages,
  awaitingFirstToken,
  chatPhase,
  onRetry,
  sending,
  onRate,
  onAsk,
  userImageUrls,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const tailContentRef = useRef<HTMLDivElement>(null);
  const spacerRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(false);
  const anchoredForRef = useRef<string | null>(null);
  const prevRef = useRef<ScrollSnapshot>({ ids: [], ready: false, assistantChars: 0 });
  const [atBottom, setAtBottom] = useState(true);
  const [newAnswerBelow, setNewAnswerBelow] = useState(false);
  const [openCite, setOpenCite] = useState<{ citations: Citation[]; index: number } | null>(null);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;

    const ids = messages.map((message) => message.id);
    const prev = prevRef.current;
    const lastAssistant = lastByRole(messages, 'assistant');
    const assistantChars = lastAssistant?.content.length ?? 0;
    const extended = isIdPrefix(prev.ids, ids);
    const shrunk = isIdPrefix(ids, prev.ids) && ids.length < prev.ids.length;
    const addedUser = extended ? messages.slice(prev.ids.length).find((message) => message.role === 'user') : undefined;

    let mode: 'bottom' | 'anchor' | 'hold' = 'hold';
    if (!prev.ready) {
      mode = awaitingFirstToken ? 'anchor' : 'bottom';
    } else if (addedUser) {
      mode = 'anchor';
    } else if (shrunk || extended) {
      mode = 'hold';
    } else {
      mode = 'bottom';
    }

    const applyFollowSpacer = (open: boolean) => {
      followRef.current = open;
      syncTailSpacer(open, scroller, tailContentRef.current, spacerRef.current);
    };

    if (mode === 'bottom') {
      anchoredForRef.current = null;
      applyFollowSpacer(false);
      scroller.scrollTop = scroller.scrollHeight;
      setNewAnswerBelow(false);
      setAtBottom(distanceFromBottom(scroller) < NEAR_BOTTOM);
    } else if (mode === 'anchor') {
      const user = addedUser ?? lastByRole(messages, 'user');
      applyFollowSpacer(true);
      if (user && anchoredForRef.current !== user.id) {
        anchoredForRef.current = user.id;
        const node = scroller.querySelector<HTMLElement>(messageSelector(user.id));
        node?.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
      }
      setNewAnswerBelow(false);
      setAtBottom(distanceFromBottom(scroller) < NEAR_BOTTOM);
    } else {
      syncTailSpacer(followRef.current, scroller, tailContentRef.current, spacerRef.current);
      const near = distanceFromBottom(scroller) < NEAR_BOTTOM;
      setAtBottom(near);
      if (near) setNewAnswerBelow(false);
      else if (assistantChars > prev.assistantChars) setNewAnswerBelow(true);
    }

    prevRef.current = { ids, ready: true, assistantChars };
  }, [messages, awaitingFirstToken, chatPhase]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      syncTailSpacer(followRef.current, scrollRef.current, tailContentRef.current, spacerRef.current);
    });
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const near = distanceFromBottom(el) < NEAR_BOTTOM;
    setAtBottom(near);
    if (near) setNewAnswerBelow(false);
  };

  const scrollToBottom = () => {
    followRef.current = false;
    anchoredForRef.current = null;
    const scroller = scrollRef.current;
    if (spacerRef.current) spacerRef.current.style.height = '0px';
    setNewAnswerBelow(false);
    setAtBottom(true);
    if (!scroller) return;
    scroller.scrollTo({
      top: scroller.scrollHeight,
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
  };

  const onAnswerCopy = (event: ClipboardEvent<HTMLDivElement>) => {
    if (!event.clipboardData) return;
    const plain = selectionPlainText(event.currentTarget);
    if (!plain) return;
    event.clipboardData.setData('text/plain', plain);
    event.preventDefault();
  };

  const latestAnswerId = sending ? undefined : latestFinishedAssistantId(messages);
  const splitAt = tailStartIndex(messages);
  const head = messages.slice(0, splitAt);
  const tail = messages.slice(splitAt);

  const renderMessage = (message: Message, index: number) => {
    if (message.role === 'user') {
      const preview = userImageUrls?.[message.id];
      return (
        <div key={message.id} className="msg-row msg-row--user" data-msg-id={message.id}>
          <div className={preview ? 'msg-bubble msg-bubble--user msg-bubble--with-image' : 'msg-bubble msg-bubble--user'}>
            {preview
              ? [
                  <img key="img" src={preview} alt="Attached image" className="msg-user-image" />,
                  <span key="text" className="msg-user-text">{message.content}</span>,
                ]
              : message.content}
          </div>
        </div>
      );
    }

    const finished = !message.streaming && !message.errorCode && message.content.trim().length > 0;
    const provenance = finished ? answerProvenance(message) : null;
    const showMeta = provenance !== null || Boolean(message.revised);

    return (
      <div key={message.id} className="msg-row msg-row--assistant" data-msg-id={message.id}>
        {message.errorCode ? (
          <div className="msg-error">
            <span className="msg-error-text">{message.content}</span>
            {onRetry && !sending && message.errorCode !== 'EXHAUSTED' && (
              <button type="button" className="msg-error-retry" onClick={() => onRetry(message.id)}>
                Try again
              </button>
            )}
          </div>
        ) : (
          <>
            <div
              className={`msg-assistant${message.streaming ? ' msg-assistant--streaming' : ''}`}
              onCopy={onAnswerCopy}
              // Sanitised by DOMPurify inside renderMarkdown.
              dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }}
            />
            {showMeta && (
              <div className="answer-meta">
                {provenance && <ProvenanceBadge provenance={provenance} />}
                {message.revised && (
                  <span
                    className="msg-revised"
                    title="Reviewed and refined for accuracy after the first draft"
                  >
                    refined for accuracy
                  </span>
                )}
                <ReadAloudButton text={message.content} placement="meta" />
              </div>
            )}
            {finished && (
              <div className="answer-tools">
                {!showMeta && <ReadAloudButton text={message.content} placement="actions" />}
                <AnswerActions
                  message={message}
                  question={precedingQuestion(messages, index)}
                  messages={messages}
                  onRate={onRate}
                />
              </div>
            )}
            {message.citations && message.citations.length > 0 && (
              <div className="sources">
                <span className="sources-label">
                  <BookIcon size={13} /> Sources
                </span>
                <ol className="sources-list">
                  {message.citations.map((citation, citationIndex, all) => {
                    const label = citation.title ?? citation.label;
                    return (
                      <li key={`${message.id}-cite-${citationIndex}`} className="source-item">
                        <button
                          type="button"
                          className="source-link"
                          onClick={() => setOpenCite({ citations: all, index: citationIndex + 1 })}
                        >
                          {citation.sourceClass && (
                            <span className={`source-chip source-chip--${citation.sourceClass}`}>
                              {SOURCE_CLASS_LABEL[citation.sourceClass]}
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
            {!sending && message.id === latestAnswerId && message.followUps && message.followUps.length > 0 && (
              <FollowUps questions={message.followUps} onAsk={onAsk} />
            )}
          </>
        )}
      </div>
    );
  };

  return (
    <div className="messages" ref={scrollRef} onScroll={handleScroll}>
      <div className="messages-column">
        {head.map((message, index) => renderMessage(message, index))}
        <div className="messages-tail">
          <div className="messages-tail-content" ref={tailContentRef}>
            {tail.map((message, index) => renderMessage(message, splitAt + index))}
            {awaitingFirstToken && <TypingIndicator phase={chatPhase} />}
          </div>
          <div ref={spacerRef} className="messages-end-spacer" aria-hidden="true" />
        </div>
      </div>
      <CitationPanel
        open={openCite}
        onClose={() => setOpenCite(null)}
        onNavigate={(idx) =>
          setOpenCite((current) =>
            current && idx >= 1 && idx <= current.citations.length ? { ...current, index: idx } : current,
          )
        }
      />
      {!atBottom && (
        <button
          type="button"
          className="scroll-pill"
          onClick={scrollToBottom}
          aria-label={newAnswerBelow ? 'New answer below' : 'Scroll to bottom'}
        >
          {newAnswerBelow ? '↓ New answer below' : '↓ Scroll to bottom'}
        </button>
      )}
    </div>
  );
}
