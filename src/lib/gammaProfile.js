// Client-side dealer gamma profile and volatility flip computation.
//
// Mirrors the ingest-background.mjs math so the gamma inflection chart and
// the volatility flip level render correctly on every run — including runs
// that predate the backend profile pass and runs where the deployed ingest
// never persisted a profile in the first place.
//
// Same conventions as the backend:
//   — Black-Scholes gamma, r=4.5%, q=0
//   — Dealer sign: long calls, short puts
//   — Sweep Ŝ over [0.85·S, 1.15·S] in $5 steps, re-evaluating BS gamma per
//     contract at each hypothetical spot with everything else held fixed
//   — Factored inner loop: d1 = (ln Ŝ + D) · invB, term = scale · φ(d1),
//     dealer γ(Ŝ) = Ŝ · Σ term

const RISK_FREE_RATE = 0.045;
const DIVIDEND_YIELD = 0.0;
const INV_SQRT_2PI = 1 / Math.sqrt(2 * Math.PI);

function yearsToExpiration(expirationIso, refMs) {
  if (!expirationIso) return null;
  const target = new Date(expirationIso + 'T20:00:00Z').getTime();
  if (Number.isNaN(target)) return null;
  const diffMs = target - refMs;
  if (diffMs <= 0) return 1 / 365;
  return diffMs / (365.25 * 24 * 3600 * 1000);
}

// Client contracts use `strike_price` (see data.mjs mapping). Backend
// contracts use `strike`. Accept both so this module is drop-in on either
// side if we ever want to unify.
function strikeOf(c) {
  return c.strike_price != null ? c.strike_price : c.strike;
}

export function computeGammaProfile(contracts, spotPrice, capturedAt) {
  if (!contracts || contracts.length === 0 || !(spotPrice > 0)) return null;

  const capturedAtMs = capturedAt ? new Date(capturedAt).getTime() : Date.now();
  if (Number.isNaN(capturedAtMs)) return null;

  const r = RISK_FREE_RATE;
  const q = DIVIDEND_YIELD;

  const prepared = [];
  for (const c of contracts) {
    const K = strikeOf(c);
    const sigma = c.implied_volatility;
    const oi = c.open_interest || 0;
    if (!(sigma > 0) || oi <= 0 || !(K > 0)) continue;
    const tau = yearsToExpiration(c.expiration_date, capturedAtMs);
    if (!(tau > 0)) continue;
    const sqrtTau = Math.sqrt(tau);
    const B = sigma * sqrtTau;
    const invB = 1 / B;
    const D = (r - q + 0.5 * sigma * sigma) * tau - Math.log(K);
    const sign = c.contract_type === 'call' ? 1 : -1;
    const scale = (Math.exp(-q * tau) / B) * oi * sign;
    prepared.push({ D, invB, scale });
  }

  if (prepared.length === 0) return null;

  const lo = spotPrice * 0.85;
  const hi = spotPrice * 1.15;
  const step = 5;
  const startS = Math.round(lo / step) * step;
  const endS = Math.round(hi / step) * step;

  const profile = [];
  for (let S = startS; S <= endS + 1e-9; S += step) {
    const lnS = Math.log(S);
    let innerSum = 0;
    for (let i = 0; i < prepared.length; i++) {
      const p = prepared[i];
      const d1 = (lnS + p.D) * p.invB;
      // Guard against float64 underflow on near-dated contracts where |d1| is
      // enormous. exp(-0.5·900) flushes to zero anyway, so clamp early and
      // skip the pow entirely.
      if (Math.abs(d1) > 30) continue;
      const phiD1 = INV_SQRT_2PI * Math.exp(-0.5 * d1 * d1);
      innerSum += p.scale * phiD1;
    }
    profile.push({ s: S, g: Math.round(S * innerSum) });
  }

  return profile;
}

// Pick the zero crossing most likely to represent the global regime boundary.
// When multiple crossings exist (narrow skew, wide expiration mix) the one
// with the steepest slope is the decisive transition.
export function findFlipFromProfile(profile) {
  if (!profile || profile.length < 2) return null;
  let bestFlip = null;
  let bestSlopeAbs = -Infinity;
  for (let i = 1; i < profile.length; i++) {
    const prev = profile[i - 1];
    const curr = profile[i];
    if (prev.g === 0) {
      return prev.s;
    }
    const crosses = (prev.g < 0 && curr.g > 0) || (prev.g > 0 && curr.g < 0);
    if (!crosses) continue;
    const dS = curr.s - prev.s;
    if (dS <= 0) continue;
    const slopeAbs = Math.abs((curr.g - prev.g) / dS);
    if (slopeAbs > bestSlopeAbs) {
      bestSlopeAbs = slopeAbs;
      const t = -prev.g / (curr.g - prev.g);
      bestFlip = prev.s + t * dS;
    }
  }
  return bestFlip;
}
