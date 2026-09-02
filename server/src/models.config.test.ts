import { describe, expect, it } from 'vitest';
import { configuredTiers, eligibleTiers } from './models.config.js';

const allKeys = { gemini: 'g', groq: 'q', openrouter: 'o' };

describe('model chain configuration', () => {
  it('includes only tiers whose provider key is configured', () => {
    const ids = configuredTiers({ gemini: 'g' }).map((t) => t.id);
    expect(ids).toEqual(['gemini-3.6-flash', 'gemini-3.5-flash']);
  });

  it('orders the full chain Gemini → Groq → OpenRouter', () => {
    const ids = eligibleTiers(allKeys, false).map((t) => t.id);
    expect(ids).toEqual([
      'gemini-3.6-flash',
      'gemini-3.5-flash',
      'groq-gpt-oss-120b',
      'openrouter-nemotron-super',
      'openrouter-glm-5.2',
      'openrouter-gemma-4-31b',
    ]);
  });

  it('excludes vision-only tiers from text requests', () => {
    const ids = eligibleTiers(allKeys, false).map((t) => t.id);
    expect(ids).not.toContain('groq-qwen3.6-27b');
  });

  it('restricts image requests to vision-capable tiers, including the Groq preview', () => {
    const ids = eligibleTiers(allKeys, true).map((t) => t.id);
    expect(ids).toContain('groq-qwen3.6-27b');
    expect(ids).not.toContain('groq-gpt-oss-120b');
    expect(ids).not.toContain('openrouter-nemotron-super');
  });

  it('returns an empty chain when nothing is configured', () => {
    expect(eligibleTiers({}, false)).toEqual([]);
  });
});
