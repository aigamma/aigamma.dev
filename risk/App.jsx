import '../src/styles/theme.css';
import '../src/styles/lab.css';
import ErrorBoundary from '../src/ErrorBoundary';
import QuantMenu from '../src/components/QuantMenu';
import Chat from '../src/components/Chat';
import SlotA from './slots/SlotA';
import SlotB from './slots/SlotB';
import SlotC from './slots/SlotC';
import SlotD from './slots/SlotD';

// Risk Lab. Four slots dedicated to risk-measurement and Greek-comparison
// models that the main dashboard does not currently carry. Each slot picks
// one operational question a risk manager asks when reading an options
// chain and lets a different model answer it on the same live SPX snapshot.
//
//   SLOT A · Cross-Model Greeks. Compute delta, gamma, and vega across
//            strikes under three option-pricing models calibrated or
//            fitted on the same slice: Black-Scholes-Merton (log-normal,
//            industry baseline), Bachelier (arithmetic / normal), and
//            Heston (stochastic variance). Answers the question of how
//            much the Greek you hedge on depends on the model you assume.
//
//   SLOT B · Delta Comparison. Five different deltas on the same chain:
//            BSM market-IV delta, minimum-variance delta (Hull-White
//            2017), sticky-strike delta, sticky-delta delta, and the
//            ingested market delta. The chart shows how much a "delta-
//            neutral" hedge shifts depending on which smile-dynamics
//            assumption you embed.
//
//   SLOT C · Vanna-Volga Decomposition. The classic three-anchor smile
//            reconstruction from FX (Castagna-Mercurio 2007): pin an
//            ATM, 25-delta put, and 25-delta call, then price every
//            other strike as a BSM price plus three weighted correction
//            terms that hedge vega, vanna, and volga against the anchors.
//            Decomposes the observed smile into the three classical
//            smile-risk exposures.
//
//   SLOT D · Second-Order Greeks. Vanna, volga, and charm across strikes
//            at one expiration. The "risk-of-risks" a vol trader carries
//            when a single-Greek hedge is not enough: vanna is how delta
//            moves when vol moves, volga is the convexity of vega to vol,
//            and charm is the bleed of delta through calendar time.
//
// All four slots consume the same live /api/data snapshot so their
// Greeks, deltas, and smile reconstructions describe one point-in-time
// chain. Unlike the bookmark-only lab surfaces, this page carries
// active egress back to the main dashboard at three redundant
// affordances, matching the /parity/, /jump/, /garch/, /regime/, and
// /stochastic/ pattern: the logo in the header is a hyperlink to `/`,
// a filled green RETURN HOME button sits in the header itself between
// the Risk Lab brand on the left and the QuantMenu trigger on the
// right — centered horizontally as the midpoint of the other two nav
// items via the header's flex space-between distribution across three
// direct children — and the footer carries a bolded Return Home link
// for a reader who has scrolled to the bottom of a long page.
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
            title="Risk Lab · cross-model Greeks, delta comparison, Vanna-Volga, second-order Greeks"
          >
            <span className="lab-badge__desktop-text">Risk Lab</span>
            <span className="lab-badge__mobile-text">Risk</span>
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

      <section className="lab-slot">
        <ErrorBoundary><SlotD /></ErrorBoundary>
      </section>

      <ErrorBoundary>
        <Chat
          context="risk"
          welcome={{
            quick:
              'Ask about cross-model Greeks, the four delta definitions, Vanna-Volga, or vanna-volga-charm across strikes, how the model you pick changes the number on your screen, and how to turn that model choice into a concrete trade. Chat stays on volatility, options, and quantitative finance.',
            deep:
              'Deep Analysis mode. Longer and more structurally detailed responses on Black-Scholes vs Bachelier vs Heston Greeks, sticky-strike vs sticky-delta vs minimum-variance hedging on SPX, the Castagna-Mercurio three-anchor smile method, and the second-order Greeks (vanna, volga, charm) that quietly carry the SPX vol book.',
          }}
        />
      </ErrorBoundary>

      <footer className="lab-footer">
        <span className="lab-footer-line">
          AI Gamma · risk lab · four-model comparison · v0.1.0
        </span>
        <a href="/" className="lab-footer-home">Return Home</a>
      </footer>
    </div>
  );
}
