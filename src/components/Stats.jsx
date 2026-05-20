// src/components/Stats.jsx
//
// Public analytics surface for aigamma.com, served at /stats/. Mirrors
// the worldthought.com Stats page in spirit (same payload-on-mount,
// same privacy posture, same window toggle, same public-by-design
// stance) but adapted to aigamma's data model and visual stack:
// Plotly for time-series and bar charts (the rest of the site already
// loads Plotly via the vendored bundle, so this page picks up zero
// new dependencies), aigamma's accent palette for color, the chat-
// logs join surfacing top chat surfaces and model split.

import { useEffect, useMemo, useRef, useState } from 'react';
import usePlotly from '../hooks/usePlotly';
import { PAGES } from '../data/pages.js';

// Aigamma accent palette. Pulled from theme.css tokens with hex
// fallbacks so the Plotly traces (which can't read CSS vars directly)
// render correctly server-side and in printed PDF exports.
const COLOR = {
  blue: '#4a9eff',
  green: '#2ecc71',
  amber: '#f1c40f',
  coral: '#e74c3c',
  purple: '#BF7FFF',
  cyan: '#1abc9c',
  bg: '#141820',
  bgBorder: '#1e2230',
  text: '#e0e0e0',
  textMuted: '#8a8f9c',
};

// Section colors so the top-pages bar chart visually separates the
// promoted top-nav surfaces, the Tools menu, and the Research labs.
const SECTION_COLOR = {
  home: COLOR.green,
  topnav: COLOR.blue,
  tools: COLOR.purple,
  research: COLOR.amber,
  chrome: COLOR.textMuted,
};

const SECTION_LABEL = {
  home: 'Home',
  topnav: 'Top nav (promoted)',
  tools: 'Tools',
  research: 'Research',
  chrome: 'Chrome',
};

const WINDOW_OPTIONS = [
  { key: 'day', label: 'Last 24h' },
  { key: 'week', label: 'Last 7 days' },
  { key: 'month', label: 'Last 30 days' },
  { key: 'all_in_window', label: 'All time' },
];

function formatInt(n) {
  if (n == null) return '0';
  return Number(n).toLocaleString('en-US');
}

function pct(num, denom) {
  if (!denom) return '0%';
  return Math.round((num / denom) * 100) + '%';
}

function StatCell({ label, value, hint, accent }) {
  return (
    <div className="stats-cell" style={accent ? { borderTopColor: accent } : undefined}>
      <div className="stats-cell-value">{formatInt(value)}</div>
      <div className="stats-cell-label">{label}</div>
      {hint && <div className="stats-cell-hint">{hint}</div>}
    </div>
  );
}

