// Shared in-lab library for the /local page. Centralizes the SVI
// y-derivatives, the Dupire local-variance extraction, the bilinear
// look-up of σ_LV at an arbitrary (y, T), and the arbitrage diagnostics
// the slots on this page all consume. Keeping this in one file means
// SlotB's Monte Carlo pricer, SlotC's 1D slice viewers, and SlotD's
// forward-smile diagnostic all read from the exact same surface — so a
// disagreement between them is a disagreement in interpretation, not
// in numerics.
//
// Dupire (1994) in log-moneyness y = ln(K/F) and total variance
// w(y, T) = σ(y, T)²·T (Gatheral 2006, eq. 1.10):
//
//   σ²_LV(y, T) = (∂w/∂T) / N(y, w, ∂w/∂y, ∂²w/∂y²)
//
//   N = 1 − (y/w)·(∂w/∂y)
//       + ¼·(−¼ − 1/w + y²/w²)·(∂w/∂y)²
//       + ½·(∂²w/∂y²)
//
// With an SVI raw parameterization the y-derivatives are analytic. The
// T-derivative is a finite difference across adjacent fitted slices —
// the "linear-in-total-variance" interpolation between slices
// (Gatheral-Jacquier 2014) preserves calendar-arbitrage-freedom so long
// as w is non-decreasing in T at every y, which is checked per-cell
// below (dw/dT < 0 ⇒ calendar-arb flag).

export const DUPIRE_MIN_VARIANCE = 1e-5;   // σ²_LV floor to keep sqrt real
export const TARGET_T_POINTS = 32;         // rows in the (y, T) grid
export const TARGET_Y_POINTS = 64;         // cols in the (y, T) grid
export const Y_HALF_WIDTH = 0.20;          // ±20% log-moneyness window
export const MIN_T_YEARS = 7 / 365;        // floor against 1/T blow-up near 0DTE
export const MAX_RMSE = 0.012;             // skip slices that didn't converge cleanly

// ---- SVI y-derivatives (analytic) -----------------------------------------

export function sviW(params, y) {
  const { a, b, rho, m, sigma } = params;
  const u = y - m;
  return a + b * (rho * u + Math.sqrt(u * u + sigma * sigma));
}
export function sviDw(params, y) {
  const { b, rho, m, sigma } = params;
  const u = y - m;
  return b * (rho + u / Math.sqrt(u * u + sigma * sigma));
}
export function sviD2w(params, y) {
  const { b, m, sigma } = params;
  const u = y - m;
  const denom = Math.pow(u * u + sigma * sigma, 1.5);
  return (b * sigma * sigma) / denom;
}

// ---- Surface bootstrap from backend sviFits --------------------------------

export function buildSurface(sviFits) {
  if (!Array.isArray(sviFits) || sviFits.length === 0) return null;
  const clean = sviFits
    .filter((f) => f && f.params && f.t_years > 0 && Number.isFinite(f.rmse_iv))
    .filter((f) => f.rmse_iv <= MAX_RMSE)
    .map((f) => ({
      T: f.t_years,
      F: f.forward_price,
      params: f.params,
      rmse: f.rmse_iv,
      expiration: f.expiration_date,
    }))
    .sort((a, b) => a.T - b.T);
  if (clean.length < 3) return null;
  return clean;
}

// Bracket T inside the sorted surface. Returns {i, j, wt} such that
// T ≈ wt·slices[j].T + (1-wt)·slices[i].T.
export function bracketIndex(surface, T) {
  const n = surface.length;
  if (T <= surface[0].T) return { i: 0, j: 1, wt: 0 };
  if (T >= surface[n - 1].T) return { i: n - 2, j: n - 1, wt: 1 };
  for (let k = 0; k < n - 1; k++) {
    if (T >= surface[k].T && T <= surface[k + 1].T) {
      const span = surface[k + 1].T - surface[k].T;
      const wt = span > 0 ? (T - surface[k].T) / span : 0;
      return { i: k, j: k + 1, wt };
    }
  }
  return { i: 0, j: 1, wt: 0 };
}

// Evaluate (w, dw/dy, d²w/dy², dw/dT) at an arbitrary (y, T) by linearly
// interpolating between bracketing slices. dw/dT uses the finite
// difference across the same bracket — same value inside one (T_i, T_{i+1})
// strip, which is the correct piecewise-constant derivative of a
// piecewise-linear-in-T interpolant. No side effects.
export function sviDerivsAt(surface, y, T) {
  if (!surface || surface.length < 2) return null;
  const { i, j, wt } = bracketIndex(surface, T);
  const A = surface[i];
  const B = surface[j];
  const dT = B.T - A.T;
  const wA = sviW(A.params, y);
  const wB = sviW(B.params, y);
  const dwA = sviDw(A.params, y);
  const dwB = sviDw(B.params, y);
  const d2wA = sviD2w(A.params, y);
  const d2wB = sviD2w(B.params, y);
  const w = (1 - wt) * wA + wt * wB;
  const dw_dy = (1 - wt) * dwA + wt * dwB;
  const d2w_dy2 = (1 - wt) * d2wA + wt * d2wB;
  const dw_dT = dT > 0 ? (wB - wA) / dT : 0;
  return { w, dw_dy, d2w_dy2, dw_dT, iSlice: i, jSlice: j };
}

