import { useEffect, useMemo, useRef } from 'react';
import usePlotly from '../../src/hooks/usePlotly';
import useIsMobile from '../../src/hooks/useIsMobile';
import { useGexHistory } from '../../src/hooks/useHistoricalData';
import {
  PLOTLY_COLORS,
  PLOTLY_FONTS,
  PLOTLY_FONT_FAMILY,
  plotly2DChartLayout,
  plotlyAxis,
  plotlyTitle,
} from '../../src/lib/plotlyTheme';

// -----------------------------------------------------------------------------
// Mixture Lognormal, 2-component Gaussian mixture on SPX daily log returns.
//
// "Lognormal mixture" on return space is implemented as a Gaussian mixture
// on log-return space, because if r = ln(S_t/S_{t-1}) is Gaussian mixture
// then S_t/S_{t-1} is lognormal mixture by construction. The log-return
// parameterization is what every downstream formula wants anyway and keeps
// the EM updates in closed form.
//
// A single-Gaussian fit on SPX daily returns badly underestimates tail mass:
// the empirical kurtosis is ~15 against a Gaussian 3, and a single normal
// cannot produce that. A 2-component mixture is the simplest model that
// can: one narrow "calm" component and one wide "crisis" component, with a
// mixing weight that encodes how often each regime is active. The fit is
// unsupervised, meaning no regime labels are supplied, and the EM algorithm
// recovers the split from the data shape alone.
//
// EM for 2-component Gaussian mixture:
//   E-step:   γ_ik = π_k φ(r_i; μ_k, σ_k) / Σ_j π_j φ(r_i; μ_j, σ_j)
//   M-step:   N_k = Σ_i γ_ik
//             π_k = N_k / N
//             μ_k = (Σ_i γ_ik r_i) / N_k
//             σ²_k = (Σ_i γ_ik (r_i − μ_k)²) / N_k
//
// Initialization splits the sample at the median absolute return. The
// calm component is seeded from the small-|r| half, the crisis component
// from the large-|r| half. That starting point already carries the
// right ordering of σ₁ < σ₂, so EM converges to the interpretable
// labelling without needing post-hoc swaps.
// -----------------------------------------------------------------------------

const LOG_2PI = Math.log(2 * Math.PI);
const TRADING_DAYS_YEAR = 252;
const EM_MAX_ITERS = 300;
const EM_TOL = 1e-8;

function buildLogReturns(series) {
  const rows = [];
  for (let i = 1; i < series.length; i++) {
    const p0 = series[i - 1]?.spx_close;
    const p1 = series[i]?.spx_close;
    if (!(p0 > 0) || !(p1 > 0)) continue;
    const r = Math.log(p1 / p0);
    if (!Number.isFinite(r)) continue;
    rows.push({ date: series[i].trading_date, r });
  }
  return rows;
}

function mean(arr) {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s / arr.length;
}

function variance(arr, m) {
  let s = 0;
  for (let i = 0; i < arr.length; i++) {
    const d = arr[i] - m;
    s += d * d;
  }
  return s / Math.max(arr.length - 1, 1);
}

function normalLogPdf(x, mu, sigma) {
  const z = (x - mu) / sigma;
  return -0.5 * (LOG_2PI + 2 * Math.log(sigma) + z * z);
}

function normalPdf(x, mu, sigma) {
  return Math.exp(normalLogPdf(x, mu, sigma));
}

// log-sum-exp of a 2-vector, kept inline because the mixture fixes K=2
function lse2(a, b) {
  const m = a > b ? a : b;
  return m + Math.log(Math.exp(a - m) + Math.exp(b - m));
}

