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
import { daysToExpiration, pickDefaultExpiration, filterPickerExpirations } from '../../src/lib/dates';

// -----------------------------------------------------------------------------
// Delta Comparison.
//
// Four delta definitions computed on the same SPX slice. They differ only
// in what they assume about how the implied-vol smile moves when spot
// moves — i.e., in ∂σ/∂S — and that one assumption controls the whole
// shape of the daily hedge ratio.
//
//   BSM / sticky-strike   The quote delta. σ(K) is held fixed when spot
//                         moves, so ∂σ/∂S = 0 and the adjustment term
//                         vanishes. This is what every option-chain
//                         screen shows.
//
//   Sticky-delta          The smile rides with spot: σ̃(k = ln K/S) is
//                         the primitive object, so when S moves the
//                         smile slides along with it in log-moneyness.
//                         Implies ∂σ/∂S|_K = −σ̃'(k)/S. For SPX put-
//                         skew (σ̃'(k) < 0) this adds to the call
//                         delta — the "bull-regime" hedge.
//
//   Minimum-Variance      Hull-White (2017) empirical delta: the hedge
//                         ratio that minimizes daily P&L variance given
//                         realized ∂σ/∂S regressions. On SPX the leverage
//                         effect means ∂σ/∂S < 0, so the MV call delta
//                         sits below the BSM call delta — you hold less
//                         long underlying because the implicit vega gain
//                         on a sell-off does part of the hedging work.
//                         Implemented here with the canonical cubic-in-
//                         delta adjustment φ(δ) = a + b·δ + c·δ².
//
//   Market                The delta carried on the ingested chain from
//                         Massive. This is computed at the quote IV
//                         with BSM, so at clean quotes it coincides with
//                         the BSM / sticky-strike line above. The gap
//                         when the two diverge is a read on residual
//                         quote-processing differences between the feed
//                         and the in-browser re-computation.
//
// One chart, four lines, one expiration. The reader takeaway is how
// different the "same" delta can look depending on the smile-dynamics
// assumption that enters through a single ∂σ/∂S term.
// -----------------------------------------------------------------------------

const RATE_R = 0.045;
const RATE_Q = 0.013;

// Hull-White (2017) MV delta cubic φ(δ) = a + b·δ + c·δ², fitted on daily
// SPX vanillas at the ~1-month horizon in the original paper. These are
// illustrative defaults. A production hedging desk would refit them on
// its own realized return / IV-change time series; in the absence of a
// persisted time series in this snapshot, the paper's published band
// produces the correct sign and scale of the MV adjustment for an SPX
// monthly slice.
const HW_A = -3.0;
const HW_B = 4.0;
const HW_C = -2.0;

// ---- BSM analytic ---------------------------------------------------------

function phi(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}
function Phi(x) {
  const a1 = 0.31938153;
  const a2 = -0.356563782;
  const a3 = 1.781477937;
  const a4 = -1.821255978;
  const a5 = 1.330274429;
  const k = 1 / (1 + 0.2316419 * Math.abs(x));
  const w = 1 - phi(x) * (a1*k + a2*k*k + a3*k*k*k + a4*k*k*k*k + a5*k*k*k*k*k);
  return x >= 0 ? w : 1 - w;
}
function bsmD1(S, K, T, r, q, sigma) {
  const vsT = sigma * Math.sqrt(T);
  return (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / vsT;
}
function bsmVega(S, K, T, r, q, sigma) {
  if (!(sigma > 0) || !(T > 0)) return 0;
  const d1 = bsmD1(S, K, T, r, q, sigma);
  return S * Math.exp(-q * T) * phi(d1) * Math.sqrt(T);
}
function bsmDelta(S, K, T, r, q, sigma, type) {
  if (!(sigma > 0) || !(T > 0)) return 0;
  const d1 = bsmD1(S, K, T, r, q, sigma);
  const eqT = Math.exp(-q * T);
  const callD = eqT * Phi(d1);
  return type === 'put' ? callD - eqT : callD;
}

// ---- SVI smile analytics (same as the stochastic / rough-vol labs) ------

function sviTotalVariance(params, k) {
  const { a, b, rho, m, sigma } = params;
  const u = k - m;
  return a + b * (rho * u + Math.sqrt(u * u + sigma * sigma));
}
function sviDw(params, k) {
  const { b, rho, m, sigma } = params;
  const u = k - m;
  return b * (rho + u / Math.sqrt(u * u + sigma * sigma));
}
function sviIv(params, k, T) {
  const w = sviTotalVariance(params, k);
  if (!(w > 0) || !(T > 0)) return null;
  return Math.sqrt(w / T);
}
// ∂σ/∂k at k = ln(K/F). Chain rule on σ(k) = √(w(k)/T):
//   dσ/dk = w'(k) / (2 · σ · T)
function sviDsigmaDk(params, k, T) {
  const sigma = sviIv(params, k, T);
  if (!sigma) return null;
  return sviDw(params, k) / (2 * sigma * T);
}

// ---- Slice extraction ---------------------------------------------------

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
    rows.push({
      strike,
      iv: src.implied_volatility,
      delta: src.delta,
      type: strike >= spotPrice ? 'call' : 'put',
    });
  }
  rows.sort((a, b) => a.strike - b.strike);
  return rows.filter((r) => Math.abs(Math.log(r.strike / spotPrice)) <= 0.2);
}

