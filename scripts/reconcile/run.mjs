#!/usr/bin/env node
// CLI entry point for the daily reconciliation job.
// Invoked by Windows Task Scheduler at 17:45 ET (evening attempt) and
// 08:00 ET (morning retry for anything the evening run couldn't reconcile).
// Both triggers are idempotent — running either twice on the same date
// is a no-op on already-reconciled days.

import process from 'node:process';
import { createThetaClient } from './theta-client.mjs';
import { createSupabaseClient } from './supabase-client.mjs';
import { runReconciliation } from './state-machine.mjs';

function todayEastern() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const y = parts.find((p) => p.type === 'year').value;
  const m = parts.find((p) => p.type === 'month').value;
  const d = parts.find((p) => p.type === 'day').value;
  return `${y}-${m}-${d}`;
}

const logger = {
  info: (event, data = {}) => console.log(JSON.stringify({ level: 'info', event, ...data })),
  warn: (event, data = {}) => console.log(JSON.stringify({ level: 'warn', event, ...data })),
  error: (event, data = {}) => console.error(JSON.stringify({ level: 'error', event, ...data })),
};

async function main() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !serviceKey) {
    logger.error('reconcile.missing_env', { need: ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY'] });
    process.exit(2);
  }

  const db = createSupabaseClient({ url, serviceKey });
  const theta = createThetaClient({
    baseUrl: process.env.THETA_BASE_URL || 'http://127.0.0.1:25503',
  });

  const ctx = { db, theta, logger, clock: { todayEastern }, config: {} };
  const summary = await runReconciliation(ctx);
  logger.info('reconcile.done', summary);
}

main().catch((err) => {
  logger.error('reconcile.fatal', { error: String(err), stack: err?.stack });
  process.exit(1);
});
