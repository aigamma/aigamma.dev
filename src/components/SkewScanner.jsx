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

// Outside-label layout. The Quadrant container expands by
// HORIZONTAL_GUTTER on each side and VERTICAL_GUTTER on top/bottom
// so the four axis labels (High IV, Low IV, leftLabel, rightLabel)
// can render in dedicated gutter space rather than overlaying dots
// near the chart edges. The 160 px horizontal gutter is sized to the
// widest side label ("High call skew" ≈ 134 px in 1rem Courier +
// 16 px label padding + 8 px breathing gap from the chart border).
// Outside placement only kicks in once the host container is wide
// enough to absorb 320 px of gutter without compressing the chart
// below ~320 px; on narrower viewports the labels fall back to the
// original inside placement.
const HORIZONTAL_GUTTER = 160;
const VERTICAL_GUTTER = 36;
const OUTSIDE_LABELS_MIN_CONTAINER = 640;

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

// Compact daily-options-volume formatter for the tooltip "Options vol"
// row. The roster JSON's optionsVolume field is contracts/day from the
// Barchart screener (e.g., NVDA = 6,755,450), which displays cleanly as
// "6.76M". For smaller-volume names we fall back to "780K" / raw
// integer to keep the row width predictable.
function formatOptionsVolume(v) {
  if (!Number.isFinite(v)) return '—';
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
  return String(Math.round(v));
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
  // Earnings filter mode. Three positions:
  //   'all'  → show every ticker, with an amber pill behind the
  //            symbol labels of names reporting inside the lookahead
  //            window.
  //   'hide' → hide tickers with confirmed earnings inside the
  //            lookahead window. Useful when a vol trader wants to
  //            read pure regime-driven IV/skew without the overlay
  //            of single-name event-vol distortion.
  //   'only' → keep only tickers with confirmed earnings inside the
  //            lookahead window. Useful for scanning the names whose
  //            event vol is currently the dominant signal (the
  //            quadrant becomes a pre-earnings positioning map).
  // The lookahead window itself is owned by the server (default 14
  // days); the response payload exposes earningsLookaheadDays so the
  // toggle copy stays consistent with the data window.
  const [earningsFilter, setEarningsFilter] = useState('all');
  // Anchor filter mode. Two values:
  //   'all'    → no anchor filter applied (default).
  //   'only'   → keep only tickers tagged anchor=true in the roster
  //              (top-50 OV ∩ SP500 names by joint-rank harmonic
  //              mean — see scripts/backfill/options-volume-roster.mjs).
  // The roster currently sizes the global anchor list at 50 names; the
  // /scan universe is top-N by options volume (default 40), so the
  // intersection between "in the universe" and "anchor=true" is at
  // most ~20-30 tickers in a typical render. The toggle disables
  // itself when the response payload reports anchorCount === 0
  // (graceful degradation for the unlikely case where SP500
  // enrichment is missing on the server side).
  const [anchorFilter, setAnchorFilter] = useState('all');
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

  // Filter to tickers with valid IV + the relevant skew metric, then
  // apply the earnings filter mode. Tickers that priced for one tab
  // but not the other (rare but possible — e.g., the call wing strike
  // was missing) simply drop from the tab where their datum is null.
  // The earnings filter is applied AFTER the IV/skew finite filter so
  // that "Only" mode shows only earnings-reporting tickers that ALSO
  // have valid IV/skew (a confirmed-but-unpriceable ticker drops from
  // the chart entirely on either tab regardless of the filter).
  const plotted = useMemo(() => {
    if (!data?.tickers) return [];
    let working = data.tickers.filter(
      (t) => Number.isFinite(t.atmIv) && Number.isFinite(t[spec.metricKey])
    );
    // Apply earnings filter first (since it's the longer-standing
    // toggle a returning reader is most likely to have set), then
    // anchor filter. Order doesn't change the result — both are
    // conjunctive predicates — but it keeps the working-set size
    // monotonically shrinking through the chain which is easier to
    // reason about during debugging.
    if (earningsFilter === 'hide') working = working.filter((t) => !t.earningsDate);
    else if (earningsFilter === 'only') working = working.filter((t) => !!t.earningsDate);
    if (anchorFilter === 'only') working = working.filter((t) => t.anchor === true);
    return working;
  }, [data, spec.metricKey, earningsFilter, anchorFilter]);

  // Count of plotted tickers that carry an upcoming earnings warning,
  // used to drive the meta-line summary line below the quadrant.
  const earningsPlottedCount = useMemo(
    () => plotted.filter((t) => !!t.earningsDate).length,
    [plotted],
  );

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

  // Universe-wide options-volume ranks for the tooltip "Options vol"
  // row. The Map maps each symbol to { rank, total } — the 1-based
  // rank in the priced universe and the total count, so the tooltip
  // can render "3.68M/day · #2 of 40" and a vol trader can immediately
  // tell whether they're looking at one of the most-traded names or a
  // mid-pack member. Total is the count of names with finite
  // optionsVolume in the response (typically equal to data.tickers.length).
  const optionsVolumeRanks = useMemo(() => {
    const map = new Map();
    if (!data?.tickers) return map;
    const ranked = [...data.tickers]
      .filter((t) => Number.isFinite(t.optionsVolume))
      .sort((a, b) => b.optionsVolume - a.optionsVolume);
    const total = ranked.length;
    ranked.forEach((t, i) => map.set(t.symbol, { rank: i + 1, total }));
    return map;
  }, [data]);

  // The plotted-points layout uses a square-ish quadrant. On wide
  // viewports we cap the side at 720 px so labels stay legible; on
  // narrow viewports we let it shrink to fit. When outside labels
  // are in play the available width has to also absorb the
  // 2 × HORIZONTAL_GUTTER side-label gutter, so the chart shrinks
  // accordingly with a hard floor of 320 px.
  const useOutsideLabels = containerWidth >= OUTSIDE_LABELS_MIN_CONTAINER;
  const xGutter = useOutsideLabels ? HORIZONTAL_GUTTER : 0;
  const quadrantSide = Math.min(
    Math.max(containerWidth - 32 - 2 * xGutter, 320),
    720
  );

  return (
    <div ref={wrapRef} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <ScannerToolbar
        tab={tab}
        onTabChange={setTab}
        earningsFilter={earningsFilter}
        onEarningsFilterChange={setEarningsFilter}
        anchorFilter={anchorFilter}
        onAnchorFilterChange={setAnchorFilter}
        anchorCount={data?.anchorCount ?? 0}
        lookaheadDays={data?.earningsLookaheadDays ?? 14}
        earningsAvailable={(data?.earningsCount ?? 0) > 0}
      />

      {data?.mode === 'seed' && (
        <div
          style={{
            background: '#3a2a1a',
            border: '1px solid #5a4220',
            color: '#e8c890',
            fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
            fontSize: '0.78rem',
            padding: '0.5rem 0.75rem',
            borderRadius: '3px',
          }}
        >
          Showing illustrative seed data. Massive options snapshot unavailable
          ({data.degradeReason || 'no detail'}). Layout and axes are accurate;
          numeric values are deterministic placeholders.
        </div>
      )}

      {error && (
        <div
          style={{
            color: 'var(--accent-coral)',
            fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
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
            fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
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
            outsideLabels={useOutsideLabels}
            plotted={plotted}
            ivRank={ivRank}
            skewRank={skewRank}
            topTenSymbols={topTenSymbols}
            optionsVolumeRanks={optionsVolumeRanks}
            hoveredSymbol={hoveredSymbol}
            onHover={setHoveredSymbol}
          />
        </div>
      )}

      {data && (
        <div
          style={{
            textAlign: 'center',
            color: 'var(--text-secondary)',
            fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
            fontSize: '0.78rem',
            letterSpacing: '0.04em',
          }}
        >
          {(() => {
            const base = `${data.pricedCount}/${data.universeSize} priced · ~${data.target?.dteTarget ?? 30}D · ${formatDate(data.sessionDate ?? data.asOf)}`;
            // Surface the earnings count whenever the filter is active OR
            // the universe contains any earnings names (so a reader
            // notices the indicator exists even before they touch the
            // toggle). The filter-active variants tell the reader how
            // many of the dots they're looking at are actually visible.
            const window = data.earningsLookaheadDays ?? 14;
            if (earningsFilter === 'hide') {
              return `${base} · ${plotted.length} of ${data.pricedCount} shown (hiding ≤${window}d earnings)`;
            }
            if (earningsFilter === 'only') {
              return `${base} · showing ${plotted.length} pre-earnings (≤${window}d)`;
            }
            if (earningsPlottedCount > 0) {
              return `${base} · ${earningsPlottedCount} with earnings ≤${window}d`;
            }
            return base;
          })()}
        </div>
      )}

      {data && <ScannerLegend />}
    </div>
  );
}

function ScannerToolbar({
  tab, onTabChange, earningsFilter, onEarningsFilterChange,
  lookaheadDays, earningsAvailable,
  anchorFilter, onAnchorFilterChange, anchorCount,
}) {
  // Two-row layout: the call/put skew tab toggle stays the visual
  // anchor on top, and the earnings-filter row sits below it as a
  // subordinate control. Both rows are centered. The earnings row
  // disables itself when the response payload reports zero
  // upcoming-earnings names — a graceful degradation for slow
  // earnings periods or for the case where EW was unreachable at
  // /scan render time (caller passes earningsAvailable=false).
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '0.55rem',
      }}
    >
      <div
        role="tablist"
        aria-label="Skew side"
        style={{
          display: 'inline-flex',
          alignItems: 'stretch',
          border: '2px solid #e8edf6',
          borderRadius: '4px',
          overflow: 'hidden',
          fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
        }}
      >
        <TabButton
          active={tab === 'put'}
          onClick={() => onTabChange('put')}
          tone="coral"
        >
          Put skew
        </TabButton>
        <div
          aria-hidden="true"
          style={{ width: 1, background: 'rgba(232, 237, 246, 0.4)' }}
        />
        <TabButton
          active={tab === 'call'}
          onClick={() => onTabChange('call')}
          tone="green"
        >
          Call skew
        </TabButton>
      </div>

      <EarningsFilterToggle
        mode={earningsFilter}
        onChange={onEarningsFilterChange}
        lookaheadDays={lookaheadDays}
        disabled={!earningsAvailable}
      />

      <AnchorFilterToggle
        mode={anchorFilter}
        onChange={onAnchorFilterChange}
        anchorCount={anchorCount}
        disabled={anchorCount === 0}
      />
    </div>
  );
}

