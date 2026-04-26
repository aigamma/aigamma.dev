import { useCallback, useEffect, useRef, useState } from 'react';

// Shared menu dropdown. Rendered in the main dashboard header and in
// every lab header so the bookmark-only labs are reachable from any
// page without touching the URL bar. Lab items are alphabetized by
// path; the "About This Page" entry is pinned to the bottom as the
// off-site exit (about.aigamma.com is a separate subdomain, so its
// label drops the /slash-brackets/ format used for on-site labs).
//
// Three lab pages — /tactical/, /seasonality/, /rotations/ — moved
// out of this dropdown into the TopNav component (see
// src/components/TopNav.jsx) so they render as standalone buttons in
// the header alongside the Menu trigger. Their entries are not
// duplicated here; opening Menu now exposes only the labs that did
// not get promoted to the top nav.
const MENU_ITEMS = [
  { href: '/discrete/',                 label: '/discrete/',      desc: 'Binomial and trinomial trees, SVI and SSVI surfaces' },
  { href: '/earnings/',                 label: '/earnings/',      desc: 'Earnings calendar by implied move and date' },
  { href: '/expiring-gamma/',           label: '/expiring-gamma/', desc: 'Per-expiration SPX call / put γ scheduled to roll off' },
  { href: '/garch/',                    label: '/garch/',         desc: 'GARCH family and ensemble forecasts' },
  { href: '/heatmap/',                  label: '/heatmap/',       desc: 'Market-cap-weighted SPX heatmap by sector' },
  { href: '/jump/',                     label: '/jump/',          desc: 'Merton, Kou, Bates, variance gamma' },
  { href: '/local/',                    label: '/local/',         desc: 'Dupire extraction and local vol pricing' },
  { href: '/parity/',                   label: '/parity/',        desc: 'Put-call parity, box-spread rate, implied forward' },
  { href: '/regime/',                   label: '/regime/',        desc: 'Mixture, Markov, Wasserstein regimes' },
  { href: '/risk/',                     label: '/risk/',          desc: 'Cross-model Greeks, Vanna-Volga, second-order' },
  { href: '/rough/',                    label: '/rough/',         desc: 'Rough Bergomi and rough vol exploration' },
  { href: '/scan/',                     label: '/scan/',          desc: 'Call/put 25Δ skew vs ATM IV scanner' },
  { href: '/stochastic/',               label: '/stochastic/',    desc: 'Heston, SABR, LSV, rough Bergomi' },
  { href: 'https://about.aigamma.com/', label: 'About This Page' },
];

export default function Menu() {
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);
  const itemRefs = useRef([]);

  const close = useCallback((returnFocus) => {
    setIsOpen(false);
    setActiveIndex(-1);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e) => {
      if (
        panelRef.current && !panelRef.current.contains(e.target) &&
        triggerRef.current && !triggerRef.current.contains(e.target)
      ) {
        close(false);
      }
    };

    const handleKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(true);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((prev) => {
          const next = prev < MENU_ITEMS.length - 1 ? prev + 1 : 0;
          requestAnimationFrame(() => itemRefs.current[next]?.focus());
          return next;
        });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((prev) => {
          const next = prev > 0 ? prev - 1 : MENU_ITEMS.length - 1;
          requestAnimationFrame(() => itemRefs.current[next]?.focus());
          return next;
        });
      } else if (e.key === 'Home') {
        e.preventDefault();
        setActiveIndex(0);
        requestAnimationFrame(() => itemRefs.current[0]?.focus());
      } else if (e.key === 'End') {
        e.preventDefault();
        const last = MENU_ITEMS.length - 1;
        setActiveIndex(last);
        requestAnimationFrame(() => itemRefs.current[last]?.focus());
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKey);
    };
  }, [isOpen, close]);

  // Route changes are full-page loads on this MPA (each lab is its own
  // Vite entry), so a click on a menuitem will unmount the component
  // naturally. popstate covers back/forward navigation while the menu
  // is open.
  useEffect(() => {
    const handler = () => close(false);
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, [close]);

  const handleToggle = () => {
    setIsOpen((prev) => {
      const next = !prev;
      if (next) {
        setActiveIndex(0);
        requestAnimationFrame(() => itemRefs.current[0]?.focus());
      } else {
        setActiveIndex(-1);
      }
      return next;
    });
  };

  return (
    <div className="menu">
      <button
        ref={triggerRef}
        type="button"
        className="menu-trigger"
        onClick={handleToggle}
        aria-expanded={isOpen}
        aria-haspopup="menu"
        aria-label="Menu"
      >
        <span>MENU</span>
        <span
          className={`menu-caret${isOpen ? ' is-open' : ''}`}
          aria-hidden="true"
        >
          &#x25BE;
        </span>
      </button>
      {isOpen && (
        <div
          ref={panelRef}
          className="menu-panel"
          role="menu"
          aria-label="Lab navigation"
        >
          {MENU_ITEMS.map((item, idx) => (
            <a
              key={item.href}
              ref={(el) => { itemRefs.current[idx] = el; }}
              role="menuitem"
              tabIndex={activeIndex === idx ? 0 : -1}
              href={item.href}
              className="menu-item"
              onClick={() => close(false)}
            >
              <span className="menu-path">{item.label}</span>
              {item.desc && <span className="menu-desc">{item.desc}</span>}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
