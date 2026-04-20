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
// Trinomial Tree (Boyle 1986, Kamrad-Ritchken 1991 stretched form).
//
// Where binomial picks two children per node, trinomial picks three: up, a
// no-move middle, and down. The extra "stay" branch is what makes the
// method converge faster at equal step count. In the Kamrad-Ritchken form
// with stretch parameter lambda >= 1:
//
//     u = exp(lambda * sigma * sqrt(dt))
//     m = 1
//     d = 1 / u
//     nu = r - q - sigma^2 / 2
//     p_u = 1 / (2 * lambda^2) + nu * sqrt(dt) / (2 * lambda * sigma)
//     p_m = 1 - 1 / lambda^2
//     p_d = 1 / (2 * lambda^2) - nu * sqrt(dt) / (2 * lambda * sigma)
//
// lambda = 1 collapses the middle probability to zero and recovers the
// binomial lattice as a special case. lambda = sqrt(3) is the classical
// choice because it maximizes the "spread" of the lattice and produces
// the fastest convergence on European prices, which is what this slot
// compares against binomial at matching N.
//
// Why trinomial helps. The odd/even oscillation in the binomial price
// comes from the terminal node set straddling vs centering on the strike.
// Trinomial always has a centered middle branch, so the node set aligns
// with the forward at every step and the systematic bias is absorbed
// into the middle probability. The residual decay is still O(1/N) in the
// worst case but the prefactor is smaller, and in practice the oscillation
// amplitude is visibly smaller.
//
// The chart compares a binomial and a trinomial European price on the
// same live-chain ATM SPX contract, both swept across the same N grid,
// both against the same BSM reference. The trinomial curve should hug
// the amber BSM line tighter than the blue binomial curve at every N,
// and by N ~ 50-80 the trinomial residual is usually already where the
// binomial residual lands at N ~ 200.
//
// Operationally this matters for anything that calls a pricer inside a
// hot loop: risk scenarios, Monte Carlo inner loops, American-style
// exotic calibration. Cutting N by 3-4x for the same accuracy is a real
// cost win that has nothing to do with IV modeling and everything to do
// with which lattice you picked.
// -----------------------------------------------------------------------------

const RATE_R = 0.045;
const RATE_Q = 0.013;

const N_MIN = 5;
const N_MAX = 400;
const LAMBDA = Math.sqrt(3);

// Default brush window covers the left third of the N domain. That is where
// the binomial oscillation is fat, the trinomial curve separates visibly
// from it, and the O(1/N) convergence is easiest to read.
const DEFAULT_N_RANGE = [N_MIN, Math.round(N_MIN + (N_MAX - N_MIN) / 3)];

const N_GRID = (() => {
  const vals = [];
  for (let n = N_MIN; n <= 40; n += 1) vals.push(n);
  for (let n = 45; n <= 120; n += 5) vals.push(n);
  for (let n = 140; n <= N_MAX; n += 20) vals.push(n);
  return vals;
})();

// --------- Trinomial pricer ----------------------------------------------

function trinomialPrice({ S, K, T, r, q, sigma, N, optionType, exercise, lambda = LAMBDA }) {
  if (!(N >= 1) || !(T > 0) || !(sigma > 0)) return null;
  const dt = T / N;
  const u = Math.exp(lambda * sigma * Math.sqrt(dt));
  const nu = r - q - 0.5 * sigma * sigma;
  const pu = 1 / (2 * lambda * lambda) + (nu * Math.sqrt(dt)) / (2 * lambda * sigma);
  const pm = 1 - 1 / (lambda * lambda);
  const pd = 1 / (2 * lambda * lambda) - (nu * Math.sqrt(dt)) / (2 * lambda * sigma);
  if (!(pu > 0) || !(pm > 0) || !(pd > 0)) return null;
  if (!(pu + pm + pd > 0.999) || !(pu + pm + pd < 1.001)) return null;
  const disc = Math.exp(-r * dt);

  // Indexing: node j at step n represents S * u^j, with j in [-n, n].
  // Store V as length (2N+1) array indexed 0..2N where index i = j + N.
  const size = 2 * N + 1;
  let V = new Float64Array(size);

  // Terminal payoff.
  for (let i = 0; i < size; i++) {
    const j = i - N;
    const ST = S * Math.pow(u, j);
    V[i] = optionType === 'call' ? Math.max(ST - K, 0) : Math.max(K - ST, 0);
  }

  // Backward induction. At step n (before reduction) the live indices
  // span i = (N - n) .. (N + n). One backward sweep shrinks the span by
  // one index on each side. Write into a fresh buffer to avoid shadowing.
  let Vnext = new Float64Array(size);
  for (let n = N - 1; n >= 0; n--) {
    for (let i = N - n; i <= N + n; i++) {
      const contin = disc * (pu * V[i + 1] + pm * V[i] + pd * V[i - 1]);
      if (exercise === 'american') {
        const j = i - N;
        const S_node = S * Math.pow(u, j);
        const intrinsic = optionType === 'call'
          ? Math.max(S_node - K, 0)
          : Math.max(K - S_node, 0);
        Vnext[i] = Math.max(intrinsic, contin);
      } else {
        Vnext[i] = contin;
      }
    }
    const tmp = V;
    V = Vnext;
    Vnext = tmp;
  }
  return V[N];
}

