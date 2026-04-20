import { useEffect, useMemo, useRef, useState } from 'react';
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
import {
  buildSurface,
  computeDupire,
  bilinearSigma,
  sviW,
  bracketIndex,
  impliedVol,
  mulberry32,
  gaussian,
} from '../dupire';

// ---------------------------------------------------------------------------
// Slot D — Forward Smile Pathology.
//
// The classical problem with pure local vol. Dupire's formula picks the
// σ_LV(K, T) that reproduces today's European option prices exactly,
// which makes the model internally consistent at t = 0 — but it says
// nothing about what the smile will look like on a future date. Under
// pure local vol, the "forward smile at T* for maturity τ" — the
// implied vol smile of options priced on a future day T* conditioned on
// a future spot level — progressively flattens as T* grows. This is
// the Gyöngy-projection artifact: σ_LV(S, t) is deterministic in (S, t)
// so once the spot gets to any particular level, the local dynamics
// out of that level are locked in; the smile that emerges from the
// continuation of those dynamics is a function of the aggregate path
// structure, which washes out toward a flat conditional smile. The
// observed market forward smile is sticky and does NOT flatten out —
// it reshapes roughly as spot moves, preserving most of today's skew
// at spot-proportional strikes.
//
// This slot makes the flattening visible:
//   1. MC many paths from today under the Dupire SDE to t = T*.
//   2. Keep only paths whose S_{T*} landed within a band around spot
//      — this simulates "the same moneyness reference" the market
//      would use to quote a forward smile today.
//   3. Continue those paths τ more years.
//   4. Price and invert a strike strip on [spot·e^-0.10, spot·e^0.10].
//   5. Overlay against today's τ-maturity smile σ(y, τ) from SVI.
//
// The gap between the two is the local-vol pathology. Local-stochastic
// vol (LSV) with a leverage function L(S, t)² = σ²_LV / E[v_t|S_t=S]
// and a Heston-style v_t cures this by letting the stochastic factor
// carry the conditional-smile structure while L(S, t) preserves the
// t = 0 pricing fit.
// ---------------------------------------------------------------------------

const STRIKE_LOG_MONEYNESS = [-0.10, -0.075, -0.05, -0.025, 0, 0.025, 0.05, 0.075, 0.10];
const N_PATHS = 4000;                       // antithetic-paired → 8000 effective
const STEPS_PER_YEAR = 252;
const TAU_YEARS = 60 / 365;                 // 60-day maturity for the forward smile
const BAND_LOG_WIDTH = 0.015;               // ±1.5% conditioning band on S_{T*}

function marketIv(surface, y, T) {
  const { i, j, wt } = bracketIndex(surface, T);
  const wA = sviW(surface[i].params, y);
  const wB = sviW(surface[j].params, y);
  const w = (1 - wt) * wA + wt * wB;
  if (w <= 0 || T <= 0) return null;
  return Math.sqrt(w / T);
}

