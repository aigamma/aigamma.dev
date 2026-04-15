// Thin client around ThetaTerminal v3 REST. Only the endpoints the
// reconciler needs. All calls are local — http://127.0.0.1:25503.
// v2 endpoints return HTTP 410 on the current terminal build; v3 only.

const DEFAULT_BASE_URL = 'http://127.0.0.1:25503';

export function createThetaClient({ baseUrl = DEFAULT_BASE_URL, fetchImpl = fetch } = {}) {
  async function probe() {
    try {
      const res = await fetchImpl(`${baseUrl}/v3/system/mdds_status`, { method: 'GET' });
      return res.ok;
    } catch {
      return false;
    }
  }

  async function fetchEodGreeks({ root = 'SPX', date }) {
    const dateStr = date.replaceAll('-', '');
    const url = `${baseUrl}/v3/option/history/greeks/eod?root=${root}&exp=*&start_date=${dateStr}&end_date=${dateStr}`;
    const res = await fetchImpl(url, { method: 'GET' });
    if (!res.ok) {
      throw new Error(`theta eod fetch failed: ${res.status}`);
    }
    return res.json();
  }

  return { probe, fetchEodGreeks };
}
