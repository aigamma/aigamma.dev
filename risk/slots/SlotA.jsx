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
// Cross-Model Greeks.
//
// Three option-pricing models, one SPX slice, one Greek at a time:
//
//   BSM       Black-Scholes-Merton. Log-normal spot, constant vol. The
//             industry baseline for every market-maker quote screen and
//             the model whose delta/gamma/vega the Massive feed ingests
//             directly. Analytic Greeks from standard formulas.
//
//   Bachelier Arithmetic / normal model. dS = σ dW with σ in price
//             units, not percent. Used historically for bond-option
//             desks and resurrected during the 2020 negative-oil-price
//             episode when the log-normal assumption broke. Near ATM
//             the Bachelier Greeks collapse onto the BSM Greeks. In
//             the wings they diverge because the normal distribution
//             has thinner tails than log-normal.
//
//   Heston    Stochastic variance, calibrated on the same slice. Greeks
//             by finite difference on the characteristic-function call
//             price. Carries smile dynamics that BSM and Bachelier by
//             construction do not. The Heston-BSM gap is therefore a
//             quantitative read of "how much of my Greek comes from
//             assuming vol is flat versus stochastic".
//
// The chart shows the selected Greek (delta, gamma, or vega) across
// strikes under all three models. The reader takeaway is how much
// the hedge you carry depends on the model you embed in the hedge
// ratio, not just on the market quote itself.
// -----------------------------------------------------------------------------

const RATE_R = 0.045;
const RATE_Q = 0.013;
const INT_N = 160;
const INT_U_MAX = 120;
const NM_MAX_ITERS = 200;
const FD_BUMP_S = 1.0;        // finite-difference spot bump for Heston delta / gamma
const FD_BUMP_SIGMA = 0.01;   // finite-difference vol bump for Heston vega

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
function bsmVega(S, K, T, r, q, sigma) {
  if (!(sigma > 0) || !(T > 0)) return 0;
  const d1 = bsmD1(S, K, T, r, q, sigma);
  return S * Math.exp(-q * T) * phi(d1) * Math.sqrt(T);
}
function bsmIv(price, S, K, T, r, q) {
  const intrinsic = Math.max(S * Math.exp(-q * T) - K * Math.exp(-r * T), 0);
  if (!(price > intrinsic)) return null;
  let sigma = 0.25;
  for (let it = 0; it < 40; it++) {
    const c = bsmCall(S, K, T, r, q, sigma);
    const v = bsmVega(S, K, T, r, q, sigma);
    const diff = c - price;
    if (Math.abs(diff) < 1e-7) return sigma;
    if (!(v > 1e-10)) break;
    sigma -= diff / v;
    if (sigma < 1e-4) sigma = 1e-4;
    if (sigma > 5) sigma = 5;
  }
  return sigma > 0 && sigma < 5 ? sigma : null;
}
function bsmGreeks(S, K, T, r, q, sigma, type) {
  if (!(sigma > 0) || !(T > 0)) return { delta: 0, gamma: 0, vega: 0 };
  const sqrtT = Math.sqrt(T);
  const d1 = bsmD1(S, K, T, r, q, sigma);
  const eqT = Math.exp(-q * T);
  const callDelta = eqT * Phi(d1);
  const delta = type === 'put' ? callDelta - eqT : callDelta;
  const gamma = (eqT * phi(d1)) / (S * sigma * sqrtT);
  const vega = S * eqT * phi(d1) * sqrtT;
  return { delta, gamma, vega };
}

// ---- Bachelier analytic ---------------------------------------------------
// Bachelier uses a normal spot process dS = σ_N dW where σ_N carries the
// same price units as S. Converting a BSM σ_LN into a Bachelier σ_N that
// prices the same ATM forward call is the standard textbook identity
//
//     σ_N ≈ σ_LN · F · exp(−d1²/2) · √(2π) / (2 · √(T))  ≈ σ_LN · F · (1 + ...)
//
// At ATM (F = K, d1 → 0.5·σ_LN·√T) the leading term is σ_N ≈ σ_LN · F,
// which is the version used below — accurate to about 1% for SPX
// equity-index vol levels. The approximation keeps the cross-model
// comparison focused on the model assumption, not on a second-order
// vol-rescaling wart.

