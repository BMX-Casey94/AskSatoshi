/**
 * Paid TTS configuration. All values come from process.env (already loaded by
 * index.ts). The feature disables itself when the three required secrets are unset.
 */

export interface TtsConfig {
  resembleApiKey: string;
  resembleVoiceUuid: string;
  resembleProjectUuid?: string;
  treasuryWif: string;
  maxChars: number;
  minBalanceUsd: number;
  adminToken: string;
  bsvUsdFallback: number;
}

function readString(env: NodeJS.ProcessEnv, key: string): string {
  return (env[key] ?? '').trim();
}

function readNumber(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function loadTtsConfig(env: NodeJS.ProcessEnv = process.env): TtsConfig {
  const project = readString(env, 'RESEMBLE_PROJECT_UUID');
  return {
    resembleApiKey: readString(env, 'RESEMBLE_API_KEY'),
    resembleVoiceUuid: readString(env, 'RESEMBLE_VOICE_UUID'),
    resembleProjectUuid: project || undefined,
    treasuryWif: readString(env, 'TREASURY_WIF'),
    maxChars: readNumber(env, 'TTS_MAX_CHARS', 12_000),
    minBalanceUsd: readNumber(env, 'TTS_MIN_BALANCE_USD', 0.25),
    adminToken: readString(env, 'TTS_ADMIN_TOKEN'),
    bsvUsdFallback: readNumber(env, 'BSV_USD_FALLBACK', 15),
  };
}

const REQUIRED_SECRETS = [
  ['resembleApiKey', 'RESEMBLE_API_KEY'],
  ['resembleVoiceUuid', 'RESEMBLE_VOICE_UUID'],
  ['treasuryWif', 'TREASURY_WIF'],
] as const;

/** True only when the Resemble key, voice UUID and treasury WIF are all present. */
export function isTtsConfigured(config: TtsConfig): boolean {
  return ttsMissingSecrets(config).length === 0;
}

/** Env var names that are empty — names only, never values. */
export function ttsMissingSecrets(config: TtsConfig): string[] {
  return REQUIRED_SECRETS.filter(([field]) => !config[field]).map(([, name]) => name);
}
