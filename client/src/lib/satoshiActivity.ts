/**
 * Aggregate Satoshi activity points for the two chart views.
 * Dates are treated as UTC (ISO, sorted ascending from the API).
 */

import type { ActivityKind, ActivityPoint } from '../types';

export type KindFilter = 'both' | 'emails' | 'posts';

export interface MonthBucket {
  key: string;
  label: string;
  posts: number;
  emails: number;
}

export interface HourHistogram {
  hours: number[];
  /** True when no timed posts existed and e-mails (or other kinds) were used instead. */
  usedAllKinds: boolean;
  timedCount: number;
}

export interface TimeZone {
  id: string;
  label: string;
  /** UTC offset in whole hours (standard time; no DST shifting). */
  offset: number;
}

export const TIMEZONES: TimeZone[] = [
  { id: 'utc', label: 'UTC', offset: 0 },
  { id: 'europe', label: 'Europe (CET)', offset: 1 },
  { id: 'us-east', label: 'US East', offset: -5 },
  { id: 'us-west', label: 'US West', offset: -8 },
  { id: 'singapore', label: 'Singapore', offset: 8 },
  { id: 'japan', label: 'Japan', offset: 9 },
  { id: 'aus-east', label: 'Australia (Sydney)', offset: 10 },
  { id: 'nz', label: 'New Zealand', offset: 12 },
];

export interface ActiveWindow {
  startHour: number;
  endHour: number;
  total: number;
}

export function normaliseKind(kind: string): ActivityKind | 'other' {
  const k = kind.trim().toLowerCase();
  if (k === 'post' || k === 'posts') return 'posts';
  if (k === 'email' || k === 'emails' || k === 'e-mail' || k === 'e-mails') return 'emails';
  return 'other';
}

export function hasClock(iso: string): boolean {
  return /T\d{2}/.test(iso);
}

function parseUtc(iso: string): Date | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function monthKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function monthLabel(key: string, includeYear: boolean): string {
  const [ys, ms] = key.split('-');
  const y = Number(ys);
  const m = Number(ms);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return key;
  const month = new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-GB', {
    month: 'short',
    timeZone: 'UTC',
  });
  return includeYear ? `${month} ${y}` : month;
}

export function filterActivityPoints(
  points: readonly ActivityPoint[],
  kindFilter: KindFilter = 'both',
): ActivityPoint[] {
  if (kindFilter === 'both') return [...points];
  return points.filter((p) => normaliseKind(p.kind) === kindFilter);
}

/**
 * Continuous UTC months from the first dated point to the last, gaps filled with zeros.
 * The x-axis range always spans `rangePoints` (defaults to `points`) so toggling
 * E-mails / Forum posts keeps the same months and makes empty stretches obvious.
 */
export function monthlyBuckets(
  points: ActivityPoint[],
  kindFilter: KindFilter = 'both',
  rangePoints: ActivityPoint[] = points,
): MonthBucket[] {
  const scoped = filterActivityPoints(points, kindFilter);
  const rangeKeys: string[] = [];
  for (const p of rangePoints) {
    const d = parseUtc(p.date);
    if (!d) continue;
    if (normaliseKind(p.kind) === 'other') continue;
    rangeKeys.push(monthKey(d));
  }
  if (rangeKeys.length === 0) return [];
  rangeKeys.sort();
  const first = rangeKeys[0]!;
  const last = rangeKeys[rangeKeys.length - 1]!;

  const counts = new Map<string, { posts: number; emails: number }>();
  for (const p of scoped) {
    const d = parseUtc(p.date);
    if (!d) continue;
    const kind = normaliseKind(p.kind);
    if (kind === 'other') continue;
    const key = monthKey(d);
    const cur = counts.get(key) ?? { posts: 0, emails: 0 };
    cur[kind] += 1;
    counts.set(key, cur);
  }

  const firstParts = first.split('-');
  const lastParts = last.split('-');
  let y = Number(firstParts[0]);
  let m = Number(firstParts[1]);
  const endY = Number(lastParts[0]);
  const endM = Number(lastParts[1]);
  if (![y, m, endY, endM].every(Number.isFinite)) return [];

  const result: MonthBucket[] = [];
  while (y < endY || (y === endY && m <= endM)) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    const c = counts.get(key) ?? { posts: 0, emails: 0 };
    const showYear = m === 1 || result.length === 0;
    result.push({
      key,
      label: monthLabel(key, showYear),
      posts: c.posts,
      emails: c.emails,
    });
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return result;
}

/**
 * Timed items by hour (0–23) in the given UTC offset.
 * "Both" sums e-mails and forum posts — it must not drop e-mails when timed posts exist.
 */
