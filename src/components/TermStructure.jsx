import { useEffect, useMemo, useRef } from 'react';
import usePlotly from '../hooks/usePlotly';
import {
  PLOTLY_BASE_LAYOUT_2D,
  PLOTLY_COLORS,
  plotlyAxis,
  plotlyRangeslider,
  plotlyTitle,
} from '../lib/plotlyTheme';

// Cloud-band visual language:
// - Independent fill: 'toself' polygons so each quartile is its own
//   compositing-independent region — no accidental alpha accumulation
//   across adjacent bands, which was the root cause of the "continuous
//   gradient" look during scaffolding.
// - Outer bands (p10-p25, p75-p90) darker; inner bands (p25-p50, p50-p75)
//   lighter, so a trace near the extremes is visually loud and a trace
//   near the median is visually calm.
// - Thin boundary strokes at p25, p50, p75 render the hard edges
//   explicitly so the p50 line is visible even though the two inner
//   quartiles share a shade.
// The observed ATM IV curve sits ON TOP of the bands in the same chart —
// cloud is historical context for today's term structure, not a separate
// view. One chart, one scale.
const BAND_OUTER     = 'rgba(74, 158, 255, 0.55)';
const BAND_INNER     = 'rgba(74, 158, 255, 0.12)';
const BOUNDARY_COLOR = 'rgba(74, 158, 255, 0.75)';
const MEDIAN_COLOR   = 'rgba(74, 158, 255, 0.90)';

const PLOTLY_LAYOUT_BASE = {
  ...PLOTLY_BASE_LAYOUT_2D,
  margin: { t: 50, r: 40, b: 90, l: 70 },
  yaxis: plotlyAxis('ATM IV (%)', { tickformat: '.1f' }),
};

