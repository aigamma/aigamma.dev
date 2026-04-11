import { useEffect, useMemo, useRef, useState } from 'react';
import usePlotly from '../hooks/usePlotly';
import { sviTotalVariance } from '../lib/svi';

// Log-moneyness grid bounds. ±12% spans the skew-visible region for SPY-like
// slices; anything wider runs past the short-tenor calibration window and into
// unreliable SVI extrapolation territory. Step size is the spec: 0.01 moneyness.
const MONEYNESS_MIN = -0.12;
const MONEYNESS_MAX = 0.12;
const MONEYNESS_STEP = 0.01;

// Hard IV clamp on grid cells — protects against short-tenor SVI extrapolation
// producing nonsense wings. Cells outside this band are rendered as gaps.
const IV_CLAMP_MIN = 0.03;
const IV_CLAMP_MAX = 1.2;

const BASE_LAYOUT_3D = {
  paper_bgcolor: 'transparent',
  font: { family: 'Courier New, monospace', color: '#e0e0e0', size: 11 },
  margin: { t: 30, r: 10, b: 10, l: 10 },
  scene: {
    bgcolor: '#141820',
    xaxis: {
      title: { text: 'log-moneyness ln(K/S)', font: { color: '#8a8f9c', size: 10 } },
      gridcolor: '#1e2230',
      zerolinecolor: '#4a9eff',
      zerolinewidth: 2,
      tickfont: { color: '#8a8f9c', size: 9 },
      backgroundcolor: '#141820',
      showbackground: true,
    },
    yaxis: {
      title: { text: 'days to expiration', font: { color: '#8a8f9c', size: 10 } },
      gridcolor: '#1e2230',
      zerolinecolor: '#2a3040',
      tickfont: { color: '#8a8f9c', size: 9 },
      backgroundcolor: '#141820',
      showbackground: true,
    },
    zaxis: {
      title: { text: 'ln(IV²)', font: { color: '#8a8f9c', size: 10 } },
      gridcolor: '#1e2230',
      zerolinecolor: '#2a3040',
      tickfont: { color: '#8a8f9c', size: 9 },
      backgroundcolor: '#141820',
      showbackground: true,
    },
    camera: { eye: { x: 1.6, y: -1.8, z: 0.85 } },
    aspectratio: { x: 1.35, y: 1.0, z: 0.75 },
  },
};

