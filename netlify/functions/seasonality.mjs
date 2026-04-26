// netlify/functions/seasonality.mjs
//
// Read-side endpoint for the /seasonality lab. Fans out to three views
// keyed by ?view= (intraday, daily, weekly):
//
//   intraday (default) — Joins the 30-minute SPX bars in
//     public.spx_intraday_bars against daily_volatility_stats.spx_close
//     to compute each bar's cumulative % change since the prior session's
//     close. Emits 13 column times (10:00 → 4:00) plus rolling N-day
//     averages and the N most recent individual sessions.
//
//   daily — Reads daily_volatility_stats.spx_close, computes each day's
//     close-to-close return, and reshapes into a (week × day-of-week)
//     grid: rows are ISO weeks (newest first), columns are Mon-Fri.
//     Holidays (NYSE-closed weekdays absent from the table) render as
//     'holiday' cells; weekdays beyond today render as 'future'. Adds
//     rolling N-week averages of each weekday's mean return.
//
//   weekly — Reshapes the same daily close series into ISO-year × ISO-week
//     weekly returns: rows are calendar years (newest first), columns are
//     ISO weeks 1..max. Each cell is (last close in week / last close in
//     prior week - 1) * 100. Adds an "All Years" average row across years
//     for each week-of-year — the headline seasonality signal.
//
// All three views read through SUPABASE_KEY (anon role) via RLS, matching
// how data.mjs is wired — spx_intraday_bars and daily_volatility_stats
// both expose allow_anon_read policies.
//
// Cache-Control: 15 minutes for intraday (matches the historical default;
// bars only land post-close), 1 hour for daily/weekly with a long SWR
// (those collapse one row per session and one row per week respectively,
// so rolling them every minute is wasteful).

const SUPABASE_TIMEOUT_MS = 8000;
const PAGE_SIZE = 1000;

// ── intraday view defaults ──────────────────────────────────────────────
const DEFAULT_DAYS = 8;
const MAX_DAYS = 30;
const DEFAULT_AVG_WINDOWS = [5, 10, 20, 30, 40, 60, 120, 252];
// 252 trading days ≈ one calendar year of NYSE sessions, the deepest
// rolling baseline a seasonality reader typically wants. Cap above that
// gates against accidentally-pathological queries; the function silently
// truncates to available samples when the underlying backfill is shorter.
const MAX_AVG_WINDOW = 252;

// ── daily view defaults ─────────────────────────────────────────────────
const DEFAULT_WEEKS = 16;
const MAX_WEEKS = 104;
const DEFAULT_DAILY_AVG_WINDOWS = [4, 8, 13, 26, 52];
// 52 weeks = one trading year; deeper than that and you're aggregating
// across multiple regimes that the average flattens.
const MAX_DAILY_AVG_WINDOW = 156;

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
  const view = (url.searchParams.get('view') || 'intraday').toLowerCase();

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  if (!supabaseUrl || !supabaseKey) return jsonError(500, 'Supabase not configured');

  const headers = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json',
  };

  try {
    if (view === 'daily') return await handleDaily(url, supabaseUrl, headers);
    if (view === 'weekly') return await handleWeekly(url, supabaseUrl, headers);
    return await handleIntraday(url, supabaseUrl, headers);
  } catch (err) {
    return jsonError(502, err.message);
  }
}

// ── intraday view ───────────────────────────────────────────────────────
async function handleIntraday(url, supabaseUrl, headers) {
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
    view: 'intraday',
    columns: BUCKETS.map((b) => b.label),
    averages,
    days: days_rows,
    asOf: relevantDates[0],
    source: 'thetadata',
  };

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
}

