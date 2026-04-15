#!/usr/bin/env node
// Derived volatility scalars for the Volatility Risk Premium model.
// Reads daily_volatility_stats (SPX OHLC populated by pull-spx-ohlc.mjs)
// and daily_term_structure (ATM IV populated by pull-term-structure.mjs)
// and writes back three derived columns per trading day:
//
//   hv_20d_yz   — Yang-Zhang 20-trading-day realized volatility on SPX
//                 OHLC, annualized by sqrt(252). Trading-time annualization
//                 because each daily return spans one trading session; the
//                 weekend return compresses into a single overnight term.
//
//   iv_30d_cm   — 30-day constant-maturity ATM IV, linearly interpolated
//                 on total variance w(k,T) = iv² · T between the two
//                 daily_term_structure rows bracketing 30 calendar DTE.
//                 ThetaData IV is already annualized on a 365-calendar-day
//                 convention, which is the correct options convention
//                 because theta decays over weekends.
//
//   vrp_spread  — iv_30d_cm − hv_20d_yz. Positive (the normal state)
//                 means options are pricing more vol than has been
//                 realized; negative (rare, dangerous) means realized
//                 has exceeded the option-implied expectation.
//
// The 252/365 asymmetry is intentional — see p6 spec. Do NOT reconcile
// the two annualizations.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
//   node scripts/backfill/compute-vol-stats.mjs [--start YYYY-MM-DD] [--end YYYY-MM-DD]
//
// Safe to re-run: it's an upsert on the primary key.

import process from 'node:process';
import { createBackfillWriter } from './supabase-writer.mjs';

const DEFAULT_START = '2025-04-14';
const DEFAULT_END   = '2026-04-11';
const HV_WINDOW     = 20;      // trading days
const TRADING_DAYS  = 252;     // annualization divisor for HV
const CM_DTE_TARGET = 30;      // calendar days for constant-maturity IV

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

// Yang-Zhang estimator — the full three-component form, not the
// simplified Parkinson or Rogers-Satchell variants. It decomposes
// daily variance into three terms that capture non-overlapping
// information:
//
//   σ²_O  = Var( ln(O_t / C_{t-1}) )   — overnight return variance
//   σ²_C  = Var( ln(C_t / O_t)     )   — open-to-close variance
//   σ²_RS = mean over t of Rogers-Satchell intraday estimator
//           [ ln(H/C)·ln(H/O) + ln(L/C)·ln(L/O) ]
//
// combined as  σ²_YZ = σ²_O + k·σ²_C + (1−k)·σ²_RS
// with k = 0.34 / (1.34 + (N+1)/(N−1)) chosen to minimize estimator
// variance. Outputs annualized standard deviation on 252 trading days.
//
// Requires N+1 consecutive OHLC rows (we need a prior close to form
// the first overnight return). Returns null if the window is short.
function yangZhangHv(ohlcWindow, N = HV_WINDOW) {
  if (!ohlcWindow || ohlcWindow.length < N + 1) return null;
  // ohlcWindow is ordered oldest first; the trailing N+1 rows form the
  // last N daily returns plus one prior close.
  const window = ohlcWindow.slice(-(N + 1));
  const overnight = [];
  const openClose = [];
  const rogersSatchell = [];
  for (let i = 1; i < window.length; i++) {
    const prev = window[i - 1];
    const curr = window[i];
    if (!(curr.spx_open > 0 && curr.spx_high > 0 && curr.spx_low > 0 && curr.spx_close > 0 && prev.spx_close > 0)) {
      return null;
    }
    overnight.push(Math.log(curr.spx_open / prev.spx_close));
    openClose.push(Math.log(curr.spx_close / curr.spx_open));
    const hRatio = Math.log(curr.spx_high / curr.spx_open);
    const lRatio = Math.log(curr.spx_low / curr.spx_open);
    const hClose = Math.log(curr.spx_high / curr.spx_close);
    const lClose = Math.log(curr.spx_low / curr.spx_close);
    rogersSatchell.push(hClose * hRatio + lClose * lRatio);
  }
  if (overnight.length !== N) return null;

  const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  // Sample variance (N-1 denominator) — matches the standard Yang-Zhang
  // derivation. Using N here would bias the estimator downward.
  const variance = (arr) => {
    const m = mean(arr);
    return arr.reduce((acc, v) => acc + (v - m) ** 2, 0) / (arr.length - 1);
  };
  const rsMean = mean(rogersSatchell);

  const sigmaO2 = variance(overnight);
  const sigmaC2 = variance(openClose);
  const sigmaRS2 = rsMean;

  const k = 0.34 / (1.34 + (N + 1) / (N - 1));
  const yzVar = sigmaO2 + k * sigmaC2 + (1 - k) * sigmaRS2;
  if (!(yzVar > 0) || !Number.isFinite(yzVar)) return null;
  return Math.sqrt(yzVar * TRADING_DAYS);
}

