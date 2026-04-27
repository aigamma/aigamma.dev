import { useMemo } from 'react';
import {
  percentileRank,
  trailingCloses,
  termStructureMetrics,
} from '../../lib/vix-models';

// Dense header pill grid for /vix. Mirrors the LevelsPanel pattern from the
// main dashboard: each cell is a single quantitative value with a short
// caption underneath. Cells are color-coded by percentile rank against the
// trailing 252-day window so the eye reads regime context without parsing
// the percentage. Friday close is the as-of timestamp on weekend visits.
//
// Cells:
//   1. VIX  — spot level + 1y percentile rank
//   2. VIX1D — 1-day vol + ratio to VIX
//   3. VIX9D — 9-day vol
//   4. VIX3M — 3-month vol
//   5. VIX6M — 6-month vol
//   6. VIX1Y — 1-year vol (long-end of Cboe-published curve)
//   7. VVIX — vol of vol + 1y percentile rank
//   8. SKEW — Cboe SKEW index, color thresholds at 130/140/150
//   9. SDEX — Nations SkewDex
//  10. Term Slope — VIX3M / VIX rendered as a binary regime label
//      (Contango / Backwardation) plus percent spread |ratio − 1| × 100%.
//      The earlier 3-decimal ratio gave false precision to a metric whose
//      load-bearing read is "is the curve sloping up or down" — the regime
//      word + a single integer percent communicates the same information
//      without inviting the reader to over-parse the second decimal.
//
// Removed cells (history): "Curvature" (the (VIX9D + VIX3M)/2 − VIX
// butterfly of the front of the term structure) — Eric flagged that he
// did not recognize it as a recognized vol-trader vocabulary item, and
// the pill displayed a 2-decimal scalar with arbitrary ±0.3 thresholds
// that had no empirical calibration. The Term Structure chart further
// down the page already conveys the convexity of the curve in shape;
// reducing it to a third decimal of a butterfly was redundant and read
// as false precision.

function PillCell({ label, value, sub, tone = 'neutral', title }) {
  const toneColor = TONE[tone] || 'var(--text-primary)';
  return (
    <div className="vix-pill" title={title}>
      <div className="vix-pill__label">{label}</div>
      <div
        className="vix-pill__value"
        style={{ color: toneColor }}
      >
        {value}
      </div>
      {sub && <div className="vix-pill__sub">{sub}</div>}
    </div>
  );
}

const TONE = {
  neutral: 'var(--text-primary)',
  green: '#04A29F',
  amber: 'var(--accent-amber)',
  coral: 'var(--accent-coral)',
  purple: 'var(--accent-purple)',
  blue: 'var(--accent-blue)',
};

function pctTone(rank) {
  if (rank == null) return 'neutral';
  if (rank >= 90) return 'coral';
  if (rank >= 70) return 'amber';
  if (rank >= 30) return 'neutral';
  if (rank >= 10) return 'green';
  return 'green';
}

function skewTone(level) {
  if (level == null) return 'neutral';
  if (level >= 150) return 'coral';
  if (level >= 140) return 'amber';
  if (level >= 130) return 'neutral';
  return 'green';
}

function fmt(n, dp = 2) {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toFixed(dp);
}

