import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearLocatorCache,
  createLocatorCache,
  dedupeEvidenceHits,
  diversifyEvidenceHits,
  loadRicherBody,
  packBroadEvidence,
  parseLeadingMatter,
  pickAngleSeed,
  seriesKey,
  type EvidenceRecord,
  type RicherSource,
} from './evidencePack.js';

beforeEach(() => {
  clearLocatorCache();
});

const COLLAPSED =
  '--- title: What is Bitcoin era: medium slug: what-is-bitcoin-8ee9d3e86674 themes: [money, design] source: summaries-medium/what-is-bitcoin-8ee9d3e86674.md --- # What is Bitcoin — core principles Bitcoin is peer-to-peer electronic cash. The supply is fixed.';

const MULTILINE = `---
title: "What is Bitcoin"
date: 2018-06-01
era: medium
slug: what-is-bitcoin-8ee9d3e86674
themes:
  - money
  - design
source: summaries-medium/what-is-bitcoin-8ee9d3e86674.md
---

# What is Bitcoin — core principles

Bitcoin is peer-to-peer electronic cash.
The core principles of the system are fixed rules.
`;

describe('parseLeadingMatter', () => {
  it('parses a collapsed investigate excerpt and strips the boilerplate', () => {
    const parsed = parseLeadingMatter(COLLAPSED);
    expect(parsed.title).toBe('What is Bitcoin');
    expect(parsed.era).toBe('medium');
    expect(parsed.slug).toBe('what-is-bitcoin-8ee9d3e86674');
    expect(parsed.themes).toEqual(['money', 'design']);
    expect(parsed.source).toBe('summaries-medium/what-is-bitcoin-8ee9d3e86674.md');
    expect(parsed.prose).toBe('Bitcoin is peer-to-peer electronic cash. The supply is fixed.');
    expect(parsed.prose).not.toContain('---');
    expect(parsed.prose).not.toContain('core principles');
  });

  it('parses a multiline education body, including a YAML theme list and an ISO date', () => {
    const parsed = parseLeadingMatter(MULTILINE);
    expect(parsed.title).toBe('What is Bitcoin');
    expect(parsed.date).toBe('2018-06-01');
    expect(parsed.era).toBe('medium');
    expect(parsed.themes).toEqual(['money', 'design']);
    expect(parsed.prose).toContain('Bitcoin is peer-to-peer electronic cash.');
    expect(parsed.prose).toContain('The core principles of the system are fixed rules.');
    expect(parsed.prose.startsWith('Bitcoin')).toBe(true);
  });

  it('keeps a **Date:** line as a citation date and drops it from the prose', () => {
    const parsed = parseLeadingMatter('# A forum post\n\n**Date:** 2009-01-03\n**URL:** https://example.com/post\n\nHello from the list.\n');
    expect(parsed.date).toBe('2009-01-03');
    expect(parsed.prose).toBe('Hello from the list.');
    expect(parsed.prose).not.toContain('2009-01-03');
  });

  it('leaves ordinary prose unchanged', () => {
    expect(parseLeadingMatter('Bitcoin is electronic cash.').prose).toBe('Bitcoin is electronic cash.');
  });
});

