import { describe, expect, it } from 'vitest';
import { answerProvenance, PROVENANCE_LABEL_LIMIT, type Provenance } from './provenance';

const OWN_WORDS = "Satoshi's own words";

const FULL_NAME = {
  'satoshi-primary': "Satoshi's own words (2008–2011)",
  spec: 'the protocol specification',
  'later-commentary': 'the later essays',
  'historical-record': 'the curated historical record',
} as const;

const CLASSES = ['satoshi-primary', 'spec', 'later-commentary', 'historical-record'] as const;

type ClassName = (typeof CLASSES)[number];

function cite(sourceClass?: string | null) {
  return { sourceClass };
}

function textOf(provenance: Provenance | null): string {
  if (!provenance) return '';
  return `${provenance.label}\n${provenance.title}`;
}

function subsets(items: readonly ClassName[]): ClassName[][] {
  const out: ClassName[][] = [];
  for (let mask = 1; mask < 2 ** items.length; mask += 1) {
    const subset: ClassName[] = [];
    for (let index = 0; index < items.length; index += 1) {
      if ((mask & (2 ** index)) === 0) continue;
      const item = items[index];
      if (item) subset.push(item);
    }
    out.push(subset);
  }
  return out;
}

describe('answerProvenance (general knowledge)', () => {
  it('labels a retrieval miss answered by the model, whatever else is present', () => {
    const p = answerProvenance({ mode: 'none', general: true, citations: [] });
    expect(p?.kind).toBe('general');
    expect(p?.label).toBe('General knowledge, not from the record');
    expect(p?.title).toContain('Nothing in the record matched');
  });
  it('shows nothing for a plain miss without the general flag', () => {
    expect(answerProvenance({ mode: 'none', citations: [] })).toBeNull();
  });
});

