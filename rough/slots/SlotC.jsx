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
// Hurst Estimator Triangulation — three orthogonal fits on the same proxy.
//
// Slot A reads H from the q-th order structure function and reports a
// pooled estimate across q ∈ {0.5, 1, 1.5, 2, 3}. That's a single method
// at multiple moments. This slot runs three *different* estimators on the
// same proxy series X_t = log |r_t| and reports their estimates side by
// side. Agreement to within ~0.03 across the three estimators is the
// robustness check on the rough-vol Hurst signature; divergence flags
// either sample-size limits, non-monofractality, or proxy-specific bias
// dominating one of the methods.
//
// The three estimators:
//
//   1. VARIOGRAM (structure function q=2): slope of log m(2, Δ) vs log Δ
//      is 2H. The canonical second-moment estimator and the one implicit
//      in the Gatheral-Jaisson-Rosenbaum plots.
//
//   2. ABSOLUTE MOMENTS (q=1): slope of log m(1, Δ) vs log Δ is H
//      directly. Lower-moment estimators are more robust to heavy tails
//      in the proxy series — and log |r_t| has a left tail (r_t ≈ 0
//      days drag log |r_t| toward −∞) that the variogram feels more
//      strongly because squaring amplifies those observations.
//
//   3. DETRENDED FLUCTUATION ANALYSIS (DFA, order 1): integrate the
//      de-meaned proxy to a cumulative walk y_t, partition into
//      non-overlapping windows of size n, fit a linear trend per
//      window, and measure the RMS residual F(n). Under a long-memory
//      fGn with Hurst H, F(n) ∼ n^H. DFA is the standard scaling
//      estimator in geophysics and genomics, and its strength is
//      explicit removal of polynomial drifts — a potential bias source
//      in the spot-return series that variogram methods do not correct.
//
// All three apply to the same daily SPX log-return series used in Slot A,
// so the three H estimates are directly comparable. The bar chart
// compares them to the Slot A pooled H for visual triangulation; the
// log-log chart overlays the three regression diagnostics on a common
// "log scale" × "log value" canvas after intercept-centering each method
// so their slopes are the visually dominant feature.
// -----------------------------------------------------------------------------

const VARIO_LAGS = [1, 2, 3, 5, 7, 10, 14, 20, 30, 45, 60];
const DFA_WINDOWS = [8, 12, 16, 22, 30, 42, 60, 85, 120, 170, 240];

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
  return {
    slope,
    intercept: my - slope * mx,
    r2: syy === 0 ? 0 : (sxy * sxy) / (sxx * syy),
  };
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

function fitMoment(series, q, label, color) {
  const xs = [];
  const ys = [];
  const raw = [];
  for (const d of VARIO_LAGS) {
    const m = structureFunction(series, q, d);
    if (m == null || !(m > 0)) continue;
    xs.push(Math.log(d));
    ys.push(Math.log(m));
    raw.push({ x: Math.log(d), y: Math.log(m), delta: d });
  }
  const fit = ols(xs, ys);
  if (!fit) return null;
  return {
    label,
    color,
    slope: fit.slope,
    intercept: fit.intercept,
    r2: fit.r2,
    H: fit.slope / q,
    raw,
    xs,
    ys,
  };
}

// DFA (order 1). Returns { raw, fit, H } or null.
function fitDfa(series, label, color) {
  const n = series.length;
  if (n < 100) return null;
  // De-mean and cumulate
  let sum = 0;
  for (let i = 0; i < n; i++) sum += series[i];
  const mean = sum / n;
  const y = new Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += series[i] - mean;
    y[i] = acc;
  }

  const logN = [];
  const logF = [];
  const raw = [];
  for (const w of DFA_WINDOWS) {
    if (w < 4 || w >= Math.floor(n / 4)) continue;
    const numWindows = Math.floor(n / w);
    // Use the first numWindows·w samples; the tail is dropped (standard DFA).
    let sumSq = 0;
    let count = 0;
    // Precompute per-window linear regression in O(w) using sums
    for (let k = 0; k < numWindows; k++) {
      // Linear fit of y[k*w .. (k+1)*w - 1] vs x = 0..w-1
      let sX = 0;
      let sY = 0;
      let sXX = 0;
      let sXY = 0;
      for (let i = 0; i < w; i++) {
        const xi = i;
        const yi = y[k * w + i];
        sX += xi;
        sY += yi;
        sXX += xi * xi;
        sXY += xi * yi;
      }
      const denom = w * sXX - sX * sX;
      if (denom === 0) continue;
      const slope = (w * sXY - sX * sY) / denom;
      const intercept = (sY - slope * sX) / w;
      for (let i = 0; i < w; i++) {
        const yhat = intercept + slope * i;
        const resid = y[k * w + i] - yhat;
        sumSq += resid * resid;
        count += 1;
      }
    }
    if (count === 0) continue;
    const F = Math.sqrt(sumSq / count);
    if (!(F > 0)) continue;
    logN.push(Math.log(w));
    logF.push(Math.log(F));
    raw.push({ x: Math.log(w), y: Math.log(F), n: w });
  }
  const fit = ols(logN, logF);
  if (!fit) return null;

  // For fGn of Hurst H, DFA on the cumulative walk gives α = H directly
  // (because the walk inherits the fBm-of-Hurst-H scaling and DFA probes
  // its RMS at window size n ~ n^H). For a white-noise input the slope is
  // 0.5, which is the sanity boundary to expect on uncorrelated proxy
  // noise.
  return {
    label,
    color,
    slope: fit.slope,
    intercept: fit.intercept,
    r2: fit.r2,
    H: fit.slope,
    raw,
    xs: logN,
    ys: logF,
  };
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
  if (v == null || !Number.isFinite(v)) return 'n/a';
  return v.toFixed(digits);
}

