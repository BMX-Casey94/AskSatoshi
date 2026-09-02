import { describe, expect, it } from 'vitest';
import type { ActivityPoint, SubjectActivity } from '../types';
import {
  alignedMonthlyOverlay,
  analyseActivity,
  availableYears,
  filterActivityPoints,
  hourHistogram,
  monthlyBuckets,
  overlayHourSeries,
  sharedPeakOverlapPct,
  weekdaySplit,
} from './satoshiActivity';

function pt(date: string, kind = 'post'): ActivityPoint {
  return { date, kind, title: 't', url: 'https://example.com/x' };
}

function subject(
  id: SubjectActivity['id'],
  label: string,
  points: ActivityPoint[],
): SubjectActivity {
  const emails = points.filter((p) => p.kind === 'email' || p.kind === 'emails').length;
  const posts = points.length - emails;
  return { id, label, total: points.length, byKind: { emails, posts }, points };
}

describe('weekdaySplit', () => {
  it('splits weekday and weekend in UTC', () => {
    const points = [
      pt('2009-01-05T12:00:00Z'), // Monday
      pt('2009-01-06T12:00:00Z'), // Tuesday
      pt('2009-01-10T12:00:00Z'), // Saturday
    ];
    const split = weekdaySplit(points, 0);
    expect(split.weekday).toBe(2);
    expect(split.weekend).toBe(1);
    expect(split.weekdayPct).toBe(67);
    expect(split.weekendPct).toBe(33);
  });

  it('lets a timezone offset move Friday night UTC onto Saturday', () => {
    const points = [pt('2009-01-02T22:00:00Z')]; // Friday 22:00 UTC
    expect(weekdaySplit(points, 0).weekday).toBe(1);
    expect(weekdaySplit(points, 10).weekend).toBe(1);
    expect(weekdaySplit(points, 10).weekday).toBe(0);
  });

  it('honours the kind filter and treats an empty set as zeros', () => {
    const points = [pt('2009-01-05T12:00:00Z', 'post'), pt('2009-01-10T12:00:00Z', 'email')];
    expect(weekdaySplit(points, 0, 'emails')).toEqual({
      weekday: 0,
      weekend: 1,
      weekdayPct: 0,
      weekendPct: 100,
    });
    expect(weekdaySplit([], 0)).toEqual({
      weekday: 0,
      weekend: 0,
      weekdayPct: 0,
      weekendPct: 0,
    });
  });
});

describe('sharedPeakOverlapPct', () => {
  it('is 100 when both series share the same peak window', () => {
    const hours = Array.from({ length: 24 }, (_, h) => (h >= 10 && h < 18 ? 5 : 0));
    expect(sharedPeakOverlapPct(hours, hours)).toBe(100);
  });

  it('is 0 when peak windows do not overlap', () => {
    const morning = Array.from({ length: 24 }, (_, h) => (h >= 6 && h < 14 ? 4 : 0));
    const evening = Array.from({ length: 24 }, (_, h) => (h >= 16 && h < 24 ? 4 : 0));
    expect(sharedPeakOverlapPct(morning, evening)).toBe(0);
  });

  it('returns null when either series has no timed activity', () => {
    const hours = Array.from({ length: 24 }, (_, h) => (h === 12 ? 3 : 0));
    const empty = Array.from({ length: 24 }, () => 0);
    expect(sharedPeakOverlapPct(hours, empty)).toBeNull();
    expect(sharedPeakOverlapPct(empty, hours)).toBeNull();
  });
});

describe('alignedMonthlyOverlay', () => {
  it('aligns every subject to the union of month keys', () => {
    const overlay = alignedMonthlyOverlay([
      subject('satoshi', 'Satoshi', [pt('2009-01-15T12:00:00Z'), pt('2009-03-01T12:00:00Z')]),
      subject('wright', 'Craig Wright', [pt('2009-02-10T12:00:00Z')]),
      subject('kleiman', 'Dave Kleiman', []),
    ]);
    expect(overlay.keys).toEqual(['2009-01', '2009-02', '2009-03']);
    expect(overlay.series.map((s) => s.id)).toEqual(['satoshi', 'wright', 'kleiman']);
    expect(overlay.series[0]?.totals).toEqual([1, 0, 1]);
    expect(overlay.series[1]?.totals).toEqual([0, 1, 0]);
    expect(overlay.series[2]?.totals).toEqual([0, 0, 0]);
  });
});

