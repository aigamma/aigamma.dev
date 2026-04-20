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
// Heston (1993) — mean-reverting square-root stochastic variance.
//
//   dS_t = (r − q)·S_t·dt + √v_t·S_t·dW₁
//   dv_t = κ·(θ − v_t)·dt + ξ·√v_t·dW₂
//   d⟨W₁, W₂⟩ = ρ·dt
//
// Five parameters under the risk-neutral measure:
//   κ   — mean-reversion speed of variance (larger → stickier)
//   θ   — long-run variance level
//   ξ   — vol-of-vol (often written σ in the original paper)
//   ρ   — Brownian correlation, typically negative for equities (leverage)
//   v₀  — initial variance
//
// The model admits a closed-form characteristic function for the log-stock,
// which in the "Little Trap" formulation (Albrecher, Mayer, Schoutens,
// Tistaert 2007) is numerically stable across all horizons:
//
//   d_j  = √((ρ·ξ·i·u − b_j)² − ξ²·(2·u_j·i·u − u²))
//   g_j  = (b_j − ρ·ξ·i·u − d_j) / (b_j − ρ·ξ·i·u + d_j)
//   D_j  = ((b_j − ρ·ξ·i·u − d_j)/ξ²)·(1 − e^(−d_j·T))/(1 − g_j·e^(−d_j·T))
//   C_j  = (r−q)·i·u·T + (κθ/ξ²)·[(b_j−ρ·ξ·i·u−d_j)·T − 2·log((1 − g_j·e^(−d_j·T))/(1 − g_j))]
//   f_j  = exp(C_j + D_j·v₀ + i·u·ln S₀)
//
// where b₁ = κ−ρ·ξ, u₁ = 1/2; b₂ = κ, u₂ = −1/2.
//
// Call price comes from the standard two-integral Heston formula:
//
//   P_j = 1/2 + (1/π)·∫₀^∞ Re[e^(−i·u·ln K)·f_j(u) / (i·u)] du
//   C   = S·e^(−q·T)·P₁ − K·e^(−r·T)·P₂
//
// BSM inversion (Newton on vega) turns each model call into a model IV at
// the same strike the observation lives at, so the residual lives in IV-
// space — which is what the trader reads and what the SVI fit uses for its
// own calibration. The two objectives are directly comparable.
//
// Calibration: five parameters, one expiration slice, ~20-40 usable strikes.
// Parameters enter through an unconstrained transform (log for the
// positives, tanh for the correlation) so the simplex never walks into a
// non-admissible region. Nelder-Mead with adaptive reflection/expansion/
// contraction/shrink coefficients; 200-iteration cap is enough for a clean
// slice and still <1 s in-browser on a modern laptop.
//
// The Feller condition 2κθ > ξ² governs whether the variance process can
// hit zero. In practice market calibrations routinely violate it — the
// market prices of deep OTM puts imply a vol-of-vol higher than the
// square-root diffusion can honor without boundary issues. That the
// condition fails is itself a finding: it tells you the empirical SPX
// variance wants heavier tails than a pure CIR process delivers, which
// is exactly the motivation for adding jumps (Bates) or switching to
// rough volatility (Slot D).
// -----------------------------------------------------------------------------

const RATE_R = 0.045;          // SOFR-ish short rate; smile shape is ~insensitive
const RATE_Q = 0.013;          // SPX trailing dividend yield
const INT_N = 160;             // Simpson nodes for the Heston inversion integral
const INT_U_MAX = 120;         // truncation of u-grid; tail decays like e^(−c·u·T)
const NM_MAX_ITERS = 220;

// -------- complex arithmetic as [re, im] pairs ---------------------------

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

// --------- Heston characteristic functions (Little Trap, j ∈ {1, 2}) ------

