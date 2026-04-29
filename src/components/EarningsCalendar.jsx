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

// Mirrors DEFAULT_CHART_FILTER_ID in netlify/functions/earnings.mjs.
// Default is the Top 100 names by US options volume; the rev-floor
// pills (Rev ≥ $5B / $2B / $1B / $500M) and the wider Top 250 OV
// pill stay as toggles a reader switches to when the Top 100 OV
// slice is too thin or too wide for the day's earnings density.
const DEFAULT_FILTER_MODE = 'topN-100';

// Text size multipliers — applied to chart SVG text, tooltip,
// header summary, calendar grid, and toggle pills so a user who
// wants larger fonts can dial up the whole component in one move.
// 'S' is a 10% shrink, 'M' is the baseline, 'L' is a 15% bump.
// First-render default is viewport-derived: phones (≤768px, the
// platform-wide mobile breakpoint shared with lab.css and the
// MobileNav swap) get 'S' so the SVG text doesn't crowd the
// container-width-sized chart, desktops get 'L' so labels read
// cleanly without a manual toggle. The user's explicit toggle
// choice still wins and persists across reloads via localStorage.
const TEXT_SCALES = { S: 0.9, M: 1.0, L: 1.15 };
const TEXT_SCALE_OPTIONS = [
  { id: 'S', label: 'S' },
  { id: 'M', label: 'M' },
  { id: 'L', label: 'L' },
];
const MOBILE_BREAKPOINT_PX = 768;

function readStoredTextScale() {
  if (typeof window === 'undefined') return 'L';
  try {
    const stored = window.localStorage?.getItem('earnings_text_scale');
    if (stored && TEXT_SCALES[stored] != null) return stored;
  } catch { /* localStorage may be unavailable in private mode */ }
  // No stored preference — derive the default from the viewport so
  // a first-time visitor on a phone doesn't have to shrink the text
  // manually and a first-time visitor on desktop gets the larger
  // reading size Eric asked for.
  try {
    if (window.matchMedia?.(`(max-width: ${MOBILE_BREAKPOINT_PX}px)`).matches) {
      return 'S';
    }
  } catch { /* matchMedia may be unavailable */ }
  return 'L';
}