function buildMoneynessGrid() {
  const grid = [];
  const steps = Math.round((MONEYNESS_MAX - MONEYNESS_MIN) / MONEYNESS_STEP);
  for (let i = 0; i <= steps; i++) {
    grid.push(Number((MONEYNESS_MIN + i * MONEYNESS_STEP).toFixed(4)));
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

  const kGrid = buildMoneynessGrid();
  const dteGrid = [];
  for (let d = minDte; d <= maxDte; d++) dteGrid.push(d);

  const z = [];
  const customdata = [];
  for (const dte of dteGrid) {
    const zRow = [];
    const cdRow = [];
    const Tyear = dte / 365;
    for (const k of kGrid) {
      const w = interpolateTotalVariance(k, dte, sortedFits);
      if (w == null || !(w > 0) || !(Tyear > 0)) {
        zRow.push(null);
        cdRow.push([null, null]);
        continue;
      }
      const ivSq = w / Tyear;
      const iv = Math.sqrt(ivSq);
      if (iv < IV_CLAMP_MIN || iv > IV_CLAMP_MAX) {
        zRow.push(null);
        cdRow.push([null, null]);
        continue;
      }
      const K = spotPrice * Math.exp(k);
      zRow.push(Math.log(ivSq));
      cdRow.push([K, iv * 100]);
    }
    z.push(zRow);
    customdata.push(cdRow);
  }

  return { kGrid, dteGrid, z, customdata };
}

function buildRawScatter(contracts, spotPrice, capturedAtMs) {
  if (!contracts || contracts.length === 0) return null;
  const x = [];
  const y = [];
  const z = [];
  const customdata = [];
  for (const c of contracts) {
    const iv = c.implied_volatility;
    if (!iv || iv <= 0.01 || iv > 2.5) continue;
    if (!c.strike_price || !c.expiration_date) continue;
    const otm =
      (c.contract_type === 'call' && c.strike_price >= spotPrice) ||
      (c.contract_type === 'put' && c.strike_price <= spotPrice);
    if (!otm) continue;
    const k = Math.log(c.strike_price / spotPrice);
    if (k < MONEYNESS_MIN - 0.02 || k > MONEYNESS_MAX + 0.02) continue;
    const expMs = new Date(`${c.expiration_date}T20:00:00Z`).getTime();
    const dte = Math.max((expMs - capturedAtMs) / 86400000, 0);
    x.push(k);
    y.push(dte);
    z.push(Math.log(iv * iv));
    customdata.push([c.strike_price, c.expiration_date, iv * 100]);
  }
  if (x.length === 0) return null;
  return { x, y, z, customdata };
}

function atmRidge(sortedFits) {
  const out = { x: [], y: [], z: [] };
  for (const fit of sortedFits) {
    const w = sviTotalVariance(fit.params, 0);
    if (!(w > 0) || !(fit.T > 0)) continue;
    const ivSq = w / fit.T;
    out.x.push(0);
    out.y.push(fit.dte);
    out.z.push(Math.log(ivSq));
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

function computeZRange(surface, scatter) {
  let zMin = Infinity;
  let zMax = -Infinity;
  if (surface) {
    for (const row of surface.z) {
      for (const v of row) {
        if (v != null && Number.isFinite(v)) {
          if (v < zMin) zMin = v;
          if (v > zMax) zMax = v;
        }
      }
    }
  }
  if (scatter) {
    for (const v of scatter.z) {
      if (v != null && Number.isFinite(v)) {
        if (v < zMin) zMin = v;
        if (v > zMax) zMax = v;
      }
    }
  }
  if (!Number.isFinite(zMin) || !Number.isFinite(zMax)) return null;
  return { zMin, zMax };
}

export default function VolSurface3D({ contracts, spotPrice, capturedAt, fits, sviSource }) {
  const chartRef = useRef(null);
  const Plotly = usePlotly();
  const [mode, setMode] = useState('svi');

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
    const zRange = computeZRange(
      effectiveMode === 'svi' ? sviSurface : null,
      effectiveMode === 'raw' ? rawScatter : null
    );

    const zMidAtm = atmIv != null ? Math.log(atmIv * atmIv) : null;
    let cMid;
    let halfRange;
    if (zRange) {
      if (zMidAtm != null) {
        cMid = zMidAtm;
        halfRange = Math.max(
          Math.abs(zRange.zMax - zMidAtm),
          Math.abs(zRange.zMin - zMidAtm),
          0.1
        );
      } else {
        cMid = (zRange.zMax + zRange.zMin) / 2;
        halfRange = Math.max((zRange.zMax - zRange.zMin) / 2, 0.1);
      }
    } else {
      cMid = 0;
      halfRange = 1;
    }
    const cMin = cMid - halfRange;
    const cMax = cMid + halfRange;

    if (effectiveMode === 'svi' && sviSurface) {
      const { kGrid, dteGrid, z, customdata } = sviSurface;
      traces.push({
        type: 'surface',
        x: kGrid,
        y: dteGrid,
        z,
        customdata,
        colorscale: 'RdBu',
        reversescale: true,
        cmin: cMin,
        cmid: cMid,
        cmax: cMax,
        showscale: true,
        opacity: 0.92,
        contours: {
          z: {
            show: true,
            usecolormap: true,
            highlightcolor: '#ffffff',
            project: { z: false },
            width: 1,
          },
        },
        colorbar: {
          title: { text: 'ln(IV²)', font: { color: '#8a8f9c', size: 10 } },
          tickfont: { color: '#8a8f9c', size: 9 },
          len: 0.65,
          thickness: 10,
          x: 1.02,
          outlinecolor: '#2a3040',
        },
        hovertemplate:
          'moneyness %{x:.3f}<br>' +
          'DTE %{y:.0f}d<br>' +
          'strike %{customdata[0]:.2f}<br>' +
          'IV %{customdata[1]:.2f}%<br>' +
          'ln(IV²) %{z:.3f}' +
          '<extra></extra>',
        name: 'SVI surface',
      });

      const ridge = atmRidge(sortedFits);
      if (ridge.x.length >= 1) {
        traces.push({
          type: 'scatter3d',
          mode: 'lines+markers',
          x: ridge.x,
          y: ridge.y,
          z: ridge.z,
          line: { color: '#f0a030', width: 5 },
          marker: { color: '#f0a030', size: 5, symbol: 'diamond' },
          name: 'ATM ridge',
          hovertemplate: 'ATM · DTE %{y:.0f}d<br>ln(IV²) %{z:.3f}<extra></extra>',
          showlegend: false,
        });
      }
    } else if (rawScatter) {
      const { x, y, z, customdata } = rawScatter;
      traces.push({
        type: 'scatter3d',
        mode: 'markers',
        x,
        y,
        z,
        customdata,
        marker: {
          size: 3.2,
          color: z,
          colorscale: 'RdBu',
          reversescale: true,
          cmid: cMid,
          cmin: cMin,
          cmax: cMax,
          showscale: true,
          opacity: 0.85,
          colorbar: {
            title: { text: 'ln(IV²)', font: { color: '#8a8f9c', size: 10 } },
            tickfont: { color: '#8a8f9c', size: 9 },
            len: 0.65,
            thickness: 10,
            x: 1.02,
            outlinecolor: '#2a3040',
          },
        },
        hovertemplate:
          'moneyness %{x:.3f}<br>' +
          'DTE %{y:.0f}d<br>' +
          'strike %{customdata[0]:.2f}<br>' +
          'exp %{customdata[1]}<br>' +
          'IV %{customdata[2]:.2f}%<br>' +
          'ln(IV²) %{z:.3f}' +
          '<extra></extra>',
        name: 'raw IV scatter',
      });
    }

    const layout = {
      ...BASE_LAYOUT_3D,
      title: {
        text:
          effectiveMode === 'svi' && hasSviFits
            ? 'SPY Volatility Surface — SVI interpolation'
            : 'SPY Volatility Surface — raw IV scatter',
        font: { color: '#e0e0e0', size: 13, family: 'Courier New, monospace' },
      },
    };

    Plotly.newPlot(chartRef.current, traces, layout, {
      responsive: true,
      displayModeBar: false,
    });
  }, [Plotly, effectiveMode, sviSurface, rawScatter, spotPrice, atmIv, sortedFits, hasSviFits]);

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
            fontSize: '0.7rem',
            color: 'var(--text-secondary)',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
          }}
        >
          {effectiveMode === 'svi' && hasSviFits
            ? `SVI interpolation · ${sortedFits.length} expiration${sortedFits.length === 1 ? '' : 's'}${sviSource ? ` · ${sviSource}` : ''} · ${MONEYNESS_STEP.toFixed(2)} k × 1 DTE grid`
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
              fontSize: '0.72rem',
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
              fontSize: '0.72rem',
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
      <div ref={chartRef} style={{ width: '100%', height: '540px' }} />
    </div>
  );
}
