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
// Put-call parity — box-spread implied rate
//
// Alpha-stage proof of concept, prompted by a Discord request to surface
// put-call parity on the platform. The original ask had two shapes on the
// table: (a) chart LHS/RHS as a ratio over time, where 1.00 is the
// equilibrium and drifts out of 1 are arbitrage or data-artifact signals,
// and (b) solve the parity equation for the borrow rate r and chart that
// over time against a Fed-funds-futures reference (ZQ) as a ground truth.
//
// With only a single current snapshot of the chain we can't chart either
// one "over time" — that needs a persisted series, which is a separate
// piece of work. What we can do right now, honestly, is the cross-section:
// compute the options-implied borrow rate at every listed expiration in
// the current snapshot and render the term structure. That answers the
// same underlying question ("is put-call parity holding, and at what r?")
// from the shape of the curve instead of from its history.
//
// The math is the classic box-spread reduction of put-call parity. For
// any two strikes K1 < K2 at a common expiration T, a long synthetic at
// K1 plus a short synthetic at K2 pays K2 - K1 at expiry with zero
// dependence on the terminal spot, so its cost today is:
//
//     box_cost = (C(K1) - P(K1)) - (C(K2) - P(K2))
//
// and put-call parity requires
//
//     box_cost = (K2 - K1) · exp(-r·T)
//
// which inverts to
//
//     r = (1 / T) · ln( (K2 - K1) / box_cost ).
//
// The dividend yield drops out because the spot-driven e^(-qT) term is the
// same on both synthetic legs and cancels. So this is a model-free read on
// the market-implied borrow rate; any assumption about the SPX dividend
// yield is unnecessary. Short-dated points are the most sensitive to
// microstructure noise because T is in the denominator, so we filter 0DTE
// and the very-short sub-1-day expirations out before plotting.
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

// Pick the tightest strike pair that brackets spot from both sides. Using
// the nearest bracket gives the most liquid strikes at the cost of the
// smallest (K2 - K1) denominator in the implied-rate solve; a wider bracket
// is more numerically stable but risks pulling in thinner strikes on the
// wings. ATM-tight is the right default here because SPX near-the-money is
// the deepest liquidity on the board.
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

