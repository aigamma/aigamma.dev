#!/usr/bin/env node
// index-daily-eod.mjs — multi-symbol EOD backfill for the /rotations lab.
//
// Pulls ThetaData /v3/index/history/eod for every symbol in DEFAULT_SYMBOLS
// (the ThetaData Index Standard universe with current 2026-Apr coverage)
// and upserts rows into public.index_daily_eod, one row per (symbol,
// trading_date). The /rotations Relative Rotation Graph reads from this
// table to compute JdK RS-Ratio and RS-Momentum vs SPX.
//
// The symbol list was filtered down from ThetaData's /v3/index/list/symbols
// (13,201 entries) by probing each candidate against the EOD endpoint for
// the most recent week — anything that returned "No data found for your
// request" was dropped, plus a few duplicates of SPX in mini form (XSP).
// The reference visual at C:\i\ shows a sector-ETF universe (XBI, XLF,
// XLK, ...) which isn't reachable at the Index Standard tier — sector
// ETFs are equities, not indices. The chosen substitutes are:
//   - Cap-weight indices: SPX (benchmark), OEX, DJX, RUT, RUI
//   - CBOE strategy indices on SPX: BXM, BXY, BXMC, BXMD, PUT, PPUT,
//     CLL, CMBO, CNDR — these are derivative-overlay strategies (covered
//     calls at multiple deltas, put-write at multiple strikes, collars,
//     iron condors) that read as "S&P 500 with strategy X applied", and
//     their RRG positions answer "which derivative strategy is leading
//     the underlying index right now?"
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
//   node scripts/backfill/index-daily-eod.mjs \
//        [--start YYYY-MM-DD] [--end YYYY-MM-DD] \
//        [--symbols SPX,RUT,...] [--force]
//
// Defaults to a 2-year backfill (~504 trading days) ending today (ET) so
// the RRG has enough history to compute 1-year rolling normalizations
// without ever hitting the start of the table. Already-present
// (symbol, trading_date) pairs are skipped unless --force is set, so
// re-running is safe and incremental.

import process from 'node:process';

const DEFAULT_THETA = 'http://127.0.0.1:25503';
const DEFAULT_LOOKBACK_CALENDAR_DAYS = 730; // ~2 years

// Universe verified against the ThetaData v3 /v3/index/history/eod endpoint
// on 2026-04-24 — every symbol below returned a CSV row dated 2026-04-23.
// The benchmark (SPX) is first. Symbols flagged with no current-data
// coverage on Index Standard (NDX, RUA, NYA, etc.) are excluded.
const DEFAULT_SYMBOLS = [
  // Benchmark + cap-weight peers. SPX is the primary reference; OEX is
  // mega-cap (top 100 of S&P 500), RUI is broad large-cap (Russell 1000),
  // RUT is small-cap (Russell 2000), DJX is the Dow Industrials / 100.
  'SPX', 'OEX', 'RUI', 'RUT', 'DJX',
  // CBOE-published S&P 500 derivative-strategy benchmarks. Each tracks the
  // index with a specific overlay — buy-write covered calls (BXM, BXY,
  // BXMC, BXMD), put-write (PUT, PPUT), collars (CLL), multi-asset (CMBO),
  // iron condor (CNDR). Their RRG positions vs SPX show which derivative
  // strategy is leading the underlying right now.
  'BXM', 'BXY', 'BXMC', 'BXMD',
  'PUT', 'PPUT',
  'CLL', 'CMBO', 'CNDR',
];

function parseArgs(argv) {
  const out = { start: null, end: null, force: false, symbols: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--start') out.start = argv[++i];
    else if (a === '--end') out.end = argv[++i];
    else if (a === '--force') out.force = true;
    else if (a === '--symbols') out.symbols = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
  }
  return out;
}

const log = (event, data = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));

function toCompactDate(iso) {
  return iso.replaceAll('-', '');
}

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

