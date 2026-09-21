/* ═══════════════════════════════════════════════════════════════════════════════════════════════════
   WHAT A PLAYER HAS ACTUALLY DONE — 29be
   ───────────────────────────────────────────────────────────────────────────────────────────────────
   Trey: "For the trade calculator... is the projected points of value taking into account what they have
   already done this season? I just want to make sure it's as dynamic as possible with changing values
   weekly."

   It was not. Every season-level number in the app — trade values, trade ideas, power rankings, free-agent
   value — was Sleeper's full-season PROJECTION, refreshed once a day, blind to the scoreboard. A receiver
   averaging 19 a game against a 12-point projection was still valued at 12 in week 9.

   ⭐⭐⭐⭐⭐ THE MODEL: A PROJECTION IS EVIDENCE WORTH A FIXED NUMBER OF GAMES. The player's value per game is
     a weighted average of his projected rate and his actual rate, where actual games count one each and
     the projection counts as `FORM_PRIOR_GAMES` (6):

         rate = (gamesPlayed × actualPerGame + 6 × projectedPerGame) / (gamesPlayed + 6)

     Week 2 (1 game): the projection still carries 86% — one big game is not a new player.
     Week 7 (6 games): half and half.
     Week 13 (12 games): actual carries two thirds.
     ⚠ WHY A PRIOR AND NOT JUST THE ACTUAL AVERAGE: fantasy points are noisy — two touchdowns on four
       catches is a 20-point week that says little about next week. Replacing the projection outright
       would have the trade finder chasing every fluke; ignoring actuals (what shipped until now) has it
       blind to real role changes. Six games is where a season's sample starts to outweigh a preseason
       model for most positions; it is one constant, named, and easy to move.
   ⭐ IT STAYS ON THE 17-GAME SCALE the whole app already speaks (`rate × 17`), so no consumer changes: the
     calculator, the finder, the power table and the free-agent list all read the same field they always
     did, and it now moves every week.

   ⚠ BOTH RATES ARE SCORED BY THE SAME FUNCTION WITH THE SAME LEAGUE SETTINGS. The actual line is summed
     raw stats (the backend translates Sleeper's keys through the player pack's own mapper), scaled to 17
     games, and handed to the app's scorer — exactly what happens to the projection. Using Sleeper's
     pre-summed pts_ppr instead would have scored actuals on default rules and projections on the
     league's, and every TE-premium or per-carry league would have shown a phantom "form" swing.
   ⚠ VBD IS A SURPLUS — the 29bb lesson again. A change of Δ season points shifts vbd by exactly Δ; it is
     never a multiply, which would flip sign for below-replacement players.

   Pure, imports nothing, the scorer is injected. `node src/form.js --test` runs the suite at the bottom.
   ══════════════════════════════════════════════════════════════════════════════════════════════════ */

export const FORM_PRIOR_GAMES = 6;
/* A dynasty asset's value moves with a breakout too — a year of production is real information about a
   young player — but by less than one season's points, since dynasty value is about several seasons. */
export const FORM_DYN_SHARE = 0.5;

const r1 = (v) => Math.round(v * 10) / 10;

/* Scale a summed stat line to `factor` × its size. Every scorer input is a count or a total, so a linear
   scale is exact — including points allowed for a defense, which the scorer reads as a season total. */
export function scaleLine(s, factor) {
  const out = {};
  Object.keys(s || {}).forEach((k) => {
    const v = Number(s[k]);
    if (Number.isFinite(v)) out[k] = v * factor;
  });
  return out;
}

/**
 * @param base   a pool entry: { pos, pts (season projection, league scoring), vbd, vbd0, value, floor, ceil }
 * @param rec    this player's season-to-date record from the backend: { gp, s: { summed engine stats } }
 * @param opts   { score: (pos, stats) => season points in league scoring, games = 17, prior = 6 }
 * @returns      { gp, actualPg, projPg, pg, seasonPts } or null when there is nothing to blend
 */
export function formRates(base, rec, opts) {
  const o = opts || {};
  const games = o.games || 17;
  const prior = o.prior != null ? o.prior : FORM_PRIOR_GAMES;
  if (!base || !rec || !(Number(rec.gp) > 0) || typeof o.score !== "function") return null;
  const gp = Number(rec.gp);
  const actualSeason = Number(o.score(base.pos, scaleLine(rec.s || {}, games / gp))) || 0;
  const actualPg = actualSeason / games;
  const projPg = (Number(base.pts) || 0) / games;
  const pg = (gp * actualPg + prior * projPg) / (gp + prior);
  return { gp, actualPg: r1(actualPg), projPg: r1(projPg), pg: r1(pg), seasonPts: pg * games };
}

/* The blended copy of a pool entry. Returns `base` untouched when there is no record — never a copy that
   merely looks different, so a player with no games keeps exactly his projection. */
export function applyFormToEntry(base, rec, opts) {
  const f = formRates(base, rec, opts);
  if (!f) return base;
  const o = opts || {};
  const pts0 = Number(base.pts) || 0;
  const pts1 = Math.round(f.seasonPts);
  const delta = pts1 - pts0;
  const out = { ...base, pts: pts1 };
  if (base.vbd != null) out.vbd = r1(base.vbd + delta);
  if (base.vbd0 != null) out.vbd0 = r1(base.vbd0 + delta);
  if (pts0 > 0) {
    const k = pts1 / pts0;
    if (base.floor != null) out.floor = r1(base.floor * k);
    if (base.ceil != null) out.ceil = r1(base.ceil * k);
  }
  if (o.dynasty) {
    if (base.value != null) out.value = r1(base.value + delta * FORM_DYN_SHARE);
  } else if (out.vbd != null) {
    out.value = out.vbd;   // redraft defines value as vbd; keep them in lockstep
  }
  out.formGp = f.gp;
  out.formActualPg = f.actualPg;
  out.formProjPg = f.projPg;
  out.formPg = f.pg;
  out.formDelta = delta;
  return out;
}

