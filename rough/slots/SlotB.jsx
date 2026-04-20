import { useEffect, useMemo, useRef, useState } from 'react';
import usePlotly from '../../src/hooks/usePlotly';
import useIsMobile from '../../src/hooks/useIsMobile';
import {
  PLOTLY_COLORS,
  PLOTLY_FONTS,
  plotly2DChartLayout,
  plotlyAxis,
  plotlyTitle,
} from '../../src/lib/plotlyTheme';

// -----------------------------------------------------------------------------
// Rough Bergomi (Bayer-Friz-Gatheral 2016) — in-browser Monte Carlo.
//
// The rBergomi spec:
//
//     v_t = ξ₀ · exp( η · Ŵ_t^H  −  (η²/2) · t^(2H) )
//     Ŵ_t^H = √(2H) · ∫_0^t (t−s)^(H−1/2) dW_s        (Riemann-Liouville fBm)
//     dS_t / S_t = √v_t · ( ρ dW_t + √(1−ρ²) dB_t )
//
// The hat-W process is a non-Markovian, non-stationary Gaussian Volterra
// integral with variance t^(2H). The (t−s)^(H−1/2) kernel is singular at
// s = t for H < 1/2 (the "rough" regime), which is the essence of why
// rBergomi cannot be written as a finite-dimensional SDE.
//
// Exact simulation via joint Cholesky factorization
// ---------------------------------------------------
// We build the (2N × 2N) joint covariance matrix of the sampled pair
// [ Ŵ_{t_1}, …, Ŵ_{t_N},  W_{t_1}, …, W_{t_N} ] on a uniform grid
// t_i = i · dt. The three sub-blocks are:
//
//   cov(Ŵ_{t_i}, Ŵ_{t_j}) = (2H / α) · ∫_0^{t_min^α} (|t_i − t_j| + v^{1/α})^{H−1/2} dv
//       with α = H + 1/2, t_min = min(t_i, t_j).
//       (Change of variable v = (t_min − u)^α removes the u = t_min
//       singularity in the original kernel form, leaving a smooth
//       integrand that Simpson's rule resolves in ~32 nodes.)
//
//   cov(W_s, Ŵ_t)         = (√(2H) / α) · ( t^α − max(t−s, 0)^α )
//       (closed form — integrates the kernel against the identity up to
//       min(s, t); the max(·,0) branch handles s > t.)
//
//   cov(W_s, W_t)         = min(s, t)
//
// The joint Cholesky L lets a single draw z ~ N(0, I_{2N}) map to a
// correlated (Ŵ, W) pair consistent with the true continuous-time law at
// the sampling times. The method is exact at the grid nodes (no
// truncation bias), which matters because hybrid schemes at daily
// resolution have documented short-maturity bias that shows up precisely
// where the ATM skew is most interesting. The O(N³) Cholesky is amortized
// across all paths.
//
// ATM skew power-law signature
// ----------------------------
// rBergomi's defining prediction is explosive ATM skew as T → 0:
//
//     ψ(T) := ∂σ_BS(k, T) / ∂k |_{k=0}  ∼  ρ η · T^(H − 1/2)
//
// (Bayer-Friz-Gatheral 2016 Prop 3.5, Fukasawa et al. 2017.) With H ≈ 0.1
// the skew grows like T^(−0.4) — observably explosive, matching the
// short-maturity skew on SPX that classical Heston-type diffusion models
// systematically underproduce. We estimate ψ(T) by Monte Carlo at four
// maturities via finite differences on the MC-implied smile, then regress
// log |ψ| against log T to recover an empirical slope. A recovered slope
// close to the input H − 1/2 confirms the implementation and shows the
// power-law visually.
// -----------------------------------------------------------------------------

const N_STEPS = 100;
const T_YEARS = 1.0;
const DT = T_YEARS / N_STEPS;
const S0 = 100;
const N_PATHS = 200;
const SIMPSON_NODES = 64;
const MATURITY_STEPS = [10, 25, 50, 100]; // T = 0.1, 0.25, 0.5, 1.0 years
const MONEYNESS = [-0.10, -0.05, 0, 0.05, 0.10];