function hestonCf(u, j, params, S0, T, r, q) {
  const { kappa, theta, xi, rho, v0 } = params;
  const bj = j === 1 ? kappa - rho * xi : kappa;
  const uj = j === 1 ? 0.5 : -0.5;

  // a = ρ·ξ·i·u − b_j  →  complex
  const iu = [0, u];
  const rhoXi = rho * xi;
  const a = [-bj, rhoXi * u];                 // = ρ·ξ·i·u − b_j
  // d = √(a² − ξ²·(2·u_j·i·u − u²)), with (2·u_j·i·u − u²) = (−u², 2·u_j·u)
  // so ξ² · (2·u_j·i·u − u²) = (−ξ²·u², 2·ξ²·u_j·u)
  const aSquared = cMul(a, a);
  const disc = cSub(aSquared, [-xi*xi * u*u, 2*xi*xi * uj * u]);
  const d = cSqrt(disc);

  // Little Trap: use (b_j − ρ·ξ·i·u − d) / (b_j − ρ·ξ·i·u + d)
  // b_j − ρ·ξ·i·u = (b_j − 0) + (0 − ρ·ξ·u)·i... actually b_j is real and
  // ρ·ξ·i·u = (0, ρ·ξ·u), so b_j − ρ·ξ·i·u = (b_j, −ρ·ξ·u).
  const bMinusA = [bj, -rhoXi * u];
  const num = cSub(bMinusA, d);
  const den = cAdd(bMinusA, d);
  const g = cDiv(num, den);

  // e^(−d·T)
  const edT = cExp(cScale(d, -T));

  // (1 − g·e^(−d·T)) / (1 − g)
  const one = [1, 0];
  const n1 = cSub(one, cMul(g, edT));
  const n2 = cSub(one, g);
  const ratio = cDiv(n1, n2);
  const logRatio = cLog(ratio);

  // C_j = (r−q)·i·u·T + (κθ/ξ²)·[num·T − 2·log(ratio)]
  const rmq_iu_T = cScale(iu, (r - q) * T);
  const term = cSub(cScale(num, T), cScale(logRatio, 2));
  const Cj = cAdd(rmq_iu_T, cScale(term, (kappa * theta) / (xi * xi)));

  // D_j = (num / ξ²) · (1 − e^(−d·T)) / (1 − g·e^(−d·T))
  const numer = cSub(one, edT);
  const denom = cSub(one, cMul(g, edT));
  const Dj = cMul(cScale(num, 1 / (xi * xi)), cDiv(numer, denom));

  // f_j = exp(C_j + D_j·v₀ + i·u·ln S₀)
  const iuLogS = cScale(iu, Math.log(S0));
  const exponent = cAdd(cAdd(Cj, cScale(Dj, v0)), iuLogS);
  return cExp(exponent);
}

// Simpson's rule on the Heston Re[e^(−i·u·ln K)·f_j(u) / (i·u)] integrand
// for a given slice of u-values; avoids re-sampling on each call by
// pre-computing the u-grid and Simpson weights once at module scope.
const U_GRID = new Float64Array(INT_N);
const U_WEIGHTS = new Float64Array(INT_N);
{
  const h = INT_U_MAX / (INT_N - 1);
  for (let i = 0; i < INT_N; i++) U_GRID[i] = Math.max(1e-6, i * h);
  // Composite Simpson: 1, 4, 2, 4, 2, ..., 4, 1 scaled by h/3
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
    // Re[e^(−i·u·ln K) · f / (i·u)]
    // e^(−i·u·ln K) = (cos(u·ln K), −sin(u·ln K))
    const eNegIu = [Math.cos(u * logK), -Math.sin(u * logK)];
    const num = cMul(eNegIu, f);
    // divide by (i·u) = (0, u): (a+bi)/(0+ui) = (b−ai)/u → real part = b/u
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

// ------- BSM pricer and Newton inversion for IV ---------------------------

function phi(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}
function Phi(x) {
  // Abramowitz-Stegun 26.2.17 — 7 digit accuracy, avoids pulling erf
  const a1 = 0.31938153;
  const a2 = -0.356563782;
  const a3 = 1.781477937;
  const a4 = -1.821255978;
  const a5 = 1.330274429;
  const k = 1 / (1 + 0.2316419 * Math.abs(x));
  const w = 1 - phi(x) * (a1*k + a2*k*k + a3*k*k*k + a4*k*k*k*k + a5*k*k*k*k*k);
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
    const step = diff / v;
    sigma -= step;
    if (sigma < 1e-4) sigma = 1e-4;
    if (sigma > 5) sigma = 5;
  }
  return sigma > 0 && sigma < 5 ? sigma : null;
}

// ------- Parameter reparameterization ------------------------------------

