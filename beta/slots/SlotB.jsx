// Slot B — Economic Events Lab
//
// First experimental tenant of the /beta/ shell after the SlotA-graduates
// rotation cleared the lab. The page is the macro counterpart to the
// platform's options-driven dashboards: instead of computing dealer
// positioning off the SPX chain, it watches the macro calendar for the
// scheduled events that move the chain. Two stacked surfaces:
//
//   1. A near-full-viewport TradingView "Economic Calendar" iframe widget
//      that owns the top of the page. Fills the container's width and
//      most of the visible height (calc(100vh - 220px)) so a desk
//      reader gets a calendar surface roughly the size of a brokerage's
//      events panel rather than a postcard. The widget is embedded via
//      the official embed-widget-events.js script with a JSON config
//      payload — width:'100%', height:'100%', dark theme, transparent
//      background, US-only currency filter. No iframe sandbox: TV's
//      script generates the iframe itself and handles its own resize
//      messaging.
//
//   2. Below the widget, an analytics panel sourced from the official
//      Forex Factory weekly XML feed, proxied through
//      /api/events-calendar (see netlify/functions/events-calendar.mjs
//      for the rate-limit / CORS / parse rationale). Two views: the
//      "Upcoming" list with forecasts and previous values, and the
//      "Past Week" list that highlights events whose actual print
//      missed forecast. Until the feed exposes the actual field, the
//      Past Week column gates on whether the event has already passed
//      and surfaces the forecast/previous so a reader can mentally
//      check against whatever wire-service number they have in hand.
//
// Mobile: the widget collapses to a single-column 70vh block, the
// analytics tables stack, and font sizes track the rest of the lab
// chrome at the 480px / 768px breakpoints.

import { useEffect, useMemo, useRef, useState } from 'react';

export const slotName = 'Economic Events';

// Big Four event-name patterns we want to spotlight for SPX traders.
// Each entry is a regex tested against the FF "title" field; the first
// hit wins. The order is the priority cascade: if a row matches multiple
// (e.g., "FOMC Statement" matches both FOMC and the rate cluster), the
// earlier pattern wins.
const SPOTLIGHT_PATTERNS = [
  { key: 'FOMC',     label: 'FOMC',  rx: /\bFOMC\b|Federal Funds Rate/i,        color: 'amber' },
  { key: 'CPI',      label: 'CPI',   rx: /\bCPI\b|Consumer Price/i,              color: 'coral' },
  { key: 'NFP',      label: 'NFP',   rx: /Non[- ]?Farm Employment Change|^NFP$/i, color: 'green' },
  { key: 'GDP',      label: 'GDP',   rx: /\bGDP\b/i,                              color: 'blue' },
  { key: 'PCE',      label: 'PCE',   rx: /\bPCE\b/i,                              color: 'purple' },
  { key: 'PPI',      label: 'PPI',   rx: /\bPPI\b/i,                              color: 'amber' },
  { key: 'ISM',      label: 'ISM',   rx: /\bISM\b/i,                              color: 'cyan' },
];

function classifySpotlight(title) {
  if (!title) return null;
  for (const pat of SPOTLIGHT_PATTERNS) {
    if (pat.rx.test(title)) return pat;
  }
  return null;
}

const IMPACT_RANK = { High: 3, Medium: 2, Low: 1, Holiday: 0 };

export default function SlotB() {
  return (
    <div className="econ-events">
      <CalendarWidget />
      <FfAnalytics />
    </div>
  );
}