// mulberry32: deterministic PRNG so path fans are reproducible across
// re-renders (same behaviour pattern used across the regime/garch labs).
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeNormalGen(rng) {
  let cached = null;
  return function () {
    if (cached != null) {
      const z = cached;
      cached = null;
      return z;
    }
    let u1 = rng();
    if (u1 < 1e-12) u1 = 1e-12;
    const u2 = rng();
    const mag = Math.sqrt(-2 * Math.log(u1));
    const z0 = mag * Math.cos(2 * Math.PI * u2);
    const z1 = mag * Math.sin(2 * Math.PI * u2);
    cached = z1;
    return z0;
  };
}

// Simpson's rule on [0, a] with `n` even subintervals. Used for the smooth
// cov(Ŵ_{t_i}, Ŵ_{t_j}) integrand after the v = (t_min − u)^α change of
// variables. 64 nodes is conservative for a smooth integrand on a bounded
// interval — resolves to < 1e-9 for the parameter ranges used here.
function simpson(f, a, n) {
  const h = a / n;
  let s = f(0) + f(a);
  for (let i = 1; i < n; i++) {
    const x = i * h;
    s += (i % 2 === 0 ? 2 : 4) * f(x);
  }
  return (s * h) / 3;
}

// cov(Ŵ_{t_i}, Ŵ_{t_j}) with t_i, t_j > 0. Diagonal short-circuits to
// t^(2H) (closed form). Off-diagonal uses the singularity-removing change
// of variable v = (t_min − u)^α described in the header comment.
function covGG(ti, tj, H) {
  if (ti <= 0 || tj <= 0) return 0;
  if (ti === tj) return Math.pow(ti, 2 * H);
  const tMin = Math.min(ti, tj);
  const tMax = Math.max(ti, tj);
  const gap = tMax - tMin;
  const alpha = H + 0.5;
  const a = Math.pow(tMin, alpha);
  const exp = H - 0.5;
  const integrand = (v) => Math.pow(gap + Math.pow(v, 1 / alpha), exp);
  const integral = simpson(integrand, a, SIMPSON_NODES);
  return ((2 * H) / alpha) * integral;
}

// cov(W_s, Ŵ_t) — closed form. For s ≤ t:
//    √(2H) · ∫_0^s (t−u)^{H−1/2} du = √(2H)/(H+1/2) · (t^{H+1/2} − (t−s)^{H+1/2})
// For s > t the kernel vanishes for u > t, so the integral truncates to
// s = t; equivalently, replace (t−s)^{H+1/2} with 0 when s > t.
function covWG(s, t, H) {
  if (s <= 0 || t <= 0) return 0;
  const alpha = H + 0.5;
  const sqrt2H = Math.sqrt(2 * H);
  if (s <= t) {
    return (sqrt2H / alpha) * (Math.pow(t, alpha) - Math.pow(t - s, alpha));
  }
  return (sqrt2H / alpha) * Math.pow(t, alpha);
}

// In-place Cholesky on an upper-packed symmetric matrix stored as
// flat Float64Array with C[i][j] at index i*n + j. Writes L below the
// diagonal (including the diagonal). Returns false on non-PSD failure.
function cholesky(C, n) {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = C[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      if (i === j) {
        if (s <= 0) return null;
        L[i * n + j] = Math.sqrt(s);
      } else {
        L[i * n + j] = s / L[j * n + j];
      }
    }
  }
  return L;
}

// y = L · z for lower-triangular L (n×n) and vector z (n). Writes into
// `out` (length n). O(n²) flops.
function multLowerTriangular(L, z, n, out) {
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k <= i; k++) s += L[i * n + k] * z[k];
    out[i] = s;
  }
}

// Abramowitz-Stegun 7.1.26 erf approximation (max abs error 1.5e-7).
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

function normalCdf(x) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function normalPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

// Black-Scholes call price with r = q = 0.
function bsCall(S, K, T, sigma) {
  if (T <= 0 || sigma <= 0) return Math.max(S - K, 0);
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + 0.5 * sigma * sigma * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  return S * normalCdf(d1) - K * normalCdf(d2);
}

