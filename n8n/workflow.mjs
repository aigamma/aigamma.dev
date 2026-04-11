import { workflow, node, trigger, expr } from '@n8n/workflow-sdk';

const SUPABASE_URL = 'https://tbxhvpoyyyhbvoyefggu.supabase.co';
const SUPABASE_SERVICE_KEY = 'sb_secret_DVrk0RlntzDePeLzyFRLTA_eLHbtgeP';
const MASSIVE_API_KEY = '4bWOQKzd3I0WmTJzW39z0hF8K0Cls46O';

const MARKET_HOURS_FILTER_JS = `
const now = new Date();
const etString = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
const et = new Date(etString);
const day = et.getDay();
const hours = et.getHours();
const minutes = et.getMinutes();
const timeDecimal = hours + minutes / 60;
const mode = $execution && $execution.mode ? $execution.mode : 'trigger';
const isScheduled = mode === 'trigger' || mode === 'production';
if (isScheduled) {
  if (day === 0 || day === 6) return [];
  if (timeDecimal < 9.5 || timeDecimal > 16.25) return [];
}
return [{ json: { timestamp: now.toISOString(), etTime: etString, underlying: 'SPX', mode, bypass: !isScheduled } }];
`;

const COMPUTE_TARGETS_JS = `
const UNDERLYING = $input.first().json.underlying;
const INDEX_TICKERS = new Set(['SPX', 'NDX', 'RUT', 'VIX', 'DJX']);
const API_TICKER = INDEX_TICKERS.has(UNDERLYING) ? 'I:' + UNDERLYING : UNDERLYING;
const startedAt = Date.now();
const capturedAtDate = new Date();
const capturedAtIso = capturedAtDate.toISOString();
const tradingDate = capturedAtDate.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

const US_MARKET_HOLIDAYS = new Set([
  '2026-01-01','2026-01-19','2026-02-16','2026-04-03','2026-05-25','2026-06-19','2026-07-03','2026-09-07','2026-11-26','2026-12-25',
  '2027-01-01','2027-01-18','2027-02-15','2027-03-26','2027-05-31','2027-06-18','2027-07-05','2027-09-06','2027-11-25','2027-12-24',
  '2028-01-17','2028-02-21','2028-04-14','2028-05-29','2028-06-19','2028-07-04','2028-09-04','2028-11-23','2028-12-25'
]);

function ymd(d) { return d.toISOString().split('T')[0]; }

function adjustForHoliday(dateStr) {
  let d = new Date(dateStr + 'T12:00:00Z');
  for (let i = 0; i < 5; i++) {
    const s = ymd(d);
    if (!US_MARKET_HOLIDAYS.has(s)) return s;
    d = new Date(d.getTime() - 86400000);
  }
  return ymd(d);
}

function thirdFriday(year, month) {
  const first = new Date(Date.UTC(year, month, 1));
  const firstDow = first.getUTCDay();
  const firstFridayDate = 1 + ((5 - firstDow + 7) % 7);
  return new Date(Date.UTC(year, month, firstFridayDate + 14));
}

const todayET = new Date(tradingDate + 'T12:00:00Z');
const targets = new Set();

const dow = todayET.getUTCDay();
const daysToFriday = (5 - dow + 7) % 7;
const frontWeekly = new Date(todayET.getTime() + (daysToFriday || 7) * 86400000);
targets.add(adjustForHoliday(ymd(frontWeekly)));

let monthly1 = thirdFriday(todayET.getUTCFullYear(), todayET.getUTCMonth());
if (monthly1 <= todayET) {
  monthly1 = thirdFriday(todayET.getUTCFullYear(), todayET.getUTCMonth() + 1);
}
targets.add(adjustForHoliday(ymd(monthly1)));

const monthly2 = thirdFriday(monthly1.getUTCFullYear(), monthly1.getUTCMonth() + 1);
targets.add(adjustForHoliday(ymd(monthly2)));

const quarterlyMonths = new Set([2, 5, 8, 11]);
let quarterly = null;
for (let i = 1; i <= 12; i++) {
  const totalMonths = monthly2.getUTCMonth() + i;
  const y = monthly2.getUTCFullYear() + Math.floor(totalMonths / 12);
  const m = totalMonths % 12;
  if (quarterlyMonths.has(m)) {
    quarterly = thirdFriday(y, m);
    break;
  }
}
if (quarterly) targets.add(adjustForHoliday(ymd(quarterly)));

return [...targets].sort().map((exp) => ({
  json: {
    underlying: UNDERLYING,
    expiration: exp,
    captured_at: capturedAtIso,
    trading_date: tradingDate,
    started_at: startedAt,
    fetch_url: 'https://api.massive.com/v3/snapshot/options/' + API_TICKER + '?limit=250&expiration_date=' + exp,
  },
}));
`;

