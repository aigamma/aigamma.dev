import { useEffect, useMemo, useState } from 'react';

// SPX intraday seasonality grid. Renders the /api/seasonality payload as
// a bordered cell grid: a row-label column on the left, 13 time-bucket
// columns (10:00 through 4:00 in 30-minute steps), an averages section
// showing rolling 5 / 10 / 20 / 30 / 40 day means at the top, and an
// individual-days section below listing the N most recent trading
// sessions. Each cell's background is a deep, saturated dark green or
// red whose lightness scales with the absolute magnitude of the cell's
// value, calibrated so a single white numeric ink reads on every cell
// with ≥6:1 contrast — passing WCAG AA across the full range.

// The deep-color endpoints were picked for two properties simultaneously:
// they're saturated enough to read as unambiguous "green/up" and
// "red/down" hue cues, and dark enough that the cell never gets bright
// enough to fight white text. Pure accent-green (#2ecc71) and
// accent-coral (#e74c3c) sit at sRGB luminance ≈ 0.55 / 0.30, where
// white-on-color drops to ~1.7:1 / ~3:1 — the reason the previous
// gradient had to flip ink to dark on saturated cells. The new targets
// land at luminance ≈ 0.118 / 0.066, giving white contrast 6.25:1 and
// 9.05:1 respectively.
const BG_NEUTRAL = { r: 20, g: 24, b: 32 }; // matches --bg-card #141820
const GREEN_DEEP = { r: 15, g: 111, b: 55 }; // #0f6f37 — deep forest
const RED_DEEP = { r: 140, g: 32, b: 48 }; //   #8c2030 — deep crimson

// The "saturation anchor" — the value at which a cell reaches the
// deepest shade. 0.6% is typical for a well-scoped 30-min SPX move on
// a normal trading day; anything above that caps out, so wide-range
// sessions don't paint every cell at full saturation.
const MAG_ANCHOR_PCT = 0.6;
// Floor and ceiling for the neutral→target interpolation factor. The
// non-zero floor keeps even near-zero cells faintly tinted toward
// their sign, so a glance at the grid still reads direction without
// having to parse the number; the ceiling lands a full-magnitude cell
// exactly on the deep target, preserving the AA contrast guarantee.
const MIN_INTERP = 0.18;
const MAX_INTERP = 1.0;

function formatCell(pct) {
  if (pct == null || !Number.isFinite(pct)) return '—';
  // Match the reference grid's precision: two decimal places, with a
  // leading sign only on non-zero values. Zero renders as "0%" without
  // a percent-point decimal to reduce visual noise on flat cells.
  const abs = Math.abs(pct);
  if (abs < 0.005) return '0%';
  const signed = (pct >= 0 ? '' : '-') + abs.toFixed(2) + '%';
  return signed;
}

function cellStyle(pct) {
  if (pct == null || !Number.isFinite(pct)) {
    // Missing-data cells: leave the card surface showing through, in
    // muted secondary ink — matches the rest of the project's no-data
    // treatment and signals "absent" rather than "zero".
    return { background: 'transparent', color: 'var(--text-secondary)' };
  }
  const mag = Math.min(Math.abs(pct) / MAG_ANCHOR_PCT, 1);
  const t = MIN_INTERP + (MAX_INTERP - MIN_INTERP) * mag;
  const target = pct >= 0 ? GREEN_DEEP : RED_DEEP;
  const r = Math.round(BG_NEUTRAL.r + (target.r - BG_NEUTRAL.r) * t);
  const g = Math.round(BG_NEUTRAL.g + (target.g - BG_NEUTRAL.g) * t);
  const b = Math.round(BG_NEUTRAL.b + (target.b - BG_NEUTRAL.b) * t);
  return {
    background: `rgb(${r}, ${g}, ${b})`,
    color: '#ffffff',
  };
}

// M/D/YYYY rendering to match the reference grid. The row label is
// compact on mobile and stays on a single line.
function formatDateLabel(iso) {
  if (!iso || typeof iso !== 'string') return iso;
  const [y, m, d] = iso.split('-').map((s) => Number(s));
  if (!y || !m || !d) return iso;
  return `${m}/${d}/${y}`;
}

function averageLabel(window) {
  return `${window} Day Avg`;
}

export default function SeasonalityGrid() {
  const [payload, setPayload] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch('/api/seasonality?days=20');
        if (!res.ok) throw new Error(`seasonality fetch failed: ${res.status}`);
        const json = await res.json();
        if (!cancelled) { setPayload(json); setLoading(false); }
      } catch (err) {
        if (!cancelled) { setError(String(err?.message || err)); setLoading(false); }
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  const rows = useMemo(() => {
    if (!payload) return [];
    // Widest window at top — read down from the long-run baseline
    // through progressively more recent regimes to the individual
    // day rows below. Matches the /c/i/ reference grid's ordering.
    const avgRows = [...(payload.averages || [])]
      .sort((a, b) => b.window - a.window)
      .map((a) => ({
        kind: 'avg',
        key: `avg-${a.window}`,
        label: averageLabel(a.window),
        values: a.values,
      }));
    const dayRows = (payload.days || []).map((d) => ({
      kind: 'day',
      key: `day-${d.trading_date}`,
      label: formatDateLabel(d.trading_date),
      values: d.values,
    }));
    return [...avgRows, ...dayRows];
  }, [payload]);

  if (loading) {
    return (
      <div className="card seasonality-card">
        <div className="seasonality-loading">Loading SPX seasonality…</div>
      </div>
    );
  }

  if (error || !payload) {
    return (
      <div className="card seasonality-card">
        <div className="seasonality-error">
          {error || 'No seasonality data available.'}
        </div>
      </div>
    );
  }

  const columns = payload.columns || [];
  const firstDayDivider = (payload.averages || []).length;

  return (
    <div className="card seasonality-card">
      <div className="seasonality-meta">
        <span className="seasonality-ticker">SPX</span>
        <span className="seasonality-asof">
          Through {formatDateLabel(payload.asOf)}
        </span>
      </div>

      <div className="seasonality-scroll">
        <table className="seasonality-grid">
          <thead>
            <tr>
              <th className="seasonality-corner">Date</th>
              {columns.map((c) => (
                <th key={c} className="seasonality-col-head">{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIdx) => (
              <tr
                key={row.key}
                className={
                  rowIdx === firstDayDivider
                    ? 'seasonality-row seasonality-row--first-day'
                    : 'seasonality-row'
                }
              >
                <th
                  scope="row"
                  className={
                    row.kind === 'avg'
                      ? 'seasonality-row-head seasonality-row-head--avg'
                      : 'seasonality-row-head'
                  }
                >
                  {row.label}
                </th>
                {row.values.map((v, i) => (
                  <td key={i} className="seasonality-cell" style={cellStyle(v)}>
                    {formatCell(v)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="seasonality-legend">
        <span className="seasonality-legend-note">
          Each cell is the cumulative % change of SPX at that 30-min bar's close
          versus the prior session's close. Averages are column-wise means over the
          most recent N trading days.
        </span>
      </div>
    </div>
  );
}
