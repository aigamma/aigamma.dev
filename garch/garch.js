// -----------------------------------------------------------------------------
// GARCH family library — pure-JS, in-browser MLE for a broad set of
// GARCH-family specifications. Fit on daily SPX log returns reconstructed
// from /api/gex-history; optimizer is derivative-free Nelder-Mead in
// unconstrained parameter space with reparameterizations chosen per model
// to keep the fit inside the stationary / positive-variance region.
//
// This file is the model zoo for /garch/. See /dev/garch.js for the earlier
// three-model (GARCH, GJR, EGARCH) prototype; that file predates this one
// and is kept in place so the /dev/ page continues to work unchanged.
//
// COVERAGE (21 specifications — Stage 1 + Stage 2, full user list)
//   Tier-1 univariate quadratic/power/absolute:
//     - GARCH(1,1)       [Bollerslev 1986]
//     - IGARCH(1,1)      [Engle-Bollerslev 1986]  α+β=1
//     - EGARCH(1,1)      [Nelson 1991]
//     - GJR-GARCH(1,1,1) [Glosten-Jagannathan-Runkle 1993]
//     - TGARCH           [Zakoian 1994]
//     - APARCH           [Ding-Granger-Engle 1993]
//     - NAGARCH          [Engle-Ng 1993]
//     - NGARCH           [Higgins-Bera 1992]
//     - AVGARCH          [Taylor 1986; Schwert 1989]
//   Component / in-mean / score-driven:
//     - CGARCH           [Lee-Engle 1999]
//     - GARCH-M          [Engle-Lilien-Robins 1987]
//     - GAS              [Creal-Koopman-Lucas 2013]
//   Long memory:
//     - FIGARCH(1,d,1)   [Baillie-Bollerslev-Mikkelsen 1996]
//     - HYGARCH          [Davidson 2004]
//   Regime-switching:
//     - MS-GARCH         [Gray 1996, 2-regime path-integrated]
//   Realized-measure augmented (uses 5-day SSR proxy; no intraday RV):
//     - Realized GARCH   [Hansen-Huang-Shek 2012]
//     - HEAVY            [Shephard-Sheppard 2010]
//   Multivariate (paired with a second series via fitAll(r, {secondSeries})):
//     - CCC-GARCH        [Bollerslev 1990]
//     - DCC-GARCH        [Engle 2002]
//     - BEKK(1,1)        [Engle-Kroner 1995, diagonal variant]
//     - OGARCH           [Alexander 2001]
//
// ENSEMBLE
//   Equal-weight master ensemble across every model with condVar != null.
//   Multivariate models contribute their SPX-marginal H_t[0,0] to the ensemble
//   so the scalar σ path stays interpretable; each multivariate model also
//   exposes __correlation for a separate ρ_{12}(t) rendering in the UI.
//
// INNOVATIONS AND LIMITATIONS
//   - Gaussian only; no Student-t or GED yet.
//   - RV proxy for Realized GARCH / HEAVY is the 5-day sum of squared daily
//     returns (no intraday data at the data source). A proper RV would
//     strictly dominate, but the 5-day SSR captures the same short-horizon
//     smoothing that intraday RV provides and is internally consistent.
//   - Multivariate likelihoods are bivariate (the zoo pairs SPX returns with
//     a second series the UI supplies, typically a differenced positioning
//     proxy). Extending to n > 2 would change the shape of the ensemble.
// -----------------------------------------------------------------------------

const TRADING_DAYS_YEAR = 252;
const SQRT_2_OVER_PI = Math.sqrt(2 / Math.PI);
const LOG_2PI = Math.log(2 * Math.PI);
const LOG_VAR_CAP = 25;

// --- numerical helpers ------------------------------------------------------

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

export function demean(returns) {
  const m = mean(returns);
  const out = new Array(returns.length);
  for (let i = 0; i < returns.length; i++) out[i] = returns[i] - m;
  return { series: out, mean: m };
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

// --- Nelder-Mead -----------------------------------------------------------

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

    const centroid = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) centroid[j] += simplex[i][j];
    }
    for (let j = 0; j < n; j++) centroid[j] /= n;

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

// --- conditional-variance recursions ---------------------------------------

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

// IGARCH(1,1): integrated GARCH imposes α+β=1, so the unconditional
// variance is undefined (infinite persistence). The conditional-variance
// recursion itself is still well-defined: h_t = ω + α·ε²_{t-1} + (1-α)·h_{t-1}.
// Here ω is retained as a positive constant that acts as a "drift" in
// variance; some references drop ω entirely (ω=0, pure RiskMetrics-style
// EWMA), but a free ω usually fits SPX a little better.
function igarchCondVar(eps, omega, alpha, init) {
  const beta = 1 - alpha;
  return garchCondVar(eps, omega, alpha, beta, init);
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
    if (logH[t] > LOG_VAR_CAP) logH[t] = LOG_VAR_CAP;
    else if (logH[t] < -LOG_VAR_CAP) logH[t] = -LOG_VAR_CAP;
    h[t] = Math.exp(logH[t]);
  }
  return h;
}

// TGARCH (Zakoian 1994): σ recursion (not σ²), with split effects for
// positive and negative shocks. Classic form:
//   σ_t = ω + α⁺ · ε⁺_{t-1} + α⁻ · |ε⁻_{t-1}| + β · σ_{t-1}
// where ε⁺ = max(ε, 0) and ε⁻ = min(ε, 0). Returns conditional variance
// (σ²) for compatibility with the rest of the pipeline.
function tgarchCondVar(eps, omega, alphaPos, alphaNeg, beta, initSigma) {
  const n = eps.length;
  const sigma = new Array(n);
  sigma[0] = initSigma;
  for (let t = 1; t < n; t++) {
    const e = eps[t - 1];
    const ePos = e > 0 ? e : 0;
    const eNegAbs = e < 0 ? -e : 0;
    sigma[t] = omega + alphaPos * ePos + alphaNeg * eNegAbs + beta * sigma[t - 1];
    if (!(sigma[t] > 0)) sigma[t] = 1e-12;
  }
  const h = new Array(n);
  for (let t = 0; t < n; t++) h[t] = sigma[t] * sigma[t];
  return h;
}

// APARCH (Ding-Granger-Engle 1993): σ^δ recursion with asymmetric leverage γ:
//   σ^δ_t = ω + α · (|ε_{t-1}| − γ · ε_{t-1})^δ + β · σ^δ_{t-1}
// δ > 0 is the power exponent (δ = 2 reduces to a GARCH-like model; δ = 1
// reduces to an absolute-value variant; δ = 1.5 is a common empirical
// fit on equity returns). γ ∈ (−1, 1) controls asymmetry: γ > 0 means
// negative ε gets amplified (the leverage direction for equities).
function aparchCondVar(eps, omega, alpha, gamma, beta, delta, initSigma) {
  const n = eps.length;
  const sdelta = new Array(n);
  sdelta[0] = Math.pow(initSigma, delta);
  for (let t = 1; t < n; t++) {
    const e = eps[t - 1];
    const shock = Math.abs(e) - gamma * e;
    const shockPow = shock > 0 ? Math.pow(shock, delta) : 0;
    sdelta[t] = omega + alpha * shockPow + beta * sdelta[t - 1];
    if (!(sdelta[t] > 0)) sdelta[t] = 1e-20;
  }
  const h = new Array(n);
  const invDelta = 1 / delta;
  for (let t = 0; t < n; t++) {
    const sigma = Math.pow(sdelta[t], invDelta);
    h[t] = sigma * sigma;
  }
  return h;
}

// NAGARCH (Engle-Ng 1993): displacement-term asymmetric GARCH:
//   σ²_t = ω + α · (ε_{t-1} − θ · σ_{t-1})² + β · σ²_{t-1}
// θ > 0 shifts the news-response curve to the left, so a negative ε
// produces a larger effect on next variance than a positive one of the
// same magnitude. This is one of the cleanest asymmetric specifications:
// the leverage parameter θ has a direct interpretation as the location
// shift of the news-impact curve's minimum.
function nagarchCondVar(eps, omega, alpha, theta, beta, initVar) {
  const n = eps.length;
  const h = new Array(n);
  h[0] = initVar;
  for (let t = 1; t < n; t++) {
    const sigmaPrev = Math.sqrt(h[t - 1]);
    const shifted = eps[t - 1] - theta * sigmaPrev;
    h[t] = omega + alpha * shifted * shifted + beta * h[t - 1];
    if (!(h[t] > 0)) h[t] = 1e-20;
  }
  return h;
}

// NGARCH (Higgins-Bera 1992): nonlinear |ε|^δ on σ^δ:
//   σ^δ_t = ω + α · |ε_{t-1}|^δ + β · σ^δ_{t-1}
// Symmetric variant of the Ding-Granger-Engle power family. δ is free.
function ngarchCondVar(eps, omega, alpha, beta, delta, initSigma) {
  const n = eps.length;
  const sdelta = new Array(n);
  sdelta[0] = Math.pow(initSigma, delta);
  for (let t = 1; t < n; t++) {
    const shockPow = Math.pow(Math.abs(eps[t - 1]), delta);
    sdelta[t] = omega + alpha * shockPow + beta * sdelta[t - 1];
    if (!(sdelta[t] > 0)) sdelta[t] = 1e-20;
  }
  const h = new Array(n);
  const invDelta = 1 / delta;
  for (let t = 0; t < n; t++) {
    const sigma = Math.pow(sdelta[t], invDelta);
    h[t] = sigma * sigma;
  }
  return h;
}

// AVGARCH (Taylor 1986; Schwert 1989): σ recursion on |ε|:
//   σ_t = ω + α · |ε_{t-1}| + β · σ_{t-1}
// Symmetric, absolute-value counterpart to TGARCH. Often fits financial
// returns noticeably better than squared-return GARCH because squared
// returns give excessive weight to outliers.
function avgarchCondVar(eps, omega, alpha, beta, initSigma) {
  const n = eps.length;
  const sigma = new Array(n);
  sigma[0] = initSigma;
  for (let t = 1; t < n; t++) {
    sigma[t] = omega + alpha * Math.abs(eps[t - 1]) + beta * sigma[t - 1];
    if (!(sigma[t] > 0)) sigma[t] = 1e-12;
  }
  const h = new Array(n);
  for (let t = 0; t < n; t++) h[t] = sigma[t] * sigma[t];
  return h;
}

// --- parameter transforms (unconstrained → constrained) --------------------

function unpackGarch(x) {
  const omega = Math.exp(x[0]);
  const p = sigmoid(x[1]);
  const s = sigmoid(x[2]);
  return { omega, alpha: p * s, beta: p * (1 - s) };
}

function unpackIgarch(x) {
  return {
    omega: Math.exp(x[0]),
    alpha: sigmoid(x[1]),
  };
}

