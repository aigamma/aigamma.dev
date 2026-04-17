import { useEffect, useMemo, useRef, useState } from 'react';
import usePlotly from '../hooks/usePlotly';
import useIsMobile from '../hooks/useIsMobile';
import { sviTotalVariance } from '../lib/svi';
import {
  PLOTLY_BASE_LAYOUT_3D,
  PLOTLY_COLORBAR,
  PLOTLY_COLORS,
  PLOTLY_FONT_FAMILY,
  PLOTLY_FONTS,
  plotly3DAxis,
  plotlyTitle,
} from '../lib/plotlyTheme';

// Strike grid is spot-relative ±12% so the surface lines up across expirations
// regardless of the absolute strike ladder at any given tenor. 12% is wider than
// the SVI calibration window (5 ATM sigmas * sqrt(T)) on the shortest tenor so
// the grid extends into SVI-clamped territory at the edges where we render gaps.
const STRIKE_WINDOW_PCT = 0.12;

// Hard IV clamp on grid cells — protects against short-tenor SVI extrapolation
// producing nonsense wings. Cells outside this band become null gaps.
const IV_CLAMP_MIN = 0.03;
const IV_CLAMP_MAX = 1.2;

// Log z-axis tick stops expressed as raw IV% values. Plotly's log-type axis
// takes raw values and computes log10 positions internally, so passing a human
// ladder here gives us perceptually-even tick spacing with trader-friendly labels.
const LOG_IV_TICKVALS = [5, 8, 12, 16, 20, 25, 30, 40, 55, 75, 100];

// 3D axis typography is intentionally heavier than the site-wide 2D tick/title
// stack. Plotly's default 3D axis labels render small and muted, which reads
// especially poorly on the dark theme — so we bump tick size to 14 and title
// size to 18, and push both toward near-white for contrast. Family matches
// the dashboard's Courier New monospace stack.
const AXIS_TICK_FONT_3D = {
  family: PLOTLY_FONT_FAMILY,
  color: 'rgba(255,255,255,0.85)',
  size: 14,
};
const AXIS_TITLE_FONT_3D = {
  family: PLOTLY_FONT_FAMILY,
  color: 'rgba(255,255,255,0.95)',
  size: 18,
};

function axis3D(titleText, extras = {}) {
  return plotly3DAxis(titleText, {
    tickfont: AXIS_TICK_FONT_3D,
    title: { text: titleText, font: AXIS_TITLE_FONT_3D },
    ...extras,
  });
}

const BASE_LAYOUT_3D = {
  ...PLOTLY_BASE_LAYOUT_3D,
  scene: {
    bgcolor: PLOTLY_COLORS.plot,
    xaxis: axis3D('strike', { dtick: 500 }),
    yaxis: axis3D('DTE'),
    zaxis: axis3D('IV%', {
      type: 'log',
      zerolinecolor: PLOTLY_COLORS.primary,
      zerolinewidth: 1.5,
      tickmode: 'array',
      tickvals: LOG_IV_TICKVALS,
      ticktext: LOG_IV_TICKVALS.map((v) => `${v}%`),
    }),
    camera: {
      eye: { x: 1.8, y: 1.8, z: 0.7 },
      center: { x: 0, y: 0, z: -0.15 },
      up: { x: 0, y: 0, z: 1 },
    },
    aspectmode: 'manual',
    aspectratio: { x: 1.5, y: 1.5, z: 1.0 },
    domain: { x: [0, 1], y: [0, 1] },
  },
};

// Build a spot-relative strike grid. Step is chosen so the grid has ~120 points
// across the ±12% window regardless of underlying price — this avoids over- or
// under-resolving the surface for cheap vs expensive underlyings.
function buildStrikeGrid(spotPrice) {
  const lo = spotPrice * (1 - STRIKE_WINDOW_PCT);
  const hi = spotPrice * (1 + STRIKE_WINDOW_PCT);
  const targetCount = 121;
  const rawStep = (hi - lo) / (targetCount - 1);
  const step = Math.max(rawStep, spotPrice * 1e-4);
  const grid = [];
  for (let i = 0; i < targetCount; i++) {
    grid.push(Number((lo + i * step).toFixed(2)));
  }
  return grid;
}

function sortFitsByDte(fitsByExp, capturedAtMs) {
  if (!fitsByExp) return [];
  return Object.values(fitsByExp)
    .filter((f) => f?.params && Number.isFinite(f?.T))
    .map((f) => {
      const expMs = new Date(`${f.expirationDate}T20:00:00Z`).getTime();
      const dte = Math.max((expMs - capturedAtMs) / 86400000, 0);
      return { ...f, dte };
    })
    .sort((a, b) => a.dte - b.dte);
}

