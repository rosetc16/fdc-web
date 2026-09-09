/* ⭐⭐⭐⭐ 29h — FIFTEEN LEAGUES, ONE SCREEN, SORTED BY WHERE YOUR TIME GOES.
   ------------------------------------------------------------------------------------------------
   Trey: "I have fifteen leagues. It is so hard for me to have to go through each league and determine a few
   things. Number one and most importantly, am I starting anybody who is hurt and not expected to play? What
   are the players I need to check back on at the last minute? … I'd like there to be somewhere on the site
   where you can basically click on it and see flags for every single league in one place and show you where
   to spend your time. and, obviously, categorize it by the severity."

   Everything this page shows already existed — one league at a time, on the team hub, fifteen visits deep.
   The feature is not new data, it is the ROLLUP: the same reads run across every connected league and then
   sorted by how much they cost you, so the answer to "where do I need to be" is the top of one list instead
   of the outcome of a fifteen-stop tour.

   ⚠ ONLY LEAGUES WHERE WE CAN SEE EVERY ROSTER. Trey drew this line: "Only ones that are connected where you
     can see every roster, available players, etc… If it's not a connected league in general, you should just
     be able to see draft results because a league hub would be irrelevant since you couldn't even see the
     live roster of the team you drafted." A manual league's roster is whatever it was on draft day, and
     telling somebody their starter is out — from a lineup they have since changed twice on waivers — is
     worse than saying nothing. Unconnected leagues are counted and named at the bottom so their absence is
     visible rather than mysterious.

   ⚠ THREE VIEWS, ONE LOAD. Availability, free agents and weather all read the same fan-out, so the toggle
     switches what is on screen and never re-fetches. Fifteen leagues is fifteen team-hub calls; doing that
     three times because somebody pressed a tab would make the page feel exactly like the thing it replaces.

   ⚠ WHAT THIS PAGE DELIBERATELY DOES NOT CLAIM. Trey also asked for players "trending up dramatically". The
     only trend in the system is `trend` on the player pack, and it is DRAFT-MARKET movement — how much
     earlier a player is being taken in drafts than three weeks ago. In August that is exactly the signal he
     means; in November it is measuring an empty room. There is no in-season usage or production trend
     anywhere in the app (no snap share, no target share, no week-over-week production), so rather than dress
     a stale draft number up as momentum, the free-agent view is built on the two things that ARE real — a
     bye you have to cover, and a free agent who out-projects someone you are starting — and the gap is
     stated on screen. Adding a real momentum signal needs a new data source and is its own build.
   ------------------------------------------------------------------------------------------------ */
import React, { useState, useEffect, useMemo, useRef } from "react";
import { api } from "../api.js";
import { formatKey, POS_COLOR, Dot, normName } from "../App.jsx";

/* The Sleeper league id for a league, or null if it is not connected. This is the whole eligibility test:
   no id, no live roster, nothing to say. */
const hubIdOf = (l) => (l && ((l.connect && l.connect.leagueId) || (l.cfg && l.cfg.connect && l.cfg.connect.leagueId) || l.sleeperLeagueId)) || null;

/* ⭐⭐⭐⭐ HOW BAD IS IT, AS A NUMBER YOU CAN SORT ON.
   Trey: "categorize it by the severity and so on." Severity here is not the injury designation on its own —
   a doubtful WR4 on your bench is not a problem and an OUT player you are STARTING is the only kind of
   emergency this page has. So the rank is the designation crossed with whether he is in your lineup, which
   is the question he actually asked: "am I starting anybody who is hurt and not expected to play?"
     4  starting, and not expected to play        — fix this now
     3  starting, and a genuine game-time call    — the "check back at the last minute" bucket
     2  starting, and carrying something          — worth knowing, probably fine
     1  on the bench and hurt                     — context, not a task
   The designation strings come from two feeds and neither is tidy, so this reads prefixes rather than
   matching a fixed list; an unrecognised status still lands somewhere sane rather than vanishing. */
