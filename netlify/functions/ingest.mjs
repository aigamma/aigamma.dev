// netlify/functions/ingest.mjs
// Scheduled trigger that fires on cron, checks whether the US equity market
// is open in ET, and (if so) dispatches to `ingest-background.mjs` via an
// internal HTTP call with a shared INGEST_SECRET.
//
// Schedule below fires every 5 minutes during a 9-hour UTC window that wraps
// both EDT and EST market hours. The in-function gate further down clips to
// the 9:30 ET - 16:30 ET window and skips weekends and US market holidays,
// so any fires that fall outside the gate window are fast no-op early
// returns. The SPX cash session closes at 16:15 ET, but the Massive feed
// is 15-minute-delayed, so the final 16:15 print only lands in the backend
// at 16:30 ET; the gate extends to 16:30 (not 16:15) to capture that last
// snapshot. Total budget: 108 fires/day Mon-Fri × ~22 trading
// days/month ≈ 2,376 trigger invocations/month, of which ~1,782 dispatch to
// the background worker and the remaining ~594 are sub-100ms gate-skip
// returns. Comfortably under Netlify free-tier 125k inv/mo and 100h runtime.

export const config = {
  // Cron is in UTC. EDT (UTC-4): 13:00-21:55 UTC = 09:00-17:55 ET, wraps the
  // 09:30-16:30 ET gate window. EST (UTC-5): 13:00-21:55 UTC = 08:00-16:55
  // ET, also wraps 09:30-16:30 ET (the EST cron tail reaches 16:55 ET, one
  // 5-minute step past the 16:30 gate, leaving a single skip-fire at 16:35
  // ET). The minimum hour range that covers both DST states' gate windows
  // is 13-21 inclusive — narrower ranges miss either the EDT 09:30 open
  // (if start > 13) or the EST 16:30 final fire (if end < 21). Day-of-week
  // 1-5 = Mon-Fri.
  schedule: '*/5 13-21 * * 1-5',
};

const INGEST_SECRET = process.env.INGEST_SECRET;
const BACKGROUND_URL = process.env.INGEST_BACKGROUND_URL;

// Hardcoded US market holidays through 2028. Mirrors ingest-background.mjs.
// Refresh this set before 2028-12-31 — past the last entry, the ingest will
// silently fire on closed-market days (wasted Massive API calls, empty runs).
const US_MARKET_HOLIDAYS = new Set([
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
  '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31',
  '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
  '2028-01-17', '2028-02-21', '2028-04-14', '2028-05-29', '2028-06-19',
  '2028-07-04', '2028-09-04', '2028-11-23', '2028-12-25',
]);

export default async function handler(request) {
  const now = new Date();
  const etDate = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const etString = now.toLocaleString('en-US', { timeZone: 'America/New_York' });

  // Market hours gate. Callers can bypass via `?force=1` (useful for manual
  // testing via `curl /.netlify/functions/ingest?force=1`).
  const url = new URL(request.url);
  const force = url.searchParams.get('force') === '1';

  // Diagnostic endpoint — reports env var presence at the function runtime
  // without exposing any values. Useful when the Netlify dashboard/MCP env
  // var list is stale or unreliable.
  if (url.searchParams.get('diag') === '1') {
    return new Response(
      JSON.stringify({
        hasIngestSecret: Boolean(INGEST_SECRET),
        hasMassiveApiKey: Boolean(process.env.MASSIVE_API_KEY),
        hasSupabaseUrl: Boolean(process.env.SUPABASE_URL),
        hasSupabaseKey: Boolean(process.env.SUPABASE_KEY),
        hasSupabaseServiceKey: Boolean(process.env.SUPABASE_SERVICE_KEY),
        hasBackgroundUrl: Boolean(BACKGROUND_URL),
        netlifyUrl: process.env.URL || null,
        nowEt: etString,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (!force) {
    const et = new Date(etString);
    const day = et.getDay();
    const timeDecimal = et.getHours() + et.getMinutes() / 60;

    if (day === 0 || day === 6) {
      console.log(`[ingest-trigger] skipping weekend (${etString})`);
      return new Response('skip: weekend', { status: 200 });
    }
    if (US_MARKET_HOLIDAYS.has(etDate)) {
      console.log(`[ingest-trigger] skipping holiday ${etDate}`);
      return new Response('skip: holiday', { status: 200 });
    }
    if (timeDecimal < 9.5 || timeDecimal > 16.5) {
      console.log(`[ingest-trigger] skipping outside market hours (${etString})`);
      return new Response('skip: outside market hours', { status: 200 });
    }
  }

  if (!INGEST_SECRET) {
    console.error('[ingest-trigger] INGEST_SECRET not configured');
    return new Response('misconfigured', { status: 500 });
  }

  // Resolve the background function URL. Netlify exposes `URL` at runtime
  // for the site base (production or branch deploy), so we can construct
  // the internal path without hardcoding a hostname.
  const bgUrl = BACKGROUND_URL ||
    `${process.env.URL || 'http://localhost:8888'}/.netlify/functions/ingest-background`;

  console.log(`[ingest-trigger] dispatching to ${bgUrl} (${etString})`);

  try {
    const res = await fetch(bgUrl, {
      method: 'POST',
      headers: {
        'x-ingest-secret': INGEST_SECRET,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ underlying: 'SPX' }),
    });
    // Background functions return 202 immediately. We do NOT wait for the
    // actual work to finish — the scheduled function has a 30s ceiling.
    console.log(`[ingest-trigger] dispatched, status=${res.status}`);
    return new Response(`dispatched (${res.status})`, { status: 202 });
  } catch (err) {
    console.error('[ingest-trigger] dispatch error:', err);
    return new Response(`dispatch failed: ${err.message}`, { status: 500 });
  }
}