// Linear interpolation of SVI total variance w(k, T) between bracketing slices.
// Linear on w is the textbook Gatheral approach and roughly preserves calendar
// no-arbitrage so long as the source slices are calendar-consistent. Outside
// the slice range we clamp to the nearest fit rather than extrapolating — SVI
// is not trustworthy beyond its calibration tenor.
function interpolateTotalVariance(k, dte, sortedFits) {
  if (sortedFits.length === 0) return null;
  if (sortedFits.length === 1) return sviTotalVariance(sortedFits[0].params, k);
  if (dte <= sortedFits[0].dte) return sviTotalVariance(sortedFits[0].params, k);
  const last = sortedFits[sortedFits.length - 1];
  if (dte >= last.dte) return sviTotalVariance(last.params, k);
  for (let i = 0; i < sortedFits.length - 1; i++) {
    const near = sortedFits[i];
    const far = sortedFits[i + 1];
    if (dte >= near.dte && dte <= far.dte) {
      const w1 = sviTotalVariance(near.params, k);
      const w2 = sviTotalVariance(far.params, k);
      const alpha = (dte - near.dte) / (far.dte - near.dte);
      return w1 + (w2 - w1) * alpha;
    }
  }
  return null;
}

function buildSviSurface(sortedFits, spotPrice) {
  if (!sortedFits || sortedFits.length === 0) return null;
  const minDte = Math.max(Math.floor(sortedFits[0].dte), 1);
  const maxDte = Math.max(Math.ceil(sortedFits[sortedFits.length - 1].dte), minDte + 1);

  const strikeGrid = buildStrikeGrid(spotPrice);
  const dteGrid = [];
  for (let d = minDte; d <= maxDte; d++) dteGrid.push(d);

  const z = [];
  const surfaceColor = [];
  const customdata = [];
  for (const dte of dteGrid) {
    const zRow = [];
    const cRow = [];
    const cdRow = [];
    const Tyear = dte / 365;
    for (const strike of strikeGrid) {
      const k = Math.log(strike / spotPrice);
      const w = interpolateTotalVariance(k, dte, sortedFits);
      if (w == null || !(w > 0) || !(Tyear > 0)) {
        zRow.push(null);
        cRow.push(null);
        cdRow.push([null, null]);
        continue;
      }
      const iv = Math.sqrt(w / Tyear);
      if (iv < IV_CLAMP_MIN || iv > IV_CLAMP_MAX) {
        zRow.push(null);
        cRow.push(null);
        cdRow.push([null, null]);
        continue;
      }
      const ivPct = iv * 100;
      zRow.push(ivPct);
      // Colorscale uses log10(iv) so color distance matches the log z axis
      // visually — a 20%→40% step looks the same perceptual jump as 40%→80%.
      cRow.push(Math.log10(ivPct));
      cdRow.push([k, ivPct]);
    }
    z.push(zRow);
    surfaceColor.push(cRow);
    customdata.push(cdRow);
  }

  return { strikeGrid, dteGrid, z, surfaceColor, customdata };
}

function buildRawScatter(contracts, spotPrice, capturedAtMs) {
  if (!contracts || contracts.length === 0) return null;
  const minStrike = spotPrice * (1 - STRIKE_WINDOW_PCT - 0.02);
  const maxStrike = spotPrice * (1 + STRIKE_WINDOW_PCT + 0.02);
  const x = [];
  const y = [];
  const z = [];
  const color = [];
  const customdata = [];
  for (const c of contracts) {
    const iv = c.implied_volatility;
    if (!iv || iv <= IV_CLAMP_MIN || iv > IV_CLAMP_MAX) continue;
    if (!c.strike_price || !c.expiration_date) continue;
    const otm =
      (c.contract_type === 'call' && c.strike_price >= spotPrice) ||
      (c.contract_type === 'put' && c.strike_price <= spotPrice);
    if (!otm) continue;
    if (c.strike_price < minStrike || c.strike_price > maxStrike) continue;
    const expMs = new Date(`${c.expiration_date}T20:00:00Z`).getTime();
    const dte = Math.max((expMs - capturedAtMs) / 86400000, 0);
    const ivPct = iv * 100;
    x.push(c.strike_price);
    y.push(dte);
    z.push(ivPct);
    color.push(Math.log10(ivPct));
    customdata.push([Math.log(c.strike_price / spotPrice), c.expiration_date, ivPct]);
  }
  if (x.length === 0) return null;
  return { x, y, z, color, customdata };
}

