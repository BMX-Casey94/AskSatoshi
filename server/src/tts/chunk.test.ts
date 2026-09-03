import { describe, expect, it } from 'vitest';
import { CHUNK_MAX_CHARS, chunkText } from './chunk.js';

describe('chunkText', () => {
  it('returns an empty array for empty or whitespace-only text', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\t  ')).toEqual([]);
  });

  it('keeps a short text as a single chunk', () => {
    expect(chunkText('Hello, world.')).toEqual(['Hello, world.']);
  });

  it('packs sentences greedily without exceeding max', () => {
    const text = 'Hello there. How are you? I am fine.';
    const chunks = chunkText(text, 28);
    expect(chunks.every((c) => c.length <= 28)).toBe(true);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('').replace(/\s+/g, ' ').trim()).toBe(text.replace(/\s+/g, ' ').trim());
    // First two short sentences fit together; the third needs its own chunk.
    expect(chunks[0]).toMatch(/Hello there\./);
    expect(chunks[0]).toMatch(/How are you\?/);
    expect(chunks.at(-1)).toMatch(/I am fine\./);
  });

  it('treats . ! ? … and : followed by space or newline as sentence boundaries', () => {
    const text = 'Wait: now. Wow! What? Hmm… done.';
    const chunks = chunkText(text, 12);
    expect(chunks.every((c) => c.length <= 12)).toBe(true);
    expect(chunks.some((c) => c.includes('Wait:'))).toBe(true);
    expect(chunks.join('')).toContain('Wow!');
    expect(chunks.join('')).toContain('What?');
    expect(chunks.join('')).toContain('Hmm…');
  });

  it('also splits on newlines', () => {
    const chunks = chunkText('first line\nsecond line\nthird', 15);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 15)).toBe(true);
    expect(chunks.join('')).toContain('first line');
    expect(chunks.join('')).toContain('second line');
  });

  it('splits an oversized sentence at the last space before max', () => {
    const text = 'alpha bravo charlie delta echo';
    const chunks = chunkText(text, 14);
    expect(chunks.every((c) => c.length <= 14)).toBe(true);
    expect(chunks[0]).toBe('alpha bravo');
    expect(chunks.join(' ')).toMatch(/charlie/);
    expect(chunks.some((c) => c.includes(' '))).toBe(true);
  });

  it('hard-cuts when a sentence has no space and exceeds max', () => {
    const text = 'abcdefghijklmnopqrstuvwxyz';
    const chunks = chunkText(text, 10);
    expect(chunks).toEqual(['abcdefghij', 'klmnopqrst', 'uvwxyz']);
    expect(chunks.every((c) => c.length <= 10)).toBe(true);
  });

  it('never returns a chunk longer than the default Resemble headroom limit', () => {
    const sentence = `${'Word '.repeat(800)}end.`;
    const chunks = chunkText(sentence);
    expect(CHUNK_MAX_CHARS).toBe(2_400);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= CHUNK_MAX_CHARS)).toBe(true);
  });
});
