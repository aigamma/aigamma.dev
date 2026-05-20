// aigamma.com client-side analytics beacon. Same shape as
// worldthought.com's beacon: cookieless, no fingerprinting, fire once
// per page mount, fail silently on network errors. Universally wired
// in src/ErrorBoundary.jsx (which wraps every per-page App) so adding
// a new page does not require remembering to wire the tracker.

const TRACK_ENDPOINT = '/api/track';

let lastTrack = '';

function post(payload) {
  try {
    const body = JSON.stringify(payload);
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const blob = new Blob([body], { type: 'application/json' });
      navigator.sendBeacon(TRACK_ENDPOINT, blob);
      return;
    }
    fetch(TRACK_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Analytics dropping silently is the correct behavior; a thrown
    // exception during page mount would not be.
  }
}

export function trackView() {
  if (typeof window === 'undefined') return;
  const path = window.location.pathname;
  const key = path + '|' + Math.floor(Date.now() / 1000);
  if (lastTrack === key) return;
  lastTrack = key;
  post({
    path,
    event: 'view',
    ref: typeof document !== 'undefined' ? document.referrer || null : null,
  });
}

export function trackComparePair(a, b, source) {
  if (typeof window === 'undefined') return;
  if (!a || !b || a === b) return;
  const path = window.location.pathname;
  const sourceTag = source === 'edge_click' ? 'edge_click' : 'compare_open';
  post({
    path,
    event: sourceTag,
    meta: { a, b },
  });
}
