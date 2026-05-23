#!/usr/bin/env node
// scripts/rag/reembed.mjs
//
// One-time migration helper: re-embeds all existing rows in public.rag_documents
// using Voyage AI voyage-3 (1024-dim), following the schema migration applied
// 2026-05-22 that changed the embedding column from vector(384) to vector(1024).
//
// Reads each row's content, batches into 32-row Voyage embed calls, and
// UPDATEs the embedding column. Skips rows where embedding is already populated
// so re-runs only fill in the missing rows.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... VOYAGE_API_KEY=... node scripts/rag/reembed.mjs
//   node --env-file=.env.local scripts/rag/reembed.mjs   # if .env.local includes all three
//
// Env vars (required):
//   SUPABASE_URL          — https://<project-ref>.supabase.co
//   SUPABASE_SERVICE_KEY  — the service-role JWT (bypasses RLS)
//   VOYAGE_API_KEY        — Voyage AI API key
//
// Env vars (optional):
//   VOYAGE_MODEL          — defaults to 'voyage-3'
//   BATCH_SIZE            — Voyage embed batch size, defaults to 32

import process from 'node:process';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY;
const VOYAGE_MODEL = process.env.VOYAGE_MODEL || 'voyage-3';
const BATCH_SIZE = Math.min(Math.max(Number(process.env.BATCH_SIZE) || 32, 1), 128);

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY');
  process.exit(1);
}
if (!VOYAGE_API_KEY) {
  console.error('Missing VOYAGE_API_KEY');
  process.exit(1);
}

const VOYAGE_ENDPOINT = 'https://api.voyageai.com/v1/embeddings';

async function voyageEmbed(texts) {
  const res = await fetch(VOYAGE_ENDPOINT, {
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
    throw new Error(`voyage embed failed status=${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.data.map((d) => d.embedding);
}

async function supabaseRest(method, path, body = null) {
  const url = `${SUPABASE_URL}/rest/v1${path}`;
  const headers = {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`supabase ${method} ${path} status=${res.status}: ${await res.text()}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function fetchPendingRows() {
  // Pull all rows where embedding is NULL (the migration nulled everything).
  // PostgREST's `is.null` filter for vector columns works on the NULL/NOT NULL state.
  // Select only id + content to keep payloads small.
  return supabaseRest(
    'GET',
    '/rag_documents?select=id,content&embedding=is.null&order=id.asc',
  );
}

async function updateEmbedding(id, embedding) {
  // PostgREST pgvector serialization: pass embedding as a JSON array; the
  // server-side cast to vector() handles the dimension.
  await supabaseRest('PATCH', `/rag_documents?id=eq.${id}`, { embedding });
}

async function main() {
  console.log(`[reembed] supabase=${SUPABASE_URL}`);
  console.log(`[reembed] voyage_model=${VOYAGE_MODEL} batch=${BATCH_SIZE}`);

  const pending = await fetchPendingRows();
  console.log(`[reembed] ${pending.length} rows need embeddings`);

  if (pending.length === 0) {
    console.log('[reembed] nothing to do');
    return;
  }

  let processed = 0;
  let failed = 0;
  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const batch = pending.slice(i, i + BATCH_SIZE);
    const texts = batch.map((r) => r.content);
    let embeddings;
    try {
      embeddings = await voyageEmbed(texts);
    } catch (e) {
      console.error(`[reembed] batch ${i}-${i + batch.length} failed: ${e.message}`);
      failed += batch.length;
      continue;
    }
    if (embeddings.length !== batch.length) {
      console.error(
        `[reembed] batch ${i}-${i + batch.length} mismatch: ${embeddings.length} embeddings for ${batch.length} inputs`,
      );
      failed += batch.length;
      continue;
    }
    // Update each row's embedding. Sequential to avoid PostgREST connection
    // pool pressure; for 122 rows this is fast enough.
    for (let j = 0; j < batch.length; j++) {
      try {
        await updateEmbedding(batch[j].id, embeddings[j]);
        processed += 1;
      } catch (e) {
        console.error(`[reembed] update id=${batch[j].id} failed: ${e.message}`);
        failed += 1;
      }
    }
    console.log(`[reembed] processed ${processed}/${pending.length}`);
  }

  console.log(`[reembed] done — ${processed} updated, ${failed} failed`);
}

main().catch((e) => {
  console.error('[reembed] fatal:', e.stack || e.message);
  process.exit(1);
});
