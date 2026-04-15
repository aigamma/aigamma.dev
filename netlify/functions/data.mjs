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
      limit: '10',
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
    // Partial runs can truncate at the background-function timeout or a
    // transient Massive API error before the fetch reaches the back-month
    // monthlies, which collapses the Breeden-Litzenberger chart onto 1-2
    // expirations even though a slightly older full-chain success exists.
    // Prefer the newest successful run inside the last ~10 cron ticks (≈50
    // minutes at the current 5-minute cadence); degrade to the newest row
    // overall if the upstream API has been partial for longer than that,
    // which beats serving a 404.
    const run = runRows.find((r) => r.status === 'success') || runRows[0];

    const snapParams = new URLSearchParams({
      run_id: `eq.${run.id}`,
      select:
        'expiration_date,strike,contract_type,implied_volatility,delta,gamma,theta,vega,open_interest,volume,close_price',
      order: 'expiration_date.asc,strike.asc',
    });
    if (expirationFilter) snapParams.set('expiration_date', `eq.${expirationFilter}`);

    const prevCloseParamsStr = run.trading_date
      ? new URLSearchParams({
          underlying: `eq.${underlying}`,
          snapshot_type: `eq.${snapshotType}`,
          trading_date: `lt.${run.trading_date}`,
          order: 'captured_at.desc',
          limit: '1',
          select: 'spot_price',
        }).toString()
      : null;

    // Cloud bands use a rolling historical window computed at EOD by the
    // reconciliation / backfill job (see scripts/backfill). They are
    // trading-date-keyed, not run-keyed, so the query is a two-step
    // "latest trading_date ≤ run.trading_date, then all 281 DTE rows at
    // that date". Falls back to the most recent day with bands so an
    // intraday run on a day whose EOD reconcile hasn't happened yet
    // still gets yesterday's frozen bands as historical context. A 404
    // or empty response is non-fatal: the frontend just skips the
    // overlay and renders the observed curve alone.
    const cloudBandsDateRes = run.trading_date
      ? fetchWithTimeout(
          `${supabaseUrl}/rest/v1/daily_cloud_bands?trading_date=lte.${run.trading_date}&select=trading_date&order=trading_date.desc&limit=1`,
          { headers },
          'daily_cloud_bands_latest'
        )
      : Promise.resolve(null);

    const [levelsRes, expMetricsRes, sviRes, prevCloseRes, cloudBandsDateResolved] = await Promise.all([
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
      prevCloseParamsStr
        ? fetchWithTimeout(
            `${supabaseUrl}/rest/v1/ingest_runs?${prevCloseParamsStr}`,
            { headers },
            'prev_close'
          )
        : Promise.resolve(null),
      cloudBandsDateRes,
    ]);

    if (!levelsRes.ok) throw new Error(`computed_levels query failed: ${levelsRes.status}`);
    if (!expMetricsRes.ok) throw new Error(`expiration_metrics query failed: ${expMetricsRes.status}`);
    if (!sviRes.ok) throw new Error(`svi_fits query failed: ${sviRes.status}`);
    if (prevCloseRes && !prevCloseRes.ok) throw new Error(`prev_close query failed: ${prevCloseRes.status}`);

    let cloudBandsRows = [];
    let cloudBandsTradingDate = null;
    if (cloudBandsDateResolved?.ok) {
      const latest = await cloudBandsDateResolved.json();
      if (Array.isArray(latest) && latest.length > 0) {
        cloudBandsTradingDate = latest[0].trading_date;
        const bandsFullRes = await fetchWithTimeout(
          `${supabaseUrl}/rest/v1/daily_cloud_bands?trading_date=eq.${cloudBandsTradingDate}&select=dte,iv_p10,iv_p30,iv_p50,iv_p70,iv_p90,sample_count&order=dte.asc`,
          { headers },
          'daily_cloud_bands_rows'
        );
        if (bandsFullRes.ok) {
          const rows = await bandsFullRes.json();
          cloudBandsRows = Array.isArray(rows) ? rows : [];
        }
      }
    }

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

    const [levelsRows, expMetricsRows, sviRows, prevCloseRows] = await Promise.all([
      levelsRes.json(),
      expMetricsRes.json(),
      sviRes.json(),
      prevCloseRes ? prevCloseRes.json() : Promise.resolve([]),
    ]);

    const prevClose = Array.isArray(prevCloseRows) && prevCloseRows.length > 0
      ? toNum(prevCloseRows[0].spot_price)
      : null;

    const contracts = contractRows.map((c) => ({
      expiration_date: c.expiration_date,
      strike_price: toNum(c.strike),
      contract_type: c.contract_type,
      implied_volatility: toNum(c.implied_volatility),
      delta: toNum(c.delta),
      gamma: toNum(c.gamma),
      theta: toNum(c.theta),
      vega: toNum(c.vega),
      open_interest: c.open_interest,
      volume: c.volume,
      close_price: toNum(c.close_price),
    }));

    const rawGammaProfile = levelsRows.length > 0 ? levelsRows[0].gamma_profile : null;
    const gammaProfile = Array.isArray(rawGammaProfile)
      ? rawGammaProfile
          .map((p) => ({ s: toNum(p.s), g: toNum(p.g) }))
          .filter((p) => p.s != null && p.g != null)
      : null;

    const levels = levelsRows.length > 0
      ? {
          call_wall: toNum(levelsRows[0].call_wall_strike),
          put_wall: toNum(levelsRows[0].put_wall_strike),
          abs_gamma_strike: toNum(levelsRows[0].abs_gamma_strike),
          volatility_flip: toNum(levelsRows[0].volatility_flip),
          net_gamma_notional: toNum(levelsRows[0].net_gamma_notional),
          put_call_ratio_oi: toNum(levelsRows[0].put_call_ratio_oi),
          put_call_ratio_volume: toNum(levelsRows[0].put_call_ratio_volume),
          total_call_oi: levelsRows[0].total_call_oi,
          total_put_oi: levelsRows[0].total_put_oi,
          total_call_volume: levelsRows[0].total_call_volume,
          total_put_volume: levelsRows[0].total_put_volume,
          gamma_profile: gammaProfile,
        }
      : null;

    const expirationMetrics = expMetricsRows.map((m) => ({
      expiration_date: m.expiration_date,
      atm_iv: toNum(m.atm_iv),
      atm_strike: toNum(m.atm_strike),
      put_25d_iv: toNum(m.put_25d_iv),
      call_25d_iv: toNum(m.call_25d_iv),
    }));

    // Bands are DTE-keyed on the wire. Trading-date → expiration-date
    // resolution happens client-side in TermStructure (it already
    // derives a trading date from capturedAt). Drop DTE rows that
    // have no underlying samples so the frontend doesn't have to
    // filter holes out of its polygon paths.
    const cloudBands = cloudBandsRows
      .map((b) => ({
        dte: b.dte,
        iv_p10: toNum(b.iv_p10),
        iv_p30: toNum(b.iv_p30),
        iv_p50: toNum(b.iv_p50),
        iv_p70: toNum(b.iv_p70),
        iv_p90: toNum(b.iv_p90),
        sample_count: b.sample_count,
      }))
      .filter((b) => b.sample_count > 0 && b.iv_p50 != null);

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
      prevClose,
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
      cloudBands,
      cloudBandsTradingDate,
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
