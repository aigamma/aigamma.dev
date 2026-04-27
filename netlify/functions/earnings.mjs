// netlify/functions/earnings.mjs
//
// Read endpoint for the /earnings surface — an earnings calendar
// scanner that mirrors and extends SpotGamma's earnings chart. Two
// payload sections feed two visual surfaces on the page:
//
//   chartDays (next 5 trading days, with implied moves):
//     Each entry { date, isoDate, tickers: [...] } where each ticker
//     carries the EarningsWhispers metadata PLUS a server-computed
//     impliedMove (decimal, e.g. 0.085 = 8.5%) derived from the
//     soonest expiration after the earnings date.
//
//   calendarDays (next 4 weeks, EW metadata only):
//     Same shape minus the impliedMove fields. Powers the upcoming
//     week-by-week grid below the chart. Implied move is omitted to
//     keep total fan-out under the Netlify 26 s sync cap; computing
//     it across all 4 weeks would push 600+ snapshot calls per
//     request, well beyond the budget.
//
// Data lineage:
//
//   1. EarningsWhispers (earningswhispers.com) — undocumented but
//      stable JSON API at /api/caldata/{YYYYMMDD}, one call per
//      calendar day. Returns the per-day list of every confirmed
//      earnings release with ticker, company, releaseTime
//      (1=BMO, 3=AMC), q1RevEst (revenue estimate, dollars),
//      q1EstEPS, confirmDate, epsTime (historical release time-of-
//      day anchor), qSales (prior-quarter actual revenue, millions).
//      The endpoint requires an ASP.NET-Core antiforgery cookie
//      that's set by an initial GET to /calendar — we bootstrap
//      that cookie once per cold start and reuse it for every
//      subsequent caldata call.
//
//   2. Massive Options snapshot (api.massive.com/v3/snapshot/options/
//      {TICKER}) — per-ticker contract chain, same MASSIVE_API_KEY
//      and same call signature already proven by /scan. We hit it
//      only for the chart-window tickers (next ~5 trading days,
//      ~30-60 names after the default Top 100 OV intersection), with
//      an expiration_date filter narrowed to [earningsDate,
//      earningsDate+14] so the response payload stays tight.
//
// Implied move formula:
//
//   Preferred:  (atmCallMid + atmPutMid) / spot         [straddle]
//   Fallback:   atmIv * sqrt(DTE / 365)                 [vol-scaled]
//
//   The straddle path needs valid bid/ask on both ATM legs; the
//   fallback path needs only a non-zero ATM IV. Stale or zero quotes
//   demote that ticker to the fallback. Tickers with neither path
//   producing a usable number drop their impliedMove to null and
//   render below the chart's plot area but still appear in the
//   tooltip-on-hover list (so the reader knows the company is
//   reporting, just without a vol-derived move estimate).
//
// Universe filter:
//
//   Default visible slice: 'topN-100' — the top 100 US tickers by
//   options volume, the same anchor list the rest of the dashboard
//   reads off of. The user-facing toggle pills above the chart let a
//   reader relax to a wider revenue-floor universe (Rev ≥ $5B,
//   Rev ≥ $2B, Rev ≥ $1B, Rev ≥ $500M) for slow earnings periods or
//   broader scans, or tighten to the Top 250 OV slice when the
//   default 100 is still too narrow. Master ingestion floor stays at
//   $500M (the most-permissive toggle) so the relaxing toggles have
//   a universe to filter from. Revenue is sourced primarily from
//   q1RevEst; falls back to qSales * 1e6 (prior-quarter actual
//   sales, in millions) when q1RevEst is null. Below the master
//   floor lives a long tail of microcaps, regional banks, small-cap
//   biotech, and illiquid REITs whose earnings are real news to
//   their employees but not load-bearing for SPX vol regime
//   reading — those names never make it into the response payload
//   regardless of toggle.
//
// Cache profile: 30 min during market hours, 4 h off-hours. Earnings
//   schedules update through the day as companies confirm release
//   times, but the change cadence is in hours not seconds, so the
//   cache TTL trades a small amount of freshness for a large drop
//   in EW load.
//
// Failure mode: if EW returns 204/error/empty for every requested
//   day, the function returns an empty calendar with a degradeReason
//   so the frontend can render a blank-state message rather than a
//   broken chart. If Massive is unreachable, the EW data still flows
//   and the chart simply renders without implied moves — calendar
//   stays useful, chart Y-axis shows blank with a degraded-banner.

import { readFileSync } from 'node:fs';