// ── TradingView widget ─────────────────────────────────────────────────
// One-time mount of the official embed script with a JSON config block
// stuffed inside the script tag. TV's loader parses that JSON, generates
// the iframe, and handles its own postMessage-based responsive resize.
// The wrapping container .tradingview-widget-container is the size we
// want the iframe to fill; .tradingview-widget-container__widget is the
// inner mount point TV's script targets.
function CalendarWidget() {
  const containerRef = useRef(null);
  // Load attempt is tracked just so we can render a tiny "loading"
  // hint underneath if the script hasn't dispatched the iframe yet.
  // The script is async so first paint shows the empty container until
  // TV's bundle resolves and injects the iframe DOM.
  const [scriptError, setScriptError] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // Build the inner mount point TV's script looks for.
    const inner = document.createElement('div');
    inner.className = 'tradingview-widget-container__widget';
    inner.style.width = '100%';
    inner.style.height = '100%';
    el.appendChild(inner);

    // The config block goes inside the <script> tag itself as text
    // content. TV's loader reads script.innerHTML, parses as JSON, and
    // applies the settings.
    const script = document.createElement('script');
    script.type = 'text/javascript';
    script.async = true;
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-events.js';
    script.onerror = () => setScriptError(true);
    script.innerHTML = JSON.stringify({
      colorTheme: 'dark',
      isTransparent: true,
      width: '100%',
      height: '100%',
      locale: 'en',
      // High-impact filter (3) + Medium (2). 1 is low-impact noise.
      // FF surfaces a few hundred low-impact rows per week that would
      // overwhelm a calendar reader looking for moves; the operator
      // toggles inside the widget if they want them back.
      importanceFilter: '0,1',
      // United States only by default — this is an SPX-positioning
      // surface, the rest of the world's calendar is one click away
      // inside the widget itself.
      countryFilter: 'us',
    });
    el.appendChild(script);

    return () => {
      // Unmount cleanup: TV's iframe is a child of the inner div, so
      // wiping the container removes everything in one pass. Also cuts
      // any pending postMessage handlers the script may have wired.
      try {
        while (el.firstChild) el.removeChild(el.firstChild);
      } catch {
        /* noop on teardown */
      }
    };
  }, []);

  return (
    <section className="econ-events__widget-card">
      <div className="econ-events__widget-header">
        <span className="econ-events__widget-title">Economic Calendar</span>
        <span className="econ-events__widget-source">via TradingView · US events · medium &amp; high impact</span>
      </div>
      <div className="tradingview-widget-container econ-events__widget-frame" ref={containerRef}>
        {/* TV's script appends the widget container__widget div + the iframe inside it.
            Until then this slot is empty; the surrounding card chrome carries the title
            so first paint isn't a blank rectangle. */}
      </div>
      {scriptError && (
        <div className="econ-events__widget-error">
          The TradingView embed script failed to load. Check your network or refresh.
        </div>
      )}
    </section>
  );
}

