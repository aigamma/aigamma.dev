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
import { fitSviSlice, sviTotalVariance } from '../../src/lib/svi';

// -----------------------------------------------------------------------------
// SVI Natural (Gatheral and Jacquier 2014, "Arbitrage-free SVI volatility
// surfaces", section 3.2).
//
// The same 5-parameter curve as Slot C, written in coordinates that center
// on the curve's minimum rather than on an arbitrary origin:
//
//     w(k) = Δ + (ω / 2) * { 1 + ζ * ρ * (k - μ)
//                            + sqrt( (ζ * (k - μ) + ρ)^2 + (1 - ρ^2) ) }
//
// Every parameter carries a direct economic or geometric meaning:
//
//     Δ : minimum total variance on the curve. Floor of w(k).
//     μ : log-moneyness where the minimum lives. Bottom of the smile.
//     ρ : skew. Left/right asymmetry, same as raw.
//     ω : curvature amplitude. Sets how "tall" the cup is above Δ.
//     ζ : horizontal compression. Larger ζ means a steeper, narrower
//         smile. Roughly 1 / σ_raw.
//
// The conversion to raw is an identity: a = Δ + ω*(1-ρ^2)/2, b = ω*ζ/2,
// m = μ - ρ/ζ, σ = sqrt(1-ρ^2)/ζ. The two curves agree pointwise. What
// changes is which parameter is "the one you reach for" when thinking
// about the smile.
//
// Why natural helps. If a risk desk asks "where is the bottom of this
// smile today and how deep is it," raw SVI cannot answer without
// algebra. m in raw is not the minimum of w; the minimum sits offset
// from m by ρσ/sqrt(1-ρ^2). Natural SVI puts that directly on the
// parameter sheet: the minimum is at μ and its value is Δ. Two
// of the five parameters are now "where is it" and "how deep is it,"
// which is what a human reader wants.
//
// The chart below plots total variance w(k) instead of implied vol.
// Total variance is the object natural SVI parameterizes directly, and
// the reparameterization geometry is only visible in that space. The
// minimum point (μ, Δ) is marked; the asymptotic wing slopes are
// annotated. The IV-vs-strike view lives in Slot C.
// -----------------------------------------------------------------------------

function toNatural({ a, b, rho, m, sigma }) {
  const root = Math.sqrt(Math.max(1 - rho * rho, 1e-12));
  const zeta = root / sigma;
  const omega = (2 * b * sigma) / root;
  const mu = m + (rho * sigma) / root;
  const delta = a - b * sigma * root;
  return { delta, mu, rho, omega, zeta };
}

// --------- UI helpers ---------------------------------------------------

