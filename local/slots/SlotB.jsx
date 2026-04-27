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
// Slot B — Local Vol Pricing.
//
// Dupire's local vol is constructed so that the one-dimensional SDE
//
//     dS = (r − q)·S dt + σ_LV(S, t)·S dW
//
// reproduces every European option price on today's smile exactly.
// That means if we price a call by Monte-Carlo simulation of this SDE
// and invert the payoff to Black-Scholes implied vol, we should recover
// the same σ(K, T) that went into building σ_LV in the first place.
// Any residual is Monte-Carlo noise plus Euler-Maruyama discretization
// error, both of which shrink with more paths / finer time steps.
//
// The slot is therefore a self-check on the Dupire extraction: by
// pricing a strike grid at four expirations under the local-vol SDE and
// overlaying the MC-implied vol against the SVI-implied vol on the
// same axes, the reader should see two curves that sit on top of each
// other per expiration. The numeric RMSE across all (K, T) points is
// the single summary of how close the local-vol inversion came.
//
// Implementation:
//   - Fine-grained time grid: dt ≈ 1 trading day (1/252 year).
//   - Antithetic sampling on the standard normal draws. With N_PATHS
//     nominal paths and antithetics, the effective sample size is
//     2·N_PATHS; pricing standard errors drop as 1/√(2·N_PATHS).
//   - σ_LV looked up bilinearly from the (y, T) grid produced by
//     local/dupire.js.
//   - r = q = 0 matches the convention in src/lib/svi.js (the backend
//     fitter also prices its own Breeden-Litzenberger calls at r = q
//     = 0). The shape of the comparison is not sensitive to a 2-3%
//     rate shift; the shape of σ_LV is.
//   - Paths are shared across expirations by checkpointing at each
//     target T, so one MC run produces the whole (K, T) price matrix
//     for the comparison.
// ---------------------------------------------------------------------------

const N_PATHS = 2000;                       // doubled via antithetic → 4000 effective
const STEPS_PER_YEAR = 252;
const MIN_STEPS = 32;
const STRIKE_LOG_MONEYNESS = [-0.10, -0.075, -0.05, -0.025, 0, 0.025, 0.05, 0.075, 0.10];

function pickTargetExpirations(surface, n = 4) {
  // Choose n expirations from the surface logarithmically spaced on T
  // so the sample spans the curve rather than clustering on either
  // end. If there are fewer than n available, just use them all.
  if (surface.length <= n) return surface.map((s, idx) => ({ idx, T: s.T }));
  const Tmin = surface[0].T;
  const Tmax = surface[surface.length - 1].T;
  const logTmin = Math.log(Tmin);
  const logTmax = Math.log(Tmax);
  const picks = [];
  const usedIdx = new Set();
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const targetT = Math.exp(logTmin + t * (logTmax - logTmin));
    // Nearest available slice by log distance
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let j = 0; j < surface.length; j++) {
      if (usedIdx.has(j)) continue;
      const d = Math.abs(Math.log(surface[j].T) - Math.log(targetT));
      if (d < bestDist) { bestDist = d; bestIdx = j; }
    }
    usedIdx.add(bestIdx);
    picks.push({ idx: bestIdx, T: surface[bestIdx].T });
  }
  picks.sort((a, b) => a.T - b.T);
  return picks;
}

function marketIv(surface, y, T) {
  // Linear-in-total-variance interpolation between bracketing SVI slices,
  // then σ = √(w / T). Consistent with what Dupire extraction assumes
  // when it uses finite differences on the same interpolation.
  const { i, j, wt } = bracketIndex(surface, T);
  const wA = sviW(surface[i].params, y);
  const wB = sviW(surface[j].params, y);
  const w = (1 - wt) * wA + wt * wB;
  if (w <= 0 || T <= 0) return null;
  return Math.sqrt(w / T);
}

