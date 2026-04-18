import { formatGamma, formatInteger, formatPercent, formatRatio } from '../lib/format';
import { daysToExpiration, isThirdFridayMonthly } from '../lib/dates';

// Treat the 3rd Friday of the month (Friday whose calendar day is 15-21) as
// an AM-settled standard SPX monthly; everything else is a PM-settled SPXW
// weekly. Only the AM case is labeled in the dropdown — PM is the default
// so an unlabeled entry implicitly means PM, which keeps the dropdown
// column narrow enough to fit the longer AM label without clipping. On
// 3rd Fridays both roots technically share the same calendar date, but the
// App-level same-day filter removes that date from the picker entirely,
// leaving only future 3rd Fridays (where the AM monthly is the primary
// interest) and non-3rd-Friday weeklies (where only SPXW exists).
function formatExpirationOption(exp, capturedAt) {
  const dteFrac = daysToExpiration(exp, capturedAt);
  const dteLabel = dteFrac != null ? `${Math.max(0, Math.round(dteFrac))}d` : '—d';
  if (isThirdFridayMonthly(exp)) {
    return `${exp} AM (${dteLabel})`;
  }
  return `${exp} (${dteLabel})`;
}

function distanceSub(level, spot) {
  if (level == null || spot == null) return null;
  const dollar = level - spot;
  const pct = (dollar / spot) * 100;
  const sign = dollar >= 0 ? '+' : '';
  return `${sign}${dollar.toFixed(2)}  ·  ${sign}${pct.toFixed(2)}%`;
}

function spotDeltaSub(spot, prevClose) {
  if (spot == null || prevClose == null || prevClose === 0) return null;
  const dollar = spot - prevClose;
  const pct = (dollar / prevClose) * 100;
  const sign = dollar >= 0 ? '+' : '';
  return `${sign}${dollar.toFixed(2)}  ·  ${sign}${pct.toFixed(2)}%`;
}

function expectedMoveDollar(spot, atmIv, dte) {
  if (spot == null || atmIv == null || dte == null || dte <= 0) return null;
  return spot * atmIv * Math.sqrt(dte / 365);
}

function Stat({ label, value, accent, sub, bold }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div
        style={{
          fontSize: '0.8rem',
          color: 'var(--text-secondary)',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          marginBottom: '0.25rem',
        }}
      >
        {label}
      </div>
      <div
        className="data-value"
        style={{
          fontSize: '1.05rem',
          color: accent || 'var(--text-primary)',
          fontWeight: bold ? 700 : undefined,
        }}
      >
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.15rem' }}>
          {sub}
        </div>
      )}
    </div>
  );
}

function Divider() {
  return (
    <div
      style={{
        borderTop: '1px solid var(--bg-card-border)',
        marginTop: '1rem',
        paddingTop: '1rem',
      }}
    />
  );
}

const ROW_GRID_CLASS = 'levels-row';