// ── daily view ──────────────────────────────────────────────────────────
async function handleDaily(url, supabaseUrl, headers) {
  const weeksParam = Number(url.searchParams.get('weeks'));
  const weeks = Number.isFinite(weeksParam) && weeksParam > 0
    ? Math.min(Math.floor(weeksParam), MAX_WEEKS)
    : DEFAULT_WEEKS;

  const averagesRaw = url.searchParams.get('averages');
  let averageWindows = DEFAULT_DAILY_AVG_WINDOWS;
  if (averagesRaw) {
    const parsed = averagesRaw
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0 && n <= MAX_DAILY_AVG_WINDOW);
    if (parsed.length > 0) averageWindows = [...new Set(parsed)].sort((a, b) => a - b);
  }

  // Pull enough daily closes to cover the deepest rolling-week window
  // plus a few extra days so the leading "prior close" for the oldest
  // week we render is always present. Convert weeks → calendar days
  // generously (× 7 + 14 day cushion for holidays + leading prior close).
  const longestWeekWindow = Math.max(weeks, ...averageWindows);
  const lookbackDays = longestWeekWindow * 7 + 14;
  const today = etTodayIso();
  const startIso = shiftIsoDate(today, -lookbackDays);

  const dailyRows = await fetchDailyClose(supabaseUrl, headers, startIso, today);
  if (dailyRows.length === 0) {
    return jsonError(404, 'No daily_volatility_stats rows in the requested window');
  }

  // Compute close-to-close % change for each trading row. The first
  // row's return is null (no prior in the window) and stays null —
  // that's why we over-fetch by 14 days.
  const dailyReturns = new Map(); // 'YYYY-MM-DD' → return %
  for (let i = 1; i < dailyRows.length; i++) {
    const prev = Number(dailyRows[i - 1].spx_close);
    const cur = Number(dailyRows[i].spx_close);
    if (Number.isFinite(prev) && prev > 0 && Number.isFinite(cur)) {
      dailyReturns.set(dailyRows[i].trading_date, ((cur - prev) / prev) * 100);
    }
  }

  // Index trading dates as a Set for O(1) "is this a trading day" checks
  // (used to distinguish holidays from missing-future-data weekdays).
  const tradingDateSet = new Set(dailyRows.map((r) => r.trading_date));

  // Build the most recent N weeks. Walk backward from today, snapping
  // to the Monday of the current ISO week, then stepping back 7 days
  // per iteration. The result is newest-first.
  const todayMonday = mondayOfWeek(today);
  const weekRows = [];
  let cursor = todayMonday;
  for (let i = 0; i < weeks; i++) {
    const monday = cursor;
    const cells = [];
    for (let dow = 0; dow < 5; dow++) {  // Mon=0..Fri=4
      const dayIso = shiftIsoDate(monday, dow);
      if (dayIso > today) {
        cells.push({ kind: 'future' });
      } else if (tradingDateSet.has(dayIso)) {
        const ret = dailyReturns.get(dayIso);
        if (ret == null) {
          // Edge case: the very first day in our fetched window has no
          // prior close to compute against. Treat as 'future' (data not
          // yet renderable) rather than 'holiday' (markets closed).
          cells.push({ kind: 'no_data' });
        } else {
          cells.push({ kind: 'data', value: ret });
        }
      } else {
        // Weekday with no row in daily_volatility_stats → NYSE was closed.
        cells.push({ kind: 'holiday' });
      }
    }
    weekRows.push({
      week_label: weekLabel(monday),
      week_start: monday,
      cells,
    });
    cursor = shiftIsoDate(cursor, -7);
  }

  // Rolling N-week averages. For each window N, each column's average
  // is the arithmetic mean of the N most-recent NUMERIC cells in that
  // column. Holiday and future cells are excluded from the sample, so
  // a holiday Monday doesn't drag the Monday average down — it just
  // shrinks the effective sample to N-1 for that column.
  const averages = averageWindows.map((window) => {
    const values = [];
    for (let dow = 0; dow < 5; dow++) {
      const samples = [];
      for (let i = 0; i < weekRows.length && samples.length < window; i++) {
        const c = weekRows[i].cells[dow];
        if (c.kind === 'data') samples.push(c.value);
      }
      if (samples.length === 0) values.push(null);
      else values.push(samples.reduce((a, b) => a + b, 0) / samples.length);
    }
    return { window, values };
  });

  const payload = {
    symbol: 'SPX',
    view: 'daily',
    columns: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
    averages,
    weeks: weekRows,
    asOf: dailyRows[dailyRows.length - 1].trading_date,
    source: 'thetadata',
  };

  return new Response(JSON.stringify(round(payload, 4)), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
    },
  });
}

