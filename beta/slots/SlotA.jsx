// Slot A — replace the default export with the model under test, and
// update the `slotName` constant below so the lab-slot label in
// ../App.jsx reflects the new model.
//
// Anything imported from ../../src/hooks, ../../src/lib, or
// ../../src/components is in scope. If the component needs the options
// payload, use the `useOptionsData` hook the same way App.jsx does on the
// main site. If the component needs historical series, use the hooks in
// ../../src/hooks/useHistoricalData.js.
//
// The surrounding lab-slot chrome (the amber slot label and the
// per-slot ErrorBoundary) is applied by the shell in ../App.jsx — this
// file is just the slot body.

export const slotName = '(empty)';

export default function SlotA() {
  return (
    <div className="lab-placeholder">
      <div className="lab-placeholder-title">Empty Slot</div>
      <div className="lab-placeholder-hint">
        Replace the default export of <code>beta/slots/SlotA.jsx</code> with
        a component. Hooks live in <code>../../src/hooks/*</code>; pure
        helpers in <code>../../src/lib/*</code>; the Plotly theme in{' '}
        <code>../../src/lib/plotlyTheme.js</code>.
      </div>
    </div>
  );
}
