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

// IVs in the payload are fractions (0.2345 = 23.45%), so the day-over-day
// delta is reported in percentage points of IV, not a relative change —
// "+0.12pp" reads unambiguously to a vol trader, whereas "+0.51%" on an
// already-percent quantity is the classic absolute-vs-relative trap.
function ivDeltaSub(current, prior) {
  if (current == null || prior == null) return null;
  const pp = (current - prior) * 100;
  const sign = pp >= 0 ? '+' : '';
  return `${sign}${pp.toFixed(2)}pp d/d`;
}

// Overnight Alignment helpers. Score is the net of per-level signs in
// [-3, +3] computed in App.jsx; color steps through coral / amber / green
// at |score| ≥ 2 so a partial alignment (2 of 3) paints the same as a full
// alignment (3 of 3) — the sub-line's per-level arrows carry the finer
// breakdown. The arrow glyphs are up/down/em-dash for rose/fell/unchanged
// and a thin space question mark for an uncountable level (e.g., prev day
// carried a null for that field).
function alignmentAccent(score) {
  if (score == null) return undefined;
  if (score >= 2) return '#02A29F';
  if (score <= -2) return 'var(--accent-coral)';
  return 'var(--accent-amber)';
}

function alignmentArrow(dir) {
  if (dir == null) return '?';
  if (dir.sign > 0) return '↑';
  if (dir.sign < 0) return '↓';
  return '—';
}

function alignmentValue(score) {
  if (score == null) return '—';
  const prefix = score > 0 ? '+' : '';
  return `${prefix}${score}`;
}

// Gamma Index is an oscillator in [-10, +10] sourced from the most recent
// daily_gex_stats row and held fixed through the session because OI only
// refreshes overnight. Accent follows the same three-band threshold as
// Overnight Alignment so the two cells read in the same visual register:
// clearly positive paints green, clearly negative paints coral, near-zero
// paints amber.
function gammaIndexAccent(value) {
  if (value == null) return undefined;
  if (value >= 2) return '#02A29F';
  if (value <= -2) return 'var(--accent-coral)';
  return 'var(--accent-amber)';
}

function gammaIndexValue(value) {
  if (value == null) return '—';
  const prefix = value > 0 ? '+' : '';
  return `${prefix}${value.toFixed(2)}`;
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

export default function LevelsPanel({ levels, spotPrice, prevClose, expirationMetrics, prevExpirationMetrics, expirations, selectedExpiration, onExpirationChange, capturedAt, vrpMetric, overnightAlignment }) {
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

  // Look up yesterday's row for the same expiration_date so the d/d diffs
  // compare the same contract, not two rolling picks at equal DTE — when
  // today's selected expiration didn't exist in yesterday's chain (e.g.,
  // today's 0DTE), prevMetric stays null and the sub-lines fall back to —.
  const prevMetric =
    relevantMetric && prevExpirationMetrics && prevExpirationMetrics.length > 0
      ? prevExpirationMetrics.find((m) => m.expiration_date === relevantMetric.expiration_date) || null
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
          label="Overnight Alignment"
          value={alignmentValue(overnightAlignment?.score)}
          accent={alignmentAccent(overnightAlignment?.score)}
          sub={
            overnightAlignment
              ? `PW ${alignmentArrow(overnightAlignment.dirs.put_wall)}  VF ${alignmentArrow(overnightAlignment.dirs.volatility_flip)}  CW ${alignmentArrow(overnightAlignment.dirs.call_wall)}`
              : null
          }
          bold
        />
        <Stat
          label="Vol Flip"
          value={formatInteger(levels.volatility_flip)}
          accent="var(--accent-amber)"
          sub={volFlipSub}
        />
        <Stat label="SPX" value={formatInteger(spotPrice)} accent="var(--accent-blue)" sub={spotDeltaSub(spotPrice, prevClose)} />
        <Stat
          label="Put Wall"
          value={formatInteger(levels.put_wall)}
          accent="var(--accent-coral)"
          sub={putWallSub}
        />
        <Stat
          label="Call Wall"
          value={formatInteger(levels.call_wall)}
          accent="var(--accent-green)"
          sub={callWallSub}
        />
      </div>

      <Divider />

      <div className={ROW_GRID_CLASS}>
        <Stat
          label="Gamma Index"
          value={gammaIndexValue(levels.gamma_index)}
          accent={gammaIndexAccent(levels.gamma_index)}
          sub={levels.gamma_index_date ? `as of ${levels.gamma_index_date}` : null}
          bold
        />
        <Stat
          label="Dist from Risk Off"
          value={flipDist != null ? `${aboveFlip ? '+' : ''}${flipDist.toFixed(2)}` : '—'}
          accent="var(--accent-amber)"
          sub={flipDist != null ? `${((flipDist / spotPrice) * 100).toFixed(2)}%` : null}
        />
        <Stat
          label="VRP"
          value={vrpMetric ? `${vrpMetric.vrp > 0 ? '+' : ''}${vrpMetric.vrp.toFixed(2)}%` : '—'}
          accent="var(--accent-purple)"
          sub={vrpMetric ? `IV ${vrpMetric.iv.toFixed(1)}% / RV ${vrpMetric.rv.toFixed(1)}%` : null}
        />
        <Stat
          label="IV Rank"
          value={vrpMetric?.ivRank != null ? `${vrpMetric.ivRank.toFixed(1)}%` : '—'}
          accent="var(--accent-purple)"
          sub={
            vrpMetric?.ivRankLow != null && vrpMetric?.ivRankHigh != null
              ? `252d: ${vrpMetric.ivRankLow.toFixed(1)}% – ${vrpMetric.ivRankHigh.toFixed(1)}%`
              : null
          }
        />
        <Stat
          label="P/C Ratio (Volume)"
          value={formatRatio(levels.put_call_ratio_volume)}
          accent="var(--accent-purple)"
          sub={
            levels.total_put_volume != null && levels.total_call_volume != null
              ? `${formatGamma(levels.total_put_volume)}P / ${formatGamma(levels.total_call_volume)}C`
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
            <Stat
              label="25Δ Put IV"
              value={formatPercent(relevantMetric.put_25d_iv)}
              sub={ivDeltaSub(relevantMetric.put_25d_iv, prevMetric?.put_25d_iv)}
            />
            <Stat
              label="ATM IV"
              value={formatPercent(relevantMetric.atm_iv)}
              sub={ivDeltaSub(relevantMetric.atm_iv, prevMetric?.atm_iv)}
            />
            <Stat
              label="25Δ Call IV"
              value={formatPercent(relevantMetric.call_25d_iv)}
              sub={ivDeltaSub(relevantMetric.call_25d_iv, prevMetric?.call_25d_iv)}
            />
          </div>
        </>
      )}
    </div>
  );
}
