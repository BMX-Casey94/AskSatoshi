import { describe, expect, it } from 'vitest';
import {
  buildCitationFilter,
  buildSystemPrompt,
  buildUserContent,
  extractKeywords,
  filterUnusedCitations,
  groundQuestion,
  locatorToUrl,
  normaliseEvidence,
  parseCitationFilter,
} from './orchestrate.js';
import { SatoshiCorpus, type CorpusDoc } from './satoshiCorpus.js';
import { CuratedReference } from './curatedReference.js';
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
  it('maps principles (education/{era}--{slug}.md) to the same public essay URLs', () => {
    expect(locatorToUrl('education/substack--the-quantum-apocalypse-is-coming.md')).toBe(
      'https://singulargrit.substack.com/p/the-quantum-apocalypse-is-coming',
    );
    expect(locatorToUrl('education/medium--what-is-bitcoin-8ee9d3e86674.md')).toBe(
      'https://medium.com/@craig_10243/what-is-bitcoin-8ee9d3e86674',
    );
  });
  it('maps repo:// docs and examples to GitHub blob URLs via the shipped registry', () => {
    expect(locatorToUrl('repo://go-sdk/docs/concepts/OP.md')).toBe(
      'https://github.com/bsv-blockchain/go-sdk/blob/master/docs/concepts/OP.md',
    );
  });
  it('maps repo:// for runar (absent from the registry) to its known home', () => {
    expect(locatorToUrl('repo://runar/examples/end2end-example/webapp-blackjack/blackjack.go')).toBe(
      'https://github.com/icellan/runar/blob/master/examples/end2end-example/webapp-blackjack/blackjack.go',
    );
  });
  it('returns undefined for repo:// names absent from the registry', () => {
    expect(locatorToUrl('repo://no-such-repo/README.md')).toBeUndefined();
  });
  it('maps code symbols ({owner}/{repo}/{path}:{line}) to GitHub blob URLs with a line anchor', () => {
    expect(locatorToUrl('bsv-blockchain/go-sdk/transaction/transaction.go:20')).toBe(
      'https://github.com/bsv-blockchain/go-sdk/blob/master/transaction/transaction.go#L20',
    );
  });
  it('keeps the dedicated BRCs-path mapping ahead of the generic symbol rule', () => {
    // bsv-blockchain/BRCs/... also matches the symbol shape; the BRCs rule must win.
    expect(locatorToUrl('bsv-blockchain/BRCs/scripts/0047.md')).toBe(
      'https://github.com/bsv-blockchain/BRCs/blob/master/scripts/0047.md',
    );
  });
  it('returns undefined for internal-only schemes', () => {
    expect(locatorToUrl('essay://medium/123')).toBeUndefined();
    expect(locatorToUrl('csw://principles/nodes')).toBeUndefined();
    expect(locatorToUrl('csw://contradictions/XT-15')).toBeUndefined();
    expect(locatorToUrl('vector://bsv-tx/1-in-1-out.json')).toBeUndefined();
    expect(locatorToUrl(undefined)).toBeUndefined();
  });
});

