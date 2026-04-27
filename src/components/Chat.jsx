import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

// Interactive chat bound to /api/chat (the Netlify Function proxy to
// Anthropic's streaming messages endpoint). Two tabs — Quick Analysis
// (Sonnet 4.6) and Deep Analysis (Opus 4.6) — mirror about.aigamma.com's
// chat affordance so the shared design language carries across the
// property. Quick is the default because for a public chat exposed on a
// live dashboard, Sonnet is the faster and cheaper path under arbitrary
// load; Opus is reserved for the user who has already engaged the chat
// and wants a longer, structurally deeper response on the math. The
// proxy injects a per-page system prompt server side, keyed by the
// `context` prop / POST field; this component never sees the prompt or
// the API key. It just speaks the wire format: POST { message, history,
// model, context } → SSE stream of content_block_delta events. Per-tab
// message lists and histories are held in local state and a ref
// respectively so a user can hop between tabs without losing either
// conversation.
//
// The component is designed to be mounted at the bottom of any directory
// on aigamma.com. The `context` prop selects which server-side system
// prompt the proxy uses; when omitted, it is inferred from the first
// path segment of window.location.pathname (so `/garch/` → `garch`, `/`
// → `main`). The `welcome` and `glowRgb` props override the default copy
// and accent colors for per-page customization — most pages will accept
// the defaults.
//
// Tab-switching is blocked while a response is streaming to prevent
// interleaved completion into the wrong tab; once loading settles, the
// user can switch freely. The glow accent around the input field is
// driven by a CSS custom property (--glow-rgb) set on the card root, so
// switching tabs re-paints the ambient animation without a re-render of
// the input itself.

const CHAT_ENDPOINT = '/api/chat';

const MODELS = {
  quick: 'claude-sonnet-4-6',
  deep: 'claude-opus-4-6',
};

// RGB triplets for the --glow-rgb CSS variable that drives the input
// border, the keyframe animation, and the focus ring. Warm yellow for
// Quick (matches about.aigamma.com's Sonnet accent), site-accent blue
// for Deep.
const DEFAULT_GLOW_RGB = {
  quick: '240, 192, 64',
  deep: '74, 158, 255',
};

const DEFAULT_WELCOME = {
  quick: 'What about this site would you like to explore?',
  deep:
    'Deep Analysis mode: responses are longer and explore the dashboard with greater structural depth and connective range across the underlying theory.',
};

// Infer the context slug from the URL when the host page does not pass
// one explicitly. `/` → 'main', `/garch/` → 'garch', `/dev/foo` → 'dev'.
// Anything unknown still falls through cleanly because the server-side
// dispatch defaults to the main prompt for unknown keys.
function inferContext() {
  if (typeof window === 'undefined') return 'main';
  const seg = window.location.pathname.split('/').filter(Boolean)[0];
  return seg || 'main';
}

