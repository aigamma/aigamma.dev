import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import usePlotly from '../../src/hooks/usePlotly';
import useIsMobile from '../../src/hooks/useIsMobile';
import { useGexHistory } from '../../src/hooks/useHistoricalData';
import {
  PLOTLY_COLORS,
  PLOTLY_FONT_FAMILY,
  plotly2DChartLayout,
  plotlyAxis,
  plotlyTitle,
} from '../../src/lib/plotlyTheme';
import RangeBrush from '../../src/components/RangeBrush';
import ResetButton from '../../src/components/ResetButton';

// Gamma Index Oscillator — historical levels of the daily Gamma Index
// rendered as a regime-colored bounded oscillator. The index is
//   10 × (atm_call_gex − atm_put_gex) / (atm_call_gex + atm_put_gex)
// (falling back to the whole-chain ratio on pre-backfill days), bounded
// to [-10, +10] and centered at zero. Positive = dealers are net long
// gamma at the ATM cluster and hedge against the move (stabilizing);
// negative = dealers are net short gamma and hedge with the move
// (amplifying). Reframing the dealer-flow signal as a bounded oscillator
// lets the reader reason about mean reversion and regime extremes
// directly, instead of trying to compare absolute GEX levels that drift
// with chain size and index level over the years.
//
// Visuals follow the site-wide dealer-gamma color language (green =
// positive, red = negative) rather than SlotA's blue/coral SPX-versus-
// Flip scheme, because the quantity being shown here is the gamma
// regime itself rather than spot's position against a dealer level.
//
// • Line split at each zero crossing (linearly interpolated in time) so
//   positive stretches carry green, negative stretches carry red, with
//   a shared crossing vertex between adjacent segments so the line
//   reads as continuous. Same segmentation idiom as SlotA's SPX-vs-Flip
//   fill, repurposed to split at y=0 instead of at the (s − f) zero.
// • Translucent fill from each segment down/up to zero, clipped as a
//   closed `toself` polygon so fills don't bleed across sign flips the
//   way a `tozeroy` + null-mask approach would.
// • 20-day EMA overlaid in amber dashed to separate regime
//   persistence (EMA slow to cross) from short-term oscillation (index
//   fast to cross). EMA rather than SMA so the overlay reacts to
//   recent regime shifts without waiting for a lagging observation to
//   roll out of a fixed window — at α = 2/(N+1) = 2/21 ≈ 0.0952 the
//   20d EMA weights the most recent sample by ~9.5% and carries a
//   center-of-mass ≈ 10 trading days, so a regime flip registers in
//   the overlay within about two weeks instead of the full 20 the
//   SMA would need.
// • Dotted amber reference bands at ±5 marking the 50%-amplitude
//   threshold commonly used to flag a "significant" regime reading —
//   the bands land on major tick positions so the axis structure
//   reinforces them visually.
// • Solid zero line drawn separately (zeroline suppressed on the axis)
//   so the regime divider reads as chrome rather than a tick mark.
// • Latest-value badge in the upper-right margin showing current
//   index, percentile rank over the visible history, and current
//   above/below-zero streak length — the three scalars that answer
//   "is this a typical reading or a tail event" and "has the regime
//   been stable" in one glance.
// • Highlighted marker on the most recent point, filled in regime
//   color and outlined in titleText white so it pops above the fills.
// • Density ribbon on the right margin — a vertical Gaussian KDE of the
//   full-history gamma index, split at zero into green-above / red-below
//   halves that match the oscillator's regime fills, with a white line
//   across the ribbon at the current-value y-position so the reader can
//   read "where does today sit in the distribution" directly off the
//   ribbon shape. The ribbon shares the main plot's y-axis so the KDE
//   y-positions align to the oscillator line-by-line, and the ribbon's
//   xaxis2 is a hidden [0, 1.05]-normalized density axis. Bandwidth is
//   Scott's-rule (1.06σn^-1/5) with a 0.15 floor so ultra-narrow
//   distributions don't collapse to a spike.
// • Site-wide RangeBrush below the plot and ResetButton in the
//   upper-left corner, matching SlotA and DealerGammaRegime: default
//   window is the trailing 6 months, brush exposes full history for
//   expansion.

