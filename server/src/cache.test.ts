import { describe, expect, it } from 'vitest';
import { AnswerCache, shouldCacheAnswer } from './cache.js';

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

  it('stores follow-ups alongside the answer', () => {
    const c = new AnswerCache();
    const withFollow = { ...answer, followUps: ['What did Satoshi say about SPV?'] };
    c.set('What is SPV?', withFollow);
    expect(c.get('what is spv')?.followUps).toEqual(['What did Satoshi say about SPV?']);
  });
});

describe('shouldCacheAnswer', () => {
  const ok = { standalone: true, hasImage: false, contested: false };

  it('caches a standalone question at the default depth', () => {
    expect(shouldCacheAnswer(ok)).toBe(true);
    expect(shouldCacheAnswer({ ...ok, depth: undefined })).toBe(true);
  });

  it('bypasses the cache when a depth is set, so depths cannot share an entry', () => {
    expect(shouldCacheAnswer({ ...ok, depth: 'beginner' })).toBe(false);
    expect(shouldCacheAnswer({ ...ok, depth: 'developer' })).toBe(false);
    expect(shouldCacheAnswer({ ...ok, depth: 'historian' })).toBe(false);
  });

  it('still bypasses images, in-thread follow-ups and contested questions', () => {
    expect(shouldCacheAnswer({ ...ok, hasImage: true })).toBe(false);
    expect(shouldCacheAnswer({ ...ok, standalone: false })).toBe(false);
    expect(shouldCacheAnswer({ ...ok, contested: true })).toBe(false);
  });
});