describe('answerProvenance', () => {
  it('keeps mixed labels to one narrow line', () => {
    expect(PROVENANCE_LABEL_LIMIT).toBeLessThanOrEqual(52);
  });

  describe('one kind of citation', () => {
    it("names Satoshi's own words only from satoshi-primary citations", () => {
      const provenance = answerProvenance({
        citations: [cite('satoshi-primary'), cite('satoshi-primary')],
        mode: 'mcp',
      });
      expect(provenance).toEqual({
        kind: 'satoshi-primary',
        label: "Answered from Satoshi's own words (2008–2011)",
        title: "The cited sources are Satoshi Nakamoto's own writings from 2008 to 2011.",
      });
    });

    it('names the protocol specification for spec citations', () => {
      expect(answerProvenance({ citations: [cite('spec')], mode: 'mcp' })).toEqual({
        kind: 'spec',
        label: 'Answered from the protocol specification (BRCs, Script, SDK)',
        title: 'The cited sources are from the protocol specification (BRCs, Script, SDK).',
      });
    });

    it('names the later essays for later-commentary citations, including an mcp answer', () => {
      const provenance = answerProvenance({
        citations: [cite('later-commentary'), cite('later-commentary')],
        mode: 'mcp',
      });
      expect(provenance).toEqual({
        kind: 'later-commentary',
        label: 'Answered from the later essays and commentary',
        title: 'The cited sources are the later essays and commentary.',
      });
      expect(textOf(provenance)).not.toContain(OWN_WORDS);
      expect(textOf(provenance)).not.toContain('protocol record');
      expect(textOf(provenance)).not.toContain('BRCs');
    });

    it('names the curated historical record for historical-record citations', () => {
      expect(answerProvenance({ citations: [cite('historical-record')], mode: 'mcp' })).toEqual({
        kind: 'historical-record',
        label: 'Answered from the curated historical record',
        title: 'The cited sources are from the curated historical record.',
      });
    });

    it('does not treat an unclassified citation as the same kind', () => {
      expect(
        answerProvenance({
          citations: [cite('spec'), cite(undefined), { sourceClass: null }],
        }),
      ).toMatchObject({
        kind: 'spec',
        label: 'Answered from the protocol specification (BRCs, Script, SDK)',
        title: 'The citations with a known kind of source are from the protocol specification (BRCs, Script, SDK).',
      });
    });
  });

  describe('several kinds of citation', () => {
    it('lists spec and essays without calling the answer Satoshi', () => {
      const provenance = answerProvenance({
        citations: [cite('later-commentary'), cite('spec')],
        mode: 'mcp',
      });
      expect(provenance).toEqual({
        kind: 'mixed',
        label: 'Drawn from 2 kinds of source: the spec and essays',
        title:
          'Drawn from 2 kinds of source, in order of evidentiary weight: the protocol specification and the later essays.',
      });
      expect(textOf(provenance)).not.toContain('Satoshi');
      expect(provenance?.label.length).toBeLessThanOrEqual(PROVENANCE_LABEL_LIMIT);
    });

    it('keeps every kind in the tooltip when the visible line is shortened', () => {
      const provenance = answerProvenance({
        citations: [
          cite('historical-record'),
          cite('later-commentary'),
          cite('spec'),
          cite('satoshi-primary'),
          cite('satoshi-primary'),
        ],
      });
      expect(provenance?.kind).toBe('mixed');
      expect(provenance?.label).toBe('Drawn from 4 kinds of source: Satoshi and the spec…');
      expect(provenance?.label.endsWith('…')).toBe(true);
      expect(provenance?.label.length).toBeLessThanOrEqual(PROVENANCE_LABEL_LIMIT);
      const title = provenance?.title ?? '';
      let previous = -1;
      for (const sourceClass of CLASSES) {
        const position = title.indexOf(FULL_NAME[sourceClass]);
        expect(position).toBeGreaterThan(previous);
        previous = position;
      }
      expect(title.endsWith('.')).toBe(true);
      expect(title.slice(0, -1).includes('.')).toBe(false);
    });

    it('uses evidentiary order whatever order the citations arrived in', () => {
      const forward = answerProvenance({
        citations: [cite('spec'), cite('later-commentary'), cite('historical-record')],
      });
      const backward = answerProvenance({
        citations: [cite('historical-record'), cite('later-commentary'), cite('spec')],
      });
      expect(backward).toEqual(forward);
      expect(forward?.label).toBe('Drawn from 3 kinds of source: the spec and essays…');
      expect(forward?.title).toBe(
        'Drawn from 3 kinds of source, in order of evidentiary weight: the protocol specification, the later essays and the curated historical record.',
      );
    });

    it('never says Satoshi\'s own words unless a satoshi-primary citation exists', () => {
      for (const subset of subsets(CLASSES)) {
        const provenance = answerProvenance({
          citations: subset.map((sourceClass) => cite(sourceClass)),
          mode: 'corpus',
        });
        expect(provenance).not.toBeNull();
        if (subset.includes('satoshi-primary')) {
          expect(textOf(provenance)).toContain(OWN_WORDS);
        } else {
          expect(textOf(provenance)).not.toContain(OWN_WORDS);
          expect(textOf(provenance)).not.toContain('Satoshi');
        }
        if (subset.length > 1) {
          expect(provenance?.kind).toBe('mixed');
          expect(provenance?.label.length).toBeLessThanOrEqual(PROVENANCE_LABEL_LIMIT);
          expect(provenance?.title.endsWith('.')).toBe(true);
          expect(provenance?.title.slice(0, -1).includes('.')).toBe(false);
        }
      }
    });
  });

  describe('fallback when nothing is classified', () => {
    it('does not call an unclassified corpus answer Satoshi\'s own words', () => {
      const provenance = answerProvenance({
        citations: [cite(undefined), cite('not-a-class')],
        mode: 'corpus',
      });
      expect(provenance).toEqual({
        kind: 'corpus',
        label: 'Answered from the 2008–2011 corpus',
        title: 'Retrieved from the 2008–2011 writing corpus.',
      });
      expect(textOf(provenance)).not.toContain(OWN_WORDS);
      expect(textOf(provenance)).not.toContain('Satoshi');
    });

    it('does not call an unclassified mcp answer the protocol record', () => {
      for (const citations of [undefined, null, [], [cite(undefined), cite('essay')]]) {
        const provenance = answerProvenance({ citations, mode: 'mcp' });
        expect(provenance).toEqual({
          kind: 'mcp',
          label: 'Answered from the indexed record',
          title: 'Retrieved from the indexed record.',
        });
        expect(textOf(provenance)).not.toMatch(/protocol|BRC|Script|SDK|essay/i);
      }
    });

    it('uses the curated historical record for reference mode', () => {
      expect(answerProvenance({ mode: 'reference' })).toEqual({
        kind: 'reference',
        label: 'Answered from the curated historical record',
        title: 'Retrieved from the curated historical record.',
      });
    });

    it('returns null when there is nothing to describe', () => {
      expect(answerProvenance({})).toBeNull();
      expect(answerProvenance({ citations: [], mode: 'none' })).toBeNull();
      expect(answerProvenance({ citations: [cite('nope')], mode: 'none' })).toBeNull();
      expect(answerProvenance({ mode: 'sideways' })).toBeNull();
    });

    it('still uses citations when mode is none', () => {
      expect(answerProvenance({ citations: [cite('later-commentary')], mode: 'none' })?.kind).toBe('later-commentary');
    });
  });

  describe('news reporting', () => {
    it('names dated CoinGeek reporting when that is the only kind', () => {
      expect(answerProvenance({ citations: [cite('news'), cite('news')], mode: 'mcp' })).toEqual({
        kind: 'news',
        label: 'Answered from CoinGeek news reporting (dated)',
        title: 'The cited sources are CoinGeek news reporting, and the articles are dated.',
      });
    });

    it('includes news reporting in a mixed list, after stronger evidence', () => {
      const provenance = answerProvenance({
        citations: [cite('news'), cite('spec')],
      });
      expect(provenance).toEqual({
        kind: 'mixed',
        label: 'Drawn from 2 kinds of source: the spec and news',
        title:
          'Drawn from 2 kinds of source, in order of evidentiary weight: the protocol specification and CoinGeek news reporting.',
      });
      expect(provenance?.title).toContain('news reporting');
      expect(provenance?.label.length).toBeLessThanOrEqual(PROVENANCE_LABEL_LIMIT);
    });

    it('keeps a five-kind mix on one line and still names news reporting in the tooltip', () => {
      const provenance = answerProvenance({
        citations: [
          cite('news'),
          cite('historical-record'),
          cite('later-commentary'),
          cite('spec'),
          cite('satoshi-primary'),
        ],
      });
      expect(provenance?.kind).toBe('mixed');
      expect(provenance?.label).toBe('Drawn from 5 kinds of source: Satoshi and the spec…');
      expect(provenance?.label.length).toBeLessThanOrEqual(PROVENANCE_LABEL_LIMIT);
      expect(provenance?.title).toBe(
        "Drawn from 5 kinds of source, in order of evidentiary weight: Satoshi's own words (2008–2011), the protocol specification, the later essays, the curated historical record and CoinGeek news reporting.",
      );
      expect(provenance?.title.endsWith('.')).toBe(true);
      expect(provenance?.title.slice(0, -1).includes('.')).toBe(false);
    });
  });

  describe('app directory', () => {
    it('names the BSV Radar catalogue when that is the only kind', () => {
      expect(answerProvenance({ citations: [cite('directory')], mode: 'reference' })).toEqual({
        kind: 'directory',
        label: 'Answered from the app directory',
        title:
          'The cited sources are the BSV Radar app directory, a partial community catalogue and not an endorsement.',
      });
    });

    it('lists the directory after news in a mix', () => {
      const provenance = answerProvenance({
        citations: [cite('directory'), cite('news')],
      });
      expect(provenance).toEqual({
        kind: 'mixed',
        label: 'Drawn from 2 kinds of source: news and directory',
        title:
          'Drawn from 2 kinds of source, in order of evidentiary weight: CoinGeek news reporting and the BSV Radar app directory.',
      });
      expect(provenance?.label.length).toBeLessThanOrEqual(PROVENANCE_LABEL_LIMIT);
    });
  });

  it('does not reorder the caller\'s citations', () => {
    const citations = [cite('historical-record'), cite('satoshi-primary')];
    answerProvenance({ citations });
    expect(citations.map((item) => item.sourceClass)).toEqual(['historical-record', 'satoshi-primary']);
  });
});
