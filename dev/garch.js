// -----------------------------------------------------------------------------
// GARCH ensemble — pure-JS GARCH(1,1), GJR-GARCH(1,1,1), and EGARCH(1,1),
// fit by Gaussian maximum likelihood with a Nelder-Mead simplex search in
// unconstrained parameter space. Built for the dev lab at /dev, where the
// whole pipeline runs in the browser off the daily SPX closes that ship
// with the existing /api/gex-history endpoint.
//
// WHY THREE MODELS, NOT ONE
//
// GARCH(1,1) is the canonical volatility-clustering model: it captures
// persistence and mean reversion but treats positive and negative shocks
// symmetrically. Equity indices don't behave that way — a -2% day fattens
// next-day variance more than a +2% day does, the well-documented
// leverage effect. GJR-GARCH adds a gated extra loading on the squared
// return when the prior return was negative, which is the simplest way to
// write that asymmetry. EGARCH writes the recursion on log-variance with
// a signed innovation term, which handles the same asymmetry differently
// and — unlike the quadratic models — guarantees positive variance
// without any parameter-space constraints, at the cost of a nonlinear
// response surface that sometimes wins and sometimes loses against its
// quadratic cousins depending on the sample.
//
// Any one of the three is a defensible pick on SPX; picking the "right"
// one ex-ante by eyeballing a fit is model-selection theater. The honest
// move is to fit all three and average their forecasts with weights that
// reflect how well each one explains the in-sample data. BIC weights —
// derived from the Schwarz criterion under a flat prior — are the
// standard Bayesian-model-averaging recipe for this, and they penalize
// extra parameters so the ensemble doesn't silently drift toward the
// richest specification just because it fits the sample a little tighter.
//
// WHAT THE ENSEMBLE PRODUCES
//
// For each model: a full in-sample path of conditional variance, the
// fitted parameters, log-likelihood, AIC, and BIC. For the ensemble: the
// BIC-weighted blend of the conditional-variance paths and a forward
// forecast for any requested horizon. The forecast uses each model's
// closed-form h-step recursion from its current state and then blends
// the resulting variance paths with the same BIC weights.
//
// WHAT THE ENSEMBLE DOES NOT DO
//
// No t or GED innovations — Gaussian only. No regime-switching. No
// GARCH-in-mean. No high-frequency realized-measure augmentation. These
// are all reasonable extensions for a later iteration, but the
// three-model Gaussian-ML core is what needs to be right first, because
// everything downstream rides on it.
// -----------------------------------------------------------------------------

const TRADING_DAYS_YEAR = 252;
const SQRT_2_OVER_PI = Math.sqrt(2 / Math.PI);
const LOG_2PI = Math.log(2 * Math.PI);

// -- numerical helpers --------------------------------------------------------

function sigmoid(x) {
  if (x >= 0) {
    const z = Math.exp(-x);
    return 1 / (1 + z);
  }
  const z = Math.exp(x);
  return z / (1 + z);
}

function mean(arr) {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s / arr.length;
}

function sampleVariance(arr) {
  const m = mean(arr);
  let s = 0;
  for (let i = 0; i < arr.length; i++) {
    const d = arr[i] - m;
    s += d * d;
  }
  return s / Math.max(arr.length - 1, 1);
}

// Center returns at zero-mean before fitting. GARCH conventionally models
// innovations ε = r − μ; on daily SPX μ is near zero and second-order next
// to the volatility dynamics, so subtracting the sample mean and proceeding
// as if μ=0 is the usual pragmatic move. Keeping a non-zero conditional
// mean would add one parameter per model without meaningfully changing
// the variance fit on this sample length.
export function demean(returns) {
  const m = mean(returns);
  const out = new Array(returns.length);
  for (let i = 0; i < returns.length; i++) out[i] = returns[i] - m;
  return { series: out, mean: m };
}

// -- conditional-variance recursions ------------------------------------------

