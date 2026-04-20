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
// Vanna-Volga Decomposition.
//
// Castagna & Mercurio (2007). Three anchor strikes — the 25-delta put, the
// ATM straddle, and the 25-delta call — pin the smile. For any other strike
// K, the VV-reconstructed price is a Black-Scholes price at the ATM vol
// plus three weighted corrections that force vega, vanna, and volga of the
// hedge portfolio to match those of the target option:
//
//   C_VV(K) = C_BSM(K, σ_ATM)
//           + Σ_i x_i(K) · [ C_BSM(K_i, σ_mkt,i) − C_BSM(K_i, σ_ATM) ]
//
// with weights { x_p(K), x_atm(K), x_c(K) } solving the linear system
//
//   Σ_i x_i(K) · G(K_i, σ_ATM) = G(K, σ_ATM)     for G ∈ {vega, vanna, volga}
//
// The three equations pin the three Greeks. The approach comes from FX
// trading desks where the three anchor quotes (25ΔP, ATM, 25ΔC) are the
// liquid objects and every other strike is backed out from them. Applied
// to SPX the decomposition exposes how much of the smile's deviation from
// the ATM-flat world is vega (symmetric wing lift), vanna (sensitivity of
// delta to vol — the leverage effect), and volga (sensitivity of vega to
// vol — the wing-of-wings convexity).
//
// The reconstructed price is then inverted back to an implied vol via
// Newton's method on BSM, giving σ_VV(K). At the three anchor strikes
// σ_VV exactly equals the market vol by construction. Between anchors the
// VV line is a smoothed interpolation; outside the anchor band it is an
// extrapolation that bends off the wing because the three-Greek match
// cannot capture the fourth moment.
//
// The two derived quantities printed in the stat row are the same ones
// FX desks use to quote the smile:
//
//   Risk Reversal (RR)   = σ(25ΔC) − σ(25ΔP)     asymmetry of the smile
//   Butterfly     (BF)   = (σ(25ΔC) + σ(25ΔP))/2 − σ(ATM)   wing convexity
//
// On SPX the RR is deeply negative (put skew) and the BF is positive
// (fat tails on both wings). The VV reconstruction reproduces those two
// numbers exactly and lets the reader watch how the full smile curve
// extends off the anchors.
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
function bsmCall(S, K, T, r, q, sigma) {
  if (!(sigma > 0) || !(T > 0)) return Math.max(S * Math.exp(-q * T) - K * Math.exp(-r * T), 0);
  const d1 = bsmD1(S, K, T, r, q, sigma);
  const d2 = d1 - sigma * Math.sqrt(T);
  return S * Math.exp(-q * T) * Phi(d1) - K * Math.exp(-r * T) * Phi(d2);
}
function bsmPut(S, K, T, r, q, sigma) {
  const c = bsmCall(S, K, T, r, q, sigma);
  return c - S * Math.exp(-q * T) + K * Math.exp(-r * T);
}
function bsmVega(S, K, T, r, q, sigma) {
  if (!(sigma > 0) || !(T > 0)) return 0;
  const d1 = bsmD1(S, K, T, r, q, sigma);
  return S * Math.exp(-q * T) * phi(d1) * Math.sqrt(T);
}
function bsmVanna(S, K, T, r, q, sigma) {
  if (!(sigma > 0) || !(T > 0)) return 0;
  const d1 = bsmD1(S, K, T, r, q, sigma);
  const d2 = d1 - sigma * Math.sqrt(T);
  return -Math.exp(-q * T) * phi(d1) * d2 / sigma;
}
function bsmVolga(S, K, T, r, q, sigma) {
  if (!(sigma > 0) || !(T > 0)) return 0;
  const d1 = bsmD1(S, K, T, r, q, sigma);
  const d2 = d1 - sigma * Math.sqrt(T);
  return S * Math.exp(-q * T) * phi(d1) * Math.sqrt(T) * d1 * d2 / sigma;
}
function bsmCallDelta(S, K, T, r, q, sigma) {
  if (!(sigma > 0) || !(T > 0)) return 0;
  const d1 = bsmD1(S, K, T, r, q, sigma);
  return Math.exp(-q * T) * Phi(d1);
}
function bsmPutDelta(S, K, T, r, q, sigma) {
  return bsmCallDelta(S, K, T, r, q, sigma) - Math.exp(-q * T);
}
function bsmIv(price, S, K, T, r, q, type = 'call') {
  const intrinsic = type === 'call'
    ? Math.max(S * Math.exp(-q * T) - K * Math.exp(-r * T), 0)
    : Math.max(K * Math.exp(-r * T) - S * Math.exp(-q * T), 0);
  if (!(price > intrinsic - 1e-10)) return null;
  let sigma = 0.25;
  for (let it = 0; it < 60; it++) {
    const p = type === 'call'
      ? bsmCall(S, K, T, r, q, sigma)
      : bsmPut(S, K, T, r, q, sigma);
    const v = bsmVega(S, K, T, r, q, sigma);
    const diff = p - price;
    if (Math.abs(diff) < 1e-7) return sigma;
    if (!(v > 1e-10)) break;
    sigma -= diff / v;
    if (sigma < 1e-4) sigma = 1e-4;
    if (sigma > 5) sigma = 5;
  }
  return sigma > 0 && sigma < 5 ? sigma : null;
}

