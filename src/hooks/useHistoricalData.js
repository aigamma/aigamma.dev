import { useEffect, useState } from 'react';

// Historical-data hooks backing the VRP and historical-levels charts. Each
// hook wraps a single `/api/*` reader endpoint and returns the standard
// `{ data, loading, error }` triple. Keeping the hook surface aligned with
// useOptionsData means consumers don't have to special-case history vs. live.
//
// The dashboard mounts several components (GammaIndexScatter,
// GammaIndexOscillator, DealerGammaRegime, SpxVolFlip) that independently
// call useGexHistory against overlapping URLs, and two components
// (VolatilityRiskPremium plus the VRP pill in App.jsx) that call
// useVrpHistory. Without a shared-request layer each component's useEffect
// fires its own fetch on mount and the browser doesn't dedupe same-URL
// in-flight requests, producing duplicate network calls that each drag
// hundreds of KB through the function → Supabase path. The sharedFetch
// helper below memoizes in-flight promises by URL for a short TTL so every
// concurrent caller shares the same Response, and the cached result
// survives for 60 s so re-mounts in the same session (tab visibility
// flips, expand/collapse of a card) don't re-fire.

const CACHE_TTL_MS = 60 * 1000;
const entries = new Map();

// Map of { url -> __apiBoot-key } for the history endpoints that the inline
// boot-script in index.html pre-fires during HTML parse. On the first
// sharedFetch call for one of these URLs we drain the booted promise so the
// hook skips the regular fetch, cutting ~50-200 ms off the cold-visit paint
// of the card that reads the endpoint (VolatilityRiskPremium and the VRP
// pill in LevelsPanel are both above-the-fold on typical viewports). Mirror
// the pattern in useOptionsData.js — the promise is consumed on first read,
// and any mismatch (URL param variant, refetch after failure) falls through
// to the regular fetch path.
const BOOT_PROMISE_URLS = {
  '/api/vrp-history': 'vrpHistory',
};

function consumeBootHistoryPromise(url) {
  if (typeof window === 'undefined') return null;
  const key = BOOT_PROMISE_URLS[url];
  if (!key) return null;
  const boot = window.__apiBoot;
  if (!boot) return null;
  const promise = boot[key];
  if (!promise) return null;
  boot[key] = null;
  return promise;
}

async function sharedFetch(url) {
  const now = Date.now();
  const cached = entries.get(url);
  if (cached && cached.expiresAt > now) return cached.promise;

  const booted = consumeBootHistoryPromise(url);
  const promise = booted
    ? booted.catch(async () => {
        // Boot fetch failed (network glitch, 5xx during deploy); fall
        // through to a fresh fetch so the hook still has a chance to
        // resolve rather than surfacing a boot-script error unrelated
        // to the hook's own retry semantics.
        const response = await fetch(url);
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`API ${response.status}: ${text}`);
        }
        return response.json();
      })
    : (async () => {
        const response = await fetch(url);
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`API ${response.status}: ${text}`);
        }
        return response.json();
      })();

  entries.set(url, { promise, expiresAt: now + CACHE_TTL_MS });
  // On error, evict immediately so a retry from any caller re-fires
  // instead of replaying the same failed promise for 60 s.
  promise.catch(() => {
    if (entries.get(url)?.promise === promise) entries.delete(url);
  });
  return promise;
}

function useHistory(endpoint, params) {
  const url = `${endpoint}${params ? `?${params}` : ''}`;
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    sharedFetch(url)
      .then((json) => {
        if (!cancelled) setData(json);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  return { data, loading, error };
}

export function useVrpHistory({ from = null, to = null } = {}) {
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  return useHistory('/api/vrp-history', params.toString());
}

export function useGexHistory({ from = null, to = null } = {}) {
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  return useHistory('/api/gex-history', params.toString());
}
