/* ═══════════════════════════════════════════════════════════════════════════════════════════════════
   WHAT AN INJURY DOES TO A LEAGUE — 29bb
   ───────────────────────────────────────────────────────────────────────────────────────────────────
   Trey, the morning after: "Jayden Daniels just got hurt and likely missing most/all of the rest of the
   year. In real time, we are looking for trades that could improve the team given this injury. Is it
   possible to have an 'Injury' tab in the league hub where you could define if the player is going to
   miss the whole year, significant time, etc... then it would cascade to the rest of the league outlook
   (power rankings, trade tab, trade calculators, helping find trade ideas, etc.). You can save the
   injuries... then you can revert them back or edit them in real time."

   ⭐⭐⭐⭐⭐ THE WHOLE FEATURE IS ONE NUMBER APPLIED IN ONE PLACE. An injury is not a badge and it is not
     a filter — it is a claim that a player will produce LESS FOOTBALL between now and the end of the
     regular season, and every screen in this app is ultimately a function of how much football each
     roster will produce. So the only honest implementation is to discount the player's VALUE at the
     point where an id becomes a valued player, and let every consumer inherit it without knowing this
     feature exists. Power rankings, positional strength, the trade calculator, the trade finder, the
     partner board, playoff odds, close calls, the lineup — none of them are touched, and all of them
     move. Anything else means maintaining a list of screens to remember, and that list is always wrong.

   ⚠⚠⚠⚠ THE TRAP THAT WOULD HAVE MADE THIS SILENTLY BACKWARDS — VBD IS A SURPLUS, NOT A QUANTITY.
     The obvious implementation is `p.vbd *= factor`. It is wrong, and wrong in the worst direction:
     `vbd` is points ABOVE a replacement-level baseline and is NEGATIVE for most of the pool. Multiplying
     −40 by 0.2 gives −8, so scaling a bench player's VBD by an injury factor makes him look FOUR TIMES
     BETTER for being hurt. Half the league's rosters would have gained power from an injury.
     ⭐ THE CORRECT TRANSFORM FALLS OUT OF THE DEFINITION. vbd = pts − baseline. If production goes to
       pts·f then vbd goes to pts·f − baseline = vbd − pts·(1−f). The baseline never has to be known: it
       cancels. It is exact, it is monotone, and it drives a zero-production player to −baseline (worth
       exactly what an empty roster spot is worth) rather than to zero. See `injTest` for the case that
       catches the multiply.

   ⚠⚠⚠ AND DYNASTY MUST NOT INHERIT THE REDRAFT DISCOUNT. A quarterback out for the year is worth almost
     nothing in a redraft league and is still a franchise asset in a dynasty one — the same fact, two
     honest answers. Applying the redraft factor to a dynasty league would have this feature confidently
     tell Trey to sell a 24-year-old franchise QB for pennies, in the exact league where that is the most
     expensive mistake available. Dynasty value therefore takes a fraction of the hit (`DYN_SHARE`),
     applied to the SURPLUS in the same shape the age curve uses (shrink a positive, deepen a negative),
     because `value` in dynasty is an ADP-blended composite and not a points quantity at all.

   ⚠ WEEKS ARE COUNTED AGAINST WHAT IS LEFT, NOT AGAINST 17. "Out four weeks" in week 3 costs a third of
     the season; the identical words in week 12 end the season. The same entry therefore has to mean
     different things in October and December, which is why `weeksLeft` is an argument and not a constant.

   ⚠ THIS FILE IS PURE AND IMPORTS NOTHING. That is deliberate: `App.jsx` is 43k lines and cannot be run
     by node, so anything that lives in it can only ever be tested through a browser. The arithmetic that
     decides whether a screen gives good or bad advice belongs somewhere a test can reach in 30ms.
     `node src/injuries.js --test` runs the suite at the bottom.
   ══════════════════════════════════════════════════════════════════════════════════════════════════ */

/* The vocabulary, in Trey's words. `weeks` is the "significant time" case and carries an editable N. */
export const INJ_SEASON = "season";
export const INJ_WEEKS = "weeks";
export const INJ_LIMITED = "limited";

