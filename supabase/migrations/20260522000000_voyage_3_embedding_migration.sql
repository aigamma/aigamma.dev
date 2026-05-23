-- Voyage AI voyage-3 embedding migration (2026-05-22)
--
-- Migrates rag_documents.embedding from gte-small (384-dim, in-process via
-- Supabase.ai) to voyage-3 (1024-dim, external API via Voyage AI).
--
-- Rationale:
--   - voyage-3 outperforms gte-small on retrieval benchmarks (MTEB)
--   - Eliminates the 256MB WORKER_RESOURCE_LIMIT that capped RAG_BATCH_SIZE
--     at 3 (gte-small accumulates in-process state across .run() calls)
--   - Standardizes embedding model across Eric's RAG portfolio (voyage-3
--     is already used in discord_chat_memory + the civil rights project)
--
-- Migration plan:
--   1. NULL all existing embeddings (cannot ALTER vector(384) -> vector(1024)
--      with values populated)
--   2. Drop the HNSW index (it's tied to the 384-dim column)
--   3. ALTER the embedding column type to vector(1024)
--   4. Recreate the HNSW index for vector(1024)
--
-- During the migration window, rag-search will gracefully degrade to
-- tsvector keyword search via the match_rag_chunks RPC's text branch
-- (already implemented in the existing function body — defensive design).
--
-- Recovery path: re-ingest all 122 rows via the updated rag-ingest Edge
-- Function. Idempotent on (source_path, chunk_index) so re-running the
-- existing scripts/rag/ingest.mjs walker against the same SOURCES list
-- will repopulate the embeddings.
--
-- Apply via Supabase CLI: supabase db push
-- Or via Supabase MCP: apply_migration

BEGIN;

-- Step 1: null all existing embeddings so the column type change can proceed.
-- The HNSW index has a WHERE (embedding IS NOT NULL) predicate, so this
-- effectively empties the index in the same statement.
UPDATE public.rag_documents SET embedding = NULL;

-- Step 2: drop the HNSW index (tied to the column's dimension).
DROP INDEX IF EXISTS public.rag_documents_embedding_hnsw;

-- Step 3: change the column dimension from 384 to 1024.
ALTER TABLE public.rag_documents
  ALTER COLUMN embedding TYPE vector(1024);

-- Step 4: recreate the HNSW index for the new dimension with the same
-- tuning (m=16, ef_construction=64) and predicate (embedding IS NOT NULL).
CREATE INDEX rag_documents_embedding_hnsw
  ON public.rag_documents
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE (embedding IS NOT NULL);

-- Step 5: update the table comment so future schema readers know the
-- embedding column changed dimension + provider.
COMMENT ON TABLE public.rag_documents IS
  'Unified RAG knowledge store for the aigamma.com chat. Chunks of indexed prose from the per-page system prompts (netlify/functions/prompts/*.mjs derived from src/data/pages.js CHAT_PAGES), the always-present global blocks (core_persona, behavior, site_nav), and the cross-repo about.aigamma.com biographical HTML. CLAUDE.md and docs/ are NOT ingested (the table comment previously claimed they were; the walker in scripts/rag/ingest.mjs has never traversed them). Each row carries content + content_hash + tsvector + 1024-dim voyage-3 embedding (migrated from 384-dim gte-small on 2026-05-22) + JSONB metadata (surface, kind, title, headings). Read by rag-search Edge Function via match_rag_chunks + get_system_prompts RPCs; written by rag-ingest Edge Function from the scripts/rag/ingest.mjs walker. Re-ingest is idempotent on (source_path, chunk_index); unchanged chunks skip the embedding round-trip. Extend the SOURCES array in scripts/rag/ingest.mjs to add new indexed surfaces.';

COMMIT;
