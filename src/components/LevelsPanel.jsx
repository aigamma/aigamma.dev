function formatCurrency(value) {
  if (value == null) return '—';
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatStrike(value) {
  if (value == null) return '—';
  return value.toFixed(2);
}

function formatInteger(value) {
  if (value == null) return '—';
  return Math.round(value).toLocaleString('en-US');
}

function formatGamma(value) {
  if (value == null) return '—';
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(2)}K`;
  return value.toFixed(0);
}

function formatPercent(value, digits = 2) {
  if (value == null) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

function formatRatio(value) {
  if (value == null) return '—';
  return value.toFixed(2);
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

function daysToExpiration(expirationDate, capturedAt) {
  if (!expirationDate || !capturedAt) return null;
  const target = new Date(`${expirationDate}T16:00:00-04:00`).getTime();
  const ref = new Date(capturedAt).getTime();
  if (Number.isNaN(target) || Number.isNaN(ref)) return null;
  const diffDays = (target - ref) / (1000 * 60 * 60 * 24);
  return Math.max(0, diffDays);
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
          fontSize: '0.7rem',
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
        <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', marginTop: '0.15rem' }}>
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

const ROW_GRID = {
  display: 'grid',
  gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
  gap: '1rem',
};

export default function LevelsPanel({ levels, spotPrice, prevClose, expirationMetrics, expirations, selectedExpiration, onExpirationChange, capturedAt }) {
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
      <div style={ROW_GRID}>
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
        <Stat label="Spot" value={formatInteger(spotPrice)} accent="var(--accent-blue)" sub={spotDeltaSub(spotPrice, prevClose)} />
        <Stat
          label="Call Wall"
          value={formatInteger(levels.call_wall)}
          accent="var(--accent-green)"
          sub={callWallSub}
        />
      </div>

      <Divider />

      <div style={ROW_GRID}>
        <Stat
          label="Expected Move"
          value={expMoveDollar != null ? expMoveDollar.toFixed(2) : '—'}
          accent="var(--accent-purple)"
          sub={expMoveSub}
          bold
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
          <div style={ROW_GRID}>
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: '0.7rem',
                  color: 'var(--text-secondary)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  marginBottom: '0.25rem',
                }}
              >
                Expiration
              </div>
              <select
                value={selectedExpiration || ''}
                onChange={(e) => onExpirationChange?.(e.target.value)}
                style={{
                  background: 'var(--bg-primary)',
                  color: 'var(--text-primary)',
                  border: '1px solid var(--bg-card-border)',
                  borderRadius: '4px',
                  padding: '0.35rem 0.5rem',
                  fontFamily: 'Courier New, monospace',
                  fontSize: '0.85rem',
                  width: '100%',
                }}
              >
                {(expirations || []).map((exp) => (
                  <option key={exp} value={exp}>{exp}</option>
                ))}
              </select>
            </div>
            <Stat label="25Δ Put IV" value={formatPercent(relevantMetric.put_25d_iv)} />
            <Stat label="ATM IV" value={formatPercent(relevantMetric.atm_iv)} />
            <Stat label="25Δ Call IV" value={formatPercent(relevantMetric.call_25d_iv)} />
          </div>
        </>
      )}
    </div>
  );
}
