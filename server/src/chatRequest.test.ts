import { describe, expect, it } from 'vitest';
import {
  chatBodySchema,
  DEFAULT_IMAGE_QUESTION,
  effectiveQuestion,
  MAX_HISTORY_TURN_CHARS,
  MAX_IMAGE_BASE64_CHARS,
  MAX_IMAGE_BYTES,
  MAX_MESSAGES_PER_REQUEST,
  MAX_QUESTION_CHARS,
  resolveChatInput,
  sanitiseMessages,
  sniffImageMime,
  validateChatImage,
} from './chatRequest.js';

const user = (content: string) => ({ role: 'user' as const, content });
const assistant = (content: string) => ({ role: 'assistant' as const, content });

describe('chatBodySchema', () => {
  it('accepts a short question with a long assistant answer in history (the poisoning case)', () => {
    // A detailed answer can legitimately reach ~32k chars at the paid output cap;
    // it must never make the next "Hi" fail validation.
    const result = chatBodySchema.safeParse({
      messages: [user('Give me a detailed architecture answer.'), assistant('a'.repeat(20_000)), user('Hi')],
    });
    expect(result.success).toBe(true);
  });

  it('keeps the documented ceilings', () => {
    // The latest-turn cap lives in the handler (8,000); history turns get 40,000 —
    // above the longest answer the paid tiers can produce.
    expect(MAX_QUESTION_CHARS).toBe(8_000);
    expect(MAX_HISTORY_TURN_CHARS).toBeGreaterThan(32_000);
  });

  it('rejects a history turn above the abuse ceiling', () => {
    const result = chatBodySchema.safeParse({
      messages: [assistant('a'.repeat(MAX_HISTORY_TURN_CHARS + 1)), user('Hi')],
    });
    expect(result.success).toBe(false);
  });

  it('bounds the message count', () => {
    const ok = chatBodySchema.safeParse({
      messages: Array.from({ length: MAX_MESSAGES_PER_REQUEST }, () => user('hi')),
    });
    expect(ok.success).toBe(true);
    const tooMany = chatBodySchema.safeParse({
      messages: Array.from({ length: MAX_MESSAGES_PER_REQUEST + 1 }, () => user('hi')),
    });
    expect(tooMany.success).toBe(false);
  });

  it('still rejects malformed shapes', () => {
    expect(chatBodySchema.safeParse({ messages: [] }).success).toBe(false);
    expect(chatBodySchema.safeParse({ messages: [{ role: 'system', content: 'x' }] }).success).toBe(false);
    expect(chatBodySchema.safeParse({ messages: [{ role: 'user', content: 42 }] }).success).toBe(false);
  });

  it('accepts beginner, developer and historian depth, and treats absence as the default', () => {
    for (const depth of ['beginner', 'developer', 'historian'] as const) {
      expect(chatBodySchema.safeParse({ messages: [user('What is SPV?')], depth }).success).toBe(true);
    }
    const omitted = chatBodySchema.safeParse({ messages: [user('What is SPV?')] });
    expect(omitted.success).toBe(true);
    if (omitted.success) expect(omitted.data.depth).toBeUndefined();
  });

  it('rejects a depth outside the three levels', () => {
    expect(chatBodySchema.safeParse({ messages: [user('Hi')], depth: 'default' }).success).toBe(false);
    expect(chatBodySchema.safeParse({ messages: [user('Hi')], depth: 'expert' }).success).toBe(false);
    expect(chatBodySchema.safeParse({ messages: [user('Hi')], depth: '' }).success).toBe(false);
  });

  it('accepts a valid image and rejects bad mime types', () => {
    const withImage = chatBodySchema.safeParse({
      messages: [user('what is in this image?')],
      image: { data: 'aGk=', mimeType: 'image/png' },
    });
    expect(withImage.success).toBe(true);
    const badMime = chatBodySchema.safeParse({
      messages: [user('what is in this image?')],
      image: { data: 'aGk=', mimeType: 'image/gif' },
    });
    expect(badMime.success).toBe(false);
  });
});

