// netlify/functions/ingest.mjs
// Scheduled trigger that fires on cron, checks whether the US equity market
// is open in ET, and (if so) dispatches to `ingest-background.mjs` via an
// internal HTTP call with a shared INGEST_SECRET.
//
// Cron is intentionally disabled on initial deploy — manual testing first.
// Uncomment the `schedule` field in `config` once the background function
// has been calibrated and Supabase has been wiped for a clean start.

// NOTE: schedule is commented out. Enable only after manual calibration.
// export const config = {
//   schedule: '*/5 * * * *',
// };

const INGEST_SECRET = process.env.INGEST_SECRET;
const BACKGROUND_URL = process.env.INGEST_BACKGROUND_URL;

// Hardcoded US market holidays through 2028. Mirrors ingest-background.mjs.
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
    if (timeDecimal < 9.5 || timeDecimal > 16.25) {
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
