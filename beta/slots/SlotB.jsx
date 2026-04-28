// Slot B — Economic Events Listener (PoC)
//
// First experimental tenant of the /beta/ shell after the SlotA-graduates
// rotation cleared the lab. The earlier draft of this slot embedded a
// TradingView "Economic Calendar" iframe widget on top of the Forex
// Factory analytics panel; that draft was abandoned because the TV
// widget rendered as a near-full-viewport white-screen funnel back to
// tradingview.com instead of usable content. This rewrite cuts the
// embed entirely and rebuilds the surface around the FF feed itself
// — the function /api/events-calendar (see netlify/functions/events-
// calendar.mjs) is now the only data source, and every byte of the
// rendered UI comes from FF rows directly.
//
// Page composition top-to-bottom:
//
//   StickyHeroBar ─ a slim compact strip that fixes to the top of the
//     viewport when the main hero card has scrolled out of view, so
//     the next-event countdown stays visible while the reader scrolls
//     down through the day-by-day schedule. IntersectionObserver-driven
//     so it only renders when needed; collapses to a single row of
//     family dot + title + countdown + impact chip.
//
//   FilterBar ─ country / impact / family pills the reader toggles
//     to scope the rest of the page, plus a free-text search input
//     for matching against event titles, plus toggles for "Hide past"
//     and "Notify me 5m before next high-impact event." USD +
//     medium-and-high impact is the default scope (this is an SPX-
//     positioning surface) but the reader can broaden in one click.
//
//   HeroNextEvent ─ big featured card for the next event (or family
//     of co-scheduled events) inside the active filter scope. The
//     card carries a live HH:MM:SS countdown that ticks every second,
//     the family badge, the forecast / previous values, and an
//     urgency tint that ramps coral as the event approaches. The
//     hero is the "listener" cue — the page IS reactive to FF and
//     the countdown is the visible proof.
//
//   StatusBar ─ "Listening to Forex Factory · fetched N minutes ago
//     · next refresh in M minutes" with a manual refresh button.
//     Re-fetch fires on a 10-minute interval (matching the function's
//     1-hour edge cache; the page polls more often than the function
//     re-fetches upstream so the "last published actual" gets
//     surfaced as soon as a future actuals feed lands).
//
//   Totals ─ summary count of events inside the active filter scope.
//
//   SpotlightStrip ─ one card per macro family with at least one
//     event in scope this week, sorted chronologically.
//
//   DaySchedule ─ chronological timeline grouped by date. Each date
//     header carries day name, full date, scope-filtered event count,
//     and an impact-count chip cluster (High / Medium / Low /
//     Holiday) so a reader sees at a glance which day of the week
//     carries the heaviest catalyst weight. Each event row is
//     click-to-expand: the inline detail panel exposes the FF source
//     URL, an "Add to calendar (.ics)" download, a "Notify me 5m
//     before" button, and a one-line forecast-vs-previous read.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export const slotName = 'Economic Events';

// Big Eight event-name patterns we want to spotlight for SPX traders.
const SPOTLIGHT_PATTERNS = [
  { key: 'FOMC',      label: 'FOMC',      rx: /\bFOMC\b|Federal Funds Rate/i,        color: 'amber'  },
  { key: 'CPI',       label: 'CPI',       rx: /\bCPI\b|Consumer Price/i,              color: 'coral'  },
  { key: 'NFP',       label: 'NFP',       rx: /Non[- ]?Farm Employment Change|^NFP$/i, color: 'green'  },
  { key: 'GDP',       label: 'GDP',       rx: /\bGDP\b/i,                              color: 'blue'   },
  { key: 'PCE',       label: 'PCE',       rx: /\bPCE\b/i,                              color: 'purple' },
  { key: 'PPI',       label: 'PPI',       rx: /\bPPI\b/i,                              color: 'amber'  },
  { key: 'ISM',       label: 'ISM',       rx: /\bISM\b/i,                              color: 'cyan'   },
  { key: 'JOBS',      label: 'JOBS',      rx: /Unemployment Claims|Employment Change|Job Openings/i, color: 'green' },
];

function classifySpotlight(title) {
  if (!title) return null;
  for (const pat of SPOTLIGHT_PATTERNS) {
    if (pat.rx.test(title)) return pat;
  }
  return null;
}

const ALL_COUNTRIES = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'NZD', 'CHF', 'CNY'];
const DEFAULT_COUNTRIES = ['USD'];
const ALL_IMPACTS = ['High', 'Medium', 'Low', 'Holiday'];
const DEFAULT_IMPACTS = ['High', 'Medium'];

const POLL_MS = 10 * 60 * 1000;       // 10 min
const CLOCK_TICK_MS = 1000;           // 1 s
const NOTIFY_LEAD_MS = 5 * 60 * 1000; // notify 5 min before next high-impact

