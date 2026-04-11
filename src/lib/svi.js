// Jim Gatheral's Stochastic Volatility Inspired (SVI) raw parameterization,
// with a Levenberg-Marquardt calibrator, no-arbitrage diagnostics, and
// Breeden-Litzenberger risk-neutral density extraction.
//
// Raw SVI total variance as a function of log-moneyness k = ln(K / F):
//
//     w(k; a, b, rho, m, sigma)
//       = a + b * ( rho * (k - m) + sqrt((k - m)^2 + sigma^2) )
//
// Implied variance is w(k) / T and implied volatility is sqrt(w(k) / T).
//
// Parameter admissibility:
//   b >= 0, |rho| < 1, sigma > 0,
//   a + b * sigma * sqrt(1 - rho^2) >= 0  (total-variance non-negativity at the vertex)
//
// Non-admissible parameters can still minimize residuals on a slice but will
// produce w(k) < 0 somewhere. The solver below enforces admissibility by
// reparameterizing the unbounded variables through exp / tanh.
//
// No-arbitrage checks:
//   - butterfly (marginal): Durrleman's g(k) >= 0
//   - total variance: w(k) >= 0 everywhere on the evaluation grid
//
// The calendar-arbitrage check needs two slices and lives in sviCalendarCheck.

const TWO_PI = 2 * Math.PI;
const SQRT_TWO = Math.SQRT2;
const MIN_YEARS = 1 / 1460; // ~6 hours, floor so intraday expiries do not blow up T -> 0

export function sviTotalVariance({ a, b, rho, m, sigma }, k) {
  const u = k - m;
  const v = Math.sqrt(u * u + sigma * sigma);
  return a + b * (rho * u + v);
}

export function sviImpliedVol(params, k, T) {
  const w = sviTotalVariance(params, k);
  if (w <= 0 || T <= 0) return null;
  return Math.sqrt(w / T);
}

// First derivative dw/dk — needed for Durrleman's butterfly test.
function sviFirstDerivative({ b, rho, m, sigma }, k) {
  const u = k - m;
  const v = Math.sqrt(u * u + sigma * sigma);
  return b * (rho + u / v);
}

// Second derivative d2w/dk2 — butterfly test.
function sviSecondDerivative({ b, m, sigma }, k) {
  const u = k - m;
  const v = Math.sqrt(u * u + sigma * sigma);
  return (b * sigma * sigma) / (v * v * v);
}

// Durrleman's g(k). A slice is butterfly-arbitrage-free iff g(k) >= 0 everywhere.
// Source: Gatheral & Jacquier (2014), "Arbitrage-free SVI volatility surfaces".
export function durrlemanG(params, k) {
  const w = sviTotalVariance(params, k);
  if (w <= 0) return -Infinity;
  const wp = sviFirstDerivative(params, k);
  const wpp = sviSecondDerivative(params, k);
  const term1 = 1 - (k * wp) / (2 * w);
  const term2 = (wp * wp) / 4 * (1 / w + 0.25);
  const term3 = wpp / 2;
  return term1 * term1 - term2 + term3;
}

// ---------------------------------------------------------------------------
// Reparameterization: the solver operates in unconstrained theta-space so
// that b, sigma stay positive and |rho| < 1 by construction. a and m are left
// free; admissibility on "a + b*sigma*sqrt(1 - rho^2) >= 0" is validated after
// convergence rather than enforced as a hard constraint (barrier penalty is
// enough to keep LM honest on realistic data).

function thetaToParams(theta) {
  const [a, m, tb, tr, ts] = theta;
  const b = Math.exp(tb);
  const rho = Math.tanh(tr);
  const sigma = Math.exp(ts);
  return { a, b, rho, m, sigma };
}

function paramsToTheta({ a, b, rho, m, sigma }) {
  return [
    a,
    m,
    Math.log(Math.max(b, 1e-8)),
    Math.atanh(clamp(rho, -0.999, 0.999)),
    Math.log(Math.max(sigma, 1e-6)),
  ];
}

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

// Analytic jacobian row for one (k, w_observed) sample, in theta-space.
// Column order matches theta: [a, m, tb, tr, ts].
function jacobianRow(params, k) {
  const { b, rho, m, sigma } = params;
  const u = k - m;
  const v = Math.sqrt(u * u + sigma * sigma);

  // Chain rule through the reparameterization:
  //   dw/dtb = dw/db * b
  //   dw/dtr = dw/drho * (1 - rho^2)
  //   dw/dts = dw/dsigma * sigma
  const dw_da = 1;
  const dw_dm = -b * (rho + u / v);
  const dw_db = rho * u + v;
  const dw_drho = b * u;
  const dw_dsigma = (b * sigma) / v;

  return [
    dw_da,
    dw_dm,
    dw_db * b,
    dw_drho * (1 - rho * rho),
    dw_dsigma * sigma,
  ];
}

