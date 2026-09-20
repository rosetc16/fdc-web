/* ═══════════════════════════════════════════════════════════════════════════════════════════════════
   STATE CODEC — shrinking the saved blob without changing a single thing that reads it
   ───────────────────────────────────────────────────────────────────────────────────────────────────
   Trey: "I'm not sure if all the mock drafts are going to crash the site or cost a ton in storage… I'm
   doing 20 mocks per draft, but I'm starting to worry about storage cost if everyone does that for every
   league, but I also don't really know the impact."

   MEASURED FIRST, on a realistic 12-team / 16-round mock:

       whole saved entry   8.7 KB
         picks   (ids)     0.7 KB
         preds   (ids)     0.7 KB
         pickNames         3.6 KB   ┐
         predNames         3.6 KB   ┘ 82% of the entry is name strings

       6 leagues x 50 mocks  ->  2.55 MB, which is 64% of the backend's 4 MB per-user cap

   So the answer to "will this cost a ton" is: the mocks themselves are cheap, and the repair data attached
   to them is not. And it is worse than a storage bill, because the whole blob is ONE row rewritten on every
   save — a heavy user was on course to hit the cap and start getting writes rejected mid-draft.

   WHY THE NAMES ARE THERE, AND WHY THEY DO NOT NEED TO BE STORED PER PICK.
   A pick is saved as an index into the player pool, so when a new data pack reorders that pool every index
   points at a different man. `pickNames` is the repair: the name is what the pick is re-resolved against.
   It cannot simply be dropped — that is the corruption users reported in 29y.
   But `pickNames[i]` is, by construction, the name of `picks[i]` at the moment of saving. The pairs are a
   FUNCTION from id to name, and a league's twenty mocks draft the same few hundred players over and over.
   So one id→name table per league replaces twenty duplicate copies of the same strings, and every name
   survives exactly as before.

   ⚠ THE ONE CASE THAT BREAKS THE FUNCTION is the very case names exist for: mocks saved either side of a
     data pack change can legitimately disagree about who id 12 is. So the table takes the majority reading
     and any mock that disagrees with it KEEPS ITS OWN ARRAYS. Correctness first; the compression is what
     is left over.

   Everything above happens at the storage boundary only. Nothing in the app sees a packed mock: unpack
   restores `pickNames`/`predNames` byte-for-byte before the state reaches React, so no reader changed.
   ═══════════════════════════════════════════════════════════════════════════════════════════════════ */

// Marks a mock whose names come from its league's table. Short on purpose — it is written once per mock.
const FROM_TABLE = "nz";
const TABLE = "nt";

const namesFor = (ids, table) =>
  (ids || []).map((id) => (id != null && table[id] != null ? table[id] : null));

// Does this mock's stored names match what the shared table would produce? Only then can they be dropped.
function agreesWithTable(ids, names, table) {
  if (!Array.isArray(names)) return true;              // nothing stored — nothing to check
  if (!Array.isArray(ids) || ids.length !== names.length) return false;
  for (let i = 0; i < ids.length; i++) {
    const want = ids[i] != null && table[ids[i]] != null ? table[ids[i]] : null;
    const have = names[i] == null ? null : names[i];
    if (want !== have) return false;
  }
  return true;
}

function buildTable(mocks) {
  // id -> { name -> times seen }. Majority wins, so one odd mock from an older pack cannot drag the table.
  const freq = new Map();
  const scan = (ids, names) => {
    if (!Array.isArray(ids) || !Array.isArray(names)) return;
    const n = Math.min(ids.length, names.length);
    for (let i = 0; i < n; i++) {
      const id = ids[i], nm = names[i];
      if (id == null || !nm) continue;
      let m = freq.get(id);
      if (!m) { m = new Map(); freq.set(id, m); }
      m.set(nm, (m.get(nm) || 0) + 1);
    }
  };
  (mocks || []).forEach((m) => { if (!m) return; scan(m.picks, m.pickNames); scan(m.preds, m.predNames); });
  if (!freq.size) return null;
  const table = {};
  freq.forEach((m, id) => {
    let best = null, bc = -1;
    m.forEach((c, nm) => { if (c > bc) { bc = c; best = nm; } });
    table[id] = best;
  });
  return table;
}