function unpackGjr(x) {
  return {
    omega: Math.exp(x[0]),
    alpha: sigmoid(x[1]),
    gamma: sigmoid(x[2]),
    beta: sigmoid(x[3]),
  };
}

function unpackEgarch(x) {
  return {
    omega: x[0],
    alpha: x[1],
    gamma: x[2],
    beta: Math.tanh(x[3]),
  };
}

// TGARCH on σ; α⁺, α⁻ ≥ 0, β ∈ [0,1). Stationarity requires
// α⁺·E[ε⁺] + α⁻·E[|ε⁻|] + β < 1, which under standard-normal innovations
// reduces to (α⁺ + α⁻)·√(2/π) + β < 1 (with E[|z|] = √(2/π) for z ~ N(0,1)).
function unpackTgarch(x) {
  return {
    omega: Math.exp(x[0]) * 1e-3,  // keep ω small; σ is in return-scale units
    alphaPos: sigmoid(x[1]) * 0.5,
    alphaNeg: sigmoid(x[2]) * 0.5,
    beta: sigmoid(x[3]),
  };
}

// APARCH: ω>0, α∈[0,1), γ∈(-1,1), β∈[0,1), δ>0 (commonly 0.5 < δ < 3).
function unpackAparch(x) {
  return {
    omega: Math.exp(x[0]),
    alpha: sigmoid(x[1]),
    gamma: Math.tanh(x[2]),
    beta: sigmoid(x[3]),
    delta: 0.5 + 2.5 * sigmoid(x[4]),  // maps ℝ to (0.5, 3.0)
  };
}

// NAGARCH: ω>0, α>0, θ (unconstrained real ~ typical range [0, 1.5] on equities), β∈[0,1).
function unpackNagarch(x) {
  return {
    omega: Math.exp(x[0]),
    alpha: sigmoid(x[1]) * 0.3,
    theta: x[2],
    beta: sigmoid(x[3]),
  };
}

function unpackNgarch(x) {
  return {
    omega: Math.exp(x[0]),
    alpha: sigmoid(x[1]),
    beta: sigmoid(x[2]),
    delta: 0.5 + 2.5 * sigmoid(x[3]),
  };
}

function unpackAvgarch(x) {
  return {
    omega: Math.exp(x[0]) * 1e-3,
    alpha: sigmoid(x[1]) * 0.5,
    beta: sigmoid(x[2]),
  };
}

// --- fit scaffold ---------------------------------------------------------

function fitOne({ name, family, kParams, objective, unpack, startRaw, condVarFromParams, extra }) {
  const t0 = performance.now();
  const { x, fx, converged, iter } = nelderMead(objective, startRaw);
  const elapsedMs = performance.now() - t0;
  const params = unpack(x);
  const condVar = condVarFromParams(params);
  const n = condVar.length;
  const logLik = -fx;
  const k = kParams;
  const aic = 2 * k - 2 * logLik;
  const bic = k * Math.log(n) - 2 * logLik;
  return {
    name,
    family,
    params,
    rawParams: x,
    logLik,
    k,
    aic,
    bic,
    iter,
    converged,
    elapsedMs,
    condVar,
    ...(extra || {}),
  };
}

// --- per-model fitters ----------------------------------------------------

export function fitGarch(eps) {
  const initVar = sampleVariance(eps);
  const condVarFromParams = ({ omega, alpha, beta }) =>
    garchCondVar(eps, omega, alpha, beta, initVar);
  const objective = (x) => {
    const { omega, alpha, beta } = unpackGarch(x);
    if (alpha + beta >= 0.9995) return 1e6 + 1e4 * (alpha + beta);
    const h = garchCondVar(eps, omega, alpha, beta, initVar);
    return gaussianNegLogLik(eps, h);
  };
  const startRaw = [Math.log(Math.max(initVar * 0.02, 1e-8)), 3.89, -2.94];
  return fitOne({
    name: 'GARCH(1,1)',
    family: 'symmetric',
    kParams: 3,
    objective,
    unpack: unpackGarch,
    startRaw,
    condVarFromParams,
  });
}

