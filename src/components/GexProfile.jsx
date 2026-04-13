import { useEffect, useMemo, useRef, useState } from 'react';
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
  margin: { t: 85, r: 30, b: 70, l: 80 },
  xaxis: plotlyAxis('', { title: '' }),
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

const LABEL_STYLE = {
  position: 'absolute',
  backgroundColor: '#10131A',
  padding: '2px 6px',
  fontSize: '12px',
  fontFamily: 'Courier New, monospace',
  fontWeight: 'bold',
  pointerEvents: 'none',
  whiteSpace: 'nowrap',
};

export default function GexProfile({ contracts, spotPrice, levels }) {
  const chartRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();
  const [labels, setLabels] = useState([]);

  const gexData = useMemo(() => {
    if (!contracts || contracts.length === 0 || !spotPrice) return null;
    const all = computeGexByStrike(contracts, spotPrice);
    const lower = spotPrice * 0.8;
    const upper = spotPrice * 1.2;
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

    // Dashed vertical reference lines only — labels are rendered as HTML
    const shapes = [];
    const pushLine = (x, color) => {
      if (x == null) return;
      shapes.push({
        type: 'line',
        x0: x,
        x1: x,
        yref: 'paper',
        y0: 0,
        y1: 1,
        line: { color, width: 3, dash: 'dash' },
      });
    };

    pushLine(spotPrice, PLOTLY_COLORS.primary);
    if (levels) {
      pushLine(levels.volatility_flip, PLOTLY_COLORS.highlight);
    }

    const layout = {
      ...PLOTLY_LAYOUT_BASE,
      title: {
        ...plotlyTitle('Gamma Exposure Profile (Symlog Adjustment)'),
        y: 0.97,
        yanchor: 'top',
      },
      yaxis: plotlyAxis('Gamma Exposure ($ notional)', {
        zerolinewidth: 2,
        tickvals,
        ticktext,
      }),
      shapes,
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
    };

    Plotly.newPlot(chartRef.current, traces, layout, {
      responsive: true,
      displayModeBar: false,
    }).then(() => {
      const fl = chartRef.current?._fullLayout;
      if (!fl) return;
      const { l: ml, t: mt, b: mb, r: mr } = fl.margin;
      const plotW = fl.width - ml - mr;
      const plotH = fl.height - mt - mb;
      const [xMin, xMax] = fl.xaxis.range;
      const xScale = plotW / (xMax - xMin);
      const px = (dataX) => ml + (dataX - xMin) * xScale;

      const topY = mt - 5;
      const bottomY = mt + plotH - 2;

      const newLabels = [
        { left: px(spotPrice), top: topY, color: PLOTLY_COLORS.primary, text: 'SPOT', bottom: false },
      ];
      if (levels) {
        if (levels.call_wall != null)
          newLabels.push({ left: px(levels.call_wall), top: topY, color: PLOTLY_COLORS.positive, text: 'CW', bottom: false });
        if (levels.put_wall != null)
          newLabels.push({ left: px(levels.put_wall), top: topY, color: PLOTLY_COLORS.negative, text: 'PW', bottom: false });
        if (levels.volatility_flip != null)
          newLabels.push({ left: px(levels.volatility_flip), top: bottomY, color: PLOTLY_COLORS.highlight, text: 'FLIP', bottom: true });
      }
      setLabels(newLabels);
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
      <div style={{ position: 'relative' }}>
        <div
          ref={chartRef}
          style={{ width: '100%', height: '530px', backgroundColor: '#141820' }}
        />
        {labels.map((l, i) => (
          <div
            key={i}
            style={{
              ...LABEL_STYLE,
              left: l.left,
              top: l.top,
              transform: l.bottom ? 'translateX(-50%)' : 'translate(-50%, -100%)',
              color: l.color,
              border: `1.5px solid ${l.color}`,
            }}
          >
            {l.text}
          </div>
        ))}
      </div>
    </div>
  );
}
