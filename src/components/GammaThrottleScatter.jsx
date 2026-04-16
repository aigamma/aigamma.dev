import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import usePlotly from '../hooks/usePlotly';
import useIsMobile from '../hooks/useIsMobile';
import { useGexHistory } from '../hooks/useHistoricalData';
import {
  PLOTLY_COLORS,
  PLOTLY_FONT_FAMILY,
  PLOTLY_FONTS,
  plotly2DChartLayout,
  plotlyAxis,
  plotlyRangeslider,
  plotlyTitle,
} from '../lib/plotlyTheme';

// Scatter of gamma throttle (x) vs 10-day realized volatility (y).
// Each dot is one trading day, colored on a continuous scale by throttle
// value: coral (deep negative gamma) through amber (neutral) to blue
// (strong positive gamma). A time-based brush zoom below the scatter
// controls which historical window is included — dragging left reveals
// more history. An exponential fit curve shows the structural negative
// correlation between gamma positioning and realized vol. The counter
// strip between the charts shows total days, positive/negative counts,
// and their ratio.

const THROTTLE_COLORSCALE = [
  [0.0, '#e74c3c'],
  [0.3, '#f39c12'],
  [0.45, '#f1c40f'],
  [0.55, '#2ecc71'],
  [1.0, '#4a9eff'],
];

// Exponential fit: y = a * exp(b * x)
// Solved via OLS on ln(y) = ln(a) + b*x
function exponentialFit(xs, ys) {
  const valid = [];
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] != null && ys[i] != null && ys[i] > 0) {
      valid.push({ x: xs[i], lny: Math.log(ys[i]) });
    }
  }
  if (valid.length < 10) return null;

  const n = valid.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of valid) {
    sx += p.x;
    sy += p.lny;
    sxx += p.x * p.x;
    sxy += p.x * p.lny;
  }
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-12) return null;

  const b = (n * sxy - sx * sy) / denom;
  const lnA = (sy - b * sx) / n;
  const a = Math.exp(lnA);

  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return { a, b };
}

function addMonthsIso(iso, months) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

