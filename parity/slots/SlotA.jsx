import { useEffect, useMemo, useRef, useState } from 'react';
import usePlotly from '../../src/hooks/usePlotly';
import useIsMobile from '../../src/hooks/useIsMobile';
import useOptionsData from '../../src/hooks/useOptionsData';
import RangeBrush from '../../src/components/RangeBrush';
import ResetButton from '../../src/components/ResetButton';
import {
  PLOTLY_COLORS,
  PLOTLY_FONTS,
  PLOTLY_FONT_FAMILY,
  plotly2DChartLayout,
  plotlyAxis,
  plotlyTitle,
} from '../../src/lib/plotlyTheme';
import { daysToExpiration } from '../../src/lib/dates';

// -----------------------------------------------------------------------------
// Put-call parity — box-spread r vs direct-PCP r at q = 0, with SPX forward
//
// Alpha-stage, v3 of the put-call-parity card prompted by sflush in Discord.
// v1 rendered a single term-structure curve of the box-spread-implied borrow
// rate. The 4-option box construction cancels S₀ exactly, so r_box is
// model-free and spot-invariant — which is the whole point of the box, but
// which (per sflush's v1 follow-up) is also what "washes out" the per-strike
// and per-snapshot instability a trader might actually want to see. His
// hypothesis: the instability of the direct-PCP variant is itself the signal.
//
// v2 overlays a second rate derived from put-call parity directly at a single
// strike, with q = 0 held fixed on purpose:
//
//     C − P = S₀·exp(−qT) − K·exp(−rT)
//
// solving for r with q = 0 gives
//
//     r_PCP,q=0 = (1/T)·ln( K / (S₀ − C + P) ).
//
// The q = 0 assumption is pedagogical rather than a modeling choice: with
// q = 0 baked in, whatever dividend yield the market has actually priced in
// leaks back into the implied rate, because the spot term no longer cancels.
// For strikes near spot and small qT, r_box − r_PCP,q=0 ≈ q_implied to first
// order (proof: expanding the parity equation with a true q* around q=0
// gives r_PCP,q=0 ≈ r* − q*·(S₀/K) ≈ r* − q* at ATM). So the vertical gap
// between the two curves is approximately the options-implied SPX dividend
// yield — a smooth baseline around 1–1.5%. And any *deviation* from that
// smooth baseline — curvature, jumps, per-expiration kinks — is the spot-
// driven pricing noise the box is specifically designed to wash out. If
// sflush's hypothesis holds, the tradable instability lives there.
//
// We compute r_PCP,q=0 at BOTH ATM-bracket strikes (K₁, K₂) and take the
// mean so the single plotted curve parallels the box's 2-strike construction
// (same four options, one fewer degree of freedom than the box gives us).
// Hover exposes the K₁- and K₂-specific values individually so the reader
// can see whether the two strikes agree or disagree at each expiration —
// disagreement between them at the same T is a second, orthogonal view of
// the same instability.
//
// v3 adds a bottom price panel that ties the two r curves back to SPX. v2
// plotted only rates, which left the reader without a direct visual anchor
// to "where SPX was when these options were priced" — sflush's v2 follow-up
// asked for SPX in the chart so the relationship between r and spot is
// legible at a glance. The bottom panel renders two things on a shared
// DTE x-axis:
//
//   (1) S₀ as a horizontal dashed reference at the current SPX spot price,
//   (2) F(T) = K₁ + (C₁ − P₁)·exp(r_box·T) — the per-expiration implied
//       SPX forward price recovered from put-call parity using r_box as
//       the discount rate.
//
// F(T) from K₁ and F(T) from K₂ are algebraically identical when evaluated
// at r_box (the box-cost identity forces F₁ = F₂; proof: substitute
// box_cost = (K₂−K₁)·exp(−r_box·T) into F₂ − F₁ and the difference
// collapses), so one curve suffices and we pick the K₁ leg. F(T) grows
// above S₀ at rate (r_box − q_implied), so the *vertical gap* between F(T)
// and the flat S₀ reference is S₀·((r_box − q)·T + O(T²)) — the cash-carry
// term. If r_box is 4.5% and q is 1.3%, that's a ~3.2% net forward drift
// per year, and a forward-curve that lies above spot by that amount is
// the direct price-domain analogue of the r_box curve in the top panel.
//
// With only a current snapshot this is still a cross-sectional view: how
// the two methods (and the implied forward) disagree across expirations at
// a single moment. The richer time-series view — how each method's r and
// F(T) wobble from snapshot to snapshot as S₀ moves between 5-minute
// ingests — needs a persisted series and is a separate piece of work.
//
// v4 adds a focus-mode pill row that sits directly above the chart and
// lets a viewer collapse the composite onto one layer at a time. ALL is
// the v3 default; RATES drops the amber spread and the green forward so
// only r_box and r_PCP remain in the top panel; SPREAD keeps only the
// amber box − PCP trace; FORWARD keeps only the green F(T) curve in the
// bottom panel. Hidden traces are set to Plotly's `visible: 'legendonly'`
// rather than removed from the spec, so each curve still occupies a row
// in the legend and a single legend click can re-add any one trace
// without leaving the focus mode. Built in response to sflush's v3
// follow-up — "why is r from PCP a straight horizontal line?" — because
// the math answer (Taylor-expanding ln(K/(S₀−C+P))/T at q=0 gives
// r_PCP ≈ (r−q) + ½(r−q)²·T + O(T²), so the leading term is T-independent
// by construction) is most legible when the two r curves sit alone in
// the top panel without the amber spread or the green forward competing
// for visual weight. The same affordance generalizes: any future layer
// added to this card can join the pill row without redesigning the
// composite.
// -----------------------------------------------------------------------------

