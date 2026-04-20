import '../src/styles/theme.css';
import '../src/styles/lab.css';
import ErrorBoundary from '../src/ErrorBoundary';
import QuantMenu from '../src/components/QuantMenu';
import Chat from '../src/components/Chat';
import GarchZoo from './slots/GarchZoo';

// /garch/ — GARCH family zoo page, bookmark-only, peer to /alpha and /dev.
// Single slot rendering 17 univariate GARCH-family specifications plus an
// equal-weight master ensemble on daily SPX log returns, with a family
// picker above the chart that lets a viewer hide a family — the ensemble
// and forecast tail recompute on whatever stays visible.
//
// The multivariate fitters (CCC / DCC / BEKK / OGARCH) stay in the
// garch.js library but are not invoked on this page. They had been paired
// with gamma_throttle's daily first-difference as a second series to
// produce an SPX-vs-positioning ρ₁₂(t) time series, but that trace had no
// actionable reading attached, so the correlation chart was removed and
// the freed space was redirected into a taller main chart.
//
// Like /alpha, /beta, and /dev, this page has no ingress or egress links:
// nothing on the main site points here, the logo is not a hyperlink, and
// the shell carries no nav. Reachable only by typing /garch or loading a
// bookmark.
export default function App() {
  return (
    <div className="app-shell lab-shell">
      <header className="lab-header">
        <div className="lab-brand">
          <img src="/logo.webp" alt="aigamma.com" className="lab-logo" />
          <span
            className="lab-badge"
            title="GARCH: 17-model univariate family zoo with equal-weight ensemble and a family picker"
          >
            GARCH LAB
          </span>
        </div>
        <QuantMenu />
      </header>

      <section className="lab-slot">
        <div className="lab-slot-label">GARCH ENSEMBLE</div>
        <ErrorBoundary><GarchZoo /></ErrorBoundary>
      </section>

      <ErrorBoundary>
        <Chat
          context="garch"
          welcome={{
            quick:
              'Ask about the GARCH family, the seventeen specifications, or the equal-weight ensemble above.',
            deep:
              'Deep Analysis mode — longer and more structurally detailed responses on GARCH theory, the specific specifications on this page, and the philosophy of fitting a family rather than a single model.',
          }}
        />
      </ErrorBoundary>

      <footer className="lab-footer">
        <span className="lab-footer-line">
          AI Gamma LLC · GARCH lab · univariate family zoo with picker
        </span>
      </footer>
    </div>
  );
}
