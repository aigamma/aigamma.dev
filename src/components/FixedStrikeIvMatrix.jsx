import { useEffect, useMemo, useRef } from 'react';
import usePlotly from '../hooks/usePlotly';
import {
  PLOTLY_BASE_LAYOUT_2D,
  PLOTLY_COLORBAR,
  PLOTLY_FONT_FAMILY,
  PLOTLY_FONTS,
  PLOTLY_HEATMAP_COLORSCALE,
  plotlyAxis,
  plotlyRangeslider,
  plotlyTitle,
} from '../lib/plotlyTheme';

const OFFSETS = [-0.05, -0.04, -0.03, -0.02, -0.01, 0, 0.01, 0.02, 0.03, 0.04, 0.05];

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const BASE_LAYOUT = {
  ...PLOTLY_BASE_LAYOUT_2D,
  margin: { t: 40, r: 40, b: 60, l: 110 },
  hovermode: 'closest',
  xaxis: plotlyAxis('', {
    side: 'bottom',
    type: 'category',
    tickangle: 0,
    rangeslider: plotlyRangeslider(),
  }),
  yaxis: plotlyAxis('Strike offset vs spot', {
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

function offsetLabel(offset) {
  if (offset === 0) return 'ATM';
  const sign = offset > 0 ? '+' : '';
  return `${sign}${(offset * 100).toFixed(0)}%`;
}

export default function FixedStrikeIvMatrix({ contracts, spotPrice, expirations }) {
  const chartRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();

  const matrix = useMemo(() => {
    if (!contracts || contracts.length === 0 || !spotPrice || !expirations || expirations.length === 0) {
      return null;
    }
    const byExp = new Map();
    for (const c of contracts) {
      if (!c.expiration_date) continue;
      if (!byExp.has(c.expiration_date)) byExp.set(c.expiration_date, []);
      byExp.get(c.expiration_date).push(c);
    }

    const sortedExps = [...expirations].sort();
    const xLabels = sortedExps.map(formatExpLabel);
    const yLabels = OFFSETS.map(offsetLabel);

    const z = OFFSETS.map(() => []);
    const textCells = OFFSETS.map(() => []);

    for (let col = 0; col < sortedExps.length; col++) {
      const expContracts = byExp.get(sortedExps[col]) || [];
      for (let row = 0; row < OFFSETS.length; row++) {
        const offset = OFFSETS[row];
        const targetStrike = spotPrice * (1 + offset);
        const preferCall = offset > 0;
        const iv = interpolateIv(expContracts, targetStrike, preferCall);
        const neutralIv =
          iv == null && offset === 0
            ? interpolateIv(expContracts, targetStrike, false) || interpolateIv(expContracts, targetStrike, true)
            : iv;
        const finalIv = iv != null ? iv : neutralIv;
        z[row].push(finalIv != null ? finalIv * 100 : null);
        textCells[row].push(finalIv != null ? `${(finalIv * 100).toFixed(2)}%` : '—');
      }
    }

    return { xLabels, yLabels, z, textCells };
  }, [contracts, spotPrice, expirations]);

  useEffect(() => {
    if (!Plotly || !chartRef.current || !matrix) return;

    const allValues = matrix.z.flat().filter((v) => v != null);
    if (allValues.length === 0) return;
    const zMin = Math.min(...allValues);
    const zMax = Math.max(...allValues);

    const trace = {
      type: 'heatmap',
      z: matrix.z,
      x: matrix.xLabels,
      y: matrix.yLabels,
      text: matrix.textCells,
      texttemplate: '%{text}',
      textfont: { family: PLOTLY_FONT_FAMILY, size: 12, color: '#0d0f13', weight: 700 },
      colorscale: PLOTLY_HEATMAP_COLORSCALE,
      zmin: zMin,
      zmax: zMax,
      hoverongaps: false,
      hovertemplate: '%{x}<br>Offset %{y}<br>IV %{text}<extra></extra>',
      xgap: 2,
      ygap: 2,
      opacity: 0.85,
      colorbar: {
        ...PLOTLY_COLORBAR,
        title: { text: 'IV %', font: PLOTLY_FONTS.axisTitle },
        thickness: 14,
        len: 0.9,
        outlinewidth: 0,
      },
    };

    const layout = {
      ...BASE_LAYOUT,
      title: plotlyTitle('Fixed-Strike IV Matrix'),
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      xaxis: {
        ...BASE_LAYOUT.xaxis,
        ...(matrix.xLabels.length > 10 ? { range: [-0.5, 9.5] } : {}),
      },
    };

    Plotly.newPlot(chartRef.current, [trace], layout, {
      responsive: true,
      displayModeBar: false,
    });
  }, [Plotly, matrix]);

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
  if (!matrix) {
    return (
      <div className="card text-muted" style={{ padding: '1rem', marginBottom: '1rem' }}>
        Fixed-strike IV matrix unavailable.
      </div>
    );
  }

  return (
    <div className="card" style={{ marginBottom: '1rem' }}>
      <div ref={chartRef} style={{ width: '100%', height: '440px', backgroundColor: 'var(--bg-card)' }} />
    </div>
  );
}
