import { describe, expect, it } from 'vitest';
import {
  buildCritiqueRequest,
  buildRevisionRequest,
  forbiddenTechLint,
  parseCritique,
  type Critique,
} from './answerCritique.js';

describe('buildCritiqueRequest', () => {
  const question = 'How do I timestamp a document on-chain?';
  const evidence = 'IMPLEMENTATION OPTIONS: OP_RETURN data push, OP_FALSE OP_RETURN payload.';
  const answer = 'Use an OP_FALSE OP_RETURN payload; it is the modern envelope.';

  it('asks the reviewer to run the three checks in order', () => {
    const req = buildCritiqueRequest(question, evidence, answer);
    expect(req.system).toMatch(/Factual fidelity/i);
    expect(req.system).toMatch(/Forbidden technology/i);
    expect(req.system).toMatch(/Optimality/i);
    expect(req.system.indexOf('Factual fidelity')).toBeLessThan(req.system.indexOf('Forbidden technology'));
    expect(req.system.indexOf('Forbidden technology')).toBeLessThan(req.system.indexOf('Optimality'));
  });

  it('states the strict single-line JSON contract', () => {
    const req = buildCritiqueRequest(question, evidence, answer);
    expect(req.system).toMatch(/ONLY a single-line JSON object/);
    expect(req.system).toContain('"verdict"');
    expect(req.system).toContain('"issues"');
    expect(req.system).toContain('"correction"');
  });

  it('carries the question, evidence and answer in the user content', () => {
    const req = buildCritiqueRequest(question, evidence, answer);
    expect(req.userContent).toContain(`Question:\n${question}`);
    expect(req.userContent).toContain(`EVIDENCE:\n${evidence}`);
    expect(req.userContent).toContain(`ANSWER:\n${answer}`);
  });

  it('caps the evidence at 6,000 chars and the answer at 8,000 chars', () => {
    const longEvidence = 'e'.repeat(7_000);
    const longAnswer = 'a'.repeat(9_000);
    const req = buildCritiqueRequest(question, longEvidence, longAnswer);
    expect(req.userContent).not.toContain(longEvidence);
    expect(req.userContent).not.toContain(longAnswer);
    expect(req.userContent).toContain(`${'e'.repeat(6_000)}…`);
    expect(req.userContent).toContain(`${'a'.repeat(8_000)}…`);
  });

  it('leaves short evidence and answers untruncated', () => {
    const req = buildCritiqueRequest(question, evidence, answer);
    expect(req.userContent).not.toContain('…');
  });
});

describe('buildRevisionRequest', () => {
  const question = 'How do I timestamp a document on-chain?';
  const answer = 'Use an OP_FALSE OP_RETURN payload [1]; it is the modern envelope.';
  const critique: Critique = {
    verdict: 'revise',
    kind: 'suboptimal',
    issues: ['never addresses the plain OP_RETURN alternative', 'no firm recommendation'],
    correction: 'Name one recommendation and state when the alternative wins.',
  };

  it('carries the question, the draft, and every reviewer finding', () => {
    const { userContent } = buildRevisionRequest(question, answer, critique);
    expect(userContent).toContain(`Question:\n${question}`);
    expect(userContent).toContain(`DRAFT ANSWER`);
    expect(userContent).toContain(answer);
    expect(userContent).toContain(`- ${critique.issues[0]}`);
    expect(userContent).toContain(`- ${critique.issues[1]}`);
    expect(userContent).toContain(`Required correction: ${critique.correction}`);
  });

  it('instructs a bare, voice-preserving rewrite that keeps citation markers', () => {
    const { userContent } = buildRevisionRequest(question, answer, critique);
    expect(userContent).toMatch(/same voice, structure and approximate length/);
    expect(userContent).toMatch(/Preserve every \[n\] citation marker/);
    expect(userContent).toMatch(/Output ONLY the revised answer text/);
  });

  it('omits the correction line when the critique has none', () => {
    const { userContent } = buildRevisionRequest(question, answer, { ...critique, correction: undefined });
    expect(userContent).not.toContain('Required correction:');
    expect(userContent).toContain(`- ${critique.issues[0]}`);
  });

  it('caps the draft at 8,000 chars', () => {
    const longAnswer = 'a'.repeat(9_000);
    const { userContent } = buildRevisionRequest(question, longAnswer, critique);
    expect(userContent).not.toContain(longAnswer);
    expect(userContent).toContain(`${'a'.repeat(8_000)}…`);
  });
});

