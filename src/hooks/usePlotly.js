import { useEffect, useState } from 'react';

let plotlyPromise = null;

function loadPlotly() {
  if (plotlyPromise) return plotlyPromise;
  if (typeof window === 'undefined') {
    return Promise.resolve({ plotly: null, error: null });
  }
  if (window.Plotly) {
    return Promise.resolve({ plotly: window.Plotly, error: null });
  }

  plotlyPromise = new Promise((resolve) => {
    const existing = document.querySelector('script[data-plotly-cdn]');
    if (existing) {
      existing.addEventListener('load', () =>
        resolve({ plotly: window.Plotly, error: null })
      );
      existing.addEventListener('error', () => {
        // Invalidate the cached promise so a subsequent mount can retry rather
        // than latching a one-time failure for the session lifetime.
        plotlyPromise = null;
        resolve({ plotly: null, error: 'Plotly CDN failed to load' });
      });
      return;
    }
    const script = document.createElement('script');
    // Self-hosted copy of plotly-cartesian-2.35.2.min.js (the cartesian
    // subset covers every trace type on the site — scatter/bar/heatmap/
    // histogram/box/pie — and ships ~447 KB gzipped vs ~1.33 MB for the
    // full plotly build, a ~890 KB first-visit saving). Hosting on the
    // same origin as everything else means: (1) no separate DNS lookup
    // or TLS handshake for cdn.plot.ly, so the first paint doesn't pay
    // that ~50-150 ms handshake latency; (2) the Netlify immutable
    // Cache-Control header from netlify.toml's `/vendor/*` rule applies,
    // so repeat visitors serve from disk cache without any edge touch;
    // (3) the HTTP/2 connection already open for /assets/* multiplexes
    // the Plotly download with the React bundle chunks, removing head-
    // of-line blocking entirely; (4) Chrome's 2020+ cache partitioning
    // means the shared-CDN-cache benefit of cdn.plot.ly is negligible
    // for most users anyway. File lives at public/vendor/ so Vite copies
    // it into dist/vendor/ during build. Keep in sync with the HTML
    // preload tag so the browser reuses the preload cache entry.
    script.src = '/vendor/plotly-cartesian-2.35.2.min.js';
    script.setAttribute('data-plotly-cdn', 'true');
    script.onload = () => resolve({ plotly: window.Plotly, error: null });
    script.onerror = () => {
      plotlyPromise = null;
      resolve({ plotly: null, error: 'Plotly CDN failed to load' });
    };
    document.head.appendChild(script);
  });
  return plotlyPromise;
}

export default function usePlotly() {
  const [state, setState] = useState(() => {
    if (typeof window !== 'undefined' && window.Plotly) {
      return { plotly: window.Plotly, error: null };
    }
    return { plotly: null, error: null };
  });

  useEffect(() => {
    if (state.plotly || state.error) return;
    let cancelled = false;
    loadPlotly().then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [state.plotly, state.error]);

  return state;
}
