import { useEffect, useMemo, useState } from 'react';
import './styles/theme.css';
import ErrorBoundary from './ErrorBoundary';
import LevelsPanel from './components/LevelsPanel';
import GexProfile from './components/GexProfile';
import GammaInflectionChart from './components/GammaInflectionChart';
import TermStructure from './components/TermStructure';
import FixedStrikeIvMatrix from './components/FixedStrikeIvMatrix';
import RiskNeutralDensity from './components/RiskNeutralDensity';
import VolatilityRiskPremium from './components/VolatilityRiskPremium';
import DealerGammaRegime from './components/DealerGammaRegime';
import GammaThrottleScatter from './components/GammaThrottleScatter';
import Chat from './components/Chat';
import QuantMenu from './components/QuantMenu';
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
// the flip, γ(spot) is negative (dealers short gamma, amplify moves). This
// matches the historical classification in netlify/functions/gex-history.mjs.
// The scalar `net_gamma_notional` (total dollar gamma summed across the book)
// is a different aggregate and does not flip sign at the vol flip, so using it
// here produced incorrect labels whenever the book's integrated sign diverged
// from the zero-crossing sign at spot.
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
  green: 'var(--accent-green)',
  coral: 'var(--accent-coral)',
  amber: 'var(--accent-amber)',
};

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
  const { data: prevDayData } = useOptionsData({
    underlying: 'SPX',
    snapshotType: 'intraday',
    tradingDate: data?.prevTradingDate,
    enabled: !!data?.prevTradingDate,
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

  const sviFits = useSviFits({
    contracts: data?.contracts,
    spotPrice: data?.spotPrice,
    capturedAt: data?.capturedAt,
    backendFits: data?.sviFits,
  });

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

  return (
    <div className="app-shell">
      <header
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
            <span
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
                display: 'inline-flex',
                alignItems: 'center',
              }}
            >
              STATUS: {regime.label}
            </span>
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
              display: 'flex',
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

          <ErrorBoundary><VolatilityRiskPremium /></ErrorBoundary>

          <ErrorBoundary>
            <TermStructure
              expirationMetrics={data.expirationMetrics}
              capturedAt={data.capturedAt}
              cloudBands={data.cloudBands}
            />
          </ErrorBoundary>

          <ErrorBoundary><DealerGammaRegime /></ErrorBoundary>

          <ErrorBoundary>
            <GammaInflectionChart
              spotPrice={data.spotPrice}
              levels={correctedLevels}
            />
          </ErrorBoundary>

          <ErrorBoundary>
            <GexProfile
              contracts={data.contracts}
              spotPrice={data.spotPrice}
              levels={correctedLevels}
              prevContracts={prevDayData?.contracts}
              prevSpotPrice={prevDayData?.spotPrice}
            />
          </ErrorBoundary>

          <ErrorBoundary><GammaThrottleScatter /></ErrorBoundary>

          <ErrorBoundary>
            <FixedStrikeIvMatrix
              contracts={data.contracts}
              spotPrice={data.spotPrice}
              expirations={data.expirations}
              prevContracts={prevDayData?.contracts}
            />
          </ErrorBoundary>

          <ErrorBoundary>
            <RiskNeutralDensity
              fits={sviFits.byExpiration}
              spotPrice={data.spotPrice}
              capturedAt={data.capturedAt}
            />
          </ErrorBoundary>
        </>
      )}

      {/* Chat renders regardless of dashboard load state so users can ask
          questions about the math and philosophy of the dashboard even if
          the live options data is still loading or in an error state. */}
      <ErrorBoundary><Chat /></ErrorBoundary>
    </div>
  );
}