function simulateForwardSmile({ grid, spot, Tstar, tau, seed }) {
  const dt = 1 / STEPS_PER_YEAR;
  const nSteps1 = Math.max(4, Math.round(Tstar / dt));
  const nSteps2 = Math.max(4, Math.round(tau / dt));
  const dt1 = Tstar / nSteps1;
  const dt2 = tau / nSteps2;
  const sqrtDt1 = Math.sqrt(dt1);
  const sqrtDt2 = Math.sqrt(dt2);
  const logSpot = Math.log(spot);
  const rng = mulberry32(seed);

  const strikes = STRIKE_LOG_MONEYNESS.map((yk) => spot * Math.exp(yk));
  const payoffs = new Array(strikes.length).fill(0);
  let kept = 0;
  let totalAttempts = 0;

  for (let p = 0; p < N_PATHS; p++) {
    // Generate antithetic pair of paths to T*.
    let s1 = logSpot;
    let s2 = logSpot;
    for (let step = 1; step <= nSteps1; step++) {
      const tNow = step * dt1;
      const y1 = s1 - logSpot;
      const y2 = s2 - logSpot;
      const sig1 = bilinearSigma(grid, y1, tNow);
      const sig2 = bilinearSigma(grid, y2, tNow);
      const z = gaussian(rng);
      s1 += -0.5 * sig1 * sig1 * dt1 + sig1 * sqrtDt1 * z;
      s2 += -0.5 * sig2 * sig2 * dt1 + sig2 * sqrtDt1 * (-z);
    }
    totalAttempts += 2;

    // Check the band on each path, continue those that qualify.
    const survivors = [];
    if (Math.abs(s1 - logSpot) <= BAND_LOG_WIDTH) survivors.push(s1);
    if (Math.abs(s2 - logSpot) <= BAND_LOG_WIDTH) survivors.push(s2);
    for (const startLogS of survivors) {
      let s = startLogS;
      for (let step = 1; step <= nSteps2; step++) {
        const tNow = Tstar + step * dt2;
        const y = s - logSpot;
        const sig = bilinearSigma(grid, y, tNow);
        const z = gaussian(rng);
        s += -0.5 * sig * sig * dt2 + sig * sqrtDt2 * z;
      }
      const ST = Math.exp(s);
      for (let ik = 0; ik < strikes.length; ik++) {
        payoffs[ik] += Math.max(ST - strikes[ik], 0);
      }
      kept += 1;
    }
  }

  if (kept === 0) return null;
  const prices = payoffs.map((sum) => sum / kept);
  return { prices, strikes, kept, totalAttempts, nSteps1, nSteps2 };
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
  // T* slider — user chooses how far into the future we condition. Short
  // T* keeps the forward smile close to today's τ-smile; long T* is
  // where the pathological flattening becomes unmistakable. Default at
  // 45 days so the effect is visible out-of-the-box.
  const [tStarDays, setTStarDays] = useState(45);
  const [seed, setSeed] = useState(0xBADF00D);
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
  const grid = useMemo(() => (surface ? computeDupire(surface) : null), [surface]);
  const spot = data?.spotPrice ?? null;

  const Tstar = tStarDays / 365;

  const result = useMemo(() => {
    if (!grid || !spot) return null;
    // Guard against T* + τ running past the end of the surface — if so,
    // we clip by not simulating at all and surfacing the reason.
    const tMax = surface[surface.length - 1].T;
    if (Tstar + TAU_YEARS > tMax) return { error: 'T* + τ exceeds surface horizon' };
    return simulateForwardSmile({ grid, spot, Tstar, tau: TAU_YEARS, seed });
  }, [grid, spot, surface, Tstar, seed]);

  const comparison = useMemo(() => {
    if (!result || result.error || !surface || !spot) return null;
    const ivFwd = result.prices.map((price, ik) => {
      const K = result.strikes[ik];
      return impliedVol(price, spot, K, TAU_YEARS);
    });
    const ivTodayTau = STRIKE_LOG_MONEYNESS.map((y) => marketIv(surface, y, TAU_YEARS));

    // Skew proxies: (σ(−0.05) − σ(+0.05)) — a standard symmetric-wing
    // measure. Larger positive value = steeper put-skew.
    const idxLeft = STRIKE_LOG_MONEYNESS.indexOf(-0.05);
    const idxRight = STRIKE_LOG_MONEYNESS.indexOf(0.05);
    const idxAtm = STRIKE_LOG_MONEYNESS.indexOf(0);
    const skewToday =
      ivTodayTau[idxLeft] != null && ivTodayTau[idxRight] != null
        ? ivTodayTau[idxLeft] - ivTodayTau[idxRight]
        : null;
    const skewFwd =
      ivFwd[idxLeft] != null && ivFwd[idxRight] != null
        ? ivFwd[idxLeft] - ivFwd[idxRight]
        : null;
    const atmFwd = ivFwd[idxAtm];
    const atmToday = ivTodayTau[idxAtm];

    return { ivFwd, ivTodayTau, skewToday, skewFwd, atmToday, atmFwd };
  }, [result, surface, spot]);

  useEffect(() => {
    if (!Plotly || !chartRef.current || !comparison) return;
    const traces = [
      {
        x: STRIKE_LOG_MONEYNESS,
        y: comparison.ivTodayTau.map((v) => (v != null ? v * 100 : null)),
        mode: 'lines+markers',
        name: `today · τ = ${Math.round(TAU_YEARS * 365)}d smile`,
        line: { color: PLOTLY_COLORS.titleText, width: 2 },
        marker: { color: PLOTLY_COLORS.titleText, size: mobile ? 6 : 8 },
        hovertemplate: 'today τ-smile<br>y %{x:.3f}<br>σ %{y:.2f}%<extra></extra>',
      },
      {
        x: STRIKE_LOG_MONEYNESS,
        y: comparison.ivFwd.map((v) => (v != null ? v * 100 : null)),
        mode: 'lines+markers',
        name: `LV forward · T* = ${tStarDays}d, τ = ${Math.round(TAU_YEARS * 365)}d`,
        line: { color: PLOTLY_COLORS.secondary, width: 2, dash: 'dash' },
        marker: {
          color: PLOTLY_COLORS.secondary,
          size: mobile ? 7 : 9,
          symbol: 'circle-open',
          line: { color: PLOTLY_COLORS.secondary, width: 2 },
        },
        hovertemplate: 'LV forward smile<br>y %{x:.3f}<br>σ %{y:.2f}%<extra></extra>',
      },
    ];
    const layout = plotly2DChartLayout({
      title: {
        ...plotlyTitle("Today's τ-Smile vs Pure Local-Vol Forward Smile"),
        y: 0.97,
        yref: 'container',
        yanchor: 'top',
      },
      margin: mobile ? { t: 50, r: 30, b: 100, l: 70 } : { t: 70, r: 40, b: 110, l: 85 },
      xaxis: plotlyAxis('log-moneyness  y = ln(K/S)', {
        tickformat: '.2f',
      }),
      yaxis: plotlyAxis('implied vol  σ (%)', {
        ticksuffix: '%',
      }),
      showlegend: true,
      legend: {
        orientation: 'h',
        y: -0.25,
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
  }, [Plotly, comparison, tStarDays, mobile]);

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
          The forward-smile sampler needs at least three well-fit SVI slices
          in the current snapshot.
        </div>
      </div>
    );
  }
  if (result?.error) {
    return (
      <div className="lab-placeholder">
        <div className="lab-placeholder-title">Surface horizon too short</div>
        <div className="lab-placeholder-hint">
          T* + τ = {Math.round((Tstar + TAU_YEARS) * 365)}d exceeds the
          longest available SVI slice at{' '}
          {Math.round(surface[surface.length - 1].T * 365)}d. Choose a shorter T*.
        </div>
      </div>
    );
  }

  const keepFrac =
    result && result.totalAttempts > 0
      ? result.kept / result.totalAttempts
      : null;
  const skewRatio =
    comparison && comparison.skewToday != null && comparison.skewFwd != null && comparison.skewToday !== 0
      ? comparison.skewFwd / comparison.skewToday
      : null;

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
        model · dupire local vol · forward-smile flattening diagnostic
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
          label="today skew (τ)"
          value={
            comparison?.skewToday != null
              ? `${(comparison.skewToday * 100).toFixed(2)}%`
              : '—'
          }
          sub="σ(−5%) − σ(+5%)"
          accent={PLOTLY_COLORS.titleText}
        />
        <StatCell
          label="LV fwd skew (τ)"
          value={
            comparison?.skewFwd != null
              ? `${(comparison.skewFwd * 100).toFixed(2)}%`
              : '—'
          }
          sub={`T* = ${tStarDays}d`}
          accent={PLOTLY_COLORS.secondary}
        />
        <StatCell
          label="skew ratio"
          value={skewRatio != null ? skewRatio.toFixed(2) : '—'}
          sub="fwd / today"
          accent={
            skewRatio != null && skewRatio < 0.75 ? PLOTLY_COLORS.secondary : undefined
          }
        />
        <StatCell
          label="conditioning band"
          value={`±${(BAND_LOG_WIDTH * 100).toFixed(1)}%`}
          sub={
            keepFrac != null
              ? `${(keepFrac * 100).toFixed(1)}% of paths kept`
              : '—'
          }
        />
        <StatCell
          label="ATM fwd / today"
          value={
            comparison?.atmFwd != null && comparison?.atmToday != null
              ? `${((comparison.atmFwd / comparison.atmToday) * 100).toFixed(0)}%`
              : '—'
          }
          sub="σ_ATM ratio"
        />
      </div>

      <div ref={chartRef} style={{ width: '100%', height: mobile ? 420 : 500 }} />

      <div
        style={{
          marginTop: '0.8rem',
          display: 'grid',
          gridTemplateColumns: mobile ? '1fr' : '1fr auto',
          gap: '1rem',
          alignItems: 'end',
        }}
      >
        <div>
          <label
            style={{
              fontSize: '0.72rem',
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
              color: 'var(--text-secondary)',
              marginBottom: '0.35rem',
              display: 'block',
            }}
          >
            T* ={' '}
            <span style={{ color: PLOTLY_COLORS.secondary, fontSize: '0.95rem' }}>
              {tStarDays}d ({(Tstar).toFixed(3)}y)
            </span>
          </label>
          <input
            type="range"
            min={7}
            max={120}
            step={1}
            value={tStarDays}
            onChange={(e) => setTStarDays(parseInt(e.target.value, 10))}
            style={{
              width: '100%',
              accentColor: PLOTLY_COLORS.secondary,
            }}
          />
        </div>
        <button
          type="button"
          onClick={() => setSeed((s) => (s * 1103515245 + 12345) | 0)}
          style={{
            padding: '0.45rem 1rem',
            fontFamily: 'Courier New, monospace',
            fontSize: '0.78rem',
            background: 'transparent',
            color: PLOTLY_COLORS.primary,
            border: `1px solid ${PLOTLY_COLORS.primary}`,
            borderRadius: 3,
            cursor: 'pointer',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            whiteSpace: 'nowrap',
          }}
        >
          Reshuffle seed
        </button>
      </div>

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
          <strong style={{ color: PLOTLY_COLORS.titleText }}>white line</strong>{' '}
          is today&apos;s implied-vol smile at τ = {Math.round(TAU_YEARS * 365)} days,
          read directly from the SVI fit. The{' '}
          <strong style={{ color: PLOTLY_COLORS.secondary }}>coral dashed line</strong>{' '}
          is the Monte-Carlo{' '}
          <em>forward smile</em> at T* = {tStarDays} days: paths are
          simulated under the Dupire SDE to T*, only those whose S_T*
          lands within ±{(BAND_LOG_WIDTH * 100).toFixed(1)}% of spot are
          kept, and the surviving paths are continued τ more days so the
          emerging conditional smile at maturity T* + τ can be inverted
          from MC call prices. Pure local vol systematically flattens
          the forward smile as T* grows — this is the textbook Gyöngy-
          projection artifact that makes pure LV unsuitable for
          forward-starting products, cliquets, and VIX-derivatives, and
          the direct motivation for augmenting LV with a stochastic
          factor (LSV).
        </p>
        <strong style={{ color: 'var(--text-primary)' }}>Reading.</strong>{' '}
        At T* ≈ 7 days the two smiles should nearly coincide (the MC is
        essentially evaluating today&apos;s smile, up to MC noise). Drag
        T* to the right and watch the coral line flatten — the skew
        ratio stat is the numerical measure of the flattening, values
        much below 1.0 are the pathology. Caveats: this measures only
        one slice of the forward smile (fixed τ, conditioned on the
        spot-band), and MC variance on the conditioning step with a
        tight band and finite paths is material — the reshuffle seed
        button is the cheapest way to gauge whether a 0.05 skew-ratio
        move as T* changes is signal or MC noise. For deep T* moves
        the conditioning band drops a larger fraction of paths, so the
        "% of paths kept" stat shrinks and MC uncertainty grows in
        tandem. If the kept fraction falls below ~5% the forward smile
        should be treated as directional indicator only, not a
        quantitative price.
      </div>
    </div>
  );
}
