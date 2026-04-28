// Slot B — Economic Events Listener (PoC, US-only)
//
// First experimental tenant of the /beta/ shell after the SlotA-graduates
// rotation cleared the lab. The earlier draft of this slot embedded a
// TradingView "Economic Calendar" iframe widget on top of the Forex
// Factory analytics panel; that draft was abandoned because the TV
// widget rendered as a near-full-viewport white-screen funnel back to
// tradingview.com instead of usable content. This rewrite cuts the
// embed entirely and rebuilds the surface around the FF feed itself
// joined with the platform's own SPX implied-volatility data, so a
// reader sees both "what's coming" and "what's the SPX vol surface
// pricing for it" on one page.
//
// USD-only by design: this is an SPX-positioning surface, so the FF
// proxy filters non-USD rows out at the server (see
// netlify/functions/events-calendar.mjs). The client therefore has
// no country state machine, no country pills, no country column in
// the schedule, and the implied-move resolver runs unconditionally
// on every event rather than gating on `e.country === 'USD'`.
//
// Two parallel data fetches drive the page:
//
//   1. /api/events-calendar — the FF weekly XML proxy. Polled every
//      10 min; returns the USD subset (~30 events / week) with title /
//      impact / forecast / previous / dateTime per row.
//
//   2. /api/data?skip_contracts=1 — the SPX intraday snapshot endpoint
//      (the same wire path the main dashboard reads). With the
//      contracts payload skipped this fetch is small (~6 KB) and
//      delivers spotPrice + capturedAt + expirationMetrics (per-
//      expiration ATM IV / 25-delta put IV / 25-delta call IV). For
//      each upcoming event the page resolves the next expiration
//      AT-OR-AFTER the event date, computes the IV-implied move
//      (move = spot × atm_iv × √(DTE/365)), and surfaces it inline on
//      the row, in the hero, and in a Plotly bar chart that maps each
//      upcoming event to its priced-in dollar / percent move.
//
// Page composition top-to-bottom:
//
//   StickyHeroBar ─ a slim compact strip that fixes to the top of the
//     viewport when the main hero card has scrolled out of view.
//
//   FilterBar ─ impact pills, free-text search, "Hide past" and
//     "Notify" toggles. (Country pills were removed when the surface
//     committed to USD-only.)
//
//   HeroNextEvent ─ big featured card with countdown, family badge,
//     forecast/previous, and the new "Implied SPX move at next exp"
//     line (±$ and %, plus DTE).
//
//   Totals ─ High / Medium / Low / Upcoming counts (the redundant
//     "In scope" and "Past" tiles were dropped per Eric's audit;
//     scope.length is derivable from the impact triple, and the
//     past count is exposed both via the Hide-past toggle and the
//     fading on past-event rows).
//
//   ImpliedMoveChart ─ Plotly bar chart, one bar per upcoming
//     high+medium-impact USD event in scope. Y axis is implied move
//     in % (translated to $ in hover), X axis is the chronologic
//     event sequence labeled with day + time. Bars are colored by
//     macro family (FOMC amber, CPI coral, NFP green, etc.) so the
//     reader sees both magnitude and macro identity at a glance. The
//     chart is the first explicit visualization on a page that was
//     conspicuously chart-free; it's the page's quantitative
//     centerpiece.
//
//   SpotlightStrip ─ one card per macro family with at least one
//     event in scope this week.
//
//   DaySchedule ─ chronological timeline grouped by date, per-day
//     impact-count chips, click-to-expand event rows with FF link /
//     .ics download / forecast-vs-previous interpretation.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import RangeBrush from '../../src/components/RangeBrush';

export const slotName = 'Economic Events';

const SPOTLIGHT_PATTERNS = [
  { key: 'FOMC',  label: 'FOMC',  rx: /\bFOMC\b|Federal Funds Rate/i,        color: 'amber',  hex: '#f1c40f' },
  { key: 'CPI',   label: 'CPI',   rx: /\bCPI\b|Consumer Price/i,              color: 'coral',  hex: '#e74c3c' },
  { key: 'NFP',   label: 'NFP',   rx: /Non[- ]?Farm Employment Change|^NFP$/i, color: 'green',  hex: '#2ecc71' },
  { key: 'GDP',   label: 'GDP',   rx: /\bGDP\b/i,                              color: 'blue',   hex: '#4a9eff' },
  { key: 'PCE',   label: 'PCE',   rx: /\bPCE\b/i,                              color: 'purple', hex: '#BF7FFF' },
  { key: 'PPI',   label: 'PPI',   rx: /\bPPI\b/i,                              color: 'amber',  hex: '#f1c40f' },
  { key: 'ISM',   label: 'ISM',   rx: /\bISM\b/i,                              color: 'cyan',   hex: '#1abc9c' },
  { key: 'JOBS',  label: 'JOBS',  rx: /Unemployment Claims|Employment Change|Job Openings/i, color: 'green', hex: '#2ecc71' },
];

function classifySpotlight(title) {
  if (!title) return null;
  for (const pat of SPOTLIGHT_PATTERNS) {
    if (pat.rx.test(title)) return pat;
  }
  return null;
}

// Default-by-impact bar color for events that don't match a macro family.
function impactHex(impact) {
  if (impact === 'High') return '#e74c3c';
  if (impact === 'Medium') return '#f1c40f';
  if (impact === 'Holiday') return '#BF7FFF';
  return '#8a8f9c';
}

const ALL_IMPACTS = ['High', 'Medium', 'Low', 'Holiday'];
const DEFAULT_IMPACTS = ['High'];

const POLL_MS = 10 * 60 * 1000;
const CLOCK_TICK_MS = 1000;
const NOTIFY_LEAD_MS = 5 * 60 * 1000;

function eventId(e) {
  return `${e.dateTime || ''}::${e.title || ''}`;
}

