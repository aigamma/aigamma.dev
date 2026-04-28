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
import { daysToExpiration, filterPickerExpirations } from '../../src/lib/dates';
import { fitSviSlice, sviTotalVariance } from '../../src/lib/svi';

// -----------------------------------------------------------------------------
// SSVI · Surface SVI (Gatheral and Jacquier 2014).
//
// The SVI slots C, D, E fit one expiration at a time. Nothing in those fits
// prevents two neighboring tenors from drifting into a calendar arbitrage
// where the earlier slice implies higher total variance at some k than the
// later slice. Calendar arbitrage across slices is a real problem in
// production vol surfaces: any two-expiration calendar spread has a
// sign-free, model-free lower bound on price that slice-fitting can violate
// silently.
//
// SSVI collapses the five-parameter-per-slice problem into one global triple
// and a per-tenor scalar:
//
//     w(k, θ_t) = (θ_t / 2) * { 1 + ρ φ(θ_t) k
//                                 + sqrt( (φ(θ_t) k + ρ)^2 + (1 - ρ^2) ) }
//
// where:
//   θ_t          is the ATM total variance at tenor t (the only per-tenor
//                degree of freedom; read off the smile at k = 0)
//   ρ            is a single global correlation used across every slice
//   φ : R+ -> R+ is a single global function that controls how the smile
//                reshapes as tenor increases
//
// Three parameters describe the whole surface apart from θ_t. On the
// power-law choice of φ,
//
//     φ(θ) = η / ( θ^γ * (1 + θ)^(1 - γ) )
//
// where 0 < γ < 1 controls the short-tenor decay rate and η > 0 controls
// the overall scale. Every SSVI surface of this family is calendar-
// arbitrage-free as long as θ_t is non-decreasing in t and φ is non-
// increasing in θ, and is butterfly-arbitrage-free as long as
//
//     θ * φ(θ) * (1 + |ρ|) <= 4
//
// holds on every relevant θ. Those are hard guarantees by construction,
// not after-the-fact checks like Durrleman's g on a slice fit.
//
// The tradeoff. Each per-slice SSVI curve is a subset of the raw SVI
// family, so the per-slice residual is at best as good as raw SVI and
// usually worse. SSVI buys global consistency at the cost of local fit
// quality. That is the right trade for a production surface consumed by
// dozens of downstream products, and the wrong trade for a single-desk
// quoting rig that only cares about today's two liquid monthlies.
//
// The slot below fits SSVI jointly across several near-term expirations,
// overlays the SSVI curves on the observed smile for each tenor, and
// reports ρ, η, γ, per-slice RMSE, and the arb-free diagnostics.
// -----------------------------------------------------------------------------

// ρ in (-1, 1), η > 0, γ in (0, 1).  Reparameterize to unbounded u-space so
// the Nelder-Mead solver below cannot wander into inadmissible territory.
function uToParams([u0, u1, u2]) {
  return {
    rho: Math.tanh(u0),
    eta: Math.exp(u1),
    gamma: 1 / (1 + Math.exp(-u2)),
  };
}
function paramsToU({ rho, eta, gamma }) {
  const r = Math.max(Math.min(rho, 0.999), -0.999);
  const g = Math.max(Math.min(gamma, 0.999), 0.001);
  return [
    0.5 * Math.log((1 + r) / (1 - r)),
    Math.log(Math.max(eta, 1e-6)),
    Math.log(g / (1 - g)),
  ];
}

function phiPower(theta, { eta, gamma }) {
  if (theta <= 0) return 0;
  return eta / (Math.pow(theta, gamma) * Math.pow(1 + theta, 1 - gamma));
}

function ssviTotalVariance(theta, k, { rho, eta, gamma }) {
  if (theta <= 0) return 0;
  const phi = phiPower(theta, { eta, gamma });
  const x = phi * k;
  const discriminant = (x + rho) * (x + rho) + (1 - rho * rho);
  return (theta / 2) * (1 + rho * x + Math.sqrt(discriminant));
}

