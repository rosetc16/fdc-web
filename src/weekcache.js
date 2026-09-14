/* ⭐⭐⭐⭐ ONE READ OF YOUR WEEK, SHARED BY EVERY SCREEN THAT ASKS ABOUT IT.
   ------------------------------------------------------------------------------------------------
   Trey: "on the homepage where you're seeing the tabular form of all the teams… it'd be cool if there was,
   like, an info icon or, like, a caution icon, depending on the severity of things, that you hover and it,
   like, recommends, hey, keep track of this player who's questionable… without having to click into
   anything specific."

   That icon needs the same data My Week reads, which is a player pack plus one team-hub call per league —
   fifteen calls for a badge on a row. Doing that twice, once for the home page and once for the page the
   home page links to, would be both slow and WRONG: two loaders drifting a few minutes apart means the home
   page can say "2 to check" and the page it opens can show three, and nobody would ever work out why.

   So the fan-out lives here, once, behind a module-level cache:
     • the home page asks for it quietly after paint and renders its icons when it arrives
     • My Week asks for the same thing and gets the cached copy instantly if it is fresh
     • My Week's five-minute refresh writes back here, so the home page's icons age with it
     • two callers arriving together share ONE in-flight promise rather than racing

   ⚠ STALE IS BETTER THAN BLANK, BUT ONLY IF IT SAYS SO. `load()` returns the cached value immediately when
     it is inside TTL and refreshes in the background otherwise; every result carries `at`, so a caller can
     tell you how old the answer is instead of implying it is live. My Week prints that stamp.
   ------------------------------------------------------------------------------------------------ */
import { api } from "./api.js";

const TTL_MS = 5 * 60 * 1000;

let cache = null;        // { sig, at, pack, hubs, week }
let inflight = null;     // a promise shared by concurrent callers

export const hubIdOf = (l) => (l && ((l.connect && l.connect.leagueId) || (l.cfg && l.cfg.connect && l.cfg.connect.leagueId) || l.sleeperLeagueId)) || null;
export const connectedOf = (leagues) => (leagues || []).filter((l) => hubIdOf(l));

/* ⭐⭐⭐⭐ WHICH ACCOUNT THIS LEAGUE CAME IN UNDER — b132.
   Every imported league has carried the username since the day import was written; nothing ever read it
   back. Sending it with the hub call is the whole fix for "it's not picking up on the league that I was
   connected to earlier but not anymore": the server can then find your roster by that name even though the
   account is no longer one of yours. `ownerId` is preferred when the import stored one — a Sleeper user id
   never changes, whereas a username can be reassigned. */
export const ownerOf = (l) => (l && (
  (l.connect && (l.connect.ownerUsername || l.connect.username))
  || (l.cfg && l.cfg.connect && (l.cfg.connect.ownerUsername || l.cfg.connect.username))
)) || null;

/* A few at a time. Fifteen parallel team-hub calls each fan out to Sleeper themselves, and firing them all
   at once is how you get rate-limited into a page that half-loads and blames your leagues. */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) {
      const k = i++;
      if (k >= items.length) return;
      try { out[k] = await fn(items[k], k); } catch (e) { out[k] = { error: String((e && e.message) || e) }; }
    }
  }));
  return out;
}

export function cachedWeek(leagues) {
  const sig = connectedOf(leagues).map(hubIdOf).join(",");
  if (cache && cache.sig === sig) return cache;
  return null;
}

export async function loadWeek(leagues, opts = {}) {
  const connected = connectedOf(leagues);
  const sig = connected.map(hubIdOf).join(",");
  if (!sig) return { sig, at: Date.now(), pack: null, hubs: [], week: null, connected: [] };
  const fresh = cache && cache.sig === sig && Date.now() - cache.at < TTL_MS;
  if (fresh && !opts.force) return cache;
  if (inflight && inflight.sig === sig && !opts.force) return inflight.p;

  const p = (async () => {
    const base = connected[0];
    // Imported lazily so this module can be pulled into the home bundle without dragging App.jsx's whole
    // evaluation order along with it; the binding is live and only read at call time.
    const { backendFormatKey } = await import("./App.jsx");
    const fmt = backendFormatKey(base && base.cfg ? base.cfg : { teams: 12, rounds: 15, scoring: { rec: 1 }, start: {} });
    const anyIdp = connected.some((l) => { const st = (l.cfg && l.cfg.start) || {}; return (st.DL || 0) + (st.LB || 0) + (st.DB || 0) + (st.IDPFLEX || 0) > 0; });
    const [pack, hubs] = await Promise.all([
      api.playerPack(fmt, undefined, { k: true, dst: true, idp: anyIdp }).catch(() => null),
      pool(connected, 4, (l) => api.sleeperTeamHub(hubIdOf(l), undefined, ownerOf(l))),
    ]);
    const week = hubs.map((h) => h && h.week).find((w) => Number.isFinite(w)) || null;
    // A refresh that fails to fetch the pack keeps the last good one — names and injury notes do not change
    // in five minutes, and losing them would blank every row for no reason.
    const value = { sig, at: Date.now(), pack: pack || (cache && cache.pack) || null, hubs, week, connected };
    cache = value;
    return value;
  })();
  inflight = { sig, p };
  try { return await p; } finally { if (inflight && inflight.p === p) inflight = null; }
}

