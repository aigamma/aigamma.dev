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
//   Call skew tab:  X axis is call_25Δ_iv − atm_iv. High X (left side
//                   of the canvas) = right wing (call) richer than ATM,
//                   which on equity-index single names typically
//                   indicates speculative-call demand or covered-call
//                   selling pressure pulling ATM down rather than
//                   wings up.
//   Put skew tab:   X axis is put_25Δ_iv − atm_iv. High X (left side
//                   of the canvas) = left wing (put) richer than ATM —
//                   the typical equity-index resting state, with
//                   over-the-median names pricing tail-risk more
//                   aggressively than peers.
//
// All universe members render with identical dot size, color, and
// label weight. Hover is the only visual privilege; no ticker is
// hard-coded as a "consensus" anchor.

const TABS = {
  call: {
    key: 'call',
    label: 'Call skew',
    metricKey: 'callSkew',
    leftLabel: 'High call skew',
    rightLabel: 'Low call skew',
    // Anchors the 2x2 background palette: the column the consensus
    // direction lives in renders teal, the other column magenta. On
    // the call tab the consensus side is "high call skew" (left
    // column of the canvas), so tealLeft = true via this 'topLeft'
    // anchor (any *Left value works; topLeft is conventional).
    consensusQuadrant: 'topLeft',
  },
  put: {
    key: 'put',
    label: 'Put skew',
    metricKey: 'putSkew',
    leftLabel: 'High put skew',
    rightLabel: 'Low put skew',
    // On the put tab the consensus side is "low put skew" (right
    // column of the canvas, where compressed equity put-skew names
    // tend to land), so tealLeft = false via this 'bottomRight'
    // anchor.
    consensusQuadrant: 'bottomRight',
  },
};

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

  // Top-10-by-options-volume membership for bold-label highlighting.
  // The roster JSON is already sorted desc by options volume, but the
  // /api/scan response can drop tickers (thin chains, snapshot errors)
  // so we re-derive the top 10 from the actual response payload rather
  // than trusting position. The top 10 universally include the most-
  // traded names — TSLA, NVDA, AAPL, MSFT, INTC, AMD, AMZN, etc. — and
  // bolding them lets the eye find them faster without any visual
  // privilege beyond label weight (no special dot, no special color).
  const topTenSymbols = useMemo(() => {
    if (!data?.tickers) return new Set();
    const ranked = [...data.tickers]
      .filter((t) => Number.isFinite(t.optionsVolume))
      .sort((a, b) => b.optionsVolume - a.optionsVolume)
      .slice(0, 10)
      .map((t) => t.symbol);
    return new Set(ranked);
  }, [data]);

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
        onTabChange={setTab}
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
            side={quadrantSide}
            plotted={plotted}
            ivRank={ivRank}
            skewRank={skewRank}
            topTenSymbols={topTenSymbols}
            hoveredSymbol={hoveredSymbol}
            onHover={setHoveredSymbol}
          />
        </div>
      )}

      {data && <ScannerLegend />}
    </div>
  );
}

