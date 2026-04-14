import { useEffect, useMemo, useState } from 'react';
import './styles/theme.css';
import VolSmile from './components/VolSmile';
import LevelsPanel from './components/LevelsPanel';
import GexProfile from './components/GexProfile';
import GammaInflectionChart from './components/GammaInflectionChart';
import TermStructure from './components/TermStructure';
import FixedStrikeIvMatrix from './components/FixedStrikeIvMatrix';
import RiskNeutralDensity from './components/RiskNeutralDensity';
import VolSurface3D from './components/VolSurface3D';
import useOptionsData from './hooks/useOptionsData';
import useSviFits from './hooks/useSviFits';
import { computeGammaProfile, findFlipFromProfile } from './lib/gammaProfile';

function formatFreshness(isoString) {
  if (!isoString) return null;
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return null;
  const et = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: false,
  }).format(d);
  return `${et} ET`;
}

// True on weekends or on weekdays after 16:15 ET. The options market closes at
// 16:15 ET for SPX, and after that the snapshot is frozen for the session — so
// the header label flips from "Last updated:" (implies ongoing updates) to
// "Final:" (implies the snapshot is done moving).
function isMarketClosed(nowDate) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(nowDate);
  const lookup = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  if (lookup.weekday === 'Sat' || lookup.weekday === 'Sun') return true;
  const hour = parseInt(lookup.hour, 10);
  const minute = parseInt(lookup.minute, 10);
  return hour * 60 + minute >= 16 * 60 + 15;
}

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
  const [prevData, setPrevData] = useState(data);

  // React's recommended "adjust state during render" pattern for deriving
  // state from props — when a new options payload arrives and the user's
  // previously selected expiration is no longer in the list (e.g., the date
  // expired between sessions), clear the selection so the UI falls back to
  // the freshest expiration on the next render. Calling setState here rather
  // than in a useEffect avoids the cascading-render warning from the
  // react-hooks/set-state-in-effect lint rule.
  if (data !== prevData) {
    setPrevData(data);
    if (
      data &&
      selectedExpiration &&
      Array.isArray(data.expirations) &&
      !data.expirations.includes(selectedExpiration)
    ) {
      setSelectedExpiration(null);
    }
  }

  const displayExpiration =
    selectedExpiration || (data && data.expirations && data.expirations[0]) || null;

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

  const filteredContracts = useMemo(() => {
    if (!data || !data.contracts) return [];
    if (!displayExpiration) return data.contracts;
    return data.contracts.filter((c) => c.expiration_date === displayExpiration);
  }, [data, displayExpiration]);

  const sviFits = useSviFits({
    contracts: data?.contracts,
    spotPrice: data?.spotPrice,
    capturedAt: data?.capturedAt,
    backendFits: data?.sviFits,
  });

  const currentSviFit = displayExpiration
    ? sviFits.byExpiration[displayExpiration] ?? null
    : null;

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
    <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '1.5rem' }}>
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
          <a
            href="https://calendar.app.google/iR8J2gEs8mUMxEct6"
            target="_blank"
            rel="noopener"
          >
            Schedule a Meeting
          </a>
        </nav>

        <div
          style={{
            fontFamily: 'Courier New, monospace',
            fontSize: '0.8rem',
            color: 'var(--text-secondary)',
          }}
        >
          {freshness && (
            <>
              <span>{marketClosed ? 'Final:' : 'Last updated:'} {freshness}</span>
              {isSynthetic && (
                <span
                  style={{
                    marginLeft: '0.5rem',
                    padding: '0.1rem 0.4rem',
                    border: '1px solid var(--accent-amber)',
                    color: 'var(--accent-amber)',
                    borderRadius: '3px',
                  }}
                >
                  SYNTHETIC
                </span>
              )}
            </>
          )}
        </div>
      </header>

      {loading && (
        <div aria-busy="true" aria-label="Loading options data">
          <div className="skeleton-card" style={{ height: '260px' }} />
          <div className="skeleton-card" style={{ height: '564px' }} />
          <div className="skeleton-card" style={{ height: '564px' }} />
          <div className="skeleton-card" style={{ height: '434px' }} />
          <div className="skeleton-card" style={{ height: '394px' }} />
          <div className="skeleton-card" style={{ height: '534px' }} />
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
          <LevelsPanel
            levels={correctedLevels}
            spotPrice={data.spotPrice}
            prevClose={data.prevClose}
            expirationMetrics={data.expirationMetrics}
            expirations={data.expirations}
            selectedExpiration={displayExpiration}
            onExpirationChange={setSelectedExpiration}
            capturedAt={data.capturedAt}
          />

          <GammaInflectionChart
            spotPrice={data.spotPrice}
            levels={correctedLevels}
          />

          <GexProfile
            contracts={data.contracts}
            spotPrice={data.spotPrice}
            levels={correctedLevels}
          />

          <FixedStrikeIvMatrix
            contracts={data.contracts}
            spotPrice={data.spotPrice}
            expirations={data.expirations}
            capturedAt={data.capturedAt}
          />

          <TermStructure
            expirationMetrics={data.expirationMetrics}
            capturedAt={data.capturedAt}
          />

          <VolSmile
            contracts={filteredContracts}
            spotPrice={data.spotPrice}
            expiration={displayExpiration}
            sviFit={currentSviFit}
            underlying={data.underlying}
          />

          <RiskNeutralDensity
            fits={sviFits.byExpiration}
            spotPrice={data.spotPrice}
            capturedAt={data.capturedAt}
          />

          <VolSurface3D
            contracts={data.contracts}
            spotPrice={data.spotPrice}
            capturedAt={data.capturedAt}
            fits={sviFits.byExpiration}
            sviSource={sviFits.source}
            underlying={data.underlying}
          />
        </>
      )}
    </div>
  );
}
