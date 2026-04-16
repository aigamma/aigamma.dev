import { useEffect, useMemo, useRef } from 'react';
import usePlotly from '../hooks/usePlotly';
import {
  PLOTLY_COLORS,
  plotly2DChartLayout,
  plotlyAxis,
  plotlyRangeslider,
  plotlyTitle,
} from '../lib/plotlyTheme';
import { addDaysIso, daysBetween, tradingDateFromCapturedAt } from '../lib/dates';

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

    // The chart domain starts just before the first non-0DTE observed
    // expiration — `startDate` is the first data point and `axisStart`
    // shifts the visible left edge a few days earlier so the first dot
    // has breathing room instead of sitting flush against the y-axis
    // line where the marker can get half-clipped by the axis boundary.
    // The rangeslider range is padded by the same amount so the slider
    // left handle lines up with the visible left edge rather than with
    // the first data point (otherwise dragging the slider left would
    // feel pinned to nothing).
    const maxBandDte = sortedCloudBands.length > 0
      ? sortedCloudBands[sortedCloudBands.length - 1].dte
      : null;
    const cloudLast = (maxBandDte != null && tradingDate)
      ? addDaysIso(tradingDate, maxBandDte)
      : rows[rows.length - 1].expiration;
    const startDate = rows[0].expiration;
    const axisStart = addDaysIso(startDate, -3);
    // Default brush window is 100 calendar days from the first non-0DTE
    // expiration, which is wide enough to show the next several monthly
    // expirations and the near-term curvature without requiring the user
    // to touch the rangeslider. Capped at cloudLast so the initial window
    // can never run past the furthest data point on the cloud domain.
    const naturalEnd = addDaysIso(startDate, 100);
    const initialWindowEnd = (cloudLast && naturalEnd > cloudLast) ? cloudLast : naturalEnd;

    // Tight bottom margin matches GammaInflectionChart's `b: 15` so the
    // rangeslider sits flush against the card floor instead of leaving a
    // strip of empty card underneath. Previous `b: 90` was copy-paste from a
    // chart with an axis-title row below the slider that this one doesn't
    // have.
    const layout = plotly2DChartLayout({
      margin: { t: 50, r: 40, b: 15, l: 70 },
      title: plotlyTitle('Term Structure'),
      xaxis: plotlyAxis('', {
        type: 'date',
        range: [axisStart, initialWindowEnd],
        autorange: false,
        rangeslider: plotlyRangeslider({
          range: [axisStart, cloudLast],
          autorange: false,
        }),
      }),
      yaxis: plotlyAxis('ATM IV (%)', { tickformat: '.1f' }),
    });

    Plotly.newPlot(chartRef.current, traces, layout, {
      responsive: true,
      displayModeBar: false,
    });
  }, [Plotly, rows, sortedCloudBands, tradingDate]);

  if (plotlyError) {
    return (
      <div
        className="card"
        style={{ padding: '1rem', marginBottom: '1rem', color: 'var(--accent-coral)' }}
      >
        Term structure unavailable — Plotly failed to load ({plotlyError}).
      </div>
    );
  }
  if (!expirationMetrics || expirationMetrics.length < 2) {
    return null;
  }

  return (
    <div className="card" style={{ marginBottom: '1rem' }}>
      <div ref={chartRef} style={{ width: '100%', height: '720px', backgroundColor: 'var(--bg-card)' }} />
    </div>
  );
}
