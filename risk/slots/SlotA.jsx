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
import { LAB_R as RATE_R, LAB_Q as RATE_Q } from '../../src/lib/marketRates.js';

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
// Same precompute-once / per-K-sum structure as the Heston slot on /jump/:
// build the 160-point CF table once for one (params, S0, T, r, q),
// then sum it against the inversion kernel e^{-iu·log(K)} for every K. The
// CF math is inlined as scalar (re, im) pairs so a Heston calibration plus
// a 48-strike Greeks pass on this slot is a few hundred thousand floating-
// point ops with zero array allocations inside the hot loop, instead of
// the hundreds of millions of [re, im] tuple allocations the original
// helper-driven shape produced.

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

// Fill (re, im) buffers with the Heston "Little Trap" characteristic function
// at every u in U_GRID for the chosen j ∈ {1, 2}. All complex arithmetic is
// inlined as scalar (re, im) pairs — no allocations inside the loop.
//
//   d   = sqrt((b_j - ρξ·iu)² - ξ²(2 u_j iu - u²))
//   g   = (b_j - ρξ·iu - d) / (b_j - ρξ·iu + d)
//   C_j = (r-q)·iu·T + (κθ/ξ²)·[(b_j - ρξ·iu - d)·T - 2·log((1 - g·e^{-dT})/(1 - g))]
//   D_j = ((b_j - ρξ·iu - d)/ξ²) · (1 - e^{-dT})/(1 - g·e^{-dT})
//   φ   = exp(C_j + D_j·v₀ + iu·log(S₀))
function fillHestonCf(outRe, outIm, j, params, S0, T, r, q) {
  const { kappa, theta, xi, rho, v0 } = params;
  const bj = j === 1 ? kappa - rho * xi : kappa;
  const uj = j === 1 ? 0.5 : -0.5;
  const rhoXi = rho * xi;
  const xi2 = xi * xi;
  const ktxi2 = (kappa * theta) / xi2;
  const rmqT = (r - q) * T;
  const logS0 = Math.log(S0);

  for (let i = 0; i < INT_N; i++) {
    const u = U_GRID[i];

    const a_re = -bj;
    const a_im = rhoXi * u;
    const aSq_re = a_re * a_re - a_im * a_im;
    const aSq_im = 2 * a_re * a_im;
    const disc_re = aSq_re + xi2 * u * u;
    const disc_im = aSq_im - 2 * xi2 * uj * u;
    const disc_mag = Math.sqrt(disc_re * disc_re + disc_im * disc_im);
    const d_re = Math.sqrt(0.5 * (disc_mag + disc_re));
    const d_im = Math.sign(disc_im || 1) * Math.sqrt(0.5 * (disc_mag - disc_re));

    const bma_re = bj;
    const bma_im = -rhoXi * u;
    const num_re = bma_re - d_re;
    const num_im = bma_im - d_im;
    const den_re = bma_re + d_re;
    const den_im = bma_im + d_im;
    const den_mag2 = den_re * den_re + den_im * den_im;
    const g_re = (num_re * den_re + num_im * den_im) / den_mag2;
    const g_im = (num_im * den_re - num_re * den_im) / den_mag2;

    const negDT_re = -d_re * T;
    const negDT_im = -d_im * T;
    const expMag1 = Math.exp(negDT_re);
    const edT_re = expMag1 * Math.cos(negDT_im);
    const edT_im = expMag1 * Math.sin(negDT_im);

    const gEdT_re = g_re * edT_re - g_im * edT_im;
    const gEdT_im = g_re * edT_im + g_im * edT_re;

    const n1_re = 1 - gEdT_re;
    const n1_im = -gEdT_im;
    const n2_re = 1 - g_re;
    const n2_im = -g_im;
    const n2_mag2 = n2_re * n2_re + n2_im * n2_im;
    const ratio_re = (n1_re * n2_re + n1_im * n2_im) / n2_mag2;
    const ratio_im = (n1_im * n2_re - n1_re * n2_im) / n2_mag2;
    const logRatio_re = 0.5 * Math.log(ratio_re * ratio_re + ratio_im * ratio_im);
    const logRatio_im = Math.atan2(ratio_im, ratio_re);

    const term_re = num_re * T - 2 * logRatio_re;
    const term_im = num_im * T - 2 * logRatio_im;

    const Cj_re = term_re * ktxi2;
    const Cj_im = u * rmqT + term_im * ktxi2;

    const numer_re = 1 - edT_re;
    const numer_im = -edT_im;
    const n1_mag2 = n1_re * n1_re + n1_im * n1_im;
    const inner_re = (numer_re * n1_re + numer_im * n1_im) / n1_mag2;
    const inner_im = (numer_im * n1_re - numer_re * n1_im) / n1_mag2;

    const numXi2_re = num_re / xi2;
    const numXi2_im = num_im / xi2;
    const Dj_re = numXi2_re * inner_re - numXi2_im * inner_im;
    const Dj_im = numXi2_re * inner_im + numXi2_im * inner_re;

    const exp_re = Cj_re + Dj_re * v0;
    const exp_im = Cj_im + Dj_im * v0 + u * logS0;
    const expMag = Math.exp(exp_re);
    outRe[i] = expMag * Math.cos(exp_im);
    outIm[i] = expMag * Math.sin(exp_im);
  }
}

