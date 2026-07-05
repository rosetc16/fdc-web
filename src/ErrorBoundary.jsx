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
  hardReload = () => {
    // Cache-busting reload. After a deploy, a stale cached bundle can throw a chunk/render error; a plain
    // reload might just re-serve the same stale files. Clear the Cache Storage first (if present), then
    // reload with a cache-busting query so the browser fetches the fresh build.
    try {
      if (typeof caches !== 'undefined' && caches.keys) {
        caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))).finally(() => {
          const u = new URL(window.location.href); u.searchParams.set('_r', Date.now().toString());
          window.location.replace(u.toString());
        });
        return;
      }
    } catch (e) { /* fall through to plain reload */ }
    const u = new URL(window.location.href); u.searchParams.set('_r', Date.now().toString());
    window.location.replace(u.toString());
  };
  render() {
    if (this.state.error) {
      return (
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0E1217', color: '#EEF2F6', fontFamily: 'system-ui, sans-serif', padding: 24 }}>
          <div style={{ maxWidth: 460, textAlign: 'center' }}>
            <div style={{ fontSize: 22, fontWeight: 800, marginBottom: 8 }}>Something hiccuped</div>
            <div style={{ fontSize: 14, lineHeight: 1.55, color: '#9AA7B5', marginBottom: 20 }}>
              The app hit an unexpected error, but <b style={{ color: '#EEF2F6' }}>your draft is safe</b> — it's saved automatically. Refresh the page to pick up right where you left off.
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              <button onClick={this.hardReload} style={{ background: '#F2B63C', color: '#151002', border: 'none', borderRadius: 8, padding: '11px 20px', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>Refresh the page</button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
