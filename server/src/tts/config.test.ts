import { afterEach, describe, expect, it } from 'vitest';
import { isTtsConfigured, loadTtsConfig, ttsMissingSecrets } from './config.js';

const FULL_ENV = {
  RESEMBLE_API_KEY: 'rk_test',
  RESEMBLE_VOICE_UUID: 'voice-uuid',
  TREASURY_WIF: 'L5EY1SbTvvPNSdCYQe1EJHfXCBBT4PmnF6CDbzCm9iifZptUvDGB',
  TTS_ADMIN_TOKEN: 'admin-secret',
};

describe('loadTtsConfig', () => {
  const prev = { ...process.env };
  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in prev)) delete process.env[key];
    }
    Object.assign(process.env, prev);
  });

  it('applies documented defaults when optional env vars are unset', () => {
    const cfg = loadTtsConfig({ ...FULL_ENV });
    expect(cfg.maxChars).toBe(12_000);
    expect(cfg.minBalanceUsd).toBe(0.25);
    expect(cfg.bsvUsdFallback).toBe(15);
    expect(cfg.resembleProjectUuid).toBeUndefined();
  });

  it('reads optional overrides from env', () => {
    const cfg = loadTtsConfig({
      ...FULL_ENV,
      RESEMBLE_PROJECT_UUID: 'proj-1',
      TTS_MAX_CHARS: '8000',
      TTS_MIN_BALANCE_USD: '1.5',
      BSV_USD_FALLBACK: '20',
    });
    expect(cfg.resembleProjectUuid).toBe('proj-1');
    expect(cfg.maxChars).toBe(8000);
    expect(cfg.minBalanceUsd).toBe(1.5);
    expect(cfg.bsvUsdFallback).toBe(20);
    expect(cfg.resembleApiKey).toBe('rk_test');
    expect(cfg.resembleVoiceUuid).toBe('voice-uuid');
    expect(cfg.treasuryWif).toBe(FULL_ENV.TREASURY_WIF);
    expect(cfg.adminToken).toBe('admin-secret');
  });

  it('reads process.env when no argument is passed', () => {
    process.env.RESEMBLE_API_KEY = 'from-process';
    process.env.RESEMBLE_VOICE_UUID = 'voice-proc';
    process.env.TREASURY_WIF = 'wif-proc';
    const cfg = loadTtsConfig();
    expect(cfg.resembleApiKey).toBe('from-process');
    expect(cfg.resembleVoiceUuid).toBe('voice-proc');
    expect(cfg.treasuryWif).toBe('wif-proc');
  });
});

describe('isTtsConfigured', () => {
  it('is true only when API key, voice UUID and treasury WIF are all present', () => {
    expect(isTtsConfigured(loadTtsConfig(FULL_ENV))).toBe(true);
    expect(isTtsConfigured(loadTtsConfig({ ...FULL_ENV, RESEMBLE_API_KEY: '' }))).toBe(false);
    expect(isTtsConfigured(loadTtsConfig({ ...FULL_ENV, RESEMBLE_VOICE_UUID: '' }))).toBe(false);
    expect(isTtsConfigured(loadTtsConfig({ ...FULL_ENV, TREASURY_WIF: '' }))).toBe(false);
    expect(isTtsConfigured(loadTtsConfig({}))).toBe(false);
  });

  it('names the missing env vars without exposing values', () => {
    expect(ttsMissingSecrets(loadTtsConfig(FULL_ENV))).toEqual([]);
    expect(ttsMissingSecrets(loadTtsConfig({ ...FULL_ENV, RESEMBLE_API_KEY: '' }))).toEqual([
      'RESEMBLE_API_KEY',
    ]);
    expect(ttsMissingSecrets(loadTtsConfig({}))).toEqual([
      'RESEMBLE_API_KEY',
      'RESEMBLE_VOICE_UUID',
      'TREASURY_WIF',
    ]);
  });
});
