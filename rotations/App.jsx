import '../src/styles/theme.css';
import '../src/styles/lab.css';
import ErrorBoundary from '../src/ErrorBoundary';
import QuantMenu from '../src/components/QuantMenu';
import RotationChart from '../src/components/RotationChart';
import SectorPerformanceBars from '../src/components/SectorPerformanceBars';

// Relative Sector Rotation lab. A four-quadrant scatter that places every
// sector ETF on a (rotation_ratio, rotation_momentum) plane with a
// trailing tail showing where it was on each of the previous N trading
// sessions. Components above 100 on the x-axis are leading the SPY
// benchmark on price; components above 100 on the y-axis are gaining on
// that lead. The four quadrants — Leading top-right, Weakening bottom-
// right, Lagging bottom-left, Improving top-left — describe a clockwise
// rotation that components typically traverse over weeks-to-months as
// regimes shift.
//
// Data source: ThetaData /v3/stock/history/eod (Stock Value tier) feeds
// public.daily_eod via scripts/backfill/daily-eod.mjs. The endpoint at
// netlify/functions/rotations.mjs computes the rotation ratio and the
// rotation momentum vs SPY and returns a tail of N daily points per
// component. The default universe matches the reference chart at
// C:\i\: SPY benchmark plus the eleven SPDR sector ETFs (XLB, XLC,
// XLE, XLF, XLI, XLK, XLP, XLRE, XLU, XLV, XLY) and three additional
// theme ETFs that appear on that chart (XBI biotech, XME metals &
// mining, KWEB China internet).
export default function App() {
  return (
    <div className="app-shell lab-shell">
      <header className="lab-header">
        <div className="lab-brand">
          <a href="/" className="lab-logo-link" aria-label="Return to aigamma.com homepage">
            <img src="/logo.webp" alt="aigamma.com" className="lab-logo" />
          </a>
          <span
            className="lab-badge"
            title="Sector Rotations · ratio + momentum vs SPX"
          >
            <span className="lab-badge__desktop-text">Sector Rotations</span>
            <span className="lab-badge__mobile-text">Rotations</span>
          </span>
        </div>
        <a
          href="/"
          className="lab-home-button lab-home-button--inline lab-home-button--split"
          aria-label="Return Home"
        >
          <span className="lab-home-button__desktop-text">Return Home</span>
          <span className="lab-home-button__mobile-text">Home</span>
        </a>
        <QuantMenu />
      </header>

      <section className="lab-slot">
        <ErrorBoundary><RotationChart /></ErrorBoundary>
      </section>

      <section className="lab-slot">
        <ErrorBoundary><SectorPerformanceBars /></ErrorBoundary>
      </section>

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
            <strong style={{ color: 'var(--text-primary)' }}>Top — Sector Rotations.</strong>{' '}
            Each component lands on the plane at coordinates (rotation
            ratio, rotation momentum). The ratio is the component's
            relative-strength price ratio expressed as a percentage of
            its own slow exponential moving average; the momentum is the
            ratio expressed as a percentage of its own fast exponential
            moving average. Two toggles in the card's meta band drive
            the view: the 1H · 1D · 1W toggle chooses the lookback
            granularity (Day pairs a 63-day ratio EMA with a 13-day
            momentum EMA, Week resamples to ISO-week-end closes and uses
            a 13-week / 5-week EMA pair, Hour requires intraday ETF
            bars that are not yet ingested into Supabase) and the
            5 · 10 · 20 · 40 · 60 toggle chooses the trail length —
            longer trails surface the canonical clockwise rotation
            spiral through Improving → Leading → Weakening → Lagging
            that is barely visible at the StockCharts default of 10
            steps. Day mode uses the StockCharts daily-RRG defaults
            (63-day / 13-day pair = 3-month range); week mode uses
            their weekly-RRG defaults (52-week / 13-week = 1-year
            range). Component positions read close to but not exactly
            the same as the proprietary StockCharts /RRG® reference —
            their implementation chains additional smoothing passes
            and likely uses total-return prices with dividend
            reinvestment, neither of which we replicate. Quadrant
            assignments and trail shapes match. Values above 100 on
            the x-axis mean the component
            is leading SPY on price; above 100 on the y-axis means
            it's gaining on that lead.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            Quadrants describe a typical clockwise rotation:{' '}
            <strong style={{ color: '#4a9eff' }}>Improving</strong>{' '}
            (top-left) → <strong style={{ color: '#2ecc71' }}>Leading</strong>{' '}
            (top-right) →{' '}
            <strong style={{ color: '#f0a030' }}>Weakening</strong>{' '}
            (bottom-right) →{' '}
            <strong style={{ color: '#e74c3c' }}>Lagging</strong>{' '}
            (bottom-left) → back to Improving. Each component carries a
            trail of dots showing where it was on each of the previous
            sessions; the larger labeled circle marks the latest
            position.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Bottom — Sector Performance.</strong>{' '}
            Three horizontal bar charts ranking the eleven GICS sectors
            by total return over 1 trading day, 5 trading days (one week),
            and 21 trading days (one month). Bars are sorted descending
            within each panel — the top bar is the day's leader, the
            bottom is the day's laggard. Green for positive, red for
            negative. The same sector can lead one panel and lag another;
            that divergence between short and long horizons is the
            primary regime-shift signal these bars are designed to
            surface.
          </p>
          <p style={{ margin: 0 }}>
            Source is ThetaData Stock Value EOD prices in
            public.daily_eod. The rotation scatter's component universe
            adds three theme ETFs to the eleven SPDR sectors (XBI biotech,
            XME metals &amp; mining, KWEB China internet); the sector
            bars below restrict themselves to the eleven SPDR sectors
            (XLB, XLC, XLE, XLF, XLI, XLK, XLP, XLRE, XLU, XLV, XLY) so
            the chart matches the conventional GICS-sector framing.
          </p>
        </div>
      </div>

      <footer className="lab-footer">
        <span className="lab-footer-line">
          AI Gamma · Sector Rotations · daily tail vs SPX · v0.1.0
        </span>
        <a href="/" className="lab-footer-home">Return Home</a>
      </footer>
    </div>
  );
}
