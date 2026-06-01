#!/usr/bin/env node
// Sanity-check Hull-White MV delta scale at a reference SPX monthly call.
import { minimumVarianceDelta, hullWhitePhi } from '../src/lib/hullWhiteMvDelta.js';

function phi(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}
function Phi(x) {
  const a1 = 0.31938153;
  const a2 = -0.356563782;
  const a3 = 1.781477937;
  const a4 = -1.821255978;
  const a5 = 1.330274429;
  const k = 1 / (1 + 0.2316419 * Math.abs(x));
  const w = 1 - phi(x) * (a1 * k + a2 * k * k + a3 * k ** 3 + a4 * k ** 4 + a5 * k ** 5);
  return x >= 0 ? w : 1 - w;
}
function bsmDelta(S, K, T, r, q, sigma) {
  const vsT = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / vsT;
  return Math.exp(-q * T) * Phi(d1);
}
function bsmVega(S, K, T, r, q, sigma) {
  const vsT = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / vsT;
  return S * Math.exp(-q * T) * phi(d1) * Math.sqrt(T);
}

const S = 6000;
const T = 30 / 365;
const sigma = 0.15;
const r = 0.045;
const q = 0.013;
const K = S;
const dBSM = bsmDelta(S, K, T, r, q, sigma);
const vega = bsmVega(S, K, T, r, q, sigma);
const dMV = minimumVarianceDelta(dBSM, vega, S, T);
const shift = dMV - dBSM;

const lo = 0.04;
const hi = 0.14;
if (shift > -lo || shift < -hi) {
  console.error(
    `MV call delta shift ${shift.toFixed(4)} outside expected band [${-hi}, ${-lo}]`,
  );
  console.error(`phi(δ)=${hullWhitePhi(dBSM).toFixed(4)}, δ_BSM=${dBSM.toFixed(4)}`);
  process.exit(1);
}
console.log(`OK: ATM call MV−BSM = ${shift.toFixed(4)} (target ~${-((lo + hi) / 2).toFixed(2)})`);
