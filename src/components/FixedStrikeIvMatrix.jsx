import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import usePlotly from '../hooks/usePlotly';
import useIsMobile from '../hooks/useIsMobile';
import {
  PLOTLY_BASE_LAYOUT_2D,
  PLOTLY_COLORBAR,
  PLOTLY_FONT_FAMILY,
  PLOTLY_FONTS,
  PLOTLY_HEATMAP_COLORSCALE,
  PLOTLY_HEATMAP_DIVERGING_COLORSCALE,
  plotlyAxis,
} from '../lib/plotlyTheme';
import RangeBrush from './RangeBrush';
import ResetButton from './ResetButton';

const NUM_STRIKE_ROWS_MOBILE = 11;
const NUM_STRIKE_ROWS_DESKTOP = 13;
const STRIKE_INCREMENT_CANDIDATES = [5, 10, 25, 50, 100, 250, 500, 1000];

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const BASE_LAYOUT = {
  ...PLOTLY_BASE_LAYOUT_2D,
  margin: { t: 10, r: 40, b: 45, l: 110 },
  hovermode: 'closest',
  xaxis: plotlyAxis('', {
    side: 'bottom',
    type: 'category',
    tickangle: 0,
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

function buildStrikeLadder(spot, numRows) {
  const inc = niceStrikeIncrement(spot);
  const center = Math.round(spot / inc) * inc;
  const halfRows = Math.floor(numRows / 2);
  return Array.from({ length: numRows }, (_, i) => center + (i - halfRows) * inc);
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
  // Persists the user's current x-axis zoom (in category indices) so
  // toggling 1D Change / Level does not snap the view back to the
  // default window. The brush commits onChange with numeric [min, max]
  // index pairs on pointerUp.
  const [colRange, setColRange] = useState(null);
  const mobile = useIsMobile();

  const { levelMatrix, changeMatrix } = useMemo(() => {
    if (!contracts || contracts.length === 0 || !spotPrice || !expirations || expirations.length === 0) {
      return { levelMatrix: null, changeMatrix: null };
    }

    const numRows = mobile ? NUM_STRIKE_ROWS_MOBILE : NUM_STRIKE_ROWS_DESKTOP;
    const byExp = groupByExpiration(contracts);
    const prevByExp = groupByExpiration(prevContracts);

    // Drop the nearest expiration (the 0DTE column during trading hours):
    // same-day IV is dominated by gamma-scalping noise and pinning effects
    // that distort the term-structure story the rest of the grid is telling.
    const sortedExps = [...expirations].sort().slice(1);
    const xLabels = sortedExps.map(formatExpLabel);
    const strikes = buildStrikeLadder(spotPrice, numRows);
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
  }, [contracts, spotPrice, expirations, prevContracts, mobile]);

  const hasPrev = changeMatrix != null;
  // On mobile the toggle is hidden to avoid colliding with the section
  // title, so force 'change' mode there regardless of whatever the user
  // last selected on desktop before a resize.
  const isChangeMode = (mobile || mode === 'change') && hasPrev;
  const activeMatrix = isChangeMode ? changeMatrix : levelMatrix;

  // Default zoom shows 5 expirations on desktop (previously 10 —
  // boxes were too small to read at a glance) and 4 on mobile where
  // the card is narrower. Returns null when the full column set fits
  // inside the default, meaning no zoom is needed.
  const defaultColRange = useMemo(() => {
    if (!activeMatrix) return null;
    if (mobile) return [-0.5, 3.5];
    if (activeMatrix.xLabels.length > 5) return [-0.5, 4.5];
    return null;
  }, [activeMatrix, mobile]);

  const activeColRange = colRange || defaultColRange;
  const brushMin = -0.5;
  const brushMax = activeMatrix ? activeMatrix.xLabels.length - 0.5 : 0;

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
        size: mobile ? 9 : 12,
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
      ...(mobile ? { margin: { t: 10, r: 30, b: 45, l: 70 } } : {}),
      title: { text: '' },
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      xaxis: {
        ...BASE_LAYOUT.xaxis,
        ...(activeColRange ? { range: activeColRange, autorange: false } : {}),
      },
      // Lock the strike axis to the full ladder regardless of how the
      // user drags the x-axis rangeslider. Without fixedrange + an
      // explicit range, Plotly's autorange 'reversed' behavior treats
      // every rangeslider move as a data-range change event and
      // recomputes the y-axis bounds from the visible columns only,
      // which visibly compresses the strike ladder each time the slider
      // is moved. The range is expressed in category indices because
      // the axis type is 'category' — [N-0.5, -0.5] places the lowest-
      // index strike (which is the bottom strike numerically) at the
      // top and the highest-index strike at the bottom, matching the
      // high-strike-at-top / low-strike-at-bottom orientation that the
      // old autorange: 'reversed' produced.
      yaxis: {
        ...BASE_LAYOUT.yaxis,
        autorange: false,
        range: [activeMatrix.yLabels.length - 0.5, -0.5],
        fixedrange: true,
      },
    };

    Plotly.react(chartRef.current, [trace], layout, {
      responsive: true,
      displayModeBar: false,
    });
  }, [Plotly, activeMatrix, isChangeMode, mobile, activeColRange]);

  const handleBrushChange = useCallback((min, max) => {
    setColRange([min, max]);
  }, []);

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
    <div className="card" style={{ marginBottom: '1rem', position: 'relative' }}>
      <ResetButton visible={colRange != null} onClick={() => setColRange(null)} />
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
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
        {hasPrev && !mobile && (
          <div style={{ position: 'absolute', right: '0.75rem', display: 'inline-flex', gap: '0.35rem' }}>
            <button type="button" onClick={() => setMode('change')} style={toggleBtnStyle(mode === 'change')}>
              1D Change
            </button>
            <button type="button" onClick={() => setMode('level')} style={toggleBtnStyle(mode === 'level')}>
              Level
            </button>
          </div>
        )}
      </div>
      <div ref={chartRef} style={{ width: '100%', height: mobile ? '440px' : '510px', backgroundColor: 'var(--bg-card)' }} />
      {activeMatrix && activeMatrix.xLabels.length > 1 && (
        <RangeBrush
          min={brushMin}
          max={brushMax}
          activeMin={activeColRange ? activeColRange[0] : brushMin}
          activeMax={activeColRange ? activeColRange[1] : brushMax}
          onChange={handleBrushChange}
        />
      )}
    </div>
  );
}
