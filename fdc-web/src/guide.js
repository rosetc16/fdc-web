/* ═══════════════════════════════════════════════════════════════════════════════════════════════════
   WHERE EVERYTHING LIVES, AND WHAT EVERY WORD MEANS — b155.
   ───────────────────────────────────────────────────────────────────────────────────────────────────
   Trey: "Can you update the site (especially the non-paid version) to appropriately inform the audience
   of what the site can do (draft and in-season). We also likely need to create some guide or instructions
   on where things are located. It could be a glossary of sorts. Sometimes the site can be hard to
   navigate, so just want to make it easier."

   ⚠⚠ THIS IS DATA, NOT A SCREEN, AND THAT IS THE WHOLE DESIGN. The same content has to appear on the
     marketing site (so a stranger can see the scope before paying) and inside Help (so it is there when
     somebody is lost mid-season). Written twice it drifts within one build — this project has paid for
     "two implementations of one thing" more times than any other single mistake — so it is written once,
     here, and rendered by one component in two places.

   ⚠⚠ AND A GUIDE THAT DESCRIBES A SCREEN THAT DOES NOT EXIST IS WORSE THAN NO GUIDE. Every `find` below
     names a control by the words actually printed on it, and sim/guide.js reads App.jsx and the split
     screens and requires each of those words to be found in the source. When a tab is renamed, that suite
     goes red rather than the guide quietly starting to lie. That check is the reason this file is a flat
     data structure instead of prose.

   ⚠ THE THREE PARTS ARE DELIBERATELY DIFFERENT QUESTIONS:
     TASKS     — "I want to do X." The fastest possible answer, because it is the question people
                 actually have when they are lost. First on the page for that reason.
     MAP       — "What is this screen for?" One entry per place you can end up, with the route to it.
     GLOSSARY  — "What does this number mean?" The app invents vocabulary (movable, fit edge, realism,
                 tier share, blend, edge). Inventing a word and never defining it is how a screen full of
                 real measurements reads as noise.
   ═══════════════════════════════════════════════════════════════════════════════════════════════════ */

/* ⭐ "I WANT TO…" — THE ANSWER IN ONE LINE. `go` is a breadcrumb in the app's own words; anything in
   `words` is extra search vocabulary, because people search for "waiver" on a screen labelled
   "Free agents" and for "bench points" on one labelled "Matchup".

   ⭐⭐⭐⭐ `at` IS WHERE THE BREADCRUMB ACTUALLY GOES — b156. Trey: "doesn't have any hyperlinks to
   anything." A route printed as text is a route you then have to go and find, which on a screen whose
   whole job is "I cannot find things" is close to useless.
   ⚠⚠ IT IS THE FURTHEST UNAMBIGUOUS STEP, NOT THE LAST STEP. Half of these end inside a specific league
     and this file cannot know WHICH league — guessing one would drop somebody into the wrong team's
     Matchup tab, which is worse than not linking at all. So anything league-scoped is `home:teams`: it
     lands on the home page with the teams list scrolled into view, which is the step that is genuinely
     hard to find, and the breadcrumb still names the tab to click once a league is open.
   ⚠ AND IT IS INERT ON THE PUBLIC SITE. A signed-out reader has no leagues and no app to be routed
     into, so the marketing copy of this guide renders the same crumbs as plain text. */
