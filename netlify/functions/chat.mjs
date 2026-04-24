// AI Gamma Dashboard Chat — Netlify Function (Streaming Proxy)
//
// Adapted from about.aigamma.com's chat function. The adaptations are: the
// system prompt surface (one per page — see ./prompts/, keyed by the
// `context` field the client sends in the POST body, with a default to the
// main dashboard prompt if the context is unknown or missing) and the
// trimmed tool surface (no document generation, no image uploads — the
// on-site chat is text-in / text-out). Model selection mirrors the about
// site's Quick/Deep tab pattern: Sonnet for fast under-load responses,
// Opus for deeper structural explanations. Everything else about the
// plumbing is byte-identical to the about-site proxy that has already
// survived production load for months — SSE passthrough to the browser,
// server-side parse of the same stream to watch for tool_use so we can run a
// follow-up turn when the model invokes web_fetch, five-round ceiling on the
// tool loop to bound cost, and pre-flight validation of model id and request
// body before the upstream fetch so we fail fast on malformed clients.
//
// Requires ANTHROPIC_API_KEY set as an environment variable in the Netlify
// dashboard for the aigamma site (Project Settings → Environment variables).
// This env var is NOT shared from about.aigamma.com; it has to be set on this
// project separately. Without it the function returns a 500 with a clear
// error message so the frontend can surface the state.

import mainPrompt from './prompts/main.mjs';
import garchPrompt from './prompts/garch.mjs';
import regimePrompt from './prompts/regime.mjs';
import roughPrompt from './prompts/rough.mjs';
import stochasticPrompt from './prompts/stochastic.mjs';
import localPrompt from './prompts/local.mjs';
import jumpPrompt from './prompts/jump.mjs';
import riskPrompt from './prompts/risk.mjs';
import discretePrompt from './prompts/discrete.mjs';
import parityPrompt from './prompts/parity.mjs';
import alphaPrompt from './prompts/alpha.mjs';
import betaPrompt from './prompts/beta.mjs';

import { CORE_PERSONA } from './prompts/core_persona.mjs';
import { BEHAVIORAL_CONSTRAINTS } from './prompts/behavior.mjs';
import { SITE_NAVIGATION_CONTEXT } from './prompts/site_nav.mjs';

// Per-page system prompt registry. Keyed by the `context` field the client
// sends in the POST body. The keys are short slugs that match the URL path
// segment of the page the chat is mounted on (main = landing page at /,
// garch = /garch/, regime = /regime/, rough = /rough/, stochastic =
// /stochastic/, local = /local/, jump = /jump/, risk = /risk/, discrete =
// /discrete/, parity = /parity/, alpha = /alpha/, beta = /beta/). Add a new
// key here and a new peer file in ./prompts/ when a new lab page wants its
// own chat voice. An unknown or missing key falls through to the main-
// dashboard prompt so a stale client that forgets to pass context still
// gets a coherent answer.
const SYSTEM_PROMPTS = {
  main: mainPrompt,
  garch: garchPrompt,
  regime: regimePrompt,
  rough: roughPrompt,
  stochastic: stochasticPrompt,
  local: localPrompt,
  jump: jumpPrompt,
  risk: riskPrompt,
  discrete: discretePrompt,
  parity: parityPrompt,
  alpha: alphaPrompt,
  beta: betaPrompt,
};

// Two-model config mirroring about.aigamma.com — Sonnet powers the default
// "Quick Analysis" tab (fast, affordable under arbitrary public load) and
// Opus powers the "Deep Analysis" tab (longer, structurally deeper responses
// for the math and philosophy questions this dashboard attracts). The max
// output tokens are aligned with the about-site values that have already
// survived months of production traffic: 128k for Opus, 64k for Sonnet.
// Both ids are confirmed accessible with the ANTHROPIC_API_KEY provisioned
// on this Netlify project — earlier attempts at 'claude-opus-4-7' returned
// upstream errors on this workspace, so 4.6 is the deepest tier pinned
// until 4.7 access is promoted.
const MODEL_CONFIG = {
  'claude-opus-4-6': { displayName: 'Claude Opus 4.6', maxTokens: 128000 },
  'claude-sonnet-4-6': { displayName: 'Claude Sonnet 4.6', maxTokens: 64000 }
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

// Tool surface is deliberately narrower than about.aigamma.com. The dashboard
// chat does not need a document generator (users can screenshot or copy) or
// image/PDF upload (questions are typed prose about math). Web search and
// web fetch are kept because dashboard questions frequently reference papers
// (Breeden and Litzenberger 1978, Gatheral's SVI notes, Heston 1993) or
// external references where a live lookup is cheaper than the model's
// training-data recollection.
const TOOLS = [
  {
    type: 'web_search_20250305',
    name: 'web_search'
  },
  {
    name: 'web_fetch',
    description: 'Fetch and read the text content of a web page at a specific URL. Use this when someone provides a URL and asks you to read, analyze, or summarize its contents. Do not use this for general information gathering; use web_search for that instead.',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The full URL to fetch, including the protocol (https://)'
        }
      },
      required: ['url']
    }
  }
];

