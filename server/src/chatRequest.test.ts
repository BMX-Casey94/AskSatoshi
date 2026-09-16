import { describe, expect, it } from 'vitest';
import {
  chatBodySchema,
  MAX_HISTORY_TURN_CHARS,
  MAX_MESSAGES_PER_REQUEST,
  MAX_QUESTION_CHARS,
  sanitiseMessages,
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
});
