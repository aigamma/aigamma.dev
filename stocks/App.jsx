import '../src/styles/theme.css';
import '../src/styles/lab.css';
import ErrorBoundary from '../src/ErrorBoundary';
import Menu from '../src/components/Menu';
import TopNav from '../src/components/TopNav';
import RotationChart from '../src/components/RotationChart';
import SectorPerformanceBars from '../src/components/SectorPerformanceBars';

// Stock Rotations lab — sister of /rotations/, but for single-name
// stocks instead of GICS sector ETFs. Same two-card layout: a Stock
// Performance bar trio (1D / 1W / 1M horizontal bars across eleven
// hand-curated top option-volume single names) on top, a four-quadrant
// Relative Stock Rotations scatter across a wider 20-name set
// underneath. The bars are first so a reader's mousewheel and click
// drag-zoom land on a non-interactive surface during the initial
// scroll; the scatter, which uses a Plotly dragmode that captures
// wheel and click on the canvas, sits at the bottom where a reader
// has already chosen to engage with it. This layout convention is
// inherited from /rotations/ so the two pages feel like vertical
// twins rather than two unrelated dashboards.
//
// The bars and the rotation chart use the SAME components mounted on
// the /rotations page (SectorPerformanceBars and RotationChart) — the
// generalization happened in those component files, not here. The
// bars receive endpoint='/api/stock-performance' and a 'Stock
// Performance' title; the rotation chart receives a symbols array of
// the 20 names plus a 'Relative Stock Rotations' title. The /api/
// rotations endpoint already supported a ?symbols= query param before
// this page existed, so the rotation side is a pure pass-through.
//
// Universe choices:
//
//   Bars (11 stocks): NVDA, TSLA, INTC, AMD, AMZN, AAPL, MU, MSFT,
//   MSTR, META, PLTR. Ranked by 2026-04-26 Barchart options-volume
//   roster descending; eleven was picked to match the eleven GICS
//   sector slots on /rotations so a reader scanning both pages sees
//   matched panel heights.
//
//   Rotation (20 stocks): the eleven bar names plus GOOGL, ORCL,
//   NFLX, AVGO, TSM, QCOM, MRVL, HOOD, COIN. The expansion adds
//   semis (AVGO / TSM / QCOM / MRVL), broker (HOOD), crypto exchange
//   (COIN), and the megacap-diversification trio (GOOGL / ORCL /
//   NFLX) so the rotation plane has enough breadth across sectors
//   to show non-trivial spatial separation. Twenty was chosen as
//   the practical density ceiling — more than that and the
//   crisscrossing trails on the four-quadrant plane become
//   illegible; the per-symbol toggle row inherited from
//   RotationChart lets a reader hide individual tickers to declutter
//   on demand.
//
// Data lineage: ThetaData /v3/stock/history/eod (Stock Value tier)
// feeds public.daily_eod via scripts/backfill/daily-eod.mjs. The 20
// stock symbols are appended to that script's DEFAULT_SYMBOLS list
// alongside the existing 14 ETF rotation universe, so a single nightly
// backfill run keeps both /rotations and /stocks fresh with no extra
// orchestration. SPY remains the benchmark all relative-strength math
// is computed against — for single-name stocks SPY is still the right
// market basis, the same reference point a vol trader uses to read
// "is this name leading or lagging the broad market this month?".

const STOCK_ROTATION_UNIVERSE = [
  'NVDA', 'TSLA', 'INTC', 'AMD', 'AMZN', 'AAPL', 'MU', 'MSFT',
  'MSTR', 'META', 'PLTR', 'GOOGL', 'ORCL', 'NFLX', 'AVGO', 'TSM',
  'QCOM', 'MRVL', 'HOOD', 'COIN',
];

