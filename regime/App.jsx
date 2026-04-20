import '../src/styles/theme.css';
import '../src/styles/lab.css';
import ErrorBoundary from '../src/ErrorBoundary';
import QuantMenu from '../src/components/QuantMenu';
import Chat from '../src/components/Chat';
import SlotA from './slots/SlotA';
import SlotB from './slots/SlotB';
import SlotC from './slots/SlotC';

// Regime Lab — three-slot scratch pad dedicated to regime-identification
// models on SPX daily log returns. The three slots are not A/B/C variants
// of a single candidate — they are three distinct methods that answer the
// same question three different ways:
//
//   SLOT A — Mixture Lognormal (2-component Gaussian mixture by EM on the
//            pooled return distribution; identifies calm vs crisis regimes
//            as two overlapping unimodal components and reports each
//            component's mean, vol, and mixing weight).
//
//   SLOT B — Markov Regime Switching (2-state Hamilton MSM with Gaussian
//            emissions, fit by EM with the Hamilton filter + Kim smoother;
//            produces a smoothed probability-of-high-vol-state trajectory
//            through time and the regime transition matrix).
//
//   SLOT C — Wasserstein K-Means Clustering (K=3 clusters of rolling
//            20-day empirical return distributions under the W₂ metric;
//            each cluster centroid is itself a 20-point empirical
//            distribution, updated as the pointwise-sorted barycenter of
//            assigned windows).
//
// All three consume the same SPX daily closes via useGexHistory so the
// answers line up on a common calendar axis. Like /alpha, /dev, /beta,
// and /garch, this lab has no ingress or egress links — the logo is not
// a hyperlink, nothing on the main site points here, and the page is
// reachable only by typing /regime or loading a bookmark.
export default function App() {
  return (
    <div className="app-shell lab-shell">
      <header className="lab-header">
        <div className="lab-brand">
          <img src="/logo.webp" alt="aigamma.com" className="lab-logo" />
          <span
            className="lab-badge"
            title="Regime Lab — regime-identification model zoo"
          >
            Regime Lab
          </span>
        </div>
        <div className="lab-nav-group">
          <QuantMenu />
          <div className="lab-meta">
            <span className="lab-meta-line">bookmark-only</span>
            <span className="lab-meta-sep">·</span>
            <span className="lab-meta-line">3 slots</span>
            <span className="lab-meta-sep">·</span>
            <span className="lab-meta-line">pre-β</span>
          </div>
        </div>
      </header>

      <div className="lab-warning">
        <strong>Experimental.</strong>{' '}
        A three-slot regime-model scratch pad. Mixture Lognormal, Markov
        Regime Switching, and Wasserstein K-Means fit in-browser on daily
        SPX log returns. Math, data, and rendering may be incomplete,
        incorrect, or change without notice.
      </div>

      <section className="lab-slot">
        <div className="lab-slot-label">SLOT A · MIXTURE LOGNORMAL</div>
        <ErrorBoundary><SlotA /></ErrorBoundary>
      </section>

      <section className="lab-slot">
        <div className="lab-slot-label">SLOT B · MARKOV REGIME SWITCHING</div>
        <ErrorBoundary><SlotB /></ErrorBoundary>
      </section>

      <section className="lab-slot">
        <div className="lab-slot-label">SLOT C · WASSERSTEIN K-MEANS</div>
        <ErrorBoundary><SlotC /></ErrorBoundary>
      </section>

      <ErrorBoundary>
        <Chat
          context="regime"
          welcome={{
            quick:
              'Ask about regime identification, the three methods above, or how they disagree at transition boundaries. Chat stays on volatility, options, and regime modeling.',
            deep:
              'Deep Analysis mode — longer and more structurally detailed responses on mixture models, Markov regime switching, Wasserstein clustering, and the philosophy of answering one question three ways.',
          }}
        />
      </ErrorBoundary>

      <footer className="lab-footer">
        <span className="lab-footer-line">
          AI Gamma LLC · regime lab · three-method zoo · v0.1.0
        </span>
      </footer>
    </div>
  );
}
