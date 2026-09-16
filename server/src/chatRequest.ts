/**
 * Chat request contract, extracted from index.ts so the rules are unit-testable
 * without booting the server.
 *
 * The asymmetry that matters: the LATEST message is the user's actual input and is
 * validated strictly by the handler (non-blank, ≤ MAX_QUESTION_CHARS). History turns
 * are derived state from our own UI — a long model answer, or an empty bubble left
 * by an aborted stream, must never poison the thread it came from. History therefore
 * gets a ceiling above anything the models can produce, and blank history turns are
 * dropped (see sanitiseMessages), never rejected.
 */

import { z } from 'zod';

/** Max length of the latest user message. Generous — the paid tiers' context is huge. */
export const MAX_QUESTION_CHARS = 8_000;
/**
 * Ceiling for a single history turn. Assistant turns carry full answers, and the
 * paid output cap (8,192 tokens) can produce ~32k chars — 40k sits above that, so a
 * long answer can never fail validation in its own thread. The model call windows
 * history to its own char budget regardless of this bound.
 */
export const MAX_HISTORY_TURN_CHARS = 40_000;
/**
 * Abuse bound on payload size. The server only reads the last few turns and our
 * client sends at most 11; 60 gives other clients headroom while bounding validation
 * work (the 8mb JSON body limit remains the absolute bound).
 */
export const MAX_MESSAGES_PER_REQUEST = 60;

export const imageSchema = z.object({
  data: z
    .string()
    .max(6_000_000)
    .regex(/^[A-Za-z0-9+/=\r\n]+$/, 'invalid base64'),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
});

const messageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().max(MAX_HISTORY_TURN_CHARS),
});

export const chatBodySchema = z.object({
  messages: z.array(messageSchema).min(1).max(MAX_MESSAGES_PER_REQUEST),
  image: imageSchema.optional(),
});

/**
 * Drop blank history turns before the conversation is used. An aborted stream can
 * leave an empty assistant bubble in the client's thread; history is derived state,
 * so a blank turn is dropped, never a reason to reject the request. The latest turn
 * is always kept — the handler validates it strictly and returns BAD_INPUT for a
 * blank or over-long current message.
 */
export function sanitiseMessages<T extends { content: string }>(messages: T[]): T[] {
  return messages.filter((m, i) => i === messages.length - 1 || m.content.trim().length > 0);
}
