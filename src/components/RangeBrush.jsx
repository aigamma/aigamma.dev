import { useCallback, useMemo, useState } from 'react';
import { PLOTLY_COLORS } from '../lib/plotlyTheme';

// Site-wide range brush — three absolutely-positioned divs inside a
// gray track. Matches the aesthetic of the scatter's original brush
// (gray ends, dark selected middle, white handles) without going
// through Plotly's SVG rangeslider machinery, which has a silent
// failure mode in thin separate strips and which renders with
// inconsistent spacing / heights across chart types (date x-axis vs
// numeric vs category). This component normalizes the brush to 40px
// flush against the chart regardless of axis type. Works on any
// numeric domain — callers pass min/max/activeMin/activeMax as numbers
// (convert dates to ms and categories to indices at the caller).
// Emits onChange only on pointer release so the downstream chart does
// not re-render 60x/s during a drag; the brush's own handles update
// locally via dragState at full pointer-move rate so visual feedback
// is still continuous.
//
// Orientation: 'horizontal' (default) lays the brush as a 40px-tall
// strip below a chart; 'vertical' lays it as a 40px-wide strip on the
// side of a chart and flips the drag axis so pointer-down-and-up
// shrinks the max handle (the axis value increases going up the
// screen, so clientY-positive deltas map to value-negative deltas).
export default function RangeBrush({
  min,
  max,
  activeMin,
  activeMax,
  onChange,
  height = 40,
  width = 40,
  orientation = 'horizontal',
  minWidth = 0,
}) {
  const [dragState, setDragState] = useState(null);
  const isVertical = orientation === 'vertical';

  const totalSpan = max - min;

  const displayMin = dragState?.currentMin ?? activeMin;
  const displayMax = dragState?.currentMax ?? activeMax;

  // "near" = side of the track where `min` visually lives. On horizontal,
  // min sits on the left (nearPct is distance from left). On vertical, min
  // sits on the bottom (nearPct is distance from bottom).
  const nearPct =
    totalSpan > 0 ? Math.max(0, ((displayMin - min) / totalSpan) * 100) : 0;
  const farPct =
    totalSpan > 0 ? Math.max(0, ((max - displayMax) / totalSpan) * 100) : 0;

  const handlePointerDown = useCallback((e) => {
    const handle = e.currentTarget.dataset.handle;
    if (!handle) return;
    const track = e.currentTarget.parentElement;
    e.preventDefault();
    e.stopPropagation();
    e.target.setPointerCapture?.(e.pointerId);
    setDragState({
      handle,
      startClient: isVertical ? e.clientY : e.clientX,
      startMin: activeMin,
      startMax: activeMax,
      rect: track.getBoundingClientRect(),
      currentMin: activeMin,
      currentMax: activeMax,
    });
  }, [isVertical, activeMin, activeMax]);

  const handlePointerMove = useCallback((e) => {
    if (!dragState) return;
    const { handle, startClient, startMin, startMax, rect } = dragState;
    const rectLen = isVertical ? rect.height : rect.width;
    if (rectLen <= 0) return;
    const clientPos = isVertical ? e.clientY : e.clientX;
    // Vertical: moving down (clientY +) decreases values, because the
    // max value lives at the top of the screen and clientY grows
    // downward. Flip the sign so a downward drag shrinks both handles.
    const signedDelta = isVertical
      ? -(clientPos - startClient)
      : clientPos - startClient;
    const delta = (signedDelta / rectLen) * totalSpan;

    let newMin = startMin;
    let newMax = startMax;
    if (handle === 'min') {
      newMin = Math.max(min, Math.min(startMax - minWidth, startMin + delta));
    } else if (handle === 'max') {
      newMax = Math.min(max, Math.max(startMin + minWidth, startMax + delta));
    } else {
      const windowWidth = startMax - startMin;
      newMin = startMin + delta;
      newMax = newMin + windowWidth;
      if (newMin < min) {
        newMin = min;
        newMax = min + windowWidth;
      }
      if (newMax > max) {
        newMax = max;
        newMin = max - windowWidth;
      }
    }
    setDragState({ ...dragState, currentMin: newMin, currentMax: newMax });
  }, [dragState, isVertical, min, max, minWidth, totalSpan]);

  const handlePointerUp = useCallback(() => {
    if (!dragState) return;
    onChange(dragState.currentMin, dragState.currentMax);
    setDragState(null);
  }, [dragState, onChange]);

  // Style objects are memoized so React skips DOM updates on the inner
  // divs when the dependent values have not changed. During a drag of
  // one handle the other handle's style stays referentially stable and
  // its DOM node does not get a fresh style attribute write per pointer
  // event, which removes the per-frame layout cost the audit identified
  // for slower devices.
  const trackStyle = useMemo(() => {
    const base = {
      backgroundColor: 'rgba(138, 143, 156, 0.32)',
      position: 'relative',
      userSelect: 'none',
      touchAction: 'none',
    };
    return isVertical
      ? {
          ...base,
          width: `${width}px`,
          height: '100%',
          borderTop: `1px solid ${PLOTLY_COLORS.grid}`,
          borderBottom: `1px solid ${PLOTLY_COLORS.grid}`,
          borderRight: `1px solid ${PLOTLY_COLORS.grid}`,
        }
      : {
          ...base,
          width: '100%',
          height: `${height}px`,
          borderLeft: `1px solid ${PLOTLY_COLORS.grid}`,
          borderRight: `1px solid ${PLOTLY_COLORS.grid}`,
          borderBottom: `1px solid ${PLOTLY_COLORS.grid}`,
        };
  }, [isVertical, width, height]);

  const windowStyle = useMemo(() => (isVertical
    ? {
        position: 'absolute',
        left: 0,
        right: 0,
        top: `${farPct}%`,
        bottom: `${nearPct}%`,
        backgroundColor: PLOTLY_COLORS.plot,
        cursor: dragState?.handle === 'window' ? 'grabbing' : 'grab',
      }
    : {
        position: 'absolute',
        top: 0,
        bottom: 0,
        left: `${nearPct}%`,
        right: `${farPct}%`,
        backgroundColor: PLOTLY_COLORS.plot,
        cursor: dragState?.handle === 'window' ? 'grabbing' : 'grab',
      }), [isVertical, nearPct, farPct, dragState?.handle]);

  const minHandleStyle = useMemo(() => (isVertical
    ? {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: `calc(${nearPct}% - 3px)`,
        height: '6px',
        backgroundColor: PLOTLY_COLORS.titleText,
        cursor: 'ns-resize',
      }
    : {
        position: 'absolute',
        top: 0,
        bottom: 0,
        left: `calc(${nearPct}% - 3px)`,
        width: '6px',
        backgroundColor: PLOTLY_COLORS.titleText,
        cursor: 'ew-resize',
      }), [isVertical, nearPct]);

  const maxHandleStyle = useMemo(() => (isVertical
    ? {
        position: 'absolute',
        left: 0,
        right: 0,
        top: `calc(${farPct}% - 3px)`,
        height: '6px',
        backgroundColor: PLOTLY_COLORS.titleText,
        cursor: 'ns-resize',
      }
    : {
        position: 'absolute',
        top: 0,
        bottom: 0,
        right: `calc(${farPct}% - 3px)`,
        width: '6px',
        backgroundColor: PLOTLY_COLORS.titleText,
        cursor: 'ew-resize',
      }), [isVertical, farPct]);

  return (
    <div
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      style={trackStyle}
    >
      <div data-handle="window" onPointerDown={handlePointerDown} style={windowStyle} />
      <div data-handle="min" onPointerDown={handlePointerDown} style={minHandleStyle} />
      <div data-handle="max" onPointerDown={handlePointerDown} style={maxHandleStyle} />
    </div>
  );
}