function packMocks(mocks, table) {
  return (mocks || []).map((m) => {
    if (!m || (!m.pickNames && !m.predNames)) return m;
    if (!agreesWithTable(m.picks, m.pickNames, table) || !agreesWithTable(m.preds, m.predNames, table)) return m;
    const { pickNames, predNames, ...rest } = m;
    return { ...rest, [FROM_TABLE]: 1 };
  });
}

function unpackMocks(mocks, table) {
  return (mocks || []).map((m) => {
    if (!m || !m[FROM_TABLE]) return m;
    const { [FROM_TABLE]: _flag, ...rest } = m;
    /* Rebuild in the original key order — names go straight back after `preds`, which is where saveMock
       writes them. Byte-identical output is not cosmetic: it lets the round-trip test assert plain string
       equality, which is the strictest statement of "this codec loses nothing" available. */
    const out = {};
    let placed = false;
    const put = () => {
      if (placed) return;
      placed = true;
      if (Array.isArray(m.picks)) out.pickNames = namesFor(m.picks, table || {});
      if (Array.isArray(m.preds)) out.predNames = namesFor(m.preds, table || {});
    };
    Object.keys(rest).forEach((k) => { out[k] = rest[k]; if (k === "preds") put(); });
    put();
    return out;
  });
}

/* Compress a state blob for storage. Safe to call on an already-packed blob (packing is idempotent:
   a mock with no name arrays is left exactly as it is). */
export function packState(state) {
  if (!state || typeof state !== "object") return state;
  const out = { ...state };
  if (Array.isArray(state.leagues)) {
    out.leagues = state.leagues.map((l) => {
      if (!l || !Array.isArray(l.mocks) || !l.mocks.length) return l;
      const table = buildTable(l.mocks);
      if (!table) return l;
      const mocks = packMocks(l.mocks, table);
      // Only keep the table if it is actually paying for itself — a league where every mock disagreed
      // would otherwise carry a few kilobytes of dictionary that nothing points at.
      if (!mocks.some((m) => m && m[FROM_TABLE])) return l;
      return { ...l, [TABLE]: table, mocks };
    });
  }
  if (Array.isArray(state.funMocks) && state.funMocks.length) {
    const table = buildTable(state.funMocks);
    if (table) {
      const mocks = packMocks(state.funMocks, table);
      if (mocks.some((m) => m && m[FROM_TABLE])) { out.funMocks = mocks; out.funNt = table; }
    }
  }
  return out;
}

/* Restore a state blob read from storage. Tolerant by design: a blob written by an older build has no
   tables and no flags, and passes through untouched. */
export function unpackState(state) {
  if (!state || typeof state !== "object") return state;
  const out = { ...state };
  if (Array.isArray(state.leagues)) {
    out.leagues = state.leagues.map((l) => {
      if (!l || !Array.isArray(l.mocks) || !l.mocks.length) return l;
      if (!l[TABLE]) return l;
      const { [TABLE]: table, ...rest } = l;
      return { ...rest, mocks: unpackMocks(l.mocks, table) };
    });
  }
  if (Array.isArray(state.funMocks) && state.funNt) {
    out.funMocks = unpackMocks(state.funMocks, state.funNt);
    delete out.funNt;
  }
  return out;
}

/* For the diagnostics panel and the tests: how big is this blob, and how much did packing save? */
export function stateFootprint(state) {
  const raw = JSON.stringify(state || {}).length;
  const packed = JSON.stringify(packState(state || {})).length;
  const mocks = (Array.isArray(state && state.leagues) ? state.leagues : []).reduce((n, l) => n + ((l && l.mocks) || []).length, 0)
    + ((state && state.funMocks) || []).length;
  return { raw, packed, saved: raw - packed, pct: raw ? Math.round(((raw - packed) / raw) * 100) : 0, mocks };
}
