# Reconciliation

Daily EOD data-integrity job that verifies and corrects Massive-collected
derived SPX features against ThetaData as the source of record. Opportunistic:
if ThetaTerminal is unreachable, the job logs and exits cleanly, and the site
continues serving Massive-sourced data at full fidelity. Reconciliation is
deferred, never skipped.

## Layout

| File | Purpose |
| --- | --- |
| `tolerance.mjs` | 2% overwrite threshold, DTE wiggle window. Pure functions. |
| `audit.mjs` | Event-row builders for `reconciliation_audit`. |
| `bands.mjs` | Percentile and uniform 0–280 DTE band grid. Frozen at write time. |
| `cascade.mjs` | Direction recomputation + forward cascade. **Contains the critical asymmetry comment.** |
| `theta-client.mjs` | Thin v3 REST client for ThetaTerminal at `127.0.0.1:25503`. |
| `supabase-client.mjs` | Thin PostgREST wrapper; RPC entry point for the atomic commit. |
| `state-machine.mjs` | Four-phase state machine. Takes `{ db, theta, logger, clock, config }`. |
| `run.mjs` | CLI entry point. Reads env, builds production context, invokes the state machine. |
| `sql/reconcile_day_atomic.sql` | Postgres stored procedure the daily commit calls via RPC. |
| `harness/fake-db.mjs` | In-memory supabase double with all-or-nothing snapshot/restore. |
| `harness/fake-theta.mjs` | In-memory theta double with configurable terminal-up / eod / error. |
| `harness/state-machine.test.mjs` | `node:test` harness: rollback, no-op, cascade, terminal-down. |

## Design contracts

- **Atomic per day.** `daily_levels.reconciled` flips only when the entire
  day commits together. Any error anywhere rolls the whole day back.
- **2% overwrite rule**, universal, levels and per-tenor ATM IV alike.
- **DTE wiggle**: ±1 day under 7 DTE, ±3 at 7+.
- **Directions cascade on correction; bands do not.** This asymmetry is
  deliberate and is called out inline in both `cascade.mjs` and
  `state-machine.mjs`. Read the comment block at the top of `cascade.mjs`
  before touching either.
- **Opportunistic, never critical path.** Terminal probe failure exits
  cleanly; no retries, no alerts, no state corruption.
- **Backfill is separate.** The one-time 2016→present historical backfill
  is not wired into this code path. It will get its own module.

## Running

```bash
# Test harness (no credentials required):
npm run test:reconcile

# Production run (requires env):
SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/reconcile/run.mjs
```

The production job is invoked by Windows Task Scheduler at 17:45 ET (same
evening) and 08:00 ET (next morning retry).