describe('citation linkability', () => {
  it('omits citations for sources with no public URL', async () => {
    const g = await groundQuestion('What is the frobnicate opcode?', {
      mcp: fakeMcp({
        claims: [{ text: 'The frobnicate opcode frobs.', support: ['sym:1'], status: 'supports' }],
        hits: [{ id: 'sym:1', locator: 'vector://bsv-tx/frob.json', title: 'frobnicate', excerpt: '…' }],
        gaps: [],
        contradictions: [],
      }),
      corpus: null,
    });
    expect(g.mode).toBe('mcp');
    // vector://... is an internal conformance fixture with no public URL → not cited.
    expect(g.citations).toHaveLength(0);
    // …but the claim is still shown to the model as evidence, without a marker.
    expect(g.evidenceText).toContain('The frobnicate opcode frobs.');
    expect(g.evidenceText).not.toMatch(/\[\d+\]/);
  });

  it('cites a document once when two hits resolve to the same URL', async () => {
    // The same essay surfaced under both its csw://essay and education/ locators.
    const g = await groundQuestion('What is the frobnicate opcode?', {
      mcp: fakeMcp({
        claims: [
          { text: 'The frobnicate opcode frobs.', support: ['h:1'], status: 'supports' },
          { text: 'It frobs thoroughly.', support: ['h:2'], status: 'supports' },
        ],
        hits: [
          { id: 'h:1', locator: 'csw://essay/substack/on-frobnicate', title: 'On Frobnicate', excerpt: '…' },
          { id: 'h:2', locator: 'education/substack--on-frobnicate.md', title: 'On Frobnicate', excerpt: '…' },
        ],
        gaps: [],
        contradictions: [],
      }),
      corpus: null,
    });
    expect(g.mode).toBe('mcp');
    expect(g.citations).toHaveLength(1);
    expect(g.citations[0]?.url).toBe('https://singulargrit.substack.com/p/on-frobnicate');
    // Both claims reference the single shared source, not [1] and [2].
    expect(g.evidenceText).toContain('[1] The frobnicate opcode frobs.');
    expect(g.evidenceText).toContain('[1] It frobs thoroughly.');
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

  it('cites a corpus URL once when a post and a quote share it', async () => {
    const quoteSameUrl: CorpusDoc = {
      id: 'quote-spv-same-url',
      kind: 'quote',
      title: 'Quoted remark',
      date: '2008-11-03',
      url: SPV_DOC.url,
      text: 'Simplified Payment Verification only requires the chain of block headers.',
    };
    const g = await groundQuestion('What is Simplified Payment Verification?', {
      mcp: fakeMcp(INSUFFICIENT_PKG),
      corpus: new SatoshiCorpus([SPV_DOC, quoteSameUrl]),
    });
    expect(g.mode).toBe('corpus');
    const urls = g.citations.map((c) => c.url);
    expect(new Set(urls).size).toBe(urls.length);
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

  it('blends essays, technical spec, and Satoshi primary for a conceptual question — essays first', async () => {
    // SPV_DOC is about Simplified Payment Verification, so ask a "why" question about it.
    const g = await groundQuestion('Why did you design Simplified Payment Verification?', {
      mcp: blendingMcp(),
      corpus: new SatoshiCorpus([SPV_DOC]),
    });
    expect(g.mode).toBe('mcp');
    // All three tiers present in the evidence, commentary ahead of the early record.
    expect(g.evidenceText).toContain('PRIMARY SOURCES');
    expect(g.evidenceText).toContain('TECHNICAL SPECIFICATION');
    expect(g.evidenceText).toContain('LATER COMMENTARY');
    expect(g.evidenceText.indexOf('LATER COMMENTARY')).toBeLessThan(g.evidenceText.indexOf('PRIMARY SOURCES'));
    expect(g.evidenceText).toContain('Simplified Payment Verification'); // Satoshi primary
    expect(g.evidenceText).toContain('BRC-62'); // technical
    expect(g.evidenceText).toContain('scale on-chain'); // essay
    // Citations carry the right provenance chips, essays numbered first.
    const classes = g.citations.map((c) => c.sourceClass);
    expect(classes).toContain('satoshi-primary');
    expect(classes).toContain('spec');
    expect(classes).toContain('later-commentary');
    expect(classes[0]).toBe('later-commentary');
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

  it('cites an essay once when it surfaces under both essay and principle locators', async () => {
    const mcp = blendingMcp();
    mcp.searchKnowledge = (async (_q: string, filters?: { kind?: string[] }) => {
      if (filters?.kind?.includes('essay')) {
        return {
          hits: [
            { id: 'e:1', kind: 'essay', title: 'Scaling Bitcoin', locator: 'csw://essay/medium/scaling' },
            { id: 'p:1', kind: 'principle', title: 'Scaling Bitcoin', locator: 'education/medium--scaling.md' },
          ],
        };
      }
      return { hits: [] };
    }) as McpBridge['searchKnowledge'];
    const g = await groundQuestion('Why did you design SPV proofs?', { mcp, corpus: null });
    expect(g.mode).toBe('mcp');
    // Both locators resolve to the same Medium essay → a single later-commentary citation.
    const commentary = g.citations.filter((c) => c.sourceClass === 'later-commentary');
    expect(commentary).toHaveLength(1);
    expect(commentary[0]?.url).toBe('https://medium.com/@craig_10243/scaling');
  });

  it('admits internal curated cards as model-facing evidence without citing them', async () => {
    // The scaling-history card (analysis://…) has no public URL: it must still reach the
    // model on a hijack question, but never appear as a source.
    const mcp = blendingMcp();
    mcp.searchKnowledge = (async (_q: string, filters?: { kind?: string[] }) => {
      if (filters?.kind?.includes('doc')) {
        return {
          hits: [
            {
              id: 'analysis:bitcoin-scaling-history',
              kind: 'doc',
              title: "Bitcoin's 2014–2017 direction change",
              locator: 'analysis://bitcoin-scaling-history',
              excerpt: 'How Bitcoin was hijacked from peer-to-peer electronic cash.',
            },
          ],
        };
      }
      return { hits: [] };
    }) as McpBridge['searchKnowledge'];
    mcp.getResource = (async () => ({
      text: 'The documented record of the scaling wars, with epistemic status attached.',
    })) as McpBridge['getResource'];
    const g = await groundQuestion('Why was Bitcoin hijacked?', { mcp, corpus: null });
    expect(g.mode).toBe('mcp');
    // The card's body reaches the model as evidence…
    expect(g.evidenceText).toContain('documented record of the scaling wars');
    // …but with no public URL it is never cited, and carries no [n] marker.
    expect(g.citations).toHaveLength(0);
    expect(g.evidenceText).not.toMatch(/\[\d+\]/);
  });

  it('does not admit unrelated internal cards that share no term with the question', async () => {
    const mcp = blendingMcp();
    mcp.searchKnowledge = (async (_q: string, filters?: { kind?: string[] }) => {
      if (filters?.kind?.includes('doc')) {
        return {
          hits: [
            {
              id: 'ops:testnet',
              kind: 'doc',
              title: 'Testnet operations playbook',
              locator: 'ops://testnet',
              excerpt: 'Faucets, explorers and mempool policy on testnet.',
            },
          ],
        };
      }
      return { hits: [] };
    }) as McpBridge['searchKnowledge'];
    const g = await groundQuestion('Why was Bitcoin hijacked?', { mcp, corpus: null });
    // No linkable hits and the internal card is off-topic → the blend fails closed.
    expect(g.mode).not.toBe('mcp');
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

  it('trims the evidence block to the given budget, keeping the head', () => {
    const grounding = {
      mode: 'mcp' as const,
      evidenceText: 'A'.repeat(100) + 'B'.repeat(100),
      citations: [],
    };
    const full = buildSystemPrompt('mcp', grounding);
    expect(full).toContain('A'.repeat(100) + 'B'.repeat(100));
    const trimmed = buildSystemPrompt('mcp', grounding, { evidenceChars: 120 });
    expect(trimmed).toContain('A'.repeat(100));
    expect(trimmed).not.toContain('B'.repeat(100));
    expect(trimmed).toMatch(/…/);
  });

  it('keeps the identity answer mysterious — breadcrumbs, never a candidate’s name', () => {
    const sys = buildSystemPrompt('mcp');
    expect(sys).toMatch(/never confirm, never deny/);
    expect(sys).toMatch(/patent portfolio/);
    expect(sys).toMatch(/private signing sessions/);
    expect(sys).toMatch(/sworn testimony/);
  });

  it('rejects keys-as-proof: possession of a key is not identity', () => {
    const sys = buildSystemPrompt('mcp');
    expect(sys).toMatch(/KEYS ARE NOT PROOF/);
    expect(sys).toMatch(/Possession of a key proves possession only/);
    expect(sys).toMatch(/copied, shared, stolen or coerced/);
  });

  it('scales answer length to the question and offers a sparing follow-up invitation', () => {
    const sys = buildSystemPrompt('mcp');
    expect(sys).toMatch(/Match the length to the question/);
    expect(sys).toMatch(/up to roughly 1,200 words/);
    expect(sys).toMatch(/FOLLOW-UP INVITATION/);
    expect(sys).toMatch(/never on a conversational message/);
  });

  it('forbids inventing acronym expansions the evidence does not give', () => {
    const sys = buildSystemPrompt('mcp');
    expect(sys).toMatch(/expanded exactly as the EVIDENCE expands them/);
    expect(sys).toMatch(/[Nn]ever invent or guess an acronym/);
  });

  it('forbids Taproot, SegWit and Lightning as implementation advice', () => {
    const sys = buildSystemPrompt('mcp');
    expect(sys).toMatch(/IMPLEMENTATION ADVICE IS BSV-ONLY/);
    expect(sys).toMatch(/Never recommend, prescribe or assume as something to implement: Taproot, SegWit, Lightning/);
    expect(sys).toMatch(/BRC-100/);
    expect(sys).toMatch(/BitGenius\.net/);
  });

  it('treats the later essays as the primary lens, with the early record in support', async () => {
    // The viewpoint framing is generated by the conceptual blend, so exercise it end to end.
    const mcp = {
      connected: true,
      investigate: async () => INSUFFICIENT_PKG,
      searchKnowledge: async (_q: string, filters?: { kind?: string[] }) => ({
        hits: filters?.kind?.includes('essay')
          ? [{ id: 'e:1', kind: 'essay', title: 'Scaling Bitcoin', locator: 'csw://essay/medium/scaling' }]
          : [],
      }),
      getResource: async () => ({ text: 'Bitcoin must scale on-chain.' }),
    } as unknown as McpBridge;
    const g = await groundQuestion('Why did you design SPV proofs?', { mcp, corpus: null });
    expect(g.evidenceText).toMatch(/primary lens/);
    expect(g.evidenceText).toMatch(/most sustained continuation of your design/);
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

  it('splits slash-joined acronyms and expands known ecosystem terms', () => {
    const kw = extractKeywords('Is that comparable to NAR/DAR? Please help me compare the two.');
    expect(kw).toBeDefined();
    expect(kw).toContain('NAR');
    expect(kw).toContain('DAR');
    expect(kw).toContain('Network Access Rules');
    expect(kw).toContain('Digital Asset Recovery');
  });

  it('drops comparison framing words, keeping the subject', () => {
    const kw = extractKeywords('How does the alert key compare to multisig?');
    expect(kw).toBeDefined();
    expect(kw).toContain('alert');
    expect(kw).toContain('multisig');
    expect(kw).not.toMatch(/\b(compare|comparable|comparison|help|versus|vs)\b/i);
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

  it('requires a source to offer a specific claim, not just a shared topic', () => {
    const req = buildCitationFilter('q', CITES);
    expect(req!.system).toMatch(/specific claim/i);
  });
});

describe('citation usage floor', () => {
  const GAVIN_EMAIL = {
    label: 'email',
    title: 'Re: Bitcoin and Wikileaks',
    url: 'https://x/email',
    excerpt:
      'I wish you would not keep talking about me as a mysterious shadowy figure, the press just turns that into a pirate currency angle. Maybe instead make it about the open source project and give more credit to your dev contributors; it helps motivate them.',
    sourceClass: 'satoshi-primary' as const,
  };
  const RUNAR_SPEC = {
    label: 'spec',
    title: 'runar-lang README',
    url: 'https://x/runar',
    excerpt:
      'Rúnar is a TypeScript embedded DSL for writing sCrypt-style spending contracts, with compiler targets and package installation instructions.',
    sourceClass: 'spec' as const,
  };
  const ANSWER =
    'In early 2011 I sent my final message to Gavin Andresen, asking him to stop portraying me as a mysterious shadowy figure because the press was turning it into a pirate currency angle. I urged him to give more credit to the dev contributors, then stepped back.';

  it('drops a citation whose content the answer never reflects', () => {
    const kept = filterUnusedCitations(ANSWER, [GAVIN_EMAIL, RUNAR_SPEC]);
    expect(kept.map((c) => c.label)).toEqual(['email']);
  });

  it('keeps every citation the answer draws on', () => {
    const answer =
      'The alert key let a single trusted party broadcast signed emergency warnings; Rúnar is a TypeScript embedded DSL for spending contracts.';
    const alertPost = {
      label: 'alert',
      title: 'Alert system',
      url: 'https://x/alert',
      excerpt: 'The alert key lets one trusted party broadcast signed emergency warnings to every node.',
      sourceClass: 'satoshi-primary' as const,
    };
    const kept = filterUnusedCitations(answer, [alertPost, RUNAR_SPEC]);
    expect(kept.map((c) => c.label)).toEqual(['alert', 'spec']);
  });

  it('fails open when no citation shows usage — a grounded answer drew on something', () => {
    const paraphrased = 'I departed because the project needed to stand on its own merits.';
    const kept = filterUnusedCitations(paraphrased, [GAVIN_EMAIL, RUNAR_SPEC]);
    expect(kept).toHaveLength(2);
  });

  it('returns the input unchanged for fewer than two citations or an empty answer', () => {
    expect(filterUnusedCitations(ANSWER, [GAVIN_EMAIL])).toEqual([GAVIN_EMAIL]);
    expect(filterUnusedCitations('', [GAVIN_EMAIL, RUNAR_SPEC])).toHaveLength(2);
  });

  it('treats a shared distinctive phrase as usage even when single tokens are common', () => {
    const essay = {
      label: 'essay',
      title: 'Governance essay',
      url: 'https://x/nar',
      excerpt: 'Network access rules define who may transact, under court-order mechanics.',
      sourceClass: 'later-commentary' as const,
    };
    const answer = 'Network access rules are a governance layer, not a base-protocol change.';
    const kept = filterUnusedCitations(answer, [essay, RUNAR_SPEC]);
    expect(kept.map((c) => c.label)).toEqual(['essay']);
  });

  it('does not count domain-common words as usage', () => {
    const generic = {
      label: 'generic',
      title: 'Bitcoin network overview',
      url: 'https://x/gen',
      excerpt: 'The Bitcoin network processes transactions through nodes on the blockchain.',
      sourceClass: 'historical-record' as const,
    };
    const kept = filterUnusedCitations(ANSWER, [GAVIN_EMAIL, generic]);
    expect(kept.map((c) => c.label)).toEqual(['email']);
  });

  it('matches case-insensitively', () => {
    const lower = ANSWER.toLowerCase();
    const kept = filterUnusedCitations(lower, [GAVIN_EMAIL, RUNAR_SPEC]);
    expect(kept.map((c) => c.label)).toEqual(['email']);
  });
});

describe('retrieval plan (query understanding)', () => {
  it('classifies on the original question while retrieving with the rewritten query', async () => {
    const calls = { search: 0, investigate: [] as string[] };
    const mcp = {
      connected: true,
      investigate: async (q: string) => {
        calls.investigate.push(q);
        return INSUFFICIENT_PKG;
      },
      searchKnowledge: async () => {
        calls.search += 1;
        return { hits: [] };
      },
      getResource: async () => ({ text: undefined }),
    } as unknown as McpBridge;
    // The rewritten query carries no conceptual cue word ("why"); only the original does.
    await groundQuestion(
      'Satoshi withdrew from public view disillusioned 2010 2011',
      { mcp, corpus: null },
      { originalQuestion: 'Why did you leave Bitcoin and move onto other things?' },
    );
    // The conceptual blend (searchKnowledge) ran first…
    expect(calls.search).toBeGreaterThan(0);
    // …and the investigate fallback received the rewritten query, not the raw question.
    expect(calls.investigate[0]).toBe('Satoshi withdrew from public view disillusioned 2010 2011');
  });

  it('tries the rewritten query, then variants, before concluding there is no evidence', async () => {
    const tried: string[] = [];
    const mcp = {
      connected: true,
      investigate: async (q: string) => {
        tried.push(q);
        return q === 'alert key emergency broadcast' ? SUFFICIENT_PKG : INSUFFICIENT_PKG;
      },
    } as unknown as McpBridge;
    const g = await groundQuestion('alert system network-wide warning', { mcp, corpus: null }, {
      variants: ['alert key emergency broadcast', 'alert key safe mode RPC'],
    });
    expect(tried).toEqual(['alert system network-wide warning', 'alert key emergency broadcast']);
    expect(g.mode).toBe('mcp');
  });

  it('keeps the question-then-keywords attempt order when no plan is supplied', async () => {
    const tried: string[] = [];
    const mcp = {
      connected: true,
      investigate: async (q: string) => {
        tried.push(q);
        return INSUFFICIENT_PKG;
      },
    } as unknown as McpBridge;
    await groundQuestion('What is the frobnicate opcode?', { mcp, corpus: null });
    expect(tried).toEqual(['What is the frobnicate opcode?', 'frobnicate opcode']);
  });

  it('passes conversation context through to investigate when the plan carries it', async () => {
    const seen: { q: string; ctx?: string }[] = [];
    const mcp = {
      connected: true,
      investigate: async (q: string, ctx?: string) => {
        seen.push({ q, ctx });
        return SUFFICIENT_PKG;
      },
    } as unknown as McpBridge;
    await groundQuestion('What is BEEF?', { mcp, corpus: null }, { context: 'Tell me about SPV proofs' });
    expect(seen[0]).toEqual({ q: 'What is BEEF?', ctx: 'Tell me about SPV proofs' });
  });

  it('searches each rewrite variant and merges the hits, citing a shared URL once', async () => {
    const queries: string[] = [];
    const mcp = {
      connected: true,
      investigate: async () => INSUFFICIENT_PKG,
      searchKnowledge: async (q: string, filters?: { kind?: string[] }) => {
        queries.push(q);
        if (!filters?.kind?.includes('essay')) return { hits: [] };
        if (q.includes('withdrew')) {
          return {
            hits: [
              { id: 'e:1', kind: 'essay', title: 'The myth of forks', locator: 'csw://essay/medium/the-myth-of-forks-be04f8e5fe4a' },
            ],
          };
        }
        if (q.includes('departure')) {
          return {
            hits: [
              { id: 'e:2', kind: 'principle', title: 'The myth of forks', locator: 'education/medium--the-myth-of-forks-be04f8e5fe4a.md' },
            ],
          };
        }
        return { hits: [] };
      },
      getResource: async () => ({ text: 'I removed myself from public view, rather disillusioned.' }),
    } as unknown as McpBridge;
    const g = await groundQuestion('Why did you leave Bitcoin?', { mcp, corpus: null }, {
      variants: ['Satoshi departure 2010 2011', 'withdrew from public view disillusioned'],
    });
    // Both variants were issued to the essay tier.
    expect(queries).toContain('Satoshi departure 2010 2011');
    expect(queries).toContain('withdrew from public view disillusioned');
    // The same essay surfaced under two locators resolves to a single citation.
    const commentary = g.citations.filter((c) => c.sourceClass === 'later-commentary');
    expect(commentary).toHaveLength(1);
    expect(commentary[0]?.url).toBe('https://medium.com/@craig_10243/the-myth-of-forks-be04f8e5fe4a');
    expect(g.evidenceText).toContain('removed myself from public view');
  });

  it('interleaves per-query hits so a noisy phrasing cannot crowd out a precise variant', async () => {
    const mcp = {
      connected: true,
      investigate: async () => INSUFFICIENT_PKG,
      searchKnowledge: async (q: string, filters?: { kind?: string[] }) => {
        if (!filters?.kind?.includes('essay')) return { hits: [] };
        // The main query returns four plausible-but-off-topic essays (filling the tier cap)…
        if (q.includes('leave')) {
          return {
            hits: [1, 2, 3, 4].map((i) => ({
              id: `n:${i}`,
              kind: 'essay',
              title: `Noise essay ${i}`,
              locator: `csw://essay/medium/noise-${i}`,
            })),
          };
        }
        // …whilst the variant returns the one essay that actually answers the question.
        if (q.includes('withdrew')) {
          return {
            hits: [
              { id: 'e:1', kind: 'essay', title: 'The myth of forks', locator: 'csw://essay/medium/the-myth-of-forks-be04f8e5fe4a' },
            ],
          };
        }
        return { hits: [] };
      },
      getResource: async () => ({ text: 'I removed myself from public view, rather disillusioned.' }),
    } as unknown as McpBridge;
    const g = await groundQuestion('Why did you leave Bitcoin?', { mcp, corpus: null }, {
      variants: ['withdrew from public view disillusioned'],
    });
    const urls = g.citations.map((c) => c.url);
    // The variant's hit survives alongside the main query's hits — not crowded out at rank 5.
    expect(urls).toContain('https://medium.com/@craig_10243/the-myth-of-forks-be04f8e5fe4a');
    expect(urls.filter((u) => u?.includes('noise-')).length).toBeGreaterThan(0);
  });

  it('searches every kind the MCP indexes, so no section of the knowledge base is filtered out', async () => {
    const kindSets: string[][] = [];
    const mcp = {
      connected: true,
      investigate: async () => INSUFFICIENT_PKG,
      searchKnowledge: async (_q: string, filters?: { kind?: string[] }) => {
        kindSets.push(filters?.kind ?? []);
        return { hits: [] };
      },
      getResource: async () => ({ text: undefined }),
    } as unknown as McpBridge;
    await groundQuestion('Why was Bitcoin hijacked?', { mcp, corpus: null });
    const searched = new Set(kindSets.flat());
    for (const kind of [
      'brc', 'symbol', 'test', 'example', 'doc', 'essay',
      'principle', 'wiki', 'web', 'live', 'contradiction', 'capability',
    ]) {
      expect(searched).toContain(kind);
    }
    // Two tiers × two passes (keywords, then the raw-phrasing retry when all tiers miss).
    // The memoised blend must NOT fan out again after investigate also comes up empty —
    // without that guard this would be 8.
    expect(kindSets).toHaveLength(4);
  });

  it('admits corpus contradiction findings as evidence-only entries, never cited', async () => {
    const mcp = {
      connected: true,
      investigate: async () => INSUFFICIENT_PKG,
      searchKnowledge: async (_q: string, filters?: { kind?: string[] }) => {
        if (filters?.kind?.includes('contradiction')) {
          return {
            hits: [
              {
                id: 'c:1',
                kind: 'contradiction',
                title: 'Alert key retirement',
                locator: 'csw://contradictions/alert-key',
                excerpt: 'The 2010 alert key sits awkwardly with later immutability claims.',
              },
            ],
          };
        }
        return { hits: [] };
      },
      getResource: async () => ({
        text: 'Finding: the early alert key design sits awkwardly with later immutability claims.',
      }),
    } as unknown as McpBridge;
    const g = await groundQuestion('Why was the alert key retired?', { mcp, corpus: null });
    expect(g.mode).toBe('mcp');
    // The finding reaches the model as evidence…
    expect(g.evidenceText).toContain('early alert key design');
    // …but with no public URL it is never cited, and carries no [n] marker.
    expect(g.citations).toHaveLength(0);
    expect(g.evidenceText).not.toMatch(/\[\d+\]/);
  });

  it('routes comparative questions to the essay-first blend, not the claim composer', async () => {
    const calls = { search: 0, investigate: 0 };
    const mcp = {
      connected: true,
      investigate: async () => {
        calls.investigate += 1;
        return SUFFICIENT_PKG;
      },
      searchKnowledge: async (_q: string, filters?: { kind?: string[] }) => {
        calls.search += 1;
        if (filters?.kind?.includes('essay')) {
          return {
            hits: [
              {
                id: 'e:1',
                kind: 'essay',
                title: 'The Miner Is Not a Monarch',
                locator: 'csw://essay/substack/the-miner-is-not-a-monarch',
              },
            ],
          };
        }
        return { hits: [] };
      },
      getResource: async () => ({
        text: 'Objections to Network Access Rules (NAR) and Digital Asset Recovery (DAR) rest on a category error.',
      }),
    } as unknown as McpBridge;
    const g = await groundQuestion('Is that comparable to NAR/DAR? Please help me compare the two.', {
      mcp,
      corpus: null,
    });
    // The blend answered it; the phrasing-sensitive investigate composer never ran.
    expect(calls.search).toBeGreaterThan(0);
    expect(calls.investigate).toBe(0);
    expect(g.citations[0]?.url).toBe('https://singulargrit.substack.com/p/the-miner-is-not-a-monarch');
  });

  it('routes identity questions by the original phrasing even when the rewrite drops the cue', async () => {
    const curated = new CuratedReference(
      [
        {
          id: 'd:1',
          category: 'testimony',
          title: 'A witness account',
          url: 'https://example.com/witness',
          text: 'Testimony about the authorship of the white paper.',
        },
      ],
      null,
      null,
    );
    const g = await groundQuestion(
      'departure record 2010 authorship',
      { mcp: null, corpus: null, curated },
      { originalQuestion: 'Are you really Craig Wright?' },
    );
    expect(g.mode).toBe('reference');
    expect(g.evidenceText).toContain('Testimony about the authorship');
  });
});
