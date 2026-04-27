import { useEffect, useMemo, useRef, useState } from 'react';
import usePlotly from '../hooks/usePlotly';
import {
  plotly2DChartLayout,
  plotlyAxis,
  PLOTLY_COLORS,
} from '../lib/plotlyTheme';

// Local font override for this chart only. The rest of the platform uses
// Courier New monospace per the brand guideline in CLAUDE.md, but the
// Sector Performance bar trio renders enough small-size text (12-13px
// y-axis sector labels, 12px bar-tip percent labels, 26px panel titles)
// that Plotly's SVG-rendered Courier New comes out visibly thinner and
// less legible than the surrounding body copy — which uses the system
// sans-serif stack defined in src/styles/theme.css. Aligning the chart
// to the same stack makes the chart and the explanatory text underneath
// it match visually and reads cleanly at every size on the panel. The
// stack is in fallback order: -apple-system on macOS Safari/Chrome,
// BlinkMacSystemFont on macOS Chrome, Segoe UI on Windows, then a
// generic sans-serif catch-all for anything else.
const CHART_FONT_FAMILY =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

// Sector-performance horizontal-bar trio. Renders the /api/sector-performance
// payload as three horizontal Plotly bar charts stacked vertically (1 day,
// 1 week, 1 month), matching the reference image at C:\i\. Each chart is
// sorted descending by performance with green bars for positive returns
// and red bars for negative; the value (signed percent to two decimals)
// prints at the bar's tip in bold so it reads as the primary number on
// each row, with the GICS sector name on the y-axis on the left. The
// three Plotly instances live in their own refs so the layouts can be
// independently sized — Plotly's subplot machinery shares a y-axis
// across stacked charts in xy mode, which would force every chart's
// sector list to be in the same order; that defeats the purpose of the
// per-horizon ranking, so we render three independent charts instead.
//
// Data flow: SectorPerformanceBars fetches /api/sector-performance once
// on mount and again every UPDATE_INTERVAL_MS (60s) so the chart picks
// up the next daily_eod write within a minute of the upstream backfill
// landing. The endpoint applies a 15-minute edge cache so the polling
// pressure on Supabase is bounded; the polling cadence is just there
// for responsiveness on the client when the user leaves the page open
// across the daily refresh boundary.

const UPDATE_INTERVAL_MS = 60_000;

const POSITIVE_INK = PLOTLY_COLORS.positive; // #2ecc71
const NEGATIVE_INK = PLOTLY_COLORS.negative; // #e74c3c