export const GUIDE_TASKS = [
  { want: 'Set my lineup this week',
    go: 'Your teams → open a league → Matchup',
    at: 'home:teams',
    note: 'Bench players who out-project a starter are marked START, and the man they would replace is marked SIT. Hover either one for the two projections.',
    words: 'start sit bench lineup optimizer swap who should I play' },
  { want: 'See every league at once before kickoff',
    go: 'Home → My Week',
    at: 'week:myweek',
    note: 'One row per league: who is questionable, who is on a bye, and which lineups still need a decision.',
    words: 'all leagues sunday morning check injuries byes' },
  { want: 'Watch scores while games are on',
    go: 'Home → Game Day',
    at: 'week:gameday',
    note: 'Live totals across every league, who you need to root for, and how much of each game is still to play.',
    words: 'live scores sunday redzone rooting watching' },
  { want: 'Find a waiver pickup',
    go: 'Your teams → open a league → Free agents',
    at: 'home:teams',
    note: 'Ranked by what they would add to YOUR lineup, not by raw points — with FAAB guidance where the league uses it.',
    words: 'waivers free agent pickup add drop streamer FAAB' },
  { want: 'Work out whether a trade is fair',
    go: 'Your teams → open a league → Trades → Trade Calculator',
    at: 'home:teams',
    note: 'Put players on both sides and it prices the deal for your format, right now and long term.',
    words: 'trade calculator evaluate offer value fair' },
  { want: 'Find a trade to propose',
    go: 'Your teams → open a league → Trades → What moves your season',
    at: 'home:teams',
    note: 'One row per manager: what you would send, what you would get, and what it does to each lineup. Open a row for the actual names.',
    words: 'trade finder partner who to call ideas deals' },
  { want: 'See how my roster stacks up',
    go: 'Your teams → open a league → League',
    at: 'home:teams',
    note: 'Standings, projected finish and power rank in one table, plus positional strength for every team. Hover a manager for their whole roster.',
    words: 'standings power rank projections rivals other teams' },
  { want: 'Look back at my draft',
    go: 'Your teams → open a league → Draft → Draft board or Draft summary',
    at: 'home:teams',
    note: 'The board is every pick round by round; the summary is the grades, the steals and the reaches.',
    words: 'draft results recap grades who I picked board summary' },
  { want: 'Practise before draft night',
    go: 'Home → Run a mock draft',
    at: 'home',
    note: 'Your exact league settings against the real engine. Run as many as you like.',
    words: 'mock practice test rehearse' },
  { want: 'Write a plan before I draft',
    go: 'Home → open a league → Draft plan & trends',
    at: 'home',
    note: 'Targets and rules you set in advance. The draft room holds you to them while you are on the clock.',
    words: 'strategy targets rules plan prepare' },
  { want: 'Change my scoring, roster slots or keepers',
    go: 'Home → open a league → Settings',
    at: 'home',
    note: 'Every number in the app is priced off these, so it is worth getting right first.',
    words: 'settings scoring roster slots keepers league setup format' },
  { want: 'Add my own player rankings',
    go: 'Home → My Rankings',
    at: 'rankings',
    note: 'Your own board, independent of the platform. Attach it to a league and it drives the My ADP and Blend columns in that draft.',
    words: 'rankings my ranks personal board cheat sheet' },
];

/* ⭐⭐⭐⭐⭐ THE OTHER WAY IN — b156. Trey: "it looks like you only hit on the draft (keep that), but
   someone might also be starting just to look at their team in season (doesn't touch on that)."

   ⚠⚠ THE QUICK-START FLOW ASSUMED EVERY NEW ARRIVAL WAS ABOUT TO DRAFT, which is true in August and
     wrong from September onwards — and somebody who signs up in week 6 to sort out a lineup was being
     handed five steps about writing a draft plan for a draft that already happened. The draft track is
     right and stays exactly as it is; this is the second track beside it.
   ⚠ IT IS SHORTER ON PURPOSE. The draft flow is preparation, so it earns five steps; this one is "link
     the account, open the team, here is what the tabs do", and padding it out to five to look symmetrical
     would be making somebody read three steps they do not need. */
export const SEASON_STEPS = [
  ['ti-plug-connected', 'Link your Sleeper account', 'home',
    'One username, once, at the top of your home page. Every league on that account appears under “Your teams” — you do not add them one at a time, and nothing has to have been drafted here for the in-season side to work.'],
  ['ti-calendar-stats', 'Open a team', 'home:teams',
    'That is the league hub: eight tabs covering your week in one league. Summary is the short version of what needs doing; Matchup, Free agents and Trades are where you do it.'],
  ['ti-first-aid-kit', 'Check every league at once', 'week:myweek',
    'My Week is the across-all-leagues view — the lineups still needing a decision, who is questionable, who is on a bye. On a Sunday morning it replaces opening eighteen tabs.'],
  ['ti-activity-heartbeat', 'Follow it live, then look back', 'week:gameday',
    'Game Day is live scores and who to root for while the games are on. Review, on Monday, is what you scored against what your best lineup would have — which over a season is usually a bigger number than any trade.'],
];

/* ⭐ THE MAP. One entry per place you can end up. `find` is the literal route in the app's own labels;
   `tabs` are what is inside once you are there. */
