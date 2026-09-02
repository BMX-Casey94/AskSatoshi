/**
 * Hand-rolled SVG charts for Satoshi activity — no chart library.
 */

import { useState, type MouseEvent } from 'react';
import type {
  AlignedMonthlyOverlay,
  HourHistogram,
  KindFilter,
  MonthBucket,
  OverlayHourSeries,
  OverlayMonthSeries,
  TimeZone,
} from '../lib/satoshiActivity';
import { formatHourLabel, niceMax } from '../lib/satoshiActivity';
import type { SubjectId } from '../types';

interface Tip {
  x: number;
  y: number;
  text: string;
}

function ChartTip({ tip }: { tip: Tip | null }) {
  if (!tip) return null;
  return (
    <div className="activity-tip" style={{ left: tip.x, top: tip.y }} role="tooltip">
      {tip.text}
    </div>
  );
}

function yTicks(max: number): number[] {
  if (max <= 1) return [0, 1];
  if (max <= 4) return Array.from({ length: max + 1 }, (_, i) => i);
  return [0, max / 2, max];
}

function seriesClass(kind: 'bar' | 'line' | 'dot' | 'swatch', id: SubjectId): string {
  return `activity-${kind} activity-${kind}--${id}`;
}

function tipFromEvent(e: MouseEvent<SVGGElement>, text: string): Tip | null {
  const rect = e.currentTarget.ownerSVGElement?.parentElement?.getBoundingClientRect();
  if (!rect) return null;
  return { x: e.clientX - rect.left + 12, y: e.clientY - rect.top - 8, text };
}

