/* ⭐⭐⭐⭐⭐ WHY A TRADE EXISTS — 29af.
   ==================================================================================================
   Trey: "I basically want you to think about how to most easily identify the potential fits and players
   that are either undervalued, underappreciated, fit your team more than another team, or they come from
   an owner who's not utilizing their roster as well, or they just have depth or something. And I basically
   want you to make very simple suggestions on things that you think are realistic and improve your team
   dramatically… right now it's a little difficult to follow."

   THE PROBLEM WITH WHAT WAS THERE. `findTrades` enumerates every one-for-one swap and keeps the ones that
   raise both starting lineups. That is a sound filter and a poor recommendation: it produces a list of
   swaps ranked by a points number, with no statement of WHY any of them should happen and no view on
   whether the other manager would ever agree. A list like that is work, not advice — you still have to
   reconstruct the reasoning for every row before you can act on one, which is precisely "difficult to
   follow".

   ⭐ EVERY ITEM IN HIS SENTENCE IS A MEASURABLE THING, and this file measures them:

     • FIT — "fit your team more than another team". The central one, and the only one that is really a
       reason a trade happens at all. A player is worth what he ADDS TO A LINEUP, not what he scores, so
       the same man can be worth 40 points to me and 3 to his owner — he is their RB4 and he would be my
       RB2. `fitEdge` is exactly that difference, and a large one is a trade both sides can rationally
       want. Nothing else on this list can make a deal happen on its own.

     • DEPTH — "they just have depth". Startable bodies beyond the ones they must field. This is what makes
       a fit edge SAFE for them: giving away your fourth back costs you nothing you were using.

     • THE OWNER — "an owner who's not utilizing their roster as well". Measured two ways, neither of which
       is an insult. (1) Their roster GRADE against their actual POINTS SCORED: a roster that grades 2nd
       and has scored 8th-most is either being set badly or has been unlucky, and both make the manager
       more willing to move. (2) What they left on their own bench this week. ⚠ NEITHER IS STATED AS A
       VERDICT ON THE PERSON — see `ownerNote`; the app cannot see their injuries, their byes or their
       reasons, and a tool that calls somebody a bad manager on a week of data is wrong more often than it
       is useful. It says what it measured and lets him draw the conclusion.

     • UNDERVALUED / UNDERAPPRECIATED — two different things, kept apart because they license different
       arguments. A player their OWNER benches despite being startable is undervalued BY THEM, which is
       leverage. A player whose season production has outrun his DRAFT COST is undervalued BY THE MARKET,
       which is a reason he might be gettable cheap but says nothing about that owner.

   ⚠⚠ AND THE HALF EVERY TRADE TOOL SKIPS: WOULD THEY SAY YES. A recommendation nobody would accept is
     worse than no recommendation, because it spends the one thing you have with your league-mates, which
     is their patience. `realism` is built from what the other side gets, whether it fixes the position
     they are actually short at, and — the big negative — whether you are asking for the best player they
     own. 29r's "there is just no way they would do this" was exactly this quantity, missing.

   ⚠ PURE, AND THE LINEUP MATHS IS INJECTED. `lineupValue` and `lineupSlots` live in App.jsx with the rest
     of the engine; passing them in keeps this file testable without a browser and, more importantly, makes
     it impossible for this screen to grow its own second opinion about what a lineup is worth. The 29y
     power-ranking bug was two implementations of one quantity; this is that lesson applied in advance.
   ================================================================================================== */

const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10;

/* ⚠⚠ EVERY ROSTER IS CLEANED ONCE, AT THE DOOR. `lineupSlots` reads `p.pos` without guarding, so a single
   null or id-less entry anywhere in a payload throws inside the lineup maths — and by then the stack is
   five frames deep in something that looks like a valuation bug. 29ac hit exactly this when `costMapOf`
   started solving real lineups; the decision then was to clean at the caller rather than slow down the
   shared primitive, and this is that decision applied to a new caller.
   ⚠ It filters rather than repairs: a player with no position cannot be placed in a lineup, and inventing
     one for him would put a phantom in a starting slot. Dropping him understates the roster, which is the
     safe direction — it can only make a trade look worse than it is. */
/* ⚠⚠⚠ AND IT DROPS A REPEATED ID — b153, and this is the answer to a question Trey asked rather than a
   guess at one: "I don't think anything changed on my rankings process and no games happened.. but I went
   from 1 of 12 for WR to 2 of 12 on that last update."
   That is exactly what b152's duplicate fix had to do, and the arithmetic is worth writing down.
   `posValue` for a position is the sum of the best `req[pos]` men at it — so a roster listing one receiver
   TWICE (the "Deebo Samuel is listed twice" bug) counted his points in two of those slots. On a shape like
   his, first at receiver by a handful of points, removing the phantom drops the total below the next team
   and the rank moves by one. Nothing about the ranking changed; a number that had been too big since the
   duplicate appeared became right.
   ⭐ SO THE GUARD MOVES DOWN HERE AS WELL. b152 deduped in the hub, where the duplicated ROW was; this
     module is where the duplicated VALUE did its damage, and it should not depend on every caller getting
     it right. Two places, because they are two different failures with one cause. */
/* ⚠ A `function` DECLARATION, NOT A `const` ARROW — deliberately. Every sim suite and the shape probe
   lift named functions out of this file with a regex that matches `function name(`, and each of them had
   its OWN one-line copy of `clean` in the eval preamble precisely because an arrow could not be sliced.
   A hand-written copy of the thing under test is the 29v trap: it agrees with my expectations instead of
   with the app, and it would have silently kept the old no-dedupe behaviour in every suite. */
