/**
 * All chat state lives here — localStorage only, nothing leaves the device except
 * the single question sent to /api/chat. Versioned schema so future shape changes
 * can migrate instead of corrupting.
 */

import type { Thread } from '../types';

const KEY = 'ask-satoshi:v1';

export interface Store {
  version: 1;
  theme: 'light' | 'dark' | null;
  threads: Thread[];
  activeThreadId: string | null;
  /** True once the local-storage notice has been shown. */
  storageNoticeSeen?: boolean;
}

const DEFAULT_STORE: Store = { version: 1, theme: null, threads: [], activeThreadId: null };

export function loadStore(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_STORE };
    const parsed = JSON.parse(raw) as Partial<Store>;
    if (parsed.version !== 1 || !Array.isArray(parsed.threads)) return { ...DEFAULT_STORE };
    return {
      version: 1,
      theme: parsed.theme === 'dark' || parsed.theme === 'light' ? parsed.theme : null,
      threads: parsed.threads,
      activeThreadId: typeof parsed.activeThreadId === 'string' ? parsed.activeThreadId : null,
      storageNoticeSeen: parsed.storageNoticeSeen === true,
    };
  } catch {
    // Corrupted storage should never take the app down.
    return { ...DEFAULT_STORE };
  }
}

let saveTimer: number | undefined;

export function saveStore(store: Store): void {
  // Debounced: streaming tokens update state many times per second.
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(store));
    } catch {
      // Quota exceeded: drop oldest threads and retry once.
      try {
        const trimmed = { ...store, threads: store.threads.slice(-10) };
        localStorage.setItem(KEY, JSON.stringify(trimmed));
      } catch {
        // Give up silently — the chat still works for this session.
      }
    }
  }, 250);
}

export function clearStore(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