function bachelierGreeks(S, K, T, r, q, sigmaLN, type) {
  if (!(sigmaLN > 0) || !(T > 0)) return { delta: 0, gamma: 0, vega: 0 };
  // Bachelier Greeks are on the forward F; convert to spot by multiplying by
  // the discount factor e^(−qT) for delta and gamma. Vega is expressed with
  // respect to σ_LN (so it stays on the same scale as BSM vega) using the
  // chain rule ∂C/∂σ_LN = ∂C/∂σ_N · F.
  const F = S * Math.exp((r - q) * T);
  const sigmaN = sigmaLN * F;
  const sT = sigmaN * Math.sqrt(T);
  const d = (F - K) / sT;
  const disc = Math.exp(-r * T);
  const N_d = Phi(d);
  const n_d = phi(d);
  const callDelta = disc * Math.exp((r - q) * T) * N_d;   // e^(−qT) · N(d)
  const putDelta = callDelta - Math.exp(-q * T);
  const delta = type === 'put' ? putDelta : callDelta;
  const gamma = (disc * Math.exp((r - q) * T) * n_d) / sT;
  // ∂C/∂σ_N = √T · φ(d). Convert to σ_LN: ∂/∂σ_LN = F · √T · φ(d) · e^(−rT)
  const vega = F * disc * n_d * Math.sqrt(T);
  return { delta, gamma, vega };
}

// ---- Heston pricing (Little-Trap characteristic function) ---------------

