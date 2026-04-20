// netlify/functions/snapshot.mjs
// Chrome-extension-facing endpoint. Returns a scalar snapshot of SPX regime
// status, key dealer-positioning levels, and front-month volatility metrics
// for the AI Gamma browser extension (see aigamma-extension/). Contract is
// fixed against popup.js — do not change field names or types without also
// updating the extension client.
//
// Shape (schemaVersion: 1):
//   asOf                ISO 8601 timestamp of the ingest run (UTC, Z-suffix)
//   gammaStatus         "POSITIVE" | "NEGATIVE" depending on spot vs volFlip
//   spot                SPX cash price at the ingest capture instant
//   putWall             strike of largest put-gamma concentration
//   volFlip             gamma zero-crossing (price, not $GEX)
//   callWall            strike of largest call-gamma concentration
//   distanceFromRiskOff spot − volFlip (signed, matches dashboard sign)
//   expectedMove        spot × atmIv/100 × sqrt(dte/365) for 30-DTE monthly
//   atmIv               30-DTE monthly ATM IV in percent (not fraction)
//   vrp                 IV − RV in percent from daily_volatility_stats (EOD)
//   ivRank              trailing 252-trading-day IV rank in percent
//   pcRatioVolume       today's put/call volume ratio
//   overnightAlignment  { score, dirs: { put_wall, volatility_flip, call_wall } }
//                       today vs. the most recent run on a prior trading date:
//                       each level contributes +1 if it rose, −1 if it fell,
//                       0 if flat; score sums to a net in [−3, +3]. dirs[key]
//                       is null when either side is missing. null at the top
//                       level when no prior trading-date run can be resolved.
//
// Sourcing rationale:
//   — spot / walls / P-C ratio: latest intraday `ingest_runs` + `computed_levels`
//   — atmIv / expectedMove: `expiration_metrics` row for the 30-DTE monthly
//     selected by `pickDefaultExpiration` (same helper the dashboard uses)
//   — volFlip: recomputed client-side-style via `computeGammaProfile` +
//     `findFlipFromProfile` over the run's `snapshots` rows. The stored
//     `computed_levels.volatility_flip` column is stale because the deployed
//     ingest can't persist the new profile (missing service-role key leaves
//     the INSERT blocked by RLS — see src/App.jsx:224-242). Replicating the
//     recompute here keeps the extension in agreement with the dashboard's
//     on-screen volFlip. Tracking the ingest bug as a follow-up ticket;
//     until it's fixed, any downstream consumer of `computed_levels` is
//     reading a number the dashboard itself overrides.
//   — vrp / ivRank: latest + rolling 252 of `daily_volatility_stats`. These
//     are EOD values that lag intraday spot by up to one trading day, which
//     matches the dashboard's LevelsPanel behavior and is explicit in the
//     extension's popup (no freshness annotation on the vol-stats side).
//
// Cache policy: `public, max-age=30, s-maxage=30`. The intraday ingest runs
// every 5 minutes during market hours; 30-second edge caching keeps popup
// latency under ~200ms without ever serving numbers that are more than 30
// seconds stale behind the data-layer snapshot.

import { computeGammaProfile, findFlipFromProfile } from '../../src/lib/gammaProfile.js';
import {
  daysToExpiration,
  filterPickerExpirations,
  pickDefaultExpiration,
} from '../../src/lib/dates.js';

const SUPABASE_TIMEOUT_MS = 8000;
const PAGE_SIZE = 1000;
const IV_RANK_WINDOW = 252;

const RESPONSE_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'public, max-age=30, s-maxage=30',
  'Access-Control-Allow-Origin': '*',
};

const ERROR_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
};

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

function round(n, d) {
  if (n == null || !Number.isFinite(n)) return null;
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: ERROR_HEADERS,
  });
}

