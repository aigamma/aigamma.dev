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
import ResetButton from './ResetButton';

// Scatter of gamma throttle (x) vs 10-day realized volatility (y).
// Each dot is one trading day, colored on a continuous scale by throttle
// value: coral (deep negative gamma) through amber (neutral) to blue
// (strong positive gamma). A custom HTML/CSS date-brush below the scatter
// controls which historical window is included — dragging the handles or
// the window body re-filters the scatter. An exponential fit curve shows
// the structural negative correlation between gamma positioning and
// realized vol. The brush is a plain div-based control rather than
// Plotly's rangeslider because the scatter's x-axis is linear (gamma
// throttle), not a date; embedding a date rangeslider requires a separate
// strip chart, and Plotly's rangeslider silently fails to render in thin
// strips (<~76px of main-plot area above the slider), which burned
// several sessions before this was rewritten as a standalone widget.

const THROTTLE_COLORSCALE = [
  [0.0, '#e74c3c'],
  [0.3, '#f39c12'],
  [0.45, '#f1c40f'],
  [0.55, '#2ecc71'],
  [1.0, '#4a9eff'],
];

const DAY_MS = 86400000;

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

function isoToMs(iso) {
  return new Date(`${iso}T00:00:00Z`).getTime();
}

function msToIso(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// Custom date-range brush — three absolutely-positioned divs inside a
// gray track. Matches the aesthetic of the other charts' Plotly
// rangesliders (gray ends, dark middle, white vertical handles) without
// going through Plotly's SVG rangeslider machinery. Emits onChange only
// on pointer release so the downstream scatter doesn't re-render 60x/s
// during a drag; the brush's own display updates locally at drag rate.
function DateRangeBrush({ firstDate, lastDate, activeRange, onChange, height = 40 }) {
  const trackRef = useRef(null);
  const [dragState, setDragState] = useState(null);

  const firstMs = useMemo(() => isoToMs(firstDate), [firstDate]);
  const lastMs = useMemo(() => isoToMs(lastDate), [lastDate]);
  const totalMs = lastMs - firstMs;

  const displayRange = dragState?.currentRange ?? activeRange;
  const activeMinMs = isoToMs(displayRange[0]);
  const activeMaxMs = isoToMs(displayRange[1]);

  const leftPct = Math.max(0, ((activeMinMs - firstMs) / totalMs) * 100);
  const rightPct = Math.max(0, ((lastMs - activeMaxMs) / totalMs) * 100);

  const handlePointerDown = (handle) => (e) => {
    if (!trackRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    e.target.setPointerCapture?.(e.pointerId);
    setDragState({
      handle,
      startClientX: e.clientX,
      startMin: isoToMs(activeRange[0]),
      startMax: isoToMs(activeRange[1]),
      rect: trackRef.current.getBoundingClientRect(),
      currentRange: activeRange,
    });
  };

  const handlePointerMove = (e) => {
    if (!dragState) return;
    const { handle, startClientX, startMin, startMax, rect } = dragState;
    if (rect.width <= 0) return;
    const deltaMs = ((e.clientX - startClientX) / rect.width) * totalMs;

    let newRange;
    if (handle === 'min') {
      const newMin = Math.max(firstMs, Math.min(startMax - DAY_MS * 5, startMin + deltaMs));
      newRange = [msToIso(newMin), msToIso(startMax)];
    } else if (handle === 'max') {
      const newMax = Math.min(lastMs, Math.max(startMin + DAY_MS * 5, startMax + deltaMs));
      newRange = [msToIso(startMin), msToIso(newMax)];
    } else {
      const windowWidth = startMax - startMin;
      let newMin = startMin + deltaMs;
      let newMax = newMin + windowWidth;
      if (newMin < firstMs) {
        newMin = firstMs;
        newMax = firstMs + windowWidth;
      }
      if (newMax > lastMs) {
        newMax = lastMs;
        newMin = lastMs - windowWidth;
      }
      newRange = [msToIso(newMin), msToIso(newMax)];
    }
    setDragState({ ...dragState, currentRange: newRange });
  };

  const handlePointerUp = () => {
    if (!dragState) return;
    onChange(dragState.currentRange);
    setDragState(null);
  };

  return (
    <div
      ref={trackRef}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      style={{
        width: '100%',
        height: `${height}px`,
        backgroundColor: 'rgba(138, 143, 156, 0.32)',
        position: 'relative',
        userSelect: 'none',
        touchAction: 'none',
        borderLeft: `1px solid ${PLOTLY_COLORS.grid}`,
        borderRight: `1px solid ${PLOTLY_COLORS.grid}`,
        borderBottom: `1px solid ${PLOTLY_COLORS.grid}`,
      }}
    >
      <div
        onPointerDown={handlePointerDown('window')}
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: `${leftPct}%`,
          right: `${rightPct}%`,
          backgroundColor: PLOTLY_COLORS.plot,
          cursor: dragState?.handle === 'window' ? 'grabbing' : 'grab',
        }}
      />
      <div
        onPointerDown={handlePointerDown('min')}
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: `calc(${leftPct}% - 3px)`,
          width: '6px',
          backgroundColor: PLOTLY_COLORS.titleText,
          cursor: 'ew-resize',
        }}
      />
      <div
        onPointerDown={handlePointerDown('max')}
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          right: `calc(${rightPct}% - 3px)`,
          width: '6px',
          backgroundColor: PLOTLY_COLORS.titleText,
          cursor: 'ew-resize',
        }}
      />
    </div>
  );
}