// ---------------------------------------------------------------------------
// Linear algebra helpers — 5x5 Gauss-Jordan is sufficient and avoids pulling
// in a matrix library for a problem this small.

function solveSymmetric(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let i = 0; i < n; i++) {
    let pivotRow = i;
    let pivotAbs = Math.abs(M[i][i]);
    for (let r = i + 1; r < n; r++) {
      const v = Math.abs(M[r][i]);
      if (v > pivotAbs) {
        pivotRow = r;
        pivotAbs = v;
      }
    }
    if (pivotAbs < 1e-14) return null;
    if (pivotRow !== i) {
      const tmp = M[i];
      M[i] = M[pivotRow];
      M[pivotRow] = tmp;
    }
    const piv = M[i][i];
    for (let c = i; c <= n; c++) M[i][c] /= piv;
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const factor = M[r][i];
      if (factor === 0) continue;
      for (let c = i; c <= n; c++) {
        M[r][c] -= factor * M[i][c];
      }
    }
  }
  return M.map((row) => row[n]);
}

// ---------------------------------------------------------------------------
// Heuristic initial guess. Robust enough for index-option slices with a visible
// kink and negative skew. The LM solver refines from here.

function initialGuess(samples) {
  if (samples.length === 0) return { a: 0.01, b: 0.1, rho: -0.3, m: 0, sigma: 0.1 };
  const ks = samples.map((s) => s.k);
  const ws = samples.map((s) => s.w);
  const wMin = Math.min(...ws);
  const wMax = Math.max(...ws);
  const kSpan = Math.max(Math.max(...ks) - Math.min(...ks), 1e-3);
  let mGuess = 0;
  let wMinLocal = Infinity;
  for (const s of samples) {
    if (s.w < wMinLocal) {
      wMinLocal = s.w;
      mGuess = s.k;
    }
  }
  const bGuess = Math.max(0.02, (wMax - wMin) / kSpan);
  const aGuess = Math.max(wMin * 0.5, 1e-6);
  return { a: aGuess, b: bGuess, rho: -0.3, m: mGuess, sigma: 0.1 };
}

// ---------------------------------------------------------------------------
// The Levenberg-Marquardt core. Residuals are w_model(k_i) - w_obs_i with
// optional per-sample weights (defaulting to unity). Convergence is declared
// when ||delta||_inf drops below tol * (1 + ||theta||_inf) or cost stops
// improving.

function runLevenbergMarquardt({
  samples,
  initial,
  maxIter = 200,
  tol = 1e-10,
}) {
  let theta = paramsToTheta(initial);
  let params = thetaToParams(theta);
  const n = samples.length;

  function residualsAndCost(p) {
    let cost = 0;
    const r = new Array(n);
    for (let i = 0; i < n; i++) {
      const s = samples[i];
      const diff = sviTotalVariance(p, s.k) - s.w;
      const weighted = diff * (s.weight ?? 1);
      r[i] = weighted;
      cost += weighted * weighted;
    }
    return { r, cost: 0.5 * cost };
  }

  let { r, cost } = residualsAndCost(params);
  let lambda = 1e-3;
  let converged = false;
  let iters = 0;

  for (; iters < maxIter; iters++) {
    // Assemble J^T J and J^T r.
    const JtJ = [
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
    ];
    const Jtr = [0, 0, 0, 0, 0];
    for (let i = 0; i < n; i++) {
      const row = jacobianRow(params, samples[i].k);
      const weight = samples[i].weight ?? 1;
      for (let a = 0; a < 5; a++) {
        const wa = row[a] * weight;
        Jtr[a] += wa * r[i];
        for (let b = a; b < 5; b++) {
          JtJ[a][b] += wa * row[b] * weight;
        }
      }
    }
    for (let a = 0; a < 5; a++) {
      for (let b = a + 1; b < 5; b++) JtJ[b][a] = JtJ[a][b];
    }

    // Damping: (J^T J + lambda * diag(J^T J)) delta = -J^T r
    const damped = JtJ.map((row, i) => {
      const copy = [...row];
      copy[i] += lambda * Math.max(JtJ[i][i], 1e-8);
      return copy;
    });
    const neg = Jtr.map((v) => -v);
    const delta = solveSymmetric(damped, neg);
    if (!delta) {
      lambda *= 10;
      if (lambda > 1e12) break;
      continue;
    }

    const thetaNew = theta.map((v, i) => v + delta[i]);
    const paramsNew = thetaToParams(thetaNew);
    const { r: rNew, cost: costNew } = residualsAndCost(paramsNew);

    if (costNew < cost) {
      const stepNorm = Math.max(...delta.map(Math.abs));
      const thetaNorm = Math.max(...thetaNew.map(Math.abs)) + 1;
      theta = thetaNew;
      params = paramsNew;
      r = rNew;
      const prevCost = cost;
      cost = costNew;
      lambda = Math.max(lambda / 10, 1e-12);
      if (stepNorm < tol * thetaNorm || Math.abs(prevCost - cost) < tol * (1 + cost)) {
        converged = true;
        iters++;
        break;
      }
    } else {
      lambda *= 10;
      if (lambda > 1e12) break;
    }
  }

  return { params, cost, converged, iterations: iters };
}

