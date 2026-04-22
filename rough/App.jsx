import '../src/styles/theme.css';
import '../src/styles/lab.css';
import ErrorBoundary from '../src/ErrorBoundary';
import QuantMenu from '../src/components/QuantMenu';
import Chat from '../src/components/Chat';
import SlotA from './slots/SlotA';
import SlotB from './slots/SlotB';
import SlotC from './slots/SlotC';

// Rough Volatility Lab — three-slot scratch pad for rough-path volatility
// models on SPX daily log returns. "Rough" volatility is the empirical
// finding (Gatheral-Jaisson-Rosenbaum 2018) that the log of realized
// variance behaves like a fractional Brownian motion with Hurst H ≈ 0.1,
// far below the H = 0.5 of standard Brownian motion. That single stylized
// fact overturned two decades of diffusion-based stochastic-volatility
// modeling and gave rise to a family of non-Markovian Volterra-type models
// whose defining prediction — ATM skew ∝ T^(H − 1/2), i.e. explosive as
// T → 0 — matches the observed index options surface in a way Heston,
// SABR, and every classical affine SV model could not.
//
// The three slots here are not A/B/C variants of one model — they are
// three different views of the same rough-vol hypothesis:
//
//   SLOT A — RFSV Hurst Signature (Gatheral-Jaisson-Rosenbaum diagnostic).
//            Compute a daily realized-variance proxy, take its log, and
//            fit the structure-function scaling m(q, Δ) = ⟨|ΔX|^q⟩ ~ Δ^(qH)
//            across multiple moment orders q. Under RFSV, the slopes
//            should pin down a single H ≈ 0.1-0.15 that is ~invariant in
//            q. The log-log plot is the canonical empirical signature.
//
//   SLOT B — Rough Bergomi Simulator. Cholesky-based Monte Carlo of the
//            rBergomi (Bayer-Friz-Gatheral 2016) model. Tunable H, η, ρ,
//            flat ξ₀. Simulates Riemann-Liouville fBm paths, exponentiates
//            into variance paths, drives a correlated spot process, and
//            inverts ATM call prices at multiple maturities to recover the
//            implied-vol term structure. The fitted T^(H−1/2) slope on
//            ATM skew is the generative counterpart to Slot A's signature.
//
//   SLOT C — Hurst Estimator Triangulation. Three orthogonal H estimators
//            (variogram on log RV, absolute-moments method on log RV,
//            detrended fluctuation analysis on log-RV cumulative sums)
//            applied to the same series. The three estimates should pin
//            down a narrow H band if the rough-vol scaling is real;
//            divergence between them is a signal that the sample is too
//            short, too noisy, or non-monofractal.
//
// All three consume daily SPX closes through the existing useGexHistory
// hook — same calendar axis as the /regime and /garch labs. Navigation
// back to the homepage is provided at three redundant affordances so the
// path out of the lab is unmissable: the logo in the upper-left of the
// header is wrapped in an anchor to /, a filled green "Return Home"
// button sits inline in the header row between the Rough Vol Lab brand
// on the left and the QuantMenu trigger on the right — horizontally
// aligned with the other top-level nav items via the header's flex
// space-between distribution — and the footer carries a bold "Return
// Home" link on its own line. The QuantMenu in the upper-right remains
// the cross-lab navigator for the nine integrated Quant Menu labs;
// nothing on the main site's public nav points here, so /rough is
// still reached by typing the URL or loading a bookmark.
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
            title="Rough Volatility Lab · fractional-Brownian / Volterra model zoo"
          >
            <span className="lab-badge__desktop-text">Rough Vol Lab</span>
            <span className="lab-badge__mobile-text">Rough Vol</span>
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
          context="rough"
          welcome={{
            quick:
              'Ask about rough volatility, the three methods above, or how the empirical Hurst signature, the rBergomi simulator, and the three-estimator triangulation corroborate or challenge each other. Chat stays on volatility, options, and rough-path modeling.',
            deep:
              'Deep Analysis mode — longer and more structurally detailed responses on fractional Brownian motion, Volterra volatility processes, short-end skew asymptotics, and the philosophy of measuring a single Hurst exponent three different ways.',
          }}
        />
      </ErrorBoundary>

      <footer className="lab-footer">
        <span className="lab-footer-line">
          AI Gamma · rough vol lab · three-method zoo · v0.1.0
        </span>
        <a href="/" className="lab-footer-home">Return Home</a>
      </footer>
    </div>
  );
}
