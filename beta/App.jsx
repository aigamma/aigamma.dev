import '../src/styles/theme.css';
import '../src/styles/lab.css';
import ErrorBoundary from '../src/ErrorBoundary';
import Menu from '../src/components/Menu';
import TopNav from '../src/components/TopNav';
import SlotB, { slotName as slotBName } from './slots/SlotB';

// Beta Lab shell — single slot for models under test. Graduated
// slots (previously SlotA/SPX-vs-Vol-Flip and SlotC/Gamma-Index-
// Oscillator, and most recently SlotB/Economic-Events) now live on
// the main dashboard or as their own production lab pages. SlotB
// is currently empty, ready for the next experimental tenant.
// Visual language intentionally mirrors the production dashboard
// (dark card chrome, Calibri-style brand sans-serif, four-token
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