export function fitIgarch(eps) {
  const initVar = sampleVariance(eps);
  const condVarFromParams = ({ omega, alpha }) =>
    igarchCondVar(eps, omega, alpha, initVar);
  const objective = (x) => {
    const { omega, alpha } = unpackIgarch(x);
    const h = igarchCondVar(eps, omega, alpha, initVar);
    return gaussianNegLogLik(eps, h);
  };
  // Start with α=0.06, a typical RiskMetrics-like EWMA decay rate.
  // logit(0.06) ≈ -2.75. ω near zero in log space.
  const startRaw = [Math.log(Math.max(initVar * 0.001, 1e-10)), -2.75];
  return fitOne({
    name: 'IGARCH(1,1)',
    family: 'symmetric',
    kParams: 2,
    objective,
    unpack: unpackIgarch,
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
    if (alpha + gamma / 2 + beta >= 0.9995) return 1e6 + 1e4 * (alpha + gamma / 2 + beta);
    const h = gjrCondVar(eps, omega, alpha, gamma, beta, initVar);
    return gaussianNegLogLik(eps, h);
  };
  const startRaw = [Math.log(Math.max(initVar * 0.02, 1e-8)), -3.48, -2.20, 1.99];
  return fitOne({
    name: 'GJR-GARCH',
    family: 'asymmetric',
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
    const params = unpackEgarch(x);
    const h = egarchCondVar(eps, params.omega, params.alpha, params.gamma, params.beta, initVar);
    return gaussianNegLogLik(eps, h);
  };
  const logInit = Math.log(Math.max(initVar, 1e-10));
  const startRaw = [logInit * 0.03, 0.10, -0.08, 2.09];
  return fitOne({
    name: 'EGARCH(1,1)',
    family: 'asymmetric',
    kParams: 4,
    objective,
    unpack: unpackEgarch,
    startRaw,
    condVarFromParams,
  });
}

export function fitTgarch(eps) {
  const initSigma = Math.sqrt(sampleVariance(eps));
  const condVarFromParams = ({ omega, alphaPos, alphaNeg, beta }) =>
    tgarchCondVar(eps, omega, alphaPos, alphaNeg, beta, initSigma);
  const objective = (x) => {
    const { omega, alphaPos, alphaNeg, beta } = unpackTgarch(x);
    // Symmetric-Gaussian stationarity: (α⁺ + α⁻)·√(2/π) + β < 1
    if ((alphaPos + alphaNeg) * SQRT_2_OVER_PI + beta >= 0.9995) return 1e8;
    const h = tgarchCondVar(eps, omega, alphaPos, alphaNeg, beta, initSigma);
    return gaussianNegLogLik(eps, h);
  };
  // Start ω tiny, α⁺≈0.03, α⁻≈0.10 (leverage — negative news moves σ more),
  // β≈0.90. logit(0.06)=-2.75, logit(0.20)=-1.39, logit(0.90)=2.20.
  const startRaw = [0, -2.75, -1.39, 2.20];
  return fitOne({
    name: 'TGARCH',
    family: 'asymmetric',
    kParams: 4,
    objective,
    unpack: unpackTgarch,
    startRaw,
    condVarFromParams,
  });
}

export function fitAparch(eps) {
  const initSigma = Math.sqrt(sampleVariance(eps));
  const condVarFromParams = ({ omega, alpha, gamma, beta, delta }) =>
    aparchCondVar(eps, omega, alpha, gamma, beta, delta, initSigma);
  const objective = (x) => {
    const { omega, alpha, gamma, beta, delta } = unpackAparch(x);
    if (alpha + beta >= 0.9995) return 1e8;
    const h = aparchCondVar(eps, omega, alpha, gamma, beta, delta, initSigma);
    return gaussianNegLogLik(eps, h);
  };
  // Start ω small, α=0.07, γ=0.3 (leverage toward negatives), β=0.88, δ=1.5.
  // logit(0.07)=-2.59, atanh(0.3)=0.31, logit(0.88)=1.99, sigmoid^-1((1.5-0.5)/2.5)=logit(0.4)=-0.405.
  const startRaw = [Math.log(Math.max(initSigma * 0.02, 1e-8)), -2.59, 0.31, 1.99, -0.405];
  return fitOne({
    name: 'APARCH',
    family: 'power',
    kParams: 5,
    objective,
    unpack: unpackAparch,
    startRaw,
    condVarFromParams,
  });
}

export function fitNagarch(eps) {
  const initVar = sampleVariance(eps);
  const condVarFromParams = ({ omega, alpha, theta, beta }) =>
    nagarchCondVar(eps, omega, alpha, theta, beta, initVar);
  const objective = (x) => {
    const { omega, alpha, theta, beta } = unpackNagarch(x);
    // Symmetric-innovation stationarity: α·(1 + θ²) + β < 1
    if (alpha * (1 + theta * theta) + beta >= 0.9995) return 1e8;
    const h = nagarchCondVar(eps, omega, alpha, theta, beta, initVar);
    return gaussianNegLogLik(eps, h);
  };
  // α·0.3 cap; α start ≈ 0.08 → sigmoid^-1(0.08/0.3) = sigmoid^-1(0.267) ≈ -1.01.
  const startRaw = [Math.log(Math.max(initVar * 0.02, 1e-8)), -1.01, 0.5, 1.99];
  return fitOne({
    name: 'NAGARCH',
    family: 'asymmetric',
    kParams: 4,
    objective,
    unpack: unpackNagarch,
    startRaw,
    condVarFromParams,
  });
}

export function fitNgarch(eps) {
  const initSigma = Math.sqrt(sampleVariance(eps));
  const condVarFromParams = ({ omega, alpha, beta, delta }) =>
    ngarchCondVar(eps, omega, alpha, beta, delta, initSigma);
  const objective = (x) => {
    const { omega, alpha, beta, delta } = unpackNgarch(x);
    if (alpha + beta >= 0.9995) return 1e8;
    const h = ngarchCondVar(eps, omega, alpha, beta, delta, initSigma);
    return gaussianNegLogLik(eps, h);
  };
  const startRaw = [Math.log(Math.max(initSigma * 0.02, 1e-8)), -2.59, 1.99, -0.405];
  return fitOne({
    name: 'NGARCH',
    family: 'power',
    kParams: 4,
    objective,
    unpack: unpackNgarch,
    startRaw,
    condVarFromParams,
  });
}

export function fitAvgarch(eps) {
  const initSigma = Math.sqrt(sampleVariance(eps));
  const condVarFromParams = ({ omega, alpha, beta }) =>
    avgarchCondVar(eps, omega, alpha, beta, initSigma);
  const objective = (x) => {
    const { omega, alpha, beta } = unpackAvgarch(x);
    if (alpha * SQRT_2_OVER_PI + beta >= 0.9995) return 1e8;
    const h = avgarchCondVar(eps, omega, alpha, beta, initSigma);
    return gaussianNegLogLik(eps, h);
  };
  const startRaw = [0, -1.39, 2.20];
  return fitOne({
    name: 'AVGARCH',
    family: 'absolute',
    kParams: 3,
    objective,
    unpack: unpackAvgarch,
    startRaw,
    condVarFromParams,
  });
}

// --- forecast recursions --------------------------------------------------

// h-step forecast as a flat array of length `horizon` of conditional
// variance values (variance, not σ). Each model's forecast follows its
// own recursion under the zero-mean symmetric-Gaussian expectation for
// h ≥ 2.

export function forecastGarch(model, lastEps, lastVar, horizon) {
  const { omega, alpha, beta } = model.params;
  const persistence = alpha + beta;
  const uncond = omega / Math.max(1 - persistence, 1e-6);
  const path = new Array(horizon);
  let prev = omega + alpha * lastEps * lastEps + beta * lastVar;
  path[0] = prev;
  for (let h = 1; h < horizon; h++) {
    path[h] = omega + persistence * prev;
    prev = path[h];
  }
  return { path, unconditional: uncond };
}

export function forecastIgarch(model, lastEps, lastVar, horizon) {
  const { omega, alpha } = model.params;
  const beta = 1 - alpha;
  const path = new Array(horizon);
  let prev = omega + alpha * lastEps * lastEps + beta * lastVar;
  path[0] = prev;
  for (let h = 1; h < horizon; h++) {
    // Under α + β = 1 the forecast grows linearly in h: E[σ²_{t+h}] = h·ω + σ²_{t+1}.
    path[h] = prev + omega;
    prev = path[h];
  }
  return { path, unconditional: null };
}

export function forecastGjr(model, lastEps, lastVar, horizon) {
  const { omega, alpha, gamma, beta } = model.params;
  const persistence = alpha + gamma / 2 + beta;
  const uncond = omega / Math.max(1 - persistence, 1e-6);
  const path = new Array(horizon);
  const I = lastEps < 0 ? 1 : 0;
  let prev = omega + alpha * lastEps * lastEps + gamma * I * lastEps * lastEps + beta * lastVar;
  path[0] = prev;
  for (let h = 1; h < horizon; h++) {
    path[h] = omega + (alpha + gamma / 2) * prev + beta * prev;
    prev = path[h];
  }
  return { path, unconditional: uncond };
}

// EGARCH multi-step: no tidy closed form because E[exp(·)] ≠ exp(E[·]).
// Short Monte-Carlo average, deterministic seeded RNG so the UI is
// reproducible across reloads.
export function forecastEgarch(model, lastEps, lastVar, horizon) {
  const { omega, alpha, gamma, beta } = model.params;
  const N = 400;
  const sumPath = new Array(horizon).fill(0);
  let seed = 0x9e3779b9;
  const rand = () => {
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

  for (let sim = 0; sim < N; sim++) {
    const sigmaLast = Math.sqrt(Math.max(lastVar, 1e-20));
    const zLast = lastEps / sigmaLast;
    let logH = omega + alpha * (Math.abs(zLast) - SQRT_2_OVER_PI) + gamma * zLast + beta * Math.log(Math.max(lastVar, 1e-20));
    if (logH > LOG_VAR_CAP) logH = LOG_VAR_CAP;
    else if (logH < -LOG_VAR_CAP) logH = -LOG_VAR_CAP;
    sumPath[0] += Math.exp(logH);
    for (let h = 1; h < horizon; h++) {
      const z = rand();
      logH = omega + alpha * (Math.abs(z) - SQRT_2_OVER_PI) + gamma * z + beta * logH;
      if (logH > LOG_VAR_CAP) logH = LOG_VAR_CAP;
      else if (logH < -LOG_VAR_CAP) logH = -LOG_VAR_CAP;
      sumPath[h] += Math.exp(logH);
    }
  }
  const path = sumPath.map((s) => s / N);
  const elog = omega / Math.max(1 - beta, 1e-6);
  const vlog = (alpha * alpha + gamma * gamma) / Math.max(1 - beta * beta, 1e-6);
  const uncond = Math.exp(elog + vlog / 2);
  return { path, unconditional: uncond };
}

// Closed-form-ish forecast for σ-recursion and σ^δ-recursion families:
// under symmetric zero-mean innovations, E[|ε|] = σ·√(2/π), and the
// σ-recursion reverts to an unconditional σ given by the fixed point of
// σ = ω + (α·√(2/π) + β)·σ; similarly for σ² under the power transform.
// Rather than hand-write each family's closed form, simulate the
// recursion with the innovation replaced by its unconditional expectation.
export function forecastTgarch(model, lastEps, lastVar, horizon) {
  const { omega, alphaPos, alphaNeg, beta } = model.params;
  const sigmaLast = Math.sqrt(Math.max(lastVar, 1e-20));
  // One-step-ahead uses realized ε
  let sigma =
    omega +
    alphaPos * Math.max(lastEps, 0) +
    alphaNeg * Math.max(-lastEps, 0) +
    beta * sigmaLast;
  const path = new Array(horizon);
  path[0] = sigma * sigma;
  // For h ≥ 2 under symmetric Gaussian: E[ε⁺] = E[|ε⁻|] = σ·√(2/π)/·(... actually
  // E[max(ε,0)] = σ·√(1/(2π)) under z~N(0,1), so E[|ε⁻|] = σ·√(1/(2π)) too.
  // The multi-step recursion becomes: σ_{h+1} = ω + (α⁺+α⁻)·σ_h·√(1/(2π)) + β·σ_h
  const halfSqrt = Math.sqrt(1 / (2 * Math.PI));
  for (let h = 1; h < horizon; h++) {
    const combined = (alphaPos + alphaNeg) * halfSqrt + beta;
    sigma = omega + combined * sigma;
    path[h] = sigma * sigma;
  }
  const sigmaUncond = omega / Math.max(1 - ((alphaPos + alphaNeg) * halfSqrt + beta), 1e-6);
  return { path, unconditional: sigmaUncond * sigmaUncond };
}

export function forecastAparch(model, lastEps, lastVar, horizon) {
  const { omega, alpha, gamma, beta, delta } = model.params;
  const sigmaLast = Math.sqrt(Math.max(lastVar, 1e-20));
  let sdelta = Math.pow(sigmaLast, delta);
  // One-step-ahead uses realized shock
  const shock0 = Math.abs(lastEps) - gamma * lastEps;
  sdelta = omega + alpha * (shock0 > 0 ? Math.pow(shock0, delta) : 0) + beta * sdelta;
  const path = new Array(horizon);
  const invDelta = 1 / delta;
  let sigma = Math.pow(sdelta, invDelta);
  path[0] = sigma * sigma;
  // For h ≥ 2 use the symmetric-Gaussian expectation
  //   κ = E[(|z| − γz)^δ] where z ~ N(0,1)
  // approximate by Monte-Carlo once (small N):
  let kappa;
  {
    const N = 2000;
    let acc = 0;
    let seed = 0x5a827999;
    for (let i = 0; i < N; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const u = (seed / 0x100000000) * 2 - 1;
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const v = (seed / 0x100000000) * 2 - 1;
      const s = u * u + v * v;
      if (s >= 1 || s === 0) { i--; continue; }
      const z = u * Math.sqrt(-2 * Math.log(s) / s);
      const shock = Math.abs(z) - gamma * z;
      acc += shock > 0 ? Math.pow(shock, delta) : 0;
    }
    kappa = acc / N;
  }
  for (let h = 1; h < horizon; h++) {
    sdelta = omega + (alpha * kappa + beta) * sdelta;
    sigma = Math.pow(sdelta, invDelta);
    path[h] = sigma * sigma;
  }
  const denom = Math.max(1 - (alpha * kappa + beta), 1e-6);
  const sigmaUncondDelta = omega / denom;
  const sigmaUncond = Math.pow(sigmaUncondDelta, invDelta);
  return { path, unconditional: sigmaUncond * sigmaUncond };
}

export function forecastNagarch(model, lastEps, lastVar, horizon) {
  const { omega, alpha, theta, beta } = model.params;
  const sigmaPrev = Math.sqrt(Math.max(lastVar, 1e-20));
  const path = new Array(horizon);
  // One-step-ahead uses realized ε
  let h0 = omega + alpha * Math.pow(lastEps - theta * sigmaPrev, 2) + beta * lastVar;
  path[0] = h0;
  // For h ≥ 2 under symmetric Gaussian: E[(z − θ)²·σ²] = (1 + θ²)·σ²
  let prev = h0;
  for (let h = 1; h < horizon; h++) {
    path[h] = omega + alpha * (1 + theta * theta) * prev + beta * prev;
    prev = path[h];
  }
  const persistence = alpha * (1 + theta * theta) + beta;
  const uncond = omega / Math.max(1 - persistence, 1e-6);
  return { path, unconditional: uncond };
}

export function forecastNgarch(model, lastEps, lastVar, horizon) {
  const { omega, alpha, beta, delta } = model.params;
  const sigmaLast = Math.sqrt(Math.max(lastVar, 1e-20));
  let sdelta = Math.pow(sigmaLast, delta);
  sdelta = omega + alpha * Math.pow(Math.abs(lastEps), delta) + beta * sdelta;
  const path = new Array(horizon);
  const invDelta = 1 / delta;
  let sigma = Math.pow(sdelta, invDelta);
  path[0] = sigma * sigma;
  // κ = E[|z|^δ] for z ~ N(0,1) = 2^(δ/2) · Γ((δ+1)/2) / √π — use tabulated gamma
  const kappa = Math.pow(2, delta / 2) * gammaFn((delta + 1) / 2) / Math.sqrt(Math.PI);
  for (let h = 1; h < horizon; h++) {
    sdelta = omega + (alpha * kappa + beta) * sdelta;
    sigma = Math.pow(sdelta, invDelta);
    path[h] = sigma * sigma;
  }
  const sigmaUncondDelta = omega / Math.max(1 - (alpha * kappa + beta), 1e-6);
  const sigmaUncond = Math.pow(sigmaUncondDelta, invDelta);
  return { path, unconditional: sigmaUncond * sigmaUncond };
}

export function forecastAvgarch(model, lastEps, lastVar, horizon) {
  const { omega, alpha, beta } = model.params;
  const sigmaLast = Math.sqrt(Math.max(lastVar, 1e-20));
  let sigma = omega + alpha * Math.abs(lastEps) + beta * sigmaLast;
  const path = new Array(horizon);
  path[0] = sigma * sigma;
  for (let h = 1; h < horizon; h++) {
    sigma = omega + (alpha * SQRT_2_OVER_PI + beta) * sigma;
    path[h] = sigma * sigma;
  }
  const sigmaUncond = omega / Math.max(1 - (alpha * SQRT_2_OVER_PI + beta), 1e-6);
  return { path, unconditional: sigmaUncond * sigmaUncond };
}

// --- Stirling's approximation to the gamma function ----------------------
// Used by NGARCH / APARCH forecast helpers to evaluate E[|z|^δ] for
// z ~ N(0,1). Good to ~1e-10 for x ≥ 1; for 0 < x < 1 use the reflection
// Γ(x) = π / (sin(π·x) · Γ(1-x)).
function gammaFn(x) {
  if (x < 0.5) {
    return Math.PI / (Math.sin(Math.PI * x) * gammaFn(1 - x));
  }
  x -= 1;
  // Lanczos approximation, g=7
  const g = 7;
  const p = [
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  let a = p[0];
  for (let i = 1; i < g + 2; i++) a += p[i] / (x + i);
  const t = x + g + 0.5;
  return Math.sqrt(2 * Math.PI) * Math.pow(t, x + 0.5) * Math.exp(-t) * a;
}

// --- ensemble --------------------------------------------------------------

export function equalWeightEnsemble(models) {
  const n = models[0].condVar.length;
  const condVar = new Array(n).fill(0);
  const w = 1 / models.length;
  for (let t = 0; t < n; t++) {
    for (let m = 0; m < models.length; m++) condVar[t] += w * models[m].condVar[t];
  }
  return { condVar, weights: models.map(() => w) };
}

// BIC-weighted ensemble: w_m ∝ exp(−½·BIC_m), normalized. Dominant models
// pull the average; useful when the zoo is used as a forecast panel.
export function bicWeightEnsemble(models) {
  if (models.length === 0) return null;
  const n = models[0].condVar.length;
  const bics = models.map((m) => m.bic);
  const minBic = Math.min(...bics);
  const raw = bics.map((bic) => Math.exp(-0.5 * (bic - minBic)));
  const sum = raw.reduce((a, b) => a + b, 0);
  const weights = raw.map((r) => r / sum);
  const condVar = new Array(n).fill(0);
  for (let t = 0; t < n; t++) {
    for (let m = 0; m < models.length; m++) {
      condVar[t] += weights[m] * models[m].condVar[t];
    }
  }
  return { condVar, weights };
}

export function blendForecasts(forecasts, weights) {
  const h = forecasts[0].path.length;
  const path = new Array(h).fill(0);
  let uncond = 0;
  let uncondW = 0;
  for (let t = 0; t < h; t++) {
    for (let m = 0; m < forecasts.length; m++) path[t] += weights[m] * forecasts[m].path[t];
  }
  for (let m = 0; m < forecasts.length; m++) {
    if (forecasts[m].unconditional != null && Number.isFinite(forecasts[m].unconditional)) {
      uncond += weights[m] * forecasts[m].unconditional;
      uncondW += weights[m];
    }
  }
  return { path, unconditional: uncondW > 0 ? uncond / uncondW : null };
}

// --- convenience wrappers --------------------------------------------------

export function annualize(variance) {
  if (variance == null || !(variance > 0) || !Number.isFinite(variance)) return null;
  return Math.sqrt(variance * TRADING_DAYS_YEAR);
}

export function horizonSigma(path, h) {
  if (!path || path.length === 0) return null;
  const use = Math.min(h, path.length);
  let s = 0;
  let count = 0;
  for (let t = 0; t < use; t++) {
    if (path[t] != null && Number.isFinite(path[t]) && path[t] > 0) {
      s += path[t];
      count++;
    }
  }
  if (count === 0) return null;
  return annualize(s / count);
}

// =============================================================================
// STAGE 2 — the remaining GARCH-family specifications. Each model plugs into
// the same orchestrator pattern as Stage 1: a fitter returns a
// {condVar, params, logLik, bic, ...} record and a forecast helper that
// projects the conditional variance h trading days forward.
//
// COVERAGE ADDED
//   - CGARCH / GARCH-M / GAS                 (component, in-mean, score)
//   - FIGARCH / HYGARCH                      (long-memory)
//   - MS-GARCH                               (2-regime, Gray 1996)
//   - Realized GARCH / HEAVY                 (5-day SSR proxy for RV)
//   - CCC / DCC / BEKK / OGARCH              (multivariate, paired series)
// =============================================================================

// --- CGARCH (Lee-Engle 1999) -----------------------------------------------
// Component decomposition into a slow long-run variance q_t and a short-run
// deviation s_t. Identification requires ρ > α+β: the long-run component
// decays more slowly than short-run fluctuations.
//   q_t = ω + ρ·q_{t-1} + φ·(ε²_{t-1} − h_{t-1})
//   s_t = α·(ε²_{t-1} − q_{t-1}) + β·s_{t-1}
//   h_t = q_t + s_t

function cgarchCondVar(eps, omega, rho, phi, alpha, beta, initQ, initH) {
  const n = eps.length;
  const h = new Array(n);
  const q = new Array(n);
  h[0] = initH;
  q[0] = initQ;
  for (let t = 1; t < n; t++) {
    const prevEps2 = eps[t - 1] * eps[t - 1];
    const sPrev = h[t - 1] - q[t - 1];
    q[t] = omega + rho * q[t - 1] + phi * (prevEps2 - h[t - 1]);
    const sNew = alpha * (prevEps2 - q[t - 1]) + beta * sPrev;
    h[t] = q[t] + sNew;
    if (!(h[t] > 0)) h[t] = 1e-20;
    if (!(q[t] > 0)) q[t] = 1e-20;
  }
  return { h, q };
}

function unpackCgarch(x) {
  return {
    omega: Math.exp(x[0]) * 1e-4,
    rho: 0.9 + 0.099 * sigmoid(x[1]),
    phi: sigmoid(x[2]) * 0.25,
    alpha: sigmoid(x[3]) * 0.3,
    beta: sigmoid(x[4]) * 0.8,
  };
}

export function fitCgarch(eps) {
  const initVar = sampleVariance(eps);
  const objective = (x) => {
    const p = unpackCgarch(x);
    if (p.alpha + p.beta >= 0.995) return 1e8;
    if (p.rho <= p.alpha + p.beta) return 1e6 + 1e4 * (p.alpha + p.beta - p.rho + 0.01);
    const { h } = cgarchCondVar(eps, p.omega, p.rho, p.phi, p.alpha, p.beta, initVar, initVar);
    return gaussianNegLogLik(eps, h);
  };
  const startRaw = [0, 0, -1, -1, 1];
  const t0 = performance.now();
  const { x, fx, converged, iter } = nelderMead(objective, startRaw, { maxIter: 1200 });
  const elapsedMs = performance.now() - t0;
  const params = unpackCgarch(x);
  const { h, q } = cgarchCondVar(eps, params.omega, params.rho, params.phi, params.alpha, params.beta, initVar, initVar);
  const n = h.length;
  const logLik = -fx;
  const k = 5;
  return {
    name: 'CGARCH', family: 'component', params, rawParams: x,
    logLik, k, aic: 2 * k - 2 * logLik, bic: k * Math.log(n) - 2 * logLik,
    iter, converged, elapsedMs, condVar: h, __lastQ: q[n - 1], __lastS: h[n - 1] - q[n - 1],
  };
}

export function forecastCgarch(model, lastEps, lastVar, horizon) {
  const { omega, rho, phi, alpha, beta } = model.params;
  let q = model.__lastQ ?? lastVar;
  let s = model.__lastS ?? 0;
  const path = new Array(horizon);
  const prevEps2 = lastEps * lastEps;
  const qNew = omega + rho * q + phi * (prevEps2 - lastVar);
  const sNew = alpha * (prevEps2 - q) + beta * s;
  q = qNew;
  s = sNew;
  path[0] = q + s;
  for (let k = 1; k < horizon; k++) {
    const hPrev = q + s;
    const qNext = omega + rho * q;
    const sNext = alpha * (hPrev - q) + beta * s;
    q = qNext;
    s = sNext;
    path[k] = q + s;
    if (!(path[k] > 0)) path[k] = 1e-20;
  }
  const qUncond = omega / Math.max(1 - rho, 1e-6);
  return { path, unconditional: qUncond };
}

// --- GARCH-in-Mean (Engle-Lilien-Robins 1987) ------------------------------
// r_t = μ + λ·σ_t + ε_t with ε_t ~ N(0, h_t) and h_t GARCH(1,1). λ is the
// risk-premium coefficient: λ > 0 means the asset requires a higher expected
// return when conditional volatility is elevated. Causal GARCH-M: the mean
// uses √h_{t−1} (σ_{t−1}) while h_t follows the usual GARCH(1,1) recursion.

function garchMCondVarAndEps(returns, mu, lambda, omega, alpha, beta, initVar) {
  const n = returns.length;
  const h = new Array(n);
  const eps = new Array(n);
  h[0] = initVar;
  eps[0] = returns[0] - mu - lambda * Math.sqrt(initVar);
  for (let t = 1; t < n; t++) {
    const prevEps = eps[t - 1];
    h[t] = omega + alpha * prevEps * prevEps + beta * h[t - 1];
    if (!(h[t] > 0)) h[t] = 1e-20;
    eps[t] = returns[t] - mu - lambda * Math.sqrt(h[t - 1]);
  }
  return { h, eps };
}

function unpackGarchM(x) {
  return {
    mu: x[0] * 1e-3,
    lambda: x[1] * 0.1,
    omega: Math.exp(x[2]) * 1e-4,
    alpha: sigmoid(x[3]) * 0.3,
    beta: sigmoid(x[4]),
  };
}

export function fitGarchM(returnsRaw) {
  const initVar = sampleVariance(returnsRaw);
  const objective = (x) => {
    const p = unpackGarchM(x);
    if (p.alpha + p.beta >= 0.9995) return 1e8;
    const { h, eps } = garchMCondVarAndEps(returnsRaw, p.mu, p.lambda, p.omega, p.alpha, p.beta, initVar);
    return gaussianNegLogLik(eps, h);
  };
  const startRaw = [0, 0, 0, -2.5, 1.8];
  const t0 = performance.now();
  const { x, fx, converged, iter } = nelderMead(objective, startRaw, { maxIter: 1500 });
  const elapsedMs = performance.now() - t0;
  const params = unpackGarchM(x);
  const { h: condVar, eps } = garchMCondVarAndEps(returnsRaw, params.mu, params.lambda, params.omega, params.alpha, params.beta, initVar);
  const n = condVar.length;
  const logLik = -fx;
  const k = 5;
  return {
    name: 'GARCH-M', family: 'mean', params, rawParams: x,
    logLik, k, aic: 2 * k - 2 * logLik, bic: k * Math.log(n) - 2 * logLik,
    iter, converged, elapsedMs, condVar, __eps: eps,
  };
}

export function forecastGarchM(model, lastEps, lastVar, horizon) {
  const { omega, alpha, beta } = model.params;
  const persistence = alpha + beta;
  const uncond = omega / Math.max(1 - persistence, 1e-6);
  const lastE = model.__eps ? model.__eps[model.__eps.length - 1] : lastEps;
  const path = new Array(horizon);
  let prev = omega + alpha * lastE * lastE + beta * lastVar;
  path[0] = prev;
  for (let h = 1; h < horizon; h++) {
    path[h] = omega + persistence * prev;
    prev = path[h];
  }
  return { path, unconditional: uncond };
}

// --- GAS (Creal-Koopman-Lucas 2013) ----------------------------------------
// Score-driven updating on log conditional variance:
//   log h_t = ω + α·s_{t-1} + β·log h_{t-1}
// For the Gaussian location-scale, the scaled score on the variance
// parameter simplifies to s_t = ε²_t/h_t − 1. The same EGARCH-style log
// transform keeps h_t strictly positive.

function gasCondVar(eps, omega, alpha, beta, initVar) {
  const n = eps.length;
  const h = new Array(n);
  const logH = new Array(n);
  logH[0] = Math.log(initVar);
  h[0] = initVar;
  for (let t = 1; t < n; t++) {
    const ht1 = h[t - 1];
    const score = (eps[t - 1] * eps[t - 1]) / ht1 - 1;
    logH[t] = omega + alpha * score + beta * logH[t - 1];
    if (logH[t] > LOG_VAR_CAP) logH[t] = LOG_VAR_CAP;
    else if (logH[t] < -LOG_VAR_CAP) logH[t] = -LOG_VAR_CAP;
    h[t] = Math.exp(logH[t]);
  }
  return h;
}

function unpackGas(x) {
  return {
    omega: x[0],
    alpha: x[1],
    beta: Math.tanh(x[2]),
  };
}

export function fitGas(eps) {
  const initVar = sampleVariance(eps);
  const condVarFromParams = ({ omega, alpha, beta }) => gasCondVar(eps, omega, alpha, beta, initVar);
  const objective = (x) => {
    const { omega, alpha, beta } = unpackGas(x);
    const h = gasCondVar(eps, omega, alpha, beta, initVar);
    return gaussianNegLogLik(eps, h);
  };
  const logInit = Math.log(Math.max(initVar, 1e-10));
  const startRaw = [0.05 * logInit, 0.03, 2.0];
  return fitOne({
    name: 'GAS', family: 'score', kParams: 3,
    objective, unpack: unpackGas, startRaw, condVarFromParams,
  });
}

export function forecastGas(model, lastEps, lastVar, horizon) {
  const { omega, alpha, beta } = model.params;
  const N = 400;
  const sumPath = new Array(horizon).fill(0);
  let seed = 0x2c6a7f1d;
  const randN = () => {
    let u, v, s;
    do {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      u = (seed / 0x100000000) * 2 - 1;
      seed = (seed * 1664525 + 1013904223) >>> 0;
      v = (seed / 0x100000000) * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    return u * Math.sqrt(-2 * Math.log(s) / s);
  };
  for (let sim = 0; sim < N; sim++) {
    let logH = omega + alpha * ((lastEps * lastEps) / lastVar - 1) + beta * Math.log(Math.max(lastVar, 1e-20));
    if (logH > LOG_VAR_CAP) logH = LOG_VAR_CAP;
    else if (logH < -LOG_VAR_CAP) logH = -LOG_VAR_CAP;
    sumPath[0] += Math.exp(logH);
    for (let h = 1; h < horizon; h++) {
      const z = randN();
      logH = omega + alpha * (z * z - 1) + beta * logH;
      if (logH > LOG_VAR_CAP) logH = LOG_VAR_CAP;
      else if (logH < -LOG_VAR_CAP) logH = -LOG_VAR_CAP;
      sumPath[h] += Math.exp(logH);
    }
  }
  const path = sumPath.map((v) => v / N);
  const uncond = Math.exp(omega / Math.max(1 - beta, 1e-6));
  return { path, unconditional: uncond };
}

// --- FIGARCH / HYGARCH (long-memory) ---------------------------------------
// BBM (Baillie-Bollerslev-Mikkelsen 1996) ARCH(∞) form of FIGARCH(1,d,1):
//   (1 − βL)·h_t = ω + [(1 − βL) − (1 − φL)(1 − L)^d]·ε²_t
// which gives h_t = ω/(1−β) + Σ_{j≥1} λ_j·ε²_{t−j} with λ_j recursively
// computed from the fractional-difference coefficients π_j of (1 − L)^d.
// The truncation at 500 lags covers >99.9% of the cumulative ARCH(∞) weight
// for the typical (d, β) region on SPX daily returns.

const FIGARCH_TRUNCATION = 500;

function figarchLambdas(phi, beta, d, M) {
  const pi = new Array(M + 1);
  pi[0] = 1;
  for (let j = 1; j <= M; j++) {
    pi[j] = pi[j - 1] * (j - 1 - d) / j;
  }
  const lam = new Array(M);
  lam[0] = -beta + d + phi;
  for (let k = 2; k <= M; k++) {
    lam[k - 1] = beta * lam[k - 2] + phi * pi[k - 1] - pi[k];
  }
  return lam;
}

function figarchCondVar(eps, omega, beta, initVar, lambdas) {
  const n = eps.length;
  const h = new Array(n);
  const omegaAdj = omega / Math.max(1 - beta, 1e-6);
  h[0] = initVar;
  const M = lambdas.length;
  for (let t = 1; t < n; t++) {
    let s = 0;
    const J = Math.min(M, t);
    for (let j = 0; j < J; j++) {
      const prev = eps[t - 1 - j];
      s += lambdas[j] * prev * prev;
    }
    if (J < M) {
      for (let j = J; j < M; j++) s += lambdas[j] * initVar;
    }
    h[t] = omegaAdj + s;
    if (!(h[t] > 0)) h[t] = 1e-20;
  }
  return h;
}

function unpackFigarch(x) {
  return {
    omega: Math.exp(x[0]) * 1e-4,
    phi: sigmoid(x[1]) * 0.5,
    beta: sigmoid(x[2]) * 0.8,
    d: 0.05 + sigmoid(x[3]) * 0.9,
  };
}

export function fitFigarch(eps) {
  const initVar = sampleVariance(eps);
  const objective = (x) => {
    const { omega, phi, beta, d } = unpackFigarch(x);
    if (beta - d - phi > 0) return 1e8;
    const lambdas = figarchLambdas(phi, beta, d, FIGARCH_TRUNCATION);
    const last = lambdas[lambdas.length - 1];
    if (!Number.isFinite(last)) return 1e9;
    const h = figarchCondVar(eps, omega, beta, initVar, lambdas);
    return gaussianNegLogLik(eps, h);
  };
  const startRaw = [0, -1, 0, 0];
  const t0 = performance.now();
  const { x, fx, converged, iter } = nelderMead(objective, startRaw, { maxIter: 1500 });
  const elapsedMs = performance.now() - t0;
  const params = unpackFigarch(x);
  const lambdas = figarchLambdas(params.phi, params.beta, params.d, FIGARCH_TRUNCATION);
  const condVar = figarchCondVar(eps, params.omega, params.beta, initVar, lambdas);
  const n = condVar.length;
  const logLik = -fx;
  const k = 4;
  return {
    name: 'FIGARCH', family: 'long-memory', params, rawParams: x,
    logLik, k, aic: 2 * k - 2 * logLik, bic: k * Math.log(n) - 2 * logLik,
    iter, converged, elapsedMs, condVar,
    __lambdas: lambdas, __initVar: initVar,
  };
}

export function forecastFigarch(model, lastEps, lastVar, horizon) {
  const { omega, beta } = model.params;
  const lambdas = model.__lambdas;
  const initVar = model.__initVar ?? lastVar;
  const M = lambdas.length;
  const omegaAdj = omega / Math.max(1 - beta, 1e-6);
  const path = new Array(horizon);
  const hist = new Array(M).fill(initVar);
  hist[0] = lastEps * lastEps;
  let s0 = 0;
  for (let j = 0; j < M; j++) s0 += lambdas[j] * hist[j];
  path[0] = omegaAdj + s0;
  for (let k = 1; k < horizon; k++) {
    for (let j = M - 1; j >= 1; j--) hist[j] = hist[j - 1];
    hist[0] = path[k - 1];
    let s = 0;
    for (let j = 0; j < M; j++) s += lambdas[j] * hist[j];
    path[k] = omegaAdj + s;
    if (!(path[k] > 0)) path[k] = 1e-20;
  }
  return { path, unconditional: null };
}

// HYGARCH (Davidson 2004): pragmatic mixture of GARCH(1,1) and FIGARCH. Mix
// weight `w` ∈ (0, 1) sits on the FIGARCH component; β is shared.
function unpackHygarch(x) {
  return {
    omega: Math.exp(x[0]) * 1e-4,
    alpha: sigmoid(x[1]) * 0.3,
    beta: sigmoid(x[2]) * 0.8,
    d: 0.05 + sigmoid(x[3]) * 0.9,
    phi: sigmoid(x[4]) * 0.5,
    mix: sigmoid(x[5]),
  };
}

function hygarchCondVar(eps, omega, alpha, beta, d, phi, mix, initVar, lambdas) {
  const n = eps.length;
  const hG = garchCondVar(eps, omega, alpha, beta, initVar);
  const hF = figarchCondVar(eps, omega, beta, initVar, lambdas);
  const h = new Array(n);
  for (let t = 0; t < n; t++) {
    h[t] = mix * hF[t] + (1 - mix) * hG[t];
    if (!(h[t] > 0)) h[t] = 1e-20;
  }
  return h;
}

export function fitHygarch(eps) {
  const initVar = sampleVariance(eps);
  const objective = (x) => {
    const p = unpackHygarch(x);
    if (p.alpha + p.beta >= 0.9995) return 1e8;
    if (p.beta - p.d - p.phi > 0) return 1e8;
    const lambdas = figarchLambdas(p.phi, p.beta, p.d, FIGARCH_TRUNCATION);
    if (!Number.isFinite(lambdas[lambdas.length - 1])) return 1e9;
    const h = hygarchCondVar(eps, p.omega, p.alpha, p.beta, p.d, p.phi, p.mix, initVar, lambdas);
    return gaussianNegLogLik(eps, h);
  };
  const startRaw = [0, -2.5, 1.5, 0, -1, 0];
  const t0 = performance.now();
  const { x, fx, converged, iter } = nelderMead(objective, startRaw, { maxIter: 1800 });
  const elapsedMs = performance.now() - t0;
  const params = unpackHygarch(x);
  const lambdas = figarchLambdas(params.phi, params.beta, params.d, FIGARCH_TRUNCATION);
  const condVar = hygarchCondVar(eps, params.omega, params.alpha, params.beta, params.d, params.phi, params.mix, initVar, lambdas);
  const n = condVar.length;
  const logLik = -fx;
  const k = 6;
  return {
    name: 'HYGARCH', family: 'long-memory', params, rawParams: x,
    logLik, k, aic: 2 * k - 2 * logLik, bic: k * Math.log(n) - 2 * logLik,
    iter, converged, elapsedMs, condVar,
    __lambdas: lambdas, __initVar: initVar,
  };
}

export function forecastHygarch(model, lastEps, lastVar, horizon) {
  const { omega, alpha, beta, mix } = model.params;
  const garchFc = forecastGarch({ params: { omega, alpha, beta } }, lastEps, lastVar, horizon);
  const figarchFc = forecastFigarch(
    { params: { omega, beta }, __lambdas: model.__lambdas, __initVar: model.__initVar },
    lastEps, lastVar, horizon,
  );
  const path = new Array(horizon);
  for (let h = 0; h < horizon; h++) {
    path[h] = mix * figarchFc.path[h] + (1 - mix) * garchFc.path[h];
  }
  return { path, unconditional: garchFc.unconditional };
}

// --- MS-GARCH (Gray 1996, 2-regime) ----------------------------------------
// Two-state Markov-regime GARCH(1,1) with Hamilton-filter likelihood. Gray's
// path-integration simplification feeds the mixture variance
// h̄_{t-1} = Σ_j π_{t-1|t-1}(j)·h_{j,t-1} into each regime's lag so the
// state stays finite.

function msGarchFilterAndLik(eps, p) {
  const n = eps.length;
  const initVar = sampleVariance(eps);
  const denom = 2 - p.p11 - p.p22;
  const piStart = denom > 1e-6 ? (1 - p.p22) / denom : 0.5;
  let pi1 = piStart;
  let pi2 = 1 - piStart;
  const h1 = new Array(n);
  const h2 = new Array(n);
  const hBar = new Array(n);
  const smooth1 = new Array(n);
  h1[0] = initVar;
  h2[0] = initVar;
  hBar[0] = initVar;
  smooth1[0] = pi1;
  let nll = 0;
  for (let t = 1; t < n; t++) {
    const fwd1 = p.p11 * pi1 + (1 - p.p22) * pi2;
    const fwd2 = (1 - p.p11) * pi1 + p.p22 * pi2;
    h1[t] = p.omega1 + p.alpha1 * eps[t - 1] * eps[t - 1] + p.beta1 * hBar[t - 1];
    h2[t] = p.omega2 + p.alpha2 * eps[t - 1] * eps[t - 1] + p.beta2 * hBar[t - 1];
    if (!(h1[t] > 0)) h1[t] = 1e-20;
    if (!(h2[t] > 0)) h2[t] = 1e-20;
    const e = eps[t];
    const f1 = Math.exp(-0.5 * (LOG_2PI + Math.log(h1[t]) + (e * e) / h1[t]));
    const f2 = Math.exp(-0.5 * (LOG_2PI + Math.log(h2[t]) + (e * e) / h2[t]));
    const marg = fwd1 * f1 + fwd2 * f2;
    if (!(marg > 0) || !Number.isFinite(marg)) {
      return { nll: Number.POSITIVE_INFINITY };
    }
    nll += -Math.log(marg);
    pi1 = (fwd1 * f1) / marg;
    pi2 = (fwd2 * f2) / marg;
    hBar[t] = pi1 * h1[t] + pi2 * h2[t];
    smooth1[t] = pi1;
  }
  return { nll, h1, h2, hBar, smooth1 };
}

function unpackMsGarch(x) {
  return {
    omega1: Math.exp(x[0]) * 1e-6,
    alpha1: sigmoid(x[1]) * 0.2,
    beta1: sigmoid(x[2]) * 0.95,
    omega2: Math.exp(x[3]) * 1e-5,
    alpha2: sigmoid(x[4]) * 0.35,
    beta2: sigmoid(x[5]) * 0.9,
    p11: 0.9 + 0.099 * sigmoid(x[6]),
    p22: 0.8 + 0.19 * sigmoid(x[7]),
  };
}

export function fitMsGarch(eps) {
  const objective = (x) => {
    const p = unpackMsGarch(x);
    if (p.alpha1 + p.beta1 >= 0.9995) return 1e8;
    if (p.alpha2 + p.beta2 >= 0.9995) return 1e8;
    return msGarchFilterAndLik(eps, p).nll;
  };
  const startRaw = [0, -2.5, 2.5, 0, -1.5, 2, 2, 1];
  const t0 = performance.now();
  const { x, fx, converged, iter } = nelderMead(objective, startRaw, { maxIter: 2000 });
  const elapsedMs = performance.now() - t0;
  const params = unpackMsGarch(x);
  const filt = msGarchFilterAndLik(eps, params);
  const n = filt.hBar.length;
  const logLik = -fx;
  const k = 8;
  params.alpha = (params.alpha1 + params.alpha2) / 2;
  params.beta = (params.beta1 + params.beta2) / 2;
  params.omega = (params.omega1 + params.omega2) / 2;
  return {
    name: 'MS-GARCH', family: 'regime', params, rawParams: x,
    logLik, k, aic: 2 * k - 2 * logLik, bic: k * Math.log(n) - 2 * logLik,
    iter, converged, elapsedMs, condVar: filt.hBar,
    __h1: filt.h1, __h2: filt.h2, __smooth1: filt.smooth1,
  };
}

export function forecastMsGarch(model, lastEps, lastVar, horizon) {
  const p = model.params;
  let pi1 = model.__smooth1 ? model.__smooth1[model.__smooth1.length - 1] : 0.5;
  let pi2 = 1 - pi1;
  let h1 = model.__h1 ? model.__h1[model.__h1.length - 1] : lastVar;
  let h2 = model.__h2 ? model.__h2[model.__h2.length - 1] : lastVar;
  let hBar = pi1 * h1 + pi2 * h2;
  const path = new Array(horizon);
  h1 = p.omega1 + p.alpha1 * lastEps * lastEps + p.beta1 * hBar;
  h2 = p.omega2 + p.alpha2 * lastEps * lastEps + p.beta2 * hBar;
  let fwd1 = p.p11 * pi1 + (1 - p.p22) * pi2;
  let fwd2 = (1 - p.p11) * pi1 + p.p22 * pi2;
  pi1 = fwd1; pi2 = fwd2;
  hBar = pi1 * h1 + pi2 * h2;
  path[0] = hBar;
  for (let k = 1; k < horizon; k++) {
    h1 = p.omega1 + (p.alpha1 + p.beta1) * hBar;
    h2 = p.omega2 + (p.alpha2 + p.beta2) * hBar;
    fwd1 = p.p11 * pi1 + (1 - p.p22) * pi2;
    fwd2 = (1 - p.p11) * pi1 + p.p22 * pi2;
    pi1 = fwd1; pi2 = fwd2;
    hBar = pi1 * h1 + pi2 * h2;
    path[k] = hBar;
  }
  const denom = 2 - p.p11 - p.p22;
  const piS1 = denom > 1e-6 ? (1 - p.p22) / denom : 0.5;
  const piS2 = 1 - piS1;
  const var1 = p.omega1 / Math.max(1 - p.alpha1 - p.beta1, 1e-6);
  const var2 = p.omega2 / Math.max(1 - p.alpha2 - p.beta2, 1e-6);
  return { path, unconditional: piS1 * var1 + piS2 * var2 };
}

// --- Realized GARCH + HEAVY (5-day SSR proxy for RV) -----------------------
// Neither model has access to intraday data from /api/gex-history; both use
// RV_t = Σ_{k=0}^{4} ε²_{t−k} / 5 as a daily proxy and then follow the
// GARCH-X structural form.
//   Realized GARCH: h_t = ω + β·h_{t-1} + γ·RV_{t-1}
//   HEAVY:          h_t = ω + α·RV_{t-1} + β·h_{t-1}

const RV_WINDOW = 5;

function realizedProxy(eps) {
  const n = eps.length;
  const rv = new Array(n).fill(0);
  for (let t = 0; t < n; t++) {
    const start = Math.max(0, t - RV_WINDOW + 1);
    let s = 0; let cnt = 0;
    for (let j = start; j <= t; j++) { s += eps[j] * eps[j]; cnt++; }
    rv[t] = cnt > 0 ? s / cnt : 0;
  }
  return rv;
}

function rvGarchCondVar(eps, rv, omega, a, b, initVar) {
  const n = eps.length;
  const h = new Array(n);
  h[0] = initVar;
  for (let t = 1; t < n; t++) {
    h[t] = omega + a * rv[t - 1] + b * h[t - 1];
    if (!(h[t] > 0)) h[t] = 1e-20;
  }
  return h;
}

function unpackRealizedGarch(x) {
  return {
    omega: Math.exp(x[0]) * 1e-4,
    beta: sigmoid(x[1]),
    gamma: sigmoid(x[2]) * 0.5,
  };
}

export function fitRealizedGarch(eps) {
  const initVar = sampleVariance(eps);
  const rv = realizedProxy(eps);
  const objective = (x) => {
    const { omega, beta, gamma } = unpackRealizedGarch(x);
    if (beta + gamma >= 0.9995) return 1e8;
    const h = rvGarchCondVar(eps, rv, omega, gamma, beta, initVar);
    return gaussianNegLogLik(eps, h);
  };
  const startRaw = [0, 1.5, -1.5];
  const t0 = performance.now();
  const { x, fx, converged, iter } = nelderMead(objective, startRaw);
  const elapsedMs = performance.now() - t0;
  const params = unpackRealizedGarch(x);
  const condVar = rvGarchCondVar(eps, rv, params.omega, params.gamma, params.beta, initVar);
  const n = condVar.length;
  const logLik = -fx;
  const k = 3;
  params.alpha = params.gamma;
  return {
    name: 'Realized GARCH', family: 'realized', params, rawParams: x,
    logLik, k, aic: 2 * k - 2 * logLik, bic: k * Math.log(n) - 2 * logLik,
    iter, converged, elapsedMs, condVar, __rv: rv,
  };
}

export function forecastRealizedGarch(model, lastEps, lastVar, horizon) {
  const { omega, beta, gamma } = model.params;
  const rvLast = model.__rv ? model.__rv[model.__rv.length - 1] : lastEps * lastEps;
  const path = new Array(horizon);
  let prev = omega + beta * lastVar + gamma * rvLast;
  path[0] = prev;
  for (let h = 1; h < horizon; h++) {
    path[h] = omega + (beta + gamma) * prev;
    prev = path[h];
  }
  const uncond = omega / Math.max(1 - beta - gamma, 1e-6);
  return { path, unconditional: uncond };
}

function unpackHeavy(x) {
  return {
    omega: Math.exp(x[0]) * 1e-4,
    alpha: sigmoid(x[1]) * 0.5,
    beta: sigmoid(x[2]),
  };
}

export function fitHeavy(eps) {
  const initVar = sampleVariance(eps);
  const rv = realizedProxy(eps);
  const objective = (x) => {
    const { omega, alpha, beta } = unpackHeavy(x);
    if (alpha + beta >= 0.9995) return 1e8;
    const h = rvGarchCondVar(eps, rv, omega, alpha, beta, initVar);
    return gaussianNegLogLik(eps, h);
  };
  const startRaw = [0, -1.5, 1.5];
  const t0 = performance.now();
  const { x, fx, converged, iter } = nelderMead(objective, startRaw);
  const elapsedMs = performance.now() - t0;
  const params = unpackHeavy(x);
  const condVar = rvGarchCondVar(eps, rv, params.omega, params.alpha, params.beta, initVar);
  const n = condVar.length;
  const logLik = -fx;
  const k = 3;
  return {
    name: 'HEAVY', family: 'realized', params, rawParams: x,
    logLik, k, aic: 2 * k - 2 * logLik, bic: k * Math.log(n) - 2 * logLik,
    iter, converged, elapsedMs, condVar, __rv: rv,
  };
}

export function forecastHeavy(model, lastEps, lastVar, horizon) {
  const { omega, alpha, beta } = model.params;
  const rvLast = model.__rv ? model.__rv[model.__rv.length - 1] : lastEps * lastEps;
  const path = new Array(horizon);
  let prev = omega + alpha * rvLast + beta * lastVar;
  path[0] = prev;
  for (let h = 1; h < horizon; h++) {
    path[h] = omega + (alpha + beta) * prev;
    prev = path[h];
  }
  const uncond = omega / Math.max(1 - alpha - beta, 1e-6);
  return { path, unconditional: uncond };
}

// --- Multivariate: CCC / DCC / BEKK / OGARCH -------------------------------
// All four run on a paired series (ε₁, ε₂) supplied by the caller. The zoo's
// scalar ensemble picks up the SPX-marginal conditional variance H_t[0,0]
// from each model; each fit also carries a __correlation series so the UI
// can plot the implied ρ_{12}(t) separately from the σ path.

function fitUnivariateGarch11(eps) {
  const initVar = sampleVariance(eps);
  const objective = (x) => {
    const { omega, alpha, beta } = unpackGarch(x);
    if (alpha + beta >= 0.9995) return 1e6 + 1e4 * (alpha + beta);
    const h = garchCondVar(eps, omega, alpha, beta, initVar);
    return gaussianNegLogLik(eps, h);
  };
  const startRaw = [Math.log(Math.max(initVar * 0.02, 1e-8)), 3.89, -2.94];
  const { x } = nelderMead(objective, startRaw);
  const params = unpackGarch(x);
  const h = garchCondVar(eps, params.omega, params.alpha, params.beta, initVar);
  const z = new Array(eps.length);
  for (let t = 0; t < eps.length; t++) {
    z[t] = eps[t] / Math.sqrt(Math.max(h[t], 1e-20));
  }
  return { params, h, z };
}

function sampleCorrelation(a, b) {
  const n = Math.min(a.length, b.length);
  const aMean = mean(a);
  const bMean = mean(b);
  let num = 0; let da = 0; let db = 0;
  for (let t = 0; t < n; t++) {
    const xa = a[t] - aMean;
    const xb = b[t] - bMean;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  return num / Math.sqrt(Math.max(da * db, 1e-30));
}

function bivariateGaussianLogLik(eps1, eps2, h11arr, h22arr, rhoArr) {
  const n = eps1.length;
  let ll = 0;
  for (let t = 0; t < n; t++) {
    const h11 = h11arr[t];
    const h22 = h22arr[t];
    const rho = rhoArr[t];
    const oneMinusR2 = 1 - rho * rho;
    const det = h11 * h22 * oneMinusR2;
    if (!(det > 0)) return Number.NEGATIVE_INFINITY;
    const sigProd = Math.sqrt(h11 * h22);
    const quad = (eps1[t] * eps1[t]) / h11 +
                 (eps2[t] * eps2[t]) / h22 -
                 2 * rho * eps1[t] * eps2[t] / sigProd;
    ll += -0.5 * (2 * LOG_2PI + Math.log(det) + quad / oneMinusR2);
  }
  return ll;
}

export function fitCcc(eps1, eps2) {
  const g1 = fitUnivariateGarch11(eps1);
  const g2 = fitUnivariateGarch11(eps2);
  const rho = sampleCorrelation(g1.z, g2.z);
  const n = eps1.length;
  const rhoArr = new Array(n).fill(rho);
  const logLik = bivariateGaussianLogLik(eps1, eps2, g1.h, g2.h, rhoArr);
  const k = 2 * 3 + 1;
  return {
    name: 'CCC-GARCH', family: 'multivariate',
    params: { ...g1.params, rho, __aux: g2.params },
    logLik, k, aic: 2 * k - 2 * logLik, bic: k * Math.log(n) - 2 * logLik,
    condVar: g1.h, __correlation: rhoArr, __h22: g2.h,
  };
}

export function forecastCcc(model, lastEps, lastVar, horizon) {
  const { omega, alpha, beta } = model.params;
  return forecastGarch({ params: { omega, alpha, beta } }, lastEps, lastVar, horizon);
}

// DCC (Engle 2002) — quasi-correlation dynamics on standardized residuals,
// two-step estimation: step 1 = per-series GARCH(1,1), step 2 = MLE of the
// correlation-innovation pair (α, β) on the quasi-correlation matrix Q_t.
function fitDccQuasi(z1, z2) {
  const n = z1.length;
  const qBar11 = mean(z1.map((v) => v * v));
  const qBar22 = mean(z2.map((v) => v * v));
  const qBar12 = mean(z1.map((v, i) => v * z2[i]));
  const objective = (x) => {
    const aPlusB = sigmoid(x[0]) * 0.995;
    const aFrac = sigmoid(x[1]);
    const a = aPlusB * aFrac;
    const b = aPlusB * (1 - aFrac);
    let q11 = qBar11, q22 = qBar22, q12 = qBar12;
    let nll = 0;
    for (let t = 0; t < n; t++) {
      if (t > 0) {
        q11 = (1 - a - b) * qBar11 + a * z1[t - 1] * z1[t - 1] + b * q11;
        q22 = (1 - a - b) * qBar22 + a * z2[t - 1] * z2[t - 1] + b * q22;
        q12 = (1 - a - b) * qBar12 + a * z1[t - 1] * z2[t - 1] + b * q12;
      }
      const r = q12 / Math.sqrt(Math.max(q11 * q22, 1e-30));
      const oneMinusR2 = 1 - r * r;
      if (!(oneMinusR2 > 0)) return 1e8;
      const v = z1[t] * z1[t] + z2[t] * z2[t];
      const cross = 2 * r * z1[t] * z2[t];
      nll += 0.5 * (Math.log(oneMinusR2) + (v - cross) / oneMinusR2 - v);
    }
    return nll;
  };
  const { x } = nelderMead(objective, [0, 0], { maxIter: 800 });
  const aPlusB = sigmoid(x[0]) * 0.995;
  const aFrac = sigmoid(x[1]);
  const dccAlpha = aPlusB * aFrac;
  const dccBeta = aPlusB * (1 - aFrac);
  let q11 = qBar11, q22 = qBar22, q12 = qBar12;
  const rSeries = new Array(n);
  for (let t = 0; t < n; t++) {
    if (t > 0) {
      q11 = (1 - dccAlpha - dccBeta) * qBar11 + dccAlpha * z1[t - 1] * z1[t - 1] + dccBeta * q11;
      q22 = (1 - dccAlpha - dccBeta) * qBar22 + dccAlpha * z2[t - 1] * z2[t - 1] + dccBeta * q22;
      q12 = (1 - dccAlpha - dccBeta) * qBar12 + dccAlpha * z1[t - 1] * z2[t - 1] + dccBeta * q12;
    }
    rSeries[t] = q12 / Math.sqrt(Math.max(q11 * q22, 1e-30));
  }
  return { dccAlpha, dccBeta, rSeries };
}

export function fitDcc(eps1, eps2) {
  const g1 = fitUnivariateGarch11(eps1);
  const g2 = fitUnivariateGarch11(eps2);
  const dcc = fitDccQuasi(g1.z, g2.z);
  const n = eps1.length;
  const logLik = bivariateGaussianLogLik(eps1, eps2, g1.h, g2.h, dcc.rSeries);
  const k = 2 * 3 + 2;
  return {
    name: 'DCC-GARCH', family: 'multivariate',
    params: { ...g1.params, dccAlpha: dcc.dccAlpha, dccBeta: dcc.dccBeta, __aux: g2.params },
    logLik, k, aic: 2 * k - 2 * logLik, bic: k * Math.log(n) - 2 * logLik,
    condVar: g1.h, __correlation: dcc.rSeries, __h22: g2.h,
  };
}

export function forecastDcc(model, lastEps, lastVar, horizon) {
  const { omega, alpha, beta } = model.params;
  return forecastGarch({ params: { omega, alpha, beta } }, lastEps, lastVar, horizon);
}

// BEKK(1,1) diagonal: A and B diagonal, C lower-triangular. Fit jointly on
// the bivariate Gaussian likelihood so the cross term is disciplined by both
// h_ii and h_ij dynamics simultaneously.
function bekkDiagRecursion(eps1, eps2, c11, c12, c22, a1, a2, b1, b2, iv1, iv2, ic) {
  const n = eps1.length;
  const h11 = new Array(n), h22 = new Array(n), h12 = new Array(n);
  h11[0] = iv1; h22[0] = iv2; h12[0] = ic;
  const q11 = c11 * c11;
  const q12 = c11 * c12;
  const q22 = c12 * c12 + c22 * c22;
  for (let t = 1; t < n; t++) {
    h11[t] = q11 + a1 * a1 * eps1[t - 1] * eps1[t - 1] + b1 * b1 * h11[t - 1];
    h22[t] = q22 + a2 * a2 * eps2[t - 1] * eps2[t - 1] + b2 * b2 * h22[t - 1];
    h12[t] = q12 + a1 * a2 * eps1[t - 1] * eps2[t - 1] + b1 * b2 * h12[t - 1];
    if (!(h11[t] > 0)) h11[t] = 1e-20;
    if (!(h22[t] > 0)) h22[t] = 1e-20;
  }
  return { h11, h22, h12 };
}

function unpackBekk(x) {
  return {
    c11: Math.exp(x[0]) * 1e-3,
    c12: x[1] * 1e-4,
    c22: Math.exp(x[2]) * 1e-3,
    a1: sigmoid(x[3]) * 0.5,
    a2: sigmoid(x[4]) * 0.5,
    b1: sigmoid(x[5]),
    b2: sigmoid(x[6]),
  };
}

export function fitBekk(eps1, eps2) {
  const iv1 = sampleVariance(eps1);
  const iv2 = sampleVariance(eps2);
  const ic = sampleCorrelation(eps1, eps2) * Math.sqrt(iv1 * iv2);
  const objective = (x) => {
    const p = unpackBekk(x);
    if (p.a1 * p.a1 + p.b1 * p.b1 >= 0.9995) return 1e8;
    if (p.a2 * p.a2 + p.b2 * p.b2 >= 0.9995) return 1e8;
    const rec = bekkDiagRecursion(eps1, eps2, p.c11, p.c12, p.c22, p.a1, p.a2, p.b1, p.b2, iv1, iv2, ic);
    let nll = 0;
    for (let t = 0; t < eps1.length; t++) {
      const det = rec.h11[t] * rec.h22[t] - rec.h12[t] * rec.h12[t];
      if (!(det > 0)) return 1e9;
      const inv11 = rec.h22[t] / det;
      const inv22 = rec.h11[t] / det;
      const inv12 = -rec.h12[t] / det;
      const quad = eps1[t] * eps1[t] * inv11 +
                   eps2[t] * eps2[t] * inv22 +
                   2 * eps1[t] * eps2[t] * inv12;
      nll += 0.5 * (2 * LOG_2PI + Math.log(det) + quad);
    }
    return nll;
  };
  const startRaw = [0, 0, 0, -1.5, -1.5, 2.5, 2.5];
  const t0 = performance.now();
  const { x, fx, converged, iter } = nelderMead(objective, startRaw, { maxIter: 2500 });
  const elapsedMs = performance.now() - t0;
  const params = unpackBekk(x);
  const rec = bekkDiagRecursion(eps1, eps2, params.c11, params.c12, params.c22, params.a1, params.a2, params.b1, params.b2, iv1, iv2, ic);
  const n = eps1.length;
  const logLik = -fx;
  const k = 7;
  const correlation = new Array(n);
  for (let t = 0; t < n; t++) {
    correlation[t] = rec.h12[t] / Math.sqrt(Math.max(rec.h11[t] * rec.h22[t], 1e-30));
  }
  params.omega = params.c11 * params.c11;
  params.alpha = params.a1 * params.a1;
  params.beta = params.b1 * params.b1;
  return {
    name: 'BEKK(1,1)', family: 'multivariate', params, rawParams: x,
    logLik, k, aic: 2 * k - 2 * logLik, bic: k * Math.log(n) - 2 * logLik,
    iter, converged, elapsedMs, condVar: rec.h11,
    __h22: rec.h22, __h12: rec.h12, __correlation: correlation,
  };
}

export function forecastBekk(model, lastEps, lastVar, horizon) {
  const { omega, alpha, beta } = model.params;
  return forecastGarch({ params: { omega, alpha, beta } }, lastEps, lastVar, horizon);
}

// OGARCH (Alexander 2001): eigendecompose sample covariance, run independent
// GARCH(1,1) on each principal component, and rotate back.
function fitOgarchInner(eps1, eps2) {
  const n = eps1.length;
  const m1 = mean(eps1);
  const m2 = mean(eps2);
  let c11 = 0, c22 = 0, c12 = 0;
  for (let t = 0; t < n; t++) {
    const a = eps1[t] - m1;
    const b = eps2[t] - m2;
    c11 += a * a;
    c22 += b * b;
    c12 += a * b;
  }
  c11 /= n - 1; c22 /= n - 1; c12 /= n - 1;
  const tr = c11 + c22;
  const det = c11 * c22 - c12 * c12;
  const disc = Math.sqrt(Math.max(tr * tr / 4 - det, 0));
  const lam1 = tr / 2 + disc;
  const lam2 = tr / 2 - disc;
  let w11, w12;
  if (Math.abs(c12) > 1e-20) {
    w11 = lam1 - c22;
    w12 = c12;
  } else {
    w11 = 1; w12 = 0;
  }
  const nrm = Math.sqrt(w11 * w11 + w12 * w12);
  w11 /= nrm; w12 /= nrm;
  const w21 = -w12;
  const w22 = w11;
  const pc1 = new Array(n);
  const pc2 = new Array(n);
  for (let t = 0; t < n; t++) {
    pc1[t] = w11 * eps1[t] + w12 * eps2[t];
    pc2[t] = w21 * eps1[t] + w22 * eps2[t];
  }
  const g1 = fitUnivariateGarch11(pc1);
  const g2 = fitUnivariateGarch11(pc2);
  return { w11, w12, w21, w22, lam1, lam2, g1, g2 };
}

export function fitOgarch(eps1, eps2) {
  const pca = fitOgarchInner(eps1, eps2);
  const n = eps1.length;
  const hSpx = new Array(n);
  const hAux = new Array(n);
  const cov = new Array(n);
  const correlation = new Array(n);
  for (let t = 0; t < n; t++) {
    const h1 = pca.g1.h[t];
    const h2 = pca.g2.h[t];
    hSpx[t] = pca.w11 * pca.w11 * h1 + pca.w21 * pca.w21 * h2;
    hAux[t] = pca.w12 * pca.w12 * h1 + pca.w22 * pca.w22 * h2;
    cov[t] = pca.w11 * pca.w12 * h1 + pca.w21 * pca.w22 * h2;
    correlation[t] = cov[t] / Math.sqrt(Math.max(hSpx[t] * hAux[t], 1e-30));
  }
  const rhoForLL = new Array(n);
  for (let t = 0; t < n; t++) {
    rhoForLL[t] = correlation[t];
  }
  const logLik = bivariateGaussianLogLik(eps1, eps2, hSpx, hAux, rhoForLL);
  const k = 2 * 3 + 1;
  const params = {
    w11: pca.w11, w12: pca.w12, w21: pca.w21, w22: pca.w22,
    pc1Garch: pca.g1.params, pc2Garch: pca.g2.params,
    omega: pca.g1.params.omega, alpha: pca.g1.params.alpha, beta: pca.g1.params.beta,
  };
  return {
    name: 'OGARCH', family: 'multivariate', params,
    logLik, k, aic: 2 * k - 2 * logLik, bic: k * Math.log(n) - 2 * logLik,
    condVar: hSpx, __h22: hAux, __h12: cov, __correlation: correlation, __pca: pca,
  };
}

export function forecastOgarch(model, lastEps, lastVar, horizon) {
  const pca = model.__pca;
  const g1Last = pca.g1.h[pca.g1.h.length - 1];
  const g2Last = pca.g2.h[pca.g2.h.length - 1];
  const pc1Eps = pca.w11 * lastEps;
  const g1Fc = forecastGarch({ params: pca.g1.params }, pc1Eps, g1Last, horizon);
  const g2Omega = pca.g2.params.omega;
  const g2Alpha = pca.g2.params.alpha;
  const g2Beta = pca.g2.params.beta;
  const g2Fc = new Array(horizon);
  let prev = g2Omega + (g2Alpha + g2Beta) * g2Last;
  g2Fc[0] = prev;
  for (let k = 1; k < horizon; k++) {
    prev = g2Omega + (g2Alpha + g2Beta) * prev;
    g2Fc[k] = prev;
  }
  const path = new Array(horizon);
  for (let t = 0; t < horizon; t++) {
    path[t] = pca.w11 * pca.w11 * g1Fc.path[t] + pca.w21 * pca.w21 * g2Fc[t];
  }
  return { path, unconditional: null };
}

// --- orchestrator: fit all, blend, forecast --------------------------------

// Fit every model registered in the zoo. Returns a list of fitted models
// plus an equal-weight ensemble. Each fitter is wrapped in a try/catch so
// a single-model convergence failure doesn't kill the whole page.
export function fitAll(returns, opts = {}) {
  const { secondSeries = null } = opts;
  const { series: eps, mean: rMean } = demean(returns);
  const demeanedFitters = [
    { fn: fitGarch,         forecast: forecastGarch },
    { fn: fitIgarch,        forecast: forecastIgarch },
    { fn: fitEgarch,        forecast: forecastEgarch },
    { fn: fitGjr,           forecast: forecastGjr },
    { fn: fitTgarch,        forecast: forecastTgarch },
    { fn: fitAparch,        forecast: forecastAparch },
    { fn: fitNagarch,       forecast: forecastNagarch },
    { fn: fitNgarch,        forecast: forecastNgarch },
    { fn: fitAvgarch,       forecast: forecastAvgarch },
    { fn: fitCgarch,        forecast: forecastCgarch },
    { fn: fitGas,           forecast: forecastGas },
    { fn: fitFigarch,       forecast: forecastFigarch },
    { fn: fitHygarch,       forecast: forecastHygarch },
    { fn: fitMsGarch,       forecast: forecastMsGarch },
    { fn: fitRealizedGarch, forecast: forecastRealizedGarch },
    { fn: fitHeavy,         forecast: forecastHeavy },
  ];
  const t0 = performance.now();
  const models = [];
  const pushErr = (label, err) => {
    models.push({
      name: label, error: err.message, family: 'failed',
      params: null, condVar: null, logLik: null, bic: null,
    });
  };
  for (const { fn, forecast } of demeanedFitters) {
    try {
      const m = fn(eps);
      m.__forecast = forecast;
      models.push(m);
    } catch (err) {
      pushErr(fn.name.replace(/^fit/, ''), err);
    }
  }
  try {
    const m = fitGarchM(returns);
    m.__forecast = forecastGarchM;
    models.push(m);
  } catch (err) {
    pushErr('GARCH-M', err);
  }
  if (secondSeries && secondSeries.length === returns.length) {
    const { series: eps2 } = demean(secondSeries);
    const bivariate = [
      { fn: fitCcc,    forecast: forecastCcc,    name: 'CCC-GARCH' },
      { fn: fitDcc,    forecast: forecastDcc,    name: 'DCC-GARCH' },
      { fn: fitBekk,   forecast: forecastBekk,   name: 'BEKK(1,1)' },
      { fn: fitOgarch, forecast: forecastOgarch, name: 'OGARCH' },
    ];
    for (const { fn, forecast, name } of bivariate) {
      try {
        const m = fn(eps, eps2);
        m.__forecast = forecast;
        models.push(m);
      } catch (err) {
        pushErr(name, err);
      }
    }
  }
  const elapsedMs = performance.now() - t0;
  const ok = models.filter((m) => m.condVar != null);
  const ensemble = ok.length > 0 ? equalWeightEnsemble(ok) : null;
  return { models, ensemble, eps, returnMean: rMean, elapsedMs };
}

export function forecastAll(fitResult, horizon) {
  const { models, eps } = fitResult;
  const lastEps = eps[eps.length - 1];
  const ok = models.filter((m) => m.condVar != null);
  const perModel = ok.map((m) => {
    const lastVar = m.condVar[m.condVar.length - 1];
    const f = m.__forecast(m, lastEps, lastVar, horizon);
    return { name: m.name, family: m.family, ...f };
  });
  if (perModel.length === 0) {
    return { perModel: [], ensemble: null, sigma1d: null, sigma10d: null, sigma21d: null };
  }
  const weights = perModel.map(() => 1 / perModel.length);
  const blended = blendForecasts(perModel, weights);
  return {
    perModel,
    ensemble: blended,
    sigma1d: annualize(blended.path[0]),
    sigma10d: horizonSigma(blended.path, 10),
    sigma21d: horizonSigma(blended.path, 21),
    sigmaUnconditional: blended.unconditional != null ? annualize(blended.unconditional) : null,
  };
}