export const INJ_CHOICES = [
  { status: INJ_SEASON, label: "Out for the season", short: "OUT (yr)", hint: "Done for the year — IR, surgery, season-ending." },
  { status: INJ_WEEKS, label: "Out a few weeks", short: "OUT", hint: "Missing significant time, then back. Set how many weeks." },
  { status: INJ_LIMITED, label: "Playing limited", short: "LTD", hint: "Active but not himself — snap count, a brace, working back." },
];

/* How much of a healthy week a "limited" player is actually worth. A hedge, deliberately mild: `limited`
   is the status people reach for when they are unsure, and an unsure status must not move a roster far. */
export const LIMITED_RATE = 0.7;

/* ⭐⭐⭐⭐ HOW MUCH OF THE REDRAFT HIT A DYNASTY ASSET TAKES. Out-for-the-year costs a redraft manager
   100% of what is left and a dynasty manager roughly a quarter of the asset — one season out of the four
   or five he is being valued over, plus a real but not catastrophic re-injury discount. Dynasty markets
   in practice move an injured young stud far less than this; 0.25 is chosen to be on the honest side of
   conservative rather than to match any particular trade calculator on the internet. */
export const DYN_SHARE = 0.25;

/* Round the way the rest of the app rounds, so a discounted number and an undiscounted one printed side
   by side agree to the same place. */
const r1 = (v) => Math.round(v * 10) / 10;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/* ⚠ TOLERANT BY DESIGN. Entries come out of a synced JSON blob that a different build may have written,
   and a malformed one must degrade to "healthy" rather than throw inside a roster resolver that every
   screen in the hub is downstream of. */
export function normalizeInjury(entry) {
  if (!entry || typeof entry !== "object") return null;
  const status = entry.status === INJ_SEASON || entry.status === INJ_WEEKS || entry.status === INJ_LIMITED
    ? entry.status : null;
  if (!status) return null;
  let weeks = Number(entry.weeks);
  if (!Number.isFinite(weeks) || weeks < 0) weeks = status === INJ_WEEKS ? 4 : 0;
  weeks = Math.min(30, Math.round(weeks));
  return {
    status,
    weeks,
    note: typeof entry.note === "string" ? entry.note.slice(0, 120) : "",
    at: Number.isFinite(Number(entry.at)) ? Number(entry.at) : null,
    /* The week the entry was SET in. "Out 4 weeks" recorded in week 3 still means "back in week 7" when
       read in week 5 — without this the countdown would restart every time the page loaded. */
    setWeek: Number.isFinite(Number(entry.setWeek)) ? Number(entry.setWeek) : null,
  };
}

/* How many of the REMAINING weeks this man is still expected to miss, as of `week`. */
export function weeksStillOut(entry, week) {
  const e = normalizeInjury(entry);
  if (!e) return 0;
  if (e.status === INJ_SEASON) return Infinity;
  if (e.status !== INJ_WEEKS) return 0;
  if (e.setWeek == null || !Number.isFinite(Number(week))) return e.weeks;
  const elapsed = Math.max(0, Number(week) - e.setWeek);
  return Math.max(0, e.weeks - elapsed);
}

/**
 * The two factors every consumer needs.
 *   prod  — the share of his remaining-season production he is still expected to deliver (0..1)
 *   week  — the share of THIS week's projection he is still expected to deliver (0..1)
 *   dyn   — the multiplier applied to a dynasty `value` surplus
 * @param {object} entry   a saved injury entry (or null)
 * @param {object} ctx     { weeksLeft, week, dynasty }
 */
export function injuryFactors(entry, ctx) {
  const e = normalizeInjury(entry);
  const weeksLeft = Math.max(1, Number((ctx && ctx.weeksLeft) || 1));
  if (!e) return { active: false, prod: 1, week: 1, dyn: 1, status: null, out: 0, label: "", short: "" };

  const out = weeksStillOut(e, ctx && ctx.week);
  let prod, wk;
  if (e.status === INJ_LIMITED) {
    prod = LIMITED_RATE;
    wk = LIMITED_RATE;
  } else {
    const missed = Math.min(weeksLeft, out === Infinity ? weeksLeft : out);
    prod = clamp01((weeksLeft - missed) / weeksLeft);
    wk = out > 0 ? 0 : 1;
  }
  /* ⚠ A `weeks` entry whose clock has run out is no longer an injury. It reports itself inactive so the
     UI can offer to clear it rather than leaving a badge on a healthy player forever. */
  const active = !(e.status === INJ_WEEKS && out <= 0);
  const lost = 1 - prod;
  return {
    active,
    prod: active ? prod : 1,
    week: active ? wk : 1,
    dyn: active && ctx && ctx.dynasty ? 1 - lost * DYN_SHARE : 1,
    status: e.status,
    out: out === Infinity ? null : out,
    label: injuryLabel(e, ctx),
    short: e.status === INJ_SEASON ? "OUT (yr)" : e.status === INJ_LIMITED ? "LTD" : `OUT ${out}w`,
  };
}

