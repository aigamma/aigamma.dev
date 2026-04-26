import '../src/styles/theme.css';
import '../src/styles/lab.css';
import '../src/styles/vix.css';
import ErrorBoundary from '../src/ErrorBoundary';
import Menu from '../src/components/Menu';
import TopNav from '../src/components/TopNav';
import Chat from '../src/components/Chat';
import useVixData from '../src/hooks/useVixData';
import VixHeaderProfile from '../src/components/vix/VixHeaderProfile';
import VixTermStructure from '../src/components/vix/VixTermStructure';
import VixContangoHistory from '../src/components/vix/VixContangoHistory';
import VixVrp from '../src/components/vix/VixVrp';
import VixOuMeanReversion from '../src/components/vix/VixOuMeanReversion';
import VixVolOfVol from '../src/components/vix/VixVolOfVol';
import VixCrossAsset from '../src/components/vix/VixCrossAsset';
import VixSkewIndices from '../src/components/vix/VixSkewIndices';
import VixRegimeMatrix from '../src/components/vix/VixRegimeMatrix';
import VixStrategyOverlay from '../src/components/vix/VixStrategyOverlay';

// /vix lab — full profile catalog of VIX models.
//
// Sole data source: public.vix_family_eod (sourced from Massive Indices
// Starter, see CLAUDE.md note in the table comment) + the SPX OHLC + 30d
// CM IV + 20d HV columns of public.daily_volatility_stats (sourced from
// ThetaData per the data-provenance rule). The /api/vix-data endpoint
// returns both in a single payload so every card on the page reads from
// one network call.
//
// Reading sequence (top to bottom):
//   1. VixHeaderProfile     — current Friday-close pill grid with 1y ranks
//   2. VixTermStructure     — 5-point curve + 1wk / 1mo / median overlays
//   3. VixContangoHistory   — historical VIX3M/VIX ratio with regime fills
//   4. VixVrp               — VIX vs SPX 20d realized vol (the VRP picture)
//   5. VixOuMeanReversion   — Ornstein-Uhlenbeck calibration + 60d forward
//   6. VixVolOfVol          — VVIX vs realized vol-of-VIX (vol-of-vol VRP)
//   7. VixCrossAsset        — VIX/VXN/RVX/OVX/GVZ on shared axis + 1y ranks
//   8. VixSkewIndices       — Cboe SKEW vs Nations SDEX overlay
//   9. VixRegimeMatrix      — 4-state classification + N-day transitions
//  10. VixStrategyOverlay   — Cboe option-strategy benchmarks vs SPX
//
// Each section is a separate ErrorBoundary so a render failure in one
// model card never blanks the rest of the page.