// ── weekly view ─────────────────────────────────────────────────────────
async function handleWeekly(url, supabaseUrl, headers) {
  // Pull every available daily close. The table is ~1100 rows, so
  // fetching the whole range is cheap and lets us render every year
  // we have without juggling per-year requests.
  const dailyRows = await fetchDailyClose(supabaseUrl, headers, '2000-01-01', etTodayIso());
  if (dailyRows.length === 0) {
    return jsonError(404, 'No daily_volatility_stats rows available');
  }

  // Group every trading day into ISO (year, week). Within each week,
  // the "close" we use is the LAST trading day's close in that week.
  // The week's return is (this week's last close / prior week's last
  // close - 1) * 100, where "prior week" is the immediately preceding
  // ISO week that has at least one trading day. This handles years
  // where week 1 starts mid-week (e.g., 2022 begins on 2022-01-03 =
  // ISO week 1 of 2022) by leaving week 1's return null when no prior
  // week exists in the data.
  const weeks = new Map(); // 'YYYY-WNN' → { iso_year, iso_week, last_close, last_date }
  for (const row of dailyRows) {
    if (row.spx_close == null) continue;
    const close = Number(row.spx_close);
    if (!Number.isFinite(close) || close <= 0) continue;
    const { year, week } = isoYearWeek(row.trading_date);
    const key = `${year}-${String(week).padStart(2, '0')}`;
    const cur = weeks.get(key);
    if (!cur || row.trading_date > cur.last_date) {
      weeks.set(key, {
        iso_year: year,
        iso_week: week,
        last_close: close,
        last_date: row.trading_date,
      });
    }
  }

  const sortedKeys = [...weeks.keys()].sort();
  // Compute weekly returns by walking sortedKeys in chronological
  // order. Two weeks are "adjacent" for the return calculation if
  // they're consecutive in sortedKeys (the prior position in the
  // chronologically sorted list). This naturally skips any week that
  // had no trading at all (which would just be absent from the map).
  const weeklyReturn = new Map(); // 'YYYY-WNN' → return %
  for (let i = 1; i < sortedKeys.length; i++) {
    const prior = weeks.get(sortedKeys[i - 1]);
    const cur = weeks.get(sortedKeys[i]);
    if (prior && cur) {
      weeklyReturn.set(sortedKeys[i], ((cur.last_close - prior.last_close) / prior.last_close) * 100);
    }
  }

  // Resolve the year set and the maximum week number across all years
  // — most years end at week 52, but ISO week 53 happens (2026 has
  // week 53). We render columns 1..maxWeek; years that don't reach
  // a given week leave that cell as 'no_data'.
  const yearSet = new Set();
  let maxWeek = 0;
  for (const w of weeks.values()) {
    yearSet.add(w.iso_year);
    if (w.iso_week > maxWeek) maxWeek = w.iso_week;
  }
  const sortedYears = [...yearSet].sort((a, b) => b - a); // newest first

  // Year × week matrix. Cell kinds:
  //   'data'     — numeric weekly return
  //   'no_data'  — week not yet reached (current year past today, or
  //                the very first week in the dataset which has no
  //                prior week to compute against)
  const yearRows = sortedYears.map((year) => {
    const cells = [];
    for (let week = 1; week <= maxWeek; week++) {
      const key = `${year}-${String(week).padStart(2, '0')}`;
      const ret = weeklyReturn.get(key);
      if (ret == null) cells.push({ kind: 'no_data' });
      else cells.push({ kind: 'data', value: ret });
    }
    return { year, cells };
  });

  // "All Years" average row: for each week-of-year, mean of all
  // numeric returns for that week across every year in the data.
  // A week present in only 2 years still gets a mean of those 2.
  const averageValues = [];
  for (let week = 1; week <= maxWeek; week++) {
    const samples = [];
    for (const year of sortedYears) {
      const key = `${year}-${String(week).padStart(2, '0')}`;
      const ret = weeklyReturn.get(key);
      if (ret != null) samples.push(ret);
    }
    if (samples.length === 0) averageValues.push(null);
    else averageValues.push(samples.reduce((a, b) => a + b, 0) / samples.length);
  }

  // Each week column carries both the ISO week label (W01, W02, ...)
  // and the Mon-Fri date range that week occupies in the CURRENT
  // calendar year. Sourcing the range from the current year is a
  // reader-affordance choice — the actual ISO calendar dates for the
  // same week number drift by ±2 days year-to-year, so showing one
  // canonical "this is roughly when in the year week 17 falls" range
  // is more useful than picking an arbitrary historical year.
  const currentIsoYear = Number(etTodayIso().slice(0, 4));
  const weekColumns = Array.from({ length: maxWeek }, (_, i) => {
    const weekNum = i + 1;
    const monday = isoWeekToMonday(currentIsoYear, weekNum);
    return {
      week: `W${String(weekNum).padStart(2, '0')}`,
      range: weekLabel(monday),
    };
  });

  const payload = {
    symbol: 'SPX',
    view: 'weekly',
    columns: weekColumns,
    averages: [{ label: 'All Years', values: averageValues }],
    years: yearRows,
    asOf: dailyRows[dailyRows.length - 1].trading_date,
    source: 'thetadata',
  };

  return new Response(JSON.stringify(round(payload, 4)), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
    },
  });
}

