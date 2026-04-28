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

const RATE_R = 0.045;
const RATE_Q = 0.013;
const INT_N = 220;
const INT_U_MAX = 180;
const NM_MAX_ITERS = 240;

// -------- complex arithmetic ---------------------------------------------

function cAdd(a, b) { return [a[0] + b[0], a[1] + b[1]]; }
function cMul(a, b) { return [a[0]*b[0] - a[1]*b[1], a[0]*b[1] + a[1]*b[0]]; }
function cScale(a, s) { return [a[0]*s, a[1]*s]; }
function cExp(a) {
  const m = Math.exp(a[0]);
  return [m * Math.cos(a[1]), m * Math.sin(a[1])];
}
function cLog(a) {
  return [0.5 * Math.log(a[0]*a[0] + a[1]*a[1]), Math.atan2(a[1], a[0])];
}
// Complex power for non-integer real exponents: z^p = exp(p · log z).
function cPow(a, p) {
  return cExp(cScale(cLog(a), p));
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

// ---- VG characteristic function of log S_T ------------------------------
//
// For complex u (used in Lewis pricing with u → u − i/2), the inner
// expression is (1 − i·u·θ·ν + 0.5·σ²·ν·u²). Computing each piece in
// complex arithmetic:
//   i·u for complex u = (u_re + i·u_im) gives (−u_im, u_re)
//   u² for complex u: (u_re² − u_im², 2·u_re·u_im)
function vgCf(uComplex, params, S0, T, r, q) {
  const { sigma, nu, theta } = params;
  const uRe = uComplex[0];
  const uIm = uComplex[1];
  const iu = [-uIm, uRe];
  const u2 = [uRe * uRe - uIm * uIm, 2 * uRe * uIm];

  // Inner = 1 − iu·θ·ν + 0.5·σ²·ν·u²
  const term1 = [1, 0];
  const term2 = cScale(iu, -theta * nu);
  const term3 = cScale(u2, 0.5 * sigma * sigma * nu);
  const inner = cAdd(cAdd(term1, term2), term3);

  // Power: inner^(−T/ν)
  const phiX = cPow(inner, -T / nu);

  // Compensator ω = (1/ν)·ln(1 − θ·ν − 0.5·σ²·ν). For θ·ν + 0.5·σ²·ν > 1
  // the log argument is non-positive and the model is ill-posed;
  // calibration penalty below blocks this region.
  const innerOmega = 1 - theta * nu - 0.5 * sigma * sigma * nu;
  if (!(innerOmega > 0)) return [Number.NaN, Number.NaN];
  const omega = Math.log(innerOmega) / nu;

  const drift = Math.log(S0) + (r - q + omega) * T;
  const expIuDrift = cExp(cScale(iu, drift));
  return cMul(expIuDrift, phiX);
}

// ---- Lewis call price ----------------------------------------------------
function vgCall(params, S0, K, T, r, q) {
  const innerOmega = 1 - params.theta * params.nu - 0.5 * params.sigma * params.sigma * params.nu;
  if (!(innerOmega > 0)) return Number.NaN;

  const k = Math.log(K / S0) - (r - q) * T;
  let acc = 0;
  for (let i = 0; i < INT_N; i++) {
    const u = U_GRID[i];
    const arg = [u, -0.5];
    const phi = vgCf(arg, params, S0, T, r, q);
    if (!Number.isFinite(phi[0]) || !Number.isFinite(phi[1])) return Number.NaN;
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
    let sse = 0;
    let n = 0;
    for (const { strike, iv } of slice) {
      const c = vgCall(p, S0, strike, T, r, q);
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

export default function SlotD() {
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
    if (!data || !activeExp || slice.length < 6 || !T || T <= 0) return null;
    return calibrateVg(slice, data.spotPrice, T, RATE_R, RATE_Q, INIT_PARAMS);
  }, [data, activeExp, slice, T]);

  useEffect(() => {
    if (!Plotly || !chartRef.current || !calib || slice.length === 0 || !T || !data) return;

    const strikes = slice.map((r) => r.strike);
    const ivs = slice.map((r) => r.iv * 100);
    const K_lo = Math.min(...strikes);
    const K_hi = Math.max(...strikes);
    const nGrid = 70;
    const gridK = new Array(nGrid);
    const gridIv = new Array(nGrid);
    for (let i = 0; i < nGrid; i++) {
      const K = K_lo + (i / (nGrid - 1)) * (K_hi - K_lo);
      gridK[i] = K;
      const c = vgCall(calib.params, data.spotPrice, K, T, RATE_R, RATE_Q);
      const iv = Number.isFinite(c) ? bsmIv(c, data.spotPrice, K, T, RATE_R, RATE_Q) : null;
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
        name: 'Variance Gamma fit',
        line: { color: PLOTLY_COLORS.primarySoft, width: 2 },
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
        ...plotlyTitle('Variance Gamma Fit · SPX'),
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
          the clean contrast with the other three models on this page,
          all of which keep a continuous diffusion piece somewhere in
          their dynamics.
        </p>
      </div>
    </div>
  );
}
