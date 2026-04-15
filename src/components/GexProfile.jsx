import { useEffect, useMemo, useRef, useState } from 'react';
import usePlotly from '../hooks/usePlotly';
import {
  PLOTLY_BASE_LAYOUT_2D,
  PLOTLY_COLORS,
  PLOTLY_SERIES_OPACITY,
  plotlyAxis,
  plotlyRangeslider,
  plotlyTitle,
} from '../lib/plotlyTheme';
import { computeGexByStrike, symlog, symlogTicks } from '../lib/gex';

const PLOTLY_LAYOUT_BASE = {
  ...PLOTLY_BASE_LAYOUT_2D,
  margin: { t: 85, r: 30, b: 15, l: 80 },
  xaxis: plotlyAxis('', { title: '', rangeslider: plotlyRangeslider() }),
  yaxis: plotlyAxis('Gamma Exposure ($ notional)', {
    zerolinewidth: 2,
    tickformat: '.2s',
  }),
  barmode: 'relative',
};

const LABEL_STYLE = {
  position: 'absolute',
  backgroundColor: '#10131A',
  padding: '2px 6px',
  fontSize: '12px',
  fontFamily: 'Courier New, monospace',
  fontWeight: 'bold',
  pointerEvents: 'none',
  whiteSpace: 'nowrap',
};

