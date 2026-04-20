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
// SVI-JW (Jump-Wing, Gatheral 2004; see Gatheral-Jacquier 2014 section 3.3).
//
// Same curve again, third parameterization. JW is the trader-readable form.
// Every number is a quantity a desk looks at directly when pricing or
// hedging a smile. The five JW parameters, for a slice with total variance
// w(0) at the forward and tenor T:
//
//     v_t    = w(0) / T                                  (ATM variance)
//     psi_t  = ( 1 / ( 2 * sqrt(w(0)) ) ) * w'(0)        (ATM skew)
//     p_t    = b * (1 - rho) / sqrt(w(0))                (put-wing slope)
//     c_t    = b * (1 + rho) / sqrt(w(0))                (call-wing slope)
//     v~_t   = w_min / T                                 (min variance)
//
// where w'(0) is the raw SVI derivative at k = 0. The first slot parameter
// is the ATM variance the trader already watches on every other screen.
// The second is the ATM skew expressed as d_sigma/d_k at k = 0, again a
// quantity every vol desk has a name for. The last two are the asymptotic
// slopes of the wings expressed in BSM vol space, which are the numbers
// that quote the "wing thickness" of the smile.
//
// Because each JW parameter corresponds to something the reader can point
// at on the curve, JW is the quoting convention of choice across most
// equity-vol desks for single-slice fitting. A market-maker who reports
// "v_t = 16%, psi_t = -0.8, p_t = 0.6, c_t = 0.3, v~_t = 14%" has
// communicated the entire smile without sending a functional form.
//
// The chart below is implied vol versus log-moneyness (not total variance
// like Slot D, and not strike like Slot C) because each JW parameter reads
// off σ(k) directly. Arrows and dashed lines on the chart show where the
// five numbers live.
// -----------------------------------------------------------------------------

