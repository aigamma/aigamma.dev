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
// Merton (1976) Jump Diffusion. The original "Black-Scholes plus jumps"
// model. The spot follows geometric Brownian motion with a compound
// Poisson overlay of log-normally distributed jumps:
//
//   dS/S = (r − q − λ·k)·dt + σ·dW + (Y − 1)·dN
//
// where N is a Poisson process with intensity λ per year, log Y ~
// N(μ_J, σ_J²) is the log jump size, and k = E[Y − 1] = exp(μ_J +
// σ_J²/2) − 1 is the compensator that keeps the discounted price a
// martingale under the risk-neutral measure.
//
// The European call price is a Poisson-weighted infinite series of
// Black-Scholes prices, each priced with a per-n adjusted spot and
// per-n adjusted variance:
//
//   C = Σ_{n=0}^∞  e^(-λ'·T) · (λ'·T)^n / n!  ·  BSM(S_n, K, T, r_n, σ_n)
//
//   λ' = λ·(1 + k)
//   r_n = r − λ·k + n·(μ_J + σ_J²/2) / T
//   σ_n² = σ² + n·σ_J² / T
//
// Series converges fast in practice. n up to 60 is more than enough
// for any sensible λ·T on equity-index time scales (λ·T < 5 here).
//
// Five free parameters (σ, λ, μ_J, σ_J, [r,q fixed]). Calibrated by
// Nelder-Mead on IV-space residuals against a single SPX expiration
// slice, identical observation set to the Stochastic Vol Lab Slot A.
// -----------------------------------------------------------------------------

const RATE_R = 0.045;
const RATE_Q = 0.013;
const N_TERMS = 60;
const NM_MAX_ITERS = 220;

// Pre-computed log factorials: log(n!) for n = 0..N_TERMS-1.
const LOG_FACT = (() => {
  const out = new Float64Array(N_TERMS);
  let acc = 0;
  out[0] = 0;
  for (let n = 1; n < N_TERMS; n++) {
    acc += Math.log(n);
    out[n] = acc;
  }
  return out;
})();

// ------- BSM pricer + Newton inversion for IV -----------------------------