const DESIGNATIONS = [
  { re: /^(out|o)$/i, key: "OUT", label: "Out", rank: 4, tone: "#F2655C" },
  { re: /^(ir|inj|injured)/i, key: "IR", label: "IR", rank: 4, tone: "#F2655C" },
  { re: /^(pup|nfi|susp)/i, key: "PUP", label: "Not available", rank: 4, tone: "#F2655C" },
  { re: /^(d|doubt)/i, key: "D", label: "Doubtful", rank: 3, tone: "#E08A3C" },
  { re: /^(q|quest)/i, key: "Q", label: "Questionable", rank: 3, tone: "var(--gold)" },
  { re: /^(dtd|day)/i, key: "DTD", label: "Day-to-day", rank: 2, tone: "var(--gold)" },
  { re: /^(p|prob)/i, key: "P", label: "Probable", rank: 2, tone: "#6BA8E5" },
];
const designationOf = (raw) => {
  const s = String(raw || "").trim();
  if (!s || /^(act|active|healthy)$/i.test(s)) return null;
  const hit = DESIGNATIONS.find((d) => d.re.test(s));
  return hit || { key: "?", label: s.slice(0, 18), rank: 2, tone: "var(--mut)" };
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

/* Run the fan-out a few at a time. Fifteen parallel team-hub calls each fan out to Sleeper themselves, and
   firing them all at once is how you get rate-limited into a page that half-loads and blames the user's
   leagues. Four keeps it quick without stampeding. */
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

export default function MyWeek({ user, leagues, onHome, onBack, backLabel, onOpenHub, onUmbrella }) {
  const [view, setView] = useState("avail");        // avail | fa | weather
  const [rows, setRows] = useState(null);           // per-league results
  const [pack, setPack] = useState(null);           // one pack: names, positions, teams, byes, injury detail
  const [weather, setWeather] = useState(null);
  const [week, setWeek] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const ranFor = useRef(null);

  const connected = useMemo(() => (leagues || []).filter((l) => hubIdOf(l)), [leagues]);
  const unconnected = useMemo(() => (leagues || []).filter((l) => !hubIdOf(l)), [leagues]);

  useEffect(() => {
    const sig = connected.map((l) => hubIdOf(l)).join(",");
    if (!sig) { setLoading(false); setRows([]); return; }
    if (ranFor.current === sig) return;
    ranFor.current = sig;
    let alive = true;
    (async () => {
      setLoading(true); setErr(null);
      try {
        /* ONE PACK FOR ALL OF THEM. Names, positions, NFL team, bye week and the merged injury detail are
           the same facts in every league — only the VALUATION is format-specific. Fetching a pack per
           league would multiply the slowest call on the page by fifteen to re-learn that Ja'Marr Chase
           plays for Cincinnati. The per-league nuance stays where it belongs, on that league's own hub. */
        const base = connected[0];
        const fmt = formatKey(base && base.cfg ? base.cfg : { teams: 12, rounds: 15, scoring: { rec: 1 }, start: {} });
        const [pk, hubs] = await Promise.all([
          api.playerPack(fmt, undefined, { k: true, dst: true }).catch(() => null),
          pool(connected, 4, (l) => api.sleeperTeamHub(hubIdOf(l))),
        ]);
        if (!alive) return;
        setPack(pk);
        const wk = hubs.map((h) => h && h.week).find((w) => Number.isFinite(w)) || null;
        setWeek(wk);
        setRows(connected.map((l, i) => ({ league: l, hub: hubs[i] && !hubs[i].error ? hubs[i] : null, error: hubs[i] && hubs[i].error })));
        if (wk) api.weatherWeek(wk).then((w) => { if (alive) setWeather(w); }).catch(() => {});
      } catch (e) {
        if (alive) setErr(String((e && e.message) || e));
      } finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [connected]);

  /* Sleeper player id -> the pack's facts about him, built once.
     ⚠ THE KEY IS `id`, NOT `sid`. The RAW pack calls the Sleeper id `id` (see routes/playerPack.js); `sid`
       is a name the draft room's buildPlayers() assigns later, and this screen reads the pack directly
       rather than building a scored pool it does not need. Keying on the wrong one is silent: the map comes
       back empty, every row still renders off the week feed alone, and the page quietly loses every injury
       note, every free agent and every weather join while looking like it worked. It did exactly that on
       the first run — four rows, no notes, no free agents, no weather. */
  const bySid = useMemo(() => {
    const m = new Map();
    ((pack && pack.players) || []).forEach((p) => { const k = p && (p.id != null ? p.id : p.sid); if (k != null) m.set(String(k), p); });
    return m;
  }, [pack]);

  /* ---- THE AVAILABILITY ROLLUP ------------------------------------------------------------------
     One row per (league, player) where there is something to say. Starters first because that is the
     question; bench entries are kept because "he is hurt but you are not starting him" is the answer to a
     question you would otherwise go and ask. */
  const availRows = useMemo(() => {
    if (!rows) return [];
    const out = [];
    rows.forEach(({ league, hub }) => {
      if (!hub || !hub.teams) return;
      const mine = hub.teams.find((t) => t.rosterId === hub.myRosterId);
      if (!mine) return;
      const starters = new Set((mine.starters || []).filter(Boolean).map(String));
      const roster = new Set([...(mine.players || []), ...(mine.reserve || []), ...(mine.taxi || [])].filter(Boolean).map(String));
      roster.forEach((sid) => {
        const p = bySid.get(sid);
        const wk = (hub.weekly && hub.weekly[sid]) || null;
        // The week feed's designation is the freshest thing we have; the pack carries the detail behind it.
        const des = designationOf((wk && wk.inj) || (p && p.inj));
        if (!des) return;
        const starting = starters.has(sid);
        const rank = starting ? des.rank : 1;
        out.push({
          key: `${league.id}:${sid}`, league, sid, starting, rank, des,
          name: (p && p.name) || `Player ${sid}`,
          pos: (p && p.pos) || (wk && wk.pos) || "",
          team: (p && p.team) || (wk && wk.team) || "",
          part: p && p.injPart, note: p && p.injNote, at: p && p.injAt,
          proj: wk && wk.pts != null ? wk.pts : null,
          opp: wk && wk.opp,
        });
      });
    });
    /* ⭐⭐⭐⭐ ONE ROW PER PLAYER, NOT ONE PER LEAGUE — and this is the difference between the page working
       and the page being the thing he asked for. The first cut listed every (league, player) pair, which
       looks fine with four leagues and is a disaster with fifteen: one injured star you own everywhere
       becomes fifteen consecutive identical rows, and the screen built to end a fifteen-stop tour turns
       into a fifteen-line scroll of the same sentence. Screenshot said so immediately — Ja'Marr Chase four
       times, Puka Nacua three.
       The injury is one fact; WHERE IT COSTS YOU is the list. So the row is the player, carrying the
       designation and the note once, and the leagues ride along as chips — which also makes the number of
       leagues visible, and that is itself the thing he wants to sort on: a doubtful player you are starting
       in six leagues is a bigger call on your morning than one you start in one. */
    const byPlayer = new Map();
    out.forEach((r) => {
      const g = byPlayer.get(r.sid) || { ...r, key: `p:${r.sid}`, inLeagues: [], startingIn: 0, rank: 0 };
      g.inLeagues.push({ league: r.league, starting: r.starting });
      if (r.starting) g.startingIn++;
      g.rank = Math.max(g.rank, r.rank);
      // Keep the strongest designation seen — the feeds can disagree across leagues if one is stale.
      if (r.des.rank > g.des.rank) g.des = r.des;
      g.part = g.part || r.part; g.note = g.note || r.note; g.at = g.at || r.at;
      g.proj = g.proj != null ? g.proj : r.proj;
      byPlayer.set(r.sid, g);
    });
    const grouped = [...byPlayer.values()];
    grouped.sort((a, b) => b.rank - a.rank || b.des.rank - a.des.rank || b.startingIn - a.startingIn
      || (b.proj || 0) - (a.proj || 0) || a.name.localeCompare(b.name));
    return grouped;
  }, [rows, bySid]);

  /* ---- FREE AGENTS ------------------------------------------------------------------------------
     Two claims only, and both are checkable: you have a starter on bye and there is somebody available who
     is not, or somebody available out-projects a player you are starting at his position by enough to be
     worth a waiver claim. Anything softer than that is a recommendation this page cannot honestly make from
     one shared pack — see the header note on the missing in-season trend. */
  const faRows = useMemo(() => {
    if (!rows || !pack) return [];
    const out = [];
    rows.forEach(({ league, hub }) => {
      if (!hub || !hub.teams) return;
      const mine = hub.teams.find((t) => t.rosterId === hub.myRosterId);
      if (!mine) return;
      const rostered = new Set((hub.rostered || []).map(String));
      const wkOf = (sid) => (hub.weekly && hub.weekly[String(sid)]) || null;
      /* ⚠ THE WEEK FEED IS THE ONLY HONEST NUMBER HERE. team-hub recomputes each player's projection against
         THIS league's own scoring settings, so it already answers "what is he worth to me this week" for a
         league that gives a point per reception and one that does not. The raw pack has no per-week
         projection at all, so a player the feed does not cover scores 0 and simply never wins a comparison —
         which is the right failure: silence, not a guess dressed as advice. */
      const ptsOf = (sid) => { const w = wkOf(sid); return w && w.pts != null ? Number(w.pts) : 0; };
      const starters = (mine.starters || []).filter(Boolean).map(String);
      const free = [];
      bySid.forEach((p, sid) => { if (!rostered.has(sid) && p.pos && p.pos !== "DEF") free.push({ sid, p }); });
      const bestFreeAt = (pos) => free.filter((f) => f.p.pos === pos)
        .map((f) => ({ ...f, v: ptsOf(f.sid) }))
        .sort((a, b) => b.v - a.v).slice(0, 3);

      starters.forEach((sid) => {
        const p = bySid.get(sid);
        if (!p || !p.pos) return;
        const onBye = hub.week != null && p.bye === hub.week;
        const mineV = ptsOf(sid);
        const cands = bestFreeAt(p.pos).filter((c) => !(hub.week != null && c.p.bye === hub.week));
        const best = cands[0];
        if (!best) return;
        if (onBye) {
          out.push({ key: `${league.id}:bye:${sid}`, league, kind: "bye", rank: 3,
            outName: p.name, pos: p.pos, inName: best.p.name, inTeam: best.p.team,
            gain: Math.round(best.v * 10) / 10,
            why: `${p.name} is on bye in week ${hub.week}` });
        } else if (best.v - mineV >= Math.max(2, mineV * 0.25)) {
          /* ⚠ THE BAR IS DELIBERATELY HIGH. A free agent projecting a point better than your starter is
             noise dressed as advice, and a page that says "pick this guy up" fifteen times is a page you
             stop believing. A quarter better, and at least two points, is a claim worth a waiver bid. */
          out.push({ key: `${league.id}:up:${sid}`, league, kind: "upgrade", rank: 2,
            outName: p.name, pos: p.pos, inName: best.p.name, inTeam: best.p.team,
            gain: Math.round((best.v - mineV) * 10) / 10,
            why: `projects ${Math.round((best.v - mineV) * 10) / 10} more than ${p.name} this week` });
        }
      });
    });
    out.sort((a, b) => b.rank - a.rank || b.gain - a.gain);
    return out;
  }, [rows, pack, bySid]);

  /* ---- WEATHER ----------------------------------------------------------------------------------
     The backend answers with GAMES; this joins them to the players you are actually starting, because a
     wind advisory in Buffalo is only your problem if you have somebody in it. */
  const wxRows = useMemo(() => {
    if (!rows || !weather || !weather.games) return [];
    const byTeam = new Map();
    weather.games.forEach((g) => g.teams.forEach((t) => byTeam.set(t, g)));
    const out = [];
    rows.forEach(({ league, hub }) => {
      if (!hub || !hub.teams) return;
      const mine = hub.teams.find((t) => t.rosterId === hub.myRosterId);
      if (!mine) return;
      (mine.starters || []).filter(Boolean).map(String).forEach((sid) => {
        const p = bySid.get(sid);
        const tm = (p && p.team) || (hub.weekly && hub.weekly[sid] && hub.weekly[sid].team);
        const g = tm && byTeam.get(String(tm).toUpperCase());
        if (!g) return;
        out.push({ key: `${league.id}:wx:${sid}`, sid, league, name: (p && p.name) || sid, pos: (p && p.pos) || "", team: tm, game: g });
      });
    });
    /* ⭐⭐⭐ GROUPED BY PLAYER, for the same reason the availability list is — see that note. A player you
       start in six leagues is one weather problem with six consequences, not six problems, and printing it
       six times buries the second player. */
    const byP = new Map();
    out.forEach((r) => {
      const g = byP.get(r.sid) || { ...r, key: `wx:${r.sid}`, inLeagues: [] };
      g.inLeagues.push(r.league);
      byP.set(r.sid, g);
    });
    const grouped = [...byP.values()];
    grouped.sort((a, b) => b.game.severity - a.game.severity || b.inLeagues.length - a.inLeagues.length || a.name.localeCompare(b.name));
    return grouped;
  }, [rows, weather, bySid]);

  const counts = useMemo(() => ({
    urgent: availRows.filter((r) => r.rank >= 4).length,
    check: availRows.filter((r) => r.rank === 3).length,
    fa: faRows.length,
    wx: wxRows.length,
  }), [availRows, faRows, wxRows]);

  const LeagueTag = ({ l, dim }) => (
    <button onClick={() => onUmbrella && onUmbrella(l.id)} data-wkleague={l.name}
      title={`Open ${l.name}`}
      style={{ cursor: "pointer", fontFamily: "inherit", flexShrink: 0, maxWidth: 190, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        border: `1px solid ${dim ? "var(--line)" : "var(--line2)"}`, background: "var(--panel2)", color: "var(--mut)",
        opacity: dim ? .6 : 1, borderRadius: 99, padding: "2px 9px", fontSize: 10.5, fontWeight: 700 }}>
      {l.name}
    </button>
  );

  return (
    <div data-screen="myweek" style={{ minHeight: "100vh", background: "var(--bg)" }}>
      <div className="hairline appheader" style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 16px", flexWrap: "wrap" }}>
        <button className="btn btn-mini" onClick={onBack || onHome}>← {backLabel || "Home"}</button>
        <div className="disp" style={{ fontSize: 18, fontWeight: 700 }}>My week</div>
        {week && <span className="chip" style={{ borderColor: "var(--line2)" }}>NFL Week {week}</span>}
        <div style={{ flex: 1 }} />
        <span className="mut" style={{ fontSize: 11.5 }}>{connected.length} connected league{connected.length === 1 ? "" : "s"}</span>
      </div>

      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "16px 20px 60px" }}>
        {/* ⭐⭐⭐ THE TOGGLE. One load behind it — switching views never refetches. */}
        <div data-wkviews className="filterchips" style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
          {[["avail", "ti-first-aid-kit", "Availability", counts.urgent + counts.check],
            ["fa", "ti-user-plus", "Free agents", counts.fa],
            ["weather", "ti-cloud-storm", "Weather", counts.wx]].map(([k, icon, label, n]) => {
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

        {/* ===================== AVAILABILITY ===================== */}
        {!loading && view === "avail" && !!connected.length && (
          availRows.length === 0 ? (
            <div className="panel" data-wkempty="avail" style={{ padding: 18 }}>
              <div className="disp" style={{ fontSize: 16, fontWeight: 700, color: "#5FD0A8", marginBottom: 4 }}>Nobody to worry about</div>
              <div className="mut" style={{ fontSize: 13 }}>No injury designation on anyone you roster, across all {connected.length} leagues.</div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {[4, 3, 2, 1].map((sev) => {
                const group = availRows.filter((r) => r.rank === sev);
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
                      {group.map((r) => (
                        <div key={r.key} data-wkrow={r.name} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "8px 9px", borderTop: "1px solid var(--line)", flexWrap: "wrap" }}>
                          <span style={{ flexShrink: 0, marginTop: 1 }}><Dot pos={r.pos} /></span>
                          <div style={{ flex: "1 1 260px", minWidth: 0 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
                              <span style={{ fontSize: 13.5, fontWeight: 700 }}>{r.name}</span>
                              <span className="mut" style={{ fontSize: 10.5 }}>{r.pos}{r.team ? ` · ${r.team}` : ""}{r.opp ? ` vs ${r.opp}` : ""}</span>
                              <span data-wkdes={r.des.key} style={{ fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".04em",
                                border: `1px solid ${r.des.tone}`, color: r.des.tone, borderRadius: 99, padding: "1px 7px" }}>{r.des.label}</span>
                              {r.startingIn > 0
                                ? <span style={{ fontSize: 9.5, fontWeight: 800, color: "var(--gold)", background: "rgba(224,166,60,.16)", borderRadius: 4, padding: "1px 5px" }}>STARTING</span>
                                : <span className="mut" style={{ fontSize: 9.5 }}>bench</span>}
                            </div>
                            {/* ⭐⭐⭐ "then provide the most updated note on the injury" — the designation says
                                what the team filed; the note is the only part that tells you whether to
                                believe it, so it gets a line of its own and carries its own age. */}
                            {(r.part || r.note) && (
                              <div className="mut" style={{ fontSize: 11.5, lineHeight: 1.45, marginTop: 3 }}>
                                {r.part ? <b style={{ color: "var(--ink)" }}>{r.part}</b> : null}{r.part && r.note ? " — " : ""}{r.note}
                                {ago(r.at) ? <span style={{ opacity: .7 }}> · {ago(r.at)}</span> : null}
                              </div>
                            )}
                            {!r.part && !r.note && <div className="mut" style={{ fontSize: 11.5, marginTop: 3, opacity: .8 }}>No note filed yet — designation only.</div>}
                            {/* WHERE IT COSTS YOU. The count leads because it is the thing that decides how
                                much of your morning this is; the names follow so you know which tabs to open. */}
                            <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap", marginTop: 5 }}>
                              <span style={{ fontSize: 10.5, fontWeight: 800, color: r.startingIn > 0 ? "var(--gold)" : "var(--mut)" }}>
                                {r.startingIn > 0 ? `Starting in ${r.startingIn}` : `On ${r.inLeagues.length} bench${r.inLeagues.length === 1 ? "" : "es"}`}
                                {r.startingIn > 0 && r.inLeagues.length > r.startingIn ? ` of ${r.inLeagues.length}` : ""}
                              </span>
                              {r.inLeagues.map((x) => <LeagueTag key={x.league.id} l={x.league} dim={!x.starting} />)}
                            </div>
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                            {r.proj != null && <span className="num mut" style={{ fontSize: 11 }}>{Math.round(r.proj * 10) / 10} proj</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )
        )}

        {/* ===================== FREE AGENTS ===================== */}
        {!loading && view === "fa" && !!connected.length && (
          <>
            {faRows.length === 0 ? (
              <div className="panel" data-wkempty="fa" style={{ padding: 18 }}>
                <div className="disp" style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Nothing worth a claim</div>
                <div className="mut" style={{ fontSize: 13 }}>No bye holes and nobody available who clearly beats a player you are starting.</div>
              </div>
            ) : (
              <div className="panel" style={{ padding: 6 }}>
                {faRows.map((r) => (
                  <div key={r.key} data-wkfarow={r.inName} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 10px", borderTop: "1px solid var(--line)", flexWrap: "wrap" }}>
                    <span data-wkfakind={r.kind} style={{ flexShrink: 0, fontSize: 9.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".04em",
                      border: `1px solid ${r.kind === "bye" ? "var(--gold)" : "#5FD0A8"}`, color: r.kind === "bye" ? "var(--gold)" : "#5FD0A8",
                      borderRadius: 99, padding: "2px 8px" }}>{r.kind === "bye" ? "Bye hole" : "Upgrade"}</span>
                    <div style={{ flex: "1 1 300px", minWidth: 0 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 700 }}>
                        Add <span style={{ color: "#5FD0A8" }}>{r.inName}</span>
                        <span className="mut" style={{ fontSize: 10.5, fontWeight: 400 }}> {r.pos}{r.inTeam ? ` · ${r.inTeam}` : ""}</span>
                        <span className="mut" style={{ fontSize: 12, fontWeight: 400 }}> for {r.outName}</span>
                      </div>
                      <div className="mut" style={{ fontSize: 11.5, marginTop: 2 }}>{r.why}</div>
                    </div>
                    <span className="num" style={{ fontSize: 12, fontWeight: 800, color: "#5FD0A8", flexShrink: 0 }}>+{r.gain}</span>
                    <LeagueTag l={r.league} />
                  </div>
                ))}
              </div>
            )}
            {/* ⚠ SAID OUT LOUD RATHER THAN QUIETLY MISSING. He asked for "trending up dramatically" too. */}
            <div className="mut" style={{ fontSize: 11, lineHeight: 1.5, marginTop: 10 }}>
              These are the two claims that can be checked: a starter on bye, and an available player who
              out-projects one you are starting by a clear margin. A "trending up" read needs in-season usage
              — snap and target share week to week — which the app does not collect yet, so it is not here
              rather than being guessed at from draft-market movement.
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
                  <div className="mut" style={{ fontSize: 13 }}>{weather.note || "The NFL schedule hasn't loaded yet."}</div>
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

        {/* ⚠ THE LEAGUES THIS PAGE CANNOT SPEAK FOR, named rather than silently missing. */}
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
