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
// Markov Regime Switching, 2-state Hamilton MSM with Gaussian emissions.
//
// Hamilton (1989) showed that letting the parameters of a time-series model
// jump between a small number of hidden regimes, governed by a Markov
// chain on the hidden state, captures the observed alternation between
// calm trending markets and volatile panic markets far better than any
// single-regime model. The mixture model in Slot A identifies regimes from
// the pooled return distribution with no temporal structure; the MSM adds
// the temporal structure and can say which regime was active on which day.
//
// Model:
//   s_t ∈ {1, 2}  (hidden state, 1 = calm, 2 = crisis)
//   P[i][j] = Pr(s_{t+1}=j | s_t=i)   (transition matrix)
//   r_t | s_t=k  ~  N(μ_k, σ_k²)      (Gaussian emissions)
//
// Fit by EM:
//   E-step   Hamilton filter forward:  α_t(k) = Pr(s_t=k, r_1:t | θ)
//            Kim smoother backward:    γ_t(k) = Pr(s_t=k | r_1:T, θ)
//                                      ξ_t(i,j) = Pr(s_t=i, s_{t+1}=j | r_1:T)
//   M-step   π_0(k) ← γ_1(k)
//            P[i][j] ← Σ_t ξ_t(i,j) / Σ_t γ_t(i)
//            μ_k    ← Σ_t γ_t(k) r_t / Σ_t γ_t(k)
//            σ²_k   ← Σ_t γ_t(k) (r_t−μ_k)² / Σ_t γ_t(k)
//
// The filter runs in log-space to avoid underflow on long series (~2000 days).
// Expected regime durations are 1 / (1 − p_kk) under the geometric holding
// time of a 2-state Markov chain, a direct read on how "sticky" each
// regime is, and the quantity a trader usually cares about most: a crisis
// with a 20-day expected duration is a very different trade than a crisis
// with a 3-day expected duration.
// -----------------------------------------------------------------------------

const LOG_2PI = Math.log(2 * Math.PI);
const TRADING_DAYS_YEAR = 252;
const EM_MAX_ITERS = 200;
const EM_TOL = 1e-7;
const CHART_LOOKBACK_DAYS = 800;

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

function normalLogPdf(x, mu, sigma) {
  const z = (x - mu) / sigma;
  return -0.5 * (LOG_2PI + 2 * Math.log(sigma) + z * z);
}

function logSumExp2(a, b) {
  const m = a > b ? a : b;
  if (!Number.isFinite(m)) return m;
  return m + Math.log(Math.exp(a - m) + Math.exp(b - m));
}

function hamiltonFilter(returns, mu, sigma, P, pi0) {
  const n = returns.length;
  const logAlpha = [new Array(n), new Array(n)];
  const logP = [[Math.log(P[0][0]), Math.log(P[0][1])], [Math.log(P[1][0]), Math.log(P[1][1])]];
  const logPi0 = [Math.log(pi0[0]), Math.log(pi0[1])];

  let logLik = 0;
  // t = 0
  const le0_0 = normalLogPdf(returns[0], mu[0], sigma[0]);
  const le0_1 = normalLogPdf(returns[0], mu[1], sigma[1]);
  const a0_0 = logPi0[0] + le0_0;
  const a0_1 = logPi0[1] + le0_1;
  const z0 = logSumExp2(a0_0, a0_1);
  logAlpha[0][0] = a0_0 - z0;
  logAlpha[1][0] = a0_1 - z0;
  logLik += z0;

  for (let t = 1; t < n; t++) {
    const le0 = normalLogPdf(returns[t], mu[0], sigma[0]);
    const le1 = normalLogPdf(returns[t], mu[1], sigma[1]);

    // predicted log α_t(j) ∝ Σ_i α_{t-1}(i) · P[i][j]
    const pred0 = logSumExp2(
      logAlpha[0][t - 1] + logP[0][0],
      logAlpha[1][t - 1] + logP[1][0],
    );
    const pred1 = logSumExp2(
      logAlpha[0][t - 1] + logP[0][1],
      logAlpha[1][t - 1] + logP[1][1],
    );

    const a_0 = pred0 + le0;
    const a_1 = pred1 + le1;
    const z = logSumExp2(a_0, a_1);
    logAlpha[0][t] = a_0 - z;
    logAlpha[1][t] = a_1 - z;
    logLik += z;
  }

  return { logAlpha, logLik, logP };
}

