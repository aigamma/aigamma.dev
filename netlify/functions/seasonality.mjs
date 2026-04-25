// netlify/functions/seasonality.mjs
//
// Read-side endpoint for the /seasonality lab. Joins the 30-minute SPX
// bars in public.spx_intraday_bars against daily_volatility_stats.spx_close
// to compute each bar's cumulative % change since the prior session's
// close, then emits:
//
//   - The 14 30-minute column times (09:30 → 16:00) that SPX RTH covers.
//   - Individual rows for the N most recent trading days (default 8).
//   - Rolling-day averages over the last 5, 10, 20, 30, 40, 60, 120, 252
//     sessions (one week through one calendar year), computed column-wise
//     so each "252 Day Avg" cell is the average of that time-of-day's
//     cumulative change across the last 252 sessions. The 252-day window
//     is the conventional "1 year" rolling baseline in equity seasonality
//     work, exposing the long-run drift signal that shorter windows miss.
//
// Query params:
//   days         — how many individual recent-day rows to include (default 8, max 30)
//   averages     — comma-separated rolling windows (default 5,10,20,30,40)
//
// The endpoint reads through SUPABASE_KEY (anon role) via RLS, matching
// how data.mjs is wired — the spx_intraday_bars and
// daily_volatility_stats tables both expose allow_anon_read policies.
//
// Cache-Control: 15 minutes at the edge + a long stale-while-revalidate.
// The table only changes once per day after close when the backfill
// script lands fresh bars, so serving stale for most of the session is
// correct behavior.

