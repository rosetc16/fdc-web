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
/* ⚠ 29r — IMPORTED FROM ITS REAL HOME, NOT RE-EXPORTED THROUGH App.jsx.
   `api`/`hasBackend` are things App.jsx imports too, and the 29p extractor only read App.jsx's own
   top-level DECLARATIONS — so this line was missing and the screen threw "hasBackend is not defined"
   the instant it mounted. tools/screens-check.mjs now fails the build on any free identifier here. */
import { api, hasBackend } from "../api.js";
import { CURRENT_SEASON, POS, Compass, formatKey } from "../App.jsx";

function Admin({ biz, setBiz, user, leagues, feedback, onRespond, onDeleteFeedback, onGrantComp, onRevokeComp, onBack }) {
  const [tab, setTab] = useState("users"); // users | invites | feedback | tools
  const [users, setUsers] = useState(null);
  const [totals, setTotals] = useState(null);
  const [uSearch, setUSearch] = useState("");
  const [invites, setInvites] = useState(null);
  const [fb, setFb] = useState(null);
  const [fbNew, setFbNew] = useState(0);
  // 29o — which door the message came through. "enhancement" collects the ideas; "bug" the defects; the
  // long tail of "other" and anything an older build filed under a topic we no longer offer stays reachable
  // under All, so a filter can never hide a report.
  const [fbKind, setFbKind] = useState("all");   // all | bug | idea
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteScope, setInviteScope] = useState("season");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const note = (t) => { setMsg(t); setTimeout(() => setMsg(null), 3500); };

  const loadUsers = async (search) => { try { const r = await api.adminUsers(search); setUsers(r.users); setTotals(r.totals); } catch (e) { note("Couldn't load users: " + (e.data?.error || e.message)); } };
  const loadInvites = async () => { try { const r = await api.adminInvites(); setInvites(r.invites); } catch (e) {} };
  const loadFeedback = async () => { try { const r = await api.adminFeedback(); setFb(r.feedback); setFbNew(r.newCount); } catch (e) {} };
  useEffect(() => { if (!hasBackend) return; loadUsers(); loadInvites(); loadFeedback(); }, []);

  const toggleDisabled = async (email, disabled) => { setBusy(true); try { await api.adminSetDisabled(email, disabled); await loadUsers(uSearch); note(disabled ? `Access turned OFF for ${email}` : `Access restored for ${email}`); } catch (e) { note(e.data?.error || e.message); } finally { setBusy(false); } };
  const revoke = async (email) => { setBusy(true); try { await api.adminRevokeComp(email); await loadUsers(uSearch); note(`Comp revoked for ${email}`); } catch (e) { note(e.data?.error || e.message); } finally { setBusy(false); } };
  const sendInvite = async () => {
    const email = inviteEmail.trim().toLowerCase();
    if (!email.includes("@")) return;
    setBusy(true);
    try { const r = await api.adminInvite(email, inviteScope); note(r.applied ? `Free access granted to ${email}` : `Invite saved — ${email} gets free access when they sign up`); setInviteEmail(""); await loadInvites(); await loadUsers(uSearch); }
    catch (e) { note(e.data?.error || e.message); } finally { setBusy(false); }
  };
  const cancelInvite = async (email) => { setBusy(true); try { await api.adminCancelInvite(email); await loadInvites(); note(`Invite canceled for ${email}`); } catch (e) {} finally { setBusy(false); } };
  const [jobResult, setJobResult] = useState(null);
  const [runningJob, setRunningJob] = useState(null);   // which job id is currently running (for per-button UI)
  const [jobProgress, setJobProgress] = useState("");   // live progress line shown next to the buttons
  const [dbSize, setDbSize] = useState(null);           // { total, tables[], adp_observations }
  const [dbBusy, setDbBusy] = useState(false);
  const loadDbSize = async () => {
    setDbSize({ loading: true });
    try { await api.wake({ maxWaitMs: 90000 }); setDbSize(await api.adminDbSize()); }
    catch (e) { setDbSize({ error: e.data?.error || e.message }); }
  };
  const cleanupDb = async (keepDays) => {
    if (!window.confirm(`Delete harvested draft picks older than ${keepDays} days and reclaim space? Your ADP numbers are unaffected — they're stored separately and recompute on the next refresh. This briefly locks the ADP tables while it compacts them (a few seconds to a couple of minutes).`)) return;
    setDbBusy(true);
    try {
      await api.wake({ maxWaitMs: 90000 });
      const r = await api.adminDbCleanup(keepDays);
      const b = r.sizeBefore, a = r.sizeAfter;
      const sizeMsg = (b && a) ? ` DB ${b.total} → ${a.total}.` : "";
      note(`Cleanup done. Removed ${Number(r.deleted || 0).toLocaleString()} old harvest rows, trimmed ${Number(r.consensusSourcesTrimmed || 0).toLocaleString()} consensus blobs.${sizeMsg}`);
      await loadDbSize();
    }
    catch (e) { note("Cleanup failed: " + (e.data?.error || e.message)); }
    finally { setDbBusy(false); }
  };

  // ---- Manual rankings: upload a CSV (e.g. FantasyPros) to lightly nudge / gap-fill the board ----
  const [rankings, setRankings] = useState([]);
  const [rkType, setRkType] = useState("dynasty");
  const [rkPpr, setRkPpr] = useState("1");
  const [rkTep, setRkTep] = useState("no");
  const [rkQb, setRkQb] = useState("SF");
  const [rkTeams, setRkTeams] = useState("12");
  const [rkDate, setRkDate] = useState("");
  const [rkLabel, setRkLabel] = useState("");
  const [rkParsed, setRkParsed] = useState(null);   // { rows:[{name,pos,team,avg}], fileName }
  const [rkBusy, setRkBusy] = useState(false);
  const [rkProgress, setRkProgress] = useState("");
  const loadRankings = async () => { try { setRankings(await api.adminManualRankings() || []); } catch (e) { setRankings([]); } };
  useEffect(() => { if (hasBackend && tab === "rankings") loadRankings(); }, [tab]);

  // Minimal robust CSV parse (handles quoted fields). Extracts the columns we need: PLAYER NAME, POS, TEAM, AVG.
  const parseRankingCsv = (text, fileName) => {
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
    if (!lines.length) return null;
    const splitRow = (line) => {
      const out = []; let cur = "", inQ = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') { if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
        else if (c === "," && !inQ) { out.push(cur); cur = ""; }
        else cur += c;
      }
      out.push(cur); return out.map((s) => s.trim());
    };
    const header = splitRow(lines[0]).map((h) => h.replace(/"/g, "").toUpperCase().trim());
    // Return the column whose header matches the EARLIEST name in the priority list (not the earliest column),
    // so e.g. AVG. is preferred over RK even when RK appears first in the file.
    const idx = (names) => { for (const nm of names) { const j = header.indexOf(nm); if (j >= 0) return j; } return -1; };
    const iName = idx(["PLAYER NAME", "PLAYER", "NAME"]);
    const iPos = idx(["POS", "POSITION"]);
    const iTeam = idx(["TEAM", "TM"]);
    // Value column: prefer the continuous average (AVG./ECR), fall back to the integer rank (RK/RANK). Both give
    // a valid ordering; AVG. breaks ties more smoothly, but RK works fine as a similar signal when that's all the
    // export has (e.g. FantasyPros' draft cheat-sheet export has RK but no AVG.).
    const iVal = idx(["AVG.", "AVG", "AVERAGE", "ECR", "RK", "RANK", "#"]);
    const usingRank = iVal >= 0 && ["RK", "RANK", "#"].includes(header[iVal]);
    if (iName < 0 || iVal < 0) return null;
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const c = splitRow(lines[i]);
      const name = (c[iName] || "").replace(/"/g, "").trim();
      if (!name) continue;
      const posRaw = iPos >= 0 ? (c[iPos] || "").replace(/[0-9"]/g, "").trim() : "";
      const team = iTeam >= 0 ? (c[iTeam] || "").replace(/"/g, "").trim() : "";
      const avg = parseFloat((c[iVal] || "").replace(/"/g, "").trim());
      if (!Number.isFinite(avg)) continue;
      rows.push({ name, pos: posRaw, team, avg });
    }
    return rows.length ? { rows, fileName, usingRank } : null;
  };

  const onRankingFile = async (file) => {
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = parseRankingCsv(text, file.name);
      if (!parsed) { note("Couldn't read that CSV — expected columns like PLAYER NAME, POS, TEAM, AVG."); return; }
      setRkParsed(parsed);
      if (!rkLabel) setRkLabel(file.name.replace(/\.csv$/i, ""));
      note(`Parsed ${parsed.rows.length} players from ${file.name} (using ${parsed.usingRank ? "the RK/rank column — no AVG. found" : "the AVG. column"}). Review the format, then Upload.`);
    } catch (e) { note("Couldn't read that file."); }
  };

  const uploadRanking = async () => {
    if (!rkParsed || !rkParsed.rows.length) { note("Pick a CSV first."); return; }
    setRkBusy(true); setRkProgress("Matching players…");
    try {
      await api.wake({ maxWaitMs: 90000 });
      // Resolve each row to a player_id via the existing admin search. Match on name; use position + team to
      // disambiguate when the search returns several. Team is a SOFT signal (can change on a trade/FA move).
      const resolved = [];
      let unmatched = 0;
      const rows = rkParsed.rows;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (i % 25 === 0) setRkProgress(`Matching players… ${i}/${rows.length}`);
        let hits = [];
        try { hits = await api.adminPlayerSearch(r.name) || []; } catch (e) { hits = []; }
        if (!hits.length) { unmatched++; continue; }
        // rank candidates: exact name + pos + team > name + pos > name
        const norm = (s) => (s || "").toLowerCase().replace(/[^a-z]/g, "");
        const wantName = norm(r.name), wantPos = (r.pos || "").toUpperCase(), wantTeam = (r.team || "").toUpperCase();
        let best = hits.find((h) => norm(h.full_name) === wantName && (h.position || "").toUpperCase() === wantPos && (h.team || "").toUpperCase() === wantTeam)
          || hits.find((h) => norm(h.full_name) === wantName && (h.position || "").toUpperCase() === wantPos)
          || hits.find((h) => norm(h.full_name) === wantName)
          || hits[0];
        if (best) resolved.push({ player_id: best.player_id, pos: (best.position || wantPos || "").toUpperCase(), rank: r.avg });
        else unmatched++;
      }
      if (!resolved.length) { note("No players matched — check the CSV format."); setRkProgress(""); return; }
      setRkProgress(`Uploading ${resolved.length} players…`);
      const r = await api.adminUploadRanking({
        players: resolved,
        type: rkType, ppr: rkPpr, tep: rkTep === "yes", qb: rkQb, teams: rkTeams,
        label: rkLabel || rkParsed.fileName, sourceName: rkParsed.fileName,
        date: rkDate ? new Date(rkDate).toISOString() : new Date().toISOString(),
      });
      setRkParsed(null); setRkProgress("");
      note(`Uploaded ${r.playersWritten} players for ${r.formatKey}.${unmatched ? ` ${unmatched} names didn't match and were skipped.` : ""} Run Update Sleeper ADP to fold it in.`);
      await loadRankings();
    } catch (e) { note("Upload failed: " + (e.data?.error || e.message)); setRkProgress(""); }
    finally { setRkBusy(false); }
  };
  const deleteRanking = async (id) => {
    if (!window.confirm("Remove this ranking? The board will drop its influence on the next refresh.")) return;
    try { await api.adminDeleteRanking(id); await loadRankings(); note("Ranking removed."); }
    catch (e) { note("Couldn't remove: " + (e.data?.error || e.message)); }
  };
  const [trendsDiag, setTrendsDiag] = useState(null);
  const loadTrendsDiag = async () => {
    try { setTrendsDiag(await api.trendsDiag()); }
    catch (e) {
      if (e.message === "BACKEND_WAKING") {
        // Not an error — just a sleeping dyno. Wake it and retry once.
        setTrendsDiag({ waking: true });
        const awake = await api.wake({ maxWaitMs: 90000 });
        if (awake) { try { setTrendsDiag(await api.trendsDiag()); return; } catch (e2) { /* fall through */ } }
        setTrendsDiag({ error: "Backend is still waking up. Give it a moment and reopen this tab." });
      } else {
        setTrendsDiag({ error: e.data?.error || e.message });
      }
    }
  };
  useEffect(() => { if (hasBackend && tab === "tools") { loadTrendsDiag(); loadDbSize(); } }, [tab]);

  // ---- Player events: dated news that makes pre-event ADP samples stale for one player ----
  const [evts, setEvts] = useState([]);
  const [evtTypes, setEvtTypes] = useState([]);
  const [evtQuery, setEvtQuery] = useState("");
  const [evtHits, setEvtHits] = useState([]);
  const [evtPlayer, setEvtPlayer] = useState(null);          // { player_id, full_name, position, team }
  const [evtType, setEvtType] = useState("season_ending_injury");
  const [evtDate, setEvtDate] = useState("");
  const [evtNote, setEvtNote] = useState("");
  const loadEvents = async () => { try { setEvts(await api.adminEvents() || []); } catch (e) { setEvts([]); } };
  const loadEventTypes = async () => { try { setEvtTypes(await api.adminEventTypes() || []); } catch (e) { setEvtTypes([]); } };
  useEffect(() => { if (hasBackend && tab === "events") { loadEvents(); if (!evtTypes.length) loadEventTypes(); } }, [tab]);
  // debounced player typeahead — we never hardcode players, always look them up live
  useEffect(() => {
    if (!hasBackend || evtQuery.trim().length < 2) { setEvtHits([]); return; }
    const t = setTimeout(async () => {
      try { setEvtHits(await api.adminPlayerSearch(evtQuery.trim()) || []); } catch (e) { setEvtHits([]); }
    }, 220);
    return () => clearTimeout(t);
  }, [evtQuery]);
  const addEvent = async () => {
    if (!evtPlayer || !evtDate) { note("Pick a player and a date."); return; }
    setBusy(true);
    try {
      await api.adminAddEvent({ player_id: evtPlayer.player_id, event_type: evtType, event_date: new Date(evtDate).toISOString(), note: evtNote || null });
      setEvtPlayer(null); setEvtQuery(""); setEvtHits([]); setEvtNote(""); setEvtDate("");
      await loadEvents();
      note("Event saved. Run the ADP refresh job to apply it.");
    } catch (e) { note(e.data?.error || e.message || "Could not save event."); }
    finally { setBusy(false); }
  };
  const removeEvent = async (id) => {
    setBusy(true);
    try { await api.adminDeleteEvent(id); await loadEvents(); note("Event removed. Run the ADP refresh job to restore the original ADP."); }
    catch (e) { note(e.data?.error || e.message || "Could not remove event."); }
    finally { setBusy(false); }
  };
  const runJob = async (job) => {
    setBusy(true); setJobResult(null); setRunningJob(job); setJobProgress("Waking the server…");
    try {
      // Wake the (possibly sleeping) dyno first, showing a live counter, so the button visibly does something
      // even during the 10-40s cold start.
      const awake = await api.wake({ maxWaitMs: 90000, onTick: (secs) => setJobProgress(`Waking the server… ${secs}s`) });
      if (!awake) {
        setJobResult({ ok: false, error: "The backend did not wake within 90 seconds. It may be redeploying — wait a moment and try again." });
        setJobProgress("");
        return;
      }
      setJobProgress(job === "refresh" ? "Server is up. Running full refresh — re-crawling real drafts…" : "Server is up. Pulling Sleeper ADP…");
      const r = await api.adminRunJob(job);
      setJobResult(r);
      const w = r?.detail?.publishedAdp?.observationsWritten ?? r?.detail?.observationsWritten;
      setJobProgress(r.ok ? `Done. ${w != null ? w.toLocaleString() + " ADP rows written." : "See result below."}` : "");
      note(r.ok ? "Job completed." : "Job error — see result below.");
    } catch (e) {
      const msg = e.message === "BACKEND_WAKING"
        ? "The job ran longer than the client would wait. It is probably STILL RUNNING on the server — wait a minute, then click Refresh stats to check."
        : (e.data?.error || e.message);
      setJobResult({ ok: false, error: msg });
      setJobProgress("");
    }
    finally { setBusy(false); setRunningJob(null); }
  };
  const setFbStatus = async (id, status) => { try { await api.adminFeedbackStatus(id, status); await loadFeedback(); } catch (e) {} };

  const fmtDate = (d) => d ? new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—";
  const statusOf = (u) => u.disabled ? { t: "Disabled", c: "var(--red)" } : u.active_paid ? { t: u.comp ? "Comped" : "Active pass", c: "var(--green)" } : { t: "Free", c: "var(--gold)" };

  const TABS = [["users", "Users", users ? users.length : null], ["invites", "Free invites", null], ["feedback", "Feedback", fbNew || null], ["events", "Player events", evts.length || null], ["rankings", "Rankings", null], ["tools", "Stripe & analytics", null]];

  return (
    <div>
      <div className="hairline appheader" style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 18px" }}>
        <Compass size={22} spin />
        <div className="disp" style={{ fontSize: 20, fontWeight: 700 }}>ADMIN <span className="gold">CONSOLE</span></div>
        <span className="chip">Role-gated · {user.email}</span>
        <div style={{ flex: 1 }} />
        <button className="btn" onClick={onBack}>← Back to app</button>
      </div>

      {!hasBackend && <div className="mut" style={{ maxWidth: 980, margin: "12px auto 0", padding: "0 18px", fontSize: 12.5 }}>Connect the backend to manage real users, invites, and feedback. (Currently running without a backend.)</div>}

      {totals && (
        <div style={{ maxWidth: 980, margin: "0 auto", padding: "14px 18px 0", display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12 }}>
          {[["Total accounts", totals.total], ["Active passes", totals.paid], ["Comped", totals.comp]].map(([l, v]) => (
            <div key={l} className="panel" style={{ padding: "12px 16px" }}><div className="num" style={{ fontSize: 24, fontWeight: 700 }}>{v}</div><div className="mut" style={{ fontSize: 11.5 }}>{l}</div></div>
          ))}
        </div>
      )}

      <div style={{ maxWidth: 980, margin: "0 auto", padding: "14px 18px 0", display: "flex", gap: 6, flexWrap: "wrap" }}>
        {TABS.map(([k, l, badge]) => (
          <button key={k} className="btn btn-mini" style={{ borderColor: tab === k ? "var(--gold)" : "var(--line)", color: tab === k ? "var(--gold)" : "var(--ink)", fontWeight: tab === k ? 700 : 400 }} onClick={() => setTab(k)}>
            {l}{badge ? <span className="chip" style={{ fontSize: 9, marginLeft: 6, borderColor: "var(--gold)", color: "var(--gold)" }}>{badge}</span> : null}
          </button>
        ))}
      </div>

      {msg && <div style={{ maxWidth: 980, margin: "10px auto 0", padding: "0 18px" }}><div className="panel" style={{ padding: "8px 12px", fontSize: 12.5, borderColor: "var(--gold)", background: "rgba(224,166,60,.07)" }}>{msg}</div></div>}

      <div style={{ maxWidth: 980, margin: "0 auto", padding: 18 }}>
        {/* USERS */}
        {tab === "users" && (
          <div className="panel" style={{ padding: 16 }}>
            <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
              <input className="gs" style={{ flex: "1 1 220px" }} placeholder="Search by email" value={uSearch} onChange={(e) => setUSearch(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") loadUsers(uSearch); }} />
              <button className="btn" onClick={() => loadUsers(uSearch)}>Search</button>
              {uSearch && <button className="btn btn-mini" onClick={() => { setUSearch(""); loadUsers(""); }}>Clear</button>}
            </div>
            {!users ? <div className="mut" style={{ fontSize: 13 }}>Loading users…</div> : users.length === 0 ? <div className="mut" style={{ fontSize: 13 }}>No users found.</div> : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                  <thead><tr className="mut" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em" }}>
                    <th style={{ textAlign: "left", paddingBottom: 6 }}>Email</th><th style={{ textAlign: "left" }}>Status</th><th style={{ textAlign: "left" }}>Joined</th><th style={{ textAlign: "left" }}>Pass until</th><th></th>
                  </tr></thead>
                  <tbody>
                    {users.map((u) => { const st = statusOf(u); return (
                      <tr key={u.id} style={{ borderTop: "1px solid var(--line)" }}>
                        <td style={{ padding: "6px 8px 6px 0" }}>{u.email}{u.is_admin && <span className="chip" style={{ fontSize: 9, marginLeft: 6 }}>admin</span>}</td>
                        <td style={{ color: st.c }}>{st.t}</td>
                        <td className="mut">{fmtDate(u.created_at)}</td>
                        <td className="mut">{u.comp ? "—" : fmtDate(u.paid_until)}</td>
                        <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                          {u.comp && !u.disabled && <button className="btn btn-mini" disabled={busy} onClick={() => revoke(u.email)} style={{ marginRight: 4 }}>Revoke comp</button>}
                          {!u.is_admin && (u.disabled
                            ? <button className="btn btn-mini" disabled={busy} onClick={() => toggleDisabled(u.email, false)} style={{ borderColor: "var(--green)", color: "var(--green)" }}>Restore</button>
                            : <button className="btn btn-mini" disabled={busy} onClick={() => toggleDisabled(u.email, true)} style={{ borderColor: "var(--red)", color: "var(--red)" }}>Turn off</button>)}
                        </td>
                      </tr>
                    );})}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* INVITES */}
        {tab === "invites" && (
          <div className="panel" style={{ padding: 16 }}>
            <div className="disp" style={{ fontSize: 17, fontWeight: 700, marginBottom: 4 }}>Give free access</div>
            <div className="mut" style={{ fontSize: 12, marginBottom: 12, lineHeight: 1.5 }}>Grant a free season pass by email. If they already have an account, it's applied instantly. If they haven't signed up yet, the free pass activates automatically the moment they create that account.</div>
            <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
              <input className="gs" style={{ flex: "1 1 200px" }} type="email" placeholder="email@example.com" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") sendInvite(); }} />
              <select className="gs" value={inviteScope} onChange={(e) => setInviteScope(e.target.value)}>
                <option value="season">This season ({CURRENT_SEASON})</option>
                <option value="forever">All-time</option>
              </select>
              <button className="btn btn-gold" disabled={busy || !inviteEmail.includes("@")} onClick={sendInvite}><i className="ti ti-gift" style={{ fontSize: 13, marginRight: 4 }} aria-hidden="true" />Grant access</button>
            </div>
            <div className="disp" style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Pending invites <span className="mut" style={{ fontSize: 11 }}>(not yet signed up)</span></div>
            {!invites ? <div className="mut" style={{ fontSize: 12 }}>Loading…</div> : invites.length === 0 ? <div className="mut" style={{ fontSize: 12 }}>No pending invites. Granted access to existing accounts shows on the Users tab as "Comped."</div> : invites.map((iv) => (
              <div key={iv.email} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, padding: "5px 0", borderTop: "1px solid var(--line)" }}>
                <i className="ti ti-mail" style={{ fontSize: 13, color: "var(--gold)" }} aria-hidden="true" />
                <span style={{ flex: 1 }}><b>{iv.email}</b></span>
                <span className="chip" style={{ fontSize: 9 }}>{iv.scope === "forever" ? "All-time" : "Season"}</span>
                <button className="btn btn-mini" disabled={busy} onClick={() => cancelInvite(iv.email)}>Cancel</button>
              </div>
            ))}
          </div>
        )}

        {/* FEEDBACK */}
        {tab === "feedback" && (() => {
          // 29o — the category is whatever the submitter's chip said, lowercased by submitFeedback. Bug and
          // idea are the two doors; everything else (including "other", and anything an older build wrote
          // under a topic we no longer offer) is reachable only under All — which is why All is the default.
          // A filter that can hide a report is worse than no filter.
          const kindOf = (f) => { const c = String((f && f.category) || "").toLowerCase(); return c === "bug" ? "bug" : (c === "idea" || c === "enhancement" || c === "feature") ? "idea" : "other"; };
          const rows = Array.isArray(fb) ? fb.filter((f) => fbKind === "all" || kindOf(f) === fbKind) : null;
          const nOf = (k) => (Array.isArray(fb) ? fb.filter((f) => k === "all" || kindOf(f) === k).length : 0);
          return (
          <div className="panel" style={{ padding: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
              <div className="disp" style={{ fontSize: 17, fontWeight: 700 }}>Feedback inbox</div>
              <div style={{ flex: 1 }} />
              {[["all", "All"], ["bug", "Bugs"], ["idea", "Enhancements"]].map(([k, lbl]) => (
                <button key={k} className="btn btn-mini" data-fbfilter={k}
                  style={{ borderColor: fbKind === k ? "var(--gold)" : "var(--line)", color: fbKind === k ? "var(--gold)" : "var(--mut)" }}
                  onClick={() => setFbKind(k)}>{lbl}{Array.isArray(fb) ? ` (${nOf(k)})` : ""}</button>
              ))}
            </div>
            {!rows ? <div className="mut" style={{ fontSize: 13 }}>Loading…</div> : rows.length === 0 ? <div className="mut" style={{ fontSize: 13 }}>{fb.length === 0 ? "No feedback yet. Messages sent from the site's contact form show up here." : `Nothing filed as ${fbKind === "bug" ? "a bug" : "an enhancement"} yet — ${fb.length} message${fb.length === 1 ? "" : "s"} under All.`}</div> : rows.map((f) => (
              <div key={f.id} style={{ padding: "10px 0", borderTop: "1px solid var(--line)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <span className="chip" style={{ fontSize: 9, borderColor: f.status === "new" ? "var(--gold)" : "var(--line)", color: f.status === "new" ? "var(--gold)" : "var(--mut)" }}>{f.status}</span>
                  <span className="chip" style={{ fontSize: 9 }}>{f.category}</span>
                  <span className="mut" style={{ fontSize: 11.5 }}>{f.email || "anonymous"}</span>
                  <div style={{ flex: 1 }} />
                  <span className="mut" style={{ fontSize: 11 }}>{fmtDate(f.created_at)}</span>
                </div>
                <div style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 6 }}>{f.message}</div>
                <div style={{ display: "flex", gap: 6 }}>
                  {f.status !== "read" && <button className="btn btn-mini" onClick={() => setFbStatus(f.id, "read")}>Mark read</button>}
                  {f.status !== "resolved" && <button className="btn btn-mini" onClick={() => setFbStatus(f.id, "resolved")} style={{ borderColor: "var(--green)", color: "var(--green)" }}>Resolve</button>}
                  {f.email && <a className="btn btn-mini" href={`mailto:${f.email}`} style={{ textDecoration: "none" }}>Reply by email</a>}
                </div>
              </div>
            ))}
          </div>
          );
        })()}

        {/* PLAYER EVENTS — mark the date a player's value changed so pre-event drafts stop counting */}
        {tab === "events" && (
          <div style={{ display: "grid", gap: 14 }}>
            <div className="panel" style={{ padding: 16 }}>
              <div className="disp" style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>Add an event</div>
              <div className="mut" style={{ fontSize: 12, lineHeight: 1.55, marginBottom: 12 }}>
                Mark the date a player's value changed. Drafts from <b>before</b> that date were made without the news,
                so they stop counting for that player. Drafts after it are untouched. The same event hits redraft and
                dynasty differently — a season-ending injury guts redraft value but only dents dynasty. Nothing is
                invented: we only reweight real drafts, so this fades out on its own as new drafts come in, and
                deleting an event fully restores the original ADP.
              </div>

              <div style={{ display: "grid", gap: 10 }}>
                {/* player picker — live lookup, never a hardcoded list */}
                <div style={{ position: "relative" }}>
                  <label className="mut" style={{ fontSize: 11, display: "block", marginBottom: 4 }}>Player</label>
                  {evtPlayer ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span className="chip" style={{ borderColor: "var(--gold)", color: "var(--gold)" }}>
                        {evtPlayer.full_name} · {evtPlayer.position}{evtPlayer.team ? ` · ${evtPlayer.team}` : ""}
                      </span>
                      <button className="btn btn-mini" onClick={() => { setEvtPlayer(null); setEvtQuery(""); }}>Change</button>
                    </div>
                  ) : (
                    <>
                      <input className="gs" style={{ width: "100%" }} placeholder="Search a player…" value={evtQuery} onChange={(e) => setEvtQuery(e.target.value)} />
                      {evtHits.length > 0 && (
                        <div className="panel" style={{ position: "absolute", zIndex: 40, left: 0, right: 0, marginTop: 4, maxHeight: 240, overflowY: "auto", padding: 4 }}>
                          {evtHits.map((h) => (
                            <div key={h.player_id} onClick={() => { setEvtPlayer(h); setEvtHits([]); }}
                              style={{ padding: "6px 8px", cursor: "pointer", borderRadius: 6, fontSize: 12.5 }}
                              onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,.06)"; }}
                              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
                              <b>{h.full_name}</b> <span className="mut">{h.position}{h.team ? ` · ${h.team}` : ""}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <div>
                    <label className="mut" style={{ fontSize: 11, display: "block", marginBottom: 4 }}>What happened</label>
                    <select className="gs" style={{ width: "100%" }} value={evtType} onChange={(e) => setEvtType(e.target.value)}>
                      {(evtTypes.length ? evtTypes : [{ key: "season_ending_injury", label: "Season-ending injury" }]).map((t) => (
                        <option key={t.key} value={t.key}>{t.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="mut" style={{ fontSize: 11, display: "block", marginBottom: 4 }}>Date it happened</label>
                    <input className="gs" type="date" style={{ width: "100%" }} value={evtDate} onChange={(e) => setEvtDate(e.target.value)} />
                  </div>
                </div>

                {/* show the chosen type's effect so there's no mystery about what this will do */}
                {(() => {
                  const t = evtTypes.find((x) => x.key === evtType);
                  if (!t) return null;
                  const pct = (v) => `${Math.round((1 - v) * 100)}%`;
                  return (
                    <div className="mut" style={{ fontSize: 11.5 }}>
                      Pre-event drafts will be discounted <b style={{ color: "var(--red)" }}>{pct(t.redraft)}</b> in redraft
                      and <b style={{ color: "var(--gold)" }}>{pct(t.dynasty)}</b> in dynasty.
                    </div>
                  );
                })()}

                <div>
                  <label className="mut" style={{ fontSize: 11, display: "block", marginBottom: 4 }}>Note (optional)</label>
                  <input className="gs" style={{ width: "100%" }} placeholder="e.g. torn ACL in practice" value={evtNote} onChange={(e) => setEvtNote(e.target.value)} />
                </div>

                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <button className="btn btn-gold" disabled={busy || !evtPlayer || !evtDate} onClick={addEvent}>Save event</button>
                  <span className="mut" style={{ fontSize: 11 }}>Then run <b>Refresh ADP</b> on the Stripe &amp; analytics tab to apply it.</span>
                </div>
              </div>
            </div>

            <div className="panel" style={{ padding: 16 }}>
              <div className="disp" style={{ fontSize: 15, fontWeight: 700, marginBottom: 10 }}>Active events</div>
              {!evts.length ? (
                <div className="mut" style={{ fontSize: 12.5 }}>No events yet. Add one above when news breaks.</div>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                  <thead><tr>
                    {["Player", "What happened", "Date", "Note", ""].map((h) => (
                      <th key={h} style={{ textAlign: "left", color: "var(--mut)", fontWeight: 500, paddingBottom: 6 }}>{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {evts.map((e) => {
                      const t = evtTypes.find((x) => x.key === e.event_type);
                      return (
                        <tr key={e.id} style={{ borderTop: "1px solid var(--line)" }}>
                          <td style={{ padding: "6px 0" }}><b>{e.full_name || e.player_id}</b> <span className="mut">{e.position}{e.team ? ` · ${e.team}` : ""}</span></td>
                          <td style={{ padding: "6px 0" }}>{t ? t.label : e.event_type}</td>
                          <td style={{ padding: "6px 0" }} className="num">{fmtDate(e.event_date)}</td>
                          <td style={{ padding: "6px 0" }} className="mut">{e.note || "—"}</td>
                          <td style={{ padding: "6px 0", textAlign: "right" }}>
                            <button className="btn btn-mini" disabled={busy} onClick={() => removeEvent(e.id)}>Remove</button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}

        {/* MANUAL RANKINGS — upload a CSV (e.g. FantasyPros) to lightly nudge / gap-fill the board */}
        {tab === "rankings" && (
          <div style={{ display: "grid", gap: 14 }}>
            <div className="panel" style={{ padding: 16 }}>
              <div className="disp" style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>Upload a rankings CSV</div>
              <div className="mut" style={{ fontSize: 12.5, lineHeight: 1.55, marginBottom: 12 }}>
                Export a rankings CSV (e.g. FantasyPros) and drop it here. It reads the <b>player name</b>, <b>position</b>, and the <b>AVG.</b> column.
                Rankings are a <b>light ~10% nudge</b> where the board already has real draft ADP, and they <b>fill the gap</b> for players the market
                hasn't drafted yet. Since a source like FantasyPros only publishes one flavor (PPR, standard TE), pick the format you want to apply it
                to below and the values get a <b>subtle scoring adjustment</b> (small TE bump for TE-premium, light PPR shifts). Re-uploading the same
                format replaces the old one, and only rankings within 30 days count.
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
                <label className="btn btn-gold" style={{ cursor: "pointer" }}>
                  <i className="ti ti-upload" style={{ fontSize: 14, marginRight: 5 }} aria-hidden="true" />Choose CSV
                  <input type="file" accept=".csv,text/csv" style={{ display: "none" }} onChange={(e) => onRankingFile(e.target.files?.[0])} />
                </label>
                {rkParsed && <span className="mut" style={{ fontSize: 12 }}>{rkParsed.fileName} — <b style={{ color: "var(--ink)" }}>{rkParsed.rows.length}</b> players parsed</span>}
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 10, marginBottom: 12 }}>
                <div><label className="mut" style={{ fontSize: 11, display: "block", marginBottom: 4 }}>League type</label>
                  <select className="gs" style={{ width: "100%" }} value={rkType} onChange={(e) => setRkType(e.target.value)}>
                    <option value="dynasty">Dynasty</option><option value="redraft">Redraft</option><option value="rookie">Rookie</option><option value="bestball">Best ball</option>
                  </select></div>
                <div><label className="mut" style={{ fontSize: 11, display: "block", marginBottom: 4 }}>PPR</label>
                  <select className="gs" style={{ width: "100%" }} value={rkPpr} onChange={(e) => setRkPpr(e.target.value)}>
                    <option value="1">Full (1.0)</option><option value="0.5">Half (0.5)</option><option value="0">None (0)</option>
                  </select></div>
                <div><label className="mut" style={{ fontSize: 11, display: "block", marginBottom: 4 }}>TE premium</label>
                  <select className="gs" style={{ width: "100%" }} value={rkTep} onChange={(e) => setRkTep(e.target.value)}>
                    <option value="no">No</option><option value="yes">Yes</option>
                  </select></div>
                <div><label className="mut" style={{ fontSize: 11, display: "block", marginBottom: 4 }}>QB</label>
                  <select className="gs" style={{ width: "100%" }} value={rkQb} onChange={(e) => setRkQb(e.target.value)}>
                    <option value="1QB">1 QB</option><option value="2QB">2 QB</option><option value="SF">Superflex</option>
                  </select></div>
                <div><label className="mut" style={{ fontSize: 11, display: "block", marginBottom: 4 }}>Teams</label>
                  <select className="gs" style={{ width: "100%" }} value={rkTeams} onChange={(e) => setRkTeams(e.target.value)}>
                    <option value="8-10">8–10</option><option value="12">12</option><option value="14+">14+</option>
                  </select></div>
                <div><label className="mut" style={{ fontSize: 11, display: "block", marginBottom: 4 }}>Ranking date</label>
                  <input className="gs" type="date" style={{ width: "100%" }} value={rkDate} onChange={(e) => setRkDate(e.target.value)} /></div>
              </div>

              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <button className="btn btn-gold" disabled={rkBusy || !rkParsed} onClick={uploadRanking}>
                  {rkBusy ? <><i className="ti ti-loader-2 spin" style={{ fontSize: 14, marginRight: 5 }} aria-hidden="true" />Working…</> : "Upload ranking"}
                </button>
                {rkProgress && <span style={{ fontSize: 12, color: "var(--gold)", fontWeight: 600 }}>{rkProgress}</span>}
                {!rkProgress && <span className="mut" style={{ fontSize: 11 }}>After upload, run <b>Update Sleeper ADP</b> to fold it into the board.</span>}
              </div>
            </div>

            <div className="panel" style={{ padding: 16 }}>
              <div className="disp" style={{ fontSize: 15, fontWeight: 700, marginBottom: 10 }}>Active rankings</div>
              {!rankings.length ? (
                <div className="mut" style={{ fontSize: 12.5 }}>No rankings uploaded yet.</div>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                  <thead><tr>{["Format", "Players", "Source", "Uploaded", ""].map((h) => <th key={h} style={{ textAlign: "left", color: "var(--mut)", fontWeight: 500, paddingBottom: 6 }}>{h}</th>)}</tr></thead>
                  <tbody>
                    {rankings.map((r) => (
                      <tr key={r.id} style={{ borderTop: "1px solid var(--line)" }}>
                        <td style={{ padding: "6px 0" }}><span className="num">{r.format_key}</span></td>
                        <td style={{ padding: "6px 0" }} className="num">{r.player_count}</td>
                        <td style={{ padding: "6px 0" }} className="mut">{r.label || r.source_name || "—"}</td>
                        <td style={{ padding: "6px 0" }} className="num mut">{fmtDate(r.created_at)}</td>
                        <td style={{ padding: "6px 0", textAlign: "right" }}><button className="btn btn-mini" onClick={() => deleteRanking(r.id)}>Remove</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}

        {/* TOOLS — pointers to Stripe + Cloudflare (the right homes for these) */}
        {tab === "tools" && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 14 }}>
            <div className="panel" style={{ padding: 16 }}>
              <div className="disp" style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>Pricing & promo codes</div>
              <div className="mut" style={{ fontSize: 12.5, lineHeight: 1.55, marginBottom: 10 }}>Price changes and discount codes are managed in Stripe, not here — Stripe enforces them securely at checkout. Create a coupon, then a promotion code customers type at checkout.</div>
              <a className="btn btn-mini" href="https://dashboard.stripe.com/coupons" target="_blank" rel="noreferrer" style={{ textDecoration: "none", marginRight: 6 }}>Open Stripe coupons ↗</a>
              <a className="btn btn-mini" href="https://dashboard.stripe.com/products" target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>Stripe products ↗</a>
            </div>
            <div className="panel" style={{ padding: 16 }}>
              <div className="disp" style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>Site analytics</div>
              <div className="mut" style={{ fontSize: 12.5, lineHeight: 1.55, marginBottom: 10 }}>Real visitor traffic, sources, and conversions live in Cloudflare Web Analytics (free, privacy-friendly, already part of your Cloudflare account). Turn it on for fantasydraftcompass.com and view the dashboard there.</div>
              <a className="btn btn-mini" href="https://dash.cloudflare.com/?to=/:account/web-analytics" target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>Open Cloudflare Analytics ↗</a>
            </div>
            <div className="panel" style={{ padding: 16, gridColumn: "1 / -1" }}>
              <div className="disp" style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>Data jobs — ADP & projections</div>
              <div className="mut" style={{ fontSize: 12.5, lineHeight: 1.55, marginBottom: 10 }}>Pull the latest Sleeper ADP and projections into the board. <b style={{ color: "var(--ink)" }}>Update Sleeper ADP</b> is the fast one — it fetches Sleeper's published ADP for every player and recomputes the board in seconds (run this if ADP looks wrong). <b style={{ color: "var(--ink)" }}>Full refresh</b> also re-crawls real drafts and can take a minute.</div>
              <div className="mut" style={{ fontSize: 12.5, lineHeight: 1.55, marginBottom: 10 }}><b style={{ color: "var(--green)" }}>These run automatically</b> — a full refresh at 4 AM (which now includes injury detail), a lighter ADP refresh midday, and a harvest pass every few hours. You normally never need to touch them. The buttons below are just a manual override if you want to force an update right now — injuries being the one worth pressing when news breaks during the day.</div>
              <div className="mut" style={{ fontSize: 12.5, lineHeight: 1.55, marginBottom: 10 }}><b style={{ color: "var(--gold)" }}>Playoff SOS needs two one-time pulls</b> — <b style={{ color: "var(--ink)" }}>Pull schedule</b> then <b style={{ color: "var(--ink)" }}>Build defense ranks</b>. Until both have run, the Playoff SOS column shows a dash for every player rather than a guess. After that the nightly refresh keeps them current.</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <button className="btn btn-gold" disabled={busy} onClick={() => runJob("adp")}>
                  <i className={`ti ti-${runningJob === "adp" ? "loader-2 spin" : "refresh"}`} style={{ fontSize: 14, marginRight: 5 }} aria-hidden="true" />
                  {runningJob === "adp" ? "Working…" : "Update Sleeper ADP"}
                </button>
                <button className="btn" disabled={busy} onClick={() => runJob("refresh")}>
                  <i className={`ti ti-${runningJob === "refresh" ? "loader-2 spin" : "refresh"}`} style={{ fontSize: 14, marginRight: 5 }} aria-hidden="true" />
                  {runningJob === "refresh" ? "Working…" : "Full refresh (slower)"}
                </button>
                <button className="btn" disabled={busy} onClick={() => runJob("byes")} title="Fast: sets every player's bye week from the current NFL schedule (~1 second). Run this after the schedule is released.">
                  <i className={`ti ti-${runningJob === "byes" ? "loader-2 spin" : "calendar-event"}`} style={{ fontSize: 14, marginRight: 5 }} aria-hidden="true" />
                  {runningJob === "byes" ? "Working…" : "Sync bye weeks"}
                </button>
                {/* Runs the INJURIES job — the one that merges ESPN's team injury reports over Sleeper's
                    designations and fills the detail the board shows. It is already in the nightly refresh;
                    this is the manual override for when news breaks during the day. (It used to point at
                    the older ESPN-headlines job, which is why clicking it did nothing useful.) */}
                <button className="btn" disabled={busy} onClick={() => runJob("injuries")} title="Pull the latest injury designations and detail (ESPN team reports merged over your platform's status). This also runs automatically in the nightly refresh — use this when something breaks mid-day.">
                  <i className={`ti ti-${runningJob === "injuries" ? "loader-2 spin" : "ambulance"}`} style={{ fontSize: 14, marginRight: 5 }} aria-hidden="true" />
                  {runningJob === "injuries" ? "Working…" : "Pull injury detail"}
                </button>
                {/* ⚠ THESE TWO EXIST BECAUSE I SHIPPED THE BACKEND JOBS WITHOUT THEM. Backend 116 added the
                    `schedule` and `defvspos` cases and the admin console never got the buttons, so playoff
                    SOS had no data and every row read "—". Exactly the 112 failure repeated: the job I built
                    and the button he could press were not the same thing. When a job needs a manual trigger,
                    the button ships in the SAME build. */}
                <button className="btn" disabled={busy} onClick={() => runJob("schedule")} title="Fetch the NFL regular-season schedule. Playoff SOS cannot be computed without it. Also runs in the nightly refresh; a schedule is fixed once released, so you only need this once.">
                  <i className={`ti ti-${runningJob === "schedule" ? "loader-2 spin" : "calendar-event"}`} style={{ fontSize: 14, marginRight: 5 }} aria-hidden="true" />
                  {runningJob === "schedule" ? "Working…" : "Pull schedule"}
                </button>
                <button className="btn" disabled={busy} onClick={() => runJob("defvspos")} title="Build last season's defense-vs-position table (~18 calls to your platform, then cached). This is the other half of Playoff SOS — it is what makes an opponent 'soft' or 'tough' for a given position.">
                  <i className={`ti ti-${runningJob === "defvspos" ? "loader-2 spin" : "shield-half"}`} style={{ fontSize: 14, marginRight: 5 }} aria-hidden="true" />
                  {runningJob === "defvspos" ? "Working…" : "Build defense ranks"}
                </button>
                {/* ⭐ AND THIS ONE SHIPS WITH ITS JOB, same rule. Trey: "can you check DST point projections…
                    most/all are coming up as 0 (and VBD is 0). I also think the Kicker projected points is
                    extremely low (in the 40s)." The defense half was a certain bug (the pack's stat mapper
                    had no team-defense branch at all); the kicker half needs the live feed to answer, and
                    this prints what it actually carries. */}
                <button className="btn" disabled={busy} onClick={() => runJob("proj-check")} title="Reads nothing and writes nothing. Reports, per position, how many players have a projection, which raw stat keys those projections carry, and which of the stats the scoring engine reads never survive the mapping. This is how to tell a scoring-settings problem from a missing-data one.">
                  <i className={`ti ti-${runningJob === "proj-check" ? "loader-2 spin" : "stethoscope"}`} style={{ fontSize: 14, marginRight: 5 }} aria-hidden="true" />
                  {runningJob === "proj-check" ? "Working…" : "Check projections"}
                </button>
                {jobProgress && <span style={{ fontSize: 12, color: jobProgress.startsWith("Done") ? "var(--green)" : "var(--gold)", fontWeight: 600 }}>{jobProgress}</span>}
              </div>
              {jobResult && (
                <div className="panel" style={{ padding: 12, marginTop: 12, background: jobResult.ok ? "#0E1606" : "#1A0E0E", borderColor: jobResult.ok ? "var(--green)" : "var(--red)" }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: jobResult.ok ? "var(--green)" : "var(--red)", marginBottom: 6 }}>{jobResult.ok ? "Job completed" : "Job error"}</div>
                  <pre style={{ fontSize: 10.5, whiteSpace: "pre-wrap", wordBreak: "break-word", margin: 0, color: "var(--mut)", maxHeight: 220, overflow: "auto" }}>{JSON.stringify(jobResult.detail || jobResult.error, null, 2)}</pre>
                </div>
              )}
              <div className="mut" style={{ fontSize: 11, marginTop: 8 }}>After it finishes, hard-refresh the app and reconnect your league to see the updated board.</div>
            </div>

            {/* DATABASE STORAGE — diagnose and reclaim disk. With a few users, storage pressure is the harvest pool. */}
            <div className="panel" style={{ padding: 16, gridColumn: "1 / -1" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 6 }}>
                <div className="disp" style={{ fontSize: 16, fontWeight: 700 }}>Database storage</div>
                <button className="btn btn-mini" disabled={dbBusy} onClick={loadDbSize}><i className="ti ti-refresh" style={{ fontSize: 13, marginRight: 4 }} aria-hidden="true" />Check size</button>
              </div>
              <div className="mut" style={{ fontSize: 12.5, lineHeight: 1.55, marginBottom: 10 }}>
                Storage pressure here is almost never about users — a few accounts take almost no space. It's the
                <b style={{ color: "var(--ink)" }}> harvested-draft ADP pool</b>, which grows on every harvest pass. Your actual ADP numbers live in a
                separate table and are unaffected by cleanup, so trimming old raw picks is safe and frees space without touching the board.
              </div>
              {dbSize && dbSize.loading && <div className="mut" style={{ fontSize: 12 }}>Reading database size…</div>}
              {dbSize && dbSize.error && <div style={{ fontSize: 12, color: "var(--red)" }}>Couldn't read size: {dbSize.error}</div>}
              {dbSize && dbSize.total && (
                <>
                  <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginBottom: 10 }}>
                    <div><div className="num" style={{ fontSize: 22, fontWeight: 800 }}>{dbSize.total.size}</div><div className="mut" style={{ fontSize: 10.5 }}>total database size</div></div>
                    {dbSize.adp_observations && <div><div className="num" style={{ fontSize: 22, fontWeight: 800, color: "var(--gold)" }}>{Number(dbSize.adp_observations.harvest_rows || 0).toLocaleString()}</div><div className="mut" style={{ fontSize: 10.5 }}>harvested pick rows</div></div>}
                  </div>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, marginBottom: 12 }}>
                    <thead><tr>{["Table", "Size", "≈ rows"].map((h) => <th key={h} style={{ textAlign: h === "Table" ? "left" : "right", color: "var(--mut)", fontWeight: 500, paddingBottom: 5 }}>{h}</th>)}</tr></thead>
                    <tbody>
                      {(dbSize.tables || []).slice(0, 8).map((t) => (
                        <tr key={t.table} style={{ borderTop: "1px solid var(--line)" }}>
                          <td style={{ padding: "5px 0" }}>{t.table}</td>
                          <td style={{ padding: "5px 0", textAlign: "right" }} className="num">{t.size}</td>
                          <td style={{ padding: "5px 0", textAlign: "right" }} className="num mut">{Number(t.approx_rows || 0).toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <button className="btn btn-gold" disabled={dbBusy} onClick={() => cleanupDb(45)}>{dbBusy ? "Cleaning…" : "Free space — keep last 45 days"}</button>
                    <button className="btn" disabled={dbBusy} onClick={() => cleanupDb(21)}>{dbBusy ? "Cleaning…" : "Aggressive — keep last 21 days"}</button>
                    <span className="mut" style={{ fontSize: 11 }}>Deletes only old raw harvest picks. ADP numbers recompute on the next refresh.</span>
                  </div>
                </>
              )}
            </div>
            <div className="panel" style={{ padding: 16, gridColumn: "1 / -1" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 6 }}>
                <div className="disp" style={{ fontSize: 16, fontWeight: 700 }}>Draft Trends pool <span className="mut" style={{ fontSize: 12 }}>harvested real drafts</span></div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button className="btn btn-mini" disabled={busy} onClick={loadTrendsDiag}><i className="ti ti-refresh" style={{ fontSize: 13, marginRight: 4 }} aria-hidden="true" />Refresh stats</button>
                  <button className="btn btn-mini" disabled={busy} onClick={async () => { await runJob("harvest-more"); loadTrendsDiag(); }} title="Harvest another batch onto the existing pool. Click repeatedly to grow it.">+ Harvest more</button>
                  <button className="btn btn-mini" disabled={busy} onClick={async () => { if (!window.confirm("Rebuild clears the pool and re-harvests a fresh batch (correctly tagged). You can then click '+ Harvest more' to grow it. Proceed?")) return; await runJob("rebuild-trends"); loadTrendsDiag(); }}>Rebuild pool</button>
                </div>
              </div>
              <div className="mut" style={{ fontSize: 12.5, lineHeight: 1.55, marginBottom: 10 }}>This pool powers the "How the field drafts" tables. It harvests automatically — a little after each deploy if empty, and every night at 4 AM — so you never have to run it by hand. The numbers below are just a health check.</div>
              {!trendsDiag && <div className="mut" style={{ fontSize: 12 }}>Loading pool stats…</div>}
              {trendsDiag && trendsDiag.waking && <div style={{ fontSize: 12, color: "var(--gold)" }}>Waking the server… this takes up to a minute on the first request.</div>}
              {trendsDiag && trendsDiag.error && <div style={{ fontSize: 12, color: "var(--red)" }}>Couldn't load: {trendsDiag.error}</div>}
              {trendsDiag && !trendsDiag.error && (
                <>
                  <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginBottom: 10 }}>
                    <div><div className="num" style={{ fontSize: 22, fontWeight: 800, color: trendsDiag.harvestedDrafts > 0 ? "var(--green)" : "var(--gold)" }}>{(trendsDiag.harvestedDrafts || 0).toLocaleString()}</div><div className="mut" style={{ fontSize: 10.5 }}>drafts in pool</div></div>
                    <div><div className="num" style={{ fontSize: 22, fontWeight: 800 }}>{(trendsDiag.harvestObservations?.players || 0).toLocaleString()}</div><div className="mut" style={{ fontSize: 10.5 }}>players covered</div></div>
                    <div><div className="num" style={{ fontSize: 22, fontWeight: 800 }}>{(trendsDiag.draftsByFormat?.length || 0)}</div><div className="mut" style={{ fontSize: 10.5 }}>formats</div></div>
                    <div><div className="num" style={{ fontSize: 13, fontWeight: 700, marginTop: 6 }}>{trendsDiag.lastHarvestedAt ? new Date(trendsDiag.lastHarvestedAt).toLocaleString() : "never"}</div><div className="mut" style={{ fontSize: 10.5 }}>last harvest</div></div>
                  </div>
                  {trendsDiag.harvestedDrafts === 0 && <div style={{ fontSize: 11.5, color: "var(--gold)", marginBottom: 8 }}>Pool is empty — it will fill automatically within a minute of the next deploy/boot, or at 4 AM. You can also force it now with Full refresh above.</div>}
                  {trendsDiag.draftsByFormat && trendsDiag.draftsByFormat.length > 0 && (
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ borderCollapse: "collapse", fontSize: 11.5, minWidth: 320 }}>
                        <thead><tr className="mut" style={{ fontSize: 10, textTransform: "uppercase" }}><th style={{ textAlign: "left", padding: "0 10px 4px 0" }}>Format</th><th className="num" style={{ textAlign: "right", padding: "0 10px 4px" }}>Drafts</th><th className="num" style={{ textAlign: "right", padding: "0 0 4px" }}>Picks</th></tr></thead>
                        <tbody>
                          {trendsDiag.draftsByFormat.slice(0, 15).map((f) => (
                            <tr key={f.format_key} style={{ borderTop: "1px solid var(--line)" }}><td style={{ padding: "3px 10px 3px 0", fontFamily: "monospace" }}>{f.format_key}</td><td className="num" style={{ textAlign: "right", padding: "3px 10px", fontWeight: 700 }}>{f.drafts.toLocaleString()}</td><td className="num mut" style={{ textAlign: "right", padding: "3px 0" }}>{(f.picks || 0).toLocaleString()}</td></tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default Admin;
