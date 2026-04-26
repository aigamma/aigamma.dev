// Shared date helpers. Extracted from TermStructure, LevelsPanel, and App so
// the calendar math lives in one place — every consumer uses identical
// Eastern-time anchors and 16:00 cash-close conventions.

export function tradingDateFromCapturedAt(capturedAt) {
  if (!capturedAt) return null;
  const d = new Date(capturedAt);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

// Rounded to one decimal. Used by TermStructure to bucket expirations onto
// the term-structure x-axis against the snapshot's captured_at reference.
export function daysBetween(isoDate, referenceMs) {
  if (!isoDate) return null;
  const target = new Date(`${isoDate}T16:00:00-04:00`).getTime();
  if (Number.isNaN(target)) return null;
  const diff = (target - referenceMs) / (1000 * 60 * 60 * 24);
  return Math.max(0, Math.round(diff * 10) / 10);
}

export function addDaysIso(isoDate, days) {
  if (!isoDate) return null;
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Wall-clock fractional days — LevelsPanel uses this for the expected-move
// horizon where a few hours matters for 0DTE.
export function daysToExpiration(expirationDate, capturedAt) {
  if (!expirationDate || !capturedAt) return null;
  const target = new Date(`${expirationDate}T16:00:00-04:00`).getTime();
  const ref = new Date(capturedAt).getTime();
  if (Number.isNaN(target) || Number.isNaN(ref)) return null;
  const diffDays = (target - ref) / (1000 * 60 * 60 * 24);
  return Math.max(0, diffDays);
}

// Months where the SPX AM-settled monthly expires on the Thursday before the
// nominal 3rd Friday because that Friday is a US market holiday (Good
// Friday or observed Juneteenth). Without this set, the 3rd-Friday-only
// heuristic below would mis-classify those Thursdays as PM weeklies and
// silently exclude them from the monthly picker — pushing the default a
// full month past the genuine SPX AM monthly. Maintained manually rather
// than computed from an Easter algorithm + Juneteenth observance rules
// because the holiday-overlap pattern is sparse (~1 entry every 1-2 years)
// and a small explicit table is easier to audit than two pages of date
// arithmetic. Add a year as 3rd Friday holidays approach.
const SPX_THURSDAY_MONTHLIES = new Set([
  '2025-04-17', // Good Friday on 3rd Friday April 18, 2025
  '2026-06-18', // Juneteenth Friday June 19, 2026
  '2027-06-17', // Juneteenth observed Friday June 18, 2027 (June 19 falls on Saturday)
  '2030-04-18', // Good Friday on 3rd Friday April 19, 2030
  '2032-06-17', // Juneteenth observed Friday June 18, 2032 (June 19 falls on Saturday)
  '2033-04-14', // Good Friday on 3rd Friday April 15, 2033
  '2037-06-18', // Juneteenth Friday June 19, 2037
]);

// True when the ISO date is an AM-settled standard SPX monthly expiration:
// either the 3rd Friday of its calendar month (Friday with day-of-month
// 15..21), or — when that Friday is a US market holiday — the Thursday
// before it (see SPX_THURSDAY_MONTHLIES above). Used by expiration-picker
// logic that needs to prefer monthlies over SPXW weeklies. The function
// keeps the historical name to avoid churning the 15+ call sites; the
// name describes the *intent* (identify the 3rd-Friday SPX monthly) even
// when the actual settlement falls on the prior Thursday.
export function isThirdFridayMonthly(iso) {
  if (!iso) return false;
  if (SPX_THURSDAY_MONTHLIES.has(iso)) return true;
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  if (d.getUTCDay() !== 5) return false;
  const day = d.getUTCDate();
  return day >= 15 && day <= 21;
}

// Strip the same-day expiration out of a picker list. 0DTE SPX contracts
// produce unreliable BSM-derived metrics — ATM IV collapses in the late-
// session pin and the 25Δ call contract can disappear because the delta
// distribution bifurcates — so the picker should never default to one.
// Keying on the ET calendar date removes both the AM-settled SPX monthly
// and the PM-settled SPXW weekly that share today's date on 3rd Fridays.
export function filterPickerExpirations(expirations, capturedAt) {
  if (!expirations?.length) return [];
  const todayIso = tradingDateFromCapturedAt(capturedAt);
  if (!todayIso) return expirations;
  return expirations.filter((exp) => exp !== todayIso);
}

// Choose the default expiration for the metrics panel: the AM-settled
// SPX monthly closest to 30 DTE, preferring one that is at least 21 days
// out (rounded). Falls back to the nearest-to-30 monthly with no floor,
// then to the first element. AM monthlies are the most liquid SPX
// expirations and the primary institutional hedging vehicles, so
// anchoring the default there gives stable ATM IV, Expected Move, and
// 25Δ readings. Requiring rounded DTE ≥ 21 keeps the default from
// drifting onto the current monthly in its final settlement week where
// the term structure can steepen sharply. The DTE is rounded before the
// floor check so a snapshot captured a half-hour past the 16:00 ET cash
// close on a Friday three weeks before the next monthly (DTE = 20.98
// raw) still passes — without rounding the floor would silently kick
// the picker out to the *next* monthly (~55 DTE) or further.
export function pickDefaultExpiration(expirations, capturedAt) {
  if (!expirations?.length) return null;
  const capturedMs = capturedAt ? new Date(capturedAt).getTime() : NaN;
  if (Number.isNaN(capturedMs)) return expirations[0];

  const withDte = expirations.map((exp) => {
    const closeMs = new Date(`${exp}T16:00:00-04:00`).getTime();
    const dte = (closeMs - capturedMs) / 86400000;
    return { exp, dte };
  });

  const monthlies = withDte.filter((x) => isThirdFridayMonthly(x.exp));
  if (monthlies.length === 0) return expirations[0];

  const primary = monthlies.filter((x) => Math.round(x.dte) >= 21);
  if (primary.length > 0) {
    primary.sort((a, b) => Math.abs(a.dte - 30) - Math.abs(b.dte - 30));
    return primary[0].exp;
  }

  // No monthly is ≥ 21 DTE rounded — happens for ~1 week per cycle,
  // between the current monthly's settlement week and the moment the
  // next monthly clears the floor. Pick the closest AM monthly to 30
  // DTE regardless of side, which favors the next monthly (always
  // present in the picker, typically 25-30 DTE in this window) over
  // the current monthly's last few days (single-digit DTE).
  const sorted = [...monthlies].sort(
    (a, b) => Math.abs(a.dte - 30) - Math.abs(b.dte - 30)
  );
  return sorted[0].exp;
}

export function formatFreshness(isoString) {
  if (!isoString) return null;
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return null;
  const et = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: false,
  }).format(d);
  return `${et} ET`;
}

// True on weekends or on weekdays after 16:30 ET. The SPX cash session closes
// at 16:15 ET, but the Massive feed is 15-min-delayed so the final closing
// print only lands in the backend at 16:30 ET (matches the cron gate in
// netlify/functions/ingest.mjs). After 16:30 ET no fresher snapshot is
// expected, so the header label flips from "Last updated:" (implies ongoing
// updates) to "Final:" (implies the snapshot is done moving).
export function isMarketClosed(nowDate) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(nowDate);
  const lookup = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  if (lookup.weekday === 'Sat' || lookup.weekday === 'Sun') return true;
  const hour = parseInt(lookup.hour, 10);
  const minute = parseInt(lookup.minute, 10);
  return hour * 60 + minute >= 16 * 60 + 30;
}
