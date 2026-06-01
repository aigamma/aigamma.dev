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
// Variance Gamma (Madan, Carr, Chang 1998). Pure-jump infinite-activity
// Levy process built by time-changing a Brownian motion with a gamma
// subordinator. No diffusive component at all. The model demonstrates
// that an "all jumps, no diffusion" specification can fit the SPX
// smile competitively.
//
// Construction: let G_t be a gamma process with mean rate 1 and
// variance rate ν per unit time. Set X_t = θ·G_t + σ·W(G_t) where W
// is an independent Brownian motion. Then X_t is the Variance Gamma
// process and the log price under the risk-neutral measure is
//
//   ln S_T = ln S₀ + (r − q + ω)·T + X_T,
//   ω = (1/ν)·ln(1 − θ·ν − 0.5·σ²·ν)         [martingale compensator]
//
// Three free parameters: σ (Brownian vol of the time-changed motion),
// ν (variance rate of the gamma clock, controls excess kurtosis), and
// θ (drift of the time-changed motion, controls skew). When θ = 0 and
// ν = 0 the model collapses back to Black-Scholes.
//
// The characteristic function is closed-form in a particularly clean
// way:
//
//   φ_X(u; T) = (1 − i·u·θ·ν + 0.5·σ²·ν·u²)^(−T/ν)
//   φ_lnS(u; T) = exp(i·u·(ln S₀ + (r − q + ω)·T)) · φ_X(u; T)
//
// Pricing uses the Lewis (2001) single-integral inversion. The
// kurtosis parameter ν is the one feature SPX really wants from this
// family: it lets the smile flatten or steepen as a function of one
// scalar that has a direct interpretation as the variance of the
// stochastic clock.
//
// VG is the simplest member of the tempered-stable / CGMY family
// (Carr-Geman-Madan-Yor 2002). Adding two parameters (G, M) and a
// stability index Y gives CGMY. Adding a CIR-driven time change gives
// VG-CIR or CGMY-CIR. This slot stops at base VG so the contrast with
// Merton, Kou, and Bates stays clean: same dataset, three-parameter
// pure-jump model, no diffusion.
// -----------------------------------------------------------------------------

const INT_N = 601;
const NM_MAX_ITERS = 240;

// Pre-computed quadrature for Lewis (2001) inversion. See the Kou slot
// for the substitution rationale: v = atan(2u), u = tan(v)/2, the
// 1/(u²+1/4) singularity dissolves into the dv measure, and Simpson on
// [0, π/2] converges at its full O(h⁴) rate.
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

