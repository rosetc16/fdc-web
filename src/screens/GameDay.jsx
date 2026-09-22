/* ⭐⭐⭐⭐⭐ GAME DAY — WHAT SHOULD I BE ROOTING FOR. 29m.
   ================================================================================================
   Trey: "I also want to be able to track all leagues live during games to see scores, trends, etc.
   basically have this be my hub for what should I be rooting for (especially if you have a lot of leagues
   and you have stakes in a ton of players, so it would basically show you who you have the most shares in
   and who you have the most shares to root against."

   In one league a Sunday needs no help. In fifteen the useful question stops being "how am I doing" and
   becomes "when this ball is in the air, do I want it caught" — and that is genuinely hard, because the
   same player is on your side in some leagues and against you in others. Josh Jacobs in six of your
   lineups and two of your opponents' is a net +4; in one of yours and five of theirs he is a net −4 and
   every one of his touchdowns costs you. Nobody holds that across fifteen matchups with a game on.

   ⚠ THE BOARD LEADS, NOT THE SCOREBOARD. The scores are the easy part and every platform already shows
     them; what no platform shows is the net stake, because no platform knows about your other fourteen
     leagues. So the rooting board is the top of this page and the matchup list is underneath it.

   ⚠ NET, NOT SHARES. "You have 6 shares of Jacobs" is the number that is easy to compute and wrong to
     act on — it ignores the two leagues where he is beating you. Sorted by |net| so the players who
     actually swing your afternoon come first, in either direction. See api/src/lib/rooting.js.

   ⚠ AND IT ONLY POLLS WHEN THERE IS SOMETHING TO POLL. Every refresh is one request that fans out across
     every league server-side; it stops entirely when the tab is hidden, and slows right down when no game
     is in progress, because a Tuesday does not need a 45-second heartbeat.
   ================================================================================================ */
import React, { useState, useEffect, useMemo, useRef } from "react";
import { api } from "../api.js";
import { Dot, WeekHoverCard, alpha } from "../App.jsx";
import { HoverTable, useHoverCard } from "../hovercard.jsx";
import { winTone } from "../livecache.js";
import WeekStep from "../weekstep.jsx";

const LIVE_MS = 45 * 1000;        // while games are on
const IDLE_MS = 10 * 60 * 1000;   // when nothing has kicked off — the score cannot move, so neither do we

const hubIdOf = (l) => (l && ((l.connect && l.connect.leagueId) || (l.cfg && l.cfg.connect && l.cfg.connect.leagueId) || l.sleeperLeagueId)) || null;
const ownerOf = (l) => (l && (
  (l.connect && (l.connect.ownerUsername || l.connect.username))
  || (l.cfg && l.cfg.connect && (l.cfg.connect.ownerUsername || l.cfg.connect.username))
)) || null;
const r1 = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : n);

/* Three states, and only one of them is certain. `pre` comes from a kickoff time we hold, so it is a fact;
   the other two are a window around kickoff, because no feed this app talks to reports a game clock. The
   wording leans on the certain one. */
const STATE = {
  pre:  { label: "yet to play", tone: "var(--gold)", icon: "ti-clock" },
  live: { label: "in progress", tone: "var(--pos)", icon: "ti-player-play" },
  done: { label: "played",      tone: "var(--mut)", icon: "ti-check" },
  unknown: { label: "—",        tone: "var(--mut)", icon: "ti-help" },
};

/* ⭐⭐⭐⭐⭐ HOW BIG A DAY IS THIS, FOR A PLAYER LIKE HIM — 29p.
   Trey: "I also want to color code the projected points based on their impact against you (I don't want QBs
   to always be high since their scoring is high)."

   Raw points are the wrong scale for colour and always have been: quarterbacks average around 18 a week and
   kickers around 8, so a heat map on the raw number paints every QB hot and every kicker cold and tells you
   nothing except which position each man plays — information already on the row.

   What matters is how far above or below a NORMAL week for his position he is. Fourteen from a kicker is a
   great day; fourteen from a quarterback is a bad one. The baselines below are ordinary starter weeks in a
   PPR league, and the colour is the z-ish distance from that baseline, so "unusually good" looks the same
   whoever produced it.

   ⚠ NEUTRAL IS THE DEFAULT AND MOST ROWS SHOULD BE NEUTRAL. If every row is coloured, none of them are —
     the band has to be wide enough that only a genuinely notable day lights up. */
const BASE = { QB: 18, RB: 11, WR: 11, TE: 8, K: 8, DEF: 7, DST: 7, DL: 7, LB: 8, DB: 7 };
const SPREAD = { QB: 7, RB: 6, WR: 6, TE: 5, K: 4, DEF: 5, DST: 5, DL: 4, LB: 4, DB: 4 };
/* ⭐⭐⭐⭐⭐ A MAN IN THE SECOND QUARTER IS NOT HAVING A BAD WEEK — 29t.
   ==================================================================================================
   The impact score compared points on the board against a full NORMAL WEEK for the position, which is
   right for a finished game and badly wrong for one still being played. Jared Goff, 7.4 points with
   most of a game left, scored −1.5 against an 18-point quarterback baseline and was painted in the
   "well below" red — the colour that means a bust. He was, in fact, exactly on pace.

   This is the same error as the projected totals and "nobody left to play", in its last hiding place:
   treating a partial score as a final one. Every live row on the board was tinted toward failure, and
   the effect was strongest early in a game, when the colour is least earned and most misleading.

   So the yardstick shrinks to the share of the game that has actually been played: a quarterback 40%
   of the way through his game is measured against 40% of a quarterback's week. The SPREAD shrinks by
   the square root of that share rather than in proportion, because variance accumulates with playing
   time — halving the minutes does not halve the uncertainty, and dividing by a proportionally tiny
   spread would send the first touchdown of the afternoon straight off the scale.
   ⚠ AND THE SHARE IS FLOORED. Two minutes in, `elapsed` is nearly zero and every number divided by it
     is enormous; below the floor there is no honest reading to give, so the row stays neutral. */
const IMPACT_MIN_ELAPSED = 0.15;
function impactOf(pos, pts, rootFor, elapsed) {
  if (!Number.isFinite(pts) || !pos) return { z: null, tone: null, label: null };
  const part = Number.isFinite(elapsed) ? Math.max(0, Math.min(1, elapsed)) : 1;
  if (part < IMPACT_MIN_ELAPSED) return { z: null, tone: null, label: `${r1(pts)} — too early in the game to read` };
  const full = BASE[String(pos).toUpperCase()] ?? 10;
  const base = Math.round(full * part * 10) / 10;
  const spread = (SPREAD[String(pos).toUpperCase()] ?? 6) * Math.sqrt(part);
  const z = (pts - base) / spread;
  if (part < 1) {
    /* Mid-game the sentence has to say what it is comparing against, or "an ordinary week" next to 7.4
       points reads as a contradiction rather than as good news. */
    const lbl = `${r1(pts)} — ${Math.abs(z) < 0.6 ? "about on pace for" : z > 0 ? "ahead of pace for" : "behind pace for"} a normal ${String(pos).toUpperCase()} week (~${base} by this point)`;
    const g = rootFor ? z : -z;
    if (g >= 1.2) return { z: r1(z), tone: "var(--pos)", label: lbl };
    if (g >= 0.6) return { z: r1(z), tone: "var(--pos-soft)", label: lbl };
    if (g <= -1.2) return { z: r1(z), tone: "var(--neg)", label: lbl };
    if (g <= -0.6) return { z: r1(z), tone: "var(--neg-soft)", label: lbl };
    return { z: r1(z), tone: "var(--ink)", label: lbl };
  }
  /* A big day is GOOD if he is yours and BAD if he is theirs — the colour follows the consequence to you,
     which is the whole premise of this page, rather than following the size of the number. */
  const good = rootFor ? z : -z;
  const label = `${r1(pts)} — ${Math.abs(z) < 0.6 ? "an ordinary week" : z > 0 ? "well above" : "well below"} a normal ${String(pos).toUpperCase()} week (~${base})`;
  if (good >= 1.2) return { z: r1(z), tone: "var(--pos)", label };
  if (good >= 0.6) return { z: r1(z), tone: "var(--pos-soft)", label };
  if (good <= -1.2) return { z: r1(z), tone: "var(--neg)", label };
  if (good <= -0.6) return { z: r1(z), tone: "var(--neg-soft)", label };
  return { z: r1(z), tone: "var(--ink)", label };
}