const FETCH_CHAIN_JS = `
const MASSIVE_API_KEY = '4bWOQKzd3I0WmTJzW39z0hF8K0Cls46O';
const MAX_PAGES_PER_EXPIRATION = 20;

const targets = $input.all();
const pages = [];

for (const targetItem of targets) {
  let url = targetItem.json.fetch_url;
  let pageCount = 0;
  while (url && pageCount < MAX_PAGES_PER_EXPIRATION) {
    const response = await this.helpers.httpRequest({
      method: 'GET',
      url: url,
      headers: {
        'Authorization': 'Bearer ' + MASSIVE_API_KEY,
      },
      json: true,
    });
    pages.push({ json: response });
    pageCount = pageCount + 1;
    if (response && response.next_url) {
      url = response.next_url;
    } else {
      break;
    }
  }
}

return pages;
`;

const COMPUTE_GEX_JS = `
const targetsNode = $('Compute Targets').all();
if (targetsNode.length === 0) return [];
const first = targetsNode[0].json;
const UNDERLYING = first.underlying;
const capturedAtIso = first.captured_at;
const tradingDate = first.trading_date;
const startedAt = first.started_at;
const capturedAtMs = new Date(capturedAtIso).getTime();

const RISK_FREE_RATE = 0.045;
const DIVIDEND_YIELD = 0.0;

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
  if (!(S > 0) || !(K > 0) || !(tau > 0) || !(sigma > 0)) return { vanna: null, charm: null };
  const sqrtTau = Math.sqrt(tau);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * tau) / (sigma * sqrtTau);
  const d2 = d1 - sigma * sqrtTau;
  const nPrimeD1 = normPdf(d1);
  const eMinusQTau = Math.exp(-q * tau);
  const vanna = -eMinusQTau * nPrimeD1 * (d2 / sigma);
  const charmCore = eMinusQTau * nPrimeD1 * ((2 * (r - q) * tau - d2 * sigma * sqrtTau) / (2 * tau * sigma * sqrtTau));
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

// Massive/Polygon next_url pagination can return the same contract across
// overlapping pages, so dedupe on (expiration, strike, type) as we build the
// raw contract list — otherwise the snapshots unique constraint
// (run_id, expiration_date, strike, contract_type) will reject the insert.
const pages = $input.all();
const allRaw = [];
const seenKeys = new Set();
let spotPrice = null;
for (const p of pages) {
  const body = p.json;
  if (body && Array.isArray(body.results)) {
    for (const r of body.results) {
      if (r && r.details) {
        const key = r.details.expiration_date + '|' + r.details.strike_price + '|' + r.details.contract_type;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
      }
      allRaw.push(r);
    }
    if (!spotPrice) {
      for (const r of body.results) {
        if (r.underlying_asset && r.underlying_asset.price) { spotPrice = r.underlying_asset.price; break; }
      }
    }
  }
}

if (!spotPrice && allRaw.length > 0) {
  let closestDelta = Infinity;
  for (const r of allRaw) {
    if (r.details && r.details.contract_type === 'call' && r.greeks && typeof r.greeks.delta === 'number') {
      const dist = Math.abs(r.greeks.delta - 0.5);
      if (dist < closestDelta) { closestDelta = dist; spotPrice = r.details.strike_price; }
    }
  }
}

if (allRaw.length === 0 || !spotPrice) return [];

const contracts = allRaw
  .filter((r) => r.details && r.greeks && r.implied_volatility > 0.001)
  .map((r) => {
    const exp = r.details.expiration_date;
    const strike = r.details.strike_price;
    const iv = r.implied_volatility;
    const isCall = r.details.contract_type === 'call';
    const tau = yearsToExpiration(exp, capturedAtMs);
    const { vanna, charm } = bsVannaCharm(spotPrice, strike, tau, iv, RISK_FREE_RATE, DIVIDEND_YIELD, isCall);
    return {
      expiration_date: exp,
      strike,
      contract_type: r.details.contract_type,
      implied_volatility: iv != null ? iv : null,
      delta: r.greeks.delta != null ? r.greeks.delta : null,
      gamma: r.greeks.gamma != null ? r.greeks.gamma : null,
      theta: r.greeks.theta != null ? r.greeks.theta : null,
      vega: r.greeks.vega != null ? r.greeks.vega : null,
      vanna: vanna != null ? Math.round(vanna * 1e8) / 1e8 : null,
      charm: charm != null ? Math.round(charm * 1e8) / 1e8 : null,
      open_interest: r.open_interest != null ? r.open_interest : 0,
      volume: (r.day && r.day.volume != null) ? r.day.volume : 0,
      close_price: (r.day && r.day.close != null) ? r.day.close : null,
    };
  });

const gexByStrike = {};
for (const c of contracts) {
  const K = c.strike;
  const gex = c.gamma * c.open_interest * 100 * spotPrice * spotPrice * 0.01;
  if (!gexByStrike[K]) gexByStrike[K] = { callGex: 0, putGex: 0 };
  if (c.contract_type === 'call') gexByStrike[K].callGex += gex;
  else gexByStrike[K].putGex += gex;
}

const strikes = Object.keys(gexByStrike).map(Number).sort((a, b) => a - b);
let callWallStrike = null, callWallGex = 0;
let putWallStrike = null, putWallGex = 0;
let absGammaStrike = null, absGammaMax = 0;
let netGammaNotional = 0;
const netGexArray = [];

for (const K of strikes) {
  const cg = gexByStrike[K].callGex;
  const pg = gexByStrike[K].putGex;
  const netGex = cg - pg;
  netGammaNotional += netGex;
  netGexArray.push({ strike: K, netGex });
  if (cg > callWallGex) { callWallGex = cg; callWallStrike = K; }
  if (pg > putWallGex) { putWallGex = pg; putWallStrike = K; }
  const absGex = cg + pg;
  if (absGex > absGammaMax) { absGammaMax = absGex; absGammaStrike = K; }
}

// Volatility flip = the net-GEX sign change bounded by the largest absolute
// values on either side. Picks the structurally dominant regime boundary
// instead of whichever zero-crossing happens to sit closest to spot.
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
for (const K of strikes) { totalCallGamma += gexByStrike[K].callGex; totalPutGamma += gexByStrike[K].putGex; }
const gammaTilt = totalPutGamma > 0 ? totalCallGamma / totalPutGamma : null;

let totalCallOi = 0, totalPutOi = 0, totalCallVolume = 0, totalPutVolume = 0;
let netVannaNotional = 0, netCharmNotional = 0;
for (const c of contracts) {
  const oi = c.open_interest || 0;
  const vol = c.volume || 0;
  if (c.contract_type === 'call') { totalCallOi += oi; totalCallVolume += vol; }
  else { totalPutOi += oi; totalPutVolume += vol; }
  if (c.vanna != null) {
    const vannaContrib = c.vanna * oi * 100 * spotPrice;
    netVannaNotional += c.contract_type === 'call' ? vannaContrib : -vannaContrib;
  }
  if (c.charm != null) {
    const charmContrib = c.charm * oi * 100 * spotPrice;
    netCharmNotional += c.contract_type === 'call' ? charmContrib : -charmContrib;
  }
}

const putCallRatioOi = totalCallOi > 0 ? totalPutOi / totalCallOi : null;
const putCallRatioVolume = totalCallVolume > 0 ? totalPutVolume / totalCallVolume : null;
const maxPainStrike = computeMaxPain(contracts);

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
  const put25dIv = put25d ? put25d.implied_volatility : null;
  const call25dIv = call25d ? call25d.implied_volatility : null;
  const skew25dRr = (call25dIv != null && put25dIv != null) ? call25dIv - put25dIv : null;
  const expMaxPain = computeMaxPain(expContracts);

  expirationMetrics.push({
    expiration_date: exp,
    atm_iv: atmIv,
    atm_strike: atmStrike,
    put_25d_iv: put25dIv,
    call_25d_iv: call25dIv,
    skew_25d_rr: skew25dRr,
    max_pain_strike: expMaxPain,
    contract_count: expContracts.length,
  });
}

const run = {
  underlying: UNDERLYING,
  captured_at: capturedAtIso,
  trading_date: tradingDate,
  snapshot_type: 'intraday',
  spot_price: spotPrice,
  contract_count: contracts.length,
  expiration_count: expirationMetrics.length,
  source: 'massive',
  status: 'success',
  duration_ms: Date.now() - startedAt,
};

const computedLevels = {
  net_gamma_notional: Math.round(netGammaNotional * 100) / 100,
  call_wall_strike: callWallStrike,
  put_wall_strike: putWallStrike,
  abs_gamma_strike: absGammaStrike,
  volatility_flip: volatilityFlip != null ? Math.round(volatilityFlip * 100) / 100 : null,
  gamma_tilt: gammaTilt != null ? Math.round(gammaTilt * 1000000) / 1000000 : null,
  max_pain_strike: maxPainStrike,
  put_call_ratio_oi: putCallRatioOi != null ? Math.round(putCallRatioOi * 10000) / 10000 : null,
  put_call_ratio_volume: putCallRatioVolume != null ? Math.round(putCallRatioVolume * 10000) / 10000 : null,
  total_call_oi: totalCallOi,
  total_put_oi: totalPutOi,
  total_call_volume: totalCallVolume,
  total_put_volume: totalPutVolume,
  net_vanna_notional: Math.round(netVannaNotional * 100) / 100,
  net_charm_notional: Math.round(netCharmNotional * 100) / 100,
};

return [{ json: { run, contracts, computedLevels, expirationMetrics } }];
`;

