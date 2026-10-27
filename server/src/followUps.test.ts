import { describe, expect, it } from 'vitest';
import { deriveFollowUps, MAX_FOLLOW_UP_CHARS, MAX_FOLLOW_UPS, type FollowUpSource } from './followUps.js';

const ask = 'How are coins issued?';

describe('deriveFollowUps', () => {
  it('phrases one question per source class, in citation order, and stops at three', () => {
    const sources: FollowUpSource[] = [
      { label: '1', title: 'Alpha paper', sourceClass: 'satoshi-primary' },
      { label: '2', title: 'Beta format', sourceClass: 'spec' },
      { label: '3', title: 'Gamma essay', sourceClass: 'later-commentary' },
      { label: '4', title: 'Delta timeline', sourceClass: 'historical-record' },
    ];
    const chips = deriveFollowUps(sources, ask);
    expect(chips).toEqual([
      'What did Satoshi say about Alpha paper?',
      'What does the specification say about Beta format?',
      'What does the later commentary say about Gamma essay?',
    ]);
    expect(chips).toHaveLength(MAX_FOLLOW_UPS);
    expect(chips.join('\n')).not.toMatch(/Delta/);
  });

  it('uses the historical-record template and a plain label when there is no class', () => {
    expect(
      deriveFollowUps([{ label: 'd', title: 'The 2010 split', sourceClass: 'historical-record' }], ask),
    ).toEqual(['What does the historical record say about The 2010 split?']);
    expect(deriveFollowUps([{ label: 'Overlay checkpoints' }], ask)).toEqual([
      'What else is recorded about Overlay checkpoints?',
    ]);
  });

  it('cleans forum titles and collapses duplicate subjects', () => {
    expect(
      deriveFollowUps(
        [{ label: 'a', title: 'Re: [PATCH] increase block size limit', sourceClass: 'satoshi-primary' }],
        ask,
      ),
    ).toEqual(['What did Satoshi say about increase block size limit?']);
    expect(
      deriveFollowUps(
        [
          { label: 'a', title: 'Re: SPV', sourceClass: 'satoshi-primary' },
          { label: 'b', title: 'SPV', sourceClass: 'spec' },
          { label: 'c', title: 'spv!', sourceClass: 'historical-record' },
        ],
        ask,
      ),
    ).toEqual(['What did Satoshi say about SPV?']);
  });

  it('skips locators, generic titles, and a chip that repeats the user question', () => {
    expect(deriveFollowUps([{ label: 'brc://spec/62', sourceClass: 'spec' }], 'What is BEEF?')).toEqual([]);
    expect(deriveFollowUps([{ label: 'x', title: 'Untitled', sourceClass: 'satoshi-primary' }], ask)).toEqual([]);
    expect(
      deriveFollowUps(
        [{ label: 'a', title: 'Simplified Payment Verification', sourceClass: 'satoshi-primary' }],
        'What did Satoshi say about Simplified Payment Verification?',
      ),
    ).toEqual([]);
    expect(
      deriveFollowUps(
        [{ label: 'a', title: 'Simplified Payment Verification', sourceClass: 'satoshi-primary' }],
        'How do lightweight clients check a payment?',
      ),
    ).toEqual(['What did Satoshi say about Simplified Payment Verification?']);
  });

  it('keeps a short shared token — "What is SPV?" may still offer Satoshi on SPV', () => {
    expect(
      deriveFollowUps([{ label: 'a', title: 'SPV', sourceClass: 'satoshi-primary' }], 'What is SPV?'),
    ).toEqual(['What did Satoshi say about SPV?']);
  });

  it.each(['Craig Wright', 'Craig S. Wright', 'CSW', 'Nick Szabo', 'Adam Back', 'Dorian Nakamoto'])(
    'drops a source that names %s and still offers the next clean source',
    (name) => {
      const chips = deriveFollowUps(
        [
          { label: 'a', title: `Notes on ${name} and the design`, sourceClass: 'later-commentary' },
          { label: 'b', title: 'Simplified payment verification', sourceClass: 'satoshi-primary' },
        ],
        'How do lightweight clients check payments?',
      );
      expect(chips).toEqual(['What did Satoshi say about Simplified payment verification?']);
      expect(chips.join(' ')).not.toMatch(new RegExp(name.replace(/[.*]/g, '\\$&'), 'i'));
    },
  );

  it('returns nothing when the only source names a living candidate', () => {
    expect(
      deriveFollowUps([{ label: 'a', title: 'Craig Wright on SPV', sourceClass: 'later-commentary' }], ask),
    ).toEqual([]);
  });

  it('still names a deceased correspondent', () => {
    expect(
      deriveFollowUps([{ label: 'a', title: "Hal Finney's first reply", sourceClass: 'satoshi-primary' }], ask),
    ).toEqual(["What did Satoshi say about Hal Finney's first reply?"]);
  });

  it('keeps every chip within 90 characters and is deterministic', () => {
    const title = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    const sources: FollowUpSource[] = [{ label: 'a', title, sourceClass: 'historical-record' }];
    const first = deriveFollowUps(sources, ask);
    const again = deriveFollowUps(sources, ask);
    expect(again).toEqual(first);
    expect(first).toHaveLength(1);
    const chip = first[0];
    expect(chip).toBeDefined();
    expect(chip!.length).toBeLessThanOrEqual(MAX_FOLLOW_UP_CHARS);
    expect(chip).toMatch(/\?$/);
    expect(chip).toMatch(/^What does the historical record say about word0/);
    expect(chip).not.toMatch(/\s\?$/);
  });

  it('returns an empty list when there are no sources', () => {
    expect(deriveFollowUps([], ask)).toEqual([]);
  });
});