export default function GammaThrottleScatter() {
  const scatterRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();
  const { data, loading, error } = useGexHistory({});
  const mobile = useIsMobile();

  const fullSeries = useMemo(() => {
    if (!data?.series) return [];
    return data.series.filter(
      (r) => r.gamma_throttle != null && r.hv_10d != null && r.hv_10d > 0 && r.spx_close != null,
    );
  }, [data]);

  const [timeRange, setTimeRange] = useState(null);

  // Default zoom spans the full available history on both sides so the
  // scatter renders with every historical sample visible and the brush
  // sits fully extended to its outer edges. Users can still narrow the
  // window by dragging the handles inward.
  const defaultRange = useMemo(() => {
    if (fullSeries.length === 0) return null;
    const first = fullSeries[0].trading_date;
    const last = fullSeries[fullSeries.length - 1].trading_date;
    return [first, last];
  }, [fullSeries]);

  const activeRange = timeRange || defaultRange;

  const filtered = useMemo(() => {
    if (!activeRange || fullSeries.length === 0) return fullSeries;
    return fullSeries.filter(
      (r) => r.trading_date >= activeRange[0] && r.trading_date <= activeRange[1],
    );
  }, [fullSeries, activeRange]);

  const stats = useMemo(() => {
    const total = filtered.length;
    const pos = filtered.filter((r) => r.regime === 'positive').length;
    const neg = total - pos;
    const ratio = neg > 0 ? pos / neg : pos > 0 ? Infinity : 0;
    return { total, pos, neg, ratio };
  }, [filtered]);

  const lastPoint = useMemo(() => {
    if (fullSeries.length === 0) return null;
    return fullSeries[fullSeries.length - 1];
  }, [fullSeries]);

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

  const handleBrushChange = useCallback((range) => {
    setTimeRange(range);
  }, []);

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

    const xMin = Math.min(...throttleVals);
    const xMax = Math.max(...throttleVals);
    const xPad = Math.max((xMax - xMin) * 0.05, 2);
    const yMax = Math.max(...rvVals);

    const traces = [];

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
  }, [Plotly, filtered, fitCurve, lastPoint, mobile, stats]);

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
    return <div className="skeleton-card" style={{ height: '640px', marginBottom: '1rem' }} />;
  }
  if (!data || fullSeries.length === 0) {
    return (
      <div className="card text-muted" style={{ marginBottom: '1rem' }}>
        No GEX history available yet — the daily_gex_stats backfill has not been run.
      </div>
    );
  }

  const firstDate = fullSeries[0].trading_date;
  const lastDate = fullSeries[fullSeries.length - 1].trading_date;

  return (
    <div className="card" style={{ marginBottom: '1rem', position: 'relative' }}>
      <ResetButton visible={timeRange != null} onClick={() => setTimeRange(null)} />
      <div ref={scatterRef} style={{ width: '100%', height: '600px', backgroundColor: 'var(--bg-card)' }} />
      <DateRangeBrush
        firstDate={firstDate}
        lastDate={lastDate}
        activeRange={activeRange}
        onChange={handleBrushChange}
        height={40}
      />
    </div>
  );
}
