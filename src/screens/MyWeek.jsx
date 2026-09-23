/* ⭐⭐⭐⭐ 29i — FIFTEEN LEAGUES, ONE SCREEN, AND AN ANSWER RATHER THAN A LIST.
   ------------------------------------------------------------------------------------------------
   Trey, on 29h: "if someone is listed on the check before kickoff, I would also like you to put side by
   side, like who would be the player that you would replace with, and what is the point differential between
   those two… I want people to be able to check this up until the last minute of kickoffs… I'd like to be
   able to sort by a few different things… on free agents, right now I'm seeing there's nothing worth to
   claim, and I'm in like 12 different leagues, so there's just no way… I almost wonder if you could look
   into availability, free agents, weather, and then lineup changes, but then there would be, like, a summary
   tab."

   29h answered "who is hurt". This answers "what do I do about it", which is a different and much more
   useful question: every flagged starter now carries the player you would put in instead and what it is
   worth — PER LEAGUE, because a league where your bench is deep and one where it is not are different
   problems wearing the same injury.

   ⚠ WHY THE FREE-AGENT VIEW WAS EMPTY ACROSS TWELVE LEAGUES. Three bugs stacked, and only the last was real.
     (1) The pack was requested with `formatKey`, the TRADE-VALUE key, where the endpoint wants
         `backendFormatKey`. No error — just a thinner pack than it should have been.
     (2) `ptsOf` returned 0 for any player the week feed did not cover, so "unknown" and "worth nothing" were
         the same number. One failed upstream call silently zeroed every comparison in every league at once,
         which is exactly what twelve identical empty answers looks like. It returns null now, and a null
         skips the comparison instead of losing it.
     (3) The only thing it looked for was "beats a player you are starting", which in twelve leagues full of
         drafted starters is genuinely rare — so the honest answer really was "nothing", and it was useless.
         A bye you must cover and a thin spot worth streaming are also real reasons to make a claim.

   ⚠ AND IT REFRESHES ITSELF. "I want people to be able to check this up until the last minute of kickoffs.
     So we're going to have to update these as different injury designations come up." Designations move all
     Sunday morning; a Saturday-night read is a different set of answers from an 11:55 one. It re-reads every
     REFRESH_MS while the tab is visible, skips the poll entirely when it is not — fifteen league reads for a
     background tab is somebody's rate limit and nobody's benefit — and never blanks the screen to do it.

   ⚠ ONLY LEAGUES WHERE WE CAN SEE EVERY ROSTER, which was Trey's line and still holds: a manual league's
     roster is whatever it was on draft day, and a lineup warning drawn from that is a warning about a lineup
     you no longer have. Those leagues are named at the bottom rather than silently missing.

   ⭐⭐⭐⭐ 29k — AND THE FREE-AGENT VIEW WAS STILL EMPTY, because the three fixes above were all fixes to the
     COMPARISON and the fault was in the POOL. This page was asking the DRAFT PLAYER PACK who was available.
     The pack is the draftable universe: `playerPack.js` drops anyone with neither an ADP nor a season
     projection, which by October is a precise description of the only players who are ever actually free —
     the back-up promoted on Wednesday, this week's streaming defence, the tight end nobody drafted. So the
     pool was "players good enough to draft in August, minus the 180 already rostered", and in twelve leagues
     that really is close to nobody. The pool is now `hub.weekly`, the league's own projection feed, which
     covers every NFL player with a game this week; the pack is demoted to what it is good at — injury
     detail and bye weeks — and a player missing from it no longer disappears.

   ⭐⭐⭐⭐ AND BYES GET THEIR OWN SECTION, not a row type. Trey: "Yes, I want this to be focused on bye weeks,
     but also just specific team upgrades." A bye is the one waiver problem with a deadline and no judgment
     in it — the slot is empty, you know it days ahead, and it is the same answer in every league that player
     is in. It leads. The upgrades follow, and they say what they are worth.

   ⚠ WHICH ACCOUNT OWNS THE TEAM. A league imported under a Sleeper account you have since removed used to
     come back with `myRosterId: null`, and this page dropped it on the floor — "not picking up on the league
     that I was connected to earlier". Every hub call now carries the username the league was imported under,
     and a league we still cannot resolve is shown with the account it needs rather than omitted.
   ------------------------------------------------------------------------------------------------ */
import React, { useState, useEffect, useMemo, useRef } from "react";
import WeekStep from "../weekstep.jsx";
import { api } from "../api.js";
import { backendFormatKey, Dot, gradeHubTrade, GRADE_TONE } from "../App.jsx";
import { HoverTable, useHoverCard } from "../hovercard.jsx";
import { useWide } from "../usewide.js";
import { designationOf, lineupSwaps } from "../weekcache.js";
import WeeklyReview from "./WeeklyReview.jsx";

const REFRESH_MS = 5 * 60 * 1000;   // his number, and about right: designations move in minutes, not seconds

const hubIdOf = (l) => (l && ((l.connect && l.connect.leagueId) || (l.cfg && l.cfg.connect && l.cfg.connect.leagueId) || l.sleeperLeagueId)) || null;
// 1st / 2nd / 3rd. This screen is code-split, so it cannot reach App.jsx's copy without dragging the
// whole module in behind it — three lines is cheaper than the import.
/* When a transaction happened. ⚠ Duplicated from App.jsx's `txWhen` deliberately — this screen is
   code-split and importing it would drag the whole module into its chunk. Six lines, and the shape it
   reads (an epoch in milliseconds) is not going to move. */
const whenOf = (at) => {
  const t = Number(at);
  if (!Number.isFinite(t) || t <= 0) return null;
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", d.getFullYear() === new Date().getFullYear()
    ? { month: "short", day: "numeric" }
    : { month: "short", day: "numeric", year: "numeric" });
};
const ordinalOf = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  const sfx = ["th", "st", "nd", "rd"], m = v % 100;
  return `${v}${sfx[(m - 20) % 10] || sfx[m] || sfx[0]}`;
};
const ownerOf = (l) => (l && (
  (l.connect && (l.connect.ownerUsername || l.connect.username))
  || (l.cfg && l.cfg.connect && (l.cfg.connect.ownerUsername || l.cfg.connect.username))
)) || null;
/* ⭐⭐⭐⭐ b161 — WHICH PLATFORM, AND YAHOO'S OWN KEY. The Yahoo hub returns the same payload shape as the
   Sleeper one, so the only thing this page changes is which endpoint it asks; everything downstream is
   untouched. ⚠ These duplicate the copies in App.jsx deliberately: this screen is code-split, and
   importing them would drag the whole module into its chunk — which is the thing the split exists to
   prevent. Three lines each, and the shape they read is the saved league record, which does not move. */
const platOf = (l) => {
  const c = (l && (l.connect || (l.cfg && l.cfg.connect))) || null;
  if (!c) return l && l.sleeperLeagueId ? "sleeper" : null;
  return (c.platform ? String(c.platform).toLowerCase() : null) || (c.leagueId ? "sleeper" : null);
};
const yahooKeyOf = (l) => {
  const c = (l && (l.connect || (l.cfg && l.cfg.connect))) || {};
  return c.leagueKey || c.league_key || (c.leagueId && /^nfl\.l\./.test(String(c.leagueId)) ? c.leagueId : null) || null;
};
const hubCall = (l, week) => {
  const k = platOf(l) === "yahoo" ? yahooKeyOf(l) : null;
  return k ? api.yahooTeamHub(k, week) : api.sleeperTeamHub(hubIdOf(l), week, ownerOf(l));
};

/* The four reasons to make a claim, each with its own word. The labels are the whole point: a streamer
   dressed as an upgrade is how a waiver list stops being trusted, and "Bye next week" is useless unless it
   is visibly not "Bye hole". Ordered here the way they are ranked in the list. */
const FA_KIND = {
  bye:     { label: "Bye hole",      tone: "var(--gold)" },
  byeNext: { label: "Bye next week", tone: "var(--info)" },
  upgrade: { label: "Pos upgrade",   tone: "var(--pos)" },
  stream:  { label: "Thin spot",     tone: "var(--mut)" },
  hole:    { label: "Starter out",   tone: "var(--neg)" },
  depth:   { label: "Bench upgrade", tone: "var(--info)" },
};

/* ⭐⭐⭐⭐ THE DESIGNATION LADDER, IN HIS ORDER.
   Trey: "out would be first, then questionable, then doubtful— sorry, out, doubtful, questionable, then
   probable. IR would be the first one, obviously."
   `sev` is that ladder and is what the by-status sort reads. `rank` is a DIFFERENT number — the designation
   crossed with whether he is in your lineup — and is what the default grouping reads, because a doubtful
   bench player is not a task and an OUT starter is the only kind of emergency this page has. Keeping them
   separate is what lets one list be sorted two honest ways.
   The strings come from two feeds and neither is tidy, so this matches prefixes; an unrecognised status
   still lands somewhere sane rather than vanishing. */
/* ⚠ DESIGNATIONS / designationOf MOVED TO weekcache.js IN 29ae and are imported above. The home strip's
   to-do list now reads designations too, and two tables of injury severities would drift without either
   screen ever looking wrong. */
/* Shared by the summary table's header and its body — see the note on the summary block. The shape
   deliberately matches AHEAD_COLS on the home strip, because the two tables answer the same question. */
const SUM_COLS = "minmax(0,1.3fr) minmax(0,1fr) 108px 118px minmax(0,1.6fr)";

const SEV = {
  4: { label: "Not expected to play", tone: "var(--neg)", icon: "ti-alert-octagon" },
  3: { label: "Check before kickoff", tone: "var(--gold)", icon: "ti-clock-exclamation" },
  2: { label: "Carrying something", tone: "var(--info)", icon: "ti-first-aid-kit" },
  1: { label: "On your bench", tone: "var(--mut)", icon: "ti-dots" },
};

/* ⭐⭐⭐⭐⭐ THE SUMMARY HOVERS, AS REAL TABLES — 29ad, shared in 29ae.
   Trey: "when you hover on '2 to check before kickoff' it gives a prettier tabular format. When you hover
   on '2.3 available from your bench' it shows who you are replacing for who."
   Both were `title` attributes — the browser's own tooltip: one typeface, no columns, no colour, and a
   half-second delay before it deigns to appear. A list of players with a status and a projection each is
   TABULAR data, and the native tooltip is the one place on this page that cannot draw a table.
   The component itself now lives in ../hovercard.jsx, because 29ae put the same card on the home strip and
   in three places on Game Day; see that file for why it is at module level and anchored off the trigger. */

/* The per-league row's availability card. Module level so the two callers cannot drift apart, and so the
   whole card — including the sentence at the bottom — can be unit-tested without a browser.
   ⚠ THE NOTE IS THE POINT OF THE CARD, not decoration. "3 not expected to play" is alarming and often
     means nothing: a ruled-out man on your BENCH needs no action at all. The count that decides whether
     you open the app before kickoff is how many of them are in the lineup, and only the card can say it. */
export function rowCard(L, kind) {
  const who = (L.avail || []).filter((r) => (kind === "notplaying" ? r.rank >= 4 : r.rank === 3));
  const starting = who.filter((r) => r.starting).length;
  const out = kind === "notplaying";
  return {
    key: kind,
    title: `${(L.league && L.league.name) || "This league"} — ${who.length} ${out ? "not expected to play" : "to check before kickoff"}`,
    cols: [{ k: "Player", strong: true }, { k: "Status", tint: true }, { k: "Where" }, { k: "Proj", right: true }],
    rows: who.map((r) => ({
      Player: r.name,
      Status: (r.des && r.des.label) || "—",
      Where: r.starting ? "In your lineup" : "On your bench",
      Proj: Number.isFinite(r.proj) ? Math.round(r.proj * 10) / 10 : "—",
      tone: (r.des && r.des.tone) || "var(--mut)",
    })),
    note: starting === 0
      ? `None of ${who.length === 1 ? "them is" : "them are"} in your lineup — nothing to do here before kickoff.`
      : `${starting} of ${who.length} ${starting === 1 ? "is" : "are"} in your lineup${out ? " and will score you nothing if the ruling holds" : ""}.`,
  };
}

const ago = (iso) => {
  if (!iso) return null;
  const d = (Date.now() - new Date(iso).getTime()) / 86400000;
  if (!Number.isFinite(d) || d < 0) return null;
  if (d < 1) return "today";
  if (d < 2) return "yesterday";
  return `${Math.round(d)}d ago`;
};
const r1 = (n) => Math.round(n * 10) / 10;
/* Run the fan-out a few at a time. Fifteen parallel team-hub calls each fan out to Sleeper themselves, and
   firing them all at once is how you get rate-limited into a page that half-loads and blames your leagues. */
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

