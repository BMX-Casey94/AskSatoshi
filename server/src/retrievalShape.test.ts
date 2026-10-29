import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyRetrieval,
  deriveDomainGenerics,
  domainGenericTerms,
  dominateTerms,
  hitQualifies,
  mergeCollectorCitations,
  overlapTerms,
  slotBudget,
  subjectTerms,
  useTestLexicon,
} from './retrievalShape.js';

describe('classifyRetrieval', () => {
  it('picks a shape from the question rather than one global order', () => {
    expect(classifyRetrieval('How does a Merkle branch prove inclusion?')).toBe('mechanism');
    expect(classifyRetrieval('What is a coinbase transaction?')).toBe('mechanism');
    expect(classifyRetrieval('What is OP_RETURN used for?')).toBe('mechanism');
    expect(classifyRetrieval('What is simplified payment verification?')).toBe('mechanism');
    expect(classifyRetrieval('What is BRC-62?')).toBe('named-spec');
    expect(classifyRetrieval('What is BEEF?')).toBe('named-spec');
    expect(classifyRetrieval('Why did you design SPV proofs?')).toBe('concept');
    expect(classifyRetrieval('What did Satoshi say about the 1MB limit?')).toBe('satoshi-quote');
    expect(classifyRetrieval('What did you write about transaction fees?')).toBe('satoshi-quote');
    expect(classifyRetrieval('Can Bitcoin scale to a million TPS?')).toBe('scaling');
    expect(classifyRetrieval('Was the block size always meant to stay small?')).toBe('scaling');
    expect(classifyRetrieval('How do I build a payment app?')).toBe('builder');
    expect(classifyRetrieval('What is Bitcoin?')).toBe('general');
  });
});

describe('slotBudget', () => {
  it('reserves the mechanism, quote, scaling and builder mixes', () => {
    expect(slotBudget('mechanism')).toMatchObject({ essay: 1, spec: 3, primary: 1, specLeads: true, rankSpecs: true, subjectConstrained: true });
    expect(slotBudget('mechanism', 'beginner')).toMatchObject({ essay: 1, spec: 3, specLeads: true });
    expect(slotBudget('mechanism', 'developer')).toMatchObject({ essay: 2, spec: 4, specLeads: true, subjectConstrained: false });
    expect(slotBudget('named-spec')).toMatchObject({ spec: 4, primary: 1, specLeads: true });
    expect(slotBudget('concept')).toMatchObject({ essay: 3, spec: 1, primary: 1, specLeads: false });
    expect(slotBudget('satoshi-quote', 'developer')).toMatchObject({ essay: 2, spec: 0, primary: 3, primaryLeads: true });
    expect(slotBudget('scaling')).toMatchObject({ essay: 4, spec: 1, primary: 0 });
    expect(slotBudget('builder', 'developer')).toMatchObject({ essay: 3, spec: 2, primaryLeads: false });
    expect(slotBudget('general', 'historian')).toMatchObject({ primary: 3, primaryLeads: true });
  });
});