// Linear interpolation on total variance w = iv² · (DTE/365) between the
// two daily_term_structure rows bracketing 30 calendar DTE. Falls back to
// nearest-neighbour if the window clips one side (e.g. only DTEs ≥30 or
// only DTEs ≤30 are available on that trading day, which happens on
// early rows of the backfill where the front-month expired yesterday).
function cm30IvFromTermStructure(termRows) {
  if (!termRows || termRows.length === 0) return { iv: null, bracket: null };
  const positive = termRows
    .filter((r) => Number.isFinite(r.atm_iv) && r.atm_iv > 0 && Number.isFinite(r.dte) && r.dte > 0)
    .sort((a, b) => a.dte - b.dte);
  if (positive.length === 0) return { iv: null, bracket: null };

  // Exact hit
  const exact = positive.find((r) => r.dte === CM_DTE_TARGET);
  if (exact) return { iv: exact.atm_iv, bracket: 'exact' };

  let lower = null;
  let upper = null;
  for (const r of positive) {
    if (r.dte < CM_DTE_TARGET) lower = r;
    else if (r.dte > CM_DTE_TARGET) { upper = r; break; }
  }
  if (lower && upper) {
    const wLower = lower.atm_iv * lower.atm_iv * (lower.dte / 365);
    const wUpper = upper.atm_iv * upper.atm_iv * (upper.dte / 365);
    const wTarget = wLower + (wUpper - wLower) * ((CM_DTE_TARGET - lower.dte) / (upper.dte - lower.dte));
    if (!(wTarget > 0)) return { iv: null, bracket: null };
    const iv = Math.sqrt(wTarget / (CM_DTE_TARGET / 365));
    return { iv, bracket: 'interpolated' };
  }
  // Clipped — the nearest-neighbour fallback. Better than null on the
  // very first day where the 30 DTE bracket may miss one side.
  if (upper) return { iv: upper.atm_iv, bracket: 'clipped_upper' };
  if (lower) return { iv: lower.atm_iv, bracket: 'clipped_lower' };
  return { iv: null, bracket: null };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !serviceKey) {
    log('vol_stats.missing_env', { need: ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY'] });
    process.exit(2);
  }

  const writer = createBackfillWriter({ url, serviceKey });

  log('vol_stats.start', { start: args.start, end: args.end, hv_window: HV_WINDOW });

  // Fetch OHLC starting ~30 trading days BEFORE args.start so the first
  // trading date in the target window can compute a full HV_WINDOW-day
  // Yang-Zhang estimate. Calendar-day lead of 45 covers 20 trading days
  // plus weekends/holidays with headroom.
  const leadStartDate = new Date(`${args.start}T00:00:00Z`);
  leadStartDate.setUTCDate(leadStartDate.getUTCDate() - 45);
  const leadStart = leadStartDate.toISOString().slice(0, 10);

  let ohlcRows;
  try {
    ohlcRows = await writer.getDailyVolatilityOhlc({ from: leadStart, to: args.end });
  } catch (err) {
    log('vol_stats.ohlc_fetch_failed', { error: String(err) });
    process.exit(1);
  }
  log('vol_stats.ohlc_loaded', { rows: ohlcRows.length });

  if (ohlcRows.length === 0) {
    log('vol_stats.no_ohlc');
    process.exit(1);
  }

  let termRows;
  try {
    // getHistoricalTermStructure uses a half-open range (gte..lt); add one
    // day to the end so it's effectively inclusive of args.end.
    const endExclusive = new Date(`${args.end}T00:00:00Z`);
    endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
    termRows = await writer.getHistoricalTermStructure({
      from: args.start,
      to: endExclusive.toISOString().slice(0, 10),
    });
  } catch (err) {
    log('vol_stats.term_fetch_failed', { error: String(err) });
    process.exit(1);
  }
  log('vol_stats.term_loaded', { rows: termRows.length });

  // Group term-structure rows by trading_date so each day's 30d CM IV
  // interpolation only sees its own snapshot.
  const termByDate = new Map();
  for (const r of termRows) {
    if (!termByDate.has(r.trading_date)) termByDate.set(r.trading_date, []);
    termByDate.get(r.trading_date).push(r);
  }

  // Sort OHLC once, oldest first. yangZhangHv reads trailing slices.
  ohlcRows.sort((a, b) => a.trading_date.localeCompare(b.trading_date));

  const computed = [];
  let hvHits = 0;
  let ivHits = 0;
  let vrpHits = 0;

  for (let i = 0; i < ohlcRows.length; i++) {
    const row = ohlcRows[i];
    if (row.trading_date < args.start || row.trading_date > args.end) continue;

    const window = ohlcRows.slice(0, i + 1);
    const hv = yangZhangHv(window, HV_WINDOW);
    if (hv != null) hvHits++;

    const term = termByDate.get(row.trading_date) || [];
    const { iv } = cm30IvFromTermStructure(term);
    if (iv != null) ivHits++;

    const vrp = hv != null && iv != null ? iv - hv : null;
    if (vrp != null) vrpHits++;

    computed.push({
      trading_date: row.trading_date,
      hv_20d_yz: hv,
      iv_30d_cm: iv,
      vrp_spread: vrp,
      sample_count: term.length,
    });
  }

  log('vol_stats.computed', {
    rows: computed.length,
    hv_hits: hvHits,
    iv_hits: ivHits,
    vrp_hits: vrpHits,
  });

  if (computed.length === 0) {
    log('vol_stats.nothing_to_write');
    process.exit(0);
  }

  try {
    await writer.upsertDailyVolatilityDerived(computed);
  } catch (err) {
    log('vol_stats.write_failed', { error: String(err) });
    process.exit(1);
  }

  log('vol_stats.done', {
    rows: computed.length,
    first: computed[0].trading_date,
    last: computed[computed.length - 1].trading_date,
  });
}

main().catch((err) => {
  log('vol_stats.fatal', { error: String(err), stack: err?.stack });
  process.exit(1);
});
