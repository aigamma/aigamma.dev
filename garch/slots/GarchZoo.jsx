import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import usePlotly from '../../src/hooks/usePlotly';
import useIsMobile from '../../src/hooks/useIsMobile';
import { useGexHistory } from '../../src/hooks/useHistoricalData';
import {
  PLOTLY_COLORS,
  PLOTLY_FONTS,
  plotly2DChartLayout,
  plotlyAxis,
  plotlyTitle,
} from '../../src/lib/plotlyTheme';
import RangeBrush from '../../src/components/RangeBrush';
import ResetButton from '../../src/components/ResetButton';
import { fitAll, forecastAll, annualize, horizonSigma } from '../garch';

// -----------------------------------------------------------------------------
// GARCH family zoo — single slot on /garch/
//
// Fits 17 univariate GARCH-family specifications by Gaussian MLE on the daily
// SPX log-return series from /api/gex-history, renders each model's in-sample
// conditional σ path, overlays an equal-weight master ensemble across visible
// models, and forecasts `FORECAST_HORIZON` trading days forward.
//
// Specifications: GARCH(1,1), IGARCH, EGARCH, GJR, TGARCH, APARCH, NAGARCH,
// NGARCH, AVGARCH, CGARCH, GAS, FIGARCH, HYGARCH, MS-GARCH, Realized GARCH,
// HEAVY, and GARCH-M (the only one fit on raw returns rather than demeaned,
// because its mean equation carries λ as a free parameter).
//
// The multivariate fitters (CCC / DCC / BEKK / OGARCH) stay in the library
// but are not invoked here — without a second series passed to fitAll they
// sit idle. They were dropped from this page because the SPX-vs-positioning
// ρ₁₂(t) time series they produced had no actionable reading attached.
//
// The family picker above the chart lets a viewer hide a whole family —
// e.g., drop the absolute-value family or the realized-measure family — and
// the ensemble plus the forecast tail recompute over whatever remains
// visible.
// -----------------------------------------------------------------------------

const FORECAST_HORIZON = 30;
const CHART_LOOKBACK_DAYS = 180;

function buildLogReturns(series) {
  const rows = [];
  for (let i = 1; i < series.length; i++) {
    const p0 = series[i - 1].spx_close;
    const p1 = series[i].spx_close;
    if (!(p0 > 0) || !(p1 > 0)) continue;
    const r = Math.log(p1 / p0);
    if (!Number.isFinite(r)) continue;
    rows.push({
      date: series[i].trading_date,
      r,
      hv10: series[i].hv_10d,
    });
  }
  return rows;
}

function isoToMs(iso) {
  return new Date(`${iso}T00:00:00Z`).getTime();
}

