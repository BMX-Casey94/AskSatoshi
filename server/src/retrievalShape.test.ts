import { describe, expect, it } from 'vitest';
import {
  classifyRetrieval,
  hitQualifies,
  mergeCollectorCitations,
  slotBudget,
  subjectTerms,
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
