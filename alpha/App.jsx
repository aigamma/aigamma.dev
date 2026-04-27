import '../src/styles/theme.css';
import '../src/styles/lab.css';
import ErrorBoundary from '../src/ErrorBoundary';
import Menu from '../src/components/Menu';
import TopNav from '../src/components/TopNav';
import Chat from '../src/components/Chat';
import SlotA, { slotName as slotAName } from './slots/SlotA';
import SlotB, { slotName as slotBName } from './slots/SlotB';

// Alpha — two-slot scratch pad, one step less ready than the beta lab
// at /beta. "α" in the software-stage sense: the release letter that
// precedes β. The shared lab.css chrome is identical to the beta lab's
// on purpose, so a component that takes shape here can promote into a
// beta slot with no restyle, and from there into the main dashboard on
// the same terms. The second slot exists so an incremental change can
// be tested in one slot while the baseline stays untouched in the other
// — SlotA and SlotB start byte-identical and diverge over time as the
// model under test iterates. The visible slot labels are sourced from
// each slot file's exported `slotName` constant rather than typed
// inline here, so the chrome dynamically reflects whatever model is
// currently mounted in each slot — swap a slot's content and the
// label updates from the same edit. The logo in the upper-left links
// back to the homepage and the Menu in the upper-right opens the
// cross-lab navigator, matching the chrome on the integrated labs;
// nothing on the main site points here, so the page is
// still reached only by typing /alpha or loading a bookmark.
export default function App() {
  return (
    <div className="app-shell lab-shell">
      <header className="lab-header">
        <div className="lab-brand">
          <span
            className="lab-badge"
            title="Alpha · pre-β, software-stage sense"
          >
            Alpha Lab
          </span>
        </div>
        <TopNav />
        <Menu />
      </header>

      <div className="lab-warning">
        <strong>Experimental.</strong>{' '}
        A two-slot A/B scratch pad for rough-cut ideas. Math, data, and
        rendering may be incomplete, incorrect, or change without notice.
      </div>

      <section className="lab-slot">
        <div className="lab-slot-label">{slotAName}</div>
        <ErrorBoundary><SlotA /></ErrorBoundary>
      </section>

      <section className="lab-slot">
        <div className="lab-slot-label">{slotBName}</div>
        <ErrorBoundary><SlotB /></ErrorBoundary>
      </section>

      <ErrorBoundary>
        <Chat
          context="alpha"
          welcome={{
            quick:
              'Ask about whichever prototype is currently in SlotA and SlotB, the iteration path between them, or the math and quant-finance motivation behind the model under test.',
            deep:
              'Deep Analysis mode: longer and more structurally detailed responses on the model currently scaffolded in the two slots, the engineering decisions behind the iteration, and the broader quantitative-finance context this prototype sits inside.',
          }}
        />
      </ErrorBoundary>

      <footer className="lab-footer">
        <span className="lab-footer-line">
          AI Gamma · α lab · software-stage sense · v1.1.4
        </span>
      </footer>
    </div>
  );
}
