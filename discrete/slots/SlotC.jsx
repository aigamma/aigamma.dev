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
import { fitSviSlice, sviTotalVariance, durrlemanG } from '../../src/lib/svi';

// -----------------------------------------------------------------------------
// SVI Raw (Stochastic Volatility Inspired, Gatheral 2004).
//
// Raw SVI expresses total variance w(k) = sigma(k)^2 * T as
//
//     w(k; a, b, rho, m, sigma) = a + b * (rho * (k - m) + sqrt((k - m)^2 + sigma^2))
//
// where k = ln(K / F) is log-moneyness relative to the forward. Five
// parameters. Admissibility: b >= 0, |rho| < 1, sigma > 0,
// a + b * sigma * sqrt(1 - rho^2) >= 0 so total variance stays non-negative
// at the curve's minimum.
//
// Each parameter controls a visible piece of the smile. a shifts the whole
// curve up or down. b controls the overall slope magnitude. rho tilts the
// left/right asymmetry (skew). m is the log-moneyness of the minimum
// variance point. sigma controls the curvature at the minimum: small sigma
// means a sharp V, large sigma means a rounded cup.
//
// This is the workhorse parametric family in equity-index vol modeling.
// Every IV-surface product on the platform that looks at a single
// expiration at a time starts here. The dashboard's ATM IV, the 25-delta
// put and call IVs, the Expected Move, and the snapshot skew numbers all
// read values off this curve. The slot below is that exact fit, exposed
// with its five parameters and with Durrleman's butterfly diagnostic.
//
// Durrleman's g(k). A slice is butterfly-arbitrage-free iff
//
//     g(k) = (1 - k * w'(k) / (2 * w(k)))^2
//            - (w'(k))^2 / 4 * (1 / w(k) + 1 / 4)
//            + w''(k) / 2
//
// is non-negative everywhere. g(k) < 0 somewhere means the fitted curve
// implies a risk-neutral density that goes negative at that log-moneyness,
// which violates monotonicity of the Breeden-Litzenberger derivation and
// would let a synthetic butterfly trade be priced below zero. Ideal SVI
// fits have g(k) >= 0 across the whole liquid region. Borderline fits dip
// slightly negative in the wings where the data is thin.
// -----------------------------------------------------------------------------

// --------- UI helpers ---------------------------------------------------

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

