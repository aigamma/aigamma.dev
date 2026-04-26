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

// Page through any /rest/v1/* endpoint via the PostgREST Range header until
// the table is drained. PostgREST caps each response at 1000 rows by default,
// so anything that might exceed that has to paginate explicitly. Used for
// both daily_volatility_stats (one row per trading day, ~1100 rows of
// 4-year backfill) and vix_family_eod (filtered to symbol=VIX, ~800 rows).
async function fetchAllRows(supabaseUrl, headers, path, label) {
  const out = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const end = offset + PAGE_SIZE - 1;
    const res = await fetchWithTimeout(
      `${supabaseUrl}${path}`,
      { headers: { ...headers, Range: `${offset}-${end}`, 'Range-Unit': 'items' } },
      label,
    );
    if (!res.ok && res.status !== 206) {
      throw new Error(`${label} query failed: ${res.status}`);
    }
    const page = await res.json();
    if (!Array.isArray(page) || page.length === 0) break;
    out.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return out;
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

  // Projection tightened to the four fields any frontend consumer actually
  // reads (VolatilityRiskPremium and App.jsx's VRP pill): trading_date,
  // spx_close, hv_20d_yz, iv_30d_cm. A grep audit across src/ showed zero
  // consumers read spx_open / spx_high / spx_low (OHLC was never surfaced
  // on the chart or tooltip — the card plots daily close only), zero read
  // vrp_spread (the spread is recomputed client-side from iv - hv so the
  // chart can annotate the sign and day-over-day delta uniformly; the
  // pre-computed column was a redundant duplicate), and zero read sample_
  // count (the Yang-Zhang estimator's sample window is a fixed 20 trading
  // days so the count is always 20 for mature rows and a small number for
  // the warmup window, but no chart or tooltip displays it). Dropping the
  // five unused columns from both the Supabase SELECT and the wire emit
  // saves ~26 KB gzipped / 51% of the endpoint payload on a 1,078-row
  // response.
  const params = new URLSearchParams({
    select: 'trading_date,spx_close,hv_20d_yz,iv_30d_cm',
    trading_date: `gte.${from}`,
    order: 'trading_date.asc',
  });
  params.append('trading_date', `lte.${to}`);

  // VIX is read off the vix_family_eod table populated by the Massive
  // Indices Starter backfill (see scripts/backfill/vix-family-eod.mjs).
  // Merged into the response by trading_date so the VRP chart can plot
  // VIX as an additional vol line alongside the chain-derived 30d CM IV
  // and the SPX 20d Yang-Zhang realized vol — the three lines compared
  // on shared annualized-percent units form a richer VRP picture
  // (Cboe-published implied vol vs our chain-derived implied vol vs
  // realized vs SPX-spot context). vix_family_eod history starts at
  // 2023-03-01 (Massive Indices Starter floor); rows older than that
  // come back without a vix field, so the chart treats the series as
  // null-tolerant.
  const vixParams = new URLSearchParams({
    select: 'trading_date,close',
    symbol: 'eq.VIX',
    trading_date: `gte.${from}`,
    order: 'trading_date.asc',
  });
  vixParams.append('trading_date', `lte.${to}`);

  try {
    // Page through via Range header so the endpoint doesn't silently truncate
    // once the backfill passes the 1000-row PostgREST default. With one row
    // per trading day, 1000 rows ≈ 4 calendar years of history. The VIX
    // fetch fires in parallel with the vol-stats fetch so the second query
    // doesn't add to the endpoint's wall-clock latency.
    const [rows, vixRows] = await Promise.all([
      fetchAllRows(supabaseUrl, headers, `/rest/v1/daily_volatility_stats?${params}`, 'daily_volatility_stats'),
      fetchAllRows(supabaseUrl, headers, `/rest/v1/vix_family_eod?${vixParams}`, 'vix_family_eod'),
    ]);

    // Index VIX by trading_date for the merge step below. With ~800 rows of
    // VIX history the Map lookup is O(1) per merge; a sort-merge or sql
    // JOIN would be no faster at this scale.
    const vixByDate = new Map();
    for (const r of vixRows) {
      const v = toNum(r.close);
      if (v != null) vixByDate.set(r.trading_date, v);
    }

    // Vol numerics are trimmed to 5 decimal places (resolution 1e-5 =
    // 0.001 IV points), two orders of magnitude below the sampling noise
    // on the underlying 20-day realized-vol and 30-day constant-maturity-
    // IV estimators. Trimming cuts ~16 KB gzipped per request by stripping
    // the ~12 trailing noise digits the full-float storage emitted. SPX
    // close is already 2dp from ThetaData, no precision trim needed. VIX
    // is already 2dp from Massive's daily aggregates, no trim needed.
    const series = rows.map((r) => ({
      trading_date: r.trading_date,
      spx_close: toNum(r.spx_close),
      hv_20d_yz: roundTo(toNum(r.hv_20d_yz), 5),
      iv_30d_cm: roundTo(toNum(r.iv_30d_cm), 5),
      vix: vixByDate.get(r.trading_date) ?? null,
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