// Top-N-by-options-volume roster for the chart filter. Same JSON file
// /heatmap and /scan already consume — generated from the Barchart
// "stocks screener" CSV at C:\sheets\ via
// scripts/backfill/options-volume-roster.mjs. Holds ~250 names sorted
// by options volume desc; we take the first 100 / 250 for the
// 'topN-100' and 'topN-250' chart-filter modes so the scatter can
// show the names whose implied ranges are actually load-bearing for
// SPX vol regime reading when a reader prefers to rank by liquidity
// instead of by company size. The 4-week calendar grid below the
// chart shares the active filter mode with the scatter (single
// source of truth, two views), so toggling the pill changes both
// surfaces together.
const ROSTER_URL = new URL('../../src/data/options-volume-roster.json', import.meta.url);
const roster = JSON.parse(readFileSync(ROSTER_URL, 'utf8'));
const ROSTER_SYMBOLS = (roster?.holdings ?? []).map((h) => String(h.symbol || '').toUpperCase());

// Pre-built top-N roster sets for the chart's options-volume filter
// modes. The roster JSON holds ~250 symbols sorted by US options
// volume desc, so slicing the leading N gives the top-N set.
const CHART_TOP_100_SET = new Set(ROSTER_SYMBOLS.slice(0, 100));
const CHART_TOP_250_SET = new Set(ROSTER_SYMBOLS.slice(0, 250));

// Chart filter mode resolver. Each mode produces a (ticker → bool)
// predicate that the handler intersects with the chart-window
// universe. Modes are exposed in the response payload so the front-
// end can render the toggle UI without a hardcoded duplicate.
const CHART_FILTER_MODES = [
  { id: 'topN-100', label: 'Top 100 OV',
    predicate: (t) => CHART_TOP_100_SET.has(t.ticker) },
  { id: 'topN-250', label: 'Top 250 OV',
    predicate: (t) => CHART_TOP_250_SET.has(t.ticker) },
  { id: 'rev-5B',   label: 'Rev ≥ $5B',
    predicate: (t) => Number.isFinite(t.revenueEst) && t.revenueEst >= 5_000_000_000 },
  { id: 'rev-2B',   label: 'Rev ≥ $2B',
    predicate: (t) => Number.isFinite(t.revenueEst) && t.revenueEst >= 2_000_000_000 },
  { id: 'rev-1B',   label: 'Rev ≥ $1B',
    predicate: (t) => Number.isFinite(t.revenueEst) && t.revenueEst >= 1_000_000_000 },
  { id: 'rev-500M', label: 'Rev ≥ $500M',
    predicate: (t) => Number.isFinite(t.revenueEst) && t.revenueEst >= 500_000_000 },
];
// Default lands on 'topN-100' — the top 100 names by US options
// volume — because for the typical earnings week that slice contains
// the reporters whose implied moves the rest of the dashboard is
// also pricing off of, so the page opens on the universe that
// matches the rest of the site's anchor list. The 'rev-2B' /
// 'rev-1B' / 'rev-500M' pills are the relaxing toggles a reader
// switches to during a slower earnings period when the top-100-by-OV
// slice is too thin to fill the chart, or when they want to scan
// the broader revenue-floor universe instead of the OV anchor set.
const DEFAULT_CHART_FILTER_ID = 'topN-100';

function resolveChartFilter(modeId) {
  return CHART_FILTER_MODES.find((m) => m.id === modeId)
    ?? CHART_FILTER_MODES.find((m) => m.id === DEFAULT_CHART_FILTER_ID);
}

const EW_BASE = 'https://www.earningswhispers.com';
const EW_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const EW_TIMEOUT_MS = 6000;

const MASSIVE_API_KEY = process.env.MASSIVE_API_KEY;
const MASSIVE_BASE = 'https://api.massive.com';
const MASSIVE_TIMEOUT_MS = 8000;

// Master revenue floor — the minimum any ticker needs to clear to
// ever appear in the response payload. Set to $500M so the most
// permissive chart toggle ('rev-500M') has a universe to filter
// from; the active chart_filter mode is then applied to BOTH the
// scatter chart and the 4-week calendar grid so the two surfaces
// stay in sync (changing the toggle changes both views together).
// Earlier behavior had a separate GRID_REVENUE_FLOOR=$1B that
// pinned the grid regardless of the chart filter — Eric explicitly
// asked for the chart and grid to share state ("they would be in
// sync"), so the per-surface floor was removed in favor of the
// single shared predicate.
const MASTER_REVENUE_FLOOR = 500_000_000;  // $500M
const CHART_DAYS = 5;                // scatter chart window (trading days)
const CALENDAR_WEEKS = 4;            // calendar grid window (calendar weeks)
const CALENDAR_DAYS = CALENDAR_WEEKS * 5; // assume Mon-Fri

const FETCH_CONCURRENCY = 6;
const EW_CONCURRENCY = 4;

// SpotGamma convention: empirical scale-down from raw ATM straddle
// premium to the realized post-event one-standard-deviation range. The
// raw straddle slightly overestimates because (a) it pays
// max(|S_T - K|, 0) which has E[|S_T - K|] under any unimodal
// distribution exceeding the standard deviation by a small fraction, and
// (b) for any DTE > 0 the straddle bakes in a small amount of
// non-earnings vol on top of the earnings-night gap. 0.85 is the factor
// the SpotGamma earnings chart uses on its own published surface and
// the convention Eric set for this page.
const STRADDLE_TO_RANGE_FACTOR = 0.85;