/* ⭐⭐⭐⭐⭐ ONE MATCHUP, OPENED OUT — 29q.
   ================================================================================================
   Trey: "With the 'your matchups' I want you to be able to click on each matchup and it shows a detailed
   breakdown to basically shows you your odds, your decisions, what to root for. Right now, it's just ugly
   and I don't know what I'm looking at."

   The collapsed row answers "am I winning". This answers the three questions that come straight after it,
   and it answers them for THIS matchup rather than across the whole afternoon:

     • THE ODDS, said in words. "22%" is a number; "you are 15.2 behind with three still to play, and they
       are projected to add 39 more" is the reason for it. The row prints the figure; this prints the
       arithmetic behind the figure, because a probability you cannot see the working of is a horoscope.

     • WHAT TO ROOT FOR, scoped to one matchup. The cross-league board is the right answer to "who do I
       want to score" in general and the WRONG one here — a player who is net +4 across your leagues can
       still be the man beating you in this one. So this lists the two remaining rosters plainly: yours to
       root for, theirs to root against, in this matchup only.

     • WHAT YOU CAN STILL DO. Lineup changes are My Week's job and are computed there from the whole
       roster, bench included, which this payload does not carry. So it LINKS rather than reimplementing
       half of it — a second, worse lineup engine that disagreed with the first would be far more use to
       nobody than a link.

   ⚠ NO NEW ARITHMETIC. Every number here already exists on the payload; this is a layout, not a model.
     A detail panel that recomputed the projection would eventually disagree with the row above it.
   ================================================================================================ */
function MatchupDetail({ L, F, tone, bySid, wide, onOpenHub }) {
  const nameOf = (sid) => {
    const p = bySid.get(String(sid));
    return p ? p : { sid, name: `Player ${sid}`, pos: null, team: null, state: "unknown" };
  };
  const side = (s) => (s && s.players ? s.players : []);
  /* ⚠ "STILL TO PLAY" INCLUDES MEN ON THE FIELD — 29t. `played` now means his game is OVER; a live player
     has points on the board and more to come, which is exactly the row you most want to see here. */
  /* ⚠⚠⚠⚠ THE ORDER OF THESE TWO SPREADS IS THE WHOLE ROW — b158, and it was the wrong way round.
     `nameOf` returns the entry from `data.rooting`, which exists to identify a player ACROSS leagues, and
     its `pts` is deliberately an OBJECT — `{lo, hi, median, varies}` — because the same afternoon is worth
     different points under different scoring. Spreading it SECOND overwrote this league's numeric `pts`
     with that object, on every live row, on every matchup, for as long as this screen has existed.
     ⭐ TWO THINGS BROKE AND BOTH WERE SILENT. React drops an object child without a word, so the
       points-so-far figure beside every live player simply WAS NOT THERE — a blank where "30.2" belongs,
       on the screen you sit on during the games. And the hover built in b151 to end the "Sleeper says 22,
       the site says 27.4" arguments read "[object Object] on the board + 22.4 projected × 57% of his game
       still to play" — the one instrument meant to make the next disagreement diagnosable in a single
       screenshot, printing garbage in its first field.
     ⚠ THIS IS THE SECOND TIME IN THIS FILE. The note by `F.me` twenty lines below records the identical
       failure: "`forecast.me` IS A SIDE, NOT A NUMBER... React drops an object child silently, so the
       column was simply blank while the win% beside it worked perfectly."
     ⭐ THE RULE: rooting supplies IDENTITY (name, position, team, opponent); the per-league row is
       authoritative for everything it measures. So identity goes down first and the row wins. */
  const left = (s) => side(s).filter((pp) => pp.phase ? pp.phase !== "done" : !pp.played)
    .map((pp) => ({ ...nameOf(pp.sid), ...pp }))
    .sort((a, b) => (b.proj || 0) - (a.proj || 0));
  const mine = left(L.me), theirs = left(L.opp);

  /* A plain function, CALLED — a component declared during render is a new type every render and React
     remounts its whole subtree. See src/App.jsx `posGrid`. */
  const rosterSide = ({ rows, label, who, rootFor, empty }) => (
    <div key={label} style={{ minWidth: 0 }}>
      {/* ⚠ THE TEAM NAME IS A SUFFIX, NOT PART OF THE SENTENCE. Built into the label it produced
          "ROOT AGAINST — THEM PLAYERS STILL TO PLAY" the moment an opponent was called "Them", and
          plenty of real team names read no better in the possessive. */}
      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: ".05em", fontWeight: 800,
        color: rootFor ? "var(--pos)" : "var(--neg)", marginBottom: 4 }}>
        <i className={`ti ${rootFor ? "ti-arrow-up" : "ti-arrow-down"}`} style={{ fontSize: 11, marginRight: 4 }} aria-hidden="true" />
        {label}
        {who ? <span className="mut" style={{ fontWeight: 600, letterSpacing: 0, textTransform: "none", marginLeft: 6 }}>{who}</span> : null}
      </div>
      {rows.length ? rows.map((pp) => (
        <div key={pp.sid} data-gdmatchplayer={pp.name} style={{ display: "flex", alignItems: "center",
          gap: 7, fontSize: 12, padding: "3px 0" }}>
          <span style={{ flexShrink: 0 }}><Dot pos={pp.pos} /></span>
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{pp.name}</span>
          <span className="mut" style={{ fontSize: 10, flexShrink: 0 }}>{pp.pos}{pp.team ? ` · ${pp.team}` : ""}</span>
          {/* A live man shows what he HAS and what he is heading for; a man yet to start has only the
              projection. Two numbers where there are two, one where there is one.
              ⭐⭐⭐⭐⭐ AND A LIVE ONE SHOWS ITS OWN ARITHMETIC — b151. Trey: "Both Sleeper and the website have
              the same points currently (18.5). The projected points is way different though (Sleeper: 22 /
              site: 27.4)." Two sites agreeing on the score and disagreeing on the finish can only differ in
              two places — the full-game projection, or how much of the game each thinks is left — and the
              screen showed NEITHER, so the only way to find out was for me to guess from a sandbox that
              cannot reach his league. Now the row states the sum it performed. The fix to the clock is in
              rooting.js; this is so the next disagreement takes one message instead of three. */}
          <span title={pp.phase === "live" && Number.isFinite(pp.projFinal)
            ? `${r1(pp.pts) || 0} on the board + ${Number.isFinite(pp.proj) ? r1(pp.proj) : "?"} projected for the full game × ${Math.round((pp.remain || 0) * 100)}% of his game still to play = ${r1(pp.projFinal)}`
            : undefined}
            style={{ flexShrink: 0, minWidth: 64, textAlign: "right",
              cursor: pp.phase === "live" ? "help" : "default" }}>
            {pp.phase === "live" && Number.isFinite(pp.pts) && (
              <span className="num" style={{ fontSize: 12, fontWeight: 800, color: "var(--ink)", marginRight: 4 }}>{r1(pp.pts)}</span>
            )}
            <span className="num" data-gdlivemath={pp.phase === "live"
              ? `${r1(pp.pts) || 0}|${Number.isFinite(pp.proj) ? r1(pp.proj) : ""}|${pp.remain != null ? pp.remain : ""}|${Number.isFinite(pp.projFinal) ? r1(pp.projFinal) : ""}` : undefined}
              style={{ fontSize: 12, fontWeight: 700,
                color: rootFor ? "var(--pos)" : "var(--neg)" }}>
              {pp.phase === "live" && Number.isFinite(pp.projFinal) ? `→${r1(pp.projFinal)}`
                : Number.isFinite(pp.proj) ? r1(pp.proj) : "—"}
            </span>
          </span>
        </div>
      )) : <div className="mut" style={{ fontSize: 11.5 }}>{empty}</div>}
    </div>
  );

  /* The odds in a sentence, built from the same three numbers the row prints. Deliberately says what is
     LEFT rather than restating the projected final, which is already two columns to the left. */
  const behindBy = F && Number.isFinite(F.margin) ? r1(Math.abs(F.margin)) : null;
  const liveMargin = L.opp ? r1(L.me.pts - L.opp.pts) : null;
  const myRest = F && F.me ? r1(F.me.remaining) : null;
  const theirRest = F && F.opp ? r1(F.opp.remaining) : null;

  return (
    <div data-gdmatchdetail={L.leagueId} style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--line)" }}>
      {F && (
        <div data-gdodds style={{ fontSize: 12.5, lineHeight: 1.6, marginBottom: 10 }}>
          <span style={{ color: tone ? tone.color : "var(--ink)", fontWeight: 800 }}>
            {Math.round(F.win * 100)}% to win
          </span>
          <span className="mut">
            {" — "}
            {liveMargin != null && (liveMargin === 0 ? "level right now"
              : liveMargin > 0 ? `up ${liveMargin} right now` : `down ${r1(Math.abs(liveMargin))} right now`)}
            {mine.length || theirs.length
              ? `, with ${mine.length} of yours and ${theirs.length} of theirs still to play`
              : ", and nobody left to play"}
            {myRest != null && theirRest != null && (mine.length || theirs.length)
              ? `. Projections add ${myRest} to you and ${theirRest} to them`
              : ""}
            {behindBy != null && F.margin < 0 ? `, leaving you ${behindBy} short.` : "."}
          </span>
          {/* ⚠ SAY WHEN THE FORECAST IS INCOMPLETE. A starter we hold no projection for carries a full
              starter's worth of uncertainty and none of his expected points, which pulls the number
              toward the middle — worth knowing before you act on it. */}
          {F.unknown > 0 && (
            <div className="mut" style={{ fontSize: 11, marginTop: 3 }}>
              {F.unknown} starter{F.unknown === 1 ? " has" : "s have"} no projection, so this is rougher than usual.
            </div>
          )}
          {F.settled && (
            <div className="mut" style={{ fontSize: 11, marginTop: 3 }}>Everyone has played — this one is final.</div>
          )}
        </div>
      )}

      <div style={{ display: "grid", gap: wide ? 20 : 12,
        gridTemplateColumns: wide ? "minmax(0,1fr) minmax(0,1fr)" : "minmax(0,1fr)" }}>
        {rosterSide({ rows: mine, label: "Root for — still to play", who: (L.me && L.me.teamName) || null,
          rootFor: true, empty: "All of yours have played." })}
        {rosterSide({ rows: theirs, label: "Root against — still to play", who: (L.opp && L.opp.teamName) || null,
          rootFor: false, empty: "All of theirs have played." })}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        <button className="btn btn-mini" data-gdmatchhub onClick={onOpenHub}>
          <i className="ti ti-layout-dashboard" style={{ fontSize: 12, marginRight: 4 }} aria-hidden="true" />
          Open this team
        </button>
        <span className="mut" style={{ fontSize: 11, alignSelf: "center" }}>
          Lineup changes and waiver ideas for this league live on My Week.
        </span>
      </div>
    </div>
  );
}