const FOCUS_MODES = [
  { key: 'all',     label: 'ALL',     show: new Set(['rBox', 'rPcp', 'rDiff', 'fwd']) },
  { key: 'rates',   label: 'RATES',   show: new Set(['rBox', 'rPcp']) },
  { key: 'spread',  label: 'SPREAD',  show: new Set(['rDiff']) },
  { key: 'forward', label: 'FORWARD', show: new Set(['fwd']) },
];

function groupByExpiration(contracts) {
  const byExp = new Map();
  for (const c of contracts) {
    if (!c.expiration_date) continue;
    if (c.strike_price == null || !Number.isFinite(c.strike_price)) continue;
    if (!(c.close_price > 0)) continue;
    const type = c.contract_type?.toLowerCase();
    if (type !== 'call' && type !== 'put') continue;
    if (!byExp.has(c.expiration_date)) {
      byExp.set(c.expiration_date, { calls: new Map(), puts: new Map() });
    }
    const bucket = byExp.get(c.expiration_date);
    const target = type === 'call' ? bucket.calls : bucket.puts;
    target.set(c.strike_price, c.close_price);
  }
  return byExp;
}

// Tightest strike pair that brackets spot from both sides. ATM-tight is the
// right default here because SPX near-the-money is the deepest liquidity on
// the board; the (K₂ − K₁) denominator is smaller and so r_box is slightly
// more mark-error-sensitive than a wider bracket, but the thicker marks at
// ATM more than compensate.
function findAtmBracket(strikes, spotPrice) {
  let K1 = null;
  let K2 = null;
  for (const k of strikes) {
    if (k <= spotPrice) {
      if (K1 == null || k > K1) K1 = k;
    } else {
      if (K2 == null || k < K2) K2 = k;
    }
  }
  if (K1 == null || K2 == null) return null;
  return [K1, K2];
}

// Direct put-call parity at a single strike, q = 0:
//   r = (1/T)·ln( K / (S₀ − C + P) )
// Undefined if the argument is non-positive, which only happens at strikes
// far below spot where the put intrinsic dominates; the ATM bracket used
// here keeps us well inside the regime where S₀ ≈ K and C − P ≈ 0, so the
// argument stays safely positive.
function pcpRateQzero(S0, K, C, P, T) {
  const denom = S0 - C + P;
  if (!(denom > 0) || !(T > 0)) return null;
  const r = (1 / T) * Math.log(K / denom);
  return Number.isFinite(r) ? r : null;
}

