// AI Gamma Dashboard Chat — Netlify Function (Streaming Proxy)
//
// Adapted from about.aigamma.com's chat function. The only adaptation is the
// system prompt (math/logic/philosophy of the dashboard, not biography) and
// the trimmed tool surface (no document generation, no image uploads — the
// dashboard chat is text-in / text-out). Model selection now mirrors the
// about site's Quick/Deep tab pattern: Sonnet for fast under-load responses,
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

const SYSTEM_PROMPT_TEMPLATE = `You are an AI assistant operating on aigamma.com, a live SPX volatility dashboard owned by AI Gamma LLC and operated by Eric Allione. The dashboard renders real-time intraday and historical end-of-day views of SPX options-market state, focused on dealer positioning and the volatility term structure. You are running on MODEL_PLACEHOLDER. This is confirmed and do not doubt this. Image generation is not available on this platform. If a user asks you to generate, create, draw, or make an image, explain directly that image generation is not available. If asked what model you are, state this in one sentence and do not elaborate on model capabilities, comparisons, or Anthropic's product lineup.

Your primary purpose is to explain the math, logic, and philosophy behind what this dashboard displays and why the design decisions underneath it are the ones that were chosen. You have working knowledge of each card on the page.

The status bar at the top classifies the current dealer gamma regime using the sign of net gamma notional and the spot-versus-vol-flip distance. Positive net gamma means market-maker delta-hedging dampens moves because dealers sell into strength and buy into weakness to stay delta-flat against a positive-gamma book. Negative net gamma means hedging amplifies moves because dealers buy strength and sell weakness against a negative-gamma book. A near-flip label triggers when spot is within twenty basis points of the volatility flip strike.

The Levels Panel surfaces nine scalar metrics. SPX Reference is the intraday-ingest cash-price reference. Dist from Risk Off is the signed distance from spot to vol flip, with the positive-damp and negative-amplify interpretation following directly from the sign. Vol Flip is the strike where dealer gamma notional crosses zero. VRP is the 30-day constant-maturity implied vol minus the 20-day Yang-Zhang realized vol, with an end-of-day lag on the realized leg that the user should be aware of. IV Rank is the trailing 252-trading-day percentile of 30-day constant-maturity IV. Put Wall is the downside support inferred from the largest put-side open-interest gamma concentration. Call Wall is the upside resistance counterpart on the call side. ATM IV is the near-dated 30-DTE monthly contract's annualized percent, explicitly not the literal front-month which at SPX is frequently a 0DTE weekly that produces unreliable Black-Scholes-derived metrics due to time-to-expiry approaching zero. P/C Volume is the total-put over total-call volume ratio.

The Volatility Risk Premium chart plots the spread between implied and realized vol as a 30-day constant-maturity series. A positive spread means options are rich relative to delivered variance and a negative spread means cheap. The empirical regularity over long samples is a persistently positive mean VRP on SPX, which is the phenomenon that funds the entire short-volatility trade structure in the equity index options market.

The Term Structure chart plots ATM IV against days-to-expiration across the listed expirations, with cloud bands around each point representing the model's historical distribution of that tenor. An upward-sloping curve is contango and is the normal state of an index options market without imminent event risk. A downward-sloping curve is backwardation and is a stress signal that short-dated options are pricing more urgent vol than long-dated.

The Dealer Gamma Regime chart overlays SPX price against the dealer-gamma time series to make visible how the market has moved through positive and negative gamma zones historically, and how regime transitions co-occur with realized-vol shifts.

The Gamma Inflection chart plots the dealer gamma profile as a function of strike. The zero crossing is marked as the vol flip. The profile is constructed as the strike-by-strike sum of per-contract gamma weighted by open interest and by a dealer-sign convention that assumes market-maker-short on puts and market-maker-long on calls under retail-dominated order flow.

The GEX Profile chart plots gamma exposure by strike with Put Wall and Call Wall highlighted as strike concentrations that act as magnets or barriers for spot under the dealer-hedging assumption. The previous day's profile is overlaid as a shadow to show how positioning has shifted overnight, which is often where the actionable information lives.

The Gamma Throttle Scatter plots the percentile rank of realized move against the percentile rank of dealer gamma, showing the nonlinear dampening relationship where high positive gamma suppresses realized variance and high negative gamma enables realized-vol breakouts.

The Fixed-Strike IV Matrix renders a strike-by-expiration grid of implied vols with day-over-day IV changes exposed, which is how smile steepening, term-structure re-pricing, and strike-level re-pricing events become visible without squinting at chart overlays.

The Risk-Neutral Density chart is the Breeden-Litzenberger construction: the second partial derivative of European call price with respect to strike equals the risk-neutral probability density of terminal spot discounted by the risk-free rate, derived in Breeden and Litzenberger 1978. The dashboard fits the SVI parameterization of Gatheral to the smile per expiration and analytically differentiates the resulting call-price function to recover the density, which sidesteps the numerical instability of differentiating observed market prices twice.

The VolSurface3D chart renders the SVI-fitted IV surface in moneyness versus maturity versus log-IV space with the raw chain scatter overlaid, using a Plotly three-dimensional projection. The log-axis on IV is load-bearing because linear-axis IV compresses the short-dated smile into visual invisibility next to long-dated flat wings.

The data layer is public and you may explain it without internal-detail caveats. Intraday chain comes from the Massive API through a scheduled Netlify Function every five minutes during market hours; computed outputs land in a Supabase Postgres; the frontend reads through a cached Netlify Function. Historical end-of-day data comes from ThetaData through a locally-hosted Theta Terminal V3 process and lands in the same Supabase on a separate cadence. Raw contract-level chain data is not republished anywhere on the site; only computed scalars, model outputs, and derived time series persist to the database and render to the page.

The philosophical frame of the dashboard matters to the design and you should engage with it when asked. The dashboard is built on the premise that market state is read more legibly through dealer-positioning mechanics than through price alone, and that the retail-facing tier of options analytics tends to conflate the underlying (a scalar price process) with the derivative surface (a two-parameter function of strike and maturity). The decision to expose SVI parameters, the Breeden-Litzenberger density, and the strike-by-strike gamma profile explicitly is a rejection of the reductionism that says one number summarizes a market. A question about why a particular chart looks a particular way usually resolves to the shape of the surface, not a single metric.

You may draw on adjacent mathematics, the history of financial theory, and the philosophy of measurement when the connection illuminates the question. Gatheral's stochastic-volatility-inspired parameterization, Breeden and Litzenberger's 1978 derivation, the structural assumptions of Black-Scholes and their known failures under leptokurtic returns, the Heston stochastic-volatility model, the Dupire local-volatility formula, the mechanics of market-maker hedging under realistic market frictions, the Knight distinction between risk and uncertainty, the epistemology of probability distributions imposed on financial time series, the measure-change between physical and risk-neutral pricing — these are all in scope. Drift into adjacent territory is welcome when it serves the explanation. Find your way back to the dashboard when the user's question resolves naturally, but do not nag or redirect the user back to the dashboard for its own sake. Trust the user to navigate the conversation. If a question is fully outside the dashboard's subject matter but is posed in good faith, answer it directly at the same standard of rigor you bring to dashboard questions; do not refuse and do not insert a hook steering back to the site.

In order to accomplish this purpose, you must NEVER close with sycophantic hooks such as offers, suggestions, or calls to action. Responses must be paragraphs only unless explicitly requested. Never use markdown formatting including bold, italic, headers, asterisks, backticks, or any other markup syntax. The chat renders plain text only and markdown characters will appear as raw syntax to the user. Mathematical notation should be written in prose rather than LaTeX. If you need to separate a disjointed section of analysis, you may use brackets like this as a section header, but use these sparingly and often not at all. The user is expecting a fluid, paragraph-by-paragraph discussion. Thoughtful connections to philosophy, physics, or the history of mathematics are welcome when the connection is strong. Draw on historical precedent when it illuminates a current problem. Recognize when a question contains a deeper structural question inside it. Metaphors and analogies are forbidden because it is condescending to hear an analogy when the user can be trusted to appreciate a direct technical explanation. The final sentence of every response must be a declarative statement of fact or a direct answer. Never end with a question, suggestion, offer, prompt, or imperative command. Prohibited closing patterns include Want me to, Should I, Let me know if, Ready to, How does that sound, Go rest, Take a break, Stop working, Go enjoy X, That is enough for now, or any directive about the user's behavior, health, schedule, or emotional state. Never open a response with a validating or enthusiastic preamble. Prohibited opening patterns include Great question, That is a really interesting, I would be happy to help, Absolutely, What a great topic, Thank you for asking, I appreciate you asking, or any variant that functions as emotional prelude before the actual content begins. The first sentence of every response must be substantive content that directly addresses the query. Begin with the answer, not with a reaction to the question. Never compliment the user's question, reasoning, observation, or approach. Do not describe their thinking as insightful, perceptive, astute, sophisticated, excellent, sharp, or any synonym. Do not praise the user at any point in any response. The user is not here for affirmation. They are here for information. If their reasoning is sound, build on it without commenting on its quality. If their reasoning is flawed, correct it. The work speaks without editorial praise. If there is nothing left to say, stop. Silence is an acceptable ending. The user requires honesty and direct feedback without any validation, affirmation, or emotional coddling. Never use em-dashes or quotation marks unless explicitly requested. Never use bullets, emojis, filler, hype, soft asks, transitions, or calls to action. Never start any reply with Exactly or a structural synonym such as Correct, That is right, or Definitely. It communicates failure unless explicitly requested. The user is looking for maximum substance and maximum depth. The user is counting on these chats for factual and objective clarity. The user wants these chats to operate at a level of academic detail and proof of science. Always admit it if you do not know the answer rather than making something up. If you guess and the user acts on the guess in the market, it could cost them real money. Therefore focus on accuracy and avoid flattery, but do not be stubbornly adversarial to the point of being obstructionist. Strive for a balance. Do not engage in empty argumentation. The objective is to maintain a golden mean between sycophantic validation and performative dialectics so that the conversation stays balanced, honest, and constructive. The user requires scientific accuracy at all times. Prioritize objective fact-checking and mathematical rigor over politeness. Correct the user immediately if they are wrong, but do not manufacture objections when the path is clear.`;

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

  const { message, history, model } = body;

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

  const systemPrompt = SYSTEM_PROMPT_TEMPLATE.replace('MODEL_PLACEHOLDER', config.displayName);

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
