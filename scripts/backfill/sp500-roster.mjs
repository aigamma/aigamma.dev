#!/usr/bin/env node
// sp500-roster.mjs — generate src/data/sp500-roster.json from the public
// SSGA SPY holdings xlsx.
//
// SPY tracks the S&P 500 1:1 by index methodology, so its daily holdings
// file IS the canonical SPX constituent list — same names, same float-
// adjusted market-cap weights. The file is a public regulatory
// disclosure published every trading day at:
//
//   https://www.ssga.com/library-content/products/fund-data/etfs/us/holdings-daily-us-en-spy.xlsx
//
// CORS-open (Access-Control-Allow-Origin: *), ~54 KB, refreshed once per
// trading session. The /heatmap surface needs four things per name —
// ticker, name, GICS sector, market-cap weight — that no market-data
// vendor at the project's current tier provides (ThetaData has no
// fundamentals or constituent endpoints; Massive's ticker-overview is
// single-call so a 500-name pull is 500 round-trips).
//
// Two-source join: SSGA's xlsx supplies ticker, name, weight, and
// shares held but NOT GICS sector — every Sector cell in the file is
// literally "-" as of the 23-Apr-2026 snapshot, so SSGA appears to
// have stopped publishing the sector column despite the header still
// reading "Sector". GICS sector classification comes from the
// community-maintained constituent CSV at
// https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv
// which is updated within days of any index reconstitution and uses
// the same ticker formatting as SSGA (BRK.B, BF.B, GOOGL, etc.).
// Names not present in the CSV (recently-added SPY holdings or
// pseudo-holdings like CASH_USD) fall back to sector "Other".
//
// This script runs ad hoc to refresh the static roster. SP500 membership
// changes ~5-10 names per year (corporate actions, additions/removals
// at quarterly index reviews); weights drift continuously but only the
// top ~30 names move enough between weekly snapshots to alter the
// treemap's visual hierarchy. Re-running monthly or after any reported
// index reconstitution keeps the roster fresh enough.
//
// The xlsx parser here is intentionally minimal — Office Open XML SHEET
// uses a small subset of the spec for SSGA's flat tables (one sheet,
// shared-strings table, no styles math, no formulas), so a ~120-line
// streaming reader covers it without pulling in a 1+ MB xlsx package.
// The script reads the central directory to find sheet1.xml and
// sharedStrings.xml entries, inflates them with zlib.inflateRaw, and
// regex-walks the resulting XML for <c> cells in <row r="N"> records.
// Cells with t="s" are shared-string indices; cells with t="n" or no t
// attribute are inline numbers.
//
// Usage:
//   node scripts/backfill/sp500-roster.mjs [--out src/data/sp500-roster.json]
//
// Writes JSON of the form:
//   { generatedAt, asOf, source, count,
//     holdings: [{symbol, name, sector, weight, sharesHeld}, ...] }
//
// Exit code is 1 on parse failure / network failure / less than 400 rows
// (a full S&P 500 should yield 500-505; less than 400 means the parser
// missed columns and should not silently overwrite the existing JSON).

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import process from 'node:process';

const SSGA_URL = 'https://www.ssga.com/library-content/products/fund-data/etfs/us/holdings-daily-us-en-spy.xlsx';
const SECTORS_CSV_URL = 'https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv';
const DEFAULT_OUT = 'src/data/sp500-roster.json';
const MIN_EXPECTED_ROWS = 400;

const log = (event, data = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));

function parseArgs(argv) {
  const out = { outPath: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.outPath = argv[++i];
  }
  return out;
}