function tradingDateFromCapturedAt(capturedAt) {
  if (!capturedAt) return null;
  const d = new Date(capturedAt);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

function daysBetween(isoDate, referenceMs) {
  if (!isoDate) return null;
  const target = new Date(`${isoDate}T16:00:00-04:00`).getTime();
  if (Number.isNaN(target)) return null;
  const diff = (target - referenceMs) / (1000 * 60 * 60 * 24);
  return Math.max(0, Math.round(diff * 10) / 10);
}

function toPct(iv) {
  return iv == null ? null : iv * 100;
}

function closedPolygon(xDates, yLower, yUpper, fillcolor) {
  return {
    x: [...xDates, ...xDates.slice().reverse()],
    y: [...yLower, ...yUpper.slice().reverse()],
    fill: 'toself',
    fillcolor,
    line: { color: 'rgba(0,0,0,0)', width: 0 },
    mode: 'lines',
    type: 'scatter',
    hoverinfo: 'skip',
    showlegend: false,
  };
}

function boundaryLine(xDates, y, color, width) {
  return {
    x: xDates,
    y,
    mode: 'lines',
    type: 'scatter',
    line: { color, width },
    hoverinfo: 'skip',
    showlegend: false,
  };
}

export default function TermStructure({ expirationMetrics, capturedAt, cloudBands }) {
  const chartRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();

  const tradingDate = useMemo(
    () => tradingDateFromCapturedAt(capturedAt),
    [capturedAt],
  );

  const rows = useMemo(() => {
    if (!expirationMetrics || expirationMetrics.length === 0 || !capturedAt) return [];
    const refMs = new Date(capturedAt).getTime();
    if (Number.isNaN(refMs)) return [];
    return expirationMetrics
      .map((m) => ({
        expiration: m.expiration_date,
        dte: daysBetween(m.expiration_date, refMs),
        atmIv: m.atm_iv,
      }))
      .filter((r) => r.dte != null)
      .sort((a, b) => a.dte - b.dte);
  }, [expirationMetrics, capturedAt]);

  useEffect(() => {
    if (!Plotly || !chartRef.current || rows.length === 0) return;

    const traces = [];

    if (cloudBands && cloudBands.length > 0) {
      const xDates = cloudBands.map((b) => b.expiration_date);
      const p10 = cloudBands.map((b) => toPct(b.iv_p10));
      const p25 = cloudBands.map((b) => toPct(b.iv_p25));
      const p50 = cloudBands.map((b) => toPct(b.iv_p50));
      const p75 = cloudBands.map((b) => toPct(b.iv_p75));
      const p90 = cloudBands.map((b) => toPct(b.iv_p90));

      traces.push(
        closedPolygon(xDates, p10, p25, BAND_OUTER),
        closedPolygon(xDates, p25, p50, BAND_INNER),
        closedPolygon(xDates, p50, p75, BAND_INNER),
        closedPolygon(xDates, p75, p90, BAND_OUTER),
        boundaryLine(xDates, p25, BOUNDARY_COLOR, 1),
        boundaryLine(xDates, p50, MEDIAN_COLOR,   1.25),
        boundaryLine(xDates, p75, BOUNDARY_COLOR, 1),
      );
    }

    // Observed ATM IV curve — calendar-date x, DTE shown in hover tooltip.
    traces.push({
      x: rows.map((r) => r.expiration),
      y: rows.map((r) => (r.atmIv == null ? null : r.atmIv * 100)),
      mode: 'lines+markers',
      type: 'scatter',
      name: 'ATM IV',
      line: { color: PLOTLY_COLORS.primary, width: 2 },
      marker: { color: PLOTLY_COLORS.primary, size: 9, symbol: 'circle' },
      text: rows.map((r) => `DTE ${r.dte}`),
      hovertemplate: '%{x}<br>%{text}<br>ATM IV: %{y:.2f}%<extra></extra>',
    });

    const cloudLast = cloudBands && cloudBands.length > 0
      ? cloudBands[cloudBands.length - 1].expiration_date
      : rows[rows.length - 1].expiration;
    const startDate = tradingDate || rows[0].expiration;
    const initialWindowEnd = cloudBands && cloudBands.length > 90
      ? cloudBands[90].expiration_date
      : cloudLast;

    const shapes = [];
    const annotations = [];
    if (tradingDate) {
      shapes.push({
        type: 'line',
        xref: 'x', yref: 'paper',
        x0: tradingDate, x1: tradingDate,
        y0: 0, y1: 1,
        line: { color: PLOTLY_COLORS.axisText, width: 1, dash: 'dash' },
      });
      annotations.push({
        xref: 'x', yref: 'paper',
        x: tradingDate, y: 1.02,
        text: 'today',
        showarrow: false,
        xanchor: 'left',
        font: {
          family: 'Courier New, monospace',
          size: 11,
          color: PLOTLY_COLORS.axisText,
        },
      });
    }

    const layout = {
      ...PLOTLY_LAYOUT_BASE,
      title: plotlyTitle('Term Structure'),
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      xaxis: plotlyAxis('', {
        type: 'date',
        range: [startDate, initialWindowEnd],
        autorange: false,
        rangeslider: plotlyRangeslider({
          range: [startDate, cloudLast],
          autorange: false,
        }),
      }),
      shapes,
      annotations,
    };

    Plotly.newPlot(chartRef.current, traces, layout, {
      responsive: true,
      displayModeBar: false,
    });
  }, [Plotly, rows, cloudBands, tradingDate]);

  if (plotlyError) {
    return (
      <div
        className="card"
        style={{ padding: '1rem', marginBottom: '1rem', color: 'var(--accent-coral)' }}
      >
        Term structure unavailable — Plotly failed to load ({plotlyError}).
      </div>
    );
  }
  if (!expirationMetrics || expirationMetrics.length < 2) {
    return null;
  }

  return (
    <div className="card" style={{ marginBottom: '1rem' }}>
      <div ref={chartRef} style={{ width: '100%', height: '720px', backgroundColor: 'var(--bg-card)' }} />
    </div>
  );
}
