// netlify/functions/data.mjs
// Reads the latest (or specified) ingest run from Supabase and returns a snapshot
// of contracts, aggregate GEX levels, and per-expiration skew metrics.
//
// Query params:
//   underlying    — ticker (default SPX)
//   snapshot_type — 'intraday' | 'daily' | 'synthetic_backfill' (default 'intraday')
//   date          — YYYY-MM-DD trading date filter (optional; without it, returns most recent run)
//   expiration    — YYYY-MM-DD expiration filter on contracts (optional; without it, returns all expirations in the run)

// Per-request Supabase timeout. Kept well under the 30s Netlify function ceiling
// so a hung query fails fast and surfaces as a 502 rather than stalling the
// whole function until the platform kills it.
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
  const tradingDate = url.searchParams.get('date');
  const expirationFilter = url.searchParams.get('expiration');

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
    const runParams = new URLSearchParams({
      underlying: `eq.${underlying}`,
      snapshot_type: `eq.${snapshotType}`,
      order: 'captured_at.desc',
      limit: '1',
    });
    if (tradingDate) runParams.set('trading_date', `eq.${tradingDate}`);

    const runRes = await fetchWithTimeout(
      `${supabaseUrl}/rest/v1/ingest_runs?${runParams}`,
      { headers },
      'ingest_runs'
    );
    if (!runRes.ok) {
      throw new Error(`ingest_runs query failed: ${runRes.status}`);
    }
    const runRows = await runRes.json();
    if (runRows.length === 0) {
      return jsonError(
        404,
        `No ${snapshotType} run found for ${underlying}${tradingDate ? ` on ${tradingDate}` : ''}`
      );
    }
    const run = runRows[0];

    const snapParams = new URLSearchParams({
      run_id: `eq.${run.id}`,
      order: 'expiration_date.asc,strike.asc',
    });
    if (expirationFilter) snapParams.set('expiration_date', `eq.${expirationFilter}`);

    const [levelsRes, expMetricsRes, sviRes] = await Promise.all([
      fetchWithTimeout(
        `${supabaseUrl}/rest/v1/computed_levels?run_id=eq.${run.id}`,
        { headers },
        'computed_levels'
      ),
      fetchWithTimeout(
        `${supabaseUrl}/rest/v1/expiration_metrics?run_id=eq.${run.id}&order=expiration_date.asc`,
        { headers },
        'expiration_metrics'
      ),
      fetchWithTimeout(
        `${supabaseUrl}/rest/v1/svi_fits?run_id=eq.${run.id}&order=expiration_date.asc`,
        { headers },
        'svi_fits'
      ),
    ]);

    if (!levelsRes.ok) throw new Error(`computed_levels query failed: ${levelsRes.status}`);
    if (!expMetricsRes.ok) throw new Error(`expiration_metrics query failed: ${expMetricsRes.status}`);
    if (!sviRes.ok) throw new Error(`svi_fits query failed: ${sviRes.status}`);

    // Page through snapshots via Range header. PostgREST/Supabase caps single
    // responses (default 1000 rows), and run 19 has 9k+ contracts — fetching a
    // single unpaginated page silently truncates to the lowest strikes of the
    // earliest expirations, which collapses the GEX profile onto one side of spot.
    const PAGE_SIZE = 1000;
    const contractRows = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const end = offset + PAGE_SIZE - 1;
      const pageRes = await fetchWithTimeout(
        `${supabaseUrl}/rest/v1/snapshots?${snapParams}`,
        { headers: { ...headers, Range: `${offset}-${end}`, 'Range-Unit': 'items' } },
        'snapshots'
      );
      if (!pageRes.ok && pageRes.status !== 206) {
        throw new Error(`snapshots query failed: ${pageRes.status}`);
      }
      const page = await pageRes.json();
      if (!Array.isArray(page) || page.length === 0) break;
      contractRows.push(...page);
      if (page.length < PAGE_SIZE) break;
    }

    const [levelsRows, expMetricsRows, sviRows] = await Promise.all([
      levelsRes.json(),
      expMetricsRes.json(),
      sviRes.json(),
    ]);

    const contracts = contractRows.map((c) => ({
      expiration_date: c.expiration_date,
      strike_price: toNum(c.strike),
      contract_type: c.contract_type,
      implied_volatility: toNum(c.implied_volatility),
      delta: toNum(c.delta),
      gamma: toNum(c.gamma),
      theta: toNum(c.theta),
      vega: toNum(c.vega),
      vanna: toNum(c.vanna),
      charm: toNum(c.charm),
      open_interest: c.open_interest,
      volume: c.volume,
      close_price: toNum(c.close_price),
    }));

    const levels = levelsRows.length > 0
      ? {
          call_wall: toNum(levelsRows[0].call_wall_strike),
          put_wall: toNum(levelsRows[0].put_wall_strike),
          abs_gamma_strike: toNum(levelsRows[0].abs_gamma_strike),
          volatility_flip: toNum(levelsRows[0].volatility_flip),
          net_gamma_notional: toNum(levelsRows[0].net_gamma_notional),
          gamma_tilt: toNum(levelsRows[0].gamma_tilt),
          max_pain_strike: toNum(levelsRows[0].max_pain_strike),
          put_call_ratio_oi: toNum(levelsRows[0].put_call_ratio_oi),
          put_call_ratio_volume: toNum(levelsRows[0].put_call_ratio_volume),
          total_call_oi: levelsRows[0].total_call_oi,
          total_put_oi: levelsRows[0].total_put_oi,
          total_call_volume: levelsRows[0].total_call_volume,
          total_put_volume: levelsRows[0].total_put_volume,
          net_vanna_notional: toNum(levelsRows[0].net_vanna_notional),
          net_charm_notional: toNum(levelsRows[0].net_charm_notional),
        }
      : null;

    const expirationMetrics = expMetricsRows.map((m) => ({
      expiration_date: m.expiration_date,
      atm_iv: toNum(m.atm_iv),
      atm_strike: toNum(m.atm_strike),
      put_25d_iv: toNum(m.put_25d_iv),
      call_25d_iv: toNum(m.call_25d_iv),
      skew_25d_rr: toNum(m.skew_25d_rr),
      max_pain_strike: toNum(m.max_pain_strike),
      contract_count: m.contract_count,
    }));

    const expirations = [...new Set(contractRows.map((c) => c.expiration_date).filter(Boolean))].sort();

    const sviFits = sviRows.map((r) => ({
      expiration_date: r.expiration_date,
      t_years: toNum(r.t_years),
      forward_price: toNum(r.forward_price),
      params: {
        a: toNum(r.a),
        b: toNum(r.b),
        rho: toNum(r.rho),
        m: toNum(r.m),
        sigma: toNum(r.sigma),
      },
      rmse_iv: toNum(r.rmse_iv),
      sample_count: r.sample_count,
      iterations: r.iterations,
      converged: r.converged,
      tenor_window: toNum(r.tenor_window),
      non_negative_variance: r.non_negative_variance,
      butterfly_arb_free: r.butterfly_arb_free,
      min_durrleman_g: toNum(r.min_durrleman_g),
      density_strikes: Array.isArray(r.density_strikes) ? r.density_strikes.map(toNum) : null,
      density_values: Array.isArray(r.density_values) ? r.density_values.map(toNum) : null,
      density_integral: toNum(r.density_integral),
      fitted_at: r.fitted_at,
    }));

    const payload = {
      underlying: run.underlying,
      spotPrice: toNum(run.spot_price),
      capturedAt: run.captured_at,
      tradingDate: run.trading_date,
      snapshotType: run.snapshot_type,
      source: run.source,
      runId: run.id,
      contractCount: contracts.length,
      expirations,
      selectedExpiration: expirationFilter || null,
      contracts,
      levels,
      expirationMetrics,
      sviFits,
    };

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
      },
    });
  } catch (err) {
    return jsonError(502, err.message);
  }
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
