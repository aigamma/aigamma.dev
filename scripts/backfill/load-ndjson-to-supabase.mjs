#!/usr/bin/env node
// Reads an NDJSON file, deduplicates, and prints SQL for Supabase MCP execute_sql.
// Run periodically to load accumulated backfill data.
//
// Usage: node scripts/backfill/load-ndjson-to-supabase.mjs scripts/backfill/.cache/gex_stream_*.ndjson
//
// Paste the output into Supabase MCP execute_sql or pipe to psql.

import { readFileSync } from 'node:fs';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('Usage: node load-ndjson-to-supabase.mjs <ndjson-file> [...]');
  process.exit(2);
}

const seen = new Map();
for (const file of files) {
  const content = readFileSync(file, 'utf8');
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o.trading_date) seen.set(o.trading_date, o);
    } catch { /* skip */ }
  }
}

const rows = [...seen.values()].sort((a, b) => a.trading_date.localeCompare(b.trading_date));
if (rows.length === 0) { console.error('No rows found'); process.exit(0); }

const BATCH = 50;
for (let i = 0; i < rows.length; i += BATCH) {
  const batch = rows.slice(i, i + BATCH);
  const vals = batch.map(r => {
    const flip = r.vol_flip_strike != null ? r.vol_flip_strike : 'NULL';
    return `('${r.trading_date}', ${r.spx_close}, ${r.net_gex}, ${r.call_gex}, ${r.put_gex}, ${flip}, ${r.contract_count})`;
  }).join(',\n  ');

  console.log(`INSERT INTO daily_gex_stats (trading_date, spx_close, net_gex, call_gex, put_gex, vol_flip_strike, contract_count)
VALUES
  ${vals}
ON CONFLICT (trading_date) DO UPDATE SET
  spx_close = EXCLUDED.spx_close, net_gex = EXCLUDED.net_gex,
  call_gex = EXCLUDED.call_gex, put_gex = EXCLUDED.put_gex,
  vol_flip_strike = EXCLUDED.vol_flip_strike, contract_count = EXCLUDED.contract_count,
  computed_at = now();`);
}
console.error(`${rows.length} unique rows in ${Math.ceil(rows.length / BATCH)} batch(es)`);
