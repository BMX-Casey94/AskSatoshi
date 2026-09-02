import { describe, expect, it, vi } from 'vitest';
import { Breaker } from './breaker.js';
import { WittyException } from './errors.js';
import { runChain, type ChainRequest, type ProviderFn } from './llm.js';

const REQ: ChainRequest = {
  system: 'You are Satoshi.',
  history: [],
  userContent: 'EVIDENCE:\n[1] x\n\nQUESTION: What is BEEF?',
};

const keys = { gemini: 'g', groq: 'q' };

function okProvider(text: string): ProviderFn {
  return async (_tier, _req, onDelta) => {
    onDelta(text);
    return text;
  };
}

function failingProvider(err: unknown): ProviderFn {
  return async () => {
    throw err;
  };
}

describe('runChain', () => {
  it('answers on the primary tier when healthy', async () => {
    const result = await runChain(REQ, {
      keys,
      breaker: new Breaker(),
      onDelta: () => undefined,
      providers: { gemini: okProvider('BEEF is defined by BRC-62 [1].') },
    });
    expect(result.tierId).toBe('gemini-3.6-flash');
    expect(result.text).toContain('BRC-62');
  });

  it('fails over to the next tier on a daily-quota error and marks the breaker', async () => {
    const breaker = new Breaker();
    const result = await runChain(REQ, {
      keys,
      breaker,
      onDelta: () => undefined,
      providers: {
        gemini: failingProvider({ status: 429, message: 'Quota exceeded: requests per day limit reached' }),
        groq: okProvider('answer from groq'),
      },
    });
    expect(result.tierId).toBe('groq-gpt-oss-120b');
    // All three Gemini tiers share one project quota, so each is marked day-exhausted…
    expect(breaker.isUsable('gemini-3.6-flash')).toBe(false);
  });

  it('throws EXHAUSTED with retryAfter when every tier is day-exhausted', async () => {
    const breaker = new Breaker();
    await expect(
      runChain(REQ, {
        keys,
        breaker,
        onDelta: () => undefined,
        providers: {
          gemini: failingProvider({ status: 429, message: 'daily quota exhausted' }),
          groq: failingProvider({ status: 429, message: 'requests per day limit' }),
        },
      }),
    ).rejects.toSatisfy(
      (e) => e instanceof WittyException && e.wittyError.code === 'EXHAUSTED' && !!e.wittyError.retryAfter,
    );
  });

  it('throws TIMEOUT when all tiers fail transiently', async () => {
    await expect(
      runChain(REQ, {
        keys,
        breaker: new Breaker(),
        onDelta: () => undefined,
        providers: {
          gemini: failingProvider({ status: 503, message: 'unavailable' }),
          groq: failingProvider(new Error('fetch failed')),
        },
      }),
    ).rejects.toSatisfy((e) => e instanceof WittyException && e.wittyError.code === 'TIMEOUT');
  });

  it('fails over fast when a tier streams no first token (stalled provider)', async () => {
    // A provider that opens but never emits a token must yield to the next tier in the
    // short first-token window, not hold the request for the full idle timeout.
    // Fake timers make the 15s window deterministic and instant.
    vi.useFakeTimers();
    try {
      const stalledProvider: ProviderFn = async (_tier, _req, _onDelta, signal) => {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, 60_000);
          signal?.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new Error('IDLE_TIMEOUT'));
          });
        });
        return '';
      };
      const promise = runChain(REQ, {
        keys,
        breaker: new Breaker(),
        onDelta: () => undefined,
        providers: { gemini: stalledProvider, groq: okProvider('answer from groq') },
      });
      // Advance past every tier's first-token window so the chain can reach Groq.
      await vi.runAllTimersAsync();
      const result = await promise;
      expect(result.tierId).toBe('groq-gpt-oss-120b');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not fail over after partial output has streamed (avoids doubled answers)', async () => {
    const halfProvider: ProviderFn = async (_tier, _req, onDelta) => {
      onDelta('partial…');
      throw { status: 500, message: 'boom' };
    };
    const deltas: string[] = [];
    await expect(
      runChain(REQ, {
        keys,
        breaker: new Breaker(),
        onDelta: (t) => deltas.push(t),
        providers: { gemini: halfProvider, groq: okProvider('should never arrive') },
      }),
    ).rejects.toSatisfy((e) => e instanceof WittyException && e.wittyError.code === 'PROVIDER_ERROR');
    expect(deltas).toEqual(['partial…']);
  });

  it('routes image requests to a vision-capable tier', async () => {
    // With only an OpenRouter key, the vision-capable tiers are the paid primary
    // (flash-lite) then the free gemma-4-31b; the chain tries the paid primary first.
    const seenModels: string[] = [];
    const visionProbe: ProviderFn = async (tier, _req, onDelta) => {
      seenModels.push(tier.model);
      onDelta('seen');
      return 'seen';
    };
    const result = await runChain(
      { ...REQ, image: { data: 'aGk=', mimeType: 'image/png' } },
      {
        keys: { openrouter: 'o' },
        breaker: new Breaker(),
        onDelta: () => undefined,
        providers: { openrouter: visionProbe },
      },
    );
    expect(result.tierId).toBe('openrouter-flash-lite');
    expect(seenModels).toEqual(['google/gemini-3.1-flash-lite']);
  });
});