/* ═══ TESTS ═══ `ok` THROWS (see injuries.js for why every printer in this repo does). */
export function formTest() {
  let n = 0;
  const ok = (c, m) => { n++; if (!c) throw new Error(`FAIL: ${m}`); console.log(`  ok  ${m}`); };
  const near = (a, b, e, m) => ok(Math.abs(a - b) <= (e == null ? 0.06 : e), `${m} (${a} ≈ ${b})`);
  /* A toy scorer: one point per `x`. Exactly linear, so the arithmetic is checkable by hand. */
  const score = (pos, s) => Number(s.x) || 0;
  const O = { score };
  const wr = { pos: "WR", pts: 204, vbd: 40, vbd0: 40, value: 40, floor: 160, ceil: 260 };   // 12.0/g projected

  // ---- the rate ----
  const hot6 = formRates(wr, { gp: 6, s: { x: 6 * 18 } }, O);                                 // 18/g actual
  near(hot6.actualPg, 18, 0.01, "six games at 18 a game read as 18 a game");
  near(hot6.pg, 15, 0.01, "after six games the projection and the actual rate weigh the same: (6×18 + 6×12)/12 = 15");
  const hot1 = formRates(wr, { gp: 1, s: { x: 30 } }, O);
  near(hot1.pg, (30 + 6 * 12) / 7, 0.06, "one 30-point game moves him only a seventh of the way — one big week is not a new player");
  const hot12 = formRates(wr, { gp: 12, s: { x: 12 * 18 } }, O);
  ok(hot12.pg > hot6.pg && hot6.pg > hot1.pg - 5, "the more games he has played, the more the actual rate counts");
  ok(formRates(wr, { gp: 0, s: { x: 0 } }, O) === null, "no games played: nothing to blend");
  ok(formRates(wr, null, O) === null, "no record: nothing to blend");

  /* ⚠⚠ A DUD WEEK THAT COUNTS. 12 points in two games is 6 a game, not 12 — the backend counts an active
     zero as a game, and the rate must divide by it. */
  near(formRates(wr, { gp: 2, s: { x: 12 } }, O).actualPg, 6, 0.01, "a zero week pulls the average down");

  // ---- the entry ----
  const e = applyFormToEntry(wr, { gp: 6, s: { x: 6 * 18 } }, O);
  ok(e.pts === 255, `season value becomes 15/g × 17 = 255 (${e.pts})`);
  ok(e.vbd === 40 + (255 - 204), `and VBD shifts by exactly the same ${255 - 204} points (${e.vbd})`);
  ok(e.value === e.vbd, "redraft value stays equal to vbd");
  ok(e.formGp === 6 && e.formPg === 15, "and the entry says what it did, for the hover");

  /* ⚠⚠⚠ THE SURPLUS RULE FROM 29bb, AGAIN. A below-replacement player who is scoring LESS than projected
     must lose value — a multiply on his negative VBD would make him look better. */
  const scrub = { pos: "RB", pts: 68, vbd: -30, vbd0: -30, value: -30 };                       // 4/g
  const cold = applyFormToEntry(scrub, { gp: 6, s: { x: 6 } }, O);                               // 1/g
  ok(cold.vbd < scrub.vbd, `a cold below-replacement player gets WORSE (${scrub.vbd} → ${cold.vbd}), never better`);
  const colder = applyFormToEntry(wr, { gp: 6, s: { x: 6 * 6 } }, O);
  ok(colder.pts < wr.pts && colder.vbd < wr.vbd, "a starter scoring half his projection loses value");

  // ---- dynasty ----
  const d = applyFormToEntry(wr, { gp: 6, s: { x: 6 * 18 } }, { ...O, dynasty: true });
  ok(d.value === 40 + (255 - 204) * FORM_DYN_SHARE, `dynasty value moves by half the season delta (${d.value})`);
  ok(d.vbd === e.vbd, "while this season's VBD moves by all of it");

  // ---- an unprojected breakout ----
  const nobody = { pos: "WR", pts: 0, vbd: -60, vbd0: -60, value: -60 };
  const breakout = applyFormToEntry(nobody, { gp: 4, s: { x: 4 * 15 } }, O);
  ok(breakout.pts > 0 && breakout.vbd > nobody.vbd, `a player the projection ignored gets credit for what he is doing (${breakout.pts} season pts)`);

  // ---- no mutation, and untouched when nothing is known ----
  const before = JSON.stringify(wr);
  applyFormToEntry(wr, { gp: 6, s: { x: 6 * 18 } }, O);
  ok(JSON.stringify(wr) === before, "the shared pool entry is never mutated");
  ok(applyFormToEntry(wr, null, O) === wr, "with no record the SAME object comes back — the projection stands exactly");

  // ---- scaling ----
  const sc = scaleLine({ passYd: 500, passTD: 3, pa: 40 }, 17 / 2);
  near(sc.passYd, 4250, 0.01, "a two-game line scales to a 17-game one");
  near(sc.pa, 340, 0.01, "points allowed scale like everything else, so a defense is scored on its season shape");

  console.log(`\n${n} checks PASS`);
  return n;
}

try {
  if (typeof process !== "undefined" && process.argv && process.argv.some((a) => a === "--test")) formTest();
} catch (e) {
  try { console.error(String((e && e.stack) || e)); } catch (_) {}
  try { if (typeof process !== "undefined" && process.exit) process.exit(1); } catch (_) {}
}