const SUPABASE_HEADERS = [
  { name: 'apikey', value: SUPABASE_SERVICE_KEY },
  { name: 'Authorization', value: 'Bearer ' + SUPABASE_SERVICE_KEY },
  { name: 'Content-Type', value: 'application/json' },
];

const scheduleTrigger = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.3,
  config: {
    name: 'Every 5 Minutes Market Hours',
    position: [-1100, 120],
    parameters: {
      rule: {
        interval: [{ field: 'cronExpression', expression: '*/5 13-21 * * 1-5' }],
      },
    },
  },
  output: [{ timestamp: '2026-04-13T13:00:00.000Z' }],
});

const marketHoursFilter = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Market Hours Filter',
    position: [-880, 120],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: MARKET_HOURS_FILTER_JS,
    },
  },
  output: [{ timestamp: '2026-04-13T13:00:00.000Z', etTime: 'Apr 13 9:00 AM', underlying: 'SPX', mode: 'trigger', bypass: false }],
});

const computeTargets = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Compute Targets',
    position: [-660, 120],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: COMPUTE_TARGETS_JS,
    },
  },
  output: [
    { underlying: 'SPX', expiration: '2026-04-17', captured_at: '2026-04-13T13:00:00.000Z', trading_date: '2026-04-13', started_at: 1744548000000, fetch_url: 'https://api.massive.com/v3/snapshot/options/I:SPX?limit=250&expiration_date=2026-04-17' },
    { underlying: 'SPX', expiration: '2026-05-15', captured_at: '2026-04-13T13:00:00.000Z', trading_date: '2026-04-13', started_at: 1744548000000, fetch_url: 'https://api.massive.com/v3/snapshot/options/I:SPX?limit=250&expiration_date=2026-05-15' },
    { underlying: 'SPX', expiration: '2026-06-18', captured_at: '2026-04-13T13:00:00.000Z', trading_date: '2026-04-13', started_at: 1744548000000, fetch_url: 'https://api.massive.com/v3/snapshot/options/I:SPX?limit=250&expiration_date=2026-06-18' },
  ],
});

