import '../src/styles/theme.css';
import '../src/styles/lab.css';
import ErrorBoundary from '../src/ErrorBoundary';
import Menu from '../src/components/Menu';
import TopNav from '../src/components/TopNav';
import SkewScanner from '../src/components/SkewScanner';

// SPX Skew Scanner lab. Two-tab interactive 2x2 quadrant view of the
// top-N options-active single-name stocks plotted by 30D ATM IV
// (vertical) versus 25-delta call-side or put-side skew (horizontal).
// Mirrors the analytical quadrant common to professional vol screeners
// — top half is "high IV" (regardless of skew sign), right half is
// "low skew" (call wing closer to ATM, or put wing closer to ATM
// depending on which tab is open). The four quadrants surface
// different setups: top-left = high vol with rich wing demand,
// top-right = high vol without wing demand, bottom-left = quiet vol
// with hidden wing demand, bottom-right = quiet vol with no wing
// pressure.
//
// Data lineage:
//   tickers + sectors:  Same options-volume roster JSON the /heatmap
//                       lab uses (src/data/options-volume-roster.json,
//                       generated from a Barchart screener CSV at
//                       C:\sheets\). This page slices the top 40 by
//                       default, which is the universe size that fits
//                       the 26 s Netlify sync cap with concurrency 6
//                       and stays visually scannable in the quadrant.
//   skew metrics:       Massive Options /v3/snapshot/options/{TICKER}
//                       endpoint, one call per ticker in parallel
//                       (concurrency 6). Per-ticker we pick the
//                       expiration in [21, 45] DTE closest to 30 days
//                       and report ATM IV (avg of call+put at the
//                       nearest-spot strike) plus the 25-delta call
//                       and put IVs, computing call_skew and put_skew
//                       as wing minus ATM in IV percentage points.
//                       See netlify/functions/scan.mjs for the full
//                       data-source decision and DB-strain analysis.

export default function App() {
  return (
    <div className="app-shell lab-shell scan-shell">
      <header className="lab-header">
        <div className="lab-brand">
          <span
            className="lab-badge"
            title="Scan · 25-delta call/put skew vs ATM IV across the top options-active single names"
          >
            <span className="lab-badge__desktop-text">Scan</span>
            <span className="lab-badge__mobile-text">Scan</span>
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

      <section className="lab-slot scan-slot">
        <ErrorBoundary><SkewScanner /></ErrorBoundary>
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
            Each ticker in the top-40 options-active universe is plotted
            in a 2x2 quadrant by 30-day ATM IV (vertical) and either
            25-delta call skew or 25-delta put skew (horizontal). Skew is
            measured as the wing IV minus the at-the-money IV in
            percentage points: call_skew = call_25Δ_iv − atm_iv,
            put_skew = put_25Δ_iv − atm_iv. Both axes are rendered as
            percentile ranks across the universe so the median split
            sits at the center cross-hairs regardless of the regime.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            For equity options the typical resting state is positive
            put skew (left wing richer than ATM, since downside protection
            commands a vol premium) and roughly flat or slightly negative
            call skew. Names that drift above the median on the call-skew
            tab are exhibiting unusual right-wing demand, frequently a
            signal of buyout speculation, earnings call positioning, or
            covered-call selling pressure pulling ATM down rather than
            wings up. Names that drift above the median on the put-skew
            tab are pricing tail-risk more aggressively than peers, which
            often clusters by sector during earnings or macro events.
          </p>
          <p style={{ margin: 0 }}>
            Data comes from Massive's options snapshot endpoint, one call
            per ticker in parallel at request time (no Supabase write
            path). The expiration target is 30 days; the function picks
            the listed expiration in the 21–45 DTE window that sits
            closest to that target. Edge-cached for 60 s during market
            hours and 15 minutes off-hours. If Massive returns auth
            errors or thin coverage the page falls back to a deterministic
            seed dataset and renders an amber banner so the placeholder
            is never confused with live data.
          </p>
        </div>
      </div>

      <footer className="lab-footer">
        <span className="lab-footer-line">
          AI Gamma · Scan · top by options volume, 25Δ wings vs ATM · v0.3.0
        </span>
        <a href="/" className="lab-footer-home">Return Home</a>
      </footer>
    </div>
  );
}