// Core local-variance evaluation at a single (y, T). Returns the scalar
// σ_LV along with a per-cell flags object so the caller can tell apart
// "w ≤ 0 (no surface here)", "dw/dT < 0 (calendar arbitrage)",
// "N ≤ 0 (butterfly arbitrage)", and "σ²_LV < MIN_VARIANCE (clip)".
export function dupireAt(surface, y, T) {
  const T_ = Math.max(T, MIN_T_YEARS);
  const d = sviDerivsAt(surface, y, T_);
  if (!d) return { sigma: null, flag: 'no-surface' };
  const { w, dw_dy, d2w_dy2, dw_dT } = d;
  if (w <= 0 || !Number.isFinite(w)) return { sigma: null, flag: 'w-nonpos' };
  if (dw_dT < 0) return { sigma: null, flag: 'calendar-arb' };
  const N =
    1
    - (y / w) * dw_dy
    + 0.25 * (-0.25 - 1 / w + (y * y) / (w * w)) * dw_dy * dw_dy
    + 0.5 * d2w_dy2;
  if (!(N > 0)) return { sigma: null, flag: 'butterfly-arb' };
  const locVar = dw_dT / N;
  if (!(locVar >= DUPIRE_MIN_VARIANCE)) return { sigma: null, flag: 'clipped' };
  return { sigma: Math.sqrt(locVar), flag: 'ok' };
}

// Build the full (y, T) Dupire grid. T is spaced geometrically to get
// dense sampling where the action is (short T) without spending cells
// on long-dated plateaus; y is uniform across ±Y_HALF_WIDTH. The
// returned `flags` mirror `sigma` one-to-one with a string tag per cell.
export function computeDupire(surface) {
  const Ts = new Array(TARGET_T_POINTS);
  const Ys = new Array(TARGET_Y_POINTS);

  const Tmin = Math.max(surface[0].T, MIN_T_YEARS);
  const Tmax = surface[surface.length - 1].T;
  const logTmin = Math.log(Tmin);
  const logTmax = Math.log(Tmax);
  for (let i = 0; i < TARGET_T_POINTS; i++) {
    const t = i / (TARGET_T_POINTS - 1);
    Ts[i] = Math.exp(logTmin + t * (logTmax - logTmin));
  }
  for (let j = 0; j < TARGET_Y_POINTS; j++) {
    Ys[j] = -Y_HALF_WIDTH + (j / (TARGET_Y_POINTS - 1)) * (2 * Y_HALF_WIDTH);
  }

  const sigma = new Array(TARGET_T_POINTS);
  const flags = new Array(TARGET_T_POINTS);
  for (let i = 0; i < TARGET_T_POINTS; i++) {
    sigma[i] = new Array(TARGET_Y_POINTS);
    flags[i] = new Array(TARGET_Y_POINTS);
  }

  for (let i = 0; i < TARGET_T_POINTS; i++) {
    for (let j = 0; j < TARGET_Y_POINTS; j++) {
      const { sigma: s, flag } = dupireAt(surface, Ys[j], Ts[i]);
      sigma[i][j] = s;
      flags[i][j] = flag;
    }
  }

  return { Ts, Ys, sigma, flags };
}

// Bilinear σ_LV lookup used by SlotB's Monte Carlo pricer and SlotD's
// forward-smile sampler. Input (y, T) is clipped to the computed grid's
// interior; cells that returned null fall back to a small positive floor
// so the Euler-Maruyama step never divides by zero or takes a NaN
// σ² into the log-normal increment. That floor is a numerical fix, not
// a model claim — the caller should separately flag when the query
// landed on a clipped cell.
export function bilinearSigma(grid, y, T) {
  const { Ts, Ys, sigma } = grid;
  const nT = Ts.length;
  const nY = Ys.length;

  const Tq = Math.max(Ts[0], Math.min(T, Ts[nT - 1]));
  const yq = Math.max(Ys[0], Math.min(y, Ys[nY - 1]));

  // Locate bracketing T and y cells. Ts is log-spaced but monotone; use
  // linear search bounded by nT so we can invert the mapping without
  // pulling an O(log n) bsearch in.
  let it = 0;
  for (let i = 0; i < nT - 1; i++) {
    if (Tq >= Ts[i] && Tq <= Ts[i + 1]) { it = i; break; }
    it = i + 1;
  }
  let jy = 0;
  for (let j = 0; j < nY - 1; j++) {
    if (yq >= Ys[j] && yq <= Ys[j + 1]) { jy = j; break; }
    jy = j + 1;
  }
  if (it >= nT - 1) it = nT - 2;
  if (jy >= nY - 1) jy = nY - 2;

  const tSpan = Ts[it + 1] - Ts[it];
  const ySpan = Ys[jy + 1] - Ys[jy];
  const ft = tSpan > 0 ? (Tq - Ts[it]) / tSpan : 0;
  const fy = ySpan > 0 ? (yq - Ys[jy]) / ySpan : 0;

  const s00 = sigma[it][jy];
  const s01 = sigma[it][jy + 1];
  const s10 = sigma[it + 1][jy];
  const s11 = sigma[it + 1][jy + 1];

  const fallback = Math.sqrt(DUPIRE_MIN_VARIANCE);
  const a = s00 == null ? fallback : s00;
  const b = s01 == null ? fallback : s01;
  const c = s10 == null ? fallback : s10;
  const d = s11 == null ? fallback : s11;

  const bottom = (1 - fy) * a + fy * b;
  const top = (1 - fy) * c + fy * d;
  const out = (1 - ft) * bottom + ft * top;
  return Number.isFinite(out) && out > 0 ? out : fallback;
}