function fmtPct(n, dp = 1) {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(dp)}%`;
}

function fmtRank(rank) {
  if (rank == null) return '—';
  return `${rank.toFixed(0)}p 1y`;
}

export default function VixHeaderProfile({ data }) {
  const cells = useMemo(() => {
    if (!data) return null;
    const { series, latest } = data;
    const last = (sym) => latest?.[sym]?.close ?? null;

    // 1y window for percentile context — last 252 closes per symbol.
    const window = (sym) => trailingCloses(series?.[sym] || [], 252);

    const ts = termStructureMetrics({
      VIX1D: last('VIX1D'),
      VIX: last('VIX'),
      VIX3M: last('VIX3M'),
    });

    const vixRank = percentileRank(last('VIX'), window('VIX'));
    const vvixRank = percentileRank(last('VVIX'), window('VVIX'));
    const skewRank = percentileRank(last('SKEW'), window('SKEW'));

    return {
      VIX: { value: last('VIX'), rank: vixRank },
      VIX1D: { value: last('VIX1D'), ratio: ts.frontRatio },
      VIX9D: { value: last('VIX9D') },
      VIX3M: { value: last('VIX3M') },
      VIX6M: { value: last('VIX6M') },
      VIX1Y: { value: last('VIX1Y') },
      VVIX: { value: last('VVIX'), rank: vvixRank },
      SKEW: { value: last('SKEW'), rank: skewRank },
      SDEX: { value: last('SDEX') },
      contango: ts.contangoRatio,
    };
  }, [data]);

  if (!data || !cells) {
    return (
      <div className="card vix-header-card">
        <div className="vix-pill-grid">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="vix-pill vix-pill--skeleton" />
          ))}
        </div>
      </div>
    );
  }

  const asOf = data.asOf || '—';

  return (
    <div className="card vix-header-card">
      <div className="vix-header-meta">
        <div className="vix-header-meta__title">VIX Snapshot</div>
        <div className="vix-header-meta__asof">As of close · {asOf}</div>
      </div>
      <div className="vix-pill-grid">
        <PillCell
          label="VIX"
          value={fmt(cells.VIX.value)}
          sub={fmtRank(cells.VIX.rank)}
          tone={pctTone(cells.VIX.rank)}
          title="Cboe Volatility Index — 30-day implied vol on SPX from option mid prices. Color reflects 1-year percentile rank."
        />
        <PillCell
          label="VIX1D"
          value={fmt(cells.VIX1D.value)}
          sub={cells.VIX1D.ratio != null ? `${(cells.VIX1D.ratio * 100).toFixed(0)}% of VIX` : '—'}
          tone={cells.VIX1D.ratio != null && cells.VIX1D.ratio > 1.05 ? 'coral' : 'neutral'}
          title="1-day VIX (constant-maturity 1-day implied vol). Ratio > 1.0 of VIX flags imminent event-day repricing."
        />
        <PillCell
          label="VIX9D"
          value={fmt(cells.VIX9D.value)}
          title="9-day constant-maturity implied vol. The shortest steady term-structure point Cboe publishes."
        />
        <PillCell
          label="VIX3M"
          value={fmt(cells.VIX3M.value)}
          title="3-month constant-maturity implied vol. The conventional benchmark for term-structure shape."
        />
        <PillCell
          label="VIX6M"
          value={fmt(cells.VIX6M.value)}
          title="6-month constant-maturity implied vol."
        />
        <PillCell
          label="VIX1Y"
          value={fmt(cells.VIX1Y.value)}
          title="1-year constant-maturity implied vol on SPX. Long-end of the published Cboe vol term structure."
        />
        <PillCell
          label="VVIX"
          value={fmt(cells.VVIX.value, 1)}
          sub={fmtRank(cells.VVIX.rank)}
          tone={pctTone(cells.VVIX.rank)}
          title="Vol-of-vol: implied vol on the VIX itself. Elevated VVIX with suppressed VIX is the textbook complacency-before-expansion tell."
        />
        <PillCell
          label="SKEW"
          value={fmt(cells.SKEW.value, 1)}
          sub={fmtRank(cells.SKEW.rank)}
          tone={skewTone(cells.SKEW.value)}
          title="Cboe SKEW Index: fat-tail premium from out-of-the-money SPX puts. >150 = crash-pricing, >140 = elevated tail premium, ~120 = normal."
        />
        <PillCell
          label="SDEX"
          value={fmt(cells.SDEX.value, 1)}
          tone="neutral"
          title="Nations SkewDex: alternative skewness construction. Cross-validates the Cboe SKEW reading via a different methodology."
        />
        <PillCell
          label="Term Slope"
          value={cells.contango != null
            ? `${cells.contango >= 1 ? 'Contango' : 'Backwardation'} (${Math.round(Math.abs(cells.contango - 1) * 100)}%)`
            : '—'}
          tone={cells.contango != null
            ? cells.contango >= 1 ? 'green' : 'coral'
            : 'neutral'}
          title="VIX3M ÷ VIX. Above 1.0 = contango (curve sloping up, calm regime). Below 1.0 = backwardation (curve sloping down, urgent near-term vol). The percent reads as |ratio − 1| × 100%."
        />
      </div>
    </div>
  );
}
