import { useEffect, useMemo, useRef } from 'react';
import usePlotly from '../../hooks/usePlotly';
import {
  PLOTLY_COLORS,
  plotly2DChartLayout,
  plotlyAxis,
  plotlyTitle,
} from '../../lib/plotlyTheme';
import { rollingRealizedVol } from '../../lib/vix-models';

// Vol of vol — annualized realized vol of the VIX level itself, plotted
// against the VVIX (the implied vol-of-vol that the option market is
// pricing). The gap is a vol-of-vol VRP analog: when VVIX persistently
// exceeds realized vol-of-VIX the option market is over-pricing future VIX
// fluctuation, and vice versa. The chart uses a 30-trading-day rolling
// realized window to roughly match VVIX's 30-day implied tenor.
//
// VVIX is plotted on the same axis (annualized vol units in %) so the gap
// is read as a level difference. A 1y rolling z-score of (VVIX − realized)
// runs as a small inset bar at the bottom of the card.

const RV_WINDOW = 30;

export default function VixVolOfVol({ data }) {
  const { plotly, error: plotlyError } = usePlotly();
  const ref = useRef(null);

  const series = useMemo(() => {
    if (!data) return null;
    const vix = data.series?.VIX || [];
    const vvix = data.series?.VVIX || [];
    if (vix.length === 0 || vvix.length === 0) return null;

    const realized = rollingRealizedVol(vix, RV_WINDOW);
    const vvixByDate = new Map(vvix.map((p) => [p.date, p.close]));

    const out = [];
    for (let i = 0; i < vix.length; i++) {
      const date = vix[i].date;
      const rv = realized[i];
      const vvixLevel = vvixByDate.get(date);
      if (rv == null || vvixLevel == null) continue;
      out.push({
        date,
        realizedVoV: rv,
        vvix: vvixLevel,
        gap: vvixLevel - rv,
      });
    }
    return out;
  }, [data]);

  useEffect(() => {
    if (!plotly || !ref.current || !series || series.length === 0) return;

    const dates = series.map((p) => p.date);
    const vvixVals = series.map((p) => p.vvix);
    const rvVals = series.map((p) => p.realizedVoV);
    const gapVals = series.map((p) => p.gap);

    const traces = [
      {
        x: dates,
        y: vvixVals,
        type: 'scatter',
        mode: 'lines',
        name: 'VVIX (implied)',
        line: { color: PLOTLY_COLORS.primarySoft, width: 1.6 },
        hovertemplate: 'VVIX %{y:.2f}<extra></extra>',
      },
      {
        x: dates,
        y: rvVals,
        type: 'scatter',
        mode: 'lines',
        name: `Realized vol of VIX (${RV_WINDOW}d)`,
        line: { color: PLOTLY_COLORS.highlight, width: 1.5 },
        hovertemplate: 'Realized %{y:.2f}<extra></extra>',
      },
      {
        x: dates,
        y: gapVals,
        type: 'bar',
        name: 'Implied − Realized',
        marker: {
          color: gapVals.map((v) =>
            v > 0 ? 'rgba(46, 204, 113, 0.45)' : 'rgba(231, 76, 60, 0.55)',
          ),
        },
        yaxis: 'y2',
        hovertemplate: 'Gap %{y:.2f}<extra></extra>',
      },
    ];

    const layout = plotly2DChartLayout({
      title: plotlyTitle('Vol of Vol: VVIX vs Realized VIX Vol'),
      xaxis: plotlyAxis(''),
      yaxis: plotlyAxis('Vol level', { side: 'left', domain: [0.30, 1] }),
      yaxis2: plotlyAxis('VVIX − Realized', {
        side: 'left',
        domain: [0, 0.22],
        anchor: 'x',
        zerolinecolor: PLOTLY_COLORS.zeroLine,
      }),
      grid: { rows: 2, columns: 1, pattern: 'independent' },
      margin: { t: 50, r: 30, b: 80, l: 70 },
      height: 460,
      showlegend: true,
      legend: { orientation: 'h', y: -0.18, x: 0.5, xanchor: 'center' },
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
  }, [plotly, series]);

  return (
    <div className="card">
      <div ref={ref} style={{ width: '100%', height: 460 }} />
      {plotlyError && (
        <div style={{ padding: '1rem', color: 'var(--accent-coral)' }}>
          Chart failed to load: {plotlyError}
        </div>
      )}
    </div>
  );
}