export default function EarningsCalendar() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [filterMode, setFilterMode] = useState(DEFAULT_FILTER_MODE);
  const [filterLoading, setFilterLoading] = useState(false);
  const [textScaleId, setTextScaleIdRaw] = useState(readStoredTextScale);
  const [containerWidth, setContainerWidth] = useState(0);
  const wrapRef = useRef(null);
  // Per-mode payload cache so toggling between already-fetched modes
  // is instant (no refetch flicker, no re-paying the ~3-5s Massive
  // fan-out cost). The cache lives for the component lifetime; a
  // hard refresh wipes it which is the right behavior since the
  // earnings calendar shifts as companies confirm release times.
  const cacheRef = useRef(new Map());

  const setTextScaleId = (id) => {
    setTextScaleIdRaw(id);
    if (typeof window !== 'undefined') {
      try { window.localStorage?.setItem('earnings_text_scale', id); }
      catch { /* localStorage may be unavailable */ }
    }
  };
  const scale = TEXT_SCALES[textScaleId] ?? 1.0;

  useEffect(() => {
    let cancelled = false;
    if (cacheRef.current.has(filterMode)) {
      setData(cacheRef.current.get(filterMode));
      setError(null);
      setFilterLoading(false);
      return () => { cancelled = true; };
    }
    setFilterLoading(true);
    fetch(`/api/earnings?chart_filter=${encodeURIComponent(filterMode)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j) => {
        if (cancelled) return;
        cacheRef.current.set(filterMode, j);
        setData(j);
        setError(null);
        setFilterLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e?.message || e));
        setFilterLoading(false);
      });
    return () => { cancelled = true; };
  }, [filterMode]);

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

  const filterModes = data?.chartFilterModes ?? FILTER_MODE_FALLBACK;
  const activeFilterLabel = filterModes.find((m) => m.id === filterMode)?.label ?? filterMode;

  return (
    <div ref={wrapRef} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <CalendarHeader
        data={data}
        filterMode={filterMode}
        setFilterMode={setFilterMode}
        filterLoading={filterLoading}
        textScaleId={textScaleId}
        setTextScaleId={setTextScaleId}
        scale={scale}
        activeFilterLabel={activeFilterLabel}
        filterModes={filterModes}
      />

      {error && (
        <div style={{
          color: 'var(--accent-coral)',
          fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
          fontSize: `${1.0 * scale}rem`,
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
          fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
          fontSize: `${1.0 * scale}rem`,
        }}>
          Loading earnings schedule…
        </div>
      )}

      {data && data.ewDegrade && (
        <div style={{
          background: '#3a2a1a',
          border: '1px solid #5a4220',
          color: '#e8c890',
          fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
          fontSize: `${0.92 * scale}rem`,
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
          scale={scale}
        />
      )}

      {/* Second filter row, between the chart and the calendar grid.
          Same FilterToggleRow component as the one inside CalendarHeader
          above the chart — both instances share the filterMode state so
          either copy controls both surfaces. Eric flagged that without
          a second copy, readers don't realize the toggle also drives
          the 4-week grid below. */}
      {data && (
        <FilterToggleRow
          modes={filterModes}
          active={filterMode}
          onChange={setFilterMode}
          loading={filterLoading}
          scale={scale}
          label="Filter"
        />
      )}

      {data && <UpcomingGrid calendarDays={data.calendarDays} scale={scale} />}
    </div>
  );
}

// Hardcoded fallback list mirrors the server's CHART_FILTER_MODES so
// the toggle row can render before the first /api/earnings response
// (or if the response shape ever drops the chartFilterModes field).
// The server is the source of truth — when the response arrives we
// prefer data.chartFilterModes.
const FILTER_MODE_FALLBACK = [
  { id: 'topN-100', label: 'Top 100 OV' },
  { id: 'topN-250', label: 'Top 250 OV' },
  { id: 'rev-5B',   label: 'Rev ≥ $5B' },
  { id: 'rev-2B',   label: 'Rev ≥ $2B' },
  { id: 'rev-1B',   label: 'Rev ≥ $1B' },
  { id: 'rev-500M', label: 'Rev ≥ $500M' },
];

function CalendarHeader({
  data,
  filterMode,
  setFilterMode,
  filterLoading,
  textScaleId,
  setTextScaleId,
  scale,
  activeFilterLabel,
  filterModes,
}) {
  const totalChart = data?.chartDays?.reduce((s, d) => s + (d.tickers?.length || 0), 0) || 0;
  const totalCal = data?.calendarDays?.reduce((s, d) => s + (d.tickers?.length || 0), 0) || 0;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '0.6rem 1.4rem',
        justifyContent: 'space-between',
        alignItems: 'baseline',
      }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem 1.1rem', alignItems: 'baseline' }}>
          <LegendDot color={SESSION_COLORS.BMO} label="Before Market Open" scale={scale} />
          <LegendDot color={SESSION_COLORS.AMC} label="After Market Close" scale={scale} />
          <LegendDot color={SESSION_COLORS.Unknown} label="Unknown" scale={scale} />
        </div>
        <div style={{
          color: 'var(--text-secondary)',
          fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
          fontSize: `${0.95 * scale}rem`,
          letterSpacing: '0.04em',
        }}>
          {data
            ? `${totalChart} chart · ${totalCal} 4-week · filter: ${activeFilterLabel} · ${data.asOf}`
            : ''}
        </div>
      </div>
      <FilterToggleRow
        modes={filterModes}
        active={filterMode}
        onChange={setFilterMode}
        loading={filterLoading}
        scale={scale}
        label="Filter"
      />
      <TextSizeToggle
        active={textScaleId}
        onChange={setTextScaleId}
        scale={scale}
      />
    </div>
  );
}

// Segmented-pill toggle row. Each button is mutex-active with the
// others (radio behavior) and styled like the existing site chrome:
// monospace caps, accent-blue active state, dim border, dim hover.
function FilterToggleRow({ modes, active, onChange, loading, scale, label = 'Filter' }) {
  return (
    <div style={{
      display: 'flex',
      flexWrap: 'wrap',
      gap: '0.45rem',
      alignItems: 'center',
    }}>
      <span style={{
        color: 'var(--text-secondary)',
        fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
        fontSize: `${0.85 * scale}rem`,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        marginRight: '0.4rem',
      }}>
        {label}
      </span>
      {modes.map((m) => {
        const isActive = m.id === active;
        return (
          <button
            key={m.id}
            type="button"
            onClick={() => { if (!isActive) onChange(m.id); }}
            disabled={loading && !isActive}
            style={{
              fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
              fontSize: `${0.92 * scale}rem`,
              padding: '0.36rem 0.78rem',
              borderRadius: '3px',
              border: `1px solid ${isActive ? 'var(--accent-blue)' : '#2e3540'}`,
              background: isActive ? 'rgba(74, 158, 255, 0.12)' : 'transparent',
              color: isActive ? 'var(--accent-blue)' : '#9aa6c2',
              cursor: isActive || loading ? 'default' : 'pointer',
              letterSpacing: '0.04em',
              opacity: loading && !isActive ? 0.5 : 1,
              transition: 'background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease',
            }}
          >
            {m.label}
          </button>
        );
      })}
      {loading && (
        <span style={{
          color: 'var(--text-secondary)',
          fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
          fontSize: `${0.85 * scale}rem`,
          marginLeft: '0.5rem',
        }}>
          Loading…
        </span>
      )}
    </div>
  );
}

// Three-position text-size toggle. Mirrors the FilterToggleRow chrome
// (monospace caps label + segmented pills) so the two sit on the same
// visual baseline, but maps S/M/L → 0.9/1.0/1.15 scale multipliers
// rather than a server-side filter mode. Selection persists in
// localStorage via the parent's setTextScaleId callback so a refresh
// preserves the reader's preference.
function TextSizeToggle({ active, onChange, scale }) {
  return (
    <div style={{
      display: 'flex',
      flexWrap: 'wrap',
      gap: '0.45rem',
      alignItems: 'center',
    }}>
      <span style={{
        color: 'var(--text-secondary)',
        fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
        fontSize: `${0.85 * scale}rem`,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        marginRight: '0.4rem',
      }}>
        Text size
      </span>
      {TEXT_SCALE_OPTIONS.map((m) => {
        const isActive = m.id === active;
        return (
          <button
            key={m.id}
            type="button"
            onClick={() => { if (!isActive) onChange(m.id); }}
            style={{
              fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
              fontSize: `${0.92 * scale}rem`,
              padding: '0.36rem 0.85rem',
              borderRadius: '3px',
              border: `1px solid ${isActive ? 'var(--accent-blue)' : '#2e3540'}`,
              background: isActive ? 'rgba(74, 158, 255, 0.12)' : 'transparent',
              color: isActive ? 'var(--accent-blue)' : '#9aa6c2',
              cursor: isActive ? 'default' : 'pointer',
              letterSpacing: '0.06em',
              fontWeight: 700,
              minWidth: '2.4rem',
              transition: 'background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease',
            }}
            title={`${m.label}: ${TEXT_SCALES[m.id] === 1.0 ? 'default' : TEXT_SCALES[m.id] < 1 ? 'compact' : 'larger'}`}
          >
            {m.label}
          </button>
        );
      })}
    </div>
  );
}

function LegendDot({ color, label, scale = 1 }) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: '0.45rem',
      fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
      fontSize: `${0.95 * scale}rem`,
      color: 'var(--text-secondary)',
    }}>
      <span style={{
        display: 'inline-block',
        width: Math.round(11 * scale),
        height: Math.round(11 * scale),
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
//   X axis: chartDays.length evenly-spaced columns, one per chart
//           day, inset from both edges by half an inter-day step so
//           the leftmost column doesn't crowd the y-axis tick labels
//           (5%, 10%, …) and the rightmost column doesn't crowd the
//           plot border. The previous flush-to-edge layout placed
//           ticker labels at the y-axis baseline, where 4-letter
//           middle-anchored labels visibly painted over the y-axis
//           tick text.
//   Y axis: 0% to dataMax%, with horizontal gridlines every 5%.
//
// Multiple tickers reporting the same day at similar implied moves
// would visually overlap as solid blots. We bin by Y rounded to the
// nearest 0.5% and offset overlapping dots horizontally within their
// X column, then anchor the labels to the rightmost dot of each bin
// (or comma-stack labels for tight clusters, capped with ellipsis).

function ScatterChart({ chartDays, containerWidth, impliedMovesLive, impliedMoveDegrade, scale = 1 }) {
  const [hovered, setHovered] = useState(null);

  const width = Math.max(Math.min(containerWidth - 16, 1100), 320);
  const height = Math.round(width * 0.62);

  // SVG text sizing — multiplied by `scale` from the text-size toggle
  // so a single user choice scales every label, tick, and title in
  // unison. Baselines are bumped from the v0.4 sizes (11/12/10.5)
  // to the v0.5 sizes (14/15/12.5) per Eric's "illegible without
  // zooming" feedback; the toggle further multiplies by 0.9/1.0/1.15.
  const fsTickLabel = 14 * scale;
  const fsAxisTitle = 16 * scale;
  const fsXDateLabel = 15 * scale;
  const fsXWeekday = 13 * scale;
  const fsDotTicker = 12.5 * scale; // +1pt over previous 11.5 baseline (Eric: "tickers 1 point higher")
  // Padding scales mildly with text size so the larger Y-axis tick
  // labels and axis titles still fit without overflowing the plot.
  const PADDING = {
    top: Math.round(36 * scale),
    right: Math.round(56 * scale),
    bottom: Math.round(64 * scale),
    left: Math.round(72 * scale),
  };
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
    // Inset both edges by half an inter-day step. n columns are
    // placed at the centers of n equal sub-bands across plotW, so
    // day 0 lands at plotW/(2n) from the y-axis (≈ half a column
    // width) instead of flush against it. Without the inset, a
    // 4-letter ticker like "MSFT" middle-anchored at x=PADDING.left
    // extends ~15px to the left, where it overpaints the y-axis
    // tick labels ("5%", "10%") rendered end-anchored at
    // x=PADDING.left - 10. Inter-day spacing is plotW/n (was
    // plotW/(n-1)), which compresses the column stride by ~20% at
    // n=5 — a tradeoff Eric was explicit about, prioritizing legible
    // y-axis labels over packing days edge-to-edge.
    return PADDING.left + (plotW * (dayIdx + 0.5)) / chartDays.length;
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
                  x={PADDING.left - 10}
                  y={y + Math.round(5 * scale)}
                  textAnchor="end"
                  fontFamily="Calibri, 'Segoe UI', system-ui, sans-serif"
                  fontSize={fsTickLabel}
                  fill="#9aa6c2"
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
              y={height - PADDING.bottom + Math.round(26 * scale)}
              textAnchor="middle"
              fontFamily="Calibri, 'Segoe UI', system-ui, sans-serif"
              fontSize={fsXDateLabel}
              fill="#cfd6e6"
            >
              {formatShortDate(d.isoDate)}
            </text>
            <text
              x={xForDay(i)}
              y={height - PADDING.bottom + Math.round(46 * scale)}
              textAnchor="middle"
              fontFamily="Calibri, 'Segoe UI', system-ui, sans-serif"
              fontSize={fsXWeekday}
              fill="#7e8aa0"
            >
              {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.dow] || ''}
            </text>
          </g>
        ))}

        {/* Y axis title — Eric called this "thumbnail grade" at 11px;
            now bumped to 16px baseline (× scale) and pulled in to
            x=18 so it doesn't run into the tick labels at the new
            size. fontWeight 600 to balance the heavier presence. */}
        <text
          x={-(PADDING.top + plotH / 2)}
          y={Math.round(20 * scale)}
          transform="rotate(-90)"
          textAnchor="middle"
          fontFamily="Calibri, 'Segoe UI', system-ui, sans-serif"
          fontSize={fsAxisTitle}
          fontWeight={600}
          fill="#cfd6e6"
        >
          Implied range (%)
        </text>

        {/* X axis title */}
        <text
          x={PADDING.left + plotW / 2}
          y={height - Math.round(6 * scale)}
          textAnchor="middle"
          fontFamily="Calibri, 'Segoe UI', system-ui, sans-serif"
          fontSize={fsAxisTitle}
          fontWeight={600}
          fill="#cfd6e6"
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
              y={cy - Math.round(10 * scale) - (g.members.length > 1 ? Math.round(4 * scale) : 0)}
              textAnchor="middle"
              fontFamily="Calibri, 'Segoe UI', system-ui, sans-serif"
              fontSize={fsDotTicker}
              fontWeight={600}
              fill="#dde4f0"
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
          padding: `${0.65 * scale}rem ${0.85 * scale}rem`,
          fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
          fontSize: `${0.92 * scale}rem`,
          color: '#e1e8f4',
          minWidth: Math.round(240 * scale),
          maxWidth: Math.round(330 * scale),
          lineHeight: 1.5,
          boxShadow: '0 2px 12px rgba(0, 0, 0, 0.6)',
        };
        if (openLeft) style.right = (width - cx + o);
        else style.left = cx + o;
        if (openDown) style.top = cy + o;
        else style.bottom = (height - cy + o);
        return <ChartTooltip ticker={hovered} style={style} scale={scale} />;
      })()}

      {/* Banner under the chart when implied moves are degraded */}
      {(impliedMovesLive === false || impliedMoveDegrade) && (
        <div style={{
          marginTop: '0.6rem',
          background: '#22262e',
          border: '1px solid #2e3540',
          color: '#cfd6e6',
          fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
          fontSize: `${0.88 * scale}rem`,
          padding: '0.55rem 0.75rem',
          borderRadius: '3px',
        }}>
          Implied moves: {impliedMovesLive ? 'partial coverage' : 'unavailable'}
          {impliedMoveDegrade ? `, ${impliedMoveDegrade}` : ''}
          . Tickers without an implied move drop off the chart but remain in the
          calendar grid below.
        </div>
      )}
    </div>
  );
}

function ChartTooltip({ ticker: t, style, scale = 1 }) {
  return (
    <div style={style}>
      <div style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: '0.5rem',
        marginBottom: '0.4rem',
      }}>
        <strong style={{ fontSize: `${1.2 * scale}rem`, color: '#f0a030' }}>{t.ticker}</strong>
        <span style={{
          color: SESSION_COLORS[t.sessionLabel] || SESSION_COLORS.Unknown,
          fontWeight: 700,
          fontSize: `${0.92 * scale}rem`,
        }}>
          {formatReleaseTime(t.epsTime, t.sessionLabel)}
        </span>
      </div>
      <div style={{
        color: 'var(--text-secondary)',
        fontSize: `${0.88 * scale}rem`,
        marginBottom: '0.55rem',
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
      <div style={{ height: 1, background: 'rgba(160,172,200,0.15)', margin: '0.5rem 0' }} />
      <TooltipRow label="Revenue est" value={formatRevenue(t.revenueEst)} />
      <TooltipRow label="EPS est" value={t.epsEst != null ? `$${Number(t.epsEst).toFixed(2)}` : '—'} />
      {t.confirmDate && (
        <TooltipRow label="Confirmed" value={t.confirmDate.slice(0, 10)} subtle />
      )}
      {/* Anchor / SP500 enrichment rows. Same conditional pattern
          used in /scan's tooltip — anchor names get the joint-rank
          tuple in accent-blue, SP500-but-not-anchor get a muted
          divergence diagnostic, non-SP500 names stay silent because
          the absence of any SP500 row IS the signal. The roster
          fields land on every ticker via earnings.mjs's
          ROSTER_MAP enrichment block. */}
      {t.anchor && (
        <TooltipRow
          label="Anchor 50"
          value={
            <span style={{ color: 'var(--accent-blue, #4a9eff)', fontWeight: 700 }}>
              {`ov${t.ovRank}/mc${t.mcRank} · ${t.weight}%`}
            </span>
          }
        />
      )}
      {!t.anchor && t.weight != null && (
        <TooltipRow
          label="SP500"
          value={`${t.weight}% · ov${t.ovRank}/mc${t.mcRank}${t.hype != null ? ` · hype ${t.hype}` : ''}`}
          subtle
        />
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
      lineHeight: 1.55,
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

function UpcomingGrid({ calendarDays, scale = 1 }) {
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
    <div className="card" style={{ padding: '1rem 1.15rem' }}>
      <div style={{
        fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
        fontSize: `${0.88 * scale}rem`,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        color: 'var(--text-secondary)',
        marginBottom: '1rem',
      }}>
        upcoming earnings · next 4 weeks · sorted by revenue desc · filter applies
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
        {weeks.map((week, wi) => (
          <WeekRow key={wi} days={week.days} scale={scale} />
        ))}
      </div>
    </div>
  );
}

function WeekRow({ days, scale }) {
  // CSS subgrid: each WeekRow defines header / BMO / AMC ( / Unknown)
  // as auto-sized rows, and every DayColumn opts into those tracks via
  // grid-template-rows: subgrid. Result: every BMO cell in the row is
  // sized to the tallest BMO content across all 5 days, and every AMC
  // cell is sized to the tallest AMC content. AMC labels line up across
  // columns AND no cell can clip its tickers — the bug Eric flagged
  // (Wed Apr 29 had AMC = 7 but only 5 names rendered) was the old
  // flex:1-with-min-height:60 layout dividing the row's vertical space
  // 50/50 between BMO and AMC regardless of how many tickers each held,
  // so a 7-ticker AMC cell next to a 2-ticker BMO cell got clipped at
  // the 50% line by the parent's overflow:hidden.
  const anyUnknown = days.some(
    (d) => d.tickers.some((t) => t.releaseTime !== 1 && t.releaseTime !== 3),
  );
  const rowSpan = anyUnknown ? 4 : 3;
  const gridTemplateRows = anyUnknown ? 'auto auto auto auto' : 'auto auto auto';
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))`,
      gridTemplateRows,
      gap: '0 0.5rem',
    }}>
      {days.map((d) => (
        <DayColumn
          key={d.isoDate}
          day={d}
          scale={scale}
          rowSpan={rowSpan}
          renderUnknownCell={anyUnknown}
        />
      ))}
    </div>
  );
}

