import { describe, expect, it } from 'vitest';
import {
  buildCitationFilter,
  buildSystemPrompt,
  buildUserContent,
  extractKeywords,
  groundQuestion,
  locatorToUrl,
  normaliseEvidence,
  parseCitationFilter,
} from './orchestrate.js';
import { SatoshiCorpus, type CorpusDoc } from './satoshiCorpus.js';
import type { McpBridge } from './mcp.js';

const SPV_DOC: CorpusDoc = {
  id: 'email-cryptography-2',
  kind: 'email',
  title: 'Bitcoin P2P e-cash paper',
  date: '2008-11-03T01:37:43Z',
  url: 'https://satoshi.nakamotoinstitute.org/emails/cryptography/2/',
  text: 'Long before the network gets anywhere near as large as that, it would be safe for users to use Simplified Payment Verification (section 8) to check for double spending, which only requires having the chain of block headers, or about 12KB per day. Only people trying to create new coins would need to run network nodes.',
};

/** Real bsv-aio-mcp@1.1.0 shapes: claims carry status; hits carry locator/excerpt. */
const SUFFICIENT_PKG = {
  question: 'What is BEEF?',
  classified_as: 'spec',
  claims: [
    { text: 'BEEF is defined by BRC-62.', support: ['brc:62'], status: 'supports', confidence: 'high' },
  ],
  hits: [
    {
      id: 'brc:62',
      kind: 'brc',
      authority: 1,
      title: 'BRC-62',
      locator: 'brc://spec/62',
      excerpt: 'Background Evaluation Extended Format (BEEF)…',
    },
  ],
  gaps: [],
  contradictions: [],
  answer_sketch: 'Start with BRC-62.',
};

const INSUFFICIENT_PKG = {
  question: 'unrelated',
  classified_as: 'historical',
  claims: [{ text: '', support: [], status: 'insufficient' }],
  hits: [],
  gaps: ['No snapshot hits were retrieved for this question.'],
  contradictions: [],
};

function fakeMcp(result: unknown): McpBridge {
  return {
    connected: true,
    investigate: async () => result,
    // searchKnowledge / getResource are absent here so the conceptual path is skipped
    // and investigate-driven tests exercise the documented route.
  } as unknown as McpBridge;
}

function failingMcp(): McpBridge {
  return {
    connected: true,
    investigate: async () => {
      throw new Error('MCP_TIMEOUT');
    },
  } as unknown as McpBridge;
}

describe('locatorToUrl', () => {
  it('maps substack essays to singulargrit.substack.com', () => {
    expect(locatorToUrl('csw://essay/substack/set-in-stone-or-sold-to-the-highest')).toBe(
      'https://singulargrit.substack.com/p/set-in-stone-or-sold-to-the-highest',
    );
  });
  it('maps medium essays to the author profile', () => {
    expect(locatorToUrl('csw://essay/medium/open-source-ed8e1066fbbd')).toBe(
      'https://medium.com/@craig_10243/open-source-ed8e1066fbbd',
    );
  });
  it('maps BRC repo paths to GitHub blob URLs', () => {
    expect(locatorToUrl('bsv-blockchain/BRCs/transactions/0062.md')).toBe(
      'https://github.com/bsv-blockchain/BRCs/blob/master/transactions/0062.md',
    );
  });
  it('passes through real http(s) URLs unchanged', () => {
    expect(locatorToUrl('https://example.com/x')).toBe('https://example.com/x');
  });
  it('maps brc://spec/{n} master specs to their GitHub page via the shipped BRC index', () => {
    // BRC-62 is BEEF (transactions/0062.md); BRC-100 is the wallet interface (wallet/0100.md).
    expect(locatorToUrl('brc://spec/62')).toBe(
      'https://github.com/bsv-blockchain/BRCs/blob/master/transactions/0062.md',
    );
    expect(locatorToUrl('brc://spec/100')).toBe(
      'https://github.com/bsv-blockchain/BRCs/blob/master/wallet/0100.md',
    );
  });
  it('returns undefined for brc://spec numbers absent from the pinned index', () => {
    // Far-future BRC not in the snapshot → fail closed, never guess a category.
    expect(locatorToUrl('brc://spec/99999')).toBeUndefined();
  });
  it('returns undefined for internal-only schemes', () => {
    expect(locatorToUrl('essay://medium/123')).toBeUndefined();
    expect(locatorToUrl('csw://principles/nodes')).toBeUndefined();
    expect(locatorToUrl(undefined)).toBeUndefined();
  });
});

