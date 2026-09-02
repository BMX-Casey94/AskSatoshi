/**
 * Aggregate Satoshi activity points for the two chart views.
 * Dates are treated as UTC (ISO, sorted ascending from the API).
 */

import type { ActivityKind, ActivityPoint, SubjectActivity, SubjectId } from '../types';

export type KindFilter = 'both' | 'emails' | 'posts';
export type YearFilter = 'all' | number;

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

export function activityYear(iso: string): number | null {
  const d = parseUtc(iso);
  return d ? d.getUTCFullYear() : null;
}

export function availableYears(...groups: readonly (readonly ActivityPoint[])[]): number[] {
  const years = new Set<number>();
  for (const points of groups) {
    for (const p of points) {
      const y = activityYear(p.date);
      if (y != null) years.add(y);
    }
  }
  return [...years].sort((a, b) => a - b);
}

export function filterActivityPoints(
  points: readonly ActivityPoint[],
  kindFilter: KindFilter = 'both',
  yearFilter: YearFilter = 'all',
): ActivityPoint[] {
  return points.filter((p) => {
    if (kindFilter !== 'both' && normaliseKind(p.kind) !== kindFilter) return false;
    if (yearFilter !== 'all' && activityYear(p.date) !== yearFilter) return false;
    return true;
  });
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
  yearFilter: YearFilter = 'all',
): MonthBucket[] {
  const scoped = filterActivityPoints(points, kindFilter, yearFilter);
  if (yearFilter !== 'all') {
    const counts = countByMonth(scoped);
    return monthsInRange(`${yearFilter}-01`, `${yearFilter}-12`, counts);
  }
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

  return monthsInRange(first, last, countByMonth(scoped));
}

function countByMonth(points: readonly ActivityPoint[]): Map<string, { posts: number; emails: number }> {
  const counts = new Map<string, { posts: number; emails: number }>();
  for (const p of points) {
    const d = parseUtc(p.date);
    if (!d) continue;
    const kind = normaliseKind(p.kind);
    if (kind === 'other') continue;
    const key = monthKey(d);
    const cur = counts.get(key) ?? { posts: 0, emails: 0 };
    cur[kind] += 1;
    counts.set(key, cur);
  }
  return counts;
}

function monthsInRange(
  first: string,
  last: string,
  counts: Map<string, { posts: number; emails: number }>,
): MonthBucket[] {
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
  yearFilter: YearFilter = 'all',
): HourHistogram {
  const scoped = filterActivityPoints(points, kindFilter, yearFilter);
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

export type SubjectFilter = SubjectId | 'all';

export const SUBJECT_FILTERS: readonly { id: SubjectFilter; label: string }[] = [
  { id: 'satoshi', label: 'Satoshi' },
  { id: 'wright', label: 'Craig Wright' },
  { id: 'kleiman', label: 'Dave Kleiman' },
  { id: 'all', label: 'All' },
];

/** CSS custom-property names used to colour each subject on overlay charts. */
export const SUBJECT_COLOUR_VAR: Record<SubjectId, string> = {
  satoshi: 'var(--accent)',
  wright: 'var(--chart-wright)',
  kleiman: 'var(--chart-kleiman)',
};

export interface WeekdaySplit {
  weekday: number;
  weekend: number;
  weekdayPct: number;
  weekendPct: number;
}

export interface OverlayMonthSeries {
  id: SubjectId;
  label: string;
  totals: number[];
}

export interface AlignedMonthlyOverlay {
  keys: string[];
  labels: string[];
  series: OverlayMonthSeries[];
}

export interface OverlayHourSeries {
  id: SubjectId;
  label: string;
  hours: number[];
  timedCount: number;
  usedAllKinds: boolean;
}

export interface SubjectPeak {
  id: SubjectId;
  label: string;
  window: ActiveWindow | null;
  weekday: WeekdaySplit;
}

export interface OverlapRow {
  id: SubjectId;
  label: string;
  pct: number | null;
}

export interface JointEffortAssessment {
  looksComposite: boolean;
  summary: string;
}

export interface ActivityAnalysis {
  peaks: SubjectPeak[];
  overlaps: OverlapRow[];
  jointEffort: JointEffortAssessment;
}

function shiftUtc(iso: string, utcOffset: number): Date | null {
  const d = parseUtc(iso);
  if (!d) return null;
  return new Date(d.getTime() + utcOffset * 3_600_000);
}

function pct(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 100);
}

