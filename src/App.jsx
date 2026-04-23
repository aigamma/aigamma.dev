import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import './styles/theme.css';
import ErrorBoundary from './ErrorBoundary';
import LevelsPanel from './components/LevelsPanel';
import GexProfile from './components/GexProfile';
import GammaInflectionChart from './components/GammaInflectionChart';
import TermStructure from './components/TermStructure';
import VolatilitySmile from './components/VolatilitySmile';
import FixedStrikeIvMatrix from './components/FixedStrikeIvMatrix';
import RiskNeutralDensity from './components/RiskNeutralDensity';
import VolatilityRiskPremium from './components/VolatilityRiskPremium';
import DealerGammaRegime from './components/DealerGammaRegime';
import SpxVolFlip from './components/SpxVolFlip';
import GammaIndexOscillator from './components/GammaIndexOscillator';
import GammaIndexScatter from './components/GammaIndexScatter';
import Chat from './components/Chat';
import QuantMenu from './components/QuantMenu';
import LazyMount from './components/LazyMount';
import useOptionsData from './hooks/useOptionsData';
import { useVrpHistory } from './hooks/useHistoricalData';
import useSviFits from './hooks/useSviFits';
import { computeGammaProfile, findFlipFromProfile } from './lib/gammaProfile';
import {
  filterPickerExpirations,
  formatFreshness,
  isMarketClosed,
  pickDefaultExpiration,
} from './lib/dates';

// Regime is determined by spot's side of the volatility flip — the price at
// which the dealer gamma profile crosses zero. When spot is above the flip,
// γ(spot) is positive (dealers long gamma, dampen moves); when spot is below
// the flip, γ(spot) is negative (dealers short gamma, amplify moves).
function classifyGammaRegime(levels, spotPrice) {
  if (!levels || spotPrice == null) return null;
  const volFlip = levels.volatility_flip;
  if (volFlip == null) return null;

  const distancePct = Math.abs(spotPrice - volFlip) / spotPrice;
  if (distancePct < 0.002) {
    return { label: 'NEAR FLIP', tone: 'amber', hint: 'spot within 20 bps of vol flip' };
  }
  if (spotPrice >= volFlip) {
    return { label: 'POSITIVE GAMMA', tone: 'green', hint: 'dealers dampen moves' };
  }
  return { label: 'NEGATIVE GAMMA', tone: 'coral', hint: 'dealers amplify moves' };
}

const REGIME_COLORS = {
  green: '#04A29F',
  coral: 'var(--accent-coral)',
  amber: 'var(--accent-amber)',
};

// Favicon state mirrors the three-state iconography of the AI Gamma browser
// extension (green plus, coral minus, AiG monogram). positive/negative only
// ship at 16 and 32 px in the extension bundle, so 48 and 128 fall back to
// the 32 px asset under upscaling; neutral ships at all four sizes natively.
// NEAR FLIP (amber tone on the dashboard) collapses to neutral here so the
// tab icon matches what the approved Chrome Store extension already shows.
// ?v=2 cache-buster busts Chrome's favicon cache across deploys. Bump
// whenever the icon artwork changes so installed users re-fetch rather
// than staying on whatever their browser cached previously — Chrome's
// favicon cache is stubborn and survives Ctrl+F5 without a URL change.
const FAVICON_PATHS = {
  positive: {
    16: '/favicons/positive/icon16.png?v=2',
    32: '/favicons/positive/icon32.png?v=2',
    48: '/favicons/positive/icon32.png?v=2',
    128: '/favicons/positive/icon32.png?v=2',
  },
  negative: {
    16: '/favicons/negative/icon16.png?v=2',
    32: '/favicons/negative/icon32.png?v=2',
    48: '/favicons/negative/icon32.png?v=2',
    128: '/favicons/negative/icon32.png?v=2',
  },
  neutral: {
    16: '/favicons/neutral/icon16.png?v=2',
    32: '/favicons/neutral/icon32.png?v=2',
    48: '/favicons/neutral/icon48.png?v=2',
    128: '/favicons/neutral/icon128.png?v=2',
  },
};

function faviconStateFromRegime(regime) {
  if (!regime) return 'neutral';
  if (regime.tone === 'green') return 'positive';
  if (regime.tone === 'coral') return 'negative';
  return 'neutral';
}

