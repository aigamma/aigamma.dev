import { useEffect, useState } from 'react';

// Historical-data hooks backing the VRP and historical-levels charts. Each
// hook wraps a single `/api/*` reader endpoint and returns the standard
// `{ data, loading, error }` triple. Keeping the hook surface aligned with
// useOptionsData means consumers don't have to special-case history vs. live.

export function useVrpHistory({ from = null, to = null } = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (from) params.set('from', from);
        if (to) params.set('to', to);
        const qs = params.toString();
        const response = await fetch(`/api/vrp-history${qs ? `?${qs}` : ''}`);
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

    run();
    return () => {
      cancelled = true;
    };
  }, [from, to]);

  return { data, loading, error };
}

export function useSpotFlipHistory({ from = null } = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (from) params.set('from', from);
        const qs = params.toString();
        const response = await fetch(`/api/spot-flip-history${qs ? `?${qs}` : ''}`);
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

    run();
    return () => {
      cancelled = true;
    };
  }, [from]);

  return { data, loading, error };
}

export function useGexHistory({ from = null, to = null } = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (from) params.set('from', from);
        if (to) params.set('to', to);
        const qs = params.toString();
        const response = await fetch(`/api/gex-history${qs ? `?${qs}` : ''}`);
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

    run();
    return () => {
      cancelled = true;
    };
  }, [from, to]);

  return { data, loading, error };
}

