/**
 * LLM provider chain: gemini-3.6-flash → gemini-3.5-flash → gemini-2.5-flash →
 * Groq gpt-oss-120b → OpenRouter :free tiers. Streams tokens, fails over on
 * quota/transient errors, and reports day-exhaustion to the circuit breaker so the
 * whole service can go politely "asleep" when every free quota is spent.
 */

import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import { Breaker, quotaResetFor } from './breaker.js';
import {
  classifyProviderError,
  retryAfterMs,
  witty,
  WittyException,
} from './errors.js';
import {
  configuredTiers,
  eligibleTiers,
  type ModelTier,
  type ProviderId,
  type ProviderKeys,
} from './models.config.js';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ImageInput {
  /** Base64, no data-URL prefix. */
  data: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
}

export interface ChainRequest {
  system: string;
  history: ChatMessage[];
  /** Evidence block + question, built by the orchestrator. */
  userContent: string;
  image?: ImageInput;
}

export type ProviderFn = (
  tier: ModelTier,
  req: ChainRequest,
  onDelta: (text: string) => void,
  signal: AbortSignal,
) => Promise<string>;

const FIRST_TOKEN_TIMEOUT_MS = 30_000;
// 1024 was being consumed by hidden "thinking" on Flash / GPT-OSS before any
// visible token, cutting answers short. 4096 leaves generous room for reasoning +
// a full answer; the system prompt still caps length, so headroom costs nothing.
const MAX_OUTPUT_TOKENS = 4_096;
// Grounded RAG, but with enough warmth for natural phrasing variety across asks.
// 0.45 is the safe ceiling: claims stay pinned by the evidence contract while openings
// and cadence vary. Higher risks the persona inventing claims on opinionated evidence.
const TEMPERATURE = 0.45;

export function createGeminiProvider(apiKey: string): ProviderFn {
  const ai = new GoogleGenAI({ apiKey });
  return async (tier, req, onDelta, signal) => {
    const userParts: ({ text: string } | { inlineData: { data: string; mimeType: string } })[] = [
      { text: req.userContent },
    ];
    if (req.image) {
      userParts.push({ inlineData: { data: req.image.data, mimeType: req.image.mimeType } });
    }
    const contents = [
      ...req.history.map((m) => ({
        role: m.role === 'assistant' ? ('model' as const) : ('user' as const),
        parts: [{ text: m.content }],
      })),
      { role: 'user' as const, parts: userParts },
    ];
    const stream = await ai.models.generateContentStream({
      model: tier.model,
      contents,
      config: {
        systemInstruction: req.system,
        temperature: TEMPERATURE,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        // Cap hidden thinking so it can't eat the whole output budget (2.5 series).
        thinkingConfig: { thinkingBudget: 1024 },
        abortSignal: signal,
      },
    } as never);
    let full = '';
    let truncated = false;
    for await (const chunk of stream) {
      if (signal.aborted) throw new Error('ABORTED');
      const text = chunk.text ?? '';
      if (text) {
        full += text;
        onDelta(text);
      }
      const finish = chunk.candidates?.[0]?.finishReason;
      if (finish === 'MAX_TOKENS') truncated = true;
    }
    if (truncated) console.warn('[llm] gemini hit MAX_TOKENS — answer may be cut short');
    return full;
  };
}

export function createOpenAiCompatProvider(provider: 'groq' | 'openrouter', apiKey: string): ProviderFn {
  const client = new OpenAI({
    apiKey,
    baseURL: provider === 'groq' ? 'https://api.groq.com/openai/v1' : 'https://openrouter.ai/api/v1',
    defaultHeaders:
      provider === 'openrouter'
        ? { 'HTTP-Referer': 'https://github.com/BMX-Casey94', 'X-Title': 'Ask Satoshi' }
        : undefined,
    timeout: 60_000,
    maxRetries: 0, // retries and failover are owned by the chain, not the SDK
  });
  return async (tier, req, onDelta, signal) => {
    const userContent = req.image
      ? [
          { type: 'text' as const, text: req.userContent },
          {
            type: 'image_url' as const,
            image_url: { url: `data:${req.image.mimeType};base64,${req.image.data}` },
          },
        ]
      : req.userContent;
    const params: Record<string, unknown> = {
      model: tier.model,
      stream: true,
      temperature: TEMPERATURE,
      max_tokens: MAX_OUTPUT_TOKENS,
      messages: [
        { role: 'system', content: req.system },
        ...req.history,
        { role: 'user', content: userContent },
      ],
    };
    // gpt-oss always reasons; 'low' protects the 8K TPM free-tier ceiling.
    if (provider === 'groq') params.reasoning_effort = 'low';
    const stream = (await client.chat.completions.create(params as never, { signal })) as unknown as AsyncIterable<{
      choices?: { delta?: { content?: string }; finish_reason?: string | null }[];
    }>;
    let full = '';
    let truncated = false;
    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      const text = choice?.delta?.content ?? '';
      if (text) {
        full += text;
        onDelta(text);
      }
      if (choice?.finish_reason === 'length') truncated = true;
    }
    if (truncated) console.warn(`[llm] ${provider} hit max tokens — answer may be cut short`);
    return full;
  };
}

