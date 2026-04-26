import { useEffect, useMemo, useState } from 'react';

// SPX seasonality grid. Three views, switched by the pill row at the top
// of the card and served by the same Netlify function (/api/seasonality)
// keyed on ?view=:
//
//   intraday — bordered cell grid: row-label column on the left, 13 30-min
//     bucket columns (10:00 → 4:00), an averages section at the top showing
//     rolling 5/10/20/30/40 day means, and the most recent N trading days
//     listed individually below.
//
//   daily — rows are ISO weeks (newest first), columns are Mon-Fri. Each
//     cell is the close-to-close % return for that day. NYSE holidays
//     (weekdays absent from daily_volatility_stats) render as gray "—"
//     cells so the reader can see the calendar shape of the week. Future
//     weekdays (today is Tue → Wed/Thu/Fri haven't happened yet) render
//     as blank "·" cells. The averages section above shows the rolling
//     mean return for each day-of-week over the last N weeks.
//
//   weekly — rows are calendar years (newest first), columns are ISO weeks
//     1..max. Each cell is the weekly return (last close in week / last
//     close in prior week - 1) * 100. The "All Years" row above is the
//     mean return for each week-of-year across every year present — the
//     headline year-over-year seasonality signal.
//
// Color encoding is shared across all three views: deep forest for
// positive cells, deep crimson for negative, lightness scaled with the
// absolute magnitude relative to the view's typical-move anchor (so a
// "big move" feels equally saturated whether it's a 0.6% half-hour, a
// 1.2% day, or a 2.5% week). White ink on every saturated cell to keep
// WCAG AA contrast across the full range.

const BG_NEUTRAL = { r: 20, g: 24, b: 32 }; // matches --bg-card #141820
const GREEN_DEEP = { r: 15, g: 111, b: 55 }; // #0f6f37 — deep forest
const RED_DEEP = { r: 140, g: 32, b: 48 }; //   #8c2030 — deep crimson

// Per-view magnitude anchors. The value at which a cell reaches the
// deepest shade. Calibrated to the typical scale of a strong move at
// each timeframe so "saturated" reads as "big move" consistently:
//   intraday — 0.6% is a typical well-scoped 30-min cumulative move
//   daily   — 1.2% is a roughly one-sigma close-to-close move on SPX
//   weekly  — 2.5% is a roughly one-sigma weekly move on SPX
const MAG_ANCHORS = { intraday: 0.6, daily: 1.2, weekly: 2.5 };
// Floor and ceiling for the neutral→target interpolation factor. The
// non-zero floor keeps even near-zero cells faintly tinted toward
// their sign, so a glance at the grid still reads direction without
// having to parse the number; the ceiling lands a full-magnitude cell
// exactly on the deep target, preserving the AA contrast guarantee.
const MIN_INTERP = 0.18;
const MAX_INTERP = 1.0;

const VIEWS = [
  { id: 'intraday', label: 'Intraday' },
  { id: 'daily', label: 'Daily' },
  { id: 'weekly', label: 'Weekly' },
];

function formatCell(pct) {
  if (pct == null || !Number.isFinite(pct)) return '—';
  const abs = Math.abs(pct);
  if (abs < 0.005) return '0%';
  return (pct >= 0 ? '' : '-') + abs.toFixed(2) + '%';
}

function dataCellStyle(pct, anchor) {
  const mag = Math.min(Math.abs(pct) / anchor, 1);
  const t = MIN_INTERP + (MAX_INTERP - MIN_INTERP) * mag;
  const target = pct >= 0 ? GREEN_DEEP : RED_DEEP;
  const r = Math.round(BG_NEUTRAL.r + (target.r - BG_NEUTRAL.r) * t);
  const g = Math.round(BG_NEUTRAL.g + (target.g - BG_NEUTRAL.g) * t);
  const b = Math.round(BG_NEUTRAL.b + (target.b - BG_NEUTRAL.b) * t);
  return { background: `rgb(${r}, ${g}, ${b})`, color: '#ffffff' };
}