// ---- 3x3 linear solve (Cramer) --------------------------------------------

function det3(m) {
  return (
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  );
}
function solve3x3(A, b) {
  const D = det3(A);
  if (Math.abs(D) < 1e-14) return null;
  const replaceCol = (col) => A.map((row, i) => row.map((v, j) => (j === col ? b[i] : v)));
  const x0 = det3(replaceCol(0)) / D;
  const x1 = det3(replaceCol(1)) / D;
  const x2 = det3(replaceCol(2)) / D;
  return [x0, x1, x2];
}

// ---- Slice extraction ------------------------------------------------------
// Pull the OTM leg at every strike; the IV is the same either side of the
// forward by put-call parity, so taking the OTM quote avoids intrinsic
// dominance without any loss of smile information.

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
    const otm = strike >= spotPrice ? call : put;
    if (!otm) continue;
    rows.push({
      strike,
      iv: otm.implied_volatility,
      type: strike >= spotPrice ? 'call' : 'put',
    });
  }
  rows.sort((a, b) => a.strike - b.strike);
  return rows.filter((r) => Math.abs(Math.log(r.strike / spotPrice)) <= 0.25);
}

function ivAtStrike(slice, S0, K) {
  if (!slice.length) return null;
  const target = Math.log(K / S0);
  const obs = slice.map((r) => ({ k: Math.log(r.strike / S0), iv: r.iv }));
  obs.sort((a, b) => a.k - b.k);
  if (target <= obs[0].k) return obs[0].iv;
  if (target >= obs[obs.length - 1].k) return obs[obs.length - 1].iv;
  for (let i = 0; i < obs.length - 1; i++) {
    if (target >= obs[i].k && target <= obs[i + 1].k) {
      const span = obs[i + 1].k - obs[i].k;
      const wt = span > 0 ? (target - obs[i].k) / span : 0;
      return obs[i].iv * (1 - wt) + obs[i + 1].iv * wt;
    }
  }
  return null;
}

// ---- Anchor strike detection ----------------------------------------------
// ATM anchor: the strike nearest to forward F (equivalently, 50-delta
// forward). 25ΔP / 25ΔC anchors: walk the interpolated IV curve and bisect
// on target call-delta 0.25 (call anchor) and put-delta −0.25 (put anchor).

