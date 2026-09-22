/* ⭐⭐⭐⭐⭐ THE WEEKLY REVIEW, AT WHATEVER SCALE YOU ARE THINKING AT — 29m.
   ================================================================================================
   Trey: "I want this to be able to be looked at within a specific league level (league hub) and also on a
   macro basis for all leagues to review your week across all leagues from the home page."

   Same review, three doors. The macro read is on My Week and answers "how did my Sunday go"; the league
   hub's Review tab answers "how did THIS team's Sunday go" and is where you land when one result is
   nagging at you; the home page is just the shortest route to the first.

   ⚠ ONE COMPONENT, NOT THREE COPIES. The temptation with "show it here as well" is to paste the block into
     the hub and tweak it, and the cost of that arrives later and quietly: the optimal-lineup wording gets
     fixed in one place, a verdict threshold moves in another, and two screens start telling a man with
     fifteen leagues two different things about the same afternoon. The ONLY difference between the scales
     is how many leagues get passed in — everything below is identical, which is why it can be.
   ================================================================================================ */
import React, { useState, useEffect, useMemo, useRef } from "react";
import { api } from "../api.js";
import { useWide } from "../usewide.js";
import { HoverTable, useHoverCard } from "../hovercard.jsx";
import { benchTone, fieldTone } from "../App.jsx";

const r1 = (n) => Math.round(n * 10) / 10;
const hubIdOf = (l) => (l && ((l.connect && l.connect.leagueId) || (l.cfg && l.cfg.connect && l.cfg.connect.leagueId) || l.sleeperLeagueId)) || null;
const ownerOf = (l) => (l && (
  (l.connect && (l.connect.ownerUsername || l.connect.username))
  || (l.cfg && l.cfg.connect && (l.cfg.connect.ownerUsername || l.cfg.connect.username))
)) || null;

/* ⭐⭐⭐⭐ THE FOUR VERDICTS — 29l. Computed on the server (lib/review.js); this is only how they look.
   Two of them are compliments, one is an excuse and one is an accusation, and the colours say which
   without anybody having to read the sentence. `icon` matters as much as `tone`: these are status
   colours, and a status carried by colour alone is unreadable to a chunk of the people using it. */
const VERDICT = {
  robbed:  { label: "Robbed",      tone: "var(--info)",   icon: "ti-mood-annoyed",   blurb: "lost with a top-third score" },
  lucky:   { label: "Got away with it", tone: "var(--gold)", icon: "ti-clover", blurb: "won below the median" },
  blown:   { label: "Blown",       tone: "var(--neg)",   icon: "ti-alert-triangle", blurb: "your best lineup beats them" },
  earned:  { label: "Earned",      tone: "var(--pos)",   icon: "ti-check",          blurb: "the result the scores deserved" },
};

/* The table's column track. Named once so the header row and every body row cannot drift apart — two
   grid-template strings that are "the same" until somebody widens one is the classic way a table stops
   lining up. `minmax(0, …)` on the name column so a long league name ellipses instead of shoving the
   numbers off the right edge. */
/* ⭐⭐⭐⭐⭐ SIX COLUMNS, NOT FOUR WITH TWO OF THEM DOUBLED UP — 29ae.
   Trey, with a screenshot: "can you make it not look so cluttered. Have it's own column for result, result
   vs. median, verdict, etc. It's just tough to follow and there is empty space."
   Both halves of that are one cause. RESULT was carrying two different facts in one cell — the head-to-head
   scoreline AND the median result glued onto its end as "/W med" — so the eye had to parse a sentence in
   the one place a table promises it will not have to. Meanwhile the LEAGUE column was `1.5fr`, which on a
   1500px screen hands it every spare pixel and opens the canyon between the verdict chip and the numbers
   that he is pointing at. Splitting the median out and capping the name column fixes both at once: the
   name still ellipses gracefully, and the slack goes where there is something to read. */
/* ⚠ THE VERDICT TRACK IS SIZED FOR "GOT AWAY WITH IT" — the longest chip — and its contents are RIGHT
   aligned. Left-aligned in a track that wide, every shorter chip ("BLOWN", "EARNED") left a 70px hole
   before the numbers, which is most of the "there is empty space" in his screenshot: the gap was not
   between columns, it was inside one. */
const COLS = "minmax(0,1fr) 116px 80px 152px 100px 76px 30px";

