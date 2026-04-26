import { useEffect, useState } from 'react';

// Single-fetch hook for the /vix lab. Drains a boot promise stashed at
// window.__vixBoot when present (the lab's index.html fires the request
// before the React bundle parses, the same pattern /tactical/ uses for its
// today + vrpHistory boot promises) and falls back to a fresh fetch on
// pages that don't pre-boot. Every card on /vix consumes the same payload
// shape — { latest, series, spx, asOf, ... } — so this hook centralizes the
// transport and lets components stay pure-render.
export default function useVixData() {
  const [state, setState] = useState({ data: null, loading: true, error: null });

  useEffect(() => {
    let cancelled = false;
    const boot = typeof window !== 'undefined' ? window.__vixBoot : null;
    const promise = boot && boot.then
      ? boot
      : fetch('/api/vix-data').then((r) => {
          if (!r.ok) {
            return r.text().then((t) => {
              throw new Error(`vix-data ${r.status}: ${t.slice(0, 200)}`);
            });
          }
          return r.json();
        });

    promise
      .then((data) => {
        if (cancelled) return;
        setState({ data, loading: false, error: null });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({ data: null, loading: false, error: err.message });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
