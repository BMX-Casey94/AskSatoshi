/**
 * Chat request contract, extracted from index.ts so the rules are unit-testable
 * without booting the server.
 *
 * The asymmetry that matters: the LATEST message is the user's actual input.
 * Without an image it must be non-blank and ≤ MAX_QUESTION_CHARS. With an image, a
 * blank or whitespace-only latest turn becomes the default image question (see
 * effectiveQuestion) — sanitiseMessages keeps that turn so the default can see it.
 * History turns are derived state from our own UI — a long model answer, or an empty
 * bubble left by an aborted stream, must never poison the thread it came from.
 * History therefore gets a ceiling above anything the models can produce, and blank
 * history turns are dropped, never rejected.
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

/**
 * Decoded image ceiling: 4 MiB, the same bound the client enforces on the file.
 * A file of that size encodes to 5,592,408 base64 characters.
 */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/**
 * Base64 character ceiling. It sits above the 4 MiB encoding (5,592,408) and below
 * the JSON body limit. express.json uses `8mb`, which the bytes parser reads as
 * 8 MiB (8,388,608). A max-size image plus a full history budget still fits in that
 * body. Anything over this ceiling, or over MAX_IMAGE_BYTES once decoded, is
 * IMAGE_REJECTED — a schema failure must not turn an oversized image into BAD_INPUT.
 */
export const MAX_IMAGE_BASE64_CHARS = 6_000_000;

export const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];

/** Question used when the user attaches an image and sends no text. */
export const DEFAULT_IMAGE_QUESTION = 'What does this image show, and does it bear on Bitcoin?';

/**
 * Standard base64 only: alphabet, length multiple of 4, padding of 0–2 '=' at the
 * end, no whitespace, no URL-safe alphabet. Linear in the input so a multi-megabyte
 * payload cannot backtrack.
 */
export function isStrictBase64(data: string): boolean {
  const n = data.length;
  if (n === 0 || n % 4 !== 0) return false;
  let pad = 0;
  if (data.charCodeAt(n - 1) === 61) pad = data.charCodeAt(n - 2) === 61 ? 2 : 1;
  const stop = n - pad;
  for (let i = 0; i < stop; i++) {
    const c = data.charCodeAt(i);
    const ok =
      (c >= 48 && c <= 57) ||
      (c >= 65 && c <= 90) ||
      (c >= 97 && c <= 122) ||
      c === 43 ||
      c === 47;
    if (!ok) return false;
  }
  return true;
}

/** Decode strict base64, or undefined when the text is not canonical. */
export function decodeStrictBase64(data: string): Buffer | undefined {
  if (!isStrictBase64(data)) return undefined;
  const bytes = Buffer.from(data, 'base64');
  if (bytes.toString('base64') !== data) return undefined;
  return bytes;
}

/**
 * Magic-byte sniff. The declared mime type is never trusted.
 * PNG 89 50 4E 47, JPEG FF D8 FF, WebP RIFF????WEBP. SVG and anything else are undefined.
 */
export function sniffImageMime(bytes: Uint8Array): ImageMimeType | undefined {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return undefined;
}

export const imageSchema = z.object({
  data: z.string().min(1).max(MAX_IMAGE_BASE64_CHARS).refine(isStrictBase64, 'invalid base64'),
  mimeType: z.enum(IMAGE_MIME_TYPES),
});

const messageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().max(MAX_HISTORY_TURN_CHARS),
});

/**
 * Answer depth. Absent means the default voice. A set depth changes vocabulary and
 * how far the explanation is developed; facts stay as written. Those requests bypass
 * the question-keyed answer cache (see shouldCacheAnswer).
 */
export const ANSWER_DEPTHS = ['beginner', 'developer', 'historian'] as const;
export const answerDepthSchema = z.enum(ANSWER_DEPTHS);
export type AnswerDepth = z.infer<typeof answerDepthSchema>;

export const chatBodySchema = z.object({
  messages: z.array(messageSchema).min(1).max(MAX_MESSAGES_PER_REQUEST),
  image: imageSchema.optional(),
  depth: answerDepthSchema.optional(),
});

/**
 * Drop blank history turns before the conversation is used. An aborted stream can
 * leave an empty assistant bubble in the client's thread; history is derived state,
 * so a blank turn is dropped, never a reason to reject the request. The latest turn
 * is always kept, even when blank. Dropping it would hide an image-only send from
 * effectiveQuestion. A blank latest turn is BAD_INPUT unless an image is attached.
 */
