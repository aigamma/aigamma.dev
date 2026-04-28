import { useCallback, useEffect, useRef, useState } from 'react';

// Mobile-only navigation block. Replaces the desktop right-cluster (TopNav's
// six promoted-lab buttons + the inline Return Home button + the MENU
// dropdown trigger) with three larger-tap-target pills laid out left-to-
// right in a single right-aligned row at ≤768px:
//
//   [HOME (green)] [TOOLS (purple) ▾] [RESEARCH (blue) ▾]
//
// HOME is suppressed on the home page itself (where it would be a no-op
// link to the page the reader is already on). The same suppression rule
// extends inside the dropdowns: when the reader is already on one of the
// listed labs (e.g. at /tactical/ when tapping TOOLS, or at /garch/ when
// tapping RESEARCH), that lab's row is filtered out so neither dropdown
// ever offers an option to navigate to the page the reader is already
// on. The desktop TopNav already enforces the same hygiene via its
// `current` prop; this brings the rule to the mobile dropdowns. The
// ABOUT_ITEM at the bottom of RESEARCH is an off-site link to
// about.aigamma.com so it is never the current page on this site and is
// exempt from the filter. The two dropdown pills open
// mutually-exclusive panels: tapping TOOLS while RESEARCH is open closes
// RESEARCH and opens TOOLS, and vice versa. Both panels anchor to the
// right edge of the .mobile-nav container so their full content shows
// inside the viewport regardless of where the trigger pill itself ended
// up after flex layout — anchoring per-pill would push the TOOLS panel
// off the right edge on narrow phones (TOOLS sits second-from-right, so
// its panel anchored to its own trigger would clip the right edge).
//
// Color identity — TOOLS in purple, RESEARCH in blue. TOOLS keeps the
// same accent the desktop MENU trigger has used since the lab-rollup-
// pill rename (TOOLS is conceptually the descendant of the desktop
// Menu's Tools section plus the TopNav buttons), and RESEARCH stays in
// the platform's primary blue (the gateway to the eight calibrated-
// model research zoos that are the platform's main quantitative
// surface). RESEARCH lands at the right edge per Eric's directive so
// the dropdown that holds the most-frequented research destinations
// sits closest to the right-handed reader's thumb position on a phone
// held in portrait, with TOOLS one pill to its left.
//
// The TOOLS dropdown contains the ten operational lab pages — the six
// previously-promoted TopNav destinations (/tactical/, /earnings/, /scan/,
// /rotations/, /vix/, /seasonality/) plus the four bookmark-only Tools
// surfaces from the desktop Menu (/stocks/, /heatmap/, /expiring-gamma/,
// /parity/). The RESEARCH dropdown contains the eight calibrated-model
// research zoos (/discrete/, /garch/, /jump/, /local/, /regime/, /risk/,
// /rough/, /stochastic/) followed by an "About This Page" off-site exit
// pinned to the bottom — the same About entry that lives at the bottom
// of the desktop Menu, just relocated under RESEARCH on mobile so it has
// a natural home (the desktop Menu has its own "About" section header
// that we don't reproduce on mobile to keep the dropdowns lean).
//
// The component is rendered automatically as a sibling of the desktop
// .menu in src/components/Menu.jsx, so every page header that already
// renders <Menu /> picks up the mobile design without per-app edits to
// the 22 App.jsx files. CSS in src/styles/theme.css swaps which UI is
// visible: at ≥769px, .mobile-nav is display:none and the existing
// .menu / .top-nav / .lab-home-button--inline render normally; at
// ≤768px, those three desktop blocks are display:none and .mobile-nav
// becomes display:inline-flex.
//
// Home-page-only brand cluster. On the home page (where there is no
// .lab-badge on the left), the .mobile-nav also carries the aigamma
// wordmark and the dealer-gamma regime status as a left-aligned pair,
// so the entire mobile header reads as a single row of:
//
//   [logo][Γ]              [RESEARCH ▾] [TOOLS ▾]
//
// The brand cluster used to live in the LevelsPanel card's top strip,
// but on phone-class viewports the LevelsPanel strip stacked vertically
// (logo+regime cluster as row 1, "Last Updated" as row 2) and pushed the
// regime read below the navigation row. Pulling the brand into the
// header on mobile means the wordmark and the gamma status sit on the
// same row as RESEARCH / TOOLS so all four primary identity + nav
// elements are visible above the fold without scrolling.
//
// Gamma status compresses to a bolded capital Greek gamma (Γ) in the
// regime tone color — green for POSITIVE GAMMA, coral for NEGATIVE
// GAMMA, amber for NEAR FLIP — instead of the desktop pill's
// icon-plus-text chrome. The single colored letter carries the same
// state signal (color is the regime classifier; the glyph itself is
// the platform's identity letter, the same Γ that gives "AI Gamma" its
// name) at a fraction of the horizontal footprint, which is what makes
// a 4-element row fit alongside the wordmark inside a 360-430px iPhone-
// class viewport. The desktop LevelsPanel pill keeps the icon + label
// chrome unchanged because there is no horizontal pressure at desktop
// widths.
//
// Brand cluster only renders when the parent passes a regimeIndicator
// (the home page App.jsx does; lab page App.jsx files do not) AND the
// detected path is /, so lab pages keep their lean pills-only mobile
// row chrome and the lab-badge on the left side of the .lab-header.

