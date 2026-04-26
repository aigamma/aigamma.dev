import { useEffect, useMemo, useRef, useState } from 'react';
import usePlotly from '../hooks/usePlotly';
import useIsMobile from '../hooks/useIsMobile';
import {
  PLOTLY_BASE_LAYOUT_2D,
  PLOTLY_COLORS,
  plotlyAxis,
} from '../lib/plotlyTheme';

// Expiring Gamma — bar chart of per-expiration dollar gamma
// concentration. Two stacked-overlay bar traces share a single x axis
// (expiration date) and a single y axis ($ gamma per 1% move at the
// current spot):
//
//   - Call γ trace: positive y, accent-coral. Σ of γ · OI · 100 · S² · 0.01
//                   over every call contract at that expiration.
//   - Put γ trace:  NEGATIVE y, accent-blue. Same sum over puts, with
//                   the sign flipped so the puts render downward and
//                   the chart reads as a mirrored bar plot around y=0.
//
// barmode = 'overlay' is correct here because the two traces inhabit
// disjoint y regions (calls always ≥ 0, puts always ≤ 0) so they cannot
// visually collide at any expiration. 'group' would split the bar
// width and shift each trace half a bar-width to either side, which
// breaks the "calls and puts on the same expiration are stacked
// visually" reading.
//
// Bar width is fixed at ~half a calendar day (in milliseconds) so a
// 0DTE bar and a 9-month-out bar render at the same visual width
// regardless of how dense the expiration calendar is at that horizon.
// Plotly's date axis spaces the bars proportionally to time to
// expiration, so the front-month wall of weeklies clusters tightly
// and the monthly OPEX dates spread out — which is exactly what the
// reader wants to see when reading "where is the next big roll-off".
//
// The chart carries an x-axis rangeslider so a reader can brush in on
// a sub-window without losing the orientation of the full series.

const COLOR_CALL = PLOTLY_COLORS.secondary;  // #e74c3c — orange/coral
const COLOR_PUT = PLOTLY_COLORS.primary;     // #4a9eff — blue
const BAR_OPACITY = 0.95;
const BAR_WIDTH_MS = 12 * 60 * 60 * 1000;    // ~half a calendar day