function fitTwoComponentGmm(returns) {
  const n = returns.length;
  if (n < 30) return null;

  // Split-at-median-|r| seed: gives σ₁ < σ₂ out of the gate so the
  // "calm" / "crisis" labelling survives EM unchanged.
  const absR = returns.map((r) => Math.abs(r));
  const medianAbs = [...absR].sort((a, b) => a - b)[Math.floor(n / 2)];
  const calm = [];
  const crisis = [];
  for (let i = 0; i < n; i++) {
    (absR[i] <= medianAbs ? calm : crisis).push(returns[i]);
  }
  if (calm.length < 5 || crisis.length < 5) return null;

  let mu1 = mean(calm);
  let mu2 = mean(crisis);
  let sigma1 = Math.sqrt(Math.max(variance(calm, mu1), 1e-10));
  let sigma2 = Math.sqrt(Math.max(variance(crisis, mu2), 1e-10));
  let pi1 = calm.length / n;
  let pi2 = 1 - pi1;

  let prevLogLik = -Infinity;
  let converged = false;
  let iters = 0;

  const gamma1 = new Array(n);

  for (iters = 0; iters < EM_MAX_ITERS; iters++) {
    // E-step in log space for numerical stability at the tails
    let logLik = 0;
    for (let i = 0; i < n; i++) {
      const l1 = Math.log(pi1) + normalLogPdf(returns[i], mu1, sigma1);
      const l2 = Math.log(pi2) + normalLogPdf(returns[i], mu2, sigma2);
      const lZ = lse2(l1, l2);
      gamma1[i] = Math.exp(l1 - lZ);
      logLik += lZ;
    }

    // M-step
    let N1 = 0;
    let sumR1 = 0;
    let sumR2 = 0;
    for (let i = 0; i < n; i++) {
      N1 += gamma1[i];
      sumR1 += gamma1[i] * returns[i];
      sumR2 += (1 - gamma1[i]) * returns[i];
    }
    const N2 = n - N1;
    if (!(N1 > 1e-6) || !(N2 > 1e-6)) break;

    const newMu1 = sumR1 / N1;
    const newMu2 = sumR2 / N2;
    let sumV1 = 0;
    let sumV2 = 0;
    for (let i = 0; i < n; i++) {
      const d1 = returns[i] - newMu1;
      const d2 = returns[i] - newMu2;
      sumV1 += gamma1[i] * d1 * d1;
      sumV2 += (1 - gamma1[i]) * d2 * d2;
    }
    const newSigma1 = Math.sqrt(Math.max(sumV1 / N1, 1e-10));
    const newSigma2 = Math.sqrt(Math.max(sumV2 / N2, 1e-10));

    mu1 = newMu1;
    mu2 = newMu2;
    sigma1 = newSigma1;
    sigma2 = newSigma2;
    pi1 = N1 / n;
    pi2 = N2 / n;

    if (Math.abs(logLik - prevLogLik) < EM_TOL * Math.max(1, Math.abs(prevLogLik))) {
      prevLogLik = logLik;
      converged = true;
      iters += 1;
      break;
    }
    prevLogLik = logLik;
  }

  // Canonicalize so component 1 is always the calm (smaller-σ) one
  if (sigma1 > sigma2) {
    [mu1, mu2] = [mu2, mu1];
    [sigma1, sigma2] = [sigma2, sigma1];
    [pi1, pi2] = [pi2, pi1];
  }

  return {
    mu1, mu2, sigma1, sigma2, pi1, pi2,
    logLik: prevLogLik,
    iters,
    converged,
    n,
  };
}

// BIC for model selection: k params = 5 (μ₁, σ₁, μ₂, σ₂, π₁) vs a single
// Gaussian's k = 2. Reported in the card header so a reader can see the
// mixture's fit premium over the null model.
function singleGaussianLogLik(returns) {
  const m = mean(returns);
  const v = variance(returns, m);
  const sigma = Math.sqrt(Math.max(v, 1e-12));
  let ll = 0;
  for (let i = 0; i < returns.length; i++) ll += normalLogPdf(returns[i], m, sigma);
  return { logLik: ll, mu: m, sigma };
}

function bic(logLik, k, n) {
  return k * Math.log(n) - 2 * logLik;
}

function formatPct(v, digits = 2) {
  if (v == null || !Number.isFinite(v)) return 'n/a';
  return `${(v * 100).toFixed(digits)}%`;
}

