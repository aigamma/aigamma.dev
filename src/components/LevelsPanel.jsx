function formatCurrency(value) {
  if (value == null) return '—';
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatStrike(value) {
  if (value == null) return '—';
  return value.toFixed(2);
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

function formatTilt(value) {
  if (value == null) return '—';
  return value.toFixed(3);
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

function Stat({ label, value, accent, sub }) {
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

export default function LevelsPanel({ levels, spotPrice, expirationMetrics, selectedExpiration, capturedAt }) {
  if (!levels) {
    return (
      <div className="card text-muted" style={{ marginBottom: '1rem' }}>
        No computed levels available for this run.
      </div>
    );
  }

  const netGammaColor =
    levels.net_gamma_notional == null
      ? undefined
      : levels.net_gamma_notional >= 0
        ? 'var(--accent-green)'
        : 'var(--accent-coral)';

  const callWallSub = distanceSub(levels.call_wall, spotPrice);
  const putWallSub = distanceSub(levels.put_wall, spotPrice);
  const absGammaSub = distanceSub(levels.abs_gamma_strike, spotPrice);
  const volFlipSub = distanceSub(levels.volatility_flip, spotPrice);
  const maxPainSub = distanceSub(levels.max_pain_strike, spotPrice);

  const pcrOiColor =
    levels.put_call_ratio_oi == null
      ? undefined
      : levels.put_call_ratio_oi >= 1
        ? 'var(--accent-coral)'
        : 'var(--accent-green)';
  const pcrVolColor =
    levels.put_call_ratio_volume == null
      ? undefined
      : levels.put_call_ratio_volume >= 1
        ? 'var(--accent-coral)'
        : 'var(--accent-green)';

  const netVannaColor =
    levels.net_vanna_notional == null
      ? undefined
      : levels.net_vanna_notional >= 0
        ? 'var(--accent-green)'
        : 'var(--accent-coral)';
  const netCharmColor =
    levels.net_charm_notional == null
      ? undefined
      : levels.net_charm_notional >= 0
        ? 'var(--accent-green)'
        : 'var(--accent-coral)';

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

  const hasFlowRow =
    levels.put_call_ratio_oi != null ||
    levels.put_call_ratio_volume != null ||
    levels.net_vanna_notional != null ||
    levels.net_charm_notional != null;

  return (
    <div className="card" style={{ marginBottom: '1rem' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
          gap: '1rem',
        }}
      >
        <Stat label="Spot" value={formatCurrency(spotPrice)} accent="var(--accent-blue)" />
        <Stat
          label="Call Wall"
          value={formatStrike(levels.call_wall)}
          accent="var(--accent-green)"
          sub={callWallSub}
        />
        <Stat
          label="Put Wall"
          value={formatStrike(levels.put_wall)}
          accent="var(--accent-coral)"
          sub={putWallSub}
        />
        <Stat
          label="Max Pain"
          value={formatStrike(levels.max_pain_strike)}
          accent="var(--text-primary)"
          sub={maxPainSub}
        />
        <Stat
          label="Abs Gamma"
          value={formatStrike(levels.abs_gamma_strike)}
          accent="var(--accent-amber)"
          sub={absGammaSub}
        />
        <Stat
          label="Vol Flip"
          value={formatStrike(levels.volatility_flip)}
          accent="var(--accent-amber)"
          sub={volFlipSub}
        />
        <Stat label="Net GEX ($)" value={formatGamma(levels.net_gamma_notional)} accent={netGammaColor} />
        <Stat label="Gamma Tilt" value={formatTilt(levels.gamma_tilt)} />
      </div>

      {hasFlowRow && (
        <>
          <Divider />
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
              gap: '1rem',
            }}
          >
            <Stat
              label="P/C Ratio (OI)"
              value={formatRatio(levels.put_call_ratio_oi)}
              accent={pcrOiColor}
              sub={
                levels.total_put_oi != null && levels.total_call_oi != null
                  ? `${formatGamma(levels.total_put_oi)}P / ${formatGamma(levels.total_call_oi)}C`
                  : null
              }
            />
            <Stat
              label="P/C Ratio (Vol)"
              value={formatRatio(levels.put_call_ratio_volume)}
              accent={pcrVolColor}
              sub={
                levels.total_put_volume != null && levels.total_call_volume != null
                  ? `${formatGamma(levels.total_put_volume)}P / ${formatGamma(levels.total_call_volume)}C`
                  : null
              }
            />
            <Stat
              label="Net Vanna"
              value={formatGamma(levels.net_vanna_notional)}
              accent={netVannaColor}
              sub="∂Δ/∂σ notional"
            />
            <Stat
              label="Net Charm"
              value={formatGamma(levels.net_charm_notional)}
              accent={netCharmColor}
              sub="∂Δ/∂t notional"
            />
          </div>
        </>
      )}

      {relevantMetric && (
        <>
          <Divider />
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
              gap: '1rem',
            }}
          >
            <Stat
              label={`ATM IV (${relevantMetric.expiration_date})`}
              value={formatPercent(relevantMetric.atm_iv)}
            />
            <Stat
              label="Expected Move"
              value={expMoveDollar != null ? `±$${expMoveDollar.toFixed(2)}` : '—'}
              accent="var(--accent-amber)"
              sub={expMoveSub}
            />
            <Stat label="ATM Strike" value={formatStrike(relevantMetric.atm_strike)} />
            <Stat label="Max Pain (exp)" value={formatStrike(relevantMetric.max_pain_strike)} accent="var(--text-primary)" />
            <Stat label="25Δ Put IV" value={formatPercent(relevantMetric.put_25d_iv)} />
            <Stat label="25Δ Call IV" value={formatPercent(relevantMetric.call_25d_iv)} />
          </div>
        </>
      )}
    </div>
  );
}