function WindowToggle({ value, onChange }) {
  return (
    <div className="stats-window-toggle" role="group" aria-label="Time window">
      {WINDOW_OPTIONS.map((opt) => (
        <button
          key={opt.key}
          type="button"
          className={`stats-window-btn${value === opt.key ? ' is-active' : ''}`}
          onClick={() => onChange(opt.key)}
          aria-pressed={value === opt.key}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// ---------- Plotly charts ----------

function PlotlyChart({ data, layout, config, height = 300 }) {
  const ref = useRef(null);
  const { plotly } = usePlotly();
  useEffect(() => {
    if (!plotly || !ref.current) return;
    const fullLayout = {
      paper_bgcolor: COLOR.bg,
      plot_bgcolor: COLOR.bg,
      font: { family: 'Calibri, "Segoe UI", system-ui, sans-serif', color: COLOR.text, size: 12 },
      margin: { t: 30, r: 18, b: 40, l: 50 },
      xaxis: { gridcolor: 'rgba(160,180,220,0.08)', linecolor: COLOR.bgBorder, tickcolor: COLOR.bgBorder, zerolinecolor: COLOR.bgBorder, color: COLOR.textMuted },
      yaxis: { gridcolor: 'rgba(160,180,220,0.08)', linecolor: COLOR.bgBorder, tickcolor: COLOR.bgBorder, zerolinecolor: COLOR.bgBorder, color: COLOR.textMuted },
      legend: { font: { color: COLOR.text, size: 11 }, bgcolor: 'rgba(0,0,0,0)' },
      hoverlabel: { bgcolor: COLOR.bg, bordercolor: COLOR.bgBorder, font: { color: COLOR.text } },
      ...layout,
    };
    const fullConfig = {
      displayModeBar: false,
      responsive: true,
      ...config,
    };
    plotly.newPlot(ref.current, data, fullLayout, fullConfig);
    return () => {
      if (ref.current && plotly.purge) plotly.purge(ref.current);
    };
  }, [plotly, data, layout, config]);

  return <div ref={ref} style={{ width: '100%', height }} />;
}

function DailyTimeSeriesChart({ daily }) {
  if (!daily || daily.length === 0) {
    return <div className="stats-empty">Daily traffic fills in as readers arrive.</div>;
  }
  const x = daily.map((d) => d.date);
  const data = [
    { x, y: daily.map((d) => d.views), type: 'scatter', mode: 'lines+markers', name: 'Views', line: { color: COLOR.blue, width: 2 }, marker: { size: 5 } },
    { x, y: daily.map((d) => d.visitors), type: 'scatter', mode: 'lines+markers', name: 'Visitors', line: { color: COLOR.green, width: 2 }, marker: { size: 5 } },
    { x, y: daily.map((d) => d.chats), type: 'scatter', mode: 'lines+markers', name: 'Chat turns', line: { color: COLOR.amber, width: 2 }, marker: { size: 5 } },
  ];
  const layout = {
    showlegend: true,
    legend: { orientation: 'h', y: -0.18 },
    xaxis: { type: 'date' },
    margin: { t: 20, r: 18, b: 60, l: 50 },
  };
  return <PlotlyChart data={data} layout={layout} height={320} />;
}

function TopPagesChart({ items }) {
  if (!items || items.length === 0) {
    return <div className="stats-empty">No page views recorded in this window yet.</div>;
  }
  const sorted = [...items].sort((a, b) => a.views - b.views); // ascending so bars read top-down by magnitude
  const data = [
    {
      type: 'bar',
      orientation: 'h',
      x: sorted.map((p) => p.views),
      y: sorted.map((p) => p.title || p.href),
      marker: { color: sorted.map((p) => SECTION_COLOR[p.section] || COLOR.textMuted) },
      hovertemplate: '%{y}: %{x} views<extra></extra>',
    },
  ];
  const layout = {
    margin: { t: 10, r: 20, b: 40, l: 140 },
    xaxis: { title: 'Page views' },
    yaxis: { automargin: true },
    bargap: 0.25,
  };
  return <PlotlyChart data={data} layout={layout} height={Math.max(260, sorted.length * 22)} />;
}

function TopChatSurfacesChart({ items }) {
  if (!items || items.length === 0) {
    return <div className="stats-empty">No chat traffic recorded in this window yet.</div>;
  }
  const sorted = [...items].sort((a, b) => a.count - b.count);
  const data = [
    {
      type: 'bar',
      orientation: 'h',
      x: sorted.map((p) => p.count),
      y: sorted.map((p) => p.title || p.surface),
      marker: { color: COLOR.purple },
      hovertemplate: '%{y}: %{x} turns<extra></extra>',
    },
  ];
  const layout = {
    margin: { t: 10, r: 20, b: 40, l: 140 },
    xaxis: { title: 'Chat turns' },
    yaxis: { automargin: true },
    bargap: 0.25,
  };
  return <PlotlyChart data={data} layout={layout} height={Math.max(220, sorted.length * 22)} />;
}

function SectionDonut({ by_section }) {
  if (!by_section || by_section.length === 0) {
    return <div className="stats-empty">Section split fills in as page views accumulate.</div>;
  }
  const data = [
    {
      type: 'pie',
      hole: 0.55,
      values: by_section.map((s) => s.count),
      labels: by_section.map((s) => SECTION_LABEL[s.section] || s.section),
      marker: { colors: by_section.map((s) => SECTION_COLOR[s.section] || COLOR.textMuted) },
      textinfo: 'label+percent',
      textfont: { color: COLOR.text, size: 11 },
      hoverinfo: 'label+value+percent',
    },
  ];
  const layout = { showlegend: false, margin: { t: 20, r: 20, b: 20, l: 20 } };
  return <PlotlyChart data={data} layout={layout} height={300} />;
}

function ChatModelDonut({ items }) {
  if (!items || items.length === 0) {
    return <div className="stats-empty">Model split fills in once chat turns are recorded.</div>;
  }
  const MODEL_LABEL = {
    'claude-sonnet-4-6': 'Sonnet 4.6 (Quick)',
    'claude-opus-4-7': 'Opus 4.7 (Deep)',
  };
  const data = [
    {
      type: 'pie',
      hole: 0.55,
      values: items.map((m) => m.count),
      labels: items.map((m) => MODEL_LABEL[m.model] || m.model),
      marker: { colors: items.map((_, i) => (i === 0 ? COLOR.blue : i === 1 ? COLOR.purple : COLOR.cyan)) },
      textinfo: 'label+percent',
      textfont: { color: COLOR.text, size: 11 },
    },
  ];
  const layout = { showlegend: false, margin: { t: 20, r: 20, b: 20, l: 20 } };
  return <PlotlyChart data={data} layout={layout} height={260} />;
}

// ---------- Simple list components ----------

function CountryList({ items }) {
  if (!items || items.length === 0) {
    return <div className="stats-empty">Country signal fills in as visitors arrive.</div>;
  }
  const total = items.reduce((s, it) => s + it.count, 0);
  const max = Math.max(...items.map((it) => it.count), 1);
  return (
    <ol className="stats-country-list">
      {items.slice(0, 15).map((c) => {
        const width = (c.count / max) * 100;
        return (
          <li key={c.country} className="stats-country-row">
            <span className="stats-country-code">{c.country}</span>
            <span className="stats-country-track">
              <span className="stats-country-fill" style={{ width: width + '%' }} />
            </span>
            <span className="stats-country-count">{formatInt(c.count)}</span>
            <span className="stats-country-pct">{pct(c.count, total)}</span>
          </li>
        );
      })}
    </ol>
  );
}

function ReferrersList({ items }) {
  if (!items || items.length === 0) {
    return (
      <div className="stats-empty">
        Inbound traffic from other sites lands here. Direct visits (typed URL, bookmark) are not
        counted as referrers and so do not appear in this list.
      </div>
    );
  }
  const total = items.reduce((s, it) => s + it.count, 0);
  return (
    <ul className="stats-simple-list">
      {items.map((r) => (
        <li key={r.domain}>
          <span>{r.domain}</span>
          <span className="stats-simple-meta">
            <span className="stats-simple-count">{formatInt(r.count)}</span>
            <span className="stats-simple-pct">{pct(r.count, total)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function PrivacyBanner() {
  return (
    <aside className="stats-privacy" aria-label="Privacy posture for this page">
      <div className="stats-privacy-head">How this page is built</div>
      <p>
        <strong>Same data, same view, for every visitor.</strong> No cookies. No login.
        No localStorage. No fingerprinting. No third-party tracking. The figures below come from
        a single in-house Netlify Function that records one event per page mount with the path,
        the document referrer&apos;s registered domain, and the country header from the edge.
      </p>
      <p>
        The visitor identifier is a sha256 hash of the client IP joined to a daily-rotating salt,
        truncated to sixteen hex characters. The raw IP is never written to disk, and the salt
        rotates at UTC midnight so the same visitor across two days resolves to two unlinkable
        hashes. The headline figures count real readers only; bot and crawler traffic is
        tabulated separately and labeled where it appears. The Do-Not-Track header is honored.
      </p>
    </aside>
  );
}

function MethodologyNote({ generated_at }) {
  return (
    <section className="card stats-methodology">
      <h2>Methodology</h2>
      <ul>
        <li>
          <strong>Tracking surface.</strong> One <code>view</code> event fires from every page mount
          (universally wired in <code>src/ErrorBoundary.jsx</code> which wraps every per-page App).
          The on-page <code>Chat</code> surface produces its own per-turn records into the
          existing <code>chat_logs</code> Supabase table; the &ldquo;Top chat surfaces&rdquo; chart
          and the model split are joined from that table.
        </li>
        <li>
          <strong>Storage.</strong> Each event is one row in <code>public.page_views</code> on the
          aigamma Supabase project. Row-level security is enabled with no policies, so the table
          is reachable only via the service-role key used by <code>/api/track</code> (write) and
          <code> /api/stats</code> (read). The /stats endpoint aggregates rows on each request and
          returns one rolled-up JSON payload to every visitor.
        </li>
        <li>
          <strong>Privacy.</strong> IP addresses are not stored. The visitor identifier is a
          sha256 hash of the IP joined to a daily-rotating salt. Referrers are reduced to their
          registered domain only (no path, no query string). User-Agent is classified coarsely
          into browser / bot / other; the version string and platform are not retained. The
          Do-Not-Track header is honored.
        </li>
        <li>
          <strong>Bots.</strong> Headline counters exclude common crawlers, AI-citation bots,
          monitoring probes, and CLI tools. The bot view count is surfaced as its own number so
          the honest total is visible without polluting the human signal.
        </li>
        <li>
          <strong>Coverage.</strong> Page-view tracking began when <code>/api/track</code>
          shipped. Chat-log tracking has been live since the chat function deployed. Time-window
          toggles are sliding windows ending at the moment this page was generated.
        </li>
      </ul>
      {generated_at && (
        <div className="stats-generated">
          Generated <time dateTime={generated_at}>{new Date(generated_at).toUTCString()}</time>
        </div>
      )}
    </section>
  );
}

// ---------- Page ----------

export default function Stats() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [windowKey, setWindowKey] = useState('week');

  useEffect(() => {
    let cancelled = false;
    fetch('/api/stats?days=90')
      .then((res) => {
        if (!res.ok) throw new Error('stats_http_' + res.status);
        return res.json();
      })
      .then((j) => {
        if (!cancelled) setData(j);
      })
      .catch((e) => {
        if (!cancelled) setError(e?.message || String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="stats-page">
        <section className="card stats-hero">
          <h1>AI Gamma &middot; Stats</h1>
          <p className="stats-hero-sub">
            The stats endpoint is temporarily unreachable. The tracking pipeline behind it is
            unaffected; this view will fill in once the endpoint responds. Refresh the page in a
            moment.
          </p>
        </section>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="stats-page">
        <section className="card stats-hero">
          <h1>AI Gamma &middot; Stats</h1>
          <p className="stats-hero-sub">Loading the public traffic snapshot...</p>
        </section>
      </div>
    );
  }

  const w = data[windowKey] || data.week;
  const dailySeries = data.month?.daily || [];

  return (
    <div className="stats-page">
      <section className="card stats-hero">
        <div className="stats-hero-head">
          <div>
            <h1>AI Gamma &middot; Stats</h1>
            <p className="stats-hero-sub">
              Public traffic on <strong>aigamma.com</strong>. The same page, the same numbers,
              for every visitor: no login, no cookies, no privileged dashboard. The window toggle
              below rescopes every count on the page.
            </p>
          </div>
          <WindowToggle value={windowKey} onChange={setWindowKey} />
        </div>

        <div className="stats-cells">
          <StatCell label="Page views" value={w.total_views} hint="real readers, excluding bots" accent={COLOR.blue} />
          <StatCell label="Unique visitors" value={w.unique_visitors} hint="distinct daily-salted hashes" accent={COLOR.green} />
          <StatCell label="Chat turns" value={w.chat_turns} hint={`across ${w.unique_chat_surfaces} surfaces`} accent={COLOR.amber} />
          <StatCell label="Bot traffic" value={w.bot_views} hint="crawlers, monitors, agents" accent={COLOR.textMuted} />
        </div>
      </section>

      <PrivacyBanner />

      <section className="card stats-section">
        <header className="stats-section-head">
          <h2>Daily readership</h2>
          <p className="stats-section-sub">
            Last 30 days. Three traces: total page views (blue), unique visitors (green), and on-page
            chat turns (amber). The chart stays on the 30-day window regardless of the toggle above
            so the trend has room to read.
          </p>
        </header>
        <DailyTimeSeriesChart daily={dailySeries} />
      </section>

      <div className="stats-grid-two">
        <section className="card stats-section">
          <header className="stats-section-head">
            <h2>Most-visited pages</h2>
            <p className="stats-section-sub">
              Top pages by view count in this window. Colors by section: green Home, blue Top nav,
              purple Tools, amber Research.
            </p>
          </header>
          <TopPagesChart items={w.top_pages} />
        </section>

        <section className="card stats-section">
          <header className="stats-section-head">
            <h2>Most-asked chat surfaces</h2>
            <p className="stats-section-sub">
              Top per-page chat surfaces by recorded turn count, sourced from the in-house
              <code> chat_logs</code> table.
            </p>
          </header>
          <TopChatSurfacesChart items={w.top_chat_surfaces} />
        </section>
      </div>

      <div className="stats-grid-two">
        <section className="card stats-section">
          <header className="stats-section-head">
            <h2>Page section mix</h2>
            <p className="stats-section-sub">
              Share of all page views by category, showing whether the tactical surfaces or the
              research labs are pulling readers.
            </p>
          </header>
          <SectionDonut by_section={w.by_section} />
        </section>

        <section className="card stats-section">
          <header className="stats-section-head">
            <h2>Where readers are</h2>
            <p className="stats-section-sub">
              Two-letter country codes from the Netlify edge x-country header. City and region
              are not retained.
            </p>
          </header>
          <CountryList items={w.by_country} />
        </section>
      </div>

      <div className="stats-grid-two">
        <section className="card stats-section">
          <header className="stats-section-head">
            <h2>Chat model split</h2>
            <p className="stats-section-sub">
              Share of chat turns by model. Quick uses Sonnet, Deep uses Opus. Both are billed
              against the same Anthropic API key.
            </p>
          </header>
          <ChatModelDonut items={w.chat_models} />
        </section>

        <section className="card stats-section">
          <header className="stats-section-head">
            <h2>Top referrers</h2>
            <p className="stats-section-sub">
              Inbound traffic from external sites. Site-internal navigation is omitted.
            </p>
          </header>
          <ReferrersList items={w.top_referrers} />
        </section>
      </div>

      <MethodologyNote generated_at={data.generated_at} />
    </div>
  );
}