function unpack(theta) {
  // theta = [log κ, log θ, log ξ, atanh ρ, log v₀]
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

// ------- Nelder-Mead simplex (adaptive coefficients, Gao-Han 2012) -------

function nelderMead(f, x0, { maxIters = 200, tol = 1e-8, step = 0.1 } = {}) {
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
  let iters = 0;

  for (; iters < maxIters; iters++) {
    // sort by value
    const idx = [...Array(n + 1).keys()].sort((a, b) => values[a] - values[b]);
    const ordered = idx.map((i) => simplex[i]);
    const valOrdered = idx.map((i) => values[i]);
    for (let i = 0; i <= n; i++) { simplex[i] = ordered[i]; values[i] = valOrdered[i]; }

    const best = values[0];
    const worst = values[n];
    if (Math.abs(worst - best) < tol) break;

    // centroid of all but worst
    const centroid = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) centroid[j] += simplex[i][j];
    }
    for (let j = 0; j < n; j++) centroid[j] /= n;

    // reflection
    const xr = centroid.map((c, j) => c + alpha * (c - simplex[n][j]));
    const fr = f(xr);

    if (fr < values[0]) {
      // expansion
      const xe = centroid.map((c, j) => c + beta * (xr[j] - c));
      const fe = f(xe);
      if (fe < fr) { simplex[n] = xe; values[n] = fe; } else { simplex[n] = xr; values[n] = fr; }
    } else if (fr < values[n - 1]) {
      simplex[n] = xr; values[n] = fr;
    } else {
      // contraction
      const outside = fr < values[n];
      const xc = outside
        ? centroid.map((c, j) => c + gamma * (xr[j] - c))
        : centroid.map((c, j) => c + gamma * (simplex[n][j] - c));
      const fc = f(xc);
      if (fc < (outside ? fr : values[n])) {
        simplex[n] = xc; values[n] = fc;
      } else {
        // shrink
        for (let i = 1; i <= n; i++) {
          simplex[i] = simplex[0].map((x0j, j) => x0j + delta * (simplex[i][j] - x0j));
          values[i] = f(simplex[i]);
        }
      }
    }
  }

  const bestIdx = values.indexOf(Math.min(...values));
  return { x: simplex[bestIdx], value: values[bestIdx], iters };
}

// ------- Slice extraction -------------------------------------------------

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
    // Use OTM for each side: calls for K ≥ spot, puts for K < spot,
    // so we stay on the liquid side of the smile.
    const source = strike >= spotPrice ? call : put;
    if (!source) continue;
    if (source.implied_volatility <= 0) continue;
    rows.push({
      strike,
      iv: source.implied_volatility,
      side: strike >= spotPrice ? 'call' : 'put',
    });
  }
  rows.sort((a, b) => a.strike - b.strike);
  return rows;
}

// Restrict to the ±20% log-moneyness band where BSM inversion is stable
// and the strike is likely to be quoted with both-sided marks. Very deep
// OTM strikes can have wide bid-ask and an isolated IV outlier there
// pulls the 5-parameter fit off the ATM region that actually matters.
function filterAtmBand(rows, spotPrice, maxLogM = 0.2) {
  return rows.filter((r) => Math.abs(Math.log(r.strike / spotPrice)) <= maxLogM);
}

// ------- Calibration objective + driver -----------------------------------

