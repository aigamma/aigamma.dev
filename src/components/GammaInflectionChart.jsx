import { useEffect, useMemo, useRef, useState } from 'react';
import usePlotly from '../hooks/usePlotly';
import {
  PLOTLY_BASE_LAYOUT_2D,
  PLOTLY_COLORS,
  plotlyAxis,
  plotlyRangeslider,
  plotlyTitle,
} from '../lib/plotlyTheme';

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

  const profile = levels?.gamma_profile || null;
  const volFlip = levels?.volatility_flip ?? null;

  const split = useMemo(() => splitByZero(profile), [profile]);
  const hasProfile = profile && profile.length > 0;

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
        hovertemplate: 'Spot %{x:,.0f}<br>γ notional: %{y:.3s}<extra></extra>',
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
        hovertemplate: 'Spot %{x:,.0f}<br>γ notional: %{y:.3s}<extra></extra>',
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

    const layout = {
      ...PLOTLY_BASE_LAYOUT_2D,
      margin: { t: 85, r: 30, b: 70, l: 80 },
      title: {
        ...plotlyTitle('AI Gamma Chart'),
        y: 0.97,
        yanchor: 'top',
      },
      xaxis: plotlyAxis('', { title: '', rangeslider: plotlyRangeslider() }),
      yaxis: plotlyAxis('Dealer Gamma Notional ($ per 1% move)', {
        zerolinewidth: 2,
        tickformat: '.2s',
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

      // The rangeslider eats into the y-domain from below, so the data plot
      // bottom edge sits above the rangeslider strip rather than at mt+plotH.
      const yDomain = fl.yaxis?.domain || [0, 1];
      const dataTopY = mt + plotH * (1 - yDomain[1]);
      const dataBotY = mt + plotH * (1 - yDomain[0]);
      const topY = dataTopY - 5;
      const bottomY = dataBotY - 8;

      const newLabels = [];
      if (spotPrice != null) {
        newLabels.push({
          left: px(spotPrice),
          top: topY,
          color: PLOTLY_COLORS.primary,
          text: 'SPOT',
        });
      }
      if (volFlip != null) {
        newLabels.push({
          left: px(volFlip),
          top: bottomY,
          color: PLOTLY_COLORS.highlight,
          text: 'FLIP',
        });
      }
      setLabels(newLabels);
    });
  }, [Plotly, hasProfile, split, spotPrice, volFlip]);

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
    <div className="card" style={{ marginBottom: '1rem' }}>
      <div style={{ position: 'relative' }}>
        <div
          ref={chartRef}
          style={{ width: '100%', height: '620px', backgroundColor: 'var(--bg-card)' }}
        />
        {labels.map((l, i) => (
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
        ))}
      </div>
    </div>
  );
}
