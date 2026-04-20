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
// Kou (2002) Double Exponential Jump Diffusion. Same compound-Poisson
// overlay as Merton, but the jump-size distribution is asymmetric
// double exponential rather than log-normal:
//
//   f_Y(y) = p · η₁ · e^(−η₁·y)·1{y ≥ 0} + (1−p) · η₂ · e^(η₂·y)·1{y < 0}
//
// where Y is the log jump size, p is the probability of an upward
// jump, η₁ controls the rate (= 1/expected size) of the upward
// exponential tail, and η₂ controls the rate of the downward tail.
// Larger η means thinner tail. Equity index calibrations almost
// always have η₂ < η₁ (downward jumps are larger on average), which
// is the empirical asymmetry that motivates the model.
//
// The characteristic function is closed-form:
//
//   ω = (r − q − 0.5σ² − λ·κ)
//   κ = E[e^Y − 1] = p·η₁/(η₁ − 1) + (1 − p)·η₂/(η₂ + 1) − 1
//   ψ_jump(u) = p·η₁/(η₁ − iu) + (1−p)·η₂/(η₂ + iu) − 1
//   φ_X(u; T) = exp[i·u·(ln S₀ + ω·T) − 0.5σ²·u²·T + λT·ψ_jump(u)]
//
// (η₁ > 1 is required for a finite first moment of the upward jump,
// which is enforced by reparameterization below.)
//
// Call price by Lewis (2001) single-integral inversion of the
// characteristic function:
//
//   C = S₀·e^(−q·T) − √(S₀·K)·e^(−(r+q)·T/2) / π · ∫₀^∞ Re[ e^(i·u·k) · φ(u − i/2) ] / (u² + 1/4) du
//
// where k = ln(K/S₀) − (r − q)·T. Single tail integrand decays like
// e^(−c·u·T) and is well-behaved across all maturities, unlike the
// Heston two-integral form. 5 free parameters: σ, λ, p, η₁, η₂.
// Calibrated by Nelder-Mead on IV-space residuals against the same
// SPX expiration slice Slot A uses.
// -----------------------------------------------------------------------------

const RATE_R = 0.045;
const RATE_Q = 0.013;
const INT_N = 200;
const INT_U_MAX = 150;
const NM_MAX_ITERS = 240;

// -------- complex arithmetic as [re, im] pairs ---------------------------

function cAdd(a, b) { return [a[0] + b[0], a[1] + b[1]]; }
function cSub(a, b) { return [a[0] - b[0], a[1] - b[1]]; }
function cMul(a, b) { return [a[0]*b[0] - a[1]*b[1], a[0]*b[1] + a[1]*b[0]]; }
function cDiv(a, b) {
  const denom = b[0]*b[0] + b[1]*b[1];
  return [(a[0]*b[0] + a[1]*b[1]) / denom, (a[1]*b[0] - a[0]*b[1]) / denom];
}
function cExp(a) {
  const m = Math.exp(a[0]);
  return [m * Math.cos(a[1]), m * Math.sin(a[1])];
}

// Pre-computed Simpson weights and u-grid (shared with kouCharFn caller).
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

// ---- Kou characteristic function of log S_T -----------------------------

function kouCf(u_complex, params, S0, T, r, q) {
  const { sigma, lambda, p, eta1, eta2 } = params;
  // κ = p·η₁/(η₁ − 1) + (1−p)·η₂/(η₂ + 1) − 1
  const kappa = p * eta1 / (eta1 - 1) + (1 - p) * eta2 / (eta2 + 1) - 1;
  const omega = r - q - 0.5 * sigma * sigma - lambda * kappa;

  // ψ_jump(u) = p·η₁/(η₁ − iu) + (1−p)·η₂/(η₂ + iu) − 1
  // η₁ − iu is complex; encode iu = (−u_im, u_re) since u is complex
  const iu = [-u_complex[1], u_complex[0]];
  const eta1_minus_iu = cSub([eta1, 0], iu);
  const eta2_plus_iu = cAdd([eta2, 0], iu);
  const term1 = cDiv([p * eta1, 0], eta1_minus_iu);
  const term2 = cDiv([(1 - p) * eta2, 0], eta2_plus_iu);
  const psi = cSub(cAdd(term1, term2), [1, 0]);

  // exponent = i·u·(ln S₀ + ω·T) − 0.5σ²·u²·T + λT·ψ
  // u² for complex u: (u_re + i·u_im)² = (u_re² − u_im², 2·u_re·u_im)
  const uRe = u_complex[0];
  const uIm = u_complex[1];
  const u2 = [uRe * uRe - uIm * uIm, 2 * uRe * uIm];
  const drift = Math.log(S0) + omega * T;
  // i·u·drift = i·u·drift = (−u_im·drift, u_re·drift)
  const iuDrift = [-uIm * drift, uRe * drift];
  const halfSigma2T = 0.5 * sigma * sigma * T;
  const sigmaTerm = [-halfSigma2T * u2[0], -halfSigma2T * u2[1]];
  const jumpTerm = [lambda * T * psi[0], lambda * T * psi[1]];
  const exponent = [iuDrift[0] + sigmaTerm[0] + jumpTerm[0], iuDrift[1] + sigmaTerm[1] + jumpTerm[1]];
  return cExp(exponent);
}