// Module-scope cookie cache. Reset on every cold start; reused across
// warm invocations within a function instance lifetime. The 30-min TTL
// guards against the cookie quietly expiring server-side without
// triggering an immediate failure — better to refresh proactively than
// to fail one request out of every long-running instance.
let _cookieCache = null;
let _cookieFetchedAt = 0;
const COOKIE_TTL_MS = 30 * 60 * 1000;

function isMarketHoursET() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const wd = get('weekday');
  if (wd === 'Sat' || wd === 'Sun') return false;
  const minutes = Number(get('hour')) * 60 + Number(get('minute'));
  return minutes >= 570 && minutes < 960;
}

function cacheControlHeader() {
  return isMarketHoursET()
    ? 'public, max-age=1800, stale-while-revalidate=900'
    : 'public, max-age=14400, stale-while-revalidate=86400';
}

function etTodayParts() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return { y: get('year'), m: get('month'), d: get('day') };
}

function etTodayIso() {
  const { y, m, d } = etTodayParts();
  return `${y}-${m}-${d}`;
}

function addDaysIso(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function subtractDaysIso(iso, n) {
  return addDaysIso(iso, -n);
}

function dteDays(expIso, todayIso) {
  const a = new Date(`${todayIso}T00:00:00Z`).getTime();
  const b = new Date(`${expIso}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86400000);
}

function isoToYyyymmdd(iso) {
  return iso.replace(/-/g, '');
}

function dayOfWeekFromIso(iso) {
  return new Date(`${iso}T00:00:00Z`).getUTCDay(); // 0=Sun..6=Sat
}

// Build the next N trading days (Mon-Fri) starting from today inclusive
// if today is itself a trading day. Saturdays/Sundays are skipped. We
// don't try to model US market holidays here — EW returns an empty list
// on those days and the frontend shows the day as "no earnings", which
// is correct fallback behavior either way.
function nextNTradingDaysFromTodayIso(todayIso, n) {
  const out = [];
  let cursor = todayIso;
  while (out.length < n) {
    const dow = dayOfWeekFromIso(cursor);
    if (dow !== 0 && dow !== 6) out.push(cursor);
    cursor = addDaysIso(cursor, 1);
  }
  return out;
}

// Fetch one date's grouped daily bars (every US ticker, one record per
// ticker, returned in a single response). Mirrors scan.mjs and
// heatmap.mjs's helpers of the same name — same endpoint, same response
// shape, same 200-with-empty-results convention for non-trading days.
// Reused (rather than imported) so this function stays self-contained
// as a Netlify deploy unit.
async function fetchMassiveGroupedDay(dateIso) {
  if (!MASSIVE_API_KEY) return { ok: false, reason: 'no-key' };
  const url = `${MASSIVE_BASE}/v2/aggs/grouped/locale/us/market/stocks/${dateIso}?adjusted=true`;
  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${MASSIVE_API_KEY}` },
      signal: AbortSignal.timeout(MASSIVE_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, reason: String(err?.name || 'fetch-error') };
  }
  if (!res.ok) {
    return { ok: false, reason: `http-${res.status}`, status: res.status };
  }
  let body;
  try { body = await res.json(); }
  catch { return { ok: false, reason: 'invalid-json' }; }
  const list = Array.isArray(body?.results) ? body.results : [];
  if (list.length === 0) {
    return { ok: true, empty: true, prices: new Map() };
  }
  const map = new Map();
  for (const r of list) {
    const sym = String(r?.T || '').toUpperCase();
    if (!sym) continue;
    const close = Number(r?.c);
    if (!Number.isFinite(close) || close <= 0) continue;
    map.set(sym, close);
  }
  return { ok: true, empty: false, prices: map };
}

// Walk back from today's ET calendar date to find the most recent
// trading session with grouped-bars data. On a Saturday or Sunday this
// returns Friday's session; on a Monday holiday it returns Friday; on a
// normal weekday during market hours it returns the in-progress
// current-day bar. The 8-day search ceiling covers any plausible
// weekend + multi-day holiday gap. The returned prices map is keyed by
// uppercase ticker → session close, used as the spotOverride passed
// into deriveImpliedMove() so chart-window tickers can be priced
// off-hours when Massive's snapshot endpoint returns a null
// underlying_asset.price.
async function fetchMostRecentSessionGrouped() {
  if (!MASSIVE_API_KEY) return { ok: false, reason: 'no-key' };
  const today = etTodayIso();
  let lastReason = 'no-data-found';
  for (let i = 0; i < 8; i++) {
    const d = subtractDaysIso(today, i);
    const result = await fetchMassiveGroupedDay(d);
    if (!result.ok) {
      lastReason = result.reason;
      if (result.status && result.status >= 400 && result.status < 500) {
        return { ok: false, reason: result.reason, status: result.status };
      }
      continue;
    }
    if (result.empty) continue;
    return { ok: true, date: d, prices: result.prices };
  }
  return { ok: false, reason: `insufficient-sessions:${lastReason}` };
}