export default function App() {
  const { data, loading, error } = useVixData();

  return (
    <div className="app-shell lab-shell">
      <header className="lab-header">
        <div className="lab-brand">
          <a href="/" className="lab-logo-link" aria-label="Return to aigamma.com homepage">
            <img src="/logo.webp" alt="aigamma.com" className="lab-logo" />
          </a>
          <span
            className="lab-badge"
            title="VIX — full profile catalog of VIX models"
          >
            <span className="lab-badge__desktop-text">VIX</span>
            <span className="lab-badge__mobile-text">VIX</span>
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
        <div aria-busy="true" aria-label="Loading VIX history">
          <div className="skeleton-card" style={{ height: '180px' }} />
          <div className="skeleton-card" style={{ height: '380px' }} />
          <div className="skeleton-card" style={{ height: '320px' }} />
          <div className="skeleton-card" style={{ height: '460px' }} />
          <div className="skeleton-card" style={{ height: '500px' }} />
          <div className="skeleton-card" style={{ height: '460px' }} />
          <div className="skeleton-card" style={{ height: '420px' }} />
          <div className="skeleton-card" style={{ height: '380px' }} />
          <div className="skeleton-card" style={{ height: '600px' }} />
          <div className="skeleton-card" style={{ height: '520px' }} />
        </div>
      )}

      {error && (
        <div className="card" style={{ padding: '2rem', color: 'var(--accent-coral)' }}>
          <div>Error loading VIX data: {error}</div>
        </div>
      )}

      {data && (
        <>
          <ErrorBoundary><VixHeaderProfile data={data} /></ErrorBoundary>
          <ErrorBoundary><VixTermStructure data={data} /></ErrorBoundary>
          <ErrorBoundary><VixContangoHistory data={data} /></ErrorBoundary>
          <ErrorBoundary><VixVrp data={data} /></ErrorBoundary>
          <ErrorBoundary><VixOuMeanReversion data={data} /></ErrorBoundary>
          <ErrorBoundary><VixVolOfVol data={data} /></ErrorBoundary>
          <ErrorBoundary><VixCrossAsset data={data} /></ErrorBoundary>
          <ErrorBoundary><VixSkewIndices data={data} /></ErrorBoundary>
          <ErrorBoundary><VixRegimeMatrix data={data} /></ErrorBoundary>
          <ErrorBoundary><VixStrategyOverlay data={data} /></ErrorBoundary>
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
          What this page measures
        </div>
        <div style={{ color: 'var(--text-secondary)', lineHeight: 1.65, fontSize: '0.95rem' }}>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Snapshot.</strong>{' '}
            Friday-close levels for the five-point Cboe vol term structure
            (VIX1D / VIX9D / VIX / VIX3M / VIX6M), VVIX (the option-implied
            vol of VIX itself), the two skew constructions (Cboe SKEW and
            Nations SkewDex), and two derived term-structure scalars
            (contango ratio = VIX3M ÷ VIX, curvature = (VIX9D + VIX3M)/2 −
            VIX). Each cell carries a 1-year percentile rank against its own
            trailing 252-day distribution as the color cue, so the eye reads
            "where in the distribution is this number" without parsing the
            value.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Term Structure.</strong>{' '}
            Five points plotted in days-to-expiration on a log scale so the
            front of the curve (1D, 9D, 30D) spaces out. Three overlays —
            today, one week ago, one month ago — read together as a flow
            sequence; the dotted line is the per-tenor median across the
            full 3-year backfill, providing a static baseline against which
            the live shape is interpreted. An upward-sloping curve is
            contango (the empirically-typical state in calm regimes), a
            downward slope is backwardation (urgent near-term vol that
            historically precedes the bulk of meaningful drawdowns).
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Contango History.</strong>{' '}
            VIX3M ÷ VIX over the full backfill window, with conditional fills
            anchoring on the 1.0 line. Green band is contango (curve sloping
            up, calm); coral band is backwardation (curve sloping down,
            warning). The chart makes durable regime episodes visible at a
            glance without parsing the underlying VIX level itself.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>VRP for VIX.</strong>{' '}
            VIX is itself an implied vol; the canonical comparison is to SPX
            realized vol over the same horizon. This card overlays VIX
            against the 20-day Yang-Zhang realized vol of SPX, on a shared
            volatility axis, with SPX itself as a soft area-fill background
            for context. The gap between the two lines is the VIX-style VRP;
            green where VIX exceeds RV (the typical state where options
            price more vol than the underlying delivers), coral where RV
            exceeds VIX (rare stress regime where realized has overshot
            option-market expectations).
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Mean Reversion.</strong>{' '}
            Log-VIX has empirically well-behaved Ornstein-Uhlenbeck dynamics:
            d log(VIX) = κ(θ − log(VIX)) dt + σ dW. The card shows the OLS
            calibration of κ (mean-reversion speed), θ (long-term mean in VIX
            level units), σ (vol of log-VIX), and the implied half-life
            ln(2)/κ. The dashed forward line projects the OU expectation 60
            trading days ahead of the latest spot — E[log VIX_T | log VIX_0]
            = θ + (log VIX_0 − θ) · exp(−κ T). Readers can see how quickly
            current levels are expected to drift back to θ under the model.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Vol of Vol.</strong>{' '}
            VVIX is the option-implied 30-day vol on VIX itself; realized
            vol-of-VIX is the 30-day annualized standard deviation of log
            changes in the VIX level. Plotted on the same scale they form a
            second-order VRP: when VVIX persistently exceeds realized
            vol-of-VIX the option market is over-pricing future VIX
            fluctuation. The bottom strip shows the implied-minus-realized
            gap as a bar series so the sign and magnitude are read at a
            glance.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Cross-Asset Vol.</strong>{' '}
            Five Cboe-published implied vol indices on shared axes, indexed
            to 100 at the start of the backfill so the reader sees relative
            regime motion rather than absolute level. The 1-year percentile
            rank table below surfaces divergences — equity vol low while
            crude vol elevated would imply a single-asset stress, not a
            broad risk-on / risk-off shift.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Skew Indices.</strong>{' '}
            Two distinct constructions of the same underlying tail-pricing
            asymmetry — Cboe SKEW from the cumulants of the SPX option-
            implied risk-neutral density, Nations SkewDex from a different
            cumulant decomposition. Plotted on dual axes, divergence between
            the two methodologies is informative about which estimator is
            being driven by tail vs near-money asymmetry on a given day.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Regime Matrix.</strong>{' '}
            Discrete VIX regime classifier with thresholds at 12 / 18 / 30 —
            roughly the 30 / 60 / 90th percentiles of the 1990-onward daily
            VIX distribution and the convention used in Cboe's own regime
            research. Four states (calm / normal / elevated / stressed); the
            card shows the current state, time spent in each over the
            backfill, and the empirical 1-day / 5-day / 21-day-ahead
            transition matrices. The diagonal is regime persistence;
            off-diagonal cells visualize how regimes flow into each other.
          </p>
          <p style={{ margin: 0 }}>
            <strong style={{ color: 'var(--text-primary)' }}>Strategy Benchmarks.</strong>{' '}
            Four Cboe option-strategy benchmark indices that monetize vol
            exposure in distinct ways: BXM (buy-write at-the-money calls),
            BXMD (buy-write 30-delta calls), BFLY (iron butterfly), CNDR
            (iron condor). Plotted as growth-of-1 cumulative returns
            indexed at backfill start so the reader sees realized payoff
            across the full 3-year regime cycle. SPX cash is overlaid as
            the buy-and-hold benchmark. Annualized return, vol, Sharpe, and
            maximum drawdown for each strategy in the table below the chart.
          </p>
        </div>
      </div>

      <ErrorBoundary>
        <Chat
          context="vix"
          welcome={{
            quick:
              'Ask about the VIX term structure, the OU mean-reversion model, vol-of-vol, the SKEW / SDEX skew constructions, the regime classification thresholds, or how the Cboe strategy benchmark indices monetize vol.',
            deep:
              'Deep Analysis mode — longer responses on Ornstein-Uhlenbeck calibration math, the vol-of-vol risk premium decomposition, Cboe SKEW vs Nations SDEX construction differences, and the strategy index recipe definitions.',
          }}
        />
      </ErrorBoundary>

      <footer className="lab-footer">
        <span className="lab-footer-line">
          AI Gamma · VIX catalog · term / VRP / OU / vol-of-vol / cross-asset / skew / regime / strategy · v0.1.0
        </span>
        <a href="/" className="lab-footer-home">Return Home</a>
      </footer>
    </div>
  );
}
