// aigamma.com, public stats aggregator.
//
// Reads page_views from Supabase across a window and returns a single
// rolled-up JSON payload that the /stats page renders. Mirrors the
// worldthought.com stats function but uses Supabase REST instead of
// Netlify Blobs as the substrate, and joins the in-house chat_logs
// table to surface the most-asked research surfaces from the on-page
// chat sidebar (the rough equivalent of worldthought's "most-opened
// connection" signal, but adapted to aigamma's research-lab page mix).
//
// No auth, no admin layer, no privileged view: the same payload is
// served to every visitor. The aggregation runs on each call (no
// separate compactor); at portfolio-site traffic levels this is well
// inside the function CPU budget and the response is cached at the
// edge for 60 seconds with a 5-minute stale-while-revalidate tail.
//
// Privacy posture: this function never returns visitor_id values, raw
// IPs, raw user-agents, raw referrer URLs, or any per-message chat
// content. It returns aggregates only. The raw events in page_views
// and the raw chat_logs rows are intentionally never exposed.

import { PAGES, CHAT_PAGES } from '../../src/data/pages.js';

const CACHE_HEADERS = {
  'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

const PATH_TO_PAGE = new Map();
for (const [href, page] of Object.entries(PAGES)) {
  PATH_TO_PAGE.set(href, {
    href,
    title: page.title,
    section: page.topnav
      ? 'topnav'
      : page.menu?.section || (href === '/' ? 'home' : 'chrome'),
  });
}

const CHAT_SURFACES = new Set(CHAT_PAGES.map((p) => p.surface));

function topN(map, n) {
  return [...map.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, n);
}

function isoMinus(days) {
  return new Date(Date.now() - days * 86400000).toISOString();
}

async function fetchPaged(url, headers, range, perPage = 1000) {
  const out = [];
  let start = 0;
  while (true) {
    const end = start + perPage - 1;
    const res = await fetch(url, {
      headers: { ...headers, Range: `${start}-${end}`, 'Range-Unit': 'items' },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`supabase_http_${res.status}: ${body.substring(0, 200)}`);
    }
    const batch = await res.json();
    for (const row of batch) out.push(row);
    if (batch.length < perPage) break;
    start += perPage;
    if (start >= range) break;
  }
  return out;
}

async function readEvents(supabaseUrl, serviceKey, daysBack) {
  const cutoff = isoMinus(daysBack);
  const select = 'ts,path,visitor_id,country,ref_domain,event,meta,ua_family';
  const url =
    `${supabaseUrl}/rest/v1/page_views?select=${encodeURIComponent(select)}` +
    `&ts=gte.${encodeURIComponent(cutoff)}` +
    `&order=ts.desc`;
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
  };
  try {
    return await fetchPaged(url, headers, 100000);
  } catch (e) {
    console.error('analytics_stats_page_views_read_failed', e?.message || e);
    return [];
  }
}

async function readChatLogs(supabaseUrl, serviceKey, daysBack) {
  const cutoff = isoMinus(daysBack);
  const select = 'id,created_at,surface,model,stop_reason';
  const url =
    `${supabaseUrl}/rest/v1/chat_logs?select=${encodeURIComponent(select)}` +
    `&created_at=gte.${encodeURIComponent(cutoff)}` +
    `&order=created_at.desc`;
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
  };
  try {
    return await fetchPaged(url, headers, 100000);
  } catch (e) {
    console.error('analytics_stats_chat_logs_read_failed', e?.message || e);
    return [];
  }
}

function dayOf(ts) {
  if (typeof ts !== 'string' || ts.length < 10) return null;
  return ts.slice(0, 10);
}

