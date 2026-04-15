// Thin wrapper around Supabase PostgREST for the reconciler. The daily
// transaction is a single RPC call to reconcile_day_atomic, because
// PostgREST cannot span a transaction across multiple REST calls and
// the per-day all-or-nothing guarantee is non-negotiable. See
// sql/reconcile_day_atomic.sql for the stored procedure contract.

export function createSupabaseClient({ url, serviceKey, fetchImpl = fetch }) {
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  };

  async function request(path, init = {}) {
    const res = await fetchImpl(`${url}${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers ?? {}) },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`supabase ${init.method ?? 'GET'} ${path} failed: ${res.status} ${body}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  async function findUnreconciledDays(throughDate) {
    return request(
      `/rest/v1/daily_levels?select=trading_date&reconciled=eq.false&trading_date=lte.${throughDate}&order=trading_date.asc`,
    );
  }

  async function getDay(tradingDate) {
    const rows = await request(
      `/rest/v1/daily_levels?select=*&trading_date=eq.${tradingDate}`,
    );
    return rows?.[0] ?? null;
  }

  async function getPriorReconciledDay(tradingDate) {
    const rows = await request(
      `/rest/v1/daily_levels?select=*&reconciled=eq.true&trading_date=lt.${tradingDate}&order=trading_date.desc&limit=1`,
    );
    return rows?.[0] ?? null;
  }

  async function getReconciledDaysAfter(tradingDate) {
    return request(
      `/rest/v1/daily_levels?select=*&reconciled=eq.true&trading_date=gt.${tradingDate}&order=trading_date.asc`,
    );
  }

  async function getTermStructure(tradingDate) {
    return request(
      `/rest/v1/daily_term_structure?select=*&trading_date=eq.${tradingDate}`,
    );
  }

  async function getHistoricalTermStructure({ from, to }) {
    return request(
      `/rest/v1/daily_term_structure?select=trading_date,dte,atm_iv&trading_date=gte.${from}&trading_date=lt.${to}&source=eq.theta`,
    );
  }

  async function reconcileDayAtomic(tradingDate, payload) {
    return request('/rest/v1/rpc/reconcile_day_atomic', {
      method: 'POST',
      body: JSON.stringify({ target_date: tradingDate, payload }),
    });
  }

  return {
    findUnreconciledDays,
    getDay,
    getPriorReconciledDay,
    getReconciledDaysAfter,
    getTermStructure,
    getHistoricalTermStructure,
    reconcileDayAtomic,
  };
}