export default function SlotB() {
  const [feed, setFeed] = useState({ status: 'loading', data: null, error: null, fetchedAt: null });
  const [iv, setIv] = useState({ status: 'loading', data: null });
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

  // FF feed fetch + 10-minute poll + visibility refresh.
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

  // SPX intraday snapshot fetch — skip_contracts=1 keeps the wire
  // small (we only need spotPrice + capturedAt + expirationMetrics).
  // Refreshed on the same 10-minute cadence as the FF feed; the main
  // dashboard's underlying ingest cadence is 5-minute, so a 10-minute
  // poll here picks up at most one ingest cycle of staleness.
  const fetchIv = useCallback(async (signal) => {
    try {
      const res = await fetch('/api/data?skip_contracts=1', { signal, headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setIv({ status: 'ready', data: json });
    } catch (err) {
      if (err?.name === 'AbortError') return;
      setIv((cur) => ({ status: cur.data ? 'ready' : 'error', data: cur.data }));
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    fetchFeed(ac.signal);
    fetchIv(ac.signal);
    const interval = setInterval(() => {
      fetchFeed(ac.signal);
      fetchIv(ac.signal);
    }, POLL_MS);
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        const idleFor = Date.now() - lastFetchRef.current;
        if (idleFor > 5 * 60 * 1000) {
          fetchFeed(ac.signal);
          fetchIv(ac.signal);
        }
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      ac.abort();
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [fetchFeed, fetchIv]);

  // Clock tick.
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

  useEffect(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission === 'granted') setNotifyEnabled(true);
    if (Notification.permission === 'denied') setNotifyDenied(true);
  }, []);

  // IntersectionObserver for sticky hero bar.
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

  // IV/expiration lookup table — sorted by expiration_date ascending.
  // Stored as a memoized array so the per-event resolver below can do
  // a linear scan in chronological order without re-sorting every
  // render.
  const ivContext = useMemo(() => {
    if (!iv.data) return null;
    const { spotPrice, capturedAt, expirationMetrics } = iv.data;
    if (!spotPrice || !capturedAt || !Array.isArray(expirationMetrics)) return null;
    const refMs = new Date(capturedAt).getTime();
    if (Number.isNaN(refMs)) return null;
    const sorted = expirationMetrics
      .filter((m) => m.atm_iv != null && m.expiration_date)
      .map((m) => {
        const expMs = new Date(`${m.expiration_date}T16:00:00-04:00`).getTime();
        const dte = Math.max(0, (expMs - refMs) / 86400000);
        return {
          expiration: m.expiration_date,
          dte,
          atmIv: Number(m.atm_iv),
          put25Iv: m.put_25d_iv != null ? Number(m.put_25d_iv) : null,
          call25Iv: m.call_25d_iv != null ? Number(m.call_25d_iv) : null,
        };
      })
      .filter((m) => m.dte != null && Number.isFinite(m.atmIv))
      .sort((a, b) => a.expiration.localeCompare(b.expiration));
    return { spotPrice: Number(spotPrice), capturedAt, refMs, expirations: sorted };
  }, [iv.data]);

  // Decorate every event with parsed Date + spotlight family + IV-
  // implied move. Implied move is only computed for USD events
  // because the IV data is SPX-only; non-USD events get _impliedMove
  // = null.
  const allEvents = useMemo(() => {
    if (!feed.data) return [];
    const out = [];
    for (const e of feed.data.events || []) {
      const at = new Date(e.dateTime);
      if (Number.isNaN(at.getTime())) continue;
      const sp = classifySpotlight(e.title);
      const implied = ivContext ? resolveImpliedMove(e, ivContext) : null;
      out.push({
        ...e,
        _id: eventId(e),
        _at: at,
        _ms: at.getTime(),
        _spotlight: sp,
        _impliedMove: implied,
      });
    }
    return out.sort((a, b) => a._ms - b._ms);
  }, [feed.data, ivContext]);

  const scoped = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return allEvents.filter((e) => {
      if (impacts.size > 0 && !impacts.has(e.impact)) return false;
      if (q && !e.title.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [allEvents, impacts, searchQuery]);

  const upcoming = useMemo(() => scoped.filter((e) => e._ms >= now), [scoped, now]);
  const past = useMemo(() => scoped.filter((e) => e._ms < now), [scoped, now]);
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

  // Chart input: upcoming high+medium-impact events with computed
  // implied moves. Filtered to the impact tiers that actually move
  // SPX (Low rarely matters for vol traders) and to events that
  // resolved to a valid IV (events without IV data are skipped from
  // the chart even when in scope, since plotting them with a null
  // bar would be visually noisy). Country filtering already happened
  // server-side, so every row in `upcoming` is USD by construction.
  const chartEvents = useMemo(() => {
    return upcoming.filter(
      (e) =>
        (e.impact === 'High' || e.impact === 'Medium') &&
        e._impliedMove &&
        e._impliedMove.movePct > 0,
    );
  }, [upcoming]);

  // Notification scheduling.
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
    if (delay <= 0 || delay > 7 * 24 * 60 * 60 * 1000) return;
    notifyTimeoutRef.current = setTimeout(() => {
      try {
        new Notification(`AI Gamma · ${target.title}`, {
          body: `In 5 minutes. Forecast ${target.forecast || 'n/a'} · Prev ${target.previous || 'n/a'}`,
          icon: '/favicon.ico',
          tag: `ff-${target._id}`,
        });
      } catch {
        /* notification API can throw on iOS WKWebView etc. */
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
        impacts={impacts} setImpacts={setImpacts}
        searchQuery={searchQuery} setSearchQuery={setSearchQuery}
        hidePast={hidePast} setHidePast={setHidePast}
        notifyEnabled={notifyEnabled} notifyDenied={notifyDenied}
        toggleNotify={toggleNotify}
      />

      <div ref={heroRef}>
        {heroGroup ? (
          <HeroNextEvent group={heroGroup} now={now} ivContext={ivContext} />
        ) : (
          <div className="econ-events__hero econ-events__hero--empty">
            <div className="econ-events__hero-empty-text">
              No remaining events this week inside the current scope.
              Broaden the filter or wait for next week's feed refresh.
            </div>
          </div>
        )}
      </div>

      <Totals scoped={scoped} upcoming={upcoming} />

      <ImpliedMoveChart events={chartEvents} ivContext={ivContext} />

      <SpotlightStrip events={scoped} now={now} />

      <DaySchedule
        events={scheduleEvents}
        now={now}
        expandedId={expandedId}
        setExpandedId={setExpandedId}
      />

      <footer className="econ-events__footnote">
        Source: Forex Factory weekly XML at <code>nfs.faireconomy.media/ff_calendar_thisweek.xml</code> +
        the platform's SPX intraday snapshot at <code>/api/data</code> for the implied-move overlays.
        The FF proxy filters to USD events only at the server (this is an SPX-positioning surface).
        Implied move per event = <code>spot × ATM IV × √(DTE/365)</code> evaluated against the next
        SPX expiration AT-OR-AFTER the event date — the move you'd be hedging if you bought a
        straddle at that expiration today, conditional on the event being the next material catalyst.
        Click any row to expose its FF source link, an .ics calendar download, and a 5-minute
        lead-time notification toggle. Times render in your local timezone after server-side
        normalization to America/New_York.
      </footer>
    </div>
  );
}

// ── Implied-move resolver ─────────────────────────────────────────────
// Find the first SPX expiration AT-OR-AFTER the event's calendar date,
// then compute the IV-implied 1-σ move from now to that expiration.
// Notes:
//   - Calendar-date comparison only — events that fall after the
//     expiration's 16:00 ET cash close on the same day are an edge
//     case (most US macro releases hit the wire 8:30am-2pm ET; FOMC
//     press conferences end ~3pm; Trump speech rows in the FF feed
//     occasionally read 11:00pm ET) and the same-day expiration is
//     the right answer for everything except those evening rows. The
//     evening-row case maps to "next-day expiration" but the loss
//     of fidelity is one trading day of vol scaling and not worth
//     the complexity at this PoC stage.
//   - The implied move is the to-expiration σ move, not an isolated
//     event-only premium. Computing the isolated event premium would
//     require subtracting the variance of the expiration immediately
//     before the event from the variance of the expiration immediately
//     after, which is meaningful but adds a second resolver and a
//     forward-variance arithmetic step.
function resolveImpliedMove(event, ivContext) {
  if (!ivContext || !event?.date) return null;
  const exp = ivContext.expirations.find((m) => m.expiration >= event.date);
  if (!exp) return null;
  if (exp.dte == null || exp.dte <= 0) return null;
  const sigmaMove = ivContext.spotPrice * exp.atmIv * Math.sqrt(exp.dte / 365);
  const movePct = exp.atmIv * Math.sqrt(exp.dte / 365) * 100;
  return {
    expiration: exp.expiration,
    dte: exp.dte,
    atmIv: exp.atmIv,
    moveDollars: sigmaMove,
    movePct,
    spotPrice: ivContext.spotPrice,
  };
}

// ── Sticky compact countdown bar ──────────────────────────────────────
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
      {a._impliedMove && (
        <span className="econ-events__sticky-move">±{formatPct(a._impliedMove.movePct)}</span>
      )}
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
// (StickyHeroBar drops country in favor of family + impact + countdown
// since every row is USD now.)

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
  impacts, setImpacts,
  searchQuery, setSearchQuery,
  hidePast, setHidePast,
  notifyEnabled, notifyDenied, toggleNotify,
}) {
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
        {anchor._impliedMove && (
          <ImpliedMovePanel imove={anchor._impliedMove} />
        )}
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

function ImpliedMovePanel({ imove }) {
  return (
    <div className="econ-events__hero-imove">
      <div className="econ-events__hero-imove-label">SPX implied move at next exp</div>
      <div className="econ-events__hero-imove-row">
        <span className="econ-events__hero-imove-value">±${formatNum(imove.moveDollars, 0)}</span>
        <span className="econ-events__hero-imove-pct">±{formatPct(imove.movePct)}</span>
        <span className="econ-events__hero-imove-meta">
          ATM IV {formatPct(imove.atmIv * 100)} · DTE {formatNum(imove.dte, 1)} · exp {imove.expiration}
        </span>
      </div>
    </div>
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

function ForecastInterpretation({ forecast, previous, title }) {
  const f = parseNumeric(forecast);
  const p = parseNumeric(previous);
  if (f == null || p == null) return null;
  if (Math.abs(f - p) < 1e-9) {
    return <div className="econ-events__hero-interp">Consensus expects no change from prior reading.</div>;
  }
  const hotter = f > p;
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

// ── Totals ────────────────────────────────────────────────────────────
function Totals({ scoped, upcoming }) {
  const high = scoped.filter((e) => e.impact === 'High').length;
  const medium = scoped.filter((e) => e.impact === 'Medium').length;
  const low = scoped.filter((e) => e.impact === 'Low').length;
  return (
    <div className="econ-events__totals">
      <Stat label="High" value={high} accent="coral" />
      <Stat label="Medium" value={medium} accent="amber" />
      <Stat label="Low" value={low} accent="muted" />
      <Stat label="Upcoming" value={upcoming.length} accent="green" />
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

// ── Implied-move scatter chart ────────────────────────────────────────
// Custom SVG scatter mirroring the /earnings page's chart pattern (see
// src/components/EarningsCalendar.jsx ScatterChart). X axis is the set
// of dates that carry at least one qualifying event in scope; Y axis
// is implied move in %. Each event is a dot at (event_date, move%);
// labels above the dot give the macro family abbreviation (FOMC,
// CPI, NFP, ...) or a short title slug when no family matches. Same-
// day same-bucket-Y events stack their labels into a comma-joined
// group so the chart never carries diagonal text or overlapping
// markers — the goal here is for the reader to see the week's vol
// catalyst shape at a glance, with full per-event detail living in
// the hover-anchored tooltip rather than on the canvas itself.
//
// The earlier draft used a Plotly bar chart with -38° rotated
// x-axis labels per row; on a typical week with 8-12 qualifying
// events the diagonal labels rendered as an unreadable wall of
// text below the bars. Eric's correction was to mirror the
// earnings-page treatment, where dot scatter + horizontal label
// stacks + hover details cleanly handles the same "many events
// per week" cardinality.
function ImpliedMoveChart({ events, ivContext }) {
  const containerRef = useRef(null);
  const [containerWidth, setContainerWidth] = useState(900);
  const [hovered, setHovered] = useState(null);
  // windowMs is the visible X-axis range (date in ms). null means
  // "use the default window" — first 21 days from refMs. The reader
  // drags the RangeBrush below the chart to expand / pan to LEAPS.
  const [windowMs, setWindowMs] = useState(null);

  // ResizeObserver-driven width so the SVG re-renders with the right
  // dimensions when the lab shell width changes (e.g. dev tools open
  // / phone rotate). Matches the EarningsCalendar pattern.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const obs = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width;
      if (w && w > 100) setContainerWidth(w);
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // ---- All hooks must be called BEFORE any early return. Earlier
  // versions of this component placed the `labelGroups` and
  // `pointMeta` useMemo calls below the empty-state early returns,
  // which produced a React #310 ("rendered more hooks than during
  // the previous render") on the first transition from
  // ivContext=null to ivContext=present. Hoisting all useMemo calls
  // above the conditional renders fixes the violation. The empty-
  // state branches read these memos but get back empty arrays /
  // empty maps, which is fine because they don't actually use the
  // values — they just need the hook count to match across
  // renders. ----

  // Term-structure datapoints: every expiration in the SPX surface
  // turned into an implied 1-σ move from now, plotted underneath the
  // event dots so a reader sees both the event-specific catalysts AND
  // the natural vol-curve shape they sit inside. Each expiration's
  // anchor X is its 16:00 ET expiry timestamp in ms (so 0DTE expirations
  // sit at "today 4pm" and LEAPS sit at "next year 4pm").
  const termPoints = useMemo(() => {
    if (!ivContext) return [];
    return ivContext.expirations.map((m) => {
      const ms = new Date(`${m.expiration}T16:00:00-04:00`).getTime();
      const movePct = m.atmIv * Math.sqrt(Math.max(m.dte, 0.04) / 365) * 100;
      const moveDollars = ivContext.spotPrice * movePct / 100;
      return {
        expiration: m.expiration,
        ms,
        atmIv: m.atmIv,
        dte: m.dte,
        movePct,
        moveDollars,
      };
    }).sort((a, b) => a.ms - b.ms);
  }, [ivContext]);

  // Per-event points carrying their event ms (used for X positioning
  // on the new continuous-date axis). The `_ms` field is already on
  // each event from the SlotB-level parsing pass; nothing else to do.
  const points = useMemo(
    () => events.map((e) => ({ ...e, ms: e._ms })),
    [events],
  );

  // Cluster dots that fall in the same (calendar date, Y bucket of
  // 0.05%) so overlapping markers spread horizontally and labels
  // stack into a comma-joined group. Calendar date is the right
  // grouping key (rather than ms) because two events on the same
  // day at slightly different times still resolve to the same
  // expiration's implied move and should cluster as one visual
  // entity.
  const labelGroups = useMemo(() => {
    const bucket = 0.05;
    const groups = new Map();
    for (const p of points) {
      const yBkt = Math.round(p._impliedMove.movePct / bucket);
      const key = `${p.date}:${yBkt}`;
      if (!groups.has(key)) {
        groups.set(key, { date: p.date, yBkt, members: [], anchorMs: p.ms });
      }
      const g = groups.get(key);
      g.members.push(p);
      // Anchor the cluster at the earliest event ms so the dot/
      // label sits at the start of the day's cluster on tighter
      // zooms.
      if (p.ms < g.anchorMs) g.anchorMs = p.ms;
    }
    return [...groups.values()];
  }, [points]);

  const pointMeta = useMemo(() => {
    const map = new Map();
    for (const g of labelGroups) {
      g.members.forEach((m, i) => map.set(m._id, { group: g, idxInGroup: i }));
    }
    return map;
  }, [labelGroups]);

  // Full X domain (the brush's full range) and the visible window
  // (the main chart's actual X range). The default window is
  // [refMs, refMs + 21 days] — three weeks ahead, which covers the
  // FF "this week" feed plus a bit of breathing room to see the next
  // week's expirations on the term-structure curve. The reader
  // expands or pans via the brush below the chart.
  const fullStartMs = ivContext?.refMs ?? Date.now();
  const fullEndMs = useMemo(() => {
    if (termPoints.length === 0) return fullStartMs + 30 * 86400000;
    return Math.max(...termPoints.map((p) => p.ms));
  }, [termPoints, fullStartMs]);

  const effectiveWindow = useMemo(() => {
    if (windowMs) return windowMs;
    return {
      start: fullStartMs,
      end: Math.min(fullEndMs, fullStartMs + 21 * 86400000),
    };
  }, [windowMs, fullStartMs, fullEndMs]);

  const visibleTermPoints = useMemo(
    () => termPoints.filter((p) => p.ms >= effectiveWindow.start && p.ms <= effectiveWindow.end),
    [termPoints, effectiveWindow],
  );
  const visibleEvents = useMemo(
    () => points.filter((p) => p.ms >= effectiveWindow.start && p.ms <= effectiveWindow.end),
    [points, effectiveWindow],
  );
  const visibleLabelGroups = useMemo(
    () => labelGroups.filter((g) => g.anchorMs >= effectiveWindow.start && g.anchorMs <= effectiveWindow.end),
    [labelGroups, effectiveWindow],
  );

  // ---- End of hook calls. Early returns are safe below. ----

  if (!ivContext) {
    return (
      <section className="econ-events__chart-card">
        <div className="econ-events__chart-meta">
          <span className="econ-events__chart-title">SPX Implied Move per Event</span>
          <span className="econ-events__chart-source">awaiting /api/data — vol surface unavailable</span>
        </div>
        <div className="econ-events__chart-empty">
          The vol-surface fetch hasn't returned yet (or the SPX intraday ingest is currently down).
          Implied-move overlays will populate as soon as <code>/api/data</code> answers.
        </div>
      </section>
    );
  }
  if (events.length === 0) {
    return (
      <section className="econ-events__chart-card">
        <div className="econ-events__chart-meta">
          <span className="econ-events__chart-title">SPX Implied Move per Event</span>
          <span className="econ-events__chart-source">no qualifying events</span>
        </div>
        <div className="econ-events__chart-empty">
          No upcoming high- or medium-impact events in the current scope. The chart populates
          when the FF feed carries a print whose date resolves to an SPX expiration in the
          fetched surface.
        </div>
      </section>
    );
  }

  // Per-cluster max size in the visible window. The label stack
  // above each cluster's dot is one row per event (vs the prior
  // truncated comma-joined single line), so the chart's top padding
  // grows with the worst-case stack height to keep the topmost
  // cluster's stack clear of the chart border. A dense FOMC day
  // (3-4 same-expiration events) needs ~50-65px of headroom; a
  // GDP/PCE Thursday morning (5 events at 12:30) needs ~75px. The
  // base padding of 36px covers the gap between the chart top and
  // the topmost line of the tallest stack.
  const maxClusterSize = visibleLabelGroups.length > 0
    ? Math.max(...visibleLabelGroups.map((g) => uniqueTitles(g.members).length))
    : 1;
  const STACK_LINE_HEIGHT = 14;
  const STACK_DOT_GAP = 12; // pixels between bottom line and dot
  const stackReserve = STACK_DOT_GAP + STACK_LINE_HEIGHT * maxClusterSize;

  const width = Math.max(Math.min(containerWidth - 16, 1100), 320);
  const height = Math.round(Math.min(width * 0.6, 560));
  const PADDING = {
    top: Math.max(52, 36 + stackReserve),
    right: 60,
    bottom: 68,
    left: 76,
  };
  const plotW = width - PADDING.left - PADDING.right;
  const plotH = height - PADDING.top - PADDING.bottom;

  // Y axis: top = 1.15 × max move across visible term points + visible
  // events, rounded up to nearest 0.5%. With the term-structure trace
  // included, the Y range scales to whatever vol curve is visible —
  // a near-term-only window stays low (~1-2%) while a multi-month
  // window opens up to LEAPS-class moves (~5-10%+). Floor at 1.5%
  // so a quiet week doesn't squish all dots against the top gridline.
  const yMaxRaw = useMemo(() => {
    const candidates = [0.015];
    for (const p of visibleTermPoints) candidates.push(p.movePct / 100);
    for (const p of visibleEvents) candidates.push(p._impliedMove.movePct / 100);
    return Math.max(...candidates);
  }, [visibleTermPoints, visibleEvents]);
  const yMax = Math.ceil((yMaxRaw * 1.15) * 200) / 200;

  const windowSpan = effectiveWindow.end - effectiveWindow.start || 1;
  const xForMs = (ms) =>
    PADDING.left + plotW * (ms - effectiveWindow.start) / windowSpan;
  const yForMove = (movePct) => PADDING.top + plotH * (1 - (movePct / 100) / yMax);

  const hoveredKey = hovered ? (hovered._kind === 'event' ? hovered._id : `term:${hovered.expiration}`) : null;

  // Y-axis tick step: 0.25% under 2%, 0.5% under 5%, 1% above.
  const yStep = yMax > 0.05 ? 0.01 : yMax > 0.02 ? 0.005 : 0.0025;

  // X-axis tick locations as ISO dates inside the visible window.
  // Step length scales with window width: dense for short windows,
  // sparse for long ones, so the axis never carries more than ~10
  // tick labels regardless of zoom level.
  const xTicks = useMemo(
    () => buildXTicks(effectiveWindow.start, effectiveWindow.end),
    [effectiveWindow.start, effectiveWindow.end],
  );

  return (
    <section className="econ-events__chart-card">
      <div className="econ-events__chart-meta">
        <span className="econ-events__chart-title">SPX Implied Move per Event</span>
        <span className="econ-events__chart-source">
          spot ${formatNum(ivContext.spotPrice, 0)} · {visibleTermPoints.length} expirations · {visibleEvents.length} events ·
          {' '}±1σ = spot × ATM&nbsp;IV × √(DTE/365)
        </span>
      </div>
      <div ref={containerRef} className="econ-events__scatter">
        <svg width={width} height={height} role="img" aria-label="SPX implied move per event scatter chart">
          {/* Y gridlines + tick labels */}
          {(() => {
            const ticks = [];
            for (let v = 0; v <= yMax + 1e-9; v += yStep) {
              const y = yForMove(v * 100);
              ticks.push(
                <g key={v}>
                  <line
                    x1={PADDING.left} x2={width - PADDING.right}
                    y1={y} y2={y}
                    stroke="rgba(160, 172, 200, 0.10)"
                    strokeDasharray="2 4"
                  />
                  <text
                    x={PADDING.left - 8}
                    y={y + 4}
                    textAnchor="end"
                    fontFamily="Courier New, monospace"
                    fontSize={12}
                    fill="#9aa6c2"
                  >
                    {(v * 100).toFixed(yStep < 0.005 ? 2 : 1)}%
                  </text>
                </g>,
              );
            }
            return ticks;
          })()}

          {/* X axis ticks */}
          {xTicks.map((tick) => {
            const x = xForMs(tick.ms);
            if (x < PADDING.left - 1 || x > width - PADDING.right + 1) return null;
            return (
              <g key={tick.ms}>
                <line
                  x1={x} x2={x}
                  y1={PADDING.top} y2={height - PADDING.bottom}
                  stroke="rgba(160, 172, 200, 0.06)"
                />
                <text
                  x={x}
                  y={height - PADDING.bottom + 22}
                  textAnchor="middle"
                  fontFamily="Courier New, monospace"
                  fontSize={13}
                  fill="#cfd6e6"
                >
                  {tick.label}
                </text>
                {tick.subLabel && (
                  <text
                    x={x}
                    y={height - PADDING.bottom + 40}
                    textAnchor="middle"
                    fontFamily="Courier New, monospace"
                    fontSize={11}
                    fill="#7e8aa0"
                  >
                    {tick.subLabel}
                  </text>
                )}
              </g>
            );
          })}

          {/* Y axis title */}
          <text
            x={-(PADDING.top + plotH / 2)}
            y={18}
            transform="rotate(-90)"
            textAnchor="middle"
            fontFamily="Courier New, monospace"
            fontSize={14}
            fontWeight={600}
            fill="#cfd6e6"
          >
            Implied move (%)
          </text>

          {/* Plot border */}
          <rect
            x={PADDING.left} y={PADDING.top}
            width={plotW} height={plotH}
            fill="none"
            stroke="rgba(160, 172, 200, 0.15)"
          />

          {/* Term-structure trace — connecting line through every
              expiration in the visible window, then small marker
              dots at each expiration. Rendered before the events so
              the colored event dots layer on top. */}
          {visibleTermPoints.length >= 2 && (
            <polyline
              points={visibleTermPoints
                .map((p) => `${xForMs(p.ms)},${yForMove(p.movePct)}`)
                .join(' ')}
              fill="none"
              stroke="rgba(74, 158, 255, 0.45)"
              strokeWidth={1.5}
            />
          )}
          {visibleTermPoints.map((p) => {
            const cx = xForMs(p.ms);
            const cy = yForMove(p.movePct);
            const isHovered = hoveredKey === `term:${p.expiration}`;
            return (
              <circle
                key={`term-${p.expiration}`}
                cx={cx}
                cy={cy}
                r={isHovered ? 5.5 : 3}
                fill="rgba(74, 158, 255, 0.35)"
                stroke={isHovered ? '#4a9eff' : 'rgba(74, 158, 255, 0.55)'}
                strokeWidth={isHovered ? 1.5 : 1}
                style={{ cursor: 'pointer', transition: 'r 0.12s ease' }}
                onMouseEnter={() => setHovered({ ...p, _kind: 'term' })}
                onMouseLeave={() => setHovered(null)}
              />
            );
          })}

          {/* Event dots */}
          {visibleEvents.map((p) => {
            const meta = pointMeta.get(p._id);
            const dotsInGroup = meta ? meta.group.members.length : 1;
            const idx = meta ? meta.idxInGroup : 0;
            const offset = (idx - (dotsInGroup - 1) / 2) * 7;
            const cx = xForMs(p.ms) + offset;
            const cy = yForMove(p._impliedMove.movePct);
            const color = p._spotlight ? p._spotlight.hex : impactHex(p.impact);
            const isHovered = hoveredKey === p._id;
            return (
              <circle
                key={p._id}
                cx={cx}
                cy={cy}
                r={isHovered ? 8 : 5}
                fill={color}
                stroke={isHovered ? '#f0a030' : 'rgba(8, 11, 16, 0.4)'}
                strokeWidth={isHovered ? 2 : 1}
                style={{ cursor: 'pointer', transition: 'r 0.12s ease' }}
                onMouseEnter={() => setHovered({ ...p, _kind: 'event' })}
                onMouseLeave={() => setHovered(null)}
              />
            );
          })}

          {/* Cluster labels — vertical stack of per-event titles
              above the cluster's dot, one line per event, each
              colored by family. Replaces the prior single-line
              comma-joined display that truncated past 5 events
              with " · …" — Eric flagged that as a hard ceiling
              that lost information for any cluster larger than
              the cap. Vertical stacking has no such ceiling: the
              chart's top padding adapts to the worst-case stack
              height (see maxClusterSize / stackReserve above), so
              every event in every cluster gets its own readable
              line. Lines are ordered chronologically with the
              earliest event at the TOP and the last event at the
              BOTTOM closest to the dot, so reading top-to-bottom
              is reading chronologically; the bottom line "anchors"
              the stack to the dot. */}
          {visibleLabelGroups.map((g) => {
            const member = g.members[0];
            const cx = xForMs(g.anchorMs);
            const cy = yForMove(member._impliedMove.movePct);

            // Per-event lines, deduped by title (rare same-title
            // duplicates collapse to one line). Each line carries
            // its event's family hex for tinting, or the default
            // text-primary off-white if no family matched.
            const seen = new Set();
            const lines = [];
            for (const m of g.members) {
              const text = truncTitle(m.title);
              if (seen.has(text)) continue;
              seen.add(text);
              lines.push({
                text,
                color: m._spotlight ? m._spotlight.hex : '#dde4f0',
              });
            }

            // Edge anchoring: when the cluster sits in the leftmost
            // 18% / rightmost 18% of the visible plot, flip the
            // textAnchor so the label extends inward rather than
            // overhanging the Y-axis or the right border.
            const fracX = (cx - PADDING.left) / plotW;
            const isLeftZone = fracX < 0.18;
            const isRightZone = fracX > 0.82;
            const textAnchor = isLeftZone ? 'start' : isRightZone ? 'end' : 'middle';
            const xOffset = isLeftZone ? -4 : isRightZone ? 4 : 0;

            // Stack the lines upward from the dot. The bottommost
            // line sits STACK_DOT_GAP above the dot, the next line
            // STACK_LINE_HEIGHT above that, etc. Iterate the lines
            // array in REVERSE so the last (chronologically latest)
            // event lands at the bottom of the stack and the first
            // event lands at the top — top-to-bottom reading order
            // is chronological order.
            const stackElements = [];
            for (let i = 0; i < lines.length; i++) {
              const fromBottom = lines.length - 1 - i;
              const y = cy - STACK_DOT_GAP - fromBottom * STACK_LINE_HEIGHT;
              stackElements.push(
                <text
                  key={`lbl-${g.date}-${g.yBkt}-${i}`}
                  x={cx + xOffset}
                  y={y}
                  textAnchor={textAnchor}
                  fontFamily="Courier New, monospace"
                  fontSize={11.5}
                  fontWeight={600}
                  fill={lines[i].color}
                  style={{ pointerEvents: 'none' }}
                >
                  {lines[i].text}
                </text>,
              );
            }

            // Thin leader line from just below the bottom label down
            // to just above the dot — the visual "arrow" that ties
            // the multi-line stack to its single anchor point. Only
            // rendered for clusters with 2+ lines (a single-event
            // cluster doesn't need a leader because the text already
            // sits directly above the dot).
            if (lines.length >= 2) {
              const lineTop = cy - STACK_DOT_GAP + 2;
              const lineBottom = cy - 6;
              stackElements.push(
                <line
                  key={`lead-${g.date}-${g.yBkt}`}
                  x1={cx} x2={cx}
                  y1={lineTop} y2={lineBottom}
                  stroke="rgba(160, 172, 200, 0.45)"
                  strokeWidth={1}
                  style={{ pointerEvents: 'none' }}
                />,
              );
            }

            return stackElements;
          })}
        </svg>

        {/* Hover-anchored tooltip — branches on hovered._kind so a
            term-structure dot gets a "next expiration only" tooltip
            and an event dot gets the full event-detail tooltip. */}
        {hovered && (() => {
          let cx;
          let cy;
          if (hovered._kind === 'term') {
            cx = xForMs(hovered.ms);
            cy = yForMove(hovered.movePct);
          } else {
            const meta = pointMeta.get(hovered._id);
            const dotsInGroup = meta ? meta.group.members.length : 1;
            const idx = meta ? meta.idxInGroup : 0;
            const offset = (idx - (dotsInGroup - 1) / 2) * 7;
            cx = xForMs(hovered.ms) + offset;
            cy = yForMove(hovered._impliedMove.movePct);
          }
          const openLeft = cx > width * 0.55;
          const openDown = cy < height * 0.30;
          const o = 14;
          const style = {
            position: 'absolute',
            zIndex: 5,
            pointerEvents: 'none',
            background: 'rgba(8, 11, 16, 0.96)',
            border: '1px solid rgba(160, 172, 200, 0.35)',
            borderRadius: '4px',
            padding: '0.7rem 0.95rem',
            fontFamily: 'Courier New, monospace',
            fontSize: '0.85rem',
            color: '#e1e8f4',
            minWidth: 280,
            maxWidth: 400,
            lineHeight: 1.5,
            boxShadow: '0 2px 12px rgba(0, 0, 0, 0.6)',
          };
          if (openLeft) style.right = (width - cx + o);
          else style.left = cx + o;
          if (openDown) style.top = cy + o;
          else style.bottom = (height - cy + o);
          if (hovered._kind === 'term') {
            return <TermTooltip term={hovered} spotPrice={ivContext.spotPrice} style={style} />;
          }
          return <ChartTooltip event={hovered} style={style} />;
        })()}
      </div>
      <div className="econ-events__brush">
        <div className="econ-events__brush-meta">
          <span>{formatLongRangeDate(effectiveWindow.start)}</span>
          <span className="econ-events__brush-spread">
            {formatRangeSpan(effectiveWindow.end - effectiveWindow.start)}
          </span>
          <span>{formatLongRangeDate(effectiveWindow.end)}</span>
        </div>
        <RangeBrush
          min={fullStartMs}
          max={fullEndMs}
          activeMin={effectiveWindow.start}
          activeMax={effectiveWindow.end}
          onChange={(start, end) => setWindowMs({ start, end })}
          height={36}
          minWidth={86400000}
        />
      </div>
    </section>
  );
}

// ── X-axis ticks ─────────────────────────────────────────────────────
// Pick a sensible step length based on the visible window's span.
// Returns up to ~10 tick objects { ms, label, subLabel }.
function buildXTicks(startMs, endMs) {
  const span = endMs - startMs;
  const day = 86400000;
  const out = [];
  if (span <= 0) return out;
  if (span <= 8 * day) {
    // Per-day ticks. Snap each to local-midnight + 12 noon so the
    // label sits visually centered on the day rather than at its
    // boundary.
    const start = midnightLocalMs(startMs);
    for (let ms = start; ms <= endMs + day; ms += day) {
      const noon = ms + 12 * 3600000;
      if (noon < startMs || noon > endMs) continue;
      const d = new Date(noon);
      out.push({
        ms: noon,
        label: `${d.getMonth() + 1}/${d.getDate()}`,
        subLabel: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()],
      });
    }
  } else if (span <= 60 * day) {
    // Weekly ticks anchored to Mondays.
    const start = midnightLocalMs(startMs);
    const startDow = new Date(start).getDay();
    const offsetToMon = ((1 - startDow) + 7) % 7;
    let ms = start + offsetToMon * day;
    while (ms <= endMs + day) {
      if (ms >= startMs - day) {
        const d = new Date(ms);
        out.push({
          ms,
          label: `${d.getMonth() + 1}/${d.getDate()}`,
          subLabel: 'Mon',
        });
      }
      ms += 7 * day;
    }
  } else if (span <= 200 * day) {
    // ~Bi-weekly ticks every 14 days.
    const start = midnightLocalMs(startMs);
    let ms = start;
    while (ms <= endMs + day) {
      if (ms >= startMs - day) {
        const d = new Date(ms);
        out.push({
          ms,
          label: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
          subLabel: null,
        });
      }
      ms += 14 * day;
    }
  } else {
    // Monthly ticks anchored to the 1st of each month.
    const d0 = new Date(startMs);
    let y = d0.getFullYear();
    let m = d0.getMonth();
    for (let i = 0; i < 18; i++) {
      const d = new Date(y, m, 1, 12, 0, 0);
      const ms = d.getTime();
      if (ms > endMs) break;
      if (ms >= startMs) {
        out.push({
          ms,
          label: d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' }),
          subLabel: null,
        });
      }
      m += 1;
      if (m >= 12) { m = 0; y += 1; }
    }
  }
  return out;
}

function midnightLocalMs(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function formatLongRangeDate(ms) {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatRangeSpan(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const days = Math.round(ms / 86400000);
  if (days < 14) return `${days}-day window`;
  if (days < 60) return `${Math.round(days / 7)}-week window`;
  return `${Math.round(days / 30)}-month window`;
}

// Term-structure tooltip — simpler than the event tooltip because
// the only meaningful payload is the expiration's vol-implied move
// numbers. No forecast/previous/family detail since the dot is the
// expiration itself, not an event.
function TermTooltip({ term, spotPrice, style }) {
  return (
    <div className="econ-events__chart-tooltip" style={style}>
      <div className="econ-events__chart-tooltip-head">
        <strong style={{ color: '#4a9eff' }}>SPX Expiration</strong>
        <span style={{ color: '#9aa6c2' }}>{term.expiration}</span>
      </div>
      <div className="econ-events__chart-tooltip-divider" />
      <ChartTooltipRow
        label="Implied move"
        value={`±${formatPct(term.movePct)} (±$${formatNum(spotPrice * term.movePct / 100, 0)})`}
        highlight
      />
      <ChartTooltipRow label="ATM IV" value={formatPct(term.atmIv * 100)} />
      <ChartTooltipRow label="DTE" value={formatNum(term.dte, 1)} />
    </div>
  );
}

function ChartTooltip({ event: e, style }) {
  const family = e._spotlight;
  const familyColor = family ? family.hex : impactHex(e.impact);
  return (
    <div className="econ-events__chart-tooltip" style={style}>
      <div className="econ-events__chart-tooltip-head">
        <strong style={{ color: familyColor }}>
          {family ? family.label : (e.impact || 'Event')}
        </strong>
        <span className={`econ-events__hero-impact econ-events__hero-impact--${(e.impact || '').toLowerCase()}`}>
          <span className={`econ-events__dot econ-events__dot--${(e.impact || '').toLowerCase()}`} aria-hidden="true" />
          {e.impact || '—'}
        </span>
      </div>
      <div className="econ-events__chart-tooltip-title">{e.title}</div>
      <div className="econ-events__chart-tooltip-when">
        {formatLongWhen(e._at, e.dayKind)}
      </div>
      <div className="econ-events__chart-tooltip-divider" />
      <ChartTooltipRow
        label="Implied move"
        value={`±${formatPct(e._impliedMove.movePct)} (±$${formatNum(e._impliedMove.moveDollars, 0)})`}
        highlight
      />
      <ChartTooltipRow label="ATM IV" value={formatPct(e._impliedMove.atmIv * 100)} />
      <ChartTooltipRow label="DTE" value={formatNum(e._impliedMove.dte, 1)} />
      <ChartTooltipRow label="Next exp" value={e._impliedMove.expiration} />
      <div className="econ-events__chart-tooltip-divider" />
      <ChartTooltipRow label="Forecast" value={e.forecast || '—'} />
      <ChartTooltipRow label="Previous" value={e.previous || '—'} />
    </div>
  );
}

function ChartTooltipRow({ label, value, highlight }) {
  return (
    <div className="econ-events__chart-tooltip-row">
      <span className="econ-events__chart-tooltip-label">{label}</span>
      <span className={`econ-events__chart-tooltip-value${highlight ? ' econ-events__chart-tooltip-value--highlight' : ''}`}>
        {value}
      </span>
    </div>
  );
}

// Short human-readable label for non-family events, used as the
// Per-event label rendered as a single line in the cluster stack
// above the dot. Trims FF's trailing rate-frequency suffixes
// (m/m, y/y, q/q) for visual tidiness — a reader who needs the
// frequency sees it in the hover tooltip — and clips at 28 chars
// with an ellipsis so the label band never grows wide enough to
// collide with the next column even on a fully-zoomed-out brush.
function truncTitle(title) {
  if (!title) return '?';
  const cleaned = title.replace(/\s+m\/m$|\s+y\/y$|\s+q\/q$/i, '').trim();
  if (cleaned.length <= 28) return cleaned;
  return cleaned.slice(0, 27) + '…';
}

// Same dedup pass the cluster-render block uses; lifted as a
// helper so the per-cluster max-size calculation that drives the
// chart's adaptive top padding agrees with what actually renders
// (rendering 4 unique lines but reserving padding for 5 raw
// members would leave wasted whitespace).
function uniqueTitles(members) {
  const seen = new Set();
  const out = [];
  for (const m of members) {
    const t = truncTitle(m.title);
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
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
                  {e._impliedMove && (
                    <span className="econ-events__spotlight-row-meta econ-events__spotlight-row-meta--imove">
                      ±<strong>{formatPct(e._impliedMove.movePct)}</strong>
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
        <span className={`econ-events__row-imove${e._impliedMove ? '' : ' econ-events__row-imove--empty'}`}>
          {e._impliedMove ? `±${formatPct(e._impliedMove.movePct)}` : '—'}
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
      {e._impliedMove && (
        <div className="econ-events__row-detail-imove">
          SPX implied move at next expiration: <strong>±${formatNum(e._impliedMove.moveDollars, 0)}</strong>{' '}
          (<strong>±{formatPct(e._impliedMove.movePct)}</strong>) ·
          ATM IV {formatPct(e._impliedMove.atmIv * 100)} · DTE {formatNum(e._impliedMove.dte, 1)} ·
          exp {e._impliedMove.expiration}
        </div>
      )}
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
    `SUMMARY:${icsEscape(event.title)}`,
    `DESCRIPTION:${icsEscape(buildIcsDescription(event))}`,
    event.url ? `URL:${icsEscape(event.url)}` : null,
    `CATEGORIES:${icsEscape(`Forex Factory · ${event.impact || 'Unknown'}`)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean);
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
  if (e._impliedMove) {
    lines.push(`SPX implied move: ±$${formatNum(e._impliedMove.moveDollars, 0)} (±${formatPct(e._impliedMove.movePct)})`);
  }
  lines.push('Source: Forex Factory · ff_calendar_thisweek.xml');
  if (e.url) lines.push(`Source URL: ${e.url}`);
  return lines.join('\\n');
}

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
function formatNum(n, decimals) {
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function formatPct(n) {
  if (!Number.isFinite(n)) return '—';
  return n < 1 ? `${n.toFixed(2)}%` : `${n.toFixed(1)}%`;
}

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

function isoDateLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}
