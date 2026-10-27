import { describe, expect, it } from 'vitest';
import type { KeyValueStore, SuggestionStores } from './suggestionPool';
import {
  SUGGESTION_POOL,
  commitSuggestionDraw,
  pickSuggestions,
  planSuggestionDraw,
  surpriseQuestion,
} from './suggestionPool';

function memory(initial: Record<string, string> = {}): KeyValueStore & { dump: () => Record<string, string> } {
  const data = { ...initial };
  return {
    getItem: (key) => (Object.prototype.hasOwnProperty.call(data, key) ? data[key]! : null),
    setItem: (key, value) => {
      data[key] = value;
    },
    dump: () => ({ ...data }),
  };
}

function setKey(questions: readonly string[]): string {
  return [...questions].sort().join('\n');
}

const IDENTITY_PROMPTS = [
  /who is satoshi/i,
  /are you satoshi/i,
  /real satoshi/i,
  /satoshi is craig/i,
  /craig wright is satoshi/i,
  /is craig wright satoshi/i,
];

describe('SUGGESTION_POOL', () => {
  it('has at least 24 distinct questions and does not ask who Satoshi is', () => {
    expect(SUGGESTION_POOL.length).toBeGreaterThanOrEqual(24);
    expect(new Set(SUGGESTION_POOL).size).toBe(SUGGESTION_POOL.length);
    for (const question of SUGGESTION_POOL) {
      expect(question.endsWith('?')).toBe(true);
      for (const pattern of IDENTITY_PROMPTS) expect(question).not.toMatch(pattern);
    }
  });
});

describe('pickSuggestions', () => {
  it('is deterministic and stays inside the pool', () => {
    const first = pickSuggestions(SUGGESTION_POOL, 4, 5, 2, null);
    const second = pickSuggestions(SUGGESTION_POOL, 4, 5, 2, null);
    expect(second).toEqual(first);
    expect(first.questions).toHaveLength(4);
    expect(new Set(first.questions).size).toBe(4);
    for (const question of first.questions) expect(SUGGESTION_POOL).toContain(question);
  });

  it('advances when the draw would repeat the previous set', () => {
    const baseline = pickSuggestions(SUGGESTION_POOL, 4, 12345, 3, null);
    const avoided = pickSuggestions(SUGGESTION_POOL, 4, 12345, 3, baseline.questions);
    expect(setKey(avoided.questions)).not.toBe(setKey(baseline.questions));
    expect(avoided.nonce).toBeGreaterThan(baseline.nonce);
  });

  it('returns the only possible set when the pool is no larger than the draw', () => {
    const pool = ['a', 'b', 'c', 'd'];
    const draw = pickSuggestions(pool, 4, 1, 0, ['d', 'c', 'b', 'a']);
    expect(new Set(draw.questions)).toEqual(new Set(pool));
  });

  it('returns nothing for an empty pool or a zero count', () => {
    expect(pickSuggestions([], 4, 1, 1, null).questions).toEqual([]);
    expect(pickSuggestions(SUGGESTION_POOL, 0, 1, 1, null).questions).toEqual([]);
  });
});

describe('planSuggestionDraw', () => {
  it('does not repeat the same four on the next page load', () => {
    const stores: SuggestionStores = { session: memory(), local: memory() };
    const first = planSuggestionDraw(SUGGESTION_POOL, 4, stores, 11);
    commitSuggestionDraw(stores, first);
    const second = planSuggestionDraw(SUGGESTION_POOL, 4, stores, 11);
    expect(first.questions).toHaveLength(4);
    expect(setKey(second.questions)).not.toBe(setKey(first.questions));
  });

  it('keeps the shuffle in session storage and leaves local storage alone', () => {
    const session = memory();
    const local = memory();
    const stores: SuggestionStores = { session, local };
    const plan = planSuggestionDraw(SUGGESTION_POOL, 4, stores, 42);
    commitSuggestionDraw(stores, plan);
    expect(Object.keys(session.dump()).length).toBeGreaterThan(0);
    expect(local.dump()).toEqual({});
    const continued = planSuggestionDraw(SUGGESTION_POOL, 4, { session, local: memory() }, 1);
    expect(setKey(continued.questions)).not.toBe(setKey(plan.questions));
  });

  it('ignores storage that throws', () => {
    const broken: KeyValueStore = {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      },
    };
    const stores: SuggestionStores = { session: broken, local: broken };
    expect(() => {
      const plan = planSuggestionDraw(SUGGESTION_POOL, 4, stores, 3);
      expect(plan.questions).toHaveLength(4);
      commitSuggestionDraw(stores, plan);
    }).not.toThrow();
  });
});

describe('surpriseQuestion', () => {
  it('picks from the pool outside the questions already shown', () => {
    const pool = ['a', 'b', 'c'];
    expect(surpriseQuestion(pool, ['a'], () => 0)).toBe('b');
    expect(surpriseQuestion(pool, ['a'], () => 0.999)).toBe('c');
    expect(surpriseQuestion(pool, pool, () => 0.4)).toBeNull();
  });
});