export default function LevelsPanel({ levels, spotPrice, prevClose, expirationMetrics, expirations, selectedExpiration, onExpirationChange, capturedAt, vrpMetric }) {
  if (!levels) {
    return (
      <div className="card text-muted" style={{ marginBottom: '1rem' }}>
        No computed levels available for this run.
      </div>
    );
  }

  const callWallSub = distanceSub(levels.call_wall, spotPrice);
  const putWallSub = distanceSub(levels.put_wall, spotPrice);
  const volFlipSub = distanceSub(levels.volatility_flip, spotPrice);

  const flipDist =
    spotPrice != null && levels.volatility_flip != null
      ? spotPrice - levels.volatility_flip
      : null;
  const aboveFlip = flipDist != null && flipDist >= 0;

  const relevantMetric =
    expirationMetrics && expirationMetrics.length > 0
      ? expirationMetrics.find((m) => m.expiration_date === selectedExpiration) || expirationMetrics[0]
      : null;

  const dte = relevantMetric ? daysToExpiration(relevantMetric.expiration_date, capturedAt) : null;
  const expMoveDollar = relevantMetric ? expectedMoveDollar(spotPrice, relevantMetric.atm_iv, dte) : null;
  const expMoveLow = expMoveDollar != null && spotPrice != null ? spotPrice - expMoveDollar : null;
  const expMoveHigh = expMoveDollar != null && spotPrice != null ? spotPrice + expMoveDollar : null;
  const expMoveSub =
    expMoveLow != null && expMoveHigh != null
      ? `${expMoveLow.toFixed(2)} – ${expMoveHigh.toFixed(2)}  ·  ${dte != null ? dte.toFixed(1) : '—'}d`
      : null;

  return (
    <div className="card" style={{ marginBottom: '1rem' }}>
      <div className={ROW_GRID_CLASS}>
        <Stat
          label="Put Wall"
          value={formatInteger(levels.put_wall)}
          accent="var(--accent-coral)"
          sub={putWallSub}
        />
        <Stat
          label="Vol Flip"
          value={formatInteger(levels.volatility_flip)}
          accent="var(--accent-amber)"
          sub={volFlipSub}
        />
        <Stat label="SPX" value={formatInteger(spotPrice)} accent="var(--accent-blue)" sub={spotDeltaSub(spotPrice, prevClose)} />
        <Stat
          label="Call Wall"
          value={formatInteger(levels.call_wall)}
          accent="var(--accent-green)"
          sub={callWallSub}
        />
        <Stat
          label="Dist from Risk Off"
          value={flipDist != null ? `${aboveFlip ? '+' : ''}${flipDist.toFixed(2)}` : '\u2014'}
          accent="var(--accent-amber)"
          sub={flipDist != null ? `${((flipDist / spotPrice) * 100).toFixed(2)}%` : null}
        />
      </div>

      <Divider />

      <div className={ROW_GRID_CLASS}>
        <Stat
          label="VRP"
          value={vrpMetric ? `${vrpMetric.vrp > 0 ? '+' : ''}${vrpMetric.vrp.toFixed(2)}%` : '\u2014'}
          accent="var(--accent-cyan)"
          sub={vrpMetric ? `IV ${vrpMetric.iv.toFixed(1)}% / RV ${vrpMetric.rv.toFixed(1)}%` : null}
        />
        <Stat
          label="IV Rank"
          value={vrpMetric?.ivRank != null ? `${vrpMetric.ivRank.toFixed(1)}%` : '\u2014'}
          accent="var(--accent-cyan)"
          sub={
            vrpMetric?.ivRankLow != null && vrpMetric?.ivRankHigh != null
              ? `252d: ${vrpMetric.ivRankLow.toFixed(1)}% – ${vrpMetric.ivRankHigh.toFixed(1)}%`
              : null
          }
        />
        <Stat
          label="IV Percentile"
          value={vrpMetric?.ivPercentile != null ? `${vrpMetric.ivPercentile.toFixed(1)}%` : '\u2014'}
          accent="var(--accent-cyan)"
          sub={
            vrpMetric?.ivLookbackDays != null
              ? `${Math.round((vrpMetric.ivPercentile / 100) * vrpMetric.ivLookbackDays)} of ${vrpMetric.ivLookbackDays}d below`
              : null
          }
        />
        <Stat
          label="P/C Ratio (Volume)"
          value={formatRatio(levels.put_call_ratio_volume)}
          accent="var(--accent-cyan)"
          sub={
            levels.total_put_volume != null && levels.total_call_volume != null
              ? `${formatGamma(levels.total_put_volume)}P / ${formatGamma(levels.total_call_volume)}C`
              : null
          }
        />
        <Stat
          label="P/C Ratio (OI)"
          value={formatRatio(levels.put_call_ratio_oi)}
          accent="var(--accent-cyan)"
          sub={
            levels.total_put_oi != null && levels.total_call_oi != null
              ? `${formatGamma(levels.total_put_oi)}P / ${formatGamma(levels.total_call_oi)}C`
              : null
          }
        />
      </div>

      {relevantMetric && (
        <>
          <Divider />
          <div className={ROW_GRID_CLASS}>
            <div style={{ minWidth: 0 }}>
              <label
                htmlFor="expiration-select"
                style={{
                  display: 'block',
                  fontSize: '0.8rem',
                  color: 'var(--text-secondary)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  marginBottom: '0.25rem',
                }}
              >
                Expiration
              </label>
              <select
                id="expiration-select"
                value={selectedExpiration || ''}
                onChange={(e) => onExpirationChange?.(e.target.value)}
                style={{
                  background: 'var(--bg-primary)',
                  color: 'var(--text-primary)',
                  border: '1px solid var(--bg-card-border)',
                  borderRadius: '4px',
                  padding: '0.35rem 0.5rem',
                  fontFamily: 'Courier New, monospace',
                  fontSize: '0.9rem',
                  width: '100%',
                }}
              >
                {(expirations || []).map((exp) => (
                  <option key={exp} value={exp}>{formatExpirationOption(exp, capturedAt)}</option>
                ))}
              </select>
            </div>
            <Stat
              label="Expected Move"
              value={
                expMoveDollar != null
                  ? `${expMoveDollar.toFixed(2)} (${spotPrice != null ? ((expMoveDollar / spotPrice) * 100).toFixed(2) : '—'}%)`
                  : '—'
              }
              accent="var(--accent-purple)"
              sub={expMoveSub}
              bold
            />
            <Stat label="25Δ Put IV" value={formatPercent(relevantMetric.put_25d_iv)} />
            <Stat label="ATM IV" value={formatPercent(relevantMetric.atm_iv)} />
            <Stat label="25Δ Call IV" value={formatPercent(relevantMetric.call_25d_iv)} />
          </div>
        </>
      )}
    </div>
  );
}
