// Promoted top-level navigation. Six lab pages — Tactical Vol,
// Earnings, Scan, Rotations, VIX, Seasonality — are surfaced as
// their own buttons in every page header so a reader does not
// have to open the Menu dropdown to reach them. The remaining
// labs continue to live in the Menu component. Order is curated
// left-to-right by importance and clustering:
//   1. Tactical Vol — densest tactical-positioning surface, top priority
//   2. Earnings     — dated catalyst calendar
//   3. Scan         — 25Δ skew vs ATM IV scanner (placed in the literal
//                     middle per the directive "between Tactical Vol
//                     and Seasonality")
//   4. Rotations    — cross-sector relative strength
//   5. VIX          — VIX family models (placed immediately after
//                     Rotations per the directive "after Rotations
//                     and before HOME"; described by the operator
//                     as one of the strongest tabs, so given a
//                     prominent mid-right position rather than
//                     trailing the cluster)
//   6. Seasonality  — intraday seasonality grid (last; immediately
//                     before the Return Home button on lab pages)
// Items render as outlined buttons matching the 3.2rem chrome of
// the Menu trigger and Return Home button. The fill color
// alternates by displayed position — even indices use accent-blue,
// odd indices use text-primary (off-white) — so the row reads as a
// striped blue/white/blue/white cluster rather than a monochrome
// blue block. The alternation runs on the post-filter render index
// so when one button is hidden (because it represents the current
// page), the surviving buttons still alternate cleanly from blue
// at the leftmost slot. VIX is the one exception: its tile carries
// an explicit `variant: 'blue'` field, pinning it to accent-blue
// regardless of its visible index. Without the pin, VIX would
// flip to white whenever any of the first four buttons was
// suppressed by the `current` filter (the renumber would push VIX
// to an odd render index). The pin keeps VIX consistently blue
// across every page context. Earlier revisions of this file pinned
// VIX to var(--accent-purple) for cross-component continuity with
// VixHeaderProfile / LevelsPanel; that purple identity was rolled
// back in the top nav per Eric's directive while the in-page VIX
// chrome retains its purple accents.
//
// Mobile uses the same full labels as desktop. An earlier version
// of this component carried a paired desktop/mobile span splitter
// that swapped each label for a 3-4 letter abbreviation (Vol /
// Earn / Rot / Seas) at ≤768px to try to keep all six buttons +
// the Menu trigger on a single header row. That goal was never
// reachable: even at the most aggressive abbreviation the Menu
// pill spilled to a second row on real phone widths, so the row
// wrapped anyway. With wrap unavoidable the abbreviations bought
// nothing and cost legibility, so the short labels were dropped
// in favor of the full names. The header's flex-wrap fallback
// already handles the multi-row layout cleanly.
//
// The `current` prop suppresses the button matching the page the
// user is already on — the lab-badge in the upper-left already
// names the page, so a duplicate button in the same header row is
// redundant. Pages that aren't one of the six promoted
// destinations (e.g. /rough/, /risk/, /jump/) omit the prop and
// see all six buttons.
const TOP_NAV_ITEMS = [
  { key: 'tactical',    href: '/tactical/',    label: 'Tactical Vol' },
  { key: 'earnings',    href: '/earnings/',    label: 'Earnings'     },
  { key: 'scan',        href: '/scan/',        label: 'Scan'         },
  { key: 'rotations',   href: '/rotations/',   label: 'Rotations'    },
  { key: 'vix',         href: '/vix/',         label: 'VIX',          variant: 'blue' },
  { key: 'seasonality', href: '/seasonality/', label: 'Seasonality'  },
];

export default function TopNav({ current } = {}) {
  const items = TOP_NAV_ITEMS.filter((item) => item.key !== current);
  return (
    <nav className="top-nav" aria-label="Featured labs">
      {items.map((item, index) => {
        const variant = item.variant
          ? `top-nav__item--${item.variant}`
          : (index % 2 === 0 ? 'top-nav__item--blue' : 'top-nav__item--white');
        return (
          <a key={item.href} href={item.href} className={`top-nav__item ${variant}`}>
            {item.label}
          </a>
        );
      })}
    </nav>
  );
}