function computeJw({ a, b, rho, m, sigma }, T) {
  const root = Math.sqrt(m * m + sigma * sigma);
  const w0 = a + b * (-rho * m + root);
  const wPrime0 = b * (rho - m / root);
  const wMin = a + b * sigma * Math.sqrt(Math.max(1 - rho * rho, 1e-12));
  if (!(w0 > 0)) return null;
  const sqrtW0 = Math.sqrt(w0);
  return {
    v: w0 / T,
    psi: wPrime0 / (2 * sqrtW0),
    p: (b * (1 - rho)) / sqrtW0,
    c: (b * (1 + rho)) / sqrtW0,
    vTilde: Math.max(wMin / T, 0),
    w0,
    wPrime0,
  };
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

export default function SlotE() {
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

  const jw = useMemo(() => (fit ? computeJw(fit.params, fit.T) : null), [fit]);

  useEffect(() => {
    if (!Plotly || !chartRef.current || !fit || !jw) return;

    const W = fit.tenorWindow;
    const T = fit.T;
    const p = fit.params;

    // Plot σ(k) = sqrt(w(k)/T) over the calibration window, slightly extended.
    const kLo = -W * 1.1;
    const kHi = W * 1.1;
    const nGrid = 201;
    const gridK = new Array(nGrid);
    const gridSigma = new Array(nGrid);
    for (let i = 0; i < nGrid; i++) {
      const k = kLo + (i / (nGrid - 1)) * (kHi - kLo);
      gridK[i] = k;
      const w = sviTotalVariance(p, k);
      gridSigma[i] = w > 0 ? Math.sqrt(w / T) * 100 : null;
    }

    // Observations.
    const sampleK = fit.samples.map((s) => s.k);
    const sampleSigma = fit.samples.map((s) => s.iv * 100);

    // ATM reading and tangent line visualizing psi_t.
    const sigmaAtmPct = Math.sqrt(jw.v) * 100;
    // d sigma / d k at k = 0: d/dk sqrt(w/T) at 0 = w'(0)/(2*sqrt(w(0)*T))
    //                                             = (psi_t) / sqrt(T) in our convention
    // but sigma is in decimal; convert to percentage-per-unit-k by multiplying by 100.
    const dSigma_dk_atm = (jw.wPrime0 / (2 * Math.sqrt(jw.w0 * T))) * 100;
    const tangentHalfWidth = 0.08;
    const tangentX = [-tangentHalfWidth, tangentHalfWidth];
    const tangentY = [
      sigmaAtmPct - dSigma_dk_atm * tangentHalfWidth,
      sigmaAtmPct + dSigma_dk_atm * tangentHalfWidth,
    ];

    // Asymptotic wing slopes for sigma(k). Wings of w(k) have slopes
    // b*(rho-1) (left) and b*(rho+1) (right). Translate to sigma slope by
    // chain rule: d sigma / dk = (dw/dk) / (2 * sqrt(w * T)). Use the
    // asymptotic value of w at large |k| for the denominator.
    const wLeftEdge = sviTotalVariance(p, kLo);
    const wRightEdge = sviTotalVariance(p, kHi);
    const sigmaLeftEdge = wLeftEdge > 0 ? Math.sqrt(wLeftEdge / T) * 100 : 0;
    const sigmaRightEdge = wRightEdge > 0 ? Math.sqrt(wRightEdge / T) * 100 : 0;

    // Draw dashed rays that visualize the wing slopes in BSM vol space.
    // Anchor them at the left/right edges and point back toward k = 0 at
    // the BSM-implied slope, which is the derivative of sigma(k) taken at
    // the edge.
    const dSigma_left = (p.b * (p.rho - 1)) / (2 * Math.sqrt(wLeftEdge * T)) * 100;
    const dSigma_right = (p.b * (p.rho + 1)) / (2 * Math.sqrt(wRightEdge * T)) * 100;
    const rayFrac = 0.35;
    const asymLeftX = [kLo, kLo + (0 - kLo) * rayFrac];
    const asymLeftY = [sigmaLeftEdge, sigmaLeftEdge + dSigma_left * (0 - kLo) * rayFrac];
    const asymRightX = [kHi - (kHi - 0) * rayFrac, kHi];
    const asymRightY = [sigmaRightEdge - dSigma_right * (kHi - 0) * rayFrac, sigmaRightEdge];

    // Floor line at sigma corresponding to v_tilde.
    const sigmaMinPct = Math.sqrt(Math.max(jw.vTilde, 0)) * 100;

    const allSigma = [
      ...sampleSigma,
      ...gridSigma.filter((v) => v != null),
      sigmaAtmPct,
      sigmaMinPct,
    ];
    const yMin = Math.min(...allSigma);
    const yMax = Math.max(...allSigma);
    const pad = (yMax - yMin) * 0.15 || 1;

    const traces = [
      {
        x: sampleK,
        y: sampleSigma,
        mode: 'markers',
        name: 'observed IV',
        marker: { color: PLOTLY_COLORS.primary, size: mobile ? 7 : 9 },
        hovertemplate: 'k %{x:.3f}<br>σ %{y:.2f}%<extra></extra>',
      },
      {
        x: gridK,
        y: gridSigma,
        mode: 'lines',
        name: 'SVI fit · σ(k)',
        line: { color: PLOTLY_COLORS.highlight, width: 2 },
        hoverinfo: 'skip',
        connectgaps: false,
      },
      {
        x: [kLo, kHi],
        y: [sigmaAtmPct, sigmaAtmPct],
        mode: 'lines',
        name: `v_t · σ_ATM ${sigmaAtmPct.toFixed(2)}%`,
        line: { color: PLOTLY_COLORS.secondary, width: 1.5, dash: 'dash' },
        hoverinfo: 'skip',
      },
      {
        x: tangentX,
        y: tangentY,
        mode: 'lines',
        name: `ψ_t · ATM skew ${jw.psi.toFixed(3)}`,
        line: { color: PLOTLY_COLORS.positive, width: 2.5 },
        hoverinfo: 'skip',
      },
      {
        x: asymLeftX,
        y: asymLeftY,
        mode: 'lines',
        name: `p_t · put wing ${jw.p.toFixed(3)}`,
        line: { color: PLOTLY_COLORS.primarySoft || '#93c5fd', width: 1.8, dash: 'dot' },
        hoverinfo: 'skip',
      },
      {
        x: asymRightX,
        y: asymRightY,
        mode: 'lines',
        name: `c_t · call wing ${jw.c.toFixed(3)}`,
        line: { color: PLOTLY_COLORS.primary, width: 1.8, dash: 'dot' },
        hoverinfo: 'skip',
      },
      {
        x: [kLo, kHi],
        y: [sigmaMinPct, sigmaMinPct],
        mode: 'lines',
        name: `ṽ_t · σ_min ${sigmaMinPct.toFixed(2)}%`,
        line: { color: PLOTLY_COLORS.axisText, width: 1, dash: 'dashdot' },
        hoverinfo: 'skip',
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
        ...plotlyTitle('σ(k) · SVI-JW Parameters on the Smile'),
        y: 0.97,
        yref: 'container',
        yanchor: 'top',
      },
      margin: mobile ? { t: 50, r: 25, b: 140, l: 60 } : { t: 70, r: 35, b: 150, l: 75 },
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
        // Six-item legend wraps on mobile; let Plotly lay it out over two rows.
      },
      hovermode: 'closest',
    });

    Plotly.react(chartRef.current, traces, layout, {
      responsive: true,
      displayModeBar: false,
    });
  }, [Plotly, fit, jw, mobile]);

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
        svi-jw · trader-readable quoting convention
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
          gridTemplateColumns: mobile ? 'repeat(2, 1fr)' : 'repeat(5, 1fr)',
          gap: '0.85rem',
          padding: '0.75rem 0',
          borderTop: '1px solid var(--bg-card-border)',
          borderBottom: '1px solid var(--bg-card-border)',
          marginBottom: '0.85rem',
        }}
      >
        <StatCell
          label="v_t · ATM σ²"
          value={jw ? formatPct(Math.sqrt(Math.max(jw.v, 0)), 2) : '-'}
          sub="as ann. vol"
          accent={PLOTLY_COLORS.secondary}
        />
        <StatCell
          label="ψ_t · ATM skew"
          value={jw ? formatFixed(jw.psi, 3) : '-'}
          sub="∂σ/∂k at k=0"
          accent={jw && jw.psi < -0.5 ? PLOTLY_COLORS.secondary : PLOTLY_COLORS.positive}
        />
        <StatCell
          label="p_t · put wing"
          value={jw ? formatFixed(jw.p, 3) : '-'}
          sub="|∂σ/∂k| left asymp."
          accent={PLOTLY_COLORS.primarySoft || '#93c5fd'}
        />
        <StatCell
          label="c_t · call wing"
          value={jw ? formatFixed(jw.c, 3) : '-'}
          sub="∂σ/∂k right asymp."
          accent={PLOTLY_COLORS.primary}
        />
        <StatCell
          label="ṽ_t · σ_min"
          value={jw ? formatPct(Math.sqrt(Math.max(jw.vTilde, 0)), 2) : '-'}
          sub="floor of σ(k)"
          accent={PLOTLY_COLORS.axisText}
        />
      </div>

      <div ref={chartRef} style={{ width: '100%', height: mobile ? 420 : 520 }} />

      <div
        style={{
          marginTop: '0.8rem',
          fontSize: '0.9rem',
          color: 'var(--text-secondary)',
          lineHeight: 1.65,
        }}
      >
        <p style={{ margin: '0 0 0.75rem' }}>
          JW is the same curve as Slots C and D with a third set of
          names. The numbers are picked so each one corresponds to
          something a vol trader already thinks about every day:{' '}
          <strong style={{ color: PLOTLY_COLORS.secondary }}>v_t</strong>{' '}
          is ATM variance,{' '}
          <strong style={{ color: PLOTLY_COLORS.positive }}>ψ_t</strong>{' '}
          is ATM skew,{' '}
          <strong style={{ color: PLOTLY_COLORS.primary }}>p_t / c_t</strong>{' '}
          are the put-wing and call-wing slopes, and{' '}
          <strong style={{ color: PLOTLY_COLORS.axisText }}>ṽ_t</strong>{' '}
          is the minimum variance floor.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          Each of those quantities is a piece of the picture you can
          point at on the chart. ATM variance is the height of the{' '}
          <strong style={{ color: PLOTLY_COLORS.secondary }}>dashed red line</strong>{' '}
          at k = 0. ATM skew is the slope of the{' '}
          <strong style={{ color: PLOTLY_COLORS.positive }}>short green tangent</strong>{' '}
          through k = 0. Wing slopes are the slopes of the{' '}
          <strong style={{ color: PLOTLY_COLORS.primary }}>dotted blue rays</strong>{' '}
          at the edges. The floor is the{' '}
          <strong style={{ color: PLOTLY_COLORS.axisText }}>gray dashdot line</strong>{' '}
          at the bottom.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          JW is a communication format. You can send a five-tuple over
          the tape and the receiver can redraw the smile. That is not
          true of raw (Slot C) or natural (Slot D), where the numbers
          are not pointed at anything the reader can see on a chart
          without doing the algebra first.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          <strong style={{ color: 'var(--text-primary)' }}>Reading.</strong>{' '}
          ψ_t is the single most important number for an equity index. A
          strongly negative ψ_t means the left side of the smile is much
          steeper than the right, which prices in leverage: on a large
          down move, volatility spikes. SPX nearly always shows
          ψ_t in [−1.5, −0.3] depending on tenor.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          p_t &gt; c_t is the usual SPX regime. The put wing is fatter
          than the call wing, which is the tail-risk premium showing up
          in the quoting convention. Picking a strategy that sells the
          put wing to buy the call wing relies on this asymmetry being
          overpriced on average; reading it straight off p_t / c_t makes
          the positioning easy to track.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          ṽ_t is the floor. On deep-in-the-money or deep-out-of-the-money
          strikes, implied vol cannot go below this level under the fit.
          When ṽ_t jumps across a session (for example: a CPI print
          compresses the ATM level but not the wings), the fit is saying
          the market is not pricing calmer tails, only a calmer center.
        </p>
        <p style={{ margin: 0 }}>
          The JW fit produces the same Durrleman g(k) as raw and
          natural. The no-arbitrage conditions translate cleanly into
          JW through the density constraints in Gatheral and Jacquier
          2014, and there is a set of explicit admissibility inequalities
          on (v_t, ψ_t, p_t, c_t, ṽ_t) that the same no-arb tests
          enforce without needing to round-trip through raw form. The
          site keeps raw as the storage format and JW as the display
          format.
        </p>
      </div>
    </div>
  );
}
