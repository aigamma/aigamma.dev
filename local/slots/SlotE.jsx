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
  PLOTLY_HEATMAP_COLORSCALE,
  PLOTLY_COLORBAR,
} from '../../src/lib/plotlyTheme';

// -----------------------------------------------------------------------------
// Dupire Local Volatility Surface (whole-surface heatmap).
//
// The three slots above on this page each operate on the Dupire surface from
// a different angle: the pricing self-check (SlotB) confirms the SDE prices
// back the smile per Gyongy, the slice viewer (SlotC) walks 1D y- and T-
// slices through the (y, T) grid, and the forward-smile pathology (SlotD)
// shows where pure local vol breaks. This card displays the whole surface
// in one picture so the reader can see the (K, T) shape as a single object
// before reading the diagnostic and slice-by-slice surfaces above.
//
// Dupire (1994) showed that any arbitrage-free implied volatility surface
// Σ(K, T) uniquely determines a deterministic local volatility function
// σ_LV(K, T) such that the one-dimensional diffusion
//
//     dS_t = (r − q)·S_t·dt + σ_LV(S_t, t)·S_t·dW_t
//
// reproduces every European call price on that surface. In log-moneyness
// y = ln(K/F) and total variance w(y, T) = σ²(y, T)·T, the formula takes
// its most usable form (Gatheral 2006, eq. 1.10):
//
//     σ²_LV(y, T) = (∂w/∂T) / N(y, w)
//
//     N(y, w) = 1 − (y/w)·(∂w/∂y) + ¼·(−¼ − 1/w + y²/w²)·(∂w/∂y)²
//               + ½·(∂²w/∂y²)
//
// With SVI parameters fit at each expiration, every y-derivative of w is
// analytic (see src/lib/svi.js). The T-derivative is a finite difference
// across adjacent slices, which preserves the calendar-arbitrage-free
// property of the input surface so long as w is non-decreasing in T at
// every y, i.e. the "linear-in-total-variance" interpolation between
// slices (Gatheral & Jacquier 2014) has that property by construction.
//
// Pure local vol reproduces today's smile exactly by design. Where it
// fails is the forward smile, the smile implied by the model for a
// future date conditioned on a future spot, which flattens out as T
// increases. That is the deterministic-mapping artifact local stochastic
// vol exists to cure (Gyongy projection plus a leverage function on a
// stochastic factor). The forward-smile pathology surface above (SlotD)
// shows that flattening directly with Monte Carlo; this heatmap shows
// the input surface that those diagnostics consume.
// -----------------------------------------------------------------------------

const DUPIRE_MIN_VARIANCE = 1e-5;         // floor for σ²_LV to keep sqrt real
const TARGET_T_POINTS = 28;               // rows in the heatmap
const TARGET_Y_POINTS = 60;               // cols in the heatmap
const Y_HALF_WIDTH = 0.18;                // ±18% log-moneyness window
const MIN_T_YEARS = 7 / 365;              // floor to avoid 1/T blow-up near 0DTE
const MAX_RMSE = 0.012;                   // skip slices that didn't converge cleanly

// --------- SVI y-derivatives (analytic) -----------------------------------

function sviW(params, y) {
  const { a, b, rho, m, sigma } = params;
  const u = y - m;
  return a + b * (rho * u + Math.sqrt(u * u + sigma * sigma));
}
function sviDw(params, y) {
  const { b, rho, m, sigma } = params;
  const u = y - m;
  return b * (rho + u / Math.sqrt(u * u + sigma * sigma));
}
function sviD2w(params, y) {
  const { b, m, sigma } = params;
  const u = y - m;
  const denom = Math.pow(u * u + sigma * sigma, 1.5);
  return (b * sigma * sigma) / denom;
}

// --------- Surface object from backend sviFits ----------------------------

function buildSurface(sviFits) {
  if (!Array.isArray(sviFits) || sviFits.length === 0) return null;
  const clean = sviFits
    .filter((f) => f && f.params && f.t_years > 0 && Number.isFinite(f.rmse_iv))
    .filter((f) => f.rmse_iv <= MAX_RMSE)
    .map((f) => ({
      T: f.t_years,
      F: f.forward_price,
      params: f.params,
      rmse: f.rmse_iv,
    }))
    .sort((a, b) => a.T - b.T);
  if (clean.length < 3) return null;
  return clean;
}

