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
// Heston (1993) Stochastic Variance. The benchmark stochastic-vol model
// against which the rest of the lineage on this page is measured. The
// spot follows GBM with a CIR-driven instantaneous variance:
//
//   dS/S = (r − q)·dt + √v·dW₁
//   dv   = κ·(θ − v)·dt + ξ·√v·dW₂
//   d⟨W₁,W₂⟩ = ρ·dt
//
// Five risk-neutral parameters: κ (variance mean-reversion speed), θ
// (long-run variance, so √θ is the long-run volatility), ξ (vol-of-vol,
// the diffusion coefficient on variance), ρ (instantaneous correlation
// between spot and variance shocks; strongly negative on equities,
// driving the leverage skew), and v₀ (current instantaneous variance).
//
// Heston is the no-jumps baseline that every other slot on this page
// extends or contrasts with. Merton, Kou, and VG all add or replace the
// continuous-diffusion piece with discrete jumps; Bates SVJ literally
// embeds Heston and tacks Merton-style log-normal jumps on top of the
// spot SDE. The headline limitation that motivates the rest of the
// page is that pure Heston cannot match the short-tenor smile that the
// SPX surface actually exhibits. Heston produces skew via the
// diffusive correlation ρ, but ρ-skew flattens to a flat line as T
// approaches zero because every diffusion path is locally Gaussian.
// The Bates extension below restores the short-tenor skew by adding a
// finite-activity jump component.
//
// Pricing uses the same Lewis (2001) single-integral inversion of the
// Schoutens single-CF form that the Bates slot uses, with the jump
// factor switched off. Same atan-substituted u-grid, same per-K sum
// against the inversion kernel, same spot-centered CF of X = ln(S_T/S₀).
// 5 free parameters, calibrated by Nelder-Mead on IV-space residuals
// against the same SPX expiration slice the other four slots use.
// -----------------------------------------------------------------------------

const INT_N = 601;
const NM_MAX_ITERS = 240;

// Pre-computed quadrature for Lewis (2001) inversion. v = atan(2u),
// u = tan(v)/2, the 1/(u²+1/4) singularity dissolves into the dv
// measure, and Simpson on [0, π/2] converges at its full O(h⁴) rate.
const U_GRID = new Float64Array(INT_N);
const U_WEIGHTS = new Float64Array(INT_N);
{
  const v_max = Math.PI / 2 - 1e-6;
  const h = v_max / (INT_N - 1);
  for (let i = 0; i < INT_N; i++) U_GRID[i] = Math.tan(i * h) / 2;
  for (let i = 0; i < INT_N; i++) {
    let w;
    if (i === 0 || i === INT_N - 1) w = 1;
    else if (i % 2 === 1) w = 4;
    else w = 2;
    U_WEIGHTS[i] = (2 * w * h) / 3;
  }
}

