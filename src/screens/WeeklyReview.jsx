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
  robbed:  { label: "Robbed",      tone: "#6BA8E5",   icon: "ti-mood-annoyed",   blurb: "lost with a top-third score" },
  lucky:   { label: "Got away with it", tone: "var(--gold)", icon: "ti-clover", blurb: "won below the median" },
  blown:   { label: "Blown",       tone: "#F2655C",   icon: "ti-alert-triangle", blurb: "your best lineup beats them" },
  earned:  { label: "Earned",      tone: "#5FD0A8",   icon: "ti-check",          blurb: "the result the scores deserved" },
};

/* The table's column track. Named once so the header row and every body row cannot drift apart — two
   grid-template strings that are "the same" until somebody widens one is the classic way a table stops
   lining up. `minmax(0, …)` on the name column so a long league name ellipses instead of shoving the
   numbers off the right edge. */
const COLS = "minmax(0,1.5fr) 118px 132px 92px 72px 34px";

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
     #57C79E against #E8635A is ΔE 10.1 under deuteranopia — comfortably separated — but the green also
     sits ΔE 14.8 from the grey median rule, which is under the safe floor. The shape difference is what
     makes that irrelevant instead of a problem.)

   ⚠ AND THE CHART IS NEVER THE ONLY COPY OF A NUMBER. Every point here is also a row in the week list
     below it, with the same figures in text. The picture is for the shape of the season; the rows are
     for the values.
