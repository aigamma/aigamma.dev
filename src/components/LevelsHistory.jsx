import { useEffect, useMemo, useRef, useState } from 'react';
import usePlotly from '../hooks/usePlotly';
import {
  PLOTLY_BASE_LAYOUT_2D,
  plotlyAxis,
  plotlyTitle,
} from '../lib/plotlyTheme';

const COLOR_CALL_WALL = '#4a9eff';
const COLOR_PUT_WALL = '#d85a30';
const COLOR_SPOT = '#2ecc71';
const COLOR_VOL_FLIP = '#f0a030';

const PLOTLY_LAYOUT_BASE = {
  ...PLOTLY_BASE_LAYOUT_2D,
  margin: { t: 40, r: 30, b: 60, l: 80 },
  xaxis: plotlyAxis('Captured At', {
    type: 'date',
    tickformat: '%b %d\n%H:%M',
  }),
  yaxis: plotlyAxis('Price', {
    tickformat: ',.2f',
    autorange: true,
  }),
  hovermode: 'x unified',
};

export default function LevelsHistory({ underlying = 'SPX', snapshotType = 'intraday' }) {
  const chartRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();

  const [history, setHistory] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchHistory() {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          underlying,
          snapshot_type: snapshotType,
        });
        const res = await fetch(`/api/levels-history?${params}`);
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`API ${res.status}: ${text}`);
        }
        const json = await res.json();
        if (!cancelled) setHistory(json);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchHistory();
    return () => {
      cancelled = true;
    };
  }, [underlying, snapshotType]);

  const series = useMemo(() => {
    if (!history || !Array.isArray(history.points) || history.points.length === 0) return null;
    const x = history.points.map((p) => p.captured_at);
    return {
      x,
      callWall: history.points.map((p) => p.call_wall_strike),
      putWall: history.points.map((p) => p.put_wall_strike),
      spot: history.points.map((p) => p.spot_price),
      volFlip: history.points.map((p) => p.volatility_flip),
    };
  }, [history]);

  useEffect(() => {
    if (!Plotly || !chartRef.current || !series) return;

    const traces = [
      {
        x: series.x,
        y: series.callWall,
        mode: 'lines+markers',
        type: 'scatter',
        name: 'Call Wall',
        connectgaps: true,
        line: { color: COLOR_CALL_WALL, width: 2 },
        marker: { color: COLOR_CALL_WALL, size: 6 },
        hovertemplate: 'Call Wall: %{y:,.2f}<extra></extra>',
      },
      {
        x: series.x,
        y: series.putWall,
        mode: 'lines+markers',
        type: 'scatter',
        name: 'Put Wall',
        connectgaps: true,
        line: { color: COLOR_PUT_WALL, width: 2 },
        marker: { color: COLOR_PUT_WALL, size: 6 },
        hovertemplate: 'Put Wall: %{y:,.2f}<extra></extra>',
      },
      {
        x: series.x,
        y: series.spot,
        mode: 'lines+markers',
        type: 'scatter',
        name: 'Spot',
        connectgaps: true,
        line: { color: COLOR_SPOT, width: 3 },
        marker: { color: COLOR_SPOT, size: 7 },
        hovertemplate: 'Spot: %{y:,.2f}<extra></extra>',
      },
      {
        x: series.x,
        y: series.volFlip,
        mode: 'lines+markers',
        type: 'scatter',
        name: 'Vol Flip',
        connectgaps: true,
        line: { color: COLOR_VOL_FLIP, width: 2, dash: 'dash' },
        marker: { color: COLOR_VOL_FLIP, size: 6 },
        hovertemplate: 'Vol Flip: %{y:,.2f}<extra></extra>',
      },
    ];

    const layout = {
      ...PLOTLY_LAYOUT_BASE,
      title: plotlyTitle('Key Levels Migration'),
      showlegend: true,
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
    };

    Plotly.newPlot(chartRef.current, traces, layout, {
      responsive: true,
      displayModeBar: false,
    });
  }, [Plotly, series]);

  if (plotlyError) {
    return (
      <div
        className="card"
        style={{ padding: '1rem', marginBottom: '1rem', color: 'var(--accent-coral)' }}
      >
        Levels history unavailable — Plotly failed to load ({plotlyError}).
      </div>
    );
  }

  if (loading && !history) {
    return (
      <div className="card text-muted" style={{ padding: '1rem', marginBottom: '1rem' }}>
        Loading levels history...
      </div>
    );
  }

  if (error) {
    return (
      <div className="card" style={{ padding: '1rem', marginBottom: '1rem', color: 'var(--accent-coral)' }}>
        Levels history error: {error}
      </div>
    );
  }

  if (!series) {
    return (
      <div className="card text-muted" style={{ padding: '1rem', marginBottom: '1rem' }}>
        No levels history available yet.
      </div>
    );
  }

  return (
    <div className="card" style={{ marginBottom: '1rem' }}>
      <div
        ref={chartRef}
        style={{ width: '100%', height: '360px', backgroundColor: '#141820' }}
      />
    </div>
  );
}
