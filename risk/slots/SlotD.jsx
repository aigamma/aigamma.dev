import { useEffect, useMemo, useRef, useState } from 'react';
import usePlotly from '../../src/hooks/usePlotly';
import useIsMobile from '../../src/hooks/useIsMobile';
import useOptionsData from '../../src/hooks/useOptionsData';
import {
  PLOTLY_COLORS,
  PLOTLY_FONTS,
  plotly2DChartLayout,
  plotlyAxis,
  plotlyTitle,
} from '../../src/lib/plotlyTheme';
import { daysToExpiration, pickDefaultExpiration, filterPickerExpirations } from '../../src/lib/dates';

// -----------------------------------------------------------------------------
// Second-Order Greeks.
//
// The first-order Greeks (delta, gamma, vega, theta) are every desk's
// bread-and-butter P&L drivers. The second-order Greeks describe how
// those drivers move when the market moves — the "risk of the risk"
// that a vol trader carries. Three of them dominate the SPX book:
//
//   Vanna  = ∂²C/∂S∂σ = ∂Δ/∂σ
//            How much delta changes when vol changes. On a put-skewed
//            index this is why a delta-neutral book at one vol level
//            is not delta-neutral at another. Vanna trades show up
//            every time the market bends its smile.
//
//   Volga  = ∂²C/∂σ² = ∂Vega/∂σ
//            Convexity of vega against vol. Long volga books make
//            money when implied vol moves in either direction. Short
//            volga books (sold wings to harvest premium) lose when
//            vol spikes. Also called "vomma".
//
//   Charm  = -∂Δ/∂T
//            The bleed of delta through calendar time. A delta-hedged
//            book today is not delta-hedged tomorrow even if spot and
//            vol do not move, because delta moves on its own schedule
//            as expiration approaches. The hedge needs daily refresh
//            and charm is the refresh amount.
//
// All three are analytic BSM Greeks evaluated at the market-implied
// volatility for each strike, so the shapes reflect the interaction
// between the standard BSM formulas and the actual SPX smile rather
// than a flat-vol assumption. Each Greek has a characteristic
// signature across strikes at one expiration: vanna changes sign near
// ATM, volga peaks in the wings, charm peaks near ATM and bleeds
// through opposite signs on either side of the forward.
//
// This slot is the analytic complement to the Vanna-Volga Decomposition
// in Slot C. Slot C uses the three second-order Greeks as hedge-match
// constraints at three anchor strikes. Slot D draws them out
// continuously across every strike so the reader can see how the hedge
// burden varies with moneyness, not just at the three pivots.
// -----------------------------------------------------------------------------

const RATE_R = 0.045;
const RATE_Q = 0.013;

// ---- BSM analytic ---------------------------------------------------------

