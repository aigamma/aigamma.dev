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

// -----------------------------------------------------------------------------
// SABR (Hagan, Kumar, Lesniewski, Woodward 2002) — "Managing Smile Risk".
//
//   dF_t = α_t · F_t^β · dW₁
//   dα_t = ν · α_t · dW₂
//   d⟨W₁, W₂⟩ = ρ · dt
//
// Four parameters: α (initial vol), β (CEV elasticity, 0 ≤ β ≤ 1), ρ
// (correlation), and ν (vol-of-vol). For equity index options the
// convention is to pin β = 1 (lognormal backbone) because the underlying
// forward is already lognormal-like and the remaining three parameters
// are enough to fit the observed smile at a single maturity. Rates desks
// historically used β = 0.5 (CIR-like) and FX desks experimented with
// β = 0 (normal). Pinning β = 1 here makes the SABR fit directly
// comparable to Slot A's Heston and eliminates the classic SABR
// identifiability problem where β and ρ trade off each other on a
// single slice.
//
// Hagan's asymptotic expansion gives Black-implied vol in closed form.
// With β = 1 the formula reduces dramatically (the (FK)^((1-β)/2) factor
// collapses, and every (1-β)^k term vanishes):
//
//   y    = ln(F/K)
//   z    = (ν/α) · y                                    [dim-less]
//   x(z) = ln( (√(1 − 2ρz + z²) + z − ρ) / (1 − ρ) )
//   σ_B  = α · (z / x(z)) · { 1 + T·[ρ·α·ν/4 + (2 − 3ρ²)/24 · ν²] + O(T²) }
//
// At ATM (K = F), z = 0 and z/x(z) → 1, so σ_ATM = α · correction. The
// z/x(z) ratio carries the whole smile shape: ρ controls the skew
// (slope at ATM), ν controls the curvature (wings). That clean
// separation is why SABR became the practitioner's standard smile model
// even after more complete stochastic-vol models existed — the
// parameters map directly onto the two things a trader reads off a
// smile by eye.
//
// Calibration is a 3-parameter Nelder-Mead on IV-space residuals
// against the same slice Slot A uses, so the two fits are directly
// comparable. The two models converge on the same shape around ATM
// but tend to disagree in the wings, where Heston's full dynamic
// structure and SABR's closed-form expansion handle tail risk
// differently.
// -----------------------------------------------------------------------------

const RATE_R = 0.045;
const RATE_Q = 0.013;
const NM_MAX_ITERS = 220;

// ---- SABR implied vol at β = 1 ------------------------------------------

function sabrIvBetaOne(params, F, K, T) {
  const { alpha, rho, nu } = params;
  if (!(alpha > 0) || !(F > 0) || !(K > 0) || !(T > 0)) return null;

  const y = Math.log(F / K);
  // Near ATM, expand z/x(z) as a series to avoid 0/0 — more stable than the
  // closed form below when |y| < 1e-4
  if (Math.abs(y) < 1e-7) {
    return alpha * (1 + T * (rho * alpha * nu / 4 + (2 - 3 * rho * rho) * nu * nu / 24));
  }
  const z = (nu / alpha) * y;
  const disc = 1 - 2 * rho * z + z * z;
  if (!(disc > 0)) return null;
  const xz = Math.log((Math.sqrt(disc) + z - rho) / (1 - rho));
  if (!Number.isFinite(xz) || xz === 0) return null;
  const ratio = z / xz;

  const correction = 1 + T * (rho * alpha * nu / 4 + (2 - 3 * rho * rho) * nu * nu / 24);
  const iv = alpha * ratio * correction;
  return Number.isFinite(iv) && iv > 0 ? iv : null;
}

// ---- Parameter reparameterization ---------------------------------------

function unpack(theta) {
  return {
    alpha: Math.exp(theta[0]),
    rho: Math.tanh(theta[1]),
    nu: Math.exp(theta[2]),
  };
}
function pack(p) {
  return [
    Math.log(Math.max(p.alpha, 1e-5)),
    Math.atanh(Math.max(-0.999, Math.min(0.999, p.rho))),
    Math.log(Math.max(p.nu, 1e-5)),
  ];
}

// ---- Nelder-Mead (adaptive Gao-Han) -------------------------------------