describe('citation linkability', () => {
  it('omits citations for sources with no public URL', async () => {
    const g = await groundQuestion('What is the frobnicate opcode?', {
      mcp: fakeMcp({
        claims: [{ text: 'The frobnicate opcode frobs.', support: ['sym:1'], status: 'supports' }],
        hits: [{ id: 'sym:1', locator: 'repo://ts-stack/frob', title: 'frobnicate', excerpt: '…' }],
        gaps: [],
        contradictions: [],
      }),
      corpus: null,
    });
    expect(g.mode).toBe('mcp');
    // repo://ts-stack/... has no public URL → not cited.
    expect(g.citations).toHaveLength(0);
    // …but the claim is still shown to the model as evidence, without a marker.
    expect(g.evidenceText).toContain('The frobnicate opcode frobs.');
    expect(g.evidenceText).not.toMatch(/\[\d+\]/);
  });

  it('cites the BRC master spec for an investigate-grounded BRC answer', async () => {
    // Regression: a conversational BRC question resolves to the master spec (brc://spec/100),
    // which must now be citable rather than silently dropped.
    const g = await groundQuestion('What can you tell me about BRC-100?', {
      mcp: fakeMcp({
        claims: [{ text: 'BRC-100 is the wallet-to-application interface.', support: ['brc:100'], status: 'supports' }],
        hits: [{ id: 'brc:100', locator: 'brc://spec/100', title: 'BRC-100 Wallet Interface', excerpt: '…' }],
        gaps: [],
        contradictions: [],
      }),
      corpus: null,
    });
    expect(g.mode).toBe('mcp');
    expect(g.citations.length).toBeGreaterThan(0);
    expect(g.citations[0]?.url).toBe(
      'https://github.com/bsv-blockchain/BRCs/blob/master/wallet/0100.md',
    );
  });

  it('cites sources that resolve to a real URL', async () => {
    const g = await groundQuestion('open source?', {
      mcp: fakeMcp({
        claims: [{ text: 'I released Bitcoin as open source.', support: ['e:1'], status: 'supports' }],
        hits: [
          {
            id: 'e:1',
            locator: 'csw://essay/medium/open-source-ed8e1066fbbd',
            title: 'Open Source',
            excerpt: '…',
          },
        ],
        gaps: [],
        contradictions: [],
      }),
      corpus: null,
    });
    expect(g.citations).toHaveLength(1);
    expect(g.citations[0]?.url).toBe('https://medium.com/@craig_10243/open-source-ed8e1066fbbd');
    expect(g.evidenceText).toContain('[1]');
  });
});

