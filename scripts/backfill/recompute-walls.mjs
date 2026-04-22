#!/usr/bin/env node
// scripts/backfill/recompute-walls.mjs
//
// Historical Put Wall and Call Wall backfill. For each trading date in
// [start, end], pulls ThetaData EOD Greeks + Open Interest for all SPX
// and SPXW contracts, buckets per-strike gross call GEX and gross put
// GEX using the same formula the live intraday pipeline uses
//   GEX_contract = gamma * OI * 100 * spot^2 * 0.01
// then finds the strike that maximizes (callGex - putGex) [Call Wall]
// and the strike that minimizes (callGex - putGex) [Put Wall]. The two
// levels are the dealer-positioning "ceiling above spot" and "floor
// below spot" that the ingest-background.mjs live loop computes at
// lines 388-404 on every Massive snapshot.
//
// Output: one JSONL row per day appended to
//   scripts/backfill/state/walls-recompute-results.jsonl
// containing { date, call_wall, put_wall, spot, contracts, computed_at }.
// Phase 2 reads this JSONL and issues a single bulk SQL UPDATE against
// daily_gex_stats — same two-phase pattern as recompute-vol-flip.mjs.
// Keeping Phase 1 Supabase-credential-free means the long ThetaData
// fetch can run even if the writer env is not loaded, and the JSONL
// is append-only so kill/restart is safe.
//
// Usage:
//   node scripts/backfill/recompute-walls.mjs [--start YYYY-MM-DD]
//     [--end YYYY-MM-DD] [--verify YYYY-MM-DD]
//
// Resumable: reads the JSONL on startup and skips dates already
// present. Safe to kill and restart at any point.

import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { tradingDaysBetween } from './trading-days.mjs';
import { expirationToIso } from './gamma-profile.mjs';

const DEFAULT_START = '2022-01-03';
const DEFAULT_END = new Date().toISOString().slice(0, 10);
const DEFAULT_THETA = 'http://127.0.0.1:25503';
const ROOTS = ['SPXW', 'SPX'];
const RESULTS_FILE = path.resolve('scripts/backfill/state/walls-recompute-results.jsonl');

