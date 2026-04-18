import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import usePlotly from '../hooks/usePlotly';
import useIsMobile from '../hooks/useIsMobile';
import { sviTotalVariance } from '../lib/svi';
import RangeBrush from './RangeBrush';
import ResetButton from './ResetButton';
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

// Initial camera position. Referenced by BASE_LAYOUT_3D below and by
// the card's Reset handler so that "first mount" and "reset view" land
// at exactly the same angle. Eye at (1.8, 1.8, 0.7) gives a three-
// quarter view with DTE receding into the screen and the ATM ridge
// near the center of the frame.
const DEFAULT_CAMERA = {
  eye: { x: 1.8, y: 1.8, z: 0.7 },
  center: { x: 0, y: 0, z: -0.15 },
  up: { x: 0, y: 0, z: 1 },
};

const BASE_LAYOUT_3D = {
  ...PLOTLY_BASE_LAYOUT_3D,
  scene: {
    bgcolor: PLOTLY_COLORS.plot,
    // Default drag mode is 'turntable' rotation — it preserves the
    // vertical up-axis, which reads more naturally on a surface than
    // free orbit. Users switch between turntable / orbit / pan / zoom
    // via the modebar buttons above the chart, and the mousewheel
    // zooms on all axes. The three RangeBrush widgets (volatility
    // left, strike below, DTE right) still provide precise per-axis
    // range control — brushes crop the data extent, the camera modes
    // re-frame the view through that fixed slice.
    dragmode: 'turntable',
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
    camera: DEFAULT_CAMERA,
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

  // Strike (x) domain is the SVI grid's ±12% window around spot — this
  // matches the surface mesh extent and covers the overwhelming majority
  // of raw-scatter points too. Raw points that land in the ±12-14% buffer
  // are clipped when the x-axis range is enforced, which is acceptable
  // because that outer ring is where the SVI extrapolation is least
  // trustworthy anyway.
  const strikeDomain = useMemo(() => {
    if (!spotPrice) return null;
    return [
      spotPrice * (1 - STRIKE_WINDOW_PCT),
      spotPrice * (1 + STRIKE_WINDOW_PCT),
    ];
  }, [spotPrice]);

  // DTE (y) domain spans the full expiration ladder — for SVI mode it
  // matches the SVI surface's DTE grid, for raw mode it's the observed
  // DTE extent of the filtered scatter points.
  const dteDomain = useMemo(() => {
    if (effectiveMode === 'svi' && sortedFits.length > 0) {
      const minDte = Math.max(Math.floor(sortedFits[0].dte), 0);
      const maxDte = Math.max(
        Math.ceil(sortedFits[sortedFits.length - 1].dte),
        minDte + 1,
      );
      return [minDte, maxDte];
    }
    if (rawScatter && rawScatter.y.length > 0) {
      let minDte = Infinity;
      let maxDte = -Infinity;
      for (const v of rawScatter.y) {
        if (v < minDte) minDte = v;
        if (v > maxDte) maxDte = v;
      }
      if (!Number.isFinite(minDte)) return null;
      const loFloor = Math.max(Math.floor(minDte), 0);
      const hiCeil = Math.max(Math.ceil(maxDte), loFloor + 1);
      return [loFloor, hiCeil];
    }
    return null;
  }, [effectiveMode, sortedFits, rawScatter]);

  // Volatility (z) domain is expressed in log10(IV%) space so the brush
  // moves linearly across the log tick ladder that the z-axis already
  // uses — a handle drag that spans half the brush track covers half
  // the decades, not half the raw IV range. The domain is derived from
  // visible data with a small log-space pad on each side, clamped to
  // the site-wide IV_CLAMP_MIN/MAX band; the fallback covers the ladder
  // when no data is on screen yet.
  const volLogDomain = useMemo(() => {
    let minIv = Infinity;
    let maxIv = -Infinity;
    if (effectiveMode === 'svi' && sviSurface) {
      for (const row of sviSurface.z) {
        for (const v of row) {
          if (v != null && Number.isFinite(v) && v > 0) {
            if (v < minIv) minIv = v;
            if (v > maxIv) maxIv = v;
          }
        }
      }
    } else if (rawScatter) {
      for (const v of rawScatter.z) {
        if (v != null && Number.isFinite(v) && v > 0) {
          if (v < minIv) minIv = v;
          if (v > maxIv) maxIv = v;
        }
      }
    }
    if (!Number.isFinite(minIv) || !Number.isFinite(maxIv) || maxIv <= minIv) {
      return [Math.log10(IV_CLAMP_MIN * 100), Math.log10(IV_CLAMP_MAX * 100)];
    }
    const logMin = Math.log10(Math.max(minIv, IV_CLAMP_MIN * 100));
    const logMax = Math.log10(Math.min(maxIv, IV_CLAMP_MAX * 100));
    const pad = Math.max((logMax - logMin) * 0.05, 0.01);
    return [
      Math.max(logMin - pad, Math.log10(IV_CLAMP_MIN * 100)),
      Math.min(logMax + pad, Math.log10(IV_CLAMP_MAX * 100)),
    ];
  }, [effectiveMode, sviSurface, rawScatter]);

  const [strikeRange, setStrikeRange] = useState(null);
  const [dteRange, setDteRange] = useState(null);
  const [volLogRange, setVolLogRange] = useState(null);
  // Track whether the user has rotated/zoomed/panned the camera away
  // from DEFAULT_CAMERA. Drives the ResetButton's visibility (so a
  // user who has only rotated, without touching any brush, still sees
  // a single one-click way back to the opening frame) and the reset
  // handler clears it alongside the three brush ranges.
  const [cameraTouched, setCameraTouched] = useState(false);

  // When the domain changes (new data, mode switch), reset any prior
  // user-selected range so the brush snaps back to the full domain
  // rather than holding a narrower selection that may now lie partly
  // outside the new data.
  useEffect(() => {
    setStrikeRange(null);
  }, [strikeDomain?.[0], strikeDomain?.[1]]);
  useEffect(() => {
    setDteRange(null);
  }, [dteDomain?.[0], dteDomain?.[1]]);
  useEffect(() => {
    setVolLogRange(null);
  }, [volLogDomain[0], volLogDomain[1]]);

  const activeStrikeRange = strikeRange || strikeDomain;
  const activeDteRange = dteRange || dteDomain;
  const activeVolLogRange = volLogRange || volLogDomain;

  const handleStrikeBrushChange = useCallback((lo, hi) => {
    setStrikeRange([lo, hi]);
  }, []);
  const handleDteBrushChange = useCallback((lo, hi) => {
    setDteRange([lo, hi]);
  }, []);
  const handleVolBrushChange = useCallback((lo, hi) => {
    setVolLogRange([lo, hi]);
  }, []);

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

    const baseScene = BASE_LAYOUT_3D.scene;
    // Read the currently-rendered camera off the graph div so we can
    // pass it back unchanged in the next Plotly.react call. Plotly's
    // react() preserves user interactions only when the new layout's
    // scene.camera equals the stored one; if we always passed the
    // module-level DEFAULT_CAMERA, every brush touch would snap the
    // view back to the opening angle and undo the user's rotation.
    // On first mount gd.layout.scene is undefined, so we fall back
    // to DEFAULT_CAMERA to seed the initial framing.
    const currentCamera =
      chartRef.current?.layout?.scene?.camera || DEFAULT_CAMERA;

    const layout = {
      ...BASE_LAYOUT_3D,
      title: plotlyTitle('Volatility Surface'),
      // Restyle the modebar so the navigation icons sit quietly against
      // the dark card — muted gray at rest, primary-blue when a mode is
      // active, fully transparent background so the buttons float over
      // the chart without a pill behind them.
      modebar: {
        activecolor: PLOTLY_COLORS.primary,
        color: PLOTLY_COLORS.axisText,
        bgcolor: 'rgba(0,0,0,0)',
        orientation: 'h',
      },
      scene: {
        ...baseScene,
        camera: currentCamera,
        xaxis: {
          ...baseScene.xaxis,
          ...(activeStrikeRange
            ? { range: activeStrikeRange, autorange: false }
            : {}),
        },
        yaxis: {
          ...baseScene.yaxis,
          ...(activeDteRange
            ? { range: activeDteRange, autorange: false }
            : {}),
        },
        // The z-axis is log-type, so Plotly interprets `range` as log10
        // values — passing the brush's log10(iv%) handles directly is
        // correct and does not need a further transform.
        zaxis: {
          ...baseScene.zaxis,
          ...(activeVolLogRange
            ? { range: activeVolLogRange, autorange: false }
            : {}),
        },
      },
    };

    // Plotly.react (not newPlot) so the user's current camera angle is
    // preserved across brush updates — newPlot snaps the scene back to
    // the layout's DEFAULT_CAMERA on every re-render, which would undo
    // any rotation as soon as the user touched a brush handle.
    Plotly.react(chartRef.current, traces, layout, {
      responsive: true,
      // Modebar exposes the three 3D navigation modes (orbitRotation,
      // tableRotation, pan3d) plus zoom3d and resetCameraDefault3d.
      // Hidden on mobile where the 12–16px icon row would be too tight
      // to tap reliably; touch users still get turntable rotation via
      // default drag + pinch-zoom via scrollZoom.
      displayModeBar: !mobile,
      displaylogo: false,
      modeBarButtonsToRemove: [
        'toImage',
        'resetCameraLastSave3d',
        'hoverClosest3d',
      ],
      // scrollZoom on enables mousewheel / pinch-zoom across all three
      // axes simultaneously. This is separate from the per-axis zoom
      // that the RangeBrush handles provide: scroll zooms the camera
      // (view magnification), brushes zoom the data (axis extent).
      scrollZoom: true,
    });
  }, [
    Plotly,
    effectiveMode,
    sviSurface,
    rawScatter,
    spotPrice,
    atmIv,
    sortedFits,
    hasSviFits,
    underlying,
    mobile,
    activeStrikeRange,
    activeDteRange,
    activeVolLogRange,
  ]);

  // Keep cameraTouched in sync with "current camera differs from
  // DEFAULT_CAMERA." The plotly_relayout event fires on both user
  // drag/scroll AND on the programmatic Plotly.relayout inside
  // handleReset, and its payload carries the new camera on the
  // 'scene.camera' key — so a single comparison against the default
  // gives us a correct state transition in both cases without the
  // suppression-flag dance that "set true on any camera event" would
  // need. Plotly.react updates that touch only axis ranges carry
  // different payload keys and are correctly ignored by the early
  // return.
  useEffect(() => {
    if (!Plotly || !chartRef.current) return;
    const el = chartRef.current;
    if (typeof el.on !== 'function') return;
    const handler = (payload) => {
      if (!payload || !('scene.camera' in payload)) return;
      const cam = payload['scene.camera'];
      const matchesDefault =
        cam?.eye?.x === DEFAULT_CAMERA.eye.x &&
        cam?.eye?.y === DEFAULT_CAMERA.eye.y &&
        cam?.eye?.z === DEFAULT_CAMERA.eye.z &&
        cam?.center?.x === DEFAULT_CAMERA.center.x &&
        cam?.center?.y === DEFAULT_CAMERA.center.y &&
        cam?.center?.z === DEFAULT_CAMERA.center.z;
      setCameraTouched(!matchesDefault);
    };
    el.on('plotly_relayout', handler);
    return () => {
      el.removeAllListeners?.('plotly_relayout');
    };
  }, [Plotly]);

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

  const dteBrushRenderable =
    dteDomain && activeDteRange && dteDomain[1] > dteDomain[0];
  const strikeBrushRenderable =
    strikeDomain && activeStrikeRange && strikeDomain[1] > strikeDomain[0];
  const volBrushRenderable =
    volLogDomain && activeVolLogRange && volLogDomain[1] > volLogDomain[0];

  const userHasBrushed =
    strikeRange != null ||
    dteRange != null ||
    volLogRange != null ||
    cameraTouched;
  const handleReset = () => {
    setStrikeRange(null);
    setDteRange(null);
    setVolLogRange(null);
    // Snap the 3D camera back to DEFAULT_CAMERA. Plotly.relayout
    // animates the camera transition smoothly. The plotly_relayout
    // listener above catches the resulting event, sees that the new
    // camera matches DEFAULT_CAMERA, and clears cameraTouched — so
    // we don't need to clear it explicitly here.
    if (Plotly && chartRef.current) {
      Plotly.relayout(chartRef.current, {
        'scene.camera': DEFAULT_CAMERA,
      });
    }
  };

  return (
    <div className="card" style={{ marginBottom: '1rem', position: 'relative' }}>
      <ResetButton visible={userHasBrushed} onClick={handleReset} />
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
      <div style={{ display: 'flex', alignItems: 'stretch' }}>
        {volBrushRenderable && (
          <RangeBrush
            orientation="vertical"
            min={volLogDomain[0]}
            max={volLogDomain[1]}
            activeMin={activeVolLogRange[0]}
            activeMax={activeVolLogRange[1]}
            onChange={handleVolBrushChange}
            width={40}
            minWidth={Math.max((volLogDomain[1] - volLogDomain[0]) * 0.02, 0.02)}
          />
        )}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <div ref={chartRef} style={{ flex: 1, height: '800px' }} />
          {strikeBrushRenderable && (
            <RangeBrush
              orientation="horizontal"
              min={strikeDomain[0]}
              max={strikeDomain[1]}
              activeMin={activeStrikeRange[0]}
              activeMax={activeStrikeRange[1]}
              onChange={handleStrikeBrushChange}
              height={40}
              minWidth={spotPrice * 0.01}
            />
          )}
        </div>
        {dteBrushRenderable && (
          <RangeBrush
            orientation="vertical"
            min={dteDomain[0]}
            max={dteDomain[1]}
            activeMin={activeDteRange[0]}
            activeMax={activeDteRange[1]}
            onChange={handleDteBrushChange}
            width={40}
            minWidth={Math.max((dteDomain[1] - dteDomain[0]) * 0.02, 2)}
          />
        )}
      </div>
    </div>
  );
}
