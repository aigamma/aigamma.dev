import { useEffect, useMemo, useRef, useState } from 'react';

// Earnings Calendar — visual centerpiece of /earnings. Two surfaces
// rendered from one /api/earnings response payload:
//
//   1. ScatterChart: next ~5 trading days, X = calendar date,
//      Y = implied move %, color = BMO/AMC/Unknown. Hover-anchored
//      tooltip with full per-ticker detail.
//
//   2. UpcomingGrid: next 4 weeks, week-by-week rows with
//      Mon-Fri × BMO/AMC cells, ticker lists sorted descending by
//      revenue estimate.
//
// Both surfaces share the same data shape and the same color
// convention, so a reader's eye can move between them without
// re-anchoring on what blue / coral mean.

const SESSION_COLORS = {
  BMO: '#4a9eff',     // accent-blue, "Before Market Open"
  AMC: '#d85a30',     // accent-coral, "After Market Close"
  Unknown: '#7e8aa0', // muted gray
};

function formatRevenue(rev) {
  if (rev == null || !Number.isFinite(rev)) return '—';
  if (rev >= 1e12) return `$${(rev / 1e12).toFixed(2)}T`;
  if (rev >= 1e9)  return `$${(rev / 1e9).toFixed(2)}B`;
  if (rev >= 1e6)  return `$${(rev / 1e6).toFixed(0)}M`;
  return `$${rev.toFixed(0)}`;
}

function formatPctMove(v, digits = 2) {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}

function formatPctVol(v, digits = 1) {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}

// EW's epsTime field is the historical release time anchor — typically
// the prior quarter's exact release time, which most companies repeat.
// We extract just the H:MM portion in ET so the tooltip can show
// "BMO · 06:30 ET" instead of just "BMO". When the time looks like a
// sentinel (00:00) we drop it.
function formatReleaseTime(epsTime, sessionLabel) {
  if (!epsTime) return sessionLabel;
  // epsTime is an ISO datetime; parse the time portion as ET.
  const m = /T(\d{2}):(\d{2})/.exec(epsTime);
  if (!m) return sessionLabel;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h === 0 && min === 0) return sessionLabel;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = ((h + 11) % 12) + 1;
  const mm = String(min).padStart(2, '0');
  return `${sessionLabel} · ~${h12}:${mm} ${ampm} ET`;
}

function formatShortDate(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', {
    month: '2-digit',
    day: '2-digit',
    timeZone: 'UTC',
  });
}

function formatLongDate(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export default function EarningsCalendar() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const wrapRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/earnings')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j) => { if (!cancelled) setData(j); })
      .catch((e) => { if (!cancelled) setError(String(e?.message || e)); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!wrapRef.current || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(Math.max(0, Math.floor(entry.contentRect.width)));
      }
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={wrapRef} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <CalendarHeader data={data} />

      {error && (
        <div style={{
          color: 'var(--accent-coral)',
          fontFamily: 'Courier New, monospace',
          padding: '1rem',
        }}>
          Error loading earnings calendar: {error}
        </div>
      )}

      {!data && !error && (
        <div style={{
          padding: '4rem 1rem',
          textAlign: 'center',
          color: 'var(--text-secondary)',
          fontFamily: 'Courier New, monospace',
          fontSize: '0.85rem',
        }}>
          Loading earnings schedule…
        </div>
      )}

      {data && data.ewDegrade && (
        <div style={{
          background: '#3a2a1a',
          border: '1px solid #5a4220',
          color: '#e8c890',
          fontFamily: 'Courier New, monospace',
          fontSize: '0.78rem',
          padding: '0.5rem 0.75rem',
          borderRadius: '3px',
        }}>
          EarningsWhispers reachability degraded ({data.ewDegrade}). Some days may
          render empty or partial.
        </div>
      )}

      {data && (
        <ScatterChart
          chartDays={data.chartDays}
          containerWidth={containerWidth}
          impliedMovesLive={data.impliedMovesLive}
          impliedMoveDegrade={data.impliedMoveDegrade}
        />
      )}

      {data && <UpcomingGrid calendarDays={data.calendarDays} />}
    </div>
  );
}

