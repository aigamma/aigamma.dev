import { useEffect, useState } from 'react';
import '../src/styles/theme.css';
import '../src/styles/lab.css';
import ErrorBoundary from '../src/ErrorBoundary';
import Menu from '../src/components/Menu';
import TopNav from '../src/components/TopNav';
import Chat from '../src/components/Chat';
import VolatilityRiskPremium from '../src/components/VolatilityRiskPremium';
import TermStructure from '../src/components/TermStructure';
import VolatilitySmile from '../src/components/VolatilitySmile';
import RiskNeutralDensity from '../src/components/RiskNeutralDensity';
import FixedStrikeIvMatrix from '../src/components/FixedStrikeIvMatrix';
import useOptionsData from '../src/hooks/useOptionsData';
import useSviFits from '../src/hooks/useSviFits';

// /tactical/ — Tactical Vol Lab.
//
// Five tactical-positioning surfaces moved off the main landing page so the
// main dashboard can lead with the dealer-gamma regime read (status badge,
// LevelsPanel scalars, gamma-profile visualizations) without competing for
// attention against the deeper IV-surface and risk-neutral-density work
// that this page now hosts. The grouping is a coherent reading sequence
// from macro to micro: VRP (cross-sectional implied vs. realized regime
// summary) → Term Structure (IV across tenors at the index level) → Smile
// (IV across strikes at one tenor) → Risk-Neutral Density (the smile re-
// expressed as a probability distribution over terminal spot via Breeden-
// Litzenberger) → Fixed-Strike IV Matrix (the strike × tenor grid that
// makes day-over-day re-pricing events visible cell by cell).
//
// Data layer mirrors the main dashboard: useOptionsData drains the
// __apiBoot.today promise pre-fired by index.html for the live SPX chain,
// useVrpHistory (called inside VolatilityRiskPremium) drains the
// __apiBoot.vrpHistory promise, useSviFits dispatches the per-expiration
// SVI calibration to the shared Web Worker so the RND density curves do
// not block scroll. The prev-day contracts for the FixedStrikeIvMatrix
// 1D-change overlay are fetched by a post-first-paint
// requestIdleCallback so the visible surfaces (smile, RND, term) paint
// without waiting on the ~240 KB brotli prev-day chain. Until that idle
// fetch resolves the matrix renders without the diff layer; both
// FixedStrikeIvMatrix and the other consumers handle prevContracts=null
// gracefully.
//
// Three redundant Return-Home affordances follow the /parity/ and /jump/
// pattern: the logo wraps a hyperlink to `/`, a green RETURN HOME button
// sits in the header alongside the Menu trigger, and the footer carries a
// bolded link for readers who scroll past the Chat panel.
export default function App() {
  const { data, loading, error, refetch } = useOptionsData({
    underlying: 'SPX',
    snapshotType: 'intraday',
  });

  const [prevDayContracts, setPrevDayContracts] = useState(null);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let cancelled = false;
    const idle = window.requestIdleCallback
      ? (cb) => window.requestIdleCallback(cb, { timeout: 2000 })
      : (cb) => setTimeout(cb, 300);
    const cancel = window.cancelIdleCallback
      ? window.cancelIdleCallback
      : clearTimeout;
    const handle = idle(() => {
      if (cancelled) return;
      fetch('/api/data?underlying=SPX&snapshot_type=intraday&prev_day=1&v=2')
        .then((r) => (r.ok ? r.json() : null))
        .then((json) => {
          if (cancelled || !json) return;
          const cols = json.contractCols;
          if (!cols || !Array.isArray(cols.strike)) return;
          const exps = Array.isArray(json.expirations) ? json.expirations : [];
          const n = cols.strike.length;
          const contracts = new Array(n);
          for (let i = 0; i < n; i++) {
            const expIdx = cols.exp[i];
            contracts[i] = {
              expiration_date: expIdx >= 0 && expIdx < exps.length ? exps[expIdx] : null,
              strike_price: cols.strike[i],
              contract_type: cols.type[i] === 0 ? 'call' : 'put',
              implied_volatility: cols.iv[i],
              delta: cols.delta[i],
              gamma: cols.gamma[i],
              open_interest: cols.oi[i],
              close_price: cols.px[i],
            };
          }
          setPrevDayContracts(contracts);
        })
        .catch(() => {});
    });
    return () => {
      cancelled = true;
      cancel(handle);
    };
  }, []);

  const sviFits = useSviFits({
    contracts: data?.contracts,
    spotPrice: data?.spotPrice,
    capturedAt: data?.capturedAt,
    backendFits: data?.sviFits,
  });

  return (
    <div className="app-shell lab-shell">
      <header className="lab-header">
        <div className="lab-brand">
          <a href="/" className="lab-logo-link" aria-label="Return to aigamma.com homepage">
            <img src="/logo.webp" alt="aigamma.com" className="lab-logo" />
          </a>
          <span
            className="lab-badge"
            title="Tactical Vol Lab · VRP, term structure, smile, RND, fixed-strike IV"
          >
            <span className="lab-badge__desktop-text">Tactical Vol Lab</span>
            <span className="lab-badge__mobile-text">Tactical</span>
          </span>
        </div>
        <TopNav />
        <a
          href="/"
          className="lab-home-button lab-home-button--inline lab-home-button--split"
          aria-label="Return Home"
        >
          <span className="lab-home-button__desktop-text">Home</span>
          <span className="lab-home-button__mobile-text">Home</span>
        </a>
        <Menu />
      </header>

      {loading && (
        <div aria-busy="true" aria-label="Loading options data">
          <div className="skeleton-card" style={{ height: '564px' }} />
          <div className="skeleton-card" style={{ height: '564px' }} />
          <div className="skeleton-card" style={{ height: '600px' }} />
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
              fontFamily: 'Courier New, monospace',
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
          <ErrorBoundary>
            <VolatilityRiskPremium
              spotPrice={data.spotPrice}
              capturedAt={data.capturedAt}
            />
          </ErrorBoundary>

          <ErrorBoundary>
            <TermStructure
              expirationMetrics={data.expirationMetrics}
              capturedAt={data.capturedAt}
              cloudBands={data.cloudBands}
            />
          </ErrorBoundary>

          <ErrorBoundary>
            <VolatilitySmile
              contracts={data.contracts}
              spotPrice={data.spotPrice}
              capturedAt={data.capturedAt}
              expirations={data.expirations}
            />
          </ErrorBoundary>

          <ErrorBoundary>
            <RiskNeutralDensity
              fits={sviFits.byExpiration}
              spotPrice={data.spotPrice}
              capturedAt={data.capturedAt}
              loading={sviFits.loading}
            />
          </ErrorBoundary>

          <ErrorBoundary>
            <FixedStrikeIvMatrix
              contracts={data.contracts}
              spotPrice={data.spotPrice}
              expirations={data.expirations}
              prevContracts={prevDayContracts}
            />
          </ErrorBoundary>
        </>
      )}

      <div className="card" style={{ padding: '1.1rem 1.25rem', margin: '1.25rem 0' }}>
        <div
          style={{
            fontFamily: 'Courier New, monospace',
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
            The 30-day constant-maturity implied vol minus the 20-day Yang-Zhang
            realized vol, plotted against SPX as context. Positive spread is
            the empirically-typical state where index options price more
            variance than the underlying delivers; negative spread is the rare
            stress regime where realized has overshot the option market's
            expectation. The persistently positive mean spread on SPX is the
            phenomenon that funds the entire short-volatility trade structure
            in the equity-index options market.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Term Structure.</strong>{' '}
            ATM IV plotted against days-to-expiration across the listed
            expirations, with cloud bands around each tenor representing the
            historical distribution of that point. An upward slope is contango
            and is the normal state of an index options market without imminent
            event risk; a downward slope is backwardation and signals that
            short-dated options are pricing more urgent vol than long-dated.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Volatility Smile.</strong>{' '}
            One expiration slice fit by three concurrent models — Heston
            stochastic variance, Merton diffusion-plus-jumps, and the SVI raw
            parameterization — overlaid on the observed OTM-preferred IV
            points. Disagreement between the three fits at the wings is the
            interesting reading: where they agree, the smile is well-described
            by any of them; where they diverge, the choice of model carries
            information that a single-parameterization view would hide.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Risk-Neutral Density.</strong>{' '}
            The Breeden-Litzenberger construction: the second partial
            derivative of European call price with respect to strike equals
            the risk-neutral probability density of terminal spot, discounted
            by the risk-free rate (Breeden and Litzenberger 1978). The page
            fits Gatheral's SVI parameterization to each expiration's smile
            and analytically differentiates the resulting call-price function,
            sidestepping the numerical instability of differentiating observed
            market prices twice.
          </p>
          <p style={{ margin: 0 }}>
            <strong style={{ color: 'var(--text-primary)' }}>Fixed-Strike IV Matrix.</strong>{' '}
            A strike-by-expiration grid of implied vols. Day-over-day IV
            changes are exposed cell by cell when the prior-day chain is
            available, which is how smile steepening, term-structure
            re-pricing, and strike-level re-pricing events become visible
            without squinting at chart overlays. The prev-day overlay is
            fetched on idle after first paint; the matrix renders without it
            until that fetch resolves.
          </p>
        </div>
      </div>

      <ErrorBoundary>
        <Chat
          context="tactical"
          welcome={{
            quick:
              'Ask about VRP, the term structure, the smile model overlays, the Breeden-Litzenberger density, or how to read day-over-day moves on the fixed-strike matrix.',
            deep:
              'Deep Analysis mode — longer and more structurally detailed responses on Heston / Merton / SVI smile fitting, Gatheral parameterizations, the analytical Breeden-Litzenberger derivation, and how the IV surface decomposes into tenor and strike effects.',
          }}
        />
      </ErrorBoundary>

      <footer className="lab-footer">
        <span className="lab-footer-line">
          AI Gamma · tactical vol lab · VRP / term / smile / RND / fixed-strike · v0.1.0
        </span>
        <a href="/" className="lab-footer-home">Return Home</a>
      </footer>
    </div>
  );
}
