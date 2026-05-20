import { useEffect, useMemo, useState } from 'react';

// CatalystBanner — three time-bucketed pills sitting between the
// LevelsPanel (the "three rows of key metrics" at the top of the
// homepage) and the GammaInflectionChart on the main SPX dashboard.
// Each pill scopes a forward time window relative to the reader's
// current wall clock:
//
//   Red    (top)    → catalysts firing in the next 0-24 hours
//   Orange (middle) → 24-48 hours
//   Yellow (bottom) → 48-72 hours
//
// A pill with zero items renders nothing — the banner reserves no
// whitespace for an empty bucket so a quiet 72-hour window collapses
// cleanly. An entirely empty banner (all three buckets zero, or both
// upstream fetches failing) returns null and the page draws as if
// the banner weren't there.
//
// Two catalyst sources feed the banner:
//
//   1. Earnings — calendarDays from /api/earnings?chart_filter=topN-100,
//      with per-ticker wall-clock anchoring at the session midpoint:
//      BMO at 7:00 AM ET, AMC at 4:30 PM ET, with EW's historical
//      epsTime field as a fallback for unsessioned releases. Top 100
//      OV scope is enforced server-side by the topN-100 filter mode
//      so no per-ticker filtering happens here.
//
//   2. Macro events — events from /api/events-calendar (the FF
//      aggregator, USD-only by server-side default), filtered to
//      High and Medium impact tiers. Low and Holiday tiers are
//      excluded so the banner stays focused on market-moving prints
//      rather than Treasury-auction housekeeping or bank holidays.
//
// Both fetches fire once on mount and re-poll every 10 minutes; the
// banner gracefully renders whichever side resolves first. A 60-
// second clock tick rebins on minute boundaries and updates the
// hours-until suffix on each item.

const POLL_MS = 10 * 60 * 1000;
const CLOCK_TICK_MS = 60 * 1000;

// Earnings session anchors — midpoints of the empirical release window
// for each session label, expressed in ET wall-clock. BMO releases
// concentrate in the 6:30-9:00 AM window; AMC releases concentrate
// in the 4:00-5:00 PM window. The midpoint anchor is good enough for
// the 24-hour bucketing the banner does — a release one hour off
// from its anchor only flips a bucket when the actual time straddles
// a 24-hour boundary from "now."
const EARNINGS_BMO_HOUR = 7;
const EARNINGS_BMO_MINUTE = 0;
const EARNINGS_AMC_HOUR = 16;
const EARNINGS_AMC_MINUTE = 30;

// US Eastern wall-clock to UTC Date. Handles EDT/EST automatically by
// probing the date with Intl.DateTimeFormat for the timeZoneName at
// noon UTC of that calendar day, which is unambiguously the same DST
// regime as the actual ET wall time later in the day. Returns null
// on malformed input.
function etWallToUtc(isoDate, hour, minute) {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return null;
  const [y, m, d] = isoDate.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d, 12, 0));
  const tzShort = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'short',
  }).formatToParts(probe).find((p) => p.type === 'timeZoneName')?.value;
  const offsetHours = tzShort === 'EDT' ? 4 : 5;
  return new Date(Date.UTC(y, m - 1, d, hour + offsetHours, minute));
}

// Compress an FF event title to a short banner-friendly label. The
// patterns mirror the spotlight set in events/slots/SlotB.jsx so the
// shorthand a reader sees in the catalyst banner matches the family
// codes used on /events/. Falls back to the first few words of the
// raw title (capped at 22 chars) when no pattern matches.
const EVENT_LABEL_PATTERNS = [
  { rx: /\bFOMC\b|Federal Funds Rate|FOMC Statement|FOMC Meeting Minutes/i, label: 'FOMC' },
  { rx: /Fed Chair|Powell Speaks/i, label: 'Powell' },
  { rx: /\bCPI\b|Core CPI|Consumer Price/i, label: 'CPI' },
  { rx: /Non[- ]?Farm Employment Change|^NFP$/i, label: 'NFP' },
  { rx: /\bGDP\b/i, label: 'GDP' },
  { rx: /Core PCE|\bPCE\b/i, label: 'PCE' },
  { rx: /\bPPI\b/i, label: 'PPI' },
  { rx: /\bISM\b/i, label: 'ISM' },
  { rx: /Unemployment Claims/i, label: 'Claims' },
  { rx: /Job Openings/i, label: 'JOLTS' },
  { rx: /Retail Sales/i, label: 'Retail' },
  { rx: /Consumer Confidence|Consumer Sentiment/i, label: 'Confidence' },
  { rx: /Treasury Bond Auction|Treasury Note Auction/i, label: 'Auction' },
];
function shortenEventLabel(title) {
  if (!title) return '';
  for (const p of EVENT_LABEL_PATTERNS) if (p.rx.test(title)) return p.label;
  const t = String(title).split(/\s+/).slice(0, 3).join(' ');
  return t.length > 22 ? `${t.slice(0, 21)}…` : t;
}

