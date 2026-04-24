# aigamma.com

Open-source quantitative volatility dashboard for SPX options, built with React, Plotly, and live OPRA data. MIT license.

Production deployment: https://aigamma.com

## What This Is

A quantitative finance platform that visualizes gamma exposure, implied volatility structure, dealer positioning, and volatility risk premium for SPX options. The dashboard consumes real-time options chain snapshots every 5 minutes during market hours, computes GEX per strike, derives key levels (Call Wall, Put Wall, Absolute Gamma Strike, Volatility Flip), fits SVI volatility surfaces, extracts Breeden-Litzenberger risk-neutral densities, and renders interactive Plotly charts on a dark-themed interface.

Historical analysis is powered by a one-year backfill of EOD options data from ThetaData, enabling percentile-banded term structure visualization, volatility risk premium modeling, and regime detection. A reconciliation job verifies intraday-collected derived features against ThetaData EOD as the source of record.

This project independently reconstructs the category of tooling offered by institutional derivatives analytics platforms, using serverless infrastructure and two independent data sources for integrity.

## Architecture

The system separates real-time data collection, historical data reconciliation, and data serving into three independent layers.

**Intraday Layer.** A scheduled Netlify Function (ingest-background.mjs) fetches the full SPX options chain from the Massive API every 5 minutes during market hours. It computes GEX and positioning metrics and writes to four Supabase tables: ingest_runs, snapshots, computed_levels, and expiration_metrics. The frontend reads from Supabase through a separate Netlify Function (data.mjs) with a 900-second CDN cache. The browser never contacts the data source directly.

**Historical Layer.** The Theta Terminal V3 runs locally and serves EOD options data through a REST API at http://127.0.0.1:25503/v3. A backfill pipeline pulls historical SPX options chains day by day, computes derived features (ATM IV per tenor, Yang-Zhang realized volatility, volatility risk premium), and writes to daily_term_structure, daily_cloud_bands, and daily_volatility_stats. Raw chain data is consumed locally and discarded. Only derived scalars persist.

**Reconciliation Layer.** A daily reconciliation job (scripts/reconcile/) compares Massive-collected derived levels against ThetaData EOD as the source of record. If any level diverges by more than 2%, ThetaData overwrites the Massive value. The entire per-day mutation set executes inside a single PostgreSQL stored procedure (reconcile_day_atomic) for all-or-nothing transaction semantics. Directional flags cascade on correction; percentile bands do not. The reconciliation layer is opportunistic: if the Theta Terminal is unreachable, the job logs and exits cleanly, and the dashboard continues serving Massive-sourced data at full fidelity.

CDN edge caching absorbs read traffic, so Supabase sees approximately one query per edge location per cache window regardless of concurrent user count.

## Models

**Gamma Exposure.** GEX per strike with symlog scaling, dealer gamma inflection profile, and gamma response map.

```
GEX_contract = gamma * open_interest * 100 * spot_price^2 * 0.01
Net_GEX(K)  = sum(call GEX at K) - sum(put GEX at K)
```

Sign convention follows dealer positioning: calls create positive gamma (stabilizing), puts create negative gamma (destabilizing), assuming dealers are net short options.

**Key Levels.** Derived from the GEX profile:
- **Call Wall**: Strike with highest positive call gamma notional
- **Put Wall**: Strike with highest negative put gamma notional
- **Absolute Gamma Strike**: Strike with highest total absolute gamma (strongest pinning effect)
- **Volatility Flip**: Interpolated net-GEX zero crossing where the absolute exposure on both sides is largest, the structurally dominant regime boundary between positive and negative dealer gamma

**Term Structure with Probability Cloud.** ATM IV across expirations with historical percentile bands computed from a 1-year rolling lookback. Four equal-probability bands (p10-p30, p30-p50, p50-p70, p70-p90) with darkest shading at the extremes and lightest at the median. Dots tinted amber below p30 and coral above p70 as mean-reversion signals.

**SVI Volatility Surface.** 3D interactive surface fit using Stochastic Volatility Inspired parameterization across all listed expirations. Toggle between SVI fit and raw scatter.

**Breeden-Litzenberger Risk-Neutral Density.** Implied probability distribution extracted from the second derivative of call prices with respect to strike, rendered across multiple expirations.

**Fixed-Strike IV Heatmap.** IV across strikes and expiration dates with color-coded intensity.

**Volatility Risk Premium.** 30-day constant-maturity ATM IV versus 20-day Yang-Zhang realized volatility with SPX price overlay. Green shading where IV exceeds HV (positive VRP, normal state), coral shading where HV exceeds IV (negative VRP). Brush-zoom with 6-month default view.

## Database Schema

| Table | Purpose |
|-------|---------|
| ingest_runs | Intraday ingest execution metadata |
| snapshots | 5-minute options chain snapshots |
| computed_levels | Intraday derived levels (PW, CW, VF) |
| expiration_metrics | Per-expiration intraday metrics |
| daily_levels | Reconciled daily key levels with directional flags and coordination metric |
| daily_term_structure | Per-tenor ATM IV history, one row per (trading_date, expiration_date) |
| daily_cloud_bands | Frozen percentile bands (p10/p30/p50/p70/p90) per (trading_date, DTE) |
| daily_volatility_stats | Yang-Zhang realized vol, constant-maturity IV, and VRP spread |
| reconciliation_audit | Append-only correction event log |

## Stack

| Component | Role |
|-----------|------|
| React 19 + Vite | Frontend framework |
| Plotly.js + Three.js | Chart rendering (2D and 3D) |
| Netlify | Hosting, CDN, scheduled functions, DNS |
| Supabase Pro | PostgreSQL persistence, RPC, and caching |
| Massive API | Real-time options chain snapshots (OPRA-sourced) |
| ThetaData (Options Standard) | Historical EOD options data, pre-computed Greeks, IV |

## Reconciliation Test Harness

A permanent test harness validates the reconciliation job's invariants:

```bash
npm run test:reconcile
```

Four scenarios: transaction rollback on simulated crash leaves reconciled=false, re-running a fully reconciled day is a no-op, cascade propagates directional flips across multiple subsequent days, and terminal-unreachable exits cleanly with zero state changes.

## Development

```bash
git clone https://github.com/aigamma/aigamma.com.git
cd aigamma.com
npm install
npm run dev
```

The dev server runs at localhost:5173. The API proxy (/api/data) only functions on Netlify, so local development shows a loading state unless you configure a local data source.

Historical data features require the Theta Terminal V3 running locally with a ThetaData subscription (Options Standard or higher) and a populated Supabase instance. See scripts/reconcile/README.md for the reconciliation architecture and scripts/backfill/ for the historical data pipeline.

## Related Sites

- **about.aigamma.com**: Portfolio and AI chatbot (repo: aigamma/about.aigamma.com)

## License

MIT. The code is free. The expertise is what employers are hiring.

## Author

Eric Allione / AI Gamma / Prescott, AZ
Revenue Systems Architect

