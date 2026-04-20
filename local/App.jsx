import '../src/styles/theme.css';
import '../src/styles/lab.css';
import ErrorBoundary from '../src/ErrorBoundary';
import QuantMenu from '../src/components/QuantMenu';
import Chat from '../src/components/Chat';
import SlotA from './slots/SlotA';
import SlotB from './slots/SlotB';
import SlotC from './slots/SlotC';
import SlotD from './slots/SlotD';

// Local Volatility Lab — four-slot scratch pad dedicated to Dupire's
// local-volatility framework end-to-end: extract σ_LV(K, T) from the
// SVI slice set of today's SPX chain, price options under the Dupire
// SDE dS = (r−q)·S dt + σ_LV(S, t)·S dW, visualize the surface from
// multiple angles, and then run the diagnostic that exposes local
// vol's signature weakness — flattened forward smiles, the reason
// local-stochastic vol exists as a paradigm at all.
//
// Where the /stochastic lab puts local vol into the broader SV
// lineage (Heston → SABR → LSV → Rough Bergomi) as a single slot,
// this lab treats local vol as the subject. Each slot here is a
// distinct operation on the same extracted surface, so a disagreement
// between slots can only be a disagreement in reading — the numerics
// come from one shared file (local/dupire.js).
//
//   SLOT A — Dupire Surface Extraction. Analytic SVI y-derivatives,
//            finite-difference T-derivative, Gatheral 2006 eq. 1.10
//            evaluated cell-by-cell on a (y, T) grid with per-cell
//            flags for calendar arbitrage (∂w/∂T < 0), butterfly
//            arbitrage (denominator N ≤ 0), and variance clipping.
//            Coverage statistics show exactly where the surface is
//            well-posed and where it is not.
//
//   SLOT B — Local Vol Pricing. Vectorized Monte Carlo under the
//            Dupire SDE with bilinear σ_LV(S, t) look-up, Euler-
//            Maruyama on log-price for numerical stability, and
//            per-expiration call pricing at five moneyness points.
//            Compares MC-recovered implied vols against the SVI
//            market smile on the same chain. Pure local vol is
//            designed to reproduce today's smile exactly — any
//            residual is MC noise plus discretization error, which
//            is the self-check.
//
//   SLOT C — Local Vol Surface Viewer. Plotly 3D surface of the same
//            σ_LV(y, T) grid SlotA renders as a heatmap, plus
//            interactive slice selectors — fix T and sweep y to see
//            the local-vol smile at a chosen tenor, or fix K and
//            sweep T to see the local-vol term structure at a chosen
//            strike. Complements SlotA (aggregate view) with local
//            views at user-chosen cross-sections.
//
//   SLOT D — Forward Smile Pathology. The textbook motivation for
//            local-stochastic vol: pure LV reproduces today's smile
//            but its forward smile — the implied smile the model
//            prices at a future date conditioned on a future spot —
//            flattens out. Monte-Carlo to an intermediate T*, bin
//            paths whose S_{T*} lands near today's spot, continue
//            those paths for additional τ years, price a fresh
//            strike strip, invert to IV, and overlay today's τ-smile.
//            The gap is the Gyöngy-projection artifact that LSV with
//            a leverage function L(S, t) is constructed to cure.
//
// All four slots consume the same live /api/data snapshot through
// useOptionsData, so the Dupire surface, the MC pricer, the 3D
// viewer, and the forward-smile diagnostic are internally consistent
// views of one point-in-time SPX chain. Like /alpha, /dev, /beta,
// /garch, /regime, /rough, and /stochastic, this lab has no ingress
// or egress links — the logo is not a hyperlink, nothing on the main
// site points here, and the page is reachable only by typing /local
// or loading a bookmark.
export default function App() {
  return (
    <div className="app-shell lab-shell">
      <header className="lab-header">
        <div className="lab-brand">
          <img src="/logo.webp" alt="aigamma.com" className="lab-logo" />
          <span
            className="lab-badge"
            title="Local Vol Lab — Dupire extraction, pricing, viewer, forward-smile"
          >
            Local Vol Lab
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
        A four-slot local-volatility scratch pad. Dupire surface
        extraction from the SVI slice set, local-vol Monte Carlo
        pricing against the market smile, interactive 3D surface
        viewer, and the forward-smile diagnostic that motivates
        local-stochastic vol. Math, data, and rendering may be
        incomplete, incorrect, or change without notice.
      </div>

      <section className="lab-slot">
        <div className="lab-slot-label">SLOT A · DUPIRE SURFACE EXTRACTION</div>
        <ErrorBoundary><SlotA /></ErrorBoundary>
      </section>

      <section className="lab-slot">
        <div className="lab-slot-label">SLOT B · LOCAL VOL PRICING</div>
        <ErrorBoundary><SlotB /></ErrorBoundary>
      </section>

      <section className="lab-slot">
        <div className="lab-slot-label">SLOT C · LOCAL VOL SURFACE VIEWER</div>
        <ErrorBoundary><SlotC /></ErrorBoundary>
      </section>

      <section className="lab-slot">
        <div className="lab-slot-label">SLOT D · FORWARD SMILE PATHOLOGY</div>
        <ErrorBoundary><SlotD /></ErrorBoundary>
      </section>

      <ErrorBoundary>
        <Chat
          context="local"
          welcome={{
            quick:
              'Ask about Dupire local volatility, the four slots above, or how pure LV relates to stochastic vol, LSV, rough vol, and the rest of the model lineage. Chat stays on volatility, options, and quantitative finance.',
            deep:
              'Deep Analysis mode — longer and more structurally detailed responses on Dupire\'s formula, Gyöngy\'s mimicking theorem, the forward-smile flattening pathology, and the philosophy of a deterministic-diffusion coefficient calibrated to today\'s smile.',
          }}
        />
      </ErrorBoundary>

      <footer className="lab-footer">
        <span className="lab-footer-line">
          AI Gamma LLC · local vol lab · dupire extraction + pricing · v0.1.0
        </span>
      </footer>
    </div>
  );
}
