/**
 * Assemble the paid TTS stack: config, purchase store, kill-switch, Resemble client,
 * treasury identity, and the Express router. Callers mount the router at /api/tts.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTtsConfigured, loadTtsConfig, ttsMissingSecrets, type TtsConfig } from './config.js';
import { fetchBsvUsd, quoteSatoshis, satsPerThousand } from './pricing.js';
import { createResembleClient, type ResembleClient } from './resemble.js';
import { createTtsRouter, type TtsRouterDeps } from './routes.js';
import { createTtsState, startBalanceMonitor, type TtsState } from './state.js';
import { createTtsStore, type TtsStore } from './store.js';
import { treasuryFromWif, verifyPayment, buildRefundTx, broadcastTx, type TreasuryIdentity } from './treasury.js';

const DEFAULT_RUNTIME = join(dirname(fileURLToPath(import.meta.url)), '../../data/runtime');

export interface TtsAssembly {
  router: ReturnType<typeof createTtsRouter>;
  config: TtsConfig;
  store: TtsStore;
  state: TtsState;
  treasury: TreasuryIdentity | null;
  resemble: ResembleClient | null;
}

export function assembleTts(runtimeDir: string = DEFAULT_RUNTIME): TtsAssembly {
  const config = loadTtsConfig();
  const store = createTtsStore(join(runtimeDir, 'tts-purchases.json'));
  const state = createTtsState(join(runtimeDir, 'tts-state.json'));
  const audioDir = join(runtimeDir, 'tts-audio');

  let treasury: TreasuryIdentity | null = null;
  let resemble: ResembleClient | null = null;

  if (isTtsConfigured(config)) {
    try {
      treasury = treasuryFromWif(config.treasuryWif);
    } catch {
      console.warn('[tts] TREASURY_WIF is invalid; TTS will stay disabled');
      treasury = null;
    }
    resemble = createResembleClient({
      apiKey: config.resembleApiKey,
      voiceUuid: config.resembleVoiceUuid,
      projectUuid: config.resembleProjectUuid,
    });
    startBalanceMonitor({ minBalanceUsd: config.minBalanceUsd }, resemble, state);
  }

  const deps: TtsRouterDeps = {
    config,
    store,
    state,
    audioDir,
    fetchBsvUsd,
    quoteSatoshis,
    satsPerThousand,
    resemble,
    treasury: treasury
      ? {
          address: treasury.address,
          lockingScriptHex: treasury.lockingScriptHex,
          key: treasury.key,
          verifyPayment: (opts) =>
            verifyPayment({
              ...opts,
              treasuryScriptHex: treasury!.lockingScriptHex,
            }),
          buildRefundTx: (opts) =>
            buildRefundTx({
              paymentTxid: opts.paymentTxid,
              voutIndex: opts.voutIndex,
              receivedSats: opts.receivedSats,
              senderScriptHex: opts.senderScriptHex,
              treasuryKey: treasury!.key,
            }),
          broadcastTx,
        }
      : null,
  };

  return { router: createTtsRouter(deps), config, store, state, treasury, resemble };
}

export function ttsStartupLine(assembly: TtsAssembly): string {
  const missing = ttsMissingSecrets(assembly.config);
  if (missing.length > 0) {
    return `[tts] disabled: not-configured (missing ${missing.join(', ')})`;
  }
  if (!assembly.treasury) {
    return '[tts] disabled: not-configured (TREASURY_WIF invalid)';
  }
  const st = assembly.state.getState();
  if (st.disabled) return `[tts] disabled: ${st.reason ?? 'kill-switch'}`;
  return `[tts] enabled (treasury ${assembly.treasury.address})`;
}
