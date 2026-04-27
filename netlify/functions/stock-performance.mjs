// netlify/functions/stock-performance.mjs
//
// Read endpoint for the /stocks Stock Performance bar trio (1D / 1W / 1M
// horizontal bar charts). Mirrors netlify/functions/sector-performance.mjs
// in shape and math but swaps the eleven SPDR sector ETFs for eleven
// hand-curated top option-volume single-name stocks. Same Supabase table
// (public.daily_eod), same anchor convention, same payload schema, so the
// frontend can reuse SectorPerformanceBars by passing a different
// endpoint URL.
//
// The eleven names are the current top option-volume single names per
// the 2026-04-26 Barchart OV roster: NVDA, TSLA, INTC, AMD, AMZN, AAPL,
// MU, MSFT, MSTR, META, PLTR. Eleven was picked to match the eleven
// GICS sector slots on the sister /rotations page so a reader can
// scan the two performance trios side by side without re-orienting to
// a different panel height. The list is hardcoded rather than read
// from src/data/options-volume-roster.json because (a) the editorial
// choice of "which 11 names to put on the bars" is independent of the
// rolling roster refresh — promotions and demotions in the broader
// 250-name roster should not silently churn this curated mega-cap
// view week to week, and (b) hardcoding avoids the netlify.toml
// included_files dance that the heatmap and scan endpoints need to
// ship the roster JSON inside their function bundles.
//
// Anchor convention is the standard finance shorthand:
//   1D = previous trading day  -> most recent close vs the one before
//   1W = 5 trading days ago    -> "1 week" in trading-day count
//   1M = 21 trading days ago   -> "1 month" in trading-day count
// Anchors are picked by row-rank inside each symbol's EOD history rather
// than by calendar arithmetic so that holidays and half-sessions don't
// shift the meaning of "5 days ago" across symbols.
//
// Reads through the anon SUPABASE_KEY against the allow_anon_read RLS
// policy on daily_eod, same auth path as /api/sector-performance and
// /api/rotations. Cache-Control: 15 minutes at the edge with a long
// stale-while-revalidate, matching the sister sector-performance
// endpoint — the underlying daily_eod table only changes once per day
// after close when scripts/backfill/daily-eod.mjs runs.

const SUPABASE_TIMEOUT_MS = 8000;

const DEFAULT_LIMIT_LOOKBACK = 30;
const MAX_LIMIT_LOOKBACK = 60;

const ANCHOR_1D = 1;
const ANCHOR_1W = 5;
const ANCHOR_1M = 21;

const PAGE_SIZE = 1000;

// Eleven curated top-option-volume single names. Symbol order in this
// list is by current options volume rank descending so log lines and
// debug dumps read top-down by liquidity; the chart re-sorts each
// panel by return value before rendering, so this initial order does
// not affect display. Names match the Barchart OV roster strings so a
// reader cross-referencing the heatmap or scan pages sees the same
// company labels here.
const TOP_STOCKS = [
  { symbol: 'NVDA', name: 'Nvidia' },
  { symbol: 'TSLA', name: 'Tesla' },
  { symbol: 'INTC', name: 'Intel' },
  { symbol: 'AMD',  name: 'AMD' },
  { symbol: 'AMZN', name: 'Amazon' },
  { symbol: 'AAPL', name: 'Apple' },
  { symbol: 'MU',   name: 'Micron' },
  { symbol: 'MSFT', name: 'Microsoft' },
  { symbol: 'MSTR', name: 'Strategy' },
  { symbol: 'META', name: 'Meta Platforms' },
  { symbol: 'PLTR', name: 'Palantir' },
];

