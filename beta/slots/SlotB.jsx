// SLOT B — replace the default export with the model under test.
//
// This slot is a peer of Slot A, intended for either a second independent
// model or an alternate version of the same model mounted in A (for
// side-by-side comparison). The three slots share no state with each
// other by default, so "version X vs version Y" of one model means
// importing both versions and rendering them in different slots.

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
