import { exceedsTolerance, computeDeltaPct } from './tolerance.mjs';
import {
  FEATURE_TYPES,
  buildOverwriteEvent,
  buildGapBackfillEvent,
  buildMissingThetaEvent,
  buildDirectionFlipEvent,
} from './audit.mjs';
import {
  computeLevelDirections,
  computeCoordination,
  computeCascadeUpdates,
  LEVEL_KEYS,
  DIRECTION_KEYS,
} from './cascade.mjs';
import { buildBandGrid, percentileRank, sampleForDte } from './bands.mjs';

function oneYearBefore(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

// Normalize a ThetaData EOD greeks response into our derived shape.
// The wire format for v3 greeks/eod with exp=* is non-trivial; deriving
// PW/CW/VF levels and per-expiration ATM IVs from a raw chain lives in
// its own module that doesn't exist yet. For now, the client must pass
// a pre-derived shape under response.derived. The harness supplies this
// directly to isolate state-machine semantics from wire-format parsing.
function deriveFromEod(response) {
  if (response?.derived) return response.derived;
  throw new Error('theta-client: wire-format derivation not yet implemented; supply response.derived');
}

export async function runReconciliation(ctx) {
  const { db, theta, logger, clock } = ctx;
  const today = clock.todayEastern();

  // Phase 1 — Discover. The database IS the work queue.
  const pending = await db.findUnreconciledDays(today);
  if (pending.length === 0) {
    logger.info('reconcile.no_work');
    return { attempted: 0, reconciled: 0, deferred: 0, skipped: 0, auditEvents: 0 };
  }

  // Phase 2 — Terminal probe. Opportunistic, never critical path.
  const up = await theta.probe();
  if (!up) {
    logger.warn('reconcile.terminal_unavailable', { pending: pending.length });
    return {
      attempted: pending.length,
      reconciled: 0,
      deferred: 0,
      skipped: pending.length,
      auditEvents: 0,
    };
  }

  // Phase 3 — Per-day processing, oldest first.
  let reconciled = 0;
  let deferred = 0;
  let auditEvents = 0;
  for (const row of pending) {
    const result = await processDay(ctx, row.trading_date);
    if (result.status === 'reconciled') {
      reconciled++;
      auditEvents += result.auditEvents;
    } else {
      deferred++;
    }
  }

  // Phase 4 — Exit.
  const summary = {
    attempted: pending.length,
    reconciled,
    deferred,
    skipped: 0,
    auditEvents,
  };
  logger.info('reconcile.run_summary', summary);
  return summary;
}

async function processDay(ctx, tradingDate) {
  const { db, theta, logger } = ctx;

  const eodResponse = await theta.fetchEodGreeks({ root: 'SPX', date: tradingDate });
  if (!eodResponse || !eodResponse.response || eodResponse.response.length === 0) {
    logger.info('reconcile.theta_eod_not_available', { trading_date: tradingDate });
    return { status: 'deferred' };
  }
  const thetaDerived = deriveFromEod(eodResponse);

  const dayRow = await db.getDay(tradingDate);
  if (!dayRow) {
    logger.warn('reconcile.massive_row_missing', { trading_date: tradingDate });
    return { status: 'deferred' };
  }
  const massiveTs = await db.getTermStructure(tradingDate);

  // 3c — Compare levels with the 2% rule. Stage overwrites.
  const levelEvents = [];
  const newLevels = {
    put_wall_strike: dayRow.put_wall_strike,
    call_wall_strike: dayRow.call_wall_strike,
    vol_flip_strike: dayRow.vol_flip_strike,
  };
  for (const key of LEVEL_KEYS) {
    const massiveVal = dayRow[key];
    const thetaVal = thetaDerived.levels?.[key];
    if (thetaVal == null || massiveVal == null) continue;
    if (exceedsTolerance(massiveVal, thetaVal)) {
      levelEvents.push(buildOverwriteEvent({
        tradingDate,
        featureType: FEATURE_TYPES.LEVEL,
        featureKey: key,
        massiveValue: massiveVal,
        thetaValue: thetaVal,
        deltaPct: computeDeltaPct(massiveVal, thetaVal),
      }));
      newLevels[key] = thetaVal;
    }
  }

  // 3d — Compare term structure rows with the 2% rule. Stage overwrites,
  // gap backfills, missing_theta_flag rows.
  const tsEvents = [];
  const tsUpdates = [];
  const tsInserts = [];
  const massiveByExp = new Map(massiveTs.map((r) => [r.expiration_date, r]));
  const thetaTs = thetaDerived.termStructure ?? [];
  const thetaByExp = new Map(thetaTs.map((r) => [r.expiration_date, r]));

  for (const [exp, thetaRow] of thetaByExp) {
    const massiveRow = massiveByExp.get(exp);
    if (!massiveRow) {
      tsInserts.push({
        trading_date: tradingDate,
        expiration_date: exp,
        dte: thetaRow.dte,
        atm_iv: thetaRow.atm_iv,
        source: 'theta',
      });
      tsEvents.push(buildGapBackfillEvent({
        tradingDate,
        featureKey: exp,
        thetaValue: thetaRow.atm_iv,
      }));
      continue;
    }
    if (exceedsTolerance(massiveRow.atm_iv, thetaRow.atm_iv)) {
      tsUpdates.push({
        trading_date: tradingDate,
        expiration_date: exp,
        atm_iv: thetaRow.atm_iv,
        source: 'theta',
      });
      tsEvents.push(buildOverwriteEvent({
        tradingDate,
        featureType: FEATURE_TYPES.ATM_IV,
        featureKey: exp,
        massiveValue: massiveRow.atm_iv,
        thetaValue: thetaRow.atm_iv,
        deltaPct: computeDeltaPct(massiveRow.atm_iv, thetaRow.atm_iv),
      }));
    }
  }
  for (const [exp, massiveRow] of massiveByExp) {
    if (!thetaByExp.has(exp)) {
      tsEvents.push(buildMissingThetaEvent({
        tradingDate,
        featureKey: exp,
        massiveValue: massiveRow.atm_iv,
      }));
    }
  }

  // 3f — Recompute D's directions against the prior reconciled day.
  // If D-1 is unreconciled, use best-available (null priorLevels → null
  // directions) and let cascade correct it later. Do NOT gate the
  // coordination metric on perfect sequential ordering.
  const priorReconciled = await db.getPriorReconciledDay(tradingDate);
  const priorLevels = priorReconciled
    ? {
        put_wall_strike: priorReconciled.put_wall_strike,
        call_wall_strike: priorReconciled.call_wall_strike,
        vol_flip_strike: priorReconciled.vol_flip_strike,
      }
    : null;
  const newDirections = computeLevelDirections(newLevels, priorLevels);
  const newCoordination = computeCoordination(newDirections);

  const directionEvents = [];
  for (let i = 0; i < LEVEL_KEYS.length; i++) {
    const dirKey = DIRECTION_KEYS[i];
    const levelKey = LEVEL_KEYS[i];
    if (dayRow[dirKey] != null && dayRow[dirKey] !== newDirections[dirKey]) {
      directionEvents.push(buildDirectionFlipEvent({
        tradingDate,
        featureKey: levelKey,
        massiveValue: dayRow[dirKey],
        thetaValue: newDirections[dirKey],
      }));
    }
  }

  // 3h — Bands. NOTE: Bands are FROZEN at write time. They are NOT
  // recomputed when earlier days' observations are corrected
  // downstream. This is the deliberate asymmetry with the direction
  // cascade (step 3i) — see the CRITICAL comment block at the top of
  // cascade.mjs for the full rationale. Do not "fix" one rule to match
  // the other.
  const historicalFrom = oneYearBefore(tradingDate);
  const historical = await db.getHistoricalTermStructure({ from: historicalFrom, to: tradingDate });
  const bandGrid = buildBandGrid(historical);

  // Denormalize percentile_rank onto D's term structure rows so serving
  // is a single-row read from daily_term_structure.
  const denormalized = [];
  for (const tsRow of [...massiveTs, ...tsInserts]) {
    const samples = sampleForDte(tsRow.dte, historical);
    denormalized.push({
      trading_date: tradingDate,
      expiration_date: tsRow.expiration_date,
      percentile_rank: percentileRank(tsRow.atm_iv, samples),
    });
  }

  // 3i — Cascade direction corrections forward through already-
  // reconciled days. Only runs when a level was actually overwritten.
  // This walks every reconciled day after D and re-checks each day's
  // directional flags against the updated baseline. BANDS ARE NOT
  // TOUCHED — the asymmetry is deliberate. See cascade.mjs.
  const cascadeUpdates = levelEvents.length > 0
    ? await computeCascadeUpdates({ db, originDate: tradingDate, originNewLevels: newLevels })
    : [];

  const payload = {
    levels: newLevels,
    directions: newDirections,
    coordination: newCoordination,
    level_events: levelEvents,
    direction_events: directionEvents,
    ts_updates: tsUpdates,
    ts_inserts: tsInserts,
    ts_events: tsEvents,
    ts_percentile_updates: denormalized,
    bands: bandGrid,
    cascade_updates: cascadeUpdates,
  };

  // 3j — Atomic commit. All of 3c–3i lands together, or the entire
  // day rolls back and stays reconciled=false.
  try {
    await db.reconcileDayAtomic(tradingDate, payload);
  } catch (err) {
    logger.error('reconcile.commit_failed', { trading_date: tradingDate, error: String(err) });
    return { status: 'deferred' };
  }

  const auditCount =
    levelEvents.length +
    tsEvents.length +
    directionEvents.length +
    cascadeUpdates.reduce((acc, u) => acc + u.events.length, 0);
  return { status: 'reconciled', auditEvents: auditCount };
}