export function sanitiseMessages<T extends { content: string }>(messages: T[]): T[] {
  return messages.filter((m, i) => i === messages.length - 1 || m.content.trim().length > 0);
}

export type ImageCheck =
  | { ok: true; mimeType: ImageMimeType }
  | { ok: false; code: 'IMAGE_REJECTED' | 'BAD_INPUT' };

/**
 * Size, canonical base64, and magic bytes against the declared type.
 * A mismatch (including SVG, GIF, or a PNG declared as JPEG) is IMAGE_REJECTED.
 * The declared mime is not rewritten to the sniffed one.
 */
export function validateChatImage(image: { data: string; mimeType: string }): ImageCheck {
  if (typeof image.data !== 'string' || image.data.length > MAX_IMAGE_BASE64_CHARS) {
    return { ok: false, code: 'IMAGE_REJECTED' };
  }
  const bytes = decodeStrictBase64(image.data);
  if (!bytes) return { ok: false, code: 'BAD_INPUT' };
  if (bytes.length > MAX_IMAGE_BYTES) return { ok: false, code: 'IMAGE_REJECTED' };
  const sniffed = sniffImageMime(bytes);
  if (!sniffed || sniffed !== image.mimeType) return { ok: false, code: 'IMAGE_REJECTED' };
  return { ok: true, mimeType: sniffed };
}

/**
 * True when the raw body carries an image payload past either ceiling. Used when
 * schema parsing fails, so a base64 string over MAX_IMAGE_BASE64_CHARS is
 * IMAGE_REJECTED rather than BAD_INPUT.
 */
export function isOversizeImagePayload(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const image = (body as { image?: unknown }).image;
  if (!image || typeof image !== 'object') return false;
  const data = (image as { data?: unknown }).data;
  if (typeof data !== 'string') return false;
  if (data.length > MAX_IMAGE_BASE64_CHARS) return true;
  const bytes = decodeStrictBase64(data);
  return bytes !== undefined && bytes.length > MAX_IMAGE_BYTES;
}

export function effectiveQuestion(
  content: string,
  hasImage: boolean,
): { ok: true; question: string } | { ok: false; code: 'BAD_INPUT' } {
  if (content.trim().length === 0) {
    if (!hasImage) return { ok: false, code: 'BAD_INPUT' };
    return { ok: true, question: DEFAULT_IMAGE_QUESTION };
  }
  if (content.length > MAX_QUESTION_CHARS) return { ok: false, code: 'BAD_INPUT' };
  return { ok: true, question: content };
}

export interface ResolvedChatInput {
  messages: { role: 'user' | 'assistant'; content: string }[];
  image?: { data: string; mimeType: ImageMimeType };
  question: string;
  depth?: AnswerDepth;
}

/**
 * The chat handler's input gate, kept pure so the error codes are testable
 * without booting the server. Oversize images are IMAGE_REJECTED even when they
 * also fail the schema. Magic-byte mismatches are IMAGE_REJECTED. A blank latest
 * message is BAD_INPUT unless an image is attached.
 */
export function resolveChatInput(
  body: unknown,
): { ok: true; value: ResolvedChatInput } | { ok: false; code: 'BAD_INPUT' | 'IMAGE_REJECTED' } {
  const parsed = chatBodySchema.safeParse(body);
  if (!parsed.success) {
    if (isOversizeImagePayload(body)) return { ok: false, code: 'IMAGE_REJECTED' };
    return { ok: false, code: 'BAD_INPUT' };
  }
  const messages = sanitiseMessages(parsed.data.messages);
  let image: ResolvedChatInput['image'];
  if (parsed.data.image) {
    const checked = validateChatImage(parsed.data.image);
    if (!checked.ok) return { ok: false, code: checked.code };
    image = { data: parsed.data.image.data, mimeType: checked.mimeType };
  }
  const decision = effectiveQuestion(messages[messages.length - 1]?.content ?? '', image !== undefined);
  if (!decision.ok) return { ok: false, code: 'BAD_INPUT' };
  return {
    ok: true,
    value: {
      messages,
      image,
      question: decision.question,
      depth: parsed.data.depth,
    },
  };
}
