import { Suspense, useEffect, useRef, useState } from 'react';

// Defer mounting a child component until its placeholder is within (or near)
// the viewport. On the main dashboard this moves ~8 Plotly.newPlot calls (the
// below-the-fold charts) out of the initial-render main-thread blocking
// window: each newPlot costs ~50-200 ms of synchronous DOM/layout work, and
// the dashboard renders 11 charts on /api/data resolution, so lazy-mounting
// the eight that aren't visible on a typical 1080p-or-smaller viewport shaves
// roughly half a second of blocking time off the first paint without
// changing which charts eventually render. The child component only mounts
// the first time the skeleton enters the pre-render buffer (`rootMargin` of
// 400px above/below) — after that we never unmount, so scrolling away and
// back doesn't re-trigger an expensive remount.
//
// Props:
//   height (required) — the eventual rendered height of the child, in any
//     CSS length unit; used on the placeholder so the skeleton takes up the
//     same vertical space as the mounted chart and the page doesn't shift
//     under the user when the child arrives.
//   children (required) — the real component (typically wrapped in an
//     ErrorBoundary by the caller).
//   margin (optional) — override for the IntersectionObserver rootMargin;
//     defaults to '400px' which gives ~1 s of prefetch on a fast-scroll
//     phone at 400 px/s.
export default function LazyMount({ height, children, margin = '400px' }) {
  // Initializer runs once per mount. Environments without
  // IntersectionObserver (server render, very old browsers) fall through to
  // eager-mount so the dashboard still renders correctly — we only miss the
  // deferred-mount performance win. Computing this during useState
  // initialization rather than in an effect keeps the observer setup off
  // the happy path for unsupported environments and avoids a cascading
  // render that the react-hooks/set-state-in-effect lint rule flags.
  const [mounted, setMounted] = useState(() => typeof IntersectionObserver === 'undefined');
  const ref = useRef(null);

  useEffect(() => {
    if (mounted) return;
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setMounted(true);
          observer.disconnect();
        }
      },
      { rootMargin: margin }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [mounted, margin]);

  // The same skeleton is used as the pre-mount placeholder and as the
  // Suspense fallback below. React.lazy children on the main dashboard
  // resolve their dynamic-import chunks the first time their Suspense
  // evaluates (the moment mounted flips to true), so a cold-first-visit
  // reader briefly sees this skeleton twice — once for the IntersectionObs
  // gate, and once for the chunk fetch — appearing as a single continuous
  // skeleton because the bytes are identical. On a warm-cache repeat visit
  // the chunk is already resolved, Suspense commits synchronously, and
  // the reader only sees the IntersectionObs skeleton.
  const skeleton = (
    <div
      ref={ref}
      className="skeleton-card"
      style={{ height, marginBottom: '1rem' }}
      aria-hidden="true"
    />
  );
  if (!mounted) return skeleton;
  return <Suspense fallback={skeleton}>{children}</Suspense>;
}