describe('hitQualifies', () => {
  it('rejects a title that shares no subject word, and keeps the named exceptions', () => {
    const telephone = { title: 'Telephone rates in France', url: 'https://example.com/france' };
    expect(hitQualifies('How do I bake sourdough bread?', telephone, 'general', 'later-commentary')).toBe(false);
    expect(hitQualifies('What is BRC-62?', telephone, 'named-spec', 'spec')).toBe(true);
    expect(hitQualifies('What is BRC-100?', { title: 'select failed 10038 fix', text: 'database error 10038', url: 'https://example.com/10038' }, 'named-spec', 'satoshi-primary')).toBe(false);
    expect(hitQualifies('What is BRC-100?', { title: 'Wallet note', text: 'See BRC-100 for the interface.', url: 'https://example.com/mail' }, 'named-spec', 'satoshi-primary')).toBe(true);
    expect(hitQualifies('How do I build a payment app?', { title: 'BRC-100', url: 'https://github.com/bsv-blockchain/BRCs/blob/master/wallet/0100.md' }, 'builder', 'spec')).toBe(true);
    expect(hitQualifies('Why was Bitcoin hijacked?', { title: 'Direction change', locator: 'analysis://bitcoin-scaling-history', excerpt: 'Bitcoin was hijacked from peer-to-peer cash.' }, 'concept', 'internal')).toBe(true);
    expect(hitQualifies('Did someone co-opt Bitcoin?', { title: 'Direction change', locator: 'analysis://bitcoin-scaling-history', excerpt: 'Bitcoin was hijacked from peer-to-peer cash.' }, 'concept', 'internal')).toBe(true);
    expect(hitQualifies('Did someone co-opt Bitcoin?', { title: 'Wallet options', url: 'https://example.com/opt' }, 'concept', 'spec')).toBe(false);
    expect(hitQualifies('What is Bitcoin?', { title: 'The 21 million', url: 'https://example.com/21' }, 'general', 'later-commentary')).toBe(true);
  });

  it('treats 1MB and leave as subject words via the phrase expansion', () => {
    expect(subjectTerms('What is the 1MB limit?').terms).toEqual(expect.arrayContaining(['1mb', 'block', 'size']));
    expect(subjectTerms('What is the 1MB limit?').terms).not.toContain('limit');
    expect(subjectTerms('Was the block size always meant to stay small?').terms).toContain('block');
    expect(subjectTerms('How is double-spending prevented?').terms).toContain('double');
    expect(subjectTerms('How is double-spending prevented?').terms).not.toContain('spend');
    expect(hitQualifies('Why did you leave Bitcoin?', { title: 'The myth of forks: Satoshi withdrew', url: 'https://example.com/forks' }, 'concept', 'later-commentary')).toBe(true);
    expect(hitQualifies('Why did you leave Bitcoin?', { title: 'The myth of forks', url: 'https://example.com/forks' }, 'concept', 'later-commentary')).toBe(false);
    expect(hitQualifies('Why did you leave Bitcoin?', { title: 'Bitcoin P2P e-cash paper', text: 'Nodes can leave and rejoin the network at will.', url: 'https://example.com/paper' }, 'concept', 'satoshi-primary')).toBe(false);
    expect(hitQualifies('What did Satoshi say about the 1MB limit?', { title: 'Connection limits', url: 'https://example.com/limits' }, 'satoshi-quote', 'satoshi-primary')).toBe(false);
    expect(hitQualifies('How is double-spending prevented?', { title: 'Wallet-Enforced Spend Policy', url: 'https://example.com/spend' }, 'mechanism', 'spec')).toBe(false);
    expect(hitQualifies('How is double-spending prevented?', { title: 'Double-Spend Assurance without Blocks', url: 'https://example.com/double' }, 'mechanism', 'later-commentary')).toBe(true);
    expect(hitQualifies('Can Bitcoin scale on-chain?', { title: 'Why Scaling on-Chain Works', url: 'https://example.com/scale' }, 'scaling', 'later-commentary')).toBe(true);
    expect(hitQualifies('What did Satoshi say about the 1MB limit?', { title: 'The Blockchain Trilemma', url: 'https://example.com/trilemma' }, 'satoshi-quote', 'later-commentary')).toBe(false);
    expect(hitQualifies('What stack should I use to build a multisig treasury?', { title: 'Multisignature Verification: Shared Control', url: 'https://example.com/multisig' }, 'builder', 'spec')).toBe(true);
  });
});