export function injuryLabel(entry, ctx) {
  const e = normalizeInjury(entry);
  if (!e) return "";
  if (e.status === INJ_SEASON) return "Out for the season";
  if (e.status === INJ_LIMITED) return "Playing limited";
  const out = weeksStillOut(e, ctx && ctx.week);
  if (out <= 0) return "Expected back";
  return out === 1 ? "Out 1 more week" : `Out ${out} more weeks`;
}

/**
 * ⭐⭐⭐⭐⭐ THE ONE FUNCTION BOTH VALUATION PATHS CALL. `resolve` in the hub and `leaguePower` reach a
 * valued player by different routes (weekly-then-undone vs straight off the pool), and they have to
 * agree — a power column that disagrees with itself across two screens is the exact fault 29y and 29aj
 * were both about. Handing them one transform is how they agree by construction.
 *
 * Returns a COPY. The pool is cached per format and shared across every league on the account; mutating
 * an entry here would leak one league's injuries into all of them.
 */
export function applyInjuryToEntry(base, entry, ctx) {
  if (!base) return base;
  const f = injuryFactors(entry, ctx);
  if (!f.active) return base;

  const pts = Number(base.pts) || 0;
  const lost = 1 - f.prod;
  const drop = pts * lost;                 // points of season production removed

  const out = { ...base };
  out.pts = r1(pts * f.prod);
  /* ⚠ THE SURPLUS TRANSFORM, NOT A MULTIPLY. See the header — a multiply flatters every below-
     replacement player on the board. `vbd0` is the redraft-basis surplus and takes the same shift: the
     baseline it is measured against is a different number but an equally constant one, so it cancels
     the same way. */
  if (base.vbd != null) out.vbd = r1(base.vbd - drop);
  if (base.vbd0 != null) out.vbd0 = r1(base.vbd0 - drop);
  if (base.floor != null) out.floor = r1(Number(base.floor) * f.prod);
  if (base.ceil != null) out.ceil = r1(Number(base.ceil) * f.prod);

  /* `value` is what the DYNASTY scorer reads, and in a redraft league it is defined as exactly `vbd`
     (see the `else` branch of the value model in App.jsx) — so redraft keeps the two in lockstep rather
     than inventing a third number, and dynasty takes the damped haircut on its surplus. */
  if (ctx && ctx.dynasty) {
    if (base.value != null) {
      const d = 1 - f.dyn;                 // 0..DYN_SHARE
      out.value = r1(base.value > 0 ? base.value * (1 - d) : base.value * (1 + d));
    }
  } else if (out.vbd != null) {
    out.value = out.vbd;
  }

  out.injStatus = f.status;
  out.injLabel = f.label;
  out.injShort = f.short;
  out.injProd = f.prod;
  out.injWeek = f.week;
  /* What the discount actually cost him, in the units the screen he lands on is printing. Kept so a
     tooltip can say "−48.2 season points" instead of asking the reader to trust that something moved. */
  out.injDropPts = r1(drop);
  return out;
}

/* A map keyed by Sleeper sid → normalized entry, dropping anything stale or malformed. The stored blob
   is the raw user record; this is what the valuation paths actually read. */
export function activeInjuryMap(injuries, ctx) {
  const out = {};
  if (!injuries || typeof injuries !== "object") return out;
  Object.keys(injuries).forEach((sid) => {
    const e = normalizeInjury(injuries[sid]);
    if (!e) return;
    if (!injuryFactors(e, ctx).active) return;
    out[String(sid)] = e;
  });
  return out;
}

