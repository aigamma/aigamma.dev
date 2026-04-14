// Shared Plotly layout theme — dark mode, Courier New monospace.
// VolSurface3D is the canonical reference; every other chart on the platform
// composes its layout from the constants and helpers below so background,
// typography, and color language stay in sync across the site.

export const PLOTLY_COLORS = {
  paper: 'transparent',
  plot: '#141820',
  grid: '#1e2230',
  zeroLine: '#2a3040',
  titleText: '#e0e0e0',
  axisText: '#8a8f9c',
  primary: '#4a9eff',
  secondary: '#e74c3c',
  highlight: '#f1c40f',
  positive: '#2ecc71',
  negative: '#e74c3c',
};

export const PLOTLY_FONT_FAMILY = 'Courier New, monospace';

export const PLOTLY_FONTS = {
  base: { family: PLOTLY_FONT_FAMILY, color: PLOTLY_COLORS.titleText, size: 12 },
  axisTitle: { family: PLOTLY_FONT_FAMILY, color: PLOTLY_COLORS.axisText, size: 12 },
  axisTick: { family: PLOTLY_FONT_FAMILY, color: PLOTLY_COLORS.axisText, size: 12 },
  chartTitle: { family: PLOTLY_FONT_FAMILY, color: PLOTLY_COLORS.titleText, size: 20 },
  legend: { family: PLOTLY_FONT_FAMILY, color: PLOTLY_COLORS.axisText, size: 12 },
};

// Rotation order for multi-series charts (risk-neutral density, etc).
export const PLOTLY_SERIES_PALETTE = [
  PLOTLY_COLORS.primary,
  PLOTLY_COLORS.highlight,
  PLOTLY_COLORS.positive,
  PLOTLY_COLORS.secondary,
];

// Default opacity for thick data elements (bars, surfaces, heatmap fills).
// Thin lines and markers keep full opacity so they remain crisp.
export const PLOTLY_SERIES_OPACITY = 0.85;

export function plotlyAxis(titleText, extras = {}) {
  return {
    title: { text: titleText, font: PLOTLY_FONTS.axisTitle },
    gridcolor: PLOTLY_COLORS.grid,
    zerolinecolor: PLOTLY_COLORS.zeroLine,
    tickfont: PLOTLY_FONTS.axisTick,
    ...extras,
  };
}

export function plotly3DAxis(titleText, extras = {}) {
  return {
    title: { text: titleText, font: PLOTLY_FONTS.axisTitle },
    gridcolor: PLOTLY_COLORS.grid,
    zerolinecolor: PLOTLY_COLORS.zeroLine,
    tickfont: PLOTLY_FONTS.axisTick,
    backgroundcolor: PLOTLY_COLORS.plot,
    showbackground: true,
    ...extras,
  };
}

export function plotlyTitle(text) {
  return { text, font: PLOTLY_FONTS.chartTitle };
}

export const PLOTLY_BASE_LAYOUT_2D = {
  paper_bgcolor: PLOTLY_COLORS.paper,
  plot_bgcolor: PLOTLY_COLORS.plot,
  font: PLOTLY_FONTS.base,
  margin: { t: 40, r: 30, b: 60, l: 70 },
  legend: {
    orientation: 'h',
    y: -0.18,
    x: 0.5,
    xanchor: 'center',
    font: PLOTLY_FONTS.legend,
  },
  hovermode: 'x unified',
};

export const PLOTLY_BASE_LAYOUT_3D = {
  paper_bgcolor: PLOTLY_COLORS.paper,
  font: PLOTLY_FONTS.base,
  margin: { t: 30, r: 10, b: 10, l: 10 },
};

// Standardized colorbar props for heatmaps / surfaces / scatter3d.
export const PLOTLY_COLORBAR = {
  tickfont: PLOTLY_FONTS.axisTick,
  thickness: 10,
  len: 0.65,
  outlinecolor: PLOTLY_COLORS.zeroLine,
};

// Diverging heatmap colorscale built from the palette — cold primary blue at
// low values, amber at the midpoint, coral at the hot end. Used by the fixed-
// strike IV matrix and any other 2D heatmap.
export const PLOTLY_HEATMAP_COLORSCALE = [
  [0, PLOTLY_COLORS.primary],
  [0.5, PLOTLY_COLORS.highlight],
  [1, PLOTLY_COLORS.secondary],
];

// Brush-zoom rangeslider styled to fit the dark theme. Returns a fresh object
// each call so individual charts can override fields without mutating shared
// state. Thickness is the slider's share of the full plot region (0..1) — 0.08
// keeps the navigator strip compact so the data plot retains most of its
// vertical real estate.
export function plotlyRangeslider(extras = {}) {
  return {
    visible: true,
    bgcolor: 'rgba(20, 24, 32, 0.55)',
    bordercolor: PLOTLY_COLORS.grid,
    borderwidth: 1,
    thickness: 0.08,
    ...extras,
  };
}
