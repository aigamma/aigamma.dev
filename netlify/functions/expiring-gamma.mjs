// netlify/functions/expiring-gamma.mjs
//
// Read endpoint for the /expiring-gamma surface — a SpotGamma-style
// "expiration concentration" bar chart that aggregates per-expiration
// dollar gamma exposure currently scheduled to roll off.
//
// One bar per listed SPX expiration carried by the most recent intraday
// ingest run. Each bar has two stacked components, both displayed as
// dollar gamma per 1% move at current spot:
//
//   - Call gamma (positive y, orange) — Σ over calls at this expiration
//                                        of γ · OI · 100 · S² · 0.01
//   - Put gamma  (negative y, blue)   — Σ over puts at this expiration
//                                        of γ · OI · 100 · S² · 0.01,
//                                        rendered downward so calls vs
//                                        puts read as a mirrored bar
//                                        chart around the y=0 zero line
//
// "If spot remains where it is" framing: every per-contract γ in the
// snapshot was computed by the ingest at the run's spot price, so
// summing γ · OI · 100 · S² · 0.01 is exactly the dollar gamma
// exposure that would burn off on each expiration date if the index
// stayed flat between now and then. The number is conservative because
// it assumes no further gamma rebalancing or dealer position changes
// — it is a "frozen book" measure, useful for reading which dates
// carry the largest dealer-hedging unwind potential, not a forecast
// of realized hedging flow.
//
// Data source: the latest successful intraday `ingest_runs` row for
// SPX, joined to the per-contract `snapshots` rows. Same probe-by-
// non-empty pattern snapshot.mjs uses, because the run header is
// written before the batched snapshots insert and a run can report
// non-zero contract_count while the inserts failed (RLS, timeout,
// quota). Walk up to 10 candidates until one has rows.
//
// Scope: every expiration the live ingest captures. The current
// ingest pipeline targets the next 9 monthly OPEX dates plus every
// weekly expiration ≤30 calendar days out, so the chart typically
// renders ~15-19 distinct expirations stretching from same-day 0DTE
// through ~9 months out. This is wider than the front-month
// expiration_metrics surface (which only carries the 30-DTE ATM IV)
// and narrower than the SpotGamma reference image (which extends to
// LEAPS 5+ years out — those contracts aren't in the live pipeline).
//
// Cache profile: 60s during market hours, 1h off-hours. The intraday
// ingest cadence is 5min, so 60s is fresh enough that the chart
// effectively tracks the live pipeline; off-hours the snapshot is
// frozen until the next session open and a long TTL avoids re-paging
// snapshots for every visit.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const SUPABASE_TIMEOUT_MS = 8000;
const PAGE_SIZE = 1000;

async function fetchWithTimeout(url, options, label) {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(SUPABASE_TIMEOUT_MS) });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new Error(`${label} timed out after ${SUPABASE_TIMEOUT_MS}ms`);
    }
    throw err;
  }
}

function toNum(value) {
  if (value == null) return null;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function isMarketHoursET() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const wd = get('weekday');
  if (wd === 'Sat' || wd === 'Sun') return false;
  const minutes = Number(get('hour')) * 60 + Number(get('minute'));
  return minutes >= 570 && minutes < 960;
}

function cacheControlHeader() {
  return isMarketHoursET()
    ? 'public, max-age=60, stale-while-revalidate=300'
    : 'public, max-age=3600, stale-while-revalidate=86400';
}