function garchCondVar(eps, omega, alpha, beta, init) {
  const n = eps.length;
  const h = new Array(n);
  h[0] = init;
  for (let t = 1; t < n; t++) {
    const prev = eps[t - 1];
    h[t] = omega + alpha * prev * prev + beta * h[t - 1];
  }
  return h;
}

function gjrCondVar(eps, omega, alpha, gamma, beta, init) {
  const n = eps.length;
  const h = new Array(n);
  h[0] = init;
  for (let t = 1; t < n; t++) {
    const prev = eps[t - 1];
    const I = prev < 0 ? 1 : 0;
    h[t] = omega + alpha * prev * prev + gamma * I * prev * prev + beta * h[t - 1];
  }
  return h;
}

function egarchCondVar(eps, omega, alpha, gamma, beta, init) {
  const n = eps.length;
  const h = new Array(n);
  const logH = new Array(n);
  logH[0] = Math.log(init);
  h[0] = init;
  for (let t = 1; t < n; t++) {
    const sigma = Math.sqrt(h[t - 1]);
    const z = eps[t - 1] / sigma;
    logH[t] = omega + alpha * (Math.abs(z) - SQRT_2_OVER_PI) + gamma * z + beta * logH[t - 1];
    // Cap the log-variance excursion so a bad simplex step can't blow up
    // into Infinity and poison downstream arithmetic. ±25 corresponds to
    // daily σ between ~3e-6 and ~3e+5, far outside any plausible SPX
    // region but still finite.
    if (logH[t] > 25) logH[t] = 25;
    else if (logH[t] < -25) logH[t] = -25;
    h[t] = Math.exp(logH[t]);
  }
  return h;
}

function gaussianNegLogLik(eps, h) {
  let nll = 0;
  for (let t = 0; t < eps.length; t++) {
    const ht = h[t];
    if (!(ht > 0) || !Number.isFinite(ht)) return Number.POSITIVE_INFINITY;
    nll += 0.5 * (LOG_2PI + Math.log(ht) + (eps[t] * eps[t]) / ht);
  }
  return nll;
}

// -- parameter transforms (unconstrained → constrained) ----------------------

// GARCH(1,1): ω > 0, α,β ∈ [0,1), α+β < 1 for stationarity.
// Parameterization: ω = exp(x₀); persistence p = α+β = σ(x₁) ∈ (0,1);
// share s = α/(α+β) = σ(x₂) ∈ (0,1). Then α = p·s, β = p·(1−s). This
// keeps the fit inside the stationary region automatically, and both
// components are strictly positive without needing a non-negativity
// barrier.
function unpackGarch(x) {
  const omega = Math.exp(x[0]);
  const p = sigmoid(x[1]);
  const s = sigmoid(x[2]);
  return { omega, alpha: p * s, beta: p * (1 - s) };
}

// GJR-GARCH(1,1,1) under symmetric Gaussian innovations: stationarity is
// α + γ/2 + β < 1 (since E[I·z²] = 1/2 when z is symmetric around zero
// and has unit variance). Parameterize the stationary sum P = α+γ/2+β
// via σ(x₁) and split it into three components with a softmax over
// (x₂, x₃, x₄) — but γ enters the split as half-weight because of the
// 1/2 factor in the stationarity bound. Concretely:
//   S = σ(x₁); w = softmax(x₂, x₃, x₄)
//   α_weight = w₀, γ_weight = 2·w₁, β_weight = w₂
//   α = S · α_weight / (α_weight + γ_weight/2 + β_weight)
// Rather than chase that normalization by hand, we use a simpler scheme:
// α, γ, β each get their own σ(·) coordinate scaled by S and a soft
// rejection is added to the objective if α + γ/2 + β ≥ 1.
function unpackGjr(x) {
  const omega = Math.exp(x[0]);
  const alpha = sigmoid(x[1]);
  const gamma = sigmoid(x[2]);
  const beta = sigmoid(x[3]);
  return { omega, alpha, gamma, beta };
}

