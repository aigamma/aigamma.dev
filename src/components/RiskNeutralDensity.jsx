import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import usePlotly from '../hooks/usePlotly';
import useIsMobile from '../hooks/useIsMobile';
import {
  PLOTLY_BASE_LAYOUT_2D,
  PLOTLY_COLORS,
  PLOTLY_FONTS,
  PLOTLY_SERIES_PALETTE,
  plotlyAxis,
  plotlyTitle,
} from '../lib/plotlyTheme';
import RangeBrush from './RangeBrush';
import ResetButton from './ResetButton';

const BASE_LAYOUT = {
  ...PLOTLY_BASE_LAYOUT_2D,
  margin: { t: 80, r: 30, b: 45, l: 95 },
  xaxis: plotlyAxis(''),
  // `ticks: 'outside'` plus an invisible 8px ticklen pushes the tick text
  // a further 8px left of the plot area's left edge, so the values like
  // "1.8m" / "800μ" stop rendering flush against the y-axis line. The
  // 15px bump in margin.l absorbs that extra spacing without crowding the
  // rotated y-axis title.
  yaxis: plotlyAxis('Risk-Neutral Density', {
    tickformat: '.2s',
    ticks: 'outside',
    ticklen: 8,
    tickcolor: 'rgba(0,0,0,0)',
    tickpad: 10,
  }),
  // Legend floats inside the top-right of the plot area instead of the
  // shared horizontal-below-plot slot from PLOTLY_BASE_LAYOUT_2D. The
  // old rangeslider pinned the horizontal legend right on top of the
  // x-axis tick labels; the external brush lives below the chart card
  // now, but the overlay position still keeps the legend out of the
  // density curves themselves (top-right corner where the far-OTM wing
  // has decayed close to zero).
  legend: {
    orientation: 'v',
    x: 0.98,
    xanchor: 'right',
    y: 0.98,
    yanchor: 'top',
    bgcolor: 'rgba(20, 24, 32, 0.7)',
    bordercolor: PLOTLY_COLORS.grid,
    borderwidth: 1,
    font: PLOTLY_FONTS.legend,
  },
};

// Compute the CDF via trapezoidal integration on the FULL density, then
// window density + CDF together so P(SPX < K) is accurate even at the
// left edge of the visible range. Without computing on the full array
// first, the CDF would start at zero at the left window boundary instead
// of reflecting the probability mass in the far left tail.
function windowDensityWithCdf({ strikes, values }, spotPrice) {
  const lo = spotPrice * 0.75;
  const hi = spotPrice * 1.25;

  const cdf = new Array(strikes.length);
  cdf[0] = 0;
  for (let i = 1; i < strikes.length; i++) {
    cdf[i] = cdf[i - 1] + (values[i - 1] + values[i]) / 2 * (strikes[i] - strikes[i - 1]);
  }

  const outStrikes = [];
  const outValues = [];
  const outCdf = [];
  for (let i = 0; i < strikes.length; i++) {
    if (strikes[i] >= lo && strikes[i] <= hi) {
      outStrikes.push(strikes[i]);
      outValues.push(values[i]);
      outCdf.push(cdf[i]);
    }
  }
  return { strikes: outStrikes, values: outValues, cdf: outCdf };
}

// Monthly SPX options expire on the third Friday of the month, shifting back
// to the preceding Thursday when that Friday is a market holiday — Good
// Friday is the only US holiday that ever lands on a third-Friday week. The
// RND chart strips weeklies so the density curves compare like-for-like
// tenors and the front-month weeklies don't stack a wall of overlapping
// lines on top of the mode.
function isMonthlyExpiration(dateStr, expirationSet) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const first = new Date(Date.UTC(y, m, 1));
  const firstFridayDom = 1 + ((5 - first.getUTCDay() + 7) % 7);
  const thirdFridayDom = firstFridayDom + 14;
  const thirdFridayStr = new Date(Date.UTC(y, m, thirdFridayDom))
    .toISOString()
    .split('T')[0];
  if (dateStr === thirdFridayStr) return true;
  // Fall through only when the canonical Friday is absent from the chain, so
  // a Thursday weekly that happens to sit one day before its own month's
  // monthly Friday doesn't get misclassified as the shifted monthly.
  if (!expirationSet.has(thirdFridayStr)) {
    const shiftedStr = new Date(Date.UTC(y, m, thirdFridayDom - 1))
      .toISOString()
      .split('T')[0];
    return dateStr === shiftedStr;
  }
  return false;
}

