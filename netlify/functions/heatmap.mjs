// netlify/functions/heatmap.mjs
//
// Read endpoint for the /heatmap surface — a market-cap-weighted GICS-
// sector treemap of every S&P 500 constituent, colored by the day's
// percent change. Joins three pieces of state at request time:
//
//   1. The static SPX roster shipped at src/data/sp500-roster.json,
//      generated once per refresh by scripts/backfill/sp500-roster.mjs
//      from the SSGA SPY holdings file plus the GitHub
//      datasets/s-and-p-500-companies CSV. Provides ticker, name,
//      market-cap weight, GICS sector, GICS sub-industry. The function
//      imports it from the bundle so there is no extra HTTP fetch.
//
//   2. Massive's full-market stock snapshot at
//      /v2/snapshot/locale/us/markets/stocks/tickers — one HTTP call
//      returns last trade + previous-day close + pre-computed
//      todaysChangePerc for every US stock; the function filters to
//      the 503 tickers in the roster. This requires the Stocks
//      product on the Massive subscription (the existing
//      MASSIVE_API_KEY is provisioned for the Options product per
//      ingest-background.mjs). On a 401/403 the function falls back
//      to whatever is in public.daily_eod (currently only the 15
//      sector ETFs from the rotations universe — useful as a sector-
//      level overview while the Stocks product is being added).
//
// Storage and memory are deliberately not in scope for this surface —
// per the design ask, we only need each constituent's prior-day close
// to compute percent change, which the Massive snapshot returns
// inline. No Supabase write path, no daily backfill, no historical
// time series. The roster JSON IS the only persisted artifact and it
// only changes when SP500 membership or weights drift materially.
//
// Cache profile mirrors the cadence of the underlying data:
//   Market hours (09:30-16:00 ET, weekdays):  max-age=60, swr=300
//   Off-hours / weekends:                     max-age=900, swr=86400
// The off-hours cache is loose because Massive's snapshot just
// returns Friday's session unchanged; tightening it would only burn
// origin requests for no freshness gain.

import { readFileSync } from 'node:fs';

// Load the roster at function-module init so the JSON parse only
// happens once per cold start. Using readFileSync rather than an
// import-attributes JSON import (`with { type: 'json' }`) keeps this
// portable across Node 20 / 22 — the import-attributes syntax landed
// at different stability levels in each, and Netlify's function
// runtime defaults can lag the local Node version. The JSON's
// inclusion in the deploy bundle is guaranteed by the
// [functions.heatmap] included_files entry in netlify.toml; the
// bundler can't trace runtime fs reads automatically.
const ROSTER_URL = new URL('../../src/data/sp500-roster.json', import.meta.url);
const roster = JSON.parse(readFileSync(ROSTER_URL, 'utf8'));

const MASSIVE_API_KEY = process.env.MASSIVE_API_KEY;
const MASSIVE_BASE = 'https://api.massive.com';
const MASSIVE_TIMEOUT_MS = 10000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const SUPABASE_TIMEOUT_MS = 8000;

// Map of SPDR sector ETF → GICS sector name. When the Massive Stocks
// product is unavailable we fall back to the daily_eod table which
// only carries the 15-symbol rotations universe. The fallback emits
// one tile per sector ETF representing the whole sector, sized at the
// sum of the sector's true SP500 weight, so the layout still hints at
// market-cap proportions while clearly being a degraded view.
const SECTOR_ETF_TO_GICS = {
  XLK:  'Information Technology',
  XLV:  'Health Care',
  XLF:  'Financials',
  XLY:  'Consumer Discretionary',
  XLC:  'Communication Services',
  XLI:  'Industrials',
  XLP:  'Consumer Staples',
  XLE:  'Energy',
  XLU:  'Utilities',
  XLRE: 'Real Estate',
  XLB:  'Materials',
};

function isMarketHoursET() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const wd = get('weekday');
  if (wd === 'Sat' || wd === 'Sun') return false;
  const h = Number(get('hour'));
  const m = Number(get('minute'));
  const minutes = h * 60 + m;
  // 09:30 → 16:00 ET. Pre-market (04:00) and post-market (16:00-20:00)
  // do trade on Massive's snapshot but with much thinner volume; we
  // treat them as off-hours from a cache-freshness perspective.
  return minutes >= 570 && minutes < 960;
}

function cacheControlHeader() {
  return isMarketHoursET()
    ? 'public, max-age=60, stale-while-revalidate=300'
    : 'public, max-age=900, stale-while-revalidate=86400';
}

