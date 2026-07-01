// App-wide error boundary. If any component throws during render (a bad data edge case mid-draft), React
// would otherwise unmount the entire tree and leave a blank white screen — and the user would lose their
// draft view. This catches that, keeps the page alive, and offers a one-click recovery. Because the app
// continuously persists state to localStorage (and the backend), reloading restores the draft where it
// left off, so a transient render error is a small bump instead of a lost draft.
import React from 'react';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    // Log for diagnostics; never rethrow (that would white-screen again).
    try { console.error('[FDC] render error caught by boundary:', error, info); } catch (e) {}
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0E1217', color: '#EEF2F6', fontFamily: 'system-ui, sans-serif', padding: 24 }}>
          <div style={{ maxWidth: 460, textAlign: 'center' }}>
            <div style={{ fontSize: 22, fontWeight: 800, marginBottom: 8 }}>Something hiccuped</div>
            <div style={{ fontSize: 14, lineHeight: 1.55, color: '#9AA7B5', marginBottom: 20 }}>
              The app hit an unexpected error, but <b style={{ color: '#EEF2F6' }}>your draft is safe</b> — it's saved automatically. Reload to pick up right where you left off.
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              <button onClick={() => window.location.reload()} style={{ background: '#F2B63C', color: '#151002', border: 'none', borderRadius: 8, padding: '11px 20px', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>Reload the app</button>
              <button onClick={() => this.setState({ error: null })} style={{ background: 'transparent', color: '#EEF2F6', border: '1px solid #2E3A48', borderRadius: 8, padding: '11px 20px', fontSize: 14, cursor: 'pointer' }}>Try to continue</button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
