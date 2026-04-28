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
import { computeGammaProfile, findFlipFromProfile } from '../lib/gammaProfile';
import { formatInteger } from '../lib/format';
import { formatExpirationOption } from '../lib/dates';
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
        fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
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

// Single row inside the per-expiration custom-levels overlay panel that
// pops into the chart's upper-left when a single expiration is picked.
// Label-on-the-left, value-on-the-right; renders an em-dash when the
// value is null (e.g., a 0DTE with no zero crossing inside the swept
// spot range) so the row count stays stable across selections and the
// reader sees explicitly which level couldn't be resolved rather than
// a missing row.
function CustomLevelRow({ label, value, color, mobile }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        gap: '0.75rem',
      }}
    >
      <span
        style={{
          color: 'var(--text-secondary)',
          fontSize: mobile ? '0.6rem' : '0.7rem',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
        }}
      >
        {label}
      </span>
      <span
        style={{
          color,
          fontSize: mobile ? '0.8rem' : '0.95rem',
          fontWeight: 'bold',
          fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
        }}
      >
        {value != null ? formatInteger(value) : '—'}
      </span>
    </div>
  );
}

export default function GexProfile({ contracts, spotPrice, levels, prevContracts, prevSpotPrice, capturedAt }) {
  const chartRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();
  const [showPrior, setShowPrior] = useState(true);
  const [strikeRange, setStrikeRange] = useState(null);
  // null = ALL EXPIRATIONS (the default — bars aggregate the full chain).
  // Non-null = single ISO expiration date; today's bars and the prior-day
  // shadow bars both filter down to that one chain so the reader can
  // isolate gamma exposure for one option-series and watch how that
  // single chain has shifted overnight.
  const [selectedExpiration, setSelectedExpiration] = useState(null);
  const mobile = useIsMobile();

  // Sorted unique ISO expiration dates that today's chain actually carries.
  // Drives the upper-left picker so every option in the dropdown is
  // guaranteed to render at least one bar — derived from contracts rather
  // than passed as a prop because the component already receives the full
  // contract list and threading another prop through App.jsx would
  // duplicate the source-of-truth.
  const availableExpirations = useMemo(() => {
    if (!contracts || contracts.length === 0) return [];
    const set = new Set();
    for (const c of contracts) {
      if (c.expiration_date) set.add(c.expiration_date);
    }
    return Array.from(set).sort();
  }, [contracts]);

  // When the chain refreshes and the previously-selected expiration is no
  // longer present (e.g., expired between sessions, or the snapshot dropped
  // a tail expiration), fall back to ALL EXPIRATIONS so the chart doesn't
  // render against a stale selection that no longer exists in the data.
  useEffect(() => {
    if (
      selectedExpiration &&
      availableExpirations.length > 0 &&
      !availableExpirations.includes(selectedExpiration)
    ) {
      setSelectedExpiration(null);
    }
  }, [selectedExpiration, availableExpirations]);

  // When the picker changes, reset the strike-range brush so the chart
  // re-centers on the new chain's natural range. Single expirations
  // typically have tighter strike coverage than the full chain (e.g., a
  // 0DTE has strikes mostly within ±2% of spot, where a 90-day chain
  // covers ±20%), so a previously-set brush window from the aggregate
  // view often exceeds the new chain's data and leaves the brush handles
  // visually misaligned against the bars below them.
  useEffect(() => {
    setStrikeRange(null);
  }, [selectedExpiration]);

  const filteredContracts = useMemo(() => {
    if (!contracts) return null;
    if (!selectedExpiration) return contracts;
    return contracts.filter((c) => c.expiration_date === selectedExpiration);
  }, [contracts, selectedExpiration]);

  const filteredPrevContracts = useMemo(() => {
    if (!prevContracts) return null;
    if (!selectedExpiration) return prevContracts;
    return prevContracts.filter((c) => c.expiration_date === selectedExpiration);
  }, [prevContracts, selectedExpiration]);

  const gexData = useMemo(() => {
    if (!filteredContracts || filteredContracts.length === 0 || !spotPrice) return null;
    const all = computeGexByStrike(filteredContracts, spotPrice);
    const lower = spotPrice * 0.8;
    const upper = spotPrice * 1.2;
    return all.filter((e) => e.strike >= lower && e.strike <= upper);
  }, [filteredContracts, spotPrice]);

  const prevGexData = useMemo(() => {
    if (!filteredPrevContracts || filteredPrevContracts.length === 0 || !prevSpotPrice || !spotPrice) return null;
    const all = computeGexByStrike(filteredPrevContracts, prevSpotPrice);
    const lower = spotPrice * 0.8;
    const upper = spotPrice * 1.2;
    return all.filter((e) => e.strike >= lower && e.strike <= upper);
  }, [filteredPrevContracts, prevSpotPrice, spotPrice]);

  // Per-expiration walls and flip — recomputed from the picked chain's
  // contracts alone so the reader sees where THIS expiration's gamma is
  // concentrated rather than the rolled-up aggregate the chart's vertical
  // reference lines (and the chip row above the chart) keep showing. The
  // panel only renders when an expiration is picked; in ALL EXPIRATIONS
  // mode this returns null and the panel JSX short-circuits.
  //
  // Mirrors the convention in netlify/functions/ingest-background.mjs that
  // produces the aggregate-chain levels Supabase persists: walls are the
  // signed-net-GEX (callGex - putGex) extremes constrained to strikes
  // within ±15% of spot to exclude stale-OI deep-OTM winners (the same
  // WALL_WINDOW_PCT the backend uses), and the flip is the smooth
  // dealer-gamma profile zero crossing from computeGammaProfile +
  // findFlipFromProfile. Re-computing client-side keeps the methodology
  // identical to the backend's aggregate-chain math without needing a
  // round-trip through Supabase for every picker change.
  const customLevels = useMemo(() => {
    if (!selectedExpiration || !filteredContracts || filteredContracts.length === 0 || !spotPrice) return null;
    const all = computeGexByStrike(filteredContracts, spotPrice);
    if (all.length === 0) return null;
    const wallMin = spotPrice * 0.85;
    const wallMax = spotPrice * 1.15;
    let callWall = null;
    let putWall = null;
    let callMaxNet = -Infinity;
    let putMinNet = Infinity;
    for (const e of all) {
      if (e.strike < wallMin || e.strike > wallMax) continue;
      const net = e.callGex - e.putGex;
      if (net > callMaxNet) {
        callMaxNet = net;
        callWall = e.strike;
      }
      if (net < putMinNet) {
        putMinNet = net;
        putWall = e.strike;
      }
    }
    const profile = computeGammaProfile(filteredContracts, spotPrice, capturedAt);
    const flip = profile ? findFlipFromProfile(profile) : null;
    return { put_wall: putWall, volatility_flip: flip, call_wall: callWall };
  }, [selectedExpiration, filteredContracts, spotPrice, capturedAt]);

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
        {/* Title row holds three slots: an upper-left expiration picker
            (single-chain isolation, default ALL EXPIRATIONS), the centered
            chart title, and an upper-right Prior Day toggle. The picker
            and the toggle are absolute-positioned so the title stays
            optically centered regardless of either control's intrinsic
            width. The picker option text and the toggle button text are
            both compact (mobile font size at phone widths) so all three
            slots fit on a single row down to ~360 px viewport widths. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            position: 'relative',
            minHeight: '1.7rem',
          }}
        >
          {availableExpirations.length > 0 && (
            <div style={{ position: 'absolute', left: 0 }}>
              <select
                className="expiration-picker"
                aria-label="Filter AI Gamma Map by expiration"
                value={selectedExpiration || ''}
                onChange={(e) => setSelectedExpiration(e.target.value || null)}
                style={{
                  background: 'var(--bg-primary)',
                  color: 'var(--text-primary)',
                  padding: '0.15rem 0.45rem',
                  fontFamily: PLOTLY_FONT_FAMILY,
                  fontSize: mobile ? '0.65rem' : '0.75rem',
                  letterSpacing: '0.05em',
                  textTransform: 'uppercase',
                }}
              >
                <option value="">All Expirations</option>
                {availableExpirations.map((exp) => (
                  <option key={exp} value={exp}>{formatExpirationOption(exp, capturedAt)}</option>
                ))}
              </select>
            </div>
          )}
          <span
            style={{
              color: PLOTLY_COLORS.titleText,
              fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
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
        {/* Reference-level chips beneath the title. The earlier P/C (OI)
            chip was lifted out of this row to make space for the new
            expiration picker above — the picker is the higher-leverage
            affordance because it lets the reader isolate a single chain's
            gamma rather than read a single aggregate-chain ratio. The
            chain-level put/call ratio still ships in the wire payload as
            levels.put_call_ratio_oi if a future surface needs it. */}
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
        </div>
      </div>
      {/* Chart wrapper carries position: relative so the per-expiration
          custom-levels panel below can absolute-position itself into the
          upper-left of the plot area — the empty space above the y-axis
          label and below the chip row that's wasted in single-chain mode
          when the leftmost deep-OTM bars contribute little gamma. The
          panel renders only when an expiration is picked; in ALL
          EXPIRATIONS mode it short-circuits and the chart's left margin
          carries only the y-axis title and tick labels as before. */}
      <div style={{ position: 'relative' }}>
        <div
          ref={chartRef}
          style={{ width: '100%', height: '700px', backgroundColor: 'var(--bg-card)' }}
        />
        {customLevels && (
          <div
            style={{
              position: 'absolute',
              top: mobile ? '8px' : '14px',
              left: mobile ? '6px' : '14px',
              zIndex: 2,
              background: 'var(--bg-card)',
              border: '1px solid var(--bg-card-border)',
              borderRadius: '4px',
              padding: mobile ? '0.4rem 0.5rem' : '0.55rem 0.75rem',
              display: 'flex',
              flexDirection: 'column',
              gap: mobile ? '0.25rem' : '0.35rem',
              minWidth: mobile ? '110px' : '155px',
            }}
          >
            <div
              style={{
                color: 'var(--text-secondary)',
                fontSize: mobile ? '0.55rem' : '0.62rem',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
                paddingBottom: mobile ? '0.2rem' : '0.3rem',
                borderBottom: '1px solid var(--bg-card-border)',
              }}
            >
              Single-chain levels
            </div>
            <CustomLevelRow label="Put Wall" value={customLevels.put_wall} color={PLOTLY_COLORS.negative} mobile={mobile} />
            <CustomLevelRow label="Vol Flip" value={customLevels.volatility_flip} color={PLOTLY_COLORS.highlight} mobile={mobile} />
            <CustomLevelRow label="Call Wall" value={customLevels.call_wall} color={PLOTLY_COLORS.positive} mobile={mobile} />
          </div>
        )}
      </div>
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
