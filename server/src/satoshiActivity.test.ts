import { describe, expect, it } from 'vitest';
import type { CorpusDoc } from './satoshiCorpus.js';
import { buildSatoshiActivity, getSatoshiActivity } from './satoshiActivity.js';

const DOCS: CorpusDoc[] = [
  {
    id: 'post-later',
    kind: 'post',
    title: 'Later forum post',
    date: '2010-12-12T10:00:00Z',
    url: 'https://satoshi.nakamotoinstitute.org/posts/bitcointalk/2/',
    text: 'later',
  },
  {
    id: 'email-first',
    kind: 'email',
    title: 'First email',
    date: '2008-10-31T18:10:00Z',
    url: 'https://satoshi.nakamotoinstitute.org/emails/cryptography/1/',
    text: 'first',
  },
  {
    id: 'quote-mid',
    kind: 'quote',
    title: 'A collected quote',
    date: '2009-01-01',
    url: 'https://satoshi.nakamotoinstitute.org/quotes/1/',
    text: 'must not appear',
  },
  {
    id: 'post-mid',
    kind: 'post',
    title: 'Middle forum post',
    date: '2009-02-11T22:00:00Z',
    url: 'https://satoshi.nakamotoinstitute.org/posts/p2pfoundation/1/',
    text: 'middle',
  },
];

describe('buildSatoshiActivity', () => {
  it('excludes quotes and returns emails and posts sorted by date ascending', () => {
    const activity = buildSatoshiActivity(DOCS, '2026-08-31T20:00:00.000Z');

    expect(activity.generatedAt).toBe('2026-08-31T20:00:00.000Z');
    expect(activity.total).toBe(3);
    expect(activity.byKind).toEqual({ emails: 1, posts: 2 });
    expect(activity.points).toEqual([
      {
        date: '2008-10-31T18:10:00Z',
        kind: 'email',
        title: 'First email',
        url: 'https://satoshi.nakamotoinstitute.org/emails/cryptography/1/',
      },
      {
        date: '2009-02-11T22:00:00Z',
        kind: 'post',
        title: 'Middle forum post',
        url: 'https://satoshi.nakamotoinstitute.org/posts/p2pfoundation/1/',
      },
      {
        date: '2010-12-12T10:00:00Z',
        kind: 'post',
        title: 'Later forum post',
        url: 'https://satoshi.nakamotoinstitute.org/posts/bitcointalk/2/',
      },
    ]);
    expect(activity.points.some((p) => p.title === 'A collected quote')).toBe(false);
    expect(activity.points.every((p) => p.kind === 'email' || p.kind === 'post')).toBe(true);
  });
});

describe('getSatoshiActivity', () => {
  it('loads the pinned corpus, excludes quotes, and is sorted by date', () => {
    const activity = getSatoshiActivity();
    const again = getSatoshiActivity();

    expect(again).toBe(activity);
    expect(activity.total).toBe(activity.byKind.emails + activity.byKind.posts);
    expect(activity.byKind.emails).toBe(38);
    expect(activity.byKind.posts).toBe(543);
    expect(activity.points).toHaveLength(581);
    expect(activity.points.every((p) => p.kind === 'email' || p.kind === 'post')).toBe(true);
    expect(activity.points.some((p) => (p as { kind: string }).kind === 'quote')).toBe(false);

    for (let i = 1; i < activity.points.length; i++) {
      expect(activity.points[i]!.date >= activity.points[i - 1]!.date).toBe(true);
    }
  });
});