function cAdd(a, b) { return [a[0] + b[0], a[1] + b[1]]; }
function cSub(a, b) { return [a[0] - b[0], a[1] - b[1]]; }
function cMul(a, b) { return [a[0]*b[0] - a[1]*b[1], a[0]*b[1] + a[1]*b[0]]; }
function cDiv(a, b) {
  const denom = b[0]*b[0] + b[1]*b[1];
  return [(a[0]*b[0] + a[1]*b[1]) / denom, (a[1]*b[0] - a[0]*b[1]) / denom];
}
function cScale(a, s) { return [a[0]*s, a[1]*s]; }
function cExp(a) {
  const m = Math.exp(a[0]);
  return [m * Math.cos(a[1]), m * Math.sin(a[1])];
}
function cLog(a) {
  return [0.5 * Math.log(a[0]*a[0] + a[1]*a[1]), Math.atan2(a[1], a[0])];
}
function cSqrt(a) {
  const r = Math.sqrt(a[0]*a[0] + a[1]*a[1]);
  const re = Math.sqrt(0.5 * (r + a[0]));
  const im = Math.sign(a[1] || 1) * Math.sqrt(0.5 * (r - a[0]));
  return [re, im];
}
function hestonCf(u, j, params, S0, T, r, q) {
  const { kappa, theta, xi, rho, v0 } = params;
  const bj = j === 1 ? kappa - rho * xi : kappa;
  const uj = j === 1 ? 0.5 : -0.5;
  const iu = [0, u];
  const rhoXi = rho * xi;
  const a = [-bj, rhoXi * u];
  const aSquared = cMul(a, a);
  const disc = cSub(aSquared, [-xi*xi * u*u, 2*xi*xi * uj * u]);
  const d = cSqrt(disc);
  const bMinusA = [bj, -rhoXi * u];
  const num = cSub(bMinusA, d);
  const den = cAdd(bMinusA, d);
  const g = cDiv(num, den);
  const edT = cExp(cScale(d, -T));
  const one = [1, 0];
  const n1 = cSub(one, cMul(g, edT));
  const n2 = cSub(one, g);
  const ratio = cDiv(n1, n2);
  const logRatio = cLog(ratio);
  const rmq_iu_T = cScale(iu, (r - q) * T);
  const term = cSub(cScale(num, T), cScale(logRatio, 2));
  const Cj = cAdd(rmq_iu_T, cScale(term, (kappa * theta) / (xi * xi)));
  const numer = cSub(one, edT);
  const denom = cSub(one, cMul(g, edT));
  const Dj = cMul(cScale(num, 1 / (xi * xi)), cDiv(numer, denom));
  const iuLogS = cScale(iu, Math.log(S0));
  const exponent = cAdd(cAdd(Cj, cScale(Dj, v0)), iuLogS);
  return cExp(exponent);
}
const U_GRID = new Float64Array(INT_N);
const U_WEIGHTS = new Float64Array(INT_N);
{
  const h = INT_U_MAX / (INT_N - 1);
  for (let i = 0; i < INT_N; i++) U_GRID[i] = Math.max(1e-6, i * h);
  for (let i = 0; i < INT_N; i++) {
    let w;
    if (i === 0 || i === INT_N - 1) w = 1;
    else if (i % 2 === 1) w = 4;
    else w = 2;
    U_WEIGHTS[i] = (w * h) / 3;
  }
}
function hestonProb(j, params, S0, K, T, r, q) {
  const logK = Math.log(K);
  let acc = 0;
  for (let i = 0; i < INT_N; i++) {
    const u = U_GRID[i];
    const f = hestonCf(u, j, params, S0, T, r, q);
    const eNegIu = [Math.cos(u * logK), -Math.sin(u * logK)];
    const num = cMul(eNegIu, f);
    const re = num[1] / u;
    acc += U_WEIGHTS[i] * re;
  }
  return 0.5 + acc / Math.PI;
}
function hestonCall(params, S0, K, T, r, q) {
  const P1 = hestonProb(1, params, S0, K, T, r, q);
  const P2 = hestonProb(2, params, S0, K, T, r, q);
  return S0 * Math.exp(-q * T) * P1 - K * Math.exp(-r * T) * P2;
}
// Heston Greeks by finite difference. The characteristic-function call is
// smooth in S, v0, and T, and the integrand truncation is far enough out
// (INT_U_MAX = 120) that the numerical noise floor is well below the FD
// bump-induced error at typical SPX spot / vol scales.
function hestonGreeks(params, S0, K, T, r, q, type) {
  const hS = FD_BUMP_S;
  const hSig = FD_BUMP_SIGMA;
  const c0 = hestonCall(params, S0, K, T, r, q);
  const cUp = hestonCall(params, S0 + hS, K, T, r, q);
  const cDn = hestonCall(params, S0 - hS, K, T, r, q);
  const callDelta = (cUp - cDn) / (2 * hS);
  const gamma = (cUp - 2 * c0 + cDn) / (hS * hS);
  // Vega: bump √v0 so the derivative is ∂C/∂σ where σ = √v0 (match the BSM
  // scale). dV0 ≈ 2·σ·hSig; use chain rule.
  const sigma0 = Math.sqrt(params.v0);
  const vPlus = (sigma0 + hSig) ** 2;
  const vMinus = Math.max((sigma0 - hSig) ** 2, 1e-8);
  const cvPlus = hestonCall({ ...params, v0: vPlus }, S0, K, T, r, q);
  const cvMinus = hestonCall({ ...params, v0: vMinus }, S0, K, T, r, q);
  const vega = (cvPlus - cvMinus) / (2 * hSig);
  const delta = type === 'put' ? callDelta - Math.exp(-q * T) : callDelta;
  return { delta, gamma, vega };
}

// ---- Heston calibration (same machinery as the stochastic lab) -----------