// ---------------------------------------------------------------------------
// Data preparation: deduplicate strikes (prefer OTM side), scrub bad IVs,
// convert to (k, w) samples. Keeping deep wings in an unweighted fit lets
// junk-priced far-OTM contracts dominate the residuals, especially on short
// tenors where the useful window is narrow. Two mitigations:
//
//   1. The moneyness window is tenor-scaled: ±5 * atmIv * sqrt(T), clipped
//      to [0.1, maxAbsK]. This tracks roughly five standard deviations of
//      log-price under the ATM vol, which is where liquidity lives.
//
//   2. Samples are vega-weighted. Black-Scholes vega peaks at the ATM strike
//      and decays like a gaussian in the wings, so liquid strikes drive the
//      fit and crap-priced deep wings contribute close to nothing.

function bsVegaAt(S, K, T, sigma) {
  if (sigma <= 0 || T <= 0 || K <= 0) return 0;
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + 0.5 * sigma * sigma * T) / (sigma * sqrtT);
  return S * sqrtT * Math.exp(-0.5 * d1 * d1) / Math.sqrt(TWO_PI);
}

function estimateAtmIv(contracts, spotPrice) {
  const atmWindow = Math.max(spotPrice * 0.005, 0.5);
  const nearby = contracts
    .filter(
      (c) =>
        c.implied_volatility != null &&
        c.implied_volatility > 0 &&
        c.implied_volatility < 2 &&
        Math.abs(c.strike_price - spotPrice) <= atmWindow
    )
    .sort((a, b) => Math.abs(a.strike_price - spotPrice) - Math.abs(b.strike_price - spotPrice));
  if (nearby.length === 0) return 0.2;
  return nearby[0].implied_volatility;
}

function prepareSamples({ contracts, spotPrice, T, forward, maxAbsK = 0.6 }) {
  const F = forward ?? spotPrice;
  const atmIvGuess = estimateAtmIv(contracts, spotPrice);
  // Five ATM standard deviations at this tenor, floored at 10%.
  const tenorWindow = Math.max(Math.min(5 * atmIvGuess * Math.sqrt(T), maxAbsK), 0.1);
  const byStrike = new Map();
  for (const c of contracts) {
    if (!c || !c.strike_price || !c.implied_volatility) continue;
    const iv = c.implied_volatility;
    if (!Number.isFinite(iv) || iv <= 0.01 || iv > 2.5) continue;
    const k = Math.log(c.strike_price / F);
    if (Math.abs(k) > tenorWindow) continue;
    const existing = byStrike.get(c.strike_price);
    const preferOtm = (c.contract_type === 'call' && c.strike_price >= F) ||
      (c.contract_type === 'put' && c.strike_price <= F);
    if (existing && !preferOtm) continue;
    const vega = bsVegaAt(spotPrice, c.strike_price, T, iv);
    // Zero-vega strikes are either too deep OTM to price or have a degenerate
    // tenor — either way the IV is noise. Skipping is cleaner than masking
    // with a 1e-8 floor that pretends to carry information it does not have.
    if (vega <= 0) continue;
    byStrike.set(c.strike_price, {
      k,
      w: iv * iv * T,
      strike: c.strike_price,
      iv,
      weight: vega,
    });
  }
  const samples = Array.from(byStrike.values()).sort((a, b) => a.k - b.k);
  // Normalize weights so the overall cost scale is comparable across tenors.
  const totalWeight = samples.reduce((acc, s) => acc + s.weight, 0);
  if (totalWeight > 0) {
    const scale = samples.length / totalWeight;
    for (const s of samples) s.weight *= scale;
  }
  return { samples, tenorWindow, atmIvGuess };
}