// Renders one cell. Three kinds: numeric data, holiday (gray), and
// future/no-data (blank). The "no_data" case is used for cells where the
// underlying market hasn't closed yet (today is Tue → Wed/Thu/Fri have
// no data) or where the leading edge of the data range has no prior
// close to compute against. "holiday" is reserved for weekdays the NYSE
// was closed (the cell exists conceptually but is intentionally blank).
function Cell({ cell, anchor }) {
  if (!cell) return <td className="seasonality-cell seasonality-cell--blank">·</td>;
  if (cell.kind === 'holiday') {
    return (
      <td
        className="seasonality-cell seasonality-cell--holiday"
        title="NYSE closed (holiday)"
      >
        —
      </td>
    );
  }
  if (cell.kind === 'future' || cell.kind === 'no_data') {
    return <td className="seasonality-cell seasonality-cell--blank">·</td>;
  }
  return (
    <td className="seasonality-cell" style={dataCellStyle(cell.value, anchor)}>
      {formatCell(cell.value)}
    </td>
  );
}

// Numeric "value" version for the legacy intraday payload (whose rows are
// raw value arrays, not {kind, value} cell objects). Accepts a number or
// null/undefined and renders the same chrome as Cell would for the
// equivalent data/no_data case.
function NumericCell({ pct, anchor }) {
  if (pct == null || !Number.isFinite(pct)) {
    return (
      <td className="seasonality-cell" style={{ background: 'transparent', color: 'var(--text-secondary)' }}>
        —
      </td>
    );
  }
  return (
    <td className="seasonality-cell" style={dataCellStyle(pct, anchor)}>
      {formatCell(pct)}
    </td>
  );
}

function formatDateLabel(iso) {
  if (!iso || typeof iso !== 'string') return iso;
  const [y, m, d] = iso.split('-').map((s) => Number(s));
  if (!y || !m || !d) return iso;
  return `${m}/${d}/${y}`;
}

function averageLabel(window, suffix) {
  return `${window} ${suffix}`;
}

export default function SeasonalityGrid() {
  const [view, setView] = useState('intraday');
  const [payloadByView, setPayloadByView] = useState({});
  const [errorByView, setErrorByView] = useState({});
  const [loadingByView, setLoadingByView] = useState({ intraday: true });

  // Fetch the active view on mount and whenever the user switches. Keep
  // previously-loaded payloads in state so re-toggling is instantaneous
  // and the user's edge-cached prior view doesn't have to round-trip.
  useEffect(() => {
    if (payloadByView[view]) return;
    let cancelled = false;
    setLoadingByView((s) => ({ ...s, [view]: true }));
    (async () => {
      try {
        const params = new URLSearchParams({ view });
        if (view === 'intraday') params.set('days', '20');
        const res = await fetch(`/api/seasonality?${params}`);
        if (!res.ok) throw new Error(`seasonality fetch failed: ${res.status}`);
        const json = await res.json();
        if (cancelled) return;
        setPayloadByView((s) => ({ ...s, [view]: json }));
        setLoadingByView((s) => ({ ...s, [view]: false }));
      } catch (err) {
        if (cancelled) return;
        setErrorByView((s) => ({ ...s, [view]: String(err?.message || err) }));
        setLoadingByView((s) => ({ ...s, [view]: false }));
      }
    })();
    return () => { cancelled = true; };
  }, [view, payloadByView]);

  const payload = payloadByView[view];
  const error = errorByView[view];
  const loading = loadingByView[view];
  const anchor = MAG_ANCHORS[view];

  return (
    <div className="card seasonality-card">
      <div className="seasonality-toolbar">
        <div className="seasonality-meta">
          <span className="seasonality-ticker">SPX</span>
          {payload?.asOf && (
            <span className="seasonality-asof">Through {formatDateLabel(payload.asOf)}</span>
          )}
        </div>
        <div className="seasonality-toggle" role="tablist" aria-label="Seasonality view">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              role="tab"
              aria-selected={view === v.id}
              className={
                view === v.id
                  ? 'seasonality-toggle__pill seasonality-toggle__pill--active'
                  : 'seasonality-toggle__pill'
              }
              onClick={() => setView(v.id)}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div className="seasonality-loading">Loading SPX seasonality…</div>
      )}
      {!loading && (error || !payload) && (
        <div className="seasonality-error">{error || 'No seasonality data available.'}</div>
      )}
      {!loading && payload && view === 'intraday' && (
        <IntradayGrid payload={payload} anchor={anchor} />
      )}
      {!loading && payload && view === 'daily' && (
        <DailyGrid payload={payload} anchor={anchor} />
      )}
      {!loading && payload && view === 'weekly' && (
        <WeeklyGrid payload={payload} anchor={anchor} />
      )}

      <div className="seasonality-legend">
        <Legend view={view} />
      </div>
    </div>
  );
}

