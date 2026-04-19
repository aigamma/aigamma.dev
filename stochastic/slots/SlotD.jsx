import { useEffect, useMemo, useRef } from 'react';
import usePlotly from '../../src/hooks/usePlotly';
import useIsMobile from '../../src/hooks/useIsMobile';
import useOptionsData from '../../src/hooks/useOptionsData';
import useSviFits from '../../src/hooks/useSviFits';
import {
  PLOTLY_COLORS,
  PLOTLY_FONTS,
  plotly2DChartLayout,
  plotlyAxis,
  plotlyTitle,
} from '../../src/lib/plotlyTheme';

// -----------------------------------------------------------------------------
// Rough Bergomi (Bayer, Friz, Gatheral 2016) — "Pricing under rough volatility".
//
// The "roughness" refers to the Hölder regularity of the variance
// trajectory. Classical stochastic vol models (Heston, SABR, Bergomi 2005)
// are driven by standard Brownian motion and have variance sample paths
// of regularity H = 1/2. Bayer, Friz, and Gatheral showed that SPX
// implied-vol dynamics are consistent with a driving fractional
// Brownian motion at Hurst H ≈ 0.1 — an order of magnitude rougher
// than semi-martingale SV models can produce.
//
// The headline empirical prediction separates the rough and classical
// regimes with a single scaling exponent: at short maturities the ATM
// volatility skew scales as
//
//     |∂σ_ATM / ∂k|  ~  c · T^(H − 1/2)
//
// Classical SV models (H = 1/2) give the flat "∼ constant" limit at
// short T, sometimes parametrized as T^(−1/2) away from the very
// shortest tenors but stable once κT is large enough. Rough models
// with H ∈ (0, 1/2) give a power-law blow-up that does not flatten,
// matching the empirical observation that short-dated skew is both
// far steeper and scales more gently with T than any Brownian-driven
// model predicts.
//
// The slot computes ATM skew from the SVI fits in the current
// snapshot (every available expiration contributes one (T, |skew|)
// point), log-log regresses to recover H, and overlays theoretical
// T^(H−1/2) curves for a few reference H values (0.10 / 0.30 / 0.50)
// through the mean fit intercept. SPX almost always lands in the H ~
// 0.07–0.15 band — the number itself is the finding.
//
// Notes on the SVI analytics used to extract ATM skew without a Monte
// Carlo: with w(y) = a + b·(ρ(y−m) + √((y−m)² + σ²)),
//
//     w(0)       = a − b·ρ·m + b·√(m² + σ²)
//     w′(0)      = b·(ρ − m/√(m² + σ²))
//     σ_ATM(T)   = √(w(0)/T)
//     ∂σ/∂k |₀  = w′(0) / (2 · σ_ATM · T) = w′(0) / (2 · √(T · w(0)))
//
// so each SVI slice produces one (T, skew) point with zero numerical
// integration. Stack all points → regress → out pops H.
// -----------------------------------------------------------------------------

const MIN_T = 5 / 365;
const MAX_T_PLOT = 3;
const MAX_RMSE = 0.015;

function sviSkewAtm(params, T) {
  const { a, b, rho, m, sigma } = params;
  const root = Math.sqrt(m * m + sigma * sigma);
  const w0 = a - b * rho * m + b * root;
  const wPrime0 = b * (rho - m / root);
  if (!(w0 > 0)) return null;
  const sigmaAtm = Math.sqrt(w0 / T);
  const skew = wPrime0 / (2 * sigmaAtm * T);
  return { skew, sigmaAtm, w0, wPrime0 };
}

function buildPoints(sviFits) {
  if (!Array.isArray(sviFits)) return [];
  const points = [];
  for (const f of sviFits) {
    if (!f?.params || !(f.t_years > MIN_T)) continue;
    if (!Number.isFinite(f.rmse_iv) || f.rmse_iv > MAX_RMSE) continue;
    const s = sviSkewAtm(f.params, f.t_years);
    if (!s || !Number.isFinite(s.skew)) continue;
    const absSkew = Math.abs(s.skew);
    if (absSkew <= 0) continue;
    points.push({
      T: f.t_years,
      skew: s.skew,
      absSkew,
      sigmaAtm: s.sigmaAtm,
      expiration: f.expiration_date,
      rmse: f.rmse_iv,
    });
  }
  points.sort((a, b) => a.T - b.T);
  return points;
}

