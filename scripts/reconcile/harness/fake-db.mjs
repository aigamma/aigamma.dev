// In-memory fake for createSupabaseClient used by state-machine tests.
// Implements the same surface and enforces the all-or-nothing guarantee
// of reconcileDayAtomic via a pre-call snapshot + restore on throw.
// This mirrors the stored procedure contract: any error inside the
// transaction rolls back every mutation, including the reconciled flag.

export function createFakeDb() {
  const state = {
    daily_levels: new Map(),
    daily_term_structure: new Map(), // key = `${date}|${exp}`
    daily_cloud_bands: new Map(),    // key = `${date}|${dte}`
    reconciliation_audit: [],
  };

  const calls = [];
  let nextRpcFailure = null;

  function snapshot() {
    return {
      daily_levels: new Map([...state.daily_levels].map(([k, v]) => [k, { ...v }])),
      daily_term_structure: new Map([...state.daily_term_structure].map(([k, v]) => [k, { ...v }])),
      daily_cloud_bands: new Map([...state.daily_cloud_bands].map(([k, v]) => [k, { ...v }])),
      reconciliation_audit: state.reconciliation_audit.map((r) => ({ ...r })),
    };
  }

  function restore(snap) {
    state.daily_levels = snap.daily_levels;
    state.daily_term_structure = snap.daily_term_structure;
    state.daily_cloud_bands = snap.daily_cloud_bands;
    state.reconciliation_audit = snap.reconciliation_audit;
  }

  async function findUnreconciledDays(throughDate) {
    calls.push({ method: 'findUnreconciledDays', throughDate });
    return [...state.daily_levels.values()]
      .filter((r) => !r.reconciled && r.trading_date <= throughDate)
      .sort((a, b) => a.trading_date.localeCompare(b.trading_date))
      .map((r) => ({ trading_date: r.trading_date }));
  }

  async function getDay(tradingDate) {
    calls.push({ method: 'getDay', tradingDate });
    const row = state.daily_levels.get(tradingDate);
    return row ? { ...row } : null;
  }

  async function getPriorReconciledDay(tradingDate) {
    calls.push({ method: 'getPriorReconciledDay', tradingDate });
    const candidates = [...state.daily_levels.values()]
      .filter((r) => r.reconciled && r.trading_date < tradingDate)
      .sort((a, b) => b.trading_date.localeCompare(a.trading_date));
    return candidates[0] ? { ...candidates[0] } : null;
  }

  async function getReconciledDaysAfter(tradingDate) {
    calls.push({ method: 'getReconciledDaysAfter', tradingDate });
    return [...state.daily_levels.values()]
      .filter((r) => r.reconciled && r.trading_date > tradingDate)
      .sort((a, b) => a.trading_date.localeCompare(b.trading_date))
      .map((r) => ({ ...r }));
  }

  async function getTermStructure(tradingDate) {
    calls.push({ method: 'getTermStructure', tradingDate });
    return [...state.daily_term_structure.values()]
      .filter((r) => r.trading_date === tradingDate)
      .map((r) => ({ ...r }));
  }

  async function getHistoricalTermStructure({ from, to }) {
    calls.push({ method: 'getHistoricalTermStructure', from, to });
    return [...state.daily_term_structure.values()]
      .filter((r) => r.trading_date >= from && r.trading_date < to && r.source === 'theta')
      .map((r) => ({ ...r }));
  }

  async function reconcileDayAtomic(tradingDate, payload) {
    calls.push({ method: 'reconcileDayAtomic', tradingDate, payload });
    const snap = snapshot();
    try {
      if (nextRpcFailure) {
        const err = nextRpcFailure;
        nextRpcFailure = null;
        throw err;
      }

      const day = state.daily_levels.get(tradingDate);
      if (!day) throw new Error(`no daily_levels row for ${tradingDate}`);
      Object.assign(day, payload.levels, payload.directions, payload.coordination, {
        reconciled: true,
        reconciled_at: new Date().toISOString(),
      });

      for (const upd of payload.ts_updates) {
        const key = `${upd.trading_date}|${upd.expiration_date}`;
        const row = state.daily_term_structure.get(key);
        if (row) Object.assign(row, { atm_iv: upd.atm_iv, source: upd.source });
      }
      for (const ins of payload.ts_inserts) {
        const key = `${ins.trading_date}|${ins.expiration_date}`;
        state.daily_term_structure.set(key, { ...ins });
      }
      for (const upd of payload.ts_percentile_updates) {
        const key = `${upd.trading_date}|${upd.expiration_date}`;
        const row = state.daily_term_structure.get(key);
        if (row) row.percentile_rank = upd.percentile_rank;
      }

      for (const b of payload.bands) {
        const key = `${tradingDate}|${b.dte}`;
        state.daily_cloud_bands.set(key, {
          trading_date: tradingDate,
          ...b,
          computed_at: new Date().toISOString(),
        });
      }

      for (const cu of payload.cascade_updates) {
        const other = state.daily_levels.get(cu.trading_date);
        if (other) Object.assign(other, cu.directions, cu.coordination);
      }

      const events = [
        ...payload.level_events,
        ...payload.direction_events,
        ...payload.ts_events,
        ...payload.cascade_updates.flatMap((u) => u.events),
      ];
      for (const e of events) {
        state.reconciliation_audit.push({
          id: state.reconciliation_audit.length + 1,
          created_at: new Date().toISOString(),
          ...e,
        });
      }

      return { ok: true };
    } catch (err) {
      restore(snap);
      throw err;
    }
  }

  return {
    findUnreconciledDays,
    getDay,
    getPriorReconciledDay,
    getReconciledDaysAfter,
    getTermStructure,
    getHistoricalTermStructure,
    reconcileDayAtomic,
    _state: state,
    _calls: calls,
    _setNextRpcFailure: (err) => { nextRpcFailure = err; },
    _snapshot: snapshot,
  };
}

export function seedDay(state, {
  trading_date,
  put_wall_strike,
  call_wall_strike,
  vol_flip_strike,
  put_wall_direction = null,
  call_wall_direction = null,
  vol_flip_direction = null,
  coordinated_move = false,
  coordinated_direction = null,
  reconciled = false,
}) {
  state.daily_levels.set(trading_date, {
    trading_date,
    put_wall_strike,
    call_wall_strike,
    vol_flip_strike,
    put_wall_direction,
    call_wall_direction,
    vol_flip_direction,
    coordinated_move,
    coordinated_direction,
    reconciled,
    reconciled_at: reconciled ? new Date().toISOString() : null,
  });
}
