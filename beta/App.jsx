import '../src/styles/theme.css';
import '../src/styles/lab.css';
import ErrorBoundary from '../src/ErrorBoundary';
import Menu from '../src/components/Menu';
import TopNav from '../src/components/TopNav';
import SlotB, { slotName as slotBName } from './slots/SlotB';

// Beta Lab shell — single slot for models under test. Graduated
// slots (previously SlotA/SPX-vs-Vol-Flip and SlotC/Gamma-Index-
// Oscillator) now live on the main dashboard; SlotB remains as the
// one experimental surface in the lab. Current tenant: a US-only
// Economic Events listener with SPX implied-volatility overlays.
// Two parallel data fetches drive the page — /api/events-calendar
// (the FF weekly XML proxy, USD-only by default at the server) and
// /api/data?skip_contracts=1 (the SPX intraday snapshot for spot +
// per-expiration ATM IV). For each upcoming event the page
// resolves the next SPX expiration AT-OR-AFTER the event date and
// computes the IV-implied 1-σ move = spot × ATM IV × √(DTE/365),
// surfacing it inline on each schedule row, in the hero card, and
// in a horizontal TimelineStrip — one row per calendar day with
// event markers positioned at their hour-of-day X within a 6am–8pm
// window, sized by impact tier and colored by macro family. Today's
// row carries an accent-amber dashed NOW vertical line. Hover any
// marker for the full forecast / previous / implied-move tooltip.
// Four prior chart drafts (Plotly bar, custom SVG scatter with
// labels above dots, term-structure overlay with rangeslider, and
// a Key Events panel) were all discarded — they tried to encode
// too many dimensions on one canvas and lost legibility on any
// reasonable week of data; the timeline keeps only WHEN events
// sit relative to one another and to NOW, leaving the implied-move
// numbers and full event detail to the schedule rows below. The hero card runs a live
// HH:MM:SS countdown (1-second tick, paused on hidden tabs);
// an IntersectionObserver-driven sticky compact bar
// pins the next-event countdown to the top of the viewport when
// the hero scrolls out of view; per-day impact-count chips and a
// macro-family spotlight strip (FOMC / CPI / NFP / GDP / PCE / PPI
// / ISM / JOBS) summarize the week at a glance; click-to-expand
// rows expose the FF source link, an .ics calendar download, the
// per-event implied-move detail line, and a forecast-vs-previous
// interpretation tinted coral (hotter inflation) or green (more
// activity); a browser-Notification opt-in fires a 5-minute lead-
// time alert ahead of the next high-impact print. An earlier draft
// embedded a TradingView "Economic Calendar" iframe widget on top
// of the FF panel; that draft was abandoned because the TV widget
// rendered as a near-full-viewport white-screen funnel back to
// tradingview.com instead of usable content. An interim draft
// also carried a non-USD country-pill cluster in the FilterBar;
// the surface committed to USD-only for SPX-positioning and the
// country chrome was retired in favor of server-side filtering.
// A second interim draft used a Plotly bar chart with diagonal
// rotated x-axis labels for the implied-move visualization; on
// any week with more than ~6 events the labels collided into an
// unreadable wall and the chart was replaced with the custom-SVG
// scatter described above (Eric pointed at the /earnings page's
// dot-with-label-above pattern as the right reference).
// Visual language intentionally mirrors the production dashboard
// (dark card chrome, Courier New monospace accents, four-token
// palette) so that a component developed here can be dropped into
// the main App with zero restyle. The amber badge and warning strip
// are the only signals that this is a sandbox rather than the
// production dashboard.
//
// The logo in the header links back to the homepage and the Menu on
// the right of the header opens the nine-lab directory, so the page is
// reachable from and navigable to every other lab without leaving the
// keyboard. Crawlers are still blocked via the noindex meta tag in
// index.html and the robots.txt Disallow line.
export default function App() {
  return (
    <div className="app-shell lab-shell">
      <header className="lab-header">
        <div className="lab-brand">
          <span className="lab-badge" title="Beta Lab: experimental">
            BETA LAB
          </span>
        </div>
        <TopNav />
        <Menu />
      </header>

      <div className="lab-warning">
        <strong>Experimental.</strong>{' '}
        Models in these slots are under test. Data, math, and rendering may
        be incomplete, incorrect, or change without notice.
      </div>

      <section className="lab-slot">
        <div className="lab-slot-label">{slotBName}</div>
        <ErrorBoundary><SlotB /></ErrorBoundary>
      </section>

      <footer className="lab-footer">
        <span className="lab-footer-line">
          AI Gamma · internal beta lab · not for public consumption · v1.1.2
        </span>
      </footer>
    </div>
  );
}
