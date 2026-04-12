// netlify/functions/levels-history.mjs
// Returns the historical time series of key levels for a given underlying, so the
// frontend can render how call_wall, put_wall, vol_flip, abs_gamma_strike, and
// spot_price migrated across successive ingest runs.
//
// Query params:
//   underlying    — ticker (default SPX)
//   snapshot_type — 'intraday' | 'daily' | 'synthetic_backfill' (default 'intraday')
//   limit         — max rows to return (default 500, capped at 2000)

const SUPABASE_TIMEOUT_MS = 8000;

async function fetchWithTimeout(url, options, label) {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(SUPABASE_TIMEOUT_MS) });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new Error(`${label} timed out after ${SUPABASE_TIMEOUT_MS}ms`);
    }
    throw err;
  }
}

export default async function handler(request) {
  const url = new URL(request.url);
  const underlying = url.searchParams.get('underlying') || 'SPX';
  const snapshotType = url.searchParams.get('snapshot_type') || 'intraday';
  const limitParam = parseInt(url.searchParams.get('limit') || '500', 10);
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 2000) : 500;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return jsonError(500, 'Supabase not configured');
  }

  const headers = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json',
  };

  try {
    // Pull the newest `limit` runs for the underlying (desc, so we stay inside
    // the limit when there are more rows than we can ship), then reverse client-
    // side so the response is chronological ascending for the chart consumer.
    const runParams = new URLSearchParams({
      underlying: `eq.${underlying}`,
      snapshot_type: `eq.${snapshotType}`,
      select: 'id,captured_at,spot_price',
      order: 'captured_at.desc',
      limit: String(limit),
    });

    const runsRes = await fetchWithTimeout(
      `${supabaseUrl}/rest/v1/ingest_runs?${runParams}`,
      { headers },
      'ingest_runs'
    );
    if (!runsRes.ok) throw new Error(`ingest_runs query failed: ${runsRes.status}`);
    const runs = await runsRes.json();

    if (runs.length === 0) {
      return jsonResponse({ underlying, snapshotType, points: [] });
    }

    const runIds = runs.map((r) => r.id);
    const levelsParams = new URLSearchParams({
      run_id: `in.(${runIds.join(',')})`,
      select: 'run_id,call_wall_strike,put_wall_strike,volatility_flip,abs_gamma_strike',
    });

    const levelsRes = await fetchWithTimeout(
      `${supabaseUrl}/rest/v1/computed_levels?${levelsParams}`,
      { headers },
      'computed_levels'
    );
    if (!levelsRes.ok) throw new Error(`computed_levels query failed: ${levelsRes.status}`);
    const levelsRows = await levelsRes.json();

    const levelsByRun = new Map();
    for (const row of levelsRows) {
      levelsByRun.set(row.run_id, row);
    }

    const points = runs
      .map((run) => {
        const lvl = levelsByRun.get(run.id) || {};
        return {
          run_id: run.id,
          captured_at: run.captured_at,
          spot_price: toNum(run.spot_price),
          call_wall_strike: toNum(lvl.call_wall_strike),
          put_wall_strike: toNum(lvl.put_wall_strike),
          volatility_flip: toNum(lvl.volatility_flip),
          abs_gamma_strike: toNum(lvl.abs_gamma_strike),
        };
      })
      .sort((a, b) => new Date(a.captured_at).getTime() - new Date(b.captured_at).getTime());

    return jsonResponse({ underlying, snapshotType, points });
  } catch (err) {
    return jsonError(502, err.message);
  }
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
    },
  });
}

function toNum(value) {
  if (value == null) return null;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