// ── Forex Factory analytics panel ──────────────────────────────────────
function FfAnalytics() {
  const [state, setState] = useState({ status: 'loading', data: null, error: null });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/events-calendar', {
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (cancelled) return;
        setState({ status: 'ready', data: json, error: null });
      } catch (err) {
        if (cancelled) return;
        setState({ status: 'error', data: null, error: err.message || String(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const { upcoming, past, totals, spotlights } = useMemo(() => {
    if (state.status !== 'ready') return { upcoming: [], past: [], totals: null, spotlights: [] };
    const now = new Date();
    const events = (state.data?.events || []).filter((e) => e.country === 'USD');
    const decorated = events.map((e) => {
      const at = new Date(e.dateTime);
      return {
        ...e,
        _at: at,
        _isPast: at.getTime() < now.getTime(),
        _spotlight: classifySpotlight(e.title),
      };
    });
    const upcomingList = decorated
      .filter((e) => !e._isPast)
      .sort((a, b) => a._at - b._at);
    const pastList = decorated
      .filter((e) => e._isPast)
      .sort((a, b) => b._at - a._at);
    const totalsObj = {
      total: decorated.length,
      high: decorated.filter((e) => e.impact === 'High').length,
      medium: decorated.filter((e) => e.impact === 'Medium').length,
      upcoming: upcomingList.length,
      past: pastList.length,
    };
    const spotlightList = decorated.filter((e) => e._spotlight);
    return { upcoming: upcomingList, past: pastList, totals: totalsObj, spotlights: spotlightList };
  }, [state]);

  if (state.status === 'loading') {
    return (
      <section className="econ-events__analytics">
        <div className="econ-events__status">Loading Forex Factory feed…</div>
      </section>
    );
  }
  if (state.status === 'error') {
    return (
      <section className="econ-events__analytics">
        <div className="econ-events__status econ-events__status--error">
          Could not load /api/events-calendar — {state.error}
        </div>
      </section>
    );
  }

  return (
    <section className="econ-events__analytics">
      <header className="econ-events__analytics-header">
        <span className="econ-events__analytics-title">Forex Factory · This Week</span>
        <span className="econ-events__analytics-source">
          fetched {formatRelative(state.data.fetchedAt)} · cached server-side ~1h
        </span>
      </header>

      {totals && (
        <div className="econ-events__totals">
          <Stat label="US events" value={totals.total} />
          <Stat label="High impact" value={totals.high} accent="coral" />
          <Stat label="Medium impact" value={totals.medium} accent="amber" />
          <Stat label="Upcoming" value={totals.upcoming} accent="green" />
          <Stat label="Past" value={totals.past} accent="muted" />
        </div>
      )}

      {spotlights.length > 0 && (
        <SpotlightStrip events={spotlights} />
      )}

      <div className="econ-events__columns">
        <EventsTable
          title="Upcoming"
          empty="No remaining US events this week."
          events={upcoming}
          mode="upcoming"
        />
        <EventsTable
          title="Past Week"
          empty="No past US events this week yet."
          events={past}
          mode="past"
        />
      </div>

      <footer className="econ-events__footnote">
        Source: Forex Factory weekly XML at <code>nfs.faireconomy.media/ff_calendar_thisweek.xml</code>.
        Forecasts and previous values shown verbatim; the public feed does not include the
        post-print &quot;actual&quot; field, so the Past Week column shows the consensus
        the print was measured against — &quot;missed forecast&quot; flags surface once a
        downstream actual feed is wired.
      </footer>
    </section>
  );
}

function SpotlightStrip({ events }) {
  // Group by spotlight key so we render one card per macro family
  // (FOMC, CPI, NFP, ...) even if the feed carries multiple sub-rows
  // (e.g., "Federal Funds Rate" + "FOMC Statement" + "FOMC Press
  // Conference" all collapse to a single FOMC card whose chrono is the
  // earliest of the three).
  const groups = new Map();
  for (const e of events) {
    const key = e._spotlight.key;
    const cur = groups.get(key);
    if (!cur || e._at < cur.headlineEvent._at) {
      groups.set(key, {
        spotlight: e._spotlight,
        events: cur ? [...cur.events, e] : [e],
        headlineEvent: e,
      });
    } else {
      cur.events.push(e);
    }
  }
  // Re-sort each group's events chronologically so the headline is the
  // earliest entry but the supporting rows render in order.
  for (const g of groups.values()) {
    g.events.sort((a, b) => a._at - b._at);
    g.headlineEvent = g.events[0];
  }
  const ordered = [...groups.values()].sort(
    (a, b) => a.headlineEvent._at - b.headlineEvent._at,
  );
  if (ordered.length === 0) return null;
  return (
    <div className="econ-events__spotlight">
      {ordered.map((g) => (
        <div
          key={g.spotlight.key}
          className={`econ-events__spotlight-card econ-events__spotlight-card--${g.spotlight.color}`}
        >
          <div className="econ-events__spotlight-key">{g.spotlight.label}</div>
          <div className="econ-events__spotlight-when">
            {formatWhen(g.headlineEvent._at, g.headlineEvent.dayKind)}
          </div>
          <div className="econ-events__spotlight-rows">
            {g.events.map((e, i) => (
              <div key={`${e.title}-${i}`} className="econ-events__spotlight-row">
                <span className="econ-events__spotlight-row-title">{e.title}</span>
                {e.forecast && (
                  <span className="econ-events__spotlight-row-meta">
                    fcst <strong>{e.forecast}</strong>
                  </span>
                )}
                {e.previous && (
                  <span className="econ-events__spotlight-row-meta">
                    prev <strong>{e.previous}</strong>
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function EventsTable({ title, empty, events, mode }) {
  if (events.length === 0) {
    return (
      <div className="econ-events__column">
        <div className="econ-events__column-title">{title}</div>
        <div className="econ-events__column-empty">{empty}</div>
      </div>
    );
  }
  return (
    <div className="econ-events__column">
      <div className="econ-events__column-title">{title}</div>
      <div className="econ-events__table-wrap">
        <table className="econ-events__table">
          <thead>
            <tr>
              <th className="econ-events__col-when">When</th>
              <th className="econ-events__col-impact">Imp</th>
              <th className="econ-events__col-title">Event</th>
              <th className="econ-events__col-num">Forecast</th>
              <th className="econ-events__col-num">Previous</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e, i) => {
              const impactClass = (e.impact || '').toLowerCase();
              const spotlightClass = e._spotlight
                ? `econ-events__row--spotlight econ-events__row--${e._spotlight.color}`
                : '';
              const pastClass = mode === 'past' ? 'econ-events__row--past' : '';
              return (
                <tr
                  key={`${e.title}-${e.dateTime}-${i}`}
                  className={`econ-events__row ${spotlightClass} ${pastClass}`.trim()}
                >
                  <td className="econ-events__col-when">{formatWhen(e._at, e.dayKind)}</td>
                  <td className={`econ-events__col-impact econ-events__impact econ-events__impact--${impactClass}`}>
                    {impactDot(e.impact)}
                    <span className="econ-events__impact-label">{e.impact || '—'}</span>
                  </td>
                  <td className="econ-events__col-title">
                    {e.url ? (
                      <a href={e.url} target="_blank" rel="noopener noreferrer">
                        {e.title}
                      </a>
                    ) : (
                      e.title
                    )}
                    {e._spotlight && (
                      <span className="econ-events__spotlight-tag">{e._spotlight.label}</span>
                    )}
                  </td>
                  <td className="econ-events__col-num">{e.forecast || '—'}</td>
                  <td className="econ-events__col-num">{e.previous || '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ label, value, accent }) {
  return (
    <div className={`econ-events__stat econ-events__stat--${accent || 'default'}`}>
      <div className="econ-events__stat-value">{value}</div>
      <div className="econ-events__stat-label">{label}</div>
    </div>
  );
}

function impactDot(impact) {
  const cls = (impact || '').toLowerCase();
  return <span className={`econ-events__dot econ-events__dot--${cls}`} aria-hidden="true" />;
}

// "Mon 9:30 AM" / "Wed All Day" / "Today 2:00 PM" / "Yesterday 8:30 AM"
function formatWhen(dt, dayKind) {
  if (!(dt instanceof Date) || Number.isNaN(dt.getTime())) return '—';
  const today = startOfDay(new Date());
  const target = startOfDay(dt);
  const diffDays = Math.round((target - today) / 86400000);
  let dayLabel;
  if (diffDays === 0) dayLabel = 'Today';
  else if (diffDays === -1) dayLabel = 'Yesterday';
  else if (diffDays === 1) dayLabel = 'Tomorrow';
  else dayLabel = dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  if (dayKind === 'all-day') return `${dayLabel} · All Day`;
  if (dayKind === 'tentative') return `${dayLabel} · Tentative`;
  const time = dt.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return `${dayLabel} · ${time}`;
}

function startOfDay(d) {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
}

function formatRelative(iso) {
  if (!iso) return 'just now';
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return iso;
  const diffMs = Date.now() - then.getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins === 1) return '1 minute ago';
  if (mins < 60) return `${mins} minutes ago`;
  const hrs = Math.round(mins / 60);
  if (hrs === 1) return '1 hour ago';
  if (hrs < 24) return `${hrs} hours ago`;
  return then.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
