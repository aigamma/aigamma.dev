// Algorithmic NYSE trading-day calendar for the historical backfill.
// ThetaTerminal v3 does not expose a calendar endpoint, so this file
// enumerates weekdays in a window and filters against hardcoded US
// equity market holidays for 2016–2026. Only used by one-shot backfill
// scripts — the live reconciler gets its date from the clock, not from
// this calendar.

// Full-day closures only. Early-close days (1pm ET day-before-holiday
// sessions) are still full trading days for EOD purposes. The Juneteenth
// observance follows the federal rule: when the holiday falls on a
// Saturday, the market observes Friday; on Sunday, it observes Monday.
// NYSE began observing Juneteenth in 2022.
const NYSE_HOLIDAYS = new Set([
  // 2016
  '2016-01-01', // New Year's Day
  '2016-01-18', // MLK Day
  '2016-02-15', // Washington's Birthday
  '2016-03-25', // Good Friday
  '2016-05-30', // Memorial Day
  '2016-07-04', // Independence Day
  '2016-09-05', // Labor Day
  '2016-11-24', // Thanksgiving
  '2016-12-26', // Christmas (observed; Dec 25 is Sunday)
  // 2017
  '2017-01-02', // New Year's Day (observed; Jan 1 is Sunday)
  '2017-01-16', // MLK Day
  '2017-02-20', // Washington's Birthday
  '2017-04-14', // Good Friday
  '2017-05-29', // Memorial Day
  '2017-07-04', // Independence Day
  '2017-09-04', // Labor Day
  '2017-11-23', // Thanksgiving
  '2017-12-25', // Christmas
  // 2018
  '2018-01-01', // New Year's Day
  '2018-01-15', // MLK Day
  '2018-02-19', // Washington's Birthday
  '2018-03-30', // Good Friday
  '2018-05-28', // Memorial Day
  '2018-07-04', // Independence Day
  '2018-09-03', // Labor Day
  '2018-11-22', // Thanksgiving
  '2018-12-05', // Day of mourning — President George H.W. Bush
  '2018-12-25', // Christmas
  // 2019
  '2019-01-01', // New Year's Day
  '2019-01-21', // MLK Day
  '2019-02-18', // Washington's Birthday
  '2019-04-19', // Good Friday
  '2019-05-27', // Memorial Day
  '2019-07-04', // Independence Day
  '2019-09-02', // Labor Day
  '2019-11-28', // Thanksgiving
  '2019-12-25', // Christmas
  // 2020
  '2020-01-01', // New Year's Day
  '2020-01-20', // MLK Day
  '2020-02-17', // Washington's Birthday
  '2020-04-10', // Good Friday
  '2020-05-25', // Memorial Day
  '2020-07-03', // Independence Day (observed; July 4 is Saturday)
  '2020-09-07', // Labor Day
  '2020-11-26', // Thanksgiving
  '2020-12-25', // Christmas
  // 2021
  '2021-01-01', // New Year's Day
  '2021-01-18', // MLK Day
  '2021-02-15', // Washington's Birthday
  '2021-04-02', // Good Friday
  '2021-05-31', // Memorial Day
  '2021-07-05', // Independence Day (observed; July 4 is Sunday)
  '2021-09-06', // Labor Day
  '2021-11-25', // Thanksgiving
  '2021-12-24', // Christmas (observed; Dec 25 is Saturday)
  // 2022
  '2022-01-17', // MLK Day
  '2022-02-21', // Washington's Birthday
  '2022-04-15', // Good Friday
  '2022-05-30', // Memorial Day
  '2022-06-20', // Juneteenth (observed; June 19 is Sunday) — first year NYSE observed
  '2022-07-04', // Independence Day
  '2022-09-05', // Labor Day
  '2022-11-24', // Thanksgiving
  '2022-12-26', // Christmas (observed; Dec 25 is Sunday)
  // 2023
  '2023-01-02', // New Year's Day (observed; Jan 1 is Sunday)
  '2023-01-16', // MLK Day
  '2023-02-20', // Washington's Birthday
  '2023-04-07', // Good Friday
  '2023-05-29', // Memorial Day
  '2023-06-19', // Juneteenth
  '2023-07-04', // Independence Day
  '2023-09-04', // Labor Day
  '2023-11-23', // Thanksgiving
  '2023-12-25', // Christmas
  // 2024
  '2024-01-01', // New Year's Day
  '2024-01-15', // MLK Day
  '2024-02-19', // Washington's Birthday
  '2024-03-29', // Good Friday
  '2024-05-27', // Memorial Day
  '2024-06-19', // Juneteenth
  '2024-07-04', // Independence Day
  '2024-09-02', // Labor Day
  '2024-11-28', // Thanksgiving
  '2024-12-25', // Christmas
  // 2025
  '2025-01-01', // New Year's Day
  '2025-01-09', // Day of mourning — President Carter
  '2025-01-20', // MLK Day
  '2025-02-17', // Washington's Birthday
  '2025-04-18', // Good Friday
  '2025-05-26', // Memorial Day
  '2025-06-19', // Juneteenth
  '2025-07-04', // Independence Day
  '2025-09-01', // Labor Day
  '2025-11-27', // Thanksgiving
  '2025-12-25', // Christmas
  // 2026
  '2026-01-01', // New Year's Day
  '2026-01-19', // MLK Day
  '2026-02-16', // Washington's Birthday
  '2026-04-03', // Good Friday
  '2026-05-25', // Memorial Day
  '2026-06-19', // Juneteenth
  '2026-07-03', // Independence Day (observed; July 4 is Saturday)
  '2026-09-07', // Labor Day
  '2026-11-26', // Thanksgiving
  '2026-12-25', // Christmas
]);

function isoDateUtc(date) {
  return date.toISOString().slice(0, 10);
}

function addDaysUtc(date, n) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + n);
  return next;
}

// Enumerates inclusive trading days in [startIso, endIso], skipping
// weekends and NYSE_HOLIDAYS. Dates are interpreted as UTC midnights;
// the NYSE day boundary lives in Eastern time but the ISO-to-ISO
// mapping is stable because we only use the date component.
export function tradingDaysBetween(startIso, endIso) {
  const start = new Date(`${startIso}T00:00:00Z`);
  const end = new Date(`${endIso}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error(`invalid date bounds: ${startIso} .. ${endIso}`);
  }
  const days = [];
  for (let cursor = start; cursor.getTime() <= end.getTime(); cursor = addDaysUtc(cursor, 1)) {
    const dow = cursor.getUTCDay(); // 0 Sun .. 6 Sat
    if (dow === 0 || dow === 6) continue;
    const iso = isoDateUtc(cursor);
    if (NYSE_HOLIDAYS.has(iso)) continue;
    days.push(iso);
  }
  return days;
}
