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
  PLOTLY_HEATMAP_COLORSCALE,
  PLOTLY_COLORBAR,
} from '../../src/lib/plotlyTheme';
import {
  buildSurface,
  computeDupire,
  coverageStats,
  Y_HALF_WIDTH,
} from '../dupire';

// ---------------------------------------------------------------------------
// Slot A — Dupire Surface Extraction.
//
// The canonical view of the lab: σ_LV(y, T) rendered as a 2D heatmap on
// log-moneyness y = ln(K/F) against tenor T in years. All downstream
// slots (B pricing, C viewer, D forward smile) consume exactly this
// surface from local/dupire.js, so the heatmap here is ground truth for
// the rest of the lab.
//
// Three diagnostics layered on top:
//   1. Coverage %: fraction of grid cells where the extraction succeeded.
//      When coverage drops below ~85% the surface has localized arbitrage
//      (usually a butterfly flag in the deepest wings at the shortest
//      tenor) and downstream MC pricers will rely on the σ² floor in
//      bilinearSigma over those cells.
//   2. Per-flag counts: how many cells hit each of {ok, calendar-arb,
//      butterfly-arb, variance-clip, w-nonpos, no-surface}. Calendar-arb
//      cells specifically signal that two adjacent SVI fits produced
//      decreasing total variance somewhere in y, which downstream slots
//      treat as an implicit advisory to skip or smooth the affected
//      (T_i, T_{i+1}) strip.
//   3. Short put skew: σ_LV at the left wing (y = −Y_HALF_WIDTH) minus
//      σ_LV ATM at the shortest tenor. The single number that explains
//      most of the crash-risk-premium component of short-dated SPX
//      option prices when decomposed into a deterministic diffusion
//      coefficient.
// ---------------------------------------------------------------------------

