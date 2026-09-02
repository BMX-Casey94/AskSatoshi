import { describe, expect, it } from 'vitest';
import { Breaker, nextMidnightInZone, quotaResetFor } from './breaker.js';

describe('Breaker', () => {
  it('reports unconfigured when no tiers exist', () => {
    expect(new Breaker().status([]).state).toBe('unconfigured');
  });

  it('is awake while any tier is usable', () => {
    const b = new Breaker();
    b.markDayExhausted('a', Date.now() + 3_600_000);
    expect(b.status(['a', 'b']).state).toBe('awake');
  });

  it('goes asleep when every tier is day-exhausted, with the earliest reset as retryAfter', () => {
    const now = Date.now();
    const b = new Breaker(() => now);
    b.markDayExhausted('a', now + 7_200_000);
    b.markDayExhausted('b', now + 3_600_000);
    const st = b.status(['a', 'b']);
    expect(st.state).toBe('asleep');
    expect(st.retryAfter).toBe(new Date(now + 3_600_000).toISOString());
  });

  it('wakes up again once the reset time has passed', () => {
    let now = Date.now();
    const b = new Breaker(() => now);
    b.markDayExhausted('a', now + 1_000);
    expect(b.status(['a']).state).toBe('asleep');
    now += 2_000;
    expect(b.status(['a']).state).toBe('awake');
  });

  it('minute-limited tiers recover quickly and do not count as day exhaustion', () => {
    let now = Date.now();
    const b = new Breaker(() => now);
    b.markMinuteLimited('a', 30_000);
    expect(b.isUsable('a')).toBe(false);
    now += 31_000;
    expect(b.isUsable('a')).toBe(true);
  });

  it('disabled tiers never recover within the process lifetime', () => {
    const b = new Breaker();
    b.markDisabled('a');
    expect(b.isUsable('a')).toBe(false);
    expect(b.status(['a']).state).toBe('asleep');
  });

  it('markOk clears all state', () => {
    const b = new Breaker();
    b.markDayExhausted('a', Date.now() + 3_600_000);
    b.markOk('a');
    expect(b.isUsable('a')).toBe(true);
  });

  it('usableCount reflects only tiers that can take a request now', () => {
    const now = Date.now();
    const b = new Breaker(() => now);
    expect(b.usableCount(['a', 'b', 'c'])).toBe(3);
    b.markDayExhausted('a', now + 3_600_000);
    b.markMinuteLimited('b', 30_000);
    expect(b.usableCount(['a', 'b', 'c'])).toBe(1);
    b.markDisabled('c');
    expect(b.usableCount(['a', 'b', 'c'])).toBe(0);
  });
});

describe('quota reset helpers', () => {
  it('nextMidnightInZone always lands in the future, within 24h', () => {
    const now = new Date();
    for (const tz of ['America/Los_Angeles', 'UTC', 'Europe/London']) {
      const t = nextMidnightInZone(tz, now);
      expect(t).toBeGreaterThan(now.getTime());
      expect(t).toBeLessThanOrEqual(now.getTime() + 24 * 3_600_000 + 3_600_000);
    }
  });

  it('gemini resets on Pacific time, others on UTC', () => {
    const now = new Date('2026-08-30T12:00:00Z');
    const pacific = quotaResetFor('gemini', now);
    const utc = quotaResetFor('groq', now);
    // Pacific midnight is 07:00 or 08:00 UTC — strictly later than UTC midnight.
    expect(pacific).toBeGreaterThan(utc);
  });
});
