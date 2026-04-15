#!/usr/bin/env node
// Historical SPX term-structure backfill — Steps 1 and 2 of the
// cloud-bands pipeline.
//
// For each trading day in the window, fetches ThetaData's EOD greeks
// CSV, extracts one ATM IV observation per expiration, and upserts to
// daily_term_structure. Respects ThetaTerminal Standard's 2-thread
// concurrency limit. Caches raw CSV to .backfill-cache/theta-eod/ so
// reruns after an aborted pass don't re-hit ThetaData for days that
// were already fetched.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
//   node scripts/backfill/pull-term-structure.mjs [--start YYYY-MM-DD] [--end YYYY-MM-DD]
//
// Defaults to 2025-04-14 .. 2026-04-11 (the 1-year window specified
// for the initial cloud-bands backfill).

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { tradingDaysBetween } from './trading-days.mjs';
import { createThetaEodClient, parseEodCsv } from './theta-eod.mjs';
import { extractAtmRows } from './atm-iv.mjs';
import { createBackfillWriter } from './supabase-writer.mjs';

const DEFAULT_START = '2025-04-14';
const DEFAULT_END   = '2026-04-11';
const CACHE_DIR     = path.resolve('scripts/backfill/.cache/theta-eod');
const CONCURRENCY   = 2;
const LOG_EVERY     = 10;

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

async function readCacheOrFetch(theta, date, symbol) {
  const cachePath = path.join(CACHE_DIR, `${symbol}-${date}.csv`);
  try {
    const cached = await fs.readFile(cachePath, 'utf8');
    return { csv: cached, fromCache: true };
  } catch {
    const csv = await theta.fetchCsvForDay({ symbol, date });
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(cachePath, csv, 'utf8');
    return { csv, fromCache: false };
  }
}

async function processDay(theta, writer, date, { skipExisting, symbol }) {
  if (skipExisting) {
    return { date, status: 'skipped_existing', rows: 0, fromCache: false };
  }
  let csv, fromCache;
  try {
    ({ csv, fromCache } = await readCacheOrFetch(theta, date, symbol));
  } catch (err) {
    return { date, status: 'fetch_failed', error: String(err), rows: 0, fromCache: false };
  }
  let rows;
  try {
    rows = parseEodCsv(csv);
  } catch (err) {
    return { date, status: 'parse_failed', error: String(err), rows: 0, fromCache };
  }
  const atmRows = extractAtmRows(rows, date);
  if (atmRows.length === 0) {
    return { date, status: 'no_atm_rows', rows: 0, fromCache };
  }
  try {
    await writer.upsertDailyTermStructure(date, atmRows);
  } catch (err) {
    return { date, status: 'write_failed', error: String(err), rows: atmRows.length, fromCache };
  }
  return { date, status: 'ok', rows: atmRows.length, fromCache };
}

// Worker-pool parallelism with a shared cursor. Each worker grabs the
// next unclaimed day, processes it, then loops. Simpler than a full
// promise-pool library and keeps the 2-thread ThetaData cap honest.
async function runPool({ items, concurrency, task, onResult }) {
  let cursor = 0;
  const results = [];
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      const result = await task(items[i], i);
      results[i] = result;
      onResult?.(result, i);
    }
  }
  const workers = Array.from({ length: concurrency }, worker);
  await Promise.all(workers);
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !serviceKey) {
    log('backfill.missing_env', { need: ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY'] });
    process.exit(2);
  }

  const theta = createThetaEodClient({
    baseUrl: process.env.THETA_BASE_URL || 'http://127.0.0.1:25503',
  });
  const writer = createBackfillWriter({ url, serviceKey });

  const days = tradingDaysBetween(args.start, args.end);
  log('backfill.start', {
    start: args.start,
    end: args.end,
    days: days.length,
    concurrency: CONCURRENCY,
    force: args.force,
  });

  // Skip days that already have rows unless --force. Avoids re-
  // upserting identical payloads on a resume.
  let existingDates = new Set();
  if (!args.force) {
    try {
      existingDates = await writer.getExistingTermStructureDates();
      log('backfill.existing', { count: existingDates.size });
    } catch (err) {
      log('backfill.existing_fetch_failed', { error: String(err) });
    }
  }

  const startedAt = Date.now();
  let completed = 0;
  let okCount = 0;
  let skipCount = 0;
  let failCount = 0;
  let totalRows = 0;

  await runPool({
    items: days,
    concurrency: CONCURRENCY,
    task: (date) => processDay(theta, writer, date, {
      skipExisting: !args.force && existingDates.has(date),
      symbol: 'SPXW',
    }),
    onResult: (result) => {
      completed++;
      if (result.status === 'ok') {
        okCount++;
        totalRows += result.rows;
      } else if (result.status === 'skipped_existing') {
        skipCount++;
      } else {
        failCount++;
        log('backfill.day_failed', result);
      }
      if (completed % LOG_EVERY === 0 || completed === days.length) {
        const elapsedMs = Date.now() - startedAt;
        const perDayMs = elapsedMs / completed;
        const remaining = days.length - completed;
        const etaMs = perDayMs * remaining;
        log('backfill.progress', {
          completed,
          total: days.length,
          ok: okCount,
          skipped: skipCount,
          failed: failCount,
          total_rows: totalRows,
          elapsed_ms: elapsedMs,
          per_day_ms: Math.round(perDayMs),
          eta_ms: Math.round(etaMs),
        });
      }
    },
  });

  log('backfill.done', {
    days: days.length,
    ok: okCount,
    skipped: skipCount,
    failed: failCount,
    total_rows: totalRows,
    elapsed_ms: Date.now() - startedAt,
  });

  if (failCount > 0) process.exit(1);
}

main().catch((err) => {
  log('backfill.fatal', { error: String(err), stack: err?.stack });
  process.exit(1);
});
