import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import usePlotly from '../hooks/usePlotly';
import useIsMobile from '../hooks/useIsMobile';
import {
  PLOTLY_BASE_LAYOUT_2D,
  PLOTLY_COLORS,
  plotlyAxis,
  plotlyTitle,
} from '../lib/plotlyTheme';
import { mergeCollidingLabels } from '../lib/labelCollision';
import RangeBrush from './RangeBrush';
import ResetButton from './ResetButton';

// Dollar gamma notional is in the $10^9-$10^11 range at SPX scale. A plain SI
// tick formatter (Plotly's '.2s') is sufficient — no symlog compression needed
// because the hypothetical-spot sweep integrates across strikes, so magnitudes
// sit on a uniform order of scale instead of the per-strike power-law the
// absolute gamma view has to cope with.
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

// Split the gamma profile into one trace per sign so Plotly's `fill: 'tozeroy'`
// paints negative area in the coral tone and positive area in the green tone.
// At each sign change we insert a synthetic sample at the linearly-interpolated
// zero crossing so both traces meet cleanly on the x-axis rather than leaving
// a gap at the sampled step boundary.
function splitByZero(profile) {
  if (!profile || profile.length === 0) return { negX: [], negY: [], posX: [], posY: [] };
  const negX = [];
  const negY = [];
  const posX = [];
  const posY = [];

  for (let i = 0; i < profile.length; i++) {
    const p = profile[i];
    if (p.g <= 0) {
      negX.push(p.s);
      negY.push(p.g);
    } else {
      negX.push(p.s);
      negY.push(null);
    }
    if (p.g >= 0) {
      posX.push(p.s);
      posY.push(p.g);
    } else {
      posX.push(p.s);
      posY.push(null);
    }
  }

  // Patch the boundary samples so the two traces meet at y=0 instead of
  // leaving a one-step visual gap at the transition.
  for (let i = 1; i < profile.length; i++) {
    const prev = profile[i - 1];
    const curr = profile[i];
    const crosses = (prev.g < 0 && curr.g > 0) || (prev.g > 0 && curr.g < 0);
    if (!crosses) continue;
    const t = Math.abs(prev.g) / (Math.abs(prev.g) + Math.abs(curr.g));
    const xZero = prev.s + t * (curr.s - prev.s);
    if (prev.g < 0) {
      negY[i - 1] = prev.g;
      negY[i] = 0;
      negX[i] = xZero;
      posY[i - 1] = 0;
      posX[i - 1] = xZero;
      posY[i] = curr.g;
    } else {
      posY[i - 1] = prev.g;
      posY[i] = 0;
      posX[i] = xZero;
      negY[i - 1] = 0;
      negX[i - 1] = xZero;
      negY[i] = curr.g;
    }
  }

  return { negX, negY, posX, posY };
}