const GREEN_FILL = 'rgba(46, 204, 113, 0.32)';
const RED_FILL = 'rgba(231, 76, 60, 0.32)';
const RIBBON_GREEN_FILL = 'rgba(46, 204, 113, 0.45)';
const RIBBON_RED_FILL = 'rgba(231, 76, 60, 0.45)';
const GREEN_LINE = PLOTLY_COLORS.positive;
const RED_LINE = PLOTLY_COLORS.negative;
const EMA_LINE = PLOTLY_COLORS.highlight;
const ZERO_LINE_COLOR = 'rgba(224, 224, 224, 0.5)';
const EXTREME_LINE_COLOR = 'rgba(241, 196, 15, 0.35)';
const EXTREME_THRESHOLD = 5;
const EMA_WINDOW = 20;
const HISTORY_FROM = '2017-01-03';

// Subplot domain split: main plot consumes 89% of the horizontal space,
// a 3% gutter separates the two, and the ribbon takes the rightmost 8%.
// At typical 1000-1200px card widths this gives the ribbon 80-95px —
// enough for a readable KDE silhouette without crowding the oscillator.
const MAIN_DOMAIN = [0, 0.89];
const RIBBON_DOMAIN = [0.92, 1.0];
const RIBBON_GRID_STEP = 0.25;

// Precomputed grid [-10, -9.75, ..., 0, ..., +10] with y=0 landing
// exactly on a grid point so the above/below split doesn't need
// interpolation at the boundary.
const RIBBON_GRID = (() => {
  const out = [];
  for (let k = -40; k <= 40; k++) out.push(k * RIBBON_GRID_STEP);
  return out;
})();

// Scott's-rule bandwidth for Gaussian KDE — h = 1.06 * σ * n^(-1/5).
// For ~1000 samples with σ ≈ 2.5 this lands around 0.66, which is
// tight enough to preserve the bimodal structure of the index
// distribution (peaks on either side of zero) without being so narrow
// that each observation shows up as its own spike. Floored at 0.15
// for safety on pathologically narrow input.
function scottBandwidth(values) {
  if (values.length < 2) return 1;
  let mean = 0;
  for (const v of values) mean += v;
  mean /= values.length;
  let variance = 0;
  for (const v of values) variance += (v - mean) ** 2;
  variance /= values.length - 1;
  const sigma = Math.sqrt(variance);
  const bw = 1.06 * sigma * Math.pow(values.length, -0.2);
  return Math.max(bw, 0.15);
}

// Gaussian KDE: density(y) = (1 / nh√(2π)) * Σ exp(−½ ((y−v)/h)²).
// O(n·|grid|) which for n=1069 and |grid|=81 is ~87k evaluations —
// fine for a one-time page-load computation.
function computeKde(values, grid, bandwidth) {
  const n = values.length;
  if (n === 0) return grid.map((y) => ({ y, density: 0 }));
  const norm = 1 / (n * bandwidth * Math.sqrt(2 * Math.PI));
  const twoHSq = 2 * bandwidth * bandwidth;
  return grid.map((y) => {
    let sum = 0;
    for (const v of values) {
      const d = y - v;
      sum += Math.exp(-(d * d) / twoHSq);
    }
    return { y, density: sum * norm };
  });
}

function isoToMs(iso) {
  return new Date(`${iso}T00:00:00Z`).getTime();
}