const MAX_TOOL_ROUNDS = 5;

async function fetchUrl(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AIGammaBot/1.0; +https://aigamma.com)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000)
    });

    if (!res.ok) {
      return 'Failed to fetch URL: HTTP ' + res.status + ' ' + res.statusText;
    }

    const contentType = res.headers.get('content-type') || '';
    const isText = contentType.includes('text/') ||
                   contentType.includes('application/json') ||
                   contentType.includes('application/xml') ||
                   contentType.includes('application/javascript');

    if (!isText) {
      return 'Cannot read this content: the URL returned ' + contentType + ', which is not a text format.';
    }

    let text = await res.text();

    if (contentType.includes('text/html')) {
      text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
      text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
      text = text.replace(/<nav[\s\S]*?<\/nav>/gi, '');
      text = text.replace(/<footer[\s\S]*?<\/footer>/gi, '');
      text = text.replace(/<[^>]+>/g, ' ');
      text = text.replace(/&nbsp;/g, ' ');
      text = text.replace(/&amp;/g, '&');
      text = text.replace(/&lt;/g, '<');
      text = text.replace(/&gt;/g, '>');
      text = text.replace(/&#\d+;/g, '');
      text = text.replace(/\s+/g, ' ');
      text = text.trim();
    }

    if (text.length > 50000) {
      text = text.substring(0, 50000) + '\n\n[Content truncated at 50,000 characters]';
    }

    return text || 'The page returned no readable text content.';
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      return 'Failed to fetch URL: the request timed out after 10 seconds.';
    }
    return 'Failed to fetch URL: ' + e.message;
  }
}