/* ⭐⭐⭐⭐ ONE PLAYER, ONE ROW — 29o.
   Trey: "On web, though, I'd probably just show Root For and Root Against side by side. There's a ton of
   blank space between the player name and the points right now, so I think we can use that space much more
   effectively."
   Two things fix that space rather than one. Splitting into two columns halves the row width, which closes
   most of the gap by itself; and the space that IS left now carries the LEAGUE NAMES, which were previously
   hidden behind a hover icon. "Starting in 5" tells you the size of your stake; "Work League, Dynasty,
   Home League +2" tells you where it is, which is the thing you were going to hover to find out. */
function RootRow({ p, wide, wx, onShow, onHide }) {
  const st = STATE[p.state] || STATE.unknown;
  const rootFor = p.net > 0;
  /* ⭐⭐⭐⭐⭐ THE LEAGUE LINE IS A CARD NOW — 29ae.
     Trey: "can you make it prettier when you hover a player and the leagues they are in… show the leagues
     better, show the impact he has on that lineup, show who his opponent is, what the weather is, etc."
     The row had a `title` attribute reading "For: A, B, C  |  Against: D" — a list of names with nothing
     beside them, which is the least useful shape this particular fact has. ⭐ THE MISSING COLUMN IS THE
     ONE HE NAMED FIRST: the same catch is worth 1.0 in PPR and 0 in standard, so "he is in five of your
     leagues" understates the spread wildly in one direction or the other. `ptsByLeague` has been on this
     payload since the board was built and nothing had ever drawn it. */
  const tip = (() => {
    const side = (arr, which) => (arr || []).filter(Boolean).map((l) => ({
      League: l.leagueName || l.leagueId,
      Side: which,
      Pts: Number.isFinite(p.ptsByLeague && p.ptsByLeague[l.leagueId]) ? r1(p.ptsByLeague[l.leagueId]) : "—",
      tone: which === "For you" ? "var(--pos)" : "var(--neg)",
    }));
    const rows = side(p.forLeagues, "For you").concat(side(p.againstLeagues, "Against you"));
    if (!rows.length) return null;
    const lines = [];
    /* `opp` arrives pre-formatted as "@ KC" or "vs KC" — see connect.js `gameByTeam`. Composing it here
       would mean this screen deciding home/away, which it cannot see. */
    if (p.opp) lines.push({ k: "Game", v: `${p.team || "?"} ${p.opp}` });
    lines.push({ k: "Status", v: st.label, tone: st.tone });
    if (p.impactLabel) lines.push({ k: "Day", v: p.impactLabel, tone: p.impactTone });
    /* ⚠ WEATHER ONLY WHEN THERE IS WEATHER, AND SAY WHAT SILENCE MEANS. The forecast route deliberately
       returns ONLY games worth flagging — roofed stadiums never come back at all (29x, on his
       instruction), and neither does a clear afternoon. So a missing line here means "nothing worth
       planning around", not "we could not find out", and the note says which. */
    if (wx) lines.push({ k: "Weather", v: wx.label, tone: wx.tone });
    return {
      key: "gdplayer", title: p.name,
      subtitle: [p.pos, p.team].filter(Boolean).join(" · "),
      lines,
      cols: [{ k: "League", strong: true }, { k: "Side", tint: true }, { k: "Pts", right: true }],
      rows,
      note: wx ? null : "No weather flagged for this game — it is indoors, or the forecast has nothing worth planning around.",
    };
  })();
  const tone = p.net === 0 ? "var(--mut)" : rootFor ? "var(--pos)" : "var(--neg)";
  /* ⚠ DROP THE BLANKS. The live route did not put a name on its league rows until b136, so every tag came
     back undefined and this line rendered as ", , +2" — the "it's not clear what is going on below each
     player" in his screenshot. The server is fixed; this filter means a future gap degrades to showing
     fewer names rather than to punctuation. */
  const names = (rootFor ? p.forLeagues : p.againstLeagues).map((l) => l && l.leagueName).filter(Boolean);
  const shown = names.slice(0, wide ? 3 : 0);
  const extra = names.length - shown.length;
  return (
    <div data-gdplayer={p.name} style={{ display: "flex", alignItems: "center", gap: 9,
      padding: "8px 10px", borderTop: "1px solid var(--line)", flexWrap: "wrap" }}>
      {/* The net, first on the row. Sign carried by an arrow as well as a colour, so the direction survives
          greyscale and colourblindness — this is the one number on the page you act on. */}
      <span data-gdnet={String(p.net)} style={{ flexShrink: 0, width: 40, textAlign: "center",
        fontSize: 13.5, fontWeight: 800, color: tone, display: "inline-flex", alignItems: "center",
        justifyContent: "center", gap: 2 }}>
        <i className={`ti ${p.net === 0 ? "ti-minus" : rootFor ? "ti-arrow-up" : "ti-arrow-down"}`}
          style={{ fontSize: 13 }} aria-hidden="true" />
        {p.net === 0 ? "0" : `${Math.abs(p.net)}`}
      </span>
      <span style={{ flexShrink: 0 }}><Dot pos={p.pos} /></span>
      <div style={{ flex: "1 1 130px", minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13.5, fontWeight: 700 }}>{p.name}</span>
          <span className="mut" style={{ fontSize: 10.5 }}>{p.pos}{p.team ? ` · ${p.team}` : ""}</span>
          <span style={{ fontSize: 10, color: st.tone, display: "inline-flex", alignItems: "center", gap: 3 }}>
            <i className={`ti ${st.icon}`} style={{ fontSize: 11 }} aria-hidden="true" />{st.label}
          </span>
        </div>
        <div className="mut" data-gdleagues={String((p.forLeagues || []).length + (p.againstLeagues || []).length)}
          onMouseEnter={tip && onShow ? (e) => onShow(e, tip) : undefined}
          onMouseLeave={tip && onHide ? onHide : undefined}
          style={{ fontSize: 11, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis",
            whiteSpace: "nowrap", cursor: tip ? "help" : "default" }}>
          {shown.length ? (
            <>{shown.join(", ")}{extra > 0 ? ` +${extra}` : ""}
              {/* Both sides only when he is genuinely on both — otherwise it is noise on every row. */}
              {rootFor && p.against > 0 && <span style={{ color: "var(--neg)" }}> · against you in {p.against}</span>}
              {!rootFor && p.for > 0 && <span style={{ color: "var(--pos)" }}> · starting in {p.for}</span>}
            </>
          ) : (
            <>
              {p.for > 0 && <span style={{ color: "var(--pos)" }}>starting in {p.for}</span>}
              {p.for > 0 && p.against > 0 && <span> · </span>}
              {p.against > 0 && <span style={{ color: "var(--neg)" }}>against you in {p.against}</span>}
            </>
          )}
        </div>
      </div>
      {/* ⚠ A RANGE WHEN THE LEAGUES DISAGREE. The same catch is 1.0 in PPR and 0 in standard, so one
          number would be true in none of his leagues. */}
      {p.pts && (
        /* ⭐⭐⭐⭐ COLOURED BY IMPACT, NOT BY TOTAL — 29p. Trey: "I also want to color code the projected
           points based on their impact against you (I don't want QBs to always be high since their scoring
           is high)." A QB's 24 and a kicker's 24 are not the same event: one is an ordinary Sunday, the
           other is the best kicking week of the year. So the colour reads how far ABOVE OR BELOW a normal
           week for that position he is, and the number stays plain. See impactOf. */
        <span className="num" data-gdpts data-gdimpact={p.impact == null ? "" : String(p.impact)}
          title={p.impactLabel || undefined}
          style={{ fontSize: 12.5, fontWeight: 800, flexShrink: 0, textAlign: "right",
            minWidth: 52, color: p.state === "pre" ? "var(--mut)" : (p.impactTone || "var(--ink)") }}>
          {p.pts.varies ? `${r1(p.pts.lo)}–${r1(p.pts.hi)}` : r1(p.pts.median)}
        </span>
      )}
    </div>
  );
}

