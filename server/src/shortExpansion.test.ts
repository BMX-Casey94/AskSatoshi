import { describe, expect, it, vi } from 'vitest';
import { AnswerCache, shouldCacheAnswer } from './cache.js';
import {
  answerCacheKeyForTurn,
  expandShortQuery,
  introducesChainClaim,
  mergeRetrievalQueries,
  parseShortExpansion,
  ShortExpansionCache,
  shouldRequestShortExpansion,
  shouldRunShortExpansion,
} from './shortExpansion.js';

const json = (phrases: string[], intent = 'merkle proof'): string =>
  JSON.stringify({ phrases, intent });

describe('parseShortExpansion', () => {
  it('keeps plain phrases, strips punctuation, and caps the list', () => {
    const parsed = parseShortExpansion(
      '```json\n{"phrases":["Merkle proof, SPV!","OP_RETURN data","OP_RETURN data","one","two","three"],"intent":"Merkle proof"}\n```',
      'merkle',
    );
    expect(parsed?.intent).toBe('Merkle proof');
    expect(parsed?.phrases).toEqual(['Merkle proof SPV', 'OP_RETURN data', 'one', 'two']);
  });

  it('drops a chain or contested claim the user did not write', () => {
    expect(introducesChainClaim('BSV is the real chain', 'merkle')).toBe(true);
    const parsed = parseShortExpansion(
      json(['OP_RETURN data storage', 'Bitcoin is a ponzi', 'BSV script']),
      'op return',
    );
    expect(parsed?.phrases).toEqual(['OP_RETURN data storage']);
  });

  it('keeps a contested word the user already used', () => {
    const parsed = parseShortExpansion(json(['ponzi scheme history']), 'Is Bitcoin a Ponzi scheme?');
    expect(parsed?.phrases).toEqual(['ponzi scheme history']);
  });

  it('rejects a reply that is not the expected object', () => {
    expect(parseShortExpansion('not json', 'merkle')).toBeUndefined();
    expect(parseShortExpansion('{"phrases":["Merkle proof"]}', 'merkle')).toBeUndefined();
    expect(parseShortExpansion('{"phrases":[],"intent":""}', 'merkle')).toBeUndefined();
    expect(parseShortExpansion('{"phrases":"nope","intent":"label"}', 'merkle')).toBeUndefined();
  });

  it('accepts an empty phrase list when the label says the index will not help', () => {
    expect(parseShortExpansion('{"phrases":[],"intent":"unrelated"}', 'sourdough')).toEqual({
      phrases: [],
      intent: 'unrelated',
    });
  });
});

describe('mergeRetrievalQueries', () => {
  it('keeps the existing queries first and drops case duplicates', () => {
    expect(
      mergeRetrievalQueries(['Merkle proof', 'withdrew'], ['merkle proof', 'SPV inclusion', 'extra']),
    ).toEqual(['Merkle proof', 'withdrew', 'SPV inclusion', 'extra']);
  });
});

describe('shouldRequestShortExpansion', () => {
  it('runs for a short in-scope fragment and a spaced opcode', () => {
    expect(shouldRequestShortExpansion('merkle')).toBe(true);
    expect(shouldRequestShortExpansion('op return')).toBe(true);
    expect(shouldRequestShortExpansion('why did you leave')).toBe(true);
  });

  it('does not run for a long question or a class that already has a deterministic path', () => {
    expect(
      shouldRequestShortExpansion(
        'How does a Merkle branch prove inclusion of a transaction in a block header for simplified payment verification?',
      ),
    ).toBe(false);
    expect(shouldRequestShortExpansion('What is BRC-100?')).toBe(false);
    expect(shouldRequestShortExpansion('What is timecoin?')).toBe(false);
    expect(shouldRequestShortExpansion('What is HandCash launching?')).toBe(false);
    expect(shouldRequestShortExpansion('List BSV apps')).toBe(false);
    expect(shouldRequestShortExpansion('thanks')).toBe(false);
    expect(shouldRequestShortExpansion('Sourdough')).toBe(false);
    expect(shouldRequestShortExpansion('Who are you?')).toBe(false);
    expect(shouldRequestShortExpansion('OP_RETURN')).toBe(false);
  });
});

describe('expandShortQuery', () => {
  it('does not call the model when there are no keys', async () => {
    const model = vi.fn(async () => json(['Merkle proof']));
    const outcome = await expandShortQuery('merkle', model, { hasKeys: false });
    expect(outcome).toEqual({ phrases: [], status: 'skipped' });
    expect(model).not.toHaveBeenCalled();
  });

  it('falls back when the model does not answer in time, and does not cache that miss', async () => {
    const cache = new ShortExpansionCache();
    let release: (value: string) => void = () => undefined;
    const hanging = new Promise<string>((resolve) => {
      release = resolve;
    });
    const outcome = await expandShortQuery('merkle', () => hanging, { timeoutMs: 15, cache });
    expect(outcome).toEqual({ phrases: [], status: 'timeout' });
    release(json(['Merkle proof SPV']));
    const model = vi.fn(async () => json(['Merkle proof SPV']));
    const again = await expandShortQuery('merkle', model, { cache });
    expect(again.status).toBe('ok');
    expect(model).toHaveBeenCalledOnce();
  });

  it('treats a thrown model error as a timeout', async () => {
    const outcome = await expandShortQuery('merkle', async () => {
      throw new Error('provider down');
    }, { timeoutMs: 50 });
    expect(outcome).toEqual({ phrases: [], status: 'timeout' });
  });

  it('caches an accepted list and an empty list, and retries a discarded reply', async () => {
    const cache = new ShortExpansionCache();
    const first = vi.fn(async () => json(['Merkle proof SPV'], 'merkle proof'));
    expect((await expandShortQuery('merkle', first, { cache })).status).toBe('ok');
    const second = vi.fn(async () => json(['should not run']));
    const hit = await expandShortQuery('merkle', second, { cache });
    expect(hit).toEqual({ phrases: ['Merkle proof SPV'], status: 'cache' });
    expect(second).not.toHaveBeenCalled();

    const emptyCache = new ShortExpansionCache();
    const emptyModel = vi.fn(async () => '{"phrases":[],"intent":"unrelated"}');
    expect(await expandShortQuery('op return', emptyModel, { cache: emptyCache })).toEqual({
      phrases: [],
      status: 'empty',
    });
    expect(await expandShortQuery('op return', emptyModel, { cache: emptyCache })).toEqual({
      phrases: [],
      status: 'cache',
    });
    expect(emptyModel).toHaveBeenCalledOnce();

    const discardCache = new ShortExpansionCache();
    const bad = vi.fn(async () => 'nope');
    expect((await expandShortQuery('merkle', bad, { cache: discardCache })).status).toBe('discarded');
    expect((await expandShortQuery('merkle', bad, { cache: discardCache })).status).toBe('discarded');
    expect(bad).toHaveBeenCalledTimes(2);
  });
});

describe('answer cache interplay', () => {
  it('does not fold expansion phrases into the question key', () => {
    expect(answerCacheKeyForTurn('merkle', ['Merkle proof SPV'])).toBe(AnswerCache.key('merkle'));
    expect(shouldCacheAnswer({ standalone: true, hasImage: false, contested: false })).toBe(true);
    expect(shouldRunShortExpansion({ question: 'merkle', hasKeys: true })).toBe(true);
    expect(shouldRunShortExpansion({ question: 'merkle', hasKeys: true, constrained: true })).toBe(false);
  });
});
