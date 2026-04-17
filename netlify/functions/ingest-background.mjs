// netlify/functions/ingest-background.mjs
// Background worker that fetches the SPX options chain from Massive API,
// computes GEX / levels / expiration metrics, and writes to Supabase.
//
// Replaces the n8n Cloud ingest workflow ($144/mo). Invoked either by
// `ingest.mjs` (cron trigger with market-hours gate) or manually via HTTP
// for calibration testing. The `-background` suffix gives this function
// Netlify's 15-minute execution ceiling instead of the 26s synchronous cap.
//
// Auth: requires INGEST_SECRET in the `x-ingest-secret` header. Prevents
// the `/api/*` redirect from exposing this to the public internet.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
// Service role key is required for writes — RLS blocks anon inserts on
// ingest_runs / snapshots / computed_levels / expiration_metrics. Falls back
// to anon if the service key is not configured so reads still work, but all
// write paths will 401 in that state.
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || SUPABASE_KEY;
const MASSIVE_API_KEY = process.env.MASSIVE_API_KEY;
const INGEST_SECRET = process.env.INGEST_SECRET;

const RISK_FREE_RATE = 0.045;
const DIVIDEND_YIELD = 0.0;
// Pagination ceiling for the unfiltered Massive fetch. SPX has ~30-40k raw
// contracts across all listed expirations; at 250/page that's ~120-160 pages.
// 300 gives comfortable headroom for calibration runs without risking the
// 15-minute background function cap (300 pages * ~0.4s/page ≈ 2 min).
const MAX_PAGES = 300;
const PAGE_DELAY_MS = 200;
const SNAPSHOT_BATCH_SIZE = 1000;
const FETCH_TIMEOUT_MS = 15000;

// Hardcoded US market holidays through 2028. Mirrors the n8n workflow.
const US_MARKET_HOLIDAYS = new Set([
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
  '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31',
  '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
  '2028-01-17', '2028-02-21', '2028-04-14', '2028-05-29', '2028-06-19',
  '2028-07-04', '2028-09-04', '2028-11-23', '2028-12-25',
]);

const INDEX_TICKERS = new Set(['SPX', 'NDX', 'RUT', 'VIX', 'DJX']);

