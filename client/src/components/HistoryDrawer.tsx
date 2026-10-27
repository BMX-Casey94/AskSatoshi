/**
 * Minimal slide-over thread history — the visible face of localStorage persistence.
 * Search filters this device's threads only. Nothing in the query is sent anywhere.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Thread } from '../types';
import { searchThreads, type TextPart, type ThreadSearchHit } from '../lib/threadSearch';
import { CloseIcon, PlusIcon, TrashIcon } from './icons';

interface Props {
  open: boolean;
  threads: Thread[];
  activeThreadId: string | null;
  onClose: () => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onClearAll: () => void;
}

const SEARCH_DEBOUNCE_MS = 200;

export function HistoryDrawer(props: Props) {
  const [query, setQuery] = useState('');
  const [deferred, setDeferred] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const sorted = useMemo(
    () => [...props.threads].sort((a, b) => b.updatedAt - a.updatedAt),
    [props.threads],
  );
  const hits = useMemo(
    () => (deferred.trim() ? searchThreads(sorted, deferred) : null),
    [sorted, deferred],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => setDeferred(query), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!props.open) {
      setQuery('');
      setDeferred('');
      return;
    }
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [props.open]);

  useEffect(() => {
    if (!props.open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (query) {
        event.preventDefault();
        setQuery('');
        setDeferred('');
        return;
      }
      props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props.open, props.onClose, query]);

  if (!props.open) return null;

  const byId = new Map(sorted.map((thread) => [thread.id, thread]));
  const visible: Array<{ thread: Thread; hit: ThreadSearchHit | null }> = hits
    ? hits.flatMap((hit) => {
        const thread = byId.get(hit.id);
        return thread ? [{ thread, hit }] : [];
      })
    : sorted.map((thread) => ({ thread, hit: null }));

  const live = !deferred.trim()
    ? ''
    : visible.length === 0
      ? 'No chats match that search.'
      : visible.length === 1
        ? '1 matching chat.'
        : `${visible.length} matching chats.`;

  const clearQuery = () => {
    setQuery('');
    setDeferred('');
    inputRef.current?.focus();
  };

  return (
    <div className="drawer-overlay" onClick={props.onClose} role="presentation">
      <aside className="drawer" onClick={(e) => e.stopPropagation()} aria-label="Chat history">
        <button type="button" className="icon-btn drawer-close" onClick={props.onClose} aria-label="Close history">
          <CloseIcon size={18} />
        </button>
        <div className="drawer-hero" aria-hidden="true">
          <img src="/Satoshi_Hero_Image_2.webp" alt="" className="drawer-hero-img" draggable={false} />
        </div>
        <div className="drawer-divider" role="presentation" />
        <form className="drawer-search" role="search" onSubmit={(event) => event.preventDefault()}>
          <label className="drawer-search-label" htmlFor="history-search">
            Search chats
          </label>
          <div className="drawer-search-row">
            <input
              ref={inputRef}
              id="history-search"
              type="search"
              className="drawer-search-input"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Title or message text"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="search"
              aria-controls="history-thread-list"
            />
            {query && (
              <button type="button" className="drawer-search-clear" onClick={clearQuery} aria-label="Clear search">
                <CloseIcon size={14} />
              </button>
            )}
          </div>
        </form>
        <button type="button" className="drawer-new" onClick={props.onNew}>
          <PlusIcon size={16} /> New chat
        </button>
        <div className="visually-hidden" aria-live="polite" aria-atomic="true">
          {live}
        </div>
        <div className="drawer-list" id="history-thread-list">
          {sorted.length === 0 && <p className="drawer-empty">No chats yet — ask Satoshi something.</p>}
          {sorted.length > 0 && hits && hits.length === 0 && (
            <p className="drawer-empty">No chats match that search.</p>
          )}
          {visible.map(({ thread, hit }) => (
            <div
              key={thread.id}
              className={`drawer-item${thread.id === props.activeThreadId ? ' drawer-item--active' : ''}`}
            >
              <button
                type="button"
                className="drawer-item-label"
                onClick={() => props.onSelect(thread.id)}
                title={thread.title}
              >
                <span className="drawer-item-title">
                  {hit ? <Highlight parts={hit.title} /> : thread.title}
                </span>
                {hit?.snippet && (
                  <span className="drawer-snippet">
                    <Highlight parts={hit.snippet} />
                  </span>
                )}
              </button>
              <button
                type="button"
                className="icon-btn drawer-item-delete"
                onClick={() => props.onDelete(thread.id)}
                aria-label={`Delete chat "${thread.title}"`}
              >
                <TrashIcon size={14} />
              </button>
            </div>
          ))}
        </div>
        {props.threads.length > 0 && (
          <button
            type="button"
            className="drawer-clear"
            onClick={() => {
              if (window.confirm('Delete every chat stored on this device? This cannot be undone.')) {
                props.onClearAll();
              }
            }}
          >
            Clear all chats
          </button>
        )}
        <p className="drawer-note">Stored only in this browser's local storage. Search stays on this device.</p>
      </aside>
    </div>
  );
}

function Highlight({ parts }: { parts: TextPart[] }) {
  return (
    <>
      {parts.map((part, index) =>
        part.hit ? (
          <mark key={index} className="drawer-hit">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}
