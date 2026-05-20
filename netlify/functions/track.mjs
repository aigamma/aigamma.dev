// aigamma.com, analytics tracker function.
//
// Public, cookieless, no-PII event collector. Powers the /stats page.
// Every page mount on the site fires one POST here from
// src/ErrorBoundary.jsx (the universal wrapper around every per-page
// App). Cross-room compare events fire from the connection surfaces
// when those land; right now aigamma has none, so only view events
// fire in the steady state. Stored in the Supabase public.page_views
// table (one row per event); the /api/stats endpoint reads from this
// table and aggregates on the fly. Mirrors the worldthought.com
// architecture but uses Supabase as the substrate rather than Netlify
// Blobs because aigamma already lives on Supabase (chat_logs,
// snapshots, etc.) and there is no reason to add a second backend.
//
// Privacy posture (load-bearing for the public-analytics promise):
//
//   1. No cookies, ever. No localStorage. No fingerprinting. The
//      client-side beacon sends only the current path and the
//      document referrer.
//   2. The visitor_id is sha256(client_ip + daily_salt) truncated to
//      16 hex chars. The daily_salt is derived deterministically from
//      the ANALYTICS_SALT_MASTER env var plus the UTC date, so same-
//      day same-IP collapses to one visitor without storing the IP,
//      and cross-day correlation of the same visitor is impossible
//      without the master salt.
//   3. The referrer is reduced to its registered domain (no path, no
//      query string) so we can see search-driven or off-site inbound
//      traffic without retaining what URL the visitor came from
//      inside another site. Same-origin referrers are dropped before
//      write.
//   4. The country header (x-country) is recorded as a two-letter
//      code only. No city, no region, no lat/lng.
//   5. Do-Not-Track is honored: if DNT 1 is set the function returns
//      204 without writing anything.
//   6. Coarse User-Agent classification only ('browser' / 'bot' /
//      'other'), no version, no platform. Bots are counted separately
//      so headline figures stay honest.

import { createHash } from 'node:crypto';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const BOT_PATTERNS = /(bot|crawler|spider|scraper|preview|monitor|wget|curl|python-requests|httpie|axios|fetch|httpclient|java\/|go-http-client|libwww|facebookexternalhit|slackbot|whatsapp|twitterbot|linkedinbot|discordbot|telegrambot|gptbot|claudebot|perplexitybot|youbot|amazonbot|applebot|bytespider|ccbot|chatgpt|claude-web|cohere|gemini|googlebot|bingbot|baiduspider|yandex|duckduckbot|sogou|exabot|seznambot|petalbot|ahrefsbot|semrushbot|mj12bot|dotbot|rogerbot|screaming|sitebulb|netcraft|uptimerobot|pingdom|statuscake|gtmetrix|lighthouse|pagespeed|headlesschrome|phantomjs|puppeteer|playwright|selenium)/i;

function classifyUserAgent(ua) {
  if (!ua) return 'other';
  if (BOT_PATTERNS.test(ua)) return 'bot';
  if (/mozilla|chrome|safari|firefox|edge|opera/i.test(ua)) return 'browser';
  return 'other';
}

function extractReferrerDomain(ref, ownHost) {
  if (!ref) return null;
  try {
    const u = new URL(ref);
    let host = u.hostname.toLowerCase();
    if (host.startsWith('www.')) host = host.slice(4);
    if (ownHost && host === ownHost.toLowerCase().replace(/^www\./, '')) return null;
    return host;
  } catch {
    return null;
  }
}

function dailySalt(dateStr) {
  const master = process.env.ANALYTICS_SALT_MASTER || 'aigamma-default-salt-rotate-monthly';
  return createHash('sha256').update(master + ':' + dateStr).digest('hex').slice(0, 32);
}

function hashVisitor(ip, dateStr) {
  if (!ip) return 'unknown';
  return createHash('sha256').update(ip + ':' + dailySalt(dateStr)).digest('hex').slice(0, 16);
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { ...CORS_HEADERS, Allow: 'POST, OPTIONS' },
    });
  }

  if (req.headers.get('dnt') === '1') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response('Invalid JSON', { status: 400, headers: CORS_HEADERS });
  }

  const path = typeof body?.path === 'string' ? body.path.slice(0, 200) : null;
  if (!path || !path.startsWith('/')) {
    return new Response('Missing or invalid path', { status: 400, headers: CORS_HEADERS });
  }

  const event = typeof body?.event === 'string' ? body.event.slice(0, 32) : 'view';
  const ALLOWED_EVENTS = new Set(['view', 'compare_open', 'edge_click']);
  if (!ALLOWED_EVENTS.has(event)) {
    return new Response('Unknown event', { status: 400, headers: CORS_HEADERS });
  }

  const refRaw = typeof body?.ref === 'string' ? body.ref.slice(0, 500) : null;
  const ownHost = req.headers.get('host') || 'aigamma.com';
  const ref_domain = extractReferrerDomain(refRaw, ownHost);

  let meta = null;
  if ((event === 'compare_open' || event === 'edge_click') && body?.meta) {
    const a = typeof body.meta.a === 'string' ? body.meta.a.slice(0, 40).toLowerCase() : null;
    const b = typeof body.meta.b === 'string' ? body.meta.b.slice(0, 40).toLowerCase() : null;
    if (a && b && a !== b) {
      meta = a < b ? { a, b } : { a: b, b: a };
    }
  }

  const ip =
    req.headers.get('x-nf-client-connection-ip') ||
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown';
  const dateStr = todayUtc();
  const visitor_id = hashVisitor(ip, dateStr);
  const country = req.headers.get('x-country') || null;
  const ua = req.headers.get('user-agent') || '';
  const ua_family = classifyUserAgent(ua);

  const row = {
    path,
    visitor_id,
    country,
    ref_domain,
    event,
    meta,
    ua_family,
  };

  // Fire-and-forget insert via Supabase REST. The 204 returns
  // immediately; a transient Supabase outage drops the event silently
  // (analytics is best-effort, not audit-grade). The service role is
  // required to bypass RLS, which is enabled with no policies on
  // public.page_views.
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/page_views`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          Prefer: 'return=minimal',
        },
        body: JSON.stringify(row),
      }).catch(() => {});
    } catch (e) {
      console.error('analytics_track_supabase_insert_failed', e?.message || e);
    }
  }

  return new Response(null, { status: 204, headers: CORS_HEADERS });
};

export const config = {
  path: '/api/track',
};
