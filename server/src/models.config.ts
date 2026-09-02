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
  /**
   * True for $0-cost models (free tiers, :free). Free models get a trimmed prompt
   * budget and a lower output cap, because their per-minute token ceilings (Groq's 8K
   * TPM above all) reject or stall on the full grounded prompt. Paid models get the
   * full budget — their context windows are large and the constraint is cost, not fit.
   */
  free?: boolean;
  /** Per-tier output cap. Free tiers get less so the request stays under their TPM. */
  maxOutputTokens?: number;
}

/** Default output cap when a tier does not override it (paid / roomy-context tiers). */
export const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;
/** Free-tier output cap: keeps a grounded request under Groq's 8K TPM ceiling. */
export const FREE_MAX_OUTPUT_TOKENS = 2_048;
/**
 * Paid-primary output cap. Long comparative answers were hitting the 4096 default and
 * truncating mid-sentence; 8192 gives generous headroom while still bounding spend
 * (at $1.50/1M, a full 8K answer costs about a penny).
 */
export const PAID_MAX_OUTPUT_TOKENS = 8_192;

export const MODEL_CHAIN: ModelTier[] = [
  // Paid workhorse: GA until ≥May 2027, $0.25/1M in + $1.50/1M out, 1M context, vision.
  // A funded OpenRouter key makes this the reliable primary; free tiers are overflow.
  { id: 'openrouter-flash-lite', provider: 'openrouter', model: 'google/gemini-3.1-flash-lite', vision: true, maxOutputTokens: PAID_MAX_OUTPUT_TOKENS },
  // Free Gemini (unpaid AI Studio keys): newest Flash confirmed GA.
  { id: 'gemini-3.6-flash', provider: 'gemini', model: 'gemini-3.6-flash', vision: true, free: true, maxOutputTokens: FREE_MAX_OUTPUT_TOKENS },
  // Same-key Gemini failover (quotas are per model, so this multiplies daily capacity).
  { id: 'gemini-3.5-flash', provider: 'gemini', model: 'gemini-3.5-flash', vision: true, free: true, maxOutputTokens: FREE_MAX_OUTPUT_TOKENS },
  // Second tier: Groq production flagship. 30 RPM / 1,000 RPD / 8K TPM free.
  { id: 'groq-gpt-oss-120b', provider: 'groq', model: 'openai/gpt-oss-120b', vision: false, free: true, maxOutputTokens: FREE_MAX_OUTPUT_TOKENS },
  // Groq vision preview — image turns only; preview models can vanish, so it is never primary.
  { id: 'groq-qwen3.6-27b', provider: 'groq', model: 'qwen/qwen3.6-27b', vision: true, visionOnly: true, free: true, maxOutputTokens: FREE_MAX_OUTPUT_TOKENS },
  // OpenRouter :free (50/day unfunded, 1,000/day after $10 one-time).
  { id: 'openrouter-nemotron-super', provider: 'openrouter', model: 'nvidia/nemotron-3-super-120b-a12b:free', vision: false, free: true, maxOutputTokens: FREE_MAX_OUTPUT_TOKENS },
  { id: 'openrouter-glm-5.2', provider: 'openrouter', model: 'z-ai/glm-5.2:free', vision: false, free: true, maxOutputTokens: FREE_MAX_OUTPUT_TOKENS },
  { id: 'openrouter-gemma-4-31b', provider: 'openrouter', model: 'google/gemma-4-31b-it:free', vision: true, free: true, maxOutputTokens: FREE_MAX_OUTPUT_TOKENS },
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

/**
 * The evidence budget (chars) for the system prompt, given which tier the request will
 * most likely land on. Free tiers get a compact block so the grounded prompt fits under
 * their per-minute token ceilings; paid tiers get the full evidence. We look at the
 * first usable tier because that is where runChain will try first.
 */
export const FREE_EVIDENCE_CHARS = 3_500;

export function evidenceBudgetFor(tier: ModelTier | undefined): number | undefined {
  return tier?.free ? FREE_EVIDENCE_CHARS : undefined;
}
