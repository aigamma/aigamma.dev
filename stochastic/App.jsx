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
// chain. Like /alpha, /dev, /beta, /garch, and /regime, this lab has
// no ingress or egress links — the logo is not a hyperlink, nothing
// on the main site points here, and the page is reachable only by
// typing /stochastic or loading a bookmark.
export default function App() {
  return (
    <div className="app-shell lab-shell">
      <header className="lab-header">
        <div className="lab-brand">
          <img src="/logo.webp" alt="aigamma.com" className="lab-logo" />
          <span
            className="lab-badge"
            title="Stochastic Vol Lab · Heston, SABR, LSV, Rough Bergomi"
          >
            Stochastic Vol Lab
          </span>
        </div>
        <div className="lab-nav-group">
          <QuantMenu />
          <div className="lab-meta">
            <span className="lab-meta-line">bookmark-only</span>
            <span className="lab-meta-sep">·</span>
            <span className="lab-meta-line">4 slots</span>
            <span className="lab-meta-sep">·</span>
            <span className="lab-meta-line">pre-β</span>
          </div>
        </div>
      </header>

      <div className="lab-warning">
        <strong>Experimental.</strong>{' '}
        A four-slot stochastic-volatility model lab. Heston, SABR,
        Local Stochastic Vol, and Rough Bergomi fit in-browser on
        live SPX option data. Math, data, and rendering may be
        incomplete, incorrect, or change without notice.
      </div>

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
          context="stochastic"
          welcome={{
            quick:
              'Ask about the Heston, SABR, Local Stochastic Vol, and Rough Bergomi slots above, where each model misses the observed SPX smile, or how the lineage maps onto three decades of responses to the short-end skew anomaly. Chat stays on volatility, options, and stochastic-vol modeling.',
            deep:
              'Deep Analysis mode — longer and more structurally detailed responses on affine characteristic functions, the Hagan SABR expansion, Dupire local vol and Gyöngy projection, fractional Brownian motion, and the philosophy of calibrating a four-model lineage to one chain snapshot.',
          }}
        />
      </ErrorBoundary>

      <footer className="lab-footer">
        <span className="lab-footer-line">
          AI Gamma LLC · stochastic vol lab · four-model lineage · v0.1.0
        </span>
      </footer>
    </div>
  );
}