// Generic Nelder-Mead for a small unconstrained minimization problem.
// Straightforward textbook implementation. Good enough for the 3-parameter
// SSVI fit; not appropriate for the 5-parameter raw SVI slice fit, which is
// why src/lib/svi.js uses Levenberg-Marquardt with analytic Jacobian.
function nelderMead(f, x0, { maxIter = 600, tol = 1e-8, step = 0.3 } = {}) {
  const n = x0.length;
  const alpha = 1;
  const gammaCoef = 2;
  const rhoCoef = 0.5;
  const sigma = 0.5;

  let simplex = [x0.slice()];
  for (let i = 0; i < n; i++) {
    const p = x0.slice();
    p[i] += x0[i] === 0 ? step : step * Math.max(Math.abs(x0[i]), 0.1);
    simplex.push(p);
  }
  let values = simplex.map(f);
  let iter = 0;

  for (; iter < maxIter; iter++) {
    const order = [...Array(n + 1).keys()].sort((a, b) => values[a] - values[b]);
    const best = order[0];
    const worst = order[n];
    const secondWorst = order[n - 1];

    // Convergence: shrink of function values across simplex.
    const spread = Math.abs(values[worst] - values[best]);
    if (spread < tol * (1 + Math.abs(values[best]))) break;

    const centroid = new Array(n).fill(0);
    for (let i = 0; i <= n; i++) {
      if (i === worst) continue;
      for (let j = 0; j < n; j++) centroid[j] += simplex[i][j] / n;
    }

    const xR = centroid.map((c, j) => c + alpha * (c - simplex[worst][j]));
    const fR = f(xR);

    if (values[best] <= fR && fR < values[secondWorst]) {
      simplex[worst] = xR;
      values[worst] = fR;
      continue;
    }
    if (fR < values[best]) {
      const xE = centroid.map((c, j) => c + gammaCoef * (xR[j] - c));
      const fE = f(xE);
      if (fE < fR) {
        simplex[worst] = xE;
        values[worst] = fE;
      } else {
        simplex[worst] = xR;
        values[worst] = fR;
      }
      continue;
    }
    const xC = centroid.map((c, j) => c + rhoCoef * (simplex[worst][j] - c));
    const fC = f(xC);
    if (fC < values[worst]) {
      simplex[worst] = xC;
      values[worst] = fC;
      continue;
    }
    for (let i = 0; i <= n; i++) {
      if (i === best) continue;
      simplex[i] = simplex[best].map((b, j) => b + sigma * (simplex[i][j] - b));
      values[i] = f(simplex[i]);
    }
  }

  const order = [...Array(n + 1).keys()].sort((a, b) => values[a] - values[b]);
  return { x: simplex[order[0]], fx: values[order[0]], iterations: iter };
}

// Fit SSVI (ρ, η, γ) jointly across the provided per-slice sample sets.
// Each perSlice entry supplies { theta, T, samples: [{k, iv, weight}] }. The
// objective is weighted IV-space SSE summed across tenors, so slices with
// more liquid strikes contribute more to the fit, which matches how desks
// weight a surface calibration.
function fitSsvi(perSlice) {
  const objective = (u) => {
    const p = uToParams(u);
    let sse = 0;
    let count = 0;
    for (const slice of perSlice) {
      const T = slice.T;
      const theta = slice.theta;
      if (!(T > 0) || !(theta > 0)) continue;
      for (const s of slice.samples) {
        const w = ssviTotalVariance(theta, s.k, p);
        if (!(w > 0)) continue;
        const ivModel = Math.sqrt(w / T);
        const diff = ivModel - s.iv;
        sse += (s.weight ?? 1) * diff * diff;
        count++;
      }
    }
    if (count === 0) return Infinity;
    return sse / count;
  };

  // Multi-start: SSVI is non-convex in (ρ, η, γ). A few well-spread seeds
  // covering the equity-skew region produce a more reliable global fit.
  const seeds = [
    { rho: -0.7, eta: 1.5, gamma: 0.5 },
    { rho: -0.5, eta: 1.0, gamma: 0.4 },
    { rho: -0.9, eta: 2.0, gamma: 0.6 },
    { rho: -0.3, eta: 1.0, gamma: 0.3 },
    { rho: -0.75, eta: 1.2, gamma: 0.45 },
  ];

  let best = null;
  for (const seed of seeds) {
    const u0 = paramsToU(seed);
    const result = nelderMead(objective, u0);
    if (!best || result.fx < best.fx) best = result;
  }
  return { params: uToParams(best.x), mse: best.fx, iterations: best.iterations };
}