// Minimal Office Open XML zip reader. Locates the End-Of-Central-Directory
// record, walks the central directory, and inflates the two entries we
// care about (worksheets/sheet1.xml + sharedStrings.xml). Skips signature
// validation beyond the magic bytes — SSGA's file is reliably well-formed.
function readZipEntries(buf) {
  // Find EOCD signature 0x06054b50 by walking backward from the end.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 65557; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip: EOCD not found');
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const cdEnd = cdOffset + cdSize;

  const entries = new Map();
  let p = cdOffset;
  while (p < cdEnd) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`zip: CD sig at ${p}`);
    const compMethod = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    // Read the local file header to get the actual data offset (extra
    // field length differs between central and local headers).
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`zip: LFH sig for ${name}`);
    const lfhNameLen = buf.readUInt16LE(localOffset + 26);
    const lfhExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lfhNameLen + lfhExtraLen;
    const dataEnd = dataStart + compSize;
    entries.set(name, { compMethod, dataStart, dataEnd });
    p += 46 + nameLen + extraLen + commentLen;
  }

  const decode = (name) => {
    const e = entries.get(name);
    if (!e) throw new Error(`zip: missing entry ${name}`);
    const slice = buf.subarray(e.dataStart, e.dataEnd);
    if (e.compMethod === 0) return slice; // stored
    if (e.compMethod === 8) return inflateRawSync(slice); // deflate
    throw new Error(`zip: unsupported method ${e.compMethod} for ${name}`);
  };
  return { entries, decode };
}

// Parse sharedStrings.xml. Each <si> entry is a unique string. Strings
// can be a single <t> or split across multiple <r><t>...</t></r> runs
// (rich text); we concatenate all <t> children of each <si>.
function parseSharedStrings(xml) {
  const result = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
  let m;
  while ((m = siRe.exec(xml)) !== null) {
    let combined = '';
    let mt;
    tRe.lastIndex = 0;
    while ((mt = tRe.exec(m[1])) !== null) {
      combined += decodeXmlEntities(mt[1]);
    }
    result.push(combined);
  }
  return result;
}

function decodeXmlEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

// Parse worksheets/sheet1.xml into a per-row map of {col: value}, where
// col is the column letter ("A", "B", ...) and value is either a number
// (for t="n") or a string (for t="s", looked up against sharedStrings).
function parseSheetRows(xml, sharedStrings) {
  const rows = new Map();
  const rowRe = /<row\s[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  const cellRe = /<c\s[^>]*r="([A-Z]+)\d+"(?:[^>]*\st="([^"]+)")?[^>]*>([\s\S]*?)<\/c>/g;
  const valRe = /<v>([\s\S]*?)<\/v>/;
  let m;
  while ((m = rowRe.exec(xml)) !== null) {
    const r = Number(m[1]);
    const inner = m[2];
    const cells = {};
    let mc;
    cellRe.lastIndex = 0;
    while ((mc = cellRe.exec(inner)) !== null) {
      const col = mc[1];
      const t = mc[2] || 'n';
      const vMatch = valRe.exec(mc[3]);
      if (!vMatch) continue;
      const raw = vMatch[1];
      if (t === 's') {
        const idx = Number(raw);
        cells[col] = sharedStrings[idx] ?? '';
      } else if (t === 'n' || t === undefined) {
        cells[col] = Number(raw);
      } else {
        cells[col] = decodeXmlEntities(raw);
      }
    }
    rows.set(r, cells);
  }
  return rows;
}

