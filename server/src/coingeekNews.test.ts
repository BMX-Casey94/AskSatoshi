import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  canonicalUrl,
  clipExcerpt,
  htmlToPlainText,
  mergeNewsItems,
  termNames,
  metaDescription,
  parseRobots,
  parseRssItems,
  pathAllowed,
  robotsAllows,
  rssEntryToItem,
  type FetchNewsItem,
} from '../scripts/fetch-coingeek.mjs';
import {
  ageMonths,
  CoinGeekNews,
  freshnessFor,
  loadCoinGeekNews,
  looksLikeNewsQuestion,
  NEWS_CITATION_CAP,
  NEWS_PROVENANCE_NOTE,
  NEWS_SOURCE_CLASS,
  newsCitations,
  newsDateline,
  newsFetchedAt,
  rankNewsHits,
  recencyWeight,
  renderNewsEvidence,
  sameNewsTopic,
  type NewsHit,
  type NewsItem,
} from './coingeekNews.js';

const NOW = new Date('2025-10-14T00:00:00.000Z');
const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'coingeek-news-'));
  dirs.push(dir);
  return dir;
}

function item(partial: Partial<NewsItem> & Pick<NewsItem, 'id' | 'title' | 'date'>): NewsItem {
  return {
    url: `https://coingeek.com/${partial.id}`,
    excerpt: partial.excerpt ?? `${partial.title}. Reported by CoinGeek.`,
    ...partial,
  };
}

function hit(partial: Partial<NewsHit> & Pick<NewsHit, 'date' | 'ageMonths' | 'freshness'>): NewsHit {
  return {
    id: 'coingeek-1',
    url: 'https://coingeek.com/story',
    title: 'Story',
    excerpt: 'Excerpt.',
    ...partial,
  };
}

describe('staleness', () => {
  it('buckets current, ageing and dated from an injected clock', () => {
    expect(ageMonths('2025-10-14T00:00:00.000Z', NOW)).toBe(0);
    expect(ageMonths('2025-09-14T00:00:00.000Z', NOW)).toBe(1);
    expect(ageMonths('2025-08-14T00:00:00.000Z', NOW)).toBe(2);
    expect(ageMonths('2025-04-14T00:00:00.000Z', NOW)).toBe(6);
    expect(ageMonths('2025-01-14T00:00:00.000Z', NOW)).toBe(9);
    expect(ageMonths('2024-04-14T00:00:00.000Z', NOW)).toBe(18);
    expect(ageMonths('2024-03-14T00:00:00.000Z', NOW)).toBe(19);
    expect(freshnessFor(0)).toBe('current');
    expect(freshnessFor(6)).toBe('current');
    expect(freshnessFor(7)).toBe('ageing');
    expect(freshnessFor(18)).toBe('ageing');
    expect(freshnessFor(19)).toBe('dated');
  });

  it('decays with a 12-month half-life so equal relevance prefers the newer article', () => {
    expect(recencyWeight(0)).toBe(1);
    expect(recencyWeight(12)).toBeCloseTo(0.5, 5);
    expect(recencyWeight(24)).toBeCloseTo(0.25, 5);
    const ranked = rankNewsHits(
      [
        { item: item({ id: 'old', title: 'Teranode laboratory trial', date: '2024-10-14T00:00:00.000Z' }), relevance: 10 },
        { item: item({ id: 'new', title: 'Centbee retail expansion', date: '2025-10-14T00:00:00.000Z' }), relevance: 10 },
      ],
      NOW,
      4,
    );
    expect(ranked.map((row) => row.id)).toEqual(['new', 'old']);
    expect(ranked[0]?.freshness).toBe('current');
    expect(ranked[1]?.ageMonths).toBe(12);
    expect(ranked[1]?.freshness).toBe('ageing');
  });

  it('keeps a strongly relevant old article above a weak new one', () => {
    const ranked = rankNewsHits(
      [
        { item: item({ id: 'old', title: 'Teranode laboratory trial', date: '2023-10-14T00:00:00.000Z' }), relevance: 40 },
        { item: item({ id: 'new', title: 'Centbee retail expansion', date: '2025-10-14T00:00:00.000Z' }), relevance: 4 },
      ],
      NOW,
      4,
    );
    expect(ranked[0]?.id).toBe('old');
    expect(ranked.map((row) => row.id)).toContain('new');
  });

  it('prefers the newer article when two hits are the same story', () => {
    expect(
      sameNewsTopic(
        'HandCash launches a retail pilot in Manila',
        'HandCash launches a retail pilot in Cebu',
      ),
    ).toBe(true);
    expect(sameNewsTopic('Teranode testnet opens', 'Centbee retail wallet expands')).toBe(false);
    const ranked = rankNewsHits(
      [
        {
          item: item({
            id: 'old',
            title: 'HandCash launches a retail pilot in Manila',
            date: '2023-10-14T00:00:00.000Z',
          }),
          relevance: 40,
        },
        {
          item: item({
            id: 'new',
            title: 'HandCash launches a retail pilot in Cebu',
            date: '2025-09-14T00:00:00.000Z',
          }),
          relevance: 10,
        },
        {
          item: item({ id: 'other', title: 'Court ruling on a mining patent', date: '2025-08-01T00:00:00.000Z' }),
          relevance: 12,
        },
      ],
      NOW,
      4,
    );
    const ids = ranked.map((row) => row.id);
    expect(ids).toContain('new');
    expect(ids).not.toContain('old');
    expect(ids).toContain('other');
  });
});