export default function GammaThrottleScatter() {
  const scatterRef = useRef(null);
  const timeRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();
  const { data, loading, error } = useGexHistory({});
  const mobile = useIsMobile();

  // Full series with valid throttle + rv
  const fullSeries = useMemo(() => {
    if (!data?.series) return [];
    return data.series.filter(
      (r) => r.gamma_throttle != null && r.hv_10d != null && r.hv_10d > 0 && r.spx_close != null,
    );
  }, [data]);

  // Time range state — defaults to last 12 months
  const [timeRange, setTimeRange] = useState(null);

  const defaultRange = useMemo(() => {
    if (fullSeries.length === 0) return null;
    const last = fullSeries[fullSeries.length - 1].trading_date;
    const first = fullSeries[0].trading_date;
    const sixMonthsBack = addMonthsIso(last, -6);
    return [sixMonthsBack >= first ? sixMonthsBack : first, last];
  }, [fullSeries]);

  const activeRange = timeRange || defaultRange;

  // Filtered data within the active time window
  const filtered = useMemo(() => {
    if (!activeRange || fullSeries.length === 0) return fullSeries;
    return fullSeries.filter(
      (r) => r.trading_date >= activeRange[0] && r.trading_date <= activeRange[1],
    );
  }, [fullSeries, activeRange]);

  // Stats for the counter
  const stats = useMemo(() => {
    const total = filtered.length;
    const pos = filtered.filter((r) => r.regime === 'positive').length;
    const neg = total - pos;
    const ratio = neg > 0 ? pos / neg : pos > 0 ? Infinity : 0;
    return { total, pos, neg, ratio };
  }, [filtered]);

  // Last data point (most recent in full series)
  const lastPoint = useMemo(() => {
    if (fullSeries.length === 0) return null;
    return fullSeries[fullSeries.length - 1];
  }, [fullSeries]);

  // Fit curve on the filtered data
  const fitCurve = useMemo(() => {
    if (filtered.length < 10) return null;
    const xs = filtered.map((r) => r.gamma_throttle);
    const ys = filtered.map((r) => r.hv_10d * 100);
    const fit = exponentialFit(xs, ys);
    if (!fit) return null;

    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const curveX = [];
    const curveY = [];
    const steps = 80;
    for (let i = 0; i <= steps; i++) {
      const x = minX + (maxX - minX) * (i / steps);
      const y = fit.a * Math.exp(fit.b * x);
      if (y > 0 && y < 300) {
        curveX.push(x);
        curveY.push(y);
      }
    }
    return { x: curveX, y: curveY };
  }, [filtered]);

  // Handle relayout events from the time strip's rangeslider
  const handleTimeRelayout = useCallback(
    (eventData) => {
      let r0 = eventData['xaxis.range[0]'] ?? eventData['xaxis.range']?.[0];
      let r1 = eventData['xaxis.range[1]'] ?? eventData['xaxis.range']?.[1];
      if (r0 && r1) {
        if (typeof r0 === 'string') r0 = r0.slice(0, 10);
        if (typeof r1 === 'string') r1 = r1.slice(0, 10);
        setTimeRange([r0, r1]);
      }
    },
    [],
  );

  // Render the scatter plot
  const [scatterError, setScatterError] = useState(null);
  useEffect(() => {
    if (!Plotly || !scatterRef.current || filtered.length === 0) return;

    const throttleVals = filtered.map((r) => r.gamma_throttle);
    const rvVals = filtered.map((r) => r.hv_10d * 100);
    const colorVals = filtered.map((r) => r.gamma_throttle);
    const hoverText = filtered.map(
      (r) =>
        `${r.trading_date}<br>Vol Flip: ${r.gamma_throttle.toFixed(1)}<br>10d RV: ${(r.hv_10d * 100).toFixed(1)}%<br>${r.regime === 'positive' ? 'Positive' : 'Negative'} Gamma`,
    );

    const cmin = Math.max(Math.min(...colorVals, -10), -80);
    const cmax = Math.min(Math.max(...colorVals, 10), 60);

    // Explicit axis ranges to bypass Plotly's doAutoRange, which throws
    // "Something went wrong with axis scaling" on certain data shapes.
    const xMin = Math.min(...throttleVals);
    const xMax = Math.max(...throttleVals);
    const xPad = Math.max((xMax - xMin) * 0.05, 2);
    const yMax = Math.max(...rvVals);

    const traces = [];

    // Main scatter
    traces.push({
      x: throttleVals,
      y: rvVals,
      mode: 'markers',
      type: 'scatter',
      marker: {
        size: mobile ? 5 : 6,
        color: colorVals,
        colorscale: THROTTLE_COLORSCALE,
        cmin,
        cmax,
        opacity: 0.8,
        line: { width: 0 },
      },
      text: hoverText,
      hovertemplate: '%{text}<extra></extra>',
      showlegend: false,
    });

    // Fit curve
    if (fitCurve) {
      traces.push({
        x: fitCurve.x,
        y: fitCurve.y,
        mode: 'lines',
        type: 'scatter',
        line: { color: PLOTLY_COLORS.primary, width: 2, dash: 'dot' },
        showlegend: false,
        hoverinfo: 'skip',
      });
    }

    // "Last" marker
    if (lastPoint) {
      traces.push({
        x: [lastPoint.gamma_throttle],
        y: [lastPoint.hv_10d * 100],
        mode: 'markers+text',
        type: 'scatter',
        marker: {
          size: 12,
          color: PLOTLY_COLORS.plot,
          line: { color: PLOTLY_COLORS.titleText, width: 2 },
          symbol: 'diamond',
        },
        text: ['Last'],
        textposition: 'top right',
        textfont: { family: PLOTLY_FONT_FAMILY, color: PLOTLY_COLORS.titleText, size: 13 },
        showlegend: false,
        hovertemplate:
          `${lastPoint.trading_date}<br>Vol Flip: ${lastPoint.gamma_throttle.toFixed(2)}<br>10d RV: ${(lastPoint.hv_10d * 100).toFixed(2)}%<extra></extra>`,
      });
    }

    // Build the upper-right annotation with current values and window stats
    const annotations = [];
    if (lastPoint) {
      const lines = [
        `Vol Flip: ${lastPoint.gamma_throttle.toFixed(2)}`,
        `10d RV: ${(lastPoint.hv_10d * 100).toFixed(2)}%`,
      ];
      if (stats.total > 0) {
        lines.push(`${stats.total} days · <span style="color:${PLOTLY_COLORS.positive}">${stats.pos}</span>/<span style="color:${PLOTLY_COLORS.negative}">${stats.neg}</span>`);
      }
      annotations.push({
        x: 0.99,
        y: 1.15,
        xref: 'paper',
        yref: 'paper',
        text: lines.join('<br>'),
        showarrow: false,
        font: { family: PLOTLY_FONT_FAMILY, color: PLOTLY_COLORS.titleText, size: 16 },
        bgcolor: 'rgba(20, 24, 32, 0.85)',
        bordercolor: PLOTLY_COLORS.grid,
        borderwidth: 1,
        borderpad: 8,
        xanchor: 'right',
        yanchor: 'top',
        align: 'right',
      });
    }

    const layout = plotly2DChartLayout({
      margin: mobile ? { t: 45, r: 15, b: 40, l: 50 } : { t: 80, r: 30, b: 45, l: 70 },
      title: {
        ...plotlyTitle(mobile ? 'Vol Flip vs. 10d RV' : 'Volatility Flip vs. 10d RV'),
        y: 0.97,
        yref: 'container',
        yanchor: 'top',
      },
      xaxis: plotlyAxis('', {
        type: 'linear',
        range: [xMin - xPad, xMax + xPad],
        autorange: false,
        zeroline: true,
        zerolinecolor: PLOTLY_COLORS.zeroLine,
        zerolinewidth: 1,
      }),
      yaxis: plotlyAxis(mobile ? '' : '10-Day Realized Volatility', {
        type: 'linear',
        range: [0, yMax * 1.1],
        autorange: false,
        ticksuffix: '%',
        ticks: 'outside',
        ticklen: 8,
        tickcolor: 'rgba(0,0,0,0)',
      }),
      hovermode: 'closest',
      showlegend: false,
      annotations,
    });

    try {
      Plotly.newPlot(scatterRef.current, traces, layout, {
        responsive: true,
        displayModeBar: false,
      });
      setScatterError(null);
    } catch (err) {
      setScatterError(err.message);
    }
  }, [Plotly, filtered, fitCurve, lastPoint, mobile]);

  // Render the time context strip with rangeslider
  useEffect(() => {
    if (!Plotly || !timeRef.current || fullSeries.length === 0 || !defaultRange) return;

    const dates = fullSeries.map((r) => r.trading_date);
    const closes = fullSeries.map((r) => r.spx_close);
    const firstDate = dates[0];
    const lastDate = dates[dates.length - 1];

    const yMin = Math.min(...closes);
    const yMax = Math.max(...closes);

    // Rangeslider-only strip — no visible chart content above the
    // brush. The trace is colored #141820 (card background) so it's
    // invisible to the user but gives Plotly real renderable data
    // to initialize the axis without triggering the doAutoRange
    // crash that transparent zero-width traces produce. Rangeslider
    // thickness is set high (0.85) so the gray/dark/white brush fills
    // nearly the entire strip. Non-zero margins are required because
    // Plotly's rangeslider creates an internal subplot whose axis
    // scaling crashes when zero margins combined with high thickness
    // leave fewer than ~10px for the main plot area.
    const trace = {
      x: dates,
      y: closes,
      mode: 'lines',
      type: 'scatter',
      line: { color: '#141820', width: 1 },
      hoverinfo: 'skip',
      showlegend: false,
    };

    const layout = plotly2DChartLayout({
      margin: { t: 6, r: mobile ? 15 : 30, b: 5, l: mobile ? 50 : 70 },
      xaxis: plotlyAxis('', {
        type: 'date',
        range: activeRange || defaultRange,
        autorange: false,
        showticklabels: false,
        showgrid: false,
        zeroline: false,
        rangeslider: plotlyRangeslider({
          range: [firstDate, lastDate],
          autorange: false,
          thickness: 0.85,
        }),
      }),
      yaxis: plotlyAxis('', {
        type: 'linear',
        range: [yMin * 0.95, yMax * 1.05],
        autorange: false,
        showticklabels: false,
        showgrid: false,
        zeroline: false,
        fixedrange: true,
      }),
      height: 55,
      showlegend: false,
    });

    Plotly.newPlot(timeRef.current, [trace], layout, {
      responsive: true,
      displayModeBar: false,
    });

    // Wire up relayout listener for the rangeslider
    timeRef.current.on('plotly_relayout', handleTimeRelayout);

    return () => {
      if (timeRef.current) {
        timeRef.current.removeListener?.('plotly_relayout', handleTimeRelayout);
      }
    };
  }, [Plotly, fullSeries, defaultRange, handleTimeRelayout, mobile]);
  // NOTE: activeRange is intentionally excluded from the time strip's
  // dependency array to avoid re-rendering the rangeslider on its own
  // events (which would reset the drag state). The rangeslider is the
  // source of truth for activeRange, not the other way around.

  if (plotlyError) {
    return (
      <div className="card" style={{ padding: '1rem', marginBottom: '1rem', color: 'var(--accent-coral)' }}>
        Gamma throttle scatter unavailable — Plotly failed to load ({plotlyError}).
      </div>
    );
  }
  if (error) {
    return (
      <div className="card" style={{ padding: '1rem', marginBottom: '1rem', color: 'var(--accent-coral)' }}>
        GEX history fetch failed: {error}
      </div>
    );
  }
  if (scatterError) {
    return (
      <div className="card" style={{ padding: '1rem', marginBottom: '1rem', color: 'var(--accent-coral)' }}>
        Gamma throttle scatter render error: {scatterError}
      </div>
    );
  }
  if (loading) {
    return <div className="skeleton-card" style={{ height: '575px', marginBottom: '1rem' }} />;
  }
  if (!data || fullSeries.length === 0) {
    return (
      <div className="card text-muted" style={{ marginBottom: '1rem' }}>
        No GEX history available yet — the daily_gex_stats backfill has not been run.
      </div>
    );
  }

  return (
    <div className="card" style={{ marginBottom: '1rem' }}>
      <div ref={scatterRef} style={{ width: '100%', height: '520px', backgroundColor: 'var(--bg-card)' }} />
      {/* Date brush zoom — a 55px rangeslider-only strip. No visible
          sparkline or chart content above the brush; just the
          gray/dark/white rangeslider control itself. */}
      <div ref={timeRef} style={{ width: '100%', height: '55px', backgroundColor: 'var(--bg-card)' }} />
    </div>
  );
}