function IntradayGrid({ payload, anchor }) {
  const rows = useMemo(() => {
    const avgRows = [...(payload.averages || [])]
      .sort((a, b) => b.window - a.window)
      .map((a) => ({
        kind: 'avg',
        key: `avg-${a.window}`,
        label: averageLabel(a.window, 'Day Avg'),
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

  const columns = payload.columns || [];
  const firstDayDivider = (payload.averages || []).length;

  return (
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
                <NumericCell key={i} pct={v} anchor={anchor} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DailyGrid({ payload, anchor }) {
  const columns = payload.columns || [];
  const weekRows = payload.weeks || [];
  const avgRows = [...(payload.averages || [])]
    .sort((a, b) => b.window - a.window)
    .map((a) => ({
      key: `avg-${a.window}`,
      label: averageLabel(a.window, 'Wk Avg'),
      values: a.values,
    }));
  const firstWeekDivider = avgRows.length;

  return (
    <div className="seasonality-scroll">
      <table className="seasonality-grid seasonality-grid--daily">
        <thead>
          <tr>
            <th className="seasonality-corner">Week</th>
            {columns.map((c) => (
              <th key={c} className="seasonality-col-head">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {avgRows.map((row) => (
            <tr key={row.key} className="seasonality-row">
              <th scope="row" className="seasonality-row-head seasonality-row-head--avg">
                {row.label}
              </th>
              {row.values.map((v, i) => (
                <NumericCell key={i} pct={v} anchor={anchor} />
              ))}
            </tr>
          ))}
          {weekRows.map((week, idx) => (
            <tr
              key={week.week_start}
              className={
                idx === 0 && firstWeekDivider > 0
                  ? 'seasonality-row seasonality-row--first-day'
                  : 'seasonality-row'
              }
            >
              <th scope="row" className="seasonality-row-head">{week.week_label}</th>
              {week.cells.map((c, i) => (
                <Cell key={i} cell={c} anchor={anchor} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// WEEKLY view, transposed: rows are ISO weeks W01..Wmax, columns are
// the calendar years present in the data (newest year on the left,
// immediately after the "Avg" summary column so the current year and the
// year-over-year baseline are both visible without scrolling). Reading
// across one row gives "what did week N return in each year, and what's
// the typical?". Reading down one column gives "what did 2024 do
// week-by-week, including the weeks where current year hasn't traded
// yet". Both are useful and the transpose lets the reader scroll
// vertically through the calendar instead of horizontally — which on a
// 27" desktop is the right axis for 52 entries.
function WeeklyGrid({ payload, anchor }) {
  const weekLabels = payload.columns || [];   // ['W01', 'W02', ..., 'Wmax']
  const yearRows = payload.years || [];       // [{year, cells: [...for each week]}]
  const avgValues = (payload.averages?.[0]?.values) || [];  // 1 entry per week
  // Years displayed left-to-right newest-first. The server already sorts
  // years descending so the order is preserved as-is.
  const yearCols = yearRows.map((y) => ({ year: y.year, cells: y.cells }));

  return (
    <div className="seasonality-scroll">
      <table className="seasonality-grid seasonality-grid--weekly">
        <thead>
          <tr>
            <th className="seasonality-corner">Week</th>
            <th className="seasonality-col-head seasonality-col-head--avg">Avg</th>
            {yearCols.map((col) => (
              <th key={col.year} className="seasonality-col-head">{col.year}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weekLabels.map((weekLabelText, weekIdx) => (
            <tr key={weekLabelText} className="seasonality-row">
              <th scope="row" className="seasonality-row-head">{weekLabelText}</th>
              <NumericCell pct={avgValues[weekIdx]} anchor={anchor} />
              {yearCols.map((col) => (
                <Cell key={col.year} cell={col.cells[weekIdx]} anchor={anchor} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Legend({ view }) {
  if (view === 'intraday') {
    return (
      <span className="seasonality-legend-note">
        Each cell is SPX's cumulative % change at that 30-min bar's close versus
        the prior session's close. Averages are column-wise means over the most
        recent N trading days.
      </span>
    );
  }
  if (view === 'daily') {
    return (
      <span className="seasonality-legend-note">
        Each cell is SPX's close-to-close % return for that day. Gray cells are
        NYSE holidays. Averages are the mean return for each weekday over the
        most recent N weeks (holidays excluded from the sample).
      </span>
    );
  }
  return (
    <span className="seasonality-legend-note">
      Each cell is the weekly % return (last close in the ISO week vs. last
      close in the prior ISO week). The "All Years" row is the mean return for
      that week-of-year across every available year — the year-over-year
      seasonality signal.
    </span>
  );
}