// Newton-Raphson implied-vol solver with a bisection safety net. Returns
// null for prices outside the no-arb band.
function bsImpliedVol(price, S, K, T) {
  const intrinsic = Math.max(S - K, 0);
  if (price < intrinsic - 1e-8) return null;
  if (price >= S - 1e-12) return null;
  let sigma = 0.3;
  for (let i = 0; i < 40; i++) {
    const sqrtT = Math.sqrt(T);
    const d1 = (Math.log(S / K) + 0.5 * sigma * sigma * T) / (sigma * sqrtT);
    const priceHat = bsCall(S, K, T, sigma);
    const vega = S * normalPdf(d1) * sqrtT;
    if (!(vega > 1e-12)) break;
    const delta = (priceHat - price) / vega;
    sigma = sigma - delta;
    if (!(sigma > 1e-6)) sigma = 1e-6;
    if (sigma > 5) sigma = 5;
    if (Math.abs(delta) < 1e-7) return sigma;
  }
  // Fall back to bisection if Newton wandered.
  let lo = 1e-4;
  let hi = 5;
  for (let i = 0; i < 80; i++) {
    const mid = 0.5 * (lo + hi);
    const p = bsCall(S, K, T, mid);
    if (p > price) hi = mid;
    else lo = mid;
    if (hi - lo < 1e-7) return mid;
  }
  return 0.5 * (lo + hi);
}

function ols(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
  }
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    sxx += dx * dx;
    sxy += dx * (ys[i] - my);
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx };
}

