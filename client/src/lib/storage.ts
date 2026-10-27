/**
 * All chat state lives here — localStorage only, nothing leaves the device except
 * the single question sent to /api/chat. Versioned schema so future shape changes
 * can migrate instead of corrupting.
 */

import type { Citation, Depth, GroundingMode, Message, MessageRole, SourceClass, Thread } from '../types';

const KEY = 'ask-satoshi:v1';
const DEPTH_KEY = 'ask-satoshi:depth';

export interface Store {
  version: 1;
  theme: 'light' | 'dark' | null;
  threads: Thread[];
  activeThreadId: string | null;
  /** True once the local-storage notice has been shown. */
  storageNoticeSeen?: boolean;
}

const GROUNDING_MODES = new Set<GroundingMode>(['mcp', 'corpus', 'reference', 'none']);
const RATINGS = new Set<Message['rating']>(['up', 'down']);
const ROLES = new Set<MessageRole>(['user', 'assistant']);
const SOURCE_CLASSES = new Set<SourceClass>(['satoshi-primary', 'spec', 'later-commentary', 'historical-record', 'news']);
const DEPTHS = new Set<Depth>(['default', 'beginner', 'developer', 'historian']);
const MAX_FOLLOW_UPS = 3;
const MAX_FOLLOW_UP_CHARS = 400;

function blankStore(): Store {
  return { version: 1, theme: null, threads: [], activeThreadId: null };
}

export function isGroundingMode(value: unknown): value is GroundingMode {
  return typeof value === 'string' && GROUNDING_MODES.has(value as GroundingMode);
}

/** Keep up to three non-empty questions. A non-string entry rejects the whole field. */
export function sanitizeFollowUps(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return undefined;
  const followUps = value
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item.length <= MAX_FOLLOW_UP_CHARS)
    .slice(0, MAX_FOLLOW_UPS);
  return followUps.length > 0 ? followUps : undefined;
}

export function parseDepth(value: unknown): Depth {
  return typeof value === 'string' && DEPTHS.has(value as Depth) ? (value as Depth) : 'default';
}

export function loadDepth(): Depth {
  try {
    return parseDepth(localStorage.getItem(DEPTH_KEY));
  } catch {
    return 'default';
  }
}

export function saveDepth(depth: Depth): void {
  try {
    localStorage.setItem(DEPTH_KEY, depth);
  } catch {
    // The choice still applies for this session.
  }
}

function optionalString(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : null;
}

function parseCitation(value: unknown): Citation | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.label !== 'string' || row.label.trim() === '') return null;
  const citation: Citation = { label: row.label };
  const title = optionalString(row.title);
  const url = optionalString(row.url);
  const excerpt = optionalString(row.excerpt);
  const date = optionalString(row.date);
  if (title === null || url === null || excerpt === null || date === null) return null;
  if (title !== undefined) citation.title = title;
  if (url !== undefined) citation.url = url;
  if (excerpt !== undefined) citation.excerpt = excerpt;
  if (date !== undefined) citation.date = date;
  if (row.sourceClass !== undefined) {
    if (typeof row.sourceClass !== 'string' || !SOURCE_CLASSES.has(row.sourceClass as SourceClass)) return null;
    citation.sourceClass = row.sourceClass as SourceClass;
  }
  return citation;
}

function parseMessage(value: unknown): Message | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || row.id.length === 0) return null;
  if (typeof row.role !== 'string' || !ROLES.has(row.role as MessageRole)) return null;
  if (typeof row.content !== 'string') return null;
  if (typeof row.ts !== 'number' || !Number.isFinite(row.ts)) return null;

  const message: Message = {
    id: row.id,
    role: row.role as MessageRole,
    content: row.content,
    ts: row.ts,
  };

  // Optional fields that fail validation are omitted. The message itself stays,
  // so one corrupt rating cannot wipe a saved answer.
  if (typeof row.errorCode === 'string') message.errorCode = row.errorCode;
  if (typeof row.streaming === 'boolean') message.streaming = row.streaming;
  if (row.revised === true) message.revised = true;
  if (Array.isArray(row.citations)) {
    const citations: Citation[] = [];
    for (const item of row.citations) {
      const citation = parseCitation(item);
      if (citation) citations.push(citation);
    }
    if (citations.length > 0) message.citations = citations;
  }
  if (isGroundingMode(row.mode)) message.mode = row.mode;
  const followUps = sanitizeFollowUps(row.followUps);
  if (followUps) message.followUps = followUps;
  if (typeof row.rating === 'string' && RATINGS.has(row.rating as Message['rating'])) {
    message.rating = row.rating as 'up' | 'down';
  }
  return message;
}

function parseThread(value: unknown): Thread | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || row.id.length === 0) return null;
  if (typeof row.title !== 'string') return null;
  if (typeof row.createdAt !== 'number' || !Number.isFinite(row.createdAt)) return null;
  if (typeof row.updatedAt !== 'number' || !Number.isFinite(row.updatedAt)) return null;
  if (!Array.isArray(row.messages)) return null;

  const messages: Message[] = [];
  const seen = new Set<string>();
  for (const item of row.messages) {
    const message = parseMessage(item);
    if (!message || seen.has(message.id)) continue;
    seen.add(message.id);
    messages.push(message);
  }
  if (messages.length === 0) return null;
  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    messages,
  };
}

/**
 * Revive a parsed localStorage value. A bad top-level shape returns an empty
 * store. A thread or message missing its required fields is dropped; valid
 * siblings are kept. mode, followUps and rating are kept only when they match
 * the schema — a bad optional field is omitted, not fatal.
 */
export function parseStoredStore(parsed: unknown): Store {
  if (!parsed || typeof parsed !== 'object') return blankStore();
  const row = parsed as Partial<Store>;
  if (row.version !== 1 || !Array.isArray(row.threads)) return blankStore();

  const threads: Thread[] = [];
  const seen = new Set<string>();
  for (const item of row.threads) {
    const thread = parseThread(item);
    if (!thread || seen.has(thread.id)) continue;
    seen.add(thread.id);
    threads.push(thread);
  }

  const active = typeof row.activeThreadId === 'string' ? row.activeThreadId : null;
  return {
    version: 1,
    theme: row.theme === 'dark' || row.theme === 'light' ? row.theme : null,
    threads,
    activeThreadId: active && seen.has(active) ? active : null,
    storageNoticeSeen: row.storageNoticeSeen === true,
  };
}

export function loadStore(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return blankStore();
    return parseStoredStore(JSON.parse(raw) as unknown);
  } catch {
    // Corrupted storage should never take the app down.
    return blankStore();
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