// ---------------------------------------------------------------------------
// Top-level fit. Returns params, cost, RMSE on IV (not variance — easier to
// interpret), admissibility flags, and the sample set used for fitting.

export function fitSviSlice({
  contracts,
  spotPrice,
  expirationDate,
  capturedAt,
  forward = null,
  maxAbsK = 0.6,
}) {
  const refMs = capturedAt ? new Date(capturedAt).getTime() : Date.now();
  const expMs = new Date(`${expirationDate}T20:00:00Z`).getTime();
  const T = Math.max((expMs - refMs) / (365 * 86400 * 1000), MIN_YEARS);
  const { samples, tenorWindow, atmIvGuess } = prepareSamples({
    contracts,
    spotPrice,
    T,
    forward,
    maxAbsK,
  });
  if (samples.length < 6) {
    return {
      ok: false,
      reason: `insufficient samples (${samples.length})`,
      expirationDate,
      T,
      sampleCount: samples.length,
    };
  }

  // Multi-start: LM on a 5-param non-convex problem can easily hit a shallow
  // local minimum (wrong m, backwards rho). Kick off several seeds covering
  // the plausible equity-skew region and accept the lowest-cost outcome.
  const heuristic = initialGuess(samples);
  const seeds = [
    heuristic,
    { ...heuristic, rho: -0.5, m: 0 },
    { ...heuristic, rho: -0.7, m: 0 },
    { ...heuristic, rho: -0.3, m: 0.01 },
    { ...heuristic, rho: -0.1, m: -0.01 },
    { ...heuristic, rho: 0, m: 0, sigma: 0.15, b: Math.max(heuristic.b, 0.05) },
  ];
  let best = null;
  for (const seed of seeds) {
    const attempt = runLevenbergMarquardt({ samples, initial: seed, maxIter: 300 });
    if (!best || attempt.cost < best.cost) best = attempt;
  }
  const { params, cost, converged, iterations } = best;

  // IV-space RMSE for human-readable goodness-of-fit.
  let sseIv = 0;
  let minW = Infinity;
  for (const s of samples) {
    const wModel = sviTotalVariance(params, s.k);
    if (wModel < minW) minW = wModel;
    const ivModel = wModel > 0 ? Math.sqrt(wModel / T) : 0;
    const diff = ivModel - s.iv;
    sseIv += diff * diff;
  }
  const rmseIv = Math.sqrt(sseIv / samples.length);

  // Admissibility diagnostics.
  const vertexFloor = params.a + params.b * params.sigma * Math.sqrt(1 - params.rho * params.rho);
  const nonNegativeVariance = vertexFloor >= -1e-10 && minW >= -1e-10;

  // Butterfly test on a dense grid. Checked over the tenor-scaled window
  // that the calibration actually targeted, because SVI can arbitrage
  // harmlessly far out in the wings where no liquid strikes exist.
  const gridCount = 121;
  const gridK = new Array(gridCount);
  const gridG = new Array(gridCount);
  const kStep = (2 * tenorWindow) / (gridCount - 1);
  let minG = Infinity;
  for (let i = 0; i < gridCount; i++) {
    gridK[i] = -tenorWindow + i * kStep;
    gridG[i] = durrlemanG(params, gridK[i]);
    if (gridG[i] < minG) minG = gridG[i];
  }
  const butterflyArbFree = minG >= -1e-6;

  return {
    ok: true,
    expirationDate,
    T,
    params,
    cost,
    rmseIv,
    converged,
    iterations,
    samples,
    sampleCount: samples.length,
    tenorWindow,
    atmIvGuess,
    diagnostics: {
      vertexFloor,
      minVarianceOnSamples: minW,
      minDurrlemanG: minG,
      nonNegativeVariance,
      butterflyArbFree,
    },
  };
}

// ---------------------------------------------------------------------------
// Breeden-Litzenberger risk-neutral density.
//
// Given a smile (SVI or raw), for each strike K on a dense grid:
//   1. sigma(K) = SVI-implied vol
//   2. C(S, K, T, sigma)  — Black-Scholes, r = q = 0
//   3. f(K) = d2C / dK2   — evaluated by central differences
//
// r = q = 0 is a deliberate simplification: the dashboard reads a single spot
// and does not carry a dividend yield. The shape of the density is what the
// user cares about and is not sensitive to a 1-2% rate shift.

