import { useCallback, useEffect, useRef, useState } from 'react';

// Shared quant-menu dropdown. Rendered in the main dashboard header and
// in every lab header so the nine bookmark-only labs are reachable from
// any page without touching the URL bar. Descriptors were cross-checked
// against each lab's App.jsx slot list (see commit rationale).
//
// Ordering is a story: start with the discrete pricers and smile fits
// that convert an option chain into tradeable prices (trees + SVI),
// add continuous vol dynamics (local vol → stochastic vol → rough
// vol), layer in discontinuous dynamics (jumps), step across to
// historical real-world vol (GARCH, regimes), and close with the
// cross-model risk view (greeks, Vanna-Volga). Parity is the tail
// entry — the no-arbitrage diagnostic that extracts r, q, and F from
// the chain itself with no pricing model on top. It lives at the
// bottom because it is a measurement surface rather than a trading
// strategy (box spreads are not the desk's focus); anyone who needs
// to audit the carry implied by the current chain finds it there.
const LAB_ITEMS = [
  { path: '/discrete/',   desc: 'Binomial and trinomial trees, SVI and SSVI surfaces' },
  { path: '/local/',      desc: 'Dupire extraction and local vol pricing' },
  { path: '/stochastic/', desc: 'Heston, SABR, LSV, rough Bergomi' },
  { path: '/rough/',      desc: 'Rough Bergomi and rough vol exploration' },
  { path: '/jump/',       desc: 'Merton, Kou, Bates, variance gamma' },
  { path: '/garch/',      desc: 'GARCH family and ensemble forecasts' },
  { path: '/regime/',     desc: 'Mixture, Markov, Wasserstein regimes' },
  { path: '/risk/',       desc: 'Cross-model Greeks, Vanna-Volga, second-order' },
  { path: '/parity/',     desc: 'Put-call parity, box-spread rate, implied forward' },
];

export default function QuantMenu() {
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
    <div className="quant-menu">
      <button
        ref={triggerRef}
        type="button"
        className="quant-menu-trigger"
        onClick={handleToggle}
        aria-expanded={isOpen}
        aria-haspopup="menu"
      >
        <span>QUANT MENU</span>
        <span
          className={`quant-menu-caret${isOpen ? ' is-open' : ''}`}
          aria-hidden="true"
        >
          &#x25BE;
        </span>
      </button>
      {isOpen && (
        <div
          ref={panelRef}
          className="quant-menu-panel"
          role="menu"
          aria-label="Quantitative labs"
        >
          {LAB_ITEMS.map((item, idx) => (
            <a
              key={item.path}
              ref={(el) => { itemRefs.current[idx] = el; }}
              role="menuitem"
              tabIndex={activeIndex === idx ? 0 : -1}
              href={item.path}
              className="quant-menu-item"
              onClick={() => close(false)}
            >
              <span className="quant-menu-path">{item.path}</span>
              <span className="quant-menu-desc">{item.desc}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