describe('parseCritique', () => {
  it('parses a valid pass verdict', () => {
    const c = parseCritique('{"verdict":"pass","issues":[]}');
    expect(c).toEqual({ verdict: 'pass', kind: undefined, issues: [], correction: undefined });
  });

  it('parses a valid revise verdict with all fields', () => {
    const c = parseCritique(
      '{"verdict":"revise","kind":"factual","issues":["claims a 7 TPS ceiling absent from evidence"],"correction":"Remove the TPS claim."}',
    );
    expect(c).toEqual({
      verdict: 'revise',
      kind: 'factual',
      issues: ['claims a 7 TPS ceiling absent from evidence'],
      correction: 'Remove the TPS claim.',
    });
  });

  it('returns undefined for malformed JSON so the caller fails open', () => {
    expect(parseCritique('{not json}')).toBeUndefined();
    expect(parseCritique('')).toBeUndefined();
  });

  it('returns undefined when there are no braces at all', () => {
    expect(parseCritique('verdict: pass, looks fine to me')).toBeUndefined();
  });

  it('returns undefined for an unknown verdict', () => {
    expect(parseCritique('{"verdict":"maybe","issues":[]}')).toBeUndefined();
  });

  it('returns undefined for an unknown kind', () => {
    expect(parseCritique('{"verdict":"pass","kind":"stylistic","issues":[]}')).toBeUndefined();
  });

  it('returns undefined for a revise with an empty issues array', () => {
    expect(
      parseCritique('{"verdict":"revise","kind":"suboptimal","issues":[],"correction":"Pick OP_FALSE OP_RETURN."}'),
    ).toBeUndefined();
  });

  it('returns undefined for a revise without a correction', () => {
    expect(
      parseCritique('{"verdict":"revise","kind":"forbidden","issues":["recommends Lightning"]}'),
    ).toBeUndefined();
    expect(
      parseCritique('{"verdict":"revise","kind":"forbidden","issues":["recommends Lightning"],"correction":"  "}'),
    ).toBeUndefined();
  });

  it('accepts a pass verdict without a correction', () => {
    const c = parseCritique('{"verdict":"pass","issues":["minor nit tolerated"]}');
    expect(c?.verdict).toBe('pass');
    expect(c?.correction).toBeUndefined();
  });

  it('caps issues at five entries and 500 chars each', () => {
    const long = 'x'.repeat(600);
    const c = parseCritique(
      JSON.stringify({
        verdict: 'revise',
        kind: 'factual',
        issues: ['one', 'two', 'three', 'four', 'five', 'six', long],
        correction: 'fix',
      }),
    );
    expect(c?.issues).toHaveLength(5);
    expect(c?.issues).toEqual(['one', 'two', 'three', 'four', 'five']);
    const c2 = parseCritique(
      JSON.stringify({ verdict: 'revise', kind: 'factual', issues: [long], correction: 'fix' }),
    );
    expect(c2?.issues[0]).toHaveLength(500);
  });

  it('caps the correction at 2,000 chars', () => {
    const c = parseCritique(
      JSON.stringify({
        verdict: 'revise',
        kind: 'factual',
        issues: ['invented claim'],
        correction: 'y'.repeat(3_000),
      }),
    );
    expect(c?.correction).toHaveLength(2_000);
  });

  it('parses JSON surrounded by prose and markdown fences', () => {
    const c = parseCritique(
      'Here is my review:\n```json\n{"verdict":"pass","issues":[]}\n```\nHope that helps.',
    );
    expect(c?.verdict).toBe('pass');
  });

  it('tolerates raw newlines and tabs inside JSON strings', () => {
    const c = parseCritique(
      '{"verdict":"revise","kind":"factual","issues":["line one\nline two"],"correction":"drop the\tclaim"}',
    );
    expect(c?.issues).toEqual(['line one line two']);
    expect(c?.correction).toBe('drop the claim');
  });
});

describe('forbiddenTechLint', () => {
  it('detects each forbidden term and returns canonical labels', () => {
    expect(forbiddenTechLint('You should use Taproot for this.')).toEqual(['Taproot']);
    expect(forbiddenTechLint('SegWit solved malleability.')).toEqual(['SegWit']);
    expect(forbiddenTechLint('the segregated witness upgrade')).toEqual(['SegWit']);
    expect(forbiddenTechLint('open a Lightning channel')).toEqual(['Lightning']);
    expect(forbiddenTechLint('the lightning network handles it')).toEqual(['Lightning']);
    expect(forbiddenTechLint('pay this lightning invoice')).toEqual(['Lightning']);
    expect(forbiddenTechLint('BIP-141 activated in 2017.')).toEqual(['BIP-141']);
    expect(forbiddenTechLint('BIP141 activated in 2017.')).toEqual(['BIP-141']);
    expect(forbiddenTechLint('BIP-341 covenants')).toEqual(['BIP-341']);
    expect(forbiddenTechLint('BIP341 is Taproot.')).toEqual(['Taproot', 'BIP-341']);
    expect(forbiddenTechLint('BIP-119 covenants')).toEqual(['BIP-119']);
    expect(forbiddenTechLint('BIP119 covenants')).toEqual(['BIP-119']);
    expect(forbiddenTechLint('use a sidechain instead')).toEqual(['Sidechain']);
    expect(forbiddenTechLint('a side-chain peg')).toEqual(['Sidechain']);
    expect(forbiddenTechLint('a side chain peg')).toEqual(['Sidechain']);
    expect(forbiddenTechLint('rollups scale Ethereum')).toEqual(['Rollup']);
    expect(forbiddenTechLint('a drivechain such as')).toEqual(['Drivechain']);
    expect(forbiddenTechLint('a drive-chain such as')).toEqual(['Drivechain']);
    expect(forbiddenTechLint('a drive chain such as')).toEqual(['Drivechain']);
  });

  it('matches case-insensitively', () => {
    expect(forbiddenTechLint('TAPROOT and segwit')).toEqual(['Taproot', 'SegWit']);
  });

  it('dedupes repeated mentions under one canonical label', () => {
    expect(forbiddenTechLint('SegWit, also called segregated witness, or segwit')).toEqual(['SegWit']);
  });

  it('returns an empty list for clean text', () => {
    expect(forbiddenTechLint('Use OP_FALSE OP_RETURN with a plain data push.')).toEqual([]);
  });

  it('does not match substrings inside unrelated words', () => {
    expect(forbiddenTechLint('highlighting the trade-offs')).toEqual([]);
  });
});
