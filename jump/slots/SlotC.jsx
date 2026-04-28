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
// Bates (1996) SVJ. Heston stochastic variance, plus Merton-style
// log-normal jumps in the spot:
//
//   dS/S = (r − q − λ·k)·dt + √v·dW₁ + (Y − 1)·dN
//   dv   = κ(θ − v)·dt + ξ·√v·dW₂
//   d⟨W₁,W₂⟩ = ρ·dt
//   ln Y ~ N(μ_J, σ_J²),  k = E[Y − 1] = exp(μ_J + σ_J²/2) − 1
//
// Eight parameters under the risk-neutral measure: the five Heston
// parameters (κ, θ, ξ, ρ, v₀) plus the three Merton jump parameters
// (λ, μ_J, σ_J). The characteristic function factorizes as the
// Heston CF multiplied by an additive jump term in the exponent:
//
//   φ_Bates(u; T) = φ_Heston(u; T) · exp[ λT · (e^(i·u·μ_J − 0.5·u²·σ_J²) − 1 − i·u·k) ]
//
// Pricing uses the Lewis (2001) single-integral inversion. The
// jump component closes the empirical short-tenor skew gap that pure
// Heston cannot match. Heston needs the diffusion correlation ρ to
// produce skew, but the diffusive skew vanishes as T → 0 because
// every diffusion path is locally Gaussian. Adding a finite-activity
// jump preserves skew at short tenor because jumps are not Gaussian
// even instantaneously.
// -----------------------------------------------------------------------------

const RATE_R = 0.045;
const RATE_Q = 0.013;
const INT_N = 200;
const INT_U_MAX = 130;
const NM_MAX_ITERS = 280;

// -------- complex arithmetic ---------------------------------------------

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

// Pre-computed Simpson weights and u-grid.
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

// ---- Heston characteristic function (Little-Trap, single CF formulation)
//
// Returns φ(u) for log S_T under the risk-neutral measure with no jump
// component included. Uses the "Schoutens" form so that there is one
// CF (not the Heston P₁/P₂ pair); Lewis pricing wants the un-pinned
// single CF directly.
function hestonCfSingle(uComplex, params, S0, T, r, q) {
  const { kappa, theta, xi, rho, v0 } = params;
  const i = [0, 1];
  const iu = cMul(i, uComplex);
  // d = √((ρ·ξ·iu − κ)² + ξ²·(iu + u²))
  // Compute ρ·ξ·iu − κ
  const a = cSub(cScale(iu, rho * xi), [kappa, 0]);
  // u² (complex)
  const u2 = cMul(uComplex, uComplex);
  // iu + u²
  const iuPlusU2 = cAdd(iu, u2);
  // a² + ξ²·(iu + u²)
  const inside = cAdd(cMul(a, a), cScale(iuPlusU2, xi * xi));
  const d = cSqrt(inside);

  // g = (κ − ρ·ξ·iu − d) / (κ − ρ·ξ·iu + d)  (Little-Trap form)
  const aMinus = cSub([kappa, 0], cScale(iu, rho * xi));
  const num = cSub(aMinus, d);
  const den = cAdd(aMinus, d);
  const g = cDiv(num, den);

  const eDt = cExp(cScale(d, -T));
  const one = [1, 0];
  // (1 − g·e^(−dT)) / (1 − g)
  const ratio = cDiv(cSub(one, cMul(g, eDt)), cSub(one, g));
  const logRatio = cLog(ratio);

  // C = (r−q)·iu·T + (κθ/ξ²)·[ (κ − ρ·ξ·iu − d)·T − 2·log(ratio) ]
  const C = cAdd(
    cScale(iu, (r - q) * T),
    cScale(cSub(cScale(num, T), cScale(logRatio, 2)), (kappa * theta) / (xi * xi)),
  );
  // D = (κ − ρ·ξ·iu − d)/ξ²  ·  (1 − e^(−dT)) / (1 − g·e^(−dT))
  const D = cMul(
    cScale(num, 1 / (xi * xi)),
    cDiv(cSub(one, eDt), cSub(one, cMul(g, eDt))),
  );

  // φ = exp(C + D·v₀ + iu·ln S₀)
  const exponent = cAdd(cAdd(C, cScale(D, v0)), cScale(iu, Math.log(S0)));
  return cExp(exponent);
}

