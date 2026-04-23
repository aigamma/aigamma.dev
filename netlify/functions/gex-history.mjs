// netlify/functions/gex-history.mjs
// Reads daily_gex_stats and returns a time series of daily dealer gamma
// exposure metrics plus derived scalars computed on the fly:
//
//   gamma_index    — 10 × (call_gex - put_gex) / (call_gex + put_gex),
//                    an oscillator bounded [-10, +10]. The ×10 scalar is
//                    a display choice so the number reads like a RSI-style
//                    oscillator around zero rather than a tiny decimal.
//                    Positive = call gamma dominates (stabilizing);
//                    negative = put gamma dominates (destabilizing). The
//                    ratio is normalized so the metric is comparable
//                    across different market regimes where absolute GEX
//                    levels differ by orders of magnitude.
//
//   regime         — 'positive' if spot >= vol_flip, else 'negative'.
//
//   hv_10d_cc      — 10-trading-day close-to-close realized volatility,
//                    annualized by sqrt(252), expressed as a fraction
//                    (0.18 = 18%). Computed from spx_close in the table
//                    so it covers the full options-history date range
//                    without depending on the daily_volatility_stats
//                    backfill.
//
// Query params:
//   from — YYYY-MM-DD inclusive lower bound (default: 2017-01-03)
//   to   — YYYY-MM-DD inclusive upper bound (default: today)

const SUPABASE_TIMEOUT_MS = 8000;
const DEFAULT_FROM = '2017-01-03';
const PAGE_SIZE = 1000;
const HV_WINDOW = 10;
const TRADING_DAYS_YEAR = 252;

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

// Rolling close-to-close realized volatility over N trading days,
// annualized by sqrt(252). Returns an array aligned with the input
// (null for the first N entries where the window is incomplete).
function computeRollingRv(closes, N) {
  const rv = new Array(closes.length).fill(null);
  if (closes.length < N + 1) return rv;

  // Precompute log returns
  const logReturns = new Array(closes.length).fill(null);
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > 0 && closes[i - 1] > 0) {
      logReturns[i] = Math.log(closes[i] / closes[i - 1]);
    }
  }

  for (let i = N; i < closes.length; i++) {
    // Collect the N most recent log returns ending at index i
    const window = [];
    for (let j = i; j > i - N && j > 0; j--) {
      if (logReturns[j] != null) window.push(logReturns[j]);
    }
    if (window.length < N) continue;

    const mean = window.reduce((a, b) => a + b, 0) / window.length;
    const variance = window.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (window.length - 1);
    if (variance > 0 && Number.isFinite(variance)) {
      rv[i] = Math.sqrt(variance * TRADING_DAYS_YEAR);
    }
  }
  return rv;
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

  // Fetch 15 extra days before `from` so the 10-day RV window is warm
  // by the time we reach the first requested date.
  const leadDate = new Date(`${from}T00:00:00Z`);
  leadDate.setUTCDate(leadDate.getUTCDate() - 22); // ~15 trading days
  const fetchFrom = leadDate.toISOString().slice(0, 10);

  const params = new URLSearchParams({
    select: 'trading_date,spx_close,net_gex,call_gex,put_gex,atm_call_gex,atm_put_gex,atm_contract_count,vol_flip_strike,call_wall_strike,put_wall_strike,contract_count',
    trading_date: `gte.${fetchFrom}`,
    order: 'trading_date.asc',
  });
  params.append('trading_date', `lte.${to}`);

  try {
    const rows = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const end = offset + PAGE_SIZE - 1;
      const pageRes = await fetchWithTimeout(
        `${supabaseUrl}/rest/v1/daily_gex_stats?${params}`,
        { headers: { ...headers, Range: `${offset}-${end}`, 'Range-Unit': 'items' } },
        'daily_gex_stats'
      );
      if (!pageRes.ok && pageRes.status !== 206) {
        throw new Error(`daily_gex_stats query failed: ${pageRes.status}`);
      }
      const page = await pageRes.json();
      if (!Array.isArray(page) || page.length === 0) break;
      rows.push(...page);
      if (page.length < PAGE_SIZE) break;
    }

    // Compute derived metrics on the full fetched range (including lead)
    const closes = rows.map((r) => toNum(r.spx_close));
    const rv10 = computeRollingRv(closes, HV_WINDOW);

    // Build the output series, trimming the lead rows
    const series = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.trading_date < from) continue;

      const callGex = toNum(r.call_gex);
      const putGex = toNum(r.put_gex);
      const atmCallGex = toNum(r.atm_call_gex);
      const atmPutGex = toNum(r.atm_put_gex);
      const netGex = toNum(r.net_gex);
      const volFlip = toNum(r.vol_flip_strike);
      const callWall = toNum(r.call_wall_strike);
      const putWall = toNum(r.put_wall_strike);
      const spxClose = toNum(r.spx_close);

      // Gamma Index: ATM-focused version sourced from atm_call_gex and
      // atm_put_gex (|delta| in [0.40, 0.60]) when available. Peak-gamma
      // strikes drive dealer hedging reactivity — the whole-chain sum dilutes
      // the signal with far-OTM put OI that does not rebalance tick-to-tick.
      // Scaled ×10 so the oscillator reads in [-10, +10]. Falls back to the
      // whole-chain ratio for rows pre-backfill (atm_* NULL) so the historical
      // series stays contiguous while the ATM backfill is in flight.
      const atmCount = r.atm_contract_count != null ? Number(r.atm_contract_count) : 0;
      const contractCount = r.contract_count != null ? Number(r.contract_count) : 0;
      let gammaIndex = null;
      if (atmCallGex != null && atmPutGex != null && (atmCallGex + atmPutGex) > 0 && atmCount >= 50) {
        gammaIndex = ((atmCallGex - atmPutGex) / (atmCallGex + atmPutGex)) * 10;
      } else if (callGex != null && putGex != null && (callGex + putGex) > 0 && contractCount >= 1000) {
        gammaIndex = ((callGex - putGex) / (callGex + putGex)) * 10;
      }

      // Regime: spot above vol flip = positive gamma
      let regime = null;
      if (spxClose != null && volFlip != null) {
        regime = spxClose >= volFlip ? 'positive' : 'negative';
      } else if (netGex != null) {
        regime = netGex >= 0 ? 'positive' : 'negative';
      }

      // net_gex runs to ~1e10 dollars of dealer gamma per 1% spot move. 6
      // significant figures (resolution ~1e4 dollars on a 1e10 scale = 1
      // part per million) is three orders of magnitude below the measurement
      // error on the underlying raw gamma values the Massive pipeline
      // aggregates. Trimming strips ~12 trailing noise digits per row and
      // cuts ~16 KB gzipped off the wire across a ~2,300-row SPX history.
      series.push({
        trading_date: r.trading_date,
        spx_close: spxClose,
        net_gex: toSigFig(netGex, 6),
        gamma_index: gammaIndex != null ? Math.round(gammaIndex * 1000) / 1000 : null,
        vol_flip: volFlip,
        call_wall: callWall,
        put_wall: putWall,
        regime,
        hv_10d: rv10[i] != null ? Math.round(rv10[i] * 10000) / 10000 : null,
      });
    }

    return new Response(
      JSON.stringify({ from, to, rowCount: series.length, series }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          // EOD-only dataset: only changes once per trading day after the
          // vol-stats cron writes the new row. 30-minute edge TTL + 24-hour
          // SWR lets repeat visits in the same session serve from cache
          // without ever going back to Supabase.
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

function toSigFig(value, sig) {
  if (value == null) return null;
  if (value === 0) return 0;
  return +value.toPrecision(sig);
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