// Build the (j=1, j=2) CF tables for one parameter tuple. The Greeks pass
// below precomputes five of these — base, S+h, S-h, v+h, v-h — outside the
// per-K loop so the FD bumps share the same per-K sum machinery.
function precomputeHestonCfGrid(params, S0, T, r, q) {
  const F1_re = new Float64Array(INT_N);
  const F1_im = new Float64Array(INT_N);
  const F2_re = new Float64Array(INT_N);
  const F2_im = new Float64Array(INT_N);
  fillHestonCf(F1_re, F1_im, 1, params, S0, T, r, q);
  fillHestonCf(F2_re, F2_im, 2, params, S0, T, r, q);
  return { F1_re, F1_im, F2_re, F2_im };
}

// Strike-dependent Heston call price from a precomputed CF grid. Sums each
// CF table against the inversion kernel e^{-iu·log(K)}; only the imaginary
// part of the product is needed per Gil-Pelaez / Heston (1993).
function hestonCallFromCfGrid(grid, S0, K, T, r, q) {
  const { F1_re, F1_im, F2_re, F2_im } = grid;
  const logK = Math.log(K);
  let acc1 = 0;
  let acc2 = 0;
  for (let i = 0; i < INT_N; i++) {
    const u = U_GRID[i];
    const c = Math.cos(u * logK);
    const s = Math.sin(u * logK);
    const im1 = c * F1_im[i] - s * F1_re[i];
    const im2 = c * F2_im[i] - s * F2_re[i];
    const w = U_WEIGHTS[i];
    acc1 += (w * im1) / u;
    acc2 += (w * im2) / u;
  }
  const P1 = 0.5 + acc1 / Math.PI;
  const P2 = 0.5 + acc2 / Math.PI;
  return S0 * Math.exp(-q * T) * P1 - K * Math.exp(-r * T) * P2;
}