// Locate two slices bracketing T among sorted surface; return (i, j, wt)
// such that T ≈ wt·slices[j].T + (1-wt)·slices[i].T.
function bracketIndex(surface, T) {
  const n = surface.length;
  if (T <= surface[0].T) return { i: 0, j: 1, wt: 0 };
  if (T >= surface[n - 1].T) return { i: n - 2, j: n - 1, wt: 1 };
  for (let k = 0; k < n - 1; k++) {
    if (T >= surface[k].T && T <= surface[k + 1].T) {
      const span = surface[k + 1].T - surface[k].T;
      const wt = span > 0 ? (T - surface[k].T) / span : 0;
      return { i: k, j: k + 1, wt };
    }
  }
  return { i: 0, j: 1, wt: 0 };
}

// Dupire local variance on the (y, T) grid. Returns σ_LV per unit time
// (annualized vol). y is log-moneyness against the forward at tenor T,
// where the forward is linearly interpolated between adjacent slices
// (a small approximation; the SPX forward grows almost linearly in T at
// (r − q) so the interpolation bias is ~second-order in T).
function computeDupire(surface) {
  const TYs = new Array(TARGET_T_POINTS);
  const Ys = new Array(TARGET_Y_POINTS);

  const Tmin = Math.max(surface[0].T, MIN_T_YEARS);
  const Tmax = surface[surface.length - 1].T;
  const logTmin = Math.log(Tmin);
  const logTmax = Math.log(Tmax);
  for (let i = 0; i < TARGET_T_POINTS; i++) {
    const t = i / (TARGET_T_POINTS - 1);
    TYs[i] = Math.exp(logTmin + t * (logTmax - logTmin));
  }
  for (let j = 0; j < TARGET_Y_POINTS; j++) {
    Ys[j] = -Y_HALF_WIDTH + (j / (TARGET_Y_POINTS - 1)) * (2 * Y_HALF_WIDTH);
  }

  const sigma = new Array(TARGET_T_POINTS);
  for (let i = 0; i < TARGET_T_POINTS; i++) {
    sigma[i] = new Array(TARGET_Y_POINTS);
  }

  for (let i = 0; i < TARGET_T_POINTS; i++) {
    const T = TYs[i];
    const { i: iA, j: iB, wt } = bracketIndex(surface, T);
    const A = surface[iA];
    const B = surface[iB];
    const dT = B.T - A.T;

    for (let j = 0; j < TARGET_Y_POINTS; j++) {
      const y = Ys[j];
      const wA = sviW(A.params, y);
      const wB = sviW(B.params, y);
      const dwA = sviDw(A.params, y);
      const dwB = sviDw(B.params, y);
      const d2wA = sviD2w(A.params, y);
      const d2wB = sviD2w(B.params, y);

      // Interpolate w and its y-derivatives linearly in T
      const w = (1 - wt) * wA + wt * wB;
      const dw_dy = (1 - wt) * dwA + wt * dwB;
      const d2w_dy2 = (1 - wt) * d2wA + wt * d2wB;
      const dw_dT = dT > 0 ? (wB - wA) / dT : 0;

      // Dupire denominator in y, w form
      if (w <= 0 || !Number.isFinite(w)) {
        sigma[i][j] = null;
        continue;
      }
      const N = 1
        - (y / w) * dw_dy
        + 0.25 * (-0.25 - 1 / w + (y * y) / (w * w)) * dw_dy * dw_dy
        + 0.5 * d2w_dy2;

      const locVar = N > 0 ? dw_dT / N : null;
      if (locVar == null || !(locVar >= DUPIRE_MIN_VARIANCE)) {
        sigma[i][j] = null;
        continue;
      }
      sigma[i][j] = Math.sqrt(locVar);
    }
  }

  return { Ts: TYs, Ys, sigma };
}

// --------- UI -------------------------------------------------------------

