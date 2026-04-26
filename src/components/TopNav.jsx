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
// at the leftmost slot.
//
// On viewports ≤768px each item swaps to a compact mobile label
// via paired desktop/mobile spans (the same pattern used by
// .lab-badge and .lab-home-button--split). With six buttons plus
// the Menu trigger (and the Return Home button on lab pages), the
// row will flex-wrap onto a second line at the narrower phone
// widths; flex-wrap on the header is the documented fallback and
// degrades cleanly.
//
// The `current` prop suppresses the button matching the page the
// user is already on — the lab-badge in the upper-left already
// names the page, so a duplicate button in the same header row is
// redundant. Pages that aren't one of the six promoted
// destinations (e.g. /rough/, /risk/, /jump/) omit the prop and
// see all six buttons.
const TOP_NAV_ITEMS = [
  { key: 'tactical',    href: '/tactical/',    label: 'Tactical Vol', short: 'Vol'  },
  { key: 'earnings',    href: '/earnings/',    label: 'Earnings',     short: 'Earn' },
  { key: 'scan',        href: '/scan/',        label: 'Scan',         short: 'Scan' },
  { key: 'rotations',   href: '/rotations/',   label: 'Rotations',    short: 'Rot'  },
  { key: 'vix',         href: '/vix/',         label: 'VIX',          short: 'VIX'  },
  { key: 'seasonality', href: '/seasonality/', label: 'Seasonality',  short: 'Seas' },
];

export default function TopNav({ current } = {}) {
  const items = TOP_NAV_ITEMS.filter((item) => item.key !== current);
  return (
    <nav className="top-nav" aria-label="Featured labs">
      {items.map((item, index) => {
        const variant = index % 2 === 0 ? 'top-nav__item--blue' : 'top-nav__item--white';
        return (
          <a key={item.href} href={item.href} className={`top-nav__item ${variant}`}>
            <span className="top-nav__desktop-text">{item.label}</span>
            <span className="top-nav__mobile-text">{item.short}</span>
          </a>
        );
      })}
    </nav>
  );
}
