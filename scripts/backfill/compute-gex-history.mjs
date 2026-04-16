#!/usr/bin/env node
// Historical daily dealer GEX backfill from ThetaData EOD Greeks.
// For each trading day, fetches the full options chain (SPX + SPXW roots),
// computes net dealer gamma exposure using the standard convention
// (call GEX positive, put GEX negative), finds the vol flip strike
// (zero crossing of the net gamma profile), and writes the aggregate
// metrics to daily_gex_stats.
//
// GEX formula matches src/lib/gex.js:
//   GEX_contract = gamma * OI * 100 * spot^2 * 0.01
// Call-side GEX is positive (dealer-short-calls creates stabilizing hedging).
// Put-side GEX is negative (dealer-short-puts creates destabilizing hedging).
// Net GEX = call_gex - put_gex; positive net = positive gamma regime.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
//   node scripts/backfill/compute-gex-history.mjs [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--force]
//
// Resumable: skips dates already in daily_gex_stats unless --force is set.
// Processes dates sequentially because the wildcard expiration=* query is
// heavy and ThetaData Standard allows only 2 concurrent threads.

import process from 'node:process';
import { createBackfillWriter } from './supabase-writer.mjs';
import { tradingDaysBetween } from './trading-days.mjs';

// Options Standard floor — no data before this date.
const DEFAULT_START = '2017-01-03';
const DEFAULT_END   = '2026-04-16';
const DEFAULT_THETA = 'http://127.0.0.1:25503';
const ROOTS         = ['SPXW', 'SPX'];
const BATCH_SIZE    = 10;  // upsert in batches

function parseArgs(argv) {
  const out = { start: DEFAULT_START, end: DEFAULT_END, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--start') out.start = argv[++i];
    else if (a === '--end') out.end = argv[++i];
    else if (a === '--force') out.force = true;
  }
  return out;
}

const log = (event, data = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));

function toCompactDate(iso) {
  return iso.replaceAll('-', '');
}

// Minimal CSV parser matching theta-eod.mjs
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

// Parse the option/history/greeks/eod CSV. We only need the fields for
// GEX computation: gamma, open_interest, strike, right, underlying_price.
function parseGreeksEodCsv(csvText) {
  const lines = csvText.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return [];
  const header = parseCsvLine(lines[0]);
  const idx = {
    strike:           header.indexOf('strike'),
    right:            header.indexOf('right'),
    gamma:            header.indexOf('gamma'),
    open_interest:    header.indexOf('open_interest'),
    underlying_price: header.indexOf('underlying_price'),
  };
  for (const [k, v] of Object.entries(idx)) {
    if (v < 0) throw new Error(`theta greeks EOD CSV missing column: ${k}`);
  }
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = parseCsvLine(lines[i]);
    const gamma = Number(parts[idx.gamma]);
    const oi = Number(parts[idx.open_interest]);
    if (!(gamma > 0) || !(oi > 0)) continue;  // skip zero/null gamma or OI
    rows.push({
      strike:          Number(parts[idx.strike]),
      right:           parts[idx.right].replace(/^"|"$/g, ''),
      gamma,
      open_interest:   oi,
      underlyingPrice: Number(parts[idx.underlying_price]),
    });
  }
  return rows;
}