/* Count for a tab badge — how many saved injuries are still biting. */
export function activeInjuryCount(injuries, ctx) {
  return Object.keys(activeInjuryMap(injuries, ctx)).length;
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════════════
   TESTS — `node src/injuries.js --test`
   ⚠ `ok` THROWS. A previous suite in this project (sim/wintone.js) printed a tick and returned, and
     passed 12/12 against a build that was broken — copied from a sibling file without the assert line.
     Every printer in this repo asserts now.
   ══════════════════════════════════════════════════════════════════════════════════════════════════ */
export function injTest() {
  let n = 0;
  const ok = (cond, msg) => {
    n++;
    if (!cond) throw new Error(`FAIL: ${msg}`);
    console.log(`  ok  ${msg}`);
  };
  const near = (a, b, eps, msg) => ok(Math.abs(a - b) <= (eps == null ? 0.05 : eps), `${msg} (${a} ≈ ${b})`);

  const CTX = { weeksLeft: 10, week: 5, dynasty: false };
  const DYN = { weeksLeft: 10, week: 5, dynasty: true };

  // ---- the factors themselves ----
  near(injuryFactors({ status: INJ_SEASON }, CTX).prod, 0, 0.001, "out for the year produces nothing");
  near(injuryFactors({ status: INJ_WEEKS, weeks: 5, setWeek: 5 }, CTX).prod, 0.5, 0.001, "out 5 of 10 remaining weeks = half");
  near(injuryFactors({ status: INJ_LIMITED }, CTX).prod, LIMITED_RATE, 0.001, "limited plays at the limited rate");
  ok(injuryFactors(null, CTX).prod === 1, "no entry means no discount");
  ok(injuryFactors({ status: "nonsense" }, CTX).prod === 1, "an unknown status means no discount");

  // ⚠ THE SAME WORDS, TWO MONTHS APART. "Out 4 weeks" must not mean the same thing in week 3 and week 12.
  const early = injuryFactors({ status: INJ_WEEKS, weeks: 4, setWeek: 3 }, { weeksLeft: 12, week: 3 });
  const late = injuryFactors({ status: INJ_WEEKS, weeks: 4, setWeek: 12 }, { weeksLeft: 3, week: 12 });
  ok(early.prod > late.prod, "four weeks out costs more of what is left in December than in September");
  near(late.prod, 0, 0.001, "four weeks out with three weeks left is the season");

  // ⚠ THE CLOCK RUNS. An entry set three weeks ago for a two-week absence is no longer an injury.
  ok(injuryFactors({ status: INJ_WEEKS, weeks: 2, setWeek: 3 }, { weeksLeft: 8, week: 6 }).active === false,
    "a weeks entry whose clock ran out reports itself inactive");
  ok(injuryFactors({ status: INJ_WEEKS, weeks: 2, setWeek: 3 }, { weeksLeft: 8, week: 6 }).prod === 1,
    "and stops discounting");
  near(weeksStillOut({ status: INJ_WEEKS, weeks: 4, setWeek: 3 }, 5), 2, 0.001, "two weeks elapsed off a four-week absence");

  /* ---- THIS WEEK, WHICH IS A SEPARATE QUESTION FROM THE SEASON ----
     ⚠ THIS BLOCK EXISTS BECAUSE THE SUITE DID NOT HAVE IT. A falsification that set `wk = 1` — i.e. an
       out-for-the-year quarterback still projecting a full game THIS SUNDAY, in the lineup, in close
       calls, in the start/sit — passed 31/31. The season factor was covered from three directions and
       the weekly one from none, which is the same shape of hole as every "the fixture cannot express the
       bug" finding in this project: the tested quantity was the one that was easy to reach. */
  ok(injuryFactors({ status: INJ_SEASON }, CTX).week === 0, "an out-for-year player projects 0.0 THIS WEEK");
  ok(injuryFactors({ status: INJ_WEEKS, weeks: 3, setWeek: 5 }, CTX).week === 0, "so does a man out the next three weeks");
  near(injuryFactors({ status: INJ_LIMITED }, CTX).week, LIMITED_RATE, 0.001, "a limited player is docked, not benched");
  ok(injuryFactors({ status: INJ_WEEKS, weeks: 2, setWeek: 1 }, { weeksLeft: 8, week: 6 }).week === 1,
    "and a man whose absence has ended plays a full week again");
  ok(injuryFactors(null, CTX).week === 1, "a healthy player is untouched this week");

  // ---- the transform ----
  const star = { name: "Star QB", pos: "QB", pts: 300, vbd: 90, vbd0: 90, value: 90, floor: 240, ceil: 360 };
  const gone = applyInjuryToEntry(star, { status: INJ_SEASON }, CTX);
  near(gone.pts, 0, 0.001, "an out-for-year star projects zero points");
  near(gone.vbd, 90 - 300, 0.001, "and his VBD falls to minus the baseline, not to zero");
  ok(gone.vbd < star.vbd, "his value went DOWN");
  ok(gone.injShort === "OUT (yr)", "and he is flagged");

  /* ⚠⚠⚠⚠⚠ THE CASE THAT CATCHES THE MULTIPLY. A below-replacement bench body has a NEGATIVE vbd, and
     `vbd *= factor` would move −40 to −8 — i.e. an injury would make him four times more valuable and
     lift the power rating of every roster holding one. This assertion is the whole reason the transform
     is a subtraction. Falsified by hand: replacing the two lines in `applyInjuryToEntry` with
     `out.vbd = r1(base.vbd * f.prod)` fails exactly here and nowhere else in this suite. */
  const scrub = { name: "Scrub", pos: "WR", pts: 60, vbd: -40, vbd0: -40, value: -40 };
  const hurtScrub = applyInjuryToEntry(scrub, { status: INJ_SEASON }, CTX);
  ok(hurtScrub.vbd < scrub.vbd, "a BELOW-replacement player also gets WORSE when hurt, never better");
  near(hurtScrub.vbd, -100, 0.001, "−40 minus the 60 points he will not score");

  // Monotonicity across the whole ladder — the property that makes the feature trustworthy at all.
  const ladder = [null, { status: INJ_LIMITED }, { status: INJ_WEEKS, weeks: 5, setWeek: 5 }, { status: INJ_SEASON }];
  [star, scrub].forEach((p) => {
    let prev = Infinity;
    ladder.forEach((e) => {
      const v = applyInjuryToEntry(p, e, CTX).vbd;
      ok(v <= prev + 0.001, `${p.name}: ${e ? e.status : "healthy"} is worth no more than the step before it`);
      prev = v;
    });
  });

  // ---- dynasty damping ----
  const dynGone = applyInjuryToEntry(star, { status: INJ_SEASON }, DYN);
  const redGone = applyInjuryToEntry(star, { status: INJ_SEASON }, CTX);
  ok(dynGone.value > redGone.value, "a dynasty asset out for the year keeps far more value than a redraft one");
  near(dynGone.value, 90 * (1 - DYN_SHARE), 0.001, "dynasty takes a damped share of the surplus");
  ok(dynGone.value > 0, "and an elite dynasty asset is still an asset");
  /* ⚠ THE NEGATIVE SIDE OF THE DYNASTY CURVE, same shape as the age model: an injury must DEEPEN a
     negative surplus, not shrink it — the identical inversion as the VBD multiply, one scale over. */
  const dynScrub = applyInjuryToEntry(scrub, { status: INJ_SEASON }, DYN);
  ok(dynScrub.value < scrub.value, "a below-replacement dynasty body also gets worse, not better");

  // ⚠ REDRAFT KEEPS `value` AND `vbd` IDENTICAL, because that is how the redraft value model defines it.
  ok(redGone.value === redGone.vbd, "redraft value stays exactly vbd after the discount");

  // ---- the map ----
  const map = activeInjuryMap({
    "1": { status: INJ_SEASON },
    "2": { status: INJ_WEEKS, weeks: 2, setWeek: 1 },   // expired by week 6
    "3": { status: "junk" },
  }, { weeksLeft: 8, week: 6 });
  ok(Object.keys(map).length === 1 && map["1"], "the map keeps only what is still biting");

  // ---- no mutation ----
  const before = JSON.stringify(star);
  applyInjuryToEntry(star, { status: INJ_SEASON }, DYN);
  ok(JSON.stringify(star) === before, "the shared pool entry is never mutated");

  console.log(`\n${n} checks PASS`);
  return n;
}

/* Run directly under node without dragging in a test framework. The `process` guard keeps this file a
   plain ES module in the browser bundle. */
try {
  if (typeof process !== "undefined" && process.argv && process.argv.some((a) => a === "--test")) injTest();
} catch (e) {
  try { console.error(String((e && e.stack) || e)); } catch (_) {}
  try { if (typeof process !== "undefined" && process.exit) process.exit(1); } catch (_) {}
}
