// netlify/functions/vrp-history.mjs
// Reads the daily_volatility_stats table and returns a time series of SPX
// OHLC plus the derived Yang-Zhang realized vol, 30-day constant-maturity
// ATM IV, and VRP spread (IV − HV) used by the Volatility Risk Premium chart.
//
// Query params:
//   from — YYYY-MM-DD inclusive lower bound (optional; default 2022-01-01)
//   to   — YYYY-MM-DD inclusive upper bound (optional; default today)

const SUPABASE_TIMEOUT_MS = 8000;
const DEFAULT_FROM = '2022-01-01';
const PAGE_SIZE = 1000;

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

export default async function handler(request) {
  const url = new URL(request.url);
  const from = url.searchParams.get('from') || DEFAULT_FROM;
  const to = url.searchParams.get('to') || new Date().toISOString().slice(0, 10);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return jsonError(400, 'from and to must be YYYY-MM-DD');
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return jsonError(500, 'Supabase not configured');
  }

  const headers = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json',
  };

  const params = new URLSearchParams({
    select: 'trading_date,spx_open,spx_high,spx_low,spx_close,hv_20d_yz,iv_30d_cm,vrp_spread,sample_count',
    trading_date: `gte.${from}`,
    order: 'trading_date.asc',
  });
  params.append('trading_date', `lte.${to}`);

  try {
    // Page through via Range header so the endpoint doesn't silently truncate
    // once the backfill passes the 1000-row PostgREST default. With one row
    // per trading day, 1000 rows ≈ 4 calendar years of history.
    const rows = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const end = offset + PAGE_SIZE - 1;
      const pageRes = await fetchWithTimeout(
        `${supabaseUrl}/rest/v1/daily_volatility_stats?${params}`,
        { headers: { ...headers, Range: `${offset}-${end}`, 'Range-Unit': 'items' } },
        'daily_volatility_stats'
      );
      if (!pageRes.ok && pageRes.status !== 206) {
        throw new Error(`daily_volatility_stats query failed: ${pageRes.status}`);
      }
      const page = await pageRes.json();
      if (!Array.isArray(page) || page.length === 0) break;
      rows.push(...page);
      if (page.length < PAGE_SIZE) break;
    }

    // Vol / VRP numerics are trimmed to 5 decimal places (resolution 1e-5 =
    // 0.001 IV points), which is two orders of magnitude below the sampling
    // noise on the underlying 20-day realized-vol and 30-day constant-
    // maturity-IV estimators and dwarfs the day-over-day change in the VRP
    // spread this chart actually surfaces. Trimming cuts ~16 KB gzipped off
    // the wire per request by stripping the ~12 trailing noise digits the
    // full-float storage emitted. OHLC and sample_count are left at their
    // native precisions (OHLC already stored at 2dp by ThetaData, sample_
    // count an integer).
    const series = rows.map((r) => ({
      trading_date: r.trading_date,
      spx_open: toNum(r.spx_open),
      spx_high: toNum(r.spx_high),
      spx_low: toNum(r.spx_low),
      spx_close: toNum(r.spx_close),
      hv_20d_yz: roundTo(toNum(r.hv_20d_yz), 5),
      iv_30d_cm: roundTo(toNum(r.iv_30d_cm), 5),
      vrp_spread: roundTo(toNum(r.vrp_spread), 5),
      sample_count: r.sample_count,
    }));

    return new Response(
      JSON.stringify({
        from,
        to,
        rowCount: series.length,
        series,
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          // EOD-only data that only changes once per trading day after the
          // vol-stats cron. 30-minute edge TTL + 24-hour SWR lets repeat
          // visits serve from the CDN without retouching Supabase.
          'Cache-Control': 'public, max-age=1800, stale-while-revalidate=86400',
        },
      }
    );
  } catch (err) {
    return jsonError(502, err.message);
  }
}

function toNum(value) {
  if (value == null) return null;
  const n = parseFloat(value);
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