// Format a forward time-to-event as a compact "5h" / "12h" / "45m"
// suffix. Sub-hour offsets render as minutes; otherwise round down
// to the hour so a "23.7h" doesn't visually look like "almost a day"
// (it's actually a hair under one full day).
function formatHoursUntil(hours) {
  if (hours <= 0) return 'now';
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  return `${Math.floor(hours)}h`;
}

function formatLongDate(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export default function CatalystBanner() {
  const [top100Data, setTop100Data] = useState(null);
  const [eventsData, setEventsData] = useState(null);
  const [now, setNow] = useState(() => Date.now());

  // Parallel fetch on mount, re-poll every 10 minutes. Both fetches
  // hit CDN-cached Netlify functions (30 min on /api/earnings during
  // market hours, 1 hour on /api/events-calendar) so the per-poll
  // upstream cost is near zero.
  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();
    const load = async () => {
      const earningsP = (async () => {
        try {
          const r = await fetch('/api/earnings?chart_filter=topN-100', { signal: ac.signal });
          if (!r.ok) return null;
          return await r.json();
        } catch { return null; }
      })();
      const eventsP = (async () => {
        try {
          const r = await fetch('/api/events-calendar', { signal: ac.signal });
          if (!r.ok) return null;
          return await r.json();
        } catch { return null; }
      })();
      const [t, e] = await Promise.all([earningsP, eventsP]);
      if (cancelled) return;
      if (t) setTop100Data(t);
      if (e) setEventsData(e);
    };
    load();
    const id = setInterval(load, POLL_MS);
    return () => { cancelled = true; ac.abort(); clearInterval(id); };
  }, []);

  // Clock tick — bucket boundaries shift one minute per tick of wall
  // time. 60-second resolution is enough for the hours-until suffix.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, []);

  const catalysts = useMemo(() => {
    const out = [];
    for (const day of top100Data?.calendarDays || []) {
      for (const t of day.tickers || []) {
        let hour = null;
        let minute = 0;
        if (t.sessionLabel === 'BMO') { hour = EARNINGS_BMO_HOUR; minute = EARNINGS_BMO_MINUTE; }
        else if (t.sessionLabel === 'AMC') { hour = EARNINGS_AMC_HOUR; minute = EARNINGS_AMC_MINUTE; }
        else if (t.epsTime) {
          // EW's epsTime is an ISO datetime anchored at the prior
          // quarter's release time. Extract the H:MM portion and
          // treat it as ET wall-clock (EW's anchor convention).
          const m = /T(\d{2}):(\d{2})/.exec(t.epsTime);
          if (m) {
            const h = Number(m[1]);
            const mm = Number(m[2]);
            // Sentinel midnight values mean "no historical anchor" — skip.
            if (!(h === 0 && mm === 0)) { hour = h; minute = mm; }
          }
        }
        if (hour == null) continue;
        const at = etWallToUtc(day.isoDate, hour, minute);
        if (!at) continue;
        out.push({
          kind: 'earnings',
          ms: at.getTime(),
          label: t.ticker,
          tooltip: `${t.ticker} · ${t.company || ''} · ${t.sessionLabel || 'Unknown'} · ${formatLongDate(day.isoDate)}`,
        });
      }
    }
    for (const e of eventsData?.events || []) {
      if (!e.dateTime) continue;
      if (e.impact !== 'High' && e.impact !== 'Medium') continue;
      const ms = new Date(e.dateTime).getTime();
      if (Number.isNaN(ms)) continue;
      out.push({
        kind: 'event',
        ms,
        label: shortenEventLabel(e.title),
        tooltip: `${e.title}${e.forecast ? ` · forecast ${e.forecast}` : ''}${e.previous ? ` · prev ${e.previous}` : ''}`,
      });
    }
    return out;
  }, [top100Data, eventsData]);

  const buckets = useMemo(() => {
    const red = [];
    const orange = [];
    const yellow = [];
    for (const c of catalysts) {
      const hours = (c.ms - now) / 3_600_000;
      if (hours <= 0) continue;
      const enriched = { ...c, hours };
      if (hours <= 24) red.push(enriched);
      else if (hours <= 48) orange.push(enriched);
      else if (hours <= 72) yellow.push(enriched);
    }
    const byHours = (a, b) => a.hours - b.hours;
    red.sort(byHours); orange.sort(byHours); yellow.sort(byHours);
    return { red, orange, yellow };
  }, [catalysts, now]);

  const total = buckets.red.length + buckets.orange.length + buckets.yellow.length;
  const ready = (top100Data != null) || (eventsData != null);
  if (!ready || total === 0) return null;

  return (
    <div
      className="card"
      style={{
        marginBottom: '1rem',
        padding: '0.7rem 0.85rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.5rem',
      }}
    >
      <CatalystPill
        label="< 24h"
        title="Imminent: 0 to 24 hours"
        items={buckets.red}
        accent={{ bg: 'rgba(231, 76, 60, 0.10)', border: 'rgba(231, 76, 60, 0.55)', fg: '#e74c3c' }}
      />
      <CatalystPill
        label="25-48h"
        title="Approaching: 24 to 48 hours"
        items={buckets.orange}
        accent={{ bg: 'rgba(231, 138, 60, 0.10)', border: 'rgba(231, 138, 60, 0.55)', fg: '#f0a030' }}
      />
      <CatalystPill
        label="49-72h"
        title="Upcoming: 48 to 72 hours"
        items={buckets.yellow}
        accent={{ bg: 'rgba(241, 196, 15, 0.10)', border: 'rgba(241, 196, 15, 0.45)', fg: '#f1c40f' }}
      />
    </div>
  );
}

