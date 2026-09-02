import { describe, expect, it } from 'vitest';
import {
  buildQueryUnderstandingRequest,
  expandTerms,
  parseQueryUnderstanding,
  rewriteCacheKey,
  RewriteCache,
  shouldSkipRewrite,
} from './queryUnderstanding.js';

describe('expandTerms', () => {
  it('expands known ecosystem acronyms, keeping the acronym alongside', () => {
    expect(expandTerms('NAR/DAR')).toBe('NAR/DAR Network Access Rules Digital Asset Recovery');
    expect(expandTerms('What is DAR?')).toBe('What is DAR? Digital Asset Recovery');
  });

  it('matches whole words only — darwin must not expand DAR', () => {
    expect(expandTerms('darwin award')).toBe('darwin award');
  });

  it('is idempotent when the expansion is already present', () => {
    expect(expandTerms('DAR Digital Asset Recovery')).toBe('DAR Digital Asset Recovery');
  });
});

describe('shouldSkipRewrite', () => {
  it('skips standalone protocol-identifier questions that already retrieve perfectly', () => {
    expect(shouldSkipRewrite('What is BRC-100?')).toBe(true);
    expect(shouldSkipRewrite('How does OP_CHECKSIG work?')).toBe(true);
  });

  it('does not skip identifier questions that reference prior context', () => {
    expect(shouldSkipRewrite('And how does BRC-100 handle that?')).toBe(false);
  });

  it('skips bare courtesy messages', () => {
    expect(shouldSkipRewrite('thanks satoshi!')).toBe(true);
    expect(shouldSkipRewrite('hello')).toBe(true);
  });

  it('does not skip a courtesy opener that continues into a real question', () => {
    expect(shouldSkipRewrite('Thanks, Satoshi. Why did you leave Bitcoin?')).toBe(false);
  });

  it('does not skip conceptual or comparative questions', () => {
    expect(shouldSkipRewrite('Why did you leave Bitcoin and move onto other things?')).toBe(false);
    expect(shouldSkipRewrite('Is that comparable to NAR/DAR? Please help me compare the two.')).toBe(false);
  });
});

describe('buildQueryUnderstandingRequest', () => {
  const history = [
    { role: 'user' as const, content: 'What was the purpose for the alert key?' },
    { role: 'assistant' as const, content: 'I designed the alert system in 2010 as a practical mechanism…' },
  ];

  it('asks for a strict JSON contract with query, variants and followup', () => {
    const req = buildQueryUnderstandingRequest('Is that comparable to NAR/DAR?', history);
    expect(req.system).toContain('"query"');
    expect(req.system).toContain('"variants"');
    expect(req.system).toContain('"followup"');
    expect(req.system).toMatch(/ONLY a JSON object/);
    expect(req.system).toMatch(/never answer the question/i);
  });

  it('instructs acronym expansion and document-vocabulary variants', () => {
    const req = buildQueryUnderstandingRequest('Is that comparable to NAR/DAR?', history);
    expect(req.system).toContain('Network Access Rules');
    expect(req.system).toContain('Digital Asset Recovery');
    expect(req.system).toMatch(/vocabulary a source document/i);
  });

  it('carries the conversation and the latest message in the user content', () => {
    const req = buildQueryUnderstandingRequest('Is that comparable to NAR/DAR?', history);
    expect(req.userContent).toContain('User: What was the purpose for the alert key?');
    expect(req.userContent).toContain('Satoshi: I designed the alert system in 2010');
    expect(req.userContent).toContain('Is that comparable to NAR/DAR?');
  });

  it('keeps only the last few history messages and truncates long ones', () => {
    const long = 'x'.repeat(1_000);
    const many = [
      { role: 'user' as const, content: 'first — should be dropped' },
      { role: 'assistant' as const, content: 'second — should be dropped' },
      { role: 'user' as const, content: 'third' },
      { role: 'assistant' as const, content: long },
      { role: 'user' as const, content: 'fifth' },
      { role: 'assistant' as const, content: 'sixth' },
    ];
    const req = buildQueryUnderstandingRequest('why?', many);
    expect(req.userContent).not.toContain('should be dropped');
    expect(req.userContent).toContain('User: third');
    expect(req.userContent).not.toContain(long);
  });
});

