// Gamma-exposure math and the symlog compression used by the AI Gamma Map
// bars. Extracted from GexProfile so future historical-GEX models can reuse
// the same conventions without pulling in the rendering component.
//
// GEX notional = gamma * OI * 100 * spot^2 * 0.01. Convention: calls positive,
// puts negative, following the standard dealer-short-puts assumption.
export function computeGexByStrike(contracts, spotPrice) {
  const byStrike = new Map();
  const mult = spotPrice * spotPrice * 0.01 * 100;

  for (const c of contracts) {
    if (!c.gamma || !c.open_interest || !c.strike_price) continue;
    const key = c.strike_price;
    if (!byStrike.has(key)) {
      byStrike.set(key, { strike: key, callGex: 0, putGex: 0 });
    }
    const entry = byStrike.get(key);
    const gex = c.gamma * c.open_interest * mult;
    if (c.contract_type === 'call') entry.callGex += gex;
    else if (c.contract_type === 'put') entry.putGex += gex;
  }

  return Array.from(byStrike.values()).sort((a, b) => a.strike - b.strike);
}

// Symmetric log with linear threshold C: below C the mapping is nearly
// linear; above C magnitudes compress logarithmically. C is computed per
// render as P75(|netGex|) so the crossover adapts to each dataset.
export const symlog = (x, C) => Math.sign(x) * Math.log1p(Math.abs(x) / C) * C;

export function formatSI(v) {
  const abs = Math.abs(v);
  const sign = v < 0 ? '\u2212' : '';
  if (abs >= 1e12) return sign + +(abs / 1e12).toFixed(1) + 'T';
  if (abs >= 1e9) return sign + +(abs / 1e9).toFixed(1) + 'G';
  if (abs >= 1e6) return sign + +(abs / 1e6).toFixed(1) + 'M';
  if (abs >= 1e3) return sign + +(abs / 1e3).toFixed(1) + 'k';
  if (abs >= 1) return sign + abs.toFixed(0);
  return '0';
}

export function symlogTicks(rawValues, C) {
  const maxAbs = Math.max(...rawValues.map(Math.abs), 1);
  const decades = Math.ceil(Math.log10(maxAbs));
  const step = decades <= 4 ? 1 : decades <= 8 ? 2 : 3;
  const tickvals = [0];
  const ticktext = ['0'];
  for (let p = 0; p <= decades + 1; p += step) {
    const v = Math.pow(10, p);
    if (v > maxAbs * 2) break;
    tickvals.push(symlog(v, C), symlog(-v, C));
    ticktext.push(formatSI(v), formatSI(-v));
  }
  return { tickvals, ticktext };
}
