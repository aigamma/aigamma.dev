import { lazy, useEffect } from 'react';
import '../src/styles/theme.css';
import '../src/styles/page.css';
import ErrorBoundary from '../src/ErrorBoundary';
import Menu from '../src/components/Menu';
import PageNarrator from '../src/components/PageNarrator';
import TopNav from '../src/components/TopNav';
import LazyMount from '../src/components/LazyMount';
import VolatilityRiskPremium from '../src/components/VolatilityRiskPremium';
import useOptionsData from '../src/hooks/useOptionsData';
import useSviFits from '../src/hooks/useSviFits';

// VRP stays statically imported because it is the only chart guaranteed to
// paint above the fold on every viewport, and the VRP chunk contains the
// rangeslider / brush wiring used by the rest of the page anyway. The three
// below-fold charts plus Chat are code-split via React.lazy so their source
// bytes do not land in the initial tactical chunk — each becomes its own
// Vite chunk fetched on demand when the LazyMount viewport gate fires.
// Combined with the idle prefetch below, this keeps the first-paint critical
// path to "header + VRP" instead of "header + four Plotly.newPlot calls
// firing in the same frame," which on Chrome DevTools profiling shaves
// roughly 600-1200 ms of main-thread blocking off the first interactive
// frame on a typical mid-tier laptop. The Volatility Smile multi-model card
// was migrated off this page on 2026-05-06 and now lives on /jump/ (which
// absorbed it via a brief intermediate /smile/ page on 2026-05-08) as the
// canonical five-model smile-fitting lineage (Variance Gamma, Heston,
// Bates SVJ, Kou, Merton); a reader looking for the multi-model smile
// read should follow the /jump/ link in the Menu dropdown.
const TermStructure = lazy(() => import('../src/components/TermStructure'));
const RiskNeutralDensity = lazy(() => import('../src/components/RiskNeutralDensity'));
const FixedStrikeIvMatrix = lazy(() => import('../src/components/FixedStrikeIvMatrix'));
const Chat = lazy(() => import('../src/components/Chat'));

// Warm the browser disk cache with the four below-fold chart chunks plus
// the Chat chunk during idle time after first paint. Mirrors the pattern in
// src/App.jsx: each React.lazy chunk would otherwise fetch on the first
// scroll that crosses its LazyMount viewport gate, costing ~30-100 ms of
// network waterfall per card on a cold connection. Firing the import()
// calls during requestIdleCallback lands the chunks in the disk cache (with
// the immutable Cache-Control header set in netlify.toml) before the reader
// scrolls, so the Suspense fallback inside LazyMount typically never
// renders. Module-level guard fires once per page load.
let prefetchedBelowFold = false;
function prefetchBelowFoldChunks() {
  if (prefetchedBelowFold) return;
  prefetchedBelowFold = true;
  const idle = (typeof window !== 'undefined' && window.requestIdleCallback)
    ? (cb) => window.requestIdleCallback(cb, { timeout: 1500 })
    : (cb) => setTimeout(cb, 200);
  idle(() => {
    import('../src/components/TermStructure');
    import('../src/components/RiskNeutralDensity');
    import('../src/components/FixedStrikeIvMatrix');
    import('../src/components/Chat');
  });
}