// last_trade is an ET wall-clock ISO string (e.g. 2026-04-23T16:03:50.000).
// The date portion is the trading date — no timezone conversion needed
// because ThetaData emits it already in ET and the cash-index close prints
// at 16:00 ET.
function extractTradingDate(lastTrade) {
  if (!lastTrade || typeof lastTrade !== 'string') return null;
  const datePart = lastTrade.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(datePart) ? datePart : null;
}

function parseIndexEodCsv(csvText) {
  // Theta returns "No data found for your request" when the symbol has no
  // rows in the requested window — handle that gracefully so a single
  // missing-week symbol doesn't kill the whole run.
  if (!csvText || csvText.startsWith('No data')) return [];
  const lines = csvText.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return [];
  const header = parseCsvLine(lines[0]);
  const idx = {
    last_trade: header.indexOf('last_trade'),
    open:       header.indexOf('open'),
    high:       header.indexOf('high'),
    low:        header.indexOf('low'),
    close:      header.indexOf('close'),
  };
  for (const [k, v] of Object.entries(idx)) {
    if (v < 0) throw new Error(`theta index EOD CSV missing column: ${k}`);
  }
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = parseCsvLine(lines[i]);
    const tradingDate = extractTradingDate(parts[idx.last_trade]);
    if (!tradingDate) continue;
    const open = Number(parts[idx.open]);
    const high = Number(parts[idx.high]);
    const low = Number(parts[idx.low]);
    const close = Number(parts[idx.close]);
    if (![open, high, low, close].every(Number.isFinite)) continue;
    if ([open, high, low, close].some((v) => v <= 0)) continue;
    rows.push({ trading_date: tradingDate, open, high, low, close });
  }
  return rows;
}

async function fetchIndexEod(baseUrl, symbol, startIso, endIso) {
  const url = `${baseUrl}/v3/index/history/eod?symbol=${encodeURIComponent(symbol)}&start_date=${toCompactDate(startIso)}&end_date=${toCompactDate(endIso)}`;
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`theta index EOD HTTP ${res.status} for ${symbol}: ${body.slice(0, 300)}`);
  }
  return parseIndexEodCsv(await res.text());
}

function addDaysIso(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function etTodayIso() {
  const now = new Date();
  const etParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const y = etParts.find((p) => p.type === 'year').value;
  const m = etParts.find((p) => p.type === 'month').value;
  const d = etParts.find((p) => p.type === 'day').value;
  return `${y}-${m}-${d}`;
}

// ThetaData v3 /v3/index/history/eod caps single requests at ~365 calendar
// days. Chunk to 360 to leave a 5-day safety margin. A 2-year backfill
// fits in 2-3 chunks per symbol.
const CHUNK_DAYS = 360;

async function fetchSymbolChunked(baseUrl, symbol, startIso, endIso) {
  const all = [];
  let cursor = startIso;
  while (cursor <= endIso) {
    const tentativeEnd = addDaysIso(cursor, CHUNK_DAYS - 1);
    const chunkEnd = tentativeEnd > endIso ? endIso : tentativeEnd;
    const rows = await fetchIndexEod(baseUrl, symbol, cursor, chunkEnd);
    all.push(...rows);
    cursor = addDaysIso(chunkEnd, 1);
  }
  // De-duplicate on trading_date — overlapping chunks would otherwise
  // double-count, though the chunk math above is non-overlapping.
  return [...new Map(all.map((r) => [r.trading_date, r])).values()];
}

// PostgREST upsert. Uses the same Prefer header pattern as supabase-writer
// so re-runs against the (symbol, trading_date) primary key merge cleanly.
async function upsertIndexRows(supabaseUrl, serviceKey, rows) {
  if (rows.length === 0) return 0;
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates,return=minimal',
  };
  // Chunk the upsert into 1000-row batches so a 14-symbol × 504-day backfill
  // (~7000 rows) doesn't hit any payload limits.
  const BATCH = 1000;
  let written = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const res = await fetch(`${supabaseUrl}/rest/v1/index_daily_eod`, {
      method: 'POST',
      headers,
      body: JSON.stringify(slice),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`supabase upsert index_daily_eod failed: ${res.status} ${body.slice(0, 300)}`);
    }
    written += slice.length;
  }
  return written;
}

