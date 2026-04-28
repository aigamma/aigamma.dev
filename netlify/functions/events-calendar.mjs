// netlify/functions/events-calendar.mjs
//
// Read-side proxy for the Forex Factory economic calendar. Aggregates
// 4 rolling weeks of forward-looking events from two FF surfaces:
//
//   1. The XML weekly export at nfs.faireconomy.media/ff_calendar_thisweek.xml.
//      Stable, fast, ~3 KB compressed; covers exactly the current
//      ISO week. FF publishes this once per hour and serves a "Request
//      Denied / wait five minutes" HTML page if the export endpoint is
//      hit too aggressively. The function caches the result at the
//      Netlify edge for 1 hour to stay well inside FF's stated
//      cadence.
//
//   2. The HTML calendar at forexfactory.com/calendar?week=<slug> for
//      the next 3 weeks (week+1, week+2, week+3). FF embeds the full
//      events list as an in-page JSON blob (`days: [{...},{...}]`)
//      inside a script tag — same shape as the XML but with richer
//      fields (Unix dateline, soloTitle, impactName, etc.) and
//      arbitrary-week date addressing. The function regex-extracts
//      the JSON, parses it, and merges with the XML week. The HTML
//      surface is more brittle than the XML (it's not a documented
//      API), so each HTML week is fetched with a soft-fail wrapper:
//      a 404 / parse error / rate-limit hit on week+2 doesn't kill
//      the whole response, it just degrades gracefully and the
//      payload reports per-source status in the `sources` field.
//
// The two sources may produce duplicate entries for any week-boundary
// event (e.g., a Sunday 11pm Trump speech that shows up on the tail
// end of one week's XML and the head of the next week's HTML). The
// merge pass dedupes by `${dateTime}::${title}`.
//
// CORS is open and the cache is shared across requesters; the wire
// payload contains only USD events by default (see DEFAULT_COUNTRIES)
// so a cross-currency request needs ?countries=EUR,GBP etc. to
// broaden the scope.
//
// Wire schema:
//   {
//     fetchedAt: ISO timestamp of this function's upstream fetch,
//     source: 'forexfactory',
//     countries: ['USD'],          // echo of the active filter
//     sources: { xml: 'ok'|'error', 'html-w1': 'ok'|'error', ... },
//     events: [
//       {
//         title: 'Federal Funds Rate',
//         country: 'USD',
//         date: '2026-04-29',          // YYYY-MM-DD (FF reference TZ)
//         time: '18:00',               // 24h HH:MM, GMT-anchored
//         dateTime: '2026-04-29T18:00:00Z', // UTC ISO; browser converts
//         dayKind: 'timed' | 'all-day' | 'tentative' | 'unknown',
//         impact: 'High' | 'Medium' | 'Low' | 'Holiday',
//         forecast: '3.75%',
//         previous: '3.75%',
//         actual: null,                 // only populated for past events
//         url: 'https://www.forexfactory.com/calendar/...',
//       },
//       ...
//     ]
//   }
//
// FF's published time fields are in GMT/UTC, NOT US Eastern as an
// earlier draft of this function assumed. The FOMC press conference
// at 2pm ET = 6pm GMT shows up in the XML as "6:00pm" — interpreting
// that as ET produced an ISO string that displayed 4 hours late on
// the client. The current normalizer treats every timed FF entry
// as UTC and emits ISO with a Z suffix; the browser handles the
// local-TZ conversion downstream.
//
// Cloudflare bypass for the HTML calendar: forexfactory.com sits
// behind Cloudflare's bot-challenge layer, which serves a "Just a
// moment..." JS challenge page (HTTP 403) to clients whose TLS /
// HTTP fingerprints don't match a real browser. Node's built-in
// fetch consistently fails this check, but a `curl` subprocess
// invoked via child_process.spawn passes (curl's TLS handshake
// happens to land in Cloudflare's allowed-fingerprint set). The
// Netlify functions runtime ships curl in the AWS Lambda system
// path so the spawn works in production. The XML feed at
// nfs.faireconomy.media is on a different Cloudflare property
// without the bot check and works fine over Node fetch.

import { spawn } from 'node:child_process';

const FF_XML_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.xml';
const FF_HTML_BASE = 'https://www.forexfactory.com/calendar?week=';
const FETCH_TIMEOUT_MS = 8000;

const NUM_HTML_WEEKS_AHEAD = 3; // total scope = 1 XML + 3 HTML = 4 weeks

const DEFAULT_COUNTRIES = ['USD'];

const FETCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

export default async function handler(request) {
  const url = new URL(request.url);
  const requestedCountries = url.searchParams.get('countries');
  let countries = DEFAULT_COUNTRIES;
  if (requestedCountries) {
    const parsed = requestedCountries
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    if (parsed.length > 0) countries = parsed;
  }
  const countrySet = new Set(countries);

  // Build the per-week fetch list. Week 0 is the XML feed; weeks 1..N
  // are HTML scrapes addressed by date slug. The reference date for
  // each HTML week is "today + 7N days" — a date inside the target
  // calendar week that FF maps to that ISO week.
  const today = new Date();
  const fetches = [
    { kind: 'xml', label: 'xml', promise: fetchXmlWeek() },
  ];
  for (let i = 1; i <= NUM_HTML_WEEKS_AHEAD; i++) {
    const ref = addDays(today, i * 7);
    fetches.push({
      kind: 'html',
      label: `html-w${i}`,
      ref,
      promise: fetchHtmlWeek(ref),
    });
  }

  const settled = await Promise.allSettled(fetches.map((f) => f.promise));
  const sources = {};
  const allEvents = [];
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    const f = fetches[i];
    if (s.status === 'fulfilled' && Array.isArray(s.value)) {
      sources[f.label] = 'ok';
      allEvents.push(...s.value);
    } else {
      sources[f.label] = 'error';
    }
  }

  // If every source failed, return a 502 so the client sees the
  // outage explicitly rather than rendering an empty week.
  const okSources = Object.values(sources).filter((s) => s === 'ok').length;
  if (okSources === 0) {
    return jsonError(502, 'All FF fetches failed', { sources });
  }

  // Dedupe by (dateTime + title); identical events appearing on
  // back-to-back week boundaries get collapsed.
  const seen = new Set();
  const deduped = [];
  for (const e of allEvents) {
    const key = `${e.dateTime}::${e.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(e);
  }

  const filtered = deduped
    .filter((e) => countrySet.has(e.country))
    .sort((a, b) => a.dateTime.localeCompare(b.dateTime));

  const payload = {
    fetchedAt: new Date().toISOString(),
    source: 'forexfactory',
    sourceUrl: FF_XML_URL,
    countries,
    sources,
    weeksRequested: 1 + NUM_HTML_WEEKS_AHEAD,
    events: filtered,
  };

  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// ── XML week fetch ──────────────────────────────────────────────────
async function fetchXmlWeek() {
  const res = await fetch(FF_XML_URL, {
    headers: FETCH_HEADERS,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`XML fetch failed: ${res.status}`);
  const xml = await res.text();
  if (!xml.includes('<weeklyevents>') && !xml.includes('<event>')) {
    throw new Error('XML response missing event tags (likely rate-limited)');
  }
  return parseXmlEvents(xml);
}

function parseXmlEvents(xml) {
  const out = [];
  const eventRegex = /<event>([\s\S]*?)<\/event>/g;
  let match;
  while ((match = eventRegex.exec(xml)) !== null) {
    const body = match[1];
    const title = extractField(body, 'title');
    const country = extractField(body, 'country');
    const dateRaw = extractField(body, 'date');
    const timeRaw = extractField(body, 'time');
    const impact = extractField(body, 'impact');
    const forecast = extractField(body, 'forecast');
    const previous = extractField(body, 'previous');
    const url = extractField(body, 'url');

    if (!title || !dateRaw) continue;

    const date = normalizeDate(dateRaw);
    const { time, dateTime, dayKind } = normalizeXmlTime(date, timeRaw);

    out.push({
      title,
      country: country || null,
      date,
      time,
      dateTime,
      dayKind,
      impact: impact || null,
      forecast: forecast || null,
      previous: previous || null,
      actual: null,
      url: url || null,
    });
  }
  return out;
}

function extractField(body, tag) {
  const selfClose = new RegExp(`<${tag}\\s*\\/>`).test(body);
  if (selfClose) return '';
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);
  const m = re.exec(body);
  if (!m) return '';
  let val = m[1].trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(val);
  if (cdata) val = cdata[1].trim();
  return val;
}

function normalizeDate(raw) {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(raw);
  if (!m) return raw;
  return `${m[3]}-${m[1]}-${m[2]}`;
}

// FF's XML times are in GMT/UTC. The FOMC press conference at 2pm ET
// shows up as "6:00pm" (= 18:00 UTC), so we anchor the dateTime ISO
// at UTC (Z suffix) and let the client browser convert to local time.
// All-day / tentative entries get anchored at noon UTC of the calendar
// date — landing the timestamp squarely inside the day in any local
// timezone the client renders in.
function normalizeXmlTime(date, raw) {
  if (!raw) {
    return { time: 'all-day', dateTime: toUtcIso(date, 12, 0), dayKind: 'all-day' };
  }
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === 'all day') {
    return { time: 'all-day', dateTime: toUtcIso(date, 12, 0), dayKind: 'all-day' };
  }
  if (trimmed === 'tentative') {
    return { time: 'tentative', dateTime: toUtcIso(date, 12, 0), dayKind: 'tentative' };
  }
  const m = /^(\d{1,2}):(\d{2})\s*(am|pm)$/i.exec(trimmed);
  if (!m) {
    return { time: trimmed, dateTime: toUtcIso(date, 12, 0), dayKind: 'unknown' };
  }
  let h = Number(m[1]);
  const mm = Number(m[2]);
  const ampm = m[3].toLowerCase();
  if (ampm === 'pm' && h !== 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;
  const hh = String(h).padStart(2, '0');
  const mmStr = String(mm).padStart(2, '0');
  return { time: `${hh}:${mmStr}`, dateTime: toUtcIso(date, h, mm), dayKind: 'timed' };
}

function toUtcIso(dateIso, hour, minute) {
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  return `${dateIso}T${hh}:${mm}:00Z`;
}

// ── HTML week fetch ─────────────────────────────────────────────────
// FF's HTML calendar embeds the events list as a JSON blob inside an
// inline script tag — pattern: `days: [{...},{...}], <next-key>: ...`.
// The function fetches the HTML, regex-extracts the array, parses it,
// and normalizes each event into the same wire shape the XML branch
// produces. The HTML uses Unix `dateline` timestamps which are
// timezone-agnostic, so the conversion is direct (new Date(ms)) with
// no TZ inference required.
async function fetchHtmlWeek(referenceDate) {
  const slug = htmlWeekSlug(referenceDate);
  const url = FF_HTML_BASE + slug;
  const html = await curlGet(url, FETCH_TIMEOUT_MS);
  return parseHtmlWeek(html);
}

// Spawn a `curl` subprocess to bypass Cloudflare's bot challenge on
// forexfactory.com. Returns the response body as a string. Throws
// on non-zero curl exit, on stderr indicating a TLS/HTTP error, or
// on a body that contains the "Just a moment..." challenge marker
// (which means even curl got challenged this time and we should
// degrade rather than misparse).
function curlGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const args = [
      '--silent',
      '--show-error',
      '--fail',
      '--location',
      '--max-time', String(Math.ceil(timeoutMs / 1000)),
      '-A', FETCH_HEADERS['User-Agent'],
      '-H', `Accept: ${FETCH_HEADERS.Accept}`,
      '-H', 'Accept-Language: en-US,en;q=0.9',
      url,
    ];
    let proc;
    try {
      proc = spawn('curl', args);
    } catch (err) {
      reject(new Error(`curl spawn failed: ${err.message}`));
      return;
    }
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    const killTimer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch { /* swallow */ }
    }, timeoutMs + 1000);
    proc.on('error', (err) => {
      clearTimeout(killTimer);
      reject(new Error(`curl process error: ${err.message}`));
    });
    proc.on('close', (code) => {
      clearTimeout(killTimer);
      if (code !== 0) {
        reject(new Error(`curl exit ${code}: ${stderr.slice(0, 200)}`));
        return;
      }
      if (stdout.includes('Just a moment...') || stdout.includes('Cloudflare Ray')) {
        reject(new Error('curl response was a Cloudflare challenge page'));
        return;
      }
      resolve(stdout);
    });
  });
}

function htmlWeekSlug(date) {
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const m = months[date.getUTCMonth()];
  const d = date.getUTCDate();
  const y = date.getUTCFullYear();
  return `${m}${d}.${y}`;
}

function parseHtmlWeek(html) {
  // Match the days array. The non-greedy [^]*?] would over-eat past
  // the array close on a long page, so the pattern requires a
  // following ", <key>:" pattern that signals the next sibling
  // property in the page-level data object.
  const m = /days:\s*(\[(?:[^[\]]|\[[^\]]*\])*\])\s*,\s*[a-zA-Z_$]+\s*:/.exec(html);
  if (!m) {
    // Fall back to a more permissive matcher: take everything from
    // "days: [" until the matching closing bracket. Implements a
    // bracket-counting walk because the JSON contains nested arrays.
    const start = html.indexOf('days: [');
    if (start < 0) throw new Error('days array not found in HTML');
    let depth = 0;
    let end = -1;
    for (let i = start + 'days: '.length; i < html.length; i++) {
      const c = html[i];
      if (c === '[') depth += 1;
      else if (c === ']') {
        depth -= 1;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end < 0) throw new Error('days array not closed in HTML');
    return parseDaysJson(html.slice(start + 'days: '.length, end));
  }
  return parseDaysJson(m[1]);
}

function parseDaysJson(jsonStr) {
  let days;
  try {
    days = JSON.parse(jsonStr);
  } catch (err) {
    throw new Error(`days JSON parse failed: ${err.message}`);
  }
  const out = [];
  for (const day of days) {
    const events = Array.isArray(day?.events) ? day.events : [];
    for (const e of events) {
      const norm = normalizeHtmlEvent(e);
      if (norm) out.push(norm);
    }
  }
  return out;
}

function normalizeHtmlEvent(e) {
  if (!e || typeof e.dateline !== 'number') return null;
  const at = new Date(e.dateline * 1000);
  if (Number.isNaN(at.getTime())) return null;

  // FF's HTML JSON includes both `name` (short form) and
  // `soloTitle` (often the same; sometimes more descriptive). Prefer
  // soloTitle when present and non-empty.
  const titleRaw = (e.soloTitle && String(e.soloTitle).trim()) ||
                   (e.name && String(e.name).trim()) || '';
  const title = stripCountryPrefix(titleRaw, e.currency);
  if (!title) return null;

  // FF uses "holiday" / "low" / "medium" / "high" lowercase impactName.
  // Normalize to title case to match the existing wire schema.
  const impact = capitalizeImpact(e.impactName);

  // dayKind: timeMasked = true means "All Day" / "Tentative" /
  // unknown (FF uses timeMasked for any unscheduled label).
  let dayKind = 'timed';
  let time;
  let dateTime;
  if (e.timeMasked) {
    const label = String(e.timeLabel || '').trim().toLowerCase();
    if (label === 'all day' || label === '') {
      dayKind = 'all-day';
      time = 'all-day';
    } else if (label === 'tentative') {
      dayKind = 'tentative';
      time = 'tentative';
    } else {
      dayKind = 'unknown';
      time = label;
    }
    // For masked entries, anchor the dateTime at noon UTC of the
    // event's calendar date (UTC date of dateline) so the day
    // grouping on the client still works.
    const dayIso = at.toISOString().slice(0, 10);
    dateTime = `${dayIso}T12:00:00Z`;
  } else {
    const hh = String(at.getUTCHours()).padStart(2, '0');
    const mm = String(at.getUTCMinutes()).padStart(2, '0');
    time = `${hh}:${mm}`;
    dateTime = at.toISOString();
  }

  // Calendar date: UTC date of the dateline. FF's day grouping in
  // the HTML JSON uses dayline-aligned dates that approximately
  // track US Eastern, but the UTC date is close enough for week-
  // level navigation and stays consistent with the XML branch.
  const date = (dateTime || '').slice(0, 10);

  return {
    title,
    country: e.currency || null,
    date,
    time,
    dateTime,
    dayKind,
    impact,
    forecast: e.forecast || null,
    previous: e.previous || null,
    actual: e.actual || null,
    url: e.url ? `https://www.forexfactory.com${e.url}` : null,
  };
}

// FF prefixes the soloTitle with a 2-letter country code on some
// rows (e.g., "US Federal Funds Rate", "UK Bank Holiday"). The XML
// branch strips this prefix because the country is reported
// separately as `currency`; do the same here for parity.
function stripCountryPrefix(title, currency) {
  if (!title) return '';
  const t = title.trim();
  // Match a leading 2-letter country code + space at the start.
  const m = /^([A-Z]{2,3})\s+(.*)$/.exec(t);
  if (m && m[2]) return m[2];
  return t;
}

function capitalizeImpact(raw) {
  if (!raw) return null;
  const s = String(raw).toLowerCase();
  if (s === 'high') return 'High';
  if (s === 'medium') return 'Medium';
  if (s === 'low') return 'Low';
  if (s === 'holiday') return 'Holiday';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── helpers ─────────────────────────────────────────────────────────
function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function jsonError(status, message, extra = {}) {
  return new Response(JSON.stringify({ error: message, ...extra }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
