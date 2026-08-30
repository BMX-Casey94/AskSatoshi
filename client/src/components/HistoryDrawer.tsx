/**
 * Minimal slide-over thread history — the visible face of localStorage persistence.
 * New chat, switch, rename-by-content (title = first question), delete, clear all.
 */

import type { Thread } from '../types';
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

export function HistoryDrawer(props: Props) {
  if (!props.open) return null;
  const sorted = [...props.threads].sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <div className="drawer-overlay" onClick={props.onClose} role="presentation">
      <aside
        className="drawer"
        onClick={(e) => e.stopPropagation()}
        aria-label="Chat history"
      >
        <button
          type="button"
          className="icon-btn drawer-close"
          onClick={props.onClose}
          aria-label="Close history"
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
        <button type="button" className="drawer-new" onClick={props.onNew}>
          <PlusIcon size={16} /> New chat
        </button>
        <div className="drawer-list">
          {sorted.length === 0 && <p className="drawer-empty">No chats yet — ask Satoshi something.</p>}
          {sorted.map((t) => (
            <div
              key={t.id}
              className={`drawer-item${t.id === props.activeThreadId ? ' drawer-item--active' : ''}`}
            >
              <button
                type="button"
                className="drawer-item-label"
                onClick={() => props.onSelect(t.id)}
                title={t.title}
              >
                {t.title}
              </button>
              <button
                type="button"
                className="icon-btn drawer-item-delete"
                onClick={() => props.onDelete(t.id)}
                aria-label={`Delete chat "${t.title}"`}
              >
                <TrashIcon size={14} />
              </button>
            </div>
          ))}
        </div>
        {sorted.length > 0 && (
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
        <p className="drawer-note">Stored only in this browser's local storage.</p>
      </aside>
    </div>
  );
}
