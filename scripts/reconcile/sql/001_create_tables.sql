-- Reconciliation schema: four tables for the daily EOD integrity job.
-- See scripts/reconcile/README.md and the design notes in
-- project_reconciliation_architecture.md (auto-memory). Does not touch
-- the existing live ingest tables (ingest_runs, snapshots,
-- computed_levels, expiration_metrics).
--
-- Apply via Supabase MCP apply_migration or psql. Idempotent where
-- possible via IF NOT EXISTS clauses so re-running is a no-op.

-- 1. daily_levels — one row per trading day. Single source of truth
-- for the day's reconciliation state. The reconciled flag is atomic:
-- it flips only when the whole day's reconciliation has committed.
create table if not exists public.daily_levels (
  trading_date          date primary key,
  put_wall_strike       numeric,
  call_wall_strike      numeric,
  vol_flip_strike       numeric,
  put_wall_direction    text check (put_wall_direction  in ('up', 'flat', 'down')),
  call_wall_direction   text check (call_wall_direction in ('up', 'flat', 'down')),
  vol_flip_direction    text check (vol_flip_direction  in ('up', 'flat', 'down')),
  coordinated_move      boolean not null default false,
  coordinated_direction text check (coordinated_direction in ('up', 'down')),
  reconciled            boolean not null default false,
  reconciled_at         timestamptz,
  massive_snapshot_time timestamptz,
  theta_fetched_at      timestamptz
);

create index if not exists daily_levels_reconciled_idx
  on public.daily_levels (reconciled, trading_date);

-- 2. daily_term_structure — per-tenor ATM IV observations keyed by
-- physical expiration (not DTE bucket). percentile_rank is denormalized
-- from daily_cloud_bands so serving is a single-row read. No reconciled
-- column — the day's reconciliation status is read from daily_levels.
create table if not exists public.daily_term_structure (
  trading_date     date    not null,
  expiration_date  date    not null,
  dte              integer not null,
  atm_iv           numeric,
  source           text    not null check (source in ('massive', 'theta')),
  percentile_rank  numeric,
  primary key (trading_date, expiration_date)
);

create index if not exists daily_term_structure_dte_idx
  on public.daily_term_structure (trading_date, dte);

-- 3. daily_cloud_bands — frozen historical percentile bands. Computed
-- once at reconciliation time from the rolling 1-year window ending the
-- day before trading_date. NEVER updated retroactively, even when
-- underlying daily_term_structure values are corrected downstream.
-- Five percentiles so the frontend can render four equal-mass 20-
-- percentile-point bands (p10-p30, p30-p50, p50-p70, p70-p90). The
-- interior split points are at p30/p70 not p25/p75 so each band holds
-- exactly the same 20 percentile points of probability mass — a
-- visually wider upper band is then entirely distributional skew and
-- not a bin-size artifact.
create table if not exists public.daily_cloud_bands (
  trading_date date    not null,
  dte          integer not null check (dte between 0 and 280),
  iv_p10       numeric,
  iv_p30       numeric,
  iv_p50       numeric,
  iv_p70       numeric,
  iv_p90       numeric,
  sample_count integer not null default 0,
  computed_at  timestamptz not null default now(),
  primary key (trading_date, dte)
);

-- 4. reconciliation_audit — append-only event log. Every correction
-- and flagged event gets a row. Powers the site's data-quality panel.
create table if not exists public.reconciliation_audit (
  id            bigserial primary key,
  trading_date  date   not null,
  feature_type  text   not null check (feature_type in ('level', 'atm_iv')),
  feature_key   text   not null,
  massive_value text,
  theta_value   text,
  delta_pct     numeric,
  event_type    text   not null check (event_type in (
                  'overwrite',
                  'gap_backfill',
                  'missing_theta_flag',
                  'direction_flip',
                  'cascade_flip'
                )),
  notes         text,
  created_at    timestamptz not null default now()
);

create index if not exists reconciliation_audit_trading_date_idx
  on public.reconciliation_audit (trading_date);

create index if not exists reconciliation_audit_event_type_idx
  on public.reconciliation_audit (event_type);

-- RLS: enable on all four so nothing is readable via the anon key.
-- The Netlify server-side functions (ingest + reconciliation runner +
-- data.mjs) use the service-role key which bypasses RLS. No public
-- policies are created; if the frontend ever needs direct anon reads,
-- add explicit read policies at that point.
alter table public.daily_levels           enable row level security;
alter table public.daily_term_structure   enable row level security;
alter table public.daily_cloud_bands      enable row level security;
alter table public.reconciliation_audit   enable row level security;