function nelderMead(f, x0, { maxIters = 200, tol = 1e-8, step = 0.15 } = {}) {
  const n = x0.length;
  const alpha = 1;
  const beta = 1 + 2 / n;
  const gamma = 0.75 - 1 / (2 * n);
  const delta = 1 - 1 / n;

  const simplex = [x0.slice()];
  for (let i = 0; i < n; i++) {
    const x = x0.slice();
    x[i] += step * (Math.abs(x0[i]) > 0.5 ? x0[i] : 1);
    simplex.push(x);
  }
  let values = simplex.map(f);

  for (let iters = 0; iters < maxIters; iters++) {
    const idx = [...Array(n + 1).keys()].sort((a, b) => values[a] - values[b]);
    const ordered = idx.map((i) => simplex[i]);
    const valOrdered = idx.map((i) => values[i]);
    for (let i = 0; i <= n; i++) { simplex[i] = ordered[i]; values[i] = valOrdered[i]; }

    if (Math.abs(values[n] - values[0]) < tol) break;

    const centroid = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) centroid[j] += simplex[i][j];
    }
    for (let j = 0; j < n; j++) centroid[j] /= n;

    const xr = centroid.map((c, j) => c + alpha * (c - simplex[n][j]));
    const fr = f(xr);

    if (fr < values[0]) {
      const xe = centroid.map((c, j) => c + beta * (xr[j] - c));
      const fe = f(xe);
      if (fe < fr) { simplex[n] = xe; values[n] = fe; } else { simplex[n] = xr; values[n] = fr; }
    } else if (fr < values[n - 1]) {
      simplex[n] = xr; values[n] = fr;
    } else {
      const outside = fr < values[n];
      const xc = outside
        ? centroid.map((c, j) => c + gamma * (xr[j] - c))
        : centroid.map((c, j) => c + gamma * (simplex[n][j] - c));
      const fc = f(xc);
      if (fc < (outside ? fr : values[n])) {
        simplex[n] = xc; values[n] = fc;
      } else {
        for (let i = 1; i <= n; i++) {
          simplex[i] = simplex[0].map((x0j, j) => x0j + delta * (simplex[i][j] - x0j));
          values[i] = f(simplex[i]);
        }
      }
    }
  }

  const bestIdx = values.indexOf(Math.min(...values));
  return { x: simplex[bestIdx], value: values[bestIdx] };
}

// ---- Slice + calibration -----------------------------------------------

function sliceObservations(contracts, expiration, spotPrice) {
  if (!contracts || !expiration || !(spotPrice > 0)) return [];
  const byStrike = new Map();
  for (const c of contracts) {
    if (c.expiration_date !== expiration) continue;
    const k = c.strike_price;
    if (k == null) continue;
    const type = c.contract_type?.toLowerCase();
    if (type !== 'call' && type !== 'put') continue;
    if (!(c.close_price > 0)) continue;
    if (!(c.implied_volatility > 0)) continue;
    if (!byStrike.has(k)) byStrike.set(k, { call: null, put: null });
    byStrike.get(k)[type] = c;
  }
  const rows = [];
  for (const [strike, { call, put }] of byStrike) {
    const src = strike >= spotPrice ? call : put;
    if (!src) continue;
    rows.push({ strike, iv: src.implied_volatility, side: strike >= spotPrice ? 'call' : 'put' });
  }
  rows.sort((a, b) => a.strike - b.strike);
  return rows.filter((r) => Math.abs(Math.log(r.strike / spotPrice)) <= 0.2);
}

function forwardPrice(S, r, q, T) {
  return S * Math.exp((r - q) * T);
}

function calibrateSabr(slice, F, T, init) {
  const obj = (theta) => {
    const p = unpack(theta);
    if (p.alpha > 3 || p.nu > 8) return 1e6;
    let sse = 0;
    let n = 0;
    for (const { strike, iv } of slice) {
      const modelIv = sabrIvBetaOne(p, F, strike, T);
      if (modelIv == null || !Number.isFinite(modelIv)) return 1e6;
      const d = modelIv - iv;
      sse += d * d;
      n++;
    }
    return n > 0 ? sse / n : 1e6;
  };
  const x0 = pack(init);
  const res = nelderMead(obj, x0, { maxIters: NM_MAX_ITERS, tol: 1e-9, step: 0.2 });
  return { params: unpack(res.x), rmse: Math.sqrt(res.value) };
}

const INIT_SABR = { alpha: 0.18, rho: -0.55, nu: 1.2 };

