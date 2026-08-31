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
import { TEAMS, normName, POS, TEAM_NAMES, POS_COLOR, teamAt, buildPlayers, REQ_F, isDynastyCfg, makeOutlook, Compass, Dot, formatKey, rankSetLabel, tradeValue, pickAssets, assetVal, evaluateTrade } from "../App.jsx";

function TradeCenter({ players, picks, userIdx, cfg, sortedAdp, draftedSet, showTip, hideTip, isMock, onExecuteTrade, tradingOn, proj }) {
  const [mode, setMode] = useState("values"); // values | evaluate
  // Evaluate-mode format toggle: lets you see the trade under redraft vs dynasty valuation without
  // changing your league. Defaults to the league's real type. evalCfg feeds the asset value + evaluate
  // math below so switching it actually moves the numbers (the old evaluate side was hardwired to cfg
  // and never responded to a format change).
  const [evalType, setEvalType] = useState(isDynastyCfg(cfg) ? "dynasty" : "redraft");
  const evalCfg = useMemo(() => ({ ...cfg, type: evalType }), [cfg, evalType]);
  // Rebuild the pool once for the chosen evaluate format so dynasty age-weighting actually applies to
  // p.vbd (tradeValue reads baked vbd). Keyed by name so we can re-value the current rosters/picks.
  const evalValById = useMemo(() => {
    let pool; try { pool = buildPlayers(evalCfg); } catch { pool = players; }
    const byName = {}; pool.forEach((p) => { byName[normName(p.name)] = p; });
    return byName;
  }, [players, evalCfg]);
  // assetVal that respects the evaluate format: for a real player, value his rebuilt (format-correct)
  // self; picks fall back to their static asset value.
  const assetValE = (a) => {
    if (a && a.pickAsset) return assetVal(a, evalCfg);
    const rp = a && a.name ? evalValById[normName(a.name)] : null;
    return rp ? Math.round(tradeValue(rp, evalCfg)) : assetVal(a, evalCfg);
  };
  const myRoster = picks.map((pk, o) => ({ p: players[pk], o })).filter((x) => x.p && teamAt(x.o) === userIdx).map((x) => x.p);
  const teamRosters = useMemo(() => {
    const r = Array.from({ length: TEAMS }, () => []);
    picks.forEach((pk, o) => { const pl = players[pk]; if (pl) r[teamAt(o)].push(pl); });
    return r;
  }, [picks, players]);
  const [partner, setPartner] = useState(userIdx === 0 ? 1 : 0);
  const leagueSize = cfg.teams || TEAMS;
  // Each team's projected finish drives the value of its FUTURE picks — a team headed for last place owns an
  // early, premium next-year pick; a contender owns a late one. Pull it from the live projection when we have it.
  const myFinish = (proj && proj.rank && proj.rank[userIdx] != null) ? proj.rank[userIdx] : null;
  const partnerFinish = (proj && proj.rank && proj.rank[partner] != null) ? proj.rank[partner] : null;
  const myPicks = useMemo(() => pickAssets(cfg, myFinish, leagueSize), [cfg, myFinish, leagueSize]);
  const partnerPicks = useMemo(() => pickAssets(cfg, partnerFinish, leagueSize), [cfg, partnerFinish, leagueSize]);
  const [give, setGive] = useState([]);
  const [get, setGet] = useState([]);
  const [tradeResult, setTradeResult] = useState(null); // {ok, msg} after a mock proposal
  const toggle = (arr, set, id) => set(arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id]);

  // Both sides are sorted by trade value, highest → lowest, so the most valuable assets are always on top.
  const myAssets = [...myRoster, ...myPicks].sort((a, b) => assetValE(b) - assetValE(a));
  const partnerAssets = [...teamRosters[partner], ...partnerPicks.map((p) => ({ ...p, id: `their-${p.id}` }))].sort((a, b) => assetValE(b) - assetValE(a));
  const giveAssets = give.map((id) => myAssets.find((a) => String(a.id) === String(id))).filter(Boolean);
  const getAssets = get.map((id) => partnerAssets.find((a) => String(a.id) === String(id))).filter(Boolean);
  const ev = evaluateTrade(giveAssets, getAssets, evalCfg);
  const partnerNet = ev.giveAdj - ev.getAdj; // they win if your give is worth more to them
  const accept = Math.max(2, Math.min(98, Math.round(50 + partnerNet * 1.3)));

  const chartPlayers = useMemo(() => players.filter((p) => POS.includes(p.pos)).slice().sort((a, b) => tradeValue(b, cfg) - tradeValue(a, cfg)), [players, cfg]);
  const maxV = chartPlayers.length ? tradeValue(chartPlayers[0], cfg) : 1;
  const [chartSearch, setChartSearch] = useState("");
  const [chartExpanded, setChartExpanded] = useState(false);

  // ---- PLAYER VALUES DATABASE: a browsable, format-aware values table (KTC-style) you can re-slice by
  // league settings WITHOUT changing your actual league. We synthesize a cfg from the controls below and
  // recompute tradeValue for every player — so you can see how a player's worth shifts in SF vs 1QB,
  // TE-premium, PPR level, team count, and dynasty vs redraft. All values are computed by OUR engine.
  const [vbScoring, setVbScoring] = useState(cfg.scoring && cfg.scoring.rec != null ? (cfg.scoring.rec >= 0.75 ? "ppr" : cfg.scoring.rec >= 0.25 ? "half" : "std") : "ppr");
  const [vbQb, setVbQb] = useState(((cfg.start && cfg.start.SUPER > 0) || cfg.sf) ? "sf" : "1qb");
  const [vbTep, setVbTep] = useState(cfg.tePremMult > 0 ? "tep" : "std");
  const [vbType, setVbType] = useState(isDynastyCfg(cfg) ? "dynasty" : "redraft");
  const [vbTeams, setVbTeams] = useState(cfg.teams || 12);
  const [vbPos, setVbPos] = useState("ALL");
  const [vbSearch, setVbSearch] = useState("");
  // Build a synthetic cfg from the controls. tradeValue reads start.SUPER, sf, tePremMult, type, scoring.
  const valuesCfg = useMemo(() => ({
    ...cfg,
    type: vbType,
    teams: vbTeams,
    sf: vbQb === "sf",
    start: { ...(cfg.start || {}), SUPER: vbQb === "sf" ? 1 : 0, QB: vbQb === "sf" ? 1 : (cfg.start?.QB || 1) },
    tePremMult: vbTep === "tep" ? (cfg.tePremMult > 0 ? cfg.tePremMult : 0.5) : 0,
    scoring: { ...(cfg.scoring || {}), rec: vbScoring === "ppr" ? 1 : vbScoring === "half" ? 0.5 : 0 },
  }), [cfg, vbType, vbTeams, vbQb, vbTep, vbScoring]);
  // Compute, sort, and rank values for the synthetic format. We REBUILD players from scratch for this
  // format (buildPlayers recomputes projected points for the scoring AND the dynasty age-adjusted VBD) —
  // otherwise switching dynasty/redraft or PPR wouldn't change anything, since tradeValue only re-reads
  // already-baked pts/vbd. Team count scales replacement depth via a light top-end adjustment.
  const valuesRows = useMemo(() => {
    let pool;
    try { pool = buildPlayers(valuesCfg); } catch { pool = players; }
    const teamAdj = 1 + (vbTeams - 12) * 0.012; // ±1.2% per team away from 12
    const list = pool.filter((p) => POS.includes(p.pos)).map((p) => ({ p, v: Math.max(0, Math.round(tradeValue(p, valuesCfg) * teamAdj)) }));
    list.sort((a, b) => b.v - a.v);
    // KTC-style 0-9999 scale: normalize so the top asset ≈ 9999.
    const top = list.length ? list[0].v : 1;
    list.forEach((x, i) => { x.ktc = top > 0 ? Math.round((x.v / top) * 9999) : 0; x.overall = i + 1; });
    // positional rank
    const posCount = {};
    list.forEach((x) => { posCount[x.p.pos] = (posCount[x.p.pos] || 0) + 1; x.posRank = posCount[x.p.pos]; });
    return list;
  }, [players, valuesCfg, vbTeams]);
  const valuesFiltered = useMemo(() => {
    let l = valuesRows;
    if (vbPos !== "ALL") l = l.filter((x) => x.p.pos === vbPos);
    if (vbSearch) { const q = vbSearch.toLowerCase(); l = l.filter((x) => x.p.name.toLowerCase().includes(q)); }
    return l.slice(0, 240);
  }, [valuesRows, vbPos, vbSearch]);

  const req = REQ_F(cfg.sf);
  const superOnly = (cfg.start && cfg.start.SUPER || 0) > 0;
  const myCounts = {}; POS.forEach((p) => (myCounts[p] = myRoster.filter((x) => x.pos === p).length));
  const wants = (pos) => {
    if (pos === "QB" && !superOnly && myCounts.QB >= 1) return false;
    const cap = (req[pos] || 0) + (["RB", "WR"].includes(pos) ? 2 : 1);
    return myCounts[pos] < cap;
  };

  const AssetRow = ({ a, checked, onToggle }) => (
    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, padding: "2px 0", cursor: "pointer", opacity: a.pickAsset ? 0.92 : 1 }}>
      <input type="checkbox" checked={checked} onChange={onToggle} />
      {a.pickAsset ? <i className="ti ti-ticket" style={{ fontSize: 13, color: "var(--gold)" }} aria-hidden="true" /> : <Dot pos={a.pos} />}
      {a.name} <span className="mut num" style={{ marginLeft: "auto" }}>{assetValE(a)}</span>
    </label>
  );

  return (
    <div style={{ padding: 14, maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        {[["values","Player values database"],["evaluate","Evaluate a trade"]].map(([k, l]) => (
          <button key={k} className="btn" style={{ borderColor: mode === k ? "var(--gold)" : "var(--line)" }} onClick={() => setMode(k)}>{l}</button>
        ))}
      </div>

      {mode === "chart" && (
        <div className="panel" style={{ padding: 16 }}>
          <div className="disp" style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Trade value chart</div>
          <div className="panel" style={{ padding: "8px 12px", marginBottom: 10, background: "var(--panel2)", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <i className="ti ti-adjustments" style={{ fontSize: 14, color: "var(--gold)" }} aria-hidden="true" />
            <span className="mut" style={{ fontSize: 11.5 }}>Values are set to this league's format:</span>
            <span style={{ fontSize: 11.5, fontWeight: 600 }}>{rankSetLabel(formatKey(cfg))}{((cfg.start && cfg.start.SUPER > 0) || cfg.sf) ? " · QBs premium" : ""}{(isDynastyCfg(cfg)) ? " · youth-weighted" : ""}</span>
          </div>
          <div className="mut" style={{ fontSize: 12.5, marginBottom: 14 }}>Values are specific to <i>this</i> league's format — Superflex inflates QBs, TE-premium lifts tight ends, dynasty weights youth — so the same player is worth different amounts in different leagues. These are our own values, computed from the same projections that drive your board — not a chart borrowed from somewhere else. Hover for the full outlook.</div>
          <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
            <div style={{ position: "relative", flex: "1 1 220px", maxWidth: 320 }}>
              <i className="ti ti-search" style={{ position: "absolute", left: 9, top: 9, fontSize: 14, color: "var(--mut)" }} aria-hidden="true" />
              <input className="gs" style={{ width: "100%", paddingLeft: 30 }} placeholder="Search any player…" value={chartSearch} onChange={(e) => setChartSearch(e.target.value)} />
            </div>
            {!chartSearch && <button className="btn btn-mini" onClick={() => setChartExpanded((x) => !x)}>{chartExpanded ? "Show top 15 each" : "Show all players"}</button>}
          </div>
          {chartSearch ? (
            <div>
              {(() => {
                const hits = chartPlayers.filter((p) => p.name.toLowerCase().includes(chartSearch.toLowerCase()));
                if (hits.length === 0) return <div className="mut" style={{ fontSize: 13 }}>No players match "{chartSearch}".</div>;
                return hits.slice(0, 50).map((p) => {
                  const v = tradeValue(p, cfg);
                  return (
                    <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, opacity: draftedSet.has(p.id) ? 0.5 : 1 }}
                      onClick={(e) => showTip(e, makeOutlook(p, null, draftedSet.has(p.id)))} onMouseEnter={(e) => showTip(e, makeOutlook(p, null, draftedSet.has(p.id)))} onMouseLeave={hideTip}>
                      <Dot pos={p.pos} /><span style={{ fontSize: 12.5, width: 180, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", cursor: "help" }}>{p.name} <span className="mut">{p.team}</span></span>
                      <div style={{ flex: 1, maxWidth: 360, height: 9, background: "var(--panel2)", borderRadius: 4, overflow: "hidden" }}><div style={{ width: `${(v / maxV) * 100}%`, height: "100%", background: POS_COLOR[p.pos] }} /></div>
                      <span className="num" style={{ fontSize: 12, width: 30, textAlign: "right" }}>{v}</span>
                    </div>
                  );
                });
              })()}
            </div>
          ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(250px,1fr))", gap: 18 }}>
            {POS.map((pos) => {
              const inPos = chartPlayers.filter((p) => p.pos === pos);
              const shown = chartExpanded ? inPos : inPos.slice(0, 15);
              return (
              <div key={pos}>
                <div className="disp" style={{ fontSize: 13, fontWeight: 700, color: POS_COLOR[pos], marginBottom: 6 }}>{pos} <span className="mut" style={{ fontSize: 10.5, fontWeight: 400 }}>({shown.length}{!chartExpanded && inPos.length > shown.length ? ` of ${inPos.length}` : ""})</span></div>
                {shown.map((p) => {
                  const v = tradeValue(p, cfg);
                  return (
                    <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3, opacity: draftedSet.has(p.id) ? 0.5 : 1 }}
                      onClick={(e) => showTip(e, makeOutlook(p, null, draftedSet.has(p.id)))} onMouseEnter={(e) => showTip(e, makeOutlook(p, null, draftedSet.has(p.id)))} onMouseLeave={hideTip}>
                      <span style={{ fontSize: 12, width: 116, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", cursor: "help" }}>{p.name}</span>
                      <div style={{ flex: 1, height: 9, background: "var(--panel2)", borderRadius: 4, overflow: "hidden" }}><div style={{ width: `${(v / maxV) * 100}%`, height: "100%", background: POS_COLOR[pos] }} /></div>
                      <span className="num" style={{ fontSize: 11, width: 26, textAlign: "right" }}>{v}</span>
                    </div>
                  );
                })}
              </div>
              );
            })}
          </div>
          )}
          {cfg.pickTrading && (
            <div style={{ marginTop: 16 }}>
              <div className="disp" style={{ fontSize: 13, fontWeight: 700, color: "var(--gold)", marginBottom: 6 }}>DRAFT PICKS</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {myPicks.map((a) => <span key={a.id} className="chip"><i className="ti ti-ticket" style={{ fontSize: 12, marginRight: 4 }} aria-hidden="true" />{a.name} · <b className="num">{a.value}</b></span>)}
              </div>
            </div>
          )}
        </div>
      )}

      {mode === "evaluate" && (
        <div className="panel" style={{ padding: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
            <div className="disp" style={{ fontSize: 18, fontWeight: 700 }}>Evaluate a trade</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {/* Format toggle so trade values respond to redraft vs dynasty (dynasty youth-weights the
                  values). The old Teams dropdown is gone — the "get" side just cycles teams with ‹ ›. */}
              <span className="mut" style={{ fontSize: 12 }}>Values:</span>
              {[["redraft", "Redraft"], ["dynasty", "Dynasty"]].map(([k, l]) => (
                <button key={k} className="btn btn-mini" style={{ borderColor: evalType === k ? "var(--gold)" : "var(--line)", color: evalType === k ? "var(--gold)" : "var(--mut)" }} onClick={() => setEvalType(k)}>{l}</button>
              ))}
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4, marginLeft: 6 }}>
                <button className="btn btn-mini" title="Previous team" onClick={() => { setPartner((p) => { let n = p; do { n = (n - 1 + TEAMS) % TEAMS; } while (n === userIdx); return n; }); setGet([]); }}><i className="ti ti-chevron-left" style={{ fontSize: 13 }} aria-hidden="true" /></button>
                <span style={{ fontSize: 12.5, fontWeight: 700, minWidth: 92, textAlign: "center" }}>{TEAM_NAMES[partner].split(" ")[0]}</span>
                <button className="btn btn-mini" title="Next team" onClick={() => { setPartner((p) => { let n = p; do { n = (n + 1) % TEAMS; } while (n === userIdx); return n; }); setGet([]); }}><i className="ti ti-chevron-right" style={{ fontSize: 13 }} aria-hidden="true" /></button>
              </span>
            </div>
          </div>
          {cfg.connect && cfg.connect.platform === "sleeper" && (
            <div className="panel" style={{ padding: "8px 11px", marginBottom: 12, background: "var(--panel2)", display: "flex", alignItems: "center", gap: 8 }}>
              <i className="ti ti-refresh" style={{ fontSize: 14, color: "var(--green)" }} aria-hidden="true" />
              <span className="mut" style={{ fontSize: 11.5 }}>Connected to Sleeper — trades executed in your real league (and any future rookie picks you own or have traded) sync in automatically and update these rosters. Use this to model deals before you make them.</span>
            </div>
          )}
          {myRoster.length === 0 && !cfg.pickTrading ? <div className="mut">Draft some players first, or turn on draft-pick trading in League settings, to make a trade.</div> : (
            <>
              {(myRoster.length === 0 || teamRosters[partner].length === 0) && cfg.pickTrading && (
                <div className="mut" style={{ fontSize: 11.5, marginBottom: 10 }}>No players drafted yet — that's fine. You can still trade this draft's picks and future rookie picks. As players get drafted they'll appear here too.</div>
              )}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                <div>
                  <div className="disp gold" style={{ fontSize: 12, letterSpacing: ".06em", marginBottom: 6 }}>YOU GIVE <span className="mut" style={{ fontWeight: 400, letterSpacing: 0 }}>· highest value first</span></div>
                  {myAssets.map((a) => <AssetRow key={a.id} a={a} checked={give.includes(a.id)} onToggle={() => toggle(give, setGive, a.id)} />)}
                  {myAssets.length === 0 && <div className="mut" style={{ fontSize: 12 }}>You haven't drafted yet.</div>}
                </div>
                <div>
                  <div className="disp gold" style={{ fontSize: 12, letterSpacing: ".06em", marginBottom: 6 }}>YOU GET <span className="mut" style={{ fontWeight: 400, letterSpacing: 0 }}>· highest value first</span></div>
                  {partnerAssets.length === 0 ? <div className="mut" style={{ fontSize: 12 }}>This team hasn't drafted yet.</div>
                    : partnerAssets.map((a) => <AssetRow key={a.id} a={a} checked={get.includes(a.id)} onToggle={() => toggle(get, setGet, a.id)} />)}
                </div>
              </div>
              <div className="panel" style={{ padding: 12, marginTop: 14, background: "var(--panel2)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, flexWrap: "wrap", gap: 6 }}>
                  <span>You give <b className="num">{ev.giveAdj}</b> <span className="mut">(raw {ev.rawGive})</span></span>
                  <span>You get <b className="num">{ev.getAdj}</b> <span className="mut">(raw {ev.rawGet})</span></span>
                  <span style={{ color: ev.net > 6 ? "var(--green)" : ev.net < -6 ? "var(--red)" : "var(--mut)" }}>Net <b className="num">{ev.net > 0 ? `+${ev.net}` : ev.net}</b></span>
                </div>
                {(give.length || get.length) ? (
                  <div style={{ marginTop: 10, fontSize: 12.5 }}>
                    {giveAssets.length >= getAssets.length + 2 && (
                      <div style={{ color: "var(--gold)", marginBottom: 4 }}><i className="ti ti-alert-triangle" style={{ fontSize: 12, marginRight: 4 }} aria-hidden="true" />Bulk trade: {giveAssets.length} pieces for {getAssets.length}. Consolidating into fewer, better players costs raw value — the headliner carries a premium and the extra bodies are discounted.</div>
                    )}
                    <div className="mut">{ev.net > 6 ? "After the consolidation adjustment, this still nets you value." : ev.net < -6 ? "You're giving up more adjusted value than you get back." : "Roughly even on adjusted value."}</div>
                    <div style={{ marginTop: 6 }}>Estimated chance <b>{TEAM_NAMES[partner].split(" ")[0]}</b> accepts: <b className="num" style={{ color: accept > 55 ? "var(--green)" : accept < 35 ? "var(--red)" : "var(--gold)" }}>{accept}%</b> <span className="mut">· {accept > 60 ? "fair-to-favorable for them" : accept > 40 ? "roughly fair" : "tilted in your favor"}</span></div>
                    {(isMock || true) && (give.length > 0 && get.length > 0) && (() => {
                      // Value the partner needs to gain to reach ~fair (accept ≈ 50). partnerNet>0 means they already gain.
                      const needed = Math.max(0, Math.ceil((6 - partnerNet)));
                      // Ideas: smallest add-ons from YOUR side (unselected roster players + picks) that would close the gap.
                      const addable = [...myRoster.filter((p) => !give.includes(p.id)), ...(cfg.pickTrading ? myPicks.filter((a) => !give.includes(a.id)) : [])]
                        .map((a) => ({ a, v: assetVal(a, cfg) }))
                        .filter((x) => x.v > 0)
                        .sort((m, n) => Math.abs(m.v - needed) - Math.abs(n.v - needed))
                        .slice(0, 3);
                      const propose = (force) => {
                        const ok = force || (Math.random() * 100 < accept);
                        if (ok) {
                          const givePlayers = giveAssets.filter((a) => !a.pickAsset).map((a) => a.id);
                          const getPlayers = getAssets.filter((a) => !a.pickAsset).map((a) => String(a.id).replace(/^their-/, "")).map(Number);
                          onExecuteTrade && onExecuteTrade({ partner, givePlayers, getPlayers });
                          setTradeResult({ ok: true, forced: force && accept < 50, msg: force && accept < 50 ? `Forced through. ${TEAM_NAMES[partner].split(" ")[0]}'s roster updated on the board.` : `${TEAM_NAMES[partner].split(" ")[0]} accepted — the deal gained them value. Board updated.` });
                          setGive([]); setGet([]);
                        } else {
                          setTradeResult({ ok: false, needed, ideas: addable, msg: `${TEAM_NAMES[partner].split(" ")[0]} passed.` });
                        }
                      };
                      return (
                      <div style={{ marginTop: 12, borderTop: "1px solid var(--line)", paddingTop: 10 }}>
                        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                          {isMock && tradingOn && <button className="btn btn-gold" onClick={() => propose(false)}><i className="ti ti-send" style={{ fontSize: 13, marginRight: 5 }} aria-hidden="true" />Propose to {TEAM_NAMES[partner].split(" ")[0]}</button>}
                          <button className="btn" style={{ borderColor: "#fff" }} onClick={() => propose(true)} title="Push the trade through immediately, regardless of the CPU's decision — handy when a deal's already agreed in your real draft"><i className="ti ti-bolt" style={{ fontSize: 13, marginRight: 5 }} aria-hidden="true" />Force trade</button>
                        </div>
                        {tradeResult && (
                          <div style={{ marginTop: 10, fontSize: 12.5 }}>
                            <div style={{ color: tradeResult.ok ? "var(--green)" : "var(--red)", fontWeight: 600 }}>{tradeResult.ok ? "✓ " : "✕ "}{tradeResult.msg}{tradeResult.forced && <span className="mut" style={{ fontWeight: 400 }}> (forced — they'd have declined)</span>}</div>
                            {!tradeResult.ok && (
                              <div className="mut" style={{ marginTop: 6, lineHeight: 1.5 }}>
                                They’d need to gain about <b style={{ color: "var(--ink)" }}>{tradeResult.needed} more</b> in adjusted value to bite.
                                {tradeResult.ideas && tradeResult.ideas.length > 0 && <> Try adding {tradeResult.ideas.map((x, i) => <span key={i}><b style={{ color: "var(--ink)" }}>{x.a.name}</b> ({x.v}){i < tradeResult.ideas.length - 1 ? ", or " : ""}</span>)} to your side — or ask for a lesser player back.</>}
                                <> You can also <b style={{ color: "var(--ink)" }}>Force trade</b> if you’ve already agreed it elsewhere.</>
                              </div>
                            )}
                          </div>
                        )}
                        <div className="mut" style={{ fontSize: 10.5, marginTop: 8 }}>CPU teams only accept deals that gain them adjusted value for this format — no lopsided trades. Force pushes any deal through instantly. Future rookie picks ride along in the deal terms.{!isMock && " In the official draft, Force is the quick way to log a trade you've already made."}</div>
                      </div>
                      );
                    })()}
                  </div>
                ) : <div className="mut" style={{ fontSize: 12, marginTop: 8 }}>Select assets on both sides to evaluate.</div>}
              </div>
            </>
          )}
        </div>
      )}

      {mode === "values" && (
        <div className="panel" style={{ padding: 16 }}>
          <div className="disp" style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Player values database</div>
          <div className="mut" style={{ fontSize: 12.5, marginBottom: 12, lineHeight: 1.5 }}>
            Browse format-aware player values on a 0–9999 scale, computed by Compass's own engine. Adjust the league settings below to see how a player's worth shifts — superflex lifts QBs, TE-premium lifts tight ends, dynasty weights youth, and so on. This is independent of your actual league, so you can explore any format.
          </div>
          {/* format controls */}
          <div className="panel" style={{ padding: 12, marginBottom: 12, background: "var(--panel2)", display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div>
              <div className="mut" style={{ fontSize: 10.5, marginBottom: 4 }}>QB format</div>
              <div style={{ display: "inline-flex", border: "1px solid var(--line)", borderRadius: 7, overflow: "hidden" }}>
                {[["1qb", "1QB"], ["sf", "Superflex"]].map(([k, l]) => (
                  <button key={k} className="btn btn-mini" style={{ borderRadius: 0, border: "none", background: vbQb === k ? "var(--gold)" : "transparent", color: vbQb === k ? "#151002" : "var(--ink)", fontWeight: vbQb === k ? 700 : 400 }} onClick={() => setVbQb(k)}>{l}</button>
                ))}
              </div>
            </div>
            <div>
              <div className="mut" style={{ fontSize: 10.5, marginBottom: 4 }}>TE</div>
              <div style={{ display: "inline-flex", border: "1px solid var(--line)", borderRadius: 7, overflow: "hidden" }}>
                {[["std", "Standard"], ["tep", "TE premium"]].map(([k, l]) => (
                  <button key={k} className="btn btn-mini" style={{ borderRadius: 0, border: "none", background: vbTep === k ? "var(--gold)" : "transparent", color: vbTep === k ? "#151002" : "var(--ink)", fontWeight: vbTep === k ? 700 : 400 }} onClick={() => setVbTep(k)}>{l}</button>
                ))}
              </div>
            </div>
            <div>
              <div className="mut" style={{ fontSize: 10.5, marginBottom: 4 }}>Scoring</div>
              <div style={{ display: "inline-flex", border: "1px solid var(--line)", borderRadius: 7, overflow: "hidden" }}>
                {[["std", "Std"], ["half", "0.5 PPR"], ["ppr", "PPR"]].map(([k, l]) => (
                  <button key={k} className="btn btn-mini" style={{ borderRadius: 0, border: "none", background: vbScoring === k ? "var(--gold)" : "transparent", color: vbScoring === k ? "#151002" : "var(--ink)", fontWeight: vbScoring === k ? 700 : 400 }} onClick={() => setVbScoring(k)}>{l}</button>
                ))}
              </div>
            </div>
            <div>
              <div className="mut" style={{ fontSize: 10.5, marginBottom: 4 }}>League type</div>
              <div style={{ display: "inline-flex", border: "1px solid var(--line)", borderRadius: 7, overflow: "hidden" }}>
                {[["redraft", "Redraft"], ["dynasty", "Dynasty"]].map(([k, l]) => (
                  <button key={k} className="btn btn-mini" style={{ borderRadius: 0, border: "none", background: vbType === k ? "var(--gold)" : "transparent", color: vbType === k ? "#151002" : "var(--ink)", fontWeight: vbType === k ? 700 : 400 }} onClick={() => setVbType(k)}>{l}</button>
                ))}
              </div>
            </div>
            <div>
              <div className="mut" style={{ fontSize: 10.5, marginBottom: 4 }}>Teams</div>
              <select className="gs" style={{ fontSize: 12, padding: "4px 6px" }} value={vbTeams} onChange={(e) => setVbTeams(+e.target.value)}>
                {[8, 10, 12, 14, 16].map((n) => <option key={n} value={n}>{n} teams</option>)}
              </select>
            </div>
          </div>
          {/* position filter + search */}
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
            {["ALL", ...POS].map((p) => (
              <button key={p} className="btn btn-mini" style={{ borderColor: vbPos === p ? "var(--gold)" : "var(--line)", color: vbPos === p ? "var(--gold)" : "var(--ink)" }} onClick={() => setVbPos(p)}>{p}</button>
            ))}
            <input className="gs" style={{ width: 180, marginLeft: "auto" }} placeholder="Search for a player" value={vbSearch} onChange={(e) => setVbSearch(e.target.value)} />
          </div>
          {/* values table */}
          <div style={{ overflowX: "auto" }}>
            <table className="tbl" style={{ width: "100%", fontSize: 12.5 }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--mut)", fontSize: 11 }}>
                  <th style={{ padding: "6px 8px" }}>#</th>
                  <th style={{ padding: "6px 8px" }}>Player</th>
                  <th style={{ padding: "6px 8px" }}>Pos</th>
                  <th style={{ padding: "6px 8px", textAlign: "right" }}>Value</th>
                  <th style={{ padding: "6px 8px", textAlign: "right" }}>Age</th>
                </tr>
              </thead>
              <tbody>
                {valuesFiltered.map((x) => (
                  <tr key={x.p.id} className="hairline" style={{ cursor: showTip ? "help" : "default" }}
                    onMouseEnter={showTip ? (e) => showTip(e, makeOutlook(x.p, null, false)) : undefined} onMouseLeave={hideTip}>
                    <td className="mut num" style={{ padding: "6px 8px" }}>{x.overall}</td>
                    <td style={{ padding: "6px 8px", fontWeight: 600 }}>{x.p.name}{x.p.rookie ? <span className="mut" style={{ fontSize: 10, marginLeft: 4 }}>R</span> : null}</td>
                    <td style={{ padding: "6px 8px" }}><Dot pos={x.p.pos} /><span className="mut">{x.p.pos}{x.posRank}</span></td>
                    <td className="num" style={{ padding: "6px 8px", textAlign: "right", fontWeight: 700, color: "var(--gold)" }}>{x.ktc}</td>
                    <td className="mut num" style={{ padding: "6px 8px", textAlign: "right" }}>{x.p.age || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mut" style={{ fontSize: 10.5, marginTop: 10, lineHeight: 1.5 }}>
            Values are Compass's own format-aware estimates (projection-based VBD with superflex / TE-premium / dynasty-age adjustments), scaled 0–9999 for easy comparison. They're not affiliated with or derived from any third-party value service.
          </div>
        </div>
      )}

      <div className="mut" style={{ fontSize: 11, marginTop: 10 }}>{cfg.pickTrading ? "Draft picks are valued by round (next-year rookie picks discounted for uncertainty). " : ""}In dynasty/keeper leagues, counterparty acceptance also uses each owner's real transaction history when a league is connected.</div>
    </div>
  );
}

export default TradeCenter;
