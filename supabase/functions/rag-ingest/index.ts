// rag-ingest — Supabase Edge Function (voyage-3 migration, 2026-05-22).
//
// Receives a batch of pre-chunked documents from scripts/rag/ingest.mjs,
// embeds each chunk by calling Voyage AI's /v1/embeddings endpoint
// (voyage-3, 1024-dim, input_type='document'), and upserts the rows into
// public.rag_documents keyed on (source_path, chunk_index).
//
// CHANGED FROM PREVIOUS VERSION:
// - Replaced Supabase.ai.Session('gte-small') in-process inference with
//   external Voyage API calls. This eliminates the 256MB WORKER_RESOURCE_LIMIT
//   that capped RAG_BATCH_SIZE at 3, and lifts embedding quality to voyage-3
//   (1024-dim, top MTEB retrieval).
// - Embedding dimension is now 1024 (was 384). Schema migration applied
//   separately (see supabase/migrations/20260522_voyage_3_migration.sql).
// - Voyage API supports batches up to 128 inputs; we batch at 32 per request
//   to keep latency predictable and stay well under per-request timeouts.
// - Added VOYAGE_API_KEY required env var; the function returns 500 with a
//   clear error if it's missing.
//
// Auth: verify_jwt is true at the platform layer; we additionally require
// role === 'service_role' on the verified JWT.
//
// Wire format (UNCHANGED from previous version, caller doesn't need updates):
//   POST { docs: [{ source_path, chunk_index, content, content_hash, metadata, token_estimate? }, ...] }
//   Authorization: Bearer <SUPABASE_SERVICE_KEY JWT>
//   200 { upserted, skipped, embed_failures }
//   401 { error: 'no_auth' | 'malformed_jwt' }
//   403 { error: 'wrong_role', role }
//   400 { error: 'invalid_body' | 'missing_docs' | 'batch_too_large' }
//   500 { error: 'voyage_api_key_missing' | 'all_embeds_failed' | 'upsert_failed' }
//
// Required Edge Function secrets (set via Supabase dashboard or CLI):
//   VOYAGE_API_KEY        — Voyage AI API key from https://dash.voyageai.com/
//   SUPABASE_URL          — auto-injected
//   SUPABASE_SERVICE_ROLE_KEY — auto-injected

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const VOYAGE_API_KEY = Deno.env.get('VOYAGE_API_KEY');
const VOYAGE_MODEL = Deno.env.get('VOYAGE_MODEL') ?? 'voyage-3';

const VOYAGE_EMBED_ENDPOINT = 'https://api.voyageai.com/v1/embeddings';
const VOYAGE_BATCH = 32;

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

interface IngestDoc {
  source_path: string;
  chunk_index: number;
  content: string;
  content_hash: string;
  metadata?: Record<string, unknown>;
  token_estimate?: number | null;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payload + '='.repeat((4 - payload.length % 4) % 4);
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

async function voyageEmbedBatch(texts: string[]): Promise<number[][]> {
  const res = await fetch(VOYAGE_EMBED_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({
      input: texts,
      model: VOYAGE_MODEL,
      input_type: 'document',
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`voyage_embed_failed status=${res.status} body=${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return (data?.data || []).map((item: { embedding: number[] }) => item.embedding);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method_not_allowed' }, 405);
  }

  if (!VOYAGE_API_KEY) {
    return jsonResponse({ error: 'voyage_api_key_missing' }, 500);
  }

  // Gateway verified the JWT signature; we additionally enforce role.
  const authHeader = req.headers.get('Authorization');
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
    return jsonResponse({ error: 'no_auth' }, 401);
  }
  const token = authHeader.slice(7).trim();
  const payload = decodeJwtPayload(token);
  if (!payload) {
    return jsonResponse({ error: 'malformed_jwt' }, 401);
  }
  if (payload.role !== 'service_role') {
    return jsonResponse({ error: 'wrong_role', role: payload.role }, 403);
  }

  let body: { docs?: IngestDoc[] };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'invalid_body' }, 400);
  }

  const docs = Array.isArray(body.docs) ? body.docs : [];
  if (docs.length === 0) {
    return jsonResponse({ error: 'missing_docs' }, 400);
  }
  if (docs.length > 200) {
    return jsonResponse({ error: 'batch_too_large', max: 200 }, 400);
  }

  // Filter valid docs and remember their original positions.
  const validDocs: IngestDoc[] = [];
  let skipped = 0;
  for (const d of docs) {
    if (!d.content || !d.source_path || typeof d.chunk_index !== 'number') {
      skipped += 1;
      continue;
    }
    validDocs.push(d);
  }

  if (validDocs.length === 0) {
    return jsonResponse(
      { upserted: 0, skipped, embed_failures: 0, error: 'no_valid_docs' },
      400,
    );
  }

  // Embed in batches of VOYAGE_BATCH. Voyage handles much larger batches
  // than gte-small could (no in-process memory ceiling).
  const embeddings: (number[] | null)[] = new Array(validDocs.length).fill(null);
  let embedFailures = 0;
  for (let i = 0; i < validDocs.length; i += VOYAGE_BATCH) {
    const batch = validDocs.slice(i, i + VOYAGE_BATCH);
    try {
      const batchEmbeddings = await voyageEmbedBatch(batch.map((d) => d.content));
      if (batchEmbeddings.length !== batch.length) {
        throw new Error(
          `voyage returned ${batchEmbeddings.length} embeddings for ${batch.length} inputs`,
        );
      }
      for (let j = 0; j < batch.length; j++) {
        embeddings[i + j] = batchEmbeddings[j];
      }
    } catch (e) {
      embedFailures += batch.length;
      console.error('voyage_embed_batch_failed', {
        batch_start: i,
        batch_size: batch.length,
        error: (e as Error)?.message,
      });
    }
  }

  const rows = validDocs
    .map((d, idx) => {
      const embedding = embeddings[idx];
      if (embedding === null) return null;
      return {
        source_path: d.source_path,
        chunk_index: d.chunk_index,
        content: d.content,
        content_hash: d.content_hash,
        embedding,
        metadata: d.metadata ?? {},
        token_estimate: d.token_estimate ?? null,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  if (rows.length === 0) {
    return jsonResponse(
      { upserted: 0, skipped, embed_failures: embedFailures, error: 'all_embeds_failed' },
      500,
    );
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { error } = await supabase
    .from('rag_documents')
    .upsert(rows, { onConflict: 'source_path,chunk_index' });

  if (error) {
    console.error('upsert_failed', error);
    return jsonResponse({ error: 'upsert_failed', detail: error.message }, 500);
  }

  return jsonResponse(
    {
      upserted: rows.length,
      skipped,
      embed_failures: embedFailures,
      model: VOYAGE_MODEL,
      dim: rows[0].embedding.length,
    },
    200,
  );
});
