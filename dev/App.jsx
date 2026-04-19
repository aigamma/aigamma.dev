import '../src/styles/theme.css';
import '../src/styles/lab.css';
import ErrorBoundary from '../src/ErrorBoundary';
import Slot from './slot';

// Dev — single-slot scratch pad, a peer to the alpha lab at /alpha. Same
// pre-β release stage, independent concept. Keeping two sibling slots
// alive at once — /alpha and /dev — buys the platform room to carry a
// stable visible example (the Discord-seeded put-call-parity card on
// /alpha) without freezing a second, earlier-stage idea out of the
// scratch-pad tier. A component maturing in either single-slot surface
// can promote into a beta slot on identical terms because the shell,
// theme, and warning strip are shared verbatim. Like /alpha and /beta,
// this page has no ingress or egress links: nothing on the main site
// points here, the logo is not a hyperlink, and the shell carries no
// nav. Reachable only by typing /dev or loading a bookmark.
export default function App() {
  return (
    <div className="app-shell lab-shell">
      <header className="lab-header">
        <div className="lab-brand">
          <img src="/logo.webp" alt="aigamma.com" className="lab-logo" />
          <span
            className="lab-badge"
            title="Dev — peer scratch pad to /alpha, same pre-β release stage"
          >
            DEV LAB
          </span>
        </div>
        <div className="lab-meta">
          <span className="lab-meta-line">bookmark-only</span>
          <span className="lab-meta-sep">·</span>
          <span className="lab-meta-line">1 slot</span>
          <span className="lab-meta-sep">·</span>
          <span className="lab-meta-line">pre-β</span>
        </div>
      </header>

      <div className="lab-warning">
        <strong>Experimental.</strong>{' '}
        A single-slot scratch pad for rough-cut ideas. Math, data, and
        rendering may be incomplete, incorrect, or change without notice.
      </div>

      <section className="lab-slot">
        <div className="lab-slot-label">SLOT</div>
        <ErrorBoundary><Slot /></ErrorBoundary>
      </section>

      <footer className="lab-footer">
        <span className="lab-footer-line">
          AI Gamma LLC · dev lab · peer of /alpha
        </span>
      </footer>
    </div>
  );
}
