import { useEffect, useMemo, useState } from 'react';
import './styles/theme.css';
import ErrorBoundary from './ErrorBoundary';
import LevelsPanel from './components/LevelsPanel';
import GexProfile from './components/GexProfile';
import GammaInflectionChart from './components/GammaInflectionChart';
import TermStructure from './components/TermStructure';
import FixedStrikeIvMatrix from './components/FixedStrikeIvMatrix';
import RiskNeutralDensity from './components/RiskNeutralDensity';
import VolSurface3D from './components/VolSurface3D';
import VolatilityRiskPremium from './components/VolatilityRiskPremium';
import DealerGammaRegime from './components/DealerGammaRegime';
import GammaThrottleScatter from './components/GammaThrottleScatter';
import useOptionsData from './hooks/useOptionsData';
import { useVrpHistory } from './hooks/useHistoricalData';
import useSviFits from './hooks/useSviFits';
import { computeGammaProfile, findFlipFromProfile } from './lib/gammaProfile';
import { formatFreshness, isMarketClosed, tradingDateFromCapturedAt } from './lib/dates';

function classifyGammaRegime(levels, spotPrice) {
  if (!levels || spotPrice == null) return null;
  const netGex = levels.net_gamma_notional;
  const volFlip = levels.volatility_flip;
  if (netGex == null) return null;

  if (volFlip != null) {
    const distancePct = Math.abs(spotPrice - volFlip) / spotPrice;
    if (distancePct < 0.002) {
      return { label: 'NEAR FLIP', tone: 'amber', hint: 'spot within 20 bps of vol flip' };
    }
  }
  if (netGex >= 0) {
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

    // IV Rank and IV Percentile over the last 252 trading days.
    // Collect the most recent ≤252 entries with valid iv_30d_cm (series is
    // sorted ascending by trading_date, so we walk backwards).
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

      const below = ivValues.filter((v) => v < currentIv).length;
      result.ivPercentile = (below / ivValues.length) * 100;
      result.ivLookbackDays = ivValues.length;
    }

    return result;
  }, [vrpData]);
  const [prevData, setPrevData] = useState(data);

  // Filter same-day expirations out of the picker dropdown entirely. 0DTE
  // SPX contracts produce unreliable BSM-derived metrics due to model
  // degradation at zero time-to-expiry — ATM IV collapses into the low
  // single digits once the chain decays into its late-session pin and the
  // 25Δ call contract disappears because the delta distribution bifurcates.
  // Keying on the ET calendar date alone excludes both 3rd-Friday contracts
  // that share today's date (the AM-settled SPX monthly that settled at
  // 9:30 ET via SOQ and the PM-settled SPXW weekly that trades until 16:00
  // ET). The FixedStrikeIvMatrix below continues to receive the unfiltered
  // data.expirations because its matrix view is a different surface from
  // the picker and renders its own handling of short-dated contracts.
  const pickerExpirations = useMemo(() => {
    if (!data?.expirations?.length) return [];
    const todayIso = tradingDateFromCapturedAt(data.capturedAt);
    if (!todayIso) return data.expirations;
    return data.expirations.filter((exp) => exp !== todayIso);
  }, [data]);

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

  // Default the expiration picker to a 3rd-Friday AM-settled SPX standard
  // monthly, preferring the closest one to 30 DTE that is still at least 21
  // DTE away from the snapshot. 3rd-Friday monthlies are the most liquid SPX
  // expirations, the primary institutional hedging vehicles, and the
  // contracts that most structured products settle against — landing the
  // default there gives dense strike coverage and stable Greeks on ATM IV,
  // Expected Move, and 25Δ selection on both sides. Requiring DTE ≥ 21
  // keeps the default from drifting onto the current monthly in its final
  // settlement week, where the term structure can steepen sharply and the
  // displayed metrics become less representative of a steady 1-month vol
  // snapshot. The fallback (nearest standard monthly > 14 DTE) is
  // defensive — SPX always lists monthlies 12+ months forward so the
  // primary branch almost always matches. Users can still pick 0DTE or any
  // other expiration from the dropdown; this only changes what renders
  // before interaction.
  const defaultExpiration = useMemo(() => {
    if (!pickerExpirations.length) return null;
    const capturedMs = data?.capturedAt ? new Date(data.capturedAt).getTime() : NaN;
    if (Number.isNaN(capturedMs)) return pickerExpirations[0];

    const withDte = pickerExpirations.map((exp) => {
      const closeMs = new Date(`${exp}T16:00:00-04:00`).getTime();
      const dte = (closeMs - capturedMs) / 86400000;
      return { exp, dte };
    });

    const isMonthly = (iso) => {
      const d = new Date(`${iso}T12:00:00Z`);
      if (d.getUTCDay() !== 5) return false;
      const day = d.getUTCDate();
      return day >= 15 && day <= 21;
    };

    const monthlies = withDte.filter((x) => isMonthly(x.exp));

    const primary = monthlies.filter((x) => x.dte >= 21);
    if (primary.length > 0) {
      primary.sort((a, b) => Math.abs(a.dte - 30) - Math.abs(b.dte - 30));
      return primary[0].exp;
    }

    const fallback = monthlies.filter((x) => x.dte > 14);
    if (fallback.length > 0) {
      fallback.sort((a, b) => a.dte - b.dte);
      return fallback[0].exp;
    }

    return pickerExpirations[0];
  }, [data, pickerExpirations]);

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
          flexWrap: 'wrap',
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

        <nav className="site-nav">
          <a href="https://about.aigamma.com/">About</a>
        </nav>

        {freshness && (
          <div
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
          <div className="skeleton-card" style={{ height: '574px' }} />
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
              expirations={pickerExpirations}
              selectedExpiration={displayExpiration}
              onExpirationChange={setSelectedExpiration}
              capturedAt={data.capturedAt}
              vrpMetric={vrpMetric}
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

          <ErrorBoundary>
            <VolSurface3D
              contracts={data.contracts}
              spotPrice={data.spotPrice}
              capturedAt={data.capturedAt}
              fits={sviFits.byExpiration}
              sviSource={sviFits.source}
              underlying={data.underlying}
            />
          </ErrorBoundary>
        </>
      )}
    </div>
  );
}
