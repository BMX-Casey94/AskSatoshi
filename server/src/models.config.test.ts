import { describe, expect, it } from 'vitest';
import {
  configuredTiers,
  eligibleTiers,
  evidenceBudgetFor,
  FREE_EVIDENCE_CHARS,
  FREE_MAX_OUTPUT_TOKENS,
} from './models.config.js';

const allKeys = { gemini: 'g', groq: 'q', openrouter: 'o' };

describe('model chain configuration', () => {
  it('includes only tiers whose provider key is configured', () => {
    const ids = configuredTiers({ gemini: 'g' }).map((t) => t.id);
    expect(ids).toEqual(['gemini-3.6-flash', 'gemini-3.5-flash']);
  });

  it('leads with the paid OpenRouter workhorse, then free Gemini → Groq → OpenRouter :free', () => {
    const ids = eligibleTiers(allKeys, false).map((t) => t.id);
    expect(ids).toEqual([
      'openrouter-flash-lite',
      'gemini-3.6-flash',
      'gemini-3.5-flash',
      'groq-gpt-oss-120b',
      'openrouter-nemotron-super',
      'openrouter-glm-5.2',
      'openrouter-gemma-4-31b',
    ]);
  });

  it('marks the paid tier non-free and every overflow tier free', () => {
    const byId = new Map(eligibleTiers(allKeys, false).map((t) => [t.id, t]));
    expect(byId.get('openrouter-flash-lite')!.free).toBeUndefined();
    expect(byId.get('gemini-3.6-flash')!.free).toBe(true);
    expect(byId.get('groq-gpt-oss-120b')!.free).toBe(true);
    expect(byId.get('openrouter-nemotron-super')!.free).toBe(true);
  });

  it('caps output lower on free tiers than on the paid tier', () => {
    const byId = new Map(eligibleTiers(allKeys, false).map((t) => [t.id, t]));
    expect(byId.get('openrouter-flash-lite')!.maxOutputTokens).toBeUndefined();
    expect(byId.get('groq-gpt-oss-120b')!.maxOutputTokens).toBe(FREE_MAX_OUTPUT_TOKENS);
  });

  it('excludes vision-only tiers from text requests', () => {
    const ids = eligibleTiers(allKeys, false).map((t) => t.id);
    expect(ids).not.toContain('groq-qwen3.6-27b');
  });

  it('restricts image requests to vision-capable tiers, including the paid primary', () => {
    const ids = eligibleTiers(allKeys, true).map((t) => t.id);
    expect(ids).toContain('openrouter-flash-lite');
    expect(ids).toContain('groq-qwen3.6-27b');
    expect(ids).not.toContain('groq-gpt-oss-120b');
    expect(ids).not.toContain('openrouter-nemotron-super');
  });

  it('returns an empty chain when nothing is configured', () => {
    expect(eligibleTiers({}, false)).toEqual([]);
  });
});

describe('evidence budget', () => {
  it('trims evidence for free tiers and gives paid tiers the full block', () => {
    const byId = new Map(eligibleTiers(allKeys, false).map((t) => [t.id, t]));
    expect(evidenceBudgetFor(byId.get('groq-gpt-oss-120b'))).toBe(FREE_EVIDENCE_CHARS);
    expect(evidenceBudgetFor(byId.get('openrouter-flash-lite'))).toBeUndefined();
    expect(evidenceBudgetFor(undefined)).toBeUndefined();
  });
});