function atmRidge(sortedFits, spotPrice) {
  const out = { x: [], y: [], z: [] };
  for (const fit of sortedFits) {
    const w = sviTotalVariance(fit.params, 0);
    if (!(w > 0) || !(fit.T > 0)) continue;
    const iv = Math.sqrt(w / fit.T);
    if (iv < IV_CLAMP_MIN || iv > IV_CLAMP_MAX) continue;
    out.x.push(spotPrice);
    out.y.push(fit.dte);
    out.z.push(iv * 100);
  }
  return out;
}

function atmIvReference(sortedFits) {
  if (!sortedFits || sortedFits.length === 0) return null;
  const near = sortedFits[0];
  const w0 = sviTotalVariance(near.params, 0);
  if (!(w0 > 0) || !(near.T > 0)) return null;
  return Math.sqrt(w0 / near.T);
}

// Compute the colorscale range in log10(iv%) space so the diverging palette is
// anchored at the nearest-tenor ATM vol and the half-range equals the largest
// perceptual distance from that center across all visible cells.
function computeColorRange(surface, scatter, atmIv) {
  let cMin = Infinity;
  let cMax = -Infinity;
  if (surface) {
    for (const row of surface.surfaceColor) {
      for (const v of row) {
        if (v != null && Number.isFinite(v)) {
          if (v < cMin) cMin = v;
          if (v > cMax) cMax = v;
        }
      }
    }
  }
  if (scatter) {
    for (const v of scatter.color) {
      if (v != null && Number.isFinite(v)) {
        if (v < cMin) cMin = v;
        if (v > cMax) cMax = v;
      }
    }
  }
  if (!Number.isFinite(cMin) || !Number.isFinite(cMax)) {
    return { cMid: 1.3, cMin: 1, cMax: 1.6 }; // ~20% default
  }
  const cMid = atmIv != null ? Math.log10(atmIv * 100) : (cMin + cMax) / 2;
  const halfRange = Math.max(Math.abs(cMax - cMid), Math.abs(cMin - cMid), 0.05);
  return { cMid, cMin: cMid - halfRange, cMax: cMid + halfRange };
}