describe('sanitiseMessages', () => {
  it('drops blank history turns left by aborted streams', () => {
    const result = sanitiseMessages([user('first'), assistant(''), user('Hi')]);
    expect(result).toEqual([user('first'), user('Hi')]);
  });

  it('drops whitespace-only history turns', () => {
    const result = sanitiseMessages([assistant('   \n  '), user('Hi')]);
    expect(result).toEqual([user('Hi')]);
  });

  it('always keeps the latest turn so the handler can validate it strictly', () => {
    const result = sanitiseMessages([user('first'), user('')]);
    expect(result).toHaveLength(2);
    expect(result[1]!.content).toBe('');
  });

  it('leaves a healthy conversation untouched', () => {
    const thread = [user('q1'), assistant('a1'), user('q2')];
    expect(sanitiseMessages(thread)).toEqual(thread);
  });

  it('keeps a blank latest turn so an image-only send can be defaulted', () => {
    const result = sanitiseMessages([user('earlier'), assistant(''), user('   ')]);
    expect(result.map((m) => m.content)).toEqual(['earlier', '   ']);
    expect(effectiveQuestion(result[result.length - 1]!.content, true)).toEqual({
      ok: true,
      question: DEFAULT_IMAGE_QUESTION,
    });
    expect(effectiveQuestion(result[result.length - 1]!.content, false)).toEqual({
      ok: false,
      code: 'BAD_INPUT',
    });
  });
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff]);
const WEBP = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x0a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

function pngOfSize(bytes: number): string {
  const buf = Buffer.alloc(bytes);
  PNG.copy(buf);
  return buf.toString('base64');
}

describe('image magic bytes', () => {
  it('recognises PNG, JPEG and WebP headers and nothing else', () => {
    expect(sniffImageMime(PNG)).toBe('image/png');
    expect(sniffImageMime(PNG.subarray(0, 4))).toBe('image/png');
    expect(sniffImageMime(JPEG)).toBe('image/jpeg');
    expect(sniffImageMime(WEBP)).toBe('image/webp');
    expect(sniffImageMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeUndefined();
    expect(sniffImageMime(Buffer.from('GIF89a'))).toBeUndefined();
    expect(
      sniffImageMime(Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])),
    ).toBeUndefined();
    expect(sniffImageMime(PNG.subarray(0, 3))).toBeUndefined();
    expect(sniffImageMime(WEBP.subarray(0, 8))).toBeUndefined();
  });

  it('rejects a declared type that does not match the bytes, including SVG', () => {
    expect(validateChatImage({ data: PNG.toString('base64'), mimeType: 'image/png' })).toEqual({
      ok: true,
      mimeType: 'image/png',
    });
    expect(validateChatImage({ data: JPEG.toString('base64'), mimeType: 'image/jpeg' })).toEqual({
      ok: true,
      mimeType: 'image/jpeg',
    });
    expect(validateChatImage({ data: WEBP.toString('base64'), mimeType: 'image/webp' })).toEqual({
      ok: true,
      mimeType: 'image/webp',
    });
    expect(validateChatImage({ data: PNG.toString('base64'), mimeType: 'image/jpeg' })).toEqual({
      ok: false,
      code: 'IMAGE_REJECTED',
    });
    expect(validateChatImage({ data: JPEG.toString('base64'), mimeType: 'image/png' })).toEqual({
      ok: false,
      code: 'IMAGE_REJECTED',
    });
    expect(validateChatImage({ data: WEBP.toString('base64'), mimeType: 'image/png' })).toEqual({
      ok: false,
      code: 'IMAGE_REJECTED',
    });
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString('base64');
    expect(validateChatImage({ data: svg, mimeType: 'image/png' })).toEqual({
      ok: false,
      code: 'IMAGE_REJECTED',
    });
    expect(validateChatImage({ data: Buffer.from('GIF89a').toString('base64'), mimeType: 'image/png' })).toEqual({
      ok: false,
      code: 'IMAGE_REJECTED',
    });
  });
});

describe('effectiveQuestion', () => {
  it('defaults a blank image question and still rejects a blank text question', () => {
    expect(effectiveQuestion('', true)).toEqual({ ok: true, question: DEFAULT_IMAGE_QUESTION });
    expect(effectiveQuestion('  \n', true)).toEqual({ ok: true, question: DEFAULT_IMAGE_QUESTION });
    expect(effectiveQuestion('', false)).toEqual({ ok: false, code: 'BAD_INPUT' });
    expect(effectiveQuestion('   ', false)).toEqual({ ok: false, code: 'BAD_INPUT' });
  });

  it('keeps a real question and still rejects an over-long one when an image is attached', () => {
    expect(effectiveQuestion('What is this?', true)).toEqual({ ok: true, question: 'What is this?' });
    expect(effectiveQuestion('  What is this?  ', false)).toEqual({
      ok: true,
      question: '  What is this?  ',
    });
    const over = 'a'.repeat(MAX_QUESTION_CHARS + 1);
    expect(effectiveQuestion(over, true)).toEqual({ ok: false, code: 'BAD_INPUT' });
    expect(effectiveQuestion(over, false)).toEqual({ ok: false, code: 'BAD_INPUT' });
  });
});

