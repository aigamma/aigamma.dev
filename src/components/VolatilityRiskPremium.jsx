import { useEffect, useMemo, useRef } from 'react';
import usePlotly from '../hooks/usePlotly';
import { useVrpHistory } from '../hooks/useHistoricalData';
import {
  PLOTLY_COLORS,
  PLOTLY_FONTS,
  plotly2DChartLayout,
  plotlyAxis,
  plotlyRangeslider,
  plotlyTitle,
} from '../lib/plotlyTheme';

// Visual language for the VRP chart:
// - SPX price as a subtle dark-blue filled area anchored to the left y-axis,
//   drawn first so it sits behind everything else as context.
// - Realized vol (Yang-Zhang 20d) and implied vol (30d constant-maturity)
//   as two contrasting lines on the right y-axis, expressed as annualized %.
// - Conditional fill between the two vol lines: green where IV > RV
//   (positive VRP, the normal state where options price more vol than has
//   been realized), red where RV > IV (negative VRP, the rare stressed
//   state where realized has exceeded option-implied expectation).
// - Labels live in the legend only, anchored top-left INSIDE the plot area
//   so they never collide with page margins on mobile.
const POS_VRP_FILL  = 'rgba(46, 204, 113, 0.22)';
const NEG_VRP_FILL  = 'rgba(231, 76, 60, 0.38)';
const SPX_AREA_FILL = 'rgba(74, 158, 255, 0.12)';
const SPX_LINE      = 'rgba(74, 158, 255, 0.55)';
const RV_COLOR      = PLOTLY_COLORS.highlight;
const IV_COLOR      = PLOTLY_COLORS.titleText;

// Walk the (iv, hv) series and emit a list of contiguous same-sign
// segments, splitting at each zero crossing of (iv - hv). Each segment
// carries its own x / iv / hv arrays so the consumer can render it as
// an independent closed polygon (fill: 'toself') bounded by the two
// vol lines on both edges — no fill-down-to-axis ambiguity, no
// null-gap fragility. The zero-crossing point is computed by linear
// interpolation on both x (time) and y (iv=hv at the crossing) and
// appears as the LAST point of the outgoing segment AND the FIRST
// point of the incoming one, so adjacent polygons meet on a shared
// vertex with no gap and no overlap.
function buildVrpSegments(series) {
  const segments = [];
  if (!series || series.length === 0) return segments;

  let current = null;
  const open = (kind) => {
    current = { kind, xs: [], ivs: [], hvs: [] };
    segments.push(current);
  };
  const push = (x, iv, hv) => {
    current.xs.push(x);
    current.ivs.push(iv);
    current.hvs.push(hv);
  };

  const first = series[0];
  open(first.iv - first.hv >= 0 ? 'positive' : 'negative');
  push(first.trading_date, first.iv, first.hv);
  let prevKind = current.kind;

  for (let i = 1; i < series.length; i++) {
    const curr = series[i];
    const currKind = curr.iv - curr.hv >= 0 ? 'positive' : 'negative';
    if (currKind !== prevKind) {
      const prev = series[i - 1];
      const prevDelta = prev.iv - prev.hv;
      const currDelta = curr.iv - curr.hv;
      const t = Math.abs(prevDelta) / (Math.abs(prevDelta) + Math.abs(currDelta));
      const prevMs = new Date(`${prev.trading_date}T00:00:00Z`).getTime();
      const currMs = new Date(`${curr.trading_date}T00:00:00Z`).getTime();
      const xCross = new Date(prevMs + t * (currMs - prevMs)).toISOString().slice(0, 10);
      const yCross = prev.iv + t * (curr.iv - prev.iv);
      push(xCross, yCross, yCross);
      open(currKind);
      push(xCross, yCross, yCross);
    }
    push(curr.trading_date, curr.iv, curr.hv);
    prevKind = currKind;
  }
  return segments;
}