async function fetchEodGreeksForDay(baseUrl, symbol, date) {
  const compact = toCompactDate(date);
  const url = `${baseUrl}/v3/option/history/greeks/eod?symbol=${symbol}&expiration=*&start_date=${compact}&end_date=${compact}`;
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // 404 or empty is expected for dates where a root had no listings
    if (res.status === 404) return [];
    throw new Error(`theta greeks/eod ${symbol} ${date} HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return parseGreeksEodCsv(await res.text());
}

// Compute GEX metrics from a combined set of parsed contract rows.
function computeDailyGex(contracts) {
  if (!contracts || contracts.length === 0) return null;

  // Use the first valid underlying price as spot
  let spotPrice = null;
  for (const c of contracts) {
    if (c.underlyingPrice > 0) { spotPrice = c.underlyingPrice; break; }
  }
  if (!spotPrice) return null;

  const mult = spotPrice * spotPrice * 0.01 * 100;
  const byStrike = new Map();

  let totalCallGex = 0;
  let totalPutGex = 0;
  const expirations = new Set();

  for (const c of contracts) {
    const gex = c.gamma * c.open_interest * mult;
    const key = c.strike;
    if (!byStrike.has(key)) byStrike.set(key, { callGex: 0, putGex: 0 });
    const entry = byStrike.get(key);

    if (c.right === 'C') {
      entry.callGex += gex;
      totalCallGex += gex;
    } else if (c.right === 'P') {
      entry.putGex += gex;
      totalPutGex += gex;
    }
  }

  // Net GEX: calls positive, puts negative (standard dealer convention)
  const netGex = totalCallGex - totalPutGex;

  // Find vol flip: the strike where net GEX per strike crosses zero.
  // Net at each strike = callGex - putGex. Walk from low to high strike
  // and find the crossing closest to spot with the largest bilateral
  // cumulative GEX (same heuristic as gammaProfile.js findFlipFromProfile).
  const strikes = Array.from(byStrike.keys()).sort((a, b) => a - b);
  let volFlip = null;
  let bestScore = -Infinity;

  for (let i = 1; i < strikes.length; i++) {
    const prevS = strikes[i - 1];
    const currS = strikes[i];
    const prevNet = byStrike.get(prevS).callGex - byStrike.get(prevS).putGex;
    const currNet = byStrike.get(currS).callGex - byStrike.get(currS).putGex;

    if ((prevNet < 0 && currNet >= 0) || (prevNet >= 0 && currNet < 0)) {
      // Linear interpolation for the zero crossing
      const t = Math.abs(prevNet) / (Math.abs(prevNet) + Math.abs(currNet));
      const crossStrike = prevS + t * (currS - prevS);

      // Score: sum of absolute GEX on both sides of the crossing.
      // The flip with the largest bilateral exposure is the meaningful one;
      // tiny oscillations in the wings score low.
      let belowSum = 0;
      let aboveSum = 0;
      for (const s of strikes) {
        const e = byStrike.get(s);
        const net = e.callGex - e.putGex;
        if (s <= crossStrike) belowSum += Math.abs(net);
        else aboveSum += Math.abs(net);
      }
      const score = Math.min(belowSum, aboveSum);
      if (score > bestScore) {
        bestScore = score;
        volFlip = Math.round(crossStrike);
      }
    }
  }

  return {
    spx_close: spotPrice,
    net_gex: netGex,
    call_gex: totalCallGex,
    put_gex: totalPutGex,
    vol_flip_strike: volFlip,
    contract_count: contracts.length,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !serviceKey) {
    log('gex.missing_env', { need: ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY'] });
    process.exit(2);
  }

  const writer = createBackfillWriter({ url, serviceKey });
  const baseUrl = process.env.THETA_BASE_URL || DEFAULT_THETA;

  const allDays = tradingDaysBetween(args.start, args.end);
  log('gex.start', { start: args.start, end: args.end, trading_days: allDays.length, force: args.force });

  // Load existing dates to skip (resume support)
  let existingDates = new Set();
  if (!args.force) {
    try {
      existingDates = await writer.getExistingGexDates();
      log('gex.existing', { count: existingDates.size });
    } catch (err) {
      log('gex.existing_fetch_failed', { error: String(err) });
    }
  }

  const pendingDays = allDays.filter((d) => !existingDates.has(d));
  log('gex.pending', { total: allDays.length, existing: existingDates.size, pending: pendingDays.length });

  if (pendingDays.length === 0) {
    log('gex.nothing_to_do');
    process.exit(0);
  }

  let processed = 0;
  let errors = 0;
  let batch = [];

  for (const day of pendingDays) {
    try {
      // Fetch both roots sequentially (2-thread limit means we can't safely
      // blast both in parallel while other backfills might be running).
      let allContracts = [];
      for (const root of ROOTS) {
        const rows = await fetchEodGreeksForDay(baseUrl, root, day);
        allContracts.push(...rows);
      }

      const result = computeDailyGex(allContracts);
      if (!result) {
        log('gex.skip_no_data', { date: day });
        continue;
      }

      batch.push({
        trading_date: day,
        ...result,
      });
      processed++;

      if (batch.length >= BATCH_SIZE) {
        await writer.upsertDailyGexStats(batch);
        log('gex.batch_written', { count: batch.length, through: day, processed, remaining: pendingDays.length - processed });
        batch = [];
      }
    } catch (err) {
      errors++;
      log('gex.day_error', { date: day, error: String(err) });
      // Continue to next day rather than aborting the whole backfill
      if (errors > 20) {
        log('gex.too_many_errors', { errors });
        break;
      }
    }
  }

  // Flush remaining batch
  if (batch.length > 0) {
    try {
      await writer.upsertDailyGexStats(batch);
      log('gex.batch_written', { count: batch.length, through: batch[batch.length - 1].trading_date, processed });
    } catch (err) {
      log('gex.final_batch_failed', { error: String(err) });
    }
  }

  log('gex.done', { processed, errors, total_days: pendingDays.length });
}

main().catch((err) => {
  log('gex.fatal', { error: String(err), stack: err?.stack });
  process.exit(1);
});
