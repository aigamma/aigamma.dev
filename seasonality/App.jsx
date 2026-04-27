import '../src/styles/theme.css';
import '../src/styles/lab.css';
import ErrorBoundary from '../src/ErrorBoundary';
import Menu from '../src/components/Menu';
import TopNav from '../src/components/TopNav';
import SeasonalityGrid from '../src/components/SeasonalityGrid';

// Intraday seasonality lab. A bordered 14-column grid of SPX's
// cumulative % change since the prior session's close, sampled at
// 30-minute RTH bars (10:00, 10:30, ..., 4:00). The top section
// stacks rolling 5 / 10 / 20 / 30 / 40 day column-wise averages so a
// reader can see which times of day typically carry the drift and
// where the mean-reversion sits; the bottom section lists the eight
// most recent trading sessions as individual rows so today's shape
// can be compared against the historical pattern at a glance.
//
// Data source: ThetaData /v3/index/history/ohlc?symbol=SPX&interval=30M
// persists into public.spx_intraday_bars via scripts/backfill/
// spx-intraday-bars.mjs. The prior close for each row's denominator
// comes from public.daily_volatility_stats.spx_close on the next-
// earlier trading_date — the two tables share the ThetaData sole-
// source lineage so the postmarket settlement window is consistent
// between the numerator (intraday close at time T) and the
// denominator (prior session's official EOD close). No secondary
// feeds (Yahoo / FRED / Google) fill gaps; any date ThetaData does
// not cover at query time stays absent from the grid rather than
// getting backfilled from a non-normalized source.
export default function App() {
  return (
    <div className="app-shell lab-shell">
      <header className="lab-header">
        <div className="lab-brand">
          <span
            className="lab-badge"
            title="Seasonality · 30-minute SPX cumulative change vs prior close"
          >
            <span className="lab-badge__desktop-text">Seasonality</span>
            <span className="lab-badge__mobile-text">Seasonality</span>
          </span>
        </div>
        <TopNav current="seasonality" />
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

      <section className="lab-slot">
        <ErrorBoundary><SeasonalityGrid /></ErrorBoundary>
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
          what this grid measures
        </div>
        <div style={{ color: 'var(--text-secondary)', lineHeight: 1.65, fontSize: '0.95rem' }}>
          <p style={{ margin: '0 0 0.7rem' }}>
            Each cell is SPX's cumulative move from the prior session's
            4:00 PM close through the end of that 30-minute window.
            The 10:00 column reflects the first half-hour after the
            open; the 4:00 column is the full session's close-to-close
            change. Green cells gained since yesterday; red cells
            lost. Color intensity scales with magnitude so a +0.60%
            cell reaches full saturation and smaller moves read as a
            wash.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            The top rows aggregate across trading days rather than
            showing a single day. A <strong style={{ color: 'var(--text-primary)' }}>40 Day Avg</strong>{' '}
            cell at 11:30, for example, is the arithmetic mean of the
            last 40 sessions' cumulative change at 11:30. Read
            column-by-column, it traces the average intraday
            trajectory. Shorter windows (5, 10, 20, 30) show whether
            the recent regime has diverged from the longer baseline.
          </p>
          <p style={{ margin: 0 }}>
            Source is ThetaData Index Standard (30-minute SPX bars)
            joined against the same provider's EOD close table. No
            secondary feeds are blended in to extend history; any
            tier-walled gap stays null rather than getting filled
            from a non-normalized source.
          </p>
        </div>
      </div>

      <footer className="lab-footer">
        <span className="lab-footer-line">
          AI Gamma · SPX intraday seasonality · 30-min bars vs prior close · v0.1.0
        </span>
        <a href="/" className="lab-footer-home">Return Home</a>
      </footer>
    </div>
  );
}
