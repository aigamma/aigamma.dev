// Thin PostgREST upsert helper for the backfill scripts. Writes
// daily_term_structure and daily_cloud_bands directly through REST;
// does NOT go through the reconcile_day_atomic stored procedure
// because that path expects a full Massive+Theta comparison payload
// that we don't have during a pure historical backfill.
//
// Writes use the service-role key so they bypass RLS. The frontend's
// anon key cannot reach these tables at all.

export function createBackfillWriter({ url, serviceKey, fetchImpl = fetch }) {
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates,return=minimal',
  };

  async function upsert(path, rows) {
    if (!rows || rows.length === 0) return 0;
    const res = await fetchImpl(`${url}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(rows),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`supabase POST ${path} failed: ${res.status} ${body.slice(0, 300)}`);
    }
    return rows.length;
  }

  async function upsertDailyTermStructure(tradingDate, atmRows) {
    const payload = atmRows.map((r) => ({
      trading_date: tradingDate,
      expiration_date: r.expiration_date,
      dte: r.dte,
      atm_iv: r.atm_iv,
      source: r.source ?? 'theta',
      percentile_rank: null,
    }));
    return upsert('/rest/v1/daily_term_structure', payload);
  }

  async function upsertDailyCloudBands(tradingDate, bandRows) {
    const payload = bandRows.map((b) => ({
      trading_date: tradingDate,
      dte: b.dte,
      iv_p10: b.iv_p10,
      iv_p30: b.iv_p30,
      iv_p50: b.iv_p50,
      iv_p70: b.iv_p70,
      iv_p90: b.iv_p90,
      sample_count: b.sample_count ?? 0,
    }));
    return upsert('/rest/v1/daily_cloud_bands', payload);
  }

  // SPX OHLC upsert for daily_volatility_stats. One row per trading date.
  // Keeps derived columns (hv_20d_yz, iv_30d_cm, vrp_spread, sample_count,
  // computed_at) untouched on existing rows because the compute-vol-stats
  // pass writes them separately against the same primary key.
  async function upsertDailyVolatilityOhlc(rows) {
    const payload = rows.map((r) => ({
      trading_date: r.trading_date,
      spx_open: r.spx_open,
      spx_high: r.spx_high,
      spx_low: r.spx_low,
      spx_close: r.spx_close,
    }));
    return upsert('/rest/v1/daily_volatility_stats', payload);
  }

  // Derived-scalar upsert for daily_volatility_stats. Writes HV, 30d CM IV,
  // VRP spread, and sample count against the same trading_date primary key
  // so it merges onto the OHLC row written by upsertDailyVolatilityOhlc.
  async function upsertDailyVolatilityDerived(rows) {
    const payload = rows.map((r) => ({
      trading_date: r.trading_date,
      hv_20d_yz: r.hv_20d_yz,
      iv_30d_cm: r.iv_30d_cm,
      vrp_spread: r.vrp_spread,
      sample_count: r.sample_count ?? null,
      computed_at: new Date().toISOString(),
    }));
    return upsert('/rest/v1/daily_volatility_stats', payload);
  }

  // Pages through daily_volatility_stats the same way
  // getHistoricalTermStructure pages through daily_term_structure — a full
  // year of OHLC is only ~250 rows, so pagination is belt-and-suspenders,
  // but consistency with the rest of the writer wins over micro-tuning.
  async function getDailyVolatilityOhlc({ from, to }) {
    const PAGE_SIZE = 1000;
    const query = `select=trading_date,spx_open,spx_high,spx_low,spx_close&trading_date=gte.${from}&trading_date=lte.${to}&order=trading_date.asc`;
    const out = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const end = offset + PAGE_SIZE - 1;
      const res = await fetchImpl(
        `${url}/rest/v1/daily_volatility_stats?${query}`,
        { headers: { ...headers, Range: `${offset}-${end}`, 'Range-Unit': 'items' } },
      );
      if (!res.ok && res.status !== 206) {
        throw new Error(`supabase vol_stats window fetch HTTP ${res.status}`);
      }
      const page = await res.json();
      if (!Array.isArray(page) || page.length === 0) break;
      out.push(...page);
      if (page.length < PAGE_SIZE) break;
    }
    return out;
  }

  // Paginated for the same reason as getHistoricalTermStructure. On a
  // partially-populated resume the full table scan is ~10k rows; the
  // 1000-row PostgREST cap would otherwise truncate to the oldest
  // ~25 days and the writer would re-fetch everything past that.
  async function getExistingTermStructureDates() {
    const PAGE_SIZE = 1000;
    const set = new Set();
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const end = offset + PAGE_SIZE - 1;
      const res = await fetchImpl(
        `${url}/rest/v1/daily_term_structure?select=trading_date&order=trading_date.asc`,
        { headers: { ...headers, Range: `${offset}-${end}`, 'Range-Unit': 'items' } },
      );
      if (!res.ok && res.status !== 206) {
        throw new Error(`supabase list term_structure HTTP ${res.status}`);
      }
      const page = await res.json();
      if (!Array.isArray(page) || page.length === 0) break;
      for (const r of page) set.add(r.trading_date);
      if (page.length < PAGE_SIZE) break;
    }
    return set;
  }

  // Pages through daily_term_structure via Range headers because
  // PostgREST caps a single response at 1000 rows — a full year of
  // ~40 expirations × 252 days is ~10k rows, well past that cap, and
  // silently truncating on the oldest 25 days was masking band samples
  // for the newer trading dates in the first smoke run.
  async function getHistoricalTermStructure({ from, to }) {
    const PAGE_SIZE = 1000;
    const query = `select=trading_date,dte,atm_iv&trading_date=gte.${from}&trading_date=lt.${to}&source=eq.theta&order=trading_date.asc,dte.asc`;
    const out = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const end = offset + PAGE_SIZE - 1;
      const res = await fetchImpl(
        `${url}/rest/v1/daily_term_structure?${query}`,
        { headers: { ...headers, Range: `${offset}-${end}`, 'Range-Unit': 'items' } },
      );
      if (!res.ok && res.status !== 206) {
        throw new Error(`supabase window fetch HTTP ${res.status}`);
      }
      const page = await res.json();
      if (!Array.isArray(page) || page.length === 0) break;
      out.push(...page);
      if (page.length < PAGE_SIZE) break;
    }
    return out;
  }

  return {
    upsertDailyTermStructure,
    upsertDailyCloudBands,
    upsertDailyVolatilityOhlc,
    upsertDailyVolatilityDerived,
    getDailyVolatilityOhlc,
    getExistingTermStructureDates,
    getHistoricalTermStructure,
  };
}
