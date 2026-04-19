import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import usePlotly from '../../src/hooks/usePlotly';
import useIsMobile from '../../src/hooks/useIsMobile';
import useOptionsData from '../../src/hooks/useOptionsData';
import RangeBrush from '../../src/components/RangeBrush';
import ResetButton from '../../src/components/ResetButton';
import {
  PLOTLY_COLORS,
  PLOTLY_FONTS,
  plotly2DChartLayout,
  plotlyAxis,
  plotlyTitle,
} from '../../src/lib/plotlyTheme';
import { daysToExpiration, pickDefaultExpiration, filterPickerExpirations } from '../../src/lib/dates';

// -----------------------------------------------------------------------------
// Binomial Tree (Cox, Ross, Rubinstein 1979).
//
// The simplest and most durable discrete pricing engine ever written. On a
// recombining N-step lattice the underlying takes an up-move u or a down-move
// d at each node, with risk-neutral probability p. CRR picks
//
//     u = exp(sigma * sqrt(dt))
//     d = 1 / u
//     p = (exp((r - q) * dt) - d) / (u - d)
//
// so that the mean and variance of one step match a geometric Brownian motion
// in the limit dt -> 0. Pricing walks backward through the lattice:
//
//     V_node = exp(-r * dt) * (p * V_up + (1 - p) * V_down)
//
// with terminal payoff V_leaf = max(S_leaf - K, 0) for a call. For American
// exercise the backward step becomes
//
//     V_node = max(intrinsic(S_node), exp(-r * dt) * (p * V_up + (1 - p) * V_down))
//
// and the difference between the two recursions is the early-exercise
// premium. For SPX (index, cash-settled, no discrete dividends) the premium
// is essentially zero for calls and very small for puts. The tree still
// runs, which makes it a clean stress test: if the Am and Eu prices
// disagree on an SPX contract by more than numerical noise, something is
// wrong with the calibration, not with the market.
//
// Convergence behavior is a fixture of the numerical finance literature.
// The lattice oscillates around the Black-Scholes price with a period of 2
// in N (odd vs even splits the terminal node set across/around the strike
// differently), decaying as O(1/N). The first ~30 steps swing wildly; by
// N ~ 200 the amplitude is below a penny for a typical SPX ATM option.
// Plotting price(N) against the BSM horizontal makes all of this visible at
// a glance and gives the reader a direct feel for how many steps a
// production pricer actually needs.
//
// The slot pulls a specific ATM contract out of the live chain and runs the
// tree on its (S, K, T) triple. The market IV for that contract is fed into
// the tree as the volatility input, and the tree's tree-price-per-N curve is
// compared to the BSM price at that same IV. This is the right comparison:
// we are asking "does the discretization engine reproduce the Black-Scholes
// continuous-limit price," not "does the tree produce the right IV," which
// is a separate and harder question that SVI answers in Slots C-F.
// -----------------------------------------------------------------------------

const RATE_R = 0.045;  // SOFR-ish
const RATE_Q = 0.013;  // SPX trailing dividend yield

const N_MIN = 5;
const N_MAX = 400;
const N_STEP = 5;   // coarser early-N steps keep the tiny oscillation visible

// Default brush window covers the left third of the N domain, where the
// odd/even oscillation is dramatic. The user can drag either handle out to
// see the quiet tail, and the ResetButton restores this window.
const DEFAULT_N_RANGE = [N_MIN, Math.round(N_MIN + (N_MAX - N_MIN) / 3)];

// Build the list of N values. Dense near the origin so the oscillation is
// resolved, spaced further apart toward N_MAX where the curve has already
// settled.
const N_GRID = (() => {
  const vals = [];
  for (let n = N_MIN; n <= 40; n += 1) vals.push(n);
  for (let n = 45; n <= 120; n += 5) vals.push(n);
  for (let n = 140; n <= N_MAX; n += 20) vals.push(n);
  return vals;
})();