// EGARCH: ω real, α,γ real, β ∈ (−1,1) for stationarity. ω and the news
// coefficients don't need positivity (log-variance handles that), so
// they're identity-mapped. Persistence β is bounded through tanh to keep
// the recursion stable without clipping a good fit.
function unpackEgarch(x) {
  return {
    omega: x[0],
    alpha: x[1],
    gamma: x[2],
    beta: Math.tanh(x[3]),
  };
}

// -- Nelder-Mead --------------------------------------------------------------

// Derivative-free simplex search. Small (3-4 dim) parameter spaces here so
// the overhead is modest; each likelihood eval is O(N) and Nelder-Mead
// usually converges in a few hundred iterations on the GARCH surface.
export function nelderMead(f, x0, opts = {}) {
  const {
    maxIter = 800,
    xTol = 1e-7,
    fTol = 1e-8,
    initialStep = 0.3,
    reflect = 1,
    expand = 2,
    contract = 0.5,
    shrink = 0.5,
  } = opts;

  const n = x0.length;
  const simplex = [x0.slice()];
  for (let i = 0; i < n; i++) {
    const v = x0.slice();
    v[i] = v[i] + (v[i] !== 0 ? initialStep * Math.abs(v[i]) : initialStep);
    simplex.push(v);
  }
  let values = simplex.map(f);

  const sortByValue = () => {
    const order = simplex
      .map((s, i) => i)
      .sort((a, b) => values[a] - values[b]);
    const newSimplex = order.map((i) => simplex[i]);
    const newValues = order.map((i) => values[i]);
    for (let i = 0; i <= n; i++) {
      simplex[i] = newSimplex[i];
      values[i] = newValues[i];
    }
  };

  for (let iter = 0; iter < maxIter; iter++) {
    sortByValue();

    const fSpread = values[n] - values[0];
    let xSpread = 0;
    for (let j = 0; j < n; j++) {
      let lo = simplex[0][j];
      let hi = simplex[0][j];
      for (let i = 1; i <= n; i++) {
        if (simplex[i][j] < lo) lo = simplex[i][j];
        if (simplex[i][j] > hi) hi = simplex[i][j];
      }
      if (hi - lo > xSpread) xSpread = hi - lo;
    }
    if (fSpread < fTol && xSpread < xTol) {
      return { x: simplex[0].slice(), fx: values[0], iter, converged: true };
    }

    // Centroid of the best n points
    const centroid = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) centroid[j] += simplex[i][j];
    }
    for (let j = 0; j < n; j++) centroid[j] /= n;

    // Reflection
    const xr = new Array(n);
    for (let j = 0; j < n; j++) xr[j] = centroid[j] + reflect * (centroid[j] - simplex[n][j]);
    const fr = f(xr);

    if (fr < values[0]) {
      const xe = new Array(n);
      for (let j = 0; j < n; j++) xe[j] = centroid[j] + expand * (xr[j] - centroid[j]);
      const fe = f(xe);
      if (fe < fr) {
        simplex[n] = xe;
        values[n] = fe;
      } else {
        simplex[n] = xr;
        values[n] = fr;
      }
      continue;
    }

    if (fr < values[n - 1]) {
      simplex[n] = xr;
      values[n] = fr;
      continue;
    }

    // Contraction — outside or inside depending on where the reflection fell
    if (fr < values[n]) {
      const xc = new Array(n);
      for (let j = 0; j < n; j++) xc[j] = centroid[j] + contract * (xr[j] - centroid[j]);
      const fc = f(xc);
      if (fc <= fr) {
        simplex[n] = xc;
        values[n] = fc;
        continue;
      }
    } else {
      const xc = new Array(n);
      for (let j = 0; j < n; j++) xc[j] = centroid[j] + contract * (simplex[n][j] - centroid[j]);
      const fc = f(xc);
      if (fc < values[n]) {
        simplex[n] = xc;
        values[n] = fc;
        continue;
      }
    }

    // Shrink toward best
    for (let i = 1; i <= n; i++) {
      for (let j = 0; j < n; j++) {
        simplex[i][j] = simplex[0][j] + shrink * (simplex[i][j] - simplex[0][j]);
      }
      values[i] = f(simplex[i]);
    }
  }

  sortByValue();
  return { x: simplex[0].slice(), fx: values[0], iter: maxIter, converged: false };
}

