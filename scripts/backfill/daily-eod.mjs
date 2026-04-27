#!/usr/bin/env node
// daily-eod.mjs — multi-symbol EOD backfill for the /rotations lab.
//
// Pulls ThetaData EOD prices for every symbol in DEFAULT_SYMBOLS and
// upserts rows into public.daily_eod, one row per (symbol, trading_date).
// Supports two ThetaData endpoints based on each symbol's kind:
//
//   - kind='index'  →  /v3/index/history/eod  (Index Standard tier)
//   - kind='stock'  →  /v3/stock/history/eod  (Stock Value tier — note the
//                       account upgraded from Stock Free to Stock Value
//                       on 2026-04-25; the EOD endpoint works on both
//                       tiers, but Stock Value also unlocks intraday
//                       OHLC, Greeks, IV, and quote endpoints if a
//                       follow-up surface ever needs them).
//
// Both endpoints return CSV with the same first-six columns this script
// cares about: created, last_trade, open, high, low, close. Differences
// downstream (volume, NBBO, market-maker fields) are non-zero on stocks
// and zero on indices, but neither is persisted to public.daily_eod.
//
// The /rotations Relative Sector Rotation page reads from this table to
// compute the rotation ratio and rotation momentum of every component
// vs the SPY benchmark. The default universe matches the reference
// chart at C:\i\: SPY (benchmark) plus the eleven SPDR sector ETFs and
// three additional theme ETFs that appear on that chart. The reference
// image's "$713.94" SPY readout matches the ThetaData close for SPY on
// 2026-04-24 exactly, confirming this is the right symbol set.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
//   node scripts/backfill/daily-eod.mjs \
//        [--start YYYY-MM-DD] [--end YYYY-MM-DD] \
//        [--symbols SPY,XLF,...] [--force]
//
// Defaults to a 2-year backfill (~504 trading days) ending today (ET) so
// the rotation chart has enough history for the 63-day standardization
// window without ever hitting the start of the table. Already-present
// (symbol, trading_date) pairs are skipped unless --force is set.

import process from 'node:process';

const DEFAULT_THETA = 'http://127.0.0.1:25503';
const DEFAULT_LOOKBACK_CALENDAR_DAYS = 730; // ~2 years

