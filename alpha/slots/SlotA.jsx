import { useEffect, useMemo, useRef } from 'react';
import usePlotly from '../../src/hooks/usePlotly';
import useIsMobile from '../../src/hooks/useIsMobile';
import useOptionsData from '../../src/hooks/useOptionsData';
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
// Put-call parity — box-spread r vs direct-PCP r at q = 0
//
// Alpha-stage, v2 of the put-call-parity card prompted by sflush in Discord.
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
// With only a current snapshot this is a cross-sectional view: how the two
// methods disagree across expirations at a single moment. The richer time-
// series view — how each method's r wobbles from snapshot to snapshot as
// S₀ moves between 5-minute ingests — needs a persisted series and is a
// separate piece of work; sketched at the bottom of the card as the
// natural next step.
// -----------------------------------------------------------------------------

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

    rows.push({
      expiration, dte, T,
      K1, K2, C1, P1, C2, P2,
      boxCost, strikeSpread,
      rBox, rPcp, rPcp1, rPcp2, rDiff, rPcpSpread,
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
  if (v == null || !Number.isFinite(v)) return '—';
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

export default function SlotA() {
  const chartRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();
  const mobile = useIsMobile();
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

  // Headline picks the first expiration ≥ 7 DTE so the displayed numbers
  // aren't skewed by the short-dated noise at the left edge of the curve,
  // which is where 1/T magnifies mark error the most.
  const headline = useMemo(() => rows.find((r) => r.dte >= 7) || rows[0] || null, [rows]);

  useEffect(() => {
    if (!Plotly || !chartRef.current || rows.length === 0) return;

    const xs = rows.map((r) => r.dte);
    const yBox = rows.map((r) => r.rBox * 100);
    const yPcp = rows.map((r) => (r.rPcp != null ? r.rPcp * 100 : null));
    const yDiff = rows.map((r) => (r.rDiff != null ? r.rDiff * 100 : null));

    const xMin = 0;
    const xMax = Math.max(...xs) * 1.04 + 1;

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
        xshift: -4,
        yshift: 2,
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
        ? { t: 50, r: 55, b: 95, l: 60 }
        : { t: 70, r: 75, b: 105, l: 75 },
      xaxis: plotlyAxis('Days to Expiration', { range: [xMin, xMax], autorange: false }),
      yaxis: plotlyAxis('r (%)', {
        range: [yMin - yPad, yMax + yPad],
        autorange: false,
        ticksuffix: '%',
        tickformat: '.2f',
      }),
      yaxis2: plotlyAxis('q ≈ box − PCP (%)', {
        range: [y2Min - y2Pad, y2Max + y2Pad],
        autorange: false,
        overlaying: 'y',
        side: 'right',
        showgrid: false,
        ticksuffix: '%',
        tickformat: '.2f',
      }),
      shapes,
      annotations,
      hovermode: 'closest',
      showlegend: true,
      legend: {
        orientation: 'h',
        y: -0.22,
        x: 0.5,
        xanchor: 'center',
        font: PLOTLY_FONTS.legend,
      },
    });

    Plotly.react(chartRef.current, traces, layout, {
      responsive: true,
      displayModeBar: false,
    });
  }, [Plotly, rows, medianDiff, mobile]);

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
            fontSize: '0.88rem',
            color: 'var(--text-secondary)',
            lineHeight: 1.55,
            maxWidth: '820px',
          }}
        >
          Two implied borrow-rate reads from the same SPX chain.{' '}
          <strong style={{ color: PLOTLY_COLORS.primary }}>Box</strong>{' '}
          (blue, 4-leg) is the stable fair-rate reference — the construction
          cancels spot, so the number does not drift when the market moves.{' '}
          <strong style={{ color: PLOTLY_COLORS.secondary }}>Direct PCP</strong>{' '}
          (coral, 1-strike with q held at zero) keeps the spot term in the
          equation, so it absorbs the dividend yield plus whatever per-strike
          mark noise is sitting in the chain.{' '}
          <strong style={{ color: PLOTLY_COLORS.highlight }}>Their gap</strong>{' '}
          (amber, right axis) sits near SPX&rsquo;s ~1.3% dividend yield when
          parity is holding cleanly, and spikes off that flat baseline at any
          expiration where one of the four options is mispriced — which is
          where the edge lives, since the box&rsquo;s own smoothness is exactly
          what hides those mispricings from the main dashboard.
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: mobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)',
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
          sub={headline ? `${headline.expiration} · ${headline.dte.toFixed(1)}d` : '—'}
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
              : '—'
          }
          accent={PLOTLY_COLORS.highlight}
        />
        <StatCell
          label="Spot"
          value={data?.spotPrice ? data.spotPrice.toFixed(2) : '—'}
          sub="SPX index"
        />
      </div>

      <div ref={chartRef} style={{ width: '100%', height: mobile ? 380 : 480 }} />

      <div
        style={{
          marginTop: '0.65rem',
          fontSize: '0.75rem',
          color: 'var(--text-secondary)',
          lineHeight: 1.6,
        }}
      >
        <strong style={{ color: 'var(--text-primary)' }}>
          Reading the chart for edge.
        </strong>{' '}
        Box r meaningfully <em>above</em> the treasury rate at matching DTE
        → boxes are cheap: <strong>buy</strong> to lend synthetically above
        risk-free and collect the spread to expiry. Box r <em>below</em>{' '}
        treasury → boxes are rich: <strong>sell</strong> and park the cash
        in T-bills instead. Amber line flat near ~1.3% = parity is holding
        cleanly, nothing to do. Amber spiking or kinking at a specific DTE
        = per-strike mispricing at that expiration; hover to see whether K₁
        or K₂ is the stale leg and whether r(K₁) and r(K₂) disagree within
        the same T — a disagreement there is often a single-contract fix.
        The slope of the blue line is the implied term structure of the
        borrow rate, so reading calendar edge off it cleanly needs a
        treasury-curve overlay (natural next addition). Sub-7d points are
        almost always 1/T-amplified mark noise rather than real edge, so
        the left-edge spikes are usually safe to ignore. Full math behind
        each line will move to an informational dropdown in a later pass.
      </div>
    </div>
  );
}
