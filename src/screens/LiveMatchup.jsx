/* ⭐⭐⭐⭐ ONE LEAGUE'S MATCHUP, LIVE — 29n.
   ================================================================================================
   Trey: "You can then see it at the league level in the hub."

   The Game Day board answers "what should I be rooting for" across fifteen leagues. This answers the much
   narrower question you have once you have picked one of them up: how is THIS game going, who has played,
   and what is left. Side by side, because a fantasy matchup is two lineups and reading them in one column
   is how you lose track of which half is yours.

   ⚠ IT READS THE SAME CACHED SCOREBOARD AS THE HOME STRIP AND GAME DAY. Three screens, one fetch — see
     src/livecache.js. A hub that fetched its own copy would eventually show a score the home page that
     linked to it disagrees with, and that bug is invisible until somebody screenshots both.

   ⚠ "YET TO PLAY" IS THE COLUMN THAT MATTERS, and it is the one a platform scoreboard leaves out. Down
     eighteen with three players left is a different game from down eighteen with none, and the score alone
     tells you the opposite of the truth.
   ================================================================================================ */
import React, { useState, useEffect } from "react";
import { Dot } from "../App.jsx";

const r1 = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : n);
const STATE = {
  pre:  { label: "yet to play", tone: "var(--gold)", icon: "ti-clock" },
  live: { label: "in progress", tone: "#5FD0A8", icon: "ti-player-play" },
  done: { label: "played",      tone: "var(--mut)", icon: "ti-check" },
  unknown: { label: "",         tone: "var(--mut)", icon: "" },
};

