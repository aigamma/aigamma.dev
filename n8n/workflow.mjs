import { workflow, node, trigger } from '@n8n/workflow-sdk';

const FETCH_AND_COMPUTE_JS = `
const MASSIVE_BASE = 'https://api.massive.com';
const UNDERLYING = $input.first().json.underlying;
const startedAt = Date.now();
const capturedAtDate = new Date();
const tradingDate = capturedAtDate.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const apiKey = '4bWOQKzd3I0WmTJzW39z0hF8K0Cls46O';

const RISK_FREE_RATE = 0.045;
const DIVIDEND_YIELD = 0.0;

function thirdFriday(year, month) {
  const first = new Date(Date.UTC(year, month, 1));
  const firstDow = first.getUTCDay();
  const firstFridayDate = 1 + ((5 - firstDow + 7) % 7);
  return new Date(Date.UTC(year, month, firstFridayDate + 14));
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
  if (!(S > 0) || !(K > 0) || !(tau > 0) || !(sigma > 0)) return { vanna: null, charm: null };
  const sqrtTau = Math.sqrt(tau);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * tau) / (sigma * sqrtTau);
  const d2 = d1 - sigma * sqrtTau;
  const nPrimeD1 = normPdf(d1);
  const eMinusQTau = Math.exp(-q * tau);
  const vanna = -eMinusQTau * nPrimeD1 * (d2 / sigma);
  const charmCore = eMinusQTau * nPrimeD1 * ((2 * (r - q) * tau - d2 * sigma * sqrtTau) / (2 * tau * sigma * sqrtTau));
  const charmCall = -charmCore;
  const charmPut = -charmCore;
  return {
    vanna: vanna / 100,
    charm: (isCall ? charmCall : charmPut) / 365,
  };
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
    if (totalPain < minPain) {
      minPain = totalPain;
      maxPainStrike = candidate;
    }
  }
  return maxPainStrike;
}

const todayET = new Date(tradingDate + 'T12:00:00Z');
const targets = new Set();

const dow = todayET.getUTCDay();
const daysToFriday = (5 - dow + 7) % 7;
const frontWeekly = new Date(todayET.getTime() + (daysToFriday || 7) * 86400000);
targets.add(frontWeekly.toISOString().split('T')[0]);

let monthly1 = thirdFriday(todayET.getUTCFullYear(), todayET.getUTCMonth());
if (monthly1 <= todayET) {
  monthly1 = thirdFriday(todayET.getUTCFullYear(), todayET.getUTCMonth() + 1);
}
targets.add(monthly1.toISOString().split('T')[0]);

const monthly2 = thirdFriday(monthly1.getUTCFullYear(), monthly1.getUTCMonth() + 1);
targets.add(monthly2.toISOString().split('T')[0]);

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
if (quarterly) targets.add(quarterly.toISOString().split('T')[0]);

const targetExpirations = [...targets].sort();

let allContracts = [];
let spotPrice = null;
const resolvedExpirations = [];

async function fetchExpiration(expStr) {
  let url = MASSIVE_BASE + '/v3/snapshot/options/' + UNDERLYING + '?apiKey=' + apiKey + '&limit=250&expiration_date=' + expStr;
  let fetched = 0;
  while (url) {
    const response = await this.helpers.httpRequest({ method: 'GET', url: url, json: true });
    if (response.results && response.results.length > 0) {
      allContracts = allContracts.concat(response.results);
      fetched += response.results.length;
      if (!spotPrice) {
        for (const r of response.results) {
          if (r.underlying_asset && r.underlying_asset.price) {
            spotPrice = r.underlying_asset.price;
            break;
          }
        }
      }
    }
    url = response.next_url ? response.next_url + '&apiKey=' + apiKey : null;
  }
  return fetched;
}

const boundFetch = fetchExpiration.bind(this);

for (const exp of targetExpirations) {
  const fetched = await boundFetch(exp);
  if (fetched > 0) {
    resolvedExpirations.push(exp);
    continue;
  }
  const target = new Date(exp + 'T12:00:00Z');
  let resolved = null;
  for (let back = 1; back <= 3; back++) {
    const cand = new Date(target.getTime() - back * 86400000);
    const candStr = cand.toISOString().split('T')[0];
    if (resolvedExpirations.indexOf(candStr) !== -1) continue;
    const got = await boundFetch(candStr);
    if (got > 0) { resolved = candStr; break; }
  }
  if (resolved) resolvedExpirations.push(resolved);
}

if (!spotPrice && allContracts.length > 0) {
  let closestDelta = Infinity;
  for (const r of allContracts) {
    if (r.details && r.details.contract_type === 'call' && r.greeks && typeof r.greeks.delta === 'number') {
      const dist = Math.abs(r.greeks.delta - 0.5);
      if (dist < closestDelta) {
        closestDelta = dist;
        spotPrice = r.details.strike_price;
      }
    }
  }
}

if (allContracts.length === 0 || !spotPrice) {
  return [];
}

const capturedAtMs = capturedAtDate.getTime();

const contracts = allContracts
  .filter(r => r.details && r.greeks && r.implied_volatility > 0.001)
  .map(r => {
    const exp = r.details.expiration_date;
    const strike = r.details.strike_price;
    const iv = r.implied_volatility;
    const isCall = r.details.contract_type === 'call';
    const tau = yearsToExpiration(exp, capturedAtMs);
    const { vanna, charm } = bsVannaCharm(spotPrice, strike, tau, iv, RISK_FREE_RATE, DIVIDEND_YIELD, isCall);
    return {
      expiration_date: exp,
      strike: strike,
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

let zeroGammaLevel = null;
let closestToSpot = Infinity;
for (let i = 1; i < netGexArray.length; i++) {
  const prev = netGexArray[i - 1];
  const curr = netGexArray[i];
  if ((prev.netGex > 0 && curr.netGex < 0) || (prev.netGex < 0 && curr.netGex > 0)) {
    const ratio = Math.abs(prev.netGex) / (Math.abs(prev.netGex) + Math.abs(curr.netGex));
    const crossing = prev.strike + ratio * (curr.strike - prev.strike);
    if (Math.abs(crossing - spotPrice) < closestToSpot) {
      closestToSpot = Math.abs(crossing - spotPrice);
      zeroGammaLevel = crossing;
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
  if (c.contract_type === 'call') {
    totalCallOi += oi;
    totalCallVolume += vol;
  } else {
    totalPutOi += oi;
    totalPutVolume += vol;
  }
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
    .filter(c => Math.abs(c.strike - spotPrice) <= atmWindow)
    .sort((a, b) => Math.abs(a.strike - spotPrice) - Math.abs(b.strike - spotPrice));
  const atmContract = atmCandidates.find(c => c.contract_type === 'call') || atmCandidates[0] || null;
  const atmIv = atmContract ? atmContract.implied_volatility : null;
  const atmStrike = atmContract ? atmContract.strike : null;

  const call25d = expContracts
    .filter(c => c.contract_type === 'call' && c.delta > 0.15 && c.delta < 0.35)
    .sort((a, b) => Math.abs(a.delta - 0.25) - Math.abs(b.delta - 0.25))[0];
  const put25d = expContracts
    .filter(c => c.contract_type === 'put' && c.delta < -0.15 && c.delta > -0.35)
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
  captured_at: capturedAtDate.toISOString(),
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
  zero_gamma_level: zeroGammaLevel != null ? Math.round(zeroGammaLevel * 100) / 100 : null,
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
return [{ json: { timestamp: now.toISOString(), etTime: etString, underlying: 'SPY', mode, bypass: !isScheduled } }];
`;

