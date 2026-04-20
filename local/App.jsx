import '../src/styles/theme.css';
import '../src/styles/lab.css';
import ErrorBoundary from '../src/ErrorBoundary';
import QuantMenu from '../src/components/QuantMenu';
import Chat from '../src/components/Chat';
import SlotB from './slots/SlotB';
import SlotC from './slots/SlotC';
import SlotD from './slots/SlotD';

// Local Volatility Lab — three-slot scratch pad dedicated to Dupire's
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
//   SLOT C — Local Vol Surface Slices. Two linked 1D slice panels
//            on the σ_LV(y, T) grid with interactive slice selectors
//            — fix T and sweep y to see the local-vol smile at a
//            chosen tenor, or fix K and sweep T to see the local-vol
//            term structure at a chosen strike. The earlier rendition
//            of this slot carried a Plotly 3D surface mesh above the
//            two slice panels, but the 3D trace was too unwieldy as a
//            dynamic object (slow to rebuild, awkward to rotate on a
//            page that already scrolls) so it was removed and the two
//            1D slices now stand alone as the actionable readings.
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
// All three slots consume the same live /api/data snapshot through
// useOptionsData, so the MC pricer, the slice viewer, and the
// forward-smile diagnostic are internally consistent views of one
// point-in-time SPX chain. Unlike the other bookmark-only labs, this page now
// carries active egress back to the main dashboard at three
// redundant affordances, matching the /parity/ and /jump/ pattern:
// the logo in the header is a hyperlink to `/`, a filled green
// RETURN HOME button sits in the header itself between the Local
// Vol Lab brand on the left and the QuantMenu trigger on the right —
// centered horizontally on the same row as the other nav items via
// the header's flex space-between distribution — and the footer
// carries a bolded Return Home link for a reader who has scrolled
// past all three slots and the Chat panel.
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
            title="Local Vol Lab — Dupire pricing, viewer, forward-smile"
          >
            Local Vol Lab
          </span>
        </div>
        <a href="/" className="lab-home-button lab-home-button--inline">Return Home</a>
        <QuantMenu />
      </header>

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
          context="local"
          welcome={{
            quick:
              'Ask about Dupire local volatility, the three slots above, or how pure LV relates to stochastic vol, LSV, rough vol, and the rest of the model lineage. Chat stays on volatility, options, and quantitative finance.',
            deep:
              'Deep Analysis mode — longer and more structurally detailed responses on Dupire\'s formula, Gyöngy\'s mimicking theorem, the forward-smile flattening pathology, and the philosophy of a deterministic-diffusion coefficient calibrated to today\'s smile.',
          }}
        />
      </ErrorBoundary>

      <footer className="lab-footer">
        <span className="lab-footer-line">
          AI Gamma LLC · local vol lab · dupire extraction + pricing · v0.1.0
        </span>
        <a href="/" className="lab-footer-home">Return Home</a>
      </footer>
    </div>
  );
}
