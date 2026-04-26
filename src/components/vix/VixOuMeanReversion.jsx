import { useEffect, useMemo, useRef } from 'react';
import usePlotly from '../../hooks/usePlotly';
import {
  PLOTLY_COLORS,
  plotly2DChartLayout,
  plotlyAxis,
  plotlyTitle,
} from '../../lib/plotlyTheme';
import { calibrateOU, ouExpectedLevel } from '../../lib/vix-models';

// Ornstein-Uhlenbeck calibration on log VIX. The card has two surfaces:
//
//   Top:    a stat block with κ (mean-reversion speed), θ (long-term mean
//           in VIX units), σ (vol of log VIX), half-life in trading days,
//           and current spot level vs θ.
//   Bottom: a chart of the log VIX series with the calibrated θ line and
//           the OU forward expectation projected 60 trading days forward
//           from the latest spot.
//
// Calibration runs over the full backfill window (~3 years) so the
// estimates are stable. Half-life under OU is ln(2) / κ, expressed in
// years; we convert to trading days for legibility against the chart's
// daily x-axis.

function StatRow({ label, value, sub, tone = 'neutral' }) {
  const colorMap = {
    neutral: 'var(--text-primary)',
    green: '#04A29F',
    amber: 'var(--accent-amber)',
    coral: 'var(--accent-coral)',
  };
  return (
    <div className="vix-ou-stat">
      <div className="vix-ou-stat__label">{label}</div>
      <div className="vix-ou-stat__value" style={{ color: colorMap[tone] || 'var(--text-primary)' }}>
        {value}
      </div>
      {sub && <div className="vix-ou-stat__sub">{sub}</div>}
    </div>
  );
}

export default function VixOuMeanReversion({ data }) {
  const { plotly, error: plotlyError } = usePlotly();
  const ref = useRef(null);

  const result = useMemo(() => {
    if (!data) return null;
    const closes = (data.series?.VIX || []).map((p) => p.close);
    return calibrateOU(closes);
  }, [data]);

  useEffect(() => {
    if (!plotly || !ref.current || !result || !result.valid || !data) return;

    const series = data.series.VIX || [];
    const dates = series.map((p) => p.date);
    const levels = series.map((p) => p.close);

    // Forward expectation from the latest observation, 60 trading days out.
    const lastPoint = series[series.length - 1];
    const forwardDays = 60;
    const forwardDates = [];
    const forwardLevels = [];
    if (lastPoint && Number.isFinite(lastPoint.close)) {
      const start = new Date(lastPoint.date + 'T00:00:00Z');
      let businessDays = 0;
      let cursor = new Date(start);
      while (businessDays < forwardDays) {
        cursor.setUTCDate(cursor.getUTCDate() + 1);
        const dow = cursor.getUTCDay();
        if (dow === 0 || dow === 6) continue;
        businessDays += 1;
        const expected = ouExpectedLevel(
          { currentLevel: lastPoint.close, kappa: result.kappa, theta: result.theta },
          businessDays,
        );
        forwardDates.push(cursor.toISOString().slice(0, 10));
        forwardLevels.push(expected);
      }
    }

    const traces = [
      // Long-term mean line drawn as a constant.
      {
        x: [dates[0], dates[dates.length - 1], ...forwardDates],
        y: new Array(2 + forwardDates.length).fill(result.thetaVixLevel),
        type: 'scatter',
        mode: 'lines',
        name: `θ = ${result.thetaVixLevel.toFixed(2)}`,
        line: { color: PLOTLY_COLORS.highlight, width: 1, dash: 'dot' },
        hovertemplate: 'Long-term mean θ = %{y:.2f}<extra></extra>',
      },
      // VIX history trace.
      {
        x: dates,
        y: levels,
        type: 'scatter',
        mode: 'lines',
        name: 'VIX',
        line: { color: PLOTLY_COLORS.primarySoft, width: 1.5 },
        hovertemplate: '%{x|%Y-%m-%d}<br>VIX %{y:.2f}<extra></extra>',
      },
      // OU forward expectation from latest spot.
      {
        x: [lastPoint?.date, ...forwardDates],
        y: [lastPoint?.close, ...forwardLevels],
        type: 'scatter',
        mode: 'lines',
        name: '60d OU forward',
        line: { color: PLOTLY_COLORS.positive, width: 2, dash: 'dash' },
        hovertemplate: 'Expected VIX %{y:.2f}<extra></extra>',
      },
    ];

    const layout = plotly2DChartLayout({
      title: plotlyTitle('Ornstein-Uhlenbeck Mean Reversion'),
      xaxis: plotlyAxis(''),
      yaxis: plotlyAxis('VIX'),
      margin: { t: 50, r: 30, b: 80, l: 70 },
      height: 380,
      showlegend: true,
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
  }, [plotly, result, data]);

  if (!result || !result.valid) {
    return (
      <div className="card" style={{ padding: '1.25rem' }}>
        <div style={{ color: 'var(--text-secondary)' }}>
          Mean-reversion calibration unavailable: {result?.reason || 'loading…'}
        </div>
      </div>
    );
  }

  const lastVix = data?.latest?.VIX?.close ?? null;
  const distFromMean = lastVix != null
    ? ((lastVix - result.thetaVixLevel) / result.thetaVixLevel) * 100
    : null;
  const tone = distFromMean == null ? 'neutral'
    : Math.abs(distFromMean) < 5 ? 'green'
    : Math.abs(distFromMean) < 20 ? 'amber'
    : 'coral';

  return (
    <div className="card">
      <div className="vix-ou-stats">
        <StatRow
          label="κ (speed)"
          value={result.kappa.toFixed(2)}
          sub="larger = faster reversion"
        />
        <StatRow
          label="θ (long-term VIX)"
          value={result.thetaVixLevel.toFixed(2)}
          sub={`log θ = ${result.theta.toFixed(3)}`}
        />
        <StatRow
          label="σ (vol of log)"
          value={result.sigma.toFixed(2)}
          sub="annualized"
        />
        <StatRow
          label="Half-life"
          value={`${result.halfLifeDays.toFixed(1)} d`}
          sub={`${result.halfLifeYears.toFixed(2)} yr`}
        />
        <StatRow
          label="Current vs θ"
          value={lastVix != null ? `${lastVix.toFixed(2)}` : '—'}
          sub={distFromMean != null
            ? `${distFromMean >= 0 ? '+' : ''}${distFromMean.toFixed(1)}% from mean`
            : '—'}
          tone={tone}
        />
      </div>
      <div ref={ref} style={{ width: '100%', height: 380 }} />
      {plotlyError && (
        <div style={{ padding: '1rem', color: 'var(--accent-coral)' }}>
          Chart failed to load: {plotlyError}
        </div>
      )}
    </div>
  );
}
