import '../src/styles/theme.css';
import '../src/styles/lab.css';
import ErrorBoundary from '../src/ErrorBoundary';
import QuantMenu from '../src/components/QuantMenu';
import SlotA, { slotName as slotAName } from './slots/SlotA';
import SlotB, { slotName as slotBName } from './slots/SlotB';
import SlotC, { slotName as slotCName } from './slots/SlotC';

// Beta Lab shell — three vertically stacked slots for models under test.
// Visual language intentionally mirrors the production dashboard (dark card
// chrome, Courier New monospace accents, four-token palette) so that a
// component developed here can be dropped into the main App with zero
// restyle. The amber badge and warning strip are the only signals that this
// is a sandbox rather than the production dashboard.
//
// The logo in the header links back to the homepage and the QuantMenu on
// the right of the header opens the nine-lab directory, so the page is
// reachable from and navigable to every other lab without leaving the
// keyboard. Crawlers are still blocked via the noindex meta tag in
// index.html and the robots.txt Disallow line.
export default function App() {
  return (
    <div className="app-shell lab-shell">
      <header className="lab-header">
        <div className="lab-brand">
          <a href="/" aria-label="aigamma.com home" style={{ display: 'block' }}>
            <img src="/logo.webp" alt="aigamma.com" className="lab-logo" />
          </a>
          <span className="lab-badge" title="Beta Lab — experimental">
            BETA LAB
          </span>
        </div>
        <QuantMenu />
      </header>

      <div className="lab-warning">
        <strong>Experimental.</strong>{' '}
        Models in these slots are under test. Data, math, and rendering may
        be incomplete, incorrect, or change without notice.
      </div>

      <section className="lab-slot">
        <div className="lab-slot-label">{slotAName}</div>
        <ErrorBoundary><SlotA /></ErrorBoundary>
      </section>

      <section className="lab-slot">
        <div className="lab-slot-label">{slotBName}</div>
        <ErrorBoundary><SlotB /></ErrorBoundary>
      </section>

      <section className="lab-slot">
        <div className="lab-slot-label">{slotCName}</div>
        <ErrorBoundary><SlotC /></ErrorBoundary>
      </section>

      <footer className="lab-footer">
        <span className="lab-footer-line">
          AI Gamma · internal beta lab · not for public consumption · v1.1.2
        </span>
      </footer>
    </div>
  );
}