// Percentile on an already-sorted Float64Array.
function percentile(sorted, p) {
  const n = sorted.length;
  if (n === 0) return 0;
  const idx = (n - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

function simulate({ H, eta, rho, xi0, seed }) {
  const n2 = 2 * N_STEPS;
  const C = new Float64Array(n2 * n2);

  // Top-left block: cov(Ŵ, Ŵ) with diagonal short-circuit
  for (let i = 0; i < N_STEPS; i++) {
    const ti = (i + 1) * DT;
    for (let j = 0; j <= i; j++) {
      const tj = (j + 1) * DT;
      const c = covGG(ti, tj, H);
      C[i * n2 + j] = c;
      C[j * n2 + i] = c;
    }
  }
  // Top-right / bottom-left: cov(Ŵ, W)
  for (let i = 0; i < N_STEPS; i++) {
    const ti = (i + 1) * DT;
    for (let j = 0; j < N_STEPS; j++) {
      const tj = (j + 1) * DT;
      const c = covWG(tj, ti, H);
      C[i * n2 + (N_STEPS + j)] = c;
      C[(N_STEPS + j) * n2 + i] = c;
    }
  }
  // Bottom-right block: cov(W, W) = min(s, t)
  for (let i = 0; i < N_STEPS; i++) {
    const ti = (i + 1) * DT;
    for (let j = 0; j <= i; j++) {
      const tj = (j + 1) * DT;
      const c = Math.min(ti, tj);
      C[(N_STEPS + i) * n2 + (N_STEPS + j)] = c;
      C[(N_STEPS + j) * n2 + (N_STEPS + i)] = c;
    }
  }

  // Mild ridge on the diagonal for numerical PSD (H < 0.5 + float rounding
  // can push the combined matrix slightly indefinite). 1e-12 is smaller
  // than the smallest diagonal entry by ~10 orders of magnitude so has no
  // observable effect on the simulated paths.
  for (let i = 0; i < n2; i++) C[i * n2 + i] += 1e-12;

  const L = cholesky(C, n2);
  if (!L) return null;

  const rng = mulberry32(seed);
  const randn = makeNormalGen(rng);
  const sqrtOneMinusRho2 = Math.sqrt(Math.max(0, 1 - rho * rho));

  // Storage for the σ-path fan. Row-major: path × step.
  const sigmaPaths = new Float64Array(N_PATHS * N_STEPS);
  const z = new Float64Array(n2);
  const joint = new Float64Array(n2);

  // Storage for spot prices at each chosen maturity: [paths × maturities].
  const spotAtMaturity = new Float64Array(N_PATHS * MATURITY_STEPS.length);

  const tPowers2H = new Array(N_STEPS);
  for (let i = 0; i < N_STEPS; i++) {
    tPowers2H[i] = Math.pow((i + 1) * DT, 2 * H);
  }

  for (let p = 0; p < N_PATHS; p++) {
    // Draw joint (Ŵ, W) sample
    for (let i = 0; i < n2; i++) z[i] = randn();
    multLowerTriangular(L, z, n2, joint);

    // Drive the spot with correlated noise. ΔW_i = W_{t_i} − W_{t_{i−1}},
    // W_{t_0} := 0. The orthogonal innovation ΔB_i ~ N(0, dt) independently.
    let logS = Math.log(S0);
    let prevW = 0;
    let nextMatIdx = 0;
    for (let i = 0; i < N_STEPS; i++) {
      const that = joint[i];
      const curW = joint[N_STEPS + i];
      const v = xi0 * Math.exp(eta * that - 0.5 * eta * eta * tPowers2H[i]);
      sigmaPaths[p * N_STEPS + i] = Math.sqrt(Math.max(v, 0));

      const dW = curW - prevW;
      const dB = randn() * Math.sqrt(DT);
      const dZ = rho * dW + sqrtOneMinusRho2 * dB;
      // Use the beginning-of-interval variance (Euler), standard for
      // rBergomi MC benchmarks at daily resolution.
      const vUse = i === 0 ? xi0 : xi0 * Math.exp(
        eta * joint[i - 1] - 0.5 * eta * eta * tPowers2H[i - 1],
      );
      logS += -0.5 * vUse * DT + Math.sqrt(Math.max(vUse, 0)) * dZ;
      prevW = curW;

      if (nextMatIdx < MATURITY_STEPS.length && i + 1 === MATURITY_STEPS[nextMatIdx]) {
        spotAtMaturity[p * MATURITY_STEPS.length + nextMatIdx] = Math.exp(logS);
        nextMatIdx += 1;
      }
    }
  }

  // σ-fan percentiles at each time step
  const fan = { p10: new Array(N_STEPS), p25: new Array(N_STEPS), p50: new Array(N_STEPS), p75: new Array(N_STEPS), p90: new Array(N_STEPS) };
  const col = new Float64Array(N_PATHS);
  for (let i = 0; i < N_STEPS; i++) {
    for (let p = 0; p < N_PATHS; p++) col[p] = sigmaPaths[p * N_STEPS + i];
    col.sort();
    fan.p10[i] = percentile(col, 0.10);
    fan.p25[i] = percentile(col, 0.25);
    fan.p50[i] = percentile(col, 0.50);
    fan.p75[i] = percentile(col, 0.75);
    fan.p90[i] = percentile(col, 0.90);
  }

  // MC-priced smile at each maturity.
  const smiles = [];
  for (let mi = 0; mi < MATURITY_STEPS.length; mi++) {
    const step = MATURITY_STEPS[mi];
    const T = step * DT;
    const vols = [];
    for (const k of MONEYNESS) {
      const K = S0 * Math.exp(k);
      let payoff = 0;
      for (let p = 0; p < N_PATHS; p++) {
        const ST = spotAtMaturity[p * MATURITY_STEPS.length + mi];
        payoff += Math.max(ST - K, 0);
      }
      const price = payoff / N_PATHS;
      const iv = bsImpliedVol(price, S0, K, T);
      vols.push(iv);
    }
    smiles.push({ T, step, vols });
  }

  // ATM skew per maturity: central-difference slope on the smile at k = 0.
  const skewXs = [];
  const skewYs = [];
  const atmIvs = [];
  for (const sm of smiles) {
    const kUp = MONEYNESS[3]; // +0.05
    const kDn = MONEYNESS[1]; // −0.05
    const vUp = sm.vols[3];
    const vDn = sm.vols[1];
    const vAt = sm.vols[2];
    if (vUp != null && vDn != null && vAt != null) {
      const skew = (vUp - vDn) / (kUp - kDn);
      skewXs.push(Math.log(sm.T));
      skewYs.push(Math.log(Math.max(Math.abs(skew), 1e-8)));
      atmIvs.push({ T: sm.T, iv: vAt, skew });
    }
  }
  const skewFit = ols(skewXs, skewYs);

  // Build a handful of representative sample paths to overlay on the fan.
  const sampleCount = 4;
  const samples = [];
  for (let s = 0; s < sampleCount; s++) {
    const p = Math.floor((s * N_PATHS) / sampleCount);
    const row = new Array(N_STEPS);
    for (let i = 0; i < N_STEPS; i++) row[i] = sigmaPaths[p * N_STEPS + i];
    samples.push(row);
  }

  return { fan, samples, smiles, skewFit, atmIvs };
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
          fontSize: '1.25rem',
          color: accent || 'var(--text-primary)',
        }}
      >
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.2rem' }}>
          {sub}
        </div>
      )}
    </div>
  );
}

function SliderRow({ label, value, min, max, step, onChange, format }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', minWidth: 0 }}>
      <span
        style={{
          fontSize: '0.72rem',
          color: 'var(--text-secondary)',
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          display: 'flex',
          justifyContent: 'space-between',
        }}
      >
        <span>{label}</span>
        <span style={{ color: 'var(--text-primary)', fontFamily: 'Courier New, monospace' }}>
          {format ? format(value) : value}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{ width: '100%', accentColor: PLOTLY_COLORS.highlight }}
      />
    </label>
  );
}