/** Aborts the attempt if no token arrives within `timeoutMs` (reset on every delta). */
async function withIdleTimeout<T>(
  fn: (signal: AbortSignal, onDelta: (text: string) => void) => Promise<T>,
  timeoutMs: number,
  onDelta: (text: string) => void,
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const reset = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error('IDLE_TIMEOUT')), timeoutMs);
  };
  reset();
  const onParentAbort = () => controller.abort(new Error('CLIENT_DISCONNECTED'));
  parentSignal?.addEventListener('abort', onParentAbort);
  try {
    return await fn(controller.signal, (text) => {
      reset();
      onDelta(text);
    });
  } finally {
    if (timer) clearTimeout(timer);
    parentSignal?.removeEventListener('abort', onParentAbort);
  }
}

export interface RunChainOptions {
  keys: ProviderKeys;
  breaker: Breaker;
  onDelta: (text: string) => void;
  signal?: AbortSignal;
  /** Injectable for tests; defaults to real providers built from `keys`. */
  providers?: Partial<Record<ProviderId, ProviderFn>>;
}

export async function runChain(
  req: ChainRequest,
  opts: RunChainOptions,
): Promise<{ text: string; tierId: string }> {
  const tiers = eligibleTiers(opts.keys, !!req.image);
  const providers: Partial<Record<ProviderId, ProviderFn>> =
    opts.providers ?? {
      ...(opts.keys.gemini ? { gemini: createGeminiProvider(opts.keys.gemini) } : {}),
      ...(opts.keys.groq ? { groq: createOpenAiCompatProvider('groq', opts.keys.groq) } : {}),
      ...(opts.keys.openrouter
        ? { openrouter: createOpenAiCompatProvider('openrouter', opts.keys.openrouter) }
        : {}),
    };

  if (tiers.length === 0) {
    if (req.image && configuredTiers(opts.keys).length > 0) {
      throw new WittyException(witty('VISION_UNAVAILABLE'));
    }
    throw new WittyException(witty('PROVIDER_ERROR'));
  }

  const usable = tiers.filter((t) => opts.breaker.isUsable(t.id));
  if (usable.length === 0) {
    const st = opts.breaker.status(tiers.map((t) => t.id));
    throw new WittyException(witty('EXHAUSTED', st.retryAfter));
  }

  let sawTransient = false;
  for (const tier of usable) {
    const provider = providers[tier.provider];
    if (!provider) continue;
    let sentAny = false;
    try {
      const text = await withIdleTimeout(
        (signal, onDelta) =>
          provider(
            tier,
            req,
            (t) => {
              sentAny = true;
              onDelta(t);
            },
            signal,
          ),
        FIRST_TOKEN_TIMEOUT_MS,
        opts.onDelta,
        opts.signal,
      );
      if (!text.trim()) throw new Error('EMPTY_RESPONSE');
      opts.breaker.markOk(tier.id);
      return { text, tierId: tier.id };
    } catch (err) {
      if (err instanceof Error && err.message === 'CLIENT_DISCONNECTED') throw err;
      // Mid-stream failure after tokens were sent: failing over would double the
      // answer, so we end the request with a witty error instead.
      if (sentAny) throw new WittyException(witty('PROVIDER_ERROR'));
      const cls = classifyProviderError(err);
      if (cls === 'day') opts.breaker.markDayExhausted(tier.id, quotaResetFor(tier.provider));
      else if (cls === 'minute') opts.breaker.markMinuteLimited(tier.id, retryAfterMs(err));
      else if (cls === 'auth') opts.breaker.markDisabled(tier.id);
      else sawTransient = true;
    }
  }

  const st = opts.breaker.status(tiers.map((t) => t.id));
  if (st.state === 'asleep') throw new WittyException(witty('EXHAUSTED', st.retryAfter));
  throw new WittyException(witty(sawTransient ? 'TIMEOUT' : 'PROVIDER_ERROR'));
}
