# Supabase Schema Reference

Project ID: `tbxhvpoyyyhbvoyefggu`. All tables have RLS enabled. Netlify functions use the service-role key (bypasses RLS) for writes and the anon key for reads.

## Core ingest tables (Massive API, real-time intraday)

**ingest_runs** — One row per fetch. PK: `id` (bigserial).
- `underlying` (varchar), `captured_at` (timestamptz), `trading_date` (date)
- `snapshot_type` (varchar, check: intraday | daily | synthetic_backfill)
- `spot_price` (numeric), `contract_count` (int), `expiration_count` (int)
- `source` (varchar, default 'massive'), `status` (varchar, default 'success')
- `duration_ms` (int, nullable), `error_message` (text, nullable)
- FK targets: snapshots, computed_levels, expiration_metrics, svi_fits

**snapshots** — Contract-level data. PK: `id` (bigserial). FK: `run_id` → ingest_runs.
- `expiration_date` (date), `strike` (numeric), `contract_type` (varchar), `root_symbol` (varchar, nullable)
- `implied_volatility`, `delta`, `gamma`, `theta`, `vega` (all numeric, nullable)
- `open_interest` (int), `volume` (int), `close_price` (numeric)
- ~5.1M rows

**computed_levels** — Aggregate metrics per run. PK: `id`. FK: `run_id` → ingest_runs (unique).
- `call_wall_strike`, `put_wall_strike`, `abs_gamma_strike`, `volatility_flip` (numeric)
- `atm_call_gex`, `atm_put_gex` (numeric), `atm_contract_count` (int) — ATM-bucket (|δ|∈[0.40, 0.60])
- `put_call_ratio_oi`, `put_call_ratio_volume` (numeric)
- `total_call_oi`, `total_put_oi`, `total_call_volume`, `total_put_volume` (bigint)
- `net_vanna_notional`, `net_charm_notional` (numeric)

**expiration_metrics** — Per-expiration skew. PK: `id`. FK: `run_id` → ingest_runs.
- `expiration_date` (date), `atm_iv`, `atm_strike` (numeric)
- `put_25d_iv`, `call_25d_iv`, `skew_25d_rr` (numeric)
- `contract_count` (int)

**svi_fits** — Gatheral raw-SVI fits + Breeden-Litzenberger density. PK: `id`. FK: `run_id` → ingest_runs.
- `expiration_date` (date), `t_years`, `forward_price` (numeric)
- SVI params: `a`, `b`, `rho`, `m`, `sigma` (numeric)
- `rmse_iv`, `sample_count`, `iterations`, `converged`, `tenor_window`
- Diagnostics: `non_negative_variance`, `butterfly_arb_free`, `min_durrleman_g`
- Density: `density_strikes` (numeric[]), `density_values` (numeric[]), `density_integral`
- 0 rows currently (client-side SVI calibration is the active path)

## Historical / EOD tables (ThetaData sourced)

**daily_volatility_stats** — EOD vol metrics. PK: `trading_date` (date).
- `spx_open`, `spx_high`, `spx_low`, `spx_close` (numeric)
- `hv_20d_yz` (Yang-Zhang 20d realized vol), `iv_30d_cm` (30d constant-maturity ATM IV)
- `vrp_spread` (iv_30d_cm − hv_20d_yz)
- `sample_count` (int), `computed_at` (timestamptz)
- 289 rows, range: 2025-02-14 → 2026-04-10

**daily_term_structure** — Per-expiration ATM IV by trading date. Composite PK: `(trading_date, expiration_date)`.
- `dte` (int), `atm_iv` (numeric), `source` (text, check: massive | theta)
- `percentile_rank` (numeric, nullable)
- 10,042 rows, all source='theta', range: 2025-04-14 → 2026-04-10

**daily_cloud_bands** — Historical IV percentile bands. Composite PK: `(trading_date, dte)`.
- `dte` (int, check: 0..280)
- `iv_p10`, `iv_p30`, `iv_p50`, `iv_p70`, `iv_p90` (numeric)
- `sample_count` (int), `computed_at` (timestamptz)
- 70,812 rows, range: 2025-04-14 → 2026-04-15

## Reconciliation tables

**daily_levels** — EOD wall/flip levels. PK: `trading_date` (date).
- `put_wall_strike`, `call_wall_strike`, `vol_flip_strike` (numeric)
- `put_wall_direction`, `call_wall_direction`, `vol_flip_direction` (text, check: up | flat | down)
- `coordinated_move` (bool), `coordinated_direction` (text, check: up | down)
- `reconciled` (bool), `reconciled_at` (timestamptz)
- `massive_snapshot_time`, `theta_fetched_at` (timestamptz)
- 0 rows

**reconciliation_audit** — Audit trail. PK: `id` (bigserial).
- `trading_date`, `feature_type` (level | atm_iv), `feature_key`
- `massive_value`, `theta_value` (text), `delta_pct` (numeric)
- `event_type` (overwrite | gap_backfill | missing_theta_flag | direction_flip | cascade_flip)
- 0 rows
