import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import usePlotly from '../hooks/usePlotly';
import useIsMobile from '../hooks/useIsMobile';
import { useVrpHistory } from '../hooks/useHistoricalData';
import {
  PLOTLY_COLORS,
  PLOTLY_FONT_FAMILY,
  PLOTLY_FONTS,
  plotly2DChartLayout,
  plotlyAxis,
  plotlyTitle,
} from '../lib/plotlyTheme';
import RangeBrush from './RangeBrush';
import ResetButton from './ResetButton';

function isoToMs(iso) {
  return new Date(`${iso}T00:00:00Z`).getTime();
}

function msToIso(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// Visual language for the VRP chart:
// - SPX price as a subtle dark-blue filled area anchored to the left y-axis,
//   drawn first so it sits behind everything else as context.
// - Realized vol (Yang-Zhang 20d) and implied vol (30d constant-maturity)
//   as two contrasting lines on the right y-axis, expressed as annualized %.
// - VIX (Cboe-published 30-day implied vol on SPX, sourced from Massive
//   Indices Starter via vix_family_eod and merged in by vrp-history.mjs)
//   as a third line on the same right y-axis, drawn in primary-soft blue
//   so the eye reads it as the "official" Cboe-disseminated implied vol
//   alongside the chain-derived 30d CM IV. The two implied measures
//   should track each other closely — when they diverge the gap is
//   informative about chain pricing vs Cboe's smoothing methodology.
// - Conditional fill between the chain-derived vol lines (IV vs RV): green
//   where IV > RV (positive VRP, the normal state where options price more
//   vol than has been realized), red where RV > IV (negative VRP, the rare
//   stressed state where realized has exceeded option-implied expectation).
//   These shaded bands are visually self-explanatory (green = IV above RV,
//   red = RV above IV) and carry no legend entries — the legend would just
//   restate what the colors already make obvious.
// - Legend contains the four line series (SPX, RV, IV, VIX) and sits as a
//   horizontal row in the top margin band below the chart title, so it
//   never overlaps the data area. Legend entries and the two y-axis titles
//   are rendered bold at a larger font size than Plotly's defaults so the
//   chart stays legible when the card is screenshotted and shared at
//   reduced resolution (Discord, Twitter, etc).
const POS_VRP_FILL  = 'rgba(46, 204, 113, 0.22)';
const NEG_VRP_FILL  = 'rgba(231, 76, 60, 0.38)';
const SPX_AREA_FILL = 'rgba(74, 158, 255, 0.12)';
const SPX_LINE      = 'rgba(74, 158, 255, 0.55)';
const RV_COLOR      = PLOTLY_COLORS.highlight;
const IV_COLOR      = PLOTLY_COLORS.titleText;
const VIX_COLOR     = PLOTLY_COLORS.primarySoft;

// Walk the (iv, hv) series and emit a list of contiguous same-sign
// segments, splitting at each zero crossing of (iv - hv). Each segment
// carries its own x / iv / hv arrays so the consumer can render it as
// an independent closed polygon (fill: 'toself') bounded by the two
// vol lines on both edges — no fill-down-to-axis ambiguity, no
// null-gap fragility. The zero-crossing point is computed by linear
// interpolation on both x (time) and y (iv=hv at the crossing) and
// appears as the LAST point of the outgoing segment AND the FIRST
// point of the incoming one, so adjacent polygons meet on a shared
// vertex with no gap and no overlap.
function buildVrpSegments(series) {
  const segments = [];
  if (!series || series.length === 0) return segments;

  let current = null;
  const open = (kind) => {
    current = { kind, xs: [], ivs: [], hvs: [] };
    segments.push(current);
  };
  const push = (x, iv, hv) => {
    current.xs.push(x);
    current.ivs.push(iv);
    current.hvs.push(hv);
  };

  const first = series[0];
  open(first.iv - first.hv >= 0 ? 'positive' : 'negative');
  push(first.trading_date, first.iv, first.hv);
  let prevKind = current.kind;

  for (let i = 1; i < series.length; i++) {
    const curr = series[i];
    const currKind = curr.iv - curr.hv >= 0 ? 'positive' : 'negative';
    if (currKind !== prevKind) {
      const prev = series[i - 1];
      const prevDelta = prev.iv - prev.hv;
      const currDelta = curr.iv - curr.hv;
      const t = Math.abs(prevDelta) / (Math.abs(prevDelta) + Math.abs(currDelta));
      const prevMs = new Date(`${prev.trading_date}T00:00:00Z`).getTime();
      const currMs = new Date(`${curr.trading_date}T00:00:00Z`).getTime();
      const xCross = new Date(prevMs + t * (currMs - prevMs)).toISOString().slice(0, 10);
      const yCross = prev.iv + t * (curr.iv - prev.iv);
      push(xCross, yCross, yCross);
      open(currKind);
      push(xCross, yCross, yCross);
    }
    push(curr.trading_date, curr.iv, curr.hv);
    prevKind = currKind;
  }
  return segments;
}

// Wrap one segment as a single fill:'toself' closed polygon. The
// polygon walks the IV edge forward in time and the HV edge backward,
// so the filled region is exactly the area between the two lines over
// this segment's x-range — never reaching the axis floor, never
// extending past the segment's boundaries. The fill color itself is the
// only cue these polygons contribute to the chart — no legend entry, no
// hover — so the reader's focus stays on the three labeled line series.
function vrpSegmentTrace(segment, fillcolor) {
  return {
    x: [...segment.xs, ...segment.xs.slice().reverse()],
    y: [...segment.ivs, ...segment.hvs.slice().reverse()],
    fill: 'toself',
    fillcolor,
    line: { color: 'rgba(0,0,0,0)', width: 0 },
    mode: 'lines',
    type: 'scatter',
    yaxis: 'y2',
    showlegend: false,
    hoverinfo: 'skip',
  };
}

function addMonthsIso(iso, months) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

export default function VolatilityRiskPremium({ spotPrice, capturedAt }) {
  const chartRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();
  const { data, loading, error } = useVrpHistory({});
  const mobile = useIsMobile();
  const [timeRange, setTimeRange] = useState(null);

  // Series visibility state. The chart's legend has been replaced by the
  // outlined toggle row rendered in JSX below the chart card; clicking a
  // toggle flips its key here, the useEffect picks the new value up via
  // dependency, and the corresponding trace's `visible` prop swaps
  // between `true` (drawn) and 'legendonly' (registered with Plotly so
  // the y-axis range still considers it but no line is rendered). VIX is
  // off by default so the chart loads with the original three vol series
  // (SPX, RV, IV) visible — the addition of VIX is opt-in for readers who
  // want to compare the Cboe-published implied vol against the chain-
  // derived implied vol.
  const [traceVisibility, setTraceVisibility] = useState({
    SPX: true,
    RV: true,
    IV: true,
    VIX: false,
  });
  const toggleTrace = useCallback((key) => {
    setTraceVisibility((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const series = useMemo(() => {
    if (!data?.series) return [];
    return data.series
      .filter((r) => r.iv_30d_cm != null && r.hv_20d_yz != null && r.spx_close != null)
      .map((r) => ({
        trading_date: r.trading_date,
        spx_close: r.spx_close,
        iv: r.iv_30d_cm * 100,
        hv: r.hv_20d_yz * 100,
        // VIX comes back as the raw Cboe value (e.g. 18.71), already in
        // percent units. Pre-2023-03 rows have null because the Massive
        // Indices Starter backfill window starts there; the trace is built
        // null-tolerantly so the line just begins at the first available
        // VIX date rather than dragging the whole series down to zero.
        vix: r.vix != null ? Number(r.vix) : null,
      }));
  }, [data]);

  // The VRP history API only contains EOD daily aggregates, so its latest
  // row is the prior trading day's close. Extend the SPX series with the
  // live intraday spot price (via data.spotPrice from the main dashboard's
  // Massive snapshot) so the rightmost point reflects where SPX actually
  // is right now rather than yesterday's settle — otherwise the line can
  // sit visually far below today's level on a fast-moving session.
  const spxSeries = useMemo(() => {
    if (!data?.series) return [];
    const base = data.series
      .filter((r) => r.spx_close != null)
      .map((r) => ({ trading_date: r.trading_date, spx_close: r.spx_close }));
    if (spotPrice != null && capturedAt) {
      const todayIso = capturedAt.slice(0, 10);
      const lastIso = base.length > 0 ? base[base.length - 1].trading_date : null;
      if (!lastIso || todayIso > lastIso) {
        base.push({ trading_date: todayIso, spx_close: spotPrice });
      }
    }
    return base;
  }, [data, spotPrice, capturedAt]);

  const vrpSegments = useMemo(() => buildVrpSegments(series), [series]);

  useEffect(() => {
    if (!Plotly || !chartRef.current || series.length === 0 || spxSeries.length === 0) return;

    const firstDate = series[0].trading_date;
    const lastDate = spxSeries[spxSeries.length - 1].trading_date;
    // Default zoom: last 6 calendar months. The external brush exposes the
    // full backfill range, so the user can drag the left handle out to see
    // the April 2025 tariff vol spike and the months of negative VRP.
    const sixMonthsBack = addMonthsIso(lastDate, -6);
    const defaultStart = sixMonthsBack >= firstDate ? sixMonthsBack : firstDate;
    const windowStart = timeRange ? timeRange[0] : defaultStart;
    const windowEnd = timeRange ? timeRange[1] : lastDate;

    // Compute y-axis ranges from the full series (back to the ThetaData
    // Index Standard floor at 2022-01-03 when SPX was ~3577). With spxMin
    // anchored at that historical low, the 0.95 padding puts spxLo well
    // below any value in a recent zoom, which naturally pins the SPX line
    // to the top ~15-20% of the chart — the visual layout that separates
    // SPX context cleanly from the IV/RV ribbon below.
    const spxMin = Math.min(...spxSeries.map((r) => r.spx_close));
    const spxMax = Math.max(...spxSeries.map((r) => r.spx_close));
    const spxLo = spxMin * 0.95;
    const spxHi = spxMax * 1.02;

    // Closed polygon for the SPX area — close series along the top,
    // constant axis-floor along the bottom. `fill: 'toself'` + the
    // reversed-x trick avoids the y=0 waste that `fill: 'tozeroy'`
    // would produce on a chart whose y-axis floor sits far above zero.
    const spxDates = spxSeries.map((r) => r.trading_date);
    const spxClose = spxSeries.map((r) => r.spx_close);
    const spxAreaTrace = {
      x: [...spxDates, ...spxDates.slice().reverse()],
      y: [...spxClose, ...spxClose.map(() => spxLo)],
      fill: 'toself',
      fillcolor: SPX_AREA_FILL,
      line: { color: 'rgba(0,0,0,0)', width: 0 },
      mode: 'lines',
      type: 'scatter',
      hoverinfo: 'skip',
      yaxis: 'y',
      showlegend: false,
    };
    const spxLineTrace = {
      x: spxDates,
      y: spxClose,
      mode: 'lines',
      type: 'scatter',
      line: { color: SPX_LINE, width: 1.5 },
      yaxis: 'y',
      name: '<b>SPX</b>',
      hovertemplate: '%{x}<br>SPX: %{y:,.2f}<extra></extra>',
    };

    // VRP shading is one closed-polygon trace per contiguous same-sign
    // segment. Each polygon is bounded on both edges by the two vol
    // lines themselves, so the fill is a thin ribbon that expands and
    // contracts with the spread — it never drops down to the chart
    // floor the way a fill:'tonexty' pair would on a null-gapped series.
    // None of these polygons contribute a legend entry — their meaning
    // is carried entirely by color (green = positive VRP, red = negative).
    const vrpTraces = [];
    for (const seg of vrpSegments) {
      if (seg.xs.length < 2) continue;
      const fill = seg.kind === 'positive' ? POS_VRP_FILL : NEG_VRP_FILL;
      vrpTraces.push(vrpSegmentTrace(seg, fill));
    }

    const rvLine = {
      x: series.map((r) => r.trading_date),
      y: series.map((r) => r.hv),
      mode: 'lines',
      type: 'scatter',
      line: { color: RV_COLOR, width: 2 },
      yaxis: 'y2',
      name: `<span style="color: ${RV_COLOR}"><b>Realized Vol (20d YZ)</b></span>`,
      hovertemplate: '%{x}<br>RV: %{y:.2f}%<extra></extra>',
    };
    const ivLine = {
      x: series.map((r) => r.trading_date),
      y: series.map((r) => r.iv),
      mode: 'lines',
      type: 'scatter',
      line: { color: IV_COLOR, width: 2 },
      yaxis: 'y2',
      name: '<b>Implied Vol (30d CM)</b>',
      hovertemplate: '%{x}<br>IV: %{y:.2f}%<extra></extra>',
    };

    // VIX trace — Cboe-published 30d implied vol on SPX, sourced via the
    // Massive Indices Starter backfill in vix_family_eod and merged into
    // the vrp-history payload by date. Filtered to rows where vix is
    // non-null so the line starts at the Massive backfill floor (2023-03)
    // and doesn't drag through pre-2023 dates as a flat line at zero.
    // Drawn at width 1.5 to sit slightly behind the bolder IV/RV pair —
    // VIX is an additional reference, not a primary measurement.
    const vixSeries = series.filter((r) => r.vix != null);
    const vixLine = {
      x: vixSeries.map((r) => r.trading_date),
      y: vixSeries.map((r) => r.vix),
      mode: 'lines',
      type: 'scatter',
      line: { color: VIX_COLOR, width: 1.5 },
      yaxis: 'y2',
      name: `<span style="color: ${VIX_COLOR}"><b>VIX</b></span>`,
      hovertemplate: '%{x}<br>VIX: %{y:.2f}<extra></extra>',
    };

    // Trace order encodes z-order in Plotly: later traces render on top of
    // earlier ones. The SPX area fill stays first so it sits behind the VRP
    // ribbon as context background, but the SPX line itself is pushed to the
    // END of the list so it renders on top of the RV/IV/VIX lines and the
    // VRP polygons wherever their paths cross. VIX sits between the VRP
    // polygons and the chain-derived IV/RV pair so the chain measurements
    // remain on top — VIX is the reference, IV/RV is the primary content.
    //
    // Each toggleable trace is included via spread+conditional so the array
    // contains only the traces the reader has asked to see. An earlier
    // version used Plotly's `visible: 'legendonly'` mechanism but Plotly.react
    // wasn't reliably picking up visibility transitions when the legend
    // itself was suppressed (showlegend: false), leaving toggled-on traces
    // invisible after the click — readers couldn't enable VIX even though
    // the toggle button was firing the state update. Conditional inclusion
    // avoids the visibility-vs-legend interaction entirely. The y-axis
    // range computation below uses ALL series (regardless of visibility) so
    // the chart doesn't jump when a trace is added or removed.
    const traces = [
      ...(traceVisibility.SPX ? [spxAreaTrace] : []),
      ...vrpTraces,
      ...(traceVisibility.VIX ? [vixLine] : []),
      ...(traceVisibility.RV ? [rvLine] : []),
      ...(traceVisibility.IV ? [ivLine] : []),
      ...(traceVisibility.SPX ? [spxLineTrace] : []),
    ];

    // Vol axis is windowed to the active zoom (unlike the SPX axis, which
    // uses the full backfill to pin SPX at the top). Using the full series
    // here would inflate volMax with historical shocks — the April 2025
    // tariff spike at ~65%, the 2022 inflation regime at ~50% — and
    // compress typical 15-25% IV/RV readings into a sliver at the bottom
    // of the chart, leaving a big empty band in the middle. Windowing lets
    // the IV/RV ribbon fill its natural vertical extent so the right axis
    // visually balances the SPX strip on the left.
    const windowedSeries = series.filter(
      (r) => r.trading_date >= windowStart && r.trading_date <= windowEnd,
    );
    const volSource = windowedSeries.length > 0 ? windowedSeries : series;
    // Include VIX in the y-axis range so the new line never clips outside
    // the visible vol band. VIX often spikes further than the chain-derived
    // IV (it's a wider-strike calculation that reaches further into the
    // OTM-put wings), so omitting it from the range computation would
    // truncate the top of any vol-spike day.
    const volValues = volSource.flatMap((r) => [
      r.iv,
      r.hv,
      ...(r.vix != null ? [r.vix] : []),
    ]);
    const volMin = Math.min(...volValues);
    const volMax = Math.max(...volValues);
    const volLo = Math.max(0, volMin * 0.85);
    const volHi = volMax * 1.1;

    // Top margin only has to hold the chart title now — the horizontal
    // legend row was replaced by the outlined HTML toggle row rendered
    // above the chart in JSX, so the in-SVG legend is gone and the
    // title-to-data band can be tighter. Left margin matches the 80px
    // used on GammaInflectionChart and GexProfile so the SPX axis sits
    // flush with the other charts on the page; the bolder 20px y-axis
    // title fits inside that budget by trimming the standoff from 30px
    // to 10px, which still reads as deliberate padding between the
    // rotated title and the right-edge tick labels without wasting the
    // card's left margin on a huge title-to-tick gap. Right margin is
    // left at 115px because the right y-axis ("Implied Volatility") still
    // carries the 30px standoff.
    const axisTitleFont = {
      family: PLOTLY_FONT_FAMILY,
      color: PLOTLY_COLORS.titleText,
      size: 20,
    };
    const layout = plotly2DChartLayout({
      margin: mobile ? { t: 45, r: 50, b: 40, l: 50 } : { t: 50, r: 115, b: 45, l: 80 },
      title: {
        ...plotlyTitle('Volatility Risk Premium'),
        y: 0.97,
        yref: 'container',
        yanchor: 'top',
      },
      xaxis: plotlyAxis('', {
        type: 'date',
        range: [windowStart, windowEnd],
        autorange: false,
      }),
      yaxis: {
        ...plotlyAxis('', {
          range: [spxLo, spxHi],
          autorange: false,
          tickformat: ',.0f',
          side: 'left',
          showgrid: false,
          ticks: 'outside',
          ticklen: 8,
          tickcolor: 'rgba(0,0,0,0)',
          tickfont: { ...PLOTLY_FONTS.axisTick, color: PLOTLY_COLORS.primarySoft },
        }),
        title: mobile ? { text: '' } : {
          text: 'SPX',
          font: { ...axisTitleFont, color: PLOTLY_COLORS.primarySoft },
          standoff: 10,
        },
      },
      yaxis2: {
        ...plotlyAxis('', {
          range: [volLo, volHi],
          autorange: false,
          tickformat: '.1f',
          ticksuffix: '%',
          side: 'right',
          overlaying: 'y',
          ticks: 'outside',
          ticklen: 8,
          tickcolor: 'rgba(0,0,0,0)',
        }),
        title: mobile ? { text: '' } : {
          text: 'Implied Volatility',
          font: axisTitleFont,
          standoff: 30,
        },
      },
      // Legend is rendered as a row of outlined HTML toggle buttons
      // above the chart card in JSX (see the .vrp-toggle-row block in
      // the return statement); Plotly's native legend is suppressed
      // because the HTML buttons carry both the visual cue (boxed,
      // colored borders) and the click-to-toggle interaction.
      showlegend: false,
      hovermode: 'x unified',
    });

    Plotly.react(chartRef.current, traces, layout, {
      responsive: true,
      displayModeBar: false,
    });
  }, [Plotly, series, vrpSegments, spxSeries, mobile, timeRange, traceVisibility]);

  const handleBrushChange = useCallback((minMs, maxMs) => {
    setTimeRange([msToIso(minMs), msToIso(maxMs)]);
  }, []);

  if (plotlyError) {
    return (
      <div className="card" style={{ padding: '1rem', marginBottom: '1rem', color: 'var(--accent-coral)' }}>
        Volatility risk premium unavailable — Plotly failed to load ({plotlyError}).
      </div>
    );
  }
  if (error) {
    return (
      <div className="card" style={{ padding: '1rem', marginBottom: '1rem', color: 'var(--accent-coral)' }}>
        VRP history fetch failed: {error}
      </div>
    );
  }
  if (loading) {
    return <div className="skeleton-card" style={{ height: '580px', marginBottom: '1rem' }} />;
  }
  if (!data || series.length === 0) {
    return (
      <div className="card text-muted" style={{ marginBottom: '1rem' }}>
        No VRP history available yet — the volatility stats backfill has not populated daily_volatility_stats.
      </div>
    );
  }

  const firstDate = series[0].trading_date;
  const lastDate = spxSeries[spxSeries.length - 1].trading_date;
  const sixMonthsBack = addMonthsIso(lastDate, -6);
  const defaultStart = sixMonthsBack >= firstDate ? sixMonthsBack : firstDate;
  const activeMinIso = timeRange ? timeRange[0] : defaultStart;
  const activeMaxIso = timeRange ? timeRange[1] : lastDate;

  // Outlined toggle row that replaces the native Plotly legend. Each
  // button is bordered in the trace's own color and renders the trace
  // name in that same color when active; when toggled off the border
  // fades to bg-card-border and the text dims to text-secondary, so
  // the active/inactive distinction reads at a glance. The boxed
  // styling makes the affordance obvious — the previous Plotly legend
  // entries were technically clickable toggles but didn't visually
  // signal that, leading readers to miss the interaction.
  const toggles = [
    { key: 'SPX', label: 'SPX',                         color: SPX_LINE   },
    { key: 'RV',  label: 'Realized Vol (20d YZ)',       color: RV_COLOR   },
    { key: 'IV',  label: 'Implied Vol (30d CM)',        color: IV_COLOR   },
    { key: 'VIX', label: 'VIX',                         color: VIX_COLOR  },
  ];

  return (
    <div className="card" style={{ marginBottom: '1rem', position: 'relative' }}>
      <ResetButton visible={timeRange != null} onClick={() => setTimeRange(null)} />
      <div ref={chartRef} style={{ width: '100%', height: '540px', backgroundColor: 'var(--bg-card)' }} />
      <div className="vrp-toggle-row" role="group" aria-label="Series visibility toggles">
        {toggles.map(({ key, label, color }) => {
          const active = traceVisibility[key];
          return (
            <button
              key={key}
              type="button"
              className="vrp-toggle"
              data-active={active}
              aria-pressed={active}
              onClick={() => toggleTrace(key)}
              style={{
                borderColor: active ? color : 'var(--bg-card-border)',
                color: active ? color : 'var(--text-secondary)',
              }}
            >
              <span className="vrp-toggle__dot" style={{ background: active ? color : 'transparent', borderColor: color }} />
              <span className="vrp-toggle__label">{label}</span>
            </button>
          );
        })}
      </div>
      <RangeBrush
        min={isoToMs(firstDate)}
        max={isoToMs(lastDate)}
        activeMin={isoToMs(activeMinIso)}
        activeMax={isoToMs(activeMaxIso)}
        onChange={handleBrushChange}
      />
    </div>
  );
}