function DayColumn({ day, scale, rowSpan, renderUnknownCell }) {
  const bmo = day.tickers.filter((t) => t.releaseTime === 1);
  const amc = day.tickers.filter((t) => t.releaseTime === 3);
  const unknown = day.tickers.filter((t) => t.releaseTime !== 1 && t.releaseTime !== 3);
  return (
    <div style={{
      gridRow: `span ${rowSpan}`,
      display: 'grid',
      gridTemplateRows: 'subgrid',
      background: '#11151c',
      border: '1px solid #1d232c',
      borderRadius: '3px',
      overflow: 'hidden',
      minWidth: 0,
    }}>
      <div style={{
        padding: '0.5rem 0.55rem',
        borderBottom: '1px solid #1d232c',
        fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
        fontSize: `${0.95 * scale}rem`,
        fontWeight: 700,
        color: '#cfd6e6',
        background: '#161b23',
        textAlign: 'center',
      }}>
        {formatLongDate(day.isoDate)}
        <div style={{
          fontSize: `${0.85 * scale}rem`,
          color: 'var(--text-secondary)',
          fontWeight: 400,
          marginTop: 3,
        }}>
          {day.tickers.length} reporting
        </div>
      </div>
      <SessionCell label="BMO" color={SESSION_COLORS.BMO} tickers={bmo} scale={scale} />
      <SessionCell label="AMC" color={SESSION_COLORS.AMC} tickers={amc} scale={scale} />
      {renderUnknownCell && (
        <SessionCell label="Unknown" color={SESSION_COLORS.Unknown} tickers={unknown} scale={scale} />
      )}
    </div>
  );
}

