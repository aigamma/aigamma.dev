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
    set('asOf', 'Failed to load');
  }
}

document.addEventListener('DOMContentLoaded', load);