function ScannerToolbar({ tab, onTabChange, data }) {
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
        {data && `${data.pricedCount}/${data.universeSize} priced · ~${data.target?.dteTarget ?? 30}D · ${formatDate(data.sessionDate ?? data.asOf)}`}
      </div>
    </div>
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
  spec, side, plotted, ivRank, skewRank,
  topTenSymbols, hoveredSymbol, onHover,
}) {
  const PADDING = 8;
  const PLOT_SIZE = side - PADDING * 2;
  const HALF = PLOT_SIZE / 2;

  // Background gradient palette per tab. See quadrantBackgrounds for
  // the column/row encoding rules.
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

      {/* Edge-anchored axis annotations. Always rendered. Each label
          appears once and hugs an edge of the quadrant. Top/bottom
          name the IV pole; left/right name the skew pole.
            Top edge:    "High IV"   (right-of-center)
            Bottom edge: "Low IV"    (right-of-center)
            Left edge:   "High [side] skew"  (mid-Y)
            Right edge:  "Low [side] skew"   (mid-Y) */}
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
          // "more skew" reading goes left, matching the screenshot
          // convention.
          const cy = (1 - yp) * PLOT_SIZE;
          const cx = (1 - xp) * PLOT_SIZE;
          const isHovered = hoveredSymbol === t.symbol;
          const isTopTen = topTenSymbols.has(t.symbol);
          // All dots are the same size and color — only the LABEL
          // weight communicates options-volume rank. Hover gets the
          // amber accent treatment as the only privileged visual.
          const r = isHovered ? 7 : 3.5;
          const dotColor = isHovered ? '#f0a030' : '#9ab2d8';
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
                x={cx + r + 4}
                y={cy + 5}
                fill={isHovered ? '#f3f4f6' : isTopTen ? '#e1e8f4' : '#9aa6c2'}
                fontFamily="Courier New, monospace"
                fontSize={isHovered ? 16 : isTopTen ? 14 : 13}
                fontWeight={isHovered || isTopTen ? 700 : 400}
                style={{ pointerEvents: 'none', userSelect: 'none' }}
              >
                {t.symbol}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Floating tooltip near the hovered dot. Rendered as a sibling
          div positioned absolutely within the Quadrant container so
          it doesn't depend on cursor coordinates — the anchor is the
          dot itself, not the mouse. Position-flips horizontally if
          the dot is in the right half (so the tooltip opens leftward
          instead of clipping the canvas) and vertically if the dot is
          near the top (so the tooltip opens downward). */}
      {(() => {
        if (!hoveredSymbol) return null;
        const t = plotted.find((p) => p.symbol === hoveredSymbol);
        if (!t) return null;
        const yp = ivRank(t.symbol);
        const xp = skewRank(t.symbol);
        if (yp == null || xp == null) return null;
        const cx = (1 - xp) * PLOT_SIZE;
        const cy = (1 - yp) * PLOT_SIZE;
        const openLeft = cx > PLOT_SIZE * 0.55;
        const openDown = cy < PLOT_SIZE * 0.30;
        const offset = 14;
        const style = {
          position: 'absolute',
          zIndex: 5,
          pointerEvents: 'none',
          background: 'rgba(8, 11, 16, 0.96)',
          border: '1px solid rgba(160, 172, 200, 0.35)',
          borderRadius: '4px',
          padding: '0.55rem 0.75rem',
          fontFamily: 'Courier New, monospace',
          fontSize: '0.78rem',
          color: '#e1e8f4',
          minWidth: 200,
          maxWidth: 260,
          lineHeight: 1.45,
          boxShadow: '0 2px 12px rgba(0, 0, 0, 0.6)',
        };
        if (openLeft) {
          style.right = (PLOT_SIZE - cx + offset) + PADDING;
        } else {
          style.left = cx + offset + PADDING;
        }
        if (openDown) {
          style.top = cy + offset + PADDING;
        } else {
          style.bottom = (PLOT_SIZE - cy + offset) + PADDING;
        }
        return <Tooltip ticker={t} style={style} />;
      })()}
    </div>
  );
}

function Tooltip({ ticker: t, style }) {
  return (
    <div style={style}>
      <div style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: '0.5rem',
        marginBottom: '0.35rem',
      }}>
        <strong style={{ fontSize: '0.95rem', color: '#f0a030' }}>{t.symbol}</strong>
        <span style={{
          color: pctChangeColor(t.pctChange),
          fontWeight: 700,
        }}>
          {formatSignedPct(t.pctChange)}
        </span>
      </div>
      <div style={{
        color: 'var(--text-secondary)',
        fontSize: '0.74rem',
        marginBottom: '0.45rem',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}>
        {t.name}
      </div>
      <TooltipRow label="Spot" value={t.spot != null ? `$${t.spot.toFixed(2)}` : '—'} />
      <TooltipRow label="Prev close" value={t.prevClose != null ? `$${t.prevClose.toFixed(2)}` : '—'} />
      <TooltipRow label="ATM IV" value={formatPct(t.atmIv)} />
      <TooltipRow
        label="IV Rank"
        value="—"
        subtle
        note="pending backfill"
      />
      <TooltipRow label="25Δ call" value={`${formatPct(t.call25dIv)} (${formatVolPoints(t.callSkew)})`} />
      <TooltipRow label="25Δ put"  value={`${formatPct(t.put25dIv)} (${formatVolPoints(t.putSkew)})`} />
      <TooltipRow label="Tenor" value={`${t.dte}D · ${t.expiration}`} subtle />
    </div>
  );
}

