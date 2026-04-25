// netlify/functions/rotations.mjs
//
// Read endpoint for the /rotations Relative Sector Rotation lab. Pulls
// the multi-symbol universe from public.daily_eod, computes the rotation
// ratio and rotation momentum for every component vs the SPY benchmark,
// and returns one tail of `tail` points per component for the chart.
// Default universe is the SPDR sector ETF set from C:\i\: SPY benchmark
// plus XBI / XLB / XLC / XLE / XLF / XLI / XLK / XLP / XLRE / XLU / XLV /
// XLY / XME / KWEB. Source data is ThetaData /v3/stock/history/eod (Stock
// Value tier on this account as of 2026-04-25).
//
// The math is the open standardized-relative-strength construction that
// any reader can derive from a benchmark series and a component series:
//
//   1. Relative strength:
//        RS_i,t = (close_i,t / close_benchmark,t) × 100
//      A scale factor that makes "in line with benchmark" map to 100.
//
//   2. Rotation ratio — standardized RS centered at 100:
//        μ = SMA(RS, L), σ = stdev(RS, L)
//        rotation_ratio = 100 + (RS − μ) / σ
//      L = norm_window. Above 100 = leading, below 100 = lagging.
//
//   3. Rotation momentum — standardized ROC of rotation_ratio centered at 100:
//        ROC = rotation_ratio_t − rotation_ratio_{t−M}
//        μ_R = SMA(ROC, L), σ_R = stdev(ROC, L)
//        rotation_momentum = 100 + (ROC − μ_R) / σ_R
//      M = momentum_lookback. Above 100 = gaining momentum.
//
// The four quadrants on the chart are:
//     Leading    (ratio > 100, momentum > 100) — top-right, green
//     Weakening  (ratio > 100, momentum < 100) — bottom-right, yellow
//     Lagging    (ratio < 100, momentum < 100) — bottom-left, red
//     Improving  (ratio < 100, momentum > 100) — top-left, blue
//
// Query params:
//   tail        — how many trailing points per component (default 10, max 60)
//   step        — granularity of each tail point: 'day' (default) | 'week' | 'hour'
//   symbols     — comma-separated component override (default = all in table)
//   benchmark   — benchmark symbol (default 'SPY')
//
// step=day uses one daily close per tail point and standardizes over a
// 63-day window with a 5-day momentum lookback. step=week resamples
// daily_eod to one close per ISO week (the last trading day's close)
// and uses a 26-week / 2-week pair, scaled down because two years of
// daily data only yields ~104 weekly samples and a 63-week window would
// chew most of it as warm-up. step=hour requires intraday ETF bars
// that aren't yet ingested into Supabase — daily_eod is end-of-day only
// and the existing intraday ingest path (Massive API → snapshots)
// covers SPX option chains, not sector ETF prices — so hour mode
// returns a 503 with a clear explanation. Adding hourly support is a
// follow-up that needs a new etf_intraday_bars table fed by ThetaData
// stock OHLC at the Stock Value tier (which the account has as of
// 2026-04-25) plus a backfill script analogous to scripts/backfill/
// spx-intraday-bars.mjs.
//
// Reads through the anon SUPABASE_KEY against the allow_anon_read RLS
// policy on daily_eod. Cache-Control: 15 minutes at the edge with
// a long stale-while-revalidate, matching the seasonality endpoint —
// the table only changes once per day after close when the backfill runs.

const SUPABASE_TIMEOUT_MS = 8000;

const DEFAULT_TAIL = 10;
const MAX_TAIL = 60;

// Per-step standardization parameters. Day mirrors the original 63-day /
// 5-day pair that the chart was first calibrated against. Week shrinks to
// 26-week / 2-week so a 2-year daily backfill (~104 weekly samples)
// leaves plenty of headroom for the warm-up window, and the displayed
// dynamics still capture quarter-scale relative-strength rotation. Hour
// values are placeholders that future intraday support can use — the
// step=hour branch errors out before they're consulted today.
const STEP_CONFIG = {
  day:  { normWindow: 63, momentumLookback: 5, label: 'days' },
  week: { normWindow: 26, momentumLookback: 2, label: 'weeks' },
  hour: { normWindow: 39, momentumLookback: 3, label: 'hours' },
};
const DEFAULT_STEP = 'day';

// PostgREST caps at 1000 rows per response. We need (tail + 2L + M + buffer)
// periods × ~15 symbols of rows. Day mode peaks around 150 days × 15 = 2250
// rows; week mode needs 2×26+2+10 ≈ 65 weeks × 5 trading days = 325 days ×
// 15 = 4875 rows — both well above the cap, so paginate.
const PAGE_SIZE = 1000;

