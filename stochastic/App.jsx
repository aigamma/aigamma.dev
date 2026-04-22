import '../src/styles/theme.css';
import '../src/styles/lab.css';
import ErrorBoundary from '../src/ErrorBoundary';
import QuantMenu from '../src/components/QuantMenu';
import Chat from '../src/components/Chat';
import SlotA from './slots/SlotA';
import SlotB from './slots/SlotB';
import SlotC from './slots/SlotC';
import SlotD from './slots/SlotD';

// Stochastic Vol Lab — four-slot scratch pad dedicated to the canonical
// stochastic-volatility model lineage for SPX options. Unlike /regime,
// these slots are not competing methods answering the same question —
// they are four historically-sequential models that each add structure
// the previous one could not carry:
//
//   SLOT A — Heston (1993). Mean-reverting square-root stochastic
//            variance. dv = κ(θ − v)dt + ξ√v dW with Brownian correlation
//            ρ to the stock. Closed-form characteristic function; call
//            prices by the Lewis (2001) single-integral inversion.
//            Calibrated to a live SPX expiration slice by Nelder-Mead
//            on the IV residual. Answers: what does the simplest
//            economically-motivated SV model produce, and where does it
//            miss the observed smile.
//
//   SLOT B — SABR (Hagan, Kumar, Lesniewski, Woodward 2002). Stochastic
//            α-β-ρ with CEV elasticity β pinned to 1 for equities
//            (lognormal regime). Hagan's asymptotic closed-form maps
//            (α, ρ, ν) directly into Black-implied vol at each strike.
//            Calibrated on the same slice Slot A uses so the two are
//            directly comparable. Answers: what does a 3-parameter
//            practitioner model give you on a single maturity, when is
//            it enough, and when is the Heston dynamic structure worth
//            the calibration cost.
//
//   SLOT C — Local Stochastic Vol. Starts from Dupire's (1994) local
//            volatility σ²_LV(K,T) = (∂w/∂T) / (denominator in y = ln K/F
//            and derivatives of w = σ²T) computed across the full SVI
//            fit set, then discusses how a stochastic leverage function
//            L(S,t) — such that E[v_t | S_t=S]·L(S,t)² reproduces
//            σ²_LV(S,t) under Gyöngy's projection — upgrades Heston to
//            match today's smile exactly while keeping the forward
//            dynamics richer than pure local vol. The chart is the
//            Dupire surface as a (K, T) heatmap; the forward-smile
//            flattening problem of pure LV is the reading.
//
//   SLOT D — Rough Bergomi (Bayer, Friz, Gatheral 2016). Variance
//            driven by a fractional Brownian motion with Hurst H ∈
//            (0, 1/2), which predicts ATM skew scaling as T^(H − 1/2)
//            instead of Heston's ~T^(−1/2). SPX empirically scales near
//            T^(−0.4), consistent with H ≈ 0.10 — a headline result
//            that motivates the rough paradigm over classical SV. The
//            slot fits H by log-log regression on |∂σ_ATM/∂k| across
//            the SVI slice set and overlays theoretical T^(H−1/2)
//            curves for H = 0.1 / 0.3 / 0.5 as references.
//
// All four consume the same live /api/data snapshot so the Heston
// fit, the SABR fit, the Dupire surface, and the rough-vol skew
// regression are internally consistent views of one point-in-time
// chain. Navigation back to the homepage is surfaced in four
// redundant ways so the reader never has to retype the URL: the
// logo in the upper-left is a hyperlink to /, a filled green
// "RETURN HOME" button sits in the lab-header row horizontally
// aligned with the QuantMenu trigger so it reads as a primary
// top-level nav affordance from the first viewport, a second
// centered green "RETURN HOME" button sits between the SABR and
// LSV slots as a mid-page escape hatch for readers who have
// scrolled past the header, and the footer carries a bolded
// Return Home link as a last-line fallback. The QuantMenu in the
// upper-right continues to expose the cross-lab directory.
export default function App() {
  return (
    <div className="app-shell lab-shell">
      <header className="lab-header">
        <div className="lab-brand">
          <a href="/" aria-label="aigamma.com home" style={{ display: 'block' }}>
            <img src="/logo.webp" alt="aigamma.com" className="lab-logo" />
          </a>
          <span
            className="lab-badge"
            title="Stochastic Vol Lab · Heston, SABR, LSV, Rough Bergomi"
          >
            <span className="lab-badge__desktop-text">Stochastic Vol Lab</span>
            <span className="lab-badge__mobile-text">Stochastic</span>
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

      <div style={{ display: 'flex', justifyContent: 'center', margin: '1.5rem 0' }}>
        <a
          href="/"
          style={{
            fontFamily: "'Courier New', monospace",
            fontSize: '1rem',
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            padding: '0.75rem 1.75rem',
            border: '1px solid var(--accent-green)',
            color: 'var(--accent-green)',
            background: 'rgba(46, 204, 113, 0.08)',
            borderRadius: '4px',
            textDecoration: 'none',
            fontWeight: 700,
          }}
        >
          Return Home
        </a>
      </div>

      <section className="lab-slot">
        <ErrorBoundary><SlotC /></ErrorBoundary>
      </section>

      <section className="lab-slot">
        <ErrorBoundary><SlotD /></ErrorBoundary>
      </section>

      <ErrorBoundary>
        <Chat
          context="stochastic"
          welcome={{
            quick:
              'Ask about the four models above, how to read the residuals between a fit and the observed smile for market edge, which model to trust for which trading decision, and how to turn a parameter change into a position. Chat stays on volatility, options, and how stochastic-vol reads translate into SPX options trades.',
            deep:
              'Deep Analysis mode: longer and more structurally detailed responses on how each model works, where it breaks down, what the gap between its fit and the market is pricing, and how to act on that gap in practical SPX options structures.',
          }}
        />
      </ErrorBoundary>

      <footer className="lab-footer">
        <span className="lab-footer-line">
          AI Gamma LLC · stochastic vol lab · four-model lineage · v0.1.0 ·{' '}
          <a href="/" style={{ color: 'inherit', fontWeight: 700 }}>
            Return Home
          </a>
        </span>
      </footer>
    </div>
  );
}
