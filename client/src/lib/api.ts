/**
 * API client. Chat uses SSE over POST (EventSource cannot POST), parsed manually
 * from the readable stream. All errors from the server arrive as typed witty events.
 */

import type { AttachedImage, Citation, StatusResponse } from '../types';

export interface ChatHandlers {
  onDelta: (text: string) => void;
  onMeta: (meta: { mode?: string; citations?: Citation[]; tier?: string }) => void;
  onError: (err: { code: string; message: string; retryAfter?: string }) => void;
  onDone: () => void;
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
