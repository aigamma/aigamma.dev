import { useEffect, useMemo, useRef, useState } from 'react';

// SPX Skew Scanner — the visual centerpiece of /scan. Renders a 2x2
// quadrant of the top-40 options-active single-name stocks by:
//
//   Y axis (vertical):    30D ATM implied volatility, percentile-ranked
//   X axis (horizontal):  25-delta call skew (call tab) or 25-delta
//                         put skew (put tab), percentile-ranked
//
// Percentile ranking guarantees the median split sits at the quadrant
// cross-hairs every render — robust to the absolute IV / skew level on
// any given day. The four quadrants then map to readings independent
// of regime: top-left is "high IV, high wing demand", top-right is
// "high IV, low wing demand", and so on, with the same interpretation
// whether VIX prints 12 or 35 today.
//
// Tab semantics:
//   Call skew tab:  X axis is call_25Δ_iv − atm_iv. High X = right
//                   wing (call) richer than ATM. The mega-cap cluster
//                   typically sits top-left because heavy call demand
//                   from covered-call writers and YOLO buyers leaves
//                   the right wing well-bid even when ATM is also
//                   well-bid.
//   Put skew tab:   X axis is put_25Δ_iv − atm_iv. High X = left wing
//                   (put) richer than ATM. The mega-cap cluster
//                   typically sits bottom-right because their compressed
//                   IV regime damps both wings simultaneously.
//
// View modes:
//   Guided View:    Renders the four corner labels and the consensus-
//                   corner highlight tag (e.g. "AAPL, MSFT, TSLA, NVDA"
//                   sticker) so a first-time reader has scaffolding for
//                   what each region means.
//   Explorer View:  Strips the corner labels so the data points and
//                   axes are unobstructed. Good for hunting for
//                   outliers without the chrome.
//
// The consensus-corner sticker is data-driven, not hard-coded — it
// names the actual mega-cap members of the relevant quadrant for the
// current snapshot. If MSFT moved out of the high-IV cluster into a
// quieter regime the sticker reflects that automatically rather than
// going stale.

const TABS = {
  call: {
    key: 'call',
    label: 'Call skew',
    metricKey: 'callSkew',
    leftLabel: 'High call skew',
    rightLabel: 'Low call skew',
    consensusQuadrant: 'topLeft',  // mega-caps live top-left on call
    paletteAccent: '#04A29F',      // teal
    paletteContrast: '#d85a30',    // coral
  },
  put: {
    key: 'put',
    label: 'Put skew',
    metricKey: 'putSkew',
    leftLabel: 'High put skew',
    rightLabel: 'Low put skew',
    consensusQuadrant: 'bottomRight',  // mega-caps live bottom-right on put
    paletteAccent: '#04A29F',
    paletteContrast: '#d85a30',
  },
};

// Mega-caps that traditionally illustrate the "consensus" quadrant of
// each tab. Used only as a label-overlay hint in Guided View; the
// scatter still plots whatever the live data says. Members are checked
// against the actual response so a missing/skipped name doesn't show
// in the sticker.
const CONSENSUS_TICKERS = ['AAPL', 'MSFT', 'TSLA', 'NVDA'];

function pctRank(values, valueAccessor) {
  // Returns a function symbol -> percentile in [0, 1]. Ties get the
  // average rank, so a cluster of identical values lands at the same
  // X coordinate rather than fanning out arbitrarily.
  const numericPairs = values
    .map((v) => ({ key: v.symbol, x: valueAccessor(v) }))
    .filter((p) => Number.isFinite(p.x));
  numericPairs.sort((a, b) => a.x - b.x);
  const ranks = new Map();
  let i = 0;
  while (i < numericPairs.length) {
    let j = i;
    while (j < numericPairs.length && numericPairs[j].x === numericPairs[i].x) j++;
    const avgRank = ((i + 1) + j) / 2; // midpoint, 1-based
    for (let k = i; k < j; k++) {
      ranks.set(numericPairs[k].key, avgRank / (numericPairs.length + 1));
    }
    i = j;
  }
  return (sym) => (ranks.has(sym) ? ranks.get(sym) : null);
}