// -- model fitters ------------------------------------------------------------

function fitOne({ name, kParams, objective, unpack, startRaw, condVarFromParams }) {
  const { x, fx, converged, iter } = nelderMead(objective, startRaw);
  const params = unpack(x);
  const n = condVarFromParams(params).length;
  const logLik = -fx;
  const k = kParams;
  const aic = 2 * k - 2 * logLik;
  const bic = k * Math.log(n) - 2 * logLik;
  return {
    name,
    params,
    rawParams: x,
    logLik,
    k,
    aic,
    bic,
    iter,
    converged,
    condVar: condVarFromParams(params),
  };
}

export function fitGarch(eps) {
  const initVar = sampleVariance(eps);
  const condVarFromParams = ({ omega, alpha, beta }) =>
    garchCondVar(eps, omega, alpha, beta, initVar);
  const objective = (x) => {
    const { omega, alpha, beta } = unpackGarch(x);
    if (alpha + beta >= 0.999) {
      return 1e6 + 1e4 * (alpha + beta);
    }
    const h = garchCondVar(eps, omega, alpha, beta, initVar);
    return gaussianNegLogLik(eps, h);
  };
  // Start: ω s.t. unconditional var ≈ sample var with p=0.98, s=0.05.
  // Unconditional var = ω/(1−α−β). Sample var ~ 1e-4 for daily SPX returns,
  // so ω ~ 2e-6. Work in log-space: log(ω) ~ -13. p=0.98 → x₁ = logit(0.98) ≈ 3.89.
  // s=0.05 → x₂ = logit(0.05) ≈ -2.94.
  const startRaw = [Math.log(Math.max(initVar * 0.02, 1e-8)), 3.89, -2.94];
  return fitOne({
    name: 'GARCH(1,1)',
    kParams: 3,
    objective,
    unpack: unpackGarch,
    startRaw,
    condVarFromParams,
  });
}

export function fitGjr(eps) {
  const initVar = sampleVariance(eps);
  const condVarFromParams = ({ omega, alpha, gamma, beta }) =>
    gjrCondVar(eps, omega, alpha, gamma, beta, initVar);
  const objective = (x) => {
    const { omega, alpha, gamma, beta } = unpackGjr(x);
    const persistence = alpha + gamma / 2 + beta;
    if (persistence >= 0.999) {
      return 1e6 + 1e4 * persistence;
    }
    const h = gjrCondVar(eps, omega, alpha, gamma, beta, initVar);
    return gaussianNegLogLik(eps, h);
  };
  // Start: ω small, α=0.03, γ=0.10, β=0.88 — a textbook SPX GJR fit.
  // logit(0.03)≈-3.48, logit(0.10)≈-2.20, logit(0.88)≈1.99.
  const startRaw = [Math.log(Math.max(initVar * 0.02, 1e-8)), -3.48, -2.20, 1.99];
  return fitOne({
    name: 'GJR-GARCH',
    kParams: 4,
    objective,
    unpack: unpackGjr,
    startRaw,
    condVarFromParams,
  });
}

export function fitEgarch(eps) {
  const initVar = sampleVariance(eps);
  const condVarFromParams = ({ omega, alpha, gamma, beta }) =>
    egarchCondVar(eps, omega, alpha, gamma, beta, initVar);
  const objective = (x) => {
    const { omega, alpha, gamma, beta } = unpackEgarch(x);
    const h = egarchCondVar(eps, omega, alpha, gamma, beta, initVar);
    return gaussianNegLogLik(eps, h);
  };
  // Start: β≈0.97, α≈0.10, γ≈-0.08, ω≈(1−β)·log(initVar). atanh(0.97)≈2.09.
  const logInit = Math.log(Math.max(initVar, 1e-10));
  const startRaw = [logInit * 0.03, 0.10, -0.08, 2.09];
  return fitOne({
    name: 'EGARCH(1,1)',
    kParams: 4,
    objective,
    unpack: unpackEgarch,
    startRaw,
    condVarFromParams,
  });
}

