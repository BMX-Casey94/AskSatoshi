import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CuratedReference,
  isIdentityQuestion,
  isScalingQuestion,
  loadCuratedReference,
  type DossierEntry,
  type ScalingRecord,
} from './curatedReference.js';
import { groundQuestion } from './orchestrate.js';
import type { McpBridge } from './mcp.js';

const ENTRY = (over: Partial<DossierEntry>): DossierEntry => ({
  id: over.id ?? 'e1',
  category: over.category ?? 'testimony',
  title: over.title ?? 'An account',
  date: over.date,
  url: over.url,
  text: over.text ?? 'Some testimony about the identity question.',
  pin: over.pin,
});

const SCALING: ScalingRecord = {
  evidenceText:
    'DEMONSTRATED CAPACITY — measured throughput record: 79.09 x 10^9 TPS peak pipeline-processed on a 100-server fleet (preprint, idealised conditions).',
  citations: [
    {
      label: 'Horizontal Scaling of UTXO-Based Transaction Processing (SSRN preprint, 2026)',
      title: 'Horizontal Scaling of UTXO-Based Transaction Processing',
      url: 'https://papers.ssrn.com/sol3/papers.cfm?abstract_id=7219719',
      excerpt: '79.09 billion TPS peak.',
    },
  ],
};

const INSUFFICIENT_PKG = {
  question: 'unrelated',
  classified_as: 'historical',
  claims: [{ text: '', support: [], status: 'insufficient' }],
  hits: [],
  gaps: [],
  contradictions: [],
};

function thinMcp(): McpBridge {
  return { connected: true, investigate: async () => INSUFFICIENT_PKG } as unknown as McpBridge;
}

describe('isIdentityQuestion', () => {
  it('matches the identity frames', () => {
    expect(isIdentityQuestion('Who is Satoshi Nakamoto?')).toBe(true);
    expect(isIdentityQuestion('Are you the real Satoshi?')).toBe(true);
    expect(isIdentityQuestion('Is Craig Wright really Satoshi?')).toBe(true);
    expect(isIdentityQuestion('Are you Craig Wright?')).toBe(true);
    expect(isIdentityQuestion('who created Bitcoin?')).toBe(true);
    expect(isIdentityQuestion('Can you prove you are Satoshi?')).toBe(true);
    expect(isIdentityQuestion('Was Satoshi Nakamoto doxxed in 2015?')).toBe(true);
    expect(isIdentityQuestion('What is the 1Csw address hidden in the whitepaper?')).toBe(true);
    expect(isIdentityQuestion('Is Bitcoin anonymous?')).toBe(false);
  });

  it('ignores the satoshi unit and technical key questions', () => {
    expect(isIdentityQuestion('What is a satoshi?')).toBe(false);
    expect(isIdentityQuestion('How many satoshis are in one bitcoin?')).toBe(false);
    expect(isIdentityQuestion('How do private keys work?')).toBe(false);
    expect(isIdentityQuestion('What is OP_CHECKSIG?')).toBe(false);
  });
});

describe('isScalingQuestion', () => {
  it('matches throughput and Teranode frames', () => {
    expect(isScalingQuestion('Can Bitcoin scale to millions of transactions per second?')).toBe(true);
    expect(isScalingQuestion('What is Teranode capable of?')).toBe(true);
    expect(isScalingQuestion('What TPS can the network sustain?')).toBe(true);
    expect(isScalingQuestion('Was the block size limit meant to be permanent?')).toBe(true);
  });

  it('rejects the image-resizing word sense', () => {
    expect(isScalingQuestion('How do I scale the logo image?')).toBe(false);
    expect(isScalingQuestion('Can I resize this icon without scaling artefacts?')).toBe(false);
  });
});