// Two-position pill toggle for the Anchor 50 filter. Mirrors the
// EarningsFilterToggle chrome (segmented buttons in a single bordered
// container, active state reverses to filled-background dark-text)
// but uses an accent-blue tonal anchor instead of amber so the two
// toggles read as distinct controls at a glance. "All" shows every
// priced ticker in the universe; "Anchor only" filters to the top-50
// OV ∩ SP500 names tagged anchor=true by the roster generator.
// Empty-anchorCount disables the toggle (graceful degradation if the
// SP500 enrichment is missing server-side); the count of in-universe
// anchors renders inline as a hint so the reader knows what fraction
// of the chart "Anchor only" mode would surface.
function AnchorFilterToggle({ mode, onChange, anchorCount, disabled }) {
  const options = [
    { id: 'all',  label: 'All' },
    { id: 'only', label: 'Anchor only' },
  ];
  return (
    <div
      role="group"
      aria-label="Anchor 50 filter"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.55rem',
        opacity: disabled ? 0.55 : 1,
      }}
    >
      <span
        style={{
          fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
          fontSize: '0.78rem',
          letterSpacing: '0.04em',
          color: 'var(--text-secondary)',
        }}
      >
        Universe ({anchorCount} anchored):
      </span>
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'stretch',
          border: '1px solid var(--accent-blue, #4a9eff)',
          borderRadius: '3px',
          overflow: 'hidden',
          fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
          fontSize: '0.75rem',
          letterSpacing: '0.06em',
        }}
      >
        {options.map((opt, i) => {
          const active = mode === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => !disabled && onChange(opt.id)}
              disabled={disabled}
              aria-pressed={active}
              style={{
                appearance: 'none',
                background: active ? 'var(--accent-blue, #4a9eff)' : 'transparent',
                color: active ? '#0d1016' : 'var(--accent-blue, #4a9eff)',
                border: 'none',
                borderRight: i < options.length - 1 ? '1px solid rgba(74, 158, 255, 0.4)' : 'none',
                padding: '0.32rem 0.7rem',
                cursor: disabled ? 'not-allowed' : 'pointer',
                textTransform: 'uppercase',
                fontWeight: active ? 700 : 400,
                fontFamily: 'inherit',
                fontSize: 'inherit',
                letterSpacing: 'inherit',
              }}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Three-position pill toggle for the upcoming-earnings filter. The
// chrome borrows from the .rotation-step-toggle pattern used on the
// Lab pages: a thin amber outline framing three segmented buttons,
// active button reverses to a filled amber background with dark
// text. Amber is the right tonal anchor here because the warning
// pills behind earnings tickers on the chart are the same amber —
// the toggle visually previews what a filter mode does to the
// chart's amber indicators. When `disabled` is true the toggle
// dims and stops responding, which surfaces the EW outage / empty
// universe state without removing the control from the layout
// (so the reader can see the feature exists, just temporarily
// unavailable).
function EarningsFilterToggle({ mode, onChange, lookaheadDays, disabled }) {
  const options = [
    { id: 'all',  label: 'Show all' },
    { id: 'hide', label: 'Hide' },
    { id: 'only', label: 'Only' },
  ];
  return (
    <div
      role="group"
      aria-label="Upcoming-earnings filter"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.55rem',
        opacity: disabled ? 0.55 : 1,
      }}
    >
      <span
        style={{
          fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
          fontSize: '0.78rem',
          letterSpacing: '0.04em',
          color: 'var(--text-secondary)',
        }}
      >
        Earnings ≤{lookaheadDays}d:
      </span>
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'stretch',
          border: '1px solid var(--accent-amber, #f0a030)',
          borderRadius: '3px',
          overflow: 'hidden',
          fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
          fontSize: '0.75rem',
          letterSpacing: '0.06em',
        }}
      >
        {options.map((opt, i) => {
          const active = mode === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => !disabled && onChange(opt.id)}
              disabled={disabled}
              aria-pressed={active}
              style={{
                appearance: 'none',
                background: active ? 'var(--accent-amber, #f0a030)' : 'transparent',
                color: active ? '#0d1016' : 'var(--accent-amber, #f0a030)',
                border: 'none',
                borderRight: i < options.length - 1 ? '1px solid rgba(240, 160, 48, 0.4)' : 'none',
                padding: '0.32rem 0.7rem',
                cursor: disabled ? 'not-allowed' : 'pointer',
                textTransform: 'uppercase',
                fontWeight: active ? 700 : 400,
                fontFamily: 'inherit',
                fontSize: 'inherit',
                letterSpacing: 'inherit',
              }}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children, tone }) {
  const color = tone === 'green' ? '#04A29F' : 'var(--accent-coral)';
  const tintBg = tone === 'green' ? 'rgba(4, 162, 159, 0.18)' : 'rgba(216, 90, 48, 0.18)';
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '0.45rem 1.1rem',
        fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
        fontSize: '1.1rem',
        fontWeight: 700,
        letterSpacing: '0.05em',
        background: active ? tintBg : 'transparent',
        color: color,
        border: 'none',
        cursor: 'pointer',
        opacity: active ? 1 : 0.55,
      }}
    >
      {children}
    </button>
  );
}