function computeRateSeries(contracts, spotPrice, capturedAt) {
  if (!contracts || !(spotPrice > 0) || !capturedAt) return [];
  const grouped = groupByExpiration(contracts);
  const rows = [];
  for (const [expiration, { calls, puts }] of grouped) {
    const matched = [];
    for (const k of calls.keys()) {
      if (puts.has(k)) matched.push(k);
    }
    if (matched.length < 2) continue;

    const bracket = findAtmBracket(matched, spotPrice);
    if (!bracket) continue;
    const [K1, K2] = bracket;

    const dte = daysToExpiration(expiration, capturedAt);
    if (dte == null || dte < 1) continue;
    const T = dte / 365;

    const C1 = calls.get(K1);
    const P1 = puts.get(K1);
    const C2 = calls.get(K2);
    const P2 = puts.get(K2);
    const boxCost = (C1 - P1) - (C2 - P2);
    const strikeSpread = K2 - K1;
    if (!(boxCost > 0) || !(strikeSpread > 0)) continue;

    const rBox = (1 / T) * Math.log(strikeSpread / boxCost);
    if (!Number.isFinite(rBox)) continue;

    const rPcp1 = pcpRateQzero(spotPrice, K1, C1, P1, T);
    const rPcp2 = pcpRateQzero(spotPrice, K2, C2, P2, T);
    let rPcp = null;
    if (rPcp1 != null && rPcp2 != null) rPcp = 0.5 * (rPcp1 + rPcp2);
    else if (rPcp1 != null) rPcp = rPcp1;
    else if (rPcp2 != null) rPcp = rPcp2;

    // r_box − r_PCP,q=0 ≈ options-implied dividend yield for small qT
    // at ATM. See the header comment for the first-order expansion.
    const rDiff = rPcp != null ? rBox - rPcp : null;

    // Cross-strike disagreement between the two ATM-bracket PCP rates:
    // a second, orthogonal view of the same instability. Null when either
    // leg was unusable.
    const rPcpSpread =
      rPcp1 != null && rPcp2 != null ? Math.abs(rPcp1 - rPcp2) : null;

    // Per-expiration implied SPX forward, recovered from PCP using r_box
    // as the discount rate: F = K + (C − P)·exp(r·T). The K₁ and K₂ legs
    // give algebraically identical forwards at r_box because the box-cost
    // identity forces F₁ = F₂ — see the header comment for the proof —
    // so one leg is enough. Using K₁ (the lower strike) here.
    const fwd = K1 + (C1 - P1) * Math.exp(rBox * T);
    // The no-dividend reference S₀·exp(r_box·T) is what F(T) would be
    // if q = 0. The observed gap F(T) − S₀·exp(r_box·T) ≈ −S₀·q·T at
    // first order, so a forward curve below this reference line is the
    // direct price-domain signature of a positive implied dividend yield.
    const fwdNoDiv = spotPrice * Math.exp(rBox * T);

    rows.push({
      expiration, dte, T,
      K1, K2, C1, P1, C2, P2,
      boxCost, strikeSpread,
      rBox, rPcp, rPcp1, rPcp2, rDiff, rPcpSpread,
      fwd, fwdNoDiv,
    });
  }
  return rows.sort((a, b) => a.dte - b.dte);
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return n % 2 ? sorted[(n - 1) / 2] : 0.5 * (sorted[n / 2 - 1] + sorted[n / 2]);
}

function formatPct(v, digits = 2) {
  if (v == null || !Number.isFinite(v)) return '–';
  return `${(v * 100).toFixed(digits)}%`;
}

function StatCell({ label, value, sub, accent }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div
        style={{
          fontSize: '0.72rem',
          color: 'var(--text-secondary)',
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          marginBottom: '0.3rem',
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: 'Courier New, monospace',
          fontSize: '1.25rem',
          color: accent || 'var(--text-primary)',
        }}
      >
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.2rem' }}>
          {sub}
        </div>
      )}
    </div>
  );
}

// slotName drives the visible "lab-slot-label" rendered by ../App.jsx so
// the chrome reflects the model in the slot rather than the slot's letter
// position. Update this string whenever the model under test changes.
export const slotName = 'PUT-CALL PARITY · BOX VS DIRECT';

