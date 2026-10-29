import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CuratedReference,
  IMPLEMENTATION_TECH_QUERY,
  implementationTechQuery,
  isDepartureQuestion,
  isIdentityQuestion,
  isImplementationQuestion,
  isScalingQuestion,
  isTimecoinQuestion,
  loadCuratedReference,
  type DossierEntry,
  type ScalingRecord,
} from './curatedReference.js';
import { groundQuestion, questionClass } from './orchestrate.js';
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

const IMPLEMENTATION: ScalingRecord = {
  evidenceText:
    'IMPLEMENTATION STACK — BSV-only: prescribe BRC-100, native script, OP_RETURN and SPV. Never prescribe Taproot, SegWit or Lightning.',
  citations: [
    {
      label: 'BRC-100 — Wallet Interface',
      title: 'BRC-100 Wallet-to-Application Interface',
      url: 'https://github.com/bsv-blockchain/BRCs/blob/master/wallet/0100.md',
      excerpt: 'The wallet-to-application interface.',
    },
  ],
};

const TIMECOIN: ScalingRecord = {
  evidenceText: 'TIMECOIN — ATTRIBUTED RECORD: his account, the court findings, his dispute.',
  citations: [
    {
      label: 'COPA v Wright [2024] EWHC 1198 (Ch) (BAILII)',
      url: 'https://www.bailii.org/ew/cases/EWHC/Ch/2024/1198.html',
      excerpt: 'Findings on the Timecoin documents.',
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

describe('isImplementationQuestion', () => {
  it('matches builder and application frames', () => {
    expect(
      isImplementationQuestion(
        'If I were to make an application for a charity that can be transparent and ran on-chain, what would you choose to implement and why?',
      ),
    ).toBe(true);
    expect(isImplementationQuestion('How do I build a wallet that talks to the chain?')).toBe(true);
    expect(isImplementationQuestion('What stack should I use for an on-chain donation platform?')).toBe(true);
    // Third-person design questions with no first person and no build verb still ask
    // "what should I build" — custody/governance nouns anchor the intent.
    expect(isImplementationQuestion('How should three trustees share control of a treasury on-chain?')).toBe(true);
    expect(isImplementationQuestion('What is the best way to structure an escrow between two parties?')).toBe(true);
    expect(
      isImplementationQuestion(
        'What is the best architecture for building a decentralised trading platform on Bitcoin?',
      ),
    ).toBe(true);
    expect(
      isImplementationQuestion(
        'How do I add login to my Bitcoin app so the server knows which wallet is calling?',
      ),
    ).toBe(true);
    expect(isImplementationQuestion('How do I build a paid API that charges a micropayment per request?')).toBe(
      true,
    );
  });

  it('lets critique and definition of BTC features through as non-builder questions', () => {
    expect(isImplementationQuestion('What is Taproot?')).toBe(false);
    expect(isImplementationQuestion('Why is SegWit a problem?')).toBe(false);
    expect(isImplementationQuestion('Explain Lightning Network')).toBe(false);
    expect(isImplementationQuestion('How do I know if Bitcoin is private?')).toBe(false);
    // Design nouns alone do not make a build question — definitions stay explanations.
    expect(isImplementationQuestion('What is a multisig wallet?')).toBe(false);
    expect(isImplementationQuestion('Explain how a treasury multisig works')).toBe(false);
  });

  it('classifies builder questions as facts so the answer does not hedge', () => {
    expect(questionClass('How do I build a charity app on chain?')).toBe('fact');
  });
});

describe('implementationTechQuery', () => {
  it('keeps the generic builder hint for ordinary builds', () => {
    expect(implementationTechQuery('How do I accept BSV payments in my web app?')).toBe(
      IMPLEMENTATION_TECH_QUERY,
    );
    expect(implementationTechQuery('How should three trustees share control of a treasury on-chain?')).toBe(
      IMPLEMENTATION_TECH_QUERY,
    );
  });

  it('adds BRC-79 when the build is a market, exchange or DEX', () => {
    const q = 'What is the best architecture for building a decentralised trading platform on Bitcoin?';
    const query = implementationTechQuery(q);
    expect(query).toContain('BRC-79');
    expect(query.startsWith(IMPLEMENTATION_TECH_QUERY)).toBe(true);
    expect(implementationTechQuery('How do I build a token exchange with an on-chain settlement layer?')).toContain(
      'BRC-79',
    );
  });

  it('adds BRC-138 for app login and BRC-121 for a paid API, not BRC-31', () => {
    expect(
      implementationTechQuery(
        'How do I add login to my Bitcoin app so the server knows which wallet is calling?',
      ),
    ).toContain('BRC-138');
    const paid = implementationTechQuery('How do I build a paid API that charges a micropayment per request?');
    expect(paid).toContain('BRC-121');
    expect(paid).not.toContain('BRC-31');
    expect(
      implementationTechQuery('What is the best way to structure an escrow between a buyer and a seller with a refund window?'),
    ).toBe(IMPLEMENTATION_TECH_QUERY);
  });
});

describe('implementation-record.json', () => {
  it('maps marketplace builds to atomic UTXO settlement, not a compiler or identity token', () => {
    const path = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'implementation-record.json');
    const rec = JSON.parse(readFileSync(path, 'utf8')) as { evidenceText: string };
    expect(rec.evidenceText).toMatch(/DECISION TABLE/);
    expect(rec.evidenceText).toMatch(/BRC-79/);
    expect(rec.evidenceText).toMatch(/atomic/i);
    expect(rec.evidenceText).toMatch(/signed UTXO/i);
    expect(rec.evidenceText).toMatch(/BRC-174 name tokens are identity binding, not a trading engine/);
    expect(rec.evidenceText).toMatch(/2-of-2/);
    expect(rec.evidenceText).toMatch(/nLockTime/);
    expect(rec.evidenceText).toMatch(/BRC-138/);
    expect(rec.evidenceText).toMatch(/BRC-121/);
    expect(rec.evidenceText).toMatch(/BRC-105/);
    expect(rec.evidenceText).not.toMatch(/x402 \(BRC-31 authenticated/);
    expect(rec.evidenceText).toMatch(/BRC-31 is Authrite mutual authentication, not a payment protocol/);
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

  it('prepends the BSV implementation stack to builder questions', async () => {
    const curated = new CuratedReference([], null, IMPLEMENTATION);
    const g = await groundQuestion(
      'If I were to make an application for a charity that ran on-chain, what would you choose to implement?',
      { mcp: thinMcp(), corpus: null, curated },
    );
    // Head position: the decision record must survive the free-tier evidence budget cut.
    expect(g.evidenceText.startsWith('IMPLEMENTATION STACK')).toBe(true);
    expect(g.evidenceText).toContain('BRC-100');
    expect(g.citations.some((c) => c.url?.includes('0100.md'))).toBe(true);
    expect(g.citations.find((c) => c.url?.includes('0100.md'))?.sourceClass).toBe('historical-record');
  });

  it('prepends the Timecoin record, including when the question reads as an identity question', async () => {
    const curated = new CuratedReference(dossier, null, null, TIMECOIN);
    const g = await groundQuestion('What did Craig Wright mean by Timecoin?', { mcp: thinMcp(), corpus: null, curated });
    expect(g.evidenceText.startsWith('TIMECOIN')).toBe(true);
    expect(g.citations.some((c) => c.url?.includes('bailii.org'))).toBe(true);
  });

  it('leaves unrelated questions alone when a Timecoin record is loaded', async () => {
    const curated = new CuratedReference([], null, null, TIMECOIN);
    const g = await groundQuestion('zxqwv unrelated gibberish', { mcp: thinMcp(), corpus: null, curated });
    expect(g.evidenceText).toBe('');
  });
});

describe('isTimecoinQuestion', () => {
  it('matches Timecoin spellings', () => {
    expect(isTimecoinQuestion('What is Timecoin?')).toBe(true);
    expect(isTimecoinQuestion('Was TimeChain real?')).toBe(true);
    expect(isTimecoinQuestion('Tell me about the Time coin paper')).toBe(true);
    expect(isTimecoinQuestion('What is the Hashcoin white paper?')).toBe(true);
  });
  it('does not match ordinary time or coin talk', () => {
    expect(isTimecoinQuestion('How long does a block take, time wise?')).toBe(false);
    expect(isTimecoinQuestion('What is a coin?')).toBe(false);
  });
});

describe('shipped timecoin record', () => {
  const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'timecoin-record.json');
  const rec = JSON.parse(readFileSync(file, 'utf8')) as ScalingRecord;
  it('has real citation URLs and never asserts foul play as fact', () => {
    expect(rec.citations.length).toBeGreaterThan(3);
    for (const c of rec.citations) expect(c.url).toMatch(/^https:\/\//);
    expect(rec.evidenceText).toContain('must not assert one');
    expect(rec.evidenceText).toContain('totally without merit');
  });
});

describe('isDepartureQuestion', () => {
  it('matches leave, disappearance, handover and the last-post questions', () => {
    expect(isDepartureQuestion('Why did you leave Bitcoin?')).toBe(true);
    expect(isDepartureQuestion('why did you disappear')).toBe(true);
    expect(isDepartureQuestion('why did you stop posting')).toBe(true);
    expect(isDepartureQuestion('why did you go away')).toBe(true);
    expect(isDepartureQuestion('why did you walk away')).toBe(true);
    expect(isDepartureQuestion('why did you hand over to Gavin')).toBe(true);
    expect(isDepartureQuestion('what happened to Satoshi')).toBe(true);
    expect(isDepartureQuestion('why did Satoshi leave')).toBe(true);
    expect(isDepartureQuestion("What was Satoshi's last post?")).toBe(true);
    expect(isDepartureQuestion('What was your last email to Mike Hearn?')).toBe(true);
    expect(isDepartureQuestion('Did you step back from Bitcoin?')).toBe(true);
    expect(isDepartureQuestion('Did Satoshi abandon the project?')).toBe(true);
  });

  it('does not match protocol questions that only share a verb or a name', () => {
    expect(isDepartureQuestion('Did you leave the block size unlimited?')).toBe(false);
    expect(isDepartureQuestion('Can you leave the fee at zero?')).toBe(false);
    expect(isDepartureQuestion("How does Gavin's getbalance command work?")).toBe(false);
    expect(isDepartureQuestion('What is OP_CHECKSIG?')).toBe(false);
    expect(isDepartureQuestion('How long does a block take, time wise?')).toBe(false);
    expect(isDepartureQuestion('What was the last block?')).toBe(false);
  });
});

describe('shipped departure record', () => {
  const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'departure-record.json');
  const rec = JSON.parse(readFileSync(file, 'utf8')) as ScalingRecord;

  it('loads from the default data directory', () => {
    const curated = loadCuratedReference();
    expect(curated?.departure?.evidenceText.startsWith('SATOSHI DEPARTURE — DOCUMENTED RECORD AND ATTRIBUTED ACCOUNT')).toBe(
      true,
    );
  });

  it('loads from the fifth path argument alone', () => {
    const curated = loadCuratedReference(undefined, undefined, undefined, undefined, file);
    expect(curated?.departure?.evidenceText).toContain("I've moved on to other things");
    expect(curated?.timecoin).toBeNull();
  });

  it('attributes the account and does not assert foul play', () => {
    expect(rec.evidenceText.startsWith('SATOSHI DEPARTURE — DOCUMENTED RECORD AND ATTRIBUTED ACCOUNT')).toBe(true);
    expect(rec.evidenceText).toContain('Dr Wright has said');
    expect(rec.evidenceText).toContain('mysterious shadowy figure');
    expect(rec.evidenceText).toContain('you must not assert one');
    expect(rec.evidenceText).not.toMatch(/foul play (?:happened|occurred|was involved|caused)/i);
    expect(rec.citations.length).toBeGreaterThan(5);
    for (const c of rec.citations) expect(c.url).toMatch(/^https:\/\//);
  });
});

describe('groundQuestion departure record', () => {
  const DEPARTURE: ScalingRecord = {
    evidenceText: 'SATOSHI DEPARTURE — DOCUMENTED RECORD AND ATTRIBUTED ACCOUNT: the April 2011 emails.',
    citations: [
      {
        label: 'Hearn thread',
        url: 'https://plan99.net/~mike/satoshi-emails/thread5.html',
        excerpt: "I've moved on to other things.",
      },
    ],
  };

  it('prepends the record and stands as reference when nothing else grounds the question', async () => {
    const curated = new CuratedReference([], null, null, null, DEPARTURE);
    const g = await groundQuestion('Why did you leave Bitcoin?', { mcp: thinMcp(), corpus: null, curated });
    expect(g.mode).toBe('reference');
    expect(g.evidenceText.startsWith('SATOSHI DEPARTURE')).toBe(true);
    expect(g.leadAngle).toBeUndefined();
    expect(g.citations.some((c) => c.url?.includes('plan99.net'))).toBe(true);
  });

  it('leaves an unrelated question alone when a departure record is loaded', async () => {
    const curated = new CuratedReference([], null, null, null, DEPARTURE);
    const g = await groundQuestion('zxqwv unrelated gibberish', { mcp: thinMcp(), corpus: null, curated });
    expect(g.mode).toBe('none');
    expect(g.evidenceText).toBe('');
  });
});
