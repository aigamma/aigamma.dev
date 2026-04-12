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
const MASSIVE_API_KEY = process.env.MASSIVE_API_KEY;
const INGEST_SECRET = process.env.INGEST_SECRET;

const RISK_FREE_RATE = 0.045;
const DIVIDEND_YIELD = 0.0;
const MAX_PAGES = 50;
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
  const targets = new Set();
  let nextMonthly = thirdFriday(todayEt.getUTCFullYear(), todayEt.getUTCMonth());
  if (nextMonthly <= todayEt) {
    nextMonthly = thirdFriday(todayEt.getUTCFullYear(), todayEt.getUTCMonth() + 1);
  }
  for (let i = 0; i < 6; i++) {
    targets.add(adjustForHoliday(ymd(nextMonthly)));
    nextMonthly = thirdFriday(nextMonthly.getUTCFullYear(), nextMonthly.getUTCMonth() + 1);
  }

  const targetExpirations = [...targets].sort();
  // Unfiltered fetch: picks up the full chain. Post-fetch filter keeps only
  // the 6 target monthlies. Proven stable in n8n run 19 (9103 contracts → 4957
  // after filter).
  const fetchUrl = `https://api.massive.com/v3/snapshot/options/${apiTicker}?limit=250`;

  return {
    underlying,
    apiTicker,
    capturedAtIso,
    capturedAtMs: capturedAtDate.getTime(),
    tradingDate,
    targetExpirations,
    targetExpirationsSet: new Set(targetExpirations),
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
  const { underlying, capturedAtIso, capturedAtMs, tradingDate, targetExpirationsSet } = targets;

  // Dedupe raw results on (expiration, strike, type). Massive/Polygon's
  // next_url pagination can return the same contract across overlapping
  // pages, which would violate the snapshots unique constraint on insert.
  const allRaw = [];
  const seenKeys = new Set();
  let spotPrice = null;

  for (const body of pages) {
    if (!body || !Array.isArray(body.results)) continue;
    for (const r of body.results) {
      if (r && r.details) {
        const key = `${r.details.expiration_date}|${r.details.strike_price}|${r.details.contract_type}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
      }
      allRaw.push(r);
    }
    if (!spotPrice) {
      for (const r of body.results) {
        if (r.underlying_asset && r.underlying_asset.price) {
          spotPrice = r.underlying_asset.price;
          break;
        }
      }
    }
  }

  // Fallback: infer spot from the ATM call (strike closest to delta 0.5).
  if (!spotPrice && allRaw.length > 0) {
    let closestDelta = Infinity;
    for (const r of allRaw) {
      if (
        r.details && r.details.contract_type === 'call' &&
        r.greeks && typeof r.greeks.delta === 'number'
      ) {
        const dist = Math.abs(r.greeks.delta - 0.5);
        if (dist < closestDelta) {
          closestDelta = dist;
          spotPrice = r.details.strike_price;
        }
      }
    }
  }

  if (allRaw.length === 0 || !spotPrice) return null;

  const contracts = allRaw
    .filter((r) => r.details && r.greeks && r.implied_volatility > 0.001)
    .filter((r) => targetExpirationsSet.has(r.details.expiration_date))
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

  // Volatility flip = sign-change boundary with the largest magnitude on
  // either side. Interpolates between the two strikes.
  let volatilityFlip = null;
  let maxBoundaryMagnitude = 0;
  for (let i = 1; i < netGexArray.length; i++) {
    const prev = netGexArray[i - 1];
    const curr = netGexArray[i];
    if ((prev.netGex > 0 && curr.netGex < 0) || (prev.netGex < 0 && curr.netGex > 0)) {
      const absPrev = Math.abs(prev.netGex);
      const absCurr = Math.abs(curr.netGex);
      const boundaryMagnitude = absPrev + absCurr;
      if (boundaryMagnitude > maxBoundaryMagnitude) {
        const ratio = absPrev / boundaryMagnitude;
        maxBoundaryMagnitude = boundaryMagnitude;
        volatilityFlip = prev.strike + ratio * (curr.strike - prev.strike);
      }
    }
  }

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
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
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
