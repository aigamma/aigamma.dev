import { useEffect, useMemo, useRef, useState } from 'react';
import usePlotly from '../hooks/usePlotly';
import {
  plotly2DChartLayout,
  plotlyAxis,
  PLOTLY_COLORS,
  PLOTLY_FONT_FAMILY,
  PLOTLY_FONTS,
} from '../lib/plotlyTheme';

// Sector-performance horizontal-bar trio. Renders the /api/sector-performance
// payload as three horizontal Plotly bar charts stacked vertically (1 day,
// 1 week, 1 month), matching the reference image at C:\i\. Each chart is
// sorted descending by performance with green bars for positive returns
// and red bars for negative; the value (signed percent to two decimals)
// prints at the bar's tip in bold so it reads as the primary number on
// each row, with the GICS sector name on the y-axis on the left. The
// three Plotly instances live in their own refs so the layouts can be
// independently sized — Plotly's subplot machinery shares a y-axis
// across stacked charts in xy mode, which would force every chart's
// sector list to be in the same order; that defeats the purpose of the
// per-horizon ranking, so we render three independent charts instead.
//
// Data flow: SectorPerformanceBars fetches /api/sector-performance once
// on mount and again every UPDATE_INTERVAL_MS (60s) so the chart picks
// up the next daily_eod write within a minute of the upstream backfill
// landing. The endpoint applies a 15-minute edge cache so the polling
// pressure on Supabase is bounded; the polling cadence is just there
// for responsiveness on the client when the user leaves the page open
// across the daily refresh boundary.

const UPDATE_INTERVAL_MS = 60_000;

const POSITIVE_INK = PLOTLY_COLORS.positive; // #2ecc71
const NEGATIVE_INK = PLOTLY_COLORS.negative; // #e74c3c

function formatPct(v) {
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(2)}`;
}

function formatDateLabel(iso) {
  if (!iso || typeof iso !== 'string') return iso ?? '';
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return `${m}/${d}/${y}`;
}

// One Plotly horizontal bar chart for a single horizon (1d / 1w / 1m).
// The y-axis is the sector name in performance-descending order; the
// x-axis is signed percent. autorange='reversed' on the y-axis flips
// Plotly's default bottom-to-top ordering so the best sector appears
// at the top of the chart (matching the reference image's layout).
function buildPanelTraces(rows) {
  if (!rows || rows.length === 0) return { traces: [], names: [] };

  const names = rows.map((r) => r.name);
  const values = rows.map((r) => r.value);
  const colors = values.map((v) => (v >= 0 ? POSITIVE_INK : NEGATIVE_INK));
  const labels = values.map(formatPct);

  const trace = {
    type: 'bar',
    orientation: 'h',
    x: values,
    y: names,
    marker: {
      color: colors,
      line: { color: 'rgba(255,255,255,0.18)', width: 0.6 },
    },
    text: labels,
    textposition: 'outside',
    cliponaxis: false,
    textfont: {
      family: PLOTLY_FONT_FAMILY,
      color: PLOTLY_COLORS.titleText,
      size: 12,
    },
    hovertemplate:
      '<b>%{customdata[0]}</b> · %{y}<br>' +
      '%{x:.2f}%<extra></extra>',
    customdata: rows.map((r) => [r.symbol]),
    showlegend: false,
  };

  return { traces: [trace], names };
}

function buildPanelLayout(rows, panelTitle) {
  if (!rows || rows.length === 0) return null;

  const values = rows.map((r) => r.value);
  const minV = Math.min(...values);
  const maxV = Math.max(...values);

  // Symmetric padding on both ends of the x range so the +N.NN bar-tip
  // labels never get clipped against the right edge and the leftmost
  // negative bar's label has space on the inside as well. The pad is a
  // function of total span so a tight regime still feels framed and a
  // wide regime doesn't waste real estate.
  const span = Math.max(maxV - minV, 1);
  const pad = Math.max(span * 0.25, 0.5);
  const xRange = [minV - pad, maxV + pad];

  return plotly2DChartLayout({
    title: {
      text: panelTitle,
      font: PLOTLY_FONTS.chartTitle,
      x: 0.5,
      xanchor: 'center',
      y: 0.96,
      yanchor: 'top',
    },
    xaxis: plotlyAxis('', {
      range: xRange,
      zeroline: true,
      zerolinecolor: 'rgba(255,255,255,0.25)',
      zerolinewidth: 1.2,
      tickformat: '.1f',
      ticksuffix: '%',
    }),
    yaxis: plotlyAxis('', {
      autorange: 'reversed',
      tickfont: {
        family: PLOTLY_FONT_FAMILY,
        color: PLOTLY_COLORS.titleText,
        size: 12,
      },
    }),
    margin: { t: 50, r: 70, b: 40, l: 170 },
    hovermode: 'closest',
    bargap: 0.25,
  });
}

function PerformancePanel({ rows, title }) {
  const chartRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();

  useEffect(() => {
    if (!Plotly || !chartRef.current || !rows) return;
    const { traces } = buildPanelTraces(rows);
    const layout = buildPanelLayout(rows, title);
    if (!layout) return;
    Plotly.react(chartRef.current, traces, layout, {
      displayModeBar: false,
      responsive: true,
    });
  }, [Plotly, rows, title]);

  if (plotlyError) {
    return (
      <div className="sector-bars__panel sector-bars__panel--error">
        {plotlyError}
      </div>
    );
  }

  return (
    <div className="sector-bars__panel">
      <div ref={chartRef} className="sector-bars__chart" />
    </div>
  );
}

export default function SectorPerformanceBars() {
  const [payload, setPayload] = useState(null);
  const [fetchError, setFetchError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch('/api/sector-performance');
        if (!res.ok) throw new Error(`sector-performance fetch failed: ${res.status}`);
        const json = await res.json();
        if (!cancelled) {
          setPayload(json);
          setFetchError(null);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setFetchError(String(err?.message || err));
          setLoading(false);
        }
      }
    }

    load();
    const id = setInterval(load, UPDATE_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const panels = useMemo(() => payload?.panels ?? null, [payload]);

  if (loading) {
    return (
      <div className="card sector-bars-card">
        <div className="sector-bars__status">Loading sector performance…</div>
      </div>
    );
  }

  if (fetchError || !panels) {
    return (
      <div className="card sector-bars-card">
        <div className="sector-bars__status sector-bars__status--error">
          {fetchError || 'No sector performance data available.'}
        </div>
      </div>
    );
  }

  return (
    <div className="card sector-bars-card">
      <div className="sector-bars__meta">
        <span className="sector-bars__title">Sector Performance</span>
        <span className="sector-bars__meta-line">
          {panels['1d'].length} GICS sectors · sorted by horizon
        </span>
        <span className="sector-bars__asof">
          Through {formatDateLabel(payload.asOf)}
        </span>
      </div>
      <PerformancePanel rows={panels['1d']} title="1 DAY PERFORMANCE" />
      <PerformancePanel rows={panels['1w']} title="1 WEEK PERFORMANCE" />
      <PerformancePanel rows={panels['1m']} title="1 MONTH PERFORMANCE" />
    </div>
  );
}
