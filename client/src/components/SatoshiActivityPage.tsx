/**
 * /satoshi-activity — posts and e-mails over time, and posts by hour of day.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { getSatoshiActivity, getSubjectActivity } from '../lib/api';
import { Link } from '../lib/router';
import { loadStore, saveStore } from '../lib/storage';
import type { ActivityResponse, SubjectActivity } from '../types';
import {
  TIMEZONES,
  SUBJECT_FILTERS,
  availableYears,
  formatGeneratedAt,
  formatHourLabel,
  filterActivityPoints,
  hourHistogram,
  monthlyBuckets,
  PEAK_WINDOW_HOURS,
  describeActiveWindow,
  peakHourBlock,
  alignedMonthlyOverlay,
  overlayHourSeries,
  analyseActivity,
} from '../lib/satoshiActivity';
import type { ActivityAnalysis, KindFilter, SubjectFilter, TimeZone, YearFilter } from '../lib/satoshiActivity';
import { HourlyChart, MonthlyChart } from './ActivityCharts';
import { HomeIcon } from './icons';
import { ThemeToggle } from './ThemeToggle';

type View = 'monthly' | 'hourly';
type ChartMode = 'bar' | 'line';
type LoadState = 'loading' | 'ready' | 'error';

export function SatoshiActivityPage() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => loadStore().theme ?? 'light');
  const [state, setState] = useState<LoadState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ActivityResponse | null>(null);
  const [view, setView] = useState<View>('monthly');
  const [chartMode, setChartMode] = useState<ChartMode>('bar');
  const [tz, setTz] = useState<TimeZone>(TIMEZONES[0]!);
  const [kindFilter, setKindFilter] = useState<KindFilter>('both');
  const [subjectFilter, setSubjectFilter] = useState<SubjectFilter>('satoshi');
  const [yearFilter, setYearFilter] = useState<YearFilter>('all');

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    const store = loadStore();
    saveStore({ ...store, theme });
  }, [theme]);

  const load = useCallback((signal?: AbortSignal) => {
    setState('loading');
    setError(null);
    void getSatoshiActivity(signal)
      .then((res) => {
        if (signal?.aborted) return;
        setData(res);
        setState('ready');
      })
      .catch((err: unknown) => {
        if (signal?.aborted) return;
        setData(null);
        setError(err instanceof Error ? err.message : 'The activity record could not be loaded.');
        setState('error');
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const overlay = subjectFilter === 'all';
  const subject: SubjectActivity | undefined =
    data && !overlay ? getSubjectActivity(subjectFilter, data) : undefined;
  const subjects = data?.subjects ?? [];

  const years = useMemo(
    () => availableYears(...subjects.map((s) => s.points)),
    [subjects],
  );
  const months = useMemo(
    () => (subject ? monthlyBuckets(subject.points, kindFilter, subject.points, yearFilter) : []),
    [subject, kindFilter, yearFilter],
  );
  const monthOverlay = useMemo(
    () => (overlay && subjects.length > 0 ? alignedMonthlyOverlay(subjects, kindFilter, yearFilter) : null),
    [overlay, subjects, kindFilter, yearFilter],
  );
  const hourly = useMemo(
    () => (subject ? hourHistogram(subject.points, tz.offset, kindFilter, yearFilter) : null),
    [subject, tz, kindFilter, yearFilter],
  );
  const hourOverlay = useMemo(
    () =>
      overlay && subjects.length > 0
        ? overlayHourSeries(subjects, tz.offset, kindFilter, yearFilter)
        : null,
    [overlay, subjects, tz, kindFilter, yearFilter],
  );
  const activeWindow = useMemo(() => (hourly ? peakHourBlock(hourly.hours) : null), [hourly]);
  const analysis = useMemo(
    () => (subjects.length > 0 ? analyseActivity(subjects, tz.offset, kindFilter, yearFilter) : null),
    [subjects, tz, kindFilter, yearFilter],
  );
  const compiled = data ? formatGeneratedAt(data.generatedAt) : null;
  const stats = useMemo(() => {
    const rows = overlay ? subjects : subject ? [subject] : [];
    let emails = 0;
    let posts = 0;
    for (const row of rows) {
      for (const p of filterActivityPoints(row.points, kindFilter, yearFilter)) {
        if (p.kind === 'email' || p.kind === 'emails') emails += 1;
        else posts += 1;
      }
    }
    return { total: emails + posts, emails, posts };
  }, [overlay, subjects, subject, kindFilter, yearFilter]);

  const emptyHistogram = useMemo(
    () => ({ hours: Array.from({ length: 24 }, () => 0), usedAllKinds: false, timedCount: 0 }),
    [],
  );

  const yearSuffix = yearFilter === 'all' ? '' : ` · ${yearFilter}`;
  const monthlyTitle =
    kindFilter === 'emails'
      ? `E-mails per month${yearSuffix}`
      : kindFilter === 'posts'
        ? `Posts per month${yearSuffix}`
        : `Posts and e-mails per month${yearSuffix}`;
  const hourlyTitle =
    kindFilter === 'emails'
      ? `E-mails by hour of day (${tz.label})${yearSuffix}`
      : kindFilter === 'posts'
        ? `Forum posts by hour of day (${tz.label})${yearSuffix}`
        : `Posts and e-mails by hour of day (${tz.label})${yearSuffix}`;

  const ready = state === 'ready' && data && (overlay || subject);

  return (
    <div className="activity">
      <header className="activity-header">
        <Link href="/" className="icon-btn" aria-label="Back to home" title="Back to home">
          <HomeIcon size={18} />
        </Link>
        <h1 className="activity-title">Satoshi activity</h1>
        <div className="activity-header-end">
          <ThemeToggle theme={theme} onToggle={() => setTheme(theme === 'light' ? 'dark' : 'light')} />
        </div>
      </header>

      <main className="activity-main">
        <p className="activity-lead">
          Posts and e-mails from the public record, plotted over time and by hour of day.
          The hour view is a heuristic for when he was awake — not a proof of location.
        </p>

        {state === 'loading' && (
          <div className="activity-status" role="status" aria-live="polite">
            Loading the activity record…
          </div>
        )}

        {state === 'error' && (
          <div className="activity-status activity-status--error" role="alert">
            <p>{error ?? 'The activity record could not be loaded.'}</p>
            <button type="button" className="activity-retry" onClick={() => load()}>
              Try again
            </button>
          </div>
        )}

        {ready && data && (
          <>
            <section className="activity-stats" aria-label="Totals">
              <Stat label="Total" value={stats.total} />
              <Stat label="Posts" value={stats.posts} />
              <Stat label="E-mails" value={stats.emails} />
            </section>
            {compiled && <p className="activity-meta">Compiled {compiled}</p>}

            <div className="activity-controls">
              <div className="activity-toggle" role="tablist" aria-label="Subject">
                {SUBJECT_FILTERS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    role="tab"
                    aria-selected={subjectFilter === opt.id}
                    className={`activity-toggle-btn${subjectFilter === opt.id ? ' activity-toggle-btn--on' : ''}`}
                    onClick={() => setSubjectFilter(opt.id)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>

              <div className="activity-toggle" role="tablist" aria-label="Chart view">
                <button
                  type="button"
                  role="tab"
                  aria-selected={view === 'monthly'}
                  className={`activity-toggle-btn${view === 'monthly' ? ' activity-toggle-btn--on' : ''}`}
                  onClick={() => setView('monthly')}
                >
                  Over time
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={view === 'hourly'}
                  className={`activity-toggle-btn${view === 'hourly' ? ' activity-toggle-btn--on' : ''}`}
                  onClick={() => setView('hourly')}
                >
                  By hour
                </button>
              </div>

              <div className="activity-toggle" role="tablist" aria-label="Chart style">
                <button
                  type="button"
                  role="tab"
                  aria-selected={chartMode === 'bar' && !(overlay && view === 'hourly')}
                  aria-disabled={overlay && view === 'hourly'}
                  disabled={overlay && view === 'hourly'}
                  className={`activity-toggle-btn${chartMode === 'bar' && !(overlay && view === 'hourly') ? ' activity-toggle-btn--on' : ''}`}
                  onClick={() => setChartMode('bar')}
                >
                  Bar
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={chartMode === 'line' || (overlay && view === 'hourly')}
                  className={`activity-toggle-btn${chartMode === 'line' || (overlay && view === 'hourly') ? ' activity-toggle-btn--on' : ''}`}
                  onClick={() => setChartMode('line')}
                >
                  Line
                </button>
              </div>

              <div className="activity-toggle" role="tablist" aria-label="Kind filter">
                <button
                  type="button"
                  role="tab"
                  aria-selected={kindFilter === 'both'}
                  className={`activity-toggle-btn${kindFilter === 'both' ? ' activity-toggle-btn--on' : ''}`}
                  onClick={() => setKindFilter('both')}
                >
                  Both
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={kindFilter === 'emails'}
                  className={`activity-toggle-btn${kindFilter === 'emails' ? ' activity-toggle-btn--on' : ''}`}
                  onClick={() => setKindFilter('emails')}
                >
                  E-mails
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={kindFilter === 'posts'}
                  className={`activity-toggle-btn${kindFilter === 'posts' ? ' activity-toggle-btn--on' : ''}`}
                  onClick={() => setKindFilter('posts')}
                >
                  Forum posts
                </button>
              </div>
            </div>

            {years.length > 0 && (
              <div className="activity-years" role="tablist" aria-label="Year">
                <button
                  type="button"
                  role="tab"
                  aria-selected={yearFilter === 'all'}
                  className={`activity-tz-btn${yearFilter === 'all' ? ' activity-tz-btn--on' : ''}`}
                  onClick={() => setYearFilter('all')}
                >
                  All years
                </button>
                {years.map((year) => (
                  <button
                    key={year}
                    type="button"
                    role="tab"
                    aria-selected={yearFilter === year}
                    className={`activity-tz-btn${yearFilter === year ? ' activity-tz-btn--on' : ''}`}
                    onClick={() => setYearFilter(year)}
                  >
                    {year}
                  </button>
                ))}
              </div>
            )}

            <section className="activity-panel" aria-live="polite">
              {view === 'monthly' ? (
                <>
                  <h2 className="activity-panel-title">{monthlyTitle}</h2>
                  <MonthlyChart
                    buckets={months}
                    mode={chartMode}
                    kindFilter={kindFilter}
                    overlay={monthOverlay}
                  />
                </>
              ) : (
                <>
                  <h2 className="activity-panel-title">{hourlyTitle}</h2>
                  {(hourly?.usedAllKinds || hourOverlay?.some((s) => s.usedAllKinds)) && (
                    <p className="activity-note">
                      This histogram includes both timed forum posts and e-mails.
                    </p>
                  )}
                  {overlay && view === 'hourly' && (
                    <p className="activity-note">Hourly overlay uses lines so the three series stay readable.</p>
                  )}
                  <HourlyChart
                    histogram={hourly ?? emptyHistogram}
                    windowStart={activeWindow?.startHour ?? null}
                    windowHours={PEAK_WINDOW_HOURS}
                    tz={tz}
                    mode={chartMode}
                    overlay={hourOverlay}
                  />

                  <div className="activity-tz" role="group" aria-label="Timezone">
                    {TIMEZONES.map((z) => (
                      <button
                        key={z.id}
                        type="button"
                        className={`activity-tz-btn${tz.id === z.id ? ' activity-tz-btn--on' : ''}`}
                        onClick={() => setTz(z)}
                      >
                        {z.label}
                      </button>
                    ))}
                  </div>

                  {overlay ? (
                    <OverlayActiveWindows analysis={analysis} tz={tz} />
                  ) : activeWindow ? (
                    <div className="activity-window">
                      <h3 className="activity-window-title">Likely active window</h3>
                      <p>
                        Peak {PEAK_WINDOW_HOURS}-hour block:{' '}
                        <strong>
                          {formatHourLabel(activeWindow.startHour)}–{formatHourLabel(activeWindow.endHour)} {tz.label}
                        </strong>{' '}
                        ({activeWindow.total} timed item{activeWindow.total === 1 ? '' : 's'}).
                      </p>
                      <p>
                        {describeActiveWindow(
                          activeWindow.startHour,
                          activeWindow.endHour,
                          tz.label,
                          PEAK_WINDOW_HOURS,
                        )}
                      </p>
                    </div>
                  ) : (
                    <p className="activity-empty">
                      Not enough timed posts to infer an active window.
                    </p>
                  )}
                </>
              )}
            </section>

            {analysis && <ActivityAnalysisPanel analysis={analysis} tz={tz} yearFilter={yearFilter} />}
          </>
        )}
      </main>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="activity-stat">
      <span className="activity-stat-value">{value.toLocaleString('en-GB')}</span>
      <span className="activity-stat-label">{label}</span>
    </div>
  );
}

function OverlayActiveWindows({
  analysis,
  tz,
}: {
  analysis: ActivityAnalysis | null;
  tz: TimeZone;
}) {
  if (!analysis) return null;
  return (
    <div className="activity-window">
      <h3 className="activity-window-title">Likely active windows</h3>
      <ul className="activity-analysis-list">
        {analysis.peaks.map((p) => (
          <li key={p.id}>
            <span className={`activity-swatch activity-swatch--${p.id}`} aria-hidden="true" />
            <span>
              <strong>{p.label}:</strong>{' '}
              {p.window
                ? `${formatHourLabel(p.window.startHour)}–${formatHourLabel(p.window.endHour)} ${tz.label} (${p.window.total} timed item${p.window.total === 1 ? '' : 's'})`
                : 'not enough timed items'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ActivityAnalysisPanel({
  analysis,
  tz,
  yearFilter,
}: {
  analysis: ActivityAnalysis;
  tz: TimeZone;
  yearFilter: YearFilter;
}) {
  return (
    <details className="activity-analysis">
      <summary className="activity-analysis-summary">Activity analysis</summary>
      <div className="activity-analysis-body">
        <section className="activity-analysis-block">
          <h3>Peak hours</h3>
          <p className="activity-analysis-lead">
            Highest-count {PEAK_WINDOW_HOURS}-hour block in {tz.label}
            {yearFilter === 'all' ? '' : ` for ${yearFilter}`}.
          </p>
          <ul className="activity-analysis-list">
            {analysis.peaks.map((p) => (
              <li key={p.id}>
                <span className={`activity-swatch activity-swatch--${p.id}`} aria-hidden="true" />
                <span>
                  <strong>{p.label}:</strong>{' '}
                  {p.window
                    ? `${formatHourLabel(p.window.startHour)}–${formatHourLabel(p.window.endHour)} (${p.window.total} timed item${p.window.total === 1 ? '' : 's'})`
                    : 'not enough timed items'}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="activity-analysis-block">
          <h3>Day of week</h3>
          <p className="activity-analysis-lead">Weekday versus weekend split in {tz.label}.</p>
          <ul className="activity-analysis-list">
            {analysis.peaks.map((p) => {
              const total = p.weekday.weekday + p.weekday.weekend;
              return (
                <li key={p.id}>
                  <span className={`activity-swatch activity-swatch--${p.id}`} aria-hidden="true" />
                  <span>
                    <strong>{p.label}:</strong>{' '}
                    {total === 0
                      ? 'no dated items'
                      : `${p.weekday.weekdayPct}% weekday · ${p.weekday.weekendPct}% weekend (${total.toLocaleString('en-GB')} item${total === 1 ? '' : 's'})`}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="activity-analysis-block">
          <h3>Overlap with Satoshi</h3>
          <p className="activity-analysis-lead">
            Share of Satoshi&apos;s peak hours that also fall in each candidate&apos;s peak window.
          </p>
          <ul className="activity-analysis-list">
            {analysis.overlaps.map((row) => (
              <li key={row.id}>
                <span className={`activity-swatch activity-swatch--${row.id}`} aria-hidden="true" />
                <span>
                  <strong>{row.label}:</strong>{' '}
                  {row.pct == null
                    ? 'cannot be scored — no timed record'
                    : `${row.pct}% of Satoshi's peak hours`}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="activity-analysis-block">
          <h3>Joint effort</h3>
          <p>{analysis.jointEffort.summary}</p>
        </section>
      </div>
    </details>
  );
}
