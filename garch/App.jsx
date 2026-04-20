import '../src/styles/theme.css';
import '../src/styles/lab.css';
import ErrorBoundary from '../src/ErrorBoundary';
import QuantMenu from '../src/components/QuantMenu';
import Chat from '../src/components/Chat';
import GarchZoo from './slots/GarchZoo';

// /garch/ — GARCH Ensemble page, an integrated Quant Menu lab.
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
// This page carries active egress back to the main dashboard at three
// redundant affordances, matching the /parity/ and /jump/ pattern: the
// logo in the header is a hyperlink to `/`, a filled green RETURN HOME
// button sits in the header itself between the GARCH LAB brand on the
// left and the QuantMenu trigger on the right — centered horizontally
// on the same row as the other nav items via the header's flex
// space-between distribution — and the footer carries a bolded Return
// Home link for a reader who has scrolled past the slot and the Chat
// panel.
export default function App() {
  return (
    <div className="app-shell lab-shell">
      <header className="lab-header">
        <div className="lab-brand">
          <a href="/" className="lab-logo-link" aria-label="Return to aigamma.com homepage">
            <img src="/logo.webp" alt="aigamma.com" className="lab-logo" />
          </a>
          <span
            className="lab-badge"
            title="GARCH: 17-model univariate family zoo with equal-weight ensemble and a family picker"
          >
            GARCH LAB
          </span>
        </div>
        <a href="/" className="lab-home-button lab-home-button--inline">Return Home</a>
        <QuantMenu />
      </header>

      <section className="lab-slot">
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
        <a href="/" className="lab-footer-home">Return Home</a>
      </footer>
    </div>
  );
}