// Coverage of the grid — fraction of cells where the Dupire extraction
// succeeded, plus per-flag counts so the caller can surface exactly
// where the surface is thin (butterfly in the wings? calendar inversion
// between one pair of adjacent expirations?).
export function coverageStats(grid) {
  if (!grid) return null;
  const { flags } = grid;
  let total = 0;
  const counts = {
    ok: 0,
    'w-nonpos': 0,
    'calendar-arb': 0,
    'butterfly-arb': 0,
    clipped: 0,
    'no-surface': 0,
  };
  for (let i = 0; i < flags.length; i++) {
    for (let j = 0; j < flags[i].length; j++) {
      total += 1;
      counts[flags[i][j]] = (counts[flags[i][j]] ?? 0) + 1;
    }
  }
  return { total, counts, coverage: total > 0 ? counts.ok / total : 0 };
}

// Abramowitz-Stegun 7.1.26 normal CDF — enough accuracy for BS pricing and
// implied-vol inversion at the display precision of the labs.
export function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-0.5 * x * x);
  const poly =
    t
    * (0.319381530
      + t * (-0.356563782
        + t * (1.781477937
          + t * (-1.821255978 + t * 1.330274429))));
  const p = 1 - d * poly;
  return x >= 0 ? p : 1 - p;
}

export function bsCall(S, K, T, sigma) {
  if (sigma <= 0 || T <= 0) return Math.max(S - K, 0);
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + 0.5 * sigma * sigma * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  return S * normCdf(d1) - K * normCdf(d2);
}

// Newton-Raphson on IV with a bisection fallback. vega = S·√T·φ(d1).
// Inverts a forward-measure call price back to Black-Scholes σ. The
// bisection bracket starts generous (1e-6 to 5) because the LV prices
// from SlotB can sit in unusual places in deep wings, and Newton's
// basin of attraction on extreme strikes is narrow.
export function impliedVol(price, S, K, T, { tol = 1e-5, maxIter = 50 } = {}) {
  const intrinsic = Math.max(S - K, 0);
  if (!(price > intrinsic)) return null;
  let sigma = 0.25;
  for (let i = 0; i < maxIter; i++) {
    const p = bsCall(S, K, T, sigma);
    const diff = p - price;
    if (Math.abs(diff) < tol) return sigma;
    const sqrtT = Math.sqrt(T);
    const d1 = (Math.log(S / K) + 0.5 * sigma * sigma * T) / (sigma * sqrtT);
    const vega = S * sqrtT * Math.exp(-0.5 * d1 * d1) / Math.sqrt(2 * Math.PI);
    if (vega <= 1e-10) break;
    let next = sigma - diff / vega;
    if (!(next > 0)) next = sigma * 0.5;
    if (next > 5) next = 5;
    sigma = next;
  }
  // Bisection fallback.
  let lo = 1e-6;
  let hi = 5;
  let pLo = bsCall(S, K, T, lo) - price;
  let pHi = bsCall(S, K, T, hi) - price;
  if (pLo * pHi > 0) return null;
  for (let i = 0; i < 100; i++) {
    const mid = 0.5 * (lo + hi);
    const pMid = bsCall(S, K, T, mid) - price;
    if (Math.abs(pMid) < tol) return mid;
    if (pLo * pMid < 0) { hi = mid; pHi = pMid; } else { lo = mid; pLo = pMid; }
  }
  return 0.5 * (lo + hi);
}

// Deterministic PRNG — mulberry32, seeded per call so slot-specific MC
// noise reshuffles don't alias across slots. See rough/slots/SlotB.jsx
// for the convention this shares with the /rough lab.
export function mulberry32(seed) {
  let s = seed | 0;
  return function next() {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Box-Muller from two uniforms. Pulls a single standard-normal per call.
export function gaussian(rng) {
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
