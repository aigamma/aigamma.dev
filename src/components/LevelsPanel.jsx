import { formatGamma, formatInteger, formatPercent, formatRatio } from '../lib/format';
import { daysToExpiration, formatFreshness, isThirdFridayMonthly } from '../lib/dates';

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

// Dist from Risk Off paints with the dealer-gamma regime color: positive
// (SPX above Vol Flip, dealers long gamma) reads in the same greenish teal
// the Gamma Index cell uses for clearly-positive readings and the browser
// extension uses for its POSITIVE status pill; negative flips to coral red,
// matching the extension's NEGATIVE pill. Binary split by sign (no amber
// middle band) because the sign itself is the regime — there is no
// "near-zero neutral" region the way there is for the bounded ±10 gamma
// index oscillator. Null returns undefined so the Stat falls back to the
// default text color rather than inheriting a stale accent.
function flipDistAccent(dist) {
  if (dist == null) return undefined;
  if (dist >= 0) return '#02A29F';
  return 'var(--accent-coral)';
}

function Stat({ label, value, accent, sub, bold, className }) {
  return (
    <div className={className} style={{ minWidth: 0 }}>
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

export default function LevelsPanel({ levels, spotPrice, prevClose, expirationMetrics, prevExpirationMetrics, expirations, selectedExpiration, onExpirationChange, capturedAt, vrpMetric, overnightAlignment, isSynthetic, regimeIndicator }) {
  if (!levels) {
    return (
      <div className="card text-muted" style={{ marginBottom: '1rem' }}>
        No computed levels available for this run.
      </div>
    );
  }

  const freshness = capturedAt ? formatFreshness(capturedAt) : null;

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
      {/* Top strip of the card: the aigamma wordmark logo on the
          left, the dealer-gamma regime indicator (favicon +
          "Gamma" / "Near Flip" text) immediately to its right,
          the "Last Updated:" freshness text centered, and an empty
          1fr cell on the right. Both the logo and the regime
          indicator used to live in the upper-left of the page
          header — the logo wrapped in an <a href="https://about.aigamma.com/">
          (an accidental clicktrap), the regime indicator inside an
          identically-shaped outlined pill that visually read as a
          sixth top-nav button but actually navigated to about.aigamma.com
          instead of behaving like a navigation button. Both were
          relocated here as static (non-link) elements so the brand
          and regime signals stay visible without competing with the
          real navigation chrome above and without functioning as
          surprise links.

          The 1fr / auto / 1fr grid keeps the freshness text
          horizontally centered in the card regardless of the
          logo+pill cluster's intrinsic width — the auto-sized
          middle column locks to the freshness span, and the
          symmetric 1fr columns on either side absorb the remainder.
          The strip always renders so the logo is visible even
          before the freshness data resolves; the regime indicator
          renders only when the regime classification is available
          (it depends on data the LevelsPanel only receives once a
          payload has been fetched).

          Pill icon sources: the positive (teal +) and negative
          (red −) glyphs are rendered as inline SVG with viewBox
          0 0 32 32 so they stay vector-crisp at any pill height.
          The geometry mirrors the original icon32.png artwork — a
          black 32×32 ground with a teal plus (vertical 8×28 + horizontal
          28×8 centered) for positive, and a red minus (26×8 centered)
          for negative — so the visual identity is preserved. The
          neutral state reads the existing 128×128 favicon PNG which
          carries higher-resolution AiGamma artwork and downscales
          cleanly at the new icon size; the prior 32×32 source upscaled
          to the new 2.4rem icon size visibly blurred on retina. The
          pill height itself was bumped from 2rem to 3.2rem to match
          the adjacent logo, with proportional bumps to icon size
          (1.3rem → 2.4rem), text size (0.85rem → 1.05rem), and
          horizontal padding so the new chrome reads at the same
          visual register as the wordmark next to it. */}
      <div
        className="levels-strip"
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr auto 1fr',
          alignItems: 'center',
          gap: '0.5rem',
          marginBottom: '1rem',
          fontFamily: 'Courier New, monospace',
          fontSize: '0.8rem',
          color: 'var(--text-secondary)',
        }}
      >
        <div
          className="levels-strip__brand"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.6rem',
            justifySelf: 'start',
          }}
        >
          <img
            src="/logo.webp"
            alt="aigamma.com"
            style={{ height: '3.2rem', display: 'block' }}
          />
          {regimeIndicator && (
            <span
              title={`${regimeIndicator.label}: ${regimeIndicator.hint}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.6rem',
                height: '3.2rem',
                padding: '0 0.85rem',
                boxSizing: 'border-box',
                border: `1px solid ${regimeIndicator.color}`,
                color: regimeIndicator.color,
                borderRadius: '4px',
                fontFamily: 'Courier New, monospace',
                fontSize: '1.05rem',
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                whiteSpace: 'nowrap',
              }}
            >
              {regimeIndicator.state === 'positive' && (
                <svg
                  viewBox="0 0 32 32"
                  width="2.4rem"
                  height="2.4rem"
                  aria-hidden="true"
                  style={{ display: 'block', flexShrink: 0 }}
                >
                  <rect width="32" height="32" fill="#000000" />
                  <rect x="12" y="2" width="8" height="28" fill="#04a29f" />
                  <rect x="2" y="12" width="28" height="8" fill="#04a29f" />
                </svg>
              )}
              {regimeIndicator.state === 'negative' && (
                <svg
                  viewBox="0 0 32 32"
                  width="2.4rem"
                  height="2.4rem"
                  aria-hidden="true"
                  style={{ display: 'block', flexShrink: 0 }}
                >
                  <rect width="32" height="32" fill="#000000" />
                  <rect x="3" y="12" width="26" height="8" fill="#ef4444" />
                </svg>
              )}
              {regimeIndicator.state === 'neutral' && (
                <img
                  src="/favicons/neutral/icon128.png?v=2"
                  alt=""
                  aria-hidden="true"
                  style={{ height: '2.4rem', width: '2.4rem', display: 'block', flexShrink: 0 }}
                />
              )}
              <span>{regimeIndicator.text}</span>
            </span>
          )}
        </div>
        {freshness ? (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.5rem',
              justifySelf: 'center',
            }}
          >
            <span style={{ whiteSpace: 'nowrap' }}>{'Last Updated: '}{freshness}</span>
            {isSynthetic && (
              <span
                style={{
                  padding: '0.1rem 0.4rem',
                  border: '1px solid var(--accent-amber)',
                  color: 'var(--accent-amber)',
                  borderRadius: '3px',
                }}
              >
                SYNTHETIC
              </span>
            )}
          </span>
        ) : (
          <span />
        )}
        <span />
      </div>
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
          bold
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
        <Stat
          label="P/C Ratio (Volume)"
          value={formatRatio(levels.put_call_ratio_volume)}
          accent="var(--accent-purple)"
          sub={
            levels.total_put_volume != null && levels.total_call_volume != null
              ? `${formatGamma(levels.total_put_volume)}P / ${formatGamma(levels.total_call_volume)}C`
              : null
          }
          className="levels-pc-volume--mobile"
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
          accent={flipDistAccent(flipDist)}
          sub={flipDist != null ? `${((flipDist / spotPrice) * 100).toFixed(2)}%` : null}
          bold
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
          className="levels-pc-volume--desktop"
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
                className="expiration-picker"
                id="expiration-select"
                value={selectedExpiration || ''}
                onChange={(e) => onExpirationChange?.(e.target.value)}
                style={{
                  background: 'var(--bg-primary)',
                  color: 'var(--text-primary)',
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
