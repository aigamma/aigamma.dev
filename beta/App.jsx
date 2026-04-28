import '../src/styles/theme.css';
import '../src/styles/lab.css';
import ErrorBoundary from '../src/ErrorBoundary';
import Menu from '../src/components/Menu';
import TopNav from '../src/components/TopNav';
import SlotB, { slotName as slotBName } from './slots/SlotB';

// Beta Lab shell — single slot for models under test. Graduated
// slots (previously SlotA/SPX-vs-Vol-Flip and SlotC/Gamma-Index-
// Oscillator) now live on the main dashboard; SlotB remains as the
// one experimental surface in the lab. Current tenant: an Economic
// Events page that pairs a near-full-viewport TradingView Economic
// Calendar widget with a Forex Factory analytics panel (NFP, CPI,
// FOMC, GDP, PCE spotlight cards, plus Upcoming / Past Week tables
// keyed off the FF weekly XML feed proxied through
// /api/events-calendar). See beta/slots/SlotB.jsx and
// netlify/functions/events-calendar.mjs for the full data path.
// Visual language intentionally mirrors the production dashboard
// (dark card chrome, Courier New monospace accents, four-token
// palette) so that a component developed here can be dropped into
// the main App with zero restyle. The amber badge and warning strip
// are the only signals that this is a sandbox rather than the
// production dashboard.
//
// The logo in the header links back to the homepage and the Menu on
// the right of the header opens the nine-lab directory, so the page is
// reachable from and navigable to every other lab without leaving the
// keyboard. Crawlers are still blocked via the noindex meta tag in
// index.html and the robots.txt Disallow line.
export default function App() {
  return (
    <div className="app-shell lab-shell">
      <header className="lab-header">
        <div className="lab-brand">
          <span className="lab-badge" title="Beta Lab: experimental">
            BETA LAB
          </span>
        </div>
        <TopNav />
        <Menu />
      </header>

      <div className="lab-warning">
        <strong>Experimental.</strong>{' '}
        Models in these slots are under test. Data, math, and rendering may
        be incomplete, incorrect, or change without notice.
      </div>

      <section className="lab-slot">
        <div className="lab-slot-label">{slotBName}</div>
        <ErrorBoundary><SlotB /></ErrorBoundary>
      </section>

      <footer className="lab-footer">
        <span className="lab-footer-line">
          AI Gamma · internal beta lab · not for public consumption · v1.1.2
        </span>
      </footer>
    </div>
  );
}
