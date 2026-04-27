import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import usePlotly from '../hooks/usePlotly';
import useIsMobile from '../hooks/useIsMobile';
import { useGexHistory } from '../hooks/useHistoricalData';
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

// SPX price as a thin connecting line with regime-colored dots overlaid.
// Green dots = positive gamma (dealers dampen moves, spot >= vol flip).
// Red dots = negative gamma (dealers amplify moves, spot < vol flip).
// Brush zoom via rangeslider defaults to the last ~90 calendar days with
// the full historical range available for expansion. Marker size and the
// y-axis range are recomputed on every rangeslider drag — the dots grow
// as the user zooms in, and the SPX y-axis tightens to exactly the
// visible window's min/max so intraday detail is not flattened by
// distant out-of-view highs or lows. Dots are fully opaque so that
// overlapping markers in the zoomed-out view render as crisp shapes
// rather than blending into a soft wash.

const LINE_COLOR = 'rgba(138, 143, 156, 0.35)';

function addDaysIso(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
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
// their x-axis slot. At the default ~90-day view (~62 trading days on a
// ~900px-wide card) this gives ~16px dots; zooming to 1 month pushes them
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

export default function DealerGammaRegime() {
  const chartRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();
  const { data, loading, error } = useGexHistory({});
  const mobile = useIsMobile();
  const [timeRange, setTimeRange] = useState(null);

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

  const firstDate = allDates[0];
  const lastDate = allDates[allDates.length - 1];
  const defaultRange = useMemo(() => {
    if (!firstDate || !lastDate) return null;
    const ninetyDaysBack = addDaysIso(lastDate, -90);
    return [ninetyDaysBack >= firstDate ? ninetyDaysBack : firstDate, lastDate];
  }, [firstDate, lastDate]);

  const activeRange = timeRange || defaultRange;

  useEffect(() => {
    if (!Plotly || !chartRef.current || allDates.length === 0 || !activeRange) return;

    const [windowStart, windowEnd] = activeRange;

    // Pad the visible x-axis a few days past the last data point so the
    // most recent dot renders fully inside the plot area instead of
    // being half-clipped by the right boundary. The external RangeBrush
    // exposes the actual [firstDate, lastDate] domain, so the brush
    // still reflects real data bounds — the pad only affects display.
    const PADDING_DAYS = 3;
    const paddedEndIso = new Date(
      new Date(`${lastDate}T00:00:00Z`).getTime() + PADDING_DAYS * 86400000,
    )
      .toISOString()
      .slice(0, 10);
    const displayEnd = windowEnd >= lastDate ? paddedEndIso : windowEnd;

    // Marker size and y-axis range are derived from the currently-visible
    // window so the dots grow as the user brushes in and the y-axis
    // tightens around the visible closes. Because the brush commits only
    // on pointerUp, this recompute runs once per drag instead of at 60 fps.
    const visibleCount = countInRange(allDates, windowStart, windowEnd);
    const chartWidth = chartRef.current.clientWidth || (mobile ? 400 : 900);
    const markerSize = computeMarkerSize(visibleCount, chartWidth, mobile);
    const yRange = computeYRange(allDates, allCloses, windowStart, windowEnd);

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

    const posTrace = {
      x: positive.map((r) => r.trading_date),
      y: positive.map((r) => r.spx_close),
      mode: 'markers',
      type: 'scatter',
      marker: {
        color: PLOTLY_COLORS.positive,
        size: markerSize,
        line: { width: 0 },
      },
      name: '<b>Positive Gamma</b>',
      hovertemplate: '%{x}<br>SPX: %{y:,.0f}<br>Positive Gamma<extra></extra>',
    };

    const negTrace = {
      x: negative.map((r) => r.trading_date),
      y: negative.map((r) => r.spx_close),
      mode: 'markers',
      type: 'scatter',
      marker: {
        color: PLOTLY_COLORS.negative,
        size: markerSize,
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
      margin: mobile ? { t: 45, r: 15, b: 40, l: 55 } : { t: 90, r: 30, b: 45, l: 85 },
      title: {
        ...plotlyTitle('Gamma Regime History'),
        y: 0.97,
        yref: 'container',
        yanchor: 'top',
      },
      xaxis: plotlyAxis('', {
        type: 'date',
        range: [windowStart, displayEnd],
        autorange: false,
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
        ...(yRange ? { range: yRange, autorange: false } : {}),
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

    Plotly.react(chartRef.current, [priceLine, posTrace, negTrace], layout, {
      responsive: true,
      displayModeBar: false,
    });
  }, [Plotly, positive, negative, allDates, allCloses, mobile, activeRange, lastDate]);

  const handleBrushChange = useCallback((minMs, maxMs) => {
    setTimeRange([msToIso(minMs), msToIso(maxMs)]);
  }, []);

  if (plotlyError) {
    return (
      <div className="card" style={{ padding: '1rem', marginBottom: '1rem', color: 'var(--accent-coral)' }}>
        Dealer gamma regime unavailable: Plotly failed to load ({plotlyError}).
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
    return <div className="skeleton-card" style={{ height: '604px', marginBottom: '1rem' }} />;
  }
  if (!data || allDates.length === 0) {
    return (
      <div className="card text-muted" style={{ marginBottom: '1rem' }}>
        No GEX history available yet. The daily_gex_stats backfill has not been run.
      </div>
    );
  }

  return (
    <div className="card" style={{ marginBottom: '1rem', position: 'relative' }}>
      <ResetButton visible={timeRange != null} onClick={() => setTimeRange(null)} />
      <div ref={chartRef} style={{ width: '100%', height: '564px', backgroundColor: 'var(--bg-card)' }} />
      {activeRange && (
        <RangeBrush
          min={isoToMs(firstDate)}
          max={isoToMs(lastDate)}
          activeMin={isoToMs(activeRange[0])}
          activeMax={isoToMs(activeRange[1])}
          onChange={handleBrushChange}
        />
      )}
    </div>
  );
}