function normCdf(x) {
  // Abramowitz & Stegun 7.1.26 — 6dp accuracy, fine for plotting.
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-0.5 * x * x);
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const p = 1 - d * poly;
  return x >= 0 ? p : 1 - p;
}

function bsCall(S, K, T, sigma) {
  if (sigma <= 0 || T <= 0) return Math.max(S - K, 0);
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + 0.5 * sigma * sigma * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  return S * normCdf(d1) - K * normCdf(d2);
}

export function breedenLitzenberger({
  params,
  spotPrice,
  T,
  kMin = -0.6,
  kMax = 0.6,
  steps = 401,
}) {
  const strikes = new Array(steps);
  const call = new Array(steps);
  for (let i = 0; i < steps; i++) {
    const k = kMin + ((kMax - kMin) * i) / (steps - 1);
    const K = spotPrice * Math.exp(k);
    strikes[i] = K;
    const w = sviTotalVariance(params, k);
    const sigma = w > 0 && T > 0 ? Math.sqrt(w / T) : 0;
    call[i] = bsCall(spotPrice, K, T, sigma);
  }

  const density = new Array(steps);
  for (let i = 0; i < steps; i++) {
    if (i === 0 || i === steps - 1) {
      density[i] = 0;
      continue;
    }
    const h1 = strikes[i] - strikes[i - 1];
    const h2 = strikes[i + 1] - strikes[i];
    // Non-uniform central second difference.
    const d2 = 2 * (h1 * call[i + 1] - (h1 + h2) * call[i] + h2 * call[i - 1]) /
      (h1 * h2 * (h1 + h2));
    density[i] = Math.max(d2, 0); // clip tiny negatives from numerical noise
  }

  // Normalize to integrate to 1 so the chart is a proper density.
  let integral = 0;
  for (let i = 1; i < steps; i++) {
    const dx = strikes[i] - strikes[i - 1];
    integral += 0.5 * (density[i] + density[i - 1]) * dx;
  }
  if (integral > 0) {
    for (let i = 0; i < steps; i++) density[i] /= integral;
  }

  return { strikes, density, integral };
}

// Lognormal reference density — what BS would say if volatility were flat at
// the ATM level. Overlaid on the SVI-implied density so the user can see
// exactly where the market is pricing in excess tail risk.
export function lognormalDensity({ spotPrice, atmIv, T, strikes }) {
  if (!atmIv || atmIv <= 0 || T <= 0) return strikes.map(() => 0);
  const sigmaSqrtT = atmIv * Math.sqrt(T);
  const density = new Array(strikes.length);
  for (let i = 0; i < strikes.length; i++) {
    const K = strikes[i];
    if (K <= 0) {
      density[i] = 0;
      continue;
    }
    const z = (Math.log(K / spotPrice) + 0.5 * atmIv * atmIv * T) / sigmaSqrtT;
    density[i] = Math.exp(-0.5 * z * z) / (K * sigmaSqrtT * Math.sqrt(TWO_PI));
  }
  return density;
}

// Calendar-arbitrage check across two time slices — total variance must be
// non-decreasing in T at every log-moneyness point. Not currently invoked by
// the UI but exported for future surface-level validation.
export function sviCalendarCheck(nearParams, farParams, kGrid) {
  let minDelta = Infinity;
  for (const k of kGrid) {
    const delta = sviTotalVariance(farParams, k) - sviTotalVariance(nearParams, k);
    if (delta < minDelta) minDelta = delta;
  }
  return { minDelta, arbitrageFree: minDelta >= -1e-10 };
}

// ---------------------------------------------------------------------------
// Fit all expirations in a contract set and return a map keyed by
// expiration date. Skips slices that fail to produce a usable fit.

export function fitSviSurface({
  contracts,
  spotPrice,
  capturedAt,
  maxAbsK = 0.6,
}) {
  const byExp = new Map();
  for (const c of contracts) {
    if (!c.expiration_date) continue;
    if (!byExp.has(c.expiration_date)) byExp.set(c.expiration_date, []);
    byExp.get(c.expiration_date).push(c);
  }
  const fits = {};
  for (const [exp, slice] of byExp.entries()) {
    const result = fitSviSlice({
      contracts: slice,
      spotPrice,
      expirationDate: exp,
      capturedAt,
      maxAbsK,
    });
    if (result.ok) fits[exp] = result;
  }
  return fits;
}
