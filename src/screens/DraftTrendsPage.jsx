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
import { CURRENT_SEASON, normName, setTeams, POS, POS_COLOR, setOrder, setPickTrades, setKeeperAdds, buildPlayers, setSpec, demand, sample, Dot, AppHeader, analyzeDraftTrends, PosFlowBar, formatKey } from "../App.jsx";

function DraftTrendsPage({ user, leagues, funMocks, onBack, onHome, onSignOut, onOpenLeague }) {
  // Pulled real Sleeper drafts (the user's own completed drafts), merged into the trend set on demand.
  // Only offered when a Sleeper account is linked — that's the "only if it's possible" gate.
  const canPullSleeper = !!(user && user.sleeperUsername) && hasBackend;
  const [pulled, setPulled] = useState([]);       // [{ id, name, cfg, picks:[ourId], kind:'sleeper', fmt, at }]
  const [pullState, setPullState] = useState("idle"); // idle | loading | done | error
  const [pullMsg, setPullMsg] = useState("");
  // Collect EVERY draft the account has — official league drafts and all mocks (league + standalone) —
  // each tagged with its format so we can filter to a comparable set.
  // A mock only feeds trends if it's substantial (see saveMock: ~2+ rounds AND ≥25% of the board). A handful of
  // picks isn't market signal and shouldn't move anything site-wide. Older saved mocks predate the flag, so we
  // fall back to the same rule computed on the fly rather than silently trusting them.
  const isSubstantialMock = (m, cfg) => {
    if (!m || !m.picks) return false;
    if (m.substantial != null) return !!m.substantial;
    const total = (m.total != null) ? m.total : (((cfg && cfg.rounds) || 15) * ((cfg && cfg.teams) || 12));
    return m.picks.length >= 24 && (total > 0 ? m.picks.length / total >= 0.25 : false);
  };
  const allDrafts = useMemo(() => {
    const out = [];
    leagues.forEach((l) => {
      if (l.picks && l.picks.length >= 12) out.push({ id: l.id, name: l.name, cfg: l.cfg, picks: l.picks, kind: "official", fmt: formatKey(l.cfg), at: l.lastPickAt || null });
      (l.mocks || []).forEach((m) => { if (isSubstantialMock(m, l.cfg)) out.push({ id: `${l.id}:${m.id}`, name: `${l.name} — mock`, cfg: l.cfg, picks: m.picks, kind: "mock", fmt: formatKey(l.cfg), at: m.at || null }); });
    });
    (funMocks || []).forEach((m) => { if (isSubstantialMock(m, m.cfg)) out.push({ id: m.id, name: m.name || "Quick mock", cfg: m.cfg, picks: m.picks, kind: "mock", fmt: formatKey(m.cfg), at: m.at || null }); });
    pulled.forEach((d) => out.push(d));
    return out;
  }, [leagues, funMocks, pulled]);

  // Pull the user's own completed Sleeper drafts and fold the format-matched ones into the trend set.
  // Sequence: list their Sleeper leagues → fetch each league's draft → keep completed ones → map each
  // pick's NAME to our player id → store as a 'sleeper' draft. Purely additive; can be cleared.
  const pullSleeper = async () => {
    if (!canPullSleeper) return;
    setPullState("loading"); setPullMsg("Finding your Sleeper leagues…");
    try {
      const resLg = await api.sleeperMyLeagues().catch(() => null);
      const lgs = (resLg && resLg.leagues) || [];
      if (!lgs.length) { setPullState("done"); setPulled([]); setPullMsg("No Sleeper leagues found on your account."); return; }
      // name → our player id, from the current rep pool (falls back to a generic pool if none yet)
      const pool = players.length ? players : (() => { setTeams(12); setSpec({ QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, SUPER: 0 }); setOrder("snake"); setPickTrades(null); setKeeperAdds({}); return buildPlayers({ type: "redraft", teams: 12, rounds: 15, start: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, SUPER: 0 }, scoring: { rec: 1 } }); })();
      const byName = {}; pool.forEach((p) => { byName[normName(p.name)] = p.id; });
      const out = [];
      let done = 0;
      for (const lg of lgs) {
        setPullMsg(`Reading drafts… (${++done}/${lgs.length})`);
        const lid = lg.league_id || lg.leagueId || lg.id;
        if (!lid) continue;
        const dr = await api.sleeperDraft(lid, user.sleeperUsername).catch(() => null);
        if (!dr || !Array.isArray(dr.picks) || dr.picks.length < 12) continue; // skip empty / too-short
        const cfg = dr.cfg || {};
        // Preserve pick POSITIONS: map names to ids but keep null for unmapped names (don't collapse the
        // array, or every later player shifts to an earlier pick — that's what made ADPs look impossible).
        // analyzeDraftTrends skips null pids, so positions stay accurate.
        const mapped = dr.picks.map((pk) => { const id = byName[normName(pk.name || "")]; return id != null ? id : null; });
        const hit = mapped.filter((x) => x != null).length;
        if (hit < 12 || hit < mapped.length * 0.6) continue; // too few names matched — skip rather than distort
        out.push({ id: `sleeper:${lid}`, name: `${dr.name || lg.name || "Sleeper league"} (Sleeper)`, cfg, picks: mapped, kind: "sleeper", fmt: formatKey(cfg), at: dr.startedAt || dr.completedAt || null });
      }
      setPulled(out);
      setPullState("done");
      setPullMsg(out.length ? `Pulled ${out.length} Sleeper draft${out.length === 1 ? "" : "s"} into your trends.` : "No completed Sleeper drafts found to add.");
    } catch (e) {
      setPullState("error"); setPullMsg("Couldn't reach Sleeper right now — try again in a moment.");
    }
  };

  const [q, setQ] = useState("");
  // Smart defaults from the user's own leagues: if they play superflex and/or dynasty, start there — the
  // page is far more useful landing on the format they actually draft than on a generic 1QB redraft that's
  // often empty in the offseason. Falls back to redraft/1QB when we can't tell.
  const leagueDefaults = useMemo(() => {
    const cfgs = (leagues || []).map((l) => l.cfg).filter(Boolean);
    if (!cfgs.length) return { type: "redraft", qb: "1qb", te: "std" };
    const sf = cfgs.filter((c) => (c.start && c.start.SUPER > 0) || c.sf || (c.start && c.start.QB >= 2)).length;
    const dyn = cfgs.filter((c) => (c.type || "redraft") === "dynasty").length;
    const tep = cfgs.filter((c) => c.tePremMult > 0).length;
    return {
      type: dyn > cfgs.length / 2 ? "dynasty" : "redraft",
      qb: sf > cfgs.length / 2 ? "sf" : "1qb",
      te: tep > cfgs.length / 2 ? "tep" : "std",
    };
  }, [leagues]);
  const [typeF, setTypeF] = useState(leagueDefaults.type);
  const [showDraftList, setShowDraftList] = useState(false); // "see the drafts behind this trend" modal
  const [draftListQ, setDraftListQ] = useState("");           // search drafts by a player they contain
  const [viewDraft, setViewDraft] = useState(null);          // a single draft opened for its full board
  const [qbF, setQbF] = useState(leagueDefaults.qb);
  const [teF, setTeF] = useState(leagueDefaults.te);
  const [teamsF, setTeamsF] = useState("all");
  const [kindF, setKindF] = useState("all"); // all | official | mock
  const [cutoff, setCutoff] = useState(""); // "" = auto (model chooses + weights recent); else YYYY-MM-DD
  const [showCal, setShowCal] = useState(false);

  const qbOf = (c) => ((c.start && c.start.SUPER > 0) || c.sf || (c.start && c.start.QB >= 2)) ? "sf" : "1qb";
  const cutoffMs = cutoff ? new Date(cutoff + "T00:00:00").getTime() : null;
  const matched = useMemo(() => allDrafts.filter((d) => {
    const c = d.cfg || {};
    if (typeF !== "all" && (c.type || "redraft") !== typeF) return false;
    if (qbF !== "all" && qbOf(c) !== qbF) return false;
    if (teF !== "all") { const isTep = c.tePremMult > 0; if ((teF === "tep") !== isTep) return false; }
    if (teamsF !== "all" && String(c.teams || 12) !== teamsF) return false;
    if (kindF !== "all" && d.kind !== kindF) return false;
    // Explicit cutoff: drop drafts BEFORE the chosen date (drafts with no timestamp are kept — we can't
    // date them, and excluding them would silently hide data). Auto mode (no cutoff) keeps everything and
    // instead down-weights older drafts in the aggregation.
    if (cutoffMs != null && d.at != null && d.at < cutoffMs) return false;
    return true;
  }), [allDrafts, typeF, qbF, teF, teamsF, kindF, cutoffMs]);

  // ===== Aggregated pool from the backend (thousands of harvested real Sleeper drafts) =====
  // This is the headline data source: how the WHOLE FIELD drafts each player in this format, not just the
  // handful of drafts on this account. Derived format key follows the filter chips so it always matches
  // what the user is looking at. Falls back server-side to a richer profile when a format is thin.
  const poolFormat = useMemo(() => {
    const scoring = teF === "tep" ? "PPR" : "PPR"; // trends are PPR-bucketed by default; TE prem is its own axis
    const qb = qbF === "sf" ? "SF" : "1QB";
    const te = teF === "tep" ? "TEP" : "STD";
    const pool = typeF === "dynasty" ? "DYNASTY" : typeF === "bestball" ? "BESTBALL" : typeF === "rookie" ? "ROOKIE" : "REDRAFT";
    const teams = teamsF === "all" ? "12" : (Number(teamsF) <= 10 ? "8-10" : Number(teamsF) >= 14 ? "14+" : "12");
    return [scoring, qb, te, pool, teams].join("|");
  }, [typeF, qbF, teF, teamsF]);
  const [pool, setPool] = useState({ state: "idle", players: [], draftCount: 0, usedFormat: null, thin: false, fallback: false });
  useEffect(() => {
    if (!hasBackend) { setPool({ state: "off", players: [], draftCount: 0 }); return; }
    let cancelled = false;
    setPool((p) => ({ ...p, state: "loading" }));
    api.trendsBoard(poolFormat, CURRENT_SEASON, { limit: 300, minDrafts: 5, minPicks: 2 })
      .then((r) => { if (cancelled) return; setPool({ state: "done", players: r.players || [], draftCount: r.draftCount || 0, usedFormat: r.usedFormat, thin: !!r.thin, fallback: !!r.fallback, note: r.note }); })
      .catch(() => { if (!cancelled) setPool({ state: "error", players: [], draftCount: 0 }); });
    return () => { cancelled = true; };
  }, [poolFormat]);
  // Pool rows filtered by the same player-name search box.
  const poolRows = useMemo(() => {
    if (!pool.players || !pool.players.length) return [];
    if (!q.trim()) return pool.players;
    const s = q.toLowerCase();
    return pool.players.filter((r) => (r.name || "").toLowerCase().includes(s));
  }, [pool, q]);

  // Build a representative player pool for the matched format (use the most common cfg among matches).
  const repCfg = useMemo(() => {
    if (!matched.length) return null;
    const tally = {}; matched.forEach((d) => { const k = formatKey(d.cfg); (tally[k] = tally[k] || { n: 0, cfg: d.cfg }); tally[k].n++; });
    return Object.values(tally).sort((a, b) => b.n - a.n)[0].cfg;
  }, [matched]);
  const players = useMemo(() => {
    if (!repCfg) return [];
    setTeams(repCfg.teams || 12); setSpec(repCfg.start); setOrder(repCfg.order || "snake"); setPickTrades(null); setKeeperAdds({});
    return buildPlayers(repCfg);
  }, [repCfg]);

  // When no explicit cutoff is chosen, the model weights recent drafts more (recency decay) — the newest
  // drafts are the most relevant. An explicit cutoff instead hard-filters and treats the kept set evenly.
  const trends = useMemo(() => analyzeDraftTrends(matched, players, { weightRecency: !cutoff, now: Date.now() }), [matched, players, cutoff]);

  // Player-name search filters the realized-ADP table (separate from the draft-set filters above).
  const realizedRows = useMemo(() => {
    if (!trends.realized) return [];
    if (!q.trim()) return trends.realized;
    const s = q.toLowerCase();
    return trends.realized.filter((r) => r.name.toLowerCase().includes(s));
  }, [trends, q]);

  const chip = (val, cur, set, label) => (
    <button onClick={() => set(val)} style={{ cursor: "pointer", fontFamily: "inherit", fontSize: 11.5, fontWeight: cur === val ? 700 : 500, padding: "4px 10px", borderRadius: 99, border: `1px solid ${cur === val ? "var(--gold)" : "var(--line)"}`, background: cur === val ? "rgba(224,166,60,.14)" : "transparent", color: cur === val ? "var(--gold)" : "var(--mut)" }}>{label}</button>
  );

  const teamOpts = useMemo(() => Array.from(new Set(allDrafts.map((d) => String(d.cfg.teams || 12)))).sort((a, b) => +a - +b), [allDrafts]);

  return (
    <div>
      <AppHeader user={user} onSignOut={onSignOut} onHome={onHome} onApp={onBack} title="Draft Trends" />
      <div style={{ maxWidth: 1000, margin: "0 auto", padding: "24px 20px 60px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6, flexWrap: "wrap" }}>
          <div style={{ width: 40, height: 40, borderRadius: 11, background: "rgba(224,166,60,.14)", display: "flex", alignItems: "center", justifyContent: "center" }}><i className="ti ti-chart-histogram" style={{ fontSize: 22, color: "var(--gold)" }} aria-hidden="true" /></div>
          <div>
            <div className="disp" style={{ fontSize: 24, fontWeight: 700, lineHeight: 1.05 }}>Draft Trends</div>
            <div className="mut" style={{ fontSize: 13 }}>How the board actually behaves across your drafts — filter to a format and see the patterns.</div>
          </div>
        </div>

        {/* filters */}
        <div className="panel" style={{ padding: 14, marginTop: 14, marginBottom: 16 }}>
          <div style={{ position: "relative", marginBottom: 12 }}>
            <i className="ti ti-search" style={{ position: "absolute", left: 11, top: 9, fontSize: 15, color: "var(--mut)" }} aria-hidden="true" />
            <input className="gs" style={{ width: "100%", paddingLeft: 34, paddingTop: 8, paddingBottom: 8, fontSize: 13.5 }} placeholder="Search a player in the results…" value={q} onChange={(e) => setQ(e.target.value)} />
            {q.trim() && <button onClick={() => setQ("")} style={{ position: "absolute", right: 8, top: 7, background: "transparent", border: "none", color: "var(--mut)", cursor: "pointer", padding: 4 }} aria-label="Clear"><i className="ti ti-x" aria-hidden="true" /></button>}
          </div>

          {/* Date cutoff — drop drafts before a chosen date. Empty = auto (model weights recent drafts more). */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
            <span className="mut" style={{ fontSize: 11, width: 42 }}>Since</span>
            <div style={{ position: "relative" }}>
              <button onClick={() => setShowCal((v) => !v)} className="btn btn-mini" style={{ borderColor: cutoff ? "var(--gold)" : "var(--line)", color: cutoff ? "var(--gold)" : "var(--ink)" }}>
                <i className="ti ti-calendar" style={{ fontSize: 13, marginRight: 5 }} aria-hidden="true" />
                {cutoff ? new Date(cutoff + "T00:00:00").toLocaleDateString() : "Auto (recent weighted)"}
              </button>
              {showCal && (
                <div style={{ position: "absolute", zIndex: 10, top: "100%", left: 0, marginTop: 6, background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 10, padding: 12, boxShadow: "0 12px 40px #0009", width: 244 }}>
                  <div className="mut" style={{ fontSize: 11.5, marginBottom: 8, lineHeight: 1.4 }}>Only include drafts on or after this date. Leave on <b style={{ color: "var(--ink)" }}>Auto</b> to keep everything and let the model weight the most recent drafts more.</div>
                  <input type="date" className="gs" style={{ width: "100%", marginBottom: 8, colorScheme: "dark" }} value={cutoff} onChange={(e) => setCutoff(e.target.value)} />
                  <div style={{ display: "flex", gap: 6 }}>
                    <button className="btn btn-mini" style={{ flex: 1 }} onClick={() => { setCutoff(""); setShowCal(false); }}>Auto</button>
                    <button className="btn btn-mini btn-gold" style={{ flex: 1 }} onClick={() => setShowCal(false)}>Apply</button>
                  </div>
                  <div style={{ display: "flex", gap: 5, marginTop: 8, flexWrap: "wrap" }}>
                    {[["7d", 7], ["30d", 30], ["90d", 90]].map(([lbl, days]) => (
                      <button key={lbl} className="btn btn-mini" style={{ fontSize: 10.5, padding: "3px 8px" }} onClick={() => { const d = new Date(Date.now() - days * 86400000); setCutoff(d.toISOString().slice(0, 10)); setShowCal(false); }}>Last {lbl}</button>
                    ))}
                  </div>
                </div>
              )}
            </div>
            {cutoff && <button className="btn btn-mini" onClick={() => setCutoff("")} title="Back to auto"><i className="ti ti-x" style={{ fontSize: 12 }} aria-hidden="true" /></button>}
            <span className="mut" style={{ fontSize: 11, opacity: 0.8 }}>{cutoff ? "older drafts excluded" : "newest drafts count most"}</span>
          </div>
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 7, alignItems: "center" }}>
            <span className="mut" style={{ fontSize: 11, width: 42 }}>Type</span>
            {chip("redraft", typeF, setTypeF, "Redraft")}{chip("dynasty", typeF, setTypeF, "Dynasty")}{chip("bestball", typeF, setTypeF, "Best ball")}{chip("rookie", typeF, setTypeF, "Rookie")}
          </div>
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 7, alignItems: "center" }}>
            <span className="mut" style={{ fontSize: 11, width: 42 }}>QB</span>
            {chip("1qb", qbF, setQbF, "1QB")}{chip("sf", qbF, setQbF, "SF / 2QB")}
          </div>
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 7, alignItems: "center" }}>
            <span className="mut" style={{ fontSize: 11, width: 42 }}>TE</span>
            {chip("std", teF, setTeF, "Standard")}{chip("tep", teF, setTeF, "TE premium")}
          </div>
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 7, alignItems: "center" }}>
            <span className="mut" style={{ fontSize: 11, width: 42 }}>Teams</span>
            {chip("all", teamsF, setTeamsF, "All")}{teamOpts.map((t) => <span key={t}>{chip(t, teamsF, setTeamsF, `${t}-team`)}</span>)}
          </div>
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center" }}>
            <span className="mut" style={{ fontSize: 11, width: 42 }}>Source</span>
            {chip("all", kindF, setKindF, "All")}{chip("official", kindF, setKindF, "Official drafts")}{chip("mock", kindF, setKindF, "Mocks")}
            {pulled.length > 0 && chip("sleeper", kindF, setKindF, "Sleeper pulls")}
          </div>

          {/* Quick-jump: shows the exact formats present in your drafts so you never have to guess which
              filter combo will surface them. Click one to snap all filters to that format. */}
          {allDrafts.length > 0 && (() => {
            const fmts = {};
            allDrafts.forEach((d) => {
              const c = d.cfg || {};
              const t = (c.type || "redraft");
              const key = JSON.stringify({ t, qb: qbOf(c), te: c.tePremMult > 0 ? "tep" : "std", teams: String(c.teams || 12) });
              fmts[key] = (fmts[key] || 0) + 1;
            });
            const entries = Object.entries(fmts).map(([k, n]) => ({ ...JSON.parse(k), n }));
            if (!entries.length) return null;
            const label = (e) => `${e.t === "rookie" ? "Rookie" : e.t === "dynasty" ? "Dynasty" : e.t === "bestball" ? "Best ball" : "Redraft"} · ${e.qb === "sf" ? "SF" : "1QB"}${e.te === "tep" ? " · TE+" : ""} · ${e.teams}T`;
            const activeKey = JSON.stringify({ t: typeF, qb: qbF, te: teF, teams: teamsF });
            return (
              <div style={{ marginTop: 9, paddingTop: 9, borderTop: "1px solid var(--line)" }}>
                <div className="mut" style={{ fontSize: 10.5, marginBottom: 5 }}>Your drafts by format — tap to jump straight to one:</div>
                <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                  {entries.sort((a, b) => b.n - a.n).map((e, i) => {
                    const isActive = JSON.stringify({ t: e.t, qb: e.qb, te: e.te, teams: e.teams }) === activeKey;
                    return (
                      <button key={i} className="btn btn-mini" style={{ fontSize: 10.5, padding: "3px 9px", borderColor: isActive ? "var(--gold)" : "var(--line2)", color: isActive ? "var(--gold)" : "var(--ink)", fontWeight: isActive ? 700 : 400 }}
                        onClick={() => { setTypeF(e.t); setQbF(e.qb); setTeF(e.te); setTeamsF(e.teams); }}>
                        {label(e)} <span style={{ opacity: 0.6 }}>({e.n})</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })()}

          {/* Pull real Sleeper drafts — only shown when a Sleeper account is linked (otherwise not possible). */}
          {canPullSleeper && (
            <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <button className="btn btn-mini" style={{ borderColor: "var(--blue)", color: "var(--blue)" }} disabled={pullState === "loading"} onClick={pullSleeper}>
                  <i className={`ti ${pullState === "loading" ? "ti-loader-2" : "ti-plug-connected"}`} style={{ fontSize: 13, marginRight: 5 }} aria-hidden="true" />
                  {pullState === "loading" ? "Pulling…" : pulled.length ? "Refresh my Sleeper drafts" : "Pull in my Sleeper drafts"}
                </button>
                {pulled.length > 0 && <button className="btn btn-mini" onClick={() => { setPulled([]); if (kindF === "sleeper") setKindF("all"); setPullMsg(""); setPullState("idle"); }}>Remove</button>}
                {pullMsg && <span className="mut" style={{ fontSize: 11.5, color: pullState === "error" ? "var(--red)" : "var(--mut)" }}>{pullMsg}</span>}
              </div>
              <div className="mut" style={{ fontSize: 10.5, marginTop: 6, lineHeight: 1.4 }}>Pulls the completed drafts from <b style={{ color: "var(--ink)" }}>your own</b> Sleeper leagues. The broad, cross-user ADP you see on the board already blends thousands of harvested Sleeper drafts (recency-weighted) — this just adds your personal drafts to the trend view.</div>
            </div>
          )}
        </div>

        {/* ===== How the field drafts — aggregated pool of harvested real Sleeper drafts. Renders ALWAYS,
             independent of whether the user has their own drafts (trends.n) — it's the league-wide view. ===== */}
        <div className="panel" style={{ padding: 16, border: "1px solid rgba(224,166,60,.4)", marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 6, marginBottom: 3 }}>
            <div className="disp" style={{ fontSize: 15, fontWeight: 700 }}>How the field drafts <span className="mut" style={{ fontSize: 11 }}>aggregated real drafts</span></div>
            {pool.state === "done" && pool.draftCount > 0 && (
              <span className="chip" style={{ fontSize: 10, color: "var(--gold)", borderColor: "rgba(224,166,60,.4)" }}>{pool.draftCount.toLocaleString()} drafts{pool.fallback ? " · nearest format" : ""}</span>
            )}
          </div>
          <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>Draft position across thousands of harvested Sleeper drafts in this format — average pick, the typical range (middle 50%), and how often each player is drafted. This is the whole field, independent of your own drafts.</div>
          {pool.state === "loading" && <div className="mut" style={{ fontSize: 12.5, textAlign: "center", padding: "16px 0" }}>Loading the aggregated draft pool…</div>}
          {pool.state === "off" && <div className="mut" style={{ fontSize: 12.5, textAlign: "center", padding: "16px 0" }}>Sign in with the live app to load the aggregated pool.</div>}
          {pool.state === "error" && <div className="mut" style={{ fontSize: 12.5, textAlign: "center", padding: "16px 0" }}>Couldn't reach the trends pool right now — try again in a moment.</div>}
          {pool.state === "done" && pool.players.length === 0 && (
            <div className="mut" style={{ fontSize: 12.5, textAlign: "center", padding: "16px 0" }}>{pool.note || "No harvested drafts for this format yet — the pool is still being built."}</div>
          )}
          {pool.state === "done" && poolRows.length > 0 && (
            <>
              {pool.thin && <div className="mut" style={{ fontSize: 11, marginBottom: 8, color: "var(--gold)" }}>Thin sample for the exact format — showing the nearest format with enough drafts.</div>}
              <div style={{ overflowX: "auto" }}>
                <table style={{ borderCollapse: "collapse", fontSize: 12, minWidth: "100%" }}>
                  <thead>
                    <tr className="mut" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: ".04em" }}>
                      <th style={{ textAlign: "left", padding: "0 8px 6px 0" }}>Player</th>
                      <th className="num" style={{ textAlign: "right", padding: "0 8px 6px" }}>Avg</th>
                      <th className="num" style={{ textAlign: "right", padding: "0 8px 6px" }}>Median</th>
                      <th className="num" style={{ textAlign: "right", padding: "0 8px 6px" }}>Range</th>
                      <th className="num" style={{ textAlign: "right", padding: "0 8px 6px" }} title="Middle 50% of drafts — the typical window he goes in">Typical</th>
                      <th className="num" style={{ textAlign: "right", padding: "0 8px 6px" }} title="Share of drafts he was taken in">Drafted</th>
                      <th className="num" style={{ textAlign: "right", padding: "0 0 6px" }} title="Number of drafts he appears in">N</th>
                    </tr>
                  </thead>
                  <tbody>
                    {poolRows.slice(0, q.trim() ? 200 : 120).map((r) => (
                      <tr key={r.id} style={{ borderTop: "1px solid var(--line)" }}>
                        <td style={{ padding: "5px 8px 5px 0", whiteSpace: "nowrap" }}><span className="posdot" style={{ background: POS_COLOR[r.position] }} /><b>{r.name}</b> <span className="mut" style={{ fontSize: 10 }}>{r.position}{r.team ? ` · ${r.team}` : ""}</span></td>
                        <td className="num" style={{ textAlign: "right", padding: "5px 8px", fontWeight: 700 }}>{r.avg}</td>
                        <td className="num" style={{ textAlign: "right", padding: "5px 8px" }}>{r.median}</td>
                        <td className="num mut" style={{ textAlign: "right", padding: "5px 8px", fontSize: 11 }}>{r.min}–{r.max}</td>
                        <td className="num" style={{ textAlign: "right", padding: "5px 8px", fontSize: 11 }}>{r.p25}–{r.p75}</td>
                        <td className="num" style={{ textAlign: "right", padding: "5px 8px", color: r.draftedRate >= 90 ? "#5FD0A8" : r.draftedRate >= 50 ? "var(--ink)" : "var(--mut)" }}>{r.draftedRate != null ? `${r.draftedRate}%` : "—"}</td>
                        <td className="num mut" style={{ textAlign: "right", padding: "5px 0", fontSize: 11 }}>{r.n}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!q.trim() && poolRows.length > 120 && <div className="mut" style={{ fontSize: 11, textAlign: "center", paddingTop: 8 }}>Showing top 120 by average pick — search a name to find anyone.</div>}
              </div>
            </>
          )}
        </div>

        {trends.n === 0 ? (
          <div className="panel" style={{ padding: 24, textAlign: "center" }}>
            <i className="ti ti-chart-dots" style={{ fontSize: 34, color: "var(--mut)", marginBottom: 10 }} aria-hidden="true" />
            <div className="disp" style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>{allDrafts.length ? "None of your own drafts match these filters" : "No drafts of your own to analyze yet"}</div>
            <div className="mut" style={{ fontSize: 13, maxWidth: 460, margin: "0 auto 12px" }}>{allDrafts.length ? "The field-wide pool above still shows how everyone drafts this format. This lower section adds YOUR drafts once you have some in this format." : "The field-wide pool above shows how everyone drafts this format. Run some mocks or complete a draft and your personal realized ADP will appear here too."}</div>
            {allDrafts.length > 0 && <button className="btn btn-mini" onClick={() => { setQ(""); setTypeF("all"); setQbF("all"); setTeF("all"); setTeamsF("all"); setKindF("all"); }}>Clear filters</button>}
          </div>
        ) : (
          <>
            {/* summary line */}
            <div className="panel" style={{ padding: 16, marginBottom: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                <span className="chip" style={{ color: "var(--gold)" }}><i className="ti ti-stack-2" style={{ fontSize: 11, marginRight: 3 }} aria-hidden="true" />{trends.n} draft{trends.n === 1 ? "" : "s"}</span>
                {!trends.enough && <span className="chip" style={{ borderColor: "var(--gold)", color: "var(--gold)" }}>small sample — run more for sharper trends</span>}
                {matched.length > 0 && <button className="btn btn-mini" style={{ fontSize: 10.5, padding: "3px 9px" }} onClick={() => setShowDraftList(true)}><i className="ti ti-list-search" style={{ fontSize: 12, marginRight: 3 }} aria-hidden="true" />Click to see drafts</button>}
              </div>
              <div style={{ fontSize: 13, lineHeight: 1.55 }}>
                Across these {trends.n} draft{trends.n === 1 ? "" : "s"}, {trends.firstQBRound != null ? `the first QB typically comes off the board around round ${trends.firstQBRound.toFixed(1)}` : "QBs vary in timing"}{trends.firstTERound != null ? `, and the first TE around round ${trends.firstTERound.toFixed(1)}` : ""}. The tables below show your <b style={{ color: "var(--ink)" }}>realized ADP</b> (where players actually go) and how each round's position mix breaks down.
              </div>
            </div>

            {/* positional flow */}
            {trends.flow.length > 0 && (
              <div className="panel" style={{ padding: 16, marginBottom: 14 }}>
                <div className="disp" style={{ fontSize: 15, fontWeight: 700, marginBottom: 3 }}>Positional flow by round</div>
                <div className="mut" style={{ fontSize: 12, marginBottom: 12 }}>Share of each position drafted in each round — where runs happen and when positions dry up.</div>
                <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
                  {POS.map((pos) => <span key={pos} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: POS_COLOR[pos] }} />{pos}</span>)}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {trends.flow.map((row) => <PosFlowBar key={row.round} row={row} />)}
                </div>
              </div>
            )}

            {/* risers & fallers */}
            {(trends.risers.length > 0 || trends.fallers.length > 0) && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 14, marginBottom: 14 }}>
                {trends.risers.length > 0 && (
                  <div className="panel" style={{ padding: 16 }}>
                    <div className="disp" style={{ fontSize: 15, fontWeight: 700, marginBottom: 3 }}>Going earlier than ADP <span className="mut" style={{ fontSize: 11 }}>▲ reaches</span></div>
                    <div className="mut" style={{ fontSize: 11.5, marginBottom: 10 }}>Players your drafts consistently take ahead of their baseline market ADP.</div>
                    {trends.risers.map((r) => (
                      <div key={r.pid} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderTop: "1px solid var(--line)" }}>
                        <Dot pos={r.pos} />
                        <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 600, fontSize: 13 }}>{r.name} <span className="mut" style={{ fontSize: 11 }}>{r.pos} · {r.team}</span></div><div className="mut" style={{ fontSize: 11 }}>goes ~{r.avgPick.toFixed(0)} · ADP {r.baseline != null ? r.baseline.toFixed(0) : "—"} · in {r.times}/{trends.n}</div></div>
                        <span className="num" style={{ fontWeight: 700, color: "var(--green)", fontSize: 13 }}>▲{r.delta.toFixed(0)}</span>
                      </div>
                    ))}
                  </div>
                )}
                {trends.fallers.length > 0 && (
                  <div className="panel" style={{ padding: 16 }}>
                    <div className="disp" style={{ fontSize: 15, fontWeight: 700, marginBottom: 3 }}>Sliding past ADP <span className="mut" style={{ fontSize: 11 }}>▼ values</span></div>
                    <div className="mut" style={{ fontSize: 11.5, marginBottom: 10 }}>Players that consistently last longer than their baseline ADP — recurring value.</div>
                    {trends.fallers.map((r) => (
                      <div key={r.pid} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderTop: "1px solid var(--line)" }}>
                        <Dot pos={r.pos} />
                        <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 600, fontSize: 13 }}>{r.name} <span className="mut" style={{ fontSize: 11 }}>{r.pos} · {r.team}</span></div><div className="mut" style={{ fontSize: 11 }}>goes ~{r.avgPick.toFixed(0)} · ADP {r.baseline != null ? r.baseline.toFixed(0) : "—"} · in {r.times}/{trends.n}</div></div>
                        <span className="num" style={{ fontWeight: 700, color: "var(--red)", fontSize: 13 }}>▼{Math.abs(r.delta).toFixed(0)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* realized ADP table */}
            <div className="panel" style={{ padding: 16 }}>
              <div className="disp" style={{ fontSize: 15, fontWeight: 700, marginBottom: 3 }}>Realized ADP <span className="mut" style={{ fontSize: 11 }}>{realizedRows.length} players{q.trim() ? " · filtered" : ""} · your drafts</span></div>
              <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>Where each player actually gets drafted across this set, vs. their baseline market ADP.</div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                  <thead><tr className="mut" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em" }}>
                    <th style={{ textAlign: "left", padding: "0 6px 6px 0" }}>Player</th>
                    <th className="num" style={{ textAlign: "right", padding: "0 8px 6px" }}>Realized</th>
                    <th className="num" style={{ textAlign: "right", padding: "0 8px 6px" }}>ADP</th>
                    <th className="num" style={{ textAlign: "right", padding: "0 8px 6px" }}>Δ</th>
                    <th className="num" style={{ textAlign: "right", padding: "0 0 6px 8px" }}>Seen</th>
                  </tr></thead>
                  <tbody>
                    {realizedRows.slice(0, 60).map((r) => (
                      <tr key={r.pid} style={{ borderTop: "1px solid var(--line)" }}>
                        <td style={{ padding: "5px 6px 5px 0" }}><span className="posdot" style={{ background: POS_COLOR[r.pos] }} /><b>{r.name}</b> <span className="mut" style={{ fontSize: 10.5 }}>{r.pos} · {r.team}</span></td>
                        <td className="num" style={{ textAlign: "right", padding: "5px 8px" }}>{r.avgPick.toFixed(1)}</td>
                        <td className="num" style={{ textAlign: "right", padding: "5px 8px", color: "var(--mut)" }}>{r.baseline != null ? r.baseline.toFixed(1) : "—"}</td>
                        <td className="num" style={{ textAlign: "right", padding: "5px 8px", color: r.delta == null ? "var(--mut)" : r.delta > 2 ? "var(--green)" : r.delta < -2 ? "var(--red)" : "var(--mut)", fontWeight: 700 }}>{r.delta == null ? "—" : r.delta > 0 ? `▲${r.delta.toFixed(0)}` : r.delta < 0 ? `▼${Math.abs(r.delta).toFixed(0)}` : "—"}</td>
                        <td className="num" style={{ textAlign: "right", padding: "5px 0 5px 8px", color: "var(--mut)" }}>{r.times}/{trends.n}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {realizedRows.length === 0 && <div className="mut" style={{ fontSize: 12.5, textAlign: "center", padding: "12px 0" }}>No players match “{q.trim()}”.</div>}
              </div>
            </div>

            {/* Draft-by-draft matrix: one COLUMN per draft, one ROW per player — the exact overall pick a
                player went in each draft. Search a name (e.g. "Jaylen Waddle") to see 47 / 55 / 52 at a glance. */}
            <div className="panel" style={{ padding: 16 }}>
              <div className="disp" style={{ fontSize: 15, fontWeight: 700, marginBottom: 3 }}>Pick-by-pick, draft by draft</div>
              <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>Each column is one draft; each cell is the overall pick that player went. Use the search box above to focus on a player.{q.trim() ? "" : " Showing the most-drafted players — search to find anyone."}</div>
              {(() => {
                const dcols = matched.slice().sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 12); // cap columns for width
                // rows: player -> per-draft overall pick (index in that draft's picks + 1)
                const qq = q.trim().toLowerCase();
                const rowMap = new Map(); // pid -> {player, picks:{draftIdx->overall}, count}
                dcols.forEach((d, di) => {
                  d.picks.forEach((pid, o) => {
                    if (pid == null) return;
                    if (!rowMap.has(pid)) rowMap.set(pid, { pid, picks: {}, count: 0 });
                    const r = rowMap.get(pid); r.picks[di] = o + 1; r.count++;
                  });
                });
                let rows = Array.from(rowMap.values()).map((r) => {
                  const pl = players.find((p) => p.id === r.pid);
                  const nums = Object.values(r.picks);
                  const avg = nums.reduce((s, x) => s + x, 0) / nums.length;
                  return { ...r, player: pl, avg };
                }).filter((r) => r.player);
                if (qq) rows = rows.filter((r) => r.player.name.toLowerCase().includes(qq));
                rows.sort((a, b) => a.avg - b.avg);
                const shown = qq ? rows : rows.filter((r) => r.count >= Math.min(2, dcols.length)).slice(0, 40);
                if (dcols.length === 0) return <div className="mut" style={{ fontSize: 12.5, textAlign: "center", padding: "10px 0" }}>No drafts in this format yet.</div>;
                if (shown.length === 0) return <div className="mut" style={{ fontSize: 12.5, textAlign: "center", padding: "10px 0" }}>{qq ? `No player named “${q.trim()}” appears in these drafts.` : "Not enough overlap across drafts yet."}</div>;
                return (
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ borderCollapse: "collapse", fontSize: 12, minWidth: "100%" }}>
                      <thead>
                        <tr className="mut" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: ".04em" }}>
                          <th style={{ textAlign: "left", padding: "0 8px 6px 0", position: "sticky", left: 0, background: "var(--panel)", zIndex: 1 }}>Player</th>
                          <th className="num" style={{ textAlign: "right", padding: "0 8px 6px" }}>Avg</th>
                          {dcols.map((d, di) => (
                            <th key={di} className="num" style={{ textAlign: "center", padding: "0 6px 6px", whiteSpace: "nowrap" }} title={`${d.name}${d.at ? " · " + new Date(d.at).toLocaleDateString() : ""}`}>
                              <i className={`ti ${d.kind === "official" ? "ti-clipboard-check" : d.kind === "sleeper" ? "ti-plug-connected" : "ti-dice-5"}`} style={{ fontSize: 12, color: d.kind === "official" ? "var(--gold)" : d.kind === "sleeper" ? "var(--blue)" : "#4FD1A1" }} aria-hidden="true" /><br />#{di + 1}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {shown.map((r) => (
                          <tr key={r.pid} style={{ borderTop: "1px solid var(--line)" }}>
                            <td style={{ padding: "5px 8px 5px 0", whiteSpace: "nowrap", position: "sticky", left: 0, background: "var(--panel)", zIndex: 1 }}><span className="posdot" style={{ background: POS_COLOR[r.player.pos] }} /><b>{r.player.name}</b> <span className="mut" style={{ fontSize: 10 }}>{r.player.pos}</span></td>
                            <td className="num" style={{ textAlign: "right", padding: "5px 8px", fontWeight: 700 }}>{r.avg.toFixed(0)}</td>
                            {dcols.map((d, di) => (
                              <td key={di} className="num" style={{ textAlign: "center", padding: "5px 6px", color: r.picks[di] != null ? "var(--ink)" : "var(--line2)" }}>{r.picks[di] != null ? r.picks[di] : "·"}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {!qq && rows.length > shown.length && <div className="mut" style={{ fontSize: 11, textAlign: "center", paddingTop: 8 }}>Showing top {shown.length} by average pick — search a name to find anyone.</div>}
                  </div>
                );
              })()}
            </div>
          </>
        )}
      </div>

      {/* "See the drafts behind this trend" — lists each matched draft with source, date, format. */}
      {showDraftList && (
        <div className="modalbg" onClick={() => { setShowDraftList(false); setViewDraft(null); }} style={{ position: "fixed", inset: 0, zIndex: 80, background: "#000a", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div className="panel" style={{ maxWidth: 560, width: "100%", maxHeight: "84vh", overflowY: "auto", padding: 18 }} onClick={(e) => e.stopPropagation()}>
            {viewDraft ? (() => {
              const d = viewDraft; const c = d.cfg || {};
              const teams = c.teams || 12;
              const fmtL = `${c.type === "dynasty" ? "Dynasty" : c.type === "rookie" ? "Rookie" : c.type === "bestball" ? "Best ball" : "Redraft"} · ${((c.start && c.start.SUPER > 0) || c.sf) ? "SF" : "1QB"}${c.tePremMult > 0 ? " · TE+" : ""} · ${teams}-team`;
              const srcL = d.kind === "official" ? "Official league draft" : d.kind === "sleeper" ? "Pulled from Sleeper" : "Mock draft";
              return (
                <>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    <button className="btn btn-mini" onClick={() => setViewDraft(null)}><i className="ti ti-arrow-left" style={{ fontSize: 13, marginRight: 3 }} aria-hidden="true" />Back</button>
                    <div className="disp" style={{ fontSize: 16, fontWeight: 700, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.name}</div>
                    <button className="btn btn-mini" onClick={() => { setShowDraftList(false); setViewDraft(null); }}><i className="ti ti-x" style={{ fontSize: 13 }} aria-hidden="true" /></button>
                  </div>
                  <div className="mut" style={{ fontSize: 11.5, marginBottom: 10, display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <span className="chip">{srcL}</span><span className="chip">{fmtL}</span>{d.at ? <span className="chip">{new Date(d.at).toLocaleDateString()}</span> : <span className="chip" style={{ opacity: 0.6 }}>no date</span>}<span className="chip">{d.picks.filter((x) => x != null).length} picks</span>
                  </div>
                  {/* search a player within THIS draft — jumps to & highlights where he went */}
                  <div style={{ position: "relative", marginBottom: 10 }}>
                    <i className="ti ti-search" style={{ position: "absolute", left: 11, top: 9, fontSize: 14, color: "var(--mut)" }} aria-hidden="true" />
                    <input className="gs" style={{ width: "100%", paddingLeft: 33, paddingTop: 7, paddingBottom: 7, fontSize: 13 }} placeholder="Find a player in this draft…" value={draftListQ} onChange={(e) => setDraftListQ(e.target.value)} />
                    {draftListQ && <button onClick={() => setDraftListQ("")} style={{ position: "absolute", right: 8, top: 6, background: "transparent", border: "none", color: "var(--mut)", cursor: "pointer" }}><i className="ti ti-x" style={{ fontSize: 14 }} aria-hidden="true" /></button>}
                  </div>
                  {(() => {
                    const q = draftListQ.trim().toLowerCase();
                    // when searching, surface the matching pick(s) up top as a quick answer
                    if (q) {
                      const hits = d.picks.map((pid, o) => ({ pid, o })).filter((x) => { const pl = x.pid != null ? players.find((y) => y.id === x.pid) : null; return pl && pl.name.toLowerCase().includes(q); });
                      if (hits.length === 0) return <div className="mut" style={{ fontSize: 12, textAlign: "center", padding: "8px 0", marginBottom: 6 }}>No player matching “{draftListQ.trim()}” in this draft.</div>;
                      return (
                        <div style={{ marginBottom: 10, padding: "8px 10px", background: "rgba(224,166,60,.10)", border: "1px solid var(--gold)", borderRadius: 8 }}>
                          {hits.map(({ pid, o }) => { const pl = players.find((y) => y.id === pid); const rd = Math.floor(o / teams) + 1, inRd = (o % teams) + 1; return (
                            <div key={o} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}><Dot pos={pl.pos} /><b>{pl.name}</b><span className="mut">went</span><b style={{ color: "var(--gold)" }}>{rd}.{String(inRd).padStart(2, "0")}</b><span className="mut">(pick #{o + 1})</span></div>
                          ); })}
                        </div>
                      );
                    }
                    return null;
                  })()}
                  <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    {d.picks.map((pid, o) => {
                      const p = pid != null ? players.find((x) => x.id === pid) : null;
                      const rd = Math.floor(o / teams) + 1, inRd = (o % teams) + 1;
                      const q = draftListQ.trim().toLowerCase();
                      const isMatch = q && p && p.name.toLowerCase().includes(q);
                      return (
                        <div key={o} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, padding: "3px 6px", borderRadius: 6, background: isMatch ? "rgba(224,166,60,.18)" : (o % (teams * 2) < teams ? "transparent" : "var(--panel2)"), outline: isMatch ? "1px solid var(--gold)" : "none", opacity: q && !isMatch ? 0.5 : 1 }}>
                          <span className="mut num" style={{ width: 42, flexShrink: 0, fontSize: 10.5 }}>{rd}.{String(inRd).padStart(2, "0")}</span>
                          <span className="mut num" style={{ width: 26, flexShrink: 0, fontSize: 10 }}>#{o + 1}</span>
                          {p ? <><Dot pos={p.pos} /><span style={{ fontWeight: 600 }}>{p.name}</span><span className="mut" style={{ fontSize: 10.5 }}>{p.pos}</span></> : <span className="mut" style={{ fontStyle: "italic" }}>— (unmapped)</span>}
                        </div>
                      );
                    })}
                  </div>
                </>
              );
            })() : (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <i className="ti ti-stack-2" style={{ fontSize: 18, color: "var(--gold)" }} aria-hidden="true" />
                  <div className="disp" style={{ fontSize: 17, fontWeight: 700, flex: 1 }}>The {matched.length} draft{matched.length === 1 ? "" : "s"} behind this trend</div>
                  <button className="btn btn-mini" onClick={() => setShowDraftList(false)}><i className="ti ti-x" style={{ fontSize: 13 }} aria-hidden="true" /></button>
                </div>
                <div className="mut" style={{ fontSize: 11.5, marginBottom: 10 }}>Tap any draft to see its full board — and search for a specific player once you're inside.</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                  {matched.slice().sort((a, b) => (b.at || 0) - (a.at || 0)).map((d) => {
                    const c = d.cfg || {};
                    const fmtL = `${c.type === "dynasty" ? "Dynasty" : c.type === "rookie" ? "Rookie" : c.type === "bestball" ? "Best ball" : "Redraft"} · ${((c.start && c.start.SUPER > 0) || c.sf) ? "SF" : "1QB"}${c.tePremMult > 0 ? " · TE+" : ""} · ${c.teams || 12}T`;
                    const srcIcon = d.kind === "official" ? "ti-clipboard-check" : d.kind === "sleeper" ? "ti-plug-connected" : "ti-dice-5";
                    const srcColor = d.kind === "official" ? "var(--gold)" : d.kind === "sleeper" ? "var(--blue)" : "#4FD1A1";
                    return (
                      <button key={d.id} onClick={() => { setDraftListQ(""); setViewDraft(d); }} style={{ textAlign: "left", cursor: "pointer", fontFamily: "inherit", color: "var(--ink)", border: "1px solid var(--line)", background: "var(--panel2)", borderRadius: 10, padding: "10px 12px", display: "flex", alignItems: "center", gap: 11 }}>
                        <div style={{ width: 32, height: 32, borderRadius: 8, background: srcColor + "1e", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><i className={`ti ${srcIcon}`} style={{ fontSize: 15, color: srcColor }} aria-hidden="true" /></div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 700, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.name}</div>
                          <div className="mut" style={{ fontSize: 10.5 }}>{d.kind === "official" ? "Official" : d.kind === "sleeper" ? "Sleeper" : "Mock"} · {fmtL}{d.at ? ` · ${new Date(d.at).toLocaleDateString()}` : ""}</div>
                        </div>
                        <i className="ti ti-chevron-right" style={{ fontSize: 15, color: "var(--mut)", flexShrink: 0 }} aria-hidden="true" />
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default DraftTrendsPage;
