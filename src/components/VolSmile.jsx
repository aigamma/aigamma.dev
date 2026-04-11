import { useEffect, useMemo, useRef, useState } from 'react';
import usePlotly from '../hooks/usePlotly';
import { sviTotalVariance } from '../lib/svi';

const PLOTLY_LAYOUT = {
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
    title: { text: 'Implied Volatility (%)', font: { color: '#8a8f9c' } },
    gridcolor: '#1e2230',
    zerolinecolor: '#2a3040',
    tickfont: { color: '#8a8f9c' },
    tickformat: '.1f',
  },
  margin: { t: 40, r: 30, b: 60, l: 70 },
  legend: {
    orientation: 'h',
    y: -0.15,
    x: 0.5,
    xanchor: 'center',
    font: { color: '#8a8f9c' },
  },
  hovermode: 'closest',
};

function buildSmileTraces(contracts, spotPrice) {
  const calls = contracts
    .filter((c) => c.contract_type === 'call' && c.strike_price > spotPrice)
    .sort((a, b) => a.strike_price - b.strike_price);

  const puts = contracts
    .filter((c) => c.contract_type === 'put' && c.strike_price < spotPrice)
    .sort((a, b) => a.strike_price - b.strike_price);

  // ATM window: within 1% of spot, spot-relative so it scales across underlyings and strike grids
  const atmWindow = Math.max(spotPrice * 0.01, 1);
  const atmCandidates = contracts
    .filter((c) => Math.abs(c.strike_price - spotPrice) <= atmWindow)
    .sort((a, b) => Math.abs(a.strike_price - spotPrice) - Math.abs(b.strike_price - spotPrice));
  const atm = atmCandidates.length > 0 ? atmCandidates[0] : null;

  const traces = [
    {
      x: puts.map((c) => c.strike_price),
      y: puts.map((c) => c.implied_volatility * 100),
      mode: 'lines+markers',
      name: 'OTM Put IV',
      line: { color: '#4a9eff', width: 2 },
      marker: { size: 3 },
      hovertemplate: 'Strike: %{x}<br>IV: %{y:.2f}%<extra>OTM Put</extra>',
    },
    {
      x: calls.map((c) => c.strike_price),
      y: calls.map((c) => c.implied_volatility * 100),
      mode: 'lines+markers',
      name: 'OTM Call IV',
      line: { color: '#d85a30', width: 2 },
      marker: { size: 3 },
      hovertemplate: 'Strike: %{x}<br>IV: %{y:.2f}%<extra>OTM Call</extra>',
    },
  ];

  if (atm) {
    traces.push({
      x: [atm.strike_price],
      y: [atm.implied_volatility * 100],
      mode: 'markers',
      name: 'ATM',
      marker: { color: '#2ecc71', size: 12, symbol: 'diamond' },
      hovertemplate: 'ATM Strike: %{x}<br>IV: %{y:.2f}%<extra></extra>',
    });
  }

  return traces;
}

function buildSviCurve(sviFit, spotPrice, contracts) {
  if (!sviFit?.params || !sviFit.T || !contracts || contracts.length === 0) return null;
  const forward = sviFit.forward || spotPrice;
  const strikes = contracts
    .map((c) => c.strike_price)
    .filter((k) => k > 0 && !Number.isNaN(k));
  if (strikes.length === 0) return null;
  const kMin = Math.log(Math.min(...strikes) / forward);
  const kMax = Math.log(Math.max(...strikes) / forward);
  // Plot the curve a touch wider than the raw strikes so the overlay shows where
  // the SVI model extrapolates past the observable chain.
  const pad = 0.05;
  const steps = 200;
  const ks = [];
  const iv = [];
  const K = [];
  for (let i = 0; i < steps; i++) {
    const k = kMin - pad + ((kMax - kMin + 2 * pad) * i) / (steps - 1);
    const w = sviTotalVariance(sviFit.params, k);
    if (!(w > 0)) continue;
    ks.push(k);
    K.push(forward * Math.exp(k));
    iv.push(Math.sqrt(w / sviFit.T) * 100);
  }
  return { strikes: K, iv };
}

export default function VolSmile({ contracts, spotPrice, expiration, sviFit, underlying }) {
  const chartRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();
  const [showSvi, setShowSvi] = useState(true);

  const sviCurve = useMemo(() => buildSviCurve(sviFit, spotPrice, contracts), [sviFit, spotPrice, contracts]);

  useEffect(() => {
    if (!Plotly || !chartRef.current || !contracts || contracts.length === 0) return;

    const traces = buildSmileTraces(contracts, spotPrice);
    if (showSvi && sviCurve) {
      traces.push({
        x: sviCurve.strikes,
        y: sviCurve.iv,
        mode: 'lines',
        name: 'SVI fit',
        line: { color: '#f0a030', width: 2.25, dash: 'solid' },
        hovertemplate: 'K %{x:.2f}<br>SVI IV %{y:.2f}%<extra></extra>',
      });
    }

    const layout = {
      ...PLOTLY_LAYOUT,
      title: {
        text: `${underlying || 'SPX'} Volatility Smile — ${expiration || 'Latest'}`,
        font: { color: '#e0e0e0', size: 14, family: 'Courier New, monospace' },
      },
    };

    Plotly.newPlot(chartRef.current, traces, layout, {
      responsive: true,
      displayModeBar: false,
    });
  }, [Plotly, contracts, spotPrice, expiration, showSvi, sviCurve, underlying]);

  if (plotlyError) {
    return (
      <div
        className="card"
        style={{ padding: '1rem', marginBottom: '1rem', color: 'var(--accent-coral)' }}
      >
        Volatility smile unavailable — Plotly failed to load ({plotlyError}).
      </div>
    );
  }
  if (!contracts || contracts.length === 0) {
    return <div className="card text-muted">No contract data available.</div>;
  }

  return (
    <div className="card">
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
          {sviFit ? (
            <>
              SVI {sviFit.source === 'client' ? '(client fit)' : '(cached)'}
              {typeof sviFit.rmseIv === 'number' && (
                <> · RMSE {(sviFit.rmseIv * 100).toFixed(2)}% IV</>
              )}
              {sviFit.diagnostics && (
                <>
                  {' · '}
                  <span
                    style={{
                      color: sviFit.diagnostics.butterflyArbFree
                        ? 'var(--accent-green)'
                        : 'var(--accent-amber)',
                    }}
                  >
                    {sviFit.diagnostics.butterflyArbFree ? 'no-arb ok' : 'butterfly warn'}
                  </span>
                </>
              )}
            </>
          ) : (
            'SVI fit unavailable for this expiration'
          )}
        </div>
        <label
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.35rem',
            cursor: sviFit ? 'pointer' : 'not-allowed',
            opacity: sviFit ? 1 : 0.5,
            fontSize: '0.72rem',
            color: 'var(--text-secondary)',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
          }}
        >
          <input
            type="checkbox"
            checked={showSvi && !!sviFit}
            disabled={!sviFit}
            onChange={(e) => setShowSvi(e.target.checked)}
          />
          Overlay SVI
        </label>
      </div>
      <div ref={chartRef} style={{ width: '100%', height: '500px' }} />
    </div>
  );
}