const SUPABASE_URL = 'https://tbxhvpoyyyhbvoyefggu.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRieGh2cG95eXloYnZveWVmZ2d1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3MDc4MzcsImV4cCI6MjA5MTI4MzgzN30.9yA9J5fvWHCiY1nEO8sEEQk7Ymsq6cYU_tRUP8vq0FI';

const supabaseHeadersRepresentation = {
  parameters: [
    { name: 'Content-Type', value: 'application/json' },
    { name: 'apikey', value: SUPABASE_ANON },
    { name: 'Authorization', value: 'Bearer ' + SUPABASE_ANON },
    { name: 'Prefer', value: 'return=representation' },
  ],
};

const supabaseHeadersMinimal = {
  parameters: [
    { name: 'Content-Type', value: 'application/json' },
    { name: 'apikey', value: SUPABASE_ANON },
    { name: 'Authorization', value: 'Bearer ' + SUPABASE_ANON },
    { name: 'Prefer', value: 'return=minimal' },
  ],
};

const scheduleTrigger = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.3,
  config: {
    name: 'Every 5 Minutes Market Hours',
    position: [-880, 120],
    parameters: {
      rule: {
        interval: [{ field: 'cronExpression', expression: '*/5 13-21 * * 1-5' }],
      },
    },
  },
  output: [{ timestamp: '2026-04-11T13:00:00.000Z' }],
});

const marketHoursFilter = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Market Hours Filter',
    position: [-660, 120],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: MARKET_HOURS_FILTER_JS,
    },
  },
  output: [{ timestamp: '2026-04-11T13:00:00.000Z', etTime: 'Apr 11 9:00 AM', underlying: 'SPY', mode: 'trigger', bypass: false }],
});