async function executeTools(toolUseBlocks) {
  const results = [];
  for (const block of toolUseBlocks) {
    if (block.name === 'web_fetch') {
      const content = await fetchUrl(block.input.url);
      results.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: content
      });
    }
  }
  return results;
}

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const apiKey = Netlify.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: 'API key not configured.' }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: 'Invalid request body.' }),
      { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }

  const { message, history, model, context } = body;

  if (!message || typeof message !== 'string' || !message.trim()) {
    return new Response(
      JSON.stringify({ error: 'No message provided.' }),
      { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }

  // Default to Sonnet when the client omits a model id, matching the
  // default-active "Quick Analysis" tab in the React component. A missing
  // model id from the client is a signal of a stale or minimal caller and
  // Sonnet is the cheaper, faster path to fall back to.
  const resolvedModel = model || 'claude-sonnet-4-6';
  const config = MODEL_CONFIG[resolvedModel];
  if (!config) {
    return new Response(
      JSON.stringify({ error: 'Invalid model specified.' }),
      { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }

  // Resolve which per-page prompt to use. An unknown or missing context key
  // falls through to the main dashboard prompt so a stale or minimal client
  // that forgets to pass context still produces a coherent response.
  const rawTemplate = SYSTEM_PROMPTS[context] || SYSTEM_PROMPTS.main;
  const promptTemplate = [
    CORE_PERSONA,
    SITE_NAVIGATION_CONTEXT,
    rawTemplate,
    BEHAVIORAL_CONSTRAINTS
  ].join('\n\n');
  const systemPrompt = promptTemplate.replace(/MODEL_PLACEHOLDER/g, config.displayName);

  const initialMessages = [
    ...(Array.isArray(history) ? history : []),
    { role: 'user', content: message.trim() }
  ];

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      async function callAnthropicStreaming(apiMessages, round) {
        if (round > MAX_TOOL_ROUNDS) {
          controller.enqueue(encoder.encode(
            'data: ' + JSON.stringify({
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: '\n\n[Tool execution limit reached]' }
            }) + '\n\n'
          ));
          return;
        }

        let anthropicRes;
        try {
          anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
              model: resolvedModel,
              max_tokens: config.maxTokens,
              system: systemPrompt,
              messages: apiMessages,
              stream: true,
              tools: TOOLS
            })
          });
        } catch (err) {
          console.error('Anthropic network error:', err?.message || err);
          controller.enqueue(encoder.encode(
            'data: ' + JSON.stringify({
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'The AI is temporarily unavailable. Please try again in a moment, or reach eric@aigamma.com.' }
            }) + '\n\n'
          ));
          return;
        }

        if (!anthropicRes.ok) {
          let upstreamBody = '';
          try {
            upstreamBody = await anthropicRes.text();
          } catch { /* body already consumed or stream errored */ }
          console.error(
            'Anthropic upstream error: status=' + anthropicRes.status +
            ' model=' + resolvedModel +
            ' body=' + upstreamBody.substring(0, 500)
          );

          const status = anthropicRes.status;
          let errMsg = 'The AI is temporarily unavailable. Please try again in a moment, or reach eric@aigamma.com.';
          if (status === 429) errMsg = 'The AI is experiencing high demand. Please wait a moment and try again.';
          if (status === 529) errMsg = 'The AI is temporarily at capacity. Please try again in a few minutes.';
          controller.enqueue(encoder.encode(
            'data: ' + JSON.stringify({
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: errMsg }
            }) + '\n\n'
          ));
          return;
        }

        const reader = anthropicRes.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let assistantContent = [];
        let currentTextContent = '';
        let currentToolUse = null;
        let stopReason = null;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          controller.enqueue(value);

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data: ')) continue;
            const data = trimmed.slice(6);
            if (data === '[DONE]') continue;

            try {
              const event = JSON.parse(data);

              if (event.type === 'content_block_start') {
                if (event.content_block.type === 'text') {
                  currentTextContent = '';
                } else if (event.content_block.type === 'tool_use') {
                  currentToolUse = {
                    id: event.content_block.id,
                    name: event.content_block.name,
                    inputJson: ''
                  };
                }
              }

              if (event.type === 'content_block_delta') {
                if (event.delta.type === 'text_delta') {
                  currentTextContent += event.delta.text;
                } else if (event.delta.type === 'input_json_delta') {
                  if (currentToolUse) {
                    currentToolUse.inputJson += event.delta.partial_json;
                  }
                }
              }

              if (event.type === 'content_block_stop') {
                if (currentToolUse) {
                  let parsedInput = {};
                  try { parsedInput = JSON.parse(currentToolUse.inputJson); } catch (e) {}
                  assistantContent.push({
                    type: 'tool_use',
                    id: currentToolUse.id,
                    name: currentToolUse.name,
                    input: parsedInput
                  });
                  currentToolUse = null;
                } else if (currentTextContent) {
                  assistantContent.push({
                    type: 'text',
                    text: currentTextContent
                  });
                  currentTextContent = '';
                }
              }

              if (event.type === 'message_delta') {
                if (event.delta && event.delta.stop_reason) {
                  stopReason = event.delta.stop_reason;
                }
              }
            } catch (e) {}
          }
        }

        if (stopReason === 'tool_use') {
          const customToolBlocks = assistantContent.filter(
            b => b.type === 'tool_use' && b.name !== 'web_search'
          );

          if (customToolBlocks.length > 0) {
            const toolResults = await executeTools(customToolBlocks);

            const newMessages = [
              ...apiMessages,
              { role: 'assistant', content: assistantContent },
              { role: 'user', content: toolResults }
            ];

            await callAnthropicStreaming(newMessages, round + 1);
          }
        }
      }

      try {
        await callAnthropicStreaming(initialMessages, 1);
      } catch (err) {
        try {
          controller.enqueue(encoder.encode(
            'data: ' + JSON.stringify({
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'An unexpected error occurred. Please try again.' }
            }) + '\n\n'
          ));
        } catch (e) {}
      } finally {
        try { controller.close(); } catch (e) {}
      }
    }
  });

  return new Response(stream, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    }
  });
};

export const config = {
  path: '/api/chat',
  method: ['POST', 'OPTIONS']
};