function calibrateHeston(slice, S0, T, r, q, init) {
  const obj = (theta) => {
    const p = unpack(theta);
    // Penalize pathological values
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
  const params = unpack(res.x);
  const rmse = Math.sqrt(res.value);
  return { params, rmse, iters: res.iters };
}

// Parameter seed that usually gets Nelder-Mead most of the way to a good
// SPX-monthly fit in <100 iterations. Numbers are a rough Bakshi-Cao-Chen
// 1997 estimate for S&P 500 options, still close enough to today's
// calibrations to serve as a warm start.
const INIT_PARAMS = {
  kappa: 2.0,
  theta: 0.04,
  xi: 0.4,
  rho: -0.7,
  v0: 0.04,
};

// ------- UI ---------------------------------------------------------------

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
  const activeExp = expiration || defaultExpiration;

  const slice = useMemo(() => {
    if (!data || !activeExp) return [];
    const raw = sliceObservations(data.contracts, activeExp, data.spotPrice);
    return filterAtmBand(raw, data.spotPrice, 0.2);
  }, [data, activeExp]);

  const dte = useMemo(() => {
    if (!activeExp || !data?.capturedAt) return null;
    return daysToExpiration(activeExp, data.capturedAt);
  }, [activeExp, data]);

  const T = dte != null ? dte / 365 : null;

  // Calibration is synchronous (~100-400 ms for a typical SPX slice on a
  // modern laptop) so useMemo is cleaner than setState-in-effect — the
  // render pause is short enough to be imperceptible against the network
  // fetch that already gated the slice.
  const calib = useMemo(() => {
    if (!data || !activeExp || slice.length < 6 || !T || T <= 0) return null;
    const res = calibrateHeston(slice, data.spotPrice, T, RATE_R, RATE_Q, INIT_PARAMS);
    return { ...res, nSlice: slice.length, expiration: activeExp };
  }, [data, activeExp, slice, T]);

  useEffect(() => {
    if (!Plotly || !chartRef.current || !calib || slice.length === 0 || !T || !data) return;

    const strikes = slice.map((r) => r.strike);
    const ivs = slice.map((r) => r.iv * 100);
    const K_lo = Math.min(...strikes);
    const K_hi = Math.max(...strikes);
    const nGrid = 60;
    const gridK = new Array(nGrid);
    const gridIv = new Array(nGrid);
    for (let i = 0; i < nGrid; i++) {
      const K = K_lo + (i / (nGrid - 1)) * (K_hi - K_lo);
      gridK[i] = K;
      const c = hestonCall(calib.params, data.spotPrice, K, T, RATE_R, RATE_Q);
      const iv = bsmIv(c, data.spotPrice, K, T, RATE_R, RATE_Q);
      gridIv[i] = iv != null ? iv * 100 : null;
    }

    const allIv = [...ivs, ...gridIv.filter((v) => v != null)];
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
      {
        x: gridK,
        y: gridIv,
        mode: 'lines',
        name: 'Heston fit',
        line: { color: PLOTLY_COLORS.highlight, width: 2 },
        hoverinfo: 'skip',
        connectgaps: false,
      },
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
        ...plotlyTitle('Heston Smile Fit · SPX'),
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
  const feller = calib ? 2 * calib.params.kappa * calib.params.theta - calib.params.xi ** 2 : null;

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
        model · heston · cir stochastic variance · 5 parameters
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
          label="κ · mean rev."
          value={calib ? formatFixed(calib.params.kappa, 2) : '-'}
          sub="speed to θ"
        />
        <StatCell
          label="θ · long-run σ²"
          value={calib ? formatPct(Math.sqrt(calib.params.theta), 1) : '-'}
          sub="as ann. vol"
          accent={PLOTLY_COLORS.primary}
        />
        <StatCell
          label="ξ · vol of vol"
          value={calib ? formatFixed(calib.params.xi, 3) : '-'}
          sub="ξ in σ-units"
        />
        <StatCell
          label="ρ · correlation"
          value={calib ? formatFixed(calib.params.rho, 3) : '-'}
          sub="equity leverage"
          accent={calib && calib.params.rho < -0.5 ? PLOTLY_COLORS.secondary : undefined}
        />
        <StatCell
          label="v₀ · spot σ"
          value={calib ? formatPct(Math.sqrt(calib.params.v0), 1) : '-'}
          sub="ann. vol today"
        />
        <StatCell
          label="Fit RMSE (IV)"
          value={calib ? formatPct(calib.rmse, 2) : '-'}
          sub={calib ? `n=${calib.nSlice} · ${calib.iters} iter` : '-'}
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
          Heston is the first stochastic-volatility model that people routinely
          calibrate in closed form. Instead of pinning volatility to a single
          constant, it lets variance itself drift around a long-run level through
          the mean-reverting process{' '}
          <code style={{ color: 'var(--text-primary)' }}>dv = κ(θ−v)dt + ξ√v dW</code>,
          with a correlation ρ linking variance shocks to spot shocks.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          Five parameters (κ, θ, ξ, ρ, v₀) are calibrated to the{' '}
          <strong style={{ color: PLOTLY_COLORS.primary }}>observed SPX IV smile</strong>{' '}
          at one expiration. The optimizer is Nelder-Mead in IV-space, and the
          model prices come from the two-integral Heston formula using the
          Little-Trap stable characteristic function.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          The{' '}
          <strong style={{ color: PLOTLY_COLORS.highlight }}>fitted smile</strong>{' '}
          tracks the shape pretty well for monthly tenors. It systematically
          undershoots the short end, though. The square-root diffusion just cannot
          produce enough short-dated skew. That gap is the empirical anomaly
          that motivates jumps (Bates), rough vol (the Rough Bergomi model below),
          and local-stochastic hybrids (the LSV model below).
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          <strong style={{ color: 'var(--text-primary)' }}>Reading.</strong>{' '}
          The <strong style={{ color: PLOTLY_COLORS.primary }}>blue dots</strong>{' '}
          are the chain&apos;s observed IVs (OTM puts below spot, OTM calls
          above). The{' '}
          <strong style={{ color: PLOTLY_COLORS.highlight }}>amber curve</strong>{' '}
          is the Heston smile that best fits them in IV-space under
          5-parameter Nelder-Mead.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          The <strong>Feller condition</strong> 2κθ &gt; ξ² is{' '}
          {feller != null ? (
            <strong
              style={{
                color: feller > 0 ? PLOTLY_COLORS.positive : PLOTLY_COLORS.secondary,
              }}
            >
              {feller > 0 ? `satisfied (2κθ − ξ² = ${feller.toFixed(3)})` : `violated (2κθ − ξ² = ${feller.toFixed(3)})`}
            </strong>
          ) : (
            '-'
          )}
          {'. '}
          When Feller fails, the variance process can touch zero. This is
          usually treated as an artifact of the calibration pushing ξ up to
          match deep-OTM put skew that the square-root diffusion cannot
          produce without extra state.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          A strongly negative ρ is the equity-leverage effect. Variance and
          spot co-move down on sell-offs, which is why the sign of ρ comes
          out clearly negative on any SPX calibration.
        </p>
        <p style={{ margin: 0 }}>
          The fit is local to one slice. A full surface calibration across
          expirations would add term-structure constraints the single-slice
          fit does not see.
        </p>
      </div>
    </div>
  );
}
