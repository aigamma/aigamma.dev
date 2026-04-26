// src/lib/vix-models.js
//
// Pure-function math layer for the /vix lab. Every visualization on the page
// derives from this module; nothing here touches the DOM, Plotly, or fetch.
// Six families of model:
//
//   1. Distributional context — percentile rank, z-score against rolling window
//   2. Mean reversion — Ornstein-Uhlenbeck calibration on log VIX
//   3. Realized vol of VIX — annualized close-to-close on the level itself,
//      compared to the implied vol-of-vol (VVIX)
//   4. Term structure — slope, contango ratio, and curvature off the five
//      points (VIX1D / VIX9D / VIX / VIX3M / VIX6M)
//   5. Regime classification — four discrete states (calm / normal / elevated
//      / stressed) defined by long-history VIX percentiles
//   6. Strategy index analytics — log-return cumulative growth, annualized
//      return, Sharpe, max drawdown
//
// All functions accept ascending date-sorted arrays. None mutate input.

// ---------------------------------------------------------------------------
// 1. Distributional context
// ---------------------------------------------------------------------------

// Percentile rank of `value` within `series`. 0..100, inclusive on both ends.
// Uses the linear interpolation convention: count of values strictly below +
// 0.5 * count of equal values, divided by total count, then * 100. This
// matches numpy.percentileofscore(kind='mean'). Returns null on empty input.
export function percentileRank(value, series) {
  if (!Number.isFinite(value) || !series || series.length === 0) return null;
  let below = 0;
  let equal = 0;
  for (const v of series) {
    if (!Number.isFinite(v)) continue;
    if (v < value) below += 1;
    else if (v === value) equal += 1;
  }
  const total = below + equal + series.filter(
    (v) => Number.isFinite(v) && v > value,
  ).length;
  if (total === 0) return null;
  return ((below + 0.5 * equal) / total) * 100;
}

// Z-score of `value` against the trailing window of `series`. Returns null if
// the window has fewer than 2 valid observations. Used to express "VIX is N
// standard deviations above its 1-year mean" type statements.
export function zScore(value, series) {
  if (!Number.isFinite(value) || !series || series.length < 2) return null;
  const valid = series.filter((v) => Number.isFinite(v));
  if (valid.length < 2) return null;
  const mean = valid.reduce((s, v) => s + v, 0) / valid.length;
  const variance = valid.reduce((s, v) => s + (v - mean) ** 2, 0) / (valid.length - 1);
  const sd = Math.sqrt(variance);
  if (sd === 0) return null;
  return (value - mean) / sd;
}

// Rolling tail of length `n` from an ascending [{date, close}] series. Returns
// just the closes as a flat number array, suitable for percentileRank / zScore.
export function trailingCloses(series, n) {
  if (!series || series.length === 0) return [];
  const start = Math.max(0, series.length - n);
  return series.slice(start).map((p) => p.close).filter(Number.isFinite);
}

// ---------------------------------------------------------------------------
// 2. Mean reversion — Ornstein-Uhlenbeck calibration on log VIX
// ---------------------------------------------------------------------------
//
// Log-VIX has empirical OU dynamics:
//
//   d log(VIX_t) = κ (θ − log(VIX_t)) dt + σ dW_t
//
// Discrete-time OLS calibration using the AR(1) representation:
//
//   X_{t+1} = a + b · X_t + ε_t   where  X_t = log(VIX_t),  Δt = 1/252 yr
//   κ = −log(b) / Δt
//   θ = a / (1 − b)
//   σ = sd(ε) · sqrt(2 κ / (1 − b²))
//
// Returns { kappa, theta, sigma, halfLifeYears, halfLifeDays, n, valid }
// where halfLife = ln(2) / κ. theta is in log-VIX units; convert back via
// Math.exp(theta) for the long-term-mean VIX level. valid=false if regression
// fails (insufficient data, b ≥ 1 implying no mean reversion).
const TRADING_DAYS_PER_YEAR = 252;

export function calibrateOU(closes) {
  if (!Array.isArray(closes)) return { valid: false, reason: 'no input' };
  const x = closes.filter((v) => Number.isFinite(v) && v > 0).map(Math.log);
  if (x.length < 60) return { valid: false, reason: `need ≥60 obs, got ${x.length}` };

  const n = x.length - 1;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += x[i];
    sumY += x[i + 1];
    sumXY += x[i] * x[i + 1];
    sumXX += x[i] * x[i];
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  const cov = sumXY / n - meanX * meanY;
  const varX = sumXX / n - meanX * meanX;
  if (varX <= 0) return { valid: false, reason: 'zero variance' };
  const b = cov / varX;
  const a = meanY - b * meanX;

  if (b >= 1 || b <= -1) {
    return { valid: false, reason: `b=${b.toFixed(4)} (no mean reversion)` };
  }

  const dt = 1 / TRADING_DAYS_PER_YEAR;
  const kappa = -Math.log(b) / dt;
  const theta = a / (1 - b);

  // Residuals to estimate σ.
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const pred = a + b * x[i];
    const resid = x[i + 1] - pred;
    sumSq += resid * resid;
  }
  const sdEps = Math.sqrt(sumSq / n);
  const sigma = sdEps * Math.sqrt((2 * kappa) / (1 - b * b));

  const halfLifeYears = Math.log(2) / kappa;
  const halfLifeDays = halfLifeYears * TRADING_DAYS_PER_YEAR;

  return {
    valid: true,
    kappa,
    theta,
    thetaVixLevel: Math.exp(theta),
    sigma,
    halfLifeYears,
    halfLifeDays,
    n,
    b,
  };
}

