#!/usr/bin/env node
// Build chunked UPDATE statements for Phase 2 of the walls backfill.
// Dedups the JSONL by trading_date (the 2026-04-22 two-instance incident
// produced 7 duplicate rows across 6 dates, all with byte-identical
// values — so "take any row per date" is safe) and writes one UPDATE
// per batch under scripts/backfill/state/walls-phase2-sql/. Each
// UPDATE sets both call_wall_strike and put_wall_strike for a batch of
// dates via a VALUES-derived table so Postgres applies the whole batch
// in a single statement.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const BATCH_SIZE = 500;
const OUT_DIR = 'scripts/backfill/state/walls-phase2-sql';
mkdirSync(OUT_DIR, { recursive: true });

const raw = readFileSync('scripts/backfill/state/walls-recompute-results.jsonl', 'utf8')
  .trim()
  .split(/\r?\n/)
  .map((l) => JSON.parse(l));

// Dedup by date, keeping the first occurrence. Duplicates (from the
// 2026-04-22 two-instance incident) have byte-identical call_wall /
// put_wall / spot values so first-seen wins without loss.
const byDate = new Map();
for (const r of raw) {
  if (!byDate.has(r.date)) byDate.set(r.date, r);
}
const rows = [...byDate.values()]
  .filter((r) => r.call_wall != null && r.put_wall != null)
  .sort((a, b) => a.date.localeCompare(b.date));

const batches = [];
for (let i = 0; i < rows.length; i += BATCH_SIZE) {
  batches.push(rows.slice(i, i + BATCH_SIZE));
}

for (let b = 0; b < batches.length; b++) {
  const batch = batches[b];
  const values = batch
    .map((r) => `('${r.date}'::date, ${r.call_wall}, ${r.put_wall})`)
    .join(',\n  ');
  const sql = `-- Walls Phase 2 batch ${b + 1}/${batches.length} (${batch.length} rows, ${batch[0].date} → ${batch[batch.length - 1].date})
UPDATE daily_gex_stats
SET call_wall_strike = v.cw,
    put_wall_strike = v.pw
FROM (VALUES
  ${values}
) AS v(trading_date, cw, pw)
WHERE daily_gex_stats.trading_date = v.trading_date;
`;
  const path = `${OUT_DIR}/batch-${String(b + 1).padStart(2, '0')}.sql`;
  writeFileSync(path, sql);
  console.log(`Wrote ${path} (${batch.length} rows, ${sql.length} bytes)`);
}
console.log(`Total: ${batches.length} batches, ${rows.length} unique dated rows (raw input: ${raw.length})`);
