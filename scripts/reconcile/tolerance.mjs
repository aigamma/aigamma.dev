// Pure tolerance arithmetic for reconciliation. No I/O, no state.

export const OVERWRITE_THRESHOLD = 0.02;

export function computeDeltaPct(massive, theta) {
  if (theta === 0 || theta == null) return null;
  return (massive - theta) / theta;
}

export function exceedsTolerance(massive, theta, threshold = OVERWRITE_THRESHOLD) {
  const delta = computeDeltaPct(massive, theta);
  if (delta == null) return false;
  return Math.abs(delta) > threshold;
}

// DTE wiggle window for matching & band sampling.
// Under 7 DTE → ±1 day. At 7+ DTE → ±3 days.
// Sensitivity is a function of time-to-expiry, not whether the
// expiration happens to be weekly or monthly.
export function wiggleWindowFor(dte) {
  return dte < 7 ? 1 : 3;
}
