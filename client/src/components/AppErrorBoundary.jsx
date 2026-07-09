import { Component } from 'react';

export default class AppErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    console.error('[nexus] UI error:', error);
  }

  render() {
    if (this.state.error) {
      const message = this.state.error?.message || String(this.state.error);
      return (
        <div style={{ fontFamily: 'system-ui, sans-serif', maxWidth: '36rem', margin: '3rem auto', padding: '0 1rem', color: '#0f172a' }}>
          <h1 style={{ fontSize: '1.25rem', margin: '0 0 0.5rem' }}>Nexus Core hit a problem</h1>
          <p style={{ color: '#475569', lineHeight: 1.45 }}>
            The app failed after sign-in. Try reloading the page. If it keeps happening, tell support what you were doing.
          </p>
          <pre
            style={{
              marginTop: '1rem',
              padding: '0.75rem',
              background: '#f8fafc',
              border: '1px solid #e2e8f0',
              borderRadius: 8,
              fontSize: '0.8rem',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {message}
          </pre>
          <button
            type="button"
            style={{ marginTop: '0.75rem', padding: '0.5rem 0.9rem', fontSize: '0.95rem', cursor: 'pointer' }}
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