const fetchAndCompute = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Fetch Chain & Compute GEX',
    position: [-440, 120],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: FETCH_AND_COMPUTE_JS,
    },
  },
  output: [{
    run: {
      underlying: 'SPY',
      captured_at: '2026-04-11T13:00:00.000Z',
      trading_date: '2026-04-11',
      snapshot_type: 'intraday',
      spot_price: 675.0,
      contract_count: 1160,
      expiration_count: 3,
      source: 'massive',
      status: 'success',
      duration_ms: 12500,
    },
    contracts: [{ expiration_date: '2026-04-17', strike: 675, contract_type: 'call', implied_volatility: 0.147, delta: 0.5, gamma: 0.02, vanna: 0.001, charm: -0.0001, open_interest: 1000, volume: 500 }],
    computedLevels: {
      net_gamma_notional: -488800000,
      call_wall_strike: 685,
      put_wall_strike: 665,
      abs_gamma_strike: 670,
      zero_gamma_level: 675.72,
      gamma_tilt: 0.921,
      max_pain_strike: 670,
      put_call_ratio_oi: 1.15,
      put_call_ratio_volume: 0.95,
      total_call_oi: 500000,
      total_put_oi: 575000,
      total_call_volume: 100000,
      total_put_volume: 95000,
      net_vanna_notional: 12500000,
      net_charm_notional: -3200000,
    },
    expirationMetrics: [{ expiration_date: '2026-04-17', atm_iv: 0.147, atm_strike: 675, put_25d_iv: 0.17, call_25d_iv: 0.126, skew_25d_rr: -0.044, max_pain_strike: 670, contract_count: 450 }],
  }],
});

const insertRunHeader = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Insert Run Header',
    position: [-220, 120],
    parameters: {
      method: 'POST',
      url: SUPABASE_URL + '/rest/v1/ingest_runs',
      sendHeaders: true,
      specifyHeaders: 'keypair',
      headerParameters: supabaseHeadersRepresentation,
      sendBody: true,
      specifyBody: 'json',
      contentType: 'json',
      jsonBody: '={{ JSON.stringify([$json.run]) }}',
    },
  },
  output: [{ id: 9, underlying: 'SPY', captured_at: '2026-04-11T13:00:00.000Z' }],
});

const insertSnapshots = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Insert Snapshots',
    position: [0, 0],
    parameters: {
      method: 'POST',
      url: SUPABASE_URL + '/rest/v1/snapshots',
      sendHeaders: true,
      specifyHeaders: 'keypair',
      headerParameters: supabaseHeadersMinimal,
      sendBody: true,
      specifyBody: 'json',
      contentType: 'json',
      jsonBody: '={{ JSON.stringify($("Fetch Chain & Compute GEX").item.json.contracts.map(c => Object.assign({}, c, { run_id: $json.id }))) }}',
    },
  },
  output: [{}],
});

const insertComputedLevels = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Insert Computed Levels',
    position: [0, 240],
    parameters: {
      method: 'POST',
      url: SUPABASE_URL + '/rest/v1/computed_levels',
      sendHeaders: true,
      specifyHeaders: 'keypair',
      headerParameters: supabaseHeadersMinimal,
      sendBody: true,
      specifyBody: 'json',
      contentType: 'json',
      jsonBody: '={{ JSON.stringify([Object.assign({}, $("Fetch Chain & Compute GEX").item.json.computedLevels, { run_id: $json.id })]) }}',
    },
  },
  output: [{}],
});

const insertExpirationMetrics = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Insert Expiration Metrics',
    position: [0, 480],
    parameters: {
      method: 'POST',
      url: SUPABASE_URL + '/rest/v1/expiration_metrics',
      sendHeaders: true,
      specifyHeaders: 'keypair',
      headerParameters: supabaseHeadersMinimal,
      sendBody: true,
      specifyBody: 'json',
      contentType: 'json',
      jsonBody: '={{ JSON.stringify($("Fetch Chain & Compute GEX").item.json.expirationMetrics.map(m => Object.assign({}, m, { run_id: $json.id }))) }}',
    },
  },
  output: [{}],
});

export default workflow('4Zi5sMgglxspjh53', 'aigammadev')
  .add(scheduleTrigger)
  .to(marketHoursFilter)
  .to(fetchAndCompute)
  .to(insertRunHeader)
  .to(insertSnapshots)
  .add(insertRunHeader)
  .to(insertComputedLevels)
  .add(insertRunHeader)
  .to(insertExpirationMetrics);