// 1st / 2nd / 3rd / 11th — the English rule, including the teens exception that catches every naive version.
const ord = (n) => {
  if (!Number.isFinite(n)) return "—";
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

/* ⭐⭐⭐⭐ YOUR WEEK AGAINST THE LEAGUE'S WEEK — 29l. "Give weekly trends not just for your matchup, but
   also compare it to the league."
   ------------------------------------------------------------------------------------------------
   ONE data series (you) plus ONE reference (the league median). That distinction drives every choice
   here: the median is not a second team, so it is a recessive grey rule rather than a second bright
   colour, and neither needs a legend box because both are labelled where they are drawn.

   ⚠ RESULT IS ENCODED TWICE, ON PURPOSE. A win is a FILLED marker in green; a loss is a HOLLOW marker in
     red. Shape carries the whole message on its own, which is what makes the chart readable to a
     red-green colourblind reader and in a screenshot printed in grey. (Measured rather than assumed:
     #57C79E against var(--neg) is ΔE 10.1 under deuteranopia — comfortably separated — but the green also
     sits ΔE 14.8 from the grey median rule, which is under the safe floor. The shape difference is what
     makes that irrelevant instead of a problem.)

   ⚠ AND THE CHART IS NEVER THE ONLY COPY OF A NUMBER. Every point here is also a row in the week list
     below it, with the same figures in text. The picture is for the shape of the season; the rows are
     for the values.
------------------------------------------------------------------------------------------------ */
/* ⭐⭐⭐⭐⭐ WHAT THE WEEK ACTUALLY TELLS YOU — 29ad.
   ==================================================================================================
   Trey: "When I'm in my team page and click 'review' I want it to show more detail to basically show my
   decision making, luck, compare to the league, should I be concerned going forward."

   Four questions, and they are genuinely different — which is why the page answered none of them well by
   showing one score and one verdict chip. A loss can be any of: you set a bad lineup, you scored fine and
   drew the week's best team, or you are simply not good enough yet. Those call for three different
   reactions and the scoreline cannot tell them apart.

   ⭐ THE DECOMPOSITION IS THE WHOLE IDEA. A week's result is your SCORING (did you put up a number) and
     your DRAW (what you were up against), and each is measured against the same league distribution so
     they are comparable. Above your own average and beaten by a top-two score is a different week from
     below your average against the worst team in the league, and both can read "L 112–118".

   ⚠⚠ AND THE FORWARD-LOOKING HALF REFUSES TO OVERCLAIM. "Should I be concerned" is a question about a
     TREND, and a trend needs a sample: with two or three weeks played there is no honest answer and this
     says so rather than inventing one from noise. That is the 29p lesson — one measurement is not a
     measurement — applied to what the product tells a person rather than to a benchmark.
   ⚠ Everything here is computed from figures the review payload already carries. Nothing is fetched and
     nothing is inferred about other managers' lineups, which the app cannot see. */
/* ⚠ NO `week` PARAMETER, DELIBERATELY — it was in the first cut's signature and never read, which is worse
   than either choice. The two halves are scoped differently ON PURPOSE: `mine` and `field` are the SELECTED
   week (how that Sunday went, against that Sunday's field), while the season mean and the outlook read
   EVERY finished week, because "should I be concerned going forward" is a question about now no matter
   which week's panel you opened it from. The cell is labelled "Going forward" and its sentence names the
   weeks it used, so the two scopes cannot be mistaken for each other on screen. An ignored parameter would
   have quietly promised the filtering that neither half does. */
export function reviewInsights({ weeks, field, mine }) {
  const rows = (weeks || []).filter((w) => w && w.me && Number.isFinite(w.me.pts) && w.me.complete !== false);
  const me = mine || null;
  if (!me || !Number.isFinite(me.pts)) return null;
  /* ⚠⚠ AN UNFINISHED WEEK GETS NO READ AT ALL. The fixture's week 7 has three starters yet to play, and
     this block cheerfully called it "A loss about where you usually land" off a 61.4 that was still going
     up — while the row three lines above it correctly wore a "3 TO PLAY" chip. Every number here is a
     verdict (where you placed, what you left on the bench, whether your best lineup wins), and not one of
     them is knowable until the last whistle. The row already explains the in-progress state in words, so
     the honest thing is to stay off the page rather than to hedge a read nobody should act on. */
  if (me.complete === false) return null;

  const vals = (field || []).filter(Number.isFinite).slice().sort((a, b) => b - a);
  const n = vals.length;
  // Where a score lands in the week's field, as a rank and as a share of teams beaten.
  const placeOf = (v) => {
    if (!Number.isFinite(v) || !n) return null;
    const beat = vals.filter((x) => x < v).length;
    return { rank: vals.filter((x) => x > v).length + 1, of: n, beat, pct: Math.round((beat / Math.max(1, n - 1)) * 100) };
  };

  const myWeeks = rows.map((w) => w.me.pts);
  const mean = myWeeks.length ? myWeeks.reduce((a, b) => a + b, 0) / myWeeks.length : null;
  const sd = myWeeks.length > 1
    ? Math.sqrt(myWeeks.reduce((a, b) => a + (b - mean) ** 2, 0) / (myWeeks.length - 1)) : null;

  const scoring = {
    pts: r1(me.pts),
    place: placeOf(me.pts),
    mean: mean == null ? null : r1(mean),
    vsOwn: mean == null ? null : r1(me.pts - mean),
    // Only meaningful with a real spread behind it; two weeks do not have one.
    z: sd && sd > 0 && myWeeks.length >= 4 ? Math.round(((me.pts - mean) / sd) * 100) / 100 : null,
  };
  const draw = {
    oppPts: Number.isFinite(me.oppPts) ? r1(me.oppPts) : null,
    place: Number.isFinite(me.oppPts) ? placeOf(me.oppPts) : null,
    median: Number.isFinite(me.medianPts) ? r1(me.medianPts) : null,
  };

  /* DECISIONS. `left` is what the best legal lineup would have added — the only part of a week that was
     entirely inside your control. Ranked against your OWN season, because a league-wide comparison would
     need every rival's bench and the app cannot see it; claiming otherwise would be inventing data. */
  const lefts = rows.map((w) => (Number.isFinite(w.me.left) ? w.me.left : 0));
  const leftMean = lefts.length ? lefts.reduce((a, b) => a + b, 0) / lefts.length : null;
  const decisions = {
    left: r1(Number.isFinite(me.left) ? me.left : 0),
    mean: leftMean == null ? null : r1(leftMean),
    // Would the best lineup have changed the result? The one question a regret figure exists to answer.
    wouldHaveWon: !!(Number.isFinite(me.oppPts) && Number.isFinite(me.optimal)
      && me.pts <= me.oppPts && me.optimal > me.oppPts),
    worst: (me.misses || []).slice().sort((a, b) => (b.gain || 0) - (a.gain || 0))[0] || null,
  };

  /* OUTLOOK. Deliberately conservative: a trend is the last three weeks against everything before them,
     and it is only reported at all once there are enough weeks for the comparison to mean something. */
  const MIN_FOR_TREND = 5;
  const outlook = (() => {
    const sample = rows.length;
    if (sample < MIN_FOR_TREND) {
      return { sample, trend: null, level: "unknown",
        why: `${sample} finished week${sample === 1 ? "" : "s"} is not enough to call a trend — check back around week ${MIN_FOR_TREND}.` };
    }
    const recent = myWeeks.slice(-3);
    const earlier = myWeeks.slice(0, -3);
    const rAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const eAvg = earlier.length ? earlier.reduce((a, b) => a + b, 0) / earlier.length : rAvg;
    const delta = r1(rAvg - eAvg);
    /* ⚠ THE BAR IS A REAL EFFECT, NOT A SIGN CHANGE. Week-to-week fantasy scoring swings by twenty points
       on nothing at all, so "down 1.4" is noise wearing a minus sign. Half a standard deviation of this
       team's own scoring is the smallest move worth mentioning, and where there is no usable spread the
       answer is that there is nothing to say. */
    const bar = sd && sd > 0 ? sd * 0.5 : 12;
    if (Math.abs(delta) < bar) {
      return { sample, trend: delta, level: "steady",
        why: `Your last ${recent.length} weeks average ${r1(rAvg)} against ${r1(eAvg)} before them — inside normal week-to-week noise for your team.` };
    }
    if (delta < 0) {
      return { sample, trend: delta, level: "concern",
        why: `Your last ${recent.length} weeks average ${r1(rAvg)}, down ${r1(Math.abs(delta))} on the ${r1(eAvg)} before them. That is bigger than your usual week-to-week swing.` };
    }
    return { sample, trend: delta, level: "rising",
      why: `Your last ${recent.length} weeks average ${r1(rAvg)}, up ${r1(delta)} on the ${r1(eAvg)} before them.` };
  })();

  /* THE ONE-LINE READ, built from the two halves rather than from the scoreline. This is what makes the
     block worth having: it is allowed to say a win was lucky and a loss was nobody's fault. */
  const headline = (() => {
    const sp = scoring.place, dp = draw.place;
    const scoredWell = sp && sp.rank <= Math.ceil(sp.of / 3);
    const scoredBadly = sp && sp.rank > Math.ceil((sp.of * 2) / 3);
    const hardDraw = dp && dp.rank <= Math.ceil(dp.of / 3);
    const softDraw = dp && dp.rank > Math.ceil((dp.of * 2) / 3);
    const won = me.result === "W";
    /* ⚠⚠ `blown` IS NOT GATED ON A BAD SCORE, AND IT GOES FIRST. It was `!won && scoredBadly &&
       wouldHaveWon`, which sounds reasonable and is wrong: the fixture's week 2 lost by 4.3 with 23.4
       points on the bench and a best lineup that wins the game — but it scored 8th of 12, one place short
       of "bottom third", so this fell through to `even` and the panel read "A loss about where you usually
       land". Four lines above it, the row's own verdict chip said BLOWN. Two claims about the same week,
       on the same panel, disagreeing — which is the failure this whole screen exists to avoid.
       Having the points and not starting them is the most actionable thing a week can contain, so it
       outranks every other read, including a hard draw: if your best lineup wins, the draw did not beat
       you. That is also why it is now the FIRST test rather than the second. */
    if (!won && decisions.wouldHaveWon) return { key: "blown", text: "Your best lineup wins this — the points were on your bench." };
    if (!won && scoredWell && hardDraw) return { key: "robbed", text: `Top-third score, and you drew the week's ${ord(dp.rank)}-best. Nothing to fix here.` };
    if (!won && scoredBadly) return { key: "outscored", text: "A bottom-third score. This one is about the roster, not the draw." };
    if (won && scoredBadly && softDraw) return { key: "lucky", text: `You scored in the bottom third and still won — you drew the ${ord(dp.rank)}-best score of ${dp.of}.` };
    if (won && scoredWell) return { key: "earned", text: "A top-third score and a win. Nothing to second-guess." };
    return { key: "even", text: won ? "A win about where you usually land." : "A loss about where you usually land." };
  })();

  return { scoring, draw, decisions, outlook, headline };
}

function SeasonTrend({ weeks, selected, onPick }) {
  /* ⚠ MEASURED, NOT STRETCHED. The first version drew into a 100x34 viewBox with
     `preserveAspectRatio="none"` and let CSS stretch it to the panel width. Paths survive that; CIRCLES DO
     NOT — every marker came out a flattened ellipse ten times wider than tall, which looked like a
     rendering fault and undid the whole point of using shape to carry win/loss. There is no viewBox that
     fixes it either, because this panel is ~1060px wide on a desktop and ~350px on a phone, so no fixed
     aspect ratio is right for both. The only correct answer is to draw in real pixels at the width the
     element actually has, so a circle is round at every size. */
  const box = React.useRef(null);
  const [w, setW] = React.useState(0);
  React.useEffect(() => {
    const el = box.current;
    if (!el) return;
    const read = () => setW(el.clientWidth || 0);
    read();
    if (typeof ResizeObserver === "undefined") return;   // older browsers: the first measure still holds
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* ⚠ FINISHED WEEKS ONLY — 29s, and for two reasons that both matter.
     A week still being played has a PARTIAL total: plotting 61.4 next to six full weeks around 120 draws a
     cliff that says "you collapsed" about an afternoon that is half over. And it has no league median
     either, which silently removed the median line from the WHOLE chart — `hasMedian` requires every point
     to have one, so a single ungraded week took the reference series with it. Caught by a test that
     asserted the chart draws both lines; it would otherwise have been a quiet loss of the comparison the
     chart exists to make. */
  const pts = (weeks || []).filter((x) => x && x.me && Number.isFinite(x.me.pts) && x.me.complete !== false);
  if (pts.length < 2) return null;
  const H = 74, PAD = 10, PADX = 8;
  const W = Math.max(160, w || 320);
  const vals = pts.flatMap((x) => [x.me.pts, x.me.median].filter(Number.isFinite));
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const span = hi - lo || 1;
  const x = (i) => PADX + (i * (W - PADX * 2)) / Math.max(1, pts.length - 1);
  const y = (v) => H - PAD - ((v - lo) / span) * (H - PAD * 2);
  const line = (key) => pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.me[key]).toFixed(1)}`).join(" ");
  const hasMedian = pts.every((p) => Number.isFinite(p.me.median));

  return (
    <div data-wktrend={String(pts.length)} ref={box} style={{ marginTop: 10 }}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img"
        aria-label={`Points by week against the league median, weeks ${pts[0].week} to ${pts[pts.length - 1].week}`}
        style={{ display: "block", overflow: "visible" }}>
        {/* The median rule first, so the series draws over it. Solid and recessive — a dashed rule reads
            as a projection, and this is a measured fact about every week. */}
        {hasMedian && <path d={line("median")} fill="none" stroke="var(--mut)" strokeWidth="1.25" opacity=".8" />}
        <path d={line("pts")} fill="none" stroke="var(--gold)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {pts.map((p, i) => {
          const won = p.me.result === "W";
          const on = p.week === selected;
          const half = Math.max(12, (W - PADX * 2) / Math.max(1, pts.length - 1) / 2);
          return (
            <g key={p.week}>
              {/* A finger-sized target. An 8px dot you have to hit dead centre is not a control. */}
              <rect x={x(i) - half} y={0} width={half * 2} height={H} fill="transparent" style={{ cursor: "pointer" }}
                onClick={() => onPick && onPick(p.week)}>
                <title>{`Week ${p.week}: you ${r1(p.me.pts)}, league median ${p.me.median != null ? r1(p.me.median) : "—"} — ${won ? "won" : p.me.result === "L" ? "lost" : "tied"}`}</title>
              </rect>
              {/* Selected week gets a halo BEHIND the marker, so it never competes with the win/loss shape. */}
              {on && <circle cx={x(i)} cy={y(p.me.pts)} r={8} fill="none" stroke="var(--gold)" strokeWidth="1.25"
                opacity=".9" style={{ pointerEvents: "none" }} />}
              {/* Filled = won, hollow = lost. Shape carries it; colour only reinforces. The 2px surface ring
                  keeps a marker legible where it sits on top of the line. */}
              <circle cx={x(i)} cy={y(p.me.pts)} r={4.5}
                fill={won ? "var(--pos)" : "var(--panel)"} stroke={won ? "var(--panel)" : "var(--neg)"}
                strokeWidth={won ? 2 : 2} style={{ pointerEvents: "none" }} />
              {!won && <circle cx={x(i)} cy={y(p.me.pts)} r={4.5} fill="none" stroke="var(--neg)" strokeWidth="2"
                style={{ pointerEvents: "none" }} />}
              {/* Only the selected week is labelled. A number on every point is chaos and goes unread. */}
              {on && <text x={x(i)} y={y(p.me.pts) - 13} textAnchor="middle" fill="var(--ink)"
                style={{ fontSize: 10, fontWeight: 700 }}>{r1(p.me.pts)}</text>}
            </g>
          );
        })}
      </svg>
      {/* Direct labels rather than a legend box: two things are drawn, and both can say their own name. */}
      <div className="mut" style={{ display: "flex", gap: 12, fontSize: 10, marginTop: 2, flexWrap: "wrap" }}>
        <span><span style={{ color: "var(--gold)", fontWeight: 800 }}>—</span> your points</span>
        {hasMedian && <span>— league median</span>}
        <span><span style={{ color: "var(--pos)" }}>●</span> won</span>
        <span><span style={{ color: "var(--neg)" }}>○</span> lost</span>
        <span style={{ marginLeft: "auto" }}>wk {pts[0].week}–{pts[pts.length - 1].week}</span>
      </div>
    </div>
  );
}

/* ⭐⭐⭐ THE WEEK ITSELF, AGAINST THE FIELD — every score in the league that week on one axis, yours
   marked. It answers "was 118 a good week?" in the only way that means anything, which is: compared to
   what the other eleven of you did on the same Sunday. */
function FieldStrip({ field, mine, median }) {
  const vals = (field || []).filter(Number.isFinite);
  if (vals.length < 3 || !Number.isFinite(mine)) return null;
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const span = hi - lo || 1;
  const pct = (v) => ((v - lo) / span) * 100;
  return (
    <div data-wkfield={String(vals.length)} style={{ marginTop: 6 }}>
      <div style={{ position: "relative", height: 16 }}>
        <div style={{ position: "absolute", left: 0, right: 0, top: 7.5, height: 1, background: "var(--line2)" }} />
        {vals.map((v, i) => (
          <span key={i} title={`${r1(v)}`} style={{ position: "absolute", left: `calc(${pct(v)}% - 3px)`, top: 5,
            width: 6, height: 6, borderRadius: 99, background: "var(--mut)", opacity: .55,
            boxShadow: "0 0 0 2px var(--panel)" }} />
        ))}
        {Number.isFinite(median) && (
          <span title={`League median ${r1(median)}`} style={{ position: "absolute", left: `calc(${pct(median)}% - 0.5px)`,
            top: 2, width: 1, height: 12, background: "var(--mut)" }} />
        )}
        <span title={`You scored ${r1(mine)}`} style={{ position: "absolute", left: `calc(${pct(mine)}% - 4.5px)`, top: 3.5,
          width: 9, height: 9, borderRadius: 99, background: "var(--gold)", boxShadow: "0 0 0 2px var(--panel)" }} />
      </div>
      <div className="mut" style={{ display: "flex", justifyContent: "space-between", fontSize: 10 }}>
        <span className="num">{r1(lo)}</span>
        <span>every team this week · <span style={{ color: "var(--gold)" }}>●</span> you</span>
        <span className="num">{r1(hi)}</span>
      </div>
    </div>
  );
}

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

/* ⭐⭐⭐ ONE NUMBER, ITS LABEL, AND NOTHING ELSE — 29q.
   The summary band used to be a run of coloured phrases sharing one line: "70.2 points left on benches
   3 lost with a winning lineup available". That is three facts in a sentence, and a sentence is the wrong
   container for figures you want to compare — nothing aligns, nothing can be scanned, and the numbers are
   the same size as the words around them. Tiles fix all three at once. */
function Tile({ n, label, tone, sub }) {
  const on = Number(n) > 0 || (typeof n === "string" && n !== "0");
  return (
    <div data-wktile={label} style={{ minWidth: 92 }}>
      <div className="num" style={{ fontSize: 23, fontWeight: 800, lineHeight: 1.12,
        color: on && tone ? tone : "var(--ink)" }}>{n}</div>
      <div className="mut" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: ".045em",
        fontWeight: 700, marginTop: 1 }}>{label}</div>
      {sub ? <div className="mut" style={{ fontSize: 10.5, marginTop: 1 }}>{sub}</div> : null}
    </div>
  );
}

/* A label above a value, aligned in a grid. Used for the season ledger, which was previously six facts
   run together on one wrapping line where the fifth was "703 (most faced in the league)". */
function Fact({ label, value, tone, note }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div className="mut" style={{ fontSize: 9.5, textTransform: "uppercase", letterSpacing: ".05em", fontWeight: 700 }}>{label}</div>
      <div className="num" style={{ fontSize: 14, fontWeight: 800, color: tone || "var(--ink)", marginTop: 1 }}>{value}</div>
      {note ? <div className="mut" style={{ fontSize: 10.5, lineHeight: 1.35, marginTop: 1 }}>{note}</div> : null}
    </div>
  );
}

export default function WeeklyReview({ leagues, scope = "all", onOpenLeague }) {
  const [raw, setRaw] = useState(null);
  const [week, setWeek] = useState(null);
  const [openMap, setOpenMap] = useState({});
  const [faWhy, setFaWhy] = useState(false);
  const { card: hcard, show: showCard, hide: hideCard } = useHoverCard();
  /* ⭐⭐⭐⭐⭐ WHY THE CHIP SAYS WHAT IT SAYS — 29bm. Trey: "'Got away with it' or 'robbed' or 'earned' - when
     you hover that tag, can you show why... Did I start someone wrong? Did they leave points on the bench?"
     Every figure the verdict was decided on is already on the row's payload: where your score and theirs
     placed in the week's field, how far they were from their own average, and what your best lineup would
     have scored. The card lays those out, then the lineup mistakes by name. (Their bench is the one thing
     we cannot show: the review only carries your roster's full points.) */
  const placeIn = (field, v) => {
    const vals = (field || []).filter(Number.isFinite);
    if (!Number.isFinite(v) || !vals.length) return null;
    return { rank: vals.filter((x) => x > v).length + 1, of: vals.length };
  };
  const verdictCard = (R) => {
    const me = R.me; if (!me || !me.verdict) return null;
    const V = VERDICT[me.verdict.key] || VERDICT.earned;
    const mp = placeIn(R.field, me.pts), op = placeIn(R.field, me.oppPts);
    const lines = [
      { k: "You scored", v: `${r1(me.pts)}${mp ? `, ${ord(mp.rank)} of ${mp.of} this week` : ""}`, strong: true },
      Number.isFinite(me.oppPts) ? { k: "They scored", v: `${r1(me.oppPts)}${op ? `, ${ord(op.rank)} of ${op.of}` : ""}${Number.isFinite(me.oppSwing) ? ` (${me.oppSwing >= 0 ? "+" : "-"}${r1(Math.abs(me.oppSwing))} on their average)` : ""}` } : null,
      Number.isFinite(me.median) ? { k: "League median", v: `${r1(me.median)}` } : null,
      me.allPlay ? { k: "Vs the field", v: `${me.allPlay.w}-${me.allPlay.l}${me.allPlay.t ? `-${me.allPlay.t}` : ""}` } : null,
      { k: "Your bench", v: me.left > 0
          ? `${r1(me.left)} points left there. Your best lineup scored ${r1(me.optimal)}${Number.isFinite(me.oppPts) ? (me.optimal > me.oppPts ? ", enough to win" : ", still not enough") : ""}`
          : "You started your best lineup", tone: me.left > 0 ? "var(--gold)" : "var(--pos)" },
    ].filter(Boolean);
    const rows = (me.misses || []).slice(0, 4).map((m) => ({ Slot: m.slot, Started: `${m.out} ${m.outPts}`, "Should have": `${m.in} ${m.inPts}`, Cost: `-${m.gain}` }));
    return { key: `verdict:${R.league.id}`, title: `${V.label}: why`, subtitle: me.verdict.text, lines,
      cols: rows.length ? [{ k: "Slot" }, { k: "Started" }, { k: "Should have" }, { k: "Cost", right: true }] : null, rows,
      note: rows.length ? null : "No lineup mistakes this week." };
  };
  /* ⭐⭐⭐⭐ WHERE YOUR SCORE LANDED IN THE LEAGUE — 29bn. Trey: "When you hover vs. Median on review, can you
     show where my total points ranked that week compared to the league. You can just list from highest to
     lowest scored with team name and points scored with a line where the median starts." Every team's score
     for the week is on the payload (`pointsByRoster`); the line sits between the top half and the rest. */
  const fieldCard = (R) => {
    const w = R.w; if (!w || !w.pointsByRoster) return null;
    const names = new Map(((R.data && R.data.teams) || []).map((t) => [String(t.rosterId), t.teamName || t.ownerName || `Team ${t.rosterId}`]));
    const myId = String(R.data && R.data.myRosterId);
    const oppId = R.me && R.me.oppRosterId != null ? String(R.me.oppRosterId) : null;
    const list = Object.entries(w.pointsByRoster).filter(([, v]) => Number.isFinite(v)).sort((a, b) => b[1] - a[1]);
    if (!list.length) return null;
    const vals = list.map(([, v]) => v).slice().sort((a, b) => a - b);
    const h = Math.floor(vals.length / 2);
    const med = R.me && Number.isFinite(R.me.medianPts) ? R.me.medianPts : R.me && Number.isFinite(R.me.median) ? R.me.median
      : (vals.length % 2 ? vals[h] : (vals[h - 1] + vals[h]) / 2);
    const rows = [];
    let lined = false;
    list.forEach(([rid, v], i) => {
      if (!lined && v < med) {
        lined = true;
        rows.push({ "#": "", Team: <span data-wkmedianline style={{ color: "var(--gold)", fontWeight: 800, fontSize: 10, letterSpacing: ".05em" }}>MEDIAN {r1(med)}</span>, Points: "" });
      }
      const me = rid === myId;
      rows.push({ "#": String(i + 1), Team: <span style={{ fontWeight: me ? 800 : 400, color: me ? "var(--gold)" : undefined }}>{names.get(rid) || `Team ${rid}`}{me ? " (you)" : rid === oppId ? " (opponent)" : ""}</span>,
        Points: r1(v), tone: me ? "var(--gold)" : undefined });
    });
    const mine = list.findIndex(([rid]) => rid === myId);
    return { key: `field:${R.league.id}`, title: `Week ${week}: every score in ${R.league.name}`,
      subtitle: mine >= 0 ? `You scored ${r1(list[mine][1])}, ${ord(mine + 1)} of ${list.length}` : undefined,
      cols: [{ k: "#", w: 22 }, { k: "Team" }, { k: "Points", right: true, tint: true, strong: true }], rows };
  };
  /* ⭐⭐⭐⭐ THE RESULT, SIDE BY SIDE — 29bm. "When I hover the 'result' on this, can you show the side by
     side of both teams and what we scored." Slot by slot, from the lineups the review now carries (b168). */
  const resultCard = (R) => {
    const me = R.me; if (!me) return null;
    const a = me.lineup || [], b = me.oppLineup || [];
    const n = Math.max(a.length, b.length);
    if (!n) return null;
    const nm = (x) => (x && x.name) || (x ? "(empty)" : "");
    const pt = (x) => (x && Number.isFinite(x.pts) ? r1(x.pts) : x ? "0" : "");
    const rows = Array.from({ length: n }, (_, i) => {
      const x = a[i], y = b[i];
      const d = (x && Number.isFinite(x.pts) ? x.pts : 0) - (y && Number.isFinite(y.pts) ? y.pts : 0);
      return { Pos: (x && x.slot) || (y && y.slot) || "", You: nm(x), "Your pts": pt(x), Them: nm(y), "Their pts": pt(y),
        tone: d > 0.05 ? "var(--pos)" : d < -0.05 ? "var(--neg)" : undefined };
    });
    rows.push({ Pos: "", You: "Total", "Your pts": r1(me.pts), Them: "Total", "Their pts": Number.isFinite(me.oppPts) ? r1(me.oppPts) : "" });
    return { key: `result:${R.league.id}`, title: `Week ${week}: ${r1(me.pts)} to ${Number.isFinite(me.oppPts) ? r1(me.oppPts) : "?"}`,
      width: 600, wrap: true, estHeight: 60 + n * 22, prefer: "left",
      cols: [{ k: "Pos", w: 44 }, { k: "You", w: 170 }, { k: "Your pts", right: true, tint: true, strong: true }, { k: "Them", w: 170 }, { k: "Their pts", right: true }],
      rows };
  };
  /* The projected finish for the weeks still in play. Read from the SHARED live cache rather than computed
     here — the home strip, Game Day and this page must agree about the same Sunday, and three independent
     forecasts is three chances to disagree. */
  const [outlook, setOutlook] = useState(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { cachedLive, loadLive } = await import("../livecache.js");
        const lv = cachedLive(leagues) || await loadLive(leagues);
        if (!alive || !lv || !lv.record) return;
        setOutlook(lv.record);
      } catch { /* no forecast: the settled record still stands on its own */ }
    })();
    return () => { alive = false; };
  }, [leagues]);
  const [loading, setLoading] = useState(false);
  const ranFor = useRef(null);
  const wide = useWide(820);

  const connected = useMemo(() => (leagues || []).filter((l) => hubIdOf(l)), [leagues]);

  useEffect(() => {
    const sig = connected.map((l) => hubIdOf(l)).join(",");
    if (!sig || ranFor.current === sig) return;
    ranFor.current = sig;
    let alive = true;
    setLoading(true);
    (async () => {
      const out = await pool(connected, 4, (l) => api.sleeperSeasonReview(hubIdOf(l), ownerOf(l)));
      if (!alive) return;
      const mapped = connected.map((league, i) => ({
        league, data: out[i] && !out[i].error ? out[i] : null, error: out[i] && out[i].error,
      }));
      setRaw(mapped);
      /* Open on the most recent week ANY league has finished. Opening on week 1 in November would be
         technically defensible and useless; the week you want to review is the one that just happened.
         ⭐⭐⭐⭐ AND "FINISHED" MEANS FINISHED — 29s. `lastCompletedWeek` is the newest week the review
         COVERS, which is not the same thing: Sleeper rolls `display_week` forward while the Monday night
         game is still to play, so the newest covered week routinely has starters who have not kicked off.
         That is the week Trey was looking at when he found the Kenneth Walker line. Landing there means
         landing on a page whose entire purpose — second-guessing a finished result — does not apply yet,
         with no verdict, no regret and no bench figure. So the default is the newest week that is actually
         over; the live one is still one click away in the picker, and says what it is when you get there. */
      const covered = Math.max(0, ...mapped.map((r) => (r.data && r.data.lastCompletedWeek) || 0));
      const finished = Math.max(0, ...mapped.flatMap((r) => ((r.data && r.data.weeks) || [])
        .filter((x) => x && x.me && x.me.complete !== false).map((x) => x.week)));
      const last = finished || covered;
      setWeek((w) => (w == null && last ? last : w));
      /* At league scale there is one card and nothing to choose between, so it opens already expanded —
         clicking "Detail" on a list of one is a step that exists only because the macro view needed it. */
      if (scope === "league" && mapped.length === 1 && mapped[0].data) {
        setOpenMap({ [mapped[0].league.id]: true });
      }
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [connected, scope]);

  const data = useMemo(() => {
    if (!raw || week == null) return null;
    const rows2 = raw.map((r) => {
      if (!r.data) return { league: r.league, error: r.error || "no data" };
      const w = (r.data.weeks || []).find((x) => x.week === week) || null;
      return { league: r.league, data: r.data, w, me: w && w.me ? w.me : null,
        field: w ? Object.values(w.pointsByRoster || {}) : [] };
    });
    const played = rows2.filter((r) => r.me);
    /* ⭐⭐⭐⭐⭐ A WEEK STILL BEING PLAYED IS NOT A RESULT — 29r.
       Trey: "At the top of the review… it shows I'm 8-2 across 10 leagues. This is what it is based on the
       current scores, but again, I expect that to be closer to 5-5 with projections."

       Third time this category error has surfaced, in a third place, which says something about how
       naturally it creeps in: a scoreline is always AVAILABLE, so anything that counts wins will happily
       count a game with eight players still to play. The server now marks those weeks `complete: false`
       (see the Kenneth Walker note in connect.js) and refuses to grade them, and the headline splits in
       two — what is settled, and where the rest is heading. */
    const live = played.filter((r) => r.me.complete === false);
    const settled = played.filter((r) => r.me.complete !== false);
    const sum = {
      leagues: played.length,
      settledN: settled.length,
      liveN: live.length,
      // The record, counted ONLY over weeks that have finished.
      w: settled.filter((r) => r.me.result === "W").length
        + settled.filter((r) => r.me.medianResult === "W").length,
      l: settled.filter((r) => r.me.result === "L").length
        + settled.filter((r) => r.me.medianResult === "L").length,
      // How many of those came from the median half, so the headline can explain an odd-looking total.
      medianGames: settled.filter((r) => r.me.medianResult).length,
      // What the unfinished ones are waiting on, so "3 still playing" can name names.
      waiting: live.flatMap((r) => (r.me.waitingOn || []).map((n) => ({ n, league: r.league.name }))).slice(0, 8),
      /* ⚠ ONLY FROM FINISHED WEEKS, and not only because of the record. Mid-week `left` is misleading in
         a specific direction — the optimal lineup counts players who have scores while your own total is
         missing the points your unplayed starter is about to add — so it reads as waste that has not
         happened yet. See `pending` in lib/review.js. */
      left: r1(settled.filter((r) => !r.me.pending).reduce((s, r) => s + (r.me.left || 0), 0)),
      blown: settled.filter((r) => r.me.verdict && r.me.verdict.key === "blown").length,
      robbed: settled.filter((r) => r.me.verdict && r.me.verdict.key === "robbed").length,
      lucky: settled.filter((r) => r.me.verdict && r.me.verdict.key === "lucky").length,
      /* ⭐⭐⭐ THE HONEST VERSION OF "HOW DID I DO". A 0–3 week against three opponents is three data
         points; the same week against every team in all three leagues is thirty-odd, and that is the
         number that says whether you scored badly or drew badly. It was previously buried one sentence
         deep inside each league row, which is the least useful place for the figure that reframes the
         headline sitting directly above it. */
      apW: settled.reduce((s, r) => s + ((r.me.allPlay && r.me.allPlay.w) || 0), 0),
      apL: settled.reduce((s, r) => s + ((r.me.allPlay && r.me.allPlay.l) || 0), 0),
      apAny: settled.some((r) => r.me.allPlay),
    };
    /* ⚠ AND THE WORST CALL COMES FROM FINISHED WEEKS ONLY. "Started Kenneth Walker 0 over Chubba Hubbard
       22.2" was this line reading a regret out of a game that had not kicked off. */
    let worst = null;
    settled.forEach((r) => (r.me.misses || []).forEach((m) => {
      if (!worst || m.gain > worst.gain) worst = { ...m, leagueName: r.league.name };
    }));
    const maxWeek = Math.max(0, ...raw.map((r) => (r.data && r.data.lastCompletedWeek) || 0));
    return { rows: rows2, sum, worst, maxWeek };
  }, [raw, week]);

  if (!connected.length) {
    return (
      <div className="panel mut" data-wkempty="review" style={{ padding: 18, fontSize: 13 }}>
        A review needs a connected league — there is no record of a lineup we never saw.
      </div>
    );
  }

  return (
    <div data-weeklyreview={scope}>
      <HoverTable card={hcard} />
              {loading && !raw && (
                <div className="panel mut" style={{ padding: 18, fontSize: 13 }}>Reading every completed week…</div>
              )}

              {data && !data.maxWeek && (
                <div className="panel" data-wkempty="review" style={{ padding: 18 }}>
                  <div className="disp" style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>No completed weeks yet</div>
                  <div className="mut" style={{ fontSize: 13 }}>The review opens once a week has finished — there is nothing to
                    second-guess about a week still being played.</div>
                </div>
              )}

              {data && !!data.maxWeek && week != null && (
                <>
                  {/* One control row, above everything it scopes. */}
                  <div data-wkweekpicker style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
                    <button className="btn btn-mini" data-wkweekprev disabled={week <= 1}
                      onClick={() => setWeek((w) => Math.max(1, w - 1))} aria-label="Previous week">
                      <i className="ti ti-chevron-left" aria-hidden="true" />
                    </button>
                    <div className="filterchips" style={{ display: "flex", gap: 4, flexWrap: "wrap", flex: "1 1 auto" }}>
                      {Array.from({ length: data.maxWeek }, (_, i) => i + 1).map((w) => (
                        <button key={w} data-wkweek={w} onClick={() => setWeek(w)} aria-pressed={w === week}
                          className="chip" style={{ fontSize: 11.5, fontWeight: w === week ? 800 : 600,
                            padding: "3px 9px", borderRadius: 99, cursor: "pointer", fontFamily: "inherit",
                            border: `1px solid ${w === week ? "var(--gold)" : "var(--line)"}`,
                            color: w === week ? "var(--gold)" : "var(--mut)",
                            background: w === week ? "rgba(224,166,60,.12)" : "transparent" }}>
                          {w}
                        </button>
                      ))}
                    </div>
                    <button className="btn btn-mini" data-wkweeknext disabled={week >= data.maxWeek}
                      onClick={() => setWeek((w) => Math.min(data.maxWeek, w + 1))} aria-label="Next week">
                      <i className="ti ti-chevron-right" aria-hidden="true" />
                    </button>
                  </div>

                  {/* ⭐⭐⭐⭐⭐ THE SUMMARY AND THE REVIEW ARE ONE OBJECT — 29q.
                      Trey: "can we just combine the 'Summary' and 'Weekly Review' — I like the info being
                      shared in each, but they kind of belong together AND they are ugly. A lot of text and
                      hard to follow."

                      He is right on both counts and they have the same cause. They were two stacked panels
                      because they were written a week apart, and the seam showed: the band told you the
                      week was 0–3 and then a second panel told you the same thing three more times, each in
                      a paragraph of prose. Three leagues produced three near-identical sentences, and on a
                      phone each one wrapped to three lines — a screen of text you have to READ to find one
                      number in.

                      One panel now: a band of figures, then the leagues as a TABLE under it. What made it
                      ugly was never the information, it was that every value lived inside a sentence, so
                      nothing lined up with anything and the numbers were the same weight as the words. In a
                      table the same facts are columns you can run your eye down, and the sentences — which
                      are genuinely good when you want one — move into the row you opened deliberately. */}
                  <div className="panel" data-wkreviewsum style={{ padding: 0, overflow: "hidden" }}>
                    <div style={{ padding: "13px 15px 12px" }}>
                      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
                        <span className="disp" style={{ fontSize: 18, fontWeight: 800 }}>Week {week}</span>
                        <span className="num" style={{ fontSize: 18, fontWeight: 800,
                          color: data.sum.w > data.sum.l ? "var(--pos)" : data.sum.l > data.sum.w ? "var(--neg)" : "var(--mut)" }}>
                          {data.sum.w}–{data.sum.l}
                        </span>
                        {data.sum.medianGames > 0 && (
                          <span className="mut" style={{ fontSize: 11.5 }}>
                            (incl. {data.sum.medianGames} median game{data.sum.medianGames === 1 ? "" : "s"})
                          </span>
                        )}
                        <span className="mut" style={{ fontSize: 12 }}>
                          {data.sum.liveN > 0
                            ? `settled, across ${data.sum.settledN} of ${data.sum.leagues} league${data.sum.leagues === 1 ? "" : "s"}`
                            : `across ${data.sum.leagues} league${data.sum.leagues === 1 ? "" : "s"}`}
                        </span>
                        {/* ⭐⭐⭐⭐⭐ WHERE THE REST IS HEADING. The settled record is a fact and stays the
                            headline; the unfinished games get the forecast the home strip already uses, so
                            the two screens cannot tell him two different things about the same afternoon.
                            `outlook` comes from the shared live read — see livecache.js. */}
                        {data.sum.liveN > 0 && (
                          <span data-wkoutlook={outlook ? `${outlook.projW}-${outlook.projL}` : "none"}
                            style={{ fontSize: 12 }}>
                            <span className="mut">· {data.sum.liveN} still playing</span>
                            {outlook && (
                              <>
                                <span className="mut">, projected to finish </span>
                                <b className="num" style={{ color: outlook.projW > outlook.projL ? "var(--pos)" : outlook.projW < outlook.projL ? "var(--neg)" : "var(--mut)" }}>
                                  {outlook.projW}–{outlook.projL}
                                </b>
                              </>
                            )}
                          </span>
                        )}
                      </div>
                      {/* Who the unfinished weeks are actually waiting on — the reason the record is not
                          final, named rather than implied. */}
                      {data.sum.liveN > 0 && data.sum.waiting.length > 0 && (
                        <div className="mut" data-wkwaiting={String(data.sum.waiting.length)}
                          style={{ fontSize: 11, marginBottom: 9, lineHeight: 1.45 }}>
                          Still to play: {data.sum.waiting.map((x) => x.n).join(", ")}
                        </div>
                      )}
                      {/* ⚠ A WRAPPING FLEX ROW OF UNEQUAL-HEIGHT TILES WRAPS RAGGED. Two of these carry a
                          sub-line and two do not, so at phone width the third tile dropped to a second row
                          that started below the TALLEST tile above it — a stray figure floating in white
                          space. A grid gives every tile the same track, so rows align whatever wraps. */}
                      <div style={{ display: "grid", gap: "14px 22px",
                        gridTemplateColumns: wide ? "repeat(auto-fit, minmax(104px, max-content))" : "repeat(2, minmax(0,1fr))" }}>
                        <Tile n={data.sum.left} label="Left on benches" tone="var(--gold)" />
                        {data.sum.apAny && (
                          <Tile n={`${data.sum.apW}–${data.sum.apL}`} label="Against the field"
                            sub="if you had played everyone" />
                        )}
                        {data.sum.blown > 0 && <Tile n={data.sum.blown} label="Blown" tone="var(--neg)" sub="your best lineup wins" />}
                        {data.sum.robbed > 0 && <Tile n={data.sum.robbed} label="Robbed" tone="var(--info)" sub="good score, bad draw" />}
                        {data.sum.lucky > 0 && <Tile n={data.sum.lucky} label="Got away with it" tone="var(--gold)" sub="won below the median" />}
                      </div>
                    </div>
                    {/* The single best line on the page, and it used to be a grey footnote. It is the one
                        thing here you could have actually changed, so it gets the accent rail. */}
                    {data.worst && data.worst.gain > 0 && (
                      <div data-wkworst style={{ fontSize: 12, padding: "9px 15px", lineHeight: 1.55,
                        borderTop: "1px solid var(--line)", borderLeft: "3px solid var(--neg)",
                        background: "rgba(242,101,92,.055)" }}>
                        <span className="mut" style={{ textTransform: "uppercase", letterSpacing: ".05em",
                          fontSize: 9.5, fontWeight: 800, marginRight: 8 }}>Worst call</span>
                        <b>{data.worst.leagueName}</b> <span className="mut">— started</span> <b>{data.worst.out}</b>
                        {" "}<span className="num mut">{data.worst.outPts}</span> <span className="mut">over</span>
                        {" "}<b style={{ color: "var(--pos)" }}>{data.worst.in}</b> <span className="num mut">{data.worst.inPts}</span>
                        {" "}<span className="num" style={{ color: "var(--neg)", fontWeight: 800 }}>−{data.worst.gain}</span>
                      </div>
                    )}

                    {/* ⭐⭐⭐ COLUMN HEADS, BECAUSE THESE ARE COLUMNS. Only on a screen wide enough to hold
                        them: at phone width the rows stack into two lines and a header describing six
                        columns that are no longer side by side would describe nothing. */}
                    {wide && (
                      <div className="mut" style={{ display: "grid", gridTemplateColumns: COLS, gap: 10,
                        padding: "7px 15px", borderTop: "1px solid var(--line)", background: "var(--panel2)",
                        fontSize: 9.5, textTransform: "uppercase", letterSpacing: ".05em", fontWeight: 700 }}>
                        <span>League</span>
                        <span style={{ textAlign: "right" }}>Result</span>
                        <span style={{ textAlign: "right" }}>vs median</span>
                        <span style={{ textAlign: "right" }}>Verdict</span>
                        <span style={{ textAlign: "right" }}>vs field</span>
                        <span style={{ textAlign: "right" }}>Bench</span>
                        <span />
                      </div>
                    )}

                  <div style={{ display: "flex", flexDirection: "column" }}>
                    {data.rows.map((R) => {
                      const me = R.me;
                      const isOpen = !!openMap[R.league.id];
                      const V = me && me.verdict ? (VERDICT[me.verdict.key] || VERDICT.earned) : null;
                      const L = R.data && R.data.ledger;
                      /* An unfinished week has no verdict, and the absence would read as a missing value
                         rather than a deliberate one. It says what it is instead. */
                      const liveChip = me && me.complete === false && (
                        <span data-wkverdict="inprogress" style={{ fontSize: 10, fontWeight: 800,
                          textTransform: "uppercase", letterSpacing: ".04em", border: "1px solid var(--gold)",
                          color: "var(--gold)", borderRadius: 99, padding: "1px 8px", display: "inline-flex",
                          alignItems: "center", gap: 4, whiteSpace: "nowrap" }}
                          title={(me.waitingOn || []).length ? `Waiting on ${me.waitingOn.join(", ")}` : "Still being played"}>
                          <i className="ti ti-clock" style={{ fontSize: 11 }} aria-hidden="true" />
                          {me.yetToPlay ? `${me.yetToPlay} to play` : "in progress"}
                        </span>
                      );
                      const verdictChip = liveChip || (V && (
                        <span data-wkverdict={me.verdict.key}
                          onMouseEnter={(e) => { const c = verdictCard(R); if (c) showCard(e, c); }} onMouseLeave={hideCard}
                          style={{ fontSize: 10, fontWeight: 800, cursor: "help",
                          textTransform: "uppercase", letterSpacing: ".04em", border: `1px solid ${V.tone}`,
                          color: V.tone, borderRadius: 99, padding: "1px 8px", display: "inline-flex",
                          alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
                          <i className={`ti ${V.icon}`} style={{ fontSize: 11 }} aria-hidden="true" />{V.label}
                        </span>
                      ));
                      /* ⭐⭐⭐⭐ THE MEDIAN HALF, where the league plays one — b140/29t.
                         Trey: "if your league has median scoring, you need to show how we relate to that as
                         well." In a median league the week is 2-0, 1-1 or 0-2, and a row showing only the
                         head-to-head is reporting half the result. Absent entirely for leagues that do not
                         play it, so the column never implies something that does not apply. */
                      const score = me && (
                        <span className="num" data-wkresult={me.result || ""}
                          onMouseEnter={(e) => { const c = resultCard(R); if (c) showCard(e, c); }} onMouseLeave={hideCard}
                          style={{ fontSize: 13, fontWeight: 800, whiteSpace: "nowrap", cursor: (me.lineup || []).length ? "help" : undefined,
                          color: me.result === "W" ? "var(--pos)" : me.result === "L" ? "var(--neg)" : "var(--mut)" }}>
                          {me.result || "—"} {r1(me.pts)}–{me.oppPts != null ? r1(me.oppPts) : "—"}
                        </span>
                      );
                      /* ⭐⭐⭐ THE MEDIAN IS ITS OWN COLUMN NOW, AND IT CARRIES THE MARGIN. Glued to the end
                         of the scoreline it could only be a letter; given a column it can be the letter AND
                         by how much, which is the part that tells you whether it was close.
                         ⚠ BLANK, NOT A DASH, IN A LEAGUE THAT DOES NOT PLAY MEDIAN SCORING. A dash down the
                           whole column would say "this applies to you and has no value", which is a
                           different and wrong claim — the same rule the projected-median column follows on
                           the home strip. */
                      const medianCell = me && me.medianResult ? (
                        <span className="num" data-wkmedian={me.medianResult}
                          onMouseEnter={(e) => { const c = fieldCard(R); if (c) showCard(e, c); }} onMouseLeave={hideCard}
                          style={{ fontSize: 12, fontWeight: 800, whiteSpace: "nowrap",
                            color: me.medianResult === "W" ? "var(--pos)" : me.medianResult === "L" ? "var(--neg)" : "var(--mut)" }}>
                          {me.medianResult}
                          {Number.isFinite(me.medianMargin) && (
                            <span style={{ fontWeight: 700, fontSize: 10, opacity: .8 }}>
                              {" "}{me.medianMargin >= 0 ? "+" : "−"}{r1(Math.abs(me.medianMargin))}
                            </span>
                          )}
                        </span>
                      ) : null;
                      return (
                        <div key={R.league.id} data-wkreviewrow={R.league.name}
                          style={{ borderTop: "1px solid var(--line)",
                            background: isOpen ? "var(--panel2)" : "transparent" }}>
                          {/* ⭐⭐⭐⭐ THE WHOLE ROW IS THE CONTROL, not a 56px button at the end of it.
                              "Detail" as a separate target meant the obvious thing to click — the league
                              name — did nothing, and on a phone the button had wrapped onto its own line
                              away from the row it belonged to. The chevron stays as the visible affordance
                              because a clickable row with no marking is a guessing game. */}
                          <button data-wkreviewtoggle={R.league.name} disabled={!me}
                            onClick={() => me && setOpenMap((o) => ({ ...o, [R.league.id]: !o[R.league.id] }))}
                            aria-expanded={isOpen} aria-label={`${isOpen ? "Hide" : "Show"} detail for ${R.league.name}`}
                            style={{ width: "100%", textAlign: "left", font: "inherit", color: "inherit",
                              background: "none", border: "none", padding: wide ? "10px 15px" : "10px 13px",
                              cursor: me ? "pointer" : "default", display: "grid", alignItems: "center",
                              gap: wide ? 10 : 6,
                              gridTemplateColumns: wide ? COLS : "minmax(0,1fr) auto" }}>
                            <span className="disp" style={{ fontSize: 14, fontWeight: 800, minWidth: 0,
                              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{R.league.name}</span>

                            {me && wide ? (
                              <>
                                <span style={{ textAlign: "right" }}>{score}</span>
                                <span style={{ textAlign: "right" }}>{medianCell}</span>
                                <span style={{ textAlign: "right" }}>{verdictChip}</span>
                                {/* ⭐⭐⭐⭐ COLOURED, BECAUSE THIS IS THE NUMBER THAT SAYS WHERE YOU STAND.
                                    The all-play record is the week with the schedule's luck removed, and it
                                    was plain grey — so a 11–0 and a 0–11 week looked the same until you
                                    read the digits. `fieldTone` breaks at the same thirds the insight block
                                    speaks in; see App.jsx. */}
                                <span className="num" data-wkfieldtone={me.allPlay ? fieldTone(me.allPlay.w, me.allPlay.l) : ""}
                                  data-wkfield onMouseEnter={(e) => { const c = fieldCard(R); if (c) showCard(e, c); }} onMouseLeave={hideCard}
                                  style={{ fontSize: 11.5, textAlign: "right", fontWeight: 700,
                                    color: me.allPlay ? fieldTone(me.allPlay.w, me.allPlay.l) : "var(--mut)" }}>
                                  {me.allPlay ? <>{me.allPlay.w}–{me.allPlay.l}
                                    <span style={{ fontSize: 10, opacity: .75, fontWeight: 600 }}> · {ord(me.allPlay.rank)}</span></> : "—"}
                                </span>
                                {/* ⚠ `benchTone` FROM App.jsx, NOT A LOCAL GOLD. This cell was
                                    `left > 0 ? gold : mut` — one shade for everything — while the home
                                    page's review table has scaled it by how much it hurt since 29w. Two
                                    surfaces showing the same figure in different colours is the drift the
                                    shared REVIEW_VERDICT map was created to stop, and it had simply been
                                    missed here. */}
                                <span className="num" data-wkbenchtone={benchTone(me.left)}
                                  style={{ fontSize: 11.5, textAlign: "right", fontWeight: 700,
                                    color: benchTone(me.left) }}>
                                  {me.left > 0 ? `−${me.left}` : "0"}
                                </span>
                                <span className="mut" style={{ textAlign: "right" }}>
                                  <i className={`ti ${isOpen ? "ti-chevron-up" : "ti-chevron-down"}`} style={{ fontSize: 14 }} aria-hidden="true" />
                                </span>
                              </>
                            ) : me ? (
                              /* Phone: two lines, still aligned — name and score on the first, the
                                 qualifiers on the second. Not a paragraph. */
                              <>
                                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                  {score}
                                  <i className={`ti ${isOpen ? "ti-chevron-up" : "ti-chevron-down"}`}
                                    style={{ fontSize: 14, color: "var(--mut)" }} aria-hidden="true" />
                                </span>
                                <span style={{ gridColumn: "1 / -1", display: "flex", alignItems: "center",
                                  gap: 8, flexWrap: "wrap", fontSize: 11.5 }}>
                                  {verdictChip}
                                  {medianCell && <span className="num mut">median {medianCell}</span>}
                                  {me.allPlay && <span className="num" style={{ color: fieldTone(me.allPlay.w, me.allPlay.l), fontWeight: 700 }}>
                                    vs field {me.allPlay.w}–{me.allPlay.l}</span>}
                                  {me.left > 0 && !me.pending && <span className="num" style={{ color: benchTone(me.left), fontWeight: 700 }}>−{me.left} bench</span>}
                                </span>
                              </>
                            ) : (
                              <span className="mut" style={{ fontSize: 12, gridColumn: wide ? "2 / -1" : "auto", textAlign: "left" }}>
                                {R.error ? "Couldn't read this league" : `Nothing recorded for week ${week}`}
                              </span>
                            )}
                          </button>

                          {me && isOpen && (
                            <div style={{ padding: wide ? "0 15px 14px" : "0 13px 14px" }}>
                              {/* The sentence lives HERE now — in the row you chose to open, where a
                                  sentence is worth reading, rather than repeated under every league. */}
                              <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 10,
                                paddingBottom: 10, borderBottom: "1px solid var(--line)", flexWrap: "wrap" }}>
                                <div className="mut" style={{ fontSize: 12, lineHeight: 1.55, flex: "1 1 320px", minWidth: 0 }}>
                                  {me.complete === false
                                    ? <>This week isn't finished{me.yetToPlay ? ` — ${me.yetToPlay} of your starters ${me.yetToPlay === 1 ? "has" : "have"} yet to play` : ""}
                                        {(me.waitingOn || []).length ? <> (<span style={{ color: "var(--ink)" }}>{me.waitingOn.join(", ")}</span>)</> : null}.
                                        {" "}There's nothing to second-guess until it is.</>
                                    : <>
                                        {me.verdict ? me.verdict.text : null}
                                        {me.allPlay && <> <span style={{ color: "var(--ink)" }}>Against the field you were {me.allPlay.w}–{me.allPlay.l}
                                          {me.allPlay.t ? `–${me.allPlay.t}` : ""}</span> ({me.allPlay.rank} of {me.allPlay.of} that week).</>}
                                      </>}
                                </div>
                                {/* ⭐⭐⭐⭐ INTO THE LEAGUE ITSELF — 29r. Trey: "I love the drop down that
                                    summarizes the week. I also want you to be able to click a button to go
                                    into the more detailed review of that specific league."
                                    The macro row is the summary by design — it has to stay short enough
                                    that ten of them are scannable. The full read (lineup, matchup, free
                                    agents, the league's own review tab) is a whole screen, and this is the
                                    door to it, from the row you were already looking at. */}
                                {onOpenLeague && R.league && (
                                  <button className="btn btn-mini" data-wkopenleague={R.league.name}
                                    onClick={() => onOpenLeague(R.league)}
                                    style={{ flexShrink: 0, borderColor: "var(--gold)", color: "var(--gold)" }}>
                                    Full review for this league
                                    <i className="ti ti-arrow-right" style={{ fontSize: 12, marginLeft: 5 }} aria-hidden="true" />
                                  </button>
                                )}
                              </div>
                              <FieldStrip field={R.field} mine={me.pts} median={me.median} />

                              {/* ⭐⭐⭐⭐⭐ THE FOUR QUESTIONS, ANSWERED SEPARATELY — 29ad. Trey: "show my
                                  decision making, luck, compare to the league, should I be concerned going
                                  forward." A scoreline cannot tell a bad lineup from a bad draw from a bad
                                  roster, and those want three different reactions. See reviewInsights. */}
                              {(() => {
                                const ins = reviewInsights({ weeks: R.data && R.data.weeks, field: R.field, mine: me });
                                if (!ins) return null;
                                const H = { robbed: "var(--info)", blown: "var(--neg)", outscored: "var(--neg)",
                                  lucky: "var(--gold)", earned: "var(--pos)", even: "var(--mut)" };
                                const OUT = { concern: "var(--neg)", rising: "var(--pos)", steady: "var(--mut)", unknown: "var(--mut)" };
                                return (
                                  <div data-wkinsight={ins.headline.key} style={{ marginTop: 10, border: "1px solid var(--line)",
                                    borderRadius: 9, padding: "9px 11px", background: "var(--panel2)" }}>
                                    <div style={{ fontSize: 12.5, fontWeight: 700, color: H[ins.headline.key] || "var(--ink)" }}>
                                      {ins.headline.text}
                                    </div>
                                    <div style={{ display: "grid", gap: "8px 16px", marginTop: 8,
                                      gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
                                      {/* How you scored, placed in the week's field AND against your own baseline. */}
                                      <div data-wkins="scoring">
                                        <div className="mut" style={{ fontSize: 9.5, textTransform: "uppercase", letterSpacing: ".05em" }}>Your score</div>
                                        <div style={{ fontSize: 12.5 }}>
                                          <b className="num">{ins.scoring.pts}</b>
                                          {ins.scoring.place && <span className="mut"> · {ord(ins.scoring.place.rank)} of {ins.scoring.place.of}</span>}
                                        </div>
                                        {ins.scoring.vsOwn != null && (
                                          <div className="mut" style={{ fontSize: 11 }}>
                                            {ins.scoring.vsOwn >= 0 ? "+" : ""}{ins.scoring.vsOwn} vs your {ins.scoring.mean} average
                                          </div>
                                        )}
                                      </div>
                                      {/* What you were up against — the half a scoreline hides. */}
                                      {ins.draw.place && (
                                        <div data-wkins="draw">
                                          <div className="mut" style={{ fontSize: 9.5, textTransform: "uppercase", letterSpacing: ".05em" }}>The draw</div>
                                          <div style={{ fontSize: 12.5 }}>
                                            <b className="num">{ins.draw.oppPts}</b>
                                            <span className="mut"> · {ord(ins.draw.place.rank)} of {ins.draw.place.of} that week</span>
                                          </div>
                                          <div className="mut" style={{ fontSize: 11 }}>
                                            {ins.draw.place.rank <= Math.ceil(ins.draw.place.of / 3) ? "One of the week's best — a hard draw."
                                              : ins.draw.place.rank > Math.ceil((ins.draw.place.of * 2) / 3) ? "One of the week's worst — a soft draw."
                                                : "A middling opponent score."}
                                          </div>
                                        </div>
                                      )}
                                      {/* The only part that was inside your control. */}
                                      <div data-wkins="decisions">
                                        <div className="mut" style={{ fontSize: 9.5, textTransform: "uppercase", letterSpacing: ".05em" }}>Your calls</div>
                                        <div style={{ fontSize: 12.5 }}>
                                          <b className="num" style={{ color: ins.decisions.left > 0 ? "var(--gold)" : "var(--pos)" }}>{ins.decisions.left}</b>
                                          <span className="mut"> left on the bench</span>
                                        </div>
                                        <div className="mut" style={{ fontSize: 11 }}>
                                          {ins.decisions.wouldHaveWon ? <b style={{ color: "var(--neg)" }}>Your best lineup wins this game.</b>
                                            : ins.decisions.mean != null ? `Your season average is ${ins.decisions.mean}.` : ""}
                                        </div>
                                      </div>
                                      {/* ⚠ AND THE FORWARD-LOOKING ONE, WHICH IS ALLOWED TO SAY IT DOES NOT KNOW. */}
                                      {/* ⚠ NOT `data-wkoutlook` — that name is already taken, 270 lines up, by
                                          the projected FINAL RECORD in the summary panel ("7-3"). Two
                                          different meanings behind one selector is how a suite ends up
                                          asserting confidently about the wrong element: `[data-wkoutlook]`
                                          would match the record first and never equal a level name, which
                                          reads as a broken feature rather than a naming clash. */}
                                      <div data-wkins="outlook" data-wkinsoutlook={ins.outlook.level}>
                                        <div className="mut" style={{ fontSize: 9.5, textTransform: "uppercase", letterSpacing: ".05em" }}>Going forward</div>
                                        <div style={{ fontSize: 12.5, fontWeight: 700, color: OUT[ins.outlook.level] }}>
                                          {ins.outlook.level === "concern" ? "Worth watching"
                                            : ins.outlook.level === "rising" ? "Trending up"
                                              : ins.outlook.level === "steady" ? "Holding steady" : "Too early to say"}
                                        </div>
                                        <div className="mut" style={{ fontSize: 11, lineHeight: 1.4 }}>{ins.outlook.why}</div>
                                      </div>
                                    </div>
                                  </div>
                                );
                              })()}

                              {/* ⭐⭐⭐ TWO QUESTIONS, TWO COLUMNS. The detail answers "what should I have
                                  done on Sunday" and "what does that make my season" — related but not
                                  sequential, and stacking them made you scroll past the first to reach the
                                  second every time. Side by side on a desktop, stacked on a phone where
                                  there is only one column to have. */}
                              <div style={{ display: "grid", gap: wide ? 22 : 14, marginTop: 12,
                                gridTemplateColumns: wide ? "minmax(0,1fr) minmax(0,1fr)" : "minmax(0,1fr)" }}>
                              <div style={{ minWidth: 0 }}>
                                <div style={{ fontSize: 12, fontWeight: 800, marginBottom: 4 }}>
                                  Your best lineup scored {r1(me.optimal)}{me.left > 0 ? ` — ${me.left} more than you did` : " — which is what you set"}
                                  {me.exact === false && <span className="mut" style={{ fontWeight: 400 }}> (approximate: this league's flex slots overlap)</span>}
                                </div>
                                {(me.misses || []).length ? (
                                  <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                                    {me.misses.map((m, i) => (
                                      <div key={i} data-wkmiss={m.in} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, flexWrap: "wrap" }}>
                                        <span className="mut" style={{ fontSize: 10, width: 42, flexShrink: 0 }}>{m.slot}</span>
                                        <span className="mut">started</span> <b>{m.out}</b> <span className="num mut">{m.outPts}</span>
                                        <span className="mut">over</span> <b style={{ color: "var(--pos)" }}>{m.in}</b> <span className="num mut">{m.inPts}</span>
                                        <span className="num" style={{ color: "var(--neg)", fontWeight: 800, marginLeft: "auto" }}>−{m.gain}</span>
                                      </div>
                                    ))}
                                  </div>
                                ) : <div className="mut" style={{ fontSize: 12 }}>You started the best nine you had.</div>}

                                {/* ⚠ THE HALF OF HIS QUESTION THIS CANNOT ANSWER, SAID OUT LOUD.
                                    ⚠ AND STILL SAID OUT LOUD AFTER THE TIDY-UP. The obvious way to cut
                                      text here was to delete this paragraph, and that would have been the
                                      one genuinely dishonest edit available: a review that quietly lists no
                                      free agents is claiming the wire was empty. The CLAIM stays on screen
                                      always; only the reasoning behind it folds away, because you need to
                                      read that once and never again. */}
                                {R.data && R.data.faBasis === "bench-only" && (
                                  <div data-wkfabasis="bench-only" style={{ marginTop: 10 }}>
                                    <div className="mut" style={{ fontSize: 11, lineHeight: 1.5 }}>
                                      Free agents aren't second-guessed for past weeks — this compares you only against
                                      your own bench.{" "}
                                      <button data-wkfawhy onClick={() => setFaWhy((v) => !v)}
                                        style={{ font: "inherit", background: "none", border: "none", padding: 0,
                                          cursor: "pointer", color: "var(--gold)", textDecoration: "underline" }}>
                                        {faWhy ? "hide" : "why?"}
                                      </button>
                                    </div>
                                    {faWhy && (
                                      <div className="mut" style={{ fontSize: 11, lineHeight: 1.5, marginTop: 4 }}>
                                        Who was actually unrostered in week {week} can't be recovered from today's rosters —
                                        the player you should have claimed is, by definition, on somebody's roster now.
                                        Sleeper does record your own bench week by week, so that half is exact.
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>

                              <div style={{ minWidth: 0 }}>
                                {L && (
                                  /* ⚠ SIX FACTS ON ONE WRAPPING LINE IS NOT A SUMMARY. This used to read
                                     "Record 2–4 Deserved 3–3 — 1 win short Points for 673 (5th of 12)
                                     Points against 703 (most faced in the league) Left on benches 46.5",
                                     which at phone width became five separate wrapped lines with no
                                     alignment between the labels and the numbers. A labelled grid is the
                                     same content and takes less vertical space than the prose did. */
                                  <div data-wkledger style={{ display: "grid", gap: "10px 14px",
                                    gridTemplateColumns: "repeat(auto-fit, minmax(96px, 1fr))" }}>
                                    <Fact label="Record" value={`${L.actualW}–${L.actualL}`} />
                                    {L.deservedW != null && (
                                      /* ⚠ "−1 luck" is a number nobody can read. Say which way it went in words:
                                         the gap between the record he has and the record the scores earned him. */
                                      <Fact label="Deserved" value={`${L.deservedW}–${L.deservedL}`}
                                        tone={L.luck === 0 ? null : L.luck > 0 ? "var(--gold)" : "var(--info)"}
                                        note={L.luck === 0 ? "exactly what you earned"
                                          : `${Math.abs(L.luck)} win${Math.abs(L.luck) === 1 ? "" : "s"} ${L.luck > 0 ? "better than you earned" : "short"}`} />
                                    )}
                                    {R.data.ranks && (
                                      <>
                                        <Fact label="Points for" value={L.pointsFor}
                                          note={`${ord(R.data.ranks.pointsForRank[String(R.data.myRosterId)])} of ${R.data.teams.length}`} />
                                        {/* ⚠ "Points against 703 (1st)" reads like a trophy. First in points
                                            against is the WORST place to be, so the rank is spelled out as what
                                            it means rather than left as an ordinal pointing the wrong way. */}
                                        <Fact label="Points against" value={L.pointsAgainst} note={(() => {
                                          const rk = R.data.ranks.pointsAgainstRank[String(R.data.myRosterId)];
                                          const of = R.data.teams.length;
                                          if (rk === 1) return "most faced in the league";
                                          if (rk === of) return "least faced in the league";
                                          return `${ord(rk)}-most faced`;
                                        })()} />
                                      </>
                                    )}
                                    <Fact label="Left on benches" value={L.leftOnBench} tone="var(--gold)" note="all season" />
                                  </div>
                                )}
                              </div>
                              </div>

                              {/* "Give weekly trends… and compare it to the league."
                                  ⚠ FULL WIDTH, BELOW BOTH COLUMNS. It spent one build inside the right-hand
                                    column, which halved a six-point time series for no reason while the
                                    left column sat half empty — a chart is the one thing on this page that
                                    genuinely gets better with width. */}
                              <SeasonTrend weeks={R.data.weeks} selected={week} onPick={setWeek} />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  </div>
                </>
              )}
    </div>
  );
}