function aggregateWindow(events, chats) {
  const human = events.filter((e) => e.ua_family !== 'bot');
  const bot = events.filter((e) => e.ua_family === 'bot');

  const views = human.filter((e) => e.event === 'view');
  const pairs = human.filter((e) => e.event === 'compare_open' || e.event === 'edge_click');

  const total_views = views.length;
  const unique_visitors = new Set(human.map((e) => e.visitor_id).filter(Boolean)).size;
  const total_compares = pairs.length;
  const bot_views = bot.filter((e) => e.event === 'view').length;
  const chat_turns = chats.length;
  const unique_chat_surfaces = new Set(chats.map((c) => c.surface).filter(Boolean)).size;

  // Top page views, joined to PAGES so the page can render titles
  // and section badges rather than raw paths. Path normalization:
  // strip query string and trailing slash variants so /tactical and
  // /tactical/ collapse to one bucket.
  const viewCounts = new Map();
  for (const e of views) {
    const p = (e.path || '').split('?')[0];
    if (!p) continue;
    const canonical = PATH_TO_PAGE.has(p) ? p : PATH_TO_PAGE.has(p + '/') ? p + '/' : p;
    viewCounts.set(canonical, (viewCounts.get(canonical) || 0) + 1);
  }
  const top_pages = topN(viewCounts, 25).map(({ key, count }) => ({
    ...PATH_TO_PAGE.get(key),
    href: PATH_TO_PAGE.get(key)?.href || key,
    title: PATH_TO_PAGE.get(key)?.title || key,
    section: PATH_TO_PAGE.get(key)?.section || 'chrome',
    views: count,
  }));

  // Page mix by section (topnav, tools, research, chrome). Each view
  // counts toward its section so a reader can see whether the
  // tactical surfaces or the research labs are driving traffic.
  const sectionCounts = new Map();
  for (const e of views) {
    const p = (e.path || '').split('?')[0];
    const page = PATH_TO_PAGE.get(p) || PATH_TO_PAGE.get(p + '/');
    const section = page?.section || 'chrome';
    sectionCounts.set(section, (sectionCounts.get(section) || 0) + 1);
  }
  const by_section = [...sectionCounts.entries()]
    .map(([section, count]) => ({ section, count }))
    .sort((a, b) => b.count - a.count);

  // Country distribution.
  const countryCounts = new Map();
  for (const e of human) {
    if (!e.country) continue;
    countryCounts.set(e.country, (countryCounts.get(e.country) || 0) + 1);
  }
  const by_country = topN(countryCounts, 30).map(({ key, count }) => ({
    country: key,
    count,
  }));

  // Referrers (off-site only; site-internal dropped at write time).
  const refCounts = new Map();
  let direct = 0;
  for (const e of views) {
    if (!e.ref_domain) direct += 1;
    else refCounts.set(e.ref_domain, (refCounts.get(e.ref_domain) || 0) + 1);
  }
  const top_referrers = topN(refCounts, 15).map(({ key, count }) => ({
    domain: key,
    count,
  }));

  // Daily series, chronological.
  const dayBuckets = new Map();
  for (const e of human) {
    const d = dayOf(e.ts);
    if (!d) continue;
    if (!dayBuckets.has(d))
      dayBuckets.set(d, { views: 0, visitors: new Set(), pairs: 0 });
    const b = dayBuckets.get(d);
    if (e.event === 'view') b.views += 1;
    if (e.event === 'compare_open' || e.event === 'edge_click') b.pairs += 1;
    if (e.visitor_id) b.visitors.add(e.visitor_id);
  }
  for (const c of chats) {
    const d = dayOf(c.created_at);
    if (!d) continue;
    if (!dayBuckets.has(d))
      dayBuckets.set(d, { views: 0, visitors: new Set(), pairs: 0, chats: 0 });
    const b = dayBuckets.get(d);
    b.chats = (b.chats || 0) + 1;
  }
  const daily = [...dayBuckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, b]) => ({
      date,
      views: b.views,
      visitors: b.visitors.size,
      pairs: b.pairs,
      chats: b.chats || 0,
    }));

  // Chat-side breakdown (mirrors worldthought's connection aggregate
  // but per the aigamma data model). Top surfaces by chat turn count,
  // model split (Sonnet vs Opus), and error-rate snapshot.
  const surfaceCounts = new Map();
  const modelCounts = new Map();
  let chat_errors = 0;
  for (const c of chats) {
    const surface = c.surface || 'unknown';
    surfaceCounts.set(surface, (surfaceCounts.get(surface) || 0) + 1);
    const model = c.model || 'unknown';
    modelCounts.set(model, (modelCounts.get(model) || 0) + 1);
    if (typeof c.stop_reason === 'string' && c.stop_reason.startsWith('upstream_')) {
      chat_errors += 1;
    }
  }
  const top_chat_surfaces = topN(surfaceCounts, 15).map(({ key, count }) => {
    const page = CHAT_PAGES.find((p) => p.surface === key);
    return {
      surface: key,
      count,
      path: page?.path || null,
      title: page?.path
        ? PATH_TO_PAGE.get(page.path)?.title || key
        : key,
    };
  });
  const chat_models = topN(modelCounts, 10).map(({ key, count }) => ({
    model: key,
    count,
  }));

  return {
    total_views,
    unique_visitors,
    total_compares,
    bot_views,
    direct_visits: direct,
    chat_turns,
    unique_chat_surfaces,
    chat_errors,
    top_pages,
    by_section,
    by_country,
    top_referrers,
    daily,
    top_chat_surfaces,
    chat_models,
  };
}

export default async (req) => {
  const url = new URL(req.url);
  const requestedDays = Math.min(90, Math.max(1, Number(url.searchParams.get('days') || '30')));

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return new Response(
      JSON.stringify({
        site: 'aigamma.com',
        error: 'analytics_supabase_env_missing',
        message:
          'The /api/stats function requires SUPABASE_URL and SUPABASE_SERVICE_KEY env vars on the Netlify project. The Stats page will recover automatically once they are set.',
      }),
      { status: 503, headers: CACHE_HEADERS },
    );
  }

  const [events, chats] = await Promise.all([
    readEvents(SUPABASE_URL, SUPABASE_SERVICE_KEY, requestedDays),
    readChatLogs(SUPABASE_URL, SUPABASE_SERVICE_KEY, requestedDays),
  ]);

  const now = Date.now();
  const dayCutoff = now - 1 * 86400000;
  const weekCutoff = now - 7 * 86400000;
  const monthCutoff = now - 30 * 86400000;

  function inWindow(evList, ts) {
    return evList.filter((e) => new Date(e.ts || e.created_at).getTime() >= ts);
  }

  const payload = {
    site: 'aigamma.com',
    generated_at: new Date().toISOString(),
    window_days: requestedDays,
    day: aggregateWindow(inWindow(events, dayCutoff), inWindow(chats, dayCutoff)),
    week: aggregateWindow(inWindow(events, weekCutoff), inWindow(chats, weekCutoff)),
    month: aggregateWindow(inWindow(events, monthCutoff), inWindow(chats, monthCutoff)),
    all_in_window: aggregateWindow(events, chats),
    notes: {
      privacy:
        'No cookies, no PII, no fingerprinting, no third-party tracking. Visitor counts are derived from a sha256 hash of IP plus a daily-rotating salt; the raw IP is never written to disk. Bot traffic is counted separately so headline figures reflect real readers. Same data, same view, for every visitor.',
      coverage:
        'Page-view tracking began when /api/track shipped. Chat-log tracking has been running since the chat function deployed. Lower the days query parameter to focus on the recent window.',
    },
  };

  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: CACHE_HEADERS,
  });
};

export const config = {
  path: '/api/stats',
};