// One pill = one bucket. Cap rendered items so a heavy 100-name day
// doesn't blow the banner up to 4 lines: 12 visible + a "+N more"
// italic tail. At ovRank<=100 density a 24-hour bucket holds roughly
// 0-15 names on a peak earnings day, and the 12 most-imminent are
// the ones a reader can actually act on.
function CatalystPill({ label, title, items, accent }) {
  if (!items || items.length === 0) return null;
  const VISIBLE_CAP = 12;
  const visible = items.slice(0, VISIBLE_CAP);
  const overflow = items.length - visible.length;
  return (
    <div
      title={title}
      style={{
        width: '100%',
        background: accent.bg,
        border: `1px solid ${accent.border}`,
        borderRadius: '8px',
        padding: '0.5rem 0.9rem',
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '0.35rem 0.7rem',
        fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
        fontSize: '0.95rem',
        color: '#cfd6e6',
        lineHeight: 1.35,
      }}
    >
      <span
        style={{
          color: accent.fg,
          fontWeight: 700,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          fontSize: '0.78rem',
          whiteSpace: 'nowrap',
          marginRight: '0.2rem',
        }}
      >
        {label}
        <span style={{
          marginLeft: '0.45rem',
          color: 'var(--text-secondary)',
          fontWeight: 600,
        }}>
          ({items.length})
        </span>
      </span>
      {visible.map((c, i) => (
        <span
          key={`${c.kind}-${c.label}-${c.ms}-${i}`}
          title={c.tooltip}
          style={{
            display: 'inline-flex',
            alignItems: 'baseline',
            gap: '0.25rem',
            cursor: 'help',
          }}
        >
          <span style={{
            fontWeight: 700,
            color: c.kind === 'event' ? accent.fg : '#e1e8f4',
          }}>
            {c.label}
          </span>
          <span style={{
            color: 'var(--text-secondary)',
            fontSize: '0.82rem',
          }}>
            {formatHoursUntil(c.hours)}
          </span>
        </span>
      ))}
      {overflow > 0 && (
        <span style={{
          color: 'var(--text-secondary)',
          fontStyle: 'italic',
          fontSize: '0.85rem',
        }}>
          +{overflow} more
        </span>
      )}
    </div>
  );
}
