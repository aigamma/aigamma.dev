// ThetaTerminal v3 EOD greeks client for the historical backfill.
// Returns parsed CSV rows (one per contract per day) with only the
// fields the ATM extractor cares about. Separate file from the live
// reconciler's theta-client.mjs because this path handles CSV parsing
// and a different query shape — the live reconciler queries a single
// day at a time and doesn't need the 44-column surface.
//
// Endpoint: /v3/option/history/greeks/eod
//   symbol=SPXW expiration=* start_date=YYYYMMDD end_date=YYYYMMDD
// Response: CSV, header row + one row per (expiration, strike, right).
//
// SPXW vs SPX: ThetaData splits S&P 500 index options into two roots.
// SPX carries the AM-settled third-Friday standards + LEAPS (20
// expirations on 2025-10-01, reaching out to 2030). SPXW carries all
// PM-settled weekly/daily options plus PM-settled third-Friday dates
// (41 expirations on 2025-10-01, reaching out ~1 year). The cloud
// bands only cover DTE 0..280, which SPXW fully spans, and the
// weeklies inside SPXW are what the term-structure chart exposes to
// users. So the backfill queries SPXW only; SPX adds LEAPS that we
// never sample.

const DEFAULT_BASE_URL = 'http://127.0.0.1:25503';

function toCompactDate(iso) {
  return iso.replaceAll('-', '');
}

// Minimal CSV parser tuned to Theta's format: comma-separated, doubled
// double-quotes escape quotes inside strings. No embedded newlines in
// the fields we care about. Avoids pulling in a dependency for a one-
// shot script.
function parseCsvLine(line) {
  const out = [];
  let i = 0;
  let field = '';
  let inQuotes = false;
  while (i < line.length) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ',') { out.push(field); field = ''; i++; continue; }
    field += ch; i++;
  }
  out.push(field);
  return out;
}

// Parses a Theta EOD greeks CSV into an array of lightweight row
// objects. Only the fields the ATM extractor needs are surfaced; the
// other 38 columns (greeks, d1/d2, dual_*, etc.) are dropped here so
// downstream code never has to worry about them.
export function parseEodCsv(csvText) {
  const lines = csvText.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return [];
  const header = parseCsvLine(lines[0]);
  const idx = {
    symbol:           header.indexOf('symbol'),
    expiration:       header.indexOf('expiration'),
    strike:           header.indexOf('strike'),
    right:            header.indexOf('right'),
    bid:              header.indexOf('bid'),
    ask:              header.indexOf('ask'),
    close:            header.indexOf('close'),
    implied_vol:      header.indexOf('implied_vol'),
    underlying_price: header.indexOf('underlying_price'),
  };
  for (const [k, v] of Object.entries(idx)) {
    if (v < 0) throw new Error(`theta EOD CSV missing column: ${k}`);
  }
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = parseCsvLine(lines[i]);
    rows.push({
      symbol:          parts[idx.symbol].replace(/^"|"$/g, ''),
      expiration:      parts[idx.expiration].replace(/^"|"$/g, ''),
      strike:          Number(parts[idx.strike]),
      right:           parts[idx.right].replace(/^"|"$/g, ''),
      bid:             Number(parts[idx.bid]),
      ask:             Number(parts[idx.ask]),
      close:           Number(parts[idx.close]),
      implied_vol:     Number(parts[idx.implied_vol]),
      underlyingPrice: Number(parts[idx.underlying_price]),
    });
  }
  return rows;
}

export function createThetaEodClient({ baseUrl = DEFAULT_BASE_URL, fetchImpl = fetch } = {}) {
  async function fetchCsvForDay({ symbol = 'SPXW', date }) {
    const compact = toCompactDate(date);
    const url = `${baseUrl}/v3/option/history/greeks/eod?symbol=${symbol}&expiration=*&start_date=${compact}&end_date=${compact}`;
    const res = await fetchImpl(url, { method: 'GET' });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`theta EOD ${date} HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    return res.text();
  }

  async function fetchRowsForDay({ symbol = 'SPXW', date }) {
    const csv = await fetchCsvForDay({ symbol, date });
    return parseEodCsv(csv);
  }

  return { fetchCsvForDay, fetchRowsForDay };
}