function Quadrant({
  spec, side, outsideLabels, plotted, ivRank, skewRank,
  topTenSymbols, optionsVolumeRanks, hoveredSymbol, onHover,
}) {
  const PADDING = 8;
  const PLOT_SIZE = side - PADDING * 2;
  const HALF = PLOT_SIZE / 2;

  // Outside-label gutter. When the host viewport is wide enough, the
  // Quadrant container expands by HORIZONTAL_GUTTER × VERTICAL_GUTTER
  // so the four axis labels render in dedicated space outside the
  // chart's plotted area rather than overlaying dots near the chart
  // edges. On narrow viewports the gutters collapse to zero and the
  // container, the chart, and the inner plot rectangle all stack at
  // the original side × side / PLOT_SIZE × PLOT_SIZE geometry, with
  // labels falling back to the original inside placement.
  const xGutter = outsideLabels ? HORIZONTAL_GUTTER : 0;
  const yGutter = outsideLabels ? VERTICAL_GUTTER : 0;
  const totalWidth = side + 2 * xGutter;
  const totalHeight = side + 2 * yGutter;
  const chartLeft = xGutter;
  const chartTop = yGutter;
  const plotLeft = chartLeft + PADDING;
  const plotTop = chartTop + PADDING;

  // Background gradient palette per tab. See quadrantBackgrounds for
  // the column/row encoding rules.
  const quadColors = quadrantBackgrounds(spec.consensusQuadrant);

  return (
    <div
      style={{
        position: 'relative',
        width: totalWidth,
        height: totalHeight,
        flexShrink: 0,
      }}
    >
      {/* Quadrant backgrounds — four colored squares forming a 2x2
          mosaic. Drawn first so the SVG scatter sits on top. */}
      <div style={{
        position: 'absolute',
        left: plotLeft,
        top: plotTop,
        width: PLOT_SIZE,
        height: PLOT_SIZE,
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
        left: plotLeft,
        top: plotTop + HALF,
        width: PLOT_SIZE,
        height: 0,
        borderTop: '1px dashed rgba(160, 172, 200, 0.3)',
        pointerEvents: 'none',
      }} />
      <div style={{
        position: 'absolute',
        left: plotLeft + HALF,
        top: plotTop,
        width: 0,
        height: PLOT_SIZE,
        borderLeft: '1px dashed rgba(160, 172, 200, 0.3)',
        pointerEvents: 'none',
      }} />

      {/* Edge-anchored axis annotations. Always rendered. Each label
          appears once and hugs an edge of the quadrant. Top/bottom
          name the IV pole; left/right name the skew pole. When
          outsideLabels is true the labels render in the gutter
          beyond the chart border; otherwise they render inside the
          plot area near each edge.
            Top edge:    "High IV"  (centered above)
            Bottom edge: "Low IV"   (centered below)
            Left edge:   "High [side] skew"  (mid-Y, just left of chart)
            Right edge:  "Low [side] skew"   (mid-Y, just right of chart) */}
      <EdgeLabel
        edge="top"
        outside={outsideLabels}
        chartLeft={chartLeft}
        chartTop={chartTop}
        chartSize={side}
        plotPadding={PADDING}
        plotSize={PLOT_SIZE}
        text="High IV"
        color="#f0a8d6"
      />
      <EdgeLabel
        edge="bottom"
        outside={outsideLabels}
        chartLeft={chartLeft}
        chartTop={chartTop}
        chartSize={side}
        plotPadding={PADDING}
        plotSize={PLOT_SIZE}
        text="Low IV"
        color="#2cd5cf"
      />
      <EdgeLabel
        edge="left"
        outside={outsideLabels}
        chartLeft={chartLeft}
        chartTop={chartTop}
        chartSize={side}
        plotPadding={PADDING}
        plotSize={PLOT_SIZE}
        text={spec.leftLabel}
        color="#e8edf6"
      />
      <EdgeLabel
        edge="right"
        outside={outsideLabels}
        chartLeft={chartLeft}
        chartTop={chartTop}
        chartSize={side}
        plotPadding={PADDING}
        plotSize={PLOT_SIZE}
        text={spec.rightLabel}
        color="#e8edf6"
      />

      {/* SVG scatter overlay. Positioned absolutely on top of the
          background mosaic, sized identically to the inner plot
          rectangle. */}
      <svg
        width={PLOT_SIZE}
        height={PLOT_SIZE}
        style={{
          position: 'absolute',
          left: plotLeft,
          top: plotTop,
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
          // hasEarnings flips on whenever the server attached an
          // earningsDate to this ticker — i.e., the ticker has a
          // confirmed EW-listed earnings release inside the
          // server-side EARNINGS_LOOKAHEAD_DAYS window. The flag
          // drives THREE visual changes downstream: an amber pill
          // behind the symbol label (rendered as an SVG <rect>
          // before the <text>), a dark-on-amber text fill in place
          // of the default gray, and a forced bold weight so the
          // label reads at every dot size. The dot itself stays the
          // standard color/style — putting the warning on the label
          // (the most-readable element) keeps the dot's positional
          // meaning clean and avoids muddying the hover treatment.
          const hasEarnings = !!t.earningsDate;
          // All dots are the same size and color — only the LABEL
          // weight communicates options-volume rank. Hover gets the
          // amber accent treatment as the only privileged visual.
          const r = isHovered ? 7 : 3.5;
          const dotColor = isHovered ? '#f0a030' : '#9ab2d8';
          const fontSize = isHovered ? 16 : isTopTen ? 14 : 13;
          // Right-edge overflow guard. Default placement is to the
          // RIGHT of the dot (cx + r + 4, text-anchor=start). For dots
          // near the right edge of the canvas the rightward label
          // would extend past PLOT_SIZE and either clip at the SVG
          // boundary or paint into adjacent page chrome. Estimate the
          // rendered text width using a 0.6 em per glyph approximation
          // — slightly conservative for the platform's Calibri-style
          // sans (Calibri averages ~0.5-0.55 em for short uppercase
          // ticker glyphs), which means the flip-to-left triggers a
          // touch sooner than strictly necessary; the conservatism is
          // benign because the leftward fallback always fits and the
          // flip happens silently with no visual marker. All symbols
          // are 3-5 chars so the worst-case overestimate is < 5 px.
          const charWidthPx = fontSize * 0.6;
          const labelWidthPx = t.symbol.length * charWidthPx;
          const overflowsRight = (cx + r + 4 + labelWidthPx) > PLOT_SIZE;
          const labelX = overflowsRight ? (cx - r - 4) : (cx + r + 4);
          const labelAnchor = overflowsRight ? 'end' : 'start';
          // Hit-target rect that envelops both the visible dot and the
          // ticker label. Earlier the only hit target was the 3.5 px
          // (idle) / 7 px (hovered) circle itself — a 7 px-diameter
          // bullseye that's easy to miss with a mouse and impossible
          // to land on a touchscreen. The transparent rect spans from
          // the leftmost shape (dot or label, depending on the
          // overflow flip) to the rightmost shape, with a small
          // 2 px padding, and uses pointer-events="all" so it catches
          // hovers on its empty area while the visible dot and text
          // beneath stay non-interactive (pointer-events="none") so
          // they don't fight for the cursor. The rect is rendered
          // FIRST so it's beneath the dot+text in z-order, but
          // pointer-events="all" forces hit-testing through the
          // visible layers — hovering anywhere over the symbol
          // cluster (label glyphs, the gap between dot and label, or
          // the dot itself) shows the tooltip.
          const dotLeft = cx - r;
          const dotRight = cx + r;
          const labelLeft = overflowsRight ? labelX - labelWidthPx : labelX;
          const labelRight = overflowsRight ? labelX : labelX + labelWidthPx;
          const hitX = Math.min(dotLeft, labelLeft) - 2;
          const hitW = Math.max(dotRight, labelRight) + 2 - hitX;
          const dotTop = cy - r;
          const dotBot = cy + r;
          const labelTop = cy + 5 - fontSize;
          const labelBot = cy + 5;
          const hitY = Math.min(dotTop, labelTop) - 2;
          const hitH = Math.max(dotBot, labelBot) + 2 - hitY;
          return (
            <g
              key={t.symbol}
              style={{ pointerEvents: 'auto', cursor: 'pointer' }}
              onMouseEnter={() => onHover(t.symbol)}
              onMouseLeave={() => onHover(null)}
            >
              <rect
                x={hitX}
                y={hitY}
                width={hitW}
                height={hitH}
                fill="transparent"
                style={{ pointerEvents: 'all' }}
              />
              <circle
                cx={cx}
                cy={cy}
                r={r}
                fill={dotColor}
                stroke={isHovered ? '#f0a030' : 'rgba(10, 13, 18, 0.6)'}
                strokeWidth={isHovered ? 2 : 1}
                style={{ pointerEvents: 'none', transition: 'r 0.12s ease' }}
              />
              {hasEarnings && (
                // Amber warning pill behind the symbol label. Dimensions
                // are derived from the same labelWidthPx and fontSize
                // estimates the hit-rect uses, so the pill always
                // hugs the rendered text regardless of label length
                // or the right-edge overflow flip. The +2 horizontal
                // padding on each side gives the dark text a small
                // safe area off the pill edges; the -1 vertical inset
                // on top and +2 on the bottom centers the pill on
                // the Calibri-style baseline (Calibri's glyph ascent
                // rises ~0.75 × fontSize above baseline and the
                // descent drops ~0.21 × fontSize below — close enough
                // to Courier New's geometry that the inset numbers
                // didn't need re-tuning when the platform font swap
                // landed). 2 px corner radius matches
                // the .rotation-step-toggle__btn pill chrome used
                // elsewhere on the site so the warning indicator
                // reads as native UI rather than a pasted-on
                // ornament.
                <rect
                  x={(overflowsRight ? labelX - labelWidthPx : labelX) - 2}
                  y={cy + 5 - fontSize - 1}
                  width={labelWidthPx + 4}
                  height={fontSize + 3}
                  fill="#f0a030"
                  rx={2}
                  ry={2}
                  style={{ pointerEvents: 'none' }}
                />
              )}
              <text
                x={labelX}
                y={cy + 5}
                textAnchor={labelAnchor}
                // When the earnings pill is rendered, force a dark
                // fill so the symbol stays legible against the amber
                // background regardless of hover state — the pill is
                // a persistent warning indicator and shouldn't disappear
                // visually when the ticker is also hovered. When no
                // pill is rendered, fall back to the original 3-tier
                // hierarchy: hovered (white), top-10 (off-white),
                // everything else (muted blue).
                fill={hasEarnings
                  ? '#0d1016'
                  : (isHovered ? '#f3f4f6' : isTopTen ? '#e1e8f4' : '#9aa6c2')}
                fontFamily="Calibri, 'Segoe UI', system-ui, sans-serif"
                fontSize={fontSize}
                fontWeight={hasEarnings || isHovered || isTopTen ? 700 : 400}
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
          fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
          fontSize: '0.78rem',
          color: '#e1e8f4',
          minWidth: 220,
          maxWidth: 280,
          lineHeight: 1.45,
          boxShadow: '0 2px 12px rgba(0, 0, 0, 0.6)',
        };
        if (openLeft) {
          style.right = (PLOT_SIZE - cx + offset) + plotLeft;
        } else {
          style.left = cx + offset + plotLeft;
        }
        if (openDown) {
          style.top = cy + offset + plotTop;
        } else {
          style.bottom = (PLOT_SIZE - cy + offset) + plotTop;
        }
        // Derive the quadrant-interpretation label using the same
        // percentile-rank math the canvas uses to position the dot, so
        // the tooltip's "Position" row stays in sync with where the
        // viewer sees the dot land. The IV pole flips at the median
        // (yp ≥ 0.5 → top half → "High IV"); the skew pole uses the
        // tab-specific edge label so call-tab dots read "High call
        // skew" / "Low call skew" and put-tab dots read "High put skew"
        // / "Low put skew", matching the chart's edge annotations
        // exactly. Median ties (yp/xp == 0.5) round to the high pole;
        // the visual representation of an exactly-median dot sitting
        // on the cross-hair is rare enough that the side-of-fence
        // assignment doesn't matter in practice.
        const ivHigh = yp >= 0.5;
        const skewHigh = xp >= 0.5;
        const quadrantLabel = `${ivHigh ? 'High IV' : 'Low IV'} · ${skewHigh ? spec.leftLabel : spec.rightLabel}`;
        const volumeRank = optionsVolumeRanks?.get?.(t.symbol) ?? null;
        const enriched = { ...t, quadrantLabel, volumeRank };
        return <Tooltip ticker={enriched} style={style} />;
      })()}
    </div>
  );
}

