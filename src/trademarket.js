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
const clean = (roster) => (roster || []).filter((p) => p && p.sid != null && p.pos);

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

  return teams.map((t) => {
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

    return {
      rosterId: t.rosterId, teamName: t.teamName, ownerName: t.ownerName, isMe: !!t.isMe,
      startable, have, surplus, need,
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
  const diag = { pairs: 0, lopsided: 0, noGainForMe: 0, noGainForThem: 0, wash: 0, teams: others.length };
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
        // The same 0.5 band the shipped finder settled on in 29w, for the same reason — see findTrades.
        if (lo / hi < 0.5) { diag.lopsided++; return; }

        const myAfter = lineupValue(me.roster.filter((p) => p.sid !== give.sid).concat([get]), sf);
        const myGain = r1(myAfter - myBase);
        if (myGain <= 0.5) { diag.noGainForMe++; return; }
        const theirAfter = lineupValue(theirRestNoGet.concat([give]), sf);
        const theirGain = r1(theirAfter - theirBase);
        if (theirGain <= 0.5) { diag.noGainForThem++; return; }

        // ── the reasons, each one a measured thing ──────────────────────────────────────────────
        const why = [];
        const theirStartable = (read && read.startable) ? (read.startable[pos] || 0) : null;
        const theirNeedAt = (read && read.need) ? read.need[gPos] || 0 : 0;
        const theirSurplusAt = (read && read.surplus) ? read.surplus[pos] || 0 : 0;
        const myNeedAt = (myRead && myRead.need) ? myRead.need[pos] || 0 : 0;
        const mySurplusAt = (myRead && myRead.surplus) ? myRead.surplus[gPos] || 0 : 0;

        if (fitEdge >= 8) {
          why.push({ key: 'fit', weight: 3,
            /* ⚠ "adds" AND "costs", NOT TWO BARE NUMBERS. These are the value of ACQUIRING him and the
               value of LOSING him, which is not what the headline figure above is (that one is net of
               what you send back) — and three unlabelled numbers on one card that do not add up is how a
               reader decides the whole page is approximate. */
            text: `He is worth ${r1(fitEdge)} more to you than to them — he adds ${myAdd} to your lineup and costs them ${theirLoss}.` });
        }
        if (theirSurplusAt > 0) {
          why.push({ key: 'depth', weight: 2,
            text: `They can spare him: ${theirStartable} startable ${pos}${theirStartable === 1 ? '' : 's'} for ${req[pos] || 0} slot${(req[pos] || 0) === 1 ? '' : 's'}.` });
        }
        if (mySurplusAt > 0) {
          why.push({ key: 'mydepth', weight: 1,
            text: `And you can spare ${give.name || 'him'} — you are ${mySurplusAt} deep at ${gPos} beyond what you start.` });
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
        else { realism += 4; parts.push('a small gain for them'); }
        if (theirNeedAt > 0) { realism += 20; parts.push(`fills their hole at ${gPos}`); }
        if (theirSurplusAt > 0) { realism += 10; parts.push(`costs them spare ${pos} depth`); }
        if (read && read.underperforming) { realism += 5; parts.push('a team with reason to shake things up'); }
        const balance = Math.round((lo / hi) * 100);
        if (balance >= 80) { realism += 10; parts.push('close on value'); }
        else if (balance < 60) { realism -= 10; parts.push('lopsided on value'); }
        /* ⚠⚠ THE BIG NEGATIVE, AND THE ONE THE OLD FINDER HAD NO WAY TO EXPRESS. Nobody trades the best
           player they own for positional fit, however well the lineup maths works out. */
        if (theirBest && theirBest.sid === get.sid) { realism -= 30; parts.push(`he is the best player they own`); }
        realism = Math.max(0, Math.min(99, realism));

        offers.push({
          team: { rosterId: them.rosterId, teamName: them.teamName, ownerName: them.ownerName },
          read, give, get, myGain, theirGain, fitEdge, myAdd, theirLoss, balance,
          giveWorth: Math.round(wGive), getWorth: Math.round(wGet),
          why: why.sort((a, b) => b.weight - a.weight),
          realism, realismWhy: parts,
          band: realism >= 65 ? 'likely' : realism >= 45 ? 'worth asking' : 'long shot',
        });
      });
    });
  });

  /* ⭐⭐⭐⭐ ONE IDEA PER TARGET, AND AT MOST TWO INVOLVING ANY ONE OF MY PLAYERS. You can only trade a man
     once, and five variations on the same target is one idea wearing five rows — which is a large part of
     what made the old list "difficult to follow". */
  const seen = new Set(), giveCount = {}, dedup = [];
  offers
    .sort((a, b) => (b.myGain - a.myGain) || (b.realism - a.realism))
    .forEach((t) => {
      const k = `${t.team.rosterId}|${t.get.sid}`;
      if (seen.has(k)) return;
      if ((giveCount[t.give.sid] || 0) >= 2) return;
      seen.add(k);
      giveCount[t.give.sid] = (giveCount[t.give.sid] || 0) + 1;
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
export function marketSummary(reads, req) {
  const R = (reads || []).filter(Boolean);
  if (!R.length) return [];
  const out = [];
  Object.keys(req || {}).forEach((pos) => {
    if (!(req[pos] > 0)) return;
    const buyers = R.filter((t) => (t.need && t.need[pos] > 0));
    const sellers = R.filter((t) => (t.surplus && t.surplus[pos] > 0));
    const me = R.find((t) => t.isMe) || null;
    const mySide = me ? (me.need && me.need[pos] > 0 ? 'buy' : me.surplus && me.surplus[pos] > 0 ? 'sell' : 'set') : null;
    /* ⚠ THE READ IS ABOUT THE RATIO, NOT THE COUNTS. "4 sellers" means nothing without knowing there are
       9 buyers; a seller's market and a buyer's market look identical if you only print one side. */
    const tone = sellers.length === 0 ? 'none'
      : buyers.length > sellers.length * 2 ? 'sellers'
        : sellers.length > buyers.length * 2 ? 'buyers' : 'balanced';
    out.push({
      pos, buyers: buyers.length, sellers: sellers.length, tone, mySide,
      buyerTeams: buyers.map((t) => t.teamName), sellerTeams: sellers.map((t) => t.teamName),
      note: tone === 'none' ? `Nobody in this league has a spare ${pos}. Whatever you get here, you will overpay for.`
        : tone === 'sellers' ? `${buyers.length} teams need a ${pos} and only ${sellers.length} can spare one — you will be bidding against the room.`
          : tone === 'buyers' ? `${sellers.length} teams have spare ${pos}s and only ${buyers.length} need one — this is where your money goes furthest.`
            : `${sellers.length} can spare a ${pos}, ${buyers.length} need one — an ordinary market.`,
    });
  });
  /* Ordered by where HE can act: the positions he is short at first, then where he has something to sell,
     then the rest. A market view sorted alphabetically is a reference table; this is a to-do list. */
  const rankOf = (m) => (m.mySide === 'buy' ? 0 : m.mySide === 'sell' ? 1 : 2);
  return out.sort((a, b) => rankOf(a) - rankOf(b) || a.pos.localeCompare(b.pos));
}
