import '../src/styles/theme.css';
import '../src/styles/lab.css';
import ErrorBoundary from '../src/ErrorBoundary';
import QuantMenu from '../src/components/QuantMenu';
import Chat from '../src/components/Chat';
import SlotA from './slots/SlotA';
import SlotB from './slots/SlotB';
import SlotC from './slots/SlotC';
import SlotD from './slots/SlotD';

// Jump Lab. Four-slot scratch pad dedicated to the canonical
// jump-process options-pricing models for SPX. The lineage is
// chronological and conceptual, each model removing or relaxing a
// restriction of the one before it:
//
//   SLOT A. Merton (1976) Jump Diffusion. Geometric Brownian motion
//           with a compound Poisson overlay of log-normally distributed
//           jumps. Five parameters: σ (diffusion vol), λ (jump
//           intensity per year), μ_J and σ_J (mean and stdev of the log
//           jump size), plus the risk-free / dividend pair carried as
//           inputs. Closed-form call price as a Poisson-weighted sum of
//           Black-Scholes calls. Calibrated in IV-space against an SPX
//           expiration slice. The historical anchor of the family.
//
//   SLOT B. Kou (2002) Double Exponential. Same compound-Poisson
//           overlay, but jump sizes drawn from an asymmetric double
//           exponential rather than a normal: probability p of an
//           upward jump with rate η₁, probability 1-p of a downward
//           jump with rate η₂. The asymmetry directly captures the
//           equity stylized fact that crash jumps are larger than
//           rally jumps. Closed-form characteristic function;
//           Lewis-style integral inversion for the call price.
//
//   SLOT C. Bates (1996) SVJ. Heston stochastic variance plus Merton
//           jumps in the spot. Eight parameters. The smile fix that
//           Heston alone cannot deliver at the short end is supplied
//           by the jump component, which closes the empirical gap
//           identified in the Stochastic Vol Lab Slot A reading. The
//           fitted jump intensity and jump-size mean tell the trader
//           how much of the skew the market is pricing as a tail-risk
//           premium versus diffusive vol.
//
//   SLOT D. Variance Gamma (Madan, Carr, Chang 1998). Pure-jump
//           infinite-activity Levy process built by time-changing a
//           Brownian motion with a gamma subordinator. No diffusive
//           component at all. Three parameters: σ (Brownian vol of
//           the time-changed motion), ν (variance rate of the gamma
//           clock, controls kurtosis), θ (drift of the time-changed
//           motion, controls skew). Closed-form characteristic
//           function. Demonstrates that an "all jumps, no diffusion"
//           process can fit the SPX smile competitively.
//
// All four consume the same live /api/data snapshot so the four fits
// describe the same point-in-time chain through different process
// assumptions. Unlike the other bookmark-only labs, this page carries
// active egress back to the main dashboard at three redundant
// affordances: the logo in the header is a hyperlink to `/`, a filled
// green RETURN HOME button sits in the header itself between the
// Jump Lab brand on the left and the QuantMenu trigger on the right
// — centered horizontally on the same row as the other nav items via
// the header's flex space-between distribution — and the footer
// carries a bolded Return Home link for a reader who has scrolled to
// the bottom of a long page.
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
            title="Jump Lab · Merton, Kou, Bates SVJ, Variance Gamma"
          >
            <span className="lab-badge__desktop-text">Jump Lab</span>
            <span className="lab-badge__mobile-text">Jump</span>
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
          context="jump"
          welcome={{
            quick:
              'Ask about jump-process option pricing, the four slots above, or how the Merton, Kou, Bates, and Variance Gamma lineage relates to the pure stochastic-vol, local-vol, and rough-vol lineages on the sibling labs. Chat stays on volatility, options, and quantitative finance.',
            deep:
              'Deep Analysis mode — longer and more structurally detailed responses on compound Poisson and double-exponential jump measures, affine jump-diffusion transform analysis, Levy processes and the Levy-Khintchine decomposition, Variance Gamma as a time-changed Brownian motion, and the philosophy of pricing a jump-augmented market that is formally incomplete.',
          }}
        />
      </ErrorBoundary>

      <footer className="lab-footer">
        <span className="lab-footer-line">
          AI Gamma · jump lab · four-model lineage · v0.1.0
        </span>
        <a href="/" className="lab-footer-home">Return Home</a>
      </footer>
    </div>
  );
}