export default function App() {
  return (
    <div className="app-shell lab-shell">
      <header className="lab-header">
        <div className="lab-brand">
          <span
            className="lab-badge"
            title="Stocks · top option-liquid single names, performance + rotation vs SPY"
          >
            <span className="lab-badge__desktop-text">Stocks</span>
            <span className="lab-badge__mobile-text">Stocks</span>
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

      <section className="lab-slot">
        <ErrorBoundary>
          <SectorPerformanceBars
            endpoint="/api/stock-performance"
            title="Stock Performance"
            noun="stock performance"
            labelField="symbol"
          />
        </ErrorBoundary>
      </section>

      <section className="lab-slot">
        <ErrorBoundary>
          <RotationChart
            symbols={STOCK_ROTATION_UNIVERSE}
            title="Relative Stock Rotations"
          />
        </ErrorBoundary>
      </section>

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
            <strong style={{ color: 'var(--text-primary)' }}>Top: Stock Performance.</strong>{' '}
            Three horizontal bar charts ranking eleven hand-curated top
            option-volume single-name stocks by total return over 1
            trading day, 5 trading days (one week), and 21 trading days
            (one month). Bars are sorted descending within each panel;
            the top bar is the day's leader, the bottom is the day's
            laggard. Green for positive, red for negative. The same
            stock can lead one panel and lag another; that divergence
            between short and long horizons is the same regime-shift
            signal the sister Sector Performance trio on /rotations
            surfaces, just narrowed to the eleven names a vol trader
            actually transacts in: NVDA, TSLA, INTC, AMD, AMZN, AAPL,
            MU, MSFT, MSTR, META, PLTR.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Bottom: Relative Stock Rotations.</strong>{' '}
            The same four-quadrant rotation plane as /rotations, mounted
            against twenty single-name stocks (the eleven bar names plus
            GOOGL, ORCL, NFLX, AVGO, TSM, QCOM, MRVL, HOOD, COIN). Each
            stock lands at coordinates (rotation ratio, rotation
            momentum), where the ratio is its relative-strength price
            ratio expressed as a percentage of its own slow EMA (Roy
            Mansfield's 1979 normalization) and momentum is the same
            percentage operation applied to the ratio with a faster
            smoother. The asymmetric slow/fast pair is what produces
            the clockwise spiral motion that characterises a rotation
            chart. Values above 100 on the x-axis mean the stock is
            leading SPY on price relative to its slow average; above
            100 on the y-axis means it's gaining on that lead relative
            to its fast average. The 1H · 1D · 1W toggle in the meta
            band chooses the lookback granularity (Day pairs a 5-day
            input smoother with a 63-day slow EMA and a 13-day fast
            EMA, Week resamples to ISO-week-end closes and uses a
            3-week smoother + 26-week slow + 5-week fast); the 5 · 10
            toggle chooses the trail length. Twenty was picked as the
            density ceiling for this plane; past that the crisscrossing
            trails get hard to read; the per-symbol toggle row above
            the chart lets you hide individual tickers on demand to
            declutter further.
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
            position. Same color language and same math as the sector
            rotation chart on /rotations, so reading skills transfer
            one-to-one between the two pages.
          </p>
          <p style={{ margin: 0 }}>
            Source is ThetaData Stock Value EOD prices in
            public.daily_eod, the same table that feeds the sector
            rotation page. The eleven bar names and twenty rotation
            names were curated from the 2026-04-26 Barchart options-
            volume roster, taking the highest-OV single-name stocks
            that also pass the "structurally always near the top" test
            (see docs/options-volume-roster.md for the editorial
            criteria). SPY remains the benchmark all relative-strength
            math is computed against. For single-name stocks SPY is
            still the right basis, the same reference point a vol
            trader uses to read whether a name is leading or lagging
            the broad market.
          </p>
        </div>
      </div>

      <footer className="lab-footer">
        <span className="lab-footer-line">
          AI Gamma · Stock Rotations · daily tail vs SPY · v0.1.0
        </span>
        <a href="/" className="lab-footer-home">Return Home</a>
      </footer>
    </div>
  );
}
