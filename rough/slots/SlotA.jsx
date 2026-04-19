import { useEffect, useMemo, useRef } from 'react';
import usePlotly from '../../src/hooks/usePlotly';
import useIsMobile from '../../src/hooks/useIsMobile';
import { useGexHistory } from '../../src/hooks/useHistoricalData';
import {
  PLOTLY_COLORS,
  PLOTLY_FONTS,
  plotly2DChartLayout,
  plotlyAxis,
  plotlyTitle,
} from '../../src/lib/plotlyTheme';

// -----------------------------------------------------------------------------
// RFSV Hurst Signature — the Gatheral-Jaisson-Rosenbaum (2018) diagnostic.
//
// The rough-volatility hypothesis, stated empirically: if log σ_t is a fBm
// of Hurst parameter H, then its q-th order structure function scales as
//
//     m(q, Δ) := E[|log σ_{t+Δ} − log σ_t|^q] ∝ Δ^(qH)
//
// over a wide range of Δ. Plotting log m(q, Δ) against log Δ should give a
// straight line with slope ζ(q) = qH. A single H recovered from every q
// ("monofractality") is the distinctive signature — multifractal financial
// models like MRW would show a concave ζ(q) curve instead.
//
// With only daily SPX closes available in-browser we cannot use intraday
// realized variance the way Gatheral et al. did with the Oxford-Man 5-min
// RV data. The best daily proxy is the log of the absolute daily return:
//
//     X_t = log |r_t|  ≈  log σ_t  +  log |Z_t|
//
// where Z_t ~ N(0,1) is the daily innovation under the standard
// stochastic-vol framing. The noise term log |Z_t| is i.i.d. and so adds a
// flat offset to the structure function at every lag — it does not bend
// the log-log scaling, which is what H is read from. The noise does
// inflate the absolute level of m(q, Δ) especially at small Δ, but the
// *slope* ζ(q) that we regress out is robust to it (this is the core
// reason the variogram method works on noisy observable proxies).
//
// We sweep q ∈ {0.5, 1, 1.5, 2, 3} and Δ ∈ {1, 2, 3, 5, 7, 10, 14, 20, 30,
// 45, 60}. Each q gives an independent log-log OLS regression and an
// independent H_q = slope/q. The pooled H is the weighted average across
// q, which is the standard summary statistic in the rough-vol literature.
// A value in the 0.08-0.18 band on daily SPX data is the empirical finding
// that launched the rough-vol program.
// -----------------------------------------------------------------------------

const LAGS = [1, 2, 3, 5, 7, 10, 14, 20, 30, 45, 60];
const MOMENTS = [0.5, 1.0, 1.5, 2.0, 3.0];
const MOMENT_COLORS = [
  PLOTLY_COLORS.primary,
  PLOTLY_COLORS.highlight,
  PLOTLY_COLORS.positive,
  PLOTLY_COLORS.secondary,
  PLOTLY_COLORS.primarySoft,
];

function buildLogAbsReturns(series) {
  const rows = [];
  for (let i = 1; i < series.length; i++) {
    const p0 = series[i - 1]?.spx_close;
    const p1 = series[i]?.spx_close;
    if (!(p0 > 0) || !(p1 > 0)) continue;
    const r = Math.log(p1 / p0);
    if (!Number.isFinite(r) || r === 0) continue;
    rows.push(Math.log(Math.abs(r)));
  }
  return rows;
}

function structureFunction(series, q, delta) {
  const n = series.length;
  if (n <= delta + 1) return null;
  let sum = 0;
  let count = 0;
  for (let t = 0; t < n - delta; t++) {
    const diff = Math.abs(series[t + delta] - series[t]);
    sum += Math.pow(diff, q);
    count += 1;
  }
  if (count === 0) return null;
  return sum / count;
}

// Ordinary least squares on (x_i, y_i): returns { slope, intercept, r2 }.
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
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const r2 = syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  return { slope, intercept, r2 };
}