function formatDollar(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9)  return `${sign}$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6)  return `${sign}$${(abs / 1e6).toFixed(0)}M`;
  return `${sign}$${abs.toFixed(0)}`;
}

function formatAsOf(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/New_York',
    timeZoneName: 'short',
  });
}

export default function ExpiringGamma() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const chartRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();
  const mobile = useIsMobile();

  useEffect(() => {
    let cancelled = false;
    fetch('/api/expiring-gamma')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j) => { if (!cancelled) setData(j); })
      .catch((e) => { if (!cancelled) setError(String(e?.message || e)); });
    return () => { cancelled = true; };
  }, []);

  const traces = useMemo(() => {
    if (!data?.expirations || data.expirations.length === 0) return null;
    const xs = data.expirations.map((e) => e.expiration_date);
    const callY = data.expirations.map((e) => e.callGammaNotional || 0);
    const putY  = data.expirations.map((e) => -(e.putGammaNotional || 0));
    // Pre-format the dollar magnitudes server-side rather than relying
    // on d3-format's :$.2s in hovertemplate. The reason is that Plotly's
    // SI-suffix output uses "G" for 1e9 instead of the "B" billions
    // suffix every other label on the site uses (formatDollar above,
    // the rotation card, the heatmap card, the levels panel, etc.).
    // Pre-formatting in JS gives the tooltip the same "$945B" /
    // "$432M" voice the rest of the page uses without needing a
    // custom Plotly format locale.
    const customdata = data.expirations.map((e) => [
      formatDollar(e.callGammaNotional || 0),
      formatDollar(e.putGammaNotional || 0),
      e.callContractCount || 0,
      e.putContractCount || 0,
    ]);
    const hovertemplate =
      '<b>%{x|%b %-d, %Y}</b>' +
      '<br>Call γ: %{customdata[0]}  (%{customdata[2]} contracts)' +
      '<br>Put γ:  %{customdata[1]}  (%{customdata[3]} contracts)' +
      '<extra></extra>';
    return [
      {
        x: xs,
        y: callY,
        customdata,
        type: 'bar',
        name: 'Call γ',
        marker: { color: COLOR_CALL, opacity: BAR_OPACITY, line: { width: 0 } },
        width: BAR_WIDTH_MS,
        hovertemplate,
      },
      {
        x: xs,
        y: putY,
        customdata,
        type: 'bar',
        name: 'Put γ',
        marker: { color: COLOR_PUT, opacity: BAR_OPACITY, line: { width: 0 } },
        width: BAR_WIDTH_MS,
        hovertemplate,
      },
    ];
  }, [data]);

  useEffect(() => {
    if (!Plotly || !chartRef.current || !traces) return;

    const layout = {
      ...PLOTLY_BASE_LAYOUT_2D,
      // Keep hovermode 'closest' instead of inheriting 'x unified' from
      // the base layout — the unified layer would render two stacked
      // tooltip rows (one per trace) at the same expiration even though
      // both traces show identical customdata, making the tooltip read
      // duplicated. 'closest' surfaces a single tooltip on whichever
      // bar the cursor is over.
      hovermode: 'closest',
      // dragmode 'pan' so a reader can drag the chart horizontally
      // through the full expiration calendar even when zoomed by the
      // rangeslider; the base layout's dragmode:false is the right
      // default for non-rangeslider charts but here it would defeat
      // the slider's purpose.
      dragmode: 'pan',
      barmode: 'overlay',
      bargap: 0.1,
      margin: mobile
        ? { t: 24, r: 14, b: 60, l: 56 }
        : { t: 24, r: 24, b: 80, l: 80 },
      xaxis: plotlyAxis('', {
        type: 'date',
        title: '',
        // Auto-zoom to span [trading date, next AM monthly OPEX + 7
        // calendar days] when the server emitted a defaultWindow.
        // Plotly's rangeslider treats xaxis.range as the visible
        // window while the slider thumb shows the full series — so
        // setting an initial range here places the reader's first
        // view on the largest near-term roll-off (the next monthly
        // OPEX, an SPX-root AM-settled contract that always carries
        // the heaviest OI concentration in the front three months)
        // without losing the ability to pan back out. autorange:
        // false is required, otherwise Plotly recomputes the range
        // to fit the data on every relayout and the slider thumb
        // snaps back to the full series after the first hover. The
        // rangeslider gets its own explicit range matching the data
        // domain so the slider track stays the same regardless of
        // the visible-window auto-zoom.
        ...(data?.defaultWindow
          ? {
              range: [data.defaultWindow.start, data.defaultWindow.end],
              autorange: false,
            }
          : {}),
        rangeslider: {
          visible: true,
          bordercolor: PLOTLY_COLORS.grid,
          borderwidth: 1,
          thickness: 0.07,
          bgcolor: 'rgba(20,24,32,0.5)',
        },
        showgrid: true,
        gridcolor: PLOTLY_COLORS.grid,
        griddash: 'dot',
        tickformat: '%Y-%m-%d',
        tickangle: 0,
      }),
      yaxis: plotlyAxis(mobile ? '' : 'Gamma Notional ($ per 1% move)', {
        zeroline: true,
        zerolinewidth: 1.5,
        zerolinecolor: PLOTLY_COLORS.zeroLine,
        tickformat: '$.2s',
        ticks: 'outside',
        ticklen: 6,
        tickcolor: 'transparent',
        showgrid: false,
      }),
      showlegend: false,
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: PLOTLY_COLORS.plot,
    };

    Plotly.react(chartRef.current, traces, layout, {
      responsive: true,
      displayModeBar: false,
    });
  }, [Plotly, traces, mobile, data]);

  if (plotlyError) {
    return (
      <div className="card" style={{ padding: '1rem', color: 'var(--accent-coral)' }}>
        Expiration concentration chart unavailable — Plotly failed to load ({plotlyError}).
      </div>
    );
  }

  if (error) {
    return (
      <div className="card" style={{ padding: '1rem', color: 'var(--accent-coral)' }}>
        Failed to load expiration data: {error}
      </div>
    );
  }

  if (!data) {
    return (
      <div className="card" style={{ padding: '2.5rem 1rem', textAlign: 'center', color: 'var(--text-secondary)', fontFamily: 'Courier New, monospace' }}>
        Loading expiration concentration…
      </div>
    );
  }

  return (
    <div className="card expiring-gamma-card">
      <div className="expiring-gamma-meta">
        <div className="expiring-gamma-meta__left">
          <span className="expiring-gamma-ticker">SPX</span>
          <span className="expiring-gamma-meta-line">
            {data.expirationCount} expirations · spot ${data.spotPrice.toFixed(2)}
          </span>
        </div>
        <div className="expiring-gamma-meta__right">
          <span style={{ color: COLOR_CALL, fontWeight: 700 }}>Call γ</span>
          <span style={{ opacity: 0.5 }}>/</span>
          <span style={{ color: COLOR_PUT, fontWeight: 700 }}>Put γ</span>
          <span className="expiring-gamma-asof">
            {data.asOf ? `as of ${formatAsOf(data.asOf)}` : ''}
          </span>
        </div>
      </div>
      <div className="expiring-gamma-totals">
        <span>
          <span style={{ color: COLOR_CALL, fontWeight: 700 }}>Total call γ</span>
          {' '}
          <span className="expiring-gamma-totals__value">{formatDollar(data.totalCallGammaNotional)}</span>
        </span>
        <span style={{ opacity: 0.4 }}>·</span>
        <span>
          <span style={{ color: COLOR_PUT, fontWeight: 700 }}>Total put γ</span>
          {' '}
          <span className="expiring-gamma-totals__value">{formatDollar(data.totalPutGammaNotional)}</span>
        </span>
        {data.nextAmExpiration && (
          <>
            <span style={{ opacity: 0.4 }}>·</span>
            <span>
              <span style={{ color: 'var(--text-secondary)' }}>Auto-zoomed to next ~100 days · next AM OPEX</span>
              {' '}
              <span className="expiring-gamma-totals__value">{data.nextAmExpiration}</span>
            </span>
          </>
        )}
      </div>
      <div ref={chartRef} className="expiring-gamma-chart" />
    </div>
  );
}
