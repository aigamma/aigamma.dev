import { useEffect, useMemo, useRef } from 'react';
import usePlotly from '../../hooks/usePlotly';
import {
  PLOTLY_COLORS,
  plotly2DChartLayout,
  plotlyAxis,
  plotlyTitle,
} from '../../lib/plotlyTheme';
import {
  cumulativeGrowth,
  annualizedStats,
  maxDrawdown,
} from '../../lib/vix-models';

// Cboe option-strategy benchmark indices vs SPX. Four strategy variants
// publicly disseminated by Cboe and tracked in our backfill: BXM (BuyWrite
// at-the-money calls), BXMD (30-delta buy-write), BFLY (iron butterfly),
// CNDR (iron condor). Each is a recipe Cboe runs daily and publishes the
// notional cumulative value of — they're not investable on their own but
// every short-vol ETF tracks one of these recipes.
//
// Chart shows growth-of-1 cumulative returns indexed at the start of the
// backfill, so the reader sees realized payoff across the regime cycle.
// SPX is plotted in primary blue as the buy-and-hold benchmark; the four
// strategies branch from there. The accompanying table shows annualized
// return, vol, Sharpe, and maximum peak-to-trough drawdown for each.

const STRATEGIES = [
  { sym: 'SPX',  label: 'SPX (cash)',     color: '#4a9eff', source: 'spx' },
  { sym: 'BXM',  label: 'BXM (BuyWrite ATM)',  color: '#f1c40f' },
  { sym: 'BXMD', label: 'BXMD (BuyWrite 30Δ)', color: '#04A29F' },
  { sym: 'BFLY', label: 'BFLY (Iron Butterfly)', color: '#BF7FFF' },
  { sym: 'CNDR', label: 'CNDR (Iron Condor)', color: '#1abc9c' },
];

function gatherSeries(data, sym, source) {
  if (source === 'spx') {
    const spx = data.spx || [];
    return spx
      .filter((p) => Number.isFinite(p.spx_close))
      .map((p) => ({ date: p.date, close: p.spx_close }));
  }
  const arr = data.series?.[sym] || [];
  return arr.filter((p) => Number.isFinite(p.close));
}

export default function VixStrategyOverlay({ data }) {
  const { plotly, error: plotlyError } = usePlotly();
  const ref = useRef(null);

  const enriched = useMemo(() => {
    if (!data) return null;
    return STRATEGIES.map((s) => {
      const series = gatherSeries(data, s.sym, s.source);
      const growth = cumulativeGrowth(series);
      const stats = annualizedStats(growth);
      const dd = maxDrawdown(growth);
      return { ...s, growth, stats, dd };
    });
  }, [data]);

  useEffect(() => {
    if (!plotly || !ref.current || !enriched) return;
    const traces = enriched
      .filter((s) => s.growth.length > 0)
      .map((s) => ({
        x: s.growth.map((p) => p.date),
        y: s.growth.map((p) => p.growth),
        type: 'scatter',
        mode: 'lines',
        name: s.label,
        line: { color: s.color, width: s.sym === 'SPX' ? 2 : 1.4 },
        hovertemplate: `${s.label}<br>%{y:.3f}×<extra></extra>`,
      }));

    const layout = plotly2DChartLayout({
      title: plotlyTitle('Cboe Strategy Benchmark Indices vs SPX (growth of 1)'),
      xaxis: plotlyAxis(''),
      yaxis: plotlyAxis('Growth of $1'),
      margin: { t: 50, r: 30, b: 80, l: 70 },
      height: 420,
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
  }, [plotly, enriched]);

  return (
    <div className="card">
      <div ref={ref} style={{ width: '100%', height: 420 }} />
      {plotlyError && (
        <div style={{ padding: '1rem', color: 'var(--accent-coral)' }}>
          Chart failed to load: {plotlyError}
        </div>
      )}
      {enriched && (
        <table className="vix-strategy-table">
          <thead>
            <tr>
              <th>Strategy</th>
              <th>Ann. Return</th>
              <th>Ann. Vol</th>
              <th>Sharpe</th>
              <th>Max DD</th>
            </tr>
          </thead>
          <tbody>
            {enriched.map((s) => (
              <tr key={s.sym}>
                <td>
                  <span
                    style={{
                      display: 'inline-block',
                      width: 10, height: 10,
                      borderRadius: '50%',
                      background: s.color,
                      marginRight: 8,
                      verticalAlign: 'middle',
                    }}
                  />
                  {s.label}
                </td>
                <td className={s.stats.annReturn >= 0 ? 'pos' : 'neg'}>
                  {s.stats.annReturn != null ? `${(s.stats.annReturn * 100).toFixed(2)}%` : '—'}
                </td>
                <td>
                  {s.stats.annVol != null ? `${(s.stats.annVol * 100).toFixed(2)}%` : '—'}
                </td>
                <td>
                  {s.stats.sharpe != null ? s.stats.sharpe.toFixed(2) : '—'}
                </td>
                <td className="neg">
                  {s.dd.maxDd != null ? `−${(s.dd.maxDd * 100).toFixed(2)}%` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
