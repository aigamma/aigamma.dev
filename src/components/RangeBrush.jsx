import { useRef, useState } from 'react';
import { PLOTLY_COLORS } from '../lib/plotlyTheme';

// Site-wide range brush — three absolutely-positioned divs inside a
// gray track. Matches the aesthetic of the scatter's original brush
// (gray ends, dark selected middle, white vertical handles) without
// going through Plotly's SVG rangeslider machinery, which has a silent
// failure mode in thin separate strips and which renders with
// inconsistent spacing / heights across chart types (date x-axis vs
// numeric vs category). This component normalizes the brush to 40px
// flush against the chart above regardless of axis type. Works on any
// numeric domain — callers pass min/max/activeMin/activeMax as numbers
// (convert dates to ms and categories to indices at the caller).
// Emits onChange only on pointer release so the downstream chart does
// not re-render 60x/s during a drag; the brush's own handles update
// locally via dragState at full pointer-move rate so visual feedback
// is still continuous.
export default function RangeBrush({
  min,
  max,
  activeMin,
  activeMax,
  onChange,
  height = 40,
  minWidth = 0,
}) {
  const trackRef = useRef(null);
  const [dragState, setDragState] = useState(null);

  const totalSpan = max - min;

  const displayMin = dragState?.currentMin ?? activeMin;
  const displayMax = dragState?.currentMax ?? activeMax;

  const leftPct =
    totalSpan > 0 ? Math.max(0, ((displayMin - min) / totalSpan) * 100) : 0;
  const rightPct =
    totalSpan > 0 ? Math.max(0, ((max - displayMax) / totalSpan) * 100) : 0;

  const handlePointerDown = (handle) => (e) => {
    if (!trackRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    e.target.setPointerCapture?.(e.pointerId);
    setDragState({
      handle,
      startClientX: e.clientX,
      startMin: activeMin,
      startMax: activeMax,
      rect: trackRef.current.getBoundingClientRect(),
      currentMin: activeMin,
      currentMax: activeMax,
    });
  };

  const handlePointerMove = (e) => {
    if (!dragState) return;
    const { handle, startClientX, startMin, startMax, rect } = dragState;
    if (rect.width <= 0) return;
    const delta = ((e.clientX - startClientX) / rect.width) * totalSpan;

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
  };

  const handlePointerUp = () => {
    if (!dragState) return;
    onChange(dragState.currentMin, dragState.currentMax);
    setDragState(null);
  };

  return (
    <div
      ref={trackRef}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      style={{
        width: '100%',
        height: `${height}px`,
        backgroundColor: 'rgba(138, 143, 156, 0.32)',
        position: 'relative',
        userSelect: 'none',
        touchAction: 'none',
        borderLeft: `1px solid ${PLOTLY_COLORS.grid}`,
        borderRight: `1px solid ${PLOTLY_COLORS.grid}`,
        borderBottom: `1px solid ${PLOTLY_COLORS.grid}`,
      }}
    >
      <div
        onPointerDown={handlePointerDown('window')}
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: `${leftPct}%`,
          right: `${rightPct}%`,
          backgroundColor: PLOTLY_COLORS.plot,
          cursor: dragState?.handle === 'window' ? 'grabbing' : 'grab',
        }}
      />
      <div
        onPointerDown={handlePointerDown('min')}
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: `calc(${leftPct}% - 3px)`,
          width: '6px',
          backgroundColor: PLOTLY_COLORS.titleText,
          cursor: 'ew-resize',
        }}
      />
      <div
        onPointerDown={handlePointerDown('max')}
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          right: `calc(${rightPct}% - 3px)`,
          width: '6px',
          backgroundColor: PLOTLY_COLORS.titleText,
          cursor: 'ew-resize',
        }}
      />
    </div>
  );
}
