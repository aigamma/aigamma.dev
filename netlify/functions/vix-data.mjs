// netlify/functions/vix-data.mjs
//
// Read endpoint for the /vix lab. Returns the full daily history for every
// symbol in public.vix_family_eod (VIX family, cross-asset vol, skew, Cboe
// strategy benchmarks) plus the SPX OHLC + 30-day constant-maturity IV /
// 20-day realized vol series from public.daily_volatility_stats so the lab
// can compute the VIX-vs-realized comparison without a second round trip.
//
// All ten visualizations on /vix derive from this single payload; they
// recompute in the browser from the raw daily series. Mean reversion (OU
// calibration), volatility cones, regime bucketing, vol-of-vol realized
// estimation, term structure history, and strategy-vs-SPX cumulative-return
// math all read from the same series array. Centralizing the data fan-in here
// keeps the page's first-render path to one network call.
//
// Cache profile mirrors /api/vrp-history and /api/rotations: 30-minute edge
// TTL with a long stale-while-revalidate. The underlying tables only refresh
// once per trading day after close, so a tighter TTL would only burn origin
// requests for no freshness gain.
//
// Query params:
//   from — YYYY-MM-DD inclusive lower bound (optional; default 2023-03-01)
//   to   — YYYY-MM-DD inclusive upper bound (optional; default today)

const SUPABASE_TIMEOUT_MS = 8000;
const PAGE_SIZE = 1000;
const DEFAULT_FROM = '2023-03-01';

// Symbol catalog. Order matters: drives column order in the term-structure
// curve and the dropdown order in the cross-asset panel. Keep in sync with
// scripts/backfill/vix-family-eod.mjs.
const VIX_SYMBOLS = [
  'VIX', 'VIX1D', 'VIX9D', 'VIX3M', 'VIX6M', 'VIX1Y',
  'VVIX',
  'VXN', 'RVX', 'OVX', 'GVZ',
  'SKEW', 'SDEX',
  'BXM', 'BXMD', 'BFLY', 'CNDR',
];

async function fetchWithTimeout(url, options, label) {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(SUPABASE_TIMEOUT_MS) });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new Error(`${label} timed out after ${SUPABASE_TIMEOUT_MS}ms`);
    }
    throw err;
  }
}

async function fetchAllRows(supabaseUrl, headers, path, label) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const end = offset + PAGE_SIZE - 1;
    const res = await fetchWithTimeout(
      `${supabaseUrl}${path}`,
      { headers: { ...headers, Range: `${offset}-${end}`, 'Range-Unit': 'items' } },
      label,
    );
    if (!res.ok && res.status !== 206) {
      throw new Error(`${label} failed: ${res.status}`);
    }
    const page = await res.json();
    if (!Array.isArray(page) || page.length === 0) break;
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

export default async function handler(request) {
  const url = new URL(request.url);
  const from = url.searchParams.get('from') || DEFAULT_FROM;
  const to = url.searchParams.get('to') || new Date().toISOString().slice(0, 10);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return jsonError(400, 'from and to must be YYYY-MM-DD');
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  if (!supabaseUrl || !supabaseKey) return jsonError(500, 'Supabase not configured');

  const headers = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json',
  };

  try {
    // Two parallel fetches: every vix_family_eod row in the window, plus
    // the SPX OHLC + 30d CM IV + 20d HV series for the VIX-vs-realized
    // chart. Both are paged via the Range header pattern used in
    // vrp-history / rotations.
    const vixParams = new URLSearchParams({
      select: 'symbol,trading_date,open,high,low,close',
      symbol: `in.(${VIX_SYMBOLS.join(',')})`,
      trading_date: `gte.${from}`,
      order: 'symbol.asc,trading_date.asc',
    });
    vixParams.append('trading_date', `lte.${to}`);

    const spxParams = new URLSearchParams({
      select: 'trading_date,spx_close,spx_open,spx_high,spx_low,hv_20d_yz,iv_30d_cm',
      trading_date: `gte.${from}`,
      order: 'trading_date.asc',
    });
    spxParams.append('trading_date', `lte.${to}`);

    const [vixRows, spxRows] = await Promise.all([
      fetchAllRows(
        supabaseUrl,
        headers,
        `/rest/v1/vix_family_eod?${vixParams}`,
        'vix_family_eod',
      ),
      fetchAllRows(
        supabaseUrl,
        headers,
        `/rest/v1/daily_volatility_stats?${spxParams}`,
        'daily_volatility_stats',
      ),
    ]);

    // Bucket VIX rows by symbol, ascending date.
    const bySymbol = {};
    for (const sym of VIX_SYMBOLS) bySymbol[sym] = [];
    for (const r of vixRows) {
      const arr = bySymbol[r.symbol];
      if (!arr) continue;
      arr.push({
        date: r.trading_date,
        open: toNum(r.open),
        high: toNum(r.high),
        low: toNum(r.low),
        close: toNum(r.close),
      });
    }

    // Latest snapshot per symbol — last row in each ascending series. Used
    // by the header pill grid, term structure curve, and percentile-rank
    // computations on the page.
    const latest = {};
    for (const sym of VIX_SYMBOLS) {
      const arr = bySymbol[sym];
      if (arr.length === 0) {
        latest[sym] = null;
        continue;
      }
      const last = arr[arr.length - 1];
      latest[sym] = { date: last.date, close: last.close };
    }

    // SPX context series. Trim to the same precision the existing vrp-history
    // endpoint uses (5 dp on vols, 2 dp on prices). Filter out warmup rows
    // missing both vol estimators so the chart never plots null gaps.
    const spxSeries = spxRows.map((r) => ({
      date: r.trading_date,
      spx_close: toNum(r.spx_close),
      spx_open: toNum(r.spx_open),
      spx_high: toNum(r.spx_high),
      spx_low: toNum(r.spx_low),
      hv_20d_yz: roundTo(toNum(r.hv_20d_yz), 5),
      iv_30d_cm: roundTo(toNum(r.iv_30d_cm), 5),
    }));

    const lastVixDate = latest['VIX']?.date || null;
    const lastSpxDate = spxSeries[spxSeries.length - 1]?.date || null;

    return new Response(
      JSON.stringify({
        from,
        to,
        asOf: lastVixDate,
        spxAsOf: lastSpxDate,
        symbols: VIX_SYMBOLS,
        latest,
        series: bySymbol,
        spx: spxSeries,
        rowCount: vixRows.length,
        spxRowCount: spxSeries.length,
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=1800, stale-while-revalidate=86400',
        },
      },
    );
  } catch (err) {
    return jsonError(502, err.message);
  }
}

function toNum(v) {
  if (v == null) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function roundTo(value, decimals) {
  if (value == null) return null;
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