export default function Chat({ context, welcome, glowRgb } = {}) {
  const resolvedContext = context || inferContext();
  const mergedWelcome = { ...DEFAULT_WELCOME, ...(welcome || {}) };
  const mergedGlowRgb = { ...DEFAULT_GLOW_RGB, ...(glowRgb || {}) };
  const [activeTab, setActiveTab] = useState('quick');
  const [messages, setMessages] = useState({ quick: [], deep: [] });
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const historyRef = useRef({ quick: [], deep: [] });
  const bodyRef = useRef(null);
  const textareaRef = useRef(null);
  // assistantRef pairs the in-flight assistant message with its tab via a
  // monotonic id so streamed deltas can be applied even though React 18+
  // batches the setMessages updater and runs it after the surrounding
  // event handler has already returned. The earlier index-based pairing
  // closed over a `let` that the updater mutated, but the next-line read
  // saw the pre-update value (null) because the updater hadn't run yet,
  // and every SSE delta then no-op'd against `ref.index == null`. Using
  // an id generated *before* setMessages and stored on the message itself
  // sidesteps the timing entirely — the id exists synchronously, and
  // applyAssistantText finds the placeholder by scanning for the id.
  const assistantRef = useRef(null);
  const pendingIdRef = useRef(0);
  // Bottom spacer height, sized on each new turn to guarantee the latest
  // user prompt can be scrolled to the top of the chat body even when the
  // assistant response is still empty or very short. Without it, a short
  // response would leave scrollHeight < clientHeight + userMsg.offsetTop
  // and scrollTop would clamp, so the prompt could not reach the top.
  const [spacerHeight, setSpacerHeight] = useState(0);
  // User prompts are clamped to three lines by default so the response has
  // room to grow below — expandedIds tracks per-id overrides where the user
  // has clicked "Show more", and overflowIds tracks which bubbles actually
  // have content beyond the clamp (so we only render the toggle when it does
  // something). Both sets are keyed by message id (see pendingIdRef).
  const [expandedIds, setExpandedIds] = useState(() => new Set());
  const [overflowIds, setOverflowIds] = useState(() => new Set());
  const bubbleRefs = useRef(new Map());

  // Anchor the most recent user prompt to the top of the chat body on each
  // *new turn* — i.e., whenever messages[activeTab].length changes (send
  // adds two entries: the user message and the pending assistant placeholder).
  // Streaming deltas mutate the existing assistant entry's text in place
  // without changing array length, so this effect intentionally does not fire
  // during streaming. Replaces a prior scrollToBottom call that ran on every
  // messages change and dragged the viewport down with each token — the
  // "jitter" the UX was suffering from. Now the prompt stays pinned and the
  // user scrolls down only when they want to follow the stream.
  const turnKey = messages[activeTab].length;
  useEffect(() => {
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      const el = bodyRef.current;
      if (!el) return;

      if (turnKey === 0) {
        setSpacerHeight(0);
        return;
      }

      const userMsgEls = el.querySelectorAll('.chat-msg-user');
      const lastUserEl = userMsgEls[userMsgEls.length - 1];
      if (!lastUserEl) {
        setSpacerHeight(0);
        return;
      }

      setSpacerHeight(Math.max(0, el.clientHeight - lastUserEl.offsetHeight - 16));

      raf2 = requestAnimationFrame(() => {
        // Scroll the *page* so the chat card sits at the top of the viewport,
        // covering whatever dashboard content was visible before the send;
        // then scroll the chat body internally so the latest user prompt
        // anchors at the top of the (now viewport-sized) card. The two
        // scrolls are independent (window vs .chat-body) so both are needed.
        const cardEl = el.closest('.chat-card');
        if (cardEl) cardEl.scrollIntoView({ block: 'start', behavior: 'smooth' });
        // Compute the internal-scroll delta from viewport rects rather than
        // `offsetTop`, because `.chat-body` has no `position: relative` and
        // offsetParent therefore walks up to <body> — giving a value in
        // document coords that doesn't match scrollTop's chat-body-local
        // coord system. Bounding rects are viewport-relative for both, so
        // the delta is correct regardless of where the card sits in the page.
        const bodyRect = el.getBoundingClientRect();
        const userRect = lastUserEl.getBoundingClientRect();
        el.scrollTop += (userRect.top - bodyRect.top) - 8;
      });
    });

    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [turnKey, activeTab]);

  // Measure each user bubble to decide whether the "Show more" toggle is
  // needed. A bubble is "overflowing" iff its scrollHeight exceeds its
  // clamped clientHeight — the CSS class `chat-msg-bubble-clamped` caps
  // height to three lines, so an unexpanded bubble reports its natural
  // (pre-clip) scrollHeight, which makes the comparison meaningful. When
  // expanded, clientHeight == scrollHeight (no clamp), so we can't detect
  // overflow from the DOM; we preserve the prior flag for any message id
  // that still exists in state (across both tabs) so expansion and tab
  // switching don't orphan the toggle.
  useLayoutEffect(() => {
    setOverflowIds((prev) => {
      const liveIds = new Set();
      for (const tab of Object.keys(messages)) {
        for (const m of messages[tab]) {
          if (m.id != null) liveIds.add(m.id);
        }
      }
      const next = new Set();
      for (const id of prev) {
        if (liveIds.has(id)) next.add(id);
      }
      bubbleRefs.current.forEach((el, id) => {
        if (!el || expandedIds.has(id)) return;
        if (el.scrollHeight > el.clientHeight + 1) next.add(id);
      });
      if (next.size !== prev.size) return next;
      for (const id of next) if (!prev.has(id)) return next;
      return prev;
    });
  }, [messages, activeTab, expandedIds]);

  const setBubbleRef = useCallback((id) => (el) => {
    if (el) bubbleRefs.current.set(id, el);
    else bubbleRefs.current.delete(id);
  }, []);

  const toggleExpand = useCallback((id) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    // After the expansion/collapse commits, re-anchor the toggled message to
    // the top of the chat body — user expects "see the full prompt from the
    // top" on expand, and on collapse the bubble's new height would otherwise
    // leave the viewport pointing at unrelated content. Two RAFs so the layout
    // settles before we measure.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const body = bodyRef.current;
        const bubble = bubbleRefs.current.get(id);
        if (!body || !bubble) return;
        const msgEl = bubble.closest('.chat-msg');
        if (!msgEl) return;
        const bodyRect = body.getBoundingClientRect();
        const msgRect = msgEl.getBoundingClientRect();
        body.scrollTop += (msgRect.top - bodyRect.top) - 8;
      });
    });
  }, []);

  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 140) + 'px';
  }, []);

  const switchTab = useCallback(
    (tabName) => {
      if (tabName === activeTab || loading) return;
      setActiveTab(tabName);
    },
    [activeTab, loading],
  );

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;

    const tab = activeTab;
    setInput('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    const userId = ++pendingIdRef.current;
    const aiId = ++pendingIdRef.current;
    setMessages((prev) => ({
      ...prev,
      [tab]: [
        ...prev[tab],
        { role: 'user', text, id: userId },
        { role: 'assistant', text: '', pending: true, id: aiId },
      ],
    }));
    assistantRef.current = { tab, id: aiId };
    setLoading(true);

    let fullResponse = '';
    let firstToken = false;

    try {
      const res = await fetch(CHAT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          history: historyRef.current[tab],
          model: MODELS[tab],
          context: resolvedContext,
        }),
      });

      if (!res.ok) {
        let errMsg = 'Request failed: ' + res.status;
        try {
          const errData = await res.json();
          if (errData && errData.error) errMsg = errData.error;
        } catch {
          /* non-JSON data line */
        }
        throw new Error(errMsg);
      }

      const applyAssistantText = (textValue) => {
        setMessages((prev) => {
          const ref = assistantRef.current;
          if (!ref) return prev;
          const list = prev[ref.tab];
          if (!list) return prev;
          const idx = list.findIndex((m) => m.id === ref.id);
          if (idx === -1) return prev;
          const nextList = list.slice();
          nextList[idx] = {
            ...nextList[idx],
            text: textValue,
            pending: false,
          };
          return { ...prev, [ref.tab]: nextList };
        });
      };

      const contentType = res.headers.get('content-type') || '';

      if (contentType.includes('text/event-stream') && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data: ')) continue;
            const data = trimmed.slice(6);
            if (data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data);
              if (
                parsed.type === 'content_block_delta' &&
                parsed.delta?.type === 'text_delta'
              ) {
                if (!firstToken) {
                  firstToken = true;
                }
                fullResponse += parsed.delta.text;
                applyAssistantText(fullResponse.trimStart());
              }
            } catch {
              /* non-JSON data line */
            }
          }
        }
      } else {
        const data = await res.json();
        fullResponse = data.response || 'No response received.';
        applyAssistantText(fullResponse);
      }

      if (!fullResponse.trim()) {
        fullResponse = 'No response received.';
        applyAssistantText(fullResponse);
      }

      historyRef.current = {
        ...historyRef.current,
        [tab]: [
          ...historyRef.current[tab],
          { role: 'user', content: text },
          { role: 'assistant', content: fullResponse.trimStart() },
        ],
      };
    } catch (err) {
      const msg = err?.message || 'Something went wrong. Please try again.';
      setMessages((prev) => {
        const ref = assistantRef.current;
        if (!ref) return prev;
        const list = prev[ref.tab];
        if (!list) return prev;
        const idx = list.findIndex((m) => m.id === ref.id);
        if (idx === -1) return prev;
        const nextList = list.slice();
        nextList[idx] = {
          ...nextList[idx],
          text: msg,
          pending: false,
        };
        return { ...prev, [ref.tab]: nextList };
      });
    } finally {
      setLoading(false);
      assistantRef.current = null;
    }
  }, [activeTab, input, loading, resolvedContext]);

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const currentMessages = messages[activeTab];
  const cardStyle = { '--glow-rgb': mergedGlowRgb[activeTab] };
  // Once the user has sent at least one prompt in the active tab, the chat
  // switches into "active" mode: the card swells to fill nearly the full
  // viewport (see .chat-card.chat-active .chat-body in theme.css) and the
  // turn-anchor effect below scrollIntoViews the card to the top of the
  // page so the conversation takes over the screen — the user is no longer
  // asked to page-scroll down into a 520px box to follow a streaming reply.
  const isActive = currentMessages.length > 0;

  return (
    <div
      className={'card chat-card' + (isActive ? ' chat-active' : '')}
      aria-label="Ask the dashboard a question"
      style={cardStyle}
    >
      <div className="chat-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'quick'}
          className={`chat-tab${activeTab === 'quick' ? ' active' : ''}`}
          data-tab="quick"
          onClick={() => switchTab('quick')}
        >
          Quick Analysis
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'deep'}
          className={`chat-tab${activeTab === 'deep' ? ' active' : ''}`}
          data-tab="deep"
          onClick={() => switchTab('deep')}
        >
          Deep Analysis
        </button>
      </div>

      <div className="chat-body" ref={bodyRef}>
        {currentMessages.length === 0 && (
          <div className="chat-welcome">{mergedWelcome[activeTab]}</div>
        )}

        {currentMessages.map((m, i) => {
          const isUser = m.role === 'user';
          const key = m.id ?? `${m.role}-${i}`;
          const isExpanded = isUser && expandedIds.has(m.id);
          const canToggle = isUser && overflowIds.has(m.id);
          return (
            <div key={key} className={'chat-msg chat-msg-' + m.role}>
              <div className="chat-msg-label">{isUser ? 'YOU' : 'AI'}</div>
              <div
                ref={isUser ? setBubbleRef(m.id) : undefined}
                className={
                  'chat-msg-bubble' +
                  (isUser && !isExpanded ? ' chat-msg-bubble-clamped' : '')
                }
              >
                {m.text || (m.pending ? (
                  <span className="chat-typing-dots" aria-hidden="true">
                    <span></span><span></span><span></span>
                  </span>
                ) : null)}
              </div>
              {canToggle && (
                <button
                  type="button"
                  className="chat-msg-expand"
                  onClick={() => toggleExpand(m.id)}
                  aria-expanded={isExpanded}
                >
                  {isExpanded ? 'Show less' : 'Show more'}
                </button>
              )}
            </div>
          );
        })}

        {spacerHeight > 0 && (
          <div
            aria-hidden="true"
            style={{ flexShrink: 0, height: spacerHeight + 'px' }}
          />
        )}
      </div>

      <div className="chat-input-row">
        <textarea
          ref={textareaRef}
          className="chat-input"
          value={input}
          placeholder="Type here"
          rows={1}
          onChange={(e) => { setInput(e.target.value); autoResize(); }}
          onKeyDown={onKeyDown}
          disabled={loading}
          aria-label="Chat message input"
        />
        <button
          type="button"
          className="chat-send"
          onClick={sendMessage}
          disabled={loading || !input.trim()}
        >
          {loading ? '...' : 'Send'}
        </button>
      </div>
    </div>
  );
}