function findAnchorStrikes(slice, S, T, r, q) {
  if (!slice.length || !(T > 0)) return null;
  const F = S * Math.exp((r - q) * T);

  // ATM anchor on forward
  let atmStrike = slice[0].strike;
  let atmDist = Infinity;
  for (const r0 of slice) {
    const d = Math.abs(r0.strike - F);
    if (d < atmDist) { atmDist = d; atmStrike = r0.strike; }
  }
  const atmIv = ivAtStrike(slice, S, atmStrike);
  if (!(atmIv > 0)) return null;

  // Bisect on delta. Scan a dense K grid and find the strike where
  //   target call-delta is 0.25 → 25ΔC anchor
  //   target put-delta is −0.25 → 25ΔP anchor
  const kLo = slice[0].strike;
  const kHi = slice[slice.length - 1].strike;
  const steps = 201;
  let callAnchor = null;
  let putAnchor = null;
  let bestCallDist = Infinity;
  let bestPutDist = Infinity;
  for (let i = 0; i < steps; i++) {
    const K = kLo + (i / (steps - 1)) * (kHi - kLo);
    const iv = ivAtStrike(slice, S, K);
    if (!(iv > 0)) continue;
    if (K >= F) {
      const cd = bsmCallDelta(S, K, T, r, q, iv);
      const dist = Math.abs(cd - 0.25);
      if (dist < bestCallDist) { bestCallDist = dist; callAnchor = { strike: K, iv, delta: cd }; }
    }
    if (K <= F) {
      const pd = bsmPutDelta(S, K, T, r, q, iv);
      const dist = Math.abs(pd - (-0.25));
      if (dist < bestPutDist) { bestPutDist = dist; putAnchor = { strike: K, iv, delta: pd }; }
    }
  }
  if (!callAnchor || !putAnchor) return null;
  return {
    atm:  { strike: atmStrike, iv: atmIv, forward: F },
    call: callAnchor,
    put:  putAnchor,
  };
}

// ---- VV reconstruction ----------------------------------------------------
// Returns { sigmaVV, priceVV, weights } at one target strike K.

function vannaVolgaReconstruct(S, K, T, r, q, anchors, targetType) {
  const { atm, call, put } = anchors;
  const sigmaATM = atm.iv;
  const Ks = [put.strike, atm.strike, call.strike];
  const sigmas = [put.iv, atm.iv, call.iv];
  const A = [
    Ks.map((Ki) => bsmVega(S, Ki, T, r, q, sigmaATM)),
    Ks.map((Ki) => bsmVanna(S, Ki, T, r, q, sigmaATM)),
    Ks.map((Ki) => bsmVolga(S, Ki, T, r, q, sigmaATM)),
  ];
  const b = [
    bsmVega(S, K, T, r, q, sigmaATM),
    bsmVanna(S, K, T, r, q, sigmaATM),
    bsmVolga(S, K, T, r, q, sigmaATM),
  ];
  const x = solve3x3(A, b);
  if (!x) return null;
  const baseCall = bsmCall(S, K, T, r, q, sigmaATM);
  let correction = 0;
  for (let i = 0; i < 3; i++) {
    correction += x[i] * (bsmCall(S, Ks[i], T, r, q, sigmas[i]) - bsmCall(S, Ks[i], T, r, q, sigmaATM));
  }
  const callPrice = baseCall + correction;
  const finalPrice = targetType === 'put'
    ? callPrice - S * Math.exp(-q * T) + K * Math.exp(-r * T)
    : callPrice;
  const sigmaVV = bsmIv(finalPrice, S, K, T, r, q, targetType);
  return {
    sigmaVV,
    priceVV: finalPrice,
    weights: { put: x[0], atm: x[1], call: x[2] },
  };
}

// ---- UI ------------------------------------------------------------------