function formatPct(v, d = 1) {
  if (v == null || !Number.isFinite(v)) return '—';
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

export default function SlotA() {
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

  const surface = useMemo(() => buildSurface(sviArray), [sviArray]);
  const dupire = useMemo(() => (surface ? computeDupire(surface) : null), [surface]);
  const coverage = useMemo(() => coverageStats(dupire), [dupire]);

  const summaryStats = useMemo(() => {
    if (!dupire) return null;
    const all = [];
    for (let i = 0; i < dupire.sigma.length; i++) {
      for (let j = 0; j < dupire.sigma[i].length; j++) {
        const v = dupire.sigma[i][j];
        if (v != null) all.push(v);
      }
    }
    if (all.length === 0) return null;
    all.sort((a, b) => a - b);
    const p50 = all[Math.floor(all.length / 2)];
    const p10 = all[Math.floor(all.length * 0.1)];
    const p90 = all[Math.floor(all.length * 0.9)];
    const jAtm = Math.floor(dupire.Ys.length / 2);
    const iShort = 0;
    const iLong = dupire.sigma.length - 1;
    const atmShort = dupire.sigma[iShort][jAtm];
    const atmLong = dupire.sigma[iLong][jAtm];
    const leftWing = dupire.sigma[iShort][0];
    const shortPutSkew =
      leftWing != null && atmShort != null ? leftWing - atmShort : null;
    return { p10, p50, p90, atmShort, atmLong, shortPutSkew };
  }, [dupire]);

  useEffect(() => {
    if (!Plotly || !chartRef.current || !dupire) return;

    const z = dupire.sigma.map((row) =>
      row.map((v) => (v != null ? v * 100 : null))
    );

    const traces = [
      {
        type: 'heatmap',
        x: dupire.Ys,
        y: dupire.Ts,
        z,
        colorscale: PLOTLY_HEATMAP_COLORSCALE,
        showscale: true,
        colorbar: {
          ...PLOTLY_COLORBAR,
          title: { text: 'σ_LV (%)', font: PLOTLY_FONTS.axisTitle, side: 'right' },
          ticksuffix: '%',
        },
        hovertemplate:
          'log-moneyness %{x:.3f}<br>T %{y:.3f}y<br>σ_LV %{z:.2f}%<extra></extra>',
        zsmooth: 'best',
      },
    ];

    const layout = plotly2DChartLayout({
      title: {
        ...plotlyTitle('Dupire Local Volatility Surface · SPX'),
        y: 0.97,
        yref: 'container',
        yanchor: 'top',
      },
      margin: mobile ? { t: 50, r: 20, b: 85, l: 65 } : { t: 70, r: 30, b: 95, l: 80 },
      xaxis: plotlyAxis('log-moneyness  y = ln(K/F)', {
        range: [-Y_HALF_WIDTH, Y_HALF_WIDTH],
        autorange: false,
        tickformat: '.2f',
      }),
      yaxis: plotlyAxis('Tenor T (years)', {
        type: 'log',
        autorange: true,
      }),
      hovermode: 'closest',
    });

    Plotly.react(chartRef.current, traces, layout, {
      responsive: true,
      displayModeBar: false,
    });
  }, [Plotly, dupire, mobile]);

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
  if (!surface) {
    return (
      <div className="lab-placeholder">
        <div className="lab-placeholder-title">Not enough SVI fits</div>
        <div className="lab-placeholder-hint">
          The Dupire surface requires at least three well-fit SVI slices in
          the current snapshot. Check back after the next ingest cycle.
        </div>
      </div>
    );
  }

  return (
    <div className="card" style={{ padding: '1.25rem 1.25rem 1rem' }}>
      <div
        style={{
          fontFamily: 'Courier New, monospace',
          fontSize: '0.7rem',
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--text-secondary)',
          marginBottom: '0.85rem',
        }}
      >
        model · dupire local vol · (y, T) heatmap with arbitrage flags
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
          label="slices used"
          value={surface.length.toString()}
          sub={`T ∈ [${surface[0].T.toFixed(2)}, ${surface[surface.length - 1].T.toFixed(2)}]y`}
        />
        <StatCell
          label="coverage"
          value={coverage ? formatPct(coverage.coverage, 1) : '—'}
          sub={coverage ? `${coverage.counts.ok}/${coverage.total} cells ok` : '—'}
          accent={
            coverage && coverage.coverage >= 0.9
              ? PLOTLY_COLORS.positive
              : coverage && coverage.coverage >= 0.75
              ? PLOTLY_COLORS.highlight
              : PLOTLY_COLORS.secondary
          }
        />
        <StatCell
          label="σ_LV median"
          value={summaryStats ? formatPct(summaryStats.p50, 1) : '—'}
          sub={summaryStats ? `[p10 ${formatPct(summaryStats.p10, 1)}, p90 ${formatPct(summaryStats.p90, 1)}]` : '—'}
          accent={PLOTLY_COLORS.highlight}
        />
        <StatCell
          label="ATM short T"
          value={summaryStats ? formatPct(summaryStats.atmShort, 1) : '—'}
          sub="σ_LV(y=0, T_short)"
          accent={PLOTLY_COLORS.primary}
        />
        <StatCell
          label="ATM long T"
          value={summaryStats ? formatPct(summaryStats.atmLong, 1) : '—'}
          sub="σ_LV(y=0, T_long)"
          accent={PLOTLY_COLORS.primary}
        />
        <StatCell
          label="short put skew"
          value={summaryStats ? formatPct(summaryStats.shortPutSkew, 1) : '—'}
          sub="σ_LV(wing) − σ_LV(ATM)"
          accent={
            summaryStats && summaryStats.shortPutSkew > 0.1
              ? PLOTLY_COLORS.secondary
              : undefined
          }
        />
      </div>

      <div ref={chartRef} style={{ width: '100%', height: mobile ? 420 : 520 }} />

      {coverage && coverage.coverage < 1 && (
        <div
          style={{
            marginTop: '0.75rem',
            fontSize: '0.82rem',
            color: 'var(--text-secondary)',
            fontFamily: 'Courier New, monospace',
            letterSpacing: '0.04em',
          }}
        >
          <span style={{ color: 'var(--text-primary)' }}>arb flags:</span>{' '}
          {coverage.counts['calendar-arb'] > 0 && (
            <span style={{ color: PLOTLY_COLORS.secondary, marginRight: '0.9rem' }}>
              calendar {coverage.counts['calendar-arb']}
            </span>
          )}
          {coverage.counts['butterfly-arb'] > 0 && (
            <span style={{ color: PLOTLY_COLORS.highlight, marginRight: '0.9rem' }}>
              butterfly {coverage.counts['butterfly-arb']}
            </span>
          )}
          {coverage.counts.clipped > 0 && (
            <span style={{ color: PLOTLY_COLORS.axisText, marginRight: '0.9rem' }}>
              clipped {coverage.counts.clipped}
            </span>
          )}
          {coverage.counts['w-nonpos'] > 0 && (
            <span style={{ color: PLOTLY_COLORS.axisText, marginRight: '0.9rem' }}>
              w≤0 {coverage.counts['w-nonpos']}
            </span>
          )}
        </div>
      )}

      <div
        style={{
          marginTop: '0.8rem',
          fontSize: '0.9rem',
          color: 'var(--text-secondary)',
          lineHeight: 1.65,
        }}
      >
        <p style={{ margin: '0 0 0.75rem 0' }}>
          The{' '}
          <strong style={{ color: PLOTLY_COLORS.primary }}>Dupire local volatility</strong>{' '}
          function σ_LV(K, T) is the unique deterministic diffusion
          coefficient that, given today&apos;s arbitrage-free implied-vol
          surface as input, reproduces every European option price on that
          surface exactly. Extracted here in (y, T) coordinates with y =
          ln(K/F) from the SVI fits at every expiration in the current
          snapshot — y-derivatives of total variance w = σ²T in analytic
          closed form from the SVI parameters, T-derivative by finite
          difference across adjacent slices, Gatheral 2006 eq. 1.10 in
          the denominator. Cells where the denominator went negative
          (butterfly arbitrage), where ∂w/∂T went negative (calendar
          arbitrage), or where σ² fell below 1e-5 (numerical clip) are
          rendered as gaps in the heatmap; the coverage stat above
          reports what fraction of the (y, T) grid produced a valid
          extraction.
        </p>
        <strong style={{ color: 'var(--text-primary)' }}>Reading.</strong>{' '}
        Short T at deep-OTM put strikes (upper-left corner at negative y)
        is where σ_LV is hottest — short-dated crash-risk premium looks,
        in deterministic-diffusion terms, like a local vol of
        {summaryStats && summaryStats.shortPutSkew != null
          ? ` ${(100 * (summaryStats.atmShort + summaryStats.shortPutSkew)).toFixed(0)}%+`
          : ' several ×ATM'}{' '}
        at the wing vs the 15-20% ATM scale at the same tenor. Read
        vertically at a fixed y the chart is the T-structure of the
        local-vol smile at that moneyness; read horizontally at a fixed
        T it is the local-vol smile at that tenor. The surface becomes
        flatter and tighter as T grows — less information per cell, but
        also less numerical strain on the 1/T factor in the Dupire
        numerator. The T &lt; 7d strip is clipped off the chart because
        that factor amplifies SVI-mark noise into the extraction faster
        than the signal can survive.
      </div>
    </div>
  );
}
