import '../src/styles/theme.css';
import '../src/styles/lab.css';
import ErrorBoundary from '../src/ErrorBoundary';
import QuantMenu from '../src/components/QuantMenu';
import Chat from '../src/components/Chat';
import SlotA from './slots/SlotA';
import SlotB from './slots/SlotB';
import SlotC from './slots/SlotC';

// Regime Lab, three-slot scratch pad dedicated to regime-identification
// models on SPX daily log returns. The three slots are not A/B/C variants
// of a single candidate; they are three distinct methods that answer the
// same question three different ways:
//
//   SLOT A: Mixture Lognormal (2-component Gaussian mixture by EM on the
//            pooled return distribution; identifies calm vs crisis regimes
//            as two overlapping unimodal components and reports each
//            component's mean, vol, and mixing weight).
//
//   SLOT B: Markov Regime Switching (2-state Hamilton MSM with Gaussian
//            emissions, fit by EM with the Hamilton filter + Kim smoother;
//            produces a smoothed probability-of-high-vol-state trajectory
//            through time and the regime transition matrix).
//
//   SLOT C: Wasserstein K-Means Clustering (K=3 clusters of rolling
//            20-day empirical return distributions under the W₂ metric;
//            each cluster centroid is itself a 20-point empirical
//            distribution, updated as the pointwise-sorted barycenter of
//            assigned windows).
//
// All three consume the same SPX daily closes via useGexHistory so the
// answers line up on a common calendar axis. Unlike the bookmark-only
// scratch-pad labs at /alpha, /dev, and /beta, this page carries active
// egress back to the main dashboard at three redundant affordances: the
// logo in the header is a hyperlink to `/`, a filled green RETURN HOME
// button sits in the header itself between the Regime Lab brand on the
// left and the QuantMenu trigger on the right — centered horizontally
// on the same row as the other nav items via the header's flex
// space-between distribution — and the footer carries a bolded Return
// Home link for a reader who has scrolled past all three slots and the
// Chat panel. Nothing on the main site's public nav points here, so
// the page is still reached only by typing /regime or loading a
// bookmark.
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
            title="Regime Lab · regime-identification model zoo"
          >
            <span className="lab-badge__desktop-text">Regime Lab</span>
            <span className="lab-badge__mobile-text">Regime</span>
          </span>
        </div>
        <a
          href="/"
          className="lab-home-button lab-home-button--inline lab-home-button--split"
          aria-label="Return Home"
        >
          <span className="lab-home-button__desktop-text">Return Home</span>
          <span className="lab-home-button__mobile-text">Home</span>
        </a>
        <QuantMenu />
      </header>

      <section className="lab-slot">
        <ErrorBoundary><SlotA /></ErrorBoundary>
      </section>

      <section className="lab-slot">
        <ErrorBoundary><SlotB /></ErrorBoundary>
      </section>

      <section className="lab-slot">
        <ErrorBoundary><SlotC /></ErrorBoundary>
      </section>

      <ErrorBoundary>
        <Chat
          context="regime"
          welcome={{
            quick:
              'Ask about the three regime models above, how they disagree near transitions, and how to turn a regime signal into an actual trade.',
            deep:
              'Deep Analysis mode for longer and more structurally detailed responses on how each model works, how to read its output, and how to act on it in the SPX options market.',
          }}
        />
      </ErrorBoundary>

      <footer className="lab-footer">
        <span className="lab-footer-line">
          AI Gamma LLC · regime lab · three-method zoo · v0.1.0
        </span>
        <a href="/" className="lab-footer-home">Return Home</a>
      </footer>
    </div>
  );
}
