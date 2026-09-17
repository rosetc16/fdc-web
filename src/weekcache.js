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

/* ⭐⭐⭐⭐ A WEEK OTHER THAN THIS ONE — 29q.
   Trey: "I'd like to be able to do the same thing on the home screen where I can toggle to see week 2
   instead of just week one. Here is where you could then show the icons to check on players like Ladd
   McConkey."

   The team hub has always accepted a week; this loader simply never passed one, because the home page only
   ever wanted "now". Looking ahead is the same request with a number in it.

   ⚠ THE WEEK IS PART OF THE CACHE KEY, and that is the whole reason this change is more than one argument.
     The signature was the league ids alone, so a week-2 read would have been served the cached week-1
     answer — same leagues, "fresh" — and the toggle would have appeared to work while changing nothing.
     A cache keyed on less than the request is a cache that lies. `off-week` reads also skip writing over
     the shared current-week entry, so stepping ahead and back does not cost a refetch of today. */
let offCache = new Map();          // week -> value, for weeks other than the current one
export async function loadWeek(leagues, opts = {}) {
  const connected = connectedOf(leagues);
  const want = Number.isFinite(opts.week) ? Number(opts.week) : null;
  const sig = connected.map(hubIdOf).join(",") + (want ? `@${want}` : "");
  if (!sig) return { sig, at: Date.now(), pack: null, hubs: [], week: null, connected: [] };
  if (want) {
    const hit = offCache.get(sig);
    if (hit && Date.now() - hit.at < TTL_MS && !opts.force) return hit;
    const v = await loadWeekAt(connected, sig, want);
    if (offCache.size > 6) offCache.clear();
    offCache.set(sig, v);
    return v;
  }
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

/* The same fetch, pinned to a week, kept out of the current-week cache. Deliberately NOT sharing the
   single-flight map above: two different weeks in flight at once are two different requests, and the
   shared map is keyed on a signature that would let one satisfy the other. */
async function loadWeekAt(connected, sig, week) {
  const base = connected[0];
  const { backendFormatKey } = await import("./App.jsx");
  const fmt = backendFormatKey(base && base.cfg ? base.cfg : { teams: 12, rounds: 15, scoring: { rec: 1 }, start: {} });
  const anyIdp = connected.some((l) => { const st = (l.cfg && l.cfg.start) || {}; return (st.DL || 0) + (st.LB || 0) + (st.DB || 0) + (st.IDPFLEX || 0) > 0; });
  const [pack, hubs] = await Promise.all([
    api.playerPack(fmt, undefined, { k: true, dst: true, idp: anyIdp }).catch(() => null),
    pool(connected, 4, (l) => api.sleeperTeamHub(hubIdOf(l), week, ownerOf(l))),
  ]);
  return { sig, at: Date.now(), pack: pack || (cache && cache.pack) || null, hubs,
    week: hubs.map((h) => h && h.week).find((w) => Number.isFinite(w)) || week, connected };
}

/* ⭐⭐⭐⭐⭐ THE INJURY DESIGNATIONS, AND THE ONE PLACE THEY LIVE — moved here in 29ae.
   These were module-private to MyWeek.jsx, which was fine while My Week was the only screen that read a
   designation. It is not any more: the home strip's to-do list, and now its hover, have to agree with My
   Week about whether "D" is worse than "Q" and what colour that is. Two tables would drift, and the drift
   would be invisible — both screens would keep rendering something plausible.
   The strings come from two feeds and neither is tidy, so this matches PREFIXES; an unrecognised status
   still lands somewhere sane rather than vanishing. */
export const DESIGNATIONS = [
  { re: /^(ir|inj|injured)/i, key: "IR", label: "IR", sev: 6, rank: 4, tone: "#F2655C" },
  { re: /^(pup|nfi|susp)/i, key: "PUP", label: "Not available", sev: 6, rank: 4, tone: "#F2655C" },
  { re: /^(out|o)$/i, key: "OUT", label: "Out", sev: 5, rank: 4, tone: "#F2655C" },
  { re: /^(d|doubt)/i, key: "D", label: "Doubtful", sev: 4, rank: 3, tone: "#E08A3C" },
  { re: /^(q|quest)/i, key: "Q", label: "Questionable", sev: 3, rank: 3, tone: "var(--gold)" },
  { re: /^(dtd|day)/i, key: "DTD", label: "Day-to-day", sev: 2, rank: 2, tone: "var(--gold)" },
  { re: /^(p|prob)/i, key: "P", label: "Probable", sev: 1, rank: 2, tone: "#6BA8E5" },
];
export function designationOf(raw) {
  const s = String(raw || "").trim();
  if (!s || /^(act|active|healthy)$/i.test(s)) return null;
  return DESIGNATIONS.find((d) => d.re.test(s)) || { key: "?", label: s.slice(0, 18), sev: 2, rank: 2, tone: "var(--mut)" };
}

/* ⭐⭐⭐⭐⭐ ONE READ OF ONE ROSTER, SHARED BY EVERY WEEK-SCOPED SCREEN — 29ae.
   Who you are starting, what each man projects THIS WEEK, whether he is hurt and whether he is on bye are
   the four facts underneath My Week, the home to-do list and Game Day alike. They were derived inline in
   MyWeek's per-league pass, which was correct while it was the only caller.
   ⚠ THE RULES THIS ENCODES ARE NOT OBVIOUS AND ARE WHY IT IS SHARED RATHER THAN COPIED:
     • `ptsOf` returns NULL, NOT ZERO, for a player the week feed does not cover. Calling that zero is what
       silenced the entire free-agent view once — every comparison became 0-vs-0.
     • The BYE test prefers the SCHEDULE (`hub.byeTeams`) and falls back to the pack's `bye_week` only when
       there is no schedule, because that column is null for long stretches of the year — which is how "no
       byes in any of your fifteen leagues" was once reported with a straight face.
   A second copy of either would look right and be wrong in a way nobody would see for months. */
export function rosterRead(hub, pack) {
  if (!hub || !hub.teams) return null;
  const mine = hub.teams.find((t) => t.rosterId === hub.myRosterId);
  if (!mine) return null;
  const bySid = new Map();
  ((pack && pack.players) || []).forEach((p) => { const k = p && (p.id != null ? p.id : p.sid); if (k != null) bySid.set(String(k), p); });
  const wkOf = (sid) => (hub.weekly && hub.weekly[String(sid)]) || null;
  const packOf = (sid) => bySid.get(String(sid)) || null;
  const ptsOf = (sid) => { const w = wkOf(sid); return w && w.pts != null ? Number(w.pts) : null; };
  const posOf = (sid) => { const p = packOf(sid); const w = wkOf(sid); return (p && p.pos) || (w && w.pos) || null; };
  const nameOf = (sid) => { const p = packOf(sid); const w = wkOf(sid); return (p && p.name) || (w && w.name) || `Player ${sid}`; };
  const teamOf = (sid) => { const p = packOf(sid); const w = wkOf(sid); return (p && p.team) || (w && w.team) || null; };
  const injOf = (sid) => designationOf((wkOf(sid) || {}).inj || (packOf(sid) || {}).inj);
  const byeSet = Array.isArray(hub.byeTeams) ? new Set(hub.byeTeams) : null;
  const onBye = (sid) => {
    if (byeSet) { const t = teamOf(sid); return t ? byeSet.has(t) : false; }
    const p = packOf(sid);
    return hub.week != null && !!p && p.bye === hub.week;
  };
  const starters = (mine.starters || []).filter(Boolean).map(String);
  const startSet = new Set(starters);
  const rosterAll = [...new Set([...(mine.players || []), ...(mine.reserve || []), ...(mine.taxi || [])].filter(Boolean).map(String))];
  return { hub, mine, bySid, wkOf, packOf, ptsOf, posOf, nameOf, teamOf, injOf, onBye,
    starters, startSet, rosterAll, bench: rosterAll.filter((s) => !startSet.has(s)) };
}

/* ⭐⭐⭐⭐⭐ THE LINEUP CHANGES, ONCE — extracted from MyWeek in 29ae so the home page can show them.
   Trey: "What I don't see is the potential more optimal roster decisions (i.e. +2.5 on your bench — then
   show on the hover who you would substitute in and for whom). This is specifically on the home page for
   'this week' — I see it on the summary."
   ⚠⚠ THE TEMPTING SHORTCUT WAS TO RECOMPUTE IT IN THE HOME STRIP, and it is exactly the mistake 29aa spent
     a build undoing: the rebuild/win-now call existed twice, the copies disagreed, and one of them drove
     a whole season of advice. Two screens telling him different numbers for "available from your bench"
     would be the same bug with smaller stakes and the same invisibility.
   Same position only, because this page does not know a league's flex rules well enough to promise a swap
   is LEGAL, and a suggestion you cannot action is worse than none. Anyone with an availability problem is
   left to the injury list rather than counted twice here. */
export function lineupSwaps(hub, pack, read) {
  const R = read || rosterRead(hub, pack);
  if (!R) return [];
  const { ptsOf, posOf, nameOf, injOf, onBye, starters, bench } = R;
  const r1 = (n) => Math.round(n * 10) / 10;
  const swaps = [];
  starters.forEach((sid) => {
    const cur = ptsOf(sid);
    if (cur == null || onBye(sid)) return;
    const d = injOf(sid);
    if (d && d.rank >= 3) return;
    const pos = posOf(sid);
    const cand = bench.filter((b) => posOf(b) === pos && !onBye(b))
      .map((b) => ({ sid: b, name: nameOf(b), pts: ptsOf(b), inj: injOf(b) }))
      .filter((c) => c.pts != null && !(c.inj && c.inj.rank >= 3))
      .sort((a, b) => b.pts - a.pts)[0];
    if (!cand || cand.pts - cur < 1) return;      // under a point is inside the noise of a projection
    swaps.push({ sid, out: nameOf(sid), outPts: cur, in: cand.name, inPts: cand.pts, pos, gain: r1(cand.pts - cur) });
  });
  swaps.sort((a, b) => b.gain - a.gain);
  return swaps;
}

/* ⭐⭐⭐ THE ONE-LINE VERDICT FOR A SINGLE LEAGUE — what the home page's icon is for.
   ⚠ IT USED TO SAY "deliberately NOT a second implementation of My Week's analysis… the rich read
     (replacements, differentials, lineup swaps) belongs on the page built for it". That reasoning still
     holds and is now SATISFIED DIFFERENTLY: 29ae gave the home row the lineup swaps Trey asked for, but by
     calling `lineupSwaps` above — the function My Week itself calls — rather than by growing a second
     analysis here. The principle was never "the home page may not show this"; it was "there may not be two
     implementations of it", and extraction is the way to honour that while still answering the request. */
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
  const R = rosterRead(hub, pack);
  if (!R) return null;
  const playedOf = opts.playedOf || (() => false);
  const { ptsOf, posOf, nameOf, teamOf, onBye, starters } = R;
  const out = { out: [], check: [], bye: [], after: [] };  // `after` = flagged, but his game is already over
  /* ⭐⭐⭐⭐⭐ THE STRUCTURED ROWS ARE THE HOVER — 29ae. Trey: "I do want to be able to hover the injury
     and see more information."
     The four arrays above are DISPLAY STRINGS ("Ja'Marr Chase (Questionable)"), which is all a one-line
     cell ever needed and is useless to a table: you cannot right-align a projection you have glued into
     a sentence. `rows` carries the same men as fields. Both are returned because the arrays have two
     callers still and quietly changing what they hold would move text on a screen nobody was testing. */
  const rows = [];
  starters.forEach((sid) => {
    const w = (hub.weekly && hub.weekly[sid]) || {};
    const p = R.packOf(sid) || {};
    const name = nameOf(sid);
    const raw = String(w.inj || p.inj || "").trim();
    const bye = onBye(sid);
    const base = { sid, name, pos: posOf(sid), team: teamOf(sid), opp: w.opp || null, proj: ptsOf(sid) };
    /* ⚠ A MAN ON BYE HAS NO OPPONENT, whatever the week feed says. The fixture happily returns one —
       "Bucky Irving · Bye week · RB · NYG" was on screen — and a row that contradicts itself in the space
       of four columns destroys trust in the three columns that are right. The bye is the stronger fact
       (it comes from the SCHEDULE; see rosterRead), so it wins and the opponent is blanked.
       Projection is left alone on purpose: a bye player's projection is a real number the feed holds, and
       seeing 16.9 sitting next to "Bye week" is exactly the sting that makes you go and fix the lineup. */
    if (bye) { out.bye.push(name); rows.push({ ...base, opp: null, kind: "bye", label: "Bye week", tone: "#6BA8E5" }); }
    if (!raw || /^(act|active|healthy)$/i.test(raw)) return;
    const des = designationOf(raw);
    // His game is over. Whatever the tag says now, it is about next Sunday — see the note on this function.
    if (playedOf(sid)) {
      out.after.push(`${name} (${raw})`);
      rows.push({ ...base, kind: "after", label: (des && des.label) || raw, tone: "var(--mut)",
        note: "picked up after his game — a week-2 question, not a week-1 one" });
      return;
    }
    if (/^(ir|inj|out|o$|pup|nfi|susp)/i.test(raw)) {
      out.out.push(`${name} (${raw})`);
      rows.push({ ...base, kind: "out", label: (des && des.label) || raw, tone: (des && des.tone) || "#F2655C" });
    } else if (/^(d|doubt|q|quest)/i.test(raw)) {
      out.check.push(`${name} (${raw})`);
      rows.push({ ...base, kind: "check", label: (des && des.label) || raw, tone: (des && des.tone) || "var(--gold)" });
    }
  });
  /* Severity ranks only what you can still DO something about. A post-game knock is recorded on the row so
     the hover can mention it — "worth knowing for next week" — but it never lights the badge, because the
     badge's whole promise is "this league needs you before kickoff". */
  const sev = out.out.length ? 3 : out.check.length ? 2 : out.bye.length ? 1 : 0;
  /* The optimal-lineup gains, from the SHARED finder — see `lineupSwaps`. Passing the read we already have
     means the roster is walked once for both halves of this answer. */
  const swaps = lineupSwaps(hub, pack, R);
  const gain = Math.round(swaps.reduce((s, x) => s + x.gain, 0) * 10) / 10;
  return { ...out, rows, sev, swaps, gain };
}
