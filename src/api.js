// Backend API client. Points at the fdc-backend you deployed.
//
// Set VITE_API_URL (e.g. https://fdc-backend.onrender.com) in your environment / Render settings.
// If it's NOT set, the app runs in LOCAL mode: accounts/payments are simulated and data comes from
// the built-in engine. This means the site always works even before the backend is connected —
// connecting the backend is a pure upgrade, not a requirement to launch.

const API = import.meta.env.VITE_API_URL || '';
export const hasBackend = !!API;

const TOKEN_KEY = 'fdc:token';
// Remembers the server's most-recent state updated_at, used for optimistic-concurrency on writes.
let _lastStateUpdatedAt = null;
export const getToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
export const setToken = (t) => { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch {} };

async function call(path, { method = 'GET', body, auth = true } = {}) {
  if (!API) throw new Error('NO_BACKEND');
  const headers = { 'Content-Type': 'application/json' };
  const token = auth ? getToken() : null;
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
  return data;
}

export const api = {
  hasBackend,
  // ---- auth ----
  async signup(email, password) {
    const r = await call('/api/auth/signup', { method: 'POST', auth: false, body: { email, password } });
    setToken(r.token); return r.user;
  },
  async signin(email, password) {
    const r = await call('/api/auth/signin', { method: 'POST', auth: false, body: { email, password } });
    setToken(r.token); return r.user;
  },
  async me() {
    if (!getToken()) return null;
    const r = await call('/api/auth/me'); return r.user;
  },
  async saveRankSets(rankSets) {
    const r = await call('/api/auth/rank-sets', { method: 'POST', body: { rankSets } });
    return r.user;
  },
  signout() { setToken(null); },

  // ---- payments ----
  async startCheckout() {
    const r = await call('/api/payments/checkout', {
      method: 'POST',
      body: { successUrl: `${location.origin}/?paid=1`, cancelUrl: `${location.origin}/?canceled=1` },
    });
    return r.url; // caller redirects to Stripe
  },

  // ---- data ----
  async adpBoard(format, season) {
    return call(`/api/adp/board?format=${encodeURIComponent(format)}${season ? `&season=${season}` : ''}`, { auth: false });
  },
  async adpPlayer(playerId, format, season) {
    return call(`/api/adp/player/${playerId}?format=${encodeURIComponent(format)}${season ? `&season=${season}` : ''}`, { auth: false });
  },
  // Aggregated draft trends from the harvested-drafts pool (thousands of real Sleeper drafts).
  async trendsBoard(format, season, opts = {}) {
    const extra = [];
    if (season) extra.push(`season=${season}`);
    if (opts.limit) extra.push(`limit=${opts.limit}`);
    if (opts.minDrafts != null) extra.push(`minDrafts=${opts.minDrafts}`);
    if (opts.minPicks != null) extra.push(`minPicks=${opts.minPicks}`);
    return call(`/api/trends/board?format=${encodeURIComponent(format)}${extra.length ? `&${extra.join('&')}` : ''}`, { auth: false });
  },
  async trendsPlayer(playerId, format, season, teams) {
    const extra = [];
    if (season) extra.push(`season=${season}`);
    if (teams) extra.push(`teams=${teams}`);
    return call(`/api/trends/player/${playerId}?format=${encodeURIComponent(format)}${extra.length ? `&${extra.join('&')}` : ''}`, { auth: false });
  },
  async trendsDiag(season) {
    return call(`/api/trends/diag${season ? `?season=${season}` : ''}`, { auth: false });
  },
  async projections(season) {
    return call(`/api/projections${season ? `?season=${season}` : ''}`, { auth: false });
  },
  async playerPack(format, season, opts = {}) {
    const extra = [];
    if (season) extra.push(`season=${season}`);
    if (opts.k) extra.push("k=1");
    if (opts.dst) extra.push("dst=1");
    if (opts.idp) extra.push("idp=1");
    return call(`/api/player-pack?format=${encodeURIComponent(format)}${extra.length ? "&" + extra.join("&") : ""}`, { auth: false });
  },

  // ---- leagues / drafts ----
  async listLeagues() { return (await call('/api/leagues')).leagues; },
  async createLeague(payload) { return (await call('/api/leagues', { method: 'POST', body: payload })).league; },
  async updateLeague(id, patch) { return (await call(`/api/leagues/${id}`, { method: 'PATCH', body: patch })).league; },
  async deleteLeague(id) { return call(`/api/leagues/${id}`, { method: 'DELETE' }); },
  async saveDraft(leagueId, draft) { return (await call(`/api/leagues/${leagueId}/drafts`, { method: 'POST', body: draft })).draft; },

  // ---- per-user app state (cross-device persistence of the local gs-state blob) ----
  // We remember the updated_at we last saw from the server and send it as baseUpdatedAt on write, so the
  // server can reject a stale overwrite (409) instead of silently clobbering newer data from another device.
  async getState() {
    const r = await call('/api/state');
    if (r && r.updatedAt) _lastStateUpdatedAt = r.updatedAt;
    return r;
  },
  async putState(state) {
    try {
      const r = await call('/api/state', { method: 'PUT', body: { state, baseUpdatedAt: _lastStateUpdatedAt } });
      if (r && r.updatedAt) _lastStateUpdatedAt = r.updatedAt;
      return r;
    } catch (e) {
      // 409 = the server has newer data (another device saved). Return the server's state + updatedAt so the
      // caller can merge and re-save, rather than losing the newer copy.
      if (e && e.status === 409 && e.data) {
        if (e.data.serverUpdatedAt) _lastStateUpdatedAt = e.data.serverUpdatedAt;
        return { ok: false, conflict: true, state: e.data.state || {}, updatedAt: e.data.serverUpdatedAt || null };
      }
      throw e;
    }
  },

  // ---- Sleeper connect / live sync ----
  async sleeperLeagues(username) { return call(`/api/connect/sleeper/leagues?username=${encodeURIComponent(username)}`); },
  async sleeperDraft(leagueId, username) { return call(`/api/connect/sleeper/draft?league_id=${encodeURIComponent(leagueId)}${username ? `&username=${encodeURIComponent(username)}` : ''}`); },
  // ---- persistent Sleeper account link ----
  async sleeperAccount() { return call('/api/connect/sleeper/account'); },                          // -> { linked, sleeperUserId, sleeperUsername }
  async sleeperLink(username) { return call('/api/connect/sleeper/link', { method: 'POST', body: { username } }); },
  async sleeperUnlink() { return call('/api/connect/sleeper/unlink', { method: 'POST' }); },
  async sleeperMyLeagues(season) { return call(`/api/connect/sleeper/my-leagues${season ? `?season=${season}` : ''}`); },
  async sleeperTeamHub(leagueId, week) { return call(`/api/connect/sleeper/team-hub?league_id=${encodeURIComponent(leagueId)}${week ? `&week=${week}` : ''}`); },

  // ---- feedback (public submit) ----
  async submitFeedback(payload) { return call('/api/feedback', { method: 'POST', auth: false, body: payload }); },

  // ---- admin: users ----
  async adminUsers(search) { return call(`/api/admin/users${search ? `?search=${encodeURIComponent(search)}` : ''}`); },
  async adminSetDisabled(email, disabled) { return call('/api/admin/set-disabled', { method: 'POST', body: { email, disabled } }); },
  async adminRevokeComp(email) { return call('/api/admin/revoke-comp', { method: 'POST', body: { email } }); },
  async adminRunJob(job) { return call('/api/admin/run-job', { method: 'POST', body: { job } }); },
  // ---- admin: invites ----
  async adminInvite(email, scope) { return call('/api/admin/invite', { method: 'POST', body: { email, scope } }); },
  async adminInvites() { return call('/api/admin/invites'); },
  async adminCancelInvite(email) { return call('/api/admin/cancel-invite', { method: 'POST', body: { email } }); },
  // ---- admin: feedback inbox ----
  async adminFeedback() { return call('/api/admin/feedback'); },
  async adminFeedbackStatus(id, status) { return call(`/api/admin/feedback/${id}/status`, { method: 'POST', body: { status } }); },
};
