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
  // skip_contracts=1 omits the 19k-contract snapshots fetch and the
  // columnar contractCols field from the wire payload. The boot script in
  // index.html uses this for the prev-day fetch because only LevelsPanel /
  // overnight-alignment (both above-the-fold) need prev-day data on first
  // paint, and everything they need is in levels / expirationMetrics —
  // not in contracts. Below-the-fold diff features (GexProfile's prev-day
  // overlay, FixedStrikeIvMatrix's 1D-change mode) are fed by a separate
  // post-first-paint idle fetch in App.jsx that omits skip_contracts and
  // gets the full prev-day chain. Trims ~240 KB brotli off the boot
  // payload AND eliminates ~100-200 ms of snapshots-pagination time from
  // the prev-day function cold path. Both effects stack on the existing
  // Cache-Control: 1 h that prev-day responses already carry, so a
  // returning reader's browser cache serves this lite payload without
  // any edge touch.
  const skipContracts = url.searchParams.get('skip_contracts') === '1';

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
    // In prev-day mode, resolve the prior trading_date in one Supabase RTT
    // by fetching enough recent trading_date rows to reliably span two
    // distinct days. Intraday SPX ingest runs fire every 5 minutes during
    // market hours, so a single trading day carries ~80 runs (6.5 hours
    // × 12/hour); to guarantee the result set covers at least the latest
    // trading_date AND the one before, we fetch limit=200 which spans
    // 2.5 trading-days-worth. A linear scan finds the first row whose
    // trading_date is strictly less than the latest — same semantics as
    // the prior lt.{latest} second query, evaluated in JS on a ~3 KB
    // result set rather than as a separate PostgREST round-trip. Saves
    // ~15-40 ms on the prev-day cold path (the pre-existing 2-query
    // implementation was a "fetch latest, then lt. that" pair that
    // serialized naturally).
    if (wantPrevDay) {
      const prevResolveParams = new URLSearchParams({
        underlying: `eq.${underlying}`,
        snapshot_type: `eq.${snapshotType}`,
        order: 'trading_date.desc',
        limit: '200',
        select: 'trading_date',
      });
      const prevResolveRes = await fetchWithTimeout(
        `${supabaseUrl}/rest/v1/ingest_runs?${prevResolveParams}`,
        { headers },
        'prev_trading_date_resolve'
      );
      if (!prevResolveRes.ok) {
        throw new Error(`prev_trading_date_resolve query failed: ${prevResolveRes.status}`);
      }
      const prevResolveRows = await prevResolveRes.json();
      if (Array.isArray(prevResolveRows) && prevResolveRows.length > 0) {
        const latestDate = prevResolveRows[0]?.trading_date;
        for (const row of prevResolveRows) {
          if (row?.trading_date && row.trading_date < latestDate) {
            tradingDate = row.trading_date;
            break;
          }
        }
      }
      if (!tradingDate) {
        return jsonError(404, `No prior-day ${snapshotType} run found for ${underlying}`);
      }
    }

    // Pick the newest successful run that reports a non-zero contract_count,
    // pushed entirely into the PostgREST filter so we fetch exactly one row
    // instead of the prior limit=10 "fetch and client-side find()" pattern.
    // status=eq.success + contract_count=gt.0 narrows the server-side scan
    // to the healthy-rows-only subset, and limit=1 + order=captured_at.desc
    // collapses that to the single newest healthy run. Saves ~400 bytes of
    // wire (10 rows → 1 row) and removes the client-side fallback find()
    // scan. If no healthy run exists (only possible in the cold-start
    // window before the first ingest landed successfully, or during a
    // sustained outage), the query returns zero rows and we 404, which is
    // the same terminal state the old implementation would reach via its
    // fallback to runRows[0] followed by the downstream snapshots query
    // returning an empty chain.
    const runParams = new URLSearchParams({
      underlying: `eq.${underlying}`,
      snapshot_type: `eq.${snapshotType}`,
      status: 'eq.success',
      contract_count: 'gt.0',
      order: 'captured_at.desc',
      limit: '1',
      // Explicit projection skips error_message (TEXT, can hold a multi-kB
      // stack trace from a prior failed run) and created_at (unused on the
      // wire). Every remaining field feeds the final payload — status and
      // contract_count are filter-only so they're not in the projection.
      select:
        'id,captured_at,trading_date,underlying,snapshot_type,spot_price,contract_count,source',
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

    // Historically this was a paginated fetch: 19 parallel PostgREST
    // requests with Range: 0-999, 1000-1999, ... building a row-of-objects
    // contractRows array that was then transformed into columnar
    // contractCols via a JS loop on the function side. Replaced with a
    // single RPC call to get_contract_cols_v1(p_run_id) — a Postgres
    // function that runs the snapshots scan, dedups expirations via
    // row_number() window, LEFT JOINs each snapshot row to its expiration
    // index, and array_agg's the nine columns into a single JSONB result
    // that matches the shape the /api/data wire already ships. Eliminates
    // 18 of the 19 Supabase round-trips on the function cold path,
    // removes ~20-40 ms of JS columnar-build loop from the function,
    // and shrinks data.mjs by ~30 lines. See migration
    // add_get_contract_cols_rpc for the function body.
    // When expirationFilter is set (historically scaffolded for a UI
    // path that never shipped, and currently zero grep hits in src/),
    // fall through to the legacy paginated path because the RPC
    // function doesn't support per-expiration slicing — the path stays
    // in place as a defensive fallback but shouldn't fire in practice.
    const useRpcContracts = !skipContracts && !expirationFilter;
    const snapParams = new URLSearchParams({
      run_id: `eq.${run.id}`,
      select:
        'expiration_date,strike,contract_type,implied_volatility,delta,gamma,open_interest,close_price',
      order: 'expiration_date.asc,strike.asc',
    });
    if (expirationFilter) snapParams.set('expiration_date', `eq.${expirationFilter}`);

    // Prior-day responses (prev_day=1) drop three queries that the frontend
    // never reads from the prev-day payload: the prev-close lookup (App.jsx
    // reads prevClose / prevTradingDate only from today's payload, not from
    // the prior day's), the cloud-bands two-step (TermStructure.jsx is
    // passed today's cloudBands only — the prior day isn't rendered against
    // the same chart), and the daily-gex-stats snapshot that produces the
    // gamma_index field (LevelsPanel.jsx reads gamma_index from today's
    // levels only, again not from prev-day). Skipping them on prev_day
    // requests shaves three Supabase round-trips off the prior-day function
    // cold path (~50-150 ms of tail latency off the prev-day fetch) and
    // eliminates ~35 KB raw / ~5 KB gzipped of cloudBands payload on the
    // prev-day wire response that was going to be discarded client-side.
    const prevCloseParamsStr = (run.trading_date && !wantPrevDay)
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
    // overlay and renders the observed curve alone. Skipped on prev_day
    // fetches — only today's payload feeds TermStructure.
    const cloudBandsDateRes = (run.trading_date && !wantPrevDay)
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
    // Skipped on prev_day fetches — LevelsPanel reads gamma_index from
    // today's levels only, the prev-day payload's copy would be unused.
    const dailyGexRes = wantPrevDay
      ? Promise.resolve(null)
      : fetchWithTimeout(
          `${supabaseUrl}/rest/v1/daily_gex_stats?select=trading_date,call_gex,put_gex,atm_call_gex,atm_put_gex,atm_contract_count,contract_count&order=trading_date.desc&limit=1`,
          { headers },
          'daily_gex_stats_latest'
        );

    // Latest VIX and VIX3M EOD closes for the LevelsPanel Term Slope
    // (Contango / Backwardation) cell that fills the row-3 mobile gap to the
    // right of "25Δ Call IV". vix_family_eod is the same Massive-sourced
    // table /api/vix-data reads from; here we only need the two most recent
    // closes for VIX and VIX3M, ordered desc with limit 4 so a one-day-stale
    // row on either symbol still resolves to a valid pair after the JS
    // dedup. Skipped on prev_day fetches — the term-slope cell paints from
    // today's payload only, and EOD readings don't change intraday so a
    // historical-mode page never needs a different value than today's.
    const vixTermRes = wantPrevDay
      ? Promise.resolve(null)
      : fetchWithTimeout(
          `${supabaseUrl}/rest/v1/vix_family_eod?symbol=in.(VIX,VIX3M)&select=symbol,trading_date,close&order=trading_date.desc&limit=4`,
          { headers },
          'vix_term_structure'
        );

    const [levelsRes, expMetricsRes, prevCloseRes, cloudBandsDateResolved, dailyGexResolved, vixTermResolved] = await Promise.all([
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
      vixTermRes,
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

    // Contracts fetch path. Three branches:
    //
    //   1. skipContracts — prev-day boot path. No Supabase query, no
    //      columnar build. contractCols stays undefined in the payload;
    //      the client's rehydrator handles the absence.
    //
    //   2. useRpcContracts (default hot path) — one POST to the
    //      get_contract_cols_v1 RPC. Postgres returns the columnar JSONB
    //      (expirations + eight per-contract arrays with precision
    //      already trimmed server-side) in a single round-trip. Replaces
    //      what used to be 19 parallel paginated Range:0-999 fetches plus
    //      a JS columnar-build loop — saves 18 Supabase round-trips and
    //      ~20-40 ms of JS CPU per function invocation.
    //
    //   3. Legacy paginated fallback — only fires when expirationFilter
    //      is set (a URL-param path with zero grep hits in src/,
    //      historically scaffolded for a UI that never shipped). The
    //      RPC function doesn't support per-expiration slicing, so this
    //      branch stays for defensive compatibility.
    //
    // In all three branches the downstream payload construction reads
    // the same two locals: `expirations` (top-level array) and
    // `contractCols` (either populated or undefined).
    let expirations;
    let contractCols;
    let legacyContractRows = null;

    if (skipContracts) {
      // Branch 1: expirations come from expiration_metrics which is
      // already loaded in the parallel batch below.
      contractCols = undefined;
      expirations = undefined;  // filled in after expMetricsRows resolves
    } else if (useRpcContracts) {
      // Branch 2: single RPC call for contractCols.
      const rpcRes = await fetchWithTimeout(
        `${supabaseUrl}/rest/v1/rpc/get_contract_cols_v1`,
        {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ p_run_id: run.id }),
        },
        'get_contract_cols_v1'
      );
      if (!rpcRes.ok) {
        throw new Error(`get_contract_cols_v1 RPC failed: ${rpcRes.status}`);
      }
      const rpcJson = await rpcRes.json();
      expirations = Array.isArray(rpcJson?.expirations) ? rpcJson.expirations : [];
      const { expirations: _drop, ...cols } = rpcJson || {};
      contractCols = cols;
    } else {
      // Branch 3: paginated fallback for expirationFilter path.
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
      legacyContractRows = [];
      for (const pageRes of pageResults) {
        if (!pageRes.ok && pageRes.status !== 206) {
          throw new Error(`snapshots query failed: ${pageRes.status}`);
        }
        const page = await pageRes.json();
        if (Array.isArray(page) && page.length > 0) legacyContractRows.push(...page);
      }
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

    // Fill in expirations + columnar build for the branches that need it.
    if (skipContracts) {
      expirations = [...new Set(expMetricsRows.map((m) => m.expiration_date).filter(Boolean))].sort();
    } else if (!useRpcContracts) {
      // Legacy path: build columnar from row objects.
      expirations = [...new Set(legacyContractRows.map((c) => c.expiration_date).filter(Boolean))].sort();
      const expIndex = new Map(expirations.map((e, i) => [e, i]));
      const n = legacyContractRows.length;
      const colExp = new Array(n);
      const colStrike = new Array(n);
      const colType = new Array(n);
      const colIv = new Array(n);
      const colDelta = new Array(n);
      const colGamma = new Array(n);
      const colOi = new Array(n);
      const colPx = new Array(n);
      for (let i = 0; i < n; i++) {
        const c = legacyContractRows[i];
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
        colPx[i] = toNum(c.close_price);
      }
      contractCols = {
        exp: colExp,
        strike: colStrike,
        type: colType,
        iv: colIv,
        delta: colDelta,
        gamma: colGamma,
        oi: colOi,
        px: colPx,
      };
    }
    // For useRpcContracts branch, expirations + contractCols are already set above.

    let dailyGex = null;
    if (dailyGexResolved?.ok) {
      const rows = await dailyGexResolved.json();
      if (Array.isArray(rows) && rows.length > 0) dailyGex = rows[0];
    }

    // Pick the latest VIX row and the latest VIX3M row out of the up-to-4
    // rows the parallel query returned. Both symbols share a (trading_date,
    // symbol) primary key in vix_family_eod so each trading_date carries at
    // most one row per symbol; the desc-by-date + limit-4 query reliably
    // surfaces the two most recent rows for each. asOf reports the older of
    // the two dates so a stale-by-one-day reading is honestly labelled.
    let termStructure = null;
    if (vixTermResolved?.ok) {
      const rows = await vixTermResolved.json();
      if (Array.isArray(rows)) {
        let vix = null;
        let vix3m = null;
        for (const r of rows) {
          if (r.symbol === 'VIX' && !vix) vix = { close: toNum(r.close), date: r.trading_date };
          if (r.symbol === 'VIX3M' && !vix3m) vix3m = { close: toNum(r.close), date: r.trading_date };
          if (vix && vix3m) break;
        }
        if (vix?.close > 0 && vix3m?.close > 0) {
          termStructure = {
            vix: vix.close,
            vix3m: vix3m.close,
            ratio: vix3m.close / vix.close,
            asOf: vix.date < vix3m.date ? vix.date : vix3m.date,
          };
        }
      }
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
    // Percentile IVs carry ~15 decimal places of IEEE-754 float noise
    // coming out of PostgREST's JSON serialization of the underlying numeric
    // column (values like "iv_p90: 0.20269000000000004"); 5 decimal places
    // is resolution of 1e-5 = 0.001 IV points, two orders of magnitude
    // below the smoothing-window sampling noise on the underlying rolling-
    // percentile estimator. sample_count is dropped from the wire entirely
    // because no frontend consumer reads it — TermStructure.jsx only reads
    // dte and the five iv_p* fields. The filter upstream already guarantees
    // sample_count > 0 for every row that makes it into this array.
    const cloudBands = cloudBandsRows
      .filter((b) => b.sample_count > 0 && b.iv_p50 != null)
      .map((b) => ({
        dte: b.dte,
        iv_p10: roundTo(toNum(b.iv_p10), 5),
        iv_p30: roundTo(toNum(b.iv_p30), 5),
        iv_p50: roundTo(toNum(b.iv_p50), 5),
        iv_p70: roundTo(toNum(b.iv_p70), 5),
        iv_p90: roundTo(toNum(b.iv_p90), 5),
      }));

    // Top-level scalars pruned to the set App.jsx / useOptionsData.js / all
    // chart components actually consume: spotPrice, prevClose, capturedAt,
    // source, expirations, plus the contractsV / contractCols / levels /
    // expirationMetrics / cloudBands sub-objects below. Dropped fields
    // (underlying, snapshotType, tradingDate, prevTradingDate,
    // selectedExpiration) were grep-audited as zero-consumer in src/ —
    // tradingDate is re-derived client-side from capturedAt via
    // tradingDateFromCapturedAt, so shipping it was redundant with the
    // capturedAt timestamp already on the wire.
    // When skipContracts is set (prev-day boot path), omit contractsV
    // and contractCols entirely — the client rehydrator in useOptionsData
    // handles the absence and leaves payload.contracts undefined, which
    // above-fold consumers (LevelsPanel, overnight-alignment, VRP pill)
    // don't read for prev-day anyway. Below-fold diff charts that do
    // need prev-day contracts receive them from the post-paint idle
    // fetch in App.jsx, which requests the same URL without this flag
    // and gets a full payload.
    const payload = {
      spotPrice: toNum(run.spot_price),
      prevClose,
      capturedAt: run.captured_at,
      source: run.source,
      expirations,
      // Wire version sentinel. Client's useOptionsData checks this and
      // rehydrates contractCols into the `contracts` row-of-objects shape
      // downstream consumers expect. Bump if the columnar schema changes
      // in a way that isn't a superset of v2.
      ...(skipContracts ? {} : { contractsV: 2, contractCols }),
      levels,
      expirationMetrics,
      cloudBands,
      termStructure,
      // cloudBandsTradingDate was shipped here as a debug/provenance field
      // pointing at the source trading_date for the cloud-band overlay
      // (useful when the overlay falls back to yesterday's bands because
      // today's EOD reconcile hasn't run yet). Grep across src/ confirmed
      // no component reads it — TermStructure.jsx uses data.cloudBands
      // directly and derives its own x-axis anchor from data.capturedAt,
      // not from cloudBandsTradingDate. Dropped from the wire.
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
// zeros we just stripped. Preserves null so callers that pipe a possibly-
// null toNum result through don't accidentally coerce missing values to 0.
function roundTo(value, decimals) {
  if (value == null) return null;
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