describe('resolveChatInput', () => {
  const png = PNG.toString('base64');

  it('accepts a 4 MiB PNG and rejects one byte over as IMAGE_REJECTED', () => {
    const exact = pngOfSize(MAX_IMAGE_BYTES);
    expect(exact.length).toBe(5_592_408);
    expect(exact.length).toBeLessThanOrEqual(MAX_IMAGE_BASE64_CHARS);
    const ok = resolveChatInput({
      messages: [user('What does this image show?')],
      image: { data: exact, mimeType: 'image/png' },
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.image?.mimeType).toBe('image/png');

    const over = pngOfSize(MAX_IMAGE_BYTES + 1);
    expect(over.length).toBeLessThanOrEqual(MAX_IMAGE_BASE64_CHARS);
    expect(
      chatBodySchema.safeParse({
        messages: [user('What does this image show?')],
        image: { data: over, mimeType: 'image/png' },
      }).success,
    ).toBe(true);
    expect(
      resolveChatInput({
        messages: [user('What does this image show?')],
        image: { data: over, mimeType: 'image/png' },
      }),
    ).toEqual({ ok: false, code: 'IMAGE_REJECTED' });
  });

  it('reports a base64 string past the character ceiling as IMAGE_REJECTED, not BAD_INPUT', () => {
    const huge = 'A'.repeat(MAX_IMAGE_BASE64_CHARS + 1);
    expect(
      chatBodySchema.safeParse({
        messages: [user('hi')],
        image: { data: huge, mimeType: 'image/png' },
      }).success,
    ).toBe(false);
    expect(
      resolveChatInput({
        messages: [user('hi')],
        image: { data: huge, mimeType: 'image/png' },
      }),
    ).toEqual({ ok: false, code: 'IMAGE_REJECTED' });
  });

  it('rejects loose base64 as BAD_INPUT and a magic mismatch as IMAGE_REJECTED', () => {
    expect(
      resolveChatInput({
        messages: [user('hi')],
        image: { data: 'aGk=\n', mimeType: 'image/png' },
      }),
    ).toEqual({ ok: false, code: 'BAD_INPUT' });
    expect(
      resolveChatInput({
        messages: [user('hi')],
        image: { data: 'aG==', mimeType: 'image/png' },
      }),
    ).toEqual({ ok: false, code: 'BAD_INPUT' });
    expect(
      resolveChatInput({
        messages: [user('hi')],
        image: { data: png, mimeType: 'image/svg+xml' },
      }),
    ).toEqual({ ok: false, code: 'BAD_INPUT' });
    expect(
      resolveChatInput({
        messages: [user('hi')],
        image: { data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64'), mimeType: 'image/png' },
      }),
    ).toEqual({ ok: false, code: 'IMAGE_REJECTED' });
    expect(
      resolveChatInput({
        messages: [user('hi')],
        image: { data: png, mimeType: 'image/jpeg' },
      }),
    ).toEqual({ ok: false, code: 'IMAGE_REJECTED' });
  });

  it('turns a blank latest message with an image into the default question and keeps the turn', () => {
    const resolved = resolveChatInput({
      messages: [user('earlier'), assistant(''), user('   ')],
      image: { data: png, mimeType: 'image/png' },
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.messages.map((m) => m.content)).toEqual(['earlier', '   ']);
    expect(resolved.value.question).toBe(DEFAULT_IMAGE_QUESTION);
    expect(resolved.value.image).toEqual({ data: png, mimeType: 'image/png' });
  });

  it('keeps BAD_INPUT for a blank message when there is no image', () => {
    expect(resolveChatInput({ messages: [user('   ')] })).toEqual({ ok: false, code: 'BAD_INPUT' });
    expect(resolveChatInput({ messages: [user('')] })).toEqual({ ok: false, code: 'BAD_INPUT' });
  });

  it('keeps a written question that arrives with an image', () => {
    const resolved = resolveChatInput({
      messages: [user('What does this image show?')],
      image: { data: png, mimeType: 'image/png' },
      depth: 'beginner',
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.question).toBe('What does this image show?');
    expect(resolved.value.depth).toBe('beginner');
  });
});