// Arbitrage diagnostics. Calendar-arb-free holds automatically when θ_t is
// non-decreasing in tenor and φ is non-increasing in θ. Butterfly-arb-free
// on each slice requires θ * φ(θ) * (1 + |ρ|) <= 4; the largest left-hand
// side on the fitted tenors is the headline number.
function computeArbDiagnostics(perSlice, params) {
  const sorted = [...perSlice].sort((a, b) => a.T - b.T);
  let calendarFree = true;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].theta < sorted[i - 1].theta - 1e-10) {
      calendarFree = false;
      break;
    }
  }
  let maxBfyLhs = 0;
  let maxBfyAtTheta = 0;
  for (const s of sorted) {
    const phi = phiPower(s.theta, params);
    const lhs = s.theta * phi * (1 + Math.abs(params.rho));
    if (lhs > maxBfyLhs) {
      maxBfyLhs = lhs;
      maxBfyAtTheta = s.theta;
    }
  }
  return {
    calendarFree,
    butterflyLhs: maxBfyLhs,
    butterflyAtTheta: maxBfyAtTheta,
    butterflyFree: maxBfyLhs <= 4 + 1e-6,
  };
}

// --------- UI helpers ---------------------------------------------------

function formatFixed(v, d = 3) {
  if (v == null || !Number.isFinite(v)) return '-';
  return v.toFixed(d);
}
function formatPct(v, d = 2) {
  if (v == null || !Number.isFinite(v)) return '-';
  return `${(v * 100).toFixed(d)}%`;
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

// Evenly-spaced perceptually-ordered color palette for the tenor overlays.
// Six colors so the chart can fit up to six tenors without palette collision.
const TENOR_PALETTE = [
  '#4a9eff', // primary blue -- shortest
  '#93c5fd', // primary soft
  '#2ecc71', // positive green
  '#f1c40f', // highlight amber
  '#f0a030', // accent amber
  '#e74c3c', // secondary coral -- longest
];

// Pick up to six expirations spread across the tenor range: skip 0DTE,
// include one in each of the short/medium/long bucket plus the two longest
// monthlies if available. This keeps the overlay chart readable while
// still showing how the surface stretches out in tenor.
function pickTenors(expirations, capturedAt, target = 6) {
  if (!expirations?.length) return [];
  const filtered = filterPickerExpirations(expirations, capturedAt);
  const withDte = filtered
    .map((e) => ({ exp: e, dte: daysToExpiration(e, capturedAt) }))
    .filter((x) => x.dte != null && x.dte > 0.5)
    .sort((a, b) => a.dte - b.dte);
  if (withDte.length === 0) return [];
  if (withDte.length <= target) return withDte.map((x) => x.exp);
  // Log-scale spacing so short tenors are not overrepresented.
  const logDtes = withDte.map((x) => Math.log(Math.max(x.dte, 0.5)));
  const logMin = logDtes[0];
  const logMax = logDtes[logDtes.length - 1];
  const picked = new Set();
  for (let i = 0; i < target; i++) {
    const t = i / (target - 1);
    const logTarget = logMin + t * (logMax - logMin);
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let j = 0; j < withDte.length; j++) {
      const d = Math.abs(logDtes[j] - logTarget);
      if (d < bestDist && !picked.has(j)) {
        bestDist = d;
        bestIdx = j;
      }
    }
    picked.add(bestIdx);
  }
  return [...picked].sort((a, b) => a - b).map((idx) => withDte[idx].exp);
}