export default async function handler() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return jsonError(500, 'Supabase not configured');
  }

  const headers = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json',
  };

  try {
    // Most recent intraday ingest run for SPX that actually has snapshot
    // rows. Same probe pattern as data.mjs: the run header is written
    // before the 15-batch snapshot insert, so a run can report a non-zero
    // contract_count while the inserts failed (RLS, storage limits,
    // timeout). Probe each candidate with a 1-row SELECT until we find
    // one with real data, then commit.
    const runParams = new URLSearchParams({
      underlying: 'eq.SPX',
      snapshot_type: 'eq.intraday',
      order: 'captured_at.desc',
      limit: '10',
    });
    const runRes = await fetchWithTimeout(
      `${supabaseUrl}/rest/v1/ingest_runs?${runParams}`,
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
        `${supabaseUrl}/rest/v1/snapshots?run_id=eq.${candidate.id}&select=id&limit=1`,
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
    const capturedAt = run.captured_at;

    const snapParams = new URLSearchParams({
      run_id: `eq.${run.id}`,
      select:
        'expiration_date,strike,contract_type,implied_volatility,open_interest',
      order: 'expiration_date.asc,strike.asc',
    });

    // Prev-day run resolver: fired in parallel with today's queries so the
    // overnight-alignment probe cost overlaps with today's snapshot paging
    // instead of serializing behind it. Same probe pattern as above — walk
    // up to 10 ingest_runs on prior trading dates and commit to the first
    // one that has non-empty snapshots. Resolves to null if no prior run
    // is available (first market day in the database, or every prior run
    // had a failed insert); the alignment field is then omitted from the
    // payload.
    const prevRunPromise = run.trading_date
      ? (async () => {
          const params = new URLSearchParams({
            underlying: 'eq.SPX',
            snapshot_type: 'eq.intraday',
            trading_date: `lt.${run.trading_date}`,
            order: 'captured_at.desc',
            limit: '10',
          });
          const res = await fetchWithTimeout(
            `${supabaseUrl}/rest/v1/ingest_runs?${params}`,
            { headers },
            'prev_ingest_runs'
          );
          if (!res.ok) return null;
          const rows = await res.json();
          if (!Array.isArray(rows) || rows.length === 0) return null;
          const cands = rows.filter((r) => r.status === 'success');
          if (cands.length === 0) cands.push(rows[0]);
          for (const c of cands) {
            const probe = await fetchWithTimeout(
              `${supabaseUrl}/rest/v1/snapshots?run_id=eq.${c.id}&select=id&limit=1`,
              { headers },
              'prev_snapshot_probe'
            );
            if (probe.ok) {
              const probeRows = await probe.json();
              if (Array.isArray(probeRows) && probeRows.length > 0) return c;
            }
          }
          return null;
        })()
      : Promise.resolve(null);

    const [levelsRes, expMetricsRes, volStatsRes] = await Promise.all([
      fetchWithTimeout(
        `${supabaseUrl}/rest/v1/computed_levels?run_id=eq.${run.id}`,
        { headers },
        'computed_levels'
      ),
      fetchWithTimeout(
        `${supabaseUrl}/rest/v1/expiration_metrics?run_id=eq.${run.id}&order=expiration_date.asc`,
        { headers },
        'expiration_metrics'
      ),
      fetchWithTimeout(
        `${supabaseUrl}/rest/v1/daily_volatility_stats?select=trading_date,iv_30d_cm,hv_20d_yz&order=trading_date.desc&limit=${IV_RANK_WINDOW}`,
        { headers },
        'daily_volatility_stats'
      ),
    ]);

    if (!levelsRes.ok) throw new Error(`computed_levels query failed: ${levelsRes.status}`);
    if (!expMetricsRes.ok) throw new Error(`expiration_metrics query failed: ${expMetricsRes.status}`);
    if (!volStatsRes.ok) throw new Error(`daily_volatility_stats query failed: ${volStatsRes.status}`);

    // Page through snapshots via Range header. PostgREST caps single
    // responses at 1000 rows by default, and a full SPX chain runs 9k+
    // contracts — unpaginated would silently truncate to the lowest-strike
    // tail of the earliest expirations and collapse the gamma profile.
    const contractRows = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const end = offset + PAGE_SIZE - 1;
      const pageRes = await fetchWithTimeout(
        `${supabaseUrl}/rest/v1/snapshots?${snapParams}`,
        { headers: { ...headers, Range: `${offset}-${end}`, 'Range-Unit': 'items' } },
        'snapshots'
      );
      if (!pageRes.ok && pageRes.status !== 206) {
        throw new Error(`snapshots query failed: ${pageRes.status}`);
      }
      const page = await pageRes.json();
      if (!Array.isArray(page) || page.length === 0) break;
      contractRows.push(...page);
      if (page.length < PAGE_SIZE) break;
    }

    const [levelsRows, expMetricsRows, volStatsRows] = await Promise.all([
      levelsRes.json(),
      expMetricsRes.json(),
      volStatsRes.json(),
    ]);

    const levelsRow = Array.isArray(levelsRows) && levelsRows.length > 0 ? levelsRows[0] : null;
    const putWall = levelsRow ? toNum(levelsRow.put_wall_strike) : null;
    const callWall = levelsRow ? toNum(levelsRow.call_wall_strike) : null;
    const pcRatioVolume = levelsRow ? toNum(levelsRow.put_call_ratio_volume) : null;

    // volFlip recompute via the gamma-profile zero crossing over the run's
    // contracts. `computeGammaProfile` expects `strike_price` (client shape)
    // or `strike` (backend shape) and handles both; we pass the raw backend
    // field name and let strikeOf() inside the helper pick it up.
    const contractsForProfile = contractRows.map((c) => ({
      expiration_date: c.expiration_date,
      strike: toNum(c.strike),
      contract_type: c.contract_type,
      implied_volatility: toNum(c.implied_volatility),
      open_interest: c.open_interest,
    }));

    let volFlip = null;
    if (spot != null && contractsForProfile.length > 0) {
      const profile = computeGammaProfile(contractsForProfile, spot, capturedAt);
      if (profile && profile.length > 0) {
        const flip = findFlipFromProfile(profile);
        if (Number.isFinite(flip)) volFlip = flip;
      }
    }
    // Fall back to the stored column only if the recompute produced nothing
    // (no zero crossing in the profile). Shouldn't happen on a live SPX
    // chain but guards against partially-ingested runs.
    if (volFlip == null && levelsRow) {
      volFlip = toNum(levelsRow.volatility_flip);
    }

    // 30-DTE monthly selection (same logic as the dashboard's LevelsPanel).
    const allExpirations = [
      ...new Set(contractRows.map((c) => c.expiration_date).filter(Boolean)),
    ].sort();
    const pickerExpirations = filterPickerExpirations(allExpirations, capturedAt);
    const defaultExp = pickDefaultExpiration(pickerExpirations, capturedAt);

    let atmIv = null;
    let expectedMove = null;
    if (defaultExp) {
      const match = expMetricsRows.find((m) => m.expiration_date === defaultExp);
      const atmIvFrac = match ? toNum(match.atm_iv) : null;
      if (atmIvFrac != null) {
        atmIv = atmIvFrac * 100;
        const dte = daysToExpiration(defaultExp, capturedAt);
        if (spot != null && dte != null && dte > 0) {
          expectedMove = spot * atmIvFrac * Math.sqrt(dte / 365);
        }
      }
    }

    // VRP + IV Rank over the rolling 252-day IV window from
    // daily_volatility_stats (EOD). Rows come back DESC, so index 0 is the
    // most recent backfill observation.
    let vrp = null;
    let ivRank = null;
    if (Array.isArray(volStatsRows) && volStatsRows.length > 0) {
      const latest = volStatsRows.find(
        (r) => toNum(r.iv_30d_cm) != null && toNum(r.hv_20d_yz) != null
      );
      if (latest) {
        vrp = (toNum(latest.iv_30d_cm) - toNum(latest.hv_20d_yz)) * 100;
      }

      const ivValues = volStatsRows
        .map((r) => toNum(r.iv_30d_cm))
        .filter((v) => v != null);
      if (ivValues.length > 1) {
        const currentIv = ivValues[0];
        let lo = ivValues[0];
        let hi = ivValues[0];
        for (let i = 1; i < ivValues.length; i++) {
          if (ivValues[i] < lo) lo = ivValues[i];
          if (ivValues[i] > hi) hi = ivValues[i];
        }
        const range = hi - lo;
        ivRank = range > 0 ? ((currentIv - lo) / range) * 100 : 50;
      }
    }

    // Overnight alignment: resolve the prev-day run (probe already in
    // flight), fetch its computed_levels and snapshots, recompute its
    // volFlip via the same gamma-profile zero crossing used for today, and
    // diff the three regime levels (put_wall, volatility_flip, call_wall)
    // against today's values. Each level contributes +1 / 0 / −1 to the
    // score; dirs[key] = null whenever either side is missing. Mirrors the
    // dashboard's overnightAlignment computation in src/App.jsx so the
    // popup and the on-page header agree on the same three signs.
    const prevRun = await prevRunPromise;
    let overnightAlignment = null;
    if (prevRun) {
      let prevPutWall = null;
      let prevCallWall = null;
      let prevVolFlip = null;

      const prevLevelsPromise = fetchWithTimeout(
        `${supabaseUrl}/rest/v1/computed_levels?run_id=eq.${prevRun.id}`,
        { headers },
        'prev_computed_levels'
      );

      const prevSnapParams = new URLSearchParams({
        run_id: `eq.${prevRun.id}`,
        select:
          'expiration_date,strike,contract_type,implied_volatility,open_interest',
        order: 'expiration_date.asc,strike.asc',
      });
      const prevContractRows = [];
      for (let offset = 0; ; offset += PAGE_SIZE) {
        const end = offset + PAGE_SIZE - 1;
        const pageRes = await fetchWithTimeout(
          `${supabaseUrl}/rest/v1/snapshots?${prevSnapParams}`,
          { headers: { ...headers, Range: `${offset}-${end}`, 'Range-Unit': 'items' } },
          'prev_snapshots'
        );
        if (!pageRes.ok && pageRes.status !== 206) break;
        const page = await pageRes.json();
        if (!Array.isArray(page) || page.length === 0) break;
        prevContractRows.push(...page);
        if (page.length < PAGE_SIZE) break;
      }

      const prevLevelsRes = await prevLevelsPromise;
      if (prevLevelsRes.ok) {
        const prevLevelsRows = await prevLevelsRes.json();
        const prevLevelsRow =
          Array.isArray(prevLevelsRows) && prevLevelsRows.length > 0 ? prevLevelsRows[0] : null;
        if (prevLevelsRow) {
          prevPutWall = toNum(prevLevelsRow.put_wall_strike);
          prevCallWall = toNum(prevLevelsRow.call_wall_strike);
        }
      }

      const prevSpot = toNum(prevRun.spot_price);
      if (prevSpot != null && prevContractRows.length > 0) {
        const prevContracts = prevContractRows.map((c) => ({
          expiration_date: c.expiration_date,
          strike: toNum(c.strike),
          contract_type: c.contract_type,
          implied_volatility: toNum(c.implied_volatility),
          open_interest: c.open_interest,
        }));
        const prevProfile = computeGammaProfile(prevContracts, prevSpot, prevRun.captured_at);
        if (prevProfile && prevProfile.length > 0) {
          const flip = findFlipFromProfile(prevProfile);
          if (Number.isFinite(flip)) prevVolFlip = flip;
        }
      }

      const diff = (today, prev) => {
        if (today == null || prev == null) return null;
        const delta = today - prev;
        const sign = delta > 0 ? 1 : delta < 0 ? -1 : 0;
        return { delta: round(delta, 2), sign };
      };
      const dirs = {
        put_wall: diff(putWall, prevPutWall),
        volatility_flip: diff(volFlip, prevVolFlip),
        call_wall: diff(callWall, prevCallWall),
      };
      let score = 0;
      let counted = 0;
      for (const key of ['put_wall', 'volatility_flip', 'call_wall']) {
        if (dirs[key]) {
          score += dirs[key].sign;
          counted += 1;
        }
      }
      if (counted > 0) {
        overnightAlignment = { score, counted, dirs };
      }
    }

    // Core-field gate: if any of spot / walls / volFlip / atmIv are
    // missing, the popup renders an empty shell. Prefer an explicit 503 so
    // the extension shows its OFFLINE state rather than a card full of
    // dashes. vrp / ivRank / pcRatioVolume stay optional (null ⇒ popup
    // shows '-').
    if (spot == null || putWall == null || callWall == null || volFlip == null || atmIv == null) {
      return jsonError(503, 'core fields missing');
    }

    const payload = {
      schemaVersion: 1,
      asOf: capturedAt,
      gammaStatus: spot > volFlip ? 'POSITIVE' : 'NEGATIVE',
      spot: round(spot, 2),
      putWall: round(putWall, 2),
      volFlip: round(volFlip, 2),
      callWall: round(callWall, 2),
      distanceFromRiskOff: round(spot - volFlip, 2),
      expectedMove: round(expectedMove, 2),
      atmIv: round(atmIv, 2),
      vrp: round(vrp, 2),
      ivRank: round(ivRank, 1),
      pcRatioVolume: round(pcRatioVolume, 2),
      overnightAlignment,
    };

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: RESPONSE_HEADERS,
    });
  } catch (err) {
    return jsonError(503, err?.message || 'unavailable');
  }
}