function Lineup({ side, mine, nameOf }) {
  if (!side) return <div className="mut" style={{ fontSize: 12, padding: 10 }}>No opponent this week.</div>;
  return (
    <div style={{ flex: "1 1 260px", minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
        <span className="disp" style={{ fontSize: 13.5, fontWeight: 800, color: mine ? "var(--gold)" : "var(--ink)" }}>
          {mine ? "You" : (side.teamName || "Them")}
        </span>
        <span className="num" style={{ fontSize: 16, fontWeight: 800, marginLeft: "auto" }}>{r1(side.pts)}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
        {(side.players || []).map((p, i) => {
          const st = STATE[p.state] || STATE.unknown;
          return (
            <div key={`${p.sid}-${i}`} data-lmplayer={nameOf(p.sid)}
              style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 7px", borderRadius: 6,
                background: p.state === "pre" ? "rgba(224,166,60,.06)" : "transparent" }}>
              <span style={{ flexShrink: 0 }}><Dot pos={p.pos} /></span>
              <span style={{ fontSize: 12.5, flex: "1 1 auto", minWidth: 0, overflow: "hidden",
                textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{nameOf(p.sid)}</span>
              {st.icon && <i className={`ti ${st.icon}`} title={st.label} style={{ fontSize: 11, color: st.tone, flexShrink: 0 }} aria-hidden="true" />}
              <span className="num" style={{ fontSize: 12, fontWeight: 700, flexShrink: 0, width: 40, textAlign: "right",
                color: p.state === "pre" ? "var(--mut)" : "var(--ink)" }}>
                {p.pts == null ? "—" : r1(p.pts)}
              </span>
            </div>
          );
        })}
      </div>
      <div className="mut" style={{ fontSize: 11, marginTop: 6, display: "flex", gap: 10, flexWrap: "wrap" }}>
        <span><b className="num" style={{ color: side.yetToPlay ? "var(--gold)" : "var(--mut)" }}>{side.yetToPlay}</b> yet to play</span>
        {side.playing > 0 && <span><b className="num" style={{ color: "#5FD0A8" }}>{side.playing}</b> in progress</span>}
        <span>{side.played} played</span>
      </div>
    </div>
  );
}

export default function LiveMatchup({ leagues, leagueId, onGameDay }) {
  const [live, setLive] = useState(null);
  const [err, setErr] = useState(null);
  const [at, setAt] = useState(null);

  useEffect(() => {
    let alive = true;
    let timer = null;
    const tick = async () => {
      try {
        const { loadLive } = await import("../livecache.js");
        const v = await loadLive(leagues);
        if (!alive) return;
        setLive(v); setAt(Date.now()); setErr(null);
        const on = !!(v && v.weekState && v.weekState.anyLive);
        // Same cadence rule as everywhere else: follow the games, not the clock.
        timer = setTimeout(() => { if (typeof document === "undefined" || !document.hidden) tick(); else timer = setTimeout(tick, 60000); },
          on ? 45000 : 10 * 60 * 1000);
      } catch (e) { if (alive) setErr(String((e && e.message) || e)); }
    };
    tick();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [leagues]);

  if (err) return <div className="panel" style={{ padding: 14, color: "var(--red)", fontSize: 13 }}>{err}</div>;
  if (!live) return <div className="panel mut" style={{ padding: 18, fontSize: 13 }}>Reading the scoreboard…</div>;

  const L = (live.leagues || []).find((x) => String(x.leagueId) === String(leagueId));
  if (!L) return <div className="panel mut" style={{ padding: 18, fontSize: 13 }}>This league is not on the live board.</div>;
  if (!L.me) {
    return (
      <div className="panel mut" data-lmempty style={{ padding: 18, fontSize: 13 }}>
        {L.ownerResolved === false
          ? "Can't tell which team is yours in this league — link the Sleeper account that owns it under Settings."
          : `No matchup recorded for week ${live.week}.`}
      </div>
    );
  }

  /* Names come off the rooting board, which already carries every started player in every league — there is
     no second lookup and no second source that could disagree about a spelling. */
  const meta = new Map((live.rooting || []).map((p) => [String(p.sid), p]));
  const nameOf = (sid) => (meta.get(String(sid)) || {}).name || `Player ${sid}`;
  const withPos = (side) => (side ? { ...side, players: (side.players || []).map((p) => ({ ...p, pos: (meta.get(String(p.sid)) || {}).pos })) } : null);

  const margin = L.opp ? r1(L.me.pts - L.opp.pts) : null;
  const up = margin != null && margin > 0;
  const ws = live.weekState || {};

  return (
    <div data-livematchup={String(leagueId)}>
      <div className="panel" style={{ padding: 14, marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 4 }}>
          {ws.anyLive && (
            <span data-lmlive style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10.5,
              fontWeight: 800, letterSpacing: ".06em", color: "#0d1210", background: "#5FD0A8",
              borderRadius: 99, padding: "2px 9px" }}>
              <span className="livedot" style={{ width: 6, height: 6, borderRadius: 99, background: "#0d1210" }} aria-hidden="true" />LIVE
            </span>
          )}
          <span className="disp" data-lmscore style={{ fontSize: 20, fontWeight: 800 }}>
            {r1(L.me.pts)}{L.opp ? ` – ${r1(L.opp.pts)}` : ""}
          </span>
          {margin != null && (
            <span style={{ fontSize: 13, fontWeight: 800, color: up ? "#5FD0A8" : margin === 0 ? "var(--mut)" : "#F2655C" }}>
              {up ? "+" : ""}{margin}
            </span>
          )}
          <span className="mut" style={{ fontSize: 11, marginLeft: "auto" }}>
            week {live.week}{at ? ` · updated ${new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}
          </span>
        </div>
        {/* ⭐⭐⭐ THE SENTENCE THE SCORE CANNOT SAY ON ITS OWN. */}
        <div className="mut" style={{ fontSize: 12 }}>
          {L.opp
            ? `${L.me.yetToPlay} of your starters yet to play, ${L.opp.yetToPlay} of theirs.`
            : `${L.me.yetToPlay} of your starters yet to play.`}
          {onGameDay && <> <button onClick={onGameDay} style={{ cursor: "pointer", fontFamily: "inherit", background: "none",
            border: "none", padding: 0, color: "var(--gold)", fontSize: 12, textDecoration: "underline" }}>
            See all leagues →</button></>}
        </div>
      </div>

      <div className="panel" style={{ padding: 12, display: "flex", gap: 18, flexWrap: "wrap" }}>
        <Lineup side={withPos(L.me)} mine nameOf={nameOf} />
        <Lineup side={withPos(L.opp)} nameOf={nameOf} />
      </div>

      <div className="mut" style={{ fontSize: 11, lineHeight: 1.55, marginTop: 10 }}>
        Points are this league's own scoring, exactly as the platform settled them — nothing is recomputed
        here, so this cannot disagree with your league's scoreboard. "Yet to play" comes from NFL kickoff
        times; whether a game is currently in progress is inferred from a window around kickoff rather than a
        live game clock.
      </div>
    </div>
  );
}