function phi(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}
function Phi(x) {
  const a1 = 0.31938153;
  const a2 = -0.356563782;
  const a3 = 1.781477937;
  const a4 = -1.821255978;
  const a5 = 1.330274429;
  const k = 1 / (1 + 0.2316419 * Math.abs(x));
  const w = 1 - phi(x) * (a1*k + a2*k*k + a3*k*k*k + a4*k*k*k*k + a5*k*k*k*k*k);
  return x >= 0 ? w : 1 - w;
}
function bsmD1(S, K, T, r, q, sigma) {
  const vsT = sigma * Math.sqrt(T);
  return (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / vsT;
}

// Vanna = -e^(-qT)·φ(d1)·d2/σ. Dimensionless per 1.0 σ.
function bsmVanna(S, K, T, r, q, sigma) {
  if (!(sigma > 0) || !(T > 0)) return 0;
  const d1 = bsmD1(S, K, T, r, q, sigma);
  const d2 = d1 - sigma * Math.sqrt(T);
  return -Math.exp(-q * T) * phi(d1) * d2 / sigma;
}

// Volga = S·e^(-qT)·φ(d1)·√T·d1·d2/σ. Per 1.0 σ², same units as vega.
function bsmVolga(S, K, T, r, q, sigma) {
  if (!(sigma > 0) || !(T > 0)) return 0;
  const d1 = bsmD1(S, K, T, r, q, sigma);
  const d2 = d1 - sigma * Math.sqrt(T);
  return S * Math.exp(-q * T) * phi(d1) * Math.sqrt(T) * d1 * d2 / sigma;
}

// Charm = -∂Δ/∂T, per year. Signed so that charm > 0 means delta is moving
// toward the contract's natural end-state (0 for OTM, ±1 for ITM) as time
// passes.
function bsmCharm(S, K, T, r, q, sigma, type) {
  if (!(sigma > 0) || !(T > 0)) return 0;
  const sqrtT = Math.sqrt(T);
  const d1 = bsmD1(S, K, T, r, q, sigma);
  const d2 = d1 - sigma * sqrtT;
  const common = Math.exp(-q * T) * phi(d1) * (2 * (r - q) * T - d2 * sigma * sqrtT) / (2 * T * sigma * sqrtT);
  if (type === 'put') {
    return -q * Math.exp(-q * T) * Phi(-d1) - common;
  }
  return q * Math.exp(-q * T) * Phi(d1) - common;
}

// ---- Slice extraction ------------------------------------------------------

function sliceObservations(contracts, expiration, spotPrice) {
  if (!contracts || !expiration || !(spotPrice > 0)) return [];
  const byStrike = new Map();
  for (const c of contracts) {
    if (c.expiration_date !== expiration) continue;
    const k = c.strike_price;
    if (k == null) continue;
    const type = c.contract_type?.toLowerCase();
    if (type !== 'call' && type !== 'put') continue;
    if (!(c.close_price > 0)) continue;
    if (!(c.implied_volatility > 0)) continue;
    if (!byStrike.has(k)) byStrike.set(k, { call: null, put: null });
    byStrike.get(k)[type] = c;
  }
  const rows = [];
  for (const [strike, { call, put }] of byStrike) {
    const src = strike >= spotPrice ? call : put;
    if (!src) continue;
    rows.push({ strike, iv: src.implied_volatility, side: strike >= spotPrice ? 'call' : 'put' });
  }
  rows.sort((a, b) => a.strike - b.strike);
  return rows.filter((r) => Math.abs(Math.log(r.strike / spotPrice)) <= 0.2);
}

function ivInterp(obs, k) {
  if (k <= obs[0].k) return obs[0].iv;
  if (k >= obs[obs.length - 1].k) return obs[obs.length - 1].iv;
  for (let i = 0; i < obs.length - 1; i++) {
    if (k >= obs[i].k && k <= obs[i + 1].k) {
      const span = obs[i + 1].k - obs[i].k;
      const wt = span > 0 ? (k - obs[i].k) / span : 0;
      return obs[i].iv * (1 - wt) + obs[i + 1].iv * wt;
    }
  }
  return obs[0].iv;
}

// ---- UI ------------------------------------------------------------------

function formatFixed(v, d = 4) {
  if (v == null || !Number.isFinite(v)) return '-';
  return v.toFixed(d);
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
          fontSize: '1.2rem',
          color: accent || 'var(--text-primary)',
        }}
      >
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginTop: '0.2rem' }}>
          {sub}
        </div>
      )}
    </div>
  );
}

const GREEK_CHOICES = [
  { id: 'vanna', label: 'Vanna', axis: 'Vanna (delta change per vol)', tickformat: '.3f', color: PLOTLY_COLORS.primary },
  { id: 'volga', label: 'Volga', axis: 'Volga (vega change per vol)', tickformat: '.1f', color: PLOTLY_COLORS.highlight },
  { id: 'charm', label: 'Charm', axis: 'Charm (delta drift per year)', tickformat: '.3f', color: PLOTLY_COLORS.secondary },
];