export function weekdaySplit(
  points: readonly ActivityPoint[],
  utcOffset = 0,
  kindFilter: KindFilter = 'both',
  yearFilter: YearFilter = 'all',
): WeekdaySplit {
  const scoped = filterActivityPoints(points, kindFilter, yearFilter);
  let weekday = 0;
  let weekend = 0;
  for (const p of scoped) {
    const d = shiftUtc(p.date, utcOffset);
    if (!d) continue;
    const day = d.getUTCDay();
    if (day === 0 || day === 6) weekend += 1;
    else weekday += 1;
  }
  const total = weekday + weekend;
  return {
    weekday,
    weekend,
    weekdayPct: pct(weekday, total),
    weekendPct: pct(weekend, total),
  };
}

export function hoursInWindow(startHour: number, windowHours: number = PEAK_WINDOW_HOURS): number[] {
  return Array.from({ length: windowHours }, (_, i) => (startHour + i) % 24);
}

export function sharedPeakOverlapPct(
  satoshiHours: readonly number[],
  candidateHours: readonly number[],
  windowHours: number = PEAK_WINDOW_HOURS,
): number | null {
  const satoshi = peakHourBlock(satoshiHours, windowHours);
  const candidate = peakHourBlock(candidateHours, windowHours);
  if (!satoshi || !candidate) return null;
  const theirs = new Set(hoursInWindow(candidate.startHour, windowHours));
  let shared = 0;
  for (const h of hoursInWindow(satoshi.startHour, windowHours)) {
    if (theirs.has(h)) shared += 1;
  }
  return pct(shared, windowHours);
}

function unionPeakOverlapPct(
  satoshiHours: readonly number[],
  wrightHours: readonly number[],
  kleimanHours: readonly number[],
  windowHours: number = PEAK_WINDOW_HOURS,
): number | null {
  const satoshi = peakHourBlock(satoshiHours, windowHours);
  const wright = peakHourBlock(wrightHours, windowHours);
  const kleiman = peakHourBlock(kleimanHours, windowHours);
  if (!satoshi || (!wright && !kleiman)) return null;
  const union = new Set<number>();
  if (wright) for (const h of hoursInWindow(wright.startHour, windowHours)) union.add(h);
  if (kleiman) for (const h of hoursInWindow(kleiman.startHour, windowHours)) union.add(h);
  let shared = 0;
  for (const h of hoursInWindow(satoshi.startHour, windowHours)) {
    if (union.has(h)) shared += 1;
  }
  return pct(shared, windowHours);
}

/** Distinct high-activity bands (circular), used to judge one person vs several. */
export function countSignificantHourClusters(hours: readonly number[]): number {
  if (hours.length !== 24) return 0;
  const max = hours.reduce((m, n) => Math.max(m, n), 0);
  if (max <= 0) return 0;
  const thresh = max * 0.35;
  const active = hours.map((n) => n >= thresh);
  if (!active.some(Boolean)) return 0;
  let runs = 0;
  for (let i = 0; i < 24; i++) {
    const prev = active[(i + 23) % 24]!;
    if (active[i] && !prev) runs += 1;
  }
  return runs === 0 ? 1 : runs;
}