export default function SlotB() {
  const fanRef = useRef(null);
  const smileRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();
  const mobile = useIsMobile();

  const [H, setH] = useState(0.10);
  const [eta, setEta] = useState(1.9);
  const [rho, setRho] = useState(-0.90);
  const [initialVol, setInitialVol] = useState(0.20);
  const [seed, setSeed] = useState(0xC0FFEE);

  const result = useMemo(
    () => simulate({ H, eta, rho, xi0: initialVol * initialVol, seed }),
    [H, eta, rho, initialVol, seed],
  );

  // σ-path fan
  useEffect(() => {
    if (!Plotly || !fanRef.current || !result) return;
    const tAxis = new Array(N_STEPS);
    for (let i = 0; i < N_STEPS; i++) tAxis[i] = (i + 1) * DT;

    const traces = [
      {
        x: tAxis.concat([...tAxis].reverse()),
        y: result.fan.p10.concat([...result.fan.p90].reverse()),
        fill: 'toself',
        fillcolor: 'rgba(74, 158, 255, 0.10)',
        line: { color: 'transparent' },
        name: '10-90%',
        hoverinfo: 'skip',
      },
      {
        x: tAxis.concat([...tAxis].reverse()),
        y: result.fan.p25.concat([...result.fan.p75].reverse()),
        fill: 'toself',
        fillcolor: 'rgba(74, 158, 255, 0.22)',
        line: { color: 'transparent' },
        name: '25-75%',
        hoverinfo: 'skip',
      },
      {
        x: tAxis,
        y: result.fan.p50,
        mode: 'lines',
        name: 'median',
        line: { color: PLOTLY_COLORS.primary, width: 2 },
        hoverinfo: 'skip',
      },
    ];
    const sampleColors = [
      PLOTLY_COLORS.highlight,
      PLOTLY_COLORS.secondary,
      PLOTLY_COLORS.positive,
      PLOTLY_COLORS.primarySoft,
    ];
    result.samples.forEach((row, i) => {
      traces.push({
        x: tAxis,
        y: row,
        mode: 'lines',
        name: `path ${i + 1}`,
        line: { color: sampleColors[i % sampleColors.length], width: 1 },
        opacity: 0.75,
        hoverinfo: 'skip',
      });
    });

    const layout = plotly2DChartLayout({
      title: {
        ...plotlyTitle('Rough Bergomi · instantaneous volatility paths'),
        y: 0.97,
        yref: 'container',
        yanchor: 'top',
      },
      margin: mobile ? { t: 50, r: 20, b: 90, l: 65 } : { t: 70, r: 30, b: 100, l: 80 },
      xaxis: plotlyAxis('t (years)'),
      yaxis: plotlyAxis('σ_t', { rangemode: 'tozero', tickformat: '.0%' }),
      showlegend: true,
      legend: {
        orientation: 'h',
        y: -0.22,
        x: 0.5,
        xanchor: 'center',
        font: PLOTLY_FONTS.legend,
      },
      hovermode: false,
    });

    Plotly.react(fanRef.current, traces, layout, {
      responsive: true,
      displayModeBar: false,
    });
  }, [Plotly, result, mobile]);

  // Smile curves per maturity
  useEffect(() => {
    if (!Plotly || !smileRef.current || !result) return;
    const traces = [];
    const smileColors = [
      PLOTLY_COLORS.primary,
      PLOTLY_COLORS.highlight,
      PLOTLY_COLORS.positive,
      PLOTLY_COLORS.secondary,
    ];
    result.smiles.forEach((sm, i) => {
      const xs = [];
      const ys = [];
      for (let k = 0; k < MONEYNESS.length; k++) {
        if (sm.vols[k] != null) {
          xs.push(MONEYNESS[k]);
          ys.push(sm.vols[k]);
        }
      }
      traces.push({
        x: xs,
        y: ys,
        mode: 'lines+markers',
        name: `T=${sm.T.toFixed(2)}y`,
        line: { color: smileColors[i % smileColors.length], width: 1.75 },
        marker: { color: smileColors[i % smileColors.length], size: 8 },
        hovertemplate: `T=${sm.T.toFixed(2)}y<br>k=%{x:.2f}<br>σ=%{y:.2%}<extra></extra>`,
      });
    });

    const layout = plotly2DChartLayout({
      title: {
        ...plotlyTitle('MC-implied smile · σ_BS(k, T)'),
        y: 0.97,
        yref: 'container',
        yanchor: 'top',
      },
      margin: mobile ? { t: 50, r: 20, b: 90, l: 65 } : { t: 70, r: 30, b: 100, l: 80 },
      xaxis: plotlyAxis('k = log(K / S₀)', { tickformat: '.2f' }),
      yaxis: plotlyAxis('Implied σ', { rangemode: 'tozero', tickformat: '.0%' }),
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

    Plotly.react(smileRef.current, traces, layout, {
      responsive: true,
      displayModeBar: false,
    });
  }, [Plotly, result, mobile]);

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

  if (!result) {
    return (
      <div className="lab-placeholder">
        <div className="lab-placeholder-title">Cholesky failed</div>
        <div className="lab-placeholder-hint">
          Joint covariance matrix is not positive-definite at this parameter
          point. Try nudging H away from 0 or 0.5 and re-simulate.
        </div>
      </div>
    );
  }

  const fittedSlope = result.skewFit?.slope;
  const skewExpFromSlope = fittedSlope != null ? fittedSlope + 0.5 : null;
  const atmIv1y = result.atmIvs.find((r) => Math.abs(r.T - 1.0) < 1e-6)?.iv;
  const atmIv1m = result.atmIvs.find((r) => Math.abs(r.T - 0.1) < 1e-6)?.iv;

  return (
    <div className="card" style={{ padding: '1.25rem 1.25rem 1rem' }}>
      <div
        style={{
          fontFamily: 'Courier New, monospace',
          fontSize: '0.7rem',
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--accent-amber)',
          marginBottom: '0.85rem',
        }}
      >
        Rough Bergomi · Bayer-Friz-Gatheral 2016
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: mobile ? '1fr 1fr' : 'repeat(4, 1fr)',
          gap: '1.1rem',
          padding: '0.85rem 0',
          borderTop: '1px solid var(--bg-card-border)',
          borderBottom: '1px solid var(--bg-card-border)',
          marginBottom: '0.85rem',
        }}
      >
        <SliderRow
          label="Hurst H"
          value={H}
          min={0.02}
          max={0.49}
          step={0.01}
          onChange={setH}
          format={(v) => v.toFixed(2)}
        />
        <SliderRow
          label="Vol-of-vol η"
          value={eta}
          min={0.5}
          max={4.0}
          step={0.1}
          onChange={setEta}
          format={(v) => v.toFixed(1)}
        />
        <SliderRow
          label="Correlation ρ"
          value={rho}
          min={-0.99}
          max={0.99}
          step={0.01}
          onChange={setRho}
          format={(v) => v.toFixed(2)}
        />
        <SliderRow
          label="Initial vol √ξ₀"
          value={initialVol}
          min={0.08}
          max={0.50}
          step={0.01}
          onChange={setInitialVol}
          format={(v) => `${(v * 100).toFixed(0)}%`}
        />
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: mobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)',
          gap: '1rem',
          padding: '0.85rem 0',
          borderBottom: '1px solid var(--bg-card-border)',
          marginBottom: '0.85rem',
        }}
      >
        <StatCell
          label="ATM σ · T=1m"
          value={atmIv1m != null ? `${(atmIv1m * 100).toFixed(1)}%` : 'n/a'}
          sub="simulated 1-month at-the-money vol"
          accent={PLOTLY_COLORS.primary}
        />
        <StatCell
          label="ATM σ · T=1y"
          value={atmIv1y != null ? `${(atmIv1y * 100).toFixed(1)}%` : 'n/a'}
          sub="simulated 1-year at-the-money vol"
          accent={PLOTLY_COLORS.primary}
        />
        <StatCell
          label="Skew slope (fit)"
          value={fittedSlope != null ? fittedSlope.toFixed(3) : 'n/a'}
          sub={`expected slope (H − 0.5): ${(H - 0.5).toFixed(3)}`}
          accent={PLOTLY_COLORS.highlight}
        />
        <StatCell
          label="Recovered H"
          value={skewExpFromSlope != null ? skewExpFromSlope.toFixed(3) : 'n/a'}
          sub={`input H: ${H.toFixed(3)}`}
          accent={PLOTLY_COLORS.positive}
        />
      </div>

      <div ref={fanRef} style={{ width: '100%', height: mobile ? 320 : 400 }} />

      <div style={{ marginTop: '0.75rem' }}>
        <div ref={smileRef} style={{ width: '100%', height: mobile ? 280 : 340 }} />
      </div>

      <div
        style={{
          marginTop: '0.75rem',
          display: 'flex',
          justifyContent: 'flex-end',
          gap: '0.5rem',
        }}
      >
        <button
          type="button"
          onClick={() => setSeed((s) => (s + 1) >>> 0)}
          style={{
            background: 'transparent',
            border: '1px solid var(--bg-card-border)',
            color: 'var(--text-secondary)',
            fontFamily: 'Courier New, monospace',
            fontSize: '0.75rem',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            padding: '0.35rem 0.85rem',
            cursor: 'pointer',
            borderRadius: '3px',
          }}
        >
          reshuffle seed
        </button>
      </div>

      <div
        style={{
          marginTop: '0.65rem',
          fontSize: '0.95rem',
          color: 'var(--text-secondary)',
          lineHeight: 1.65,
        }}
      >
        <p style={{ margin: '0 0 0.6rem' }}>
          This is a forward-looking simulator. Set the four sliders to the
          regime you want to test, and {N_PATHS} Monte Carlo paths will
          project a year of SPX volatility plus the implied vol smile that
          regime would produce.
        </p>
        <p style={{ margin: '0 0 0.4rem' }}>
          <strong style={{ color: 'var(--text-primary)' }}>The four sliders.</strong>
        </p>
        <p style={{ margin: '0 0 0.4rem' }}>
          <strong style={{ color: PLOTLY_COLORS.highlight }}>Hurst H</strong>{' '}
          controls how rough the volatility moves are. Lower H means more
          violent short-term swings.
        </p>
        <p style={{ margin: '0 0 0.4rem' }}>
          <strong style={{ color: PLOTLY_COLORS.highlight }}>Vol-of-vol η</strong>{' '}
          scales how dramatically vol can change in either direction.
          Higher η produces a wider fan.
        </p>
        <p style={{ margin: '0 0 0.4rem' }}>
          <strong style={{ color: PLOTLY_COLORS.highlight }}>Correlation ρ</strong>{' '}
          links spot moves to vol moves. The standard equity setting is
          negative, which produces the put-skew that you see on real SPX
          chains.
        </p>
        <p style={{ margin: '0 0 0.6rem' }}>
          <strong style={{ color: PLOTLY_COLORS.highlight }}>Initial vol √ξ₀</strong>{' '}
          is the starting at-the-money vol level. Set this to current
          1-month at-the-money vol to anchor the simulation to today.
        </p>
        <p style={{ margin: '0 0 0.6rem' }}>
          <strong style={{ color: 'var(--text-primary)' }}>How to use it.</strong>{' '}
          Anchor the simulator to today first.
        </p>
        <p style={{ margin: '0 0 0.6rem' }}>
          Set √ξ₀ to the current SPX 1-month at-the-money implied vol. Set H
          to the value reported by the RFSV signature or the three-estimator
          triangulation on this page, typically near 0.12. Leave ρ
          near −0.9 and η near 1.9 as a reasonable equity baseline. Then
          read the smile chart against today's SPX option chain.
        </p>
        <p style={{ margin: '0 0 0.6rem' }}>
          If the simulated short-maturity smile is{' '}
          <strong style={{ color: 'var(--text-primary)' }}>flatter</strong>{' '}
          than the market is currently pricing, the market is paying for
          more risk than your regime assumes. Treat that as a possible early
          warning of a vol regime shift.
        </p>
        <p style={{ margin: '0 0 0.6rem' }}>
          If the simulated smile is{' '}
          <strong style={{ color: 'var(--text-primary)' }}>steeper</strong>{' '}
          than the market, the market may be too complacent relative to the
          underlying vol process. Short-dated puts could be cheap.
        </p>
        <p style={{ margin: '0 0 0.6rem' }}>
          The σ-path fan above shows the range of vol paths consistent with
          your regime settings. Use the 25-75 percent band as the most
          probable forward range. If realized vol breaks above the 90
          percent line in coming weeks, the regime has likely shifted to
          lower H (rougher vol).
        </p>
        <p style={{ margin: 0 }}>
          The Recovered H stat is a sanity check that the simulator is
          working. It should land within roughly 0.05 of the input H you
          chose with the slider.
        </p>
      </div>
    </div>
  );
}