// --------- Binomial pricer for side-by-side comparison -------------------

function binomialPrice({ S, K, T, r, q, sigma, N, optionType, exercise }) {
  if (!(N >= 1) || !(T > 0) || !(sigma > 0)) return null;
  const dt = T / N;
  const u = Math.exp(sigma * Math.sqrt(dt));
  const d = 1 / u;
  const disc = Math.exp(-r * dt);
  const p = (Math.exp((r - q) * dt) - d) / (u - d);
  if (!(p > 0) || !(p < 1)) return null;

  const V = new Float64Array(N + 1);
  for (let j = 0; j <= N; j++) {
    const ST = S * Math.pow(u, j) * Math.pow(d, N - j);
    V[j] = optionType === 'call' ? Math.max(ST - K, 0) : Math.max(K - ST, 0);
  }
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

// --------- BSM ----------------------------------------------------------

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

// --------- Slice helpers ------------------------------------------------

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

// --------- UI ------------------------------------------------------------

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
    const bsmPrice = bsm({ ...cfg, optionType });
    const bin = N_GRID.map((N) => binomialPrice({ ...cfg, N, optionType, exercise: 'european' }));
    const tri = N_GRID.map((N) => trinomialPrice({ ...cfg, N, optionType, exercise: 'european' }));
    return { Ns: N_GRID, bsm: bsmPrice, bin, tri, cfg };
  }, [contract, T, data, optionType]);

  useEffect(() => {
    if (!Plotly || !chartRef.current || !curve) return;

    const { Ns, bsm: bsmPrice, bin, tri, cfg } = curve;
    // Fit the y-axis to the brushed window so the binomial oscillation and
    // the trinomial curve both occupy the full vertical range of the visible
    // region. Without this the default left-third view would sit compressed
    // at the top of the card because the quiet tail toward N = 400 defines
    // the lower bound of the global min.
    const [xStart, xEnd] = activeNRange;
    let yMin = Infinity;
    let yMax = -Infinity;
    for (let i = 0; i < Ns.length; i++) {
      if (Ns[i] < xStart || Ns[i] > xEnd) continue;
      for (const y of [bin[i], tri[i]]) {
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
    const pad = (yMax - yMin) * 0.2 || 0.5;

    const traces = [
      {
        x: Ns,
        y: bin,
        mode: 'lines+markers',
        name: 'Binomial',
        line: { color: PLOTLY_COLORS.primary, width: 1.3 },
        marker: { color: PLOTLY_COLORS.primary, size: mobile ? 3 : 4 },
        opacity: 0.65,
        hovertemplate: 'N %{x}<br>$%{y:.3f}<extra>Binomial</extra>',
      },
      {
        x: Ns,
        y: tri,
        mode: 'lines+markers',
        name: 'Trinomial · λ = √3',
        line: { color: PLOTLY_COLORS.positive, width: 1.8 },
        marker: { color: PLOTLY_COLORS.positive, size: mobile ? 4 : 5 },
        hovertemplate: 'N %{x}<br>$%{y:.3f}<extra>Trinomial</extra>',
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
        ...plotlyTitle(`Binomial vs Trinomial · SPX ${optionType === 'call' ? 'Call' : 'Put'} · K = ${cfg.K}`),
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

  // Quantify the convergence gap at a few representative N values.
  const atN = (N) => {
    if (!curve) return { bin: null, tri: null };
    const idx = N_GRID.indexOf(N);
    if (idx < 0) return { bin: null, tri: null };
    return { bin: curve.bin[idx], tri: curve.tri[idx] };
  };
  const resid = (p, ref) => (p != null && ref != null ? Math.abs(p - ref) : null);
  const bsmPrice = curve?.bsm;
  const at40 = atN(40);
  const at200 = atN(200);
  const r40Bin = resid(at40.bin, bsmPrice);
  const r40Tri = resid(at40.tri, bsmPrice);
  const r200Bin = resid(at200.bin, bsmPrice);
  const r200Tri = resid(at200.tri, bsmPrice);
  const speedup = r40Bin != null && r40Tri != null && r40Tri > 0 ? r40Bin / r40Tri : null;

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
        boyle 1986 · kamrad-ritchken stretched · λ = √3
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
          IV = {contract ? formatPct(contract.implied_volatility, 2) : '-'} · λ = √3
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
          label="|bin − BSM| @ N=40"
          value={r40Bin != null ? `$${r40Bin.toFixed(4)}` : '-'}
          sub="low-N binomial residual"
          accent={PLOTLY_COLORS.primary}
        />
        <StatCell
          label="|tri − BSM| @ N=40"
          value={r40Tri != null ? `$${r40Tri.toFixed(4)}` : '-'}
          sub="low-N trinomial residual"
          accent={PLOTLY_COLORS.positive}
        />
        <StatCell
          label="speedup @ N=40"
          value={speedup != null ? `${speedup.toFixed(1)}×` : '-'}
          sub="bin/tri residual ratio"
          accent={speedup != null && speedup > 2 ? PLOTLY_COLORS.positive : undefined}
        />
        <StatCell
          label="|bin − BSM| @ N=200"
          value={r200Bin != null ? `$${r200Bin.toFixed(4)}` : '-'}
          sub="high-N binomial"
        />
        <StatCell
          label="|tri − BSM| @ N=200"
          value={r200Tri != null ? `$${r200Tri.toFixed(4)}` : '-'}
          sub="high-N trinomial"
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
          Trinomial trees add a third branch: up, stay, down. The stay
          branch absorbs drift cleanly and lines the terminal nodes up
          with the forward regardless of N, which kills most of the
          odd/even oscillation that binomial trees suffer from. At
          λ = 1 the middle probability collapses and the lattice degenerates
          back to binomial; at λ = √3 the spread is wide enough for the
          fastest European convergence.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          The chart above prices the same ATM SPX contract Slot A priced, but
          now with both lattices on the same axes. The{' '}
          <strong style={{ color: PLOTLY_COLORS.primary }}>blue curve</strong>{' '}
          is binomial, carried over from Slot A. The{' '}
          <strong style={{ color: PLOTLY_COLORS.positive }}>green curve</strong>{' '}
          is trinomial. The{' '}
          <strong style={{ color: PLOTLY_COLORS.highlight }}>amber line</strong>{' '}
          is Black-Scholes.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          The green curve sits visibly closer to amber at every N, and the
          low-N tail is much smoother. That is the trinomial win in one
          picture: fewer steps for the same accuracy. For a production
          pricer that has to run millions of lattices per second through a
          scenario engine, a 3-4x step reduction at matched accuracy is
          a meaningful cost.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          <strong style={{ color: 'var(--text-primary)' }}>Reading.</strong>{' '}
          At N = 40 the{' '}
          <strong style={{ color: PLOTLY_COLORS.positive }}>trinomial residual</strong>{' '}
          is typically a few times smaller than the{' '}
          <strong style={{ color: PLOTLY_COLORS.primary }}>binomial residual</strong>.
          The speedup metric is exactly that ratio: if trinomial at N = 40
          matches binomial at N = 120, the ratio reads ~3×. The shape of
          both curves matters too. Binomial zigzags above and below BSM
          because of odd/even parity; trinomial tracks one-sided most of the
          time, which makes intermediate Ns usable for extrapolation.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          The λ = √3 choice is not arbitrary. Boyle showed that this value
          maximizes the variance of the one-step distribution given the
          constraint that all three probabilities stay in [0, 1]. Smaller
          λ narrows the lattice and breaks admissibility at high vol;
          larger λ slows convergence. At typical SPX vol levels √3 is
          safely inside the admissible region, but at very short DTE or
          very high sigma a dynamic λ that backs off toward 1 is needed to
          keep p_d &gt; 0.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          The binomial and trinomial curves agree to pennies at N = 200,
          and both agree with BSM to pennies at that step count. The
          asymptotic answer is the same. What differs is the path there.
          That is the practical takeaway: every tree is a path from a
          coarse discretization toward the same continuous-limit price,
          and smarter discretizations shorten the path.
        </p>
        <p style={{ margin: 0 }}>
          For American pricing (not shown on this chart to keep the
          convergence comparison clean) trinomial also wins, and by more,
          because the early-exercise boundary is better approximated when
          the middle branch can land directly on the strike. That is why
          most production American-option pricers use trinomial lattices
          rather than binomial.
        </p>
      </div>
    </div>
  );
}
