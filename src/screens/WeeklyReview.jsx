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

export default function WeeklyReview({ leagues, scope = "all" }) {
  const [raw, setRaw] = useState(null);
  const [week, setWeek] = useState(null);
  const [openMap, setOpenMap] = useState({});
  const [loading, setLoading] = useState(false);
  const ranFor = useRef(null);

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

                  {/* The week in one line, across every league. */}
                  <div className="panel" data-wkreviewsum style={{ padding: 14, marginBottom: 12 }}>
                    <div className="disp" style={{ fontSize: 17, fontWeight: 800, marginBottom: 6 }}>
                      Week {week}: {data.sum.w}–{data.sum.l} across {data.sum.leagues} league{data.sum.leagues === 1 ? "" : "s"}
                    </div>
                    <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 12 }}>
                      <span><b className="num" style={{ color: "var(--gold)" }}>{data.sum.left}</b>
                        <span className="mut"> points left on benches</span></span>
                      {data.sum.blown > 0 && <span><b className="num" style={{ color: "#F2655C" }}>{data.sum.blown}</b>
                        <span className="mut"> lost with a winning lineup available</span></span>}
                      {data.sum.robbed > 0 && <span><b className="num" style={{ color: "#6BA8E5" }}>{data.sum.robbed}</b>
                        <span className="mut"> lost on the draw</span></span>}
                      {data.sum.lucky > 0 && <span><b className="num" style={{ color: "var(--gold)" }}>{data.sum.lucky}</b>
                        <span className="mut"> won below the median</span></span>}
                    </div>
                    {data.worst && data.worst.gain > 0 && (
                      <div data-wkworst className="mut" style={{ fontSize: 12, marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--line)" }}>
                        Worst call of the week — <b style={{ color: "var(--ink)" }}>{data.worst.leagueName}</b>:
                        {" "}started <b style={{ color: "var(--ink)" }}>{data.worst.out}</b> <span className="num">{data.worst.outPts}</span>
                        {" "}over <b style={{ color: "#5FD0A8" }}>{data.worst.in}</b> <span className="num">{data.worst.inPts}</span>
                        {" "}<span className="num" style={{ color: "#F2655C", fontWeight: 800 }}>−{data.worst.gain}</span>
                      </div>
                    )}
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {data.rows.map((R) => {
                      const me = R.me;
                      const isOpen = !!openMap[R.league.id];
                      const V = me && me.verdict ? (VERDICT[me.verdict.key] || VERDICT.earned) : null;
                      const L = R.data && R.data.ledger;
                      return (
                        <div key={R.league.id} className="panel" data-wkreviewrow={R.league.name} style={{ padding: 12 }}>
                          <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                            <span className="disp" style={{ fontSize: 14.5, fontWeight: 800 }}>{R.league.name}</span>
                            {me ? (
                              <>
                                <span className="num" style={{ fontSize: 13, fontWeight: 800,
                                  color: me.result === "W" ? "#5FD0A8" : me.result === "L" ? "#F2655C" : "var(--mut)" }}>
                                  {me.result || "—"} {r1(me.pts)}–{me.oppPts != null ? r1(me.oppPts) : "—"}
                                </span>
                                {V && (
                                  <span data-wkverdict={me.verdict.key} style={{ fontSize: 10, fontWeight: 800,
                                    textTransform: "uppercase", letterSpacing: ".04em", border: `1px solid ${V.tone}`,
                                    color: V.tone, borderRadius: 99, padding: "1px 8px", display: "inline-flex",
                                    alignItems: "center", gap: 4 }}>
                                    <i className={`ti ${V.icon}`} style={{ fontSize: 11 }} aria-hidden="true" />{V.label}
                                  </span>
                                )}
                                {me.left > 0 && <span className="num mut" style={{ fontSize: 11.5 }}>−{me.left} on the bench</span>}
                                <button className="btn btn-mini" data-wkreviewtoggle={R.league.name} style={{ marginLeft: "auto" }}
                                  onClick={() => setOpenMap((o) => ({ ...o, [R.league.id]: !o[R.league.id] }))}>
                                  {isOpen ? "Less" : "Detail"}
                                </button>
                              </>
                            ) : (
                              <span className="mut" style={{ fontSize: 12 }}>
                                {R.error ? "Couldn't read this league" : `Nothing recorded for week ${week}`}
                              </span>
                            )}
                          </div>

                          {me && (
                            <div className="mut" style={{ fontSize: 12, marginTop: 5, lineHeight: 1.5 }}>
                              {me.verdict ? me.verdict.text : null}
                              {me.allPlay && <> <span style={{ color: "var(--ink)" }}>Against the field you were {me.allPlay.w}–{me.allPlay.l}
                                {me.allPlay.t ? `–${me.allPlay.t}` : ""}</span> ({me.allPlay.rank} of {me.allPlay.of} that week).</>}
                            </div>
                          )}

                          {me && isOpen && (
                            <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--line)" }}>
                              <FieldStrip field={R.field} mine={me.pts} median={me.median} />

                              {/* ⭐⭐⭐⭐ "should you have started someone else?" — the point of the whole page. */}
                              <div style={{ marginTop: 12 }}>
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
                              </div>

                              {/* ⚠ THE HALF OF HIS QUESTION THIS CANNOT ANSWER, SAID OUT LOUD. */}
                              {R.data && R.data.faBasis === "bench-only" && (
                                <div className="mut" data-wkfabasis="bench-only" style={{ fontSize: 11, marginTop: 10, lineHeight: 1.5 }}>
                                  Free agents are not second-guessed for past weeks. Who was actually unrostered in week
                                  {" "}{week} can't be recovered from today's rosters — the player you should have claimed is,
                                  by definition, on somebody's roster now — so this compares you only against players who were
                                  already on your bench, which Sleeper records week by week.
                                </div>
                              )}

                              {/* "Give weekly trends… and compare it to the league." */}
                              <SeasonTrend weeks={R.data.weeks} selected={week} onPick={setWeek} />

                              {L && (
                                <div data-wkledger style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--line)",
                                  display: "flex", gap: 16, flexWrap: "wrap", fontSize: 12 }}>
                                  <span><span className="mut">Record </span><b className="num">{L.actualW}–{L.actualL}</b></span>
                                  {L.deservedW != null && (
                                    /* ⚠ "−1 luck" is a number nobody can read. Say which way it went in words:
                                       the gap between the record he has and the record the scores earned him. */
                                    <span><span className="mut">Deserved </span><b className="num">{L.deservedW}–{L.deservedL}</b>
                                      {L.luck !== 0 && (
                                        <span style={{ color: L.luck > 0 ? "var(--gold)" : "#6BA8E5", fontWeight: 700 }}>
                                          {" "}— {Math.abs(L.luck)} win{Math.abs(L.luck) === 1 ? "" : "s"}
                                          {L.luck > 0 ? " better than you earned" : " short"}
                                        </span>
                                      )}</span>
                                  )}
                                  {R.data.ranks && (
                                    <>
                                      <span><span className="mut">Points for </span><b className="num">{L.pointsFor}</b>
                                        <span className="mut"> ({ord(R.data.ranks.pointsForRank[String(R.data.myRosterId)])} of {R.data.teams.length})</span></span>
                                      {/* ⚠ "Points against 703 (1st)" reads like a trophy. First in points
                                          against is the WORST place to be, so the rank is spelled out as what
                                          it means rather than left as an ordinal pointing the wrong way. */}
                                      <span><span className="mut">Points against </span><b className="num">{L.pointsAgainst}</b>
                                        <span className="mut"> ({(() => {
                                          const rk = R.data.ranks.pointsAgainstRank[String(R.data.myRosterId)];
                                          const of = R.data.teams.length;
                                          if (rk === 1) return "most faced in the league";
                                          if (rk === of) return "least faced in the league";
                                          return `${ord(rk)}-most faced`;
                                        })()})</span></span>
                                    </>
                                  )}
                                  <span><span className="mut">Left on benches </span><b className="num" style={{ color: "var(--gold)" }}>{L.leftOnBench}</b></span>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
    </div>
  );
}
