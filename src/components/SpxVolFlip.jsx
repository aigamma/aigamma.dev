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
// interaction model: default window is the trailing 6 months of the
// series, the brush exposes the full history for expansion, and the
// y-axis tightens to the visible window on every brush commit so zoomed
// regions don't sit flattened against distant out-of-view extrema.

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

function addMonthsIso(iso, months) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
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

// Compute a tight y-axis range (5% padded) over the (spot, flip, call
// wall, put wall) values whose date falls inside [xStart, xEnd]
// inclusive. Call Wall and Put Wall are often outside the spot-vs-flip
// band — Call Wall typically sits 2-5% above spot and Put Wall 3-8%
// below — so including both in the range calculation guarantees the
// full span of the four visible series is always inside the plot area
// no matter how the brush is positioned. Returns null if nothing falls
// in the window so callers can leave the existing range alone rather
// than collapsing the axis to a degenerate span.
function computeYRange(series, xStart, xEnd) {
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
    consider(r.cw);
    consider(r.pw);
  }
  if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) return null;
  if (yMax === yMin) {
    const pad = Math.max(yMin * 0.01, 1);
    return [yMin - pad, yMax + pad];
  }
  const pad = (yMax - yMin) * 0.05;
  return [yMin - pad, yMax + pad];
}

export default function SpxVolFlip() {
  const chartRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();
  const { data, loading, error } = useGexHistory({ from: HISTORY_FROM });
  const mobile = useIsMobile();
  const [timeRange, setTimeRange] = useState(null);

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
    const sixMonthsBack = addMonthsIso(lastDate, -6);
    return [sixMonthsBack >= firstDate ? sixMonthsBack : firstDate, lastDate];
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
    // points rather than interpolating across them. Off by default
    // (visible:'legendonly') with a clickable legend entry — the SPX /
    // Vol Flip story is the primary narrative of this card, and the
    // walls crowd the chart with two additional step lines that often
    // sit well outside the spot-vs-flip band (Call Wall 2-5% above
    // spot, Put Wall 3-8% below) and stretch the y-axis vertically.
    // The reader opts in to either wall by clicking the legend entry,
    // which toggles it to fully visible without needing a separate
    // control surface. Legend entries render grayed-out when hidden so
    // the affordance is obvious.
    const callWallValues = series.map((r) => r.cw);
    const putWallValues = series.map((r) => r.pw);
    const callWallTrace = {
      x: times,
      y: callWallValues,
      mode: 'lines',
      type: 'scatter',
      line: { color: CALL_WALL_LINE, width: 1.5, shape: 'hv' },
      name: '<b>Call Wall</b>',
      hovertemplate: '%{x|%b %d, %Y}<br>Call Wall: %{y:,.0f}<extra></extra>',
      connectgaps: false,
      showlegend: true,
      visible: 'legendonly',
    };
    const putWallTrace = {
      x: times,
      y: putWallValues,
      mode: 'lines',
      type: 'scatter',
      line: { color: PUT_WALL_LINE, width: 1.5, shape: 'hv' },
      name: '<b>Put Wall</b>',
      hovertemplate: '%{x|%b %d, %Y}<br>Put Wall: %{y:,.0f}<extra></extra>',
      connectgaps: false,
      showlegend: true,
      visible: 'legendonly',
    };

    let aboveLegendShown = false;
    let belowLegendShown = false;
    const lineTraces = [];
    for (const seg of segments) {
      if (seg.ts.length < 2) continue;
      if (seg.kind === 'above') {
        lineTraces.push(
          segmentLineTrace(
            seg,
            BLUE_LINE,
            !aboveLegendShown,
            '<b>SPX · above Flip</b>',
            'spx-above',
          ),
        );
        aboveLegendShown = true;
      } else {
        lineTraces.push(
          segmentLineTrace(
            seg,
            RED_LINE,
            !belowLegendShown,
            '<b>SPX · below Flip</b>',
            'spx-below',
          ),
        );
        belowLegendShown = true;
      }
    }

    const traces = [...fillTraces, flipTrace, callWallTrace, putWallTrace, ...lineTraces];

    const yRange = computeYRange(series, windowStart, windowEnd);

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

    Plotly.newPlot(chartRef.current, traces, layout, {
      responsive: true,
      displayModeBar: false,
    });
  }, [Plotly, series, segments, mobile, activeRange]);

  const handleBrushChange = useCallback((minMs, maxMs) => {
    setTimeRange([msToIso(minMs), msToIso(maxMs)]);
  }, []);

  if (plotlyError) {
    return (
      <div className="card" style={{ padding: '1rem', color: 'var(--accent-coral)' }}>
        Chart unavailable — Plotly failed to load ({plotlyError}).
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
      <ResetButton visible={timeRange != null} onClick={() => setTimeRange(null)} />
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
