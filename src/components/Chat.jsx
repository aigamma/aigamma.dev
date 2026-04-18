import { useCallback, useEffect, useRef, useState } from 'react';

// Interactive chat bound to /api/chat (the Netlify Function proxy to
// Anthropic's streaming messages endpoint). Two tabs — Quick Analysis
// (Sonnet 4.6) and Deep Analysis (Opus 4.6) — mirror about.aigamma.com's
// chat affordance so the shared design language carries across the
// property. Quick is the default because for a public chat exposed on a
// live dashboard, Sonnet is the faster and cheaper path under arbitrary
// load; Opus is reserved for the user who has already engaged the chat
// and wants a longer, structurally deeper response on the math. The
// proxy injects the dashboard-focused system prompt server side, so this
// component never sees the prompt or the API key. It just speaks the
// wire format: POST { message, history, model } → SSE stream of
// content_block_delta events. Per-tab message lists and histories are
// held in local state and a ref respectively so a user can hop between
// tabs without losing either conversation.
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
  beta: 'claude-opus-4-6',
};

// RGB triplets for the --glow-rgb CSS variable that drives the input
// border, the keyframe animation, and the focus ring. Warm yellow for
// Quick (matches about.aigamma.com's Sonnet accent), site-accent blue
// for Deep, accent-coral for the experimental Beta row.
const GLOW_RGB = {
  quick: '240, 192, 64',
  deep: '74, 158, 255',
  beta: '231, 76, 60',
};

const WELCOME = {
  quick: 'What about this site would you like to explore?',
  deep:
    'Deep Analysis mode — responses are longer and explore the dashboard with greater structural depth and connective range across the underlying theory.',
  beta: 'Experimental beta — Volatility Surface model.',
};

export default function Chat() {
  const [activeTab, setActiveTab] = useState('quick');
  const [messages, setMessages] = useState({ quick: [], deep: [], beta: [] });
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const historyRef = useRef({ quick: [], deep: [], beta: [] });
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

  const scrollToBottom = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, activeTab, scrollToBottom]);

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

    const id = ++pendingIdRef.current;
    setMessages((prev) => ({
      ...prev,
      [tab]: [
        ...prev[tab],
        { role: 'user', text },
        { role: 'assistant', text: '', pending: true, id },
      ],
    }));
    assistantRef.current = { tab, id };
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
  }, [activeTab, input, loading]);

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const currentMessages = messages[activeTab];
  const cardStyle = { '--glow-rgb': GLOW_RGB[activeTab] };

  return (
    <div
      className="card chat-card"
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
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'beta'}
          className={`chat-tab chat-tab-beta${activeTab === 'beta' ? ' active' : ''}`}
          data-tab="beta"
          onClick={() => switchTab('beta')}
        >
          Beta: Volatility Surface
        </button>
      </div>

      <div className="chat-body" ref={bodyRef}>
        {currentMessages.length === 0 && (
          <div className="chat-welcome">{WELCOME[activeTab]}</div>
        )}

        {currentMessages.map((m, i) => (
          <div key={i} className={'chat-msg chat-msg-' + m.role}>
            <div className="chat-msg-label">{m.role === 'user' ? 'YOU' : 'AI'}</div>
            <div className="chat-msg-bubble">
              {m.text || (m.pending ? (
                <span className="chat-typing-dots" aria-hidden="true">
                  <span></span><span></span><span></span>
                </span>
              ) : null)}
            </div>
          </div>
        ))}
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
