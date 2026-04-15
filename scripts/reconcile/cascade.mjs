// ============================================================================
// CRITICAL: CASCADE vs FROZEN-BANDS ASYMMETRY
// ============================================================================
// This module cascades directional-flag corrections forward through already-
// reconciled days. Percentile bands (see bands.mjs) DO NOT cascade. A future
// reader will see two apparently contradictory rules and be tempted to "fix"
// one to match the other. DO NOT. The asymmetry is deliberate.
//
// Directional flags CASCADE because they are state-transition accounting in
// the values themselves. A flag of "up" on day E asserts "E's level exceeded
// D's level." If D's level gets corrected, the assertion must be re-checked
// against the corrected baseline. Correctness of the historical record
// requires propagation.
//
// Percentile bands DO NOT CASCADE because they are point-in-time distributional
// snapshots — "what was known about the 1-year percentile rank at the moment
// of this day's close." Recomputing them retroactively would rewrite history
// every time a correction landed. The as-of semantics are the point.
// Tomorrow's bands use tomorrow's lookback window.
//
// The two rules are consistent in INTENT despite looking contradictory at
// first read. Directional flags track the values; bands preserve the frame.
// ============================================================================

import { buildCascadeFlipEvent } from './audit.mjs';

export const DIRECTION = Object.freeze({
  UP: 'up',
  FLAT: 'flat',
  DOWN: 'down',
});

export const LEVEL_KEYS = Object.freeze([
  'put_wall_strike',
  'call_wall_strike',
  'vol_flip_strike',
]);

export const DIRECTION_KEYS = Object.freeze([
  'put_wall_direction',
  'call_wall_direction',
  'vol_flip_direction',
]);

export function computeDirection(current, prior) {
  if (current == null || prior == null) return null;
  if (current > prior) return DIRECTION.UP;
  if (current < prior) return DIRECTION.DOWN;
  return DIRECTION.FLAT;
}

export function computeLevelDirections(dayLevels, priorLevels) {
  if (!priorLevels) {
    return {
      put_wall_direction: null,
      call_wall_direction: null,
      vol_flip_direction: null,
    };
  }
  return {
    put_wall_direction: computeDirection(dayLevels.put_wall_strike, priorLevels.put_wall_strike),
    call_wall_direction: computeDirection(dayLevels.call_wall_strike, priorLevels.call_wall_strike),
    vol_flip_direction: computeDirection(dayLevels.vol_flip_strike, priorLevels.vol_flip_strike),
  };
}

export function computeCoordination(directions) {
  const values = [
    directions.put_wall_direction,
    directions.call_wall_direction,
    directions.vol_flip_direction,
  ];
  // Any null OR any flat breaks coordination. All three must have
  // moved in the same direction (no minimum magnitude threshold).
  if (values.some((d) => d == null || d === DIRECTION.FLAT)) {
    return { coordinated_move: false, coordinated_direction: null };
  }
  const first = values[0];
  if (values.every((d) => d === first)) {
    return { coordinated_move: true, coordinated_direction: first };
  }
  return { coordinated_move: false, coordinated_direction: null };
}

// Walk forward from originDate, recomputing directions against the updated
// baseline. Returns a list of per-day updates to stage inside the reconciliation
// transaction. BANDS ARE NOT TOUCHED — see the asymmetry comment at the top of
// this file for why.
export async function computeCascadeUpdates({ db, originDate, originNewLevels }) {
  const subsequent = await db.getReconciledDaysAfter(originDate);
  if (subsequent.length === 0) return [];

  const updates = [];
  let priorLevels = originNewLevels;

  for (const dayRow of subsequent) {
    const dayLevels = {
      put_wall_strike: dayRow.put_wall_strike,
      call_wall_strike: dayRow.call_wall_strike,
      vol_flip_strike: dayRow.vol_flip_strike,
    };
    const newDirections = computeLevelDirections(dayLevels, priorLevels);
    const newCoordination = computeCoordination(newDirections);

    const oldDirections = {
      put_wall_direction: dayRow.put_wall_direction,
      call_wall_direction: dayRow.call_wall_direction,
      vol_flip_direction: dayRow.vol_flip_direction,
    };

    const events = [];
    for (let i = 0; i < LEVEL_KEYS.length; i++) {
      const levelKey = LEVEL_KEYS[i];
      const dirKey = DIRECTION_KEYS[i];
      if (oldDirections[dirKey] !== newDirections[dirKey]) {
        events.push(buildCascadeFlipEvent({
          tradingDate: dayRow.trading_date,
          featureKey: levelKey,
          oldDirection: oldDirections[dirKey],
          newDirection: newDirections[dirKey],
        }));
      }
    }

    const directionsChanged =
      oldDirections.put_wall_direction !== newDirections.put_wall_direction ||
      oldDirections.call_wall_direction !== newDirections.call_wall_direction ||
      oldDirections.vol_flip_direction !== newDirections.vol_flip_direction;

    if (directionsChanged || events.length > 0) {
      updates.push({
        trading_date: dayRow.trading_date,
        directions: newDirections,
        coordination: newCoordination,
        events,
      });
    }

    // Next iteration's baseline is this day's UNCHANGED levels. Cascade
    // corrects direction flags, not level values, so once we're past the
    // origin day each subsequent day's baseline is whatever it always was.
    // This means meaningful flips almost always happen only on the
    // immediately-subsequent day; the walk still visits the rest to verify.
    priorLevels = dayLevels;
  }

  return updates;
}