function Tooltip({ ticker: t, style }) {
  // Subhead concatenates the company name and sector. Both come from
  // the roster JSON via the /api/scan response (t.name, t.sector). The
  // sector is the cluster anchor a vol trader uses to read whether a
  // ticker's quadrant position is idiosyncratic or part of a sector-
  // wide vol move — Energy names piling into "high IV + high put skew"
  // during an oil shock looks different from a single-name earnings
  // event in the same coordinate.
  const subhead = t.sector ? `${t.name} · ${t.sector}` : t.name;
  // Volume-rank presentation: "3.68M/day · #2 of 40" tells the reader
  // both the absolute scale (millions of contracts a day) and the
  // relative position in the universe. The total comes from
  // optionsVolumeRanks (set in SkewScanner) and equals the count of
  // priced names in the roster slice — typically 40.
  const volumeRankLabel = (t.volumeRank && Number.isFinite(t.volumeRank.rank))
    ? `${formatOptionsVolume(t.optionsVolume)}/day · #${t.volumeRank.rank} of ${t.volumeRank.total}`
    : formatOptionsVolume(t.optionsVolume);
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
        {subhead}
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
      {t.earningsDate && (
        // Earnings warning row. Highlights the date + reporting
        // session (BMO / AMC / Unknown) and a "in N days" suffix so
        // a reader instantly sees how soon the event lands. The
        // value text is rendered in amber to mirror the chart pill —
        // a reader scanning the tooltip for context on why the dot's
        // label is amber-pilled finds the explanation in the same
        // color. Same EW data lineage as /earnings; the server
        // attached the field whenever the ticker has a confirmed
        // release inside its EARNINGS_LOOKAHEAD_DAYS window.
        <TooltipRow
          label="Earnings"
          value={
            <span style={{ color: '#f0a030', fontWeight: 700 }}>
              {formatEarningsValue(t.earningsDate, t.earningsSession, t.daysToEarnings)}
            </span>
          }
        />
      )}
      <TooltipRow label="25Δ call" value={`${formatPct(t.call25dIv)} (${formatVolPoints(t.callSkew)})`} />
      <TooltipRow label="25Δ put"  value={`${formatPct(t.put25dIv)} (${formatVolPoints(t.putSkew)})`} />
      <TooltipRow label="25Δ RR" value={formatVolPoints(t.rrSkew)} />
      {t.quadrantLabel && (
        <TooltipRow label="Position" value={t.quadrantLabel} />
      )}
      <TooltipRow label="Tenor" value={`${t.dte}D · ${t.expiration}`} subtle />
      <TooltipRow label="Options vol" value={volumeRankLabel} subtle />
      {/* Anchor / hype rows. Three branches based on what the
          roster generator could compute for this ticker. Anchor
          names get the joint-rank tuple in accent-blue (matches
          the AnchorFilterToggle chrome); SP500-but-not-anchor names
          get the hype divergence in muted text so a reader can see
          why they were excluded; non-SP500 names are left silent —
          their absence of any SP500 row IS the explanation, and a
          tooltip line reading "non-SP500" doesn't add information
          beyond what the reader can already see from the empty
          weight column elsewhere. */}
      {t.anchor && (
        <TooltipRow
          label="Anchor 50"
          value={
            <span style={{ color: 'var(--accent-blue, #4a9eff)', fontWeight: 700 }}>
              {`ov${t.ovRank}/mc${t.mcRank} · ${t.weight}%`}
            </span>
          }
        />
      )}
      {!t.anchor && t.weight != null && (
        <TooltipRow
          label="SP500"
          value={`${t.weight}% · ov${t.ovRank}/mc${t.mcRank}${t.hype != null ? ` · hype ${t.hype}` : ''}`}
          subtle
        />
      )}
    </div>
  );
}