function msToIso(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function advanceBusinessDays(iso, n) {
  const cursor = new Date(`${iso}T00:00:00Z`);
  for (let i = 0; i < n; i++) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    while (cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }
  return cursor.toISOString().slice(0, 10);
}

function formatPct(v, digits = 2) {
  if (v == null || !Number.isFinite(v)) return '–';
  return `${(v * 100).toFixed(digits)}%`;
}

function formatNum(v, digits = 4) {
  if (v == null || !Number.isFinite(v)) return '–';
  if (Math.abs(v) < 1e-4 && v !== 0) return v.toExponential(2);
  return v.toFixed(digits);
}

function primaryAlpha(m) {
  const p = m.params;
  if (!p) return null;
  if (p.alpha != null) return p.alpha;
  if (p.alphaPos != null && p.alphaNeg != null) return (p.alphaPos + p.alphaNeg) / 2;
  return null;
}
function leverageTerm(m) {
  const p = m.params;
  if (!p) return null;
  if (p.gamma != null) return p.gamma;
  if (p.theta != null) return p.theta;
  if (p.alphaPos != null && p.alphaNeg != null) return p.alphaNeg - p.alphaPos;
  if (p.lambda != null) return p.lambda;
  return null;
}
function powerTerm(m) {
  const p = m.params;
  if (!p) return null;
  if (p.delta != null) return p.delta;
  if (p.d != null) return p.d;
  if (p.mix != null) return p.mix;
  return null;
}
function persistenceOf(m) {
  const p = m.params;
  if (!p) return null;
  if (m.name === 'GARCH(1,1)') return p.alpha + p.beta;
  if (m.name === 'IGARCH(1,1)') return 1;
  if (m.name === 'GJR-GARCH') return p.alpha + p.gamma / 2 + p.beta;
  if (m.name === 'EGARCH(1,1)') return Math.abs(p.beta);
  if (m.name === 'TGARCH') return (p.alphaPos + p.alphaNeg) * Math.sqrt(1 / (2 * Math.PI)) * 2 + p.beta;
  if (m.name === 'NAGARCH') return p.alpha * (1 + p.theta * p.theta) + p.beta;
  if (m.name === 'APARCH') return p.alpha + p.beta;
  if (m.name === 'NGARCH') return p.alpha + p.beta;
  if (m.name === 'AVGARCH') return p.alpha * Math.sqrt(2 / Math.PI) + p.beta;
  if (m.name === 'CGARCH') return p.rho;
  if (m.name === 'GAS') return Math.abs(p.beta);
  if (m.name === 'FIGARCH') return 1;
  if (m.name === 'HYGARCH') return p.mix + (1 - p.mix) * (p.alpha + p.beta);
  if (m.name === 'MS-GARCH') return (p.alpha1 + p.beta1 + p.alpha2 + p.beta2) / 2;
  if (m.name === 'Realized GARCH') return p.beta + p.gamma;
  if (m.name === 'HEAVY') return p.alpha + p.beta;
  if (m.name === 'GARCH-M') return p.alpha + p.beta;
  return null;
}

function StatCell({ label, value, sub, accent }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div
        style={{
          fontSize: '0.72rem',
          color: 'var(--text-secondary)',
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          marginBottom: '0.3rem',
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: 'Courier New, monospace',
          fontSize: '1.25rem',
          color: accent || 'var(--text-primary)',
        }}
      >
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.2rem' }}>
          {sub}
        </div>
      )}
    </div>
  );
}

const FAMILY_COLORS = {
  symmetric:    '#4a9eff',  // accent-blue
  asymmetric:   '#d85a30',  // accent-coral
  power:        '#a67bd6',  // purple
  absolute:     '#f0a030',  // accent-amber
  component:    '#4acfc1',  // teal
  mean:         '#d64ab0',  // magenta
  score:        '#6bc3d6',  // light blue
  'long-memory':'#e06040',  // warm red
  regime:       '#f0d040',  // gold
  realized:     '#88d04a',  // lime
};

const ENSEMBLE_COLOR = '#2ecc71'; // accent-green

function modelColor(m, idxWithinFamily) {
  const base = FAMILY_COLORS[m.family] || 'var(--text-secondary)';
  if (!idxWithinFamily) return base;
  const hex = base.replace('#', '');
  if (hex.length !== 6) return base;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const shift = idxWithinFamily * 18;
  const clamp = (v) => Math.max(0, Math.min(255, v));
  const r2 = clamp(r + shift).toString(16).padStart(2, '0');
  const g2 = clamp(g + shift).toString(16).padStart(2, '0');
  const b2 = clamp(b - shift / 2).toString(16).padStart(2, '0');
  return `#${r2}${g2}${b2}`;
}