function TooltipRow({ label, value, subtle, note }) {
  return (
    <div style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'baseline',
      gap: '0.6rem',
      color: subtle ? 'var(--text-secondary)' : '#e1e8f4',
    }}>
      <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <span style={{ textAlign: 'right' }}>
        {value}
        {note && (
          <span style={{
            color: '#7e8aa0',
            fontSize: '0.7rem',
            marginLeft: '0.4rem',
            fontStyle: 'italic',
          }}>
            {note}
          </span>
        )}
      </span>
    </div>
  );
}

function formatSignedPct(p) {
  if (p == null || !Number.isFinite(p)) return '—';
  const sign = p > 0 ? '+' : '';
  return `${sign}${p.toFixed(2)}%`;
}

function pctChangeColor(p) {
  if (p == null || !Number.isFinite(p)) return 'var(--text-secondary)';
  if (p > 0) return '#3ec57e';
  if (p < 0) return 'var(--accent-coral)';
  return 'var(--text-secondary)';
}

function EdgeLabel({ edge, offsetPx, plotPadding, plotSize, text, color }) {
  // Edge-anchored axis label. All four labels are centered on the
  // median split line of their respective axis: top/bottom on the
  // vertical X=50% center, left/right on the horizontal Y=50% center.
  // The black-box backing gives each label legible contrast against
  // the gradient quadrant fill underneath, regardless of whether the
  // label happens to land on the deeper-tinted half or the muted half.
  //
  // Stock SVG text wins on collision: the SVG element renders AFTER
  // these EdgeLabel divs in the Quadrant component's DOM order, so
  // SVG text natively stacks on top per the standard CSS painting
  // order (later-in-DOM = drawn-later = on-top within the same
  // stacking context). A stock label that lands on top of an axis
  // label simply punches through visually — the user sees the ticker
  // and infers the axis label from position context.
  const baseStyle = {
    position: 'absolute',
    pointerEvents: 'none',
    fontFamily: 'Courier New, monospace',
    fontSize: '1.0rem',
    fontWeight: 700,
    letterSpacing: '0.02em',
    color,
    background: 'rgba(0, 0, 0, 0.78)',
    padding: '3px 8px',
    borderRadius: '3px',
    lineHeight: 1.15,
    whiteSpace: 'nowrap',
  };

  if (edge === 'top') {
    return (
      <div
        style={{
          ...baseStyle,
          left: plotPadding + plotSize * 0.50,
          top: offsetPx,
          transform: 'translateX(-50%)',
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
          left: plotPadding + plotSize * 0.50,
          bottom: offsetPx,
          transform: 'translateX(-50%)',
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
      }}
    >
      {text}
    </div>
  );
}

function ScannerLegend() {
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
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: '#9ab2d8',
        }} />
        <span style={{ color: 'var(--text-secondary)' }}>universe member</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
        <span
          style={{
            color: '#e1e8f4',
            fontWeight: 700,
            fontFamily: 'Courier New, monospace',
            fontSize: '0.95rem',
          }}
        >
          BOLD
        </span>
        <span style={{ color: 'var(--text-secondary)' }}>top 10 by options volume</span>
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

      <div style={{
        marginLeft: 'auto',
        color: 'var(--text-secondary)',
        fontSize: '0.78rem',
      }}>
        Hover any dot for the ticker profile.
      </div>
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
