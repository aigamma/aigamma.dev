import { useEffect, useMemo, useRef, useState } from 'react';
import usePlotly from '../hooks/usePlotly';
import useIsMobile from '../hooks/useIsMobile';
import {
  PLOTLY_BASE_LAYOUT_2D,
  PLOTLY_COLORS,
  PLOTLY_FONTS,
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
const COLOR_CUMULATIVE_CALL = 'rgba(231, 76, 60, 0.55)';   // call coral, semi-transparent line
const COLOR_CUMULATIVE_PUT = 'rgba(74, 158, 255, 0.55)';   // put blue, semi-transparent line
const BAR_OPACITY = 0.95;
const BAR_WIDTH_MS = 12 * 60 * 60 * 1000;    // ~half a calendar day

// Per-expiration-type marker styling for the Plotly annotations
// rendered above each non-weekly bar. Quarterly Mar/Jun/Sep/Dec OPEX
// in purple to match the VIX chrome elsewhere on the site, regular
// monthly OPEX in amber, 0DTE in green, weekly suppressed (default,
// no annotation). Same color tokens as CSS custom properties so the
// chart legend in JSX can mirror them without redefining hexes.
const EXPIRATION_TYPE_TAGS = {
  '0DTE':      { label: '0DTE', color: '#2ecc71' },  // accent-green
  quarterly:   { label: 'Q',    color: '#BF7FFF' },  // accent-purple
  monthly:     { label: 'M',    color: '#f1c40f' },  // accent-amber
};

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

// Format a captured-at timestamp as a relative-time string ("12 min
// ago", "3 hours ago", "2 days ago"). Used by the stale-data pill so
// a reader can immediately tell whether the snapshot is from this
// minute's intraday tick or from last Friday's close, without having
// to parse an absolute timestamp into a freshness judgment. Returns
// "just now" for sub-minute deltas; falls through to the formatAsOf
// absolute string when the relative formatting would round to 0
// because of clock skew between the user's machine and the CDN.
function formatRelative(iso, now = Date.now()) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const ageMs = Math.max(0, now - t);
  const sec = Math.floor(ageMs / 1000);
  if (sec < 30) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
  const day = Math.floor(hr / 24);
  return `${day} day${day === 1 ? '' : 's'} ago`;
}

// Determine whether the regular cash session is currently open in ET.
// Mon-Fri 09:30-16:00 → open; otherwise closed. Holidays are NOT
// excluded here — the surface only needs to distinguish "live tick
// expected within minutes" from "snapshot frozen until next session"
// and a holiday weekday with a stale 4pm-prior-day asOf is already
// caught by the >2h staleness rule. Adding a holiday calendar would
// be redundant and create a maintenance dependency on the same date
// list the server already carries.
function isMarketOpenET(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const wd = get('weekday');
  if (wd === 'Sat' || wd === 'Sun') return false;
  const minutes = Number(get('hour')) * 60 + Number(get('minute'));
  return minutes >= 570 && minutes < 960;
}

// Distill the freshness state into a single label the meta band can
// render as a colored pill. Three states because three is the smallest
// set that distinguishes the actionable cases:
//   - LIVE (green)   — session open AND data <10 min old; trader can
//                      assume the bar heights match a fresh print
//   - STALE (amber)  — session open but data >10 min old; pipeline is
//                      lagging or paused, treat the snapshot with
//                      caution
//   - CLOSED (gray)  — session closed (after-hours, weekend, holiday);
//                      data is the most recent available but doesn't
//                      reflect any post-close trading
function classifyFreshness(asOfIso, now = new Date()) {
  if (!asOfIso) return { label: 'NO DATA', tone: 'closed' };
  const ageMs = now.getTime() - new Date(asOfIso).getTime();
  const ageMin = ageMs / 60000;
  const open = isMarketOpenET(now);
  if (!open) return { label: 'MARKET CLOSED', tone: 'closed' };
  if (ageMin <= 10) return { label: 'LIVE', tone: 'live' };
  return { label: 'STALE', tone: 'stale' };
}