function formatPct(v) {
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(2)}`;
}

function formatDateLabel(iso) {
  if (!iso || typeof iso !== 'string') return iso ?? '';
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return `${m}/${d}/${y}`;
}

// One Plotly horizontal bar chart for a single horizon (1d / 1w / 1m).
// The y-axis is the sector name in performance-descending order; the
// x-axis is the absolute magnitude of the return — every bar starts at
// zero and extends rightward so all magnitudes are visually comparable
// against a common left baseline rather than splitting around a center
// spine. The sign of each return is carried by color (green positive,
// red negative) and by the signed text label printed at the bar's tip.
// autorange='reversed' on the y-axis flips Plotly's default bottom-to-
// top ordering so the best-performing sector appears at the top of the
// chart, matching the reference image's layout.
function buildPanelTraces(rows) {
  if (!rows || rows.length === 0) return { traces: [], names: [] };

  const values = rows.map((r) => r.value);
  const magnitudes = values.map((v) => Math.abs(v));
  const colors = values.map((v) => (v >= 0 ? POSITIVE_INK : NEGATIVE_INK));
  const labels = values.map(formatPct);

  // Each y-axis category label is wrapped in an inline <span> whose color
  // matches its bar (green for positive returns, red for negative). Plotly
  // renders tick text through the same SVG-text path that supports a
  // subset of HTML — <b>, <i>, <span style="...">, etc. — so the colored
  // markup carries through correctly. Each panel computes its own colored
  // labels because the same sector can be green in one horizon and red
  // in another (e.g. XLE leads on 1W and trails on 1M in the current
  // regime), and Plotly treats each unique string as its own categorical
  // value within the chart so cross-panel sharing is not a concern.
  const coloredNames = rows.map((r) => {
    const color = r.value >= 0 ? POSITIVE_INK : NEGATIVE_INK;
    return `<span style="color:${color}">${r.name}</span>`;
  });

  const trace = {
    type: 'bar',
    orientation: 'h',
    x: magnitudes,
    y: coloredNames,
    marker: {
      color: colors,
      line: { color: 'rgba(255,255,255,0.18)', width: 0.6 },
    },
    text: labels,
    textposition: 'outside',
    cliponaxis: false,
    textfont: {
      family: CHART_FONT_FAMILY,
      color: PLOTLY_COLORS.titleText,
      size: 12,
    },
    // Hover references customdata[2] (the plain sector name) rather than
    // %{y}, which would otherwise dump the colored-span HTML straight
    // into the hover label. The hover stays uncolored for legibility on
    // the dark hover-card background.
    hovertemplate:
      '<b>%{customdata[0]}</b> · %{customdata[2]}<br>' +
      '%{customdata[1]:+.2f}%<extra></extra>',
    customdata: rows.map((r) => [r.symbol, r.value, r.name]),
    showlegend: false,
  };

  return { traces: [trace], names: rows.map((r) => r.name) };
}

function buildPanelLayout(rows, panelTitle) {
  if (!rows || rows.length === 0) return null;

  const values = rows.map((r) => r.value);
  const maxMag = Math.max(...values.map((v) => Math.abs(v)), 0.5);

  // Bars all extend rightward from x=0, so the range starts at 0 (the
  // common baseline) and runs out to maxMag plus 25% padding so the bar-
  // tip ±N.NN labels never bump up against the plot's right edge.
  const xRange = [0, maxMag * 1.25];

  return plotly2DChartLayout({
    title: {
      text: panelTitle,
      // 26px non-bold sans-serif. Same point size and weight regime as
      // the .what-this-card paragraphs underneath the chart, so the
      // panel headers and the explanatory copy share a typographic
      // family — eye doesn't have to switch between two type systems.
      font: { family: CHART_FONT_FAMILY, color: PLOTLY_COLORS.titleText, size: 26 },
      x: 0.5,
      xanchor: 'center',
      y: 0.99,
      yanchor: 'top',
    },
    xaxis: plotlyAxis('', {
      range: xRange,
      zeroline: true,
      zerolinecolor: 'rgba(255,255,255,0.25)',
      zerolinewidth: 1.2,
      tickformat: '.1f',
      ticksuffix: '%',
    }),
    yaxis: plotlyAxis('', {
      autorange: 'reversed',
      // Push the sector labels away from the axis line so they don't
      // butt up against the start of the bars. ticks: 'outside' with a
      // transparent tickcolor draws invisible 12-pixel tick marks that
      // create the gap without showing actual tick chrome — Plotly has
      // no direct "tick label padding" property, so this is the
      // canonical way to add breathing room between category labels and
      // the data area on a horizontal-bar chart.
      ticks: 'outside',
      ticklen: 12,
      tickcolor: 'rgba(0,0,0,0)',
      tickfont: {
        family: CHART_FONT_FAMILY,
        color: PLOTLY_COLORS.titleText,
        size: 12,
      },
    }),
    margin: { t: 44, r: 70, b: 40, l: 170 },
    hovermode: 'closest',
    bargap: 0.25,
  });
}

function PerformancePanel({ rows, title }) {
  const chartRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();

  useEffect(() => {
    if (!Plotly || !chartRef.current || !rows) return;
    const { traces } = buildPanelTraces(rows);
    const layout = buildPanelLayout(rows, title);
    if (!layout) return;
    Plotly.react(chartRef.current, traces, layout, {
      displayModeBar: false,
      responsive: true,
    });
  }, [Plotly, rows, title]);

  if (plotlyError) {
    return (
      <div className="sector-bars__panel sector-bars__panel--error">
        {plotlyError}
      </div>
    );
  }

  return (
    <div className="sector-bars__panel">
      <div ref={chartRef} className="sector-bars__chart" />
    </div>
  );
}

// The endpoint and title are configurable so this same component can
// render either the eleven SPDR sector ETFs (the original use case on
// /rotations -> /api/sector-performance) or any other 1D/1W/1M
// horizontal-bar trio that returns the same payload shape (panels with
// {symbol, name, value} rows). The /stocks page passes endpoint=
// '/api/stock-performance' and title='Stock Performance' to render
// the same chart trio for the eleven hand-curated top option-volume
// single-name stocks. Defaults preserve the original /rotations
// behavior so no caller change is required there.
//
// noun is the short label used in the loading and error placeholders
// ("Loading sector performance…" vs "Loading stock performance…") so
// the placeholder copy stays accurate to whatever the page is
// rendering. Defaulting to 'sector performance' keeps the original
// /rotations placeholder text identical to its pre-generalization
// behavior.
export default function SectorPerformanceBars({
  endpoint = '/api/sector-performance',
  title = 'Sector Performance',
  noun = 'sector performance',
} = {}) {
  const [payload, setPayload] = useState(null);
  const [fetchError, setFetchError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch(endpoint);
        if (!res.ok) throw new Error(`${endpoint} fetch failed: ${res.status}`);
        const json = await res.json();
        if (!cancelled) {
          setPayload(json);
          setFetchError(null);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setFetchError(String(err?.message || err));
          setLoading(false);
        }
      }
    }

    load();
    const id = setInterval(load, UPDATE_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [endpoint]);

  const panels = useMemo(() => payload?.panels ?? null, [payload]);

  if (loading) {
    return (
      <div className="card sector-bars-card">
        <div className="sector-bars__status">Loading {noun}…</div>
      </div>
    );
  }

  if (fetchError || !panels) {
    return (
      <div className="card sector-bars-card">
        <div className="sector-bars__status sector-bars__status--error">
          {fetchError || `No ${noun} data available.`}
        </div>
      </div>
    );
  }

  return (
    <div className="card sector-bars-card">
      <div className="sector-bars__meta">
        <span className="sector-bars__title">{title}</span>
        <span className="sector-bars__asof">
          Through {formatDateLabel(payload.asOf)}
        </span>
      </div>
      <PerformancePanel rows={panels['1d']} title="1 DAY PERFORMANCE" />
      <PerformancePanel rows={panels['1w']} title="1 WEEK PERFORMANCE" />
      <PerformancePanel rows={panels['1m']} title="1 MONTH PERFORMANCE" />
    </div>
  );
}
