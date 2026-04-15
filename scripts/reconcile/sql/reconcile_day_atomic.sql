-- reconcile_day_atomic(target_date date, payload jsonb)
-- ============================================================================
-- The per-day all-or-nothing guarantee for the reconciliation job.
-- PostgREST cannot span a transaction across multiple REST calls, so the
-- entire per-day mutation set is passed as a single jsonb payload and
-- applied inside a single plpgsql stored procedure. Any error anywhere in
-- the body rolls back every mutation, including the reconciled flag.
--
-- Called from scripts/reconcile/supabase-client.mjs :: reconcileDayAtomic.
-- The payload shape is built in scripts/reconcile/state-machine.mjs.
--
-- CRITICAL: If a future change extends the payload, BOTH the staging logic
-- in state-machine.mjs AND this function must be updated together. The fake
-- harness in scripts/reconcile/harness/fake-db.mjs also mirrors this contract
-- — it is the test-time implementation of this same function, so any schema
-- drift here must be reflected there too.
--
-- Payload shape:
-- {
--   "levels":         { put_wall_strike, call_wall_strike, vol_flip_strike },
--   "directions":     { put_wall_direction, call_wall_direction, vol_flip_direction },
--   "coordination":   { coordinated_move, coordinated_direction },
--   "level_events":   [audit rows],
--   "direction_events":[audit rows],
--   "ts_updates":     [{ trading_date, expiration_date, atm_iv, source }],
--   "ts_inserts":     [{ trading_date, expiration_date, dte, atm_iv, source }],
--   "ts_events":      [audit rows],
--   "ts_percentile_updates": [{ trading_date, expiration_date, percentile_rank }],
--   "bands":          [{ dte, iv_p10, iv_p30, iv_p50, iv_p70, iv_p90, sample_count }],
--   "cascade_updates":[{ trading_date, directions, coordination, events: [audit] }]
-- }
-- ============================================================================

create or replace function public.reconcile_day_atomic(target_date date, payload jsonb)
returns void
language plpgsql
security definer
as $$
declare
  v_level         jsonb := payload -> 'levels';
  v_dir           jsonb := payload -> 'directions';
  v_coord         jsonb := payload -> 'coordination';
  v_ts_update     jsonb;
  v_ts_insert     jsonb;
  v_pct_update    jsonb;
  v_band          jsonb;
  v_cascade       jsonb;
  v_event         jsonb;
