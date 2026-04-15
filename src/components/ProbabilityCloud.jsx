import { useEffect, useMemo, useRef } from 'react';
import usePlotly from '../hooks/usePlotly';
import {
  PLOTLY_BASE_LAYOUT_2D,
  PLOTLY_COLORS,
  plotlyAxis,
  plotlyRangeslider,
  plotlyTitle,
} from '../lib/plotlyTheme';

// Four discrete quartile bands render behind the observed ATM-IV curve.
// Drawn as independent fill: 'toself' closed polygons rather than stacked
// fill: 'tonexty' traces so each band is its own compositing-independent
// region — no accidental alpha accumulation across adjacent bands, which
// was the root cause of the "continuous gradient" look. Outer bands
// (p10-p25, p75-p90) are darker; inner bands (p25-p50, p50-p75) are
// lighter; the alpha gap is wide so the p25 and p75 boundaries read as
// hard edges. Thin boundary strokes at p25, p50, p75 guarantee the p50
// line is visible even though the two adjacent inner bands share a shade.
const BAND_OUTER = 'rgba(74, 158, 255, 0.55)';
const BAND_INNER = 'rgba(74, 158, 255, 0.12)';
const BOUNDARY_COLOR = 'rgba(74, 158, 255, 0.75)';
const MEDIAN_COLOR   = 'rgba(74, 158, 255, 0.90)';

function markerColorForRank(p) {
  if (p == null) return PLOTLY_COLORS.primary;
  if (p < 0.25) return PLOTLY_COLORS.highlight;
  if (p > 0.75) return PLOTLY_COLORS.secondary;
  return PLOTLY_COLORS.primary;
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

export default function ProbabilityCloud({ tradingDate, bands, observed }) {
  const chartRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();

  const { traces, layout } = useMemo(() => {
    if (!tradingDate || !bands || bands.length === 0) {
      return { traces: [], layout: null };
    }

    const xDates = bands.map((b) => b.expiration_date);
    const p10 = bands.map((b) => toPct(b.iv_p10));
    const p25 = bands.map((b) => toPct(b.iv_p25));
    const p50 = bands.map((b) => toPct(b.iv_p50));
    const p75 = bands.map((b) => toPct(b.iv_p75));
    const p90 = bands.map((b) => toPct(b.iv_p90));

    const bandP10P25 = closedPolygon(xDates, p10, p25, BAND_OUTER);
    const bandP25P50 = closedPolygon(xDates, p25, p50, BAND_INNER);
    const bandP50P75 = closedPolygon(xDates, p50, p75, BAND_INNER);
    const bandP75P90 = closedPolygon(xDates, p75, p90, BAND_OUTER);

    const lineP25 = boundaryLine(xDates, p25, BOUNDARY_COLOR, 1);
    const lineP50 = boundaryLine(xDates, p50, MEDIAN_COLOR, 1.25);
    const lineP75 = boundaryLine(xDates, p75, BOUNDARY_COLOR, 1);

    const observedRows = observed || [];
    const obsX = observedRows.map((o) => o.expiration_date);
    const obsY = observedRows.map((o) => toPct(o.atm_iv));
    const obsColors = observedRows.map((o) => markerColorForRank(o.percentile_rank));
    const obsText = observedRows.map((o) => {
      const pct = o.percentile_rank == null
        ? '—'
        : `p${Math.round(o.percentile_rank * 100)}`;
      return `DTE ${o.dte} • rank ${pct}`;
    });
    const observedTrace = {
      x: obsX, y: obsY, mode: 'lines+markers', type: 'scatter',
      name: 'ATM IV',
      line: { color: PLOTLY_COLORS.primary, width: 2 },
      marker: {
        color: obsColors, size: 8,
        line: { color: PLOTLY_COLORS.plot, width: 1 },
      },
      text: obsText,
      hovertemplate: '%{x}<br>%{text}<br>ATM IV: %{y:.2f}%<extra></extra>',
    };

    const allTraces = [
      bandP10P25,
      bandP25P50,
      bandP50P75,
      bandP75P90,
      lineP25,
      lineP50,
      lineP75,
      observedTrace,
    ];

    const firstDate = xDates[0];
    const lastDate = xDates[xDates.length - 1];
    const initialWindowEnd = xDates[Math.min(90, xDates.length - 1)];

    const computedLayout = {
      ...PLOTLY_BASE_LAYOUT_2D,
      margin: { t: 50, r: 40, b: 90, l: 70 },
      title: plotlyTitle('Probability Cloud'),
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      hovermode: 'x unified',
      xaxis: plotlyAxis('', {
        type: 'date',
        range: [firstDate, initialWindowEnd],
        autorange: false,
        rangeslider: plotlyRangeslider({
          range: [firstDate, lastDate],
          autorange: false,
        }),
      }),
      yaxis: plotlyAxis('ATM IV (%)', { tickformat: '.1f' }),
      shapes: [
        {
          type: 'line',
          xref: 'x', yref: 'paper',
          x0: tradingDate, x1: tradingDate,
          y0: 0, y1: 1,
          line: { color: PLOTLY_COLORS.axisText, width: 1, dash: 'dash' },
        },
      ],
      annotations: [
        {
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
        },
      ],
    };

    return { traces: allTraces, layout: computedLayout };
  }, [tradingDate, bands, observed]);

  useEffect(() => {
    if (!Plotly || !chartRef.current || !layout || traces.length === 0) return;
    Plotly.newPlot(chartRef.current, traces, layout, {
      responsive: true,
      displayModeBar: false,
    });
  }, [Plotly, traces, layout]);

  if (plotlyError) {
    return (
      <div
        className="card"
        style={{ padding: '1rem', marginBottom: '1rem', color: 'var(--accent-coral)' }}
      >
        Probability cloud unavailable — Plotly failed to load ({plotlyError}).
      </div>
    );
  }

  if (!bands || bands.length === 0) return null;

  return (
    <div className="card" style={{ marginBottom: '1rem' }}>
      <div
        ref={chartRef}
        style={{ width: '100%', height: '880px', backgroundColor: 'var(--bg-card)' }}
      />
    </div>
  );
}