export default function MyWeek({ user, leagues, onHome, onBack, backLabel, onOpenHub, onUmbrella, initialView, onViewConsumed, embedded }) {
  // Home has two doors into this screen and they land on different tabs — see `myWeekView` in App.jsx.
  const [view, setView] = useState(initialView || "summary");   // summary | avail | lineup | fa | weather | review
  useEffect(() => { if (initialView && onViewConsumed) onViewConsumed(); }, []);
  const [sortBy, setSortBy] = useState("impact");   // impact | designation | leagues | league
  const [rows, setRows] = useState(null);
  const [pack, setPack] = useState(null);
  const [weather, setWeather] = useState(null);
  const [week, setWeek] = useState(null);
  /* ⭐⭐⭐⭐⭐ THE WEEK YOU ASKED FOR — 29w. Trey: "I want a toggle + I want it to default to the next week
     on Tuesdays." NULL means "whatever the backend decides is current", which since b143 rolls to the next
     week once every game of the current one has finished. A number means the user drove the stepper and is
     obeyed exactly — including stepping BACK to a finished week, which must not bounce forward again. */
  const [weekSel, setWeekSel] = useState(null);
  /* ⚠ THE STEPPER'S "CURRENT" IS THE AUTOMATIC WEEK, NOT THE ONE ON SCREEN. First cut passed `week`,
     which is read back from whatever the hubs just returned — so stepping to week 10 also moved `current`
     to 10, the control concluded it was already home, and the "↵ this week" reset never appeared. The
     automatic week is whatever came back while nothing was selected; remember that separately. */
  const [autoWeek, setAutoWeek] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshedAt, setRefreshedAt] = useState(null);
  /* The hover card's content and where to draw it. Null when nothing is hovered. */
  const { card, show: showCard, hide: hideCard } = useHoverCard();
  const wide = useWide(900);
  const [err, setErr] = useState(null);
  const ranFor = useRef(null);
  const connected = useMemo(() => (leagues || []).filter((l) => hubIdOf(l)), [leagues]);
  const unconnected = useMemo(() => (leagues || []).filter((l) => !hubIdOf(l)), [leagues]);
  /* ⭐⭐⭐⭐⭐ LEAGUE ACTIVITY — b161. Trey: "just see an aggregated list of connected leagues... somewhere
     on like the this week tab, I think, since it's an aggregated look."
     ⚠⚠ FETCHED ONLY WHEN THE VIEW IS OPENED, and this is not an optimisation. The backend makes one
       upstream Sleeper call per league PER WEEK, so a four-week window across twelve leagues is 48 calls —
       adding that to this page's existing load would put it on every Sunday-morning poll, for a view
       most visits never open. It is loaded once per (leagues × window) and kept. */
  const [tx, setTx] = useState(null);
  const [txErr, setTxErr] = useState(null);
  const [txLoading, setTxLoading] = useState(false);
  const [txScope, setTxScope] = useState("mine");     // mine | all — his toggle, and it defaults to mine
  const [txWeeks, setTxWeeks] = useState(4);
  const txRan = useRef(null);

  useEffect(() => {
    const sig = connected.map((l) => hubIdOf(l)).join(",") + "@" + (weekSel == null ? "auto" : weekSel);
    if (!sig) { setLoading(false); setRows([]); return; }
    let alive = true;
    const load = async (quiet) => {
      if (!quiet) setLoading(true);
      setErr(null);
      try {
        /* ONE PACK FOR ALL OF THEM. Names, positions, NFL team, bye week and the merged injury detail are
           the same facts in every league — only the VALUATION is format-specific, and this page does not
           value anybody: it reads what Sleeper already projects under each league's own scoring.
           ⚠ backendFormatKey, NOT formatKey. They are different keys with similar names and the wrong one
             fails silently: `formatKey` is the trade-value key ("RE-1QB-TEstd"), the endpoint wants
             "SCORING|QB|TE|POOL|TEAMS", and given a string with no pipes the server builds nonsense fallback
             keys, matches no published ADP and returns a thinner pack with every adp null. Nothing errors. */
        const base = connected[0];
        const fmt = backendFormatKey(base && base.cfg ? base.cfg : { teams: 12, rounds: 15, scoring: { rec: 1 }, start: {} });
        // IDP too when any league starts defenders, or every defensive starter is missing from the map.
        const anyIdp = connected.some((l) => { const st = (l.cfg && l.cfg.start) || {}; return (st.DL || 0) + (st.LB || 0) + (st.DB || 0) + (st.IDPFLEX || 0) > 0; });
        const [pk, hubs] = await Promise.all([
          api.playerPack(fmt, undefined, { k: true, dst: true, idp: anyIdp }).catch(() => null),
          pool(connected, 4, (l) => hubCall(l, weekSel == null ? undefined : weekSel)),
        ]);
        if (!alive) return;
        if (pk) setPack(pk);
        const wk = hubs.map((h) => h && h.week).find((w) => Number.isFinite(w)) || null;
        setWeek(wk);
        // The backend also reports the week it WOULD have chosen, which is the stepper's home.
        const auto = hubs.map((h) => h && h.defaultWeek).find((w) => Number.isFinite(w));
        if (Number.isFinite(auto)) setAutoWeek(auto);
        else if (weekSel == null && Number.isFinite(wk)) setAutoWeek(wk);
        setRows(connected.map((l, i) => ({ league: l, hub: hubs[i] && !hubs[i].error ? hubs[i] : null, error: hubs[i] && hubs[i].error })));
        setRefreshedAt(Date.now());
        if (wk) api.weatherWeek(wk).then((w) => { if (alive) setWeather(w); }).catch(() => {});
      } catch (e) {
        if (alive) setErr(String((e && e.message) || e));
      } finally { if (alive) setLoading(false); }
    };
    if (ranFor.current !== sig) { ranFor.current = sig; load(false); }
    /* ⭐⭐⭐ THE POLL, AND THE ONE CONDITION ON IT. `document.hidden` is the cheapest possible way to know
       nobody is looking, and a quiet refresh never sets `loading`, so the screen updates under you rather
       than blanking — which matters at 11:55 when you are staring at the row you are about to act on. */
    const t = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      load(true);
    }, REFRESH_MS);
    return () => { alive = false; clearInterval(t); };
  }, [connected, weekSel]);

  const bySid = useMemo(() => {
    const m = new Map();
    ((pack && pack.players) || []).forEach((p) => { const k = p && (p.id != null ? p.id : p.sid); if (k != null) m.set(String(k), p); });
    return m;
  }, [pack]);

  /* ⭐⭐⭐⭐ ONE PASS PER LEAGUE, AND EVERY VIEW READS ITS RESULT.
     Availability, lineup changes and free agents are three questions about the same three facts: who you are
     starting, what everyone projects this week, and who else you could play. Computing them together means
     the replacement suggested on an injury row and the swap suggested by the lineup view can never disagree
     with each other — which two separate calculations eventually would. */
  const perLeague = useMemo(() => {
    if (!rows) return [];
    return rows.map(({ league, hub, error }) => {
      if (!hub || !hub.teams) return { league, error: error || "no data" };
      const mine = hub.teams.find((t) => t.rosterId === hub.myRosterId);
      /* ⭐⭐⭐ A LEAGUE WE CANNOT PLACE YOU IN IS A TASK, NOT A GAP. It has one cause and one fix — the
         Sleeper account that owns this team is not linked — so say that, name the account if the league
         remembers it, and leave the row on the page. Dropping it is what made a whole league appear to
         vanish from this screen with no explanation anywhere. */
      if (!mine) return { league, error: "roster not found", needsAccount: ownerOf(league) || true };
      const wkOf = (sid) => (hub.weekly && hub.weekly[String(sid)]) || null;
      /* ⚠ NULL, NOT ZERO. A player the week feed does not cover has an UNKNOWN projection, and calling that
         zero is how the whole free-agent view went silent: every comparison became 0-vs-0 and all twelve
         leagues answered "nothing worth a claim" in unison. Null propagates into "these two cannot be
         compared", which is a thing the page can say out loud. */
      const ptsOf = (sid) => { const w = wkOf(sid); return w && w.pts != null ? Number(w.pts) : null; };
      const starters = (mine.starters || []).filter(Boolean).map(String);
      const startSet = new Set(starters);
      const rosterAll = [...new Set([...(mine.players || []), ...(mine.reserve || []), ...(mine.taxi || [])].filter(Boolean).map(String))];
      const bench = rosterAll.filter((s) => !startSet.has(s));
      const rostered = new Set((hub.rostered || []).map(String));
      const posOf = (sid) => { const p = bySid.get(sid); const w = wkOf(sid); return (p && p.pos) || (w && w.pos) || null; };
      const nameOf = (sid) => { const p = bySid.get(sid); const w = wkOf(sid); return (p && p.name) || (w && w.name) || `Player ${sid}`; };
      const teamOf = (sid) => { const p = bySid.get(sid); const w = wkOf(sid); return (p && p.team) || (w && w.team) || null; };
      /* ⭐⭐⭐⭐ THE BYE TEST, IN THE ORDER WE ACTUALLY TRUST IT.
         (1) The schedule: this player's NFL team has no game in week N. Unarguable, and the server now
             sends the set. (2) The player pack's `bye_week`, which is null for long stretches of the year
             and was the ONLY test before 29k — which is why a page Trey wanted "focused on bye weeks"
             reported no byes at all. A missing team is not a bye; it is a player we cannot place, and
             saying nothing about him is the honest move. */
      const byeSet = Array.isArray(hub.byeTeams) ? new Set(hub.byeTeams) : null;
      const onBye = (sid) => {
        if (byeSet) { const t = teamOf(sid); return t ? byeSet.has(t) : false; }
        const p = bySid.get(sid);
        return hub.week != null && !!p && p.bye === hub.week;
      };
      const injOf = (sid) => designationOf((wkOf(sid) || {}).inj || (bySid.get(sid) || {}).inj);

      /* ⭐⭐⭐⭐ THE FREE-AGENT POOL COMES FROM THE LEAGUE'S OWN WEEK FEED — see the header for the long
         version. `hub.weekly` is every player with a projection this week under THIS league's scoring;
         subtract everyone on a roster in THIS league and what is left is, by definition, available here.
         The pack is consulted for the nicer name and the injury detail, and a player it has never heard of
         is still a real pickup rather than an invisible one. */
      const freeByPos = new Map();
      Object.keys((hub && hub.weekly) || {}).forEach((sid) => {
        if (rostered.has(sid)) return;
        const w = hub.weekly[sid] || {};
        const pos = posOf(sid);
        if (!pos) return;
        const v = ptsOf(sid);
        if (v == null) return;                       // unknown, not zero — see the note on ptsOf
        if (!freeByPos.has(pos)) freeByPos.set(pos, []);
        freeByPos.get(pos).push({ sid, name: nameOf(sid), team: teamOf(sid), pts: v, bye: onBye(sid), inj: injOf(sid), opp: w.opp });
      });
      freeByPos.forEach((arr) => arr.sort((a, b) => b.pts - a.pts));

      /* ⭐⭐⭐⭐ WHO WOULD YOU PLAY INSTEAD — the thing he asked for, and what turns this page from a report
         into a decision. Bench first, because a bench player costs nothing and is available at 11:58 while a
         free agent needs a claim that may already be too late. Anyone hurt, on bye, or with no projection is
         not a replacement: "start your other doubtful receiver" is worse than saying nothing. */
      const replacementFor = (sid) => {
        const pos = posOf(sid);
        if (!pos) return null;
        const cur = ptsOf(sid);
        const usable = (c) => c.pts != null && !c.bye && !(c.inj && c.inj.rank >= 3);
        const benchOpts = bench.filter((b) => b !== sid && posOf(b) === pos)
          .map((b) => ({ sid: b, name: nameOf(b), pts: ptsOf(b), bye: onBye(b), inj: injOf(b), where: "bench" }))
          .filter(usable).sort((a, b) => b.pts - a.pts);
        const faOpts = (freeByPos.get(pos) || []).filter((f) => usable(f)).slice(0, 1)
          .map((f) => ({ ...f, where: "free agent" }));
        const best = benchOpts[0] || faOpts[0] || null;
        if (!best) return null;
        return { ...best, delta: cur == null ? null : r1(best.pts - cur), curPts: cur };
      };

      const avail = [];
      rosterAll.forEach((sid) => {
        const des = injOf(sid);
        if (!des) return;
        const starting = startSet.has(sid);
        const p = bySid.get(sid) || {};
        const w = wkOf(sid) || {};
        avail.push({ sid, starting, des, rank: starting ? des.rank : 1,
          name: nameOf(sid), pos: posOf(sid), team: p.team || w.team || "", opp: w.opp,
          part: p.injPart, note: p.injNote, at: p.injAt, proj: ptsOf(sid),
          replacement: starting ? replacementFor(sid) : null });
      });

      /* ⭐⭐⭐ LINEUP CHANGES — "are there better players that are projecting for more points to better
         optimize your lineup?" Nothing to do with injuries: a healthy bench player who simply projects
         higher than the healthy starter in front of him.
         ⚠ THE RULE ITSELF MOVED TO weekcache.js IN 29ae, because Trey asked for the same figure on the home
           page ("+2.5 on your bench") and a second copy of it there would be the 29aa duplication bug with
           smaller stakes. One implementation, two callers. */
      const swaps = lineupSwaps(hub, pack);

      /* ⭐⭐⭐ FREE AGENTS, IN THREE FLAVOURS RATHER THAN ONE — see the header for why one was not enough.
         Each is labelled for exactly what it is, so the list never lets a streamer pass for an upgrade. */
      const byeNextSet = Array.isArray(hub.byeTeamsNext) ? new Set(hub.byeTeamsNext) : null;
      const fa = [];
      /* One name is one claim. Two bye holes at the same position are two problems and deserve two answers —
         offering the same running back for both reads like a bug and, worse, is one you cannot act on twice. */
      const taken = new Set();
      const claimable = (pos) => (freeByPos.get(pos) || []).filter((f) => !f.bye && !taken.has(f.name) && !(f.inj && f.inj.rank >= 4));

      /* ⭐⭐⭐⭐ BYES FIRST, AND FROM THE WHOLE ROSTER RATHER THAN THE LINEUP. "I want this to be focused on
         bye weeks." A bye is a hole you can see coming, and the reason to look at it early is that the
         waiver wire is picked over by Tuesday. So: anyone you are STARTING who is on bye this week is an
         open slot right now; anyone on the roster who is on bye NEXT week is a slot you can cover while
         there is still somebody worth covering it with. The second kind is the one nothing on this site
         has ever told him. */
      const byeSeen = new Set();
      const pushBye = (sid, when) => {
        const pos = posOf(sid);
        if (!pos || byeSeen.has(sid)) return;
        byeSeen.add(sid);
        const best = claimable(pos).filter((f) => !(when === "next" && byeNextSet && f.team && byeNextSet.has(f.team)))[0];
        if (!best) return;
        taken.add(best.name);
        fa.push({
          kind: when === "next" ? "byeNext" : "bye",
          rank: when === "next" ? 3 : 4, pos, outName: nameOf(sid), inName: best.name, inTeam: best.team,
          gain: r1(best.pts),
          why: when === "next"
            ? `${nameOf(sid)} is on bye in week ${(hub.week || 0) + 1} — claim now, not Tuesday`
            : `${nameOf(sid)} is on bye in week ${hub.week}`,
        });
      };
      /* ⚠ STARTERS BOTH TIMES, INCLUDING FOR NEXT WEEK. Running the next-week pass over the WHOLE roster
         reads well until you watch what it does: a handcuff back you stashed on the bench is not a hole in
         anything, but he generates a claim — and because byes are answered before upgrades, that phantom
         claim SPENDS the best free player at his position and the genuine upgrade behind it goes unlisted.
         A player you are not starting is not a slot you have to fill. */
      /* ⭐⭐⭐⭐⭐ HOLES FIRST: A STARTER WHO WILL NOT PLAY, OR A SLOT WITH NOBODY IN IT — 29bm.
         Trey: "I just lost Jaxson Dart and Jayden Daniels (my 2 QBs) to injuries that will keep both out
         this week. At a very minimum, that league should be recommending I pick up a QB." It recommended
         nothing, for two reasons. The upgrade pass needs the starter's projection, and Sleeper stops
         projecting a player once he is ruled out (null, so `cur == null` skipped him). And an empty slot
         ('0', which is what the lineup holds once you bench or drop the injured man) has no player and so
         no position to search. A hole is now: an empty slot, a starter who is out or doubtful, or a starter
         projecting nothing while the rest of the lineup is projected. It is answered against the best
         healthy bench player at that position, because a free agent is only worth a claim if he beats the
         man you would otherwise slide in. */
      /* ⭐⭐⭐⭐⭐ 29bo — THE NEXT THREE WEEKS, AND YOUR OWN MAN IN THE LIST. Trey: "can you highlight where your
         current player fits. For example, I see +7 for DST, but I don't see my defense in there to compare
         them. It might also be helpful to see the next 3 weeks and how they project comparatively to ensure
         it's not just a one week thing... This is particularly important for defenses for matchups."
         Backend b169 sends `weeklyNext` ([[pts, opp], ...] for the three weeks after this one) so a streaming
         defence can be read as a schedule rather than a single Sunday. */
      const parkedMine = new Set([].concat(mine.reserve || [], mine.taxi || []).filter(Boolean).map(String));
      const adpOf = (sid) => { const p = bySid.get(sid); return p && Number.isFinite(p.adp) ? p.adp : 999; };
      const KD = (pos) => /^(K|DEF|DST)$/i.test(String(pos || ""));
      const releaseFor = (pos, startingOver) => {
        if (KD(pos)) {
          const same = bench.filter((b) => !parkedMine.has(b) && posOf(b) === pos);
          if (same.length) return same.sort((x, y) => adpOf(y) - adpOf(x))[0];
          return startingOver;
        }
        const pool2 = bench.filter((b) => !parkedMine.has(b) && !KD(posOf(b)));
        if (!pool2.length) return startingOver;
        return pool2.sort((x, y) => adpOf(y) - adpOf(x) || (ptsOf(x) || 0) - (ptsOf(y) || 0))[0];
      };
      const nextOf = (sid) => {
        const rowsN = (hub.weeklyNext && hub.weeklyNext[String(sid)]) || null;
        return (hub.weeksNext || []).map((wk2, i) => {
          const cell = rowsN && rowsN[i];
          return { week: wk2, pts: cell && cell[0] != null ? r1(cell[0]) : null, opp: cell ? cell[1] : null };
        });
      };
      const relInfo = (sid) => sid ? { name: nameOf(sid), pos: posOf(sid), pts: ptsOf(sid), adp: adpOf(sid) < 999 ? Math.round(adpOf(sid)) : null } : null;
      const SLOT_POS = { QB: ["QB"], RB: ["RB"], WR: ["WR"], TE: ["TE"], K: ["K"], DEF: ["DEF", "DST"], DST: ["DST", "DEF"],
        FLEX: ["RB", "WR", "TE"], WRRB_FLEX: ["RB", "WR"], REC_FLEX: ["WR", "TE"], SUPER_FLEX: ["QB", "RB", "WR", "TE"],
        IDP_FLEX: ["DL", "LB", "DB"], DL: ["DL"], LB: ["LB"], DB: ["DB"] };
      const slotList = (Array.isArray(hub.rosterPositions) ? hub.rosterPositions : []).filter((x) => !/^(BN|IR|TAXI)$/i.test(x));
      const anyProj = starters.some((s) => { const v = ptsOf(s); return v != null && v > 0; });
      const benchUsed = new Set();
      const healthy = (sid) => { const d = injOf(sid); return !onBye(sid) && ptsOf(sid) != null && ptsOf(sid) > 0 && !(d && d.sev >= 4); };
      const holeSids = new Set();
      (mine.starters || []).forEach((raw, i) => {
        const sid = raw == null ? "0" : String(raw);
        const empty = sid === "0";
        if (!empty && onBye(sid)) return;              // byes have their own pass below
        const d = empty ? null : injOf(sid);
        const v = empty ? null : ptsOf(sid);
        const out = empty || (d && d.sev >= 4) || (anyProj && (v == null || v <= 0));
        if (!out) return;
        const slot = slotList[i] || null;
        const positions = empty ? (SLOT_POS[slot] || (slot ? [slot] : [])) : [posOf(sid)].filter(Boolean);
        if (!positions.length) return;
        if (!empty) holeSids.add(sid);
        const benchBest = bench.filter((b) => !benchUsed.has(b) && !startSet.has(b) && positions.includes(posOf(b)) && healthy(b))
          .sort((a, b) => ptsOf(b) - ptsOf(a))[0] || null;
        const benchPts = benchBest ? ptsOf(benchBest) : 0;
        const best = positions.flatMap((pp) => claimable(pp).filter((f) => !(f.inj && f.inj.rank >= 3)).slice(0, 1).map((f) => ({ ...f, pos: pp })))
          .sort((a, b) => b.pts - a.pts)[0];
        const who = empty ? `Your ${slot || positions[0]} slot is empty` : `${nameOf(sid)} is ${!d ? "not projected to play" : d.key === "IR" ? "on IR" : d.key === "PUP" ? "not available" : d.label.toLowerCase()} this week`;
        if (!best || best.pts - benchPts < 1.5) { if (benchBest) benchUsed.add(benchBest); return; }
        taken.add(best.name);
        /* ⭐ 29bp — Trey: "On the 'starter out' ones, I also want to see alternatives on there." Same card the
           position upgrades get: every free agent who could fill the hole, the man on your bench who would
           otherwise take it (the gold row, since he is what you are really replacing), and the next weeks. */
        const holeAlts = positions.flatMap((pp) => claimable(pp).filter((f) => !(f.inj && f.inj.rank >= 3)).slice(0, 6))
          .sort((a, b) => b.pts - a.pts).slice(0, 8)
          .map((f) => ({ name: f.name, team: f.team, pts: r1(f.pts), gain: r1(f.pts - benchPts), opp: f.opp, next: nextOf(f.sid) }));
        const holeYours = benchBest
          ? { name: `${nameOf(benchBest)} (your bench)`, team: teamOf(benchBest), pts: r1(benchPts), opp: (wkOf(benchBest) || {}).opp || null, next: nextOf(benchBest), mine: true }
          : (empty ? null : { name: `${nameOf(sid)} (out)`, team: teamOf(sid), pts: 0, opp: (wkOf(sid) || {}).opp || null, next: nextOf(sid), mine: true });
        fa.push({ kind: "hole", rank: 5, pos: best.pos, outName: empty ? "empty slot" : nameOf(sid), inName: best.name, inTeam: best.team,
          gain: r1(best.pts - benchPts), inPts: r1(best.pts), alts: holeAlts, yours: holeYours, weeksNext: hub.weeksNext || [],
          startOver: benchBest ? { name: nameOf(benchBest), pts: r1(benchPts) } : null,
          release: relInfo(releaseFor(best.pos, empty ? null : sid)),
          why: benchBest
            ? `${who}. ${best.name} projects ${r1(best.pts)}, ${r1(best.pts - benchPts)} more than ${nameOf(benchBest)} on your bench`
            : `${who} and you have no healthy ${positions.join("/")} on the bench. ${best.name} projects ${r1(best.pts)}` });
      });

      starters.forEach((sid) => { if (onBye(sid)) pushBye(sid, "now"); });
      if (byeNextSet) starters.forEach((sid) => { const t = teamOf(sid); if (t && byeNextSet.has(t)) pushBye(sid, "next"); });

      /* ⭐⭐⭐⭐⭐ THEN THE POSITION UPGRADES, BY POSITION RATHER THAN BY STARTER — 29bp.
         Trey (29bn): "I also want you to list if there is a starter that would get outscored by someone on
         waivers... For DST and K, I only want to show the top option... For RB, WR, TE, QB upgrades to starting
         lineup, you can show more than one, but only if you are convicted."
         Trey (29bp): "I see a lot of defense and kicker recommendations, but not a ton of position players. I do
         want to ultimately compare against the starting lineup, but we should also compare against the bench
         too."
         ⚠ WHY THE SKILL POSITIONS WERE QUIET, AND THE KICKER STOPPED: the old pass walked STARTERS and needed a
           free agent to beat one of them. A kicker or a defence has one starter and a thin wire, so it clears
           that bar constantly; a running back room has two starters and a flex and a bench, so almost nothing
           does — and a starter with no projection at all (a kicker Sleeper has not published yet) was skipped
           entirely, which is how a league that had a kicker upgrade last week had nothing at all this week.
         Now each POSITION is read as a room: the man a pickup would replace in the lineup is the WORST starter
         there, and the man he would replace on the bench is the worst usable backup. Two kinds of row come out
         of that, and they are labelled differently because they are different claims:
           · "Pos upgrade" — he beats your worst starter (K/DEF: by a point; else 1.5 and 10%).
           · "Bench upgrade" — he does not, but he beats your best BACKUP at that position and is close enough
             to the lineup to matter (70% of your worst starter), which is the injury and bye insurance that
             never used to be listed. One per position, and never for K/DEF, where a second one is dead weight.
         Alternatives (and your own man, and the next three weeks) ride on every row's hover. */
      const usable = (sid) => { const d = injOf(sid); return !onBye(sid) && ptsOf(sid) != null && !(d && d.rank >= 3); };
      const posGroups = new Map();
      const addTo = (pos, sid, starting) => { if (!pos) return; if (!posGroups.has(pos)) posGroups.set(pos, { starters: [], bench: [] });
        posGroups.get(pos)[starting ? "starters" : "bench"].push(sid); };
      starters.forEach((sid) => { if (!onBye(sid) && !holeSids.has(sid)) addTo(posOf(sid), sid, true); });
      bench.forEach((sid) => { if (!parkedMine.has(sid) && usable(sid)) addTo(posOf(sid), sid, false); });
      const depthRows = [];
      posGroups.forEach((g, pos) => {
        const kd = KD(pos);
        const mineStart = g.starters.slice().sort((x, y) => (ptsOf(x) || 0) - (ptsOf(y) || 0));
        const worstStart = mineStart[0] || null;
        const cur = worstStart != null ? (ptsOf(worstStart) || 0) : null;
        const mineBench = g.bench.slice().sort((x, y) => (ptsOf(y) || 0) - (ptsOf(x) || 0));
        const bestBench = mineBench[0] || null;
        const free = claimable(pos).filter((f) => !(f.inj && f.inj.rank >= 3));
        if (!free.length) return;
        const wkNext = hub.weeksNext || [];
        const altsFrom = (baseline) => free.slice(0, 8).map((f) => ({ name: f.name, team: f.team, pts: r1(f.pts), gain: r1(f.pts - baseline), opp: f.opp, next: nextOf(f.sid) }));
        /* ── starter upgrades ─────────────────────────────────────────────────────────────────── */
        if (cur != null) {
          const better = free.filter((f) => f.pts > cur);
          const bar = kd ? 1 : Math.max(1.5, cur * 0.10);
          const conv = (f) => f.pts - cur >= Math.max(3, cur * 0.20);
          const rows = [];
          if (better.length && better[0].pts - cur >= bar) rows.push(better[0]);
          if (!kd && rows.length) better.slice(1).forEach((f) => { if (rows.length < 3 && conv(f) && conv(rows[0])) rows.push(f); });
          rows.forEach((best) => {
            taken.add(best.name);
            const rel = releaseFor(pos, worstStart);
            fa.push({ kind: "upgrade", rank: 2, pos, outName: nameOf(worstStart), inName: best.name, inTeam: best.team,
              gain: r1(best.pts - cur), inPts: r1(best.pts), weeksNext: wkNext,
              startOver: { name: nameOf(worstStart), pts: r1(cur) }, release: relInfo(rel),
              alts: altsFrom(cur),
              yours: { name: nameOf(worstStart), team: teamOf(worstStart), pts: r1(cur), opp: (wkOf(worstStart) || {}).opp || null, next: nextOf(worstStart), mine: true },
              why: `projects ${r1(best.pts)}, ${r1(best.pts - cur)} more than ${nameOf(worstStart)}, the ${pos} you would drop from the lineup` });
          });
          if (rows.length) return;      // one claim per position: a starter upgrade outranks depth
        }
        /* ── bench upgrades: the depth claim, which is where the running backs and receivers live ── */
        if (kd) return;
        const benchPts = bestBench != null ? (ptsOf(bestBench) || 0) : 0;
        const floor = cur != null ? cur * 0.7 : 0;
        const best = free[0];
        if (!best || best.pts < floor || best.pts - benchPts < 1.5) return;
        const rel = releaseFor(pos, null);
        depthRows.push({ kind: "depth", rank: 1, pos, outName: bestBench != null ? nameOf(bestBench) : `no backup ${pos}`,
          inName: best.name, inTeam: best.team, gain: r1(best.pts - benchPts), inPts: r1(best.pts), weeksNext: wkNext,
          startOver: cur != null ? { name: nameOf(worstStart), pts: r1(cur) } : null,
          benchOver: bestBench != null ? { name: nameOf(bestBench), pts: r1(benchPts) } : null,
          release: relInfo(rel), alts: altsFrom(benchPts),
          yours: bestBench != null
            ? { name: `${nameOf(bestBench)} (your best backup)`, team: teamOf(bestBench), pts: r1(benchPts), opp: (wkOf(bestBench) || {}).opp || null, next: nextOf(bestBench), mine: true }
            : (worstStart != null ? { name: `${nameOf(worstStart)} (your ${pos})`, team: teamOf(worstStart), pts: r1(cur || 0), opp: (wkOf(worstStart) || {}).opp || null, next: nextOf(worstStart), mine: true } : null),
          why: bestBench != null
            ? `projects ${r1(best.pts)} and would be your best backup ${pos}, ${r1(best.pts - benchPts)} ahead of ${nameOf(bestBench)}`
            : `projects ${r1(best.pts)} and you have no healthy backup ${pos} at all` });
      });
      /* Depth is the quietest claim on the page, so it is capped: the three best, not one per position. */
      depthRows.sort((x, y) => y.gain - x.gain).slice(0, 3).forEach((rowD) => { taken.add(rowD.inName); fa.push(rowD); });

      // One suggestion per position and player: the same free agent covering three of your slots is one idea.
      const seen = new Set();
      const faTrim = fa.sort((a, b) => b.rank - a.rank || b.gain - a.gain)
        .filter((x) => { const k = `${x.pos}:${x.inName}`; if (seen.has(k)) return false; seen.add(k); return true; });

      const projKnown = starters.some((s) => ptsOf(s) != null);
      /* What the pool actually was, so an empty list can tell you WHY. "No free agents worth claiming" and
         "we could not see the free agents" look identical on screen and are completely different problems —
         and the second one is the one that has been true for months. */
      const poolSize = [...freeByPos.values()].reduce((s, a) => s + a.length, 0);
      return { league, hub, avail, swaps, fa: faTrim, projKnown, poolSize, byeKnown: !!byeSet, week: hub.week };
    });
  }, [rows, bySid]);

  /* One row per PLAYER across leagues, carrying every league he is in and the replacement suggested in each.
     A player you start in six leagues is one injury with six consequences, not six injuries — printing it
     six times is the clutter this page exists to end. */
  const availRows = useMemo(() => {
    const byPlayer = new Map();
    perLeague.forEach((L) => {
      if (!L || !L.avail) return;
      L.avail.forEach((r) => {
        const g = byPlayer.get(r.sid) || { ...r, key: `p:${r.sid}`, inLeagues: [], startingIn: 0, rank: 0 };
        g.inLeagues.push({ league: L.league, starting: r.starting, replacement: r.replacement });
        if (r.starting) g.startingIn++;
        g.rank = Math.max(g.rank, r.rank);
        if (r.des.sev > g.des.sev) g.des = r.des;
        g.part = g.part || r.part; g.note = g.note || r.note; g.at = g.at || r.at;
        g.proj = g.proj != null ? g.proj : r.proj;
        byPlayer.set(r.sid, g);
      });
    });
    return [...byPlayer.values()];
  }, [perLeague]);

  /* ⭐⭐⭐ FOUR WAYS TO READ THE SAME LIST — "having different views upon availability". Each answers a
     different morning: where the damage is, his designation ladder straight, how much of your day a player
     is, and one league at a time for when you are actually going to go and fix them. */
  const availSorted = useMemo(() => {
    const a = availRows.slice();
    if (sortBy === "designation") a.sort((x, y) => y.des.sev - x.des.sev || y.startingIn - x.startingIn || x.name.localeCompare(y.name));
    else if (sortBy === "leagues") a.sort((x, y) => y.startingIn - x.startingIn || y.inLeagues.length - x.inLeagues.length || y.des.sev - x.des.sev);
    else a.sort((x, y) => y.rank - x.rank || y.des.sev - x.des.sev || y.startingIn - x.startingIn || (y.proj || 0) - (x.proj || 0));
    return a;
  }, [availRows, sortBy]);

  const wxRows = useMemo(() => {
    if (!weather || !weather.games) return [];
    const byTeam = new Map();
    weather.games.forEach((g) => g.teams.forEach((t) => byTeam.set(t, g)));
    const byP = new Map();
    perLeague.forEach((L) => {
      if (!L || !L.hub) return;
      const mine = L.hub.teams.find((t) => t.rosterId === L.hub.myRosterId);
      if (!mine) return;
      (mine.starters || []).filter(Boolean).map(String).forEach((sid) => {
        const p = bySid.get(sid);
        const tm = (p && p.team) || (L.hub.weekly && L.hub.weekly[sid] && L.hub.weekly[sid].team);
        const g = tm && byTeam.get(String(tm).toUpperCase());
        if (!g) return;
        const e = byP.get(sid) || { key: `wx:${sid}`, sid, name: (p && p.name) || sid, pos: (p && p.pos) || "", team: tm, game: g, inLeagues: [] };
        e.inLeagues.push(L.league);
        byP.set(sid, e);
      });
    });
    return [...byP.values()].sort((a, b) => b.game.severity - a.game.severity || b.inLeagues.length - a.inLeagues.length || a.name.localeCompare(b.name));
  }, [perLeague, weather, bySid]);

  /* ⭐⭐⭐⭐⭐ THE WEATHER IS A PROPERTY OF THE GAME, NOT OF THE PLAYER — 29x.
     Trey: "can you condense it by game. For example... I see a line for Tee Higgins... Ja'Marr Chase...
     Joe Burrow... Instead it should just show 'CIN @ HOU' then list the players and show what leagues
     those players are in."

     He is right and it is the same shape as several earlier fixes on this project: the page was keyed on
     the wrong noun. One storm produced three identical forecast sentences because three of his starters
     were in it, so the amount of screen a game took was decided by how many shares he happened to own —
     and the thing you actually need to read, the conditions, was repeated verbatim down the column.
     One row per GAME, with its players underneath. The sentence is said once, the players are the detail,
     and the severity ordering is now over games rather than over near-duplicates. */
  const wxGames = useMemo(() => {
    const byGame = new Map();
    wxRows.forEach((r) => {
      const k = `${r.game.away}@${r.game.home}`;
      if (!byGame.has(k)) byGame.set(k, { key: k, game: r.game, players: [] });
      byGame.get(k).players.push(r);
    });
    return [...byGame.values()]
      .map((g) => ({
        ...g,
        // Within a game, the men you have most riding on come first.
        players: g.players.slice().sort((a, b) => b.inLeagues.length - a.inLeagues.length || a.name.localeCompare(b.name)),
        // How many of YOUR lineups this one game touches — the reason to care about it at all.
        lineups: g.players.reduce((n2, p) => n2 + p.inLeagues.length, 0),
      }))
      .sort((a, b) => b.game.severity - a.game.severity || b.lineups - a.lineups
        || new Date(a.game.kickoff) - new Date(b.game.kickoff));
  }, [wxRows]);

  const counts = useMemo(() => ({
    urgent: availRows.filter((r) => r.rank >= 4).length,
    check: availRows.filter((r) => r.rank === 3).length,
    avail: availRows.filter((r) => r.rank >= 3).length,
    lineup: perLeague.reduce((s, L) => s + ((L && L.swaps) || []).length, 0),
    fa: perLeague.reduce((s, L) => s + ((L && L.fa) || []).length, 0),
    wx: wxRows.length,
    /* Zero until the feed has been fetched, which is correct rather than coy: before the view is opened
       we genuinely do not know, and a badge guessing at a number is worse than no badge. */
    moves: tx ? (tx.leagues || []).reduce((n, L) => n + (L.items || []).filter((x) => x.mine).length, 0) : 0,
  }), [availRows, perLeague, wxRows, tx]);

  /* A plain function, CALLED — a component declared during render is a new type every render and React
     remounts its whole subtree. See src/App.jsx `posGrid`. */
  const leagueTag = (l, dim) => (
    <button key={l.id} onClick={() => onUmbrella && onUmbrella(l.id)} data-wkleague={l.name} title={`Open ${l.name}`}
      style={{ cursor: "pointer", fontFamily: "inherit", flexShrink: 0, maxWidth: 230, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        border: `1px solid ${dim ? "var(--line)" : "var(--line2)"}`, background: "var(--panel2)", color: "var(--mut)",
        opacity: dim ? .6 : 1, borderRadius: 99, padding: "2px 9px", fontSize: 10.5, fontWeight: 700 }}>{l.name}</button>
  );

  /* ⭐⭐⭐⭐ ONE REPLACEMENT, AND IT SAYS WHICH KIND IT IS.
     The first cut printed "→ start X" for every alternative, and the very first test run showed why that is
     wrong: "→ start Jameson Williams (bench) 13.8 vs 23.6 −9.8". That is not a recommendation, it is a
     downgrade of nearly ten points — the honest reading is "if he sits, this is the best you have", and
     printing it as an instruction would have people benching a questionable star for a worse healthy body,
     which is the opposite of the advice.
     So the wording follows the arithmetic: a genuine gain is an instruction, a loss is a fallback, and the
     colour follows too. Nothing is hidden either way — you still see both projections and the gap, because
     the whole point is to let you decide how much a questionable tag is worth to you. */
  /* A plain function, CALLED — see `leagueTag` above. */
  const swapLine = ({ outPts, inName, inPts, delta, where }) => {
    const better = delta == null || delta >= 0;
    return (
      <span key={inName} data-wkswap={inName} data-wkswapkind={better ? "gain" : "fallback"}
        style={{ display: "inline-flex", alignItems: "baseline", gap: 5, fontSize: 11.5, flexWrap: "wrap" }}>
        <span className="mut">{better ? "→ start" : "→ if he sits, best you have is"}</span>
        <b style={{ color: better ? "var(--pos)" : "var(--ink)" }}>{inName}</b>
        {where ? <span className="mut" style={{ fontSize: 9.5 }}>({where})</span> : null}
        {inPts != null && outPts != null && <span className="num mut" style={{ fontSize: 10.5 }}>{r1(inPts)} vs {r1(outPts)}</span>}
        {delta != null && <b className="num" style={{ fontSize: 11, color: better ? "var(--pos)" : "var(--neg)" }}>{delta >= 0 ? "+" : ""}{delta}</b>}
      </span>
    );
  };

  /* The activity feed, fetched the first time the view is opened and again only if the league set or the
     window changes. `txRan` is the same guard pattern the main load uses — see `ranFor` above. */
  useEffect(() => {
    if (view !== "moves" || !connected.length) return;
    const sig = connected.map((l) => `${platOf(l)}:${hubIdOf(l)}`).join(",") + "@" + txWeeks;
    if (txRan.current === sig) return;
    txRan.current = sig;
    let alive = true;
    setTxLoading(true); setTxErr(null);
    /* ⭐⭐⭐⭐⭐ BOTH PLATFORMS NOW — b163. Until this build the feed asked Sleeper only and named the
       Yahoo leagues it was skipping; Trey's own account is mixed, so his feed was genuinely a league
       short every time he opened it. ⚠ TWO CALLS, NOT ONE: the platforms address a league differently
       and answer on different upstreams, so they are fetched separately and merged here.
       ⚠⚠ AND ONE SIDE FAILING MUST NOT EMPTY THE OTHER. `allSettled`, not `all` — an expired Yahoo token
         costing the Sleeper half of the feed would be a new way to show a quietly incomplete list, which
         is the exact fault this change is fixing. Whatever cannot be read is NAMED. */
    const sleeperLgs = connected.filter((l) => platOf(l) !== "yahoo");
    const yahooLgs = connected.filter((l) => platOf(l) === "yahoo" && yahooKeyOf(l));
    /* A Yahoo league with no usable league_key cannot be asked about at all — say which. */
    const noKey = connected.filter((l) => platOf(l) === "yahoo" && !yahooKeyOf(l)).map((l) => l.name);
    if (!sleeperLgs.length && !yahooLgs.length) {
      setTx({ leagues: [], pendingSupported: false, uncovered: noKey }); setTxLoading(false); return;
    }
    Promise.allSettled([
      sleeperLgs.length
        ? api.sleeperTransactions(sleeperLgs.map((l) => hubIdOf(l)), sleeperLgs.map((l) => ownerOf(l)), txWeeks)
        : Promise.resolve(null),
      yahooLgs.length ? api.yahooTransactions(yahooLgs.map((l) => yahooKeyOf(l))) : Promise.resolve(null),
    ]).then(([sRes, yRes]) => {
      if (!alive) return;
      const sOk = sRes.status === "fulfilled" && sRes.value ? sRes.value : null;
      const yOk = yRes.status === "fulfilled" && yRes.value ? yRes.value : null;
      if (!sOk && !yOk) {
        const why = (sRes.reason && sRes.reason.message) || (yRes.reason && yRes.reason.message) || "error";
        setTxErr(String(why)); return;
      }
      /* ⚠ NAMED THE WAY HE NAMED IT. A league that could not be read came back as "nfl.l.99" — a Yahoo
         league key, which is how the API addresses it and not how anybody thinks about it. The name on
         his own league record is the one he will recognise. */
      const nameFor = (id) => (connected.find((c) => String(hubIdOf(c)) === String(id)
        || String(yahooKeyOf(c) || "") === String(id)) || {}).name || id;
      const uncovered = [...noKey];
      if (!sOk && sleeperLgs.length) uncovered.push(...sleeperLgs.map((l) => l.name));
      if (!yOk && yahooLgs.length) uncovered.push(...yahooLgs.map((l) => l.name));
      ((yOk && yOk.leagues) || []).forEach((L) => { if (L.error) uncovered.push(L.leagueName || nameFor(L.leagueId)); });
      const leagues = [...((sOk && sOk.leagues) || []), ...((yOk && yOk.leagues) || []).filter((L) => !L.error)];
      setTx({
        ...(sOk || {}),
        leagues,
        /* ⭐ THE PENDING SENTENCE IS PER PLATFORM NOW. Sleeper cannot show an unresolved offer and Yahoo
           can, so the claim depends on which leagues are actually in this feed — printing Sleeper's
           limitation over a Yahoo league would be a fresh false statement where the old one was fixed. */
        pendingSupported: !!(yOk && yOk.pendingSupported),
        sleeperCovered: !!(sOk && (sOk.leagues || []).length),
        yahooCovered: !!(yOk && (yOk.leagues || []).filter((L) => !L.error).length),
        uncovered,
      });
    }).finally(() => { if (alive) setTxLoading(false); });
    return () => { alive = false; };
  }, [view, connected, txWeeks]);

  /* One flat, newest-first list across every league, because the ask was explicitly an AGGREGATED look.
     The per-league view already exists inside each league's Trades tab. */
  const txItems = useMemo(() => {
    /* ⚠⚠⚠⚠ THE LEAGUE LABEL IS STAMPED FROM THE WRAPPER, and this line is why the Yahoo rows shipped
       blank in the first cut. The row prints `x.leagueName || x.leagueId` — per ITEM — and the Sleeper
       backend happens to set both on every transaction it normalises. The Yahoo parser does not, so
       every Yahoo row rendered with an empty league column: on an AGGREGATED feed across twelve leagues,
       the one thing that tells you which league a move happened in was simply missing, and the rows
       otherwise looked perfect. Stamping here fixes it for both platforms and for any platform added
       later, because it reads the wrapper the merge already has rather than trusting each backend to
       remember. ⚠ The item's own values still WIN where it has them. */
    const named = (l) => (connected.find((c) => String(hubIdOf(c)) === String(l.leagueId)
      || String(yahooKeyOf(c) || "") === String(l.leagueId)) || {}).name || null;
    const all = ((tx && tx.leagues) || []).flatMap((L) => {
      const nm = L.leagueName || named(L) || L.leagueId;
      return (L.items || []).map((x) => ({ ...x, faab: L.faab, budget: L.budget,
        leagueId: x.leagueId || L.leagueId, leagueName: x.leagueName || nm }));
    });
    return all.sort((a, b) => (b.at || 0) - (a.at || 0));
  }, [tx, connected]);
  const txShown = useMemo(() => (txScope === "mine" ? txItems.filter((x) => x.mine) : txItems), [txItems, txScope]);

  /* ⭐⭐⭐⭐⭐ A GRADE ON EVERY TRADE IN THE FEED — 29bm. Trey: "On the 'my week' 'league activity' tab... can
     you show the trade grades next to each trade shown on there." Same recipe as the hub's Recent activity
     (`gradeHubTrade` in App.jsx): each side graded on the rosters just before the deal, with this season's
     results as they stood that week. That needs season-to-date for each trade's week (one request per
     distinct week, only while this view is open) and today's, for the fairness scale. */
  const [txStd, setTxStd] = useState({});
  useEffect(() => {
    if (view !== "moves" || !tx) return;
    const wanted = [...new Set(txItems.filter((x) => x.type === "trade" && x.status === "complete" && x.week).map((x) => String(Number(x.week))))];
    if (week) wanted.push("cur");
    const todo = wanted.filter((k) => !(k in txStd));
    if (!todo.length) return;
    let alive = true;
    todo.forEach((k) => (api.seasonToDate ? api.seasonToDate(k === "cur" ? week : Number(k)) : Promise.resolve(null))
      .then((r) => { if (alive) setTxStd((v) => ({ ...v, [k]: r || null })); })
      .catch(() => { if (alive) setTxStd((v) => ({ ...v, [k]: null })); }));
    return () => { alive = false; };
  }, [view, tx, txItems, week]);
  /* ⭐⭐⭐⭐⭐ 29bo — THE ALTERNATIVES CARD: your own man in the list, and the next three weeks beside this one.
     Trey: "can you highlight where your current player fits... I see +7 for DST, but I don't see my defense in
     there to compare them. It might also be helpful to see the next 3 weeks... particularly important for
     defenses for matchups." Your starter is a row like any other, drawn in gold and labelled, and every row
     carries its next three opponents and projections plus the three-week total, so a good matchup this week
     and a bad month after it cannot hide. */
  const faAltsCard = (L, r) => {
    const weeks = r.weeksNext || [];
    const rowsAll = [r.yours, ...(r.alts || [])].filter(Boolean);
    const three = (x) => { const v = (x.next || []).map((n) => n.pts).filter((n) => n != null); return v.length ? r1(v.reduce((a, b2) => a + b2, 0)) : null; };
    const best3 = Math.max(...rowsAll.map((x) => three(x) || 0));
    const cell = (x, i) => { const n = (x.next || [])[i]; if (!n || n.pts == null) return <span className="mut">—</span>;
      return <span>{n.pts}<span className="mut" style={{ fontSize: 9.5 }}>{n.opp ? ` ${n.opp}` : ""}</span></span>; };
    const cols = [{ k: "Player", w: 150 }, { k: "This week", right: true, strong: true, tint: true },
      ...weeks.map((w2) => ({ k: `Wk ${w2}`, right: true, w: 74 })),
      { k: "Next 3", right: true, strong: true }];
    const rows = rowsAll.map((x) => {
      const t3 = three(x);
      const row = {
        Player: x.mine
          ? <span data-wkaltmine={x.name} style={{ color: "var(--gold)", fontWeight: 800 }}>{x.name} <span style={{ fontSize: 9.5 }}>YOURS</span></span>
          : <span>{x.name}<span className="mut" style={{ fontSize: 9.5 }}>{x.team ? ` ${x.team}` : ""}</span></span>,
        "This week": <span>{x.pts}<span className="mut" style={{ fontSize: 9.5 }}>{x.opp ? ` ${x.opp}` : ""}</span></span>,
        "Next 3": t3 == null ? <span className="mut">—</span>
          : <span style={{ color: t3 >= best3 - 0.01 ? "var(--pos)" : undefined }}>{t3}</span>,
        tone: x.mine ? "var(--gold)" : "var(--pos)",
      };
      weeks.forEach((w2, i) => { row[`Wk ${w2}`] = cell(x, i); });
      return row;
    });
    return { key: `alts:${L.league.id}:${r.inName}`, width: 620, wrap: true, estHeight: 70 + rows.length * 22,
      title: `${r.pos} options next to ${r.yours ? r.yours.name : r.outName}`,
      subtitle: `Week ${L.week || ""} projection first, then the next ${weeks.length || 0} weeks with the opponent`,
      cols, rows,
      note: weeks.length
        ? `Your own player is the gold row. "Next 3" is the sum of those weeks, so a one-week matchup does not read as a season-long upgrade.${/^(K|DEF|DST)$/.test(String(r.pos)) ? " Kickers and defences get one row on the list; the rest are here." : ""}`
        : "The next weeks' projections are not published yet, so this is one week only." };
  };
  const txGrades = useMemo(() => {
    const out = {};
    if (view !== "moves" || !rows) return out;
    txItems.forEach((x) => {
      if (x.type !== "trade" || x.status !== "complete") return;
      const row = rows.find((r) => r.hub && String(hubIdOf(r.league)) === String(x.leagueId));
      if (!row) return;
      const w = Number(x.week) || null;
      if ((w != null && txStd[String(w)] === undefined) || (week && txStd.cur === undefined)) { out[x.id] = { loading: true }; return; }
      try { out[x.id] = gradeHubTrade(row.hub, x, { then: w != null ? txStd[String(w)] : null, std: txStd.cur || null }); } catch (e) { /* ungraded, not broken */ }
    });
    return out;
  }, [view, txItems, rows, txStd, week]);

  const VIEWS = [
    ["summary", "ti-layout-dashboard", "Summary", 0],
    ["avail", "ti-first-aid-kit", "Availability", counts.avail],
    ["lineup", "ti-arrows-exchange", "Lineup changes", counts.lineup],
    ["fa", "ti-user-plus", "Free agents", counts.fa],
    ["weather", "ti-cloud-storm", "Weather", counts.wx],
    /* ⭐⭐⭐ b161 — and it sits AFTER the four things to do before kickoff, for the same reason the weekly
       review is last: this is a record of what has already happened, and a badge on it would compete with
       an injury warning for Sunday-morning attention and win. */
    ["moves", "ti-arrows-shuffle", "League activity", counts.moves],
    /* ⭐⭐⭐ TWO DOORS TO THE SAME ROOM IS ONE DOOR TOO MANY — 29q.
       Trey: "can we just combine the 'Summary' and 'Weekly Review'."
       Inside the in-season shell the review is now a TAB, sitting three centimetres above this chip strip
       and leading to exactly the same component. Offering it twice on one screen is what made the page feel
       like it had two of everything. Standalone — which is still a real route — the chip is the only way
       in, so it stays there.
       ⚠ And it is last and badgeless either way: everything above it is a thing to DO before kickoff, and
         this is the only one about a week you can no longer change. A count here would compete for Sunday
         morning attention and win, which would be exactly wrong. */
    ...(embedded ? [] : [["review", "ti-history", "Weekly review", 0]]),
  ];

  return (
    <div data-screen="myweek" style={{ minHeight: embedded ? 0 : "100vh", background: "var(--bg)" }}>
      {/* Inside the in-season shell the tab strip is the header; this one would stack a second
          title bar on the first. The freshness stamp still matters though, so it moves down into
          the view chips row rather than being lost. See InSeason.jsx. */}
      {!embedded && (
        <div className="hairline appheader" style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 16px", flexWrap: "wrap" }}>
          <button className="btn btn-mini" onClick={onBack || onHome}>← {backLabel || "Home"}</button>
          <div className="disp" style={{ fontSize: 18, fontWeight: 700 }}>My week</div>
          {week && <span className="chip" style={{ borderColor: "var(--line2)" }}>NFL Week {week}</span>}
          <div style={{ flex: 1 }} />
          {/* The freshness stamp is part of the promise: "check this up until the last minute of kickoffs" is
              only trustworthy if the page says how old what you are looking at is. */}
          {refreshedAt && <span data-wkfresh className="mut" style={{ fontSize: 11 }}>
            <i className="ti ti-refresh" style={{ fontSize: 11, marginRight: 4 }} aria-hidden="true" />
            updated {new Date(refreshedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · re-checks every 5 min
          </span>}
          <span className="mut" style={{ fontSize: 11.5 }}>{connected.length} connected league{connected.length === 1 ? "" : "s"}</span>
        </div>
      )}

      <div style={{ maxWidth: 1120, margin: "0 auto", padding: "16px 20px 60px" }}>
        {/* ⚠ THE FRESHNESS STAMP FOLLOWS THE CHIPS WHEN EMBEDDED. Hiding this screen's own header inside the
            in-season shell took the "updated 10:49 · re-checks every 5 min" line with it — and that line is
            part of the promise: "check this up until the last minute of kickoffs" is only trustworthy if
            the page says how old what you are looking at is. I wrote a comment saying it moved and then did
            not move it; it moves here. */}
        {embedded && refreshedAt && (
          <div data-wkfresh className="mut" style={{ fontSize: 11, marginBottom: 8, display: "flex", gap: 10, flexWrap: "wrap" }}>
            <span>
              <i className="ti ti-refresh" style={{ fontSize: 11, marginRight: 4 }} aria-hidden="true" />
              updated {new Date(refreshedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · re-checks every 5 min
            </span>
            <span>{connected.length} connected league{connected.length === 1 ? "" : "s"}</span>
            {/* ⭐⭐⭐⭐⭐ THE TOGGLE — 29w. Trey: "There are also no 'free agents' showing up for any of my
                leagues in 'my week' — this probably because it's defaulted to week one, but again I want a
                toggle + I want it to default to the next week on Tuesdays."
                Both halves were real. The default is fixed on the server (b143 rolls once every game of the
                week has been played); this is the other half, so a finished week is somewhere you can go
                deliberately rather than somewhere you are stuck. */}
            <WeekStep week={weekSel == null ? week : weekSel} current={autoWeek} busy={loading}
              onPick={setWeekSel} label="NFL Week" />
          </div>
        )}
        <div data-wkviews className="filterchips" style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
          {VIEWS.map(([k, icon, label, n]) => {
            const on = view === k;
            return (
              <button key={k} data-wkview={k} onClick={() => setView(k)} aria-pressed={on}
                style={{ cursor: "pointer", fontFamily: "inherit", display: "inline-flex", alignItems: "center", gap: 6,
                  border: `1px solid ${on ? "var(--gold)" : "var(--line2)"}`, background: on ? "rgba(224,166,60,.10)" : "transparent",
                  color: on ? "var(--gold)" : "var(--ink)", borderRadius: 9, padding: "7px 13px", fontSize: 13, fontWeight: 700 }}>
                <i className={`ti ${icon}`} style={{ fontSize: 14 }} aria-hidden="true" />{label}
                {n > 0 && <span style={{ fontSize: 10.5, fontWeight: 800, background: on ? "var(--gold)" : "var(--panel3)", color: on ? "#151002" : "var(--mut)", borderRadius: 99, padding: "0 6px" }}>{n}</span>}
              </button>
            );
          })}
        </div>

        {loading && <div className="panel" style={{ padding: 22, textAlign: "center" }}>
          <div className="mut" style={{ fontSize: 13 }}>Reading {connected.length} league{connected.length === 1 ? "" : "s"}…</div>
        </div>}
        {err && <div className="panel" style={{ padding: 16, borderColor: "var(--red)" }}><span style={{ color: "var(--red)" }}>{err}</span></div>}

        {!loading && !connected.length && (
          <div className="panel" style={{ padding: 18 }}>
            <div className="disp" style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>Nothing to read yet</div>
            <div className="mut" style={{ fontSize: 13, lineHeight: 1.55 }}>
              This page works from your live rosters, so it needs leagues connected to a platform we can read every
              roster from. Connect Sleeper and every league you are in shows up here.
            </div>
          </div>
        )}

        {/* ===================== SUMMARY ===================== */}
        {/* ⭐⭐⭐ "a summary tab that you could look at by league, or a macro level of things that you need to
            be aware of throughout the week." Two halves in that order: what the week looks like across
            everything, then one line per league so you know which ones to actually open. */}
        {!loading && view === "summary" && !!connected.length && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div className="panel" data-wksummary style={{ padding: "14px 16px" }}>
              <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
                {/* ⭐⭐⭐⭐⭐ THE TILE COUNTS PLAYERS; THE ROWS BELOW COUNT LEAGUES — 29w.
                    Trey: "I'm also confused how it says '3 check before kickoff' but yet there are lots
                    more checks listed (maybe it's the same player for different leagues?)"
                    He is exactly right, and the page never said so. `availRows` groups by PLAYER — Ladd
                    McConkey questionable is ONE man to check however many of your teams he is on — while
                    each league row counts that league's own instances. Both numbers are correct and the
                    pair is nonsense without a unit, which is the same category error as "8-2 across 10
                    leagues" was for the record.
                    So the tile says PLAYERS in its label, and the hover names them with the number of
                    lineups each one is in — which makes 3 players across 7 lineups add up on sight. */}
                {[["Not expected to play", counts.urgent, "var(--neg)", "notplaying"],
                  ["Players to check", counts.check, "var(--gold)", "check"],
                  ["Lineup gains", counts.lineup, "var(--pos)", null], ["Waiver ideas", counts.fa, "var(--info)", null],
                  ["Weather", counts.wx, "var(--info)", null]].map(([lbl, n, tone, kind]) => {
                  /* ⚠ "notplaying", NOT "urgent" — tools/icons-scan.mjs treats any quoted lowercase token
                     that matches a Tabler icon name as an icon in use, and `urgent` is one of them. The
                     literal would have failed the icon gate and, if forced through, shipped a glyph
                     nothing renders. The scanner is deliberately over-broad because missing a REAL icon
                     ships a blank square; the cost is that data keys must dodge the icon namespace. */
                  const who = kind === "notplaying" ? availRows.filter((r) => r.rank >= 4)
                    : kind === "check" ? availRows.filter((r) => r.rank === 3) : null;
                  const lineups = who ? who.reduce((s2, r) => s2 + (r.inLeagues || []).length, 0) : 0;
                  /* ⭐⭐⭐⭐ THE HOVER IS A TABLE NOW — 29ad. Player, what is wrong with him, how many of
                     your lineups he is in, and what he is projected for: four columns, which is what the
                     old newline-separated `title` string was pretending to be. */
                  const tip = who && who.length ? {
                    key: kind,
                    title: `${who.length} player${who.length === 1 ? "" : "s"} across ${lineups} lineup${lineups === 1 ? "" : "s"}`,
                    cols: [{ k: "Player", strong: true }, { k: "Status", tint: true }, { k: "Lineups", right: true }, { k: "Proj", right: true }],
                    rows: who.map((r) => ({
                      Player: r.name,
                      Status: (r.des && r.des.label) || "—",
                      Lineups: (r.inLeagues || []).length,
                      Proj: Number.isFinite(r.proj) ? Math.round(r.proj * 10) / 10 : "—",
                      tone: (r.des && r.des.tone) || "var(--mut)",
                    })),
                    note: lineups !== who.length
                      ? "The tile counts PLAYERS — one questionable man is one man however many of your teams he is on. The league rows below count each league's own instances."
                      : null,
                  } : null;
                  return (
                    <div key={lbl} data-wktile={kind || lbl} data-wktilen={String(n)}
                      data-wktilelineups={who ? String(lineups) : undefined}
                      onMouseEnter={tip ? (e) => showCard(e, tip) : undefined} onMouseLeave={tip ? hideCard : undefined}
                      style={{ minWidth: 118, cursor: tip ? "help" : "default" }}>
                      <div className="num" style={{ fontSize: 26, fontWeight: 800, color: n > 0 ? tone : "var(--mut)", lineHeight: 1.1 }}>{n}</div>
                      <div className="mut" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".04em", fontWeight: 700 }}>{lbl}</div>
                      {/* The reconciliation, stated rather than left as an exercise. */}
                      {who && who.length > 0 && lineups !== who.length && (
                        <div className="mut" style={{ fontSize: 9.5, fontWeight: 600 }}>across {lineups} lineups</div>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="mut" style={{ fontSize: 12.5, marginTop: 11, lineHeight: 1.5 }}>
                {counts.urgent > 0
                  ? <>Start here: <b style={{ color: "var(--neg)" }}>{counts.urgent} player{counts.urgent === 1 ? "" : "s"} you are starting {counts.urgent === 1 ? "is" : "are"} not expected to play.</b></>
                  : counts.check > 0
                    ? <>Nothing is ruled out, but <b style={{ color: "var(--gold)" }}>{counts.check}</b> of your starters {counts.check === 1 ? "is" : "are"} a game-time call — worth another look before kickoff.</>
                    : <>No availability problems anywhere. {counts.lineup > 0 ? `${counts.lineup} lineup${counts.lineup === 1 ? "" : "s"} could still score more.` : "Your lineups are set."}</>}
              </div>
            </div>

            {/* ⭐⭐⭐⭐⭐ THE SUMMARY IS THE HOME TABLE NOW — 29ae.
                Trey: "Can you actually make the summary on the 'my week' also a bit more detailed with
                projections and such. Similar to the home page."
                ⭐ AND "SIMILAR TO" IS THE SPECIFICATION, NOT A HINT. These two tables answer the same
                  question about the same week — the home strip is the glance and this is the screen you
                  open when the glance says something needs doing — so any column that exists on one and
                  not the other is a thing he has to go and look up in the other place. Same columns, same
                  order, same alignment, same hover cards; what differs is that this one sits above the
                  four detail tabs the home strip links out to.
                ⚠ THE COLUMN WIDTHS ARE SHARED WITH THE HEADER by a single constant, because a header that
                  drifts from its body is worse than no header — it mislabels rather than fails. */}
            <div className="panel" style={{ padding: 6 }}>
              {wide && (
                <div className="mut" style={{ display: "grid", gap: 10, padding: "4px 10px 6px",
                  gridTemplateColumns: SUM_COLS, fontSize: 9, textTransform: "uppercase",
                  letterSpacing: ".05em", fontWeight: 800 }}>
                  <span>League</span>
                  <span>Opponent</span>
                  <span style={{ textAlign: "right" }}>Projected</span>
                  <span style={{ textAlign: "right" }}>vs median</span>
                  <span>To sort out</span>
                </div>
              )}
              {perLeague.map((L) => {
                if (!L) return null;
                const urgent = (L.avail || []).filter((r) => r.rank >= 4).length;
                const check = (L.avail || []).filter((r) => r.rank === 3).length;
                const gain = (L.swaps || []).reduce((s, x) => s + x.gain, 0);
                const tone = L.error ? "var(--mut)" : urgent ? "var(--neg)" : check ? "var(--gold)" : "var(--pos)";
                const m = (L.hub && L.hub.matchup) || null;
                const meProj = m && m.meProj ? m.meProj.pts : null;
                const oppProj = m && m.oppProj ? m.oppProj.pts : null;
                const oppName = (m && m.opp && m.opp.teamName) || null;
                const medProj = L.hub && Number.isFinite(L.hub.medianProjected) ? L.hub.medianProjected : null;
                return (
                  <div key={L.league.id} data-wksumrow={L.league.name}
                    style={{ display: "grid", alignItems: "center", gap: wide ? 10 : 5,
                      gridTemplateColumns: wide ? SUM_COLS : "minmax(0,1fr)",
                      padding: "8px 10px", borderTop: "1px solid var(--line)" }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 99, background: tone, flexShrink: 0 }} aria-hidden="true" />
                      <button onClick={() => onUmbrella && onUmbrella(L.league.id)}
                        style={{ cursor: "pointer", fontFamily: "inherit", background: "none", border: "none", color: "var(--ink)", fontSize: 13.5, fontWeight: 700, padding: 0, textAlign: "left", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {L.league.name}
                      </button>
                    </span>
                    <span className="mut" data-wksumopp={oppName || ""} style={{ fontSize: 11.5, minWidth: 0,
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {oppName || (L.error ? "—" : "no opponent set")}
                    </span>
                    {/* The projected scoreline, coloured by which way it is going — the same read the home
                        strip gives, from the same two fields on the same payload. */}
                    <span className="num" data-wksumproj={Number.isFinite(meProj) ? String(meProj) : ""}
                      style={{ fontSize: 12, textAlign: wide ? "right" : "left" }}>
                      {Number.isFinite(meProj) ? (
                        <>
                          <b style={{ color: Number.isFinite(oppProj) ? (meProj >= oppProj ? "var(--pos)" : "var(--neg)") : "var(--ink)" }}>{meProj}</b>
                          {Number.isFinite(oppProj) && <span className="mut"> – {oppProj}</span>}
                        </>
                      ) : <span className="mut">—</span>}
                    </span>
                    {/* ⚠ BLANK WHERE THE LEAGUE DOES NOT PLAY MEDIAN SCORING. A dash in every row would
                        imply the column applies everywhere and merely has no value here. */}
                    <span className="num" data-wksummedian={medProj != null ? String(medProj) : ""}
                      style={{ fontSize: 11.5, textAlign: wide ? "right" : "left" }}>
                      {medProj != null && Number.isFinite(meProj) ? (
                        <span style={{ color: meProj >= medProj ? "var(--pos)" : "var(--neg)" }}>
                          {meProj >= medProj ? "+" : ""}{r1(meProj - medProj)}
                          <span className="mut" style={{ fontSize: 10 }}> vs {medProj}</span>
                        </span>
                      ) : <span className="mut" style={{ fontSize: 10.5 }}>{medProj != null ? "—" : ""}</span>}
                    </span>
                    <span className="mut" style={{ fontSize: 11.5, minWidth: 0 }}>
                      {/* ⭐⭐⭐ A LEAGUE WE CANNOT PLACE YOU IN GETS AN INSTRUCTION, NOT A SHRUG. There is
                          exactly one reason this happens and exactly one fix, so print both — and print the
                          username the league was imported under when we have it, because "link the account
                          that owns this" is not actionable if you have four of them. */}
                      {L.needsAccount ? (
                        <span data-wkneedsaccount={typeof L.needsAccount === "string" ? L.needsAccount : "1"} style={{ color: "var(--gold)" }}>
                          Can't tell which team is yours — link the Sleeper account
                          {typeof L.needsAccount === "string" ? <> <b>{L.needsAccount}</b></> : null} under Settings
                        </span>
                      ) : L.error ? <span style={{ color: "var(--red)" }}>Couldn't read this league</span>
                        /* ⭐⭐⭐⭐ "when you hover that, can you show the details of what that means" — 29w.
                           The row said how MANY without ever saying WHO, so the only way to act on it was
                           to open the league and go looking. The names, their designations and what each
                           one is projected for are all already on the row's own data. */
                        /* ⚠⚠ THESE ARE THE SPANS TREY ACTUALLY POINTED AT. "when you hover on '2 to check
                           before kickoff'" is THIS row, not the tile above it that happens to count the
                           same thing — my first cut converted the tile and left the row on the native
                           `title`, which would have shipped a change he could not see at the place he
                           asked for it. Both row details are cards now; the tile keeps its own. */
                        : urgent ? <span data-wkrowdetail="notplaying" style={{ color: "var(--neg)", cursor: "help" }}
                            onMouseEnter={(e) => showCard(e, rowCard(L, "notplaying"))} onMouseLeave={hideCard}>
                            {urgent} not expected to play</span>
                        : check ? <span data-wkrowdetail="check" style={{ color: "var(--gold)", cursor: "help" }}
                            onMouseEnter={(e) => showCard(e, rowCard(L, "check"))} onMouseLeave={hideCard}>
                            {check} to check before kickoff</span>
                        : "No availability problems"}
                      {/* ⭐⭐⭐⭐⭐ "when you hover on '2.3 available from your bench' it shows who you are
                          replacing for who." The number was the CONCLUSION with the reasoning withheld —
                          and the reasoning is the actionable part, because you cannot make a swap you
                          cannot name. Slot, who comes out, who goes in, what it gains. */}
                      {gain > 0 ? (
                        <span data-wkrowdetail="bench" style={{ color: "var(--pos)", cursor: "help" }}
                          onMouseEnter={(e) => showCard(e, {
                            key: "bench",
                            title: `${L.league.name} — ${(L.swaps || []).length} change${(L.swaps || []).length === 1 ? "" : "s"} worth +${r1(gain)}`,
                            cols: [{ k: "Slot" }, { k: "Out", strong: true }, { k: "In", strong: true }, { k: "Gain", right: true }],
                            rows: (L.swaps || []).map((x) => ({
                              Slot: x.pos, Out: `${x.out} (${r1(x.outPts)})`, In: `${x.in} (${r1(x.inPts)})`, Gain: `+${r1(x.gain)}`,
                            })),
                            note: "Projected points only — a swap you would not make for other reasons is still listed, because the page does not know your reasons.",
                          })}
                          onMouseLeave={hideCard}> · +{r1(gain)} available from your bench</span>
                      ) : null}
                      {(L.fa || []).length ? <span> · {(L.fa || []).length} waiver idea{(L.fa || []).length === 1 ? "" : "s"}</span> : null}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ===================== AVAILABILITY ===================== */}
        {!loading && view === "avail" && !!connected.length && (
          availSorted.length === 0 ? (
            <div className="panel" data-wkempty="avail" style={{ padding: 18 }}>
              <div className="disp" style={{ fontSize: 16, fontWeight: 700, color: "var(--pos)", marginBottom: 4 }}>Nobody to worry about</div>
              <div className="mut" style={{ fontSize: 13 }}>No injury designation on anyone you roster, across all {connected.length} leagues.</div>
            </div>
          ) : (
            <>
              <div data-wksorts style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 11 }}>
                <span className="mut" style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".05em", fontWeight: 800 }}>Sort by</span>
                {[["impact", "Impact"], ["designation", "Injury status"], ["leagues", "How many leagues"], ["league", "By league"]].map(([k, lbl]) => (
                  <button key={k} data-wksort={k} onClick={() => setSortBy(k)} aria-pressed={sortBy === k}
                    style={{ cursor: "pointer", fontFamily: "inherit", border: `1px solid ${sortBy === k ? "var(--gold)" : "var(--line2)"}`,
                      background: sortBy === k ? "rgba(224,166,60,.10)" : "transparent", color: sortBy === k ? "var(--gold)" : "var(--mut)",
                      borderRadius: 99, padding: "4px 11px", fontSize: 11.5, fontWeight: 700 }}>{lbl}</button>
                ))}
              </div>
              {sortBy === "league"
                ? <ByLeague perLeague={perLeague} swapLine={swapLine} onUmbrella={onUmbrella} />
                : <FlatList rows={availSorted} sortBy={sortBy} leagueTag={leagueTag} swapLine={swapLine} />}
            </>
          )
        )}

        {/* ===================== LINEUP CHANGES ===================== */}
        {!loading && view === "lineup" && !!connected.length && (
          counts.lineup === 0 ? (
            <div className="panel" data-wkempty="lineup" style={{ padding: 18 }}>
              <div className="disp" style={{ fontSize: 16, fontWeight: 700, color: "var(--pos)", marginBottom: 4 }}>Your lineups are already the best you have</div>
              <div className="mut" style={{ fontSize: 13 }}>No bench player projects more than the starter in front of him at the same position, in any league.</div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {perLeague.filter((L) => L && (L.swaps || []).length).map((L) => (
                <div key={L.league.id}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 5 }}>
                    <span className="disp" style={{ fontSize: 14, fontWeight: 800 }}>{L.league.name}</span>
                    <span className="mut" style={{ fontSize: 11.5 }}>+{r1(L.swaps.reduce((s, x) => s + x.gain, 0))} projected</span>
                  </div>
                  <div className="panel" style={{ padding: 6 }}>
                    {L.swaps.map((sw) => (
                      <div key={sw.sid} data-wklineup={sw.in} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderTop: "1px solid var(--line)", flexWrap: "wrap" }}>
                        <span style={{ flexShrink: 0 }}><Dot pos={sw.pos} /></span>
                        <div style={{ flex: "1 1 320px", minWidth: 0, fontSize: 13 }}>
                          <span className="mut">Bench</span> <b>{sw.out}</b> <span className="num mut" style={{ fontSize: 11 }}>{r1(sw.outPts)}</span>
                          {" "}<span className="mut">for</span> <b style={{ color: "var(--pos)" }}>{sw.in}</b> <span className="num mut" style={{ fontSize: 11 }}>{r1(sw.inPts)}</span>
                        </div>
                        <b className="num" style={{ fontSize: 12.5, color: "var(--pos)", flexShrink: 0 }}>+{sw.gain}</b>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )
        )}

        {/* ===================== FREE AGENTS ===================== */}
        {!loading && view === "fa" && !!connected.length && (
          <>
            {counts.fa === 0 ? (
              /* ⭐⭐⭐⭐ AN EMPTY LIST HAS TO SAY WHICH KIND OF EMPTY IT IS. Trey read "nothing worth a claim"
                 across twelve leagues and correctly refused to believe it — and he was right, the pool was
                 broken. So this now prints the size of the pool it searched. A real all-clear says it looked
                 at four hundred available players; a broken one says it looked at nine, and that number is
                 the bug report. */
              <div className="panel" data-wkempty="fa" style={{ padding: 18 }}>
                <div className="disp" style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Nothing worth a claim</div>
                <div className="mut" style={{ fontSize: 13, lineHeight: 1.5 }}>
                  No bye holes, no available player who beats one of your starters, and no thin spot worth streaming.
                  {perLeague.some((L) => L && L.hub && !L.projKnown) && <> ⚠ At least one league has no weekly projections
                    from Sleeper yet, so there is nothing to compare there — that is a data gap, not an all-clear.</>}
                  {perLeague.some((L) => L && L.hub && !L.byeKnown) && <> ⚠ The NFL schedule has not been loaded for this
                    season, so bye weeks are being read from player records rather than from the schedule and may be
                    incomplete.</>}
                </div>
                <div className="mut num" data-wkfapool={String(perLeague.reduce((s, L) => s + ((L && L.poolSize) || 0), 0))}
                  style={{ fontSize: 11, marginTop: 8 }}>
                  Searched {perLeague.reduce((s, L) => s + ((L && L.poolSize) || 0), 0).toLocaleString()} available
                  players across {perLeague.filter((L) => L && L.hub).length} leagues.
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {perLeague.filter((L) => L && (L.fa || []).length).map((L) => (
                  <div key={L.league.id}>
                    <div className="disp" style={{ fontSize: 14, fontWeight: 800, marginBottom: 5 }}>{L.league.name}</div>
                    <div className="panel" style={{ padding: 6 }}>
                      {L.fa.map((r, i) => (
                        <div key={i} data-wkfarow={r.inName} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderTop: "1px solid var(--line)", flexWrap: "wrap" }}>
                          <span data-wkfakind={r.kind}
                            onMouseEnter={r.alts && r.alts.length ? (e) => showCard(e, faAltsCard(L, r)) : undefined}
                            onMouseLeave={r.alts && r.alts.length ? hideCard : undefined}
                            style={{ flexShrink: 0, fontSize: 9.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".04em",
                            border: `1px solid ${FA_KIND[r.kind].tone}`, color: FA_KIND[r.kind].tone, cursor: r.alts && r.alts.length ? "help" : undefined,
                            borderRadius: 99, padding: "2px 8px" }}>{FA_KIND[r.kind].label}{r.alts && r.alts.length > 1 ? ` +${r.alts.length - 1}` : ""}</span>
                          <div style={{ flex: "1 1 300px", minWidth: 0 }}>
                            <div style={{ fontSize: 13.5, fontWeight: 700 }}>
                              Add <span style={{ color: "var(--pos)" }}>{r.inName}</span>
                              <span className="mut" style={{ fontSize: 10.5, fontWeight: 400 }}> {r.pos}{r.inTeam ? ` · ${r.inTeam}` : ""}</span>
                            </div>
                            <div className="mut" style={{ fontSize: 11.5, marginTop: 2 }}>{r.why}</div>
                            {(r.startOver || r.benchOver) && (
                              <div data-wkfacompare style={{ fontSize: 11, marginTop: 3, display: "flex", gap: 12, flexWrap: "wrap" }}>
                                {r.benchOver && (
                                  <span data-wkfabench={r.benchOver.name}><span className="mut">Better than </span><b>{r.benchOver.name}</b>
                                    <span className="num mut"> {r.benchOver.pts} (your best backup)</span>
                                    <span className="num" style={{ color: "var(--pos)", fontWeight: 700 }}> (+{r1(r.inPts - r.benchOver.pts)})</span></span>
                                )}
                                {r.startOver && (
                                  <span data-wkfastart={r.startOver.name}><span className="mut">{r.kind === "depth" ? "Your lineup " + r.pos + " " : r.kind === "hole" ? "Instead of " : "Starts over "}</span><b>{r.startOver.name}</b> <span className="num mut">{r.startOver.pts}</span>
                                    <span className="num" style={{ color: r.inPts - r.startOver.pts >= 0 ? "var(--pos)" : "var(--mut)", fontWeight: 700 }}> ({r.inPts - r.startOver.pts >= 0 ? "+" : ""}{r1(r.inPts - r.startOver.pts)})</span></span>
                                )}
                                {r.release && (
                                  <span data-wkfarelease={r.release.name}><span className="mut">Release </span><b>{r.release.name}</b>
                                    <span className="num mut"> {r.release.pos} · {r.release.pts != null ? `${r1(r.release.pts)} this week` : "no projection"}{r.release.adp ? ` · ADP ${r.release.adp}` : " · undrafted"}</span>
                                    {r.release.pts != null && <span className="num" style={{ color: "var(--pos)", fontWeight: 700 }}> (+{r1(r.inPts - r.release.pts)})</span>}</span>
                                )}
                              </div>
                            )}
                          </div>
                          <span className="num" style={{ fontSize: 12, fontWeight: 800, color: "var(--pos)", flexShrink: 0 }}>+{r.gain}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="mut" style={{ fontSize: 11, lineHeight: 1.5, marginTop: 10 }}>
              Five kinds of claim: a starter who is out (or a slot with nobody in it), a slot left empty by a bye this
              week, a bye coming next week you can cover while the wire is still worth picking over, and a position
              upgrade, which is any starter a free agent outprojects this week, kickers and defences included. Each
              upgrade names the starter he would replace and the bench player you would release (never an IR man). A
              "Bench upgrade" is the other half of the same read: he does not beat your starter, but he beats your
              best backup at that position and is close enough to the lineup to matter, which is your injury and
              bye cover.
              Hover a Pos upgrade chip for the other free agents who would also beat your starter. Byes come from the
              NFL schedule.
            </div>
          </>
        )}

        {/* ===================== WEATHER ===================== */}
        {!loading && view === "weather" && !!connected.length && (
          <>
            {!weather ? <div className="panel" style={{ padding: 16 }}><span className="mut" style={{ fontSize: 13 }}>Reading the forecast…</span></div>
              : weather.unavailable ? (
                <div className="panel" data-wkempty="weather" style={{ padding: 18 }}>
                  <div className="disp" style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>No forecast yet</div>
                  <div className="mut" style={{ fontSize: 13, lineHeight: 1.5 }}>{weather.note || "The NFL schedule hasn't loaded yet."}</div>
                </div>
              ) : wxRows.length === 0 ? (
                <div className="panel" data-wkempty="weather" style={{ padding: 18 }}>
                  <div className="disp" style={{ fontSize: 16, fontWeight: 700, color: "var(--pos)", marginBottom: 4 }}>Nothing to play around</div>
                  <div className="mut" style={{ fontSize: 13, lineHeight: 1.55 }}>
                    Nobody you are starting is in a game with weather worth planning around
                    {weather.counts ? <> — {weather.counts.indoors} of this week's games are indoors, and the rest are forecast clear enough not to matter.</> : "."}
                  </div>
                </div>
              ) : (
                <div className="panel" style={{ padding: 6 }}>
                  {wxGames.map((G) => {
                    const sev = G.game.severity;
                    const tone = sev >= 3 ? "var(--neg)" : sev === 2 ? "var(--gold)" : "var(--info)";
                    return (
                      <div key={G.key} data-wkwxgame={G.key} data-wkwxsev={sev}
                        style={{ padding: "10px 10px 11px", borderTop: "1px solid var(--line)" }}>
                        {/* THE GAME, SAID ONCE. */}
                        <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
                          <span style={{ flexShrink: 0, fontSize: 9.5, fontWeight: 800, textTransform: "uppercase",
                            letterSpacing: ".04em", border: `1px solid ${tone}`, color: tone,
                            borderRadius: 99, padding: "2px 8px" }}>{G.game.label}</span>
                          <span className="disp" style={{ fontSize: 14.5, fontWeight: 800 }}>
                            {G.game.away} @ {G.game.home}
                          </span>
                          <span className="mut" style={{ fontSize: 11 }}>
                            {new Date(G.game.kickoff).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}
                          </span>
                          <span style={{ flex: 1 }} />
                          <span className="mut" style={{ fontSize: 10.5, fontWeight: 700 }}>
                            {G.players.length} starter{G.players.length === 1 ? "" : "s"} · {G.lineups} lineup{G.lineups === 1 ? "" : "s"}
                          </span>
                        </div>
                        <div className="mut" style={{ fontSize: 11.5, marginTop: 4 }}>{G.game.text}</div>
                        {/* THE PLAYERS, UNDERNEATH — each with the leagues he is starting in, which is the
                            part that decides whether this storm is a problem for you or a curiosity. */}
                        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 7 }}>
                          {G.players.map((r) => (
                            <div key={r.key} data-wkwxrow={r.name}
                              style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", paddingLeft: 2 }}>
                              <Dot pos={r.pos} />
                              <span style={{ fontSize: 12.5, fontWeight: 700 }}>{r.name}</span>
                              <span className="mut" style={{ fontSize: 10.5 }}>{r.pos} · {r.team}</span>
                              <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
                                {r.inLeagues.map((l) => leagueTag(l))}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            {weather && weather.counts && (
              <div className="mut" style={{ fontSize: 11, marginTop: 10, lineHeight: 1.5 }}>
                Week {weather.week}: {weather.counts.games} games · {weather.counts.indoors} indoors (never flagged) ·
                {" "}{weather.counts.checked} forecast · {weather.counts.flagged} with conditions worth knowing.
                Any stadium with a roof is excluded outright; sun and light rain are not listed.
              </div>
            )}
          </>
        )}

        {/* ===================== LEAGUE ACTIVITY =====================
            ⭐⭐⭐⭐⭐ b161. Trey: "trades that are currently pending, aka someone has sent me a trade or I
            have sent them a trade... just see an aggregated list of connected leagues... And then you can
            look at another section that says like recently rejected or recently accepted trades. I want
            that to be only ones that I show, but I also want to be able to toggle to show the entire
            league on trades that have been accepted recently."

            ⚠⚠⚠⚠ THE FIRST THING THIS VIEW DOES IS ADMIT WHAT IT CANNOT DO. Sleeper publishes transactions
              once they RESOLVE: there is no pending offer to read, and a declined trade leaves no record
              at all — it is indistinguishable from a trade nobody ever sent. Every other build of this
              feature I can imagine ships a "Pending" section that is always empty, which tells the reader
              something false about his league rather than something true about the API. One sentence, at
              the top, once. (See api/.../lib/transactions.js for the evidence.)
            ⚠ AND THE TOGGLE DEFAULTS TO MINE, which is his order of asking: "I want that to be only ones
              that I show, but I also want to be able to toggle". */}
        {!loading && view === "moves" && !!connected.length && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {txLoading && !tx && (
              <div className="panel" style={{ padding: 22, textAlign: "center" }}>
                <div className="mut" style={{ fontSize: 13 }}>Reading the last {txWeeks} weeks across {connected.length} league{connected.length === 1 ? "" : "s"}…</div>
              </div>
            )}
            {txErr && <div className="panel" style={{ padding: 16, borderColor: "var(--red)" }}><span style={{ color: "var(--red)" }}>{txErr}</span></div>}
            {tx && (
              <>
                <div className="panel" data-wkmoves={String(txItems.length)} style={{ padding: "14px 16px" }}>
                  <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginBottom: 10 }}>
                    {[["Trades", (tx.leagues || []).reduce((n, L) => n + (L.trends ? L.trends.totals.trades : 0), 0), "var(--gold)"],
                      ["Waiver claims", (tx.leagues || []).reduce((n, L) => n + (L.trends ? L.trends.totals.waivers : 0), 0), "var(--ink)"],
                      ["Free agents", (tx.leagues || []).reduce((n, L) => n + (L.trends ? L.trends.totals.freeAgents : 0), 0), "var(--ink)"],
                      ["Claims that failed", (tx.leagues || []).reduce((n, L) => n + (L.trends ? L.trends.totals.failed : 0), 0), "var(--neg)"]]
                      .map(([label, n, tone]) => (
                      <div key={label} data-wkmovestat={`${label}:${n}`}>
                        <div className="num" style={{ fontSize: 22, fontWeight: 800, color: tone, lineHeight: 1.1 }}>{n}</div>
                        <div className="mut" style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".05em" }}>{label}</div>
                      </div>
                    ))}
                    {(tx.leagues || []).some((L) => L.faab) && (
                      <div data-wkmovesfaab>
                        <div className="num" style={{ fontSize: 22, fontWeight: 800, color: "var(--pos)", lineHeight: 1.1 }}>
                          ${(tx.leagues || []).reduce((n, L) => n + (L.trends ? L.trends.totals.faabSpent : 0), 0)}
                        </div>
                        <div className="mut" style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".05em" }}>FAAB spent</div>
                      </div>
                    )}
                  </div>
                  {/* THE HONEST SENTENCE. */}
                  {/* ⚠ AND IT NAMES THE RIGHT PLATFORM. A Yahoo-only account was being told what SLEEPER
                      does and does not publish, which is a true sentence about the wrong service and
                      reads as though we had looked. */}
                  <div data-wkmovesnote className="mut" style={{ fontSize: 11.5, lineHeight: 1.55, paddingTop: 10, borderTop: "1px solid var(--line)" }}>
                    {/* ⭐⭐⭐⭐⭐ THE SENTENCE IS PER PLATFORM NOW — b163, and it has to be, because the two
                        platforms differ on exactly the thing Trey asked for first. Sleeper publishes a
                        transaction only once it has resolved; Yahoo carries offers still waiting on a
                        decision and ones that were turned down. A single sentence over a mixed feed is
                        false whichever way it is written, so it says what is true OF THE LEAGUES IN THIS
                        FEED — which is why the flags travel on the payload rather than being decided here. */}
                    {tx.yahooCovered && !tx.sleeperCovered ? (
                      <><b style={{ color: "var(--ink)" }}>Pending offers are included.</b> Yahoo publishes trades that
                      are still waiting on a decision, and ones that were turned down — so an offer sitting in your
                      inbox shows up below, marked as waiting.</>
                    ) : tx.yahooCovered && tx.sleeperCovered ? (
                      <><b style={{ color: "var(--ink)" }}>Pending offers show for your Yahoo leagues only.</b> Yahoo
                      publishes trades still waiting on a decision; Sleeper publishes a transaction only once it has
                      gone through, so an offer in a Sleeper league leaves no record we can read. Anything below from
                      a Sleeper league has already happened.</>
                    ) : (
                      <><b style={{ color: "var(--ink)" }}>Pending offers are not available.</b> Sleeper only publishes a
                      transaction once it has gone through, so an offer sitting in your inbox — and a trade somebody
                      turned down — leave no record we can read. Everything below has already happened. Check Sleeper
                      itself for anything still waiting on a yes.</>
                    )}
                  </div>
                  {/* ⚠ STILL NAMED, BUT FOR A DIFFERENT REASON. This used to say "Yahoo publishes no
                      transaction feed", which is no longer true. A league lands here now only when the
                      call for it actually failed — an expired token, a league key we never got — and a
                      quietly incomplete list is still worse than an empty one. */}
                  {(tx.uncovered || []).length > 0 && (
                    <div data-wkmovesuncovered={String((tx.uncovered || []).length)} className="mut"
                      style={{ fontSize: 11.5, lineHeight: 1.55, marginTop: 7 }}>
                      <b style={{ color: "var(--gold)" }}>Not included:</b>{" "}
                      {tx.uncovered.join(", ")} — we couldn't read activity for {(tx.uncovered || []).length === 1 ? "that league" : "those leagues"} just
                      now, so {(tx.uncovered || []).length === 1 ? "it is" : "they are"} missing from everything above. Every other in-season screen still works on {(tx.uncovered || []).length === 1 ? "it" : "them"}.
                    </div>
                  )}
                </div>

                {/* ⭐⭐⭐⭐ WHERE YOU SIT, LEAGUE BY LEAGUE — b161. The aggregated totals above answer "what
                    has been happening"; this answers "am I the one it is happening to". Across twelve
                    leagues the useful read is not how many moves you made, it is which leagues you have
                    gone quiet in — and that is a per-league fact that an aggregate cannot carry.
                    ⚠ ONLY LEAGUES WHERE THE STANDING EXISTS. `myRank` is null when there is nobody to
                      compare against, and a rank of 1 out of 1 is not a finding. */}
                {(tx.leagues || []).some((L) => L.trends && L.trends.myRank) && (
                  <div className="panel" data-wkmovesrank style={{ padding: "11px 14px" }}>
                    <div className="disp" style={{ fontSize: 13.5, fontWeight: 800, marginBottom: 7 }}>
                      How active you are <span className="mut" style={{ fontSize: 10.5, fontWeight: 500 }}>· by league, over the window</span>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: "4px 16px" }}>
                      {(tx.leagues || []).filter((L) => L.trends && L.trends.myRank).map((L) => {
                        const r = L.trends.myRank, n = L.trends.teams;
                        const me = L.trends.mine || { trades: 0, waivers: 0, freeAgents: 0 };
                        const moves = me.trades + me.waivers + me.freeAgents;
                        /* Quiet is the finding, so it gets the colour. Busy is just busy. */
                        const quiet = r > Math.ceil(n * 0.66);
                        return (
                          <div key={L.leagueId} data-wkmovesrankrow={`${L.leagueId}:${r}/${n}`}
                            style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, fontSize: 12, padding: "1px 0" }}>
                            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{L.leagueName || L.leagueId}</span>
                            <span style={{ flexShrink: 0 }}>
                              <b className="num" style={{ color: quiet ? "var(--gold)" : "var(--ink)" }}>{ordinalOf(r)}</b>
                              <span className="mut"> of {n}</span>
                              <span className="mut num" style={{ fontSize: 10.5 }}> · {moves} move{moves === 1 ? "" : "s"}</span>
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  {[["mine", "Mine"], ["all", "Everyone"]].map(([k, l]) => (
                    <button key={k} data-wkmovescope={k} aria-pressed={txScope === k} onClick={() => setTxScope(k)}
                      style={{ cursor: "pointer", fontFamily: "inherit", fontSize: 12.5, fontWeight: txScope === k ? 800 : 600,
                        padding: "6px 13px", borderRadius: 9,
                        border: `1px solid ${txScope === k ? "var(--gold)" : "var(--line2)"}`,
                        background: txScope === k ? "rgba(224,166,60,.10)" : "transparent",
                        color: txScope === k ? "var(--gold)" : "var(--ink)" }}>{l}</button>
                  ))}
                  <div style={{ flex: 1 }} />
                  <span className="mut" style={{ fontSize: 11 }}>Window</span>
                  {[2, 4, 8].map((w) => (
                    <button key={w} data-wkmoveswindow={String(w)} aria-pressed={txWeeks === w} onClick={() => setTxWeeks(w)}
                      className="btn btn-mini" style={{ borderColor: txWeeks === w ? "var(--gold)" : "var(--line)",
                        color: txWeeks === w ? "var(--gold)" : "var(--mut)" }}>{w} wk</button>
                  ))}
                </div>

                {!txShown.length && (
                  <div className="panel" data-wkmovesempty style={{ padding: 18 }}>
                    <div className="mut" style={{ fontSize: 13, lineHeight: 1.55 }}>
                      {(tx.uncovered || []).length && !(tx.leagues || []).length
                        ? <span data-wkmovesuncovered={String((tx.uncovered || []).length)}>
                          We couldn't read activity for {(tx.uncovered || []).join(", ")} just now, so there is
                          nothing to aggregate here. Everything else in the in-season screens still works on
                          {(tx.uncovered || []).length === 1 ? " it" : " them"}.</span>
                        : txScope === "mine"
                        ? <>You have not made a move in the last {txWeeks} weeks in any connected league. Switch to
                          <b style={{ color: "var(--ink)" }}> Everyone</b> to see what the rest of your leagues have been doing.</>
                          : <>Nothing has happened in any of your leagues in the last {txWeeks} weeks. Try a longer window.</>}
                    </div>
                  </div>
                )}

                {["trade", "waiver", "free_agent"].map((kind) => {
                  const rows = txShown.filter((x) => x.type === kind);
                  if (!rows.length) return null;
                  const title = kind === "trade" ? "Trades" : kind === "waiver" ? "Waiver claims" : "Free-agent adds";
                  return (
                    <div key={kind} className="panel" data-wkmovesgroup={`${kind}:${rows.length}`} style={{ padding: "12px 14px" }}>
                      <div className="disp" style={{ fontSize: 14, fontWeight: 800, marginBottom: 8 }}>
                        {title} <span className="mut" style={{ fontSize: 11, fontWeight: 500 }}>· {rows.length}</span>
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                        {rows.slice(0, 40).map((x) => (
                          <div key={x.id} data-wkmove={`${x.type}:${x.status}`} data-wkmovemine={x.mine ? "1" : "0"}
                            /* The league a row belongs to, and whether that league has bidding at all —
                               so a check can tell "no bid shown" from "no bidding in this league". */
                            data-wkmoveleague={x.leagueId || ""} data-wkmovefaab={x.faab ? "1" : "0"}
                            style={{ display: "flex", gap: 10, alignItems: "flex-start", paddingBottom: 9,
                              borderBottom: "1px solid var(--line)", opacity: x.status === "failed" ? .8 : 1 }}>
                            <span className="mut" style={{ flexShrink: 0, fontSize: 10.5, width: 96, paddingTop: 2 }}>
                              {x.leagueName || x.leagueId}
                            </span>
                            <div style={{ flex: 1, minWidth: 0, fontSize: 12.5, lineHeight: 1.6 }}>
                              {x.teams.map((t, i) => (
                                <div key={t.rosterId} data-wkmoveside={`${t.rosterId}`}
                                  style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "baseline" }}>
                                  <b style={{ color: t.isMe ? "var(--gold)" : "var(--ink)" }}>{t.isMe ? "You" : t.teamName}</b>
                                  {kind === "trade" && (() => {
                                    const G = txGrades[x.id];
                                    const g = G && !G.loading && !G.multi ? G[t.rosterId] : null;
                                    if (G && G.loading) return <span className="mut" data-wkmovegrade="loading" style={{ fontSize: 10.5 }}>grading…</span>;
                                    if (!g) return null;
                                    const tone = GRADE_TONE(g.letter);
                                    return (
                                      <span data-wkmovegrade={`${t.rosterId}:${g.letter}`}
                                        title={`${(g.why || []).join(", ")}${g.perWeek != null ? `. ${g.perWeek >= 0 ? "+" : ""}${Number(g.perWeek).toFixed(1)} a week for ${t.isMe ? "you" : t.teamName}` : ""}`}
                                        style={{ fontSize: 11.5, fontWeight: 800, color: tone, border: `1px solid ${tone}`, borderRadius: 6, padding: "0 5px", cursor: "help", alignSelf: "center", lineHeight: 1.45 }}>
                                        {g.letter.replace("-", "\u2212")}
                                      </span>
                                    );
                                  })()}
                                  {/* ⚠ "GETS" AND "SENDS", NOT "ADDS" AND "DROPS". On a trade row `drops` means
                                      "gave up in the deal" — printing it as a cut would say both managers
                                      released their best players. See lib/transactions.js. */}
                                  {t.got.length > 0 && (
                                    <span><span className="mut">{kind === "trade" ? "gets" : "add"}</span>{" "}
                                      {t.got.map((pp, j) => (
                                        <span key={pp.sid}>{j ? ", " : ""}<Dot pos={pp.pos} /><b>{pp.name}</b>
                                          <span className="mut" style={{ fontSize: 10.5 }}> {pp.team || ""}</span></span>
                                      ))}</span>
                                  )}
                                  {/* ⭐⭐⭐⭐⭐ THE OTHER HALF OF THE DEAL IS NOT FOOTNOTES — b163. Trey: "there
                                      are some players and draft picks that are greyed out and makes it
                                      hard to track what was actually in the transaction." The received
                                      players were in ink with a position dot and the ones given up, plus
                                      every pick, were muted at 11px in brackets. In a trade both sides ARE
                                      the transaction. The LABELS stay muted; the names do not. */}
                                  {t.picks.map((pk) => (
                                    <span key={pk.label} style={{ fontSize: 11.5 }}>
                                      <i className="ti ti-ticket" style={{ fontSize: 11, color: "var(--gold)", marginRight: 3 }} aria-hidden="true" />
                                      <b>{pk.label}</b>
                                    </span>
                                  ))}
                                  {t.faabIn > 0 && <span style={{ fontSize: 11.5, color: "var(--pos)" }}>+ <b>${t.faabIn}</b> FAAB</span>}
                                  {t.gave.length > 0 && (
                                    <span style={{ fontSize: 12.5 }}>
                                      <span className="mut">{kind === "trade" ? "sends" : "drops"}</span>{" "}
                                      {t.gave.map((pp, j) => (
                                        <span key={pp.sid}>{j ? ", " : ""}<Dot pos={pp.pos} /><b>{pp.name}</b></span>
                                      ))}
                                    </span>
                                  )}
                                  {t.faabOut > 0 && <span style={{ fontSize: 11.5 }}><span className="mut">−</span> <b>${t.faabOut}</b> <span className="mut">FAAB</span></span>}
                                  {i < x.teams.length - 1 && kind === "trade" && <span className="mut" style={{ fontSize: 11 }}>·</span>}
                                </div>
                              ))}
                              {x.note && <div className="mut" style={{ fontSize: 11, fontStyle: "italic" }}>{x.note}</div>}
                            </div>
                            <div style={{ flexShrink: 0, textAlign: "right", display: "flex", flexDirection: "column", gap: 2 }}>
                              {/* ⚠ A BID IS ONLY PRINTED WHERE BIDS EXIST. In a waiver-priority league the
                                  backend sends null rather than 0, because "$0" reads as "he got him for
                                  nothing" instead of "this league does not have bidding". */}
                              {x.bid != null && <span className="num" style={{ fontSize: 12.5, fontWeight: 800,
                                color: x.status === "failed" ? "var(--mut)" : "var(--pos)" }}>${x.bid}</span>}
                              {x.status === "failed" && <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: ".05em",
                                color: "var(--neg)" }}>DIDN'T LAND</span>}
                              <span data-wkmovewhen={x.at ? String(x.at) : ""} className="num" style={{ fontSize: 11, fontWeight: 600 }}>{whenOf(x.at) || ""}</span>
                              <span className="mut" style={{ fontSize: 10 }}>{x.week ? `Wk ${x.week}` : ""}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                      {rows.length > 40 && <div className="mut" style={{ fontSize: 11, paddingTop: 8 }}>{rows.length - 40} more not shown — narrow the window.</div>}
                    </div>
                  );
                })}
              </>
            )}
          </div>
        )}

        {/* ===================== WEEKLY REVIEW =====================
            Trey: "a review of what you could have done better… should you have started someone else? Was
            there a FA? Was it good luck or bad luck that you won or lost? Give weekly trends not just for
            your matchup, but also compare it to the league."

            ⚠ THE VERDICT LEADS, NOT THE SCORE. A scoreboard is something he already has in Sleeper; what
              this page owes him is the sentence that says whether the result was earned — and it has to be
              willing to say the loss was his fault, or the whole thing is a horoscope. */}
        {/* The review itself lives in its own screen, because the league hub and the home page show the
            SAME thing at a different scale — see WeeklyReview.jsx. Here it is handed every connected
            league, which is the macro read. */}
        {view === "review" && <WeeklyReview leagues={connected} scope="all" />}

        {!loading && unconnected.length > 0 && (
          <div data-wkunconnected className="mut" style={{ fontSize: 11.5, marginTop: 18, lineHeight: 1.55, borderTop: "1px solid var(--line)", paddingTop: 10 }}>
            {unconnected.length} league{unconnected.length === 1 ? " is" : "s are"} not on this page —
            {" "}{unconnected.slice(0, 4).map((l) => l.name).join(", ")}{unconnected.length > 4 ? ` and ${unconnected.length - 4} more` : ""}.
            {" "}They are not connected to a platform, so there is no live roster to read: your draft results are still
            there, but a lineup we last saw on draft day is not something to give you a starting-lineup warning from.
          </div>
        )}
      </div>
      {/* One card for the whole screen, drawn last so it sits above everything. */}
      <HoverTable card={card} />
    </div>
  );
}

/* ---- the two shapes the availability list takes ------------------------------------------------- */

/* ⚠ `leagueTag` AND `swapLine` ARRIVE AS PLAIN FUNCTIONS, not components — b163. They used to be
   declared inside MyWeek's render and passed down as component props, so React saw a new component type
   on every render and remounted this row's whole subtree every time. Called, they inline. */
function Row({ r, leagueTag, swapLine }) {
  return (
    <div data-wkrow={r.name} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "9px 10px", borderTop: "1px solid var(--line)", flexWrap: "wrap" }}>
      <span style={{ flexShrink: 0, marginTop: 1 }}><Dot pos={r.pos} /></span>
      <div style={{ flex: "1 1 300px", minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13.5, fontWeight: 700 }}>{r.name}</span>
          <span className="mut" style={{ fontSize: 10.5 }}>{r.pos}{r.team ? ` · ${r.team}` : ""}{r.opp ? ` vs ${r.opp}` : ""}</span>
          <span data-wkdes={r.des.key} style={{ fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".04em",
            border: `1px solid ${r.des.tone}`, color: r.des.tone, borderRadius: 99, padding: "1px 7px" }}>{r.des.label}</span>
          {r.startingIn > 0
            ? <span style={{ fontSize: 9.5, fontWeight: 800, color: "var(--gold)", background: "rgba(224,166,60,.16)", borderRadius: 4, padding: "1px 5px" }}>STARTING</span>
            : <span className="mut" style={{ fontSize: 9.5 }}>bench</span>}
          {r.proj != null && <span className="num mut" style={{ fontSize: 10.5 }}>{r1(r.proj)} proj</span>}
        </div>
        {(r.part || r.note)
          ? <div className="mut" style={{ fontSize: 11.5, lineHeight: 1.45, marginTop: 3 }}>
              {r.part ? <b style={{ color: "var(--ink)" }}>{r.part}</b> : null}{r.part && r.note ? " — " : ""}{r.note}
              {ago(r.at) ? <span style={{ opacity: .7 }}> · {ago(r.at)}</span> : null}
            </div>
          : <div className="mut" style={{ fontSize: 11.5, marginTop: 3, opacity: .8 }}>No note filed yet — designation only.</div>}
        {/* ⭐⭐⭐⭐ THE REPLACEMENT, ONE LINE PER LEAGUE. Trey: "put side by side, like who would be the player
            that you would replace with, and what is the point differential between those two." It has to be
            per league because it IS per league — the same injury is a shrug where your bench is deep and a
            problem where it is not, and one averaged answer would hide both. */}
        <div style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 6 }}>
          <span style={{ fontSize: 10.5, fontWeight: 800, color: r.startingIn > 0 ? "var(--gold)" : "var(--mut)" }}>
            {r.startingIn > 0 ? `Starting in ${r.startingIn}` : `On ${r.inLeagues.length} bench${r.inLeagues.length === 1 ? "" : "es"}`}
            {r.startingIn > 0 && r.inLeagues.length > r.startingIn ? ` of ${r.inLeagues.length}` : ""}
          </span>
          {r.inLeagues.map((x) => (
            <div key={x.league.id} style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap", paddingLeft: 2 }}>
              {leagueTag(x.league, !x.starting)}
              {x.starting && (x.replacement
                ? swapLine({ outPts: x.replacement.curPts, inName: x.replacement.name, inPts: x.replacement.pts,
                    delta: x.replacement.delta, where: x.replacement.where })
                : <span className="mut" style={{ fontSize: 11 }}>→ nobody healthy at {r.pos} on your bench or the wire</span>)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function FlatList({ rows, sortBy, leagueTag, swapLine }) {
  /* Grouped into the severity buckets only in the default view. The explicit sorts render one flat list,
     because grouping would quietly re-sort the list the user just asked to sort. */
  if (sortBy !== "impact") {
    return <div className="panel" style={{ padding: 6 }}>{rows.map((r) => <Row key={r.key} r={r} leagueTag={leagueTag} swapLine={swapLine} />)}</div>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {[4, 3, 2, 1].map((sev) => {
        const group = rows.filter((r) => r.rank === sev);
        if (!group.length) return null;
        const meta = SEV[sev];
        return (
          <div key={sev} data-wkgroup={sev}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7 }}>
              <i className={`ti ${meta.icon}`} style={{ fontSize: 15, color: meta.tone }} aria-hidden="true" />
              <span className="disp" style={{ fontSize: 15, fontWeight: 800, color: meta.tone }}>{meta.label}</span>
              <span className="mut" style={{ fontSize: 11.5 }}>{group.length}</span>
            </div>
            <div className="panel" style={{ padding: 6, borderColor: sev >= 3 ? meta.tone : "var(--line)" }}>
              {group.map((r) => <Row key={r.key} r={r} leagueTag={leagueTag} swapLine={swapLine} />)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* One league at a time — for when you are going to go and fix them rather than survey them. */
function ByLeague({ perLeague, swapLine, onUmbrella }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {perLeague.filter((L) => L && (L.avail || []).some((r) => r.rank >= 2)).map((L) => {
        const list = L.avail.filter((r) => r.rank >= 2).sort((a, b) => b.rank - a.rank || b.des.sev - a.des.sev);
        return (
          <div key={L.league.id} data-wkleaguegroup={L.league.name}>
            <button onClick={() => onUmbrella && onUmbrella(L.league.id)}
              style={{ cursor: "pointer", fontFamily: "inherit", background: "none", border: "none", padding: 0, marginBottom: 5, color: "var(--ink)" }}>
              <span className="disp" style={{ fontSize: 14, fontWeight: 800 }}>{L.league.name}</span>
              <span className="mut" style={{ fontSize: 11.5, marginLeft: 8 }}>{list.length} to look at</span>
            </button>
            <div className="panel" style={{ padding: 6 }}>
              {list.map((r) => (
                <div key={r.sid} data-wkrow={r.name} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "9px 10px", borderTop: "1px solid var(--line)", flexWrap: "wrap" }}>
                  <span style={{ flexShrink: 0, marginTop: 1 }}><Dot pos={r.pos} /></span>
                  <div style={{ flex: "1 1 300px", minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 13.5, fontWeight: 700 }}>{r.name}</span>
                      <span className="mut" style={{ fontSize: 10.5 }}>{r.pos}{r.team ? ` · ${r.team}` : ""}</span>
                      <span data-wkdes={r.des.key} style={{ fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".04em",
                        border: `1px solid ${r.des.tone}`, color: r.des.tone, borderRadius: 99, padding: "1px 7px" }}>{r.des.label}</span>
                      {r.starting && <span style={{ fontSize: 9.5, fontWeight: 800, color: "var(--gold)", background: "rgba(224,166,60,.16)", borderRadius: 4, padding: "1px 5px" }}>STARTING</span>}
                    </div>
                    {(r.part || r.note) && <div className="mut" style={{ fontSize: 11.5, marginTop: 3 }}>{r.part ? <b style={{ color: "var(--ink)" }}>{r.part}</b> : null}{r.part && r.note ? " — " : ""}{r.note}</div>}
                    {r.starting && (r.replacement
                      ? <div style={{ marginTop: 5 }}>{swapLine({ outPts: r.replacement.curPts, inName: r.replacement.name, inPts: r.replacement.pts, delta: r.replacement.delta, where: r.replacement.where })}</div>
                      : <div className="mut" style={{ fontSize: 11, marginTop: 5 }}>→ nobody healthy at {r.pos} on your bench or the wire</div>)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
