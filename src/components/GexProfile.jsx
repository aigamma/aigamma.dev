import { useEffect, useMemo, useRef } from 'react';
import usePlotly from '../hooks/usePlotly';
import {
  PLOTLY_BASE_LAYOUT_2D,
  PLOTLY_COLORS,
  PLOTLY_FONTS,
  PLOTLY_SERIES_OPACITY,
  plotlyAxis,
  plotlyTitle,
} from '../lib/plotlyTheme';

const PLOTLY_LAYOUT_BASE = {
  ...PLOTLY_BASE_LAYOUT_2D,
  margin: { t: 40, r: 30, b: 60, l: 80 },
  xaxis: plotlyAxis('Strike Price'),
  yaxis: plotlyAxis('Gamma Exposure ($ notional)', {
    zerolinewidth: 2,
    tickformat: '.2s',
  }),
  barmode: 'relative',
};

// GEX notional = gamma * OI * 100 * spot^2 * 0.01. Convention: calls positive, puts negative,
// which follows the common dealer-short-puts assumption used by SpotGamma-style profiles.
function computeGexByStrike(contracts, spotPrice) {
  const byStrike = new Map();
  const mult = spotPrice * spotPrice * 0.01 * 100;

  for (const c of contracts) {
    if (!c.gamma || !c.open_interest || !c.strike_price) continue;
    const key = c.strike_price;
    if (!byStrike.has(key)) {
      byStrike.set(key, { strike: key, callGex: 0, putGex: 0 });
    }
    const entry = byStrike.get(key);
    const gex = c.gamma * c.open_interest * mult;
    if (c.contract_type === 'call') entry.callGex += gex;
    else if (c.contract_type === 'put') entry.putGex += gex;
  }

  return Array.from(byStrike.values()).sort((a, b) => a.strike - b.strike);
}

function refLine(x, color, label) {
  return {
    shape: {
      type: 'line',
      x0: x,
      x1: x,
      yref: 'paper',
      y0: 0,
      y1: 1,
      line: { color, width: 1.5, dash: 'dash' },
    },
    annotation: {
      x,
      xref: 'x',
      y: 1,
      yref: 'paper',
      yanchor: 'bottom',
      text: label,
      showarrow: false,
      font: { ...PLOTLY_FONTS.axisTitle, color },
    },
  };
}

export default function GexProfile({ contracts, spotPrice, levels }) {
  const chartRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();

  const gexData = useMemo(() => {
    if (!contracts || contracts.length === 0 || !spotPrice) return null;
    const all = computeGexByStrike(contracts, spotPrice);
    const lower = spotPrice * 0.9;
    const upper = spotPrice * 1.1;
    return all.filter((e) => e.strike >= lower && e.strike <= upper);
  }, [contracts, spotPrice]);

  useEffect(() => {
    if (!Plotly || !chartRef.current || !gexData || gexData.length === 0) return;

    const strikes = gexData.map((e) => e.strike);
    const callGex = gexData.map((e) => e.callGex);
    const putGex = gexData.map((e) => -e.putGex);

    const traces = [
      {
        x: strikes,
        y: callGex,
        type: 'bar',
        name: 'Call GEX',
        marker: { color: PLOTLY_COLORS.positive, opacity: PLOTLY_SERIES_OPACITY },
        hovertemplate: 'Strike %{x}<br>Call GEX: %{y:.3s}<extra></extra>',
      },
      {
        x: strikes,
        y: putGex,
        type: 'bar',
        name: 'Put GEX',
        marker: { color: PLOTLY_COLORS.negative, opacity: PLOTLY_SERIES_OPACITY },
        hovertemplate: 'Strike %{x}<br>Put GEX: %{y:.3s}<extra></extra>',
      },
    ];

    const shapes = [];
    const annotations = [];
    const push = (entry) => {
      if (entry == null || entry.shape.x0 == null) return;
      shapes.push(entry.shape);
      annotations.push(entry.annotation);
    };

    push(refLine(spotPrice, PLOTLY_COLORS.primary, 'SPOT'));
    if (levels) {
      push(refLine(levels.call_wall, PLOTLY_COLORS.positive, 'CW'));
      push(refLine(levels.put_wall, PLOTLY_COLORS.negative, 'PW'));
      push(refLine(levels.abs_gamma_strike, PLOTLY_COLORS.highlight, 'AG'));
      push(refLine(levels.volatility_flip, PLOTLY_COLORS.axisText, 'VF'));
    }

    const layout = {
      ...PLOTLY_LAYOUT_BASE,
      title: plotlyTitle('Gamma Exposure Profile (all expirations)'),
      shapes,
      annotations,
    };

    Plotly.newPlot(chartRef.current, traces, layout, {
      responsive: true,
      displayModeBar: false,
    });
  }, [Plotly, gexData, spotPrice, levels]);

  if (plotlyError) {
    return (
      <div
        className="card"
        style={{ padding: '1rem', marginBottom: '1rem', color: 'var(--accent-coral)' }}
      >
        Gamma exposure profile unavailable — Plotly failed to load ({plotlyError}).
      </div>
    );
  }
  if (!contracts || contracts.length === 0) {
    return <div className="card text-muted">No GEX data available.</div>;
  }

  return (
    <div className="card" style={{ marginBottom: '1rem' }}>
      <div ref={chartRef} style={{ width: '100%', height: '420px' }} />
    </div>
  );
}
