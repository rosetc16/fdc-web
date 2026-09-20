// The app persists its state through `window.storage` (get/set), an interface from the original
// prototype host. In this standalone app we back it with localStorage so everything works and
// persists in the browser with zero setup. (Per-user server persistence happens via the API in
// api.js when a backend is configured; this local store is the always-available fallback and
// holds UI state like the current league list between visits.)
import { packState, unpackState } from './statecodec.js';

const KEY_PREFIX = 'fdc:';

/* ⭐⭐⭐ THE STATE BLOB IS COMPRESSED HERE, AT THE DOOR, AND NOWHERE ELSE.
 *
 * Eight places in App.jsx read or write "gs-state", and the codec has to run on every one of them or a
 * packed blob eventually meets a reader that does not know about tables. Patching eight call sites is how
 * you get seven of them right; putting it in the one function they all go through is how you get eight.
 *
 * Local storage is worth compressing in its own right, not just to match the server: browsers cap a domain
 * at roughly 5 MB, a heavy user's mocks were heading for 2.5 MB of that, and a localStorage write that
 * throws QuotaExceeded is silently swallowed by the catch below — the user's draft simply stops saving.
 *
 * ⚠ ONLY "gs-state" IS TOUCHED. Every other key is opaque text and is passed through untouched.
 */
const isStateKey = (key) => key === 'gs-state';

if (typeof window !== 'undefined' && !window.storage) {
  window.storage = {
    async get(key) {
      try {
        const v = localStorage.getItem(KEY_PREFIX + key);
        if (v == null) return null;
        if (!isStateKey(key)) return { key, value: v };
        // A blob written by an older build has no tables; unpackState passes it straight through.
        try { return { key, value: JSON.stringify(unpackState(JSON.parse(v))) }; }
        catch { return { key, value: v }; }
      } catch { return null; }
    },
    async set(key, value) {
      try {
        let v = value;
        if (isStateKey(key)) {
          try { v = JSON.stringify(packState(JSON.parse(value))); }
          catch { v = value; }   // not JSON, or not the shape we expect — store it verbatim rather than lose it
        }
        localStorage.setItem(KEY_PREFIX + key, v);
        return { key, value };
      }
      catch { return null; }
    },
    async delete(key) {
      try { localStorage.removeItem(KEY_PREFIX + key); return { key, deleted: true }; }
      catch { return null; }
    },
  };
}