export default function SlotC() {
  const chartRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();
  const mobile = useIsMobile();
  const { data, loading, error } = useGexHistory();

  const proxy = useMemo(() => buildLogAbsReturns(data?.series || []), [data]);
  const variogram = useMemo(
    () => fitMoment(proxy, 2, 'Variogram (q=2)', PLOTLY_COLORS.primary),
    [proxy],
  );
  const absmom = useMemo(
    () => fitMoment(proxy, 1, 'Absolute moments (q=1)', PLOTLY_COLORS.highlight),
    [proxy],
  );
  const dfa = useMemo(
    () => fitDfa(proxy, 'DFA (order 1)', PLOTLY_COLORS.positive),
    [proxy],
  );

  const methods = useMemo(
    () => [variogram, absmom, dfa].filter(Boolean),
    [variogram, absmom, dfa],
  );

  useEffect(() => {
    if (!Plotly || !chartRef.current || methods.length === 0) return;

    // Overlay chart: each method's (x, y) pairs are intercept-centered
    // (y − intercept) so the three curves share the same "log-scale × 0
    // baseline" canvas and the slopes are the visually dominant
    // feature. The slopes themselves are the Hurst parameter (for q=1 and
    // DFA) or 2H (for q=2) — the bar chart below converts all three to H.
    const traces = [];
    for (const m of methods) {
      const xs = m.raw.map((r) => r.x);
      const ys = m.raw.map((r) => r.y - m.intercept);
      traces.push({
        x: xs,
        y: ys,
        mode: 'markers',
        name: m.label,
        marker: { color: m.color, size: 9, symbol: 'circle' },
        hovertemplate: `${m.label}<br>log x=%{x:.3f}<br>log y (centered)=%{y:.3f}<extra></extra>`,
        legendgroup: m.label,
        showlegend: true,
      });
      if (xs.length >= 2) {
        const xMin = Math.min(...xs);
        const xMax = Math.max(...xs);
        const yMin = m.slope * xMin;
        const yMax = m.slope * xMax;
        traces.push({
          x: [xMin, xMax],
          y: [yMin, yMax],
          mode: 'lines',
          line: { color: m.color, width: 1.25, dash: 'dot' },
          hoverinfo: 'skip',
          legendgroup: m.label,
          showlegend: false,
        });
      }
    }

    const layout = plotly2DChartLayout({
      title: {
        ...plotlyTitle('Hurst estimator triangulation · intercept-centered log-log'),
        y: 0.97,
        yref: 'container',
        yanchor: 'top',
      },
      margin: mobile
        ? { t: 50, r: 20, b: 95, l: 65 }
        : { t: 70, r: 30, b: 105, l: 80 },
      xaxis: plotlyAxis('log (Δ or n)'),
      yaxis: plotlyAxis('centered log scaling value'),
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
  }, [Plotly, methods, mobile]);

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

  if (methods.length === 0) {
    return (
      <div className="lab-placeholder">
        <div className="lab-placeholder-title">Not enough history</div>
        <div className="lab-placeholder-hint">
          The three Hurst estimators require at least 100 daily log-returns.
        </div>
      </div>
    );
  }

  // Triangulation: compute mean and spread across methods.
  let hSum = 0;
  let hCount = 0;
  const hs = [];
  for (const m of methods) {
    if (Number.isFinite(m.H)) {
      hSum += m.H;
      hCount += 1;
      hs.push(m.H);
    }
  }
  const hMean = hCount > 0 ? hSum / hCount : null;
  let hVar = 0;
  if (hCount > 1) {
    for (const h of hs) hVar += (h - hMean) * (h - hMean);
    hVar /= hCount - 1;
  }
  const hSpread = Math.sqrt(hVar);
  const tightAgreement = hSpread < 0.03;

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
        Hurst triangulation · three orthogonal estimators
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
          label="H · Variogram"
          value={formatFixed(variogram?.H, 3)}
          sub={`slope 2H = ${formatFixed(variogram?.slope, 3)} · R²=${formatFixed(variogram?.r2, 3)}`}
          accent={PLOTLY_COLORS.primary}
        />
        <StatCell
          label="H · Abs. moments"
          value={formatFixed(absmom?.H, 3)}
          sub={`slope = H = ${formatFixed(absmom?.slope, 3)} · R²=${formatFixed(absmom?.r2, 3)}`}
          accent={PLOTLY_COLORS.highlight}
        />
        <StatCell
          label="H · DFA (order 1)"
          value={formatFixed(dfa?.H, 3)}
          sub={`slope = H = ${formatFixed(dfa?.slope, 3)} · R²=${formatFixed(dfa?.r2, 3)}`}
          accent={PLOTLY_COLORS.positive}
        />
        <StatCell
          label="Triangulated H"
          value={formatFixed(hMean, 3)}
          sub={
            hSpread != null
              ? `spread stdev ${formatFixed(hSpread, 3)} · ${
                  tightAgreement ? 'tight' : 'wide'
                }`
              : 'n/a'
          }
          accent={tightAgreement ? PLOTLY_COLORS.positive : PLOTLY_COLORS.secondary}
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
        <p style={{ margin: '0 0 0.6rem' }}>
          This card cross-checks the H reading from the RFSV signature above
          using three independent measurement methods. All three should give
          a similar number when the rough-vol regime is well defined.
        </p>
        <p style={{ margin: '0 0 0.4rem' }}>
          <strong style={{ color: PLOTLY_COLORS.primary }}>Variogram</strong>{' '}
          measures the typical squared difference between distant log-vol
          observations.
        </p>
        <p style={{ margin: '0 0 0.4rem' }}>
          <strong style={{ color: PLOTLY_COLORS.highlight }}>Absolute moments</strong>{' '}
          uses absolute differences instead, which downweights the most
          extreme days. It is more robust to outliers.
        </p>
        <p style={{ margin: '0 0 0.6rem' }}>
          <strong style={{ color: PLOTLY_COLORS.positive }}>DFA</strong>{' '}
          looks at how cumulative drift in log-vol scales with window size,
          after removing local trends within each window.
        </p>
        <p style={{ margin: '0 0 0.6rem' }}>
          When all three methods agree, the H reading is reliable. When
          they diverge, the data is noisy or the regime is shifting, and
          you should treat any single H estimate with skepticism.
        </p>
        <p style={{ margin: '0 0 0.6rem' }}>
          <strong style={{ color: 'var(--text-primary)' }}>How to use it.</strong>{' '}
          Look at the Triangulated H value first.
        </p>
        <p style={{ margin: '0 0 0.6rem' }}>
          A spread under 0.03 means all three methods agree. The H reading
          is reliable. Plug it into the rough Bergomi simulator above as the
          calibration starting point.
        </p>
        <p style={{ margin: '0 0 0.6rem' }}>
          A wider spread means at least one method is reading the data
          differently. This usually happens during transitional vol regimes
          or after a major market event has skewed the recent sample. Hold
          off committing to a single H value. Use the most conservative
          (highest) reading if you must choose one, or wait a few weeks for
          the methods to converge again.
        </p>
        <p style={{ margin: '0 0 0.6rem' }}>
          Watch how the spread changes over time. When the methods were
          tight and start to spread apart, that is itself a signal of
          regime change in SPX volatility. Treat that as a cue to reduce
          short-vol exposure and re-check the SPX skew.
        </p>
        <p style={{ margin: 0 }}>
          A triangulated H around{' '}
          <strong style={{ color: PLOTLY_COLORS.highlight }}>0.10 to 0.15</strong>{' '}
          with a tight spread is the typical SPX rough-vol regime. Anything
          outside that band warrants a second look at the macro tape.
        </p>
      </div>
    </div>
  );
}