// ── helpers ─────────────────────────────────────────────────────────────

// Pages through daily_volatility_stats AND spx_intraday_bars (15:30 bar)
// via Range headers, then unions the two close series so the most-recent
// trading days are present even when the EOD backfill lags the intraday
// backfill. Both tables are paged because PostgREST caps a single
// response at 1000 rows — daily_volatility_stats is ~1100 rows today and
// the intraday 15:30 slice is the same row count, so anything covering
// "all available history" needs at least two pages.
//
// Source priority: daily_volatility_stats.spx_close is ThetaData's
// canonical CBOE EOD close and the preferred source. spx_intraday_bars
// at bucket_time = '15:30:00' is the 16:00:00 index tick (the close OF
// the 15:30-16:00 bar). The two diverge by ~$5 / 0.1% on average
// because the official close incorporates the closing-auction print
// while the tick is the spot value at the bell — close enough for a
// seasonality grid where the question is "did the day go up or down,
// and how much", and worth the trade-off because the EOD backfill can
// lag the intraday backfill by 1-3 sessions, which would otherwise
// paint freshly-traded weekdays as 'holiday' in the DAILY view.
async function fetchDailyClose(supabaseUrl, headers, fromIso, toIso) {
  const dvsRows = await pageRange(
    supabaseUrl, headers,
    `daily_volatility_stats?select=trading_date,spx_close&order=trading_date.asc&trading_date=gte.${fromIso}&trading_date=lte.${toIso}`,
    'daily_volatility_stats',
  );
  const sibRows = await pageRange(
    supabaseUrl, headers,
    `spx_intraday_bars?select=trading_date,spx_close&bucket_time=eq.15:30:00&order=trading_date.asc&trading_date=gte.${fromIso}&trading_date=lte.${toIso}`,
    'spx_intraday_bars',
  );

  // Combine: intraday tick fills first, dvs canonical close overwrites
  // where present. The order of the two writes matters — dvs must come
  // second so a date present in both ends up with the official close.
  const closeByDate = new Map();
  for (const r of sibRows) {
    if (r.spx_close == null) continue;
    const v = Number(r.spx_close);
    if (Number.isFinite(v) && v > 0) closeByDate.set(r.trading_date, v);
  }
  for (const r of dvsRows) {
    if (r.spx_close == null) continue;
    const v = Number(r.spx_close);
    if (Number.isFinite(v) && v > 0) closeByDate.set(r.trading_date, v);
  }
  return [...closeByDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([trading_date, spx_close]) => ({ trading_date, spx_close }));
}