/* ⭐⭐⭐ THE ONE-LINE VERDICT FOR A SINGLE LEAGUE — what the home page's icon is for.
   Deliberately NOT a second implementation of My Week's analysis: it counts designations on the starters
   this league reports and stops there. The rich read (replacements, differentials, lineup swaps) needs the
   whole per-league pass and belongs on the page built for it; what a row on the home page owes you is
   whether it is worth opening, which is a number and a colour. */
/* ⭐⭐⭐⭐⭐ AN INJURY TAG AFTER THE GAME IS NEXT WEEK'S PROBLEM — 29p.
   Trey: "it's telling me that Ladd McConkey is questionable. He is questionable POST GAME. So I don't need
   to check it for week 1, but rather for week 2 next week."
   Exactly right, and it is the difference between a useful flag and a nag. A designation is a question
   about a game that has not happened: "will he play on Sunday". Once Sunday has happened for him, the same
   letter Q means something completely different — a knock picked up IN the game, which is a week-2 concern
   and nothing you can act on now. Counting it as "1 to check" on week 1 sends you to look at a lineup you
   can no longer change.
   `playedOf` answers "is his game over"; where we cannot tell, the old behaviour stands, because an
   unflagged injury is a worse failure than a stale one. */
export function leagueFlags(hub, pack, opts = {}) {
  if (!hub || !hub.teams) return null;
  const mine = hub.teams.find((t) => t.rosterId === hub.myRosterId);
  if (!mine) return null;
  const playedOf = opts.playedOf || (() => false);
  const bySid = new Map();
  ((pack && pack.players) || []).forEach((p) => { const k = p && (p.id != null ? p.id : p.sid); if (k != null) bySid.set(String(k), p); });
  const starters = (mine.starters || []).filter(Boolean).map(String);
  /* Byes from the SCHEDULE when the server could resolve it, and only from the player's `bye_week` column
     when it could not — that column is null for long stretches of the year, which is how "nobody in any of
     your fifteen leagues is on bye" used to be reported with a straight face. See connect.js `byeTeams`. */
  const byeSet = Array.isArray(hub.byeTeams) ? new Set(hub.byeTeams) : null;
  const out = { out: [], check: [], bye: [], after: [] };  // `after` = flagged, but his game is already over
  starters.forEach((sid) => {
    const w = (hub.weekly && hub.weekly[sid]) || {};
    const p = bySid.get(sid) || {};
    const name = p.name || w.name || `Player ${sid}`;
    const raw = String(w.inj || p.inj || "").trim();
    const team = p.team || w.team || null;
    const onBye = byeSet ? (team ? byeSet.has(team) : false) : (hub.week != null && p.bye === hub.week);
    if (onBye) out.bye.push(name);
    if (!raw || /^(act|active|healthy)$/i.test(raw)) return;
    // His game is over. Whatever the tag says now, it is about next Sunday — see the note on this function.
    if (playedOf(sid)) { out.after.push(`${name} (${raw})`); return; }
    if (/^(ir|inj|out|o$|pup|nfi|susp)/i.test(raw)) out.out.push(`${name} (${raw})`);
    else if (/^(d|doubt|q|quest)/i.test(raw)) out.check.push(`${name} (${raw})`);
  });
  /* Severity ranks only what you can still DO something about. A post-game knock is recorded on the row so
     the hover can mention it — "worth knowing for next week" — but it never lights the badge, because the
     badge's whole promise is "this league needs you before kickoff". */
  const sev = out.out.length ? 3 : out.check.length ? 2 : out.bye.length ? 1 : 0;
  return { ...out, sev };
}
