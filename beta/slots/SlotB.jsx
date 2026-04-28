// Slot B — replace the default export with the model under test, and
// update the `slotName` constant below so the lab-slot label reflects
// the new model.
//
// This slot is a peer of Slot A, intended for either a second independent
// model or an alternate version of the same model mounted in A (for
// side-by-side comparison). The three slots share no state with each
// other by default, so "version X vs version Y" of one model means
// importing both versions and rendering them in different slots.
//
// The Economic Events listener that previously lived in this slot
// graduated to /events/ as a permanent production lab page (see
// events/App.jsx + events/slots/SlotB.jsx + netlify/functions/
// events-calendar.mjs). This slot is back to its empty-placeholder
// state, ready to hold the next model under test.

export const slotName = '(empty)';

export default function SlotB() {
  return (
    <div className="lab-placeholder">
      <div className="lab-placeholder-title">Empty Slot</div>
      <div className="lab-placeholder-hint">
        Replace the default export of <code>beta/slots/SlotB.jsx</code> with
        a component. Use this slot to A/B against Slot A, or to hold a
        second unrelated model under test.
      </div>
    </div>
  );
}