const DEFAULT_BENCHMARK = 'SPY';

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

  const stepParam = (url.searchParams.get('step') || DEFAULT_STEP).toLowerCase();
  if (!STEP_CONFIG[stepParam]) {
    return jsonError(400, `Unknown step: ${stepParam}. Use day, week, or hour.`);
  }
  const stepConfig = STEP_CONFIG[stepParam];

  const tailParam = Number(url.searchParams.get('tail'));
  const tail = Number.isFinite(tailParam) && tailParam > 0
    ? Math.min(Math.floor(tailParam), MAX_TAIL)
    : DEFAULT_TAIL;

  const benchmark = (url.searchParams.get('benchmark') || DEFAULT_BENCHMARK).toUpperCase();

  const symbolsRaw = url.searchParams.get('symbols');
  const symbolsFilter = symbolsRaw
    ? symbolsRaw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
    : null;

  // Hourly rotation needs intraday ETF bars that don't yet land in any
  // Supabase table — daily_eod is end-of-day only, and the existing
  // intraday ingest pipeline (Massive API → snapshots/computed_levels)
  // covers SPX option chains, not sector ETF prices. Surface this
  // explicitly so the UI can render a clear note instead of an opaque
  // error; the path lights up once an etf_intraday_bars table is fed by
  // a follow-up backfill script analogous to spx-intraday-bars.mjs.
  if (stepParam === 'hour') {
    return jsonError(503,
      'Hourly rotation needs intraday ETF bars in Supabase, which are not yet ingested. ' +
      'The daily_eod table is end-of-day only and no etf_intraday_bars table exists. ' +
      'Use day or week with the existing daily backfill, or run a ThetaData stock OHLC ' +
      'intraday backfill to enable hourly mode.'
    );
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
    // Pull enough trailing rows to cover the longest computation window
    // for every symbol, then trim to `tail` at the end. The window has
    // to fit RS(t) → SMA(L) over RS → diff(M) over rotation_ratio →
    // SMA(L) over diff = 2L + M − 2 periods of warm-up before the first
    // valid rotation_momentum point, plus tail for the visible trail.
    // Week mode multiplies that by ~5 to convert weekly periods into
    // calendar days that need to be present in daily_eod before
    // resampling, plus a small slack for the resampler's last-day bias.
    const minPeriods = 2 * stepConfig.normWindow + stepConfig.momentumLookback + tail + 5;
    const periodToDayMultiplier = stepParam === 'week' ? 7 : 1;
    const minDays = minPeriods * periodToDayMultiplier;
    const rowLimit = minDays * 20; // 15 symbols + headroom

    // Fetch all symbols' recent rows in one paged query, ordered newest-
    // first so we can slice trailing windows without sorting in JS later.
    const params = new URLSearchParams({
      select: 'symbol,trading_date,close',
      order: 'trading_date.desc,symbol.asc',
      limit: String(rowLimit),
    });
    if (symbolsFilter && symbolsFilter.length > 0) {
      // PostgREST `in` filter syntax: symbol=in.(SPY,XLK,...)
      params.set('symbol', `in.(${[...symbolsFilter, benchmark].join(',')})`);
    }

    const rows = [];
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

    // Bucket rows by symbol → date-sorted ascending close array. The
    // computations downstream need ascending order so SMA / stdev /
    // diff windows reference past data correctly.
    const bySymbol = {};
    for (const r of rows) {
      (bySymbol[r.symbol] ||= []).push({ date: r.trading_date, close: Number(r.close) });
    }
    for (const sym of Object.keys(bySymbol)) {
      bySymbol[sym].sort((a, b) => a.date.localeCompare(b.date));
    }

    const rawBenchSeries = bySymbol[benchmark];
    if (!rawBenchSeries || rawBenchSeries.length === 0) {
      return jsonError(404, `Benchmark symbol ${benchmark} not in daily_eod`);
    }

    // Resample to the requested step's native period before any
    // computation. Day mode keeps the daily series unchanged; week mode
    // collapses to one close per ISO week (the last trading day's close,
    // typically Friday) so SMA / stdev / diff windows reference weekly
    // periods rather than daily ones, matching the user's chosen
    // granularity. Hour mode short-circuits earlier so it never reaches
    // here.
    const benchSeries = stepParam === 'week' ? resampleWeekly(rawBenchSeries) : rawBenchSeries;

    // Build a Map from period-end trading_date → benchmark close for fast
    // lookup. After resampling the date is the last trading day of each
    // ISO week; before resampling it's the daily trading date.
    const benchByDate = new Map(benchSeries.map((p) => [p.date, p.close]));
    const benchDates = benchSeries.map((p) => p.date);

    // Compute RS-Ratio / RS-Momentum for every component (every symbol
    // except the benchmark itself, optionally filtered by symbolsFilter).
    const componentSyms = Object.keys(bySymbol)
      .filter((s) => s !== benchmark)
      .filter((s) => !symbolsFilter || symbolsFilter.length === 0 || symbolsFilter.includes(s))
      .sort();

    const components = [];
    for (const sym of componentSyms) {
      const rawSeries = bySymbol[sym];
      if (!rawSeries || rawSeries.length === 0) continue;
      const series = stepParam === 'week' ? resampleWeekly(rawSeries) : rawSeries;
      const tailPoints = computeTail(series, benchByDate, benchDates, tail, stepConfig);
      if (tailPoints.length === 0) continue;
      components.push({ symbol: sym, points: tailPoints });
    }

    // Benchmark price strip — sized in the chosen granularity (daily for
    // day mode, weekly for week mode). We send the last (tail + 20)
    // closes so a future top-left price strip can show some context
    // before the visible-tail window.
    const benchTail = benchSeries.slice(-Math.min(tail + 20, benchSeries.length));

    const lastDate = benchSeries[benchSeries.length - 1]?.date;
    const payload = {
      benchmark: {
        symbol: benchmark,
        last_close: benchSeries[benchSeries.length - 1]?.close ?? null,
        history: benchTail.map((p) => ({ date: p.date, close: p.close })),
      },
      components,
      tail,
      asOf: lastDate,
      params: {
        step: stepParam,
        step_label: stepConfig.label,
        norm_window: stepConfig.normWindow,
        momentum_lookback: stepConfig.momentumLookback,
      },
      source: 'thetadata',
    };

    return new Response(JSON.stringify(round(payload, 4)), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        // Same cache window as /api/seasonality — the underlying table
        // only refreshes once a day after close, so a 15-minute edge
        // cache plus a day of stale-while-revalidate is the right
        // freshness profile.
        'Cache-Control': 'public, max-age=900, stale-while-revalidate=86400',
      },
    });
  } catch (err) {
    return jsonError(502, err.message);
  }
}

