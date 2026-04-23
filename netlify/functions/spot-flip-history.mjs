// netlify/functions/spot-flip-history.mjs
// Returns a time series of (captured_at, spot_price, volatility_flip) from
// recent intraday ingest runs for the Gamma Regime chart. Each row pairs the
// run's spot price with the vol flip from its computed_levels record. Null
// flips are forward-filled from the most recent known value so the frontend
// always has a continuous reference level.
//
// Query params:
//   from — YYYY-MM-DD lookback start (optional; default 14 calendar days ago)

const SUPABASE_TIMEOUT_MS = 8000;
const PAGE_SIZE = 1000;
const DEFAULT_LOOKBACK_DAYS = 14;
const LEVELS_BATCH = 200;

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
  const fromParam = url.searchParams.get('from');

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
    const from = fromParam || new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);

    const runParams = new URLSearchParams({
      underlying: 'eq.SPX',
      snapshot_type: 'eq.intraday',
      status: 'eq.success',
      select: 'id,captured_at,spot_price',
      order: 'captured_at.asc',
    });
    runParams.set('captured_at', `gte.${from}T00:00:00Z`);

    const runs = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const end = offset + PAGE_SIZE - 1;
      const res = await fetchWithTimeout(
        `${supabaseUrl}/rest/v1/ingest_runs?${runParams}`,
        { headers: { ...headers, Range: `${offset}-${end}`, 'Range-Unit': 'items' } },
        'ingest_runs',
      );
      if (!res.ok && res.status !== 206) throw new Error(`ingest_runs: ${res.status}`);
      const page = await res.json();
      if (!Array.isArray(page) || page.length === 0) break;
      runs.push(...page);
      if (page.length < PAGE_SIZE) break;
    }

    if (runs.length === 0) {
      return jsonOk({ series: [] });
    }

    // Batch-fetch computed_levels for all run IDs. volatility_flip is the
    // zero-crossing flip when available; abs_gamma_strike (the gamma-max
    // strike) is the fallback for older runs where the zero-crossing pass
    // was not yet deployed.
    const flipMap = new Map();
    for (let i = 0; i < runs.length; i += LEVELS_BATCH) {
      const batch = runs.slice(i, i + LEVELS_BATCH).map((r) => r.id);
      const lvlParams = new URLSearchParams({
        select: 'run_id,volatility_flip,abs_gamma_strike',
      });
      lvlParams.set('run_id', `in.(${batch.join(',')})`);
      const res = await fetchWithTimeout(
        `${supabaseUrl}/rest/v1/computed_levels?${lvlParams}`,
        { headers },
        'computed_levels',
      );
      if (res.ok) {
        const rows = await res.json();
        for (const r of rows) {
          flipMap.set(r.run_id, toNum(r.volatility_flip) ?? toNum(r.abs_gamma_strike));
        }
      }
    }

    // Build series with forward-fill for missing flips. Skip rows before
    // any flip value is known so the frontend doesn't have to handle nulls.
    // SPX spot is quoted to 2 decimal places by the CBOE feed (and by
    // ThetaData's EOD normalization), but the value persisted in
    // ingest_runs.spot_price carries the full float that came out of the
    // intraday Massive response — e.g., 7136.368070360775. Rounding to 2dp
    // matches the natural precision and saves ~500 bytes gzipped on a
    // 380-row payload. Flip values are already stored at 2dp because
    // computed_levels.volatility_flip is rounded at ingest time.
    let lastFlip = null;
    const series = [];
    for (const run of runs) {
      const flip = flipMap.get(run.id) ?? lastFlip;
      if (flip != null) lastFlip = flip;
      if (flip == null) continue;
      const spot = toNum(run.spot_price);
      series.push({
        t: run.captured_at,
        s: spot == null ? null : Math.round(spot * 100) / 100,
        f: flip,
      });
    }

    return jsonOk({ series });
  } catch (err) {
    return jsonError(502, err.message);
  }
}

function toNum(value) {
  if (value == null) return null;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function jsonOk(data) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
    },
  });
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
