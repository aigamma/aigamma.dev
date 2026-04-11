import { useState, useEffect } from 'react';

export default function useHistoryData({ underlying = 'SPX', snapshotType = 'intraday', lookback = '24h', limit = 500 } = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchHistory() {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          underlying,
          snapshot_type: snapshotType,
          lookback,
          limit: String(limit),
        });
        const response = await fetch(`/api/history?${params}`);
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`API ${response.status}: ${text}`);
        }
        const json = await response.json();
        if (!cancelled) setData(json);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchHistory();
    return () => {
      cancelled = true;
    };
  }, [underlying, snapshotType, lookback, limit]);

  return { data, loading, error };
}
