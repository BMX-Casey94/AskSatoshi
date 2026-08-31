/**
 * Hand-rolled SVG charts for Satoshi activity — no chart library.
 */

import { useState, type MouseEvent } from 'react';
import type { HourHistogram, MonthBucket, TimeZone } from '../lib/satoshiActivity';
import { formatHourLabel, niceMax } from '../lib/satoshiActivity';

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

// ---------------------------------------------------------------------------
// Monthly chart (bar or line)
// ---------------------------------------------------------------------------

interface MonthlyProps {
  buckets: MonthBucket[];
  mode: 'bar' | 'line';
}

export function MonthlyChart({ buckets, mode }: MonthlyProps) {
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

  // Label collision fix: never show first/last unconditionally; use a fixed
  // interval and always include the first label only if there's room.
  const maxLabels = Math.floor(innerW / 52); // ~52px per label
  const labelEvery = Math.max(1, Math.ceil(buckets.length / maxLabels));

  const hideTip = () => setTip(null);

  // Build line-chart points
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
                const rect = e.currentTarget.ownerSVGElement?.parentElement?.getBoundingClientRect();
                if (!rect) return;
                setTip({ x: e.clientX - rect.left + 12, y: e.clientY - rect.top - 8, text: tipText });
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
                const rect = e.currentTarget.ownerSVGElement?.parentElement?.getBoundingClientRect();
                if (!rect) return;
                setTip({ x: e.clientX - rect.left + 12, y: e.clientY - rect.top - 8, text: tipText });
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
        <li>
          <span className="activity-swatch activity-swatch--posts" aria-hidden="true" />
          Posts
        </li>
        <li>
          <span className="activity-swatch activity-swatch--emails" aria-hidden="true" />
          E-mails
        </li>
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hourly chart (bar or line) with timezone support
// ---------------------------------------------------------------------------

interface HourlyProps {
  histogram: HourHistogram;
  windowStart: number | null;
  tz: TimeZone;
  mode: 'bar' | 'line';
}

export function HourlyChart({ histogram, windowStart, tz, mode }: HourlyProps) {
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
    for (let i = 0; i < 4; i++) {
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
                const rect = e.currentTarget.ownerSVGElement?.parentElement?.getBoundingClientRect();
                if (!rect) return;
                setTip({ x: e.clientX - rect.left + 12, y: e.clientY - rect.top - 8, text: tipText });
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
                const rect = e.currentTarget.ownerSVGElement?.parentElement?.getBoundingClientRect();
                if (!rect) return;
                setTip({ x: e.clientX - rect.left + 12, y: e.clientY - rect.top - 8, text: tipText });
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