// ---- Lewis (2001) single-integral call price ----------------------------
//
// C = S₀·e^(−q·T) − √(S₀·K)·e^(−(r+q)·T/2) / π · ∫₀^∞ Re[ e^(i·u·k) · φ(u − i/2) ] / (u² + 1/4) du
// where k = ln(K/S₀) − (r − q)·T.

function kouCall(params, S0, K, T, r, q) {
  const k = Math.log(K / S0) - (r - q) * T;
  let acc = 0;
  for (let i = 0; i < INT_N; i++) {
    const u = U_GRID[i];
    // u − i/2 as a complex pair
    const arg = [u, -0.5];
    const phi = kouCf(arg, params, S0, T, r, q);
    // e^(i·u·k) = (cos(u·k), sin(u·k))
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

// ------- BSM pricer + Newton inversion for IV ----------------------------

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

// ------- Reparameterization ----------------------------------------------
//
// theta = [log σ, log λ, logit p, log(η₁ − 1), log η₂]
//
// η₁ > 1 strictly so the upward jump has a finite first moment. Encoding
// η₁ as exp(theta₃) + 1 keeps that constraint while keeping the search
// unconstrained.
function unpack(theta) {
  return {
    sigma: Math.exp(theta[0]),
    lambda: Math.exp(theta[1]),
    p: 1 / (1 + Math.exp(-theta[2])),
    eta1: Math.exp(theta[3]) + 1,
    eta2: Math.exp(theta[4]),
  };
}
function pack(p) {
  const eta1Safe = Math.max(p.eta1, 1.001);
  return [
    Math.log(Math.max(p.sigma, 1e-4)),
    Math.log(Math.max(p.lambda, 1e-4)),
    Math.log(Math.max(p.p, 1e-6) / Math.max(1 - p.p, 1e-6)),
    Math.log(eta1Safe - 1),
    Math.log(Math.max(p.eta2, 1e-4)),
  ];
}

// ------- Nelder-Mead -----------------------------------------------------

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

// ------- Slice extraction ------------------------------------------------

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

function calibrateKou(slice, S0, T, r, q, init) {
  const obj = (theta) => {
    const p = unpack(theta);
    if (p.sigma > 1.5 || p.lambda > 30 || p.eta1 > 200 || p.eta2 > 200) return 1e6;
    let sse = 0;
    let n = 0;
    for (const { strike, iv } of slice) {
      const c = kouCall(p, S0, strike, T, r, q);
      const modelIv = bsmIv(c, S0, strike, T, r, q);
      if (modelIv == null || !Number.isFinite(modelIv)) return 1e6;
      const d = modelIv - iv;
      sse += d * d;
      n++;
    }
    return n > 0 ? sse / n : 1e6;
  };
  const x0 = pack(init);
  const res = nelderMead(obj, x0, { maxIters: NM_MAX_ITERS, tol: 1e-9, step: 0.2 });
  return { params: unpack(res.x), rmse: Math.sqrt(res.value) };
}

// Warm start. Equity-index typical shape: roughly 60/40 split between
// down-jumps and up-jumps with the down side fatter (smaller η₂),
// moderate intensity, and ~15% diffusion vol.
const INIT_PARAMS = {
  sigma: 0.13,
  lambda: 1.5,
  p: 0.4,
  eta1: 25,
  eta2: 12,
};

// ------- UI --------------------------------------------------------------

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

export default function SlotB() {
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
    return calibrateKou(slice, data.spotPrice, T, RATE_R, RATE_Q, INIT_PARAMS);
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
      const c = kouCall(calib.params, data.spotPrice, K, T, RATE_R, RATE_Q);
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
        name: 'Kou fit',
        line: { color: PLOTLY_COLORS.positive, width: 2 },
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
        ...plotlyTitle('Kou Smile Fit · SPX'),
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
  // Average jump size in percent terms. Up = 1/η₁; down = −1/η₂.
  const upMean = calib ? 1 / calib.params.eta1 : null;
  const dnMean = calib ? -1 / calib.params.eta2 : null;
  const downHeavier = calib && Math.abs(dnMean) > Math.abs(upMean);

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
        kou · diffusion plus asymmetric exponential jumps · 5 parameters
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
          label="σ · diffusion"
          value={calib ? formatPct(calib.params.sigma, 2) : '-'}
          sub="ann. Brownian vol"
          accent={PLOTLY_COLORS.primary}
        />
        <StatCell
          label="λ · intensity"
          value={calib ? formatFixed(calib.params.lambda, 2) : '-'}
          sub="jumps per year"
          accent={PLOTLY_COLORS.highlight}
        />
        <StatCell
          label="p · up share"
          value={calib ? formatFixed(calib.params.p, 3) : '-'}
          sub="prob jump is up"
          accent={PLOTLY_COLORS.positive}
        />
        <StatCell
          label="1/η₁ · up size"
          value={upMean != null ? formatPct(upMean, 1) : '-'}
          sub="avg up log-jump"
        />
        <StatCell
          label="1/η₂ · dn size"
          value={dnMean != null ? formatPct(dnMean, 1) : '-'}
          sub="avg dn log-jump"
          accent={downHeavier ? PLOTLY_COLORS.secondary : undefined}
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
          Kou (2002) keeps Merton&apos;s compound Poisson scaffolding but
          replaces the single Gaussian jump distribution with an{' '}
          <strong style={{ color: PLOTLY_COLORS.positive }}>asymmetric double exponential</strong>.
          Up-jumps and down-jumps are drawn from two separate
          exponential distributions with their own rates. The model
          captures the well-documented stylized fact that equity crash
          jumps are larger than rally jumps in a way that one Gaussian
          cannot.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          Five parameters. The diffusion volatility{' '}
          <strong style={{ color: PLOTLY_COLORS.primary }}>σ</strong>{' '}
          and jump intensity{' '}
          <strong style={{ color: PLOTLY_COLORS.highlight }}>λ</strong>{' '}
          play the same roles as in Merton. The new pieces are{' '}
          <strong style={{ color: PLOTLY_COLORS.positive }}>p</strong>,
          the probability that a given jump is upward, and the rates{' '}
          <strong style={{ color: PLOTLY_COLORS.highlight }}>η₁</strong>{' '}
          and{' '}
          <strong style={{ color: PLOTLY_COLORS.secondary }}>η₂</strong>{' '}
          of the up and down exponential tails. Larger η means thinner
          tail. Equity calibrations almost always come back with η₂
          smaller than η₁, which is the asymmetric crash-risk premium
          written in the parameters.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          The characteristic function is closed-form. Pricing uses the
          Lewis (2001) single-integral inversion, which is numerically
          stable across all maturities. Calibration is a 5-parameter
          Nelder-Mead in IV-space against the same SPX slice the Merton
          model uses.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          <strong style={{ color: 'var(--text-primary)' }}>Reading.</strong>{' '}
          The{' '}
          <strong style={{ color: PLOTLY_COLORS.primary }}>blue dots</strong>{' '}
          are the chain&apos;s observed IVs. The{' '}
          <strong style={{ color: PLOTLY_COLORS.positive }}>green curve</strong>{' '}
          is the Kou fit. Where Merton uses a single symmetric Gaussian
          for jump sizes, Kou splits it into two asymmetric exponentials,
          which is why Kou tends to produce a steeper left wing on
          equity slices than Merton with the same number of effective
          parameters.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          The{' '}
          <strong style={{ color: PLOTLY_COLORS.positive }}>up share p</strong>{' '}
          is rarely close to 0.5 on SPX. A typical fit comes back with p
          well under half, meaning more than half of all jumps are
          downward. Combined with the average down-jump being larger
          than the average up-jump (1/η₂ &gt; 1/η₁), the model encodes
          the crash-risk asymmetry without needing stochastic vol.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          The asymmetry is not just empirical. The double exponential is
          the unique jump distribution that makes barrier and lookback
          options tractable in closed form, which is why Kou became the
          default jump model for path-dependent exotics. SPX vanilla
          calibration here is the same model in its smile-fitting role.
        </p>
        <p style={{ margin: 0 }}>
          Like Merton, Kou cannot produce the term-structure shape of
          the SPX surface from one slice. The single-slice fit captures
          today&apos;s smile but does not constrain how that smile
          evolves with maturity. The Bates SVJ model below is the
          combination that closes that gap.
        </p>
      </div>
    </div>
  );
}