// --------- CRR binomial pricer -------------------------------------------

function binomialPrice({ S, K, T, r, q, sigma, N, optionType, exercise }) {
  if (!(N >= 1) || !(T > 0) || !(sigma > 0) || !(S > 0) || !(K > 0)) return null;
  const dt = T / N;
  const u = Math.exp(sigma * Math.sqrt(dt));
  const d = 1 / u;
  const disc = Math.exp(-r * dt);
  const p = (Math.exp((r - q) * dt) - d) / (u - d);
  if (!(p > 0) || !(p < 1)) return null;

  // Terminal layer.
  const V = new Float64Array(N + 1);
  for (let j = 0; j <= N; j++) {
    const ST = S * Math.pow(u, j) * Math.pow(d, N - j);
    V[j] = optionType === 'call' ? Math.max(ST - K, 0) : Math.max(K - ST, 0);
  }

  // Backward induction.
  for (let n = N - 1; n >= 0; n--) {
    for (let j = 0; j <= n; j++) {
      const contin = disc * (p * V[j + 1] + (1 - p) * V[j]);
      if (exercise === 'american') {
        const S_node = S * Math.pow(u, j) * Math.pow(d, n - j);
        const intrinsic = optionType === 'call'
          ? Math.max(S_node - K, 0)
          : Math.max(K - S_node, 0);
        V[j] = Math.max(intrinsic, contin);
      } else {
        V[j] = contin;
      }
    }
  }
  return V[0];
}

// --------- Black-Scholes reference ---------------------------------------

function phi(x) { return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI); }
function Phi(x) {
  const a1 = 0.31938153, a2 = -0.356563782, a3 = 1.781477937;
  const a4 = -1.821255978, a5 = 1.330274429;
  const k = 1 / (1 + 0.2316419 * Math.abs(x));
  const w = 1 - phi(x) * (a1 * k + a2 * k * k + a3 * k * k * k + a4 * k * k * k * k + a5 * k * k * k * k * k);
  return x >= 0 ? w : 1 - w;
}
function bsm({ S, K, T, r, q, sigma, optionType }) {
  if (!(sigma > 0) || !(T > 0)) {
    return optionType === 'call'
      ? Math.max(S * Math.exp(-q * T) - K * Math.exp(-r * T), 0)
      : Math.max(K * Math.exp(-r * T) - S * Math.exp(-q * T), 0);
  }
  const vsT = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / vsT;
  const d2 = d1 - vsT;
  if (optionType === 'call') {
    return S * Math.exp(-q * T) * Phi(d1) - K * Math.exp(-r * T) * Phi(d2);
  }
  return K * Math.exp(-r * T) * Phi(-d2) - S * Math.exp(-q * T) * Phi(-d1);
}

// --------- Slice helpers --------------------------------------------------

function pickAtmContract(contracts, expiration, spotPrice, optionType) {
  if (!contracts || !expiration || !(spotPrice > 0)) return null;
  let best = null;
  let bestDist = Infinity;
  for (const c of contracts) {
    if (c.expiration_date !== expiration) continue;
    if (c.contract_type?.toLowerCase() !== optionType) continue;
    if (!(c.implied_volatility > 0)) continue;
    if (!(c.close_price > 0)) continue;
    const dist = Math.abs(c.strike_price - spotPrice);
    if (dist < bestDist) {
      bestDist = dist;
      best = c;
    }
  }
  return best;
}

// --------- UI -------------------------------------------------------------