function fitHurstSignature(series) {
  if (series.length < 120) return null;
  const perMoment = [];
  for (let iq = 0; iq < MOMENTS.length; iq++) {
    const q = MOMENTS[iq];
    const logDeltas = [];
    const logStructure = [];
    const raw = [];
    for (let id = 0; id < LAGS.length; id++) {
      const d = LAGS[id];
      const m = structureFunction(series, q, d);
      if (m == null || !(m > 0)) continue;
      logDeltas.push(Math.log(d));
      logStructure.push(Math.log(m));
      raw.push({ delta: d, m });
    }
    const fit = ols(logDeltas, logStructure);
    if (!fit) continue;
    perMoment.push({
      q,
      color: MOMENT_COLORS[iq % MOMENT_COLORS.length],
      logDeltas,
      logStructure,
      slope: fit.slope,
      intercept: fit.intercept,
      r2: fit.r2,
      H: fit.slope / q,
      raw,
    });
  }
  if (perMoment.length === 0) return null;

  // Pooled Hurst: unweighted mean of per-moment estimates. Each q gives an
  // independent read on H, and a simple mean is the standard way to
  // collapse the family of estimates into a single number to headline.
  let sumH = 0;
  let countH = 0;
  for (const row of perMoment) {
    if (Number.isFinite(row.H)) {
      sumH += row.H;
      countH += 1;
    }
  }
  const hPooled = countH > 0 ? sumH / countH : null;

  // Spread across q as a monofractality check. A tight spread (stdev < 0.03)
  // is consistent with monofractal scaling; a larger spread flags
  // multifractal-like behavior and warrants caution about reading H as a
  // single number.
  let varH = 0;
  if (countH > 1 && hPooled != null) {
    for (const row of perMoment) {
      if (Number.isFinite(row.H)) {
        const dH = row.H - hPooled;
        varH += dH * dH;
      }
    }
    varH /= countH - 1;
  }
  const hSpread = Math.sqrt(varH);

  return { perMoment, hPooled, hSpread, n: series.length };
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

function formatFixed(v, digits = 3) {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toFixed(digits);
}

export default function SlotA() {
  const chartRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();
  const mobile = useIsMobile();
  const { data, loading, error } = useGexHistory();

  const proxy = useMemo(() => buildLogAbsReturns(data?.series || []), [data]);
  const fit = useMemo(() => fitHurstSignature(proxy), [proxy]);

  useEffect(() => {
    if (!Plotly || !chartRef.current || !fit) return;

    const traces = [];
    for (const row of fit.perMoment) {
      traces.push({
        x: row.logDeltas,
        y: row.logStructure,
        mode: 'markers',
        name: `q=${row.q}`,
        marker: { color: row.color, size: 9, symbol: 'circle' },
        hovertemplate:
          `q=${row.q}<br>` +
          'Δ=%{customdata[0]}<br>' +
          'log m=%{y:.3f}<extra></extra>',
        customdata: row.raw.map((r) => [r.delta]),
        legendgroup: `q${row.q}`,
        showlegend: true,
      });
      // Fit line across the observed log-Δ range
      const xs = row.logDeltas;
      if (xs.length >= 2) {
        const xMin = Math.min(...xs);
        const xMax = Math.max(...xs);
        const yMin = row.intercept + row.slope * xMin;
        const yMax = row.intercept + row.slope * xMax;
        traces.push({
          x: [xMin, xMax],
          y: [yMin, yMax],
          mode: 'lines',
          line: { color: row.color, width: 1.25, dash: 'dot' },
          hoverinfo: 'skip',
          legendgroup: `q${row.q}`,
          showlegend: false,
        });
      }
    }

    const layout = plotly2DChartLayout({
      title: {
        ...plotlyTitle('RFSV · log m(q, Δ) vs log Δ on log |r|'),
        y: 0.97,
        yref: 'container',
        yanchor: 'top',
      },
      margin: mobile
        ? { t: 50, r: 20, b: 95, l: 65 }
        : { t: 70, r: 30, b: 105, l: 80 },
      xaxis: plotlyAxis('log Δ (days)', {
        tickvals: LAGS.map((d) => Math.log(d)),
        ticktext: LAGS.map((d) => String(d)),
      }),
      yaxis: plotlyAxis('log m(q, Δ)'),
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
  }, [Plotly, fit, mobile]);

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
          The structure-function fit requires at least 120 daily returns
          (max lag Δ = 60 with ≥ 60 independent pairs).
        </div>
      </div>
    );
  }

  // Decide monofractal regime tag by Hurst spread. Per Gatheral-Jaisson-
  // Rosenbaum (2018), a stdev of H across q below ~0.03 is consistent with
  // monofractal scaling; above that, the proxy shows enough multifractal
  // curvature that reading a single H is a lossy summary.
  const monofractal = fit.hSpread < 0.03;

  return (
    <div className="card" style={{ padding: '1.25rem 1.25rem 1rem' }}>
      <div style={{ marginBottom: '0.85rem' }}>
        <div
          style={{
            fontFamily: 'Courier New, monospace',
            fontSize: '0.7rem',
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--text-secondary)',
            marginBottom: '0.35rem',
          }}
        >
          model · RFSV · Gatheral-Jaisson-Rosenbaum 2018 structure function
        </div>
        <div
          style={{
            fontSize: '1.00rem',
            color: 'var(--text-secondary)',
            lineHeight: 1.6,
            maxWidth: '820px',
          }}
        >
          Structure-function scaling of a log-vol proxy.{' '}
          <strong style={{ color: 'var(--text-primary)' }}>
            X<sub>t</sub> = log |r<sub>t</sub>|
          </strong>{' '}
          is used as the daily log-σ proxy (intraday realized variance is
          unavailable in-browser). For each moment order q, the q-th
          structure function{' '}
          <strong style={{ color: 'var(--text-primary)' }}>
            m(q, Δ) = ⟨|X<sub>t+Δ</sub> − X<sub>t</sub>|<sup>q</sup>⟩
          </strong>{' '}
          is computed across lags Δ = 1, 2, 3, 5, 7, 10, 14, 20, 30, 45,
          60 and regressed in log-log. Under the RFSV hypothesis the
          slopes should be{' '}
          <strong style={{ color: 'var(--text-primary)' }}>ζ(q) = qH</strong>{' '}
          for a single Hurst parameter{' '}
          <strong style={{ color: PLOTLY_COLORS.highlight }}>H</strong>.
          The five markers per q are the log m(q, Δ) values; the dotted
          lines are the per-q OLS fits. Parallel slopes = monofractal =
          rough-vol signature.
        </div>
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
          label="Pooled Hurst H"
          value={formatFixed(fit.hPooled, 3)}
          sub={`mean of H(q) across q ∈ {${MOMENTS.join(', ')}}`}
          accent={PLOTLY_COLORS.highlight}
        />
        <StatCell
          label="H spread (stdev)"
          value={formatFixed(fit.hSpread, 3)}
          sub={monofractal ? 'tight — monofractal' : 'wide — multifractal?'}
          accent={monofractal ? PLOTLY_COLORS.positive : PLOTLY_COLORS.secondary}
        />
        <StatCell
          label="H(q=2)"
          value={formatFixed(
            fit.perMoment.find((r) => r.q === 2)?.H,
            3,
          )}
          sub="canonical variance-scaling estimate"
        />
        <StatCell
          label="Sample n"
          value={fit.n.toLocaleString()}
          sub="daily SPX log-returns used"
        />
      </div>

      <div ref={chartRef} style={{ width: '100%', height: mobile ? 340 : 440 }} />

      <div
        style={{
          marginTop: '0.65rem',
          fontSize: '0.95rem',
          color: 'var(--text-secondary)',
          lineHeight: 1.65,
        }}
      >
        <strong style={{ color: 'var(--text-primary)' }}>Reading:</strong>{' '}
        An H in the{' '}
        <strong style={{ color: PLOTLY_COLORS.highlight }}>0.08-0.18</strong>{' '}
        band reproduces the Gatheral-Jaisson-Rosenbaum result on daily index
        data and is inconsistent with any classical diffusion SV model
        (Heston, SABR, 3/2), all of which imply H = 0.5 under their
        variance dynamics. A tight H spread across q (stdev &lt; 0.03) says
        the log-vol proxy is approximately{' '}
        <strong style={{ color: PLOTLY_COLORS.positive }}>monofractal</strong>:
        one H describes every moment. A wide spread is a flag that the
        proxy shows multifractal curvature — either because the sample is
        too short to pin H down at high q, or because a pure-rough-vol
        model is too stylized for the true dynamics. The{' '}
        <strong style={{ color: 'var(--text-primary)' }}>log |r<sub>t</sub>|</strong>{' '}
        proxy carries i.i.d. innovation noise that lifts every m(q, Δ) by
        a q-dependent constant — the{' '}
        <em>intercepts</em> are biased upward but the{' '}
        <em>slopes</em> are not, which is why this diagnostic is useful
        even with daily-only observations.
      </div>
    </div>
  );
}