async function fetchMassiveSnapshot(tickers) {
  if (!MASSIVE_API_KEY) {
    return { ok: false, reason: 'no-key', status: 0 };
  }
  // Massive accepts a comma-separated tickers list; passing all 503
  // names keeps the response small (~30 KB) vs the unfiltered ~10 MB
  // full-market dump.
  const url = `${MASSIVE_BASE}/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${encodeURIComponent(tickers.join(','))}`;
  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${MASSIVE_API_KEY}` },
      signal: AbortSignal.timeout(MASSIVE_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, reason: String(err?.name || 'fetch-error'), status: 0 };
  }
  if (!res.ok) {
    return { ok: false, reason: `http-${res.status}`, status: res.status };
  }
  let body;
  try {
    body = await res.json();
  } catch (err) {
    return { ok: false, reason: 'invalid-json', status: 200 };
  }
  // Massive returns { tickers: [...], status, count }. Each ticker
  // entry has day.c (today's close), prevDay.c (yesterday's close),
  // lastTrade.p (most recent trade price), todaysChangePerc.
  const list = Array.isArray(body?.tickers) ? body.tickers : [];
  const map = new Map();
  for (const t of list) {
    const sym = String(t?.ticker || '').toUpperCase();
    if (!sym) continue;
    const last = Number(t?.lastTrade?.p) || Number(t?.day?.c) || null;
    const prev = Number(t?.prevDay?.c) || null;
    const pct = Number.isFinite(t?.todaysChangePerc)
      ? t.todaysChangePerc
      : (Number.isFinite(last) && Number.isFinite(prev) && prev > 0)
        ? ((last - prev) / prev) * 100
        : null;
    map.set(sym, { last, prev, pctChange: pct });
  }
  return { ok: true, prices: map, sourceUpdated: body?.tickers?.[0]?.updated || null };
}

// Fallback path. Pulls the most recent two trading-day closes for each
// sector ETF in public.daily_eod and computes percent change. Returns
// 11 sector-level tiles with weight = sum of constituent SP500 weights
// per sector. The frontend renders the same treemap layout — just
// with 11 big tiles instead of 503 small ones — and shows a
// "degraded source" banner.
async function fetchSupabaseSectorEtfs() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return { ok: false, reason: 'no-supabase-config' };
  }
  const symbols = Object.keys(SECTOR_ETF_TO_GICS);
  // Pull the last 5 trading days per sector ETF — the math only needs
  // 2 closes but the buffer absorbs any single missing bar.
  const params = new URLSearchParams({
    select: 'symbol,trading_date,close',
    order: 'trading_date.desc,symbol.asc',
    symbol: `in.(${symbols.join(',')})`,
    limit: String(5 * symbols.length),
  });
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/daily_eod?${params}`, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
      signal: AbortSignal.timeout(SUPABASE_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, reason: String(err?.name || 'fetch-error') };
  }
  if (!res.ok) return { ok: false, reason: `supabase-${res.status}` };
  const rows = await res.json().catch(() => null);
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, reason: 'no-rows' };
  }
  // Bucket by symbol → ascending close array, take last two.
  const bySymbol = {};
  for (const r of rows) {
    (bySymbol[r.symbol] ||= []).push({ date: r.trading_date, close: Number(r.close) });
  }
  const map = new Map();
  let asOf = null;
  for (const sym of symbols) {
    const series = (bySymbol[sym] || []).sort((a, b) => a.date.localeCompare(b.date));
    if (series.length < 2) continue;
    const last = series[series.length - 1];
    const prev = series[series.length - 2];
    if (!last || !prev || !(prev.close > 0)) continue;
    map.set(sym, {
      last: last.close,
      prev: prev.close,
      pctChange: ((last.close - prev.close) / prev.close) * 100,
      asOf: last.date,
    });
    if (!asOf || last.date > asOf) asOf = last.date;
  }
  return { ok: true, prices: map, asOf };
}

export default async function handler(_request) {
  const tickers = roster.holdings.map((h) => h.symbol);

  // Try Massive first. On any failure, fall back to the sector-ETF
  // overview from Supabase so the page still renders something useful.
  const massive = await fetchMassiveSnapshot(tickers);

  if (massive.ok) {
    const tiles = [];
    let pricedCount = 0;
    for (const h of roster.holdings) {
      const px = massive.prices.get(h.symbol);
      const tile = {
        symbol: h.symbol,
        name: h.name,
        sector: h.sector,
        weight: h.weight,
        last: px?.last ?? null,
        prev: px?.prev ?? null,
        pctChange: px?.pctChange ?? null,
      };
      if (Number.isFinite(tile.pctChange)) pricedCount += 1;
      tiles.push(tile);
    }
    const payload = {
      mode: 'constituents',
      asOf: roster.asOf,
      sourceUpdated: massive.sourceUpdated,
      source: 'massive',
      generatedAt: roster.generatedAt,
      count: tiles.length,
      pricedCount,
      tiles,
    };
    return jsonResponse(200, payload, cacheControlHeader());
  }

  // Massive unavailable. Try the sector-ETF fallback.
  const fallback = await fetchSupabaseSectorEtfs();
  if (!fallback.ok) {
    return jsonResponse(502, {
      error: 'No price source available',
      massive_failure: massive.reason,
      fallback_failure: fallback.reason,
    }, 'no-store');
  }

  // Sum SP500 weights per GICS sector to size the 11 fallback tiles by
  // true index weight rather than by ETF NAV.
  const weightBySector = {};
  for (const h of roster.holdings) {
    weightBySector[h.sector] = (weightBySector[h.sector] || 0) + h.weight;
  }

  const tiles = [];
  for (const [etf, sector] of Object.entries(SECTOR_ETF_TO_GICS)) {
    const px = fallback.prices.get(etf);
    if (!px) continue;
    tiles.push({
      symbol: etf,
      name: sector,
      sector,
      weight: weightBySector[sector] || 0,
      last: px.last,
      prev: px.prev,
      pctChange: px.pctChange,
    });
  }

  return jsonResponse(200, {
    mode: 'sector-etf-fallback',
    asOf: fallback.asOf,
    source: 'thetadata-via-supabase',
    generatedAt: roster.generatedAt,
    count: tiles.length,
    pricedCount: tiles.length,
    massiveFailure: massive.reason,
    tiles,
  }, cacheControlHeader());
}

function jsonResponse(status, body, cacheControl) {
  return new Response(JSON.stringify(round(body, 4)), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': cacheControl,
    },
  });
}

function round(node, decimals) {
  if (Array.isArray(node)) return node.map((n) => round(n, decimals));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = round(v, decimals);
    return out;
  }
  if (typeof node === 'number') {
    const f = 10 ** decimals;
    return Math.round(node * f) / f;
  }
  return node;
}
