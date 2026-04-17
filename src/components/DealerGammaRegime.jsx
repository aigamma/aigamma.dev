import { useEffect, useMemo, useRef } from 'react';
import usePlotly from '../hooks/usePlotly';
import useIsMobile from '../hooks/useIsMobile';
import { useGexHistory } from '../hooks/useHistoricalData';
import {
  PLOTLY_COLORS,
  PLOTLY_FONT_FAMILY,
  PLOTLY_FONTS,
  plotly2DChartLayout,
  plotlyAxis,
  plotlyRangeslider,
  plotlyTitle,
} from '../lib/plotlyTheme';

// SPX price as a thin connecting line with regime-colored dots overlaid.
// Green dots = positive gamma (dealers dampen moves, spot >= vol flip).
// Red dots = negative gamma (dealers amplify moves, spot < vol flip).
// Brush zoom via rangeslider defaults to the last 6 months with the full
// historical range available for expansion. Marker size, marker opacity,
// AND the y-axis range are all recomputed on every rangeslider drag — the
// dots grow into larger semi-transparent spheres as the user zooms in,
// and the SPX y-axis tightens to exactly the visible window's min/max so
// intraday detail is not flattened by distant out-of-view highs or lows.

const LINE_COLOR = 'rgba(138, 143, 156, 0.35)';

function addMonthsIso(iso, months) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

// Count entries in a sorted ISO-date array that fall within [lo, hi]
// inclusive. Linear scan — fine for the ~2500-point history we render.
function countInRange(sortedDates, lo, hi) {
  let count = 0;
  for (const d of sortedDates) {
    if (d >= lo && d <= hi) count++;
  }
  return count;
}

// Compute a tight y-axis range (5% padded) over only the closes whose
// matching date falls inside [xStart, xEnd] inclusive. Returns null if no
// points fall in the window, in which case callers should leave the
// existing range alone rather than collapsing the axis to a degenerate
// span.
function computeYRange(allDates, allCloses, xStart, xEnd) {
  let yMin = Infinity;
  let yMax = -Infinity;
  for (let i = 0; i < allDates.length; i++) {
    if (allDates[i] >= xStart && allDates[i] <= xEnd) {
      const v = allCloses[i];
      if (v < yMin) yMin = v;
      if (v > yMax) yMax = v;
    }
  }
  if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) return null;
  if (yMax === yMin) {
    const pad = Math.max(yMin * 0.01, 1);
    return [yMin - pad, yMax + pad];
  }
  const pad = (yMax - yMin) * 0.06;
  return [yMin - pad, yMax + pad];
}

// Scale marker diameter so dots fill roughly sqrt(pixels-per-point) of
// their x-axis slot. At the default 6-month view (~125 trading days on a
// ~900px-wide card) this gives ~11px dots; zooming to 1 month pushes them
// to ~27px and saturates at the 30px ceiling, which is about the point
// where overlapping spheres start to blend meaningfully under the opacity
// curve below. The floor at 7px keeps dots visible even at full-history
// zoom-out (~2500 days).
function computeMarkerSize(visibleCount, chartWidth, mobile) {
  const minSize = mobile ? 4 : 7;
  const maxSize = mobile ? 16 : 30;
  if (visibleCount <= 0) return minSize;
  const pxPerPoint = chartWidth / visibleCount;
  const scaled = Math.sqrt(pxPerPoint) * (mobile ? 3.0 : 4.2);
  return Math.max(minSize, Math.min(maxSize, scaled));
}

// Opacity drops as the visible count rises so clusters on the zoomed-out
// view accumulate into a denser color rather than stacking as one
// flat-colored wall of dots. Clamped to [0.40, 0.70] so the dots always
// carry slight transparency — at every zoom level overlapping dots mix
// into a visibly denser color, which is what lets a cluster read as a
// cluster instead of as a single flat-filled dot sitting on top of its
// neighbors. The previous ceiling of 0.88 was effectively opaque, which
// hid cluster density.
function computeMarkerOpacity(visibleCount) {
  if (visibleCount <= 0) return 0.6;
  const opacity = 2.5 / Math.sqrt(visibleCount) + 0.40;
  return Math.max(0.40, Math.min(0.70, opacity));
}