// Stable identifier for an event row — used as the key for the
// "currently expanded row" state. The dateTime + title pair is unique
// in practice (FF doesn't list the same event twice at the same
// minute), and falls back gracefully if either field is missing.
function eventId(e) {
  return `${e.dateTime || ''}::${e.title || ''}`;
}

export default function SlotB() {
  const [feed, setFeed] = useState({ status: 'loading', data: null, error: null, fetchedAt: null });
  const [countries, setCountries] = useState(new Set(DEFAULT_COUNTRIES));
  const [impacts, setImpacts] = useState(new Set(DEFAULT_IMPACTS));
  const [searchQuery, setSearchQuery] = useState('');
  const [hidePast, setHidePast] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [notifyEnabled, setNotifyEnabled] = useState(false);
  const [notifyDenied, setNotifyDenied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const lastFetchRef = useRef(0);
  const heroRef = useRef(null);
  const [heroVisible, setHeroVisible] = useState(true);

  const fetchFeed = useCallback(async (signal) => {
    try {
      const res = await fetch('/api/events-calendar', { signal, headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      lastFetchRef.current = Date.now();
      setFeed({ status: 'ready', data: json, error: null, fetchedAt: Date.now() });
    } catch (err) {
      if (err?.name === 'AbortError') return;
      setFeed((cur) => ({
        status: cur.data ? 'ready' : 'error',
        data: cur.data,
        error: err.message || String(err),
        fetchedAt: cur.fetchedAt,
      }));
    }
  }, []);

  // Initial fetch + 10-minute poll + refresh on tab focus.
  useEffect(() => {
    const ac = new AbortController();
    fetchFeed(ac.signal);
    const interval = setInterval(() => fetchFeed(ac.signal), POLL_MS);
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        const idleFor = Date.now() - lastFetchRef.current;
        if (idleFor > 5 * 60 * 1000) fetchFeed(ac.signal);
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      ac.abort();
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [fetchFeed]);

  // Clock tick — drives the live hero countdown.
  useEffect(() => {
    let id = null;
    const start = () => {
      if (id != null) return;
      id = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    };
    const stop = () => {
      if (id != null) { clearInterval(id); id = null; }
    };
    const onVis = () => {
      if (document.visibilityState === 'visible') start();
      else stop();
    };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      stop();
    };
  }, []);

  // Mount-time check on the Notification permission. Browsers without
  // the API (older Safari iOS) silently disable the toggle.
  useEffect(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission === 'granted') setNotifyEnabled(true);
    if (Notification.permission === 'denied') setNotifyDenied(true);
  }, []);

  // IntersectionObserver wired to the hero card. The sticky compact
  // bar at the top of the viewport renders only when the main hero
  // has scrolled out of view, so the reader scrolling down through
  // the day schedule still sees the next-event countdown without the
  // header chrome competing with the schedule for vertical space when
  // the hero is already on-screen.
  useEffect(() => {
    const el = heroRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const obs = new IntersectionObserver(
      ([entry]) => setHeroVisible(entry.isIntersecting && entry.intersectionRatio > 0.2),
      { threshold: [0, 0.2, 0.5, 1] },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [feed.data]);

  // Decorate every event with parsed Date + spotlight family + past flag.
  const allEvents = useMemo(() => {
    if (!feed.data) return [];
    const out = [];
    for (const e of feed.data.events || []) {
      const at = new Date(e.dateTime);
      if (Number.isNaN(at.getTime())) continue;
      out.push({
        ...e,
        _id: eventId(e),
        _at: at,
        _ms: at.getTime(),
        _spotlight: classifySpotlight(e.title),
      });
    }
    return out.sort((a, b) => a._ms - b._ms);
  }, [feed.data]);

  // Active scope: filtered by country + impact pills + free-text search.
  const scoped = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return allEvents.filter((e) => {
      if (countries.size > 0 && !countries.has(e.country)) return false;
      if (impacts.size > 0 && !impacts.has(e.impact)) return false;
      if (q && !e.title.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [allEvents, countries, impacts, searchQuery]);

  const upcoming = useMemo(() => scoped.filter((e) => e._ms >= now), [scoped, now]);
  const past = useMemo(() => scoped.filter((e) => e._ms < now), [scoped, now]);

  // What the schedule actually renders. When `hidePast` is on, past
  // rows are dropped entirely; when off, they stay in DOM with reduced
  // opacity so the timeline reads continuously.
  const scheduleEvents = useMemo(
    () => (hidePast ? upcoming : scoped),
    [hidePast, upcoming, scoped],
  );

  const heroGroup = useMemo(() => {
    if (upcoming.length === 0) return null;
    const head = upcoming[0];
    if (!head._spotlight) return { anchor: head, events: [head] };
    const cluster = upcoming.filter(
      (e) => e.date === head.date && e._spotlight?.key === head._spotlight.key,
    );
    return { anchor: head, events: cluster };
  }, [upcoming]);

  // Notification scheduling. Tracks the next high-impact event in
  // scope; sets a single setTimeout that fires NOTIFY_LEAD_MS before
  // the event. Re-runs whenever the scoped set or the toggle state
  // changes. On unmount or scope change the prior timeout is cleared
  // so the reader's filter changes don't leave dangling alarms.
  const notifyTimeoutRef = useRef(null);
  useEffect(() => {
    if (notifyTimeoutRef.current != null) {
      clearTimeout(notifyTimeoutRef.current);
      notifyTimeoutRef.current = null;
    }
    if (!notifyEnabled) return;
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    const target = upcoming.find(
      (e) => e.impact === 'High' && e._ms - Date.now() > NOTIFY_LEAD_MS,
    );
    if (!target) return;
    const delay = target._ms - Date.now() - NOTIFY_LEAD_MS;
    // setTimeout's 32-bit signed-int delay cap is 2^31-1 ms ≈ 24.8 d.
    // The FF feed only carries this week, so any delay past 7 days
    // is already an outlier; the cap below is a defensive guard
    // against the rare edge case rather than an expected branch.
    if (delay <= 0 || delay > 7 * 24 * 60 * 60 * 1000) return;
    notifyTimeoutRef.current = setTimeout(() => {
      try {
        new Notification(`AI Gamma · ${target.country} · ${target.title}`, {
          body: `In 5 minutes. Forecast ${target.forecast || 'n/a'} · Prev ${target.previous || 'n/a'}`,
          icon: '/favicon.ico',
          tag: `ff-${target._id}`,
        });
      } catch {
        /* notification API can throw on iOS WKWebView etc.; swallow */
      }
    }, delay);
    return () => {
      if (notifyTimeoutRef.current != null) {
        clearTimeout(notifyTimeoutRef.current);
        notifyTimeoutRef.current = null;
      }
    };
  }, [notifyEnabled, upcoming]);

  const requestNotifyPermission = useCallback(async () => {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      setNotifyDenied(true);
      return;
    }
    if (Notification.permission === 'granted') {
      setNotifyEnabled(true);
      return;
    }
    if (Notification.permission === 'denied') {
      setNotifyDenied(true);
      return;
    }
    try {
      const result = await Notification.requestPermission();
      if (result === 'granted') setNotifyEnabled(true);
      else setNotifyDenied(true);
    } catch {
      setNotifyDenied(true);
    }
  }, []);

  const toggleNotify = useCallback(() => {
    if (notifyEnabled) {
      setNotifyEnabled(false);
      return;
    }
    requestNotifyPermission();
  }, [notifyEnabled, requestNotifyPermission]);

  if (feed.status === 'loading' && !feed.data) {
    return (
      <section className="econ-events econ-events--bare">
        <div className="econ-events__status">Listening to Forex Factory…</div>
      </section>
    );
  }
  if (feed.status === 'error' && !feed.data) {
    return (
      <section className="econ-events econ-events--bare">
        <div className="econ-events__status econ-events__status--error">
          Could not reach /api/events-calendar — {feed.error}
        </div>
      </section>
    );
  }

  return (
    <div className="econ-events">
      {!heroVisible && heroGroup && (
        <StickyHeroBar group={heroGroup} now={now} />
      )}

      <FilterBar
        countries={countries} setCountries={setCountries}
        impacts={impacts} setImpacts={setImpacts}
        searchQuery={searchQuery} setSearchQuery={setSearchQuery}
        hidePast={hidePast} setHidePast={setHidePast}
        notifyEnabled={notifyEnabled} notifyDenied={notifyDenied}
        toggleNotify={toggleNotify}
      />

      <div ref={heroRef}>
        {heroGroup ? (
          <HeroNextEvent group={heroGroup} now={now} />
        ) : (
          <div className="econ-events__hero econ-events__hero--empty">
            <div className="econ-events__hero-empty-text">
              No remaining events this week inside the current scope.
              Broaden the filter or wait for next week's feed refresh.
            </div>
          </div>
        )}
      </div>

      <StatusBar
        fetchedAt={feed.fetchedAt}
        now={now}
        nextRefreshAt={feed.fetchedAt ? feed.fetchedAt + POLL_MS : null}
        onRefresh={() => fetchFeed()}
        error={feed.error}
      />

      <Totals scoped={scoped} upcoming={upcoming} past={past} />

      <SpotlightStrip events={scoped} now={now} />

      <DaySchedule
        events={scheduleEvents}
        now={now}
        expandedId={expandedId}
        setExpandedId={setExpandedId}
      />

      <footer className="econ-events__footnote">
        Source: Forex Factory weekly XML at <code>nfs.faireconomy.media/ff_calendar_thisweek.xml</code>,
        proxied through <code>/api/events-calendar</code> with a 1-hour edge cache. Click any row to expose its
        FF source link, an .ics calendar download, and a 5-minute lead-time notification toggle. Notifications
        require the browser-level Notification permission and only fire while this tab is open. Times render
        in your local timezone after server-side normalization to America/New_York.
      </footer>
    </div>
  );
}

// ── Sticky compact countdown bar ──────────────────────────────────────
// Fixes to the top of the viewport when the main hero is offscreen.
function StickyHeroBar({ group, now }) {
  const a = group.anchor;
  const family = a._spotlight;
  const ms = a._ms - now;
  const urgency = urgencyTier(ms);
  const familyClass = family ? `econ-events__sticky--${family.color}` : 'econ-events__sticky--neutral';
  return (
    <div className={`econ-events__sticky ${familyClass} econ-events__sticky--${urgency}`}>
      <span className="econ-events__sticky-eyebrow">Next</span>
      {family && (
        <span className={`econ-events__sticky-family econ-events__sticky-family--${family.color}`}>
          {family.label}
        </span>
      )}
      <span className="econ-events__sticky-title">{a.title}</span>
      <span className={`econ-events__hero-impact econ-events__hero-impact--${(a.impact || '').toLowerCase()}`}>
        <span className={`econ-events__dot econ-events__dot--${(a.impact || '').toLowerCase()}`} aria-hidden="true" />
        {a.impact || '—'}
      </span>
      <span className="econ-events__sticky-countdown">
        <CompactCountdown ms={ms} dayKind={a.dayKind} />
      </span>
    </div>
  );
}

function CompactCountdown({ ms, dayKind }) {
  if (dayKind === 'all-day' || dayKind === 'tentative') {
    return <span className="econ-events__sticky-countdown-passive">{dayKind === 'all-day' ? 'All Day' : 'Tentative'}</span>;
  }
  if (ms <= 0) return <span className="econ-events__sticky-countdown-passive">Released</span>;
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (days > 0) return <span><strong>{days}</strong>d <strong>{hours}</strong>h</span>;
  return (
    <span>
      <strong>{String(hours).padStart(2, '0')}</strong>h{' '}
      <strong>{String(mins).padStart(2, '0')}</strong>m{' '}
      <strong>{String(secs).padStart(2, '0')}</strong>s
    </span>
  );
}

// ── Filter bar ────────────────────────────────────────────────────────
function FilterBar({
  countries, setCountries,
  impacts, setImpacts,
  searchQuery, setSearchQuery,
  hidePast, setHidePast,
  notifyEnabled, notifyDenied, toggleNotify,
}) {
  const toggleCountry = (c) => {
    setCountries((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c); else next.add(c);
      return next;
    });
  };
  const toggleImpact = (i) => {
    setImpacts((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  };
  return (
    <div className="econ-events__filterbar">
      <div className="econ-events__filtergroup">
        <span className="econ-events__filtergroup-label">Country</span>
        <div className="econ-events__pills">
          {ALL_COUNTRIES.map((c) => {
            const active = countries.has(c);
            return (
              <button
                key={c}
                type="button"
                className={`econ-events__pill ${active ? 'econ-events__pill--active' : ''}`}
                onClick={() => toggleCountry(c)}
                aria-pressed={active}
              >
                {c}
              </button>
            );
          })}
        </div>
      </div>
      <div className="econ-events__filtergroup">
        <span className="econ-events__filtergroup-label">Impact</span>
        <div className="econ-events__pills">
          {ALL_IMPACTS.map((i) => {
            const active = impacts.has(i);
            return (
              <button
                key={i}
                type="button"
                className={`econ-events__pill econ-events__pill--impact econ-events__pill--impact-${i.toLowerCase()} ${active ? 'econ-events__pill--active' : ''}`}
                onClick={() => toggleImpact(i)}
                aria-pressed={active}
              >
                <span className={`econ-events__dot econ-events__dot--${i.toLowerCase()}`} aria-hidden="true" />
                {i}
              </button>
            );
          })}
        </div>
      </div>
      <div className="econ-events__filtergroup">
        <span className="econ-events__filtergroup-label">Search</span>
        <input
          type="search"
          className="econ-events__searchbox"
          placeholder="title contains…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>
      <div className="econ-events__filtergroup">
        <button
          type="button"
          className={`econ-events__pill ${hidePast ? 'econ-events__pill--active' : ''}`}
          onClick={() => setHidePast((v) => !v)}
          aria-pressed={hidePast}
          title="Hide events that have already passed"
        >
          Hide past
        </button>
        <button
          type="button"
          className={`econ-events__pill econ-events__pill--notify ${notifyEnabled ? 'econ-events__pill--active' : ''} ${notifyDenied ? 'econ-events__pill--denied' : ''}`}
          onClick={toggleNotify}
          aria-pressed={notifyEnabled}
          title={notifyDenied ? 'Browser denied notifications' : 'Notify 5 minutes before next high-impact event'}
          disabled={notifyDenied}
        >
          {notifyDenied ? 'Notifications blocked' : (notifyEnabled ? 'Notify · ON' : 'Notify · OFF')}
        </button>
      </div>
    </div>
  );
}

// ── Hero next-event card ──────────────────────────────────────────────
function HeroNextEvent({ group, now }) {
  const anchor = group.anchor;
  const family = anchor._spotlight;
  const ms = anchor._ms - now;
  const urgency = urgencyTier(ms);
  const familyClass = family ? `econ-events__hero--${family.color}` : 'econ-events__hero--neutral';
  return (
    <section className={`econ-events__hero ${familyClass} econ-events__hero--${urgency}`}>
      <div className="econ-events__hero-stripe" aria-hidden="true" />
      <div className="econ-events__hero-content">
        <div className="econ-events__hero-meta">
          <span className="econ-events__hero-eyebrow">Next event</span>
          {family && (
            <span className={`econ-events__hero-family-badge econ-events__hero-family-badge--${family.color}`}>
              {family.label}
            </span>
          )}
          <span className="econ-events__hero-country">{anchor.country}</span>
          <span className={`econ-events__hero-impact econ-events__hero-impact--${(anchor.impact || '').toLowerCase()}`}>
            <span className={`econ-events__dot econ-events__dot--${(anchor.impact || '').toLowerCase()}`} aria-hidden="true" />
            {anchor.impact || 'Unknown'}
          </span>
        </div>
        <h2 className="econ-events__hero-title">
          {anchor.url ? (
            <a href={anchor.url} target="_blank" rel="noopener noreferrer">{anchor.title}</a>
          ) : anchor.title}
        </h2>
        <div className="econ-events__hero-when">
          {formatLongWhen(anchor._at, anchor.dayKind)}
        </div>
        <Countdown ms={ms} dayKind={anchor.dayKind} />
        <div className="econ-events__hero-numbers">
          <HeroNumber label="Forecast" value={anchor.forecast} accent="amber" />
          <HeroNumber label="Previous" value={anchor.previous} accent="muted" />
          <HeroNumber label="Actual" value={anchor.actual} accent="green" pending />
        </div>
        <ForecastInterpretation forecast={anchor.forecast} previous={anchor.previous} title={anchor.title} />
        {group.events.length > 1 && (
          <div className="econ-events__hero-cluster">
            <div className="econ-events__hero-cluster-label">
              {group.events.length} events in this {family?.label || 'cluster'} cluster
            </div>
            <div className="econ-events__hero-cluster-rows">
              {group.events.map((e, i) => (
                <div key={i} className="econ-events__hero-cluster-row">
                  <span className="econ-events__hero-cluster-time">
                    {formatTimeOnly(e._at, e.dayKind)}
                  </span>
                  <span className="econ-events__hero-cluster-title">{e.title}</span>
                  {e.forecast && (
                    <span className="econ-events__hero-cluster-meta">
                      fcst <strong>{e.forecast}</strong>
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function HeroNumber({ label, value, accent, pending }) {
  return (
    <div className={`econ-events__hero-num econ-events__hero-num--${accent}${pending ? ' econ-events__hero-num--pending' : ''}`}>
      <div className="econ-events__hero-num-label">{label}</div>
      <div className="econ-events__hero-num-value">
        {value || (pending ? '—' : '—')}
      </div>
    </div>
  );
}

function Countdown({ ms, dayKind }) {
  if (dayKind === 'all-day' || dayKind === 'tentative') {
    return (
      <div className="econ-events__countdown econ-events__countdown--passive">
        {dayKind === 'all-day' ? 'All Day' : 'Tentative'}
      </div>
    );
  }
  if (ms <= 0) {
    return <div className="econ-events__countdown econ-events__countdown--past">Released</div>;
  }
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  return (
    <div className="econ-events__countdown">
      {days > 0 && <span><strong>{days}</strong>d </span>}
      <span><strong>{String(hours).padStart(2, '0')}</strong>h </span>
      <span><strong>{String(mins).padStart(2, '0')}</strong>m </span>
      <span><strong>{String(secs).padStart(2, '0')}</strong>s</span>
    </div>
  );
}

function urgencyTier(ms) {
  if (ms <= 0) return 'past';
  const hr = ms / 3600000;
  if (hr <= 1) return 'now';
  if (hr <= 6) return 'soon';
  if (hr <= 24) return 'today';
  if (hr <= 72) return 'week';
  return 'far';
}

// ── Forecast vs previous interpretation ───────────────────────────────
// One-liner that helps a non-macro reader understand what direction
// the consensus expects relative to the prior reading. Intentionally
// terse — the page is for context, not commentary.
function ForecastInterpretation({ forecast, previous, title }) {
  const f = parseNumeric(forecast);
  const p = parseNumeric(previous);
  if (f == null || p == null) return null;
  if (Math.abs(f - p) < 1e-9) {
    return (
      <div className="econ-events__hero-interp">
        Consensus expects no change from prior reading.
      </div>
    );
  }
  const hotter = f > p;
  // Inflation-style series read coral when the print is hotter than
  // prior; growth/labor read green for hotter prints (more activity =
  // typically equity-positive). The lookup is heuristic — readers
  // should treat the color as a hint, not a forecast.
  const hot = isInflationary(title);
  const colorClass = hotter
    ? (hot ? 'econ-events__hero-interp--coral' : 'econ-events__hero-interp--green')
    : (hot ? 'econ-events__hero-interp--green' : 'econ-events__hero-interp--coral');
  const direction = hotter ? 'higher' : 'lower';
  const delta = formatDelta(f, p, forecast);
  return (
    <div className={`econ-events__hero-interp ${colorClass}`}>
      Consensus expects <strong>{direction}</strong> reading vs prior — {delta}.
    </div>
  );
}

function parseNumeric(s) {
  if (s == null) return null;
  const m = /-?\d+(\.\d+)?/.exec(String(s));
  if (!m) return null;
  const v = Number(m[0]);
  return Number.isFinite(v) ? v : null;
}

function formatDelta(f, p, rawForecast) {
  const diff = f - p;
  const isPercent = /%/.test(String(rawForecast || ''));
  const decimals = Math.max(0, Math.min(2, (String(rawForecast || '').split('.')[1] || '').length));
  const formatted = Math.abs(diff).toFixed(decimals);
  return `Δ ${diff > 0 ? '+' : '−'}${formatted}${isPercent ? '%' : ''}`;
}

function isInflationary(title) {
  return /Price|CPI|PPI|PCE|Wage|ECI|Inflation/i.test(title || '');
}

// ── Status bar ────────────────────────────────────────────────────────
function StatusBar({ fetchedAt, now, nextRefreshAt, onRefresh, error }) {
  const fetchedAgo = fetchedAt ? formatDuration(now - fetchedAt) : 'never';
  const refreshIn = nextRefreshAt ? Math.max(0, nextRefreshAt - now) : 0;
  return (
    <div className="econ-events__statusbar">
      <span className="econ-events__listening">
        <span className="econ-events__listening-dot" aria-hidden="true" />
        Listening to Forex Factory
      </span>
      <span className="econ-events__statusbar-meta">
        fetched {fetchedAgo} ago · next refresh in {formatDuration(refreshIn)}
      </span>
      {error && (
        <span className="econ-events__statusbar-error">last error: {error}</span>
      )}
      <button type="button" className="econ-events__refresh" onClick={onRefresh}>
        Refresh now
      </button>
    </div>
  );
}

// ── Totals ────────────────────────────────────────────────────────────
function Totals({ scoped, upcoming, past }) {
  const high = scoped.filter((e) => e.impact === 'High').length;
  const medium = scoped.filter((e) => e.impact === 'Medium').length;
  const low = scoped.filter((e) => e.impact === 'Low').length;
  return (
    <div className="econ-events__totals">
      <Stat label="High" value={high} accent="coral" />
      <Stat label="Medium" value={medium} accent="amber" />
      <Stat label="Low" value={low} accent="muted" />
      <Stat label="Upcoming" value={upcoming.length} accent="green" />
      <Stat label="Past" value={past.length} accent="muted" />
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

// ── Spotlight strip ───────────────────────────────────────────────────
function SpotlightStrip({ events, now }) {
  const byKey = new Map();
  for (const e of events) {
    if (!e._spotlight) continue;
    const k = e._spotlight.key;
    const cur = byKey.get(k);
    if (!cur) byKey.set(k, { spotlight: e._spotlight, events: [e] });
    else cur.events.push(e);
  }
  const ordered = [...byKey.values()]
    .map((g) => ({ ...g, events: g.events.sort((a, b) => a._ms - b._ms) }))
    .sort((a, b) => a.events[0]._ms - b.events[0]._ms);
  if (ordered.length === 0) return null;
  return (
    <div className="econ-events__spotlight">
      {ordered.map((g) => {
        const head = g.events[0];
        const past = head._ms < now;
        return (
          <div
            key={g.spotlight.key}
            className={`econ-events__spotlight-card econ-events__spotlight-card--${g.spotlight.color}${past ? ' econ-events__spotlight-card--past' : ''}`}
          >
            <div className="econ-events__spotlight-key">{g.spotlight.label}</div>
            <div className="econ-events__spotlight-when">
              {past ? 'Released ' : ''}{formatRelativeWhen(head._at, head.dayKind, now)}
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
        );
      })}
    </div>
  );
}

// ── Day-by-day schedule ──────────────────────────────────────────────
function DaySchedule({ events, now, expandedId, setExpandedId }) {
  const byDate = new Map();
  for (const e of events) {
    const k = e.date;
    if (!byDate.has(k)) byDate.set(k, []);
    byDate.get(k).push(e);
  }
  const sortedDates = [...byDate.keys()].sort();
  if (sortedDates.length === 0) {
    return (
      <div className="econ-events__schedule-empty">
        No events match the current filter scope.
      </div>
    );
  }
  const todayKey = isoDateLocal(new Date(now));
  return (
    <div className="econ-events__schedule">
      {sortedDates.map((dateKey) => {
        const dayEvents = byDate.get(dateKey).sort((a, b) => a._ms - b._ms);
        const isToday = dateKey === todayKey;
        const allPast = dayEvents.every((e) => e._ms < now);
        const counts = countImpacts(dayEvents);
        return (
          <div
            key={dateKey}
            className={`econ-events__day${isToday ? ' econ-events__day--today' : ''}${allPast ? ' econ-events__day--past' : ''}`}
          >
            <div className="econ-events__day-header">
              <span className="econ-events__day-name">{formatDayName(dateKey, todayKey)}</span>
              <span className="econ-events__day-date">{formatLongDate(dateKey)}</span>
              <DayImpactChips counts={counts} />
              <span className="econ-events__day-count">{dayEvents.length} events</span>
            </div>
            <div className="econ-events__day-rows">
              {dayEvents.map((e) => (
                <EventRow
                  key={e._id}
                  event={e}
                  past={e._ms < now}
                  expanded={expandedId === e._id}
                  onToggle={() => setExpandedId(expandedId === e._id ? null : e._id)}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function countImpacts(events) {
  const out = { High: 0, Medium: 0, Low: 0, Holiday: 0 };
  for (const e of events) {
    if (out[e.impact] != null) out[e.impact] += 1;
  }
  return out;
}

function DayImpactChips({ counts }) {
  return (
    <div className="econ-events__day-chips">
      {ALL_IMPACTS.map((i) => {
        if (!counts[i]) return null;
        const cls = i.toLowerCase();
        return (
          <span
            key={i}
            className={`econ-events__day-chip econ-events__day-chip--${cls}`}
            title={`${counts[i]} ${i.toLowerCase()}-impact event${counts[i] > 1 ? 's' : ''}`}
          >
            <span className={`econ-events__dot econ-events__dot--${cls}`} aria-hidden="true" />
            {counts[i]}
          </span>
        );
      })}
    </div>
  );
}

function EventRow({ event: e, past, expanded, onToggle }) {
  const sp = e._spotlight;
  return (
    <div
      className={`econ-events__row${past ? ' econ-events__row--past' : ''}${sp ? ` econ-events__row--${sp.color}` : ''}${expanded ? ' econ-events__row--expanded' : ''}`}
    >
      <button
        type="button"
        className="econ-events__row-summary"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <span className="econ-events__row-time">{formatTimeOnly(e._at, e.dayKind)}</span>
        <span className={`econ-events__row-impact econ-events__row-impact--${(e.impact || '').toLowerCase()}`}>
          <span className={`econ-events__dot econ-events__dot--${(e.impact || '').toLowerCase()}`} aria-hidden="true" />
        </span>
        <span className="econ-events__row-country">{e.country}</span>
        <span className="econ-events__row-title">
          <span className="econ-events__row-title-text">{e.title}</span>
          {sp && <span className="econ-events__row-family">{sp.label}</span>}
        </span>
        <span className="econ-events__row-num">
          <span className="econ-events__row-num-label">F</span>
          {e.forecast || '—'}
        </span>
        <span className="econ-events__row-num">
          <span className="econ-events__row-num-label">P</span>
          {e.previous || '—'}
        </span>
        <span className="econ-events__row-num econ-events__row-num--actual">
          <span className="econ-events__row-num-label">A</span>
          {e.actual || '—'}
        </span>
        <span className="econ-events__row-toggle" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <EventRowDetail event={e} past={past} />
      )}
    </div>
  );
}

function EventRowDetail({ event: e, past }) {
  const onIcs = useCallback(() => downloadIcs(e), [e]);
  return (
    <div className="econ-events__row-detail">
      <div className="econ-events__row-detail-row">
        {e.url && (
          <a
            className="econ-events__row-action econ-events__row-action--link"
            href={e.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open on Forex Factory ↗
          </a>
        )}
        <button
          type="button"
          className="econ-events__row-action"
          onClick={onIcs}
        >
          Add to calendar (.ics)
        </button>
        <span className="econ-events__row-detail-when">
          {formatLongWhen(e._at, e.dayKind)}
        </span>
      </div>
      <ForecastInterpretation
        forecast={e.forecast}
        previous={e.previous}
        title={e.title}
      />
      {past && e.actual == null && (
        <div className="econ-events__row-detail-note">
          This event has been released. The public Forex Factory feed does not publish post-print actual values; click "Open on Forex Factory" to see what hit the wire.
        </div>
      )}
    </div>
  );
}

// ── .ics calendar export ───────────────────────────────────────────
function downloadIcs(event) {
  const start = event._at instanceof Date ? event._at : new Date(event.dateTime);
  if (Number.isNaN(start.getTime())) return;
  // Default 30-minute event duration. Most macro releases are
  // instantaneous prints on a wire (CPI, NFP, ISM, GDP) where the
  // notional "duration" is academic and 30 min is enough for a desk
  // reader's calendar to show the slot. FOMC events with longer
  // press-conferences (~1h) are still mostly single moments for
  // calendar purposes; the reader can stretch the block manually if
  // they want. All-day rows are suppressed (no .ics for the bank-
  // holiday-style passthrough events).
  if (event.dayKind === 'all-day' || event.dayKind === 'tentative') return;
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//AI Gamma//Beta Events Listener//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:ff-${slugifyForUid(event.title)}-${event.dateTime}@aigamma.com`,
    `DTSTAMP:${formatIcsDate(new Date())}`,
    `DTSTART:${formatIcsDate(start)}`,
    `DTEND:${formatIcsDate(end)}`,
    `SUMMARY:${icsEscape(`${event.country || ''} · ${event.title}`)}`,
    `DESCRIPTION:${icsEscape(buildIcsDescription(event))}`,
    event.url ? `URL:${icsEscape(event.url)}` : null,
    `CATEGORIES:${icsEscape(`Forex Factory · ${event.impact || 'Unknown'}`)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean);
  // The .ics line break is CRLF per RFC 5545.
  const ics = lines.join('\r\n');
  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${slugifyForFile(event.title)}.ics`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function buildIcsDescription(e) {
  const lines = [];
  lines.push(`Impact: ${e.impact || 'unknown'}`);
  if (e.forecast) lines.push(`Forecast: ${e.forecast}`);
  if (e.previous) lines.push(`Previous: ${e.previous}`);
  if (e._spotlight) lines.push(`Family: ${e._spotlight.label}`);
  lines.push('Source: Forex Factory · ff_calendar_thisweek.xml');
  if (e.url) lines.push(`Source URL: ${e.url}`);
  return lines.join('\\n');
}

// RFC 5545 says DTSTART/DTSTAMP must be in YYYYMMDDTHHMMSSZ form.
// Convert to UTC and strip dashes/colons/milliseconds.
function formatIcsDate(d) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function icsEscape(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

function slugifyForFile(s) {
  return String(s).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60).toLowerCase();
}

function slugifyForUid(s) {
  return slugifyForFile(s).replace(/-/g, '');
}

// ── Formatting helpers ────────────────────────────────────────────────
function formatLongWhen(dt, dayKind) {
  if (!(dt instanceof Date) || Number.isNaN(dt.getTime())) return '—';
  const day = dt.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  if (dayKind === 'all-day') return `${day} · All Day`;
  if (dayKind === 'tentative') return `${day} · Tentative`;
  const time = dt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
  const tz = dt.toLocaleTimeString(undefined, { timeZoneName: 'short' }).split(' ').pop();
  return `${day} · ${time} ${tz}`;
}

function formatTimeOnly(dt, dayKind) {
  if (!(dt instanceof Date) || Number.isNaN(dt.getTime())) return '—';
  if (dayKind === 'all-day') return 'All Day';
  if (dayKind === 'tentative') return 'Tentative';
  return dt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
}

function formatRelativeWhen(dt, dayKind, now) {
  if (!(dt instanceof Date) || Number.isNaN(dt.getTime())) return '—';
  const ms = dt.getTime() - now;
  if (dayKind === 'all-day' || dayKind === 'tentative') {
    return formatTimeOnly(dt, dayKind);
  }
  const abs = Math.abs(ms);
  const direction = ms >= 0 ? 'in ' : '';
  const suffix = ms >= 0 ? '' : ' ago';
  if (abs < 60_000) return `${direction}<1m${suffix}`;
  const totalMin = Math.round(abs / 60000);
  if (totalMin < 60) return `${direction}${totalMin}m${suffix}`;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours < 24) {
    return mins
      ? `${direction}${hours}h ${mins}m${suffix}`
      : `${direction}${hours}h${suffix}`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours
    ? `${direction}${days}d ${remHours}h${suffix}`
    : `${direction}${days}d${suffix}`;
}

function formatDayName(dateIso, todayIso) {
  if (dateIso === todayIso) return 'Today';
  const today = new Date(`${todayIso}T12:00:00`);
  const target = new Date(`${dateIso}T12:00:00`);
  const diffDays = Math.round((target - today) / 86400000);
  if (diffDays === -1) return 'Yesterday';
  if (diffDays === 1) return 'Tomorrow';
  return new Date(`${dateIso}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long' });
}

function formatLongDate(dateIso) {
  return new Date(`${dateIso}T12:00:00`).toLocaleDateString(undefined, {
    month: 'long', day: 'numeric', year: 'numeric',
  });
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m`;
  const hours = Math.floor(totalMin / 60);
  const remMin = totalMin % 60;
  if (hours < 24) return remMin ? `${hours}h ${remMin}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHr = hours % 24;
  return remHr ? `${days}d ${remHr}h` : `${days}d`;
}

function isoDateLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}