------------------------------------------------------------------------------------------------ */
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

  const pts = (weeks || []).filter((x) => x && x.me && Number.isFinite(x.me.pts));
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
                fill={won ? "#57C79E" : "var(--panel)"} stroke={won ? "var(--panel)" : "#E8635A"}
                strokeWidth={won ? 2 : 2} style={{ pointerEvents: "none" }} />
              {!won && <circle cx={x(i)} cy={y(p.me.pts)} r={4.5} fill="none" stroke="#E8635A" strokeWidth="2"
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
        <span><span style={{ color: "#57C79E" }}>●</span> won</span>
        <span><span style={{ color: "#E8635A" }}>○</span> lost</span>
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

export default function WeeklyReview({ leagues, scope = "all" }) {
  const [raw, setRaw] = useState(null);
  const [week, setWeek] = useState(null);
  const [openMap, setOpenMap] = useState({});
  const [faWhy, setFaWhy] = useState(false);
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
         technically defensible and useless; the week you want to review is the one that just happened. */
      const last = Math.max(0, ...mapped.map((r) => (r.data && r.data.lastCompletedWeek) || 0));
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
    const sum = {
      leagues: played.length,
      w: played.filter((r) => r.me.result === "W").length,
      l: played.filter((r) => r.me.result === "L").length,
      left: r1(played.reduce((s, r) => s + (r.me.left || 0), 0)),
      blown: played.filter((r) => r.me.verdict && r.me.verdict.key === "blown").length,
      robbed: played.filter((r) => r.me.verdict && r.me.verdict.key === "robbed").length,
      lucky: played.filter((r) => r.me.verdict && r.me.verdict.key === "lucky").length,
      /* ⭐⭐⭐ THE HONEST VERSION OF "HOW DID I DO". A 0–3 week against three opponents is three data
         points; the same week against every team in all three leagues is thirty-odd, and that is the
         number that says whether you scored badly or drew badly. It was previously buried one sentence
         deep inside each league row, which is the least useful place for the figure that reframes the
         headline sitting directly above it. */
      apW: played.reduce((s, r) => s + ((r.me.allPlay && r.me.allPlay.w) || 0), 0),
      apL: played.reduce((s, r) => s + ((r.me.allPlay && r.me.allPlay.l) || 0), 0),
      apAny: played.some((r) => r.me.allPlay),
    };
    let worst = null;
    played.forEach((r) => (r.me.misses || []).forEach((m) => {
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
                          color: data.sum.w > data.sum.l ? "#5FD0A8" : data.sum.l > data.sum.w ? "#F2655C" : "var(--mut)" }}>
                          {data.sum.w}–{data.sum.l}
                        </span>
                        <span className="mut" style={{ fontSize: 12 }}>
                          across {data.sum.leagues} league{data.sum.leagues === 1 ? "" : "s"}
                        </span>
                      </div>
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
                        {data.sum.blown > 0 && <Tile n={data.sum.blown} label="Blown" tone="#F2655C" sub="your best lineup wins" />}
                        {data.sum.robbed > 0 && <Tile n={data.sum.robbed} label="Robbed" tone="#6BA8E5" sub="good score, bad draw" />}
                        {data.sum.lucky > 0 && <Tile n={data.sum.lucky} label="Got away with it" tone="var(--gold)" sub="won below the median" />}
                      </div>
                    </div>
                    {/* The single best line on the page, and it used to be a grey footnote. It is the one
                        thing here you could have actually changed, so it gets the accent rail. */}
                    {data.worst && data.worst.gain > 0 && (
                      <div data-wkworst style={{ fontSize: 12, padding: "9px 15px", lineHeight: 1.55,
                        borderTop: "1px solid var(--line)", borderLeft: "3px solid #F2655C",
                        background: "rgba(242,101,92,.055)" }}>
                        <span className="mut" style={{ textTransform: "uppercase", letterSpacing: ".05em",
                          fontSize: 9.5, fontWeight: 800, marginRight: 8 }}>Worst call</span>
                        <b>{data.worst.leagueName}</b> <span className="mut">— started</span> <b>{data.worst.out}</b>
                        {" "}<span className="num mut">{data.worst.outPts}</span> <span className="mut">over</span>
                        {" "}<b style={{ color: "#5FD0A8" }}>{data.worst.in}</b> <span className="num mut">{data.worst.inPts}</span>
                        {" "}<span className="num" style={{ color: "#F2655C", fontWeight: 800 }}>−{data.worst.gain}</span>
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
                        <span>Verdict</span>
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
                      const verdictChip = V && (
                        <span data-wkverdict={me.verdict.key} style={{ fontSize: 10, fontWeight: 800,
                          textTransform: "uppercase", letterSpacing: ".04em", border: `1px solid ${V.tone}`,
                          color: V.tone, borderRadius: 99, padding: "1px 8px", display: "inline-flex",
                          alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
                          <i className={`ti ${V.icon}`} style={{ fontSize: 11 }} aria-hidden="true" />{V.label}
                        </span>
                      );
                      const score = me && (
                        <span className="num" style={{ fontSize: 13, fontWeight: 800, whiteSpace: "nowrap",
                          color: me.result === "W" ? "#5FD0A8" : me.result === "L" ? "#F2655C" : "var(--mut)" }}>
                          {me.result || "—"} {r1(me.pts)}–{me.oppPts != null ? r1(me.oppPts) : "—"}
                        </span>
                      );
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
                                <span>{verdictChip}</span>
                                <span className="num mut" style={{ fontSize: 11.5, textAlign: "right" }}>
                                  {me.allPlay ? <>{me.allPlay.w}–{me.allPlay.l}
                                    <span style={{ fontSize: 10, opacity: .75 }}> · {ord(me.allPlay.rank)}</span></> : "—"}
                                </span>
                                <span className="num" style={{ fontSize: 11.5, textAlign: "right",
                                  color: me.left > 0 ? "var(--gold)" : "var(--mut)" }}>
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
                                  {me.allPlay && <span className="num mut">vs field {me.allPlay.w}–{me.allPlay.l}</span>}
                                  {me.left > 0 && <span className="num" style={{ color: "var(--gold)" }}>−{me.left} bench</span>}
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
                              <div className="mut" style={{ fontSize: 12, lineHeight: 1.55, marginBottom: 10,
                                paddingBottom: 10, borderBottom: "1px solid var(--line)" }}>
                                {me.verdict ? me.verdict.text : null}
                                {me.allPlay && <> <span style={{ color: "var(--ink)" }}>Against the field you were {me.allPlay.w}–{me.allPlay.l}
                                  {me.allPlay.t ? `–${me.allPlay.t}` : ""}</span> ({me.allPlay.rank} of {me.allPlay.of} that week).</>}
                              </div>
                              <FieldStrip field={R.field} mine={me.pts} median={me.median} />

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
                                        <span className="mut">over</span> <b style={{ color: "#5FD0A8" }}>{m.in}</b> <span className="num mut">{m.inPts}</span>
                                        <span className="num" style={{ color: "#F2655C", fontWeight: 800, marginLeft: "auto" }}>−{m.gain}</span>
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
                                        tone={L.luck === 0 ? null : L.luck > 0 ? "var(--gold)" : "#6BA8E5"}
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