function clean(roster) {
  const seen = new Set();
  return (roster || []).filter((p) => {
    if (!p || p.sid == null || !p.pos) return false;
    const k = String(p.sid);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
   HOW EACH TEAM IN THE LEAGUE IS DOING WITH WHAT IT HAS.
   One pass over the league, before any swap is considered, because every reason below is a property of a
   ROSTER or a MANAGER rather than of a pair of players. Computing it per candidate pair would be both
   slower and — the part that matters — inconsistent, since the same team would be described differently
   on two different cards.
   ──────────────────────────────────────────────────────────────────────────────────────────────── */
export function teamReads(input) {
  const o = input || {};
  const teams = o.teams || [];
  const sf = o.sf;
  const req = o.req || {};
  const lineupValue = o.lineupValue;
  const repl = o.repl || {};
  if (!teams.length || typeof lineupValue !== 'function') return [];

  /* Points-for rank and roster-grade rank, so the two can be compared. Both are ranks rather than raw
     numbers on purpose: points-for is in season points and a roster grade is in arbitrary units, and the
     only honest comparison between two different scales is the ORDER they put the league in. */
  const byPF = teams.filter((t) => Number.isFinite(t.pointsFor)).slice().sort((a, b) => b.pointsFor - a.pointsFor);
  const pfRank = new Map(byPF.map((t, i) => [t.rosterId, i + 1]));
  const byGrade = teams.filter((t) => Number.isFinite(t.rosterScore)).slice().sort((a, b) => b.rosterScore - a.rosterScore);
  const gradeRank = new Map(byGrade.map((t, i) => [t.rosterId, i + 1]));

  const out = teams.map((t) => {
    const roster = clean(t.roster);
    /* Startable bodies per position: men worth more than this league's replacement level. ⚠ The same
       definition `positionMarket` and the trade calculator use — "above replacement", not "above zero" —
       because four replacement-level receivers are not depth however well their points add up. */
    const startable = {}, have = {};
    roster.forEach((p) => {
      const pos = String(p.pos || '').toUpperCase();
      if (!pos) return;
      have[pos] = (have[pos] || 0) + 1;
      if ((Number(p.pts) || 0) > (repl[pos] || 0)) startable[pos] = (startable[pos] || 0) + 1;
    });
    const surplus = {}, need = {};
    Object.keys(req).forEach((pos) => {
      const want = req[pos] || 0;
      if (!want) return;
      const got = startable[pos] || 0;
      if (got > want) surplus[pos] = got - want;
      if (got < want) need[pos] = want - got;
    });

    /* ⭐⭐⭐⭐⭐ WHAT THE POSITION IS WORTH TO THIS TEAM, WHICH IS THE READ THAT ACTUALLY MATCHES — 29ai.
       Trey: "I rank 10th of 12 in RBs... but it says I have +1 spare. Well, I suck at that position, so I
       probably don't have a spare." And: "I have no good RBs, but my WR are legit. I should be matching up
       with teams that have RB surplus and need WR."
       ⭐ HE IS DESCRIBING RANK, AND `surplus` WAS COUNTING BODIES. Three backs over a replacement line is
         "a spare" by headcount and can still be the worst running back room in the league — which is
         exactly the situation he is in, and the app cheerfully told him to go and sell one. Counting is
         the wrong question; where you sit against the other eleven is the right one, and it is the thing
         he said out loud both times.
       ⚠ AND IT IS THE ONLY MEASURE THAT SURVIVES WEEK 2. "Above replacement" is an absolute line, so two
         weeks into a season every roster in the league reads thin and NOTHING lines up with anybody — his
         other complaint, and the same cause. A RANK is relative: somebody is always first at running back
         and somebody is always last, in week 2 exactly as in week 12.
       `posValue` totals what a position PUTS IN THE LINEUP (the starters it fills, not the whole room —
       a fourth back nobody starts is not strength), and the caller ranks them league-wide below. */
    const posValue = {};
    Object.keys(req).forEach((pos) => {
      const want = req[pos] || 0;
      if (!want) return;
      const best = roster.filter((p) => String(p.pos || '').toUpperCase() === pos)
        .map((p) => Number(p.pts) || 0).sort((a, b) => b - a).slice(0, want);
      posValue[pos] = r1(best.reduce((x, y) => x + y, 0));
    });

    /* ⭐⭐⭐⭐ THE ROSTER-VS-RESULTS GAP. A team whose roster grades near the top and whose points sit near
       the bottom is the single best person in the league to open a conversation with: something is going
       wrong for them that a trade might fix, and they know it.
       ⚠ POSITIVE MEANS UNDERPERFORMING (grade better than results). Null when we cannot rank both, which
         is the off-season and the first week of any season — and a null must read as "no opinion" rather
         than as zero, or every team looks perfectly efficient before a ball is kicked. */
    const pf = pfRank.get(t.rosterId) || null;
    const gr = gradeRank.get(t.rosterId) || null;
    const gap = pf != null && gr != null ? pf - gr : null;

    /* What they left on their own bench THIS WEEK: the value of the lineup they actually set against the
       best one available to them. ⚠ MEASURED ON THE WEEK'S OWN POINTS, not season value — a manager who
       correctly benched a man on bye must not be scored as wasteful for it, and season value cannot tell
       the difference. `weekRoster`/`setStarters` are optional; without them this is simply null. */
    let benchWaste = null;
    if (Array.isArray(o.weekRosterOf ? o.weekRosterOf(t) : null) && Array.isArray(t.setStarters)) {
      const wk = o.weekRosterOf(t);
      const setIds = new Set(t.setStarters.map(String));
      const setPts = wk.filter((p) => setIds.has(String(p.sid))).reduce((s, p) => s + (Number(p.pts) || 0), 0);
      const best = lineupValue(wk, sf);
      const d = r1(best - setPts);
      // Under a point is inside the noise of a projection and is not a finding.
      benchWaste = d > 1 ? d : 0;
    }

    /* ⭐⭐⭐⭐⭐ WHAT THIS TEAM COULD ACTUALLY MOVE AT EACH POSITION — 29aj, and it retires "+1 spare".
       ==================================================================================================
       Trey, for the second time: "I'm still not sure the 'potential positional trade considerations' is
       actually working the way it should. The +Spare just feels like not the best way to determine this...
       especially since this league has a flex position."

       ⚠⚠ THE FLEX IS NOT A DETAIL, IT IS THE WHOLE COUNTEREXAMPLE. `surplus` counts startable bodies above
         the MUST-FIELD requirement, and `reqStart` deliberately excludes the flex slot — correctly, because
         no single position is owed it. The consequence nobody followed through: in a league that starts
         2 RB + 1 FLEX, a team with three startable backs has `surplus.RB = 1` and is told to go and sell
         one, when the third back is the man filling the flex every week. The count is not just a crude
         proxy for depth — in a flex league it is systematically off by one at RB and WR, in the direction
         that invents spares.

       ⭐ THE MEASURE THAT CANNOT MAKE THAT MISTAKE IS MARGINAL COST: solve the team's best lineup, take the
         player out, solve it again. The difference is what he is actually worth to the roster that holds
         him — and because the solve fills the flex from whoever is left, a third back who is starting in
         the flex has a real cost and a fourth back who is not has ~none. The flex is handled by being
         PLAYED rather than by being modelled.
       ⭐ AND AGAINST THAT, WHAT HE IS WORTH TO SOMEBODY WHO NEEDS HIM (`worth`, value over replacement).
         `edge = worth − cost` is Trey's own sentence from 29ai — "value that you can move from there to
         reshape your team" — and it is the same quantity `mySurplus` already prices for MY roster. This
         puts every team on it, which is what lets the position summary talk about a market instead of a
         headcount.
       ⚠ ONLY THE TOP FEW AT A POSITION ARE PRICED. The lineup solve is the expensive part and the fifth
         receiver on a roster is never the answer to "what can you move" — he clears no replacement line, so
         his edge is zero by construction and solving for him is pure cost. */
    const movable = {}, cheapest = {};
    Object.keys(req).forEach((pos) => {
      if (!(req[pos] > 0)) return;
      const atPos = roster.filter((p) => String(p.pos || '').toUpperCase() === pos)
        .sort((a, b) => (Number(b.pts) || 0) - (Number(a.pts) || 0)).slice(0, 4);
      if (!atPos.length) return;
      const base = lineupValue(roster, sf);
      let best = null;
      atPos.forEach((p) => {
        const worth = Math.max(0, (Number(p.pts) || 0) - (repl[pos] || 0));
        if (worth <= 0) return;
        const cost = Math.max(0, r1(base - lineupValue(roster.filter((x) => String(x.sid) !== String(p.sid)), sf)));
        const edge = r1(worth - cost);
        /* ⚠ TIES BREAK TOWARD THE CHEAPER MAN, and this was a real finding rather than a precaution. With
           four elite receivers my WR1 and my WR4 came out on the SAME edge — the first costs 60 and is
           worth 180, the fourth costs nothing and is worth 120 — and taking the first match offered my
           best receiver. Same number, wildly different advice: the point of this whole measure is the man
           you would actually part with, so when the edge cannot separate two players, the lower cost
           does. (sim/posmarket.js §3 prints the pick, which is how it surfaced.) */
        if (!best || edge > best.edge || (edge === best.edge && cost < best.cost)) {
          best = { sid: p.sid, name: p.name || null, pos, cost, worth: r1(worth), edge };
        }
      });
      /* ⚠ AND THE EDGE HAS TO BE WORTH SAYING OUT LOUD — b151. "Greater than zero" let a six-point edge
         over a whole season (about a third of a point a week, which is inside the noise of any
         projection) print a MOVE verdict on a player the reader would look at and say "why him". The
         floor is a share of the position's own replacement level rather than a constant, because this
         function is handed season values on one screen and weekly ones on another and must not silently
         mean something different depending on which. */
      const floor = Math.max(0, (repl[pos] || 0) * 0.1);
      if (best && best.edge > floor) movable[pos] = best;
      /* ⚠ AND THE BEST CANDIDATE IS KEPT EVEN WHEN THE ANSWER IS NO — b151. "Leave it alone" is a verdict
         and a verdict needs its working; `cheapest` is the man the answer is about, so the row can say
         what he is worth to this lineup instead of asserting that nothing is available. */
      if (best) cheapest[pos] = best;
    });

    return {
      rosterId: t.rosterId, teamName: t.teamName, ownerName: t.ownerName, isMe: !!t.isMe,
      startable, have, surplus, need, posValue, movable, cheapest,
      pfRank: pf, gradeRank: gr, gap, benchWaste,
      /* The one-line read, written here so every card in the app says the same thing about this manager.
         ⚠ IT NEVER CALLS ANYBODY BAD AT FANTASY. We cannot see their injuries or their reasons; what we
           can see is a gap between what they hold and what they have scored, and that is what it says. */
      ownerNote: gap == null ? null
        : gap >= 3 ? `Roster grades ${ord(gr)} but they have scored ${ord(pf)}-most — something is not clicking for them.`
          : gap <= -3 ? `Scoring ${ord(pf)}-most off a roster that grades ${ord(gr)} — they are getting the most out of it.`
            : null,
      underperforming: gap != null && gap >= 3,
      overperforming: gap != null && gap <= -3,
    };
  });

  /* ⭐⭐⭐⭐⭐ AND NOW RANK EVERY POSITION ACROSS THE LEAGUE, which is the number the whole fit read runs on.
     `posRank[pos]` is 1 for the best room in the league at that position. `strongAt` / `thinAt` are the
     top and bottom thirds — thirds rather than a fixed cut because a 10-team and a 14-team league have
     to mean the same thing by the same rule (the 29x "rank is the only unit that means the same thing
     next week" lesson, applied to a league instead of a feed).
     ⚠ A ONE-TEAM LEAGUE HAS NO THIRDS. With fewer than four teams every rank is both top and bottom, so
       the flags stay empty rather than declaring everybody strong and thin at once. */
  const n = out.length;
  const positions = new Set();
  out.forEach((r) => Object.keys(r.posValue || {}).forEach((pos) => positions.add(pos)));
  positions.forEach((pos) => {
    const order = out.slice().sort((a, b) => (b.posValue[pos] || 0) - (a.posValue[pos] || 0));
    order.forEach((r, i) => { r.posRank = r.posRank || {}; r.posRank[pos] = i + 1; });
  });
  if (n >= 4) {
    const topCut = Math.max(1, Math.round(n / 3));
    const botCut = n - topCut + 1;
    out.forEach((r) => {
      r.strongAt = {}; r.thinAt = {};
      Object.keys(r.posRank || {}).forEach((pos) => {
        if (r.posRank[pos] <= topCut) r.strongAt[pos] = r.posRank[pos];
        if (r.posRank[pos] >= botCut) r.thinAt[pos] = r.posRank[pos];
      });
    });
  } else {
    out.forEach((r) => { r.strongAt = {}; r.thinAt = {}; });
  }
  out.forEach((r) => { r.teams = n; });
  return out;
}

function ord(n) {
  if (!Number.isFinite(n)) return '—';
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
   THE BOARD. Every one-for-one swap that makes sense, each carrying the reasons it makes sense and an
   estimate of whether the other manager would agree.
   ──────────────────────────────────────────────────────────────────────────────────────────────── */
export function tradeBoard(input) {
  const o = input || {};
  const me = o.me ? { ...o.me, roster: clean(o.me.roster) } : null;
  const others = (o.others || [])
    .map((t) => (t ? { ...t, roster: clean(t.roster) } : null))
    .filter((t) => t && t.roster.length);
  const lineupValue = o.lineupValue;
  const sf = o.sf;
  const req = o.req || {};
  const repl = o.repl || {};
  const max = o.max || 6;
  const reads = new Map((o.reads || []).map((r) => [r.rosterId, r]));
  const diag = { pairs: 0, lopsided: 0, noGainForMe: 0, noGainForThem: 0, wash: 0, teams: others.length,
    // b152 — the consolidation pass keeps its own counters, so "nothing came back" can name which pass.
    consolPairs: 0, consolLopsided: 0, consolNoGainForMe: 0, consolNoGainForThem: 0, consolBothStarters: 0,
    // b153 — ideas that survived only because the tilt band let them through, counted so the census adds up.
    tilted: 0, consolTilted: 0,
    /* ⚠ b153 — HOW MANY EACH PASS ACTUALLY PRODUCED, which is the one thing the counters above could not
       say. Every existing counter is a REJECTION count, so "the consolidation pass is dead code" and "the
       consolidation pass works and the variety cap dropped its offers" printed identically — and the
       first of those was true for three builds. A rejection census with no numerator is half a census. */
    offers: 0, consolOffers: 0 };

  /* ⭐⭐⭐⭐⭐ A DEAL DOES NOT HAVE TO IMPROVE BOTH LINEUPS TO BE WORTH SENDING — b153.
     ==================================================================================================
     Trey, on the same three blank columns for the second time: "I wonder if it's the note on no one for
     one or two for one that improves both lineups (which I find hard to believe). It doesn't have to be
     a perfect swap. You can say that this slightly favors me or them... I really just want this to spark
     ideas or starting points."

     ⚠ `theirGain > 0.5` WAS A HARD GATE, AND IT IS THE WRONG QUESTION. What it asks is "does this raise
       the other manager's OPTIMAL STARTING LINEUP, solved by us, on our projections, this season". Real
       managers trade on value, on need, on a hunch about a schedule — and they take deals that cost their
       current lineup a little all the time. Requiring a strict improvement on a number they have never
       seen throws away the entire category Trey is asking for: the fair-on-value idea that tilts his way.
     ⭐ SO THE BAND REPLACES THE GATE. The other side may give up a slice of its lineup — proportional to
       the lineup, because 20 points means something different to a 900-point team and a 1,600-point one —
       and the idea survives, carrying a `tilt` that says plainly which way it leans. What it must NOT do
       is survive as a robbery: the tier-for-tier fairness band still applies, and now runs FIRST in both
       passes, so nothing reaches the tilt band that was never a fair swap to begin with.
     ⚠ MY OWN SIDE KEEPS ITS FLOOR. This is his screen, and an idea that does not improve his lineup is
       not an idea he has any reason to send. The asymmetry is deliberate. */
  /* ⚠ DEFINED INSIDE `tradeBoard` ON PURPOSE. Every sim suite and the shape probe slice this file with a
     regex that lifts ONE named function at a time; a new module-level helper called from inside
     `tradeBoard` is invisible to all of them and six suites go red at once (29aj, and it cost an hour). */
  const TILT_FLOOR = (base) => -Math.max(5, Math.abs(Number(base) || 0) * 0.04);
  const tiltNoteFor = (tilt, mine, theirs) => (tilt === 'both'
    ? `Both lineups improve — you +${mine}, them +${theirs}.`
    : `Fair on value, but it is your lineup that gains — you +${mine}, their own starting lineup ${theirs >= 0 ? `barely moves (+${theirs})` : `drops ${Math.abs(theirs)}`}. Worth asking, not a lock.`);
  if (!me || !me.roster || !me.roster.length || typeof lineupValue !== 'function') {
    return withDiag([], diag);
  }

  const myBase = lineupValue(me.roster, sf);
  const myRead = reads.get(me.rosterId) || null;
  const worthOf = (p) => Math.max(0, (Number(p && p.pts) || 0) - (repl[String(p && p.pos).toUpperCase()] || 0));

  /* ⭐⭐⭐⭐ POSITIONAL RANK BY VALUE AND BY DRAFT COST, league-wide, so "the market has not caught up with
     him" is a measured claim rather than a feeling. Built once over every rostered player.
     ⚠ ADP IS OPTIONAL. Plenty of leagues import without it, and a signal that silently becomes false for
       everybody is worse than one that is absent — `mktRank` is null when there is no ADP to rank. */
  const everyone = [me.roster].concat(others.map((t) => t.roster)).flat();
  const valRank = new Map(), adpRank = new Map();
  ['QB', 'RB', 'WR', 'TE'].forEach((pos) => {
    const at = everyone.filter((p) => String(p.pos).toUpperCase() === pos);
    at.slice().sort((a, b) => (b.pts || 0) - (a.pts || 0)).forEach((p, i) => valRank.set(String(p.sid), i + 1));
    const withAdp = at.filter((p) => Number.isFinite(p.adp));
    withAdp.slice().sort((a, b) => a.adp - b.adp).forEach((p, i) => adpRank.set(String(p.sid), i + 1));
  });

  /* ⭐⭐⭐⭐⭐ IS THIS A FAIR TRADE — MEASURED TIER FOR TIER, NOT IN RAW VALUE — b151.
     ==================================================================================================
     Trey: "I struggle to believe there are no clean swaps." Nine managers, nine "no clean swap", on a
     roster that is first in the league at receiver and tenth at running back — the single most obviously
     tradeable shape there is.

     ⚠⚠ 73% OF EVERY PAIR THIS FINDER CONSIDERED WAS BEING THROWN AWAY BY ONE LINE, and a probe built in
       his league's shape said so outright: of 132 "my receiver for their back" pairs, 132 died on the
       fairness gate and ZERO died for want of a gain to either side. Deals worth +72 to him and +40 to
       the other manager never reached the screen.

     ⭐ THE CAUSE IS THAT VALUE-ABOVE-REPLACEMENT IS NOT COMPARABLE ACROSS POSITIONS. The gate was a ratio
       of two VOR numbers, and VOR depends on how good the REPLACEMENT is — so in a year when nobody in
       the league has a good running back, the best back available is worth 84 over replacement while an
       ordinary receiver is worth 176, and swapping them reads as a 0.48 robbery. It is nothing of the
       sort: it is the best back in the league for a good receiver, which is a trade both managers would
       recognise as square. The measure was punishing him for the exact scarcity that made the trade
       worth doing.

     ⭐ SO FAIRNESS IS A SHARE OF THE POSITION'S OWN TOP. An RB worth 100% of the best back available and
       a WR worth 92% of the best receiver available are a fair swap, whatever the raw numbers say —
       which is how people actually talk about trades ("an RB1 for a WR1").
     ⚠ AND THE DEGENERATE CASE IS GUARDED. If a position's best man is barely above replacement, every
       share at that position is a ratio of two tiny numbers and therefore noise — worse, it would make
       a worthless player look like a stud because he is the least bad one. Below `TIER_FLOOR` the raw
       worth is used, which is the old behaviour, deliberately. */
  const TIER_FLOOR = 25;            // season points over replacement; under this a position has no spread
  const posTop = {};
  ['QB', 'RB', 'WR', 'TE'].forEach((pos) => {
    posTop[pos] = Math.max(0, ...everyone.filter((p) => String(p.pos).toUpperCase() === pos).map(worthOf));
  });
  const tierShare = (p) => {
    const pos = String(p && p.pos).toUpperCase();
    const top = posTop[pos] || 0;
    const w = worthOf(p);
    return top >= TIER_FLOOR ? w / top : w;
  };

  const offers = [];
  others.forEach((them) => {
    const read = reads.get(them.rosterId) || null;
    const theirBase = lineupValue(them.roster, sf);
    const theirSet = new Set((them.setStarters || []).map(String));
    /* Their best asset, by what he is worth to anybody. Asking for it is the single biggest reason a
       proposal gets ignored, and 29r's "there is just no way they would do this" was this fact missing. */
    let theirBest = null;
    them.roster.forEach((p) => { if (!theirBest || worthOf(p) > worthOf(theirBest)) theirBest = p; });

    them.roster.forEach((get) => {
      const pos = String(get.pos || '').toUpperCase();
      if (!pos || get.sid == null) return;
      const theirRestNoGet = them.roster.filter((p) => p.sid !== get.sid);
      // What losing him actually costs THEM — the other half of the fit edge.
      const theirLoss = r1(theirBase - lineupValue(theirRestNoGet, sf));
      const myAdd = r1(lineupValue(me.roster.concat([get]), sf) - myBase);
      /* ⭐⭐⭐⭐⭐ THE FIT EDGE, AND IT IS COMPUTED BEFORE ANY PRICE IS CONSIDERED. If a man is not worth
         more in my lineup than in theirs, no price makes the trade sensible for both of us — so this is
         the gate, and everything below is about what he costs rather than whether to want him. */
      const fitEdge = r1(myAdd - theirLoss);
      if (myAdd <= 0.5) return;

      me.roster.forEach((give) => {
        if (give.sid == null || give.sid === get.sid) return;
        diag.pairs++;
        const gPos = String(give.pos || '').toUpperCase();
        if (gPos === pos && Math.abs((give.pts || 0) - (get.pts || 0)) < 6) { diag.wash++; return; }
        const wGive = worthOf(give), wGet = worthOf(get);
        const hi = Math.max(wGive, wGet), lo = Math.min(wGive, wGet);
        if (hi <= 0) return;
        /* ⚠⚠ THE BAND IS ON THE TIER SHARE NOW, NOT ON RAW VALUE — b151. See `tierShare` above for why
           a raw cross-position ratio threw away three quarters of every pair in Trey's league. The 0.5
           band itself is unchanged and is still the one the shipped finder settled on in 29w; what
           changed is the scale it is applied to. */
        const sGive = tierShare(give), sGet = tierShare(get);
        const sHi = Math.max(sGive, sGet), sLo = Math.min(sGive, sGet);
        if (sHi <= 0 || sLo / sHi < 0.5) { diag.lopsided++; return; }

        const myAfter = lineupValue(me.roster.filter((p) => p.sid !== give.sid).concat([get]), sf);
        const myGain = r1(myAfter - myBase);
        if (myGain <= 0.5) { diag.noGainForMe++; return; }
        const theirAfter = lineupValue(theirRestNoGet.concat([give]), sf);
        const theirGain = r1(theirAfter - theirBase);
        // ⚠ b153 — a band, not a gate. See TILT_FLOOR. The fairness check above has already run.
        if (theirGain <= TILT_FLOOR(theirBase)) { diag.noGainForThem++; return; }
        const tilt = theirGain > 0.5 ? 'both' : 'you';
        if (tilt !== 'both') diag.tilted++;

        // ── the reasons, each one a measured thing ──────────────────────────────────────────────
        const why = [];
        const theirStartable = (read && read.startable) ? (read.startable[pos] || 0) : null;
        const theirNeedAt = (read && read.need) ? read.need[gPos] || 0 : 0;
        const theirSurplusAt = (read && read.surplus) ? read.surplus[pos] || 0 : 0;
        const myNeedAt = (myRead && myRead.need) ? myRead.need[pos] || 0 : 0;
        const mySurplusAt = (myRead && myRead.surplus) ? myRead.surplus[gPos] || 0 : 0;
        /* ⚠ 29aj — THE "CAN THEY AFFORD HIM" LINE IS PRICED NOW, NOT COUNTED. `theirLoss` is what their
           own best lineup gives up by losing THIS man, which is the only version of the claim that is true
           in a flex league: a third back who fills their flex every week is not somebody they can lose,
           however many "startable" bodies a replacement line says they have. `theirSurplusAt` survives as
           a gate only — it decides whether the sentence is worth making, never what it says. */
        const affordable = theirLoss != null && theirLoss < Math.max(2, myAdd * 0.5);

        if (fitEdge >= 8) {
          why.push({ key: 'fit', weight: 3,
            /* ⚠ "adds" AND "costs", NOT TWO BARE NUMBERS. These are the value of ACQUIRING him and the
               value of LOSING him, which is not what the headline figure above is (that one is net of
               what you send back) — and three unlabelled numbers on one card that do not add up is how a
               reader decides the whole page is approximate. */
            text: `He is worth ${r1(fitEdge)} more to you than to them — he adds ${myAdd} to your lineup and costs them ${theirLoss}.` });
        }
        if (affordable) {
          why.push({ key: 'depth', weight: 2,
            text: `They can afford to lose him — their own best lineup only drops ${theirLoss}, because they have cover behind him.` });
        }
        /* And the mirror of it for the man I am sending: what MY lineup gives up, which is the number the
           whole recommendation rests on and was previously stated as a body count at his position. */
        const myCost = r1(myBase - lineupValue(me.roster.filter((p) => p.sid !== give.sid), sf));
        if (myCost < Math.max(2, myGain * 0.5)) {
          why.push({ key: 'mydepth', weight: 1,
            text: `And ${give.name || 'he'} is cheap for you to lose — your lineup drops ${myCost} without him.` });
        }
        /* ⭐ UNDERVALUED BY HIS OWN OWNER. Their usage is the evidence: he clears this league's replacement
           bar and they are not starting him. ⚠ Only claimed when we actually HAVE their set lineup —
           `theirSet.size` guards an empty array reading as "he is benched", which would fire for every
           player in the league. */
        if (theirSet.size > 0 && !theirSet.has(String(get.sid)) && worthOf(get) > 0) {
          why.push({ key: 'benched', weight: 2,
            text: `Their own lineup says they do not rate him — he is startable and they benched him this week.` });
        }
        /* ⭐ UNDERVALUED BY THE MARKET. Outproducing where he was drafted, which is a reason he may come
           cheap and is independent of this owner. */
        const vr = valRank.get(String(get.sid)), ar = adpRank.get(String(get.sid));
        if (vr && ar && ar - vr >= 8) {
          why.push({ key: 'market', weight: 1,
            text: `The market has not caught up: he is the ${pos}${vr} on production and was drafted as the ${pos}${ar}.` });
        }
        if (read && read.underperforming) {
          why.push({ key: 'owner', weight: 1, text: read.ownerNote });
        }
        if (myNeedAt > 0) {
          why.push({ key: 'need', weight: 2,
            text: `${pos} is where you are short — you have ${(myRead && myRead.startable[pos]) || 0} startable for ${req[pos] || 0} slot${(req[pos] || 0) === 1 ? '' : 's'}.` });
        }

        // ── would they say yes ─────────────────────────────────────────────────────────────────
        /* Not a probability and not presented as one — a 0-100 read with its components named, so the
           card can show its working. The weights are deliberately blunt: this is a judgement about human
           behaviour and false precision on it would be worse than a coarse honest scale. */
        const parts = [];
        let realism = 40;                                        // a deal that helps them at all starts here
        if (theirGain >= 10) { realism += 20; parts.push('big lineup gain for them'); }
        else if (theirGain >= 4) { realism += 12; parts.push('a real lineup gain for them'); }
        else if (theirGain > 0.5) { realism += 4; parts.push('a small gain for them'); }
        /* ⚠ b153 — THE TILT IS PRICED, NOT HIDDEN. Letting these through the gate and then scoring them
           as if both sides gained would be worse than the gate was: the list would fill with asks that
           read as mutual. They come in low and say why. */
        else { realism -= 12; parts.push('their own starting lineup does not improve, so it is an ask'); }
        if (theirNeedAt > 0) { realism += 20; parts.push(`fills their hole at ${gPos}`); }
        if (theirSurplusAt > 0 || affordable) { realism += 10; parts.push(`costs them depth rather than a starter`); }
        if (read && read.underperforming) { realism += 5; parts.push('a team with reason to shake things up'); }
        // ⚠ Same change as the gate: balance is tier for tier, so a position's scarcity is not a penalty.
        const balance = Math.round((sLo / sHi) * 100);
        if (balance >= 80) { realism += 10; parts.push('close on value'); }
        else if (balance < 60) { realism -= 10; parts.push('lopsided on value'); }
        /* ⚠⚠ THE BIG NEGATIVE, AND THE ONE THE OLD FINDER HAD NO WAY TO EXPRESS. Nobody trades the best
           player they own for positional fit, however well the lineup maths works out.
           ⚠ b151 SOFTENED IT WHERE THEY HAVE COVER, and the probe is why: a manager with four startable
             backs, giving up the best of them for an elite receiver, was carrying the full −30 — which
             on its own pushed genuinely mutual deals (+72 him, +40 them) under the bar and produced the
             nine blank rows Trey was looking at. "The best player they own" means something very
             different when the man behind him also starts. */
        if (theirBest && theirBest.sid === get.sid) {
          const covered = affordable || theirSurplusAt > 0;
          realism -= covered ? 12 : 30;
          parts.push(covered ? 'the best player they own, though they have cover behind him'
            : 'he is the best player they own');
        }
        realism = Math.max(0, Math.min(99, realism));

        diag.offers++;
        offers.push({
          team: { rosterId: them.rosterId, teamName: them.teamName, ownerName: them.ownerName },
          read, give, get, myGain, theirGain, fitEdge, myAdd, theirLoss, balance,
          tilt, tiltNote: tiltNoteFor(tilt, myGain, theirGain),
          giveWorth: Math.round(wGive), getWorth: Math.round(wGet),
          why: why.sort((a, b) => b.weight - a.weight),
          realism, realismWhy: parts,
          band: realism >= 65 ? 'likely' : realism >= 45 ? 'worth asking' : 'long shot',
        });
      });
    });
  });

  /* ⭐⭐⭐⭐⭐ TWO OF MINE FOR ONE OF THEIRS — b152, and it is the shape his roster actually needs.
     ==================================================================================================
     Trey, on a tab where every deal column came back blank: "the 'you' 'them' and 'ideas' columns are
     completely empty (which I just don't think that can be true)."

     ⚠⚠ THE FINDER ONLY EVER ENUMERATED ONE-FOR-ONE, AND HIS LEAGUE STARTS TWO FLEX. Rebuilding his shape
       with FLEX: 2 reproduced the blank screen exactly — 0 offers out of 306 pairs, and `movable` empty
       at every position. The reason is arithmetic, not a filter: with two flex slots a deep receiver room
       has NO spare man, every receiver he owns is in the lineup, so ANY one-for-one that sends one costs
       him a starter and cannot improve his lineup. The finder was right and the answer was still useless,
       because "no one-for-one improves both teams" is not "there is nothing to do".

     ⭐ WHAT A TEAM WITH QUALITY DEPTH AND A HOLE DOES IS CONSOLIDATE: send two good players for one better
       one. That is the single most common real fantasy trade and the app could not express it. Two men
       leave, one arrives, my lineup improves because the arriving player beats my worst starter by more
       than the two departures cost, and THEIRS improves because two startable bodies beat one.

     ⚠ THE ENUMERATION IS BOUNDED ON PURPOSE. Unrestricted it is every pair of my roster against every one
       of theirs, eleven times over — so `give` pairs come from my most tradeable men only, `get` from
       theirs, and the pair must include at least one man who is NOT in my optimal lineup. That last rule
       is what keeps it a consolidation rather than a fire sale: sending two starters for one player is a
       different (and usually bad) trade, and it is not what he is asking for.
     ⚠ AND IT COSTS A ROSTER SPOT ON THEIR SIDE, which is a real reason to say no and is priced as one. */
  const CONSOL_POOL = 7;
  const CONSOL_SPARE = 4;
  if (typeof o.consolidate === 'undefined' || o.consolidate) {
    const myOptSids = new Set();
    const myLineup = typeof o.lineupSlots === 'function' ? o.lineupSlots(me.roster, sf) : null;
    if (myLineup && myLineup.slots) {
      myLineup.slots.forEach((x) => { if (x && x.p) myOptSids.add(String(x.p.sid)); });
    }
    /* My tradeable men, best first — and `spare` marks the ones my own best lineup does not use, which is
       the half of the pair that makes this a consolidation. Without a lineup solve (a caller that did not
       pass `lineupSlots`) everyone counts as a candidate and the pair rule below falls back to worth. */
    /* ⚠⚠⚠⚠ THE POOL HAS TO CONTAIN A SPARE OR THE WHOLE PASS IS DEAD CODE — b153, and it was.
       The probe, rebuilt in Trey's exact shape, returned `consolBothStarters: 1596` out of 1596 pairs:
       EVERY consolidation pair this finder considered was thrown away by the one rule that makes it a
       consolidation, because the pool it drew from could not satisfy that rule. "Top 7 by worth" on a
       roster that starts 8 is, by construction, eight-tenths starters — so `!a.spare && !b.spare` was
       true for all 21 pairs per target, every target, every team, and b152 shipped a pass that has
       never once produced an offer. The blank columns Trey has now reported twice were this.
       ⭐ SO THE POOL IS BUILT IN TWO HALVES: the best men I own (what a package is anchored on) AND the
         best men my own lineup does not use (what makes it a consolidation rather than a fire sale).
       ⚠ AND THE SPARE HALF DOES NOT REQUIRE POSITIVE VALUE OVER REPLACEMENT. A bench flier is worth
         nothing to my lineup and is still a real part of a real trade — "my WR3 and a dart for your
         RB1" is the most ordinary package in fantasy football. The fairness gate below prices the pair
         against what comes back, so a worthless throw-in cannot make a bad deal look fair. */
    const scored = me.roster
      .map((p) => ({ p, w: worthOf(p), spare: myOptSids.size ? !myOptSids.has(String(p.sid)) : true }))
      .sort((a, b) => b.w - a.w);
    const topAny = scored.filter((x) => x.w > 0).slice(0, CONSOL_POOL);
    const anySids = new Set(topAny.map((x) => String(x.p.sid)));
    const myCand = topAny.concat(
      scored.filter((x) => x.spare && !anySids.has(String(x.p.sid))).slice(0, CONSOL_SPARE));

    others.forEach((them) => {
      const read = reads.get(them.rosterId) || null;
      const theirBase = lineupValue(them.roster, sf);
      let theirBest = null;
      them.roster.forEach((p) => { if (!theirBest || worthOf(p) > worthOf(theirBest)) theirBest = p; });
      const targets = them.roster
        .map((p) => ({ p, w: worthOf(p) }))
        .filter((x) => x.w > 0)
        .sort((a, b) => b.w - a.w)
        .slice(0, CONSOL_POOL);

      targets.forEach(({ p: get }) => {
        const gPos = String(get.pos || '').toUpperCase();
        const restNoGet = them.roster.filter((p) => String(p.sid) !== String(get.sid));
        const theirLoss = r1(theirBase - lineupValue(restNoGet, sf));

        for (let i = 0; i < myCand.length; i++) {
          for (let j = i + 1; j < myCand.length; j++) {
            const a = myCand[i], b = myCand[j];
            diag.consolPairs++;
            // At least one departing man must be somebody my own best lineup does not use.
            if (!a.spare && !b.spare) { diag.consolBothStarters++; continue; }
            const giveSids = new Set([String(a.p.sid), String(b.p.sid)]);

            /* ⚠ FAIRNESS ON A PACKAGE IS NOT THE SUM OF ITS PARTS. Two men are worth less together than
               their values add up to — the second one is a body the other manager has to find a starting
               spot or a roster spot for — so the pair is discounted before it is compared, tier for tier,
               against the man coming back. 0.75 is blunt and deliberately so; see the note on `realism`.
               ⚠ b153 — THIS NOW RUNS BEFORE THE GAIN CHECKS, matching the one-for-one pass. With a band
                 rather than a gate on their side, fairness is the thing standing between "an idea that
                 tilts your way" and "a robbery", so it has to be the first question, not the last. */
            const pairShare = (tierShare(a.p) + tierShare(b.p)) * 0.75;
            const getShare = tierShare(get);
            const sHi2 = Math.max(pairShare, getShare), sLo2 = Math.min(pairShare, getShare);
            if (sHi2 <= 0 || sLo2 / sHi2 < 0.5) { diag.consolLopsided++; continue; }

            const myAfter = lineupValue(me.roster.filter((x) => !giveSids.has(String(x.sid))).concat([get]), sf);
            const myGain = r1(myAfter - myBase);
            if (myGain <= 0.5) { diag.consolNoGainForMe++; continue; }
            const theirAfter = lineupValue(restNoGet.concat([a.p, b.p]), sf);
            const theirGain = r1(theirAfter - theirBase);
            if (theirGain <= TILT_FLOOR(theirBase)) { diag.consolNoGainForThem++; continue; }
            const tilt = theirGain > 0.5 ? 'both' : 'you';
            if (tilt !== 'both') diag.consolTilted++;

            const parts = [];
            let realism = 40;
            if (theirGain >= 10) { realism += 20; parts.push('big lineup gain for them'); }
            else if (theirGain >= 4) { realism += 12; parts.push('a real lineup gain for them'); }
            else if (theirGain > 0.5) { realism += 4; parts.push('a small gain for them'); }
            else { realism -= 12; parts.push('their own starting lineup does not improve, so it is an ask'); }
            const theirNeedA = (read && read.need) ? read.need[String(a.p.pos).toUpperCase()] || 0 : 0;
            const theirNeedB = (read && read.need) ? read.need[String(b.p.pos).toUpperCase()] || 0 : 0;
            if (theirNeedA > 0 || theirNeedB > 0) { realism += 15; parts.push('fills a hole they cannot field'); }
            /* ⚠ TWO IN, ONE OUT COSTS THEM A ROSTER SPOT — somebody on their bench has to be dropped, and
               that is a real reason to decline that a one-for-one never carries. */
            realism -= 8; parts.push('two-for-one, so it costs them a roster spot');
            const balance = Math.round((sLo2 / sHi2) * 100);
            if (balance >= 80) { realism += 10; parts.push('close on value'); }
            else if (balance < 60) { realism -= 10; parts.push('lopsided on value'); }
            if (theirBest && String(theirBest.sid) === String(get.sid)) {
              realism -= 12; parts.push('the best player they own — but two starters is a real return');
            }
            realism = Math.max(0, Math.min(99, realism));

            diag.consolOffers++;
            offers.push({
              team: { rosterId: them.rosterId, teamName: them.teamName, ownerName: them.ownerName },
              read, give: a.p, give2: b.p, get, myGain, theirGain,
              tilt, tiltNote: tiltNoteFor(tilt, myGain, theirGain),
              fitEdge: r1(myGain), myAdd: r1(myGain), theirLoss, balance,
              giveWorth: Math.round(a.w + b.w), getWorth: Math.round(worthOf(get)),
              why: [{ key: 'consolidate', weight: 3,
                text: `Two for one: ${a.p.name} and ${b.p.name} for ${get.name}. Your lineup is +${myGain} because ${get.name} beats what leaves, and they turn one ${gPos} into two startable players.` }]
                .concat(read && read.underperforming ? [{ key: 'owner', weight: 1, text: read.ownerNote }] : []),
              realism, realismWhy: parts,
              band: realism >= 65 ? 'likely' : realism >= 45 ? 'worth asking' : 'long shot',
            });
          }
        }
      });
    });
  }

  /* ⭐⭐⭐⭐ ONE IDEA PER TARGET, AND AT MOST TWO INVOLVING ANY ONE OF MY PLAYERS. You can only trade a man
     once, and five variations on the same target is one idea wearing five rows — which is a large part of
     what made the old list "difficult to follow". */
  const seen = new Set(), giveCount = {}, dedup = [];
  offers
    /* ⚠⚠⚠ THE CAPS ARE A BUDGET, AND A DEAL THEY WOULD ACTUALLY TAKE HAS TO SPEND IT FIRST — b153.
       Letting the tilt band through without this line cost eight recommendations in the deep-league
       probe: the biggest raw gains are, almost by definition, the ones the other manager likes least, so
       sorting on `myGain` alone handed every per-player and per-team slot to asks and squeezed genuinely
       mutual +26/+2 trades off the board entirely. The band was supposed to ADD ideas underneath the
       recommendations, not outbid them. Realistic first, then by what it does for you — which is the
       same two-key rule `partnerBoard` and the cards already sort by, so no two lists can disagree. */
    .sort((a, b) => ((b.realism >= 45) - (a.realism >= 45)) || (b.myGain - a.myGain) || (b.realism - a.realism))
    .forEach((t) => {
      const k = `${t.team.rosterId}|${t.get.sid}`;
      if (seen.has(k)) return;
      // ⚠ b152 — a two-for-one spends BOTH men, so both count against the cap. Without this, one
      //   player could headline four packages and the list would be one idea wearing four rows again.
      const gives = [t.give, t.give2].filter(Boolean);
      if (gives.some((g) => (giveCount[g.sid] || 0) >= 2)) return;
      seen.add(k);
      gives.forEach((g) => { giveCount[g.sid] = (giveCount[g.sid] || 0) + 1; });
      dedup.push(t);
    });

  /* ⭐⭐⭐⭐⭐ A SPREAD OF PARTNERS — AND DELIBERATELY NOT A SPREAD OF POSITIONS.
     Measured against the real 12-team fixture the first version returned five offers, four of them tight
     ends and three of them with the same manager. The obvious fix was to cap per POSITION, and it was
     wrong: it cut the board to two, because a tight-end hole was genuinely the only thing worth fixing on
     that roster, and three of the four ideas it threw away were DIFFERENT MANAGERS who could each sell a
     tight end. Four routes to your one real problem is four options; hiding three of them to look varied
     is a worse recommendation that reads as a better list.
     ⭐ WHAT ACTUALLY REPEATS is the PARTNER: the same manager three times is one conversation, and the
       second and third rows add nothing you could act on separately. So the cap is per team, and the
       screen states the theme out loud instead (see the `theme` line on the tab) — which turns "four tight
       ends again" from apparent repetition into the point being made. */
  const perTeam = {}, spread = [];
  dedup.forEach((t) => {
    if ((perTeam[t.team.rosterId] || 0) >= 2) return;
    perTeam[t.team.rosterId] = (perTeam[t.team.rosterId] || 0) + 1;
    spread.push(t);
  });

  /* ⭐⭐⭐⭐⭐ TWO LISTS, NOT ONE RANKING. A huge gain nobody would accept and a modest gain they would take
     today are not points on one scale, and mixing them is how a recommendation list stops being read: the
     top row is always the fantasy trade, so the eye learns the list is aspirational and skips it.
     So: what to send TODAY, ranked by what it does for you; and separately, the long shots, clearly
     labelled, for when he wants to swing. */
  const realistic = spread.filter((t) => t.realism >= 45).slice(0, max);
  /* ⚠ A LONG SHOT HAS TO BEAT THE BEST REALISTIC OFFER, not merely the worst one shown. Anything less and
     the section fills with ordinary trades that happen to be unlikely, which is the opposite of its job:
     it exists for the deal that is worth an ask precisely because the payoff is out of the ordinary. */
  const longShots = dedup.filter((t) => t.realism < 45 && t.myGain > (realistic.length ? realistic[0].myGain : 0))
    .slice(0, 2);
  const list = realistic.map((t, i) => ({ ...t, rank: i + 1 }));
  /* `all` is every surviving idea before the variety cap — carried non-enumerably so the array still reads
     as the shortlist everywhere it is rendered, while a test (or a future "show everything") can reach the
     rest. ⚠ Without it a test cannot tell "this offer was capped away for variety" from "this offer was
     never generated", which are opposite findings. */
  return withDiag(list, diag, longShots, dedup);
}

function withDiag(list, diag, longShots, all) {
  Object.defineProperty(list, 'diag', { value: diag, enumerable: false });
  Object.defineProperty(list, 'longShots', { value: longShots || [], enumerable: false });
  Object.defineProperty(list, 'all', { value: all || list.slice(), enumerable: false });
  return list;
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
   THE MARKET, IN ONE SENTENCE PER POSITION.
   Trey: "be able to look at trade markets in general."
   `positionMarket` (29x) already answers "who can help me at X" once you have picked an X. This answers
   the question you have before that: which positions are actually tradeable in this league at all. A
   position where nine of twelve teams are short is not a market, it is a queue — and knowing that before
   you spend a week asking is the whole value.
   ──────────────────────────────────────────────────────────────────────────────────────────────── */
/* ⭐⭐⭐⭐⭐ REBUILT IN 29aj ON RANK AND PRICED VALUE — the last place "+N spare" was still being printed.
   ==================================================================================================
   Trey: "I'm still not sure the 'Potential Positional Trade Considerations' is actually working the way
   it should. The +Spare just feels like not the best way to determine this... especially since this
   league has a flex position."

   ⚠⚠ HE HAD ALREADY SAID THIS ONCE AND ONLY HALF OF IT GOT FIXED. 29ai moved the LEAGUE READ off spare
     bodies and onto rank and marginal cost, and left this function — an older section on the same tab,
     under a heading he had personally renamed — still counting startable bodies over an absolute line.
     Two sections of one screen describing the same roster by two different rules, with the deprecated one
     under the clearer heading. ⭐ THE PORTABLE LESSON: when feedback kills a MEASURE, grep for the measure,
     not for the screen. `surplus`/`need` survive here only as the "cannot even field it" special case.

   WHAT EACH POSITION NOW REPORTS:
     • WHERE I RANK — 4th of 12 at running back. The only statement that means the same thing in week 2 as
       in week 12, which is the failure that made the old read useless early (nobody clears an absolute
       line yet, so every position read "no market").
     • WHAT I COULD ACTUALLY MOVE — a named player, his marginal cost to my lineup and his worth to a team
       that needs him. Flex-aware because the cost comes from re-solving the lineup; see `movable`.
     • WHO IS SHORT AND WHO IS DEEP — counted from the same rank thirds, so this section and the partner
       list cannot disagree about which teams are thin at a position.
     • AND THE VERDICT IN ONE WORD, because a to-do list is what he asked this tab to be.

   ⭐⭐⭐⭐⭐ AND IN b151 IT LEARNED ABOUT THE DEALS, which is what it was missing.
   ==================================================================================================
   Trey: "I still think we need to dig into 'potential positional trade considerations' — for example,
   it's saying not to move WR... but as you can see, my RB is brutal... my WR is strong and I have depth.
   It's probably worth while to move a WR for RB if I have the depth and not just quality."

   ⚠⚠ `movable` ASKS "CAN I LOSE HIM FOR FREE", AND THAT IS THE WRONG QUESTION FOR A RESHAPE. In a
     2WR+FLEX league a man with four receivers starts three of them, so only the fourth can ever come out
     for nothing — and if that fourth is below replacement he is worth nothing to anybody either. Both
     tests fail, the position reads HOLD, and the screen tells a manager with the best receiver room in
     the league and the third-worst backs to leave it alone. He is right and the measure was wrong: the
     question is not "is he spare" but "does what he brings back exceed what he costs me".

   ⭐ THAT QUANTITY ALREADY EXISTS — it is `myGain` on every offer the finder produced, which is the
     difference between two solved lineups and therefore counts the cost of losing the man AND the gain
     from the man arriving. So the verdict now reads the DEALS: a position you can send from is one an
     actual offer sends from, and the row names that offer. ⚠ Which also makes this section and the deal
     list agree by construction rather than by coincidence — the failure mode this file has hit twice.
   ⚠ `offers` IS OPTIONAL. Without it the function behaves exactly as it did in 29aj, because a caller
     that has not run the finder is not a caller that should get silence. */
export function marketSummary(reads, req, opts) {
  const R = (reads || []).filter(Boolean);
  if (!R.length) return [];
  const me = R.find((t) => t.isMe) || null;
  const teams = R.length;
  const offers = (opts && Array.isArray(opts.offers)) ? opts.offers : [];
  /* The best REALISTIC offer that sends from / receives at each position. Realistic rather than merely
     possible, because this section is a to-do list: an idea nobody would accept is not a thing to do. */
  const bestBy = (pick, pos) => offers
    .filter((t) => t && t.realism >= 45 && t.give && t.get && String(pick(t).pos).toUpperCase() === pos)
    .sort((a, b) => b.myGain - a.myGain)[0] || null;
  const out = [];
  Object.keys(req || {}).forEach((pos) => {
    if (!(req[pos] > 0)) return;

    /* Deep and thin are the rank thirds `teamReads` already computed — NOT a second definition. The old
       code's `buyers`/`sellers` were bodies over a line, which is how a position could report "nobody has
       a spare" in a league where four teams were plainly deep there. */
    const deep = R.filter((t) => !t.isMe && (t.strongAt || {})[pos] != null);
    const thin = R.filter((t) => !t.isMe && (t.thinAt || {})[pos] != null);
    // The sharper fact, kept because when it is true it beats any ranking: they cannot field the position.
    const cantField = R.filter((t) => !t.isMe && (t.need || {})[pos] > 0);
    // Teams that hold a genuinely movable asset here — priced, flex-aware, and named on their own cards.
    const holders = R.filter((t) => !t.isMe && (t.movable || {})[pos]);

    const myRank = me ? (me.posRank || {})[pos] || null : null;
    const myMovable = me ? (me.movable || {})[pos] || null : null;
    const iAmThin = !!(me && (me.thinAt || {})[pos] != null);
    const iAmStrong = !!(me && (me.strongAt || {})[pos] != null);
    const iCantField = !!(me && (me.need || {})[pos] > 0);

    /* ⭐⭐⭐ THE VERDICT, AND IT IS DELIBERATELY ALLOWED TO SAY "SELL" AT A POSITION I RANK BADLY AT.
       That is Trey's own correction from 29ai — "It's not always about having a spare, but rather having
       value that you can move from there to reshape your team" — and it is the case the old rule could
       not express at all: the 10th-best back room in the league can still contain one man worth more to
       somebody else than he is to me. Being short comes first, because a hole you cannot field is the
       only thing on this tab that costs you points every single week. */
    /* ⭐⭐⭐⭐⭐ b151 — A REAL OFFER OUTRANKS EVERY READ ABOVE. `sendFrom` is the best realistic deal that
       sends a player FROM this position, `getAt` the best one that brings a player TO it; both are
       measured in `myGain`, which is the difference between two solved lineups and therefore already
       counts what leaving costs me. That is the "does moving him buy more than he costs" test Trey
       described, and it is the one `movable` could not express. */
    const sendFrom = bestBy((t) => t.give, pos);
    const getAt = bestBy((t) => t.get, pos);

    /* ⚠ A DEAL, WHERE THERE IS ONE, DECIDES THE VERDICT — and each position gets exactly ONE role in it,
       or the same swap prints twice in two rows saying the same sentence (which is what the first cut of
       this did: RB and WR both read "Send WR4 for RB1"). The position a player ARRIVES at is a buy; the
       position he LEAVES is a sell; a position doing both is the rare genuine two-way. */
    let side = 'set';
    if (getAt && sendFrom) side = 'buy';
    else if (getAt) side = 'buy';
    else if (sendFrom) side = 'sell';
    else if (iCantField || iAmThin) side = 'buy';
    else if (myMovable && myMovable.edge > 0) side = 'sell';
    const twoWay = !!(getAt && sendFrom);

    /* ⚠ THE MARKET TONE IS STILL A RATIO — that part of the old function was right. What changed is what
       the two sides are counted from. A position where eight of twelve are thin is a queue, not a market,
       and that is worth knowing BEFORE you spend a week asking. */
    const tone = !holders.length ? 'none'
      : thin.length > holders.length * 2 ? 'sellers'
        : holders.length > thin.length * 2 ? 'buyers' : 'balanced';

    const marketNote = tone === 'none'
      ? `Nothing movable at ${pos} anywhere in the league — whatever you get here, you will overpay for.`
      : tone === 'sellers' ? `${thin.length} teams are short at ${pos} and only ${holders.length} hold anything movable — you would be bidding against the room.`
        : tone === 'buyers' ? `${holders.length} teams hold a movable ${pos} and only ${thin.length} are short — this is where your value goes furthest.`
          : `${holders.length} hold a movable ${pos}, ${thin.length} are short — an ordinary market.`;

    /* The action line names a PLAYER wherever there is one to name. "You have depth at RB" is not
       something you can send anybody; "Kenneth Walker costs your lineup 1.2 a week and is worth 9.4 to a
       team that needs a back" is. */
    /* ⭐⭐⭐⭐ THE LINE LEADS WITH THE DEAL WHEN THERE IS ONE. A concrete "send X to Y for Z" is worth more
       than any amount of description of the market it sits in, and it is the thing he can act on in the
       next five minutes. The market read survives underneath as `marketNote`. */
    const dealLine = getAt
      ? `Get ${getAt.get.name} from ${getAt.team.teamName} — it costs you ${getAt.give.name} (${String(getAt.give.pos).toUpperCase()}), and your lineup is +${getAt.myGain} for it.`
      : sendFrom
        /* ⚠ b153 — THEIR SIDE CAN BE NEGATIVE NOW (see the tilt band in tradeBoard), and a hard-coded
           plus renders "+-18 to theirs". Two characters, and it is the kind of thing that makes a reader
           stop trusting every other number on the page. */
        ? `Send ${sendFrom.give.name} to ${sendFrom.team.teamName} for ${sendFrom.get.name} (${String(sendFrom.get.pos).toUpperCase()}) — +${sendFrom.myGain} to your lineup, ${sendFrom.theirGain > 0 ? `+${sendFrom.theirGain} to theirs` : sendFrom.theirGain === 0 ? 'no change to theirs' : `${sendFrom.theirGain} to theirs, so it is an ask`}.`
        : null;
    /* ⭐⭐⭐⭐ WHO THIS ROW IS ABOUT, DECIDED ONCE — b151. The chip beside the position used to pick its own
       player from the same three candidates in its own order, and on a two-way row (a deal arriving AND a
       deal leaving) the two chose differently: the line said "Get Justin Jefferson" and the chip four
       pixels below said "Travis Hunter". Found by a check written for exactly this fault one section
       earlier, in a different column. The precedence lives here, with the sentence it has to match. */
    const subject = getAt ? getAt.get.name
      : sendFrom ? sendFrom.give.name
        : (myMovable && myMovable.name) || null;

    const action = dealLine ? dealLine
      : side === 'buy'
      ? (iCantField
        ? `You cannot field ${req[pos]} at ${pos}. ${holders.length ? `${holders.length} team${holders.length === 1 ? ' holds' : 's hold'} one they can move.` : 'Nobody has one to spare, so this is a waiver problem, not a trade one.'}`
        : `You rank ${ord(myRank)} of ${teams} at ${pos}. ${deep.length ? `${deep.length} team${deep.length === 1 ? ' is' : 's are'} in the top third here.` : 'Nobody is notably deep, so expect to pay up.'}`)
      : side === 'sell'
        /* ⚠ "costs your lineup 0 a week" IS A SENTENCE NOBODY WRITES. It is also the most common case and
           the best news on the row — a man your best lineup does not use at all — so it gets words rather
           than a zero. (Caught by reading sim/posmarket.js §3's own output, which is what printing the
           pick in the PASS line is for.) */
        /* ⚠ "a week" WAS WRONG BY A FACTOR OF SEVENTEEN — b151. This screen works in SEASON value (the tab
           says so in its own opening line, and `seasonRosterOf` is what feeds it), so a cost of 40 is
           forty points across a season, not forty a week. Nobody would have noticed from the number; they
           would simply have believed a much bigger claim than the app was making. */
        ? `${myMovable.name || pos} ${myMovable.cost > 0 ? `costs your lineup ${myMovable.cost} in season value` : 'is not in your best lineup at all'} and is worth ${myMovable.worth} to a team that needs him`
          + `${thin.length ? ` — ${thin.length} ${thin.length === 1 ? 'is' : 'are'} short at ${pos}${cantField.length ? `, ${cantField.length} cannot field it at all` : ''}.` : ', but nobody here is short there.'}`
        /* ⭐⭐⭐⭐⭐ AND "LEAVE IT ALONE" HAS TO JUSTIFY ITSELF — b151. Trey, at a position he is first in the
           league at: "it's saying not to move WR... but my RB is brutal... my WR is strong and I have
           depth." Sometimes the maths genuinely disagrees with that instinct — three receivers in a
           2WR+FLEX lineup all START, so the third is worth his full value in the flex and no back on the
           market is worth more — and when it does, the answer is to SHOW THE ARITHMETIC rather than to
           assert a verdict. A bare "nothing here is worth more to somebody else than it is to you" reads
           as the app not having looked, which is exactly how he read it.
           ⚠ The cheapest man to lose is named even when the answer is no, because "which one did you even
             consider" is the first question anybody would ask of this row. */
        : (() => {
          const cheapest = me && (me.cheapest || {})[pos];
          const where = iAmStrong ? `You rank ${ord(myRank)} of ${teams} at ${pos}` : `You rank ${ord(myRank)} of ${teams}`;
          if (cheapest && cheapest.cost > 0) {
            return `${where}, and the best candidate to move — ${cheapest.name} — is worth ${cheapest.cost} in season value to your OWN lineup, more than anything on the market would bring back. Leave it alone.`;
          }
          return `${where} and nothing here is worth more to somebody else than it is to you. Leave it alone.`;
        })();

    out.push({
      pos, myRank, teams, side, twoWay, tone,
      iAmThin, iAmStrong, iCantField,
      movable: myMovable, subject,
      /* The two offers this verdict was built from, so the row can link straight into the calculator and
         a suite can hold the panel against the deal list. */
      sendFrom: sendFrom ? { sid: sendFrom.give.sid, name: sendFrom.give.name, to: sendFrom.team.teamName,
        getName: sendFrom.get.name, getPos: String(sendFrom.get.pos).toUpperCase(), getSid: sendFrom.get.sid,
        rosterId: sendFrom.team.rosterId, myGain: sendFrom.myGain, theirGain: sendFrom.theirGain } : null,
      getAt: getAt ? { sid: getAt.get.sid, name: getAt.get.name, from: getAt.team.teamName,
        giveName: getAt.give.name, givePos: String(getAt.give.pos).toUpperCase(), giveSid: getAt.give.sid,
        rosterId: getAt.team.rosterId, myGain: getAt.myGain, theirGain: getAt.theirGain } : null,
      deep: deep.length, thin: thin.length, cantField: cantField.length, holders: holders.length,
      deepTeams: deep.map((t) => t.teamName), thinTeams: thin.map((t) => t.teamName),
      cantFieldTeams: cantField.map((t) => t.teamName),
      holderTeams: holders.map((t) => ({ teamName: t.teamName, player: (t.movable[pos] || {}).name || null })),
      action, marketNote,
      /* ⚠ `note` IS KEPT UNDER ITS OLD NAME because two callers read it and renaming a field is not a
         behaviour change worth risking in the same build as a rebuild of what it contains. */
      note: marketNote,
    });
  });
  /* Ordered by where HE can act, which is what makes this a to-do list rather than a reference table:
     a position that is both a hole and a source first, then holes, then things to sell, then the rest. */
  const rankOf = (m) => (m.twoWay ? 0 : m.side === 'buy' ? 1 : m.side === 'sell' ? 2 : 3);
  return out.sort((a, b) => rankOf(a) - rankOf(b) || a.pos.localeCompare(b.pos));
}

/* ⭐⭐⭐⭐⭐ THE LEAGUE READ — 29ah, and the reason it exists is that the deal board was not answering
 * the question.
 * ==================================================================================================
 * Trey, on the tab 29af shipped: "I like the calculator portion of it. I like the information that it
 * shares back with you... it still isn't clear to me though that it is sharing information that's gonna
 * like help you beat the league. Like identifying trends as to what teams might be the best partner for
 * a trade, who is underutilizing the roster... or is there a certain team where like both sides just
 * benefit so much that it makes sense? Do you have a depth in a certain area that you should definitely
 * move? Basically, like what is it that's going to increase your playoff odds the most? That is also
 * realistic. That's key."
 *
 * ⭐ HE IS ASKING FOR A DIFFERENT UNIT OF ANALYSIS, NOT MORE ROWS. 29af ranked INDIVIDUAL DEALS, and a
 *   ranked list of deals is a list of moves; what he wants is a read on the LEAGUE — which of eleven
 *   managers is worth opening a conversation with, and why that one. Those are not the same object.
 *   Five deals with three managers tells you nothing about the other eight teams, and the eight might
 *   include the one whose roster is the mirror image of yours.
 *
 * So this aggregates the SAME offers up to the partner, and answers per team:
 *   • can we help each other AT ALL (a double coincidence of wants — see `complement`)
 *   • how much do we BOTH gain (`mutual`, which is deliberately the MINIMUM of the two gains)
 *   • is this manager motivated (the underperformer read from teamReads)
 *   • what is the single best thing available with them, and is it realistic
 *
 * ⚠ `mutual` IS THE MINIMUM OF THE TWO GAINS, NOT THE SUM. "Both sides benefit so much that it makes
 *   sense" is a statement about the WEAKER half: a deal worth +80 to me and +2 to them is not mutual, it
 *   is a deal I want, and summing them (+82) would rank it above a genuine +30/+30 that any manager
 *   would take on sight. The minimum is the only summary that cannot be gamed by one big side.
 */

/* ⭐⭐⭐⭐⭐ WHICH RACE IS ACTUALLY STILL LIVE — and this was a MEASURED finding, not a design choice.
   He said the headline should be "what is going to increase your playoff odds the most". Ranking by that
   was the plan until it was run against his own league: he is first at 99.5% to make the playoffs, so
   EVERY trade on the board moved playoff odds by +0.0% and the ranking was a column of zeroes. The
   honest headline is not playoff odds, it is THE TIGHTEST THING STILL IN PLAY — and saying so out loud
   ("you are already in; this is what a bye is worth") is more useful than a number that cannot move.
   ⚠ 92 RATHER THAN 100, because a 97% race is not a race: the remaining 3% is simulation noise around a
     conclusion already reached, and ranking trades by it would sort on nothing. */
export function raceCurrency(odds) {
  const o = odds || {};
  /* ⚠⚠ `Number(null)` IS 0 AND `Number.isFinite(0)` IS TRUE — this project's own oldest logged trap, and
     I walked into it again here. A league with no first-round byes reports `byeOdds: null`, which this
     turned into a live 0% race: the header read "ranked by a first-round bye — currently 0%" in a league
     that has no byes at all, and every gain under it would have been +0.0%, which is the exact failure
     raceCurrency exists to prevent. Reject null BEFORE converting, never after. */
  const n = (v) => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
  const made = n(o.odds), bye = n(o.byeOdds), one = n(o.oneSeed);
  if (made != null && made < 92) return { key: 'odds', label: 'playoff odds', at: made, locked: false };
  if (bye != null && bye < 92) return { key: 'byeOdds', label: 'a first-round bye', at: bye, locked: true };
  if (one != null && one < 92) return { key: 'oneSeed', label: 'the 1 seed', at: one, locked: true };
  /* Everything is settled — which is a real answer and the screen says it rather than printing +0.0%
     next to five recommendations and letting him work out why they are all the same. */
  return { key: null, label: null, at: made, locked: true };
}

export function partnerBoard(input) {
  const o = input || {};
  const offers = Array.isArray(o.offers) ? o.offers : [];
  const reads = new Map((o.reads || []).map((r) => [r.rosterId, r]));
  const mine = o.myRead || null;
  const req = o.req || {};

  /* ── WHO CAN HELP WHOM, BEFORE ANY DEAL IS ENUMERATED ─────────────────────────────────────────────
     ⚠ THIS IS COMPUTED FROM THE ROSTER SHAPES, NOT FROM THE OFFER LIST, and that is the whole point.
       An offer list only contains teams a swap was FOUND with, so building the partner read out of it
       would silently drop every manager whose fit is real but whose best deal happens to be a two-for-one
       the finder does not enumerate. The complement is a fact about two rosters; the deals are evidence. */
  /* ⭐⭐⭐⭐⭐ WHO FITS WHOM, READ OFF POSITIONAL RANK — rebuilt in 29ai.
     Trey: "It's showing I don't line up with any team. This just can't be the case… I have no good RBs,
     but my WR are legit. I should be matching up with teams that have RB surplus and need WR."
     ⚠⚠ THE OLD VERSION COMPARED SPARE BODIES AGAINST UNFILLED SLOTS, both measured against an ABSOLUTE
       replacement line — and two weeks into a season almost nobody clears an absolute line, so every team
       in his league came back with no need and no surplus and the page told him, eleven times, that
       nothing lined up. A rank cannot do that: somebody is always first at running back.
     ⭐ SO A FIT IS NOW "I am in the bottom third where you are in the top third", which is the sentence he
       used. The startable counts are still carried for the detail line, because "they cannot even field
       two" is a sharper fact than "they rank 9th" when it happens to be true — but it is no longer what
       decides whether two teams have anything to talk about. */
  const complementOf = (them) => {
    const out = [];
    if (!mine || !them) return out;
    const seen = new Set();
    const add = (pos, dir, why) => { const k = pos + dir; if (!seen.has(k)) { seen.add(k); out.push({ pos, dir, why }); } };
    Object.keys(req).forEach((pos) => {
      if (!(req[pos] > 0)) return;
      const iRank = (mine.posRank || {})[pos], theirRank = (them.posRank || {})[pos];
      const iStrong = (mine.strongAt || {})[pos] != null, iThin = (mine.thinAt || {})[pos] != null;
      const theyStrong = (them.strongAt || {})[pos] != null, theyThin = (them.thinAt || {})[pos] != null;
      // I can SELL here: strong for me, weak for them.
      if (iStrong && theyThin) add(pos, 'sell', `you rank ${ord(iRank)} and they rank ${ord(theirRank)}`);
      // I can BUY here: weak for me, strong for them.
      if (iThin && theyStrong) add(pos, 'buy', `they rank ${ord(theirRank)} and you rank ${ord(iRank)}`);
      /* ⚠ THE OLD SIGNAL IS KEPT AS A SECOND ROUTE, NOT DISCARDED. A team that literally cannot field a
         position is a buyer whatever the ranking says, and that is the most actionable fact on the page
         when it is true. It simply can no longer be the ONLY way to qualify.
         ⚠⚠ BUT THE OTHER HALF OF IT IS THE RETIRED MEASURE — 29aj. This said "…and you have one spare",
           which is the exact phrase Trey has now objected to twice, reading a body count that a flex slot
           makes wrong. "Cannot field it" is a real fact and stays; what I have to offer is `movable`,
           which is priced against my own solved lineup and, better, has a NAME on it. */
      const theyNeed = (them.need || {})[pos] || 0, iNeed = (mine.need || {})[pos] || 0;
      const iCanMove = (mine.movable || {})[pos] || null, theyCanMove = (them.movable || {})[pos] || null;
      if (iCanMove && theyNeed > 0) {
        add(pos, 'sell', `they cannot field ${req[pos]} and you have ${iCanMove.name || `a ${pos}`} to move`);
      }
      if (theyCanMove && iNeed > 0) {
        add(pos, 'buy', `you cannot field ${req[pos]} and they have ${theyCanMove.name || `a ${pos}`} to move`);
      }
    });
    return out;
  };

  const byTeam = new Map();
  offers.forEach((t) => {
    const id = t && t.team && t.team.rosterId;
    if (id == null) return;
    if (!byTeam.has(id)) byTeam.set(id, []);
    byTeam.get(id).push(t);
  });

  const partners = (o.others || []).map((them) => {
    const read = reads.get(them.rosterId) || null;
    const list = (byTeam.get(them.rosterId) || []).slice()
      /* Realistic first, then by what it does for me — the same ordering rule the cards use, so the
         partner list and the deals inside it can never disagree about which idea is the best one. */
      .sort((a, b) => (b.realism >= 45) - (a.realism >= 45) || (b.myGain - a.myGain));
    const best = list[0] || null;
    const realistic = list.filter((t) => t.realism >= 45);
    /* ⭐⭐⭐⭐⭐ WHAT THE ROW SHOWS IS `ideas`, NOT `realistic` — b153.
       Trey: "I really just want this to spark ideas or starting points."
       ⚠ A 45-REALISM BAR IS THE RIGHT FILTER FOR A RECOMMENDATION AND THE WRONG ONE FOR A PROMPT. The
         cards at the top of the tab say "do this", and they should stay strict. This table answers "is
         there anything here with this manager", and answering "no" because the one idea available is a
         62% ask rather than a 70% one is how three columns end up blank on a screen that had seven
         priced, fair, measured ideas sitting behind it — which is exactly what the probe found.
       ⭐ SO: realistic ones when they exist, the best of the rest when they do not, and every row carries
         its own `band` and `tilt` so nothing is dressed up as likelier than it is. */
    const ideas = (realistic.length ? realistic : list).slice(0, 3);
    const comp = complementOf(read);
    const twoWay = comp.some((c) => c.dir === 'sell') && comp.some((c) => c.dir === 'buy');
    const mutual = best ? r1(Math.min(best.myGain, best.theirGain)) : 0;

    /* ⭐⭐⭐ ONE LINE SAYING WHY THIS MANAGER, ordered by which fact would actually change your mind.
       A two-way fit outranks everything — it is the only situation where you are not asking for a
       favour — then a motivated owner, then a plain one-way fit. */
    /* ⭐⭐⭐⭐⭐ THE FIT IS DESCRIBED WHETHER OR NOT A SWAP CAME OUT OF IT — 29ai, and the old version
       getting this wrong is most of why he saw "nothing lines up" eleven times. Both the fit branches
       used to require `realistic.length`, so a manager whose roster is the exact mirror of yours was
       reported as having nothing to offer purely because the one-for-one finder came back empty. That is
       the opposite of the design — sim/partners.js §3 even hands the function zero deals and requires the
       read to survive — and the test missed it because it checked the complement and the flags and never
       read the sentence. A shape fit is a fact about two rosters; a deal is a convenience. */
    let tone = 'none', why = null;
    const sell = comp.find((c) => c.dir === 'sell'), buy = comp.find((c) => c.dir === 'buy');
    /* ⚠ b153 — THREE STATES, NOT TWO. "No clean swap" was being printed at a manager the finder had
       priced two fair ideas with, because neither cleared the recommendation bar. That sentence is only
       true when there is genuinely nothing. */
    const noDeal = realistic.length ? ''
      : ideas.length ? ` Nothing here improves both starting lineups, but ${ideas.length === 1 ? 'one idea is' : `${ideas.length} ideas are`} fair on value and tilt your way — open the row.`
        : ' No one-for-one or package came out of it — worth a message anyway, or build one below.';
    if (sell && buy) {
      tone = 'mutual';
      why = `Straight fit both ways — they are short at ${sell.pos} where you are strong (${sell.why}), and deep at ${buy.pos} where you are short.${noDeal}`;
    } else if (buy) {
      tone = 'fit';
      /* ⚠ NOT "they can spare a TE" — 29aj. Grammatically it is the verb rather than the retired noun, but
         it is the same idea and the same word Trey has objected to twice, and a screen that says "spare"
         anywhere invites the reader to believe a body count is still behind one of these numbers. What
         they have is something they can MOVE, which is a priced statement about their own lineup. */
      why = `They have a ${buy.pos} to move and you are short one — ${buy.why}.${noDeal}`;
    } else if (sell) {
      tone = 'fit';
      why = `They are short at ${sell.pos} and you are strong there — ${sell.why}.${noDeal}`;
    } else if (read && read.underperforming && ideas.length) {
      tone = 'motivated';
      why = read.ownerNote;
    } else if (ideas.length) {
      /* ⚠ b153 — `ideas`, NOT `realistic`. A manager sitting on the single biggest gain available to you
         was being filed under "not worth chasing" and folded away behind a button, because the one idea
         with him was a 26-realism ask. The probe's top row was exactly this. */
      tone = 'thin';
      why = ideas.length > 1
        ? `No obvious shape fit — what is here is ${ideas.length} straight value swaps.`
        : 'No obvious shape fit — the one idea here is a straight value swap.';
    } else {
      tone = 'none';
      why = read && read.overperforming
        ? 'Nothing lines up — and they are getting the most out of their roster, so they have little reason to move.'
        : 'Your rosters are strong and weak in the same places, so neither of you has anything the other needs.';
    }

    /* ⭐⭐⭐⭐ THE TWO COLUMNS THE TABLE DRAWS — b151, and they come from the DEALS first.
       `complement` is a shape read off positional ranks, and a manager can have three realistic ideas
       without one: a screenshot of the new table showed a row reading "You send —" beside "3 ideas",
       which is the table arguing with its own last column. Where there are deals, the positions in them
       ARE the answer; the rank-based complement fills in for a manager the finder came up empty on, which
       is the case it was built for. */
    /* ⚠ b153 — DERIVED FROM `ideas`, THE SAME LIST THE ROW EXPANDS TO. Reading them off `realistic` while
       the Ideas column counted something else is how b151's "You send —" beside "3 ideas" happened; the
       fix then was to stop using the rank complement, and the fix now is to use the one list. */
    const posOf = (t, dir) => String((dir === 'sell' ? t.give : t.get).pos).toUpperCase();
    const dealSend = [...new Set(ideas.flatMap((t) => [String(t.give.pos).toUpperCase()]
      .concat(t.give2 ? [String(t.give2.pos).toUpperCase()] : [])))];
    const dealGet = [...new Set(ideas.map((t) => String(t.get.pos).toUpperCase()))];
    const merge = (fromDeals, dir) => {
      const out2 = fromDeals.map((pos) => {
        const c = comp.find((x) => x.dir === dir && x.pos === pos);
        const n = ideas.filter((t) => posOf(t, dir) === pos
          || (dir === 'sell' && t.give2 && String(t.give2.pos).toUpperCase() === pos)).length;
        return { pos, dir, why: c ? c.why : `${n} of the ideas with them ${dir === 'sell' ? 'send' : 'bring back'} a ${pos}` };
      });
      comp.filter((c) => c.dir === dir && !fromDeals.includes(c.pos)).forEach((c) => out2.push(c));
      return out2;
    };
    const columns = merge(dealSend, 'sell').concat(merge(dealGet, 'buy'));

    return {
      rosterId: them.rosterId, teamName: them.teamName, ownerName: them.ownerName,
      read, best, deals: list, realisticN: realistic.length,
      // b153 — what the row actually offers to open, and how many. See `ideas` above.
      ideas, ideaN: ideas.length, tilt: best ? best.tilt || 'both' : null,
      myGain: best ? best.myGain : 0, theirGain: best ? best.theirGain : 0, mutual,
      realism: best ? best.realism : 0, complement: comp, columns, twoWay, tone, why,
    };
  });

  /* ⚠ RANKED BY WHAT IS REALISTICALLY AVAILABLE, NOT BY WHAT IS IMAGINABLE. A partner whose only idea is
     a 20-realism long shot sorts below one with a modest deal they would actually take — which is the
     "That is also realistic. That's key." half of what he asked for, applied to the partner list rather
     than only to the individual cards. */
  partners.sort((a, b) =>
    (b.realisticN > 0) - (a.realisticN > 0)
    // b153 — then "has anything at all", so a manager with a tilted idea outranks one with nothing.
    || (b.ideaN > 0) - (a.ideaN > 0)
    || (b.twoWay - a.twoWay)
    || (b.myGain - a.myGain)
    || (b.realism - a.realism));

  /* ── WHAT YOU CAN TRADE FROM ─────────────────────────────────────────────────────────────────────
     ⭐⭐⭐⭐⭐ REBUILT IN 29ai ON WHAT HE SAID, WHICH WAS A BETTER IDEA THAN THE ONE IT REPLACES.
     Trey: "I also rank 10th of 12 in RBs, but it says I have +1 spare. Well, I suck at that position, so
     I probably don't have a spare. It's not always about having a spare, but rather having value that
     you can move from there to reshape your team."
     ⭐ THAT IS TWO SEPARATE CLAIMS AND BOTH ARE RIGHT. The first: a headcount over a replacement line is
       not depth, and calling the 10th-best back room in a 12-team league "spare" is the kind of advice
       that costs a tool its credibility. The second is the better model — a position is a place you can
       TRADE FROM when moving your second man there costs your lineup little and is worth a lot to
       somebody else, and that can be true at a position you are bad at and false at one you are good at.
     ⭐ SO THE MEASURE IS `cost` — what my optimal lineup loses if this man leaves — AGAINST `worth`, what
       he adds to a lineup that needs him. Low cost and real worth is a tradeable asset. That is the same
       quantity 29ac introduced for the other side of the market (`costMapOf`), pointed at my own roster.
     ⚠ AND THE HEADLINE IS THE PLAYER, NOT THE POSITION, because "RB" is not something you can offer
       anybody. Every row names the man it is talking about, which is also what he asked for when he said
       he could not tell what "1 spare starter" meant. */
  const mySurplus = [];
  if (mine && typeof o.costOf === 'function') {
    const byPos = new Map();
    (o.myRoster || []).forEach((p) => {
      const pos = String(p && p.pos || '').toUpperCase();
      if (!pos || !(req[pos] > 0)) return;
      if (!byPos.has(pos)) byPos.set(pos, []);
      byPos.get(pos).push(p);
    });
    byPos.forEach((list, pos) => {
      /* The candidate is the cheapest man to lose who is still worth something — not the worst player
         at the position (nobody wants him) and not the best (you are not selling him). */
      /* ⚠ AND THE TIE BREAKS ON COST — 29aj, the same correction `movable` needed. Four elite receivers
         put my WR1 and my WR4 on an identical edge, and a sort with no tie-break hands back whichever the
         comparator happened to leave first. "Offer your best receiver" and "offer your fourth" are the
         same number and opposite advice. */
      const priced = list.map((p) => ({ p, cost: o.costOf(p), worth: o.worthOf ? o.worthOf(p) : 0 }))
        .filter((x) => x.worth > 0)
        .sort((a, b) => ((b.worth - b.cost) - (a.worth - a.cost)) || (a.cost - b.cost));
      const pick = priced[0];
      if (!pick || pick.worth - pick.cost <= 0) return;
      const buyers = partners.filter((p) => ((p.read && p.read.thinAt) || {})[pos] != null
        || ((p.read && p.read.need) || {})[pos] > 0);
      const cantField = partners.filter((p) => ((p.read && p.read.need) || {})[pos] > 0);
      const best = partners
        .flatMap((p) => p.deals.filter((t) => t.give.pos === pos && t.realism >= 45).map((t) => ({ ...t, partner: p })))
        .sort((a, b) => b.myGain - a.myGain)[0] || null;
      mySurplus.push({ pos, player: pick.p, cost: r1(pick.cost), worth: r1(pick.worth),
        edge: r1(pick.worth - pick.cost),
        myRank: (mine.posRank || {})[pos] || null, teams: mine.teams || null,
        buyers: buyers.length, cantField: cantField.length, best,
        buyerNames: buyers.slice(0, 3).map((p) => p.teamName || p.ownerName || 'a team'),
        cantFieldNames: cantField.slice(0, 3).map((p) => p.teamName || p.ownerName || 'a team') });
    });
    /* Ranked by what the move is actually worth to somebody, then by how many of them there are. */
    mySurplus.sort((a, b) => b.edge - a.edge || b.buyers - a.buyers);
  }

  return { partners, mySurplus, twoWayN: partners.filter((p) => p.twoWay).length,
    motivated: partners.filter((p) => p.read && p.read.underperforming && p.realisticN > 0) };
}
