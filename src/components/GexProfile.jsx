import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import usePlotly from '../hooks/usePlotly';
import useIsMobile from '../hooks/useIsMobile';
import {
  PLOTLY_BASE_LAYOUT_2D,
  PLOTLY_COLORS,
  PLOTLY_FONT_FAMILY,
  PLOTLY_SERIES_OPACITY,
  plotlyAxis,
} from '../lib/plotlyTheme';
import { computeGexByStrike, symlog, symlogTicks } from '../lib/gex';
import { formatInteger, formatRatio } from '../lib/format';
import RangeBrush from './RangeBrush';
import ResetButton from './ResetButton';

const PLOTLY_LAYOUT_BASE = {
  ...PLOTLY_BASE_LAYOUT_2D,
  margin: { t: 20, r: 30, b: 45, l: 80 },
  xaxis: plotlyAxis('', { title: '' }),
  yaxis: plotlyAxis('Gamma Exposure ($ notional)', {
    zerolinewidth: 2,
    tickformat: '.2s',
  }),
  barmode: 'overlay',
};

const SHADOW_OPACITY = 0.2;

function LevelLabel({ name, value, color, format = formatInteger }) {
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
        {format(value)}
      </span>
    </div>
  );
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

export default function GexProfile({ contracts, spotPrice, levels, prevContracts, prevSpotPrice }) {
  const chartRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();
  const [showPrior, setShowPrior] = useState(true);
  const [strikeRange, setStrikeRange] = useState(null);
  const mobile = useIsMobile();

  const gexData = useMemo(() => {
    if (!contracts || contracts.length === 0 || !spotPrice) return null;
    const all = computeGexByStrike(contracts, spotPrice);
    const lower = spotPrice * 0.8;
    const upper = spotPrice * 1.2;
    return all.filter((e) => e.strike >= lower && e.strike <= upper);
  }, [contracts, spotPrice]);

  const prevGexData = useMemo(() => {
    if (!prevContracts || prevContracts.length === 0 || !prevSpotPrice || !spotPrice) return null;
    const all = computeGexByStrike(prevContracts, prevSpotPrice);
    const lower = spotPrice * 0.8;
    const upper = spotPrice * 1.2;
    return all.filter((e) => e.strike >= lower && e.strike <= upper);
  }, [prevContracts, prevSpotPrice, spotPrice]);

  const hasPrior = prevGexData != null && prevGexData.length > 0;

  const brushDomain = useMemo(() => {
    if (!gexData || gexData.length === 0) return null;
    const strikes = gexData.map((e) => e.strike);
    const strikeMin = strikes[0];
    const strikeMax = strikes[strikes.length - 1];
    const zoomLow = spotPrice * 0.94;
    let zoomHigh = spotPrice * 1.03;
    if (levels?.call_wall != null && levels.call_wall > zoomHigh) {
      zoomHigh = levels.call_wall * 1.01;
    }
    return { strikeMin, strikeMax, defaultRange: [zoomLow, zoomHigh] };
  }, [gexData, spotPrice, levels]);

  const activeRange = strikeRange || brushDomain?.defaultRange;

  useEffect(() => {
    if (!Plotly || !chartRef.current || !gexData || gexData.length === 0) return;

    const strikes = gexData.map((e) => e.strike);
    const callGexRaw = gexData.map((e) => e.callGex);
    const putGexRaw = gexData.map((e) => -e.putGex);

    // Build combined raw values for consistent symlog scaling when shadow is active.
    let allRaw = [...callGexRaw, ...putGexRaw];
    let prevCallGexRaw, prevPutGexRaw, prevStrikes;
    if (showPrior && hasPrior) {
      prevStrikes = prevGexData.map((e) => e.strike);
      prevCallGexRaw = prevGexData.map((e) => e.callGex);
      prevPutGexRaw = prevGexData.map((e) => -e.putGex);
      allRaw = [...allRaw, ...prevCallGexRaw, ...prevPutGexRaw];
    }

    // C sets the symlog crossover: below C the bars scale linearly (preserving
    // relative size), above C they compress logarithmically. Using P90 of the
    // actual bar magnitudes (not net GEX) keeps the top 10% of bars in the log
    // regime and the rest linear, so the important ATM bars dominate visually
    // instead of being flattened into uniformity.
    const allAbs = allRaw.map(Math.abs).sort((a, b) => a - b);
    const C = allAbs[Math.floor(allAbs.length * 0.90)] || 1;

    const { tickvals, ticktext } = symlogTicks(allRaw, C);

    const traces = [];

    // Ghost bars from previous day — drawn first so they sit behind.
    if (showPrior && hasPrior) {
      traces.push(
        {
          x: prevStrikes,
          y: prevCallGexRaw.map((v) => symlog(v, C)),
          type: 'bar',
          name: 'Prior Call',
          marker: { color: PLOTLY_COLORS.positive, opacity: SHADOW_OPACITY },
          hoverinfo: 'skip',
          showlegend: false,
        },
        {
          x: prevStrikes,
          y: prevPutGexRaw.map((v) => symlog(v, C)),
          type: 'bar',
          name: 'Prior Put',
          marker: { color: PLOTLY_COLORS.negative, opacity: SHADOW_OPACITY },
          hoverinfo: 'skip',
          showlegend: false,
        },
      );
    }

    // Current bars — drawn last so they render on top.
    traces.push(
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
    );

    const shapes = [];
    const pushLine = (x, color, dash = 'dash') => {
      if (x == null) return;
      shapes.push({
        type: 'line',
        x0: x,
        x1: x,
        yref: 'paper',
        y0: 0,
        y1: 1,
        line: { color, width: 3, dash },
      });
    };

    if (levels) {
      pushLine(levels.put_wall, PLOTLY_COLORS.negative, 'dot');
      pushLine(levels.volatility_flip, PLOTLY_COLORS.highlight);
      pushLine(levels.call_wall, PLOTLY_COLORS.positive);
    }
    pushLine(spotPrice, PLOTLY_COLORS.primary);

    const [zoomLow, zoomHigh] = activeRange || [spotPrice * 0.94, spotPrice * 1.03];

    const layout = {
      ...PLOTLY_LAYOUT_BASE,
      ...(mobile ? { margin: { t: 20, r: 15, b: 40, l: 50 } } : {}),
      xaxis: plotlyAxis('', {
        title: '',
        range: [zoomLow, zoomHigh],
        autorange: false,
      }),
      yaxis: plotlyAxis(mobile ? '' : 'Gamma Exposure ($ notional)', {
        zerolinewidth: 2,
        tickvals,
        ticktext,
        ticks: 'outside',
        ticklen: 8,
        tickcolor: 'transparent',
      }),
      shapes,
      showlegend: false,
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
    };

    Plotly.react(chartRef.current, traces, layout, {
      responsive: true,
      displayModeBar: false,
    });
  }, [Plotly, gexData, spotPrice, levels, prevGexData, showPrior, hasPrior, mobile, activeRange]);

  const handleBrushChange = useCallback((min, max) => {
    setStrikeRange([min, max]);
  }, []);

  if (plotlyError) {
    return (
      <div
        className="card"
        style={{ padding: '1rem', marginBottom: '1rem', color: 'var(--accent-coral)' }}
      >
        Gamma exposure profile unavailable: Plotly failed to load ({plotlyError}).
      </div>
    );
  }
  if (!contracts || contracts.length === 0) {
    return <div className="card text-muted">No GEX data available.</div>;
  }

  return (
    <div className="card" style={{ marginBottom: '1rem', position: 'relative' }}>
      <ResetButton visible={strikeRange != null} onClick={() => setStrikeRange(null)} />
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
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            position: 'relative',
          }}
        >
          <span
            style={{
              color: PLOTLY_COLORS.titleText,
              fontFamily: 'Courier New, monospace',
              fontSize: '20px',
              fontWeight: 'normal',
              lineHeight: 1,
            }}
          >
            AI Gamma Map
          </span>
          {hasPrior && (
            <div style={{ position: 'absolute', right: 0 }}>
              <button type="button" onClick={() => setShowPrior((p) => !p)} style={toggleBtnStyle(showPrior)}>
                Prior Day
              </button>
            </div>
          )}
        </div>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: mobile ? '0.75rem' : '1.75rem',
            alignItems: 'baseline',
            justifyContent: 'center',
          }}
        >
          <LevelLabel name="Put Wall" value={levels?.put_wall} color={PLOTLY_COLORS.negative} />
          <LevelLabel name="Flip" value={levels?.volatility_flip} color={PLOTLY_COLORS.highlight} />
          <LevelLabel name="SPX" value={spotPrice} color={PLOTLY_COLORS.primary} />
          <LevelLabel name="Call Wall" value={levels?.call_wall} color={PLOTLY_COLORS.positive} />
          <LevelLabel
            name="P/C (OI)"
            value={levels?.put_call_ratio_oi}
            color="var(--accent-purple)"
            format={formatRatio}
          />
        </div>
      </div>
      <div
        ref={chartRef}
        style={{ width: '100%', height: '700px', backgroundColor: 'var(--bg-card)' }}
      />
      {brushDomain && activeRange && (
        <RangeBrush
          min={brushDomain.strikeMin}
          max={brushDomain.strikeMax}
          activeMin={activeRange[0]}
          activeMax={activeRange[1]}
          onChange={handleBrushChange}
        />
      )}
    </div>
  );
}
