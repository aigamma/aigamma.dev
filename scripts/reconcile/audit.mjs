// Audit event builders. Plain objects, no I/O. Every correction or
// flagged condition produced by the reconciliation job becomes one
// row in reconciliation_audit.

export const EVENT_TYPES = Object.freeze({
  OVERWRITE: 'overwrite',
  GAP_BACKFILL: 'gap_backfill',
  MISSING_THETA_FLAG: 'missing_theta_flag',
  DIRECTION_FLIP: 'direction_flip',
  CASCADE_FLIP: 'cascade_flip',
});

export const FEATURE_TYPES = Object.freeze({
  LEVEL: 'level',
  ATM_IV: 'atm_iv',
});

export function buildOverwriteEvent({
  tradingDate,
  featureType,
  featureKey,
  massiveValue,
  thetaValue,
  deltaPct,
  notes = null,
}) {
  return {
    trading_date: tradingDate,
    feature_type: featureType,
    feature_key: String(featureKey),
    massive_value: massiveValue,
    theta_value: thetaValue,
    delta_pct: deltaPct,
    event_type: EVENT_TYPES.OVERWRITE,
    notes,
  };
}

export function buildGapBackfillEvent({ tradingDate, featureKey, thetaValue, notes = null }) {
  return {
    trading_date: tradingDate,
    feature_type: FEATURE_TYPES.ATM_IV,
    feature_key: String(featureKey),
    massive_value: null,
    theta_value: thetaValue,
    delta_pct: null,
    event_type: EVENT_TYPES.GAP_BACKFILL,
    notes,
  };
}

export function buildMissingThetaEvent({ tradingDate, featureKey, massiveValue, notes = null }) {
  return {
    trading_date: tradingDate,
    feature_type: FEATURE_TYPES.ATM_IV,
    feature_key: String(featureKey),
    massive_value: massiveValue,
    theta_value: null,
    delta_pct: null,
    event_type: EVENT_TYPES.MISSING_THETA_FLAG,
    notes,
  };
}

export function buildDirectionFlipEvent({
  tradingDate,
  featureKey,
  massiveValue,
  thetaValue,
  notes = null,
}) {
  return {
    trading_date: tradingDate,
    feature_type: FEATURE_TYPES.LEVEL,
    feature_key: String(featureKey),
    massive_value: massiveValue,
    theta_value: thetaValue,
    delta_pct: null,
    event_type: EVENT_TYPES.DIRECTION_FLIP,
    notes,
  };
}

export function buildCascadeFlipEvent({ tradingDate, featureKey, oldDirection, newDirection, notes = null }) {
  return {
    trading_date: tradingDate,
    feature_type: FEATURE_TYPES.LEVEL,
    feature_key: String(featureKey),
    massive_value: oldDirection,
    theta_value: newDirection,
    delta_pct: null,
    event_type: EVENT_TYPES.CASCADE_FLIP,
    notes: notes ?? `flipped ${oldDirection} → ${newDirection}`,
  };
}
