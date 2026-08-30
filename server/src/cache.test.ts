import { describe, expect, it } from 'vitest';
import { AnswerCache } from './cache.js';

const answer = { text: 'SPV is described in section 8…', mode: 'mcp' as const, citations: [] };

describe('AnswerCache', () => {
  it('normalises case, punctuation and whitespace', () => {
    const c = new AnswerCache();
    c.set('What is SPV?', answer);
    expect(c.get('what  is   spv')).toEqual(answer);
    expect(c.get('WHAT IS SPV!')).toEqual(answer);
  });

  it('misses on different questions', () => {
    const c = new AnswerCache();
    c.set('What is SPV?', answer);
    expect(c.get('Why run a home node?')).toBeUndefined();
  });

  it('evicts least-recently-used beyond capacity', () => {
    const c = new AnswerCache(2);
    c.set('q1', answer);
    c.set('q2', answer);
    c.get('q1'); // touch q1 so q2 is oldest
    c.set('q3', answer);
    expect(c.get('q2')).toBeUndefined();
    expect(c.get('q1')).toEqual(answer);
    expect(c.get('q3')).toEqual(answer);
  });

  it('expires entries after the TTL', async () => {
    const c = new AnswerCache(10, 5);
    c.set('q1', answer);
    await new Promise((r) => setTimeout(r, 10));
    expect(c.get('q1')).toBeUndefined();
  });
});