export default function RiskNeutralDensity({ fits, spotPrice, capturedAt, loading = false }) {
  const chartRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();
  const mobile = useIsMobile();
  const [strikeRange, setStrikeRange] = useState(null);

  const brushDomain = useMemo(() => {
    if (!spotPrice) return null;
    return {
      min: spotPrice * 0.75,
      max: spotPrice * 1.25,
      defaultRange: [spotPrice * 0.95, spotPrice * 1.12],
    };
  }, [spotPrice]);

  const activeRange = strikeRange || brushDomain?.defaultRange;

  const sortedExps = useMemo(() => {
    if (!fits || !capturedAt) return [];
    const now = new Date(capturedAt).getTime();
    const withDensity = Object.values(fits).filter(
      (f) => f?.density && f.density.strikes && f.density.values
    );
    const expirationSet = new Set(withDensity.map((f) => f.expirationDate));
    return withDensity
      .filter((f) => isMonthlyExpiration(f.expirationDate, expirationSet))
      .sort((a, b) => {
        const ta = new Date(a.expirationDate).getTime();
        const tb = new Date(b.expirationDate).getTime();
        return ta - tb;
      })
      .map((f) => {
        const daysToExp = Math.max((new Date(`${f.expirationDate}T20:00:00Z`).getTime() - now) / 86400000, 0);
        return { ...f, dte: daysToExp };
      })
      .filter((f) => f.dte >= 7);
  }, [fits, capturedAt]);

  useEffect(() => {
    if (!Plotly || !chartRef.current || sortedExps.length === 0 || !spotPrice) return;

    const traces = [];
    const modeX = [];
    const modeY = [];
    const modeColors = [];
    const modeHover = [];

    sortedExps.forEach((fit, idx) => {
      const windowed = windowDensityWithCdf(
        { strikes: fit.density.strikes, values: fit.density.values },
        spotPrice,
      );
      const color = PLOTLY_SERIES_PALETTE[idx % PLOTLY_SERIES_PALETTE.length];
      const label = `${fit.expirationDate} (${fit.dte.toFixed(0)}d)`;

      // Find the mode (peak density) for this expiration.
      let peakVal = 0;
      let peakIdx = 0;
      for (let i = 0; i < windowed.values.length; i++) {
        if (windowed.values[i] > peakVal) {
          peakVal = windowed.values[i];
          peakIdx = i;
        }
      }

      // customdata carries [cdf, densityRelativeToPeak] so the hover
      // can show both the cumulative probability and how close this
      // strike is to the optimal butterfly center for this expiration.
      const customdata = windowed.strikes.map((_, i) => [
        windowed.cdf[i],
        peakVal > 0 ? windowed.values[i] / peakVal : 0,
      ]);

      traces.push({
        x: windowed.strikes,
        y: windowed.values,
        customdata,
        mode: 'lines',
        type: 'scatter',
        name: label,
        line: { color, width: 2 },
        fill: 'tozeroy',
        fillcolor: `${color}22`,
        hovertemplate:
          label + '<br>K %{x:,.0f}<br>P(SPX < K) = %{customdata[0]:.1%}'
          + '<br>density: %{customdata[1]:.0%} of mode'
          + '<extra></extra>',
      });

      // Collect mode marker for this expiration.
      modeX.push(windowed.strikes[peakIdx]);
      modeY.push(peakVal);
      modeColors.push(color);
      modeHover.push(`${label}<br>mode: ${windowed.strikes[peakIdx].toFixed(0)}`);
    });

    // Single scatter trace for all mode markers — diamond dots at each
    // curve's peak. The mode is the most probable settlement strike for
    // that expiration and the optimal center for a butterfly.
    if (modeX.length > 0) {
      traces.push({
        x: modeX,
        y: modeY,
        mode: 'markers',
        type: 'scatter',
        marker: { color: modeColors, size: 9, symbol: 'diamond', line: { color: '#141820', width: 1 } },
        showlegend: false,
        hovertemplate: '%{text}<extra></extra>',
        text: modeHover,
      });
    }

    // Default zoom is asymmetric around spot — tight on the left where the
    // density falls off sharply, wider on the right where the longer-dated
    // curves spread out. 5% below / 12% above keeps all the probability
    // mass visible without wasting space on near-zero wings.
    const [zoomLow, zoomHigh] = activeRange || [spotPrice * 0.95, spotPrice * 1.12];

    // Spot line as a Plotly shape so it sits across all traces.
    const layout = {
      ...BASE_LAYOUT,
      ...(mobile ? {
        margin: { t: 45, r: 15, b: 40, l: 50 },
        showlegend: false,
        yaxis: plotlyAxis('', { tickformat: '.2s', tickpad: 10 }),
      } : {}),
      title: {
        ...plotlyTitle('Breeden-Litzenberger'),
        y: 0.96,
        yanchor: 'top',
      },
      xaxis: plotlyAxis('', {
        range: [zoomLow, zoomHigh],
        autorange: false,
      }),
      shapes: [
        {
          type: 'line',
          x0: spotPrice,
          x1: spotPrice,
          yref: 'paper',
          y0: 0,
          y1: 1,
          line: { color: PLOTLY_COLORS.primary, width: 1.5, dash: 'dash' },
        },
      ],
      annotations: mobile ? [] : [
        {
          x: spotPrice,
          xref: 'x',
          y: 1,
          yref: 'paper',
          yanchor: 'bottom',
          text: 'SPX',
          showarrow: false,
          font: { ...PLOTLY_FONTS.axisTitle, color: PLOTLY_COLORS.primary },
        },
      ],
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      hovermode: 'closest',
    };

    Plotly.react(chartRef.current, traces, layout, {
      responsive: true,
      displayModeBar: false,
    });
  }, [Plotly, sortedExps, spotPrice, mobile, activeRange]);

  const handleBrushChange = useCallback((min, max) => {
    setStrikeRange([min, max]);
  }, []);

  if (plotlyError) {
    return (
      <div
        className="card"
        style={{ padding: '1rem', marginBottom: '1rem', color: 'var(--accent-coral)' }}
      >
        Risk-neutral density unavailable: Plotly failed to load ({plotlyError}).
      </div>
    );
  }
  if (!sortedExps || sortedExps.length === 0) {
    // Distinguish "SVI fits are still being computed in a concurrent
    // background render" from "fits are genuinely unavailable for this
    // run". When App.jsx flagged loading=true, the urgent render just
    // committed with the deferred (stale-null) contracts value and the
    // background render is running fitSviSlice across the expirations;
    // paint a skeleton that matches the rendered chart height instead of
    // the "unavailable" card, which would otherwise flicker in for the
    // ~100-300 ms the background render is in flight.
    if (loading) {
      return (
        <div
          className="skeleton-card"
          style={{ height: '560px', marginBottom: '1rem' }}
          aria-busy="true"
          aria-label="Computing risk-neutral density"
        />
      );
    }
    return (
      <div className="card text-muted" style={{ padding: '1rem', marginBottom: '1rem' }}>
        Risk-neutral density unavailable: SVI fits required.
      </div>
    );
  }

  return (
    <div className="card" style={{ marginBottom: '1rem', position: 'relative' }}>
      <ResetButton visible={strikeRange != null} onClick={() => setStrikeRange(null)} />
      <div ref={chartRef} style={{ width: '100%', height: '480px', backgroundColor: 'var(--bg-card)' }} />
      {brushDomain && activeRange && (
        <RangeBrush
          min={brushDomain.min}
          max={brushDomain.max}
          activeMin={activeRange[0]}
          activeMax={activeRange[1]}
          onChange={handleBrushChange}
        />
      )}
    </div>
  );
}