function readExpFromUrl() {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('exp');
  return /^\d{4}-\d{2}-\d{2}$/.test(raw || '') ? raw : null;
}

export default function App() {
  const [selectedExpiration, setSelectedExpiration] = useState(readExpFromUrl);
  const { data, loading, error, refetch } = useOptionsData({
    underlying: 'SPX',
    snapshotType: 'intraday',
  });
  // Prior-day snapshot fetched in parallel with today's. The server
  // resolves the prev trading date internally, so this request doesn't
  // have to wait for the primary /api/data to resolve and hand back
  // prevTradingDate — both hit the CDN at mount, cutting ~600-1200 ms
  // off the old serial-refetch path.
  const { data: prevDayData } = useOptionsData({
    underlying: 'SPX',
    snapshotType: 'intraday',
    prevDay: true,
  });
  const { data: vrpData } = useVrpHistory({});
  const vrpMetric = useMemo(() => {
    if (!vrpData?.series) return null;

    // Find the latest row with valid IV and HV for the VRP spread
    let latest = null;
    for (let i = vrpData.series.length - 1; i >= 0; i--) {
      const r = vrpData.series[i];
      if (r.iv_30d_cm != null && r.hv_20d_yz != null) {
        latest = r;
        break;
      }
    }
    if (!latest) return null;

    const result = {
      vrp: (latest.iv_30d_cm - latest.hv_20d_yz) * 100,
      iv: latest.iv_30d_cm * 100,
      rv: latest.hv_20d_yz * 100,
    };

    // IV Rank over the last 252 trading days. Collect the most recent ≤252
    // entries with valid iv_30d_cm (series is sorted ascending by
    // trading_date, so we walk backwards).
    const ivValues = [];
    for (let i = vrpData.series.length - 1; i >= 0 && ivValues.length < 252; i--) {
      if (vrpData.series[i].iv_30d_cm != null) {
        ivValues.push(vrpData.series[i].iv_30d_cm);
      }
    }

    if (ivValues.length > 1) {
      const currentIv = ivValues[0];
      const lo = Math.min(...ivValues);
      const hi = Math.max(...ivValues);
      const range = hi - lo;

      result.ivRank = range > 0 ? ((currentIv - lo) / range) * 100 : 50;
      result.ivRankHigh = hi * 100;
      result.ivRankLow = lo * 100;
    }

    return result;
  }, [vrpData]);
  const [prevData, setPrevData] = useState(data);

  // The picker excludes the same-day expiration — see
  // filterPickerExpirations in src/lib/dates.js for why. The
  // FixedStrikeIvMatrix below continues to receive the unfiltered
  // data.expirations because its matrix view is a different surface from
  // the picker and renders its own handling of short-dated contracts.
  const pickerExpirations = useMemo(
    () => filterPickerExpirations(data?.expirations, data?.capturedAt),
    [data]
  );

  // React's recommended "adjust state during render" pattern for deriving
  // state from props — when a new options payload arrives and the user's
  // previously selected expiration is no longer in the picker list (e.g.,
  // the date expired between sessions, or a ?exp=today URL param is no
  // longer valid after the same-day filter), clear the selection so the UI
  // falls back to the default on the next render. Calling setState here
  // rather than in a useEffect avoids the cascading-render warning from the
  // react-hooks/set-state-in-effect lint rule.
  if (data !== prevData) {
    setPrevData(data);
    if (
      data &&
      selectedExpiration &&
      !pickerExpirations.includes(selectedExpiration)
    ) {
      setSelectedExpiration(null);
    }
  }

  // See pickDefaultExpiration in src/lib/dates.js for the tenor-gate logic.
  // Users can still pick 0DTE or any other expiration from the dropdown;
  // this only changes what renders before interaction.
  const defaultExpiration = useMemo(
    () => pickDefaultExpiration(pickerExpirations, data?.capturedAt),
    [data, pickerExpirations]
  );

  const displayExpiration = selectedExpiration || defaultExpiration;

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (selectedExpiration) {
      params.set('exp', selectedExpiration);
    } else {
      params.delete('exp');
    }
    const query = params.toString();
    const next = window.location.pathname + (query ? `?${query}` : '') + window.location.hash;
    if (next !== window.location.pathname + window.location.search + window.location.hash) {
      window.history.replaceState(null, '', next);
    }
  }, [selectedExpiration]);

  // Defer the SVI fit (one fitSviSlice call per expiration, ~31 expirations
  // on a live SPX chain, ~100-300 ms total on a modern laptop) into a
  // concurrent background render so the other eleven charts above
  // RiskNeutralDensity in the page flow paint first. useDeferredValue
  // returns the previous value (initially null → null) in urgent renders
  // and schedules a lower-priority background render with the new value;
  // React paints after the urgent render commits, so the below-the-fold
  // RND waits one extra render for its density while the stats grid and
  // the gamma/term-structure charts above it hit the screen as soon as
  // the data lands. RND shows a skeleton during that window (see
  // RiskNeutralDensity.jsx) rather than the "unavailable" card that used
  // to render when fits was empty.
  const deferredContracts = useDeferredValue(data?.contracts);
  const deferredSpot = useDeferredValue(data?.spotPrice);
  const deferredCapturedAt = useDeferredValue(data?.capturedAt);
  const deferredBackendFits = useDeferredValue(data?.sviFits);
  const sviFits = useSviFits({
    contracts: deferredContracts,
    spotPrice: deferredSpot,
    capturedAt: deferredCapturedAt,
    backendFits: deferredBackendFits,
  });
  const sviLoading = deferredContracts !== data?.contracts;

  // Client-side override of the gamma inflection profile and volatility flip.
  // The backend pass that writes `gamma_profile` and recomputes
  // `volatility_flip` from the zero crossing was shipped but the deployed
  // ingest has not been able to persist new runs since then (missing service
  // key breaks RLS INSERT), so every run in the database still carries a null
  // profile and the old gamma-max-based flip. Recomputing here guarantees the
  // chart lights up correctly on every run, past and future, independent of
  // backend state.
  const correctedLevels = useMemo(() => {
    if (!data?.levels || !data?.contracts || !(data.spotPrice > 0)) return data?.levels || null;
    const profile = computeGammaProfile(data.contracts, data.spotPrice, data.capturedAt);
    if (!profile || profile.length === 0) return data.levels;
    const flip = findFlipFromProfile(profile);
    return {
      ...data.levels,
      gamma_profile: profile,
      volatility_flip: flip ?? data.levels.volatility_flip,
    };
  }, [data]);

  // Mirror the client-side vol-flip recomputation on the previous trading
  // day's snapshot so the overnight alignment score compares like with like
  // (both days' flip values are the zero-crossing of the locally-computed
  // gamma profile, not a mix of fresh profile today vs stale backend flip
  // yesterday). put_wall and call_wall are read directly from the payload
  // because no client-side correction is applied to them.
  const prevCorrectedLevels = useMemo(() => {
    if (!prevDayData?.levels) return null;
    if (!prevDayData.contracts || !(prevDayData.spotPrice > 0)) return prevDayData.levels;
    const profile = computeGammaProfile(prevDayData.contracts, prevDayData.spotPrice, prevDayData.capturedAt);
    if (!profile || profile.length === 0) return prevDayData.levels;
    const flip = findFlipFromProfile(profile);
    return {
      ...prevDayData.levels,
      volatility_flip: flip ?? prevDayData.levels.volatility_flip,
    };
  }, [prevDayData]);

  // Overnight alignment: compare today's put wall, vol flip, and call wall
  // against yesterday's corrected values. Each level contributes +1 if it
  // rose, -1 if it fell, 0 if unchanged or missing. The score sums to a net
  // in [-3, +3]; the per-level signs travel alongside in `dirs` so the UI
  // can render an individual arrow for each. This is informational — the
  // component displays the net and the breakdown and leaves interpretation
  // to the reader.
  const overnightAlignment = useMemo(() => {
    if (!correctedLevels || !prevCorrectedLevels) return null;
    const keys = ['put_wall', 'volatility_flip', 'call_wall'];
    const dirs = {};
    let score = 0;
    let counted = 0;
    for (const key of keys) {
      const today = correctedLevels[key];
      const prev = prevCorrectedLevels[key];
      if (today == null || prev == null) {
        dirs[key] = null;
        continue;
      }
      const delta = today - prev;
      const sign = delta > 0 ? 1 : delta < 0 ? -1 : 0;
      dirs[key] = { delta, sign };
      score += sign;
      counted += 1;
    }
    if (counted === 0) return null;
    return { score, counted, dirs };
  }, [correctedLevels, prevCorrectedLevels]);

  const freshness = data ? formatFreshness(data.capturedAt) : null;
  const isSynthetic = data && data.source === 'synthetic';
  const regime = data ? classifyGammaRegime(correctedLevels, data.spotPrice) : null;
  const marketClosed = isMarketClosed(new Date());

  // Dynamic favicon: sync the tab icon with the same regime classification
  // that drives the on-page STATUS badge, so the tab chrome always agrees
  // with the dashboard header. Keyed on the primitive state string so the
  // effect fires only on actual regime transitions, not on every data
  // refetch that returns a fresh object with the same tone.
  const faviconState = faviconStateFromRegime(regime);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const paths = FAVICON_PATHS[faviconState];
    for (const size of [16, 32, 48, 128]) {
      const link = document.getElementById(`favicon-${size}`);
      if (link) link.setAttribute('href', paths[size]);
    }
  }, [faviconState]);

  return (
    <div className="app-shell">
      <header
        className="site-header"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'nowrap',
          gap: '0.75rem',
          marginBottom: '1rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <a href="https://about.aigamma.com/" style={{ display: 'block' }}>
            <img
              src="/logo.webp"
              alt="aigamma.com"
              style={{
                height: '3.2rem',
                display: 'block',
              }}
            />
          </a>
          {regime && (
            <>
              <span
                className="regime-badge-desktop"
                title={regime.hint}
                style={{
                  fontFamily: 'Courier New, monospace',
                  fontSize: '1.25rem',
                  padding: '0 1rem',
                  border: `1px solid ${REGIME_COLORS[regime.tone]}`,
                  color: REGIME_COLORS[regime.tone],
                  borderRadius: '3px',
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  whiteSpace: 'nowrap',
                  height: '3.2rem',
                  boxSizing: 'border-box',
                  alignItems: 'center',
                }}
              >
                STATUS: {regime.label}
              </span>
              <img
                className="regime-badge-mobile"
                src={FAVICON_PATHS[faviconStateFromRegime(regime)][32]}
                alt={`STATUS: ${regime.label}`}
                title={`STATUS: ${regime.label} — ${regime.hint}`}
                style={{
                  height: '3.2rem',
                  width: '3.2rem',
                  flexShrink: 0,
                }}
              />
            </>
          )}
        </div>

        {/* QuantMenu and About are direct children of the header (rather
            than grouped inside a .site-nav wrapper) so the header's
            `justify-content: space-between` distributes four equal gaps
            across four items, placing QuantMenu's center exactly at the
            midpoint between the status group's right edge and About's
            left edge — Eric's requested "roughly center QUANT MENU in
            between the gamma status and ABOUT". */}
        <QuantMenu />
        <a href="https://about.aigamma.com/" className="site-about-link">About</a>

        {freshness && (
          <div
            className="site-timestamp"
            style={{
              fontFamily: 'Courier New, monospace',
              fontSize: '0.8rem',
              color: 'var(--text-secondary)',
              alignItems: 'center',
              gap: '0.5rem',
            }}
          >
            <span>{marketClosed ? 'Final:' : 'Last updated:'} {freshness}</span>
            {isSynthetic && (
              <span
                style={{
                  padding: '0.1rem 0.4rem',
                  border: '1px solid var(--accent-amber)',
                  color: 'var(--accent-amber)',
                  borderRadius: '3px',
                }}
              >
                SYNTHETIC
              </span>
            )}
          </div>
        )}
      </header>

      {loading && (
        <div aria-busy="true" aria-label="Loading options data">
          <div className="skeleton-card" style={{ height: '260px' }} />
          <div className="skeleton-card" style={{ height: '564px' }} />
          <div className="skeleton-card" style={{ height: '564px' }} />
          <div className="skeleton-card" style={{ height: '394px' }} />
          <div className="skeleton-card" style={{ height: '434px' }} />
          <div className="skeleton-card" style={{ height: '600px' }} />
          <div className="skeleton-card" style={{ height: '600px' }} />
          <div className="skeleton-card" style={{ height: '454px' }} />
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
            <LevelsPanel
              levels={correctedLevels}
              spotPrice={data.spotPrice}
              prevClose={data.prevClose}
              expirationMetrics={data.expirationMetrics}
              prevExpirationMetrics={prevDayData?.expirationMetrics}
              expirations={pickerExpirations}
              selectedExpiration={displayExpiration}
              onExpirationChange={setSelectedExpiration}
              capturedAt={data.capturedAt}
              vrpMetric={vrpMetric}
              overnightAlignment={overnightAlignment}
            />
          </ErrorBoundary>

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

          {/* VolatilitySmile through FixedStrikeIvMatrix are wrapped in
              LazyMount so their skeletons hold the page layout stable but
              their Plotly.newPlot calls don't fire until the reader scrolls
              within ~400 px of each card. On a typical 1080p viewport the
              dashboard renders LevelsPanel + VRP + TermStructure eagerly
              above the fold and defers the other eight charts; on mobile
              even fewer cards paint on first frame. Each mounted chart
              incurs 50-200 ms of Plotly DOM/layout work; deferring the
              eight below-fold charts saves ~0.5-1.5 s of initial-render
              main-thread blocking depending on device speed, and their
              subsequent mount happens off the critical path so the user
              sees above-fold charts immediately while the rest hydrate
              quietly as they scroll. Heights match each component's real
              rendered height (including brushes / reset-buttons / legends)
              so the placeholder occupies the same vertical footprint as
              the mounted chart and there is no CLS. */}
          <ErrorBoundary>
            <LazyMount height="600px">
              <VolatilitySmile
                contracts={data.contracts}
                spotPrice={data.spotPrice}
                capturedAt={data.capturedAt}
                expirations={data.expirations}
              />
            </LazyMount>
          </ErrorBoundary>

          <ErrorBoundary><LazyMount height="604px"><DealerGammaRegime /></LazyMount></ErrorBoundary>

          <ErrorBoundary><LazyMount height="600px"><SpxVolFlip /></LazyMount></ErrorBoundary>

          <ErrorBoundary><LazyMount height="600px"><GammaIndexOscillator /></LazyMount></ErrorBoundary>

          <ErrorBoundary>
            <LazyMount height="700px">
              <GammaInflectionChart
                spotPrice={data.spotPrice}
                levels={correctedLevels}
              />
            </LazyMount>
          </ErrorBoundary>

          <ErrorBoundary>
            <LazyMount height="700px">
              <GexProfile
                contracts={data.contracts}
                spotPrice={data.spotPrice}
                levels={correctedLevels}
                prevContracts={prevDayData?.contracts}
                prevSpotPrice={prevDayData?.spotPrice}
              />
            </LazyMount>
          </ErrorBoundary>

          <ErrorBoundary><LazyMount height="640px"><GammaIndexScatter /></LazyMount></ErrorBoundary>

          <ErrorBoundary>
            <LazyMount height="560px">
              <RiskNeutralDensity
                fits={sviFits.byExpiration}
                spotPrice={data.spotPrice}
                capturedAt={data.capturedAt}
                loading={sviLoading}
              />
            </LazyMount>
          </ErrorBoundary>

          <ErrorBoundary>
            <LazyMount height="600px">
              <FixedStrikeIvMatrix
                contracts={data.contracts}
                spotPrice={data.spotPrice}
                expirations={data.expirations}
                prevContracts={prevDayData?.contracts}
              />
            </LazyMount>
          </ErrorBoundary>
        </>
      )}

      {/* Chat renders regardless of dashboard load state so users can ask
          questions about the math and philosophy of the dashboard even if
          the live options data is still loading or in an error state. It
          sits at the very bottom of the dashboard so LazyMount defers the
          ~6 KB gzipped Chat chunk's React mount work until a reader scrolls
          within 400 px of the bottom of the page, which is long after all
          11 above-Chat cards have had a chance to hydrate and paint. */}
      <ErrorBoundary><LazyMount height="320px"><Chat /></LazyMount></ErrorBoundary>
    </div>
  );
}