function unpack(theta) {
  return {
    kappa: Math.exp(theta[0]),
    theta: Math.exp(theta[1]),
    xi: Math.exp(theta[2]),
    rho: Math.tanh(theta[3]),
    v0: Math.exp(theta[4]),
  };
}
function pack(p) {
  return [
    Math.log(Math.max(p.kappa, 1e-4)),
    Math.log(Math.max(p.theta, 1e-6)),
    Math.log(Math.max(p.xi, 1e-4)),
    Math.atanh(Math.max(-0.999, Math.min(0.999, p.rho))),
    Math.log(Math.max(p.v0, 1e-6)),
  ];
}
function nelderMead(f, x0, { maxIters = 200, tol = 1e-8, step = 0.15 } = {}) {
  const n = x0.length;
  const alpha = 1;
  const beta = 1 + 2 / n;
  const gamma = 0.75 - 1 / (2 * n);
  const delta = 1 - 1 / n;
  const simplex = [x0.slice()];
  for (let i = 0; i < n; i++) {
    const x = x0.slice();
    x[i] += step * (Math.abs(x0[i]) > 0.5 ? x0[i] : 1);
    simplex.push(x);
  }
  let values = simplex.map(f);
  for (let iters = 0; iters < maxIters; iters++) {
    const idx = [...Array(n + 1).keys()].sort((a, b) => values[a] - values[b]);
    const ordered = idx.map((i) => simplex[i]);
    const valOrdered = idx.map((i) => values[i]);
    for (let i = 0; i <= n; i++) { simplex[i] = ordered[i]; values[i] = valOrdered[i]; }
    if (Math.abs(values[n] - values[0]) < tol) break;
    const centroid = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) centroid[j] += simplex[i][j];
    }
    for (let j = 0; j < n; j++) centroid[j] /= n;
    const xr = centroid.map((c, j) => c + alpha * (c - simplex[n][j]));
    const fr = f(xr);
    if (fr < values[0]) {
      const xe = centroid.map((c, j) => c + beta * (xr[j] - c));
      const fe = f(xe);
      if (fe < fr) { simplex[n] = xe; values[n] = fe; } else { simplex[n] = xr; values[n] = fr; }
    } else if (fr < values[n - 1]) {
      simplex[n] = xr; values[n] = fr;
    } else {
      const outside = fr < values[n];
      const xc = outside
        ? centroid.map((c, j) => c + gamma * (xr[j] - c))
        : centroid.map((c, j) => c + gamma * (simplex[n][j] - c));
      const fc = f(xc);
      if (fc < (outside ? fr : values[n])) { simplex[n] = xc; values[n] = fc; }
      else {
        for (let i = 1; i <= n; i++) {
          simplex[i] = simplex[0].map((x0j, j) => x0j + delta * (simplex[i][j] - x0j));
          values[i] = f(simplex[i]);
        }
      }
    }
  }
  const bestIdx = values.indexOf(Math.min(...values));
  return { x: simplex[bestIdx], value: values[bestIdx] };
}

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

function calibrateHeston(slice, S0, T, r, q, init) {
  const obj = (theta) => {
    const p = unpack(theta);
    if (p.kappa > 50 || p.theta > 1 || p.xi > 3 || p.v0 > 1) return 1e6;
    let sse = 0;
    let n = 0;
    for (const { strike, iv } of slice) {
      const c = hestonCall(p, S0, strike, T, r, q);
      const modelIv = bsmIv(c, S0, strike, T, r, q);
      if (modelIv == null || !Number.isFinite(modelIv)) return 1e6;
      const diff = modelIv - iv;
      sse += diff * diff;
      n++;
    }
    return n > 0 ? sse / n : 1e6;
  };
  const x0 = pack(init);
  const res = nelderMead(obj, x0, { maxIters: NM_MAX_ITERS, tol: 1e-8, step: 0.15 });
  return { params: unpack(res.x), rmse: Math.sqrt(res.value) };
}
const INIT_PARAMS = { kappa: 2.0, theta: 0.04, xi: 0.4, rho: -0.7, v0: 0.04 };

// ---- UI ------------------------------------------------------------------

function formatPct(v, d = 2) {
  if (v == null || !Number.isFinite(v)) return '-';
  return `${(v * 100).toFixed(d)}%`;
}
function formatFixed(v, d = 3) {
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
  { id: 'delta', label: 'Delta', axis: 'Δ', tickformat: '.3f' },
  { id: 'gamma', label: 'Gamma', axis: 'Γ (per $)', tickformat: '.4f' },
  { id: 'vega', label: 'Vega', axis: 'V (per 1.00 σ)', tickformat: '.1f' },
];