// SSGA's sheet layout (verified Apr 24 2026 file):
//   row 2: A="Ticker Symbol:", B="SPY"
//   row 3: A="Holdings:", B="<as-of date>"
//   row 5: header row — A=Name, B=Ticker, C=Identifier (CUSIP), D=SEDOL,
//                       E=Weight (%), F=Sector, G=Shares Held, H=Currency
//   row 6+: holdings, descending by weight
function extractHoldings(rows) {
  const header = rows.get(5);
  if (!header) throw new Error('sheet: header row 5 missing');
  // Fixed positions per the SSGA layout above. Verified by spot-check —
  // top holding's ticker should be a recognizable mega-cap (NVDA / AAPL /
  // MSFT family) and weight should be 5-10% of fund.
  const colName = 'A', colTicker = 'B', colWeight = 'E', colSector = 'F', colShares = 'G';
  if (!/Ticker/i.test(String(header[colTicker]))) {
    throw new Error(`sheet: column ${colTicker} header not a ticker label: ${header[colTicker]}`);
  }
  if (!/Sector/i.test(String(header[colSector]))) {
    throw new Error(`sheet: column ${colSector} header not a sector label: ${header[colSector]}`);
  }
  if (!/Weight/i.test(String(header[colWeight]))) {
    throw new Error(`sheet: column ${colWeight} header not a weight label: ${header[colWeight]}`);
  }

  const holdings = [];
  // Walk every row >= 6. Stop on the first all-empty / footer row that
  // has no ticker — SSGA appends a few disclaimer rows below the table.
  const sortedRowKeys = [...rows.keys()].filter((r) => r >= 6).sort((a, b) => a - b);
  for (const r of sortedRowKeys) {
    const row = rows.get(r);
    const ticker = String(row[colTicker] ?? '').trim();
    if (!ticker) continue;
    // Real S&P 500 tickers are 1-5 uppercase letters, optionally with a
    // single ".A" / ".B" / ".C" share-class suffix (BRK.B, BF.B, etc).
    // Anything else is an SSGA bookkeeping row — pseudo-tickers like
    // "-" for the cash position, "CASH_USD", or numeric internal IDs
    // like "2602335D" that show up as contra-holdings for adjustments.
    if (!/^[A-Z]{1,5}(\.[A-Z])?$/.test(ticker)) continue;
    const weight = Number(row[colWeight]);
    const sector = String(row[colSector] ?? '').trim() || 'Unclassified';
    const name = String(row[colName] ?? '').trim();
    const sharesHeld = Number(row[colShares] ?? 0);
    if (!Number.isFinite(weight) || weight <= 0) continue;
    holdings.push({
      symbol: ticker.replace(/\s+/g, '').toUpperCase(),
      name,
      sector,
      weight,
      sharesHeld: Number.isFinite(sharesHeld) ? sharesHeld : null,
    });
  }
  return holdings;
}

// Tiny CSV reader for the GitHub sectors file. Handles quoted fields
// (the headquarters column is comma-bearing and double-quote wrapped)
// but not embedded escapes — none appear in the constituents CSV.
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return { header: [], rows: [] };
  const splitLine = (line) => {
    const out = [];
    let field = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"') { inQ = false; continue; }
        field += ch;
      } else {
        if (ch === '"') { inQ = true; continue; }
        if (ch === ',') { out.push(field); field = ''; continue; }
        field += ch;
      }
    }
    out.push(field);
    return out;
  };
  const header = splitLine(lines[0]);
  const rows = lines.slice(1).map((l) => {
    const cells = splitLine(l);
    const row = {};
    for (let i = 0; i < header.length; i++) row[header[i]] = cells[i] ?? '';
    return row;
  });
  return { header, rows };
}

async function fetchSectorMap() {
  const res = await fetch(SECTORS_CSV_URL, {
    signal: AbortSignal.timeout(15000),
    headers: { 'User-Agent': 'aigamma-roster-script/1.0' },
  });
  if (!res.ok) throw new Error(`sectors CSV HTTP ${res.status}`);
  const text = await res.text();
  const { rows } = parseCsv(text);
  const map = new Map();
  for (const r of rows) {
    const sym = String(r['Symbol'] ?? '').trim().toUpperCase();
    const sector = String(r['GICS Sector'] ?? '').trim();
    const sub = String(r['GICS Sub-Industry'] ?? '').trim();
    if (sym && sector) map.set(sym, { sector, subIndustry: sub });
  }
  return map;
}