function computeBoxRateSeries(contracts, spotPrice, capturedAt) {
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
    const spread = K2 - K1;
    if (!(boxCost > 0) || !(spread > 0)) continue;

    const r = (1 / T) * Math.log(spread / boxCost);
    if (!Number.isFinite(r)) continue;

    rows.push({ expiration, dte, T, K1, K2, C1, P1, C2, P2, boxCost, r });
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

export const slotName = 'PUT-CALL PARITY · BOX-SPREAD IMPLIED RATE';

export default function SlotB() {
  const chartRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();
  const mobile = useIsMobile();
  const [dteRange, setDteRange] = useState(null);
  const { data, loading, error } = useOptionsData({
    underlying: 'SPX',
    snapshotType: 'intraday',
  });

  const rows = useMemo(
    () => computeBoxRateSeries(data?.contracts, data?.spotPrice, data?.capturedAt),
    [data],
  );

  const medianR = useMemo(() => (rows.length ? median(rows.map((r) => r.r)) : null), [rows]);

  // Stable data-driven max for the RangeBrush. The chart's visible
  // x-axis range is driven by `dteRange` (null = full window); the
  // brush itself anchors against this immutable data max so the track
  // does not resize as the user drags handles.
  const dteMaxData = useMemo(() => {
    if (rows.length === 0) return 1;
    return Math.max(...rows.map((r) => r.dte)) * 1.04 + 1;
  }, [rows]);
  const activeDteRange = dteRange || [0, dteMaxData];

  // Headline: prefer the first expiration ≥ 7 DTE so the displayed number
  // isn't skewed by the short-dated noise at the left edge of the curve.
  const headline = useMemo(() => rows.find((r) => r.dte >= 7) || rows[0] || null, [rows]);

  useEffect(() => {
    if (!Plotly || !chartRef.current || rows.length === 0) return;

    const xs = rows.map((r) => r.dte);
    const ys = rows.map((r) => r.r * 100);

    const hoverText = rows.map(
      (r) =>
        [
          `<b>${r.expiration}</b>`,
          `DTE ${r.dte.toFixed(1)}`,
          `K₁ ${r.K1.toLocaleString()} · K₂ ${r.K2.toLocaleString()}`,
          `C₁ ${r.C1.toFixed(2)} · P₁ ${r.P1.toFixed(2)}`,
          `C₂ ${r.C2.toFixed(2)} · P₂ ${r.P2.toFixed(2)}`,
          `box $${r.boxCost.toFixed(2)} · spread ${r.K2 - r.K1}`,
          `<b>r ${(r.r * 100).toFixed(3)}%</b>`,
        ].join('<br>'),
    );

    const xMin = activeDteRange[0];
    const xMax = activeDteRange[1];
    const yMin = Math.min(...ys);
    const yMax = Math.max(...ys);
    const ySpan = yMax - yMin;
    const yPad = ySpan > 0 ? ySpan * 0.15 : Math.abs(yMin) * 0.2 || 0.5;

    const traces = [
      {
        x: xs,
        y: ys,
        mode: 'lines+markers',
        type: 'scatter',
        line: { color: PLOTLY_COLORS.primary, width: 1.25 },
        marker: { color: PLOTLY_COLORS.primary, size: mobile ? 6 : 8, line: { width: 0 } },
        hoverinfo: 'text',
        text: hoverText,
        showlegend: false,
      },
    ];

    const shapes = [];
    const annotations = [];
    if (medianR != null) {
      const medianPct = medianR * 100;
      shapes.push({
        type: 'line',
        xref: 'x',
        yref: 'y',
        x0: xMin,
        x1: xMax,
        y0: medianPct,
        y1: medianPct,
        line: { color: PLOTLY_COLORS.highlight, width: 1, dash: 'dash' },
      });
      annotations.push({
        x: xMax,
        y: medianPct,
        xref: 'x',
        yref: 'y',
        xanchor: 'right',
        yanchor: 'bottom',
        text: `median ${medianPct.toFixed(2)}%`,
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

    const layout = plotly2DChartLayout({
      title: {
        ...plotlyTitle('Put-Call Parity · Box-Spread Implied Rate'),
        y: 0.97,
        yref: 'container',
        yanchor: 'top',
      },
      margin: mobile ? { t: 50, r: 20, b: 55, l: 60 } : { t: 70, r: 30, b: 60, l: 75 },
      xaxis: plotlyAxis('Days to Expiration', { range: [xMin, xMax], autorange: false }),
      yaxis: plotlyAxis('Implied r (%)', {
        range: [yMin - yPad, yMax + yPad],
        autorange: false,
        ticksuffix: '%',
        tickformat: '.2f',
      }),
      shapes,
      annotations,
      showlegend: false,
      hovermode: 'closest',
    });

    Plotly.react(chartRef.current, traces, layout, {
      responsive: true,
      displayModeBar: false,
    });
  }, [Plotly, rows, medianR, mobile, activeDteRange[0], activeDteRange[1]]);

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
          bracketing the spot price to compute a box-spread implied rate.
        </div>
      </div>
    );
  }

  const rangeR = {
    lo: Math.min(...rows.map((r) => r.r)),
    hi: Math.max(...rows.map((r) => r.r)),
  };

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
          model · put-call parity
        </div>
        <div
          style={{
            fontSize: '0.88rem',
            color: 'var(--text-secondary)',
            lineHeight: 1.6,
            maxWidth: '720px',
          }}
        >
          <p style={{ margin: '0 0 0.55rem' }}>
            Options-implied borrow rate at every SPX expiration, computed
            from a 4-leg box spread at the tightest strike bracket around
            spot. The term structure is the curve of those rates by DTE.
          </p>
          <p style={{ margin: 0 }}>
            The{' '}
            <strong style={{ color: PLOTLY_COLORS.primary }}>
              blue dots
            </strong>{' '}
            are the implied rate at each expiration. Points <em>above</em>{' '}
            the matching treasury yield mean the box is cheap and buying it
            captures the spread to expiry. Points <em>below</em> treasury
            mean the box is rich and holding T-bills beats it. Flat, close
            to treasury across DTEs means parity is holding cleanly and
            there is nothing to do.
          </p>
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
          label="Nearest r"
          value={formatPct(headline?.r, 2)}
          sub={headline ? `${headline.expiration} · ${headline.dte.toFixed(1)}d` : '–'}
          accent={PLOTLY_COLORS.primary}
        />
        <StatCell
          label="Median r"
          value={formatPct(medianR, 2)}
          sub={`${rows.length} expirations`}
          accent={PLOTLY_COLORS.highlight}
        />
        <StatCell
          label="Range"
          value={`${(rangeR.lo * 100).toFixed(2)}% – ${(rangeR.hi * 100).toFixed(2)}%`}
          sub={`spread ${((rangeR.hi - rangeR.lo) * 100).toFixed(2)}%`}
        />
        <StatCell
          label="Spot"
          value={data?.spotPrice ? data.spotPrice.toFixed(2) : '–'}
          sub="SPX index"
        />
      </div>

      <div style={{ position: 'relative' }}>
        <ResetButton visible={dteRange != null} onClick={() => setDteRange(null)} />
        <div ref={chartRef} style={{ width: '100%', height: mobile ? 320 : 420 }} />
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
          marginTop: '0.65rem',
          fontSize: '0.75rem',
          color: 'var(--text-secondary)',
          lineHeight: 1.6,
        }}
      >
        <p style={{ margin: '0 0 0.4rem' }}>
          Hover any point for strikes, option marks, and box cost.
        </p>
        <p style={{ margin: '0 0 0.4rem' }}>
          Short-dated points are the noisiest because the 1/T factor
          magnifies mark error at low DTE. The left edge should be read
          with that in mind.
        </p>
        <p style={{ margin: 0 }}>
          The flatter the curve, the more consistently parity is holding
          across the board.
        </p>
      </div>
    </div>
  );
}