// -- forecasts ----------------------------------------------------------------

// h-step ahead variance forecast for each of the three models from the
// current state. Returns an array of length `horizon`, indexed 1..horizon.

export function forecastGarch(model, lastEps, lastVar, horizon) {
  const { omega, alpha, beta } = model.params;
  const persistence = alpha + beta;
  const unconditional = omega / (1 - persistence);
  const out = new Array(horizon);
  let prevVar = omega + alpha * lastEps * lastEps + beta * lastVar;
  out[0] = prevVar;
  for (let h = 1; h < horizon; h++) {
    out[h] = omega + persistence * prevVar;
    prevVar = out[h];
  }
  // Equivalent closed form for h≥2: unconditional + persistence^(h-1) * (out[0] - unconditional)
  return { path: out, unconditional };
}

export function forecastGjr(model, lastEps, lastVar, horizon) {
  const { omega, alpha, gamma, beta } = model.params;
  // Symmetric-innovation stationary persistence
  const persistence = alpha + gamma / 2 + beta;
  const unconditional = omega / (1 - persistence);
  const out = new Array(horizon);
  // One-step forecast uses the realized sign of lastEps
  const I = lastEps < 0 ? 1 : 0;
  let prevVar = omega + alpha * lastEps * lastEps + gamma * I * lastEps * lastEps + beta * lastVar;
  out[0] = prevVar;
  for (let h = 1; h < horizon; h++) {
    // For h≥2 the sign is unknown; take expectation under zero-mean Gaussian:
    //   E[ε²|info] = prevVar; E[I·ε²|info] = (1/2)·prevVar
    out[h] = omega + (alpha + gamma / 2) * prevVar + beta * prevVar;
    prevVar = out[h];
  }
  return { path: out, unconditional };
}

