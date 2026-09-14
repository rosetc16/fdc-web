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
import { Dot } from "../App.jsx";

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
  live: { label: "in progress", tone: "#5FD0A8", icon: "ti-player-play" },
  done: { label: "played",      tone: "var(--mut)", icon: "ti-check" },
  unknown: { label: "—",        tone: "var(--mut)", icon: "ti-help" },
};

/* ⭐⭐⭐⭐ ONE PLAYER, ONE ROW — 29o.
   Trey: "On web, though, I'd probably just show Root For and Root Against side by side. There's a ton of
   blank space between the player name and the points right now, so I think we can use that space much more
   effectively."
   Two things fix that space rather than one. Splitting into two columns halves the row width, which closes
   most of the gap by itself; and the space that IS left now carries the LEAGUE NAMES, which were previously
   hidden behind a hover icon. "Starting in 5" tells you the size of your stake; "Work League, Dynasty,
   Home League +2" tells you where it is, which is the thing you were going to hover to find out. */
function RootRow({ p, wide }) {
  const st = STATE[p.state] || STATE.unknown;
  const rootFor = p.net > 0;
  const tone = p.net === 0 ? "var(--mut)" : rootFor ? "#5FD0A8" : "#F2655C";
  const names = (rootFor ? p.forLeagues : p.againstLeagues).map((l) => l.leagueName);
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
        <div className="mut" style={{ fontSize: 11, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          title={[
            p.forLeagues.length ? `For: ${p.forLeagues.map((l) => l.leagueName).join(", ")}` : "",
            p.againstLeagues.length ? `Against: ${p.againstLeagues.map((l) => l.leagueName).join(", ")}` : "",
          ].filter(Boolean).join("  |  ")}>
          {shown.length ? (
            <>{shown.join(", ")}{extra > 0 ? ` +${extra}` : ""}
              {/* Both sides only when he is genuinely on both — otherwise it is noise on every row. */}
              {rootFor && p.against > 0 && <span style={{ color: "#F2655C" }}> · against you in {p.against}</span>}
              {!rootFor && p.for > 0 && <span style={{ color: "#5FD0A8" }}> · starting in {p.for}</span>}
            </>
          ) : (
            <>
              {p.for > 0 && <span style={{ color: "#5FD0A8" }}>starting in {p.for}</span>}
              {p.for > 0 && p.against > 0 && <span> · </span>}
              {p.against > 0 && <span style={{ color: "#F2655C" }}>against you in {p.against}</span>}
            </>
          )}
        </div>
      </div>
      {/* ⚠ A RANGE WHEN THE LEAGUES DISAGREE. The same catch is 1.0 in PPR and 0 in standard, so one
          number would be true in none of his leagues. */}
      {p.pts && (
        <span className="num" data-gdpts style={{ fontSize: 12.5, fontWeight: 800, flexShrink: 0, textAlign: "right",
          minWidth: 52, color: p.state === "pre" ? "var(--mut)" : "var(--ink)" }}>
          {p.pts.varies ? `${r1(p.pts.lo)}–${r1(p.pts.hi)}` : r1(p.pts.median)}
        </span>
      )}
    </div>
  );
}

export default function GameDay({ leagues, onHome, onBack, backLabel, onOpenHub }) {
  const [data, setData] = useState(null);
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
    const sig = ids.join(",");
    if (!sig) { setLoading(false); return; }
    let alive = true;
    let timer = null;

    const load = async (quiet) => {
      if (!quiet) setLoading(true);
      try {
        const r = await api.sleeperLive(ids, undefined, connected.map(ownerOf));
        if (!alive) return;
        setData(r); setAt(Date.now()); setErr(null);
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
  }, [connected, data && data.at]);

  const board = useMemo(() => {
    const all = (data && data.rooting) || [];
    const rows = side === "for" ? all.filter((p) => p.net > 0)
      : side === "against" ? all.filter((p) => p.net < 0)
      : all.filter((p) => p.net !== 0 || p.for + p.against > 1);
    return rows.slice(0, 40);
  }, [data, side]);

  // The two columns the desktop layout uses. Same ordering rule as the single list: biggest swing first.
  const forRows = useMemo(() => ((data && data.rooting) || []).filter((p) => p.net > 0).slice(0, 25), [data]);
  const againstRows = useMemo(() => ((data && data.rooting) || []).filter((p) => p.net < 0).slice(0, 25), [data]);

  const T = (data && data.totals) || null;

  return (
    <div data-screen="gameday" style={{ minHeight: "100vh", background: "var(--bg)" }}>
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
            <div className="disp" style={{ fontSize: 19, fontWeight: 800, marginBottom: 6 }}>
              {T.winning}–{T.losing}{T.tied ? `–${T.tied}` : ""} across {T.leagues} league{T.leagues === 1 ? "" : "s"}
            </div>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 12 }}>
              {T.close > 0 && <span><b className="num" style={{ color: "var(--gold)" }}>{T.close}</b>
                <span className="mut"> still within 15</span></span>}
              {/* ⭐⭐⭐ THE NUMBER THAT SAYS WHETHER A DEFICIT IS REAL. Down twenty with four still to play
                  is a different afternoon from down twenty with none, and the scoreline alone says the
                  opposite of the truth. */}
              <span><b className="num" style={{ color: "#5FD0A8" }}>{T.yetToPlay}</b>
                <span className="mut"> of your starters yet to play</span></span>
              <span><b className="num" style={{ color: "#F2655C" }}>{T.oppYetToPlay}</b>
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

        {/* ===================== THE ROOTING BOARD ===================== */}
        {data && (
          <>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
              <span className="disp" style={{ fontSize: 15, fontWeight: 800 }}>Who to root for</span>
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
                {[["for", "Root for", "#5FD0A8", "ti-arrow-up", forRows],
                  ["against", "Root against", "#F2655C", "ti-arrow-down", againstRows]].map(([k, label, tone, icon, list]) => (
                  <div key={k} data-gdcolumn={k} style={{ flex: "1 1 380px", minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
                      <i className={`ti ${icon}`} style={{ fontSize: 13, color: tone }} aria-hidden="true" />
                      <span className="disp" style={{ fontSize: 12.5, fontWeight: 800, color: tone, letterSpacing: ".03em" }}>{label}</span>
                      <span className="mut num" style={{ fontSize: 11 }}>{list.length}</span>
                    </div>
                    <div className="panel" style={{ padding: 6, borderColor: `${tone}33` }}>
                      {list.length
                        ? list.map((p) => <RootRow key={p.sid} p={p} wide />)
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
                {board.map((p) => <RootRow key={p.sid} p={p} wide={false} />)}
              </div>
            )}

            {/* ===================== THE MATCHUPS ===================== */}
            <div className="disp" style={{ fontSize: 15, fontWeight: 800, marginBottom: 8 }}>Your matchups</div>
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
                return (
                  <div key={L.leagueId || i} className="panel" data-gdmatch={name} style={{ padding: 12 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                      <button onClick={() => onOpenHub && league && onOpenHub(league.id)}
                        style={{ cursor: "pointer", fontFamily: "inherit", background: "none", border: "none",
                          color: "var(--ink)", fontSize: 14, fontWeight: 800, padding: 0, textAlign: "left" }}
                        className="disp">{name}</button>
                      <span className="num" data-gdscore style={{ fontSize: 14, fontWeight: 800,
                        color: margin == null ? "var(--mut)" : up ? "#5FD0A8" : margin === 0 ? "var(--mut)" : "#F2655C" }}>
                        {r1(L.me.pts)}{L.opp ? ` – ${r1(L.opp.pts)}` : ""}
                      </span>
                      {margin != null && (
                        <span style={{ fontSize: 11, fontWeight: 700, color: up ? "#5FD0A8" : margin === 0 ? "var(--mut)" : "#F2655C" }}>
                          {up ? "+" : ""}{margin}
                        </span>
                      )}
                      <span className="mut" style={{ fontSize: 11.5, marginLeft: "auto" }}>
                        {L.me.yetToPlay} yet to play{L.opp ? ` · ${L.opp.yetToPlay} for ${L.opp.teamName || "them"}` : ""}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="mut" style={{ fontSize: 11, lineHeight: 1.55, marginTop: 14 }}>
              Scores and per-player points come from each league's own scoring, exactly as the platform settled
              them — nothing here is recomputed, so this can never disagree with your league's scoreboard.
              "Yet to play" is read from NFL kickoff times; whether a game is currently in progress is inferred
              from a window around kickoff rather than a live game clock, so treat it as a good guess and
              "yet to play" as the reliable one.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