describe('CuratedReference.searchDossier', () => {
  const entries: DossierEntry[] = [
    ENTRY({ id: 'pinned', category: 'doxxing-2015', title: 'The 2015 outing', text: 'Dragged into the open by journalists.', pin: true }),
    ENTRY({ id: 't1', category: 'testimony', title: 'A witness account of Satoshi', text: 'A witness describes the private demonstration for Satoshi.' }),
    ENTRY({ id: 't2', category: 'testimony', title: 'Another witness on Satoshi', text: 'A second witness account of Satoshi.' }),
    ENTRY({ id: 'c1', category: 'curiosity', title: 'The whitepaper breadcrumb', text: 'A hidden address prefix some link to Satoshi.' }),
  ];

  it('puts pinned cornerstones first and keeps categories diverse', () => {
    const ref = new CuratedReference(entries, null);
    const picked = ref.searchDossier('Who is Satoshi?', 4);
    expect(picked[0]?.id).toBe('pinned');
    const ids = picked.map((p) => p.id);
    expect(ids).toContain('c1'); // curiosity not crowded out by the two testimony hits
    expect(ids.filter((id) => id.startsWith('t')).length).toBeLessThanOrEqual(2);
  });

  it('respects the limit', () => {
    const ref = new CuratedReference(entries, null);
    expect(ref.searchDossier('Who is Satoshi?', 2)).toHaveLength(2);
  });
});

describe('loadCuratedReference', () => {
  it('loads dossier and scaling record from explicit paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'curated-'));
    try {
      const dossierPath = join(dir, 'dossier.json');
      const scalingPath = join(dir, 'scaling.json');
      writeFileSync(dossierPath, JSON.stringify({ entries: [ENTRY({ id: 'x' })] }));
      writeFileSync(scalingPath, JSON.stringify(SCALING));
      const ref = loadCuratedReference(dossierPath, scalingPath);
      expect(ref).not.toBeNull();
      expect(ref!.scaling?.evidenceText).toContain('79.09');
      expect(ref!.searchDossier('anything')).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when both files are missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'curated-'));
    try {
      expect(loadCuratedReference(join(dir, 'nope.json'), join(dir, 'nada.json'))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('groundQuestion with curated reference', () => {
  const dossier: DossierEntry[] = [
    ENTRY({
      id: 'doxxing',
      category: 'doxxing-2015',
      title: 'The December 2015 outing',
      date: '2015-12-09',
      url: 'https://example.com/doxxing',
      text: 'He did not come forward; he was named by journalists, and his home was visited within hours.',
      pin: true,
    }),
    ENTRY({
      id: 'kurt',
      category: 'commentary',
      title: 'A historian weighs the evidence',
      date: '2021-05-01',
      url: 'https://example.com/kurt',
      text: 'Kurt Wuckert Jr has made some great points which often get little attention.',
    }),
  ];

  it('answers identity questions from the dossier with historical-record citations', async () => {
    const curated = new CuratedReference(dossier, null);
    const g = await groundQuestion('Who is Satoshi Nakamoto?', { mcp: thinMcp(), corpus: null, curated });
    expect(g.mode).toBe('reference');
    expect(g.evidenceText).toContain('THE HISTORICAL RECORD');
    expect(g.evidenceText).toContain('did not come forward');
    expect(g.citations.length).toBeGreaterThan(0);
    expect(g.citations[0]?.sourceClass).toBe('historical-record');
    expect(g.citations[0]?.url).toBe('https://example.com/doxxing');
  });

  it('does not hijack the satoshi-unit question', async () => {
    const curated = new CuratedReference(dossier, null);
    const g = await groundQuestion('What is a satoshi?', { mcp: thinMcp(), corpus: null, curated });
    expect(g.mode).not.toBe('reference');
  });

  it('appends the demonstrated-capacity record to scaling answers', async () => {
    const curated = new CuratedReference([], SCALING);
    const g = await groundQuestion('Can Bitcoin scale to billions of transactions?', {
      mcp: thinMcp(),
      corpus: null,
      curated,
    });
    expect(g.evidenceText).toContain('79.09');
    expect(g.citations.some((c) => c.url?.includes('ssrn.com'))).toBe(true);
    expect(g.citations.find((c) => c.url?.includes('ssrn.com'))?.sourceClass).toBe('historical-record');
  });

  it('lets the scaling record stand alone when nothing else grounds the question', async () => {
    const curated = new CuratedReference([], SCALING);
    const g = await groundQuestion('What TPS can Teranode sustain?', { mcp: thinMcp(), corpus: null, curated });
    expect(g.mode).toBe('reference');
    expect(g.evidenceText).toContain('DEMONSTRATED CAPACITY');
  });

  it('leaves non-scaling, non-identity questions untouched', async () => {
    const curated = new CuratedReference(dossier, SCALING);
    const g = await groundQuestion('zxqwv unrelated gibberish', { mcp: thinMcp(), corpus: null, curated });
    expect(g.mode).toBe('none');
    expect(g.evidenceText).toBe('');
  });
});