const TOOLS_ITEMS = [
  { href: '/tactical/',       label: '/tactical/',       desc: 'VRP, term structure, smile, RND, fixed-strike IV' },
  { href: '/earnings/',       label: '/earnings/',       desc: 'Earnings calendar by implied move and date' },
  { href: '/scan/',           label: '/scan/',           desc: '25Δ skew vs ATM IV scanner across single names' },
  { href: '/rotations/',      label: '/rotations/',      desc: 'Sector rotation chart and 1D/1W/1M bar trio' },
  { href: '/vix/',            label: '/vix/',            desc: 'VIX term structure, OU, vol-of-vol, regimes' },
  { href: '/seasonality/',    label: '/seasonality/',    desc: 'SPX intraday and daily seasonality grids' },
  { href: '/stocks/',         label: '/stocks/',         desc: 'Top option-liquid single names, performance + rotation' },
  { href: '/heatmap/',        label: '/heatmap/',        desc: 'Equal-size top-250-by-options-volume heatmap by sector' },
  { href: '/events/',         label: '/events/',         desc: 'US macro release calendar with SPX implied-move overlays' },
  { href: '/expiring-gamma/', label: '/expiring-gamma/', desc: 'Gamma scheduled to expire per date' },
  { href: '/parity/',         label: '/parity/',         desc: 'Put-call parity, box-spread rate, implied forward' },
];

const RESEARCH_ITEMS = [
  { href: '/discrete/',   label: '/discrete/',   desc: 'Binomial and trinomial trees, SVI and SSVI surfaces' },
  { href: '/garch/',      label: '/garch/',      desc: 'GARCH family and ensemble forecasts' },
  { href: '/jump/',       label: '/jump/',       desc: 'Merton, Kou, Bates, variance gamma' },
  { href: '/local/',      label: '/local/',      desc: 'Dupire extraction and local vol pricing' },
  { href: '/regime/',     label: '/regime/',     desc: 'Mixture, Markov, Wasserstein regimes' },
  { href: '/risk/',       label: '/risk/',       desc: 'Cross-model Greeks, Vanna-Volga, second-order' },
  { href: '/rough/',      label: '/rough/',      desc: 'Rough Bergomi and rough vol exploration' },
  { href: '/stochastic/', label: '/stochastic/', desc: 'Heston, SABR, LSV, rough Bergomi' },
];

const ABOUT_ITEM = {
  href: 'https://about.aigamma.com/',
  label: 'About This Page',
  desc: 'Founder bio, platform notes, off-site exit',
};