// Per-day scale support — divide each expiration's $ gamma by the
// number of calendar days between this expiration and the prior one
// to convert "$ rolling off this date" into "$/day rate of rolloff
// from the prior expiration through this one." This rebalances the
// chart's visual emphasis: the front-week stack of weeklies (each
// 1-3 days from the prior expiration) gets pulled UP relative to
// the back-month monoliths (each 27-30 days from the prior monthly
// OPEX), surfacing the long tail of weeklies that the linear view
// flattens against the 5/15 + 6/18 monoliths.
//
// The first expiration in the list uses (this - tradingDate) as the
// span so the 0DTE / front-week bar gets a meaningful divisor (1 day
// for 0DTE) rather than divide-by-zero. Subsequent expirations use
// the gap to the immediately prior expiration.
//
// SCALE_MODES is the source of truth for the toggle button labels +
// y-axis title suffix; adding a third mode here automatically extends
// both the toggle UI and the axis title without further coordination.
const SCALE_MODES = [
  {
    id: 'linear',
    label: 'Linear',
    axisFormat: '$.2s',
    titleSuffix: '$ per 1% move',
    hoverSuffix: '',
  },
  {
    id: 'perDay',
    label: 'Per-day',
    axisFormat: '$.2s',
    titleSuffix: '$/day rate (per 1% move)',
    hoverSuffix: ' /day',
  },
];

function daysBetweenIso(aIso, bIso) {
  const a = new Date(`${aIso}T12:00:00Z`).getTime();
  const b = new Date(`${bIso}T12:00:00Z`).getTime();
  return Math.max(1, Math.round((a - b) / 86400000));
}

// English ordinal suffix for the percentile pill labels. The previous
// hardcoded "th" suffix produced "3th" / "1th" / "22th" — wrong for
// 1/2/3 and the 21/22/23 / 31/32/33 / etc decades. The 11/12/13
// exception is the standard rule (eleventh / twelfth / thirteenth all
// take "th"). Reads at a glance: "80th", "1st", "23rd", "12th".
function ordinalSuffix(n) {
  const v = Math.abs(n) % 100;
  if (v >= 11 && v <= 13) return 'th';
  switch (v % 10) {
    case 1: return 'st';
    case 2: return 'nd';
    case 3: return 'rd';
    default: return 'th';
  }
}

