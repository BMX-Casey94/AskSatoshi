/**
 * API client. Chat uses SSE over POST (EventSource cannot POST), parsed manually
 * from the readable stream. All errors from the server arrive as typed witty events.
 */

import type { AttachedImage, Citation, SatoshiActivityResponse, StatusResponse } from '../types';

export interface ChatHandlers {
  onDelta: (text: string) => void;
  onMeta: (meta: { mode?: string; citations?: Citation[]; tier?: string }) => void;
  onError: (err: { code: string; message: string; retryAfter?: string }) => void;
  onDone: () => void;
  /** Pre-grounding status, e.g. the MCP child is still waking up. */
  onStatus?: (status: { phase?: string }) => void;
}

interface ChatMessagePayload {
  role: 'user' | 'assistant';
  content: string;
}

export async function getStatus(signal?: AbortSignal): Promise<StatusResponse> {
  const res = await fetch('/api/status', { signal });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()) as StatusResponse;
}

function isSatoshiActivityResponse(value: unknown): value is SatoshiActivityResponse {
  if (!value || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  const byKind = o.byKind;
  if (!byKind || typeof byKind !== 'object') return false;
  const kinds = byKind as Record<string, unknown>;
  if (typeof o.generatedAt !== 'string' || typeof o.total !== 'number') return false;
  if (typeof kinds.emails !== 'number' || typeof kinds.posts !== 'number') return false;
  if (!Array.isArray(o.points)) return false;
  return o.points.every((p) => {
    if (!p || typeof p !== 'object') return false;
    const row = p as Record<string, unknown>;
    return (
      typeof row.date === 'string' &&
      typeof row.kind === 'string' &&
      typeof row.title === 'string' &&
      typeof row.url === 'string'
    );
  });
}

export async function getSatoshiActivity(signal?: AbortSignal): Promise<SatoshiActivityResponse> {
  const res = await fetch('/api/satoshi-activity', { signal });
  if (!res.ok) throw new Error(`Activity record unavailable (${res.status}).`);
  const body: unknown = await res.json();
  if (!isSatoshiActivityResponse(body)) {
    throw new Error('Activity record was malformed.');
  }
  return body;
}

export async function streamChat(
  messages: ChatMessagePayload[],
  image: AttachedImage | null,
  handlers: ChatHandlers,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages,
      ...(image ? { image: { data: image.data, mimeType: image.mimeType } } : {}),
    }),
    signal,
  });

  if (!res.ok || !res.body) {
    // Rate limits and pre-stream exhaustion arrive as JSON, not SSE.
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string; retryAfter?: string } };
      if (body.error?.code && body.error.message) {
        handlers.onError({
          code: body.error.code,
          message: body.error.message,
          retryAfter: body.error.retryAfter,
        });
        return;
      }
    } catch {
      // fall through to generic error
    }
    handlers.onError({
      code: 'PROVIDER_ERROR',
      message: 'Something upstream has gone pear-shaped. Not a reorg, just a hiccup — try again in a moment.',
    });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = 'message';

  const dispatch = (rawEvent: string) => {
    const dataLines = rawEvent
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart());
    if (dataLines.length === 0) return;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(dataLines.join('\n')) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (currentEvent) {
      case 'delta':
        if (typeof payload.text === 'string') handlers.onDelta(payload.text);
        break;
      case 'meta':
        handlers.onMeta(payload as { mode?: string; citations?: Citation[]; tier?: string });
        break;
      case 'status':
        handlers.onStatus?.(payload as { phase?: string });
        break;
      case 'error':
        handlers.onError({
          code: String(payload.code ?? 'PROVIDER_ERROR'),
          message: String(payload.message ?? 'Something went wrong.'),
          retryAfter: typeof payload.retryAfter === 'string' ? payload.retryAfter : undefined,
        });
        break;
      case 'done':
        handlers.onDone();
        break;
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const eventLine = rawEvent.split('\n').find((l) => l.startsWith('event:'));
      if (eventLine) currentEvent = eventLine.slice(6).trim();
      if (rawEvent.startsWith(':')) continue; // heartbeat
      dispatch(rawEvent);
      currentEvent = 'message';
    }
  }
}