describe('parseQueryUnderstanding', () => {
  it('parses a bare JSON reply', () => {
    const u = parseQueryUnderstanding(
      '{"query": "why Satoshi left Bitcoin departure", "variants": ["withdrew from public view disillusioned"], "followup": false}',
      'Why did you leave Bitcoin?',
    );
    expect(u).toEqual({
      query: 'why Satoshi left Bitcoin departure',
      variants: ['withdrew from public view disillusioned'],
      followUp: false,
    });
  });

  it('parses a fenced JSON reply', () => {
    const u = parseQueryUnderstanding(
      '```json\n{"query": "why Satoshi left Bitcoin", "variants": [], "followup": false}\n```',
      'Why did you leave Bitcoin?',
    );
    expect(u?.query).toBe('why Satoshi left Bitcoin');
  });

  it('returns undefined for prose so the caller fails open', () => {
    expect(parseQueryUnderstanding('Here is your query: Satoshi departure', 'Why did you leave?')).toBeUndefined();
    expect(parseQueryUnderstanding('', 'Why did you leave?')).toBeUndefined();
    expect(parseQueryUnderstanding('{not json}', 'Why did you leave?')).toBeUndefined();
  });

  it('returns undefined when the query is missing or empty', () => {
    expect(parseQueryUnderstanding('{"variants": [], "followup": false}', 'Why did you leave?')).toBeUndefined();
    expect(parseQueryUnderstanding('{"query": "  ", "variants": []}', 'Why did you leave?')).toBeUndefined();
  });

  it('collapses whitespace and newlines in the query', () => {
    const u = parseQueryUnderstanding(
      '{"query": "alert   key\nsystem comparison", "variants": []}',
      'alert key?',
    );
    expect(u?.query).toBe('alert key system comparison');
  });

  it('caps variants at three, dedupes them and drops empties and repeats of the query', () => {
    const u = parseQueryUnderstanding(
      '{"query": "alert key purpose", "variants": ["alert key purpose", "alert system emergency", "", "alert key safe mode", "alert key retirement", "a fifth variant"], "followup": false}',
      'alert key?',
    );
    expect(u?.variants).toEqual(['alert system emergency', 'alert key safe mode', 'alert key retirement']);
  });

  it('parses the followup flag, defaulting to false', () => {
    expect(
      parseQueryUnderstanding('{"query": "alert key compared with DAR", "variants": [], "followup": true}', 'compare them?', 'alert key?')?.followUp,
    ).toBe(true);
    expect(
      parseQueryUnderstanding('{"query": "alert key purpose", "variants": []}', 'alert key?')?.followUp,
    ).toBe(false);
  });

  it('rejects a rewrite that shares no vocabulary with the question or context (hallucination guard)', () => {
    expect(
      parseQueryUnderstanding('{"query": "banana smoothie recipe", "variants": []}', 'What is SPV?'),
    ).toBeUndefined();
  });

  it('accepts a rewrite anchored by an acronym the user wrote', () => {
    const u = parseQueryUnderstanding(
      '{"query": "Digital Asset Recovery (DAR) framework", "variants": []}',
      'What is DAR?',
    );
    expect(u?.query).toBe('Digital Asset Recovery (DAR) framework');
  });

  it('accepts a follow-up rewrite anchored by the conversation context', () => {
    const u = parseQueryUnderstanding(
      '{"query": "compare the 2010 alert key system with Network Access Rules and Digital Asset Recovery", "variants": [], "followup": true}',
      'Is that comparable to NAR/DAR?',
      'What was the purpose for the alert key?',
    );
    expect(u?.query).toContain('alert key');
  });
});

describe('rewriteCacheKey', () => {
  it('normalises case and punctuation, and changes with the prior context', () => {
    expect(rewriteCacheKey('What is X?')).toBe(rewriteCacheKey('what  is  x'));
    expect(rewriteCacheKey('What is X?')).not.toBe(rewriteCacheKey('What is X?', 'prior question'));
  });
});

describe('RewriteCache', () => {
  it('round-trips a stored understanding and misses unknown keys', () => {
    const cache = new RewriteCache();
    const value = { query: 'q', variants: [], followUp: false };
    cache.set('k', value);
    expect(cache.get('k')).toEqual(value);
    expect(cache.get('unknown')).toBeUndefined();
  });

  it('evicts the oldest entry beyond capacity', () => {
    const cache = new RewriteCache(2);
    cache.set('a', { query: 'a', variants: [], followUp: false });
    cache.set('b', { query: 'b', variants: [], followUp: false });
    cache.set('c', { query: 'c', variants: [], followUp: false });
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('c')).toBeDefined();
  });
});
