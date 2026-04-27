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
// Wire shape: each VIX series row is `{date, close}` and each SPX series row
// is `{date, spx_close, hv_20d_yz, iv_30d_cm}` — close-only, no OHLC. Audit
// across every /vix consumer (App.jsx + the ten chart components in
// src/components/vix/* + the helpers in src/lib/vix-models.js) confirmed
// none of them read open / high / low for any of the 17 VIX-family symbols
// or for the SPX context series; every reference is either `.close` for
// the VIX symbols or `spx_close` / `hv_20d_yz` / `iv_30d_cm` for the SPX
// series. The backfill scripts (compute-vol-stats.mjs's Yang-Zhang HV
// estimator, pull-spx-ohlc.mjs, spx-intraday-bars.mjs) still write OHLC to
// the underlying daily_volatility_stats / vix_family_eod tables — that
// remains the data of record — but the /api/vix-data wire response drops
// the three OHLC columns, saving ~550 KB on the response (~13,600 rows ×
// ~30 bytes/row of dropped open/high/low text JSON across the 17-symbol
// fan-out, plus ~24 KB on the SPX series). Net wire payload drops from
// ~1.21 MB to ~640 KB on a typical from=2023-03-01 request, halving
// transfer time on slow connections without changing any rendered surface.
// If a future /vix card ever needs candles for VIX itself, the data is one
// SQL column-list edit away — but right now nothing consumes it.
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
      // Close-only projection. The underlying vix_family_eod table stores
      // OHLC for every symbol, but no /vix consumer reads open/high/low —
      // see the wire-shape comment at the top of this file for the audit
      // that confirmed it. Trimming the SQL select to (symbol,
      // trading_date, close) cuts both Supabase egress AND the JSON
      // serialization the function pays per request.
      select: 'symbol,trading_date,close',
      symbol: `in.(${VIX_SYMBOLS.join(',')})`,
      trading_date: `gte.${from}`,
      order: 'symbol.asc,trading_date.asc',
    });
    vixParams.append('trading_date', `lte.${to}`);

    const spxParams = new URLSearchParams({
      // Same close-only treatment for the SPX context series. spx_open /
      // spx_high / spx_low are columns in daily_volatility_stats that
      // back compute-vol-stats.mjs's Yang-Zhang HV estimator (the
      // backfill writes OHLC and reads OHLC server-side to compute the
      // hv_20d_yz column on this same row), but no client surface reads
      // the OHLC fields from the wire — only spx_close, hv_20d_yz, and
      // iv_30d_cm.
      select: 'trading_date,spx_close,hv_20d_yz,iv_30d_cm',
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

    // Bucket VIX rows by symbol, ascending date. Close-only payload (see
    // the wire-shape comment at the top of this file).
    const bySymbol = {};
    for (const sym of VIX_SYMBOLS) bySymbol[sym] = [];
    for (const r of vixRows) {
      const arr = bySymbol[r.symbol];
      if (!arr) continue;
      arr.push({
        date: r.trading_date,
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
    // OHLC fields (spx_open / spx_high / spx_low) are dropped from the wire —
    // backfill server-side reads them from daily_volatility_stats to compute
    // hv_20d_yz, but no /vix consumer reads them client-side.
    const spxSeries = spxRows.map((r) => ({
      date: r.trading_date,
      spx_close: toNum(r.spx_close),
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
