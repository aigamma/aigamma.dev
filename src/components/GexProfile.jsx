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

// Symmetric log with linear threshold C: below C the mapping is nearly
// linear; above C magnitudes compress logarithmically. C is computed per
// render as P75(|netGex|) so the crossover adapts to each dataset.
const symlog = (x, C) => Math.sign(x) * Math.log1p(Math.abs(x) / C) * C;

function formatSI(v) {
  const abs = Math.abs(v);
  const sign = v < 0 ? '\u2212' : '';
  if (abs >= 1e12) return sign + +(abs / 1e12).toFixed(1) + 'T';
  if (abs >= 1e9) return sign + +(abs / 1e9).toFixed(1) + 'G';
  if (abs >= 1e6) return sign + +(abs / 1e6).toFixed(1) + 'M';
  if (abs >= 1e3) return sign + +(abs / 1e3).toFixed(1) + 'k';
  if (abs >= 1) return sign + abs.toFixed(0);
  return '0';
}

function symlogTicks(rawValues, C) {
  const maxAbs = Math.max(...rawValues.map(Math.abs), 1);
  const decades = Math.ceil(Math.log10(maxAbs));
  const step = decades <= 4 ? 1 : decades <= 8 ? 2 : 3;
  const tickvals = [0];
  const ticktext = ['0'];
  for (let p = 0; p <= decades + 1; p += step) {
    const v = Math.pow(10, p);
    if (v > maxAbs * 2) break;
    tickvals.push(symlog(v, C), symlog(-v, C));
    ticktext.push(formatSI(v), formatSI(-v));
  }
  return { tickvals, ticktext };
}

function refLine(x, color, label, bottom = false) {
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
      y: bottom ? -0.12 : 1,
      yref: 'paper',
      yanchor: bottom ? 'top' : 'bottom',
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
    const callGexRaw = gexData.map((e) => e.callGex);
    const putGexRaw = gexData.map((e) => -e.putGex);

    // C = 75th percentile of |netGex| — the crossover between linear and
    // logarithmic compression, recomputed from the live dataset each render.
    const absNetGex = gexData
      .map((e) => Math.abs(e.callGex - e.putGex))
      .sort((a, b) => a - b);
    const C = absNetGex[Math.floor(absNetGex.length * 0.75)] || 1;

    const { tickvals, ticktext } = symlogTicks([...callGexRaw, ...putGexRaw], C);

    const traces = [
      {
        x: strikes,
        y: callGexRaw.map((v) => symlog(v, C)),
        customdata: callGexRaw,
        type: 'bar',
        name: 'Call Gamma',
        marker: { color: PLOTLY_COLORS.positive, opacity: PLOTLY_SERIES_OPACITY },
        hovertemplate: 'Strike %{x}<br>Call Gamma: %{customdata:.3s}<extra></extra>',
      },
      {
        x: strikes,
        y: putGexRaw.map((v) => symlog(v, C)),
        customdata: putGexRaw,
        type: 'bar',
        name: 'Put Gamma',
        marker: { color: PLOTLY_COLORS.negative, opacity: PLOTLY_SERIES_OPACITY },
        hovertemplate: 'Strike %{x}<br>Put Gamma: %{customdata:.3s}<extra></extra>',
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
      push(refLine(levels.volatility_flip, PLOTLY_COLORS.axisText, 'Flip', true));
    }

    const layout = {
      ...PLOTLY_LAYOUT_BASE,
      title: plotlyTitle('Gamma Exposure Profile (Symlog Adjustment)'),
      yaxis: plotlyAxis('Gamma Exposure ($ notional)', {
        zerolinewidth: 2,
        tickvals,
        ticktext,
      }),
      shapes,
      annotations,
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
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
      <div
        ref={chartRef}
        style={{ width: '100%', height: '420px', backgroundColor: '#141820' }}
      />
    </div>
  );
}
