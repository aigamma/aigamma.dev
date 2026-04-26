import { useEffect, useMemo, useRef, useState } from 'react';

// SPX market-cap-weighted heatmap. Each tile is one S&P 500
// constituent; tile area is proportional to the name's float-adjusted
// SPY weight (which IS its SP500 market-cap weight by SPY's index
// methodology). Tiles are grouped into eleven GICS sector regions so a
// reader can read sector composition at a glance and compare relative
// sector size and intra-day breadth side by side.
//
// Color encoding is the day's percent change from previous close:
//   strong red    < -2%
//   light red     -2% .. -0.25%
//   neutral       -0.25% .. +0.25%
//   light green   +0.25% .. +2%
//   strong green  > +2%
// The neutral band is wider than ±0.05% so the bulk of names that move
// only a few basis points read as "no real change today" rather than
// painting the entire grid in faint pastels.
//
// Layout is a nested squarified treemap (Bruls, Huijsing, Van Wijk
// 2000): one outer pass that lays the eleven sectors in the page
// rectangle sized by sector total weight, then one inner pass per
// sector that lays its constituents in the sector rectangle sized by
// individual weight. Squarification minimises the worst aspect ratio
// of any tile, which in practice keeps tiles closer to square than
// strip / slice-and-dice algorithms — the right choice when the goal
// is text legibility on every tile rather than fast linear scanning.
//
// Tile typography:
//   ticker  bold, large, always shown
//   pct     smaller, shown only when the tile is wide enough to fit
//   name    full company name shown only on hover via title= tooltip
// The min-width gate on pct is set so small tiles read as "ticker
// only" rather than truncated-mid-string ugliness.
//
// Container sizing: the heatmap consumes the full viewport height
// minus the lab header chrome via 100vh - header math, then ResizeObserver
// tracks the actual rendered box and re-runs squarification on resize
// so a window-resize re-laps the tiles cleanly without holding stale
// dimensions from the initial measure.

const NEUTRAL_BAND_PCT = 0.25;
const STRONG_PCT = 2.0;

const SECTOR_ORDER = [
  'Information Technology',
  'Communication Services',
  'Consumer Discretionary',
  'Financials',
  'Health Care',
  'Industrials',
  'Consumer Staples',
  'Energy',
  'Utilities',
  'Real Estate',
  'Materials',
  'Other',
];

// Header strip background per sector — a desaturated version of the
// page accent palette, chosen so adjacent sector strips read as
// distinct without competing with the red/green tile fills inside.
const SECTOR_HEADER_BG = '#1c2129';
const SECTOR_HEADER_FG = '#a8b0c0';

function pctToColor(pct) {
  if (pct == null || !Number.isFinite(pct)) return '#202531';
  const clipped = Math.max(-STRONG_PCT, Math.min(STRONG_PCT, pct));
  if (Math.abs(clipped) <= NEUTRAL_BAND_PCT) return '#262b35';
  const intensity = (Math.abs(clipped) - NEUTRAL_BAND_PCT) / (STRONG_PCT - NEUTRAL_BAND_PCT);
  // Two-stop ramp anchored at the dark neutral above the band edge
  // (#2a3038 / #382828) and the saturated accent at the strong edge.
  // The neutral end is darker than the bg-card so a positive- or
  // negative-tinted tile sits visually distinct from the surrounding
  // sector header strip without becoming a harsh color block at small
  // moves.
  if (clipped > 0) {
    return mixHex('#2a3038', '#1f8d4f', intensity);
  }
  return mixHex('#382828', '#a23a25', intensity);
}

// Brighter foreground for high-saturation tiles, dimmer for tiles
// near the neutral band. Keeps text legible without painting it as
// pure white on dark gray (washed out) or stark white on saturated red
// (visual fatigue across 500 tiles).
function pctToTextColor(pct) {
  if (pct == null || !Number.isFinite(pct)) return '#6e7686';
  const abs = Math.abs(pct);
  if (abs <= NEUTRAL_BAND_PCT) return '#9ea4b0';
  if (abs >= STRONG_PCT * 0.7) return '#f3f4f6';
  return '#d8dbe2';
}