export default function SlotA() {
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
  const [greek, setGreek] = useState('delta');
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

  const calib = useMemo(() => {
    if (!data || !activeExp || slice.length < 6 || !T || T <= 0) return null;
    return calibrateHeston(slice, data.spotPrice, T, RATE_R, RATE_Q, INIT_PARAMS);
  }, [data, activeExp, slice, T]);

  const curves = useMemo(() => {
    if (!data || !slice.length || !T || !calib) return null;
    const S0 = data.spotPrice;
    // Interpolate IV across observed strikes so BSM / Bachelier Greeks can
    // evaluate on the same grid as the Heston Greeks. Piecewise linear in
    // log-moneyness is plenty for Greek visualisation; the wings do not
    // need the arbitrage-free structure an SVI would add.
    const obs = slice.map((r) => ({ k: Math.log(r.strike / S0), iv: r.iv }));
    obs.sort((a, b) => a.k - b.k);
    function ivAt(K) {
      const k = Math.log(K / S0);
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
    const Ks = slice.map((r) => r.strike);
    const Klo = Math.min(...Ks);
    const Khi = Math.max(...Ks);
    const nGrid = 48;
    const strikes = new Array(nGrid);
    const bsm = new Array(nGrid);
    const bach = new Array(nGrid);
    const hest = new Array(nGrid);
    for (let i = 0; i < nGrid; i++) {
      const K = Klo + (i / (nGrid - 1)) * (Khi - Klo);
      strikes[i] = K;
      const type = K >= S0 ? 'call' : 'put';
      const sigma = ivAt(K);
      bsm[i] = bsmGreeks(S0, K, T, RATE_R, RATE_Q, sigma, type);
      bach[i] = bachelierGreeks(S0, K, T, RATE_R, RATE_Q, sigma, type);
      hest[i] = hestonGreeks(calib.params, S0, K, T, RATE_R, RATE_Q, type);
    }
    return { strikes, bsm, bach, hest };
  }, [data, slice, T, calib]);

  useEffect(() => {
    if (!Plotly || !chartRef.current || !curves || !data) return;
    const { strikes, bsm, bach, hest } = curves;
    const pick = (arr) => arr.map((g) => g[greek]);
    const greekDef = GREEK_CHOICES.find((g) => g.id === greek);

    const traces = [
      {
        x: strikes,
        y: pick(bsm),
        mode: 'lines',
        name: 'BSM · log-normal',
        line: { color: PLOTLY_COLORS.primary, width: 2 },
        hovertemplate: `K %{x}<br>BSM ${greekDef.axis} %{y:${greekDef.tickformat}}<extra></extra>`,
      },
      {
        x: strikes,
        y: pick(bach),
        mode: 'lines',
        name: 'Bachelier · normal',
        line: { color: PLOTLY_COLORS.highlight, width: 2, dash: 'dash' },
        hovertemplate: `K %{x}<br>Bach ${greekDef.axis} %{y:${greekDef.tickformat}}<extra></extra>`,
      },
      {
        x: strikes,
        y: pick(hest),
        mode: 'lines',
        name: 'Heston · stochastic vol',
        line: { color: PLOTLY_COLORS.positive, width: 2 },
        hovertemplate: `K %{x}<br>Heston ${greekDef.axis} %{y:${greekDef.tickformat}}<extra></extra>`,
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
    ];

    const allY = [...pick(bsm), ...pick(bach), ...pick(hest)].filter(Number.isFinite);
    const yMin = Math.min(...allY);
    const yMax = Math.max(...allY);
    const pad = (yMax - yMin) * 0.12 || 0.01;

    const layout = plotly2DChartLayout({
      title: {
        ...plotlyTitle(`${greekDef.label} across strikes · SPX`),
        y: 0.97,
        yref: 'container',
        yanchor: 'top',
      },
      margin: mobile ? { t: 50, r: 25, b: 85, l: 65 } : { t: 70, r: 35, b: 100, l: 80 },
      xaxis: plotlyAxis('Strike', { autorange: true }),
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
  }, [Plotly, curves, greek, mobile, data]);

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

  // ATM reference row — all three models, at K = spot
  const atmCell = (() => {
    if (!curves || !data) return null;
    const idx = curves.strikes.reduce((best, K, i) => {
      return Math.abs(K - data.spotPrice) < Math.abs(curves.strikes[best] - data.spotPrice) ? i : best;
    }, 0);
    return {
      bsm: curves.bsm[idx][greek],
      bach: curves.bach[idx][greek],
      hest: curves.hest[idx][greek],
    };
  })();

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
        model · cross-model greeks · bsm / bachelier / heston on one slice
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
          label={`BSM ${greek}`}
          value={atmCell ? formatFixed(atmCell.bsm, 4) : '-'}
          sub="at spot · log-normal"
          accent={PLOTLY_COLORS.primary}
        />
        <StatCell
          label={`Bachelier ${greek}`}
          value={atmCell ? formatFixed(atmCell.bach, 4) : '-'}
          sub="at spot · normal"
          accent={PLOTLY_COLORS.highlight}
        />
        <StatCell
          label={`Heston ${greek}`}
          value={atmCell ? formatFixed(atmCell.hest, 4) : '-'}
          sub="at spot · stoch vol"
          accent={PLOTLY_COLORS.positive}
        />
        <StatCell
          label="κ, θ, ξ, ρ, v₀"
          value={calib
            ? `${calib.params.kappa.toFixed(1)} · ${formatPct(Math.sqrt(calib.params.theta), 0)}`
            : '-'}
          sub={calib
            ? `ρ ${calib.params.rho.toFixed(2)} · √v₀ ${formatPct(Math.sqrt(calib.params.v0), 1)}`
            : '-'}
        />
        <StatCell
          label="Heston fit RMSE"
          value={calib ? formatPct(calib.rmse, 2) : '-'}
          sub="in IV-space"
          accent={calib && calib.rmse < 0.01 ? PLOTLY_COLORS.positive : undefined}
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
          Three pricing models compute the same Greek on the same SPX slice.
          The{' '}
          <strong style={{ color: PLOTLY_COLORS.primary }}>BSM</strong>{' '}
          line is log-normal with constant vol, evaluated at the interpolated
          market implied vol. This is the Greek every quote screen shows.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          The{' '}
          <strong style={{ color: PLOTLY_COLORS.highlight }}>Bachelier</strong>{' '}
          dashed line is the same Greek under a normal spot process instead
          of log-normal. Near the money the two are nearly identical. In the
          wings they diverge because the normal tail is thinner.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          The{' '}
          <strong style={{ color: PLOTLY_COLORS.positive }}>Heston</strong>{' '}
          line comes from a stochastic-variance fit on the current slice,
          with Greeks by finite difference on the characteristic-function
          call. It carries smile dynamics that the first two models cannot.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          The reader takeaway is the vertical spacing between the three
          curves at a strike you care about. That distance is the model
          risk embedded in the Greek, before any quote-level noise enters.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          <strong style={{ color: 'var(--text-primary)' }}>Reading.</strong>{' '}
          Near the money the three lines collapse almost on top of each other.
          That is expected. ATM is where every sensible option model agrees,
          because the payoff is dominated by its linear piece and the shape of
          the tail barely matters.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          Away from the money the three lines fan out. The{' '}
          <strong style={{ color: PLOTLY_COLORS.highlight }}>Bachelier</strong>{' '}
          curve bends fastest because the normal distribution underweights
          extreme moves relative to the log-normal. The{' '}
          <strong style={{ color: PLOTLY_COLORS.positive }}>Heston</strong>{' '}
          curve tracks the BSM curve out to a few percent of spot and then
          starts to bulge because stochastic vol reprices the tail.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          For <strong>delta</strong>, the gap between BSM and Heston in the
          left wing is a read on how much your delta hedge changes if you
          allow vol to move with spot. For <strong>gamma</strong>, the
          Heston peak can be fatter or shifted because the smile has
          curvature in K that a flat-vol model cannot see. For{' '}
          <strong>vega</strong>, Bachelier and BSM disagree the most because
          they carry different notional interpretations of σ.
        </p>
        <p style={{ margin: 0 }}>
          The goal of the chart is not to decide which model is right. It is
          to give a visual answer to the question of how sensitive your
          hedge ratio is to the modelling assumption itself.
        </p>
      </div>
    </div>
  );
}