describe('normaliseEvidence', () => {
  it('treats supported claims as sufficient and resolves support ids to locators', () => {
    const e = normaliseEvidence(SUFFICIENT_PKG);
    expect(e.sufficient).toBe(true);
    expect(e.claims[0]?.text).toBe('BEEF is defined by BRC-62.');
    expect(e.claims[0]?.refs).toEqual(['brc://spec/62']);
    expect(e.excerpts[0]?.ref).toBe('brc://spec/62');
    expect(e.sketch).toBe('Start with BRC-62.');
  });

  it('treats all-insufficient claim sets as not sufficient (fail-closed)', () => {
    const e = normaliseEvidence(INSUFFICIENT_PKG);
    expect(e.sufficient).toBe(false);
    expect(e.gaps).toEqual(['No snapshot hits were retrieved for this question.']);
  });

  it('treats incidental hits without supported claims as not sufficient', () => {
    const e = normaliseEvidence({
      claims: [],
      hits: [{ id: 'brc:1', locator: 'brc://spec/1', excerpt: 'incidental mention' }],
    });
    expect(e.sufficient).toBe(false);
  });

  it('keeps contradicted claims flagged rather than asserting them', () => {
    const e = normaliseEvidence({
      claims: [{ text: 'The limit was always 1MB by design.', support: ['essay:1'], status: 'contradicts' }],
      hits: [{ id: 'essay:1', locator: 'essay://medium/123', excerpt: '…' }],
    });
    expect(e.sufficient).toBe(true);
    expect(e.claims[0]?.contradicts).toBe(true);
  });

  it('degrades gracefully on unexpected shapes', () => {
    expect(normaliseEvidence(null).sufficient).toBe(false);
    expect(normaliseEvidence('nonsense').sufficient).toBe(false);
    expect(normaliseEvidence({ raw: 'plain text' }).sufficient).toBe(false);
  });

  it('keeps padding excerpts on-topic when a question is given', () => {
    // The claim is backed by a Teranode hit; the package also carries an unrelated
    // wallet-onboarding hit. Padding must not pull the unrelated hit into the evidence.
    const pkg = {
      claims: [
        { text: 'Teranode sustained 1M TPS.', support: ['doc:teranode'], status: 'supports' },
      ],
      hits: [
        { id: 'doc:teranode', locator: 'doc:teranode:bench', title: 'Teranode throughput benchmarks', excerpt: 'sustained 1 million TPS' },
        { id: 'brc:137', locator: 'bsv-blockchain/BRCs/wallet/0137.md', title: 'Device-Aware Wallet Onboarding', excerpt: 'wallet login fallback' },
      ],
    };
    const e = normaliseEvidence(pkg, 'how do I scale bitcoin for more transactions per second?');
    expect(e.excerpts.some((x) => x.ref === 'doc:teranode:bench')).toBe(true);
    expect(e.excerpts.some((x) => x.ref === 'bsv-blockchain/BRCs/wallet/0137.md')).toBe(false);
  });

  it('pads freely when no question is supplied (back-compat)', () => {
    const pkg = {
      claims: [{ text: 'X.', support: ['a'], status: 'supports' }],
      hits: [
        { id: 'a', locator: 'brc://spec/1', excerpt: 'one' },
        { id: 'b', locator: 'brc://spec/2', excerpt: 'two' },
      ],
    };
    const e = normaliseEvidence(pkg);
    expect(e.excerpts.length).toBe(2);
  });
});

describe('groundQuestion routing', () => {
  it('routes to the MCP when evidence is sufficient', async () => {
    const g = await groundQuestion('What is BEEF?', {
      mcp: fakeMcp(SUFFICIENT_PKG),
      corpus: new SatoshiCorpus([SPV_DOC]),
    });
    expect(g.mode).toBe('mcp');
    expect(g.evidenceText).toContain('BRC-62');
    // brc://spec/62 now resolves to the BEEF spec on GitHub via the BRC index.
    expect(g.citations[0]?.url).toBe(
      'https://github.com/bsv-blockchain/BRCs/blob/master/transactions/0062.md',
    );
  });

  it('cites a linkable BRC repo path using its title', async () => {
    const g = await groundQuestion('What is BEEF?', {
      mcp: fakeMcp({
        ...SUFFICIENT_PKG,
        hits: [
          {
            id: 'brc:62',
            locator: 'bsv-blockchain/BRCs/transactions/0062.md',
            title: 'BRC-62',
            excerpt: '…',
          },
        ],
      }),
      corpus: null,
    });
    expect(g.citations[0]?.label).toBe('BRC-62');
    expect(g.citations[0]?.url).toBe(
      'https://github.com/bsv-blockchain/BRCs/blob/master/transactions/0062.md',
    );
  });

  it('falls back to the Satoshi corpus when the MCP is insufficient', async () => {
    const g = await groundQuestion('What is Simplified Payment Verification?', {
      mcp: fakeMcp(INSUFFICIENT_PKG),
      corpus: new SatoshiCorpus([SPV_DOC]),
    });
    expect(g.mode).toBe('corpus');
    expect(g.evidenceText).toContain('Simplified Payment Verification');
    expect(g.citations[0]?.url).toContain('satoshi.nakamotoinstitute.org');
  });

  it('formats Quoted remarks with a date and quotation marks around the excerpt', async () => {
    const quoteDoc: CorpusDoc = {
      id: 'quote-spv',
      kind: 'quote',
      title: 'Quoted remark',
      date: '2010-06-18',
      url: 'https://satoshi.nakamotoinstitute.org/quotes/',
      text: 'Simplified Payment Verification is for lightweight client-only users who only do transactions.',
    };
    const g = await groundQuestion('Simplified Payment Verification lightweight clients', {
      mcp: fakeMcp(INSUFFICIENT_PKG),
      corpus: new SatoshiCorpus([quoteDoc]),
    });
    expect(g.mode).toBe('corpus');
    expect(g.citations[0]?.title).toBe('A historical quote from Satoshi');
    expect(g.citations[0]?.date).toBe('2010-06-18');
    expect(g.citations[0]?.excerpt).toBe(
      '"Simplified Payment Verification is for lightweight client-only users who only do transactions."',
    );
  });

  it('falls back to the corpus when the MCP throws', async () => {
    const g = await groundQuestion('What is Simplified Payment Verification?', {
      mcp: failingMcp(),
      corpus: new SatoshiCorpus([SPV_DOC]),
    });
    expect(g.mode).toBe('corpus');
  });

  it('fails closed with mode none when neither source can answer', async () => {
    const g = await groundQuestion('zxqwv unrelated gibberish', {
      mcp: fakeMcp(INSUFFICIENT_PKG),
      corpus: new SatoshiCorpus([SPV_DOC]),
    });
    expect(g.mode).toBe('none');
  });

  it('works with no MCP and no corpus at all', async () => {
    const g = await groundQuestion('anything', { mcp: null, corpus: null });
    expect(g.mode).toBe('none');
  });
});

