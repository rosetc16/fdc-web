/* ⭐⭐⭐ 29p — SPLIT OUT OF App.jsx SO THE DRAFT ROOM DOES NOT CARRY IT.
   Trey: "Obviously we need to make sure that the speed and efficiency of this app is strong for draft
   night (i.e. 'Break up the app')… performance has to matter the most."
   Measured: stubbing the non-room screens out entirely took the bundle from 1360kB to 976kB and boot into
   a draft room from 2290ms to 1789ms at 4x CPU throttle. This screen is one of them — it is never open
   during a draft, so it now lives in its own chunk and is fetched the first time it is actually shown.
   ⚠ The import below is a CYCLE (App.jsx → this file → App.jsx) and that is deliberate and safe: every
   imported name is used at CALL time, never while this module is evaluating, and ES module bindings are
   live, so the engine's mutable globals (TEAMS, SPEC, ORDER…) read correctly through it. Anything that
   needs a value at module-evaluation time must NOT be imported this way — it would be in its temporal
   dead zone and the screen would throw on first render. */
import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { readStrategy, surname, POS, cpos, bandOfRound, POS_COLOR, ORDER, ordinal, sample, positionTip, vbdColor, CheatSheetModal, PrintedStrategy, printElement, analyzeLeagueMockTrends, Section, TrendsShell } from "../App.jsx";