describe('news datelines', () => {
  it('labels every item, and adds the staleness clause only once an article is ageing or dated', () => {
    const dated = hit({
      date: '2024-03-14T00:00:00.000Z',
      ageMonths: ageMonths('2024-03-14T00:00:00.000Z', NOW),
      freshness: 'dated',
    });
    expect(newsDateline(dated)).toBe(
      '[News — CoinGeek, 14 March 2024, reported 19 months ago — may be out of date]',
    );
    expect(
      newsDateline(
        hit({
          date: '2025-01-14T00:00:00.000Z',
          ageMonths: 9,
          freshness: 'ageing',
        }),
      ),
    ).toBe('[News — CoinGeek, 14 January 2025, reported 9 months ago — may be out of date]');
    const current = newsDateline(
      hit({ date: '2025-08-14T00:00:00.000Z', ageMonths: 2, freshness: 'current' }),
    );
    expect(current).toBe('[News — CoinGeek, 14 August 2025, reported 2 months ago]');
    expect(current).not.toContain('may be out of date');
    expect(newsDateline(hit({ date: '2025-09-14T00:00:00.000Z', ageMonths: 1, freshness: 'current' }))).toContain(
      'reported 1 month ago',
    );
    expect(newsDateline(hit({ date: '2025-10-14T00:00:00.000Z', ageMonths: 0, freshness: 'current' }))).toContain(
      'reported this month',
    );
    expect(renderNewsEvidence([dated])).toMatch(/^\[News — CoinGeek, 14 March 2024/);
    expect(renderNewsEvidence([])).toBe('');
  });

  it('caps citations at four and marks them as news', () => {
    const hits = Array.from({ length: 6 }, (_unused, index) =>
      hit({
        id: `coingeek-${index}`,
        title: `Story ${index}`,
        date: '2025-08-14T00:00:00.000Z',
        ageMonths: 2,
        freshness: 'current',
      }),
    );
    const citations = newsCitations(hits);
    expect(citations).toHaveLength(NEWS_CITATION_CAP);
    expect(citations[0]).toMatchObject({
      label: 'Story 0',
      title: 'Story 0',
      sourceClass: NEWS_SOURCE_CLASS,
      url: 'https://coingeek.com/story',
    });
    expect(NEWS_SOURCE_CLASS).toBe('news');
  });
});

describe('looksLikeNewsQuestion', () => {
  it('accepts events, announcements, adoption and named activity', () => {
    const yes = [
      "What's the latest news on Teranode?",
      'Who is using HandCash for payments?',
      'Did TAAL announce a partnership this year?',
      'What happened with the COPA lawsuit in 2024?',
      'Any recent adoption of Bitcoin SV by a retailer?',
      'What is HandCash launching?',
    ];
    for (const question of yes) expect(looksLikeNewsQuestion(question), question).toBe(true);
  });

  it('rejects protocol mechanics and identity, including the two specified questions', () => {
    const no = [
      'How does a Merkle branch show that a payment is included?',
      'How does a Merkle branch show…',
      'Who is Satoshi',
      'Who is Satoshi Nakamoto?',
      'What is an opcode?',
      'How does SPV verification work?',
      'Explain BRC-62',
      'What does the script do with OP_CHECKSIG?',
      'Was the block size always meant to be small?',
      'What did Satoshi say about transaction fees?',
      "What's the latest block size?",
    ];
    for (const question of no) expect(looksLikeNewsQuestion(question), question).toBe(false);
  });
});

describe('NEWS_PROVENANCE_NOTE', () => {
  it('tells the model how to attribute time-sensitive reporting', () => {
    expect(NEWS_PROVENANCE_NOTE).toContain('BSV-aligned editorial stance');
    expect(NEWS_PROVENANCE_NOTE).toContain('CoinGeek reported in March 2024 that…');
    expect(NEWS_PROVENANCE_NOTE).toContain('circumstances may have changed');
    expect(NEWS_PROVENANCE_NOTE).toContain('present tense');
    expect(NEWS_PROVENANCE_NOTE).toContain('protocol mechanics');
    expect(NEWS_PROVENANCE_NOTE).toContain('specification or the primary record');
  });
});

describe('CoinGeekNews search', () => {
  const clock = () => NOW;
  const news = new CoinGeekNews(
    [
      item({
        id: 'old',
        title: '<p>Teranode public trial in Geneva</p>',
        date: '2024-03-14T00:00:00.000Z',
        excerpt: '<p>Teranode public trial opens in Geneva. <strong>Measured</strong> throughput.</p>',
      }),
      item({
        id: 'new',
        title: 'Teranode public trial in Geneva',
        date: '2025-08-14T00:00:00.000Z',
        excerpt: 'Teranode public trial opens in Geneva with a later measurement.',
      }),
      item({
        id: 'wallet',
        title: 'Centbee retail wallet expands in South Africa',
        date: '2025-09-01T00:00:00.000Z',
        excerpt: 'Centbee retail wallet expands merchant payments in South Africa.',
        tags: ['Centbee'],
      }),
    ],
    clock,
  );

  it('strips HTML at ingest and prefers the newer article on the same story', () => {
    const hits = news.search('Teranode public trial Geneva');
    expect(hits.map((row) => row.id)).toContain('new');
    expect(hits.map((row) => row.id)).not.toContain('old');
    expect(hits[0]?.title).not.toMatch(/<[^>]+>/);
    expect(hits[0]?.excerpt.length).toBeLessThanOrEqual(400);
    expect(hits[0]?.freshness).toBe('current');
  });

  it('fails closed on unrelated gibberish', () => {
    expect(news.search('zxqwv plugh asdfgh')).toEqual([]);
  });
});

describe('loadCoinGeekNews', () => {
  it('fails open on a missing, corrupt or empty file', () => {
    const dir = tempDir();
    expect(loadCoinGeekNews(join(dir, 'missing.json'))).toBeNull();
    const corrupt = join(dir, 'corrupt.json');
    writeFileSync(corrupt, '{');
    expect(loadCoinGeekNews(corrupt)).toBeNull();
    const empty = join(dir, 'empty.json');
    writeFileSync(empty, JSON.stringify({ pin: { fetchedAt: '2026-01-01T00:00:00.000Z' }, items: [] }));
    expect(loadCoinGeekNews(empty)).toBeNull();
    const useless = join(dir, 'useless.json');
    writeFileSync(useless, JSON.stringify({ items: [{ title: 'no id' }] }));
    expect(loadCoinGeekNews(useless)).toBeNull();
  });

  it('reads pin.fetchedAt from the head of a snapshot', () => {
    const dir = tempDir();
    const path = join(dir, 'news.json');
    writeFileSync(
      path,
      JSON.stringify({
        pin: {
          source: 'https://coingeek.com/',
          fetchedAt: '2026-10-27T12:00:00.000Z',
          counts: { items: 1 },
        },
        items: [item({ id: 'coingeek-1', title: 'Teranode ships a test', date: '2026-10-01T00:00:00.000Z' })],
      }),
    );
    expect(newsFetchedAt(path)).toBe('2026-10-27T12:00:00.000Z');
    expect(newsFetchedAt(join(dir, 'missing.json'))).toBeUndefined();
    const loaded = loadCoinGeekNews(path, () => NOW);
    expect(loaded?.search('Teranode test').length).toBeGreaterThan(0);
  });
});

describe('fetch script merge and HTML', () => {
  const coverage = { from: '2023-10-27T00:00:00.000Z', to: '2026-10-27T00:00:00.000Z', complete: true };

  function row(partial: Partial<FetchNewsItem> & Pick<FetchNewsItem, 'id' | 'title' | 'date' | 'excerpt'>): FetchNewsItem {
    return { url: `https://coingeek.com/${partial.id}`, ...partial };
  }

  it('strips tags, decodes entities, and clips on a sentence boundary', () => {
    expect(htmlToPlainText('<p>Hello &amp; &#8217;world&#x201D;</p>')).toBe('Hello & ’world”');
    expect(htmlToPlainText('<p>Keep <strong>this</strong>.</p><script>alert(1)</script>')).toBe('Keep this.');
    expect(htmlToPlainText('&lt;stdio.h&gt;')).toBe('<stdio.h>');
    expect(htmlToPlainText(htmlToPlainText('&lt;stdio.h&gt;'))).toBe('<stdio.h>');
    const clipped = clipExcerpt(`${'A'.repeat(100)}. ${'B'.repeat(500)}`);
    expect(clipped.length).toBeLessThanOrEqual(400);
    expect(clipped.endsWith('.')).toBe(true);
    expect(clipped.startsWith('AAA')).toBe(true);
    const wordy = clipExcerpt(Array.from({ length: 120 }, () => 'word').join(' '));
    expect(wordy.length).toBeLessThanOrEqual(400);
    expect(wordy.length).toBeGreaterThan(40);
    expect(wordy.endsWith('word')).toBe(true);
  });

  it('reads a meta description from the head and ignores the body', () => {
    const html =
      '<html><head><meta content="Alpha &amp; beta." name="description"><meta property="og:description" content="Gamma"></head><body><p>FULL BODY SHOULD NOT BE STORED</p></body></html>';
    expect(metaDescription(html)).toBe('Alpha & beta.');
    expect(metaDescription(html)).not.toContain('FULL BODY');
    expect(metaDescription('<head><meta property="og:description" content="Only og."></head>')).toBe('Only og.');
  });

  it('turns an RSS item into a plain-text excerpt', () => {
    const xml = `<?xml version="1.0"?><rss><channel><item>
      <title>HandCash &amp; launch</title>
      <link>https://coingeek.com/handcash-launch/</link>
      <pubDate>Tue, 14 Mar 2024 12:00:00 +0000</pubDate>
      <category>Business</category>
      <category domain="post_tag"><![CDATA[HandCash]]></category>
      <description><![CDATA[<p>HandCash announced a pilot.</p><script>alert(1)</script>]]></description>
    </item></channel></rss>`;
    const [entry] = parseRssItems(xml);
    expect(entry?.categories).toEqual(['Business']);
    expect(entry?.tags).toEqual(['HandCash']);
    const article = rssEntryToItem(entry ?? {}, Date.parse('2020-01-01T00:00:00.000Z'));
    expect(article?.title).toBe('HandCash & launch');
    expect(article?.excerpt).toBe('HandCash announced a pilot.');
    expect(article?.excerpt).not.toMatch(/<[^>]+>/);
    expect(article?.url).toBe('https://coingeek.com/handcash-launch');
  });

  it('maps category ids to names and drops Uncategorized duplicates', () => {
    const lookup = new Map([
      [1, 'Business'],
      [2, 'Finance'],
      [9, 'Uncategorized'],
    ]);
    expect(termNames([2, 1, 2, 9, 4], lookup, 12)).toEqual(['Finance', 'Business']);
  });

  it('honours robots.txt and still blocks /wp-admin/', () => {
    const robots = parseRobots('User-agent: *\nDisallow: /wp-admin/\nAllow: /wp-admin/admin-ajax.php\n');
    expect(robotsAllows(robots, 'AskSatoshi-NewsIndexer', '/wp-json/wp/v2/posts')).toBe(true);
    expect(robotsAllows(robots, 'AskSatoshi-NewsIndexer', '/feed/')).toBe(true);
    expect(robotsAllows(robots, 'AskSatoshi-NewsIndexer', '/wp-admin/install.php')).toBe(false);
    expect(robotsAllows(robots, 'AskSatoshi-NewsIndexer', '/wp-admin/admin-ajax.php')).toBe(true);
    expect(pathAllowed(robots, 'AskSatoshi-NewsIndexer', '/wp-admin/admin-ajax.php')).toBe(false);
    expect(pathAllowed(parseRobots('User-agent: *\nDisallow:\n'), 'anyone', '/wp-admin/')).toBe(false);
    expect(pathAllowed(robots, 'anyone', '/sitemap_index.xml')).toBe(true);
  });

  it('merges idempotently by id and url, keeps the latest modified, and drops only a covered gap', () => {
    const existing = [
      row({
        id: 'coingeek-1',
        url: 'https://coingeek.com/a/',
        title: 'Old',
        date: '2024-01-01T00:00:00.000Z',
        modified: '2024-01-02T00:00:00.000Z',
        excerpt: 'old text',
      }),
      row({
        id: 'coingeek-slug',
        url: 'https://www.coingeek.com/moved/?utm_source=x',
        title: 'Moved old',
        date: '2024-06-01T00:00:00.000Z',
        modified: '2024-06-01T00:00:00.000Z',
        excerpt: 'moved old',
      }),
      row({
        id: 'coingeek-gone',
        title: 'Removed',
        date: '2025-01-01T00:00:00.000Z',
        excerpt: 'no longer on the site',
      }),
      row({
        id: 'coingeek-archive',
        title: 'Outside the window',
        date: '2020-01-01T00:00:00.000Z',
        excerpt: 'kept because the fetch did not cover 2020',
      }),
    ];
    const incoming = [
      row({
        id: 'coingeek-1',
        url: 'https://coingeek.com/a',
        title: 'New',
        date: '2024-01-01T00:00:00.000Z',
        modified: '2024-06-01T00:00:00.000Z',
        excerpt: 'new text',
      }),
      row({
        id: 'coingeek-9',
        url: 'https://coingeek.com/moved',
        title: 'Moved new',
        date: '2024-06-01T00:00:00.000Z',
        modified: '2025-01-01T00:00:00.000Z',
        excerpt: 'moved new',
      }),
      row({
        id: 'coingeek-1',
        url: 'https://coingeek.com/a',
        title: 'Stale incoming',
        date: '2024-01-01T00:00:00.000Z',
        modified: '2023-01-01T00:00:00.000Z',
        excerpt: 'must not win',
      }),
    ];
    const before = structuredClone(existing);
    const once = mergeNewsItems(existing, incoming, coverage);
    expect(existing).toEqual(before);
    expect(once.find((row) => row.id === 'coingeek-1')).toMatchObject({ title: 'New', excerpt: 'new text' });
    expect(once.find((row) => row.url === 'https://coingeek.com/moved')).toMatchObject({
      id: 'coingeek-9',
      title: 'Moved new',
    });
    expect(once.map((row) => row.id)).not.toContain('coingeek-slug');
    expect(once.map((row) => row.id)).not.toContain('coingeek-gone');
    expect(once.map((row) => row.id)).toContain('coingeek-archive');
    const twice = mergeNewsItems(once, incoming, coverage);
    expect(twice).toEqual(once);

    const tagged = mergeNewsItems(
      [row({ id: 'coingeek-1', url: 'https://coingeek.com/a', title: 'Old', date: '2024-01-01T00:00:00.000Z', modified: '2024-06-01T00:00:00.000Z', excerpt: 'old', categories: ['Business'], tags: ['Teranode'] })],
      [row({ id: 'coingeek-1', url: 'https://coingeek.com/a', title: 'Retitled', date: '2024-01-01T00:00:00.000Z', modified: '2024-07-01T00:00:00.000Z', excerpt: 'newer' })],
      coverage,
    );
    expect(tagged[0]).toMatchObject({ title: 'Retitled', excerpt: 'newer', categories: ['Business'], tags: ['Teranode'] });

    const partial = mergeNewsItems(existing, incoming, { ...coverage, complete: false });
    expect(partial.map((row) => row.id)).toContain('coingeek-gone');
    expect(canonicalUrl('https://www.coingeek.com/moved/?utm_source=x')).toBe('https://coingeek.com/moved');
  });
});