// Rotation ratio / momentum computation. Returns the last `tail` periods
// where both metrics are defined (warm-up periods are dropped). The
// `series` and `benchDates` arrays are already in the granularity the
// step asks for: day mode passes daily samples, week mode passes
// ISO-week-end samples produced by resampleWeekly. The standardization
// windows therefore measure the chosen period count, not always days.
function computeTail(series, benchByDate, benchDates, tail, stepConfig) {
  const { normWindow, momentumLookback } = stepConfig;

  // Build RS aligned to the benchmark's date index — only the dates
  // present in BOTH series can contribute (a missing component bar on
  // a date when the benchmark trades is left out, so the SMA/stdev
  // windows are over consecutive aligned samples not calendar periods).
  const componentByDate = new Map(series.map((p) => [p.date, p.close]));
  const aligned = [];
  for (const date of benchDates) {
    const cClose = componentByDate.get(date);
    const bClose = benchByDate.get(date);
    if (!Number.isFinite(cClose) || !Number.isFinite(bClose) || bClose <= 0) continue;
    aligned.push({ date, rs: (cClose / bClose) * 100 });
  }
  if (aligned.length < normWindow + momentumLookback) return [];

  // First standardization: RS → rotation ratio.
  const rotationRatio = standardize(aligned.map((p) => p.rs), normWindow);

  // Rate of change of rotation ratio over momentumLookback periods, then
  // standardize again to get rotation momentum. ROC values land at index
  // i ≥ momentumLookback; before that they're null.
  const roc = rotationRatio.map((v, i) => {
    if (v == null) return null;
    const prior = rotationRatio[i - momentumLookback];
    if (prior == null) return null;
    return v - prior;
  });
  const rotationMomentum = standardize(roc, normWindow);

  // Pack outputs aligned to dates.
  const points = [];
  for (let i = 0; i < aligned.length; i++) {
    if (rotationRatio[i] == null || rotationMomentum[i] == null) continue;
    points.push({
      date: aligned[i].date,
      rs_ratio: rotationRatio[i],
      rs_momentum: rotationMomentum[i],
    });
  }

  return points.slice(-tail);
}

// ISO-week resampler. Collapses an ascending [{date, close}] daily series
// to one entry per ISO 8601 week, keyed by the last trading day's close
// (typically Friday's, but the last available trading day inside that
// week if Friday is a holiday — XME on July 4 week, etc.). The ISO week
// definition is identical to the one Plotly's xaxis date math uses, so a
// future "weekly bar" view of the same data would line up without
// translation. Used by the week-step branch in the handler so the
// rotation ratio / momentum standardization sees one sample per week.
function isoWeek(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // Thursday in this ISO week
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  firstThursday.setUTCDate(4 - ((firstThursday.getUTCDay() + 6) % 7));
  const weekNum = 1 + Math.round((d - firstThursday) / 604800000);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

function resampleWeekly(series) {
  const byWeek = new Map();
  for (const p of series) {
    byWeek.set(isoWeek(p.date), p);
  }
  return [...byWeek.values()];
}

// Z-score-style standardization centered at 100. Returns null for indices
// where the rolling window doesn't have enough non-null samples.
function standardize(values, window) {
  const out = new Array(values.length).fill(null);
  for (let i = window - 1; i < values.length; i++) {
    const slice = values.slice(i - window + 1, i + 1).filter((v) => v != null && Number.isFinite(v));
    if (slice.length < Math.floor(window * 0.7)) continue; // require ≥70% of window present
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    const sqDiff = slice.reduce((a, b) => a + (b - mean) ** 2, 0);
    const sd = Math.sqrt(sqDiff / (slice.length - 1));
    if (!Number.isFinite(sd) || sd === 0) continue;
    const v = values[i];
    if (v == null || !Number.isFinite(v)) continue;
    out[i] = 100 + (v - mean) / sd;
  }
  return out;
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