function simulateLV({ grid, spot, targetT, nPaths, seed }) {
  // One fine time grid covering [0, T_max], with checkpoints at each
  // target expiration. Log-price Euler-Maruyama on the Dupire SDE at
  // r = q = 0:
  //   d(ln S) = −½σ_LV(S, t)² dt + σ_LV(S, t) dW
  // The antithetic path uses the same σ_LV sequence but draws with
  // the sign of z flipped; since σ_LV is spot-dependent, the two
  // paths diverge after one step, which reduces the correlation the
  // antithetic trick produces but still cuts variance materially on
  // European payoffs.
  const Tmax = targetT[targetT.length - 1].T;
  const nSteps = Math.max(MIN_STEPS, Math.ceil(Tmax * STEPS_PER_YEAR));
  const dt = Tmax / nSteps;
  const sqrtDt = Math.sqrt(dt);
  const stepAtT = targetT.map((t) => Math.max(1, Math.round(t.T / dt)));
  const rng = mulberry32(seed);

  const nT = targetT.length;
  const nK = STRIKE_LOG_MONEYNESS.length;
  const payoffs = new Array(nT);
  for (let i = 0; i < nT; i++) payoffs[i] = new Array(nK).fill(0);

  const logSpot = Math.log(spot);
  const strikes = STRIKE_LOG_MONEYNESS.map((yk) => spot * Math.exp(yk));

  for (let p = 0; p < nPaths; p++) {
    let s1 = logSpot;
    let s2 = logSpot;
    let nextCheckpoint = 0;
    for (let step = 1; step <= nSteps; step++) {
      const tNow = step * dt;
      const y1 = s1 - logSpot;
      const y2 = s2 - logSpot;
      const sig1 = bilinearSigma(grid, y1, tNow);
      const sig2 = bilinearSigma(grid, y2, tNow);
      const z = gaussian(rng);
      s1 += -0.5 * sig1 * sig1 * dt + sig1 * sqrtDt * z;
      s2 += -0.5 * sig2 * sig2 * dt + sig2 * sqrtDt * (-z);
      if (nextCheckpoint < nT && step === stepAtT[nextCheckpoint]) {
        const S1 = Math.exp(s1);
        const S2 = Math.exp(s2);
        for (let ik = 0; ik < nK; ik++) {
          const K = strikes[ik];
          payoffs[nextCheckpoint][ik] += Math.max(S1 - K, 0) + Math.max(S2 - K, 0);
        }
        nextCheckpoint++;
      }
    }
  }

  // Call prices: average over 2·nPaths (antithetic pairs).
  const prices = payoffs.map((row) => row.map((v) => v / (2 * nPaths)));
  return { prices, strikes, nPaths, nSteps, dt };
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

export default function SlotB() {
  const chartRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();
  const mobile = useIsMobile();
  const { data, loading, error } = useOptionsData({
    underlying: 'SPX',
    snapshotType: 'intraday',
  });
  const [seed, setSeed] = useState(0xD0CAFE);
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

  const targetT = useMemo(
    () => (surface && surface.length >= 2 ? pickTargetExpirations(surface, 4) : null),
    [surface]
  );

  const mc = useMemo(() => {
    if (!grid || !spot || !targetT) return null;
    return simulateLV({ grid, spot, targetT, nPaths: N_PATHS, seed });
  }, [grid, spot, targetT, seed]);

  const comparison = useMemo(() => {
    if (!mc || !surface || !targetT || !spot) return null;
    const rows = [];
    let sse = 0;
    let n = 0;
    let maxAbs = 0;
    for (let it = 0; it < targetT.length; it++) {
      const T = targetT[it].T;
      const expiration = surface[targetT[it].idx].expiration;
      const Ks = mc.strikes;
      const row = {
        T,
        expiration,
        y: STRIKE_LOG_MONEYNESS,
        ivMarket: [],
        ivMc: [],
        diff: [],
      };
      for (let ik = 0; ik < Ks.length; ik++) {
        const K = Ks[ik];
        const y = STRIKE_LOG_MONEYNESS[ik];
        const ivM = marketIv(surface, y, T);
        const ivMc = impliedVol(mc.prices[it][ik], spot, K, T);
        row.ivMarket.push(ivM);
        row.ivMc.push(ivMc);
        if (ivM != null && ivMc != null) {
          const d = ivMc - ivM;
          row.diff.push(d);
          sse += d * d;
          n += 1;
          if (Math.abs(d) > maxAbs) maxAbs = Math.abs(d);
        } else {
          row.diff.push(null);
        }
      }
      rows.push(row);
    }
    const rmse = n > 0 ? Math.sqrt(sse / n) : null;
    return { rows, rmse, maxAbs, n };
  }, [mc, surface, targetT, spot]);

  useEffect(() => {
    if (!Plotly || !chartRef.current || !comparison) return;
    const palette = [
      PLOTLY_COLORS.primary,
      PLOTLY_COLORS.highlight,
      PLOTLY_COLORS.positive,
      PLOTLY_COLORS.secondary,
    ];
    const traces = [];
    for (let it = 0; it < comparison.rows.length; it++) {
      const row = comparison.rows[it];
      const color = palette[it % palette.length];
      const Tlabel = row.T < 0.08 ? `${(row.T * 365).toFixed(0)}d` : `${row.T.toFixed(2)}y`;
      traces.push({
        x: row.y,
        y: row.ivMarket.map((v) => (v != null ? v * 100 : null)),
        mode: 'lines',
        name: `market · T=${Tlabel}`,
        line: { color, width: 2 },
        hovertemplate: 'market<br>y %{x:.3f}<br>σ %{y:.2f}%<extra></extra>',
      });
      traces.push({
        x: row.y,
        y: row.ivMc.map((v) => (v != null ? v * 100 : null)),
        mode: 'markers',
        name: `local vol MC · T=${Tlabel}`,
        marker: {
          color,
          size: mobile ? 7 : 9,
          symbol: 'circle-open',
          line: { color, width: 2 },
        },
        hovertemplate: 'local vol MC<br>y %{x:.3f}<br>σ %{y:.2f}%<extra></extra>',
      });
    }
    const layout = plotly2DChartLayout({
      title: {
        ...plotlyTitle('Market Smile vs Local Vol Monte Carlo · SPX'),
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
  }, [Plotly, comparison, mobile]);

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
          Local-vol pricing needs at least three well-fit SVI slices in the
          current snapshot.
        </div>
      </div>
    );
  }

  const rmseBps = comparison?.rmse != null ? (comparison.rmse * 10000).toFixed(0) : '—';
  const maxBps = comparison?.maxAbs != null ? (comparison.maxAbs * 10000).toFixed(0) : '—';

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
        model · dupire local vol · monte carlo pricing self-check
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
          label="IV RMSE"
          value={comparison ? `${rmseBps} bps` : '—'}
          sub={`across ${comparison?.n ?? 0} (K, T) points`}
          accent={
            comparison && comparison.rmse != null && comparison.rmse < 0.005
              ? PLOTLY_COLORS.positive
              : PLOTLY_COLORS.highlight
          }
        />
        <StatCell
          label="max |ΔIV|"
          value={comparison ? `${maxBps} bps` : '—'}
          sub="worst-case (K, T) cell"
          accent={
            comparison && comparison.maxAbs != null && comparison.maxAbs > 0.015
              ? PLOTLY_COLORS.secondary
              : undefined
          }
        />
        <StatCell
          label="paths"
          value={mc ? `${mc.nPaths.toLocaleString()}×2` : '—'}
          sub="antithetic sampling"
        />
        <StatCell
          label="steps"
          value={mc ? mc.nSteps.toLocaleString() : '—'}
          sub={mc ? `dt ≈ ${(mc.dt * 252).toFixed(2)}·trading days` : '—'}
        />
        <StatCell
          label="expirations"
          value={targetT ? targetT.length.toString() : '—'}
          sub={
            targetT
              ? `T ∈ [${targetT[0].T.toFixed(2)}, ${targetT[targetT.length - 1].T.toFixed(2)}]y`
              : '—'
          }
        />
      </div>

      <div ref={chartRef} style={{ width: '100%', height: mobile ? 420 : 500 }} />

      <div
        style={{
          marginTop: '0.8rem',
          display: 'flex',
          justifyContent: 'flex-end',
          gap: '0.5rem',
        }}
      >
        <button
          type="button"
          onClick={() => setSeed((s) => (s * 1103515245 + 12345) | 0)}
          style={{
            padding: '0.4rem 1rem',
            fontFamily: 'Courier New, monospace',
            fontSize: '0.78rem',
            background: 'transparent',
            color: PLOTLY_COLORS.primary,
            border: `1px solid ${PLOTLY_COLORS.primary}`,
            borderRadius: 3,
            cursor: 'pointer',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
          }}
        >
          Reshuffle seed
        </button>
      </div>

      <div
        style={{
          marginTop: '0.6rem',
          fontSize: '0.9rem',
          color: 'var(--text-secondary)',
          lineHeight: 1.65,
        }}
      >
        <p style={{ margin: '0 0 0.75rem 0' }}>
          Monte-Carlo pricing under the Dupire SDE dS = σ_LV(S, t)·S dW,
          with σ_LV looked up bilinearly from the same (y, T) grid the
          surface extraction renders. The{' '}
          <strong style={{ color: PLOTLY_COLORS.titleText }}>solid lines</strong>{' '}
          are the SVI market smile interpolated linear-in-total-variance
          between the two bracketing expirations; the{' '}
          <strong style={{ color: PLOTLY_COLORS.titleText }}>open markers</strong>{' '}
          are the MC-implied vol inverted from the Dupire-SDE call
          payoffs at the same (K, T) points. Because local vol is
          constructed to reproduce today&apos;s smile by design
          (Gyöngy&apos;s projection makes the relationship exact), the
          two should overlay each other up to MC noise and Euler-
          Maruyama discretization error. Any visible gap is a numerical
          signal, not a modeling one.
        </p>
        <strong style={{ color: 'var(--text-primary)' }}>Reading.</strong>{' '}
        A tight overlay across all four tenors confirms that the Dupire
        extraction is internally consistent. No information was
        lost between the SVI surface and the local-vol PDE / SDE
        representation. An IV RMSE in the single-digit bps range is what
        this should produce on a well-fit chain with {N_PATHS.toLocaleString()}{' '}
        antithetic-paired paths. Systematic deviations (MC vols sitting
        above or below market for a whole tenor) are the fingerprint of
        Euler-Maruyama bias on rough surfaces: local vols that jump
        sharply between cells let discrete-time paths accumulate variance
        the continuous process would smooth, which biases short-dated
        wings high. The reshuffle seed button resamples the antithetic
        pair sequence; moving the RMSE by more than a couple of bps with
        each click is a sign the path count is too low for the precision
        the reader is asking of it, not that the local vol itself is off.
      </div>
    </div>
  );
}
