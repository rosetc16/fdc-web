// Backend API client. Points at the fdc-backend you deployed.
//
// Set VITE_API_URL (e.g. https://fdc-backend.onrender.com) in your environment / Render settings.
// If it's NOT set, the app runs in LOCAL mode: accounts/payments are simulated and data comes from
// the built-in engine. This means the site always works even before the backend is connected —
// connecting the backend is a pure upgrade, not a requirement to launch.

const API = import.meta.env.VITE_API_URL || '';
export const hasBackend = !!API;

const TOKEN_KEY = 'fdc:token';
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

  // ---- Sleeper connect / live sync ----
  async sleeperLeagues(username) { return call(`/api/connect/sleeper/leagues?username=${encodeURIComponent(username)}`); },
  async sleeperDraft(leagueId, username) { return call(`/api/connect/sleeper/draft?league_id=${encodeURIComponent(leagueId)}${username ? `&username=${encodeURIComponent(username)}` : ''}`); },

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
