import { useEffect, useMemo, useRef, useState } from 'react';

// Options-active heatmap. Renders the top ~250 single-name stocks by
// US options volume as equal-size tiles arranged into eleven GICS
// sector bands, colored by the most-recent-session percent change vs
// the previous close.
//
// Why equal-size and not market-cap-weighted: the project tried a
// market-cap-weighted SP500 treemap first (the conventional finviz /
// Webull / TradingView / thinkorswim layout) but the MAG7 dominance
// problem hijacked the visual — NVDA + AAPL + MSFT + AMZN + AVGO +
// GOOGL/GOOG + META command roughly a third of the index by weight,
// so seven tiles ate a third of the canvas while the other ~496
// names competed for the remaining two-thirds. The equal-size design
// removes the market-cap hierarchy entirely and lets every name in
// the universe command equal visual attention. The trade-off is the
// universe shrinks from ~503 SP500 members to the top ~250 single
// names by options volume — names a vol trader actually trades —
// which is the right narrowing for this project's audience.
//
// Layout: each sector becomes a horizontal band with a thin header
// strip (sector name + ticker count) followed by a CSS grid of
// equal-size tiles. The grid column count is chosen at the page
// level based on viewport width so all sectors share the same tile
// width. Sector bands stack vertically, naturally producing a
// scroll-when-needed page that the user can size to taste — at a
// 1700×900 viewport with column width ~110px (15 columns), the page
// is roughly 1300px tall total, comfortable to scroll within the
// browser viewport.
//
// Color encoding is the day's percent change from previous close:
//   strong red    < -2%
//   light red     -2% .. -0.25%
//   neutral       -0.25% .. +0.25%
//   light green   +0.25% .. +2%
//   strong green  > +2%
// Same encoding the prior market-cap version used; the move is well-
// calibrated for the typical day-to-day range of single-name moves.

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

const SECTOR_HEADER_BG = '#1c2129';
const SECTOR_HEADER_FG = '#a8b0c0';

// Target tile width range. The grid picks a column count that keeps
// each tile somewhere in this range — wider on big monitors, denser
// on smaller viewports. Tile height is fixed so the grid stays
// scannable without text reflow.
const MIN_TILE_WIDTH = 96;
const TARGET_TILE_WIDTH = 118;
const TILE_HEIGHT = 52;
const TILE_GAP = 2;
const SECTOR_HEADER_HEIGHT = 22;
const SECTOR_GAP = 6;

function pctToColor(pct) {
  if (pct == null || !Number.isFinite(pct)) return '#202531';
  const clipped = Math.max(-STRONG_PCT, Math.min(STRONG_PCT, pct));
  if (Math.abs(clipped) <= NEUTRAL_BAND_PCT) return '#262b35';
  const intensity = (Math.abs(clipped) - NEUTRAL_BAND_PCT) / (STRONG_PCT - NEUTRAL_BAND_PCT);
  if (clipped > 0) return mixHex('#2a3038', '#1f8d4f', intensity);
  return mixHex('#382828', '#a23a25', intensity);
}

function pctToTextColor(pct) {
  if (pct == null || !Number.isFinite(pct)) return '#6e7686';
  const abs = Math.abs(pct);
  if (abs <= NEUTRAL_BAND_PCT) return '#9ea4b0';
  if (abs >= STRONG_PCT * 0.7) return '#f3f4f6';
  return '#d8dbe2';
}

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

function formatVolume(v) {
  if (v == null || !Number.isFinite(v) || v <= 0) return '';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(v);
}

