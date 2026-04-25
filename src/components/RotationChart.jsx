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

export default function RotationChart() {
  const chartRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();
  const [step, setStep] = useState('day');
  const [payload, setPayload] = useState(null);
  const [fetchError, setFetchError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFetchError(null);
    async function load() {
      try {
        const res = await fetch(`/api/rotations?tail=10&step=${step}`);
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
  }, [step]);

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
    // visual clutter.
    const traces = payload.components.map((c) => {
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
    });

    Plotly.react(chartRef.current, traces, layout, {
      displayModeBar: false,
      responsive: true,
    });
  }, [Plotly, payload, chartData]);

  // The card chrome (meta band + step toggle) renders in every state so
  // the lookback control stays reachable even when the current step is
  // erroring out — most importantly, when the user picks Hour and the
  // API returns 503, we want them to be able to click Day or Week to get
  // back to a working chart without reloading the page. The chart slot
  // below the meta band swaps between loading / error / chart depending
  // on the fetch state for the current step.
  const benchmarkSymbol = payload?.benchmark?.symbol ?? 'SPY';
  const stepLabel = payload?.params?.step_label || 'periods';
  const errorMessage = fetchError || plotlyError;

  return (
    <div className="card rotation-card">
      <div className="rotation-meta">
        <span className="rotation-ticker">{benchmarkSymbol}</span>
        <RotationStepToggle step={step} onChange={setStep} disabled={loading} />
        {payload && (
          <>
            <span className="rotation-meta-line">
              {payload.tail} {stepLabel} · {payload.components.length} components
            </span>
            <span className="rotation-asof">
              Through {formatDateLabel(payload.asOf)}
            </span>
          </>
        )}
      </div>
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
