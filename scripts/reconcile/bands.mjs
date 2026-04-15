import { wiggleWindowFor } from './tolerance.mjs';

// Percentile band computation for the frozen cloud grid.
//
// NOTE: Bands are POINT-IN-TIME SNAPSHOTS. They are written once per
// (trading_date, dte) at reconciliation time and NEVER recomputed
// retroactively, even when underlying daily_term_structure values are
// corrected downstream. The cascade-for-directions rule does NOT apply
// to bands. See the full rationale in cascade.mjs.

export const BAND_DTE_MIN = 0;
export const BAND_DTE_MAX = 280;

export function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return null;
  if (sortedValues.length === 1) return sortedValues[0];
  const rank = p * (sortedValues.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sortedValues[lower];
  const weight = rank - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

export function sampleForDte(targetDte, historicalRows) {
  const window = wiggleWindowFor(targetDte);
  const samples = [];
  for (const row of historicalRows) {
    if (Math.abs(row.dte - targetDte) <= window) {
      samples.push(row.atm_iv);
    }
  }
  samples.sort((a, b) => a - b);
  return samples;
}

export function computeBand(targetDte, historicalRows) {
  const samples = sampleForDte(targetDte, historicalRows);
  if (samples.length === 0) {
    return {
      dte: targetDte,
      iv_p10: null,
      iv_p30: null,
      iv_p50: null,
      iv_p70: null,
      iv_p90: null,
      sample_count: 0,
    };
  }
  // Interior split points are p30/p70 (not p25/p75) so the four
  // rendered bands (p10-p30, p30-p50, p50-p70, p70-p90) each hold
  // exactly 20 percentile points of probability mass. A visually
  // wider upper band is then purely distributional skew, not a
  // bin-size artifact.
  return {
    dte: targetDte,
    iv_p10: percentile(samples, 0.10),
    iv_p30: percentile(samples, 0.30),
    iv_p50: percentile(samples, 0.50),
    iv_p70: percentile(samples, 0.70),
    iv_p90: percentile(samples, 0.90),
    sample_count: samples.length,
  };
}

// Uniform grid 0..280. Single-key lookup from frontend, no sparse
// grid, no nearest-neighbor logic at the render layer.
export function buildBandGrid(historicalRows) {
  const grid = [];
  for (let dte = BAND_DTE_MIN; dte <= BAND_DTE_MAX; dte++) {
    grid.push(computeBand(dte, historicalRows));
  }
  return grid;
}

export function percentileRank(value, sortedValues) {
  if (value == null || sortedValues.length === 0) return null;
  let below = 0;
  for (const v of sortedValues) {
    if (v < value) below++;
    else break;
  }
  return below / sortedValues.length;
}
