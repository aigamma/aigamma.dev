import '../src/styles/theme.css';
import '../src/styles/lab.css';
import ErrorBoundary from '../src/ErrorBoundary';
import Slot from './slot';

// Alpha — single-slot scratch pad, one step less ready than the beta lab
// at /beta. "α" in the software-stage sense: the release letter that
// precedes β. The shared lab.css chrome is identical to the beta lab's
// on purpose, so a component that takes shape here can promote into a
// beta slot with no restyle, and from there into the main dashboard on
// the same terms. Like /beta, this page has no ingress or egress links:
// nothing on the main site points here, the logo is not a hyperlink,
// and the shell carries no nav. Reachable only by typing /alpha or
// loading a bookmark.
export default function App() {
  return (
    <div className="app-shell lab-shell">
      <header className="lab-header">
        <div className="lab-brand">
          <img src="/logo.webp" alt="aigamma.com" className="lab-logo" />
          <span
            className="lab-badge"
            title="Alpha — pre-β, software-stage sense"
          >
            α LAB
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
          AI Gamma LLC · α lab · software-stage sense · v1.1.2
        </span>
      </footer>
    </div>
  );
}