export default async function handler() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return jsonError(500, 'Supabase not configured');
  }

  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    // Probe-and-commit on ingest_runs. The header is written before
    // the batched snapshot inserts, so a run can carry a non-zero
    // contract_count while the inserts failed silently (RLS, timeout,
    // 5xx on the batched insert). Pull the 10 most recent candidates,
    // prefer status=success, and probe each with a 1-row select on
    // snapshots until we find a run that actually has data.
    const runParams = new URLSearchParams({
      underlying: 'eq.SPX',
      snapshot_type: 'eq.intraday',
      order: 'captured_at.desc',
      limit: '10',
      select: 'id,captured_at,trading_date,spot_price,contract_count,status',
    });
    const runRes = await fetchWithTimeout(
      `${SUPABASE_URL}/rest/v1/ingest_runs?${runParams}`,
      { headers },
      'ingest_runs'
    );
    if (!runRes.ok) throw new Error(`ingest_runs query failed: ${runRes.status}`);
    const runRows = await runRes.json();
    if (!Array.isArray(runRows) || runRows.length === 0) {
      return jsonError(503, 'no intraday runs found');
    }

    const candidates = runRows.filter((r) => r.status === 'success');
    if (candidates.length === 0) candidates.push(runRows[0]);

    let run = null;
    for (const candidate of candidates) {
      const probeRes = await fetchWithTimeout(
        `${SUPABASE_URL}/rest/v1/snapshots?run_id=eq.${candidate.id}&select=id&limit=1`,
        { headers },
        'snapshot_probe'
      );
      if (probeRes.ok) {
        const probeRows = await probeRes.json();
        if (Array.isArray(probeRows) && probeRows.length > 0) {
          run = candidate;
          break;
        }
      }
    }
    if (!run) return jsonError(503, 'no run with non-empty snapshots');

    const spot = toNum(run.spot_price);
    if (!(spot > 0)) return jsonError(503, 'run carries no spot price');

    // Page through snapshots with a tight projection. The aggregation
    // only needs (expiration_date, contract_type, gamma,
    // open_interest); skipping the wider columns (strike, IV, delta,
    // theta, vega, volume, close_price, root_symbol) shrinks each
    // row by ~60% and removes a multiple-MB serialization tax on the
    // round-trip.
    const snapParams = new URLSearchParams({
      run_id: `eq.${run.id}`,
      select: 'expiration_date,contract_type,gamma,open_interest',
    });

    const contractRows = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const end = offset + PAGE_SIZE - 1;
      const pageRes = await fetchWithTimeout(
        `${SUPABASE_URL}/rest/v1/snapshots?${snapParams}`,
        { headers: { ...headers, Range: `${offset}-${end}`, 'Range-Unit': 'items' } },
        'snapshots'
      );
      if (!pageRes.ok && pageRes.status !== 206) {
        throw new Error(`snapshots query failed: ${pageRes.status}`);
      }
      const page = await pageRes.json();
      if (!Array.isArray(page) || page.length === 0) break;
      for (const r of page) contractRows.push(r);
      if (page.length < PAGE_SIZE) break;
    }

    if (contractRows.length === 0) {
      return jsonError(503, 'no snapshot rows for run');
    }

    // Per-expiration accumulator. Two slots per expiration: call and
    // put. The dollar-gamma scaling factor (100 * S² * 0.01) is
    // applied once at the end rather than per row to avoid burning
    // floating-point precision on the inner loop.
    const buckets = new Map();
    for (const r of contractRows) {
      const exp = r.expiration_date;
      const t = r.contract_type;
      const g = toNum(r.gamma);
      const oi = toNum(r.open_interest);
      if (!exp || (t !== 'call' && t !== 'put')) continue;
      if (g == null || oi == null || g <= 0 || oi <= 0) continue;
      let bucket = buckets.get(exp);
      if (!bucket) {
        bucket = { callShares: 0, putShares: 0, callCount: 0, putCount: 0 };
        buckets.set(exp, bucket);
      }
      // gamma * OI is the per-share gamma exposure aggregated across
      // contracts. Conversion to $ gamma per 1% move happens after
      // the loop closes, so the inner hot path stays as two adds and
      // a count increment.
      if (t === 'call') {
        bucket.callShares += g * oi;
        bucket.callCount += 1;
      } else {
        bucket.putShares += g * oi;
        bucket.putCount += 1;
      }
    }

    // Apply the GEX scaling factor once. 100 = contract multiplier
    // (each option covers 100 shares), S² · 0.01 = the dollar value
    // of a 1% move (γ has units of Δdelta/$, so γ · ΔS · S = $ value
    // per share at S; ΔS = 0.01 · S gives γ · S² · 0.01).
    const dollarFactor = 100 * spot * spot * 0.01;

    const expirations = [...buckets.keys()].sort().map((exp) => {
      const b = buckets.get(exp);
      return {
        expiration_date: exp,
        callGammaNotional: round(b.callShares * dollarFactor, 0),
        putGammaNotional: round(b.putShares * dollarFactor, 0),
        callContractCount: b.callCount,
        putContractCount: b.putCount,
      };
    });

    const totalCallGamma = expirations.reduce((s, e) => s + (e.callGammaNotional || 0), 0);
    const totalPutGamma = expirations.reduce((s, e) => s + (e.putGammaNotional || 0), 0);

    const payload = {
      asOf: run.captured_at,
      tradingDate: run.trading_date || null,
      spotPrice: spot,
      contractCount: contractRows.length,
      expirationCount: expirations.length,
      totalCallGammaNotional: round(totalCallGamma, 0),
      totalPutGammaNotional: round(totalPutGamma, 0),
      expirations,
    };

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': cacheControlHeader(),
      },
    });
  } catch (err) {
    return jsonError(502, err.message || 'expiring-gamma read failed');
  }
}

function round(n, decimals) {
  if (n == null || !Number.isFinite(n)) return null;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}