export const GUIDE_MAP = [
  {
    key: 'start', title: 'Setting up', icon: 'ti-plug-connected',
    blurb: 'Do these once. Everything else is priced off what the app learns here, so a league with the wrong scoring gives confidently wrong advice.',
    items: [
      { name: 'Connect a league', find: 'Home → Create or connect a league',
        at: 'home',
        does: 'Import from Sleeper, MyFantasyLeague or Fantrax and the settings, keepers and your draft slot come with it. ESPN, Yahoo, CBS and NFL.com can be built by hand, and a hand-built league is a first-class path rather than a fallback.' },
      { name: 'Settings', find: 'Home → open a league → Settings',
        at: 'home',
        does: 'Teams, rounds, roster slots, scoring, draft order, keepers and traded picks. Change one and every valuation on every screen re-prices.' },
      { name: 'My Rankings', find: 'Home → My Rankings',
        at: 'rankings',
        does: 'Your own player board, separate from the platform. Attached to a league it powers the My ADP and Blend columns in that draft room.' },
      { name: 'Account', find: 'Any screen → Account',
        at: 'account',
        does: 'Your season pass, linked Sleeper account, email preferences and theme.' },
    ],
  },
  {
    key: 'draft', title: 'Draft day', icon: 'ti-target-arrow',
    blurb: 'The draft room is one screen with tabs across the top. You live on the first two while you are on the clock; the rest are for the gaps between picks.',
    items: [
      { name: 'Draft plan & trends', find: 'Home → open a league → Draft plan & trends',
        at: 'home',
        does: 'Written before draft night: the players you are targeting, the rules you want held to, and what your mock drafts say about how your seat behaves.' },
      { name: 'Mock draft', find: 'Home → Run a mock draft',
        at: 'home',
        does: 'The real engine against simulated opponents in your exact settings. Unlimited, and every one feeds My Mock Insights.' },
      { name: 'The draft room', find: 'Home → open a league → Start the draft',
        at: 'home',
        does: 'Where you actually draft. Picks sync live on Sleeper, MyFantasyLeague and Fantrax; everywhere else you type each pick as it is announced and the advice updates the same way.',
        tabs: [
          ['Hub', 'On the clock: who to take, what waiting costs, and what is about to run.'],
          ['Team analysis', 'Your roster so far, by position, against what the league starts.'],
          ['League', 'Every other team\'s roster and needs — who is about to take your guy.'],
          ['Draft board', 'The grid of every pick, current and projected, with steals and reaches marked.'],
          ['Depth charts', 'NFL depth charts, so you can see who is behind whom.'],
          ['Trade', 'Pick values and packages during the draft itself.'],
          ['Summary', 'Grades, biggest steals and reaches, projected standings and a shareable recap.'],
          ['Settings', 'The league\'s own setup, editable mid-draft.'],
        ] },
    ],
  },
  {
    key: 'season', title: 'During the season', icon: 'ti-calendar-stats',
    blurb: 'Two entry points. My Week and Game Day look ACROSS every league you own; the league hub looks INSIDE one of them.',
    items: [
      { name: 'My Week', find: 'Home → My Week',
        at: 'week:myweek',
        does: 'Every league in one list before kickoff: the lineups that still need a decision, who is questionable, who is on a bye, and what it would cost you to leave it.' },
      { name: 'Game Day', find: 'Home → Game Day',
        at: 'week:gameday',
        does: 'While games are on: live totals in every league, who you need to root for and against, and how much of each game is still to play.' },
      { name: 'Review', find: 'Home → My Week → Review',
        at: 'week:review',
        does: 'After the week: what you scored, what your best lineup would have scored, and the decisions that cost you.' },
      { name: 'The league hub', find: 'Home → Your teams → open a league',
        at: 'home:teams',
        does: 'Everything about one league, all season. Tabs across the top.',
        tabs: [
          ['Summary', 'The week in one card: what needs sorting out, and what to do about it.'],
          ['Matchup', 'You against your opponent slot by slot, live or projected, with START and SIT marks on any lineup change worth making.'],
          ['Review', 'Last week in this league, and what the alternative was.'],
          ['Free agents', 'The pickups that would actually change YOUR lineup, with FAAB guidance.'],
          ['Trades', 'The trade calculator, the league read, and a finder that names who to call and what to offer.'],
          ['My roster', 'Your team by position, with where each position ranks in the league.'],
          ['League', 'Standings, projected finish, power rank and positional strength. Hover a manager for their whole roster.'],
          ['Draft', 'Opens this league\'s draft board or draft summary.'],
        ] },
    ],
  },
  {
    key: 'tools', title: 'Tools that work any time', icon: 'ti-tools',
    blurb: 'These are not tied to a week or a draft. Reach them from the home page.',
    items: [
      { name: 'Trade Tools', find: 'Home → Trade Tools',
        at: 'tradeTools',
        does: 'Format-aware player and pick values plus a quick evaluator, usable outside any league. Inside a league it adds your roster and the trade finder.' },
      { name: 'ADP Intelligence', find: 'Home → ADP Intelligence',
        at: 'adpIntel',
        does: 'Everything about where a player is going: the consensus, how it is moving across recent drafts, the spread, the sample size, and your own blended number.' },
      { name: 'League News & Movers', find: 'Home → League News & Movers',
        at: 'trends',
        does: 'The wider wire — ADP risers and fallers, signings, depth-chart changes and injuries. Not tied to your leagues.' },
      { name: 'My Mock Insights', find: 'Home → My Mock Insights',
        at: 'trendsTime',
        does: 'Patterns across your own mocks: the rounds where you find value, and the players you keep ending up with.' },
      { name: 'Help & support', find: 'Any screen → Help',
        at: 'help',
        does: 'This guide, the FAQ, the terms, and a form that reaches a person.' },
    ],
  },
];

