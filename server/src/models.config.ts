/**
 * Pinned model chain. Free catalogues churn (Groq sunset Llama 3.3 in Aug 2026;
 * OpenRouter rotates its :free list weekly), so a sunset ID is a one-line change here.
 * Verified against live official docs on 30 Aug 2026.
 */

export type ProviderId = 'gemini' | 'groq' | 'openrouter';

export interface ModelTier {
  id: string;
  provider: ProviderId;
  model: string;
  vision: boolean;
  /** Only eligible for requests carrying an image (e.g. Groq's vision preview). */
  visionOnly?: boolean;
}

export const MODEL_CHAIN: ModelTier[] = [
  // Primary: newest Flash confirmed GA + free on unpaid AI Studio keys.
  { id: 'gemini-3.6-flash', provider: 'gemini', model: 'gemini-3.6-flash', vision: true },
  // Same-key Gemini failover (quotas are per model, so this multiplies daily capacity).
  { id: 'gemini-3.5-flash', provider: 'gemini', model: 'gemini-3.5-flash', vision: true },
  // Second tier: Groq production flagship. 30 RPM / 1,000 RPD / 8K TPM free.
  { id: 'groq-gpt-oss-120b', provider: 'groq', model: 'openai/gpt-oss-120b', vision: false },
  // Groq vision preview — image turns only; preview models can vanish, so it is never primary.
  { id: 'groq-qwen3.6-27b', provider: 'groq', model: 'qwen/qwen3.6-27b', vision: true, visionOnly: true },
  // Optional third tier: OpenRouter :free (50/day unfunded, 1,000/day after $10 one-time).
  { id: 'openrouter-nemotron-super', provider: 'openrouter', model: 'nvidia/nemotron-3-super-120b-a12b:free', vision: false },
  { id: 'openrouter-glm-5.2', provider: 'openrouter', model: 'z-ai/glm-5.2:free', vision: false },
  { id: 'openrouter-gemma-4-31b', provider: 'openrouter', model: 'google/gemma-4-31b-it:free', vision: true },
];

export interface ProviderKeys {
  gemini?: string;
  groq?: string;
  openrouter?: string;
}

export function configuredTiers(keys: ProviderKeys): ModelTier[] {
  return MODEL_CHAIN.filter(
    (t) =>
      (t.provider === 'gemini' && !!keys.gemini) ||
      (t.provider === 'groq' && !!keys.groq) ||
      (t.provider === 'openrouter' && !!keys.openrouter),
  );
}

/** Tiers eligible for this request, in failover order. Image requests need vision tiers. */
export function eligibleTiers(keys: ProviderKeys, hasImage: boolean): ModelTier[] {
  const configured = configuredTiers(keys);
  if (hasImage) return configured.filter((t) => t.vision);
  return configured.filter((t) => !t.visionOnly);
}