export default function GexProfile({ contracts, spotPrice, levels }) {
  const chartRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();
  const [labels, setLabels] = useState([]);

  const gexData = useMemo(() => {
    if (!contracts || contracts.length === 0 || !spotPrice) return null;
    const all = computeGexByStrike(contracts, spotPrice);
    const lower = spotPrice * 0.8;
    const upper = spotPrice * 1.2;
    return all.filter((e) => e.strike >= lower && e.strike <= upper);
  }, [contracts, spotPrice]);

  useEffect(() => {
    if (!Plotly || !chartRef.current || !gexData || gexData.length === 0) return;

    const strikes = gexData.map((e) => e.strike);
    const callGexRaw = gexData.map((e) => e.callGex);
    const putGexRaw = gexData.map((e) => -e.putGex);

    // C = 75th percentile of |netGex| — the crossover between linear and
    // logarithmic compression, recomputed from the live dataset each render.
    const absNetGex = gexData
      .map((e) => Math.abs(e.callGex - e.putGex))
      .sort((a, b) => a - b);
    const C = absNetGex[Math.floor(absNetGex.length * 0.75)] || 1;

    const { tickvals, ticktext } = symlogTicks([...callGexRaw, ...putGexRaw], C);

    const traces = [
      {
        x: strikes,
        y: callGexRaw.map((v) => symlog(v, C)),
        customdata: callGexRaw,
        type: 'bar',
        name: 'Call Gamma',
        marker: { color: PLOTLY_COLORS.positive, opacity: PLOTLY_SERIES_OPACITY },
        hovertemplate: 'Strike %{x}<br>Call Gamma: %{customdata:.3s}<extra></extra>',
      },
      {
        x: strikes,
        y: putGexRaw.map((v) => symlog(v, C)),
        customdata: putGexRaw,
        type: 'bar',
        name: 'Put Gamma',
        marker: { color: PLOTLY_COLORS.negative, opacity: PLOTLY_SERIES_OPACITY },
        hovertemplate: 'Strike %{x}<br>Put Gamma: %{customdata:.3s}<extra></extra>',
      },
    ];

    // Dashed vertical reference lines only — labels are rendered as HTML
    const shapes = [];
    const pushLine = (x, color) => {
      if (x == null) return;
      shapes.push({
        type: 'line',
        x0: x,
        x1: x,
        yref: 'paper',
        y0: 0,
        y1: 1,
        line: { color, width: 3, dash: 'dash' },
      });
    };

    pushLine(spotPrice, PLOTLY_COLORS.primary);
    if (levels) {
      pushLine(levels.volatility_flip, PLOTLY_COLORS.highlight);
    }

    const strikeMin = strikes[0];
    const strikeMax = strikes[strikes.length - 1];
    const zoomLow = spotPrice * 0.87;
    const zoomHigh = spotPrice * 1.13;

    const layout = {
      ...PLOTLY_LAYOUT_BASE,
      title: {
        ...plotlyTitle('AI Gamma Map'),
        y: 0.97,
        yanchor: 'top',
      },
      xaxis: plotlyAxis('', {
        title: '',
        range: [zoomLow, zoomHigh],
        autorange: false,
        rangeslider: plotlyRangeslider({ range: [strikeMin, strikeMax], autorange: false }),
      }),
      yaxis: plotlyAxis('Gamma Exposure ($ notional)', {
        zerolinewidth: 2,
        tickvals,
        ticktext,
      }),
      shapes,
      showlegend: false,
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
    };

    Plotly.newPlot(chartRef.current, traces, layout, {
      responsive: true,
      displayModeBar: false,
    }).then(() => {
      const fl = chartRef.current?._fullLayout;
      if (!fl) return;
      const { l: ml, t: mt, b: mb, r: mr } = fl.margin;
      const plotW = fl.width - ml - mr;
      const plotH = fl.height - mt - mb;
      const [xMin, xMax] = fl.xaxis.range;
      const xScale = plotW / (xMax - xMin);
      const px = (dataX) => ml + (dataX - xMin) * xScale;

      const yDomain = fl.yaxis?.domain || [0, 1];
      const dataTopY = mt + plotH * (1 - yDomain[1]);
      const topY = dataTopY - 5;

      // Anchor FLIP above the main x-axis tick-label strip (the strike-price
      // row Plotly renders between the data plot and the rangeslider). Prefer
      // the rendered `.xaxislayer-above` group's bounding box since it's what
      // actually contains the tick labels; fall back to a larger offset from
      // the rangeslider rect so the label still clears the label row if the
      // selector changes in a future Plotly release.
      let bottomY;
      const container = chartRef.current;
      if (container) {
        const containerRect = container.getBoundingClientRect();
        const xAxisLayer = container.querySelector('.xaxislayer-above');
        if (xAxisLayer) {
          const layerRect = xAxisLayer.getBoundingClientRect();
          bottomY = layerRect.top - containerRect.top - 10;
        } else {
          const rangesliderBg = container.querySelector('.rangeslider-bg');
          if (rangesliderBg) {
            const sliderRect = rangesliderBg.getBoundingClientRect();
            bottomY = sliderRect.top - containerRect.top - 35;
          } else {
            bottomY = mt + plotH * (1 - yDomain[0]) - 35;
          }
        }
      } else {
        bottomY = mt + plotH * (1 - yDomain[0]) - 35;
      }

      // Query the rendered title SVG group so the Put Gamma / Call Gamma
      // corner labels can sit on the exact same horizontal baseline as the
      // "AI Gamma Map" title, regardless of how Plotly internally resolves
      // the title's container-coord y=0.97 value to a pixel offset.
      let titleTop = 22;
      if (container) {
        const titleEl = container.querySelector('.gtitle');
        if (titleEl) {
          const cRect = container.getBoundingClientRect();
          const titleRect = titleEl.getBoundingClientRect();
          titleTop = titleRect.top - cRect.top;
        }
      }

      const newLabels = [
        { left: px(spotPrice), top: topY, color: PLOTLY_COLORS.primary, text: 'SPOT' },
        { corner: 'left', offset: 20, top: titleTop, color: PLOTLY_COLORS.negative, text: 'Put Gamma' },
        { corner: 'right', offset: 20, top: titleTop, color: PLOTLY_COLORS.positive, text: 'Call Gamma' },
      ];
      if (levels) {
        if (levels.call_wall != null)
          newLabels.push({ left: px(levels.call_wall), top: topY, color: PLOTLY_COLORS.positive, text: 'CW' });
        if (levels.put_wall != null)
          newLabels.push({ left: px(levels.put_wall), top: topY, color: PLOTLY_COLORS.negative, text: 'PW' });
        if (levels.volatility_flip != null)
          newLabels.push({ left: px(levels.volatility_flip), top: bottomY, color: PLOTLY_COLORS.highlight, text: 'FLIP' });
      }
      setLabels(newLabels);
    });
  }, [Plotly, gexData, spotPrice, levels]);

  if (plotlyError) {
    return (
      <div
        className="card"
        style={{ padding: '1rem', marginBottom: '1rem', color: 'var(--accent-coral)' }}
      >
        Gamma exposure profile unavailable — Plotly failed to load ({plotlyError}).
      </div>
    );
  }
  if (!contracts || contracts.length === 0) {
    return <div className="card text-muted">No GEX data available.</div>;
  }

  return (
    <div className="card" style={{ marginBottom: '1rem' }}>
      <div style={{ position: 'relative' }}>
        <div
          ref={chartRef}
          style={{ width: '100%', height: '700px', backgroundColor: 'var(--bg-card)' }}
        />
        {labels.map((l, i) => {
          if (l.corner) {
            return (
              <div
                key={i}
                style={{
                  position: 'absolute',
                  top: l.top,
                  left: l.corner === 'left' ? l.offset : undefined,
                  right: l.corner === 'right' ? l.offset : undefined,
                  color: l.color,
                  fontFamily: 'Courier New, monospace',
                  fontSize: '20px',
                  fontWeight: 'bold',
                  lineHeight: 1,
                  pointerEvents: 'none',
                  whiteSpace: 'nowrap',
                }}
              >
                {l.text}
              </div>
            );
          }
          return (
            <div
              key={i}
              style={{
                ...LABEL_STYLE,
                left: l.left,
                top: l.top,
                transform: 'translate(-50%, -100%)',
                color: l.color,
                border: `1.5px solid ${l.color}`,
              }}
            >
              {l.text}
            </div>
          );
        })}
      </div>
    </div>
  );
}
