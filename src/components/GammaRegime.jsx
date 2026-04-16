import { useEffect, useMemo, useRef } from 'react';
import usePlotly from '../hooks/usePlotly';
import { useSpotFlipHistory } from '../hooks/useHistoricalData';
import {
  PLOTLY_COLORS,
  PLOTLY_FONT_FAMILY,
  PLOTLY_FONTS,
  plotly2DChartLayout,
  plotlyAxis,
  plotlyRangeslider,
  plotlyTitle,
} from '../lib/plotlyTheme';

// Visual language for the Gamma Regime chart:
// - SPX price line colored by regime: blue when spot is above the gamma
//   flip level (positive gamma, dealers dampen moves), red when below
//   (negative gamma, dealers amplify moves).
// - Gamma flip as a dashed amber reference line. The flip is the
//   zero-crossing of the dealer gamma profile — the level where
//   aggregate dealer hedging switches from stabilizing to destabilizing.
// - Danger zone: red fill between the price line and the flip line
//   whenever spot is below flip, so the negative-gamma region is
//   visually obvious at a glance. A faint blue fill sits above flip
//   for context but stays subdued so the danger zone pops.
// - Legend sits in the top margin band below the title, matching the
//   VRP chart's horizontal layout.
const ABOVE_COLOR  = PLOTLY_COLORS.primary;
const BELOW_COLOR  = PLOTLY_COLORS.secondary;
const FLIP_COLOR   = PLOTLY_COLORS.highlight;
const DANGER_FILL  = 'rgba(231, 76, 60, 0.25)';
const SAFE_FILL    = 'rgba(74, 158, 255, 0.08)';

// Walk the spot/flip time series and split into contiguous above/below
// segments, interpolating crossings. Each segment carries its own
// arrays so it can be rendered as an independent trace with
// regime-appropriate coloring. The crossing point is computed by
// linear interpolation on both time and price so adjacent polygons
// share a vertex with no gap or overlap — same pattern as the VRP
// chart's buildVrpSegments.
function buildRegimeSegments(series) {
  const segments = [];
  if (!series || series.length === 0) return segments;

  let current = null;
  const open = (kind) => {
    current = { kind, ts: [], spots: [], flips: [] };
    segments.push(current);
  };
  const push = (t, s, f) => {
    current.ts.push(t);
    current.spots.push(s);
    current.flips.push(f);
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
      const t = Math.abs(prevDelta) / (Math.abs(prevDelta) + Math.abs(currDelta));
      const prevMs = new Date(prev.t).getTime();
      const currMs = new Date(curr.t).getTime();
      const crossT = new Date(prevMs + t * (currMs - prevMs)).toISOString();
      const crossS = prev.s + t * (curr.s - prev.s);
      const crossF = prev.f + t * (curr.f - prev.f);
      push(crossT, crossS, crossF);
      open(currKind);
      push(crossT, crossS, crossF);
    }
    push(curr.t, curr.s, curr.f);
    prevKind = currKind;
  }
  return segments;
}

// Closed polygon for a fill between the spot line and the flip line
// over a segment's time range. Walk forward along spot, backward along
// flip to close the polygon — same toself trick as the VRP chart.
function regimeFillTrace(segment, fillcolor) {
  return {
    x: [...segment.ts, ...segment.ts.slice().reverse()],
    y: [...segment.spots, ...segment.flips.slice().reverse()],
    fill: 'toself',
    fillcolor,
    line: { color: 'rgba(0,0,0,0)', width: 0 },
    mode: 'lines',
    type: 'scatter',
    showlegend: false,
    hoverinfo: 'skip',
  };
}

