// Slot B — Economic Events Listener (production, US-only)
//
// The body of the /events/ lab page (events/App.jsx mounts this
// component as its sole tenant). Graduated from /beta/ after the
// PoC iteration converged. The component name is preserved as
// "SlotB" for parity with the /beta/ source — both locations carry
// byte-identical code so a future change to either ports across
// without drift; if the component matures further we can collapse
// the duplicate by promoting it to src/components/.
//
// The earlier draft of this slot embedded a TradingView "Economic
// Calendar" iframe widget on top of the Forex Factory analytics
// panel; that draft was abandoned because the TV widget rendered
// as a near-full-viewport white-screen funnel back to
// tradingview.com instead of usable content. The current
// implementation cuts the embed entirely and renders the surface
// around the FF feed itself joined with the platform's own SPX
// implied-volatility data, so a reader sees both "what's coming"
// and "what's the SPX vol surface pricing for it" on one page.
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
//   1. /api/events-calendar — the FF rolling-4-week aggregator
//      (XML for this week + HTML scrape for the next 3). Polled
//      every 10 min; returns the USD subset (~80–100 events) with
//      title / impact / forecast / previous / dateTime per row.
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
//   TimelineStrip ─ horizontal week-of-events visualization. One row
//     per calendar day; markers positioned at their hour-of-day X
//     within a 6am–8pm window. Marker size keys impact (High = 6.5
//     px, Medium = 4.5 px, Low = 3 px); marker color keys family.
//     Today's row carries an accent-amber dashed NOW vertical line.
//     Past markers fade. Hover any marker for the same forecast /
//     previous / implied-move detail the schedule's click-to-expand
//     carries. Replaced four prior chart drafts (Plotly bar with
//     diagonal labels, custom SVG scatter with cluster labels above
//     dots, term-structure overlay with rangeslider, and a
//     KeyEventsList panel) — all of which collapsed under their
//     own informational density on any reasonable week of data.
//     The timeline keeps only what a desk reader can use at a
//     glance: WHEN events sit relative to one another and to NOW.
//
//   SpotlightStrip ─ one card per macro family with at least one
//     event in scope this week.
//
//   DaySchedule ─ chronological timeline grouped by date, per-day
//     impact-count chips, click-to-expand event rows with FF link /
//     Google Calendar add-event link / forecast-vs-previous interpretation.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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

// Per-impact-tier dot/text color. High = coral, Medium = amber,
// Low = gray, Holiday = teal. Holiday previously shared the purple
// hex with the earnings layer; Eric flagged the visual collision
// (a Holiday-tier macro dot and an earnings dot would render in
// the same color) so Holiday is now the platform's --accent-cyan
// teal token, leaving purple uniquely associated with earnings.
function impactHex(impact) {
  if (impact === 'High') return '#e74c3c';
  if (impact === 'Medium') return '#f1c40f';
  if (impact === 'Holiday') return '#1abc9c';
  return '#8a8f9c';
}
const EARNINGS_HEX = '#BF7FFF';

const ALL_IMPACTS = ['High', 'Medium', 'Low', 'Holiday'];
const DEFAULT_IMPACTS = ['High'];

// Window covered by the timeline visualization at the top of the
// page, in milliseconds. Eric's "This Week's Catalysts" framing
// implies the chart shows ~7 forward days regardless of how much
// data the FF aggregator returned (the schedule below still shows
// the full 4-week scope). 7 days × 24h × 3600s × 1000ms.
const TIMELINE_WINDOW_MS = 7 * 24 * 3600 * 1000;

const POLL_MS = 10 * 60 * 1000;
const CLOCK_TICK_MS = 1000;

function eventId(e) {
  return `${e.dateTime || ''}::${e.title || ''}`;
}

