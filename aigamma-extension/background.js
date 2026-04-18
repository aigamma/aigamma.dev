const ENDPOINT = 'https://aigamma.com/api/snapshot.json';
const ALARM_MARKET = 'poll-market';
const FETCH_TIMEOUT_MS = 10000;
const MARKET_PERIOD_MIN = 2;
const POLL_COOLDOWN_MS = 30000;

// currentIconState is null until the first setIconForState call resolves
// within this worker lifetime. Using null instead of 'neutral' as the
// initial value guarantees that the first setIcon call per worker wake
// always issues chrome.action.setIcon(), which synchronizes the displayed
// icon with our variable in the edge case where the worker terminated
// while showing a non-neutral icon and then woke up with fetch returning
// neutral (failure / unknown status) — without this sentinel, the dedup
// guard would short-circuit and leave the stale non-neutral icon on the
// toolbar.
let currentIconState = null;
let lastFetchedAt = 0;

const ICON_PATHS = {
  neutral: { 16: 'icons/neutral/icon16.png', 32: 'icons/neutral/icon32.png' },
  positive: { 16: 'icons/positive/icon16.png', 32: 'icons/positive/icon32.png' },
  negative: { 16: 'icons/negative/icon16.png', 32: 'icons/negative/icon32.png' },
};

// onInstalled and onStartup both fetch unconditionally so a fresh install
// or browser cold start on a weekend displays the most recent known state
// within seconds instead of waiting until the next Monday market open.
chrome.runtime.onInstalled.addListener(() => {
  registerAlarms();
  pollNow();
});

chrome.runtime.onStartup.addListener(() => {
  registerAlarms();
  pollNow();
});

// Single alarm, 2-minute cadence, year-round. Handler fetches only during
// US equity market hours. SPX options market is closed outside those
// hours, dealer positioning is static, and gammaStatus cannot change, so
// polling off-hours would refetch the same number and burn Netlify
// invocations for zero informational gain. Between Friday close and
// Monday open the toolbar displays whatever state was last set, which is
// the correct regime because regime has not moved. The first in-window
// alarm tick after 09:30 ET Monday refreshes the icon.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_MARKET && isMarketHours()) {
    pollNow();
  }
});

function registerAlarms() {
  chrome.alarms.clearAll(() => {
    chrome.alarms.create(ALARM_MARKET, { periodInMinutes: MARKET_PERIOD_MIN });
  });
}

async function pollNow() {
  const now = Date.now();
  if (now - lastFetchedAt < POLL_COOLDOWN_MS) return;
  lastFetchedAt = now;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(ENDPOINT, {
      cache: 'no-store',
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    setIconForState(mapGammaStatus(data && data.gammaStatus));
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.warn('AI Gamma: poll failed, falling back to neutral icon.', msg);
    setIconForState('neutral');
  }
}

function mapGammaStatus(status) {
  if (status === 'POSITIVE') return 'positive';
  if (status === 'NEGATIVE') return 'negative';
  return 'neutral';
}

function setIconForState(state) {
  if (state === currentIconState) return;
  const path = ICON_PATHS[state] || ICON_PATHS.neutral;
  chrome.action.setIcon({ path }, () => {
    if (chrome.runtime.lastError) {
      console.error('AI Gamma: setIcon failed', chrome.runtime.lastError.message);
      return;
    }
    console.debug('AI Gamma: icon', currentIconState, '->', state);
    currentIconState = state;
  });
}

// Mon-Fri 9:30 to 16:00 America/New_York. Intl.DateTimeFormat with an
// IANA zone handles the twice-yearly EST/EDT transition automatically, so
// the market-hours gate stays correct without hard-coded UTC offsets.
// hourCycle h23 forces 00-23 to avoid the en-US midnight-as-24 quirk.
function isMarketHours() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hourCycle: 'h23',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const weekday = get('weekday');
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  const hour = Number(get('hour'));
  const minute = Number(get('minute'));
  const totalMinutes = hour * 60 + minute;
  const openMinutes = 9 * 60 + 30;
  const closeMinutes = 16 * 60;
  return totalMinutes >= openMinutes && totalMinutes < closeMinutes;
}

// First-poll-after-wake: runs on every worker wake (every module load).
// Closes the stale-state window when an MV3 worker terminates mid-market
// hours and wakes later — without this, a regime flip that occurred while
// the worker was asleep would display a stale icon for up to 2 minutes
// until the next alarm tick. Gated by isMarketHours() so off-hours wakes
// (which still fire the 2-min alarm for scheduling simplicity, but
// shouldn't trigger fetches) don't burn Netlify invocations. The 30-second
// lastFetchedAt cooldown inside pollNow() dedups this call against any
// onInstalled / onStartup / onAlarm pollNow that runs in the same wake.
if (isMarketHours()) {
  pollNow();
}