function formatPct(v, digits = 1) {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}

function formatVolPoints(v, digits = 1) {
  if (v == null || !Number.isFinite(v)) return '—';
  const sign = v > 0 ? '+' : '';
  return `${sign}${(v * 100).toFixed(digits)}vp`;
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export default function SkewScanner() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('call');
  const [view, setView] = useState('guided'); // 'guided' | 'explorer'
  const [hoveredSymbol, setHoveredSymbol] = useState(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const wrapRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/scan')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j) => {
        if (!cancelled) setData(j);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e?.message || e));
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!wrapRef.current || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(Math.max(0, Math.floor(entry.contentRect.width)));
      }
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  const spec = TABS[tab];

  // Filter to tickers with valid IV + the relevant skew metric.
  // Tickers that priced for one tab but not the other (rare but
  // possible — e.g., the call wing strike was missing) simply drop
  // from the tab where their datum is null.
  const plotted = useMemo(() => {
    if (!data?.tickers) return [];
    return data.tickers.filter(
      (t) => Number.isFinite(t.atmIv) && Number.isFinite(t[spec.metricKey])
    );
  }, [data, spec.metricKey]);

  const ivRank = useMemo(() => pctRank(plotted, (t) => t.atmIv), [plotted]);
  const skewRank = useMemo(
    () => pctRank(plotted, (t) => t[spec.metricKey]),
    [plotted, spec.metricKey]
  );

  // The "consensus" quadrant resident sticker. Filters CONSENSUS_TICKERS
  // to those that landed in the expected quadrant for the current tab —
  // empty if none of them did, in which case the sticker is hidden.
  const consensusResidents = useMemo(() => {
    if (view !== 'guided') return [];
    const expected = spec.consensusQuadrant;
    return plotted
      .filter((t) => CONSENSUS_TICKERS.includes(t.symbol))
      .filter((t) => {
        const yp = ivRank(t.symbol);
        const xp = skewRank(t.symbol);
        if (yp == null || xp == null) return false;
        // Note: y-axis is inverted in screen coords (top = high IV).
        // High IV ⇒ yp > 0.5; high skew ⇒ xp > 0.5 (left side).
        // For "high skew" we mean position closer to LEFT, so x_screen < 0.5.
        // We'll re-encode the two boolean coordinates, then map to quadrant.
        const isHighIv = yp >= 0.5;
        const isHighSkew = xp >= 0.5;
        if (expected === 'topLeft')     return isHighIv && isHighSkew;
        if (expected === 'topRight')    return isHighIv && !isHighSkew;
        if (expected === 'bottomLeft')  return !isHighIv && isHighSkew;
        if (expected === 'bottomRight') return !isHighIv && !isHighSkew;
        return false;
      })
      .map((t) => t.symbol);
  }, [plotted, view, spec.consensusQuadrant, ivRank, skewRank]);

  // The plotted-points layout uses a square-ish quadrant. On wide
  // viewports we cap the side at 720 px so labels stay legible; on
  // narrow viewports we let it shrink to fit.
  const quadrantSide = Math.min(
    Math.max(containerWidth - 32, 320),
    720
  );

  return (
    <div ref={wrapRef} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <ScannerToolbar
        tab={tab}
        view={view}
        onTabChange={setTab}
        onViewChange={setView}
        data={data}
      />

      {data?.mode === 'seed' && (
        <div
          style={{
            background: '#3a2a1a',
            border: '1px solid #5a4220',
            color: '#e8c890',
            fontFamily: 'Courier New, monospace',
            fontSize: '0.78rem',
            padding: '0.5rem 0.75rem',
            borderRadius: '3px',
          }}
        >
          Showing illustrative seed data — Massive options snapshot unavailable
          ({data.degradeReason || 'no detail'}). Layout and axes are accurate;
          numeric values are deterministic placeholders.
        </div>
      )}

      {error && (
        <div
          style={{
            color: 'var(--accent-coral)',
            fontFamily: 'Courier New, monospace',
            padding: '1rem',
          }}
        >
          Error loading scan: {error}
        </div>
      )}

      {!data && !error && (
        <div
          style={{
            padding: '4rem 1rem',
            textAlign: 'center',
            color: 'var(--text-secondary)',
            fontFamily: 'Courier New, monospace',
            fontSize: '0.85rem',
          }}
        >
          Loading skew snapshot…
        </div>
      )}

      {data && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'flex-start',
          }}
        >
          <Quadrant
            spec={spec}
            view={view}
            side={quadrantSide}
            plotted={plotted}
            ivRank={ivRank}
            skewRank={skewRank}
            hoveredSymbol={hoveredSymbol}
            onHover={setHoveredSymbol}
            consensusResidents={consensusResidents}
          />
        </div>
      )}

      {data && (
        <ScannerLegend data={data} spec={spec} hovered={
          hoveredSymbol ? plotted.find((t) => t.symbol === hoveredSymbol) : null
        } />
      )}
    </div>
  );
}