// Returns a Set of (symbol, trading_date) keys already present, so the
// caller can skip them. Pages through PostgREST's 1000-row response cap
// the same way supabase-writer.mjs does for the existing tables.
async function getExistingSymbolDates(supabaseUrl, serviceKey) {
  const PAGE_SIZE = 1000;
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
  };
  const set = new Set();
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const end = offset + PAGE_SIZE - 1;
    const res = await fetch(
      `${supabaseUrl}/rest/v1/index_daily_eod?select=symbol,trading_date&order=symbol.asc,trading_date.asc`,
      { headers: { ...headers, Range: `${offset}-${end}`, 'Range-Unit': 'items' } },
    );
    if (!res.ok && res.status !== 206) {
      throw new Error(`supabase list index_daily_eod HTTP ${res.status}`);
    }
    const page = await res.json();
    if (!Array.isArray(page) || page.length === 0) break;
    for (const r of page) set.add(`${r.symbol}|${r.trading_date}`);
    if (page.length < PAGE_SIZE) break;
  }
  return set;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !serviceKey) {
    log('index_eod.missing_env', { need: ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY'] });
    process.exit(2);
  }

  const end = args.end ?? etTodayIso();
  const start = args.start ?? addDaysIso(end, -DEFAULT_LOOKBACK_CALENDAR_DAYS);
  const symbols = args.symbols ?? DEFAULT_SYMBOLS;
  const baseUrl = process.env.THETA_BASE_URL || DEFAULT_THETA;

  log('index_eod.start', {
    start, end, theta: baseUrl, force: args.force, symbols,
  });

  // Resolve existing rows once up front so we can subtract them per-symbol
  // before deciding which dates to ship to Postgres. On a cold backfill
  // the set is empty and every fetched row writes; on a daily incremental
  // run the set covers ~99% and only the latest few days fall through.
  let existing = args.force ? new Set() : await getExistingSymbolDates(url, serviceKey);
  log('index_eod.existing_loaded', { rows: existing.size });

  let totalFetched = 0;
  let totalWritten = 0;
  const perSymbol = {};

  for (const sym of symbols) {
    let rows;
    try {
      rows = await fetchSymbolChunked(baseUrl, sym, start, end);
    } catch (err) {
      log('index_eod.fetch_failed', { symbol: sym, error: String(err) });
      continue;
    }
    totalFetched += rows.length;

    let toWrite = rows.map((r) => ({ symbol: sym, ...r }));
    if (!args.force) {
      toWrite = toWrite.filter((r) => !existing.has(`${r.symbol}|${r.trading_date}`));
    }

    if (toWrite.length === 0) {
      log('index_eod.symbol_skip', { symbol: sym, fetched: rows.length });
      perSymbol[sym] = { fetched: rows.length, written: 0 };
      continue;
    }

    try {
      const n = await upsertIndexRows(url, serviceKey, toWrite);
      totalWritten += n;
      perSymbol[sym] = {
        fetched: rows.length,
        written: n,
        first: toWrite[0].trading_date,
        last: toWrite[toWrite.length - 1].trading_date,
      };
      log('index_eod.symbol_done', { symbol: sym, ...perSymbol[sym] });
    } catch (err) {
      log('index_eod.write_failed', { symbol: sym, error: String(err) });
    }
  }

  log('index_eod.done', {
    symbols: symbols.length,
    fetched_rows: totalFetched,
    written_rows: totalWritten,
    perSymbol,
  });
}

main().catch((err) => {
  log('index_eod.fatal', { error: String(err), stack: err?.stack });
  process.exit(1);
});