// "2026-04-24" → "Apr 24, 2026". Parse at noon UTC to keep the date
// intact regardless of the viewer's local timezone offset (a Date
// constructed from "2026-04-24" alone is interpreted as UTC midnight,
// which can roll back to Apr 23 once toLocaleDateString applies a
// negative-offset locale).
function formatLastUpdated(iso) {
  if (!iso || typeof iso !== 'string') return '';
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export default function SpxHeatmap() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [containerWidth, setContainerWidth] = useState(0);
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

  // Track container width only — height is determined by sector
  // band stacking and the page scrolls naturally if it overflows
  // the viewport. ResizeObserver keeps column count responsive on
  // window resize without manual window-resize listeners.
  useEffect(() => {
    if (!wrapRef.current || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const cr = entry.contentRect;
        setContainerWidth(Math.max(0, Math.floor(cr.width)));
      }
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  // Compute column count from container width. Picks the number of
  // columns that yields a tile width closest to TARGET_TILE_WIDTH
  // while staying above MIN_TILE_WIDTH. Floor at 6 columns so very
  // narrow viewports still produce a recognizable grid rather than
  // collapsing to a single tall column.
  const cols = useMemo(() => {
    if (containerWidth < 50) return 0;
    const usableWidth = containerWidth - TILE_GAP; // account for outer padding
    let best = Math.max(6, Math.round(usableWidth / TARGET_TILE_WIDTH));
    while (best > 6 && (usableWidth - (best - 1) * TILE_GAP) / best < MIN_TILE_WIDTH) {
      best -= 1;
    }
    return best;
  }, [containerWidth]);

  const tileWidth = useMemo(() => {
    if (!cols || containerWidth < 50) return 0;
    return Math.floor((containerWidth - (cols - 1) * TILE_GAP) / cols);
  }, [cols, containerWidth]);

  // Group tiles by sector in canonical order, with an implicit
  // 'Other' bucket for any tile whose sector doesn't match the
  // canonical eleven (shouldn't happen with the current roster
  // generator but the fallback keeps the layout robust).
  const sectorBands = useMemo(() => {
    if (!data?.tiles) return [];
    const bySector = new Map();
    for (const t of data.tiles) {
      const key = SECTOR_ORDER.includes(t.sector) ? t.sector : 'Other';
      if (!bySector.has(key)) bySector.set(key, []);
      bySector.get(key).push(t);
    }
    // Within each sector, sort by SP500 market-cap weight descending
    // so the durable anchor names (NVDA / AAPL / MSFT in Information
    // Technology, AMZN / TSLA in Consumer Discretionary, JPM / V / MA
    // in Financials, …) cluster at the top-left of each sector band.
    // Non-SP500 names (MSTR / IREN / HIMS / TSM / MRVL — the ~50% of
    // the OV roster that doesn't intersect SP500) carry weight=null
    // and sort below all SP500 names in the band, ordered by their
    // existing options-volume rank so the most-active dynamic-tail
    // names still cluster reasonably within their non-SP500 sub-group.
    // Tile sizes remain equal — only the ORDER changes; the visual
    // hierarchy now matches the mental map "big anchors first, hype
    // tail trails" without violating the equal-tile principle that
    // motivated rejecting cap-weighted treemaps in the first place.
    // Symbol-asc tiebreaker keeps the layout deterministic when two
    // tiles share both weight (rare; same SP500 cap-rank) and
    // optionsVolume (rare).
    for (const [, list] of bySector) {
      list.sort((a, b) => {
        const wa = a.weight;
        const wb = b.weight;
        if (wa != null && wb != null) {
          if (wb !== wa) return wb - wa;
        } else if (wa != null) {
          return -1; // SP500-anchored above non-SP500
        } else if (wb != null) {
          return 1;
        }
        const ova = a.optionsVolume || 0;
        const ovb = b.optionsVolume || 0;
        if (ovb !== ova) return ovb - ova;
        return (a.symbol || '').localeCompare(b.symbol || '');
      });
    }
    return SECTOR_ORDER
      .filter((s) => bySector.has(s))
      .map((s) => ({ sector: s, tiles: bySector.get(s) }));
  }, [data]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '0.5rem',
      }}
    >
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
          Live single-name prices unavailable from Massive (
          {data.massiveFailure || 'no detail'}). Showing eleven sector ETFs
          from ThetaData EOD as a fallback view.
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
          background: 'var(--bg-primary)',
          borderRadius: '3px',
          padding: '0',
        }}
      >
        {!data && !error && (
          <div
            style={{
              padding: '4rem 1rem',
              textAlign: 'center',
              color: 'var(--text-secondary)',
              fontFamily: 'Courier New, monospace',
              fontSize: '0.85rem',
            }}
          >
            Loading constituents…
          </div>
        )}

        {data && cols > 0 && tileWidth > 0 && sectorBands.map((band, idx) => {
          const rowCount = Math.ceil(band.tiles.length / cols);
          return (
            <div
              key={band.sector}
              style={{
                marginBottom: idx === sectorBands.length - 1 ? 0 : SECTOR_GAP + 'px',
              }}
            >
              <div
                style={{
                  height: SECTOR_HEADER_HEIGHT,
                  background: SECTOR_HEADER_BG,
                  color: SECTOR_HEADER_FG,
                  fontFamily: 'Courier New, monospace',
                  fontSize: '0.7rem',
                  letterSpacing: '0.1em',
                  textTransform: 'uppercase',
                  display: 'grid',
                  gridTemplateColumns: '1fr auto 1fr',
                  alignItems: 'center',
                  padding: '0 0.5rem',
                  gap: '0.75rem',
                }}
              >
                {/* Three-column grid keeps the per-band layout uniform
                    across all eleven sectors: sector name pinned left,
                    count pinned right, middle column reserved for the
                    page-level title (rendered only on the first band,
                    which is Information Technology under the canonical
                    SECTOR_ORDER). Using 1fr auto 1fr instead of flex
                    space-between guarantees the middle text is centered
                    on the strip's full width regardless of how wide the
                    side elements grow — flex space-between would center
                    the middle text on the gap between the sides, which
                    drifts off-center as one side gets longer than the
                    other. The standalone page-header row this folds
                    into was redundant given the IT strip is already
                    visually anchored at the top of every render. */}
                <span style={{ justifySelf: 'start' }}>{band.sector}</span>
                <span
                  style={{
                    justifySelf: 'center',
                    color: '#9aa3b8',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {idx === 0 && (
                    data.mode === 'sector-etf-fallback'
                      ? 'Sector ETFs · fallback view'
                      : 'Top 250 SPX stocks by option volume'
                  )}
                </span>
                <div style={{
                  justifySelf: 'end',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.75rem',
                }}>
                  {idx === 0 && data.asOf && (
                    <>
                      <span style={{ color: '#9aa3b8' }}>
                        Last Updated: {formatLastUpdated(data.asOf)}
                      </span>
                      <span style={{ color: '#5a626f' }}>·</span>
                    </>
                  )}
                  <span style={{ color: '#6c7384' }}>{band.tiles.length}</span>
                </div>
              </div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: `repeat(${cols}, ${tileWidth}px)`,
                  gridAutoRows: `${TILE_HEIGHT}px`,
                  gap: `${TILE_GAP}px`,
                  marginTop: `${TILE_GAP}px`,
                }}
              >
                {band.tiles.map((t) => {
                  const bg = pctToColor(t.pctChange);
                  const fg = pctToTextColor(t.pctChange);
                  const volStr = formatVolume(t.optionsVolume);
                  return (
                    <div
                      key={t.symbol}
                      title={`${t.symbol} · ${t.name}\n${t.sector}\n${formatPct(t.pctChange)} · last ${formatPrice(t.last)} · prev ${formatPrice(t.prev)}${volStr ? `\nOpt vol ${volStr}` : ''}`}
                      style={{
                        background: bg,
                        color: fg,
                        fontFamily: 'Courier New, monospace',
                        display: 'flex',
                        flexDirection: 'column',
                        justifyContent: 'center',
                        alignItems: 'center',
                        overflow: 'hidden',
                        cursor: 'default',
                        padding: '2px',
                        boxSizing: 'border-box',
                      }}
                    >
                      <span
                        style={{
                          fontWeight: 700,
                          fontSize: '0.95rem',
                          lineHeight: 1.05,
                          letterSpacing: '0.02em',
                          whiteSpace: 'nowrap',
                          maxWidth: '100%',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {t.symbol}
                      </span>
                      <span
                        style={{
                          fontSize: '0.78rem',
                          opacity: 0.92,
                          marginTop: '1px',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {formatPct(t.pctChange)}
                      </span>
                    </div>
                  );
                })}
                {/* Pad the trailing row so the grid doesn't end with a
                    half-empty row of awkward white space; use empty
                    sentinel cells styled as transparent so the grid's
                    explicit row count matches its rendered footprint. */}
                {Array.from({ length: rowCount * cols - band.tiles.length }).map((_, i) => (
                  <div key={`pad-${i}`} style={{ background: 'transparent' }} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