export default function GameDay({ leagues, onHome, onBack, backLabel, onOpenHub, embedded }) {
  const [data, setData] = useState(null);
  /* ⭐⭐⭐⭐ "For the 'game day' tab, we need to be able to toggle between different weeks." — 29w.
     NULL means the backend's current week (which since b143 rolls forward once the week's games are done);
     a number is the user driving the stepper and is passed through verbatim. */
  const [weekSel, setWeekSel] = useState(null);
  /* Same reasoning as My Week: the stepper's home is the week the backend picks when nothing is selected,
     not the week currently on screen — otherwise stepping away also moves "home" and the reset vanishes. */
  const [autoWeek, setAutoWeek] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [side, setSide] = useState("all");     // all | for | against — the MOBILE control
  const [at, setAt] = useState(null);
  const ranFor = useRef(null);

  /* ⭐⭐⭐ THE TOGGLE IS A PHONE CONTROL, NOT A DESIGN. Trey: "I like the Game Day concept and being able to
     click between Everyone, Root For, and Root Against. I think that makes a lot of sense on mobile. On web,
     though, I'd probably just show Root For and Root Against side by side."
     Exactly right: on a phone the two lists cannot sit next to each other so you have to choose, and on a
     desktop making you choose hides half the answer behind a click for no reason. Same data, two layouts. */
  const [wide, setWide] = useState(true);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(min-width: 900px)");
    const read = () => setWide(mq.matches);
    read();
    // Safari before 14 has no addEventListener on MediaQueryList; the deprecated form still works there.
    if (mq.addEventListener) { mq.addEventListener("change", read); return () => mq.removeEventListener("change", read); }
    mq.addListener(read); return () => mq.removeListener(read);
  }, []);

  const connected = useMemo(() => (leagues || []).filter((l) => hubIdOf(l)), [leagues]);

  useEffect(() => {
    const ids = connected.map(hubIdOf);
    const sig = ids.join(",") + "@" + (weekSel == null ? "auto" : weekSel);
    if (!ids.length) { setLoading(false); return; }
    let alive = true;
    let timer = null;

    const load = async (quiet) => {
      if (!quiet) setLoading(true);
      try {
        const r = await api.sleeperLive(ids, weekSel == null ? undefined : weekSel, connected.map(ownerOf));
        if (!alive) return;
        setData(r); setAt(Date.now()); setErr(null);
        if (weekSel == null && r && Number.isFinite(r.week)) setAutoWeek(r.week);
      } catch (e) {
        if (alive && !quiet) setErr(String((e && e.message) || e));
      } finally { if (alive) setLoading(false); }
    };

    /* The cadence follows the games, not the clock. A page with nothing in progress is a page whose
       numbers cannot change, and hammering it would cost somebody else their live draft sync. */
    const schedule = () => {
      if (timer) clearTimeout(timer);
      const anyLive = !!(data && (data.rooting || []).some((p) => p.state === "live"));
      timer = setTimeout(async () => {
        if (typeof document === "undefined" || !document.hidden) await load(true);
        schedule();
      }, anyLive ? LIVE_MS : IDLE_MS);
    };

    if (ranFor.current !== sig) { ranFor.current = sig; load(false); }
    schedule();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [connected, weekSel, data && data.at]);

  /* ⭐⭐⭐ "I also want to be able to toggle to players that haven't played vs. already played vs. all."
     Three different Sundays: before kickoff you are reading the slate, at 4pm you want only the men still
     on a field, and afterwards you want the damage report.
     ⚠ DECLARED ABOVE EVERY MEMO THAT USES IT, and that is not a style preference. These first went in next
       to `forRows` further down, which left the `board` memo above referencing them before initialisation —
       a temporal-dead-zone error that BUILDS PERFECTLY and throws the instant the screen renders. The
       bundler cannot see it; only opening the page does. */
  const [phase, setPhase] = useState("all");   // all | live | pre | done
  /* ⭐⭐⭐⭐⭐ TWO WAYS TO READ A SUNDAY, AND YOU PICK ONE — 29q.
     Trey: "I want there to be a toggle to view it as a league or player level. That way you don't have to
     scroll all the way down."
     The page had both stacked: the rooting board, then twelve matchups underneath it. With fifteen leagues
     that is a screen and a half of scrolling to answer "am I winning", every time, and the board you
     scrolled past is not the thing you wanted. They are two views of one afternoon — who to root for, and
     where you stand — so they become a toggle instead of a column.
     ⚠ PLAYERS IS THE DEFAULT because it is the half no platform can show you. Sleeper already has your
       scoreboard; nothing but this has your net stake across fifteen leagues. */
  const [view, setView] = useState("players");  // players | leagues
  // Which matchup rows are opened out. Keyed by league id, so a poll refresh does not close them.
  const [openMatch, setOpenMatch] = useState({});
  /* ⭐⭐⭐⭐⭐ THE SAME HOVER PANEL THE HOME STRIP HAS USED SINCE 29r — 29ae.
     Trey, about this table: "I want to be able to hover things like 'left to play' and see who is left…
     'projected' and see the side by side lineups, etc."
     ⭐ HE IS ASKING FOR A FEATURE THAT ALREADY EXISTS ONE SCREEN OVER, which is the whole reason to import
       `WeekHoverCard` rather than write it again here. Both tables are fed by the SAME live payload
       (`live.leagues` on home, `data.leagues` here — one route, one shape), so a second implementation
       would have had nothing to do but drift. The 29ac/29aa lesson, applied before it could bite.
     ⚠ NOT the generic HoverTable from hovercard.jsx: this one draws a matchup — two lineups, a forecast,
       a win probability — and flattening it into a list card would lose the comparison that is the point. */
  // The generic list card, for the player rows' league breakdown. See src/hovercard.jsx.
  const { card: ptip, show: showPlayerCard, hide: hidePlayerCard } = useHoverCard();
  /* ⭐⭐⭐ THE FORECAST, JOINED BY NFL TEAM. My Week already loads this for its own tab; Game Day is the
     screen you sit on while the games happen, and "is he in the rain" belongs on the player you are
     looking at rather than one tab away. One call, cached by the browser, and a failure is silent — a
     missing forecast must never stop the board rendering. */
  const [wx, setWx] = useState(null);
  /* ⚠⚠ ITS OWN EFFECT, AND THAT IS NOT TIDINESS — IT IS THE ONLY WAY IT WORKS. The first cut fired this
     inside the live loader, right after `setData(r)`. That loader lists `data && data.at` in its own
     dependencies, so setting the data RE-RUNS THE EFFECT, React tears the previous one down first, and the
     cleanup flips `alive` to false on the weather promise that is still in the air. The response came back
     200 every time and `setWx` was never reached — the network tab showed a perfectly healthy request and
     the hover showed "no weather flagged" for a game with heavy snow in it.
     Same family as the 29t review-tab hang: AN EFFECT THAT SETS STATE IT ALSO DEPENDS ON CANCELS ANYTHING
     ELSE IT STARTED. A second resource on a different cadence belongs in a second effect.
     ⭐ Keyed on the resolved WEEK, so it fetches once per week rather than once per two-minute poll — a
       forecast does not move on the cadence a live scoreboard does. */
  useEffect(() => {
    const wk = weekSel == null ? (data && data.week) : weekSel;
    if (!Number.isFinite(wk)) return;
    let alive = true;
    // Swallowed on purpose: no forecast is a missing line on a hover, never a board that will not draw.
    api.weatherWeek(wk).then((w) => { if (alive) setWx(w); }).catch(() => {});
    return () => { alive = false; };
  }, [weekSel, data && data.week]);
  const wxByTeam = useMemo(() => {
    const m = new Map();
    ((wx && wx.games) || []).forEach((g) => (g.teams || []).forEach((t) => m.set(t, g)));
    return m;
  }, [wx]);
  const wxFor = (p) => {
    const g = p && p.team ? wxByTeam.get(p.team) : null;
    if (!g) return null;
    // `label` and `text` are the route's own words (see routes/weather.js); nothing is re-worded here.
    return { label: [g.label, g.text].filter(Boolean).join(" — "),
      tone: g.severity >= 2 ? "var(--neg)" : "var(--gold)" };
  };
  const [mcard, setMcard] = useState(null);
  const showMatchCard = (e, L, kind) => {
    const r = e.currentTarget.getBoundingClientRect();
    const w = kind === "both" || kind === "left" ? 520 : 340;
    setMcard({ L, kind, x: Math.max(8, Math.min(r.left, window.innerWidth - w - 8)), y: r.bottom + 6 });
  };
  const hideMatchCard = () => setMcard(null);
  /* ⚠ THE SHARE OF THE GAME PLAYED COMES OFF THE ROW, NOT OUT OF A DATE SUBTRACTION HERE — 29t.
     The first cut computed it client-side from the payload's `at` stamp minus its kickoff map. That is
     two fields which only share a clock when one machine produced both, and it failed the first time it
     was looked at: the stub stamps `at` from the real clock while its games sit on a fixed timeline, so
     every live player came back as 100% finished and the mid-game colouring below never ran. The server
     now sends `elapsed` from the same function the forecast's `remain` comes from. Falling back to a half
     for a live row keeps an older payload readable rather than uncoloured. */
  const elapsedOf = (p) => (Number.isFinite(p.elapsed) ? p.elapsed
    : p.state === "done" ? 1 : p.state === "live" ? 0.5 : null);
  const decorate = (p) => {
    const rootFor = p.net > 0;
    const pts = p.pts ? p.pts.median : null;
    const im = impactOf(p.pos, pts, rootFor, elapsedOf(p));
    return { ...p, impact: im.z, impactTone: im.tone, impactLabel: im.label };
  };
  /* ⭐⭐⭐⭐⭐ "PLAYED" MEANS PLAYED, NOT "NOT YET TO PLAY" — 29q.
     Trey: "we need to check the 'yet to play' button. Right now it's showing me that I have no one yet to
     play… but Monday night football is tonight."

     This read `p.state !== "pre"` for the Played bucket, which quietly swept up every player whose kickoff
     time we do not hold — and a player we cannot time is exactly the one the Monday night game produces
     when the schedule is a week short. So a starter who has not taken a snap was filed under "played" and
     vanished from "yet to play", and the screen whose job is to tell you what is left told him nothing
     was. Three states, three meanings, and the unknown ones are surfaced below rather than absorbed into
     whichever bucket happens to be adjacent. */
  /* ⭐⭐⭐⭐ FOUR CHIPS, BECAUSE THERE ARE THREE PHASES — 29t. Trey: "The players that are still playing
     should also still show up in 'left'." Playing now is its own answer to "what is left" and its own
     answer to "who should I be watching", and folding it into either neighbour loses it. */
  const inPhase = (p) => (phase === "all" ? true : phase === "pre" ? p.state === "pre"
    : phase === "live" ? p.state === "live" : p.state === "done");
  const phaseCount = (k) => ((data && data.rooting) || []).filter((p) => (k === "all" ? true
    : k === "pre" ? p.state === "pre" : k === "live" ? p.state === "live" : p.state === "done")).length;
  /* Starters with no kickoff time at all. Named, not counted: "3 players" is a bug report, "Kelce, Mahomes
     and Rice have no kickoff time" is a diagnosis, and it points straight at the schedule job. */
  const untimed = useMemo(() => ((data && data.rooting) || []).filter((p) => p.state === "unknown"), [data]);

  const board = useMemo(() => {
    const all = (data && data.rooting) || [];
    const rows = side === "for" ? all.filter((p) => p.net > 0)
      : side === "against" ? all.filter((p) => p.net < 0)
      : all.filter((p) => p.net !== 0 || p.for + p.against > 1);
    return rows.filter(inPhase).map(decorate).slice(0, 40);
  }, [data, side, phase]);

  // The two columns the desktop layout uses. Same ordering rule as the single list: biggest swing first.
  const forRows = useMemo(() => ((data && data.rooting) || []).filter((p) => p.net > 0).filter(inPhase).map(decorate).slice(0, 25), [data, phase]);
  const againstRows = useMemo(() => ((data && data.rooting) || []).filter((p) => p.net < 0).filter(inPhase).map(decorate).slice(0, 25), [data, phase]);

  /* ⭐⭐⭐⭐⭐ WHAT TO PUT ON — 29q.
     ------------------------------------------------------------------------------------------------
     Trey: "I think this tab could also just have more info / sections for 'game day'."

     The section this page was missing is the one a Sunday actually asks: of the games still to come,
     which one matters most to me? The board answers "who", the matchups answer "where", and neither
     answers "when" — "9 of your starters yet to play" treats the 1pm slate, the 4:25 window and Sunday
     night as one undifferentiated pile, when they are three separate decisions about the next three hours.

     So: remaining starters grouped by kickoff, each window carrying its own net exposure. It reads
     "4:25 — 6 for you, 2 against, biggest: Chase +5", which is the sentence that tells you which game to
     turn on and whether you want it to go well.

     ⚠ NET PER WINDOW, NOT A HEADCOUNT. Same reasoning as the board itself: four players in a window with
       two of them on your opponents' rosters is not "four to watch", it is a wash. `net` is summed across
       the window's players for exactly the reason it exists on each row.
     ⚠ AND IT IS EMPTY-SAFE IN BOTH DIRECTIONS. No schedule loaded → no windows and the section does not
       render (rather than one bucket labelled "unknown" containing everything). Nothing left to play →
       it does not render either, because at 11pm the honest answer is that there is nothing to watch.
     ------------------------------------------------------------------------------------------------ */
  const windows = useMemo(() => {
    const kicks = (data && data.kickoffs) || null;
    if (!kicks || !Object.keys(kicks).length) return [];
    const byTime = new Map();
    ((data && data.rooting) || []).forEach((p) => {
      if (p.state !== "pre") return;              // only games that have NOT started — the certain state
      const iso = p.team ? kicks[String(p.team)] : null;
      if (!iso) return;
      if (!byTime.has(iso)) byTime.set(iso, []);
      byTime.get(iso).push(p);
    });
    return [...byTime.entries()]
      .map(([iso, players]) => {
        const sorted = [...players].sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
        return {
          iso, at: Date.parse(iso), players: sorted,
          net: players.reduce((s, p) => s + p.net, 0),
          forN: players.reduce((s, p) => s + p.for, 0),
          againstN: players.reduce((s, p) => s + p.against, 0),
          top: sorted[0] || null,
        };
      })
      .sort((a, b) => a.at - b.at);
  }, [data]);

  const T = (data && data.totals) || null;
  /* ⭐⭐⭐⭐⭐ THE PROJECTED RECORD — 29bm. Trey: "it's showing I'm 0-0-10 across 10 leagues. Can you change
     these numbers to reflect the projections (and make it clear that it's based on projections)." Before
     kickoff every matchup is 0-0, so the live tally is all ties and says nothing. The headline now counts
     each matchup by its projected final (`forecast.me.projected` vs `forecast.opp.projected`, the same
     figures printed on each row) and says "projected" in words; the live tally sits under it. */
  const PT = useMemo(() => {
    const Ls = ((data && data.leagues) || []).filter((L) => L && L.opp && L.forecast && L.forecast.me && L.forecast.opp
      && Number.isFinite(L.forecast.me.projected) && Number.isFinite(L.forecast.opp.projected));
    if (!Ls.length) return null;
    let w = 0, l = 0, t = 0, exp = 0, expN = 0;
    Ls.forEach((L) => {
      const d = L.forecast.me.projected - L.forecast.opp.projected;
      if (Math.abs(d) < 0.05) t++; else if (d > 0) w++; else l++;
      if (Number.isFinite(L.forecast.win)) { exp += L.forecast.win > 1 ? L.forecast.win / 100 : L.forecast.win; expN++; }
    });
    return { w, l, t, n: Ls.length, exp: expN === Ls.length ? Math.round(exp * 10) / 10 : null };
  }, [data]);

  /* Every starter on the payload, by id — the board already holds one entry per player with his name,
     position, team and game state, so the matchup drill-down can name a roster without a second lookup. */
  const bySid = useMemo(() => {
    const m = new Map();
    ((data && data.rooting) || []).forEach((p) => m.set(String(p.sid), p));
    return m;
  }, [data]);

  return (
    <div data-screen="gameday" style={{ minHeight: embedded ? 0 : "100vh", background: "var(--bg)" }}>
      {/* Inside the in-season shell the tab strip IS the header, so this one would be a second title bar
          stacked on the first. See InSeason.jsx. */}
      {!embedded && (
        <div className="hairline appheader" style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 16px", flexWrap: "wrap" }}>
          <button className="btn btn-mini" onClick={onBack || onHome}>← {backLabel || "Home"}</button>
          <span className="disp" style={{ fontSize: 18, fontWeight: 800 }}>Game day</span>
          {data && <span className="chip" style={{ fontSize: 11, padding: "2px 8px", borderRadius: 99, border: "1px solid var(--line)", color: "var(--mut)" }}>
            NFL Week {data.week}
          </span>}
          <span className="mut" style={{ marginLeft: "auto", fontSize: 11 }}>
            {at ? `updated ${new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}
            {data && (data.rooting || []).some((p) => p.state === "live") ? " · refreshing every 45s" : " · no games in progress"}
          </span>
        </div>
      )}

      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "16px 16px 40px" }}>
        {!connected.length && (
          <div className="panel mut" style={{ padding: 18, fontSize: 13 }}>
            Game day needs connected leagues — it reads live rosters and scores from the platform.
          </div>
        )}
        {err && <div className="panel" style={{ padding: 14, marginBottom: 12, color: "var(--red)", fontSize: 13 }}>{err}</div>}
        {loading && !data && <div className="panel mut" style={{ padding: 18, fontSize: 13 }}>Reading every league…</div>}

        {/* ===================== THE DAY, IN ONE LINE ===================== */}
        {T && (
          <div className="panel" data-gdtotals style={{ padding: 14, marginBottom: 14 }}>
            {PT ? (
              <>
                <div className="disp" data-gdprojrec={`${PT.w}-${PT.l}-${PT.t}`} style={{ fontSize: 19, fontWeight: 800, marginBottom: 2 }}>
                  Projected {PT.w}-{PT.l}{PT.t ? `-${PT.t}` : ""} across {PT.n} league{PT.n === 1 ? "" : "s"}
                </div>
                <div className="mut" data-gdliverec={`${T.winning || 0}-${T.losing || 0}-${T.tied || 0}`} style={{ fontSize: 11.5, marginBottom: 8 }}>
                  Based on each matchup's projected final score{PT.exp != null ? `, about ${PT.exp} expected wins from the win odds` : ""}.
                  On the board right now: {T.winning || 0}-{T.losing || 0}{T.tied ? `-${T.tied}` : ""}.
                </div>
              </>
            ) : (
              <div className="disp" style={{ fontSize: 19, fontWeight: 800, marginBottom: 6 }}>
                {T.winning}–{T.losing}{T.tied ? `–${T.tied}` : ""} across {T.leagues} league{T.leagues === 1 ? "" : "s"}
              </div>
            )}
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 12 }}>
              {T.close > 0 && <span><b className="num" style={{ color: "var(--gold)" }}>{T.close}</b>
                <span className="mut"> still within 15</span></span>}
              {/* ⭐⭐⭐ THE NUMBER THAT SAYS WHETHER A DEFICIT IS REAL. Down twenty with four still to play
                  is a different afternoon from down twenty with none, and the scoreline alone says the
                  opposite of the truth. */}
              <span><b className="num" style={{ color: "var(--pos)" }}>{T.yetToPlay}</b>
                <span className="mut"> of your starters yet to play</span></span>
              <span><b className="num" style={{ color: "var(--neg)" }}>{T.oppYetToPlay}</b>
                <span className="mut"> of theirs</span></span>
              <span className="mut">{r1(T.pointsFor)} for · {r1(T.pointsAgainst)} against</span>
            </div>
            {data && !data.scheduleKnown && (
              <div className="mut" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.5 }}>
                ⚠ The NFL schedule has not been loaded for this season, so "yet to play" cannot be counted —
                run Update schedule from admin. Scores are unaffected.
              </div>
            )}
          </div>
        )}

          {/* ⭐⭐⭐⭐⭐ THE PAGE DIAGNOSES ITSELF WHEN THE SCHEDULE IS SHORT — 29q.
              Every state on this screen is derived from kickoff times, so a missing schedule row does not
              produce an error, it produces a confident wrong answer: players sorted into the wrong bucket
              and a Monday night game that simply is not there. This says which players we could not time,
              which teams they play for, and what fixes it — so the next person to hit this reads the
              cause off the screen instead of filing "yet to play is broken". */}
          {untimed.length > 0 && (
            <div className="panel" data-gduntimed={String(untimed.length)}
              style={{ padding: "9px 12px", marginBottom: 14, borderColor: "var(--gold)",
                background: "rgba(224,166,60,.07)" }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "var(--gold)" }}>
                <i className="ti ti-calendar-off" style={{ fontSize: 13, marginRight: 5 }} aria-hidden="true" />
                {untimed.length} player{untimed.length === 1 ? " has" : "s have"} no kickoff time
              </div>
              <div className="mut" style={{ fontSize: 11.5, lineHeight: 1.55, marginTop: 3 }}>
                {untimed.slice(0, 6).map((p) => `${p.name}${p.team ? ` (${p.team})` : ""}`).join(", ")}
                {untimed.length > 6 ? `, +${untimed.length - 6} more` : ""}
                {" — "}the NFL schedule is missing {(data && data.scheduleMissing && data.scheduleMissing.length)
                  ? `these teams this week: ${data.scheduleMissing.join(", ")}` : "those games"}.
                {" "}They can't be sorted into yet-to-play or played, so they appear only under All.
                Running <b style={{ color: "var(--ink)" }}>Pull schedule</b> in Admin fixes it.
              </div>
            </div>
          )}

          {/* ⭐⭐⭐⭐ THE OTHER WAY THE TWO SOURCES DISAGREE — 29ag / b148.
              Trey, at 12:21 in the morning: "DJ Moore plays on Thursday, but his game hasn't started yet.
              Because of that, he is showing up with a 0 projection AND he isn't listed as left to play."
              The stats feed had a line for a man whose game was still twenty hours away, and the old rule
              let that overrule the kickoff time — so a Thursday starter was filed as FINISHED, which drops
              him out of "left to play" and multiplies his remaining projection by zero. The clock wins now.
              ⚠ BUT THE DISAGREEMENT IS STILL WORTH SEEING, and it is the same reasoning as the panel above:
                if the feed is publishing empty shells ahead of kickoff this is harmless noise, and if OUR
                schedule is stale for those teams it is not — and the only way anyone can tell which is to
                be able to read the number. Silently picking a winner is what hid this in the first place. */}
          {!!(data && data.statBeforeKickoff && data.statBeforeKickoff.length) && (
            <div className="panel" data-gdearlystat={String(data.statBeforeKickoff.length)}
              style={{ padding: "9px 12px", marginBottom: 14, borderColor: "var(--gold)",
                background: "rgba(224,166,60,.07)" }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "var(--gold)" }}>
                <i className="ti ti-clock-exclamation" style={{ fontSize: 13, marginRight: 5 }} aria-hidden="true" />
                {data.statBeforeKickoff.length} stat line{data.statBeforeKickoff.length === 1 ? "" : "s"} ahead of kickoff
              </div>
              <div className="mut" style={{ fontSize: 11.5, lineHeight: 1.55, marginTop: 3 }}>
                {data.statBeforeKickoff.slice(0, 6).map((sid) => {
                  const p = ((data && data.rooting) || []).find((r) => String(r.sid) === String(sid));
                  return p ? `${p.name}${p.team ? ` (${p.team})` : ""}` : `Player ${sid}`;
                }).join(", ")}
                {data.statBeforeKickoff.length > 6 ? `, +${data.statBeforeKickoff.length - 6} more` : ""}
                {" — "}Sleeper reports stats for them, but the schedule says their game hasn't kicked off.
                {" "}They're being counted as <b style={{ color: "var(--ink)" }}>still to play</b>, which is
                right if those are empty pre-game rows. If their games really are underway, the schedule is
                stale — run <b style={{ color: "var(--ink)" }}>Pull schedule</b> in Admin.
              </div>
            </div>
          )}

        {/* ⭐⭐⭐⭐⭐ THE WEEK TOGGLE — 29w. Trey: "For the 'game day' tab, we need to be able to toggle
            between different weeks."
            It sits here rather than in the header because the header only renders when this screen is
            standalone, and Game Day is normally reached EMBEDDED inside the in-season shell — a control
            placed there would have been invisible in the one place he actually uses it. */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
          <WeekStep week={weekSel == null ? (data && data.week) : weekSel} current={autoWeek}
            busy={loading} onPick={setWeekSel} label="NFL Week" />
          {weekSel != null && data && (
            <span className="mut" style={{ fontSize: 11 }}>
              {/* A past week's board is a record, not a thing to root for — say so rather than letting a
                  frozen page look like a stalled one. */}
              looking at a week that isn't live — scores are final
            </span>
          )}
        </div>

        {/* ⭐⭐⭐⭐ THE TOGGLE, ABOVE BOTH VIEWS. Big enough to be the page's main control, because it is. */}
        {data && (
          <div className="filterchips" data-gdviews style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
            {[["players", "ti-users", "By player", "Who to root for, across every league"],
              ["leagues", "ti-list-details", "By league", "Where each matchup stands"]].map(([k, icon, lbl, title]) => {
              const on = view === k;
              return (
                <button key={k} data-gdview={k} onClick={() => setView(k)} aria-pressed={on} title={title}
                  style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13,
                    fontWeight: on ? 800 : 600, padding: "7px 14px", borderRadius: 9, cursor: "pointer",
                    fontFamily: "inherit",
                    border: `1px solid ${on ? "var(--pos)" : "var(--line2)"}`,
                    color: on ? "#0d1210" : "var(--ink)",
                    background: on ? "var(--pos)" : "transparent" }}>
                  <i className={`ti ${icon}`} style={{ fontSize: 14 }} aria-hidden="true" />{lbl}
                </button>
              );
            })}
          </div>
        )}

        {/* ===================== THE ROOTING BOARD ===================== */}
        {data && view === "players" && (
          <>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
              <span className="disp" style={{ fontSize: 15, fontWeight: 800 }}>Who to root for</span>
              <div className="filterchips" data-gdphases style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                {/* ⭐⭐⭐ THE COUNT IS ON THE CHIP, AND THAT IS NOT DECORATION. An empty list under "Yet to
                    play" is ambiguous in the worst way — it reads identically whether the filter is broken
                    or there is genuinely nobody left, which is precisely the confusion that made this a bug
                    report rather than a shrug. A chip that says "Yet to play 0" answers it before you
                    click, and one that says 4 while the list is empty is a visible contradiction. */}
                {[["all", "All"], ["live", "Playing now"], ["pre", "Yet to play"], ["done", "Played"]].map(([k, lbl]) => (
                  <button key={k} data-gdphase={k} data-gdphasen={String(phaseCount(k))}
                    onClick={() => setPhase(k)} aria-pressed={phase === k}
                    style={{ fontSize: 11, fontWeight: phase === k ? 800 : 600, padding: "2px 9px", borderRadius: 99,
                      cursor: "pointer", fontFamily: "inherit",
                      border: `1px solid ${phase === k ? "var(--pos)" : "var(--line)"}`,
                      color: phase === k ? "var(--pos)" : "var(--mut)",
                      background: phase === k ? "var(--pos-wash)" : "transparent" }}>
                    {lbl} <span style={{ opacity: .7, fontWeight: 600 }}>{phaseCount(k)}</span>
                  </button>
                ))}
              </div>
              {/* The chips are the PHONE control. On a wide screen both lists are on screen at once, so a
                  filter that hides half the answer would be a click that buys nothing. */}
              {!wide && (
                <div className="filterchips" data-gdsides style={{ display: "flex", gap: 5, marginLeft: "auto", flexWrap: "wrap" }}>
                  {[["all", "Everyone"], ["for", "Root for"], ["against", "Root against"]].map(([k, lbl]) => (
                    <button key={k} data-gdside={k} onClick={() => setSide(k)} aria-pressed={side === k}
                      style={{ fontSize: 11.5, fontWeight: side === k ? 800 : 600, padding: "3px 10px", borderRadius: 99,
                        cursor: "pointer", fontFamily: "inherit",
                        border: `1px solid ${side === k ? "var(--gold)" : "var(--line)"}`,
                        color: side === k ? "var(--gold)" : "var(--mut)",
                        background: side === k ? "rgba(224,166,60,.12)" : "transparent" }}>{lbl}</button>
                  ))}
                </div>
              )}
            </div>

            {wide ? (
              /* ⭐⭐⭐⭐⭐ TWO COLUMNS, BOTH ANSWERS AT ONCE — 29o. The whole point of the net is that it has
                 a sign, and putting the two signs side by side is the clearest possible statement of that:
                 the left column is every ball you want caught, the right is every ball you do not. */
              <div data-gdcolumns style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
                {[["for", "Root for", "var(--pos)", "ti-arrow-up", forRows],
                  ["against", "Root against", "var(--neg)", "ti-arrow-down", againstRows]].map(([k, label, tone, icon, list]) => (
                  <div key={k} data-gdcolumn={k} style={{ flex: "1 1 380px", minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
                      <i className={`ti ${icon}`} style={{ fontSize: 13, color: tone }} aria-hidden="true" />
                      <span className="disp" style={{ fontSize: 12.5, fontWeight: 800, color: tone, letterSpacing: ".03em" }}>{label}</span>
                      <span className="mut num" style={{ fontSize: 11 }}>{list.length}</span>
                    </div>
                    <div className="panel" style={{ padding: 6, borderColor: `${alpha(tone, 20)}` }}>
                      {list.length
                        ? list.map((p) => <RootRow key={p.sid} p={p} wide wx={wxFor(p)} onShow={showPlayerCard} onHide={hidePlayerCard} />)
                        : <div className="mut" style={{ fontSize: 12, padding: "10px 4px" }}>
                            {k === "for" ? "Nobody you are net FOR yet." : "Nobody you are net against — a good place to be."}
                          </div>}
                    </div>
                  </div>
                ))}
              </div>
            ) : !board.length ? (
              <div className="panel mut" data-gdempty style={{ padding: 18, fontSize: 13 }}>
                Nobody you have a stake in on more than one side yet. Once lineups lock, this fills up.
              </div>
            ) : (
              <div className="panel" style={{ padding: 6, marginBottom: 16 }}>
                {board.map((p) => <RootRow key={p.sid} p={p} wide={false} wx={wxFor(p)} onShow={showPlayerCard} onHide={hidePlayerCard} />)}
              </div>
            )}

            {/* ===================== WHAT TO WATCH ===================== */}
            {windows.length > 0 && (
              <div data-gdwindows={String(windows.length)} style={{ marginBottom: 18 }}>
                <div className="disp" style={{ fontSize: 15, fontWeight: 800, marginBottom: 8 }}>
                  Still to come
                  <span className="mut" style={{ fontSize: 11.5, fontWeight: 400, marginLeft: 8 }}>
                    your remaining starters, by kickoff
                  </span>
                </div>
                <div style={{ display: "grid", gap: 8,
                  gridTemplateColumns: wide ? "repeat(auto-fit, minmax(240px, 1fr))" : "minmax(0,1fr)" }}>
                  {windows.map((w) => {
                    const good = w.net > 0, flat = w.net === 0;
                    const tone = flat ? "var(--mut)" : good ? "var(--pos)" : "var(--neg)";
                    return (
                      <div key={w.iso} className="panel" data-gdwindow={w.iso} style={{ padding: "10px 12px" }}>
                        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                          <span className="disp" style={{ fontSize: 14, fontWeight: 800 }}>
                            {new Date(w.at).toLocaleTimeString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}
                          </span>
                          {/* Net first and biggest, because it is the answer; the raw counts sit behind it
                              so a wash of 4-for/4-against still reads as four players you care about. */}
                          <span className="num" style={{ fontSize: 14, fontWeight: 800, color: tone }}>
                            {flat ? "even" : `${good ? "+" : ""}${w.net}`}
                          </span>
                          <span className="mut" style={{ fontSize: 11 }}>
                            {w.forN} for · {w.againstN} against
                          </span>
                          <span className="mut" style={{ fontSize: 11, marginLeft: "auto" }}>
                            {w.players.length} player{w.players.length === 1 ? "" : "s"}
                          </span>
                        </div>
                        <div className="mut" style={{ fontSize: 11.5, lineHeight: 1.5, marginTop: 3,
                          overflow: "hidden", textOverflow: "ellipsis" }}>
                          {w.players.slice(0, 4).map((p) => (
                            <span key={p.sid} style={{ marginRight: 9, whiteSpace: "nowrap" }}>
                              <span style={{ color: p.net > 0 ? "var(--pos)" : p.net < 0 ? "var(--neg)" : "var(--mut)" }}>
                                {p.net > 0 ? "↑" : p.net < 0 ? "↓" : "—"}
                              </span>{" "}
                              <span style={{ color: "var(--ink)" }}>{p.name}</span>
                              {p.net !== 0 && <span className="num"> {p.net > 0 ? "+" : ""}{p.net}</span>}
                            </span>
                          ))}
                          {w.players.length > 4 && <span>+{w.players.length - 4} more</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

          </>
        )}

        {/* ===================== THE MATCHUPS ===================== */}
        {data && view === "leagues" && (
          <>
            <div className="disp" style={{ fontSize: 15, fontWeight: 800, marginBottom: 8 }}>Your matchups</div>
            {wide && (
              <div className="mut" style={{ display: "grid", gap: 10, padding: "0 12px 5px",
                gridTemplateColumns: "minmax(0,1.4fr) 132px 132px 108px minmax(0,150px)",
                fontSize: 9.5, textTransform: "uppercase", letterSpacing: ".05em", fontWeight: 700 }}>
                <span>League</span>
                <span style={{ textAlign: "right" }}>Now</span>
                <span style={{ textAlign: "right" }}>Projected</span>
                <span style={{ textAlign: "right" }}>Win</span>
                <span style={{ textAlign: "right" }}>Left to play</span>
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {(data.leagues || []).map((L, i) => {
                const league = connected.find((c) => String(hubIdOf(c)) === String(L.leagueId));
                const name = (league && league.name) || L.leagueName || L.leagueId || "League";
                if (!L.me) {
                  return (
                    <div key={L.leagueId || i} className="panel" data-gdmatch={name} style={{ padding: 12 }}>
                      <span className="disp" style={{ fontSize: 14, fontWeight: 800 }}>{name}</span>
                      <span className="mut" style={{ fontSize: 12, marginLeft: 10 }}>
                        {L.ownerResolved === false ? "Can't tell which team is yours — link that Sleeper account"
                          : L.error ? "Couldn't read this league" : "No matchup this week"}
                      </span>
                    </div>
                  );
                }
                const margin = L.opp ? r1(L.me.pts - L.opp.pts) : null;
                const up = margin != null && margin > 0;
                /* ⭐⭐⭐⭐⭐ THE PROJECTED SCORE BESIDE THE LIVE ONE — b137/29q.
                   Trey: "I want to see the current score AND the projected score", and separately "I love
                   on sleeper how there is color coded projection systems (i.e. 11% projected to win is red
                   // 87% to win is green)."
                   29p put exactly this on the home strip and then left Game Day — the screen you actually
                   sit on during the games — showing only the live scoreline. So the two screens disagreed
                   about the same matchup: home said a projected loss, Game Day said you were up 12. The
                   forecast has been on this payload since b136; it just was not being drawn here. */
                const F = L.forecast || null;
                const tone = F && Number.isFinite(F.win) ? winTone(F.win) : null;
                const open = !!openMatch[L.leagueId];
                return (
                  <div key={L.leagueId || i} className="panel" data-gdmatch={name}
                    style={{ padding: "10px 12px", background: open ? "var(--panel2)" : undefined }}>
                    <div style={{ display: "grid", alignItems: "center", gap: 10,
                      gridTemplateColumns: wide ? "minmax(0,1.4fr) 132px 132px 108px minmax(0,150px)" : "minmax(0,1fr) auto" }}>
                      {/* ⭐⭐⭐⭐ THE NAME OPENS THE BREAKDOWN; IT NO LONGER LEAVES THE PAGE.
                          Trey: "I want you to be able to click on each matchup and it shows a detailed
                          breakdown to basically shows you your odds, your decisions, what to root for."
                          It used to navigate to the league hub — a whole screen away, mid-Sunday, to answer
                          a question about the row you were already looking at. The hub is still one click
                          from inside the opened row, where it is a deliberate departure rather than the
                          only thing the row could do. */}
                      <button data-gdmatchtoggle={name} aria-expanded={open}
                        onClick={() => setOpenMatch((o) => ({ ...o, [L.leagueId]: !o[L.leagueId] }))}
                        style={{ cursor: "pointer", fontFamily: "inherit", background: "none", border: "none",
                          color: "var(--ink)", fontSize: 14, fontWeight: 800, padding: 0, textAlign: "left",
                          minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                          display: "flex", alignItems: "center", gap: 6 }}
                        className="disp">
                        <i className={`ti ${open ? "ti-chevron-down" : "ti-chevron-right"}`}
                          style={{ fontSize: 13, color: "var(--mut)", flexShrink: 0 }} aria-hidden="true" />
                        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{name}</span>
                      </button>
                      <span style={{ textAlign: wide ? "right" : "left" }}>
                        <span className="num" data-gdscore style={{ fontSize: 14, fontWeight: 800,
                          color: margin == null ? "var(--mut)" : up ? "var(--pos)" : margin === 0 ? "var(--mut)" : "var(--neg)" }}>
                          {r1(L.me.pts)}{L.opp ? ` – ${r1(L.opp.pts)}` : ""}
                        </span>
                        {margin != null && (
                          <span style={{ fontSize: 11, fontWeight: 700, marginLeft: 6,
                            color: up ? "var(--pos)" : margin === 0 ? "var(--mut)" : "var(--neg)" }}>
                            {up ? "+" : ""}{margin}
                          </span>
                        )}
                        {!wide && <span className="mut" style={{ fontSize: 9.5, display: "block", textTransform: "uppercase", letterSpacing: ".05em", fontWeight: 700 }}>now</span>}
                      </span>
                      {/* ⚠ `forecast.me` IS A SIDE, NOT A NUMBER. It came back as
                          {scored, remaining, projected, variance, yetToPlay, unknown} and rendering it
                          directly printed nothing at all — React drops an object child silently, so the
                          column was simply blank while the win% beside it worked perfectly. Caught by
                          looking at the screen; no build or type error was ever going to say so. */}
                      {F && F.me && Number.isFinite(F.me.projected) ? (
                        <span data-gdproj={String(r1(F.me.projected))} className="num mut"
                          onMouseEnter={(e) => showMatchCard(e, L, "both")} onMouseLeave={hideMatchCard}
                          style={{ fontSize: 13, fontWeight: 700, textAlign: wide ? "right" : "left", cursor: "help" }}>
                          {r1(F.me.projected)}{F.opp && Number.isFinite(F.opp.projected) ? ` – ${r1(F.opp.projected)}` : ""}
                          {!wide && <span className="mut" style={{ fontSize: 9.5, display: "block", textTransform: "uppercase", letterSpacing: ".05em", fontWeight: 700 }}>projected</span>}
                        </span>
                      ) : <span />}
                      {tone ? (
                        /* ⚠ THE PERCENTAGE IS ALWAYS PRINTED. Red and green are the one pair a colourblind
                           reader cannot separate, and this is the figure the whole row turns on — so the
                           colour reinforces a number and a word rather than carrying the meaning alone. */
                        <span data-gdwin={String(Math.round(F.win * 100))}
                          onMouseEnter={(e) => showMatchCard(e, L, "win")} onMouseLeave={hideMatchCard}
                          style={{ textAlign: wide ? "right" : "left", cursor: "help" }}>
                          <span className="num" style={{ fontSize: 14, fontWeight: 800, color: tone.color }}>
                            {Math.round(F.win * 100)}%
                          </span>
                          <span className="mut" style={{ fontSize: 10, marginLeft: 5 }}>{tone.label}</span>
                        </span>
                      ) : <span />}
                      <span className="mut" data-gdleft={String(L.me.yetToPlay)}
                        onMouseEnter={L.opp ? (e) => showMatchCard(e, L, "left") : undefined}
                        onMouseLeave={L.opp ? hideMatchCard : undefined}
                        style={{ fontSize: 11.5, textAlign: wide ? "right" : "left",
                          cursor: L.opp ? "help" : "default", gridColumn: wide ? "auto" : "1 / -1" }}>
                        {L.me.yetToPlay} yet to play{L.opp ? ` · ${L.opp.yetToPlay} for ${L.opp.teamName || "them"}` : ""}
                      </span>
                    </div>
                    {open && <MatchupDetail L={L} F={F} tone={tone} bySid={bySid} wide={wide}
                      onOpenHub={() => onOpenHub && league && onOpenHub(league.id)} />}
                  </div>
                );
              })}
            </div>
            {/* One panel for the whole table — see the note on `showMatchCard`. */}
            <WeekHoverCard card={mcard} bySid={bySid} winTone={winTone} />
          </>
        )}

        {data && (
            <div className="mut" style={{ fontSize: 11, lineHeight: 1.55, marginTop: 14 }}>
              Scores and per-player points come from each league's own scoring, exactly as the platform settled
              them — nothing here is recomputed, so this can never disagree with your league's scoreboard.
              "Yet to play" is read from NFL kickoff times; whether a game is currently in progress is inferred
              from a window around kickoff rather than a live game clock, so treat it as a good guess and
              "yet to play" as the reliable one.
            </div>
        )}
      </div>
      {/* One card for the whole screen. Mounted at the root rather than inside either layout, because the
          player board renders in two different places depending on width and a card mounted inside one of
          them would simply not exist on a phone. */}
      <HoverTable card={ptip} />
    </div>
  );
}
