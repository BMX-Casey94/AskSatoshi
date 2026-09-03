/**
 * Persistent kill-switch for paid TTS. Survives process restarts so a credit-exhausted
 * or low-balance disable stays off until an operator re-enables it.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type KillReason = 'credit-exhausted' | 'low-balance';

export interface TtsKillState {
  disabled: boolean;
  reason: KillReason | null;
  disabledAt: number | null;
}

export interface TtsState {
  getState(): TtsKillState;
  disable(reason: KillReason): TtsKillState;
  enable(): TtsKillState;
}

export interface WalletSnapshot {
  balanceDollars: number;
  lowBalance: boolean;
}

export interface BalanceClient {
  getWallet(): Promise<WalletSnapshot | null>;
}

const DEFAULT_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../data/runtime/tts-state.json');
const POLL_INTERVAL_MS = 30 * 60 * 1000;

const ENABLED: TtsKillState = { disabled: false, reason: null, disabledAt: null };

function atomicWrite(filePath: string, contents: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, contents, 'utf8');
  try {
    renameSync(tmp, filePath);
  } catch {
    if (existsSync(filePath)) unlinkSync(filePath);
    renameSync(tmp, filePath);
  }
}

export function createTtsState(filePath: string = DEFAULT_PATH): TtsState {
  let current: TtsKillState = { ...ENABLED };

  const persist = () => {
    atomicWrite(filePath, JSON.stringify(current, null, 2));
  };

  if (existsSync(filePath)) {
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf8')) as TtsKillState;
      if (typeof raw.disabled === 'boolean') current = raw;
    } catch (err) {
      console.warn('[tts] state file unreadable; starting enabled:', err instanceof Error ? err.message : err);
    }
  }

  return {
    getState() {
      return { ...current };
    },
    disable(reason) {
      current = { disabled: true, reason, disabledAt: Date.now() };
      persist();
      console.warn(`[tts] disabled: ${reason}`);
      return { ...current };
    },
    enable() {
      current = { ...ENABLED };
      persist();
      console.info('[tts] kill-switch cleared');
      return { ...current };
    },
  };
}

/**
 * One poll of the Resemble billing wallet. Disables on low balance; never auto-enables —
 * an operator must POST /admin/enable after topping up.
 */
export async function pollBalanceTick(
  config: { minBalanceUsd: number },
  resembleClient: BalanceClient,
  state: TtsState,
): Promise<void> {
  const wallet = await resembleClient.getWallet();
  if (!wallet) return;
  if (wallet.lowBalance || wallet.balanceDollars < config.minBalanceUsd) {
    state.disable('low-balance');
  }
}

export function startBalanceMonitor(
  config: { minBalanceUsd: number },
  resembleClient: BalanceClient,
  state: TtsState,
): NodeJS.Timeout {
  const handle = setInterval(() => {
    void pollBalanceTick(config, resembleClient, state).catch((err) => {
      console.warn('[tts] balance poll failed:', err instanceof Error ? err.message : err);
    });
  }, POLL_INTERVAL_MS);
  handle.unref();
  return handle;
}
