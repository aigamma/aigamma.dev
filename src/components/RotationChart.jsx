import { useEffect, useMemo, useRef, useState } from 'react';
import usePlotly from '../hooks/usePlotly';
import {
  plotly2DChartLayout,
  plotlyAxis,
  PLOTLY_COLORS,
  PLOTLY_FONT_FAMILY,
} from '../lib/plotlyTheme';

// Relative Sector Rotation chart. Renders the /api/rotations payload as a
// four-quadrant scatter where each ETF's recent trail is plotted against
// the SPY benchmark via standardized relative-strength math: rotation
// ratio on the x-axis (>100 = component leading benchmark on price),
// rotation momentum on the y-axis (>100 = component's rotation ratio is
// rising). The four quadrants tint the background and lend their color
// to the trail of any component whose latest point sits inside them —
// Leading green top-right, Weakening amber bottom-right, Lagging coral
// bottom-left, Improving blue top-left. Each component renders as one
// Plotly scatter trace with mode='lines+markers+text': the tail is a
// thin line with small dot markers, the most-recent point is a larger
// filled circle plus the symbol label, and hover text reports date /
// ratio / momentum on every dot.
//
// Data source: ThetaData /v3/stock/history/eod (Stock Value tier) via
// public.daily_eod → /api/rotations. The default universe matches the
// reference chart at C:\i\: SPY benchmark plus the eleven SPDR sector
// ETFs and three additional theme ETFs (XBI / XLB / XLC / XLE / XLF /
// XLI / XLK / XLP / XLRE / XLU / XLV / XLY / XME / KWEB). Adding a
// symbol to scripts/backfill/daily-eod.mjs's DEFAULT_SYMBOLS list and
// re-running the backfill will surface it on the chart automatically
// with no client-side edits.
//
// Per-symbol visibility row (RotationSymbolToggle) sits between the meta
// band and the chart canvas. Each pill is colored by the current
// quadrant ink of its component's latest point so the active state
// mirrors the trail color on the chart, and clicking a pill toggles
// that component's trace on or off. The axis range stays computed from
// every component (not just the visible subset) so toggling pills does
// not warp the spatial layout — visible traces stay in the same
// positions a reader saw before they hid the others. The hidden-set
// state defaults to empty so a first-time reader lands on all 14
// components rendered.

const QUADRANT_FILL = {
  leading:   'rgba(46, 204, 113, 0.10)',
  weakening: 'rgba(240, 160, 48, 0.10)',
  lagging:   'rgba(231, 76, 60, 0.10)',
  improving: 'rgba(74, 158, 255, 0.10)',
};

// Solid color for each quadrant — used for the trail line + endpoint
// dot of any component whose latest point lands in that quadrant.
const QUADRANT_INK = {
  leading:   '#2ecc71',
  weakening: '#f0a030',
  lagging:   '#e74c3c',
  improving: '#4a9eff',
};

function quadrantOf(ratio, momentum) {
  if (ratio >= 100 && momentum >= 100) return 'leading';
  if (ratio >= 100 && momentum < 100)  return 'weakening';
  if (ratio < 100  && momentum < 100)  return 'lagging';
  return 'improving';
}

function formatDateLabel(iso) {
  if (!iso || typeof iso !== 'string') return iso ?? '';
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return `${m}/${d}/${y}`;
}

// Three-position lookback toggle that drives the API's ?step= param. The
// labels mirror the convention financial charts use elsewhere on the
// dashboard: short alpha codes for the period (1H = one hour per tail
// step, 1D = one trading day, 1W = one ISO-trading-week). Hour mode is
// surfaced even though it currently returns 503 from /api/rotations
// because the chart's job is to make the user's intended granularity
// reachable via UI; the error path then explains the data prerequisite
// when the user clicks it, which is more honest than hiding the option
// entirely. Day stays the default to preserve the chart's behavior for
// readers who don't touch the toggle.
const STEP_OPTIONS = [
  { id: 'hour', short: '1H', long: 'Hour' },
  { id: 'day',  short: '1D', long: 'Day' },
  { id: 'week', short: '1W', long: 'Week' },
];

