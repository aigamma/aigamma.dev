import { useCallback, useEffect, useRef, useState } from 'react';

// Interactive chat bound to /api/chat (the Netlify Function proxy to
// Anthropic's streaming messages endpoint). The proxy pins the model to
// Claude Opus 4.7 and injects the dashboard-focused system prompt server
// side, so this component never sees the prompt or the API key. It just
// speaks the wire format: POST { message, history, model } → SSE stream
// of content_block_delta events. History is kept client-side in a ref
// (not state) because we only read it when assembling the next request,
// so re-rendering on every message append would be waste.
//
// The component is deliberately small. Every complexity in the about-site
// chat that is not required for a math/logic/philosophy conversation
// (file upload, document generation, model picker tabs, conversation cap)
// has been dropped. The single feature that matters is a clean streaming
// render that updates the assistant bubble token-by-token without
// scroll-snapping the page on every delta.

const CHAT_ENDPOINT = '/api/chat';
const MODEL = 'claude-opus-4-6';
const WELCOME = 'Ask about the math, logic, or philosophy behind anything on this dashboard. The dealer gamma regime, the SVI fit, the Breeden-Litzenberger density, the VRP construction, why ATM IV excludes the front-month weekly, where the Put Wall comes from, how term structure pricing works, and any of the theory underneath. Answers come from Claude Opus 4.6 and stream as they are generated.';

export default function Chat() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const historyRef = useRef([]);
  const bodyRef = useRef(null);
  const textareaRef = useRef(null);
  const assistantRef = useRef(null);

  const scrollToBottom = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 140) + 'px';
  }, []);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;

    setInput('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    const nextMessages = [
      ...messages,
      { role: 'user', text },
      { role: 'assistant', text: '', pending: true }
    ];
    setMessages(nextMessages);
    assistantRef.current = nextMessages.length - 1;
    setLoading(true);

    let fullResponse = '';
    let firstToken = false;

    try {
      const res = await fetch(CHAT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          history: historyRef.current,
          model: MODEL
        })
      });

      if (!res.ok) {
        let errMsg = 'Request failed: ' + res.status;
        try {
          const errData = await res.json();
          if (errData && errData.error) errMsg = errData.error;
        } catch { /* non-JSON data line */ }
        throw new Error(errMsg);
      }

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
              if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
                if (!firstToken) {
                  firstToken = true;
                }
                fullResponse += parsed.delta.text;
                setMessages((prev) => {
                  const idx = assistantRef.current;
                  if (idx == null || idx >= prev.length) return prev;
                  const next = prev.slice();
                  next[idx] = { ...next[idx], text: fullResponse.trimStart(), pending: false };
                  return next;
                });
              }
            } catch { /* non-JSON data line */ }
          }
        }
      } else {
        const data = await res.json();
        fullResponse = data.response || 'No response received.';
        setMessages((prev) => {
          const idx = assistantRef.current;
          if (idx == null || idx >= prev.length) return prev;
          const next = prev.slice();
          next[idx] = { ...next[idx], text: fullResponse, pending: false };
          return next;
        });
      }

      if (!fullResponse.trim()) {
        fullResponse = 'No response received.';
        setMessages((prev) => {
          const idx = assistantRef.current;
          if (idx == null || idx >= prev.length) return prev;
          const next = prev.slice();
          next[idx] = { ...next[idx], text: fullResponse, pending: false };
          return next;
        });
      }

      historyRef.current = [
        ...historyRef.current,
        { role: 'user', content: text },
        { role: 'assistant', content: fullResponse.trimStart() }
      ];
    } catch (err) {
      const msg = err?.message || 'Something went wrong. Please try again.';
      setMessages((prev) => {
        const idx = assistantRef.current;
        if (idx == null || idx >= prev.length) return prev;
        const next = prev.slice();
        next[idx] = { ...next[idx], text: msg, pending: false };
        return next;
      });
    } finally {
      setLoading(false);
      assistantRef.current = null;
    }
  }, [input, loading, messages]);

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div className="card chat-card" aria-label="Ask the dashboard a question">
      <div className="chat-header">
        <span className="chat-title">ASK THE DASHBOARD</span>
      </div>

      <div className="chat-body" ref={bodyRef}>
        {messages.length === 0 && (
          <div className="chat-welcome">{WELCOME}</div>
        )}

        {messages.map((m, i) => (
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
          placeholder="Type your question"
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
