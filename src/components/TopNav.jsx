// Promoted top-level navigation. Three lab pages — Tactical Vol,
// Seasonality, Rotations — are surfaced as their own buttons in
// every page header so a reader does not have to open the Menu
// dropdown to reach them. The remaining labs continue to live in
// the Menu component. Items render as outlined buttons matching
// the 3.2rem chrome of the Menu trigger and Return Home button,
// so the four right-side header affordances sit on one horizontal
// baseline. The fill color alternates by displayed position —
// even indices use accent-blue, odd indices use text-primary
// (off-white) — so the row reads as a striped blue/white/blue/white
// cluster rather than a monochrome blue block. The alternation runs
// on the post-filter render index so when one button is hidden
// (because it represents the current page), the surviving buttons
// still alternate cleanly from blue at the leftmost slot.
//
// On viewports ≤768px each item swaps to a compact mobile label
// via paired desktop/mobile spans (the same pattern used by
// .lab-badge and .lab-home-button--split) so three buttons + a
// Return Home + a Menu trigger still fit on one row at phone
// widths without requiring the lab-header's flex-wrap fallback.
//
// The `current` prop suppresses the button matching the page the
// user is already on — the lab-badge in the upper-left already
// names the page, so a duplicate button in the same header row is
// redundant. Pages that aren't one of the four promoted
// destinations (e.g. /rough/, /risk/, /jump/) omit the prop and
// see all four buttons.
const TOP_NAV_ITEMS = [
  { key: 'earnings',    href: '/earnings/',    label: 'Earnings',     short: 'Earn' },
  { key: 'tactical',    href: '/tactical/',    label: 'Tactical Vol', short: 'Vol'  },
  { key: 'seasonality', href: '/seasonality/', label: 'Seasonality',  short: 'Seas' },
  { key: 'rotations',   href: '/rotations/',   label: 'Rotations',    short: 'Rot'  },
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