function formatFixed(v, digits = 4) {
  if (v == null || !Number.isFinite(v)) return 'n/a';
  return v.toFixed(digits);
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

export default function SlotA() {
  const chartRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();
  const mobile = useIsMobile();
  const { data, loading, error } = useGexHistory();

  const returns = useMemo(() => {
    const rows = buildLogReturns(data?.series || []);
    return rows.map((r) => r.r);
  }, [data]);

  const fit = useMemo(() => fitTwoComponentGmm(returns), [returns]);
  const single = useMemo(
    () => (returns.length >= 30 ? singleGaussianLogLik(returns) : null),
    [returns],
  );

  useEffect(() => {
    if (!Plotly || !chartRef.current || !fit) return;

    const rMin = Math.min(...returns);
    const rMax = Math.max(...returns);
    const pad = 0.1 * Math.max(Math.abs(rMin), Math.abs(rMax));
    const lo = rMin - pad;
    const hi = rMax + pad;

    // Density grid covering the empirical support
    const N = 400;
    const xs = new Array(N);
    for (let i = 0; i < N; i++) xs[i] = lo + (i / (N - 1)) * (hi - lo);

    const d1 = xs.map((x) => fit.pi1 * normalPdf(x, fit.mu1, fit.sigma1));
    const d2 = xs.map((x) => fit.pi2 * normalPdf(x, fit.mu2, fit.sigma2));
    const dMix = xs.map((x, i) => d1[i] + d2[i]);

    const traces = [
      {
        x: returns,
        type: 'histogram',
        histnorm: 'probability density',
        name: 'empirical',
        marker: { color: PLOTLY_COLORS.axisText, opacity: 0.5 },
        nbinsx: mobile ? 40 : 80,
        hoverinfo: 'skip',
      },
      {
        x: xs,
        y: d1,
        mode: 'lines',
        name: `calm · ${(fit.pi1 * 100).toFixed(1)}% of days`,
        line: { color: PLOTLY_COLORS.primary, width: 1.75 },
        hoverinfo: 'skip',
      },
      {
        x: xs,
        y: d2,
        mode: 'lines',
        name: `crisis · ${(fit.pi2 * 100).toFixed(1)}% of days`,
        line: { color: PLOTLY_COLORS.secondary, width: 1.75 },
        hoverinfo: 'skip',
      },
      {
        x: xs,
        y: dMix,
        mode: 'lines',
        name: 'mixture',
        line: { color: PLOTLY_COLORS.highlight, width: 1.25, dash: 'dash' },
        hoverinfo: 'skip',
      },
    ];

    if (single) {
      const dSingle = xs.map((x) => normalPdf(x, single.mu, single.sigma));
      traces.push({
        x: xs,
        y: dSingle,
        mode: 'lines',
        name: '1-Gaussian baseline',
        line: { color: PLOTLY_COLORS.positive, width: 1, dash: 'dot' },
        hoverinfo: 'skip',
      });
    }

    const layout = plotly2DChartLayout({
      title: {
        ...plotlyTitle(
          mobile
            ? 'Mixture Lognormal<br>2-Component EM Fit'
            : 'Mixture Lognormal · 2-Component EM Fit'
        ),
        y: 0.97,
        yref: 'container',
        yanchor: 'top',
      },
      margin: mobile
        ? { t: 75, r: 20, b: 90, l: 60 }
        : { t: 70, r: 30, b: 105, l: 75 },
      xaxis: plotlyAxis('Daily log return', {
        range: [lo, hi],
        autorange: false,
        tickformat: '.1%',
      }),
      yaxis: plotlyAxis('Density', { rangemode: 'tozero' }),
      showlegend: true,
      legend: {
        orientation: 'h',
        y: -0.22,
        x: 0.5,
        xanchor: 'center',
        font: PLOTLY_FONTS.legend,
      },
      hovermode: false,
      barmode: 'overlay',
    });

    Plotly.react(chartRef.current, traces, layout, {
      responsive: true,
      displayModeBar: false,
    });
  }, [Plotly, fit, returns, single, mobile]);

  if (loading && !data) {
    return (
      <div className="lab-placeholder">
        <div className="lab-placeholder-title">Loading history…</div>
        <div className="lab-placeholder-hint">
          Fetching daily SPX closes from <code>/api/gex-history</code>.
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="lab-placeholder" style={{ borderColor: 'var(--accent-coral)' }}>
        <div className="lab-placeholder-title" style={{ color: 'var(--accent-coral)' }}>
          History fetch failed
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

  if (!fit) {
    return (
      <div className="lab-placeholder">
        <div className="lab-placeholder-title">Not enough history</div>
        <div className="lab-placeholder-hint">
          The EM fit requires at least 30 daily log returns.
        </div>
      </div>
    );
  }

  const sigma1Ann = fit.sigma1 * Math.sqrt(TRADING_DAYS_YEAR);
  const sigma2Ann = fit.sigma2 * Math.sqrt(TRADING_DAYS_YEAR);
  const bicMix = bic(fit.logLik, 5, fit.n);
  const bicSingle = single ? bic(single.logLik, 2, fit.n) : null;
  const bicDelta = bicSingle != null ? bicSingle - bicMix : null;

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
        mixture lognormal · 2-component EM
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: mobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)',
          gap: '1rem',
          padding: '0.85rem 0',
          borderTop: '1px solid var(--bg-card-border)',
          borderBottom: '1px solid var(--bg-card-border)',
          marginBottom: '0.85rem',
        }}
      >
        <StatCell
          label="Calm vol (ann.)"
          value={formatPct(sigma1Ann, 1)}
          sub={`drift ${formatFixed(fit.mu1 * TRADING_DAYS_YEAR, 3)} · weight ${(fit.pi1 * 100).toFixed(1)}%`}
          accent={PLOTLY_COLORS.primary}
        />
        <StatCell
          label="Crisis vol (ann.)"
          value={formatPct(sigma2Ann, 1)}
          sub={`drift ${formatFixed(fit.mu2 * TRADING_DAYS_YEAR, 3)} · weight ${(fit.pi2 * 100).toFixed(1)}%`}
          accent={PLOTLY_COLORS.secondary}
        />
        <StatCell
          label="Vol ratio"
          value={(sigma2Ann / sigma1Ann).toFixed(2) + '×'}
          sub="crisis / calm"
        />
        <StatCell
          label="2-mood fit edge"
          value={bicDelta != null ? bicDelta.toFixed(1) : 'n/a'}
          sub={`${fit.n} days${fit.converged ? ' · converged' : ''}`}
          accent={bicDelta != null && bicDelta > 10 ? PLOTLY_COLORS.positive : undefined}
        />
      </div>

      <div ref={chartRef} style={{ width: '100%', height: mobile ? 340 : 440 }} />

      <div
        style={{
          marginTop: '0.8rem',
          fontSize: '0.9rem',
          color: 'var(--text-secondary)',
          lineHeight: 1.65,
        }}
      >
        <p style={{ margin: '0 0 0.75rem' }}>
          The market trades in two distinct moods. On{' '}
          <strong style={{ color: PLOTLY_COLORS.primary }}>calm</strong>{' '}
          days, daily moves cluster in a tight band. On{' '}
          <strong style={{ color: PLOTLY_COLORS.secondary }}>crisis</strong>{' '}
          days, they fan out much wider. The{' '}
          <strong style={{ color: PLOTLY_COLORS.highlight }}>mixture</strong>{' '}
          curve is what the combined daily-return distribution actually
          looks like across both moods. The{' '}
          <strong style={{ color: PLOTLY_COLORS.positive }}>1-Gaussian baseline</strong>{' '}
          is what a single-volatility model assumes, the way most
          textbook position-sizing and VaR systems are still built. The
          visible gap between those two curves out in the tails is
          exactly the loss you are not pricing when you use one
          volatility for every market condition, and it is where
          single-regime risk blows up every cycle.
        </p>
        <p style={{ margin: 0 }}>
          <strong style={{ color: 'var(--text-primary)' }}>Practical use.</strong>{' '}
          The vol-ratio stat above is the scaling factor most
          single-vol risk systems are missing. If your stop placement,
          position sizing, or option-writing framework uses one
          historical volatility, multiply that number by the vol ratio
          on days when the Markov model below flags crisis probability
          above fifty percent. That is a rough first-cut recalibration
          and it closes the most expensive blind spot in single-regime
          risk. The crisis weight above tells you how often that
          recalibration is actually live over the long run, typically
          about one day in four to five rather than the one-in-a-hundred
          tail event a normal assumption implies. The fit-edge number
          scores the two-mood view against a flat single-vol baseline;
          readings above ten mean the two-mood view fits the history
          decisively better, which is your go-ahead to trust the vol
          ratio above the static number your risk book was calibrated
          on.
        </p>
      </div>
    </div>
  );
}