const fetchChain = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Fetch Chain',
    position: [-440, 120],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: FETCH_CHAIN_JS,
    },
  },
  output: [
    { status: 'OK', request_id: 'abc', results: [{ details: { contract_type: 'call', strike_price: 6200, expiration_date: '2026-04-17' }, greeks: { delta: 0.5, gamma: 0.02, theta: -0.1, vega: 0.3 }, implied_volatility: 0.15, open_interest: 1000, day: { volume: 500, close: 3.5 } }], next_url: null },
  ],
});

const computeGex = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Compute GEX',
    position: [-220, 120],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: COMPUTE_GEX_JS,
    },
  },
  output: [
    {
      run: {
        underlying: 'SPX',
        captured_at: '2026-04-13T13:00:00.000Z',
        trading_date: '2026-04-13',
        snapshot_type: 'intraday',
        spot_price: 6200,
        contract_count: 2966,
        expiration_count: 3,
        source: 'massive',
        status: 'success',
        duration_ms: 12500,
      },
      contracts: [{ expiration_date: '2026-04-17', strike: 6200, contract_type: 'call', implied_volatility: 0.15, delta: 0.5, gamma: 0.02, vanna: 0.001, charm: -0.0001, open_interest: 1000, volume: 500 }],
      computedLevels: {
        net_gamma_notional: -488800000,
        call_wall_strike: 6300,
        put_wall_strike: 6100,
        abs_gamma_strike: 6200,
        volatility_flip: 6175.72,
        gamma_tilt: 0.921,
        max_pain_strike: 6195,
        put_call_ratio_oi: 1.2,
        put_call_ratio_volume: 1.1,
        total_call_oi: 500000,
        total_put_oi: 600000,
        total_call_volume: 100000,
        total_put_volume: 110000,
        net_vanna_notional: 1896872097.43,
        net_charm_notional: -1378026551.89,
      },
      expirationMetrics: [{ expiration_date: '2026-04-17', atm_iv: 0.15, atm_strike: 6200, put_25d_iv: 0.17, call_25d_iv: 0.13, skew_25d_rr: -0.04, max_pain_strike: 6195, contract_count: 1040 }],
    },
  ],
});