export default function SlotB() {
  const [feed, setFeed] = useState({ status: 'loading', data: null, error: null, fetchedAt: null });
  const [iv, setIv] = useState({ status: 'loading', data: null });
  const [earningsFeed, setEarningsFeed] = useState({ status: 'loading', data: null });
  const [impacts, setImpacts] = useState(new Set(DEFAULT_IMPACTS));
  const [showEarnings, setShowEarnings] = useState(true);
  const [expandedId, setExpandedId] = useState(null);
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

  // Earnings calendar fetch — /api/earnings's calendarDays returns
  // the next 4 weeks of confirmed releases for the default top-100-OV
  // universe, with EW metadata only (no implied moves; the function
  // skips per-name Massive snapshot fan-out for the calendar window
  // to stay inside the Netlify sync timeout). Polled on the same
  // 10-minute cadence as the FF feed and the IV snapshot. The
  // earnings layer on the timeline is purely reference data — the
  // page treats every entry as a known catalyst with its own
  // pre-determined session timing (BMO / AMC / unknown) and renders
  // the dots in the same hour-of-day strip as the macro events.
  const fetchEarnings = useCallback(async (signal) => {
    try {
      const res = await fetch('/api/earnings', { signal, headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setEarningsFeed({ status: 'ready', data: json });
    } catch (err) {
      if (err?.name === 'AbortError') return;
      setEarningsFeed((cur) => ({ status: cur.data ? 'ready' : 'error', data: cur.data }));
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    fetchFeed(ac.signal);
    fetchIv(ac.signal);
    fetchEarnings(ac.signal);
    const interval = setInterval(() => {
      fetchFeed(ac.signal);
      fetchIv(ac.signal);
      fetchEarnings(ac.signal);
    }, POLL_MS);
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        const idleFor = Date.now() - lastFetchRef.current;
        if (idleFor > 5 * 60 * 1000) {
          fetchFeed(ac.signal);
          fetchIv(ac.signal);
          fetchEarnings(ac.signal);
        }
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      ac.abort();
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [fetchFeed, fetchIv, fetchEarnings]);

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

  const scoped = useMemo(
    () => allEvents.filter((e) => impacts.size === 0 || impacts.has(e.impact)),
    [allEvents, impacts],
  );

  const upcoming = useMemo(() => scoped.filter((e) => e._ms >= now), [scoped, now]);
  const past = useMemo(() => scoped.filter((e) => e._ms < now), [scoped, now]);
  const scheduleEvents = scoped;

  const heroGroup = useMemo(() => {
    if (upcoming.length === 0) return null;
    const head = upcoming[0];
    if (!head._spotlight) return { anchor: head, events: [head] };
    const cluster = upcoming.filter(
      (e) => e.date === head.date && e._spotlight?.key === head._spotlight.key,
    );
    return { anchor: head, events: cluster };
  }, [upcoming]);

  // Earnings calendar — flatten the per-day calendar payload into
  // event-shaped records that share the same `_kind` / `_at` / `_ms`
  // contract the macro events use. Each ticker maps to a single
  // record with a session-derived hour-of-day position so the
  // timeline can plot it on the same per-day track as the macro
  // events. Earnings entries are tagged `_kind: 'earnings'` so the
  // render branches on color (purple) and the tooltip branches on
  // the EarningsTooltip variant.
  const earningsEvents = useMemo(() => {
    if (!earningsFeed.data) return [];
    const out = [];
    for (const day of earningsFeed.data.calendarDays || []) {
      const isoDate = day.isoDate;
      if (!isoDate) continue;
      for (const t of day.tickers || []) {
        // Position the dot at the session's expected wall-clock time:
        //   BMO → 7:00 AM (typical pre-open release window 6:30-9:00)
        //   AMC → 4:30 PM (typical post-close window 4:00-5:00)
        //   Unknown → 12:00 noon as a sentinel mid-day position
        let hour = 12;
        let minute = 0;
        if (t.sessionLabel === 'BMO') { hour = 7; minute = 0; }
        else if (t.sessionLabel === 'AMC') { hour = 16; minute = 30; }
        else if (t.epsTime) {
          const m = /T(\d{2}):(\d{2})/.exec(t.epsTime);
          if (m) { hour = Number(m[1]); minute = Number(m[2]); }
        }
        const at = new Date(`${isoDate}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`);
        if (Number.isNaN(at.getTime())) continue;
        out.push({
          _kind: 'earnings',
          _id: `earnings-${t.ticker}-${isoDate}`,
          _at: at,
          _ms: at.getTime(),
          date: isoDate,
          dateTime: at.toISOString(),
          dayKind: 'timed',
          title: `${t.ticker} earnings`,
          country: 'USD',
          impact: null,
          _earnings: t,
        });
      }
    }
    return out.sort((a, b) => a._ms - b._ms);
  }, [earningsFeed.data]);

  // Chart input: upcoming events from the FF feed (any impact tier
  // that the user has on in the active impacts filter) plus the
  // earnings layer when the Earnings toggle is on. The macro events
  // are already filtered through the `upcoming` pipeline so they
  // respect the user's active impact selection; earnings are added
  // unconditionally when the toggle is on (no per-impact gate, since
  // earnings have no FF impact tier — they're their own layer).
  // The TimelineStrip itself further constrains the visible set to a
  // 7-day forward window.
  const chartEvents = useMemo(() => {
    const macro = upcoming;
    if (!showEarnings) return macro;
    const upcomingEarnings = earningsEvents.filter((e) => e._ms >= now);
    return [...macro, ...upcomingEarnings].sort((a, b) => a._ms - b._ms);
  }, [upcoming, earningsEvents, showEarnings, now]);

  if (feed.status === 'loading' && !feed.data) {
    return (
      <section className="econ-events econ-events--bare">
        <div className="econ-events__status">Loading the events calendar…</div>
      </section>
    );
  }
  if (feed.status === 'error' && !feed.data) {
    return (
      <section className="econ-events econ-events--bare">
        <div className="econ-events__status econ-events__status--error">
          Could not reach /api/events-calendar: {feed.error}
        </div>
      </section>
    );
  }

  return (
    <div className="econ-events">
      {!heroVisible && heroGroup && (
        <StickyHeroBar group={heroGroup} now={now} />
      )}

      <div ref={heroRef}>
        {heroGroup ? (
          <HeroNextEvent group={heroGroup} now={now} ivContext={ivContext} />
        ) : (
          <div className="econ-events__hero econ-events__hero--empty">
            <div className="econ-events__hero-empty-text">
              No upcoming events match the current filter scope.
              Broaden the impact filter or wait for the next feed refresh.
            </div>
          </div>
        )}
      </div>

      <Totals scoped={scoped} upcoming={upcoming} />

      <ChartFilters
        impacts={impacts}
        setImpacts={setImpacts}
        showEarnings={showEarnings}
        setShowEarnings={setShowEarnings}
        earningsCount={earningsEvents.filter((e) => e._ms >= now).length}
      />

      <TimelineStrip events={chartEvents} now={now} />

      <SpotlightStrip events={scoped} now={now} />

      <DaySchedule
        events={scheduleEvents}
        now={now}
        expandedId={expandedId}
        setExpandedId={setExpandedId}
      />

      <footer className="econ-events__footnote">
        Implied move per event = <code>spot × ATM IV × √(DTE/365)</code> evaluated against the next
        SPX expiration AT-OR-AFTER the event date. This is the move you'd be hedging if you bought
        a straddle at that expiration today, conditional on the event being the next material
        catalyst. Click any row to add the event to Google Calendar or Outlook in one click; both
        open the destination's web compose form in a new tab pre-populated with the event's
        title, time, and detail payload. Times render in your local timezone.
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
  const impactToken = (a.impact || 'neutral').toLowerCase();
  return (
    <div className={`econ-events__sticky econ-events__sticky--impact-${impactToken} econ-events__sticky--${urgency}`}>
      <span className="econ-events__sticky-eyebrow">Next</span>
      {family && (
        <span className={`econ-events__sticky-family econ-events__sticky-family--impact-${impactToken}`}>
          {family.label}
        </span>
      )}
      <span className="econ-events__sticky-title">{a.title}</span>
      {a._impliedMove && (
        <span className="econ-events__sticky-move">±{formatPct(a._impliedMove.movePct)}</span>
      )}
      <span className={`econ-events__hero-impact econ-events__hero-impact--${(a.impact || '').toLowerCase()}`}>
        <span className={`econ-events__dot econ-events__dot--${(a.impact || '').toLowerCase()}`} aria-hidden="true" />
        {a.impact || '-'}
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

// ── Chart filters ────────────────────────────────────────────────────
// Sits directly above the TimelineStrip and drives both the chart
// scope and the page-wide impact filter. Two pill clusters: one for
// macro impact tiers (High default-on, Medium / Low / Holiday off
// by default), one for the optional Earnings layer (default on).
// The High pill is special — it carries an "anchor" treatment
// (always-active styling, can't be turned off via single click)
// because the page is fundamentally a high-impact-catalyst surface
// and a reader who deselects every impact tier would be left
// staring at an empty chart with no obvious recovery path.
function ChartFilters({ impacts, setImpacts, showEarnings, setShowEarnings, earningsCount }) {
  const toggleImpact = (tier) => {
    setImpacts((prev) => {
      const next = new Set(prev);
      if (next.has(tier)) {
        // Don't allow deselecting the last remaining impact tier —
        // keeps the chart from going blank with no clear recovery.
        if (next.size === 1) return next;
        next.delete(tier);
      } else {
        next.add(tier);
      }
      return next;
    });
  };
  return (
    <div className="econ-events__chart-filters">
      <div className="econ-events__chart-filters-group">
        <span className="econ-events__chart-filters-label">Macro</span>
        {ALL_IMPACTS.map((tier) => {
          const active = impacts.has(tier);
          const cls = tier.toLowerCase();
          const verb = active ? '' : '+ ';
          return (
            <button
              key={tier}
              type="button"
              className={`econ-events__chart-filter-pill econ-events__chart-filter-pill--${cls} ${active ? 'econ-events__chart-filter-pill--active' : ''}`}
              onClick={() => toggleImpact(tier)}
              aria-pressed={active}
            >
              <span className={`econ-events__dot econ-events__dot--${cls}`} aria-hidden="true" />
              {verb}{tier}
            </button>
          );
        })}
      </div>
      <div className="econ-events__chart-filters-group">
        <span className="econ-events__chart-filters-label">Layers</span>
        <button
          type="button"
          className={`econ-events__chart-filter-pill econ-events__chart-filter-pill--earnings ${showEarnings ? 'econ-events__chart-filter-pill--active' : ''}`}
          onClick={() => setShowEarnings((v) => !v)}
          aria-pressed={showEarnings}
          title={showEarnings ? 'Hide top-100-OV earnings releases' : 'Show top-100-OV earnings releases'}
        >
          <span className="econ-events__dot econ-events__dot--earnings" aria-hidden="true" />
          {showEarnings ? '' : '+ '}Earnings (top 100 OV){earningsCount ? ` · ${earningsCount}` : ''}
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
  const impactToken = (anchor.impact || 'neutral').toLowerCase();
  return (
    <section className={`econ-events__hero econ-events__hero--impact-${impactToken} econ-events__hero--${urgency}`}>
      <div className="econ-events__hero-stripe" aria-hidden="true" />
      <div className="econ-events__hero-content">
        <div className="econ-events__hero-meta">
          <span className="econ-events__hero-eyebrow">Next event</span>
          {family && (
            <span className={`econ-events__hero-family-badge econ-events__hero-family-badge--impact-${impactToken}`}>
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
        {value || (pending ? '-' : '-')}
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
      Consensus expects <strong>{direction}</strong> reading vs prior, {delta}.
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


// ── Timeline strip ───────────────────────────────────────────────────
// Horizontal week-of-events strip. The earlier ImpliedMoveChart
// drafts (Plotly bar, custom SVG scatter, term-structure overlay,
// rangeslider, key-events panel) were all discarded — their common
// flaw was that they tried to encode multiple dimensions on one
// canvas (date AND implied-move AND family AND impact AND text-
// labels-without-collision) and lost legibility on every reasonable
// week of data. This component keeps only what a desk reader can
// actually use at a glance: WHEN events sit relative to one another
// and to the current moment. Implied move, forecast, previous,
// full title, family — those all live in the schedule rows below
// and the hover tooltip here.
//
// Layout: one row per calendar day in the event set; each row has
// a small label cell (day name + date + count) on the left and a
// horizontal SVG track on the right showing event markers
// positioned at their hour-of-day X within a 6am–8pm window. The
// "today" row carries an accent-amber dashed NOW vertical line.
// Past markers fade to 0.45 opacity. Hover any marker for the
// same forecast / previous / implied-move detail the schedule's
// click-to-expand carries.
function TimelineStrip({ events, now }) {
  const containerRef = useRef(null);
  const [containerWidth, setContainerWidth] = useState(900);
  const [hovered, setHovered] = useState(null);

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

  // Filter to a 7-day rolling window (today through today + 7 days).
  // The title is fixed at "This Week's Catalysts" — the schedule
  // section below the timeline still shows the full 4-week scope,
  // so a reader who needs to plan further out scrolls past the
  // chart. The chart's job is the next-week glance.
  const windowEndMs = now + TIMELINE_WINDOW_MS;
  const windowEvents = useMemo(
    () => events.filter((e) => e._ms >= now && e._ms <= windowEndMs),
    [events, now, windowEndMs],
  );

  // Group events by calendar date inside the visible window.
  const dayBlocks = useMemo(() => {
    const byDate = new Map();
    for (const e of windowEvents) {
      if (!byDate.has(e.date)) byDate.set(e.date, []);
      byDate.get(e.date).push(e);
    }
    return [...byDate.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, list]) => ({
        date,
        events: list.sort((a, b) => a._ms - b._ms),
      }));
  }, [windowEvents]);

  if (windowEvents.length === 0) {
    return (
      <section className="econ-events__timeline">
        <div className="econ-events__timeline-meta">
          <span className="econ-events__timeline-title">This Week's Catalysts</span>
          <span className="econ-events__timeline-source">no qualifying events in the next 7 days</span>
        </div>
        <div className="econ-events__timeline-empty">
          The timeline populates when the FF feed (or the earnings layer) carries
          an upcoming event in the active impact filter. Try adding Medium / Low
          impact tiers above, or wait for the next feed refresh.
        </div>
      </section>
    );
  }

  const TRACK_LABEL_WIDTH = 88;
  const TRACK_HORIZ_PAD = 14;
  const trackWidth = Math.max(containerWidth - TRACK_LABEL_WIDTH - TRACK_HORIZ_PAD * 2, 200);
  const ROW_HEIGHT = 44;

  const todayIso = isoDateLocal(new Date(now));

  // Per-event color: macro events use their impact tier color (High
  // = coral, Medium = amber, Low = gray, Holiday = purple); earnings
  // events use the EARNINGS_HEX (purple) and render as a hollow ring
  // so they visually distinguish from filled-purple Holiday tier
  // events even when the two share the same hex.
  const colorFor = (e) => (e._kind === 'earnings' ? EARNINGS_HEX : impactHex(e.impact));

  // Macro and earnings counts for the meta strip below the title.
  const macroCount = windowEvents.filter((e) => e._kind !== 'earnings').length;
  const earningsCount = windowEvents.length - macroCount;

  return (
    <section className="econ-events__timeline">
      <div className="econ-events__timeline-meta">
        <span className="econ-events__timeline-title">This Week's Catalysts</span>
        <span className="econ-events__timeline-source">
          {macroCount} macro release{macroCount === 1 ? '' : 's'}
          {earningsCount > 0 ? ` · ${earningsCount} earnings` : ''}
          {' · color keys impact tier · earnings render as a hollow purple ring'}
        </span>
      </div>
      <div className="econ-events__timeline-rows" ref={containerRef}>
        {dayBlocks.map((block) => {
          const dayDate = new Date(`${block.date}T12:00:00`);
          const dayName = dayDate.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase();
          const dayShort = dayDate.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });
          const isToday = block.date === todayIso;

          // X scale within this day: 6:00 AM (0.0 frac) to 8:00 PM
          // (1.0 frac). The bulk of US macro events fall in this
          // 14-hour window; events outside it (e.g. an 11pm Trump
          // speech) clip to the window edges.
          const HOUR_START = 6;
          const HOUR_END = 20;
          const xForEvent = (e) => {
            const d = e._at;
            const hour = d.getHours() + d.getMinutes() / 60;
            const clamped = Math.min(Math.max(hour, HOUR_START), HOUR_END);
            const frac = (clamped - HOUR_START) / (HOUR_END - HOUR_START);
            return frac * trackWidth;
          };

          let nowX = null;
          if (isToday) {
            const nowDate = new Date(now);
            const nowHour = nowDate.getHours() + nowDate.getMinutes() / 60;
            if (nowHour >= HOUR_START && nowHour <= HOUR_END) {
              const frac = (nowHour - HOUR_START) / (HOUR_END - HOUR_START);
              nowX = frac * trackWidth;
            }
          }

          return (
            <div key={block.date} className={`econ-events__timeline-row${isToday ? ' econ-events__timeline-row--today' : ''}`}>
              <div className="econ-events__timeline-label">
                <span className="econ-events__timeline-day">{dayName}</span>
                <span className="econ-events__timeline-date">{dayShort}</span>
                <span className="econ-events__timeline-count">{block.events.length}</span>
              </div>
              <div className="econ-events__timeline-track" style={{ height: ROW_HEIGHT }}>
                <svg
                  width={trackWidth}
                  height={ROW_HEIGHT}
                  style={{ display: 'block' }}
                  role="img"
                  aria-label={`${dayName} ${dayShort} timeline`}
                >
                  <line
                    x1={0} x2={trackWidth}
                    y1={ROW_HEIGHT / 2} y2={ROW_HEIGHT / 2}
                    stroke="rgba(160, 172, 200, 0.18)"
                    strokeWidth={1}
                  />

                  {[8, 10, 12, 14, 16, 18].map((hr) => {
                    const frac = (hr - HOUR_START) / (HOUR_END - HOUR_START);
                    const x = frac * trackWidth;
                    return (
                      <g key={hr}>
                        <line
                          x1={x} x2={x}
                          y1={ROW_HEIGHT / 2 - 4} y2={ROW_HEIGHT / 2 + 4}
                          stroke="rgba(160, 172, 200, 0.18)"
                        />
                        <text
                          x={x}
                          y={ROW_HEIGHT - 4}
                          textAnchor="middle"
                          fontFamily="Calibri, 'Segoe UI', system-ui, sans-serif"
                          fontSize={9}
                          fill="rgba(160, 172, 200, 0.55)"
                        >
                          {hr === 12 ? '12p' : hr > 12 ? `${hr - 12}p` : `${hr}a`}
                        </text>
                      </g>
                    );
                  })}

                  {nowX != null && (
                    <g>
                      <line
                        x1={nowX} x2={nowX}
                        y1={2} y2={ROW_HEIGHT - 14}
                        stroke="#f0a030"
                        strokeWidth={1.5}
                        strokeDasharray="2 3"
                      />
                      <text
                        x={nowX + 3}
                        y={10}
                        fontFamily="Calibri, 'Segoe UI', system-ui, sans-serif"
                        fontSize={9}
                        fontWeight={700}
                        fill="#f0a030"
                      >
                        NOW
                      </text>
                    </g>
                  )}

                  {clusterByMinute(block.events).map((cluster) => {
                    // Anchor the cluster at its first event's hour-of-
                    // day position. All events in a cluster share the
                    // same minute by construction, so xForEvent is the
                    // same for every member — pick any.
                    const cx = xForEvent(cluster.events[0]);
                    const cy = ROW_HEIGHT / 2;
                    // Dot radius scales modestly with cluster size so a
                    // dense BMO 7am cluster reads as visibly heavier
                    // than a single-ticker AMC slot. Capped at +4px so
                    // a 16-event cluster doesn't dominate the row.
                    const r = 5 + Math.min(4, Math.log2(cluster.events.length));
                    const appearance = clusterAppearance(cluster);
                    const isHovered = hovered?.key === cluster.key;
                    const past = cluster.events.every((e) => e._ms < now);
                    return (
                      <g key={cluster.key}>
                        <circle
                          cx={cx}
                          cy={cy}
                          r={isHovered ? r + 2.5 : r}
                          fill={appearance.fill}
                          stroke={isHovered ? '#f0a030' : appearance.stroke}
                          strokeWidth={isHovered ? 2 : appearance.strokeWidth}
                          opacity={past && !isHovered ? 0.45 : 1}
                          style={{ cursor: 'pointer', transition: 'r 0.12s ease' }}
                          onMouseEnter={() => setHovered(cluster)}
                          onMouseLeave={() => setHovered(null)}
                        />
                        {cluster.events.length > 1 && (
                          <text
                            x={cx}
                            y={cy + 3.5}
                            textAnchor="middle"
                            fontFamily="Calibri, 'Segoe UI', system-ui, sans-serif"
                            fontSize={9}
                            fontWeight={700}
                            fill={appearance.fill === 'transparent' ? appearance.stroke : '#0d1016'}
                            style={{ pointerEvents: 'none' }}
                          >
                            {cluster.events.length}
                          </text>
                        )}
                      </g>
                    );
                  })}
                </svg>

                {hovered && hovered.date === block.date && (() => {
                  const cx = xForEvent(hovered.events[0]);
                  const openLeft = cx > trackWidth * 0.55;
                  const o = 14;
                  const style = {
                    position: 'absolute',
                    zIndex: 5,
                    pointerEvents: 'none',
                    background: 'rgba(8, 11, 16, 0.96)',
                    border: '1px solid rgba(160, 172, 200, 0.35)',
                    borderRadius: '4px',
                    padding: '0.7rem 0.95rem',
                    fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
                    fontSize: '0.82rem',
                    color: '#e1e8f4',
                    minWidth: 260,
                    maxWidth: 420,
                    lineHeight: 1.5,
                    boxShadow: '0 2px 12px rgba(0, 0, 0, 0.6)',
                    bottom: ROW_HEIGHT + 4,
                  };
                  if (openLeft) style.right = (trackWidth - cx + o);
                  else style.left = cx + o;
                  // Single-event clusters use the existing detail
                  // tooltip variants; multi-event clusters use the new
                  // ClusterTooltip that lists every member.
                  if (hovered.events.length === 1) {
                    const single = hovered.events[0];
                    return single._kind === 'earnings'
                      ? <EarningsTooltip event={single} style={style} />
                      : <TimelineTooltip event={single} style={style} />;
                  }
                  return <ClusterTooltip cluster={hovered} style={style} />;
                })()}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function TimelineTooltip({ event: e, style }) {
  const family = e._spotlight;
  const impactColor = impactHex(e.impact);
  return (
    <div className="econ-events__chart-tooltip" style={style}>
      <div className="econ-events__chart-tooltip-head">
        <strong style={{ color: impactColor }}>
          {family ? family.label : (e.impact || 'Event')}
        </strong>
        <span className={`econ-events__hero-impact econ-events__hero-impact--${(e.impact || '').toLowerCase()}`}>
          <span className={`econ-events__dot econ-events__dot--${(e.impact || '').toLowerCase()}`} aria-hidden="true" />
          {e.impact || '-'}
        </span>
      </div>
      <div className="econ-events__chart-tooltip-title">{e.title}</div>
      <div className="econ-events__chart-tooltip-when">
        {formatLongWhen(e._at, e.dayKind)}
      </div>
      {e._impliedMove && (
        <>
          <div className="econ-events__chart-tooltip-divider" />
          <div className="econ-events__chart-tooltip-row">
            <span className="econ-events__chart-tooltip-label">Implied move</span>
            <span className="econ-events__chart-tooltip-value econ-events__chart-tooltip-value--highlight">
              ±{formatPct(e._impliedMove.movePct)} (±${formatNum(e._impliedMove.moveDollars, 0)})
            </span>
          </div>
          <div className="econ-events__chart-tooltip-row">
            <span className="econ-events__chart-tooltip-label">ATM IV</span>
            <span className="econ-events__chart-tooltip-value">{formatPct(e._impliedMove.atmIv * 100)}</span>
          </div>
        </>
      )}
      <div className="econ-events__chart-tooltip-divider" />
      <div className="econ-events__chart-tooltip-row">
        <span className="econ-events__chart-tooltip-label">Forecast</span>
        <span className="econ-events__chart-tooltip-value">{e.forecast || '-'}</span>
      </div>
      <div className="econ-events__chart-tooltip-row">
        <span className="econ-events__chart-tooltip-label">Previous</span>
        <span className="econ-events__chart-tooltip-value">{e.previous || '-'}</span>
      </div>
    </div>
  );
}

// Earnings-row tooltip — fields are the EarningsWhispers metadata
// the /api/earnings function ships in calendarDays[].tickers[].
// Cluster events that share the same hour:minute on the same day
// so they render as a single dot rather than overlapping markers
// at the same X position. Eric noticed Thursday's AMC cluster was
// only showing one ticker (RIVN) when AAPL and other top-100 names
// were also reporting at 4:30pm — the markers were stacking at the
// identical X/Y position with only the topmost circle hit-testable
// and visible.
function clusterByMinute(events) {
  const buckets = new Map();
  for (const e of events) {
    const minuteKey = Math.floor(e._ms / 60000);
    if (!buckets.has(minuteKey)) {
      buckets.set(minuteKey, {
        key: `${e.date}-${minuteKey}`,
        ms: e._ms,
        date: e.date,
        events: [],
      });
    }
    buckets.get(minuteKey).events.push(e);
  }
  return [...buckets.values()].sort((a, b) => a.ms - b.ms);
}

// Cluster fill / stroke decision: pure-earnings clusters render as
// hollow purple rings (preserving the earnings-layer visual
// identity); any cluster containing a macro event picks the color
// of the highest-impact macro member and renders filled. The
// individual events still appear separately in the cluster
// tooltip so a mixed cluster (rare — usually a macro release at
// 8:30am can collide with a BMO earnings at 7:00am only when
// rounded; in practice they're separate minutes and don't cluster)
// keeps full per-event detail accessible on hover.
function clusterAppearance(cluster) {
  const macros = cluster.events.filter((e) => e._kind !== 'earnings');
  if (macros.length === 0) {
    return { fill: 'transparent', stroke: EARNINGS_HEX, strokeWidth: 1.5 };
  }
  const impactRank = { High: 3, Medium: 2, Low: 1, Holiday: 0 };
  const top = macros.reduce(
    (best, e) =>
      (impactRank[e.impact] || 0) > (impactRank[best.impact] || 0) ? e : best,
    macros[0],
  );
  return {
    fill: impactHex(top.impact),
    stroke: 'rgba(8, 11, 16, 0.55)',
    strokeWidth: 1,
  };
}

// Tooltip for a multi-event cluster — splits the membership into
// macro and earnings sub-sections, each rendering one compact row
// per event. Long earnings clusters cap at MAX_ROWS members with a
// "+ N more" tail so a 30-name reporting day's tooltip stays
// readable; the schedule below the chart still carries the full
// list. Single-event clusters do NOT use this variant — they fall
// through to the existing TimelineTooltip / EarningsTooltip
// branches in the timeline render.
function ClusterTooltip({ cluster, style }) {
  const MAX_ROWS = 12;
  const events = cluster.events.slice().sort((a, b) => a._ms - b._ms);
  const macros = events.filter((e) => e._kind !== 'earnings');
  const earnings = events.filter((e) => e._kind === 'earnings');
  const time = events[0]._at.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return (
    <div className="econ-events__chart-tooltip" style={style}>
      <div className="econ-events__chart-tooltip-head">
        <strong style={{ color: '#e1e8f4' }}>
          {events.length} events at {time}
        </strong>
      </div>
      <div className="econ-events__chart-tooltip-when">
        {formatLongDate(cluster.date)}
      </div>
      {macros.length > 0 && (
        <>
          <div className="econ-events__chart-tooltip-divider" />
          <div className="econ-events__cluster-section-label">
            Macro releases · {macros.length}
          </div>
          {macros.map((e) => (
            <div key={e._id} className="econ-events__cluster-row">
              <span
                className={`econ-events__dot econ-events__dot--${(e.impact || '').toLowerCase()}`}
                aria-hidden="true"
              />
              <span className="econ-events__cluster-row-title">{e.title}</span>
              {e.forecast && (
                <span className="econ-events__cluster-row-meta">fcst {e.forecast}</span>
              )}
            </div>
          ))}
        </>
      )}
      {earnings.length > 0 && (
        <>
          <div className="econ-events__chart-tooltip-divider" />
          <div className="econ-events__cluster-section-label">
            Earnings · {earnings.length}
          </div>
          {earnings.slice(0, MAX_ROWS).map((e) => {
            const t = e._earnings || {};
            return (
              <div key={e._id} className="econ-events__cluster-row">
                <span className="econ-events__dot econ-events__dot--earnings" aria-hidden="true" />
                <span className="econ-events__cluster-row-title">
                  <strong style={{ color: EARNINGS_HEX }}>{t.ticker}</strong>
                  <span className="econ-events__cluster-row-company">{t.company || ''}</span>
                </span>
                <span className="econ-events__cluster-row-meta">
                  {formatRevenue(t.revenueEst)}
                </span>
              </div>
            );
          })}
          {earnings.length > MAX_ROWS && (
            <div className="econ-events__cluster-row econ-events__cluster-row--more">
              + {earnings.length - MAX_ROWS} more · see schedule below
            </div>
          )}
        </>
      )}
    </div>
  );
}

function EarningsTooltip({ event: e, style }) {
  const t = e._earnings || {};
  const sessionLabel = t.sessionLabel === 'BMO' ? 'Before Market Open'
    : t.sessionLabel === 'AMC' ? 'After Market Close'
    : t.sessionLabel === 'Unknown' ? 'Unknown timing'
    : (t.sessionLabel || 'Unknown timing');
  return (
    <div className="econ-events__chart-tooltip" style={style}>
      <div className="econ-events__chart-tooltip-head">
        <strong style={{ color: EARNINGS_HEX }}>EARNINGS</strong>
        <span style={{ color: EARNINGS_HEX, fontSize: '0.75rem' }}>
          {t.ticker || ''}
        </span>
      </div>
      <div className="econ-events__chart-tooltip-title">{t.company || t.ticker || 'Earnings release'}</div>
      <div className="econ-events__chart-tooltip-when">
        {formatLongDate(e.date)} · {sessionLabel}
      </div>
      <div className="econ-events__chart-tooltip-divider" />
      <div className="econ-events__chart-tooltip-row">
        <span className="econ-events__chart-tooltip-label">Revenue est</span>
        <span className="econ-events__chart-tooltip-value">{formatRevenue(t.revenueEst)}</span>
      </div>
      <div className="econ-events__chart-tooltip-row">
        <span className="econ-events__chart-tooltip-label">EPS est</span>
        <span className="econ-events__chart-tooltip-value">{t.epsEst != null ? `$${Number(t.epsEst).toFixed(2)}` : '-'}</span>
      </div>
      {t.ovRank != null && (
        <div className="econ-events__chart-tooltip-row">
          <span className="econ-events__chart-tooltip-label">OV rank · MC rank</span>
          <span className="econ-events__chart-tooltip-value">
            ov{t.ovRank}{t.mcRank != null ? ` · mc${t.mcRank}` : ''}
          </span>
        </div>
      )}
      {t.weight != null && (
        <div className="econ-events__chart-tooltip-row">
          <span className="econ-events__chart-tooltip-label">SP500 weight</span>
          <span className="econ-events__chart-tooltip-value">{Number(t.weight).toFixed(2)}%</span>
        </div>
      )}
    </div>
  );
}

function formatRevenue(v) {
  if (v == null || !Number.isFinite(Number(v))) return '-';
  const n = Number(v);
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  return `$${n.toFixed(0)}`;
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
        // Spotlight cards are family-grouped (FOMC card holds all
        // FOMC events, etc.) but Eric's directive is to drop family
        // color coding and color by impact instead. The card's
        // border picks up the impact tier of the head event — most
        // family clusters are uniform-tier in practice (FOMC =
        // High, ISM = Medium, etc.), so the head's tier is a
        // faithful summary of the card's contents.
        const impactToken = (head.impact || 'neutral').toLowerCase();
        return (
          <div
            key={g.spotlight.key}
            className={`econ-events__spotlight-card econ-events__spotlight-card--impact-${impactToken}${past ? ' econ-events__spotlight-card--past' : ''}`}
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
  const impactToken = (e.impact || 'neutral').toLowerCase();
  return (
    <div
      className={`econ-events__row econ-events__row--impact-${impactToken}${past ? ' econ-events__row--past' : ''}${expanded ? ' econ-events__row--expanded' : ''}`}
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
          {e.forecast || '-'}
        </span>
        <span className="econ-events__row-num">
          <span className="econ-events__row-num-label">P</span>
          {e.previous || '-'}
        </span>
        <span className={`econ-events__row-imove${e._impliedMove ? '' : ' econ-events__row-imove--empty'}`}>
          {e._impliedMove ? `±${formatPct(e._impliedMove.movePct)}` : '-'}
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
  const googleHref = useMemo(() => googleCalendarUrl(e), [e]);
  const outlookHref = useMemo(() => outlookCalendarUrl(e), [e]);
  const [news, setNews] = useState({ status: 'loading', items: [] });

  // Lazy fetch the news feed when the row is expanded. The function
  // proxies Google News RSS keyed off a query derived from the
  // event title (or "{TICKER} earnings" for earnings rows). Cached
  // 30 min on the edge so re-expanding the same row is essentially
  // free — the cache key is the query string, not the row id, so
  // an FOMC Statement and an FOMC Press Conference share the same
  // upstream fetch when they land on the same query (they don't
  // here — they have distinct titles — but the principle holds).
  useEffect(() => {
    let cancelled = false;
    const query = newsQueryForEvent(e);
    if (!query) return undefined;
    setNews({ status: 'loading', items: [] });
    fetch(`/api/event-news?q=${encodeURIComponent(query)}`, {
      headers: { Accept: 'application/json' },
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((json) => {
        if (cancelled) return;
        setNews({ status: 'ready', items: Array.isArray(json.items) ? json.items : [] });
      })
      .catch(() => {
        if (cancelled) return;
        setNews({ status: 'error', items: [] });
      });
    return () => { cancelled = true; };
  }, [e._id]);

  return (
    <div className="econ-events__row-detail">
      <div className="econ-events__row-detail-row">
        {googleHref && (
          <a
            className="econ-events__row-action econ-events__row-action--link"
            href={googleHref}
            target="_blank"
            rel="noopener noreferrer"
          >
            Add to Google Calendar ↗
          </a>
        )}
        {outlookHref && (
          <a
            className="econ-events__row-action econ-events__row-action--link"
            href={outlookHref}
            target="_blank"
            rel="noopener noreferrer"
          >
            Add to Outlook ↗
          </a>
        )}
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
      <NewsFeed news={news} />
    </div>
  );
}

// Build the news query string for an event. Macro events use the
// title with the trailing m/m / y/y / q/q rate-frequency suffix
// stripped (the suffix is irrelevant to news search and pollutes
// the query). Earnings rows use "{TICKER} earnings" so a row for
// Apple's quarterly maps to "AAPL earnings" — Google News returns
// pre-print analyst expectations and post-print results equally
// well from that anchor.
function newsQueryForEvent(e) {
  if (!e) return '';
  if (e._kind === 'earnings') {
    const ticker = e._earnings?.ticker;
    return ticker ? `${ticker} earnings` : '';
  }
  return (e.title || '').replace(/\s+m\/m$|\s+y\/y$|\s+q\/q$/i, '').trim();
}

function NewsFeed({ news }) {
  if (news.status === 'loading') {
    return (
      <div className="econ-events__news">
        <div className="econ-events__news-label">News</div>
        <div className="econ-events__news-status">loading…</div>
      </div>
    );
  }
  if (news.status === 'error') {
    return (
      <div className="econ-events__news">
        <div className="econ-events__news-label">News</div>
        <div className="econ-events__news-status econ-events__news-status--error">
          news fetch failed
        </div>
      </div>
    );
  }
  if (news.items.length === 0) {
    return (
      <div className="econ-events__news">
        <div className="econ-events__news-label">News</div>
        <div className="econ-events__news-status">no recent coverage</div>
      </div>
    );
  }
  return (
    <div className="econ-events__news">
      <div className="econ-events__news-label">News · {news.items.length}</div>
      <ul className="econ-events__news-list">
        {news.items.map((it, i) => (
          <li key={`${it.link}-${i}`} className="econ-events__news-item">
            <a
              className="econ-events__news-link"
              href={it.link}
              target="_blank"
              rel="noopener noreferrer"
            >
              {it.title}
            </a>
            <div className="econ-events__news-meta">
              <span className="econ-events__news-source">{it.source || '-'}</span>
              <span className="econ-events__news-sep">·</span>
              <span className="econ-events__news-time">{it.pubDateRelative || ''}</span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Google Calendar handoff ───────────────────────────────────────
// Builds a calendar.google.com/render?action=TEMPLATE URL pre-filled
// with the event's title, start/end times (UTC, Z-suffix), and a
// description that carries the impact / forecast / previous /
// implied-move payload. Clicking the link opens Google Calendar's
// new-event form in a new tab with everything pre-populated; the
// user clicks Save and the event lands on their calendar — no file
// download, no Outlook handoff, no per-platform .ics quirks. The
// prior implementation generated an .ics blob the browser handed
// off to whatever default-calendar handler the OS had registered;
// on macOS that opens Calendar.app (fast), on iOS it opens an
// approval modal (slow), on Windows defaults route to Outlook
// (very slow on first-time setup). Eric's directive: ditch .ics
// entirely, route to Google Calendar which most readers actually
// use.
//
// Returns null for events without a precise time (all-day /
// tentative entries) so the action button suppresses for those —
// pre-filling Google Calendar with a midnight-anchored entry that
// the user has to manually edit isn't an improvement.
const GCAL_BASE = 'https://calendar.google.com/calendar/render';

function googleCalendarUrl(event) {
  if (!event) return null;
  if (event.dayKind === 'all-day' || event.dayKind === 'tentative') return null;
  const start = event._at instanceof Date ? event._at : new Date(event.dateTime);
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  const fmtUtc = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: event.title || 'Event',
    dates: `${fmtUtc(start)}/${fmtUtc(end)}`,
    details: buildEventDescription(event),
    ctz: 'America/New_York',
  });
  return `${GCAL_BASE}?${params.toString()}`;
}

// Outlook web (outlook.live.com) deep-link template — same idea as
// Google's URL-template handoff but Microsoft's path. Critical
// distinction: this opens Outlook's WEB compose form in a new tab,
// NOT a download that triggers the OS-level Outlook desktop file
// association. Eric's prior .ics flow handed the file off to the
// desktop Outlook app which spun up an "extended upgrade animation
// with an envelope" loop — that's exactly the path this URL
// avoids. Personal outlook.live.com handles the redirect for
// outlook.office.com (work/school) tenants automatically when the
// user is signed in there, so a single URL covers both consumer
// and business Outlook web users.
const OUTLOOK_BASE = 'https://outlook.live.com/calendar/0/deeplink/compose';

function outlookCalendarUrl(event) {
  if (!event) return null;
  if (event.dayKind === 'all-day' || event.dayKind === 'tentative') return null;
  const start = event._at instanceof Date ? event._at : new Date(event.dateTime);
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  const params = new URLSearchParams({
    subject: event.title || 'Event',
    body: buildEventDescription(event),
    startdt: start.toISOString(),
    enddt: end.toISOString(),
    allday: 'false',
    path: '/calendar/action/compose',
    rru: 'addevent',
  });
  return `${OUTLOOK_BASE}?${params.toString()}`;
}

function buildEventDescription(e) {
  const lines = [];
  if (e.impact) lines.push(`Impact: ${e.impact}`);
  if (e.forecast) lines.push(`Forecast: ${e.forecast}`);
  if (e.previous) lines.push(`Previous: ${e.previous}`);
  if (e._spotlight) lines.push(`Family: ${e._spotlight.label}`);
  if (e._impliedMove) {
    lines.push(`SPX implied move: ±$${formatNum(e._impliedMove.moveDollars, 0)} (±${formatPct(e._impliedMove.movePct)})`);
  }
  if (e._kind === 'earnings' && e._earnings) {
    const t = e._earnings;
    if (t.company) lines.push(`Company: ${t.company}`);
    if (t.sessionLabel) lines.push(`Session: ${t.sessionLabel}`);
    if (t.epsEst != null) lines.push(`EPS estimate: $${Number(t.epsEst).toFixed(2)}`);
  }
  return lines.join('\n');
}

// ── Formatting helpers ────────────────────────────────────────────────
function formatNum(n, decimals) {
  if (!Number.isFinite(n)) return '-';
  return n.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function formatPct(n) {
  if (!Number.isFinite(n)) return '-';
  return n < 1 ? `${n.toFixed(2)}%` : `${n.toFixed(1)}%`;
}

function formatLongWhen(dt, dayKind) {
  if (!(dt instanceof Date) || Number.isNaN(dt.getTime())) return '-';
  const day = dt.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  if (dayKind === 'all-day') return `${day} · All Day`;
  if (dayKind === 'tentative') return `${day} · Tentative`;
  const time = dt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
  const tz = dt.toLocaleTimeString(undefined, { timeZoneName: 'short' }).split(' ').pop();
  return `${day} · ${time} ${tz}`;
}

function formatTimeOnly(dt, dayKind) {
  if (!(dt instanceof Date) || Number.isNaN(dt.getTime())) return '-';
  if (dayKind === 'all-day') return 'All Day';
  if (dayKind === 'tentative') return 'Tentative';
  return dt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
}

function formatRelativeWhen(dt, dayKind, now) {
  if (!(dt instanceof Date) || Number.isNaN(dt.getTime())) return '-';
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
