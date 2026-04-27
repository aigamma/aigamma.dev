// netlify/functions/snapshots-retention.mjs
//
// Scheduled retention cleanup for the `snapshots` table. Once per week,
// invoke two Postgres RPCs in parallel — `cleanup_partial_snapshots_v1`
// (default 7-day threshold, partial-status runs) and
// `cleanup_success_snapshots_v1` (default 90-day threshold, success-status
// runs) — and combine their JSON reports into a single function-log line
// so Netlify's logs preserve a row-count-and-window record per fire.
//
// Why both partial AND success: The 2026-04-26 audit established two
// distinct accumulation problems on the snapshots table.
//
//   - Partial runs: 16-75% of intraday SPX ingests over the prior two
//     weeks completed in `partial` status (Massive pagination timeouts on
//     pages past ~30 of the chain). Each partial wrote 7-10K snapshot
//     rows that no read path consumes — every reader (data.mjs,
//     snapshot.mjs, expiring-gamma.mjs, fixed-strike-iv.mjs) filters
//     `status='eq.success'` before joining to snapshots. Commit 13f9b0e
//     stopped new partial runs from writing snapshots; the partial RPC
//     here reclaims any that slip through (regression backstop) plus
//     anything written before 13f9b0e landed.
//   - Success runs: ~50 success runs/day (post-13f9b0e) × 18K rows =
//     ~900K new rows/day at the steady state, which would push
//     snapshots to ~325M rows / ~80 GB by the end of a year if
//     unbounded. No live UI surface reads success-run snapshots older
//     than ~2 days (the dashboard reads only the latest run; the
//     /tactical/ FixedStrikeIvMatrix prev-day overlay reads ≤2 days
//     back). The remaining consumers of older success-run snapshots are
//     hypothetical — a future methodology change in compute-gex-history
//     or compute-vol-stats might want to re-derive daily aggregates from
//     historical chains. The default 90-day threshold preserves that
//     window while bounding steady-state size to ~80M rows / ~20 GB.
//
// Both thresholds are env-overridable so Eric can tune without a
// redeploy:
//   SNAPSHOTS_RETENTION_PARTIAL_DAYS  — default 7
//   SNAPSHOTS_RETENTION_SUCCESS_DAYS  — default 90
// Either var can be set to 0 to disable that cleanup pass entirely
// (useful if a backfill-recompute window is in progress and Eric wants
// to freeze the historical chain temporarily).
//
// The two RPCs are called in parallel via Promise.all because they
// touch disjoint row sets (`status='partial'` vs `status='success'`)
// and Postgres can scan them concurrently without lock contention. The
// combined wall-clock matches the slower of the two — useful when the
// success cleanup is a multi-second DELETE on a long-tail accumulation.
//
// Schedule: 0 8 * * 0 — every Sunday at 08:00 UTC = 04:00 ET (EDT) or
// 03:00 ET (EST), well outside any market session and outside the
// 13:00-21:55 UTC ingest window. Cron runs even on holiday weeks
// because the retention boundary is purely calendar-based.

export const config = {
  schedule: '0 8 * * 0',
};

const SUPABASE_URL = process.env.SUPABASE_URL;
// Service role key required because the cleanup_*_snapshots_v1 RPCs
// operate on the `snapshots` table which is RLS-protected. The
// functions are SECURITY DEFINER so the caller doesn't strictly need
// DELETE-on-snapshots, but PostgREST still requires the caller pass an
// apikey + Authorization matching a role with EXECUTE on the function;
// the migrations grant anon and service_role both, so either would
// work. Using the service key matches the pattern used by
// ingest-background.mjs.
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

// Default thresholds, overridable via env vars. NaN-safe parse: any
// non-numeric env value falls back to the default. A value of 0
// disables that cleanup pass (the handler skips the corresponding RPC
// call when ageDays === 0).
const DEFAULT_PARTIAL_DAYS = 7;
const DEFAULT_SUCCESS_DAYS = 90;

function parseEnvDays(envValue, fallback) {
  if (envValue == null || envValue === '') return fallback;
  const n = parseInt(envValue, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

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

async function callCleanupRpc(rpcName, ageDays, headers) {
  if (ageDays === 0) {
    return { skipped: true, age_days_threshold: 0 };
  }
  const res = await fetchWithTimeout(
    `${SUPABASE_URL}/rest/v1/rpc/${rpcName}`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ p_age_days: ageDays }),
    },
    rpcName,
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${rpcName} returned ${res.status}: ${text}`);
  }
  return await res.json();
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

  // Per-invocation overrides via query string take precedence over env
  // vars, which take precedence over the file-level defaults. The
  // query-string path is for ad-hoc manual invocations
  // (`curl '/.netlify/functions/snapshots-retention?partial_days=3&success_days=30'`)
  // when Eric wants to clean up a specific window without persisting
  // a new threshold.
  const url = new URL(request.url);
  const partialDaysParam = url.searchParams.get('partial_days') ?? url.searchParams.get('age_days');
  const successDaysParam = url.searchParams.get('success_days');

  const partialDays = partialDaysParam != null
    ? parseEnvDays(partialDaysParam, DEFAULT_PARTIAL_DAYS)
    : parseEnvDays(process.env.SNAPSHOTS_RETENTION_PARTIAL_DAYS, DEFAULT_PARTIAL_DAYS);
  const successDays = successDaysParam != null
    ? parseEnvDays(successDaysParam, DEFAULT_SUCCESS_DAYS)
    : parseEnvDays(process.env.SNAPSHOTS_RETENTION_SUCCESS_DAYS, DEFAULT_SUCCESS_DAYS);

  console.log(
    `[snapshots-retention] starting partial_days=${partialDays} success_days=${successDays}`
  );

  const headers = {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    const [partialReport, successReport] = await Promise.all([
      callCleanupRpc('cleanup_partial_snapshots_v1', partialDays, headers),
      callCleanupRpc('cleanup_success_snapshots_v1', successDays, headers),
    ]);

    const elapsedMs = Date.now() - startedAt;
    const totalDeleted =
      (partialReport.deleted_rows || 0) + (successReport.deleted_rows || 0);

    console.log(
      `[snapshots-retention] done (${elapsedMs}ms): total_deleted=${totalDeleted} ` +
      `partial=${partialReport.deleted_rows ?? 'skipped'}/` +
      `${partialReport.partial_runs_targeted ?? 0} ` +
      `success=${successReport.deleted_rows ?? 'skipped'}/` +
      `${successReport.success_runs_targeted ?? 0}`
    );

    return new Response(
      JSON.stringify({
        ok: true,
        elapsed_ms: elapsedMs,
        total_deleted_rows: totalDeleted,
        partial: partialReport,
        success: successReport,
      }),
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
