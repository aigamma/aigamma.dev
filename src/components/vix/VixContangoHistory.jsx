import { useEffect, useMemo, useRef } from 'react';
import usePlotly from '../../hooks/usePlotly';
import useIsMobile from '../../hooks/useIsMobile';
import {
  PLOTLY_COLORS,
  plotly2DChartLayout,
  plotlyAxis,
  plotlyTitle,
} from '../../lib/plotlyTheme';
import { termStructureRatioHistory } from '../../lib/vix-models';

// Historical contango ratio (VIX3M / VIX) over the full backfill window. The
// 1.0 line is drawn as a horizontal threshold; everything above is contango
// (calm regime, the empirically-typical state of the term structure),
// everything below is backwardation (urgent near-term vol — the regime that
// historically precedes the bulk of meaningful drawdowns).
//
// Conditional fill mirrors the VRP card pattern: green band where ratio > 1
// (the comfortable state), coral fill where ratio < 1 (the warning state).

export default function VixContangoHistory({ data }) {
  const { plotly, error: plotlyError } = usePlotly();
  const ref = useRef(null);
  const isMobile = useIsMobile();

  const series = useMemo(() => {
    if (!data) return null;
    return termStructureRatioHistory(data.series?.VIX, data.series?.VIX3M);
  }, [data]);

  useEffect(() => {
    if (!plotly || !ref.current || !series || series.length === 0) return;

    const dates = series.map((p) => p.date);
    const ratios = series.map((p) => p.ratio);

    // Two-trace conditional fill against the 1.0 baseline. The "above" trace
    // shows where ratio exceeds 1.0 (clamped at 1 below); fills downward to
    // 1.0 in green. The "below" trace shows where ratio undershoots (clamped
    // at 1 above); fills upward to 1.0 in coral.
    const aboveY = ratios.map((r) => (r >= 1 ? r : 1));
    const belowY = ratios.map((r) => (r <= 1 ? r : 1));

    const traces = [
      // Baseline at y=1 (drawn first so fills attach to it).
      {
        x: dates,
        y: dates.map(() => 1),
        type: 'scatter',
        mode: 'lines',
        line: { color: PLOTLY_COLORS.zeroLine, width: 1, dash: 'dash' },
        hoverinfo: 'skip',
        showlegend: false,
      },
      // Contango fill (above 1).
      {
        x: dates,
        y: aboveY,
        type: 'scatter',
        mode: 'none',
        fill: 'tonexty',
        fillcolor: 'rgba(46, 204, 113, 0.18)',
        hoverinfo: 'skip',
        showlegend: false,
      },
      // Baseline again so the next fill anchors to y=1.
      {
        x: dates,
        y: dates.map(() => 1),
        type: 'scatter',
        mode: 'lines',
        line: { color: 'rgba(0,0,0,0)', width: 0 },
        hoverinfo: 'skip',
        showlegend: false,
      },
      // Backwardation fill (below 1).
      {
        x: dates,
        y: belowY,
        type: 'scatter',
        mode: 'none',
        fill: 'tonexty',
        fillcolor: 'rgba(231, 76, 60, 0.20)',
        hoverinfo: 'skip',
        showlegend: false,
      },
      // Actual ratio line on top of fills.
      {
        x: dates,
        y: ratios,
        type: 'scatter',
        mode: 'lines',
        name: 'VIX3M / VIX',
        line: { color: PLOTLY_COLORS.primarySoft, width: 1.5 },
        hovertemplate: '%{x|%Y-%m-%d}<br>%{y:.3f}<extra></extra>',
      },
    ];

    const layout = plotly2DChartLayout({
      title: plotlyTitle(
        isMobile
          ? 'Term Structure<br>Contango / Backwardation'
          : 'Term Structure Contango / Backwardation'
      ),
      xaxis: plotlyAxis(''),
      yaxis: plotlyAxis('VIX3M / VIX'),
      margin: { t: isMobile ? 75 : 50, r: 30, b: 50, l: 70 },
      height: 320,
      showlegend: false,
      annotations: [
        {
          x: 0.01, xref: 'paper', y: 1, yref: 'y',
          text: 'Contango', showarrow: false,
          font: { color: '#2ecc71', family: "Calibri, 'Segoe UI', system-ui, sans-serif", size: 11 },
          align: 'left', xanchor: 'left', yanchor: 'bottom',
        },
        {
          x: 0.01, xref: 'paper', y: 1, yref: 'y',
          text: 'Backwardation', showarrow: false,
          font: { color: '#e74c3c', family: "Calibri, 'Segoe UI', system-ui, sans-serif", size: 11 },
          align: 'left', xanchor: 'left', yanchor: 'top',
        },
      ],
    });

    plotly.newPlot(ref.current, traces, layout, {
      displayModeBar: false,
      responsive: true,
    });

    const onResize = () => plotly.Plots.resize(ref.current);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      if (ref.current) plotly.purge(ref.current);
    };
  }, [plotly, series, isMobile]);

  return (
    <div className="card">
      <div ref={ref} style={{ width: '100%', height: 320 }} />
      {plotlyError && (
        <div style={{ padding: '1rem', color: 'var(--accent-coral)' }}>
          Chart failed to load: {plotlyError}
        </div>
      )}
    </div>
  );
}
