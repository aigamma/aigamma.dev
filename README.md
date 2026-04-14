# aigamma.com

This is the production React dashboard deployed at https://aigamma.com. The whole project is available in this public repo; it depends on Supabase as the cache layer accumulating market data, and Netlify for DNS, hosting, scheduled ingest functions, and builds.

Open-source volatility dashboard for equity options, built with React, Plotly, and live OPRA data from the Massive API (formerly Polygon.io). MIT license.

## What This Is

A quantitative finance platform that visualizes gamma exposure, implied volatility structure, and dealer positioning for US equity options. The dashboard consumes 15-minute delayed options chain snapshots, updates 5 minutes (in prototype phase but will update every minute after further steps and paying for an n8n cloud upgrade), computes GEX per strike, derives key levels (Call Wall, Put Wall, Absolute Gamma Strike, Volatility Flip), and renders interactive Plotly charts on a dark-themed interface.

This project independently reconstructs the category of tooling offered by institutional derivatives analytics platforms, using publicly available delayed data and serverless infrastructure.

## Architecture

![Infrastructure Topology](docs/architecture.png)

The system separates data collection from data serving. An n8n Cloud workflow is the sole consumer of the Massive API, running on a 15-minute cron during market hours (~26 executions per day). It fetches the full options chain, computes GEX and skew metrics in a Code node, and writes to Supabase PostgreSQL. The frontend reads exclusively from Supabase through a Netlify Function with CDN cache headers (900-second TTL). The browser never contacts the data source directly.

Supabase serves as both the intraday cache (overwritten every 15 minutes) and the permanent historical archive (daily snapshots preserved indefinitely). This eliminates the need for a separate Redis instance. CDN edge caching absorbs read traffic, so Supabase sees approximately one query per edge location per 15-minute window regardless of concurrent user count.

## GEX Computation

```
GEX_contract = gamma * open_interest * 100 * spot_price^2 * 0.01
Net_GEX(K)  = sum(call GEX at K) - sum(put GEX at K)
```

Sign convention follows dealer positioning: calls create positive gamma (stabilizing), puts create negative gamma (destabilizing), assuming dealers are net short options.

Key levels derived from the GEX profile:
- **Call Wall**: Strike with highest positive call gamma notional
- **Put Wall**: Strike with highest negative put gamma notional
- **Absolute Gamma Strike**: Strike with highest total absolute gamma (strongest pinning effect)
- **Volatility Flip**: Interpolated net-GEX zero crossing where the absolute exposure on both sides is largest — the structurally dominant regime boundary between positive and negative dealer gamma

## Stack

| Component | Role |
|-----------|------|
| React + Vite | Frontend framework |
| Plotly.js | Chart rendering |
| Netlify | Hosting, CDN, serverless functions |
| Supabase | PostgreSQL persistence and caching |
| n8n Cloud | Scheduled data collection and computation |
| Massive API | Options chain snapshots (OPRA-sourced, 15-min delayed) |

## Regulatory Note

This platform serves exclusively 15-minute delayed data via the Massive API Options Starter tier. Under SEC Rule 603 (Regulation NMS, 17 C.F.R. 242.603), delayed data distribution does not trigger subscriber classification, attestation collection, or exchange fee obligations.

## Development

```bash
git clone https://github.com/aigamma/aigamma.com.git
cd aigamma.com
npm install
npm run dev
```

The dev server runs at `localhost:5173`. The API proxy (`/api/data`) only functions on Netlify, so local development shows a loading state unless you configure a local data source.

## License

MIT. The code is free. The expertise is what employers are hiring.

## Author

Eric Allione / AI Gamma LLC / Prescott, AZ

Revenue systems architect and former DoD architect and Principal Analyst at a derivatives analytics firm. Designed the volatility tools (fixed strike IV matrix, volatility smile, term structure), oversaw development of live gamma and charm tools, wrote 585 institutional-grade evening market analyses, built a 700-page public knowledge base, and individually trained hundreds of paying professional subscribers on derivatives mechanics. All without generative AI.