function MockTrendsPage({ league, players, onBack, backLabel, onHome, onSignOut, user, onRunMock }) {
  const t = useMemo(() => analyzeLeagueMockTrends(league.mocks || [], players, league.cfg), [league, players]);
  const [tip, setTip] = useState(null);
  const [expanded, setExpanded] = useState({});   // which price columns are showing their full list
  const [runSort, setRunSort] = useState("recent");  // section 02: "recent" | "finish"
  const [runAll, setRunAll] = useState(false);       // section 02: top 10, or every mock
  const showTip = (e, content) => { try { setTip(positionTip(e.clientX, e.clientY, content, e.currentTarget)); } catch (_) {} };
  const hideTip = () => setTip(null);
  const teams = league.cfg.teams || 12;
  // ⭐ 29p — print this plan, and the door to the printable cheat sheet. See TrendsShell.
  const [sheetOpen, setSheetOpen] = useState(false);
  const strategy = readStrategy(league);
  // The sheet's own board when opened from here: the league's pool on market order. The draft room passes
  // its live filtered board instead; same component, different builder.
  const sheetRows = (n) => (players || []).slice()
    .filter((p) => p && p.adp != null)
    .sort((a, b) => (a.adp ?? 999) - (b.adp ?? 999))
    .slice(0, Number.isFinite(n) ? n : undefined);

  // ⚠⚠ THE SHELL IS DEFINED AT MODULE LEVEL (see TrendsShell), NOT HERE, and that is not a style choice.
  // It used to be `const Shell = ({children}) => (...)` inside this function, which makes it a NEW COMPONENT
  // TYPE on every render — so every single setTip() unmounted and remounted the entire page. Trey found it
  // by hand: "if I hover on the first and go to the second, it just shows a '?' but it works on the third
  // one. If I go from the first... then let it load a bit by not going straight to the second, then it shows
  // the second one." That is the exact signature: the chip you are sliding onto is DESTROYED AND RECREATED
  // under the pointer, and the browser only fires mouseover when the pointer moves onto an element — a node
  // swapped beneath a moving cursor never gets one, so you keep the `cursor: help` question mark and no
  // tooltip. Pausing lets the remount finish before you arrive, which is why waiting "fixed" it.
  // A probe that slides the mouse in steps reproduces it every time (work/_hovbug.mjs); one that teleports
  // does not, because a teleport lands as one clean mouseover on the destination.
  // ⚠ AND IT IS USED DIRECTLY, not wrapped in a local `const Shell = ({children}) => <TrendsShell…>`.
  // That indirection looks harmless and is exactly the same bug: the WRAPPER is the new component type, so
  // React still throws away everything under it on every render. Half-fixing it left the probe failing in
  // the same way, which is how I know.
  const shellProps = {
    onBack, backLabel, onHome, onSignOut, tip,
    onPrint: () => printElement("[data-planbody]"),
    onCheatSheet: () => setSheetOpen(true),
  };

  // ⭐⭐ EARLY PICKS AND LATE PICKS ARE TWO DIFFERENT DECISIONS, so sections 04 and 05 render as two
  // labelled sub-groups instead of one ranked pile. Trey: "a lot of the 'going earlier than they're worth'
  // are just later picks that people might be reaching on some… I want to split both of these sections into
  // early picks and late picks (maybe it's just first 5 rounds / after first 5)." A round-2 mistake costs a
  // starter; a round-11 one costs a bench flier. Mixing them buries the first under a pile of the second.
  // ⚠ THESE ARE FUNCTIONS THAT RETURN JSX, NOT COMPONENTS. A `const Row = () => …` used as <Row/> would be
  // a brand-new component type on every render and would bring back the hover-remount bug documented above.
  // ⭐⭐ AND THEY SIT SIDE BY SIDE. Trey: "you can just put rounds 1-5 on the left side and rounds 8+ on
  // the right. There is a lot of blank space in this widget, so you can split it side by side and fit more
  // names (make it so you can expand to see more names). I want them to be a part of the same widget (not
  // two different ones)." So: ONE panel, two columns, each with its own show-more.
  const PRICE_COLS = "24px minmax(0,1fr) 62px 84px 58px";
  const SHOW_FIRST = 6;
  const priceHead = (last) => (
    <div style={{ display: "grid", gridTemplateColumns: PRICE_COLS, gap: 7, padding: "5px 10px 4px", fontSize: 9, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--mut)", fontWeight: 700, borderBottom: "1px solid var(--line)" }}>
      <span /><span>Player</span><span style={{ textAlign: "right" }}>Goes</span><span style={{ textAlign: "right" }}>Plays like</span><span style={{ textAlign: "right" }}>{last}</span>
    </div>
  );
  // "Plays like round 20" in a fifteen-round draft is not a claim, it is a bug telling on itself. Anything
  // the price curve puts past the last pick now says so in words.
  const worthLabel = (v) => (t.lastRound && v.worthRound > t.lastRound ? `past round ${t.lastRound}` : `round ${v.worthRound}`);
  // ONE SCALE FOR BOTH ROUND COLUMNS: round 1 is the darkest, the last round the palest, so "Goes" and
  // "Plays like" can be compared by eye down the page as well as across a row. The "Plays like" cell is
  // the one that carries the verdict, so it also takes the section's colour; "Goes" stays neutral.
  const roundShade = (r, last, filled, good) => {
    const R = Math.max(1, last || 15);
    const t2 = Math.max(0, Math.min(1, (R - Math.min(r, R)) / Math.max(1, R - 1)));   // 1 at round 1 → 0 at the last
    if (!filled) return { color: `rgba(233,238,243,${0.42 + t2 * 0.5})`, background: `rgba(136,150,165,${0.05 + t2 * 0.13})`, borderRadius: 4, padding: "1px 4px" };
    const rgb = good ? "95,208,168" : "242,101,92";
    return { color: `rgba(${rgb},${0.55 + t2 * 0.45})`, background: `rgba(${rgb},${0.05 + t2 * 0.2})`, borderRadius: 4, padding: "1px 4px" };
  };
  const priceRow = (v, i, kind) => {
    const good = kind === "value";
    const surplus = Math.max(0, v.goesRound - v.worthRound);
    // Rounds of value in whichever direction this table is about.
    const gap = good ? surplus : Math.max(0, v.worthRound - v.goesRound);
    return (
      <div key={v.id} data-bargain={good ? v.id : undefined} data-avoid={good ? undefined : v.id}
        onMouseEnter={(e) => showTip(e, good ? [
          { kind: "take", tone: "good", x: `${v.name} — goes around pick ${v.avgO} (round ${v.goesRound})` },
          { t: "Why he's a bargain", x: `On this board his ${t.valueMetric === "value" ? "long-term value" : "value over replacement"} is what a ${worthLabel(v)} pick ordinarily returns — ${surplus} round${surplus === 1 ? "" : "s"} of surplus.` },
          { t: "On the best rosters", x: v.lift > 0 ? `He appears ${v.lift}% more often on teams that finished top ${t.podium || 3} in their room than on the ones that finished bottom ${t.podium || 3}.` : "He shows up about equally on strong and weak rosters — the value here is the price, not the company he keeps." },
          { t: "Seen in", x: `${v.n} of your ${t.n} mock${t.n === 1 ? "" : "s"}` },
          { kind: "playercard", p: v.p },
        ] : [
          { kind: "take", tone: "bad", x: `${v.name} — goes around pick ${v.avgO} (round ${v.goesRound})` },
          { t: "Why to let him go", x: `His ${t.valueMetric === "value" ? "long-term value" : "value over replacement"} is what a ${worthLabel(v)} pick ordinarily returns, so taking him where your room does spends ${v.worthRound - v.goesRound} rounds of draft capital you don't get back.` },
          ...(v.lift < 0 ? [{ t: "And it shows", x: `He appears ${Math.abs(v.lift)}% more often on teams that finished BOTTOM ${t.podium || 3} in their room than on the top-${t.podium || 3} ones.` }] : []),
          { t: "Seen in", x: `${v.n} of your ${t.n} mock${t.n === 1 ? "" : "s"}` },
          { kind: "playercard", p: v.p },
        ])} onMouseLeave={hideTip}
        style={{ display: "grid", gridTemplateColumns: PRICE_COLS, gap: 7, alignItems: "center", padding: "7px 10px", borderTop: i ? "1px solid var(--line)" : "none", cursor: "help" }}>
        <span style={{ fontWeight: 800, color: POS_COLOR[v.pos], fontSize: 11 }}>{v.pos}</span>
        <span style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v.name}</span>
        {/* ⭐⭐ CONDITIONALLY FORMATTED, so a trend is visible without reading every row. Trey: "can you
            conditionally format some of the 'Plays Like' 'Goes' and 'Rounds of Value' so I can find more
            trends without having to dig too much." The two round columns share ONE scale — early rounds
            dark, late rounds pale — so a glance down them shows whether this league's mispricings cluster
            at the top of the draft or the bottom, and a row where the two shades differ sharply IS the
            find. Shading only; the numbers stay plain so nothing is hidden behind colour. */}
        <span className="num" style={{ fontSize: 11, textAlign: "right", ...roundShade(v.goesRound, t.lastRound, false) }}>R{v.goesRound}</span>
        {/* ⭐⭐ HOW BIG THE GAP IS, VISIBLE. Trey: "Nico Collins is a 3rd rounder, but plays like a 2nd
            rounder… but Brock Bowers is a 3rd rounder that plays like a 1st rounder (I want to see that
            Brock is ahead of Nico in value basically)." Both rows read "round 3" in the Goes column and
            the difference was one digit apart in another. The gap is now the loudest thing on the row —
            sized, coloured by magnitude, and stated in rounds. */}
        <span className="num" style={{ fontSize: 12, fontWeight: 800, textAlign: "right", ...roundShade(v.worthRound, t.lastRound, true, good) }}>{worthLabel(v)}</span>
        <span style={{ textAlign: "right", display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 4 }}>
          <span style={{ display: "inline-flex", gap: 1.5 }}>
            {Array.from({ length: Math.min(4, Math.max(0, gap)) }).map((_, k) => (
              <span key={k} style={{ width: 4, height: 11 + k * 2, borderRadius: 1, background: good ? "#5FD0A8" : "#F2655C", opacity: 0.55 + k * 0.15 }} />
            ))}
          </span>
          <span className="num" style={{ fontSize: 11.5, fontWeight: gap >= 3 ? 800 : 600, borderRadius: 4, padding: "1px 5px",
            color: gap <= 0 ? "var(--mut)" : good ? `rgba(95,208,168,${Math.min(1, 0.5 + gap * 0.14)})` : `rgba(242,101,92,${Math.min(1, 0.5 + gap * 0.14)})`,
            background: gap <= 0 ? "transparent" : good ? `rgba(95,208,168,${Math.min(0.3, gap * 0.055)})` : `rgba(242,101,92,${Math.min(0.3, gap * 0.055)})` }}>
            {gap > 0 ? `${gap}${gap > 4 ? "+" : ""}` : "—"}
          </span>
        </span>
      </div>
    );
  };
  // One column of the pair: heading, note, rows, and its own expander.
  // ⭐ ONE BUTTON PER SECTION. Trey: "can you just do one button for each one of 'going later' and 'going
  //   earlier'. I don't want to have to click twice." The expander now keys on the SECTION, so both columns
  //   open together and it sits under the pair rather than inside a column.
  const priceCol = (key, label, note, list, lastCol, kind) => {
    const open = !!expanded[key];
    const shown = open ? list : list.slice(0, SHOW_FIRST);
    return (
      <div data-pricecol={`${key}:${label}`} style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "0 10px 4px", flexWrap: "wrap" }}>
          <span style={{ fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".06em" }}>{label}</span>
          <span className="mut" style={{ fontSize: 11 }}>{note}</span>
        </div>
        {list.length === 0
          ? <div className="mut" style={{ fontSize: 12, padding: "10px" }}>Nothing here in your mocks yet.</div>
          : <>
              {priceHead(lastCol)}
              {shown.map((v, i) => priceRow(v, i, kind))}
            </>}
      </div>
    );
  };
  // The pair, in one panel with a divider down the middle and ONE expander underneath for both columns.
  const pricePair = (key, a, b, hidden) => (
    <div className="panel" style={{ padding: "12px 4px" }}>
      <div className="trendpair" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 0 }}>
        <div style={{ minWidth: 0, paddingRight: 10 }}>{a}</div>
        <div style={{ minWidth: 0, paddingLeft: 10, borderLeft: "1px solid var(--line)" }}>{b}</div>
      </div>
      {hidden > 0 && (
        <div style={{ padding: "10px 10px 2px", textAlign: "center" }}>
          <button className="btn btn-mini" data-expander={key}
            onClick={() => setExpanded((e) => ({ ...e, [key]: !e[key] }))}>
            {expanded[key] ? "Show fewer ▴" : `Show ${hidden} more ▾`}
          </button>
        </div>
      )}
    </div>
  );
  const hiddenIn = (...lists) => lists.reduce((n, l) => n + Math.max(0, (l || []).length - SHOW_FIRST), 0);
  const cut = t.earlyCut || 5;

  if (!t.n) {
    return (
      <TrendsShell {...shellProps}>
        <div className="disp" style={{ fontSize: 30, fontWeight: 800, letterSpacing: "-.01em" }}>Your draft plan</div>
        <div className="mut" style={{ fontSize: 14, marginTop: 6, marginBottom: 20 }}>{league.name}</div>
        <div className="panel" style={{ padding: 26, textAlign: "center", background: "var(--panel2)" }}>
          <i className="ti ti-chart-histogram" style={{ fontSize: 38, color: "#7ed6a5" }} aria-hidden="true" />
          <div className="disp" style={{ fontSize: 19, fontWeight: 700, margin: "12px 0 8px" }}>
            {t.started ? "Nothing finished enough to read yet" : "Run a mock and this page writes itself"}
          </div>
          <div className="mut" style={{ fontSize: 13.5, lineHeight: 1.6, maxWidth: 620, margin: "0 auto 18px" }}>
            {t.started
              ? `${t.started} mock${t.started === 1 ? " has" : "s have"} been started but none is far enough along to read. A team's finish only means something once its starting lineup is mostly drafted.`
              : `Every mock you run is ${teams} drafts, not one — this page reads all of them: what the best rosters in your room did differently, which players keep turning up as bargains, and which positions you can afford to wait on. All of it specific to ${league.name}.`}
          </div>
          {onRunMock && <button className="btn btn-gold" onClick={onRunMock}><i className="ti ti-dice-5" style={{ fontSize: 13, marginRight: 5 }} aria-hidden="true" />Run a mock draft</button>}
        </div>
      </TrendsShell>
    );
  }

  const conf = t.enough ? { t: "Solid sample", c: "#5FD0A8" } : t.n >= 3 ? { t: "Early read", c: "var(--gold)" } : { t: "Thin — treat as a hint", c: "#F2655C" };

  const rankColor = (r, of) => (r <= Math.max(1, Math.round(of * 0.25)) ? "#5FD0A8" : r <= Math.round(of * 0.6) ? "var(--gold)" : "#F2655C");

  return (
    <TrendsShell {...shellProps}>
      {sheetOpen && (
        <CheatSheetModal
          league={league} cfg={league.cfg}
          getRows={sheetRows}
          tierMetric={(p) => p.adp}
          myRanks={null} queue={null} myRoster={t.myKeepers || []}
          strategy={strategy}
          onClose={() => setSheetOpen(false)}
        />
      )}
      {/* ---- headline ---- */}
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <div>
          <div className="disp" style={{ fontSize: 30, fontWeight: 800, letterSpacing: "-.01em" }}>Your draft plan</div>
          <div className="mut" style={{ fontSize: 13.5, marginTop: 4 }}>
            {league.name} · read from <b style={{ color: "var(--ink)" }}>{t.n} mock{t.n === 1 ? "" : "s"}</b> = <b style={{ color: "var(--ink)" }}>{t.teamDrafts} team-drafts</b>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }} className="noprint">
          <span className="chip" style={{ borderColor: conf.c, color: conf.c }}>{conf.t}</span>
          {onRunMock && <button className="btn btn-mini btn-gold" onClick={onRunMock}><i className="ti ti-dice-5" style={{ fontSize: 12, marginRight: 4 }} aria-hidden="true" />Run another</button>}
        </div>
      </div>

      {/* ⭐⭐ 29p — YOUR OWN INPUTS, AT THE TOP. Trey: "Can you also add a section with your inputs for
          'Draft Strategy' at the top of this sheet." Everything below this line is what the room did; this
          is what HE decided, and on a printed page handed to a co-manager it is the part that says whose
          plan this is. Renders nothing when no plan has been written. */}
      <PrintedStrategy strategy={strategy} cfg={league.cfg} />

      {/* ---- 01 · THE PLAN. The whole point of the page, at the top, before any evidence. ---- */}
      {t.pathway.length > 0 && (
        <Section n={1} title="Your plan" sub={`Written for the roster you actually have${t.myKeepers.length ? ` — ${t.myKeepers.length} keeper${t.myKeepers.length === 1 ? "" : "s"} included` : ""}, not for the league average.`}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {t.pathway.map((p, i) => (
              <div key={i} style={{ display: "flex", gap: 12, padding: "13px 15px", borderRadius: 11, background: "linear-gradient(100deg,rgba(224,166,60,.10),rgba(224,166,60,.03))", border: "1px solid rgba(224,166,60,.35)" }}>
                <span className="disp" style={{ fontSize: 17, fontWeight: 800, color: "var(--gold)", lineHeight: 1.3, flexShrink: 0 }}>{i + 1}</span>
                <span style={{ fontSize: 14, lineHeight: 1.55 }}>{p}</span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* ---- 02 · YOU vs THE ROOM ---- */}
      {/* ⭐⭐ A TABLE, NOT A ROW OF CHIPS. Trey: "You have a ton of room to work with here. Instead of the
          side by side 5 of 10, 6 of 10, 5 of 10… can you make this in table form, show more details of each
          draft (aka how you started), projected points of those teams, and such." A chip carried one number
          and hid the other six behind a hover; the space was there the whole time. */}
      {t.myRuns.length > 0 && (
        <Section n={2} title="How you've been finishing" accent="#7ed6a5"
          sub={`One row per mock, out of ${teams}. Behind is how far off the winning team you finished; Room winner is what the team that beat you opened with. Hover any row for the full starting lineup you ended up with.`}>
          <div className="panel" style={{ padding: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap", marginBottom: 12 }}>
              <div>
                <div className="disp" style={{ fontSize: 30, fontWeight: 800, color: rankColor(t.myAvgRank, teams), lineHeight: 1 }}>{ordinal(Math.round(t.myAvgRank))}</div>
                <div className="mut" style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".06em", marginTop: 3 }}>average finish</div>
              </div>
              <div>
                <div className="disp num" style={{ fontSize: 30, fontWeight: 800, lineHeight: 1 }}>{Math.round(t.myRuns.reduce((s2, r) => s2 + r.pts, 0) / t.myRuns.length)}</div>
                <div className="mut" style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".06em", marginTop: 3 }}>average projected pts</div>
              </div>
              <div>
                <div className="disp num" style={{ fontSize: 30, fontWeight: 800, lineHeight: 1, color: "#F2655C" }}>
                  {Math.round(t.myRuns.reduce((s2, r) => s2 + (r.gapToFirst || 0), 0) / t.myRuns.length)}
                </div>
                <div className="mut" style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".06em", marginTop: 3 }}>average pts behind first</div>
              </div>
            </div>
            {(() => {
              // ⚠ THE COLUMNS WERE FLOATING APART. Trey: "There is still a weird amount of blank space + the
              //   spacing is strange." Two greedy `1fr` columns in a seven-column grid split all the slack
              //   between them, so "How you opened" and "Room winner opened" each grew a hand's width of
              //   nothing while the numeric columns stayed pinned left. Every column is now sized to its
              //   content, ONE column absorbs the remainder, and the space that was empty is carrying two
              //   things worth having: the shape of the roster you finished with, and its best player.
              // ⚠ AND THE LAST COLUMN WAS STILL BEING CUT OFF. Trey: "the 'how you've been finishing' cuts
              //   off the points of the column of 'Room Winner opened'." Its pills plus a points figure need
              //   more than 150px, and it was the column with no room left to take it from. The flexible
              //   column is now the one in the MIDDLE of the row, so the two pill columns at either end each
              //   get a fixed width big enough for five pills and a number.
              const RUN_COLS = "26px 62px 56px 50px 144px 40px minmax(0,1fr) 128px 176px";
              const posPill = (pp, k, dim) => (
                <b key={k} style={{ fontSize: 10, color: POS_COLOR[pp] || "var(--mut)", border: `1px solid ${POS_COLOR[pp] || "var(--line)"}44`, borderRadius: 4, padding: "1px 4px", opacity: dim ? 0.8 : 1 }}>{pp}</b>
              );
              // ⭐⭐ SORTABLE, AND CAPPED AT TEN. Trey: "I want you to be able to sort mock drafts by recency
              //   and finish (best to last). It should default to show the top 10, but then you can click a
              //   button to expand to see more." Both orders answer different questions — recency is "what
              //   am I doing lately", finish is "what did my best drafts look like" — and once a manager has
              //   twenty mocks saved, an unsorted list of twenty is not a table, it is a wall.
              const sorted = t.myRuns.slice();
              if (runSort === "finish") sorted.sort((a, b) => a.rank - b.rank || b.pts - a.pts);
              else sorted.sort((a, b) => (b.at || 0) - (a.at || 0) || t.myRuns.indexOf(b) - t.myRuns.indexOf(a));
              const shownRuns = runAll ? sorted : sorted.slice(0, 10);
              return (
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 8px 7px", flexWrap: "wrap" }}>
                    <span className="mut" style={{ fontSize: 9.5, textTransform: "uppercase", letterSpacing: ".06em", fontWeight: 700 }}>Sort</span>
                    {[["recent", "Most recent"], ["finish", "Best finish"]].map(([k, lbl]) => (
                      <button key={k} className="btn btn-mini" data-runsort={k}
                        style={{ borderColor: runSort === k ? "var(--gold)" : "var(--line)", color: runSort === k ? "var(--gold)" : "var(--mut)" }}
                        onClick={() => setRunSort(k)}>{lbl}</button>
                    ))}
                    <div style={{ flex: 1 }} />
                    <span className="mut" style={{ fontSize: 10.5 }}>{shownRuns.length} of {sorted.length}</span>
                  </div>
                  <div className="runhead" style={{ display: "grid", gridTemplateColumns: RUN_COLS, gap: 8, fontSize: 9, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--mut)", fontWeight: 700, padding: "0 8px 5px" }}>
                    <span>#</span>
                    <span>Finish</span>
                    <span style={{ textAlign: "right" }}>Your pts</span>
                    <span style={{ textAlign: "right" }}>Behind</span>
                    <span>Your first five</span>
                    <span style={{ textAlign: "right" }}>QB</span>
                    <span>Finished with</span>
                    <span>Your first two</span>
                    <span>Room winner opened</span>
                  </div>
                  {shownRuns.map((r, i) => {
                    const isBest = t.myBest && t.myBest.mock === r.mock;
                    const isWorst = t.myWorst && t.myWorst.mock === r.mock && !isBest;
                    const opened = (r.open5 || r.open3 || "").split("-").filter(Boolean);
                    return (
                      <div key={r.mock} data-runchip={i} onMouseEnter={(e) => showTip(e, [
                        { kind: "take", tone: r.rank <= 3 ? "good" : r.rank <= teams / 2 ? "neutral" : "bad",
                          x: `Mock ${i + 1} — ${ordinal(r.rank)} of ${r.of} · ${r.pts} projected points${r.gapToFirst ? ` · ${r.gapToFirst} behind first` : " · won the room"}` },
                        { t: "How you opened", x: `${(r.open5 || r.open3 || "").replace(/-/g, " → ")}${r.qbRound < 99 ? ` · quarterback in round ${r.qbRound}` : " · no quarterback drafted"}` },
                        ...(r.held ? [{ t: "You finished with", x: POS.map((pp) => `${r.held[pp] || 0} ${pp}`).join(" · ") }] : []),
                        ...(r.winOpen3 ? [{ t: "The team that won the room", x: `Opened ${r.winOpen3.replace(/-/g, " → ")}${r.winQbRound != null && r.winQbRound < 99 ? `, quarterback in round ${r.winQbRound}` : ""} and finished on ${r.bestPts} points.` }] : []),
                        { kind: "altheader", x: "The lineup you finished with" },
                        ...(r.starters.length
                          ? [{ kind: "playertable", cols: ["rank", "name", "pts"], players: r.starters.map((x) => ({ posRank: x.slot, pos: x.pos, name: x.name, pts: x.pts })) }]
                          : [{ t: "—", x: "No lineup recorded" }]),
                        ...(r.bench.length ? [{ kind: "altheader", x: "Bench" }, { kind: "playertable", cols: ["rank", "name", "pts"], players: r.bench.map((x) => ({ posRank: x.pos, pos: x.pos, name: x.name, pts: x.pts })) }] : []),
                      ])} onMouseLeave={hideTip}
                        className="rungrid" style={{ display: "grid", gridTemplateColumns: RUN_COLS, gap: 8, alignItems: "center", fontSize: 12.5, padding: "7px 8px", cursor: "help",
                          borderTop: "1px solid var(--line)", borderRadius: isBest || isWorst ? 7 : 0,
                          background: isBest ? "rgba(95,208,168,.09)" : isWorst ? "rgba(242,101,92,.08)" : "transparent" }}>
                        <span className="mut num" style={{ fontSize: 11.5 }}>{i + 1}</span>
                        <span style={{ display: "flex", alignItems: "baseline", gap: 3 }}>
                          <b className="num" style={{ fontSize: 14, color: rankColor(r.rank, r.of) }}>{ordinal(r.rank)}</b>
                          <span className="mut" style={{ fontSize: 9.5 }}>of {r.of}</span>
                        </span>
                        <span className="num" style={{ textAlign: "right", fontWeight: 700 }}>{r.pts}</span>
                        <span className="num" style={{ textAlign: "right", fontSize: 11.5, color: r.gapToFirst ? "#F2655C" : "#5FD0A8" }}>{r.gapToFirst ? `−${r.gapToFirst}` : "won"}</span>
                        {/* ⭐ HOVER THE PILLS FOR THE NAMES. Trey: "when you hover on the position of 'your
                            first five' can you show who each person was." The pills answer "what shape",
                            the hover answers "which draft" — and stopping the event here means the row's own
                            tooltip does not immediately overwrite it. */}
                        <span data-runopen={i} style={{ display: "flex", gap: 3, flexWrap: "nowrap", overflow: "hidden", cursor: "help" }}
                          onMouseEnter={(e) => { e.stopPropagation(); showTip(e, [
                            { kind: "take", tone: "neutral", x: `Mock ${i + 1} — how you opened` },
                            ...((r.open5p && r.open5p.length)
                              ? [{ kind: "playertable", cols: ["rank", "name", "pts"], players: r.open5p.map((x) => ({ posRank: `R${x.round}`, pos: x.pos, name: x.name, pts: "" })) }]
                              : [{ t: "—", x: "No picks recorded for this mock" }]),
                          ]); }}>{opened.map((pp, k) => posPill(pp, k))}</span>
                        <span className="num" style={{ textAlign: "right", fontSize: 11.5, color: "var(--mut)" }}>{r.qbRound < 99 ? `R${r.qbRound}` : "none"}</span>
                        {/* ⭐ THE ROSTER SHAPE — the thing you actually compare between two mocks. */}
                        <span style={{ display: "flex", gap: 4, flexWrap: "nowrap", overflow: "hidden" }}>
                          {r.held ? POS.map((pp) => (
                            <span key={pp} className="num" style={{ fontSize: 10.5, color: POS_COLOR[pp] }}>{r.held[pp] || 0}<span className="mut" style={{ fontSize: 8.5 }}>{pp}</span></span>
                          )) : <span className="mut">—</span>}
                        </span>
                        {/* ⭐ 29p — ROUNDS 1 AND 2, STACKED. Trey: "I love that you show the first rounder, but
                            can you show the 2nd rounder next to him." Two lines rather than two columns: the
                            row is already nine columns wide and a tenth would have squeezed the pills at
                            either end, which is the exact complaint that shaped this table in the first place.
                            The round label carries which is which, so a team holding two firsts still reads
                            correctly. */}
                        <span data-runfirst={i} style={{ display: "flex", flexDirection: "column", gap: 2, overflow: "hidden", fontSize: 12, minWidth: 0 }}>
                          {r.best ? (
                            <span style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
                              <span className="mut num" style={{ fontSize: 8.5, width: 15, flexShrink: 0 }}>R{r.best.round}</span>
                              {posPill(r.best.pos, 0)}
                              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{surname(r.best.name)}</span>
                            </span>
                          ) : <span className="mut">—</span>}
                          {r.best2 ? (
                            <span style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0, opacity: 0.86 }}>
                              <span className="mut num" style={{ fontSize: 8.5, width: 15, flexShrink: 0 }}>R{r.best2.round}</span>
                              {posPill(r.best2.pos, 1)}
                              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11.5 }}>{surname(r.best2.name)}</span>
                            </span>
                          ) : null}
                        </span>
                        {/* ⭐ AND THE SAME HOVER ON THE WINNER'S OPENING — "same with the winner section". */}
                        <span data-runwin={i} style={{ display: "flex", gap: 3, alignItems: "center", flexWrap: "nowrap", overflow: "hidden", cursor: "help" }}
                          onMouseEnter={(e) => { e.stopPropagation(); showTip(e, [
                            { kind: "take", tone: "good", x: `Mock ${i + 1} — the team that won the room${r.winPts != null ? ` (${r.winPts} pts)` : ""}` },
                            ...((r.winOpen5p && r.winOpen5p.length)
                              ? [{ kind: "playertable", cols: ["rank", "name", "pts"], players: r.winOpen5p.map((x) => ({ posRank: `R${x.round}`, pos: x.pos, name: x.name, pts: "" })) }]
                              : [{ t: "—", x: "No picks recorded for the winning team" }]),
                            ...(r.winQbRound != null && r.winQbRound < 99 ? [{ t: "Their quarterback", x: `Round ${r.winQbRound}` }] : []),
                          ]); }}>
                          {(r.winOpen5p ? r.winOpen5p.map((x) => x.pos) : (r.winOpen3 ? r.winOpen3.split("-") : [])).map((pp, k) => posPill(pp, k, true))}
                          {r.bestPts != null && <span className="mut num" style={{ fontSize: 10.5, marginLeft: 2 }}>{r.bestPts}</span>}
                        </span>
                      </div>
                    );
                  })}
                  {sorted.length > shownRuns.length && (
                    <div style={{ textAlign: "center", padding: "10px 0 2px" }}>
                      <button className="btn btn-mini" data-runmore onClick={() => setRunAll(true)}>Show all {sorted.length} mocks ▾</button>
                    </div>
                  )}
                  {runAll && sorted.length > 10 && (
                    <div style={{ textAlign: "center", padding: "10px 0 2px" }}>
                      <button className="btn btn-mini" onClick={() => setRunAll(false)}>Show the top 10 only ▴</button>
                    </div>
                  )}
                </div>
              );
            })()}
            {t.myBest && t.myWorst && t.myBest.mock !== t.myWorst.mock && (
              <div style={{ fontSize: 12.5, lineHeight: 1.55, borderTop: "1px solid var(--line)", paddingTop: 10, marginTop: 10 }}>
                <b style={{ color: "#5FD0A8" }}>Your best run</b> finished {ordinal(t.myBest.rank)} ({t.myBest.pts} pts) opening {t.myBest.open3 ? t.myBest.open3.replace(/-/g, " → ") : "—"}
                {t.myBest.qbRound < 99 ? ` and taking a quarterback in round ${t.myBest.qbRound}` : " without drafting a quarterback"}.{" "}
                <b style={{ color: "#F2655C" }}>Your worst</b> finished {ordinal(t.myWorst.rank)} ({t.myWorst.pts} pts) opening {t.myWorst.open3 ? t.myWorst.open3.replace(/-/g, " → ") : "—"}
                {t.myWorst.qbRound < 99 ? ` with a round-${t.myWorst.qbRound} quarterback` : ""}.
              </div>
            )}
          </div>
        </Section>
      )}

      {/* ---- 03 · WAIT OR DON'T ---- */}
      {t.posCurves && t.posCurves.some((c) => c.retention != null) && (
        <Section n={3} title="What you can afford to wait on" accent="#6fa8dc"
          sub="Average projected points of the players your room actually took at each position, by phase of the draft. Every position falls off as a draft goes on — what matters is which ones fall off FASTEST, so the verdicts rank the four against each other rather than against a bar I made up.">
          {/* ⭐⭐⭐ THE COMPARISON, BEFORE THE DETAIL. Trey: "it's even harder to compare that from position to
              position group. I want to basically use color and conditional formatting to show... YES you do
              lose -25 points from taking a QB from round 1-2 to 3-5... but shoot you lose -57 if you do the
              same as a RB... but holy cow it's only -5 if it's a TE."
              One grid, four rows, one cell per band transition, every cell on the SAME points scale and
              coloured by how much it hurts. Reading down a column answers "which position can I not afford
              to wait on between these two phases", which is the decision — and it took four separate charts
              and a lot of arithmetic to answer before. */}
          {t.dropCols && t.posCurves.some((c) => (c.steps || []).some((d) => d != null)) && (
            <div className="panel" style={{ padding: 14, marginBottom: 12 }}>
              <div className="disp" style={{ fontSize: 13, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--mut)", marginBottom: 3 }}>What waiting costs, side by side</div>
              <div className="mut" style={{ fontSize: 11.5, lineHeight: 1.5, marginBottom: 8, maxWidth: 760 }}>
                Projected points given up by moving one phase later at each position. Every cell is on the same scale, so the colour means the same thing in every row — and a cheap wait is good news, so it reads green.
              </div>
              {/* ⭐ THE KEY. A four-colour scale needs one, and it doubles as the instruction: green is the
                  position to let come to you, red is the one to spend a pick on now. */}
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
                {[["#5FD0A8", "cheap — let it come to you"], ["#E0A63C", "watch it"], ["#E39A6E", "act soon"], ["#FF8F86", "take one now"]].map(([c2, lbl]) => (
                  <span key={lbl} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10.5, color: "var(--mut)" }}>
                    <span style={{ width: 12, height: 12, borderRadius: 3, background: `${c2}33`, border: `1px solid ${c2}88` }} />{lbl}
                  </span>
                ))}
              </div>
              <div className="dropgrid" style={{ display: "grid", gridTemplateColumns: `46px repeat(${t.dropCols.length}, minmax(0,1fr))`, gap: 6 }}>
                <span />
                {t.dropCols.map((lbl) => (
                  <span key={lbl} className="mut" style={{ fontSize: 8.5, textTransform: "uppercase", letterSpacing: ".04em", fontWeight: 700, textAlign: "center" }}>{lbl}</span>
                ))}
                {t.posCurves.slice().sort((a, b) => POS.indexOf(a.pos) - POS.indexOf(b.pos)).map((c) => (
                  <React.Fragment key={c.pos}>
                    <span style={{ fontWeight: 800, color: POS_COLOR[c.pos], fontSize: 13, alignSelf: "center" }}>{c.pos}</span>
                    {(c.steps || []).slice(1).map((d, i) => {
                      // Severity is a share of the biggest drop anywhere, which is what makes the colours
                      // comparable ACROSS rows rather than only within one.
                      // ⭐⭐⭐ 29n — A DIVERGING SCALE, NOT FOUR SHADES OF RED. Trey: "The 'What you can
                      //   afford to wait on' board should have better conditional formatting than just a
                      //   bunch of red." He is right: every cell is a cost, so painting them all red says
                      //   only "waiting costs something" — which the reader already knew. The QUESTION is
                      //   which waits are cheap, and a cheap wait is GOOD NEWS, so it should look like it.
                      //   Quartered against the biggest drop on the page: green = let it come to you,
                      //   amber = watch it, orange = act soon, red = this is the one you cannot wait on.
                      const sev = d == null ? 0 : Math.min(1, Math.max(0, d) / Math.max(1, t.dropMax));
                      const gain = d != null && d < 0;
                      const TIER = sev < 0.25 ? 0 : sev < 0.5 ? 1 : sev < 0.75 ? 2 : 3;
                      const TIER_RGB = ["95,208,168", "224,166,60", "217,140,95", "242,101,92"];
                      const TIER_FG = ["#5FD0A8", "#E0A63C", "#E39A6E", "#FF8F86"];
                      const rgb = gain ? "95,208,168" : TIER_RGB[TIER];
                      const bg = d == null ? "var(--panel2)" : `rgba(${rgb},${gain ? 0.16 : 0.10 + (sev - TIER * 0.25) * 0.6 + TIER * 0.04})`;
                      const fg = d == null ? "var(--mut)" : gain ? "#5FD0A8" : TIER_FG[TIER];
                      return (
                        <span key={i} data-dropcell={`${c.pos}:${i}`} title={d == null ? "Your mocks haven't reached this phase at this position yet." : gain ? `${c.pos}s taken here averaged ${Math.abs(d)} points MORE than the phase before — your room reaches at this position.` : `Waiting from ${t.dropCols[i].replace(" to ", " to ")} costs about ${d} projected points at ${c.pos}.`}
                          style={{ textAlign: "center", padding: "7px 4px", borderRadius: 7, background: bg, border: `1px solid rgba(${d == null ? "120,130,145,.3" : `${rgb},${0.28 + sev * 0.4}`})`, cursor: "help" }}>
                          <b className="num" style={{ fontSize: 14.5, color: fg, display: "block", lineHeight: 1.15 }}>{d == null ? "—" : gain ? `+${Math.abs(d)}` : `−${d}`}</b>
                          {d != null && <span style={{ display: "block", height: 3, borderRadius: 2, marginTop: 4, background: fg, opacity: 0.9, width: `${Math.max(6, Math.abs(d) / Math.max(1, t.dropMax) * 100)}%`, marginLeft: "auto", marginRight: "auto" }} />}
                        </span>
                      );
                    })}
                  </React.Fragment>
                ))}
              </div>
              {(() => {
                const worst = t.posCurves.flatMap((c) => (c.steps || []).slice(1).map((d, i) => ({ pos: c.pos, d, i }))).filter((x) => x.d != null && x.d > 0).sort((a, b) => b.d - a.d)[0];
                const best = t.posCurves.flatMap((c) => (c.steps || []).slice(1).map((d, i) => ({ pos: c.pos, d, i }))).filter((x) => x.d != null).sort((a, b) => a.d - b.d)[0];
                if (!worst) return null;
                return (
                  <div style={{ fontSize: 12.5, lineHeight: 1.55, marginTop: 10, paddingLeft: 9, borderLeft: "2px solid #F2655C" }}>
                    The most expensive wait on your board is <b style={{ color: POS_COLOR[worst.pos] }}>{worst.pos}</b> from {t.dropCols[worst.i].toLowerCase()} — about <b style={{ color: "#F2655C" }}>{worst.d} points</b>.
                    {best && best.pos !== worst.pos && <> The cheapest is <b style={{ color: POS_COLOR[best.pos] }}>{best.pos}</b> at {best.d <= 0 ? `+${Math.abs(best.d)}` : `−${best.d}`}, so that is the position to let come to you.</>}
                  </div>
                );
              })()}
            </div>
          )}
          <div className="panel" style={{ padding: 14 }}>
            {/* ⭐ HIS ORDER, NOT THE RANKING'S. Trey: "Can you then put it in this order: QB, RB, WR, TE."
                A list that re-orders itself every time the data moves is one you have to re-read from the
                top; a fixed order lets you go straight to the position you're deciding about. The verdict
                is on every row anyway, so nothing is lost by not sorting by it. */}
            {t.posCurves.slice().sort((a, b) => POS.indexOf(a.pos) - POS.indexOf(b.pos)).map((c) => {
              const vc = /wait/i.test(c.verdict || "") && !/anyway/i.test(c.verdict || "") ? "#5FD0A8" : /early/i.test(c.verdict || "") ? "#F2655C" : "var(--gold)";
              const mx = Math.max(1, ...c.avg.filter((x) => x != null));
              return (
                <div key={c.pos} data-poscurve={c.pos} style={{ padding: "11px 0", borderTop: "1px solid var(--line)" }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 9, marginBottom: 7 }}>
                    <span style={{ fontWeight: 800, color: POS_COLOR[c.pos], fontSize: 15 }}>{c.pos}</span>
                    <span style={{ fontSize: 12.5, fontWeight: 800, color: vc }}>{c.verdict || "—"}</span>
                  </div>
                  {/* ⭐⭐ THE NUMBERS LIVE ON THE CHART, NOT IN A TOOLTIP. Each band is a labelled tile carrying
                      the average projected points of the players taken there and, after the first, how many
                      points that phase gives up against the one before it. Nothing here needs a pointer. */}
                  <div style={{ display: "grid", gridTemplateColumns: `repeat(${c.avg.length}, minmax(0,1fr))`, gap: 6 }}>
                    {c.avg.map((v, i) => {
                      const prev = i > 0 ? c.avg[i - 1] : null;
                      const drop = v != null && prev != null ? prev - v : null;
                      const men = (c.men && c.men[i]) || [];
                      return (
                        <div key={i} data-band={`${c.pos}:${i}`}
                          onMouseEnter={(e) => showTip(e, [
                            { kind: "take", tone: v == null ? "neutral" : "neutral", x: `${c.pos} taken in ${c.bands[i].toLowerCase()}` },
                            { t: v == null ? "No data" : "Average projected points of the players taken there", x: v == null ? "Your mocks haven't reached this phase." : `${v} pts across ${men.length ? "the players below" : "this phase"}` },
                            ...(men.length ? [{ kind: "altheader", x: "Who actually went here — green beats what these rounds ordinarily buy, red doesn't" }] : []),
                            ...men.map((mn) => ({
                              kind: "take", tone: mn.good ? "good" : "bad",
                              x: `${mn.name} — ${mn.pts} pts, went around pick ${mn.avgO}${mn.n > 1 ? ` in ${mn.n} mocks` : ""}`,
                            })),
                          ])} onMouseLeave={hideTip}
                          style={{ border: "1px solid var(--line)", borderRadius: 8, background: "var(--panel2)", padding: "6px 8px 7px", opacity: v == null ? 0.5 : 1, cursor: men.length ? "help" : "default" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                            <span className="mut" style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: ".05em", fontWeight: 700 }}>{c.bands[i].replace("Rounds ", "R")}</span>
                            {/* ⭐⭐⭐ 29n — WHEN THE FIRST AND SECOND ACTUALLY WENT, marked on the picture.
                                Trey: "I want to show a clearer picture for not only the time the first player
                                is drafted, but also when the second player goes... I want the points graphics
                                to show that as well." A filled dot on the band where the best rosters had
                                their first at this position, a hollow one where they had their second — so
                                the tiles read as a timeline rather than four disconnected averages.
                                ⭐ It scales to the format on its own: in a superflex league `startsN` is 2 at
                                QB, so the second-QB marker appears there exactly as it does at RB. */}
                            {[["first", c.firstAt, true], ["second", c.secondAt, false], ["third", c.thirdAt, false]].map(([lbl, rd, filled]) => {
                              if (rd == null || bandOfRound(rd, c.bands) !== i) return null;
                              if (lbl !== "first" && c.startsN < (lbl === "second" ? 2 : 3)) return null;
                              return (
                                <span key={lbl} data-bandmark={`${c.pos}:${lbl}`}
                                  title={`The best-finishing rosters had their ${lbl} ${c.pos} by the end of round ${rd}. Your league starts ${c.startsN} ${c.pos}${c.startsN === 1 ? "" : "s"}.`}
                                  style={{ display: "inline-flex", alignItems: "center", gap: 2, fontSize: 8, fontWeight: 800, color: POS_COLOR[c.pos], cursor: "help", whiteSpace: "nowrap" }}>
                                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: filled ? POS_COLOR[c.pos] : "transparent", border: `1.5px solid ${POS_COLOR[c.pos]}`, display: "inline-block" }} />
                                  {lbl === "first" ? "1st" : lbl === "second" ? "2nd" : "3rd"}
                                </span>
                              );
                            })}
                            {/* ⭐⭐⭐ 29o — AND THE RUN. Trey: "mark the run, not the Nth player."
                                The ordinals say a position is being drafted in order, which it always is.
                                The run says WHEN THE TIER EMPTIES — the window where this position goes
                                faster than it normally does in this room, which is the thing that takes the
                                man you were waiting for. Only drawn where it reliably happens: a run that
                                showed up in two of seven mocks is noise wearing a badge. */}
                            {c.run && c.run.share >= 50 && bandOfRound(c.run.round, c.bands) === i && (
                              <span data-bandrun={`${c.pos}:${c.run.round}`}
                                title={`THE RUN. In ${c.run.seen} of your ${c.run.of} completed mocks the ${c.pos}s start going in a cluster around round ${c.run.round} — about ${c.run.n} of them inside ${c.run.window} picks, well above the rate they go at the rest of the draft. That is the window where the tier you were waiting on empties, and it is a different question from when the first or second one goes.`}
                                style={{ display: "inline-flex", alignItems: "center", gap: 2, fontSize: 8, fontWeight: 800, color: "#F2655C", cursor: "help", whiteSpace: "nowrap", border: "1px solid #F2655C77", background: "rgba(242,101,92,.12)", borderRadius: 3, padding: "0 3px" }}>
                                <i className="ti ti-flame" style={{ fontSize: 8 }} aria-hidden="true" />RUN
                              </span>
                            )}
                          </div>
                          {/* ⭐⭐ THE DROP IS THE HEADLINE, NOT THE LEVEL. Trey: "The graphs just don't really
                              do it for me because it's a random line to 'fill up' showing the max points,
                              but it's hard to follow." He is right — a bar filled against that position's
                              OWN maximum makes every position's first band look identical and says nothing
                              you can act on. The level is still printed, small; the loud number is what
                              this phase costs you, and its bar is on the page-wide scale so the same length
                              means the same points at QB as at RB. */}
                          <div className="num mut" style={{ fontSize: 11, fontWeight: 700, lineHeight: 1.2 }}>{v == null ? "—" : `${v} pts`}</div>
                          {drop == null ? (
                            <div className="mut" style={{ fontSize: 9.5, marginTop: 3 }}>{v == null ? "no data yet" : "starting level"}</div>
                          ) : (() => {
                            const sev = Math.min(1, Math.max(0, drop) / Math.max(1, t.dropMax || 1));
                            const gain = drop < 0;
                            return (
                              <>
                                <div className="num" style={{ fontSize: 18, fontWeight: 800, lineHeight: 1.2, marginTop: 1, color: gain ? "#5FD0A8" : sev > 0.5 ? "#F2655C" : sev > 0.22 ? "var(--gold)" : "var(--ink)" }}>
                                  {gain ? `+${Math.abs(drop)}` : `−${drop}`}
                                </div>
                                <div style={{ height: 4, background: "var(--panel)", borderRadius: 3, overflow: "hidden", margin: "3px 0 3px" }}>
                                  <div style={{ height: "100%", width: `${Math.max(4, (Math.abs(drop) / Math.max(1, t.dropMax || 1)) * 100)}%`, background: gain ? "#5FD0A8" : sev > 0.5 ? "#F2655C" : sev > 0.22 ? "var(--gold)" : "var(--line2)" }} />
                                </div>
                                <div className="mut" style={{ fontSize: 9 }}>vs {c.bands[i - 1].replace("Rounds ", "R")}</div>
                              </>
                            );
                          })()}
                        </div>
                      );
                    })}
                  </div>
                  {/* ⭐ AND THE PLAIN-LANGUAGE WHY, in points rather than a percentage of something invisible. */}
                  {c.why && (
                    <div data-why={c.pos} style={{ fontSize: 12.5, lineHeight: 1.5, marginTop: 7, paddingLeft: 9, borderLeft: `2px solid ${vc}` }}>{c.why}</div>
                  )}
                  {/* ⭐⭐⭐ AND THE PACE. "you could take a RB in round 1… but if you wait until round 9 to
                      take your second, you're probably in a bad spot." Everything above this line is about
                      the FIRST one; this row is about how many you have by when, best rosters against
                      worst, at the end of each band. */}
                  {c.pace && c.pace.some((x) => x.top != null) && (
                    <div data-pace={c.pos} style={{ marginTop: 8, padding: "8px 10px", borderRadius: 8, background: "var(--panel2)", border: "1px solid var(--line)" }}>
                      <div style={{ display: "grid", gridTemplateColumns: `92px repeat(${c.pace.length}, minmax(0,1fr))`, gap: 6, alignItems: "center" }}>
                        <span className="mut" style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: ".05em", fontWeight: 700 }}>{c.pos}s held by</span>
                        {c.pace.map((x) => <span key={x.byRound} className="mut num" style={{ fontSize: 10, textAlign: "center" }}>end of R{x.byRound}</span>)}
                        <span style={{ fontSize: 10.5, fontWeight: 700, color: "#5FD0A8" }}>Best rosters</span>
                        {c.pace.map((x) => <span key={x.byRound} className="num" style={{ fontSize: 13, fontWeight: 800, textAlign: "center", color: "#5FD0A8" }}>{x.top == null ? "—" : x.top}</span>)}
                        <span className="mut" style={{ fontSize: 10.5 }}>Worst rosters</span>
                        {c.pace.map((x) => <span key={x.byRound} className="num mut" style={{ fontSize: 13, textAlign: "center" }}>{x.bottom == null ? "—" : x.bottom}</span>)}
                      </div>
                      {c.paceLine && <div data-paceline={c.pos} style={{ fontSize: 12, lineHeight: 1.5, marginTop: 7, paddingTop: 7, borderTop: "1px solid var(--line)" }}>{c.paceLine}</div>}
                      {/* ⭐ 29o — the run, in words as well as as a badge. The badge says WHERE; this says
                          what it is and how reliable it is, which is what decides whether you move a pick. */}
                      {c.run && c.run.share >= 50 && (
                        <div data-runline={c.pos} style={{ fontSize: 12, lineHeight: 1.5, marginTop: 7, paddingTop: 7, borderTop: "1px solid var(--line)" }}>
                          <b style={{ color: "#F2655C" }}>The run:</b> {c.pos}s come off in a cluster around <b>round {c.run.round}</b> — about <b>{c.run.n}</b> inside {c.run.window} picks, in {c.run.seen} of your {c.run.of} mocks.{" "}
                          {c.firstAt != null && c.run.round > c.firstAt
                            ? `The first one goes in round ${c.firstAt}; the tier empties ${c.run.round - c.firstAt} round${c.run.round - c.firstAt === 1 ? "" : "s"} later, and that is the deadline that matters.`
                            : "It starts as soon as the position starts going at all — there is no quiet window here."}
                        </div>
                      )}
                    </div>
                  )}
                  {/* ⭐⭐ WHERE THE TWO READS DISAGREE, SAY SO HERE rather than letting section 01 and this
                      one contradict each other on opposite ends of the page. */}
                  {c.conflict && (
                    <div data-conflict={c.pos} style={{ fontSize: 12, lineHeight: 1.5, marginTop: 6, padding: "6px 9px", borderRadius: 7, background: "rgba(212,175,55,.09)", border: "1px solid rgba(212,175,55,.28)" }}>
                      <b style={{ color: "var(--gold)" }}>But how they finished says otherwise. </b>{c.conflict}
                    </div>
                  )}
                  {/* ⭐ AND WHO TO TAKE THERE. "It's also not really showing what players you should target
                      late within each round (basically who are the league winners)." A verdict of "safe to
                      wait" is only useful if it comes with the names you're waiting FOR. */}
                  {c.late.length > 0 && (
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 7, flexWrap: "wrap" }}>
                      <span className="mut" style={{ fontSize: 9.5, textTransform: "uppercase", letterSpacing: ".05em" }}>Worth waiting for</span>
                      {c.late.map((v) => (
                        <span key={v.id} onMouseEnter={(e) => showTip(e, [
                          { kind: "take", tone: "good", x: `${v.name} — usually goes round ${v.goesRound}` },
                          { t: "What he's worth", x: `Priced like a round-${v.worthRound} pick on this board.` },
                          { kind: "playercard", p: v.p },
                        ])} onMouseLeave={hideTip}
                          style={{ fontSize: 11, padding: "1px 7px", borderRadius: 999, border: `1px solid ${POS_COLOR[c.pos]}55`, background: "var(--panel2)", cursor: "help" }}>
                          {surname(v.name)} <span className="mut">R{v.goesRound}</span>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {/* ⭐⭐⭐ AND THE OTHER HALF OF THE PLAN: WHO IS ACTUALLY THERE AT YOUR PICKS.
              Trey: "I also want to show the players that are worth pursuing early in drafts (that are
              available around your pick)... if I have the 8th pick, I know I'm not getting Jahmyr Gibbs...
              but perhaps you signal I should take Saquon Barkley at my 2nd pick and CeeDee Lamb at my 1st.
              Basically I want combinations or strategies that you think will best help me obtain success."
              Every other list on this page describes the market in general and none of them know where he
              SITS — a bargain that never reaches pick 8 is not a plan. This is measured, not reasoned: for
              each of his first picks it walks every completed mock, takes who was genuinely still on the
              board at that exact overall pick, and ranks those by value. "Available in 6 of 7" is a fact
              about his room. A name is claimed by the EARLIEST pick it can plausibly be taken at, so the
              column reads as a sequence rather than the same leaderboard four times. */}
          {t.earlyPlan && t.earlyPlan.length > 0 && (
            <div className="panel" style={{ padding: 14, marginTop: 12 }} data-earlyplan>
              <div className="disp" style={{ fontSize: 13, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--mut)", marginBottom: 3 }}>Worth taking early — who actually reaches your picks</div>
              <div className="mut" style={{ fontSize: 11.5, lineHeight: 1.5, marginBottom: 10, maxWidth: 860 }}>
                From your seat, in your mocks: one row per pick you own, and the players still on the board when it came round. The <b style={{ color: "var(--gold)" }}>gold outline</b> is the route I'd take. Each name is coloured by how its market ADP compares with THAT pick number — <b style={{ color: "#5FD0A8" }}>green</b> means the room usually takes him earlier, so having him there is found money; <b style={{ color: "#E39A6E" }}>orange</b> means you'd be taking him ahead of the market. <b style={{ color: "#5FD0A8" }}>◦</b> marks a man who was still there at your NEXT pick too, so he can wait.
              </div>
              {/* ⭐⭐⭐ 29o — THE ROUTES, COMPARED. Trey: "make the route a comparison, not a verdict."
                  One row per opening you could genuinely take at your first pick, each walked out with the
                  same rules, each priced on the same scale: VALUE OVER REPLACEMENT OF THE PLAYERS WHO
                  ACTUALLY START. That number is why this is a comparison rather than three opinions — a
                  fourth running back scores nothing because he does not crack the lineup, and a starting
                  slot you never filled scores nothing either, so hoarding and holes are both priced without
                  a thumb on the scale. The cost column is the whole feature: what going WR instead of RB
                  costs you by round ten, in points over replacement, on your own measured board. */}
              {t.earlyRoutes && t.earlyRoutes.length > 1 && (
                <div data-routecmp={t.earlyRoutes.length} style={{ marginBottom: 12, paddingBottom: 11, borderBottom: "1px solid var(--line)" }}>
                  <div className="mut" style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: ".06em", fontWeight: 700, marginBottom: 5 }}>
                    Where each opening leaves you — round {t.earlyRoutes[0].steps[0].round} to {t.earlyRoutes[0].steps[t.earlyRoutes[0].steps.length - 1].round}
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto auto auto", gap: "0 10px", alignItems: "center" }}>
                    {["Open", "Shape", "Starters", "Cost"].map((h) => (
                      <div key={h} className="mut" style={{ fontSize: 8.5, textTransform: "uppercase", letterSpacing: ".05em", fontWeight: 700, paddingBottom: 3, textAlign: h === "Open" ? "left" : "right" }}>{h}</div>
                    ))}
                    {t.earlyRoutes.map((r) => (
                      <React.Fragment key={r.open}>
                        <div data-routeopen={r.open} style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 0", borderTop: "1px solid var(--line2)", minWidth: 0 }}>
                          <b style={{ fontSize: 11, color: POS_COLOR[r.open], flexShrink: 0 }}>{r.open}</b>
                          <span style={{ fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{surname(r.openName || "")}</span>
                          {r.best && <span style={{ flexShrink: 0, fontSize: 8, fontWeight: 800, letterSpacing: ".05em", color: "var(--gold)", border: "1px solid var(--gold)", borderRadius: 3, padding: "0 3px" }}>BEST</span>}
                        </div>
                        <div style={{ padding: "5px 0", borderTop: "1px solid var(--line2)", display: "flex", gap: 2, justifyContent: "flex-end" }}
                          title={r.steps.map((s) => `${s.label} ${s.pos} ${surname(s.name)}`).join("  ·  ")}>
                          {r.shape.map((q, qi) => <b key={qi} style={{ fontSize: 9.5, color: POS_COLOR[q], letterSpacing: "-.02em" }}>{q}{qi < r.shape.length - 1 ? <span className="mut" style={{ fontWeight: 400 }}>·</span> : null}</b>)}
                        </div>
                        <div className="num" style={{ padding: "5px 0", borderTop: "1px solid var(--line2)", textAlign: "right", fontWeight: 800, fontSize: 12, color: r.best ? "var(--gold)" : "var(--ink)" }}
                          title={`${r.vor} points of value over replacement in the starting lineup this route fills — ${r.pts} projected points across those starters.\n\n${(r.slots || []).map((s) => `${s.slot}  ${s.name} (R${s.round})`).join("\n")}${r.bench ? `\n+ ${r.bench} on the bench` : ""}${r.holes.length ? `\n\nStill unfilled after round ${r.steps[r.steps.length - 1].round}: ${r.holes.join(", ")}.` : "\n\nEvery starting slot filled."}\n\nThese names were on the board at these picks in ${r.conf}% of your completed mocks on average.`}>
                          {r.vor}
                        </div>
                        <div className="num" style={{ padding: "5px 0", borderTop: "1px solid var(--line2)", textAlign: "right", fontSize: 11.5, fontWeight: 700, color: r.cost === 0 ? "var(--mut)" : r.cost <= 12 ? "var(--gold)" : "#F2655C" }}
                          title={r.cost === 0 ? "The strongest starting lineup of the openings your board actually offers." : `Going ${r.open} instead costs ${r.cost} points of starting-lineup value over replacement by round ${r.steps[r.steps.length - 1].round}.`}>
                          {r.cost === 0 ? "—" : `−${r.cost}`}
                        </div>
                      </React.Fragment>
                    ))}
                  </div>
                  {/* Holes are the thing a shape does not show, so they get said in words. */}
                  {t.earlyRoutes.some((r) => r.holes.length) && (
                    <div className="mut" style={{ fontSize: 10.5, lineHeight: 1.5, marginTop: 6 }}>
                      {t.earlyRoutes.filter((r) => r.holes.length).map((r) => `${r.open} leaves ${r.holes.join(" and ")} unfilled`).join("; ")}.
                    </div>
                  )}
                </div>
              )}
              {/* ⭐⭐⭐ 29n — THE ROUTE, ACROSS THE TOP. Trey: "could it lay out the direction you would
                  recommend going in each round in order to optimize winning." One chip per pick, read left to
                  right; the reasoning is in each chip's hover so the strip stays a strip. */}
              {t.earlyRoute && t.earlyRoute.length > 0 && (
                <div data-earlyroute={t.earlyRoute.length} style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "stretch", marginBottom: 12, paddingBottom: 11, borderBottom: "1px solid var(--line)" }}>
                  <span className="mut" style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: ".06em", fontWeight: 700, alignSelf: "center", marginRight: 2 }}>The route</span>
                  {t.earlyRoute.map((st, i) => (
                    <span key={st.o} data-routestep={st.pos} title={`${st.label} — ${st.name}: ${st.why}. He was on the board here in ${st.seen} of your ${st.of} completed mocks${st.adp != null ? `, market ADP ${st.adp}` : ""}.`}
                      style={{ display: "inline-flex", flexDirection: "column", gap: 1, border: `1px solid ${POS_COLOR[st.pos]}55`, background: `${POS_COLOR[st.pos]}14`, borderRadius: 7, padding: "4px 7px", cursor: "help", minWidth: 0 }}>
                      <span style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
                        <b className="num mut" style={{ fontSize: 8.5 }}>{st.label}</b>
                        <b style={{ fontSize: 10, color: POS_COLOR[st.pos] }}>{st.pos}</b>
                      </span>
                      <span style={{ fontSize: 11, whiteSpace: "nowrap" }}>{surname(st.name)}</span>
                    </span>
                  ))}
                </div>
              )}
              {/* ⭐⭐ AND THE OPTIONS AS A GRID, NOT TEN CARDS. Trey: "this widget is taking up a ton of
                  space, so I'd like to find a way to either fit more horizontally or vertically (or both)."
                  Ten cards of five two-line rows was ~540px of column. One row per pick with five chips
                  across is the same information in roughly a third of the height, and it reads the way the
                  decision reads: your pick on the left, what is actually there on the right. */}
              <div className="planscroll scrollhint" style={{ overflowX: "auto" }}>
                <div style={{ minWidth: 720 }}>
                  {t.earlyPlan.map((row, ri) => {
                    const chosen = (t.earlyRoute || []).find((s) => s.o === row.o);
                    return (
                      <div key={row.o} data-planpick={row.label} className="planrow"
                        style={{ display: "grid", gridTemplateColumns: "62px repeat(5, minmax(0,1fr))", gap: 6, alignItems: "stretch", padding: "5px 0", borderTop: ri ? "1px solid var(--line)" : "none" }}>
                        <span style={{ display: "flex", flexDirection: "column", justifyContent: "center", lineHeight: 1.2 }}>
                          <b className="num" style={{ fontSize: 12.5, color: "var(--gold)" }}>{row.label}</b>
                          <span className="mut" style={{ fontSize: 8.5, textTransform: "uppercase", letterSpacing: ".04em" }}>round {row.round}</span>
                        </span>
                        {row.picks.map((pk) => {
                          const isRoute = chosen && chosen.name === pk.name;
                          // ⭐ ADP AGAINST THIS PICK. Under it = the market takes him earlier than you are,
                          //   which is the definition of value at this slot; over it = you are reaching.
                          const v = pk.vsPick;
                          const col = v == null ? "var(--mut)" : v <= -8 ? "#5FD0A8" : v <= -2 ? "#8FD8BC" : v < 8 ? "var(--ink)" : v < 20 ? "#E39A6E" : "#F2655C";
                          return (
                            <span key={pk.name} data-planrow={pk.name} data-planroute={isRoute ? "1" : ""}
                              title={`${pk.name} — value ${pk.val > 0 ? "+" : ""}${pk.val}${pk.adp != null ? ` · market ADP ${pk.adp}, ${v === 0 ? "exactly this pick" : v < 0 ? `${Math.abs(v)} picks BEFORE this slot — value if he's here` : `${v} picks after this slot — you'd be taking him early`}` : ""}. On the board here in ${pk.seen} of ${pk.of} mocks${pk.waitable ? `, and still there at your next pick in ${pk.nextSeen}` : ""}.${isRoute ? ` ROUTE: ${chosen.why}.` : ""}`}
                              style={{ display: "flex", flexDirection: "column", gap: 1, borderRadius: 6, padding: "4px 6px", cursor: "help", minWidth: 0,
                                border: isRoute ? "1px solid var(--gold)" : "1px solid var(--line)", background: isRoute ? "rgba(224,166,60,.10)" : "var(--panel2)" }}>
                              <span style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
                                <b style={{ fontSize: 9, color: POS_COLOR[pk.pos], flexShrink: 0 }}>{pk.pos}</b>
                                <span style={{ fontSize: 11.5, color: col, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: isRoute ? 700 : 400 }}>{pk.name}</span>
                                {pk.waitable && <span data-planwait style={{ flexShrink: 0, fontSize: 11, color: "#5FD0A8", lineHeight: 1 }} title="Still there at your next pick in most mocks">◦</span>}
                              </span>
                              <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                                <span className="mut num" data-planadp={pk.adp == null ? "" : pk.adp} style={{ fontSize: 8.5 }}>{pk.adp != null ? `ADP ${pk.adp}` : "ADP —"}</span>
                                <span className="num" style={{ fontSize: 8.5, fontWeight: 700, color: col }}>{v == null ? "" : v === 0 ? "even" : v < 0 ? `${v}` : `+${v}`}</span>
                                <div style={{ flex: 1 }} />
                                <span className="num" style={{ fontSize: 8.5, fontWeight: 700, color: vbdColor(pk.val) }}>{pk.val > 0 ? `+${pk.val}` : pk.val}</span>
                              </span>
                            </span>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </Section>
      )}

      {/* ---- 04 · BARGAINS ---- */}
      {t.valuePlayers && t.valuePlayers.length > 0 && (
        <Section n={4} title="Going later than they're worth" accent="#5FD0A8"
          sub={`Where a player's ${t.valueMetric === "value" ? "long-term value" : "value over replacement"} is higher than the pick he actually goes at in your room would ordinarily buy. Read it as "goes in round 6, plays like a round 3 pick". Kickers and defenses are left out — they're priced on a different basis entirely.`}>
          {pricePair("val",
            priceCol("val", `Rounds 1-${cut}`, "starters — a round of surplus here is the whole draft", t.valueEarly || [], "Rounds of value", "value"),
            priceCol("val", `Rounds ${cut + 1}+`, "depth and fliers — cheap, and where a room gives away points", t.valueLate || [], "Rounds of value", "value"),
            hiddenIn(t.valueEarly, t.valueLate))}
        </Section>
      )}

      {/* ---- 05 · AVOID ---- */}
      {t.avoidPlayers && t.avoidPlayers.length > 0 && (
        <Section n={5} title="Going earlier than they're worth" accent="#F2655C"
          sub="The mirror image: your room reaches for these. Letting one come to you two rounds later costs nothing, and taking him at his going rate costs you the pick. Kickers and defenses are excluded here too.">
          {pricePair("avd",
            priceCol("avd", `Rounds 1-${cut}`, "the expensive mistakes — one of these costs you a starter", t.avoidEarly || [], "Rounds overpaid", "avoid"),
            priceCol("avd", `Rounds ${cut + 1}+`, "cheap reaches — worth knowing, but nobody loses a season here", t.avoidLate || [], "Rounds overpaid", "avoid"),
            hiddenIn(t.avoidEarly, t.avoidLate))}
        </Section>
      )}

      {/* ---- 06 · THE EVIDENCE ---- */}
      {/* ⭐⭐⭐ THIRD REWRITE, AND THIS TIME BY SUBTRACTION. Trey, for the third time: "The 'When the best
          teams took each position' is still so incredibly confusing." Each previous attempt answered his
          complaint by ADDING — more columns, more labels, a caveat line — and every addition made the thing
          he could not read slightly larger. So this version throws out the tables. It is ONE SENTENCE and
          ONE PICTURE per position: the rounds the best rosters took their first at that position, the round
          they came back for the second, and the same window for the group that did worst. Every number that
          used to sit in a column is still available, in the hover, where it belongs. */}
      <Section n={6} title="When to take each position" accent="var(--mut)"
        sub={`Read straight across. The solid band is the window the best-finishing rosters took their FIRST at that position; the dot after it is when they came back for their second; the dashed band underneath is what the worst-finishing rosters did. The number inside each band is that group's average projected lineup, and "best" means a top-${t.podium || 3} finish in its own room. Hover any band for the sample behind it.`}>
        <div className="panel" style={{ padding: 14 }}>
          {(t.groups || []).filter((g) => g && POS.includes(g.label) && g.buckets.length >= 2).map((g) => {
            const best = g.buckets[0], worst = g.buckets[g.buckets.length - 1];
            const spread = best.pts - worst.pts;
            const R = Math.max(1, t.lastRound || 15);
            const pct = (r) => `${Math.max(0, Math.min(100, ((r - 1) / R) * 100))}%`;
            const wide = (lo, hi) => `${Math.max(3, ((Math.min(hi, R) - lo + 1) / R) * 100)}%`;
            const col = POS_COLOR[g.label] || "var(--gold)";
            const sentence = spread <= 0
              ? `No timing separated itself at ${g.label} — every group finished within ${Math.abs(spread)} points of the others, so take the board.`
              : `Take your first ${g.label} in ${best.lo === best.hi ? `round ${best.lo}` : `rounds ${best.lo}-${best.hi === R ? "" : best.hi}`}${best.hi >= R ? "+" : ""}${best.secondRound ? `, and the second around round ${Math.round(best.secondRound)}` : ""}. Rosters that did averaged ${best.pts} projected points — ${spread} more than the ones that waited until ${worst.lo === worst.hi ? `round ${worst.lo}` : `round ${worst.lo}${worst.hi >= R ? "+" : `-${worst.hi}`}`}.`;
            // ⭐ THE HONEST CAVEAT, kept from the last version but now as words only — the chips below are
            //   filtered to this position, so nothing under a "WR" heading is a running back any more.
            // ⚠ THE CAVEAT USED TO READ "only 0% of the players separating that group are QBs, so a good
            //   part of their edge came from what they did elsewhere" — Trey: "I don't know what this
            //   means." Neither does anybody: it is a percentage of an invisible denominator, and at 0% it
            //   is a sentence about nothing. What it was trying to say is worth saying, so say THAT: name
            //   the positions those teams actually separated themselves at.
            const others = (best.winnersAll || []).filter((w) => cpos(w.pos) !== g.label);
            const otherPos = [...new Set(others.map((w) => cpos(w.pos)))];
            const caveat = spread > 0 && otherPos.length && (best.winners || []).length === 0
              ? `None of the players that separated this group are ${g.label}s — what set them apart was their ${otherPos.join(" and ")}. Read the timing as a by-product of that, not as a ${g.label} finding.`
              : spread > 0 && otherPos.length >= 2 && (best.winners || []).length < otherPos.length
                ? `Their edge wasn't only at ${g.label} — the same teams also separated themselves at ${otherPos.join(" and ")}.`
                : null;
            const band = (b, tone) => (
              <div key={tone} data-window={`${g.label}:${tone}`} onMouseEnter={(e) => showTip(e, [
                { kind: "take", tone: tone === "best" ? "good" : "bad", x: `${b.key} — averaged ${b.pts} projected points` },
                { t: "vs the room", x: `${b.edge >= 0 ? "+" : ""}${b.edge} against the average team across all your mocks, keeper value held equal, over ${b.n} team-drafts.` },
                ...(b.topShare != null ? [{ t: `Top-${t.podium || 3} finishes`, x: `${b.topShare}% of these teams finished top ${t.podium || 3} in their own room.` }] : []),
                ...(b.secondRound
                  ? [{ t: `Their second ${g.label}`, x: `${b.secondShare}% took another, around round ${b.secondRound}. They finished with ${b.held} ${g.label}${b.held === 1 ? "" : "s"}.` }]
                  : [{ t: `Their second ${g.label}`, x: "Most of these teams never took a second one." }]),
                ...(b.typical && b.typical.some((x) => x.p)
                  ? [{ kind: "altheader", x: "What those teams typically took, round by round — all positions" },
                     { kind: "playertable", cols: ["rank", "name", "pts"], players: b.typical.filter((x) => x.p).map((x) => ({ posRank: `R${x.round}`, pos: x.p.pos, name: x.p.name, pts: Math.round(x.p.pts || 0) })) }]
                  : []),
              ])} onMouseLeave={hideTip}
                style={{ position: "absolute", left: pct(b.lo), width: wide(b.lo, b.hi), top: tone === "best" ? 0 : 20, height: 17, borderRadius: 4, cursor: "help",
                  // ⚠ The BEST band takes the position's own colour, which for QB and TE is already a warm
                  //   red — so the worst band cannot be red too or the two read as the same thing. Muted
                  //   dashed outline instead: filled = what worked, outlined = what didn't.
                  background: tone === "best" ? col : "transparent", opacity: tone === "best" ? 0.9 : 1,
                  border: tone === "best" ? "none" : "1px dashed var(--mut)",
                  display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
                <span className={tone === "best" ? "num" : "num mut"} style={{ fontSize: 9.5, fontWeight: 700, color: tone === "best" ? "#0d0f12" : undefined, whiteSpace: "nowrap" }}>
                  {b.pts}
                </span>
              </div>
            );
            return (
              <div key={g.label} data-poswhen={g.label} style={{ padding: "12px 0", borderTop: "1px solid var(--line)" }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 9, marginBottom: 5, flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 800, color: col, fontSize: 15 }}>{g.label}</span>
                  <span data-takeaway={g.label} style={{ fontSize: 12.5, lineHeight: 1.5 }}>{sentence}</span>
                </div>
                {spread > 0 && (
                  <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 14, alignItems: "center" }}>
                    <div>
                      <div style={{ position: "relative", height: 48 }}>
                        {/* the round rail */}
                        <div style={{ position: "absolute", left: 0, right: 0, top: 8, height: 1, background: "var(--line)" }} />
                        <div style={{ position: "absolute", left: 0, right: 0, top: 28, height: 1, background: "var(--line)" }} />
                        {band(best, "best")}
                        {band(worst, "worst")}
                        {/* ⭐ WHEN THEY CAME BACK. The whole reason "first WR in round 6+" looked wrong. */}
                        {/* ⭐ AND THE WORST GROUP'S SECOND PICK TOO, hollow. Trey: "I want a dot for the
                            2nd player for the 'worst lineups' — that dot can just not be colored in."
                            The pair is the whole point: it is the gap between when the good rosters came
                            back and when the bad ones did. */}
                        {worst.secondRound && (
                          <div data-second={`${g.label}:worst`} onMouseEnter={(e) => showTip(e, [
                            { kind: "take", tone: "bad", x: `The worst group's second ${g.label} — around round ${worst.secondRound}` },
                            { t: "How many did it", x: `${worst.secondShare}% of the teams in the worst group came back for another, and they finished with ${worst.held} ${g.label}${worst.held === 1 ? "" : "s"} on average.` },
                          ])} onMouseLeave={hideTip}
                            style={{ position: "absolute", left: pct(worst.secondRound), top: 19, transform: "translateX(-50%)", cursor: "help" }}>
                            <div style={{ width: 12, height: 12, borderRadius: 999, background: "transparent", border: `2px solid var(--mut)` }} />
                            <div className="mut num" style={{ fontSize: 8.5, marginTop: 1, transform: "translateX(-30%)" }}>2nd</div>
                          </div>
                        )}
                        {best.secondRound && (
                          <div data-second={g.label} onMouseEnter={(e) => showTip(e, [
                            { kind: "take", tone: "good", x: `Their second ${g.label} — around round ${best.secondRound}` },
                            { t: "How many did it", x: `${best.secondShare}% of the teams in the winning group came back for another, and they finished with ${best.held} ${g.label}${best.held === 1 ? "" : "s"} on average.` },
                          ])} onMouseLeave={hideTip}
                            style={{ position: "absolute", left: pct(best.secondRound), top: -1, transform: "translateX(-50%)", cursor: "help" }}>
                            <div style={{ width: 12, height: 12, borderRadius: 999, background: col, border: "2px solid var(--panel)" }} />
                            <div className="mut num" style={{ fontSize: 8.5, marginTop: 1, transform: "translateX(-30%)" }}>2nd</div>
                          </div>
                        )}
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 1 }}>
                        {[1, Math.ceil(R / 4), Math.ceil(R / 2), Math.ceil((3 * R) / 4), R].map((r, k) => (
                          <span key={k} className="mut num" style={{ fontSize: 8.5 }}>R{r}</span>
                        ))}
                      </div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div className="num" style={{ fontSize: 17, fontWeight: 800, color: "#5FD0A8", lineHeight: 1.15 }}>+{spread}</div>
                      <div className="mut" style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: ".05em" }}>pts, best vs worst</div>
                      <div className="mut num" style={{ fontSize: 9.5, marginTop: 2 }}>{best.n} team-drafts{best.topShare != null ? ` · ${best.topShare}% top ${t.podium || 3}` : ""}</div>
                    </div>
                  </div>
                )}
                {caveat && <div data-caveat={g.label} style={{ fontSize: 11.5, lineHeight: 1.45, marginTop: 6, color: "var(--gold)" }}>{caveat}</div>}
                {best.winners && best.winners.length > 0 && (
                  <div data-winners={g.label} style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 7, flexWrap: "wrap" }}>
                    <span className="mut" style={{ fontSize: 9.5, textTransform: "uppercase", letterSpacing: ".05em" }}>The {g.label}s on those rosters</span>
                    {best.winners.map((w) => (
                      <span key={w.id} onMouseEnter={(e) => showTip(e, [
                        { kind: "take", tone: "good", x: `${w.name} — on ${w.onN} of the ${w.of} teams in this group` },
                        { t: "Why he's flagged", x: `Across all your mocks he shows up ${w.lift}% more often on teams that finished top ${t.podium || 3} in their room than on the ones that finished bottom ${t.podium || 3}.` },
                      ])} onMouseLeave={hideTip}
                        style={{ fontSize: 11, padding: "1.5px 8px", borderRadius: 999, cursor: "help", border: `1px solid ${col}55`, background: "var(--panel2)" }}>
                        {surname(w.name)} <span className="mut num">+{w.lift}%</span>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {/* the opening-shape finding, as one sentence rather than its own table */}
          {(() => {
            const g = (t.groups || []).find((x) => x && x.label === "shape" && x.buckets.length >= 2);
            if (!g) return null;
            const b = g.buckets[0], w = g.buckets[g.buckets.length - 1];
            const d = b.pts - w.pts;
            return (
              <div data-takeaway="shape" style={{ fontSize: 12.5, lineHeight: 1.55, borderTop: "1px solid var(--line)", paddingTop: 11, marginTop: 4 }}>
                <b>How they opened. </b>
                {d > 0
                  ? <span className="mut">Rosters that opened <b style={{ color: "var(--ink)" }}>{b.key.replace(/-early$/, "-heavy")}</b> averaged {b.pts} projected points, {d} more than the ones that opened {w.key.replace(/-early$/, "-heavy")} ({b.n} team-drafts vs {w.n}).</span>
                  : <span className="mut">Neither an RB-heavy nor a WR-heavy start separated itself — every opening finished within {Math.abs(d)} points of the others.</span>}
              </div>
            );
          })()}
          {t.findings.filter((f) => f.k === "top").map((f) => (
            <div key={f.k} style={{ fontSize: 12.5, lineHeight: 1.55, borderTop: "1px solid var(--line)", paddingTop: 10, marginTop: 8 }}>
              <b>{f.head}. </b><span className="mut">{f.body}</span>
            </div>
          ))}
        </div>
      </Section>

      {/* ---- footer ---- */}
      <div style={{ marginTop: 28, padding: "14px 16px", borderRadius: 11, border: `1px solid ${t.enough ? "var(--line)" : "var(--gold)"}`, background: "var(--panel2)", display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
        <i className={`ti ${t.enough ? "ti-circle-check" : "ti-alert-circle"}`} style={{ fontSize: 20, color: t.enough ? "#5FD0A8" : "var(--gold)" }} aria-hidden="true" />
        <div style={{ flex: 1, minWidth: 220, fontSize: 12.5, lineHeight: 1.55 }}>
          {t.enough
            ? `Read from ${t.n} mocks — enough that one unusual room can't swing a finding on its own. Every mock you add keeps it current as ADP moves.`
            : `Read from ${t.n} mock${t.n === 1 ? "" : "s"}. Run ${Math.max(1, 6 - t.n)} more and these stop being able to swing on one unusual room — the plan above will sharpen with each one.`}
        </div>
        {onRunMock && <button className={`btn btn-mini${t.enough ? "" : " btn-gold"}`} onClick={onRunMock}><i className="ti ti-dice-5" style={{ fontSize: 12, marginRight: 4 }} aria-hidden="true" />Run a mock draft</button>}
      </div>
    </TrendsShell>
  );
}

export default MockTrendsPage;
