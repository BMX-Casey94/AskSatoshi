/**
 * /satoshi-activity — posts and e-mails over time, and posts by hour of day.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { getSatoshiActivity } from '../lib/api';
import { Link } from '../lib/router';
import { loadStore, saveStore } from '../lib/storage';
import type { SatoshiActivityResponse } from '../types';
import {
  formatGeneratedAt,
  formatHourLabel,
  formatUtcOffset,
  hourHistogram,
  monthlyBuckets,
  peakFourHourBlock,
} from '../lib/satoshiActivity';
import { HourlyChart, MonthlyChart } from './ActivityCharts';
import { HomeIcon } from './icons';
import { ThemeToggle } from './ThemeToggle';

type View = 'monthly' | 'hourly';
type LoadState = 'loading' | 'ready' | 'error';

export function SatoshiActivityPage() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => loadStore().theme ?? 'light');
  const [state, setState] = useState<LoadState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<SatoshiActivityResponse | null>(null);
  const [view, setView] = useState<View>('monthly');

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

  const months = useMemo(() => (data ? monthlyBuckets(data.points) : []), [data]);
  const hourly = useMemo(() => (data ? hourHistogram(data.points) : null), [data]);
  const activeWindow = useMemo(() => (hourly ? peakFourHourBlock(hourly.hours) : null), [hourly]);
  const compiled = data ? formatGeneratedAt(data.generatedAt) : null;

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
          Posts and e-mails from the public record, plotted over time and by hour of day
          (UTC). The hour view is a heuristic for when he was awake — not a proof of
          location.
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

        {state === 'ready' && data && (
          <>
            <section className="activity-stats" aria-label="Totals">
              <Stat label="Total" value={data.total} />
              <Stat label="Posts" value={data.byKind.posts} />
              <Stat label="E-mails" value={data.byKind.emails} />
            </section>
            {compiled && <p className="activity-meta">Compiled {compiled}</p>}

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

            <section className="activity-panel" aria-live="polite">
              {view === 'monthly' ? (
                <>
                  <h2 className="activity-panel-title">Posts and e-mails per month</h2>
                  <MonthlyChart buckets={months} />
                </>
              ) : (
                <>
                  <h2 className="activity-panel-title">Posts by hour of day (UTC)</h2>
                  {hourly?.usedAllKinds && (
                    <p className="activity-note">
                      Timed forum posts were scarce, so e-mails and other dated items are
                      included in this histogram.
                    </p>
                  )}
                  {hourly && (
                    <HourlyChart histogram={hourly} windowStart={activeWindow?.startHour ?? null} />
                  )}
                  {activeWindow ? (
                    <div className="activity-window">
                      <h3 className="activity-window-title">Likely active window</h3>
                      <p>
                        Peak four-hour block:{' '}
                        <strong>
                          {formatHourLabel(activeWindow.startHour)}–{formatHourLabel(activeWindow.endHour)} UTC
                        </strong>{' '}
                        ({activeWindow.total} timed item{activeWindow.total === 1 ? '' : 's'}).
                      </p>
                      <p>
                        If that stretch was evening (19:00–23:00 local time), it implies
                        roughly <strong>{formatUtcOffset(activeWindow.impliedOffsetHours)}</strong>.
                        That assumption is the usual “he wrote after work” reading — a
                        morning person, or someone posting on a schedule, would land
                        elsewhere.
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
