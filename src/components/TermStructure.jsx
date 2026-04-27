import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import usePlotly from '../hooks/usePlotly';
import useIsMobile from '../hooks/useIsMobile';
import {
  PLOTLY_COLORS,
  PLOTLY_FONTS,
  plotly2DChartLayout,
  plotlyAxis,
  plotlyTitle,
} from '../lib/plotlyTheme';
import { addDaysIso, daysBetween, tradingDateFromCapturedAt } from '../lib/dates';
import RangeBrush from './RangeBrush';
import ResetButton from './ResetButton';

function isoToMs(iso) {
  return new Date(`${iso}T00:00:00Z`).getTime();
}

function msToIso(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// Cloud-band visual language:
// - Four equal-mass percentile bands, each an independent fill: 'toself'
//   closed polygon so there is no alpha accumulation between adjacent
//   regions — each band renders as exactly its assigned color.
// - Hot-to-cold palette carves out the regions by color alone:
//   green (p10-p30) → yellow (p30-p50) → orange (p50-p70) → red (p70-p90).
//   Each band holds exactly the same 20 percentile points of probability
//   mass, so the four regions are strictly comparable. A point sitting in
//   the red band is visibly stressed, a point in the green band is
//   visibly subdued, and the color edges are the boundaries — no stroke
//   lines needed.
// - Alphas held low (0.28 each) so the cloud reads as atmospheric
//   context wash rather than hard colored walls, and the observed ATM
//   IV trace in primary blue stays the clear foreground element.
//
// On the "why are the bands not even height":
// Percentile bands on a right-skewed distribution are inherently
// asymmetric even when each band carries equal probability mass — the
// top band is wider than the bottom band because the real IV
// distribution has a heavy right tail. Stress regimes push IV up much
// harder than calm regimes push it down. Because each band now covers
// exactly 20 percentile points (p10-p30, p30-p50, p50-p70, p70-p90),
// any visual asymmetry is entirely distributional skew and not a
// bin-size artifact — the earlier p25/p75 split put 15 / 25 / 25 / 15
// percentile points in the four bands and conflated those two effects.
//
// The observed ATM IV curve sits ON TOP of the bands in the same chart —
// cloud is historical context for today's term structure, not a separate
// view. One chart, one scale.
const BAND_TOP      = 'rgba(231, 76, 60, 0.32)';   // p70-p90 (stress band, red)
const BAND_UPPER    = 'rgba(230, 126, 34, 0.28)';  // p50-p70 (upper-mid, orange)
const BAND_LOWER    = 'rgba(241, 196, 15, 0.28)';  // p30-p50 (lower-mid, yellow)
const BAND_BOTTOM   = 'rgba(46, 204, 113, 0.32)';  // p10-p30 (calm band, green)

// Bands arrive from the backend as DTE-keyed rows (see daily_cloud_bands
// schema). Calendar x values are derived from the observed trading date
// plus integer DTE, so the cloud lines up with the live term-structure
// trace that uses the same anchor date.

function toPct(iv) {
  return iv == null ? null : iv * 100;
}

function closedPolygon(xDates, yLower, yUpper, fillcolor) {
  return {
    x: [...xDates, ...xDates.slice().reverse()],
    y: [...yLower, ...yUpper.slice().reverse()],
    fill: 'toself',
    fillcolor,
    line: { color: 'rgba(0,0,0,0)', width: 0 },
    mode: 'lines',
    type: 'scatter',
    hoverinfo: 'skip',
    showlegend: false,
  };
}

export default function TermStructure({ expirationMetrics, capturedAt, cloudBands }) {
  const chartRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();
  const mobile = useIsMobile();
  const [timeRange, setTimeRange] = useState(null);

  const tradingDate = useMemo(
    () => tradingDateFromCapturedAt(capturedAt),
    [capturedAt],
  );

  // Filter 0DTE (and any fractional DTE below 1) because same-day options
  // carry microstructure noise — pin risk, jump-to-expiry effects, and
  // bid/ask blowouts in the final minutes — that chronically distorts the
  // observed ATM IV at DTE 0 and compresses the meaningful portion of the
  // term-structure curve on the y-axis. The filter is applied at the
  // component level so the underlying row stays available in Supabase and
  // in the reader endpoint for any downstream model that wants it.
  const rows = useMemo(() => {
    if (!expirationMetrics || expirationMetrics.length === 0 || !capturedAt) return [];
    const refMs = new Date(capturedAt).getTime();
    if (Number.isNaN(refMs)) return [];
    return expirationMetrics
      .map((m) => ({
        expiration: m.expiration_date,
        dte: daysBetween(m.expiration_date, refMs),
        atmIv: m.atm_iv,
      }))
      .filter((r) => r.dte != null && r.dte >= 1)
      .sort((a, b) => a.dte - b.dte);
  }, [expirationMetrics, capturedAt]);

  // Hoist the sorted cloud-band slice above the effect so the same
  // filtered DTE-domain is used by both the polygon construction and the
  // x-axis range computation below. The `>= 1` filter matches the rows
  // filter above so the cloud and the observed curve share a single
  // no-0DTE domain.
  const sortedCloudBands = useMemo(() => {
    if (!cloudBands || cloudBands.length === 0 || !tradingDate) return [];
    return cloudBands
      .filter((b) =>
        b.dte != null && b.dte >= 1 &&
        b.iv_p10 != null && b.iv_p30 != null && b.iv_p50 != null &&
        b.iv_p70 != null && b.iv_p90 != null)
      .sort((a, b) => a.dte - b.dte);
  }, [cloudBands, tradingDate]);

  // Compute a tight y-axis range over the cloud bands' p10/p90 envelope and
  // the observed ATM IV trace, then floor the lower bound at 1% so Plotly's
  // auto-tick can never emit a "0.0" tick at the bottom-left corner where it
  // would collide with the first x-axis date label. Padded ±5% so the
  // outermost data sits comfortably inside the plot area.
  const yRange = useMemo(() => {
    let yMin = Infinity;
    let yMax = -Infinity;
    for (const r of rows) {
      if (r.atmIv != null) {
        const v = r.atmIv * 100;
        if (v < yMin) yMin = v;
        if (v > yMax) yMax = v;
      }
    }
    for (const b of sortedCloudBands) {
      const lo = b.iv_p10 * 100;
      const hi = b.iv_p90 * 100;
      if (lo < yMin) yMin = lo;
      if (hi > yMax) yMax = hi;
    }
    if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) return null;
    const pad = (yMax - yMin) * 0.05;
    return [Math.max(1, yMin - pad), yMax + pad];
  }, [rows, sortedCloudBands]);

  // Compute the brush's outer domain and default initial window outside
  // the effect so the render path can share the same numbers with the
  // Plotly layout. `axisStart` is padded 3 days left of the first
  // observed expiration; `cloudLast` is the furthest cloud-band DTE (or
  // the last observed expiration when no cloud exists); `initialEnd` is
  // capped at 100 calendar days from the first expiration so the default
  // window shows the near-term curvature without forcing the user to
  // touch the brush.
  const brushDomain = useMemo(() => {
    if (rows.length === 0) return null;
    const startDate = rows[0].expiration;
    const axisStart = addDaysIso(startDate, -3);
    const maxBandDte = sortedCloudBands.length > 0
      ? sortedCloudBands[sortedCloudBands.length - 1].dte
      : null;
    const cloudLast = (maxBandDte != null && tradingDate)
      ? addDaysIso(tradingDate, maxBandDte)
      : rows[rows.length - 1].expiration;
    const naturalEnd = addDaysIso(startDate, 100);
    const initialEnd = (cloudLast && naturalEnd > cloudLast) ? cloudLast : naturalEnd;
    return { axisStart, cloudLast, initialEnd };
  }, [rows, sortedCloudBands, tradingDate]);

  useEffect(() => {
    if (!Plotly || !chartRef.current || rows.length === 0) return;

    const traces = [];

    if (sortedCloudBands.length > 0) {
      const xDates = sortedCloudBands.map((b) => addDaysIso(tradingDate, b.dte));
      const p10 = sortedCloudBands.map((b) => toPct(b.iv_p10));
      const p30 = sortedCloudBands.map((b) => toPct(b.iv_p30));
      const p50 = sortedCloudBands.map((b) => toPct(b.iv_p50));
      const p70 = sortedCloudBands.map((b) => toPct(b.iv_p70));
      const p90 = sortedCloudBands.map((b) => toPct(b.iv_p90));

      traces.push(
        closedPolygon(xDates, p10, p30, BAND_BOTTOM),
        closedPolygon(xDates, p30, p50, BAND_LOWER),
        closedPolygon(xDates, p50, p70, BAND_UPPER),
        closedPolygon(xDates, p70, p90, BAND_TOP),
      );
    }

    // Observed ATM IV curve — calendar-date x, DTE shown in hover tooltip.
    traces.push({
      x: rows.map((r) => r.expiration),
      y: rows.map((r) => (r.atmIv == null ? null : r.atmIv * 100)),
      mode: 'lines+markers',
      type: 'scatter',
      name: 'ATM IV',
      line: { color: PLOTLY_COLORS.primary, width: 2 },
      marker: { color: PLOTLY_COLORS.primary, size: 9, symbol: 'circle' },
      text: rows.map((r) => `DTE ${r.dte}`),
      hovertemplate: '%{x}<br>%{text}<br>ATM IV: %{y:.2f}%<extra></extra>',
    });

    if (!brushDomain) return;
    const { axisStart, initialEnd } = brushDomain;
    const windowStart = timeRange ? timeRange[0] : axisStart;
    const windowEnd = timeRange ? timeRange[1] : initialEnd;

    // Chart bottom margin now matches the scatter (b: 45) so the x-axis
    // tick labels have room to breathe before the external RangeBrush
    // picks up flush against the card floor.
    const layout = plotly2DChartLayout({
      margin: mobile ? { t: 45, r: 15, b: 40, l: 50 } : { t: 50, r: 40, b: 45, l: 70 },
      title: plotlyTitle('Term Structure'),
      showlegend: false,
      xaxis: plotlyAxis('', {
        type: 'date',
        range: [windowStart, windowEnd],
        autorange: false,
      }),
      yaxis: {
        ...plotlyAxis('ATM IV (%)', { tickformat: '.1f' }),
        title: mobile ? { text: '' } : {
          text: 'ATM IV (%)',
          font: { ...PLOTLY_FONTS.axisTitleBold, color: PLOTLY_COLORS.primarySoft },
          standoff: 10,
        },
        tickfont: { ...PLOTLY_FONTS.axisTick, color: PLOTLY_COLORS.primarySoft },
        ...(yRange ? { range: yRange, autorange: false } : {}),
      },
    });

    Plotly.react(chartRef.current, traces, layout, {
      responsive: true,
      displayModeBar: false,
    });
  }, [Plotly, rows, sortedCloudBands, tradingDate, mobile, brushDomain, timeRange, yRange]);

  const handleBrushChange = useCallback((minMs, maxMs) => {
    setTimeRange([msToIso(minMs), msToIso(maxMs)]);
  }, []);

  if (plotlyError) {
    return (
      <div
        className="card"
        style={{ padding: '1rem', marginBottom: '1rem', color: 'var(--accent-coral)' }}
      >
        Term structure unavailable: Plotly failed to load ({plotlyError}).
      </div>
    );
  }
  if (!expirationMetrics || expirationMetrics.length < 2) {
    return null;
  }

  const activeMinIso = timeRange ? timeRange[0] : brushDomain?.axisStart;
  const activeMaxIso = timeRange ? timeRange[1] : brushDomain?.initialEnd;

  return (
    <div className="card" style={{ marginBottom: '1rem', position: 'relative' }}>
      <ResetButton visible={timeRange != null} onClick={() => setTimeRange(null)} />
      <div ref={chartRef} style={{ width: '100%', height: '500px', backgroundColor: 'var(--bg-card)' }} />
      {brushDomain && (
        <RangeBrush
          min={isoToMs(brushDomain.axisStart)}
          max={isoToMs(brushDomain.cloudLast)}
          activeMin={isoToMs(activeMinIso)}
          activeMax={isoToMs(activeMaxIso)}
          onChange={handleBrushChange}
        />
      )}
    </div>
  );
}