// Linear hex-channel mixer. Both endpoints are 6-digit #rrggbb. t
// clamps to [0,1].
function mixHex(a, b, t) {
  const c = Math.max(0, Math.min(1, t));
  const ar = parseInt(a.slice(1, 3), 16);
  const ag = parseInt(a.slice(3, 5), 16);
  const ab = parseInt(a.slice(5, 7), 16);
  const br = parseInt(b.slice(1, 3), 16);
  const bg = parseInt(b.slice(3, 5), 16);
  const bb = parseInt(b.slice(5, 7), 16);
  const r = Math.round(ar + (br - ar) * c);
  const g = Math.round(ag + (bg - ag) * c);
  const bl = Math.round(ab + (bb - ab) * c);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${bl.toString(16).padStart(2, '0')}`;
}

// Squarified treemap layout (Bruls, Huijsing, Van Wijk 2000).
// Returns one rect per item: { x, y, w, h, item }. Items must be
// pre-sorted descending by `value`. Container is the rect to fill.
//
// The algorithm grows a "row" of items along the shorter side of the
// remaining container; each new item is added to the row only if doing
// so improves (lowers) the worst aspect ratio of any tile in the row.
// When the new item would make the row's worst ratio worse, the row
// is finalised and laid out; the new item starts a fresh row in the
// remaining sub-container.
function squarify(items, container) {
  if (!items || items.length === 0) return [];
  const total = items.reduce((s, it) => s + Math.max(0, it.value), 0);
  if (total <= 0 || container.w <= 0 || container.h <= 0) return [];

  const out = [];
  let remaining = { ...container, valueLeft: total };
  let queue = items.filter((it) => it.value > 0);

  while (queue.length > 0) {
    const row = [];
    let rowSum = 0;
    const shortSide = Math.min(remaining.w, remaining.h);
    while (queue.length > 0) {
      const next = queue[0];
      const trial = [...row, next];
      const trialSum = rowSum + next.value;
      const worstAfter = worstAspect(trial, trialSum, shortSide, remaining);
      if (row.length > 0 && worstAfter > worstAspect(row, rowSum, shortSide, remaining)) {
        break;
      }
      row.push(next);
      rowSum = trialSum;
      queue.shift();
    }
    layoutRow(row, rowSum, remaining, out);
    remaining = trimContainer(remaining, rowSum);
  }
  return out;
}

// Worst aspect ratio of any tile if the given row is laid out in the
// remaining container's short side. Uses the standard squarified
// formulation: for row-area A laid along short side s with total
// remaining value V_r and remaining area A_r, each tile's two sides
// are A_r * v/V_r / s and s, so aspect = max(s² * v / A, A / (s² * v)).
function worstAspect(row, rowSum, shortSide, remaining) {
  const remArea = remaining.w * remaining.h * (rowSum / remaining.valueLeft);
  if (remArea <= 0 || shortSide <= 0) return Infinity;
  let worst = 0;
  for (const item of row) {
    if (item.value <= 0) continue;
    const tileArea = remArea * (item.value / rowSum);
    const longSide = tileArea / shortSide;
    const r = Math.max(shortSide / longSide, longSide / shortSide);
    if (r > worst) worst = r;
  }
  return worst || Infinity;
}

function layoutRow(row, rowSum, remaining, out) {
  if (row.length === 0 || rowSum <= 0) return;
  const portion = rowSum / remaining.valueLeft;
  const rowArea = remaining.w * remaining.h * portion;

  // The row is laid along the short side; the perpendicular dimension
  // is rowArea / shortSide. Each tile then takes its share of the
  // short-side length.
  const horizontalRow = remaining.w <= remaining.h;
  if (horizontalRow) {
    const rowH = rowArea / remaining.w;
    let cursor = remaining.x;
    for (const item of row) {
      const w = remaining.w * (item.value / rowSum);
      out.push({ x: cursor, y: remaining.y, w, h: rowH, item });
      cursor += w;
    }
  } else {
    const rowW = rowArea / remaining.h;
    let cursor = remaining.y;
    for (const item of row) {
      const h = remaining.h * (item.value / rowSum);
      out.push({ x: remaining.x, y: cursor, w: rowW, h, item });
      cursor += h;
    }
  }
}

function trimContainer(remaining, rowSum) {
  const portion = rowSum / remaining.valueLeft;
  const rowArea = remaining.w * remaining.h * portion;
  const horizontalRow = remaining.w <= remaining.h;
  if (horizontalRow) {
    const rowH = rowArea / remaining.w;
    return {
      x: remaining.x,
      y: remaining.y + rowH,
      w: remaining.w,
      h: remaining.h - rowH,
      valueLeft: remaining.valueLeft - rowSum,
    };
  }
  const rowW = rowArea / remaining.h;
  return {
    x: remaining.x + rowW,
    y: remaining.y,
    w: remaining.w - rowW,
    h: remaining.h,
    valueLeft: remaining.valueLeft - rowSum,
  };
}

// Format helpers
function formatPct(pct) {
  if (pct == null || !Number.isFinite(pct)) return '—';
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(2)}%`;
}