function kimSmoother(logAlpha, logP) {
  const n = logAlpha[0].length;
  const logGamma = [new Array(n), new Array(n)];
  // Joint ξ_t(i,j) indexed as xi[i*2+j][t] for t = 0..n-2
  const xi = [new Array(n - 1), new Array(n - 1), new Array(n - 1), new Array(n - 1)];

  logGamma[0][n - 1] = logAlpha[0][n - 1];
  logGamma[1][n - 1] = logAlpha[1][n - 1];

  for (let t = n - 2; t >= 0; t--) {
    // Predicted α̂_{t+1|t}(j) = Σ_i α_t(i) · P[i][j]
    const pred0 = logSumExp2(
      logAlpha[0][t] + logP[0][0],
      logAlpha[1][t] + logP[1][0],
    );
    const pred1 = logSumExp2(
      logAlpha[0][t] + logP[0][1],
      logAlpha[1][t] + logP[1][1],
    );

    // γ_t(i) = Σ_j γ_{t+1}(j) · (α_t(i) P[i][j] / α̂_{t+1|t}(j))
    const g0 = logSumExp2(
      logGamma[0][t + 1] + logAlpha[0][t] + logP[0][0] - pred0,
      logGamma[1][t + 1] + logAlpha[0][t] + logP[0][1] - pred1,
    );
    const g1 = logSumExp2(
      logGamma[0][t + 1] + logAlpha[1][t] + logP[1][0] - pred0,
      logGamma[1][t + 1] + logAlpha[1][t] + logP[1][1] - pred1,
    );
    logGamma[0][t] = g0;
    logGamma[1][t] = g1;

    xi[0][t] = logAlpha[0][t] + logP[0][0] + logGamma[0][t + 1] - pred0;
    xi[1][t] = logAlpha[0][t] + logP[0][1] + logGamma[1][t + 1] - pred1;
    xi[2][t] = logAlpha[1][t] + logP[1][0] + logGamma[0][t + 1] - pred0;
    xi[3][t] = logAlpha[1][t] + logP[1][1] + logGamma[1][t + 1] - pred1;
  }

  return { logGamma, xi };
}

function fitMsm(returns) {
  const n = returns.length;
  if (n < 60) return null;

  // Seed from a rough calm/crisis partition by |r|, same trick as Slot A,
  // to give the EM the correct ordering σ₁ < σ₂ at initialization
  const absR = returns.map((r) => Math.abs(r));
  const sortedAbs = [...absR].sort((a, b) => a - b);
  const cut = sortedAbs[Math.floor(n * 0.75)];
  const calm = [];
  const crisis = [];
  for (let i = 0; i < n; i++) (absR[i] <= cut ? calm : crisis).push(returns[i]);

  const meanArr = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const stdArr = (a, m) => Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(a.length - 1, 1));

  let mu = [meanArr(calm), meanArr(crisis)];
  let sigma = [Math.max(stdArr(calm, mu[0]), 1e-6), Math.max(stdArr(crisis, mu[1]), 1e-6)];
  // Sticky initial transitions: calm more persistent than crisis, which
  // matches the empirical prior and gives the filter a head start
  let P = [
    [0.98, 0.02],
    [0.10, 0.90],
  ];
  let pi0 = [0.9, 0.1];

  let prevLogLik = -Infinity;
  let converged = false;
  let iters = 0;
  let filtered;
  let smoothed;

  for (iters = 0; iters < EM_MAX_ITERS; iters++) {
    filtered = hamiltonFilter(returns, mu, sigma, P, pi0);
    smoothed = kimSmoother(filtered.logAlpha, filtered.logP);
    const logLik = filtered.logLik;

    // M-step: compute γ, ξ in linear space for parameter updates
    let N0 = 0;
    let N1 = 0;
    let sumR0 = 0;
    let sumR1 = 0;
    for (let t = 0; t < n; t++) {
      const g0 = Math.exp(smoothed.logGamma[0][t]);
      const g1 = Math.exp(smoothed.logGamma[1][t]);
      N0 += g0;
      N1 += g1;
      sumR0 += g0 * returns[t];
      sumR1 += g1 * returns[t];
    }
    if (!(N0 > 1e-6) || !(N1 > 1e-6)) break;
    const newMu0 = sumR0 / N0;
    const newMu1 = sumR1 / N1;

    let sumV0 = 0;
    let sumV1 = 0;
    for (let t = 0; t < n; t++) {
      const g0 = Math.exp(smoothed.logGamma[0][t]);
      const g1 = Math.exp(smoothed.logGamma[1][t]);
      const d0 = returns[t] - newMu0;
      const d1 = returns[t] - newMu1;
      sumV0 += g0 * d0 * d0;
      sumV1 += g1 * d1 * d1;
    }
    const newSigma0 = Math.sqrt(Math.max(sumV0 / N0, 1e-12));
    const newSigma1 = Math.sqrt(Math.max(sumV1 / N1, 1e-12));

    let xi00 = 0;
    let xi01 = 0;
    let xi10 = 0;
    let xi11 = 0;
    for (let t = 0; t < n - 1; t++) {
      xi00 += Math.exp(smoothed.xi[0][t]);
      xi01 += Math.exp(smoothed.xi[1][t]);
      xi10 += Math.exp(smoothed.xi[2][t]);
      xi11 += Math.exp(smoothed.xi[3][t]);
    }
    const row0 = xi00 + xi01;
    const row1 = xi10 + xi11;
    const newP00 = row0 > 1e-12 ? xi00 / row0 : P[0][0];
    const newP01 = row0 > 1e-12 ? xi01 / row0 : P[0][1];
    const newP10 = row1 > 1e-12 ? xi10 / row1 : P[1][0];
    const newP11 = row1 > 1e-12 ? xi11 / row1 : P[1][1];

    const newPi0 = [
      Math.exp(smoothed.logGamma[0][0]),
      Math.exp(smoothed.logGamma[1][0]),
    ];

    mu = [newMu0, newMu1];
    sigma = [newSigma0, newSigma1];
    P = [[newP00, newP01], [newP10, newP11]];
    pi0 = newPi0;

    if (Math.abs(logLik - prevLogLik) < EM_TOL * Math.max(1, Math.abs(prevLogLik))) {
      prevLogLik = logLik;
      converged = true;
      iters += 1;
      break;
    }
    prevLogLik = logLik;
  }

  // Canonicalize: state 0 = calm (lower σ), state 1 = crisis (higher σ)
  if (sigma[0] > sigma[1]) {
    mu = [mu[1], mu[0]];
    sigma = [sigma[1], sigma[0]];
    P = [[P[1][1], P[1][0]], [P[0][1], P[0][0]]];
    pi0 = [pi0[1], pi0[0]];
    if (smoothed) {
      const g0 = smoothed.logGamma[0];
      smoothed.logGamma[0] = smoothed.logGamma[1];
      smoothed.logGamma[1] = g0;
    }
  }

  const gammaCrisis = smoothed ? smoothed.logGamma[1].map((l) => Math.exp(l)) : [];

  return {
    mu, sigma, P, pi0,
    logLik: prevLogLik,
    iters, converged, n,
    gammaCrisis,
  };
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

