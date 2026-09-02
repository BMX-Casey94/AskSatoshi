/**
 * Global circuit breaker tracking per-tier quota state. When every configured tier is
 * day-exhausted, the service reports "asleep" with a retryAfter timestamp; the client
 * disables the composer and shows the sleeping banner until quotas reset.
 */

export type AwakeState = 'awake' | 'asleep' | 'unconfigured';

export interface ServiceStatus {
  state: AwakeState;
  retryAfter?: string;
}

interface TierState {
  minuteLimitedUntil?: number;
  dayExhaustedUntil?: number;
  disabled?: boolean;
}

/** Current offset (ms) of a timezone at a given instant — zone-local minus UTC. */
function zoneOffsetMs(tz: string, at: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(at)) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - at.getTime();
}

/** Next local midnight in the given IANA timezone, as a UTC epoch (DST-safe to the hour). */
export function nextMidnightInZone(tz: string, now: Date = new Date()): number {
  const offset = zoneOffsetMs(tz, now);
  const localNow = now.getTime() + offset;
  const nextLocalMidnight = Math.floor(localNow / 86_400_000) * 86_400_000 + 86_400_000;
  const approxUtc = nextLocalMidnight - offset;
  // Recompute the offset at the target instant so a DST change overnight is absorbed.
  const offsetAtTarget = zoneOffsetMs(tz, new Date(approxUtc));
  return nextLocalMidnight - offsetAtTarget;
}

/** Gemini's daily quota resets at midnight Pacific; Groq/OpenRouter windows are UTC-based. */
export function quotaResetFor(provider: string, now: Date = new Date()): number {
  return provider === 'gemini'
    ? nextMidnightInZone('America/Los_Angeles', now)
    : nextMidnightInZone('UTC', now);
}

export class Breaker {
  private readonly states = new Map<string, TierState>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  markMinuteLimited(id: string, retryMs = 60_000): void {
    const s = this.state(id);
    s.minuteLimitedUntil = this.now() + Math.min(retryMs, 5 * 60_000);
  }

  markDayExhausted(id: string, until: number): void {
    this.state(id).dayExhaustedUntil = until;
  }

  /** Auth failures disable a tier for the process lifetime — retrying would burn quota. */
  markDisabled(id: string): void {
    this.state(id).disabled = true;
  }

  markOk(id: string): void {
    this.states.delete(id);
  }

  isUsable(id: string): boolean {
    const s = this.states.get(id);
    if (!s) return true;
    if (s.disabled) return false;
    const now = this.now();
    if (s.dayExhaustedUntil !== undefined && s.dayExhaustedUntil > now) return false;
    if (s.minuteLimitedUntil !== undefined && s.minuteLimitedUntil > now) return false;
    return true;
  }

  status(configuredIds: string[]): ServiceStatus {
    if (configuredIds.length === 0) return { state: 'unconfigured' };
    if (configuredIds.some((id) => this.isUsable(id))) return { state: 'awake' };

    // Asleep: report the earliest quota reset across day-exhausted tiers.
    const now = this.now();
    const resets = configuredIds
      .map((id) => this.states.get(id)?.dayExhaustedUntil)
      .filter((t): t is number => t !== undefined && t > now);
    if (resets.length === 0) {
      // Everything is minute-limited or disabled rather than day-exhausted: wake soon.
      return { state: 'asleep', retryAfter: new Date(now + 60_000).toISOString() };
    }
    return { state: 'asleep', retryAfter: new Date(Math.min(...resets)).toISOString() };
  }

  /**
   * How many of the configured tiers can take a request right now. Used to decide
   * whether the service can afford auxiliary LLM calls (query rewrite, citation
   * filter) or should spend its scarce remaining quota on the answer alone.
   */
  usableCount(configuredIds: string[]): number {
    return configuredIds.filter((id) => this.isUsable(id)).length;
  }

  private state(id: string): TierState {
    let s = this.states.get(id);
    if (!s) {
      s = {};
      this.states.set(id, s);
    }
    return s;
  }
}