/* ⭐ THE GLOSSARY. Every entry is a word the app PRINTS. `where` is where you meet it, which matters more
   than the definition — a term you cannot place is one you cannot check. */
export const GUIDE_GLOSSARY = [
  { group: 'Value and the board', terms: [
    { term: 'ADP', where: 'Draft board, ADP Intelligence', say: 'Average draft position — roughly where a player comes off the board across real drafts. Ours is read from thousands of them and re-priced for your exact format, not a single national average.' },
    { term: 'VBD', where: 'Draft room, everywhere a value is shown', say: 'Value based drafting. How many points a player scores above what you could get at his position anyway. It is the reason a good tight end can be worth more than a better-scoring receiver.' },
    { term: 'Replacement level', where: 'Under VBD', say: 'The player you could have for free at that position given how many your league starts. Everything above him is the part that actually wins you weeks.' },
    { term: 'Tier', where: 'Draft board, rankings', say: 'A group of players close enough in value that which one you get matters less than getting one of them. The gap between tiers is where a pick is urgent.' },
    { term: 'Steal / Reach', where: 'Draft board, Summary', say: 'A pick taken much later than his value says (steal, green) or much earlier (reach, red). Measured against your format, not against a national list.' },
    { term: 'Edge', where: 'Draft room columns', say: 'The gap between our valuation and the ranks you entered from your platform — where your platform disagrees with the market.' },
    { term: 'My ADP / Blend', where: 'Draft room columns', say: 'My ADP is your own ranking for a player. Blend is your ranking mixed with the market read, so you can lean on your own opinions without ignoring the room.' },
    { term: 'Availability odds', where: 'Draft room, on the clock', say: 'The chance a player is still there at your next pick, from simulating the picks in between. It is what turns "I like him" into "I have to take him now".' },
    { term: 'Take now', where: 'Draft room, on the clock', say: 'The other half of availability odds: what passing on someone actually costs — who you would fall to at that position, how much worse he is, and how likely he is to reach you. Take now when the drop-off is real and the odds are bad.' },
  ] },
  { group: 'Your team, in season', terms: [
    { term: 'Optimal lineup', where: 'Matchup, Review', say: 'The best legal lineup from the players you own, solved slot by slot including the flex. It is what "points left on the bench" is measured against.' },
    { term: 'START / SIT', where: 'Matchup', say: 'A bench player who out-projects one of your starters, and the starter he would replace. Hover either for both projections and the difference.' },
    { term: 'Left to play', where: 'Home, Game Day', say: 'Starters whose games have not finished. A player is only counted as played once his stat line says so, not merely because a game clock says his window has passed.' },
    { term: 'Power rank', where: 'League tab, home table', say: 'How good a roster is, blending what the roster projects with what the team has actually done. Deliberately not a week-to-week number — a bye week should not move it.' },
    { term: 'Projected finish', where: 'League tab', say: 'Where a team lands by the end of the regular season, from its record so far and its roster strength. A guide, not a guarantee.' },
    { term: 'Positional rank', where: 'My roster, League tab, Trades', say: 'Where your receivers (or backs, or tight ends) rank against the other rosters in your league. A rank means the same thing in week 2 as in week 12, which a points total does not.' },
    { term: 'FAAB', where: 'Free agents', say: 'Free agent acquisition budget — the fake money some leagues bid with instead of a waiver order. Where your league uses it, the suggested bid is a share of what is left.' },
    { term: 'Posture', where: 'League hub', say: 'Whether the app is advising you to win now or to build. It is detected from your record and your roster, and you can override it.' },
  ] },
  { group: 'Trades', terms: [
    { term: 'Movable', where: 'Trades → positional read', say: 'A player you can trade from without hurting your own lineup much — measured by solving your lineup with and without him. Not the same as having a spare body: in a league with a flex, a third back can start every week.' },
    { term: 'Likely / worth asking / long shot', where: 'Trade ideas', say: 'How a proposal is likely to land, from a 0\u2013100 read with its reasons named \u2014 what it does for their lineup, whether it fills a hole they cannot field, whether you are asking for the best player they own. It is a judgement about a person and is never dressed up as a probability.' },
    { term: 'What moves your season', where: 'Trades', say: 'The section that ranks every manager in your league by what a deal with them would do for you — and it is ranked by the thing that is still in play. Once your playoff place is settled it switches to what moves your seeding, because a number that cannot move is not a reason to trade.' },
    { term: 'Favors you', where: 'Trade ideas', say: 'The deal is fair on value but it is your lineup that gains — worth asking, not a lock. Deals where both lineups improve are not labelled.' },
    { term: 'Two for one', where: 'Trade ideas', say: 'Consolidation: sending two good players for one better one. What a team with real depth and a hole at one position actually needs to do.' },
    { term: 'Season value', where: 'Trades', say: 'Points across the rest of the season, not this week. The trade screens work in season value throughout — a 40 there is about two and a half points a week.' },
  ] },
  { group: 'League formats', terms: [
    { term: 'Flex / Superflex', where: 'Settings, lineups', say: 'A flex slot takes a back, receiver or tight end. A superflex also takes a quarterback, which changes quarterback value more than any other setting in fantasy.' },
    { term: 'Keeper', where: 'Settings, draft room', say: 'A player held from last season, usually at a cost in draft capital. Set them in Settings and they apply to the official draft and every mock for that league.' },
    { term: 'Median', where: 'Home table, League tab', say: 'Some leagues also score you against the league median every week, so you can go 2-0 or 0-2 in a single Sunday. Where yours does, the median result is shown beside your matchup \u2014 and a good score is worth more than merely beating one opponent.' },
    { term: 'Taxi squad / IR', where: 'League tab roster hover', say: 'Roster spots that sit outside your active team. A man on injured reserve cannot play until his team activates him, so he is shown separately from your bench rather than counted as depth.' },
  ] },
];