export default function MobileNav({ regimeIndicator } = {}) {
  // Single dropdown-state machine: only one of TOOLS / RESEARCH can be
  // open at a time. Tapping the open pill again closes it; tapping the
  // other pill swaps. The state is plain string-or-null so the conditional
  // render in JSX stays a simple equality check.
  const [openPanel, setOpenPanel] = useState(null);

  // Capture the current path once at first render. window.location is
  // read once because these pages are MPAs so the path never changes
  // within a single mount; falling back to null on the SSR path is cheap
  // because the home dashboard is hydrated client-side anyway. The path
  // is normalized by collapsing /index.html to / and forcing a trailing
  // slash on non-root paths so the comparison against the items' href
  // values (all of which end in '/') is robust to "/tactical" vs
  // "/tactical/" and "/index.html" vs "/" address-bar variants. isHome
  // is derived from currentPath so the existing home-page rules — HOME
  // pill suppressed, brand cluster shown — keep working unchanged.
  const [currentPath] = useState(() => {
    if (typeof window === 'undefined') return null;
    const p = window.location.pathname;
    if (p === '/' || p === '/index.html') return '/';
    return p.replace(/\/index\.html$/, '/').replace(/\/?$/, '/');
  });
  const isHome = currentPath === '/';

  const containerRef = useRef(null);
  const toolsTriggerRef = useRef(null);
  const researchTriggerRef = useRef(null);

  const close = useCallback((returnFocusTo) => {
    setOpenPanel(null);
    if (returnFocusTo === 'tools') toolsTriggerRef.current?.focus();
    if (returnFocusTo === 'research') researchTriggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!openPanel) return;

    const handleClickOutside = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        close(null);
      }
    };

    const handleKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(openPanel);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKey);
    };
  }, [openPanel, close]);

  // Close the dropdown on browser back/forward navigation while it is open
  // (an in-page action that didn't navigate to a new lab) — mirrors the
  // popstate handler in Menu.jsx. Lab clicks themselves cause a full page
  // load and unmount the component, so no separate handler is needed for
  // those.
  useEffect(() => {
    const handler = () => setOpenPanel(null);
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, []);

  const togglePanel = (which) => {
    setOpenPanel((prev) => (prev === which ? null : which));
  };

  // Filter the dropdown item lists to suppress any entry that links back
  // to the current page. Generalizes the HOME-pill rule (HOME is hidden
  // on the home page) to every item in TOOLS and RESEARCH so neither
  // dropdown ever offers the option to navigate to the page the reader
  // is already on. ABOUT_ITEM is an off-site link to about.aigamma.com
  // so it is never the current page on this site and is exempt from the
  // filter. On SSR / pre-mount paths where currentPath is null the
  // unfiltered lists render unchanged.
  const visibleToolsItems = currentPath
    ? TOOLS_ITEMS.filter((item) => item.href !== currentPath)
    : TOOLS_ITEMS;
  const visibleResearchItems = currentPath
    ? RESEARCH_ITEMS.filter((item) => item.href !== currentPath)
    : RESEARCH_ITEMS;

  // Brand cluster shows only on the home page. The Γ uses the regime tone
  // color (green / coral / amber) and falls back to the muted brand color
  // when no regime classification has been resolved yet (e.g., between
  // mount and the first /api/data response). The wordmark always renders
  // when on the home page so first-paint shows the logo even before the
  // gamma classifier resolves.
  const showBrand = isHome;
  const gammaColor = regimeIndicator?.color || 'var(--text-secondary)';
  const gammaTitle = regimeIndicator
    ? `${regimeIndicator.label}: ${regimeIndicator.hint}`
    : 'Dealer gamma regime';

  return (
    <div
      className={`mobile-nav${showBrand ? ' mobile-nav--with-brand' : ''}`}
      ref={containerRef}
    >
      {showBrand && (
        <div className="mobile-nav__brand">
          <img
            src="/logo.webp"
            alt="aigamma.com"
            className="mobile-nav__logo"
          />
          <span
            className="mobile-nav__status"
            title={gammaTitle}
            aria-label={regimeIndicator?.label || 'Dealer gamma regime'}
          >
            {regimeIndicator?.state === 'positive' && (
              <svg
                viewBox="0 0 32 32"
                className="mobile-nav__status-icon"
                aria-hidden="true"
              >
                <rect width="32" height="32" fill="#000000" />
                <rect x="12" y="2" width="8" height="28" fill="#04a29f" />
                <rect x="2" y="12" width="28" height="8" fill="#04a29f" />
              </svg>
            )}
            {regimeIndicator?.state === 'negative' && (
              <svg
                viewBox="0 0 32 32"
                className="mobile-nav__status-icon"
                aria-hidden="true"
              >
                <rect width="32" height="32" fill="#000000" />
                <rect x="3" y="12" width="26" height="8" fill="#ef4444" />
              </svg>
            )}
            {regimeIndicator?.state === 'neutral' && (
              <img
                src="/favicons/neutral/icon128.png?v=2"
                alt=""
                aria-hidden="true"
                className="mobile-nav__status-icon"
              />
            )}
            {/* Γ rendered as an inline SVG path rather than a text glyph
                so its width and height match the sibling status icon
                exactly and visual height alignment between the two
                badge elements is pixel-precise. A text Γ at the same
                visual cap-height would require a font-size of ~4.5rem
                with line-height: 1, which would push the .mobile-nav
                row to ~4.5rem and dominate the entire page header.
                The path traces a Γ silhouette: top horizontal bar
                28x8 with a left vertical stem 8x28, both 8 units
                thick on a 32x32 grid — the same stroke weight as the
                positive icon's plus sign, so the two badge elements
                read as siblings at matching visual weight. fill is
                currentColor so a single inline color: prop drives
                the regime tint. */}
            <svg
              viewBox="0 0 32 32"
              className="mobile-nav__gamma"
              aria-hidden="true"
              style={{ color: gammaColor }}
            >
              <path d="M2 2 H30 V10 H10 V30 H2 Z" fill="currentColor" />
            </svg>
          </span>
        </div>
      )}
      {!isHome && (
        <a href="/" className="mobile-nav__pill mobile-nav__pill--home" aria-label="Return Home">
          HOME
        </a>
      )}
      <button
        ref={toolsTriggerRef}
        type="button"
        className="mobile-nav__pill mobile-nav__pill--tools"
        onClick={() => togglePanel('tools')}
        aria-expanded={openPanel === 'tools'}
        aria-haspopup="menu"
        aria-label="Tools menu"
      >
        <span>TOOLS</span>
        <span
          className={`mobile-nav__caret${openPanel === 'tools' ? ' is-open' : ''}`}
          aria-hidden="true"
        >
          &#x25BE;
        </span>
      </button>
      <button
        ref={researchTriggerRef}
        type="button"
        className="mobile-nav__pill mobile-nav__pill--research"
        onClick={() => togglePanel('research')}
        aria-expanded={openPanel === 'research'}
        aria-haspopup="menu"
        aria-label="Research menu"
      >
        <span>RESEARCH</span>
        <span
          className={`mobile-nav__caret${openPanel === 'research' ? ' is-open' : ''}`}
          aria-hidden="true"
        >
          &#x25BE;
        </span>
      </button>

      {openPanel === 'research' && (
        <div
          className="mobile-nav__dropdown mobile-nav__dropdown--research"
          role="menu"
          aria-label="Research"
        >
          {visibleResearchItems.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="mobile-nav__item mobile-nav__item--research"
              role="menuitem"
              onClick={() => setOpenPanel(null)}
            >
              <span className="mobile-nav__item-path">{item.label}</span>
              <span className="mobile-nav__item-desc">{item.desc}</span>
            </a>
          ))}
          <div className="mobile-nav__divider" role="presentation" />
          <a
            href={ABOUT_ITEM.href}
            className="mobile-nav__item mobile-nav__item--about"
            role="menuitem"
            onClick={() => setOpenPanel(null)}
          >
            <span className="mobile-nav__item-path">{ABOUT_ITEM.label}</span>
            <span className="mobile-nav__item-desc">{ABOUT_ITEM.desc}</span>
          </a>
        </div>
      )}

      {openPanel === 'tools' && (
        <div
          className="mobile-nav__dropdown mobile-nav__dropdown--tools"
          role="menu"
          aria-label="Tools"
        >
          {visibleToolsItems.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="mobile-nav__item mobile-nav__item--tools"
              role="menuitem"
              onClick={() => setOpenPanel(null)}
            >
              <span className="mobile-nav__item-path">{item.label}</span>
              <span className="mobile-nav__item-desc">{item.desc}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
