import { useEffect, useMemo, useRef } from 'react';
import usePlotly from '../hooks/usePlotly';
import {
  PLOTLY_BASE_LAYOUT_2D,
  PLOTLY_COLORS,
  plotlyAxis,
  plotlyRangeslider,
  plotlyTitle,
} from '../lib/plotlyTheme';

const PLOTLY_LAYOUT_BASE = {
  ...PLOTLY_BASE_LAYOUT_2D,
  margin: { t: 40, r: 40, b: 60, l: 70 },
  xaxis: plotlyAxis('Days to Expiration', { rangeslider: plotlyRangeslider() }),
  yaxis: plotlyAxis('ATM IV (%)', { tickformat: '.1f' }),
};

function daysBetween(isoDate, referenceMs) {
  if (!isoDate) return null;
  const target = new Date(`${isoDate}T16:00:00-04:00`).getTime();
  if (Number.isNaN(target)) return null;
  const diff = (target - referenceMs) / (1000 * 60 * 60 * 24);
  return Math.max(0, Math.round(diff * 10) / 10);
}

export default function TermStructure({ expirationMetrics, capturedAt }) {
  const chartRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();

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

    const traces = [
      {
        x: rows.map((r) => r.dte),
        y: rows.map((r) => (r.atmIv == null ? null : r.atmIv * 100)),
        mode: 'lines+markers',
        type: 'scatter',
        name: 'ATM IV',
        line: { color: PLOTLY_COLORS.primary, width: 2 },
        marker: { color: PLOTLY_COLORS.primary, size: 9, symbol: 'circle' },
        yaxis: 'y',
        text: rows.map((r) => r.expiration),
        hovertemplate: '%{text}<br>DTE %{x}<br>ATM IV: %{y:.2f}%<extra></extra>',
      },
    ];

    const maxDte = rows[rows.length - 1].dte;
    const zoomLow = 0;
    const zoomHigh = Math.min(100, maxDte);

    const layout = {
      ...PLOTLY_LAYOUT_BASE,
      title: plotlyTitle('Term Structure'),
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      xaxis: plotlyAxis('Days to Expiration', {
        range: [zoomLow, zoomHigh],
        autorange: false,
        rangeslider: plotlyRangeslider({ range: [0, maxDte], autorange: false }),
      }),
    };

    Plotly.newPlot(chartRef.current, traces, layout, {
      responsive: true,
      displayModeBar: false,
    });
  }, [Plotly, rows]);

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
      <div ref={chartRef} style={{ width: '100%', height: '400px', backgroundColor: 'var(--bg-card)' }} />
    </div>
  );
}
