import { useEffect, useMemo, useRef, useState } from 'react';
import usePlotly from '../hooks/usePlotly';
import { lognormalDensity, sviTotalVariance } from '../lib/svi';

const BASE_LAYOUT = {
  paper_bgcolor: 'transparent',
  plot_bgcolor: '#141820',
  font: { family: 'Courier New, monospace', color: '#e0e0e0', size: 12 },
  xaxis: {
    title: { text: 'Strike Price', font: { color: '#8a8f9c' } },
    gridcolor: '#1e2230',
    zerolinecolor: '#2a3040',
    tickfont: { color: '#8a8f9c' },
  },
  yaxis: {
    title: { text: 'Risk-Neutral Density', font: { color: '#8a8f9c' } },
    gridcolor: '#1e2230',
    zerolinecolor: '#2a3040',
    tickfont: { color: '#8a8f9c' },
    tickformat: '.2s',
  },
  margin: { t: 40, r: 30, b: 60, l: 80 },
  legend: {
    orientation: 'h',
    y: -0.2,
    x: 0.5,
    xanchor: 'center',
    font: { color: '#8a8f9c' },
  },
  hovermode: 'x unified',
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
  const Plotly = usePlotly();
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

    const palette = ['#4a9eff', '#f0a030', '#9b8cff', '#2ecc71', '#d85a30'];
    const traces = [];

    sortedExps.forEach((fit, idx) => {
      const windowed = windowDensity(
        { strikes: fit.density.strikes, values: fit.density.values },
        spotPrice
      );
      const color = palette[idx % palette.length];
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
      title: {
        text: 'Risk-Neutral Density (Breeden-Litzenberger)',
        font: { color: '#e0e0e0', size: 14, family: 'Courier New, monospace' },
      },
      shapes: [
        {
          type: 'line',
          x0: spotPrice,
          x1: spotPrice,
          yref: 'paper',
          y0: 0,
          y1: 1,
          line: { color: '#4a9eff', width: 1.5, dash: 'dash' },
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
          font: { color: '#4a9eff', size: 10, family: 'Courier New, monospace' },
        },
      ],
    };

    Plotly.newPlot(chartRef.current, traces, layout, {
      responsive: true,
      displayModeBar: false,
    });
  }, [Plotly, sortedExps, spotPrice, showLognormal]);

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
