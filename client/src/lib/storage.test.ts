import { describe, expect, it } from 'vitest';
import { parseDepth, parseStoredStore, sanitizeFollowUps } from './storage';

function message(extra: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    role: 'assistant',
    content: 'The chain with the most proof-of-work is the valid one.',
    ts: 1_700_000_000_000,
    ...extra,
  };
}

function thread(messages: unknown[]) {
  return {
    id: 't1',
    title: 'Longest chain',
    createdAt: 10,
    updatedAt: 20,
    messages,
  };
}

describe('parseStoredStore', () => {
  it('keeps mode, follow-ups and rating on reload', () => {
    const store = parseStoredStore({
      version: 1,
      theme: 'dark',
      activeThreadId: 't1',
      storageNoticeSeen: true,
      threads: [
        thread([
          message({
            mode: 'corpus',
            followUps: ['  What is SPV?  ', 'Why does difficulty adjust?', 'How does Script lock a coin?', 'Fourth is dropped'],
            rating: 'up',
            revised: true,
            citations: [{ label: 'White paper §8', title: 'Bitcoin', sourceClass: 'satoshi-primary' }],
          }),
        ]),
      ],
    });

    const saved = store.threads[0]?.messages[0];
    expect(store.theme).toBe('dark');
    expect(store.activeThreadId).toBe('t1');
    expect(store.storageNoticeSeen).toBe(true);
    expect(saved?.mode).toBe('corpus');
    expect(saved?.rating).toBe('up');
    expect(saved?.revised).toBe(true);
    expect(saved?.followUps).toEqual([
      'What is SPV?',
      'Why does difficulty adjust?',
      'How does Script lock a coin?',
    ]);
    expect(saved?.citations?.[0]?.sourceClass).toBe('satoshi-primary');
  });

  it('keeps a CoinGeek news citation on reload', () => {
    const store = parseStoredStore({
      version: 1,
      threads: [
        thread([
          message({
            citations: [
              {
                label: 'Teranode trial',
                title: 'Teranode trial',
                url: 'https://coingeek.com/teranode-trial',
                date: '2024-03-14T00:00:00.000Z',
                excerpt: 'CoinGeek reported a public trial.',
                sourceClass: 'news',
              },
            ],
          }),
        ]),
      ],
    });
    expect(store.threads[0]?.messages[0]?.citations?.[0]?.sourceClass).toBe('news');
  });

  it('drops a bad optional field and keeps the message', () => {
    const store = parseStoredStore({
      version: 1,
      theme: 'light',
      threads: [
        thread([
          message({ mode: 'MCP', followUps: ['Fine', 2], rating: 'sideways' }),
          { id: 'm2', role: 'nope', content: 'drop me', ts: 1 },
          { id: 'm3', role: 'user', content: 'A real question', ts: 2 },
        ]),
      ],
    });
    const messages = store.threads[0]?.messages ?? [];
    expect(messages.map((item) => item.id)).toEqual(['m1', 'm3']);
    expect(messages[0]?.content).toContain('proof-of-work');
    expect(messages[0]?.mode).toBeUndefined();
    expect(messages[0]?.followUps).toBeUndefined();
    expect(messages[0]?.rating).toBeUndefined();
    expect(store.theme).toBe('light');
  });

  it('rejects a broken top-level shape and a thread with no valid messages', () => {
    expect(parseStoredStore(null).threads).toEqual([]);
    expect(parseStoredStore({ version: 2, threads: [] }).threads).toEqual([]);
    expect(parseStoredStore({ version: 1, threads: {} }).threads).toEqual([]);
    const store = parseStoredStore({
      version: 1,
      theme: 'dark',
      activeThreadId: 'gone',
      threads: [thread([{ id: '', role: 'user', content: 'x', ts: 1 }]), 'nope', thread([message({ id: 'kept' })])],
    });
    expect(store.threads).toHaveLength(1);
    expect(store.threads[0]?.messages[0]?.id).toBe('kept');
    expect(store.activeThreadId).toBeNull();
    expect(store.theme).toBe('dark');
  });
});

describe('sanitizeFollowUps', () => {
  it('returns undefined unless every entry is a string', () => {
    expect(sanitizeFollowUps(undefined)).toBeUndefined();
    expect(sanitizeFollowUps(['', '   '])).toBeUndefined();
    expect(sanitizeFollowUps(['Ok', 1])).toBeUndefined();
    expect(sanitizeFollowUps(['  Kept  '])).toEqual(['Kept']);
  });
});

describe('parseDepth', () => {
  it('accepts the four depths and rejects anything else', () => {
    expect(parseDepth('historian')).toBe('historian');
    expect(parseDepth('default')).toBe('default');
    expect(parseDepth('Beginner')).toBe('default');
    expect(parseDepth(null)).toBe('default');
  });
});
