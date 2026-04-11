import { useState, useEffect } from 'react';

export default function useOptionsData({ underlying = 'SPX', snapshotType = 'intraday', expiration = null, tradingDate = null } = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchData() {
      setLoading(true);
      setError(null);

      try {
        const params = new URLSearchParams({ underlying, snapshot_type: snapshotType });
        if (expiration) params.set('expiration', expiration);
        if (tradingDate) params.set('date', tradingDate);

        const response = await fetch(`/api/data?${params}`);
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`API ${response.status}: ${text}`);
        }

        const json = await response.json();
        if (!cancelled) {
          setData(json);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.message);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    fetchData();
    return () => {
      cancelled = true;
    };
  }, [underlying, snapshotType, expiration, tradingDate]);

  return { data, loading, error };
}
