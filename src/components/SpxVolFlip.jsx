import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import usePlotly from '../hooks/usePlotly';
import useIsMobile from '../hooks/useIsMobile';
import { useGexHistory } from '../hooks/useHistoricalData';
import {
  PLOTLY_COLORS,
  PLOTLY_FONT_FAMILY,
  plotly2DChartLayout,
  plotlyAxis,
  plotlyTitle,
} from '../lib/plotlyTheme';
import RangeBrush from './RangeBrush';
import ResetButton from './ResetButton';

// Daily SPX EOD close against the daily Vol Flip level with two-color shading
// between them — blue where SPX closed above the flip (positive dealer gamma
// regime, market-making flow dampens moves) and red where SPX closed below
// (negative gamma regime, flow amplifies). Visual framing mirrors the
// reference image: a solid price line that recolors at each regime crossing,
// a dotted reference level, and a filled band between them.
//
// Data source is /api/gex-history, which reads daily_gex_stats and returns
// one row per trading date with spx_close and vol_flip_strike. Index
// Standard at ThetaData gates SPX OHLC to 2022-01-03 onward, so the series
// naturally starts there regardless of how far back the request reaches.
//
// The series is split into contiguous same-sign segments at each SPX/Flip
// crossing (linearly interpolated in both time and level), and each segment
// is rendered as a fill:'toself' closed polygon walking the SPX edge
// forward and the Flip edge backward — the same technique the VRP card
// uses for its positive/negative-VRP shading, which keeps the fill clipped
// to the band between the two lines rather than dropping to the axis floor
// that a fill:'tonexty' pair with null gaps would leak into.
//
// The card ships with the site-wide RangeBrush below the plot and a
// ResetButton in the upper-left corner, matching DealerGammaRegime's
// interaction model: default window is the trailing ~60 calendar days of
// the series, the brush exposes the full history for expansion, and the
// y-axis tightens to the visible window on every brush commit so zoomed
// regions don't sit flattened against distant out-of-view extrema.
//
// The upper-left also hosts dedicated Call Wall / Put Wall toggle
// buttons that sit alongside the ResetButton in a single flex cluster.
// The buttons control visibility of the daily Call Wall (positive
// green) and Put Wall (negative red) step lines — both off by default.
// Active buttons render with a filled tinted background and
// full-saturation border; inactive buttons are outline-only gray so
// the pressed/unpressed state is obvious without having to compare
// legend-entry brightness (the prior "visible:'legendonly'" approach).
// Hiding a wall also physically tightens the y-axis to the spot/flip
// band so the regime narrative reads at higher vertical resolution
// when the walls are off.

const BLUE_FILL = 'rgba(74, 158, 255, 0.28)';
const RED_FILL = 'rgba(216, 90, 48, 0.30)';
const BLUE_LINE = PLOTLY_COLORS.primary;
const RED_LINE = '#d85a30';
const FLIP_LINE = PLOTLY_COLORS.highlight;
const CALL_WALL_LINE = PLOTLY_COLORS.positive;
const PUT_WALL_LINE = PLOTLY_COLORS.negative;
const HISTORY_FROM = '2022-01-03';

function isoToMs(iso) {
  return new Date(`${iso}T00:00:00Z`).getTime();
}

function msToIso(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function addDaysIso(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Densify a daily series so the flip column steps at each day boundary.
// For each adjacent pair (day_i, day_{i+1}), insert a synthetic vertex at
// (t_{i+1}, s_{i+1}, f_i) just before the real (t_{i+1}, s_{i+1}, f_{i+1})
// point. Feeding this to buildSegments produces fill polygons whose
// flip-side edges trace the same horizontal-then-vertical step shape as
// the yellow line (rendered separately with Plotly's shape:'hv'), so the
// blue/red fill sits flush against the yellow line instead of slanting
// between adjacent daily flip values and creating triangular gaps at
// every step. The synthetic point carries day_{i+1}'s spot (not day_i's)
// so the SPX-side edge of the polygon still slopes linearly from s_i to
// s_{i+1} across the gap — only the flip side is step-shaped, which
// matches the physical semantics of a piecewise-constant daily reference
// signal drawn against a continuous intraday-reconstructable price.
function densifyForStep(series) {
  if (series.length === 0) return [];
  const out = [{ ...series[0] }];
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1];
    const curr = series[i];
    out.push({ t: curr.t, s: curr.s, f: prev.f });
    out.push({ ...curr });
  }
  return out;
}