// ---- VG characteristic function of X = ln(S_T/S₀) -----------------------
//
// Centered CF (around S₀): the ln S₀ shift is absorbed into the Lewis k
// outside this loop so the integrand has O(1) magnitude rather than the
// O(√S₀) values produced by the un-centered ln S_T form. Same precompute-
// once / per-K-sum factorisation that the Heston pricer on /jump/ and
// /risk/ uses. The CF is independent of strike, so for one
// (params, S0, T, r, q) we evaluate φ(u − i/2) once at every u in U_GRID
// and store the (re, im) pair into Float64Arrays. Per-K pricing then
// reduces to a tight O(INT_N) sum against the Lewis kernel
// e^(i·u·k)/(u²+1/4).
//
//   φ_VG(u; T)  = (1 − i·u·θ·ν + 0.5·σ²·ν·u²)^(−T/ν)
//   φ_X(u; T)   = exp[i·u·(r − q + ω)·T] · φ_VG(u; T)
//   ω           = (1/ν)·ln(1 − θ·ν − 0.5·σ²·ν)
//
// At u = u_real − i/2 the complex parts collapse to:
//   iu        = (1/2, u_real)
//   u²        = (u_real² − 1/4, −u_real)
//
// Returns true on success, false if the parameters fall in the inadmissible
// region (1 − θν − 0.5σ²ν ≤ 0); the calibration objective penalises that
// region with a hard penalty so a single Float64Array NaN flag is enough.
function fillVgCf(outRe, outIm, params, S0, T, r, q) {
  const { sigma, nu, theta } = params;
  const innerOmega = 1 - theta * nu - 0.5 * sigma * sigma * nu;
  if (!(innerOmega > 0)) {
    for (let i = 0; i < INT_N; i++) {
      outRe[i] = Number.NaN;
      outIm[i] = Number.NaN;
    }
    return false;
  }
  const omega = Math.log(innerOmega) / nu;
  const drift = (r - q + omega) * T;
  const power = -T / nu;
  const halfSigma2Nu = 0.5 * sigma * sigma * nu;
  const thetaNu = theta * nu;

  for (let i = 0; i < INT_N; i++) {
    const u = U_GRID[i];

    // Inner = 1 − iu·θν + 0.5·σ²·ν·u²
    //   −iu·θν = (−0.5·θν, −u·θν)
    //   0.5·σ²ν·u² = (0.5·σ²ν·(u²−1/4), 0.5·σ²ν·(−u))
    const inner_re = 1 - 0.5 * thetaNu + halfSigma2Nu * (u * u - 0.25);
    const inner_im = -u * thetaNu + halfSigma2Nu * -u;

    // phiX = inner^power = exp(power · log(inner))
    const inner_mag2 = inner_re * inner_re + inner_im * inner_im;
    const logInner_re = 0.5 * Math.log(inner_mag2);
    const logInner_im = Math.atan2(inner_im, inner_re);
    const phiX_exp_re = power * logInner_re;
    const phiX_exp_im = power * logInner_im;
    const phiXMag = Math.exp(phiX_exp_re);
    const phiX_re = phiXMag * Math.cos(phiX_exp_im);
    const phiX_im = phiXMag * Math.sin(phiX_exp_im);

    // expIuDrift = exp(iu·drift) — iu·drift = (0.5·drift, u·drift)
    const eIuDriftMag = Math.exp(0.5 * drift);
    const eIuDrift_re = eIuDriftMag * Math.cos(u * drift);
    const eIuDrift_im = eIuDriftMag * Math.sin(u * drift);

    // φ = expIuDrift · phiX
    outRe[i] = eIuDrift_re * phiX_re - eIuDrift_im * phiX_im;
    outIm[i] = eIuDrift_re * phiX_im + eIuDrift_im * phiX_re;
  }
  return true;
}

function precomputeVgCfGrid(params, S0, T, r, q) {
  const F_re = new Float64Array(INT_N);
  const F_im = new Float64Array(INT_N);
  const ok = fillVgCf(F_re, F_im, params, S0, T, r, q);
  return { F_re, F_im, ok };
}