export function hourHistogram(
  points: ActivityPoint[],
  utcOffset = 0,
  kindFilter: KindFilter = 'both',
): HourHistogram {
  const scoped = filterActivityPoints(points, kindFilter);
  const timed = scoped.filter((p) => hasClock(p.date));
  const timedPosts = timed.filter((p) => normaliseKind(p.kind) === 'posts');
  const timedEmails = timed.filter((p) => normaliseKind(p.kind) === 'emails');
  const hours = Array.from({ length: 24 }, () => 0);
  for (const p of timed) {
    const d = parseUtc(p.date);
    if (!d) continue;
    const h = ((d.getUTCHours() + utcOffset) % 24 + 24) % 24;
    hours[h] = (hours[h] ?? 0) + 1;
  }
  return {
    hours,
    usedAllKinds: kindFilter === 'both' && timedEmails.length > 0 && timedPosts.length > 0,
    timedCount: timed.length,
  };
}

/** Width of the sliding peak-activity window (hours). */
export const PEAK_WINDOW_HOURS = 8;

/** Highest-count contiguous hour block, wrapping midnight. */
export function peakHourBlock(
  hours: readonly number[],
  windowHours: number = PEAK_WINDOW_HOURS,
): ActiveWindow | null {
  if (hours.length !== 24 || windowHours < 1 || windowHours > 24) return null;
  let bestStart = 0;
  let bestTotal = -1;
  for (let start = 0; start < 24; start++) {
    let total = 0;
    for (let i = 0; i < windowHours; i++) {
      total += hours[(start + i) % 24] ?? 0;
    }
    if (total > bestTotal) {
      bestTotal = total;
      bestStart = start;
    }
  }
  if (bestTotal <= 0) return null;

  return {
    startHour: bestStart,
    endHour: (bestStart + windowHours) % 24,
    total: bestTotal,
  };
}

export function formatUtcOffset(hours: number): string {
  if (hours === 0) return 'UTC';
  const sign = hours > 0 ? '+' : '−';
  const abs = Math.abs(hours);
  const whole = Math.trunc(abs);
  const mins = Math.round((abs - whole) * 60);
  if (mins === 0) return `UTC${sign}${whole}`;
  return `UTC${sign}${whole}:${String(mins).padStart(2, '0')}`;
}

export function formatHourLabel(hour: number): string {
  return `${String(((hour % 24) + 24) % 24).padStart(2, '0')}:00`;
}

export type DayPart = 'overnight' | 'morning' | 'afternoon' | 'evening';

/** Classify a contiguous hour window by which day-part most of its hours fall into. */
export function classifyDayPart(startHour: number, windowHours: number = PEAK_WINDOW_HOURS): DayPart {
  const scores: Record<DayPart, number> = {
    overnight: 0,
    morning: 0,
    afternoon: 0,
    evening: 0,
  };
  for (let i = 0; i < windowHours; i++) {
    const h = ((startHour + i) % 24 + 24) % 24;
    if (h >= 5 && h < 12) scores.morning += 1;
    else if (h >= 12 && h < 17) scores.afternoon += 1;
    else if (h >= 17 && h < 22) scores.evening += 1;
    else scores.overnight += 1; // 22–05
  }
  let best: DayPart = 'overnight';
  let bestScore = -1;
  for (const part of Object.keys(scores) as DayPart[]) {
    if (scores[part] > bestScore) {
      bestScore = scores[part];
      best = part;
    }
  }
  return best;
}

/** Plain-English reading of the peak window in the selected timezone. */
export function describeActiveWindow(
  startHour: number,
  _endHour: number,
  tzLabel: string,
  windowHours: number = PEAK_WINDOW_HOURS,
): string {
  const part = classifyDayPart(startHour, windowHours);
  switch (part) {
    case 'evening':
      return `In ${tzLabel} time that lands mainly in the evening — consistent with writing after a conventional workday.`;
    case 'afternoon':
      return `In ${tzLabel} time that lands mainly in the afternoon — daytime activity, not an after-work evening pattern.`;
    case 'morning':
      return `In ${tzLabel} time that lands mainly in the morning — a start-of-day pattern rather than evening hours.`;
    case 'overnight':
      return `In ${tzLabel} time that lands mainly overnight / in the small hours — not conventional evening activity in this zone.`;
  }
}

export function niceMax(n: number): number {
  if (n <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(n));
  const nrm = n / pow;
  const nice = nrm <= 1 ? 1 : nrm <= 2 ? 2 : nrm <= 5 ? 5 : 10;
  return nice * pow;
}

export function formatGeneratedAt(iso: string): string | null {
  const d = parseUtc(iso);
  if (!d) return null;
  return d.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  });
}