// Tail-length presets. Two values: 5 for a tight recent snapshot, 10
// to match the conventional rotation-chart trail length. Anything past
// 10 stacks too many crisscrossing trails on top of each other given
// 14 components in the universe; the longer-tail experiment that
// briefly shipped 5/10/20/40/60 and the follow-up 5/10/15 both
// surfaced the visual-clutter problem and got cut down to this minimal
// pair. Default is 10 paired with the week step (see useState below)
// so a first-time reader lands on the trail length where the actual
// clockwise spiral motion is visible; 5 stays available for the
// tighter recent-snapshot view.
const TAIL_OPTIONS = [5, 10];
const DEFAULT_TAIL = 10;

function RotationStepToggle({ step, onChange, disabled }) {
  return (
    <div
      className="rotation-step-toggle"
      role="group"
      aria-label="Lookback granularity"
    >
      {STEP_OPTIONS.map((opt) => {
        const active = opt.id === step;
        return (
          <button
            key={opt.id}
            type="button"
            className={
              'rotation-step-toggle__btn' +
              (active ? ' rotation-step-toggle__btn--active' : '')
            }
            aria-pressed={active}
            disabled={disabled}
            title={`${opt.long} per tail step`}
            onClick={() => onChange(opt.id)}
          >
            {opt.short}
          </button>
        );
      })}
    </div>
  );
}

function RotationTailToggle({ tail, onChange, disabled }) {
  return (
    <div
      className="rotation-step-toggle"
      role="group"
      aria-label="Trail length"
    >
      {TAIL_OPTIONS.map((n) => {
        const active = n === tail;
        return (
          <button
            key={n}
            type="button"
            className={
              'rotation-step-toggle__btn' +
              (active ? ' rotation-step-toggle__btn--active' : '')
            }
            aria-pressed={active}
            disabled={disabled}
            title={`${n} periods of trail per component`}
            onClick={() => onChange(n)}
          >
            {n}
          </button>
        );
      })}
    </div>
  );
}

// Per-symbol visibility toggle row. Renders one pill per component
// using the component's current quadrant ink color when active so the
// pill's appearance mirrors the color of that component's trail on
// the chart. Inactive pills strip out the fill, dim the border and
// text, so the row reads as a legend that also acts as a control.
// The toggle is built around a hiddenSymbols Set rather than a
// selectedSymbols Set so the empty-state default (no entries =
// everything visible) requires no initialization when payload arrives.
function RotationSymbolToggle({ components, hiddenSymbols, onToggle, disabled }) {
  return (
    <div
      className="rotation-symbol-toggle"
      role="group"
      aria-label="Visible components"
    >
      {components.map((c) => {
        const last = c.points[c.points.length - 1];
        const quad = quadrantOf(last.rs_ratio, last.rs_momentum);
        const color = QUADRANT_INK[quad];
        const active = !hiddenSymbols.has(c.symbol);
        // Inline color/border because each pill picks up its own
        // quadrant ink — there is no static class that knows which
        // quadrant a ticker is currently in. Inactive pills fall back
        // to neutral chrome (translucent border + secondary text)
        // since their fill would otherwise inherit the last-active
        // quadrant color and read as still-visible.
        const style = active
          ? { borderColor: color, backgroundColor: color, color: '#0d1016' }
          : { borderColor: 'rgba(255,255,255,0.18)', color: 'var(--text-secondary)' };
        return (
          <button
            key={c.symbol}
            type="button"
            className={
              'rotation-symbol-toggle__btn' +
              (active ? ' rotation-symbol-toggle__btn--active' : '')
            }
            aria-pressed={active}
            disabled={disabled}
            title={active ? `Hide ${c.symbol}` : `Show ${c.symbol}`}
            style={style}
            onClick={() => onToggle(c.symbol)}
          >
            {c.symbol}
          </button>
        );
      })}
    </div>
  );
}

