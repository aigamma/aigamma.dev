// SLOT C — replace the default export with the model under test.
//
// Third and last slot. Using all three simultaneously is useful for
// three-way comparisons (e.g., the same metric computed three different
// ways) or for landing a stack of unrelated experiments on one page.

export default function SlotC() {
  return (
    <div className="lab-placeholder">
      <div className="lab-placeholder-title">Empty Slot</div>
      <div className="lab-placeholder-hint">
        Replace the default export of <code>beta/slots/SlotC.jsx</code> with
        a component. Leave this slot as a placeholder when only two models
        are under test — the empty-state card is intentionally quiet.
      </div>
    </div>
  );
}