function SessionCell({ label, color, tickers, scale = 1 }) {
  return (
    <div style={{
      borderTop: '1px solid #1d232c',
      padding: '0.55rem 0.55rem',
      fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
      fontSize: `${0.95 * scale}rem`,
    }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        marginBottom: '0.4rem',
      }}>
        <span style={{
          color,
          fontSize: `${0.85 * scale}rem`,
          fontWeight: 700,
          letterSpacing: '0.08em',
        }}>
          {label}
        </span>
        <span style={{
          color: 'var(--text-secondary)',
          fontSize: `${0.85 * scale}rem`,
        }}>
          {tickers.length}
        </span>
      </div>
      {tickers.length === 0 ? (
        <div style={{ color: '#3a4253', fontSize: `${0.88 * scale}rem` }}>—</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.22rem' }}>
          {tickers.map((t) => {
            // Calendar grid tooltip extends the existing browser-native
            // title with anchor / SP500 metadata when available so a
            // hover reveals the durable-core context without needing
            // to switch surfaces. Non-SP500 names get the same
            // baseline title as before (no extra line) — the absence
            // of an anchor / SP500 line IS the signal that the ticker
            // sits in the dynamic-tail half of the OV roster.
            const titleParts = [
              `${t.company} · ${formatRevenue(t.revenueEst)} est${t.epsEst != null ? ` · EPS $${Number(t.epsEst).toFixed(2)}` : ''}`,
            ];
            if (t.anchor) {
              titleParts.push(`Anchor 50 (ov${t.ovRank}/mc${t.mcRank}, weight ${t.weight}%)`);
            } else if (t.weight != null) {
              titleParts.push(`SP500 weight ${t.weight}% · ov${t.ovRank}/mc${t.mcRank}${t.hype != null ? ` · hype ${t.hype}` : ''}`);
            }
            return (
              <div
                key={t.ticker}
                title={titleParts.join('\n')}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: '0.5rem',
                  color: '#cfd6e6',
                  cursor: 'help',
                }}
              >
                <span style={{ fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '0.32rem' }}>
                  {t.anchor && (
                    // Anchor 50 indicator inline with the ticker label.
                    // 5px round dot in cream — same treatment as the
                    // /heatmap tile dot — mirrors the visual language
                    // for "this name is in the durable core" across
                    // the two surfaces. Aria-hidden because the textual
                    // anchor info lives in the title attribute already.
                    <span
                      aria-hidden="true"
                      style={{
                        width: '5px',
                        height: '5px',
                        borderRadius: '50%',
                        background: '#fff5d6',
                        boxShadow: '0 0 2px rgba(0, 0, 0, 0.5)',
                        flexShrink: 0,
                      }}
                    />
                  )}
                  {t.ticker}
                </span>
                <span style={{ color: 'var(--text-secondary)', fontSize: `${0.85 * scale}rem` }}>
                  {formatRevenue(t.revenueEst)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
