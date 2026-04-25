import { useCallback, useEffect, useRef, useState } from 'react';

// Shared menu dropdown. Rendered in the main dashboard header and in
// every lab header so the bookmark-only labs are reachable from any
// page without touching the URL bar. Items are alphabetized by path so
// users get a stable scan order across every surface that mounts it.
const LAB_ITEMS = [
  { path: '/discrete/',    desc: 'Binomial and trinomial trees, SVI and SSVI surfaces' },
  { path: '/garch/',       desc: 'GARCH family and ensemble forecasts' },
  { path: '/jump/',        desc: 'Merton, Kou, Bates, variance gamma' },
  { path: '/local/',       desc: 'Dupire extraction and local vol pricing' },
  { path: '/parity/',      desc: 'Put-call parity, box-spread rate, implied forward' },
  { path: '/regime/',      desc: 'Mixture, Markov, Wasserstein regimes' },
  { path: '/risk/',        desc: 'Cross-model Greeks, Vanna-Volga, second-order' },
  { path: '/rotations/',   desc: 'Relative sector rotation chart' },
  { path: '/rough/',       desc: 'Rough Bergomi and rough vol exploration' },
  { path: '/seasonality/', desc: 'SPX 30-minute intraday seasonality grid' },
  { path: '/stochastic/',  desc: 'Heston, SABR, LSV, rough Bergomi' },
  { path: '/tactical/',    desc: 'VRP, term structure, smile, RND, fixed-strike IV' },
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
          const next = prev < LAB_ITEMS.length - 1 ? prev + 1 : 0;
          requestAnimationFrame(() => itemRefs.current[next]?.focus());
          return next;
        });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((prev) => {
          const next = prev > 0 ? prev - 1 : LAB_ITEMS.length - 1;
          requestAnimationFrame(() => itemRefs.current[next]?.focus());
          return next;
        });
      } else if (e.key === 'Home') {
        e.preventDefault();
        setActiveIndex(0);
        requestAnimationFrame(() => itemRefs.current[0]?.focus());
      } else if (e.key === 'End') {
        e.preventDefault();
        const last = LAB_ITEMS.length - 1;
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
          {LAB_ITEMS.map((item, idx) => (
            <a
              key={item.path}
              ref={(el) => { itemRefs.current[idx] = el; }}
              role="menuitem"
              tabIndex={activeIndex === idx ? 0 : -1}
              href={item.path}
              className="menu-item"
              onClick={() => close(false)}
            >
              <span className="menu-path">{item.path}</span>
              <span className="menu-desc">{item.desc}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