function CalendarHeader({ data }) {
  const totalChart = data?.chartDays?.reduce((s, d) => s + (d.tickers?.length || 0), 0) || 0;
  const totalCal = data?.calendarDays?.reduce((s, d) => s + (d.tickers?.length || 0), 0) || 0;
  return (
    <div style={{
      display: 'flex',
      flexWrap: 'wrap',
      gap: '0.6rem 1.4rem',
      justifyContent: 'space-between',
      alignItems: 'baseline',
    }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem 1rem', alignItems: 'baseline' }}>
        <LegendDot color={SESSION_COLORS.BMO} label="Before Market Open" />
        <LegendDot color={SESSION_COLORS.AMC} label="After Market Close" />
        <LegendDot color={SESSION_COLORS.Unknown} label="Unknown" />
      </div>
      <div style={{
        color: 'var(--text-secondary)',
        fontFamily: 'Courier New, monospace',
        fontSize: '0.78rem',
        letterSpacing: '0.04em',
      }}>
        {data
          ? `${totalChart} chart · ${totalCal} 4-week · revenue ≥ $1B · ${data.asOf}`
          : ''}
      </div>
    </div>
  );
}

function LegendDot({ color, label }) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: '0.4rem',
      fontFamily: 'Courier New, monospace',
      fontSize: '0.82rem',
      color: 'var(--text-secondary)',
    }}>
      <span style={{
        display: 'inline-block',
        width: 10,
        height: 10,
        borderRadius: '50%',
        background: color,
      }} />
      {label}
    </span>
  );
}

// -----------------------------------------------------------------
// Scatter chart
// -----------------------------------------------------------------
//
// Reproduces the SpotGamma earnings chart layout from the reference
// at C:\i\earnings chart.png:
//
//   X axis: 5 evenly-spaced columns, one per chart day.
//   Y axis: 0% to dataMax%, with horizontal gridlines every 5%.
//
// Multiple tickers reporting the same day at similar implied moves
// would visually overlap as solid blots. We bin by Y rounded to the
// nearest 0.5% and offset overlapping dots horizontally within their
// X column, then anchor the labels to the rightmost dot of each bin
// (or comma-stack labels for tight clusters, capped with ellipsis).