function formatPct(v, d = 2) {
  if (v == null || !Number.isFinite(v)) return '-';
  return `${(v * 100).toFixed(d)}%`;
}
function formatUsd(v, d = 2) {
  if (v == null || !Number.isFinite(v)) return '-';
  return `$${v.toFixed(d)}`;
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

  const defaultExpiration = useMemo(() => {
    if (!data?.expirations) return null;
    const eligible = filterPickerExpirations(data.expirations, data.capturedAt);
    return pickDefaultExpiration(eligible, data.capturedAt);
  }, [data]);

  const [expiration, setExpiration] = useState(null);
  const [optionType, setOptionType] = useState('call');
  const [nRange, setNRange] = useState(null);
  const activeExp = expiration || defaultExpiration;
  const activeNRange = nRange || DEFAULT_N_RANGE;

  const handleBrushChange = useCallback((minN, maxN) => {
    setNRange([minN, maxN]);
  }, []);

  const dte = useMemo(() => {
    if (!activeExp || !data?.capturedAt) return null;
    return daysToExpiration(activeExp, data.capturedAt);
  }, [activeExp, data]);
  const T = dte != null ? dte / 365 : null;

  const contract = useMemo(() => {
    if (!data || !activeExp || !(data.spotPrice > 0)) return null;
    return pickAtmContract(data.contracts, activeExp, data.spotPrice, optionType);
  }, [data, activeExp, optionType]);

  const curve = useMemo(() => {
    if (!contract || !T || T <= 0 || !(data?.spotPrice > 0)) return null;
    const cfg = {
      S: data.spotPrice,
      K: contract.strike_price,
      T,
      r: RATE_R,
      q: RATE_Q,
      sigma: contract.implied_volatility,
    };
    const bsmCall = bsm({ ...cfg, optionType });
    const euro = N_GRID.map((N) => binomialPrice({ ...cfg, N, optionType, exercise: 'european' }));
    const amer = N_GRID.map((N) => binomialPrice({ ...cfg, N, optionType, exercise: 'american' }));
    return { Ns: N_GRID, bsm: bsmCall, euro, amer, cfg };
  }, [contract, T, data, optionType]);

  useEffect(() => {
    if (!Plotly || !chartRef.current || !curve) return;

    const { Ns, bsm: bsmPrice, euro, amer, cfg } = curve;
    // Fit the y-axis to whatever is inside the current brush window so the
    // visible oscillation is not squashed by the quiet tail toward large N.
    // Mirrors computeYRange in DealerGammaRegime.jsx.
    const [xStart, xEnd] = activeNRange;
    let yMin = Infinity;
    let yMax = -Infinity;
    for (let i = 0; i < Ns.length; i++) {
      if (Ns[i] < xStart || Ns[i] > xEnd) continue;
      for (const y of [euro[i], amer[i]]) {
        if (y == null || !Number.isFinite(y)) continue;
        if (y < yMin) yMin = y;
        if (y > yMax) yMax = y;
      }
    }
    if (Number.isFinite(bsmPrice)) {
      if (bsmPrice < yMin) yMin = bsmPrice;
      if (bsmPrice > yMax) yMax = bsmPrice;
    }
    if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) {
      yMin = bsmPrice - 1;
      yMax = bsmPrice + 1;
    }
    const pad = (yMax - yMin) * 0.18 || 0.5;

    const traces = [
      {
        x: Ns,
        y: euro,
        mode: 'lines+markers',
        name: 'Binomial · European',
        line: { color: PLOTLY_COLORS.primary, width: 1.5 },
        marker: { color: PLOTLY_COLORS.primary, size: mobile ? 4 : 5 },
        hovertemplate: 'N %{x}<br>$%{y:.3f}<extra>European</extra>',
      },
      {
        x: Ns,
        y: amer,
        mode: 'lines+markers',
        name: 'Binomial · American',
        line: { color: PLOTLY_COLORS.secondary, width: 1.5, dash: 'dot' },
        marker: { color: PLOTLY_COLORS.secondary, size: mobile ? 4 : 5 },
        hovertemplate: 'N %{x}<br>$%{y:.3f}<extra>American</extra>',
      },
      {
        x: [Ns[0], Ns[Ns.length - 1]],
        y: [bsmPrice, bsmPrice],
        mode: 'lines',
        name: 'BSM reference',
        line: { color: PLOTLY_COLORS.highlight, width: 2 },
        hovertemplate: '$%{y:.3f}<extra>BSM</extra>',
      },
    ];

    const layout = plotly2DChartLayout({
      title: {
        ...plotlyTitle(`Binomial Convergence · SPX ${optionType === 'call' ? 'Call' : 'Put'} · K = ${cfg.K}`),
        y: 0.97,
        yref: 'container',
        yanchor: 'top',
      },
      margin: mobile ? { t: 50, r: 25, b: 85, l: 60 } : { t: 70, r: 35, b: 100, l: 75 },
      xaxis: plotlyAxis('N · tree depth', {
        range: activeNRange,
        autorange: false,
      }),
      yaxis: plotlyAxis('Price (USD)', {
        range: [yMin - pad, yMax + pad],
        autorange: false,
        tickprefix: '$',
        tickformat: '.2f',
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

    Plotly.react(chartRef.current, traces, layout, {
      responsive: true,
      displayModeBar: false,
    });
  }, [Plotly, curve, mobile, optionType, activeNRange]);

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

  const N_REPORT = 200;
  const euroAtReport = curve ? curve.euro[N_GRID.indexOf(N_REPORT)] : null;
  const amerAtReport = curve ? curve.amer[N_GRID.indexOf(N_REPORT)] : null;
  const bsmPrice = curve ? curve.bsm : null;
  const residual = euroAtReport != null && bsmPrice != null ? euroAtReport - bsmPrice : null;
  const earlyExercisePremium = amerAtReport != null && euroAtReport != null
    ? amerAtReport - euroAtReport
    : null;

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
          model · cox ross rubinstein 1979 · two-branch recombining lattice
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
            The binomial tree is the oldest and most portable discrete pricer
            in finance. It builds an option price from the bottom up by
            walking a recombining lattice of up/down moves, then discounting
            each node backward through{' '}
            <code style={{ color: 'var(--text-primary)' }}>V = e^(-r·dt)·(p·V_up + (1-p)·V_down)</code>.
            CRR picks u, d, p so that the one-step mean and variance match a
            log-normal diffusion. As the step count N grows, the price
            converges to Black-Scholes.
          </p>
          <p style={{ margin: '0 0 0.75rem' }}>
            The chart below prices{' '}
            <strong style={{ color: 'var(--text-primary)' }}>one ATM SPX option</strong>{' '}
            from the live chain at tree depths from 5 to 400. The{' '}
            <strong style={{ color: PLOTLY_COLORS.primary }}>blue curve</strong>{' '}
            is the European tree price. The{' '}
            <strong style={{ color: PLOTLY_COLORS.secondary }}>coral curve</strong>{' '}
            is the same option priced under American early exercise. The{' '}
            <strong style={{ color: PLOTLY_COLORS.highlight }}>amber line</strong>{' '}
            is the Black-Scholes reference at the contract&apos;s quoted IV.
          </p>
          <p style={{ margin: 0 }}>
            Two things are visible. First, the famous odd/even oscillation:
            the tree alternates above and below BSM in a pattern that decays
            roughly as 1/N. Second, the American-European gap is the{' '}
            <strong style={{ color: PLOTLY_COLORS.secondary }}>early-exercise premium</strong>.
            For SPX it is near zero because the index is cash-settled and
            dividend flow is smooth, so there is no clean incentive to stop
            early. Feeding the same machinery a dividend-paying single
            name or a 30-year Treasury future produces a visibly non-zero
            gap.
          </p>
        </div>
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
        <label
          style={{
            fontSize: '0.72rem',
            color: 'var(--text-secondary)',
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
          }}
        >
          Side:
        </label>
        <select
          value={optionType}
          onChange={(e) => setOptionType(e.target.value)}
          style={{
            background: 'var(--bg-card)',
            color: 'var(--text-primary)',
            border: '1px solid var(--bg-card-border)',
            padding: '0.3rem 0.5rem',
            fontFamily: 'Courier New, monospace',
            fontSize: '0.85rem',
          }}
        >
          <option value="call">call</option>
          <option value="put">put</option>
        </select>
        <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
          DTE {dte != null ? dte.toFixed(1) : '-'} · K = {contract?.strike_price ?? '-'} ·
          IV = {contract ? formatPct(contract.implied_volatility, 2) : '-'}
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
          label="BSM price"
          value={formatUsd(bsmPrice)}
          sub="continuous limit"
          accent={PLOTLY_COLORS.highlight}
        />
        <StatCell
          label={`tree (EU) N=${N_REPORT}`}
          value={formatUsd(euroAtReport)}
          sub="European exercise"
          accent={PLOTLY_COLORS.primary}
        />
        <StatCell
          label={`tree (AM) N=${N_REPORT}`}
          value={formatUsd(amerAtReport)}
          sub="American exercise"
          accent={PLOTLY_COLORS.secondary}
        />
        <StatCell
          label="|tree − BSM|"
          value={residual != null ? `$${Math.abs(residual).toFixed(4)}` : '-'}
          sub={`residual at N = ${N_REPORT}`}
          accent={residual != null && Math.abs(residual) < 0.01 ? PLOTLY_COLORS.positive : undefined}
        />
        <StatCell
          label="Am − Eu premium"
          value={earlyExercisePremium != null ? `$${earlyExercisePremium.toFixed(4)}` : '-'}
          sub="early exercise value"
          accent={earlyExercisePremium != null && earlyExercisePremium > 0.005 ? PLOTLY_COLORS.secondary : undefined}
        />
        <StatCell
          label="market mid"
          value={contract ? formatUsd(contract.close_price, 2) : '-'}
          sub="chain close/mid"
        />
      </div>

      <div style={{ position: 'relative' }}>
        <ResetButton visible={nRange != null} onClick={() => setNRange(null)} />
        <div ref={chartRef} style={{ width: '100%', height: mobile ? 380 : 460 }} />
        <RangeBrush
          min={N_MIN}
          max={N_MAX}
          activeMin={activeNRange[0]}
          activeMax={activeNRange[1]}
          onChange={handleBrushChange}
          minWidth={10}
        />
      </div>

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
          At small N the{' '}
          <strong style={{ color: PLOTLY_COLORS.primary }}>blue tree</strong>{' '}
          is all over the place relative to the{' '}
          <strong style={{ color: PLOTLY_COLORS.highlight }}>amber BSM line</strong>.
          The odd/even oscillation is not a bug. It is how the terminal
          node set lands relative to the strike. Even N puts a node exactly
          at the forward; odd N straddles it. Each case carries a different
          second-order bias, and the two sequences cancel out in the limit.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          By N ≈ 200 the residual has settled to a few cents. That is the
          empirical answer to &quot;how many steps does a production tree
          need to match BSM&quot; for a liquid ATM SPX contract. Deep OTM
          strikes, high-vol regimes, and short tenors all push that number
          higher; a 0DTE ATM contract can need N ~ 1000 to get to penny
          accuracy.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          The{' '}
          <strong style={{ color: PLOTLY_COLORS.secondary }}>American curve</strong>{' '}
          on SPX sits on top of the European curve. That is the right
          answer. SPX has no discrete dividends, a smooth q accrual, and no
          rational reason to exercise an index option early. When this lab
          is later pointed at a symbol with chunky dividends, the coral
          curve will visibly detach upward on the put side before each
          ex-dividend date.
        </p>
        <p style={{ margin: 0 }}>
          Why this matters for the dashboard. Every BSM-based Greek and
          every IV number on the main site assumes the continuous-limit
          price. The tree result shows what the same option looks like
          under a non-BSM pricing convention, and confirms that for SPX
          the two agree to within pennies. That is the license for using
          Black-Scholes everywhere else.
        </p>
      </div>
    </div>
  );
}
