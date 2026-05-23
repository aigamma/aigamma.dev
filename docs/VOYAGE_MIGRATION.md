# Voyage-3 embedding migration (2026-05-22)

Standardizes aigamma.com's RAG embedding stack on Voyage AI's voyage-3 (1024-dim, retrieval-tuned) to align with the discord_chat_memory table and the new civil-rights-history-project RAG layer. Migrates away from in-process Supabase.ai gte-small (384-dim).

## What changes

| Layer | Before | After |
|---|---|---|
| Embedding model | gte-small | voyage-3 |
| Dimensions | 384 | 1024 |
| Compute location | In-process inside Supabase Edge Function | External Voyage API call |
| Batch size ceiling | 3 (in-process memory bound) | 32 (Voyage rate-limit bound; much higher in practice) |
| Per-chunk embed cost | $0 (Supabase compute included) | ~$0.00003 (voyage-3 at $0.06/1M tokens) |
| Retrieval quality (rough MTEB) | ~55 | ~67 |
| Cold-start latency | ~500ms model load | None |
| Edge Function memory pressure | High (model weights in RAM) | Low (HTTP-out only) |

## What stays the same

- Wire format of both Edge Functions (caller code doesn't need updates)
- `match_rag_chunks` RPC signature (the `p_query_embedding vector` parameter is dimension-agnostic — it's a generic `vector` type, not `vector(N)`)
- `get_system_prompts` RPC (doesn't use embeddings)
- `chat_logs` table (records retrieved chunks; new embeddings are slot-compatible)
- Graceful degradation: if Voyage API fails or `VOYAGE_API_KEY` is missing, rag-search falls back to tsvector keyword search via the existing fallback branch in `match_rag_chunks`

## One-time cost

- Re-embed all 122 existing rows: ~122 chunks × ~500 tokens × $0.06/1M = **~$0.004** in Voyage API charges
- Engineering time: ~1-2 hours including schema migration, function deploys, verification

## Steady-state cost change

- aigamma chat has low traffic (44 chat_logs rows to date); steady-state query embedding is **< $0.05/month**
- Net effect: minimal positive cost change (a few cents/month) in exchange for better retrieval quality + cleaner Edge Function architecture + standardized stack

## Migration runbook

### Prerequisites

1. Set the Voyage AI API key as an Edge Function secret:
   ```bash
   # Via Supabase CLI (preferred):
   supabase secrets set VOYAGE_API_KEY=pa-xxxx --project-ref tbxhvpoyyyhbvoyefggu

   # Or via Supabase dashboard:
   #   Project Settings → Edge Functions → Manage Secrets
   #   Add VOYAGE_API_KEY with the value from worldthought.com's .env.local
   ```
2. Verify `VOYAGE_MODEL` is set or accepts the default `voyage-3`:
   ```bash
   # Optional — defaults to voyage-3 if not set
   supabase secrets set VOYAGE_MODEL=voyage-3 --project-ref tbxhvpoyyyhbvoyefggu
   ```

### Apply

Three steps, applied in order. The schema migration triggers a brief window of degraded search (tsvector keyword fallback) until step 3 completes the re-embed.

#### Step 1 — Apply schema migration

```bash
# Via Supabase CLI:
cd C:\aigamma.com
supabase db push  # picks up supabase/migrations/20260522000000_voyage_3_embedding_migration.sql

# Or via Supabase MCP (one-liner):
# claude_ai_Supabase__apply_migration with project_id and the SQL body
```

This nulls all embeddings, drops the old HNSW index, alters the column to `vector(1024)`, and recreates the HNSW index.

#### Step 2 — Deploy updated Edge Functions

```bash
# Via Supabase CLI:
supabase functions deploy rag-ingest --project-ref tbxhvpoyyyhbvoyefggu
supabase functions deploy rag-search --project-ref tbxhvpoyyyhbvoyefggu

# Or via Supabase MCP:
# claude_ai_Supabase__deploy_edge_function with the function source files
```

The new functions read `VOYAGE_API_KEY` from secrets and use voyage-3 for embedding. rag-search has graceful degradation built in if the key is missing.

#### Step 3 — Re-embed all 122 existing rows

```bash
# Set env vars (use the same SUPABASE_SERVICE_KEY from .env.local)
export SUPABASE_URL=https://tbxhvpoyyyhbvoyefggu.supabase.co
export SUPABASE_SERVICE_KEY=eyJ...   # service_role JWT
export RAG_BATCH_SIZE=32             # bumped from 3 — gte-small memory constraint is gone

# Run the existing walker. It will:
#   1. Chunk all SOURCES
#   2. Hash each chunk
#   3. Diff against rag_documents.content_hash
#   4. Send unchanged + changed + new chunks to rag-ingest
#   5. rag-ingest embeds with voyage-3 and upserts
#
# Because all embeddings were nulled in step 1, the upsert will populate
# embedding for every existing row, regardless of whether content_hash matches.
node scripts/rag/ingest.mjs
```

Expected output: `~122 chunks embedded`. Verify in the dashboard or via:

```sql
SELECT
  COUNT(*) FILTER (WHERE embedding IS NOT NULL) AS embedded,
  COUNT(*) FILTER (WHERE embedding IS NULL) AS pending,
  COUNT(*) AS total
FROM public.rag_documents;
```

#### Step 4 — Verify retrieval works

```bash
# Hit rag-search with a known-good query and confirm embedding_used: true
curl -X POST https://tbxhvpoyyyhbvoyefggu.supabase.co/functions/v1/rag-search \
  -H 'Content-Type: application/json' \
  -d '{"query":"what is the main dashboard about?","surface":"main","top_k":5}'
```

Look for:
- `"embedding_used": true`
- `"embedding_error": null`
- `"model": "voyage-3"`
- `"chunks": [...]` populated with similarity matches
- `"system_prompts": [...]` populated with pinned per-surface + global prompts

If `"embedding_used": false` and `"embedding_error": "voyage_api_key_missing"`, step 1 of prerequisites didn't take — re-check secrets.

If `"chunks": []` after embedding: re-run step 3 (re-embed); the embedding column may not have populated.

## Rollback

If anything goes wrong, the rollback path is symmetric:

```sql
-- Revert schema (vector(1024) → vector(384), drop+recreate index)
BEGIN;
UPDATE public.rag_documents SET embedding = NULL;
DROP INDEX IF EXISTS public.rag_documents_embedding_hnsw;
ALTER TABLE public.rag_documents ALTER COLUMN embedding TYPE vector(384);
CREATE INDEX rag_documents_embedding_hnsw ON public.rag_documents
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE (embedding IS NOT NULL);
COMMIT;
```

Then redeploy the pre-migration Edge Function source (kept in git history before this migration's commit) and re-run the gte-small ingest.

## Coordination with other systems

- **about.aigamma.com**: This site queries aigamma.com's `rag-search` cross-domain. No code changes needed there — it inherits the voyage-3 improvement automatically. The biographical HTML chunks are part of the 122 rows that get re-embedded in step 3.
- **discord_chat_memory**: Already on voyage-3; unaffected by this migration.
- **civil-rights-history-project**: New project, will be ingested into a separate Pinecone Builder project (not Supabase). Already designed for voyage-3 from day one (see `C:\civil\rag\`).
- **worldthought.com**: Already on voyage-3 (its own Pinecone project, separate from aigamma). Unaffected.

## What this commit ships

- `supabase/migrations/20260522000000_voyage_3_embedding_migration.sql` — the schema migration (atomic, transactional)
- `supabase/functions/rag-ingest/index.ts` — the new Edge Function source
- `supabase/functions/rag-search/index.ts` — the new Edge Function source
- `docs/VOYAGE_MIGRATION.md` — this runbook

The Edge Function source files were not previously in the repo (they lived only in Supabase deployment). Committing them now means future schema/function changes can be reviewed in git before deployment.