const insertRunHeader = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Insert Run Header',
    position: [0, 120],
    parameters: {
      method: 'POST',
      url: SUPABASE_URL + '/rest/v1/ingest_runs',
      authentication: 'none',
      sendHeaders: true,
      specifyHeaders: 'keypair',
      headerParameters: {
        parameters: [
          ...SUPABASE_HEADERS,
          { name: 'Prefer', value: 'return=representation' },
        ],
      },
      sendBody: true,
      specifyBody: 'json',
      contentType: 'json',
      jsonBody: expr('{{ JSON.stringify([$json.run]) }}'),
    },
  },
  output: [{ id: 15, underlying: 'SPX', captured_at: '2026-04-13T13:00:00.000Z' }],
});

const insertSnapshots = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Insert Snapshots',
    position: [220, 0],
    parameters: {
      method: 'POST',
      url: SUPABASE_URL + '/rest/v1/snapshots',
      authentication: 'none',
      sendHeaders: true,
      specifyHeaders: 'keypair',
      headerParameters: {
        parameters: [
          ...SUPABASE_HEADERS,
          { name: 'Prefer', value: 'return=minimal' },
        ],
      },
      sendBody: true,
      specifyBody: 'json',
      contentType: 'json',
      jsonBody: expr('{{ JSON.stringify($("Compute GEX").item.json.contracts.map(c => Object.assign({}, c, { run_id: $json.id }))) }}'),
    },
  },
  output: [{}],
});

const insertComputedLevels = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Insert Computed Levels',
    position: [220, 240],
    parameters: {
      method: 'POST',
      url: SUPABASE_URL + '/rest/v1/computed_levels',
      authentication: 'none',
      sendHeaders: true,
      specifyHeaders: 'keypair',
      headerParameters: {
        parameters: [
          ...SUPABASE_HEADERS,
          { name: 'Prefer', value: 'return=minimal' },
        ],
      },
      sendBody: true,
      specifyBody: 'json',
      contentType: 'json',
      jsonBody: expr('{{ JSON.stringify([Object.assign({}, $("Compute GEX").item.json.computedLevels, { run_id: $json.id })]) }}'),
    },
  },
  output: [{}],
});

const insertExpirationMetrics = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Insert Expiration Metrics',
    position: [220, 480],
    parameters: {
      method: 'POST',
      url: SUPABASE_URL + '/rest/v1/expiration_metrics',
      authentication: 'none',
      sendHeaders: true,
      specifyHeaders: 'keypair',
      headerParameters: {
        parameters: [
          ...SUPABASE_HEADERS,
          { name: 'Prefer', value: 'return=minimal' },
        ],
      },
      sendBody: true,
      specifyBody: 'json',
      contentType: 'json',
      jsonBody: expr('{{ JSON.stringify($("Compute GEX").item.json.expirationMetrics.map(m => Object.assign({}, m, { run_id: $json.id }))) }}'),
    },
  },
  output: [{}],
});

export default workflow('4Zi5sMgglxspjh53', 'aigammadev')
  .add(scheduleTrigger)
  .to(marketHoursFilter)
  .to(computeTargets)
  .to(fetchChain)
  .to(computeGex)
  .to(insertRunHeader)
  .to(insertSnapshots)
  .add(insertRunHeader)
  .to(insertComputedLevels)
  .add(insertRunHeader)
  .to(insertExpirationMetrics);