export default function ExpiringGamma() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [scaleMode, setScaleMode] = useState('linear');
  // Tick once a minute so the "X min ago" relative-time pill stays
  // accurate without forcing a full re-fetch. 60s is the right cadence
  // for minute-resolution labels — anything finer is wasted re-renders
  // and anything coarser would let "1 min ago" linger as truth past
  // the threshold where it's silently turned into "2 min ago".
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(id);
  }, []);
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

  const freshness = useMemo(() => classifyFreshness(data?.asOf, now), [data?.asOf, now]);
  const relativeAsOf = useMemo(() => formatRelative(data?.asOf, now.getTime()), [data?.asOf, now]);

  const traces = useMemo(() => {
    if (!data?.expirations || data.expirations.length === 0) return null;
    const xs = data.expirations.map((e) => e.expiration_date);
    // Compute per-expiration day-spans for the per-day scale mode. The
    // first expiration's span is to the trading_date (so 0DTE → 1 day);
    // each subsequent expiration's span is to the immediately prior
    // expiration in the sorted list. The dataPerDay variant divides
    // each $ gamma value by its span; the linear variant ignores spans
    // and uses raw $ gamma. Pre-computing both arrays makes the
    // useMemo invalidation cheap on toggle (no per-row arithmetic on
    // every re-render).
    const tradingDate = data.tradingDate || data.expirations[0]?.expiration_date;
    const spans = data.expirations.map((e, i) => {
      const prior = i === 0 ? tradingDate : data.expirations[i - 1].expiration_date;
      return daysBetweenIso(e.expiration_date, prior);
    });
    const perDay = scaleMode === 'perDay';
    const callY = data.expirations.map((e, i) => {
      const v = e.callGammaNotional || 0;
      return perDay ? v / spans[i] : v;
    });
    const putY = data.expirations.map((e, i) => {
      const v = e.putGammaNotional || 0;
      return perDay ? -(v / spans[i]) : -v;
    });
    const cumCallY = data.expirations.map((e) => e.cumulativeCallPct);
    const cumPutY  = data.expirations.map((e) => e.cumulativePutPct);
    // Pre-format the dollar magnitudes server-side rather than relying
    // on d3-format's :$.2s in hovertemplate. The reason is that Plotly's
    // SI-suffix output uses "G" for 1e9 instead of the "B" billions
    // suffix every other label on the site uses (formatDollar above,
    // the rotation card, the heatmap card, the levels panel, etc.).
    // Pre-formatting in JS gives the tooltip the same "$945B" /
    // "$432M" voice the rest of the page uses without needing a
    // custom Plotly format locale.
    //
    // In per-day mode the formatted values get a "/day" suffix and
    // are pre-divided by the span so the tooltip reads "$5B /day"
    // instead of "$5B" — matches the y-axis labels in the same mode.
    const hoverSuffix = perDay ? ' /day' : '';
    const customdata = data.expirations.map((e, i) => [
      formatDollar(perDay ? (e.callGammaNotional || 0) / spans[i] : (e.callGammaNotional || 0)) + hoverSuffix,
      formatDollar(perDay ? (e.putGammaNotional || 0) / spans[i] : (e.putGammaNotional || 0)) + hoverSuffix,
      e.callContractCount || 0,
      e.putContractCount || 0,
      e.cumulativeCallPct == null ? '—' : `${e.cumulativeCallPct.toFixed(0)}%`,
      e.cumulativePutPct == null ? '—' : `${e.cumulativePutPct.toFixed(0)}%`,
      spans[i],
    ]);
    const hovertemplate =
      '<b>%{x|%b %-d, %Y}</b>' +
      (perDay ? '<br><i>%{customdata[6]} day span</i>' : '') +
      '<br>Call γ: %{customdata[0]}  (%{customdata[2]} contracts)' +
      '<br>Put γ:  %{customdata[1]}  (%{customdata[3]} contracts)' +
      '<br>Cumulative C/P: %{customdata[4]} / %{customdata[5]}' +
      '<extra></extra>';
    // Cumulative-rolloff overlay traces. Two thin step lines on a
    // 0-100 secondary y-axis (yaxis2, see layout below) — one for the
    // running cumulative call γ share and one for puts. Plotted as
    // mode='lines+markers' with a thin dotted line + small markers at
    // each expiration so the reader sees both the gradient (line
    // slope = how front-loaded the rolloff is at this date) and the
    // discrete sampling points (markers anchor each step to its
    // expiration). Both lines rise monotonically from low% at the
    // first expiration to 100% at the last; the visual gap between
    // them at any date answers "is the put book more front-loaded
    // than the call book?" — the dealer-positioning question that
    // raw-magnitude bars can't answer at a glance.
    //
    // hoverinfo='skip' on the cumulative traces because the bar
    // tooltip already surfaces both cumulative percentages via the
    // customdata pre-format above; a second tooltip on each marker
    // would duplicate the rows and clutter the hover surface.
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
      {
        x: xs,
        y: cumCallY,
        type: 'scatter',
        mode: 'lines+markers',
        name: 'Cumulative call %',
        yaxis: 'y2',
        line: { color: COLOR_CUMULATIVE_CALL, width: 1.5, dash: 'dot', shape: 'hv' },
        marker: { color: COLOR_CUMULATIVE_CALL, size: 4, line: { width: 0 } },
        hoverinfo: 'skip',
      },
      {
        x: xs,
        y: cumPutY,
        type: 'scatter',
        mode: 'lines+markers',
        name: 'Cumulative put %',
        yaxis: 'y2',
        line: { color: COLOR_CUMULATIVE_PUT, width: 1.5, dash: 'dot', shape: 'hv' },
        marker: { color: COLOR_CUMULATIVE_PUT, size: 4, line: { width: 0 } },
        hoverinfo: 'skip',
      },
    ];
  }, [data]);

  // Plotly annotations rendering the per-bar expiration-type tag
  // (0DTE / Q / M) above each non-weekly bar. Weekly expirations are
  // the default and don't get a tag so the chart stays uncluttered;
  // the annotated bars are precisely the structural-gamma dates a
  // reader cares about (front 0DTE wall + every monthly OPEX +
  // every quarterly OPEX).
  //
  // Anchored to the bar's date on x and the bar's call γ value on y
  // (since calls render upward), with yshift to lift the tag above
  // the bar top by a fixed pixel offset that doesn't depend on the
  // y-axis scale. The bar value uses the same per-day vs linear
  // transform the traces use so the tag stays anchored to the bar
  // top in either scale mode.
  const expirationTypeAnnotations = useMemo(() => {
    if (!data?.expirations) return [];
    const tradingDate = data.tradingDate || data.expirations[0]?.expiration_date;
    return data.expirations
      .map((e, i) => {
        const tag = EXPIRATION_TYPE_TAGS[e.expirationType];
        if (!tag) return null;
        const prior = i === 0 ? tradingDate : data.expirations[i - 1].expiration_date;
        const span = daysBetweenIso(e.expiration_date, prior);
        const rawCall = e.callGammaNotional || 0;
        const yVal = scaleMode === 'perDay' ? rawCall / span : rawCall;
        return {
          x: e.expiration_date,
          y: yVal,
          xref: 'x',
          yref: 'y',
          text: tag.label,
          showarrow: false,
          yshift: 14,
          font: {
            family: 'Courier New, monospace',
            color: tag.color,
            size: 10,
          },
          bgcolor: 'rgba(13, 16, 22, 0.85)',
          bordercolor: tag.color,
          borderwidth: 1,
          borderpad: 2,
        };
      })
      .filter(Boolean);
  }, [data, scaleMode]);

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
      yaxis: plotlyAxis(
        mobile
          ? ''
          : scaleMode === 'perDay'
            ? 'Gamma Notional ($/day rate, per 1% move)'
            : 'Gamma Notional ($ per 1% move)',
        {
          zeroline: true,
          zerolinewidth: 1.5,
          zerolinecolor: PLOTLY_COLORS.zeroLine,
          tickformat: '$.2s',
          ticks: 'outside',
          ticklen: 6,
          tickcolor: 'transparent',
          showgrid: false,
        }
      ),
      // Secondary y-axis for the cumulative-rolloff lines. Fixed
      // domain [0, 100] so the percent reading is always anchored —
      // no autorange wobble between snapshots. side: 'right' puts
      // the % ticks on the opposite edge from the dollar gamma ticks
      // so the two scales don't share a label column. overlaying:
      // 'y' makes Plotly draw both axes inside the same plot area
      // rather than stacking them in separate subplots; the
      // cumulative line then reads as a literal overlay on the bar
      // chart, which is the desired "where is the bar height vs.
      // the cumulative line" comparison.
      yaxis2: {
        ...plotlyAxis(mobile ? '' : 'Cumulative %', {
          range: [0, 105],
          autorange: false,
          side: 'right',
          overlaying: 'y',
          ticksuffix: '%',
          tickvals: [0, 25, 50, 75, 100],
          showgrid: false,
          ticks: 'outside',
          ticklen: 4,
          tickcolor: 'transparent',
          tickfont: { ...PLOTLY_FONTS.axisTick, color: '#8a8f9c' },
        }),
        title: mobile ? { text: '' } : {
          text: 'Cumulative %',
          font: { ...PLOTLY_FONTS.axisTitleBold, color: '#8a8f9c' },
          standoff: 10,
        },
      },
      annotations: expirationTypeAnnotations,
      showlegend: false,
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: PLOTLY_COLORS.plot,
    };

    Plotly.react(chartRef.current, traces, layout, {
      responsive: true,
      displayModeBar: false,
    });
  }, [Plotly, traces, expirationTypeAnnotations, mobile, data, scaleMode]);

  if (plotlyError) {
    return (
      <div className="card" style={{ padding: '1rem', color: 'var(--accent-coral)' }}>
        Expiration concentration chart unavailable: Plotly failed to load ({plotlyError}).
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
          {/* Scale mode toggle. Two-position rather than three because
              a log y-axis breaks the diverging-bar metaphor — bars are
              anchored at y=0 and a log axis can't position them
              meaningfully without inventing a synthetic floor. The
              per-day mode achieves the same long-tail-surfacing goal
              that log would have served and stays compatible with the
              call-up / put-down geometry. */}
          <div className="expiring-gamma-scale-toggle" role="group" aria-label="Y-axis scale">
            {SCALE_MODES.map((mode) => {
              const active = mode.id === scaleMode;
              return (
                <button
                  key={mode.id}
                  type="button"
                  className={
                    'expiring-gamma-scale-toggle__btn' +
                    (active ? ' expiring-gamma-scale-toggle__btn--active' : '')
                  }
                  aria-pressed={active}
                  title={mode.id === 'perDay'
                    ? 'Divide each bar by the days since the prior expiration. Surfaces the front-week tail'
                    : 'Raw $ gamma per expiration'}
                  onClick={() => setScaleMode(mode.id)}
                >
                  {mode.label}
                </button>
              );
            })}
          </div>
        </div>
        <div className="expiring-gamma-meta__right">
          <span style={{ color: COLOR_CALL, fontWeight: 700 }}>Call γ</span>
          <span style={{ opacity: 0.5 }}>/</span>
          <span style={{ color: COLOR_PUT, fontWeight: 700 }}>Put γ</span>
          {/* Freshness pill: distinguishes a live intraday tick from a
              stale snapshot from a closed market. The colored pill
              gives the at-a-glance read; the relative-time text next
              to it gives the precise age so a reader can tell "2 min
              ago" (still useful) from "2 days ago" (use with care). */}
          <span
            className={`expiring-gamma-freshness expiring-gamma-freshness--${freshness.tone}`}
            title={data.asOf ? `as of ${formatAsOf(data.asOf)}` : ''}
          >
            {freshness.label}
          </span>
          <span className="expiring-gamma-asof">{relativeAsOf}</span>
        </div>
      </div>
      <div className="expiring-gamma-totals">
        <span>
          <span style={{ color: COLOR_CALL, fontWeight: 700 }}>Total call γ</span>
          {' '}
          <span className="expiring-gamma-totals__value">{formatDollar(data.totalCallGammaNotional)}</span>
          {/* 30d percentile pill — only renders when the server returned
              a non-null rank (sample size >= 5). The tooltip carries
              the sample size so a reader investigating an unexpected
              rank can see whether it's vs. 5 days or vs. 30. */}
          {data.historicalCallPercentile != null && (
            <span
              className="expiring-gamma-pctile"
              title={`vs ${data.historicalSampleSize}d historical EOD call γ distribution`}
            >
              {data.historicalCallPercentile}{ordinalSuffix(data.historicalCallPercentile)}
            </span>
          )}
        </span>
        <span style={{ opacity: 0.4 }}>·</span>
        <span>
          <span style={{ color: COLOR_PUT, fontWeight: 700 }}>Total put γ</span>
          {' '}
          <span className="expiring-gamma-totals__value">{formatDollar(data.totalPutGammaNotional)}</span>
          {data.historicalPutPercentile != null && (
            <span
              className="expiring-gamma-pctile"
              title={`vs ${data.historicalSampleSize}d historical EOD put γ distribution`}
            >
              {data.historicalPutPercentile}{ordinalSuffix(data.historicalPutPercentile)}
            </span>
          )}
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
      {/* Chart-legend strip below the bars. Two roles: (1) name the new
          dotted overlay traces so a reader doesn't have to hover or
          guess that the dotted line is the cumulative %; (2) name
          the per-bar Q / M / 0DTE tags with their color swatches.
          Anchored as a flex row so it wraps cleanly on mobile, where
          the chart itself doesn't have room for the legend inside
          the plot area. */}
      <div className="expiring-gamma-chart-legend">
        <span className="expiring-gamma-chart-legend__item">
          <span className="expiring-gamma-chart-legend__line" style={{ borderColor: COLOR_CUMULATIVE_CALL }} />
          Cumulative call %
        </span>
        <span className="expiring-gamma-chart-legend__item">
          <span className="expiring-gamma-chart-legend__line" style={{ borderColor: COLOR_CUMULATIVE_PUT }} />
          Cumulative put %
        </span>
        <span className="expiring-gamma-chart-legend__divider">·</span>
        <span className="expiring-gamma-chart-legend__item">
          <span className="expiring-gamma-chart-legend__chip" style={{ borderColor: EXPIRATION_TYPE_TAGS['0DTE'].color, color: EXPIRATION_TYPE_TAGS['0DTE'].color }}>0DTE</span>
          same-day
        </span>
        <span className="expiring-gamma-chart-legend__item">
          <span className="expiring-gamma-chart-legend__chip" style={{ borderColor: EXPIRATION_TYPE_TAGS.quarterly.color, color: EXPIRATION_TYPE_TAGS.quarterly.color }}>Q</span>
          quarterly OPEX
        </span>
        <span className="expiring-gamma-chart-legend__item">
          <span className="expiring-gamma-chart-legend__chip" style={{ borderColor: EXPIRATION_TYPE_TAGS.monthly.color, color: EXPIRATION_TYPE_TAGS.monthly.color }}>M</span>
          monthly OPEX
        </span>
      </div>
    </div>
  );
}
