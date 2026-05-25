import { Component } from 'react';
import { trackView } from './analytics';

const MOBILE_QUERY = '(max-width: 768px)';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this._titleObserver = null;
    this._titleMql = null;
    this._titleMqlHandler = null;
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  // ErrorBoundary wraps every per-page App across the site, so its
  // mount fires exactly once per page load. Piggybacking the analytics
  // view-event here means every existing page already participates in
  // the public /stats counters without needing 16 separate edits, and
  // any future page added under the same main.jsx / ErrorBoundary
  // pattern is auto-wired. The mobile-title-stripper rides the same
  // universal mount: ~38 native title="" tooltips scattered across 13
  // components were each turning into Safari-iOS long-press tooltips
  // and noisy mobile-Chrome touch-targets. Stripping them globally
  // here keeps the mobile tap targets clean and avoids touching every
  // component (some of which don't have useIsMobile wired in).
  componentDidMount() {
    try {
      trackView();
    } catch {
      // Analytics is fire-and-forget; never let a tracking exception
      // unmount the page or trip the boundary's error state.
    }
    this.setupMobileTitleStripper();
  }

  componentWillUnmount() {
    if (this._titleObserver) {
      this._titleObserver.disconnect();
      this._titleObserver = null;
    }
    if (this._titleMql && this._titleMqlHandler) {
      if (this._titleMql.removeEventListener) {
        this._titleMql.removeEventListener('change', this._titleMqlHandler);
      } else if (this._titleMql.removeListener) {
        this._titleMql.removeListener(this._titleMqlHandler);
      }
      this._titleMql = null;
      this._titleMqlHandler = null;
    }
  }

  setupMobileTitleStripper() {
    if (typeof window === 'undefined' || typeof MutationObserver === 'undefined') return;
    if (!window.matchMedia) return;

    const stripFrom = (root) => {
      if (!root || root.nodeType !== 1) return;
      if (root.hasAttribute && root.hasAttribute('title')) {
        root.removeAttribute('title');
      }
      if (root.querySelectorAll) {
        const titled = root.querySelectorAll('[title]');
        for (let i = 0; i < titled.length; i += 1) {
          titled[i].removeAttribute('title');
        }
      }
    };

    const onMutations = (mutations) => {
      for (let i = 0; i < mutations.length; i += 1) {
        const m = mutations[i];
        if (m.type === 'attributes' && m.attributeName === 'title' && m.target && m.target.hasAttribute && m.target.hasAttribute('title')) {
          m.target.removeAttribute('title');
        } else if (m.type === 'childList' && m.addedNodes) {
          for (let j = 0; j < m.addedNodes.length; j += 1) {
            stripFrom(m.addedNodes[j]);
          }
        }
      }
    };

    const enable = () => {
      if (this._titleObserver) return;
      stripFrom(document.body);
      this._titleObserver = new MutationObserver(onMutations);
      this._titleObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['title'],
      });
    };

    const disable = () => {
      if (!this._titleObserver) return;
      this._titleObserver.disconnect();
      this._titleObserver = null;
    };

    this._titleMql = window.matchMedia(MOBILE_QUERY);
    this._titleMqlHandler = (event) => (event.matches ? enable() : disable());
    if (this._titleMql.matches) enable();
    if (this._titleMql.addEventListener) {
      this._titleMql.addEventListener('change', this._titleMqlHandler);
    } else if (this._titleMql.addListener) {
      this._titleMql.addListener(this._titleMqlHandler);
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
