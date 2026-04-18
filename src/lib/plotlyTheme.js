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
  // Soft sky-blue tint of `primary` (lifted toward titleText with mild
  // desaturation, equivalent to Tailwind blue-300). Used for axis titles
  // and tick text that need to chromatically associate with a primary-blue
  // trace family but stay legible on the dark card. The fully-saturated
  // primary reads too "neon" for static text and a 0.55-alpha version of
  // primary blends down to ~#2f5e95 against the card, which is fine for a
  // thin line stroke but too dark for glyph interiors. ~9.4:1 contrast on
  // var(--bg-card), well above the WCAG AA 4.5:1 floor for normal text.
  primarySoft: '#93c5fd',
  secondary: '#e74c3c',
  highlight: '#f1c40f',
  positive: '#2ecc71',
  negative: '#e74c3c',
};

export const PLOTLY_FONT_FAMILY = 'Courier New, monospace';

export const PLOTLY_FONTS = {
  base: { family: PLOTLY_FONT_FAMILY, color: PLOTLY_COLORS.titleText, size: 12 },
  // `axisTitle` is the legacy small/muted font kept for annotations and
  // colorbar titles where the bold chart-scale font would be overbearing.
  // `axisTitleBold` is the site-wide axis-title font — every 2D chart
  // renders its y-axis title at 20px bright-white bold so the axis is
  // legible at the reduced resolution that screenshots get shared at on
  // Discord, Twitter, and similar. `plotlyAxis` applies it automatically
  // to any non-empty title.
  axisTitle: { family: PLOTLY_FONT_FAMILY, color: PLOTLY_COLORS.axisText, size: 12 },
  axisTitleBold: { family: PLOTLY_FONT_FAMILY, color: PLOTLY_COLORS.titleText, size: 20 },
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
  // Non-empty titles get the site-wide chart-scale treatment so every
  // y-axis label on the dashboard reads at the same size as the VRP card's
  // "SPX" title. The text is rendered unbolded at 20px because the thin
  // monospace stroke is easier to read at that scale than the bold variant.
  const title = titleText
    ? { text: titleText, font: PLOTLY_FONTS.axisTitleBold, standoff: 10 }
    : { text: '', font: PLOTLY_FONTS.axisTitle };
  return {
    title,
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
  hoverlabel: {
    bgcolor: PLOTLY_COLORS.plot,
    bordercolor: PLOTLY_COLORS.grid,
    font: { family: PLOTLY_FONT_FAMILY, color: PLOTLY_COLORS.titleText, size: 13 },
  },
  // Click-and-drag rubber-band zoom and pan are disabled on every 2D
  // card so the only way to re-frame a chart is through its RangeBrush
  // widget — a brush-only paradigm that keeps tick positions and axis
  // scales stable across the dashboard and makes chart screenshots
  // reproducible. The 3D VolSurface card is the one exception: it
  // enables Plotly's native 3D navigation (turntable/orbit/pan/zoom)
  // alongside its three RangeBrush widgets, because a 3D surface can't
  // be inspected without camera rotation. Hover still works here —
  // hovermode is independent of dragmode.
  dragmode: false,
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
// strike IV matrix (level mode) and any other 2D heatmap.
export const PLOTLY_HEATMAP_COLORSCALE = [
  [0, PLOTLY_COLORS.primary],
  [0.5, PLOTLY_COLORS.highlight],
  [1, PLOTLY_COLORS.secondary],
];

// Symmetric change colorscale — blue for IV contraction, dark neutral at zero
// change, coral for IV expansion. Used by the fixed-strike IV matrix in
// day-over-day change mode. The midpoint matches the zeroLine color so
// unchanged cells recede visually and large moves pop.
export const PLOTLY_HEATMAP_DIVERGING_COLORSCALE = [
  [0, PLOTLY_COLORS.primary],
  [0.5, PLOTLY_COLORS.zeroLine],
  [1, PLOTLY_COLORS.secondary],
];

// Brush-zoom rangeslider config. The visual "naked slider" look — hidden
// mini-trace plus lighter unselected regions for contrast against the dark
// selected window — is enforced by CSS overrides on the Plotly rangeslider
// SVG classes in src/styles/theme.css, not here. This factory only sets the
// structural props (thickness, border) that CSS cannot reach.
export function plotlyRangeslider(extras = {}) {
  return {
    visible: true,
    bordercolor: PLOTLY_COLORS.grid,
    borderwidth: 1,
    thickness: 0.08,
    ...extras,
  };
}

// Composes PLOTLY_BASE_LAYOUT_2D with the transparent-card background every
// 2D chart overrides anyway (charts sit inside dark cards, so the plot area
// reads through to var(--bg-card) instead of PLOTLY_COLORS.plot). Extras are
// applied last so callers can set margin, title, axes, shapes, etc.
export function plotly2DChartLayout(extras = {}) {
  return {
    ...PLOTLY_BASE_LAYOUT_2D,
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    ...extras,
  };
}