const STOCK_SYMBOLS = TOP_STOCKS.map((s) => s.symbol);

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

  const lookbackParam = Number(url.searchParams.get('limit_lookback'));
  const lookback = Number.isFinite(lookbackParam) && lookbackParam > 0
    ? Math.min(Math.floor(lookbackParam), MAX_LIMIT_LOOKBACK)
    : DEFAULT_LIMIT_LOOKBACK;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  if (!supabaseUrl || !supabaseKey) return jsonError(500, 'Supabase not configured');

  const headers = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json',
  };

  try {
    // lookback × 11 stocks = ~330 rows for defaults — fits in one page,
    // but loop anyway in case a future caller bumps lookback to MAX.
    const params = new URLSearchParams({
      select: 'symbol,trading_date,close',
      order: 'trading_date.desc,symbol.asc',
      symbol: `in.(${STOCK_SYMBOLS.join(',')})`,
      limit: String(lookback * STOCK_SYMBOLS.length),
    });

    const rows = [];
    const rowLimit = lookback * STOCK_SYMBOLS.length;
    for (let offset = 0; offset < rowLimit; offset += PAGE_SIZE) {
      const end = Math.min(offset + PAGE_SIZE, rowLimit) - 1;
      const res = await fetchWithTimeout(
        `${supabaseUrl}/rest/v1/daily_eod?${params}`,
        { headers: { ...headers, Range: `${offset}-${end}`, 'Range-Unit': 'items' } },
        'daily_eod',
      );
      if (!res.ok && res.status !== 206) {
        throw new Error(`daily_eod query failed: ${res.status}`);
      }
      const page = await res.json();
      if (!Array.isArray(page) || page.length === 0) break;
      rows.push(...page);
      if (page.length < end - offset + 1) break;
    }
    if (rows.length === 0) return jsonError(404, 'No daily_eod rows available for top stocks');

    const bySymbol = {};
    for (const r of rows) {
      (bySymbol[r.symbol] ||= []).push({ date: r.trading_date, close: Number(r.close) });
    }
    for (const sym of Object.keys(bySymbol)) {
      bySymbol[sym].sort((a, b) => a.date.localeCompare(b.date));
    }

    const stocks = [];
    let asOf = null;
    for (const { symbol, name } of TOP_STOCKS) {
      const series = bySymbol[symbol];
      if (!series || series.length < ANCHOR_1M + 1) continue;

      const n = series.length;
      const latest = series[n - 1];
      const a1d = series[n - 1 - ANCHOR_1D];
      const a1w = series[n - 1 - ANCHOR_1W];
      const a1m = series[n - 1 - ANCHOR_1M];

      if (!latest || !a1d || !a1w || !a1m) continue;
      if ([latest.close, a1d.close, a1w.close, a1m.close].some((v) => !Number.isFinite(v) || v <= 0)) continue;

      stocks.push({
        symbol,
        name,
        latest_close: latest.close,
        latest_date: latest.date,
        return_1d: ((latest.close - a1d.close) / a1d.close) * 100,
        return_1w: ((latest.close - a1w.close) / a1w.close) * 100,
        return_1m: ((latest.close - a1m.close) / a1m.close) * 100,
      });

      if (!asOf || latest.date > asOf) asOf = latest.date;
    }

    if (stocks.length === 0) return jsonError(502, 'No stock returns computable');

    const sorted_1d = [...stocks].sort((a, b) => b.return_1d - a.return_1d);
    const sorted_1w = [...stocks].sort((a, b) => b.return_1w - a.return_1w);
    const sorted_1m = [...stocks].sort((a, b) => b.return_1m - a.return_1m);

    const payload = {
      asOf,
      anchors: { day: ANCHOR_1D, week: ANCHOR_1W, month: ANCHOR_1M },
      panels: {
        '1d': sorted_1d.map((s) => ({ symbol: s.symbol, name: s.name, value: s.return_1d })),
        '1w': sorted_1w.map((s) => ({ symbol: s.symbol, name: s.name, value: s.return_1w })),
        '1m': sorted_1m.map((s) => ({ symbol: s.symbol, name: s.name, value: s.return_1m })),
      },
      stocks,
      source: 'thetadata',
    };

    return new Response(JSON.stringify(round(payload, 4)), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=900, stale-while-revalidate=86400',
      },
    });
  } catch (err) {
    return jsonError(502, err.message);
  }
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

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