function ScannerToolbar({ tab, view, onTabChange, onViewChange, data }) {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '1rem',
        justifyContent: 'space-between',
      }}
    >
      <div
        role="tablist"
        aria-label="View mode"
        style={{ display: 'flex', gap: '0.4rem' }}
      >
        <ToggleButton
          active={view === 'guided'}
          onClick={() => onViewChange('guided')}
        >
          Guided View
        </ToggleButton>
        <ToggleButton
          active={view === 'explorer'}
          onClick={() => onViewChange('explorer')}
        >
          Explorer View
        </ToggleButton>
      </div>

      <div
        role="tablist"
        aria-label="Skew side"
        style={{
          display: 'flex',
          gap: '0.6rem',
          fontFamily: 'Courier New, monospace',
        }}
      >
        <TabButton
          active={tab === 'put'}
          onClick={() => onTabChange('put')}
          tone="coral"
        >
          Put skew
        </TabButton>
        <TabButton
          active={tab === 'call'}
          onClick={() => onTabChange('call')}
          tone="green"
        >
          Call skew
        </TabButton>
      </div>

      <div
        style={{
          color: 'var(--text-secondary)',
          fontFamily: 'Courier New, monospace',
          fontSize: '0.78rem',
          letterSpacing: '0.04em',
        }}
      >
        {data && `${data.pricedCount}/${data.universeSize} priced · ~${data.target?.dteTarget ?? 30}D · ${formatDate(data.asOf)}`}
      </div>
    </div>
  );
}

function ToggleButton({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '0.4rem 0.75rem',
        fontFamily: 'Courier New, monospace',
        fontSize: '0.78rem',
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        background: active ? 'var(--accent-blue)' : 'transparent',
        color: active ? '#0d1016' : 'var(--accent-blue)',
        border: '1px solid var(--accent-blue)',
        borderRadius: '3px',
        cursor: 'pointer',
        fontWeight: 700,
      }}
    >
      {children}
    </button>
  );
}

function TabButton({ active, onClick, children, tone }) {
  const color = tone === 'green' ? '#04A29F' : 'var(--accent-coral)';
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '0.45rem 1.1rem',
        fontFamily: 'Courier New, monospace',
        fontSize: '1.1rem',
        fontWeight: 700,
        letterSpacing: '0.05em',
        background: 'transparent',
        color: color,
        border: active ? `2px solid ${color}` : '2px solid transparent',
        borderRadius: '4px',
        cursor: 'pointer',
        opacity: active ? 1 : 0.55,
      }}
    >
      {children}
    </button>
  );
}