export default function SlotA() {
  const chartRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();
  const mobile = useIsMobile();
  const [focus, setFocus] = useState('all');
  const [dteRange, setDteRange] = useState(null);
  const { data, loading, error } = useOptionsData({
    underlying: 'SPX',
    snapshotType: 'intraday',
  });

  const rows = useMemo(
    () => computeRateSeries(data?.contracts, data?.spotPrice, data?.capturedAt),
    [data],
  );

  const medianDiff = useMemo(() => {
    const vals = rows.map((r) => r.rDiff).filter((v) => v != null);
    return vals.length ? median(vals) : null;
  }, [rows]);

  const diffRange = useMemo(() => {
    const vals = rows.map((r) => r.rDiff).filter((v) => v != null);
    if (vals.length === 0) return null;
    return { lo: Math.min(...vals), hi: Math.max(...vals) };
  }, [rows]);

  // Stable data-driven max for the RangeBrush. The chart's visible
  // x-axis range is driven by `dteRange` (null = full window); the
  // brush itself anchors against this immutable data max so the track
  // does not resize as the user drags handles.
  const dteMaxData = useMemo(() => {
    if (rows.length === 0) return 1;
    return Math.max(...rows.map((r) => r.dte)) * 1.04 + 1;
  }, [rows]);
  const activeDteRange = dteRange || [0, dteMaxData];

  // Headline picks the first expiration ≥ 7 DTE so the displayed numbers
  // aren't skewed by the short-dated noise at the left edge of the curve,
  // which is where 1/T magnifies mark error the most.
  const headline = useMemo(() => rows.find((r) => r.dte >= 7) || rows[0] || null, [rows]);

  useEffect(() => {
    if (!Plotly || !chartRef.current || rows.length === 0) return;

    const S0 = data?.spotPrice;
    const activeFocus = FOCUS_MODES.find((m) => m.key === focus) || FOCUS_MODES[0];
    const visibleFor = (key) => (activeFocus.show.has(key) ? true : 'legendonly');

    const xs = rows.map((r) => r.dte);
    const yBox = rows.map((r) => r.rBox * 100);
    const yPcp = rows.map((r) => (r.rPcp != null ? r.rPcp * 100 : null));
    const yDiff = rows.map((r) => (r.rDiff != null ? r.rDiff * 100 : null));
    const yFwd = rows.map((r) => r.fwd);

    const xMin = activeDteRange[0];
    const xMax = activeDteRange[1];

    const yRates = [...yBox, ...yPcp].filter((v) => v != null);
    const yMin = Math.min(...yRates);
    const yMax = Math.max(...yRates);
    const ySpan = yMax - yMin;
    const yPad = ySpan > 0 ? ySpan * 0.12 : Math.abs(yMin) * 0.2 || 0.5;

    const yDiffFiltered = yDiff.filter((v) => v != null);
    const y2Min = yDiffFiltered.length ? Math.min(...yDiffFiltered) : 0;
    const y2Max = yDiffFiltered.length ? Math.max(...yDiffFiltered) : 1;
    const y2Span = y2Max - y2Min;
    const y2Pad = y2Span > 0 ? y2Span * 0.25 : Math.abs(y2Max) * 0.3 || 0.2;

    // Price-axis range for the bottom SPX panel. Anchor both to S₀ and to
    // the full forward curve so the S₀ reference line is always in frame
    // and the F(T) curve's climb above spot is easy to eyeball. Pad 18%
    // of the observed (F_max − min(S₀, F_min)) span so the curve doesn't
    // hug the axis edges; fall back to 0.5% of S₀ when the curve is flat.
    const priceAnchors = [S0, ...yFwd.filter((v) => Number.isFinite(v))];
    const priceMin = Math.min(...priceAnchors);
    const priceMax = Math.max(...priceAnchors);
    const priceSpan = priceMax - priceMin;
    const pricePad = priceSpan > 0 ? priceSpan * 0.18 : S0 * 0.005;
    const priceLo = priceMin - pricePad;
    const priceHi = priceMax + pricePad;

    const hoverBox = rows.map((r) =>
      [
        `<b>${r.expiration}</b>`,
        `DTE ${r.dte.toFixed(1)}`,
        `K₁ ${r.K1.toLocaleString()} · K₂ ${r.K2.toLocaleString()}`,
        `C₁ ${r.C1.toFixed(2)} · P₁ ${r.P1.toFixed(2)}`,
        `C₂ ${r.C2.toFixed(2)} · P₂ ${r.P2.toFixed(2)}`,
        `box $${r.boxCost.toFixed(2)} · ΔK ${r.strikeSpread}`,
        `<b>r<sub>box</sub> ${(r.rBox * 100).toFixed(3)}%</b>`,
      ].join('<br>'),
    );

    const hoverPcp = rows.map((r) =>
      r.rPcp != null
        ? [
            `<b>${r.expiration}</b>`,
            `DTE ${r.dte.toFixed(1)}`,
            `direct PCP · q = 0 assumed`,
            `r at K₁ ${(r.rPcp1 * 100).toFixed(3)}%`,
            `r at K₂ ${(r.rPcp2 * 100).toFixed(3)}%`,
            r.rPcpSpread != null
              ? `|r(K₁) − r(K₂)| ${(r.rPcpSpread * 100).toFixed(3)}%`
              : '',
            `<b>r̄<sub>PCP</sub> ${(r.rPcp * 100).toFixed(3)}%</b>`,
          ]
            .filter(Boolean)
            .join('<br>')
        : '',
    );

    const hoverDiff = rows.map((r) =>
      r.rDiff != null
        ? [
            `<b>${r.expiration}</b>`,
            `DTE ${r.dte.toFixed(1)}`,
            `r<sub>box</sub> − r<sub>PCP,q=0</sub>`,
            `<b>${(r.rDiff * 100).toFixed(3)}%</b>`,
            `<span style="opacity:0.7">≈ options-implied q at ATM</span>`,
          ].join('<br>')
        : '',
    );

    // Forward-curve hover exposes the raw PCP-recovered forward, the gap
    // vs S₀ (raw carry + dividends), and the gap vs S₀·exp(r_box·T) (which
    // is the pure q signature — gap divided by S₀·T is ≈ q at first order).
    const hoverFwd = rows.map((r) => {
      const fwdMinusSpot = r.fwd - S0;
      const fwdMinusNoDiv = r.fwd - r.fwdNoDiv;
      const qApprox = r.T > 0 ? -fwdMinusNoDiv / (S0 * r.T) : null;
      return [
        `<b>${r.expiration}</b>`,
        `DTE ${r.dte.toFixed(1)}`,
        `<b>F(T) ${r.fwd.toFixed(2)}</b>`,
        `F − S₀ ${fwdMinusSpot >= 0 ? '+' : ''}${fwdMinusSpot.toFixed(2)}`,
        `S₀·exp(r<sub>box</sub>·T) ${r.fwdNoDiv.toFixed(2)}`,
        `F − S₀·exp(r<sub>box</sub>·T) ${fwdMinusNoDiv >= 0 ? '+' : ''}${fwdMinusNoDiv.toFixed(2)}`,
        qApprox != null
          ? `<span style="opacity:0.7">≈ q ${(qApprox * 100).toFixed(2)}%</span>`
          : '',
      ]
        .filter(Boolean)
        .join('<br>');
    });

    const traces = [
      {
        x: xs,
        y: yBox,
        name: 'r<sub>box</sub> · 4-leg, spot cancels',
        mode: 'lines+markers',
        type: 'scatter',
        line: { color: PLOTLY_COLORS.primary, width: 1.5 },
        marker: { color: PLOTLY_COLORS.primary, size: mobile ? 6 : 8, line: { width: 0 } },
        hoverinfo: 'text',
        text: hoverBox,
        visible: visibleFor('rBox'),
      },
      {
        x: xs,
        y: yPcp,
        name: 'r<sub>PCP</sub> · 1-strike, q = 0',
        mode: 'lines+markers',
        type: 'scatter',
        line: { color: PLOTLY_COLORS.secondary, width: 1.5, dash: 'dot' },
        marker: {
          color: PLOTLY_COLORS.secondary,
          size: mobile ? 6 : 8,
          symbol: 'diamond',
          line: { width: 0 },
        },
        hoverinfo: 'text',
        text: hoverPcp,
        connectgaps: false,
        visible: visibleFor('rPcp'),
      },
      {
        x: xs,
        y: yDiff,
        name: 'r<sub>box</sub> − r<sub>PCP</sub> · ≈ implied q',
        mode: 'lines+markers',
        type: 'scatter',
        line: { color: PLOTLY_COLORS.highlight, width: 1.25 },
        marker: {
          color: PLOTLY_COLORS.highlight,
          size: mobile ? 5 : 7,
          symbol: 'triangle-up',
          line: { width: 0 },
        },
        hoverinfo: 'text',
        text: hoverDiff,
        yaxis: 'y2',
        connectgaps: false,
        visible: visibleFor('rDiff'),
      },
      {
        x: xs,
        y: yFwd,
        name: 'F(T) · SPX forward · K₁+(C−P)·e<sup>r·T</sup>',
        mode: 'lines+markers',
        type: 'scatter',
        line: { color: PLOTLY_COLORS.positive, width: 1.5 },
        marker: {
          color: PLOTLY_COLORS.positive,
          size: mobile ? 6 : 8,
          symbol: 'square',
          line: { width: 0 },
        },
        hoverinfo: 'text',
        text: hoverFwd,
        xaxis: 'x2',
        yaxis: 'y3',
        visible: visibleFor('fwd'),
      },
    ];

    const shapes = [];
    const annotations = [];
    if (medianDiff != null) {
      const medPct = medianDiff * 100;
      shapes.push({
        type: 'line',
        xref: 'x',
        yref: 'y2',
        x0: xMin,
        x1: xMax,
        y0: medPct,
        y1: medPct,
        line: { color: PLOTLY_COLORS.highlight, width: 1, dash: 'dash' },
      });
      annotations.push({
        x: xMax,
        y: medPct,
        xref: 'x',
        yref: 'y2',
        xanchor: 'right',
        yanchor: 'bottom',
        text: `median q ${medPct.toFixed(2)}%`,
        showarrow: false,
        font: { family: PLOTLY_FONT_FAMILY, color: PLOTLY_COLORS.highlight, size: 11 },
        bgcolor: PLOTLY_COLORS.plot,
        bordercolor: PLOTLY_COLORS.highlight,
        borderwidth: 1,
        borderpad: 3,
        xshift: -4,
        yshift: 4,
      });
    }

    // Horizontal S₀ reference on the bottom SPX price panel. The visual
    // distance between the F(T) trace and this line is S₀·((r_box − q)·T)
    // to first order — i.e. the cash-and-carry term made visible. Drawn
    // in primarySoft so it reads as "this is SPX, not a data series."
    if (Number.isFinite(S0)) {
      shapes.push({
        type: 'line',
        xref: 'x2',
        yref: 'y3',
        x0: xMin,
        x1: xMax,
        y0: S0,
        y1: S0,
        line: { color: PLOTLY_COLORS.primarySoft, width: 1, dash: 'dash' },
      });
      annotations.push({
        x: xMin,
        y: S0,
        xref: 'x2',
        yref: 'y3',
        xanchor: 'left',
        yanchor: 'bottom',
        text: `S₀ ${S0.toLocaleString(undefined, { maximumFractionDigits: 2 })}`,
        showarrow: false,
        font: { family: PLOTLY_FONT_FAMILY, color: PLOTLY_COLORS.primarySoft, size: 11 },
        bgcolor: PLOTLY_COLORS.plot,
        bordercolor: PLOTLY_COLORS.primarySoft,
        borderwidth: 1,
        borderpad: 3,
        xshift: 4,
        yshift: 4,
      });
    }

    const layout = plotly2DChartLayout({
      title: {
        ...plotlyTitle('Put-Call Parity · Box vs Direct PCP'),
        y: 0.97,
        yref: 'container',
        yanchor: 'top',
      },
      margin: mobile
        ? { t: 50, r: 55, b: 105, l: 60 }
        : { t: 70, r: 75, b: 115, l: 75 },
      // Top panel (r%) owns xaxis anchored to y; its tick labels are
      // hidden so the shared DTE axis reads only once at the bottom.
      xaxis: {
        ...plotlyAxis('', { range: [xMin, xMax], autorange: false }),
        anchor: 'y',
        showticklabels: false,
      },
      // Bottom panel (SPX $) owns xaxis2 anchored to y3 and carries the
      // Days-to-Expiration axis title. `matches: 'x'` locks both panels
      // to the same x range so a DTE read lines up vertically.
      xaxis2: {
        ...plotlyAxis('Days to Expiration', { range: [xMin, xMax], autorange: false }),
        anchor: 'y3',
        matches: 'x',
      },
      yaxis: {
        ...plotlyAxis('r (%)', {
          range: [yMin - yPad, yMax + yPad],
          autorange: false,
          ticksuffix: '%',
          tickformat: '.2f',
        }),
        domain: [0.32, 1.0],
        anchor: 'x',
      },
      yaxis2: {
        ...plotlyAxis('q ≈ box − PCP (%)', {
          range: [y2Min - y2Pad, y2Max + y2Pad],
          autorange: false,
          ticksuffix: '%',
          tickformat: '.2f',
          showgrid: false,
        }),
        domain: [0.32, 1.0],
        overlaying: 'y',
        side: 'right',
        anchor: 'x',
      },
      yaxis3: {
        ...plotlyAxis('SPX ($)', {
          range: [priceLo, priceHi],
          autorange: false,
          tickformat: ',.0f',
        }),
        domain: [0.0, 0.22],
        anchor: 'x2',
      },
      shapes,
      annotations,
      hovermode: 'closest',
      showlegend: true,
      legend: {
        orientation: 'h',
        y: -0.32,
        x: 0.5,
        xanchor: 'center',
        font: PLOTLY_FONTS.legend,
      },
    });

    Plotly.react(chartRef.current, traces, layout, {
      responsive: true,
      displayModeBar: false,
    });
  }, [Plotly, rows, medianDiff, data, mobile, focus, activeDteRange[0], activeDteRange[1]]);

  if (loading && !data) {
    return (
      <div className="lab-placeholder">
        <div className="lab-placeholder-title">Loading chain…</div>
        <div className="lab-placeholder-hint">
          Fetching the current SPX snapshot from <code>/api/data</code>.
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="lab-placeholder" style={{ borderColor: 'var(--accent-coral)' }}>
        <div className="lab-placeholder-title" style={{ color: 'var(--accent-coral)' }}>
          Chain fetch failed
        </div>
        <div className="lab-placeholder-hint">{error}</div>
      </div>
    );
  }

  if (plotlyError) {
    return (
      <div className="lab-placeholder" style={{ borderColor: 'var(--accent-coral)' }}>
        <div className="lab-placeholder-title" style={{ color: 'var(--accent-coral)' }}>
          Plotly unavailable
        </div>
        <div className="lab-placeholder-hint">{plotlyError}</div>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="lab-placeholder">
        <div className="lab-placeholder-title">No usable strike pairs</div>
        <div className="lab-placeholder-hint">
          The current snapshot does not contain enough matched call/put pairs
          bracketing the spot price to compute implied rates at either method.
        </div>
      </div>
    );
  }

  return (
    <div className="card" style={{ padding: '1.25rem 1.25rem 1rem' }}>
      <div style={{ marginBottom: '0.85rem' }}>
        <div
          style={{
            fontFamily: 'Courier New, monospace',
            fontSize: '0.7rem',
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--text-secondary)',
            marginBottom: '0.35rem',
          }}
        >
          model · put-call parity · box vs direct
        </div>
        <div
          style={{
            fontSize: '1rem',
            color: 'var(--text-secondary)',
            lineHeight: 1.6,
            maxWidth: '820px',
          }}
        >
          <p style={{ margin: '0 0 0.6rem' }}>
            Two implied borrow-rate reads from the same SPX chain plus the
            PCP-recovered forward-price term structure, stacked so any gap
            between them is visible at a glance alongside where SPX itself
            was when the chain was priced.
          </p>
          <p style={{ margin: '0 0 0.6rem' }}>
            The{' '}
            <strong style={{ color: PLOTLY_COLORS.primary }}>
              blue line (Box r)
            </strong>{' '}
            is a 4-leg construction that cancels spot. Its number does not
            drift when the market moves, so it is the stable fair-rate
            reference.
          </p>
          <p style={{ margin: '0 0 0.6rem' }}>
            The{' '}
            <strong style={{ color: PLOTLY_COLORS.secondary }}>
              coral line (Direct PCP)
            </strong>{' '}
            is a 1-strike read with q held at zero. It keeps the spot term
            in the equation, so it absorbs the dividend yield plus any
            per-strike mark noise sitting in the chain.
          </p>
          <p style={{ margin: '0 0 0.6rem' }}>
            The{' '}
            <strong style={{ color: PLOTLY_COLORS.highlight }}>
              amber line (box minus PCP, right axis)
            </strong>{' '}
            sits near SPX&rsquo;s ~1.3% dividend yield when parity holds
            cleanly. It spikes off that baseline at any expiration where
            one of the four options is mispriced. That spike is the signal.
          </p>
          <p style={{ margin: 0 }}>
            The bottom panel ties it all back to price. The{' '}
            <strong style={{ color: PLOTLY_COLORS.positive }}>
              green line (F(T) forward)
            </strong>{' '}
            is the SPX forward recovered from each expiration&rsquo;s
            options using the box r, and the{' '}
            <strong style={{ color: PLOTLY_COLORS.primarySoft }}>
              dashed reference
            </strong>{' '}
            is SPX spot S₀ at the snapshot. The gap between them is the
            cash-and-carry term — box r net of dividends, in dollars. When
            F(T) tracks S₀·exp(box r · T) the chain is internally
            consistent; when it sags below, the shortfall is the
            market-implied dividend drag.
          </p>
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: mobile ? 'repeat(2, 1fr)' : 'repeat(5, 1fr)',
          gap: '1rem',
          padding: '0.85rem 0',
          borderTop: '1px solid var(--bg-card-border)',
          borderBottom: '1px solid var(--bg-card-border)',
          marginBottom: '0.85rem',
        }}
      >
        <StatCell
          label="Box r"
          value={formatPct(headline?.rBox, 2)}
          sub={headline ? `${headline.expiration} · ${headline.dte.toFixed(1)}d` : '–'}
          accent={PLOTLY_COLORS.primary}
        />
        <StatCell
          label="Direct PCP r"
          value={formatPct(headline?.rPcp, 2)}
          sub="q = 0 assumed"
          accent={PLOTLY_COLORS.secondary}
        />
        <StatCell
          label="Box − PCP · ≈ q"
          value={formatPct(headline?.rDiff, 2)}
          sub={
            diffRange
              ? `range ${formatPct(diffRange.lo, 2)} – ${formatPct(diffRange.hi, 2)}`
              : '–'
          }
          accent={PLOTLY_COLORS.highlight}
        />
        <StatCell
          label="Fwd F(T)"
          value={headline?.fwd ? headline.fwd.toFixed(2) : '–'}
          sub={
            headline?.fwd && data?.spotPrice
              ? `F − S₀ ${headline.fwd - data.spotPrice >= 0 ? '+' : ''}${(headline.fwd - data.spotPrice).toFixed(2)}`
              : 'PCP-implied'
          }
          accent={PLOTLY_COLORS.positive}
        />
        <StatCell
          label="Spot"
          value={data?.spotPrice ? data.spotPrice.toFixed(2) : '–'}
          sub="SPX index"
        />
      </div>

      <div
        role="group"
        aria-label="Chart focus mode"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.4rem',
          flexWrap: 'wrap',
          marginBottom: '0.6rem',
        }}
      >
        <span
          style={{
            fontFamily: 'Courier New, monospace',
            fontSize: '0.7rem',
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--text-secondary)',
            marginRight: '0.25rem',
          }}
        >
          focus
        </span>
        {FOCUS_MODES.map(({ key, label }) => {
          const active = focus === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setFocus(key)}
              aria-pressed={active}
              style={{
                padding: '0.3rem 0.7rem',
                fontFamily: 'Courier New, monospace',
                fontSize: '0.7rem',
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                background: active ? 'var(--text-primary)' : 'transparent',
                color: active ? 'var(--bg-card)' : 'var(--text-primary)',
                border: '1px solid var(--bg-card-border)',
                borderRadius: '4px',
                cursor: 'pointer',
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      <div style={{ position: 'relative' }}>
        <ResetButton visible={dteRange != null} onClick={() => setDteRange(null)} />
        <div ref={chartRef} style={{ width: '100%', height: mobile ? 460 : 560 }} />
        <RangeBrush
          min={0}
          max={dteMaxData}
          activeMin={activeDteRange[0]}
          activeMax={activeDteRange[1]}
          onChange={(newMin, newMax) => setDteRange([newMin, newMax])}
          minWidth={5}
        />
      </div>

      <div
        style={{
          marginTop: '0.75rem',
          fontSize: '0.95rem',
          color: 'var(--text-secondary)',
          lineHeight: 1.65,
        }}
      >
        <p style={{ margin: '0 0 0.6rem', color: 'var(--text-primary)' }}>
          <strong>Reading the chart for edge</strong>
        </p>
        <p style={{ margin: '0 0 0.55rem' }}>
          <strong style={{ color: PLOTLY_COLORS.primary }}>Box r</strong>{' '}
          sitting meaningfully <em>above</em> the treasury rate at matching
          DTE means the box is cheap. <strong>Buy</strong> the box to lend
          synthetically above risk-free and collect the spread to expiry.
        </p>
        <p style={{ margin: '0 0 0.55rem' }}>
          <strong style={{ color: PLOTLY_COLORS.primary }}>Box r</strong>{' '}
          sitting <em>below</em> treasury means the box is rich.{' '}
          <strong>Sell</strong> the box and park the cash in T-bills instead.
        </p>
        <p style={{ margin: '0 0 0.55rem' }}>
          <strong style={{ color: PLOTLY_COLORS.highlight }}>
            Amber line
          </strong>{' '}
          flat near ~1.3% means parity is holding cleanly. Nothing to do.
        </p>
        <p style={{ margin: '0 0 0.55rem' }}>
          <strong style={{ color: PLOTLY_COLORS.highlight }}>
            Amber spiking
          </strong>{' '}
          or kinking at a specific DTE flags per-strike mispricing at that
          expiration. Hover to see which of K₁ or K₂ is the stale leg. If{' '}
          <strong style={{ color: PLOTLY_COLORS.secondary }}>r(K₁)</strong>{' '}
          and{' '}
          <strong style={{ color: PLOTLY_COLORS.secondary }}>r(K₂)</strong>{' '}
          disagree within the same T, the edge is usually a single-contract
          fix.
        </p>
        <p style={{ margin: '0 0 0.55rem' }}>
          <strong style={{ color: PLOTLY_COLORS.positive }}>
            F(T) (bottom panel, green)
          </strong>{' '}
          should climb smoothly above S₀ at a pace that matches box r minus
          the ~1.3% SPX dividend yield. A bent, wavy, or locally-inverted
          F(T) at a specific DTE is the price-domain view of the same leg
          mispricing the amber line flags overhead — the signals rhyme at
          the same expiration, and a clean edge is one where both agree
          about which strike is stale.
        </p>
        <p style={{ margin: 0 }}>
          Sub-7d points are almost always 1/T-amplified mark noise rather
          than real edge. Left-edge spikes are usually safe to ignore.
        </p>
      </div>
    </div>
  );
}
