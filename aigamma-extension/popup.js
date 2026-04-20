const ENDPOINT = 'https://aigamma.com/api/snapshot.json';

const fmt = (n, d = 2) =>
  n == null || Number.isNaN(Number(n))
    ? '-'
    : Number(n).toLocaleString('en-US', {
        minimumFractionDigits: d,
        maximumFractionDigits: d,
      });

const signed = (n, d = 2) =>
  n == null || Number.isNaN(Number(n))
    ? '-'
    : (Number(n) > 0 ? '+' : '') + Number(n).toFixed(d);

const pct = (n) =>
  n == null || Number.isNaN(Number(n))
    ? '-'
    : (Number(n) > 0 ? '+' : '') + Number(n).toFixed(2) + '%';

const set = (id, text) => {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
};

const DIR_KEYS = ['put_wall', 'volatility_flip', 'call_wall'];

// Renders the overnight alignment score and the three per-level direction
// arrows into #overnightScore and #overnightDirs respectively. Uses DOM
// methods rather than innerHTML to stay MV3-CSP-clean. Handles null
// payloads (first market day in the database, or every prior run's
// snapshot insert failed) by showing a dash and three neutral dots.
const renderOvernight = (oa) => {
  const scoreEl = document.getElementById('overnightScore');
  const dirsEl = document.getElementById('overnightDirs');
  if (!scoreEl || !dirsEl) return;
  while (dirsEl.firstChild) dirsEl.removeChild(dirsEl.firstChild);
  if (!oa || typeof oa.score !== 'number') {
    scoreEl.textContent = '-';
    for (let i = 0; i < 3; i++) {
      const s = document.createElement('span');
      s.className = 'dir muted';
      s.textContent = '·';
      dirsEl.appendChild(s);
    }
    return;
  }
  scoreEl.textContent = (oa.score > 0 ? '+' : '') + oa.score;
  for (const key of DIR_KEYS) {
    const d = oa.dirs && oa.dirs[key];
    const s = document.createElement('span');
    if (!d) {
      s.className = 'dir muted';
      s.textContent = '·';
    } else if (d.sign > 0) {
      s.className = 'dir up';
      s.textContent = '↑';
    } else if (d.sign < 0) {
      s.className = 'dir dn';
      s.textContent = '↓';
    } else {
      s.className = 'dir muted';
      s.textContent = '=';
    }
    dirsEl.appendChild(s);
  }
};

async function load() {
  const status = document.getElementById('status');
  try {
    const res = await fetch(ENDPOINT, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();

    const gs = d.gammaStatus || '-';
    status.textContent = gs;
    status.className = 'status ' + (gs === 'POSITIVE' ? 'pos' : gs === 'NEGATIVE' ? 'neg' : '');

    set('spot', fmt(d.spot));
    set('putWall', fmt(d.putWall));
    set('volFlip', fmt(d.volFlip));
    set('callWall', fmt(d.callWall));
    set('distRiskOff', signed(d.distanceFromRiskOff));
    set('atmIv', d.atmIv == null ? '-' : fmt(d.atmIv, 2) + '%');
    set('vrp', pct(d.vrp));
    set('ivRank', d.ivRank == null ? '-' : fmt(d.ivRank, 1) + '%');
    set('pcVol', fmt(d.pcRatioVolume));
    renderOvernight(d.overnightAlignment);

    if (d.asOf) {
      const ts = new Date(d.asOf);
      set(
        'asOf',
        'As of ' +
          ts.toLocaleTimeString('en-US', {
            hour: 'numeric',
            minute: '2-digit',
            timeZoneName: 'short',
          })
      );
    } else {
      set('asOf', '');
    }
  } catch {
    status.textContent = 'OFFLINE';
    status.className = 'status neg';
    // Wipe the loading placeholders so the popup doesn't keep showing "..."
    // on every row forever when the endpoint is unreachable.
    ['spot', 'putWall', 'volFlip', 'callWall', 'distRiskOff',
     'atmIv', 'vrp', 'ivRank', 'pcVol'].forEach((id) => set(id, '-'));
    renderOvernight(null);
    set('asOf', 'Failed to load');
  }
}

document.addEventListener('DOMContentLoaded', load);