function phi(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}
function Phi(x) {
  // Abramowitz-Stegun 26.2.17. ~7-digit accuracy, fast and stable.
  const a1 = 0.31938153;
  const a2 = -0.356563782;
  const a3 = 1.781477937;
  const a4 = -1.821255978;
  const a5 = 1.330274429;
  const k = 1 / (1 + 0.2316419 * Math.abs(x));
  const w = 1 - phi(x) * (a1*k + a2*k*k + a3*k*k*k + a4*k*k*k*k + a5*k*k*k*k*k);
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
  return S * Math.exp(-q * T) * phi(d1) * Math.sqrt(T);
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

// ------- Merton call price -----------------------------------------------

function mertonCall(params, S0, K, T, r, q) {
  const { sigma, lambda, muJ, sigmaJ } = params;
  // k = E[Y − 1] = exp(μ_J + σ_J²/2) − 1
  const k = Math.exp(muJ + 0.5 * sigmaJ * sigmaJ) - 1;
  const lambdaT = lambda * T;
  let price = 0;
  // Truncate when the Poisson tail is negligibly small.
  for (let n = 0; n < N_TERMS; n++) {
    // log(p_n) = -λT + n·log(λT) - log(n!)
    const logP = -lambdaT + n * Math.log(Math.max(lambdaT, 1e-300)) - LOG_FACT[n];
    if (logP < -32 && n > 5) break;
    const weight = Math.exp(logP);
    const sigmaN = Math.sqrt(sigma * sigma + (n * sigmaJ * sigmaJ) / T);
    const rN = r - lambda * k + (n * (muJ + 0.5 * sigmaJ * sigmaJ)) / T;
    price += weight * bsmCall(S0, K, T, rN, q, sigmaN);
  }
  return price;
}

// ------- Reparameterization (unconstrained <-> constrained) ---------------

function unpack(theta) {
  // theta = [log σ, log λ, μ_J (free real), log σ_J]
  return {
    sigma: Math.exp(theta[0]),
    lambda: Math.exp(theta[1]),
    muJ: theta[2],
    sigmaJ: Math.exp(theta[3]),
  };
}
function pack(p) {
  return [
    Math.log(Math.max(p.sigma, 1e-4)),
    Math.log(Math.max(p.lambda, 1e-4)),
    p.muJ,
    Math.log(Math.max(p.sigmaJ, 1e-4)),
  ];
}

// ------- Nelder-Mead simplex (Gao-Han 2012 adaptive coefficients) --------

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

// ------- Slice extraction -------------------------------------------------

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

// ------- Calibration objective -------------------------------------------

function calibrateMerton(slice, S0, T, r, q, init) {
  const obj = (theta) => {
    const p = unpack(theta);
    if (p.sigma > 1.5 || p.lambda > 30 || p.sigmaJ > 1) return 1e6;
    if (p.muJ < -2 || p.muJ > 1) return 1e6;
    let sse = 0;
    let n = 0;
    for (const { strike, iv } of slice) {
      const c = mertonCall(p, S0, strike, T, r, q);
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

// Warm start. SPX-style negative jump mean, moderate jump sd, ~1 jump
// per year with diffusion vol around the historical norm. The simplex
// reaches the basin from this seed for almost any monthly slice.
const INIT_PARAMS = {
  sigma: 0.15,
  lambda: 1.0,
  muJ: -0.10,
  sigmaJ: 0.15,
};

// ------- UI ---------------------------------------------------------------

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

  const calib = useMemo(() => {
    if (!data || !activeExp || slice.length < 6 || !T || T <= 0) return null;
    return calibrateMerton(slice, data.spotPrice, T, RATE_R, RATE_Q, INIT_PARAMS);
  }, [data, activeExp, slice, T]);

  useEffect(() => {
    if (!Plotly || !chartRef.current || !calib || slice.length === 0 || !T || !data) return;

    const strikes = slice.map((r) => r.strike);
    const ivs = slice.map((r) => r.iv * 100);
    const K_lo = Math.min(...strikes);
    const K_hi = Math.max(...strikes);
    const nGrid = 80;
    const gridK = new Array(nGrid);
    const gridIv = new Array(nGrid);
    for (let i = 0; i < nGrid; i++) {
      const K = K_lo + (i / (nGrid - 1)) * (K_hi - K_lo);
      gridK[i] = K;
      const c = mertonCall(calib.params, data.spotPrice, K, T, RATE_R, RATE_Q);
      const iv = bsmIv(c, data.spotPrice, K, T, RATE_R, RATE_Q);
      gridIv[i] = iv != null ? iv * 100 : null;
    }

    // Diffusion-only counterfactual. Same calibrated diffusion vol σ but
    // λ = 0. Lets the reader see exactly how much smile is jump-driven.
    const noJumpParams = { ...calib.params, lambda: 0 };
    const gridIvNoJump = new Array(nGrid);
    for (let i = 0; i < nGrid; i++) {
      const c = mertonCall(noJumpParams, data.spotPrice, gridK[i], T, RATE_R, RATE_Q);
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
        name: 'Merton fit',
        line: { color: PLOTLY_COLORS.highlight, width: 2 },
        hoverinfo: 'skip',
        connectgaps: false,
      },
      {
        x: gridK,
        y: gridIvNoJump,
        mode: 'lines',
        name: 'diffusion-only · λ = 0',
        line: { color: PLOTLY_COLORS.axisText, width: 1, dash: 'dash' },
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
        ...plotlyTitle('Merton Jump Fit · SPX'),
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

  // Expected jump per year: λ · k where k = e^(μ_J + σ_J²/2) − 1.
  const k = calib ? Math.exp(calib.params.muJ + 0.5 * calib.params.sigmaJ ** 2) - 1 : null;
  const jumpDrag = calib ? calib.params.lambda * k : null;

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
        merton · diffusion plus log-normal jumps · 4 free parameters
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
          label="μ_J · log mean"
          value={calib ? formatFixed(calib.params.muJ, 3) : '-'}
          sub="avg log jump size"
          accent={calib && calib.params.muJ < -0.05 ? PLOTLY_COLORS.secondary : undefined}
        />
        <StatCell
          label="σ_J · log sd"
          value={calib ? formatFixed(calib.params.sigmaJ, 3) : '-'}
          sub="jump dispersion"
        />
        <StatCell
          label="λ·k · drift drag"
          value={jumpDrag != null ? formatPct(jumpDrag, 2) : '-'}
          sub="jump compensator"
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
          Merton (1976) is the original answer to a problem Black-Scholes
          could not solve. Constant-vol diffusion is too smooth. Real index
          returns have heavy tails and an obvious left skew that no
          single-σ lognormal can produce. Merton overlays a{' '}
          <strong style={{ color: PLOTLY_COLORS.highlight }}>compound Poisson process</strong>{' '}
          on top of GBM, so the spot occasionally takes a discrete jump
          sized log-normally.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          Four free parameters do the work. The diffusion volatility{' '}
          <strong style={{ color: PLOTLY_COLORS.primary }}>σ</strong>{' '}
          sets the day-to-day Brownian noise. The jump intensity{' '}
          <strong style={{ color: PLOTLY_COLORS.highlight }}>λ</strong>{' '}
          counts expected jumps per year. The jump-size distribution is
          log-normal with{' '}
          <strong style={{ color: PLOTLY_COLORS.secondary }}>mean μ_J</strong>{' '}
          and{' '}
          <strong style={{ color: PLOTLY_COLORS.secondary }}>standard deviation σ_J</strong>{' '}
          in log space. A negative μ_J means jumps are crashes on average.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          The European call price is a Poisson-weighted infinite series of
          Black-Scholes calls, each priced with a per-jump-count adjusted
          spot drift and variance. The series converges fast. Calibration
          is a 4-parameter Nelder-Mead in IV-space against the same SPX
          slice the Stochastic Vol Lab uses, so the smiles can be compared
          side by side across labs.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          <strong style={{ color: 'var(--text-primary)' }}>Reading.</strong>{' '}
          The{' '}
          <strong style={{ color: PLOTLY_COLORS.primary }}>blue dots</strong>{' '}
          are the chain&apos;s observed IVs, OTM puts below spot and OTM
          calls above. The{' '}
          <strong style={{ color: PLOTLY_COLORS.highlight }}>amber curve</strong>{' '}
          is the Merton fit. The{' '}
          <strong style={{ color: 'var(--text-secondary)' }}>dashed grey</strong>{' '}
          line is the same calibrated σ but with the jump component switched
          off, so the visible gap between amber and grey is precisely the
          smile that the jump component contributes.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          A strongly negative μ_J means the market is pricing in
          asymmetric crash risk. The combination of a sizeable λ and a
          negative μ_J is what generates the steep left wing on a single
          slice without needing stochastic vol.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          Where Merton struggles is the term structure. A constant λ
          and constant σ cannot bend the smile at one tenor without
          flattening it at another. That motivates the Bates SVJ model
          below, which adds Heston-style stochastic variance underneath
          the same Merton jump overlay.
        </p>
        <p style={{ margin: 0 }}>
          The drift drag column reports λ·k, the risk-neutral
          compensator that subtracts itself from the GBM drift to keep
          the discounted spot a martingale under the jump-augmented
          measure. It is the part of the expected return that exists
          purely to offset the jump component, not a real predicted
          return.
        </p>
      </div>
    </div>
  );
}