// ---- Bates CF: Heston × Merton-jump factor -------------------------------
function batesCf(uComplex, params, S0, T, r, q) {
  const { lambda, muJ, sigmaJ } = params;
  const phiH = hestonCfSingle(uComplex, params, S0, T, r, q);
  // jump factor: exp[ λT·(e^(iu·μJ − 0.5·u²·σJ²) − 1 − iu·k) ]
  const k = Math.exp(muJ + 0.5 * sigmaJ * sigmaJ) - 1;
  const i = [0, 1];
  const iu = cMul(i, uComplex);
  const u2 = cMul(uComplex, uComplex);
  // exponent inside the inner exp: iu·μJ − 0.5·σJ²·u²
  const innerExp = cSub(cScale(iu, muJ), cScale(u2, 0.5 * sigmaJ * sigmaJ));
  const eInner = cExp(innerExp);
  const inner = cSub(cSub(eInner, [1, 0]), cScale(iu, k));
  const jumpExp = cScale(inner, lambda * T);
  const jumpFactor = cExp(jumpExp);
  return cMul(phiH, jumpFactor);
}

// ---- Lewis call price ----------------------------------------------------
function batesCall(params, S0, K, T, r, q) {
  const k = Math.log(K / S0) - (r - q) * T;
  let acc = 0;
  for (let i = 0; i < INT_N; i++) {
    const u = U_GRID[i];
    const arg = [u, -0.5];
    const phi = batesCf(arg, params, S0, T, r, q);
    const eIuk = [Math.cos(u * k), Math.sin(u * k)];
    const num = cMul(eIuk, phi);
    const denom = u * u + 0.25;
    acc += U_WEIGHTS[i] * num[0] / denom;
  }
  const sqrtSK = Math.sqrt(S0 * K);
  const factor = sqrtSK * Math.exp(-(r + q) * T / 2) / Math.PI;
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
// theta = [log κ, log θ, log ξ, atanh ρ, log v₀, log λ, μ_J, log σ_J]

function unpack(theta) {
  return {
    kappa: Math.exp(theta[0]),
    theta: Math.exp(theta[1]),
    xi: Math.exp(theta[2]),
    rho: Math.tanh(theta[3]),
    v0: Math.exp(theta[4]),
    lambda: Math.exp(theta[5]),
    muJ: theta[6],
    sigmaJ: Math.exp(theta[7]),
  };
}
function pack(p) {
  return [
    Math.log(Math.max(p.kappa, 1e-4)),
    Math.log(Math.max(p.theta, 1e-6)),
    Math.log(Math.max(p.xi, 1e-4)),
    Math.atanh(Math.max(-0.999, Math.min(0.999, p.rho))),
    Math.log(Math.max(p.v0, 1e-6)),
    Math.log(Math.max(p.lambda, 1e-4)),
    p.muJ,
    Math.log(Math.max(p.sigmaJ, 1e-4)),
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

function calibrateBates(slice, S0, T, r, q, init) {
  const obj = (theta) => {
    const p = unpack(theta);
    if (p.kappa > 50 || p.theta > 1 || p.xi > 3 || p.v0 > 1) return 1e6;
    if (p.lambda > 30 || p.sigmaJ > 1 || p.muJ < -2 || p.muJ > 1) return 1e6;
    let sse = 0;
    let n = 0;
    for (const { strike, iv } of slice) {
      const c = batesCall(p, S0, strike, T, r, q);
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

// Warm start. Gentler Heston piece (lower κ, lower ξ) than the Heston-only
// fit in the Stochastic Vol Lab, because the jump component will absorb
// the deep-OTM skew that Heston-alone has to inflate ξ to match.
const INIT_PARAMS = {
  kappa: 1.5,
  theta: 0.035,
  xi: 0.30,
  rho: -0.65,
  v0: 0.035,
  lambda: 0.6,
  muJ: -0.10,
  sigmaJ: 0.15,
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

export default function SlotC() {
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

  const calib = useMemo(() => {
    if (!data || !activeExp || slice.length < 8 || !T || T <= 0) return null;
    return calibrateBates(slice, data.spotPrice, T, RATE_R, RATE_Q, INIT_PARAMS);
  }, [data, activeExp, slice, T]);

  useEffect(() => {
    if (!Plotly || !chartRef.current || !calib || slice.length === 0 || !T || !data) return;

    const strikes = slice.map((r) => r.strike);
    const ivs = slice.map((r) => r.iv * 100);
    const K_lo = Math.min(...strikes);
    const K_hi = Math.max(...strikes);
    const nGrid = 50;
    const gridK = new Array(nGrid);
    const gridIv = new Array(nGrid);
    for (let i = 0; i < nGrid; i++) {
      const K = K_lo + (i / (nGrid - 1)) * (K_hi - K_lo);
      gridK[i] = K;
      const c = batesCall(calib.params, data.spotPrice, K, T, RATE_R, RATE_Q);
      const iv = bsmIv(c, data.spotPrice, K, T, RATE_R, RATE_Q);
      gridIv[i] = iv != null ? iv * 100 : null;
    }

    // Heston-only counterfactual. Jumps switched off; the gap to the
    // full Bates curve is the smile contribution from the jump
    // component, exactly the Heston short-skew gap that Bates closes.
    const noJumpParams = { ...calib.params, lambda: 0 };
    const gridIvNoJump = new Array(nGrid);
    for (let i = 0; i < nGrid; i++) {
      const c = batesCall(noJumpParams, data.spotPrice, gridK[i], T, RATE_R, RATE_Q);
      const iv = bsmIv(c, data.spotPrice, gridK[i], T, RATE_R, RATE_Q);
      gridIvNoJump[i] = iv != null ? iv * 100 : null;
    }

    const allIv = [...ivs, ...gridIv.filter((v) => v != null), ...gridIvNoJump.filter((v) => v != null)];
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
        name: 'Bates SVJ fit',
        line: { color: PLOTLY_COLORS.secondary, width: 2 },
        hoverinfo: 'skip',
        connectgaps: false,
      },
      {
        x: gridK,
        y: gridIvNoJump,
        mode: 'lines',
        name: 'Heston-only · λ = 0',
        line: { color: PLOTLY_COLORS.highlight, width: 1, dash: 'dash' },
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
        ...plotlyTitle('Bates SVJ Fit · SPX'),
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
        <div className="lab-placeholder-title">Loading chain...</div>
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

  // Annual jump variance contribution: λ·(μ_J² + σ_J²). Compare to θ
  // (long-run variance) to read how much of total variance is jump-driven.
  const jumpVar = calib ? calib.params.lambda * (calib.params.muJ ** 2 + calib.params.sigmaJ ** 2) : null;
  const jumpShare = calib && calib.params.theta > 0
    ? jumpVar / (jumpVar + calib.params.theta)
    : null;

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
        bates svj · heston variance plus merton jumps · 8 parameters
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
          label="θ · long-run σ"
          value={calib ? formatPct(Math.sqrt(calib.params.theta), 1) : '-'}
          sub="Heston piece"
          accent={PLOTLY_COLORS.highlight}
        />
        <StatCell
          label="ρ · correlation"
          value={calib ? formatFixed(calib.params.rho, 3) : '-'}
          sub="Heston leverage"
          accent={calib && calib.params.rho < -0.5 ? PLOTLY_COLORS.secondary : undefined}
        />
        <StatCell
          label="ξ · vol of vol"
          value={calib ? formatFixed(calib.params.xi, 3) : '-'}
          sub="Heston piece"
        />
        <StatCell
          label="λ · jump rate"
          value={calib ? formatFixed(calib.params.lambda, 2) : '-'}
          sub="jumps per year"
          accent={PLOTLY_COLORS.secondary}
        />
        <StatCell
          label="μ_J · log mean"
          value={calib ? formatFixed(calib.params.muJ, 3) : '-'}
          sub="avg log jump"
          accent={calib && calib.params.muJ < -0.05 ? PLOTLY_COLORS.secondary : undefined}
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
          Bates (1996) is the answer to a problem that pure Heston could
          not solve. Heston produces smile through diffusive correlation
          ρ, but that mechanism vanishes as the tenor shrinks. Every
          diffusion path is locally Gaussian, so a pure-Heston smile
          flattens into a flat line as T approaches zero.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          Bates fixes that by adding{' '}
          <strong style={{ color: PLOTLY_COLORS.secondary }}>Merton-style log-normal jumps</strong>{' '}
          to a{' '}
          <strong style={{ color: PLOTLY_COLORS.highlight }}>Heston stochastic-variance core</strong>.
          The jump component preserves skew at short tenor because a
          jump is non-Gaussian even instantaneously. Heston still does
          the heavy lifting at long tenor, where mean-reverting
          variance produces the right term-structure shape.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          Eight parameters: the five Heston parameters (κ, θ, ξ, ρ, v₀)
          plus three jump parameters (λ, μ_J, σ_J). The characteristic
          function factorizes cleanly. Pricing is by Lewis (2001)
          single-integral inversion. Calibration is an 8-parameter
          Nelder-Mead in IV-space against the same SPX slice the other
          three models use.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          <strong style={{ color: 'var(--text-primary)' }}>Reading.</strong>{' '}
          The{' '}
          <strong style={{ color: PLOTLY_COLORS.primary }}>blue dots</strong>{' '}
          are the chain&apos;s observed IVs. The{' '}
          <strong style={{ color: PLOTLY_COLORS.secondary }}>coral curve</strong>{' '}
          is the full Bates SVJ fit. The{' '}
          <strong style={{ color: PLOTLY_COLORS.highlight }}>dashed amber line</strong>{' '}
          is the Heston-only counterfactual using the same fitted (κ, θ,
          ξ, ρ, v₀) but with λ set to zero. The visible gap between the
          two model lines is the smile that the jump component
          contributes, which is precisely the short-skew gap that pure
          Heston cannot deliver.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          A second indirect read of the jump contribution is the{' '}
          <strong style={{ color: PLOTLY_COLORS.secondary }}>jump-variance share</strong>{' '}
          {jumpShare != null ? (
            <strong style={{ color: PLOTLY_COLORS.secondary }}>
              ({(jumpShare * 100).toFixed(0)}% of total variance)
            </strong>
          ) : (
            ''
          )}
          {'. '}
          This is λ·(μ_J² + σ_J²) divided by the sum of long-run variance
          θ and the same jump-variance contribution. It quantifies how
          much of the model&apos;s total variance is being delivered by
          discrete jumps versus continuous diffusion.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          With Bates the calibrated Heston ξ is usually lower than the
          Heston-alone calibration finds, because Bates does not need to
          inflate vol-of-vol to match the deep-OTM put skew. The jump
          component does that work cleanly, and ξ is left to describe
          the diffusive short-rate of variance itself.
        </p>
        <p style={{ margin: 0 }}>
          Bates is the canonical SVJ model and was the practitioner
          default for SPX surfaces through the 2000s. Its main remaining
          limitation is that the jump intensity is constant under the
          risk-neutral measure. SVCJ (Duffie-Pan-Singleton 2000) lifts
          that by jumping in variance as well, and self-exciting Hawkes
          formulations make λ depend on the jump history.
        </p>
      </div>
    </div>
  );
}
