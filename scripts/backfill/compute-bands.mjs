#!/usr/bin/env node
// Historical cloud-bands backfill — Step 3 of the pipeline.
//
// Reads daily_term_structure (source=theta) and, for each trading day
// in the target window, computes percentile bands for DTE 0..280
// using a 1-year rolling lookback. The DTE wiggle tolerance is pulled
// from scripts/reconcile/tolerance.mjs so the backfill and the live
// reconciler stay bit-for-bit consistent. Writes to daily_cloud_bands
// via PostgREST upsert.
//
// By spec these bands are FROZEN once written — the live reconciler
// never recomputes a historical row even if daily_term_structure is
// corrected downstream. If you need to rebuild (e.g., you just
// discovered a parsing bug), pass --force to overwrite.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
//   node scripts/backfill/compute-bands.mjs [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--force]
//
// Defaults the target window to [2025-04-14, today] so the latest
// day's bands (the ones the frontend reads for "today") are always
// populated on each invocation.

import process from 'node:process';
import { tradingDaysBetween } from './trading-days.mjs';
import { createBackfillWriter } from './supabase-writer.mjs';
import { buildBandGrid, BAND_DTE_MAX } from '../reconcile/bands.mjs';

const DEFAULT_START = '2025-04-14';

function todayIsoEastern() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function parseArgs(argv) {
  const out = { start: DEFAULT_START, end: todayIsoEastern(), force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--start') out.start = argv[++i];
    else if (a === '--end') out.end = argv[++i];
    else if (a === '--force') out.force = true;
  }
  return out;
}

function addDaysIso(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const log = (event, data = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));

// Returns a sorted-by-trading_date list of observations. Each row is
// {trading_date, dte, atm_iv}. dte may exceed BAND_DTE_MAX — those
// rows get filtered out of the sampling at band-compute time.
async function loadAllObservations(writer) {
  const rows = await writer.getHistoricalTermStructure({
    from: '1970-01-01',
    to: '2999-12-31',
  });
  const parsed = rows
    .filter((r) => r.atm_iv != null && Number.isFinite(Number(r.atm_iv)))
    .map((r) => ({
      trading_date: r.trading_date,
      dte: Number(r.dte),
      atm_iv: Number(r.atm_iv),
    }))
    .sort((a, b) => a.trading_date.localeCompare(b.trading_date));
  return parsed;
}

// Filters an already-sorted observation array to the rolling lookback
// window for a target trading date: [target - 365d, target - 1d]. A
// plain filter is fine here (252 target dates × ~10k rows), no need
// for binary search.
function lookbackSlice(sorted, targetDate) {
  const minIncl = addDaysIso(targetDate, -365);
  const maxIncl = addDaysIso(targetDate, -1);
  return sorted.filter((r) => r.trading_date >= minIncl && r.trading_date <= maxIncl);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !serviceKey) {
    log('bands.missing_env', { need: ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY'] });
    process.exit(2);
  }
  const writer = createBackfillWriter({ url, serviceKey });

  log('bands.loading_observations');
  const all = await loadAllObservations(writer);
  log('bands.observations_loaded', {
    count: all.length,
    first: all[0]?.trading_date ?? null,
    last: all[all.length - 1]?.trading_date ?? null,
  });
  if (all.length === 0) {
    log('bands.no_observations');
    process.exit(1);
  }

  const targets = tradingDaysBetween(args.start, args.end);
  log('bands.start', {
    start: args.start,
    end: args.end,
    target_days: targets.length,
    dte_range: [0, BAND_DTE_MAX],
  });

  let completed = 0;
  let totalBandRows = 0;
  for (const tradingDate of targets) {
    const window = lookbackSlice(all, tradingDate);
    const grid = buildBandGrid(window);
    try {
      await writer.upsertDailyCloudBands(tradingDate, grid);
      totalBandRows += grid.length;
    } catch (err) {
      log('bands.write_failed', { trading_date: tradingDate, error: String(err) });
      process.exit(1);
    }
    completed++;
    if (completed % 20 === 0 || completed === targets.length) {
      const nonZeroCount = grid.filter((g) => g.sample_count > 0).length;
      log('bands.progress', {
        completed,
        total: targets.length,
        last_date: tradingDate,
        lookback_samples: window.length,
        dte_with_data: nonZeroCount,
      });
    }
  }

  log('bands.done', { target_days: targets.length, total_rows: totalBandRows });
}

main().catch((err) => {
  log('bands.fatal', { error: String(err), stack: err?.stack });
  process.exit(1);
});