describe('overlayHourSeries', () => {
  it('returns a 24-hour histogram per subject in the given offset', () => {
    const series = overlayHourSeries(
      [
        subject('satoshi', 'Satoshi', [pt('2009-01-05T14:00:00Z')]),
        subject('wright', 'Craig Wright', [pt('2009-01-05T14:00:00Z')]),
      ],
      2,
    );
    expect(series).toHaveLength(2);
    expect(series[0]?.hours[16]).toBe(1);
    expect(series[1]?.hours[16]).toBe(1);
    expect(series[0]?.timedCount).toBe(1);
  });
});

describe('analyseActivity', () => {
  it('reports peak hours, weekday split, overlap, and a single-person note for a unimodal Satoshi', () => {
    const satoshiPts = Array.from({ length: 8 }, (_, i) =>
      pt(`2009-01-05T${String(10 + i).padStart(2, '0')}:00:00Z`),
    );
    const analysis = analyseActivity(
      [
        subject('satoshi', 'Satoshi Nakamoto', satoshiPts),
        subject('wright', 'Craig Wright', []),
        subject('kleiman', 'Dave Kleiman', []),
      ],
      0,
    );
    expect(analysis.peaks[0]?.window?.startHour).toBe(10);
    expect(analysis.peaks[0]?.weekday.weekday).toBe(8);
    expect(analysis.overlaps).toEqual([
      { id: 'wright', label: 'Craig Wright', pct: null },
      { id: 'kleiman', label: 'Dave Kleiman', pct: null },
    ]);
    expect(analysis.jointEffort.looksComposite).toBe(false);
    expect(analysis.jointEffort.summary).toMatch(/single person/i);
  });

  it('flags a composite when Satoshi has two distant hour clusters', () => {
    const satoshiPts = [
      ...Array.from({ length: 4 }, (_, i) => pt(`2009-01-05T${String(8 + i).padStart(2, '0')}:00:00Z`)),
      ...Array.from({ length: 4 }, (_, i) => pt(`2009-01-05T${String(20 + i).padStart(2, '0')}:00:00Z`)),
    ];
    const analysis = analyseActivity(
      [subject('satoshi', 'Satoshi Nakamoto', satoshiPts), subject('wright', 'Craig Wright', []), subject('kleiman', 'Dave Kleiman', [])],
      0,
    );
    expect(analysis.jointEffort.looksComposite).toBe(true);
    expect(analysis.jointEffort.summary).toMatch(/more than one person|composite/i);
  });
});

describe('year filter', () => {
  const mixed = [
    pt('2008-11-01T12:00:00Z', 'email'),
    pt('2009-01-15T18:00:00Z', 'post'),
    pt('2009-06-02T09:00:00Z', 'email'),
    pt('2010-03-01T12:00:00Z', 'post'),
  ];

  it('lists unique years in order', () => {
    expect(availableYears(mixed)).toEqual([2008, 2009, 2010]);
  });

  it('filters points to one calendar year', () => {
    expect(filterActivityPoints(mixed, 'both', 2009).map((p) => p.date)).toEqual([
      '2009-01-15T18:00:00Z',
      '2009-06-02T09:00:00Z',
    ]);
  });

  it('pins the monthly axis to January–December of the selected year', () => {
    const buckets = monthlyBuckets(mixed, 'both', mixed, 2009);
    expect(buckets).toHaveLength(12);
    expect(buckets[0]?.key).toBe('2009-01');
    expect(buckets[11]?.key).toBe('2009-12');
    expect(buckets.reduce((n, b) => n + b.posts + b.emails, 0)).toBe(2);
  });

  it('limits the hour histogram to that year', () => {
    const hist = hourHistogram(mixed, 0, 'both', 2009);
    expect(hist.timedCount).toBe(2);
    expect(hist.hours[18]).toBe(1);
    expect(hist.hours[9]).toBe(1);
  });
});