describe('mergeCollectorCitations', () => {
  it('leads with the collector whose title shares the subject when the leads disagree', () => {
    const search = [
      { title: 'Fixing OP_Fals', url: 'https://example.com/fals' },
      { title: 'Another note', url: 'https://example.com/note' },
    ];
    const investigate = [{ title: 'OP_RETURN and Data Storage', url: 'https://example.com/opreturn' }];
    const merged = mergeCollectorCitations(search, investigate, 'What is OP_RETURN used for?');
    expect(merged.investigateFirst).toBe(true);
    expect(merged.citations[0]?.title).toBe('OP_RETURN and Data Storage');
    expect(merged.citations.map((citation) => citation.url)).toEqual([
      'https://example.com/opreturn',
      'https://example.com/fals',
      'https://example.com/note',
    ]);
  });

  it('keeps search order when both leads share the subject', () => {
    const search = [{ title: 'OP_RETURN layout', url: 'https://example.com/a' }];
    const investigate = [{ title: 'OP_RETURN storage', url: 'https://example.com/b' }];
    const merged = mergeCollectorCitations(search, investigate, 'What is OP_RETURN?');
    expect(merged.investigateFirst).toBe(false);
    expect(merged.citations[0]?.url).toBe('https://example.com/a');
  });
});

describe('domain frequency', () => {
  afterEach(() => useTestLexicon(null));

  it('admits a domain word only when it is common, and always admits an author name that occurs', () => {
    const freq = new Map<string, number>([
      ['bitcoin', 40],
      ['block', 20],
      ['nod', 15],
      ['merkle', 2],
      ['satoshi', 1],
      ['scheme', 1],
    ]);
    const generic = deriveDomainGenerics(freq, 100);
    expect(generic.has('bitcoin')).toBe(true);
    expect(generic.has('block')).toBe(true);
    expect(generic.has('nod')).toBe(true);
    expect(generic.has('satoshi')).toBe(true);
    expect(generic.has('merkle')).toBe(false);
    expect(generic.has('scheme')).toBe(false);
  });

  it('keeps the rare term when another term is far more common', () => {
    const freq = new Map<string, number>([
      ['ponzi', 0],
      ['scheme', 15],
      ['merkle', 13],
      ['tree', 4],
    ]);
    expect(dominateTerms(['ponzi', 'scheme'], freq)).toEqual(['ponzi']);
    expect(dominateTerms(['merkle', 'tree'], freq).sort()).toEqual(['merkle', 'tree']);
    // A word the index has seen, however rare, does not erase the other subject.
    expect(dominateTerms(['scale', 'million', 'tps'], new Map([['scale', 14], ['million', 22], ['tps', 1]])).sort())
      .toEqual(['million', 'scale', 'tps']);
    expect(dominateTerms(['build', 'app'], new Map([['build', 109], ['app', 19]])).sort()).toEqual(['app', 'build']);
  });

  it('derives the live generic set from the corpus and the protocol index', () => {
    useTestLexicon(null);
    const generic = domainGenericTerms();
    for (const term of ['bitcoin', 'block', 'transaction', 'network', 'satoshi']) {
      expect(generic.has(term)).toBe(true);
    }
    for (const term of ['merkle', 'utxo', 'ponzi']) {
      expect(generic.has(term)).toBe(false);
    }
  });
});