// ---- UI ------------------------------------------------------------------

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

export default function SlotB() {
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

  const slice = useMemo(() => {
    if (!data || !activeExp) return [];
    return sliceObservations(data.contracts, activeExp, data.spotPrice);
  }, [data, activeExp]);

  const dte = useMemo(() => {
    if (!activeExp || !data?.capturedAt) return null;
    return daysToExpiration(activeExp, data.capturedAt);
  }, [activeExp, data]);
  const T = dte != null ? dte / 365 : null;
  const F = data && T ? forwardPrice(data.spotPrice, RATE_R, RATE_Q, T) : null;

  const calib = useMemo(() => {
    if (!slice.length || !F || !T || slice.length < 5) return null;
    return calibrateSabr(slice, F, T, INIT_SABR);
  }, [slice, F, T]);

  useEffect(() => {
    if (!Plotly || !chartRef.current || !calib || !F || !T || slice.length === 0) return;

    const strikes = slice.map((r) => r.strike);
    const ivs = slice.map((r) => r.iv * 100);
    const K_lo = Math.min(...strikes);
    const K_hi = Math.max(...strikes);
    const nGrid = 120;
    const gridK = new Array(nGrid);
    const gridIv = new Array(nGrid);
    for (let i = 0; i < nGrid; i++) {
      const K = K_lo + (i / (nGrid - 1)) * (K_hi - K_lo);
      gridK[i] = K;
      const iv = sabrIvBetaOne(calib.params, F, K, T);
      gridIv[i] = iv != null ? iv * 100 : null;
    }

    const allIv = [...ivs, ...gridIv.filter((v) => v != null)];
    const yMin = Math.min(...allIv);
    const yMax = Math.max(...allIv);
    const pad = (yMax - yMin) * 0.12 || 1;

    // Backbone reference: the path σ_ATM traces as F moves, under fixed
    // SABR parameters and β = 1 → constant (lognormal backbone is flat
    // in F). Included as a dotted reference line at σ_ATM so the reader
    // can eyeball deviations.
    const atmIv = sabrIvBetaOne(calib.params, F, F, T);

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
        x: gridK,
        y: gridIv,
        mode: 'lines',
        name: 'SABR fit · β = 1',
        line: { color: PLOTLY_COLORS.positive, width: 2 },
        hoverinfo: 'skip',
        connectgaps: false,
      },
      {
        x: [F, F],
        y: [yMin - pad, yMax + pad],
        mode: 'lines',
        name: 'forward F',
        line: { color: PLOTLY_COLORS.axisText, width: 1, dash: 'dot' },
        hoverinfo: 'skip',
        showlegend: false,
      },
      {
        x: [K_lo, K_hi],
        y: [atmIv * 100, atmIv * 100],
        mode: 'lines',
        name: 'σ_ATM backbone',
        line: { color: PLOTLY_COLORS.highlight, width: 1, dash: 'dash' },
        hoverinfo: 'skip',
        showlegend: false,
      },
    ];

    const layout = plotly2DChartLayout({
      title: {
        ...plotlyTitle('SABR Smile Fit · SPX'),
        y: 0.97,
        yref: 'container',
        yanchor: 'top',
      },
      margin: mobile ? { t: 50, r: 25, b: 85, l: 60 } : { t: 70, r: 35, b: 100, l: 75 },
      xaxis: plotlyAxis('Strike', {
        range: [K_lo - (K_hi - K_lo) * 0.02, K_hi + (K_hi - K_lo) * 0.02],
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

    Plotly.react(chartRef.current, traces, layout, {
      responsive: true,
      displayModeBar: false,
    });
  }, [Plotly, calib, slice, F, T, mobile]);

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
          fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
          fontSize: '0.7rem',
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--accent-amber)',
          marginBottom: '0.85rem',
        }}
      >
        sabr · hagan closed-form · β pinned to 1
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
          DTE {dte != null ? dte.toFixed(1) : '-'} · {slice.length} strikes · F ={' '}
          {F != null ? F.toFixed(2) : '-'}
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
          label="α · ATM vol"
          value={calib ? formatPct(calib.params.alpha, 2) : '-'}
          sub="lognormal α(F, β=1)"
          accent={PLOTLY_COLORS.primary}
        />
        <StatCell
          label="ρ · skew"
          value={calib ? formatFixed(calib.params.rho, 3) : '-'}
          sub="spot-vol correlation"
          accent={calib && calib.params.rho < -0.5 ? PLOTLY_COLORS.secondary : undefined}
        />
        <StatCell
          label="ν · curvature"
          value={calib ? formatFixed(calib.params.nu, 2) : '-'}
          sub="vol of vol"
        />
        <StatCell
          label="β · pinned"
          value="1.000"
          sub="lognormal backbone"
        />
        <StatCell
          label="Fit RMSE (IV)"
          value={calib ? formatPct(calib.rmse, 2) : '-'}
          sub={calib ? `n=${slice.length}` : '-'}
          accent={calib && calib.rmse < 0.01 ? PLOTLY_COLORS.positive : undefined}
        />
      </div>

      <div ref={chartRef} style={{ width: '100%', height: mobile ? 380 : 460 }} />

      <div
        style={{
          marginTop: '0.8rem',
          fontSize: '0.9rem',
          color: 'var(--text-secondary)',
          lineHeight: 1.65,
        }}
      >
        <p style={{ margin: '0 0 0.75rem' }}>
          SABR is the smile model that reads the way a trader eyeballs a
          smile. Three numbers with three clear jobs:{' '}
          <strong>α</strong> sets the level (where ATM sits),{' '}
          <strong>ρ</strong> sets the tilt (how asymmetric the skew is), and{' '}
          <strong>ν</strong> sets the curvature (how steep the wings turn
          up). When the Heston fit above wrestles with dynamics and
          stochastic structure, SABR just carves the visible curve and gives
          you numbers you can trade against directly.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          <strong style={{ color: 'var(--text-primary)' }}>Reading the chart.</strong>{' '}
          Blue dots are the same SPX observations the Heston card fits. The{' '}
          <strong style={{ color: PLOTLY_COLORS.positive }}>green curve</strong>{' '}
          is the SABR smile. SABR usually hugs the observed dots much more
          tightly than Heston at a single expiration because it is purpose-built
          for smile geometry, not underlying dynamics. If the green line tracks
          the dots cleanly while the Heston amber line above misses, that is
          a normal state of the world: SABR prices what the market is, Heston
          prices what a mean-reverting SV process would produce, and the
          difference is the premium the market is putting on structure Heston
          cannot capture.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          <strong style={{ color: 'var(--text-primary)' }}>Practical use.</strong>{' '}
          Treat SABR as the interpolator between the strikes that trade. Once
          it fits, you can price a strike that has no quote, mark a spread,
          or compute a delta at a strike the book does not cover, and the
          answer will be consistent with the observed smile. Watch{' '}
          <strong>ρ</strong> across the trading day: ρ drifting more negative
          means the market is paying up for downside relative to upside (put
          skew steepening) and is often the first signal that dealer gamma
          positioning has flipped or that hedging flows are one-sided. ρ
          drifting toward zero means the skew is flattening, which after a
          crash is a setup where short-dated puts have lost their crash
          premium and are cheaper relative to calls than usual.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          Read <strong>ν</strong> as a wing-richness gauge. A high ν produces
          steep wings, so deep out-of-the-money options (far puts and far
          calls) are priced with a lot of curvature. When ν is elevated
          relative to recent days the market is overpaying for tail optionality,
          which sets up wing-selling trades (iron condors, put-spread sales,
          call-spread overwrites). When ν is compressed the tails are cheap
          and long-wing structures (risk reversals, broken-wing flies, outright
          OTM puts for crash protection) are efficient.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          The{' '}
          <strong style={{ color: PLOTLY_COLORS.highlight }}>dashed backbone</strong>{' '}
          is ATM vol under the pinned β = 1 lognormal regime. It is flat by
          construction, so every bit of visible curvature on the green line
          is ρ and ν doing work, not the backbone moving. That clean
          separation is why SABR became the practitioner&apos;s standard
          smile model: if ρ or ν changes on the next refresh, you know
          which dimension of the smile actually moved.
        </p>
        <p style={{ margin: 0 }}>
          Caveat. SABR describes a smile, not a process. It tells you what
          the current expiration looks like and lets you interpolate within
          it, but it does not forecast how the smile will evolve as spot
          moves or time passes. For that you need the Heston, Dupire, or
          Rough Bergomi view on the same data. Use SABR to price what is,
          use the dynamic models to think about what is coming.
        </p>
      </div>
    </div>
  );
}
