/* ⭐⭐⭐⭐ ONE LIVE READ, SHARED BY EVERY SCREEN THAT SHOWS A SCORE — 29n.
   ------------------------------------------------------------------------------------------------
   Trey: "when a week is live… the live badge shows up on the home page to see live results… then once
   games have finished… There should be a review tab next to live where you can dive into these. You can
   then see it at the league level in the hub."

   That is three screens reading the same scoreboard: the home page's badge and strip, the Game Day board,
   and one league's Live tab in the hub. Letting each fetch its own copy would be both wasteful and WRONG
   in a way that is very hard to explain to a user — the home page saying 3–2 while the hub it links to
   shows a game that has since flipped, because the two loaders are ninety seconds apart. A scoreboard that
   disagrees with itself is worse than a stale one that admits it.

   So the fetch lives here, once:
     • the home page asks quietly after paint and renders its badge when the answer lands
     • Game Day asks for the same thing and gets the cached copy instantly if it is fresh
     • the hub's Live tab filters that same copy down to one league
     • Game Day's poll writes back here, so the home badge ages with it
     • concurrent callers share ONE in-flight promise rather than racing

   ⚠ THE TTL FOLLOWS THE GAMES, NOT THE CLOCK. Thirty seconds while something is actually being played;
     ten minutes when nothing is. A Wednesday afternoon cannot produce a new score, and polling through it
     spends somebody else's rate limit — the ceiling on Sleeper is application-wide, not per user.
   ------------------------------------------------------------------------------------------------ */
import { api } from "./api.js";

const LIVE_TTL_MS = 30 * 1000;
const IDLE_TTL_MS = 10 * 60 * 1000;

let cache = null;        // { sig, at, value }
let inflight = null;

export const hubIdOf = (l) => (l && ((l.connect && l.connect.leagueId) || (l.cfg && l.cfg.connect && l.cfg.connect.leagueId) || l.sleeperLeagueId)) || null;
export const ownerOf = (l) => (l && (
  (l.connect && (l.connect.ownerUsername || l.connect.username))
  || (l.cfg && l.cfg.connect && (l.cfg.connect.ownerUsername || l.cfg.connect.username))
)) || null;
export const connectedOf = (leagues) => (leagues || []).filter((l) => hubIdOf(l));

const ttlFor = (value) => (value && value.weekState && value.weekState.anyLive ? LIVE_TTL_MS : IDLE_TTL_MS);

export function cachedLive(leagues) {
  const sig = connectedOf(leagues).map(hubIdOf).join(",");
  if (cache && cache.sig === sig) return cache.value;
  return null;
}

export async function loadLive(leagues, opts = {}) {
  const connected = connectedOf(leagues);
  const sig = connected.map(hubIdOf).join(",");
  if (!sig) return null;
  const fresh = cache && cache.sig === sig && Date.now() - cache.at < ttlFor(cache.value);
  if (fresh && !opts.force) return cache.value;
  if (inflight && inflight.sig === sig && !opts.force) return inflight.p;

  const p = (async () => {
    const value = await api.sleeperLive(connected.map(hubIdOf), undefined, connected.map(ownerOf));
    cache = { sig, at: Date.now(), value };
    return value;
  })();
  inflight = { sig, p };
  try { return await p; } finally { if (inflight && inflight.p === p) inflight = null; }
}

/* ⭐⭐⭐ WHAT THE HOME PAGE NEEDS TO DECIDE WHAT TO SHOW, in one object.
   Deliberately NOT a second implementation of anything: it reads the week state the server already sent
   and the totals it already computed. The home page's job is to choose between a live badge, a review tab,
   both, or neither — that is a rendering decision, and it should not require its own arithmetic. */
export function homeWeekView(live) {
  if (!live) return { show: false };
  const ws = live.weekState || {};
  const T = live.totals || null;
  return {
    show: !!(ws.anyLive || ws.anyDone),
    live: !!ws.anyLive,
    /* "once games have finished (I'm thinking any game that's finished)" — the tab APPEARS on the first
       final whistle. Whether the week can actually be REVIEWED is a stricter test the review itself makes
       (every game done), because reviewing half a week gives advice about players who have not played. */
    reviewable: !!ws.anyDone,
    weekComplete: !!ws.allDone,
    nextKickoff: ws.nextKickoff || null,
    week: live.week || null,
    totals: T,
    at: live.at || null,
  };
}