// Reference universe combines two sets:
//
//   /rotations consumers (15 symbols): SPY benchmark plus the eleven
//   SPDR sector ETFs (XLB, XLC, XLE, XLF, XLI, XLK, XLP, XLRE, XLU,
//   XLV, XLY) and three additional theme ETFs that appear on the
//   reference chart at C:\i\ (XBI biotech, XME metals & mining, KWEB
//   China internet).
//
//   /stocks consumers (20 symbols): the twenty top option-volume
//   single-name stocks curated for the Stock Performance bar trio
//   (eleven names: NVDA, TSLA, INTC, AMD, AMZN, AAPL, MU, MSFT, MSTR,
//   META, PLTR) and the Relative Stock Rotations scatter (those eleven
//   plus GOOGL, ORCL, NFLX, AVGO, TSM, QCOM, MRVL, HOOD, COIN). Both
//   surfaces share the same SPY benchmark above so a reader can
//   compare single-name relative strength against sector relative
//   strength on the same axis convention.
//
// Each symbol's `kind` decides which ThetaData endpoint the fetcher
// hits — sector ETFs and single-name stocks both go through
// /v3/stock/history/eod (Stock Value tier on this account as of
// 2026-04-25). ThetaData's index/list/symbols endpoint includes a
// few sector-flavored entries (SP500-10 through SP500-60, the GICS-
// coded S&P 500 sector indices) but those returned no current data
// in probe runs and were excluded earlier; the actual ETFs at
// /v3/stock/history/eod do have current 2026-04-24 coverage.
const DEFAULT_SYMBOLS = [
  { symbol: 'SPY',   kind: 'stock' },
  // Sector rotation universe (/rotations).
  { symbol: 'XBI',   kind: 'stock' },
  { symbol: 'XLB',   kind: 'stock' },
  { symbol: 'XLC',   kind: 'stock' },
  { symbol: 'XLE',   kind: 'stock' },
  { symbol: 'XLF',   kind: 'stock' },
  { symbol: 'XLI',   kind: 'stock' },
  { symbol: 'XLK',   kind: 'stock' },
  { symbol: 'XLP',   kind: 'stock' },
  { symbol: 'XLRE',  kind: 'stock' },
  { symbol: 'XLU',   kind: 'stock' },
  { symbol: 'XLV',   kind: 'stock' },
  { symbol: 'XLY',   kind: 'stock' },
  { symbol: 'XME',   kind: 'stock' },
  { symbol: 'KWEB',  kind: 'stock' },
  // Single-name stock universe (/stocks).
  { symbol: 'NVDA',  kind: 'stock' },
  { symbol: 'TSLA',  kind: 'stock' },
  { symbol: 'INTC',  kind: 'stock' },
  { symbol: 'AMD',   kind: 'stock' },
  { symbol: 'AMZN',  kind: 'stock' },
  { symbol: 'AAPL',  kind: 'stock' },
  { symbol: 'MU',    kind: 'stock' },
  { symbol: 'MSFT',  kind: 'stock' },
  { symbol: 'MSTR',  kind: 'stock' },
  { symbol: 'META',  kind: 'stock' },
  { symbol: 'PLTR',  kind: 'stock' },
  { symbol: 'GOOGL', kind: 'stock' },
  { symbol: 'ORCL',  kind: 'stock' },
  { symbol: 'NFLX',  kind: 'stock' },
  { symbol: 'AVGO',  kind: 'stock' },
  { symbol: 'TSM',   kind: 'stock' },
  { symbol: 'QCOM',  kind: 'stock' },
  { symbol: 'MRVL',  kind: 'stock' },
  { symbol: 'HOOD',  kind: 'stock' },
  { symbol: 'COIN',  kind: 'stock' },
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

// last_trade is an ET wall-clock ISO string (e.g. 2026-04-24T17:14:31.483
// for stocks, 2026-04-23T16:03:50.000 for indices). The date portion is
// the trading date — no timezone conversion needed because ThetaData
// emits it already in ET. Stock prints arrive at 17:1X (post-close
// auction) while index prints arrive at 16:0X (cash close); the date
// part is the same for both.
function extractTradingDate(lastTrade) {
  if (!lastTrade || typeof lastTrade !== 'string') return null;
  const datePart = lastTrade.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(datePart) ? datePart : null;
}

function parseEodCsv(csvText) {
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
    if (v < 0) throw new Error(`theta EOD CSV missing column: ${k}`);
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

function endpointFor(kind) {
  if (kind === 'stock') return '/v3/stock/history/eod';
  if (kind === 'index') return '/v3/index/history/eod';
  throw new Error(`Unknown symbol kind: ${kind}`);
}

async function fetchEod(baseUrl, symbol, kind, startIso, endIso) {
  const url = `${baseUrl}${endpointFor(kind)}?symbol=${encodeURIComponent(symbol)}&start_date=${toCompactDate(startIso)}&end_date=${toCompactDate(endIso)}`;
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`theta EOD HTTP ${res.status} for ${symbol} (${kind}): ${body.slice(0, 300)}`);
  }
  return parseEodCsv(await res.text());
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

// Both EOD endpoints cap single requests at ~365 calendar days. Chunk to
// 360 to leave a 5-day safety margin.
const CHUNK_DAYS = 360;

async function fetchSymbolChunked(baseUrl, symbol, kind, startIso, endIso) {
  const all = [];
  let cursor = startIso;
  while (cursor <= endIso) {
    const tentativeEnd = addDaysIso(cursor, CHUNK_DAYS - 1);
    const chunkEnd = tentativeEnd > endIso ? endIso : tentativeEnd;
    const rows = await fetchEod(baseUrl, symbol, kind, cursor, chunkEnd);
    all.push(...rows);
    cursor = addDaysIso(chunkEnd, 1);
  }
  return [...new Map(all.map((r) => [r.trading_date, r])).values()];
}

async function upsertRows(supabaseUrl, serviceKey, rows) {
  if (rows.length === 0) return 0;
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates,return=minimal',
  };
  const BATCH = 1000;
  let written = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const res = await fetch(`${supabaseUrl}/rest/v1/daily_eod`, {
      method: 'POST',
      headers,
      body: JSON.stringify(slice),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`supabase upsert daily_eod failed: ${res.status} ${body.slice(0, 300)}`);
    }
    written += slice.length;
  }
  return written;
}

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
      `${supabaseUrl}/rest/v1/daily_eod?select=symbol,trading_date&order=symbol.asc,trading_date.asc`,
      { headers: { ...headers, Range: `${offset}-${end}`, 'Range-Unit': 'items' } },
    );
    if (!res.ok && res.status !== 206) {
      throw new Error(`supabase list daily_eod HTTP ${res.status}`);
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
    log('eod.missing_env', { need: ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY'] });
    process.exit(2);
  }

  const end = args.end ?? etTodayIso();
  const start = args.start ?? addDaysIso(end, -DEFAULT_LOOKBACK_CALENDAR_DAYS);

  // If --symbols is passed, look up the kind from DEFAULT_SYMBOLS by name;
  // unknown symbols default to 'stock' since most ad-hoc additions to a
  // rotation universe are equity ETFs. To force kind='index' for an
  // ad-hoc symbol, edit DEFAULT_SYMBOLS rather than passing --symbols.
  let universe = DEFAULT_SYMBOLS;
  if (args.symbols) {
    const known = new Map(DEFAULT_SYMBOLS.map((s) => [s.symbol, s.kind]));
    universe = args.symbols.map((sym) => ({
      symbol: sym,
      kind: known.get(sym) ?? 'stock',
    }));
  }

  const baseUrl = process.env.THETA_BASE_URL || DEFAULT_THETA;

  log('eod.start', {
    start, end, theta: baseUrl, force: args.force,
    symbols: universe.map((u) => `${u.symbol}(${u.kind})`),
  });

  let existing = args.force ? new Set() : await getExistingSymbolDates(url, serviceKey);
  log('eod.existing_loaded', { rows: existing.size });

  let totalFetched = 0;
  let totalWritten = 0;
  const perSymbol = {};

  for (const { symbol, kind } of universe) {
    let rows;
    try {
      rows = await fetchSymbolChunked(baseUrl, symbol, kind, start, end);
    } catch (err) {
      log('eod.fetch_failed', { symbol, kind, error: String(err) });
      continue;
    }
    totalFetched += rows.length;

    let toWrite = rows.map((r) => ({ symbol, ...r }));
    if (!args.force) {
      toWrite = toWrite.filter((r) => !existing.has(`${r.symbol}|${r.trading_date}`));
    }

    if (toWrite.length === 0) {
      log('eod.symbol_skip', { symbol, kind, fetched: rows.length });
      perSymbol[symbol] = { fetched: rows.length, written: 0 };
      continue;
    }

    try {
      const n = await upsertRows(url, serviceKey, toWrite);
      totalWritten += n;
      perSymbol[symbol] = {
        kind,
        fetched: rows.length,
        written: n,
        first: toWrite[0].trading_date,
        last: toWrite[toWrite.length - 1].trading_date,
      };
      log('eod.symbol_done', { symbol, ...perSymbol[symbol] });
    } catch (err) {
      log('eod.write_failed', { symbol, kind, error: String(err) });
    }
  }

  log('eod.done', {
    symbols: universe.length,
    fetched_rows: totalFetched,
    written_rows: totalWritten,
    perSymbol,
  });
}

main().catch((err) => {
  log('eod.fatal', { error: String(err), stack: err?.stack });
  process.exit(1);
});