export default function GammaRegime() {
  const chartRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();
  const { data, loading, error } = useSpotFlipHistory({});

  const series = useMemo(() => {
    if (!data?.series) return [];
    return data.series.filter((r) => r.s != null && r.f != null);
  }, [data]);

  const segments = useMemo(() => buildRegimeSegments(series), [series]);

  useEffect(() => {
    if (!Plotly || !chartRef.current || series.length === 0) return;

    const traces = [];

    // Fill polygons first so they sit behind the price lines.
    for (const seg of segments) {
      if (seg.ts.length < 2) continue;
      traces.push(regimeFillTrace(seg, seg.kind === 'below' ? DANGER_FILL : SAFE_FILL));
    }

    // Spot price line segments colored by regime.
    for (const seg of segments) {
      traces.push({
        x: seg.ts,
        y: seg.spots,
        mode: 'lines',
        type: 'scatter',
        line: { color: seg.kind === 'above' ? ABOVE_COLOR : BELOW_COLOR, width: 2 },
        showlegend: false,
        hovertemplate: '%{x}<br>SPX: %{y:,.2f}<extra></extra>',
      });
    }

    // Flip level as a single dashed amber line across the full range.
    traces.push({
      x: series.map((r) => r.t),
      y: series.map((r) => r.f),
      mode: 'lines',
      type: 'scatter',
      line: { color: FLIP_COLOR, width: 2, dash: 'dash' },
      name: '<b>Gamma Flip</b>',
      hovertemplate: '%{x}<br>Flip: %{y:,.0f}<extra></extra>',
    });

    // Dummy legend entries for SPX regime coloring.
    traces.push(
      {
        x: [null],
        y: [null],
        mode: 'lines',
        type: 'scatter',
        line: { color: ABOVE_COLOR, width: 2 },
        name: '<b>SPX (positive \u03b3)</b>',
      },
      {
        x: [null],
        y: [null],
        mode: 'lines',
        type: 'scatter',
        line: { color: BELOW_COLOR, width: 2 },
        name: '<b>SPX (negative \u03b3)</b>',
      },
    );

    const spots = series.map((r) => r.s);
    const flips = series.map((r) => r.f);
    const allY = [...spots, ...flips];
    const yMin = Math.min(...allY);
    const yMax = Math.max(...allY);
    const yPad = (yMax - yMin) * 0.05 || 50;

    const firstT = series[0].t;
    const lastT = series[series.length - 1].t;
    // Default zoom: last 7 calendar days of intraday data.
    const sevenDaysAgo = new Date(new Date(lastT).getTime() - 7 * 86400000).toISOString();
    const windowStart = sevenDaysAgo >= firstT ? sevenDaysAgo : firstT;

    const axisTitleFont = {
      family: PLOTLY_FONT_FAMILY,
      color: PLOTLY_COLORS.titleText,
      size: 20,
    };
    const legendFont = {
      family: PLOTLY_FONT_FAMILY,
      color: PLOTLY_COLORS.titleText,
      size: 18,
    };

    const layout = plotly2DChartLayout({
      margin: { t: 100, r: 30, b: 15, l: 80 },
      title: {
        ...plotlyTitle('Gamma Regime'),
        y: 0.97,
        yref: 'container',
        yanchor: 'top',
      },
      xaxis: plotlyAxis('', {
        type: 'date',
        range: [windowStart, lastT],
        autorange: false,
        rangeslider: plotlyRangeslider({
          range: [firstT, lastT],
          autorange: false,
        }),
      }),
      yaxis: {
        ...plotlyAxis('', {
          range: [yMin - yPad, yMax + yPad],
          autorange: false,
          tickformat: ',.0f',
          ticks: 'outside',
          ticklen: 8,
          tickcolor: 'rgba(0,0,0,0)',
        }),
        title: {
          text: 'SPX',
          font: { ...axisTitleFont, color: PLOTLY_COLORS.primary },
          standoff: 10,
        },
        tickfont: { ...PLOTLY_FONTS.axisTick, color: PLOTLY_COLORS.primary },
      },
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
  }, [Plotly, series, segments]);

  if (plotlyError) {
    return (
      <div className="card" style={{ padding: '1rem', marginBottom: '1rem', color: 'var(--accent-coral)' }}>
        Gamma regime unavailable — Plotly failed to load ({plotlyError}).
      </div>
    );
  }
  if (error) {
    return (
      <div className="card" style={{ padding: '1rem', marginBottom: '1rem', color: 'var(--accent-coral)' }}>
        Gamma regime fetch failed: {error}
      </div>
    );
  }
  if (loading) {
    return <div className="skeleton-card" style={{ height: '600px', marginBottom: '1rem' }} />;
  }
  if (!data || series.length === 0) {
    return (
      <div className="card text-muted" style={{ marginBottom: '1rem' }}>
        No gamma regime history available — intraday spot/flip data has not been collected yet.
      </div>
    );
  }

  return (
    <div className="card" style={{ marginBottom: '1rem' }}>
      <div ref={chartRef} style={{ width: '100%', height: '600px', backgroundColor: 'var(--bg-card)' }} />
    </div>
  );
}
