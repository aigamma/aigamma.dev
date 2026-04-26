// scripts/backfill/vix-family-eod.mjs
//
// Pulls daily EOD OHLC for the VIX family + cross-asset vol + skew + Cboe
// option-strategy benchmark indices from Massive Indices Starter and upserts
// every row into public.vix_family_eod. The /vix lab reads exclusively from
// that table — never directly from Massive — so the page renders from cached
// historical state on weekends and stays useful even if Massive is unreachable.
//
// Source: Massive Indices Starter (api.massive.com /v2/aggs/ticker/I:{SYMBOL}
// /range/1/day/{from}/{to}). The user signed up for the tier on 2026-04-26;
// historical depth at this tier is ~Feb 2023 forward (verified by binary
// search probing the daily aggregate endpoint), so the default backfill window
// is 2023-03-01 to today.
//
// SPX is deliberately NOT in the symbol list — its EOD lives in
// daily_volatility_stats sourced from ThetaData per the data-provenance rule
// in CLAUDE.md. This script's data layer is for symbols ThetaData does not
// cover at the Index Standard tier.
//
// Usage:
//   node scripts/backfill/vix-family-eod.mjs                   # default 2023-03-01 → today
//   node scripts/backfill/vix-family-eod.mjs --from 2024-01-01 # custom window
//   node scripts/backfill/vix-family-eod.mjs --symbols VIX,VVIX
//
// Required env: MASSIVE_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY
// Reads .env at the repo root if present (no dotenv dep — minimal parser).

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// All symbols the /vix lab catalog touches. Stored without the Massive
// 'I:' prefix in Supabase for cleaner downstream queries. Verified
// available on Indices Starter by probing the /v3/snapshot/indices and
// /v2/aggs/ticker endpoints on 2026-04-26.
const DEFAULT_SYMBOLS = [
  // Vol term structure (forward VIX expectations across 1d / 9d / 30d / 90d / 180d / 365d)
  'VIX', 'VIX1D', 'VIX9D', 'VIX3M', 'VIX6M', 'VIX1Y',
  // Vol of vol — implied vol on VIX itself
  'VVIX',
  // Cross-asset vol indices
  'VXN',  // Nasdaq 100 implied vol
  'RVX',  // Russell 2000 implied vol
  'OVX',  // Crude oil implied vol (USO)
  'GVZ',  // Gold implied vol (GLD)
  // Skew indices — fat-tail premium gauges
  'SKEW', // Cboe SKEW (S&P 500 skewness from option prices, centered at 100)
  'SDEX', // Nations SkewDex (alternative skew construction)
  // Cboe option-strategy benchmark indices (publicly disseminated, free to display)
  'BXM',  // BuyWrite Index (covered call at-the-money)
  'BXMD', // BuyWrite 30-Delta (covered call ~OTM)
  'BFLY', // Iron Butterfly Index
  'CNDR', // Iron Condor Index
];

const DEFAULT_FROM = '2023-03-01';
const MASSIVE_BASE = 'https://api.massive.com';
const MASSIVE_TIMEOUT_MS = 20000;
const FETCH_DELAY_MS = 250;
const UPSERT_BATCH_SIZE = 1000;

function loadDotEnv() {
  const p = resolve(process.cwd(), '.env');
  if (!existsSync(p)) return;
  const text = readFileSync(p, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function parseArgs(argv) {
  const args = { from: DEFAULT_FROM, to: todayIso(), symbols: DEFAULT_SYMBOLS };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') args.from = argv[++i];
    else if (a === '--to') args.to = argv[++i];
    else if (a === '--symbols') {
      args.symbols = argv[++i].split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    } else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/backfill/vix-family-eod.mjs [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--symbols A,B,C]');
      process.exit(0);
    }
  }
  return args;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

async function fetchJson(url, headers, label) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(MASSIVE_TIMEOUT_MS) });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${label} ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// One paginated fetch covers a typical 3-year window in a single call (default
// limit 5000 is well above 752 trading days). Retains a next_url loop just in
// case Massive ever returns a paged response on long windows.
async function fetchDailyBars(symbol, from, to, apiKey) {
  const ticker = `I:${symbol}`;
  let url =
    `${MASSIVE_BASE}/v2/aggs/ticker/${ticker}/range/1/day/${from}/${to}` +
    `?adjusted=true&sort=asc&limit=5000`;
  const headers = { Authorization: `Bearer ${apiKey}` };
  const out = [];
  let pageCount = 0;
  while (url) {
    const body = await fetchJson(url, headers, `massive ${symbol} page ${pageCount + 1}`);
    const results = Array.isArray(body?.results) ? body.results : [];
    for (const r of results) {
      const ts = Number(r.t);
      if (!Number.isFinite(ts)) continue;
      const tradingDate = new Date(ts).toISOString().slice(0, 10);
      out.push({
        symbol,
        trading_date: tradingDate,
        open: r.o ?? null,
        high: r.h ?? null,
        low: r.l ?? null,
        close: r.c ?? null,
      });
    }
    pageCount += 1;
    url = body?.next_url || null;
    if (url) await new Promise((r) => setTimeout(r, FETCH_DELAY_MS));
  }
  return out;
}

async function upsertRows(supabaseUrl, serviceKey, rows) {
  if (rows.length === 0) return 0;
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates,return=minimal',
  };
  let written = 0;
  for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + UPSERT_BATCH_SIZE);
    const res = await fetch(`${supabaseUrl}/rest/v1/vix_family_eod`, {
      method: 'POST',
      headers,
      body: JSON.stringify(batch),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`supabase upsert ${i / UPSERT_BATCH_SIZE + 1} failed: ${res.status} ${body.slice(0, 300)}`);
    }
    written += batch.length;
  }
  return written;
}

async function main() {
  loadDotEnv();

  const apiKey = process.env.MASSIVE_API_KEY;
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!apiKey || !supabaseUrl || !serviceKey) {
    console.error('missing env: need MASSIVE_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY');
    process.exit(2);
  }

  const args = parseArgs(process.argv);
  console.log(`[vix-backfill] symbols=${args.symbols.length} from=${args.from} to=${args.to}`);

  const startedAt = Date.now();
  const summary = [];
  for (const symbol of args.symbols) {
    const t0 = Date.now();
    try {
      const rows = await fetchDailyBars(symbol, args.from, args.to, apiKey);
      const written = await upsertRows(supabaseUrl, serviceKey, rows);
      const ms = Date.now() - t0;
      console.log(`  [${symbol}] fetched=${rows.length} upserted=${written} (${ms}ms)`);
      summary.push({ symbol, rows: rows.length, ms });
    } catch (err) {
      console.error(`  [${symbol}] FAILED: ${err.message}`);
      summary.push({ symbol, error: err.message });
    }
    await new Promise((r) => setTimeout(r, FETCH_DELAY_MS));
  }
  const totalMs = Date.now() - startedAt;
  const totalRows = summary.reduce((s, x) => s + (x.rows || 0), 0);
  const errors = summary.filter((x) => x.error).length;
  console.log(`[vix-backfill] done in ${totalMs}ms — ${totalRows} rows across ${args.symbols.length - errors}/${args.symbols.length} symbols`);
  if (errors > 0) process.exit(1);
}

main().catch((err) => {
  console.error('[vix-backfill] fatal:', err);
  process.exit(1);
});