describe('dedupeEvidenceHits', () => {
  it('collapses a principle/essay pair and keeps the distinct sentences', () => {
    const { hits } = dedupeEvidenceHits([
      {
        id: 'principle:medium:what-is-bitcoin-aaa',
        kind: 'principle',
        locator: 'education/medium--what-is-bitcoin-aaa.md',
        title: 'What is Bitcoin',
        excerpt: 'Bitcoin is electronic cash.',
      },
      {
        id: 'essay:medium:what-is-bitcoin-aaa',
        kind: 'essay',
        locator: 'csw://essay/medium/what-is-bitcoin-aaa',
        title: 'What is Bitcoin',
        excerpt: 'Bitcoin is electronic cash. Settlement is final.',
      },
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.excerpt).toContain('Bitcoin is electronic cash.');
    expect(hits[0]?.excerpt).toContain('Settlement is final.');
    expect(hits[0]?.locator).toBe('csw://essay/medium/what-is-bitcoin-aaa');
  });

  it('drops a near-identical title and keeps both when the dates differ', () => {
    const same = 'Bitcoin is peer-to-peer electronic cash with no trusted issuer.';
    const { hits } = dedupeEvidenceHits([
      {
        id: 'essay:medium:aaa',
        kind: 'essay',
        title: 'What is Bitcoin',
        date: '2018-06-01',
        excerpt: same,
      },
      {
        id: 'essay:medium:aaa-copy',
        kind: 'essay',
        title: 'What Is Bitcoin',
        date: '2018-06-01',
        excerpt: same,
      },
      {
        id: 'essay:medium:bbb',
        kind: 'essay',
        title: 'What is Bitcoin',
        date: '2024-02-02',
        excerpt: same,
      },
    ]);
    expect(hits.map((hit) => hit.id)).toEqual(['essay:medium:aaa', 'essay:medium:bbb']);
  });

  it('keeps same-title posts whose wording differs', () => {
    const { hits } = dedupeEvidenceHits([
      {
        id: 'essay:medium:cash',
        kind: 'essay',
        title: 'What is Bitcoin',
        date: '2018-06-01',
        excerpt: 'Bitcoin is peer-to-peer electronic cash with no trusted issuer and a fixed supply.',
      },
      {
        id: 'essay:medium:tax',
        kind: 'essay',
        title: 'What is Bitcoin',
        date: '2018-06-01',
        excerpt: 'Capital gains arise when bitcoin is sold and must be reported to the revenue authority.',
      },
    ]);
    expect(hits).toHaveLength(2);
  });
});

function row(partial: Partial<EvidenceRecord> & Pick<EvidenceRecord, 'id' | 'title'>): EvidenceRecord {
  return {
    kind: 'essay',
    excerpt: partial.excerpt ?? partial.title,
    themes: partial.themes,
    ...partial,
  };
}

describe('diversifyEvidenceHits', () => {
  const question = 'What is Bitcoin?';
  const hits: EvidenceRecord[] = [
    row({ id: 'tax-1', title: 'Tax and Bitcoin — income', themes: ['tax'], excerpt: 'Income tax.' }),
    row({ id: 'tax-2', title: 'Tax and Bitcoin — capital', themes: ['tax'], excerpt: 'Capital gains.' }),
    row({ id: 'tax-3', title: 'Taxing Bitcoin — VAT', themes: ['tax'], excerpt: 'VAT treatment.' }),
    row({ id: 'money', title: 'What is Bitcoin', themes: ['money'], excerpt: 'Electronic cash.' }),
    row({ id: 'supply', title: 'The 21 million', themes: ['supply'], excerpt: 'Fixed supply.' }),
    row({ id: 'script', title: 'Script and Bitcoin transactions', themes: ['script'], excerpt: 'Predicate language.' }),
  ];

  it('caps a theme and a title series at two and keeps the highest ranked', () => {
    expect(seriesKey('Tax and Bitcoin — income')).toBe(seriesKey('Taxing Bitcoin — VAT'));
    const kept = diversifyEvidenceHits(hits, question);
    expect(kept.map((hit) => hit.id)).toEqual(['tax-1', 'tax-2', 'money', 'supply', 'script']);
  });

  it('does not cap the series when the question is about it', () => {
    const kept = diversifyEvidenceHits(hits, 'How is Bitcoin taxed?');
    expect(kept.map((hit) => hit.id)).toEqual(['tax-1', 'tax-2', 'tax-3', 'money', 'supply', 'script']);
  });

  it('keeps a lower-ranked hit that engages a specific question term', () => {
    const governance: EvidenceRecord[] = [
      row({ id: 'g1', title: 'Governance notes one', themes: ['governance'], excerpt: 'Committees and process.' }),
      row({ id: 'g2', title: 'Governance notes two', themes: ['governance'], excerpt: 'More committees.' }),
      row({ id: 'g3', title: 'Governance notes three', themes: ['governance'], excerpt: 'Still committees.' }),
      row({
        id: 'g4',
        title: 'How Bitcoin was hijacked',
        themes: ['governance'],
        excerpt: 'The protocol was hijacked by a block-size ceiling.',
      }),
    ];
    const kept = diversifyEvidenceHits(governance, 'Why was Bitcoin hijacked?');
    expect(kept.map((hit) => hit.id)).toEqual(['g1', 'g2', 'g4']);
  });

  it('is a no-op for a handful of candidates', () => {
    const few = hits.slice(0, 3);
    const packed = packBroadEvidence(few, question, () => 0.99);
    expect(packed.hits).toBe(few);
    expect(packed.leadAngle).toBeUndefined();
  });

  it('keeps a primary-record cluster that theme and series caps would drop', () => {
    const primaries: EvidenceRecord[] = [
      row({
        id: 'p1',
        title: 'Alpha note — one',
        kind: 'satoshi-primary',
        themes: ['primary record'],
        date: '2008-10-31',
        excerpt: 'Root in the header.',
      }),
      row({
        id: 'p2',
        title: 'Alpha note — two',
        kind: 'satoshi-primary',
        themes: ['primary record'],
        date: '2009-01-09',
        excerpt: 'Branch links the transaction.',
      }),
      row({
        id: 'p3',
        title: 'Alpha note — three',
        themes: ['primary record'],
        date: '2010-07-14',
        excerpt: 'Header commits to the root.',
      }),
    ];
    const mixed = [...primaries, ...hits.slice(0, 3)];
    const kept = diversifyEvidenceHits(mixed, question);
    expect(kept.map((hit) => hit.id)).toEqual(['p1', 'p2', 'p3', 'tax-1', 'tax-2']);
  });

  it('does not drop primary-record hits when the final limit would otherwise exclude them', () => {
    const packed = packBroadEvidence(
      [
        ...hits,
        row({
          id: 'p1',
          title: 'Alpha note — one',
          kind: 'satoshi-primary',
          themes: ['primary record'],
          date: '2008-10-31',
          excerpt: 'Root in the header.',
        }),
        row({
          id: 'p2',
          title: 'Alpha note — two',
          kind: 'satoshi-primary',
          themes: ['primary record'],
          date: '2009-01-09',
          excerpt: 'Branch links the transaction.',
        }),
        row({
          id: 'p3',
          title: 'Alpha note — three',
          kind: 'satoshi-primary',
          themes: ['primary record'],
          date: '2010-07-14',
          excerpt: 'Header commits to the root.',
        }),
      ],
      question,
      () => 0.99,
      { limit: 4 },
    );
    expect(
      packed.hits
        .filter((hit) => hit.kind === 'satoshi-primary' || hit.themes?.[0] === 'primary record')
        .map((hit) => hit.id)
        .sort(),
    ).toEqual(['p1', 'p2', 'p3']);
  });
});

describe('pickAngleSeed', () => {
  const angles = [
    { id: 'tax', label: 'tax — Tax and Bitcoin — income' },
    { id: 'money', label: 'money — What is Bitcoin' },
    { id: 'design', label: 'design — What is Bitcoin' },
    { id: 'supply', label: 'supply — The 21 million' },
  ];

  it('is deterministic for an injected rng', () => {
    expect(pickAngleSeed(angles, () => 0)?.id).toBe('tax');
    expect(pickAngleSeed(angles, () => 0.5)?.id).toBe('design');
    expect(pickAngleSeed(angles, () => 0.99)?.id).toBe('supply');
  });

  it('moves the chosen angle to the front of a broad set', () => {
    const hits: EvidenceRecord[] = [
      row({ id: 'tax-1', title: 'Tax and Bitcoin — income', themes: ['tax'] }),
      row({ id: 'tax-2', title: 'Tax and Bitcoin — capital', themes: ['tax'] }),
      row({ id: 'money', title: 'What is Bitcoin', themes: ['money'], date: '2018-06-01' }),
      row({ id: 'design', title: 'What is Bitcoin', themes: ['design'], date: '2024-02-02', excerpt: 'A commodity ledger with protocol rules.' }),
      row({ id: 'supply', title: 'The 21 million', themes: ['supply'] }),
      row({ id: 'script', title: 'Script and Bitcoin transactions', themes: ['script'] }),
    ];
    const packed = packBroadEvidence(hits, 'What is Bitcoin?', () => 0.99, { limit: 4 });
    expect(packed.leadAngle).toMatch(/supply/);
    expect(packed.leadAngle).toMatch(/21 million/);
    expect(packed.hits.map((hit) => hit.id)).toEqual(['supply', 'tax-1', 'money', 'design']);
  });
});

describe('loadRicherBody', () => {
  it('fails open when the fetch throws', async () => {
    const prose = await loadRicherBody('csw://essay/medium/x', async () => {
      throw new Error('down');
    });
    expect(prose).toBeUndefined();
  });

  it('fails open when the fetch exceeds the timeout', async () => {
    const prose = await loadRicherBody('csw://essay/medium/slow', () => new Promise(() => undefined), {
      timeoutMs: 30,
    });
    expect(prose).toBeUndefined();
  });

  it('caches a successful read by locator', async () => {
    let calls = 0;
    const load = async () => {
      calls += 1;
      return '---\ntitle: Cash\n---\n\n# Cash — core principles\n\nBitcoin is electronic cash.';
    };
    const first = await loadRicherBody('csw://essay/medium/cash', load);
    const second = await loadRicherBody('csw://essay/medium/cash', load);
    expect(first).toBe('Bitcoin is electronic cash.');
    expect(second).toBe(first);
    expect(calls).toBe(1);
  });

  it('expires a cached read after the ttl', async () => {
    let now = 0;
    let calls = 0;
    const cache = createLocatorCache<RicherSource>({ ttlMs: 1_000, now: () => now });
    const load = async () => {
      calls += 1;
      return 'Bitcoin is electronic cash.';
    };
    await loadRicherBody('csw://essay/medium/ttl', load, { cache });
    now = 1_001;
    await loadRicherBody('csw://essay/medium/ttl', load, { cache });
    expect(calls).toBe(2);
  });
});
