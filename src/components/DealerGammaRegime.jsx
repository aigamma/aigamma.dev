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
// Brush zoom via rangeslider defaults to the last 2 years with the full
// historical range available for expansion.

const LINE_COLOR = 'rgba(138, 143, 156, 0.35)';

function addMonthsIso(iso, months) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
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

    // Positive gamma dots (green)
    const posTrace = {
      x: positive.map((r) => r.trading_date),
      y: positive.map((r) => r.spx_close),
      mode: 'markers',
      type: 'scatter',
      marker: { color: PLOTLY_COLORS.positive, size: mobile ? 3 : 4, opacity: 0.85 },
      name: '<b>Positive Gamma</b>',
      hovertemplate: '%{x}<br>SPX: %{y:,.0f}<br>Positive Gamma<extra></extra>',
    };

    // Negative gamma dots (red)
    const negTrace = {
      x: negative.map((r) => r.trading_date),
      y: negative.map((r) => r.spx_close),
      mode: 'markers',
      type: 'scatter',
      marker: { color: PLOTLY_COLORS.negative, size: mobile ? 3 : 4, opacity: 0.85 },
      name: '<b>Negative Gamma</b>',
      hovertemplate: '%{x}<br>SPX: %{y:,.0f}<br>Negative Gamma<extra></extra>',
    };

    const firstDate = allDates[0];
    const lastDate = allDates[allDates.length - 1];
    const twoYearsBack = addMonthsIso(lastDate, -24);
    const windowStart = twoYearsBack >= firstDate ? twoYearsBack : firstDate;

    const legendFont = {
      family: PLOTLY_FONT_FAMILY,
      color: PLOTLY_COLORS.titleText,
      size: 18,
    };

    const layout = plotly2DChartLayout({
      margin: mobile ? { t: 45, r: 15, b: 15, l: 50 } : { t: 90, r: 30, b: 15, l: 70 },
      title: {
        ...plotlyTitle('SPX Dealer Gamma Exposure By Regime'),
        y: 0.97,
        yref: 'container',
        yanchor: 'top',
      },
      xaxis: plotlyAxis('', {
        type: 'date',
        range: [windowStart, lastDate],
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