function formatPct(v, d = 2) {
  if (v == null || !Number.isFinite(v)) return '-';
  return `${(v * 100).toFixed(d)}%`;
}
function formatBp(v, d = 0) {
  if (v == null || !Number.isFinite(v)) return '-';
  return `${(v * 10000).toFixed(d)} bp`;
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

export default function SlotC() {
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

  const anchors = useMemo(() => {
    if (!data || !T || T <= 0 || slice.length < 6) return null;
    return findAnchorStrikes(slice, data.spotPrice, T, RATE_R, RATE_Q);
  }, [data, T, slice]);

  const curves = useMemo(() => {
    if (!data || !slice.length || !anchors || !T) return null;
    const S = data.spotPrice;
    const Ks = slice.map((r) => r.strike);
    const kLo = Math.min(...Ks);
    const kHi = Math.max(...Ks);
    const nGrid = 64;
    const strikes = new Array(nGrid);
    const sigmaVVArr = new Array(nGrid);
    for (let i = 0; i < nGrid; i++) {
      const K = kLo + (i / (nGrid - 1)) * (kHi - kLo);
      strikes[i] = K;
      const type = K >= anchors.atm.forward ? 'call' : 'put';
      const rec = vannaVolgaReconstruct(S, K, T, RATE_R, RATE_Q, anchors, type);
      sigmaVVArr[i] = rec?.sigmaVV ?? null;
    }
    // Fit-quality: RMSE of σ_VV vs observed σ at the actual listed strikes.
    let sse = 0;
    let n = 0;
    for (const obs of slice) {
      const type = obs.strike >= anchors.atm.forward ? 'call' : 'put';
      const rec = vannaVolgaReconstruct(S, obs.strike, T, RATE_R, RATE_Q, anchors, type);
      if (rec && rec.sigmaVV != null) {
        const d = rec.sigmaVV - obs.iv;
        sse += d * d;
        n++;
      }
    }
    const rmse = n > 0 ? Math.sqrt(sse / n) : null;
    return { strikes, sigmaVVArr, rmse };
  }, [data, slice, anchors, T]);

  useEffect(() => {
    if (!Plotly || !chartRef.current || !curves || !slice.length || !anchors || !data) return;
    const { strikes, sigmaVVArr } = curves;

    const traces = [
      {
        x: slice.map((r) => r.strike),
        y: slice.map((r) => r.iv),
        mode: 'markers',
        name: 'Market IV',
        marker: {
          color: PLOTLY_COLORS.axisText,
          size: mobile ? 5 : 6,
          line: { width: 0 },
        },
        hovertemplate: 'K %{x}<br>σ_mkt %{y:.2%}<extra></extra>',
      },
      {
        x: strikes,
        y: sigmaVVArr,
        mode: 'lines',
        name: 'VV reconstruction',
        line: { color: PLOTLY_COLORS.primary, width: 2.5 },
        hovertemplate: 'K %{x}<br>σ_VV %{y:.2%}<extra></extra>',
        connectgaps: false,
      },
      // Three anchor markers
      {
        x: [anchors.put.strike],
        y: [anchors.put.iv],
        mode: 'markers',
        name: '25ΔP anchor',
        marker: {
          color: PLOTLY_COLORS.secondary,
          size: mobile ? 11 : 13,
          symbol: 'diamond',
          line: { color: PLOTLY_COLORS.titleText, width: 1 },
        },
        hovertemplate: 'K %{x}<br>σ(25ΔP) %{y:.2%}<extra></extra>',
      },
      {
        x: [anchors.atm.strike],
        y: [anchors.atm.iv],
        mode: 'markers',
        name: 'ATM anchor',
        marker: {
          color: PLOTLY_COLORS.highlight,
          size: mobile ? 11 : 13,
          symbol: 'diamond',
          line: { color: PLOTLY_COLORS.titleText, width: 1 },
        },
        hovertemplate: 'K %{x}<br>σ(ATM) %{y:.2%}<extra></extra>',
      },
      {
        x: [anchors.call.strike],
        y: [anchors.call.iv],
        mode: 'markers',
        name: '25ΔC anchor',
        marker: {
          color: PLOTLY_COLORS.positive,
          size: mobile ? 11 : 13,
          symbol: 'diamond',
          line: { color: PLOTLY_COLORS.titleText, width: 1 },
        },
        hovertemplate: 'K %{x}<br>σ(25ΔC) %{y:.2%}<extra></extra>',
      },
      {
        x: [data.spotPrice, data.spotPrice],
        y: [0, 10],
        mode: 'lines',
        name: 'spot',
        line: { color: PLOTLY_COLORS.axisText, width: 1, dash: 'dot' },
        hoverinfo: 'skip',
        showlegend: false,
      },
    ];

    const allY = [
      ...slice.map((r) => r.iv),
      ...sigmaVVArr.filter(Number.isFinite),
      anchors.atm.iv,
      anchors.call.iv,
      anchors.put.iv,
    ];
    const yMin = Math.min(...allY);
    const yMax = Math.max(...allY);
    const pad = (yMax - yMin) * 0.15 || 0.01;

    const layout = plotly2DChartLayout({
      title: {
        ...plotlyTitle('Vanna-Volga smile reconstruction · SPX'),
        y: 0.97,
        yref: 'container',
        yanchor: 'top',
      },
      margin: mobile ? { t: 50, r: 25, b: 95, l: 65 } : { t: 70, r: 35, b: 110, l: 80 },
      xaxis: plotlyAxis('Strike'),
      yaxis: plotlyAxis('Implied vol', {
        range: [Math.max(0, yMin - pad), yMax + pad],
        autorange: false,
        tickformat: '.1%',
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
  }, [Plotly, curves, slice, anchors, data, mobile]);

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

  const rr = anchors ? anchors.call.iv - anchors.put.iv : null;
  const bf = anchors ? 0.5 * (anchors.call.iv + anchors.put.iv) - anchors.atm.iv : null;

  return (
    <div className="card" style={{ padding: '1.25rem 1.25rem 1rem' }}>
      <div
        style={{
          fontFamily: 'Courier New, monospace',
          fontSize: '0.7rem',
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--text-secondary)',
          marginBottom: '0.85rem',
        }}
      >
        model · vanna-volga · three-anchor smile reconstruction
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
        <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
          DTE {dte != null ? dte.toFixed(1) : '-'} · {slice.length} strikes ·{' '}
          F = {anchors ? anchors.atm.forward.toFixed(2) : '-'}
        </span>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: mobile ? 'repeat(2, 1fr)' : 'repeat(6, 1fr)',
          gap: '0.85rem',
          padding: '0.75rem 0',
          borderTop: '1px solid var(--bg-card-border)',
          borderBottom: '1px solid var(--bg-card-border)',
          marginBottom: '0.85rem',
        }}
      >
        <StatCell
          label="σ(25ΔP)"
          value={anchors ? formatPct(anchors.put.iv, 2) : '-'}
          sub={anchors ? `K ${anchors.put.strike.toFixed(0)}` : '-'}
          accent={PLOTLY_COLORS.secondary}
        />
        <StatCell
          label="σ(ATM)"
          value={anchors ? formatPct(anchors.atm.iv, 2) : '-'}
          sub={anchors ? `K ${anchors.atm.strike.toFixed(0)}` : '-'}
          accent={PLOTLY_COLORS.highlight}
        />
        <StatCell
          label="σ(25ΔC)"
          value={anchors ? formatPct(anchors.call.iv, 2) : '-'}
          sub={anchors ? `K ${anchors.call.strike.toFixed(0)}` : '-'}
          accent={PLOTLY_COLORS.positive}
        />
        <StatCell
          label="Risk Reversal"
          value={rr != null ? formatBp(rr, 0) : '-'}
          sub="25ΔC minus 25ΔP"
          accent={rr != null && rr < 0 ? PLOTLY_COLORS.secondary : PLOTLY_COLORS.positive}
        />
        <StatCell
          label="Butterfly"
          value={bf != null ? formatBp(bf, 0) : '-'}
          sub="wings minus ATM"
          accent={bf != null && bf > 0 ? PLOTLY_COLORS.highlight : undefined}
        />
        <StatCell
          label="VV fit RMSE"
          value={curves?.rmse != null ? formatPct(curves.rmse, 2) : '-'}
          sub="in IV-space"
          accent={curves?.rmse != null && curves.rmse < 0.015 ? PLOTLY_COLORS.positive : undefined}
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
          The Vanna-Volga method pins the smile with three anchor strikes.
          The{' '}
          <strong style={{ color: PLOTLY_COLORS.secondary }}>25-delta put</strong>,
          the{' '}
          <strong style={{ color: PLOTLY_COLORS.highlight }}>ATM straddle</strong>,
          and the{' '}
          <strong style={{ color: PLOTLY_COLORS.positive }}>25-delta call</strong>{' '}
          carry the bulk of options liquidity on an FX desk. Every other
          strike is priced as a Black-Scholes baseline at the ATM vol plus
          three correction terms that match the vega, vanna, and volga of
          the target option against a basket of the three anchors.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          The{' '}
          <strong style={{ color: PLOTLY_COLORS.primary }}>blue line</strong>{' '}
          is the reconstructed implied-vol smile. It passes through all
          three colored diamond anchors exactly by construction. The
          grey dots are the listed market IVs at every strike on the
          current SPX slice. The gap between the grey dots and the blue
          line is how much of the observed smile is not explained by the
          three-Greek match at the anchors.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          Two derived numbers from the anchors describe the smile's
          shape. The{' '}
          <strong>Risk Reversal (RR)</strong> is σ(25ΔC) minus σ(25ΔP),
          which measures asymmetry. On SPX it is deeply negative because
          puts are more expensive than equally out-of-the-money calls.
          The{' '}
          <strong>Butterfly (BF)</strong> is the average of the two wing
          vols minus the ATM vol, which measures convexity. A positive
          BF means the market prices fat tails on both sides.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          The VV reconstruction is a local second-order approximation.
          Between the anchors it bends naturally along the smile. Outside
          the anchor band the line is an extrapolation built on the
          three-Greek match and it can drift off the observed wing. The
          RMSE at the bottom of the stat row measures that drift across
          the listed strikes.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          <strong style={{ color: 'var(--text-primary)' }}>Reading.</strong>{' '}
          The three diamonds are where the reconstruction is pinned. The
          blue line leaves the ATM diamond and bends toward the 25-delta
          wings, picking up curvature on the way. The amount of bend
          depends on the Risk Reversal and the Butterfly alone: RR
          controls tilt, BF controls convexity.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          A{' '}
          <strong style={{ color: PLOTLY_COLORS.secondary }}>large negative RR</strong>{' '}
          is the SPX leverage signal. It says the market charges more
          premium for downside protection than for an equally-out-of-
          the-money call, which is the vanna dimension of the smile.
          When RR gets more negative the blue line tilts further to the
          left wing and the put-anchor diamond rides visibly above the
          call-anchor diamond.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          A{' '}
          <strong style={{ color: PLOTLY_COLORS.highlight }}>large positive BF</strong>{' '}
          is the fat-tails signal. It says the market prices both wings
          above the ATM vol, which is the volga dimension of the smile.
          When BF grows the blue line arcs up toward both sides and the
          ATM diamond sits in a visible trough below the two wing
          diamonds.
        </p>
        <p style={{ margin: 0 }}>
          The{' '}
          <strong style={{ color: PLOTLY_COLORS.primary }}>VV fit RMSE</strong>{' '}
          is how well a three-parameter local model captures every listed
          strike in the slice. Low RMSE means the smile really is driven
          by RR and BF and is close to a clean three-anchor picture.
          Elevated RMSE means higher-order effects are in play that
          need a full smile fit like SVI to capture.
        </p>
      </div>
    </div>
  );
}
