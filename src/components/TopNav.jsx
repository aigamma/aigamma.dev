// Promoted top-level navigation. Six lab pages — Tactical,
// Earnings, Scan, Rotations, VIX, Seasonality — are surfaced as
// their own buttons in every page header so a reader does not
// have to open the Menu dropdown to reach them. The remaining
// labs continue to live in the Menu component. Order is curated
// left-to-right by importance and clustering:
//   1. Tactical — densest tactical-positioning surface, top priority
//                 (the page's own in-page lab-badge still identifies
//                 the lab as "Tactical Vol"; the top-nav button was
//                 shortened to single-word "Tactical" to match the
//                 single-word labels on the other five buttons and to
//                 reduce header overflow risk on split-screen widths)
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
// at the leftmost slot. Every item participates in the alternation;
// none is pinned to a fixed color. An earlier revision pinned VIX
// to accent-blue via an explicit `variant: 'blue'` field so that
// suppressing one of the first four buttons (which renumbers VIX
// from the even-blue idx 4 to the odd-white idx 3) wouldn't flip
// its color. That pin produced two blues in a row on every page
// that filtered an earlier button (/tactical, /earnings, /scan,
// /rotations all rendered VIX adjacent to a same-color neighbor),
// breaking the striped read the alternation rule was designed to
// produce. The pin was removed so VIX follows the same per-page
// alternation as every other button. An even earlier revision
// pinned VIX to var(--accent-purple) for cross-component continuity
// with VixHeaderProfile / LevelsPanel; that purple identity was
// rolled back in the top nav per Eric's directive while the in-page
// VIX chrome retains its purple accents.
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
  { key: 'tactical',    href: '/tactical/',    label: 'Tactical'     },
  { key: 'earnings',    href: '/earnings/',    label: 'Earnings'     },
  { key: 'scan',        href: '/scan/',        label: 'Scan'         },
  { key: 'rotations',   href: '/rotations/',   label: 'Rotations'    },
  { key: 'vix',         href: '/vix/',         label: 'VIX'          },
  { key: 'seasonality', href: '/seasonality/', label: 'Seasonality'  },
];

export default function TopNav({ current } = {}) {
  const items = TOP_NAV_ITEMS.filter((item) => item.key !== current);
  return (
    <nav className="top-nav" aria-label="Featured labs">
      {items.map((item, index) => {
        const variant = index % 2 === 0 ? 'top-nav__item--blue' : 'top-nav__item--white';
        return (
          <a key={item.href} href={item.href} className={`top-nav__item ${variant}`}>
            {item.label}
          </a>
        );
      })}
    </nav>
  );
}
