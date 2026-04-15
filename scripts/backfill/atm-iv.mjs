// Extracts per-expiration ATM IV rows from a day of Theta EOD greeks.
//
// Matches the live-ingest selection rule in
// netlify/functions/ingest-background.mjs so the two sources are
// directly comparable: among the contracts whose strike is nearest to
// underlying_price, prefer the CALL, fall back to the PUT. Theta's
// deep-OTM placeholder rows (implied_vol == 0 or 100) are filtered out
// so we don't accidentally pick one as "ATM" if the true ATM strike
// happens to have a broken row.

function isValidIv(iv) {
  return Number.isFinite(iv) && iv > 0.01 && iv < 5.0;
}

function daysBetweenIso(fromIso, toIso) {
  const a = new Date(`${fromIso}T00:00:00Z`).getTime();
  const b = new Date(`${toIso}T00:00:00Z`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

// Groups rows by expiration_date and, per group, picks the contract
// whose strike is closest to the underlying. Returns one row per
// expiration in the shape daily_term_structure expects, minus
// trading_date which is applied by the caller.
export function extractAtmRows(rows, tradingDate) {
  if (!rows || rows.length === 0) return [];
  const byExp = new Map();
  let underlyingPrice = null;
  for (const r of rows) {
    if (underlyingPrice == null && Number.isFinite(r.underlyingPrice) && r.underlyingPrice > 0) {
      underlyingPrice = r.underlyingPrice;
    }
    if (!isValidIv(r.implied_vol)) continue;
    if (!Number.isFinite(r.strike) || r.strike <= 0) continue;
    if (!byExp.has(r.expiration)) byExp.set(r.expiration, []);
    byExp.get(r.expiration).push(r);
  }
  if (underlyingPrice == null) return [];

  const out = [];
  for (const [expiration, expRows] of byExp) {
    expRows.sort((a, b) => Math.abs(a.strike - underlyingPrice) - Math.abs(b.strike - underlyingPrice));
    const nearestStrike = expRows[0].strike;
    const atMoney = expRows.filter((r) => r.strike === nearestStrike);
    const atmContract =
      atMoney.find((r) => r.right.toUpperCase() === 'CALL') ||
      atMoney.find((r) => r.right.toUpperCase() === 'PUT') ||
      atMoney[0];
    if (!atmContract) continue;
    const dte = daysBetweenIso(tradingDate, expiration);
    if (dte == null || dte < 0) continue;
    out.push({
      expiration_date: expiration,
      dte,
      atm_iv: atmContract.implied_vol,
      source: 'theta',
    });
  }
  out.sort((a, b) => a.dte - b.dte);
  return out;
}
