// rag-search — Supabase Edge Function (voyage-3 migration, 2026-05-22).
//
// Embeds the user's query via Voyage AI (voyage-3, 1024-dim, input_type='query'),
// then returns two parallel retrieval results:
//   1. Always-pinned system prompts for the active surface (per-page persona
//      blocks + global core_persona / behavior / site_nav)
//   2. Similarity-ranked chunks from the broader corpus
//
// The Netlify chat function calls this once per turn, splices the returned
// context into its system prompt, and forwards to Anthropic.
//
// CHANGED FROM PREVIOUS VERSION:
// - Replaced Supabase.ai.Session('gte-small') in-process inference with
//   external Voyage API calls.
// - Query embedding is now 1024-dim (was 384). Schema migration applied
//   separately (see supabase/migrations/20260522_voyage_3_migration.sql).
// - Voyage uses input_type='query' for retrieval-side embeddings (different
//   model head than 'document'; using the wrong one degrades retrieval).
// - Graceful degradation preserved: if Voyage call fails (network error,
//   missing API key, rate limit), the function falls back to tsvector
//   keyword search via the same match_rag_chunks RPC's text fallback.
// - Added VOYAGE_API_KEY env var; missing key triggers the tsvector fallback
//   rather than a hard error, so search keeps working in degraded mode.
//
// The function is public (verify_jwt: false) because the React chat component
// on aigamma.com hits it without an auth token. Per-IP rate limit at 30/min
// via the same check_rate_limit RPC the Netlify chat function uses.
//
// Wire format (UNCHANGED from previous version):
//   POST { query: string, surface?: string, top_k?: number }
//   200 { system_prompts: [...], chunks: [...], embedding_used: boolean,
//         embedding_error: string | null, surface }
//   429 { error: 'rate_limited', retry_in_seconds }
//   400 { error: 'missing_query' | 'invalid_body' }
//
// Required Edge Function secrets:
//   VOYAGE_API_KEY        — Voyage AI API key. If missing, the function
//                           falls back to tsvector search (degraded mode).
//   SUPABASE_URL          — auto-injected
//   SUPABASE_SERVICE_ROLE_KEY — auto-injected

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const VOYAGE_API_KEY = Deno.env.get('VOYAGE_API_KEY');
const VOYAGE_MODEL = Deno.env.get('VOYAGE_MODEL') ?? 'voyage-3';

const VOYAGE_EMBED_ENDPOINT = 'https://api.voyageai.com/v1/embeddings';
const EXPECTED_DIM = 1024;

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

const RATE_LIMIT_PER_MINUTE = 30;

function jsonResponse(body: unknown, status: number, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', ...extraHeaders },
  });
}

function extractClientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  const cf = req.headers.get('cf-connecting-ip');
  if (cf) return cf;
  return 'unknown';
}

async function voyageEmbedQuery(text: string): Promise<number[]> {
  const res = await fetch(VOYAGE_EMBED_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({
      input: [text],
      model: VOYAGE_MODEL,
      input_type: 'query',
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`voyage_embed_failed status=${res.status} body=${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const embedding = data?.data?.[0]?.embedding;
  if (!embedding) throw new Error('voyage_response_missing_embedding');
  return embedding;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method_not_allowed' }, 405);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const clientIp = extractClientIp(req);

  try {
    const { data: rateLimit, error } = await supabase.rpc('check_rate_limit', {
      p_client_ip: clientIp,
      p_endpoint: 'rag-search',
      p_max_per_minute: RATE_LIMIT_PER_MINUTE,
    });
    if (!error && rateLimit && rateLimit.allowed === false) {
      const retry = rateLimit.reset_in_seconds ?? 60;
      return jsonResponse(
        {
          error: 'rate_limited',
          retry_in_seconds: retry,
          limit: rateLimit.limit,
          count: rateLimit.count,
        },
        429,
        { 'Retry-After': String(retry) },
      );
    }
  } catch (e) {
    console.error('rate_limit_check_failed', e);
  }

  let body: { query?: string; surface?: string; top_k?: number };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'invalid_body' }, 400);
  }

  const query = (body.query ?? '').toString().trim();
  const surface = body.surface ? String(body.surface) : null;
  const topK = Math.min(Math.max(Number(body.top_k) || 6, 1), 20);

  if (!query) {
    return jsonResponse({ error: 'missing_query' }, 400);
  }

  // Embed the query via Voyage. If the API key is missing or the call fails,
  // fall back to tsvector keyword search via match_rag_chunks's text branch.
  let queryEmbedding: number[] | null = null;
  let embedErr: string | null = null;
  if (!VOYAGE_API_KEY) {
    embedErr = 'voyage_api_key_missing';
  } else {
    try {
      queryEmbedding = await voyageEmbedQuery(query);
      if (queryEmbedding.length !== EXPECTED_DIM) {
        console.warn('unexpected_embedding_length', queryEmbedding.length);
        embedErr = `unexpected_dim_${queryEmbedding.length}`;
        queryEmbedding = null;
      }
    } catch (e) {
      embedErr = (e as Error)?.message ?? 'embed_failed';
      console.error('voyage_embed_failed_falling_back_to_tsvector', embedErr);
    }
  }

  const [promptsResult, chunksResult] = await Promise.all([
    surface
      ? supabase.rpc('get_system_prompts', { p_surface: surface })
      : Promise.resolve({ data: [], error: null } as { data: unknown[]; error: null }),
    supabase.rpc('match_rag_chunks', {
      p_query_embedding: queryEmbedding,
      p_query_text: queryEmbedding ? null : query,
      p_match_count: topK,
    }),
  ]);

  if (promptsResult.error) {
    console.error('get_system_prompts_error', promptsResult.error);
  }
  if (chunksResult.error) {
    console.error('match_rag_chunks_error', chunksResult.error);
  }

  return jsonResponse(
    {
      system_prompts: promptsResult.data ?? [],
      chunks: chunksResult.data ?? [],
      embedding_used: queryEmbedding !== null,
      embedding_error: embedErr,
      surface,
      top_k: topK,
      model: queryEmbedding !== null ? VOYAGE_MODEL : null,
    },
    200,
  );
});