function ScatterChart({ chartDays, containerWidth, impliedMovesLive, impliedMoveDegrade }) {
  const [hovered, setHovered] = useState(null);

  const width = Math.max(Math.min(containerWidth - 16, 1100), 320);
  const height = Math.round(width * 0.62);

  const PADDING = { top: 32, right: 56, bottom: 56, left: 64 };
  const plotW = width - PADDING.left - PADDING.right;
  const plotH = height - PADDING.top - PADDING.bottom;

  // Collect every plottable point.
  const points = useMemo(() => {
    const out = [];
    for (let dayIdx = 0; dayIdx < chartDays.length; dayIdx++) {
      const day = chartDays[dayIdx];
      for (const t of day.tickers || []) {
        if (!Number.isFinite(t.impliedMove)) continue;
        out.push({ ...t, dayIdx, isoDate: day.isoDate });
      }
    }
    return out;
  }, [chartDays]);

  // Y scale: top of plot = 1.1 * max move, rounded up to nearest 5%.
  const yMax = useMemo(() => {
    if (points.length === 0) return 0.20;
    const m = Math.max(...points.map((p) => p.impliedMove));
    return Math.max(0.05, Math.ceil((m * 1.10) * 20) / 20); // round up to 5%
  }, [points]);

  const xForDay = (dayIdx) => {
    if (chartDays.length <= 1) return PADDING.left + plotW / 2;
    return PADDING.left + (plotW * dayIdx) / (chartDays.length - 1);
  };
  const yForMove = (m) => PADDING.top + plotH * (1 - m / yMax);

  // Cluster labels by (dayIdx, Y bucket of ~1% width) so close-in-Y
  // tickers within the same column stack into a single label group
  // like "WDC, RDDT, RIVN, RIOT, CLX, …" matching the reference.
  // Within each bucket we also offset dots horizontally so they don't
  // overlap visually.
  const labelGroups = useMemo(() => {
    const bucket = 0.0075; // 0.75% Y-bucket width
    const groups = new Map(); // key -> { dayIdx, members: [...] }
    for (const p of points) {
      const yBkt = Math.round(p.impliedMove / bucket);
      const key = `${p.dayIdx}:${yBkt}`;
      if (!groups.has(key)) groups.set(key, { dayIdx: p.dayIdx, yBkt, members: [] });
      groups.get(key).members.push(p);
    }
    // Sort members within each group by revenue desc (largest first
    // → leftmost label, also matches our >$1B sort order from the
    // backend).
    for (const g of groups.values()) {
      g.members.sort((a, b) => (b.revenueEst ?? 0) - (a.revenueEst ?? 0));
    }
    return [...groups.values()];
  }, [points]);

  // Per-point lookup: which group it belongs to + its index within.
  const pointMeta = useMemo(() => {
    const map = new Map();
    for (const g of labelGroups) {
      g.members.forEach((m, i) => {
        map.set(`${m.isoDate}:${m.ticker}`, { group: g, idxInGroup: i });
      });
    }
    return map;
  }, [labelGroups]);

  const hoveredKey = hovered ? `${hovered.isoDate}:${hovered.ticker}` : null;

  return (
    <div className="card" style={{ position: 'relative', padding: '0.5rem 0.75rem' }}>
      <svg width={width} height={height} role="img" aria-label="Earnings implied move scatter chart">
        {/* Y gridlines + labels every 5% */}
        {(() => {
          const ticks = [];
          const stepPct = yMax > 0.10 ? 0.05 : 0.01;
          for (let v = 0; v <= yMax + 1e-9; v += stepPct) {
            const y = yForMove(v);
            ticks.push(
              <g key={v}>
                <line
                  x1={PADDING.left} x2={width - PADDING.right}
                  y1={y} y2={y}
                  stroke="rgba(160, 172, 200, 0.10)"
                  strokeDasharray="2 4"
                />
                <text
                  x={PADDING.left - 8}
                  y={y + 4}
                  textAnchor="end"
                  fontFamily="Courier New, monospace"
                  fontSize={11}
                  fill="#7e8aa0"
                >
                  {(v * 100).toFixed(stepPct < 0.025 ? 1 : 0)}%
                </text>
              </g>,
            );
          }
          return ticks;
        })()}

        {/* X axis day labels */}
        {chartDays.map((d, i) => (
          <g key={d.isoDate}>
            <line
              x1={xForDay(i)} x2={xForDay(i)}
              y1={PADDING.top} y2={height - PADDING.bottom}
              stroke="rgba(160, 172, 200, 0.06)"
            />
            <text
              x={xForDay(i)}
              y={height - PADDING.bottom + 22}
              textAnchor="middle"
              fontFamily="Courier New, monospace"
              fontSize={12}
              fill="#9aa6c2"
            >
              {formatShortDate(d.isoDate)}
            </text>
            <text
              x={xForDay(i)}
              y={height - PADDING.bottom + 38}
              textAnchor="middle"
              fontFamily="Courier New, monospace"
              fontSize={10}
              fill="#5a6478"
            >
              {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.dow] || ''}
            </text>
          </g>
        ))}

        {/* Y axis title */}
        <text
          x={-(PADDING.top + plotH / 2)}
          y={16}
          transform="rotate(-90)"
          textAnchor="middle"
          fontFamily="Courier New, monospace"
          fontSize={11}
          fill="#9aa6c2"
        >
          Implied range (%)
        </text>

        {/* X axis title */}
        <text
          x={PADDING.left + plotW / 2}
          y={height - 6}
          textAnchor="middle"
          fontFamily="Courier New, monospace"
          fontSize={11}
          fill="#9aa6c2"
        >
          Date
        </text>

        {/* Plot border */}
        <rect
          x={PADDING.left} y={PADDING.top}
          width={plotW} height={plotH}
          fill="none"
          stroke="rgba(160, 172, 200, 0.15)"
        />

        {/* Dots */}
        {points.map((p) => {
          const meta = pointMeta.get(`${p.isoDate}:${p.ticker}`);
          const dotsInGroup = meta ? meta.group.members.length : 1;
          const idx = meta ? meta.idxInGroup : 0;
          const offset = (idx - (dotsInGroup - 1) / 2) * 6; // spread within group
          const cx = xForDay(p.dayIdx) + offset;
          const cy = yForMove(p.impliedMove);
          const color = SESSION_COLORS[p.sessionLabel] || SESSION_COLORS.Unknown;
          const isHovered = hoveredKey === `${p.isoDate}:${p.ticker}`;
          return (
            <circle
              key={`${p.isoDate}-${p.ticker}`}
              cx={cx}
              cy={cy}
              r={isHovered ? 8 : 5}
              fill={color}
              stroke={isHovered ? '#f0a030' : 'rgba(8, 11, 16, 0.4)'}
              strokeWidth={isHovered ? 2 : 1}
              style={{ cursor: 'pointer', transition: 'r 0.12s ease' }}
              onMouseEnter={() => setHovered(p)}
              onMouseLeave={() => setHovered(null)}
            />
          );
        })}

        {/* Label groups — anchor to leftmost member dot, tilt above */}
        {labelGroups.map((g) => {
          const member = g.members[0];
          const cx = xForDay(g.dayIdx);
          const cy = yForMove(member.impliedMove);
          const tickerList = g.members.map((m) => m.ticker);
          const display = tickerList.length > 5
            ? `${tickerList.slice(0, 5).join(', ')}, …`
            : tickerList.join(', ');
          // Position label above the dot cluster.
          return (
            <text
              key={`label-${g.dayIdx}-${g.yBkt}`}
              x={cx}
              y={cy - 9 - (g.members.length > 1 ? 4 : 0)}
              textAnchor="middle"
              fontFamily="Courier New, monospace"
              fontSize={10.5}
              fontWeight={600}
              fill="#cfd6e6"
              style={{ pointerEvents: 'none' }}
            >
              {display}
            </text>
          );
        })}
      </svg>

      {/* Hover-anchored tooltip, positioned absolutely over the SVG.
          Same flip-on-edge logic as SkewScanner. */}
      {hovered && (() => {
        const meta = pointMeta.get(`${hovered.isoDate}:${hovered.ticker}`);
        const dotsInGroup = meta ? meta.group.members.length : 1;
        const idx = meta ? meta.idxInGroup : 0;
        const offset = (idx - (dotsInGroup - 1) / 2) * 6;
        const cx = xForDay(hovered.dayIdx) + offset;
        const cy = yForMove(hovered.impliedMove);
        const openLeft = cx > width * 0.55;
        const openDown = cy < height * 0.30;
        const o = 14;
        const style = {
          position: 'absolute',
          zIndex: 5,
          pointerEvents: 'none',
          background: 'rgba(8, 11, 16, 0.96)',
          border: '1px solid rgba(160, 172, 200, 0.35)',
          borderRadius: '4px',
          padding: '0.6rem 0.8rem',
          fontFamily: 'Courier New, monospace',
          fontSize: '0.78rem',
          color: '#e1e8f4',
          minWidth: 220,
          maxWidth: 300,
          lineHeight: 1.45,
          boxShadow: '0 2px 12px rgba(0, 0, 0, 0.6)',
        };
        if (openLeft) style.right = (width - cx + o);
        else style.left = cx + o;
        if (openDown) style.top = cy + o;
        else style.bottom = (height - cy + o);
        return <ChartTooltip ticker={hovered} style={style} />;
      })()}

      {/* Banner under the chart when implied moves are degraded */}
      {(impliedMovesLive === false || impliedMoveDegrade) && (
        <div style={{
          marginTop: '0.5rem',
          background: '#22262e',
          border: '1px solid #2e3540',
          color: '#9aa6c2',
          fontFamily: 'Courier New, monospace',
          fontSize: '0.74rem',
          padding: '0.4rem 0.6rem',
          borderRadius: '3px',
        }}>
          Implied moves: {impliedMovesLive ? 'partial coverage' : 'unavailable'}
          {impliedMoveDegrade ? ` — ${impliedMoveDegrade}` : ''}
          . Tickers without an implied move drop off the chart but remain in the
          calendar grid below.
        </div>
      )}
    </div>
  );
}