// /tactical/ — Tactical Vol.
//
// Four tactical-positioning surfaces moved off the main landing page so the
// main dashboard can lead with the dealer-gamma regime read (status badge,
// LevelsPanel scalars, gamma-profile visualizations) without competing for
// attention against the deeper IV-surface and risk-neutral-density work
// that this page now hosts. The grouping is a coherent reading sequence
// from macro to micro: VRP (cross-sectional implied vs. realized regime
// summary) → Term Structure (IV across tenors at the index level) → Risk-
// Neutral Density (the smile re-expressed as a probability distribution
// over terminal spot via Breeden-Litzenberger) → Fixed-Strike IV Matrix
// (the strike × tenor grid that makes day-over-day re-pricing events
// visible cell by cell). The single-tenor multi-model Volatility Smile
// card used to sit between Term Structure and RND on this page; it was
// migrated to its own /smile/ page on 2026-05-06 to cure cold-mount
// latency on this page (five concurrent Plotly.newPlot calls firing on
// first paint was the slowest page on the site), and on 2026-05-08 the
// /smile/ page itself was absorbed by /jump/ once the canonical
// smile-fitting lineage (Variance Gamma, Heston, Bates SVJ, Kou, Merton)
// landed on /jump/ as five reading surfaces sharing one calibration slice.
//
// Data layer mirrors the main dashboard: useOptionsData drains the
// __apiBoot.today promise pre-fired by index.html for the live SPX chain,
// useVrpHistory (called inside VolatilityRiskPremium) drains the
// __apiBoot.vrpHistory promise, useSviFits dispatches the per-expiration
// SVI calibration to the shared Web Worker so the RND density curves on
// the Risk-Neutral Density card do not block scroll. The prev-day chain
// for the FixedStrikeIvMatrix
// 1D-change overlay is no longer fetched here — the matrix component
// owns its own prev-day data and pulls a thin IV-only projection from
// /api/fixed-strike-iv in two phases (visible expirations first, the
// rest on idle), replacing the historical 228 KB /api/data?prev_day=1
// idle fetch that lived in this App.jsx until 2026-04-26.
//
// Render layer: VRP renders eagerly (the only above-fold chart on a
// typical viewport). The three other charts plus Chat are React.lazy +
// LazyMount-gated, which means (a) their source bytes are split into
// per-card chunks instead of bundling into the initial tactical chunk
// and (b) their Plotly.newPlot calls don't fire until the reader scrolls
// within 200 px of each card. An idle-time prefetch fires the three
// import() calls during requestIdleCallback so the chunks land in the
// disk cache before the reader scrolls and the Suspense fallback inside
// LazyMount typically never paints. This pattern was added 2026-04-27
// after profiling /tactical as the slowest page on the site — a cold
// load was firing five Plotly.newPlot calls in the same frame, costing
// ~600-1200 ms of synchronous main-thread work that the user perceived
// as a long blank-then-everything-at-once load. Migrating the multi-
// model Volatility Smile card off this page on 2026-05-06 took the
// page from five eager-or-near-eager charts down to four, shedding the
// most expensive concurrent calibration cost (Heston Nelder-Mead +
// Merton Poisson-weighted simplex + SVI Levenberg-Marquardt all on the
// same slice) off the tactical critical path entirely. The smile card
// now lives on /jump/ as the first of five concurrent smile-fitting
// surfaces.
//
// Three redundant Return-Home affordances follow the /jump/ pattern:
// the logo wraps a hyperlink to `/`, a green RETURN HOME button
// sits in the header alongside the Menu trigger, and the footer carries a
// bolded link for readers who scroll past the Chat panel.
export default function App() {
  const { data, loading, error, refetch } = useOptionsData({
    underlying: 'SPX',
    snapshotType: 'intraday',
  });

  useEffect(() => {
    prefetchBelowFoldChunks();
  }, []);

  // SVI fits dispatch to a shared Web Worker (see src/hooks/useSviFits.js)
  // so the calibration runs off-thread the moment /api/data resolves. By the
  // time the reader scrolls into RND's LazyMount viewport gate, the worker
  // has typically already returned and `sviFits.byExpiration` is populated.
  const sviFits = useSviFits({
    contracts: data?.contracts,
    spotPrice: data?.spotPrice,
    capturedAt: data?.capturedAt,
    backendFits: data?.sviFits,
  });

  return (
    <div className="app-shell page-shell">
      <header className="page-header">
        <div className="page-brand">
          <span
            className="page-badge"
            title="Tactical Vol · VRP, term structure, RND, fixed-strike IV (smile moved to /jump/)"
          >
            <span className="page-badge__desktop-text">Tactical Vol</span>
            <span className="page-badge__mobile-text">Tactical Vol</span>
          </span>
        </div>
        <TopNav current="tactical" />
        <a
          href="/"
          className="page-home-button page-home-button--inline page-home-button--split"
          aria-label="Return Home"
        >
          <span className="page-home-button__desktop-text">Home</span>
          <span className="page-home-button__mobile-text">Home</span>
        </a>
        <Menu />
      </header>

      <ErrorBoundary><PageNarrator page="/tactical/" /></ErrorBoundary>

      {loading && (
        <div aria-busy="true" aria-label="Loading options data">
          <div className="skeleton-card" style={{ height: '564px' }} />
          <div className="skeleton-card" style={{ height: '564px' }} />
          <div className="skeleton-card" style={{ height: '560px' }} />
          <div className="skeleton-card" style={{ height: '600px' }} />
        </div>
      )}

      {error && (
        <div className="card" style={{ padding: '2rem', color: 'var(--accent-coral)' }}>
          <div>Error: {error}</div>
          <button
            type="button"
            onClick={refetch}
            style={{
              marginTop: '1rem',
              padding: '0 1rem',
              height: '2.4rem',
              fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
              fontSize: '0.9rem',
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              background: 'transparent',
              color: 'var(--accent-blue)',
              border: '1px solid var(--accent-blue)',
              borderRadius: '3px',
              cursor: 'pointer',
            }}
          >
            Retry
          </button>
        </div>
      )}

      {data && (
        <>
          {/* VRP is the only chart that paints above the fold on a typical
              viewport (header ~100px + VRP card 564px ≈ 664px), so it stays
              eagerly mounted to land in the same frame as /api/data
              resolution. The four below-fold cards are LazyMount-gated
              behind a 200px scroll margin so their Plotly.newPlot calls
              defer until the reader actually scrolls into range — saving
              the synchronous DOM/layout cost (50-200 ms each) from the
              first-paint critical path. Heights match each component's
              real rendered footprint (matching the loading-skeleton
              heights above) so the placeholder occupies the same vertical
              space as the mounted chart and there is no CLS. The 200px
              margin is tighter than the main dashboard's 400px because
              tactical's charts are taller (564-600px each), so the wider
              margin would defeat the purpose by triggering all four
              mounts on first paint anyway. */}
          <ErrorBoundary>
            <VolatilityRiskPremium
              spotPrice={data.spotPrice}
              capturedAt={data.capturedAt}
            />
          </ErrorBoundary>

          <ErrorBoundary>
            <LazyMount height="564px" margin="200px">
              <TermStructure
                expirationMetrics={data.expirationMetrics}
                capturedAt={data.capturedAt}
                cloudBands={data.cloudBands}
              />
            </LazyMount>
          </ErrorBoundary>

          <ErrorBoundary>
            <LazyMount height="560px" margin="200px">
              <RiskNeutralDensity
                fits={sviFits.byExpiration}
                spotPrice={data.spotPrice}
                capturedAt={data.capturedAt}
                loading={sviFits.loading}
              />
            </LazyMount>
          </ErrorBoundary>

          <ErrorBoundary>
            <LazyMount height="600px" margin="200px">
              <FixedStrikeIvMatrix
                contracts={data.contracts}
                spotPrice={data.spotPrice}
                expirations={data.expirations}
              />
            </LazyMount>
          </ErrorBoundary>
        </>
      )}

      <div className="card" style={{ padding: '1.1rem 1.25rem', margin: '1.25rem 0' }}>
        <div
          style={{
            fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
            fontSize: '0.7rem',
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--text-secondary)',
            marginBottom: '0.45rem',
          }}
        >
          what this page measures
        </div>
        <div style={{ color: 'var(--text-secondary)', lineHeight: 1.65, fontSize: '0.95rem' }}>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Volatility Risk Premium.</strong>{' '}
            <strong style={{ color: 'var(--text-primary)' }}>30-day constant-maturity IV</strong> minus{' '}
            <strong style={{ color: 'var(--text-primary)' }}>20-day Yang-Zhang realized vol</strong>,
            plotted against SPX as context.{' '}
            <strong style={{ color: 'var(--accent-green)' }}>Positive spread</strong> is the
            empirically-typical state where index options price more variance than the underlying
            delivers; <strong style={{ color: 'var(--accent-coral)' }}>negative spread</strong>{' '}
            is the rare stress regime where realized has overshot the option market's expectation.
            The persistently <strong style={{ color: 'var(--accent-green)' }}>positive mean spread</strong>{' '}
            on SPX is what funds the entire short-volatility trade structure in equity-index options.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Term Structure.</strong>{' '}
            <strong style={{ color: 'var(--text-primary)' }}>ATM IV vs days-to-expiration</strong>{' '}
            across the listed expirations, with{' '}
            <strong style={{ color: 'var(--text-primary)' }}>cloud bands</strong>{' '}
            around each tenor representing the historical distribution of that point. An upward
            slope is <strong style={{ color: 'var(--accent-green)' }}>contango</strong>, the
            normal state of an index market without imminent event risk. A downward slope is{' '}
            <strong style={{ color: 'var(--accent-coral)' }}>backwardation</strong>: short-dated
            options pricing more urgent vol than long-dated.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Risk-Neutral Density.</strong>{' '}
            The <strong style={{ color: 'var(--text-primary)' }}>Breeden-Litzenberger construction</strong>:
            the <strong style={{ color: 'var(--text-primary)' }}>second partial derivative of European
            call price with respect to strike</strong> equals the risk-neutral probability density of
            terminal spot at expiration (Breeden and Litzenberger 1978). The SVI fitter here uses{' '}
            <strong style={{ color: 'var(--text-primary)' }}>r = q = 0</strong>, so the plotted density
            is the undiscounted second derivative of the fitted call curve.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            The page fits <strong style={{ color: 'var(--text-primary)' }}>Gatheral's SVI</strong>{' '}
            to each expiration's smile and analytically differentiates the resulting call-price
            function, sidestepping the numerical instability of differentiating observed market
            prices twice. Model zoos on /jump/, /risk/, and /discrete/ pin carry at{' '}
            <strong style={{ color: 'var(--text-primary)' }}>r ≈ 4.5%, q ≈ 1.3%</strong>{' '}
            via src/lib/marketRates.js; this surface uses r = q = 0 for smile shape.
          </p>
          <p style={{ margin: 0 }}>
            <strong style={{ color: 'var(--text-primary)' }}>Fixed-Strike IV Matrix.</strong>{' '}
            A <strong style={{ color: 'var(--text-primary)' }}>strike × expiration grid</strong>{' '}
            of implied vols. Day-over-day IV changes are exposed cell by cell when the prior-day
            chain is available, so{' '}
            <strong style={{ color: 'var(--accent-amber)' }}>smile steepening</strong>,{' '}
            <strong style={{ color: 'var(--accent-amber)' }}>term-structure re-pricing</strong>,
            and <strong style={{ color: 'var(--accent-amber)' }}>strike-level re-pricing</strong>{' '}
            events become visible without squinting at chart overlays.
          </p>
        </div>
      </div>

      <ErrorBoundary>
        <LazyMount height="320px" margin="200px">
          <Chat
            context="tactical"
            welcome={{
              quick:
                'Ask about VRP, the term structure, the Breeden-Litzenberger density, or how to read day-over-day moves on the fixed-strike matrix. The multi-model Volatility Smile (Variance Gamma, Heston, Bates SVJ, Kou, Merton) moved to /jump/.',
              deep:
                'Deep Analysis mode: longer and more structurally detailed responses on the volatility risk premium, term-structure cloud-band construction, the analytical Breeden-Litzenberger derivation from SVI fits, and how the IV surface decomposes into tenor and strike effects.',
            }}
          />
        </LazyMount>
      </ErrorBoundary>

      <footer className="page-footer">
        <a href="/disclaimer/" className="page-footer-disclaimer">Disclaimer</a>
        <a href="/" className="page-footer-home">Return Home</a>
        <a href="https://about.aigamma.com/" className="page-footer-about">Created by Eric Allione</a>
      </footer>
    </div>
  );
}