function extractAsOf(rows) {
  const r3 = rows.get(3);
  if (!r3) return null;
  for (const k of Object.keys(r3)) {
    const v = r3[k];
    if (k === 'A') continue;
    if (typeof v === 'number') {
      // Excel serial date (days since 1899-12-30). Convert to ISO.
      const ms = (v - 25569) * 86400000;
      const d = new Date(ms);
      if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    }
    if (typeof v === 'string' && /\d/.test(v)) return v;
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  log('roster.start', { url: SSGA_URL, out: args.outPath });

  const res = await fetch(SSGA_URL, {
    signal: AbortSignal.timeout(20000),
    headers: { 'User-Agent': 'aigamma-roster-script/1.0' },
  });
  if (!res.ok) {
    log('roster.fetch_failed', { status: res.status });
    process.exit(1);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  log('roster.fetched', { bytes: buf.length });

  let sharedStrings, sheetRows;
  try {
    const { decode } = readZipEntries(buf);
    const sharedXml = decode('xl/sharedStrings.xml').toString('utf8');
    const sheetXml = decode('xl/worksheets/sheet1.xml').toString('utf8');
    sharedStrings = parseSharedStrings(sharedXml);
    sheetRows = parseSheetRows(sheetXml, sharedStrings);
    log('roster.parsed', { sharedStrings: sharedStrings.length, rows: sheetRows.size });
  } catch (err) {
    log('roster.parse_failed', { error: String(err) });
    process.exit(1);
  }

  let holdings, asOf;
  try {
    holdings = extractHoldings(sheetRows);
    asOf = extractAsOf(sheetRows);
  } catch (err) {
    log('roster.extract_failed', { error: String(err) });
    process.exit(1);
  }

  // Join sectors. The CSV is the canonical S&P 500 list; SSGA's
  // holdings include cash and the occasional newly-added name that
  // hasn't propagated to the CSV yet. Anything missing falls back to
  // sector "Other" so the heatmap still has a tile to render.
  let sectorMap;
  try {
    sectorMap = await fetchSectorMap();
    log('roster.sectors_fetched', { count: sectorMap.size });
  } catch (err) {
    log('roster.sectors_failed', { error: String(err) });
    process.exit(1);
  }
  let unmatched = 0;
  for (const h of holdings) {
    const m = sectorMap.get(h.symbol);
    if (m) {
      h.sector = m.sector;
      h.subIndustry = m.subIndustry || null;
    } else {
      h.sector = 'Other';
      h.subIndustry = null;
      unmatched += 1;
    }
  }
  log('roster.sectors_joined', { unmatched });

  if (holdings.length < MIN_EXPECTED_ROWS) {
    log('roster.too_few', { count: holdings.length, min: MIN_EXPECTED_ROWS });
    process.exit(1);
  }

  // Sanity check the top holding to catch a column-shift parse bug —
  // SPY's #1 holding should have weight 5-10% and a recognizable mega-
  // cap ticker. If weight is below 1% the parser is reading the wrong
  // column and we should fail loudly rather than ship a broken roster.
  const top = holdings[0];
  if (!top || top.weight < 1) {
    log('roster.sanity_failed', { top });
    process.exit(1);
  }

  const totalWeight = holdings.reduce((s, h) => s + h.weight, 0);
  const sectorCounts = {};
  for (const h of holdings) sectorCounts[h.sector] = (sectorCounts[h.sector] || 0) + 1;

  const payload = {
    generatedAt: new Date().toISOString(),
    asOf,
    source: SSGA_URL,
    count: holdings.length,
    totalWeight: Math.round(totalWeight * 1000) / 1000,
    sectors: sectorCounts,
    holdings,
  };

  mkdirSync(dirname(args.outPath), { recursive: true });
  writeFileSync(args.outPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  log('roster.done', {
    out: args.outPath,
    count: holdings.length,
    totalWeight: payload.totalWeight,
    asOf,
    top3: holdings.slice(0, 3).map((h) => `${h.symbol}=${h.weight.toFixed(2)}%`),
  });
}

main().catch((err) => {
  log('roster.fatal', { error: String(err), stack: err?.stack });
  process.exit(1);
});