begin
  -- 1. Overwrite the day's levels, direction flags, and coordination.
  update public.daily_levels
     set put_wall_strike        = (v_level  ->> 'put_wall_strike')::numeric,
         call_wall_strike       = (v_level  ->> 'call_wall_strike')::numeric,
         vol_flip_strike        = (v_level  ->> 'vol_flip_strike')::numeric,
         put_wall_direction     = v_dir   ->> 'put_wall_direction',
         call_wall_direction    = v_dir   ->> 'call_wall_direction',
         vol_flip_direction     = v_dir   ->> 'vol_flip_direction',
         coordinated_move       = (v_coord ->> 'coordinated_move')::boolean,
         coordinated_direction  = v_coord ->> 'coordinated_direction',
         reconciled             = true,
         reconciled_at          = now()
   where trading_date = target_date;

  if not found then
    raise exception 'reconcile_day_atomic: no daily_levels row for %', target_date;
  end if;

  -- 2. Term structure overwrites.
  for v_ts_update in select * from jsonb_array_elements(coalesce(payload -> 'ts_updates', '[]'::jsonb))
  loop
    update public.daily_term_structure
       set atm_iv = (v_ts_update ->> 'atm_iv')::numeric,
           source = v_ts_update ->> 'source'
     where trading_date   = target_date
       and expiration_date = (v_ts_update ->> 'expiration_date')::date;
  end loop;

  -- 3. Term structure inserts (gap backfills).
  for v_ts_insert in select * from jsonb_array_elements(coalesce(payload -> 'ts_inserts', '[]'::jsonb))
  loop
    insert into public.daily_term_structure
           (trading_date, expiration_date, dte, atm_iv, source)
    values (target_date,
            (v_ts_insert ->> 'expiration_date')::date,
            (v_ts_insert ->> 'dte')::int,
            (v_ts_insert ->> 'atm_iv')::numeric,
            v_ts_insert ->> 'source')
    on conflict (trading_date, expiration_date) do nothing;
  end loop;

  -- 4. Denormalized percentile_rank writes.
  for v_pct_update in select * from jsonb_array_elements(coalesce(payload -> 'ts_percentile_updates', '[]'::jsonb))
  loop
    update public.daily_term_structure
       set percentile_rank = (v_pct_update ->> 'percentile_rank')::numeric
     where trading_date   = target_date
       and expiration_date = (v_pct_update ->> 'expiration_date')::date;
  end loop;

  -- 5. Frozen cloud bands. POINT-IN-TIME SNAPSHOT — never updated
  -- retroactively, even when underlying daily_term_structure values get
  -- corrected on a later run. This is the deliberate asymmetry with the
  -- direction cascade below. See scripts/reconcile/cascade.mjs for the
  -- full rationale.
  for v_band in select * from jsonb_array_elements(coalesce(payload -> 'bands', '[]'::jsonb))
  loop
    insert into public.daily_cloud_bands
           (trading_date, dte, iv_p10, iv_p30, iv_p50, iv_p70, iv_p90, sample_count, computed_at)
    values (target_date,
            (v_band ->> 'dte')::int,
            nullif(v_band ->> 'iv_p10', '')::numeric,
            nullif(v_band ->> 'iv_p30', '')::numeric,
            nullif(v_band ->> 'iv_p50', '')::numeric,
            nullif(v_band ->> 'iv_p70', '')::numeric,
            nullif(v_band ->> 'iv_p90', '')::numeric,
            (v_band ->> 'sample_count')::int,
            now())
    on conflict (trading_date, dte) do update
       set iv_p10       = excluded.iv_p10,
           iv_p30       = excluded.iv_p30,
           iv_p50       = excluded.iv_p50,
           iv_p70       = excluded.iv_p70,
           iv_p90       = excluded.iv_p90,
           sample_count = excluded.sample_count,
           computed_at  = excluded.computed_at;
  end loop;

  -- 6. Cascade direction corrections forward through already-reconciled
  -- days. BANDS ARE NOT TOUCHED HERE — cascade is directions only. See
  -- scripts/reconcile/cascade.mjs for the CRITICAL asymmetry comment.
  for v_cascade in select * from jsonb_array_elements(coalesce(payload -> 'cascade_updates', '[]'::jsonb))
  loop
    update public.daily_levels
       set put_wall_direction    = v_cascade -> 'directions' ->> 'put_wall_direction',
           call_wall_direction   = v_cascade -> 'directions' ->> 'call_wall_direction',
           vol_flip_direction    = v_cascade -> 'directions' ->> 'vol_flip_direction',
           coordinated_move      = (v_cascade -> 'coordination' ->> 'coordinated_move')::boolean,
           coordinated_direction = v_cascade -> 'coordination' ->> 'coordinated_direction'
     where trading_date = (v_cascade ->> 'trading_date')::date;
  end loop;

  -- 7. Audit events — single append from all buckets.
  for v_event in
    select * from jsonb_array_elements(coalesce(payload -> 'level_events',     '[]'::jsonb))
    union all
    select * from jsonb_array_elements(coalesce(payload -> 'direction_events', '[]'::jsonb))
    union all
    select * from jsonb_array_elements(coalesce(payload -> 'ts_events',        '[]'::jsonb))
    union all
    select v.value
      from jsonb_array_elements(coalesce(payload -> 'cascade_updates', '[]'::jsonb)) c,
           jsonb_array_elements(coalesce(c.value -> 'events', '[]'::jsonb)) v
  loop
    insert into public.reconciliation_audit
           (trading_date, feature_type, feature_key, massive_value, theta_value,
            delta_pct, event_type, notes, created_at)
    values ((v_event ->> 'trading_date')::date,
            v_event ->> 'feature_type',
            v_event ->> 'feature_key',
            nullif(v_event ->> 'massive_value', '')::text,
            nullif(v_event ->> 'theta_value',   '')::text,
            nullif(v_event ->> 'delta_pct',     '')::numeric,
            v_event ->> 'event_type',
            v_event ->> 'notes',
            now());
  end loop;
end;
$$;