// ---- Heston calibration (same machinery as the stochastic page) -----------

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
    // One CF table per parameter set; every strike on the slice reuses it.
    const grid = precomputeHestonCfGrid(p, S0, T, r, q);
    let sse = 0;
    let n = 0;
    for (const { strike, iv } of slice) {
      const c = hestonCallFromCfGrid(grid, S0, strike, T, r, q);
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

// Build the 48-strike Greeks grid for the chart. BSM and Bachelier Greeks
// are analytic and per-K. Heston Greeks are computed by central finite
// differences against five precomputed CF grids (base, S±h, v0±h) so each
// per-K Greek call is five lightweight O(INT_N) sums against cached tables
// rather than five full CF rebuilds. The IV used for BSM and Bachelier is
// piecewise-linear in log-moneyness across the observed slice — fine for
// Greek visualisation; the wings do not need the arbitrage-free structure
// an SVI fit would add.
function buildCurves(calib, slice, data, T) {
  if (!calib || !slice.length || !data) return null;
  const S0 = data.spotPrice;

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

  // Five Heston CF tables for the FD bumps. The base grid is reused for the
  // c0 term in the gamma central difference; the four bumped grids cover
  // delta (S ± h), gamma (S ± h via c0), and vega (vol ± h).
  const hS = FD_BUMP_S;
  const hSig = FD_BUMP_SIGMA;
  const sigma0 = Math.sqrt(calib.params.v0);
  const vPlus = (sigma0 + hSig) ** 2;
  const vMinus = Math.max((sigma0 - hSig) ** 2, 1e-8);
  const gridBase = precomputeHestonCfGrid(calib.params, S0, T, RATE_R, RATE_Q);
  const gridSpotUp = precomputeHestonCfGrid(calib.params, S0 + hS, T, RATE_R, RATE_Q);
  const gridSpotDn = precomputeHestonCfGrid(calib.params, S0 - hS, T, RATE_R, RATE_Q);
  const gridVolUp = precomputeHestonCfGrid({ ...calib.params, v0: vPlus }, S0, T, RATE_R, RATE_Q);
  const gridVolDn = precomputeHestonCfGrid({ ...calib.params, v0: vMinus }, S0, T, RATE_R, RATE_Q);

  const Ks = slice.map((r) => r.strike);
  const Klo = Math.min(...Ks);
  const Khi = Math.max(...Ks);
  const nGrid = 48;
  const strikes = new Array(nGrid);
  const bsm = new Array(nGrid);
  const bach = new Array(nGrid);
  const hest = new Array(nGrid);
  const eqT = Math.exp(-RATE_Q * T);
  for (let i = 0; i < nGrid; i++) {
    const K = Klo + (i / (nGrid - 1)) * (Khi - Klo);
    strikes[i] = K;
    const type = K >= S0 ? 'call' : 'put';
    const sigma = ivAt(K);
    bsm[i] = bsmGreeks(S0, K, T, RATE_R, RATE_Q, sigma, type);
    bach[i] = bachelierGreeks(S0, K, T, RATE_R, RATE_Q, sigma, type);

    const c0 = hestonCallFromCfGrid(gridBase, S0, K, T, RATE_R, RATE_Q);
    const cUp = hestonCallFromCfGrid(gridSpotUp, S0 + hS, K, T, RATE_R, RATE_Q);
    const cDn = hestonCallFromCfGrid(gridSpotDn, S0 - hS, K, T, RATE_R, RATE_Q);
    const cvPlus = hestonCallFromCfGrid(gridVolUp, S0, K, T, RATE_R, RATE_Q);
    const cvMinus = hestonCallFromCfGrid(gridVolDn, S0, K, T, RATE_R, RATE_Q);
    const callDelta = (cUp - cDn) / (2 * hS);
    const gamma = (cUp - 2 * c0 + cDn) / (hS * hS);
    const vega = (cvPlus - cvMinus) / (2 * hSig);
    const delta = type === 'put' ? callDelta - eqT : callDelta;
    hest[i] = { delta, gamma, vega };
  }
  return { strikes, bsm, bach, hest };
}

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
          fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
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

  // Calibration plus the 48-strike Greeks grid both run inside one
  // requestIdleCallback-deferred effect so the page can mount and paint its
  // header / picker / stat-row chrome without the Heston math blocking the
  // main thread. Mirrors the deferral pattern on /jump/. The cancellation
  // flag prevents a stale calibration from a now-superseded expiration or
  // greek dropdown overwriting fresh state if the reader changes the
  // selection mid-flight.
  //
  // The Greeks block precomputes five Heston CF tables — base (params, S0),
  // spot-up (params, S0+h), spot-down (params, S0-h), vol-up (params with
  // bumped v0, S0), vol-down (params with bumped v0, S0) — once outside the
  // 48-strike loop. Each per-K finite-difference Greek then resolves to five
  // cheap O(INT_N) sums against the cached grids instead of five full
  // characteristic-function rebuilds. Without that factorisation each strike
  // would do 5 × 2 × 160 ≈ 1,600 CF evaluations; with it, 5 × 320 = 1,600 CF
  // evaluations are paid once for the whole grid and the per-strike work is
  // five sums of 160 reals each.
  const [fits, setFits] = useState(null);
  useEffect(() => {
    if (!data || !activeExp || slice.length < 6 || !T || T <= 0) {
      setFits(null);
      return undefined;
    }
    if (typeof window === 'undefined') {
      const calib = calibrateHeston(slice, data.spotPrice, T, RATE_R, RATE_Q, INIT_PARAMS);
      const curves = buildCurves(calib, slice, data, T);
      setFits({ calib, curves });
      return undefined;
    }
    let cancelled = false;
    const idle = window.requestIdleCallback
      ? (cb) => window.requestIdleCallback(cb, { timeout: 1500 })
      : (cb) => setTimeout(cb, 0);
    const cancel = window.cancelIdleCallback || clearTimeout;
    const handle = idle(() => {
      if (cancelled) return;
      const calib = calibrateHeston(slice, data.spotPrice, T, RATE_R, RATE_Q, INIT_PARAMS);
      if (cancelled) return;
      const curves = buildCurves(calib, slice, data, T);
      if (cancelled) return;
      setFits({ calib, curves });
    });
    return () => {
      cancelled = true;
      cancel(handle);
    };
  }, [data, activeExp, slice, T]);

  const calib = fits?.calib ?? null;
  const curves = fits?.curves ?? null;

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
        ...plotlyTitle(
          mobile
            ? `${greekDef.label} across<br>strikes`
            : `${greekDef.label} across strikes`
        ),
        // Plotly 2.35.2 anchors a multi-line title's bottom near y when
        // yref='container' / yanchor='top'; on mobile (where the title wraps
        // to two lines) y=0.97 puts the first line ~15-20px above the SVG
        // top and clips its top half. Drop y on mobile so two lines clear.
        y: mobile ? 0.92 : 0.97,
        yref: 'container',
        yanchor: 'top',
      },
      margin: mobile ? { t: 75, r: 25, b: 85, l: 65 } : { t: 70, r: 35, b: 100, l: 80 },
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
      <div className="page-placeholder">
        <div className="page-placeholder-title">Loading chain…</div>
        <div className="page-placeholder-hint">
          Loading the live SPX snapshot.
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="page-placeholder" style={{ borderColor: 'var(--accent-coral)' }}>
        <div className="page-placeholder-title" style={{ color: 'var(--accent-coral)' }}>
          Chain fetch failed
        </div>
        <div className="page-placeholder-hint">{error}</div>
      </div>
    );
  }
  if (plotlyError) {
    return (
      <div className="page-placeholder" style={{ borderColor: 'var(--accent-coral)' }}>
        <div className="page-placeholder-title" style={{ color: 'var(--accent-coral)' }}>
          Plotly unavailable
        </div>
        <div className="page-placeholder-hint">{plotlyError}</div>
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
          fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
          fontSize: '0.7rem',
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--accent-amber)',
          marginBottom: '0.85rem',
        }}
      >
        cross-model greeks · bsm / bachelier / heston on one slice
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
            fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
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
            fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
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
          label="Heston fit"
          value={calib
            ? `${calib.params.kappa.toFixed(1)} · ${formatPct(Math.sqrt(calib.params.theta), 0)}`
            : '-'}
          sub={calib
            ? `corr ${calib.params.rho.toFixed(2)} · now-vol ${formatPct(Math.sqrt(calib.params.v0), 1)}`
            : '-'}
        />
        <StatCell
          label="Heston fit error"
          value={calib ? formatPct(calib.rmse, 2) : '-'}
          sub="vs market IV"
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
          Every hedge ratio on a quote screen is the answer to a math
          problem, and the math problem depends on what you assume about
          how spot moves. The three lines here are the same Greek computed
          under three different assumptions, evaluated at the market implied
          vol for each strike. The vertical gap between them is how much of
          your hedge is coming from the model you picked rather than from
          the market itself.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          The{' '}
          <strong style={{ color: PLOTLY_COLORS.primary }}>BSM</strong>{' '}
          line is the industry default: log-normal spot with constant vol.
          This is the Greek your broker platform and quote screen show.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          The{' '}
          <strong style={{ color: PLOTLY_COLORS.highlight }}>Bachelier</strong>{' '}
          dashed line swaps log-normal for a normal arithmetic process.
          Near the money the two overlap almost perfectly. Out in the wings
          Bachelier bends faster because a normal distribution has thinner
          tails than a log-normal.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          The{' '}
          <strong style={{ color: PLOTLY_COLORS.positive }}>Heston</strong>{' '}
          line is a stochastic-vol fit calibrated on the current slice. It
          knows the smile is not flat and carries the way vol moves with
          spot. Close to the money Heston tracks BSM. Further out it bulges
          in the direction of whichever wing the smile is leaning on, which
          on SPX is almost always the put side.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          The stat row shows the selected Greek at spot under each model,
          the Heston calibration as mean-reversion speed and long-run vol
          with the correlation and current vol underneath, and the fit
          error against the observed market smile. A fit error around 1% or
          under means Heston is reproducing the slice faithfully and the
          green-to-blue gap is real model disagreement, not calibration
          noise.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          <strong style={{ color: 'var(--text-primary)' }}>Practical use.</strong>{' '}
          If you delta-hedge a wing position using the BSM delta on your
          screen, you systematically over-hedge or under-hedge because the
          screen ignores smile dynamics. On SPX the Heston delta for a
          25-delta put is noticeably lower in magnitude than the BSM delta,
          because the vega gain on a sell-off already does part of the
          hedging work. Swapping in the Heston delta closes the sizing gap
          and cuts daily hedge-rebalance costs.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          Gamma scalpers can read the Heston gamma peak as the true location
          of the scalping edge, which often sits slightly off spot rather
          than right on it. If your program triggers re-hedges on BSM gamma
          bumps, you will under-scalp the real gamma in the wings and
          over-scalp at spot. The Heston curve tells you where to concentrate
          the work.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          Wing vega buyers should note that both BSM and Bachelier undercount
          vega out in the tails relative to Heston, because neither carries
          smile dynamics. If you are long far-OTM options as a vol play, the
          vega exposure you are carrying is larger than the quote-screen
          number, and a spike in implied vol pays you more than BSM vega
          suggests.
        </p>
        <p style={{ margin: 0 }}>
          When the three lines bunch tightly on your current expiration,
          model risk is small and the BSM hedge on your screen is trustworthy.
          When they fan out, the choice of model is worth real daily PnL,
          and the empirically correct answer on SPX is almost always closer
          to the Heston line than to BSM, especially past 5% OTM on the put
          side.
        </p>
      </div>
    </div>
  );
}
