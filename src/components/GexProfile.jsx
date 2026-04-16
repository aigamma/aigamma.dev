import { useEffect, useMemo, useRef } from 'react';
import usePlotly from '../hooks/usePlotly';
import {
  PLOTLY_BASE_LAYOUT_2D,
  PLOTLY_COLORS,
  PLOTLY_SERIES_OPACITY,
  plotlyAxis,
  plotlyRangeslider,
} from '../lib/plotlyTheme';
import { computeGexByStrike, symlog, symlogTicks } from '../lib/gex';
import { formatInteger } from '../lib/format';

const PLOTLY_LAYOUT_BASE = {
  ...PLOTLY_BASE_LAYOUT_2D,
  margin: { t: 20, r: 30, b: 15, l: 80 },
  xaxis: plotlyAxis('', { title: '', rangeslider: plotlyRangeslider() }),
  yaxis: plotlyAxis('Gamma Exposure ($ notional)', {
    zerolinewidth: 2,
    tickformat: '.2s',
  }),
  barmode: 'relative',
};

function LevelLabel({ name, value, color }) {
  if (value == null) return null;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: '0.5rem',
        fontFamily: 'Courier New, monospace',
      }}
    >
      <span
        style={{
          color: 'var(--text-secondary)',
          fontSize: '0.75rem',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
        }}
      >
        {name}
      </span>
      <span
        style={{
          color,
          fontSize: '1rem',
          fontWeight: 'bold',
        }}
      >
        {formatInteger(value)}
      </span>
    </div>
  );
}

export default function GexProfile({ contracts, spotPrice, levels }) {
  const chartRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();

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

    // Dashed vertical reference lines only — no text attached. The horizontal
    // legend row above the chart names each line and supplies the numeric
    // value, so the in-plot markers carry no labels of their own and stay
    // locked to data coordinates as the user pans or zooms the rangeslider.
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

    if (levels) {
      pushLine(levels.put_wall, PLOTLY_COLORS.negative);
      pushLine(levels.volatility_flip, PLOTLY_COLORS.highlight);
      pushLine(levels.call_wall, PLOTLY_COLORS.positive);
    }
    pushLine(spotPrice, PLOTLY_COLORS.primary);

    const strikeMin = strikes[0];
    const strikeMax = strikes[strikes.length - 1];
    const zoomLow = spotPrice * 0.87;
    const zoomHigh = spotPrice * 1.13;

    const layout = {
      ...PLOTLY_LAYOUT_BASE,
      xaxis: plotlyAxis('', {
        title: '',
        range: [zoomLow, zoomHigh],
        autorange: false,
        rangeslider: plotlyRangeslider({ range: [strikeMin, strikeMax], autorange: false }),
      }),
      yaxis: plotlyAxis('Gamma Exposure ($ notional)', {
        zerolinewidth: 2,
        tickvals,
        ticktext,
      }),
      shapes,
      showlegend: false,
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
        style={{
          padding: '0.75rem 1rem 0.5rem 1rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.6rem',
        }}
      >
        <div
          style={{
            color: PLOTLY_COLORS.titleText,
            fontFamily: 'Courier New, monospace',
            fontSize: '20px',
            fontWeight: 'normal',
            lineHeight: 1,
            textAlign: 'center',
          }}
        >
          AI Gamma Map
        </div>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '1.75rem',
            alignItems: 'baseline',
            justifyContent: 'center',
          }}
        >
          <LevelLabel name="Put Wall" value={levels?.put_wall} color={PLOTLY_COLORS.negative} />
          <LevelLabel name="Flip" value={levels?.volatility_flip} color={PLOTLY_COLORS.highlight} />
          <LevelLabel name="Spot" value={spotPrice} color={PLOTLY_COLORS.primary} />
          <LevelLabel name="Call Wall" value={levels?.call_wall} color={PLOTLY_COLORS.positive} />
        </div>
      </div>
      <div
        ref={chartRef}
        style={{ width: '100%', height: '700px', backgroundColor: 'var(--bg-card)' }}
      />
    </div>
  );
}
