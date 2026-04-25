// netlify/functions/sector-performance.mjs
//
// Read endpoint for the /rotations sector-performance bars (1D / 1W / 1M
// horizontal bar charts that match the reference image at C:\i\). Pulls
// the recent ~30 trading days of EOD closes for the eleven SPDR sector
// ETFs from public.daily_eod, computes percent-change returns over three
// horizon anchors, and returns one payload sorted descending by each
// horizon so the React component can render the three charts directly
// without further sorting on the client.
//
// Anchor convention is the standard finance shorthand:
//   1D = previous trading day  → most recent close vs the one before it
//   1W = 5 trading days ago    → "1 week" in trading-day count
//   1M = 21 trading days ago   → "1 month" in trading-day count
// These map cleanly onto the three panels of the reference image and the
// labels that ship in the GICS sector-performance widgets the project
// wants to mirror. Anchors are picked by row-rank inside each symbol's
// EOD history rather than by calendar arithmetic so that holidays and
// half-sessions don't shift the meaning of "5 days ago" across symbols.
//
// The eleven SPDR sector ETFs map 1:1 to GICS sectors (XLK = Technology,
// XLY = Consumer Cyclical, etc.). The reference image uses sector names,
// not tickers, so the payload carries both — name for the y-axis label,
// symbol for hover and for cross-referencing with the rotation scatter
// above. The three additional theme ETFs in daily_eod (XBI biotech, XME
// metals & mining, KWEB China internet) are intentionally excluded from
// the bars since the chart is a sector-rotation surface, not a thematic
// breadth surface; they remain on the rotation scatter where their
// thematic positioning vs SPY is the relevant signal.
//
// Query params:
//   limit_lookback — how many trailing rows to pull per symbol (default
//                     30, max 60). The math only needs 22 rows but the
//                     extra buffer leaves slack for any single missing
//                     bar that would otherwise misalign the anchor count.
//
// Reads through the anon SUPABASE_KEY against the allow_anon_read RLS
// policy on daily_eod, same auth path as /api/rotations and /api/seasonality.
// Cache-Control: 15 minutes at the edge with a long stale-while-revalidate.
// The underlying daily_eod table only changes once per day after close
// when the backfill runs, so a sub-quarter-hour origin freshness profile
// is the right balance — frequent enough to pick up the post-close write,
// patient enough that the function doesn't re-execute on every page view.

const SUPABASE_TIMEOUT_MS = 8000;

const DEFAULT_LIMIT_LOOKBACK = 30;
const MAX_LIMIT_LOOKBACK = 60;

// Anchor offsets in trading-day count, indexed from the most recent close.
// 0 is the latest close, 1 is the previous close, 5 is one week ago, 21 is
// one month ago. The lookback ceiling above must cover MAX(anchors) with
// margin for missing-bar slack.
const ANCHOR_1D = 1;
const ANCHOR_1W = 5;
const ANCHOR_1M = 21;

const PAGE_SIZE = 1000;

// Eleven SPDR sector ETFs in GICS order. Names match the reference image
// at C:\i\ — "Consumer Cyclical" rather than "Consumer Discretionary",
// "Consumer Defensive" rather than "Consumer Staples", "Financial"
// rather than "Financials" (singular). These are the conventional
// rendering on retail finance dashboards even though the GICS taxonomy
// itself uses the longer-form names.
const SECTOR_ETFS = [
  { symbol: 'XLK',  name: 'Technology' },
  { symbol: 'XLV',  name: 'Healthcare' },
  { symbol: 'XLF',  name: 'Financial' },
  { symbol: 'XLY',  name: 'Consumer Cyclical' },
  { symbol: 'XLC',  name: 'Communication Services' },
  { symbol: 'XLI',  name: 'Industrials' },
  { symbol: 'XLP',  name: 'Consumer Defensive' },
  { symbol: 'XLE',  name: 'Energy' },
  { symbol: 'XLU',  name: 'Utilities' },
  { symbol: 'XLRE', name: 'Real Estate' },
  { symbol: 'XLB',  name: 'Basic Materials' },
];

const SECTOR_SYMBOLS = SECTOR_ETFS.map((s) => s.symbol);
const SECTOR_NAME_BY_SYMBOL = Object.fromEntries(
  SECTOR_ETFS.map((s) => [s.symbol, s.name]),
);

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
    // Pull the most recent `lookback` rows per symbol in one paged query.
    // Lookback × 11 sectors = ~330 rows for defaults — fits in one page,
    // but loop anyway in case a future caller bumps lookback to MAX.
    const params = new URLSearchParams({
      select: 'symbol,trading_date,close',
      order: 'trading_date.desc,symbol.asc',
      symbol: `in.(${SECTOR_SYMBOLS.join(',')})`,
      limit: String(lookback * SECTOR_SYMBOLS.length),
    });

    const rows = [];
    const rowLimit = lookback * SECTOR_SYMBOLS.length;
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
    if (rows.length === 0) return jsonError(404, 'No daily_eod rows available');

    // Bucket rows by symbol → ascending-date close array. Same shape as
    // /api/rotations so future code that wants to do its own anchor math
    // can reuse the reading pattern.
    const bySymbol = {};
    for (const r of rows) {
      (bySymbol[r.symbol] ||= []).push({ date: r.trading_date, close: Number(r.close) });
    }
    for (const sym of Object.keys(bySymbol)) {
      bySymbol[sym].sort((a, b) => a.date.localeCompare(b.date));
    }

    // Compute returns per sector. The minimum required series length is
    // ANCHOR_1M + 1; sectors with shorter series are dropped (none in the
    // current production data, but the guard keeps the function honest).
    const sectors = [];
    let asOf = null;
    for (const { symbol, name } of SECTOR_ETFS) {
      const series = bySymbol[symbol];
      if (!series || series.length < ANCHOR_1M + 1) continue;

      const n = series.length;
      const latest = series[n - 1];
      const a1d = series[n - 1 - ANCHOR_1D];
      const a1w = series[n - 1 - ANCHOR_1W];
      const a1m = series[n - 1 - ANCHOR_1M];

      if (!latest || !a1d || !a1w || !a1m) continue;
      if ([latest.close, a1d.close, a1w.close, a1m.close].some((v) => !Number.isFinite(v) || v <= 0)) continue;

      sectors.push({
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

    if (sectors.length === 0) return jsonError(502, 'No sector returns computable');

    // Pre-sorted views by horizon, descending. The chart renders these
    // directly as bar y-axis order (top = best, bottom = worst).
    const sorted_1d = [...sectors].sort((a, b) => b.return_1d - a.return_1d);
    const sorted_1w = [...sectors].sort((a, b) => b.return_1w - a.return_1w);
    const sorted_1m = [...sectors].sort((a, b) => b.return_1m - a.return_1m);

    const payload = {
      asOf,
      anchors: { day: ANCHOR_1D, week: ANCHOR_1W, month: ANCHOR_1M },
      panels: {
        '1d': sorted_1d.map((s) => ({ symbol: s.symbol, name: s.name, value: s.return_1d })),
        '1w': sorted_1w.map((s) => ({ symbol: s.symbol, name: s.name, value: s.return_1w })),
        '1m': sorted_1m.map((s) => ({ symbol: s.symbol, name: s.name, value: s.return_1m })),
      },
      sectors,
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
