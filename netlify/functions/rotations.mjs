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
// The math is a three-stage EMA-percentage construction with Roy
// Mansfield's 1979 "Mansfield Relative Performance" indicator as the
// foundational prior art on the ratio arm: relative strength expressed
// as a percentage of its own long-period moving average, centered at
// 100. A short input smoother dampens period-to-period noise in the
// raw RS series before the percentage-of-moving-average operation
// runs; without it, the ratio output inherits high-frequency noise
// from RS in the numerator (the slow EMA only smooths the divisor),
// and the resulting trails zigzag on sideways-moving components
// instead of tracing clean spirals. The momentum arm applies the
// same percentage-of-moving-average operation to the ratio with a
// faster smoother, producing a velocity-like measure that leads
// ratio in time and gives the trail its spiral structure as
// components rotate through the four quadrants.
//
//   1. Relative strength:
//        RS_t = (close_component_t / close_benchmark_t) * 100
//
//   2. Pre-smoothed RS (input filter):
//        smoothed_RS_t = EMA(RS, smoothWindow)_t
//
//   3. Rotation ratio: smoothed RS as a percentage of its own slow EMA
//      (Mansfield 1979 normalization, with EMA in place of his
//      original 52-week SMA so old samples decay smoothly rather
//      than dropping off a fixed-window edge):
//        rotation_ratio_t = (smoothed_RS_t / EMA(smoothed_RS, slowWindow)_t) * 100
//      Above 100 means the component is above its long-term smooth
//      average (leading); below 100 means lagging.
//
//   4. Rotation momentum: rotation ratio as a percentage of its own
//      fast EMA:
//        rotation_momentum_t = (rotation_ratio_t /
//                               EMA(rotation_ratio, fastWindow)_t) * 100
//      Above 100 means ratio is rising vs its recent average
//      (gaining); below 100 means falling. The fast smoother is the
//      source of the phase lead between momentum and ratio that
//      produces clockwise spiral motion in the (ratio, momentum)
//      plane.
//
// Earlier iterations explored a Mansfield-style rate-of-change form
// (ratio_t = RS_t / RS_{t-N}, momentum_t = ratio_t / ratio_{t-N})
// which got quadrant assignments roughly right but produced
// straight-line trails because both arms shared the same N-period
// horizon and had no phase difference. The two-EMA form gives
// smooth flowing trails because EMA is a stable per-step denominator
// (it changes only by k×Δ each step, k ≈ 0.077 for window=26), and
// the asymmetric slow/fast pair produces the velocity-vs-position
// phase relationship that traces spirals.
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
// step=day uses one daily close per tail point with a 63-day slow
// EMA and a 13-day fast EMA — the conventional ~3-month/~3-week
// daily-rotation pair. step=week resamples daily_eod to one close
// per ISO week (the last trading day's close, typically Friday) and
// uses a 26-week slow EMA and a 5-week fast EMA — 26 weeks is the
// middle ground that puts high-yield defensives in the right half
// of the plane (13 was too short, 52 too long against our 2-year
// backfill's ~104 weekly samples). step=hour requires intraday ETF
// bars that aren't yet ingested into Supabase — daily_eod is
// end-of-day only and the existing intraday ingest path (Massive API
// → snapshots) covers SPX option chains, not sector ETF prices — so
// hour mode returns a 503 with a clear explanation. Adding hourly
// support is a follow-up that needs a new etf_intraday_bars table
// fed by ThetaData stock OHLC at the Stock Value tier (which the
// account has as of 2026-04-25) plus a backfill script analogous to
// scripts/backfill/spx-intraday-bars.mjs.
//
// Reads through the anon SUPABASE_KEY against the allow_anon_read RLS
// policy on daily_eod. Cache-Control: 15 minutes at the edge with
// a long stale-while-revalidate, matching the seasonality endpoint —
// the table only changes once per day after close when the backfill runs.

const SUPABASE_TIMEOUT_MS = 8000;

const DEFAULT_TAIL = 10;
const MAX_TAIL = 60;

// Per-step EMA windows for the three-stage rotation formula.
// smoothWindow is a short input filter that dampens period-to-period
// noise in the relative-strength series before the rotation math
// runs; without it the ratio output inherits high-frequency noise
// from RS in the numerator, even though the slow EMA smooths the
// divisor, and the resulting trails zigzag on sideways-moving
// components instead of tracing clean spirals. slowWindow drives
// the ratio (smoothed RS as a percentage of its own slow EMA);
// fastWindow drives the momentum (ratio as a percentage of its own
// fast EMA). The asymmetry between slow and fast is what produces
// the phase lead that traces spirals in the (ratio, momentum)
// plane: momentum responds to recent changes in ratio while ratio
// itself moves on the slower horizon.
//
// Day mode 5/63/13 pre-smooths RS over a trading week and pairs a
// ~3-month slow EMA with a ~3-week fast EMA, the conventional
// daily-rotation defaults. Week mode 3/26/5 pre-smooths RS over
// three weeks and pairs a 26-week slow EMA with a 5-week fast EMA;
// 26 weeks (~6 months) sits between the failed prior calibrations
// (13 was too short and pushed defensives into Lagging, 52 burned
// ~65 weeks of warm-up out of our 2-year backfill's 104 weekly
// samples), leaving ~70 valid weeks for the visible tail.
//
// Hour values are placeholders; the step=hour branch returns 503
// before they're consulted because no intraday ETF table exists yet.
const STEP_CONFIG = {
  day:  { smoothWindow: 5, slowWindow: 63, fastWindow: 13, label: 'days' },
  week: { smoothWindow: 3, slowWindow: 26, fastWindow: 5,  label: 'weeks' },
  hour: { smoothWindow: 5, slowWindow: 63, fastWindow: 13, label: 'hours' },
};
const DEFAULT_STEP = 'day';

