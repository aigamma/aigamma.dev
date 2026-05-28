// SLOT F · SSVI Joint Surface Fit Across Tenors.
//
// The implementation, math, chart wiring, and prose explainer all live
// in src/components/SsviSurfaceFit.jsx so the same exact panel can also
// be mounted on the landing page (src/App.jsx) without duplicating ~700
// lines of Nelder-Mead solver + Plotly trace assembly + per-slice RMSE
// table + arbitrage diagnostics. This file stays in place because
// discrete/App.jsx still imports `./slots/SlotF` directly under its
// six-slot mounting pattern; the thin wrapper preserves the import
// path while letting the heavy code centralize in src/components/.
import SsviSurfaceFit from '../../src/components/SsviSurfaceFit';

export default function SlotF() {
  return <SsviSurfaceFit />;
}