function SubjectLegend({ series }: { series: { id: SubjectId; label: string }[] }) {
  return (
    <ul className="activity-legend" aria-label="Subjects">
      {series.map((s) => (
        <li key={s.id}>
          <span className={seriesClass('swatch', s.id)} aria-hidden="true" />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Monthly chart (bar or line)
// ---------------------------------------------------------------------------

interface MonthlyProps {
  buckets: MonthBucket[];
  mode: 'bar' | 'line';
  kindFilter?: KindFilter;
  overlay?: AlignedMonthlyOverlay | null;
}

export function MonthlyChart({ buckets, mode, kindFilter = 'both', overlay = null }: MonthlyProps) {
  if (overlay) {
    return <MonthlyOverlayChart overlay={overlay} mode={mode} />;
  }
  return <MonthlySingleChart buckets={buckets} mode={mode} kindFilter={kindFilter} />;
}

function MonthlySingleChart({
  buckets,
  mode,
  kindFilter = 'both',
}: {
  buckets: MonthBucket[];
  mode: 'bar' | 'line';
  kindFilter?: KindFilter;
}) {
  const [tip, setTip] = useState<Tip | null>(null);
  if (buckets.length === 0) {
    return <p className="activity-empty">No dated posts or e-mails to plot.</p>;
  }

  const rawMax = buckets.reduce((m, b) => Math.max(m, b.posts + b.emails), 0);
  const yMax = niceMax(rawMax);
  const W = 720;
  const H = 280;
  const pad = { l: 44, r: 16, t: 16, b: 44 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  const band = innerW / buckets.length;
  const barW = Math.max(2, band * 0.62);

  const maxLabels = Math.floor(innerW / 52);
  const labelEvery = Math.max(1, Math.ceil(buckets.length / maxLabels));

  const hideTip = () => setTip(null);

  const linePoints = buckets.map((b, i) => ({
    x: pad.l + i * band + band / 2,
    y: pad.t + innerH - ((b.posts + b.emails) / yMax) * innerH,
    posts: b.posts,
    emails: b.emails,
    key: b.key,
    label: b.label,
  }));

  const polyline = linePoints.map((p) => `${p.x},${p.y}`).join(' ');

  return (
    <div className="activity-chart-wrap">
      <svg
        className="activity-chart"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Posts and e-mails per month"
        onMouseLeave={hideTip}
      >
        {yTicks(yMax).map((v) => {
          const y = pad.t + innerH - (v / yMax) * innerH;
          return (
            <g key={`y-${v}`}>
              <line x1={pad.l} x2={W - pad.r} y1={y} y2={y} className="activity-grid" />
              <text x={pad.l - 8} y={y + 3.5} textAnchor="end" className="activity-axis">
                {Number.isInteger(v) ? v : v.toFixed(1)}
              </text>
            </g>
          );
        })}

        {mode === 'bar'
          ? buckets.map((b, i) => {
              const x = pad.l + i * band + (band - barW) / 2;
              const total = b.posts + b.emails;
              const hPosts = (b.posts / yMax) * innerH;
              const hEmails = (b.emails / yMax) * innerH;
              const yPosts = pad.t + innerH - hPosts;
              const yEmails = yPosts - hEmails;
              const showLabel = i % labelEvery === 0;
              const tipText = `${b.key}: ${b.posts} post${b.posts === 1 ? '' : 's'}, ${b.emails} e-mail${b.emails === 1 ? '' : 's'}`;
              const onMove = (e: MouseEvent<SVGGElement>) => {
                const next = tipFromEvent(e, tipText);
                if (next) setTip(next);
              };
              return (
                <g key={b.key} onMouseMove={onMove} onMouseLeave={hideTip}>
                  {b.posts > 0 && (
                    <rect x={x} y={yPosts} width={barW} height={hPosts} rx={Math.min(3, barW / 2)} className="activity-bar activity-bar--posts" />
                  )}
                  {b.emails > 0 && (
                    <rect x={x} y={yEmails} width={barW} height={hEmails} rx={total === b.emails ? Math.min(3, barW / 2) : 0} className="activity-bar activity-bar--emails" />
                  )}
                  {showLabel && (
                    <text x={pad.l + i * band + band / 2} y={H - 12} textAnchor="middle" className="activity-axis">
                      {b.label}
                    </text>
                  )}
                </g>
              );
            })
          : null}

        {mode === 'line' ? (
          <>
            <polyline
              points={polyline}
              fill="none"
              className="activity-line"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {linePoints.map((p, i) => {
              const showLabel = i % labelEvery === 0;
              const tipText = `${p.key}: ${p.posts} post${p.posts === 1 ? '' : 's'}, ${p.emails} e-mail${p.emails === 1 ? '' : 's'}`;
              const onMove = (e: MouseEvent<SVGGElement>) => {
                const next = tipFromEvent(e, tipText);
                if (next) setTip(next);
              };
              return (
                <g key={p.key} onMouseMove={onMove} onMouseLeave={hideTip}>
                  <circle cx={p.x} cy={p.y} r={3.5} className="activity-dot" />
                  {showLabel && (
                    <text x={p.x} y={H - 12} textAnchor="middle" className="activity-axis">
                      {p.label}
                    </text>
                  )}
                </g>
              );
            })}
          </>
        ) : null}

        <line x1={pad.l} x2={W - pad.r} y1={pad.t + innerH} y2={pad.t + innerH} className="activity-baseline" />
      </svg>
      <ChartTip tip={tip} />
      <ul className="activity-legend" aria-label="Series">
        {kindFilter !== 'emails' && (
          <li>
            <span className="activity-swatch activity-swatch--posts" aria-hidden="true" />
            Posts
          </li>
        )}
        {kindFilter !== 'posts' && (
          <li>
            <span className="activity-swatch activity-swatch--emails" aria-hidden="true" />
            E-mails
          </li>
        )}
      </ul>
    </div>
  );
}

function MonthlyOverlayChart({ overlay, mode }: { overlay: AlignedMonthlyOverlay; mode: 'bar' | 'line' }) {
  const [tip, setTip] = useState<Tip | null>(null);
  if (overlay.keys.length === 0) {
    return <p className="activity-empty">No dated posts or e-mails to plot.</p>;
  }

  const rawMax = overlay.series.reduce((m, s) => Math.max(m, ...s.totals, 0), 0);
  const yMax = niceMax(rawMax);
  const W = 720;
  const H = 280;
  const pad = { l: 44, r: 16, t: 16, b: 44 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  const n = overlay.keys.length;
  const band = innerW / n;
  const groupW = band * 0.82;
  const barW = Math.max(1.5, groupW / Math.max(1, overlay.series.length));
  const maxLabels = Math.floor(innerW / 52);
  const labelEvery = Math.max(1, Math.ceil(n / maxLabels));
  const hideTip = () => setTip(null);

  const lineFor = (s: OverlayMonthSeries) =>
    overlay.keys.map((_, i) => {
      const total = s.totals[i] ?? 0;
      return {
        x: pad.l + i * band + band / 2,
        y: pad.t + innerH - (total / yMax) * innerH,
        total,
      };
    });

  return (
    <div className="activity-chart-wrap">
      <svg
        className="activity-chart"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Posts and e-mails per month, all subjects"
        onMouseLeave={hideTip}
      >
        {yTicks(yMax).map((v) => {
          const y = pad.t + innerH - (v / yMax) * innerH;
          return (
            <g key={`oy-${v}`}>
              <line x1={pad.l} x2={W - pad.r} y1={y} y2={y} className="activity-grid" />
              <text x={pad.l - 8} y={y + 3.5} textAnchor="end" className="activity-axis">
                {Number.isInteger(v) ? v : v.toFixed(1)}
              </text>
            </g>
          );
        })}

        {mode === 'bar'
          ? overlay.keys.map((key, i) => {
              const groupX = pad.l + i * band + (band - groupW) / 2;
              const showLabel = i % labelEvery === 0;
              return (
                <g key={key}>
                  {overlay.series.map((s, si) => {
                    const total = s.totals[i] ?? 0;
                    const h = (total / yMax) * innerH;
                    const x = groupX + si * barW;
                    const y = pad.t + innerH - h;
                    const tipText = `${s.label}, ${key}: ${total} item${total === 1 ? '' : 's'}`;
                    const onMove = (e: MouseEvent<SVGGElement>) => {
                      const next = tipFromEvent(e, tipText);
                      if (next) setTip(next);
                    };
                    return (
                      <g key={s.id} onMouseMove={onMove} onMouseLeave={hideTip}>
                        {total > 0 && (
                          <rect
                            x={x}
                            y={y}
                            width={Math.max(1, barW - 0.6)}
                            height={h}
                            rx={Math.min(2, barW / 2)}
                            className={seriesClass('bar', s.id)}
                          />
                        )}
                      </g>
                    );
                  })}
                  {showLabel && (
                    <text x={pad.l + i * band + band / 2} y={H - 12} textAnchor="middle" className="activity-axis">
                      {overlay.labels[i]}
                    </text>
                  )}
                </g>
              );
            })
          : null}

        {mode === 'line'
          ? overlay.series.map((s) => {
              const pts = lineFor(s);
              return (
                <g key={s.id}>
                  <polyline
                    points={pts.map((p) => `${p.x},${p.y}`).join(' ')}
                    fill="none"
                    className={seriesClass('line', s.id)}
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                  {pts.map((p, i) => {
                    const showLabel = i % labelEvery === 0 && s === overlay.series[0];
                    const tipText = `${s.label}, ${overlay.keys[i]}: ${p.total} item${p.total === 1 ? '' : 's'}`;
                    const onMove = (e: MouseEvent<SVGGElement>) => {
                      const next = tipFromEvent(e, tipText);
                      if (next) setTip(next);
                    };
                    return (
                      <g key={`${s.id}-${overlay.keys[i]}`} onMouseMove={onMove} onMouseLeave={hideTip}>
                        <circle cx={p.x} cy={p.y} r={3.5} className={seriesClass('dot', s.id)} />
                        {showLabel && (
                          <text x={p.x} y={H - 12} textAnchor="middle" className="activity-axis">
                            {overlay.labels[i]}
                          </text>
                        )}
                      </g>
                    );
                  })}
                </g>
              );
            })
          : null}

        <line x1={pad.l} x2={W - pad.r} y1={pad.t + innerH} y2={pad.t + innerH} className="activity-baseline" />
      </svg>
      <ChartTip tip={tip} />
      <SubjectLegend series={overlay.series} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hourly chart (bar or line) with timezone support
// ---------------------------------------------------------------------------

interface HourlyProps {
  histogram: HourHistogram;
  windowStart: number | null;
  windowHours: number;
  tz: TimeZone;
  mode: 'bar' | 'line';
  overlay?: OverlayHourSeries[] | null;
}

export function HourlyChart({ histogram, windowStart, windowHours, tz, mode, overlay = null }: HourlyProps) {
  if (overlay) {
    return <HourlyOverlayChart series={overlay} tz={tz} />;
  }
  return (
    <HourlySingleChart
      histogram={histogram}
      windowStart={windowStart}
      windowHours={windowHours}
      tz={tz}
      mode={mode}
    />
  );
}

function HourlySingleChart({
  histogram,
  windowStart,
  windowHours,
  tz,
  mode,
}: {
  histogram: HourHistogram;
  windowStart: number | null;
  windowHours: number;
  tz: TimeZone;
  mode: 'bar' | 'line';
}) {
  const [tip, setTip] = useState<Tip | null>(null);
  const { hours, timedCount } = histogram;
  if (timedCount === 0) {
    return (
      <p className="activity-empty">
        None of the records include a clock time, so an hour-of-day plot cannot be drawn.
      </p>
    );
  }

  const rawMax = hours.reduce((m, n) => Math.max(m, n), 0);
  const yMax = niceMax(rawMax);
  const W = 720;
  const H = 260;
  const pad = { l: 44, r: 16, t: 16, b: 40 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  const band = innerW / 24;
  const barW = Math.max(4, band * 0.7);

  const inWindow = (h: number) => {
    if (windowStart === null) return false;
    for (let i = 0; i < windowHours; i++) {
      if ((windowStart + i) % 24 === h) return true;
    }
    return false;
  };

  const hideTip = () => setTip(null);

  const linePoints = hours.map((count, h) => ({
    x: pad.l + h * band + band / 2,
    y: pad.t + innerH - (count / yMax) * innerH,
    count,
    hour: h,
  }));

  const polyline = linePoints.map((p) => `${p.x},${p.y}`).join(' ');

  return (
    <div className="activity-chart-wrap">
      <svg
        className="activity-chart"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Posts per hour of day (${tz.label})`}
        onMouseLeave={hideTip}
      >
        {yTicks(yMax).map((v) => {
          const y = pad.t + innerH - (v / yMax) * innerH;
          return (
            <g key={`hy-${v}`}>
              <line x1={pad.l} x2={W - pad.r} y1={y} y2={y} className="activity-grid" />
              <text x={pad.l - 8} y={y + 3.5} textAnchor="end" className="activity-axis">
                {Number.isInteger(v) ? v : v.toFixed(1)}
              </text>
            </g>
          );
        })}

        {mode === 'bar'
          ? hours.map((count, h) => {
              const x = pad.l + h * band + (band - barW) / 2;
              const barH = (count / yMax) * innerH;
              const y = pad.t + innerH - barH;
              const peak = inWindow(h);
              const tipText = `${formatHourLabel(h)} ${tz.label}: ${count} post${count === 1 ? '' : 's'}`;
              const onMove = (e: MouseEvent<SVGGElement>) => {
                const next = tipFromEvent(e, tipText);
                if (next) setTip(next);
              };
              const showLabel = h % 3 === 0 || h === 23;
              return (
                <g key={h} onMouseMove={onMove} onMouseLeave={hideTip}>
                  <rect
                    x={x}
                    y={barH > 0 ? y : pad.t + innerH - 1}
                    width={barW}
                    height={barH > 0 ? barH : 1}
                    rx={Math.min(3, barW / 2)}
                    className={peak ? 'activity-bar activity-bar--peak' : 'activity-bar activity-bar--hour'}
                  />
                  {showLabel && (
                    <text x={pad.l + h * band + band / 2} y={H - 10} textAnchor="middle" className="activity-axis">
                      {formatHourLabel(h)}
                    </text>
                  )}
                </g>
              );
            })
          : null}

        {mode === 'line' ? (
          <>
            <polyline
              points={polyline}
              fill="none"
              className="activity-line"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {linePoints.map((p) => {
              const peak = inWindow(p.hour);
              const tipText = `${formatHourLabel(p.hour)} ${tz.label}: ${p.count} post${p.count === 1 ? '' : 's'}`;
              const onMove = (e: MouseEvent<SVGGElement>) => {
                const next = tipFromEvent(e, tipText);
                if (next) setTip(next);
              };
              const showLabel = p.hour % 3 === 0 || p.hour === 23;
              return (
                <g key={p.hour} onMouseMove={onMove} onMouseLeave={hideTip}>
                  <circle cx={p.x} cy={p.y} r={3.5} className={peak ? 'activity-dot activity-dot--peak' : 'activity-dot'} />
                  {showLabel && (
                    <text x={p.x} y={H - 10} textAnchor="middle" className="activity-axis">
                      {formatHourLabel(p.hour)}
                    </text>
                  )}
                </g>
              );
            })}
          </>
        ) : null}

        <line x1={pad.l} x2={W - pad.r} y1={pad.t + innerH} y2={pad.t + innerH} className="activity-baseline" />
      </svg>
      <ChartTip tip={tip} />
    </div>
  );
}

function HourlyOverlayChart({ series, tz }: { series: OverlayHourSeries[]; tz: TimeZone }) {
  const [tip, setTip] = useState<Tip | null>(null);
  if (!series.some((s) => s.timedCount > 0)) {
    return (
      <p className="activity-empty">
        None of the records include a clock time, so an hour-of-day plot cannot be drawn.
      </p>
    );
  }

  const rawMax = series.reduce((m, s) => Math.max(m, ...s.hours, 0), 0);
  const yMax = niceMax(rawMax);
  const W = 720;
  const H = 260;
  const pad = { l: 44, r: 16, t: 16, b: 40 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  const band = innerW / 24;
  const hideTip = () => setTip(null);

  return (
    <div className="activity-chart-wrap">
      <svg
        className="activity-chart"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Posts per hour of day, all subjects (${tz.label})`}
        onMouseLeave={hideTip}
      >
        {yTicks(yMax).map((v) => {
          const y = pad.t + innerH - (v / yMax) * innerH;
          return (
            <g key={`ohy-${v}`}>
              <line x1={pad.l} x2={W - pad.r} y1={y} y2={y} className="activity-grid" />
              <text x={pad.l - 8} y={y + 3.5} textAnchor="end" className="activity-axis">
                {Number.isInteger(v) ? v : v.toFixed(1)}
              </text>
            </g>
          );
        })}

        {series.map((s) => {
          const pts = s.hours.map((count, h) => ({
            x: pad.l + h * band + band / 2,
            y: pad.t + innerH - (count / yMax) * innerH,
            count,
            hour: h,
          }));
          return (
            <g key={s.id}>
              <polyline
                points={pts.map((p) => `${p.x},${p.y}`).join(' ')}
                fill="none"
                className={seriesClass('line', s.id)}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {pts.map((p) => {
                const tipText = `${s.label}, ${formatHourLabel(p.hour)} ${tz.label}: ${p.count}`;
                const onMove = (e: MouseEvent<SVGGElement>) => {
                  const next = tipFromEvent(e, tipText);
                  if (next) setTip(next);
                };
                const showLabel = (p.hour % 3 === 0 || p.hour === 23) && s === series[0];
                return (
                  <g key={`${s.id}-${p.hour}`} onMouseMove={onMove} onMouseLeave={hideTip}>
                    <circle cx={p.x} cy={p.y} r={3.5} className={seriesClass('dot', s.id)} />
                    {showLabel && (
                      <text x={p.x} y={H - 10} textAnchor="middle" className="activity-axis">
                        {formatHourLabel(p.hour)}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          );
        })}

        <line x1={pad.l} x2={W - pad.r} y1={pad.t + innerH} y2={pad.t + innerH} className="activity-baseline" />
      </svg>
      <ChartTip tip={tip} />
      <SubjectLegend series={series} />
    </div>
  );
}
