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
  let tradingDate = url.searchParams.get('date');
  const expirationFilter = url.searchParams.get('expiration');
  // prev_day=1 lets the browser request the previous trading day's run
  // without having to wait on today's /api/data to resolve first and
  // hand back prevTradingDate. The server resolves the prev date from
  // ingest_runs internally, so today's and yesterday's payloads can be
  // fetched in parallel from the client. Ignored when `date` is set.
  const wantPrevDay = !tradingDate && url.searchParams.get('prev_day') === '1';

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
    // In prev-day mode, first resolve the actual trading_date we want: the
    // most recent distinct trading_date strictly before the latest intraday
    // run's trading_date. One cheap single-column query that returns at most
    // a handful of rows.
    if (wantPrevDay) {
      const latestParams = new URLSearchParams({
        underlying: `eq.${underlying}`,
        snapshot_type: `eq.${snapshotType}`,
        order: 'trading_date.desc',
        limit: '1',
        select: 'trading_date',
      });
      const latestRes = await fetchWithTimeout(
        `${supabaseUrl}/rest/v1/ingest_runs?${latestParams}`,
        { headers },
        'latest_trading_date'
      );
      if (!latestRes.ok) throw new Error(`latest_trading_date query failed: ${latestRes.status}`);
      const latestRows = await latestRes.json();
      const latestDate = Array.isArray(latestRows) && latestRows[0]?.trading_date;
      if (latestDate) {
        const prevParams = new URLSearchParams({
          underlying: `eq.${underlying}`,
          snapshot_type: `eq.${snapshotType}`,
          trading_date: `lt.${latestDate}`,
          order: 'trading_date.desc',
          limit: '1',
          select: 'trading_date',
        });
        const prevRes = await fetchWithTimeout(
          `${supabaseUrl}/rest/v1/ingest_runs?${prevParams}`,
          { headers },
          'prev_trading_date'
        );
        if (prevRes.ok) {
          const prevRows = await prevRes.json();
          if (Array.isArray(prevRows) && prevRows[0]?.trading_date) {
            tradingDate = prevRows[0].trading_date;
          }
        }
      }
      if (!tradingDate) {
        return jsonError(404, `No prior-day ${snapshotType} run found for ${underlying}`);
      }
    }

    const runParams = new URLSearchParams({
      underlying: `eq.${underlying}`,
      snapshot_type: `eq.${snapshotType}`,
      order: 'captured_at.desc',
      limit: '10',
      // Explicit projection skips error_message (TEXT, can hold a multi-kB
      // stack trace from a prior failed run) and created_at (unused on the
      // wire). Every remaining field feeds either the run-selection
      // heuristic below or the final payload.
      select:
        'id,captured_at,trading_date,underlying,snapshot_type,spot_price,contract_count,status,source',
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
    // Pick the newest successful run that reports a non-zero contract_count.
    // The prior implementation probed each candidate with a serial single-row
    // SELECT against snapshots to defend against a failure mode where the run
    // header landed but the batched INSERT into snapshots didn't. That mode
    // hasn't recurred in the current stable ingest path, and the probe loop
    // was costing up to 10 sequential Supabase round-trips on every page
    // load. If a header-with-no-body run ever slips through again, the symptom
    // is a single 60-second-cache window serving an empty chain until the
    // next 5-minute cron writes a healthy run — acceptable degradation
    // relative to paying the probe cost on every successful load.
    const run =
      runRows.find((r) => r.status === 'success' && (r.contract_count ?? 0) > 0) ||
      runRows[0];

    const snapParams = new URLSearchParams({
      run_id: `eq.${run.id}`,
      // Projection intentionally omits theta, vega — the frontend reads
      // neither today, and any future model that needs them (SVI/Heston/Merton
      // calibrations) is expected to reconstruct them locally from IV + strike
      // + spot + T, or to fetch them through a purpose-built model-inputs
      // endpoint. bid_price/ask_price/charm/vanna were dropped from the table
      // entirely in the null-column cleanup; root_symbol is written for the
      // SPX/SPXW disambiguation during ingest but no frontend surface reads
      // it. The fields that remain in snapshots after the cleanup are fully
      // enumerated below.
      select:
        'expiration_date,strike,contract_type,implied_volatility,delta,gamma,open_interest,volume,close_price',
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
          select: 'spot_price,trading_date',
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

    // Gamma Index comes from the most-recent daily_gex_stats row, not from
    // the live computed_levels. OI is reported once overnight and stays
    // fixed through the session; intraday IV/spot drift the live call_gex
    // and put_gex aggregates but the dealer positioning book the market
    // is facing today is whatever last night's EOD sweep produced.
    const dailyGexRes = fetchWithTimeout(
      `${supabaseUrl}/rest/v1/daily_gex_stats?select=trading_date,call_gex,put_gex,atm_call_gex,atm_put_gex,atm_contract_count,contract_count&order=trading_date.desc&limit=1`,
      { headers },
      'daily_gex_stats_latest'
    );

    const [levelsRes, expMetricsRes, prevCloseRes, cloudBandsDateResolved, dailyGexResolved] = await Promise.all([
      fetchWithTimeout(
        // Explicit projection — lists only the seven fields the wire payload
        // exposes. Prevents accidental regressions where a future widening
        // column pulls kilobytes of unused data into every response.
        `${supabaseUrl}/rest/v1/computed_levels?run_id=eq.${run.id}&select=call_wall_strike,put_wall_strike,volatility_flip,put_call_ratio_oi,put_call_ratio_volume,total_call_volume,total_put_volume`,
        { headers },
        'computed_levels'
      ),
      fetchWithTimeout(
        `${supabaseUrl}/rest/v1/expiration_metrics?run_id=eq.${run.id}&order=expiration_date.asc&select=expiration_date,atm_iv,put_25d_iv,call_25d_iv`,
        { headers },
        'expiration_metrics'
      ),
      // The svi_fits query used to sit here in parallel with the rest of the
      // batch, but the table has been empty for the lifetime of this codebase
      // (useSviFits always falls back to client-side calibration). The
      // round-trip was costing ~40 ms on every page load for a guaranteed
      // empty response. If scheduled SVI persistence ever lands, the query
      // returns and the useSviFits hook picks up the backend fits without
      // needing a wire-shape change — the frontend still accepts the
      // sviFits array when present.
      prevCloseParamsStr
        ? fetchWithTimeout(
            `${supabaseUrl}/rest/v1/ingest_runs?${prevCloseParamsStr}`,
            { headers },
            'prev_close'
          )
        : Promise.resolve(null),
      cloudBandsDateRes,
      dailyGexRes,
    ]);

    if (!levelsRes.ok) throw new Error(`computed_levels query failed: ${levelsRes.status}`);
    if (!expMetricsRes.ok) throw new Error(`expiration_metrics query failed: ${expMetricsRes.status}`);
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
    // responses at 1000 rows, and an SPX intraday run holds ~19k contracts.
    // The page count is known up front from run.contract_count (populated
    // by ingest before the snapshot INSERT lands), so all pages fire in
    // parallel instead of sequentially — turning ~20 serial Supabase RTTs
    // into ~20 concurrent ones bottlenecked on the slowest page. When
    // expirationFilter is set the contract_count overestimates the slice
    // size, which is fine: the extra pages just come back empty and get
    // filtered out below.
    const PAGE_SIZE = 1000;
    const totalPages = Math.max(1, Math.ceil((run.contract_count || 0) / PAGE_SIZE));
    const pageResults = await Promise.all(
      Array.from({ length: totalPages }, (_, i) => {
        const offset = i * PAGE_SIZE;
        const end = offset + PAGE_SIZE - 1;
        return fetchWithTimeout(
          `${supabaseUrl}/rest/v1/snapshots?${snapParams}`,
          { headers: { ...headers, Range: `${offset}-${end}`, 'Range-Unit': 'items' } },
          'snapshots'
        );
      })
    );
    const contractRows = [];
    for (const pageRes of pageResults) {
      if (!pageRes.ok && pageRes.status !== 206) {
        throw new Error(`snapshots query failed: ${pageRes.status}`);
      }
      const page = await pageRes.json();
      if (Array.isArray(page) && page.length > 0) contractRows.push(...page);
    }

    const [levelsRows, expMetricsRows, prevCloseRows] = await Promise.all([
      levelsRes.json(),
      expMetricsRes.json(),
      prevCloseRes ? prevCloseRes.json() : Promise.resolve([]),
    ]);

    const prevClose = Array.isArray(prevCloseRows) && prevCloseRows.length > 0
      ? toNum(prevCloseRows[0].spot_price)
      : null;
    const prevTradingDate = Array.isArray(prevCloseRows) && prevCloseRows.length > 0
      ? prevCloseRows[0].trading_date
      : null;

    // Columnar encoding of the contracts array for wire transmission. SPX
    // runs hit ~19k contracts; the row-of-objects shape repeats the nine
    // JSON keys 19k times (~1.7 MB raw just for the keys) and pushes 15+
    // decimal places for IV / delta / gamma (vastly beyond the ~1e-3
    // precision the BSM model can actually resolve against the minimum
    // option-tick). Columnar strips the key repetition and lets gzip
    // exploit long identical runs in each per-field array; precision
    // trimming drops 10+ noise digits per numeric. Measured on a live
    // 18,878-contract SPX snapshot: 4.29 MB raw / 780 KB gzipped →
    // 917 KB raw / 265 KB gzipped (−515 KB gzipped, 66% saving) on the
    // wire. useOptionsData.js rehydrates this back into the row-of-
    // objects shape downstream consumers expect, so no component code
    // changed. `type` is 0=call / 1=put. `exp` indexes into the
    // top-level `expirations` array (unique sorted, derived below).
    const expirations = [...new Set(contractRows.map((c) => c.expiration_date).filter(Boolean))].sort();
    const expIndex = new Map(expirations.map((e, i) => [e, i]));
    const n = contractRows.length;
    const colExp = new Array(n);
    const colStrike = new Array(n);
    const colType = new Array(n);
    const colIv = new Array(n);
    const colDelta = new Array(n);
    const colGamma = new Array(n);
    const colOi = new Array(n);
    const colVol = new Array(n);
    const colPx = new Array(n);
    for (let i = 0; i < n; i++) {
      const c = contractRows[i];
      colExp[i] = expIndex.get(c.expiration_date) ?? -1;
      colStrike[i] = toNum(c.strike);
      colType[i] = c.contract_type === 'call' ? 0 : 1;
      const iv = toNum(c.implied_volatility);
      colIv[i] = iv == null ? null : roundTo(iv, 5);
      const d = toNum(c.delta);
      colDelta[i] = d == null ? null : roundTo(d, 5);
      const g = toNum(c.gamma);
      colGamma[i] = g == null ? null : toSigFig(g, 6);
      colOi[i] = c.open_interest;
      colVol[i] = c.volume;
      colPx[i] = toNum(c.close_price);
    }
    const contractCols = {
      exp: colExp,
      strike: colStrike,
      type: colType,
      iv: colIv,
      delta: colDelta,
      gamma: colGamma,
      oi: colOi,
      vol: colVol,
      px: colPx,
    };

    let dailyGex = null;
    if (dailyGexResolved?.ok) {
      const rows = await dailyGexResolved.json();
      if (Array.isArray(rows) && rows.length > 0) dailyGex = rows[0];
    }
    let gammaIndex = null;
    let gammaIndexDate = null;
    if (dailyGex) {
      const cg = toNum(dailyGex.call_gex);
      const pg = toNum(dailyGex.put_gex);
      const acg = toNum(dailyGex.atm_call_gex);
      const apg = toNum(dailyGex.atm_put_gex);
      const acc = dailyGex.atm_contract_count != null ? Number(dailyGex.atm_contract_count) : 0;
      const cc = dailyGex.contract_count != null ? Number(dailyGex.contract_count) : 0;
      // Prefer the ATM-focused ratio (|delta| in [0.40, 0.60]) when the
      // backfill has populated it. Fall back to the whole-chain version for
      // rows pre-backfill so the Levels Panel cell stays populated during
      // the 9h backfill window.
      if (acg != null && apg != null && (acg + apg) > 0 && acc >= 50) {
        gammaIndex = Math.round(((acg - apg) / (acg + apg)) * 10 * 1000) / 1000;
        gammaIndexDate = dailyGex.trading_date;
      } else if (cg != null && pg != null && (cg + pg) > 0 && cc >= 1000) {
        gammaIndex = Math.round(((cg - pg) / (cg + pg)) * 10 * 1000) / 1000;
        gammaIndexDate = dailyGex.trading_date;
      }
    }

    const levels = levelsRows.length > 0
      ? {
          call_wall: toNum(levelsRows[0].call_wall_strike),
          put_wall: toNum(levelsRows[0].put_wall_strike),
          volatility_flip: toNum(levelsRows[0].volatility_flip),
          put_call_ratio_oi: toNum(levelsRows[0].put_call_ratio_oi),
          put_call_ratio_volume: toNum(levelsRows[0].put_call_ratio_volume),
          total_call_volume: levelsRows[0].total_call_volume,
          total_put_volume: levelsRows[0].total_put_volume,
          gamma_index: gammaIndex,
          gamma_index_date: gammaIndexDate,
        }
      : null;

    const expirationMetrics = expMetricsRows.map((m) => ({
      expiration_date: m.expiration_date,
      atm_iv: toNum(m.atm_iv),
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

    const payload = {
      underlying: run.underlying,
      spotPrice: toNum(run.spot_price),
      prevClose,
      prevTradingDate,
      capturedAt: run.captured_at,
      tradingDate: run.trading_date,
      snapshotType: run.snapshot_type,
      source: run.source,
      expirations,
      selectedExpiration: expirationFilter || null,
      // Wire version sentinel. Client's useOptionsData checks this and
      // rehydrates contractCols into the `contracts` row-of-objects shape
      // downstream consumers expect. Bump if the columnar schema changes
      // in a way that isn't a superset of v2.
      contractsV: 2,
      contractCols,
      levels,
      expirationMetrics,
      cloudBands,
      cloudBandsTradingDate,
    };

    // Today's live run changes every ~5 minutes; serve with a short TTL
    // plus a longer SWR so a warm edge responds instantly. Prior-day runs
    // are frozen — once a run's trading_date is in the past, the payload
    // won't change, so the edge can hold it for an hour without any
    // staleness risk.
    const isFrozen = Boolean(tradingDate);
    const cacheControl = isFrozen
      ? 'public, max-age=3600, stale-while-revalidate=86400'
      : 'public, max-age=60, stale-while-revalidate=300';

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': cacheControl,
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

// Round to N decimal places. Used for IV (5dp → resolution of 1e-5, well
// below BSM model error against the minimum option-tick) and delta (5dp →
// same resolution, matches the natural precision of the underlying
// numerical solver). Returns a primitive Number rather than a string so
// JSON.stringify doesn't wrap it in quotes and doesn't re-introduce trailing
// zeros we just stripped.
function roundTo(value, decimals) {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

// Keep N significant figures regardless of magnitude. Used for gamma
// because its magnitude ranges from ~1e-7 (deep OTM) to ~1e-2 (near-ATM
// 0DTE), and a fixed-decimal rounding would either destroy the near-spot
// resolution or waste bytes on deep-OTM noise. +Number(x.toPrecision(N))
// coerces the scientific-notation string back to a primitive number whose
// JSON serialization uses the shortest round-trip representation.
function toSigFig(value, sig) {
  if (value === 0) return 0;
  return +value.toPrecision(sig);
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