// Forward expected value of an OU process given current state X0:
//   E[X_T | X_0] = θ + (X_0 − θ) · exp(−κ T)
// Returns the implied VIX level (Math.exp of the log-VIX expectation) at
// `daysAhead` trading days forward. Used for the "where will VIX be in N
// days" gauge on the mean-reversion card.
export function ouExpectedLevel({ currentLevel, kappa, theta }, daysAhead) {
  if (!(currentLevel > 0) || !Number.isFinite(kappa) || !Number.isFinite(theta)) return null;
  const T = daysAhead / TRADING_DAYS_PER_YEAR;
  const x0 = Math.log(currentLevel);
  const xT = theta + (x0 - theta) * Math.exp(-kappa * T);
  return Math.exp(xT);
}

// ---------------------------------------------------------------------------
// 3. Realized volatility of VIX (rolling, annualized)
// ---------------------------------------------------------------------------
//
// Computes annualized close-to-close realized volatility of the VIX level
// over rolling windows of `window` trading days. Same Garman-Klass-free
// estimator the rest of the site uses for simple realized vol on a single
// price series. Returns an array aligned to the input dates, with null in
// the warmup window.

export function rollingRealizedVol(series, window) {
  if (!series || series.length < window + 1) {
    return new Array(series?.length || 0).fill(null);
  }
  // Log returns first.
  const logRet = new Array(series.length).fill(null);
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1].close;
    const curr = series[i].close;
    if (Number.isFinite(prev) && Number.isFinite(curr) && prev > 0 && curr > 0) {
      logRet[i] = Math.log(curr / prev);
    }
  }
  const out = new Array(series.length).fill(null);
  for (let i = window; i < series.length; i++) {
    const slice = logRet.slice(i - window + 1, i + 1).filter(Number.isFinite);
    if (slice.length < window * 0.8) continue;
    const mean = slice.reduce((s, v) => s + v, 0) / slice.length;
    const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / (slice.length - 1);
    out[i] = Math.sqrt(variance * TRADING_DAYS_PER_YEAR) * 100;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4. Term structure metrics
// ---------------------------------------------------------------------------
//
// Given an object { VIX1D, VIX9D, VIX, VIX3M, VIX6M } of latest closes,
// returns slope (3M − 30D) / 30D, contango ratio (3M / 30D), and a curvature
// proxy (9D + 3M) / 2 − 30D. Returns null fields when any input is missing.

export function termStructureMetrics(points) {
  const v1 = points?.VIX1D;
  const v9 = points?.VIX9D;
  const v30 = points?.VIX;
  const v3m = points?.VIX3M;
  const v6m = points?.VIX6M;

  const slope = Number.isFinite(v3m) && Number.isFinite(v30) && v30 > 0
    ? (v3m - v30) / v30
    : null;

  const contangoRatio = Number.isFinite(v3m) && Number.isFinite(v30) && v30 > 0
    ? v3m / v30
    : null;

  // Curvature: positive = belly above the wings (humped), negative = bowed.
  // Computed as (V9 + V3M)/2 − VIX, so a flat or linear term structure
  // returns ≈ 0.
  const curvature = Number.isFinite(v9) && Number.isFinite(v3m) && Number.isFinite(v30)
    ? (v9 + v3m) / 2 - v30
    : null;

  // Front-to-spot ratio captures urgency at the very front of the curve;
  // VIX1D < VIX is normal, VIX1D > VIX flags imminent event-day repricing.
  const frontRatio = Number.isFinite(v1) && Number.isFinite(v30) && v30 > 0
    ? v1 / v30
    : null;

  return { slope, contangoRatio, curvature, frontRatio };
}

// Compute the contango ratio (VIX3M / VIX) for every date where both series
// have a value. Returns [{date, ratio}]. Used by the historical-contango chart.
export function termStructureRatioHistory(vixSeries, vix3mSeries) {
  if (!vixSeries || !vix3mSeries) return [];
  const v3mByDate = new Map(vix3mSeries.map((p) => [p.date, p.close]));
  const out = [];
  for (const p of vixSeries) {
    const v3m = v3mByDate.get(p.date);
    if (Number.isFinite(p.close) && Number.isFinite(v3m) && p.close > 0) {
      out.push({ date: p.date, ratio: v3m / p.close });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 5. Regime classification (four discrete states by VIX level)
// ---------------------------------------------------------------------------
//
// Pre-empirical thresholds calibrated against the 30-year VIX historical
// distribution: 12 / 18 / 30 maps roughly to the 30th / 60th / 90th
// percentiles of all daily closes since 1990. This is a documented industry
// convention (Cboe's own VIX research papers and any major prop desk's vol
// regime model uses similar cuts), not a value pulled from this page's
// 3-year backfill — short-window thresholds would shift every market cycle.

export const VIX_REGIME_THRESHOLDS = { calm: 12, normal: 18, elevated: 30 };

export function classifyRegime(vixLevel) {
  if (!Number.isFinite(vixLevel)) return null;
  if (vixLevel < VIX_REGIME_THRESHOLDS.calm) return 'calm';
  if (vixLevel < VIX_REGIME_THRESHOLDS.normal) return 'normal';
  if (vixLevel < VIX_REGIME_THRESHOLDS.elevated) return 'elevated';
  return 'stressed';
}

// Walk the daily series and tally days per regime. Returns
// { calm: n, normal: n, elevated: n, stressed: n, total: n }.
export function regimeDistribution(vixSeries) {
  const tally = { calm: 0, normal: 0, elevated: 0, stressed: 0, total: 0 };
  for (const p of vixSeries) {
    const r = classifyRegime(p.close);
    if (!r) continue;
    tally[r] += 1;
    tally.total += 1;
  }
  return tally;
}

// Empirical transition matrix between the four regimes. Returns
// transitions[from][to] = probability. Useful for "if we're in NORMAL today,
// what is the probability we're in STRESSED in 5 days" type forecasts.
export function regimeTransitions(vixSeries, lag = 1) {
  const states = vixSeries.map((p) => classifyRegime(p.close)).filter(Boolean);
  const labels = ['calm', 'normal', 'elevated', 'stressed'];
  const counts = {};
  for (const f of labels) {
    counts[f] = {};
    for (const t of labels) counts[f][t] = 0;
  }
  for (let i = 0; i < states.length - lag; i++) {
    counts[states[i]][states[i + lag]] += 1;
  }
  const probs = {};
  for (const f of labels) {
    probs[f] = {};
    const rowTotal = labels.reduce((s, t) => s + counts[f][t], 0);
    for (const t of labels) {
      probs[f][t] = rowTotal > 0 ? counts[f][t] / rowTotal : 0;
    }
  }
  return probs;
}

// ---------------------------------------------------------------------------
// 6. Strategy index analytics — cumulative growth, Sharpe, drawdown
// ---------------------------------------------------------------------------

// Convert a [{date, close}] series into a cumulative-growth-of-1 series
// indexed at the first valid close. Returns [{date, growth, ret}] where
// `growth` starts at 1.0 and `ret` is the daily log return.
export function cumulativeGrowth(series) {
  if (!series || series.length === 0) return [];
  const first = series.find((p) => Number.isFinite(p.close) && p.close > 0);
  if (!first) return [];
  const base = first.close;
  return series
    .filter((p) => Number.isFinite(p.close) && p.close > 0)
    .map((p, i, arr) => {
      const ret = i > 0 ? Math.log(p.close / arr[i - 1].close) : 0;
      return { date: p.date, growth: p.close / base, ret };
    });
}

// Annualized log-return mean and Sharpe ratio (rf = 0). Returns
// { annReturn, annVol, sharpe }. Computed on log returns so multiperiod
// compounding lines up with the cumulative-growth chart.
export function annualizedStats(growthSeries, riskFreeRate = 0) {
  if (!growthSeries || growthSeries.length < 2) {
    return { annReturn: null, annVol: null, sharpe: null };
  }
  const rets = growthSeries.slice(1).map((p) => p.ret).filter(Number.isFinite);
  if (rets.length < 2) return { annReturn: null, annVol: null, sharpe: null };
  const mean = rets.reduce((s, v) => s + v, 0) / rets.length;
  const variance = rets.reduce((s, v) => s + (v - mean) ** 2, 0) / (rets.length - 1);
  const sd = Math.sqrt(variance);
  const annReturn = mean * TRADING_DAYS_PER_YEAR;
  const annVol = sd * Math.sqrt(TRADING_DAYS_PER_YEAR);
  const sharpe = annVol > 0 ? (annReturn - riskFreeRate) / annVol : null;
  return { annReturn, annVol, sharpe };
}

// Maximum peak-to-trough drawdown of a growth series, as a positive fraction
// (0.20 = -20% drawdown). Returns { maxDd, peakDate, troughDate }.
export function maxDrawdown(growthSeries) {
  if (!growthSeries || growthSeries.length === 0) {
    return { maxDd: null, peakDate: null, troughDate: null };
  }
  let peak = -Infinity;
  let peakDate = null;
  let maxDd = 0;
  let ddPeakDate = null;
  let troughDate = null;
  for (const p of growthSeries) {
    if (!Number.isFinite(p.growth)) continue;
    if (p.growth > peak) {
      peak = p.growth;
      peakDate = p.date;
    }
    const dd = (peak - p.growth) / peak;
    if (dd > maxDd) {
      maxDd = dd;
      ddPeakDate = peakDate;
      troughDate = p.date;
    }
  }
  return { maxDd, peakDate: ddPeakDate, troughDate };
}