function buildSegments(series) {
  const segments = [];
  if (!series || series.length === 0) return segments;

  let current = null;
  const open = (kind) => {
    current = { kind, ts: [], ss: [], fs: [] };
    segments.push(current);
  };
  const push = (t, s, f) => {
    current.ts.push(t);
    current.ss.push(s);
    current.fs.push(f);
  };

  const first = series[0];
  open(first.s >= first.f ? 'above' : 'below');
  push(first.t, first.s, first.f);
  let prevKind = current.kind;

  for (let i = 1; i < series.length; i++) {
    const curr = series[i];
    const currKind = curr.s >= curr.f ? 'above' : 'below';
    if (currKind !== prevKind) {
      const prev = series[i - 1];
      const prevDelta = prev.s - prev.f;
      const currDelta = curr.s - curr.f;
      const denom = Math.abs(prevDelta) + Math.abs(currDelta);
      const alpha = denom > 0 ? Math.abs(prevDelta) / denom : 0.5;
      const prevMs = new Date(prev.t).getTime();
      const currMs = new Date(curr.t).getTime();
      const xCrossIso = new Date(prevMs + alpha * (currMs - prevMs))
        .toISOString()
        .slice(0, 10);
      const yCross = prev.s + alpha * (curr.s - prev.s);
      push(xCrossIso, yCross, yCross);
      open(currKind);
      push(xCrossIso, yCross, yCross);
    }
    push(curr.t, curr.s, curr.f);
    prevKind = currKind;
  }
  return segments;
}

function segmentFillTrace(segment, fillcolor) {
  return {
    x: [...segment.ts, ...segment.ts.slice().reverse()],
    y: [...segment.ss, ...segment.fs.slice().reverse()],
    fill: 'toself',
    fillcolor,
    line: { color: 'rgba(0,0,0,0)', width: 0 },
    mode: 'lines',
    type: 'scatter',
    showlegend: false,
    hoverinfo: 'skip',
  };
}

function segmentLineTrace(segment, color, showLegend, name, legendgroup) {
  return {
    x: segment.ts,
    y: segment.ss,
    mode: 'lines',
    type: 'scatter',
    line: { color, width: 2 },
    name,
    legendgroup,
    showlegend: showLegend,
    hovertemplate: '%{x|%b %d, %Y}<br>SPX: %{y:,.2f}<extra></extra>',
  };
}

// Compute a tight y-axis range (5% padded) over the (spot, flip, and
// optionally call wall / put wall) values whose date falls inside
// [xStart, xEnd] inclusive. Call Wall typically sits 2-5% above spot
// and Put Wall 3-8% below, so when either is visible the axis must
// span them too; when both are hidden the axis tightens to just the
// spot-vs-flip band so the regime narrative reads at a larger vertical
// resolution. `includeCallWall` and `includePutWall` track the toggle
// state so hiding a wall also physically tightens the axis rather than
// just hiding the line. Returns null if nothing falls in the window so
// callers can leave the existing range alone rather than collapsing
// the axis to a degenerate span.
function computeYRange(series, xStart, xEnd, includeCallWall, includePutWall) {
  let yMin = Infinity;
  let yMax = -Infinity;
  const consider = (v) => {
    if (!Number.isFinite(v)) return;
    if (v < yMin) yMin = v;
    if (v > yMax) yMax = v;
  };
  for (const r of series) {
    if (r.t < xStart || r.t > xEnd) continue;
    consider(r.s);
    consider(r.f);
    if (includeCallWall) consider(r.cw);
    if (includePutWall) consider(r.pw);
  }
  if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) return null;
  if (yMax === yMin) {
    const pad = Math.max(yMin * 0.01, 1);
    return [yMin - pad, yMax + pad];
  }
  const pad = (yMax - yMin) * 0.05;
  return [yMin - pad, yMax + pad];
}

