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
import { api } from "../api.js";
import { backendFormatKey, Dot } from "../App.jsx";
import WeeklyReview from "./WeeklyReview.jsx";

const REFRESH_MS = 5 * 60 * 1000;   // his number, and about right: designations move in minutes, not seconds

const hubIdOf = (l) => (l && ((l.connect && l.connect.leagueId) || (l.cfg && l.cfg.connect && l.cfg.connect.leagueId) || l.sleeperLeagueId)) || null;
const ownerOf = (l) => (l && (
  (l.connect && (l.connect.ownerUsername || l.connect.username))
  || (l.cfg && l.cfg.connect && (l.cfg.connect.ownerUsername || l.cfg.connect.username))
)) || null;

/* The four reasons to make a claim, each with its own word. The labels are the whole point: a streamer
   dressed as an upgrade is how a waiver list stops being trusted, and "Bye next week" is useless unless it
   is visibly not "Bye hole". Ordered here the way they are ranked in the list. */
const FA_KIND = {
  bye:     { label: "Bye hole",      tone: "var(--gold)" },
  byeNext: { label: "Bye next week", tone: "#6BA8E5" },
  upgrade: { label: "Upgrade",       tone: "#5FD0A8" },
  stream:  { label: "Thin spot",     tone: "var(--mut)" },
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
const DESIGNATIONS = [
  { re: /^(ir|inj|injured)/i, key: "IR", label: "IR", sev: 6, rank: 4, tone: "#F2655C" },
  { re: /^(pup|nfi|susp)/i, key: "PUP", label: "Not available", sev: 6, rank: 4, tone: "#F2655C" },
  { re: /^(out|o)$/i, key: "OUT", label: "Out", sev: 5, rank: 4, tone: "#F2655C" },
  { re: /^(d|doubt)/i, key: "D", label: "Doubtful", sev: 4, rank: 3, tone: "#E08A3C" },
  { re: /^(q|quest)/i, key: "Q", label: "Questionable", sev: 3, rank: 3, tone: "var(--gold)" },
  { re: /^(dtd|day)/i, key: "DTD", label: "Day-to-day", sev: 2, rank: 2, tone: "var(--gold)" },
  { re: /^(p|prob)/i, key: "P", label: "Probable", sev: 1, rank: 2, tone: "#6BA8E5" },
];
const designationOf = (raw) => {
  const s = String(raw || "").trim();
  if (!s || /^(act|active|healthy)$/i.test(s)) return null;
  return DESIGNATIONS.find((d) => d.re.test(s)) || { key: "?", label: s.slice(0, 18), sev: 2, rank: 2, tone: "var(--mut)" };
};

const SEV = {
  4: { label: "Not expected to play", tone: "#F2655C", icon: "ti-alert-octagon" },
  3: { label: "Check before kickoff", tone: "var(--gold)", icon: "ti-clock-exclamation" },
  2: { label: "Carrying something", tone: "#6BA8E5", icon: "ti-first-aid-kit" },
  1: { label: "On your bench", tone: "var(--mut)", icon: "ti-dots" },
};

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
  const [loading, setLoading] = useState(true);
  const [refreshedAt, setRefreshedAt] = useState(null);
  const [err, setErr] = useState(null);
  const ranFor = useRef(null);
  const connected = useMemo(() => (leagues || []).filter((l) => hubIdOf(l)), [leagues]);
  const unconnected = useMemo(() => (leagues || []).filter((l) => !hubIdOf(l)), [leagues]);

  useEffect(() => {
    const sig = connected.map((l) => hubIdOf(l)).join(",");
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
          pool(connected, 4, (l) => api.sleeperTeamHub(hubIdOf(l), undefined, ownerOf(l))),
        ]);
        if (!alive) return;
        if (pk) setPack(pk);
        const wk = hubs.map((h) => h && h.week).find((w) => Number.isFinite(w)) || null;
        setWeek(wk);
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
  }, [connected]);

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
         higher than the healthy starter in front of him. Same position only, because this page does not know
         your league's flex rules well enough to promise a swap is legal, and a suggestion you cannot action
         is worse than none. Anyone with an availability problem is left to that list rather than counted
         twice here. */
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
      starters.forEach((sid) => { if (onBye(sid)) pushBye(sid, "now"); });
      if (byeNextSet) starters.forEach((sid) => { const t = teamOf(sid); if (t && byeNextSet.has(t)) pushBye(sid, "next"); });

      /* ⭐⭐⭐ THEN THE UPGRADES — "but also just specific team upgrades." Same shape as before, now over a
         pool that contains the players who are actually free. The bar stays deliberately high: a claim
         costs you a roster spot and possibly FAAB, so "two points and a quarter better" is the least this
         can be worth without turning the list into noise. */
      starters.forEach((sid) => {
        const pos = posOf(sid);
        if (!pos || onBye(sid)) return;
        const cur = ptsOf(sid);
        const best = claimable(pos)[0];
        if (!best || cur == null) return;
        if (best.pts - cur >= Math.max(2, cur * 0.25) || (cur < 6 && best.pts > cur)) taken.add(best.name);
        if (best.pts - cur >= Math.max(2, cur * 0.25)) {
          fa.push({ kind: "upgrade", rank: 2, pos, outName: nameOf(sid), inName: best.name, inTeam: best.team,
            gain: r1(best.pts - cur), why: `projects ${r1(best.pts - cur)} more than ${nameOf(sid)} this week` });
        } else if (cur < 6 && best.pts > cur) {
          fa.push({ kind: "stream", rank: 1, pos, outName: nameOf(sid), inName: best.name, inTeam: best.team,
            gain: r1(best.pts - cur), why: `${nameOf(sid)} projects ${r1(cur)} — ${best.name} is available at ${r1(best.pts)}` });
        }
      });
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

  const counts = useMemo(() => ({
    urgent: availRows.filter((r) => r.rank >= 4).length,
    check: availRows.filter((r) => r.rank === 3).length,
    avail: availRows.filter((r) => r.rank >= 3).length,
    lineup: perLeague.reduce((s, L) => s + ((L && L.swaps) || []).length, 0),
    fa: perLeague.reduce((s, L) => s + ((L && L.fa) || []).length, 0),
    wx: wxRows.length,
  }), [availRows, perLeague, wxRows]);

  const LeagueTag = ({ l, dim }) => (
    <button onClick={() => onUmbrella && onUmbrella(l.id)} data-wkleague={l.name} title={`Open ${l.name}`}
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
  const Swap = ({ outPts, inName, inPts, delta, where }) => {
    const better = delta == null || delta >= 0;
    return (
      <span data-wkswap={inName} data-wkswapkind={better ? "gain" : "fallback"}
        style={{ display: "inline-flex", alignItems: "baseline", gap: 5, fontSize: 11.5, flexWrap: "wrap" }}>
        <span className="mut">{better ? "→ start" : "→ if he sits, best you have is"}</span>
        <b style={{ color: better ? "#5FD0A8" : "var(--ink)" }}>{inName}</b>
        {where ? <span className="mut" style={{ fontSize: 9.5 }}>({where})</span> : null}
        {inPts != null && outPts != null && <span className="num mut" style={{ fontSize: 10.5 }}>{r1(inPts)} vs {r1(outPts)}</span>}
        {delta != null && <b className="num" style={{ fontSize: 11, color: better ? "#5FD0A8" : "#F2655C" }}>{delta >= 0 ? "+" : ""}{delta}</b>}
      </span>
    );
  };

  const VIEWS = [
    ["summary", "ti-layout-dashboard", "Summary", 0],
    ["avail", "ti-first-aid-kit", "Availability", counts.avail],
    ["lineup", "ti-arrows-exchange", "Lineup changes", counts.lineup],
    ["fa", "ti-user-plus", "Free agents", counts.fa],
    ["weather", "ti-cloud-storm", "Weather", counts.wx],
    // Last, and badgeless on purpose: everything above it is a thing to DO before kickoff, and this is the
    // only one that is about a week you can no longer change. A count here would compete for the same
    // attention on a Sunday morning and win, which would be exactly wrong.
    ["review", "ti-history", "Weekly review", 0],
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
            {week && <span>NFL Week {week}</span>}
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
                {[["Not expected to play", counts.urgent, "#F2655C"], ["Check before kickoff", counts.check, "var(--gold)"],
                  ["Lineup gains", counts.lineup, "#5FD0A8"], ["Waiver ideas", counts.fa, "#6BA8E5"], ["Weather", counts.wx, "#6BA8E5"]].map(([lbl, n, tone]) => (
                  <div key={lbl} style={{ minWidth: 118 }}>
                    <div className="num" style={{ fontSize: 26, fontWeight: 800, color: n > 0 ? tone : "var(--mut)", lineHeight: 1.1 }}>{n}</div>
                    <div className="mut" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".04em", fontWeight: 700 }}>{lbl}</div>
                  </div>
                ))}
              </div>
              <div className="mut" style={{ fontSize: 12.5, marginTop: 11, lineHeight: 1.5 }}>
                {counts.urgent > 0
                  ? <>Start here: <b style={{ color: "#F2655C" }}>{counts.urgent} player{counts.urgent === 1 ? "" : "s"} you are starting {counts.urgent === 1 ? "is" : "are"} not expected to play.</b></>
                  : counts.check > 0
                    ? <>Nothing is ruled out, but <b style={{ color: "var(--gold)" }}>{counts.check}</b> of your starters {counts.check === 1 ? "is" : "are"} a game-time call — worth another look before kickoff.</>
                    : <>No availability problems anywhere. {counts.lineup > 0 ? `${counts.lineup} lineup${counts.lineup === 1 ? "" : "s"} could still score more.` : "Your lineups are set."}</>}
              </div>
            </div>

            <div className="panel" style={{ padding: 6 }}>
              {perLeague.map((L) => {
                if (!L) return null;
                const urgent = (L.avail || []).filter((r) => r.rank >= 4).length;
                const check = (L.avail || []).filter((r) => r.rank === 3).length;
                const gain = (L.swaps || []).reduce((s, x) => s + x.gain, 0);
                const tone = L.error ? "var(--mut)" : urgent ? "#F2655C" : check ? "var(--gold)" : "#5FD0A8";
                return (
                  <div key={L.league.id} data-wksumrow={L.league.name} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderTop: "1px solid var(--line)", flexWrap: "wrap" }}>
                    <span style={{ width: 8, height: 8, borderRadius: 99, background: tone, flexShrink: 0 }} aria-hidden="true" />
                    <button onClick={() => onUmbrella && onUmbrella(L.league.id)}
                      style={{ cursor: "pointer", fontFamily: "inherit", background: "none", border: "none", color: "var(--ink)", fontSize: 13.5, fontWeight: 700, padding: 0, textAlign: "left", flex: "1 1 200px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {L.league.name}
                    </button>
                    <span className="mut" style={{ fontSize: 11.5, flex: "2 1 320px", minWidth: 0 }}>
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
                        : urgent ? <span style={{ color: "#F2655C" }}>{urgent} not expected to play</span>
                        : check ? <span style={{ color: "var(--gold)" }}>{check} to check before kickoff</span>
                        : "No availability problems"}
                      {gain > 0 ? <span style={{ color: "#5FD0A8" }}> · +{r1(gain)} available from your bench</span> : null}
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
              <div className="disp" style={{ fontSize: 16, fontWeight: 700, color: "#5FD0A8", marginBottom: 4 }}>Nobody to worry about</div>
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
                ? <ByLeague perLeague={perLeague} Swap={Swap} onUmbrella={onUmbrella} />
                : <FlatList rows={availSorted} sortBy={sortBy} LeagueTag={LeagueTag} Swap={Swap} />}
            </>
          )
        )}

        {/* ===================== LINEUP CHANGES ===================== */}
        {!loading && view === "lineup" && !!connected.length && (
          counts.lineup === 0 ? (
            <div className="panel" data-wkempty="lineup" style={{ padding: 18 }}>
              <div className="disp" style={{ fontSize: 16, fontWeight: 700, color: "#5FD0A8", marginBottom: 4 }}>Your lineups are already the best you have</div>
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
                          {" "}<span className="mut">for</span> <b style={{ color: "#5FD0A8" }}>{sw.in}</b> <span className="num mut" style={{ fontSize: 11 }}>{r1(sw.inPts)}</span>
                        </div>
                        <b className="num" style={{ fontSize: 12.5, color: "#5FD0A8", flexShrink: 0 }}>+{sw.gain}</b>
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
                          <span data-wkfakind={r.kind} style={{ flexShrink: 0, fontSize: 9.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".04em",
                            border: `1px solid ${FA_KIND[r.kind].tone}`, color: FA_KIND[r.kind].tone,
                            borderRadius: 99, padding: "2px 8px" }}>{FA_KIND[r.kind].label}</span>
                          <div style={{ flex: "1 1 300px", minWidth: 0 }}>
                            <div style={{ fontSize: 13.5, fontWeight: 700 }}>
                              Add <span style={{ color: "#5FD0A8" }}>{r.inName}</span>
                              <span className="mut" style={{ fontSize: 10.5, fontWeight: 400 }}> {r.pos}{r.inTeam ? ` · ${r.inTeam}` : ""}</span>
                            </div>
                            <div className="mut" style={{ fontSize: 11.5, marginTop: 2 }}>{r.why}</div>
                          </div>
                          <span className="num" style={{ fontSize: 12, fontWeight: 800, color: "#5FD0A8", flexShrink: 0 }}>+{r.gain}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="mut" style={{ fontSize: 11, lineHeight: 1.5, marginTop: 10 }}>
              Four kinds of claim, labelled so none of them pretends to be another: a slot left empty by a bye this
              week, a bye coming next week you can cover while the wire is still worth picking over, an available
              player who clearly beats one of yours, and a thin spot where your starter is barely producing. Byes come
              from the NFL schedule rather than from a player's bye-week field, which is blank for much of the year. A
              "trending up" read needs in-season usage — snap and target share week to week — which the app does not
              collect yet, so it is absent rather than faked from draft-market movement.
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
                  <div className="disp" style={{ fontSize: 16, fontWeight: 700, color: "#5FD0A8", marginBottom: 4 }}>Nothing to play around</div>
                  <div className="mut" style={{ fontSize: 13, lineHeight: 1.55 }}>
                    Nobody you are starting is in a game with weather worth planning around
                    {weather.counts ? <> — {weather.counts.indoors} of this week's games are indoors, and the rest are forecast clear enough not to matter.</> : "."}
                  </div>
                </div>
              ) : (
                <div className="panel" style={{ padding: 6 }}>
                  {wxRows.map((r) => (
                    <div key={r.key} data-wkwxrow={r.name} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 10px", borderTop: "1px solid var(--line)", flexWrap: "wrap" }}>
                      <span data-wkwxsev={r.game.severity} style={{ flexShrink: 0, fontSize: 9.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".04em",
                        border: `1px solid ${r.game.severity >= 3 ? "#F2655C" : r.game.severity === 2 ? "var(--gold)" : "#6BA8E5"}`,
                        color: r.game.severity >= 3 ? "#F2655C" : r.game.severity === 2 ? "var(--gold)" : "#6BA8E5",
                        borderRadius: 99, padding: "2px 8px" }}>{r.game.label}</span>
                      <span style={{ flexShrink: 0 }}><Dot pos={r.pos} /></span>
                      <div style={{ flex: "1 1 300px", minWidth: 0 }}>
                        <div style={{ fontSize: 13.5, fontWeight: 700 }}>{r.name} <span className="mut" style={{ fontSize: 10.5, fontWeight: 400 }}>{r.pos} · {r.team}</span></div>
                        <div className="mut" style={{ fontSize: 11.5, marginTop: 2 }}>
                          {r.game.away} @ {r.game.home} · {r.game.text}
                          {r.game.mayClose ? <span style={{ opacity: .8 }}> · roof can close</span> : null}
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap", marginTop: 5 }}>
                          <span style={{ fontSize: 10.5, fontWeight: 800, color: "var(--gold)" }}>Starting in {r.inLeagues.length}</span>
                          {r.inLeagues.map((l) => <LeagueTag key={l.id} l={l} />)}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            {weather && weather.counts && (
              <div className="mut" style={{ fontSize: 11, marginTop: 10, lineHeight: 1.5 }}>
                Week {weather.week}: {weather.counts.games} games · {weather.counts.indoors} indoors (never flagged) ·
                {" "}{weather.counts.checked} forecast · {weather.counts.flagged} with conditions worth knowing.
                Domes are excluded outright; sun and light rain are not listed.
              </div>
            )}
          </>
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
    </div>
  );
}

/* ---- the two shapes the availability list takes ------------------------------------------------- */

function Row({ r, LeagueTag, Swap }) {
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
              <LeagueTag l={x.league} dim={!x.starting} />
              {x.starting && (x.replacement
                ? <Swap outPts={x.replacement.curPts} inName={x.replacement.name} inPts={x.replacement.pts}
                    delta={x.replacement.delta} where={x.replacement.where} />
                : <span className="mut" style={{ fontSize: 11 }}>→ nobody healthy at {r.pos} on your bench or the wire</span>)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function FlatList({ rows, sortBy, LeagueTag, Swap }) {
  /* Grouped into the severity buckets only in the default view. The explicit sorts render one flat list,
     because grouping would quietly re-sort the list the user just asked to sort. */
  if (sortBy !== "impact") {
    return <div className="panel" style={{ padding: 6 }}>{rows.map((r) => <Row key={r.key} r={r} LeagueTag={LeagueTag} Swap={Swap} />)}</div>;
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
              {group.map((r) => <Row key={r.key} r={r} LeagueTag={LeagueTag} Swap={Swap} />)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* One league at a time — for when you are going to go and fix them rather than survey them. */
function ByLeague({ perLeague, Swap, onUmbrella }) {
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
                      ? <div style={{ marginTop: 5 }}><Swap outPts={r.replacement.curPts} inName={r.replacement.name} inPts={r.replacement.pts} delta={r.replacement.delta} where={r.replacement.where} /></div>
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