export default function DealerGammaRegime() {
  const chartRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();
  const { data, loading, error } = useGexHistory({});
  const mobile = useIsMobile();

  const { positive, negative, allDates, allCloses } = useMemo(() => {
    if (!data?.series) return { positive: [], negative: [], allDates: [], allCloses: [] };
    const pos = [];
    const neg = [];
    const dates = [];
    const closes = [];
    for (const r of data.series) {
      if (r.spx_close == null) continue;
      dates.push(r.trading_date);
      closes.push(r.spx_close);
      if (r.regime === 'positive') {
        pos.push(r);
      } else {
        neg.push(r);
      }
    }
    return { positive: pos, negative: neg, allDates: dates, allCloses: closes };
  }, [data]);

  useEffect(() => {
    if (!Plotly || !chartRef.current || allDates.length === 0) return;

    const firstDate = allDates[0];
    const lastDate = allDates[allDates.length - 1];
    const sixMonthsBack = addMonthsIso(lastDate, -6);
    const windowStart = sixMonthsBack >= firstDate ? sixMonthsBack : firstDate;

    // Pad the visible x-axis a few days past the last data point so the
    // most recent dot renders fully inside the plot area instead of
    // being half-clipped by the right boundary. The rangeslider's own
    // range (below) stays [firstDate, lastDate] so the brush still
    // reflects the actual data range, not this display padding. The
    // relayout handler extends r1 to paddedEndIso on every drag that
    // reaches lastDate, preserving the pad at every zoom level.
    const PADDING_DAYS = 3;
    const paddedEndIso = new Date(
      new Date(`${lastDate}T00:00:00Z`).getTime() + PADDING_DAYS * 86400000,
    )
      .toISOString()
      .slice(0, 10);

    // Seed markers and y-axis range with the values that match the
    // default 6-month window so the first paint is already at the right
    // scale — big bubbles, tight vertical range, no flat-to-top artifact
    // from distant historical highs. The relayout listener recomputes
    // all three (size, opacity, y-range) on every rangeslider drag.
    const initialCount = countInRange(allDates, windowStart, lastDate);
    const chartWidth = chartRef.current.clientWidth || (mobile ? 400 : 900);
    const initialSize = computeMarkerSize(initialCount, chartWidth, mobile);
    const initialOpacity = computeMarkerOpacity(initialCount);
    const initialYRange = computeYRange(allDates, allCloses, windowStart, lastDate);

    // Thin connecting line for price continuity
    const priceLine = {
      x: allDates,
      y: allCloses,
      mode: 'lines',
      type: 'scatter',
      line: { color: LINE_COLOR, width: 1 },
      showlegend: false,
      hoverinfo: 'skip',
    };

    // Positive gamma dots (green). line.width:0 suppresses Plotly's
    // default 1px data-colored border, which at low opacity renders as
    // a distracting halo around each sphere.
    const posTrace = {
      x: positive.map((r) => r.trading_date),
      y: positive.map((r) => r.spx_close),
      mode: 'markers',
      type: 'scatter',
      marker: {
        color: PLOTLY_COLORS.positive,
        size: initialSize,
        opacity: initialOpacity,
        line: { width: 0 },
      },
      name: '<b>Positive Gamma</b>',
      hovertemplate: '%{x}<br>SPX: %{y:,.0f}<br>Positive Gamma<extra></extra>',
    };

    // Negative gamma dots (red)
    const negTrace = {
      x: negative.map((r) => r.trading_date),
      y: negative.map((r) => r.spx_close),
      mode: 'markers',
      type: 'scatter',
      marker: {
        color: PLOTLY_COLORS.negative,
        size: initialSize,
        opacity: initialOpacity,
        line: { width: 0 },
      },
      name: '<b>Negative Gamma</b>',
      hovertemplate: '%{x}<br>SPX: %{y:,.0f}<br>Negative Gamma<extra></extra>',
    };

    const legendFont = {
      family: PLOTLY_FONT_FAMILY,
      color: PLOTLY_COLORS.titleText,
      size: 18,
    };

    const layout = plotly2DChartLayout({
      margin: mobile ? { t: 45, r: 15, b: 15, l: 55 } : { t: 90, r: 30, b: 15, l: 85 },
      title: {
        ...plotlyTitle('Gamma Regime History'),
        y: 0.97,
        yref: 'container',
        yanchor: 'top',
      },
      xaxis: plotlyAxis('', {
        type: 'date',
        range: [windowStart, paddedEndIso],
        autorange: false,
        rangeslider: plotlyRangeslider({
          range: [firstDate, lastDate],
          autorange: false,
        }),
      }),
      yaxis: plotlyAxis(mobile ? '' : 'SPX', {
        tickformat: ',.0f',
        ticks: 'outside',
        ticklen: 8,
        tickcolor: 'rgba(0,0,0,0)',
        // Override the plotlyAxis default standoff (10) with a larger
        // value so the rotated "SPX" title sits well left of the tick
        // numbers (6,400 / 6,500 / ...) instead of crowding them. The
        // left margin above is widened to 85 to absorb the extra
        // offset without clipping the title.
        ...(mobile
          ? {}
          : {
              title: {
                text: 'SPX',
                font: PLOTLY_FONTS.axisTitleBold,
                standoff: 25,
              },
            }),
        ...(initialYRange ? { range: initialYRange, autorange: false } : {}),
      }),
      showlegend: !mobile,
      legend: {
        orientation: 'h',
        x: 0.5,
        y: 1.03,
        xanchor: 'center',
        yanchor: 'bottom',
        font: legendFont,
        bgcolor: 'rgba(0, 0, 0, 0)',
        borderwidth: 0,
      },
      hovermode: 'closest',
    });

    Plotly.newPlot(chartRef.current, [priceLine, posTrace, negTrace], layout, {
      responsive: true,
      displayModeBar: false,
    });

    // Recompute marker size, marker opacity, AND y-axis range whenever
    // the rangeslider brush is dragged. Plotly fires plotly_relayout
    // with the new xaxis range (either as `xaxis.range[0]/[1]` or
    // `xaxis.range` array) — both shapes are handled. Autorange resets
    // (no range keys in the event) fall back to the full series. Events
    // that carry only yaxis updates are skipped so the y-range relayout
    // we call from inside the handler does not loop back into itself;
    // the yaxis.range update we trigger fires relayout again, but that
    // second event has no xaxis keys and is filtered out at the top.
    // Plotly.restyle targets only the two scatter traces (indices 1 and
    // 2), leaving the price line alone.
    const chartEl = chartRef.current;
    const relayoutHandler = (eventData) => {
      if (!eventData) return;
      const hasXRange =
        eventData['xaxis.range[0]'] != null ||
        eventData['xaxis.range'] != null ||
        eventData['xaxis.autorange'] === true;
      if (!hasXRange) return;

      let r0 = eventData['xaxis.range[0]'] ?? eventData['xaxis.range']?.[0];
      let r1 = eventData['xaxis.range[1]'] ?? eventData['xaxis.range']?.[1];
      if (r0 == null || r1 == null) {
        if (eventData['xaxis.autorange'] !== true) return;
        r0 = firstDate;
        r1 = lastDate;
      }
      if (typeof r0 === 'string') r0 = r0.slice(0, 10);
      if (typeof r1 === 'string') r1 = r1.slice(0, 10);

      // When the user's selected window reaches the last data point,
      // extend the displayed right edge to paddedEndIso so the final
      // dot renders fully inside the plot area. effectiveR1 (clamped to
      // lastDate) is what the data-summary code below uses, so the pad
      // never contaminates the count / marker-size / y-range math.
      // Already-padded events (r1 === paddedEndIso from our own
      // relayout call) short-circuit the nested relayout because
      // displayR1 === r1 in that case, which prevents feedback looping.
      const effectiveR1 = r1 > lastDate ? lastDate : r1;
      const shouldPad = effectiveR1 === lastDate;
      const displayR1 = shouldPad ? paddedEndIso : r1;

      if (displayR1 !== r1) {
        Plotly.relayout(chartEl, { 'xaxis.range': [r0, displayR1] });
        return;
      }

      const count = countInRange(allDates, r0, effectiveR1);
      const width = chartEl.clientWidth || (mobile ? 400 : 900);
      const size = computeMarkerSize(count, width, mobile);
      const opacity = computeMarkerOpacity(count);

      Plotly.restyle(
        chartEl,
        { 'marker.size': size, 'marker.opacity': opacity },
        [1, 2],
      );

      const yRange = computeYRange(allDates, allCloses, r0, effectiveR1);
      if (yRange) {
        Plotly.relayout(chartEl, { 'yaxis.range': yRange });
      }
    };

    chartEl.on('plotly_relayout', relayoutHandler);

    return () => {
      if (chartEl?.removeAllListeners) {
        chartEl.removeAllListeners('plotly_relayout');
      }
    };
  }, [Plotly, positive, negative, allDates, allCloses, mobile]);

  if (plotlyError) {
    return (
      <div className="card" style={{ padding: '1rem', marginBottom: '1rem', color: 'var(--accent-coral)' }}>
        Dealer gamma regime unavailable — Plotly failed to load ({plotlyError}).
      </div>
    );
  }
  if (error) {
    return (
      <div className="card" style={{ padding: '1rem', marginBottom: '1rem', color: 'var(--accent-coral)' }}>
        GEX history fetch failed: {error}
      </div>
    );
  }
  if (loading) {
    return <div className="skeleton-card" style={{ height: '564px', marginBottom: '1rem' }} />;
  }
  if (!data || allDates.length === 0) {
    return (
      <div className="card text-muted" style={{ marginBottom: '1rem' }}>
        No GEX history available yet — the daily_gex_stats backfill has not been run.
      </div>
    );
  }

  return (
    <div className="card" style={{ marginBottom: '1rem' }}>
      <div ref={chartRef} style={{ width: '100%', height: '564px', backgroundColor: 'var(--bg-card)' }} />
    </div>
  );
}
