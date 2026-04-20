# Resume prompt — vol flip migration (2026-04-20)

## What this is

Phase 1 of a two-phase migration that recomputes
`daily_gex_stats.vol_flip_strike` for all 2333 trading days from
2017-01-03 through 2026-04-15 using the γ(Ŝ) zero-crossing method
defined in `src/lib/gammaProfile.js` (live main page), replacing the
prior strike-axis zero-crossing method in
`scripts/backfill/compute-gex-history.mjs::computeDailyGex` which was
a different statistic and produced flip values that disagreed with the
live page on some fraction of days.

## How to check status

```bash
# How many days have completed
wc -l scripts/backfill/state/vol-flip-recompute-results.jsonl

# Most recent result
tail -1 scripts/backfill/state/vol-flip-recompute-results.jsonl

# Background process log (if launched via the standard command below)
tail -30 /tmp/vol-flip-migration.log
```

Each completed day appends one JSON line:

```json
{"date":"2026-04-15","flip":6870.15,"spot":7022.95,"contracts":19845,"profile_samples":422,"computed_at":"..."}
```

## How to resume if the process died

The script is append-only. Re-running skips dates already present in
the JSONL:

```bash
# Pre-check: Theta Terminal must be up on 127.0.0.1:25503.
curl -sS --max-time 5 "http://127.0.0.1:25503/v3/option/history/greeks/eod?symbol=SPX&expiration=*&start_date=20260415&end_date=20260415" | head -c 200

# Relaunch Theta Terminal if the test above fails:
powershell -Command "Get-Process java -ErrorAction SilentlyContinue | Stop-Process -Force"
cd /c/thetadata && nohup java -jar ThetaTerminalv3.jar > /tmp/theta-terminal-migration.log 2>&1 &

# Resume the migration
nohup node scripts/backfill/recompute-vol-flip.mjs \
  --dates-file scripts/backfill/state/vol-flip-dates.txt \
  --start 2017-01-03 --end 2026-04-15 \
  > /tmp/vol-flip-migration.log 2>&1 &
echo $! > /tmp/vol-flip-migration.pid
```

## When Phase 1 completes

Run Phase 2: apply the computed flips to Supabase via a single bulk
UPDATE. Read `scripts/backfill/state/vol-flip-recompute-results.jsonl`
and issue `UPDATE daily_gex_stats SET vol_flip_strike = v.flip FROM
(VALUES ...) AS v(trading_date, flip) WHERE
daily_gex_stats.trading_date = v.trading_date::date`. Can be done via
the Supabase MCP tool or via psql with a generated SQL file.

Sanity checks to run after Phase 2:

```sql
-- How many days' regime label flipped due to the methodology change
-- (requires joining against the backup file; see check script)
SELECT COUNT(*) FROM daily_gex_stats;

-- Any days where spot sits exactly on the new flip (NEAR FLIP)
SELECT trading_date, spx_close, vol_flip_strike,
       ABS(spx_close - vol_flip_strike) AS dist
FROM daily_gex_stats
WHERE vol_flip_strike IS NOT NULL
ORDER BY dist ASC LIMIT 20;
```

## Backup

Old `vol_flip_strike` values preserved at
`scripts/backfill/state/vol-flip-backup-2026-04-20.json`. If the
migration needs to be rolled back:

```sql
-- pseudo: read the backup JSON and issue the equivalent UPDATE with
-- the old values as v.flip.
```

## Timing

- Per-day cost: ~40-45 seconds (two wildcard-expiration fetches per
  root × two roots, serialized per the Jetty-writev-crash memory).
- Total: ~27 hours for 2333 days.
- If the terminal session ID breaks mid-run (per the Theta session
  memory, usually from multiple launcher instances), kill all java
  processes and relaunch one, then resume.
