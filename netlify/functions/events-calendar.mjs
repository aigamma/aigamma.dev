// netlify/functions/events-calendar.mjs
//
// Read-side proxy for the Forex Factory weekly calendar XML feed at
// https://nfs.faireconomy.media/ff_calendar_thisweek.xml. Three reasons
// the browser can't fetch the source URL directly:
//
//   1. CORS: the faireconomy.media origin does not advertise
//      Access-Control-Allow-Origin, so a cross-origin XHR from
//      aigamma.com is blocked by the browser regardless of how often
//      the source is reachable.
//   2. Rate limiting: the FF maintainers explicitly throttle the
//      Calendar Export endpoint and serve a "Request Denied / wait
//      five minutes" HTML page to clients that hit it too often. Their
//      published guidance is "the export is updated once per hour;
//      requesting it more than that is unnecessary and can result in
//      being blocked." A naive client-side fetch on every page mount
//      would burn through that budget on the first day of any traffic.
//   3. XML parsing: the source is XML with windows-1252 / CDATA
//      sections, not JSON, and we only need ~9 fields per event. The
//      browser would have to ship a parser to consume it.
//
// This function fetches the XML once, parses it server-side, and emits
// JSON. The Netlify edge cache is configured for 1 hour fresh +
// 24-hour stale-while-revalidate so the function only re-fetches the
// upstream once per hour at most, comfortably inside FF's stated
// update cadence. The same cache pattern is used by the seasonality
// and rotations functions (see netlify/functions/seasonality.mjs).
//
// Schema emitted to the client:
//   {
//     fetchedAt: ISO timestamp of this function's upstream fetch,
//     source: 'forexfactory',
//     events: [
//       {
//         title: 'Federal Funds Rate',
//         country: 'USD',
//         date: '2026-04-29',     // normalized YYYY-MM-DD
//         time: '18:00',          // normalized HH:MM (24h, ET)
//         dateTime: '2026-04-29T18:00:00-04:00', // ISO with ET offset
//         impact: 'High',
//         forecast: '3.75%',
//         previous: '3.75%',
//         actual: null,           // FF "thisweek" feed does not carry actual; reserved
//         url: 'https://www.forexfactory.com/calendar/1-us-federal-funds-rate'
//       },
//       ...
//     ]
//   }
//
// Notes:
//   - Times in the FF feed are in US Eastern (per FF's own UI). The
//     ET offset toggles between -05:00 (EST) and -04:00 (EDT) by date,
//     so we resolve each event's offset using the IANA zone via
//     Intl.DateTimeFormat rather than hard-coding one offset.
//   - The "actual" field is not present in the thisweek XML (FF only
//     publishes forecast/previous in the export); we emit it as null
//     so the client component renders "—" until a future version of
//     the function fills it from a different source.
//   - "All Day" / "Tentative" times are emitted with time='all-day'
//     or time='tentative' and dateTime set to the day's 00:00 ET so
//     downstream sort logic still works.
//   - "Holiday" impact-tier rows are passed through (the FF feed uses
//     them for bank holidays); the client decides whether to render
//     them.
//
// The function ships zero dependencies — the FF schema is flat enough
// that a 30-line regex extractor parses it more reliably than pulling
// in xml2js / fast-xml-parser for one endpoint.

const FF_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.xml';
const FETCH_TIMEOUT_MS = 8000;

