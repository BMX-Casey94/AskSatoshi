import { describe, expect, it } from 'vitest';
import { formatCorpusUpdated } from './corpusDate';

describe('formatCorpusUpdated', () => {
  it('formats a calendar date in en-GB long form', () => {
    expect(formatCorpusUpdated('2026-10-27')).toBe('27 October 2026');
    expect(formatCorpusUpdated('2026-10-27T23:30:00.000Z')).toBe('27 October 2026');
  });

  it('returns null for a missing or impossible date', () => {
    expect(formatCorpusUpdated('')).toBeNull();
    expect(formatCorpusUpdated('27 October 2026')).toBeNull();
    expect(formatCorpusUpdated('2026-02-31')).toBeNull();
    expect(formatCorpusUpdated('2026-13-01')).toBeNull();
  });
});