describe('conceptual blend (searchGrounding)', () => {
  /** MCP stub that serves search_knowledge by kind filter and get_resource bodies. */
  function blendingMcp(): McpBridge {
    const bodies: Record<string, string> = {
      'csw://essay/medium/scaling': 'I have argued for years that Bitcoin must scale on-chain to reach the world.',
      'bsv-blockchain/BRCs/transactions/0062.md': 'BRC-62 defines Background Evaluation Extended Format (BEEF) for SPV proofs.',
    };
    return {
      connected: true,
      investigate: async () => INSUFFICIENT_PKG,
      searchKnowledge: async (_q: string, filters?: { kind?: string[] }) => {
        const kinds = filters?.kind ?? [];
        const hits: unknown[] = [];
        if (kinds.includes('essay')) {
          hits.push({ id: 'e:1', kind: 'essay', title: 'Scaling Bitcoin', locator: 'csw://essay/medium/scaling' });
        }
        if (kinds.includes('brc') || kinds.includes('doc')) {
          hits.push({ id: 'b:62', kind: 'brc', title: 'BRC-62', locator: 'bsv-blockchain/BRCs/transactions/0062.md' });
        }
        return { hits };
      },
      getResource: async (uri: string) => ({ text: bodies[uri] }),
    } as unknown as McpBridge;
  }

  it('blends Satoshi primary, technical spec, and essays for a conceptual question', async () => {
    // SPV_DOC is about Simplified Payment Verification, so ask a "why" question about it.
    const g = await groundQuestion('Why did you design Simplified Payment Verification?', {
      mcp: blendingMcp(),
      corpus: new SatoshiCorpus([SPV_DOC]),
    });
    expect(g.mode).toBe('mcp');
    // All three tiers present in the evidence.
    expect(g.evidenceText).toContain('PRIMARY SOURCES');
    expect(g.evidenceText).toContain('TECHNICAL SPECIFICATION');
    expect(g.evidenceText).toContain('LATER COMMENTARY');
    expect(g.evidenceText).toContain('Simplified Payment Verification'); // Satoshi primary
    expect(g.evidenceText).toContain('BRC-62'); // technical
    expect(g.evidenceText).toContain('scale on-chain'); // essay
    // Citations carry the right provenance chips, primary numbered first.
    const classes = g.citations.map((c) => c.sourceClass);
    expect(classes).toContain('satoshi-primary');
    expect(classes).toContain('spec');
    expect(classes).toContain('later-commentary');
    expect(classes[0]).toBe('satoshi-primary');
  });

  it('surfaces technical spec data even when no essay matches', async () => {
    const mcp = blendingMcp();
    // Remove essay results by making the essay kind return nothing.
    mcp.searchKnowledge = (async (_q: string, filters?: { kind?: string[] }) => {
      if (filters?.kind?.includes('essay')) return { hits: [] };
      return { hits: [{ id: 'b:62', kind: 'brc', title: 'BRC-62', locator: 'bsv-blockchain/BRCs/transactions/0062.md' }] };
    }) as McpBridge['searchKnowledge'];
    const g = await groundQuestion('Why did you design SPV proofs?', { mcp, corpus: null });
    expect(g.mode).toBe('mcp');
    expect(g.evidenceText).toContain('TECHNICAL SPECIFICATION');
    expect(g.evidenceText).toContain('BRC-62');
    expect(g.evidenceText).not.toContain('LATER COMMENTARY');
  });
});