// Bootstrap the antiforgery cookie. ASP.NET Core sets a
// .AspNetCore.Antiforgery.<seg> cookie on the first GET of any page
// that renders a form-protected view; /calendar is the natural seed
// because that's what the JSON endpoints back. We capture every
// Set-Cookie header (there can be both the antiforgery cookie and an
// auth/session cookie) and rejoin them as a single Cookie request
// header for downstream API calls.
async function bootstrapEwCookie() {
  if (_cookieCache && Date.now() - _cookieFetchedAt < COOKIE_TTL_MS) {
    return _cookieCache;
  }
  const res = await fetch(`${EW_BASE}/calendar`, {
    headers: { 'User-Agent': EW_USER_AGENT, Accept: 'text/html' },
    signal: AbortSignal.timeout(EW_TIMEOUT_MS),
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new Error(`ew-bootstrap-${res.status}`);
  }
  // Node fetch exposes getSetCookie() (returns array). Older runtimes
  // collapse multiple Set-Cookie into a single comma-joined string,
  // which is hard to parse — try the array path first and fall back.
  let setCookies = [];
  if (typeof res.headers.getSetCookie === 'function') {
    setCookies = res.headers.getSetCookie();
  } else {
    const raw = res.headers.get('set-cookie');
    if (raw) setCookies = [raw];
  }
  const tokens = [];
  for (const sc of setCookies) {
    if (!sc) continue;
    const first = sc.split(';')[0].trim();
    // Take only cookies that look relevant; stripping marketing /
    // analytics cookies keeps the Cookie header small and avoids
    // accidentally echoing tracking IDs back to EW.
    if (
      first.startsWith('.AspNetCore.Antiforgery') ||
      first.startsWith('.AspNetCore.Cookies') ||
      first.startsWith('AspNetCore') ||
      first.startsWith('ASP.NET_SessionId')
    ) {
      tokens.push(first);
    }
  }
  if (tokens.length === 0) {
    throw new Error('ew-bootstrap-no-cookie');
  }
  _cookieCache = tokens.join('; ');
  _cookieFetchedAt = Date.now();
  return _cookieCache;
}

async function fetchEwCalendarDay(yyyymmdd) {
  let cookie;
  try {
    cookie = await bootstrapEwCookie();
  } catch (err) {
    return { ok: false, reason: String(err.message || err) };
  }
  let res;
  try {
    res = await fetch(`${EW_BASE}/api/caldata/${yyyymmdd}`, {
      headers: {
        'User-Agent': EW_USER_AGENT,
        Accept: 'application/json, text/javascript, */*; q=0.01',
        Referer: `${EW_BASE}/calendar`,
        'X-Requested-With': 'XMLHttpRequest',
        Cookie: cookie,
      },
      signal: AbortSignal.timeout(EW_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, reason: String(err?.name || 'ew-fetch-error') };
  }
  if (res.status === 204) return { ok: true, rows: [] };
  if (!res.ok) {
    // 401/403 likely means the cookie expired — invalidate and the next
    // call will reseed.
    if (res.status === 401 || res.status === 403) {
      _cookieCache = null;
      _cookieFetchedAt = 0;
    }
    return { ok: false, reason: `ew-http-${res.status}` };
  }
  let body;
  try {
    body = await res.json();
  } catch {
    return { ok: false, reason: 'ew-invalid-json' };
  }
  if (!Array.isArray(body)) return { ok: true, rows: [] };
  return { ok: true, rows: body };
}

function normalizeEwRow(r) {
  const q1Rev = Number(r?.q1RevEst);
  const qSales = Number(r?.qSales);
  // Revenue: prefer q1RevEst (estimate, dollars). Fall back to
  // qSales * 1e6 (prior-quarter actual, millions) when null/zero. The
  // fallback is admittedly a different statistical animal — last
  // quarter's actual is a noisy proxy for next quarter's estimate —
  // but the only alternative is to drop the row entirely, which would
  // hide names like SHOP whose q1RevEst is sometimes null in EW's
  // feed even though they're clearly multibillion-dollar reporters.
  const revenueEst = Number.isFinite(q1Rev) && q1Rev > 0
    ? q1Rev
    : (Number.isFinite(qSales) && qSales > 0 ? qSales * 1e6 : null);
  const releaseTime = Number(r?.releaseTime);
  const sessionLabel = releaseTime === 1 ? 'BMO'
    : releaseTime === 3 ? 'AMC'
    : 'Unknown';
  return {
    ticker: String(r?.ticker || '').toUpperCase(),
    company: String(r?.company || '').trim(),
    releaseTime: Number.isFinite(releaseTime) ? releaseTime : null,
    sessionLabel,
    nextEPSDate: r?.nextEPSDate || null,
    confirmDate: r?.confirmDate || null,
    epsTime: r?.epsTime || null,
    qDate: r?.qDate || null,
    quarterDate: r?.quarterDate || null,
    epsEst: Number.isFinite(Number(r?.q1EstEPS)) ? Number(r.q1EstEPS) : null,
    revenueEst,
    qSales: Number.isFinite(qSales) ? qSales : null,
    sentimentTotal: Number.isFinite(Number(r?.total)) ? Number(r.total) : null,
  };
}

async function pmap(items, concurrency, mapper) {
  const out = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await mapper(items[i], i);
    }
  }
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    worker,
  );
  await Promise.all(workers);
  return out;
}

