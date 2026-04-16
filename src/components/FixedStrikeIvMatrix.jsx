import { useEffect, useMemo, useRef, useState } from 'react';
import usePlotly from '../hooks/usePlotly';
import {
  PLOTLY_BASE_LAYOUT_2D,
  PLOTLY_COLORBAR,
  PLOTLY_FONT_FAMILY,
  PLOTLY_FONTS,
  PLOTLY_HEATMAP_COLORSCALE,
  PLOTLY_HEATMAP_DIVERGING_COLORSCALE,
  plotlyAxis,
  plotlyRangeslider,
} from '../lib/plotlyTheme';

const NUM_STRIKE_ROWS = 11;
const HALF_ROWS = Math.floor(NUM_STRIKE_ROWS / 2);
const STRIKE_INCREMENT_CANDIDATES = [5, 10, 25, 50, 100, 250, 500, 1000];

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const BASE_LAYOUT = {
  ...PLOTLY_BASE_LAYOUT_2D,
  margin: { t: 10, r: 40, b: 60, l: 110 },
  hovermode: 'closest',
  xaxis: plotlyAxis('', {
    side: 'bottom',
    type: 'category',
    tickangle: 0,
    rangeslider: plotlyRangeslider(),
  }),
  yaxis: plotlyAxis('Strike', {
    type: 'category',
    autorange: 'reversed',
  }),
};

function formatExpLabel(expirationDate) {
  const parts = expirationDate.split('-');
  if (parts.length !== 3) return expirationDate;
  const monthIdx = parseInt(parts[1], 10) - 1;
  if (monthIdx < 0 || monthIdx > 11) return expirationDate;
  return `${MONTH_ABBR[monthIdx]} ${parseInt(parts[2], 10)}`;
}

function interpolateIv(contracts, targetStrike, preferCall) {
  const filtered = contracts
    .filter((c) => c.contract_type === (preferCall ? 'call' : 'put') && c.implied_volatility != null)
    .sort((a, b) => a.strike_price - b.strike_price);
  if (filtered.length === 0) return null;

  let lower = null;
  let upper = null;
  for (const c of filtered) {
    if (c.strike_price <= targetStrike) lower = c;
    if (c.strike_price >= targetStrike) {
      upper = c;
      break;
    }
  }
  if (lower && upper && lower.strike_price === upper.strike_price) return upper.implied_volatility;
  if (lower && upper) {
    const w = (targetStrike - lower.strike_price) / (upper.strike_price - lower.strike_price);
    return lower.implied_volatility * (1 - w) + upper.implied_volatility * w;
  }
  if (upper) return upper.implied_volatility;
  if (lower) return lower.implied_volatility;
  return null;
}

function niceStrikeIncrement(spot) {
  const target = spot * 0.01;
  return STRIKE_INCREMENT_CANDIDATES.reduce(
    (best, c) => (Math.abs(c - target) < Math.abs(best - target) ? c : best),
    STRIKE_INCREMENT_CANDIDATES[0],
  );
}

function buildStrikeLadder(spot) {
  const inc = niceStrikeIncrement(spot);
  const center = Math.round(spot / inc) * inc;
  return Array.from({ length: NUM_STRIKE_ROWS }, (_, i) => center + (i - HALF_ROWS) * inc);
}

function groupByExpiration(contracts) {
  const map = new Map();
  if (!contracts) return map;
  for (const c of contracts) {
    if (!c.expiration_date) continue;
    if (!map.has(c.expiration_date)) map.set(c.expiration_date, []);
    map.get(c.expiration_date).push(c);
  }
  return map;
}

function toggleBtnStyle(active) {
  return {
    background: active ? 'rgba(74,158,255,0.12)' : 'none',
    border: `1px solid ${active ? 'rgba(74,158,255,0.4)' : 'rgba(255,255,255,0.25)'}`,
    borderRadius: '3px',
    padding: '0.15rem 0.45rem',
    fontFamily: PLOTLY_FONT_FAMILY,
    fontSize: '0.75rem',
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    cursor: 'pointer',
    color: active ? '#e0e0e0' : '#8a8f9c',
  };
}

