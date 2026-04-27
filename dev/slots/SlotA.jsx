import { useEffect, useMemo, useRef, useState } from 'react';
import usePlotly from '../../src/hooks/usePlotly';
import useIsMobile from '../../src/hooks/useIsMobile';
import { useGexHistory } from '../../src/hooks/useHistoricalData';
import {
  PLOTLY_COLORS,
  PLOTLY_FONTS,
  PLOTLY_FONT_FAMILY,
  plotly2DChartLayout,
  plotlyAxis,
  plotlyTitle,
} from '../../src/lib/plotlyTheme';
import { fitEnsemble, forecastEnsemble, annualize } from '../garch';

export const slotName = 'GARCH ENSEMBLE';

// -----------------------------------------------------------------------------
// GARCH ensemble — dev-lab proof of concept
//
// This card fits three GARCH-family models on daily SPX log returns and
// renders the ensemble forecast next to each component's individual fit.
// The ensemble is BIC-weighted; the math, the reasoning behind the three-
// model choice, and the forecast construction all live in ./garch.js. The
// returns series is reconstructed from /api/gex-history, which ships a
// full SPX-close column back to 2017-01-03 because the GEX tables index
// off spx_close already. No second data call needed.
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
    rows.push({ date: series[i].trading_date, r, hv10: series[i].hv_10d });
  }
  return rows;
}

function formatPct(v, digits = 2) {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}