export default function GammaInflectionChart({ spotPrice, levels }) {
  const chartRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();
  const [labels, setLabels] = useState([]);
  const [strikeRange, setStrikeRange] = useState(null);
  const mobile = useIsMobile();

  const profile = levels?.gamma_profile || null;
  const volFlip = levels?.volatility_flip ?? null;

  const split = useMemo(() => splitByZero(profile), [profile]);
  const hasProfile = profile && profile.length > 0;

  const dataMin = hasProfile ? profile[0].s : null;
  const dataMax = hasProfile ? profile[profile.length - 1].s : null;
  const defaultRange = useMemo(() => {
    if (!hasProfile) return null;
    const hasSpot = spotPrice != null;
    const zoomLow = hasSpot ? spotPrice * 0.93 : dataMin;
    const zoomHigh = hasSpot ? spotPrice * 1.07 : dataMax;
    return [zoomLow, zoomHigh];
  }, [hasProfile, spotPrice, dataMin, dataMax]);
  const activeRange = strikeRange || defaultRange;

  useEffect(() => {
    if (!Plotly || !chartRef.current || !hasProfile) return;

    const traces = [
      {
        x: split.negX,
        y: split.negY,
        type: 'scatter',
        mode: 'lines',
        name: 'Negative Gamma',
        line: { color: PLOTLY_COLORS.negative, width: 2 },
        fill: 'tozeroy',
        fillcolor: 'rgba(231, 76, 60, 0.35)',
        connectgaps: false,
        hovertemplate: 'SPX %{x:,.0f}<br>γ notional: %{y:.3s}<extra></extra>',
      },
      {
        x: split.posX,
        y: split.posY,
        type: 'scatter',
        mode: 'lines',
        name: 'Positive Gamma',
        line: { color: PLOTLY_COLORS.positive, width: 2 },
        fill: 'tozeroy',
        fillcolor: 'rgba(46, 204, 113, 0.35)',
        connectgaps: false,
        hovertemplate: 'SPX %{x:,.0f}<br>γ notional: %{y:.3s}<extra></extra>',
      },
    ];

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
    pushLine(volFlip, PLOTLY_COLORS.highlight);

    const [zoomLow, zoomHigh] = activeRange || [dataMin, dataMax];

    const layout = {
      ...PLOTLY_BASE_LAYOUT_2D,
      margin: mobile ? { t: 45, r: 15, b: 40, l: 50 } : { t: 85, r: 30, b: 45, l: 80 },
      title: {
        ...plotlyTitle('AI Gamma Inflection'),
        y: 0.97,
        yanchor: 'top',
      },
      xaxis: plotlyAxis('', {
        title: '',
        range: [zoomLow, zoomHigh],
        autorange: false,
      }),
      yaxis: plotlyAxis(mobile ? '' : 'Dealer Gamma Notional ($ per 1% move)', {
        zerolinewidth: 2,
        tickformat: '.2s',
        ticks: 'outside',
        ticklen: 8,
        tickcolor: 'transparent',
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

      // Anchor FLIP above the main x-axis tick-label strip (the strike-price
      // row Plotly renders at the bottom of the data plot). Prefer the
      // rendered `.xaxislayer-above` group's bounding box since it's what
      // actually contains the tick labels; fall back to a geometric offset
      // from the plot area if the selector changes in a future Plotly release.
      let bottomY;
      const container = chartRef.current;
      if (container) {
        const containerRect = container.getBoundingClientRect();
        const xAxisLayer = container.querySelector('.xaxislayer-above');
        if (xAxisLayer) {
          const layerRect = xAxisLayer.getBoundingClientRect();
          bottomY = layerRect.top - containerRect.top - 10;
        } else {
          bottomY = mt + plotH * (1 - yDomain[0]) - 35;
        }
      } else {
        bottomY = mt + plotH * (1 - yDomain[0]) - 35;
      }

      // SPOT anchors at the top of the plot area so it can never collide
      // with FLIP at the bottom, regardless of how close spot sits to the
      // volatility flip level. The 10px offset from mt mirrors the 10px
      // clearance bottomY leaves between FLIP and the x-axis tick strip.
      const topY = mt + 10;

      // Query the rendered title SVG group so the Put Gamma / Call Gamma
      // corner labels can sit on the exact same horizontal baseline as the
      // "AI Gamma Chart" title, regardless of how Plotly internally resolves
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

      // Corner labels (Put Gamma / Call Gamma) render outside the collision
      // pipeline because they sit in fixed positions at the top corners of
      // the card and never collide with any level label. SPOT and FLIP are
      // anchored at opposite vertical ends of the plot area — SPOT at the
      // top of the dashed blue spot line, FLIP above the x-axis tick strip —
      // so they can no longer collide visually even when spot sits directly
      // on the volatility flip level. The vertical separation also visually
      // demonstrates the distance between spot and the regime boundary,
      // since the two labels sit on opposite edges of the same plot area
      // the dashed lines cross. Each label is still routed through
      // `mergeCollidingLabels` as its own single-element candidate list so
      // the segment-shape normalization in the helper stays the source of
      // truth for the `KEY VALUE` display string across every label on the
      // dashboard.
      const newLabels = [];
      if (!mobile) {
        // Push the Put Gamma label right when the reset button is
        // visible in the upper-left corner so the two do not collide
        // horizontally; restore the tight 20px offset otherwise.
        const putOffset = strikeRange != null ? 85 : 20;
        newLabels.push(
          { corner: 'left', offset: putOffset, top: titleTop, color: PLOTLY_COLORS.negative, text: 'Put Gamma' },
          { corner: 'right', offset: 20, top: titleTop, color: PLOTLY_COLORS.positive, text: 'Call Gamma' },
        );
      }

      const bottomCandidates = [];
      if (volFlip != null) {
        bottomCandidates.push({
          key: 'FLIP',
          value: volFlip,
          priority: 2,
          x: px(volFlip),
          top: bottomY,
          color: PLOTLY_COLORS.highlight,
        });
      }
      for (const merged of mergeCollidingLabels(bottomCandidates)) {
        newLabels.push({ level: true, anchor: 'bottom', ...merged });
      }

      const topCandidates = [];
      if (spotPrice != null) {
        topCandidates.push({
          key: 'SPX',
          value: spotPrice,
          priority: 3,
          x: px(spotPrice),
          top: topY,
          color: PLOTLY_COLORS.primary,
        });
      }
      for (const merged of mergeCollidingLabels(topCandidates)) {
        newLabels.push({ level: true, anchor: 'top', ...merged });
      }
      setLabels(newLabels);
    });
  }, [Plotly, hasProfile, split, spotPrice, volFlip, profile, mobile, activeRange, dataMin, dataMax]);

  const handleBrushChange = useCallback((min, max) => {
    setStrikeRange([min, max]);
  }, []);

  if (plotlyError) {
    return (
      <div
        className="card"
        style={{ padding: '1rem', marginBottom: '1rem', color: 'var(--accent-coral)' }}
      >
        Gamma inflection chart unavailable — Plotly failed to load ({plotlyError}).
      </div>
    );
  }

  if (!hasProfile) {
    return (
      <div className="card text-muted" style={{ marginBottom: '1rem' }}>
        Gamma inflection curve unavailable for this run — the profile is computed
        at ingest time and older runs predate that pass.
      </div>
    );
  }

  return (
    <div className="card" style={{ marginBottom: '1rem', position: 'relative' }}>
      <ResetButton visible={strikeRange != null} onClick={() => setStrikeRange(null)} />
      <div style={{ position: 'relative' }}>
        <div
          ref={chartRef}
          style={{ width: '100%', height: '700px', backgroundColor: 'var(--bg-card)' }}
        />
        {activeRange && dataMin != null && dataMax != null && (
          <RangeBrush
            min={dataMin}
            max={dataMax}
            activeMin={activeRange[0]}
            activeMax={activeRange[1]}
            onChange={handleBrushChange}
          />
        )}
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
                left: l.x,
                top: l.top,
                transform: l.anchor === 'top' ? 'translate(-50%, 0)' : 'translate(-50%, -100%)',
                color: l.color,
                border: `1.5px solid ${l.color}`,
              }}
            >
              {l.segments.map((s, si) => (
                <span key={s.key}>
                  {si > 0 && <span style={{ color: PLOTLY_COLORS.axisText }}> / </span>}
                  <span style={{ color: s.color }}>{s.display}</span>
                </span>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
