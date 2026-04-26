import '../src/styles/theme.css';
import '../src/styles/lab.css';
import ErrorBoundary from '../src/ErrorBoundary';
import Menu from '../src/components/Menu';
import TopNav from '../src/components/TopNav';
import EarningsCalendar from '../src/components/EarningsCalendar';

// Earnings Calendar lab. Two stacked surfaces fed by one Netlify
// function (netlify/functions/earnings.mjs):
//
//   Top:    Scatter chart of the next ~5 trading days of earnings
//           releases, plotted by server-computed implied move
//           (vertical) versus calendar date (horizontal). Each ticker
//           is one dot, color-coded by reporting session — accent-blue
//           for Before Market Open, accent-coral for After Market
//           Close, neutral gray for Unknown. Hover surfaces the full
//           per-ticker detail (company name, revenue estimate, EPS
//           estimate, confirm date, straddle expiration / strike,
//           ATM IV, computed implied move).
//
//   Bottom: Calendar grid for the next four weeks. Each row is a
//           trading week (Mon-Fri) with two columns per weekday
//           (BMO and AMC). Cells contain ordered ticker lists,
//           sorted descending by revenue estimate so the largest
//           reporters land at the top of the cell — which is the one
//           explicit improvement on the EarningsWhispers calendar
//           that motivated this page (EW orders by their own
//           sentiment-vote total, which conflates reader interest
//           with company size and bumps small popular tickers above
//           market-moving large caps).
//
// Universe filter:
//   q1RevEst >= $1B (with qSales*1e6 fallback for null estimates).
//   This intentionally truncates EW's 200-300-name peak-day universe
//   to the 30-100 names where options-driven implied moves are
//   liquid and the day's institutional positioning matters. See
//   netlify/functions/earnings.mjs for the rationale.
//
// Data lineage:
//   EarningsWhispers /api/caldata/{YYYYMMDD} — undocumented JSON
//   endpoint, one call per calendar day. Requires an antiforgery
//   cookie bootstrapped via GET /calendar; see the function file.
//   Per-ticker implied move is then derived server-side from the
//   Massive options snapshot endpoint for the chart-window subset.

export default function App() {
  return (
    <div className="app-shell lab-shell earnings-shell">
      <header className="lab-header">
        <div className="lab-brand">
          <a href="/" className="lab-logo-link" aria-label="Return to aigamma.com homepage">
            <img src="/logo.webp" alt="aigamma.com" className="lab-logo" />
          </a>
          <span
            className="lab-badge"
            title="Earnings · upcoming releases by implied move and date, scraped from EarningsWhispers"
          >
            <span className="lab-badge__desktop-text">Earnings</span>
            <span className="lab-badge__mobile-text">Earnings</span>
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
        <span
          className="lab-badge lab-badge--coral"
          title="This page is a v0 — implied moves are currently not rendering on weekends/off-hours because Massive's snapshot endpoint returns a null underlying_asset.price outside live sessions. A grouped-bars spot fallback (already proven in scan.mjs) is the planned fix."
          style={{
            borderColor: 'var(--accent-coral)',
            color: 'var(--accent-coral)',
          }}
        >
          <span className="lab-badge__desktop-text">Under Construction</span>
          <span className="lab-badge__mobile-text">WIP</span>
        </span>
      </header>

      <section className="lab-slot earnings-slot">
        <ErrorBoundary><EarningsCalendar /></ErrorBoundary>
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
            Each upcoming earnings release on the next five trading
            days is plotted as a single dot. The horizontal axis is the
            calendar date the company reports; the vertical axis is the
            options-market implied range as a percent of spot. The
            implied range is the 0.85-scaled at-the-money straddle
            midprice on the soonest expiration that captures the
            earnings event — same-day or later for Before-Open
            reporters, next-day or later for After-Close reporters,
            since same-day options settle at 4 PM ET before an
            after-close release. The 0.85 factor is the SpotGamma
            convention; it scales raw straddle premium down to the
            empirically-realized post-event one-standard-deviation
            range. Color encodes the reporting session: blue for Before
            Market Open, coral for After Market Close, gray for
            unconfirmed. Hover any dot for the full per-ticker profile,
            including the dollar implied range, the ATM strike, and
            the straddle expiration.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            Implied range is computed server-side from the Massive
            options snapshot. For each ticker we identify the soonest
            listed expiration that captures the earnings event (gated
            by reporting session as above), then pick the single strike
            nearest spot that has both a call and a put listed at that
            expiration, and compute 0.85 × (call mid + put mid). When
            the ATM strike has no usable bid/ask or last-trade price on
            either leg, the ticker drops off the chart — earnings
            concentrate options liquidity, so a missing ATM mid is a
            strong signal that the data is unreliable for that ticker
            on this snapshot rather than a sign that we should fall
            back to a less direct estimate.
          </p>
          <p style={{ margin: 0 }}>
            The four-week upcoming grid below the chart lists every
            release with a revenue estimate above one billion dollars,
            sorted within each Before-Open / After-Close cell by
            revenue estimate descending. EarningsWhispers is the
            universe source; their API orders rows by the site's
            own sentiment-vote total, which conflates reader interest
            with company size — sorting by revenue instead surfaces the
            day's most market-moving reporters first. The revenue
            estimate is q1RevEst from EW, with prior-quarter actual
            sales as a fallback when the estimate is null.
          </p>
        </div>
      </div>

      <footer className="lab-footer">
        <span className="lab-footer-line">
          AI Gamma · Earnings Calendar · upcoming releases by implied move and date · v0.1.0
        </span>
        <a href="/" className="lab-footer-home">Return Home</a>
      </footer>
    </div>
  );
}
