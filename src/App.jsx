import { useMemo, useState } from 'react';
import './styles/theme.css';
import VolSmile from './components/VolSmile';
import LevelsHistory from './components/LevelsHistory';
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

export default function App() {
  const [selectedExpiration, setSelectedExpiration] = useState(null);
  const { data, loading, error } = useOptionsData({
    underlying: 'SPX',
    snapshotType: 'intraday',
  });

  const displayExpiration =
    selectedExpiration || (data && data.expirations && data.expirations[0]) || null;

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
  }, [data?.levels, data?.contracts, data?.spotPrice, data?.capturedAt]);

  const freshness = data ? formatFreshness(data.capturedAt) : null;
  const isSynthetic = data && data.source === 'synthetic';
  const regime = data ? classifyGammaRegime(correctedLevels, data.spotPrice) : null;

  return (
    <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '1.5rem' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '0.75rem',
          marginBottom: '1rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <img
            src="/logo.png"
            alt="aigamma.com"
            style={{
              height: '3.2rem',
              display: 'block',
            }}
          />
          {regime && (
            <span
              title={regime.hint}
              style={{
                fontFamily: 'Courier New, monospace',
                fontSize: '1rem',
                padding: '0.55rem 0.75rem',
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
              {regime.label}
            </span>
          )}
        </div>

        <div
          style={{
            fontFamily: 'Courier New, monospace',
            fontSize: '0.8rem',
            color: 'var(--text-secondary)',
          }}
        >
          {freshness && (
            <>
              <span>AS OF {freshness}</span>
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
        <div className="card text-muted" style={{ padding: '2rem', textAlign: 'center' }}>
          Loading options data...
        </div>
      )}

      {error && (
        <div className="card" style={{ padding: '2rem', color: 'var(--accent-coral)' }}>
          Error: {error}
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

          <GexProfile
            contracts={data.contracts}
            spotPrice={data.spotPrice}
            levels={correctedLevels}
          />

          <GammaInflectionChart
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

      <LevelsHistory underlying="SPX" snapshotType="intraday" />
    </div>
  );
}