// Button with a pressed (active) / unpressed (inactive) look, styled
// to match the ResetButton visual language (Courier New, uppercase,
// letter-spaced) but keyed to a color pair rather than a single fixed
// tint. Active renders with a filled background at ~0.22 alpha of the
// active color, a full-saturation border, and bright white text; the
// inactive state is a flat transparent box with a muted gray outline
// and dimmed text. The border+fill contrast when active vs the outline
// alone when inactive makes the on/off state obvious at a glance,
// which is the whole reason these exist in place of the prior
// "legendonly" grayed-out legend entries.
function ToggleButton({ active, onClick, label, activeBg, activeBorder, mobile }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        background: active ? activeBg : 'transparent',
        border: `1px solid ${active ? activeBorder : 'rgba(138,143,156,0.35)'}`,
        borderRadius: '3px',
        padding: mobile ? '0.1rem 0.4rem' : '0.2rem 0.55rem',
        fontFamily: PLOTLY_FONT_FAMILY,
        fontSize: mobile ? '0.7rem' : '0.75rem',
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        cursor: 'pointer',
        color: active ? '#e0e0e0' : '#8a8f9c',
        lineHeight: 1,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  );
}

export default function SpxVolFlip() {
  const chartRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();
  const { data, loading, error } = useGexHistory({ from: HISTORY_FROM });
  const mobile = useIsMobile();
  const [timeRange, setTimeRange] = useState(null);
  const [showCallWall, setShowCallWall] = useState(false);
  const [showPutWall, setShowPutWall] = useState(false);

  const series = useMemo(() => {
    if (!data?.series) return [];
    return data.series
      .map((r) => ({
        t: r.trading_date,
        s: r.spx_close,
        f: r.vol_flip,
        cw: Number.isFinite(r.call_wall) ? r.call_wall : null,
        pw: Number.isFinite(r.put_wall) ? r.put_wall : null,
      }))
      .filter((r) => r.t && Number.isFinite(r.s) && Number.isFinite(r.f));
  }, [data]);

  const segments = useMemo(() => buildSegments(densifyForStep(series)), [series]);

  const firstDate = series.length > 0 ? series[0].t : null;
  const lastDate = series.length > 0 ? series[series.length - 1].t : null;

  const defaultRange = useMemo(() => {
    if (!firstDate || !lastDate) return null;
    const sixtyDaysBack = addDaysIso(lastDate, -60);
    return [sixtyDaysBack >= firstDate ? sixtyDaysBack : firstDate, lastDate];
  }, [firstDate, lastDate]);

  const activeRange = timeRange || defaultRange;

  useEffect(() => {
    if (!Plotly || !chartRef.current || series.length === 0 || !activeRange) return;

    const [windowStart, windowEnd] = activeRange;

    const times = series.map((r) => r.t);
    const flip = series.map((r) => r.f);

    const fillTraces = segments
      .filter((seg) => seg.ts.length >= 2)
      .map((seg) =>
        segmentFillTrace(seg, seg.kind === 'above' ? BLUE_FILL : RED_FILL),
      );

    const flipTrace = {
      x: times,
      y: flip,
      mode: 'lines',
      type: 'scatter',
      line: { color: FLIP_LINE, width: 1.5, shape: 'hv' },
      name: '<b>Vol Flip</b>',
      hovertemplate: '%{x|%b %d, %Y}<br>Vol Flip: %{y:,.2f}<extra></extra>',
      // legendrank 2 sandwiches Vol Flip between SPX above (rank 1)
      // and SPX below (rank 3) in the centered horizontal legend, so
      // the reference level reads visually as the center of the
      // three-way regime narrative rather than as the first entry.
      legendrank: 2,
    };

    // Put Wall and Call Wall are daily EOD levels computed from the
    // per-strike net GEX peaks of the full SPX chain: Call Wall is the
    // strike maximizing (callGex - putGex) — the "ceiling above spot"
    // where dealers are most long gamma — and Put Wall is the strike
    // minimizing it — the "floor below spot" where dealers are most
    // short gamma. Both render as step lines with shape='hv' like the
    // Vol Flip so the horizontal plateaus and vertical jumps carry the
    // same piecewise-constant semantics. Colors follow GexProfile's
    // convention: Call Wall = positive green, Put Wall = negative red.
    // Values are null for days where the /api/gex-history endpoint
    // hasn't received the backfill yet — Plotly gaps the line at null
    // points rather than interpolating across them. Off by default —
    // the SPX / Vol Flip story is the primary narrative of this card,
    // and the walls crowd the chart with two additional step lines
    // that often sit well outside the spot-vs-flip band (Call Wall
    // 2-5% above spot, Put Wall 3-8% below) and stretch the y-axis
    // vertically. The reader opts in via dedicated toggle buttons in
    // the upper-left corner of the card, which replaces the earlier
    // "legendonly" approach where the walls appeared as grayed-out
    // legend entries that toggled to full visibility on click. The
    // explicit button metaphor makes the on/off state immediately
    // obvious (filled green or red when active, outline-only gray
    // when inactive) without requiring the reader to notice that a
    // legend entry is rendered dimmer than its neighbors. The
    // corresponding yRange calculation also respects the toggle state
    // so hiding a wall physically tightens the y-axis rather than
    // just hiding the line, which gives the spot/flip band a larger
    // fraction of the vertical real estate when walls are off.
    // customdata carries a pre-formatted "±x.x%" string per point so the
    // hover can surface each wall's distance from that day's SPX close
    // without Plotly arithmetic. Sign convention: (wall - spot) / spot,
    // so Call Wall reads positive above spot (typical) and Put Wall reads
    // negative below spot (typical). On days where either value is null
    // the customdata entry is [null] and the hovertemplate falls through
    // to "N/A" for the delta cell.
    const formatDistance = (wall, spot) => {
      if (!Number.isFinite(wall) || !Number.isFinite(spot) || spot === 0) return 'N/A';
      const pct = ((wall - spot) / spot) * 100;
      const sign = pct >= 0 ? '+' : '';
      return `${sign}${pct.toFixed(1)}%`;
    };
    const callWallValues = series.map((r) => r.cw);
    const putWallValues = series.map((r) => r.pw);
    const callWallCustomData = series.map((r) => [formatDistance(r.cw, r.s)]);
    const putWallCustomData = series.map((r) => [formatDistance(r.pw, r.s)]);
    const callWallTrace = {
      x: times,
      y: callWallValues,
      customdata: callWallCustomData,
      mode: 'lines',
      type: 'scatter',
      line: { color: CALL_WALL_LINE, width: 1.5, shape: 'hv' },
      name: '<b>Call Wall</b>',
      hovertemplate:
        '%{x|%b %d, %Y}<br>Call Wall: %{y:,.0f} (%{customdata[0]} vs SPX)<extra></extra>',
      connectgaps: false,
      showlegend: false,
    };
    const putWallTrace = {
      x: times,
      y: putWallValues,
      customdata: putWallCustomData,
      mode: 'lines',
      type: 'scatter',
      line: { color: PUT_WALL_LINE, width: 1.5, shape: 'hv' },
      name: '<b>Put Wall</b>',
      hovertemplate:
        '%{x|%b %d, %Y}<br>Put Wall: %{y:,.0f} (%{customdata[0]} vs SPX)<extra></extra>',
      connectgaps: false,
      showlegend: false,
    };

    let aboveLegendShown = false;
    let belowLegendShown = false;
    const lineTraces = [];
    for (const seg of segments) {
      if (seg.ts.length < 2) continue;
      if (seg.kind === 'above') {
        const trace = segmentLineTrace(
          seg,
          BLUE_LINE,
          !aboveLegendShown,
          '<b>SPX · above Flip</b>',
          'spx-above',
        );
        if (!aboveLegendShown) trace.legendrank = 1;
        lineTraces.push(trace);
        aboveLegendShown = true;
      } else {
        const trace = segmentLineTrace(
          seg,
          RED_LINE,
          !belowLegendShown,
          '<b>SPX · below Flip</b>',
          'spx-below',
        );
        if (!belowLegendShown) trace.legendrank = 3;
        lineTraces.push(trace);
        belowLegendShown = true;
      }
    }

    const traces = [
      ...fillTraces,
      flipTrace,
      ...(showCallWall ? [callWallTrace] : []),
      ...(showPutWall ? [putWallTrace] : []),
      ...lineTraces,
    ];

    const yRange = computeYRange(series, windowStart, windowEnd, showCallWall, showPutWall);

    const legendFont = {
      family: PLOTLY_FONT_FAMILY,
      color: PLOTLY_COLORS.titleText,
      size: mobile ? 12 : 16,
    };
    const layout = plotly2DChartLayout({
      margin: mobile ? { t: 70, r: 20, b: 40, l: 60 } : { t: 95, r: 30, b: 45, l: 80 },
      title: {
        ...plotlyTitle('SPX vs Vol Flip'),
        y: 0.97,
        yref: 'container',
        yanchor: 'top',
      },
      xaxis: plotlyAxis('', {
        type: 'date',
        range: [windowStart, windowEnd],
        autorange: false,
      }),
      yaxis: plotlyAxis(mobile ? '' : 'SPX', {
        tickformat: ',.0f',
        ...(yRange ? { range: yRange, autorange: false } : {}),
      }),
      showlegend: !mobile,
      legend: {
        orientation: 'h',
        x: 0.5,
        y: 1.03,
        xanchor: 'center',
        yanchor: 'bottom',
        font: legendFont,
        bgcolor: 'rgba(0, 0, 0, 0)',
        borderwidth: 0,
      },
      hovermode: 'x unified',
    });

    Plotly.react(chartRef.current, traces, layout, {
      responsive: true,
      displayModeBar: false,
    });
  }, [Plotly, series, segments, mobile, activeRange, showCallWall, showPutWall]);

  const handleBrushChange = useCallback((minMs, maxMs) => {
    setTimeRange([msToIso(minMs), msToIso(maxMs)]);
  }, []);

  if (plotlyError) {
    return (
      <div className="card" style={{ padding: '1rem', color: 'var(--accent-coral)' }}>
        Chart unavailable: Plotly failed to load ({plotlyError}).
      </div>
    );
  }
  if (error) {
    return (
      <div className="card" style={{ padding: '1rem', color: 'var(--accent-coral)' }}>
        Daily SPX/Vol-Flip fetch failed: {error}
      </div>
    );
  }
  if (loading) {
    return <div className="skeleton-card" style={{ height: '600px' }} />;
  }
  if (!data || series.length === 0) {
    return (
      <div className="card text-muted">
        No daily SPX/Vol-Flip samples available yet.
      </div>
    );
  }

  return (
    <div className="card" style={{ position: 'relative' }}>
      <div
        style={{
          position: 'absolute',
          top: mobile ? '0.3rem' : '0.5rem',
          left: mobile ? '0.3rem' : '0.5rem',
          zIndex: 5,
          display: 'flex',
          gap: '0.4rem',
          alignItems: 'center',
        }}
      >
        <ToggleButton
          active={showPutWall}
          onClick={() => setShowPutWall((v) => !v)}
          label="Put Wall"
          activeBg="rgba(231,76,60,0.22)"
          activeBorder="rgba(231,76,60,0.85)"
          mobile={mobile}
        />
        <ToggleButton
          active={showCallWall}
          onClick={() => setShowCallWall((v) => !v)}
          label="Call Wall"
          activeBg="rgba(46,204,113,0.22)"
          activeBorder="rgba(46,204,113,0.85)"
          mobile={mobile}
        />
        <ResetButton visible={timeRange != null} onClick={() => setTimeRange(null)} inline />
      </div>
      <div
        ref={chartRef}
        style={{ width: '100%', height: '560px', backgroundColor: 'var(--bg-card)' }}
      />
      {activeRange && firstDate && lastDate && (
        <RangeBrush
          min={isoToMs(firstDate)}
          max={isoToMs(lastDate)}
          activeMin={isoToMs(activeRange[0])}
          activeMax={isoToMs(activeRange[1])}
          onChange={handleBrushChange}
        />
      )}
    </div>
  );
}
