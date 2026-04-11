import { useEffect, useMemo, useRef, useState } from 'react';
import usePlotly from '../hooks/usePlotly';
import { lognormalDensity, sviTotalVariance } from '../lib/svi';
import {
  PLOTLY_BASE_LAYOUT_2D,
  PLOTLY_COLORS,
  PLOTLY_FONTS,
  PLOTLY_SERIES_PALETTE,
  plotlyAxis,
  plotlyTitle,
} from '../lib/plotlyTheme';

const BASE_LAYOUT = {
  ...PLOTLY_BASE_LAYOUT_2D,
  margin: { t: 40, r: 30, b: 60, l: 80 },
  xaxis: plotlyAxis('Strike Price'),
  yaxis: plotlyAxis('Risk-Neutral Density', { tickformat: '.2s' }),
};

function computeAtmIv(fit) {
  if (!fit?.params || !fit.T) return null;
  const w = sviTotalVariance(fit.params, 0);
  if (!(w > 0) || !(fit.T > 0)) return null;
  return Math.sqrt(w / fit.T);
}

// Windows the density to within +/- 25% of spot so the chart does not waste
// horizontal space on the near-zero wings of the lognormal / RND. 25% is wide
// enough to see the fat left tail while still keeping the mode visible.
function windowDensity({ strikes, values }, spotPrice) {
  const lo = spotPrice * 0.75;
  const hi = spotPrice * 1.25;
  const outStrikes = [];
  const outValues = [];
  for (let i = 0; i < strikes.length; i++) {
    if (strikes[i] >= lo && strikes[i] <= hi) {
      outStrikes.push(strikes[i]);
      outValues.push(values[i]);
    }
  }
  return { strikes: outStrikes, values: outValues };
}

export default function RiskNeutralDensity({ fits, spotPrice, capturedAt }) {
  const chartRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();
  const [showLognormal, setShowLognormal] = useState(true);

  const sortedExps = useMemo(() => {
    if (!fits || !capturedAt) return [];
    const now = new Date(capturedAt).getTime();
    return Object.values(fits)
      .filter((f) => f?.density && f.density.strikes && f.density.values)
      .sort((a, b) => {
        const ta = new Date(a.expirationDate).getTime();
        const tb = new Date(b.expirationDate).getTime();
        return ta - tb;
      })
      .map((f) => {
        const daysToExp = Math.max((new Date(`${f.expirationDate}T20:00:00Z`).getTime() - now) / 86400000, 0);
        return { ...f, dte: daysToExp };
      });
  }, [fits, capturedAt]);

  useEffect(() => {
    if (!Plotly || !chartRef.current || sortedExps.length === 0 || !spotPrice) return;

    const traces = [];

    sortedExps.forEach((fit, idx) => {
      const windowed = windowDensity(
        { strikes: fit.density.strikes, values: fit.density.values },
        spotPrice
      );
      const color = PLOTLY_SERIES_PALETTE[idx % PLOTLY_SERIES_PALETTE.length];
      const label = `${fit.expirationDate} (${fit.dte.toFixed(0)}d)`;

      traces.push({
        x: windowed.strikes,
        y: windowed.values,
        mode: 'lines',
        type: 'scatter',
        name: label,
        line: { color, width: 2 },
        fill: 'tozeroy',
        fillcolor: `${color}22`,
        hovertemplate: 'K %{x:.2f}<br>density %{y:.3s}<extra>' + label + '</extra>',
      });

      if (showLognormal) {
        const atmIv = computeAtmIv(fit);
        if (atmIv) {
          const ln = lognormalDensity({
            spotPrice,
            atmIv,
            T: fit.T,
            strikes: windowed.strikes,
          });
          traces.push({
            x: windowed.strikes,
            y: ln,
            mode: 'lines',
            type: 'scatter',
            name: `${label} · lognormal @ ATM IV`,
            line: { color, width: 1.5, dash: 'dot' },
            opacity: 0.8,
            hovertemplate: 'K %{x:.2f}<br>LN density %{y:.3s}<extra>ref</extra>',
            showlegend: idx === 0,
          });
        }
      }
    });

    // Spot line as a Plotly shape so it sits across all traces.
    const layout = {
      ...BASE_LAYOUT,
      title: plotlyTitle('Risk-Neutral Density (Breeden-Litzenberger)'),
      shapes: [
        {
          type: 'line',
          x0: spotPrice,
          x1: spotPrice,
          yref: 'paper',
          y0: 0,
          y1: 1,
          line: { color: PLOTLY_COLORS.primary, width: 1.5, dash: 'dash' },
        },
      ],
      annotations: [
        {
          x: spotPrice,
          xref: 'x',
          y: 1,
          yref: 'paper',
          yanchor: 'bottom',
          text: 'SPOT',
          showarrow: false,
          font: { ...PLOTLY_FONTS.axisTitle, color: PLOTLY_COLORS.primary },
        },
      ],
    };

    Plotly.newPlot(chartRef.current, traces, layout, {
      responsive: true,
      displayModeBar: false,
    });
  }, [Plotly, sortedExps, spotPrice, showLognormal]);

  if (plotlyError) {
    return (
      <div
        className="card"
        style={{ padding: '1rem', marginBottom: '1rem', color: 'var(--accent-coral)' }}
      >
        Risk-neutral density unavailable — Plotly failed to load ({plotlyError}).
      </div>
    );
  }
  if (!sortedExps || sortedExps.length === 0) {
    return (
      <div className="card text-muted" style={{ padding: '1rem', marginBottom: '1rem' }}>
        Risk-neutral density unavailable — SVI fits required.
      </div>
    );
  }

  return (
    <div className="card" style={{ marginBottom: '1rem' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '0.5rem',
          marginBottom: '0.35rem',
        }}
      >
        <div
          style={{
            fontSize: '0.7rem',
            color: 'var(--text-secondary)',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
          }}
        >
          {sortedExps.length} expiration{sortedExps.length === 1 ? '' : 's'} — second derivative of SVI call-price curve
        </div>
        <label
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.35rem',
            cursor: 'pointer',
            fontSize: '0.72rem',
            color: 'var(--text-secondary)',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
          }}
        >
          <input
            type="checkbox"
            checked={showLognormal}
            onChange={(e) => setShowLognormal(e.target.checked)}
          />
          Lognormal reference
        </label>
      </div>
      <div ref={chartRef} style={{ width: '100%', height: '420px' }} />
    </div>
  );
}