export function forecastEgarch(model, lastEps, lastVar, horizon) {
  const { omega, alpha, gamma, beta } = model.params;
  // EGARCH's multi-step expected log-variance has no tidy closed form
  // because E[exp(·)] ≠ exp(E[·]); the clean move is a short Monte-Carlo
  // average over the log-variance recursion with standard-normal draws.
  // Small N is fine — the aggregate ensemble rarely leans heavily on
  // EGARCH's tail behavior for a 21-day forecast.
  const N_SIMS = 400;
  const sumPath = new Array(horizon).fill(0);
  let seed = 0x9e3779b9;
  const rand = () => {
    // Marsaglia-polar Gaussian, deterministic seed for reproducible UI.
    let u, v, s;
    do {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      u = (seed / 0x100000000) * 2 - 1;
      seed = (seed * 1664525 + 1013904223) >>> 0;
      v = (seed / 0x100000000) * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    return u * Math.sqrt((-2 * Math.log(s)) / s);
  };

  for (let sim = 0; sim < N_SIMS; sim++) {
    const sigmaLast = Math.sqrt(Math.max(lastVar, 1e-20));
    const zLast = lastEps / sigmaLast;
    let logH = omega + alpha * (Math.abs(zLast) - SQRT_2_OVER_PI) + gamma * zLast + beta * Math.log(Math.max(lastVar, 1e-20));
    if (logH > 25) logH = 25;
    else if (logH < -25) logH = -25;
    sumPath[0] += Math.exp(logH);
    for (let h = 1; h < horizon; h++) {
      const z = rand();
      logH = omega + alpha * (Math.abs(z) - SQRT_2_OVER_PI) + gamma * z + beta * logH;
      if (logH > 25) logH = 25;
      else if (logH < -25) logH = -25;
      sumPath[h] += Math.exp(logH);
    }
  }
  const out = sumPath.map((s) => s / N_SIMS);
  // Unconditional log-variance under Gaussian innovations:
  //   E[log σ²] = ω/(1−β); Var[log σ²] = (α² + γ²)/(1−β²) (approx),
  // so E[σ²] = exp(E + V/2).
  const elog = omega / (1 - beta);
  const vlog = (alpha * alpha + gamma * gamma) / Math.max(1 - beta * beta, 1e-6);
  const unconditional = Math.exp(elog + vlog / 2);
  return { path: out, unconditional };
}

// -- ensemble ----------------------------------------------------------------

// BIC weights: w_i ∝ exp(-½ · ΔBIC_i). Normalized to sum to 1.
export function bicWeights(models) {
  const minBic = Math.min(...models.map((m) => m.bic));
  const raw = models.map((m) => Math.exp(-0.5 * (m.bic - minBic)));
  const z = raw.reduce((a, b) => a + b, 0);
  return raw.map((r) => r / z);
}

// Blend per-model forecast paths using ensemble weights. The conditional
// variance is the natural quantity to average (it's what the likelihood
// is defined against); converting to σ happens in the UI layer.
export function blendPaths(paths, weights) {
  const h = paths[0].length;
  const out = new Array(h).fill(0);
  for (let t = 0; t < h; t++) {
    for (let m = 0; m < paths.length; m++) {
      out[t] += weights[m] * paths[m][t];
    }
  }
  return out;
}

// -- convenience wrappers -----------------------------------------------------

export function annualize(variance) {
  return Math.sqrt(variance * TRADING_DAYS_YEAR);
}

// Average the first `h` daily variance forecasts and annualize to
// σ-over-h-days (expressed in annualized terms). This is the convention
// an option trader reads: "if I bought a straddle at σ and σ_realized
// matched this number, I'd break even over the next h days."
export function horizonSigma(path, h) {
  const use = Math.min(h, path.length);
  let s = 0;
  for (let t = 0; t < use; t++) s += path[t];
  return annualize(s / use);
}

export function fitEnsemble(returns) {
  const { series: eps, mean: rMean } = demean(returns);
  const t0 = performance.now();
  const garch = fitGarch(eps);
  const gjr = fitGjr(eps);
  const egarch = fitEgarch(eps);
  const elapsedMs = performance.now() - t0;

  const models = [garch, gjr, egarch];
  const weights = bicWeights(models);

  // Ensemble in-sample conditional variance
  const n = eps.length;
  const ensembleCondVar = new Array(n);
  for (let t = 0; t < n; t++) {
    let v = 0;
    for (let m = 0; m < models.length; m++) v += weights[m] * models[m].condVar[t];
    ensembleCondVar[t] = v;
  }

  return {
    models,
    weights,
    ensembleCondVar,
    eps,
    returnMean: rMean,
    elapsedMs,
  };
}

// Given a fitted ensemble and the last observed epsilon and in-sample
// variance state for each model, return per-model paths, the ensemble
// path, and horizon-averaged annualized σ at the stamp horizons.
export function forecastEnsemble(ensemble, horizon) {
  const { models, weights, eps, ensembleCondVar } = ensemble;
  const lastEps = eps[eps.length - 1];
  const lastIndex = ensembleCondVar.length - 1;

  const paths = [
    forecastGarch(models[0], lastEps, models[0].condVar[lastIndex], horizon),
    forecastGjr(models[1], lastEps, models[1].condVar[lastIndex], horizon),
    forecastEgarch(models[2], lastEps, models[2].condVar[lastIndex], horizon),
  ];
  const blendedPath = blendPaths(paths.map((p) => p.path), weights);
  const blendedUnconditional =
    weights[0] * paths[0].unconditional +
    weights[1] * paths[1].unconditional +
    weights[2] * paths[2].unconditional;

  return {
    perModel: paths.map((p, i) => ({ name: models[i].name, ...p })),
    ensemble: { path: blendedPath, unconditional: blendedUnconditional },
    sigma1d: annualize(blendedPath[0]),
    sigma10d: horizonSigma(blendedPath, 10),
    sigma21d: horizonSigma(blendedPath, 21),
    sigmaUnconditional: annualize(blendedUnconditional),
  };
}
