import { describe, expect, it } from 'vitest';
import type { Thread } from '../types';
import { searchThreads } from './threadSearch';

function thread(id: string, title: string, messages: string[]): Thread {
  return {
    id,
    title,
    createdAt: 0,
    updatedAt: 0,
    messages: messages.map((content, index) => ({
      id: `${id}-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content,
      ts: index,
    })),
  };
}

function hitText(parts: { text: string; hit: boolean }[] | null): string {
  return (parts ?? []).filter((part) => part.hit).map((part) => part.text).join('');
}

describe('searchThreads', () => {
  const threads = [
    thread('both', 'SPV notes', ['Nothing here', 'A Merkle branch links a transaction to a header']),
    thread('one', 'SPV notes', ['Headers only']),
    thread('cafe', 'Café ledger', ['A naïve note about blocks']),
    thread('later', 'Chat', ['no match here', 'the merkle proof sits here', 'another merkle later']),
  ];

  it('returns every thread, in order, for a blank query', () => {
    expect(searchThreads(threads, '   ').map((hit) => hit.id)).toEqual(['both', 'one', 'cafe', 'later']);
    expect(searchThreads(threads, '   ')[0]?.snippet).toBeNull();
  });

  it('requires every term and ignores case', () => {
    expect(searchThreads(threads, 'merkle header').map((hit) => hit.id)).toEqual(['both']);
    expect(searchThreads(threads, 'MERKLE').map((hit) => hit.id)).toEqual(['both', 'later']);
  });

  it('matches without diacritics in either the query or the text', () => {
    const hits = searchThreads(threads, 'cafe naive');
    expect(hits.map((hit) => hit.id)).toEqual(['cafe']);
    expect(hitText(hits[0]?.title ?? null)).toBe('Café');
    expect(hitText(hits[0]?.snippet ?? null)).toContain('naïve');
  });

  it('highlights the original casing and snippets the first matching message', () => {
    const hit = searchThreads(threads, 'merkle')[1];
    expect(hit?.id).toBe('later');
    expect(hitText(hit?.snippet ?? null)).toBe('merkle');
    const snippet = (hit?.snippet ?? []).map((part) => part.text).join('');
    expect(snippet).toContain('the merkle proof sits here');
    expect(snippet).not.toContain('another merkle later');
  });

  it('treats punctuation in the query as literal text', () => {
    expect(() => searchThreads(threads, 'spv (section')).not.toThrow();
    expect(searchThreads(threads, 'spv (section')).toEqual([]);
    const literal = searchThreads(
      [thread('rx', 'Notes', ['See spv (section 8) for the header'])],
      'spv (section',
    );
    expect(literal).toHaveLength(1);
    const snippet = (literal[0]?.snippet ?? []).map((part) => part.text).join('');
    expect(snippet).toContain('spv (section');
    expect(hitText(literal[0]?.snippet ?? null)).toContain('spv');
    expect(hitText(literal[0]?.snippet ?? null)).toContain('(section');
  });

  it('omits a snippet when only the title matches', () => {
    const hit = searchThreads([thread('t', 'Difficulty adjustment', ['Unrelated body'])], 'difficulty');
    expect(hit[0]?.snippet).toBeNull();
    expect(hitText(hit[0]?.title ?? null)).toBe('Difficulty');
  });
});