export default function VolSurface3D({ contracts, spotPrice, capturedAt, fits, sviSource, underlying }) {
  const chartRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();
  const [mode, setMode] = useState('raw');
  const mobile = useIsMobile();

  const capturedAtMs = useMemo(
    () => (capturedAt ? new Date(capturedAt).getTime() : null),
    [capturedAt]
  );

  const sortedFits = useMemo(
    () => (capturedAtMs != null ? sortFitsByDte(fits, capturedAtMs) : []),
    [fits, capturedAtMs]
  );
  const hasSviFits = sortedFits.length > 0;
  const effectiveMode = hasSviFits ? mode : 'raw';

  const sviSurface = useMemo(() => {
    if (!hasSviFits || effectiveMode !== 'svi' || !spotPrice) return null;
    return buildSviSurface(sortedFits, spotPrice);
  }, [hasSviFits, effectiveMode, sortedFits, spotPrice]);

  const rawScatter = useMemo(
    () => (capturedAtMs != null ? buildRawScatter(contracts, spotPrice, capturedAtMs) : null),
    [contracts, spotPrice, capturedAtMs]
  );

  const atmIv = useMemo(() => atmIvReference(sortedFits), [sortedFits]);

  useEffect(() => {
    if (!Plotly || !chartRef.current || !spotPrice) return;

    const traces = [];
    const { cMid, cMin, cMax } = computeColorRange(
      effectiveMode === 'svi' ? sviSurface : null,
      effectiveMode === 'raw' ? rawScatter : null,
      atmIv
    );

    if (effectiveMode === 'svi' && sviSurface) {
      const { strikeGrid, dteGrid, z, surfaceColor, customdata } = sviSurface;
      traces.push({
        type: 'surface',
        x: strikeGrid,
        y: dteGrid,
        z,
        surfacecolor: surfaceColor,
        customdata,
        colorscale: 'RdBu',
        reversescale: true,
        cmin: cMin,
        cmid: cMid,
        cmax: cMax,
        showscale: !mobile,
        opacity: 0.85,
        contours: {
          z: {
            show: true,
            usecolormap: true,
            highlightcolor: PLOTLY_COLORS.titleText,
            project: { z: false },
            width: 1,
          },
        },
        colorbar: {
          ...PLOTLY_COLORBAR,
          title: { text: 'log₁₀ IV%', font: PLOTLY_FONTS.axisTitle },
          x: 1.02,
        },
        hovertemplate:
          'strike %{x:.2f}<br>' +
          'DTE %{y:.0f}d<br>' +
          'moneyness %{customdata[0]:.3f}<br>' +
          'IV %{customdata[1]:.2f}%' +
          '<extra></extra>',
        name: 'SVI surface',
      });

      const ridge = atmRidge(sortedFits, spotPrice);
      if (ridge.x.length >= 1) {
        traces.push({
          type: 'scatter3d',
          mode: 'lines+markers',
          x: ridge.x,
          y: ridge.y,
          z: ridge.z,
          line: { color: PLOTLY_COLORS.highlight, width: 5 },
          marker: { color: PLOTLY_COLORS.highlight, size: 5, symbol: 'diamond' },
          name: 'ATM ridge',
          hovertemplate:
            'ATM · strike %{x:.2f}<br>DTE %{y:.0f}d<br>IV %{z:.2f}%<extra></extra>',
          showlegend: false,
        });
      }
    } else if (rawScatter) {
      const { x, y, z, color, customdata } = rawScatter;
      traces.push({
        type: 'scatter3d',
        mode: 'markers',
        x,
        y,
        z,
        customdata,
        marker: {
          size: 3.2,
          color,
          colorscale: 'RdBu',
          reversescale: true,
          cmid: cMid,
          cmin: cMin,
          cmax: cMax,
          showscale: !mobile,
          opacity: 0.85,
          colorbar: {
            ...PLOTLY_COLORBAR,
            title: { text: 'log₁₀ IV%', font: PLOTLY_FONTS.axisTitle },
            x: 1.02,
          },
        },
        hovertemplate:
          'strike %{x:.2f}<br>' +
          'DTE %{y:.0f}d<br>' +
          'moneyness %{customdata[0]:.3f}<br>' +
          'exp %{customdata[1]}<br>' +
          'IV %{customdata[2]:.2f}%' +
          '<extra></extra>',
        name: 'raw IV scatter',
      });
    }

    const layout = {
      ...BASE_LAYOUT_3D,
      title: plotlyTitle('Volatility Surface'),
    };

    Plotly.newPlot(chartRef.current, traces, layout, {
      responsive: true,
      displayModeBar: false,
    });
  }, [Plotly, effectiveMode, sviSurface, rawScatter, spotPrice, atmIv, sortedFits, hasSviFits, underlying, mobile]);

  if (plotlyError) {
    return (
      <div
        className="card"
        style={{ padding: '1rem', marginBottom: '1rem', color: 'var(--accent-coral)' }}
      >
        Volatility surface unavailable — Plotly failed to load ({plotlyError}).
      </div>
    );
  }
  if (!contracts || contracts.length === 0 || !spotPrice) {
    return (
      <div className="card text-muted" style={{ padding: '1rem', marginBottom: '1rem' }}>
        Volatility surface unavailable — no contracts loaded.
      </div>
    );
  }

  return (
    <div className="card" style={{ marginBottom: '1rem' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '0.5rem',
          marginBottom: '0.35rem',
        }}
      >
        <div
          style={{
            fontSize: '0.8rem',
            color: 'var(--text-secondary)',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
          }}
        >
          {effectiveMode === 'svi' && hasSviFits
            ? `SVI interpolation · ${sortedFits.length} expiration${sortedFits.length === 1 ? '' : 's'}${sviSource ? ` · ${sviSource}` : ''} · strike × DTE × log IV`
            : hasSviFits
              ? 'Raw IV scatter — toggle to see SVI fit'
              : 'Raw IV scatter — SVI fits unavailable for this run'}
        </div>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.75rem' }}>
          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.35rem',
              cursor: hasSviFits ? 'pointer' : 'not-allowed',
              opacity: hasSviFits ? 1 : 0.5,
              fontSize: '0.8rem',
              color: 'var(--text-secondary)',
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
            }}
          >
            <input
              type="radio"
              name="surface-mode"
              value="svi"
              checked={effectiveMode === 'svi'}
              disabled={!hasSviFits}
              onChange={() => setMode('svi')}
            />
            SVI fit
          </label>
          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.35rem',
              cursor: 'pointer',
              fontSize: '0.8rem',
              color: 'var(--text-secondary)',
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
            }}
          >
            <input
              type="radio"
              name="surface-mode"
              value="raw"
              checked={effectiveMode === 'raw'}
              onChange={() => setMode('raw')}
            />
            Raw scatter
          </label>
        </div>
      </div>
      <div ref={chartRef} style={{ width: '100%', height: '800px' }} />
    </div>
  );
}
