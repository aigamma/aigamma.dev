import '../src/styles/theme.css';
import '../src/styles/lab.css';
import ErrorBoundary from '../src/ErrorBoundary';
import Menu from '../src/components/Menu';
import TopNav from '../src/components/TopNav';
import SpxHeatmap from '../src/components/SpxHeatmap';

// SPX Heatmap lab. A market-cap-weighted GICS-sector treemap of every
// S&P 500 constituent, colored by the day's percent change from the
// previous close. The layout fills the full viewport height minus
// chrome so small-cap tiles get more area than the typical fixed-
// aspect-ratio finviz-style heatmap, which is the explicit "more
// tickers legible" UX target this surface was built to address.
//
// Data lineage:
//   tickers + market-cap weights:  SPDR SPY holdings xlsx
//                                  (regenerated from
//                                  scripts/backfill/sp500-roster.mjs)
//   GICS sectors:                  github.com/datasets/s-and-p-500-companies
//   prices:                        Massive Stock snapshot (1 call), with
//                                  ThetaData EOD via Supabase as a
//                                  graceful fallback to 11 sector ETFs
//                                  if the Massive Stocks product is not
//                                  entitled on the existing API key
//
// See netlify/functions/heatmap.mjs for the join logic and
// src/components/SpxHeatmap.jsx for the squarified treemap renderer.
export default function App() {
  return (
    <div className="app-shell lab-shell heatmap-shell">
      <header className="lab-header">
        <div className="lab-brand">
          <a href="/" className="lab-logo-link" aria-label="Return to aigamma.com homepage">
            <img src="/logo.webp" alt="aigamma.com" className="lab-logo" />
          </a>
          <span
            className="lab-badge"
            title="SPX Heatmap · market-cap-weighted, % change"
          >
            <span className="lab-badge__desktop-text">SPX Heatmap</span>
            <span className="lab-badge__mobile-text">Heatmap</span>
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

      <section className="lab-slot heatmap-slot">
        <ErrorBoundary><SpxHeatmap /></ErrorBoundary>
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
            Every S&amp;P 500 constituent rendered as a tile sized by
            its float-adjusted market-cap weight in the index and
            colored by the day's percent change from the previous
            close. Tiles are grouped by GICS sector so a reader can see
            sector composition (the eleven outer regions) and intra-day
            breadth (red vs green within each region) at the same time.
            The neutral band is ±0.25%; movement beyond ±2% saturates
            the color. Hover a tile for the full company name, exact
            weight, last price, and previous close.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            Layout is a nested squarified treemap (Bruls, Huijsing,
            Van Wijk 2000): one outer pass that lays the eleven sectors
            in the page rectangle sized by sector total weight, then
            one inner pass per sector that lays its constituents in
            the sector rectangle sized by individual weight.
            Squarification minimises the worst aspect ratio of any
            tile, which keeps tiles closer to square than a
            slice-and-dice algorithm would — the right trade-off when
            the goal is text legibility on every tile rather than a
            single dominant axis to scan along.
          </p>
          <p style={{ margin: 0 }}>
            Constituent list and market-cap weights are pulled from
            the SPDR SPY ETF holdings file (SSGA), which tracks SPX
            1:1 by index methodology and is therefore the canonical
            public list of names + float-adjusted weights. GICS sector
            classification is joined from the
            datasets/s-and-p-500-companies CSV. Live prices come from
            Massive's stock snapshot endpoint (one call per page load,
            edge-cached for 60 s during market hours). When that
            endpoint is unavailable the page falls back to the eleven
            SPDR sector ETFs in ThetaData EOD, sized by each sector's
            true SP500 weight.
          </p>
        </div>
      </div>

      <footer className="lab-footer">
        <span className="lab-footer-line">
          AI Gamma · SPX Heatmap · market-cap-weighted, % change · v0.1.0
        </span>
        <a href="/" className="lab-footer-home">Return Home</a>
      </footer>
    </div>
  );
}