// ---- Heston CF (Schoutens single-CF form, X = ln(S_T/S₀)) --------------
//
// Centered CF (around S₀): the ln S₀ shift is absorbed into the Lewis k
// outside this loop so the integrand has O(1) magnitude. Identical to
// the Heston piece inside the Bates SVJ slot's fillBatesCf, with the
// jump factor exp[λT·(...)] omitted because λ ≡ 0 on this slot.
//
// At u = u_real − i/2 the complex parts collapse to:
//   iu        = (1/2, u_real)
//   u²        = (u_real² − 1/4, −u_real)
//   iu + u²   = (u_real² + 1/4, 0)        ← purely real
//   ξ²·(iu+u²) = (ξ²·(u_real²+1/4), 0)
function fillHestonCf(outRe, outIm, params, S0, T, r, q) {
  const { kappa, theta, xi, rho, v0 } = params;
  const xi2 = xi * xi;
  const rhoXi = rho * xi;
  const ktxi2 = (kappa * theta) / xi2;
  const rmqT = (r - q) * T;

  for (let i = 0; i < INT_N; i++) {
    const u = U_GRID[i];

    // a = ρ·ξ·iu − κ = (0.5·ρξ − κ, ρξ·u)
    const a_re = 0.5 * rhoXi - kappa;
    const a_im = rhoXi * u;
    // a²
    const aSq_re = a_re * a_re - a_im * a_im;
    const aSq_im = 2 * a_re * a_im;
    // ξ²·(iu + u²) is purely real: ξ²·(u² + 1/4)
    const xi2_iuPlusU2_re = xi2 * (u * u + 0.25);
    // inside = a² + ξ²·(iu + u²)
    const inside_re = aSq_re + xi2_iuPlusU2_re;
    const inside_im = aSq_im;
    // d = sqrt(inside) — principal branch with sign continuity
    const inside_mag = Math.sqrt(inside_re * inside_re + inside_im * inside_im);
    const d_re = Math.sqrt(0.5 * (inside_mag + inside_re));
    const d_im = Math.sign(inside_im || 1) * Math.sqrt(0.5 * (inside_mag - inside_re));

    // aMinus = κ − ρ·ξ·iu = (κ − 0.5·ρξ, −ρξ·u)
    const am_re = kappa - 0.5 * rhoXi;
    const am_im = -rhoXi * u;
    // num = aMinus − d, den = aMinus + d
    const num_re = am_re - d_re;
    const num_im = am_im - d_im;
    const den_re = am_re + d_re;
    const den_im = am_im + d_im;
    // g = num / den
    const den_mag2 = den_re * den_re + den_im * den_im;
    const g_re = (num_re * den_re + num_im * den_im) / den_mag2;
    const g_im = (num_im * den_re - num_re * den_im) / den_mag2;

    // eDt = exp(−d·T)
    const negDT_re = -d_re * T;
    const negDT_im = -d_im * T;
    const expMag1 = Math.exp(negDT_re);
    const eDt_re = expMag1 * Math.cos(negDT_im);
    const eDt_im = expMag1 * Math.sin(negDT_im);

    // gEdT = g · eDt — also serves as denominator (1 − gEdT) of D and ratio
    const gEdT_re = g_re * eDt_re - g_im * eDt_im;
    const gEdT_im = g_re * eDt_im + g_im * eDt_re;

    // ratio = (1 − gEdT) / (1 − g)
    const oneMinusGEdT_re = 1 - gEdT_re;
    const oneMinusGEdT_im = -gEdT_im;
    const oneMinusG_re = 1 - g_re;
    const oneMinusG_im = -g_im;
    const ompg_mag2 = oneMinusG_re * oneMinusG_re + oneMinusG_im * oneMinusG_im;
    const ratio_re =
      (oneMinusGEdT_re * oneMinusG_re + oneMinusGEdT_im * oneMinusG_im) / ompg_mag2;
    const ratio_im =
      (oneMinusGEdT_im * oneMinusG_re - oneMinusGEdT_re * oneMinusG_im) / ompg_mag2;
    // logRatio = log(ratio) — principal branch
    const logRatio_re = 0.5 * Math.log(ratio_re * ratio_re + ratio_im * ratio_im);
    const logRatio_im = Math.atan2(ratio_im, ratio_re);

    // term = num·T − 2·logRatio
    const term_re = num_re * T - 2 * logRatio_re;
    const term_im = num_im * T - 2 * logRatio_im;

    // C = (r−q)·iu·T + (κθ/ξ²)·term. (r−q)·iu·T = (0.5·rmqT, u·rmqT)
    const C_re = 0.5 * rmqT + term_re * ktxi2;
    const C_im = u * rmqT + term_im * ktxi2;

    // inner = (1 − eDt) / (1 − gEdT)
    const oneMinusEDt_re = 1 - eDt_re;
    const oneMinusEDt_im = -eDt_im;
    const omgedt_mag2 =
      oneMinusGEdT_re * oneMinusGEdT_re + oneMinusGEdT_im * oneMinusGEdT_im;
    const inner_re =
      (oneMinusEDt_re * oneMinusGEdT_re + oneMinusEDt_im * oneMinusGEdT_im) /
      omgedt_mag2;
    const inner_im =
      (oneMinusEDt_im * oneMinusGEdT_re - oneMinusEDt_re * oneMinusGEdT_im) /
      omgedt_mag2;

    // D = (num/ξ²) · inner
    const numXi2_re = num_re / xi2;
    const numXi2_im = num_im / xi2;
    const D_re = numXi2_re * inner_re - numXi2_im * inner_im;
    const D_im = numXi2_re * inner_im + numXi2_im * inner_re;

    // exponent = C + D·v0  (centered CF, no iu·log S₀ term)
    const exp_re = C_re + D_re * v0;
    const exp_im = C_im + D_im * v0;
    const expMag = Math.exp(exp_re);
    outRe[i] = expMag * Math.cos(exp_im);
    outIm[i] = expMag * Math.sin(exp_im);
  }
}

function precomputeHestonCfGrid(params, S0, T, r, q) {
  const F_re = new Float64Array(INT_N);
  const F_im = new Float64Array(INT_N);
  fillHestonCf(F_re, F_im, params, S0, T, r, q);
  return { F_re, F_im };
}