export default function SlotD() {
  const chartRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();
  const mobile = useIsMobile();
  const { data, loading, error } = useOptionsData({
    underlying: 'SPX',
    snapshotType: 'intraday',
  });

  const defaultExpiration = useMemo(() => {
    if (!data?.expirations) return null;
    const eligible = filterPickerExpirations(data.expirations, data.capturedAt);
    return pickDefaultExpiration(eligible, data.capturedAt);
  }, [data]);

  const [expiration, setExpiration] = useState(null);
  const [greek, setGreek] = useState('vanna');
  const activeExp = expiration || defaultExpiration;

  const slice = useMemo(() => {
    if (!data || !activeExp) return [];
    return sliceObservations(data.contracts, activeExp, data.spotPrice);
  }, [data, activeExp]);

  const dte = useMemo(() => {
    if (!activeExp || !data?.capturedAt) return null;
    return daysToExpiration(activeExp, data.capturedAt);
  }, [activeExp, data]);
  const T = dte != null ? dte / 365 : null;

  const curves = useMemo(() => {
    if (!data || !slice.length || !T || T <= 0) return null;
    const S = data.spotPrice;
    const obs = slice.map((r) => ({ k: Math.log(r.strike / S), iv: r.iv })).sort((a, b) => a.k - b.k);
    const Ks = slice.map((r) => r.strike);
    const Klo = Math.min(...Ks);
    const Khi = Math.max(...Ks);
    const nGrid = 96;
    const strikes = new Array(nGrid);
    const vanna = new Array(nGrid);
    const volga = new Array(nGrid);
    const charm = new Array(nGrid);
    for (let i = 0; i < nGrid; i++) {
      const K = Klo + (i / (nGrid - 1)) * (Khi - Klo);
      strikes[i] = K;
      const sigma = ivInterp(obs, Math.log(K / S));
      const type = K >= S ? 'call' : 'put';
      vanna[i] = bsmVanna(S, K, T, RATE_R, RATE_Q, sigma);
      volga[i] = bsmVolga(S, K, T, RATE_R, RATE_Q, sigma);
      charm[i] = bsmCharm(S, K, T, RATE_R, RATE_Q, sigma, type);
    }
    return { strikes, vanna, volga, charm };
  }, [data, slice, T]);

  useEffect(() => {
    if (!Plotly || !chartRef.current || !curves || !data) return;
    const { strikes } = curves;
    const greekDef = GREEK_CHOICES.find((g) => g.id === greek);
    const yValues = curves[greek];

    const traces = [
      {
        x: strikes,
        y: yValues,
        mode: 'lines',
        name: greekDef.label,
        line: { color: greekDef.color, width: 2.5 },
        fill: 'tozeroy',
        fillcolor: `${greekDef.color}22`,
        hovertemplate: `K %{x}<br>${greekDef.label} %{y:${greekDef.tickformat}}<extra></extra>`,
      },
      {
        x: [data.spotPrice, data.spotPrice],
        y: [-1e6, 1e6],
        mode: 'lines',
        name: 'spot',
        line: { color: PLOTLY_COLORS.axisText, width: 1, dash: 'dot' },
        hoverinfo: 'skip',
        showlegend: false,
      },
      {
        x: [strikes[0], strikes[strikes.length - 1]],
        y: [0, 0],
        mode: 'lines',
        name: 'zero',
        line: { color: PLOTLY_COLORS.zeroLine, width: 1 },
        hoverinfo: 'skip',
        showlegend: false,
      },
    ];

    const allY = yValues.filter(Number.isFinite);
    const yMin = Math.min(...allY, 0);
    const yMax = Math.max(...allY, 0);
    const pad = (yMax - yMin) * 0.12 || 0.01;

    const layout = plotly2DChartLayout({
      title: {
        ...plotlyTitle(`${greekDef.label} across strikes · SPX`),
        y: 0.97,
        yref: 'container',
        yanchor: 'top',
      },
      margin: mobile ? { t: 50, r: 25, b: 85, l: 65 } : { t: 70, r: 35, b: 100, l: 80 },
      xaxis: plotlyAxis('Strike'),
      yaxis: plotlyAxis(greekDef.axis, {
        range: [yMin - pad, yMax + pad],
        autorange: false,
        tickformat: greekDef.tickformat,
      }),
      showlegend: true,
      legend: {
        orientation: 'h',
        y: -0.22,
        x: 0.5,
        xanchor: 'center',
        font: PLOTLY_FONTS.legend,
      },
      hovermode: 'closest',
    });

    Plotly.react(chartRef.current, traces, layout, {
      responsive: true,
      displayModeBar: false,
    });
  }, [Plotly, curves, greek, data, mobile]);

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

  const pickerExpirations = data?.expirations
    ? filterPickerExpirations(data.expirations, data.capturedAt)
    : [];

  const atmVals = (() => {
    if (!curves || !data) return null;
    const idx = curves.strikes.reduce((best, K, i) => {
      return Math.abs(K - data.spotPrice) < Math.abs(curves.strikes[best] - data.spotPrice) ? i : best;
    }, 0);
    return { vanna: curves.vanna[idx], volga: curves.volga[idx], charm: curves.charm[idx] };
  })();

  const extremes = (() => {
    if (!curves) return null;
    const arr = curves[greek];
    let min = { v: Infinity, K: null };
    let max = { v: -Infinity, K: null };
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] < min.v) { min.v = arr[i]; min.K = curves.strikes[i]; }
      if (arr[i] > max.v) { max.v = arr[i]; max.K = curves.strikes[i]; }
    }
    return { min, max };
  })();

  return (
    <div className="card" style={{ padding: '1.25rem 1.25rem 1rem' }}>
      <div
        style={{
          fontFamily: 'Courier New, monospace',
          fontSize: '0.7rem',
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--accent-amber)',
          marginBottom: '0.85rem',
        }}
      >
        second-order greeks · vanna / volga / charm across strikes
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          flexWrap: 'wrap',
          marginBottom: '0.75rem',
        }}
      >
        <label
          style={{
            fontSize: '0.72rem',
            color: 'var(--text-secondary)',
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
          }}
        >
          Expiration:
        </label>
        <select
          value={activeExp || ''}
          onChange={(e) => setExpiration(e.target.value)}
          style={{
            background: 'var(--bg-card)',
            color: 'var(--text-primary)',
            border: '1px solid var(--bg-card-border)',
            padding: '0.3rem 0.5rem',
            fontFamily: 'Courier New, monospace',
            fontSize: '0.85rem',
          }}
        >
          {pickerExpirations.map((e) => (
            <option key={e} value={e}>{e}</option>
          ))}
        </select>
        <label
          style={{
            fontSize: '0.72rem',
            color: 'var(--text-secondary)',
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
            marginLeft: '0.5rem',
          }}
        >
          Greek:
        </label>
        <select
          value={greek}
          onChange={(e) => setGreek(e.target.value)}
          style={{
            background: 'var(--bg-card)',
            color: 'var(--text-primary)',
            border: '1px solid var(--bg-card-border)',
            padding: '0.3rem 0.5rem',
            fontFamily: 'Courier New, monospace',
            fontSize: '0.85rem',
          }}
        >
          {GREEK_CHOICES.map((g) => (
            <option key={g.id} value={g.id}>{g.label}</option>
          ))}
        </select>
        <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
          DTE {dte != null ? dte.toFixed(1) : '-'} · {slice.length} strikes ·{' '}
          spot {data?.spotPrice != null ? data.spotPrice.toFixed(2) : '-'}
        </span>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: mobile ? 'repeat(2, 1fr)' : 'repeat(5, 1fr)',
          gap: '0.85rem',
          padding: '0.75rem 0',
          borderTop: '1px solid var(--bg-card-border)',
          borderBottom: '1px solid var(--bg-card-border)',
          marginBottom: '0.85rem',
        }}
      >
        <StatCell
          label="ATM vanna"
          value={atmVals ? formatFixed(atmVals.vanna, 4) : '-'}
          sub="delta change per vol bump"
          accent={PLOTLY_COLORS.primary}
        />
        <StatCell
          label="ATM volga"
          value={atmVals ? formatFixed(atmVals.volga, 1) : '-'}
          sub="vega change per vol bump"
          accent={PLOTLY_COLORS.highlight}
        />
        <StatCell
          label="ATM charm"
          value={atmVals ? formatFixed(atmVals.charm, 4) : '-'}
          sub="daily delta drift at spot"
          accent={PLOTLY_COLORS.secondary}
        />
        <StatCell
          label={`Peak ${greek}`}
          value={extremes ? formatFixed(extremes.max.v, 3) : '-'}
          sub={extremes && extremes.max.K != null
            ? `at K ${extremes.max.K.toFixed(0)} (${data && extremes.max.K > data.spotPrice ? 'call side' : 'put side'})`
            : '-'}
        />
        <StatCell
          label={`Trough ${greek}`}
          value={extremes ? formatFixed(extremes.min.v, 3) : '-'}
          sub={extremes && extremes.min.K != null
            ? `at K ${extremes.min.K.toFixed(0)} (${data && extremes.min.K > data.spotPrice ? 'call side' : 'put side'})`
            : '-'}
        />
      </div>

      <div ref={chartRef} style={{ width: '100%', height: mobile ? 400 : 480 }} />

      <div
        style={{
          marginTop: '0.8rem',
          fontSize: '0.9rem',
          color: 'var(--text-secondary)',
          lineHeight: 1.65,
        }}
      >
        <p style={{ margin: '0 0 0.75rem' }}>
          First-order Greeks (delta, gamma, vega, theta) are every desk's
          bread-and-butter PnL drivers. The second-order Greeks describe how
          those first-order drivers move when the market moves. Three of
          them dominate the SPX book:{' '}
          <strong style={{ color: PLOTLY_COLORS.primary }}>vanna</strong>,{' '}
          <strong style={{ color: PLOTLY_COLORS.highlight }}>volga</strong>, and{' '}
          <strong style={{ color: PLOTLY_COLORS.secondary }}>charm</strong>.
          Each one is worth real money per week on an options book, and each
          has a signature shape across strikes that the chart reveals.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          <strong style={{ color: PLOTLY_COLORS.primary }}>Vanna</strong>{' '}
          is how much delta changes when vol changes. On a put-skewed index
          a delta-neutral book at 15% vol is not delta-neutral at 20% vol.
          Vanna is why a vol rally quietly re-skews every delta hedge in
          the book. The signature shape is near zero at ATM, flips sign at
          the forward, and peaks roughly one standard deviation out into
          each wing.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          <strong style={{ color: PLOTLY_COLORS.highlight }}>Volga</strong>{' '}
          is the convexity of vega to vol. A long-volga book gains from
          vol moves in either direction. A short-volga book (classic
          short-premium structures sitting at the ATM trough) loses on
          vol spikes. Volga is small at ATM, positive in both wings, and
          tallest where deep-OTM options still carry meaningful vega.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          <strong style={{ color: PLOTLY_COLORS.secondary }}>Charm</strong>{' '}
          is the daily bleed of delta through calendar time. Even in a
          perfectly quiet market the delta of an option moves by a small
          amount every day because time-to-expiry is shrinking. Charm is
          the refresh amount a delta-hedged book needs each session, and
          the magnitude grows as expiration approaches.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          The chart plots the selected Greek at every strike on the
          current slice, evaluated at the market implied vol for that
          strike. Switch Greeks with the dropdown. The stat row reports
          the ATM value and the peak and trough locations on either side
          of spot. The fill color below the line makes the sign obvious
          at a glance.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          <strong style={{ color: 'var(--text-primary)' }}>Practical use.</strong>{' '}
          Vanna is the "quiet re-hedge" number. Any vol move silently
          shifts your delta. For a short-put book hedged with short
          stock, a vol spike pushes put delta further from zero, your
          position delta grows more positive, and you have to sell more
          stock into a falling tape to stay neutral. That is the mechanism
          behind classic short-vol carnage on SPX: vol gaps up, short-put
          delta explodes, the short-vol crowd is forced to sell stock in
          thin tape, which accelerates the drop. Reading the vanna curve
          on your current slice tells you where on the strike ladder this
          feedback is sharpest, which is where the tail risk on a
          short-premium book actually lives.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          Volga is the "vol convexity" number and it maps directly onto
          the premium-selling versus premium-buying trade choice. Short
          ATM straddles sit in the volga trough and collect theta cheaply,
          but any reasonable vol move in either direction pulls premium
          back out of the pocket. Long wings sit high on the volga
          shoulders and pay off on a vol regime change. The volga curve
          here shows where wing premium is really worth something versus
          where the ATM trough can be harvested for theta without outsized
          tail risk.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          Charm is the "you still have to hedge every day" number. For a
          long-dated book it is small and predictable, and a weekly
          rebalance picks it up with no drama. For a short-dated book
          (weekly expiry, especially 0DTE) charm grows fast and flips sign
          on the far side of the forward, so a delta-hedged position at
          3pm is not delta-hedged at 3:30pm even if nothing in the market
          has moved. Traders running 0DTE SPX structures see the charm
          term dominate hedge PnL in the final session, and the right
          refresh cadence on the last day is hourly rather than daily.
        </p>
        <p style={{ margin: 0 }}>
          Where the peak of the displayed Greek sits is itself information.
          When the peak sits close to spot, second-order risk is
          concentrated near the ATM strike and a delta-hedged book can
          carry fewer strikes before it runs out of risk budget. When the
          peak sits far into a wing, the tail of the book is doing most
          of the work and structure-of-wings choices (which OTM strikes
          to own or sell) matter more than ATM sizing. The typical SPX
          pattern is vanna positive on the call side and negative on the
          put side with the biggest magnitude in the put wing, volga
          positive on both wings with a mild asymmetry toward puts, and
          charm positive at ATM that flips sign a short distance into
          each wing.
        </p>
      </div>
    </div>
  );
}