// Format the earnings tooltip value as e.g. "Mon, Apr 28 · BMO · in 2d"
// or "Today · AMC". Days-to-earnings = 0 reads as "Today"; 1 reads as
// "Tomorrow"; otherwise "in Nd". The session label is omitted when EW
// returned an Unknown session (rather than guessing) so the reader
// doesn't draw a false conclusion about whether the event lands
// before-market or after-close. The date itself is formatted in UTC
// and labeled with a weekday so a reader scanning the tooltip on
// (say) a Monday sees "Wed, Apr 30" not "2026-04-30".
function formatEarningsValue(iso, session, days) {
  if (!iso) return '—';
  const d = new Date(`${iso}T12:00:00Z`);
  const dateStr = Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC',
    });
  const parts = [dateStr];
  if (session && session !== 'Unknown') parts.push(session);
  if (Number.isFinite(days)) {
    if (days === 0) parts.push('today');
    else if (days === 1) parts.push('tomorrow');
    else if (days > 1) parts.push(`in ${days}d`);
  }
  return parts.join(' · ');
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

function EdgeLabel({ edge, outside, chartLeft, chartTop, chartSize, plotPadding, plotSize, text, color }) {
  // Edge-anchored axis label. All four labels are centered on the
  // median split line of their respective axis: top/bottom on the
  // vertical X=50% center, left/right on the horizontal Y=50% center.
  // The black-box backing gives each label legible contrast against
  // the gradient quadrant fill underneath (inside placement) or the
  // page background (outside placement), regardless of which side
  // the label lands on.
  //
  // OUTSIDE placement (wide viewports): labels live in the gutter
  // beyond the chart border, with an 8 px breathing gap. The chart
  // dots no longer collide with axis labels because the labels never
  // overlap the plotted area.
  //
  // INSIDE placement (narrow viewports): the original v0.3 layout —
  // labels live inside the plot area near each edge. Stock SVG text
  // wins on collision because the SVG element renders AFTER these
  // EdgeLabel divs in DOM order; a stock label that lands on top of
  // an axis label simply punches through visually.
  const baseStyle = {
    position: 'absolute',
    pointerEvents: 'none',
    fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
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

  if (outside) {
    const GAP = 8;
    const HALF = chartSize / 2;
    if (edge === 'top') {
      return (
        <div
          style={{
            ...baseStyle,
            left: chartLeft + HALF,
            top: chartTop - GAP,
            transform: 'translate(-50%, -100%)',
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
            left: chartLeft + HALF,
            top: chartTop + chartSize + GAP,
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
            left: chartLeft - GAP,
            top: chartTop + HALF,
            transform: 'translate(-100%, -50%)',
          }}
        >
          {text}
        </div>
      );
    }
    return (
      <div
        style={{
          ...baseStyle,
          left: chartLeft + chartSize + GAP,
          top: chartTop + HALF,
          transform: 'translateY(-50%)',
        }}
      >
        {text}
      </div>
    );
  }

  // Inside placement — narrow viewports. chartLeft / chartTop are
  // both 0 in this branch (the container is the chart itself), so
  // positioning is relative to the container directly.
  const offsetPx = plotPadding + 12;
  const insideHalf = plotSize / 2;
  if (edge === 'top') {
    return (
      <div
        style={{
          ...baseStyle,
          left: plotPadding + insideHalf,
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
          left: plotPadding + insideHalf,
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
          top: plotPadding + insideHalf,
          transform: 'translateY(-50%)',
        }}
      >
        {text}
      </div>
    );
  }
  return (
    <div
      style={{
        ...baseStyle,
        right: offsetPx,
        top: plotPadding + insideHalf,
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
        fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
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
            fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
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
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
        {/* Mirror of the in-chart amber pill — same fill color, same
            radius, same dark-on-amber typography — so a reader can
            connect the legend entry to the chart indicator at a
            glance. */}
        <span
          style={{
            display: 'inline-block',
            background: '#f0a030',
            color: '#0d1016',
            fontWeight: 700,
            fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
            fontSize: '0.82rem',
            padding: '0.05rem 0.35rem',
            borderRadius: '2px',
            letterSpacing: '0.02em',
          }}
        >
          ABCD
        </span>
        <span style={{ color: 'var(--text-secondary)' }}>earnings within ~2 weeks</span>
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