// ---- Lewis call price ----------------------------------------------------
//
// C = S₀·e^(−q·T) − √(S₀·K)·e^(−r·T) / π · ∫₀^∞ Re[ e^(i·u·k) · φ_X(u − i/2) ] / (u² + 1/4) du
// where k = ln(S₀/K) and φ_X is the centered CF of X = ln(S_T/S₀).
function hestonCallFromCfGrid(grid, S0, K, T, r, q) {
  const { F_re, F_im } = grid;
  const k = Math.log(S0 / K);
  let acc = 0;
  for (let i = 0; i < INT_N; i++) {
    const u = U_GRID[i];
    const c = Math.cos(u * k);
    const s = Math.sin(u * k);
    // 1/(u²+1/4) kernel absorbed into U_WEIGHTS via atan substitution.
    const num_re = c * F_re[i] - s * F_im[i];
    acc += U_WEIGHTS[i] * num_re;
  }
  const factor = (Math.sqrt(S0 * K) * Math.exp(-r * T)) / Math.PI;
  const call = S0 * Math.exp(-q * T) - factor * acc;
  return Math.max(call, Math.max(S0 * Math.exp(-q * T) - K * Math.exp(-r * T), 0));
}

// ------- BSM ------------------------------------------------------------

function phiPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}
function Phi(x) {
  const a1 = 0.31938153;
  const a2 = -0.356563782;
  const a3 = 1.781477937;
  const a4 = -1.821255978;
  const a5 = 1.330274429;
  const k = 1 / (1 + 0.2316419 * Math.abs(x));
  const w = 1 - phiPdf(x) * (a1*k + a2*k*k + a3*k*k*k + a4*k*k*k*k + a5*k*k*k*k*k);
  return x >= 0 ? w : 1 - w;
}
function bsmCall(S, K, T, r, q, sigma) {
  if (!(sigma > 0) || !(T > 0)) {
    return Math.max(S * Math.exp(-q * T) - K * Math.exp(-r * T), 0);
  }
  const vsT = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / vsT;
  const d2 = d1 - vsT;
  return S * Math.exp(-q * T) * Phi(d1) - K * Math.exp(-r * T) * Phi(d2);
}
function bsmVega(S, K, T, r, q, sigma) {
  const vsT = sigma * Math.sqrt(T);
  if (!(vsT > 0)) return 0;
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / vsT;
  return S * Math.exp(-q * T) * phiPdf(d1) * Math.sqrt(T);
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

// ------- Reparameterization ---------------------------------------------
//
// theta = [log κ, log θ, log ξ, atanh ρ, log v₀]

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

// ------- Nelder-Mead ----------------------------------------------------

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
      if (fc < (outside ? fr : values[n])) {
        simplex[n] = xc; values[n] = fc;
      } else {
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

// ------- Slice ----------------------------------------------------------

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

// ------- Calibration ---------------------------------------------------

function calibrateHeston(slice, S0, T, r, q, init) {
  const obj = (theta) => {
    const p = unpack(theta);
    if (p.kappa > 50 || p.theta > 1 || p.xi > 3 || p.v0 > 1) return 1e6;
    const grid = precomputeHestonCfGrid(p, S0, T, r, q);
    let sse = 0;
    let n = 0;
    for (const { strike, iv } of slice) {
      const c = hestonCallFromCfGrid(grid, S0, strike, T, r, q);
      const modelIv = bsmIv(c, S0, strike, T, r, q);
      if (modelIv == null || !Number.isFinite(modelIv)) return 1e6;
      const d = modelIv - iv;
      sse += d * d;
      n++;
    }
    return n > 0 ? sse / n : 1e6;
  };
  const x0 = pack(init);
  const res = nelderMead(obj, x0, { maxIters: NM_MAX_ITERS, tol: 1e-9, step: 0.18 });
  return { params: unpack(res.x), rmse: Math.sqrt(res.value) };
}

// Warm start. SPX-typical: ~20% long-run vol (θ ≈ 0.04), strong negative
// correlation (ρ ≈ −0.7) for the leverage skew, moderate vol-of-vol, fast
// mean-reversion. The simplex reaches the basin from this seed for almost
// any monthly slice on the SPX surface.
const INIT_PARAMS = {
  kappa: 2.0,
  theta: 0.04,
  xi: 0.4,
  rho: -0.7,
  v0: 0.04,
};

// ------- UI -------------------------------------------------------------

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

export default function SlotB() {
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

  // Heston calibration deferred to idle callback so chart paints
  // observation dots before the simplex runs. Same pattern as the
  // sibling jump-process slots on this page.
  const [calib, setCalib] = useState(null);
  useEffect(() => {
    if (!data || !activeExp || slice.length < 5 || !T || T <= 0) {
      setCalib(null);
      return undefined;
    }
    if (typeof window === 'undefined') {
      setCalib(calibrateHeston(slice, data.spotPrice, T, RATE_R, RATE_Q, INIT_PARAMS));
      return undefined;
    }
    let cancelled = false;
    const idle = window.requestIdleCallback
      ? (cb) => window.requestIdleCallback(cb, { timeout: 1500 })
      : (cb) => setTimeout(cb, 0);
    const cancel = window.cancelIdleCallback || clearTimeout;
    const handle = idle(() => {
      if (cancelled) return;
      const res = calibrateHeston(slice, data.spotPrice, T, RATE_R, RATE_Q, INIT_PARAMS);
      if (cancelled) return;
      setCalib(res);
    });
    return () => {
      cancelled = true;
      cancel(handle);
    };
  }, [data, activeExp, slice, T]);

  useEffect(() => {
    if (!Plotly || !chartRef.current || slice.length === 0 || !T || !data) return;

    const strikes = slice.map((r) => r.strike);
    const ivs = slice.map((r) => r.iv * 100);
    const K_lo = Math.min(...strikes);
    const K_hi = Math.max(...strikes);

    let gridK = null;
    let gridIv = null;
    if (calib) {
      const nGrid = 60;
      gridK = new Array(nGrid);
      gridIv = new Array(nGrid);
      const hestonGrid = precomputeHestonCfGrid(
        calib.params,
        data.spotPrice,
        T,
        RATE_R,
        RATE_Q
      );
      for (let i = 0; i < nGrid; i++) {
        const K = K_lo + (i / (nGrid - 1)) * (K_hi - K_lo);
        gridK[i] = K;
        const c = hestonCallFromCfGrid(hestonGrid, data.spotPrice, K, T, RATE_R, RATE_Q);
        const iv = bsmIv(c, data.spotPrice, K, T, RATE_R, RATE_Q);
        gridIv[i] = iv != null ? iv * 100 : null;
      }
    }

    const allIv = gridIv ? [...ivs, ...gridIv.filter((v) => v != null)] : ivs;
    const yMin = Math.min(...allIv);
    const yMax = Math.max(...allIv);
    const pad = (yMax - yMin) * 0.12 || 1;

    const traces = [
      {
        x: strikes,
        y: ivs,
        mode: 'markers',
        name: 'observed IV',
        marker: { color: PLOTLY_COLORS.primary, size: mobile ? 7 : 9, line: { width: 0 } },
        hovertemplate: 'K %{x}<br>σ %{y:.2f}%<extra></extra>',
      },
      ...(calib ? [{
        x: gridK,
        y: gridIv,
        mode: 'lines',
        name: 'Heston fit',
        line: { color: PLOTLY_COLORS.highlight, width: 2 },
        hoverinfo: 'skip',
        connectgaps: false,
      }] : []),
      {
        x: [data.spotPrice, data.spotPrice],
        y: [yMin - pad, yMax + pad],
        mode: 'lines',
        name: 'spot',
        line: { color: PLOTLY_COLORS.axisText, width: 1, dash: 'dot' },
        hoverinfo: 'skip',
        showlegend: false,
      },
    ];

    const layout = plotly2DChartLayout({
      title: {
        ...plotlyTitle('Heston Stochastic Vol Fit'),
        y: 0.97,
        yref: 'container',
        yanchor: 'top',
      },
      margin: mobile ? { t: 50, r: 25, b: 85, l: 60 } : { t: 70, r: 35, b: 100, l: 75 },
      xaxis: plotlyAxis('Strike', {
        range: [K_lo - (K_hi - K_lo) * 0.02, K_hi + (K_hi - K_lo) * 0.02],
        autorange: false,
      }),
      yaxis: plotlyAxis('Implied Vol (%)', {
        range: [yMin - pad, yMax + pad],
        autorange: false,
        ticksuffix: '%',
        tickformat: '.1f',
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
  }, [Plotly, calib, slice, T, data, mobile]);

  if (loading && !data) {
    return (
      <div className="page-placeholder">
        <div className="page-placeholder-title">Loading chain...</div>
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
        heston · stochastic variance · 5 parameters
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
        <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
          DTE {dte != null ? dte.toFixed(1) : '-'} · {slice.length} strikes ·{' '}
          r = {(RATE_R * 100).toFixed(2)}%, q = {(RATE_Q * 100).toFixed(2)}%
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
          label="√v₀ · spot σ"
          value={calib ? formatPct(Math.sqrt(calib.params.v0), 1) : '-'}
          sub="instantaneous"
          accent={PLOTLY_COLORS.primary}
        />
        <StatCell
          label="√θ · long-run σ"
          value={calib ? formatPct(Math.sqrt(calib.params.theta), 1) : '-'}
          sub="mean-revert target"
          accent={PLOTLY_COLORS.highlight}
        />
        <StatCell
          label="κ · mean revert"
          value={calib ? formatFixed(calib.params.kappa, 2) : '-'}
          sub="speed (1/yr)"
        />
        <StatCell
          label="ξ · vol of vol"
          value={calib ? formatFixed(calib.params.xi, 3) : '-'}
          sub="diffusion of v"
        />
        <StatCell
          label="ρ · correlation"
          value={calib ? formatFixed(calib.params.rho, 3) : '-'}
          sub="leverage skew"
          accent={calib && calib.params.rho < -0.5 ? PLOTLY_COLORS.secondary : undefined}
        />
        <StatCell
          label="Fit RMSE (IV)"
          value={calib ? formatPct(calib.rmse, 2) : '-'}
          sub={calib ? `n = ${slice.length}` : '-'}
          accent={calib && calib.rmse < 0.01 ? PLOTLY_COLORS.positive : undefined}
        />
      </div>

      <div ref={chartRef} style={{ width: '100%', height: mobile ? 380 : 460 }} />

      <div
        style={{
          marginTop: '0.8rem',
          fontSize: '0.9rem',
          color: 'var(--text-secondary)',
          lineHeight: 1.65,
        }}
      >
        <p style={{ margin: '0 0 0.75rem' }}>
          Heston (1993) is the benchmark stochastic-variance model. The
          spot follows GBM, but the instantaneous variance{' '}
          <strong style={{ color: PLOTLY_COLORS.primary }}>v</strong>{' '}
          itself follows a CIR process with mean-reversion speed{' '}
          <strong style={{ color: 'var(--text-primary)' }}>κ</strong>,
          long-run level{' '}
          <strong style={{ color: PLOTLY_COLORS.highlight }}>θ</strong>,
          and vol-of-vol{' '}
          <strong style={{ color: 'var(--text-primary)' }}>ξ</strong>.
          The two Brownian motions are correlated with parameter{' '}
          <strong style={{ color: PLOTLY_COLORS.secondary }}>ρ</strong>,
          which is the lever that produces smile through diffusive
          leverage. On equity surfaces ρ comes back strongly negative
          because down-moves are accompanied by vol expansions.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          Five parameters and a closed-form characteristic function. We
          price by Lewis (2001) single-integral inversion of the
          Schoutens single-CF form, the same machinery the Bates SVJ
          slot uses with the jump factor switched on; here the jump
          factor is identically one. Calibration is a five-parameter
          Nelder-Mead in IV-space against the same SPX expiration slice
          the other four slots on this page use, so the five fits
          describe the same observations through five different process
          assumptions.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          <strong style={{ color: 'var(--text-primary)' }}>Reading.</strong>{' '}
          The{' '}
          <strong style={{ color: PLOTLY_COLORS.primary }}>blue dots</strong>{' '}
          are the chain&apos;s observed IVs. The{' '}
          <strong style={{ color: PLOTLY_COLORS.highlight }}>amber curve</strong>{' '}
          is the Heston fit. The headline read is{' '}
          <strong style={{ color: PLOTLY_COLORS.secondary }}>ρ</strong>:
          a value substantially below zero confirms the leverage-skew
          mechanism by which Heston produces a downside-tilted smile from
          purely continuous dynamics.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          Heston&apos;s structural limitation is what motivates the rest
          of the page. Because every diffusion path is locally Gaussian,
          the ρ-driven skew flattens to zero as the tenor T approaches
          zero. In practice this means pure Heston cannot match the
          short-tenor SPX smile, which empirically stays steep and
          asymmetric all the way down to expiry. The Bates SVJ model
          embeds this same Heston piece and adds Merton-style log-normal
          jumps in the spot to restore short-tenor skew, and that is the
          extension the rest of this page makes explicit.
        </p>
        <p style={{ margin: 0 }}>
          The dashed amber line on the Bates slot below is the same
          Heston pricer with the calibrated Bates parameters and λ = 0.
          It is not the same fit as this slot — Bates and Heston-alone
          fit different (κ, θ, ξ, ρ, v₀) values to the chain because
          Bates can split the smile between diffusion and jumps while
          Heston-alone has to inflate ξ and ρ to match the deep wings.
          Reading them side by side is the cleanest way to see what the
          jump component contributes.
        </p>
      </div>
    </div>
  );
}