const SUPABASE_TIMEOUT_MS = 8000;
const DEFAULT_DAYS = 8;
const MAX_DAYS = 30;
const DEFAULT_AVG_WINDOWS = [5, 10, 20, 30, 40, 60, 120, 252];
// 252 trading days ≈ one calendar year of NYSE sessions, the deepest
// rolling baseline a seasonality reader typically wants. Cap above that
// gates against accidentally-pathological queries; the function silently
// truncates to available samples when the underlying backfill is shorter.
const MAX_AVG_WINDOW = 252;
// PostgREST silently caps a single response at 1000 rows regardless of
// the ?limit= query param, so we page through with Range headers. A 252
// day window at 14 bars/day is ~3528 rows, well above the cap.
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
  const daysParam = Number(url.searchParams.get('days'));
  const days = Number.isFinite(daysParam) && daysParam > 0
    ? Math.min(Math.floor(daysParam), MAX_DAYS)
    : DEFAULT_DAYS;

  const averagesRaw = url.searchParams.get('averages');
  let averageWindows = DEFAULT_AVG_WINDOWS;
  if (averagesRaw) {
    const parsed = averagesRaw
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0 && n <= MAX_AVG_WINDOW);
    if (parsed.length > 0) averageWindows = [...new Set(parsed)].sort((a, b) => a - b);
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
    // Fetch enough trading days to cover the longest average window plus
    // the N individual-day rows. Bars are pulled as one paged query
    // descending by trading_date so we can slice either set off the
    // same result.
    const longestWindow = Math.max(...averageWindows);
    const neededDays = Math.max(days, longestWindow);
    // 14 bars per day × needed-days gives an upper bound on rows. Add a
    // small margin (+2 days) so a stray missing bar on any given session
    // doesn't truncate the last complete day out of the result set.
    const rowLimit = (neededDays + 2) * 14;

    const barsParams = new URLSearchParams({
      select: 'trading_date,bucket_time,spx_close',
      order: 'trading_date.desc,bucket_time.asc',
      limit: String(rowLimit),
    });

    // Page through the bars via Range headers — PostgREST caps a single
    // response at PAGE_SIZE rows even when ?limit= is larger, and the
    // 252-day window needs ~3528 rows. Stop when a page returns fewer
    // than PAGE_SIZE (last page) or when we hit the requested rowLimit.
    const barRows = [];
    for (let offset = 0; offset < rowLimit; offset += PAGE_SIZE) {
      const end = Math.min(offset + PAGE_SIZE, rowLimit) - 1;
      const pageRes = await fetchWithTimeout(
        `${supabaseUrl}/rest/v1/spx_intraday_bars?${barsParams}`,
        { headers: { ...headers, Range: `${offset}-${end}`, 'Range-Unit': 'items' } },
        'spx_intraday_bars',
      );
      if (!pageRes.ok && pageRes.status !== 206) {
        throw new Error(`spx_intraday_bars query failed: ${pageRes.status}`);
      }
      const page = await pageRes.json();
      if (!Array.isArray(page) || page.length === 0) break;
      barRows.push(...page);
      if (page.length < end - offset + 1) break;
    }
    if (barRows.length === 0) {
      return jsonError(404, 'No spx_intraday_bars rows available');
    }

    // Resolve distinct trading dates in descending order so we can pull
    // the corresponding prior closes in one query keyed by a union of
    // dates-and-prior-dates. Anything outside the window of relevant
    // dates is filtered in JS.
    const datesDesc = [...new Set(barRows.map((r) => r.trading_date))].sort().reverse();
    // Trim to the set we actually need (longest window + days) — the
    // over-fetch margin above means datesDesc may be longer than
    // neededDays by one or two.
    const relevantDates = datesDesc.slice(0, neededDays);
    if (relevantDates.length === 0) return jsonError(404, 'No trading dates resolved');

    // Prior-close lookup. For each relevant trading_date we need the
    // close from the prior session — which is the next-earlier
    // trading_date in daily_volatility_stats. Pull a window that
    // definitely covers everything: from just-before the oldest
    // relevant date, through the newest relevant date. One query.
    const oldestRelevant = relevantDates[relevantDates.length - 1];
    const newestRelevant = relevantDates[0];
    // Reach back ~10 calendar days past the oldest relevant date so a
    // long weekend / holiday doesn't orphan the first day in the
    // window. EOD is weekdays-only so 10 calendar days is safely >= 1
    // prior trading session.
    const priorWindowStart = shiftIsoDate(oldestRelevant, -10);

    const dvsParams = new URLSearchParams({
      select: 'trading_date,spx_close',
      order: 'trading_date.asc',
      trading_date: `gte.${priorWindowStart}`,
    });
    // Stack an upper bound; PostgREST wants every filter as its own
    // URLSearchParams key, not a comma.
    dvsParams.append('trading_date', `lte.${newestRelevant}`);

    const dvsRes = await fetchWithTimeout(
      `${supabaseUrl}/rest/v1/daily_volatility_stats?${dvsParams}`,
      { headers },
      'daily_volatility_stats',
    );
    if (!dvsRes.ok) throw new Error(`daily_volatility_stats query failed: ${dvsRes.status}`);
    const dvsRows = await dvsRes.json();
    if (!Array.isArray(dvsRows) || dvsRows.length === 0) {
      return jsonError(502, 'No daily_volatility_stats rows for prior-close lookup');
    }

    // Map each relevant trading_date → its prior session's close.
    const dvsSorted = dvsRows
      .filter((r) => r.spx_close != null)
      .sort((a, b) => a.trading_date.localeCompare(b.trading_date));
    const priorCloseByDate = {};
    for (const d of relevantDates) {
      // Find the latest dvs row whose trading_date < d.
      let prior = null;
      for (let i = dvsSorted.length - 1; i >= 0; i--) {
        if (dvsSorted[i].trading_date < d) { prior = dvsSorted[i]; break; }
      }
      if (prior) priorCloseByDate[d] = Number(prior.spx_close);
    }

    // Bucket the bar rows by trading_date → { bucket_time: spx_close }.
    const barsByDate = {};
    for (const r of barRows) {
      if (!relevantDates.includes(r.trading_date)) continue;
      (barsByDate[r.trading_date] ||= {})[r.bucket_time] = Number(r.spx_close);
    }

    // Canonical column order. The 14 RTH bucket timestamps ThetaData
    // emits per session. Column labels are the END of each 30-min bin
    // (the readable wall-clock time when that cell's value is finalized),
    // which matches the SPY reference image's header. 09:30 bar ends at
    // 10:00, 10:00 bar ends at 10:30, ..., 16:00 bar is the closing
    // marker whose finalization time is 16:00 itself (degenerate last
    // row).
    const BUCKETS = [
      { bucket_time: '09:30:00', label: '10:00' },
      { bucket_time: '10:00:00', label: '10:30' },
      { bucket_time: '10:30:00', label: '11:00' },
      { bucket_time: '11:00:00', label: '11:30' },
      { bucket_time: '11:30:00', label: '12:00' },
      { bucket_time: '12:00:00', label: '12:30' },
      { bucket_time: '12:30:00', label: '1:00' },
      { bucket_time: '13:00:00', label: '1:30' },
      { bucket_time: '13:30:00', label: '2:00' },
      { bucket_time: '14:00:00', label: '2:30' },
      { bucket_time: '14:30:00', label: '3:00' },
      { bucket_time: '15:00:00', label: '3:30' },
      { bucket_time: '15:30:00', label: '4:00' },
    ];

    // Per-day row: array of pct_change values aligned with BUCKETS.
    // A missing bar or missing prior close yields a null in that slot —
    // the grid renders nulls as the "no data" placeholder rather than
    // as 0.00.
    const perDay = relevantDates.map((date) => {
      const priorClose = priorCloseByDate[date];
      const bars = barsByDate[date] || {};
      const values = BUCKETS.map(({ bucket_time }) => {
        const px = bars[bucket_time];
        if (!Number.isFinite(priorClose) || priorClose <= 0 || !Number.isFinite(px)) return null;
        return ((px - priorClose) / priorClose) * 100;
      });
      return { trading_date: date, values };
    });

    // Column-wise rolling averages. For each window N, each column's
    // average is the arithmetic mean of the N most-recent non-null
    // pct_change values in that column. N excludes null samples so a
    // missing bar on one day doesn't drag the average down — it just
    // shrinks the effective sample to N-1 for that column. This
    // matches how /c/i/'s reference grid treats short history days.
    const averages = averageWindows.map((window) => {
      const values = BUCKETS.map((_, colIdx) => {
        const samples = [];
        for (let i = 0; i < perDay.length && samples.length < window; i++) {
          const v = perDay[i].values[colIdx];
          if (v !== null) samples.push(v);
        }
        if (samples.length === 0) return null;
        const sum = samples.reduce((a, b) => a + b, 0);
        return sum / samples.length;
      });
      return { window, values };
    });

    // Individual days: only the most recent `days` of them. perDay is
    // already sorted newest-first, so slice off the front.
    const days_rows = perDay.slice(0, days);

    const payload = {
      symbol: 'SPX',
      columns: BUCKETS.map((b) => b.label),
      averages,
      days: days_rows,
      asOf: relevantDates[0],
      source: 'thetadata',
    };

    // Response rounded to 4 decimal places on the wire. Enough
    // precision for the grid to print "0.04%" without floating-point
    // trailing noise, and keeps the JSON compact.
    return new Response(JSON.stringify(round(payload, 4)), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        // Bars only change post-close, so hold for 15 minutes at the
        // edge and let the SWR window absorb the occasional refresh.
        // The backfill lands fresh rows once per day and the grid
        // doesn't need sub-minute freshness.
        'Cache-Control': 'public, max-age=900, stale-while-revalidate=86400',
      },
    });
  } catch (err) {
    return jsonError(502, err.message);
  }
}

function shiftIsoDate(iso, deltaDays) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
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
