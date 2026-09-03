import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTtsState, pollBalanceTick, startBalanceMonitor } from './state.js';

const dirs: string[] = [];

async function tmpStatePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tts-state-'));
  dirs.push(dir);
  return join(dir, 'tts-state.json');
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('TtsState', () => {
  it('starts enabled and disable persists to disk so a new instance stays disabled', async () => {
    const path = await tmpStatePath();
    const state = createTtsState(path);
    expect(state.getState()).toEqual({ disabled: false, reason: null, disabledAt: null });

    const before = Date.now();
    state.disable('credit-exhausted');
    const snap = state.getState();
    expect(snap.disabled).toBe(true);
    expect(snap.reason).toBe('credit-exhausted');
    expect(snap.disabledAt).toBeGreaterThanOrEqual(before);

    const onDisk = JSON.parse(await readFile(path, 'utf8')) as { disabled: boolean; reason: string };
    expect(onDisk.disabled).toBe(true);
    expect(onDisk.reason).toBe('credit-exhausted');

    const reloaded = createTtsState(path);
    expect(reloaded.getState().disabled).toBe(true);
    expect(reloaded.getState().reason).toBe('credit-exhausted');
  });

  it('enable clears the kill switch and persists the clear', async () => {
    const path = await tmpStatePath();
    const state = createTtsState(path);
    state.disable('low-balance');
    state.enable();
    expect(state.getState()).toEqual({ disabled: false, reason: null, disabledAt: null });

    const reloaded = createTtsState(path);
    expect(reloaded.getState().disabled).toBe(false);
    expect(reloaded.getState().reason).toBeNull();
  });
});

describe('pollBalanceTick', () => {
  it('disables for low-balance when dollars are below the configured minimum', async () => {
    const state = createTtsState(await tmpStatePath());
    await pollBalanceTick(
      { minBalanceUsd: 0.25 },
      { getWallet: async () => ({ balanceDollars: 0.1, lowBalance: false }) },
      state,
    );
    expect(state.getState()).toMatchObject({ disabled: true, reason: 'low-balance' });
  });

  it('disables when Resemble reports low_balance even if dollars are above the floor', async () => {
    const state = createTtsState(await tmpStatePath());
    await pollBalanceTick(
      { minBalanceUsd: 0.25 },
      { getWallet: async () => ({ balanceDollars: 9.92, lowBalance: true }) },
      state,
    );
    expect(state.getState()).toMatchObject({ disabled: true, reason: 'low-balance' });
  });

  it('leaves the switch alone when the wallet lookup fails or the balance is healthy', async () => {
    const state = createTtsState(await tmpStatePath());
    await pollBalanceTick({ minBalanceUsd: 0.25 }, { getWallet: async () => null }, state);
    expect(state.getState().disabled).toBe(false);
    await pollBalanceTick(
      { minBalanceUsd: 0.25 },
      { getWallet: async () => ({ balanceDollars: 1, lowBalance: false }) },
      state,
    );
    expect(state.getState().disabled).toBe(false);
  });
});

describe('startBalanceMonitor', () => {
  it('returns an unrefed interval handle', () => {
    const state = createTtsState(join(tmpdir(), `tts-state-monitor-${Date.now()}.json`));
    const unref = vi.fn();
    const handle = { unref, ref: vi.fn(), hasRef: () => true } as unknown as NodeJS.Timeout;
    const spy = vi.spyOn(global, 'setInterval').mockReturnValue(handle);
    try {
      const started = startBalanceMonitor(
        { minBalanceUsd: 0.25 },
        { getWallet: async () => null },
        state,
      );
      expect(setInterval).toHaveBeenCalledWith(expect.any(Function), 30 * 60 * 1000);
      expect(unref).toHaveBeenCalledOnce();
      expect(started).toBe(handle);
    } finally {
      spy.mockRestore();
    }
  });
});
