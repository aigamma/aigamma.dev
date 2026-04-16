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

    const series = rows.map((r) => ({
      trading_date: r.trading_date,
      spx_open: toNum(r.spx_open),
      spx_high: toNum(r.spx_high),
      spx_low: toNum(r.spx_low),
      spx_close: toNum(r.spx_close),
      hv_20d_yz: toNum(r.hv_20d_yz),
      iv_30d_cm: toNum(r.iv_30d_cm),
      vrp_spread: toNum(r.vrp_spread),
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
          // Longer cache than the intraday endpoint — this is EOD-only data
          // that only changes once per trading day after the vol-stats cron.
          'Cache-Control': 'public, max-age=300, stale-while-revalidate=1800',
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

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
