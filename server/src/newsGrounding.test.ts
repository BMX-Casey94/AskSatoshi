import { describe, expect, it } from 'vitest';
import type { NewsHit } from './coingeekNews.js';
import { withNewsEvidence } from './newsGrounding.js';
import type { Grounding } from './orchestrate.js';

const hit = (over: Partial<NewsHit> = {}): NewsHit => ({
  id: 'n1',
  url: 'https://coingeek.com/example-launch/',
  title: 'Example firm launches BSV payments',
  date: '2026-09-01',
  excerpt: 'The firm said it had launched payments on BSV.',
  ageMonths: 2,
  freshness: 'current',
  ...over,
});

const stub = (hits: NewsHit[]) => ({ searchAll: () => hits });

const base: Grounding = {
  mode: 'mcp',
  evidenceText: 'Existing evidence.',
  citations: [{ label: 'BRC-62', sourceClass: 'spec' }],
};

describe('withNewsEvidence', () => {
  it('leaves protocol-mechanics questions untouched', () => {
    const r = withNewsEvidence(base, 'How does a Merkle branch show inclusion?', undefined, stub([hit()]));
    expect(r.usedNews).toBe(false);
    expect(r.grounding).toBe(base);
  });

  it('leaves identity questions untouched', () => {
    const r = withNewsEvidence(base, 'Who is Satoshi Nakamoto?', undefined, stub([hit()]));
    expect(r.usedNews).toBe(false);
  });

  it('is a no-op when the news index is absent or finds nothing', () => {
    const q = 'What is the latest BSV partnership news?';
    expect(withNewsEvidence(base, q, undefined, null).usedNews).toBe(false);
    expect(withNewsEvidence(base, q, undefined, stub([])).usedNews).toBe(false);
  });

  it('appends dated news evidence and news citations for an event question', () => {
    const r = withNewsEvidence(base, 'What is the latest BSV partnership news?', undefined, stub([hit()]));
    expect(r.usedNews).toBe(true);
    expect(r.grounding.mode).toBe('mcp');
    expect(r.grounding.evidenceText.startsWith('Existing evidence.')).toBe(true);
    expect(r.grounding.evidenceText).toContain('NEWS REPORTING');
    expect(r.grounding.evidenceText).toContain('[News — CoinGeek, 1 September 2026');
    expect(r.grounding.citations).toHaveLength(2);
    expect(r.grounding.citations[1]?.sourceClass).toBe('news');
  });

  it('turns a retrieval miss into a reference-mode answer when news can answer it', () => {
    const miss: Grounding = { mode: 'none', evidenceText: '', citations: [] };
    const r = withNewsEvidence(miss, 'What is the latest BSV partnership news?', undefined, stub([hit()]));
    expect(r.grounding.mode).toBe('reference');
    expect(r.grounding.citations).toHaveLength(1);
  });

  it('flags older reporting as possibly out of date', () => {
    const old = hit({ date: '2024-01-10', ageMonths: 33, freshness: 'dated' });
    const r = withNewsEvidence(base, 'What is the latest BSV partnership news?', undefined, stub([old]));
    expect(r.grounding.evidenceText).toContain('may be out of date');
  });
});