// ---- Lewis call price ----------------------------------------------------
//
// C = S₀·e^(−q·T) − √(S₀·K)·e^(−r·T) / π · ∫₀^∞ Re[ e^(i·u·k) · φ_X(u − i/2) ] / (u² + 1/4) du
// where k = ln(S₀/K) and φ_X is the CF of X = ln(S_T/S₀) (centered).
function vgCallFromCfGrid(grid, S0, K, T, r, q) {
  if (!grid.ok) return Number.NaN;
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
// theta = [log σ, log ν, θ (free real)]

function unpack(theta) {
  return {
    sigma: Math.exp(theta[0]),
    nu: Math.exp(theta[1]),
    theta: theta[2],
  };
}
function pack(p) {
  return [
    Math.log(Math.max(p.sigma, 1e-4)),
    Math.log(Math.max(p.nu, 1e-4)),
    p.theta,
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

// ------- Calibration -----------------------------------------------------

function calibrateVg(slice, S0, T, r, q, init) {
  const obj = (theta) => {
    const p = unpack(theta);
    if (p.sigma > 1.5 || p.nu > 5) return 1e6;
    if (p.theta < -2 || p.theta > 1) return 1e6;
    // Compensator condition: 1 − θν − 0.5σ²ν > 0
    const innerOmega = 1 - p.theta * p.nu - 0.5 * p.sigma * p.sigma * p.nu;
    if (!(innerOmega > 0.01)) return 1e6;
    // One CF table per parameter set; every strike on the slice reuses it.
    const grid = precomputeVgCfGrid(p, S0, T, r, q);
    if (!grid.ok) return 1e6;
    let sse = 0;
    let n = 0;
    for (const { strike, iv } of slice) {
      const c = vgCallFromCfGrid(grid, S0, strike, T, r, q);
      if (!Number.isFinite(c)) return 1e6;
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

// Warm start. SPX-typical: σ a bit above ATM IV, moderate kurtosis,
// negative drift (skew toward downside).
const INIT_PARAMS = {
  sigma: 0.18,
  nu: 0.25,
  theta: -0.20,
};

// ------- UI ------------------------------------------------------------

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
    return sliceObservations(data.contracts, activeExp, data.spotPrice);
  }, [data, activeExp]);

  const dte = useMemo(() => {
    if (!activeExp || !data?.capturedAt) return null;
    return daysToExpiration(activeExp, data.capturedAt);
  }, [activeExp, data]);
  const T = dte != null ? dte / 365 : null;

  // Variance Gamma calibration (3-parameter pure-jump Levy fit) deferred
  // to idle callback so chart paints observation dots before the simplex
  // runs. VG is the lightest of the four /jump/ slots by parameter count
  // and converges in fewer iterations than the others, but the same
  // pattern is applied for consistency and to keep the chart paintable
  // alongside its three sibling slots.
  const [calib, setCalib] = useState(null);
  useEffect(() => {
    if (!data || !activeExp || slice.length < 6 || !T || T <= 0) {
      setCalib(null);
      return undefined;
    }
    if (typeof window === 'undefined') {
      setCalib(calibrateVg(slice, data.spotPrice, T, RATE_R, RATE_Q, INIT_PARAMS));
      return undefined;
    }
    let cancelled = false;
    const idle = window.requestIdleCallback
      ? (cb) => window.requestIdleCallback(cb, { timeout: 1500 })
      : (cb) => setTimeout(cb, 0);
    const cancel = window.cancelIdleCallback || clearTimeout;
    const handle = idle(() => {
      if (cancelled) return;
      const res = calibrateVg(slice, data.spotPrice, T, RATE_R, RATE_Q, INIT_PARAMS);
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
      const nGrid = 70;
      gridK = new Array(nGrid);
      gridIv = new Array(nGrid);
      // Build the VG CF table once for the calibrated parameter set, then
      // sum it against the Lewis kernel for each grid strike.
      const vgGrid = precomputeVgCfGrid(
        calib.params,
        data.spotPrice,
        T,
        RATE_R,
        RATE_Q
      );
      for (let i = 0; i < nGrid; i++) {
        const K = K_lo + (i / (nGrid - 1)) * (K_hi - K_lo);
        gridK[i] = K;
        const c = vgCallFromCfGrid(vgGrid, data.spotPrice, K, T, RATE_R, RATE_Q);
        const iv = Number.isFinite(c) ? bsmIv(c, data.spotPrice, K, T, RATE_R, RATE_Q) : null;
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
        name: 'Variance Gamma fit',
        line: { color: PLOTLY_COLORS.primarySoft, width: 2 },
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
        ...plotlyTitle('Variance Gamma Fit'),
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

  // Excess kurtosis of X_T under VG. For VG, kurt = 3·(1 + 2ν/T) at θ=0;
  // with skew the formula is more involved but the headline is that ν
  // controls how heavy the tail of the increment distribution is.
  // Simplest readable derived stat is the annualized return variance
  // of the time-changed motion: σ² + θ²·ν.
  const annVar = calib ? calib.params.sigma ** 2 + calib.params.theta ** 2 * calib.params.nu : null;

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
        variance gamma · pure-jump infinite-activity levy · 3 parameters
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
          gridTemplateColumns: mobile ? 'repeat(2, 1fr)' : 'repeat(5, 1fr)',
          gap: '0.85rem',
          padding: '0.75rem 0',
          borderTop: '1px solid var(--bg-card-border)',
          borderBottom: '1px solid var(--bg-card-border)',
          marginBottom: '0.85rem',
        }}
      >
        <StatCell
          label="σ · BM scale"
          value={calib ? formatPct(calib.params.sigma, 2) : '-'}
          sub="time-changed BM vol"
          accent={PLOTLY_COLORS.primary}
        />
        <StatCell
          label="ν · gamma var rate"
          value={calib ? formatFixed(calib.params.nu, 3) : '-'}
          sub="kurtosis driver"
          accent={PLOTLY_COLORS.highlight}
        />
        <StatCell
          label="θ · drift"
          value={calib ? formatFixed(calib.params.theta, 3) : '-'}
          sub="skew driver"
          accent={calib && calib.params.theta < 0 ? PLOTLY_COLORS.secondary : undefined}
        />
        <StatCell
          label="σ² + θ²ν · ann var"
          value={annVar != null ? formatPct(Math.sqrt(annVar), 1) : '-'}
          sub="implied ann. vol"
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
          Variance Gamma is a pure-jump model with no diffusive
          component at all. The construction is conceptually elegant.
          Take a Brownian motion, then run its clock not at constant
          time but at a random rate given by an independent gamma
          process. The result is a process that jumps at every instant
          (infinite activity) and whose increments are heavy-tailed in
          a way that calibrates well to options markets.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          Three free parameters and they all have direct meaning. The
          Brownian volatility{' '}
          <strong style={{ color: PLOTLY_COLORS.primary }}>σ</strong>{' '}
          sets the scale of the time-changed motion. The variance rate
          of the gamma clock{' '}
          <strong style={{ color: PLOTLY_COLORS.highlight }}>ν</strong>{' '}
          controls the kurtosis (smile curvature). The drift parameter{' '}
          <strong style={{ color: PLOTLY_COLORS.secondary }}>θ</strong>{' '}
          controls the skew. With θ negative the model leans
          asymmetrically toward downside log-returns, which is the
          feature that lets it fit equity smiles cleanly.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          The characteristic function is closed-form and short:{' '}
          <code style={{ color: 'var(--text-primary)' }}>
            (1 − iuθν + 0.5σ²νu²)^(−T/ν)
          </code>
          . Pricing is by Lewis (2001) inversion of that single
          integrand. When θ goes to zero and ν goes to zero the model
          collapses back to Black-Scholes, so VG nests BSM as a
          limiting case.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          <strong style={{ color: 'var(--text-primary)' }}>Reading.</strong>{' '}
          The{' '}
          <strong style={{ color: PLOTLY_COLORS.primary }}>blue dots</strong>{' '}
          are the chain&apos;s observed IVs. The{' '}
          <strong style={{ color: PLOTLY_COLORS.primarySoft }}>soft-blue curve</strong>{' '}
          is the Variance Gamma fit. With only three parameters the
          model often matches the central smile shape competitively.
          Where it tends to struggle is the very deep wings, because the
          tempered-stable family with extra parameters (CGMY) has the
          flexibility to bend each tail independently.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          The kurtosis parameter{' '}
          <strong style={{ color: PLOTLY_COLORS.highlight }}>ν</strong>{' '}
          is the lever that controls smile curvature, and it has a clean
          interpretation: it is the variance per unit time of the random
          clock that subordinates the Brownian motion. Larger ν means
          the clock runs more erratically, which makes the increments
          more leptokurtic. As ν approaches zero the random clock
          becomes deterministic and VG collapses back to Black-Scholes.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          A negative{' '}
          <strong style={{ color: PLOTLY_COLORS.secondary }}>θ</strong>{' '}
          tilts the smile so that downside moves are larger and more
          frequent than upside moves of the same probability. It is the
          parameter that produces the put skew on equity calibrations,
          analogous to the role ρ plays in the Heston family.
        </p>
        <p style={{ margin: 0 }}>
          What VG demonstrates conceptually is that diffusive volatility
          is not necessary to fit options markets. A pure-jump
          infinite-activity Levy process can do the same job. That is
          the clean contrast with the other four models on this page,
          all of which keep a continuous diffusion piece somewhere in
          their dynamics.
        </p>
      </div>
    </div>
  );
}