async function pageRange(supabaseUrl, headers, queryPath, label) {
  const out = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const end = offset + PAGE_SIZE - 1;
    const res = await fetchWithTimeout(
      `${supabaseUrl}/rest/v1/${queryPath}`,
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

function shiftIsoDate(iso, deltaDays) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

// ISO 8601 year/week. ISO weeks start Monday; week 1 contains the
// first Thursday of the calendar year (equivalently, contains Jan 4).
// Late-Dec / early-Jan dates may belong to a different ISO year than
// their calendar year — 2023-01-01 (Sun) is ISO 2022-W52, and 2024-12-30
// (Mon) is ISO 2025-W01. The Thursday-shift trick used here is the
// standard reference algorithm for the ISO calendar.
function isoYearWeek(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const isoDay = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
  date.setUTCDate(date.getUTCDate() + (4 - isoDay));
  // Now date = Thursday of this ISO week.
  const isoYear = date.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Day = jan4.getUTCDay() === 0 ? 7 : jan4.getUTCDay();
  const week1Thursday = new Date(jan4);
  week1Thursday.setUTCDate(jan4.getUTCDate() + (4 - jan4Day));
  const days = Math.round((date - week1Thursday) / 86400000);
  return { year: isoYear, week: Math.round(days / 7) + 1 };
}

// Returns the Monday (ISO date) of the week containing the given ISO date.
function mondayOfWeek(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const isoDay = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - (isoDay - 1));
  return date.toISOString().slice(0, 10);
}

// Returns the Monday (ISO date) of ISO week N of the given ISO year.
// Week 1 contains Jan 4 (the standard ISO anchor); the Monday of week 1
// is found by walking back to Monday from Jan 4, then each subsequent
// week's Monday is +7 days from there. Years where ISO week 53 doesn't
// exist still return a valid Monday — it just happens to fall in the
// next calendar year's W01 territory, which the WEEKLY view never
// surfaces because maxWeek is derived from the actual data.
function isoWeekToMonday(isoYear, isoWeek) {
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Day = jan4.getUTCDay() === 0 ? 7 : jan4.getUTCDay();
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - (jan4Day - 1));
  const weekNMonday = new Date(week1Monday);
  weekNMonday.setUTCDate(week1Monday.getUTCDate() + (isoWeek - 1) * 7);
  return weekNMonday.toISOString().slice(0, 10);
}

// Friendly label for a week starting on the given Monday ISO date:
// "Apr 21 – 25" when the week stays in one month, or "Mar 30 – Apr 3"
// when it crosses a month boundary. Friday is used as the right edge
// because the trading week ends Friday — even when Friday is a holiday,
// the label still spans the calendar week and that's the right hint
// for the reader.
function weekLabel(mondayIso) {
  const [y, m, d] = mondayIso.split('-').map(Number);
  const monday = new Date(Date.UTC(y, m - 1, d));
  const friday = new Date(monday);
  friday.setUTCDate(monday.getUTCDate() + 4);
  const monthName = (date) => new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(date);
  if (monday.getUTCMonth() === friday.getUTCMonth()) {
    return `${monthName(monday)} ${monday.getUTCDate()} – ${friday.getUTCDate()}`;
  }
  return `${monthName(monday)} ${monday.getUTCDate()} – ${monthName(friday)} ${friday.getUTCDate()}`;
}

function etTodayIso() {
  const now = new Date();
  const etParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const y = etParts.find((p) => p.type === 'year').value;
  const m = etParts.find((p) => p.type === 'month').value;
  const d = etParts.find((p) => p.type === 'day').value;
  return `${y}-${m}-${d}`;
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