/* Everything searchable, flattened once, so the search box is one pass over one array rather than three
   nested loops recomputed on every keystroke. */
export function guideIndex() {
  const rows = [];
  GUIDE_TASKS.forEach((t) => rows.push({
    kind: 'task', title: t.want, body: `${t.go} ${t.note} ${t.words || ''}`, go: t.go, at: t.at, note: t.note }));
  GUIDE_MAP.forEach((sec) => sec.items.forEach((it) => {
    rows.push({ kind: 'place', section: sec.title, title: it.name, body: `${it.find} ${it.does}`, go: it.find, at: it.at, note: it.does });
    /* ⚠ b156 — A TAB INHERITS ITS SCREEN'S LINK TARGET, not one of its own. The furthest this file can
       honestly route is the screen; which tab to click is what the crumb says. */
    (it.tabs || []).forEach(([label, what]) => rows.push({
      kind: 'place', section: it.name, title: label, body: `${it.find} ${label} ${what}`,
      go: `${it.find} → ${label}`, at: it.at, note: what }));
  }));
  GUIDE_GLOSSARY.forEach((g) => g.terms.forEach((t) => rows.push({
    kind: 'term', section: g.group, title: t.term, body: `${t.where} ${t.say}`, go: t.where, note: t.say })));
  return rows;
}

export function guideSearch(rows, q) {
  const needle = String(q || '').trim().toLowerCase();
  if (needle.length < 2) return [];
  /* ⚠ EVERY WORD HAS TO MATCH, NOT ANY. "trade value" with an OR returns every row that says "trade",
     which on this app is most of them, and a search that returns forty results has not answered
     anything. */
  const parts = needle.split(/\s+/).filter(Boolean);
  return rows
    .map((r) => {
      const hay = `${r.title} ${r.body}`.toLowerCase();
      if (!parts.every((p) => hay.includes(p))) return null;
      // A hit in the TITLE is what the reader meant; a hit in the body is a maybe.
      const inTitle = parts.filter((p) => r.title.toLowerCase().includes(p)).length;
      return { ...r, score: inTitle * 10 + (r.kind === 'task' ? 3 : r.kind === 'place' ? 2 : 1) };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);
}
