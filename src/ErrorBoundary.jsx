import { Component } from 'react';
import { trackView } from './analytics';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  // ErrorBoundary wraps every per-page App across the site, so its
  // mount fires exactly once per page load. Piggybacking the analytics
  // view-event here means every existing page already participates in
  // the public /stats counters without needing 16 separate edits, and
  // any future page added under the same main.jsx / ErrorBoundary
  // pattern is auto-wired.
  componentDidMount() {
    try {
      trackView();
    } catch {
      // Analytics is fire-and-forget; never let a tracking exception
      // unmount the page or trip the boundary's error state.
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            maxWidth: 1100,
            margin: '2rem auto',
            padding: '2rem',
            fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
            color: '#e74c3c',
            background: '#141820',
            border: '1px solid #e74c3c',
            borderRadius: 6,
          }}
        >
          <h2 style={{ marginBottom: '1rem' }}>Something went wrong</h2>
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '0.85rem' }}>
            {this.state.error?.message || String(this.state.error)}
          </pre>
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '0.75rem', color: '#8a8f9c', marginTop: '1rem' }}>
            {this.state.error?.stack}
          </pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              marginTop: '1rem',
              padding: '0.5rem 1.5rem',
              fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
              fontSize: '0.9rem',
              background: 'transparent',
              color: '#4a9eff',
              border: '1px solid #4a9eff',
              borderRadius: 3,
              cursor: 'pointer',
            }}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