function Quadrant({
  spec, view, side, plotted, ivRank, skewRank,
  hoveredSymbol, onHover, consensusResidents,
}) {
  const PADDING = 8;
  const PLOT_SIZE = side - PADDING * 2;
  const HALF = PLOT_SIZE / 2;

  // Background gradients per quadrant. Encoding: the "consensus"
  // quadrant for this tab gets the deeper teal tint, the diagonal
  // opposite (high contrast / low contrast pairing) gets a magenta-
  // coral tint, and the off-diagonals get muted.
  // For "Call skew": consensus = topLeft (mega-caps with high IV +
  // high call demand). For "Put skew": consensus = bottomRight
  // (mega-caps with compressed IV + compressed put skew).
  const quadColors = quadrantBackgrounds(spec.consensusQuadrant);

  return (
    <div
      style={{
        position: 'relative',
        width: side,
        height: side,
        flexShrink: 0,
      }}
    >
      {/* Quadrant backgrounds — four colored squares forming a 2x2
          mosaic. Drawn first so the SVG scatter sits on top. */}
      <div style={{
        position: 'absolute',
        inset: PADDING,
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gridTemplateRows: '1fr 1fr',
        gap: 1,
        background: '#0a0d12',
        borderRadius: '3px',
        overflow: 'hidden',
      }}>
        <div style={{ background: quadColors.topLeft }} />
        <div style={{ background: quadColors.topRight }} />
        <div style={{ background: quadColors.bottomLeft }} />
        <div style={{ background: quadColors.bottomRight }} />
      </div>

      {/* Cross-hair lines marking the median split. Positioned at the
          center of the inner plot rectangle. */}
      <div style={{
        position: 'absolute',
        left: PADDING,
        top: PADDING + HALF,
        width: PLOT_SIZE,
        height: 0,
        borderTop: '1px dashed rgba(160, 172, 200, 0.3)',
        pointerEvents: 'none',
      }} />
      <div style={{
        position: 'absolute',
        left: PADDING + HALF,
        top: PADDING,
        width: 0,
        height: PLOT_SIZE,
        borderLeft: '1px dashed rgba(160, 172, 200, 0.3)',
        pointerEvents: 'none',
      }} />

      {/* Guided-view annotations. Each label appears once and hugs an
          edge of the quadrant rather than crowding all four corners.
          Top edge:    "High IV"   (right-of-center, the conventional
                                    finance reading: high IV is the
                                    "stress" half of the canvas)
          Bottom edge: "Low IV"    (right-of-center, mirror of top)
          Left edge:   "High [side] skew"  (mid-Y, axis label)
          Right edge:  "Low [side] skew"   (mid-Y, axis label)
          Plus a ConsensusSticker placed inside the consensus quadrant
          listing the mega-cap residents that landed there.
          Hidden when view==='explorer' so a power user can read the
          scatter without label chrome competing for the eye. */}
      {view === 'guided' && (
        <>
          <EdgeLabel
            edge="top"
            offsetPx={PADDING + 12}
            plotPadding={PADDING}
            plotSize={PLOT_SIZE}
            text="High IV"
            color="#f0a8d6"
          />
          <EdgeLabel
            edge="bottom"
            offsetPx={PADDING + 12}
            plotPadding={PADDING}
            plotSize={PLOT_SIZE}
            text="Low IV"
            color="#9aa6c2"
          />
          <EdgeLabel
            edge="left"
            offsetPx={PADDING + 12}
            plotPadding={PADDING}
            plotSize={PLOT_SIZE}
            text={spec.leftLabel}
            color="#e8edf6"
          />
          <EdgeLabel
            edge="right"
            offsetPx={PADDING + 12}
            plotPadding={PADDING}
            plotSize={PLOT_SIZE}
            text={spec.rightLabel}
            color="#9aa6c2"
          />
          {consensusResidents.length > 0 && (
            <ConsensusSticker
              residents={consensusResidents}
              quadrant={spec.consensusQuadrant}
              padding={PADDING}
              plotSize={PLOT_SIZE}
            />
          )}
        </>
      )}

      {/* SVG scatter overlay. Positioned absolutely on top of the
          background mosaic, sized identically to the inner plot
          rectangle. */}
      <svg
        width={PLOT_SIZE}
        height={PLOT_SIZE}
        style={{
          position: 'absolute',
          left: PADDING,
          top: PADDING,
          pointerEvents: 'none',
        }}
        aria-label={`Scatter: ATM IV vs ${spec.label}`}
      >
        {plotted.map((t) => {
          const yp = ivRank(t.symbol);
          const xp = skewRank(t.symbol);
          if (yp == null || xp == null) return null;
          // Y inverted: high IV → low pixel y (top of canvas).
          // X: high skew → low pixel x (left of canvas) so the natural
          // "more skew" reading goes left, matching the screenshots.
          const cy = (1 - yp) * PLOT_SIZE;
          const cx = (1 - xp) * PLOT_SIZE;
          const isHovered = hoveredSymbol === t.symbol;
          const isMega = CONSENSUS_TICKERS.includes(t.symbol);
          const r = isHovered ? 7 : isMega ? 5 : 3.5;
          const dotColor = isHovered ? '#f0a030' : isMega ? '#4a9eff' : '#9ab2d8';
          return (
            <g key={t.symbol} style={{ pointerEvents: 'auto' }}>
              <circle
                cx={cx}
                cy={cy}
                r={r}
                fill={dotColor}
                stroke={isHovered ? '#f0a030' : 'rgba(10, 13, 18, 0.6)'}
                strokeWidth={isHovered ? 2 : 1}
                style={{ cursor: 'pointer', transition: 'r 0.12s ease' }}
                onMouseEnter={() => onHover(t.symbol)}
                onMouseLeave={() => onHover(null)}
              />
              <text
                x={cx + r + 3}
                y={cy + 4}
                fill={isHovered ? '#f3f4f6' : isMega ? '#cfdcf3' : '#7e8aa0'}
                fontFamily="Courier New, monospace"
                fontSize={isHovered ? 12 : isMega ? 11 : 10}
                fontWeight={isHovered || isMega ? 700 : 400}
                style={{ pointerEvents: 'none', userSelect: 'none' }}
              >
                {t.symbol}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function EdgeLabel({ edge, offsetPx, plotPadding, plotSize, text, color }) {
  // Edge-anchored guidance label. `edge` ∈ {top,bottom,left,right}
  // chooses which side the label rides; offsetPx pushes it inward
  // from that edge so it doesn't sit flush against the border. For
  // the top/bottom labels we anchor right-of-center to mirror the
  // reference screenshots' aesthetic (the "High IV" label hugs the
  // top-right area, not the dead-center top). For the left/right
  // labels we vertically center the text on the X-axis split line.
  const baseStyle = {
    position: 'absolute',
    pointerEvents: 'none',
    fontFamily: 'Courier New, monospace',
    fontSize: '1.05rem',
    fontWeight: 700,
    letterSpacing: '0.02em',
    color,
    textShadow: '0 1px 3px rgba(0, 0, 0, 0.95)',
    lineHeight: 1.1,
    whiteSpace: 'nowrap',
  };

  if (edge === 'top') {
    return (
      <div
        style={{
          ...baseStyle,
          left: plotPadding + plotSize * 0.62,
          top: offsetPx,
        }}
      >
        {text}
      </div>
    );
  }
  if (edge === 'bottom') {
    return (
      <div
        style={{
          ...baseStyle,
          left: plotPadding + plotSize * 0.62,
          bottom: offsetPx,
        }}
      >
        {text}
      </div>
    );
  }
  if (edge === 'left') {
    return (
      <div
        style={{
          ...baseStyle,
          left: offsetPx,
          top: plotPadding + plotSize * 0.50,
          transform: 'translateY(-50%)',
        }}
      >
        {text}
      </div>
    );
  }
  // edge === 'right'
  return (
    <div
      style={{
        ...baseStyle,
        right: offsetPx,
        top: plotPadding + plotSize * 0.50,
        transform: 'translateY(-50%)',
        textAlign: 'right',
      }}
    >
      {text}
    </div>
  );
}

function ConsensusSticker({ residents, quadrant, padding, plotSize }) {
  // Position the sticker offset slightly into the named quadrant from
  // the corner, so it doesn't overlap CornerLabel.
  const isRight = quadrant.endsWith('Right');
  const isBottom = quadrant.startsWith('bottom');
  const x = padding + (isRight ? plotSize - 16 : 16);
  const y = padding + (isBottom ? plotSize - 60 : 60);
  const transform = `translate(${isRight ? '-100%' : '0'}, ${isBottom ? '-100%' : '0'})`;
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        transform,
        pointerEvents: 'none',
        fontFamily: 'Courier New, monospace',
        fontSize: '1.0rem',
        fontWeight: 700,
        color: '#4a9eff',
        textShadow: '0 1px 2px rgba(0, 0, 0, 0.85)',
        lineHeight: 1.25,
        maxWidth: plotSize * 0.4,
      }}
    >
      {residents.join(', ')}
    </div>
  );
}

function ScannerLegend({ data, spec, hovered }) {
  return (
    <div
      className="card"
      style={{
        padding: '0.75rem 1rem',
        display: 'flex',
        flexWrap: 'wrap',
        gap: '1.25rem',
        alignItems: 'center',
        fontFamily: 'Courier New, monospace',
        fontSize: '0.82rem',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
        <span style={{
          display: 'inline-block',
          width: 10,
          height: 10,
          borderRadius: '50%',
          background: '#4a9eff',
        }} />
        <span style={{ color: 'var(--text-secondary)' }}>mega-cap reference</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
        <span style={{
          display: 'inline-block',
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: '#9ab2d8',
        }} />
        <span style={{ color: 'var(--text-secondary)' }}>universe member</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
        <span style={{
          display: 'inline-block',
          width: 12,
          height: 12,
          borderRadius: '50%',
          background: '#f0a030',
          boxShadow: '0 0 0 2px #f0a030',
        }} />
        <span style={{ color: 'var(--text-secondary)' }}>hovered</span>
      </div>

      {hovered && (
        <div
          style={{
            marginLeft: 'auto',
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'baseline',
            gap: '0.85rem',
            color: '#f3f4f6',
          }}
        >
          <strong style={{ fontSize: '0.95rem', color: '#f0a030' }}>{hovered.symbol}</strong>
          <span style={{ color: 'var(--text-secondary)' }}>{hovered.name}</span>
          <span>spot ${hovered.spot?.toFixed(2)}</span>
          <span>ATM IV {formatPct(hovered.atmIv)}</span>
          <span>
            call {formatPct(hovered.call25dIv)} ({formatVolPoints(hovered.callSkew)})
          </span>
          <span>
            put {formatPct(hovered.put25dIv)} ({formatVolPoints(hovered.putSkew)})
          </span>
          <span style={{ color: 'var(--text-secondary)' }}>
            {hovered.dte}D · {hovered.expiration}
          </span>
        </div>
      )}
    </div>
  );
}

// Per-quadrant background colors. Encoded as "the column the
// consensus quadrant lives in is the teal column; the other column
// is magenta." Top row gets the deep tint (high IV is the saturated
// half of the canvas), bottom row gets the muted tint. This produces
// mirrored palettes between the call and put tabs because their
// consensus quadrants live in opposite columns:
//
//   Call tab (consensus topLeft, tealLeft = true):
//     topLeft  = teal.deep      topRight  = magenta.deep
//     bottomLeft = teal.light   bottomRight = magenta.light
//
//   Put tab (consensus bottomRight, tealLeft = false):
//     topLeft  = magenta.deep   topRight  = teal.deep
//     bottomLeft = magenta.light bottomRight = teal.light
//
// This matches the reference screenshots' visual aesthetic: the
// "good news" / consensus-direction column is rendered in teal-green
// and the "warning" / contrarian direction in magenta-coral, with
// vertical IV intensity encoded by tint depth.
function quadrantBackgrounds(consensus) {
  const teal = {
    deep: 'linear-gradient(135deg, #1a4a47 0%, #0e2a28 100%)',
    light: 'linear-gradient(135deg, #1c2a2a 0%, #141d1d 100%)',
  };
  const magenta = {
    deep: 'linear-gradient(135deg, #4a1a3a 0%, #2a0e22 100%)',
    light: 'linear-gradient(135deg, #2a1c25 0%, #1d141a 100%)',
  };
  const tealLeft = consensus.endsWith('Left');
  return {
    topLeft:     tealLeft ? teal.deep   : magenta.deep,
    topRight:    tealLeft ? magenta.deep : teal.deep,
    bottomLeft:  tealLeft ? teal.light  : magenta.light,
    bottomRight: tealLeft ? magenta.light : teal.light,
  };
}