// The chart accepts an optional symbols prop (an array of ticker
// strings) that gets joined with commas and passed through to the
// /api/rotations endpoint as ?symbols=AAA,BBB,... so the same chart
// component can render either the 14 sector + theme ETFs (default,
// /rotations page) or any other curated universe of names already
// present in public.daily_eod (e.g. the eleven hand-picked top
// option-volume single-name stocks on /stocks). The endpoint already
// supports symbol filtering — see netlify/functions/rotations.mjs's
// `symbolsFilter` block — so this is a pure pass-through.
//
// title overrides the section name displayed in the meta band ("Relative
// Sector Rotations" by default; "Relative Stock Rotations" on the
// /stocks page) so a reader doesn't see the wrong label when this
// chart is mounted outside the sector-ETF universe. Both props default
// to the original /rotations behavior so no caller change is needed
// on that page.
function RotationChart({
  symbols = null,
  title = 'Relative Sector Rotations',
} = {}) {
  const chartRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();
  // Defaults: week step + 5-period tail. The weekly view shows the
  // longer-horizon rotation pattern that's most actionable for the
  // sector-rotation use case, and tail=5 gives the tightest visual
  // cluster (less trail overlap with 14 components rendering at once).
  const [step, setStep] = useState('week');
  const [tail, setTail] = useState(DEFAULT_TAIL);
  const [payload, setPayload] = useState(null);
  const [fetchError, setFetchError] = useState(null);
  const [loading, setLoading] = useState(true);
  // Hidden-set state for the per-symbol visibility row. Empty default
  // = everything visible; toggling a pill adds or removes its symbol
  // from the set. Using "hidden" rather than "selected" means a fresh
  // payload (after a step or tail change) needs no initialization —
  // any component the user previously hid stays hidden across refreshes
  // because the symbols are stable across step/tail changes, and any
  // brand-new symbol added to the universe later renders by default.
  const [hiddenSymbols, setHiddenSymbols] = useState(() => new Set());

  const handleToggleSymbol = (symbol) => {
    setHiddenSymbols((prev) => {
      const next = new Set(prev);
      if (next.has(symbol)) next.delete(symbol);
      else next.add(symbol);
      return next;
    });
  };

  // Memoize the symbols query-string fragment so the useEffect dep
  // array can compare a stable string instead of the array identity
  // (a fresh [...] literal passed by the parent on every render would
  // refetch on every parent re-render even when the symbol set is
  // unchanged). Joined with commas to match the endpoint's `symbols`
  // query-param format.
  const symbolsParam = useMemo(
    () => (symbols && symbols.length > 0 ? symbols.join(',') : ''),
    [symbols],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFetchError(null);
    async function load() {
      try {
        const qs = symbolsParam
          ? `tail=${tail}&step=${step}&symbols=${encodeURIComponent(symbolsParam)}`
          : `tail=${tail}&step=${step}`;
        const res = await fetch(`/api/rotations?${qs}`);
        if (!res.ok) {
          // The 503 path for hour mode returns a JSON {error: '...'}
          // payload that's much more useful than a generic status code,
          // so try to surface it directly. Fall back to the status code
          // for non-JSON failures (network, html error page, etc.).
          let msg = `rotations fetch failed: ${res.status}`;
          try {
            const j = await res.json();
            if (j && j.error) msg = j.error;
          } catch {}
          throw new Error(msg);
        }
        const json = await res.json();
        if (!cancelled) {
          setPayload(json);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setFetchError(String(err?.message || err));
          setPayload(null);
          setLoading(false);
        }
      }
    }
    load();
    return () => { cancelled = true; };
  }, [step, tail, symbolsParam]);

  // Pre-compute axis ranges and trace data once payload is in hand.
  // The axis is symmetric around 100 with at least ±1.5 of half-extent
  // so flat-regime data still reads as four populated quadrants rather
  // than a tight cluster squashed against the zero-crossing.
  const chartData = useMemo(() => {
    if (!payload?.components) return null;

    const xs = [], ys = [];
    for (const c of payload.components) {
      for (const p of c.points) {
        if (Number.isFinite(p.rs_ratio)) xs.push(p.rs_ratio);
        if (Number.isFinite(p.rs_momentum)) ys.push(p.rs_momentum);
      }
    }
    if (xs.length === 0 || ys.length === 0) return null;

    const xExt = Math.max(
      Math.abs(100 - Math.min(...xs)),
      Math.abs(Math.max(...xs) - 100),
      1.5,
    ) * 1.18;
    const yExt = Math.max(
      Math.abs(100 - Math.min(...ys)),
      Math.abs(Math.max(...ys) - 100),
      1.5,
    ) * 1.18;
    const xRange = [100 - xExt, 100 + xExt];
    const yRange = [100 - yExt, 100 + yExt];

    return { xRange, yRange };
  }, [payload]);

  useEffect(() => {
    if (!Plotly || !chartRef.current || !payload || !chartData) return;

    const { xRange, yRange } = chartData;

    // Per-component trace: tail line + small dot markers + a larger
    // endpoint dot with the symbol label. marker.size as an array gives
    // every point its own size; text matches that — non-empty only at
    // the latest index so the tail dots stay unlabeled and don't cause
    // visual clutter. Components are filtered through hiddenSymbols so
    // a reader can hide individual tickers via the pill row above the
    // chart; the filter happens here (not at the axis-range step) so
    // the chart's spatial layout stays stable as pills are toggled.
    const visibleComponents = payload.components.filter(
      (c) => !hiddenSymbols.has(c.symbol),
    );
    const traces = visibleComponents.map((c) => {
      const last = c.points[c.points.length - 1];
      const quad = quadrantOf(last.rs_ratio, last.rs_momentum);
      const color = QUADRANT_INK[quad];

      const x = c.points.map((p) => p.rs_ratio);
      const y = c.points.map((p) => p.rs_momentum);
      const sizes = c.points.map((_, i) =>
        i === c.points.length - 1 ? 14 : 6,
      );
      const texts = c.points.map((_, i) =>
        i === c.points.length - 1 ? `<b>${c.symbol}</b>` : '',
      );
      const hoverTexts = c.points.map(
        (p) =>
          `<b>${c.symbol}</b><br>${formatDateLabel(p.date)}<br>` +
          `Ratio: ${p.rs_ratio.toFixed(2)}<br>` +
          `Momentum: ${p.rs_momentum.toFixed(2)}`,
      );

      return {
        x,
        y,
        mode: 'lines+markers+text',
        type: 'scatter',
        name: c.symbol,
        line: { color, width: 1.7, shape: 'spline', smoothing: 0.6 },
        marker: {
          color,
          size: sizes,
          line: { color: '#0d1016', width: 1.5 },
        },
        text: texts,
        textposition: 'middle right',
        textfont: {
          family: PLOTLY_FONT_FAMILY,
          color: PLOTLY_COLORS.titleText,
          size: 12,
        },
        hoverinfo: 'text',
        hovertext: hoverTexts,
        showlegend: false,
      };
    });

    // Background quadrant rectangles + the two cross-hair lines through
    // 100 / 100. layer: 'below' keeps the rectangles behind the data;
    // the cross-hair lines render above the rectangles but below the
    // traces by virtue of being the last shape entries (Plotly draws
    // shapes in array order with traces on top).
    const shapes = [
      {
        type: 'rect',
        xref: 'x', yref: 'y',
        x0: xRange[0], x1: 100, y0: 100, y1: yRange[1],
        fillcolor: QUADRANT_FILL.improving,
        line: { width: 0 },
        layer: 'below',
      },
      {
        type: 'rect',
        xref: 'x', yref: 'y',
        x0: 100, x1: xRange[1], y0: 100, y1: yRange[1],
        fillcolor: QUADRANT_FILL.leading,
        line: { width: 0 },
        layer: 'below',
      },
      {
        type: 'rect',
        xref: 'x', yref: 'y',
        x0: xRange[0], x1: 100, y0: yRange[0], y1: 100,
        fillcolor: QUADRANT_FILL.lagging,
        line: { width: 0 },
        layer: 'below',
      },
      {
        type: 'rect',
        xref: 'x', yref: 'y',
        x0: 100, x1: xRange[1], y0: yRange[0], y1: 100,
        fillcolor: QUADRANT_FILL.weakening,
        line: { width: 0 },
        layer: 'below',
      },
      {
        type: 'line',
        xref: 'x', yref: 'y',
        x0: 100, x1: 100, y0: yRange[0], y1: yRange[1],
        line: { color: PLOTLY_COLORS.titleText, width: 1.2 },
      },
      {
        type: 'line',
        xref: 'x', yref: 'y',
        x0: xRange[0], x1: xRange[1], y0: 100, y1: 100,
        line: { color: PLOTLY_COLORS.titleText, width: 1.2 },
      },
    ];

    // Quadrant text labels in the four corners. These are rendered with
    // each quadrant's own color so the chart's color language is
    // legible without a separate legend.
    const labelOffset = (range) => (range[1] - range[0]) * 0.025;
    const annotations = [
      {
        x: xRange[1] - labelOffset(xRange),
        y: yRange[1] - labelOffset(yRange),
        xref: 'x', yref: 'y',
        xanchor: 'right', yanchor: 'top',
        text: '<b>Leading</b>',
        showarrow: false,
        font: { color: QUADRANT_INK.leading, size: 14, family: PLOTLY_FONT_FAMILY },
      },
      {
        x: xRange[0] + labelOffset(xRange),
        y: yRange[1] - labelOffset(yRange),
        xref: 'x', yref: 'y',
        xanchor: 'left', yanchor: 'top',
        text: '<b>Improving</b>',
        showarrow: false,
        font: { color: QUADRANT_INK.improving, size: 14, family: PLOTLY_FONT_FAMILY },
      },
      {
        x: xRange[0] + labelOffset(xRange),
        y: yRange[0] + labelOffset(yRange),
        xref: 'x', yref: 'y',
        xanchor: 'left', yanchor: 'bottom',
        text: '<b>Lagging</b>',
        showarrow: false,
        font: { color: QUADRANT_INK.lagging, size: 14, family: PLOTLY_FONT_FAMILY },
      },
      {
        x: xRange[1] - labelOffset(xRange),
        y: yRange[0] + labelOffset(yRange),
        xref: 'x', yref: 'y',
        xanchor: 'right', yanchor: 'bottom',
        text: '<b>Weakening</b>',
        showarrow: false,
        font: { color: QUADRANT_INK.weakening, size: 14, family: PLOTLY_FONT_FAMILY },
      },
    ];

    const layout = plotly2DChartLayout({
      xaxis: plotlyAxis('Rotation Ratio', {
        range: xRange,
        zeroline: false,
        showgrid: true,
        gridcolor: 'rgba(255,255,255,0.05)',
      }),
      yaxis: plotlyAxis('Rotation Momentum', {
        range: yRange,
        zeroline: false,
        showgrid: true,
        gridcolor: 'rgba(255,255,255,0.05)',
      }),
      shapes,
      annotations,
      margin: { t: 30, r: 30, b: 70, l: 70 },
      hovermode: 'closest',
      // Override the platform-wide dragmode: false from PLOTLY_BASE_LAYOUT_2D
      // because RRG components cluster tightly around the 100/100
      // cross-hairs and a reader needs to zoom in to see individual
      // labels and trail directions. Pan-on-drag plus wheel-zoom is the
      // standard 2D-scatter interaction model and Plotly handles
      // double-click-to-reset automatically. The other 2D charts on the
      // platform stay brush-only because their x-axis is time and the
      // brush idiom is more useful there; the rotation chart is the
      // only place where both axes are values that benefit from
      // free-form pan/zoom.
      dragmode: 'pan',
    });

    Plotly.react(chartRef.current, traces, layout, {
      displayModeBar: false,
      responsive: true,
      // scrollZoom enables mouse-wheel zoom and pinch-to-zoom on
      // touch devices. doubleClick='reset' restores the axes to their
      // computed default ranges (xRange / yRange above) — this is the
      // same behavior as the user pressing the Reset button in the
      // meta band, which we expose as a visible affordance because
      // first-time readers won't necessarily know the double-click
      // gesture is available.
      scrollZoom: true,
      doubleClick: 'reset',
    });
  }, [Plotly, payload, chartData, hiddenSymbols]);

  const handleResetView = () => {
    if (!Plotly || !chartRef.current || !chartData) return;
    Plotly.relayout(chartRef.current, {
      'xaxis.range': chartData.xRange,
      'yaxis.range': chartData.yRange,
    });
  };

  // The card chrome (meta band + step toggle) renders in every state so
  // the lookback control stays reachable even when the current step is
  // erroring out — most importantly, when the user picks Hour and the
  // API returns 503, we want them to be able to click Day or Week to get
  // back to a working chart without reloading the page. The chart slot
  // below the meta band swaps between loading / error / chart depending
  // on the fetch state for the current step.
  //
  // The .rotation-ticker title comes from the title prop (defaults to
  // "Relative Sector Rotations"; the /stocks page passes "Relative
  // Stock Rotations") rather than the benchmark symbol. Earlier the
  // title rendered payload.benchmark.symbol (typically "SPY"), but on
  // /rotations the SPY benchmark is implicit in the entire chart's
  // construction (every component is plotted relative to SPY) — naming
  // it as a giant page-level title was confusing because a reader
  // glancing at the card couldn't tell whether it meant "this is a
  // chart of SPY" (no — SPY is just the basis the components are
  // measured against) or "this card represents the SPY benchmark"
  // (also no — SPY appears as a single dot on the plane). Naming the
  // section after what it shows ("Relative Sector Rotations") is
  // unambiguous. The benchmark symbol is still implicit in the prose
  // explainer card below.
  const stepLabel = payload?.params?.step_label || 'periods';
  const errorMessage = fetchError || plotlyError;

  return (
    <div className="card rotation-card">
      <div className="rotation-meta">
        <span className="rotation-ticker">{title}</span>
        <RotationStepToggle step={step} onChange={setStep} disabled={loading} />
        <RotationTailToggle tail={tail} onChange={setTail} disabled={loading} />
        {payload && !errorMessage && (
          <button
            type="button"
            className="rotation-reset-btn"
            onClick={handleResetView}
            disabled={loading}
            title="Reset zoom / pan back to default view"
          >
            Reset View
          </button>
        )}
        {payload && (
          <>
            <span className="rotation-meta-line">
              {payload.tail} {stepLabel} ·{' '}
              {hiddenSymbols.size > 0
                ? `${payload.components.length - hiddenSymbols.size} of ${payload.components.length} components`
                : `${payload.components.length} components`}
            </span>
            <span className="rotation-asof">
              Through {formatDateLabel(payload.asOf)}
            </span>
          </>
        )}
      </div>
      {!loading && !errorMessage && payload && (
        <RotationSymbolToggle
          components={payload.components}
          hiddenSymbols={hiddenSymbols}
          onToggle={handleToggleSymbol}
          disabled={loading}
        />
      )}
      {loading && (
        <div className="rotation-status">Loading rotation chart…</div>
      )}
      {!loading && errorMessage && (
        <div className="rotation-status rotation-status--error">
          {errorMessage}
        </div>
      )}
      {!loading && !errorMessage && payload && (
        <div ref={chartRef} className="rotation-chart" />
      )}
    </div>
  );
}

export default RotationChart;