function ChartTooltip({ ticker: t, style }) {
  return (
    <div style={style}>
      <div style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: '0.5rem',
        marginBottom: '0.35rem',
      }}>
        <strong style={{ fontSize: '1rem', color: '#f0a030' }}>{t.ticker}</strong>
        <span style={{
          color: SESSION_COLORS[t.sessionLabel] || SESSION_COLORS.Unknown,
          fontWeight: 700,
          fontSize: '0.78rem',
        }}>
          {formatReleaseTime(t.epsTime, t.sessionLabel)}
        </span>
      </div>
      <div style={{
        color: 'var(--text-secondary)',
        fontSize: '0.74rem',
        marginBottom: '0.5rem',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}>
        {t.company}
      </div>
      <TooltipRow label="Reports" value={formatLongDate(t.isoDate)} />
      <TooltipRow label="Implied range" value={t.impliedRange != null ? `±$${Number(t.impliedRange).toFixed(2)}` : '—'} highlight />
      <TooltipRow label="Implied move" value={formatPctMove(t.impliedMove)} subtle />
      <TooltipRow label="ATM straddle" value={t.straddleMid != null ? `$${Number(t.straddleMid).toFixed(2)}` : '—'} subtle />
      <TooltipRow label="Spot" value={t.spot != null ? `$${Number(t.spot).toFixed(2)}` : '—'} />
      <TooltipRow label="ATM strike" value={t.straddleStrike != null ? `$${Number(t.straddleStrike).toFixed(2)}` : '—'} subtle />
      <TooltipRow label="ATM IV" value={formatPctVol(t.atmIv)} subtle />
      <TooltipRow label="Straddle exp" value={t.straddleExpiration ? `${t.straddleExpiration} (${t.dte}D)` : '—'} subtle />
      <div style={{ height: 1, background: 'rgba(160,172,200,0.15)', margin: '0.45rem 0' }} />
      <TooltipRow label="Revenue est" value={formatRevenue(t.revenueEst)} />
      <TooltipRow label="EPS est" value={t.epsEst != null ? `$${Number(t.epsEst).toFixed(2)}` : '—'} />
      {t.confirmDate && (
        <TooltipRow label="Confirmed" value={t.confirmDate.slice(0, 10)} subtle />
      )}
    </div>
  );
}