export default function GarchZoo() {
  const chartRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();
  const mobile = useIsMobile();
  const { data, loading, error } = useGexHistory({});
  const [fitState, setFitState] = useState({ fit: null, forecast: null, error: null });
  const [hiddenFamilies, setHiddenFamilies] = useState(() => new Set());

  const returnsWithDate = useMemo(() => {
    if (!data?.series) return null;
    return buildLogReturns(data.series);
  }, [data]);

  useEffect(() => {
    if (!returnsWithDate || returnsWithDate.length < 200) return;
    let cancelled = false;
    const handle = setTimeout(() => {
      try {
        const returns = returnsWithDate.map((r) => r.r);
        const fit = fitAll(returns);
        const forecast = forecastAll(fit, FORECAST_HORIZON);
        if (!cancelled) setFitState({ fit, forecast, error: null });
      } catch (err) {
        if (!cancelled) setFitState({ fit: null, forecast: null, error: err.message });
      }
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [returnsWithDate]);

  const lastRealizedHv = useMemo(() => {
    if (!returnsWithDate) return null;
    for (let i = returnsWithDate.length - 1; i >= 0; i--) {
      if (returnsWithDate[i].hv10 != null) return returnsWithDate[i].hv10;
    }
    return null;
  }, [returnsWithDate]);

  const firstHistoricalDate = returnsWithDate?.[0]?.date ?? null;
  const lastHistoricalDate = returnsWithDate?.[returnsWithDate.length - 1]?.date ?? null;
  const lastForecastDate = useMemo(() => {
    if (!lastHistoricalDate) return null;
    return advanceBusinessDays(lastHistoricalDate, FORECAST_HORIZON);
  }, [lastHistoricalDate]);

  // Brush domain spans the full historical sample plus the forecast tail
  // so the user can pan into older σ paths to inspect model fit on prior
  // regimes, or focus the window on the forecast neighborhood. The
  // default opens to the last CHART_LOOKBACK_DAYS of history through the
  // end of the forecast — same window the page used to render before the
  // brush was wired in, so the initial view is unchanged from v1.
  const defaultRange = useMemo(() => {
    if (!returnsWithDate || returnsWithDate.length === 0 || !lastForecastDate) return null;
    const idx = Math.max(0, returnsWithDate.length - CHART_LOOKBACK_DAYS);
    return [returnsWithDate[idx].date, lastForecastDate];
  }, [returnsWithDate, lastForecastDate]);

  const [timeRange, setTimeRange] = useState(null);
  const activeRange = timeRange || defaultRange;

  const handleBrushChange = useCallback((minMs, maxMs) => {
    setTimeRange([msToIso(minMs), msToIso(maxMs)]);
  }, []);

  // Families present in the current fit, in fit-order, so the picker
  // reads left-to-right in the same order the chart legend does.
  const familiesInFit = useMemo(() => {
    if (!fitState.fit) return [];
    const seen = new Set();
    const order = [];
    for (const m of fitState.fit.models) {
      if (m.condVar != null && !seen.has(m.family)) {
        seen.add(m.family);
        order.push(m.family);
      }
    }
    return order;
  }, [fitState]);

  const visibleModels = useMemo(() => {
    if (!fitState.fit) return [];
    return fitState.fit.models.filter(
      (m) => m.condVar != null && !hiddenFamilies.has(m.family),
    );
  }, [fitState, hiddenFamilies]);

  // Equal-weight ensemble over just the visible subset, recomputed any
  // time the picker toggles. Matches in-sample condVar with the forecast
  // by model name so a hidden family drops out of both panels at once.
  const visibleEnsemble = useMemo(() => {
    if (!fitState.forecast || visibleModels.length === 0) return null;
    const T = visibleModels[0].condVar.length;
    const condVar = new Array(T).fill(0);
    for (let t = 0; t < T; t++) {
      for (const m of visibleModels) condVar[t] += m.condVar[t] / visibleModels.length;
    }
    const keep = new Set(visibleModels.map((m) => m.name));
    const fs = fitState.forecast.perModel.filter((f) => keep.has(f.name));
    const H = fs[0]?.path.length ?? 0;
    const path = new Array(H).fill(0);
    for (let h = 0; h < H; h++) {
      for (const f of fs) path[h] += f.path[h] / fs.length;
    }
    return {
      condVar,
      path,
      sigma1d: H > 0 ? annualize(path[0]) : null,
      sigma10d: horizonSigma(path, 10),
      sigma21d: horizonSigma(path, 21),
    };
  }, [fitState, visibleModels]);

  useEffect(() => {
    if (!Plotly || !chartRef.current || !fitState.fit || !visibleEnsemble || !returnsWithDate || !activeRange) return;

    // Trace data spans the full historical sample; the brush narrows the
    // visible window via the x-axis range below, not by slicing inputs.
    // This matches the site-wide RangeBrush pattern (see DealerGammaRegime)
    // and lets the user pan into older σ history without refitting.
    const dates = returnsWithDate.map((r) => r.date);
    const hvSeries = returnsWithDate.map((r) =>
      r.hv10 != null ? r.hv10 * 100 : null,
    );
    const toAnnPct = (arr) => arr.map((v) => {
      const a = annualize(v);
      return a != null ? a * 100 : null;
    });

    const traces = [
      {
        x: dates,
        y: hvSeries,
        mode: 'lines',
        type: 'scatter',
        name: 'Realized vol (10d)',
        line: { color: PLOTLY_COLORS.axisText, width: 1, dash: 'dot' },
        connectgaps: false,
        hovertemplate: '<b>%{x}</b><br>realized vol (10d): %{y:.2f}%<extra></extra>',
      },
    ];

    const familyCount = {};
    visibleModels.forEach((m) => {
      const k = m.family;
      const idx = familyCount[k] = (familyCount[k] ?? -1) + 1;
      traces.push({
        x: dates,
        y: toAnnPct(m.condVar),
        mode: 'lines',
        type: 'scatter',
        name: m.name,
        line: { color: modelColor(m, idx), width: 1 },
        opacity: 0.6,
        hovertemplate: `<b>%{x}</b><br>${m.name}: %{y:.2f}%<extra></extra>`,
      });
    });

    traces.push({
      x: dates,
      y: toAnnPct(visibleEnsemble.condVar),
      mode: 'lines',
      type: 'scatter',
      name: 'Ensemble average',
      line: { color: ENSEMBLE_COLOR, width: 2.4 },
      hovertemplate: '<b>%{x}</b><br>ensemble average σ: %{y:.2f}%<extra></extra>',
    });

    // Forecast tail
    const lastDate = new Date(dates[dates.length - 1] + 'T00:00:00Z');
    const forecastDates = [];
    const cursor = new Date(lastDate);
    for (let i = 0; i < visibleEnsemble.path.length; i++) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      while (cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6) {
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
      forecastDates.push(cursor.toISOString().slice(0, 10));
    }
    const lastEnsembleVar = visibleEnsemble.condVar[visibleEnsemble.condVar.length - 1];
    const lastEnsembleSigma = annualize(lastEnsembleVar);
    traces.push({
      x: [dates[dates.length - 1], ...forecastDates],
      y: [
        lastEnsembleSigma != null ? lastEnsembleSigma * 100 : null,
        ...visibleEnsemble.path.map((v) => {
          const a = annualize(v);
          return a != null ? a * 100 : null;
        }),
      ],
      mode: 'lines',
      type: 'scatter',
      name: 'Ensemble forecast (30d)',
      line: { color: ENSEMBLE_COLOR, width: 2.4, dash: 'dash' },
      hovertemplate: '<b>%{x}</b><br>ensemble forecast σ: %{y:.2f}%<extra></extra>',
    });

    // Plotly's autorange would otherwise scan the full trace data — which
    // now spans the entire history — and stretch the y-axis to cover
    // out-of-window σ spikes (e.g. the 2020 COVID-era 100%+ readings),
    // leaving the visible σ paths squashed against the bottom of the
    // chart. Compute a tight y-range over only the points whose x falls
    // inside activeRange so the y-axis fits the visible window. Mirrors
    // `computeYRange` in src/components/DealerGammaRegime.jsx.
    const [xStart, xEnd] = activeRange;
    let yMin = Infinity;
    let yMax = -Infinity;
    for (const tr of traces) {
      const xs = tr.x;
      const ys = tr.y;
      for (let i = 0; i < xs.length; i++) {
        const xv = xs[i];
        const yv = ys[i];
        if (yv == null || !Number.isFinite(yv)) continue;
        if (xv < xStart || xv > xEnd) continue;
        if (yv < yMin) yMin = yv;
        if (yv > yMax) yMax = yv;
      }
    }
    let yRange = null;
    if (Number.isFinite(yMin) && Number.isFinite(yMax)) {
      if (yMax === yMin) {
        const pad = Math.max(yMin * 0.1, 0.5);
        yRange = [Math.max(0, yMin - pad), yMax + pad];
      } else {
        const pad = (yMax - yMin) * 0.08;
        yRange = [Math.max(0, yMin - pad), yMax + pad];
      }
    }

    const totalOk = fitState.fit.models.filter((m) => m.condVar != null).length;
    const titleSpecs = visibleModels.length === totalOk
      ? `${totalOk} specifications + ensemble average`
      : `${visibleModels.length} of ${totalOk} specifications + ensemble average`;
    const titleText = mobile
      ? `GARCH Ensemble · Conditional σ (Annualized)<br>${titleSpecs}`
      : `GARCH Ensemble · Conditional σ (Annualized) · ${titleSpecs}`;
    const layout = plotly2DChartLayout({
      title: {
        ...plotlyTitle(titleText),
        y: 0.97,
        yref: 'container',
        yanchor: 'top',
      },
      margin: mobile ? { t: 75, r: 20, b: 110, l: 60 } : { t: 70, r: 30, b: 120, l: 75 },
      xaxis: plotlyAxis('', { type: 'date', range: activeRange, autorange: false }),
      yaxis: plotlyAxis('σ (%)', {
        ticksuffix: '%',
        tickformat: '.1f',
        ...(yRange ? { range: yRange, autorange: false } : {}),
      }),
      showlegend: true,
      legend: {
        orientation: 'h',
        y: -0.14,
        x: 0.5,
        xanchor: 'center',
        font: PLOTLY_FONTS.legend,
      },
      hovermode: 'x unified',
    });

    Plotly.react(chartRef.current, traces, layout, {
      responsive: true,
      displayModeBar: false,
    });
  }, [Plotly, fitState, visibleModels, visibleEnsemble, returnsWithDate, mobile, activeRange]);

  if (loading && !data) {
    return (
      <div className="lab-placeholder">
        <div className="lab-placeholder-title">Loading SPX history…</div>
        <div className="lab-placeholder-hint">
          Fetching the daily close series from <code>/api/gex-history</code>.
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="lab-placeholder" style={{ borderColor: 'var(--accent-coral)' }}>
        <div className="lab-placeholder-title" style={{ color: 'var(--accent-coral)' }}>
          History fetch failed
        </div>
        <div className="lab-placeholder-hint">{error}</div>
      </div>
    );
  }

  if (plotlyError) {
    return (
      <div className="lab-placeholder" style={{ borderColor: 'var(--accent-coral)' }}>
        <div className="lab-placeholder-title" style={{ color: 'var(--accent-coral)' }}>
          Plotly unavailable
        </div>
        <div className="lab-placeholder-hint">{plotlyError}</div>
      </div>
    );
  }

  if (!returnsWithDate || returnsWithDate.length < 200) {
    return (
      <div className="lab-placeholder">
        <div className="lab-placeholder-title">Not enough history</div>
        <div className="lab-placeholder-hint">
          Need at least 200 daily returns to fit the GARCH family;
          the current history endpoint returned {returnsWithDate?.length ?? 0}.
        </div>
      </div>
    );
  }

  if (fitState.error) {
    return (
      <div className="lab-placeholder" style={{ borderColor: 'var(--accent-coral)' }}>
        <div className="lab-placeholder-title" style={{ color: 'var(--accent-coral)' }}>
          Fit failed
        </div>
        <div className="lab-placeholder-hint">{fitState.error}</div>
      </div>
    );
  }

  if (!fitState.fit) {
    return (
      <div className="lab-placeholder">
        <div className="lab-placeholder-title">Fitting zoo…</div>
        <div className="lab-placeholder-hint">
          17 GARCH-family specifications by Gaussian MLE on{' '}
          {returnsWithDate.length.toLocaleString()} daily returns. Nelder-Mead
          in-browser, serial fit with FIGARCH / HYGARCH / MS-GARCH the
          expensive ones. Typical wall-clock: 2–5 seconds on a modern laptop.
        </div>
      </div>
    );
  }

  const { fit } = fitState;
  const ok = fit.models.filter((m) => m.condVar != null);
  const failed = fit.models.filter((m) => m.condVar == null);

  const familyCount = {};
  const rowColors = visibleModels.map((m) => {
    const k = m.family;
    const idx = familyCount[k] = (familyCount[k] ?? -1) + 1;
    return modelColor(m, idx);
  });

  const familyCounts = {};
  for (const m of ok) familyCounts[m.family] = (familyCounts[m.family] ?? 0) + 1;

  return (
    <div className="card" style={{ padding: '1.25rem 1.25rem 1rem' }}>
      <div
        style={{
          fontFamily: 'Courier New, monospace',
          fontSize: '0.7rem',
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--accent-amber)',
          marginBottom: '0.6rem',
        }}
      >
        GARCH Ensemble
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: mobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)',
          gap: '1rem',
          padding: '0.85rem 0',
          borderTop: '1px solid var(--bg-card-border)',
          borderBottom: '1px solid var(--bg-card-border)',
          marginBottom: '0.85rem',
        }}
      >
        <StatCell
          label="σ (1-day)"
          value={formatPct(visibleEnsemble?.sigma1d, 2)}
          sub="ensemble average · annualized"
          accent={ENSEMBLE_COLOR}
        />
        <StatCell
          label="σ (10-day)"
          value={formatPct(visibleEnsemble?.sigma10d, 2)}
          sub="ensemble average · annualized"
          accent={ENSEMBLE_COLOR}
        />
        <StatCell
          label="σ (21-day)"
          value={formatPct(visibleEnsemble?.sigma21d, 2)}
          sub="ensemble average · one-month"
          accent={ENSEMBLE_COLOR}
        />
        <StatCell
          label="Realized vol"
          value={formatPct(lastRealizedHv, 2)}
          sub="last close · trailing 10 days"
        />
      </div>

      {/* Family picker: toggle a family on or off. The ensemble recomputes. */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '0.4rem',
          alignItems: 'center',
          marginBottom: '0.75rem',
        }}
      >
        <span
          style={{
            fontSize: '0.7rem',
            color: 'var(--text-secondary)',
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
            marginRight: '0.25rem',
          }}
        >
          families:
        </span>
        {familiesInFit.map((fam) => {
          const active = !hiddenFamilies.has(fam);
          const color = FAMILY_COLORS[fam] || 'var(--text-secondary)';
          return (
            <button
              key={fam}
              type="button"
              onClick={() => {
                setHiddenFamilies((prev) => {
                  const next = new Set(prev);
                  if (next.has(fam)) next.delete(fam);
                  else next.add(fam);
                  return next;
                });
              }}
              style={{
                background: active ? `${color}1a` : 'transparent',
                border: `1px solid ${active ? color : 'var(--bg-card-border)'}`,
                color: active ? color : 'var(--text-secondary)',
                padding: '0.3rem 0.65rem',
                fontFamily: 'Courier New, monospace',
                fontSize: '0.74rem',
                cursor: 'pointer',
                borderRadius: '3px',
                opacity: active ? 1 : 0.55,
                textTransform: 'lowercase',
                letterSpacing: '0.02em',
              }}
              title={active ? `hide ${fam}` : `show ${fam}`}
            >
              {fam} · {familyCounts[fam] ?? 0}
            </button>
          );
        })}
        {hiddenFamilies.size > 0 && (
          <button
            type="button"
            onClick={() => setHiddenFamilies(new Set())}
            style={{
              background: 'transparent',
              border: '1px solid var(--bg-card-border)',
              color: 'var(--text-secondary)',
              padding: '0.3rem 0.65rem',
              fontFamily: 'Courier New, monospace',
              fontSize: '0.74rem',
              cursor: 'pointer',
              borderRadius: '3px',
              marginLeft: '0.25rem',
            }}
            title="Show all families"
          >
            reset
          </button>
        )}
      </div>

      {visibleModels.length === 0 ? (
        <div
          style={{
            width: '100%',
            height: mobile ? 480 : 720,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: '1px dashed var(--bg-card-border)',
            borderRadius: '4px',
            color: 'var(--text-secondary)',
            fontSize: '0.85rem',
          }}
        >
          All families hidden. Toggle one back on or hit reset.
        </div>
      ) : (
        <div style={{ position: 'relative' }}>
          <ResetButton visible={timeRange != null} onClick={() => setTimeRange(null)} />
          <div ref={chartRef} style={{ width: '100%', height: mobile ? 480 : 720 }} />
          {activeRange && firstHistoricalDate && lastForecastDate && (
            <RangeBrush
              min={isoToMs(firstHistoricalDate)}
              max={isoToMs(lastForecastDate)}
              activeMin={isoToMs(activeRange[0])}
              activeMax={isoToMs(activeRange[1])}
              onChange={handleBrushChange}
            />
          )}
        </div>
      )}

      <div
        style={{
          fontSize: '0.88rem',
          color: 'var(--text-secondary)',
          lineHeight: 1.6,
          maxWidth: '820px',
          marginTop: '1.5rem',
        }}
      >
        <p style={{ margin: '0 0 0.7rem' }}>
          17 volatility models fit on daily SPX log returns. Each colored
          line above is one model&apos;s conditional σ path, annualized to
          percent. The{' '}
          <strong style={{ color: ENSEMBLE_COLOR }}>
            bold green line is the ensemble average
          </strong>{' '}
          (equal-weight mean across the visible models), and the dashed
          green tail is its 30-day forward forecast. The dotted white line
          is realized vol over the trailing 10 trading days, shown as a
          reality check against the model fits.
        </p>

        <p style={{ margin: '0 0 0.7rem' }}>
          Compare the{' '}
          <strong style={{ color: ENSEMBLE_COLOR }}>ensemble average</strong>{' '}
          to the dotted realized-vol line. Ensemble above realized means
          the models expect volatility to rise from here. Ensemble below
          realized means they expect mean reversion back down. A tight
          cluster of model lines around the ensemble is high forecast
          confidence. A fan-out means the families disagree and the
          regime is ambiguous.
        </p>

        <p style={{ margin: '0 0 0.5rem', color: 'var(--text-primary)' }}>
          Each family picks up a different piece of the volatility
          signal. Hide a family with the picker above the chart to see
          how much of the ensemble depends on it.
        </p>

        <ul
          style={{
            margin: '0 0 0.7rem',
            paddingLeft: '1.1rem',
            lineHeight: 1.55,
          }}
        >
          <li>
            <strong style={{ color: FAMILY_COLORS.symmetric }}>
              Symmetric (GARCH, IGARCH)
            </strong>
            : baseline. Volatility clusters without regard to the
            direction of the return.
          </li>
          <li>
            <strong style={{ color: FAMILY_COLORS.asymmetric }}>
              Asymmetric (GJR, EGARCH, TGARCH, NAGARCH)
            </strong>
            : leverage effect. Down days spike vol more than up days.
            When these run above the symmetric line, the market is
            pricing asymmetric downside fear.
          </li>
          <li>
            <strong style={{ color: FAMILY_COLORS.power }}>
              Power (APARCH, NGARCH)
            </strong>
            : adjustable response to outlier days. Softer below
            δ&nbsp;=&nbsp;2, more extreme above it.
          </li>
          <li>
            <strong style={{ color: FAMILY_COLORS.absolute }}>
              Absolute (AVGARCH)
            </strong>
            : models σ directly rather than variance. Less reactive to
            single extreme days. If it diverges from the quadratic
            models, a handful of tail days is doing most of the work
            in the others.
          </li>
          <li>
            <strong style={{ color: FAMILY_COLORS.component }}>
              Component (CGARCH)
            </strong>
            : splits a slow long-run mean of vol from short-run shocks.
            Read its slow component as the vol level the market is
            gravitating back toward.
          </li>
          <li>
            <strong style={{ color: FAMILY_COLORS.mean }}>
              In-mean (GARCH-M)
            </strong>
            : lets vol feed back into expected return. Use it as a read
            on the risk premium currently priced into SPX.
          </li>
          <li>
            <strong style={{ color: FAMILY_COLORS.score }}>
              Score-driven (GAS)
            </strong>
            : robust to occasional jumps. The steadier read of baseline
            vol when recent history has a few outlier days.
          </li>
          <li>
            <strong style={{ color: FAMILY_COLORS['long-memory'] }}>
              Long-memory (FIGARCH, HYGARCH)
            </strong>
            : fractional persistence. Shocks decay over weeks to
            quarters, not days. Watch these when the question is how
            long a spike will linger.
          </li>
          <li>
            <strong style={{ color: FAMILY_COLORS.regime }}>
              Regime (MS-GARCH)
            </strong>
            : switches between a calm and a stress regime. When the
            stress regime dominates the weighted average, you are not
            in a typical diffusion regime anymore.
          </li>
          <li>
            <strong style={{ color: FAMILY_COLORS.realized }}>
              Realized (Realized GARCH, HEAVY)
            </strong>
            : pulls in a 5-day realized-variance proxy. Reacts faster
            to observed stress than the pure return-based models.
          </li>
        </ul>

        <p style={{ margin: 0 }}>
          If hiding one family visibly moves the{' '}
          <strong style={{ color: ENSEMBLE_COLOR }}>
            green ensemble line
          </strong>
          , that family is load-bearing for the current read. If the
          ensemble barely moves, the remaining models already agree and
          that family is not adding information right now.
        </p>
      </div>

      <div style={{ marginTop: '1.1rem', overflowX: 'auto' }}>
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: '0.78rem',
            minWidth: '760px',
          }}
        >
          <thead>
            <tr style={{ color: 'var(--text-secondary)', textAlign: 'left' }}>
              {[
                'Model', 'Family', 'k', 'ω', 'α', 'Asym', 'β', 'δ',
                'Persistence', 'log-L', 'BIC',
              ].map((label, i) => (
                <th
                  key={label}
                  style={{
                    padding: '0.45rem 0.55rem',
                    fontWeight: 'normal',
                    textAlign: i <= 1 ? 'left' : 'right',
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleModels.map((m, i) => {
              const p = m.params;
              const pers = persistenceOf(m);
              return (
                <tr key={m.name}>
                  <td style={{ padding: '0.45rem 0.55rem', color: rowColors[i], fontFamily: 'Courier New, monospace' }}>
                    {m.name}
                  </td>
                  <td style={{ padding: '0.45rem 0.55rem', color: 'var(--text-secondary)' }}>
                    {m.family}
                  </td>
                  <td style={{ padding: '0.45rem 0.55rem', fontFamily: 'Courier New, monospace', textAlign: 'right' }}>
                    {m.k}
                  </td>
                  <td style={{ padding: '0.45rem 0.55rem', fontFamily: 'Courier New, monospace', textAlign: 'right' }}>
                    {formatNum(p.omega)}
                  </td>
                  <td style={{ padding: '0.45rem 0.55rem', fontFamily: 'Courier New, monospace', textAlign: 'right' }}>
                    {formatNum(primaryAlpha(m))}
                  </td>
                  <td style={{ padding: '0.45rem 0.55rem', fontFamily: 'Courier New, monospace', textAlign: 'right' }}>
                    {formatNum(leverageTerm(m))}
                  </td>
                  <td style={{ padding: '0.45rem 0.55rem', fontFamily: 'Courier New, monospace', textAlign: 'right' }}>
                    {formatNum(p.beta)}
                  </td>
                  <td style={{ padding: '0.45rem 0.55rem', fontFamily: 'Courier New, monospace', textAlign: 'right' }}>
                    {formatNum(powerTerm(m), 2)}
                  </td>
                  <td style={{ padding: '0.45rem 0.55rem', fontFamily: 'Courier New, monospace', textAlign: 'right' }}>
                    {pers != null ? pers.toFixed(3) : '–'}
                  </td>
                  <td style={{ padding: '0.45rem 0.55rem', fontFamily: 'Courier New, monospace', textAlign: 'right' }}>
                    {m.logLik != null ? m.logLik.toFixed(1) : '–'}
                  </td>
                  <td style={{ padding: '0.45rem 0.55rem', fontFamily: 'Courier New, monospace', textAlign: 'right' }}>
                    {m.bic != null ? m.bic.toFixed(1) : '–'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {failed.length > 0 && (
        <div
          style={{
            marginTop: '0.85rem',
            padding: '0.6rem 0.8rem',
            border: '1px solid var(--accent-coral)',
            borderRadius: '4px',
            fontSize: '0.78rem',
            color: 'var(--accent-coral)',
            fontFamily: 'Courier New, monospace',
          }}
        >
          {failed.length} fit{failed.length === 1 ? '' : 's'} failed:{' '}
          {failed.map((f) => f.name).join(', ')}
        </div>
      )}

      <div
        style={{
          marginTop: '0.85rem',
          fontSize: '0.75rem',
          color: 'var(--text-secondary)',
          lineHeight: 1.6,
        }}
      >
        <p style={{ margin: '0 0 0.5rem' }}>
          Fit in-browser on {returnsWithDate.length.toLocaleString()} daily
          log returns ({returnsWithDate[0].date} to{' '}
          {returnsWithDate[returnsWithDate.length - 1].date}) in{' '}
          {fit.elapsedMs.toFixed(0)}ms across {ok.length} models.
        </p>
        <p style={{ margin: 0 }}>
          <strong style={{ color: 'var(--text-primary)' }}>Persistence</strong>{' '}
          in the table is how sticky a vol shock is. Values near 1 mean a
          shock takes weeks to fade. Values in the 0.90 to 0.97 band are
          typical for SPX and imply vol drifts back to average over
          roughly a month. Values below 0.85 mean vol mean-reverts
          quickly. IGARCH and FIGARCH are pinned at 1 by construction and
          act as upper-bound benchmarks for how slow decay can get.
        </p>
      </div>
    </div>
  );
}