describe('title gate against the weak overlaps', () => {
  afterEach(() => useTestLexicon(null));

  it('does not cite a title that only shares a generic or a verb-shaped near miss', () => {
    useTestLexicon(null);
    const ponzi = 'Is Bitcoin a Ponzi scheme?';
    expect(overlapTerms(ponzi).required).toEqual(expect.arrayContaining(['ponzi', 'scheme']));
    expect(hitQualifies(ponzi, { title: 'Re: URI-scheme for bitcoin', url: 'https://example.com/uri' }, 'general', 'later-commentary')).toBe(false);

    const stop = 'Why did Satoshi stop posting?';
    expect(hitQualifies(stop, { title: 'Stop — exported method in go-sdk', url: 'https://example.com/stop', kind: 'symbol' }, 'concept', 'spec')).toBe(false);
    expect(hitQualifies(stop, { title: 'Stop — exported method in go-sdk', url: 'https://example.com/stop' }, 'concept', 'spec')).toBe(false);
    expect(hitQualifies(stop, { title: 'Satoshi NEVER Posted on Bitcointalk', url: 'https://example.com/never' }, 'concept', 'later-commentary')).toBe(true);
    expect(hitQualifies(stop, { title: 'Burning and why it matters that it is stopped', url: 'https://example.com/stopped' }, 'concept', 'later-commentary')).toBe(false);

    const happened = 'What happened to Satoshi?';
    expect(hitQualifies(happened, {
      title: 'Re: [bitcoin-list] Does Bitcoin Crash in Windows?',
      text: 'Satoshi Nakamoto: what happened was a display bug.',
      url: 'https://example.com/windows',
    }, 'concept', 'satoshi-primary')).toBe(false);

    const gone = 'Why did you disappear?';
    expect(hitQualifies(gone, {
      title: 'Re: overflow bug SERIOUS',
      text: 'The coins will not disappear.',
      url: 'https://example.com/overflow',
    }, 'concept', 'satoshi-primary')).toBe(false);
    expect(hitQualifies(gone, {
      title: 'Re: Transaction disappeared in the void...',
      url: 'https://example.com/void',
    }, 'concept', 'satoshi-primary')).toBe(false);
    expect(hitQualifies(gone, {
      title: 'When the Tollkeepers Disappear: The Consequences of Real Digital Cash',
      url: 'https://example.com/toll',
    }, 'concept', 'later-commentary')).toBe(false);
  });

  it('still grounds a question whose only subject is a generic domain word', () => {
    useTestLexicon(null);
    expect(overlapTerms('What is Bitcoin?').open).toBe(true);
    expect(hitQualifies('What is Bitcoin?', { title: 'The 21 million', url: 'https://example.com/21' }, 'general', 'later-commentary')).toBe(true);
    expect(overlapTerms('blocks').open).toBe(true);
    expect(hitQualifies('blocks', { title: 'The 21 million', url: 'https://example.com/21' }, 'general', 'later-commentary')).toBe(true);
    expect(hitQualifies('How do Merkle trees work?', { title: 'Merkle Trees and SPV', url: 'https://example.com/merkle' }, 'mechanism', 'spec')).toBe(true);
    expect(hitQualifies('What is a UTXO?', { title: 'UTXO set and pruning', url: 'https://example.com/utxo' }, 'mechanism', 'spec')).toBe(true);
  });

  it('keeps a title that shares a real subject, including one introduced by the query that retrieved it', () => {
    useTestLexicon(null);
    expect(overlapTerms('alert system network-wide warning').required).toEqual(expect.arrayContaining(['alert']));
    expect(hitQualifies(
      'alert system network-wide warning',
      { title: 'Alert key', url: 'https://example.com/alert' },
      'general',
      'spec',
      'alert key emergency broadcast',
    )).toBe(true);
    expect(hitQualifies(
      'How do I build a payment app?',
      { title: 'Walletless applications to build SPV proofs at scale', url: 'https://example.com/wallets' },
      'builder',
      'later-commentary',
    )).toBe(true);
    expect(hitQualifies(
      'How do I build a payment app?',
      { title: 'BRC-100', url: 'https://github.com/bsv-blockchain/BRCs/blob/master/wallet/0100.md' },
      'builder',
      'spec',
    )).toBe(true);
    expect(hitQualifies(
      'Can Bitcoin scale to a million TPS?',
      { title: 'On-chain scaling essay 1', url: 'https://example.com/scale' },
      'scaling',
      'later-commentary',
    )).toBe(true);
    // The question never says "alert". The rewrite does, and that is what retrieved the hit.
    expect(hitQualifies(
      'What was that warning?',
      { title: 'Alert key', url: 'https://example.com/alert' },
      'general',
      'spec',
      'alert key emergency broadcast',
    )).toBe(true);
    // A rewrite must not revive a companion the question-side gate already dropped.
    expect(hitQualifies(
      'Is Bitcoin a Ponzi scheme?',
      { title: 'Re: URI-scheme for bitcoin', url: 'https://example.com/uri' },
      'general',
      'later-commentary',
      'ponzi scheme',
    )).toBe(false);
    expect(hitQualifies(
      'Why did Satoshi stop posting?',
      { title: 'Stop — exported method in go-sdk', url: 'https://example.com/stop', kind: 'symbol' },
      'concept',
      'spec',
      'satoshi stop posting',
    )).toBe(false);
  });
});