export default async function handler(request) {
  const startedAt = Date.now();

  if (request.headers.get('x-ingest-secret') !== INGEST_SECRET) {
    return new Response('unauthorized', { status: 401 });
  }

  if (!SUPABASE_URL || !SUPABASE_KEY || !MASSIVE_API_KEY) {
    console.error('[ingest] missing env vars');
    return new Response('misconfigured', { status: 500 });
  }

  const url = new URL(request.url);
  const underlying = url.searchParams.get('underlying') || 'SPX';

  console.log(`[ingest] starting ${underlying} ingest`);

  try {
    // Phase 1 — Compute targets
    const phase1Start = Date.now();
    const targets = computeTargets(underlying);
    console.log(
      `[ingest] phase1 targets: ${targets.targetExpirations.join(', ')} ` +
      `(${Date.now() - phase1Start}ms)`
    );

    // Phase 2 — Fetch from Massive API
    const phase2Start = Date.now();
    const { pages, pagesFetched, partial } = await fetchChain(targets.fetchUrl);
    const rawContractCount = pages.reduce(
      (sum, p) => sum + (Array.isArray(p.results) ? p.results.length : 0),
      0
    );
    console.log(
      `[ingest] phase2 fetch: ${pagesFetched} pages, ${rawContractCount} raw contracts ` +
      `(${Date.now() - phase2Start}ms)${partial ? ' [PARTIAL]' : ''}`
    );

    // Phase 3 — Compute GEX
    const phase3Start = Date.now();
    const computed = computeGex(pages, targets, startedAt, partial);
    if (!computed) {
      console.error('[ingest] phase3 compute returned null (no contracts or no spot)');
      await insertErrorRun(targets, startedAt, 'no contracts or no spot price');
      return new Response('no data', { status: 502 });
    }
    console.log(
      `[ingest] phase3 compute: ${computed.contracts.length} contracts, ` +
      `${computed.expirationMetrics.length} expirations, spot=${computed.run.spot_price} ` +
      `(${Date.now() - phase3Start}ms)`
    );

    // Phase 4 — Insert to Supabase
    const phase4Start = Date.now();
    await insertAll(computed);
    console.log(
      `[ingest] phase4 inserts complete (${Date.now() - phase4Start}ms)`
    );

    const totalMs = Date.now() - startedAt;
    console.log(`[ingest] done in ${totalMs}ms`);
    return new Response(JSON.stringify({
      ok: true,
      duration_ms: totalMs,
      contract_count: computed.contracts.length,
      expiration_count: computed.expirationMetrics.length,
      pages_fetched: pagesFetched,
      status: computed.run.status,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    console.error('[ingest] fatal error:', err);
    try {
      await insertErrorRun(
        { underlying, capturedAtIso: new Date().toISOString(), tradingDate: tradingDateEt() },
        startedAt,
        err.message
      );
    } catch (logErr) {
      console.error('[ingest] failed to log error run:', logErr);
    }
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// -----------------------------------------------------------------------------
// Phase 1 — target computation
// -----------------------------------------------------------------------------

function computeTargets(underlying) {
  const apiTicker = INDEX_TICKERS.has(underlying) ? `I:${underlying}` : underlying;
  const capturedAtDate = new Date();
  const capturedAtIso = capturedAtDate.toISOString();
  const tradingDate = tradingDateEt(capturedAtDate);

  const todayEt = new Date(tradingDate + 'T12:00:00Z');
  const monthlies = new Set();
  let nextMonthly = thirdFriday(todayEt.getUTCFullYear(), todayEt.getUTCMonth());
  if (nextMonthly <= todayEt) {
    nextMonthly = thirdFriday(todayEt.getUTCFullYear(), todayEt.getUTCMonth() + 1);
  }
  for (let i = 0; i < 9; i++) {
    monthlies.add(adjustForHoliday(ymd(nextMonthly)));
    nextMonthly = thirdFriday(nextMonthly.getUTCFullYear(), nextMonthly.getUTCMonth() + 1);
  }

  // Weeklies: any expiration date within the next 30 days is accepted so the
  // near-term gamma (where 0-30 DTE dominates the curve) makes it into the
  // profile. SPX lists M/T/W/Th/F weeklies, so an explicit weekday enumeration
  // would be fragile — we take the cutoff-date approach instead and let the
  // post-fetch filter in computeGex discover whatever the chain actually has.
  const weeklyCutoffDate = new Date(todayEt.getTime() + 30 * 86400000);
  const weeklyCutoff = ymd(weeklyCutoffDate);

  const monthlyList = [...monthlies].sort();
  const targetExpirations = monthlyList;

  // Unfiltered fetch: picks up the full chain. Post-fetch filter keeps every
  // contract whose expiration is either one of the 9 target monthlies or lies
  // at or before weeklyCutoff. The 12-month stress test (8 back-to-back runs,
  // all stable at 46-50s each) confirmed the unfiltered fetch is the bottleneck,
  // not the post-fetch filter — adding weeklies just pulls more rows through
  // the insert path without touching the pagination footprint.
  const fetchUrl = `https://api.massive.com/v3/snapshot/options/${apiTicker}?limit=250`;

  return {
    underlying,
    apiTicker,
    capturedAtIso,
    capturedAtMs: capturedAtDate.getTime(),
    tradingDate,
    targetExpirations,
    monthlyExpirationsSet: new Set(monthlyList),
    weeklyCutoff,
    fetchUrl,
  };
}

function ymd(d) {
  return d.toISOString().split('T')[0];
}

function tradingDateEt(date = new Date()) {
  return date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function thirdFriday(year, month) {
  const first = new Date(Date.UTC(year, month, 1));
  const firstDow = first.getUTCDay();
  const firstFridayDate = 1 + ((5 - firstDow + 7) % 7);
  return new Date(Date.UTC(year, month, firstFridayDate + 14));
}

function adjustForHoliday(dateStr) {
  let d = new Date(dateStr + 'T12:00:00Z');
  for (let i = 0; i < 5; i++) {
    const s = ymd(d);
    if (!US_MARKET_HOLIDAYS.has(s)) return s;
    d = new Date(d.getTime() - 86400000);
  }
  return ymd(d);
}

// -----------------------------------------------------------------------------
// Phase 2 — paginated fetch from Massive API
// -----------------------------------------------------------------------------

async function fetchChain(startUrl) {
  const pages = [];
  let url = startUrl;
  let pagesFetched = 0;
  let partial = false;

  while (url && pagesFetched < MAX_PAGES) {
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${MASSIVE_API_KEY}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!res.ok) {
        console.error(`[ingest] massive API ${res.status} on page ${pagesFetched + 1}`);
        partial = true;
        break;
      }

      const body = await res.json();
      pages.push(body);
      pagesFetched += 1;

      if (body && body.next_url) {
        url = body.next_url;
        if (PAGE_DELAY_MS > 0) {
          await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
        }
      } else {
        break;
      }
    } catch (err) {
      console.error(`[ingest] fetch error on page ${pagesFetched + 1}: ${err.message}`);
      partial = true;
      break;
    }
  }

  if (pagesFetched >= MAX_PAGES) {
    console.warn(`[ingest] hit MAX_PAGES limit (${MAX_PAGES})`);
    partial = true;
  }

  return { pages, pagesFetched, partial };
}

// -----------------------------------------------------------------------------
// Phase 3 — GEX computation (ported from n8n Compute GEX node)
// -----------------------------------------------------------------------------

function computeGex(pages, targets, startedAt, partial) {
  const { underlying, capturedAtIso, capturedAtMs, tradingDate, monthlyExpirationsSet, weeklyCutoff } = targets;

  // Dedupe raw results on (expiration, strike, type). Massive/Polygon's
  // next_url pagination can return the same contract across overlapping
  // pages, which would violate the snapshots unique constraint on insert.
  //
  // On the 3rd Friday of a month, the SPX chain also contains two
  // distinct tickers at every (expiration, strike, type) tuple that
  // expires today:
  //
  //   - O:SPX…  — AM-settled monthly (legacy). Expires at 9:30 ET open
  //                via the SOQ. Once settled, Massive/Polygon keeps
  //                returning its row but with a stale close_price (a
  //                final settlement artifact or a last-trade value from
  //                a very different spot level) and stale IV / delta
  //                computed from that stale premium.
  //   - O:SPXW… — PM-settled weekly (modern). Expires at 16:00 ET close.
  //                Still trading intraday with live quotes.
  //
  // The dedup key only distinguishes (exp, strike, type), so before
  // this fix about half the 3rd-Friday 0DTE strikes won SPXW and half
  // won SPX depending on Massive's page order — producing a chain where
  // put close_prices alternated between plausible ($93) and implausible
  // ($444), ATM IV inverted to sub-1% on a chain whose true ATM was
  // ~15-18%, and the 25Δ call filter (delta in [0.15, 0.35]) came up
  // empty because AM-monthly deltas were near zero while the live SPXW
  // deltas were dropped. The divergence was observable to the minute:
  // pre-9:30 ET snapshots on 2026-04-17 showed atm_iv / put_25d_iv /
  // call_25d_iv all near 15%, and the moment the SPX monthly settled
  // via SOQ those three values fragmented into 0.2% / 60% / null.
  //
  // Flatten all pages first, sort so O:SPXW tickers come before O:SPX
  // (everything else sorts stably after), then keep the first occurrence
  // per dedup key. SPXW deterministically wins on the 3rd Friday and is
  // a pure no-op on every other day (either no collision exists, or
  // both contracts are pre-settlement and interchangeable).
  const flatResults = [];
  for (const body of pages) {
    if (!body || !Array.isArray(body.results)) continue;
    for (const r of body.results) flatResults.push(r);
  }
  flatResults.sort((a, b) => {
    const at = a?.details?.ticker || '';
    const bt = b?.details?.ticker || '';
    const ap = at.startsWith('O:SPXW') ? 0 : 1;
    const bp = bt.startsWith('O:SPXW') ? 0 : 1;
    return ap - bp;
  });

  const allRaw = [];
  const seenKeys = new Set();
  for (const r of flatResults) {
    if (r && r.details) {
      const key = `${r.details.expiration_date}|${r.details.strike_price}|${r.details.contract_type}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
    }
    allRaw.push(r);
  }

  if (allRaw.length === 0) return null;

  // Spot inference from the chain. Massive API stopped populating
  // underlying_asset.price for SPX index options (every contract returns
  // { ticker: "I:SPX" } with no price field), and the old "argmin |delta-0.5|
  // across allRaw" fallback picked up LEAPS whose delta-0.5 strike equals the
  // multi-year FORWARD price (S·exp((r-q+σ²/2)·τ)), not spot — which is why the
  // stored spot was wandering between 7000 and 9200 on a ~7025 underlying. We
  // now restrict to the shortest-DTE expiration that has at least five calls,
  // bracket delta = 0.5 between the two adjacent strikes, linearly interpolate
  // to find the K where delta would be exactly 0.5, then invert BS delta
  // (d1=0 ⇒ S = K·exp(-(r-q+σ²/2)·τ)) to strip out forward drift. For a
  // <10-DTE front expiration this leaves <$5 of residual error at SPX levels.
  const spotPrice = inferSpotFromChain(allRaw, capturedAtMs);
  if (!(spotPrice > 0)) return null;

  const contracts = allRaw
    .filter((r) => r.details && r.greeks && r.implied_volatility > 0.001)
    .filter((r) => {
      const exp = r.details.expiration_date;
      return monthlyExpirationsSet.has(exp) || exp <= weeklyCutoff;
    })
    .map((r) => ({
      expiration_date: r.details.expiration_date,
      strike: r.details.strike_price,
      contract_type: r.details.contract_type,
      implied_volatility: r.implied_volatility ?? null,
      delta: r.greeks.delta ?? null,
      gamma: r.greeks.gamma ?? null,
      theta: r.greeks.theta ?? null,
      vega: r.greeks.vega ?? null,
      open_interest: r.open_interest ?? 0,
      volume: r.day?.volume ?? 0,
      close_price: r.day?.close ?? null,
    }));

  // Per-strike GEX accumulation.
  const gexByStrike = {};
  for (const c of contracts) {
    const gex = c.gamma * c.open_interest * 100 * spotPrice * spotPrice * 0.01;
    if (!gexByStrike[c.strike]) gexByStrike[c.strike] = { callGex: 0, putGex: 0 };
    if (c.contract_type === 'call') gexByStrike[c.strike].callGex += gex;
    else gexByStrike[c.strike].putGex += gex;
  }

  const strikes = Object.keys(gexByStrike).map(Number).sort((a, b) => a - b);

  // Walls use signed net GEX so call and put walls can't collide at the same
  // strike. Abs gamma strike uses gross GEX.
  let callWallStrike = null, callWallNet = -Infinity;
  let putWallStrike = null, putWallNet = Infinity;
  let absGammaStrike = null, absGammaMax = 0;
  let netGammaNotional = 0;
  const netGexArray = [];

  for (const K of strikes) {
    const cg = gexByStrike[K].callGex;
    const pg = gexByStrike[K].putGex;
    const netGex = cg - pg;
    netGammaNotional += netGex;
    netGexArray.push({ strike: K, netGex });
    if (netGex > callWallNet) { callWallNet = netGex; callWallStrike = K; }
    if (netGex < putWallNet) { putWallNet = netGex; putWallStrike = K; }
    const absGex = cg + pg;
    if (absGex > absGammaMax) { absGammaMax = absGex; absGammaStrike = K; }
  }

  // Volatility flip = zero crossing of the Black-Scholes dealer gamma profile
  // computed by sweeping hypothetical spot across a ±15% window and summing
  // per-contract dollar gamma at every sample. See computeGammaProfile for the
  // derivation. Operating on the smooth profile instead of the raw per-strike
  // net GEX avoids the round-strike anchor pathology that made the previous
  // algorithm latch onto single-strike anomalies like the 6600/6605 boundary.
  const gammaProfile = computeGammaProfile(contracts, spotPrice, capturedAtMs);
  const volatilityFlip = findFlipFromProfile(gammaProfile);

  let totalCallGamma = 0, totalPutGamma = 0;
  for (const K of strikes) {
    totalCallGamma += gexByStrike[K].callGex;
    totalPutGamma += gexByStrike[K].putGex;
  }
  const gammaTilt = totalPutGamma > 0 ? totalCallGamma / totalPutGamma : null;

  let totalCallOi = 0, totalPutOi = 0, totalCallVolume = 0, totalPutVolume = 0;
  let netVannaNotional = 0, netCharmNotional = 0;
  for (const c of contracts) {
    const oi = c.open_interest || 0;
    const vol = c.volume || 0;
    const isCall = c.contract_type === 'call';
    if (isCall) { totalCallOi += oi; totalCallVolume += vol; }
    else { totalPutOi += oi; totalPutVolume += vol; }
    const tau = yearsToExpiration(c.expiration_date, capturedAtMs);
    const { vanna, charm } = bsVannaCharm(
      spotPrice, c.strike, tau, c.implied_volatility, RISK_FREE_RATE, DIVIDEND_YIELD, isCall
    );
    if (vanna != null) {
      const contrib = vanna * oi * 100 * spotPrice;
      netVannaNotional += isCall ? contrib : -contrib;
    }
    if (charm != null) {
      const contrib = charm * oi * 100 * spotPrice;
      netCharmNotional += isCall ? contrib : -contrib;
    }
  }

  const putCallRatioOi = totalCallOi > 0 ? totalPutOi / totalCallOi : null;
  const putCallRatioVolume = totalCallVolume > 0 ? totalPutVolume / totalCallVolume : null;
  const maxPainStrike = computeMaxPain(contracts);

  // Per-expiration metrics
  const contractsByExp = {};
  for (const c of contracts) {
    if (!contractsByExp[c.expiration_date]) contractsByExp[c.expiration_date] = [];
    contractsByExp[c.expiration_date].push(c);
  }

  const atmWindow = Math.max(spotPrice * 0.01, 5);
  const expirationMetrics = [];
  for (const exp of Object.keys(contractsByExp)) {
    const expContracts = contractsByExp[exp];
    const atmCandidates = expContracts
      .filter((c) => Math.abs(c.strike - spotPrice) <= atmWindow)
      .sort((a, b) => Math.abs(a.strike - spotPrice) - Math.abs(b.strike - spotPrice));
    const atmContract = atmCandidates.find((c) => c.contract_type === 'call') || atmCandidates[0] || null;
    const atmIv = atmContract ? atmContract.implied_volatility : null;
    const atmStrike = atmContract ? atmContract.strike : null;

    const call25d = expContracts
      .filter((c) => c.contract_type === 'call' && c.delta > 0.15 && c.delta < 0.35)
      .sort((a, b) => Math.abs(a.delta - 0.25) - Math.abs(b.delta - 0.25))[0];
    const put25d = expContracts
      .filter((c) => c.contract_type === 'put' && c.delta < -0.15 && c.delta > -0.35)
      .sort((a, b) => Math.abs(Math.abs(a.delta) - 0.25) - Math.abs(Math.abs(b.delta) - 0.25))[0];

    expirationMetrics.push({
      expiration_date: exp,
      atm_iv: atmIv,
      atm_strike: atmStrike,
      put_25d_iv: put25d ? put25d.implied_volatility : null,
      call_25d_iv: call25d ? call25d.implied_volatility : null,
      max_pain_strike: computeMaxPain(expContracts),
      contract_count: expContracts.length,
    });
  }

  const run = {
    underlying,
    captured_at: capturedAtIso,
    trading_date: tradingDate,
    snapshot_type: 'intraday',
    spot_price: spotPrice,
    contract_count: contracts.length,
    expiration_count: expirationMetrics.length,
    source: 'netlify',
    status: partial ? 'partial' : 'success',
    duration_ms: Date.now() - startedAt,
  };

  const computedLevels = {
    net_gamma_notional: round(netGammaNotional, 2),
    call_wall_strike: callWallStrike,
    put_wall_strike: putWallStrike,
    abs_gamma_strike: absGammaStrike,
    volatility_flip: volatilityFlip != null ? round(volatilityFlip, 2) : null,
    gamma_profile: gammaProfile,
    gamma_tilt: gammaTilt != null ? round(gammaTilt, 6) : null,
    max_pain_strike: maxPainStrike,
    put_call_ratio_oi: putCallRatioOi != null ? round(putCallRatioOi, 4) : null,
    put_call_ratio_volume: putCallRatioVolume != null ? round(putCallRatioVolume, 4) : null,
    total_call_oi: totalCallOi,
    total_put_oi: totalPutOi,
    total_call_volume: totalCallVolume,
    total_put_volume: totalPutVolume,
    net_vanna_notional: round(netVannaNotional, 2),
    net_charm_notional: round(netCharmNotional, 2),
  };

  return { run, contracts, computedLevels, expirationMetrics };
}

function round(n, decimals) {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}

function normPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

// Back out SPX spot from the nearest-DTE ATM call using Black-Scholes delta
// inversion. Call delta is monotone decreasing in strike at any fixed
// expiration, so the two adjacent listed strikes that bracket delta=0.5 pin
// down the exact K where delta would be 0.5 via linear interpolation. Setting
// d1=0 (the delta=0.5 condition) and solving gives
//   S = K·exp(-(r-q+σ²/2)·τ)
// with σ approximated by the ATM call's IV. Restricting to the shortest
// expiration keeps τ tiny (usually <0.03 years), so the drift correction is
// small and the result tracks the true index level to within a few dollars.
function inferSpotFromChain(allRaw, capturedAtMs) {
  const callsByExp = new Map();
  for (const r of allRaw) {
    if (r.details?.contract_type !== 'call') continue;
    if (typeof r.greeks?.delta !== 'number') continue;
    if (!(r.details.strike_price > 0)) continue;
    const exp = r.details.expiration_date;
    if (!exp) continue;
    if (!callsByExp.has(exp)) callsByExp.set(exp, []);
    callsByExp.get(exp).push({
      strike: r.details.strike_price,
      delta: r.greeks.delta,
      iv: typeof r.implied_volatility === 'number' && r.implied_volatility > 0
        ? r.implied_volatility
        : 0.15,
    });
  }
  if (callsByExp.size === 0) return null;

  const sortedExps = [...callsByExp.keys()].sort();
  let chosenExp = null;
  let chosenCalls = null;
  for (const exp of sortedExps) {
    const calls = callsByExp.get(exp);
    if (calls.length >= 5) { chosenExp = exp; chosenCalls = calls; break; }
  }
  if (!chosenCalls) return null;
  chosenCalls.sort((a, b) => a.strike - b.strike);

  let strikeAtHalfDelta = null;
  let atmIv = null;
  for (let i = 0; i < chosenCalls.length - 1; i++) {
    const a = chosenCalls[i];
    const b = chosenCalls[i + 1];
    if (a.delta >= 0.5 && b.delta <= 0.5) {
      const span = a.delta - b.delta;
      if (span > 0) {
        const t = (a.delta - 0.5) / span;
        strikeAtHalfDelta = a.strike + t * (b.strike - a.strike);
        atmIv = a.iv + t * (b.iv - a.iv);
        break;
      }
    }
  }
  if (strikeAtHalfDelta == null) {
    let best = chosenCalls[0];
    for (const c of chosenCalls) {
      if (Math.abs(c.delta - 0.5) < Math.abs(best.delta - 0.5)) best = c;
    }
    strikeAtHalfDelta = best.strike;
    atmIv = best.iv;
  }

  const tau = yearsToExpiration(chosenExp, capturedAtMs) || (1 / 365);
  const sigma = atmIv > 0 ? atmIv : 0.15;
  const drift = Math.exp(-(RISK_FREE_RATE - DIVIDEND_YIELD + 0.5 * sigma * sigma) * tau);
  return strikeAtHalfDelta * drift;
}

function yearsToExpiration(expirationIso, refMs) {
  if (!expirationIso) return null;
  const target = new Date(expirationIso + 'T20:00:00Z').getTime();
  if (Number.isNaN(target)) return null;
  const diffMs = target - refMs;
  if (diffMs <= 0) return 1 / 365;
  return diffMs / (365.25 * 24 * 3600 * 1000);
}

function bsVannaCharm(S, K, tau, sigma, r, q, isCall) {
  if (!(S > 0) || !(K > 0) || !(tau > 0) || !(sigma > 0)) {
    return { vanna: null, charm: null };
  }
  const sqrtTau = Math.sqrt(tau);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * tau) / (sigma * sqrtTau);
  const d2 = d1 - sigma * sqrtTau;
  const nPrimeD1 = normPdf(d1);
  const eMinusQTau = Math.exp(-q * tau);
  const vanna = -eMinusQTau * nPrimeD1 * (d2 / sigma);
  const charmCore = eMinusQTau * nPrimeD1 *
    ((2 * (r - q) * tau - d2 * sigma * sqrtTau) / (2 * tau * sigma * sqrtTau));
  return { vanna: vanna / 100, charm: (-charmCore) / 365 };
}

// Black-Scholes gamma, dΔ/dS. Pure analytic form — call and put share the same
// gamma so the contract type does not enter the formula; the dealer sign
// convention is applied by the caller.
function bsGamma(S, K, tau, sigma, r, q) {
  if (!(S > 0) || !(K > 0) || !(tau > 0) || !(sigma > 0)) return 0;
  const sqrtTau = Math.sqrt(tau);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * tau) / (sigma * sqrtTau);
  return Math.exp(-q * tau) * normPdf(d1) / (S * sigma * sqrtTau);
}

// Dealer gamma profile curve. For each hypothetical spot Ŝ in the sweep
// window we re-evaluate BS gamma for every contract holding (K, τ, σ, r, q)
// fixed at their observed values, then sum the dealer-signed dollar gamma per
// 1% move (calls long, puts short — the SpotGamma-style assumption the rest
// of the file already uses). Because BS gamma is continuous in S, the
// resulting curve is naturally smooth and has no dependence on arbitrary
// kernel widths — the zero crossing IS the structural regime boundary.
//
// Per-contract constants are hoisted out of the inner loop:
//   d1 = (ln(S) + D) * invB   where D = (r-q+σ²/2)·τ - ln(K), invB = 1/(σ√τ)
//   scale = exp(-q·τ) / (σ√τ) · OI · sign
//   term  = scale · φ(d1)
//   dealerGamma(Ŝ) = Ŝ · Σ term
//
// Sweep: [0.85·S, 1.15·S] in $5 steps → ~435 samples at current SPX levels,
// giving <$1 interpolation error on the zero crossing. Cost: ~5M BS evals on
// a 10k-contract chain ≈ 300ms in Node, absorbed in the ~48s ingest budget.
function computeGammaProfile(contracts, spotPrice, capturedAtMs) {
  if (!contracts || contracts.length === 0 || !(spotPrice > 0)) return null;

  const r = RISK_FREE_RATE;
  const q = DIVIDEND_YIELD;
  const INV_SQRT_2PI = 1 / Math.sqrt(2 * Math.PI);

  const prepared = [];
  for (const c of contracts) {
    const sigma = c.implied_volatility;
    const oi = c.open_interest || 0;
    if (!(sigma > 0) || oi <= 0 || !(c.strike > 0)) continue;
    const tau = yearsToExpiration(c.expiration_date, capturedAtMs);
    if (!(tau > 0)) continue;
    const sqrtTau = Math.sqrt(tau);
    const B = sigma * sqrtTau;
    const invB = 1 / B;
    const D = (r - q + 0.5 * sigma * sigma) * tau - Math.log(c.strike);
    const sign = c.contract_type === 'call' ? 1 : -1;
    const scale = (Math.exp(-q * tau) / B) * oi * sign;
    prepared.push({ D, invB, scale });
  }

  if (prepared.length === 0) return null;

  const lo = spotPrice * 0.85;
  const hi = spotPrice * 1.15;
  const step = 5;
  const startS = Math.round(lo / step) * step;
  const endS = Math.round(hi / step) * step;

  const profile = [];
  for (let S = startS; S <= endS + 1e-9; S += step) {
    const lnS = Math.log(S);
    let innerSum = 0;
    for (let i = 0; i < prepared.length; i++) {
      const p = prepared[i];
      const d1 = (lnS + p.D) * p.invB;
      const phiD1 = INV_SQRT_2PI * Math.exp(-0.5 * d1 * d1);
      innerSum += p.scale * phiD1;
    }
    // dealerGamma(S) = S · Σ scale · φ(d1)
    profile.push({ s: S, g: Math.round(S * innerSum) });
  }

  return profile;
}

// Given a smooth profile, return the interpolated zero crossing that
// represents the structural regime boundary. A dealer gamma profile
// accumulates a large negative area below spot (dealer short gamma on
// short puts) and a large positive area above spot (dealer long gamma on
// long calls), separated by the volatility flip. Narrow tail oscillations
// — which arise when short-dated contracts at far-OTM strikes swap their
// per-strike gamma peaks as the hypothetical-spot sweep walks across their
// strike — can produce extra zero crossings with very steep instantaneous
// slopes but negligible cumulative mass. The previous "steepest slope"
// heuristic amplified that pathology rather than rejecting it: on
// 2026-04-15 run 210 the profile had a 250-billion oscillation between
// s=5975 and s=5985 whose slope was ~47 billion per dollar — two orders of
// magnitude steeper than the real crossing at 6894 whose slope was 0.54
// billion per dollar — so the flip latched onto the spurious tail
// oscillation at 5984 instead of the structural boundary. The correct
// heuristic is the crossing with the largest bilateral cumulative
// exposure: walk the profile once building the prefix sum of g, and among
// the zero crossings return the one where the prefix sum magnitude at the
// left neighbor is largest. At that crossing the left-side accumulated
// signed area is as extreme as possible, which by conservation means the
// right-side area is as extreme as possible in the opposite direction.
// Narrow oscillations contribute locally bounded prefix-sum swings that
// get dominated by the sustained regime area of the real boundary.
// Replaying this against the 120 persisted profiles from 2026-04-13 onward
// picks the same flip as the stored value on 117 runs and corrects three
// that the old heuristic had misrouted into the tails (run 210 from 5984
// to 6894, run 168 from 7988 to 6883, run 105 from 7987 to 6850).
function findFlipFromProfile(profile) {
  if (!profile || profile.length < 2) return null;

  const n = profile.length;
  const prefix = new Array(n);
  let running = 0;
  for (let i = 0; i < n; i++) {
    running += profile[i].g;
    prefix[i] = running;
  }

  let bestFlip = null;
  let bestScore = -Infinity;
  for (let i = 1; i < n; i++) {
    const prev = profile[i - 1];
    const curr = profile[i];
    if (Math.sign(prev.g) === Math.sign(curr.g)) continue;
    const score = Math.abs(prefix[i - 1]);
    if (score <= bestScore) continue;
    bestScore = score;
    const dg = curr.g - prev.g;
    if (dg === 0) {
      bestFlip = prev.s;
    } else {
      const t = -prev.g / dg;
      bestFlip = prev.s + t * (curr.s - prev.s);
    }
  }
  return bestFlip;
}

function computeMaxPain(contracts) {
  if (!contracts || contracts.length === 0) return null;
  const strikeSet = new Set();
  for (const c of contracts) strikeSet.add(c.strike);
  const strikes = [...strikeSet].sort((a, b) => a - b);
  let minPain = Infinity;
  let maxPainStrike = null;
  for (const candidate of strikes) {
    let totalPain = 0;
    for (const c of contracts) {
      const oi = c.open_interest || 0;
      if (oi === 0) continue;
      if (c.contract_type === 'call') {
        totalPain += Math.max(candidate - c.strike, 0) * oi * 100;
      } else {
        totalPain += Math.max(c.strike - candidate, 0) * oi * 100;
      }
    }
    if (totalPain < minPain) { minPain = totalPain; maxPainStrike = candidate; }
  }
  return maxPainStrike;
}

// -----------------------------------------------------------------------------
// Phase 4 — Supabase inserts
// -----------------------------------------------------------------------------

function supabaseHeaders(extra = {}) {
  // Use the service role key for writes so RLS does not reject inserts on
  // ingest_runs / snapshots / computed_levels / expiration_metrics.
  return {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function insertAll({ run, contracts, computedLevels, expirationMetrics }) {
  // 1. Insert run header, get back the id
  const runRes = await fetch(`${SUPABASE_URL}/rest/v1/ingest_runs`, {
    method: 'POST',
    headers: supabaseHeaders({ Prefer: 'return=representation' }),
    body: JSON.stringify([run]),
  });
  if (!runRes.ok) {
    const text = await runRes.text();
    throw new Error(`ingest_runs insert failed: ${runRes.status} ${text}`);
  }
  const runRows = await runRes.json();
  const runId = runRows[0]?.id;
  if (!runId) throw new Error('ingest_runs insert returned no id');

  // 2. Parallel: snapshots (batched), computed_levels, expiration_metrics
  await Promise.all([
    insertSnapshotsBatched(runId, contracts),
    insertComputedLevels(runId, computedLevels),
    insertExpirationMetrics(runId, expirationMetrics),
  ]);
}

async function insertSnapshotsBatched(runId, contracts) {
  for (let i = 0; i < contracts.length; i += SNAPSHOT_BATCH_SIZE) {
    const batch = contracts
      .slice(i, i + SNAPSHOT_BATCH_SIZE)
      .map((c) => ({ ...c, run_id: runId }));
    const res = await fetch(`${SUPABASE_URL}/rest/v1/snapshots`, {
      method: 'POST',
      headers: supabaseHeaders({ Prefer: 'return=minimal' }),
      body: JSON.stringify(batch),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `snapshots insert batch ${i / SNAPSHOT_BATCH_SIZE + 1} failed: ${res.status} ${text}`
      );
    }
  }
}

async function insertComputedLevels(runId, levels) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/computed_levels`, {
    method: 'POST',
    headers: supabaseHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify([{ ...levels, run_id: runId }]),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`computed_levels insert failed: ${res.status} ${text}`);
  }
}

async function insertExpirationMetrics(runId, metrics) {
  if (!metrics || metrics.length === 0) return;
  const rows = metrics.map((m) => ({ ...m, run_id: runId }));
  const res = await fetch(`${SUPABASE_URL}/rest/v1/expiration_metrics`, {
    method: 'POST',
    headers: supabaseHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`expiration_metrics insert failed: ${res.status} ${text}`);
  }
}

async function insertErrorRun(targets, startedAt, errMessage) {
  const errorRun = {
    underlying: targets.underlying,
    captured_at: targets.capturedAtIso || new Date().toISOString(),
    trading_date: targets.tradingDate || tradingDateEt(),
    snapshot_type: 'intraday',
    spot_price: null,
    contract_count: 0,
    expiration_count: 0,
    source: 'netlify',
    status: 'error',
    duration_ms: Date.now() - startedAt,
  };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/ingest_runs`, {
    method: 'POST',
    headers: supabaseHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify([errorRun]),
  });
  if (!res.ok) {
    console.error(
      `[ingest] failed to insert error run: ${res.status} ${errMessage}`
    );
  }
}