// Wrap one segment as a single fill:'toself' closed polygon. The
// polygon walks the IV edge forward in time and the HV edge backward,
// so the filled region is exactly the area between the two lines over
// this segment's x-range — never reaching the axis floor, never
// extending past the segment's boundaries.
function vrpSegmentTrace(segment, fillcolor, name, showlegend, legendgroup) {
  return {
    x: [...segment.xs, ...segment.xs.slice().reverse()],
    y: [...segment.ivs, ...segment.hvs.slice().reverse()],
    fill: 'toself',
    fillcolor,
    line: { color: 'rgba(0,0,0,0)', width: 0 },
    mode: 'lines',
    type: 'scatter',
    yaxis: 'y2',
    name,
    legendgroup,
    showlegend,
    hoverinfo: 'skip',
  };
}

function addMonthsIso(iso, months) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

export default function VolatilityRiskPremium() {
  const chartRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();
  const { data, loading, error } = useVrpHistory({});

  const series = useMemo(() => {
    if (!data?.series) return [];
    return data.series
      .filter((r) => r.iv_30d_cm != null && r.hv_20d_yz != null && r.spx_close != null)
      .map((r) => ({
        trading_date: r.trading_date,
        spx_close: r.spx_close,
        iv: r.iv_30d_cm * 100,
        hv: r.hv_20d_yz * 100,
      }));
  }, [data]);

  const spxSeries = useMemo(() => {
    if (!data?.series) return [];
    return data.series
      .filter((r) => r.spx_close != null)
      .map((r) => ({ trading_date: r.trading_date, spx_close: r.spx_close }));
  }, [data]);

  const vrpSegments = useMemo(() => buildVrpSegments(series), [series]);

  useEffect(() => {
    if (!Plotly || !chartRef.current || series.length === 0 || spxSeries.length === 0) return;

    const spxMin = Math.min(...spxSeries.map((r) => r.spx_close));
    const spxMax = Math.max(...spxSeries.map((r) => r.spx_close));
    const spxLo = spxMin * 0.95;
    const spxHi = spxMax * 1.02;

    // Closed polygon for the SPX area — close series along the top,
    // constant axis-floor along the bottom. `fill: 'toself'` + the
    // reversed-x trick avoids the y=0 waste that `fill: 'tozeroy'`
    // would produce on a chart whose y-axis floor sits far above zero.
    const spxDates = spxSeries.map((r) => r.trading_date);
    const spxClose = spxSeries.map((r) => r.spx_close);
    const spxAreaTrace = {
      x: [...spxDates, ...spxDates.slice().reverse()],
      y: [...spxClose, ...spxClose.map(() => spxLo)],
      fill: 'toself',
      fillcolor: SPX_AREA_FILL,
      line: { color: 'rgba(0,0,0,0)', width: 0 },
      mode: 'lines',
      type: 'scatter',
      hoverinfo: 'skip',
      yaxis: 'y',
      showlegend: false,
    };
    const spxLineTrace = {
      x: spxDates,
      y: spxClose,
      mode: 'lines',
      type: 'scatter',
      line: { color: SPX_LINE, width: 1.5 },
      yaxis: 'y',
      name: 'S&P 500',
      hovertemplate: '%{x}<br>SPX: %{y:,.2f}<extra></extra>',
    };

    // VRP shading is one closed-polygon trace per contiguous same-sign
    // segment. Each polygon is bounded on both edges by the two vol
    // lines themselves, so the fill is a thin ribbon that expands and
    // contracts with the spread — it never drops down to the chart
    // floor the way a fill:'tonexty' pair would on a null-gapped series.
    // Legend entries live on only the first segment of each sign via
    // legendgroup; subsequent segments share the group with
    // showlegend:false so the legend shows one row per color.
    const vrpTraces = [];
    let firstPos = true;
    let firstNeg = true;
    for (const seg of vrpSegments) {
      if (seg.xs.length < 2) continue;
      if (seg.kind === 'positive') {
        vrpTraces.push(vrpSegmentTrace(seg, POS_VRP_FILL, 'Positive VRP (IV > RV)', firstPos, 'vrp_pos'));
        firstPos = false;
      } else {
        vrpTraces.push(vrpSegmentTrace(seg, NEG_VRP_FILL, 'Negative VRP (RV > IV)', firstNeg, 'vrp_neg'));
        firstNeg = false;
      }
    }

    const rvLine = {
      x: series.map((r) => r.trading_date),
      y: series.map((r) => r.hv),
      mode: 'lines',
      type: 'scatter',
      line: { color: RV_COLOR, width: 2 },
      yaxis: 'y2',
      name: 'Realized Vol (20d YZ)',
      hovertemplate: '%{x}<br>RV: %{y:.2f}%<extra></extra>',
    };
    const ivLine = {
      x: series.map((r) => r.trading_date),
      y: series.map((r) => r.iv),
      mode: 'lines',
      type: 'scatter',
      line: { color: IV_COLOR, width: 2 },
      yaxis: 'y2',
      name: 'Implied Vol (30d CM)',
      hovertemplate: '%{x}<br>IV: %{y:.2f}%<extra></extra>',
    };

    const traces = [
      spxAreaTrace,
      spxLineTrace,
      ...vrpTraces,
      rvLine,
      ivLine,
    ];

    const volValues = series.flatMap((r) => [r.iv, r.hv]);
    const volMin = Math.min(...volValues);
    const volMax = Math.max(...volValues);
    const volLo = Math.max(0, volMin * 0.85);
    const volHi = volMax * 1.1;

    const firstDate = series[0].trading_date;
    const lastDate = series[series.length - 1].trading_date;
    // Default zoom: last 6 calendar months. The rangeslider exposes the full
    // backfill range, so the user can drag the left handle out to see the
    // April 2025 tariff vol spike and the months of negative VRP that followed.
    const sixMonthsBack = addMonthsIso(lastDate, -6);
    const windowStart = sixMonthsBack >= firstDate ? sixMonthsBack : firstDate;

    const layout = plotly2DChartLayout({
      margin: { t: 50, r: 80, b: 15, l: 80 },
      title: plotlyTitle('Volatility Risk Premium'),
      xaxis: plotlyAxis('', {
        type: 'date',
        range: [windowStart, lastDate],
        autorange: false,
        rangeslider: plotlyRangeslider({
          range: [firstDate, lastDate],
          autorange: false,
        }),
      }),
      yaxis: plotlyAxis('S&P 500', {
        range: [spxLo, spxHi],
        autorange: false,
        tickformat: ',.0f',
        side: 'left',
        showgrid: false,
      }),
      yaxis2: plotlyAxis('Annualized Vol', {
        range: [volLo, volHi],
        autorange: false,
        tickformat: '.1f',
        ticksuffix: '%',
        side: 'right',
        overlaying: 'y',
      }),
      legend: {
        orientation: 'v',
        x: 0.01,
        y: 0.99,
        xanchor: 'left',
        yanchor: 'top',
        font: PLOTLY_FONTS.legend,
        bgcolor: 'rgba(10, 14, 26, 0.75)',
        bordercolor: PLOTLY_COLORS.grid,
        borderwidth: 1,
      },
      hovermode: 'x unified',
    });

    Plotly.newPlot(chartRef.current, traces, layout, {
      responsive: true,
      displayModeBar: false,
    });
  }, [Plotly, series, vrpSegments, spxSeries]);

  if (plotlyError) {
    return (
      <div className="card" style={{ padding: '1rem', marginBottom: '1rem', color: 'var(--accent-coral)' }}>
        Volatility risk premium unavailable — Plotly failed to load ({plotlyError}).
      </div>
    );
  }
  if (error) {
    return (
      <div className="card" style={{ padding: '1rem', marginBottom: '1rem', color: 'var(--accent-coral)' }}>
        VRP history fetch failed: {error}
      </div>
    );
  }
  if (loading) {
    return <div className="skeleton-card" style={{ height: '720px', marginBottom: '1rem' }} />;
  }
  if (!data || series.length === 0) {
    return (
      <div className="card text-muted" style={{ marginBottom: '1rem' }}>
        No VRP history available yet — the volatility stats backfill has not populated daily_volatility_stats.
      </div>
    );
  }

  return (
    <div className="card" style={{ marginBottom: '1rem' }}>
      <div ref={chartRef} style={{ width: '100%', height: '720px', backgroundColor: 'var(--bg-card)' }} />
    </div>
  );
}
