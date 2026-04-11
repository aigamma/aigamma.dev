// netlify/functions/history.mjs
// Returns a time series of recent ingest runs joined with computed_levels so the
// dashboard can plot spot, net GEX, vanna, charm, and PCR evolution across the
// session.
//
// Query params:
//   underlying    — ticker (default SPX)
//   snapshot_type — 'intraday' | 'daily' | 'synthetic_backfill' (default 'intraday')
//   lookback      — ISO-8601 duration fragment; accepts "Nh" or "Nd" (default '24h')
//   limit         — max rows to return (default 500, cap 2000)

export default async function handler(request) {
  const url = new URL(request.url);
  const underlying = url.searchParams.get('underlying') || 'SPX';
  const snapshotType = url.searchParams.get('snapshot_type') || 'intraday';
  const lookbackParam = url.searchParams.get('lookback') || '24h';
  const limitParam = parseInt(url.searchParams.get('limit') || '500', 10);
  const limit = Math.min(Math.max(1, Number.isFinite(limitParam) ? limitParam : 500), 2000);

  const lookbackMs = parseLookback(lookbackParam);
  if (lookbackMs == null) return jsonError(400, `Invalid lookback: ${lookbackParam}`);

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  if (!supabaseUrl || !supabaseKey) return jsonError(500, 'Supabase not configured');

  const headers = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json',
  };

  const sinceIso = new Date(Date.now() - lookbackMs).toISOString();

  try {
    const runParams = new URLSearchParams({
      underlying: `eq.${underlying}`,
      snapshot_type: `eq.${snapshotType}`,
      captured_at: `gte.${sinceIso}`,
      order: 'captured_at.asc',
      limit: String(limit),
      select: 'id,captured_at,trading_date,spot_price,source,contract_count',
    });

    const runRes = await fetch(`${supabaseUrl}/rest/v1/ingest_runs?${runParams}`, { headers });
    if (!runRes.ok) throw new Error(`ingest_runs query failed: ${runRes.status}`);
    const runRows = await runRes.json();

    if (runRows.length === 0) {
      return jsonOk({ underlying, snapshotType, lookback: lookbackParam, points: [] });
    }

    const runIds = runRows.map((r) => r.id);
    const levelsParams = new URLSearchParams({
      run_id: `in.(${runIds.join(',')})`,
      select:
        'run_id,net_gamma_notional,call_wall_strike,put_wall_strike,volatility_flip,max_pain_strike,put_call_ratio_oi,put_call_ratio_volume,net_vanna_notional,net_charm_notional,gamma_tilt',
    });
    const levelsRes = await fetch(`${supabaseUrl}/rest/v1/computed_levels?${levelsParams}`, { headers });
    if (!levelsRes.ok) throw new Error(`computed_levels query failed: ${levelsRes.status}`);
    const levelsRows = await levelsRes.json();

    const levelsByRun = new Map();
    for (const row of levelsRows) levelsByRun.set(row.run_id, row);

    const points = runRows.map((r) => {
      const l = levelsByRun.get(r.id) || {};
      return {
        runId: r.id,
        capturedAt: r.captured_at,
        tradingDate: r.trading_date,
        source: r.source,
        spotPrice: toNum(r.spot_price),
        netGamma: toNum(l.net_gamma_notional),
        callWall: toNum(l.call_wall_strike),
        putWall: toNum(l.put_wall_strike),
        volFlip: toNum(l.volatility_flip),
        maxPain: toNum(l.max_pain_strike),
        pcrOi: toNum(l.put_call_ratio_oi),
        pcrVolume: toNum(l.put_call_ratio_volume),
        netVanna: toNum(l.net_vanna_notional),
        netCharm: toNum(l.net_charm_notional),
        gammaTilt: toNum(l.gamma_tilt),
      };
    });

    return jsonOk({ underlying, snapshotType, lookback: lookbackParam, points });
  } catch (err) {
    return jsonError(502, err.message);
  }
}

function parseLookback(s) {
  const m = /^(\d+)([hHdD])$/.exec(s.trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  if (unit === 'h') return n * 3600 * 1000;
  if (unit === 'd') return n * 86400 * 1000;
  return null;
}

function toNum(v) {
  if (v == null) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function jsonOk(payload) {
  return new Response(JSON.stringify(payload), {
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
