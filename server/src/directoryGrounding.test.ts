import { describe, expect, it } from 'vitest';
import { CATALOGUE_CAVEAT, DIRECTORY_EVIDENCE_HEADER, DIRECTORY_PROVENANCE_NOTE, type DirectoryHit, type DirectorySource } from './bsvRadar.js';
import { withDirectoryEvidence } from './directoryGrounding.js';
import type { Grounding } from './orchestrate.js';

const hit = (over: Partial<DirectoryHit> = {}): DirectoryHit => ({
  kind: 'app',
  id: 'handcash',
  name: 'HandCash',
  category: 'Wallets',
  summary: 'A user-friendly BSV wallet with social features',
  url: 'https://handcash.io',
  radarUrl: 'https://bsvradar.com/apps/handcash',
  lastUpdated: '2026-05-29',
  ...over,
});

const stub = (hits: DirectoryHit[], now = '2026-10-28T12:00:00.000Z'): DirectorySource => ({
  searchAll: () => hits,
  meta: { fetchedAt: '2026-10-28T12:00:00.000Z', sourceFileDate: '2026-10-28' },
  now: () => new Date(now),
});

const base: Grounding = {
  mode: 'mcp',
  evidenceText: 'Existing evidence.',
  citations: [{ label: 'BRC-62', sourceClass: 'spec' }],
};

describe('withDirectoryEvidence', () => {
  it('is a no-op for a how-to-build question, a mechanics question, a missing index, or no matches', () => {
    const hits = [hit()];
    expect(withDirectoryEvidence(base, 'How do I build an app?', undefined, stub(hits)).usedDirectory).toBe(false);
    expect(withDirectoryEvidence(base, 'How do I build an app?', undefined, stub(hits)).grounding).toBe(base);
    expect(withDirectoryEvidence(base, 'How does a Merkle branch show inclusion?', undefined, stub(hits)).usedDirectory).toBe(
      false,
    );
    expect(withDirectoryEvidence(base, 'Who is Satoshi Nakamoto?', undefined, stub(hits)).usedDirectory).toBe(false);
    expect(withDirectoryEvidence(base, 'What is the latest BSV partnership news?', undefined, stub(hits)).usedDirectory).toBe(
      false,
    );
    const q = 'What wallets exist on BSV?';
    expect(withDirectoryEvidence(base, q, undefined, null).usedDirectory).toBe(false);
    expect(withDirectoryEvidence(base, q, undefined, stub([])).usedDirectory).toBe(false);
    expect(withDirectoryEvidence(base, q, undefined, stub([])).grounding).toBe(base);
  });

  it('appends the caveat, the model instruction and directory citations', () => {
    const result = withDirectoryEvidence(base, 'What wallets exist on BSV?', undefined, stub([hit()]));
    expect(result.usedDirectory).toBe(true);
    expect(result.grounding.mode).toBe('mcp');
    // Directory evidence leads: it must survive free-tier truncation, which keeps the head.
    expect(result.grounding.evidenceText.startsWith(DIRECTORY_EVIDENCE_HEADER)).toBe(true);
    expect(result.grounding.evidenceText).toContain('Existing evidence.');
    expect(result.grounding.evidenceText).toContain(
      'APP DIRECTORY (BSV Radar — partial community catalogue, listing is not endorsement, status may be out of date):',
    );
    expect(result.grounding.evidenceText).toContain(CATALOGUE_CAVEAT);
    expect(result.grounding.evidenceText).toContain(DIRECTORY_PROVENANCE_NOTE);
    expect(result.grounding.evidenceText).toContain('partial list');
    expect(result.grounding.evidenceText).toContain('Never claim the catalogue is complete');
    expect(result.grounding.evidenceText).toContain('Never endorse an app');
    expect(result.grounding.evidenceText).toContain('Never state that an app is currently operational');
    expect(result.grounding.evidenceText).toContain('between three and six listings');
    expect(result.grounding.evidenceText).toContain('HandCash (Wallets)');
    expect(result.grounding.evidenceText).toContain('https://handcash.io');
    expect(result.grounding.evidenceText).toContain('catalogue page https://bsvradar.com/apps/handcash');
    expect(result.grounding.evidenceText).toContain('catalogue date 29 May 2026');
    expect(result.grounding.evidenceText).toContain('Snapshot taken 28 October 2026');
    expect(result.grounding.citations).toHaveLength(2);
    expect(result.grounding.citations[1]).toMatchObject({
      label: 'HandCash',
      title: 'HandCash',
      url: 'https://bsvradar.com/apps/handcash',
      sourceClass: 'directory',
      date: '2026-05-29',
    });
  });

  it('turns a retrieval miss into a reference-mode answer and caps the list at eight', () => {
    const miss: Grounding = { mode: 'none', evidenceText: '', citations: [] };
    const many = Array.from({ length: 10 }, (_unused, index) =>
      hit({ id: `app-${index}`, name: `App ${index}`, radarUrl: `https://bsvradar.com/apps/app-${index}` }),
    );
    const result = withDirectoryEvidence(miss, 'List BSV apps', undefined, stub(many));
    expect(result.grounding.mode).toBe('reference');
    expect(result.grounding.citations).toHaveLength(8);
    expect(result.grounding.citations.every((citation) => citation.sourceClass === 'directory')).toBe(true);
  });

  it('says the snapshot may be behind the live directory once it is more than 14 days old', () => {
    const fresh = withDirectoryEvidence(base, 'List BSV apps', undefined, stub([hit()], '2026-11-11T12:00:00.000Z'));
    expect(fresh.grounding.evidenceText).not.toContain('may be behind the live directory');
    const stale = withDirectoryEvidence(base, 'List BSV apps', undefined, stub([hit()], '2026-11-12T12:00:00.000Z'));
    expect(stale.grounding.evidenceText).toContain('This snapshot is more than 14 days old and may be behind the live directory.');
  });
});