// PostgREST caps at 1000 rows per response. We need (tail + smoothWindow
// + slowWindow + fastWindow + buffer) periods * ~15 symbols of rows so
// each EMA has at least one full window of valid samples to seed
// against. Day mode peaks around (10 + 5 + 63 + 13 + 10) ~= 101 days *
// 15 = 1515 rows; week mode needs (10 + 3 + 26 + 5 + 10) ~= 54 weeks *
// 5 trading days = 270 days * 15 = 4050 rows. Both above the cap, so
// paginate.
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
    // Pull enough trailing rows that each EMA has at least one full
    // window of valid samples to seed against. The SMA-seeded EMA in
    // ema() is unbiased from its very first emitted value (the seed IS
    // an unbiased mean estimator over `window` samples), so 1× window
    // is the actual minimum for valid output rather than the more
    // conservative 2× that "fully forgets the seed". The fast momentum
    // EMA chains on top of the slow ratio EMA, so the warm-up is
    // slowWindow + fastWindow periods, plus tail for the visible trail
    // and a small buffer. Week mode multiplies that by ~7 to convert
    // weekly periods into calendar days that need to be present in
    // daily_eod before resampling — five trading days per week plus
    // weekend slack — and the rowLimit caps at the size of our 2-year
    // backfill (15 symbols × 501 days ≈ 7515 rows) so a request can't
    // ask for more rows than the table holds.
    const minPeriods = stepConfig.smoothWindow + stepConfig.slowWindow + stepConfig.fastWindow + tail + 10;
    const periodToDayMultiplier = stepParam === 'week' ? 7 : 1;
    const minDays = minPeriods * periodToDayMultiplier;
    const rowLimit = Math.min(minDays * 20, 16000); // 15 symbols + headroom, capped

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
    // diff windows reference past data correctly. Each symbol's series
    // is then run through adjustForSplits to repair the 2:1 splits the
    // SPDR sector family did on 2025-12-05 (XLB, XLE, XLK, XLU, XLY all
    // halved on the same day; the pre-split closes in daily_eod are
    // raw / unadjusted, so without this pass the 63-day EMA mixes
    // pre-split values around 38 with post-split values around 16 and
    // every split-affected component lands far off where StockCharts'
    // adjusted-close baseline at C:\i\ shows it).
    const bySymbol = {};
    for (const r of rows) {
      (bySymbol[r.symbol] ||= []).push({ date: r.trading_date, close: Number(r.close) });
    }
    for (const sym of Object.keys(bySymbol)) {
      bySymbol[sym].sort((a, b) => a.date.localeCompare(b.date));
      bySymbol[sym] = adjustForSplits(bySymbol[sym]);
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
        smooth_window: stepConfig.smoothWindow,
        slow_window: stepConfig.slowWindow,
        fast_window: stepConfig.fastWindow,
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
// ISO-week-end samples produced by resampleWeekly. The EMA windows
// therefore count the chosen period, not always days.
//
// Three-stage EMA-percentage construction. Stage 0 pre-smooths RS with
// a short EMA so period-to-period noise in the relative-strength
// numerator does not zigzag the ratio output. Stage 1 expresses
// smoothed RS as a percentage of its own slow EMA, the Roy Mansfield
// 1979 "Mansfield Relative Performance" normalization with EMA in
// place of his original 52-week SMA so old samples decay smoothly
// rather than dropping off a hard window edge. Stage 2 applies the
// same percentage-of-moving-average operation to the ratio with a
// faster smoother, producing the momentum arm whose phase lead over
// ratio traces the clockwise spiral motion as components rotate
// through the four quadrants.
function computeTail(series, benchByDate, benchDates, tail, stepConfig) {
  const { smoothWindow, slowWindow, fastWindow } = stepConfig;

  // Build RS aligned to the benchmark's date index. Only the dates
  // present in BOTH series can contribute (a missing component bar on
  // a date when the benchmark trades is left out, so the EMAs operate
  // on consecutive aligned samples not calendar periods).
  const componentByDate = new Map(series.map((p) => [p.date, p.close]));
  const aligned = [];
  for (const date of benchDates) {
    const cClose = componentByDate.get(date);
    const bClose = benchByDate.get(date);
    if (!Number.isFinite(cClose) || !Number.isFinite(bClose) || bClose <= 0) continue;
    aligned.push({ date, rs: (cClose / bClose) * 100 });
  }
  if (aligned.length < smoothWindow + slowWindow + fastWindow) return [];

  const rs = aligned.map((p) => p.rs);

  // Stage 0: pre-smooth the RS series with a short EMA so the ratio
  // arm's numerator carries less period-to-period noise. The slow
  // EMA in stage 1 already smooths the divisor; pre-smoothing the
  // numerator on a comparable horizon keeps both arms at a
  // consistent noise floor and prevents the ratio output from
  // zigzagging on sideways-moving components.
  const rsSmooth = ema(rs, smoothWindow);

  // Stage 1: rotation ratio = (smoothed RS / EMA(smoothed RS, slow)) * 100.
  // First valid value lands at index smoothWindow + slowWindow - 2 (when
  // both ema()'s SMA seeds are full). Above 100 means the component's
  // smoothed relative strength is above its long-term smooth average
  // (leading); below 100 means below it.
  const rsSlowEma = ema(rsSmooth, slowWindow);
  const rotationRatio = rsSmooth.map((v, i) => {
    const e = rsSlowEma[i];
    if (e == null || e <= 0 || v == null) return null;
    return (v / e) * 100;
  });

  // Stage 2: rotation momentum = (ratio / EMA(ratio, fast)) * 100.
  // Same percentage-of-moving-average operation applied to the ratio
  // with a faster smoother. Above 100 means ratio is rising vs its
  // short-term average (gaining); below 100 means falling.
  const ratioFastEma = ema(rotationRatio, fastWindow);
  const rotationMomentum = rotationRatio.map((v, i) => {
    const e = ratioFastEma[i];
    if (e == null || e <= 0 || v == null) return null;
    return (v / e) * 100;
  });

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

// Walks an ascending [{date, close}] series chronologically; whenever a
// day-over-day jump bigger than ±35% appears (2:1 splits round-trip at
// ~0.50, reverse 1:2 splits at ~2.00, common 3:1 splits at ~0.33), it
// treats the jump as a stock split and multiplies every prior close by
// the observed jump ratio so the pre-split portion of the series lands
// on the post-split price scale. The threshold is wide enough that no
// single-day move on a sector ETF in modern history would trigger it
// (the largest 1-day moves on SPDR sector funds during the 2020 COVID
// crash were ~−12%) and tight enough to catch all common split sizes.
// Idempotent: running it on an already-adjusted series does nothing
// because no split-sized jumps remain. Compounds correctly across
// multiple historical splits — each split-day adjusts everything before
// it, so a later split adjusts the earlier-adjusted values once more,
// stacking the factors. The fix lives at the API layer rather than as
// a one-time SQL UPDATE on daily_eod so the raw ThetaData EOD remains
// the authoritative table on disk; if a future ETF split is detected
// at fetch time, the rotation chart picks it up automatically without
// a backfill rerun.
function adjustForSplits(series) {
  if (!series || series.length < 2) return series;
  const adjusted = series.map((p) => ({ date: p.date, close: p.close }));
  for (let i = 1; i < adjusted.length; i++) {
    const prev = adjusted[i - 1].close;
    const curr = adjusted[i].close;
    if (!Number.isFinite(prev) || prev <= 0 || !Number.isFinite(curr) || curr <= 0) continue;
    const r = curr / prev;
    if (r < 0.65 || r > 1.55) {
      for (let j = 0; j < i; j++) {
        adjusted[j].close *= r;
      }
    }
  }
  return adjusted;
}

// Exponential moving average. Seeded with the SMA of the first `window`
// valid samples (standard TA-Lib seeding) so the very first emitted EMA
// value is unbiased rather than dominated by an arbitrary first observation.
// Subsequent values use the canonical recurrence ema_t = α·v_t + (1−α)·ema_{t−1}
// with α = 2/(window+1). Returns one entry per input position; positions
// before the SMA seed completes hold null. Treats nulls as gaps — a missing
// input at position i carries the previous EMA forward without updating it,
// which preserves the time alignment with the input array even when a few
// component bars are missing relative to the benchmark.
function ema(values, window) {
  if (window <= 1) return values.slice();
  const alpha = 2 / (window + 1);
  const out = new Array(values.length).fill(null);
  let acc = null;
  let seedCount = 0;
  let seedSum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const valid = v != null && Number.isFinite(v);
    if (acc == null) {
      if (!valid) continue;
      seedCount += 1;
      seedSum += v;
      if (seedCount === window) {
        acc = seedSum / window;
        out[i] = acc;
      }
    } else {
      if (valid) {
        acc = v * alpha + acc * (1 - alpha);
      }
      out[i] = acc;
    }
  }
  return out;
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