export default function FixedStrikeIvMatrix({ contracts, spotPrice, expirations, prevContracts }) {
  const chartRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();
  const [mode, setMode] = useState('change');

  const { levelMatrix, changeMatrix } = useMemo(() => {
    if (!contracts || contracts.length === 0 || !spotPrice || !expirations || expirations.length === 0) {
      return { levelMatrix: null, changeMatrix: null };
    }

    const byExp = groupByExpiration(contracts);
    const prevByExp = groupByExpiration(prevContracts);

    const sortedExps = [...expirations].sort();
    const xLabels = sortedExps.map(formatExpLabel);
    const strikes = buildStrikeLadder(spotPrice);
    const yLabels = strikes.map((s) => s.toString());

    const zLevel = strikes.map(() => []);
    const textLevel = strikes.map(() => []);
    const zChange = strikes.map(() => []);
    const textChange = strikes.map(() => []);
    let hasAnyChange = false;

    for (let col = 0; col < sortedExps.length; col++) {
      const expContracts = byExp.get(sortedExps[col]) || [];
      const prevExpContracts = prevByExp.get(sortedExps[col]) || [];

      for (let row = 0; row < strikes.length; row++) {
        const targetStrike = strikes[row];
        const preferCall = targetStrike > spotPrice;

        let iv = interpolateIv(expContracts, targetStrike, preferCall);
        if (iv == null) iv = interpolateIv(expContracts, targetStrike, !preferCall);

        zLevel[row].push(iv != null ? iv * 100 : null);
        textLevel[row].push(iv != null ? `${(iv * 100).toFixed(2)}%` : '\u2014');

        if (prevExpContracts.length > 0 && iv != null) {
          let prevIv = interpolateIv(prevExpContracts, targetStrike, preferCall);
          if (prevIv == null) prevIv = interpolateIv(prevExpContracts, targetStrike, !preferCall);

          if (prevIv != null) {
            const delta = (iv - prevIv) * 100;
            zChange[row].push(delta);
            const sign = delta > 0 ? '+' : '';
            textChange[row].push(`${sign}${delta.toFixed(2)}`);
            hasAnyChange = true;
          } else {
            zChange[row].push(null);
            textChange[row].push('\u2014');
          }
        } else {
          zChange[row].push(null);
          textChange[row].push('\u2014');
        }
      }
    }

    const level = { xLabels, yLabels, z: zLevel, textCells: textLevel };
    const change = hasAnyChange ? { xLabels, yLabels, z: zChange, textCells: textChange } : null;
    return { levelMatrix: level, changeMatrix: change };
  }, [contracts, spotPrice, expirations, prevContracts]);

  const hasPrev = changeMatrix != null;
  const isChangeMode = mode === 'change' && hasPrev;
  const activeMatrix = isChangeMode ? changeMatrix : levelMatrix;

  useEffect(() => {
    if (!Plotly || !chartRef.current || !activeMatrix) return;

    const allValues = activeMatrix.z.flat().filter((v) => v != null);
    if (allValues.length === 0) return;

    let zMin, zMax, colorscale;
    if (isChangeMode) {
      const absMax = Math.max(...allValues.map(Math.abs));
      zMin = -absMax;
      zMax = absMax;
      colorscale = PLOTLY_HEATMAP_DIVERGING_COLORSCALE;
    } else {
      zMin = Math.min(...allValues);
      zMax = Math.max(...allValues);
      colorscale = PLOTLY_HEATMAP_COLORSCALE;
    }

    const trace = {
      type: 'heatmap',
      z: activeMatrix.z,
      x: activeMatrix.xLabels,
      y: activeMatrix.yLabels,
      text: activeMatrix.textCells,
      texttemplate: '%{text}',
      textfont: {
        family: PLOTLY_FONT_FAMILY,
        size: 12,
        color: isChangeMode ? '#e0e0e0' : '#0d0f13',
        weight: 700,
      },
      colorscale,
      zmin: zMin,
      zmax: zMax,
      hoverongaps: false,
      hovertemplate: isChangeMode
        ? '%{x}<br>Strike %{y}<br>\u0394 %{text}<extra></extra>'
        : '%{x}<br>Strike %{y}<br>IV %{text}<extra></extra>',
      xgap: 2,
      ygap: 2,
      opacity: 0.85,
      colorbar: {
        ...PLOTLY_COLORBAR,
        title: { text: isChangeMode ? '\u0394 IV' : 'IV %', font: PLOTLY_FONTS.axisTitle },
        thickness: 14,
        len: 0.9,
        outlinewidth: 0,
      },
    };

    const layout = {
      ...BASE_LAYOUT,
      title: { text: '' },
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      xaxis: {
        ...BASE_LAYOUT.xaxis,
        ...(activeMatrix.xLabels.length > 10 ? { range: [-0.5, 9.5] } : {}),
      },
    };

    Plotly.newPlot(chartRef.current, [trace], layout, {
      responsive: true,
      displayModeBar: false,
    });
  }, [Plotly, activeMatrix, isChangeMode]);

  if (plotlyError) {
    return (
      <div
        className="card"
        style={{ padding: '1rem', marginBottom: '1rem', color: 'var(--accent-coral)' }}
      >
        Fixed-strike IV matrix unavailable — Plotly failed to load ({plotlyError}).
      </div>
    );
  }
  if (!levelMatrix) {
    return (
      <div className="card text-muted" style={{ padding: '1rem', marginBottom: '1rem' }}>
        Fixed-strike IV matrix unavailable.
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
          padding: '0 0.75rem',
        }}
      >
        <span
          style={{
            fontFamily: PLOTLY_FONT_FAMILY,
            fontSize: '20px',
            color: '#e0e0e0',
          }}
        >
          Fixed-Strike IV
        </span>
        {hasPrev && (
          <div style={{ display: 'inline-flex', gap: '0.35rem' }}>
            <button type="button" onClick={() => setMode('change')} style={toggleBtnStyle(mode === 'change')}>
              1D Change
            </button>
            <button type="button" onClick={() => setMode('level')} style={toggleBtnStyle(mode === 'level')}>
              Level
            </button>
          </div>
        )}
      </div>
      <div ref={chartRef} style={{ width: '100%', height: '440px', backgroundColor: 'var(--bg-card)' }} />
    </div>
  );
}