export default function SlotF() {
  const chartRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();
  const mobile = useIsMobile();
  const { data, loading, error } = useOptionsData({
    underlying: 'SPX',
    snapshotType: 'intraday',
  });

  const [maxSlices, setMaxSlices] = useState(6);

  const tenors = useMemo(() => {
    if (!data?.expirations || !data?.capturedAt) return [];
    return pickTenors(data.expirations, data.capturedAt, maxSlices);
  }, [data, maxSlices]);

  // Per-slice raw SVI fits give us θ_t and a clean set of vega-weighted (k, iv)
  // samples on the tenor-scaled window. SSVI is then a global reparameterization
  // that reuses those samples; fitting SSVI against raw SVI's own samples keeps
  // the tenor coverage and weighting consistent with Slots C/D/E.
  const perSlice = useMemo(() => {
    if (!data || !tenors.length || !(data.spotPrice > 0)) return [];
    const results = [];
    for (const exp of tenors) {
      const slice = data.contracts.filter((c) => c.expiration_date === exp);
      if (slice.length < 8) continue;
      const fit = fitSviSlice({
        contracts: slice,
        spotPrice: data.spotPrice,
        expirationDate: exp,
        capturedAt: data.capturedAt,
      });
      if (!fit.ok) continue;
      const theta = sviTotalVariance(fit.params, 0);
      if (!(theta > 0)) continue;
      const dte = daysToExpiration(exp, data.capturedAt);
      results.push({
        expirationDate: exp,
        dte,
        T: fit.T,
        theta,
        rawParams: fit.params,
        rawRmseIv: fit.rmseIv,
        samples: fit.samples,
        tenorWindow: fit.tenorWindow,
      });
    }
    return results.sort((a, b) => a.T - b.T);
  }, [data, tenors]);

  const ssvi = useMemo(() => {
    if (perSlice.length < 2) return null;
    const { params, mse } = fitSsvi(perSlice);
    // Per-slice IV-RMSE for SSVI fit.
    const slicePerf = perSlice.map((slice) => {
      let sse = 0;
      let count = 0;
      for (const s of slice.samples) {
        const w = ssviTotalVariance(slice.theta, s.k, params);
        if (!(w > 0)) continue;
        const ivModel = Math.sqrt(w / slice.T);
        const diff = ivModel - s.iv;
        sse += diff * diff;
        count++;
      }
      const ssviRmse = count > 0 ? Math.sqrt(sse / count) : null;
      return {
        ...slice,
        ssviRmse,
        rawRmseIv: slice.rawRmseIv,
      };
    });
    let globalSse = 0;
    let globalCount = 0;
    for (const slice of slicePerf) {
      for (const s of slice.samples) {
        const w = ssviTotalVariance(slice.theta, s.k, params);
        if (!(w > 0)) continue;
        const ivModel = Math.sqrt(w / slice.T);
        const diff = ivModel - s.iv;
        globalSse += diff * diff;
        globalCount++;
      }
    }
    const globalRmse = globalCount > 0 ? Math.sqrt(globalSse / globalCount) : null;
    const arb = computeArbDiagnostics(perSlice, params);
    return { params, mse, slicePerf, globalRmse, arb };
  }, [perSlice]);

  useEffect(() => {
    if (!Plotly || !chartRef.current || !ssvi || ssvi.slicePerf.length === 0) return;

    const traces = [];
    // Plot range: widest tenor window across the fitted slices, plus 10%.
    const widest = Math.max(...ssvi.slicePerf.map((s) => s.tenorWindow));
    const kLo = -widest * 1.05;
    const kHi = widest * 1.05;
    const nGrid = 201;

    ssvi.slicePerf.forEach((slice, idx) => {
      const color = TENOR_PALETTE[idx % TENOR_PALETTE.length];
      const dteLabel = slice.dte != null ? `${slice.dte.toFixed(0)}d` : '';
      // Observed IVs (markers).
      traces.push({
        x: slice.samples.map((s) => s.k),
        y: slice.samples.map((s) => s.iv * 100),
        mode: 'markers',
        name: `${slice.expirationDate} · ${dteLabel} · obs`,
        marker: { color, size: mobile ? 5 : 7, opacity: 0.7 },
        hovertemplate: `${slice.expirationDate}<br>k %{x:.3f}<br>σ %{y:.2f}%<extra></extra>`,
        legendgroup: slice.expirationDate,
      });
      // SSVI curve (solid line).
      const gridK = new Array(nGrid);
      const gridSigma = new Array(nGrid);
      for (let i = 0; i < nGrid; i++) {
        const k = kLo + (i / (nGrid - 1)) * (kHi - kLo);
        gridK[i] = k;
        const w = ssviTotalVariance(slice.theta, k, ssvi.params);
        gridSigma[i] = w > 0 ? Math.sqrt(w / slice.T) * 100 : null;
      }
      traces.push({
        x: gridK,
        y: gridSigma,
        mode: 'lines',
        name: `${slice.expirationDate} · ${dteLabel} · SSVI`,
        line: { color, width: 2 },
        hoverinfo: 'skip',
        connectgaps: false,
        legendgroup: slice.expirationDate,
        showlegend: false,
      });
    });

    // Vertical zero-line (forward).
    const allSigma = [];
    for (const slice of ssvi.slicePerf) {
      for (const s of slice.samples) allSigma.push(s.iv * 100);
    }
    const yMin = Math.min(...allSigma);
    const yMax = Math.max(...allSigma);
    const pad = (yMax - yMin) * 0.15 || 1;
    traces.push({
      x: [0, 0],
      y: [yMin - pad, yMax + pad],
      mode: 'lines',
      name: 'forward (k=0)',
      line: { color: PLOTLY_COLORS.axisText, width: 1, dash: 'dot' },
      hoverinfo: 'skip',
      showlegend: false,
    });

    const layout = plotly2DChartLayout({
      title: {
        ...plotlyTitle(
          mobile
            ? 'SSVI · Joint Surface Fit<br>Across Tenors'
            : 'SSVI · Joint Surface Fit Across Tenors'
        ),
        y: 0.97,
        yref: 'container',
        yanchor: 'top',
      },
      margin: mobile ? { t: 75, r: 25, b: 140, l: 60 } : { t: 70, r: 35, b: 160, l: 75 },
      xaxis: plotlyAxis('Log-Moneyness k = ln(K/F)', {
        range: [kLo, kHi],
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
        y: -0.28,
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
  }, [Plotly, ssvi, mobile]);

  if (loading && !data) {
    return (
      <div className="lab-placeholder">
        <div className="lab-placeholder-title">Loading chain…</div>
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
        ssvi · joint surface fit across tenors
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
          Max tenors:
        </label>
        <select
          value={maxSlices}
          onChange={(e) => setMaxSlices(Number(e.target.value))}
          style={{
            background: 'var(--bg-card)',
            color: 'var(--text-primary)',
            border: '1px solid var(--bg-card-border)',
            padding: '0.3rem 0.5rem',
            fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
            fontSize: '0.85rem',
          }}
        >
          {[3, 4, 5, 6].map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
        <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
          slices fitted {ssvi?.slicePerf?.length ?? 0} · log-DTE spaced across the liquid expirations
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
          label="ρ · global skew"
          value={ssvi ? formatFixed(ssvi.params.rho, 3) : '-'}
          sub="one number, all tenors"
          accent={PLOTLY_COLORS.secondary}
        />
        <StatCell
          label="η · φ scale"
          value={ssvi ? formatFixed(ssvi.params.eta, 3) : '-'}
          sub="overall slope magnitude"
          accent={PLOTLY_COLORS.highlight}
        />
        <StatCell
          label="γ · φ decay"
          value={ssvi ? formatFixed(ssvi.params.gamma, 3) : '-'}
          sub="how fast smile flattens"
          accent={PLOTLY_COLORS.positive}
        />
        <StatCell
          label="σ · global RMSE"
          value={ssvi?.globalRmse != null ? formatPct(ssvi.globalRmse, 3) : '-'}
          sub="IV space, all slices"
          accent={PLOTLY_COLORS.primary}
        />
        <StatCell
          label="bfy · θφ(1+|ρ|)"
          value={ssvi?.arb ? formatFixed(ssvi.arb.butterflyLhs, 3) : '-'}
          sub={ssvi?.arb?.butterflyFree ? 'under 4 · arb-free' : 'OVER 4 · check'}
          accent={
            ssvi?.arb?.butterflyFree
              ? PLOTLY_COLORS.positive
              : PLOTLY_COLORS.secondary
          }
        />
        <StatCell
          label="calendar"
          value={
            ssvi?.arb
              ? ssvi.arb.calendarFree
                ? 'arb-free'
                : 'violated'
              : '-'
          }
          sub="θ_t monotone in T"
          accent={
            ssvi?.arb?.calendarFree
              ? PLOTLY_COLORS.positive
              : PLOTLY_COLORS.secondary
          }
        />
      </div>

      <div ref={chartRef} style={{ width: '100%', height: mobile ? 460 : 560 }} />

      {ssvi?.slicePerf?.length > 0 && (
        <div
          style={{
            marginTop: '1rem',
            borderTop: '1px solid var(--bg-card-border)',
            paddingTop: '0.75rem',
          }}
        >
          <div
            style={{
              fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
              fontSize: '0.7rem',
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--text-secondary)',
              marginBottom: '0.5rem',
            }}
          >
            per-slice RMSE · SSVI vs raw SVI
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table
              style={{
                width: '100%',
                fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
                fontSize: '0.82rem',
                borderCollapse: 'collapse',
              }}
            >
              <thead>
                <tr style={{ color: 'var(--text-secondary)', textAlign: 'left' }}>
                  <th style={{ padding: '0.3rem 0.6rem 0.3rem 0' }}>expiry</th>
                  <th style={{ padding: '0.3rem 0.6rem' }}>dte</th>
                  <th style={{ padding: '0.3rem 0.6rem' }}>θ_t</th>
                  <th style={{ padding: '0.3rem 0.6rem' }}>φ(θ_t)</th>
                  <th style={{ padding: '0.3rem 0.6rem' }}>raw SVI RMSE</th>
                  <th style={{ padding: '0.3rem 0.6rem' }}>SSVI RMSE</th>
                  <th style={{ padding: '0.3rem 0.6rem' }}>gap</th>
                </tr>
              </thead>
              <tbody>
                {ssvi.slicePerf.map((slice, idx) => {
                  const color = TENOR_PALETTE[idx % TENOR_PALETTE.length];
                  const gap =
                    slice.ssviRmse != null && slice.rawRmseIv != null
                      ? slice.ssviRmse - slice.rawRmseIv
                      : null;
                  return (
                    <tr
                      key={slice.expirationDate}
                      style={{ borderTop: '1px solid var(--bg-card-border)' }}
                    >
                      <td style={{ padding: '0.3rem 0.6rem 0.3rem 0', color }}>
                        {slice.expirationDate}
                      </td>
                      <td style={{ padding: '0.3rem 0.6rem' }}>
                        {slice.dte != null ? slice.dte.toFixed(1) : '-'}
                      </td>
                      <td style={{ padding: '0.3rem 0.6rem' }}>
                        {formatFixed(slice.theta, 4)}
                      </td>
                      <td style={{ padding: '0.3rem 0.6rem' }}>
                        {formatFixed(phiPower(slice.theta, ssvi.params), 3)}
                      </td>
                      <td style={{ padding: '0.3rem 0.6rem' }}>
                        {slice.rawRmseIv != null ? formatPct(slice.rawRmseIv, 3) : '-'}
                      </td>
                      <td style={{ padding: '0.3rem 0.6rem' }}>
                        {slice.ssviRmse != null ? formatPct(slice.ssviRmse, 3) : '-'}
                      </td>
                      <td
                        style={{
                          padding: '0.3rem 0.6rem',
                          color:
                            gap == null
                              ? 'var(--text-secondary)'
                              : gap > 0.01
                              ? PLOTLY_COLORS.secondary
                              : PLOTLY_COLORS.axisText,
                        }}
                      >
                        {gap != null ? `+${formatPct(gap, 3)}` : '-'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div
        style={{
          marginTop: '0.9rem',
          fontSize: '0.9rem',
          color: 'var(--text-secondary)',
          lineHeight: 1.65,
        }}
      >
        <p style={{ margin: '0 0 0.75rem' }}>
          SSVI fits one{' '}
          <strong style={{ color: PLOTLY_COLORS.secondary }}>ρ</strong>,
          one scale{' '}
          <strong style={{ color: PLOTLY_COLORS.highlight }}>η</strong>,
          and one decay{' '}
          <strong style={{ color: PLOTLY_COLORS.positive }}>γ</strong>{' '}
          across the entire surface, and lets the per-tenor ATM total
          variance{' '}
          <strong style={{ color: PLOTLY_COLORS.primary }}>θ_t</strong>{' '}
          be the only slice-specific number. Three global parameters for
          the whole smile, one scalar per tenor. That is the entire
          surface.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          This is the opposite end of the fitting spectrum from Slots C,
          D, and E. Those are per-slice fits: five parameters per tenor,
          each slice free to drift independently. SSVI trades local fit
          quality for global consistency. On the calendar side the
          consistency is a hard guarantee: every two-slice calendar
          spread inside the fitted surface is free of arbitrage by
          construction, as long as θ_t is non-decreasing in tenor and
          the fitted φ is non-increasing in θ.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          The chart above overlays observed IVs (markers) and the SSVI curve
          (line) for up to six tenors, color-coded from{' '}
          <strong style={{ color: TENOR_PALETTE[0] }}>shortest blue</strong>{' '}
          to{' '}
          <strong style={{ color: TENOR_PALETTE[5] }}>longest coral</strong>.
          Gaps between observed markers and SSVI lines are the cost of
          the global fit: where raw SVI could bend a slice exactly onto
          its own data, SSVI has to compromise that slice to keep every
          other slice consistent with the same ρ and φ.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          <strong style={{ color: 'var(--text-primary)' }}>Reading the fit.</strong>{' '}
          ρ is the single global skew. For SPX, a healthy fit sits in the
          range [−0.8, −0.5] most days, tightening toward zero only
          during very short-dated compression events. η and γ jointly
          describe how the smile decays with tenor: higher η means fatter
          wings overall, higher γ means the decay concentrates in the
          short end rather than being spread evenly across the surface.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          The per-slice RMSE table quantifies the price SSVI pays for
          global consistency. The gap column is SSVI RMSE minus raw SVI
          RMSE on the same slice. If a tenor shows a gap larger than
          about 1% IV it is a tenor that raw SVI is bending its shape to
          fit something that SSVI's shared (ρ, η, γ) refuses to bend for.
          Usually the offender is a very short-dated slice where the
          butterfly shape is distorted by pin-risk, or a very long-dated
          slice where the wing data is too sparse to constrain either
          fit. Large gaps are a signal to check the slice-level data
          quality, not a signal that SSVI is wrong.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          The butterfly arb diagnostic reports
          max<sub>t</sub> θ_t · φ(θ_t) · (1 + |ρ|). The sufficient
          condition for butterfly-arb-free on every fitted slice is that
          this quantity stays under 4. A value in the 2-3 range is typical
          on SPX; values pushing past 3.5 on the shortest tenors are a
          warning that the fit is getting close to the arb boundary and a
          larger η or ρ shift could trip it.
        </p>
        <p style={{ margin: 0 }}>
          <strong style={{ color: 'var(--text-primary)' }}>What SSVI is for.</strong>{' '}
          Every dashboard number that has to be consistent across tenors
          benefits from an SSVI backbone. Term-structure slope metrics,
          cross-tenor risk reversals, calendar-spread fair values, and
          forward-vol estimates all depend on the surface being globally
          consistent in a way that slice fits cannot promise. The raw and
          natural slots above are the right tool when the question is
          "what does this one smile look like." This slot is the right
          tool when the question is "does the whole surface hang together."
        </p>
      </div>
    </div>
  );
}