function msToIso(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function addMonthsIso(iso, months) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

// Exponential moving average with smoothing α = 2 / (window + 1) —
// the standard Wilder/textbook convention where a 20-period EMA
// weights the most recent sample at ≈ 9.5%. The series is seeded
// with the SMA of the first `window` samples so the warm-up period
// emits null (Plotly gaps the line at those positions rather than
// smoothing through partial windows, matching the prior SMA
// behavior), and the recurrence EMA[t] = α·v[t] + (1−α)·EMA[t−1]
// carries forward from there.
function exponentialMovingAverage(values, window) {
  const out = new Array(values.length).fill(null);
  if (values.length < window) return out;
  const alpha = 2 / (window + 1);
  let sum = 0;
  for (let i = 0; i < window; i++) sum += values[i];
  let ema = sum / window;
  out[window - 1] = ema;
  for (let i = window; i < values.length; i++) {
    ema = alpha * values[i] + (1 - alpha) * ema;
    out[i] = ema;
  }
  return out;
}

// Split the series at each zero crossing into contiguous same-sign
// segments. At each sign flip the crossing point (linearly interpolated
// in time by the |value| ratio of the bracketing samples) is pushed
// onto the end of the outgoing segment and the start of the incoming
// one, so adjacent polygons meet on a shared vertex and the two-color
// fill reads as continuous.
function buildSegments(series) {
  const segments = [];
  if (!series || series.length === 0) return segments;

  let current = null;
  const open = (kind) => {
    current = { kind, ts: [], ys: [] };
    segments.push(current);
  };
  const push = (t, y) => {
    current.ts.push(t);
    current.ys.push(y);
  };

  const first = series[0];
  open(first.g >= 0 ? 'pos' : 'neg');
  push(first.t, first.g);
  let prevKind = current.kind;

  for (let i = 1; i < series.length; i++) {
    const curr = series[i];
    const currKind = curr.g >= 0 ? 'pos' : 'neg';
    if (currKind !== prevKind) {
      const prev = series[i - 1];
      const prevAbs = Math.abs(prev.g);
      const currAbs = Math.abs(curr.g);
      const denom = prevAbs + currAbs;
      const alpha = denom > 0 ? prevAbs / denom : 0.5;
      const prevMs = new Date(prev.t).getTime();
      const currMs = new Date(curr.t).getTime();
      const xCross = new Date(prevMs + alpha * (currMs - prevMs))
        .toISOString()
        .slice(0, 10);
      push(xCross, 0);
      open(currKind);
      push(xCross, 0);
    }
    push(curr.t, curr.g);
    prevKind = currKind;
  }
  return segments;
}

// Polygon walking a segment forward along the index line and back along
// y=0 to close. Yields a fill clipped exactly to the area between the
// line and zero over that segment's x-range, never leaking across sign
// flips.
function segmentFillTrace(seg, fillcolor) {
  return {
    x: [...seg.ts, ...seg.ts.slice().reverse()],
    y: [...seg.ys, ...seg.ys.map(() => 0)],
    fill: 'toself',
    fillcolor,
    line: { color: 'rgba(0,0,0,0)', width: 0 },
    mode: 'lines',
    type: 'scatter',
    showlegend: false,
    hoverinfo: 'skip',
  };
}

function segmentLineTrace(seg, color, showLegend, name, legendgroup) {
  return {
    x: seg.ts,
    y: seg.ys,
    mode: 'lines',
    type: 'scatter',
    line: { color, width: 2.5 },
    name,
    legendgroup,
    showlegend: showLegend,
    hovertemplate: '%{x|%b %d, %Y}<br>Gamma Index: %{y:.2f}<extra></extra>',
  };
}

// Y-axis range for the oscillator. Unlike SlotA (SPX, unbounded) which
// tightens its y-axis to the brushed window, this chart plots a
// bounded [-10, +10] oscillator whose meaningful zones (±5 extreme
// bands, ±10 theoretical walls) are fixed regardless of which subset
// of the history is on screen. Pinning the axis to a slightly padded
// [-10.5, +10.5] keeps those zones in place as the brush moves, makes
// the ±5 bands and the ±10 boundaries always visible, and — critically
// for the right-margin density ribbon — lets the KDE silhouette taper
// to zero at both extremes instead of being truncated mid-curve by a
// tight axis. Flat low-vol windows will sit as near-horizontal lines
// near zero, which is the honest rendering ("this stretch was
// quiet") rather than a misleadingly-stretched axis that makes quiet
// stretches look oscillatory.
const Y_RANGE = [-10.5, 10.5];

// Percent of samples ≤ target. Fed into the latest-value badge so the
// reader can see at a glance whether today's index is a typical
// reading or a tail event.
function percentileRank(values, target) {
  if (!values.length) return null;
  let below = 0;
  for (const v of values) if (v <= target) below++;
  return (below / values.length) * 100;
}

// Contiguous-streak length at the end of the series: how many most-
// recent trading days carry the same sign as the final sample. Lets
// the reader see whether today's regime is a fresh transition or a
// well-established run.
function tailStreak(values) {
  if (!values.length) return 0;
  const last = values[values.length - 1];
  const sign = last >= 0;
  let n = 0;
  for (let i = values.length - 1; i >= 0; i--) {
    if ((values[i] >= 0) !== sign) break;
    n++;
  }
  return n;
}

export const slotName = 'Gamma Index Oscillator · Historical Levels';

export default function SlotC() {
  const chartRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();
  const { data, loading, error } = useGexHistory({ from: HISTORY_FROM });
  const mobile = useIsMobile();
  const [timeRange, setTimeRange] = useState(null);

  const series = useMemo(() => {
    if (!data?.series) return [];
    return data.series
      .filter((r) => r.gamma_index != null && Number.isFinite(r.gamma_index))
      .map((r) => ({ t: r.trading_date, g: r.gamma_index }));
  }, [data]);

  const segments = useMemo(() => buildSegments(series), [series]);

  const ema = useMemo(
    () => exponentialMovingAverage(series.map((r) => r.g), EMA_WINDOW),
    [series],
  );

  // Full-history KDE, normalized so the peak density maps to 1. Pre-
  // split at y=0 into above/below halves that will render as two
  // separate fill-to-zerox scatter traces on the ribbon, matching the
  // oscillator's green-above / red-below regime coloring. Both halves
  // include y=0 as an endpoint so the fills meet on a shared vertex
  // and the green/red boundary reads flush without a gap or overlap.
  const ribbon = useMemo(() => {
    if (series.length === 0) return null;
    const values = series.map((r) => r.g);
    const bw = scottBandwidth(values);
    const raw = computeKde(values, RIBBON_GRID, bw);
    let peak = 0;
    for (const p of raw) if (p.density > peak) peak = p.density;
    if (peak === 0) return null;
    const normalized = raw.map((p) => ({ y: p.y, density: p.density / peak }));
    const above = normalized.filter((p) => p.y >= 0);
    const below = normalized.filter((p) => p.y <= 0);
    return { above, below, bandwidth: bw };
  }, [series]);

  const firstDate = series.length > 0 ? series[0].t : null;
  const lastDate = series.length > 0 ? series[series.length - 1].t : null;

  const defaultRange = useMemo(() => {
    if (!firstDate || !lastDate) return null;
    const sixMonthsBack = addMonthsIso(lastDate, -6);
    return [sixMonthsBack >= firstDate ? sixMonthsBack : firstDate, lastDate];
  }, [firstDate, lastDate]);

  const activeRange = timeRange || defaultRange;

  // Stats are computed over the full history (not the brushed window)
  // so the percentile rank answers "where does today sit in the whole
  // historical distribution" — the stable frame of reference that
  // doesn't shift as the user drags the brush. The streak is also
  // global because a regime run that started inside the brushed
  // window is not a complete streak count.
  const stats = useMemo(() => {
    if (series.length === 0) return null;
    const values = series.map((r) => r.g);
    const latest = series[series.length - 1];
    const pct = percentileRank(values, latest.g);
    const streak = tailStreak(values);
    return {
      latest: latest.g,
      latestDate: latest.t,
      pct,
      streak,
      sign: latest.g >= 0 ? 'pos' : 'neg',
    };
  }, [series]);

  useEffect(() => {
    if (!Plotly || !chartRef.current || series.length === 0 || !activeRange) return;

    const [windowStart, windowEnd] = activeRange;

    const fillTraces = segments
      .filter((seg) => seg.ts.length >= 2)
      .map((seg) =>
        segmentFillTrace(seg, seg.kind === 'pos' ? GREEN_FILL : RED_FILL),
      );

    let posLegendShown = false;
    let negLegendShown = false;
    const lineTraces = [];
    for (const seg of segments) {
      if (seg.ts.length < 2) continue;
      if (seg.kind === 'pos') {
        lineTraces.push(
          segmentLineTrace(
            seg,
            GREEN_LINE,
            !posLegendShown,
            '<b>Positive Gamma</b>',
            'gamma-pos',
          ),
        );
        posLegendShown = true;
      } else {
        lineTraces.push(
          segmentLineTrace(
            seg,
            RED_LINE,
            !negLegendShown,
            '<b>Negative Gamma</b>',
            'gamma-neg',
          ),
        );
        negLegendShown = true;
      }
    }

    const emaTrace = {
      x: series.map((r) => r.t),
      y: ema,
      mode: 'lines',
      type: 'scatter',
      line: { color: EMA_LINE, width: 1.5, dash: 'dash' },
      name: `<b>${EMA_WINDOW}d EMA</b>`,
      hovertemplate: `%{x|%b %d, %Y}<br>${EMA_WINDOW}d EMA: %{y:.2f}<extra></extra>`,
      connectgaps: false,
    };

    // Highlighted marker on the most recent point — filled in regime
    // color and outlined in titleText white so it reads as the "you
    // are here" dot above the fills. `cliponaxis: false` disables the
    // per-subplot clip-rect for this trace so the marker isn't bisected
    // by the main plot's right edge when latest.t coincides with
    // windowEnd (the default view pins windowEnd to the latest date, so
    // without this the right half of the circle gets chopped off by
    // Plotly's clip-path). The trace is only included below when the
    // brushed window actually contains latest.t — otherwise the
    // unclipped marker would float into the gutter between the main
    // plot and the density ribbon.
    const latest = series[series.length - 1];
    const latestTrace = {
      x: [latest.t],
      y: [latest.g],
      mode: 'markers',
      type: 'scatter',
      marker: {
        size: mobile ? 10 : 13,
        color: latest.g >= 0 ? GREEN_LINE : RED_LINE,
        line: { color: PLOTLY_COLORS.titleText, width: 2 },
        symbol: 'circle',
      },
      cliponaxis: false,
      showlegend: false,
      hovertemplate:
        `<b>Latest</b><br>%{x|%b %d, %Y}<br>Gamma Index: %{y:.2f}<extra></extra>`,
    };
    const latestInWindow = latest.t >= windowStart && latest.t <= windowEnd;

    // Ribbon traces — two filled KDE silhouettes on xaxis2, sharing the
    // main plot's y-axis so the densities align to the oscillator's
    // line-by-line. fill:'tozerox' fills between the curve and the
    // ribbon's x=0 (its left edge) so the density reads as a horizontal
    // distance from the gutter.
    const ribbonTraces = [];
    if (ribbon) {
      ribbonTraces.push({
        x: ribbon.above.map((p) => p.density),
        y: ribbon.above.map((p) => p.y),
        xaxis: 'x2',
        yaxis: 'y',
        mode: 'lines',
        type: 'scatter',
        fill: 'tozerox',
        fillcolor: RIBBON_GREEN_FILL,
        line: { color: GREEN_LINE, width: 1 },
        hoverinfo: 'skip',
        showlegend: false,
      });
      ribbonTraces.push({
        x: ribbon.below.map((p) => p.density),
        y: ribbon.below.map((p) => p.y),
        xaxis: 'x2',
        yaxis: 'y',
        mode: 'lines',
        type: 'scatter',
        fill: 'tozerox',
        fillcolor: RIBBON_RED_FILL,
        line: { color: RED_LINE, width: 1 },
        hoverinfo: 'skip',
        showlegend: false,
      });
    }

    const traces = [
      ...fillTraces,
      emaTrace,
      ...lineTraces,
      ...(latestInWindow ? [latestTrace] : []),
      ...ribbonTraces,
    ];

    // Ambient structure: zero axis + two ±5 extreme-threshold bands,
    // drawn as layer:'below' so the fills and lines paint over them
    // rather than the bands cutting through the data.
    const shapes = [
      {
        type: 'line',
        xref: 'paper',
        x0: 0,
        x1: 1,
        yref: 'y',
        y0: 0,
        y1: 0,
        line: { color: ZERO_LINE_COLOR, width: 1.25 },
        layer: 'below',
      },
      {
        type: 'line',
        xref: 'paper',
        x0: 0,
        x1: 1,
        yref: 'y',
        y0: EXTREME_THRESHOLD,
        y1: EXTREME_THRESHOLD,
        line: { color: EXTREME_LINE_COLOR, width: 1, dash: 'dot' },
        layer: 'below',
      },
      {
        type: 'line',
        xref: 'paper',
        x0: 0,
        x1: 1,
        yref: 'y',
        y0: -EXTREME_THRESHOLD,
        y1: -EXTREME_THRESHOLD,
        line: { color: EXTREME_LINE_COLOR, width: 1, dash: 'dot' },
        layer: 'below',
      },
    ];

    // White horizontal bar across the ribbon at the current-value
    // y-position. Spans only the ribbon's paper domain so it reads as a
    // "you are here" tick on the distribution rather than a chart-wide
    // reference line. Drawn at layer:'above' so the KDE fills don't
    // obscure it.
    if (stats && ribbon) {
      shapes.push({
        type: 'line',
        xref: 'paper',
        x0: RIBBON_DOMAIN[0],
        x1: RIBBON_DOMAIN[1],
        yref: 'y',
        y0: stats.latest,
        y1: stats.latest,
        line: { color: PLOTLY_COLORS.titleText, width: 2 },
        layer: 'above',
      });
    }

    const annotations = [];
    if (stats) {
      const signLabel = stats.sign === 'pos' ? 'pos' : 'neg';
      const lines = [
        `<b>${stats.latest >= 0 ? '+' : ''}${stats.latest.toFixed(2)}</b>`,
        `P${stats.pct.toFixed(0)} · ${stats.streak}d ${signLabel}`,
      ];
      annotations.push({
        x: 0.99,
        y: 1.15,
        xref: 'paper',
        yref: 'paper',
        text: lines.join('<br>'),
        showarrow: false,
        font: {
          family: PLOTLY_FONT_FAMILY,
          color: stats.sign === 'pos' ? GREEN_LINE : RED_LINE,
          size: mobile ? 13 : 16,
        },
        bgcolor: 'rgba(20, 24, 32, 0.85)',
        bordercolor: PLOTLY_COLORS.grid,
        borderwidth: 1,
        borderpad: 8,
        xanchor: 'right',
        yanchor: 'top',
        align: 'right',
      });
    }

    // Left-edge labels for the extreme bands, tucked inside the plot
    // so they sit on the dotted lines rather than floating in data
    // space.
    annotations.push({
      x: 0.005,
      y: EXTREME_THRESHOLD,
      xref: 'paper',
      yref: 'y',
      text: 'EXTREME +',
      showarrow: false,
      font: {
        family: PLOTLY_FONT_FAMILY,
        color: EXTREME_LINE_COLOR,
        size: mobile ? 9 : 10,
      },
      xanchor: 'left',
      yanchor: 'bottom',
    });
    annotations.push({
      x: 0.005,
      y: -EXTREME_THRESHOLD,
      xref: 'paper',
      yref: 'y',
      text: 'EXTREME −',
      showarrow: false,
      font: {
        family: PLOTLY_FONT_FAMILY,
        color: EXTREME_LINE_COLOR,
        size: mobile ? 9 : 10,
      },
      xanchor: 'left',
      yanchor: 'top',
    });

    // "LATEST" caption at the ribbon's right edge next to the white
    // current-value line so the reader can tie the line to the
    // present moment without looking back at the corner badge. No
    // matching "DENSITY" header — the corner badge sits in that
    // paper-margin zone and the vertical green/red silhouette is
    // self-explanatory once the reader sees the oscillator and
    // ribbon sharing y-axis positions. Skipped on mobile: the
    // ribbon shrinks to ~40px at phone widths and extra labels
    // crowd it.
    if (ribbon && stats && !mobile) {
      annotations.push({
        x: RIBBON_DOMAIN[1] - 0.005,
        y: stats.latest,
        xref: 'paper',
        yref: 'y',
        text: '<b>LATEST</b>',
        showarrow: false,
        font: {
          family: PLOTLY_FONT_FAMILY,
          color: PLOTLY_COLORS.titleText,
          size: 9,
        },
        bgcolor: 'rgba(20, 24, 32, 0.9)',
        borderpad: 2,
        xanchor: 'right',
        yanchor: 'middle',
      });
    }

    const legendFont = {
      family: PLOTLY_FONT_FAMILY,
      color: PLOTLY_COLORS.titleText,
      size: mobile ? 12 : 16,
    };
    const layout = plotly2DChartLayout({
      margin: mobile ? { t: 70, r: 20, b: 40, l: 55 } : { t: 95, r: 30, b: 45, l: 80 },
      title: {
        ...plotlyTitle('Gamma Index Oscillator'),
        y: 0.97,
        yref: 'container',
        yanchor: 'top',
      },
      xaxis: plotlyAxis('', {
        type: 'date',
        range: [windowStart, windowEnd],
        autorange: false,
        domain: MAIN_DOMAIN,
      }),
      // Hidden density axis for the ribbon — no tick labels, no grid,
      // fixedrange so any future pan/zoom affordance on the main plot
      // doesn't drag the ribbon's density scale. Range runs slightly
      // past 1.0 so the KDE silhouette doesn't touch the ribbon's
      // right edge at its peak.
      xaxis2: {
        domain: RIBBON_DOMAIN,
        anchor: 'y',
        range: [0, 1.05],
        autorange: false,
        fixedrange: true,
        showgrid: false,
        showticklabels: false,
        showline: true,
        linecolor: PLOTLY_COLORS.grid,
        zeroline: false,
      },
      yaxis: plotlyAxis(mobile ? '' : 'Gamma Index', {
        range: Y_RANGE,
        autorange: false,
        zeroline: false,
        tickvals: [-10, -5, 0, 5, 10],
      }),
      shapes,
      annotations,
      showlegend: !mobile,
      legend: {
        orientation: 'h',
        x: 0.5,
        y: 1.03,
        xanchor: 'center',
        yanchor: 'bottom',
        font: legendFont,
        bgcolor: 'rgba(0, 0, 0, 0)',
        borderwidth: 0,
      },
      hovermode: 'x unified',
    });

    Plotly.newPlot(chartRef.current, traces, layout, {
      responsive: true,
      displayModeBar: false,
    });
  }, [Plotly, series, segments, ema, activeRange, stats, mobile]);

  const handleBrushChange = useCallback((minMs, maxMs) => {
    setTimeRange([msToIso(minMs), msToIso(maxMs)]);
  }, []);

  if (plotlyError) {
    return (
      <div className="card" style={{ padding: '1rem', color: 'var(--accent-coral)' }}>
        Chart unavailable — Plotly failed to load ({plotlyError}).
      </div>
    );
  }
  if (error) {
    return (
      <div className="card" style={{ padding: '1rem', color: 'var(--accent-coral)' }}>
        Gamma Index history fetch failed: {error}
      </div>
    );
  }
  if (loading) {
    return <div className="skeleton-card" style={{ height: '600px' }} />;
  }
  if (!data || series.length === 0) {
    return (
      <div className="card text-muted">
        No Gamma Index samples available yet — daily_gex_stats has not produced
        any rows with usable atm_call_gex / atm_put_gex readings.
      </div>
    );
  }

  return (
    <div className="card" style={{ position: 'relative' }}>
      <ResetButton visible={timeRange != null} onClick={() => setTimeRange(null)} />
      <div
        ref={chartRef}
        style={{ width: '100%', height: '560px', backgroundColor: 'var(--bg-card)' }}
      />
      {activeRange && firstDate && lastDate && (
        <RangeBrush
          min={isoToMs(firstDate)}
          max={isoToMs(lastDate)}
          activeMin={isoToMs(activeRange[0])}
          activeMax={isoToMs(activeRange[1])}
          onChange={handleBrushChange}
        />
      )}
    </div>
  );
}
