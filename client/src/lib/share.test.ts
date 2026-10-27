import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildTweetExcerpt,
  copyText,
  formatAnswerWithSources,
  formatReferenceList,
  formatUkDate,
  markdownToPlainText,
  timelineHref,
  truncateAtBoundary,
  xIntentUrl,
} from './share';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('markdownToPlainText', () => {
  it('keeps paragraphs and drops emphasis, links and citation markers', () => {
    const plain = markdownToPlainText(
      'Hello [1].\n\nSee **this** [white paper](https://bitcoin.org/bitcoin.pdf) [2].',
    );
    expect(plain).toBe('Hello.\n\nSee this white paper.');
  });

  it('keeps unordered and ordered lists', () => {
    const plain = markdownToPlainText('- First\n- Second\n\n1. Third\n2. Fourth');
    expect(plain).toBe('• First\n• Second\n\n1. Third\n2. Fourth');
  });

  it('keeps fenced code without the fence and leaves brackets inside code', () => {
    const plain = markdownToPlainText('Before\n\n```\nconst items = array[1];\n```\n\n`array[1]` is an index [3].');
    expect(plain).toBe('Before\n\nconst items = array[1];\n\narray[1] is an index.');
  });

  it('strips headings and blockquote markers', () => {
    expect(markdownToPlainText('## Title\n\n> A quoted line [4].')).toBe('Title\n\nA quoted line.');
  });

  it('drops grouped citation markers', () => {
    expect(markdownToPlainText('Noted [1, 2] here.')).toBe('Noted here.');
  });
});

describe('tweet excerpt', () => {
  it('includes the question when the question and the answer both fit', () => {
    expect(buildTweetExcerpt('What is Bitcoin?', 'A peer-to-peer electronic cash system.', 240)).toBe(
      'What is Bitcoin?\n\nA peer-to-peer electronic cash system.',
    );
  });

  it('omits a question that would leave no room for the answer', () => {
    const question = 'Q'.repeat(180);
    const answer = 'Answer starts here and continues with more words so it can be cut cleanly.';
    const result = buildTweetExcerpt(question, answer, 240);
    expect(result.startsWith('Answer starts')).toBe(true);
    expect(result.includes('QQQ')).toBe(false);
    expect(result.length).toBeLessThanOrEqual(240);
  });

  it('cuts a long answer at a sentence boundary and adds an ellipsis', () => {
    const answer =
      'One two three four five six seven. Eight nine ten eleven twelve thirteen fourteen.';
    const result = buildTweetExcerpt('', answer, 50);
    expect(result).toBe('One two three four five six seven\u2026');
    expect(result.length).toBeLessThanOrEqual(50);
  });

  it('cuts at a word boundary when there is no sentence in the latter half', () => {
    const text = 'alpha bravo charlie delta echo foxtrot golf hotel';
    const result = truncateAtBoundary(text, 24);
    expect(result.endsWith('\u2026')).toBe(true);
    expect(result.length).toBeLessThanOrEqual(24);
    const body = result.slice(0, -1);
    expect(text.startsWith(body)).toBe(true);
    expect(text.charAt(body.length)).toBe(' ');
  });

  it('leaves a short string unchanged', () => {
    expect(truncateAtBoundary('Already short.', 240)).toBe('Already short.');
  });

  it('collapses answer whitespace and stays within the limit', () => {
    const result = buildTweetExcerpt('What is Bitcoin?', 'Hello\n\nworld '.repeat(40), 80);
    expect(result.startsWith('What is Bitcoin?\n\n')).toBe(true);
    expect(result.endsWith('\u2026')).toBe(true);
    expect(result.length).toBeLessThanOrEqual(80);
    expect(result.includes('\n\nHello')).toBe(true);
  });

  it('never exceeds the requested limit', () => {
    const samples = [
      'Short.',
      'A'.repeat(500),
      'word '.repeat(80),
      'Hello there. '.repeat(30),
      'NoBreak'.repeat(40),
      'End with a question? Yes it does. And then more.',
    ];
    for (const sample of samples) {
      for (const limit of [1, 2, 10, 40, 80, 240]) {
        const result = buildTweetExcerpt('What is this question?', sample, limit);
        expect(result.length).toBeLessThanOrEqual(limit);
      }
    }
  });
});

describe('reference list', () => {
  it('formats title, url and UK date, then the site line', () => {
    expect(
      formatAnswerWithSources(
        'Hello [1].\n\nSee **this**.',
        [
          {
            label: 'Fallback',
            title: 'White paper',
            url: 'https://bitcoin.org/bitcoin.pdf',
            date: '2008-10-31',
          },
          { label: 'Forum post', date: '2009-01-03' },
        ],
        'https://ask.example',
      ),
    ).toBe(
      [
        'Hello.',
        '',
        'See this.',
        '',
        '1. White paper \u2014 https://bitcoin.org/bitcoin.pdf (31 October 2008)',
        '2. Forum post (3 January 2009)',
        '',
        'Via Ask Satoshi',
        'https://ask.example',
      ].join('\n'),
    );
  });

  it('omits a missing url and an unparseable date', () => {
    expect(formatReferenceList([{ label: 'Notes', date: 'not-a-date' }])).toBe('1. Notes');
  });

  it('formats a bare calendar day in UK English', () => {
    expect(formatUkDate('2008-10-31')).toBe('31 October 2008');
    expect(formatUkDate('2008-02-31')).toBeNull();
  });
});

describe('timeline and X urls', () => {
  it('links a real citation day and falls back to the page otherwise', () => {
    expect(timelineHref('2008-10-31')).toBe('/satoshi-activity?date=2008-10-31');
    expect(timelineHref('2008-10-31T00:00:00.000Z')).toBe('/satoshi-activity?date=2008-10-31');
    expect(timelineHref('not a date')).toBe('/satoshi-activity');
    expect(timelineHref()).toBe('/satoshi-activity');
    expect(timelineHref('2008-02-31')).toBe('/satoshi-activity');
  });

  it('encodes tweet text and the page url', () => {
    const url = xIntentUrl('Hello & goodbye\nNext', 'https://ask.example/a?b=1&c=2');
    expect(url).toBe(
      `https://twitter.com/intent/tweet?text=${encodeURIComponent('Hello & goodbye\nNext')}&url=${encodeURIComponent('https://ask.example/a?b=1&c=2')}`,
    );
    expect(url).not.toContain('Hello & goodbye');
  });
});

describe('copyText', () => {
  it('uses navigator.clipboard.writeText when it resolves', async () => {
    const writes: string[] = [];
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: async (value: string) => {
          writes.push(value);
        },
      },
    });
    await expect(copyText('hello')).resolves.toBe(true);
    expect(writes).toEqual(['hello']);
  });

  it('falls back to execCommand when writeText rejects', async () => {
    const area = {
      value: '',
      style: {},
      tabIndex: 0,
      setAttribute() {},
      focus() {},
      select() {},
      setSelectionRange() {},
      remove() {},
    };
    const exec = vi.fn(() => true);
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: async () => {
          throw new Error('denied');
        },
      },
    });
    vi.stubGlobal('document', {
      execCommand: exec,
      createElement: () => area,
      body: { appendChild() {} },
      getSelection: () => null,
    });
    await expect(copyText('plain')).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
    expect(area.value).toBe('plain');
  });

  it('returns false and does not throw when nothing can copy', async () => {
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: async () => {
          throw new Error('denied');
        },
      },
    });
    vi.stubGlobal('document', undefined);
    await expect(copyText('plain')).resolves.toBe(false);
  });
});
