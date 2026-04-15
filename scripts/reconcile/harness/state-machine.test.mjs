import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb, seedDay } from './fake-db.mjs';
import { createFakeTheta, derivedEod } from './fake-theta.mjs';
import { runReconciliation } from '../state-machine.mjs';

function makeLogger() {
  const events = [];
  return {
    events,
    info: (event, data = {}) => events.push({ level: 'info', event, ...data }),
    warn: (event, data = {}) => events.push({ level: 'warn', event, ...data }),
    error: (event, data = {}) => events.push({ level: 'error', event, ...data }),
  };
}

function makeCtx({ db, theta, logger, today = '2026-04-14' }) {
  return {
    db,
    theta,
    logger,
    clock: { todayEastern: () => today },
    config: {},
  };
}

describe('reconciliation state machine', () => {
  it('rolls back the entire day on commit failure, leaving reconciled=false', async () => {
    const db = createFakeDb();
    seedDay(db._state, {
      trading_date: '2026-04-13',
      put_wall_strike: 5020,
      call_wall_strike: 5110,
      vol_flip_strike: 5055,
    });

    const theta = createFakeTheta();
    theta._setEodResponse('2026-04-13', derivedEod({
      levels: { put_wall_strike: 5250, call_wall_strike: 5280, vol_flip_strike: 5180 },
    }));

    db._setNextRpcFailure(new Error('simulated crash'));

    const logger = makeLogger();
    const summary = await runReconciliation(makeCtx({ db, theta, logger }));

    assert.equal(summary.reconciled, 0, 'nothing reconciled');
    assert.equal(summary.deferred, 1, 'day counted as deferred');
    const row = db._state.daily_levels.get('2026-04-13');
    assert.equal(row.reconciled, false, 'reconciled flag must not flip on failure');
    assert.equal(row.put_wall_strike, 5020, 'levels must not change on rollback');
    assert.equal(row.call_wall_strike, 5110);
    assert.equal(row.vol_flip_strike, 5055);
    assert.equal(db._state.reconciliation_audit.length, 0, 'audit must not persist on rollback');
    assert.equal(db._state.daily_cloud_bands.size, 0, 'bands must not persist on rollback');
  });

  it('is a no-op when there are no unreconciled days', async () => {
    const db = createFakeDb();
    seedDay(db._state, {
      trading_date: '2026-04-13',
      put_wall_strike: 5020,
      call_wall_strike: 5110,
      vol_flip_strike: 5055,
      reconciled: true,
    });

    const theta = createFakeTheta();
    const logger = makeLogger();
    const summary = await runReconciliation(makeCtx({ db, theta, logger }));

    assert.equal(summary.attempted, 0);
    assert.equal(summary.reconciled, 0);
    const rpcCalls = db._calls.filter((c) => c.method === 'reconcileDayAtomic');
    assert.equal(rpcCalls.length, 0, 'no RPC should fire for a fully reconciled dataset');
    assert(logger.events.some((e) => e.event === 'reconcile.no_work'));
  });

  it('cascades direction flips forward across already-reconciled days when a baseline is corrected', async () => {
    const db = createFakeDb();
    // D-1 reconciled. Baseline for D's directions.
    seedDay(db._state, {
      trading_date: '2026-04-10',
      put_wall_strike: 5000,
      call_wall_strike: 5100,
      vol_flip_strike: 5050,
      reconciled: true,
    });
    // D: the target of this run, unreconciled Massive values.
    seedDay(db._state, {
      trading_date: '2026-04-11',
      put_wall_strike: 5020,
      call_wall_strike: 5110,
      vol_flip_strike: 5055,
    });
    // D+1: reconciled against the UNCORRECTED D baseline → directions 'up'.
    seedDay(db._state, {
      trading_date: '2026-04-12',
      put_wall_strike: 5040,
      call_wall_strike: 5130,
      vol_flip_strike: 5070,
      put_wall_direction: 'up',
      call_wall_direction: 'up',
      vol_flip_direction: 'up',
      coordinated_move: true,
      coordinated_direction: 'up',
      reconciled: true,
    });
    // D+2: reconciled against D+1; its baseline does NOT change during cascade.
    seedDay(db._state, {
      trading_date: '2026-04-13',
      put_wall_strike: 5060,
      call_wall_strike: 5150,
      vol_flip_strike: 5090,
      put_wall_direction: 'up',
      call_wall_direction: 'up',
      vol_flip_direction: 'up',
      coordinated_move: true,
      coordinated_direction: 'up',
      reconciled: true,
    });

    const theta = createFakeTheta();
    // Theta says D's real levels are MUCH higher than Massive captured.
    // All three deltas exceed 2%, triggering overwrite on every level.
    // After overwrite D = [5250, 5280, 5180], which is higher than D+1's
    // [5040, 5130, 5070]. Cascade re-checks D+1's directions against the
    // new D baseline — all three flip from 'up' to 'down'.
    theta._setEodResponse('2026-04-11', derivedEod({
      levels: { put_wall_strike: 5250, call_wall_strike: 5280, vol_flip_strike: 5180 },
    }));

    const logger = makeLogger();
    const summary = await runReconciliation(makeCtx({ db, theta, logger }));

    assert.equal(summary.reconciled, 1);

    const d = db._state.daily_levels.get('2026-04-11');
    assert.equal(d.reconciled, true);
    assert.equal(d.put_wall_strike, 5250);
    assert.equal(d.call_wall_strike, 5280);
    assert.equal(d.vol_flip_strike, 5180);

    const dPlus1 = db._state.daily_levels.get('2026-04-12');
    assert.equal(dPlus1.put_wall_direction, 'down', 'D+1 PW direction flips after D baseline correction');
    assert.equal(dPlus1.call_wall_direction, 'down');
    assert.equal(dPlus1.vol_flip_direction, 'down');
    assert.equal(dPlus1.coordinated_move, true);
    assert.equal(dPlus1.coordinated_direction, 'down');

    const dPlus2 = db._state.daily_levels.get('2026-04-13');
    // D+2's baseline is D+1's unchanged levels. Its directions stay 'up'.
    assert.equal(dPlus2.put_wall_direction, 'up', 'D+2 unaffected — its baseline (D+1 values) did not change');
    assert.equal(dPlus2.call_wall_direction, 'up');
    assert.equal(dPlus2.vol_flip_direction, 'up');

    const cascadeEvents = db._state.reconciliation_audit.filter((e) => e.event_type === 'cascade_flip');
    assert.equal(cascadeEvents.length, 3, 'one cascade_flip per level on D+1');
    const cascadeDates = new Set(cascadeEvents.map((e) => e.trading_date));
    assert.deepEqual([...cascadeDates], ['2026-04-12'], 'cascade only touched D+1');
  });

  it('exits cleanly when the terminal is unreachable, with zero state changes', async () => {
    const db = createFakeDb();
    seedDay(db._state, {
      trading_date: '2026-04-13',
      put_wall_strike: 5020,
      call_wall_strike: 5110,
      vol_flip_strike: 5055,
    });
    const preSnap = db._snapshot();

    const theta = createFakeTheta();
    theta._setTerminalUp(false);

    const logger = makeLogger();
    const summary = await runReconciliation(makeCtx({ db, theta, logger }));

    assert.equal(summary.skipped, 1);
    assert.equal(summary.reconciled, 0);
    assert.equal(summary.deferred, 0);
    const rpcCalls = db._calls.filter((c) => c.method === 'reconcileDayAtomic');
    assert.equal(rpcCalls.length, 0, 'no RPC should fire when terminal is down');
    assert(logger.events.some((e) => e.event === 'reconcile.terminal_unavailable'));

    const postRow = db._state.daily_levels.get('2026-04-13');
    const preRow = preSnap.daily_levels.get('2026-04-13');
    assert.deepEqual(postRow, preRow, 'day row untouched');
    assert.equal(db._state.reconciliation_audit.length, 0);
    assert.equal(db._state.daily_cloud_bands.size, 0);
  });
});