function formatPct(v, d = 1) {
  if (v == null || !Number.isFinite(v)) return '-';
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

export default function SlotE() {
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

  // Building the SVI-implied total-variance surface and computing the
  // Dupire local-vol grid by finite differences in (k, T) is the heaviest
  // single computation on /local/. Defer both stages to requestIdleCallback
  // so the chart card paints its chrome and the upstream SVI worker
  // callback resolves before the surface math runs.
  const [surfaceState, setSurfaceState] = useState({ surface: null, dupire: null });
  useEffect(() => {
    if (!sviArray?.length) {
      setSurfaceState({ surface: null, dupire: null });
      return undefined;
    }
    const compute = () => {
      const surface = buildSurface(sviArray);
      const dupire = surface ? computeDupire(surface) : null;
      return { surface, dupire };
    };
    if (typeof window === 'undefined') {
      setSurfaceState(compute());
      return undefined;
    }
    let cancelled = false;
    const idle = window.requestIdleCallback
      ? (cb) => window.requestIdleCallback(cb, { timeout: 1500 })
      : (cb) => setTimeout(cb, 0);
    const cancel = window.cancelIdleCallback || clearTimeout;
    const handle = idle(() => {
      if (cancelled) return;
      const result = compute();
      if (cancelled) return;
      setSurfaceState(result);
    });
    return () => {
      cancelled = true;
      cancel(handle);
    };
  }, [sviArray]);
  const surface = surfaceState.surface;
  const dupire = surfaceState.dupire;

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

    // ATM slice (y ≈ 0) across T for the "term structure" read
    const jAtm = Math.floor(dupire.Ys.length / 2);
    const atmByT = dupire.sigma.map((row) => row[jAtm]);
    const atmShort = atmByT[Math.floor(atmByT.length * 0.15)];
    const atmLong = atmByT[atmByT.length - 1];

    // Left-wing (downside) at shortest available T, for the classic
    // steep short-dated put skew
    const iShort = 0;
    const jLeft = 0;
    const jAtm2 = jAtm;
    const sigmaShortATM = dupire.sigma[iShort][jAtm2];
    const sigmaShortPut = dupire.sigma[iShort][jLeft];
    const shortPutSkew = sigmaShortPut != null && sigmaShortATM != null
      ? (sigmaShortPut - sigmaShortATM)
      : null;

    return { p10, p50, p90, atmShort, atmLong, shortPutSkew };
  }, [dupire]);

  useEffect(() => {
    if (!Plotly || !chartRef.current || !dupire) return;

    // Convert σ to %, render as heatmap. x-axis is log-moneyness y,
    // y-axis is T in years (log scale reads more naturally for vol surfaces).
    const z = dupire.sigma.map((row) => row.map((v) => (v != null ? v * 100 : null)));

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
        ...plotlyTitle(
          mobile
            ? 'Dupire Local<br>Volatility Surface'
            : 'Dupire Local Volatility Surface'
        ),
        // Plotly 2.35.2 anchors a multi-line title's bottom near y when
        // yref='container' / yanchor='top'; on mobile (where the title wraps
        // to two lines) y=0.97 puts the first line ~15-20px above the SVG
        // top and clips its top half. Drop y on mobile so two lines clear.
        y: mobile ? 0.92 : 0.97,
        yref: 'container',
        yanchor: 'top',
      },
      margin: mobile ? { t: 75, r: 20, b: 85, l: 65 } : { t: 70, r: 30, b: 95, l: 80 },
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
      <div className="page-placeholder">
        <div className="page-placeholder-title">Loading chain…</div>
        <div className="page-placeholder-hint">
          Loading the live SPX snapshot.
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="page-placeholder" style={{ borderColor: 'var(--accent-coral)' }}>
        <div className="page-placeholder-title" style={{ color: 'var(--accent-coral)' }}>
          Chain fetch failed
        </div>
        <div className="page-placeholder-hint">{error}</div>
      </div>
    );
  }
  if (plotlyError) {
    return (
      <div className="page-placeholder" style={{ borderColor: 'var(--accent-coral)' }}>
        <div className="page-placeholder-title" style={{ color: 'var(--accent-coral)' }}>
          Plotly unavailable
        </div>
        <div className="page-placeholder-hint">{plotlyError}</div>
      </div>
    );
  }
  if (!surface) {
    return (
      <div className="page-placeholder">
        <div className="page-placeholder-title">Not enough SVI fits</div>
        <div className="page-placeholder-hint">
          The Dupire surface requires at least three well-fit SVI slices in the
          current snapshot. Check back after the next ingest cycle.
        </div>
      </div>
    );
  }

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
        dupire local vol · surface from SVI slice set
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
          label="slices used"
          value={surface.length.toString()}
          sub={`T ∈ [${surface[0].T.toFixed(2)}, ${surface[surface.length - 1].T.toFixed(2)}]y`}
        />
        <StatCell
          label="σ_LV median"
          value={summaryStats ? formatPct(summaryStats.p50, 1) : '-'}
          sub={summaryStats ? `[p10 ${formatPct(summaryStats.p10, 1)}, p90 ${formatPct(summaryStats.p90, 1)}]` : '-'}
          accent={PLOTLY_COLORS.highlight}
        />
        <StatCell
          label="ATM short T"
          value={summaryStats ? formatPct(summaryStats.atmShort, 1) : '-'}
          sub="σ_LV(y=0, T short)"
          accent={PLOTLY_COLORS.primary}
        />
        <StatCell
          label="ATM long T"
          value={summaryStats ? formatPct(summaryStats.atmLong, 1) : '-'}
          sub="σ_LV(y=0, T long)"
          accent={PLOTLY_COLORS.primary}
        />
        <StatCell
          label="short put skew"
          value={summaryStats ? formatPct(summaryStats.shortPutSkew, 1) : '-'}
          sub="σ_LV(−18%) − σ_LV(0)"
          accent={
            summaryStats && summaryStats.shortPutSkew > 0.1 ? PLOTLY_COLORS.secondary : undefined
          }
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
          This heatmap is the {' '}
          <strong style={{ color: PLOTLY_COLORS.primary }}>Dupire local
          volatility surface</strong>, a decoded version of the entire SPX
          smile laid out in one picture. Every point on the map is the
          vol-per-unit-time that the options market is pricing for a specific
          strike at a specific future date, after you strip out the averaging
          that implied vol quietly does. Where the amber on the chart gets
          hot, the market is pricing genuine spot-and-time-specific risk. Where
          it stays cool, there is no extra premium being charged for that
          region.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          <strong style={{ color: 'var(--text-primary)' }}>Reading the chart.</strong>{' '}
          Horizontal axis is how far out-of-the-money a strike is (negative
          numbers are downside puts, positive numbers are upside calls).
          Vertical axis is how far out in time (log scale, so a day reads as
          far from a week as a week does from a month). The hottest band sits
          in the upper-left corner: short-dated downside strikes. That is
          where the crash premium lives. Read straight up a column and you see
          term structure for one strike; read across a row and you see the
          local-vol smile at one tenor.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          <strong style={{ color: 'var(--text-primary)' }}>Practical use.</strong>{' '}
          This surface is the cleanest available read on{' '}
          <em>where in strike-and-time space the market is charging the most
          premium</em>. Compare the short T row to the long T row: if the
          ratio of short-dated put vol to long-dated put vol is unusually
          high (more than 2 to 3x), short-dated crash protection is expensive
          in absolute terms and will bleed hard if nothing happens,
          which favors selling calendar puts (sell short-dated, buy
          longer-dated at the same strike) to collect that decay. When the
          surface is relatively flat across T on the downside, the crash term
          structure has compressed and long-dated puts are offering crash
          protection at near-parity with short-dated ones, which is the
          setup for buying longer-dated tails.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          Within a single tenor row, the slope from ATM to the deep downside
          is the local skew. When that slope is unusually steep (the row
          colors warm fast as you move left of zero), put overwriters and put
          spread sellers are being paid above the long-run average for the
          same risk. Stat-row numbers above give the quick version: the{' '}
          <strong>short put skew</strong> stat is σ_LV at the deep downside
          minus σ_LV at ATM on the shortest tenor, so values above about 0.10
          are in the historically steep range and point to a crowded
          protection bid.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          <strong>How this card relates to the three above.</strong> The
          pricing self-check (top of the page) confirms that simulating the
          Dupire SDE under this surface prices the smile back within MC and
          discretization error (Gyongy). The slice viewer (middle) cuts the same surface into 1D
          y-slices and T-slices so the reader can isolate one row or one
          column and read the local-vol smile or term structure point by
          point. The forward-smile pathology (just above this card) takes the
          same surface, simulates paths to a future date, and shows how the
          conditional smile flattens out, which is the artifact local
          stochastic vol exists to fix. This heatmap is the input every one
          of those diagnostics consumes, displayed as a single object so the
          (K, T) shape is legible at a glance before the slice-by-slice
          readings above narrow it down.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          <strong>Caveat on the forward smile.</strong> A pure local-vol model
          reproduces today&apos;s prices exactly but gives a forward smile
          that flattens with time, which the real market does not do. The
          forward-smile pathology surface above (SlotD) demonstrates that
          flattening directly with Monte Carlo. If you are pricing a
          forward-starting structure (cliquets, forward variance swaps,
          barrier options whose value depends on how the smile will look next
          month), this surface alone will underprice wing risk. Local
          stochastic vol (LSV) is the model that uses this surface as its
          input and then adds a stochastic factor on top to produce realistic
          forward dynamics; the surface here is the first half of that
          calibration.
        </p>
        <p style={{ margin: 0 }}>
          Noise note. The very top of the chart (tenors shorter than about a
          week) is clipped because the 1/T factor in the Dupire formula
          amplifies any noise in the underlying SVI fits to the point where
          the read is mostly numerical artifact. Treat anything inside a week
          as directional only.
        </p>
      </div>
    </div>
  );
}
