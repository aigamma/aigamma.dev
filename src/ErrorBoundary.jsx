import { Component } from 'react';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            maxWidth: 1100,
            margin: '2rem auto',
            padding: '2rem',
            fontFamily: 'Courier New, monospace',
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
              fontFamily: 'Courier New, monospace',
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
