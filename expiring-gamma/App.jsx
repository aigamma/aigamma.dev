import '../src/styles/theme.css';
import '../src/styles/lab.css';
import ErrorBoundary from '../src/ErrorBoundary';
import Menu from '../src/components/Menu';
import TopNav from '../src/components/TopNav';
import ExpiringGamma from '../src/components/ExpiringGamma';

// Expiration Concentration lab. One Netlify function
// (netlify/functions/expiring-gamma.mjs) reads the latest intraday
// SPX ingest, aggregates per-expiration call and put dollar gamma
// at the run's spot price, and feeds a single Plotly bar chart that
// renders calls upward in coral and puts downward in blue around the
// y=0 zero line — a "what would unwind if spot stayed here" view of
// the dealer-hedging book by expiration.
//
// The page intentionally has no controls. A reader who wants to see
// the gamma profile across STRIKES (rather than across EXPIRATIONS)
// has the GEX Profile and Gamma Inflection charts on the main
// dashboard; this surface answers a different question — which
// dates carry the largest scheduled gamma roll-off — that the rest
// of the dashboard does not directly visualize.
//
// Data scope: every expiration the live ingest pipeline captures.
// Currently the ingest targets the next 9 monthly OPEX dates and
// every weekly ≤30 calendar days out, so the chart spans roughly
// today through 9 months out. LEAPS-style expirations 1+ years out
// are not in the live pipeline and therefore do not render here.

export default function App() {
  return (
    <div className="app-shell lab-shell expiring-gamma-shell">
      <header className="lab-header">
        <div className="lab-brand">
          <a href="/" className="lab-logo-link" aria-label="Return to aigamma.com homepage">
            <img src="/logo.webp" alt="aigamma.com" className="lab-logo" />
          </a>
          <span
            className="lab-badge"
            title="Expiration Concentration · per-expiration call / put dollar gamma scheduled to expire at current spot"
          >
            <span className="lab-badge__desktop-text">Expiration Concentration</span>
            <span className="lab-badge__mobile-text">Expiring γ</span>
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

      <section className="lab-slot expiring-gamma-slot">
        <ErrorBoundary><ExpiringGamma /></ErrorBoundary>
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
            Each bar is one listed SPX expiration. The height above the
            zero line is the total dollar gamma carried by every call
            at that expiration; the depth below the zero line is the
            same sum across puts, rendered downward so calls and puts
            on the same date read as a mirrored pair. Both are quoted
            in dollars per 1% move at the current spot price — the
            standard SpotGamma-style dealer-hedging unit.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            "If spot remains where it is" is the implicit framing.
            Every per-contract gamma value used in the sum was
            computed at the run's spot price by the ingest, so the
            bar at any expiration is exactly the gamma that would
            roll off on that date assuming the index stays flat
            between now and then. This is a frozen-book measure: it
            ignores subsequent dealer rebalancing, OI changes, and
            spot drift, so the right reading is "potential unwind
            magnitude", not "forecast hedging flow".
          </p>
          <p style={{ margin: 0 }}>
            The data scope follows the live ingest pipeline — the
            next nine monthly OPEX dates plus every weekly within
            thirty calendar days of today. Far-dated LEAPS contracts
            are not in the pipeline and therefore not in the chart;
            the bars stop at roughly nine months out. The most
            visually prominent bars are typically the next quarterly
            OPEX, the next monthly OPEX, and the front-week 0DTE
            stack, which together represent the bulk of dealer gamma
            that is structurally certain to unwind in the near term.
          </p>
        </div>
      </div>

      <footer className="lab-footer">
        <span className="lab-footer-line">
          AI Gamma · Expiration Concentration · per-expiration γ scheduled to roll off · v0.1.0
        </span>
        <a href="/" className="lab-footer-home">Return Home</a>
      </footer>
    </div>
  );
}
