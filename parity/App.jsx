import '../src/styles/theme.css';
import '../src/styles/lab.css';
import ErrorBoundary from '../src/ErrorBoundary';
import QuantMenu from '../src/components/QuantMenu';
import SlotA, { slotName as slotAName } from './slots/SlotA';
import SlotB, { slotName as slotBName } from './slots/SlotB';

// Parity Lab. Two slots dedicated to put-call parity on the live SPX
// chain — the v4 composite (box r vs direct PCP r at q = 0, plus the
// PCP-recovered SPX forward) and the v1 baseline (box-spread implied
// rate alone). The work originated in /alpha as a response to a Discord
// question about how put-call parity could be surfaced on the platform,
// and iterated through four versions there as Discord-driven follow-ups
// added the direct-PCP overlay (v2), the SPX forward panel (v3), and a
// focus-mode pill row (v4). /alpha continues as the iteration surface
// for further versions; this page is the stable home so the /parity/
// URL can be cited or shared without churn as alpha keeps moving.
//
// Slot A is the v4 composite, Slot B is the v1 baseline. Both consume
// the same /api/data SPX snapshot, so any disagreement between them is
// model-spec disagreement (one strike at q = 0 vs four-leg with q
// cancelled) rather than a data-cut difference. The visible slot
// labels are sourced from each slot file's exported `slotName`
// constant rather than typed inline here, so the chrome dynamically
// reflects what is mounted in each slot — swap a slot's content and
// the label updates from the same edit.
//
// CALIBRATION IN PROGRESS. The current implementation produces
// implausible readings on the live SPX chain (median r ≈ −222%,
// nearest ≈ −87%) where a correctly calibrated read should sit within
// a reasonable spread of the risk-free rate. Root-cause diagnosis is
// ongoing across five candidates: box-leg construction at the tightest
// ATM bracket where strike width is small, mark quality on deep-ITM
// legs whose bid-ask spread dominates the rate signal, sign / unit /
// compounding conventions in the rate solver, dividend treatment (SPX
// has a continuous yield that the q = 0 direct-PCP variant
// deliberately absorbs but that the four-leg box should cancel), and
// underlying-symbol verification (European-style SPX vs accidentally
// American-style SPY proxy). The page IS linked from QuantMenu at the
// tail of the lab list — parity is a measurement surface (no-arbitrage
// diagnostic that reads r, q, and F off the chain with no pricer on
// top) rather than a trading strategy, so it sits at the bottom of
// the sequence as the diagnostic anyone auditing the implied carry
// can reach, not at the top as a headline. Box spreads are not the
// desk's focus. The in-page warning banner makes the calibration
// state explicit to readers who arrive here.
export default function App() {
  return (
    <div className="app-shell lab-shell">
      <header className="lab-header">
        <div className="lab-brand">
          <img src="/logo.webp" alt="aigamma.com" className="lab-logo" />
          <span
            className="lab-badge"
            title="Parity Lab · put-call parity, box vs direct PCP, implied SPX forward"
          >
            Parity Lab
          </span>
        </div>
        <div className="lab-nav-group">
          <QuantMenu />
          <div className="lab-meta">
            <span className="lab-meta-line">put-call parity</span>
            <span className="lab-meta-sep">·</span>
            <span className="lab-meta-line">2 slots</span>
            <span className="lab-meta-sep">·</span>
            <span className="lab-meta-line">pre-β</span>
          </div>
        </div>
      </header>

      <div className="lab-warning">
        <strong>Calibration in progress — not for use.</strong>{' '}
        Current readings (median r ≈ −222%, nearest ≈ −87%) are
        implausible for SPX, where a correctly calibrated put-call-
        parity read should sit within a reasonable spread of the
        risk-free rate (SOFR-adjacent, low single digits). Diagnosing
        across box construction at the tightest ATM bracket, mark
        quality on deep-ITM legs, sign and unit conventions, and
        dividend treatment. Page is kept up as a diagnostic surface
        but is not promoted to the QuantMenu until the nearest-expiry
        rate converges to a plausible spread of SOFR and the median
        across all expirations sits within a few tens of basis points
        of treasury.
      </div>

      <section className="lab-slot">
        <div className="lab-slot-label">{slotAName}</div>
        <ErrorBoundary><SlotA /></ErrorBoundary>
      </section>

      <section className="lab-slot">
        <div className="lab-slot-label">{slotBName}</div>
        <ErrorBoundary><SlotB /></ErrorBoundary>
      </section>

      <footer className="lab-footer">
        <span className="lab-footer-line">
          AI Gamma LLC · parity lab · v1.0.0
        </span>
      </footer>
    </div>
  );
}
