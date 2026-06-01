// Canonical rate conventions for aigamma.com surfaces.
//
// LAB_R / LAB_Q — pinned teaching constants on model zoos (/jump/, /risk/,
// /discrete/) so cross-model fits are reproducible without a live curve.
//
// SVI_R / SVI_Q — Breeden-Litzenberger, Dupire, and SVI slice fits on the
// dashboard use r = q = 0 so densities and local vol emphasize smile shape
// rather than carry. Tactical prose documents this choice.

/** SOFR-ish risk-free for lab pages (decimal). */
export const LAB_R = 0.045;

/** Trailing SPX dividend yield for lab pages (decimal). */
export const LAB_Q = 0.013;

/** SVI / BL / Dupire fitter carry (decimal). */
export const SVI_R = 0;

export const SVI_Q = 0;