function TooltipRow({ label, value, subtle, highlight }) {
  return (
    <div style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'baseline',
      gap: '0.6rem',
      color: subtle ? 'var(--text-secondary)' : '#e1e8f4',
    }}>
      <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <span style={{
        textAlign: 'right',
        color: highlight ? '#f0a030' : (subtle ? 'var(--text-secondary)' : '#e1e8f4'),
        fontWeight: highlight ? 700 : 400,
      }}>
        {value}
      </span>
    </div>
  );
}

// -----------------------------------------------------------------
// 4-week upcoming grid
// -----------------------------------------------------------------

function UpcomingGrid({ calendarDays }) {
  // Group days into ISO weeks (Mon-Fri). A "week" starts on the
  // earliest weekday in the group and runs forward until we hit
  // another Monday. We render up to 4 such weeks.
  const weeks = useMemo(() => {
    const weeksOut = [];
    let current = null;
    for (const day of calendarDays) {
      const dow = day.dow; // 1=Mon..5=Fri
      if (!current || dow === 1 || dow < (current.lastDow ?? 0)) {
        current = { days: [], lastDow: 0 };
        weeksOut.push(current);
      }
      current.days.push(day);
      current.lastDow = dow;
    }
    return weeksOut;
  }, [calendarDays]);

  return (
    <div className="card" style={{ padding: '0.85rem 1rem' }}>
      <div style={{
        fontFamily: 'Courier New, monospace',
        fontSize: '0.7rem',
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        color: 'var(--text-secondary)',
        marginBottom: '0.85rem',
      }}>
        upcoming earnings — next 4 weeks · revenue ≥ $1B · sorted by revenue desc
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
        {weeks.map((week, wi) => (
          <WeekRow key={wi} days={week.days} />
        ))}
      </div>
    </div>
  );
}