// OLS on log|skew| = slope·log(T) + intercept.
function fitPowerLaw(points) {
  if (points.length < 3) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  const n = points.length;
  for (const p of points) {
    const x = Math.log(p.T);
    const y = Math.log(p.absSkew);
    sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const denom = n * sxx - sx * sx;
  if (!(Math.abs(denom) > 0)) return null;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;

  // R²
  const yMean = sy / n;
  let ssTot = 0, ssRes = 0;
  for (const p of points) {
    const y = Math.log(p.absSkew);
    const yHat = slope * Math.log(p.T) + intercept;
    ssTot += (y - yMean) ** 2;
    ssRes += (y - yHat) ** 2;
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  const H = slope + 0.5;
  return { slope, intercept, H, r2, c: Math.exp(intercept) };
}

function theoryCurve(H, c, Tgrid) {
  // c·T^(H − 1/2)
  return Tgrid.map((T) => c * Math.pow(T, H - 0.5));
}

// --------- UI -------------------------------------------------------------

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

export default function SlotD() {
  const chartRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();
  const mobile = useIsMobile();
  const { data, loading, error } = useOptionsData({
    underlying: 'SPX',
    snapshotType: 'intraday',
  });
  const sviFits = useSviFits({
    contracts: data?.contracts,
    spotPrice: data?.spotPrice,
    capturedAt: data?.capturedAt,
    backendFits: data?.sviFits,
  });

  const sviArray = useMemo(() => {
    const out = [];
    for (const f of Object.values(sviFits?.byExpiration || {})) {
      if (!f?.params || !(f.T > 0)) continue;
      out.push({
        expiration_date: f.expirationDate,
        t_years: f.T,
        forward_price: f.forward,
        params: f.params,
        rmse_iv: f.rmseIv,
      });
    }
    return out;
  }, [sviFits]);

  const points = useMemo(() => buildPoints(sviArray), [sviArray]);
  const fit = useMemo(() => fitPowerLaw(points), [points]);

  useEffect(() => {
    if (!Plotly || !chartRef.current || !fit || points.length < 3) return;

    const Tmin = Math.max(points[0].T * 0.8, MIN_T);
    const Tmax = Math.min(points[points.length - 1].T * 1.2, MAX_T_PLOT);
    const nGrid = 80;
    const logTmin = Math.log(Tmin);
    const logTmax = Math.log(Tmax);
    const Tgrid = new Array(nGrid);
    for (let i = 0; i < nGrid; i++) {
      const t = i / (nGrid - 1);
      Tgrid[i] = Math.exp(logTmin + t * (logTmax - logTmin));
    }

    // Reference H values: the three H values below span the rough-to-
    // classical regime. 0.10 is the empirical SPX consensus (Gatheral,
    // Jaisson, Rosenbaum 2018). 0.30 is an "intermediate rough" regime
    // sometimes seen in crypto/commodities. 0.50 is the classical SV
    // limit corresponding to Brownian-driven models (Heston, Bergomi-05)
    // — Slot A lives at this H; its skew-scaling would match this line.
    const refHs = [0.10, 0.30, 0.50];
    const refColors = [PLOTLY_COLORS.secondary, PLOTLY_COLORS.highlight, PLOTLY_COLORS.primary];

    const traces = [];

    // Theoretical reference curves, normalized to pass through the mean
    // (T̄, |skew|̄) of the points so the rough/classical comparison is
    // anchored on the same intercept as the empirical data
    const meanLogT = points.reduce((s, p) => s + Math.log(p.T), 0) / points.length;
    const meanLogSkew = points.reduce((s, p) => s + Math.log(p.absSkew), 0) / points.length;

    for (let i = 0; i < refHs.length; i++) {
      const H = refHs[i];
      // Pin so that (meanLogT, meanLogSkew) lies on the curve:
      //   log|skew| = (H − 0.5) · log(T) + log c   →  log c = meanLogSkew − (H−0.5)·meanLogT
      const logC = meanLogSkew - (H - 0.5) * meanLogT;
      const c = Math.exp(logC);
      const ys = theoryCurve(H, c, Tgrid);
      traces.push({
        x: Tgrid,
        y: ys,
        mode: 'lines',
        name: `H = ${H.toFixed(2)}${H === 0.5 ? ' · classical SV' : ''}`,
        line: {
          color: refColors[i],
          width: 1.5,
          dash: H === 0.5 ? 'dash' : 'solid',
        },
        hoverinfo: 'skip',
      });
    }

    // Fitted curve
    const fitCurve = theoryCurve(fit.H, fit.c, Tgrid);
    traces.push({
      x: Tgrid,
      y: fitCurve,
      mode: 'lines',
      name: `fit · H = ${fit.H.toFixed(3)}`,
      line: { color: PLOTLY_COLORS.positive, width: 2 },
      hoverinfo: 'skip',
    });

    // Observed points
    traces.push({
      x: points.map((p) => p.T),
      y: points.map((p) => p.absSkew),
      mode: 'markers',
      name: 'observed |∂σ/∂k|',
      marker: {
        color: PLOTLY_COLORS.titleText,
        size: mobile ? 7 : 9,
        line: { color: PLOTLY_COLORS.axisText, width: 1 },
      },
      text: points.map(
        (p) =>
          `${p.expiration}<br>T = ${p.T.toFixed(3)}y<br>σ_ATM = ${(p.sigmaAtm * 100).toFixed(2)}%<br>|skew| = ${p.absSkew.toFixed(4)}`,
      ),
      hovertemplate: '%{text}<extra></extra>',
    });

    const skewMin = Math.min(...points.map((p) => p.absSkew));
    const skewMax = Math.max(...points.map((p) => p.absSkew));

    const layout = plotly2DChartLayout({
      title: {
        ...plotlyTitle('ATM Skew Term Structure · SPX'),
        y: 0.97,
        yref: 'container',
        yanchor: 'top',
      },
      margin: mobile ? { t: 50, r: 30, b: 90, l: 70 } : { t: 70, r: 40, b: 100, l: 85 },
      xaxis: plotlyAxis('Tenor T (years, log)', {
        type: 'log',
        range: [Math.log10(Tmin * 0.95), Math.log10(Tmax * 1.05)],
        autorange: false,
      }),
      yaxis: plotlyAxis('|∂σ_ATM / ∂k|  (log)', {
        type: 'log',
        range: [Math.log10(skewMin * 0.6), Math.log10(skewMax * 1.6)],
        autorange: false,
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
  }, [Plotly, fit, points, mobile]);

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
  if (points.length < 3) {
    return (
      <div className="lab-placeholder">
        <div className="lab-placeholder-title">Not enough SVI slices</div>
        <div className="lab-placeholder-hint">
          The power-law fit needs at least three well-fit SVI expirations in
          the current snapshot. Check back after the next ingest cycle.
        </div>
      </div>
    );
  }

  const isRough = fit && fit.H < 0.35;

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
          model · rough bergomi · skew term-structure scaling law
        </div>
        <div
          style={{
            fontSize: '0.95rem',
            color: 'var(--text-secondary)',
            lineHeight: 1.6,
            maxWidth: '860px',
          }}
        >
          <p style={{ margin: '0 0 0.75rem' }}>
            Rough volatility predicts that ATM skew scales as{' '}
            <code style={{ color: 'var(--text-primary)' }}>|∂σ_ATM/∂k| ~ c · T^(H − ½)</code>.
            The Hurst parameter <strong>H</strong> measures how rough the
            variance driving noise is.
          </p>
          <p style={{ margin: '0 0 0.75rem' }}>
            H = ½ is standard Brownian motion, which is where Slot A&apos;s
            Heston lives. It predicts a flat skew at short T.
          </p>
          <p style={{ margin: '0 0 0.75rem' }}>
            H &lt; ½ is rougher. The volatility path becomes more jagged than
            Brownian and generates the steep short-dated skew that classical SV
            models cannot produce without jumps. SPX consensus since
            Gatheral-Jaisson-Rosenbaum (2018) is H ≈ 0.1.
          </p>
          <p style={{ margin: 0 }}>
            Each{' '}
            <strong style={{ color: PLOTLY_COLORS.titleText }}>observed point</strong>{' '}
            on the chart is the ATM skew from one SVI slice. The{' '}
            <strong style={{ color: PLOTLY_COLORS.positive }}>green line</strong>{' '}
            is the fitted power law. The{' '}
            <strong style={{ color: PLOTLY_COLORS.secondary }}>coral</strong>,{' '}
            <strong style={{ color: PLOTLY_COLORS.highlight }}>amber</strong>, and{' '}
            <strong style={{ color: PLOTLY_COLORS.primary }}>blue</strong>{' '}
            reference lines are T^(H−½) for H = 0.10 / 0.30 / 0.50, each pinned
            to the same intercept so the comparison reads as slope-only.
          </p>
        </div>
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
          label="fit H (Hurst)"
          value={fit ? formatFixed(fit.H, 3) : '-'}
          sub={fit ? `slope = ${fit.slope.toFixed(3)}` : '-'}
          accent={isRough ? PLOTLY_COLORS.secondary : PLOTLY_COLORS.primary}
        />
        <StatCell
          label="regime"
          value={fit ? (isRough ? 'rough' : 'smooth') : '-'}
          sub={fit ? (isRough ? 'H < 0.35' : 'H ≥ 0.35') : '-'}
          accent={isRough ? PLOTLY_COLORS.secondary : undefined}
        />
        <StatCell
          label="R² (log-log)"
          value={fit ? formatFixed(fit.r2, 3) : '-'}
          sub="goodness of power law"
          accent={fit && fit.r2 > 0.9 ? PLOTLY_COLORS.positive : undefined}
        />
        <StatCell
          label="slices used"
          value={points.length.toString()}
          sub={`T ∈ [${points[0].T.toFixed(2)}, ${points[points.length - 1].T.toFixed(2)}]y`}
        />
        <StatCell
          label="short T skew"
          value={formatFixed(points[0]?.absSkew, 4)}
          sub={`at T = ${points[0]?.T.toFixed(3)}y`}
          accent={PLOTLY_COLORS.highlight}
        />
      </div>

      <div ref={chartRef} style={{ width: '100%', height: mobile ? 380 : 480 }} />

      <div
        style={{
          marginTop: '0.8rem',
          fontSize: '0.9rem',
          color: 'var(--text-secondary)',
          lineHeight: 1.65,
        }}
      >
        <p style={{ margin: '0 0 0.75rem' }}>
          <strong style={{ color: 'var(--text-primary)' }}>Reading.</strong>{' '}
          On log-log axes a single Hurst exponent turns into a straight line
          whose slope is H − ½. A fitted{' '}
          <strong style={{ color: isRough ? PLOTLY_COLORS.secondary : PLOTLY_COLORS.primary }}>
            H ≈ {fit ? fit.H.toFixed(2) : '-'}
          </strong>{' '}
          in the 0.05–0.15 band is the canonical rough-vol finding, and it is
          what drove adoption of the Bayer-Friz-Gatheral paper.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          The H = 0.5 reference line is what Heston (Slot A) would trace out.
          The visible gap between that line and the observed points at the
          short end is the empirical anomaly. Heston systematically undershoots.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          Why it matters operationally. If skew scales as T^(−0.4) rather than
          T^(−0.5), then short-dated put risk grows less steeply than a
          classical SV model predicts as you shorten T. That changes both
          hedging cost estimates and forward skew projections for variance-swap
          and VIX-like products.
        </p>
        <p style={{ margin: 0 }}>
          Caveats. The SVI-implied ATM skew is a local tangent read at y = 0,
          so thin wings or bad fits (filtered out above {MAX_RMSE * 100}%%&nbsp;RMSE)
          can still pull the power-law slope. And the ATM skew definition used
          here is ∂σ/∂k, not the variance-swap skew ∂σ²T/∂k that shows up in
          some rough-vol derivations. The two scale the same way at short T
          but carry different intercepts.
        </p>
      </div>
    </div>
  );
}