export function assessJointEffort(
  satoshiHours: readonly number[],
  wrightHours: readonly number[],
  kleimanHours: readonly number[],
): JointEffortAssessment {
  const satoshiPeak = peakHourBlock(satoshiHours);
  if (!satoshiPeak) {
    return {
      looksComposite: false,
      summary:
        'There is not enough timed Satoshi activity to judge whether the pattern is one person or several.',
    };
  }

  const timed = satoshiHours.reduce((sum, n) => sum + n, 0);
  const concentration = timed > 0 ? satoshiPeak.total / timed : 0;
  const clusters = countSignificantHourClusters(satoshiHours);
  const spread = concentration < 0.5 || clusters >= 2;

  const wOverlap = sharedPeakOverlapPct(satoshiHours, wrightHours);
  const kOverlap = sharedPeakOverlapPct(satoshiHours, kleimanHours);
  const unionOverlap = unionPeakOverlapPct(satoshiHours, wrightHours, kleimanHours);
  const bestSolo = Math.max(wOverlap ?? 0, kOverlap ?? 0);
  const unionBeatsBoth =
    unionOverlap != null && wOverlap != null && kOverlap != null && unionOverlap >= bestSolo + 25;

  const looksComposite = spread || unionBeatsBoth;

  if (unionBeatsBoth) {
    return {
      looksComposite: true,
      summary:
        "Wright and Kleiman's peak hours together cover more of Satoshi's active window than either does alone, so a joint effort is not ruled out.",
    };
  }
  if (looksComposite) {
    return {
      looksComposite: true,
      summary:
        "Satoshi's timed activity is spread across more than one cluster of hours, which is what you would expect if more than one person was writing under the name — or if one person kept irregular hours.",
    };
  }
  return {
    looksComposite: false,
    summary:
      "Satoshi's timed activity clusters in one stretch of the day — consistent with a single person's sleeping pattern.",
  };
}

export function alignedMonthlyOverlay(
  subjects: readonly SubjectActivity[],
  kindFilter: KindFilter = 'both',
  yearFilter: YearFilter = 'all',
): AlignedMonthlyOverlay {
  const rangePoints = subjects.flatMap((s) => s.points);
  const frame = monthlyBuckets(rangePoints, kindFilter, rangePoints, yearFilter);
  return {
    keys: frame.map((b) => b.key),
    labels: frame.map((b) => b.label),
    series: subjects.map((s) => {
      const buckets = monthlyBuckets(s.points, kindFilter, rangePoints, yearFilter);
      const byKey = new Map(buckets.map((b) => [b.key, b.posts + b.emails]));
      return {
        id: s.id,
        label: s.label,
        totals: frame.map((b) => byKey.get(b.key) ?? 0),
      };
    }),
  };
}

export function overlayHourSeries(
  subjects: readonly SubjectActivity[],
  utcOffset = 0,
  kindFilter: KindFilter = 'both',
  yearFilter: YearFilter = 'all',
): OverlayHourSeries[] {
  return subjects.map((s) => {
    const hist = hourHistogram(s.points, utcOffset, kindFilter, yearFilter);
    return {
      id: s.id,
      label: s.label,
      hours: hist.hours,
      timedCount: hist.timedCount,
      usedAllKinds: hist.usedAllKinds,
    };
  });
}

export function analyseActivity(
  subjects: readonly SubjectActivity[],
  utcOffset = 0,
  kindFilter: KindFilter = 'both',
  yearFilter: YearFilter = 'all',
): ActivityAnalysis {
  const peaks: SubjectPeak[] = subjects.map((s) => {
    const hist = hourHistogram(s.points, utcOffset, kindFilter, yearFilter);
    return {
      id: s.id,
      label: s.label,
      window: peakHourBlock(hist.hours),
      weekday: weekdaySplit(s.points, utcOffset, kindFilter, yearFilter),
    };
  });

  const satoshi = subjects.find((s) => s.id === 'satoshi');
  const satoshiHours = satoshi
    ? hourHistogram(satoshi.points, utcOffset, kindFilter, yearFilter).hours
    : Array.from({ length: 24 }, () => 0);

  const overlaps: OverlapRow[] = subjects
    .filter((s) => s.id !== 'satoshi')
    .map((s) => ({
      id: s.id,
      label: s.label,
      pct: sharedPeakOverlapPct(
        satoshiHours,
        hourHistogram(s.points, utcOffset, kindFilter, yearFilter).hours,
      ),
    }));

  const wright = subjects.find((s) => s.id === 'wright');
  const kleiman = subjects.find((s) => s.id === 'kleiman');
  const jointEffort = assessJointEffort(
    satoshiHours,
    wright ? hourHistogram(wright.points, utcOffset, kindFilter, yearFilter).hours : Array.from({ length: 24 }, () => 0),
    kleiman ? hourHistogram(kleiman.points, utcOffset, kindFilter, yearFilter).hours : Array.from({ length: 24 }, () => 0),
  );

  return { peaks, overlaps, jointEffort };
}
