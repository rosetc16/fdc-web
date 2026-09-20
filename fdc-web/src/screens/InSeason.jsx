/* ⭐⭐⭐⭐⭐ ONE IN-SEASON SCREEN, THREE TABS — 29p.
   ================================================================================================
   Trey: "On the 'Game Day' — when you click it, I still want to see the other tabs that you can toggle to
   on this page (My Week / Game Day / Weekly Review)."

   These were three separate routes, which meant the three questions a season week asks — what do I need to
   fix, who am I rooting for, what should I have done — were three round trips through the home page. On a
   Sunday you move between them constantly, and a home page in between is not navigation, it is an
   interruption.

   ⚠ THE TAB STRIP IS THE SCREEN; THE THREE PANELS ARE UNCHANGED. Nothing about My Week, Game Day or the
     review moved into this file — it mounts the existing components, so there is still exactly one
     implementation of each and nothing to drift. What this adds is the strip, the shared header, and the
     fact that switching tabs is instant instead of a page load and a refetch.

   ⚠ AND THE PANELS ARE KEPT ALIVE ONCE OPENED. Game Day polls; unmounting it on every tab change would
     throw away the poll and the cache and start the fan-out again the moment you came back. Panels you
     have opened stay mounted and hidden, so hopping between tabs costs nothing and the live board keeps
     ticking behind the review you flicked to.
   ================================================================================================ */
import React, { useState, useEffect } from "react";
import MyWeek from "./MyWeek.jsx";
import GameDay from "./GameDay.jsx";
import WeeklyReview from "./WeeklyReview.jsx";

const TABS = [
  ["myweek", "My Week", "ti-first-aid-kit", "What needs fixing before kickoff"],
  ["gameday", "Game Day", "ti-activity-heartbeat", "Live scores and who to root for"],
  ["review", "Review", "ti-history", "What you could have done better"],
];

export default function InSeason({ user, leagues, initialTab, onHome, onBack, backLabel, onOpenHub, onUmbrella, onUpdate }) {
  const [tab, setTab] = useState(TABS.some(([k]) => k === initialTab) ? initialTab : "myweek");
  // Which panels have ever been opened — see the note above on keeping them mounted.
  const [seen, setSeen] = useState(() => ({ [TABS.some(([k]) => k === initialTab) ? initialTab : "myweek"]: true }));
  useEffect(() => { setSeen((s) => (s[tab] ? s : { ...s, [tab]: true })); }, [tab]);

  return (
    <div data-screen="inseason" data-inseasontab={tab} style={{ minHeight: "100vh", background: "var(--bg)" }}>
      <div className="hairline appheader" style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 16px", flexWrap: "wrap" }}>
        <button className="btn btn-mini" onClick={onBack || onHome}>← {backLabel || "Home"}</button>
        <span className="disp" style={{ fontSize: 17, fontWeight: 800 }}>In season</span>
        <div className="filterchips" data-inseasontabs style={{ display: "flex", gap: 5, flexWrap: "wrap", marginLeft: 6 }}>
          {TABS.map(([k, label, icon, title]) => {
            const on = tab === k;
            return (
              <button key={k} data-inseasontab={k} onClick={() => setTab(k)} aria-pressed={on} title={title}
                style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5,
                  fontWeight: on ? 800 : 600, padding: "5px 12px", borderRadius: 99, cursor: "pointer",
                  fontFamily: "inherit",
                  border: `1px solid ${on ? "var(--pos)" : "var(--line)"}`,
                  color: on ? "#0d1210" : "var(--mut)",
                  background: on ? "var(--pos)" : "transparent" }}>
                <i className={`ti ${icon}`} style={{ fontSize: 13 }} aria-hidden="true" />{label}
              </button>
            );
          })}
        </div>
      </div>

      {/* `hidden` rather than unmounting: an unmounted Game Day loses its poll and refetches on return. */}
      {seen.myweek && (
        <div hidden={tab !== "myweek"}>
          <MyWeek user={user} leagues={leagues} embedded onHome={onHome} onBack={onBack} backLabel={backLabel}
            onOpenHub={onOpenHub} onUmbrella={onUmbrella} />
        </div>
      )}
      {seen.gameday && (
        <div hidden={tab !== "gameday"}>
          <GameDay leagues={leagues} embedded onHome={onHome} onBack={onBack} backLabel={backLabel} onOpenHub={onUmbrella} />
        </div>
      )}
      {seen.review && (
        <div hidden={tab !== "review"} style={{ maxWidth: 1100, margin: "0 auto", padding: "16px 16px 40px" }}>
          {/* ⚠ onOpenHub TAKES A SLEEPER-SHAPED OBJECT, NOT AN APP LEAGUE ID — 29t. This passed `l.id`, the
              app's own internal id ("L0"), as a bare string; App.jsx reads `sl.league_id` off it, got
              undefined, and the team-hub route fell through to "This team view needs to be reopened".
              The hub is keyed on the SLEEPER league id, which is what hubIdOf returns. */}
          <WeeklyReview leagues={leagues} scope="all"
            onOpenLeague={(l) => {
              const sleeperId = (l && ((l.connect && l.connect.leagueId)
                || (l.cfg && l.cfg.connect && l.cfg.connect.leagueId) || l.sleeperLeagueId)) || null;
              if (sleeperId && onOpenHub) onOpenHub({ league_id: sleeperId });
            }} />
        </div>
      )}
    </div>
  );
}
