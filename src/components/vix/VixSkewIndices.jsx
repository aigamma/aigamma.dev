import { useEffect, useMemo, useRef } from 'react';
import usePlotly from '../../hooks/usePlotly';
import useIsMobile from '../../hooks/useIsMobile';
import {
  PLOTLY_COLORS,
  plotly2DChartLayout,
  plotlyAxis,
  plotlyTitle,
} from '../../lib/plotlyTheme';

// Cboe SKEW + Nations SkewDex side-by-side. Two distinct constructions of
// the same underlying risk-off premium: SKEW is built from the cumulants
// of the risk-neutral density implied by SPX option prices and is centered
// at 100 with crash-pricing > 150; SDEX (SkewDex) uses an alternative
// cumulant decomposition and indexes differently. Plotting them on shared
// time / dual y axes shows whether the two methodologies agree on the
// direction and magnitude of skew shifts — divergence is informative
// about which estimator is being driven by tail vs near-money asymmetry.

export default function VixSkewIndices({ data }) {
  const { plotly, error: plotlyError } = usePlotly();
  const ref = useRef(null);
  const isMobile = useIsMobile();

  const series = useMemo(() => {
    if (!data) return null;
    const skew = data.series?.SKEW || [];
    const sdex = data.series?.SDEX || [];
    return { skew, sdex };
  }, [data]);

  useEffect(() => {
    if (!plotly || !ref.current || !series) return;

    const traces = [
      {
        x: series.skew.map((p) => p.date),
        y: series.skew.map((p) => p.close),
        type: 'scatter',
        mode: 'lines',
        name: 'Cboe SKEW',
        line: { color: PLOTLY_COLORS.primarySoft, width: 1.6 },
        hovertemplate: 'SKEW %{y:.2f}<extra></extra>',
      },
      {
        x: series.sdex.map((p) => p.date),
        y: series.sdex.map((p) => p.close),
        type: 'scatter',
        mode: 'lines',
        name: 'Nations SDEX',
        line: { color: PLOTLY_COLORS.highlight, width: 1.4 },
        yaxis: 'y2',
        hovertemplate: 'SDEX %{y:.2f}<extra></extra>',
      },
    ];

    const layout = plotly2DChartLayout({
      title: plotlyTitle(
        isMobile
          ? 'Skew Indices:<br>Cboe SKEW vs Nations SkewDex'
          : 'Skew Indices: Cboe SKEW vs Nations SkewDex'
      ),
      xaxis: plotlyAxis(''),
      yaxis: plotlyAxis('Cboe SKEW', { side: 'left' }),
      yaxis2: plotlyAxis('SDEX', {
        overlaying: 'y',
        side: 'right',
        showgrid: false,
        tickfont: { color: PLOTLY_COLORS.highlight, family: "Calibri, 'Segoe UI', system-ui, sans-serif", size: 12 },
      }),
      margin: { t: isMobile ? 75 : 50, r: 70, b: 80, l: 70 },
      height: 380,
      showlegend: true,
      legend: { orientation: 'h', y: -0.18, x: 0.5, xanchor: 'center' },
      shapes: [
        {
          type: 'line',
          x0: 0, x1: 1, xref: 'paper',
          y0: 150, y1: 150, yref: 'y',
          line: { color: PLOTLY_COLORS.secondary, width: 1, dash: 'dot' },
        },
        {
          type: 'line',
          x0: 0, x1: 1, xref: 'paper',
          y0: 140, y1: 140, yref: 'y',
          line: { color: PLOTLY_COLORS.highlight, width: 1, dash: 'dot' },
        },
      ],
      annotations: [
        {
          x: 0.99, xref: 'paper', y: 150, yref: 'y',
          text: 'crash pricing', showarrow: false,
          font: { color: PLOTLY_COLORS.secondary, size: 11, family: "Calibri, 'Segoe UI', system-ui, sans-serif" },
          xanchor: 'right', yanchor: 'bottom',
        },
        {
          x: 0.99, xref: 'paper', y: 140, yref: 'y',
          text: 'elevated tail premium', showarrow: false,
          font: { color: PLOTLY_COLORS.highlight, size: 11, family: "Calibri, 'Segoe UI', system-ui, sans-serif" },
          xanchor: 'right', yanchor: 'bottom',
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
      <div ref={ref} style={{ width: '100%', height: 380 }} />
      {plotlyError && (
        <div style={{ padding: '1rem', color: 'var(--accent-coral)' }}>
          Chart failed to load: {plotlyError}
        </div>
      )}
    </div>
  );
}
