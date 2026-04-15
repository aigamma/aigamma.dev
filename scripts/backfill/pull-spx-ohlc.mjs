#!/usr/bin/env node
// SPX index EOD OHLC backfill — Step 1 of the Volatility Risk Premium
// model. Pulls daily OHLC for the SPX index (not SPXW options) from
// ThetaData v3 /v3/index/history/eod and upserts each row into
// daily_volatility_stats. The Yang-Zhang realized-vol computation
// in compute-vol-stats.mjs consumes these rows.
//
// ThetaData's v3 index EOD endpoint returns CSV with columns:
//   created,last_trade,open,high,low,close,volume,count,bid_*,ask_*
// For an index, volume/bid/ask are always zero — we only keep OHLC and
// derive the trading date from the `last_trade` ISO timestamp (the
// 16:02 ET print on the close, in ET wall-clock).
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
//   node scripts/backfill/pull-spx-ohlc.mjs [--start YYYY-MM-DD] [--end YYYY-MM-DD]
//
// Defaults match the term-structure backfill window so the VRP model
// lines up 1:1 with the existing 30d constant-maturity IV series.

import process from 'node:process';
import { createBackfillWriter } from './supabase-writer.mjs';

const DEFAULT_START = '2025-04-14';
const DEFAULT_END   = '2026-04-11';
const DEFAULT_THETA = 'http://127.0.0.1:25503';

function parseArgs(argv) {
  const out = { start: DEFAULT_START, end: DEFAULT_END };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--start') out.start = argv[++i];
    else if (a === '--end') out.end = argv[++i];
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

// last_trade is an ET wall-clock ISO string (e.g. 2026-04-10T16:02:52.000).
// The date portion is the trading date — no timezone conversion needed
// because ThetaData emits it already in ET and SPX closes at 16:00 ET.
function extractTradingDate(lastTrade) {
  if (!lastTrade || typeof lastTrade !== 'string') return null;
  const datePart = lastTrade.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(datePart) ? datePart : null;
}

function parseIndexEodCsv(csvText) {
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
    rows.push({
      trading_date: tradingDate,
      spx_open: open,
      spx_high: high,
      spx_low: low,
      spx_close: close,
    });
  }
  return rows;
}

async function fetchSpxOhlc(baseUrl, startIso, endIso) {
  const url = `${baseUrl}/v3/index/history/eod?symbol=SPX&start_date=${toCompactDate(startIso)}&end_date=${toCompactDate(endIso)}`;
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`theta index EOD HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  return parseIndexEodCsv(await res.text());
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !serviceKey) {
    log('spx_ohlc.missing_env', { need: ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY'] });
    process.exit(2);
  }

  const writer = createBackfillWriter({ url, serviceKey });
  const baseUrl = process.env.THETA_BASE_URL || DEFAULT_THETA;

  log('spx_ohlc.start', { start: args.start, end: args.end, theta: baseUrl });

  let rows;
  try {
    rows = await fetchSpxOhlc(baseUrl, args.start, args.end);
  } catch (err) {
    log('spx_ohlc.fetch_failed', { error: String(err) });
    process.exit(1);
  }
  log('spx_ohlc.fetched', { rows: rows.length });

  if (rows.length === 0) {
    log('spx_ohlc.no_rows');
    process.exit(1);
  }

  try {
    await writer.upsertDailyVolatilityOhlc(rows);
  } catch (err) {
    log('spx_ohlc.write_failed', { error: String(err) });
    process.exit(1);
  }

  log('spx_ohlc.done', {
    rows: rows.length,
    first: rows[0].trading_date,
    last: rows[rows.length - 1].trading_date,
  });
}

main().catch((err) => {
  log('spx_ohlc.fatal', { error: String(err), stack: err?.stack });
  process.exit(1);
});