function formatPct(v, d = 2) {
  if (v == null || !Number.isFinite(v)) return '-';
  return `${(v * 100).toFixed(d)}%`;
}
function formatFixed(v, d = 3) {
  if (v == null || !Number.isFinite(v)) return '-';
  return v.toFixed(d);
}
function formatScientific(v, d = 3) {
  if (v == null || !Number.isFinite(v)) return '-';
  if (Math.abs(v) < 1e-3) return v.toExponential(d);
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

  const natural = useMemo(() => (fit ? toNatural(fit.params) : null), [fit]);

  useEffect(() => {
    if (!Plotly || !chartRef.current || !fit) return;

    const W = fit.tenorWindow;
    const p = fit.params;
    const nat = natural;
    const nGrid = 201;

    // Plot domain: a little wider than the calibration window so the
    // asymptotic behavior is visible.
    const kLo = -W * 1.15;
    const kHi = W * 1.15;
    const gridK = new Array(nGrid);
    const gridW = new Array(nGrid);
    for (let i = 0; i < nGrid; i++) {
      gridK[i] = kLo + (i / (nGrid - 1)) * (kHi - kLo);
      gridW[i] = sviTotalVariance(p, gridK[i]);
    }

    // Sample points in (k, w) space.
    const sampleK = fit.samples.map((s) => s.k);
    const sampleW = fit.samples.map((s) => s.w);

    // Minimum of the curve in (k, w) space. Natural places this at (mu, delta).
    const minK = nat.mu;
    const minW = nat.delta;

    // Asymptotic slopes of w: left slope = b(rho - 1), right slope = b(rho + 1).
    // Draw short rays from the left and right edges back toward the minimum
    // so the reader can see the wing tangents.
    const slopeL = p.b * (p.rho - 1);
    const slopeR = p.b * (p.rho + 1);
    const wLeftEdge = sviTotalVariance(p, kLo);
    const wRightEdge = sviTotalVariance(p, kHi);
    const asymLeftX = [kLo, kLo + (minK - kLo) * 0.35];
    const asymLeftY = [wLeftEdge, wLeftEdge + slopeL * (minK - kLo) * 0.35];
    const asymRightX = [kHi - (kHi - minK) * 0.35, kHi];
    const asymRightY = [wRightEdge - slopeR * (kHi - minK) * 0.35, wRightEdge];

    const allW = [...sampleW, ...gridW, minW];
    const yMin = Math.min(...allW);
    const yMax = Math.max(...allW);
    const pad = (yMax - yMin) * 0.15 || 0.01;

    const traces = [
      {
        x: sampleK,
        y: sampleW,
        mode: 'markers',
        name: 'observed w(k)',
        marker: { color: PLOTLY_COLORS.primary, size: mobile ? 7 : 9 },
        hovertemplate: 'k %{x:.3f}<br>w %{y:.4f}<extra></extra>',
      },
      {
        x: gridK,
        y: gridW,
        mode: 'lines',
        name: 'SVI fit · natural form',
        line: { color: PLOTLY_COLORS.highlight, width: 2 },
        hoverinfo: 'skip',
      },
      {
        x: [minK],
        y: [minW],
        mode: 'markers+text',
        name: 'minimum (μ, Δ)',
        marker: {
          color: PLOTLY_COLORS.secondary,
          size: mobile ? 10 : 13,
          symbol: 'diamond',
          line: { color: PLOTLY_COLORS.titleText, width: 1 },
        },
        text: [' (μ, Δ)'],
        textposition: 'top right',
        textfont: { color: PLOTLY_COLORS.secondary, family: 'Courier New, monospace', size: 11 },
        hovertemplate: 'μ = %{x:.3f}<br>Δ = %{y:.4f}<extra></extra>',
      },
      {
        x: asymLeftX,
        y: asymLeftY,
        mode: 'lines',
        name: 'left wing slope b(ρ−1)',
        line: { color: PLOTLY_COLORS.positive, width: 1.5, dash: 'dash' },
        hoverinfo: 'skip',
        showlegend: false,
      },
      {
        x: asymRightX,
        y: asymRightY,
        mode: 'lines',
        name: 'right wing slope b(ρ+1)',
        line: { color: PLOTLY_COLORS.positive, width: 1.5, dash: 'dash' },
        hoverinfo: 'skip',
        showlegend: false,
      },
      {
        x: [0, 0],
        y: [yMin - pad, yMax + pad],
        mode: 'lines',
        name: 'forward (k=0)',
        line: { color: PLOTLY_COLORS.axisText, width: 1, dash: 'dot' },
        hoverinfo: 'skip',
        showlegend: false,
      },
    ];

    const layout = plotly2DChartLayout({
      title: {
        ...plotlyTitle('Total Variance w(k) · SVI Natural Form'),
        y: 0.97,
        yref: 'container',
        yanchor: 'top',
      },
      margin: mobile ? { t: 50, r: 25, b: 85, l: 70 } : { t: 70, r: 35, b: 100, l: 85 },
      xaxis: plotlyAxis('Log-Moneyness k = ln(K/F)', {
        range: [kLo, kHi],
        autorange: false,
      }),
      yaxis: plotlyAxis('Total variance w(k)', {
        range: [yMin - pad, yMax + pad],
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
      hovermode: 'closest',
    });

    Plotly.react(chartRef.current, traces, layout, {
      responsive: true,
      displayModeBar: false,
    });
  }, [Plotly, fit, natural, mobile]);

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

  // Economic readouts. σ_min is the implied vol at the curve minimum:
  // sqrt(Δ/T). σ_atm is the implied vol at k = 0: sqrt(w(0)/T).
  const sigmaMin = fit && natural && fit.T > 0 && natural.delta > 0
    ? Math.sqrt(natural.delta / fit.T)
    : null;
  const wAtm = fit ? sviTotalVariance(fit.params, 0) : null;
  const sigmaAtm = fit && wAtm > 0 && fit.T > 0 ? Math.sqrt(wAtm / fit.T) : null;

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
        svi natural · reparameterized around the minimum
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
          DTE {dte != null ? dte.toFixed(1) : '-'} · T = {fit?.T ? fit.T.toFixed(3) : '-'} ·
          samples {fit?.sampleCount ?? '-'}
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
          label="Δ · min variance"
          value={natural ? formatScientific(natural.delta, 4) : '-'}
          sub="floor of w(k)"
          accent={PLOTLY_COLORS.secondary}
        />
        <StatCell
          label="μ · min log-K"
          value={natural ? formatFixed(natural.mu, 4) : '-'}
          sub="where w(k) bottoms"
        />
        <StatCell
          label="ρ · skew"
          value={natural ? formatFixed(natural.rho, 3) : '-'}
          sub="same as raw"
          accent={natural && natural.rho < -0.5 ? PLOTLY_COLORS.secondary : undefined}
        />
        <StatCell
          label="ω · amplitude"
          value={natural ? formatFixed(natural.omega, 3) : '-'}
          sub="curve height scale"
          accent={PLOTLY_COLORS.highlight}
        />
        <StatCell
          label="ζ · compression"
          value={natural ? formatFixed(natural.zeta, 2) : '-'}
          sub="1/σ_raw horizontal scale"
          accent={PLOTLY_COLORS.positive}
        />
        <StatCell
          label="σ at minimum"
          value={sigmaMin != null ? formatPct(sigmaMin, 1) : '-'}
          sub={sigmaAtm != null ? `σ_ATM = ${formatPct(sigmaAtm, 1)}` : '-'}
        />
      </div>

      <div ref={chartRef} style={{ width: '100%', height: mobile ? 400 : 480 }} />

      <div
        style={{
          marginTop: '0.8rem',
          fontSize: '0.9rem',
          color: 'var(--text-secondary)',
          lineHeight: 1.65,
        }}
      >
        <p style={{ margin: '0 0 0.75rem' }}>
          Natural SVI is the same curve as Slot C with different axes
          of thought. Instead of picking parameters that describe the
          algebra of the formula{' '}
          <code style={{ color: 'var(--text-primary)' }}>(a, b, m)</code>{' '}
          it picks parameters that describe the geometry of the smile{' '}
          <code style={{ color: 'var(--text-primary)' }}>(Δ, μ, ω, ζ)</code>{' '}
          plus the shared skew ρ.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          The{' '}
          <strong style={{ color: PLOTLY_COLORS.secondary }}>red diamond</strong>{' '}
          is the minimum of the total variance curve. Its horizontal
          position is{' '}
          <strong style={{ color: 'var(--text-primary)' }}>μ</strong>{' '}
          (log-moneyness of the bottom) and its height is{' '}
          <strong style={{ color: 'var(--text-primary)' }}>Δ</strong>{' '}
          (floor of total variance). In raw SVI neither number is
          directly a parameter; both require algebra.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          The{' '}
          <strong style={{ color: PLOTLY_COLORS.positive }}>green dashes</strong>{' '}
          are the asymptotic wing slopes. Left slope is b(ρ−1), right
          slope is b(ρ+1). ρ tilts the cup; ζ compresses it in k; ω
          scales it in w. Natural SVI isolates these three knobs so
          that changing one does not smear across the others the way it
          does in raw.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          <strong style={{ color: 'var(--text-primary)' }}>Reading.</strong>{' '}
          The y-axis here is total variance w(k), not implied vol, because
          that is the native space of the natural parameterization. Total
          variance goes up as T grows even if implied vol stays flat, so
          do not compare w(k) numbers across expirations without the
          T scaling.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          Natural parameters read cleanly against the picture. Δ is the
          y-coordinate of the red diamond. μ is its x-coordinate. ω is
          roughly the distance from Δ to the ATM variance reading,
          scaled by (1-ρ²). ζ controls how fast the curve closes off the
          minimum; a small ζ makes a wide bowl, a large ζ makes a narrow V.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          Why this matters operationally. Calibration through natural
          parameters is more numerically stable because they are less
          correlated at the optimum. Raw (a, b, m, σ) has well-known
          parameter tradeoffs where two different raw parameter sets
          produce nearly identical curves, which makes Hessian inversion
          for confidence intervals unstable. Natural parameters decouple
          the geometry and produce better-conditioned optimization.
        </p>
        <p style={{ margin: 0 }}>
          The fit here uses the raw form under the hood (Slot C&apos;s LM
          solver) and then converts to natural for display. This is by
          design: the two spaces are related by a smooth invertible map,
          so fitting in raw and reading in natural gives the same answer
          as fitting in natural directly, modulo a harmless reparameterization.
        </p>
      </div>
    </div>
  );
}