function formatPrice(p) {
  if (p == null || !Number.isFinite(p)) return '—';
  if (p >= 1000) return p.toFixed(0);
  if (p >= 100) return p.toFixed(1);
  return p.toFixed(2);
}

export default function SpxHeatmap() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const wrapRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/heatmap')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j) => {
        if (!cancelled) setData(j);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e?.message || e));
      });
    return () => { cancelled = true; };
  }, []);

  // Track the container's rendered box. ResizeObserver fires once on
  // mount with the initial layout, then again on any window-resize or
  // parent layout shift, so the treemap stays sharp across viewport
  // changes without manually tracking window resize events.
  useEffect(() => {
    if (!wrapRef.current || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const cr = entry.contentRect;
        setSize({ w: Math.max(0, Math.floor(cr.width)), h: Math.max(0, Math.floor(cr.height)) });
      }
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  const layout = useMemo(() => {
    if (!data || !data.tiles || size.w < 50 || size.h < 50) return null;

    // Group tiles by sector and sort sectors in the canonical reading
    // order (mega-sectors first, then mid, then small). Within each
    // sector, sort tickers by weight descending so squarify gets its
    // expected input order.
    const bySector = new Map();
    for (const t of data.tiles) {
      const key = SECTOR_ORDER.includes(t.sector) ? t.sector : 'Other';
      if (!bySector.has(key)) bySector.set(key, []);
      bySector.get(key).push(t);
    }
    for (const [, list] of bySector) {
      list.sort((a, b) => b.weight - a.weight);
    }

    const sectors = SECTOR_ORDER
      .filter((s) => bySector.has(s))
      .map((s) => {
        const tickers = bySector.get(s);
        const totalWeight = tickers.reduce((sum, t) => sum + t.weight, 0);
        return { sector: s, tickers, totalWeight, value: totalWeight };
      });

    // Outer treemap: lay out sectors in the full container.
    const sectorRects = squarify(sectors, { x: 0, y: 0, w: size.w, h: size.h });

    // Inner treemap: each sector rect gets a header strip (sector
    // label + total weight + count) and a body region for its tickers.
    const HEADER_H = 22;
    const PAD = 1;
    const renderTiles = [];
    const sectorOverlays = [];
    for (const rect of sectorRects) {
      const { item, x, y, w, h } = rect;
      const headerH = h > HEADER_H * 2.4 ? HEADER_H : 0;
      sectorOverlays.push({
        sector: item.sector,
        totalWeight: item.totalWeight,
        tickerCount: item.tickers.length,
        x: x + PAD,
        y: y + PAD,
        w: Math.max(0, w - PAD * 2),
        h: headerH,
      });
      const innerRect = {
        x: x + PAD,
        y: y + PAD + headerH,
        w: Math.max(0, w - PAD * 2),
        h: Math.max(0, h - PAD * 2 - headerH),
      };
      const inner = squarify(
        item.tickers.map((t) => ({ ...t, value: t.weight })),
        innerRect,
      );
      for (const tile of inner) {
        renderTiles.push({
          x: tile.x,
          y: tile.y,
          w: tile.w,
          h: tile.h,
          item: tile.item,
        });
      }
    }
    return { renderTiles, sectorOverlays };
  }, [data, size]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '0.5rem',
        height: '100%',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '1rem',
          flexWrap: 'wrap',
          fontFamily: 'Courier New, monospace',
          fontSize: '0.75rem',
          letterSpacing: '0.08em',
          color: 'var(--text-secondary)',
          textTransform: 'uppercase',
        }}
      >
        <span>
          {data
            ? `S&P 500 · ${data.pricedCount}/${data.count} priced · ${data.mode === 'sector-etf-fallback' ? 'sector ETFs (fallback)' : 'live'}`
            : 'Loading…'}
        </span>
        <span style={{ color: 'var(--text-secondary)' }}>
          {data?.sourceUpdated
            ? `As of ${new Date(data.sourceUpdated).toLocaleString('en-US', { timeZone: 'America/New_York', timeZoneName: 'short' })}`
            : data?.asOf || ''}
        </span>
      </div>

      {data?.mode === 'sector-etf-fallback' && (
        <div
          style={{
            background: '#3a2a1a',
            border: '1px solid #5a4220',
            color: '#e8c890',
            fontFamily: 'Courier New, monospace',
            fontSize: '0.78rem',
            padding: '0.4rem 0.6rem',
            borderRadius: '3px',
          }}
        >
          Live constituent prices unavailable from Massive (
          {data.massiveFailure || 'no detail'}). Showing eleven sector ETFs
          from ThetaData EOD as a fallback view. Each tile sums its sector's
          true SP500 market-cap weight.
        </div>
      )}

      {error && (
        <div
          style={{
            color: 'var(--accent-coral)',
            fontFamily: 'Courier New, monospace',
            padding: '1rem',
          }}
        >
          Error loading heatmap: {error}
        </div>
      )}

      <div
        ref={wrapRef}
        style={{
          position: 'relative',
          flex: '1 1 auto',
          minHeight: '60vh',
          background: 'var(--bg-primary)',
          borderRadius: '3px',
          overflow: 'hidden',
        }}
      >
        {layout?.sectorOverlays.map((s) => (
          <div
            key={`hdr-${s.sector}`}
            style={{
              position: 'absolute',
              left: s.x,
              top: s.y,
              width: s.w,
              height: s.h,
              background: SECTOR_HEADER_BG,
              color: SECTOR_HEADER_FG,
              fontFamily: 'Courier New, monospace',
              fontSize: '0.68rem',
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              display: s.h > 0 ? 'flex' : 'none',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '0 0.45rem',
              boxSizing: 'border-box',
              pointerEvents: 'none',
            }}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {s.sector}
            </span>
            <span style={{ color: '#6c7384', flexShrink: 0, marginLeft: '0.5rem' }}>
              {s.totalWeight.toFixed(1)}%
            </span>
          </div>
        ))}

        {layout?.renderTiles.map((tile) => {
          const t = tile.item;
          const bg = pctToColor(t.pctChange);
          const fg = pctToTextColor(t.pctChange);
          const showPct = tile.w > 44 && tile.h > 30;
          const showName = tile.w > 110 && tile.h > 56;
          const ticker = t.symbol;
          return (
            <div
              key={t.symbol}
              title={`${t.symbol} · ${t.name}\n${t.sector}\nWeight ${t.weight.toFixed(3)}%\n${formatPct(t.pctChange)} · last ${formatPrice(t.last)} · prev ${formatPrice(t.prev)}`}
              style={{
                position: 'absolute',
                left: tile.x + 1,
                top: tile.y + 1,
                width: Math.max(0, tile.w - 2),
                height: Math.max(0, tile.h - 2),
                background: bg,
                color: fg,
                fontFamily: 'Courier New, monospace',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                alignItems: 'center',
                overflow: 'hidden',
                cursor: 'default',
                boxSizing: 'border-box',
                padding: '2px',
              }}
            >
              <span
                style={{
                  fontWeight: 700,
                  fontSize: Math.max(8, Math.min(20, Math.sqrt(tile.w * tile.h) / 5.5)) + 'px',
                  lineHeight: 1.05,
                  textAlign: 'center',
                  whiteSpace: 'nowrap',
                  maxWidth: '100%',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {ticker}
              </span>
              {showPct && (
                <span
                  style={{
                    fontSize: Math.max(7, Math.min(13, Math.sqrt(tile.w * tile.h) / 8)) + 'px',
                    opacity: 0.92,
                    marginTop: '1px',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {formatPct(t.pctChange)}
                </span>
              )}
              {showName && (
                <span
                  style={{
                    fontSize: Math.max(6, Math.min(10, Math.sqrt(tile.w * tile.h) / 11)) + 'px',
                    opacity: 0.66,
                    marginTop: '1px',
                    maxWidth: '95%',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {t.name}
                </span>
              )}
            </div>
          );
        })}

        {data && !layout && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-secondary)',
              fontFamily: 'Courier New, monospace',
              fontSize: '0.85rem',
            }}
          >
            Sizing canvas…
          </div>
        )}

        {!data && !error && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-secondary)',
              fontFamily: 'Courier New, monospace',
              fontSize: '0.85rem',
            }}
          >
            Loading constituents…
          </div>
        )}
      </div>
    </div>
  );
}