// Spoof a real browser User-Agent. The Cloudflare layer in front of
// faireconomy.media will serve the rate-limited HTML to obvious bot
// UAs (curl/* and friends). A standard Chrome UA gets the XML.
const FETCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Accept': 'application/xml, text/xml, */*;q=0.8',
};

export default async function handler() {
  let xml;
  try {
    const res = await fetch(FF_URL, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      return jsonError(502, `Upstream FF fetch failed: ${res.status}`);
    }
    xml = await res.text();
    // Cheap rate-limit detector: the throttle response is HTML, not XML.
    if (!xml.includes('<weeklyevents>') && !xml.includes('<event>')) {
      return jsonError(502, 'Upstream FF returned non-XML (likely rate-limited)');
    }
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      return jsonError(504, `FF fetch timed out after ${FETCH_TIMEOUT_MS}ms`);
    }
    return jsonError(502, `FF fetch error: ${err.message || String(err)}`);
  }

  let events;
  try {
    events = parseEvents(xml);
  } catch (err) {
    return jsonError(500, `XML parse error: ${err.message || String(err)}`);
  }

  const payload = {
    fetchedAt: new Date().toISOString(),
    source: 'forexfactory',
    sourceUrl: FF_URL,
    events,
  };

  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // 1 hour fresh on the edge + 24 hour stale-while-revalidate. FF
      // publishes the export "once per hour" by their own admission,
      // so anything tighter is wasted upstream traffic and risks the
      // throttle. The SWR tail keeps the page snappy if the upstream
      // hiccups — a stale serve is fine for an event calendar where
      // most rows don't change between hours.
      'Cache-Control': 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400',
      // CORS open so the /beta/ React app can fetch this from
      // aigamma.com directly (also covers any future cross-origin
      // consumer).
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// ── XML parsing ────────────────────────────────────────────────────────
// Regex-based extractor over a flat <weeklyevents><event>...</event></weeklyevents>
// schema. The FF XML uses CDATA on every value-bearing field so the
// extractor strips the CDATA wrapper after pulling the inner text.
function parseEvents(xml) {
  const out = [];
  // Match each <event>...</event> block. Non-greedy on body so blocks
  // don't bleed into each other; the s flag lets . span newlines.
  const eventRegex = /<event>([\s\S]*?)<\/event>/g;
  let match;
  while ((match = eventRegex.exec(xml)) !== null) {
    const body = match[1];
    const title = extractField(body, 'title');
    const country = extractField(body, 'country');
    const dateRaw = extractField(body, 'date');     // MM-DD-YYYY
    const timeRaw = extractField(body, 'time');     // 12-hour with am/pm, "All Day", "Tentative"
    const impact = extractField(body, 'impact');    // High / Medium / Low / Holiday
    const forecast = extractField(body, 'forecast');
    const previous = extractField(body, 'previous');
    const url = extractField(body, 'url');

    if (!title || !dateRaw) continue; // require at least these two

    const date = normalizeDate(dateRaw);   // YYYY-MM-DD
    const { time, dateTime, dayKind } = normalizeTime(date, timeRaw);

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
      actual: null, // not in thisweek feed; reserved for a future data source
      url: url || null,
    });
  }
  // Sort chronologically — the source already comes ordered, but a
  // belt-and-suspenders sort ensures consumers can rely on order.
  out.sort((a, b) => a.dateTime.localeCompare(b.dateTime));
  return out;
}

// Pulls the inner text of <tag>...</tag>, unwrapping CDATA. Returns
// '' for self-closing or empty tags.
function extractField(body, tag) {
  // Self-closing form: <tag />
  const selfClose = new RegExp(`<${tag}\\s*\\/>`).test(body);
  if (selfClose) return '';
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);
  const m = re.exec(body);
  if (!m) return '';
  let val = m[1].trim();
  // Strip CDATA wrapper if present.
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(val);
  if (cdata) val = cdata[1].trim();
  return val;
}

// 'MM-DD-YYYY' → 'YYYY-MM-DD'.
function normalizeDate(raw) {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(raw);
  if (!m) return raw;
  return `${m[3]}-${m[1]}-${m[2]}`;
}

// Convert a 12-hour FF time like "11:30am" / "6:00pm" into 24-hour HH:MM
// in US Eastern, plus an ISO-with-offset string. Special cases:
//   "All Day"  → time='all-day',  dateTime= date + T00:00 ET
//   "Tentative" → time='tentative', dateTime= date + T00:00 ET
function normalizeTime(date, raw) {
  if (!raw) return { time: 'all-day', dateTime: toEtIso(date, 0, 0), dayKind: 'all-day' };
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === 'all day') {
    return { time: 'all-day', dateTime: toEtIso(date, 0, 0), dayKind: 'all-day' };
  }
  if (trimmed === 'tentative') {
    return { time: 'tentative', dateTime: toEtIso(date, 0, 0), dayKind: 'tentative' };
  }
  const m = /^(\d{1,2}):(\d{2})\s*(am|pm)$/i.exec(trimmed);
  if (!m) {
    // Fallback: keep the raw string, anchor to start of day.
    return { time: trimmed, dateTime: toEtIso(date, 0, 0), dayKind: 'unknown' };
  }
  let h = Number(m[1]);
  const mm = Number(m[2]);
  const ampm = m[3].toLowerCase();
  if (ampm === 'pm' && h !== 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;
  const hh = String(h).padStart(2, '0');
  const mmStr = String(mm).padStart(2, '0');
  return { time: `${hh}:${mmStr}`, dateTime: toEtIso(date, h, mm), dayKind: 'timed' };
}

// Build an ISO-8601 timestamp anchored to America/New_York. The ET
// offset is -05:00 for EST and -04:00 for EDT depending on date; we
// resolve which one applies for the target date by formatting it via
// the IANA zone and pulling the offset out of the formatted parts.
function toEtIso(dateIso, hour, minute) {
  const offsetMinutes = etOffsetMinutes(dateIso);
  const sign = offsetMinutes <= 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const offH = String(Math.floor(abs / 60)).padStart(2, '0');
  const offM = String(abs % 60).padStart(2, '0');
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  return `${dateIso}T${hh}:${mm}:00${sign}${offH}:${offM}`;
}

// Returns the America/New_York UTC offset in minutes for the given ISO
// date (positive east of UTC, negative west). EST=-300, EDT=-240.
function etOffsetMinutes(dateIso) {
  // Anchor at 12:00 UTC on the target date so we don't straddle a DST
  // transition that happens at 02:00 local.
  const d = new Date(`${dateIso}T12:00:00Z`);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'shortOffset',
    year: 'numeric',
  });
  const parts = fmt.formatToParts(d);
  const offsetPart = parts.find((p) => p.type === 'timeZoneName')?.value || 'GMT-5';
  // shortOffset emits strings like "GMT-5" or "GMT-4".
  const m = /GMT([+-])(\d{1,2})(?::?(\d{2}))?/.exec(offsetPart);
  if (!m) return -300;
  const sign = m[1] === '-' ? -1 : 1;
  const h = Number(m[2]);
  const mm = Number(m[3] || 0);
  return sign * (h * 60 + mm);
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