function WeekRow({ days }) {
  // Each day gets two stacked cells: BMO and AMC. Tickers without a
  // recognized session land in BMO (the Unknown bucket — rare, since
  // EW only emits releaseTime 1 or 3).
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))`,
      gap: '0.5rem',
    }}>
      {days.map((d) => (
        <DayColumn key={d.isoDate} day={d} />
      ))}
    </div>
  );
}

function DayColumn({ day }) {
  const bmo = day.tickers.filter((t) => t.releaseTime === 1);
  const amc = day.tickers.filter((t) => t.releaseTime === 3);
  const unknown = day.tickers.filter((t) => t.releaseTime !== 1 && t.releaseTime !== 3);
  return (
    <div style={{
      background: '#11151c',
      border: '1px solid #1d232c',
      borderRadius: '3px',
      overflow: 'hidden',
      display: 'flex',
      flexDirection: 'column',
      minWidth: 0,
    }}>
      <div style={{
        padding: '0.4rem 0.5rem',
        borderBottom: '1px solid #1d232c',
        fontFamily: 'Courier New, monospace',
        fontSize: '0.78rem',
        fontWeight: 700,
        color: '#cfd6e6',
        background: '#161b23',
        textAlign: 'center',
      }}>
        {formatLongDate(day.isoDate)}
        <div style={{
          fontSize: '0.7rem',
          color: 'var(--text-secondary)',
          fontWeight: 400,
          marginTop: 2,
        }}>
          {day.tickers.length} reporting
        </div>
      </div>
      <SessionCell label="BMO" color={SESSION_COLORS.BMO} tickers={bmo} />
      <SessionCell label="AMC" color={SESSION_COLORS.AMC} tickers={amc} />
      {unknown.length > 0 && (
        <SessionCell label="Unknown" color={SESSION_COLORS.Unknown} tickers={unknown} />
      )}
    </div>
  );
}

function SessionCell({ label, color, tickers }) {
  return (
    <div style={{
      borderTop: '1px solid #1d232c',
      padding: '0.45rem 0.5rem',
      fontFamily: 'Courier New, monospace',
      fontSize: '0.74rem',
      flex: 1,
      minHeight: 60,
    }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        marginBottom: '0.3rem',
      }}>
        <span style={{
          color,
          fontSize: '0.7rem',
          fontWeight: 700,
          letterSpacing: '0.08em',
        }}>
          {label}
        </span>
        <span style={{
          color: 'var(--text-secondary)',
          fontSize: '0.7rem',
        }}>
          {tickers.length}
        </span>
      </div>
      {tickers.length === 0 ? (
        <div style={{ color: '#3a4253', fontSize: '0.72rem' }}>—</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.18rem' }}>
          {tickers.map((t) => (
            <div
              key={t.ticker}
              title={`${t.company} · ${formatRevenue(t.revenueEst)} est${t.epsEst != null ? ` · EPS $${Number(t.epsEst).toFixed(2)}` : ''}`}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: '0.5rem',
                color: '#cfd6e6',
                cursor: 'help',
              }}
            >
              <span style={{ fontWeight: 600 }}>{t.ticker}</span>
              <span style={{ color: 'var(--text-secondary)', fontSize: '0.7rem' }}>
                {formatRevenue(t.revenueEst)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
