import '../src/styles/theme.css';
import './lab.css';
import ErrorBoundary from '../src/ErrorBoundary';
import SlotA from './slots/SlotA';
import SlotB from './slots/SlotB';
import SlotC from './slots/SlotC';

// Beta Lab shell — three vertically stacked slots for models under test.
// Visual language intentionally mirrors the production dashboard (dark card
// chrome, Courier New monospace accents, four-token palette) so that a
// component developed here can be dropped into the main App with zero
// restyle. The amber badge and warning strip are the only signals that this
// is a sandbox rather than the production dashboard.
//
// There are no ingress or egress links on purpose: nothing on the main site
// links here, the logo is not a hyperlink, and there is no nav. This page
// is reachable only by typing /beta in the URL bar or using a bookmark.
// Crawlers are blocked via the noindex meta tag in index.html and the
// robots.txt Disallow line.
export default function App() {
  return (
    <div className="app-shell lab-shell">
      <header className="lab-header">
        <div className="lab-brand">
          <img src="/logo.webp" alt="aigamma.com" className="lab-logo" />
          <span className="lab-badge" title="Beta Lab — experimental, bookmark-only">
            BETA LAB
          </span>
        </div>
        <div className="lab-meta">
          <span className="lab-meta-line">bookmark-only</span>
          <span className="lab-meta-sep">·</span>
          <span className="lab-meta-line">3 slots</span>
          <span className="lab-meta-sep">·</span>
          <span className="lab-meta-line">experimental</span>
        </div>
      </header>

      <div className="lab-warning">
        <strong>Experimental.</strong>{' '}
        Models in these slots are under test. Data, math, and rendering may
        be incomplete, incorrect, or change without notice. Nothing here is
        for trading or decision-making.
      </div>

      <section className="lab-slot">
        <div className="lab-slot-label">SLOT A</div>
        <ErrorBoundary><SlotA /></ErrorBoundary>
      </section>

      <section className="lab-slot">
        <div className="lab-slot-label">SLOT B</div>
        <ErrorBoundary><SlotB /></ErrorBoundary>
      </section>

      <section className="lab-slot">
        <div className="lab-slot-label">SLOT C</div>
        <ErrorBoundary><SlotC /></ErrorBoundary>
      </section>

      <footer className="lab-footer">
        <span className="lab-footer-line">
          AI Gamma LLC · internal beta lab · not for public consumption
        </span>
      </footer>
    </div>
  );
}