function formatParam(v, digits = 4) {
  if (v == null || !Number.isFinite(v)) return '—';
  if (Math.abs(v) < 1e-4) return v.toExponential(2);
  return v.toFixed(digits);
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

function ParamRow({ model, weight, color }) {
  const p = model.params;
  const persistence =
    model.name === 'GARCH(1,1)'
      ? p.alpha + p.beta
      : model.name === 'GJR-GARCH'
        ? p.alpha + (p.gamma ?? 0) / 2 + p.beta
        : Math.abs(p.beta);
  return (
    <tr>
      <td style={{ padding: '0.5rem 0.6rem', color, fontFamily: 'Courier New, monospace' }}>
        {model.name}
      </td>
      <td style={{ padding: '0.5rem 0.6rem', fontFamily: 'Courier New, monospace', textAlign: 'right' }}>
        {formatParam(p.omega)}
      </td>
      <td style={{ padding: '0.5rem 0.6rem', fontFamily: 'Courier New, monospace', textAlign: 'right' }}>
        {formatParam(p.alpha)}
      </td>
      <td style={{ padding: '0.5rem 0.6rem', fontFamily: 'Courier New, monospace', textAlign: 'right' }}>
        {p.gamma == null ? '—' : formatParam(p.gamma)}
      </td>
      <td style={{ padding: '0.5rem 0.6rem', fontFamily: 'Courier New, monospace', textAlign: 'right' }}>
        {formatParam(p.beta)}
      </td>
      <td style={{ padding: '0.5rem 0.6rem', fontFamily: 'Courier New, monospace', textAlign: 'right' }}>
        {persistence.toFixed(3)}
      </td>
      <td style={{ padding: '0.5rem 0.6rem', fontFamily: 'Courier New, monospace', textAlign: 'right' }}>
        {model.logLik.toFixed(1)}
      </td>
      <td style={{ padding: '0.5rem 0.6rem', fontFamily: 'Courier New, monospace', textAlign: 'right' }}>
        {model.bic.toFixed(1)}
      </td>
      <td style={{ padding: '0.5rem 0.6rem', fontFamily: 'Courier New, monospace', textAlign: 'right', color }}>
        {(weight * 100).toFixed(1)}%
      </td>
    </tr>
  );
}

export default function SlotA() {
  const chartRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();
  const mobile = useIsMobile();
  const { data, loading, error } = useGexHistory({});
  const [fitState, setFitState] = useState({ ensemble: null, forecast: null, error: null });

  const returnsWithDate = useMemo(() => {
    if (!data?.series) return null;
    return buildLogReturns(data.series);
  }, [data]);

  // Fit inside an effect so the slow work doesn't block the render that
  // paints the loading placeholder. For ~2000 daily returns × three
  // models × ~300 Nelder-Mead iterations the browser wall-clock runs
  // low hundreds of milliseconds, which is comfortable for a deferred
  // effect but disruptive if run synchronously on the render path.
  useEffect(() => {
    if (!returnsWithDate || returnsWithDate.length < 200) return;
    let cancelled = false;
    // Yield to the browser so the "fitting…" placeholder gets a paint
    // before the optimizer takes over the main thread.
    const handle = setTimeout(() => {
      try {
        const returns = returnsWithDate.map((r) => r.r);
        const ensemble = fitEnsemble(returns);
        const forecast = forecastEnsemble(ensemble, FORECAST_HORIZON);
        if (!cancelled) setFitState({ ensemble, forecast, error: null });
      } catch (err) {
        if (!cancelled) setFitState({ ensemble: null, forecast: null, error: err.message });
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

  useEffect(() => {
    if (!Plotly || !chartRef.current || !fitState.ensemble || !returnsWithDate) return;

    const { ensemble, forecast } = fitState;
    const { models, weights, ensembleCondVar } = ensemble;

    // Trim the chart to the last CHART_LOOKBACK_DAYS for legibility; the
    // full 2017-onwards path is fit but isn't useful to eye-ball.
    const n = returnsWithDate.length;
    const start = Math.max(0, n - CHART_LOOKBACK_DAYS);
    const dates = returnsWithDate.slice(start).map((r) => r.date);
    const hvSeries = returnsWithDate.slice(start).map((r) =>
      r.hv10 != null ? r.hv10 * 100 : null,
    );

    const toAnnPct = (arr) => arr.slice(start).map((v) => annualize(v) * 100);

    const traces = [
      {
        x: dates,
        y: hvSeries,
        mode: 'lines',
        type: 'scatter',
        name: 'Realized HV₁₀',
        line: { color: PLOTLY_COLORS.axisText, width: 1, dash: 'dot' },
        connectgaps: false,
        hovertemplate: '<b>%{x}</b><br>realized HV₁₀: %{y:.2f}%<extra></extra>',
      },
      {
        x: dates,
        y: toAnnPct(models[0].condVar),
        mode: 'lines',
        type: 'scatter',
        name: 'GARCH(1,1)',
        line: { color: PLOTLY_COLORS.primary, width: 1 },
        opacity: 0.75,
        hovertemplate: '<b>%{x}</b><br>GARCH: %{y:.2f}%<extra></extra>',
      },
      {
        x: dates,
        y: toAnnPct(models[1].condVar),
        mode: 'lines',
        type: 'scatter',
        name: 'GJR-GARCH',
        line: { color: PLOTLY_COLORS.positive, width: 1 },
        opacity: 0.75,
        hovertemplate: '<b>%{x}</b><br>GJR: %{y:.2f}%<extra></extra>',
      },
      {
        x: dates,
        y: toAnnPct(models[2].condVar),
        mode: 'lines',
        type: 'scatter',
        name: 'EGARCH(1,1)',
        line: { color: PLOTLY_COLORS.secondary, width: 1 },
        opacity: 0.75,
        hovertemplate: '<b>%{x}</b><br>EGARCH: %{y:.2f}%<extra></extra>',
      },
      {
        x: dates,
        y: toAnnPct(ensembleCondVar),
        mode: 'lines',
        type: 'scatter',
        name: 'Ensemble',
        line: { color: PLOTLY_COLORS.highlight, width: 2 },
        hovertemplate: '<b>%{x}</b><br>ensemble: %{y:.2f}%<extra></extra>',
      },
    ];

    // Forecast tail — append the h-day forecast as a continuation of the
    // ensemble line with a dashed style so the fit vs. forecast boundary
    // is visually obvious.
    const lastDate = new Date(dates[dates.length - 1] + 'T00:00:00Z');
    const forecastDates = [];
    const cursor = new Date(lastDate);
    for (let i = 0; i < forecast.ensemble.path.length; i++) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      // Skip weekends so the forecast lands on plausible trading dates
      while (cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6) {
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
      forecastDates.push(cursor.toISOString().slice(0, 10));
    }
    traces.push({
      x: [dates[dates.length - 1], ...forecastDates],
      y: [
        annualize(ensembleCondVar[ensembleCondVar.length - 1]) * 100,
        ...forecast.ensemble.path.map((v) => annualize(v) * 100),
      ],
      mode: 'lines',
      type: 'scatter',
      name: 'Forecast',
      line: { color: PLOTLY_COLORS.highlight, width: 2, dash: 'dash' },
      hovertemplate: '<b>%{x}</b><br>forecast σ: %{y:.2f}%<extra></extra>',
    });

    const layout = plotly2DChartLayout({
      title: {
        ...plotlyTitle(
          mobile
            ? 'GARCH Ensemble<br>Conditional σ (Annualized)'
            : 'GARCH Ensemble · Conditional σ (Annualized)'
        ),
        y: 0.97,
        yref: 'container',
        yanchor: 'top',
      },
      margin: mobile ? { t: 75, r: 20, b: 80, l: 60 } : { t: 70, r: 30, b: 90, l: 75 },
      xaxis: plotlyAxis('', { type: 'date' }),
      yaxis: plotlyAxis('σ (%)', {
        ticksuffix: '%',
        tickformat: '.1f',
      }),
      showlegend: true,
      legend: {
        orientation: 'h',
        y: -0.22,
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
  }, [Plotly, fitState, returnsWithDate, mobile]);

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
          Need at least 200 daily returns to fit a meaningful GARCH(1,1);
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

  if (!fitState.ensemble) {
    return (
      <div className="lab-placeholder">
        <div className="lab-placeholder-title">Fitting ensemble…</div>
        <div className="lab-placeholder-hint">
          GARCH(1,1), GJR-GARCH, and EGARCH(1,1) by Gaussian MLE on{' '}
          {returnsWithDate.length.toLocaleString()} daily returns. Nelder-Mead
          in-browser, no worker (a few hundred milliseconds on a modern laptop).
        </div>
      </div>
    );
  }

  const { ensemble, forecast } = fitState;
  const { models, weights } = ensemble;
  const modelColors = [PLOTLY_COLORS.primary, PLOTLY_COLORS.positive, PLOTLY_COLORS.secondary];

  return (
    <div className="card" style={{ padding: '1.25rem 1.25rem 1rem' }}>
      <div style={{ marginBottom: '0.85rem' }}>
        <div
          style={{
            fontFamily: 'Courier New, monospace',
            fontSize: '0.7rem',
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--text-secondary)',
            marginBottom: '0.35rem',
          }}
        >
          model · GARCH ensemble
        </div>
        <div
          style={{
            fontSize: '0.88rem',
            color: 'var(--text-secondary)',
            lineHeight: 1.55,
            maxWidth: '760px',
          }}
        >
          Three GARCH-family specifications fit by Gaussian MLE on the daily
          SPX log-return series: vanilla GARCH(1,1), GJR-GARCH(1,1,1) with a
          leverage term, and EGARCH(1,1) on log-variance. The ensemble blends
          them by BIC weight{' '}
          <code style={{ fontFamily: 'Courier New, monospace', color: 'var(--text-primary)' }}>
            w<sub>i</sub> ∝ exp(−½·ΔBIC<sub>i</sub>)
          </code>
          , penalizing the two asymmetric models' extra parameter against
          their fit. The forecast is the BIC-weighted blend of each model's
          h-step variance path from the current state.
        </div>
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
          value={formatPct(forecast.sigma1d, 2)}
          sub="ensemble · annualized"
          accent={PLOTLY_COLORS.highlight}
        />
        <StatCell
          label="σ (10-day)"
          value={formatPct(forecast.sigma10d, 2)}
          sub="avg variance → annualized"
          accent={PLOTLY_COLORS.highlight}
        />
        <StatCell
          label="σ (21-day)"
          value={formatPct(forecast.sigma21d, 2)}
          sub="one-month horizon"
          accent={PLOTLY_COLORS.highlight}
        />
        <StatCell
          label="Realized HV₁₀"
          value={formatPct(lastRealizedHv, 2)}
          sub="last close · 10d window"
        />
      </div>

      <div ref={chartRef} style={{ width: '100%', height: mobile ? 340 : 440 }} />

      <div style={{ marginTop: '1.1rem', overflowX: 'auto' }}>
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: '0.8rem',
            minWidth: '680px',
          }}
        >
          <thead>
            <tr style={{ color: 'var(--text-secondary)', textAlign: 'left' }}>
              <th style={{ padding: '0.5rem 0.6rem', fontWeight: 'normal', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                Model
              </th>
              <th style={{ padding: '0.5rem 0.6rem', fontWeight: 'normal', textAlign: 'right', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                ω
              </th>
              <th style={{ padding: '0.5rem 0.6rem', fontWeight: 'normal', textAlign: 'right', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                α
              </th>
              <th style={{ padding: '0.5rem 0.6rem', fontWeight: 'normal', textAlign: 'right', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                γ
              </th>
              <th style={{ padding: '0.5rem 0.6rem', fontWeight: 'normal', textAlign: 'right', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                β
              </th>
              <th style={{ padding: '0.5rem 0.6rem', fontWeight: 'normal', textAlign: 'right', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                Persistence
              </th>
              <th style={{ padding: '0.5rem 0.6rem', fontWeight: 'normal', textAlign: 'right', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                log-L
              </th>
              <th style={{ padding: '0.5rem 0.6rem', fontWeight: 'normal', textAlign: 'right', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                BIC
              </th>
              <th style={{ padding: '0.5rem 0.6rem', fontWeight: 'normal', textAlign: 'right', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                Weight
              </th>
            </tr>
          </thead>
          <tbody>
            {models.map((m, i) => (
              <ParamRow key={m.name} model={m} weight={weights[i]} color={modelColors[i]} />
            ))}
          </tbody>
        </table>
      </div>

      <div
        style={{
          marginTop: '0.85rem',
          fontSize: '0.75rem',
          color: 'var(--text-secondary)',
          lineHeight: 1.6,
        }}
      >
        Fit in-browser on {returnsWithDate.length.toLocaleString()} daily log returns
        ({returnsWithDate[0].date} → {returnsWithDate[returnsWithDate.length - 1].date})
        in {ensemble.elapsedMs.toFixed(0)}ms. Persistence is{' '}
        <code style={{ fontFamily: 'Courier New, monospace', color: 'var(--text-primary)' }}>
          α+β
        </code>{' '}
        for GARCH,{' '}
        <code style={{ fontFamily: 'Courier New, monospace', color: 'var(--text-primary)' }}>
          α+γ/2+β
        </code>{' '}
        for GJR (symmetric-innovation stationary sum), and{' '}
        <code style={{ fontFamily: 'Courier New, monospace', color: 'var(--text-primary)' }}>
          |β|
        </code>{' '}
        for EGARCH. Close to 1 means vol shocks die out slowly. The EGARCH
        multi-step variance forecast is a small Monte-Carlo average over
        log-variance paths; the GARCH and GJR forecasts are closed-form.
      </div>
    </div>
  );
}