export default function SlotB() {
  const chartRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();
  const mobile = useIsMobile();
  const { data, loading, error } = useGexHistory();

  const series = useMemo(() => buildLogReturns(data?.series || []), [data]);
  const returns = useMemo(() => series.map((r) => r.r), [series]);
  const fit = useMemo(() => fitMsm(returns), [returns]);

  useEffect(() => {
    if (!Plotly || !chartRef.current || !fit) return;

    // Zoom the time series to the most recent CHART_LOOKBACK_DAYS trading days
    // so the regime transitions are legible; fit itself runs on the full sample
    const last = Math.max(0, series.length - CHART_LOOKBACK_DAYS);
    const xs = series.slice(last).map((r) => r.date);
    const absR = series.slice(last).map((r) => Math.abs(r.r) * 100);
    const gC = fit.gammaCrisis.slice(last);

    const traces = [
      {
        x: xs,
        y: absR,
        mode: 'lines',
        name: '|r| (%)',
        line: { color: PLOTLY_COLORS.axisText, width: 0.85 },
        yaxis: 'y',
        hovertemplate: '%{x}<br>|r| %{y:.2f}%<extra></extra>',
      },
      {
        x: xs,
        y: gC,
        mode: 'lines',
        name: 'Pr(crisis)',
        line: { color: PLOTLY_COLORS.secondary, width: 1.5 },
        fill: 'tozeroy',
        fillcolor: 'rgba(231, 76, 60, 0.12)',
        yaxis: 'y2',
        hovertemplate: '%{x}<br>Pr(crisis) %{y:.3f}<extra></extra>',
      },
    ];

    const layout = plotly2DChartLayout({
      title: {
        ...plotlyTitle(
          mobile
            ? 'Markov Regime Switching<br>Smoothed Pr(crisis)'
            : 'Markov Regime Switching · Smoothed Pr(crisis)'
        ),
        y: 0.97,
        yref: 'container',
        yanchor: 'top',
      },
      margin: mobile
        ? { t: 75, r: 55, b: 65, l: 60 }
        : { t: 70, r: 75, b: 70, l: 75 },
      xaxis: plotlyAxis('Date', { type: 'date' }),
      yaxis: plotlyAxis('|daily return| (%)', { ticksuffix: '%', tickformat: '.1f', rangemode: 'tozero' }),
      yaxis2: plotlyAxis('Pr(crisis)', {
        overlaying: 'y',
        side: 'right',
        range: [0, 1],
        autorange: false,
        showgrid: false,
        tickformat: '.1f',
      }),
      showlegend: true,
      legend: {
        orientation: 'h',
        y: -0.18,
        x: 0.5,
        xanchor: 'center',
        font: PLOTLY_FONTS.legend,
      },
      hovermode: 'x unified',
    });

    Plotly.react(chartRef.current, traces, layout, {
      responsive: true,
      displayModeBar: false,
    });
  }, [Plotly, fit, series, mobile]);

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
          The Hamilton MSM EM requires at least 60 daily log returns.
        </div>
      </div>
    );
  }

  const sigma0Ann = fit.sigma[0] * Math.sqrt(TRADING_DAYS_YEAR);
  const sigma1Ann = fit.sigma[1] * Math.sqrt(TRADING_DAYS_YEAR);
  const dur0 = 1 / Math.max(1 - fit.P[0][0], 1e-6);
  const dur1 = 1 / Math.max(1 - fit.P[1][1], 1e-6);
  const currentCrisis = fit.gammaCrisis.length ? fit.gammaCrisis[fit.gammaCrisis.length - 1] : null;

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
        Hamilton MSM · 2-state Gaussian emissions
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
          label="Calm state"
          value={formatPct(sigma0Ann, 1)}
          sub={`drift ${formatFixed(fit.mu[0] * TRADING_DAYS_YEAR, 3)} · avg ${dur0.toFixed(1)}d`}
          accent={PLOTLY_COLORS.primary}
        />
        <StatCell
          label="Crisis state"
          value={formatPct(sigma1Ann, 1)}
          sub={`drift ${formatFixed(fit.mu[1] * TRADING_DAYS_YEAR, 3)} · avg ${dur1.toFixed(1)}d`}
          accent={PLOTLY_COLORS.secondary}
        />
        <StatCell
          label="Stay rates"
          value={`${(fit.P[0][0] * 100).toFixed(1)}% · ${(fit.P[1][1] * 100).toFixed(1)}%`}
          sub="calm-stay · crisis-stay"
        />
        <StatCell
          label="Current Pr(crisis)"
          value={currentCrisis != null ? (currentCrisis * 100).toFixed(1) + '%' : 'n/a'}
          sub={`${fit.n} days${fit.converged ? ' · converged' : ''}`}
          accent={currentCrisis != null && currentCrisis > 0.5 ? PLOTLY_COLORS.secondary : PLOTLY_COLORS.primary}
        />
      </div>

      <div ref={chartRef} style={{ width: '100%', height: mobile ? 360 : 460 }} />

      <div
        style={{
          marginTop: '0.8rem',
          fontSize: '0.9rem',
          color: 'var(--text-secondary)',
          lineHeight: 1.65,
        }}
      >
        <p style={{ margin: '0 0 0.75rem' }}>
          The mixture model above tells you the market has two moods.
          This one adds the part that is actually tradeable: which mood
          is active right now. The{' '}
          <strong style={{ color: PLOTLY_COLORS.secondary }}>coral fill</strong>{' '}
          is the model's best estimate, day by day, of the probability
          that the market sits in the crisis regime. The peaks line up
          with the COVID crash in early 2020, the 2022 bear market, and
          the 2023 regional-bank episode, and the model identifies them
          from return magnitudes alone with no event labels supplied.
          The average-duration numbers in the stats row are in trading
          days and tell you how long each regime typically sticks
          around once it arrives, which is the quantity that decides
          whether a regime flip is a trade-around moment or a
          book-adjusting moment.
        </p>
        <p style={{ margin: 0 }}>
          <strong style={{ color: 'var(--text-primary)' }}>Practical use.</strong>{' '}
          Rising crisis probability is a risk-off signal. When the
          coral fill crosses fifty percent on the way up, treat it as a
          prompt to widen stops, reduce position size, buy downside
          protection, or rotate out of directly exposed books. The
          average-duration numbers tell you how long the regime is
          likely to hold: a crisis with a twenty-day expected duration
          is a very different trade from a crisis with a three-day
          duration, and the first wants proper hedges while the second
          usually wants patience and a short-dated fade. Treat the tape
          as mean-reverting and volatility-expanding when the current
          probability in the stats row sits above fifty percent, and
          fall back to the usual calm-regime playbook below it. The
          characteristic failure mode is lag, because the smoother uses
          the full history up to today rather than forecasting forward,
          so pair it with faster reads such as realized-vol breakouts,
          dealer-gamma flips, or your own flow monitors rather than
          waiting on it alone.
        </p>
      </div>
    </div>
  );
}