function parseArgs(argv) {
  const out = { start: DEFAULT_START, end: DEFAULT_END, verifyDate: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--start') out.start = argv[++i];
    else if (a === '--end') out.end = argv[++i];
    else if (a === '--verify') out.verifyDate = argv[++i];
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
  let i = 0, field = '', inQuotes = false;
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

function parseCsv(csvText, requiredCols) {
  const lines = csvText.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return [];
  const header = parseCsvLine(lines[0]);
  const idx = {};
  for (const col of requiredCols) {
    const i = header.indexOf(col);
    if (i < 0) throw new Error(`CSV missing column: ${col}`);
    idx[col] = i;
  }
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = parseCsvLine(lines[i]);
    const row = {};
    for (const col of requiredCols) row[col] = parts[idx[col]];
    rows.push(row);
  }
  return rows;
}

async function fetchTextWithRetry(url, label, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('client timeout 180s')), 180000);
    try {
      const res = await fetch(url, { signal: ac.signal });
      if (res.status === 404) { clearTimeout(timer); return null; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      clearTimeout(timer);
      return text;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (i < attempts - 1) {
        const backoff = 2000 * Math.pow(2, i);
        log('fetch.retry', { label, attempt: i + 1, error: String(err), backoff_ms: backoff });
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }
  throw lastErr;
}

async function fetchGreeksEod(baseUrl, symbol, date) {
  const compact = toCompactDate(date);
  const url = `${baseUrl}/v3/option/history/greeks/eod?symbol=${symbol}&expiration=*&start_date=${compact}&end_date=${compact}`;
  const text = await fetchTextWithRetry(url, `greeks ${symbol} ${date}`);
  if (text === null) return [];
  return parseCsv(text, ['expiration', 'strike', 'right', 'gamma', 'underlying_price']);
}

async function fetchOI(baseUrl, symbol, date) {
  const compact = toCompactDate(date);
  const url = `${baseUrl}/v3/option/history/open_interest?symbol=${symbol}&expiration=*&start_date=${compact}&end_date=${compact}`;
  const text = await fetchTextWithRetry(url, `oi ${symbol} ${date}`);
  if (text === null) return [];
  return parseCsv(text, ['expiration', 'strike', 'right', 'open_interest']);
}

function joinChain(greeks, oiRows) {
  const oiMap = new Map();
  for (const r of oiRows) {
    const right = r.right.replace(/^"|"$/g, '');
    const key = `${r.expiration}|${r.strike}|${right}`;
    oiMap.set(key, Number(r.open_interest));
  }
  const joined = [];
  for (const g of greeks) {
    const right = g.right.replace(/^"|"$/g, '');
    const key = `${g.expiration}|${g.strike}|${right}`;
    const oi = oiMap.get(key);
    const gamma = Number(g.gamma);
    const K = Number(g.strike);
    const upx = Number(g.underlying_price);
    if (!(oi > 0) || !(gamma > 0) || !(K > 0) || !(upx > 0)) continue;
    joined.push({
      strike: K,
      right,
      gamma,
      oi,
      expiration: expirationToIso(g.expiration),
      underlyingPrice: upx,
    });
  }
  return joined;
}

function pickSpotPrice(contracts) {
  for (const c of contracts) if (c.underlyingPrice > 0) return c.underlyingPrice;
  return null;
}

// Find Call Wall and Put Wall from the per-strike gross GEX profile.
//
// Per-strike aggregates: callGex_K = sum over call contracts at K of
//   gamma * OI * 100 * spot^2 * 0.01, and putGex_K similarly summed over
// puts at K. Both are gross-positive numbers; the sign-flip that makes
// net dealer gamma meaningful only lives in the difference.
//
// Call Wall = strike maximizing (callGex - putGex) — the peak of the
// positive-net-gamma ridge, the "ceiling above spot" where dealers sit
// longest-gamma and their hedging flow damps moves most aggressively.
//
// Put Wall = strike minimizing (callGex - putGex) equivalently
// maximizing (putGex - callGex) — the peak of the negative-net-gamma
// valley, the "floor below spot" where dealer hedging amplifies moves.
//
// Identical convention to ingest-background.mjs::388-404 so the
// historical backfill lines up with the live intraday wall series
// without a discontinuity at the 2026-04-11 handoff.
function findWalls(contracts, spotPrice) {
  const mult = spotPrice * spotPrice * 0.01 * 100;
  const byStrike = new Map();
  for (const c of contracts) {
    const bucket = byStrike.get(c.strike) || { callGex: 0, putGex: 0 };
    const gex = c.gamma * c.oi * mult;
    const isCall = c.right === 'C' || c.right === 'CALL';
    const isPut = c.right === 'P' || c.right === 'PUT';
    if (isCall) bucket.callGex += gex;
    else if (isPut) bucket.putGex += gex;
    byStrike.set(c.strike, bucket);
  }
  let callWallStrike = null, callWallNet = -Infinity;
  let putWallStrike = null, putWallNet = Infinity;
  for (const [K, { callGex, putGex }] of byStrike) {
    const net = callGex - putGex;
    if (net > callWallNet) { callWallNet = net; callWallStrike = K; }
    if (net < putWallNet) { putWallNet = net; putWallStrike = K; }
  }
  return {
    callWall: callWallStrike,
    putWall: putWallStrike,
    strikeCount: byStrike.size,
  };
}

async function recomputeOneDay(baseUrl, date) {
  // Per the thetadata-serialize-wildcards guidance, fetch greeks and OI
  // serially per root (not Promise.all) to avoid the Jetty writev
  // IOException crashes on the Theta Terminal side that concurrent
  // wildcard fetches reliably trigger.
  let allContracts = [];
  for (const root of ROOTS) {
    const greeks = await fetchGreeksEod(baseUrl, root, date);
    await new Promise((r) => setTimeout(r, 100));
    const oi = await fetchOI(baseUrl, root, date);
    await new Promise((r) => setTimeout(r, 100));
    allContracts.push(...joinChain(greeks, oi));
  }
  if (allContracts.length === 0) {
    return { callWall: null, putWall: null, contracts: 0, spot: null, strikeCount: 0 };
  }
  const spot = pickSpotPrice(allContracts);
  if (!(spot > 0)) {
    return { callWall: null, putWall: null, contracts: allContracts.length, spot: null, strikeCount: 0 };
  }
  const walls = findWalls(allContracts, spot);
  return {
    callWall: walls.callWall,
    putWall: walls.putWall,
    contracts: allContracts.length,
    spot,
    strikeCount: walls.strikeCount,
  };
}

function readCompletedDates() {
  const set = new Set();
  try {
    const raw = fs.readFileSync(RESULTS_FILE, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r.date) set.add(r.date);
      } catch {}
    }
  } catch {}
  return set;
}

function appendResult(record) {
  fs.mkdirSync(path.dirname(RESULTS_FILE), { recursive: true });
  fs.appendFileSync(RESULTS_FILE, JSON.stringify(record) + '\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = process.env.THETA_BASE_URL || DEFAULT_THETA;

  if (args.verifyDate) {
    log('verify.start', { date: args.verifyDate });
    const result = await recomputeOneDay(baseUrl, args.verifyDate);
    log('verify.done', { date: args.verifyDate, ...result });
    return;
  }

  const allDates = tradingDaysBetween(args.start, args.end);
  const completed = readCompletedDates();
  const pending = allDates.filter((d) => !completed.has(d));
  log('start', {
    start: args.start,
    end: args.end,
    total: allDates.length,
    completed: completed.size,
    pending: pending.length,
  });

  if (pending.length === 0) { log('nothing_to_do'); return; }

  let processed = 0, errors = 0;

  for (const date of pending) {
    try {
      const r = await recomputeOneDay(baseUrl, date);
      if (r.callWall == null || r.putWall == null) {
        log('day.no_walls', { date, contracts: r.contracts, spot: r.spot, strikes: r.strikeCount });
      }
      appendResult({
        date,
        call_wall: r.callWall,
        put_wall: r.putWall,
        spot: r.spot,
        contracts: r.contracts,
        strike_count: r.strikeCount,
        computed_at: new Date().toISOString(),
      });
      processed++;

      if (processed % 10 === 0) {
        log('progress', {
          processed,
          remaining: pending.length - processed,
          last_date: date,
          last_call_wall: r.callWall,
          last_put_wall: r.putWall,
          last_spot: r.spot,
        });
      }
    } catch (err) {
      errors++;
      log('day.error', { date, error: String(err) });
      if (errors > 25) { log('too_many_errors', { errors }); break; }
    }
  }

  log('done', { processed, errors });
}

main().catch((err) => {
  log('fatal', { error: String(err), stack: err?.stack });
  process.exit(1);
});