export default function SlotC() {
  const fitChartRef = useRef(null);
  const gChartRef = useRef(null);
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

  const dte = useMemo(() => {
    if (!activeExp || !data?.capturedAt) return null;
    return daysToExpiration(activeExp, data.capturedAt);
  }, [activeExp, data]);

  const fit = useMemo(() => {
    if (!data || !activeExp || !(data.spotPrice > 0)) return null;
    const sliceContracts = data.contracts.filter((c) => c.expiration_date === activeExp);
    if (sliceContracts.length < 8) return null;
    const res = fitSviSlice({
      contracts: sliceContracts,
      spotPrice: data.spotPrice,
      expirationDate: activeExp,
      capturedAt: data.capturedAt,
    });
    return res.ok ? res : null;
  }, [data, activeExp]);

  // Top chart: observed IVs and fitted SVI curve in strike space.
  useEffect(() => {
    if (!Plotly || !fitChartRef.current || !fit || !data?.spotPrice) return;

    const T = fit.T;
    const F = data.spotPrice;
    const strikes = fit.samples.map((s) => s.strike);
    const ivs = fit.samples.map((s) => s.iv * 100);
    const kLo = Math.min(...fit.samples.map((s) => s.k));
    const kHi = Math.max(...fit.samples.map((s) => s.k));
    const nGrid = 140;
    const gridK = new Array(nGrid);
    const gridStrikes = new Array(nGrid);
    const gridIv = new Array(nGrid);
    for (let i = 0; i < nGrid; i++) {
      const k = kLo + (i / (nGrid - 1)) * (kHi - kLo);
      gridK[i] = k;
      gridStrikes[i] = F * Math.exp(k);
      const w = sviTotalVariance(fit.params, k);
      gridIv[i] = w > 0 && T > 0 ? Math.sqrt(w / T) * 100 : null;
    }

    const allIv = [...ivs, ...gridIv.filter((v) => v != null)];
    const yMin = Math.min(...allIv);
    const yMax = Math.max(...allIv);
    const pad = (yMax - yMin) * 0.12 || 1;
    const xLo = Math.min(...strikes);
    const xHi = Math.max(...strikes);

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
        x: gridStrikes,
        y: gridIv,
        mode: 'lines',
        name: 'SVI raw fit',
        line: { color: PLOTLY_COLORS.highlight, width: 2 },
        hoverinfo: 'skip',
        connectgaps: false,
      },
      {
        x: [F, F],
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
        ...plotlyTitle(mobile ? 'SVI Raw Fit<br>SPX slice' : 'SVI Raw Fit · SPX slice'),
        y: 0.97,
        yref: 'container',
        yanchor: 'top',
      },
      margin: mobile ? { t: 75, r: 25, b: 85, l: 60 } : { t: 70, r: 35, b: 100, l: 75 },
      xaxis: plotlyAxis('Strike', {
        range: [xLo - (xHi - xLo) * 0.02, xHi + (xHi - xLo) * 0.02],
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

    Plotly.react(fitChartRef.current, traces, layout, {
      responsive: true,
      displayModeBar: false,
    });
  }, [Plotly, fit, data, mobile]);

  // Second chart: Durrleman's g(k) over the calibration window.
  useEffect(() => {
    if (!Plotly || !gChartRef.current || !fit) return;

    const W = fit.tenorWindow;
    const nGrid = 181;
    const gridK = new Array(nGrid);
    const gridG = new Array(nGrid);
    for (let i = 0; i < nGrid; i++) {
      const k = -W + (2 * W * i) / (nGrid - 1);
      gridK[i] = k;
      gridG[i] = durrlemanG(fit.params, k);
    }
    const minG = Math.min(...gridG);
    const maxG = Math.max(...gridG);
    const pad = Math.max(Math.abs(minG), Math.abs(maxG)) * 0.1 || 0.05;
    const yMin = Math.min(minG, 0) - pad;
    const yMax = maxG + pad;

    const traces = [
      {
        x: gridK,
        y: gridG,
        mode: 'lines',
        name: 'Durrleman g(k)',
        line: { color: PLOTLY_COLORS.positive, width: 2 },
        fill: 'tozeroy',
        fillcolor: 'rgba(46, 204, 113, 0.15)',
        hovertemplate: 'k %{x:.3f}<br>g %{y:.4f}<extra></extra>',
      },
      {
        x: [-W, W],
        y: [0, 0],
        mode: 'lines',
        name: 'arbitrage threshold',
        line: { color: PLOTLY_COLORS.secondary, width: 1, dash: 'dash' },
        hoverinfo: 'skip',
      },
    ];

    const layout = plotly2DChartLayout({
      title: {
        ...plotlyTitle(
          mobile
            ? 'No-Butterfly-Arbitrage<br>g(k) ≥ 0 required'
            : 'No-Butterfly-Arbitrage · g(k) ≥ 0 required'
        ),
        y: 0.96,
        yref: 'container',
        yanchor: 'top',
      },
      margin: mobile ? { t: 75, r: 25, b: 70, l: 60 } : { t: 60, r: 35, b: 80, l: 75 },
      xaxis: plotlyAxis('Log-Moneyness k = ln(K/F)', {
        range: [-W, W],
        autorange: false,
      }),
      yaxis: plotlyAxis('g(k)', {
        range: [yMin, yMax],
        autorange: false,
        tickformat: '.3f',
      }),
      showlegend: true,
      legend: {
        orientation: 'h',
        y: -0.22,
        x: 0.5,
        xanchor: 'center',
        font: PLOTLY_FONTS.legend,
      },
      hovermode: 'x unified',
    });

    Plotly.react(gChartRef.current, traces, layout, {
      responsive: true,
      displayModeBar: false,
    });
  }, [Plotly, fit, mobile]);

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

  const pickerExpirations = data?.expirations
    ? filterPickerExpirations(data.expirations, data.capturedAt)
    : [];

  const p = fit?.params;
  const minG = fit?.diagnostics?.minDurrlemanG;
  const butterflyOk = fit?.diagnostics?.butterflyArbFree;

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
        svi raw · 5 parameters · one expiration slice
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
          DTE {dte != null ? dte.toFixed(1) : '-'} · samples {fit?.sampleCount ?? '-'} ·
          window ±{fit?.tenorWindow ? fit.tenorWindow.toFixed(2) : '-'} · T = {fit?.T ? fit.T.toFixed(3) : '-'}
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
          label="a · level"
          value={p ? formatFixed(p.a, 4) : '-'}
          sub="vertical shift"
        />
        <StatCell
          label="b · slope scale"
          value={p ? formatFixed(p.b, 4) : '-'}
          sub="overall steepness"
        />
        <StatCell
          label="ρ · skew"
          value={p ? formatFixed(p.rho, 3) : '-'}
          sub="left/right tilt"
          accent={p && p.rho < -0.5 ? PLOTLY_COLORS.secondary : undefined}
        />
        <StatCell
          label="m · min k"
          value={p ? formatFixed(p.m, 4) : '-'}
          sub="log-moneyness of min"
        />
        <StatCell
          label="σ · curvature"
          value={p ? formatFixed(p.sigma, 4) : '-'}
          sub="smile roundedness"
        />
        <StatCell
          label="RMSE (IV)"
          value={fit ? formatPct(fit.rmseIv, 2) : '-'}
          sub={fit ? `${fit.iterations} LM iter` : '-'}
          accent={fit && fit.rmseIv < 0.01 ? PLOTLY_COLORS.positive : undefined}
        />
      </div>

      <div ref={fitChartRef} style={{ width: '100%', height: mobile ? 340 : 400 }} />

      <div ref={gChartRef} style={{ width: '100%', height: mobile ? 240 : 280, marginTop: '1.1rem' }} />

      <div
        style={{
          marginTop: '0.8rem',
          fontSize: '0.9rem',
          color: 'var(--text-secondary)',
          lineHeight: 1.65,
        }}
      >
        <p style={{ margin: '0 0 0.75rem' }}>
          Raw SVI is the standard parametric form for a single-expiration
          smile. Five numbers{' '}
          <code style={{ color: 'var(--text-primary)' }}>(a, b, ρ, m, σ)</code>{' '}
          pin down a convex-capable curve in total variance space. The
          platform&apos;s stored SVI fits all live in this parameterization.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          The{' '}
          <strong style={{ color: PLOTLY_COLORS.primary }}>observed IVs</strong>{' '}
          are the liquid OTM marks from the current SPX snapshot for the
          selected expiration. The{' '}
          <strong style={{ color: PLOTLY_COLORS.highlight }}>fitted curve</strong>{' '}
          is the Levenberg-Marquardt solution to vega-weighted squared
          residuals in total-variance space. The fit is the basis for
          every smoothed IV number the site publishes.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          The second chart above is Durrleman&apos;s g(k). Fits with{' '}
          <strong style={{ color: PLOTLY_COLORS.positive }}>g(k) ≥ 0</strong>{' '}
          everywhere imply a strictly non-negative risk-neutral density.
          Fits that dip below the{' '}
          <strong style={{ color: PLOTLY_COLORS.secondary }}>red dashed threshold</strong>{' '}
          admit butterfly arbitrage somewhere in the wings and should be
          treated as diagnostic warnings, not as fatal errors, because
          thin data in the wings can legitimately break the test without
          implying anything tradable.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          <strong style={{ color: 'var(--text-primary)' }}>Reading.</strong>{' '}
          The upper chart is the fit. Good fits hug the blue dots with
          no systematic bias, especially at the ATM strike where vega is
          highest and the fit weighting puts most of its attention.
          Systematic miss in the wings usually means the sigma parameter
          is locked too tight; rerunning the fit with a multi-start seed
          usually resolves it.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          The lower chart is the arbitrage diagnostic. Below the{' '}
          <strong style={{ color: PLOTLY_COLORS.secondary }}>red threshold</strong>{' '}
          the fit admits butterfly arbitrage. Above it, the implied
          density is proper. SPX smiles fit under this parameterization
          almost always keep g(k) strictly positive across the ±20%
          log-moneyness window, which is why this fit can feed directly
          into the Breeden-Litzenberger density extraction without
          needing a density-clip step.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          The current fit reports min g(k) ={' '}
          <strong
            style={{
              color: butterflyOk ? PLOTLY_COLORS.positive : PLOTLY_COLORS.secondary,
            }}
          >
            {minG != null ? formatFixed(minG, 4) : '-'}
          </strong>
          . A value below zero flags that the fitted density goes
          negative somewhere in the tested window and that the fit
          should be used with care in any downstream tail computation.
        </p>
        <p style={{ margin: 0 }}>
          This slice fit is locally optimal. It does not know what any
          other expiration looks like, so two adjacent-maturity raw-SVI
          fits can in principle violate calendar arbitrage
          (non-decreasing total variance in T at every k). Slot F
          below shows the surface-level fix for that.
        </p>
      </div>
    </div>
  );
}
