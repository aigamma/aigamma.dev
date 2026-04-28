// netlify/functions/event-news.mjs
//
// Per-event news feed aggregator. Takes a query string from the
// /events/ page (typically the event title — "FOMC Press Conference",
// "Core CPI m/m", "Federal Funds Rate") and returns a list of recent
// news articles relevant to that catalyst, so a reader expanding a
// row gets a small inline news feed showing what's being written
// about the upcoming print.
//
// Source: Google News RSS at news.google.com/rss/search. Public
// endpoint, no auth required, returns RSS XML with title / link /
// pubDate / description / source per item. Roughly mirrors the news
// feed Forex Factory shows on its individual event pages but
// sourced independently so the page doesn't depend on FF's curation
// surface (and avoids embedding FF's branding inline on each row).
//
// Cache profile: 30 min fresh on the edge + 4 h SWR. News-cycle
// freshness for an upcoming macro release matters most in the
// minutes/hours leading up to the print itself, but the page never
// shows real-time news (the row has to be expanded for the fetch to
// fire). 30 min is a comfortable balance between freshness and
// upstream load on Google News, which has a documented "personal
// non-commercial use" TOS that forbids tight polling.
//
// Wire schema:
//   {
//     query: 'FOMC Press Conference',
//     fetchedAt: ISO timestamp,
//     items: [
//       {
//         title: 'FOMC Meeting Preview: ...',
//         link: 'https://news.google.com/rss/articles/...',
//         source: 'FOREX.com',
//         pubDate: ISO timestamp,
//         pubDateRelative: '13 minutes ago',
//       },
//       ...
//     ]
//   }
//
// The link is Google News's redirector URL; it transparently
// redirects to the actual article on the source's domain when the
// browser opens it. We don't decode the base64-encoded path because
// the redirect works without intervention.

const FETCH_TIMEOUT_MS = 6000;
const ITEM_LIMIT = 10;

// Comma-separated query string with hl/gl/ceid pinned to en-US so
// the feed targets US English news regardless of where the function
// runs. The hl=en-US locale matches the FF feed's USD-only scope.
const GN_RSS_BASE = 'https://news.google.com/rss/search';
const GN_RSS_PARAMS = 'hl=en-US&gl=US&ceid=US:en';

const FETCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Accept': 'application/rss+xml, application/xml;q=0.9, */*;q=0.8',
};

export default async function handler(request) {
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();
  if (!q) return jsonError(400, 'Missing required query param `q`');
  if (q.length > 200) return jsonError(400, 'Query too long (max 200 chars)');

  const rssUrl = `${GN_RSS_BASE}?q=${encodeURIComponent(q)}&${GN_RSS_PARAMS}`;
  let xml;
  try {
    const res = await fetch(rssUrl, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      return jsonError(502, `Upstream fetch failed: ${res.status}`);
    }
    xml = await res.text();
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      return jsonError(504, `News fetch timed out after ${FETCH_TIMEOUT_MS}ms`);
    }
    return jsonError(502, `News fetch error: ${err.message || String(err)}`);
  }

  let items;
  try {
    items = parseRssItems(xml).slice(0, ITEM_LIMIT);
  } catch (err) {
    return jsonError(500, `RSS parse error: ${err.message || String(err)}`);
  }

  const now = Date.now();
  const decorated = items.map((it) => ({
    ...it,
    pubDateRelative: relativeTime(it.pubDate, now),
  }));

  return new Response(JSON.stringify({
    query: q,
    fetchedAt: new Date(now).toISOString(),
    items: decorated,
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=1800, s-maxage=1800, stale-while-revalidate=14400',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// Regex-based RSS extractor over the flat <item>...</item> blocks
// Google News emits. Each item carries:
//   <title>...</title>           → headline (with " - SOURCE" suffix)
//   <link>...</link>              → Google News redirector URL
//   <pubDate>...</pubDate>        → RFC 1123 timestamp (Tue, 28 Apr 2026 17:41:38 GMT)
//   <source url="...">SOURCE</source>  → publisher name + URL
//   <description>...</description> → HTML-wrapped headline (we drop)
function parseRssItems(xml) {
  const out = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const body = m[1];
    const titleRaw = extractTag(body, 'title');
    const link = extractTag(body, 'link');
    const pubDateRaw = extractTag(body, 'pubDate');
    const sourceMatch = /<source\s+url="([^"]*)">([^<]*)<\/source>/.exec(body);
    const sourceName = sourceMatch ? unescapeXml(sourceMatch[2]) : '';

    if (!titleRaw || !link) continue;

    // Google News appends " - SOURCE" to titles; strip it for a
    // cleaner headline in the UI (the source already renders in
    // its own slot below the title).
    let title = unescapeXml(titleRaw);
    if (sourceName) {
      const suffix = ` - ${sourceName}`;
      if (title.endsWith(suffix)) title = title.slice(0, -suffix.length);
    }

    const pubDate = pubDateRaw ? new Date(pubDateRaw).toISOString() : null;

    out.push({
      title,
      link: unescapeXml(link),
      source: sourceName,
      pubDate,
    });
  }
  return out;
}

function extractTag(body, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);
  const m = re.exec(body);
  return m ? m[1].trim() : '';
}

function unescapeXml(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'");
}

// Compact "5 min ago" / "2 h ago" / "3 d ago" / "Apr 24" relative
// time format. Items older than 7 days emit an absolute date so
// the reader can tell stale background-context articles from
// pre-event coverage at a glance.
function relativeTime(iso, nowMs) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diffMs = nowMs - t;
  if (diffMs < 0) return 'just now';
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
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