describe('prompt construction', () => {
  it('sends the latest question raw; evidence lives in the system prompt', () => {
    const grounding = {
      mode: 'mcp' as const,
      evidenceText: '[1] BEEF is defined by BRC-62.',
      citations: [{ label: 'brc://spec/62' }],
    };
    // User content is the bare question (so follow-ups are not buried under evidence).
    expect(buildUserContent('What is BEEF?', grounding)).toBe('What is BEEF?');
    // Evidence is carried by the system prompt instead.
    const sys = buildSystemPrompt('mcp', grounding);
    expect(sys).toContain('EVIDENCE');
    expect(sys).toContain('BEEF is defined by BRC-62.');
    expect(sys).toMatch(/Answer ONLY the latest user message/);
  });

  it('corpus mode tells the model the evidence is Satoshi’s own writing', () => {
    expect(buildSystemPrompt('corpus')).toMatch(/historical forum posts and e-mails/);
    expect(buildSystemPrompt('mcp')).toMatch(/pinned snapshot/);
  });
});

describe('extractKeywords', () => {
  it('pulls a BRC identifier out of a conversational question', () => {
    expect(extractKeywords('What can you tell me about BRC-100s?')).toBe('BRC-100');
    expect(extractKeywords('What is BRC-100?')).toBe('BRC-100');
    expect(extractKeywords('explain BRC-62 please')).toBe('BRC-62');
  });

  it('normalises plural BRC references to the singular spec id', () => {
    expect(extractKeywords('What are BRC-100s used for?')).toBe('BRC-100');
    // A bare "BRCs" has no numeric id, so it falls through to content words.
    expect(extractKeywords('tell me about the BRCs')).toBe('BRCs');
  });

  it('keeps opcode and coined technical terms', () => {
    expect(extractKeywords('How does OP_CHECKSIG work?')).toBe('OP_CHECKSIG');
    expect(extractKeywords('What is BEEF?')).toBe('BEEF');
  });

  it('strips the conversational wrapper when no identifier is present', () => {
    const kw = extractKeywords('Was the block size always meant to be small?');
    expect(kw).toBeDefined();
    expect(kw).not.toMatch(/\b(was|the|to|be)\b/i);
    expect(kw).toContain('block');
  });

  it('returns undefined for a question with no content words', () => {
    expect(extractKeywords('what is it?')).toBeUndefined();
  });
});

describe('citation relevance filter', () => {
  const CITES = [
    { label: 'a', title: 'New icon/logo', url: 'https://x/1', excerpt: 'Full size 530x529 image for scaling down to custom sizes', sourceClass: 'satoshi-primary' as const },
    { label: 'b', title: 'The myths of Bitcoin', url: 'https://x/2', excerpt: 'Bitcoin can scale to terabyte size blocks today', sourceClass: 'spec' as const },
  ];

  it('builds no filter request for fewer than two citations', () => {
    expect(buildCitationFilter('q', [CITES[0]!])).toBeUndefined();
    expect(buildCitationFilter('q', [])).toBeUndefined();
  });

  it('builds a filter request listing each candidate with its excerpt', () => {
    const req = buildCitationFilter('What is the importance of scaling?', CITES);
    expect(req).toBeDefined();
    expect(req!.userContent).toContain('What is the importance of scaling?');
    expect(req!.userContent).toContain('[1] New icon/logo');
    expect(req!.userContent).toContain('[2] The myths of Bitcoin');
    expect(req!.system).toMatch(/strict relevance filter/i);
  });

  it('parses a bare numeric list into 0-based indices', () => {
    expect(parseCitationFilter('1, 3', 5)).toEqual([0, 2]);
    expect(parseCitationFilter('2', 5)).toEqual([1]);
    expect(parseCitationFilter('2, 2, 4.', 5)).toEqual([1, 3]);
  });

  it('treats "none" as an explicit all-rejected', () => {
    expect(parseCitationFilter('none', 3)).toEqual([]);
    expect(parseCitationFilter('None of these.', 3)).toEqual([]);
  });

  it('returns undefined for prose so the caller fails open', () => {
    expect(parseCitationFilter('Sources 1 and 3 are relevant', 5)).toBeUndefined();
    expect(parseCitationFilter('', 5)).toBeUndefined();
  });

  it('drops out-of-range indices', () => {
    expect(parseCitationFilter('1, 9', 3)).toEqual([0]);
  });
});
