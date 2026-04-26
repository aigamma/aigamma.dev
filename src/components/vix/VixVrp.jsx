import { useEffect, useMemo, useRef } from 'react';
import usePlotly from '../../hooks/usePlotly';
import {
  PLOTLY_COLORS,
  plotly2DChartLayout,
  plotlyAxis,
  plotlyTitle,
} from '../../lib/plotlyTheme';

// VIX vs SPX 30-day realized vol. The VIX is itself an implied vol on SPX,
// so this chart is the canonical "VRP" decomposition specialized to read
// from the index level rather than from a constant-maturity option-chain
// IV. The two series live on the same axis (annualized vol in % units), so
// the gap IS the volatility risk premium.
//
// Conditional fill mirrors the main /tactical VRP card:
//   green where VIX > RV   — premium positive (the empirically-typical state)
//   coral where RV > VIX   — premium negative (the rare stress regime)

export default function VixVrp({ data }) {
  const { plotly, error: plotlyError } = usePlotly();
  const ref = useRef(null);

  const series = useMemo(() => {
    if (!data) return null;
    const vix = data.series?.VIX || [];
    const spx = data.spx || [];
    const vixByDate = new Map(vix.map((p) => [p.date, p.close]));
    const out = [];
    for (const s of spx) {
      const vixLevel = vixByDate.get(s.date);
      const rv = s.hv_20d_yz != null ? s.hv_20d_yz * 100 : null;
      if (vixLevel != null && rv != null) {
        out.push({ date: s.date, vix: vixLevel, rv, spx: s.spx_close });
      }
    }
    return out;
  }, [data]);

  useEffect(() => {
    if (!plotly || !ref.current || !series || series.length === 0) return;

    const dates = series.map((p) => p.date);
    const vixVals = series.map((p) => p.vix);
    const rvVals = series.map((p) => p.rv);
    const spxVals = series.map((p) => p.spx);

    // Conditional fills: green band where VIX above RV, coral where below.
    const minSeries = series.map((p) => Math.min(p.vix, p.rv));
    const maxSeries = series.map((p) => Math.max(p.vix, p.rv));
    const greenMask = series.map((p) => (p.vix >= p.rv ? Math.max(p.vix, p.rv) : null));
    const coralMask = series.map((p) => (p.rv > p.vix ? Math.max(p.vix, p.rv) : null));

    const traces = [
      // SPX area background on left axis.
      {
        x: dates,
        y: spxVals,
        type: 'scatter',
        mode: 'lines',
        name: 'SPX',
        line: { color: PLOTLY_COLORS.primary, width: 1 },
        fill: 'tozeroy',
        fillcolor: 'rgba(74, 158, 255, 0.08)',
        yaxis: 'y2',
        hovertemplate: 'SPX %{y:.2f}<extra></extra>',
      },
      // Floor (min of vix/rv) — invisible anchor for fill.
      {
        x: dates,
        y: minSeries,
        type: 'scatter',
        mode: 'lines',
        line: { color: 'rgba(0,0,0,0)', width: 0 },
        showlegend: false,
        hoverinfo: 'skip',
      },
      // Ceiling shaded green where VIX >= RV.
      {
        x: dates,
        y: greenMask,
        type: 'scatter',
        mode: 'none',
        fill: 'tonexty',
        fillcolor: 'rgba(46, 204, 113, 0.20)',
        showlegend: false,
        hoverinfo: 'skip',
        connectgaps: false,
      },
      // Same anchor again for the coral overlay (Plotly fills "tonexty"
      // pair-wise so a fresh anchor is needed before the second fill trace).
      {
        x: dates,
        y: minSeries,
        type: 'scatter',
        mode: 'lines',
        line: { color: 'rgba(0,0,0,0)', width: 0 },
        showlegend: false,
        hoverinfo: 'skip',
      },
      // Ceiling shaded coral where RV > VIX.
      {
        x: dates,
        y: coralMask,
        type: 'scatter',
        mode: 'none',
        fill: 'tonexty',
        fillcolor: 'rgba(231, 76, 60, 0.22)',
        showlegend: false,
        hoverinfo: 'skip',
        connectgaps: false,
      },
      // RV (Yang-Zhang 20-day) line.
      {
        x: dates,
        y: rvVals,
        type: 'scatter',
        mode: 'lines',
        name: 'SPX RV (20d YZ)',
        line: { color: PLOTLY_COLORS.highlight, width: 1.6 },
        hovertemplate: 'RV %{y:.2f}<extra></extra>',
      },
      // VIX line on top of everything.
      {
        x: dates,
        y: vixVals,
        type: 'scatter',
        mode: 'lines',
        name: 'VIX',
        line: { color: PLOTLY_COLORS.primarySoft, width: 1.8 },
        hovertemplate: 'VIX %{y:.2f}<extra></extra>',
      },
    ];

    const layout = plotly2DChartLayout({
      title: plotlyTitle('VIX vs SPX 20-day Realized Vol'),
      xaxis: plotlyAxis(''),
      yaxis: plotlyAxis('Vol (annualized %)', { side: 'left' }),
      yaxis2: plotlyAxis('SPX', {
        overlaying: 'y',
        side: 'right',
        showgrid: false,
        tickfont: { color: PLOTLY_COLORS.primary, family: 'Courier New, monospace', size: 12 },
      }),
      margin: { t: 50, r: 70, b: 80, l: 70 },
      height: 460,
      showlegend: true,
      legend: {
        orientation: 'h',
        y: -0.15,
        x: 0.5,
        xanchor: 'center',
      },
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
