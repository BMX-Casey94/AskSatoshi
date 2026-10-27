/**
 * LLM provider chain: gemini-3.6-flash → gemini-3.5-flash →
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

export interface ProviderResult {
  text: string;
  /**
   * True when the provider stopped at the output-token cap: the text is cut off,
   * not complete. Callers use this to distinguish a deliberately short answer from
   * a corrupted one — only the latter must never replace a complete draft.
   */
  truncated: boolean;
}

export type ProviderFn = (
  tier: ModelTier,
  req: ChainRequest,
  onDelta: (text: string) => void,
  signal: AbortSignal,
) => Promise<ProviderResult>;

const FIRST_TOKEN_TIMEOUT_MS = 45_000;
/**
 * How long to wait for a tier's FIRST token before failing over. A stalled provider
 * (connection open, nothing streaming) should not hold the request hostage for the
 * full idle timeout when a healthy tier is waiting. Once tokens flow, the longer
 * idle timeout governs gaps between them.
 */
const FIRST_TOKEN_FAILOVER_MS = 15_000;
// 1024 was being consumed by hidden "thinking" on Flash / GPT-OSS before any
// visible token, cutting answers short. 4096 leaves generous room for reasoning +
// a full answer; the system prompt still caps length, so headroom costs nothing.
const MAX_OUTPUT_TOKENS = 4_096;
// Grounded RAG, but with enough warmth for natural phrasing variety across asks.
// 0.45 is the safe ceiling: claims stay pinned by the evidence contract while openings
// and cadence vary. Higher risks the persona inventing claims on opinionated evidence.
const TEMPERATURE = 0.45;

export function outputTokenLimit(tier: ModelTier): number {
  return tier.maxOutputTokens ?? MAX_OUTPUT_TOKENS;
}

/**
 * gpt-oss always reasons; 'low' keeps a free-tier request under Groq's 8K TPM.
 * The vision preview must not receive the parameter — an unsupported field is a 400,
 * and the image would never be seen.
 */
export function groqReasoningEffort(model: string): 'low' | undefined {
  return model.includes('gpt-oss') ? 'low' : undefined;
}

export type GeminiPart = { text: string } | { inlineData: { data: string; mimeType: string } };

export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

/**
 * Gemini wire shape. History stays text: the image belongs to the latest turn only.
 * Text and inlineData are separate parts — the API rejects a part that sets both.
 * The system prompt is systemInstruction, not a content turn, so it cannot drop the image.
 */
export function buildGeminiContents(req: ChainRequest): {
  systemInstruction: string;
  contents: GeminiContent[];
} {
  const parts: GeminiPart[] = [{ text: req.userContent }];
  if (req.image) {
    parts.push({ inlineData: { data: req.image.data, mimeType: req.image.mimeType } });
  }
  return {
    systemInstruction: req.system,
    contents: [
      ...req.history.map((m) => ({
        role: m.role === 'assistant' ? ('model' as const) : ('user' as const),
        parts: [{ text: m.content }] as GeminiPart[],
      })),
      { role: 'user' as const, parts },
    ],
  };
}

export type OpenAiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | OpenAiContentPart[];
}

/**
 * OpenAI-compatible wire shape (Groq and OpenRouter, including Gemini models hosted
 * there). History stays plain text. The image is a data-URL part on the latest user
 * message only, beside the question text. The system prompt is its own message.
 */
export function buildOpenAiMessages(req: ChainRequest): OpenAiMessage[] {
  const content: string | OpenAiContentPart[] = req.image
    ? [
        { type: 'text', text: req.userContent },
        {
          type: 'image_url',
          image_url: { url: `data:${req.image.mimeType};base64,${req.image.data}` },
        },
      ]
    : req.userContent;
  return [{ role: 'system', content: req.system }, ...req.history, { role: 'user', content }];
}

export function createGeminiProvider(apiKey: string): ProviderFn {
  const ai = new GoogleGenAI({ apiKey });
  return async (tier, req, onDelta, signal) => {
    const built = buildGeminiContents(req);
    const stream = await ai.models.generateContentStream({
      model: tier.model,
      contents: built.contents,
      config: {
        systemInstruction: built.systemInstruction,
        temperature: TEMPERATURE,
        maxOutputTokens: outputTokenLimit(tier),
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
    return { text: full, truncated };
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
    const params: Record<string, unknown> = {
      model: tier.model,
      stream: true,
      temperature: TEMPERATURE,
      max_tokens: outputTokenLimit(tier),
      messages: buildOpenAiMessages(req),
    };
    if (provider === 'groq') {
      const effort = groqReasoningEffort(tier.model);
      if (effort) params.reasoning_effort = effort;
    }
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
    return { text: full, truncated };
  };
}

/** Aborts the attempt if no token arrives within `timeoutMs` (reset on every delta). */
async function withIdleTimeout<T>(
  fn: (signal: AbortSignal, onDelta: (text: string) => void) => Promise<T>,
  timeoutMs: number,
  onDelta: (text: string) => void,
  parentSignal?: AbortSignal,
  firstTokenMs?: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let firstTokenSeen = false;
  const arm = (ms: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error('IDLE_TIMEOUT')), ms);
  };
  // Before the first token, use the shorter failover window so a stalled provider
  // yields quickly; after it, fall back to the generous idle gap between tokens.
  arm(firstTokenMs ?? timeoutMs);
  const onParentAbort = () => controller.abort(new Error('CLIENT_DISCONNECTED'));
  parentSignal?.addEventListener('abort', onParentAbort);
  try {
    return await fn(controller.signal, (text) => {
      if (!firstTokenSeen) {
        firstTokenSeen = true;
        arm(timeoutMs);
      } else {
        arm(timeoutMs);
      }
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
  /**
   * True when tokens are buffered server-side instead of streamed to the client.
   * A mid-stream provider failure can then fail over safely: nothing was ever
   * shown, so a fresh attempt cannot double a visible answer.
   */
  buffered?: boolean;
  /** Injectable for tests; defaults to real providers built from `keys`. */
  providers?: Partial<Record<ProviderId, ProviderFn>>;
}

export async function runChain(
  req: ChainRequest,
  opts: RunChainOptions,
): Promise<{ text: string; tierId: string; truncated: boolean }> {
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
      const result = await withIdleTimeout(
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
        FIRST_TOKEN_FAILOVER_MS,
      );
      if (!result.text.trim()) throw new Error('EMPTY_RESPONSE');
      opts.breaker.markOk(tier.id);
      return { text: result.text, tierId: tier.id, truncated: result.truncated };
    } catch (err) {
      if (err instanceof Error && err.message === 'CLIENT_DISCONNECTED') throw err;
      // Mid-stream failure after tokens reached the client: failing over would
      // double the visible answer, so a streaming request ends with a witty error.
      // Buffered requests have shown nothing, so failover remains safe.
      if (sentAny && !opts.buffered) throw new WittyException(witty('PROVIDER_ERROR'));
      const cls = classifyProviderError(err);
      // Name the tier and the classified reason so a production failure is diagnosable
      // from the journal alone, instead of surfacing only as a generic witty error.
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(`[llm] tier ${tier.id} failed (${cls}): ${detail.slice(0, 200)}`);
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