// Per-ticker snapshot fetch tightly scoped to an
// [eventCapturingDate, earningsDate+14] expiration window so the
// response stays small. The lower bound is gated by reporting session:
//
//   BMO (releaseTime=1): release happens before market open on the
//     earnings date, so the SAME-DAY expiration captures the move
//     (the contract settles at 4 PM ET, after the morning gap-and-
//     drift). Lower bound = earningsDate.
//
//   AMC (releaseTime=3) or Unknown: release happens after market close.
//     The same-day expiration settles 4 PM ET, BEFORE the post-close
//     release, so it does not price the event — its straddle reflects
//     the regular session move and would systematically understate the
//     event-implied range. Lower bound = earningsDate + 1 trading day
//     (the next listed expiration is the first one whose settlement
//     comes after the earnings event). For Unknown we default to the
//     AMC convention because it's the safer assumption — including a
//     same-day expiration that settled before the event would corrupt
//     the chart, while excluding it costs at most one DTE of vol.
//
// Same auth pattern as scan.mjs.
async function fetchTickerSnapshot(ticker, earningsIso, releaseTime, spot) {
  if (!MASSIVE_API_KEY) return { ok: false, reason: 'no-key' };
  const minExpIso = releaseTime === 1 ? earningsIso : addDaysIso(earningsIso, 1);
  // 30-day upper bound captures both (a) liquid names with weekly /
  // daily expirations close to the earnings date and (b) mid-caps that
  // only list third-Friday monthly expirations, where the next listed
  // exp can be 15-25 days past an earnings date that lands mid-month.
  // The 0.85 straddle factor was calibrated by SpotGamma against the
  // soonest expiration after the event, so for monthly-only names the
  // chart value will be slightly biased high (extra DTE bakes in
  // non-earnings vol), but covering them is still a more informative
  // signal than dropping them entirely. The deriveImpliedMove() loop
  // picks the soonest listed exp from the returned set, so liquid
  // names with daily expirations still pin to DTE=0/1.
  const params = new URLSearchParams({
    'expiration_date.gte': minExpIso,
    'expiration_date.lte': addDaysIso(earningsIso, 30),
    limit: '250',
  });
  // Strike-range filter scoped to ±15% of spot. Without this, high-
  // priced names like META ($675) and KLAC ($1935) with daily / many
  // expirations in the 30-day window blow past the limit=250 ceiling
  // BEFORE the response reaches the ATM band, because Massive's
  // default sort is expiration_date.asc, strike_price.asc — so the
  // first 250 contracts only cover the lowest-strike OTM puts on the
  // earliest expirations and the entire ATM grid gets truncated. The
  // observed symptom was strikes selected 25-30% below spot (META
  // strike=$495 vs spot=$675; KLAC strike=$1400 vs spot=$1935),
  // producing implausibly-wide implied ranges (META 24.04%, KLAC
  // 20.75%) because callMid + putMid at a deeply-ITM strike includes
  // ~$180 of intrinsic value that has nothing to do with the
  // earnings-night gap. ±15% is wide enough to absorb any plausible
  // ATM band including high-IV biotechs (whose largest single-day
  // straddles cap around 30% in extreme cases) while narrow enough
  // that the strike-grid count per expiration stays well under the
  // 250 ceiling. When spot is unknown (the ticker missed the grouped-
  // bars spot map — should be rare since the map covers ~12k US
  // tickers), we omit the strike filter and accept the pagination
  // risk; better than dropping the ticker outright.
  if (Number.isFinite(spot) && spot > 0) {
    params.set('strike_price.gte', String(spot * 0.85));
    params.set('strike_price.lte', String(spot * 1.15));
  }
  let res;
  try {
    res = await fetch(`${MASSIVE_BASE}/v3/snapshot/options/${ticker}?${params}`, {
      headers: { Authorization: `Bearer ${MASSIVE_API_KEY}` },
      signal: AbortSignal.timeout(MASSIVE_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, reason: String(err?.name || 'fetch-error') };
  }
  if (!res.ok) return { ok: false, reason: `http-${res.status}` };
  let body;
  try { body = await res.json(); } catch { return { ok: false, reason: 'invalid-json' }; }
  return { ok: true, contracts: Array.isArray(body?.results) ? body.results : [] };
}

// Resolve a single contract's mid by trying every price field
// Massive's snapshot endpoint exposes, in order of preference. Each
// field is a real traded or modeled price; this is NOT a vol-time
// approximation (no IV-scaled fallback — that path was removed
// deliberately per Eric's directive). The order traverses from "live
// at this moment" to "session anchored" so a live session uses the
// freshest NBBO mid while an off-hours request still gets a real
// straddle price for every contract Massive lists.
//
//   1. last_quote NBBO mid — real-time best bid/ask average. Goes
//      null off-hours when there's no streaming book to aggregate.
//   2. last_trade.price — most recent actual trade. Persists from
//      the prior session into off-hours, but can be missing for
//      contracts that didn't trade on the session.
//   3. fmv — Polygon's continuously-computed Fair Market Value (the
//      model used to feed the dashboard NBBO indicator). Populated
//      even off-hours and across the full strike grid because it's
//      synthesized from neighboring quotes + IV surface, not a raw
//      market quote. This is a price, not a vol estimate, so it
//      stays inside the "real ATM straddle" convention.
//   4. day.close — current session's official closing price for the
//      contract. Empty during a live session before the close,
//      populated after.
//   5. day.previous_close — prior session's closing price. Always
//      populated by the start of the next session. Final fallback;
//      furthest back in time but still a real traded price.
function midPrice(c) {
  const bid = Number(c?.last_quote?.bid);
  const ask = Number(c?.last_quote?.ask);
  if (Number.isFinite(bid) && Number.isFinite(ask) && bid >= 0 && ask > 0 && ask >= bid) {
    return (bid + ask) / 2;
  }
  const last = Number(c?.last_trade?.price);
  if (Number.isFinite(last) && last > 0) return last;
  const fmv = Number(c?.fmv);
  if (Number.isFinite(fmv) && fmv > 0) return fmv;
  const dayClose = Number(c?.day?.close);
  if (Number.isFinite(dayClose) && dayClose > 0) return dayClose;
  const prevClose = Number(c?.day?.previous_close);
  if (Number.isFinite(prevClose) && prevClose > 0) return prevClose;
  return null;
}

// Reduce a snapshot to the implied-range estimate using the SpotGamma
// convention Eric set: 0.85 × (ATM call mid + ATM put mid), where the
// ATM strike is the single nearest-listed strike to spot that has BOTH
// a call AND a put listed at the chosen expiration. Single strike, not
// nearest-call + nearest-put separately — picking the legs independently
// could yield a strangle if the closest call and closest put strikes
// disagree, which would no longer satisfy the straddle definition.
//
// No vol-time fallback. Earnings concentrate options liquidity, so an
// ATM contract with no usable bid/ask AND no last-trade price is a
// strong signal that the data is unreliable for THAT ticker on THIS
// snapshot — better to drop the ticker than to fall back to a
// vol-scaled approximation that diverges from the convention. The
// caller surfaces these drops via the impliedMoveDegrade banner if the
// chart-window coverage falls below 50%.
//
// `spotOverride` (the prior session's grouped-bars close, threaded in
// from fetchMostRecentSessionGrouped at handler entry) takes precedence
// over the snapshot's per-contract underlying_asset.price field.
// underlying_asset.price is a live-quote field on Massive's snapshot
// endpoint and goes null off-hours; the override carries us through
// weekends and pre-open hours when the snapshot would otherwise be
// unspottable. Same precedence rule as scan.mjs's deriveSkew.
//
// Returns { impliedRange, impliedMove, straddleMid, expiration, strike,
//           atmIv, spot, dte } | { reason } where reason is one of:
//   'no-spot'        — neither override nor underlying_asset.price set
//   'no-listed-exp'  — no expiration in the requested window has both
//                      a call and a put
//   'no-common-strike' — chosen expiration has calls and puts but no
//                        single strike with BOTH legs (shouldn't happen
//                        on liquid earnings names, but defensive)
//   'no-mid'         — ATM call or put has null bid/ask AND null
//                      last-trade price (per Eric: "does not deserve
//                      to be on the charting tool")
function deriveImpliedMove(contracts, todayIso, spotOverride) {
  if (!Array.isArray(contracts) || contracts.length === 0) {
    return { reason: 'no-listed-exp' };
  }
  let spot = Number.isFinite(spotOverride) && spotOverride > 0 ? spotOverride : null;
  if (!(spot > 0)) {
    for (const c of contracts) {
      const p = Number(c?.underlying_asset?.price);
      if (Number.isFinite(p) && p > 0) { spot = p; break; }
    }
  }
  if (!(spot > 0)) return { reason: 'no-spot' };
  // Restrict to contracts with usable details. We don't gate on IV
  // here (the formula is a pure straddle midprice scaling, not a
  // vol-time computation); IV only feeds the tooltip context.
  const valid = contracts.filter((c) => {
    if (!c?.details) return false;
    const strike = Number(c.details.strike_price);
    return Number.isFinite(strike) && strike > 0
      && (c.details.contract_type === 'call' || c.details.contract_type === 'put')
      && typeof c.details.expiration_date === 'string';
  });
  // Bucket by expiration, keeping calls and puts separate so we can
  // pick the soonest expiration with both legs and then the
  // nearest-spot strike that has both legs.
  const byExp = new Map();
  for (const c of valid) {
    const e = c.details.expiration_date;
    if (!byExp.has(e)) byExp.set(e, { calls: new Map(), puts: new Map() });
    const bucket = byExp.get(e);
    const slot = c.details.contract_type === 'call' ? bucket.calls : bucket.puts;
    slot.set(Number(c.details.strike_price), c);
  }
  let chosenExp = null;
  let chosenBucket = null;
  for (const exp of [...byExp.keys()].sort()) {
    const bucket = byExp.get(exp);
    if (bucket.calls.size > 0 && bucket.puts.size > 0) {
      chosenExp = exp;
      chosenBucket = bucket;
      break;
    }
  }
  if (!chosenExp) return { reason: 'no-listed-exp' };
  // Single ATM strike: nearest-to-spot strike that has BOTH a call AND
  // a put listed at this expiration. Set intersection of the two strike
  // keysets, then argmin over |strike - spot|.
  const commonStrikes = [];
  for (const s of chosenBucket.calls.keys()) {
    if (chosenBucket.puts.has(s)) commonStrikes.push(s);
  }
  if (commonStrikes.length === 0) return { reason: 'no-common-strike' };
  let atmStrike = commonStrikes[0];
  let bestDist = Math.abs(atmStrike - spot);
  for (const s of commonStrikes) {
    const d = Math.abs(s - spot);
    if (d < bestDist) { bestDist = d; atmStrike = s; }
  }
  const atmCall = chosenBucket.calls.get(atmStrike);
  const atmPut = chosenBucket.puts.get(atmStrike);
  const callMid = midPrice(atmCall);
  const putMid = midPrice(atmPut);
  if (callMid == null || putMid == null) return { reason: 'no-mid' };
  const straddleMid = callMid + putMid;
  const impliedRange = STRADDLE_TO_RANGE_FACTOR * straddleMid;
  const impliedMove = impliedRange / spot;
  const dte = dteDays(chosenExp, todayIso);
  const callIv = Number(atmCall.implied_volatility);
  const putIv = Number(atmPut.implied_volatility);
  const ivPair = [callIv, putIv].filter((x) => Number.isFinite(x) && x > 0);
  const atmIv = ivPair.length > 0
    ? ivPair.reduce((a, b) => a + b, 0) / ivPair.length
    : null;
  return {
    impliedRange,
    impliedMove,
    straddleMid,
    expiration: chosenExp,
    strike: atmStrike,
    atmIv,
    spot,
    dte,
  };
}

export default async function handler(request) {
  const todayIso = etTodayIso();
  const dates = nextNTradingDaysFromTodayIso(todayIso, CALENDAR_DAYS);
  const url = new URL(request.url);
  const chartFilterMode = resolveChartFilter(url.searchParams.get('chart_filter'));

  // Fetch all calendar days from EW in parallel (bounded). Per-day
  // failures don't fail the whole request — that day just renders empty.
  // Master floor is $500M so the most-permissive chart toggle has a
  // universe to filter from; the grid filter below tightens to $1B.
  const dayResults = await pmap(dates, EW_CONCURRENCY, async (iso) => {
    const result = await fetchEwCalendarDay(isoToYyyymmdd(iso));
    if (!result.ok) {
      return { isoDate: iso, ok: false, reason: result.reason, tickers: [] };
    }
    const filtered = result.rows
      .map(normalizeEwRow)
      .filter((r) => r.ticker && r.revenueEst != null && r.revenueEst >= MASTER_REVENUE_FLOOR)
      .sort((a, b) => (b.revenueEst ?? 0) - (a.revenueEst ?? 0));
    return { isoDate: iso, ok: true, tickers: filtered };
  });

  // Chart subset: first CHART_DAYS trading days, gated by the active
  // chart filter mode. Top-100-by-options-volume is the default (the
  // SpotGamma-style tight scatter); other modes widen the universe to
  // top-250 OV or to revenue thresholds of $5B/$1B/$500M for readers
  // who want to see more of the long tail of the earnings calendar.
  // The 4-week grid below the chart is unaffected by this toggle —
  // it always renders the wider $1B-revenue universe so the landscape
  // view stays consistent regardless of which chart mode is active.
  const chartIndices = new Set(dates.slice(0, CHART_DAYS));
  const chartTickerJobs = [];
  for (const day of dayResults) {
    if (!chartIndices.has(day.isoDate)) continue;
    for (const t of day.tickers) {
      if (!chartFilterMode.predicate(t)) continue;
      chartTickerJobs.push({ day, ticker: t });
    }
  }

  let liveImpliedMoves = false;
  let impliedMoveDegrade = null;

  if (MASSIVE_API_KEY && chartTickerJobs.length > 0) {
    // Pull the most recent grouped daily bars once and build a per-
    // ticker spot map. This is the off-hours fallback for the
    // snapshot endpoint's underlying_asset.price field, which is a
    // live-quote field that goes null on weekends and pre-open.
    // Without this, every ticker drops with reason='no-spot' off-
    // hours — exactly the failure mode that motivated this rewrite
    // (commit bc6613c documented the root cause). One upstream call
    // serves the entire chart-window roster.
    const groupedSession = await fetchMostRecentSessionGrouped();
    const spotMap = groupedSession.ok ? groupedSession.prices : new Map();

    const jobResults = await pmap(chartTickerJobs, FETCH_CONCURRENCY, async (job) => {
      const knownSpot = spotMap.get(job.ticker.ticker);
      const snap = await fetchTickerSnapshot(
        job.ticker.ticker,
        job.day.isoDate,
        job.ticker.releaseTime,
        knownSpot,
      );
      if (!snap.ok) return { job, ok: false, reason: snap.reason };
      const derived = deriveImpliedMove(
        snap.contracts,
        todayIso,
        knownSpot,
      );
      if (derived?.reason) return { job, ok: false, reason: derived.reason };
      return { job, ok: true, ...derived };
    });
    let okCount = 0;
    for (const r of jobResults) {
      if (!r.ok) {
        r.job.ticker.impliedMove = null;
        r.job.ticker.impliedRange = null;
        r.job.ticker.impliedMoveReason = r.reason;
        continue;
      }
      okCount += 1;
      r.job.ticker.impliedMove = r.impliedMove;
      r.job.ticker.impliedRange = r.impliedRange;
      r.job.ticker.straddleMid = r.straddleMid;
      r.job.ticker.straddleExpiration = r.expiration;
      r.job.ticker.straddleStrike = r.strike;
      r.job.ticker.atmIv = r.atmIv;
      r.job.ticker.spot = r.spot;
      r.job.ticker.dte = r.dte;
    }
    liveImpliedMoves = okCount > 0;
    if (okCount === 0) {
      impliedMoveDegrade = `no-coverage-massive (${chartTickerJobs.length} jobs, 0 priced; spotMap=${spotMap.size}; groupedSession=${groupedSession.ok ? 'ok' : groupedSession.reason})`;
    } else if (okCount < chartTickerJobs.length / 2) {
      impliedMoveDegrade = `partial-coverage (${okCount}/${chartTickerJobs.length})`;
    }
  } else if (!MASSIVE_API_KEY) {
    impliedMoveDegrade = 'no-massive-key';
  }

  const chartDays = dayResults
    .filter((d) => chartIndices.has(d.isoDate))
    .map((d) => ({
      ...d,
      dow: dayOfWeekFromIso(d.isoDate),
      tickers: d.tickers.filter((t) => chartFilterMode.predicate(t)),
    }));

  // Calendar grid uses the SAME chart filter so the two surfaces
  // share state — the toggle controls both views together. Prior
  // behavior pinned the grid at a separate $1B floor regardless of
  // the chart filter; Eric explicitly requested the sync so the
  // reader sees the same universe in both surfaces.
  const calendarDays = dayResults.map((d) => ({
    isoDate: d.isoDate,
    ok: d.ok,
    reason: d.reason || null,
    dow: dayOfWeekFromIso(d.isoDate),
    tickers: d.tickers
      .filter((t) => chartFilterMode.predicate(t))
      .map((t) => ({
      ticker: t.ticker,
      company: t.company,
      releaseTime: t.releaseTime,
      sessionLabel: t.sessionLabel,
      revenueEst: t.revenueEst,
      epsEst: t.epsEst,
      epsTime: t.epsTime,
      confirmDate: t.confirmDate,
    })),
  }));

  const ewFailures = dayResults.filter((d) => !d.ok);
  const ewDegrade = ewFailures.length > 0
    ? `ew-failures:${ewFailures.length}/${dayResults.length} (${ewFailures.slice(0, 3).map((f) => `${f.isoDate}:${f.reason}`).join(',')})`
    : null;

  const payload = {
    asOf: todayIso,
    masterRevenueFloor: MASTER_REVENUE_FLOOR,
    chartFilter: chartFilterMode.id,
    chartFilterLabel: chartFilterMode.label,
    chartFilterModes: CHART_FILTER_MODES.map((m) => ({ id: m.id, label: m.label })),
    chartDayCount: CHART_DAYS,
    calendarWeekCount: CALENDAR_WEEKS,
    impliedMovesLive: liveImpliedMoves,
    impliedMoveDegrade,
    ewDegrade,
    chartDays,
    calendarDays,
  };

  return new Response(JSON.stringify(round(payload, 5)), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': cacheControlHeader(),
    },
  });
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
