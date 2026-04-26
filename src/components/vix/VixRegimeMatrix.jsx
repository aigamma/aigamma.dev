import { useMemo } from 'react';
import {
  classifyRegime,
  regimeDistribution,
  regimeTransitions,
  VIX_REGIME_THRESHOLDS,
} from '../../lib/vix-models';

// Discrete VIX regime classifier. Four states defined by long-history
// percentile cuts on the VIX level (12 / 18 / 30 — these match Cboe's
// regime-research conventions and the 30 / 60 / 90th percentiles of the
// 1990-onward daily VIX distribution; we don't recompute the cuts off the
// 3-year backfill because three years is too short a window to anchor
// decade-scale regime thresholds).
//
// The card renders three things:
//   1. The current state badge (large, color-coded).
//   2. A four-cell tally showing how many days in the backfill landed in
//      each state.
//   3. The empirical N-day-ahead transition matrix — for each "from" state,
//      the probability of being in each "to" state N trading days later.
//      The diagonal is the persistence; off-diagonal cells visualize how
//      regimes flow into each other.

const STATE_ORDER = ['calm', 'normal', 'elevated', 'stressed'];
const STATE_COLOR = {
  calm:     '#04A29F',
  normal:   '#4a9eff',
  elevated: '#f1c40f',
  stressed: '#e74c3c',
};
const STATE_LABEL = {
  calm:     'CALM',
  normal:   'NORMAL',
  elevated: 'ELEVATED',
  stressed: 'STRESSED',
};
const STATE_HINT = {
  calm:     'VIX < 12 — risk-on regime',
  normal:   'VIX 12-18 — typical operating zone',
  elevated: 'VIX 18-30 — caution',
  stressed: 'VIX > 30 — crisis pricing',
};

function pctTone(p) {
  if (p >= 0.50) return STATE_COLOR.stressed;
  if (p >= 0.20) return STATE_COLOR.elevated;
  if (p >= 0.05) return STATE_COLOR.normal;
  return STATE_COLOR.calm;
}

const TRANSITION_LAGS = [1, 5, 21];

export default function VixRegimeMatrix({ data }) {
  const computed = useMemo(() => {
    if (!data) return null;
    const vix = data.series?.VIX || [];
    const lastVix = data.latest?.VIX?.close ?? null;
    const currentState = classifyRegime(lastVix);
    const dist = regimeDistribution(vix);
    const transitions = {};
    for (const lag of TRANSITION_LAGS) {
      transitions[lag] = regimeTransitions(vix, lag);
    }
    return { currentState, lastVix, dist, transitions };
  }, [data]);

  if (!computed) {
    return <div className="card" style={{ padding: '1rem' }}>Loading regime data…</div>;
  }
  const { currentState, lastVix, dist, transitions } = computed;

  return (
    <div className="card vix-regime-card">
      <div className="vix-regime-header">
        <div className="vix-regime-current">
          <div className="vix-regime-current__label">Current state</div>
          <div
            className="vix-regime-current__badge"
            style={{
              borderColor: currentState ? STATE_COLOR[currentState] : 'var(--bg-card-border)',
              color: currentState ? STATE_COLOR[currentState] : 'var(--text-secondary)',
            }}
          >
            {currentState ? STATE_LABEL[currentState] : '—'}
          </div>
          <div className="vix-regime-current__sub">
            VIX = {lastVix != null ? lastVix.toFixed(2) : '—'} ·{' '}
            {currentState ? STATE_HINT[currentState] : ''}
          </div>
        </div>

        <div className="vix-regime-tally">
          {STATE_ORDER.map((s) => {
            const n = dist[s];
            const pct = dist.total > 0 ? (n / dist.total) * 100 : 0;
            return (
              <div key={s} className="vix-regime-tally__cell">
                <div className="vix-regime-tally__name" style={{ color: STATE_COLOR[s] }}>
                  {STATE_LABEL[s]}
                </div>
                <div className="vix-regime-tally__count">{n}d</div>
                <div className="vix-regime-tally__pct">{pct.toFixed(1)}%</div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="vix-regime-thresholds">
        Thresholds: VIX &lt; {VIX_REGIME_THRESHOLDS.calm} = calm ·{' '}
        VIX &lt; {VIX_REGIME_THRESHOLDS.normal} = normal ·{' '}
        VIX &lt; {VIX_REGIME_THRESHOLDS.elevated} = elevated ·{' '}
        VIX ≥ {VIX_REGIME_THRESHOLDS.elevated} = stressed
      </div>

      {TRANSITION_LAGS.map((lag) => (
        <div key={lag} className="vix-regime-matrix">
          <div className="vix-regime-matrix__title">
            {lag}-day transition probability
          </div>
          <table className="vix-regime-table">
            <thead>
              <tr>
                <th />
                {STATE_ORDER.map((s) => (
                  <th key={s} style={{ color: STATE_COLOR[s] }}>{STATE_LABEL[s]}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {STATE_ORDER.map((from) => (
                <tr key={from}>
                  <th style={{ color: STATE_COLOR[from] }}>{STATE_LABEL[from]}</th>
                  {STATE_ORDER.map((to) => {
                    const p = transitions[lag][from][to];
                    const intensity = Math.min(p * 1.4, 1);
                    return (
                      <td
                        key={to}
                        style={{
                          background: `rgba(74, 158, 255, ${(intensity * 0.6).toFixed(3)})`,
                          color: p > 0 ? pctTone(p) : 'var(--text-secondary)',
                          fontWeight: from === to ? 700 : 400,
                        }}
                      >
                        {p > 0 ? `${(p * 100).toFixed(1)}%` : '—'}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
