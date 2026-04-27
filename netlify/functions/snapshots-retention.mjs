// netlify/functions/snapshots-retention.mjs
//
// Scheduled retention cleanup for the `snapshots` table. Once per week,
// invoke the Postgres RPC `cleanup_partial_snapshots_v1(p_age_days)` to
// remove per-strike snapshot rows attached to partial-status ingest runs
// older than the threshold. Returns a small JSON report so Netlify's
// function logs preserve a row-count-and-time-window record on every fire.
//
// Why partial-only: The 2026-04-26 audit found that ~37% of intraday SPX
// ingest runs over the prior two market weeks completed in `partial` status
// (Massive pagination timeouts on pages past ~30 of the chain). Each
// partial run wrote 7-10K snapshot rows that no read path in
// netlify/functions consumes — every reader (data.mjs, snapshot.mjs,
// expiring-gamma.mjs, fixed-strike-iv.mjs) filters `status='eq.success'`
// before joining to snapshots. After commit 13f9b0e the ingest itself
// stopped writing those rows for NEW partial runs; this scheduled
// function exists to reclaim the historical accumulation that built up
// before that commit landed AND to act as defense-in-depth in case the
// 13f9b0e branch ever regresses.
//
// What this does NOT do: clean up SUCCESS-run snapshots. That is a
// separate retention policy with bigger implications (a methodology
// change in the daily aggregation scripts could in principle want to
// re-derive daily_gex_stats from old success-run chains, although in
// practice the daily_* tables are themselves the data of record at
// EOD), and Eric should set the threshold for that policy explicitly.
// If/when a success-run retention is wanted, add a sibling RPC and
// extend this function — do NOT generalize cleanup_partial_snapshots_v1
// to also drop success-run rows.
//
// Schedule: 0 8 * * 0 — every Sunday at 08:00 UTC, which is 04:00 ET (EDT)
// or 03:00 ET (EST), well outside any market session and outside the
// ingest window. The cleanup workload is light (after the first-run
// historical reclaim, weekly invocations should find at most ~80
// partial runs from the prior week × 0 snapshot rows each because of
// commit 13f9b0e). The cron runs even on holiday weeks because the
// retention boundary is purely calendar-based.

export const config = {
  schedule: '0 8 * * 0',
};

const SUPABASE_URL = process.env.SUPABASE_URL;
// Service role key required because the cleanup_partial_snapshots_v1
// RPC operates on the `snapshots` table which is RLS-protected. The
// function itself is SECURITY DEFINER so the caller doesn't strictly
// need DELETE-on-snapshots, but PostgREST still requires the caller
// pass an apikey + Authorization that matches a role with EXECUTE on
// the function — the migration grants both anon and service_role, so
// either would work; using the service key matches the pattern used by
// ingest-background.mjs.
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

// Age threshold (days) below which partial runs are preserved. Seven
// days gives any in-flight forensic review of a Massive pagination
// outage window enough room to inspect the partial chains before
// they're reclaimed. Override via the `?age_days=N` query param when
// invoking this function manually for one-off cleanup of a different
// window.
const DEFAULT_AGE_DAYS = 7;

const RETENTION_TIMEOUT_MS = 60000;

async function fetchWithTimeout(url, options, label) {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(RETENTION_TIMEOUT_MS) });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new Error(`${label} timed out after ${RETENTION_TIMEOUT_MS}ms`);
    }
    throw err;
  }
}

export default async function handler(request) {
  const startedAt = Date.now();

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('[snapshots-retention] missing Supabase env vars');
    return new Response(
      JSON.stringify({ error: 'misconfigured' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const url = new URL(request.url);
  const ageDaysParam = url.searchParams.get('age_days');
  const ageDays = ageDaysParam != null ? parseInt(ageDaysParam, 10) : DEFAULT_AGE_DAYS;
  if (!Number.isFinite(ageDays) || ageDays < 1) {
    return new Response(
      JSON.stringify({ error: 'age_days must be a positive integer' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  console.log(`[snapshots-retention] starting (age_days=${ageDays})`);

  try {
    const rpcRes = await fetchWithTimeout(
      `${SUPABASE_URL}/rest/v1/rpc/cleanup_partial_snapshots_v1`,
      {
        method: 'POST',
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ p_age_days: ageDays }),
      },
      'cleanup_partial_snapshots_v1',
    );

    if (!rpcRes.ok) {
      const text = await rpcRes.text();
      throw new Error(`RPC returned ${rpcRes.status}: ${text}`);
    }

    const report = await rpcRes.json();
    const elapsedMs = Date.now() - startedAt;

    console.log(
      `[snapshots-retention] done (${elapsedMs}ms): deleted_rows=${report.deleted_rows} ` +
      `runs_targeted=${report.partial_runs_targeted} ` +
      `window=[${report.oldest_captured_at || 'none'}, ${report.newest_captured_at || 'none'}]`
    );

    return new Response(
      JSON.stringify({ ok: true, elapsed_ms: elapsedMs, ...report }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('[snapshots-retention] error:', err);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    );
  }
}
