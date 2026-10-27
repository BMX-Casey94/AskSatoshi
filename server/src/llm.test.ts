import { describe, expect, it, vi } from 'vitest';
import { Breaker } from './breaker.js';
import { WittyException } from './errors.js';
import {
  buildGeminiContents,
  buildOpenAiMessages,
  groqReasoningEffort,
  outputTokenLimit,
  runChain,
  type ChainRequest,
  type ProviderFn,
} from './llm.js';
import { eligibleTiers, FREE_MAX_OUTPUT_TOKENS, PAID_MAX_OUTPUT_TOKENS } from './models.config.js';

const REQ: ChainRequest = {
  system: 'You are Satoshi.',
  history: [],
  userContent: 'EVIDENCE:\n[1] x\n\nQUESTION: What is BEEF?',
};

const keys = { gemini: 'g', groq: 'q' };

function okProvider(text: string, truncated = false): ProviderFn {
  return async (_tier, _req, onDelta) => {
    onDelta(text);
    return { text, truncated };
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
        return { text: '', truncated: false };
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

  it('fails over after partial output when buffered (nothing reached the client)', async () => {
    // Closed-door generation buffers tokens server-side, so a mid-stream provider
    // failure cannot double a visible answer — failing over is safe and correct.
    const halfProvider: ProviderFn = async (_tier, _req, onDelta) => {
      onDelta('partial…');
      throw { status: 500, message: 'boom' };
    };
    const result = await runChain(REQ, {
      keys,
      breaker: new Breaker(),
      onDelta: () => undefined,
      buffered: true,
      providers: { gemini: halfProvider, groq: okProvider('complete answer from groq') },
    });
    expect(result.tierId).toBe('groq-gpt-oss-120b');
    expect(result.text).toBe('complete answer from groq');
  });

  it('propagates the provider truncation flag', async () => {
    const result = await runChain(REQ, {
      keys,
      breaker: new Breaker(),
      onDelta: () => undefined,
      providers: { gemini: okProvider('cut off mid-sentence', true) },
    });
    expect(result.truncated).toBe(true);
  });

  it('reports no truncation when the provider finishes cleanly', async () => {
    const result = await runChain(REQ, {
      keys,
      breaker: new Breaker(),
      onDelta: () => undefined,
      providers: { gemini: okProvider('complete') },
    });
    expect(result.truncated).toBe(false);
  });

  it('routes image requests to a vision-capable tier', async () => {
    // With only an OpenRouter key, the vision-capable tiers are the paid primary
    // (flash-lite) then the free gemma-4-31b; the chain tries the paid primary first.
    const seenModels: string[] = [];
    const visionProbe: ProviderFn = async (tier, _req, onDelta) => {
      seenModels.push(tier.model);
      onDelta('seen');
      return { text: 'seen', truncated: false };
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

  it('fails an image over to the next vision tier and never calls a text-only model', async () => {
    const seen: { id: string; model: string; image?: string }[] = [];
    const watch =
      (fail: boolean, text = 'seen'): ProviderFn =>
      async (tier, req, onDelta) => {
        seen.push({ id: tier.id, model: tier.model, image: req.image?.data });
        expect(tier.vision).toBe(true);
        expect(req.system).toBe(REQ.system);
        expect(req.userContent).toBe(REQ.userContent);
        expect(req.image?.mimeType).toBe('image/png');
        if (fail) throw { status: 400, message: 'image rejected' };
        onDelta(text);
        return { text, truncated: false };
      };
    const result = await runChain(
      { ...REQ, image: { data: 'iVBORw0K', mimeType: 'image/png' } },
      {
        keys: { gemini: 'g', groq: 'q', openrouter: 'o' },
        breaker: new Breaker(),
        onDelta: () => undefined,
        providers: {
          openrouter: watch(true),
          gemini: watch(true),
          groq: watch(false, 'from qwen'),
        },
      },
    );
    expect(result).toEqual({ text: 'from qwen', tierId: 'groq-qwen3.6-27b', truncated: false });
    expect(seen).toEqual([
      { id: 'openrouter-flash-lite', model: 'google/gemini-3.1-flash-lite', image: 'iVBORw0K' },
      { id: 'gemini-3.6-flash', model: 'gemini-3.6-flash', image: 'iVBORw0K' },
      { id: 'gemini-3.5-flash', model: 'gemini-3.5-flash', image: 'iVBORw0K' },
      { id: 'groq-qwen3.6-27b', model: 'qwen/qwen3.6-27b', image: 'iVBORw0K' },
    ]);
  });
});

describe('vision payload', () => {
  const imageReq: ChainRequest = {
    system: 'SYS',
    history: [
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
    ],
    userContent: 'What does this image show?',
    image: { data: 'iVBORw0K', mimeType: 'image/png' },
  };

  it('puts the image on the current Gemini turn and leaves history as text', () => {
    const built = buildGeminiContents(imageReq);
    expect(built.systemInstruction).toBe('SYS');
    expect(built.systemInstruction).not.toContain('iVBORw0K');
    expect(built.contents).toEqual([
      { role: 'user', parts: [{ text: 'earlier question' }] },
      { role: 'model', parts: [{ text: 'earlier answer' }] },
      {
        role: 'user',
        parts: [
          { text: 'What does this image show?' },
          { inlineData: { data: 'iVBORw0K', mimeType: 'image/png' } },
        ],
      },
    ]);
  });

  it('puts the image on the current OpenAI turn as a data URL and leaves history as text', () => {
    expect(buildOpenAiMessages(imageReq)).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What does this image show?' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0K' } },
        ],
      },
    ]);
  });

  it('omits image parts when there is no image', () => {
    expect(buildGeminiContents(REQ).contents).toEqual([{ role: 'user', parts: [{ text: REQ.userContent }] }]);
    const messages = buildOpenAiMessages(REQ);
    expect(messages[messages.length - 1]).toEqual({ role: 'user', content: REQ.userContent });
  });

  it('does not ask Groq vision models for gpt-oss reasoning effort', () => {
    expect(groqReasoningEffort('openai/gpt-oss-120b')).toBe('low');
    expect(groqReasoningEffort('qwen/qwen3.6-27b')).toBeUndefined();
  });

  it('uses each vision tier output cap', () => {
    const paid = eligibleTiers({ openrouter: 'o' }, true)[0];
    const free = eligibleTiers({ gemini: 'g' }, true)[0];
    expect(outputTokenLimit(paid!)).toBe(PAID_MAX_OUTPUT_TOKENS);
    expect(outputTokenLimit(free!)).toBe(FREE_MAX_OUTPUT_TOKENS);
    expect(outputTokenLimit({ id: 'x', provider: 'gemini', model: 'm', vision: true })).toBe(4_096);
  });
});
