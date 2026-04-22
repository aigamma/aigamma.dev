import { useEffect, useMemo, useRef } from 'react';
import usePlotly from '../../src/hooks/usePlotly';
import useIsMobile from '../../src/hooks/useIsMobile';
import { useGexHistory } from '../../src/hooks/useHistoricalData';
import {
  PLOTLY_COLORS,
  PLOTLY_FONT_FAMILY,
  plotly2DChartLayout,
  plotlyAxis,
  plotlyTitle,
} from '../../src/lib/plotlyTheme';

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

const BLUE_FILL = 'rgba(74, 158, 255, 0.28)';
const RED_FILL = 'rgba(216, 90, 48, 0.30)';
const BLUE_LINE = PLOTLY_COLORS.primary;
const RED_LINE = '#d85a30';
const FLIP_LINE = 'rgba(224, 224, 224, 0.55)';
const HISTORY_FROM = '2022-01-03';

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

export const slotName = 'SPX vs Vol Flip · Daily Gamma Regime';

export default function SlotA() {
  const chartRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();
  const { data, loading, error } = useGexHistory({ from: HISTORY_FROM });
  const mobile = useIsMobile();

  const series = useMemo(() => {
    if (!data?.series) return [];
    return data.series
      .map((r) => ({ t: r.trading_date, s: r.spx_close, f: r.vol_flip }))
      .filter((r) => r.t && Number.isFinite(r.s) && Number.isFinite(r.f));
  }, [data]);

  const segments = useMemo(() => buildSegments(series), [series]);

  useEffect(() => {
    if (!Plotly || !chartRef.current || series.length === 0) return;

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
      line: { color: FLIP_LINE, dash: 'dot', width: 1.5 },
      name: '<b>Vol Flip</b>',
      hovertemplate: '%{x|%b %d, %Y}<br>Vol Flip: %{y:,.2f}<extra></extra>',
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

    const traces = [...fillTraces, flipTrace, ...lineTraces];

    const spot = series.map((r) => r.s);
    const allY = [...spot, ...flip];
    const yMin = Math.min(...allY);
    const yMax = Math.max(...allY);
    const pad = Math.max((yMax - yMin) * 0.05, 1);

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
      }),
      yaxis: plotlyAxis(mobile ? '' : 'SPX', {
        tickformat: ',.0f',
        range: [yMin - pad, yMax + pad],
        autorange: false,
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
  }, [Plotly, series, segments, mobile]);

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
    return <div className="skeleton-card" style={{ height: '560px' }} />;
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
        ref={chartRef}
        style={{ width: '100%', height: '560px', backgroundColor: 'var(--bg-card)' }}
      />
    </div>
  );
}
