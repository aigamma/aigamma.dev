// Hull and White (2017) minimum-variance delta, equation (6).
//
//   Δf − δ_BS ΔS = (ν_BS / (S√T)) · (a + b·δ_BS + c·δ_BS²) + ε
//   δ_MV = δ_BS + (ν_BS / (S√T)) · (a + b·δ_BS + c·δ_BS²)
//
// ν_BS is BSM vega (∂C/∂σ with σ in decimal). Coefficients below are
// illustrative SPX call values on the regression scale of the paper (not
// the legacy /100 divisor). A desk would refit (a,b,c) on a rolling panel
// of (Δf, ΔS, δ, ν, S, T); see scripts/verify-hull-white-mv.mjs.

/** SPX call, calm-regime illustrative quadratic (decimal δ). */
export const HW_A = -0.42;
export const HW_B = 0.58;
export const HW_C = -0.28;

export function hullWhitePhi(bsmDelta, coeffs = { a: HW_A, b: HW_B, c: HW_C }) {
  const { a, b, c } = coeffs;
  return a + b * bsmDelta + c * bsmDelta * bsmDelta;
}

/**
 * @param {number} bsmDelta - practitioner BSM delta
 * @param {number} vega - BSM vega ∂C/∂σ (decimal σ)
 * @param {number} S - spot
 * @param {number} T - years to expiry
 */
export function minimumVarianceDelta(bsmDelta, vega, S, T) {
  if (!(S > 0) || !(T > 0)) return bsmDelta;
  const ratio = vega / (S * Math.sqrt(T));
  return bsmDelta + ratio * hullWhitePhi(bsmDelta);
}