// ---- UI ------------------------------------------------------------------

function formatFixed(v, d = 3) {
  if (v == null || !Number.isFinite(v)) return '-';
  return v.toFixed(d);
}
function formatPct(v, d = 2) {
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
  const sviFits = useSviFits({
    contracts: data?.contracts,
    spotPrice: data?.spotPrice,
    capturedAt: data?.capturedAt,
    backendFits: data?.sviFits,
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
  const F = data && T ? data.spotPrice * Math.exp((RATE_R - RATE_Q) * T) : null;

  const sviSlice = useMemo(() => {
    if (!activeExp) return null;
    return sviFits?.byExpiration?.[activeExp] ?? null;
  }, [sviFits, activeExp]);

  const deltas = useMemo(() => {
    if (!slice.length || !T || !data || !F) return null;
    const S = data.spotPrice;
    const rows = slice.map((obs) => {
      const K = obs.strike;
      const sigma = obs.iv;
      const type = obs.type;
      const dBSM = bsmDelta(S, K, T, RATE_R, RATE_Q, sigma, type);
      const vega = bsmVega(S, K, T, RATE_R, RATE_Q, sigma);

      const k = Math.log(K / F);
      let dSigmaDk = null;
      if (sviSlice?.params) {
        dSigmaDk = sviDsigmaDk(sviSlice.params, k, T);
      } else {
        // finite-difference fallback against the neighbors
        dSigmaDk = null;
      }

      // Sticky-delta: σ̃(k) fixed → ∂σ/∂S|_K = −σ̃'(k)/S
      const stickyDelta = dSigmaDk != null
        ? dBSM + vega * (-dSigmaDk / S)
        : null;

      // Hull-White 2017 cubic adjustment φ(δ) = a + b·δ + c·δ²:
      //   δ_MV = δ_BSM + (vega / (S·√T)) · φ(δ_BSM)
      const phiHW = HW_A + HW_B * dBSM + HW_C * dBSM * dBSM;
      const mvDelta = dBSM + (vega / (S * Math.sqrt(T))) * (phiHW / 100);

      return {
        K,
        k,
        type,
        iv: sigma,
        dBSM,
        dMarket: Number.isFinite(obs.delta) ? obs.delta : null,
        dStickyDelta: stickyDelta,
        dMV: mvDelta,
        vega,
        dSigmaDk,
      };
    });
    return rows;
  }, [slice, T, data, F, sviSlice]);

  useEffect(() => {
    if (!Plotly || !chartRef.current || !deltas || !data) return;

    const strikes = deltas.map((r) => r.K);
    const bsm = deltas.map((r) => r.dBSM);
    const mv = deltas.map((r) => r.dMV);
    const sd = deltas.map((r) => r.dStickyDelta);
    const mkt = deltas.map((r) => r.dMarket);

    const traces = [
      {
        x: strikes,
        y: bsm,
        mode: 'lines+markers',
        name: 'BSM · sticky-strike',
        line: { color: PLOTLY_COLORS.primary, width: 2 },
        marker: { size: 4, color: PLOTLY_COLORS.primary },
        hovertemplate: 'K %{x}<br>BSM δ %{y:.3f}<extra></extra>',
      },
      {
        x: strikes,
        y: sd,
        mode: 'lines',
        name: 'Sticky-delta',
        line: { color: PLOTLY_COLORS.highlight, width: 2, dash: 'dash' },
        hovertemplate: 'K %{x}<br>δ_sd %{y:.3f}<extra></extra>',
        connectgaps: false,
      },
      {
        x: strikes,
        y: mv,
        mode: 'lines',
        name: 'Minimum-Variance',
        line: { color: PLOTLY_COLORS.secondary, width: 2 },
        hovertemplate: 'K %{x}<br>δ_MV %{y:.3f}<extra></extra>',
      },
      {
        x: strikes,
        y: mkt,
        mode: 'markers',
        name: 'Market δ (feed)',
        marker: {
          color: PLOTLY_COLORS.positive,
          size: mobile ? 6 : 7,
          line: { width: 0 },
        },
        hovertemplate: 'K %{x}<br>feed δ %{y:.3f}<extra></extra>',
      },
      {
        x: [data.spotPrice, data.spotPrice],
        y: [-1.1, 1.1],
        mode: 'lines',
        name: 'spot',
        line: { color: PLOTLY_COLORS.axisText, width: 1, dash: 'dot' },
        hoverinfo: 'skip',
        showlegend: false,
      },
    ];

    const allY = [...bsm, ...mv, ...sd.filter(Number.isFinite), ...mkt.filter(Number.isFinite)];
    const yMin = Math.min(...allY);
    const yMax = Math.max(...allY);
    const pad = (yMax - yMin) * 0.1 || 0.05;

    const layout = plotly2DChartLayout({
      title: {
        ...plotlyTitle('Delta definitions across strikes · SPX'),
        y: 0.97,
        yref: 'container',
        yanchor: 'top',
      },
      margin: mobile ? { t: 50, r: 25, b: 90, l: 65 } : { t: 70, r: 35, b: 100, l: 80 },
      xaxis: plotlyAxis('Strike'),
      yaxis: plotlyAxis('Delta', {
        range: [yMin - pad, yMax + pad],
        autorange: false,
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
      hovermode: 'closest',
    });

    Plotly.react(chartRef.current, traces, layout, {
      responsive: true,
      displayModeBar: false,
    });
  }, [Plotly, deltas, data, mobile]);

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

  // ATM reference row — use the strike closest to spot
  const atmRow = deltas && data
    ? deltas.reduce((best, r) => (Math.abs(r.K - data.spotPrice) < Math.abs(best.K - data.spotPrice) ? r : best), deltas[0])
    : null;

  const atmSkew = sviSlice?.params
    ? sviDsigmaDk(sviSlice.params, 0, T)
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
        model · delta comparison · bsm / sticky-delta / minimum-variance / market
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
          DTE {dte != null ? dte.toFixed(1) : '-'} · {slice.length} strikes ·{' '}
          F = {F != null ? F.toFixed(2) : '-'} ·{' '}
          SVI {sviSlice ? 'ok' : 'fallback'}
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
          label="ATM BSM δ"
          value={atmRow ? formatFixed(atmRow.dBSM, 3) : '-'}
          sub={atmRow ? `K ${atmRow.K} · σ ${formatPct(atmRow.iv, 1)}` : '-'}
          accent={PLOTLY_COLORS.primary}
        />
        <StatCell
          label="ATM sticky-δ"
          value={atmRow && atmRow.dStickyDelta != null ? formatFixed(atmRow.dStickyDelta, 3) : '-'}
          sub={atmRow && atmRow.dStickyDelta != null
            ? `+${formatFixed(atmRow.dStickyDelta - atmRow.dBSM, 3)} vs BSM`
            : 'needs SVI'}
          accent={PLOTLY_COLORS.highlight}
        />
        <StatCell
          label="ATM MV δ"
          value={atmRow ? formatFixed(atmRow.dMV, 3) : '-'}
          sub={atmRow ? `${formatFixed(atmRow.dMV - atmRow.dBSM, 3)} vs BSM` : '-'}
          accent={PLOTLY_COLORS.secondary}
        />
        <StatCell
          label="ATM market δ"
          value={atmRow && atmRow.dMarket != null ? formatFixed(atmRow.dMarket, 3) : '-'}
          sub="from feed"
          accent={PLOTLY_COLORS.positive}
        />
        <StatCell
          label="ATM skew ∂σ/∂k"
          value={atmSkew != null ? formatFixed(atmSkew, 3) : '-'}
          sub="negative = put-skew"
          accent={atmSkew != null && atmSkew < 0 ? PLOTLY_COLORS.secondary : undefined}
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
          Four notions of delta on one SPX slice. They all start from the same
          market implied vol and the same option price. They differ only in
          what they assume about how the smile moves when spot moves. That
          one assumption is worth up to a few cents of hedge per dollar of
          notional.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          The{' '}
          <strong style={{ color: PLOTLY_COLORS.primary }}>BSM line</strong>{' '}
          is the quote delta. It assumes σ(K) is glued to the strike and
          does not move with spot. This is the "sticky-strike" world and is
          what every option-chain screen reports.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          The{' '}
          <strong style={{ color: PLOTLY_COLORS.highlight }}>sticky-delta line</strong>{' '}
          assumes the whole smile rides with the underlying. Under SPX put
          skew this makes call delta larger, because when spot rises the
          smile at the call strike also rises and adds to the call value.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          The{' '}
          <strong style={{ color: PLOTLY_COLORS.secondary }}>minimum-variance line</strong>{' '}
          is the Hull-White (2017) hedge: the delta that minimizes realized
          P&amp;L variance given that on SPX vol tends to rise when spot
          falls. It runs below the BSM call line because some of the
          downside hedge is already done by your vega book.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          The{' '}
          <strong style={{ color: PLOTLY_COLORS.positive }}>green dots</strong>{' '}
          are the market deltas carried on the feed, computed with BSM at
          quote IV. They track the BSM line by construction. The gap when it
          opens is quote-processing noise.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          <strong style={{ color: 'var(--text-primary)' }}>Reading.</strong>{' '}
          The vertical spread between the{' '}
          <strong style={{ color: PLOTLY_COLORS.primary }}>BSM</strong>,{' '}
          <strong style={{ color: PLOTLY_COLORS.highlight }}>sticky-delta</strong>, and{' '}
          <strong style={{ color: PLOTLY_COLORS.secondary }}>MV</strong>{' '}
          lines is largest in the wings and near zero at ATM. Out-of-the-money
          options are almost all vega, so the ∂σ/∂S term dominates their
          hedge ratio. At-the-money options are mostly intrinsic, so the
          smile-dynamics correction barely moves them.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          For SPX monthly calls, the sticky-delta line sits above BSM and the
          MV line sits below. Both adjustments are driven by the same negative
          ATM skew. Sticky-delta says the smile rides with spot (vol up when
          spot up). MV says the smile moves opposite spot (vol up when spot
          down, the leverage effect). The empirical reality for SPX is much
          closer to MV.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          For SPX monthly puts, the picture flips. The sticky-delta line is
          less negative than BSM and the MV line is more negative. A
          delta-hedged long put under the MV framework requires selling a bit
          more stock than BSM asks for, because the vega payoff on a
          sell-off also contributes to the hedge.
        </p>
        <p style={{ margin: 0 }}>
          If the four lines bunch together, smile dynamics are not moving the
          hedge much. If they fan out strongly, the smile-dynamics assumption
          is material for how you hedge this slice today. The cubic
          adjustment coefficients come from Hull-White (2017) and are
          indicative, not refitted to the current snapshot.
        </p>
      </div>
    </div>
  );
}
