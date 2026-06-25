import React, { useState, useEffect, useMemo, useRef } from "react";
import { api, hasBackend, setToken } from "./api.js";


/* ============================================================
   FANTASY DRAFT COMPASS — FULL PLATFORM PROTOTYPE
   Public site -> sign up -> season pass checkout (simulated) ->
   league library (persists via artifact storage) -> league setup ->
   live draft room (real simplified engine) -> admin console.

   SECURITY MODEL — READ BEFORE LAUNCH:
   This is a CLIENT-SIDE prototype. Every gate here (admin allowlist,
   paid/unpaid access, profile data, simulated payments) runs in the
   browser and is therefore BYPASSABLE by a determined user via dev tools.
   That is unavoidable for any browser-only app. For production these MUST
   be enforced on a SERVER you control: managed auth (Auth0/Clerk/Firebase),
   server-side admin + subscription checks on every protected request,
   payments via Stripe/PayPal (card data never touches your servers),
   and profile/payment data behind authenticated, authorized APIs only.
   The ADMIN_EMAILS list below is the *client* convenience gate; the real
   authority check must live server-side. Payments & auth here are SIMULATED.
   Sample 2026 projection data. 12-team leagues in this demo.
   ============================================================ */

// Team count is set per active league before any engine call (single active league at a time).
let TEAMS = 12;

// --- Admin allowlist -------------------------------------------------------------------
// ONLY these emails get the Admin tab/console. This is the prototype's gate; in production
// the real authority check lives on the SERVER (the client list is convenience only —
// see the security notes in the Help/legal section). Add admins here.
const ADMIN_EMAILS = ["rosetc16@gmail.com", "trey.rose@pirates.com"];
const isAdminEmail = (email) => !!email && ADMIN_EMAILS.map((e) => e.toLowerCase()).includes(String(email).trim().toLowerCase());

// --- Seasons ---------------------------------------------------------------------------
// One account holds every season. The user picks an active season; rankings, leagues, and
// preferences carry forward via "run it back" copies rather than being lost year to year.
const CURRENT_SEASON = 2026;
// Normalize a player name for cross-source matching (Sleeper picks ↔ engine players): lowercase,
// strip punctuation and common suffixes (Jr/Sr/II/III), collapse spaces.
const normName = (s) => String(s || "").toLowerCase()
  .replace(/[.,'’]/g, "")
  .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "")
  .replace(/\s+/g, " ").trim();
// Comp subscriptions granted by an admin, keyed by email. A comp can be "season" (this league
// year only) or "forever". Returns the active comp for an email, or null. In production this
// lives server-side; here it's stored in biz.comps and applied at sign-in.
function compFor(biz, email) {
  if (!biz || !email) return null;
  const list = biz.comps || [];
  const c = list.find((x) => x.email && x.email.toLowerCase() === String(email).toLowerCase() && !x.revoked);
  if (!c) return null;
  if (c.scope === "season" && c.season != null && c.season !== CURRENT_SEASON) return null; // expired season comp
  return c;
}
const SEASONS = [2026, 2025, 2024];

// --- Named ranking sets ----------------------------------------------------------------
// A set: { id, name, season, type, qbType('1QB'|'SF'), teType('std'|'tep'), leagueId|null,
//          list:[playerId], created }. We migrate any legacy user.ranks map into named sets
// so older accounts keep working.
function setSettingsKey(set) {
  const mode = set.type === "dynasty" || set.type === "keeper" ? "DYN" : set.type === "bestball" ? "BB" : "RE";
  const te = set.teType === "tep" ? "TEP1" : "TEstd";
  return `${mode}-${set.qbType || "1QB"}-${te}`;
}
// Group a league type into the same family a ranking set's type belongs to (keeper rides with dynasty).
function typeFamily(t) { return t === "dynasty" || t === "keeper" ? "dynasty" : t === "bestball" ? "bestball" : "redraft"; }
// Canonical superflex/2QB detection. A league is "QB-premium" if it starts more than one
// QB-eligible slot — either an explicit SUPER/superflex slot, two or more dedicated QB slots,
// or the legacy cfg.sf flag. This is the single source of truth used everywhere QB scarcity matters.
function isSuperflex(cfg) {
  if (!cfg) return false;
  if (cfg.sf) return true;
  const st = cfg.start || {};
  return (st.SUPER || 0) > 0 || (st.QB || 0) >= 2;
}
// The defensive (IDP) position set, parallel to the offensive POS list.
const IDP_POS = ["DL", "LB", "DB"];
// A league uses IDP if it has the idp flag or any defensive starting slot configured.
function idpOn(cfg) {
  if (!cfg) return false;
  if (cfg.idp) return true;
  const st = cfg.start || {};
  return (st.DL || 0) > 0 || (st.LB || 0) > 0 || (st.DB || 0) > 0 || (st.IDPFLEX || 0) > 0;
}
// Score how relevant a saved ranking set is to a league cfg, and list any format mismatches.
// Same TYPE family is the gate; QB/TE/PPR differences reduce the score but still show (flagged).
function rankRelevance(set, cfg) {
  if (typeFamily(set.type) !== typeFamily(cfg.type)) return null; // different draft type — don't show
  // QB premium family: SF and 2QB both make QBs scarce/valuable; 1QB does not.
  const qbFam = (q) => (q === "SF" || q === "2QB") ? "premium" : "single";
  const leagueQb = ((cfg.start && cfg.start.SUPER > 0) || cfg.sf) ? "SF" : "1QB";
  const setQb = set.qbType || "1QB";
  const leagueTeP = cfg.tePremMult > 0;
  const setTeP = set.teType === "tep";
  let score = 100; const flags = [];
  const lbl = (q) => q === "SF" ? "Superflex" : q === "2QB" ? "2QB" : "1QB";
  if (qbFam(setQb) !== qbFam(leagueQb)) { score -= 45; flags.push(`${lbl(setQb)} ranks · league is ${lbl(leagueQb)}`); }
  else if (setQb !== leagueQb) { score -= 8; flags.push(`${lbl(setQb)} ranks · league is ${lbl(leagueQb)} (both QB-premium)`); }
  if (setTeP !== leagueTeP) { score -= 22; flags.push(setTeP ? "TE-premium ranks · league isn't" : "league is TE-premium · ranks aren't"); }
  if (set.leagueId != null && cfg.__leagueId != null && set.leagueId === cfg.__leagueId) score += 30;
  return { score: Math.max(0, score), flags, exact: flags.length === 0 };
}
function migrateRankSets(user) {
  if (!user) return user;
  if (Array.isArray(user.rankSets)) return user; // already migrated
  const sets = [];
  if (user.ranks && typeof user.ranks === "object") {
    Object.entries(user.ranks).forEach(([key, list], i) => {
      const [mode, qb, te] = key.split("-");
      sets.push({ id: `rs-legacy-${i}-${Date.now()}`, name: `My ${mode === "DYN" ? "Dynasty" : mode === "BB" ? "Best ball" : "Redraft"} board`, season: CURRENT_SEASON, type: mode === "DYN" ? "dynasty" : mode === "BB" ? "bestball" : "redraft", qbType: qb === "SF" ? "SF" : "1QB", teType: te === "TEstd" ? "std" : "tep", leagueId: null, list: list || [], created: new Date().toLocaleDateString() });
    });
  }
  return { ...user, rankSets: sets, season: user.season || CURRENT_SEASON };
}

const setTeams = (n) => { TEAMS = Math.max(2, Math.min(20, n || 12)); };
const POS = ["QB", "RB", "WR", "TE"];

let RAW = [
  ["Ja'Marr Chase","WR","CIN",26,10,1.5,330],
  ["Bijan Robinson","RB","ATL",24,5,2.0,322],
  ["Jahmyr Gibbs","RB","DET",24,8,3.2,320],
  ["Justin Jefferson","WR","MIN",27,6,3.8,315],
  ["Saquon Barkley","RB","PHI",29,9,4.5,305],
  ["CeeDee Lamb","WR","DAL",27,7,6.0,300],
  ["Puka Nacua","WR","LAR",25,6,6.8,306],
  ["Amon-Ra St. Brown","WR","DET",26,8,7.5,298],
  ["De'Von Achane","RB","MIA",24,12,8.2,300],
  ["Malik Nabers","WR","NYG",23,11,9.4,290],
  ["Nico Collins","WR","HOU",27,14,11.0,282],
  ["Ashton Jeanty","RB","LV",22,8,11.5,295],
  ["Brian Thomas Jr.","WR","JAX",23,11,12.0,280],
  ["Christian McCaffrey","RB","SF",30,9,12.8,290],
  ["Drake London","WR","ATL",24,5,13.5,276],
  ["A.J. Brown","WR","PHI",28,9,14.5,272],
  ["Josh Jacobs","RB","GB",28,5,15.2,270],
  ["Brock Bowers","TE","LV",23,8,16.0,255],
  ["Derrick Henry","RB","BAL",32,7,17.0,268],
  ["Trey McBride","TE","ARI",26,8,18.5,240],
  ["Ladd McConkey","WR","LAC",24,5,19.5,255],
  ["Jaxon Smith-Njigba","WR","SEA",24,10,20.5,260],
  ["Tee Higgins","WR","CIN",27,10,21.5,250],
  ["Kyren Williams","RB","LAR",25,6,23.0,252],
  ["Bucky Irving","RB","TB",23,9,24.0,256],
  ["Chase Brown","RB","CIN",26,10,25.0,248],
  ["Garrett Wilson","WR","NYJ",25,9,26.0,248],
  ["Marvin Harrison Jr.","WR","ARI",24,8,27.0,250],
  ["Davante Adams","WR","LAR",33,6,28.5,232],
  ["Terry McLaurin","WR","WAS",30,12,29.0,240],
  ["Mike Evans","WR","TB",32,9,30.0,238],
  ["Omarion Hampton","RB","LAC",23,5,30.5,244],
  ["Breece Hall","RB","NYJ",25,9,31.0,240],
  ["Kenneth Walker III","RB","SEA",25,8,32.5,236],
  ["DK Metcalf","WR","PIT",28,5,33.5,228],
  ["George Kittle","TE","SF",32,9,34.0,225],
  ["Rashee Rice","WR","KC",26,10,35.0,240],
  ["Jonathan Taylor","RB","IND",27,11,36.0,238],
  ["DeVonta Smith","WR","PHI",27,9,37.0,226],
  ["Xavier Worthy","WR","KC",23,10,38.0,228],
  ["James Cook","RB","BUF",26,7,39.0,232],
  ["Josh Allen","QB","BUF",30,7,40.0,405],
  ["Alvin Kamara","RB","NO",31,11,40.5,226],
  ["Jonathon Brooks","RB","CAR",23,14,41.5,224],
  ["Lamar Jackson","QB","BAL",29,7,42.0,400],
  ["Tetairoa McMillan","WR","CAR",23,14,43.0,222],
  ["Jayden Daniels","QB","WAS",25,12,44.0,385],
  ["Travis Hunter","WR","JAX",23,8,45.0,225],
  ["Jameson Williams","WR","DET",25,8,46.0,216],
  ["Jalen Hurts","QB","PHI",27,9,46.5,380],
  ["Calvin Ridley","WR","TEN",31,10,47.0,210],
  ["Zay Flowers","WR","BAL",25,7,48.0,218],
  ["Joe Burrow","QB","CIN",29,10,48.5,375],
  ["Sam LaPorta","TE","DET",25,8,49.0,205],
  ["Tyreek Hill","WR","NYJ",32,9,49.5,215],
  ["TreVeyon Henderson","RB","NE",23,14,50.0,218],
  ["George Pickens","WR","DAL",25,7,51.0,212],
  ["Jaylen Waddle","WR","MIA",27,12,52.0,205],
  ["Courtland Sutton","WR","DEN",30,12,53.0,214],
  ["Quinshon Judkins","RB","CLE",24,9,54.0,205],
  ["Aaron Jones","RB","MIN",31,6,55.0,205],
  ["Chuba Hubbard","RB","CAR",27,14,56.0,222],
  ["David Montgomery","RB","DET",28,8,57.0,200],
  ["Patrick Mahomes","QB","KC",30,10,58.0,360],
  ["Chris Olave","WR","NO",26,11,59.0,200],
  ["Baker Mayfield","QB","TB",31,9,60.0,350],
  ["DJ Moore","WR","CHI",29,5,60.5,200],
  ["Jerry Jeudy","WR","CLE",26,9,61.5,202],
  ["Jordan Love","QB","GB",27,5,62.0,340],
  ["Jordan Addison","WR","MIN",24,6,62.5,190],
  ["Rome Odunze","WR","CHI",24,5,63.5,195],
  ["Bo Nix","QB","DEN",26,12,64.0,345],
  ["Khalil Shakir","WR","BUF",26,7,65.0,188],
  ["Caleb Williams","QB","CHI",24,5,66.0,330],
  ["Jakobi Meyers","WR","LV",29,8,66.5,196],
  ["T.J. Hockenson","TE","MIN",28,6,67.0,185],
  ["Travis Etienne","RB","JAX",27,8,68.0,176],
  ["Mark Andrews","TE","BAL",30,7,69.0,180],
  ["David Njoku","TE","CLE",30,9,70.0,182],
  ["Tony Pollard","RB","TEN",28,10,71.0,198],
  ["Isiah Pacheco","RB","KC",27,10,72.0,192],
  ["Brock Purdy","QB","SF",26,9,73.0,330],
  ["Kaleb Johnson","RB","PIT",22,5,74.0,196],
  ["Justin Herbert","QB","LAC",28,5,75.0,335],
  ["RJ Harvey","RB","DEN",25,12,76.0,210],
  ["Zach Charbonnet","RB","SEA",25,8,77.0,182],
  ["Jaylen Warren","RB","PIT",27,5,78.0,188],
  ["Tucker Kraft","TE","GB",25,5,79.0,178],
  ["Tyler Warren","TE","IND",24,11,80.0,172],
  ["Colston Loveland","TE","CHI",22,5,82.0,165],
  ["C.J. Stroud","QB","HOU",25,14,83.0,322],
  ["Dak Prescott","QB","DAL",32,7,84.0,325],
  ["Kyler Murray","QB","ARI",29,8,85.0,320],
  ["Drake Maye","QB","NE",24,14,86.0,328],
  ["Jordan Mason","RB","MIN",27,6,87.0,178],
  ["Jared Goff","QB","DET",31,8,88.0,318],
  ["Tyjae Spears","RB","TEN",25,10,89.0,165],
  ["J.J. McCarthy","QB","MIN",23,6,90.0,310],
  ["Trey Benson","RB","ARI",24,8,91.0,168],
  ["Cam Skattebo","RB","NYG",24,11,92.0,168],
  ["Trevor Lawrence","QB","NE",31,8,92,312],
  ["Jaydon Blue","RB","DAL",23,7,93.0,160],
  ["Stefon Diggs","WR","NE",32,14,94.0,192],
  ["Daniel Jones","QB","HOU",25,5,94.8,306],
  ["Keon Coleman","WR","BUF",23,7,95.0,180],
  ["Jayden Reed","WR","GB",26,5,96.0,182],
  ["Rashod Bateman","WR","BAL",26,7,97.0,168],
  ["Sam Darnold","QB","NO",25,11,97.9,302],
  ["Deebo Samuel","WR","WAS",30,12,98.0,172],
  ["Jauan Jennings","WR","SF",28,9,99.0,170],
  ["Matthew Golden","WR","GB",23,5,100.0,175],
  ["Dallas Goedert","TE","NO",32,11,100,165],
  ["Geno Smith","QB","ARI",32,6,100.9,295],
  ["Michael Pittman Jr.","WR","IND",29,11,101.0,168],
  ["Cooper Kupp","WR","SEA",33,8,102.0,178],
  ["Tank Bigsby","RB","LAR",27,5,103,175],
  ["Cole Kmet","TE","SF",32,14,103.3,164],
  ["Jeremiah Smith","WR","CLE",21,9,104.0,185],
  ["Michael Penix Jr.","QB","DET",31,12,104.7,291],
  ["Adam Thielen","WR","NE",30,8,105,172],
  ["Tyler Allgeier","RB","MIA",23,12,105.5,170],
  ["Chig Okonkwo","TE","KC",29,9,106.3,160],
  ["Jeremiyah Love","RB","NO",21,11,107.0,188],
  ["Joshua Palmer","WR","PHI",23,10,107.2,172],
  ["Justice Hill","RB","SF",24,14,107.4,167],
  ["Tua Tagovailoa","QB","DET",23,12,107.8,288],
  ["Makai Lemon","WR","SEA",22,8,108.0,175],
  ["Jaleel McLaughlin","RB","CLE",29,11,109.6,164],
  ["DeMario Douglas","WR","BUF",30,14,109.6,172],
  ["Will Dissly","TE","ATL",31,10,109.6,158],
  ["Nicholas Singleton","RB","DAL",22,7,110.0,180],
  ["Anthony Richardson","QB","ARI",28,6,111.1,281],
  ["Dyami Brown","WR","ATL",25,10,111.7,169],
  ["Carnell Tate","WR","CHI",21,5,112.0,170],
  ["Kareem Hunt","RB","WAS",29,14,112.0,160],
  ["Mike Gesicki","TE","DEN",26,12,112.6,155],
  ["Calvin Austin III","WR","DAL",25,14,113.5,165],
  ["Elijah Mitchell","RB","TEN",31,6,113.8,157],
  ["Aaron Rodgers","QB","DEN",32,12,114.2,275],
  ["Wan'Dale Robinson","WR","SF",31,14,115.1,163],
  ["Kendre Miller","RB","DAL",23,14,115.5,156],
  ["Cade Otton","TE","PIT",27,11,115.5,151],
  ["Jordyn Tyson","WR","ARI",21,8,116.0,168],
  ["Adonai Mitchell","WR","GB",28,8,116.7,162],
  ["Russell Wilson","QB","WAS",24,14,117.1,271],
  ["Roschon Johnson","RB","CIN",32,14,117.6,151],
  ["Fernando Mendoza","QB","IND",22,11,118.0,300],
  ["Noah Fant","TE","CHI",25,8,118.3,145],
  ["Ja'Lynn Polk","WR","PIT",27,11,118.7,156],
  ["Ray Davis","RB","CLE",30,11,119.3,150],
  ["Quinten Joyner","RB","LAR",21,6,120.0,162],
  ["Troy Franklin","WR","SEA",24,6,120.5,153],
  ["Matthew Stafford","QB","LV",32,6,120.7,266],
  ["Dawson Knox","TE","LV",28,6,121.5,138],
  ["Braelon Allen","RB","LV",31,6,121.6,146],
  ["Xavier Legette","WR","CIN",26,14,122.5,151],
  ["Joe Flacco","QB","WAS",24,14,123.6,261],
  ["Isaac Guerendo","RB","TEN",29,6,124.2,142],
  ["Theo Johnson","TE","BUF",23,14,124.9,135],
  ["Jalen McMillan","WR","NE",29,8,125.0,148],
  ["Jaylen Wright","RB","ARI",23,6,126.1,140],
  ["Will Levis","QB","TB",32,10,126.6,257],
  ["Andrei Iosivas","WR","GB",23,8,127.3,143],
  ["Ja'Tavion Sanders","TE","JAX",31,6,127.7,134],
  ["Antonio Williams","WR","BUF",22,7,128.0,158],
  ["MarShawn Lloyd","RB","WAS",28,14,128.6,137],
  ["Jalen Coker","WR","IND",24,6,129.0,139],
  ["Mac Jones","QB","WAS",27,14,129.5,255],
  ["Blake Corum","RB","TB",31,10,130.5,134],
  ["Quentin Johnston","WR","IND",32,6,130.8,133],
  ["Isaiah Likely","TE","PHI",28,10,131.2,127],
  ["Eric Singleton Jr.","WR","LAC",21,5,132.0,155],
  ["Cedric Tillman","WR","DAL",24,14,132.5,129],
  ["Bhayshul Tuten","RB","BAL",27,14,132.6,131],
  ["Spencer Rattler","QB","MIN",29,10,132.9,252],
  ["Romeo Doubs","WR","DET",24,12,134.1,126],
  ["Kyle Pitts","TE","LAC",28,12,134.1,120],
  ["Kenyon Sadiq","TE","DET",21,8,135.0,150],
  ["Rico Dowdle","RB","SEA",31,6,135.1,131],
  ["Jameis Winston","QB","WAS",29,14,136.1,245],
  ["Christian Kirk","WR","GB",24,8,136.4,122],
  ["Dalton Kincaid","TE","TB",31,10,137.0,116],
  ["Najee Harris","RB","SF",30,14,137.6,130],
  ["Denzel Boston","WR","NYJ",22,9,138.0,150],
  ["Josh Downs","WR","CAR",27,6,138.2,116],
  ["Jarrett Stidham","QB","JAX",28,6,139.1,240],
  ["Marvin Mims","WR","CAR",23,6,139.8,114],
  ["Joe Mixon","RB","NYG",24,9,139.9,127],
  ["Drew Allar","QB","TEN",22,10,140.0,285],
  ["Jonnu Smith","TE","MIA",26,12,140.5,110],
  ["Darnell Mooney","WR","LV",29,6,142.2,108],
  ["Kirk Cousins","QB","NYJ",26,10,142.2,232],
  ["Nick Chubb","RB","SEA",23,6,142.3,126],
  ["Hunter Henry","TE","ARI",28,6,143.5,106],
  ["Hollywood Brown","WR","ATL",27,10,143.8,107],
  ["Austin Ekeler","RB","CHI",32,8,144.4,122],
  ["LaNorris Sellers","QB","LV",21,8,145.0,280],
  ["Antonio Gibson","RB","BAL",31,14,146.2,118],
  ["Pat Freiermuth","TE","PIT",23,11,147.0,100],
  ["Demario Douglas","WR","NO",28,11,147.9,101],
  ["Zamir White","RB","NO",25,11,148.5,113],
  ["Jake Ferguson","TE","LV",25,6,149.7,97],
  ["Tyler Lockett","WR","BAL",29,14,150.0,96],
  ["Devin Singletary","RB","WAS",25,14,150.8,109],
  ["Keenan Allen","WR","SF",24,14,151.7,93],
  ["Evan Engram","TE","IND",32,6,152.4,96],
  ["Samaje Perine","RB","LAR",24,5,152.8,108],
  ["Amari Cooper","WR","LV",29,6,154.1,88],
  ["Jerome Ford","RB","MIA",31,12,154.6,107],
  ["Brenton Strange","TE","NYJ",31,10,155.0,92],
  ["Diontae Johnson","WR","SF",23,14,156.4,89],
  ["Ty Chandler","RB","HOU",29,5,157.0,103],
  ["Zach Ertz","TE","DET",31,12,158.1,86],
  ["Allen Lazard","WR","CLE",27,11,158.2,84],
  ["Will Shipley","RB","BUF",28,14,158.7,103],
  ["Julian Sayin","QB","CLE",20,9,160.0,270],
  ["Brandin Cooks","WR","NE",26,8,160.0,84],
  ["Audric Estime","RB","ATL",31,10,161.2,103],
  ["DeAndre Hopkins","WR","DET",32,12,162.2,84],
  ["Sean Tucker","RB","MIN",24,10,163.5,100],
  ["Emanuel Wilson","RB","DET",25,12,165.6,96],
  ["Brandon Aubrey","K","DAL",25,14,177.8,150],
  ["Harrison Butker","K","IND",33,6,180.2,148],
  ["Broncos D/ST","DST","DEN",0,12,180.7,140],
  ["Jake Bates","K","WAS",30,14,182.9,146],
  ["Eagles D/ST","DST","PHI",0,10,183.1,138],
  ["Cameron Dicker","K","DET",32,12,185.5,144],
  ["Texans D/ST","DST","HOU",0,5,186.0,136],
  ["Ravens D/ST","DST","BAL",0,14,188.4,134],
  ["Chris Boswell","K","PIT",34,11,188.6,142],
  ["Ka'imi Fairbairn","K","BUF",25,14,191.2,140],
  ["Steelers D/ST","DST","PIT",0,11,191.5,132],
  ["Bills D/ST","DST","BUF",0,14,193.8,130],
  ["Jason Sanders","K","SEA",31,6,194.2,138],
  ["Vikings D/ST","DST","MIN",0,10,195.6,128],
  ["Tyler Bass","K","TB",34,10,197.6,136],
  ["Packers D/ST","DST","GB",0,8,197.7,126],
  ["Chargers D/ST","DST","LAC",0,12,199.7,124],
  ["Younghoe Koo","K","JAX",34,6,201.0,134],
  ["Lions D/ST","DST","DET",0,12,202.7,122],
  ["Wil Lutz","K","NYJ",32,10,204.2,132],
  ["Seahawks D/ST","DST","SEA",0,6,204.9,120],
  ["Jake Elliott","K","CAR",29,6,206.5,130],
  ["Chiefs D/ST","DST","KC",0,9,206.7,118],
  ["49ers D/ST","DST","SF",0,14,208.8,116],
  ["Evan McPherson","K","LAC",24,12,209.5,128],
  ["Saints D/ST","DST","NO",0,11,211.2,114],
  ["Joshua Karty","K","NO",35,11,212.8,126],
  ["Cowboys D/ST","DST","DAL",0,14,213.4,112],
  ["Matt Gay","K","CLE",28,11,215.1,124],
  ["Jets D/ST","DST","NYJ",0,10,216.1,110],
  ["Chase McLaughlin","K","PHI",28,10,217.9,122],
  ["Cairo Santos","K","NE",33,8,220.1,120],
  // ===== IDP (individual defensive players) — only used when a league configures IDP slots.
  // adp0 values intentionally late; projPts are on the IDP scoring scale (tackle-heavy).
  ["Fred Warner","LB","SF",29,14,150.0,205],
  ["Roquan Smith","LB","BAL",28,7,152.0,202],
  ["Zaire Franklin","LB","IND",29,11,154.0,200],
  ["Micah Parsons","LB","DAL",27,7,156.0,196],
  ["Bobby Wagner","LB","WAS",36,12,160.0,192],
  ["Foyesade Oluokun","LB","JAX",30,8,162.0,190],
  ["Nick Bolton","LB","KC",26,9,168.0,184],
  ["Lavonte David","LB","TB",36,9,172.0,180],
  ["Myles Garrett","DL","CLE",30,9,158.0,188],
  ["Trey Hendrickson","DL","CIN",31,10,164.0,182],
  ["Maxx Crosby","DL","LV",28,8,166.0,181],
  ["Will Anderson Jr.","DL","HOU",25,14,170.0,178],
  ["Aidan Hutchinson","DL","DET",26,8,171.0,177],
  ["Nik Bonitto","DL","DEN",26,12,176.0,170],
  ["T.J. Watt","DL","PIT",31,5,178.0,172],
  ["Danielle Hunter","DL","HOU",31,14,182.0,166],
  ["Kerby Joseph","DB","DET",25,8,174.0,176],
  ["Antoine Winfield Jr.","DB","TB",27,9,180.0,168],
  ["Budda Baker","DB","ARI",30,8,184.0,164],
  ["Brian Branch","DB","DET",24,8,186.0,162],
  ["Derwin James","DB","LAC",29,12,188.0,160],
  ["Xavier McKinney","DB","GB",26,5,192.0,156],
  ["Jessie Bates III","DB","ATL",28,5,196.0,152],
  ["Kyle Hamilton","DB","BAL",24,7,198.0,150]
];

const OUTLOOKS = {
  "Ja'Marr Chase":{p:"The consensus 1.01. Elite target share in a pass-first offense with Burrow healthy. Locked into league-winning WR1 volume."},
  "Bijan Robinson":{p:"Undisputed centerpiece of Atlanta's backfield. Three-down workhorse with goal-line and passing-game usage \u2014 every-week RB1."},
  "Jahmyr Gibbs":{p:"Explosive dual-threat in one of the league's best offenses. Featured back role with league-winning ceiling."},
  "Justin Jefferson":{p:"Still the most talented receiver in football, now with a young QB. Volume isn't in question; a tweak in camp is worth monitoring."},
  "Saquon Barkley":{p:"Coming off a monster year behind an elite line. Massive volume and scoring; the watch item is heavy-workload regression."},
  "CeeDee Lamb":{p:"Alpha target in Dallas with Prescott healthy. A strong bet for top-five WR production again."},
  "Puka Nacua":{p:"One of the highest target-per-route receivers alive. Injury history is the only knock on a WR1 profile."},
  "Amon-Ra St. Brown":{p:"PPR machine in a high-octane offense. Volume and red-zone role make him one of the safest WRs in the pool."},
  "De'Von Achane":{p:"Now the unquestioned engine of Miami's offense after a turbulent offseason \u2014 new QB, a high draft pick on the line, and a fresh extension point to a featured, high-touch role.",tm:"Miami reshaped around him: a new quarterback under center, premium draft capital added to the offensive line, and the departures of Tua, a Waddle trade, and the Tyreek Hill release clear the path to a true featured, high-volume role."},
  "Malik Nabers":{p:"Sensational young WR1 with true alpha volume; the QB situation caps the ceiling until the offense stabilizes. Trending up."},
  "Nico Collins":{p:"Prime-age WR in HOU with an established role; value tracks team volume and health."},
  "Ashton Jeanty":{p:"Rookie phenom handed an immediate workhorse role. Team invested in the line \u2014 high-volume rookie RB with breakout written all over it."},
  "Brian Thomas Jr.":{p:"Ascending year-two breakout candidate with a commanding target share."},
  "Christian McCaffrey":{p:"Highest-ceiling back when healthy; coming off an injury-marred season, so the profile carries more risk than the name."},
  "Drake London":{p:"Ascending WR1 with a young QB growing around him; target and red-zone share trending up."},
  "A.J. Brown":{p:"Prime-age WR in PHI with an established role; value tracks team volume and health."},
  "Josh Jacobs":{p:"Prime-age RB in GB with an established role; value tracks team volume and health."},
  "Brock Bowers":{p:"Generational TE coming off a record rookie year. Target share rivals a WR1 \u2014 a true difference-maker, especially in TE-premium."},
  "Derrick Henry":{p:"Defied age again behind a strong line. Volume and TDs remain; the age cliff is the looming question being priced in."},
  "Trey McBride":{p:"Target hog at tight end, competing only with himself for volume. TD regression upside makes him a strong TE1."},
  "Ladd McConkey":{p:"Prime-age WR in LAC with an established role; value tracks team volume and health."},
  "Jaxon Smith-Njigba":{p:"Ascended into a true WR1 role; volume points to another step forward."},
  "Tee Higgins":{p:"Prime-age WR in CIN with an established role; value tracks team volume and health."},
  "Kyren Williams":{p:"Prime-age RB in LAR with an established role; value tracks team volume and health."},
  "Bucky Irving":{p:"Broke out as a rookie and enters as the lead back in a good offense. Three-down ascending profile."},
  "Chase Brown":{p:"Prime-age RB in CIN with an established role; value tracks team volume and health."},
  "Garrett Wilson":{p:"Prime-age WR in NYJ with an established role; value tracks team volume and health."},
  "Marvin Harrison Jr.":{p:"Year-two leap candidate; the talent and draft capital point up if the Cardinals' passing game improves.",tm:"Arizona's passing game taking a step forward would unlock his Year-2 ceiling."},
  "Davante Adams":{p:"Veteran WR in LAR with a steadier, experience-based floor; age is the long-term question."},
  "Terry McLaurin":{p:"Prime-age WR in WAS with an established role; value tracks team volume and health."},
  "Mike Evans":{p:"Veteran WR in TB with a steadier, experience-based floor; age is the long-term question."},
  "Omarion Hampton":{p:"Rookie back stepping into significant early-down work. Team invested capital; clear path to volume."},
  "Breece Hall":{p:"Prime-age RB in NYJ with an established role; value tracks team volume and health."},
  "Kenneth Walker III":{p:"Prime-age RB in SEA with an established role; value tracks team volume and health."},
  "DK Metcalf":{p:"Prime-age WR in PIT with an established role; value tracks team volume and health."},
  "George Kittle":{p:"Veteran TE in SF with a steadier, experience-based floor; age is the long-term question."},
  "Rashee Rice":{p:"Explosive when on the field, but a suspension/availability cloud and recovery make him one of the higher-variance picks in this range."},
  "Jonathan Taylor":{p:"Prime-age RB in IND with an established role; value tracks team volume and health."},
  "DeVonta Smith":{p:"Prime-age WR in PHI with an established role; value tracks team volume and health."},
  "Xavier Worthy":{p:"Ascending field-stretcher who closed his rookie year strong; in line for a bigger role."},
  "James Cook":{p:"Prime-age RB in BUF with an established role; value tracks team volume and health."},
  "Josh Allen":{p:"Perennial top-two fantasy QB on rushing floor alone. Reloaded receiving room; a superflex cornerstone."},
  "Alvin Kamara":{p:"Veteran RB in NO with a steadier, experience-based floor; age is the long-term question."},
  "Jonathon Brooks":{p:"Young RB in CAR with developmental upside; role and snaps will define the season."},
  "Lamar Jackson":{p:"Dual-threat ceiling few QBs can match in an offense built around him. Elite QB1 with weekly league-winning upside."},
  "Tetairoa McMillan":{p:"Rookie X-receiver with prototype size and a featured role. Boom-bust early, but the target share points to a fast ascent."},
  "Jayden Daniels":{p:"Sophomore-leap candidate; rushing volume gives him a QB1 floor most pocket passers can't touch."},
  "Travis Hunter":{p:"Two-way unicorn whose offensive snaps dictate value. Enormous ceiling if he's a full-time receiver."},
  "Jameson Williams":{p:"Prime-age WR in DET with an established role; value tracks team volume and health.",tm:"Detroit's offense remains one of the league's most explosive; his role and target share are trending up."},
  "Jalen Hurts":{p:"Prime-age QB in PHI with an established role; value tracks team volume and health."},
  "Calvin Ridley":{p:"Veteran WR in TEN with a steadier, experience-based floor; age is the long-term question."},
  "Zay Flowers":{p:"Prime-age WR in BAL with an established role; value tracks team volume and health."},
  "Joe Burrow":{p:"Prime-age QB in CIN with an established role; value tracks team volume and health."},
  "Sam LaPorta":{p:"Prime-age TE in DET with an established role; value tracks team volume and health."},
  "Tyreek Hill":{p:"Still a field-tilting deep threat, now in a new home. Age and a team change add some risk to a high ceiling.",tm:"A new team and scheme reset his context; the target competition and quarterback fit will define whether the elite production holds."},
  "TreVeyon Henderson":{p:"Explosive rookie with a path to a lead role in a backfield with room. Upside profile."},
  "George Pickens":{p:"Prime-age WR in DAL with an established role; value tracks team volume and health."},
  "Jaylen Waddle":{p:"Prime-age WR in MIA with an established role; value tracks team volume and health."},
  "Courtland Sutton":{p:"Prime-age WR in DEN with an established role; value tracks team volume and health."},
  "Quinshon Judkins":{p:"Rookie with three-down skills; the backfield is open for him to claim. Ascending."},
  "Aaron Jones":{p:"Veteran RB in MIN with a steadier, experience-based floor; age is the long-term question."},
  "Chuba Hubbard":{p:"Prime-age RB in CAR with an established role; value tracks team volume and health."},
  "David Montgomery":{p:"Prime-age RB in DET with an established role; value tracks team volume and health."},
  "Patrick Mahomes":{p:"Prime-age QB in KC with an established role; value tracks team volume and health."},
  "Chris Olave":{p:"Prime-age WR in NO with an established role; value tracks team volume and health."},
  "Baker Mayfield":{p:"Veteran QB in TB with a steadier, experience-based floor; age is the long-term question."},
  "DJ Moore":{p:"Prime-age WR in CHI with an established role; value tracks team volume and health."},
  "Jerry Jeudy":{p:"Prime-age WR in CLE with an established role; value tracks team volume and health."},
  "Jordan Love":{p:"Prime-age QB in GB with an established role; value tracks team volume and health."},
  "Jordan Addison":{p:"Prime-age WR in MIN with an established role; value tracks team volume and health."},
  "Rome Odunze":{p:"Year-two ascent candidate with the draft capital and target path to break out."},
  "Bo Nix":{p:"Quietly produced as a rookie and now commands the offense; rushing usage gives him a sneaky-high floor."},
  "Khalil Shakir":{p:"Prime-age WR in BUF with an established role; value tracks team volume and health."},
  "Caleb Williams":{p:"Year-two breakout candidate with a revamped cast and staff. Top-eight upside if it clicks.",tm:"Chicago overhauled the supporting cast and coaching staff around him \u2014 a real environment upgrade for a year-two leap."},
  "Jakobi Meyers":{p:"Prime-age WR in LV with an established role; value tracks team volume and health."},
  "T.J. Hockenson":{p:"Prime-age TE in MIN with an established role; value tracks team volume and health."},
  "Travis Etienne":{p:"Prime-age RB in JAX with an established role; value tracks team volume and health."},
  "Mark Andrews":{p:"Prime-age TE in BAL with an established role; value tracks team volume and health."},
  "David Njoku":{p:"Prime-age TE in CLE with an established role; value tracks team volume and health."},
  "Tony Pollard":{p:"Prime-age RB in TEN with an established role; value tracks team volume and health."},
  "Isiah Pacheco":{p:"Prime-age RB in KC with an established role; value tracks team volume and health."},
  "Brock Purdy":{p:"Prime-age QB in SF with an established role; value tracks team volume and health."},
  "Kaleb Johnson":{p:"Rookie with a runway to early-down volume behind a run-committed staff."},
  "Justin Herbert":{p:"Prime-age QB in LAC with an established role; value tracks team volume and health."},
  "RJ Harvey":{p:"Change-of-pace rookie with breakaway speed; receiving role could lift his ceiling."},
  "Zach Charbonnet":{p:"Prime-age RB in SEA with an established role; value tracks team volume and health."},
  "Jaylen Warren":{p:"Prime-age RB in PIT with an established role; value tracks team volume and health."},
  "Tucker Kraft":{p:"Prime-age TE in GB with an established role; value tracks team volume and health."},
  "Tyler Warren":{p:"Rookie TE with a real receiving role; one of the higher-upside TE stashes."},
  "Colston Loveland":{p:"Athletic rookie TE in a modernizing offense; long-term ascending, patchy early."},
  "C.J. Stroud":{p:"Prime-age QB in HOU with an established role; value tracks team volume and health."},
  "Dak Prescott":{p:"Veteran QB in DAL with a steadier, experience-based floor; age is the long-term question."},
  "Kyler Murray":{p:"Prime-age QB in ARI with an established role; value tracks team volume and health."},
  "Drake Maye":{p:"Ascending young QB with growing rushing usage; a sneaky superflex value."},
  "Jordan Mason":{p:"Prime-age RB in MIN with an established role; value tracks team volume and health."},
  "Jared Goff":{p:"Veteran QB in DET with a steadier, experience-based floor; age is the long-term question."},
  "Tyjae Spears":{p:"Prime-age RB in TEN with an established role; value tracks team volume and health."},
  "J.J. McCarthy":{p:"Young QB in MIN with developmental upside; role and snaps will define the season."},
  "Trey Benson":{p:"Prime-age RB in ARI with an established role; value tracks team volume and health."},
  "Cam Skattebo":{p:"Bruising rookie carving out goal-line and short-yardage work; TD-dependent but trending into a role."},
  "Trevor Lawrence":{p:"Veteran QB in NE with a steadier, experience-based floor; age is the long-term question."},
  "Jaydon Blue":{p:"Young RB in DAL with developmental upside; role and snaps will define the season."},
  "Stefon Diggs":{p:"Veteran WR in NE with a steadier, experience-based floor; age is the long-term question."},
  "Daniel Jones":{p:"Prime-age QB in HOU with an established role; value tracks team volume and health."},
  "Keon Coleman":{p:"Young WR in BUF with developmental upside; role and snaps will define the season."},
  "Jayden Reed":{p:"Prime-age WR in GB with an established role; value tracks team volume and health."},
  "Rashod Bateman":{p:"Prime-age WR in BAL with an established role; value tracks team volume and health."},
  "Sam Darnold":{p:"Prime-age QB in NO with an established role; value tracks team volume and health."},
  "Deebo Samuel":{p:"Prime-age WR in WAS with an established role; value tracks team volume and health."},
  "Jauan Jennings":{p:"Prime-age WR in SF with an established role; value tracks team volume and health."},
  "Matthew Golden":{p:"Speed rookie in a crowded room; boom weeks tied to deep usage."},
  "Dallas Goedert":{p:"Veteran TE in NO with a steadier, experience-based floor; age is the long-term question."},
  "Geno Smith":{p:"Veteran QB in ARI with a steadier, experience-based floor; age is the long-term question."},
  "Michael Pittman Jr.":{p:"Prime-age WR in IND with an established role; value tracks team volume and health."},
  "Cooper Kupp":{p:"Veteran WR in SEA with a steadier, experience-based floor; age is the long-term question."},
  "Tank Bigsby":{p:"Prime-age RB in LAR with an established role; value tracks team volume and health."},
  "Cole Kmet":{p:"Veteran TE in SF with a steadier, experience-based floor; age is the long-term question."},
  "Jeremiah Smith":{p:"Generational rookie WR talent; immediate target share expected, capped only by the offense around him."},
  "Michael Penix Jr.":{p:"Veteran QB in DET with a steadier, experience-based floor; age is the long-term question."},
  "Adam Thielen":{p:"Prime-age WR in NE with an established role; value tracks team volume and health."},
  "Tyler Allgeier":{p:"Young RB in MIA with developmental upside; role and snaps will define the season."},
  "Chig Okonkwo":{p:"Prime-age TE in KC with an established role; value tracks team volume and health."},
  "Jeremiyah Love":{p:"Dynamic rookie RB with elite burst; a featured-role candidate from day one."},
  "Joshua Palmer":{p:"Young WR in PHI with developmental upside; role and snaps will define the season."},
  "Justice Hill":{p:"Prime-age RB in SF with an established role; value tracks team volume and health."},
  "Tua Tagovailoa":{p:"Young QB in DET with developmental upside; role and snaps will define the season."},
  "Makai Lemon":{p:"Polished rookie route-runner with an early path to slot volume; one of the safer rookie WR profiles."},
  "Jaleel McLaughlin":{p:"Prime-age RB in CLE with an established role; value tracks team volume and health."},
  "DeMario Douglas":{p:"Prime-age WR in BUF with an established role; value tracks team volume and health."},
  "Will Dissly":{p:"Veteran TE in ATL with a steadier, experience-based floor; age is the long-term question."},
  "Nicholas Singleton":{p:"Explosive rookie back with three-down upside in a backfield he can take over."},
  "Anthony Richardson":{p:"Prime-age QB in ARI with an established role; value tracks team volume and health."},
  "Dyami Brown":{p:"Prime-age WR in ATL with an established role; value tracks team volume and health."},
  "Carnell Tate":{p:"Smooth rookie X-receiver with a clear runway to targets."},
  "Kareem Hunt":{p:"Prime-age RB in WAS with an established role; value tracks team volume and health."},
  "Mike Gesicki":{p:"Prime-age TE in DEN with an established role; value tracks team volume and health."},
  "Calvin Austin III":{p:"Prime-age WR in DAL with an established role; value tracks team volume and health."},
  "Elijah Mitchell":{p:"Veteran RB in TEN with a steadier, experience-based floor; age is the long-term question."},
  "Aaron Rodgers":{p:"Veteran QB in DEN with a steadier, experience-based floor; age is the long-term question."},
  "Wan'Dale Robinson":{p:"Veteran WR in SF with a steadier, experience-based floor; age is the long-term question."},
  "Kendre Miller":{p:"Young RB in DAL with developmental upside; role and snaps will define the season."},
  "Cade Otton":{p:"Prime-age TE in PIT with an established role; value tracks team volume and health."},
  "Jordyn Tyson":{p:"Young WR in ARI with developmental upside; role and snaps will define the season."},
  "Adonai Mitchell":{p:"Prime-age WR in GB with an established role; value tracks team volume and health."},
  "Russell Wilson":{p:"Prime-age QB in WAS with an established role; value tracks team volume and health."},
  "Roschon Johnson":{p:"Veteran RB in CIN with a steadier, experience-based floor; age is the long-term question."},
  "Fernando Mendoza":{p:"Top rookie QB of the 2026 class stepping into a starting opportunity; raw but high-upside with developing rushing ability."},
  "Noah Fant":{p:"Prime-age TE in CHI with an established role; value tracks team volume and health."},
  "Ja'Lynn Polk":{p:"Prime-age WR in PIT with an established role; value tracks team volume and health."},
  "Ray Davis":{p:"Prime-age RB in CLE with an established role; value tracks team volume and health."},
  "Quinten Joyner":{p:"Young RB in LAR with developmental upside; role and snaps will define the season."},
  "Troy Franklin":{p:"Prime-age WR in SEA with an established role; value tracks team volume and health."},
  "Matthew Stafford":{p:"Veteran QB in LV with a steadier, experience-based floor; age is the long-term question."},
  "Dawson Knox":{p:"Prime-age TE in LV with an established role; value tracks team volume and health."},
  "Braelon Allen":{p:"Veteran RB in LV with a steadier, experience-based floor; age is the long-term question."},
  "Xavier Legette":{p:"Prime-age WR in CIN with an established role; value tracks team volume and health."},
  "Joe Flacco":{p:"Prime-age QB in WAS with an established role; value tracks team volume and health."},
  "Isaac Guerendo":{p:"Prime-age RB in TEN with an established role; value tracks team volume and health."},
  "Theo Johnson":{p:"Young TE in BUF with developmental upside; role and snaps will define the season."},
  "Jalen McMillan":{p:"Prime-age WR in NE with an established role; value tracks team volume and health."},
  "Jaylen Wright":{p:"Young RB in ARI with developmental upside; role and snaps will define the season."},
  "Will Levis":{p:"Veteran QB in TB with a steadier, experience-based floor; age is the long-term question."},
  "Andrei Iosivas":{p:"Young WR in GB with developmental upside; role and snaps will define the season."},
  "Ja'Tavion Sanders":{p:"Veteran TE in JAX with a steadier, experience-based floor; age is the long-term question."},
  "Antonio Williams":{p:"Young WR in BUF with developmental upside; role and snaps will define the season."},
  "MarShawn Lloyd":{p:"Prime-age RB in WAS with an established role; value tracks team volume and health."},
  "Jalen Coker":{p:"Prime-age WR in IND with an established role; value tracks team volume and health."},
  "Mac Jones":{p:"Prime-age QB in WAS with an established role; value tracks team volume and health."},
  "Blake Corum":{p:"Veteran RB in TB with a steadier, experience-based floor; age is the long-term question."},
  "Quentin Johnston":{p:"Veteran WR in IND with a steadier, experience-based floor; age is the long-term question."},
  "Isaiah Likely":{p:"Prime-age TE in PHI with an established role; value tracks team volume and health."},
  "Eric Singleton Jr.":{p:"Young WR in LAC with developmental upside; role and snaps will define the season."},
  "Cedric Tillman":{p:"Prime-age WR in DAL with an established role; value tracks team volume and health."},
  "Bhayshul Tuten":{p:"Prime-age RB in BAL with an established role; value tracks team volume and health."},
  "Spencer Rattler":{p:"Prime-age QB in MIN with an established role; value tracks team volume and health."},
  "Romeo Doubs":{p:"Prime-age WR in DET with an established role; value tracks team volume and health."},
  "Kyle Pitts":{p:"Prime-age TE in LAC with an established role; value tracks team volume and health."},
  "Kenyon Sadiq":{p:"Athletic rookie TE; developmental but a long-term ascending profile."},
  "Rico Dowdle":{p:"Veteran RB in SEA with a steadier, experience-based floor; age is the long-term question."},
  "Jameis Winston":{p:"Prime-age QB in WAS with an established role; value tracks team volume and health."},
  "Christian Kirk":{p:"Prime-age WR in GB with an established role; value tracks team volume and health."},
  "Dalton Kincaid":{p:"Veteran TE in TB with a steadier, experience-based floor; age is the long-term question."},
  "Najee Harris":{p:"Prime-age RB in SF with an established role; value tracks team volume and health."},
  "Denzel Boston":{p:"Young WR in NYJ with developmental upside; role and snaps will define the season."},
  "Josh Downs":{p:"Prime-age WR in CAR with an established role; value tracks team volume and health."},
  "Jarrett Stidham":{p:"Prime-age QB in JAX with an established role; value tracks team volume and health."},
  "Marvin Mims":{p:"Young WR in CAR with developmental upside; role and snaps will define the season."},
  "Joe Mixon":{p:"Prime-age RB in NYG with an established role; value tracks team volume and health."},
  "Drew Allar":{p:"Young QB in TEN with developmental upside; role and snaps will define the season."},
  "Jonnu Smith":{p:"Prime-age TE in MIA with an established role; value tracks team volume and health."},
  "Darnell Mooney":{p:"Prime-age WR in LV with an established role; value tracks team volume and health."},
  "Kirk Cousins":{p:"Prime-age QB in NYJ with an established role; value tracks team volume and health."},
  "Nick Chubb":{p:"Young RB in SEA with developmental upside; role and snaps will define the season."},
  "Hunter Henry":{p:"Prime-age TE in ARI with an established role; value tracks team volume and health."},
  "Hollywood Brown":{p:"Prime-age WR in ATL with an established role; value tracks team volume and health."},
  "Austin Ekeler":{p:"Veteran RB in CHI with a steadier, experience-based floor; age is the long-term question."},
  "LaNorris Sellers":{p:"Young QB in LV with developmental upside; role and snaps will define the season."},
  "Antonio Gibson":{p:"Veteran RB in BAL with a steadier, experience-based floor; age is the long-term question."},
  "Pat Freiermuth":{p:"Young TE in PIT with developmental upside; role and snaps will define the season."},
  "Demario Douglas":{p:"Prime-age WR in NO with an established role; value tracks team volume and health."},
  "Zamir White":{p:"Prime-age RB in NO with an established role; value tracks team volume and health."},
  "Jake Ferguson":{p:"Prime-age TE in LV with an established role; value tracks team volume and health."},
  "Tyler Lockett":{p:"Prime-age WR in BAL with an established role; value tracks team volume and health."},
  "Devin Singletary":{p:"Prime-age RB in WAS with an established role; value tracks team volume and health."},
  "Keenan Allen":{p:"Prime-age WR in SF with an established role; value tracks team volume and health."},
  "Evan Engram":{p:"Veteran TE in IND with a steadier, experience-based floor; age is the long-term question."},
  "Samaje Perine":{p:"Prime-age RB in LAR with an established role; value tracks team volume and health."},
  "Amari Cooper":{p:"Prime-age WR in LV with an established role; value tracks team volume and health."},
  "Jerome Ford":{p:"Veteran RB in MIA with a steadier, experience-based floor; age is the long-term question."},
  "Brenton Strange":{p:"Veteran TE in NYJ with a steadier, experience-based floor; age is the long-term question."},
  "Diontae Johnson":{p:"Young WR in SF with developmental upside; role and snaps will define the season."},
  "Ty Chandler":{p:"Prime-age RB in HOU with an established role; value tracks team volume and health."},
  "Zach Ertz":{p:"Veteran TE in DET with a steadier, experience-based floor; age is the long-term question."},
  "Allen Lazard":{p:"Prime-age WR in CLE with an established role; value tracks team volume and health."},
  "Will Shipley":{p:"Prime-age RB in BUF with an established role; value tracks team volume and health."},
  "Julian Sayin":{p:"Young QB in CLE with developmental upside; role and snaps will define the season."},
  "Brandin Cooks":{p:"Prime-age WR in NE with an established role; value tracks team volume and health."},
  "Audric Estime":{p:"Veteran RB in ATL with a steadier, experience-based floor; age is the long-term question."},
  "DeAndre Hopkins":{p:"Veteran WR in DET with a steadier, experience-based floor; age is the long-term question."},
  "Sean Tucker":{p:"Prime-age RB in MIN with an established role; value tracks team volume and health."},
  "Emanuel Wilson":{p:"Prime-age RB in DET with an established role; value tracks team volume and health."},
  "Brandon Aubrey":{p:"Kicker tied to DAL's scoring; stream by matchup, not a draft priority."},
  "Harrison Butker":{p:"Kicker tied to IND's scoring; stream by matchup, not a draft priority."},
  "Broncos D/ST":{p:"Streaming defense; value swings with weekly matchup and turnover variance."},
  "Jake Bates":{p:"Kicker tied to WAS's scoring; stream by matchup, not a draft priority."},
  "Eagles D/ST":{p:"Streaming defense; value swings with weekly matchup and turnover variance."},
  "Cameron Dicker":{p:"Kicker tied to DET's scoring; stream by matchup, not a draft priority."},
  "Texans D/ST":{p:"Streaming defense; value swings with weekly matchup and turnover variance."},
  "Ravens D/ST":{p:"Streaming defense; value swings with weekly matchup and turnover variance."},
  "Chris Boswell":{p:"Kicker tied to PIT's scoring; stream by matchup, not a draft priority."},
  "Ka'imi Fairbairn":{p:"Kicker tied to BUF's scoring; stream by matchup, not a draft priority."},
  "Steelers D/ST":{p:"Streaming defense; value swings with weekly matchup and turnover variance."},
  "Bills D/ST":{p:"Streaming defense; value swings with weekly matchup and turnover variance."},
  "Jason Sanders":{p:"Kicker tied to SEA's scoring; stream by matchup, not a draft priority."},
  "Vikings D/ST":{p:"Streaming defense; value swings with weekly matchup and turnover variance."},
  "Tyler Bass":{p:"Kicker tied to TB's scoring; stream by matchup, not a draft priority."},
  "Packers D/ST":{p:"Streaming defense; value swings with weekly matchup and turnover variance."},
  "Chargers D/ST":{p:"Streaming defense; value swings with weekly matchup and turnover variance."},
  "Younghoe Koo":{p:"Kicker tied to JAX's scoring; stream by matchup, not a draft priority."},
  "Lions D/ST":{p:"Streaming defense; value swings with weekly matchup and turnover variance."},
  "Wil Lutz":{p:"Kicker tied to NYJ's scoring; stream by matchup, not a draft priority."},
  "Seahawks D/ST":{p:"Streaming defense; value swings with weekly matchup and turnover variance."},
  "Jake Elliott":{p:"Kicker tied to CAR's scoring; stream by matchup, not a draft priority."},
  "Chiefs D/ST":{p:"Streaming defense; value swings with weekly matchup and turnover variance."},
  "49ers D/ST":{p:"Streaming defense; value swings with weekly matchup and turnover variance."},
  "Evan McPherson":{p:"Kicker tied to LAC's scoring; stream by matchup, not a draft priority."},
  "Saints D/ST":{p:"Streaming defense; value swings with weekly matchup and turnover variance."},
  "Joshua Karty":{p:"Kicker tied to NO's scoring; stream by matchup, not a draft priority."},
  "Cowboys D/ST":{p:"Streaming defense; value swings with weekly matchup and turnover variance."},
  "Matt Gay":{p:"Kicker tied to CLE's scoring; stream by matchup, not a draft priority."},
  "Jets D/ST":{p:"Streaming defense; value swings with weekly matchup and turnover variance."},
  "Chase McLaughlin":{p:"Kicker tied to PHI's scoring; stream by matchup, not a draft priority."},
  "Cairo Santos":{p:"Kicker tied to NE's scoring; stream by matchup, not a draft priority."}
};

let STATS = {
  "Ja'Marr Chase":{rec:135,tgt:202,recYd:1230,recTD:13,fum:3,hundredYd:2.0,bigPlay:10.7},
  "Bijan Robinson":{rushAtt:330,rushYd:1420,rushTD:15,rec:41,tgt:53,recYd:290,recTD:4,fum:2,hundredYd:4.0,bigPlay:14.9},
  "Jahmyr Gibbs":{rushAtt:408,rushYd:1755,rushTD:15,rec:33,tgt:43,recYd:275,fum:3,hundredYd:5.3,bigPlay:17.7},
  "Justin Jefferson":{rushAtt:6,rushYd:30,rec:131,tgt:196,recYd:1090,recTD:12,hundredYd:1.5,bigPlay:9.7},
  "Saquon Barkley":{rushAtt:305,rushYd:1312,rushTD:14,rec:41,tgt:53,recYd:348,recTD:3,fum:2,hundredYd:3.8,bigPlay:14.4},
  "CeeDee Lamb":{rec:125,tgt:188,recYd:1070,recTD:12,fum:2,hundredYd:1.3,bigPlay:9.3},
  "Puka Nacua":{rec:128,tgt:192,recYd:1080,recTD:12,fum:1,hundredYd:1.3,bigPlay:9.4},
  "Amon-Ra St. Brown":{rushAtt:4,rushYd:70,rec:124,tgt:186,recYd:1070,recTD:11,fum:3,hundredYd:1.6,bigPlay:9.9},
  "De'Von Achane":{rushAtt:264,rushYd:1137,rushTD:14,rec:59,tgt:77,recYd:453,fum:1,hundredYd:3.5,bigPlay:13.8},
  "Malik Nabers":{rec:121,tgt:182,recYd:1090,recTD:11,fum:3,hundredYd:1.4,bigPlay:9.5},
  "Nico Collins":{rushAtt:3,rushYd:30,rec:118,tgt:177,recYd:990,recTD:11,fum:2,hundredYd:1.1,bigPlay:8.9},
  "Ashton Jeanty":{rushAtt:196,rushYd:842,rushTD:13,rec:70,tgt:91,recYd:628,recTD:1,fum:3,hundredYd:3.0,bigPlay:12.8},
  "Brian Thomas Jr.":{rec:117,tgt:176,recYd:970,recTD:11,hundredYd:0.9,bigPlay:8.4},
  "Christian McCaffrey":{rushAtt:275,rushYd:1183,rushTD:13,rec:41,tgt:53,recYd:367,recTD:4,fum:4,hundredYd:3.3,bigPlay:13.5},
  "Drake London":{rec:115,tgt:172,recYd:990,recTD:11,fum:2,hundredYd:0.9,bigPlay:8.6},
  "A.J. Brown":{rushAtt:4,rushYd:70,rec:113,tgt:170,recYd:940,recTD:10,fum:1,hundredYd:1.0,bigPlay:8.8},
  "Josh Jacobs":{rushAtt:98,rushYd:422,rushTD:12,rec:72,tgt:94,recYd:638,recTD:4,fum:2,hundredYd:1.2,bigPlay:9.2},
  "Brock Bowers":{rec:94,tgt:136,recYd:990,recTD:11,fum:2,hundredYd:0.9,bigPlay:8.6},
  "Derrick Henry":{rushAtt:314,rushYd:1351,rushTD:12,rec:38,tgt:49,recYd:249,fum:1,hundredYd:3.5,bigPlay:13.9},
  "Trey McBride":{rec:89,tgt:129,recYd:930,recTD:10,fum:1,hundredYd:0.7,bigPlay:8.1},
  "Ladd McConkey":{rec:106,tgt:159,recYd:950,recTD:10,fum:3,hundredYd:0.8,bigPlay:8.3},
  "Jaxon Smith-Njigba":{rushAtt:3,rushYd:70,rec:108,tgt:162,recYd:910,recTD:10,fum:3,hundredYd:0.9,bigPlay:8.5},
  "Tee Higgins":{rec:104,tgt:156,recYd:880,recTD:10,fum:1,hundredYd:0.5,bigPlay:7.7},
  "Kyren Williams":{rushAtt:342,rushYd:1471,rushTD:11,rec:16,tgt:21,recYd:109,recTD:3,fum:3,hundredYd:3.4,bigPlay:13.7},
  "Bucky Irving":{rushAtt:137,rushYd:587,rushTD:12,rec:67,tgt:87,recYd:543,recTD:1,fum:1,hundredYd:1.5,bigPlay:9.8},
  "Chase Brown":{rushAtt:103,rushYd:443,rushTD:11,rec:72,tgt:94,recYd:617,recTD:2,fum:4,hundredYd:1.2,bigPlay:9.2},
  "Garrett Wilson":{rec:103,tgt:154,recYd:870,recTD:10,fum:1,hundredYd:0.4,bigPlay:7.6},
  "Marvin Harrison Jr.":{rec:104,tgt:156,recYd:920,recTD:10,fum:3,hundredYd:0.7,bigPlay:8.0},
  "Davante Adams":{rushAtt:9,rushYd:70,rec:97,tgt:146,recYd:760,recTD:9,fum:1,hundredYd:0.3,bigPlay:7.2},
  "Terry McLaurin":{rushAtt:6,rushYd:30,rec:100,tgt:150,recYd:850,recTD:9,fum:1,hundredYd:0.5,bigPlay:7.7},
  "Mike Evans":{rec:99,tgt:148,recYd:850,recTD:9,hundredYd:0.4,bigPlay:7.4},
  "Omarion Hampton":{rushAtt:292,rushYd:1255,rushTD:11,rec:31,tgt:40,recYd:215,recTD:1,fum:3,hundredYd:3.0,bigPlay:12.8},
  "Breece Hall":{rushAtt:206,rushYd:885,rushTD:11,rec:38,tgt:49,recYd:335,recTD:3,fum:2,hundredYd:1.9,bigPlay:10.6},
  "Kenneth Walker III":{rushAtt:120,rushYd:518,rushTD:11,rec:56,tgt:73,recYd:482,recTD:3,fum:2,hundredYd:1.0,bigPlay:8.7},
  "DK Metcalf":{rec:95,tgt:142,recYd:790,recTD:9,hundredYd:0.1,bigPlay:6.9},
  "George Kittle":{rec:83,tgt:120,recYd:880,recTD:9,hundredYd:0.5,bigPlay:7.7},
  "Rashee Rice":{rushAtt:5,rushYd:30,rec:100,tgt:150,recYd:830,recTD:9,hundredYd:0.4,bigPlay:7.5},
  "Jonathan Taylor":{rushAtt:280,rushYd:1205,rushTD:11,rec:17,tgt:22,recYd:125,recTD:4,fum:1,hundredYd:2.4,bigPlay:11.6},
  "DeVonta Smith":{rec:94,tgt:141,recYd:840,recTD:9,fum:3,hundredYd:0.3,bigPlay:7.3},
  "Xavier Worthy":{rec:95,tgt:142,recYd:830,recTD:9,fum:2,hundredYd:0.3,bigPlay:7.2},
  "James Cook":{rushAtt:89,rushYd:381,rushTD:11,rec:65,tgt:84,recYd:509,recTD:3,fum:3,hundredYd:0.5,bigPlay:7.7},
  "Josh Allen":{passYd:4945,passTD:43,INT:9,rushAtt:132,rushYd:532,rushTD:1,fum:3,threeHundredYd:2.0},
  "Alvin Kamara":{rushAtt:84,rushYd:362,rushTD:10,rec:67,tgt:87,recYd:488,recTD:3,fum:2,hundredYd:0.4,bigPlay:7.4},
  "Jonathon Brooks":{rushAtt:167,rushYd:718,rushTD:10,rec:44,tgt:57,recYd:382,recTD:2,fum:1,hundredYd:1.4,bigPlay:9.6},
  "Lamar Jackson":{passYd:5072,passTD:42,INT:12,rushAtt:89,rushYd:451,rushTD:2,fum:2,threeHundredYd:2.2},
  "Tetairoa McMillan":{rec:92,tgt:138,recYd:800,recTD:9,fum:2,hundredYd:0.1,bigPlay:7.0},
  "Jayden Daniels":{passYd:4788,passTD:41,INT:8,rushAtt:48,rushYd:275,rushTD:4,fum:3,threeHundredYd:1.8},
  "Travis Hunter":{rushAtt:9,rushYd:70,rec:94,tgt:141,recYd:740,recTD:9,fum:2,hundredYd:0.2,bigPlay:7.0},
  "Jameson Williams":{rec:90,tgt:135,recYd:820,recTD:8,fum:2,hundredYd:0.2,bigPlay:7.1},
  "Jalen Hurts":{passYd:4760,passTD:40,INT:15,rushAtt:95,rushYd:536,rushTD:2,fum:3,threeHundredYd:1.8},
  "Calvin Ridley":{rec:88,tgt:132,recYd:780,recTD:8,fum:2,hundredYd:0.1,bigPlay:6.8},
  "Zay Flowers":{rec:91,tgt:136,recYd:810,recTD:8,fum:1,hundredYd:0.2,bigPlay:7.0},
  "Joe Burrow":{passYd:4458,passTD:39,INT:13,rushAtt:119,rushYd:407,rushTD:6,fum:5,threeHundredYd:1.3},
  "Sam LaPorta":{rec:76,tgt:110,recYd:790,recTD:9,fum:2,hundredYd:0.1,bigPlay:6.9},
  "Tyreek Hill":{rec:90,tgt:135,recYd:830,recTD:8,fum:3,hundredYd:0.3,bigPlay:7.2},
  "TreVeyon Henderson":{rushAtt:90,rushYd:389,rushTD:10,rec:64,tgt:83,recYd:471,recTD:2,fum:2,hundredYd:0.4,bigPlay:7.5},
  "George Pickens":{rushAtt:5,rushYd:70,rec:88,tgt:132,recYd:730,recTD:8,fum:2,hundredYd:0.1,bigPlay:7.0},
  "Jaylen Waddle":{rushAtt:8,rushYd:70,rec:85,tgt:128,recYd:670,recTD:8,fum:1,bigPlay:6.4},
  "Courtland Sutton":{rushAtt:5,rushYd:70,rec:89,tgt:134,recYd:720,recTD:8,fum:1,hundredYd:0.1,bigPlay:6.9},
  "Quinshon Judkins":{rushAtt:70,rushYd:250,rushTD:9,rec:69,tgt:90,recYd:597,recTD:1,fum:4,hundredYd:0.3,bigPlay:7.4},
  "Aaron Jones":{rushAtt:80,rushYd:343,rushTD:9,rec:60,tgt:78,recYd:407,recTD:3,fum:1,bigPlay:6.5},
  "Chuba Hubbard":{rushAtt:211,rushYd:906,rushTD:10,rec:41,tgt:53,recYd:364,fum:3,hundredYd:2.1,bigPlay:11.0},
  "David Montgomery":{rushAtt:140,rushYd:603,rushTD:9,rec:37,tgt:48,recYd:327,recTD:4,fum:4,hundredYd:0.7,bigPlay:8.1},
  "Patrick Mahomes":{passYd:3812,passTD:38,INT:11,rushAtt:99,rushYd:495,rushTD:6,fum:4,threeHundredYd:0.4},
  "Chris Olave":{rec:83,tgt:124,recYd:730,recTD:8,fum:2,bigPlay:6.3},
  "Baker Mayfield":{passYd:4220,passTD:37,INT:7,rushAtt:49,rushYd:472,rushTD:1,fum:3,threeHundredYd:1.0},
  "DJ Moore":{rec:83,tgt:124,recYd:690,recTD:8,bigPlay:6.0},
  "Jerry Jeudy":{rec:84,tgt:126,recYd:760,recTD:8,fum:3,bigPlay:6.6},
  "Jordan Love":{passYd:4050,passTD:36,INT:12,rushAtt:113,rushYd:380,rushTD:5,fum:5,threeHundredYd:0.7},
  "Jordan Addison":{rec:79,tgt:118,recYd:730,recTD:7,fum:2,bigPlay:6.3},
  "Rome Odunze":{rec:81,tgt:122,recYd:660,recTD:8,bigPlay:5.7},
  "Bo Nix":{passYd:5088,passTD:36,INT:13,rushAtt:82,rushYd:195,rushTD:2,fum:4,threeHundredYd:2.2},
  "Khalil Shakir":{rec:78,tgt:117,recYd:700,recTD:7,fum:1,bigPlay:6.1},
  "Caleb Williams":{passYd:3702,passTD:35,INT:14,rushAtt:93,rushYd:419,rushTD:6,fum:4,threeHundredYd:0.2},
  "Jakobi Meyers":{rec:82,tgt:123,recYd:680,recTD:8,fum:1,bigPlay:5.9},
  "T.J. Hockenson":{rec:69,tgt:100,recYd:700,recTD:8,fum:1,bigPlay:6.1},
  "Travis Etienne":{rushAtt:113,rushYd:487,rushTD:8,rec:42,tgt:55,recYd:333,recTD:2,fum:4,hundredYd:0.2,bigPlay:7.1},
  "Mark Andrews":{rec:67,tgt:97,recYd:690,recTD:8,fum:2,bigPlay:6.0},
  "David Njoku":{rec:67,tgt:97,recYd:690,recTD:8,fum:1,bigPlay:6.0},
  "Tony Pollard":{rushAtt:147,rushYd:632,rushTD:9,rec:39,tgt:51,recYd:318,recTD:3,fum:4,hundredYd:0.8,bigPlay:8.3},
  "Isiah Pacheco":{rushAtt:164,rushYd:705,rushTD:9,rec:25,tgt:32,recYd:225,recTD:4,fum:2,hundredYd:0.7,bigPlay:8.1},
  "Brock Purdy":{passYd:5205,passTD:35,INT:15,rushAtt:103,rushYd:118,rushTD:1,fum:3,threeHundredYd:2.4},
  "Kaleb Johnson":{rushAtt:203,rushYd:872,rushTD:9,rec:25,tgt:32,recYd:198,recTD:2,fum:1,hundredYd:1.3,bigPlay:9.3},
  "Justin Herbert":{passYd:4265,passTD:35,INT:15,rushAtt:114,rushYd:384,rushTD:3,fum:1,threeHundredYd:1.0},
  "RJ Harvey":{rushAtt:101,rushYd:433,rushTD:10,rec:56,tgt:73,recYd:387,recTD:3,fum:3,hundredYd:0.2,bigPlay:7.1},
  "Zach Charbonnet":{rushAtt:189,rushYd:814,rushTD:8,rec:22,tgt:29,recYd:146,recTD:3,fum:1,hundredYd:0.8,bigPlay:8.3},
  "Jaylen Warren":{rushAtt:93,rushYd:400,rushTD:9,rec:45,tgt:58,recYd:310,recTD:4,fum:3,bigPlay:6.2},
  "Tucker Kraft":{rec:66,tgt:96,recYd:720,recTD:7,fum:1,bigPlay:6.3},
  "Tyler Warren":{rec:64,tgt:93,recYd:660,recTD:7,bigPlay:5.7},
  "Colston Loveland":{rec:61,tgt:88,recYd:660,recTD:7,fum:2,bigPlay:5.7},
  "C.J. Stroud":{passYd:3920,passTD:34,INT:13,rushAtt:54,rushYd:472,rushTD:2,fum:2,threeHundredYd:0.5},
  "Dak Prescott":{passYd:4778,passTD:34,INT:14,rushAtt:124,rushYd:199,rushTD:2,fum:3,threeHundredYd:1.8},
  "Kyler Murray":{passYd:4285,passTD:34,INT:12,rushAtt:139,rushYd:346,rushTD:1,fum:2,threeHundredYd:1.1},
  "Drake Maye":{passYd:4252,passTD:35,INT:15,rushAtt:123,rushYd:419,rushTD:2,fum:3,threeHundredYd:1.0},
  "Jordan Mason":{rushAtt:199,rushYd:857,rushTD:8,rec:26,tgt:34,recYd:223,fum:2,hundredYd:1.3,bigPlay:9.4},
  "Jared Goff":{passYd:4140,passTD:33,INT:9,rushAtt:137,rushYd:104,rushTD:5,fum:1,threeHundredYd:0.8},
  "Tyjae Spears":{rushAtt:70,rushYd:250,rushTD:8,rec:64,tgt:83,recYd:555,recTD:1,fum:3,hundredYd:0.2,bigPlay:7.0},
  "J.J. McCarthy":{passYd:3522,passTD:33,INT:10,rushAtt:60,rushYd:371,rushTD:5,fum:5},
  "Trey Benson":{rushAtt:70,rushYd:250,rushTD:8,rec:59,tgt:77,recYd:503,fum:3,bigPlay:6.5},
  "Cam Skattebo":{rushAtt:70,rushYd:250,rushTD:8,rec:71,tgt:92,recYd:493,recTD:1,fum:3,bigPlay:6.5},
  "Trevor Lawrence":{passYd:4065,passTD:33,INT:8,rushAtt:133,rushYd:314,rushTD:2,fum:5,threeHundredYd:0.7},
  "Jaydon Blue":{rushAtt:205,rushYd:881,rushTD:7,rec:17,tgt:22,recYd:149,recTD:1,fum:4,hundredYd:1.1,bigPlay:9.0},
  "Stefon Diggs":{rec:80,tgt:120,recYd:700,recTD:7,bigPlay:6.1},
  "Daniel Jones":{passYd:3338,passTD:32,INT:14,rushAtt:50,rushYd:465,rushTD:6,fum:5},
  "Keon Coleman":{rec:75,tgt:112,recYd:650,recTD:7,fum:1,bigPlay:5.7},
  "Jayden Reed":{rec:76,tgt:114,recYd:700,recTD:7,fum:3,bigPlay:6.1},
  "Rashod Bateman":{rec:70,tgt:105,recYd:660,recTD:6,fum:2,bigPlay:5.7},
  "Sam Darnold":{passYd:3342,passTD:32,INT:7,rushAtt:78,rushYd:263,rushTD:5,fum:1},
  "Deebo Samuel":{rec:72,tgt:108,recYd:600,recTD:7,fum:1,bigPlay:5.2},
  "Jauan Jennings":{rec:71,tgt:106,recYd:570,recTD:7,bigPlay:5.0},
  "Matthew Golden":{rec:73,tgt:110,recYd:640,recTD:7,fum:2,bigPlay:5.6},
  "Dallas Goedert":{rec:61,tgt:88,recYd:620,recTD:7,bigPlay:5.4},
  "Geno Smith":{passYd:3250,passTD:31,INT:14,rushAtt:45,rushYd:470,rushTD:4,fum:1},
  "Michael Pittman Jr.":{rec:70,tgt:105,recYd:660,recTD:6,fum:2,bigPlay:5.7},
  "Cooper Kupp":{rec:74,tgt:111,recYd:660,recTD:7,fum:2,bigPlay:5.7},
  "Tank Bigsby":{rushAtt:70,rushYd:294,rushTD:8,rec:57,tgt:74,recYd:486,fum:4,hundredYd:0.1,bigPlay:6.8},
  "Cole Kmet":{rec:61,tgt:88,recYd:650,recTD:7,fum:2,bigPlay:5.7},
  "Jeremiah Smith":{rushAtt:4,rushYd:30,rec:77,tgt:116,recYd:650,recTD:7,fum:1,bigPlay:5.9},
  "Michael Penix Jr.":{passYd:3180,passTD:31,INT:7,rushAtt:93,rushYd:438,rushTD:3,fum:4},
  "Adam Thielen":{rec:72,tgt:108,recYd:600,recTD:7,fum:1,bigPlay:5.2},
  "Tyler Allgeier":{rushAtt:70,rushYd:250,rushTD:8,rec:68,tgt:88,recYd:483,fum:2,bigPlay:6.4},
  "Chig Okonkwo":{rec:59,tgt:86,recYd:610,recTD:7,fum:1,bigPlay:5.3},
  "Jeremiyah Love":{rushAtt:113,rushYd:487,rushTD:9,rec:36,tgt:47,recYd:273,recTD:4,fum:1,bigPlay:6.6},
  "Joshua Palmer":{rec:72,tgt:108,recYd:580,recTD:7,bigPlay:5.0},
  "Justice Hill":{rushAtt:153,rushYd:657,rushTD:8,rec:32,tgt:42,recYd:213,recTD:1,fum:3,hundredYd:0.4,bigPlay:7.6},
  "Tua Tagovailoa":{passYd:3760,passTD:30,INT:11,rushAtt:59,rushYd:356,rushTD:2,fum:4,threeHundredYd:0.3},
  "Makai Lemon":{rushAtt:3,rushYd:70,rec:73,tgt:110,recYd:530,recTD:7,bigPlay:5.2},
  "Jaleel McLaughlin":{rushAtt:70,rushYd:250,rushTD:7,rec:80,tgt:104,recYd:535,recTD:3,fum:4,hundredYd:0.1,bigPlay:6.8},
  "DeMario Douglas":{rec:72,tgt:108,recYd:600,recTD:7,fum:1,bigPlay:5.2},
  "Will Dissly":{rec:59,tgt:86,recYd:590,recTD:7,fum:1,bigPlay:5.1},
  "Nicholas Singleton":{rushAtt:140,rushYd:602,rushTD:8,rec:32,tgt:42,recYd:238,recTD:3,fum:1,hundredYd:0.3,bigPlay:7.3},
  "Anthony Richardson":{passYd:3338,passTD:30,INT:9,rushAtt:102,rushYd:435,rushTD:2,fum:5},
  "Dyami Brown":{rushAtt:9,rushYd:70,rec:70,tgt:105,recYd:580,recTD:6,fum:1,bigPlay:5.7},
  "Carnell Tate":{rec:71,tgt:106,recYd:570,recTD:7,bigPlay:5.0},
  "Kareem Hunt":{rushAtt:101,rushYd:435,rushTD:7,rec:41,tgt:53,recYd:315,recTD:1,fum:2,bigPlay:6.5},
  "Mike Gesicki":{rec:57,tgt:83,recYd:620,recTD:6,bigPlay:5.4},
  "Calvin Austin III":{rushAtt:5,rushYd:70,rec:69,tgt:104,recYd:550,recTD:6,fum:1,bigPlay:5.4},
  "Elijah Mitchell":{rushAtt:70,rushYd:298,rushTD:7,rec:37,tgt:48,recYd:262,recTD:4,fum:1,bigPlay:4.9},
  "Aaron Rodgers":{passYd:3598,passTD:29,INT:15,rushAtt:90,rushYd:411,rushTD:2,fum:4},
  "Wan'Dale Robinson":{rec:68,tgt:102,recYd:590,recTD:6,bigPlay:5.1},
  "Kendre Miller":{rushAtt:70,rushYd:250,rushTD:7,rec:48,tgt:62,recYd:371,recTD:2,fum:3,bigPlay:5.4},
  "Cade Otton":{rec:56,tgt:81,recYd:590,recTD:6,bigPlay:5.1},
  "Jordyn Tyson":{rec:70,tgt:105,recYd:620,recTD:6,bigPlay:5.4},
  "Adonai Mitchell":{rec:68,tgt:102,recYd:640,recTD:6,fum:3,bigPlay:5.6},
  "Russell Wilson":{passYd:2892,passTD:29,INT:12,rushAtt:124,rushYd:533,rushTD:2,fum:1},
  "Roschon Johnson":{rushAtt:70,rushYd:250,rushTD:7,rec:53,tgt:69,recYd:464,recTD:1,fum:3,bigPlay:6.2},
  "Fernando Mendoza":{passYd:4062,passTD:32,INT:11,rushAtt:77,rushYd:355,rushTD:1,fum:5,threeHundredYd:0.7},
  "Noah Fant":{rec:54,tgt:78,recYd:550,recTD:6,bigPlay:4.8},
  "Ja'Lynn Polk":{rec:65,tgt:98,recYd:590,recTD:6,fum:2,bigPlay:5.1},
  "Ray Davis":{rushAtt:101,rushYd:433,rushTD:7,rec:36,tgt:47,recYd:247,recTD:2,fum:4,bigPlay:5.9},
  "Quinten Joyner":{rushAtt:70,rushYd:250,rushTD:7,rec:55,tgt:72,recYd:385,recTD:4,fum:3,bigPlay:5.5},
  "Troy Franklin":{rec:64,tgt:96,recYd:530,recTD:6,bigPlay:4.6},
  "Matthew Stafford":{passYd:4070,passTD:28,INT:12,rushAtt:50,rushYd:132,rushTD:2,fum:5,threeHundredYd:0.7},
  "Dawson Knox":{rec:51,tgt:74,recYd:530,recTD:6,fum:1,bigPlay:4.6},
  "Braelon Allen":{rushAtt:150,rushYd:643,rushTD:7,rec:18,tgt:23,recYd:157,recTD:2,fum:3,hundredYd:0.1,bigPlay:7.0},
  "Xavier Legette":{rushAtt:4,rushYd:30,rec:63,tgt:94,recYd:510,recTD:6,fum:1,bigPlay:4.7},
  "Joe Flacco":{passYd:3990,passTD:27,INT:8,rushAtt:67,rushYd:74,rushTD:1,fum:2,threeHundredYd:0.6},
  "Isaac Guerendo":{rushAtt:70,rushYd:250,rushTD:6,rec:44,tgt:57,recYd:370,recTD:2,fum:3,bigPlay:5.4},
  "Theo Johnson":{rec:50,tgt:72,recYd:490,recTD:6,bigPlay:4.3},
  "Jalen McMillan":{rec:62,tgt:93,recYd:500,recTD:6,bigPlay:4.3},
  "Jaylen Wright":{rushAtt:77,rushYd:333,rushTD:6,rec:30,tgt:39,recYd:247,recTD:3,fum:1,bigPlay:5.0},
  "Will Levis":{passYd:3285,passTD:27,INT:12,rushAtt:88,rushYd:276,rushTD:4,fum:5},
  "Andrei Iosivas":{rec:60,tgt:90,recYd:510,recTD:6,fum:2,bigPlay:4.4},
  "Ja'Tavion Sanders":{rec:50,tgt:72,recYd:520,recTD:6,fum:2,bigPlay:4.5},
  "Antonio Williams":{rec:66,tgt:99,recYd:600,recTD:6,fum:2,bigPlay:5.2},
  "MarShawn Lloyd":{rushAtt:70,rushYd:250,rushTD:6,rec:50,tgt:65,recYd:333,recTD:4,fum:2,bigPlay:5.1},
  "Jalen Coker":{rec:58,tgt:87,recYd:510,recTD:5,bigPlay:4.4},
  "Mac Jones":{passYd:2882,passTD:27,INT:11,rushAtt:74,rushYd:377,rushTD:3,fum:1},
  "Blake Corum":{rushAtt:70,rushYd:250,rushTD:6,rec:55,tgt:72,recYd:387,recTD:4,fum:2,bigPlay:5.5},
  "Quentin Johnston":{rushAtt:3,rushYd:30,rec:55,tgt:82,recYd:510,recTD:5,fum:3,bigPlay:4.7},
  "Isaiah Likely":{rec:47,tgt:68,recYd:540,recTD:5,fum:2,bigPlay:4.7},
  "Eric Singleton Jr.":{rec:65,tgt:98,recYd:580,recTD:6,fum:2,bigPlay:5.0},
  "Cedric Tillman":{rec:54,tgt:81,recYd:510,recTD:5,fum:3,bigPlay:4.4},
  "Bhayshul Tuten":{rushAtt:135,rushYd:579,rushTD:6,rec:18,tgt:23,recYd:151,recTD:2,fum:4,bigPlay:6.3},
  "Spencer Rattler":{passYd:2685,passTD:27,INT:14,rushAtt:105,rushYd:466,rushTD:4,fum:3},
  "Romeo Doubs":{rushAtt:8,rushYd:30,rec:52,tgt:78,recYd:430,recTD:5,fum:1,bigPlay:4.0},
  "Kyle Pitts":{rec:44,tgt:64,recYd:500,recTD:5,fum:2,bigPlay:4.3},
  "Kenyon Sadiq":{rec:56,tgt:81,recYd:580,recTD:6,bigPlay:5.0},
  "Rico Dowdle":{rushAtt:70,rushYd:250,rushTD:6,rec:52,tgt:68,recYd:347,recTD:3,fum:2,bigPlay:5.2},
  "Jameis Winston":{passYd:2575,passTD:26,INT:11,rushAtt:83,rushYd:440,rushTD:4,fum:4},
  "Christian Kirk":{rushAtt:3,rushYd:70,rec:51,tgt:76,recYd:350,recTD:5,bigPlay:3.7},
  "Dalton Kincaid":{rec:43,tgt:62,recYd:430,recTD:5,bigPlay:3.7},
  "Najee Harris":{rushAtt:120,rushYd:518,rushTD:6,rec:26,tgt:34,recYd:182,recTD:1,fum:4,bigPlay:6.1},
  "Denzel Boston":{rec:62,tgt:93,recYd:520,recTD:6,bigPlay:4.5},
  "Josh Downs":{rec:48,tgt:72,recYd:440,recTD:4,bigPlay:3.8},
  "Jarrett Stidham":{passYd:2748,passTD:25,INT:10,rushAtt:41,rushYd:401,rushTD:2,fum:1},
  "Marvin Mims":{rec:48,tgt:72,recYd:480,recTD:4,fum:3,bigPlay:4.2},
  "Joe Mixon":{rushAtt:70,rushYd:250,rushTD:6,rec:39,tgt:51,recYd:351,recTD:1,fum:3,bigPlay:5.2},
  "Drew Allar":{passYd:4180,passTD:30,INT:13,rushAtt:136,rushYd:218,rushTD:1,fum:2,threeHundredYd:0.9},
  "Jonnu Smith":{rec:41,tgt:59,recYd:410,recTD:5,fum:1,bigPlay:3.6},
  "Darnell Mooney":{rushAtt:3,rushYd:70,rec:45,tgt:68,recYd:380,recTD:4,fum:3,bigPlay:3.9},
  "Kirk Cousins":{passYd:2238,passTD:24,INT:8,rushAtt:78,rushYd:545,rushTD:3,fum:5},
  "Nick Chubb":{rushAtt:70,rushYd:250,rushTD:6,rec:48,tgt:62,recYd:399,recTD:1,fum:3,bigPlay:5.6},
  "Hunter Henry":{rec:39,tgt:57,recYd:430,recTD:4,bigPlay:3.7},
  "Hollywood Brown":{rec:45,tgt:68,recYd:380,recTD:4,bigPlay:3.3},
  "Austin Ekeler":{rushAtt:70,rushYd:250,rushTD:6,rec:76,tgt:99,recYd:663,recTD:3,fum:2,hundredYd:0.6,bigPlay:7.9},
  "LaNorris Sellers":{passYd:3517,passTD:29,INT:14,rushAtt:79,rushYd:493,rushTD:2,fum:5},
  "Antonio Gibson":{rushAtt:70,rushYd:250,rushTD:5,rec:73,tgt:95,recYd:590,recTD:2,fum:3,hundredYd:0.3,bigPlay:7.3},
  "Pat Freiermuth":{rec:37,tgt:54,recYd:410,recTD:4,fum:1,bigPlay:3.6},
  "Demario Douglas":{rec:42,tgt:63,recYd:390,recTD:4,fum:2,bigPlay:3.4},
  "Zamir White":{rushAtt:70,rushYd:250,rushTD:5,rec:40,tgt:52,recYd:340,recTD:2,fum:2,bigPlay:5.1},
  "Jake Ferguson":{rec:36,tgt:52,recYd:370,recTD:4,bigPlay:3.2},
  "Tyler Lockett":{rushAtt:7,rushYd:30,rec:40,tgt:60,recYd:350,recTD:4,fum:2,bigPlay:3.3},
  "Devin Singletary":{rushAtt:81,rushYd:349,rushTD:5,rec:25,tgt:32,recYd:211,recTD:1,fum:4,bigPlay:4.9},
  "Keenan Allen":{rec:39,tgt:58,recYd:350,recTD:4,bigPlay:3.0},
  "Evan Engram":{rec:36,tgt:52,recYd:400,recTD:4,fum:2,bigPlay:3.5},
  "Samaje Perine":{rushAtt:70,rushYd:250,rushTD:5,rec:67,tgt:87,recYd:437,recTD:4,fum:1,bigPlay:6.0},
  "Amari Cooper":{rec:37,tgt:56,recYd:350,recTD:3,bigPlay:3.0},
  "Jerome Ford":{rushAtt:70,rushYd:250,rushTD:5,rec:74,tgt:96,recYd:482,fum:1,bigPlay:6.4},
  "Brenton Strange":{rec:34,tgt:49,recYd:340,recTD:4,bigPlay:3.0},
  "Diontae Johnson":{rec:37,tgt:56,recYd:360,recTD:3,fum:1,bigPlay:3.1},
  "Ty Chandler":{rushAtt:70,rushYd:250,rushTD:5,rec:40,tgt:52,recYd:333,fum:2,bigPlay:5.1},
  "Zach Ertz":{rec:32,tgt:46,recYd:340,recTD:4,fum:2,bigPlay:3.0},
  "Allen Lazard":{rec:35,tgt:52,recYd:350,recTD:3,fum:2,bigPlay:3.0},
  "Will Shipley":{rushAtt:70,rushYd:250,rushTD:5,rec:40,tgt:52,recYd:292,fum:1,bigPlay:4.7},
  "Julian Sayin":{passYd:3482,passTD:28,INT:10,rushAtt:104,rushYd:267,rushTD:3,fum:3},
  "Brandin Cooks":{rec:35,tgt:52,recYd:350,recTD:3,bigPlay:3.0},
  "Audric Estime":{rushAtt:70,rushYd:250,rushTD:5,rec:48,tgt:62,recYd:338,recTD:3,fum:3,bigPlay:5.1},
  "DeAndre Hopkins":{rec:35,tgt:52,recYd:350,recTD:3,fum:1,bigPlay:3.0},
  "Sean Tucker":{rushAtt:70,rushYd:250,rushTD:5,rec:57,tgt:74,recYd:492,recTD:4,fum:2,bigPlay:6.5},
  "Emanuel Wilson":{rushAtt:70,rushYd:250,rushTD:4,rec:70,tgt:91,recYd:561,recTD:3,fum:2,hundredYd:0.2,bigPlay:7.1},
  "Brandon Aubrey":{fg:36,fg50:4,pat:41,fgMiss:6},
  "Harrison Butker":{fg:40,fg50:6,pat:18,fgMiss:2},
  "Broncos D/ST":{sack:47,dint:17,dfr:11,dtd:2,pa:150},
  "Jake Bates":{fg:36,fg50:4,pat:31,fgMiss:2},
  "Eagles D/ST":{sack:30,dint:16,dfr:11,dtd:6,pa:170},
  "Cameron Dicker":{fg:31,fg50:6,pat:44,fgMiss:4},
  "Texans D/ST":{sack:33,dint:16,dfr:11,dtd:6,pa:220},
  "Ravens D/ST":{sack:52,dint:19,dfr:7,dtd:6,pa:410},
  "Chris Boswell":{fg:39,fg50:6,pat:19,fgMiss:7},
  "Ka'imi Fairbairn":{fg:33,fg50:7,pat:31,fgMiss:3},
  "Steelers D/ST":{sack:48,dint:10,dfr:6,dtd:2,pa:150},
  "Bills D/ST":{sack:48,dint:9,dfr:13,dtd:4,pa:210},
  "Jason Sanders":{fg:28,fg50:8,pat:45,fgMiss:6},
  "Vikings D/ST":{sack:45,dint:14,dfr:11,dtd:5,pa:320},
  "Tyler Bass":{fg:32,fg50:8,pat:26,fgMiss:2},
  "Packers D/ST":{sack:34,dint:20,dfr:11,dtd:2,pa:170},
  "Chargers D/ST":{sack:30,dint:12,dfr:16,dtd:1,pa:150},
  "Younghoe Koo":{fg:35,fg50:2,pat:29,fgMiss:5},
  "Lions D/ST":{sack:38,dint:17,dfr:9,dtd:5,pa:330},
  "Wil Lutz":{fg:32,fg50:3,pat:37,fgMiss:7},
  "Seahawks D/ST":{sack:37,dint:22,dfr:10,dtd:4,pa:400},
  "Jake Elliott":{fg:36,fg50:4,pat:22,fgMiss:7},
  "Chiefs D/ST":{sack:54,dint:10,dfr:10,dtd:6,pa:470},
  "49ers D/ST":{sack:49,dint:20,dfr:6,dtd:5,pa:480},
  "Evan McPherson":{fg:32,fg50:6,pat:22,fgMiss:3},
  "Saints D/ST":{sack:41,dint:16,dfr:14,dtd:2,pa:340},
  "Joshua Karty":{fg:31,fg50:6,pat:27,fgMiss:5},
  "Cowboys D/ST":{sack:51,dint:14,dfr:7,dtd:3,pa:340},
  "Matt Gay":{fg:26,fg50:2,pat:46,fgMiss:5},
  "Jets D/ST":{sack:35,dint:15,dfr:16,dtd:1,pa:280},
  "Chase McLaughlin":{fg:21,fg50:9,pat:46,fgMiss:4},
  "Cairo Santos":{fg:25,fg50:5,pat:42,fgMiss:6},
  // IDP stat lines (season projections). solo/ast tackles, idpSack, tfl, qbh, idpInt, pd, ff, fr, idpTD, saf
  "Fred Warner":{solo:108,ast:54,idpSack:3,tfl:11,qbh:7,idpInt:2,pd:8,ff:2,fr:1},
  "Roquan Smith":{solo:110,ast:58,idpSack:2,tfl:9,qbh:5,idpInt:1,pd:6,ff:1,fr:1},
  "Zaire Franklin":{solo:112,ast:60,idpSack:2,tfl:8,qbh:4,idpInt:1,pd:5,ff:2,fr:1},
  "Micah Parsons":{solo:54,ast:24,idpSack:13,tfl:18,qbh:30,idpInt:0,pd:3,ff:3,fr:1},
  "Bobby Wagner":{solo:104,ast:56,idpSack:3,tfl:9,qbh:5,idpInt:1,pd:5,ff:1,fr:1},
  "Foyesade Oluokun":{solo:106,ast:62,idpSack:1,tfl:6,qbh:3,idpInt:2,pd:6,ff:1,fr:1},
  "Nick Bolton":{solo:98,ast:52,idpSack:2,tfl:7,qbh:4,idpInt:1,pd:5,ff:1,fr:2},
  "Lavonte David":{solo:88,ast:48,idpSack:5,tfl:10,qbh:8,idpInt:1,pd:5,ff:2,fr:1},
  "Myles Garrett":{solo:42,ast:18,idpSack:15,tfl:19,qbh:34,idpInt:0,pd:4,ff:4,fr:1},
  "Trey Hendrickson":{solo:40,ast:16,idpSack:16,tfl:17,qbh:32,idpInt:0,pd:2,ff:2,fr:1},
  "Maxx Crosby":{solo:48,ast:22,idpSack:12,tfl:20,qbh:28,idpInt:0,pd:3,ff:3,fr:1},
  "Will Anderson Jr.":{solo:44,ast:20,idpSack:11,tfl:16,qbh:26,idpInt:0,pd:3,ff:2,fr:1},
  "Aidan Hutchinson":{solo:46,ast:20,idpSack:12,tfl:16,qbh:27,idpInt:0,pd:4,ff:2,fr:1},
  "Nik Bonitto":{solo:38,ast:16,idpSack:11,tfl:13,qbh:22,idpInt:0,pd:3,ff:3,fr:1},
  "T.J. Watt":{solo:44,ast:18,idpSack:12,tfl:17,qbh:29,idpInt:1,pd:6,ff:4,fr:1},
  "Danielle Hunter":{solo:40,ast:18,idpSack:12,tfl:15,qbh:25,idpInt:0,pd:2,ff:2,fr:1},
  "Kerby Joseph":{solo:70,ast:26,idpSack:0,tfl:3,qbh:1,idpInt:7,pd:16,ff:1,fr:1},
  "Antoine Winfield Jr.":{solo:84,ast:34,idpSack:4,tfl:7,qbh:5,idpInt:3,pd:10,ff:4,fr:2},
  "Budda Baker":{solo:96,ast:40,idpSack:2,tfl:5,qbh:3,idpInt:2,pd:8,ff:1,fr:1},
  "Brian Branch":{solo:90,ast:36,idpSack:1,tfl:4,qbh:2,idpInt:4,pd:13,ff:1,fr:1},
  "Derwin James":{solo:88,ast:38,idpSack:4,tfl:8,qbh:6,idpInt:2,pd:9,ff:2,fr:1},
  "Xavier McKinney":{solo:80,ast:32,idpSack:1,tfl:4,qbh:2,idpInt:5,pd:12,ff:1,fr:1},
  "Jessie Bates III":{solo:78,ast:34,idpSack:1,tfl:4,qbh:2,idpInt:4,pd:11,ff:2,fr:2},
  "Kyle Hamilton":{solo:76,ast:34,idpSack:3,tfl:6,qbh:5,idpInt:3,pd:11,ff:1,fr:1}
};

let META = {
  "Ja'Marr Chase":{floor:271,ceil:398,consensus:5.5},
  "Bijan Robinson":{floor:276,ceil:375,consensus:6.2},
  "Jahmyr Gibbs":{floor:271,ceil:377,consensus:11.5},
  "Justin Jefferson":{floor:259,ceil:379,consensus:1.5,inj:"minor"},
  "Saquon Barkley":{floor:258,ceil:359,consensus:3.9},
  "CeeDee Lamb":{floor:257,ceil:349,consensus:1.0},
  "Puka Nacua":{floor:253,ceil:367,consensus:5.4,inj:"minor"},
  "Amon-Ra St. Brown":{floor:251,ceil:352,consensus:1.0},
  "De'Von Achane":{floor:250,ceil:357,consensus:8.5},
  "Malik Nabers":{floor:224,ceil:366,consensus:2.5},
  "Nico Collins":{floor:240,ceil:330,consensus:13.8},
  "Ashton Jeanty":{floor:195,ceil:410,consensus:12.7,rookie:1},
  "Brian Thomas Jr.":{floor:219,ceil:350,consensus:24.7},
  "Christian McCaffrey":{floor:247,ceil:339,consensus:5.5,inj:"minor"},
  "Drake London":{floor:231,ceil:327,consensus:12.1},
  "A.J. Brown":{floor:226,ceil:325,consensus:20.4},
  "Josh Jacobs":{floor:224,ceil:322,consensus:16.7},
  "Brock Bowers":{floor:204,ceil:314,consensus:16.5},
  "Derrick Henry":{floor:236,ceil:305,consensus:13.4},
  "Trey McBride":{floor:199,ceil:287,consensus:21.4},
  "Ladd McConkey":{floor:212,ceil:305,consensus:18.5},
  "Jaxon Smith-Njigba":{floor:214,ceil:313,consensus:25.1},
  "Tee Higgins":{floor:208,ceil:298,consensus:26.0},
  "Kyren Williams":{floor:208,ceil:302,consensus:23.9},
  "Bucky Irving":{floor:199,ceil:321,consensus:26.5},
  "Chase Brown":{floor:207,ceil:296,consensus:30.4},
  "Garrett Wilson":{floor:212,ceil:290,consensus:25.7},
  "Marvin Harrison Jr.":{floor:211,ceil:295,consensus:37.9},
  "Davante Adams":{floor:203,ceil:266,consensus:43.2},
  "Terry McLaurin":{floor:211,ceil:274,consensus:28.0},
  "Mike Evans":{floor:212,ceil:268,consensus:37.7},
  "Omarion Hampton":{floor:161,ceil:339,consensus:52.3,rookie:1},
  "Breece Hall":{floor:204,ceil:281,consensus:41.3},
  "Kenneth Walker III":{floor:196,ceil:282,consensus:25.3,inj:"minor"},
  "DK Metcalf":{floor:196,ceil:265,consensus:29.1},
  "George Kittle":{floor:198,ceil:256,consensus:33.2,inj:"minor"},
  "Rashee Rice":{floor:203,ceil:283,consensus:24.0,inj:"major"},
  "Jonathan Taylor":{floor:201,ceil:280,consensus:44.0},
  "DeVonta Smith":{floor:193,ceil:264,consensus:41.2},
  "Xavier Worthy":{floor:180,ceil:283,consensus:47.4},
  "James Cook":{floor:192,ceil:278,consensus:31.3},
  "Josh Allen":{floor:366,ceil:450,consensus:31.7},
  "Alvin Kamara":{floor:196,ceil:260,consensus:39.7},
  "Jonathon Brooks":{floor:176,ceil:280,consensus:38.4,inj:"major"},
  "Lamar Jackson":{floor:341,ceil:467,consensus:52.3},
  "Tetairoa McMillan":{floor:149,ceil:306,consensus:65.6,rookie:1},
  "Jayden Daniels":{floor:337,ceil:440,consensus:35.8},
  "Travis Hunter":{floor:148,ceil:313,consensus:14.8,rookie:1},
  "Jameson Williams":{floor:181,ceil:256,consensus:43.5},
  "Jalen Hurts":{floor:333,ceil:434,consensus:51.2},
  "Calvin Ridley":{floor:185,ceil:239,consensus:43.0},
  "Zay Flowers":{floor:179,ceil:263,consensus:43.7},
  "Joe Burrow":{floor:328,ceil:429,consensus:48.8},
  "Sam LaPorta":{floor:168,ceil:247,consensus:57.1},
  "Tyreek Hill":{floor:188,ceil:246,consensus:54.6},
  "TreVeyon Henderson":{floor:147,ceil:299,consensus:67.7,rookie:1},
  "George Pickens":{floor:178,ceil:251,consensus:55.8},
  "Jaylen Waddle":{floor:173,ceil:242,consensus:73.9},
  "Courtland Sutton":{floor:186,ceil:246,consensus:64.6},
  "Quinshon Judkins":{floor:144,ceil:276,consensus:49.0,rookie:1},
  "Aaron Jones":{floor:179,ceil:235,consensus:61.3,inj:"minor"},
  "Chuba Hubbard":{floor:188,ceil:261,consensus:49.4},
  "David Montgomery":{floor:164,ceil:241,consensus:53.5},
  "Patrick Mahomes":{floor:319,ceil:407,consensus:54.6},
  "Chris Olave":{floor:166,ceil:239,consensus:65.7,inj:"minor"},
  "Baker Mayfield":{floor:312,ceil:393,consensus:67.8},
  "DJ Moore":{floor:171,ceil:234,consensus:56.4},
  "Jerry Jeudy":{floor:169,ceil:240,consensus:51.8},
  "Jordan Love":{floor:292,ceil:395,consensus:50.0},
  "Jordan Addison":{floor:160,ceil:225,consensus:51.9},
  "Rome Odunze":{floor:160,ceil:235,consensus:71.9},
  "Bo Nix":{floor:302,ceil:395,consensus:58.0},
  "Khalil Shakir":{floor:158,ceil:223,consensus:50.4},
  "Caleb Williams":{floor:286,ceil:380,consensus:79.7},
  "Jakobi Meyers":{floor:168,ceil:228,consensus:73.2},
  "T.J. Hockenson":{floor:158,ceil:216,consensus:85.7},
  "Travis Etienne":{floor:145,ceil:212,consensus:56.9},
  "Mark Andrews":{floor:155,ceil:209,consensus:74.3},
  "David Njoku":{floor:156,ceil:212,consensus:80.1},
  "Tony Pollard":{floor:169,ceil:232,consensus:79.8},
  "Isiah Pacheco":{floor:158,ceil:231,consensus:73.0},
  "Brock Purdy":{floor:286,ceil:381,consensus:65.2},
  "Kaleb Johnson":{floor:129,ceil:273,consensus:99.7,rookie:1},
  "Justin Herbert":{floor:294,ceil:382,consensus:70.3},
  "RJ Harvey":{floor:154,ceil:275,consensus:67.4,rookie:1},
  "Zach Charbonnet":{floor:153,ceil:216,consensus:72.6},
  "Jaylen Warren":{floor:162,ceil:218,consensus:66.1},
  "Tucker Kraft":{floor:147,ceil:213,consensus:82.0},
  "Tyler Warren":{floor:125,ceil:226,consensus:90.0,rookie:1},
  "Colston Loveland":{floor:112,ceil:226,consensus:74.6,rookie:1},
  "C.J. Stroud":{floor:278,ceil:373,consensus:97.0},
  "Dak Prescott":{floor:285,ceil:371,consensus:108.7,inj:"minor"},
  "Kyler Murray":{floor:270,ceil:378,consensus:90.3},
  "Drake Maye":{floor:277,ceil:387,consensus:109.0},
  "Jordan Mason":{floor:151,ceil:209,consensus:91.5},
  "Jared Goff":{floor:287,ceil:354,consensus:77.6},
  "Tyjae Spears":{floor:137,ceil:197,consensus:83.9},
  "J.J. McCarthy":{floor:246,ceil:383,consensus:103.2},
  "Trey Benson":{floor:140,ceil:200,consensus:93.9},
  "Cam Skattebo":{floor:121,ceil:222,consensus:92.4,rookie:1},
  "Trevor Lawrence":{floor:283,ceil:346,consensus:114.2},
  "Jaydon Blue":{floor:106,ceil:223,consensus:120.1,rookie:1},
  "Stefon Diggs":{floor:165,ceil:223,consensus:110.8,inj:"minor"},
  "Daniel Jones":{floor:258,ceil:361,consensus:86.0},
  "Keon Coleman":{floor:144,ceil:221,consensus:82.5},
  "Jayden Reed":{floor:154,ceil:214,consensus:104.6,inj:"minor"},
  "Rashod Bateman":{floor:143,ceil:197,consensus:88.1},
  "Sam Darnold":{floor:254,ceil:357,consensus:117.0},
  "Deebo Samuel":{floor:147,ceil:201,consensus:84.6},
  "Jauan Jennings":{floor:145,ceil:199,consensus:110.2},
  "Matthew Golden":{floor:117,ceil:242,consensus:120.6,rookie:1},
  "Dallas Goedert":{floor:146,ceil:187,consensus:91.5},
  "Geno Smith":{floor:263,ceil:332,consensus:105.7},
  "Michael Pittman Jr.":{floor:144,ceil:196,consensus:81.8},
  "Cooper Kupp":{floor:156,ceil:204,consensus:98.0,inj:"minor"},
  "Tank Bigsby":{floor:149,ceil:205,consensus:111.5},
  "Cole Kmet":{floor:140,ceil:191,consensus:80.6},
  "Jeremiah Smith":{floor:123,ceil:256,consensus:92.1,rookie:1},
  "Michael Penix Jr.":{floor:255,ceil:332,consensus:117.0,inj:"minor"},
  "Adam Thielen":{floor:152,ceil:195,consensus:105.6},
  "Tyler Allgeier":{floor:134,ceil:211,consensus:104.3},
  "Chig Okonkwo":{floor:132,ceil:192,consensus:97.8},
  "Jeremiyah Love":{floor:124,ceil:262,consensus:110.1,rookie:1},
  "Joshua Palmer":{floor:137,ceil:212,consensus:104.1},
  "Justice Hill":{floor:143,ceil:194,consensus:122.8},
  "Tua Tagovailoa":{floor:235,ceil:348,consensus:105.9},
  "Makai Lemon":{floor:117,ceil:242,consensus:98.3,rookie:1},
  "Jaleel McLaughlin":{floor:139,ceil:193,consensus:118.2},
  "DeMario Douglas":{floor:151,ceil:196,consensus:109.8},
  "Will Dissly":{floor:140,ceil:179,consensus:124.4},
  "Nicholas Singleton":{floor:119,ceil:250,consensus:114.6,rookie:1},
  "Anthony Richardson":{floor:240,ceil:328,consensus:102.9},
  "Dyami Brown":{floor:141,ceil:202,consensus:106.0},
  "Carnell Tate":{floor:115,ceil:234,consensus:131.2,rookie:1},
  "Kareem Hunt":{floor:134,ceil:190,consensus:136.4},
  "Mike Gesicki":{floor:132,ceil:181,consensus:109.2,inj:"minor"},
  "Calvin Austin III":{floor:139,ceil:195,consensus:101.9},
  "Elijah Mitchell":{floor:134,ceil:184,consensus:113.1},
  "Aaron Rodgers":{floor:241,ceil:315,consensus:104.4},
  "Wan'Dale Robinson":{floor:140,ceil:189,consensus:118.5},
  "Kendre Miller":{floor:122,ceil:196,consensus:105.8},
  "Cade Otton":{floor:124,ceil:182,consensus:86.6},
  "Jordyn Tyson":{floor:111,ceil:234,consensus:123.7,rookie:1},
  "Adonai Mitchell":{floor:135,ceil:193,consensus:134.6},
  "Russell Wilson":{floor:237,ceil:311,consensus:128.8},
  "Roschon Johnson":{floor:129,ceil:176,consensus:116.8},
  "Fernando Mendoza":{floor:210,ceil:404,consensus:121.4,rookie:1},
  "Noah Fant":{floor:124,ceil:169,consensus:119.7},
  "Ja'Lynn Polk":{floor:134,ceil:182,consensus:139.7},
  "Ray Davis":{floor:128,ceil:175,consensus:130.7},
  "Quinten Joyner":{floor:107,ceil:225,consensus:136.3,rookie:1},
  "Troy Franklin":{floor:131,ceil:179,consensus:96.7},
  "Matthew Stafford":{floor:238,ceil:298,consensus:129.8},
  "Dawson Knox":{floor:118,ceil:161,consensus:124.3},
  "Braelon Allen":{floor:127,ceil:168,consensus:134.2},
  "Xavier Legette":{floor:126,ceil:180,consensus:115.9},
  "Joe Flacco":{floor:223,ceil:305,consensus:122.0},
  "Isaac Guerendo":{floor:121,ceil:166,consensus:128.5},
  "Theo Johnson":{floor:107,ceil:167,consensus:104.7},
  "Jalen McMillan":{floor:123,ceil:176,consensus:123.7},
  "Jaylen Wright":{floor:109,ceil:176,consensus:161.7},
  "Will Levis":{floor:230,ceil:289,consensus:146.5},
  "Andrei Iosivas":{floor:113,ceil:177,consensus:153.7},
  "Ja'Tavion Sanders":{floor:119,ceil:152,consensus:131.5},
  "Antonio Williams":{floor:104,ceil:220,consensus:132.3,rookie:1},
  "MarShawn Lloyd":{floor:115,ceil:162,consensus:137.9},
  "Jalen Coker":{floor:119,ceil:162,consensus:155.4},
  "Mac Jones":{floor:224,ceil:291,consensus:112.6},
  "Blake Corum":{floor:118,ceil:152,consensus:144.2},
  "Quentin Johnston":{floor:116,ceil:153,consensus:107.0},
  "Isaiah Likely":{floor:106,ceil:151,consensus:110.6},
  "Eric Singleton Jr.":{floor:102,ceil:216,consensus:144.1,rookie:1},
  "Cedric Tillman":{floor:107,ceil:154,consensus:151.9},
  "Bhayshul Tuten":{floor:112,ceil:153,consensus:129.1},
  "Spencer Rattler":{floor:214,ceil:296,consensus:152.9},
  "Romeo Doubs":{floor:104,ceil:152,consensus:130.8},
  "Kyle Pitts":{floor:100,ceil:143,consensus:134.2},
  "Kenyon Sadiq":{floor:99,ceil:209,consensus:91.1,rookie:1},
  "Rico Dowdle":{floor:116,ceil:148,consensus:157.1},
  "Jameis Winston":{floor:209,ceil:286,consensus:161.2},
  "Christian Kirk":{floor:104,ceil:143,consensus:139.5},
  "Dalton Kincaid":{floor:103,ceil:131,consensus:170.9},
  "Najee Harris":{floor:113,ceil:150,consensus:138.5},
  "Denzel Boston":{floor:102,ceil:205,consensus:117.1,rookie:1},
  "Josh Downs":{floor:98,ceil:137,consensus:121.8},
  "Jarrett Stidham":{floor:205,ceil:280,consensus:108.6},
  "Marvin Mims":{floor:91,ceil:141,consensus:149.6},
  "Joe Mixon":{floor:108,ceil:149,consensus:159.1},
  "Drew Allar":{floor:198,ceil:385,consensus:165.1,rookie:1},
  "Jonnu Smith":{floor:93,ceil:129,consensus:165.0},
  "Darnell Mooney":{floor:89,ceil:130,consensus:157.4},
  "Kirk Cousins":{floor:198,ceil:271,consensus:138.0},
  "Nick Chubb":{floor:100,ceil:156,consensus:139.1},
  "Hunter Henry":{floor:89,ceil:126,consensus:155.6},
  "Hollywood Brown":{floor:92,ceil:125,consensus:153.1},
  "Austin Ekeler":{floor:108,ceil:138,consensus:119.1},
  "LaNorris Sellers":{floor:193,ceil:380,consensus:142.2,rookie:1},
  "Antonio Gibson":{floor:101,ceil:138,consensus:188.5},
  "Pat Freiermuth":{floor:79,ceil:124,consensus:115.2},
  "Demario Douglas":{floor:85,ceil:120,consensus:127.2},
  "Zamir White":{floor:96,ceil:133,consensus:150.3,inj:"minor"},
  "Jake Ferguson":{floor:80,ceil:117,consensus:147.2},
  "Tyler Lockett":{floor:80,ceil:115,consensus:139.7},
  "Devin Singletary":{floor:93,ceil:127,consensus:140.8},
  "Keenan Allen":{floor:79,ceil:110,consensus:128.1},
  "Evan Engram":{floor:85,ceil:109,consensus:150.4},
  "Samaje Perine":{floor:91,ceil:127,consensus:155.1},
  "Amari Cooper":{floor:74,ceil:104,consensus:157.5},
  "Jerome Ford":{floor:93,ceil:123,consensus:139.1},
  "Brenton Strange":{floor:79,ceil:106,consensus:142.8},
  "Diontae Johnson":{floor:68,ceil:113,consensus:126.6},
  "Ty Chandler":{floor:86,ceil:122,consensus:171.7,inj:"minor"},
  "Zach Ertz":{floor:75,ceil:99,consensus:166.0},
  "Allen Lazard":{floor:70,ceil:100,consensus:158.3},
  "Will Shipley":{floor:86,ceil:122,consensus:146.9},
  "Julian Sayin":{floor:188,ceil:364,consensus:179.2,rookie:1},
  "Brandin Cooks":{floor:70,ceil:100,consensus:154.0},
  "Audric Estime":{floor:91,ceil:117,consensus:153.6},
  "DeAndre Hopkins":{floor:74,ceil:96,consensus:156.9},
  "Sean Tucker":{floor:83,ceil:120,consensus:187.8},
  "Emanuel Wilson":{floor:80,ceil:114,consensus:169.7},
  "Brandon Aubrey":{floor:127,ceil:177,consensus:160.5},
  "Harrison Butker":{floor:128,ceil:171,consensus:204.9},
  "Broncos D/ST":{floor:108,ceil:177,consensus:121.3},
  "Jake Bates":{floor:129,ceil:166,consensus:175.4},
  "Eagles D/ST":{floor:109,ceil:171,consensus:176.0},
  "Cameron Dicker":{floor:126,ceil:165,consensus:175.0},
  "Texans D/ST":{floor:106,ceil:170,consensus:170.4},
  "Ravens D/ST":{floor:106,ceil:167,consensus:242.4},
  "Chris Boswell":{floor:122,ceil:165,consensus:217.1},
  "Ka'imi Fairbairn":{floor:116,ceil:168,consensus:216.8},
  "Steelers D/ST":{floor:101,ceil:168,consensus:240.5},
  "Bills D/ST":{floor:104,ceil:160,consensus:194.3},
  "Jason Sanders":{floor:122,ceil:157,consensus:212.8},
  "Vikings D/ST":{floor:100,ceil:161,consensus:190.4},
  "Tyler Bass":{floor:116,ceil:159,consensus:167.5},
  "Packers D/ST":{floor:98,ceil:158,consensus:193.6},
  "Chargers D/ST":{floor:96,ceil:157,consensus:162.3},
  "Younghoe Koo":{floor:119,ceil:152,consensus:183.8},
  "Lions D/ST":{floor:96,ceil:152,consensus:208.6},
  "Wil Lutz":{floor:115,ceil:151,consensus:229.3},
  "Seahawks D/ST":{floor:95,ceil:149,consensus:224.2},
  "Jake Elliott":{floor:109,ceil:154,consensus:181.5},
  "Chiefs D/ST":{floor:90,ceil:150,consensus:198.5},
  "49ers D/ST":{floor:90,ceil:146,consensus:170.4},
  "Evan McPherson":{floor:108,ceil:151,consensus:159.5},
  "Saints D/ST":{floor:87,ceil:145,consensus:205.3},
  "Joshua Karty":{floor:111,ceil:143,consensus:215.3},
  "Cowboys D/ST":{floor:88,ceil:139,consensus:200.0},
  "Matt Gay":{floor:103,ceil:148,consensus:203.0},
  "Jets D/ST":{floor:87,ceil:137,consensus:168.9},
  "Chase McLaughlin":{floor:102,ceil:145,consensus:174.2},
  "Cairo Santos":{floor:103,ceil:139,consensus:192.0},
  "Fred Warner":{floor:178,ceil:232,consensus:150.0},
  "Roquan Smith":{floor:176,ceil:228,consensus:152.0},
  "Zaire Franklin":{floor:174,ceil:226,consensus:154.0},
  "Micah Parsons":{floor:166,ceil:228,consensus:156.0},
  "Bobby Wagner":{floor:168,ceil:216,consensus:160.0},
  "Foyesade Oluokun":{floor:166,ceil:214,consensus:162.0},
  "Nick Bolton":{floor:160,ceil:208,consensus:168.0},
  "Lavonte David":{floor:156,ceil:204,consensus:172.0},
  "Myles Garrett":{floor:160,ceil:220,consensus:158.0},
  "Trey Hendrickson":{floor:154,ceil:212,consensus:164.0},
  "Maxx Crosby":{floor:153,ceil:210,consensus:166.0},
  "Will Anderson Jr.":{floor:150,ceil:206,consensus:170.0},
  "Aidan Hutchinson":{floor:149,ceil:205,consensus:171.0},
  "Nik Bonitto":{floor:142,ceil:198,consensus:176.0},
  "T.J. Watt":{floor:145,ceil:202,consensus:178.0},
  "Danielle Hunter":{floor:140,ceil:194,consensus:182.0},
  "Kerby Joseph":{floor:148,ceil:204,consensus:174.0},
  "Antoine Winfield Jr.":{floor:142,ceil:196,consensus:180.0},
  "Budda Baker":{floor:138,ceil:190,consensus:184.0},
  "Brian Branch":{floor:136,ceil:188,consensus:186.0},
  "Derwin James":{floor:134,ceil:188,consensus:188.0},
  "Xavier McKinney":{floor:131,ceil:182,consensus:192.0},
  "Jessie Bates III":{floor:128,ceil:178,consensus:196.0},
  "Kyle Hamilton":{floor:126,ceil:176,consensus:198.0}
};

// ---- LIVE DATA ----------------------------------------------------------------------------
// The built-in RAW/STATS/META above are a fallback. When the backend is connected, we replace
// them with live Sleeper data (real teams, projections, injuries, rookie status, and ADP) so the
// board reflects reality. The engine logic is unchanged — it just reads fresher RAW/STATS/META.
let LIVE_LOADED = false;
let LIVE_ADP_SPARSE = false; // true when live ADP is too thin to trust → engine ranks by VBD value
export function isLivePackLoaded() { return LIVE_LOADED; }

// Build engine structures from the backend player-pack response. Keyed by player name (the engine's
// key). We keep only players with a usable position and (ADP or projection), already filtered server-side.
export function applyLivePack(pack) {
  if (!pack || !Array.isArray(pack.players) || pack.players.length === 0) return false;
  const raw = [], stats = {}, meta = {};
  const seen = new Set();
  // Map Sleeper's granular positions into the engine's known buckets. Anything we can't place
  // (offensive linemen, long snappers, etc.) is dropped — the engine only drafts fantasy positions.
  const POS_MAP = {
    QB: "QB", RB: "RB", FB: "RB", WR: "WR", TE: "TE", K: "K", DEF: "DST", DST: "DST",
    DL: "DL", DE: "DL", DT: "DL", NT: "DL",
    LB: "LB", ILB: "LB", OLB: "LB", MLB: "LB",
    DB: "DB", CB: "DB", S: "DB", FS: "DB", SS: "DB",
  };
  const normPos = (pos) => POS_MAP[pos] || null;
  // Provisional ranking uses the ENGINE's real scoring (scoreFromStats with default PPR), per
  // position, so the order matches how the engine values players — not a crude guess. This keeps
  // the displayed board and the draft AI consistent.
  const projValue = (st, pos) => {
    if (!st) return 0;
    try { return scoreFromStats(pos, st, DEFAULT_SCORING); } catch { return 0; }
  };
  // Decide the ranking strategy. Real ADP is only trustworthy when we have a healthy amount of it for
  // *draftable* players AND it isn't dominated by rookie/dynasty drafts. Early in the year the only
  // drafts harvested on Sleeper are rookie/dynasty drafts, so "real ADP" covers mostly rookies — using
  // it would bury veterans (Allen, Tua) and float no-name rookies to the top. Until real REDRAFT ADP
  // accumulates broadly, we rank the board by projections/VBD, which is a far more sensible default.
  const draftable = pack.players.filter((p) => normPos(p.pos));
  const withRealAdp = draftable.filter((p) => p.adp != null);
  const adpCount = withRealAdp.length;
  // Guard against rookie-contaminated samples: only trust ADP when coverage is BROAD (lots of players,
  // i.e. real redraft drafts are happening) — not just a handful of early rookie picks. A high count is
  // the signal that the market has matured past rookie-only drafts.
  const rookieShareOfAdp = adpCount > 0 ? withRealAdp.filter((p) => p.rookie).length / adpCount : 0;
  const ADP_HEALTHY = adpCount >= 120 && rookieShareOfAdp < 0.5; // broad coverage, not rookie-dominated

  const projValueAll = (p) => projValue(p.stats, normPos(p.pos));
  // Provisional ADP for players lacking real ADP: rank by projection, placed after real-ADP players.
  const withAdp = ADP_HEALTHY ? withRealAdp.length : 0;
  const noAdpSorted = (ADP_HEALTHY ? draftable.filter((p) => p.adp == null) : draftable.slice())
    .map((p) => ({ p, v: projValueAll(p) }))
    .sort((a, b) => b.v - a.v);
  const provisionalAdp = new Map();
  noAdpSorted.forEach((x, i) => provisionalAdp.set(x.p.id, withAdp + i + 1));

  for (const p of pack.players) {
    if (!p.name || !p.pos) continue;
    const pos = normPos(p.pos);
    if (!pos) continue; // skip positions the engine doesn't draft (OL, LS, etc.)
    let name = p.name;
    if (seen.has(name)) { name = `${p.name} (${p.team || pos})`; if (seen.has(name)) continue; }
    seen.add(name);
    // Use real ADP only when coverage is healthy AND not rookie-dominated; else rank by projection.
    const useRealAdp = ADP_HEALTHY && p.adp != null;
    const adp = useRealAdp ? p.adp : (provisionalAdp.get(p.id) || 999);
    raw.push([name, pos, p.team || "FA", p.age || 0, p.bye || 0, adp, p.adpHi || adp]);
    if (p.stats && Object.keys(p.stats).length) stats[name] = p.stats;
    meta[name] = {
      consensus: useRealAdp ? p.adp : null,   // only show a "consensus" number when it's real, trusted ADP
      rookie: !!p.rookie,
      inj: p.inj || null,
      floor: p.floor != null ? p.floor : null,
      ceil: p.ceil != null ? p.ceil : null,
    };
  }
  if (raw.length < 50) return false; // sanity: don't swap in a too-small pool
  RAW = raw; STATS = stats; META = meta;
  LIVE_LOADED = true;
  LIVE_ADP_SPARSE = !ADP_HEALTHY; // when sparse/rookie-contaminated, rank by VBD value instead
  return true;
}

const TEAM_NAMES_POOL = ["Gridiron Gurus","Waiver Wolves","Bye Week Blues","The Audibles","Mahomes Alone","Run CMC","Fourth & Long","Hail Marys","The Handcuffs","Mock Draft Szn","Chasing Chase","Bench Mob","Pylon Pushers","Zero RB Zealots","Gravy Train","Red Zone Rebels","Pocket Presence","Flea Flickers","Snap Counters","Garbage Time"];
// Active team names for the current league (may be overridden by manual/Sleeper entry).
let TEAM_NAMES = TEAM_NAMES_POOL.slice(0, 12);
const setTeamNames = (names) => { TEAM_NAMES = names; };
const POS_COLOR = { QB:"#EF6A6A", RB:"#4FD1A1", WR:"#5BA8F5", TE:"#F2A35C", DL:"#b07cc6", LB:"#7e9b59", DB:"#5fb0b0", K:"#9aa7b3", DST:"#9aa7b3" };
// ---- Recent trends feed --------------------------------------------------------------
// PLUGGABLE DATA LAYER. In production, getTrendsFeed() reads a nightly-synced blend of
// public sources — ADP movement (Sleeper/FantasyPros/ESPN), transactions & signings,
// depth-chart changes ("new weapon"), and injury wires — keyed by date. In this prototype
// it returns a representative sample, clearly labeled, so the page and its filters are real
// and the live feed is a one-function swap. Nothing here is manually maintained by the user.
function getTrendsFeed() {
  return {
    asOf: "sample data",
    climbers: [
      { name: "Brian Thomas Jr.", pos: "WR", team: "JAX", move: +14, note: "Target share trending up in camp reports." },
      { name: "Bo Nix", pos: "QB", team: "DEN", move: +11, note: "Rushing usage lifting his floor in drafts." },
      { name: "Jeremiyah Love", pos: "RB", team: "NO", move: +9, note: "Rookie buzz; path to early-down work." },
      { name: "Rome Odunze", pos: "WR", team: "CHI", move: +8, note: "Year-two leap chatter, revamped offense." },
      { name: "Tucker Kraft", pos: "TE", team: "GB", move: +7, note: "Quietly climbing as a TE value." },
      { name: "Jordan Addison", pos: "WR", team: "MIN", move: +6, note: "Camp reports point to a bigger route share." },
      { name: "Trey Benson", pos: "RB", team: "ARI", move: +6, note: "Handcuff value rising on workload questions ahead." },
      { name: "Jayden Reed", pos: "WR", team: "GB", move: +5, note: "Steady riser as the slot role solidifies." },
    ],
    fallers: [
      { name: "Cooper Kupp", pos: "WR", team: "SEA", move: -10, note: "New team, age, and target competition." },
      { name: "Stefon Diggs", pos: "WR", team: "NE", move: -7, note: "Coming off injury; murkier role." },
      { name: "Derrick Henry", pos: "RB", team: "BAL", move: -6, note: "Age cliff being priced in." },
      { name: "Zay Flowers", pos: "WR", team: "BAL", move: -5, note: "Crowded target tree tempering expectations." },
      { name: "Najee Harris", pos: "RB", team: "LAC", move: -5, note: "Committee concerns after backfield additions." },
      { name: "Dallas Goedert", pos: "TE", team: "NO", move: -4, note: "New scheme clouds the target outlook." },
    ],
    signings: [
      { name: "Tyreek Hill", team: "NYJ", note: "Lands in a new offense — fresh QB and target competition reshapes his outlook." },
      { name: "Aaron Jones", team: "MIN", note: "Re-signed; backfield workload clarified." },
      { name: "Mike Williams", team: "PIT", note: "Adds a downfield element; mid-round dart throw." },
      { name: "Gus Edwards", team: "free agent", note: "Still unsigned — landing spot will set his value." },
    ],
    weapons: [
      { name: "De'Von Achane", team: "MIA", note: "New QB + high draft capital on the OL; now the featured back." },
      { name: "Caleb Williams", team: "CHI", note: "Revamped receiver room and staff around him." },
      { name: "Drake Maye", team: "NE", note: "Added pass-catching help; rushing usage rising." },
      { name: "Jayden Daniels", team: "WAS", note: "New weapons and a year of rapport lifting the ceiling." },
      { name: "Michael Penix Jr.", team: "ATL", note: "Full season as starter with a loaded skill group." },
    ],
    injuries: [
      { name: "Rashee Rice", pos: "WR", team: "KC", sev: "major", note: "Availability cloud — recovery and suspension risk." },
      { name: "Jonathon Brooks", pos: "RB", team: "CAR", sev: "major", note: "Recovery timeline a real draft-day risk." },
      { name: "Justin Jefferson", pos: "WR", team: "MIN", sev: "minor", note: "Minor camp tweak — monitor, not alarming." },
      { name: "Christian McCaffrey", pos: "RB", team: "SF", sev: "minor", note: "Managing a nagging issue; volume risk." },
      { name: "Tank Dell", pos: "WR", team: "HOU", sev: "major", note: "Working back from injury; timeline unclear." },
      { name: "J.K. Dobbins", pos: "RB", team: "DEN", sev: "minor", note: "Injury history keeps the floor uncertain." },
    ],
  };
}
// Injury display: dark red for concerning, lighter red for minor.
// Severity tiers — the projected game-availability status, most to least severe.
const INJURY_STATUS = {
  suspended: { color: "#6a1b9a", label: "Suspended", abbr: "SUSP" },
  out:       { color: "#b71c1c", label: "Out", abbr: "OUT" },
  pup:       { color: "#b71c1c", label: "PUP / NFI", abbr: "PUP" },
  ir:        { color: "#b71c1c", label: "Injured reserve", abbr: "IR" },
  doubtful:  { color: "#e64a19", label: "Doubtful", abbr: "D" },
  questionable: { color: "#f9a825", label: "Questionable", abbr: "Q" },
  dtd:       { color: "#e57373", label: "Day-to-day", abbr: "DTD" },
};
// Per-player injury detail. status -> tier above; note -> 1-3 sentence description; back -> optional return-by string.
// In production these stream from the injury wire (status, designation, est. return) and refresh daily.
const INJURY_DETAIL = {
  "Justin Jefferson": { status: "questionable", note: "Tweaked a hamstring in camp and was limited late in the preseason. Expected to play Week 1 but worth monitoring the practice reports.", back: "Week 1" },
  "Puka Nacua": { status: "dtd", note: "Minor knee soreness managed through camp. No structural concern — treated as routine maintenance.", back: "Week 1" },
  "Christian McCaffrey": { status: "questionable", note: "Coming off the Achilles/calf issues that wrecked last season. Looks healthy now, but the workload and age make it a lingering risk.", back: "Week 1" },
  "Kenneth Walker III": { status: "dtd", note: "Recurring ankle that flares up; played through it before. Hasn't missed significant time but limits some practices.", back: "Week 1" },
  "George Kittle": { status: "questionable", note: "Chronic hamstring/core maintenance — the kind that costs a game or two most seasons. Elite when on the field.", back: "Week 1" },
  "Rashee Rice": { status: "suspended", note: "Facing a multi-game suspension tied to an offseason legal matter, on top of returning from a knee injury. Treat early-season availability as a real question.", back: "Suspended — est. Week 7" },
  "Jonathon Brooks": { status: "pup", note: "Recovering from a torn ACL; opened camp on the PUP list. A redshirt-style timeline is realistic before he's a usable contributor.", back: "PUP — est. Week 5" },
  "Aaron Jones": { status: "dtd", note: "Hamstring and quad issues that pop up periodically. Effective when healthy, but the injury history is extensive for his age.", back: "Week 1" },
  "Chris Olave": { status: "questionable", note: "Multiple concussions over the past two seasons. No current absence, but the history adds risk to the projection.", back: "Week 1" },
  "Dak Prescott": { status: "dtd", note: "Returning from a season-ending hamstring avulsion. Reportedly full-go, but it's a notable soft-tissue injury to track early.", back: "Week 1" },
  "Stefon Diggs": { status: "doubtful", note: "Working back from a torn ACL suffered midseason. Likely eased in slowly; early-season role and explosiveness are uncertain.", back: "est. Week 3" },
  "Jayden Reed": { status: "questionable", note: "Foot/ankle soreness limited him late in camp. Trending toward playing but not a lock for a full snap share Week 1.", back: "Week 1" },
  "Cooper Kupp": { status: "questionable", note: "Perennial soft-tissue risk (ankle, hamstring) that has cost games each of the last few seasons. Productive when available.", back: "Week 1" },
  "Michael Penix Jr.": { status: "dtd", note: "Minor shoulder/throwing-arm maintenance from camp. No expected missed time.", back: "Week 1" },
  "Mike Gesicki": { status: "dtd", note: "Minor knee tendinitis being managed. Not expected to affect availability.", back: "Week 1" },
  "Zamir White": { status: "questionable", note: "Quad/groin issues that lingered through camp and into the opener window. Backfield role is contingent on health.", back: "Week 1" },
  "Ty Chandler": { status: "dtd", note: "Minor ankle tweak. Depth back whose value hinges on others' health more than his own.", back: "Week 1" },
};
// Generic fallback when a flagged player has no specific detail.
const INJURY_INFO = {
  major: { color: "#b71c1c", label: "Concerning", text: "A serious or lingering injury that could cost significant time or limit the role — discount the projection and treat availability as a real risk." },
  minor: { color: "#e57373", label: "Minor", text: "A minor or short-term issue (tweak, maintenance, or coming off a small injury). Worth noting but unlikely to derail the season." },
};
// Resolve the full badge view for a player: prefers specific detail, falls back to the generic tier.
function injuryView(p) {
  if (!p || !p.inj) return null;
  const d = INJURY_DETAIL[p.name];
  if (d && INJURY_STATUS[d.status]) { const st = INJURY_STATUS[d.status]; return { color: st.color, abbr: st.abbr, label: st.label, note: d.note, back: d.back }; }
  // Map live Sleeper injury statuses (e.g. "Questionable","Doubtful","Out","IR","PUP","Sus") to our tiers.
  const sleeperToTier = {
    questionable: "minor", probable: "minor", doubtful: "major", out: "major",
    ir: "major", pup: "major", sus: "major", suspended: "major", cov: "minor", dnr: "major", na: "major",
  };
  let key = p.inj;
  if (!INJURY_INFO[key]) key = sleeperToTier[String(p.inj).toLowerCase()] || "minor";
  const g = INJURY_INFO[key] || INJURY_INFO.minor;
  if (!g) return null; // ultimate safety: no badge rather than a crash
  const major = key === "major";
  const abbr = major ? "INJ" : (String(p.inj).slice(0, 1).toUpperCase() || "Q");
  return { color: g.color, abbr, label: g.label, note: g.text, back: null };
}

/* ---------------- engine (cfg-threaded) ---------------- */
let ORDER = "snake";
const setOrder = (o) => { ORDER = o || "snake"; };
// Pick-trade overrides: overall-pick-index -> team index that now owns it.
let PICK_OWNER = {};
const setPickTrades = (trades) => {
  PICK_OWNER = {};
  (trades || []).forEach((t) => { if (t && t.o != null && t.to != null) PICK_OWNER[t.o] = t.to; });
};
// Convert platform traded picks [{round, fromSlot, toSlot}] into owner overrides [{o, to, round}],
// computing the actual overall pick index for each (round, original-slot) under the given order.
function tradesToOwnerOverrides(tradedPicks, N, order) {
  const naturalTeamAt = (o) => {
    const r = Math.floor(o / N), i = o % N;
    if (order === "linear") return i;
    if (order === "3rr") { if (r === 0) return i; if (r === 1) return N - 1 - i; return (r % 2 === 1) ? i : N - 1 - i; }
    return r % 2 === 0 ? i : N - 1 - i; // snake
  };
  const out = [];
  (tradedPicks || []).forEach((t) => {
    const fromTeam = (t.fromSlot || 0) - 1, toTeam = (t.toSlot || 0) - 1, r = (t.round || 1) - 1;
    if (fromTeam < 0 || toTeam < 0) return;
    for (let i = 0; i < N; i++) { const o = r * N + i; if (naturalTeamAt(o) === fromTeam) { out.push({ o, to: toTeam, round: t.round }); break; } }
  });
  return out;
}
// Live ownership from a connected platform: overall-pick-index -> team index (slot-1), taken from
// the real draft_slot of each pick. This is the SOURCE OF TRUTH for who made each pick when synced,
// overriding any snake recompute so rosters and team assignment match the real draft exactly.
let LIVE_PICK_TEAM = null; // null when not connected; array/object otherwise
const setLivePickTeams = (map) => { LIVE_PICK_TEAM = map && Object.keys(map).length ? map : null; };
const baseTeamAt = (o) => {
  const r = Math.floor(o / TEAMS), i = o % TEAMS;
  if (ORDER === "linear") return i;
  if (ORDER === "3rr") {
    if (r === 0) return i;
    if (r === 1) return TEAMS - 1 - i;
    return (r % 2 === 1) ? i : TEAMS - 1 - i;
  }
  return r % 2 === 0 ? i : TEAMS - 1 - i; // snake
};
// Order of precedence: explicit pick trade > live real ownership > computed draft order.
const teamAt = (o) => (PICK_OWNER[o] != null ? PICK_OWNER[o] : (LIVE_PICK_TEAM && LIVE_PICK_TEAM[o] != null ? LIVE_PICK_TEAM[o] : baseTeamAt(o)));
// The natural (pre-trade) owner of an overall pick — used to list a team's tradeable picks.
const naturalOwner = (o) => (LIVE_PICK_TEAM && LIVE_PICK_TEAM[o] != null ? LIVE_PICK_TEAM[o] : baseTeamAt(o));

// No-cost keepers: players defaulted onto a roster WITHOUT consuming a pick. Stored as
// team-index -> [playerId]. They seed the projection demographics and value/summary so a
// team that keeps, say, a stud RB for free is correctly treated as already strong at RB.
let KEEPER_ADDS = {}; // { teamIdx: [playerId, ...] }
const setKeeperAdds = (map) => { KEEPER_ADDS = map || {}; };
const keeperAddIds = (teamIdx) => KEEPER_ADDS[teamIdx] || [];
// add no-cost keeper positions into a per-team counts object (the {QB,RB,WR,TE} shape)
const seedKeeperCounts = (players, teamIdx, counts) => { keeperAddIds(teamIdx).forEach((id) => { const p = players[id]; if (p && counts[p.pos] != null) counts[p.pos]++; }); };
// add no-cost keeper players into a per-team roster array
const seedKeeperRoster = (players, teamIdx, arr) => { keeperAddIds(teamIdx).forEach((id) => { if (players[id]) arr.push(players[id]); }); };
// every no-cost keeper id (all teams) — these are unavailable to draft
const allKeeperAddIds = () => Object.values(KEEPER_ADDS).flat();
const pickLabel = (o) => `${Math.floor(o / TEAMS) + 1}.${String((o % TEAMS) + 1).padStart(2, "0")}`;
const ordinal = (n) => { const s = ["th","st","nd","rd"], v = n % 100; return n + (s[(v-20)%10] || s[v] || s[0]); };
const totalOf = (cfg) => TEAMS * cfg.rounds;
// Clipboard with a textarea fallback (the artifact iframe often blocks the async API).
function copyText(text) {
  try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).catch(() => fallbackCopy(text)); return true; } } catch (e) {}
  return fallbackCopy(text);
}
function fallbackCopy(text) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0"; ta.style.top = "0";
    document.body.appendChild(ta); ta.focus(); ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch (e) { return false; }
}

// Default PPR scoring. Every value is points-per-unit of a raw projected stat.
// Changing any of these reprices the whole board because pts is computed from stats.
const DEFAULT_SCORING = {
  passYd: 0.04, passTD: 4, INT: -2, pass2pt: 2,
  rushYd: 0.1, rushTD: 6, rushAtt: 0, rush2pt: 2,
  rec: 1, recTE: 1, recYd: 0.1, recTD: 6, rec2pt: 2,
  fum: -2,
  // milestone bonuses (modeled from projected per-game yardage)
  bonus100: 0, bonus300pass: 0,
  // big-play / explosive-play bonuses (per play of that length)
  bonusBigRec: 0,     // per 20+ yard reception
  bonusBigRush: 0,    // per 20+ yard run
  bonus40Rec: 0,      // per 40+ yard reception
  bonus40Rush: 0,     // per 40+ yard run
  bonus40PassTD: 0,   // per 40+ yard passing TD
  // kicker
  fg: 3, fg50: 2, pat: 1, fgMiss: -1,
  // dst
  sack: 1, dint: 2, dfr: 2, dtd: 6, paPer: 1,
  // IDP (individual defensive players) — common balanced defaults
  idpSolo: 1, idpAst: 0.5, idpSack: 2, idpTFL: 1, idpQBH: 1,
  idpInt: 3, idpPD: 1, idpFF: 2, idpFR: 2, idpDTD: 6, idpSaf: 2,
};
function scoreFromStats(pos, s, sc) {
  if (!s) return 0;
  if (pos === "K") return (s.fg || 0) * sc.fg + (s.fg50 || 0) * sc.fg50 + (s.pat || 0) * sc.pat + (s.fgMiss || 0) * sc.fgMiss;
  if (pos === "DST") return (s.sack || 0) * sc.sack + (s.dint || 0) * sc.dint + (s.dfr || 0) * sc.dfr + (s.dtd || 0) * sc.dtd + Math.max(0, 35 - (s.pa || 350) / 10) * sc.paPer;
  if (pos === "DL" || pos === "LB" || pos === "DB") {
    return (s.solo || 0) * sc.idpSolo + (s.ast || 0) * sc.idpAst + (s.idpSack || 0) * sc.idpSack
      + (s.tfl || 0) * sc.idpTFL + (s.qbh || 0) * sc.idpQBH + (s.idpInt || 0) * sc.idpInt
      + (s.pd || 0) * sc.idpPD + (s.ff || 0) * sc.idpFF + (s.fr || 0) * sc.idpFR
      + (s.idpTD || 0) * sc.idpDTD + (s.saf || 0) * sc.idpSaf;
  }
  let pts = 0;
  pts += (s.passYd || 0) * sc.passYd + (s.passTD || 0) * sc.passTD + (s.INT || 0) * sc.INT;
  pts += (s.rushYd || 0) * sc.rushYd + (s.rushTD || 0) * sc.rushTD + (s.rushAtt || 0) * (sc.rushAtt || 0);
  // TE reception value can differ from base (TE premium); other positions use base rec
  const recVal = pos === "TE" && sc.recTE != null ? sc.recTE : sc.rec;
  pts += (s.rec || 0) * recVal + (s.recYd || 0) * sc.recYd + (s.recTD || 0) * sc.recTD;
  pts += (s.fum || 0) * sc.fum;
  // milestone bonuses, modeled from expected counts stored on the stat line
  pts += (s.hundredYd || 0) * (sc.bonus100 || 0);
  pts += (s.threeHundredYd || 0) * (sc.bonus300pass || 0);
  // Explosive-play bonuses. The data carries one projected 20+ yard play count (bigPlay);
  // we split it into rushing vs receiving by each player's share of rush/rec yards, and
  // model 40+ yard plays as ~22% of a player's 20+ plays (league-agnostic estimate).
  const big = s.bigPlay || 0;
  if (big > 0) {
    const ry = s.recYd || 0, uy = s.rushYd || 0, denom = ry + uy;
    const recShare = denom > 0 ? ry / denom : (pos === "RB" ? 0.25 : 1);
    const bigRec = big * recShare;
    const bigRush = big * (1 - recShare);
    pts += bigRec * (sc.bonusBigRec || 0);
    pts += bigRush * (sc.bonusBigRush || 0);
    pts += bigRec * 0.22 * (sc.bonus40Rec || 0);
    pts += bigRush * 0.22 * (sc.bonus40Rush || 0);
  }
  // 40+ yard passing TDs: ~14% of a passer's TDs are 40+ (league-agnostic estimate)
  if ((sc.bonus40PassTD || 0) && (s.passTD || 0)) pts += (s.passTD || 0) * 0.14 * sc.bonus40PassTD;
  return pts;
}

function buildPlayers(cfg) {
  const teMult = cfg.tePremMult != null ? cfg.tePremMult : (cfg.tePrem ? 1.0 : 0);
  const sf = isSuperflex(cfg); // canonical: covers cfg.sf, SUPER slot, or 2+ QB slots
  const useIdp = idpOn(cfg);
  const sc = { ...DEFAULT_SCORING, ...(cfg.scoring || {}) };
  const exclude = !!cfg.excludeRookies;
  // IDP players only enter the pool when the league actually starts defensive slots.
  const SRC = RAW.filter((r) => {
    if (!useIdp && IDP_POS.includes(r[1])) return false;
    if (exclude && META[r[0]] && META[r[0]].rookie) return false;
    return true;
  });
  const ps = SRC.map((r, i) => {
    const stats = STATS[r[0]] || {};
    const meta = META[r[0]] || {};
    // points from this league's scoring applied to raw projected stats.
    // TE premium is already handled inside scoreFromStats (recTE), so no extra add here.
    let pts = Math.round(scoreFromStats(r[1], stats, sc));
    // floor / ceiling scale with the variance baked into META (ratio off default pts)
    const dPts = META[r[0]] ? Math.max(1, scoreFromStats(r[1], stats, DEFAULT_SCORING)) : pts;
    const floorR = meta.floor != null ? meta.floor / dPts : 0.82;
    const ceilR = meta.ceil != null ? meta.ceil / dPts : 1.2;
    return {
      id: i, name: r[0], pos: r[1], team: r[2], age: r[3], bye: r[4], adp0: r[5], stats, pts,
      floor: Math.round(pts * floorR), ceil: Math.round(pts * ceilR),
      consensus0: meta.consensus != null ? meta.consensus : r[5], rookie: !!meta.rookie, inj: meta.inj || null,
    };
  });
  // In Superflex/2QB, QBs are far more valuable than their 1QB-anchored public ADP implies —
  // a flat multiplier leaves elite QBs buried, so we pull each QB up the board by its QB rank.
  // QB1≈pick 3, QB2≈4, QB3≈5.5, ramping ~1.55/rank, then easing for streamer-tier QBs.
  const qbRawSorted = ps.filter((p) => p.pos === "QB").map((p) => p.adp0).sort((a, b) => a - b);
  const qbRankOfRaw = (raw) => { const i = qbRawSorted.indexOf(raw); return i < 0 ? qbRawSorted.length : i + 1; };
  // TE premium: the lift is meaningful and rank-weighted — elite TEs (Bowers/McBride/Kittle)
  // become true first-round assets in TEP, while back-end TEs barely move. teMult is the extra
  // points-per-reception over the WR/RB rate (0.5 ≈ "TE premium", 1.0 ≈ "super TE premium").
  const teRawSorted = ps.filter((p) => p.pos === "TE").map((p) => p.adp0).sort((a, b) => a - b);
  const teRankOfRaw = (raw) => { const i = teRawSorted.indexOf(raw); return i < 0 ? teRawSorted.length : i + 1; };
  const adpTransform = (raw, pos) => {
    let a = raw;
    if (sf) {
      if (pos === "QB") {
        const r = qbRankOfRaw(raw);
        const anchor = r <= 12 ? 2.4 + (r - 1) * 1.55 : 20 + (r - 12) * 2.6;
        a = Math.max(1.5, Math.min(anchor, raw)); // never push a QB *below* its 1QB ADP
      } else {
        a = raw * 1.08; // skill players slide slightly to make room for QBs
      }
    }
    if (teMult > 0 && pos === "TE") {
      // rank-weighted pull-up: top TEs get a strong multiplier that fades down the position.
      const r = teRankOfRaw(raw);
      const strength = Math.min(1, teMult / 0.5); // 0.5 PPR-TE bump = full strength, scales up
      // fraction of the gap to the front of the board we close, biggest for TE1/TE2
      const pull = strength * Math.max(0.08, 0.46 - (r - 1) * 0.055);
      a = Math.max(1.4, raw * (1 - pull));
    }
    return a;
  };
  ps.forEach((p) => {
    p.adpMarket = adpTransform(p.adp0, p.pos); p.adp = p.adpMarket;
    p.consensus = adpTransform(p.consensus0, p.pos); // field-wide ADP for value comparison
  });
  const counts = sf ? { QB: 24, RB: 30, WR: 36, TE: 14 } : { QB: 14, RB: 30, WR: 36, TE: 14 };
  const repl = {};
  POS.forEach((pos) => { const s = ps.filter((p) => p.pos === pos).sort((a, b) => b.pts - a.pts); repl[pos] = s.length ? s[Math.min(counts[pos] - 1, s.length - 1)].pts : 0; });
  // IDP replacement levels (only relevant when IDP players are in the pool). Indices approximate
  // a typical 12-team IDP starting requirement so VBD is comparable to offense.
  const idpCounts = { DL: 24, LB: 30, DB: 24 };
  if (useIdp) IDP_POS.forEach((pos) => { const s = ps.filter((p) => p.pos === pos).sort((a, b) => b.pts - a.pts); repl[pos] = s.length ? s[Math.min(idpCounts[pos] - 1, s.length - 1)].pts : 0; });
  const VBD_POS = useIdp ? [...POS, ...IDP_POS] : POS;
  ps.forEach((p) => { p.vbd = VBD_POS.includes(p.pos) ? Math.round((p.pts - repl[p.pos]) * 10) / 10 : -50; });
  // ---- DYNASTY AGE ADJUSTMENT ----------------------------------------------------------------
  // In dynasty/keeper leagues, a player's long-term value depends heavily on age, and it ages very
  // differently by position: RBs fall off a cliff in their late 20s, WRs decline more gently, TEs and
  // especially QBs hold value into their 30s. We compute an age multiplier per player and apply it to
  // their VBD so the dynasty board slides aging players (e.g. a 29-yo RB) down toward where the dynasty
  // market actually has them, while young ascending players hold or rise. Redraft is unaffected.
  const isDynasty = cfg.type === "dynasty" || cfg.type === "keeper";
  if (isDynasty) {
    // peak age (full value at/below this) and yearly decline rate past peak, by position.
    const AGE = {
      RB: { peak: 24, decline: 0.115, floor: 0.26 }, // steepest fall — RBs age worst in dynasty
      WR: { peak: 25, decline: 0.052, floor: 0.40 },
      TE: { peak: 26, decline: 0.045, floor: 0.45 },
      QB: { peak: 28, decline: 0.028, floor: 0.55 }, // ages best
    };
    const youthBump = (pos, age) => {
      // young players (below peak) get a modest dynasty bump for years of control ahead
      const cfgA = AGE[pos]; if (!cfgA) return 1;
      const yearsYoung = Math.max(0, cfgA.peak - age);
      return 1 + Math.min(0.18, yearsYoung * (pos === "RB" ? 0.05 : 0.035));
    };
    const ageMult = (pos, age) => {
      const a = AGE[pos]; if (!a || !age || age <= 0) return 1;
      if (age <= a.peak) return youthBump(pos, age);
      const yearsPast = age - a.peak;
      // exponential-ish decline, clamped to a floor so a great old player isn't zeroed out
      return Math.max(a.floor, Math.pow(1 - a.decline, yearsPast));
    };
    ps.forEach((p) => {
      if (!VBD_POS.includes(p.pos)) return;
      const m = ageMult(p.pos, p.age);
      p.ageMult = m;
      // Apply to VBD. Shift so even discounted players keep a sensible relative order within position.
      p.vbd = Math.round(p.vbd * m * 10) / 10;
    });
  }
  [...POS, "K", "DST", ...IDP_POS].forEach((pos) => { const s = ps.filter((p) => p.pos === pos).sort((a, b) => b.pts - a.pts); s.forEach((p, i) => (p.posRank = i + 1)); });
  // How far is this league's scoring from standard? Public ADP is anchored to standard
  // scoring, so for an unusual league (e.g. points-per-carry) the market doesn't reflect
  // real value. We blend each player's effective ADP toward their value rank in proportion
  // to how weird the scoring is — so predictions and advice follow the reshuffled board.
  let scoreDist = 0;
  Object.keys(DEFAULT_SCORING).forEach((k) => { const base = Math.abs(DEFAULT_SCORING[k]) || 1; scoreDist += Math.abs((sc[k] || 0) - DEFAULT_SCORING[k]) / base; });
  const valByPts = ps.filter((p) => POS.includes(p.pos)).slice().sort((a, b) => b.pts - a.pts);
  valByPts.forEach((p, i) => (p.valueOverall = i + 1));
  const blend = Math.max(0, Math.min(0.85, scoreDist * 0.12)); // 0 at standard, grows with weirdness
  if (blend > 0.02) {
    ps.forEach((p) => { if (p.valueOverall != null) p.adp = p.adpMarket * (1 - blend) + (p.valueOverall + 0.5) * blend; });
  }
  // SPARSE LIVE ADP: when live ADP is too thin to trust (early season / mostly rookie drafts), the
  // market anchor is unreliable, so rank the board by the engine's own VBD value instead. We build a
  // cross-position value ranking (incl. K/DST/IDP) and, in Superflex/2QB, lift QBs by their value so
  // elite QBs land where they should. This produces a real, sensible board until live ADP matures.
  if (typeof LIVE_ADP_SPARSE !== "undefined" && LIVE_ADP_SPARSE) {
    const valPool = ps.filter((p) => VBD_POS.includes(p.pos) || p.pos === "K" || p.pos === "DST");
    // Effective cross-position value for ranking. In SuperFlex/2QB, QBs are more valuable, but the
    // lift must be PROPORTIONAL to the QB's own value — a flat bump makes replacement QBs leapfrog
    // elite RB/WR (e.g. Jaxson Dart over Bijan), which is wrong. Elite QBs get a real boost; marginal
    // QBs get little. Tuned so an SF board interleaves top QBs with top RB/WR like the market does.
    const qbs = valPool.filter((p) => p.pos === "QB").sort((a, b) => (b.vbd ?? -50) - (a.vbd ?? -50));
    const qbRankById = new Map(); qbs.forEach((p, i) => qbRankById.set(p.id, i)); // 0 = QB1
    // Position rank within RBs (by value) — used to lift elite bell-cow RBs toward where the human
    // market actually drafts them. VBD alone undervalues elite RBs vs how people really draft (a proven
    // top-3 scorer like CMC goes top-5 in nearly every redraft, recency + bell-cow scarcity). Since this
    // fallback board stands in for the MARKET (what others will pick), it should mirror that behavior.
    const rbs = valPool.filter((p) => p.pos === "RB").sort((a, b) => (b.vbd ?? -50) - (a.vbd ?? -50));
    const rbRankById = new Map(); rbs.forEach((p, i) => rbRankById.set(p.id, i)); // 0 = RB1
    const effVal = (p) => {
      let v = p.vbd != null ? p.vbd : -50;
      if (sf && p.pos === "QB") {
        // SuperFlex QB premium. In SF, the top ~4-5 QBs anchor the very top of the board — they're the
        // scarcest startable asset (you need 1.5-2 per team). In DYNASTY this is even stronger, because
        // QBs hold value for a decade while RBs decay fast. So the lift is large for QB1-5 and dynasty
        // gets an extra multiplier. Tuned so elite QBs (Allen, Daniels, Maye) clearly lead, with elite
        // young RB/WR just behind — matching real SF (dynasty) ADP.
        const rank = qbRankById.get(p.id) ?? 99; // 0 = QB1
        const decay = Math.pow(0.86, rank);       // QB1 full → QB5 ~53% → QB10 ~22%
        const base = isDynasty ? 78 : 52;          // dynasty QBs anchor the top harder
        v += base * decay;
      }
      if (p.pos === "RB") {
        // Market-realism lift for elite RBs: top bell-cows get drafted ahead of pure VBD (recency +
        // scarcity). Kept MODEST so it doesn't leapfrog elite QBs in SuperFlex. In dynasty it's smaller
        // still — RBs age out fast, so the market doesn't push old RBs up, and vbd is already age-cut.
        const rank = rbRankById.get(p.id) ?? 99; // 0 = RB1
        const decay = Math.pow(0.88, rank);       // RB1 full → RB6 ~46% → RB10 ~28%
        const base = isDynasty ? 18 : 38;          // much smaller in dynasty
        v += base * decay;
      }
      return v;
    };
    const ranked = valPool.slice().sort((a, b) => effVal(b) - effVal(a));
    // Assign a fractional "ADP-like" position rather than flat 1,2,3. We start at 1.0 and step forward
    // by an amount proportional to the value gap to the next player: tightly-bunched players land close
    // together (1.2, 1.5, 1.9…) and a real drop-off creates a bigger jump. This is an honest reflection
    // of the model's value spacing (not invented market data) and reads far more naturally than integers.
    // It also stays monotonic and averages ~1 step per player so overall pick numbers remain realistic.
    if (ranked.length) {
      // Use RAW vbd gaps (not the premium-inflated effVal) so the QB/RB premiums don't blow up the
      // spacing. Keep the average step at ~1 pick per player so overall ADP tracks rank, with small
      // fractional offsets that reflect how tightly players are bunched. Reads like real ADP (1.4, 2.1…).
      const vs = ranked.map((p) => (p.vbd != null ? p.vbd : -50));
      const gaps = [];
      for (let i = 0; i < ranked.length - 1; i++) gaps.push(Math.max(0, vs[i] - vs[i + 1]));
      const avgGap = gaps.length ? (gaps.reduce((a, b) => a + b, 0) / gaps.length) : 1;
      let pos = 1.0;
      ranked.forEach((p, i) => {
        p.adp = Math.round(pos * 10) / 10;
        p.adpMarket = p.adp;
        // step ~1 on average; nudged ±0.3 by how this player's gap compares to the average gap.
        const g = i < gaps.length ? gaps[i] : avgGap;
        const rel = avgGap > 0 ? g / avgGap : 1;            // 1 = average gap
        const step = Math.max(0.7, Math.min(1.4, 0.7 + rel * 0.35)); // stays close to 1
        pos += step;
      });
    }
    // players outside the value pool (shouldn't be many) sink below
    ps.forEach((p) => { if (!valPool.includes(p)) { p.adp = ranked.length + 50; } });
  }
  // OVERALL value tiers across positions (VBD-based). Walk players in VBD order; a tier
  // breaks at an elbow — a drop clearly bigger than the local average — for chunky tiers.
  const byV = ps.filter((p) => POS.includes(p.pos)).sort((a, b) => b.vbd - a.vbd);
  byV.forEach((p, i) => (p.valueRank = i + 1));
  let vt = 1, sinceBreak = 0;
  for (let i = 0; i < byV.length; i++) {
    if (i > 0) {
      const drop = byV[i - 1].vbd - byV[i].vbd;
      const w = byV.slice(Math.max(0, i - 6), i);
      let avg = 0; for (let j = 1; j < w.length; j++) avg += w[j - 1].vbd - w[j].vbd;
      avg = w.length > 1 ? avg / (w.length - 1) : drop;
      if ((drop > Math.max(8, avg * 2.1) && sinceBreak >= 2) || sinceBreak >= 8) { vt++; sinceBreak = 0; }
    }
    byV[i].vbdTier = vt; byV[i].tier = vt; sinceBreak++;
  }
  ps.filter((p) => !POS.includes(p.pos)).forEach((p) => { p.tier = vt + 1; p.vbdTier = vt + 1; });
  // ADP tiers: same elbow idea but over the ADP ordering (gaps in where the market drafts).
  const byA = ps.slice().sort((a, b) => a.adp - b.adp);
  let at = 1, sinceA = 0;
  for (let i = 0; i < byA.length; i++) {
    if (i > 0) {
      const gap = byA[i].adp - byA[i - 1].adp;
      const w = byA.slice(Math.max(0, i - 6), i);
      let avg = 0; for (let j = 1; j < w.length; j++) avg += w[j].adp - w[j - 1].adp;
      avg = w.length > 1 ? avg / (w.length - 1) : gap;
      if ((gap > Math.max(2.4, avg * 2.0) && sinceA >= 2) || sinceA >= 9) { at++; sinceA = 0; }
    }
    byA[i].adpTier = at; sinceA++;
  }
  ps.forEach((p) => { const o = OUTLOOKS[p.name]; p.outlook = o ? o.p : null; p.teamOutlook = o && o.tm ? o.tm : null; });

  // KEEPER-ADJUSTED ADP (compact-up). If players are kept, they're off the board — so the
  // remaining players' effective draft position rises to fill the vacated slots. Example:
  // keep the top-3 ADP players and the old #4 now effectively goes near the top of the board.
  const keptIds = new Set((cfg.keepers || []).map((k) => k.playerId).filter((x) => x != null));
  if (keptIds.size) {
    ps.forEach((p) => { p.adpOriginal = p.adp; p.isKept = keptIds.has(p.id); });
    // The set of ADP "slots" that actually exist on the board, in ascending order. After
    // removing keepers, the i-th still-available player (by original ADP) inherits the i-th
    // ADP slot — so everyone behind a keeper compacts upward into the vacated draft capital.
    const allAdpSlots = ps.filter((p) => POS.includes(p.pos)).map((p) => p.adpOriginal).sort((a, b) => a - b);
    const avail = ps.filter((p) => !keptIds.has(p.id) && POS.includes(p.pos)).sort((a, b) => a.adpOriginal - b.adpOriginal);
    avail.forEach((p, i) => { p.adp = allAdpSlots[i] != null ? allAdpSlots[i] : p.adpOriginal; });
  }
  return ps;
}

// Market spread around a player's ADP. Tight at the very top (the 1.01 almost never
// slides), widening with ADP. This is what stops elite round-1 players from falling.
const sigma = (adp) => Math.max(0.7, 0.6 + 0.085 * adp);
// Selection propensity vs the current pick.
//  - Going EARLIER than ADP (z>0): decays (reaches are rarer the bigger the reach).
//  - At ADP (z≈0): peak baseline.
//  - FALLEN past ADP (z<0): RISES — real drafters pounce on value that slips. The further
//    an elite (low-ADP) player falls, the closer to certain he's taken. This is what stops
//    a 1.05 ADP player from sliding 20 picks. The magnet is stronger for higher-pedigree
//    (lower-ADP) players, who almost never make it far past their price.
const baseW = (p, pick) => {
  const s = sigma(p.adp);
  const z = (p.adp - pick) / s; // z>0 = would be a reach; z<0 = has fallen
  if (z > 0) return Math.exp(-0.5 * z * z); // reach penalty
  const fallen = -z; // how many sigmas past ADP he's slipped
  // pedigree: elite (low ADP) players get a steeper magnet
  const pedigree = p.adp <= 12 ? 3.4 : p.adp <= 24 ? 2.5 : p.adp <= 48 ? 1.8 : 1.25;
  return 1 + fallen * pedigree; // value magnet grows the longer he slides
};
// Active roster spec for the current league (set per league before engine calls).
// start: dedicated starters per position; FLEX (RB/WR/TE) and SUPER (any) are generic slots.
let SPEC = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, SUPER: 0, DST: 0, K: 0 };
const setSpec = (s) => { SPEC = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, SUPER: 0, DST: 0, K: 0, ...(s || {}) }; };
const genericSlots = () => (SPEC.FLEX || 0) + (SPEC.SUPER || 0);
// demand ~ expected roster need scaled by starters + a share of generic slots
const demand = (sf) => {
  const g = genericSlots();
  return {
    QB: SPEC.QB + (sf || SPEC.SUPER > 0 ? 0.7 : 0.05) + (SPEC.SUPER ? SPEC.SUPER * 0.5 : 0),
    RB: SPEC.RB + g * 0.42,
    WR: SPEC.WR + g * 0.46,
    TE: SPEC.TE + g * 0.12,
  };
};
const REQ_F = (sf) => ({ QB: SPEC.QB, RB: SPEC.RB, WR: SPEC.WR, TE: SPEC.TE });
function capsOf(cfg) {
  const d = Math.max(0, cfg.rounds - 8);
  const base = cfg.sf
    ? { QB: 3 + Math.floor(d / 6), RB: 4 + Math.ceil(d / 2), WR: 4 + Math.ceil(d / 2), TE: 2 + Math.floor(d / 6) }
    : { QB: 2 + Math.floor(d / 6), RB: 4 + Math.ceil(d / 2), WR: 4 + Math.ceil(d / 2), TE: 2 + Math.floor(d / 6) };
  POS.forEach((p) => { const x = cfg.caps && cfg.caps[p]; if (x != null && x !== "" && +x > 0) base[p] = +x; });
  return base;
}
function flexOpen(counts, req) { let s = 0; ["RB","WR","TE"].forEach((p) => (s += Math.max(0, counts[p] - req[p]))); return s < genericSlots(); }
function unfilledStarters(counts, sf) { const req = REQ_F(sf); let u = 0; POS.forEach((p) => (u += Math.max(0, req[p] - counts[p]))); if (flexOpen(counts, req)) u += genericSlots() - (["RB","WR","TE"].reduce((a,p)=>a+Math.max(0,counts[p]-req[p]),0)); return Math.max(0, u); }
function legalCands(cands, counts, cfg) {
  const caps = capsOf(cfg), req = REQ_F(cfg.sf);
  const remaining = cfg.rounds - POS.reduce((s, p) => s + counts[p], 0);
  const mustFill = unfilledStarters(counts, cfg.sf) >= remaining;
  const ok = cands.filter((c) => {
    if (counts[c.pos] >= caps[c.pos]) return false;
    if (mustFill) { const needs = counts[c.pos] < req[c.pos] || (["RB","WR","TE"].includes(c.pos) && flexOpen(counts, req)); if (!needs) return false; }
    return true;
  });
  return ok.length ? ok : cands;
}
function marginalVbd(c, counts, sf) {
  const req = REQ_F(sf);
  if (counts[c.pos] < req[c.pos]) return c.vbd;
  const G = genericSlots();
  const superOnly = SPEC.SUPER || 0;
  let surplus = 0; ["RB","WR","TE"].forEach((p) => (surplus += Math.max(0, counts[p] - req[p])));
  if (superOnly > 0) surplus += Math.max(0, counts.QB - req.QB);
  const eligible = c.pos !== "QB" || superOnly > 0 || sf;
  return surplus < G && eligible ? c.vbd : c.vbd * 0.25;
}
function userScore(c, counts, dem, strategy, sf, pickNum) {
  if (strategy === "adp") return -c.adp;
  const mv = marginalVbd(c, counts, sf);
  if (strategy === "value") return mv;
  if (strategy === "youth") {
    // prize young players, still gated by real value so it can't draft scrubs
    const ageScore = Math.max(0, 30 - c.age) * 6;
    return mv + ageScore + 5 * Math.max(0, dem[c.pos] - counts[c.pos]) - reachPenalty(c, pickNum) * 0.5;
  }
  if (strategy === "upside") {
    // ceiling proxy: young + ascending + positions with breakout variance
    const youngBonus = Math.max(0, 27 - c.age) * 5;
    const posVar = c.pos === "WR" || c.pos === "RB" ? 14 : c.pos === "TE" ? 6 : 4;
    return mv + youngBonus + posVar + 4 * Math.max(0, dem[c.pos] - counts[c.pos]) - reachPenalty(c, pickNum) * 0.5;
  }
  // BALANCED (and wr/rb-heavy tilts): value + need, anchored to the market so it won't
  // pass an obvious consensus pick. The reach penalty makes drafting far ahead of ADP
  // costly, which is why at pick 5 it takes the best available top-of-board player.
  let s = mv + 7 * Math.max(0, dem[c.pos] - counts[c.pos]) - reachPenalty(c, pickNum);
  if ((strategy === "wr" && c.pos === "WR") || (strategy === "rb" && c.pos === "RB")) s += 18;
  return s;
}
// cost of drafting a player well before the market would — grows the earlier you are
// (a round-1 reach is far more wasteful than a round-12 reach) and with the gap size.
function reachPenalty(c, pickNum) {
  if (pickNum == null) return 0;
  const gap = c.adp - pickNum; // positive = you'd be reaching
  if (gap <= 0) return 0;
  const earlyFactor = Math.max(0.3, 1.6 - pickNum / 60); // ~1.6x in round 1, fading later
  return gap * 2.2 * earlyFactor;
}
function needMult(counts, pos, round, dem, R) {
  const need = Math.max(0, dem[pos] - counts[pos]);
  if (need <= 0.05) return pos === "QB" || pos === "TE" ? 0.4 : 0.8;
  return 1 + 0.5 * Math.min(need, 2) * (0.7 + 0.5 * (round / R));
}
function runMultF(recent, pos) { const c = recent.filter((x) => x === pos).length; return c >= 3 ? Math.min(1.5, 1 + 0.18 * (c - 2)) : 1; }
function weightFor(p, pickNum, counts, round, recent, dem, R) { return baseW(p, pickNum) * needMult(counts, p.pos, round, dem, R) * runMultF(recent, p.pos) + 1e-7; }
function candidatesOf(sortedAdp, drafted, limit) { const out = []; for (const p of sortedAdp) { if (!drafted[p.id]) { out.push(p); if (out.length >= limit) break; } } return out; }
function sample(cands, ws) { const sum = ws.reduce((a, b) => a + b, 0); let r = Math.random() * sum; for (let i = 0; i < cands.length; i++) { r -= ws[i]; if (r <= 0) return i; } return cands.length - 1; }

function runSims(players, sortedAdp, picks, userIdx, cfg, strategy, nSims) {
  const TOTAL = totalOf(cfg), R = cfg.rounds, sf = cfg.sf;
  const start = picks.length;
  const nexts = []; for (let o = start; o < TOTAL && nexts.length < 3; o++) if (teamAt(o) === userIdx) nexts.push(o);
  if (!nexts.length) return null;
  const dem = demand(sf);
  const baseDrafted = new Uint8Array(players.length);
  const baseCounts = Array.from({ length: TEAMS }, () => ({ QB: 0, RB: 0, WR: 0, TE: 0 }));
  picks.forEach((pk, o) => { const pl = players[pk]; if (!pl) return; baseDrafted[pk] = 1; const c = baseCounts[teamAt(o)]; if (c[pl.pos] != null) c[pl.pos]++; });
  for (let t = 0; t < TEAMS; t++) { seedKeeperCounts(players, t, baseCounts[t]); }
  allKeeperAddIds().forEach((id) => { baseDrafted[id] = 1; });
  const baseRecent = picks.slice(-8).map((id) => players[id] && players[id].pos).filter(Boolean);
  const surv = [new Float64Array(players.length), new Float64Array(players.length), new Float64Array(players.length)];
  const expBest1 = { QB: 0, RB: 0, WR: 0, TE: 0 };
  const end = nexts[nexts.length - 1];
  for (let s = 0; s < nSims; s++) {
    const drafted = baseDrafted.slice();
    const counts = baseCounts.map((c) => ({ ...c }));
    let recent = baseRecent.slice();
    for (let o = start; o <= end; o++) {
      const t = teamAt(o), round = Math.floor(o / TEAMS) + 1, pickNum = o + 1;
      const ni = nexts.indexOf(o);
      if (ni >= 0) {
        for (const p of players) if (!drafted[p.id]) surv[ni][p.id]++;
        if (ni === 0) { const best = { QB: -999, RB: -999, WR: -999, TE: -999 }; for (const p of players) if (!drafted[p.id] && p.vbd > best[p.pos]) best[p.pos] = p.vbd; POS.forEach((pos) => { if (best[pos] > -999) expBest1[pos] += best[pos]; }); }
        if (o === end) break;
        const cands = legalCands(candidatesOf(sortedAdp, drafted, 30), counts[t], cfg);
        let bc = cands[0], bs = -1e9;
        for (const c of cands) { const sc = userScore(c, counts[t], dem, strategy, sf, pickNum); if (sc > bs) { bs = sc; bc = c; } }
        drafted[bc.id] = 1; counts[t][bc.pos]++; recent = [...recent.slice(-7), bc.pos];
        continue;
      }
      const cands = legalCands(candidatesOf(sortedAdp, drafted, 34), counts[t], cfg);
      const ws = cands.map((c) => weightFor(c, pickNum, counts[t], round, recent, dem, R));
      const i = sample(cands, ws);
      drafted[cands[i].id] = 1; counts[t][cands[i].pos]++; recent = [...recent.slice(-7), cands[i].pos];
    }
  }
  const pct = surv.map((arr) => { const m = {}; players.forEach((p) => (m[p.id] = Math.round((arr[p.id] / nSims) * 100))); return m; });
  POS.forEach((pos) => (expBest1[pos] /= nSims));
  return { nexts, pct, expBest1 };
}

// Survival odds for every player at an arbitrary OVERALL pick number (e.g. a pick you
// might trade for). Simulates opponents from the current state up to that pick.
function survivalAtPick(players, sortedAdp, picks, targetOverall, cfg, nSims) {
  const TOTAL = totalOf(cfg), R = cfg.rounds, sf = cfg.sf, dem = demand(sf);
  const target = Math.max(picks.length, Math.min(TOTAL, targetOverall - 1)); // 0-indexed exclusive boundary
  const baseDrafted = new Uint8Array(players.length);
  const baseCounts = Array.from({ length: TEAMS }, () => ({ QB: 0, RB: 0, WR: 0, TE: 0 }));
  picks.forEach((pk, o) => { const pl = players[pk]; if (!pl) return; baseDrafted[pk] = 1; const c = baseCounts[teamAt(o)]; if (c[pl.pos] != null) c[pl.pos]++; });
  for (let t = 0; t < TEAMS; t++) { seedKeeperCounts(players, t, baseCounts[t]); }
  allKeeperAddIds().forEach((id) => { baseDrafted[id] = 1; });
  const baseRecent = picks.slice(-8).map((id) => players[id] && players[id].pos).filter(Boolean);
  // Count, per player, how many sims they SURVIVE past `target`. One simulation per sim run,
  // stopping at the target boundary — anyone still undrafted survived. Single shared random
  // process guarantees the result is monotonic in target (later target ⇒ ≤ survival).
  const surv = new Float64Array(players.length);
  for (let s = 0; s < nSims; s++) {
    const drafted = baseDrafted.slice();
    const counts = baseCounts.map((c) => ({ ...c }));
    let recent = baseRecent.slice();
    for (let o = picks.length; o < target; o++) {
      const t = teamAt(o), round = Math.floor(o / TEAMS) + 1, pickNum = o + 1;
      const cands = legalCands(candidatesOf(sortedAdp, drafted, 34), counts[t], cfg);
      const ws = cands.map((c) => weightFor(c, pickNum, counts[t], round, recent, dem, R));
      const c = cands[sample(cands, ws)];
      if (!c) break;
      drafted[c.id] = 1; counts[t][c.pos]++; recent = [...recent.slice(-7), c.pos];
    }
    for (const p of players) if (!drafted[p.id]) surv[p.id]++;
  }
  const m = {}; players.forEach((p) => (m[p.id] = Math.round((surv[p.id] / nSims) * 100)));
  return m;
}

function projectAll(players, sortedAdp, picks, userIdx, cfg, strategy, forcedId) {
  const TOTAL = totalOf(cfg), R = cfg.rounds, sf = cfg.sf;
  const dem = demand(sf);
  const drafted = new Uint8Array(players.length);
  const rosters = Array.from({ length: TEAMS }, () => []);
  picks.forEach((pk, o) => { const pl = players[pk]; if (!pl) return; drafted[pk] = 1; rosters[teamAt(o)].push(pl); });
  for (let t = 0; t < TEAMS; t++) { seedKeeperRoster(players, t, rosters[t]); }
  allKeeperAddIds().forEach((id) => { drafted[id] = 1; });
  let recent = picks.slice(-8).map((id) => players[id] && players[id].pos).filter(Boolean);
  let userFirstDone = false;
  for (let o = picks.length; o < TOTAL; o++) {
    const t = teamAt(o), round = Math.floor(o / TEAMS) + 1, pickNum = o + 1;
    const counts = { QB: 0, RB: 0, WR: 0, TE: 0 };
    rosters[t].forEach((p) => { if (counts[p.pos] != null) counts[p.pos]++; });
    let choice = null;
    if (t === userIdx) {
      if (!userFirstDone && forcedId != null && !drafted[forcedId]) { choice = players[forcedId]; }
      else { const cands = legalCands(candidatesOf(sortedAdp, drafted, 30), counts, cfg); let bs = -1e9; for (const c of cands) { const sc = userScore(c, counts, dem, strategy, sf, pickNum); if (sc > bs) { bs = sc; choice = c; } } }
      userFirstDone = true;
    } else {
      const cands = legalCands(candidatesOf(sortedAdp, drafted, 34), counts, cfg);
      let bs = -1e9; for (const c of cands) { const w = weightFor(c, pickNum, counts, round, recent, dem, R); if (w > bs) { bs = w; choice = c; } }
    }
    if (!choice) break;
    drafted[choice.id] = 1; rosters[t].push(choice); recent = [...recent.slice(-7), choice.pos];
  }
  const pts = rosters.map((r) => lineupPts(r, sf));
  const order = pts.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v);
  const rank = new Array(TEAMS); order.forEach((e, idx) => (rank[e.i] = idx + 1));
  return { rosters, pts, rank };
}

// Projected full board: returns an array indexed by OVERALL pick number. Already-made picks
// are left undefined (the real pick fills them); each remaining slot gets the engine's
// most-likely player id, simulating the rest of the draft from the current state forward.
function projectBoard(players, sortedAdp, picks, userIdx, cfg, strategy, forcedId) {
  const TOTAL = totalOf(cfg), R = cfg.rounds, sf = cfg.sf;
  const dem = demand(sf);
  const drafted = new Uint8Array(players.length);
  const counts = Array.from({ length: TEAMS }, () => ({ QB: 0, RB: 0, WR: 0, TE: 0 }));
  picks.forEach((pk, o) => { const pl = players[pk]; if (!pl) return; drafted[pk] = 1; const c = counts[teamAt(o)]; if (c[pl.pos] != null) c[pl.pos]++; });
  for (let t = 0; t < TEAMS; t++) { seedKeeperCounts(players, t, counts[t]); }
  allKeeperAddIds().forEach((id) => { drafted[id] = 1; });
  let recent = picks.slice(-8).map((id) => players[id] && players[id].pos).filter(Boolean);
  let userFirstDone = false;
  const board = new Array(TOTAL).fill(undefined);
  // Pre-rank a deep fallback list (by ADP, then projection value) so we can always fill late slots
  // even when the top-of-board candidate window is exhausted in very deep (e.g. 26-round) drafts.
  const deepPool = sortedAdp.slice();
  for (let o = picks.length; o < TOTAL; o++) {
    const t = teamAt(o), round = Math.floor(o / TEAMS) + 1, pickNum = o + 1;
    let choice = null;
    if (t === userIdx) {
      if (!userFirstDone && forcedId != null && !drafted[forcedId]) choice = players[forcedId];
      else { const cands = legalCands(candidatesOf(sortedAdp, drafted, 30), counts[t], cfg); let bs = -1e9; for (const c of cands) { const sc = userScore(c, counts[t], dem, strategy, sf, pickNum); if (sc > bs) { bs = sc; choice = c; } } }
      userFirstDone = true;
    } else {
      const cands = legalCands(candidatesOf(sortedAdp, drafted, 34), counts[t], cfg);
      let bs = -1e9; for (const c of cands) { const w = weightFor(c, pickNum, counts[t], round, recent, dem, R); if (w > bs) { bs = w; choice = c; } }
    }
    // Fallback: if the ranked window produced nothing (deep draft, thin pool), take the best
    // remaining undrafted player by ADP so the projected board still completes all rounds.
    if (!choice) { for (const c of deepPool) { if (!drafted[c.id]) { choice = c; break; } } }
    if (!choice) break; // truly no players left at all
    board[o] = choice.id; drafted[choice.id] = 1; if (counts[t][choice.pos] != null) counts[t][choice.pos]++; recent = [...recent.slice(-7), choice.pos];
  }
  return board;
}

function projectPath(players, sortedAdp, picks, userIdx, cfg, strategy, forcedId, extend) {
  const TOTAL = totalOf(cfg), R = cfg.rounds, sf = cfg.sf;
  const dem = demand(sf);
  const drafted = new Uint8Array(players.length);
  const counts = Array.from({ length: TEAMS }, () => ({ QB: 0, RB: 0, WR: 0, TE: 0 }));
  picks.forEach((pk, o) => { const pl = players[pk]; if (!pl) return; drafted[pk] = 1; const c = counts[teamAt(o)]; if (c[pl.pos] != null) c[pl.pos]++; });
  for (let t = 0; t < TEAMS; t++) { seedKeeperCounts(players, t, counts[t]); }
  allKeeperAddIds().forEach((id) => { drafted[id] = 1; });
  let recent = picks.slice(-8).map((id) => players[id] && players[id].pos).filter(Boolean);
  const path = []; let passedUser = false, afterUser = 0;
  for (let o = picks.length; o < TOTAL && path.length < 20; o++) {
    const t = teamAt(o), round = Math.floor(o / TEAMS) + 1, pickNum = o + 1;
    let entry;
    if (t === userIdx) {
      let choice = null;
      if (!passedUser && forcedId != null && !drafted[forcedId]) choice = players[forcedId];
      else { const cands = legalCands(candidatesOf(sortedAdp, drafted, 30), counts[t], cfg); let bs = -1e9; for (const c of cands) { const sc = userScore(c, counts[t], dem, strategy, sf, pickNum); if (sc > bs) { bs = sc; choice = c; } } }
      entry = { o, t, user: true, p: choice };
      passedUser = true;
      if (!choice) break;
      drafted[choice.id] = 1; counts[t][choice.pos]++; recent = [...recent.slice(-7), choice.pos];
    } else {
      const cands = legalCands(candidatesOf(sortedAdp, drafted, 34), counts[t], cfg);
      if (!cands.length) { continue; } // nothing legal/left to project at this slot — skip it
      const ws = cands.map((c) => weightFor(c, pickNum, counts[t], round, recent, dem, R));
      const sum = ws.reduce((a, b) => a + b, 0);
      let bi = 0; for (let i = 1; i < ws.length; i++) if (ws[i] > ws[bi]) bi = i;
      const c = cands[bi];
      if (!c) { continue; }
      // guard the probability: if total weight is 0 (degenerate), fall back to an even split
      const prob = sum > 0 ? Math.round((ws[bi] / sum) * 100) : Math.round(100 / cands.length);
      entry = { o, t, p: c, prob: Number.isFinite(prob) ? prob : 0 };
      drafted[c.id] = 1; if (counts[t][c.pos] != null) counts[t][c.pos]++; recent = [...recent.slice(-7), c.pos];
    }
    path.push(entry);
    if (passedUser) { if (!extend || afterUser >= 5) break; if (!entry.user) afterUser++; }
  }
  return path;
}

function lineupPts(roster, sf) {
  const by = { QB: [], RB: [], WR: [], TE: [] };
  roster.forEach((p) => { if (by[p.pos]) by[p.pos].push(p.pts); });
  POS.forEach((k) => by[k].sort((a, b) => b - a));
  let pts = 0; const used = { QB: 0, RB: 0, WR: 0, TE: 0 };
  const take = (pos, n) => { for (let i = 0; i < n; i++) if (by[pos][used[pos]] != null) { pts += by[pos][used[pos]]; used[pos]++; } };
  take("QB", SPEC.QB); take("RB", SPEC.RB); take("WR", SPEC.WR); take("TE", SPEC.TE);
  for (let i = 0; i < (SPEC.FLEX || 0); i++) { let f = null; ["RB","WR","TE"].forEach((pos) => { const v = by[pos][used[pos]]; if (v != null && (f == null || v > f.v)) f = { pos, v }; }); if (f) { pts += f.v; used[f.pos]++; } }
  for (let i = 0; i < (SPEC.SUPER || 0); i++) { let b = null; POS.forEach((pos) => { const v = by[pos][used[pos]]; if (v != null && (b == null || v > b.v)) b = { pos, v }; }); if (b) { pts += b.v; used[b.pos]++; } }
  return Math.round(pts);
}
function lineupSlots(roster, sf) {
  const sorted = { QB: [], RB: [], WR: [], TE: [] };
  roster.forEach((p) => { if (sorted[p.pos]) sorted[p.pos].push(p); });
  POS.forEach((k) => sorted[k].sort((a, b) => b.pts - a.pts));
  const slots = []; const used = { QB: 0, RB: 0, WR: 0, TE: 0 };
  const take = (slot, pos) => { const p = sorted[pos][used[pos]]; slots.push({ slot, p: p || null }); if (p) used[pos]++; };
  for (let i = 0; i < SPEC.QB; i++) take(SPEC.QB > 1 ? `QB${i + 1}` : "QB", "QB");
  for (let i = 0; i < SPEC.RB; i++) take(`RB${i + 1}`, "RB");
  for (let i = 0; i < SPEC.WR; i++) take(`WR${i + 1}`, "WR");
  for (let i = 0; i < SPEC.TE; i++) take(SPEC.TE > 1 ? `TE${i + 1}` : "TE", "TE");
  for (let i = 0; i < (SPEC.FLEX || 0); i++) { let best = null; ["RB","WR","TE"].forEach((pos) => { const p = sorted[pos][used[pos]]; if (p && (!best || p.pts > best.pts)) best = p; }); slots.push({ slot: (SPEC.FLEX > 1 ? `FLEX${i + 1}` : "FLEX"), p: best }); if (best) used[best.pos]++; }
  for (let i = 0; i < (SPEC.SUPER || 0); i++) { let b2 = null; POS.forEach((pos) => { const p = sorted[pos][used[pos]]; if (p && (!b2 || p.pts > b2.pts)) b2 = p; }); slots.push({ slot: "SFLX", p: b2 }); if (b2) used[b2.pos]++; }
  const bench = []; POS.forEach((pos) => { for (let i = used[pos]; i < sorted[pos].length; i++) bench.push(sorted[pos][i]); });
  bench.sort((a, b) => b.pts - a.pts);
  return { slots, bench };
}
function needLevel(count, bestVbd, dem, pos) {
  const qty = dem[pos] - count;
  if (qty >= 1.5) return 2;
  if (qty > 0.05) return 1;
  if (bestVbd != null && bestVbd < 0) return 1;
  return 0;
}
// Position strength for a team: quality × quantity, returning 0 (green/strong), 1 (amber/middle),
// 2 (red/weak). Mirrors the "League needs — strength" table so chips and that table always agree.
//  - count: how many at this position the team rosters
//  - bestVbd: best VBD among them (null = none) — the QUALITY signal
//  - req: starting slots required at this position in this format
//  - remaining: picks the team still has left (so we can weight urgency of unfilled starters)
// Logic: full starters + real talent = strong; full starters w/ weak talent OR partial w/ strong
// talent = middle; otherwise weak. A team with the WR1 but only 1 of 3 WR slots filled and lots of
// draft left still reads weak/amber, because the unfilled slots will drag the lineup down.
function posStrength(count, bestVbd, req, remaining) {
  const haveStarters = count >= req;
  const short = Math.max(0, req - count);
  const quality = bestVbd; // best VBD at position (null = none)
  if (req === 0 && count === 0) return 0; // not a starting position here
  // Strong: starters filled AND at least one genuinely useful (above-replacement) player. Filling
  // your slots when others haven't is real strength, so the quality bar here is modest.
  if (haveStarters && quality != null && quality >= 8) return 0;
  // Middle: starters filled but only replacement-level talent, OR not yet filled but holding a
  // strong piece with the picks left to round it out.
  if (haveStarters && quality != null && quality >= -8) return 1;
  if (!haveStarters && quality != null && quality >= 40 && remaining != null && remaining > short) return 1;
  // Otherwise weak: thin headcount, below-replacement talent, or running out of picks to fix it.
  return 2;
}
// Draft-pick value curve. Like a trade-value chart, early picks are worth dramatically more than
// late ones (non-linear). We score a pick position into "value points" so the WORTH of moving a
// player is the change in curve value between his ADP and where he actually went — not a flat
// pick-count difference. This makes reaches/steals at the top of the draft carry far more weight.
function pickCurve(overallPick) {
  // overallPick is 1-based. Smooth exponential-ish decay: pick 1 ≈ 1000, ~halves every ~14 picks.
  // Tuned so R1 picks tower over late picks (pick 1≈1000, 12≈590, 24≈360, 60≈120, 120≈22, 180≈4).
  const x = Math.max(1, overallPick);
  return 1000 * Math.pow(0.955, x - 1);
}
function pickValue(p, overall, cfg) {
  const actual = overall + 1;            // where he was actually taken (1-based)
  const adp = Math.max(1, p.adp);        // where he should have gone
  // Value = how much draft-capital value the pick gained or lost vs. his market price, on the curve.
  // Steal (fell past ADP): actual > adp → you spent a cheaper pick on a pricier asset → positive.
  // Reach (taken early):   actual < adp → you spent a premium pick on a cheaper asset → negative.
  const curveGap = pickCurve(adp) - pickCurve(actual);
  // Scale to a readable range and round. The curve already bakes in round disparity (a few picks at
  // the top swing far more value than many picks at the bottom), so no separate round multiplier.
  let v = curveGap / 6;
  // Reaches sting a touch harder than equivalent steals reward — premium capital misused is worse
  // than capital saved. Asymmetric by ~25%.
  if (v < 0) v *= 1.25;
  return Math.round(v);
}
// Overall pick number (1-based) from a 0-based pick index.
const overallPick = (o) => o + 1;
const heat = (pct) => `hsla(${Math.round(pct * 1.25)},60%,45%,0.22)`;
const valBg = (v) => (v === 0 ? "transparent" : v > 0 ? `rgba(124,217,178,${Math.min(0.5, Math.abs(v) / 80)})` : `rgba(242,101,92,${Math.min(0.5, Math.abs(v) / 80)})`);

function makeOutlook(p, sims, drafted) {
  const out = [];
  const tierWord = p.tier <= 1 ? "elite" : p.tier === 2 ? "strong" : p.tier === 3 ? "solid" : p.tier <= 5 ? "depth/upside" : "late-round";
  const posLabel = { QB: "quarterback", RB: "running back", WR: "receiver", TE: "tight end", DL: "defensive lineman", LB: "linebacker", DB: "defensive back", K: "kicker", DST: "defense" }[p.pos] || p.pos;
  const range = p.ceil != null && p.floor != null ? (p.ceil - p.floor > p.pts * 0.42 ? "boom-or-bust" : "steady") : null;
  const edge = Math.round(p.adp - p.consensus);
  const gap = p.valueRank != null ? Math.round(p.adp - p.valueRank) : 0;
  const surv = !drafted && sims && sims.pct[0] && sims.pct[0][p.id] != null ? sims.pct[0][p.id] : null;
  const iv = injuryView(p);

  // 1) THE TAKE — one short verdict line your eye lands on first.
  let take, takeTone = "neutral";
  if (gap > 8 || edge > 5) { take = "Value here — you can likely wait and still get him."; takeTone = "good"; }
  else if (gap < -8 || edge < -5) { take = "Priced above his value — let someone else reach."; takeTone = "bad"; }
  else if (surv != null && surv <= 20) { take = "Going soon — if you want him, take him now."; takeTone = "warn"; }
  else { take = "Fairly priced at the market here."; takeTone = "neutral"; }
  out.push({ kind: "take", tone: takeTone, x: take });

  // 2) STAT STRIP — compact chips, the numbers at a glance.
  const chips = [`${p.pos}${p.posRank}`, `Tier ${p.tier}`, `${p.pts} pts`, `${p.vbd > 0 ? "+" : ""}${p.vbd.toFixed(0)} VBD`, `ADP ${p.adp.toFixed(1)}`];
  if (surv != null) chips.push(`${surv}% to you`);
  out.push({ kind: "stats", chips });

  // 3) WHO — one-line identity sentence.
  const article = /^[aeiou]/i.test(tierWord) ? "An" : "A";
  out.push({ t: "Who", x: `${article} ${tierWord} ${posLabel}${range ? `, ${range} profile` : ""}.` });

  // 4) WHY — the situational read.
  let why;
  if (gap > 8) why = `Market underprices him ~${gap} picks for this scoring.`;
  else if (gap < -8) why = `Market prices him ~${Math.abs(gap)} picks above his value for this scoring.`;
  else if (edge > 5) why = `This platform drafts him ~${edge} picks later than the field — room to wait.`;
  else if (edge < -5) why = `This platform over-drafts him ~${Math.abs(edge)} picks vs. the field.`;
  else why = `His ADP (${p.adp.toFixed(1)}) lines up with both this platform and the field.`;
  if (surv != null) why += surv <= 20 ? ` Only ~${surv}% to survive to your next pick.` : surv <= 55 ? ` ~${surv}% coin-flip to make it back.` : ` ~${surv}% he's still there next time.`;
  out.push({ t: "Why", x: why });

  // 5) SUPPORTING — secondary detail, clearly subordinate.
  if (p.floor != null && p.ceil != null) out.push({ t: "Range", x: `Floor ${p.floor} · proj ${p.pts} · ceiling ${p.ceil}.` });
  if (iv) out.push({ t: `Injury — ${iv.label}${iv.back ? ` · ${iv.back}` : ""}`, x: iv.note });
  if (p.outlook) out.push({ t: "Player", x: p.outlook });
  if (p.teamOutlook) out.push({ t: "Team", x: p.teamOutlook });
  if (p.adpOriginal != null && Math.abs(p.adpOriginal - p.adp) > 0.6) out.push({ t: "Keeper-adjusted ADP", x: `Effective ADP ${p.adp.toFixed(1)} (market ${p.adpOriginal.toFixed(1)}) — keepers ahead of him are off the board.` });
  out.push({ t: "Bye", x: `Week ${p.bye || "—"}` });
  out.push({ t: "Note", x: `Sample outlook; production pulls a live read from player data, news, and injury feeds.` });
  return out;
}

// Renders makeOutlook's blocks into a scannable card: a tinted verdict line, a chip stat-strip,
// then labeled rows. Used by every player-hover tooltip so the layout is identical everywhere.
function OutlookCard({ content }) {
  const toneColor = { good: "var(--green)", bad: "var(--red)", warn: "var(--gold)", neutral: "var(--ink)" };
  return (
    <>
      {content.map((l, i) => {
        if (typeof l === "string") return <div key={i} style={{ fontSize: 12, marginBottom: i < content.length - 1 ? 6 : 0 }}>{l}</div>;
        if (l.kind === "take") {
          const c = toneColor[l.tone] || "var(--ink)";
          return (
            <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 7, marginBottom: 9, paddingBottom: 9, borderBottom: "1px solid var(--line)" }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: c, marginTop: 5, flexShrink: 0 }} />
              <span className="disp" style={{ fontSize: 14, fontWeight: 700, color: c, lineHeight: 1.25 }}>{l.x}</span>
            </div>
          );
        }
        if (l.kind === "stats") {
          return (
            <div key={i} style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 10 }}>
              {l.chips.map((ch, j) => (
                <span key={j} className="num" style={{ fontSize: 11, fontWeight: 600, background: "var(--panel2)", border: "1px solid var(--line)", borderRadius: 5, padding: "2px 7px", whiteSpace: "nowrap" }}>{ch}</span>
              ))}
            </div>
          );
        }
        const isNote = l.t === "Note";
        return (
          <div key={i} style={{ display: "flex", gap: 8, marginBottom: i < content.length - 1 ? 6 : 0 }}>
            <div className="disp" style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".07em", color: isNote ? "var(--mut)" : "var(--gold)", width: 64, flexShrink: 0, textAlign: "right", paddingTop: 1, lineHeight: 1.3 }}>{l.t}</div>
            <div style={{ fontSize: isNote ? 10.5 : 12, color: isNote ? "var(--mut)" : "var(--ink)", lineHeight: 1.4, flex: 1 }}>{l.x}</div>
          </div>
        );
      })}
    </>
  );
}

// Build a scannable, color-coded outlook for a completed pick on the draft board grid.
// `roster` = the players the drafting team already had BEFORE this pick (for need context).
// `req` = that team's starting requirement by position (from REQ_F / cfg.start).
function boardPickOutlook(p, o, cfg, ownerLabel, roster, req) {
  const out = [];
  const v = pickValue(p, o, cfg); // + = steal (fell past ADP), - = reach (taken early)
  const slip = Math.round((o + 1) - p.adp); // picks past ADP (positive = later than ADP)

  // 1) TAKE — color-coded value verdict.
  let take, tone;
  if (v > 3) { take = `Steal — fell ${Math.abs(slip)} picks past ADP.`; tone = "good"; }
  else if (v < -3) { take = `Reach — taken ${Math.abs(slip)} picks early.`; tone = "bad"; }
  else { take = `Fair value at market (ADP ${p.adp.toFixed(1)}).`; tone = "neutral"; }
  out.push({ kind: "take", tone, x: take });

  // 2) STAT STRIP
  out.push({ kind: "stats", chips: [`${p.pos}${p.posRank}`, `Tier ${p.tier}`, `${p.pts} pts`, `${p.vbd > 0 ? "+" : ""}${p.vbd.toFixed(0)} VBD`, `${v > 0 ? "+" : ""}${v} curve`] });

  // 3) PICK / PLAYER
  out.push({ t: "Pick", x: `${pickLabel(o)} — ${ownerLabel}` });
  out.push({ t: "Player", x: `${p.name} (${p.pos}${p.posRank}, overall Tier ${p.tier}).` });

  // 4) NEED — does it fit what the team needed? (only for real positional needs)
  if (roster && req) {
    const have = roster.filter((x) => x.pos === p.pos).length;
    const need = req[p.pos] || 0;
    let fit;
    if (p.pos === "QB" && !((cfg.start && cfg.start.SUPER) > 0) && have >= 1) fit = `Already set at QB — a backup/luxury more than a need.`;
    else if (need > 0 && have < need) fit = `Fills a need — they had ${have} of ${need} starting ${p.pos} slots.`;
    else if (have >= need && need > 0) fit = `Depth pick — starting ${p.pos} slots were already covered (${have}/${need}).`;
    else fit = `Adds ${p.pos} depth for flex/bench.`;
    out.push({ t: "Need", x: fit });
  }

  // 5) OUTLOOK — quick overall read combining value + need direction.
  let overall;
  if (v > 3) overall = `Good process: got a falling player below market.`;
  else if (v < -3) overall = roster && req && (req[p.pos] || 0) > roster.filter((x) => x.pos === p.pos).length ? `Aggressive, but it did plug a real need.` : `Early for the board — paid above the going rate.`;
  else overall = `Solid, on-market selection.`;
  out.push({ t: "Outlook", x: overall });
  return out;
}

/* ---------------- styles ---------------- */
const css = `
@import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Barlow:wght@400;500;600;700&display=swap');
.gs-root{--bg:#000000;--panel:#0C0C0E;--panel2:#070708;--line:#23231F;--ink:#F3F1E9;--mut:#8C8B82;--gold:#F2B63C;--gold2:#FFD071;--red:#F2655C;--green:#7CD9B2;--mono:'DM Mono','SF Mono',ui-monospace,monospace;
  background:var(--bg);color:var(--ink);font-family:'Barlow',system-ui,sans-serif;min-height:100vh;font-size:14px;}
.gs-root *{box-sizing:border-box}
.disp{font-family:'Barlow Condensed','Barlow',sans-serif;letter-spacing:.02em}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px}
.hairline{border-bottom:1px solid var(--line)} .mut{color:var(--mut)} .gold{color:var(--gold)}
.btn{background:var(--panel2);border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:6px 12px;cursor:pointer;font-family:'Barlow';font-size:13px;transition:border-color .15s,background .15s,transform .1s,box-shadow .15s}
.btn:hover{border-color:var(--gold);background:#15140d;transform:translateY(-1px);box-shadow:0 2px 10px #0006}
.btn:active{transform:translateY(0)}
.btn:focus-visible{outline:2px solid var(--gold);outline-offset:1px}
.btn-gold{background:var(--gold);color:#151002;border:none;font-weight:700}
.btn-gold:hover{filter:brightness(1.08);border-color:transparent;background:var(--gold2);box-shadow:0 3px 16px rgba(242,182,60,.4)}
.btn-mini{padding:2px 8px;font-size:11px;border-radius:6px}
.btn-mini:hover{transform:none;box-shadow:none}
.tab{padding:8px 14px;cursor:pointer;border:none;background:none;color:var(--mut);font-family:'Barlow Condensed';font-size:16px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;border-bottom:2px solid transparent;transition:color .15s,border-color .15s}
.tab:hover{color:var(--ink);border-bottom-color:#5a5a52}
.tab.on{color:var(--ink);border-bottom-color:var(--gold)}
.hubtile:hover{transform:translateY(-2px);border-color:var(--gold)!important;box-shadow:0 6px 20px #0008}
.flipcard{perspective:1000px;border:none;background:none;padding:0;cursor:pointer;font-family:inherit;color:var(--ink);height:148px}
.flipinner{position:relative;width:100%;height:100%;transition:transform .5s;transform-style:preserve-3d}
.flipcard:hover .flipinner,.flipcard:focus-visible .flipinner{transform:rotateY(180deg)}
.flipface{position:absolute;inset:0;backface-visibility:hidden;-webkit-backface-visibility:hidden;border:1px solid var(--line);border-radius:13px;overflow:hidden;display:flex;flex-direction:column}
.flipback{transform:rotateY(180deg);background:var(--panel);padding:15px;justify-content:center}
.bigact:hover{transform:translateY(-2px);box-shadow:0 8px 24px #0009}
.bigact{transition:transform .15s,box-shadow .15s,border-color .15s}
.dblsep{border:none;height:0;margin:0;border-top:2px solid var(--ink);border-bottom:2px solid var(--ink);padding:3px 0;opacity:.22}
.menuitem{transition:background .15s}
.hubsection{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:20px 20px 22px}
.menuitem:hover{background:rgba(214,170,75,0.14)!important;color:var(--gold)!important}
.menuitem:hover .disp{color:var(--gold)}
.posdot{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px;vertical-align:1px;flex-shrink:0}
.chip{display:inline-flex;align-items:center;gap:6px;background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:4px 8px;font-size:12px;white-space:nowrap}
.ticker{display:flex;gap:8px;overflow-x:auto;padding:10px 12px;scrollbar-width:thin;align-items:stretch}
.tickcard{min-width:118px;background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:8px 10px;flex-shrink:0}
.tickcard.you{border-color:var(--gold);background:#1A1505}
.tickcard.clock{border-color:#33476B;background:#0F1B30}
.meter{height:3px;background:var(--line);border-radius:2px;margin-top:6px;overflow:hidden}.meter>div{height:100%;background:var(--gold)}
table.board{width:100%;border-collapse:separate;border-spacing:0;font-size:13px}
table.board th{font-family:'Barlow Condensed';text-transform:uppercase;letter-spacing:.06em;font-size:12px;color:var(--mut);text-align:left;padding:8px 8px;border-bottom:2px solid var(--line);position:sticky;top:0;background:linear-gradient(180deg,var(--panel),var(--panel2));cursor:pointer;white-space:nowrap;z-index:2}
table.board th:hover{color:var(--ink)}
table.board td{padding:6px 8px;border-bottom:1px solid #16203320}
table.board tbody tr:nth-child(even) td{background:#10141b66}
table.board tbody tr:hover td{background:#1b2740aa}
table.board th.frz,table.board td.frz{position:sticky;left:0;z-index:3;background:var(--panel)}
table.board tbody tr:nth-child(even) td.frz{background:#0f131a}
table.board tbody tr:hover td.frz{background:#11161f}
table.board th.frz{z-index:4;box-shadow:1px 0 0 var(--line)}
table.board td.frz{box-shadow:1px 0 0 var(--line)}
table.board tbody tr td.frz{border-left:3px solid transparent}
.struck{opacity:.34;text-decoration:line-through}
.num{font-variant-numeric:tabular-nums}
.slotlbl{font-family:'Barlow Condensed';font-size:11px;letter-spacing:.08em;color:var(--mut);width:40px;display:inline-block}
.alert{border:1px solid var(--red);background:#2A1210;border-radius:8px;padding:8px 10px;color:#FFB4AC;font-size:13px}
input.gs,select.gs{background:var(--panel2);border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:8px 10px;font-family:'Barlow';font-size:13px}
input.gs:focus,select.gs:focus{outline:2px solid var(--gold);outline-offset:0}
.gridboard{display:grid;grid-template-columns:repeat(12,minmax(88px,1fr));gap:3px;font-size:11px}
.cell{border-radius:5px;padding:5px 6px;background:var(--panel2);border:1px solid var(--line);min-height:44px;cursor:default}
/* --- Sleeper-style draft board --- */
.boardwrap{position:relative;border:1px solid var(--line);border-radius:12px;overflow:auto;max-height:72vh;background:var(--panel)}
.bgrid{display:grid;gap:4px;padding:8px}
.bhead{position:sticky;top:0;z-index:5;display:grid;gap:4px;padding:8px 8px 6px;background:linear-gradient(180deg,var(--panel) 78%,transparent);backdrop-filter:blur(2px)}
.bteam{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;padding:7px 4px;border-radius:9px;background:var(--panel2);border:1px solid var(--line);min-height:42px;text-align:center}
.bteam.you{background:linear-gradient(180deg,rgba(242,182,60,.18),rgba(242,182,60,.05));border-color:var(--gold)}
.bteam .nm{font-size:11px;font-weight:700;line-height:1.1;letter-spacing:.02em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.bteam .sub{font-size:8.5px;letter-spacing:.08em;text-transform:uppercase}
.bcell{position:relative;border-radius:9px;padding:6px 7px;background:var(--panel2);border:1px solid var(--line);min-height:48px;display:flex;flex-direction:column;gap:1px;cursor:default;transition:transform .1s,border-color .1s}
.bcell:hover{transform:translateY(-1px);border-color:#4a4a3c}
.bcell.you{background:linear-gradient(180deg,rgba(242,182,60,.13),rgba(242,182,60,.03));border-color:rgba(242,182,60,.55)}
.bcell.you.oncl{border-color:var(--gold);box-shadow:0 0 0 1px var(--gold) inset}
.bcell.upcoming{border-style:dashed;border-color:rgba(242,182,60,.6)}
.bcell.empty{opacity:.4}
.bcell .pl{font-size:10px;font-weight:600;line-height:1.12;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.bcell .lbl{font-size:9px;display:flex;align-items:center;gap:3px;opacity:.85}
.bcell .posdot{display:inline-block;width:14px;text-align:center;font-size:8px;font-weight:800;border-radius:3px;padding:0 2px;color:#0a0a0a}
.bcell .val{font-size:9px;font-weight:700;margin-top:1px}
/* --- Availability tab (modern) --- */
.availrow{display:grid;align-items:center;gap:10px;padding:9px 12px;border-radius:11px;background:var(--panel2);border:1px solid var(--line);transition:border-color .12s,transform .1s}
.availrow:hover{border-color:#4a4a3c;transform:translateY(-1px)}
.availrow .pname{font-weight:700;font-size:13.5px}
.availpct{position:relative;height:30px;border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;font-variant-numeric:tabular-nums;overflow:hidden;border:1px solid var(--line)}
.availpct .fill{position:absolute;left:0;top:0;bottom:0;border-radius:6px 0 0 6px;opacity:.34}
.availpct .txt{position:relative;z-index:1}
.availhead{display:grid;gap:10px;padding:6px 12px;font-size:9.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--mut);font-weight:700}
.posbadge{display:inline-flex;align-items:center;justify-content:center;min-width:30px;height:20px;border-radius:5px;font-size:9.5px;font-weight:800;color:#0a0a0a}
.tooltip{position:fixed;z-index:90;width:300px;max-width:300px;background:#0A0A0C;border:1px solid #3A3A30;border-radius:10px;padding:12px 13px;font-size:12.5px;line-height:1.5;pointer-events:none;box-shadow:0 12px 40px #000D}
.needcell{text-align:center;border-radius:5px;padding:3px 0;font-size:12px}
.info{cursor:help;border-bottom:1px dotted var(--mut)}
.hero-h{font-size:58px;font-weight:700;line-height:1.0}
.feature{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px;transition:border-color .18s, transform .18s, background .18s;cursor:default}
.feature:hover{border-color:var(--gold);transform:translateY(-3px);background:#121210}
.showcase{background:linear-gradient(165deg,#13130D,#0B0B08);border:1px solid #2A2A20;border-radius:14px;padding:18px;transition:border-color .2s,transform .2s,box-shadow .2s;cursor:default}
.showcase:hover{border-color:var(--gold);transform:translateY(-4px);box-shadow:0 14px 40px rgba(242,182,60,.10)}
.showcase-badge{display:inline-flex;align-items:center;gap:6px;font-family:'Barlow Condensed';text-transform:uppercase;letter-spacing:.1em;font-size:10.5px;font-weight:700;color:var(--gold);background:#1A1505;border:1px solid #4A3A12;border-radius:99px;padding:4px 11px}
.showcase-badge i{font-size:13px}
.modalbg{position:fixed;inset:0;background:#000C;display:flex;align-items:center;justify-content:center;z-index:60;padding:16px}
.statline{font-family:'Barlow Condensed';font-size:38px;font-weight:700;color:var(--gold)}
.spin-slow{animation:spin 22s linear infinite;transform-origin:50% 50%}
.spin-needle{transform-origin:50% 50%;transition:transform 1.1s cubic-bezier(.34,1.56,.64,1)}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes pulseGold{0%,100%{opacity:.5}50%{opacity:1}}
.glowline{background:linear-gradient(90deg,transparent,var(--gold),transparent);height:1px;opacity:.5}
.hover-row{transition:background .12s}.hover-row:hover{background:#16160F}
@media(max-width:980px){.cols{flex-direction:column}.rail{width:100%!important}.hero-h{font-size:38px}}
@media(max-width:640px){
  .hero-h{font-size:30px!important}
  .statline{font-size:30px}
  /* draft-room tab bar scrolls horizontally instead of wrapping/squishing */
  .tabbar{overflow-x:auto;-webkit-overflow-scrolling:touch;flex-wrap:nowrap!important;scrollbar-width:none}
  .tabbar::-webkit-scrollbar{display:none}
  .tab{white-space:nowrap;flex:0 0 auto}
  /* wide tables scroll inside their panel rather than blowing out the page */
  .tablewrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
  /* collapse the ADP-intel / trade two-column layouts to one column on phones */
  .adp-grid{grid-template-columns:1fr!important}
  .adp-grid .adp-list{max-height:200px!important}
  /* comfortable tap targets */
  .btn,.btn-mini{min-height:38px}
  .menuitem{min-height:44px}
  /* tighten page gutters */
  .gs-pad{padding-left:14px!important;padding-right:14px!important}
  /* header button labels: keep them from overflowing */
  .appheader{flex-wrap:wrap;row-gap:6px}
}
@media(prefers-reduced-motion:reduce){.gs-root *{transition:none!important;animation:none!important}}
`;

// Compass mark — the brand. Spins slowly; the needle can point to a heading (degrees).
function Compass({ size = 40, heading = null, spin = false }) {
  // "The Instrument" — premium engraved navigational mark.
  // Engraved double ring, finely graduated rim (the thousands of drafts/data points the
  // engine reads), a center rose built from football laces, and a sharp dual needle.
  const ticks = [];
  for (let i = 0; i < 36; i++) {
    const a = (i * 10 * Math.PI) / 180;
    const cardinal = i % 9 === 0;
    const r1 = cardinal ? 40 : 41, r2 = cardinal ? 33 : 36;
    ticks.push(
      <line key={i}
        x1={50 + r1 * Math.sin(a)} y1={50 - r1 * Math.cos(a)}
        x2={50 + r2 * Math.sin(a)} y2={50 - r2 * Math.cos(a)}
        stroke={cardinal ? "var(--gold)" : "#4a4a44"} strokeWidth={cardinal ? 1.4 : 0.6} />
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" style={{ display: "block" }}>
      <circle cx="50" cy="50" r="46" fill="none" stroke="#9a9488" strokeWidth="1" opacity="0.85" />
      <circle cx="50" cy="50" r="42" fill="none" stroke="var(--gold)" strokeWidth="0.9" opacity="0.85" />
      <g className={spin ? "spin-slow" : ""}>{ticks}</g>
      {/* football-lace rose at center */}
      <g stroke="var(--gold)" strokeWidth="1.1" fill="none" opacity="0.92">
        <line x1="50" y1="30" x2="50" y2="70" />
        <line x1="46" y1="37" x2="54" y2="37" /><line x1="45" y1="45" x2="55" y2="45" />
        <line x1="45" y1="55" x2="55" y2="55" /><line x1="46" y1="63" x2="54" y2="63" />
      </g>
      {/* sharp dual needle (points to heading when provided) */}
      <g className={heading == null ? "spin-needle" : ""} style={{ transform: heading != null ? `rotate(${heading}deg)` : undefined, transformOrigin: "50px 50px" }}>
        <polygon points="50,23 53,50 47,50" fill="var(--gold2,#f0c560)" />
        <polygon points="50,77 53,50 47,50" fill="#46463f" />
      </g>
      <circle cx="50" cy="50" r="3.6" fill="#000" stroke="var(--gold)" strokeWidth="1.2" />
    </svg>
  );
}
function Wordmark({ size = 20 }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 9 }}>
      <Compass size={size + 8} spin />
      <span className="disp" style={{ fontSize: size, fontWeight: 700, letterSpacing: ".01em" }}>
        FANTASY DRAFT <span className="gold">COMPASS</span>
      </span>
    </span>
  );
}
const Dot = ({ pos }) => <span className="posdot" title={pos} style={{ background: POS_COLOR[pos] }} />;
const PosName = ({ p }) => <span><Dot pos={p.pos} /><span className="mut" style={{ fontSize: "0.92em" }}>{p.pos}</span> <b>{p.name}</b></span>;

/* ============================================================ APP SHELL */
export default function App() {
  const [route, setRoute] = useState("home"); // home | checkout | library | setup | draft | admin
  const [user, setUser] = useState(null); // {email, paid, admin}
  const [authOpen, setAuthOpen] = useState(false);
  const [authError, setAuthError] = useState(null);
  const [leagues, setLeagues] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [draftTab, setDraftTab] = useState(null); // optional tab to open the draft room on
  const [helpTab, setHelpTab] = useState(null); // optional tab to open Help on
  const [setupReturn, setSetupReturn] = useState(null); // where the New League flow should return to
  const [biz, setBiz] = useState({ price: 19.99, promos: [] });
  const [loaded, setLoaded] = useState(false);
  const [dataVersion, setDataVersion] = useState(0); // bumps when live player data loads, to refresh boards
  const [demoLeague, setDemoLeague] = useState(null); // unsaved demo draft from homepage
  const [mockLeague, setMockLeague] = useState(null); // transient mock draft running against a saved league
  const [quickMockOpen, setQuickMockOpen] = useState(false); // quick-mock pre-draft prompt
  const [funMocks, setFunMocks] = useState([]); // standalone mocks not tied to a league
  const [feedback, setFeedback] = useState([]); // user-submitted feedback {id,email,topic,msg,ts,status,reply}

  useEffect(() => {
    (async () => {
      try {
        if (window.storage) {
          try { const r = await window.storage.get("gs-state"); if (r && r.value) { const d = JSON.parse(r.value); if (d.leagues) setLeagues(d.leagues); if (d.biz) setBiz(d.biz); if (d.user) { const comped = !!compFor(d.biz, d.user.email); setUser(migrateRankSets({ ...d.user, admin: isAdminEmail(d.user.email), paid: d.user.paid || comped, comp: comped })); } if (d.funMocks) setFunMocks(d.funMocks); if (d.feedback) setFeedback(d.feedback); } } catch (e) {}
        }
        // Backend mode: restore the real session from the token, and handle a Stripe return.
        if (hasBackend) {
          // Load the live player pack (real teams, projections, injuries, ADP) and feed the engine.
          try {
            const pack = await api.playerPack("PPR|1QB|STD|REDRAFT|12", undefined);
            if (applyLivePack(pack)) setDataVersion((v) => v + 1);
          } catch (e) { /* fall back to built-in dataset if unavailable */ }
          try {
            const me = await api.me();
            if (me) { const admin = isAdminEmail(me.email); const merged = migrateRankSets({ ...me, rankSets: me.rankSets || [], admin, paid: me.paid || admin }); setUser(merged); persist({ user: merged }); }
          } catch (e) {}
          try {
            const params = new URLSearchParams(window.location.search);
            if (params.get("paid") === "1") {
              const me = await api.me();
              if (me) { const admin = isAdminEmail(me.email); setUser(migrateRankSets({ ...me, rankSets: me.rankSets || [], admin, paid: me.paid || admin })); }
              window.history.replaceState({}, "", window.location.pathname); // clean the URL
              setRoute("home");
            }
          } catch (e) {}
        }
      } catch (e) {}
      setLoaded(true);
    })();
  }, []);

  // Ensure a mobile viewport meta exists (so the app scales correctly on phones in any host,
  // including a standalone deploy). Harmless if one is already present.
  useEffect(() => {
    try {
      if (typeof document !== "undefined" && !document.querySelector('meta[name="viewport"]')) {
        const m = document.createElement("meta");
        m.name = "viewport";
        m.content = "width=device-width, initial-scale=1, viewport-fit=cover";
        document.head.appendChild(m);
      }
    } catch (e) {}
  }, []);

  // Every route change starts at the top so the site header is in view (no landing mid-page).
  useEffect(() => {
    try {
      window.scrollTo(0, 0);
      if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
    } catch (e) {}
  }, [route]);

  const persist = async (next) => {
    try { if (window.storage) await window.storage.set("gs-state", JSON.stringify({ leagues: next.leagues ?? leagues, user: next.user ?? user, biz: next.biz ?? biz, funMocks: next.funMocks ?? funMocks, feedback: next.feedback ?? feedback })); } catch (e) {}
    // In backend mode, also save the user's personal ranking sets server-side so they survive a
    // refresh (the local storage copy would otherwise be overwritten by api.me() on reload).
    try {
      if (hasBackend && next.user && Array.isArray(next.user.rankSets)) {
        await api.saveRankSets(next.user.rankSets);
      }
    } catch (e) { /* keep local copy; will retry on next change */ }
  };

  const signUp = async (email, password, mode = "signup") => {
    // Backend mode: real accounts. Falls back to local simulated accounts when no backend.
    if (hasBackend) {
      try {
        const u = mode === "signup" ? await api.signup(email, password) : await api.signin(email, password);
        setAuthError(null);
        const admin = isAdminEmail(u.email || email);
        const merged = migrateRankSets({ ...u, rankSets: u.rankSets || [], admin, paid: u.paid || admin });
        setUser(merged); persist({ user: merged });
        return merged;
      } catch (e) {
        setAuthError(e.message === "NO_BACKEND" ? "Backend not reachable" : (e.data?.error || e.message || "Sign-in failed"));
        throw e;
      }
    }
    const comped = !!compFor(biz, email);
    const admin = isAdminEmail(email);
    const u = { email, paid: comped || admin, comp: comped, admin, rankSets: [], season: CURRENT_SEASON };
    setUser(u); persist({ user: u });
    return u;
  };
  const completePurchase = async () => {
    if (hasBackend) {
      // Real payment: send the user to Stripe Checkout. On return (?paid=1) we refresh from the API.
      try { const url = await api.startCheckout(); if (url) { window.location.href = url; return; } }
      catch (e) { /* fall through to local grant if checkout can't start */ }
    }
    const u = { ...user, paid: true }; setUser(u); persist({ user: u }); setRoute("home");
  };
  // Admin: grant a free comp subscription to an email (season or forever), or revoke it.
  const grantComp = (email, scope) => {
    const e = String(email).trim().toLowerCase();
    if (!e) return;
    const others = (biz.comps || []).filter((c) => c.email.toLowerCase() !== e);
    const comp = { email: e, scope, season: scope === "season" ? CURRENT_SEASON : null, granted: new Date().toLocaleDateString(), revoked: false };
    const b = { ...biz, comps: [comp, ...others] };
    setBiz(b);
    // if the comp targets the currently signed-in user, flip them to paid immediately
    let nextUser = user;
    if (user && user.email && user.email.toLowerCase() === e) { nextUser = { ...user, paid: true, comp: true }; setUser(nextUser); }
    persist({ biz: b, user: nextUser });
  };
  const revokeComp = (email) => {
    const e = String(email).trim().toLowerCase();
    const comps = (biz.comps || []).map((c) => c.email.toLowerCase() === e ? { ...c, revoked: true } : c);
    const b = { ...biz, comps };
    setBiz(b);
    let nextUser = user;
    // only downgrade the live user if their paid status came from a comp (not a real purchase)
    if (user && user.email && user.email.toLowerCase() === e && user.comp) { nextUser = { ...user, paid: false, comp: false }; setUser(nextUser); }
    persist({ biz: b, user: nextUser });
  };
  const signOut = () => { try { setToken(null); } catch (e) {} setUser(null); persist({ user: null }); setRoute("home"); };

  const createLeague = (cfg) => {
    const lg = { id: Date.now(), name: cfg.name, cfg, picks: [], preds: [], created: new Date().toLocaleDateString() };
    const next = [...leagues, lg];
    setLeagues(next); persist({ leagues: next });
    setActiveId(lg.id); setRoute("draft");
  };
  const saveLeague = (id, picks, preds) => {
    const next = leagues.map((l) => (l.id === id ? { ...l, picks, preds } : l));
    setLeagues(next); persist({ leagues: next });
  };
  const updateLeagueCfg = (id, cfg) => {
    if (id === "demo") { setDemoLeague((d) => ({ ...d, name: cfg.name, cfg })); return; }
    const next = leagues.map((l) => (l.id === id ? { ...l, name: cfg.name, cfg } : l));
    setLeagues(next); persist({ leagues: next });
  };
  const deleteLeague = (id) => { const next = leagues.filter((l) => l.id !== id); setLeagues(next); persist({ leagues: next }); };
  const updateUser = (patch) => { const merged = { ...user, ...patch }; const u = { ...merged, admin: isAdminEmail(merged.email) }; setUser(u); persist({ user: u }); };

  const startDemo = () => {
    setDemoLeague({ id: "demo", demo: true, name: "Free demo draft", cfg: { name: "Free demo draft", type: "redraft", teams: 12, rounds: 15, demoRounds: 3, slot: 5, sf: false, tePrem: false, tePremMult: 0, caps: {}, start: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, SUPER: 0, DST: 0, K: 0 }, demo: true }, picks: [], preds: [] });
    setRoute("draft"); setActiveId("demo");
  };

  // Run a mock draft against a saved league's exact settings, tracked separately from the
  // league's real draft. The result snapshots into that league's `mocks` history (last 50).
  const startMock = (leagueId) => {
    const lg = leagues.find((l) => l.id === leagueId);
    if (!lg) return;
    const mockId = `mock-${Date.now()}`;
    // If the league has a set draft order (or a fixed slot), the mock inherits it.
    // If not, randomize the user's slot for this mock so trends can compare draft positions.
    const orderSet = Array.isArray(lg.cfg.draftOrder) && lg.cfg.draftOrder.length === (lg.cfg.teams || 12);
    let mcfg = lg.cfg;
    if (!orderSet && (lg.cfg.slot == null)) {
      const randSlot = Math.floor(Math.random() * (lg.cfg.teams || 12)) + 1;
      mcfg = { ...lg.cfg, slot: randSlot, slotRandomized: true };
    }
    setMockLeague({ id: mockId, mockOf: leagueId, name: `${lg.name} — mock`, cfg: mcfg, picks: [], preds: [] });
    setDraftTab(null); setActiveId(mockId); setRoute("draft");
  };
  const saveMock = (picks, preds) => {
    if (!mockLeague) return;
    const entry = { id: mockLeague.id, picks, preds, ran: new Date().toLocaleString(), n: picks.length };
    if (mockLeague.mockOf == null) {
      // standalone "fun" mock — store in the global funMocks list, not under a league
      const e2 = { ...entry, name: mockLeague.name, cfg: mockLeague.cfg };
      const next = [e2, ...funMocks.filter((m) => m.id !== entry.id)].slice(0, 50);
      setFunMocks(next); persist({ funMocks: next });
      return;
    }
    const next = leagues.map((l) => {
      if (l.id !== mockLeague.mockOf) return l;
      const existing = (l.mocks || []).filter((m) => m.id !== entry.id);
      return { ...l, mocks: [entry, ...existing].slice(0, 50) }; // newest first, cap 50
    });
    setLeagues(next); persist({ leagues: next });
  };
  // Standalone mock not tied to any league — quick simple defaults or a fully custom cfg.
  const startQuickMock = (cfg) => {
    const c = cfg || { name: "Quick mock", type: "redraft", teams: 12, rounds: 15, slot: 6, sf: false, tePrem: false, tePremMult: 0, caps: {}, start: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, SUPER: 0, DST: 0, K: 0 } };
    const id = `fun-${Date.now()}`;
    setMockLeague({ id, mockOf: null, name: c.name || "Quick mock", cfg: c, picks: [], preds: [] });
    setActiveId(id); setRoute("draft");
  };
  const deleteFunMock = (id) => { const next = funMocks.filter((m) => m.id !== id); setFunMocks(next); persist({ funMocks: next }); };

  const submitFeedback = async (entry) => {
    // Send to the backend so it lands in the admin inbox. Falls back to local storage if no backend.
    if (hasBackend) {
      try {
        await api.submitFeedback({ email: entry.email || (user && user.email) || null, category: (entry.topic || "other").toLowerCase(), message: entry.msg });
        return;
      } catch (e) { /* fall through to local */ }
    }
    const e = { id: `fb-${Date.now()}`, email: entry.email, topic: entry.topic || "General", msg: entry.msg, ts: new Date().toLocaleString(), status: "new", reply: null };
    const next = [e, ...feedback].slice(0, 500);
    setFeedback(next); persist({ feedback: next });
  };
  const respondFeedback = (id, reply) => {
    const next = feedback.map((f) => (f.id === id ? { ...f, reply, status: "answered", repliedAt: new Date().toLocaleString() } : f));
    setFeedback(next); persist({ feedback: next });
  };
  const deleteFeedback = (id) => { const next = feedback.filter((f) => f.id !== id); setFeedback(next); persist({ feedback: next }); };
  const deleteMock = (leagueId, mockId) => {
    const next = leagues.map((l) => (l.id === leagueId ? { ...l, mocks: (l.mocks || []).filter((m) => m.id !== mockId) } : l));
    setLeagues(next); persist({ leagues: next });
  };

  const active = activeId === "demo" ? demoLeague : (mockLeague && activeId === mockLeague.id) ? mockLeague : leagues.find((l) => l.id === activeId);

  if (!loaded) return <div className="gs-root" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}><style>{css}</style><div className="mut">Loading…</div></div>;

  return (
    <div className="gs-root">
      <style>{css}</style>
      {route === "home" && user?.paid && <PaidHub user={user} leagues={leagues} funMocks={funMocks}
        onLibrary={() => setRoute("library")} onNewLeague={() => { setSetupReturn(null); setRoute("setup"); }} onDatabase={() => setRoute("database")}
        onOfficial={(id) => { setActiveId(id); setRoute("draft"); }} onMock={startMock} onQuickMock={() => setQuickMockOpen(true)}
        onTrends={() => setRoute("trends")} onHelp={() => { setHelpTab(null); setRoute("help"); }} onGuide={() => { setHelpTab("guide"); setRoute("help"); }} onAccount={() => setRoute("account")} onAdmin={() => setRoute("admin")} onSignOut={signOut}
        onUmbrella={(id) => { setActiveId(id); setRoute("leagueHub"); }} onRankings={() => setRoute("rankings")} onTrendsTime={() => setRoute("trendsTime")} onTradeTools={() => setRoute("tradeTools")} onAdpIntel={() => setRoute("adpIntel")} onDelete={deleteLeague} />}
      {route === "leagueHub" && user && (() => { const lg = leagues.find((l) => l.id === activeId); return lg ? <LeagueUmbrella user={user} league={lg} onSignOut={signOut} onHome={() => setRoute("home")} onBack={() => setRoute(user.paid ? "home" : "library")}
        onOfficial={(id) => { setDraftTab(null); setActiveId(id); setRoute("draft"); }} onMock={startMock} onSettings={(id) => { setDraftTab("settings"); setActiveId(id); setRoute("draft"); }}
        onViewMock={(leagueId, m) => { const l2 = leagues.find((x) => x.id === leagueId); if (!l2) return; setMockLeague({ id: m.id, mockOf: leagueId, name: `${l2.name} — mock`, cfg: l2.cfg, picks: m.picks || [], preds: m.preds || [] }); setActiveId(m.id); setRoute("draft"); }}
        onDeleteMock={deleteMock} onDelete={(id) => { deleteLeague(id); setRoute(user.paid ? "home" : "library"); }} /> : null; })()}
      {route === "home" && !user?.paid && <HomePage biz={biz} user={user} onSignIn={() => setAuthOpen(true)} onDemo={startDemo} onBuy={() => (user ? setRoute("checkout") : setAuthOpen(true))} onApp={() => setRoute("library")} onHelp={(t) => { setHelpTab(t || null); setRoute("help"); }} />}
      {route === "learn" && <HomePage biz={biz} user={user} onSignIn={() => setAuthOpen(true)} onDemo={startDemo} onBuy={() => (user ? setRoute("checkout") : setAuthOpen(true))} onApp={() => setRoute(user?.paid ? "home" : "library")} onHelp={(t) => { setHelpTab(t || null); setRoute("help"); }} initialTab="how" />}
      {route === "trends" && user && <TrendsPage user={user} onSignOut={signOut} onHome={() => setRoute("home")} onBack={() => setRoute(user?.paid ? "home" : "library")} />}
      {route === "help" && <HelpPage user={user} biz={biz} onSignOut={signOut} onHome={() => setRoute("home")} onBack={() => setRoute(user ? (user.paid ? "home" : "library") : "home")} onSubmit={submitFeedback} initialTab={helpTab} />}
      {route === "checkout" && user && <Checkout biz={biz} user={user} onDone={completePurchase} onBack={() => setRoute("home")} />}
      {route === "library" && user && <Library user={user} leagues={leagues} onNew={() => setRoute("setup")} onUmbrella={(id) => { setActiveId(id); setRoute("leagueHub"); }} onDelete={deleteLeague} onAdmin={() => setRoute("admin")} onSignOut={signOut} onHome={() => setRoute("home")} onAccount={() => setRoute("account")} onDeleteMock={deleteMock} onOpenMockView={(leagueId, m) => { const lg = leagues.find((l) => l.id === leagueId); if (!lg) return; setMockLeague({ id: m.id, mockOf: leagueId, name: `${lg.name} — mock`, cfg: lg.cfg, picks: m.picks || [], preds: m.preds || [] }); setActiveId(m.id); setRoute("draft"); }} onQuickMock={() => setQuickMockOpen(true)} onDatabase={() => setRoute("database")} onTrends={() => setRoute("trends")} onHelp={() => { setHelpTab(null); setRoute("help"); }} funMockCount={funMocks.length} />}
      {route === "database" && user && <DraftsDatabase leagues={leagues} funMocks={funMocks} user={user} onSignOut={signOut} onHome={() => setRoute("home")} onBack={() => setRoute(user.paid ? "home" : "library")}
        onOpenLeague={(id) => { setActiveId(id); setRoute("draft"); }}
        onOpenMock={(leagueId, m) => { const lg = leagues.find((l) => l.id === leagueId); if (!lg) return; setMockLeague({ id: m.id, mockOf: leagueId, name: `${lg.name} — mock`, cfg: lg.cfg, picks: m.picks || [], preds: m.preds || [] }); setActiveId(m.id); setRoute("draft"); }}
        onOpenFun={(m) => { setMockLeague({ id: m.id, mockOf: null, name: m.name || "Quick mock", cfg: m.cfg, picks: m.picks || [], preds: m.preds || [] }); setActiveId(m.id); setRoute("draft"); }} onQuickMock={() => setQuickMockOpen(true)} onTrendsTime={() => setRoute("trendsTime")} onDelete={deleteLeague} />}
      {route === "trendsTime" && user && <TrendsOverTimePage user={user} leagues={leagues} funMocks={funMocks} onSignOut={signOut} onHome={() => setRoute("home")} onBack={() => setRoute(user.paid ? "home" : "library")} onOpenLeague={(id) => { setActiveId(id); setRoute("leagueHub"); }} />}
      {route === "tradeTools" && user && <TradeToolsPage user={user} onSignOut={signOut} onHome={() => setRoute("home")} onBack={() => setRoute(user.paid ? "home" : "library")} />}
      {route === "adpIntel" && user && <AdpIntelPage user={user} onSignOut={signOut} onHome={() => setRoute("home")} onBack={() => setRoute(user.paid ? "home" : "library")} />}
      {route === "account" && user && <Account user={user} onUpdate={updateUser} onBack={() => setRoute(user.paid ? "home" : "library")} onHome={() => setRoute("home")} onSignOut={signOut} onRankings={() => setRoute("rankings")} />}
      {route === "rankings" && user && <RankingsHub user={user} leagues={leagues} onUpdate={updateUser} onSignOut={signOut} onHome={() => setRoute("home")} onBack={() => setRoute(user.paid ? "home" : "library")} onNewLeague={() => { setSetupReturn("rankings"); setRoute("setup"); }} />}
      {route === "setup" && <Setup onCreate={createLeague} onBack={() => { const r = setupReturn || (user?.paid ? "home" : "library"); setSetupReturn(null); setRoute(r); }} backLabel={setupReturn === "rankings" ? "Rankings" : user?.paid ? "Home" : "Library"} />}
      {route === "draft" && active && (
        <DraftRoom key={active.id} league={active} user={user} isMock={!!(mockLeague && active.id === mockLeague.id)} isDemo={!!active.demo} initialTab={draftTab}
          onSave={(picks, preds) => {
            if (active.id === "demo") setDemoLeague((d) => ({ ...d, picks, preds }));
            else if (mockLeague && active.id === mockLeague.id) { setMockLeague((m) => ({ ...m, picks, preds })); saveMock(picks, preds); }
            else saveLeague(active.id, picks, preds);
          }}
          onExit={() => { if (mockLeague && active.id === mockLeague.id) setMockLeague(null); setDraftTab(null); setRoute(user ? (user.paid ? "home" : "library") : "home"); }}
          onSettings={(cfg) => { if (active.id === "demo") setDemoLeague((d) => ({ ...d, cfg })); else if (mockLeague && active.id === mockLeague.id) setMockLeague((m) => ({ ...m, cfg })); else updateLeagueCfg(active.id, cfg); }}
          onEditRanks={() => { if (mockLeague && active.id === mockLeague.id) setMockLeague(null); setDraftTab(null); setRoute("rankings"); }}
          onUseRankSet={(setId, lgId) => { if (!user) return; const next = (user.rankSets || []).map((rs) => rs.id === setId ? { ...rs, leagueId: lgId } : rs); updateUser({ rankSets: next }); }}
          onColPrefs={(prefs) => { if (user) updateUser({ colPrefs: prefs }); }}
          onBuy={() => { if (!user) setAuthOpen(true); else setRoute("checkout"); }} />
      )}
      {route === "admin" && user && isAdminEmail(user.email) && <Admin biz={biz} setBiz={(b) => { setBiz(b); persist({ biz: b }); }} user={user} leagues={leagues} feedback={feedback} onRespond={respondFeedback} onDeleteFeedback={deleteFeedback} onGrantComp={grantComp} onRevokeComp={revokeComp} onBack={() => setRoute("library")} />}
      {quickMockOpen && <QuickMockSetup onCancel={() => setQuickMockOpen(false)} onStart={(cfg) => { setQuickMockOpen(false); startQuickMock(cfg); }} />}
      {authOpen && <AuthModal hasBackend={hasBackend} authError={authError} onClose={() => { setAuthOpen(false); setAuthError(null); }} onSignUp={async (email, password, mode) => {
        try {
          const u = await signUp(email, password, mode);
          setAuthOpen(false); setAuthError(null);
          setRoute(u && u.paid ? "home" : "checkout");
        } catch (e) { /* error shown in modal */ }
      }} />}
    </div>
  );
}

/* ============================================================ HOMEPAGE */
// Small step illustrations for the Quick-Start Guide — one per home "Get started" step.
function GuideGraphic({ kind }) {
  const g = "var(--gold)";
  const box = { width: "100%", height: 96, display: "block" };
  if (kind === "rankings") return (
    <svg viewBox="0 0 240 96" style={box} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (<g key={i}><rect x="20" y={12 + i * 19} width="16" height="14" rx="3" fill={g} opacity={1 - i * 0.18} /><text x="28" y={23 + i * 19} fontSize="9" fontWeight="700" fill="#1A1505" textAnchor="middle" fontFamily="var(--mono)">{i + 1}</text><rect x="44" y={12 + i * 19} width={150 - i * 26} height="14" rx="4" fill="var(--panel2)" /><i /><rect x={200} y={14 + i * 19} width="20" height="10" rx="3" fill="none" stroke={g} strokeWidth="1" opacity="0.55" /></g>))}
    </svg>
  );
  if (kind === "create") return (
    <svg viewBox="0 0 240 96" style={box} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      {["ESPN", "Sleeper", "Yahoo"].map((t, i) => (<g key={i}><rect x={18 + i * 52} y="20" width="46" height="24" rx="6" fill="var(--panel2)" stroke="var(--line)" strokeWidth="1" /><text x={41 + i * 52} y="35" fontSize="8.5" fill="var(--mut)" textAnchor="middle" fontFamily="var(--mono)">{t}</text></g>))}
      <path d="M120 52 v10 M120 62 h-44 M120 62 h44 M76 62 v8 M164 62 v8 M120 62 v8" stroke={g} strokeWidth="1.5" fill="none" opacity="0.6" />
      <rect x="86" y="70" width="68" height="20" rx="6" fill={g} /><text x="120" y="83" fontSize="9" fontWeight="700" fill="#1A1505" textAnchor="middle">Your league</text>
    </svg>
  );
  if (kind === "open") return (
    <svg viewBox="0 0 240 96" style={box} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      {[0, 1, 2].map((i) => (<g key={i}><rect x="20" y={12 + i * 26} width="200" height="20" rx="6" fill="var(--panel2)" stroke={i === 0 ? g : "var(--line)"} strokeWidth={i === 0 ? 1.5 : 1} /><circle cx="33" cy={22 + i * 26} r="5" fill={i === 0 ? "var(--green)" : g} opacity={i === 0 ? 1 : 0.5} /><rect x="44" y={18 + i * 26} width={90 - i * 14} height="8" rx="4" fill="var(--line)" /><text x="210" y={25 + i * 26} fontSize="8" fill={g} textAnchor="end">{i === 0 ? "Open →" : ""}</text></g>))}
    </svg>
  );
  if (kind === "mock") return (
    <svg viewBox="0 0 240 96" style={box} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <polyline points="20,72 60,58 100,64 140,40 180,46 220,24" fill="none" stroke={g} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      {[[20, 72], [60, 58], [100, 64], [140, 40], [180, 46], [220, 24]].map(([x, y], i) => (<circle key={i} cx={x} cy={y} r="3.5" fill={g} />))}
      <line x1="20" y1="84" x2="220" y2="84" stroke="var(--line)" strokeWidth="1" />
      <text x="20" y="14" fontSize="8" fill="var(--mut)" fontFamily="var(--mono)">your reps → sharper read</text>
    </svg>
  );
  if (kind === "draft") return (
    <svg viewBox="0 0 240 96" style={box} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      {[["#4FD1A1", 0, "Top pick"], ["#5BA8F5", 1, ""], ["#F2A35C", 2, ""]].map(([c, i, tag], k) => (<g key={k}><rect x="20" y={14 + i * 24} width="200" height="18" rx="5" fill="var(--panel2)" /><circle cx="32" cy={23 + i * 24} r="4" fill={c} />{tag ? <><rect x="150" y={17 + i * 24} width="44" height="12" rx="4" fill="none" stroke={g} strokeWidth="1" /><text x="172" y={26 + i * 24} fontSize="7" fill={g} textAnchor="middle">{tag}</text></> : null}<rect x="44" y={19 + i * 24} width={80} height="8" rx="4" fill="var(--line)" /></g>))}
      <circle cx="208" cy="78" r="11" fill="none" stroke={g} strokeWidth="2" /><polygon points="208,71 211,80 208,77 205,80" fill={g} />
    </svg>
  );
  return null;
}

// Illustrations for the "Why It's Worth It" value props.
function WhyGraphic({ kind }) {
  const g = "var(--gold)";
  const box = { width: "100%", height: 84, display: "block" };
  if (kind === "live") return ( // compass vs frozen sheet
    <svg viewBox="0 0 220 84" style={box} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <g opacity="0.5"><rect x="14" y="16" width="70" height="54" rx="5" fill="none" stroke="var(--mut)" strokeWidth="1.5" />{[0,1,2,3].map(i=>(<rect key={i} x="22" y={24+i*11} width="54" height="5" rx="2.5" fill="var(--mut)" />))}<line x1="18" y1="14" x2="80" y2="72" stroke="var(--red)" strokeWidth="2" /></g>
      <text x="104" y="46" fontSize="13" fill="var(--mut)" textAnchor="middle">vs</text>
      <circle cx="166" cy="43" r="26" fill="none" stroke={g} strokeWidth="2" /><circle cx="166" cy="43" r="26" fill="none" stroke={g} strokeWidth="2.5" strokeDasharray="30 200" strokeLinecap="round" transform="rotate(-60 166 43)" /><polygon points="166,24 173,47 166,41 159,47" fill={g} /><circle cx="166" cy="43" r="3" fill={g} />
    </svg>
  );
  if (kind === "format") return ( // many drafts → your board
    <svg viewBox="0 0 220 84" style={box} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      {[0,1,2,3,4].map(i=>(<rect key={i} x={18+i*9} y={14+i*3} width="48" height="34" rx="4" fill="var(--panel2)" stroke="var(--line)" strokeWidth="1" opacity={0.4+i*0.12} />))}
      <path d="M76 40 h26 m0 0 l-6 -5 m6 5 l-6 5" fill="none" stroke={g} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="112" y="14" width="92" height="56" rx="6" fill="var(--panel2)" stroke={g} strokeWidth="1.5" />{[0,1,2,3].map(i=>(<g key={i}><rect x="120" y={22+i*12} width="10" height="8" rx="2" fill={g} opacity={1-i*0.18} /><rect x="136" y={22+i*12} width={56-i*8} height="8" rx="3" fill="var(--line)" /></g>))}
    </svg>
  );
  if (kind === "decide") return ( // who now + wait cost
    <svg viewBox="0 0 220 84" style={box} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <rect x="16" y="30" width="96" height="24" rx="6" fill={g} /><text x="64" y="46" fontSize="11" fontWeight="700" fill="#1A1505" textAnchor="middle">Take now</text>
      <rect x="124" y="30" width="80" height="24" rx="6" fill="var(--panel2)" stroke="var(--line)" strokeWidth="1" /><text x="164" y="42" fontSize="9" fill="var(--mut)" textAnchor="middle">wait costs</text><text x="164" y="51" fontSize="9" fontWeight="700" fill="var(--red)" textAnchor="middle">−12 pts</text>
      <polygon points="64,20 60,28 68,28" fill={g} />
    </svg>
  );
  if (kind === "trust") return ( // measured accuracy gauge
    <svg viewBox="0 0 220 84" style={box} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <path d="M70 60 A40 40 0 0 1 150 60" fill="none" stroke="var(--line)" strokeWidth="8" strokeLinecap="round" />
      <path d="M70 60 A40 40 0 0 1 138 38" fill="none" stroke={g} strokeWidth="8" strokeLinecap="round" />
      <text x="110" y="56" fontSize="15" fontWeight="700" fill="var(--ink)" textAnchor="middle" fontFamily="var(--mono)">live</text>
      <text x="110" y="72" fontSize="9" fill="var(--mut)" textAnchor="middle">measured in-app</text>
    </svg>
  );
  return null;
}
function HelpPage({ user, biz, onBack, onHome, onSignOut, onSubmit, initialTab }) {
  const [tab, setTab] = useState(initialTab || "help");
  const [email, setEmail] = useState(user?.email || "");
  const [topic, setTopic] = useState("General");
  const [msg, setMsg] = useState("");
  const [sent, setSent] = useState(false);
  const submit = () => {
    if (!email.includes("@") || msg.trim().length < 3) return;
    onSubmit({ email, topic, msg: msg.trim() });
    setSent(true); setMsg("");
    setTimeout(() => setSent(false), 4000);
  };
  const faqs = [
    ["How do the predictions work?", "We read thousands of real drafts in your exact format to learn how the board actually behaves — runs, slides, reaches — then run simulations to turn that into live availability odds and pick recommendations. It updates after every selection."],
    ["Is my draft data private?", "Yes. Your leagues, drafts, mock drafts, and personal rankings are tied to your account and are never shared with or visible to other users."],
    ["What does the season pass cover?", "One pass covers unlimited leagues and unlimited mock drafts with every feature through the March 1 league-year cutoff. You'll always see the current price — including any active promo — on the home page and at checkout before you pay anything."],
    ["Which platforms sync automatically?", "Sleeper syncs automatically at launch — picks, traded picks, rosters, and depth charts flow in. Every other platform (ESPN, Yahoo, manual leagues) works through fast manual entry."],
    ["Can I set keepers and traded picks?", "Yes — in any draft's Settings tab. Keepers can be kept at a specific pick or added free to a roster, and you can reassign traded picks between teams. These apply to the official draft and every mock for that league."],
    ["How do I get help fast?", "Use the form on this page. It reaches the team directly, and replies come to the email you submit with."],
  ];
  return (
    <div>
      <AppHeader user={user} onSignOut={onSignOut} onHome={onHome} onApp={onBack} title="Help" />
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "24px 20px 50px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 14, flexWrap: "wrap" }}>
          <Compass size={40} />
          <div>
            <div className="disp" style={{ fontSize: 26, fontWeight: 700 }}>Help & support</div>
            <div className="mut" style={{ fontSize: 13 }}>Answers, contact, and the fine print — all in one place.</div>
          </div>
        </div>

        <div className="hairline" style={{ display: "flex", gap: 4, marginBottom: 18, flexWrap: "wrap" }}>
          {[["help","Help & FAQ"],["guide","Quick-start guide"],["contact","Contact us"],["legal","Terms & privacy"]].map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)} style={{ background: "transparent", border: "none", borderBottom: tab === k ? "2px solid var(--gold)" : "2px solid transparent", color: tab === k ? "var(--gold)" : "var(--mut)", fontWeight: 600, fontSize: 14, padding: "10px 14px", cursor: "pointer", fontFamily: "inherit" }}>{l}</button>
          ))}
        </div>

        {tab === "help" && (
          <div>
            {faqs.map(([q, a], i) => (
              <div key={i} className="panel" style={{ padding: 16, marginBottom: 10 }}>
                <div className="disp" style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>{q}</div>
                <div className="mut" style={{ fontSize: 13, lineHeight: 1.55 }}>{a}</div>
              </div>
            ))}
            <div className="panel" style={{ padding: 16, marginTop: 10, background: "var(--panel2)" }}>
              <div style={{ fontSize: 13 }}>Didn't find it? <button className="btn btn-mini" onClick={() => setTab("contact")}>Send us a message →</button></div>
            </div>
          </div>
        )}

        {tab === "guide" && (
          <div>
            <div className="panel" style={{ padding: 18, marginBottom: 14, background: "var(--panel2)" }}>
              <div className="disp" style={{ fontSize: 17, fontWeight: 700, marginBottom: 4 }}>Get the most out of Fantasy Draft Compass</div>
              <div className="mut" style={{ fontSize: 13, lineHeight: 1.55 }}>These are the same five steps as the “Get started” flow on your home screen — here with a bit more on the why behind each. Do them in order and you'll walk into draft night more prepared than anyone in your league.</div>
            </div>
            {[
              ["rankings", "ti-list-numbers", "Set your rankings", "Optional, but do it first if you want your own values driving the board. Tell the tool where you disagree with the market and your ranks become a “My ADP” column plus a “Blend” (your read tempered by consensus) right on the draft board. One global injury/news tweak ripples a player across every board at once."],
              ["create", "ti-plus", "Create or connect a league", "Connect Sleeper, ESPN, or Yahoo to auto-import — or build one by hand in a minute. Set the real rules: teams, scoring, roster slots, SuperFlex, TE premium, draft order, keepers, traded picks. Everything downstream is computed from these, so a SuperFlex 0.5-PPR board looks nothing like a standard 1QB one."],
              ["open", "ti-stack-2", "Open an existing league", "Everything you've built lives in one place. Jump back into any league to draft, mock, edit settings, or review past drafts — your keepers, pick trades, and rankings all travel with it."],
              ["mock", "ti-dice-5", "Run a mock", "Mocks are your highest-leverage habit — reps on your exact settings. Each one is scored and saved, and “My Mock Insights” surfaces your tendencies across them (where you reach, the values you keep missing), kept separate by format. The more you run, the sharper the read."],
              ["draft", "ti-trophy", "Draft for real", "On the clock, the hub is mission control: projected picks, live availability odds (“will he make it back to you?”), take-now-vs-wait math, selective insight tags on the players that matter, and your custom columns — all recalculating after every selection. Trust the odds to time your picks."],
            ].map(([kind, icon, title, body], i) => (
              <div key={i} className="panel" style={{ padding: 0, marginBottom: 12, overflow: "hidden" }}>
                <div style={{ display: "flex", gap: 0, flexWrap: "wrap" }}>
                  <div style={{ flex: "1 1 320px", padding: 16, display: "flex", gap: 14, alignItems: "flex-start" }}>
                    <div style={{ flexShrink: 0, width: 38, height: 38, borderRadius: 9, background: "#1A1505", border: "1px solid var(--gold)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <span className="disp gold" style={{ fontSize: 18, fontWeight: 700 }}>{i + 1}</span>
                    </div>
                    <div>
                      <div className="disp" style={{ fontSize: 15.5, fontWeight: 700, marginBottom: 3, display: "flex", alignItems: "center", gap: 7 }}><i className={`ti ${icon}`} style={{ fontSize: 16, color: "var(--gold)" }} aria-hidden="true" />{title}</div>
                      <div className="mut" style={{ fontSize: 13, lineHeight: 1.55 }}>{body}</div>
                    </div>
                  </div>
                  <div style={{ flex: "1 1 220px", minWidth: 200, background: "var(--panel2)", borderLeft: "1px solid var(--line)", display: "flex", alignItems: "center", justifyContent: "center", padding: "12px 16px" }}>
                    <GuideGraphic kind={kind} />
                  </div>
                </div>
              </div>
            ))}
            <div className="panel" style={{ padding: 16, marginTop: 4, background: "var(--panel2)" }}>
              <div className="disp" style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Beyond draft day</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 10 }}>
                {[
                  ["ti-arrows-exchange", "Trade Tools", "Format-aware trade values and an evaluator — weigh any deal, in-season or mid-draft."],
                  ["ti-rss", "League News & Movers", "ADP risers/fallers, signings, depth-chart moves, and the injury wire so your board reflects this week."],
                  ["ti-history", "Carry it season to season", "Your leagues, rankings, and settings live in your account. “Run it back” copies last year forward."],
                ].map(([icon, t, b], i) => (
                  <div key={i} style={{ display: "flex", gap: 9, alignItems: "flex-start" }}>
                    <i className={`ti ${icon}`} style={{ fontSize: 16, color: "var(--gold)", marginTop: 1, flexShrink: 0 }} aria-hidden="true" />
                    <div><div style={{ fontSize: 12.5, fontWeight: 700 }}>{t}</div><div className="mut" style={{ fontSize: 11.5, lineHeight: 1.45 }}>{b}</div></div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {tab === "contact" && (
          <div className="panel" style={{ padding: 20 }}>
            <div className="disp" style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Send feedback or get help</div>
            <div className="mut" style={{ fontSize: 12.5, marginBottom: 16 }}>Bug, idea, or question — it goes straight to the team. We reply to the email you enter below.</div>
            <div style={{ marginBottom: 12 }}>
              <label className="mut" style={{ fontSize: 12.5, display: "block", marginBottom: 4 }}>Your email (so we can reply)</label>
              <input className="gs" style={{ width: "100%" }} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label className="mut" style={{ fontSize: 12.5, display: "block", marginBottom: 4 }}>Topic</label>
              <select className="gs" style={{ width: "100%" }} value={topic} onChange={(e) => setTopic(e.target.value)}>
                {["General", "Bug report", "Feature request", "Billing", "Data accuracy", "Other"].map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div style={{ marginBottom: 14 }}>
              <label className="mut" style={{ fontSize: 12.5, display: "block", marginBottom: 4 }}>Message</label>
              <textarea className="gs" style={{ width: "100%", minHeight: 120, resize: "vertical", fontFamily: "inherit" }} value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="What's on your mind?" />
            </div>
            <button className="btn btn-gold" onClick={submit} disabled={!email.includes("@") || msg.trim().length < 3}>Submit feedback</button>
            {sent && <div style={{ marginTop: 12, color: "var(--green)", fontSize: 13 }}><i className="ti ti-check" style={{ marginRight: 5 }} aria-hidden="true" />Thanks — your message was received. We'll reply to {email} if it needs a response.</div>}
            <div className="mut" style={{ fontSize: 11, marginTop: 14 }}>In this prototype, submissions are stored to the admin feedback inbox; in production they'd also notify the team and route replies to your email automatically.</div>
          </div>
        )}

        {tab === "legal" && (
          <div>
            <div className="panel" style={{ padding: 18, marginBottom: 12 }}>
              <div className="disp" style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>The short version</div>
              <div className="mut" style={{ fontSize: 13, lineHeight: 1.6 }}>Fantasy Draft Compass is a draft-assistance tool. We give you data-driven projections and recommendations to help you make your own decisions — we don't guarantee outcomes, and we're not affiliated with the NFL, Sleeper, ESPN, Yahoo, or any league platform. Use it, enjoy it, draft a winner. The details below just make that official.</div>
            </div>
            {[
              ["Terms of use", "By using Fantasy Draft Compass you agree to use it for personal, lawful fantasy-football purposes. The projections, rankings, availability odds, and recommendations are informational and provided “as is,” without warranty of accuracy or fitness for a particular purpose. You're responsible for your own draft and roster decisions. We may update features, data, and these terms over time."],
              ["No guarantees", "Fantasy outcomes depend on factors outside anyone's control — injuries, coaching, and plain luck. Nothing here is a promise of a specific result, ranking, or championship. Past performance of a projection model does not guarantee future accuracy."],
              ["Privacy", "We store the account email you provide, your leagues, drafts, and the feedback you submit, in order to operate the service and respond to you. We don't sell your personal information. Payment is handled by a third-party processor; your full card details never touch our servers. You can request deletion of your account data at any time via the contact form."],
              ["Trademarks & affiliations", "Team names, player names, and platform names (Sleeper, ESPN, Yahoo, etc.) are the property of their respective owners and are used for identification only. Fantasy Draft Compass is an independent tool and is not endorsed by or affiliated with those organizations or the NFL."],
              ["Subscriptions & refunds", `The season pass is a one-time charge valid through the March 1 league-year cutoff. We back it with a 7-day money-back guarantee — if it's not for you, reach out through the contact form within 7 days of purchase for a full refund.`],
              ["Security & your account", "Your account sign-in is handled by a managed authentication provider, access to paid features and the admin console is verified on our servers, and payments run through a trusted processor so your card details never reach us. We use encryption in transit and at rest and follow least-privilege access for staff. No system is perfectly unbreakable, but we take protecting your account and data seriously and act quickly on any issue."],
            ].map(([h, b], i) => (
              <div key={i} className="panel" style={{ padding: 16, marginBottom: 10 }}>
                <div className="disp" style={{ fontSize: 14.5, fontWeight: 700, marginBottom: 4 }}>{h}</div>
                <div className="mut" style={{ fontSize: 12.5, lineHeight: 1.6 }}>{b}</div>
              </div>
            ))}
            <div className="mut" style={{ fontSize: 11, marginTop: 8 }}>This is a friendly summary for a prototype, not legal advice — have an attorney review final terms before launch.</div>
          </div>
        )}
      </div>
    </div>
  );
}

function TrendsPage({ user, onBack, onHome, onSignOut }) {
  const f = useMemo(() => getTrendsFeed(), []);
  const CAP = 4; // collapsed view shows this many; rest behind "show all"
  const Section = ({ icon, title, items, render }) => {
    const [open, setOpen] = useState(false);
    const shown = open ? items : items.slice(0, CAP);
    return (
      <div className="panel" style={{ padding: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <i className={`ti ${icon}`} style={{ fontSize: 20, color: "var(--gold)" }} aria-hidden="true" />
          <div className="disp" style={{ fontSize: 16, fontWeight: 700, flex: 1 }}>{title}</div>
          <span className="chip" style={{ fontSize: 10 }}>{items.length}</span>
        </div>
        {shown.map(render)}
        {items.length > CAP && (
          <button className="btn btn-mini" style={{ marginTop: 10, width: "100%" }} onClick={() => setOpen((v) => !v)}>
            {open ? "Show less" : `Show all ${items.length}`} <i className={`ti ti-chevron-${open ? "up" : "down"}`} style={{ fontSize: 12, marginLeft: 4 }} aria-hidden="true" />
          </button>
        )}
      </div>
    );
  };
  const moveRow = (p, up) => (
    <div key={p.name} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderTop: "1px solid var(--line)" }}>
      <Dot pos={p.pos} />
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>{p.name} <span className="mut" style={{ fontSize: 11 }}>{p.pos} · {p.team}</span></div>
        <div className="mut" style={{ fontSize: 11.5 }}>{p.note}</div>
      </div>
      <span className="num" style={{ fontWeight: 700, color: up ? "var(--green)" : "var(--red)" }}>{up ? "▲" : "▼"} {Math.abs(p.move)}</span>
    </div>
  );
  const noteRow = (x, color) => (
    <div key={x.name} style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "6px 0", borderTop: "1px solid var(--line)" }}>
      {x.pos ? <Dot pos={x.pos} /> : <i className="ti ti-arrow-badge-right" style={{ fontSize: 14, color: color || "var(--gold)", marginTop: 2 }} aria-hidden="true" />}
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>{x.name} <span className="mut" style={{ fontSize: 11 }}>{x.team}{x.pos ? ` · ${x.pos}` : ""}</span>{x.sev && <span style={{ marginLeft: 6, fontSize: 10, color: "#fff", background: INJURY_INFO[x.sev].color, borderRadius: 3, padding: "0 5px" }}>{INJURY_INFO[x.sev].label}</span>}</div>
        <div className="mut" style={{ fontSize: 11.5 }}>{x.note}</div>
      </div>
    </div>
  );
  return (
    <div>
      <AppHeader user={user} onSignOut={onSignOut} onHome={onHome} onApp={onBack} title="Recent trends" />
      <div style={{ maxWidth: 1000, margin: "0 auto", padding: "24px 20px 50px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 6, flexWrap: "wrap" }}>
          <Compass size={40} />
          <div>
            <div className="disp" style={{ fontSize: 26, fontWeight: 700 }}>Recent trends</div>
            <div className="mut" style={{ fontSize: 13 }}>Your hub to stay on top of the market — ADP movement, signings, new weapons, and injuries.</div>
          </div>
        </div>
        <div className="chip" style={{ borderColor: "var(--gold)", color: "var(--gold)", marginBottom: 16 }}>Pulled from public sources · {f.asOf}</div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 14 }}>
          <Section icon="ti-trending-up" title="Climbing ADP" items={f.climbers} render={(p) => moveRow(p, true)} />
          <Section icon="ti-trending-down" title="Falling ADP" items={f.fallers} render={(p) => moveRow(p, false)} />
          <Section icon="ti-file-signature" title="Recent signings & moves" items={f.signings} render={(x) => noteRow(x)} />
          <Section icon="ti-target-arrow" title="New weapons / situation upgrades" items={f.weapons} render={(x) => noteRow(x)} />
          <Section icon="ti-bandage" title="Injury wire" items={f.injuries} render={(x) => noteRow(x, INJURY_INFO[x.sev].color)} />
        </div>

        <div className="mut" style={{ fontSize: 11.5, marginTop: 18 }}>In production this page refreshes daily from public ADP movement (Sleeper, FantasyPros, ESPN), transaction and depth-chart feeds, and injury wires — nothing here is entered by hand. The sample above shows the layout and the categories the live feed populates.</div>
      </div>
    </div>
  );
}

function LeagueUmbrella({ user, league, onBack, onHome, onSignOut, onOfficial, onMock, onSettings, onViewMock, onDeleteMock, onDelete }) {
  const total = (league.cfg.teams || 12) * league.cfg.rounds;
  const st = league.picks.length >= total ? "complete" : league.picks.length > 0 ? "progress" : "fresh";
  const mocks = league.mocks || [];
  const keepers = league.cfg.keepers || [];
  const [showMocks, setShowMocks] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  return (
    <div>
      <AppHeader user={user} onSignOut={onSignOut} onHome={onHome} onApp={onBack} title="League" />
      <div style={{ maxWidth: 820, margin: "0 auto", padding: "24px 20px 50px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", marginBottom: 6 }}>
          <Compass size={40} />
          <div style={{ flex: 1 }}>
            <div className="disp" style={{ fontSize: 27, fontWeight: 700 }}>{league.name}</div>
            <div className="mut" style={{ fontSize: 13 }}>{league.cfg.teams || 12} teams · {league.cfg.sf ? "Superflex" : "1QB"}{league.cfg.tePremMult > 0 ? ` · TE+${league.cfg.tePremMult}` : ""} · {league.cfg.rounds} rounds{league.cfg.slot ? ` · your slot ${league.cfg.slot}` : ""} · {LEAGUE_TYPES.find((t) => t[0] === league.cfg.type)?.[1] || "Redraft"}</div>
          </div>
        </div>
        {keepers.length > 0 && <div className="gold" style={{ fontSize: 12, marginBottom: 4 }}><i className="ti ti-lock" style={{ fontSize: 12, marginRight: 4 }} aria-hidden="true" />{keepers.length} keeper{keepers.length > 1 ? "s" : ""} set — applied to the official draft and every mock.</div>}

        {/* THREE CHOICES INSIDE THE UMBRELLA */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(230px,1fr))", gap: 12, marginTop: 18 }}>
          <button className="hubtile" onClick={() => onOfficial(league.id)} style={{ textAlign: "left", background: "#16140c", border: "1px solid var(--gold)", borderRadius: 12, padding: 18, cursor: "pointer", fontFamily: "inherit", color: "var(--ink)" }}>
            <i className="ti ti-flag-3" style={{ fontSize: 24, color: "var(--gold)" }} aria-hidden="true" />
            <div className="disp" style={{ fontSize: 17, fontWeight: 700, margin: "9px 0 3px" }}>{st === "complete" ? "View Official Results" : st === "progress" ? "Resume Official Draft" : "Start Official Draft"}</div>
            <div className="mut" style={{ fontSize: 12, lineHeight: 1.45 }}>{st === "complete" ? "Draft complete — review the board, teams, and recap." : st === "progress" ? `${league.picks.length}/${total} picks made.` : "The real one. Live recommendations, projections, and grades."}</div>
          </button>
          <button className="hubtile" onClick={() => onMock(league.id)} style={{ textAlign: "left", background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 12, padding: 18, cursor: "pointer", fontFamily: "inherit", color: "var(--ink)" }}>
            <i className="ti ti-dice-5" style={{ fontSize: 24, color: "var(--gold)" }} aria-hidden="true" />
            <div className="disp" style={{ fontSize: 17, fontWeight: 700, margin: "9px 0 3px" }}>Run a Mock Draft</div>
            <div className="mut" style={{ fontSize: 12, lineHeight: 1.45 }}>Practice on this league's exact settings & keepers. {mocks.length ? `${mocks.length} saved.` : "Builds your prep trends."}</div>
          </button>
          <button className="hubtile" onClick={() => onSettings(league.id)} style={{ textAlign: "left", background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 12, padding: 18, cursor: "pointer", fontFamily: "inherit", color: "var(--ink)" }}>
            <i className="ti ti-settings" style={{ fontSize: 24, color: "var(--gold)" }} aria-hidden="true" />
            <div className="disp" style={{ fontSize: 17, fontWeight: 700, margin: "9px 0 3px" }}>League Settings</div>
            <div className="mut" style={{ fontSize: 12, lineHeight: 1.45 }}>Scoring, roster, draft order, keepers & pick trades — edit anytime.</div>
          </button>
        </div>

        {/* MOCK HISTORY + TRENDS */}
        {mocks.length > 0 && (
          <div style={{ marginTop: 22 }}>
            <button className="btn btn-mini" onClick={() => setShowMocks((s) => !s)}>{showMocks ? "Hide mock history" : `Mock history (${mocks.length})`}</button>
            {showMocks && (
              <div className="panel" style={{ padding: 14, marginTop: 10 }}>
                <div style={{ maxHeight: 220, overflowY: "auto" }}>
                  {mocks.map((m, i) => (
                    <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", fontSize: 12.5, borderTop: i ? "1px solid var(--line)" : "none" }}>
                      <span className="mut num" style={{ width: 22 }}>#{mocks.length - i}</span>
                      <span style={{ flex: 1 }}>{m.ran}</span>
                      <span className="mut">{m.n}/{total}</span>
                      <button className="btn btn-mini" onClick={() => onViewMock(league.id, m)}>view</button>
                      <button className="btn btn-mini" onClick={() => onDeleteMock(league.id, m.id)}>✕</button>
                    </div>
                  ))}
                </div>
                <MockTrendsLazy league={league} />
              </div>
            )}
          </div>
        )}

        {/* Delete this league */}
        {onDelete && (
          <div style={{ marginTop: 28, paddingTop: 16, borderTop: "1px solid var(--line)" }}>
            {!confirmDel ? (
              <button className="btn btn-mini" onClick={() => setConfirmDel(true)} style={{ borderColor: "var(--line)", color: "var(--mut)" }}><i className="ti ti-trash" style={{ fontSize: 13, marginRight: 5 }} aria-hidden="true" />Delete this league</button>
            ) : (
              <div className="panel" style={{ padding: 14, borderColor: "var(--red)", background: "var(--panel2)", maxWidth: 460 }}>
                <div style={{ fontSize: 13.5, marginBottom: 10 }}>Delete <b>{league.name}</b>{mocks.length ? ` and its ${mocks.length} mock draft${mocks.length === 1 ? "" : "s"}` : ""}? This permanently removes the league, its official draft, and all settings. This can't be undone.</div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="btn btn-mini" style={{ borderColor: "var(--red)", color: "var(--red)" }} onClick={() => onDelete(league.id)}><i className="ti ti-trash" style={{ fontSize: 12, marginRight: 4 }} aria-hidden="true" />Yes, delete it</button>
                  <button className="btn btn-mini" onClick={() => setConfirmDel(false)}>Cancel</button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
function ToolGraphic({ kind, color }) {
  const c = color || "var(--gold)";
  const bg = { width: "100%", height: "100%", display: "block" };
  if (kind === "rankings") return (
    <svg viewBox="0 0 200 90" style={bg} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      {[0,1,2,3].map((i) => (<g key={i}><rect x="22" y={14 + i*18} width="14" height="12" rx="2" fill={c} opacity={1 - i*0.18} /><rect x="44" y={14 + i*18} width={120 - i*22} height="12" rx="3" fill="var(--panel2)" /><circle cx="172" cy={20 + i*18} r="3" fill={c} opacity={0.6} /></g>))}
    </svg>
  );
  if (kind === "mockinsights") return (
    <svg viewBox="0 0 200 90" style={bg} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <polyline points="14,70 50,52 86,58 122,30 158,38 186,16" fill="none" stroke={c} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      {[[14,70],[50,52],[86,58],[122,30],[158,38],[186,16]].map(([x,y],i)=>(<circle key={i} cx={x} cy={y} r="3.5" fill={c} />))}
      <line x1="14" y1="80" x2="186" y2="80" stroke="var(--line)" strokeWidth="1" />
    </svg>
  );
  if (kind === "news") return (
    <svg viewBox="0 0 200 90" style={bg} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      {[0,1,2].map((i)=>(<g key={i}><circle cx="26" cy={20 + i*24} r="6" fill={c} opacity={0.85 - i*0.2} /><rect x="40" y={16 + i*24} width="120" height="6" rx="3" fill="var(--panel2)" /><rect x="40" y={25 + i*24} width="80" height="5" rx="2.5" fill="var(--line)" /><path d={`M168 ${20+i*24} l6 -4 v8 z`} fill={i===0?"var(--green)":i===1?c:"var(--mut)"} /></g>))}
    </svg>
  );
  if (kind === "guide") return (
    <svg viewBox="0 0 200 90" style={bg} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <circle cx="100" cy="45" r="30" fill="none" stroke="var(--line)" strokeWidth="2" />
      <circle cx="100" cy="45" r="30" fill="none" stroke={c} strokeWidth="3" strokeDasharray="38 200" strokeLinecap="round" transform="rotate(-90 100 45)" />
      <polygon points="100,30 108,52 100,46 92,52" fill={c} />
      <circle cx="100" cy="45" r="3" fill={c} />
    </svg>
  );
  if (kind === "trade") return (
    <svg viewBox="0 0 200 90" style={bg} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      {[18, 40].map((y, i) => <rect key={`l${i}`} x="20" y={y} width="60" height="14" rx="3" fill={c} opacity={0.85 - i * 0.25} />)}
      {[18, 40].map((y, i) => <rect key={`r${i}`} x="120" y={y} width="60" height="14" rx="3" fill="var(--panel2)" stroke={c} strokeWidth="1.5" opacity={0.9 - i * 0.2} />)}
      <path d="M88 30 h18 m0 0 l-5 -4 m5 4 l-5 4" fill="none" stroke={c} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M112 52 h-18 m0 0 l5 -4 m-5 4 l5 4" fill="none" stroke={c} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="60" y="68" width="80" height="9" rx="4.5" fill="var(--line)" /><rect x="60" y="68" width="46" height="9" rx="4.5" fill={c} />
    </svg>
  );
  if (kind === "adp") return (
    <svg viewBox="0 0 200 90" style={bg} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      {[26, 40, 54, 68].map((y, i) => (<g key={i}><rect x="20" y={y - 5} width={[150, 110, 132, 90][i]} height="8" rx="4" fill={c} opacity={0.4 + i * 0.12} /></g>))}
      <line x1="120" y1="14" x2="120" y2="80" stroke={c} strokeWidth="2" strokeDasharray="3 3" /><text x="124" y="20" fontSize="8" fill={c} fontFamily="monospace">consensus</text>
    </svg>
  );
  return null;
}

// Interactive hero showcase — each topic is a working mini version of the real feature, so a new
// visitor immediately gets what the tool does and gets fired up to use it.
function HeroShowcase() {
  const TOPICS = [
    { key: "board", icon: "ti-layout-board", label: "Live board", color: "#e0833a" },
    { key: "predict", icon: "ti-target-arrow", label: "Predict the board", color: "#5BA8F5" },
    { key: "trade", icon: "ti-arrows-exchange", label: "Trade intelligence", color: "#4FD1A1" },
    { key: "ranks", icon: "ti-list-numbers", label: "Your rankings", color: "#d6aa4b" },
    { key: "grades", icon: "ti-trophy", label: "Live grades", color: "#c79cff" },
  ];
  const [active, setActive] = useState("board");
  const t = TOPICS.find((x) => x.key === active) || TOPICS[0];

  // ---- PREDICT: upcoming picks with survival % + why-tags (team need / run / value) ----
  const PredictDemo = () => {
    const rows = [
      { name: "Bijan Robinson", pos: "RB", pct: 4, tag: "Positional run", tagColor: "#EF6A6A" },
      { name: "CeeDee Lamb", pos: "WR", pct: 22, tag: "Best available", tagColor: "#5BA8F5" },
      { name: "Puka Nacua", pos: "WR", pct: 51, tag: "Fills your WR need", tagColor: "#4FD1A1" },
      { name: "Sam LaPorta", pos: "TE", pct: 78, tag: "Value vs ADP", tagColor: "#F2A35C" },
    ];
    return (
      <div>
        <div className="mut" style={{ fontSize: 10.5, marginBottom: 7, letterSpacing: ".04em" }}>WILL THEY LAST TO YOUR PICK (1.09)?</div>
        {rows.map((r, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <span className="posdot" style={{ background: POS_COLOR[r.pos] }} />
            <span style={{ fontSize: 12, width: 96, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</span>
            <div style={{ flex: 1, height: 9, borderRadius: 5, background: "var(--panel2)", overflow: "hidden" }}>
              <div style={{ width: `${r.pct}%`, height: "100%", background: r.pct < 25 ? "#EF6A6A" : r.pct < 60 ? "#d6aa4b" : "#4FD1A1", borderRadius: 5, transition: "width .5s" }} />
            </div>
            <span className="num" style={{ fontSize: 11, width: 30, textAlign: "right", color: r.pct < 25 ? "#EF6A6A" : "var(--ink)" }}>{r.pct}%</span>
            <span style={{ fontSize: 9, color: r.tagColor, border: `1px solid ${r.tagColor}66`, borderRadius: 5, padding: "1px 5px", whiteSpace: "nowrap", width: 96, textAlign: "center" }}>{r.tag}</span>
          </div>
        ))}
        <div className="mut" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.45 }}>Live survival odds for every player before your pick — flagged by <b style={{ color: "var(--ink)" }}>team needs, positional runs, value vs ADP, and your strategy</b>.</div>
      </div>
    );
  };

  // ---- TRADE: tap a target to build a deal, watch the accept % + verdict update ----
  // Uses the SAME acceptance model as the live tool: a partner accepts in proportion to how much
  // value the deal sends THEM. accept = 50 + (theirGain)*1.3, clamped. Honest, not inflated.
  const TradeDemo = () => {
    const GIVE = { name: "DK Metcalf", pos: "WR", val: 70 }; // what you send
    const targets = [
      { name: "Garrett Wilson", pos: "WR", val: 92 },    // you get the better player → they reject
      { name: "DeVonta Smith", pos: "WR", val: 68 },     // ~even → fair, coin-flip
      { name: "Jaylen Waddle", pos: "WR", val: 54 },     // you send the better player → they love it
    ];
    const [pick, setPick] = useState(1);
    const tg = targets[pick];
    // partner gains (their value in) − (their value out). They receive GIVE, send the target.
    const partnerNet = GIVE.val - tg.val;
    const accept = Math.max(2, Math.min(98, Math.round(50 + partnerNet * 1.3)));
    const youWin = -partnerNet; // positive = the deal favors YOU
    const verdict = accept >= 60 ? "Favors them — they'd likely accept"
      : accept >= 38 ? "Roughly even — a coin-flip either way"
      : accept >= 15 ? "Favors you — add a piece to get it done"
      : "Lopsided your way — they'll pass";
    const vc = accept >= 60 ? "#4FD1A1" : accept >= 38 ? "#d6aa4b" : "#EF6A6A";
    return (
      <div>
        <div className="mut" style={{ fontSize: 10.5, marginBottom: 6, letterSpacing: ".04em" }}>YOU GIVE <b style={{ color: "var(--ink)" }}>{GIVE.name}</b> <span className="num">({GIVE.val})</span> — PICK WHO YOU GET:</div>
        <div style={{ display: "flex", gap: 5, marginBottom: 9, flexWrap: "wrap" }}>
          {targets.map((x, i) => (
            <button key={i} onClick={() => setPick(i)} className="bigact" style={{ cursor: "pointer", fontFamily: "inherit", fontSize: 11, padding: "5px 9px", borderRadius: 7, border: `1px solid ${pick === i ? t.color : "var(--line)"}`, background: pick === i ? t.color + "22" : "transparent", color: "var(--ink)", display: "flex", alignItems: "center", gap: 5 }}>
              <span className="posdot" style={{ background: POS_COLOR[x.pos] }} />{x.name}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", borderRadius: 10, background: "var(--panel2)" }}>
          <div style={{ textAlign: "center", minWidth: 58 }}>
            <div className="num disp" style={{ fontSize: 26, fontWeight: 700, color: vc }}>{accept}%</div>
            <div className="mut" style={{ fontSize: 9 }}>they accept</div>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 600 }}>Get {tg.name} <span className="mut num" style={{ fontSize: 11 }}>({tg.val})</span></div>
            <div style={{ fontSize: 11, color: vc, marginTop: 2 }}>{verdict}</div>
            <div className="mut" style={{ fontSize: 10, marginTop: 2 }}>{youWin > 4 ? `Nets you ~${youWin} in value` : youWin < -4 ? `Costs you ~${Math.abs(youWin)} in value` : "Value is about even both ways"}</div>
          </div>
        </div>
        <div className="mut" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.45 }}>The percentage is how likely <b style={{ color: "var(--ink)" }}>they</b> say yes — high % means the deal sends them value. Build a real trade and we score it instantly, format-aware.</div>
      </div>
    );
  };

  // ---- RANKS: drag a player up/down, blended rank recomputes live ----
  const RanksDemo = () => {
    const CONS = { "Ja'Marr Chase": 1.4, "Bijan Robinson": 3.2, "Puka Nacua": 8.1, "Malik Nabers": 6.5, "Brock Bowers": 14.0 };
    const POSOF = { "Ja'Marr Chase": "WR", "Bijan Robinson": "RB", "Puka Nacua": "WR", "Malik Nabers": "WR", "Brock Bowers": "TE" };
    const [order, setOrder] = useState(["Bijan Robinson", "Ja'Marr Chase", "Puka Nacua", "Malik Nabers", "Brock Bowers"]);
    const move = (i, d) => { const j = i + d; if (j < 0 || j >= order.length) return; const c = order.slice(); [c[i], c[j]] = [c[j], c[i]]; setOrder(c); };
    const blend = (name, i) => (0.65 * (i + 1) + 0.35 * CONS[name]).toFixed(1);
    return (
      <div>
        <div style={{ display: "flex", fontSize: 9.5, color: "var(--mut)", padding: "0 4px 4px", letterSpacing: ".03em" }}>
          <span style={{ width: 52 }}>YOUR RANK</span><span style={{ flex: 1 }}>PLAYER</span><span style={{ width: 42, textAlign: "right" }}>MKT</span><span style={{ width: 50, textAlign: "right" }}>BLEND</span>
        </div>
        {order.map((name, i) => (
          <div key={name} style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 4px", borderTop: "1px solid var(--line)", fontSize: 12 }}>
            <span className="num gold" style={{ width: 20, fontWeight: 700 }}>{i + 1}</span>
            <span style={{ display: "flex", gap: 2, width: 28 }}>
              <button onClick={() => move(i, -1)} disabled={i === 0} className="bigact" style={{ cursor: "pointer", border: "1px solid var(--line)", background: "transparent", color: "var(--ink)", borderRadius: 4, fontSize: 9, width: 13, lineHeight: 1, padding: "2px 0" }}>▲</button>
              <button onClick={() => move(i, 1)} disabled={i === order.length - 1} className="bigact" style={{ cursor: "pointer", border: "1px solid var(--line)", background: "transparent", color: "var(--ink)", borderRadius: 4, fontSize: 9, width: 13, lineHeight: 1, padding: "2px 0" }}>▼</button>
            </span>
            <span className="posdot" style={{ background: POS_COLOR[POSOF[name]] }} />
            <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name}</span>
            <span className="num mut" style={{ width: 42, textAlign: "right", fontSize: 11 }}>{CONS[name].toFixed(1)}</span>
            <span className="num" style={{ width: 50, textAlign: "right", color: t.color, fontWeight: 600 }}>{blend(name, i)}</span>
          </div>
        ))}
        <div className="mut" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.45 }}>Move a player and the <b style={{ color: "var(--ink)" }}>Blend</b> recomputes live — your opinion (65%) tempered by the market (35%), feeding your draft board.</div>
      </div>
    );
  };

  // ---- GRADES: value tags (steal/reach), report card ----
  const GradesDemo = () => {
    const picks = [
      { name: "Nico Collins", pos: "WR", tag: "STEAL", delta: "+18", tc: "#4FD1A1" },
      { name: "Saquon Barkley", pos: "RB", tag: "VALUE", delta: "+6", tc: "#5BA8F5" },
      { name: "Calvin Ridley", pos: "WR", tag: "REACH", delta: "−11", tc: "#EF6A6A" },
    ];
    return (
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        <div style={{ textAlign: "center", flexShrink: 0 }}>
          <div style={{ width: 64, height: 64, borderRadius: 16, background: t.color + "22", border: `2px solid ${t.color}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span className="disp" style={{ fontSize: 30, fontWeight: 700, color: t.color }}>A−</span>
          </div>
          <div className="mut" style={{ fontSize: 9.5, marginTop: 4 }}>DRAFT GRADE</div>
          <div className="mut" style={{ fontSize: 9.5 }}>proj. 2nd of 12</div>
        </div>
        <div style={{ flex: 1, minWidth: 150 }}>
          {picks.map((p, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 6, fontSize: 12 }}>
              <span className="posdot" style={{ background: POS_COLOR[p.pos] }} />
              <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</span>
              <span className="num" style={{ fontSize: 10, color: p.tc }}>{p.delta}</span>
              <span style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: ".04em", color: p.tc, border: `1px solid ${p.tc}66`, borderRadius: 5, padding: "1px 5px" }}>{p.tag}</span>
            </div>
          ))}
          <div className="mut" style={{ fontSize: 11, marginTop: 6, lineHeight: 1.45 }}>Live grades, biggest steals & reaches, and a projected finish — a full report card as you draft.</div>
        </div>
      </div>
    );
  };

  // ---- BOARD: the real draft board — ADP, value, insight tags; tap to draft a player ----
  const BoardDemo = () => {
    const init = [
      { name: "Ja'Marr Chase", pos: "WR", adp: "1.4", vbd: 92, posRank: 1, tier: 1, pts: 312, tag: "Top recommendation", tc: "#d6aa4b",
        why: "Our #1 overall in this format — the rare every-week WR1 with target volume that doesn't dip.", surv: 2 },
      { name: "Bijan Robinson", pos: "RB", adp: "2.1", vbd: 88, posRank: 1, tier: 1, pts: 305, tag: "RB run — act now", tc: "#EF6A6A",
        why: "Two RBs went in the last three picks — the position is thinning fast. Best back on the board.", surv: 4 },
      { name: "Justin Jefferson", pos: "WR", adp: "3.8", vbd: 80, posRank: 2, tier: 1, pts: 298, tag: "Best WR available", tc: "#9aa7b3",
        why: "Elite separation and a locked-in target share; safest floor among the remaining wideouts.", surv: 9 },
      { name: "Saquon Barkley", pos: "RB", adp: "4.6", vbd: 78, posRank: 2, tier: 1, pts: 291, tag: "Fills your RB need", tc: "#4FD1A1",
        why: "You have zero RBs and the tier ends soon — he plugs your biggest hole with a workhorse role.", surv: 14 },
      { name: "Brock Bowers", pos: "TE", adp: "9.2", vbd: 71, posRank: 1, tier: 2, pts: 248, tag: "Value vs ADP", tc: "#5BA8F5",
        why: "Going ~3 picks later than his consensus — a positional cheat code at a discount.", surv: 38 },
      { name: "Malik Nabers", pos: "WR", adp: "6.5", vbd: 69, posRank: 3, tier: 2, pts: 276, tag: "Upside pick", tc: "#c79cff",
        why: "Ceiling well above his projection — the target hog in a pass-heavy offense with league-winner range.", surv: 21 },
    ];
    const [drafted, setDrafted] = useState({});
    const [hover, setHover] = useState(null);
    const toggle = (i) => setDrafted((d) => ({ ...d, [i]: !d[i] }));
    return (
      <div style={{ position: "relative" }}>
        <div style={{ display: "flex", fontSize: 9.5, color: "var(--mut)", padding: "0 6px 5px", letterSpacing: ".03em" }}>
          <span style={{ width: 30 }} /><span style={{ flex: 1 }}>PLAYER</span><span style={{ width: 34, textAlign: "right" }}>ADP</span><span style={{ width: 34, textAlign: "right" }}>VBD</span>
        </div>
        {init.map((p, i) => {
          const gone = drafted[i];
          return (
            <div key={i} onClick={() => toggle(i)} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
              style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 6px", borderTop: "1px solid var(--line)", cursor: "pointer", fontSize: 12, opacity: gone ? 0.4 : 1, background: hover === i ? t.color + "14" : "transparent", borderRadius: 5 }}>
              <span style={{ width: 24, flexShrink: 0 }}>
                <span style={{ display: "inline-flex", width: 22, height: 16, borderRadius: 4, border: `1px solid ${gone ? "var(--mut)" : "#fff"}`, alignItems: "center", justifyContent: "center", fontSize: 8, fontWeight: 700, color: gone ? "var(--mut)" : "var(--ink)" }}>{gone ? "✓" : "+"}</span>
              </span>
              <span className="posdot" style={{ background: POS_COLOR[p.pos] }} />
              <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", textDecoration: gone ? "line-through" : "none" }}>{p.name}</span>
              {!gone && <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: ".02em", color: p.tc, border: `1px solid ${p.tc}66`, borderRadius: 4, padding: "0 4px", whiteSpace: "nowrap" }}>{p.tag}</span>}
              <span className="num mut" style={{ width: 34, textAlign: "right", fontSize: 11 }}>{p.adp}</span>
              <span className="num" style={{ width: 34, textAlign: "right", color: t.color, fontWeight: 600 }}>+{p.vbd}</span>
            </div>
          );
        })}

        {/* hover summary card — the signature interaction */}
        {hover != null && (() => {
          const p = init[hover];
          return (
            <div style={{ marginTop: 9, border: `1px solid ${p.tc}66`, borderRadius: 10, background: "var(--panel2)", padding: "11px 13px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <span className="posdot" style={{ background: POS_COLOR[p.pos] }} />
                <span className="disp" style={{ fontSize: 14.5, fontWeight: 700 }}>{p.name}</span>
                <span className="mut" style={{ fontSize: 11 }}>{p.pos}{p.posRank} · Tier {p.tier}</span>
                <div style={{ flex: 1 }} />
                <span style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: ".02em", color: p.tc, border: `1px solid ${p.tc}66`, borderRadius: 4, padding: "1px 5px" }}>{p.tag}</span>
              </div>
              <div style={{ display: "flex", gap: 14, marginBottom: 6 }}>
                <div><div className="num disp" style={{ fontSize: 17, fontWeight: 700 }}>{p.pts}</div><div className="mut" style={{ fontSize: 9 }}>proj pts</div></div>
                <div><div className="num disp" style={{ fontSize: 17, fontWeight: 700, color: t.color }}>+{p.vbd}</div><div className="mut" style={{ fontSize: 9 }}>value (VBD)</div></div>
                <div><div className="num disp" style={{ fontSize: 17, fontWeight: 700, color: p.surv < 25 ? "#EF6A6A" : "var(--ink)" }}>{p.surv}%</div><div className="mut" style={{ fontSize: 9 }}>lasts to you</div></div>
              </div>
              <div className="mut" style={{ fontSize: 11.5, lineHeight: 1.45 }}>{p.why}</div>
            </div>
          );
        })()}

        <div className="mut" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.45 }}><b style={{ color: "var(--ink)" }}>Hover any name</b> for the full read — projection, value, survival odds, and the “why.” Tap to draft and the board re-ranks instantly.</div>
      </div>
    );
  };

  const Preview = t.key === "board" ? BoardDemo : t.key === "predict" ? PredictDemo : t.key === "trade" ? TradeDemo : t.key === "ranks" ? RanksDemo : GradesDemo;
  return (
    <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "stretch" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 180, flex: "1 1 180px" }}>
        {TOPICS.map((x) => (
          <button key={x.key} onClick={() => setActive(x.key)} className="bigact" style={{ display: "flex", alignItems: "center", gap: 9, textAlign: "left", cursor: "pointer", fontFamily: "inherit", padding: "10px 12px", borderRadius: 10, border: `1px solid ${active === x.key ? x.color : "var(--line)"}`, background: active === x.key ? x.color + "1e" : "transparent", color: "var(--ink)" }}>
            <i className={`ti ${x.icon}`} style={{ fontSize: 18, color: x.color }} aria-hidden="true" />
            <span className="disp" style={{ fontSize: 14, fontWeight: 700, flex: 1 }}>{x.label}</span>
            {active === x.key && <i className="ti ti-chevron-right" style={{ fontSize: 14, color: x.color }} aria-hidden="true" />}
          </button>
        ))}
        <div className="mut" style={{ fontSize: 10.5, marginTop: 2, lineHeight: 1.4, padding: "0 2px" }}>Try them — these are live, interactive samples of the real tool.</div>
      </div>
      <div style={{ flex: "2 1 320px", border: `1px solid ${t.color}44`, borderRadius: 12, background: `linear-gradient(160deg, ${t.color}12, var(--panel))`, padding: 16, minWidth: 280 }}>
        <Preview />
      </div>
    </div>
  );
}

// Quick-mock pre-draft prompt: choose type + simple format + your slot, shown over a faded
// preview of the draft board behind it. On submit, builds a cfg and launches the mock.
function QuickMockSetup({ onStart, onCancel }) {
  const [type, setType] = useState("redraft");
  const [teams, setTeams] = useState(12);
  const [qb, setQb] = useState("1QB");      // 1QB | SF
  const [te, setTe] = useState("std");      // std | tep
  const [slot, setSlot] = useState("random"); // "random" or a number
  const TYPES = [["redraft", "Redraft"], ["dynasty", "Dynasty"], ["bestball", "Best ball"], ["rookie", "Rookie only"]];

  const launch = () => {
    const start = { QB: qb === "SF" ? 1 : 1, RB: 2, WR: 2, TE: 1, FLEX: 1, SUPER: qb === "SF" ? 1 : 0, DST: 0, K: 0 };
    const scoring = { ...DEFAULT_SCORING };
    if (te === "tep") scoring.recTE = (scoring.rec || 0) + 0.5;
    const chosenSlot = slot === "random" ? (1 + Math.floor(Math.random() * teams)) : +slot;
    const cfg = {
      name: "Quick mock", type, teams: +teams, rounds: 15, slot: chosenSlot,
      sf: qb === "SF", tePrem: te === "tep", tePremMult: te === "tep" ? 0.5 : 0,
      caps: {}, start, scoring, excludeRookies: false, keeper: false, idp: false,
    };
    onStart(cfg);
  };

  const Seg = ({ value, set, options }) => (
    <div style={{ display: "inline-flex", background: "var(--panel2)", borderRadius: 9, padding: 3, gap: 2, flexWrap: "wrap" }}>
      {options.map(([k, l]) => (
        <button key={k} onClick={() => set(k)} className="bigact" style={{ cursor: "pointer", fontFamily: "inherit", fontSize: 12.5, fontWeight: 600, padding: "6px 12px", borderRadius: 7, border: "none", background: value === k ? "var(--gold)" : "transparent", color: value === k ? "#1A1505" : "var(--ink)" }}>{l}</button>
      ))}
    </div>
  );

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      {/* faded draft-board backdrop */}
      <div style={{ position: "absolute", inset: 0, background: "var(--bg)", overflow: "hidden" }} aria-hidden="true">
        <div style={{ opacity: 0.16, filter: "blur(1.5px)", padding: "40px 30px", pointerEvents: "none" }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            {Array.from({ length: 8 }).map((_, i) => <div key={i} style={{ flex: 1, height: 34, borderRadius: 7, background: "var(--panel)", border: "1px solid var(--line)" }} />)}
          </div>
          {Array.from({ length: 10 }).map((_, r) => (
            <div key={r} style={{ display: "flex", gap: 8, marginBottom: 8 }}>
              {Array.from({ length: 8 }).map((_, c) => {
                const pc = [POS_COLOR.QB, POS_COLOR.RB, POS_COLOR.WR, POS_COLOR.TE][(r + c) % 4];
                return <div key={c} style={{ flex: 1, height: 46, borderRadius: 7, background: "var(--panel)", borderLeft: `3px solid ${pc}`, border: "1px solid var(--line)" }} />;
              })}
            </div>
          ))}
        </div>
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(10,10,8,0.6), rgba(10,10,8,0.82))" }} />
      </div>

      {/* prompt card */}
      <div className="panel" style={{ position: "relative", maxWidth: 460, width: "100%", padding: 24, boxShadow: "0 24px 60px #000a" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
          <div style={{ width: 38, height: 38, borderRadius: 10, background: "#4FD1A122", display: "flex", alignItems: "center", justifyContent: "center" }}><i className="ti ti-dice-5" style={{ fontSize: 20, color: "#4FD1A1" }} aria-hidden="true" /></div>
          <div>
            <div className="disp" style={{ fontSize: 20, fontWeight: 700 }}>Quick mock</div>
            <div className="mut" style={{ fontSize: 12 }}>A fast practice draft — set it up and go.</div>
          </div>
        </div>

        <div style={{ marginTop: 16 }}>
          <div className="mut" style={{ fontSize: 11.5, fontWeight: 600, marginBottom: 6, letterSpacing: ".03em" }}>LEAGUE TYPE</div>
          <Seg value={type} set={setType} options={TYPES} />
        </div>

        <div style={{ marginTop: 16, display: "flex", gap: 24, flexWrap: "wrap" }}>
          <div>
            <div className="mut" style={{ fontSize: 11.5, fontWeight: 600, marginBottom: 6, letterSpacing: ".03em" }}>QB FORMAT</div>
            <Seg value={qb} set={setQb} options={[["1QB", "1QB"], ["SF", "Superflex"]]} />
          </div>
          <div>
            <div className="mut" style={{ fontSize: 11.5, fontWeight: 600, marginBottom: 6, letterSpacing: ".03em" }}>TIGHT END</div>
            <Seg value={te} set={setTe} options={[["std", "Standard"], ["tep", "TE premium"]]} />
          </div>
        </div>

        <div style={{ marginTop: 16, display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div>
            <div className="mut" style={{ fontSize: 11.5, fontWeight: 600, marginBottom: 6, letterSpacing: ".03em" }}>TEAMS</div>
            <select className="gs" value={teams} onChange={(e) => { const n = +e.target.value; setTeams(n); if (slot !== "random" && +slot > n) setSlot("random"); }}>
              {[8, 10, 12, 14, 16].map((n) => <option key={n} value={n}>{n} teams</option>)}
            </select>
          </div>
          <div>
            <div className="mut" style={{ fontSize: 11.5, fontWeight: 600, marginBottom: 6, letterSpacing: ".03em" }}>YOUR PICK</div>
            <select className="gs" value={slot} onChange={(e) => setSlot(e.target.value)}>
              <option value="random">🎲 Random slot</option>
              {Array.from({ length: teams }, (_, i) => <option key={i} value={i + 1}>Pick {i + 1}</option>)}
            </select>
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 22 }}>
          <button className="btn" onClick={onCancel}>Cancel</button>
          <div style={{ flex: 1 }} />
          <button className="btn btn-gold" onClick={launch}><i className="ti ti-player-play" style={{ fontSize: 14, marginRight: 5 }} aria-hidden="true" />Start mock</button>
        </div>
      </div>
    </div>
  );
}

function PaidHub({ user, leagues, funMocks, onLibrary, onNewLeague, onOfficial, onMock, onQuickMock, onDatabase, onTrends, onHelp, onGuide, onAccount, onAdmin, onSignOut, onUmbrella, onRankings, onTrendsTime, onTradeTools, onAdpIntel, onDelete }) {
  const totalMocks = leagues.reduce((s, l) => s + (l.mocks || []).length, 0) + funMocks.length;
  const inProgress = leagues.filter((l) => l.picks.length > 0 && l.picks.length < (l.cfg.teams || 12) * l.cfg.rounds);
  const [q, setQ] = useState("");
  const firstName = (user?.name || (user?.email ? user.email.split("@")[0] : "") || "").split(/[ .]/)[0];
  const greetName = firstName ? firstName.charAt(0).toUpperCase() + firstName.slice(1) : null;
  const hour = new Date().getHours();
  const timeGreet = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  const matchedLeagues = q.trim() ? leagues.filter((l) => l.name.toLowerCase().includes(q.toLowerCase())) : leagues;
  // surface in-progress first, then not-started, then complete
  const sortedLeagues = matchedLeagues.slice().sort((a, b) => {
    const rank = (l) => { const tot = (l.cfg.teams || 12) * l.cfg.rounds; return l.picks.length >= tot ? 2 : l.picks.length > 0 ? 0 : 1; };
    return rank(a) - rank(b);
  });
  const [openPick, setOpenPick] = useState(false); // top quick-action league picker
  const [openPickFlow, setOpenPickFlow] = useState(false); // in-flow (Get started) league picker
  const [mockPick, setMockPick] = useState(false); // expand the "run a mock" picker box
  const [delConfirm, setDelConfirm] = useState(null); // league id pending delete confirmation
  // open exactly one picker at a time
  const openLeaguePanel = () => { setMockPick(false); setOpenPickFlow(false); setOpenPick((v) => !v); };
  const openLeagueFlow = () => { setMockPick(false); setOpenPick(false); setOpenPickFlow((v) => !v); };
  const openMockPanel = () => { setOpenPick(false); setOpenPickFlow(false); setMockPick((v) => !v); };

  const leagueStatus = (l) => {
    const total = (l.cfg.teams || 12) * l.cfg.rounds;
    if (l.picks.length >= total) return { label: "Draft complete", color: "var(--green)", pct: 100, icon: "ti-circle-check" };
    if (l.picks.length > 0) return { label: `Drafting · ${l.picks.length}/${total}`, color: "var(--gold)", pct: Math.round((l.picks.length / total) * 100), icon: "ti-player-play" };
    return { label: "Ready to draft", color: "var(--mut)", pct: 0, icon: "ti-flag-3" };
  };

  // Secondary tools as flip cards (front = title + graphic, back = explanation).
  const flipTools = [
    { kind: "rankings", icon: "ti-list-numbers", color: "#6aa9ff", title: "My Rankings", back: "Build your own player board. Attach it to a league and it powers the “My ADP” and “Blend” columns right inside that draft.", action: onRankings },
    { kind: "mockinsights", icon: "ti-chart-line", color: "#7ed6a5", title: "My Mock Insights", back: totalMocks ? `Patterns across your own ${totalMocks} mock${totalMocks === 1 ? "" : "s"} — the spots where you find value and the players you keep landing.` : "After you run a few mock drafts, this reveals the patterns across them — your tendencies and best value spots.", action: onTrendsTime },
    { kind: "news", icon: "ti-rss", color: "#ff9d6a", title: "League News & Movers", back: "The wider fantasy wire: ADP risers and fallers, signings, depth-chart changes, and injuries. Not tied to your leagues.", action: onTrends },
    { kind: "trade", icon: "ti-arrows-exchange", color: "#4FD1A1", title: "Trade Tools", back: "Format-aware trade values and a quick evaluator — weigh any deal by format, even outside a draft. Inside a league it adds your roster, picks, and the trade finder.", action: onTradeTools },
    { kind: "adp", icon: "ti-chart-dots", color: "#5BA8F5", title: "ADP Intelligence", back: "Every ADP consideration for a player: the consensus to follow, how it's trending across recent Sleeper drafts, the spread, sample size, and your blended number — all format-aware.", action: onAdpIntel },
    { kind: "guide", icon: "ti-compass", color: "#d6aa4b", title: "Quick-Start Guide", back: "A short walkthrough of how every piece fits together. Start here if anything feels unclear.", action: onGuide },
  ];

  // Single guided flow — the order of operations AND the primary actions, merged. Each step
  // opens the right thing; "open a league" and "run a mock" open inline boxes (no page jump).
  const anyMock = totalMocks > 0;
  const steps = [
    { n: 1, icon: "ti-list-numbers", title: "Set your rankings", note: "Optional, but do it first if you want your own values driving the board.", action: onRankings, done: (user?.rankSets || []).length > 0 },
    { n: 2, icon: "ti-plus", title: "Create or connect a league", note: "Connect Sleeper/ESPN/Yahoo, or build one by hand. Settings, keepers, and drafts live here.", action: onNewLeague, done: leagues.length > 0 },
    { n: 3, icon: "ti-stack-2", title: "Open an existing league", note: leagues.length ? `Jump into one of your ${leagues.length} league${leagues.length === 1 ? "" : "s"}.` : "Once you have a league, open it here.", action: () => (leagues.length ? openLeagueFlow() : onNewLeague()), done: false },
    { n: 4, icon: "ti-dice-5", title: "Run a mock", note: "A quick mock, an existing mock, or a mock of a specific league.", action: openMockPanel, done: anyMock },
    { n: 5, icon: "ti-trophy", title: "Draft for real", note: "Open your league and start the official draft.", action: () => (leagues.length ? openLeagueFlow() : onNewLeague()), done: leagues.some((l) => l.picks.length >= (l.cfg.teams || 12) * l.cfg.rounds) },
  ];
  const nextStep = steps.find((s) => !s.done) || steps[steps.length - 1];

  return (
    <div>
      <div className="hairline" style={{ display: "flex", alignItems: "center", gap: 16, padding: "12px 20px" }}>
        <Wordmark size={20} />
        <div style={{ flex: 1 }} />
        <span className="chip" style={{ color: "var(--green)" }}><i className="ti ti-circle-check" style={{ fontSize: 11, marginRight: 3 }} aria-hidden="true" />Season pass active</span>
        {user?.admin && <button className="btn btn-mini" onClick={onAdmin}>Admin</button>}
        <button className="btn btn-mini" onClick={onHelp}><i className="ti ti-help-circle" style={{ fontSize: 13, marginRight: 4 }} aria-hidden="true" />Help</button>
        <button className="btn btn-mini" onClick={onAccount}><i className="ti ti-user" style={{ fontSize: 13, marginRight: 4 }} aria-hidden="true" />Account</button>
        <button className="btn btn-mini" onClick={onSignOut}>Sign out</button>
      </div>

      {/* QUICK ACTIONS — equal-weight menu items, subtly highlighted as the primary zone */}
      <div style={{ maxWidth: 940, margin: "0 auto", padding: "14px 20px 18px" }}>
        <div style={{ display: "flex", alignItems: "stretch", border: "1px solid rgba(214,170,75,0.45)", borderRadius: 12, overflow: "hidden", background: "linear-gradient(180deg, rgba(214,170,75,0.10), rgba(214,170,75,0.04))" }}>
          <button onClick={() => onNewLeague()} className="menuitem" style={{ flex: 1, cursor: "pointer", fontFamily: "inherit", color: "var(--ink)", border: "none", background: "transparent", padding: "14px 18px", display: "flex", alignItems: "center", justifyContent: "center", gap: 9 }}>
            <i className="ti ti-plus" style={{ fontSize: 18, color: "var(--gold)" }} aria-hidden="true" />
            <span className="disp" style={{ fontSize: 15.5, fontWeight: 700 }}>Create New League</span>
          </button>
          <div style={{ width: 1, background: "rgba(214,170,75,0.30)" }} />
          <button onClick={() => (leagues.length ? openLeaguePanel() : onNewLeague())} className="menuitem" style={{ flex: 1, cursor: "pointer", fontFamily: "inherit", color: "var(--ink)", border: "none", background: "transparent", padding: "14px 18px", display: "flex", alignItems: "center", justifyContent: "center", gap: 9 }}>
            <i className="ti ti-stack-2" style={{ fontSize: 18, color: "var(--gold)" }} aria-hidden="true" />
            <span className="disp" style={{ fontSize: 15.5, fontWeight: 700 }}>Choose Existing League</span>
            <i className={`ti ti-chevron-${openPick ? "up" : "down"}`} style={{ fontSize: 14, color: "var(--mut)" }} aria-hidden="true" />
          </button>
          <div style={{ width: 1, background: "rgba(214,170,75,0.30)" }} />
          <button onClick={() => onRankings()} className="menuitem" style={{ flex: 1, cursor: "pointer", fontFamily: "inherit", color: "var(--ink)", border: "none", background: "transparent", padding: "14px 18px", display: "flex", alignItems: "center", justifyContent: "center", gap: 9 }}>
            <i className="ti ti-list-numbers" style={{ fontSize: 18, color: "var(--gold)" }} aria-hidden="true" />
            <span className="disp" style={{ fontSize: 15.5, fontWeight: 700 }}>My Rankings</span>
          </button>
        </div>
      </div>

      {/* the existing-league picker can open straight from the quick action above */}
      {openPick && leagues.length > 0 && (
        <div style={{ maxWidth: 940, margin: "0 auto", padding: "10px 20px 0" }}>
          <div className="panel" style={{ padding: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <i className="ti ti-stack-2" style={{ fontSize: 16, color: "var(--gold)" }} aria-hidden="true" />
              <div className="disp" style={{ fontSize: 15, fontWeight: 700, flex: 1 }}>Choose a league</div>
              <button className="btn btn-mini" onClick={() => setOpenPick(false)}>Close</button>
            </div>
            <div style={{ position: "relative", marginBottom: 10 }}>
              <i className="ti ti-search" style={{ position: "absolute", left: 12, top: 11, fontSize: 15, color: "var(--mut)" }} aria-hidden="true" />
              <input className="gs" autoFocus style={{ width: "100%", paddingLeft: 36, paddingTop: 10, paddingBottom: 10, fontSize: 14 }} placeholder={`Search your ${leagues.length} league${leagues.length === 1 ? "" : "s"} & drafts…`} value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 7, maxHeight: 320, overflowY: "auto" }}>
              {sortedLeagues.map((l) => {
                const st = leagueStatus(l); const mocks = (l.mocks || []).length;
                return (
                  <div key={l.id} style={{ border: "1px solid var(--line)", background: "var(--panel2)", borderRadius: 11, padding: "11px 13px", display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ width: 34, height: 34, borderRadius: 9, background: "var(--panel)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><i className={`ti ${st.icon}`} style={{ fontSize: 16, color: st.color }} aria-hidden="true" /></div>
                    <button onClick={() => onUmbrella(l.id)} style={{ flex: 1, minWidth: 0, textAlign: "left", cursor: "pointer", fontFamily: "inherit", color: "var(--ink)", border: "none", background: "transparent", padding: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        <span className="disp" style={{ fontSize: 15, fontWeight: 700 }}>{l.name}</span>
                        {(l.cfg.keepers || []).length > 0 && <span className="chip" style={{ fontSize: 9 }}><i className="ti ti-lock" style={{ fontSize: 9, marginRight: 2 }} aria-hidden="true" />{(l.cfg.keepers || []).length}</span>}
                        {mocks > 0 && <span className="chip" style={{ fontSize: 9 }}>{mocks} mock{mocks === 1 ? "" : "s"}</span>}
                      </div>
                      <div className="mut" style={{ fontSize: 11, marginTop: 1 }}>{l.cfg.teams || 12}T · {l.cfg.sf ? "Superflex" : "1QB"}{l.cfg.tePremMult > 0 ? " · TE+" : ""} · {l.cfg.rounds} rds · <span style={{ color: st.color, fontWeight: 600 }}>{st.label}</span></div>
                    </button>
                    <button className="btn btn-mini" onClick={() => onUmbrella(l.id)} style={{ flexShrink: 0 }}>Open</button>
                    {onDelete && (delConfirm === l.id
                      ? <span style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                          <button className="btn btn-mini" style={{ borderColor: "var(--red)", color: "var(--red)" }} onClick={() => { onDelete(l.id); setDelConfirm(null); }} title="Confirm delete"><i className="ti ti-check" style={{ fontSize: 12 }} aria-hidden="true" /></button>
                          <button className="btn btn-mini" onClick={() => setDelConfirm(null)} title="Cancel"><i className="ti ti-x" style={{ fontSize: 12 }} aria-hidden="true" /></button>
                        </span>
                      : <button className="btn btn-mini" onClick={() => setDelConfirm(l.id)} title="Delete league" style={{ flexShrink: 0, borderColor: "var(--line)", color: "var(--mut)" }}><i className="ti ti-trash" style={{ fontSize: 13 }} aria-hidden="true" /></button>
                    )}
                  </div>
                );
              })}
              {q.trim() && sortedLeagues.length === 0 && (
                <div style={{ textAlign: "center", padding: "10px 0" }}>
                  <div className="mut" style={{ fontSize: 13, marginBottom: 8 }}>No leagues match “{q.trim()}”.</div>
                  <button className="btn btn-gold btn-mini" onClick={() => { setQ(""); onNewLeague(); }}><i className="ti ti-plus" style={{ fontSize: 12, marginRight: 4 }} aria-hidden="true" />Create it as a new league</button>
                </div>
              )}
            </div>
            <div style={{ borderTop: "1px solid var(--line)", marginTop: 10, paddingTop: 10 }}>
              <button className="btn btn-mini" onClick={onDatabase}><i className="ti ti-database" style={{ fontSize: 12, marginRight: 5 }} aria-hidden="true" />Browse all drafts &amp; mocks</button>
            </div>
          </div>
        </div>
      )}

      {/* HERO */}
      <div style={{ position: "relative", overflow: "hidden", borderBottom: "1px solid var(--line)", background: "radial-gradient(130% 150% at 88% -30%, rgba(214,170,75,0.20), transparent 58%), radial-gradient(90% 120% at 5% 0%, rgba(91,168,245,0.10), transparent 55%), linear-gradient(180deg, var(--panel) 0%, var(--bg) 100%)" }}>
        <div style={{ maxWidth: 940, margin: "0 auto", padding: "26px 20px 26px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap", marginBottom: 20 }}>
            <Compass size={62} spin />
            <div style={{ flex: 1, minWidth: 240 }}>
              <div className="disp" style={{ fontSize: 30, fontWeight: 700, letterSpacing: "-.02em", lineHeight: 1.05 }}>{timeGreet}{greetName ? `, ${greetName}` : ""}.</div>
              <div className="mut" style={{ fontSize: 14.5, marginTop: 4 }}>{leagues.length === 0 ? "Your draft command center. Here's what it does — then jump in below." : inProgress.length ? "You've got a draft in progress — jump back in below." : "Your draft command center. Pick a topic to see it in action."}</div>
            </div>
          </div>
          <HeroShowcase />
        </div>
      </div>

      <div style={{ maxWidth: 940, margin: "0 auto", padding: "26px 20px 64px", display: "flex", flexDirection: "column", gap: 22 }}>

        {/* RESUME */}
        {inProgress.length > 0 && (
          <button className="bigact" onClick={() => onOfficial(inProgress[0].id)} style={{ width: "100%", textAlign: "left", cursor: "pointer", fontFamily: "inherit", color: "var(--ink)", border: "1.5px solid var(--gold)", background: "linear-gradient(90deg, #1b1708, #141206)", borderRadius: 14, padding: "15px 18px", display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ width: 40, height: 40, borderRadius: 20, background: "var(--gold)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><i className="ti ti-player-play-filled" style={{ fontSize: 19, color: "#1A1505" }} aria-hidden="true" /></div>
            <div style={{ flex: 1 }}>
              <div className="disp" style={{ fontSize: 16, fontWeight: 700 }}>Resume your draft</div>
              <div className="mut" style={{ fontSize: 12.5 }}>{inProgress[0].name} — {inProgress[0].picks.length}/{(inProgress[0].cfg.teams || 12) * inProgress[0].cfg.rounds} picks made</div>
            </div>
            <span className="gold" style={{ fontSize: 13, fontWeight: 600 }}>Continue →</span>
          </button>
        )}

        {/* ===== SECTION: GET STARTED ===== */}
        <div className="hubsection">
          <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 3 }}>
            <i className="ti ti-route" style={{ fontSize: 19, color: "var(--gold)" }} aria-hidden="true" />
            <div className="disp" style={{ fontSize: 19, fontWeight: 700 }}>Get started</div>
          </div>
          <div className="mut" style={{ fontSize: 12.5, marginBottom: 14 }}>The whole flow, in order — jump in anywhere. Hover a card for details; your next step glows gold.</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(165px,1fr))", gap: 10 }}>
            {steps.map((s) => {
              const isNext = s.n === nextStep.n;
              const accent = s.done ? "var(--green)" : isNext ? "var(--gold)" : "var(--mut)";
              return (
                <div key={s.n} className="flipcard" role="button" tabIndex={0} onClick={s.action} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && s.action()} style={{ height: 124 }}>
                  <div className="flipinner">
                    {/* FRONT — number + icon + title */}
                    <div className="flipface" style={{ background: isNext ? "#16140c" : "var(--panel2)", border: `1px solid ${isNext ? "var(--gold)" : "var(--line)"}`, padding: 13, justifyContent: "space-between" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                        <span className="disp" style={{ fontSize: 34, fontWeight: 700, lineHeight: 1, color: accent, opacity: s.done ? 0.5 : 1 }}>{s.n}</span>
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                          <i className={`ti ${s.icon}`} style={{ fontSize: 18, color: accent }} aria-hidden="true" />
                          {s.done && <i className="ti ti-circle-check-filled" style={{ fontSize: 15, color: "var(--green)" }} aria-hidden="true" />}
                          {isNext && !s.done && <span className="gold" style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: ".05em", textTransform: "uppercase", border: "1px solid var(--gold)", borderRadius: 5, padding: "1px 4px" }}>Next</span>}
                        </div>
                      </div>
                      <div className="disp" style={{ fontSize: 14, fontWeight: 700, lineHeight: 1.1 }}>{s.title}</div>
                    </div>
                    {/* BACK — detail */}
                    <div className="flipface flipback" style={{ border: `1px solid ${isNext ? "var(--gold)" : "var(--line)"}` }}>
                      <div className="disp" style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 4 }}><span style={{ color: accent }}>{s.n}.</span> {s.title}</div>
                      <div className="mut" style={{ fontSize: 10.5, lineHeight: 1.4 }}>{s.note}</div>
                      <div className="gold" style={{ fontSize: 11, fontWeight: 600, marginTop: 6 }}>{s.done ? "Done ✓ · revisit →" : "Go →"}</div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

        {/* OPEN-A-LEAGUE inline box (steps 3 & 5) */}
        {openPickFlow && leagues.length > 0 && (
          <div style={{ background: "var(--panel2)", border: "1px solid var(--line)", borderRadius: 12, padding: 14, marginTop: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <i className="ti ti-stack-2" style={{ fontSize: 16, color: "var(--gold)" }} aria-hidden="true" />
              <div className="disp" style={{ fontSize: 15, fontWeight: 700, flex: 1 }}>Open a league</div>
              <button className="btn btn-mini" onClick={() => setOpenPickFlow(false)}>Close</button>
            </div>
            <div style={{ position: "relative", marginBottom: 10 }}>
              <i className="ti ti-search" style={{ position: "absolute", left: 12, top: 11, fontSize: 15, color: "var(--mut)" }} aria-hidden="true" />
              <input className="gs" autoFocus style={{ width: "100%", paddingLeft: 36, paddingTop: 10, paddingBottom: 10, fontSize: 14 }} placeholder={`Search your ${leagues.length} league${leagues.length === 1 ? "" : "s"} & drafts…`} value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 7, maxHeight: 360, overflowY: "auto" }}>
              {sortedLeagues.map((l) => {
                const st = leagueStatus(l); const mocks = (l.mocks || []).length;
                return (
                  <div key={l.id} style={{ border: "1px solid var(--line)", background: "var(--panel2)", borderRadius: 11, padding: "11px 13px", display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ width: 34, height: 34, borderRadius: 9, background: "var(--panel)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><i className={`ti ${st.icon}`} style={{ fontSize: 16, color: st.color }} aria-hidden="true" /></div>
                    <button onClick={() => onUmbrella(l.id)} style={{ flex: 1, minWidth: 0, textAlign: "left", cursor: "pointer", fontFamily: "inherit", color: "var(--ink)", border: "none", background: "transparent", padding: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        <span className="disp" style={{ fontSize: 15, fontWeight: 700 }}>{l.name}</span>
                        {(l.cfg.keepers || []).length > 0 && <span className="chip" style={{ fontSize: 9 }}><i className="ti ti-lock" style={{ fontSize: 9, marginRight: 2 }} aria-hidden="true" />{(l.cfg.keepers || []).length}</span>}
                        {mocks > 0 && <span className="chip" style={{ fontSize: 9 }}>{mocks} mock{mocks === 1 ? "" : "s"}</span>}
                      </div>
                      <div className="mut" style={{ fontSize: 11, marginTop: 1 }}>{l.cfg.teams || 12}T · {l.cfg.sf ? "Superflex" : "1QB"}{l.cfg.tePremMult > 0 ? " · TE+" : ""} · {l.cfg.rounds} rds · <span style={{ color: st.color, fontWeight: 600 }}>{st.label}</span></div>
                    </button>
                    <button className="btn btn-mini" onClick={() => onUmbrella(l.id)} style={{ flexShrink: 0 }}>Open</button>
                    {onDelete && (delConfirm === l.id
                      ? <span style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                          <button className="btn btn-mini" style={{ borderColor: "var(--red)", color: "var(--red)" }} onClick={() => { onDelete(l.id); setDelConfirm(null); }} title="Confirm delete"><i className="ti ti-check" style={{ fontSize: 12 }} aria-hidden="true" /></button>
                          <button className="btn btn-mini" onClick={() => setDelConfirm(null)} title="Cancel"><i className="ti ti-x" style={{ fontSize: 12 }} aria-hidden="true" /></button>
                        </span>
                      : <button className="btn btn-mini" onClick={() => setDelConfirm(l.id)} title="Delete league" style={{ flexShrink: 0, borderColor: "var(--line)", color: "var(--mut)" }}><i className="ti ti-trash" style={{ fontSize: 13 }} aria-hidden="true" /></button>
                    )}
                  </div>
                );
              })}
              {q.trim() && sortedLeagues.length === 0 && (
                <div style={{ textAlign: "center", padding: "10px 0" }}>
                  <div className="mut" style={{ fontSize: 13, marginBottom: 8 }}>No leagues match “{q.trim()}”.</div>
                  <button className="btn btn-gold btn-mini" onClick={() => { setQ(""); onNewLeague(); }}><i className="ti ti-plus" style={{ fontSize: 12, marginRight: 4 }} aria-hidden="true" />Create it as a new league</button>
                </div>
              )}
            </div>
            <div style={{ borderTop: "1px solid var(--line)", marginTop: 10, paddingTop: 10 }}>
              <button className="btn btn-mini" onClick={onDatabase}><i className="ti ti-database" style={{ fontSize: 12, marginRight: 5 }} aria-hidden="true" />Browse all drafts &amp; mocks</button>
            </div>
          </div>
        )}

        {/* RUN-A-MOCK inline box (step 4): quick mock, an existing mock, or a specific league's mock */}
        {mockPick && (
          <div style={{ background: "var(--panel2)", border: "1px solid var(--line)", borderRadius: 12, padding: 14, marginTop: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <i className="ti ti-dice-5" style={{ fontSize: 16, color: "#4FD1A1" }} aria-hidden="true" />
              <div className="disp" style={{ fontSize: 15, fontWeight: 700, flex: 1 }}>Run a mock</div>
              <button className="btn btn-mini" onClick={() => setMockPick(false)}>Close</button>
            </div>
            <div className="mut" style={{ fontSize: 11.5, marginBottom: 10 }}>Practice with a quick mock, re-open a past mock, or mock a specific league's exact settings.</div>
            <button className="hubtile" onClick={() => { setMockPick(false); onQuickMock(); }} style={{ width: "100%", textAlign: "left", cursor: "pointer", fontFamily: "inherit", color: "var(--ink)", border: "1px solid #4FD1A155", background: "#4FD1A114", borderRadius: 11, padding: "11px 13px", display: "flex", alignItems: "center", gap: 11, marginBottom: 10 }}>
              <div style={{ width: 32, height: 32, borderRadius: 9, background: "#4FD1A122", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><i className="ti ti-bolt" style={{ fontSize: 16, color: "#4FD1A1" }} aria-hidden="true" /></div>
              <div style={{ flex: 1 }}><div className="disp" style={{ fontSize: 14, fontWeight: 700 }}>Quick mock</div><div className="mut" style={{ fontSize: 11 }}>Pick a format and go — no league needed.</div></div>
              <span style={{ fontSize: 12, fontWeight: 600, color: "#4FD1A1" }}>Start →</span>
            </button>
            {leagues.length > 0 && (
              <>
                <div className="mut" style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: ".04em", margin: "4px 0 6px" }}>MOCK A SPECIFIC LEAGUE</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 220, overflowY: "auto" }}>
                  {leagues.map((l) => (
                    <button key={l.id} className="hubtile" onClick={() => { setMockPick(false); onMock(l.id); }} style={{ textAlign: "left", cursor: "pointer", fontFamily: "inherit", color: "var(--ink)", border: "1px solid var(--line)", background: "var(--panel2)", borderRadius: 10, padding: "9px 12px", display: "flex", alignItems: "center", gap: 10 }}>
                      <i className="ti ti-clipboard-list" style={{ fontSize: 15, color: "var(--gold)" }} aria-hidden="true" />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="disp" style={{ fontSize: 13.5, fontWeight: 700 }}>{l.name}</div>
                        <div className="mut" style={{ fontSize: 10.5 }}>{l.cfg.teams || 12}T · {l.cfg.sf ? "SF" : "1QB"}{l.cfg.tePremMult > 0 ? " · TE+" : ""} · {(l.mocks || []).length} mock{(l.mocks || []).length === 1 ? "" : "s"} run</div>
                      </div>
                      <span className="gold" style={{ fontSize: 11.5, fontWeight: 600 }}>Mock →</span>
                    </button>
                  ))}
                </div>
              </>
            )}
            <div style={{ borderTop: "1px solid var(--line)", marginTop: 10, paddingTop: 10 }}>
              <button className="btn btn-mini" onClick={onDatabase}><i className="ti ti-database" style={{ fontSize: 12, marginRight: 5 }} aria-hidden="true" />Re-open a past mock from the database</button>
            </div>
          </div>
        )}
        </div>{/* end Get started section */}

        {/* ===== SECTION: YOUR TOOLKIT ===== */}
        <div className="hubsection">
          <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 3 }}>
            <i className="ti ti-tools" style={{ fontSize: 19, color: "var(--gold)" }} aria-hidden="true" />
            <div className="disp" style={{ fontSize: 19, fontWeight: 700 }}>Your toolkit</div>
          </div>
          <div className="mut" style={{ fontSize: 13, marginBottom: 14 }}>Hover any card to see what it does. These work across all your leagues.</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 12 }}>
            {flipTools.map((t, i) => (
              <div key={i} className="flipcard" role="button" tabIndex={0} onClick={t.action} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && t.action()}>
                <div className="flipinner">
                  <div className="flipface" style={{ background: "var(--panel2)" }}>
                    <div style={{ padding: "12px 14px 6px", display: "flex", alignItems: "center", gap: 8 }}>
                      <i className={`ti ${t.icon}`} style={{ fontSize: 18, color: t.color }} aria-hidden="true" />
                      <span className="disp" style={{ fontSize: 15.5, fontWeight: 700 }}>{t.title}</span>
                    </div>
                    <div style={{ flex: 1, padding: "0 10px 10px", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <div style={{ width: "100%", height: "100%", background: t.color + "14", borderRadius: 9, display: "flex", alignItems: "center", justifyContent: "center", padding: 8 }}>
                        <ToolGraphic kind={t.kind} color={t.color} />
                      </div>
                    </div>
                  </div>
                  <div className="flipface flipback">
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                      <div style={{ width: 30, height: 30, borderRadius: 8, background: t.color + "22", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><i className={`ti ${t.icon}`} style={{ fontSize: 16, color: t.color }} aria-hidden="true" /></div>
                      <span className="disp" style={{ fontSize: 14.5, fontWeight: 700 }}>{t.title}</span>
                    </div>
                    <div className="mut" style={{ fontSize: 11.5, lineHeight: 1.45 }}>{t.back}</div>
                    <div className="gold" style={{ fontSize: 11.5, fontWeight: 600, marginTop: 8 }}>Open →</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="mut" style={{ fontSize: 11.5, marginTop: 26, textAlign: "center" }}>Season pass valid through the March 1 league-year cutoff · unlimited leagues & mock drafts.</div>
      </div>
    </div>
  );
}

function BlendDemo() {
  // small fixed cast with a fixed consensus ADP; user reorders and watches Blend recompute live.
  const CONS = { "Ja'Marr Chase": 1.4, "Bijan Robinson": 3.2, "Puka Nacua": 8.1, "De'Von Achane": 11.2, "Malik Nabers": 6.5 };
  const [order, setOrder] = useState(["Puka Nacua", "Ja'Marr Chase", "Malik Nabers", "Bijan Robinson", "De'Von Achane"]);
  const [touched, setTouched] = useState(false);
  const move = (i, d) => { const j = i + d; if (j < 0 || j >= order.length) return; const c = order.slice(); [c[i], c[j]] = [c[j], c[i]]; setOrder(c); setTouched(true); };
  const blend = (name, i) => +(0.65 * (i + 1) + 0.35 * CONS[name]).toFixed(1);
  return (
    <div style={{ fontFamily: "var(--mono)", fontSize: 11.5 }}>
      <div style={{ display: "flex", color: "var(--mut)", padding: "0 6px 5px", borderBottom: "1px solid var(--line)" }}>
        <span style={{ width: 34 }} />
        <span style={{ flex: 1 }}>Player</span>
        <span style={{ width: 40, textAlign: "right" }}>ADP</span>
        <span style={{ width: 38, textAlign: "right", color: "var(--gold)" }}>Mine</span>
        <span style={{ width: 44, textAlign: "right", color: "var(--gold2)" }}>Blend</span>
      </div>
      {order.map((name, i) => (
        <div key={name} style={{ display: "flex", alignItems: "center", padding: "5px 6px", borderBottom: "1px solid #1A1A14", transition: "background .15s" }}>
          <span style={{ width: 34, display: "flex", gap: 2 }}>
            <button onClick={() => move(i, -1)} disabled={i === 0} title="Move up" style={{ background: "none", border: "none", color: i === 0 ? "#3A3A30" : "var(--gold)", cursor: i === 0 ? "default" : "pointer", fontSize: 11, padding: 0, lineHeight: 1 }}>▲</button>
            <button onClick={() => move(i, 1)} disabled={i === order.length - 1} title="Move down" style={{ background: "none", border: "none", color: i === order.length - 1 ? "#3A3A30" : "var(--gold)", cursor: i === order.length - 1 ? "default" : "pointer", fontSize: 11, padding: 0, lineHeight: 1 }}>▼</button>
          </span>
          <span style={{ flex: 1 }}>{name}</span>
          <span style={{ width: 40, textAlign: "right", color: "var(--mut)" }}>{CONS[name].toFixed(1)}</span>
          <span style={{ width: 38, textAlign: "right", color: "var(--gold)", fontWeight: 700 }}>{i + 1}</span>
          <span style={{ width: 44, textAlign: "right", color: "var(--gold2)", fontWeight: 600 }}>{blend(name, i).toFixed(1)}</span>
        </div>
      ))}
      <div className="mut" style={{ fontSize: 10.5, marginTop: 7, textAlign: "center", color: touched ? "var(--gold)" : "var(--mut)" }}>
        {touched ? "↑ Blend recomputes live — your rank, tempered by the market." : "Reorder a player (▲▼) and watch Blend update."}
      </div>
    </div>
  );
}

function AvailDemo() {
  // survival probability decays as more picks happen before your turn. Demo of the real idea.
  const [picks, setPicks] = useState(6);
  // a player with demand d ~ chance any given pick takes him; survival ≈ (1-d)^picks
  const players = [["Breakout RB", 0.16, "var(--rb,#7CD9B2)"], ["WR3 value", 0.07, "var(--wr,#F2B63C)"]];
  const surv = (d) => Math.round(Math.pow(1 - d, picks) * 100);
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
        <span className="mut" style={{ fontSize: 11.5, fontFamily: "var(--mono)" }}>Picks until your turn</span>
        <span className="gold num" style={{ fontSize: 18, fontWeight: 700 }}>{picks}</span>
      </div>
      <input type="range" min="1" max="14" value={picks} onChange={(e) => setPicks(+e.target.value)} style={{ width: "100%", accentColor: "var(--gold)", marginBottom: 12, cursor: "pointer" }} />
      {players.map(([lab, d], i) => {
        const pct = surv(d);
        const col = pct > 60 ? "var(--green)" : pct > 30 ? "var(--gold)" : "var(--red)";
        return (
          <div key={i} style={{ marginBottom: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 3 }}>
              <span style={{ fontWeight: 600 }}>{lab}</span>
              <span className="num" style={{ color: col, fontWeight: 700 }}>{pct}% makes it back</span>
            </div>
            <div style={{ height: 9, borderRadius: 5, background: "#23231C", overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${pct}%`, background: col, borderRadius: 5, transition: "width .25s ease, background .25s" }} />
            </div>
          </div>
        );
      })}
      <div className="mut" style={{ fontSize: 10.5, marginTop: 4, textAlign: "center" }}>Drag the slider — the further your pick, the less likely he survives.</div>
    </div>
  );
}

function HomePage({ biz, user, onSignIn, onDemo, onBuy, onApp, onHelp, initialTab }) {
  // Interactive preview: a live mini board. Hover any player to see the real AI outlook
  // the tool shows; the compass needle swings to "point at" the highlighted pick.
  const previewCfg = { rounds: 12, teams: 12, sf: false, tePrem: false, caps: {}, start: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, SUPER: 0 } };
  setTeams(12); setSpec(previewCfg.start); setOrder("snake"); setPickTrades(null); setTeamNames(TEAM_NAMES_POOL.slice(0, 12));
  const players = useMemo(() => buildPlayers(previewCfg), []);
  const top = useMemo(() => players.slice().sort((a, b) => a.adp - b.adp).slice(0, 12), [players]);
  const [hover, setHover] = useState(null);
  const [tip, setTip] = useState(null);
  const [htab, setHtab] = useState(initialTab || "overview");
  const feats = [
    ["ti-target-arrow", "Projected Picks", "The engine forecasts every pick between now and yours, with live probabilities — recalculated after every single selection."],
    ["ti-chart-dots", "Availability Odds", "Thousands of simulations give you the exact chance your guy survives to your next pick. No more guessing whether he makes it back."],
    ["ti-scale", "Take Now vs. Wait", "Best-player-available is amateur hour. We show what passing actually costs you, position by position."],
    ["ti-flame", "Run Detection", "QB run forming? You'll see it three picks before the rest of your league starts panicking."],
    ["ti-arrows-exchange", "Trade Intelligence", "Format-aware pick values, generated trade packages, and acceptance odds — who to call and exactly what to offer."],
    ["ti-trophy", "Grades & Recap", "Live draft grades, biggest steals and reaches, projected standings, and a shareable recap with receipts."],
  ];
  const showTip = (e, p) => { setHover(p.id); const x = Math.min(e.clientX + 14, window.innerWidth - 320); const y = Math.min(e.clientY + 10, window.innerHeight - 240); setTip({ x, y, content: makeOutlook(p, null, false) }); };
  const hideTip = () => { setHover(null); setTip(null); };
  const heading = hover != null ? (top.findIndex((p) => p.id === hover) / top.length) * 360 : null;
  const paid = !!(user && user.paid);

  return (
    <div>
      <div className="hairline" style={{ display: "flex", alignItems: "center", gap: 16, padding: "12px 20px" }}>
        <Wordmark size={20} />
        <div style={{ flex: 1 }} />
        <button className="btn" onClick={() => onHelp && onHelp("help")}><i className="ti ti-help-circle" style={{ fontSize: 14, marginRight: 5 }} aria-hidden="true" />Help & FAQ</button>
        {paid
          ? <button className="btn btn-gold" onClick={onApp}>Open App</button>
          : user
            ? <button className="btn btn-gold" onClick={onBuy}>Get the Season Pass</button>
            : <button className="btn" onClick={onSignIn}>Sign In</button>}
      </div>

      <div className="hairline" style={{ display: "flex", gap: 4, padding: "0 20px", justifyContent: "center", flexWrap: "wrap" }}>
        {[["overview","Overview"],["how","How to Use It"],["value","Why It's Worth It"]].map(([k, l]) => (
          <button key={k} onClick={() => setHtab(k)} style={{ background: "transparent", border: "none", borderBottom: htab === k ? "2px solid var(--gold)" : "2px solid transparent", color: htab === k ? "var(--gold)" : "var(--mut)", fontWeight: 600, fontSize: 14, padding: "13px 16px", cursor: "pointer", fontFamily: "inherit" }}>{l}</button>
        ))}
      </div>

      {htab === "overview" && (<>

      <div style={{ maxWidth: 1080, margin: "0 auto", padding: "46px 20px 8px", display: "flex", gap: 40, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 380px" }}>
          <div className="disp" style={{ fontSize: 13, letterSpacing: ".22em", color: "var(--gold)", marginBottom: 14 }}>FIND YOUR DIRECTION ON DRAFT DAY</div>
          <div className="disp hero-h">YOUR DRAFT,<br /><span className="gold">TRUE NORTH.</span></div>
          <div className="mut" style={{ fontSize: 17, maxWidth: 520, margin: "18px 0 24px", lineHeight: 1.55 }}>
            Fantasy Draft Compass reads <b style={{ color: "var(--ink)" }}>thousands of real drafts</b> across the fantasy landscape — tracking how players actually come off the board, where the market is trending, and who's getting reached for — then points you to the right pick in real time, recalculating after every selection.
          </div>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            {paid ? <>
              <button className="btn btn-gold" style={{ padding: "13px 26px", fontSize: 16 }} onClick={onApp}>Open the App</button>
              <button className="btn" style={{ padding: "13px 26px", fontSize: 16, border: "1.5px solid #fff" }} onClick={onDemo}>Run a Mock Draft</button>
            </> : <>
              <button className="btn btn-gold" style={{ padding: "13px 26px", fontSize: 16 }} onClick={onDemo}>Try a Free Demo Draft</button>
              <button className="btn" style={{ padding: "13px 26px", fontSize: 16, border: "1.5px solid #fff" }} onClick={onBuy}>Season Pass — ${biz.price.toFixed(2)}</button>
            </>}
          </div>
          <div className="mut" style={{ fontSize: 12, marginTop: 11 }}>{paid ? "Your season pass is active — jump into your leagues anytime." : "Free demo — no signup, no card, no catch. Draft five rounds on the real engine."}</div>
        </div>

        <div style={{ flex: "0 0 300px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16 }}>
          <Compass size={190} spin />
          <div className="disp" style={{ fontSize: 12, letterSpacing: ".18em", color: "var(--mut)", textAlign: "center" }}>TRUE NORTH ON EVERY PICK</div>
        </div>
      </div>

      {/* ===== OVERVIEW BODY — contained sections with consistent rhythm ===== */}
      <div style={{ maxWidth: 1000, margin: "0 auto", padding: "20px 20px 50px", display: "flex", flexDirection: "column", gap: 20 }}>

        {/* SHOWCASE */}
        <div className="hubsection">
          <div style={{ textAlign: "center", marginBottom: 14 }}>
            <div className="disp" style={{ fontSize: 27, fontWeight: 700, lineHeight: 1.1 }}>This isn't a cheat sheet. <span className="gold">It's a draft brain.</span></div>
            <div className="mut" style={{ fontSize: 14, maxWidth: 600, margin: "6px auto 0", lineHeight: 1.5 }}>Pick a topic and actually use it — these are live, working samples of the real tool.</div>
          </div>
          <HeroShowcase />
        </div>

        {/* FORMATS SUPPORTED — quick convincer strip; IDP listed as a peer, not highlighted */}
        <div className="hubsection">
          <div className="disp" style={{ fontSize: 17, fontWeight: 700, textAlign: "center", marginBottom: 3 }}>Built for your league — whatever it is</div>
          <div className="mut" style={{ fontSize: 12.5, textAlign: "center", marginBottom: 14 }}>Every format reprices the board. If you play it, the compass speaks it — including full IDP support.</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center" }}>
            {["Redraft", "Dynasty", "Keeper", "Best ball", "Rookie-only", "1QB", "SuperFlex / 2QB", "PPR / Half / Standard", "TE premium", "IDP — defensive players"].map((t) => (
              <span key={t} className="chip" style={{ fontSize: 12 }}>{t}</span>
            ))}
          </div>
        </div>

        {/* STATS STRIP — slim banded separator beat */}
        <div style={{ display: "flex", gap: 26, justifyContent: "center", flexWrap: "wrap", textAlign: "center", padding: "18px 20px", borderRadius: 14, border: "1px solid var(--line)", background: "linear-gradient(180deg, rgba(214,170,75,0.05), transparent)" }}>
          <div><div className="statline">1,000s</div><div className="mut" style={{ fontSize: 12.5 }}>of real drafts read<br />for board behavior</div></div>
          <div><div className="statline">1,000</div><div className="mut" style={{ fontSize: 12.5 }}>simulations behind every<br />availability percentage</div></div>
          <div><div className="statline">~50%</div><div className="mut" style={{ fontSize: 12.5 }}>of pick positions called<br />(prior-tool track record)</div></div>
          <div><div className="statline">Live</div><div className="mut" style={{ fontSize: 12.5 }}>engine accuracy shown in-app,<br />measured on real drafts</div></div>
        </div>

        {/* FEATURE GRID */}
        <div className="hubsection">
          <div className="disp" style={{ fontSize: 24, fontWeight: 700, textAlign: "center", marginBottom: 4 }}>Everything pointing one way: <span className="gold">your best pick.</span></div>
          <div className="mut" style={{ textAlign: "center", fontSize: 13.5, marginBottom: 20 }}>Six instruments, one readout. <span style={{ opacity: 0.7 }}>Hover any card for the detail.</span></div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 14 }}>
            {feats.map((f, i) => (
              <div key={i} className="flipcard" role="button" tabIndex={0} style={{ height: 132 }}>
                <div className="flipinner">
                  {/* FRONT — icon + title */}
                  <div className="flipface" style={{ background: "var(--panel2)", padding: 16, justifyContent: "center", alignItems: "flex-start" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
                      <div style={{ width: 42, height: 42, borderRadius: 11, background: "rgba(214,170,75,0.14)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                        <i className={`ti ${f[0]}`} style={{ fontSize: 22, color: "var(--gold)" }} aria-hidden="true" />
                      </div>
                      <div className="disp" style={{ fontSize: 18, fontWeight: 700, lineHeight: 1.1 }}>{f[1]}</div>
                    </div>
                  </div>
                  {/* BACK — description */}
                  <div className="flipface flipback" style={{ background: "var(--panel2)" }}>
                    <div className="disp gold" style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 5 }}>{f[1]}</div>
                    <div className="mut" style={{ fontSize: 12.5, lineHeight: 1.5 }}>{f[2]}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* REAL-DRAFT EDGE */}
        <div className="hubsection" style={{ display: "flex", gap: 22, alignItems: "center", flexWrap: "wrap" }}>
          <Compass size={64} spin />
          <div style={{ flex: "1 1 360px" }}>
            <div className="disp" style={{ fontSize: 20, fontWeight: 700, marginBottom: 5 }}>The real-draft edge</div>
            <div className="mut" style={{ fontSize: 13.5, lineHeight: 1.55 }}>
              Public ADP tells you the average. We go deeper — continuously reading thousands of real completed drafts to learn how your <i>exact</i> format actually behaves: where the runs start, which players slide, who gets reached for, and how it's all trending this week. That's the difference between a cheat sheet and a compass.
            </div>
          </div>
        </div>

        {/* PRICING */}
        <div style={{ maxWidth: 560, width: "100%", margin: "0 auto" }}>
        {paid ? (
          <div className="panel" style={{ padding: 26, textAlign: "center", borderColor: "var(--green)" }}>
            <div style={{ display: "flex", justifyContent: "center", marginBottom: 6 }}><Compass size={34} /></div>
            <div className="disp" style={{ fontSize: 22, fontWeight: 700, color: "var(--green)" }}>You're all set</div>
            <div className="mut" style={{ fontSize: 13, margin: "8px 0 14px" }}>Your season pass is active through the March 1 league-year cutoff — unlimited leagues, unlimited mock drafts, every feature. Nothing else to buy.</div>
            <button className="btn btn-gold" style={{ width: "100%", padding: 12, fontSize: 15 }} onClick={onApp}>Open the App</button>
          </div>
        ) : (
          <div className="panel" style={{ padding: 26, textAlign: "center", borderColor: "var(--gold)" }}>
            <div style={{ display: "flex", justifyContent: "center", marginBottom: 6 }}><Compass size={34} /></div>
            <div className="disp" style={{ fontSize: 22, fontWeight: 700 }}>Season Pass</div>
            <div className="disp" style={{ fontSize: 46, fontWeight: 700, color: "var(--gold)", margin: "6px 0" }}>${biz.price.toFixed(2)}<span className="mut" style={{ fontSize: 16 }}>/season</span></div>
            <div className="mut" style={{ fontSize: 13, marginBottom: 14 }}>Valid through the March 1 league-year cutoff. Unlimited leagues, unlimited mock drafts, every feature — Sleeper sync, live predictions, trade tools, and grades.</div>
            <button className="btn btn-gold" style={{ width: "100%", padding: 12, fontSize: 15 }} onClick={onBuy}>Get the Pass</button>
            <div className="mut" style={{ fontSize: 11.5, marginTop: 12 }}>Card · PayPal · Venmo · Apple Pay — handled by our payment processor. Your card details never touch our servers.</div>
          </div>
        )}
        </div>

        {/* FAQ */}
        <div className="hubsection" style={{ maxWidth: 760, width: "100%", margin: "0 auto" }}>
          <div className="disp" style={{ fontSize: 24, fontWeight: 700, marginBottom: 14 }}>FAQ</div>
          {[
            ["Which platforms does it work with?", "Live auto-sync with Sleeper at launch — every pick in the room, traded picks, rosters, and depth charts flow in automatically and the board updates within seconds. Note: you still make your pick inside Sleeper (their draft is the source of truth); we read it live and tell you what to do — we don't draft for you. Every other platform (ESPN, Yahoo, anywhere) works through fast manual entry: type a few letters, hit Enter, done."],
            ["What makes the predictions different?", "We don't just read public ADP — we read thousands of real completed drafts in your format to learn actual board behavior: runs, slides, reaches, and weekly trends. Then 1,000 simulations per pick turn that into live availability odds and recommendations."],
            ["What formats are supported?", "Redraft, dynasty, keeper, best ball, and rookie-only drafts. 1QB and Superflex/2QB. PPR variants and adjustable TE premium. Full IDP support too — start individual defensive players (DL, LB, DB) with their own scoring, and they're projected and ranked right alongside offense. Your league's exact scoring drives every number you see."],
            ["Is my payment information safe?", "Yes — because we never have it. Checkout is handled entirely by our payment processor; card numbers go directly to them and we store only a token. We support card, PayPal, Venmo, and wallets."],
            ["What happens when the season ends?", "Passes run to the March 1 league-year cutoff, then everyone renews together before next draft season. Your leagues and draft history stay saved on your account."],
          ].map((q, i) => <Faq key={i} q={q[0]} a={q[1]} />)}
          <div className="mut" style={{ fontSize: 11.5, marginTop: 24, textAlign: "center" }}>
            Prototype: payments and accounts are simulated; the production build uses a payment processor and managed authentication exactly as described. Player data and depth charts shown here are a static sample — the live product pulls current Sleeper data daily. Accuracy stats reflect the prior tool's track record; the new engine's numbers are measured on real drafts and displayed live in-app.
          </div>
        </div>
      </div>
      </>)}

      {htab === "how" && (
        <div style={{ maxWidth: 880, margin: "0 auto", padding: "34px 20px 50px" }}>
          <div className="disp" style={{ fontSize: 28, fontWeight: 700, marginBottom: 6 }}>How to Use It</div>
          <div className="mut" style={{ fontSize: 14, marginBottom: 24, maxWidth: 640 }}>Five steps from zero to drafting. Set it up, get your reps, then let the compass do the heavy lifting on the clock.</div>
          {[
            ["rankings", "ti-list-numbers", "Set your rankings", "Optional, but powerful: tell the tool where you disagree with the market. Your ranks become a “My ADP” column plus a “Blend” (your read tempered by consensus) right on the draft board, and one global injury/news tweak ripples a player across every board at once."],
            ["create", "ti-plug-connected", "Create or connect a league", "Link Sleeper, ESPN, or Yahoo and we pull in teams, roster slots, scoring, and your draft slot automatically — or build one by hand in under a minute. Your scoring drives every number: add a SuperFlex slot and the whole board re-prices for 2QB; bump TE reception value and tight ends climb."],
            ["open", "ti-stack-2", "Open your league", "Everything you've built lives in one place. Jump into any league to draft, mock, edit settings, or review past drafts — your keepers, pick trades, and rankings all travel with it."],
            ["mock", "ti-dice-5", "Run a mock", "Mocks are your reps on your exact settings. Each one is scored and saved, and the tool surfaces your tendencies across them — where you reach, the values you keep missing — kept separate by format. The more you run, the sharper the read."],
            ["draft", "ti-clock-play", "Draft live, on the clock", "The hub becomes mission control: your recommended pick, the cost of waiting at each position, live availability odds for everyone you're eyeing, runs and slides forming in real time, and selective tags on the players that matter — all recalculating after every pick in the room. Connected to Sleeper, every pick syncs in automatically within seconds; you still make your selection in Sleeper, and the compass reads it live to keep your board current."],
          ].map(([kind, icon, title, body], i) => (
            <div key={i} className="panel" style={{ padding: 0, marginBottom: 12, overflow: "hidden" }}>
              <div style={{ display: "flex", gap: 0, flexWrap: "wrap" }}>
                <div style={{ flex: "1 1 320px", padding: 18, display: "flex", gap: 14, alignItems: "flex-start" }}>
                  <div style={{ flexShrink: 0, width: 38, height: 38, borderRadius: 9, background: "#1A1505", border: "1px solid var(--gold)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <span className="disp gold" style={{ fontSize: 18, fontWeight: 700 }}>{i + 1}</span>
                  </div>
                  <div>
                    <div className="disp" style={{ fontSize: 16, fontWeight: 700, marginBottom: 4, display: "flex", alignItems: "center", gap: 7 }}><i className={`ti ${icon}`} style={{ fontSize: 16, color: "var(--gold)" }} aria-hidden="true" />{title}</div>
                    <div className="mut" style={{ fontSize: 13.5, lineHeight: 1.55 }}>{body}</div>
                  </div>
                </div>
                <div style={{ flex: "1 1 220px", minWidth: 200, background: "var(--panel2)", borderLeft: "1px solid var(--line)", display: "flex", alignItems: "center", justifyContent: "center", padding: "12px 16px" }}>
                  <GuideGraphic kind={kind} />
                </div>
              </div>
            </div>
          ))}
          <div className="panel" style={{ padding: 16, marginTop: 4, marginBottom: 22, background: "var(--panel2)" }}>
            <div className="disp" style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Beyond draft day</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 10 }}>
              {[
                ["ti-arrows-exchange", "Trade Tools", "Format-aware trade values and an evaluator with acceptance odds — weigh any deal, in-season or mid-draft."],
                ["ti-rss", "League News & Movers", "ADP risers/fallers, signings, depth-chart moves, and the injury wire so your board reflects this week."],
                ["ti-trophy", "Grades & recap", "Live grades, biggest steals and reaches, projected standings, and a shareable recap — every league saved to your account."],
              ].map(([icon, t, b], i) => (
                <div key={i} style={{ display: "flex", gap: 9, alignItems: "flex-start" }}>
                  <i className={`ti ${icon}`} style={{ fontSize: 16, color: "var(--gold)", marginTop: 1, flexShrink: 0 }} aria-hidden="true" />
                  <div><div style={{ fontSize: 12.5, fontWeight: 700 }}>{t}</div><div className="mut" style={{ fontSize: 11.5, lineHeight: 1.45 }}>{b}</div></div>
                </div>
              ))}
            </div>
          </div>
          <div style={{ textAlign: "center" }}>
            {paid
              ? <button className="btn btn-gold" style={{ padding: "12px 26px", fontSize: 15 }} onClick={onApp}>Back to Your Hub</button>
              : <button className="btn btn-gold" style={{ padding: "12px 26px", fontSize: 15 }} onClick={onDemo}>Try It Now — Free Demo Draft</button>}
          </div>
        </div>
      )}

      {htab === "value" && (
        <div style={{ maxWidth: 880, margin: "0 auto", padding: "34px 20px 50px" }}>
          <div className="disp" style={{ fontSize: 28, fontWeight: 700, marginBottom: 6 }}>Why It's Worth It</div>
          <div className="mut" style={{ fontSize: 14, marginBottom: 28, maxWidth: 640 }}>A great draft is the cheapest edge in fantasy — it sets your season before week 1. Most tools hand you a static cheat sheet. The compass works the live board with you.</div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(250px,1fr))", gap: 14, marginBottom: 26 }}>
            {[
              ["live", "ti-map-2", "A compass, not a cheat sheet", "Printed rankings are frozen the moment they're made. The compass recalculates after every pick in your room, so the advice is always current to the board in front of you."],
              ["format", "ti-database", "Real drafts, your format", "Instead of one generic ADP, it reads thousands of real drafts and re-prices the board for your exact scoring and roster — the league you're actually in, not the average one."],
              ["decide", "ti-target-arrow", "Decisions, not just data", "It doesn't dump numbers on you. It answers the only question that matters on the clock: who should I take right now, and what does waiting cost me?"],
              ["trust", "ti-shield-check", "Built for trust", "No invented accuracy claims — the engine's hit rate is measured on real drafts and shown live in the app. You see exactly how often it's right."],
            ].map((v, i) => (
              <div key={i} className="panel" style={{ padding: 0, overflow: "hidden" }}>
                <div style={{ background: "var(--panel2)", borderBottom: "1px solid var(--line)", padding: "12px 14px 6px" }}>
                  <WhyGraphic kind={v[0]} />
                </div>
                <div style={{ padding: 16 }}>
                  <div className="disp" style={{ fontSize: 16, fontWeight: 700, marginBottom: 5, display: "flex", alignItems: "center", gap: 8 }}>
                    <i className={`ti ${v[1]}`} style={{ fontSize: 18, color: "var(--gold)" }} aria-hidden="true" />{v[2]}
                  </div>
                  <div className="mut" style={{ fontSize: 13, lineHeight: 1.55 }}>{v[3]}</div>
                </div>
              </div>
            ))}
          </div>

          <div className="panel" style={{ padding: 22, marginBottom: 22 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
              <div className="disp" style={{ fontSize: 19, fontWeight: 700, flex: 1 }}>Cheat Sheet vs. Fantasy Draft Compass</div>
            </div>
            <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
              <div style={{ flex: 1, textAlign: "center", fontSize: 11, fontWeight: 700, letterSpacing: ".06em", color: "var(--red)", textTransform: "uppercase", display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}><i className="ti ti-file-text" aria-hidden="true" />The cheat sheet</div>
              <div style={{ flex: 1, textAlign: "center", fontSize: 11, fontWeight: 700, letterSpacing: ".06em", color: "var(--green)", textTransform: "uppercase", display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}><i className="ti ti-compass" aria-hidden="true" />The compass</div>
            </div>
            {[
              ["Static rankings printed pre-season", "Live board that updates after every pick"],
              ["One generic ADP for everyone", "Re-priced for your exact scoring & roster"],
              ["You guess if your guy makes it back", "Simulated availability odds at your next pick"],
              ["\"Best player available\"", "What waiting actually costs, by position"],
              ["Find out you reached after the draft", "See runs and slides forming in real time"],
              ["No way to practice your format", "Unlimited mocks that learn your tendencies"],
              ["Your opinion lives on a napkin", "Your rankings ride the board, blended with the market"],
              ["Start over every August", "Leagues, ranks & settings carry season to season"],
            ].map((r, i) => (
              <div key={i} style={{ display: "flex", gap: 10, padding: "9px 0", borderTop: i ? "1px solid var(--line)" : "none", alignItems: "center" }}>
                <div style={{ flex: 1, color: "var(--mut)", fontSize: 13, display: "flex", gap: 7, alignItems: "flex-start" }}><i className="ti ti-x" style={{ color: "var(--red)", marginTop: 2, flexShrink: 0 }} aria-hidden="true" /><span>{r[0]}</span></div>
                <div style={{ flex: 1, fontSize: 13, display: "flex", gap: 7, alignItems: "flex-start" }}><i className="ti ti-check" style={{ color: "var(--green)", marginTop: 2, flexShrink: 0 }} aria-hidden="true" /><span>{r[1]}</span></div>
              </div>
            ))}
          </div>

          <div className="panel" style={{ padding: 26, textAlign: "center", borderColor: paid ? "var(--green)" : "var(--gold)", background: "radial-gradient(120% 140% at 50% 0%, rgba(214,170,75,0.10), transparent 60%)" }}>
            <div style={{ display: "flex", justifyContent: "center", marginBottom: 8 }}><Compass size={40} spin /></div>
            <div className="disp" style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>{paid ? "You've got the whole toolkit." : "One pass. Every league. All season."}</div>
            <div className="mut" style={{ fontSize: 13.5, marginBottom: 16, maxWidth: 520, margin: "0 auto 16px" }}>{paid ? "Your season pass unlocks unlimited leagues and mock drafts with every feature — head in and start drafting." : "Unlimited leagues and mock drafts, every feature, through the March 1 league-year cutoff — for the price of about one waiver-claim mistake."}</div>
            <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
              {paid ? <>
                <button className="btn btn-gold" style={{ padding: "12px 26px", fontSize: 15 }} onClick={onApp}>Open the App</button>
                <button className="btn" style={{ padding: "12px 26px", fontSize: 15 }} onClick={onDemo}>Run a Mock Draft</button>
              </> : <>
                <button className="btn btn-gold" style={{ padding: "12px 26px", fontSize: 15 }} onClick={onBuy}>Season Pass — ${biz.price.toFixed(2)}</button>
                <button className="btn" style={{ padding: "12px 26px", fontSize: 15 }} onClick={onDemo}>Try the Free Demo First</button>
              </>}
            </div>
          </div>
        </div>
      )}

      <SiteFooter biz={biz} onDemo={onDemo} onBuy={onBuy} onSignIn={onSignIn} onHelp={onHelp} onTab={setHtab} />

      {tip && (
        <div className="tooltip" style={{ left: tip.x, top: tip.y }}>
          <OutlookCard content={tip.content} />
        </div>
      )}
    </div>
  );
}

function SiteFooter({ biz, onDemo, onBuy, onSignIn, onHelp, onTab }) {
  const year = new Date().getFullYear();
  const goTab = (t) => { onTab && onTab(t); if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" }); };
  const col = (title, links) => (
    <div>
      <div className="disp mut" style={{ fontSize: 10.5, letterSpacing: ".1em", marginBottom: 10 }}>{title}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        {links.map(([label, fn], i) => (
          <button key={i} onClick={fn} style={{ background: "none", border: "none", color: "var(--mut)", fontFamily: "inherit", fontSize: 12.5, textAlign: "left", padding: 0, cursor: "pointer", transition: "color .15s" }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--ink)")} onMouseLeave={(e) => (e.currentTarget.style.color = "var(--mut)")}>{label}</button>
        ))}
      </div>
    </div>
  );
  return (
    <footer style={{ borderTop: "1px solid var(--line)", marginTop: 30, padding: "34px 20px 30px" }}>
      <div style={{ maxWidth: 1080, margin: "0 auto", display: "flex", gap: 40, flexWrap: "wrap", justifyContent: "space-between" }}>
        <div style={{ flex: "1 1 260px", minWidth: 220 }}>
          <Wordmark size={20} />
          <div className="mut" style={{ fontSize: 12.5, lineHeight: 1.55, marginTop: 12, maxWidth: 320 }}>
            Your draft, true north. A live draft compass that reads thousands of real drafts in your exact format and points you to the right pick — in real time.
          </div>
          <div className="mut" style={{ fontSize: 11, marginTop: 14 }}>A Grateful Sheets product.</div>
        </div>
        <div style={{ display: "flex", gap: 48, flexWrap: "wrap" }}>
          {col("PRODUCT", [
            ["Free demo draft", onDemo],
            ["Get the season pass", onBuy],
            ["Sign in", onSignIn],
          ])}
          {col("EXPLORE", [
            ["Overview", () => goTab("overview")],
            ["How to use it", () => goTab("how")],
            ["Why it's worth it", () => goTab("value")],
          ])}
          {col("SUPPORT", [
            ["Help & FAQ", () => onHelp && onHelp("help")],
            ["Contact us", () => onHelp && onHelp("contact")],
            ["Terms & privacy", () => onHelp && onHelp("legal")],
          ])}
        </div>
      </div>
      <div style={{ maxWidth: 1080, margin: "22px auto 0", paddingTop: 18, borderTop: "1px solid var(--line)", display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <span className="mut" style={{ fontSize: 11.5 }}>© {year} Fantasy Draft Compass · Grateful Sheets. All rights reserved.</span>
        <span className="mut" style={{ fontSize: 11.5 }}>Not affiliated with the NFL or any fantasy platform. For entertainment purposes.</span>
      </div>
    </footer>
  );
}
function Faq({ q, a }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="panel" style={{ marginBottom: 8, padding: "12px 16px", cursor: "pointer" }} onClick={() => setOpen((o) => !o)}>
      <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 600 }}>{q}<span className="mut">{open ? "−" : "+"}</span></div>
      {open && <div className="mut" style={{ fontSize: 13.5, marginTop: 8, lineHeight: 1.55 }}>{a}</div>}
    </div>
  );
}

/* ============================================================ AUTH + CHECKOUT */
function AuthModal({ onClose, onSignUp, hasBackend, authError }) {
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");        // confirm password (signup only)
  const [showPw, setShowPw] = useState(false); // show/hide password text
  const [mode, setMode] = useState("signin"); // signin | signup | forgotpw | forgotuser
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const title = mode === "signup" ? "Create your account" : mode === "forgotpw" ? "Reset your password" : mode === "forgotuser" ? "Find your username" : "Sign in";
  const pwMismatch = mode === "signup" && pw2.length > 0 && pw !== pw2;
  const canSubmit = email.includes("@") && pw.length >= 6 && (mode !== "signup" || pw === pw2);
  const submit = async () => { if (!canSubmit) return; setBusy(true); try { await onSignUp(email, pw, mode); } finally { setBusy(false); } };
  // a small reusable eye button for the password fields
  const EyeBtn = () => (
    <button type="button" tabIndex={-1} onClick={() => setShowPw((s) => !s)} aria-label={showPw ? "Hide password" : "Show password"}
      style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "var(--mut)", cursor: "pointer", padding: 4, lineHeight: 0 }}>
      <i className={`ti ${showPw ? "ti-eye-off" : "ti-eye"}`} style={{ fontSize: 16 }} aria-hidden="true" />
    </button>
  );
  return (
    <div className="modalbg" onClick={onClose}>
      <div className="panel" style={{ maxWidth: 380, width: "100%", padding: 22 }} onClick={(e) => e.stopPropagation()}>
        <div className="disp" style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>{title}</div>

        {(mode === "signin" || mode === "signup") && <>
          <div className="mut" style={{ fontSize: 12, marginBottom: 14 }}>{hasBackend ? "Your account is secured with hashed credentials." : "Demo mode — accounts are stored locally in your browser. Connect the backend for real accounts."}</div>
          <input className="gs" style={{ width: "100%", marginBottom: 8 }} placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <div style={{ position: "relative", marginBottom: mode === "signup" ? 8 : 14 }}>
            <input className="gs" type={showPw ? "text" : "password"} style={{ width: "100%", paddingRight: 34 }} placeholder="Password" value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && canSubmit) submit(); }} />
            <EyeBtn />
          </div>
          {mode === "signup" && <>
            <div style={{ position: "relative", marginBottom: 6 }}>
              <input className="gs" type={showPw ? "text" : "password"} style={{ width: "100%", paddingRight: 34, borderColor: pwMismatch ? "var(--red)" : undefined }} placeholder="Confirm password" value={pw2} onChange={(e) => setPw2(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && canSubmit) submit(); }} />
              <EyeBtn />
            </div>
            {pwMismatch && <div style={{ color: "var(--red)", fontSize: 11.5, marginBottom: 8 }}>Passwords don't match</div>}
            {!pwMismatch && <div style={{ height: 6 }} />}
          </>}
          {authError && <div style={{ color: "var(--red)", fontSize: 12, marginBottom: 10 }}>{authError}</div>}
          <button className="btn btn-gold" style={{ width: "100%", padding: 10 }} disabled={busy || !canSubmit} onClick={submit}>{busy ? "…" : mode === "signup" ? "Create account" : "Sign in"}</button>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10, gap: 8, flexWrap: "wrap" }}>
            {mode === "signin"
              ? <button className="btn-link" style={{ background: "none", border: "none", color: "var(--gold)", fontSize: 11.5, cursor: "pointer", fontFamily: "inherit", padding: 0 }} onClick={() => { setMode("signup"); setPw(""); setPw2(""); }}>Need an account? Sign up</button>
              : <button className="btn-link" style={{ background: "none", border: "none", color: "var(--gold)", fontSize: 11.5, cursor: "pointer", fontFamily: "inherit", padding: 0 }} onClick={() => { setMode("signin"); setPw2(""); }}>Have an account? Sign in</button>}
            {mode === "signin" && <span style={{ display: "flex", gap: 8 }}>
              <button className="btn-link" style={{ background: "none", border: "none", color: "var(--mut)", fontSize: 11.5, cursor: "pointer", fontFamily: "inherit", padding: 0 }} onClick={() => { setSent(false); setMode("forgotpw"); }}>Forgot password?</button>
              <button className="btn-link" style={{ background: "none", border: "none", color: "var(--mut)", fontSize: 11.5, cursor: "pointer", fontFamily: "inherit", padding: 0 }} onClick={() => { setSent(false); setMode("forgotuser"); }}>Forgot username?</button>
            </span>}
          </div>
        </>}

        {mode === "forgotpw" && <>
          <div className="mut" style={{ fontSize: 12.5, marginBottom: 14, lineHeight: 1.5 }}>Enter your account email and we'll send a secure password-reset link. The link expires in 30 minutes.</div>
          {sent ? (
            <div className="panel" style={{ padding: 14, background: "var(--panel2)", textAlign: "center" }}>
              <i className="ti ti-mail-check" style={{ fontSize: 22, color: "var(--green)" }} aria-hidden="true" />
              <div style={{ fontSize: 13, marginTop: 6 }}>If an account exists for <b>{email || "that email"}</b>, a reset link is on its way. Check your inbox and spam.</div>
            </div>
          ) : <>
            <input className="gs" style={{ width: "100%", marginBottom: 12 }} placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
            <button className="btn btn-gold" style={{ width: "100%", padding: 10 }} disabled={!email.includes("@")} onClick={() => setSent(true)}>Send reset link</button>
          </>}
          <div className="mut" style={{ fontSize: 11, marginTop: 10, textAlign: "center" }}>Simulated — production sends a real email via the auth provider.</div>
          <button className="btn-link" style={{ background: "none", border: "none", color: "var(--gold)", fontSize: 11.5, cursor: "pointer", fontFamily: "inherit", padding: 0, marginTop: 10, display: "block", margin: "10px auto 0" }} onClick={() => setMode("signin")}>← Back to sign in</button>
        </>}

        {mode === "forgotuser" && <>
          <div className="mut" style={{ fontSize: 12.5, marginBottom: 14, lineHeight: 1.5 }}>Your username is the email you signed up with. Enter an email to confirm whether an account exists for it — we'll email you the details so you don't have to reach out to support.</div>
          {sent ? (
            <div className="panel" style={{ padding: 14, background: "var(--panel2)", textAlign: "center" }}>
              <i className="ti ti-mail-check" style={{ fontSize: 22, color: "var(--green)" }} aria-hidden="true" />
              <div style={{ fontSize: 13, marginTop: 6 }}>If an account matches <b>{email || "that email"}</b>, we've sent its sign-in details there.</div>
            </div>
          ) : <>
            <input className="gs" style={{ width: "100%", marginBottom: 12 }} placeholder="Email to look up" value={email} onChange={(e) => setEmail(e.target.value)} />
            <button className="btn btn-gold" style={{ width: "100%", padding: 10 }} disabled={!email.includes("@")} onClick={() => setSent(true)}>Email me my details</button>
          </>}
          <button className="btn-link" style={{ background: "none", border: "none", color: "var(--gold)", fontSize: 11.5, cursor: "pointer", fontFamily: "inherit", padding: 0, marginTop: 10, display: "block", margin: "10px auto 0" }} onClick={() => setMode("signin")}>← Back to sign in</button>
        </>}
      </div>
    </div>
  );
}

function Checkout({ biz, user, onDone, onBack }) {
  const [method, setMethod] = useState("card");
  const [promo, setPromo] = useState("");
  const [applied, setApplied] = useState(null);
  const [busy, setBusy] = useState(false);
  const price = applied ? +(biz.price * (1 - applied.pct / 100)).toFixed(2) : biz.price;
  const tryPromo = () => { const f = biz.promos.find((p) => p.code.toLowerCase() === promo.trim().toLowerCase()); setApplied(f || null); if (!f) setPromo(""); };
  const pay = () => { setBusy(true); onDone(); };
  // When a real backend is connected, checkout hands off to Stripe (onDone -> startCheckout ->
  // redirect). We don't show the simulated card form in that case.
  if (hasBackend) {
    return (
      <div style={{ maxWidth: 480, margin: "0 auto", padding: "50px 20px" }}>
        <button className="btn btn-mini" onClick={onBack}>← Back</button>
        <div className="panel" style={{ padding: 24, marginTop: 14 }}>
          <div className="disp" style={{ fontSize: 22, fontWeight: 700 }}>Season pass checkout</div>
          <div className="mut" style={{ fontSize: 12.5, margin: "4px 0 16px" }}>{user.email} • valid through March 1</div>
          <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 0", borderBottom: "1px solid var(--line)" }}>
            <span>Fantasy Draft Compass season pass</span><b className="num">${biz.price.toFixed(2)}</b>
          </div>
          <div className="mut" style={{ fontSize: 12.5, margin: "14px 0 16px" }}>You'll be taken to our secure payment page to finish. Your card details are handled entirely by Stripe — they never touch our servers.</div>
          <button className="btn btn-gold" style={{ width: "100%", padding: 12, fontSize: 15 }} onClick={pay} disabled={busy}>{busy ? "Taking you to checkout…" : `Continue to payment — $${biz.price.toFixed(2)}`}</button>
        </div>
      </div>
    );
  }
  const paySim = () => { setBusy(true); setTimeout(onDone, 900); };
  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "50px 20px" }}>
      <button className="btn btn-mini" onClick={onBack}>← Back</button>
      <div className="panel" style={{ padding: 24, marginTop: 14 }}>
        <div className="disp" style={{ fontSize: 22, fontWeight: 700 }}>Season pass checkout</div>
        <div className="mut" style={{ fontSize: 12.5, margin: "4px 0 16px" }}>{user.email} • valid through March 1</div>
        <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 0", borderBottom: "1px solid var(--line)" }}>
          <span>Fantasy Draft Compass season pass</span><b className="num">${price.toFixed(2)}</b>
        </div>
        {applied && <div className="mut" style={{ fontSize: 12, padding: "6px 0", color: "var(--green)" }}>Promo "{applied.code}" applied — {applied.pct}% off</div>}
        <div style={{ display: "flex", gap: 8, margin: "12px 0" }}>
          <input className="gs" style={{ flex: 1 }} placeholder="Promo code" value={promo} onChange={(e) => setPromo(e.target.value)} />
          <button className="btn" onClick={tryPromo}>Apply</button>
        </div>
        <div style={{ display: "flex", gap: 8, margin: "4px 0 14px" }}>
          {[["card","Card"],["paypal","PayPal"],["venmo","Venmo"]].map(([k, l]) => (
            <button key={k} className="btn" style={{ flex: 1, borderColor: method === k ? "var(--gold)" : "var(--line)" }} onClick={() => setMethod(k)}>{l}</button>
          ))}
        </div>
        {method === "card" ? (
          <div className="panel" style={{ padding: 14, background: "var(--panel2)", marginBottom: 14 }}>
            <div className="mut" style={{ fontSize: 11.5, marginBottom: 8 }}>Secure card form — embedded directly from the payment processor. In production this iframe belongs to them; your card number never reaches our servers.</div>
            <input className="gs" style={{ width: "100%", marginBottom: 6 }} placeholder="Card number (simulated — don't enter a real card)" disabled />
            <div style={{ display: "flex", gap: 6 }}>
              <input className="gs" style={{ flex: 1 }} placeholder="MM/YY" disabled /><input className="gs" style={{ flex: 1 }} placeholder="CVC" disabled /><input className="gs" style={{ flex: 1 }} placeholder="ZIP" disabled />
            </div>
          </div>
        ) : (
          <div className="panel" style={{ padding: 14, background: "var(--panel2)", marginBottom: 14 }}>
            <div className="mut" style={{ fontSize: 12 }}>In production this button hands off to {method === "paypal" ? "PayPal" : "Venmo (via PayPal)"} — you approve there and return here with the pass active. Nothing financial is stored on our side.</div>
          </div>
        )}
        <button className="btn btn-gold" style={{ width: "100%", padding: 12, fontSize: 15 }} onClick={paySim} disabled={busy}>{busy ? "Processing…" : `Complete purchase — $${price.toFixed(2)} (simulated)`}</button>
      </div>
    </div>
  );
}

/* ============================================================ LIBRARY + SETUP */
function AppHeader({ user, onAdmin, onSignOut, onHome, onAccount, onApp, onHelp, backLabel, title }) {
  return (
    <div className="hairline appheader" style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 18px", flexWrap: "wrap" }}>
      {onApp && <button className="btn btn-mini" onClick={onApp} title="Go back">← {backLabel || "Back"}</button>}
      <div style={{ cursor: "pointer" }} onClick={onHome}><Wordmark size={18} /></div>
      {title && <div className="chip">{title}</div>}
      <div style={{ flex: 1 }} />
      {user?.paid ? <span className="chip" style={{ color: "var(--green)", cursor: "default" }} title="Your season pass is active"><i className="ti ti-circle-check" style={{ fontSize: 11, marginRight: 3 }} aria-hidden="true" />Season pass active</span> : <span className="chip" style={{ cursor: "default" }} title="You're on the free demo">Free demo</span>}
      {onHome && <button className="btn btn-mini" onClick={onHome} title="Home, FAQ & guides">Home</button>}
      {onHelp && <button className="btn btn-mini" onClick={onHelp} title="Help, contact & terms">Help</button>}
      {user?.admin && <button className="btn" onClick={onAdmin}>Admin</button>}
      {onAccount && <button className="btn" onClick={onAccount} title="Account settings"><i className="ti ti-user" style={{ fontSize: 14 }} aria-hidden="true" /> Account</button>}
      <button className="btn btn-mini" onClick={onSignOut}>Sign out</button>
    </div>
  );
}

// Analyze a league's stored mocks for prep insights: value patterns, landmines, and what
// the best mock outcomes had in common. Pure function — takes mocks + a player lookup.
function analyzeMockTrends(mocks, players, cfg) {
  // A mock contributes once it's gone deep enough to reveal a pattern in YOUR picks — we don't
  // need the whole draft done. Require at least ~3 rounds of picks (or 25% of the draft, whichever
  // is smaller), so realistic partial mocks still produce insights.
  const teams = cfg.teams || 12;
  const minPicks = Math.min(teams * 3, Math.max(teams, Math.round(teams * cfg.rounds * 0.25)));
  const done = (mocks || []).filter((m) => m.picks && m.picks.length >= minPicks);
  if (!done.length) return { n: 0, samples: (mocks || []).length };
  const byId = {}; players.forEach((p) => (byId[p.id] = p));
  const slot = cfg.slot ? cfg.slot - 1 : null;
  // your-pick value across mocks: where you tend to find surplus (player VBD vs pick cost)
  const yourPicksAgg = {}; // playerId -> { times, sumOverall }
  const valByMock = []; // {mock, yourVbd, firstAtPos:{}}
  done.forEach((m) => {
    let yourVbd = 0; const order = [];
    m.picks.forEach((pid, o) => {
      const t = o % teams; const round = Math.floor(o / teams);
      const team = (round % 2 === 0) ? t : teams - 1 - t; // snake approx for analysis
      if (slot != null && team === slot) {
        const p = byId[pid]; if (p) { yourVbd += Math.max(0, p.vbd); order.push({ pid, o, pos: p.pos, vbd: p.vbd }); }
        yourPicksAgg[pid] = yourPicksAgg[pid] || { times: 0, sumO: 0 }; yourPicksAgg[pid].times++; yourPicksAgg[pid].sumO += o + 1;
      }
    });
    valByMock.push({ id: m.id, yourVbd: Math.round(yourVbd), order });
  });
  valByMock.sort((a, b) => b.yourVbd - a.yourVbd);
  const best = valByMock.slice(0, Math.max(1, Math.round(valByMock.length / 3)));
  const worst = valByMock.slice(-Math.max(1, Math.round(valByMock.length / 3)));
  // which positions do your BEST mocks take early (first 3 of your picks) vs worst?
  const earlyPos = (set) => { const c = { QB: 0, RB: 0, WR: 0, TE: 0 }; set.forEach((v) => v.order.slice(0, 3).forEach((x) => { if (c[x.pos] != null) c[x.pos]++; })); return c; };
  const bestEarly = earlyPos(best), worstEarly = earlyPos(worst);
  // recurring value targets: players you got who consistently outperform their pick slot
  const valueTargets = Object.entries(yourPicksAgg).map(([pid, a]) => { const p = byId[pid]; const avgO = a.sumO / a.times; return p ? { name: p.name, pos: p.pos, avgO: Math.round(avgO), times: a.times, vbd: p.vbd, edge: Math.round(p.vbd) } : null; })
    .filter(Boolean).filter((x) => x.times >= Math.max(2, done.length * 0.3)).sort((a, b) => b.vbd - a.vbd).slice(0, 6);
  // landmines: positions where your worst mocks reached early and it cost value
  const landminePos = POS.filter((pos) => worstEarly[pos] > bestEarly[pos] + Math.max(1, best.length * 0.4));
  return {
    n: done.length, samples: (mocks || []).length,
    bestVbd: best.length ? Math.round(best.reduce((s, x) => s + x.yourVbd, 0) / best.length) : 0,
    worstVbd: worst.length ? Math.round(worst.reduce((s, x) => s + x.yourVbd, 0) / worst.length) : 0,
    bestEarly, worstEarly, valueTargets, landminePos,
    enough: done.length >= 8,
  };
}

function MockTrendsPanel({ league, players }) {
  const t = useMemo(() => analyzeMockTrends(league.mocks || [], players, league.cfg), [league, players]);
  if (t.n === 0) return (
    <div className="panel" style={{ padding: 16, marginTop: 10, background: "var(--panel2)" }}>
      <div className="disp" style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>Mock trends <span className="mut" style={{ fontSize: 11 }}>AI prep</span></div>
      <div className="mut" style={{ fontSize: 12.5 }}>Run a few mock drafts for this league and I'll analyze them here — value patterns, landmines, and what your best drafts had in common. {t.samples > 0 ? `(${t.samples} started, none far enough along yet.)` : ""}</div>
    </div>
  );
  const topEarly = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]).filter((x) => x[1] > 0).map((x) => x[0]).slice(0, 2).join(" & ");
  const lines = [];
  lines.push(`Across ${t.n} completed mock${t.n > 1 ? "s" : ""}, your strongest drafts (avg ${t.bestVbd} starter VBD) leaned ${topEarly(t.bestEarly) || "balanced"} early, while your weakest (${t.worstVbd}) ${topEarly(t.worstEarly) ? `over-invested in ${topEarly(t.worstEarly)}` : "lacked a clear plan"}.`);
  if (t.valueTargets.length) lines.push(`Recurring value: ${t.valueTargets.slice(0, 3).map((v) => `${v.name} (${v.pos}, ~pick ${v.avgO})`).join(", ")} kept landing on your roster at a discount — targets to plan around.`);
  if (t.landminePos.length) lines.push(`Landmine: reaching for ${t.landminePos.join("/")} early showed up far more in your worst drafts than your best. Let the board come to you there.`);
  lines.push(t.enough ? `Sample's solid — these patterns are reasonably stable.` : `Only ${t.n} mock${t.n > 1 ? "s" : ""} so far — run a handful more for sharper, more reliable conclusions.`);
  return (
    <div className="panel" style={{ padding: 16, marginTop: 10, background: "var(--panel2)" }}>
      <div className="disp" style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>Mock trends <span className="mut" style={{ fontSize: 11 }}>AI prep · {t.n} analyzed</span></div>
      {lines.map((l, i) => <div key={i} style={{ fontSize: 12.5, lineHeight: 1.55, marginBottom: 6, color: i === lines.length - 1 ? "var(--mut)" : "var(--ink)" }}>{l}</div>)}
      {!t.enough && <div style={{ marginTop: 4 }}><span className="chip" style={{ borderColor: "var(--gold)", color: "var(--gold)" }}>Tip: more mocks = sharper insights</span></div>}
    </div>
  );
}

function MockTrendsLazy({ league }) {
  const players = useMemo(() => {
    setTeams(league.cfg.teams || 12); setSpec(league.cfg.start); setOrder(league.cfg.order || "snake");
    setPickTrades(league.cfg.pickTrades); setKeeperAdds({});
    return buildPlayers(league.cfg);
  }, [league]);
  return <MockTrendsPanel league={league} players={players} />;
}

function TrendsOverTimePage({ user, leagues, funMocks, onBack, onHome, onSignOut, onOpenLeague }) {
  const totalMocks = leagues.reduce((s, l) => s + (l.mocks || []).length, 0) + funMocks.length;
  // Build analyzable buckets, each tied to ONE format so insights are never mixed across formats.
  // League buckets keep their own cfg; quick mocks are grouped by their format key.
  const buckets = useMemo(() => {
    const out = [];
    leagues.forEach((l) => { if ((l.mocks || []).length > 0) out.push({ id: l.id, name: l.name, cfg: l.cfg, mocks: l.mocks, fmt: formatKey(l.cfg), kind: "league" }); });
    // group fun mocks by format key
    const byFmt = {};
    funMocks.forEach((m) => { const k = formatKey(m.cfg); (byFmt[k] = byFmt[k] || []).push(m); });
    Object.entries(byFmt).forEach(([fmt, ms]) => out.push({ id: `__fun__${fmt}`, name: `Quick mocks · ${rankSetLabel(fmt)}`, cfg: ms[0].cfg, mocks: ms, fmt, kind: "fun" }));
    return out;
  }, [leagues, funMocks]);

  // optional format filter — only show buckets matching the chosen format family
  const formats = useMemo(() => { const seen = []; buckets.forEach((b) => { if (!seen.includes(b.fmt)) seen.push(b.fmt); }); return seen; }, [buckets]);
  const [fmtFilter, setFmtFilter] = useState("all");
  const shownBuckets = fmtFilter === "all" ? buckets : buckets.filter((b) => b.fmt === fmtFilter);
  const [selId, setSelId] = useState(buckets[0] ? buckets[0].id : null);
  const sel = shownBuckets.find((b) => b.id === selId) || shownBuckets[0] || null;

  return (
    <div>
      <AppHeader user={user} onSignOut={onSignOut} onHome={onHome} onApp={onBack} title="My Mock Insights" />
      <div style={{ maxWidth: 820, margin: "0 auto", padding: "24px 20px 50px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 14, flexWrap: "wrap" }}>
          <div style={{ flexShrink: 0, width: 44, height: 44, borderRadius: 10, background: "#1A1505", border: "1px solid var(--gold)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <i className="ti ti-chart-line" style={{ fontSize: 22, color: "var(--gold)" }} aria-hidden="true" />
          </div>
          <div style={{ flex: 1 }}>
            <div className="disp" style={{ fontSize: 26, fontWeight: 700 }}>My Mock Insights</div>
            <div className="mut" style={{ fontSize: 13 }}>What your mock drafts reveal about how you draft — value patterns, landmines, and what your best drafts have in common. Insights are kept separate by format.</div>
          </div>
        </div>

        {totalMocks === 0 ? (
          <div className="panel" style={{ padding: 28, textAlign: "center" }}>
            <i className="ti ti-dice" style={{ fontSize: 30, color: "var(--mut)" }} aria-hidden="true" />
            <div className="disp" style={{ fontSize: 18, fontWeight: 700, margin: "10px 0 4px" }}>No mocks yet</div>
            <div className="mut" style={{ fontSize: 13, marginBottom: 14, maxWidth: 460, margin: "0 auto 14px" }}>Run a mock and its read shows up here right away. The more you run in a given format, the sharper the patterns get.</div>
            <button className="btn btn-gold" onClick={onBack}>Back to the hub</button>
          </div>
        ) : (
          <div>
            {/* format filter — keeps different formats from being mixed together */}
            {formats.length > 1 && (
              <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
                <label className="mut" style={{ fontSize: 12 }}>Format:</label>
                <button className="btn btn-mini" style={{ borderColor: fmtFilter === "all" ? "var(--gold)" : "var(--line)", color: fmtFilter === "all" ? "var(--gold)" : "var(--ink)" }} onClick={() => setFmtFilter("all")}>All</button>
                {formats.map((f) => (
                  <button key={f} className="btn btn-mini" style={{ borderColor: fmtFilter === f ? "var(--gold)" : "var(--line)", color: fmtFilter === f ? "var(--gold)" : "var(--ink)" }} onClick={() => { setFmtFilter(f); const first = buckets.find((b) => b.fmt === f); if (first) setSelId(first.id); }}>{rankSetLabel(f)}</button>
                ))}
              </div>
            )}

            <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 16, flexWrap: "wrap" }}>
              <label className="mut" style={{ fontSize: 12.5 }}>Analyzing:</label>
              <select className="gs" value={sel ? sel.id : ""} onChange={(e) => setSelId(e.target.value)} style={{ minWidth: 240 }}>
                {shownBuckets.map((b) => <option key={b.id} value={b.id}>{b.name} — {b.mocks.length} mock{b.mocks.length === 1 ? "" : "s"}</option>)}
              </select>
              {sel && sel.kind === "league" && <button className="btn btn-mini" onClick={() => onOpenLeague(sel.id)}>Open this league →</button>}
            </div>

            {sel ? <MockTrendsLazy league={{ id: sel.id, name: sel.name, cfg: sel.cfg, mocks: sel.mocks }} /> : <div className="mut" style={{ fontSize: 13 }}>Pick a set above.</div>}

            {/* at-a-glance list of every analyzable set, with its format */}
            {buckets.length > 1 && (
              <div style={{ marginTop: 22 }}>
                <div className="disp mut" style={{ fontSize: 11, letterSpacing: ".06em", marginBottom: 8 }}>ALL YOUR MOCK SETS</div>
                {buckets.map((b) => (
                  <div key={b.id} onClick={() => { setSelId(b.id); setFmtFilter("all"); }} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--line)", marginBottom: 6, cursor: "pointer", background: sel && sel.id === b.id ? "#16160F" : "transparent" }}>
                    <i className={`ti ${b.kind === "fun" ? "ti-bolt" : "ti-stack-2"}`} style={{ fontSize: 15, color: "var(--gold)" }} aria-hidden="true" />
                    <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{b.name}</span>
                    <span className="mut" style={{ fontSize: 11.5 }}>{rankSetLabel(b.fmt)}</span>
                    <span className="chip">{b.mocks.length} mock{b.mocks.length === 1 ? "" : "s"}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="mut" style={{ fontSize: 11, marginTop: 18 }}>Mocks are format-specific — a SuperFlex board behaves nothing like a 1QB one, so each format is analyzed on its own.</div>
          </div>
        )}
      </div>
    </div>
  );
}

function DraftsDatabase({ leagues, funMocks, onBack, onOpenLeague, onOpenMock, onOpenFun, user, onSignOut, onHome, onQuickMock, onTrendsTime, onDelete }) {
  const [kind, setKind] = useState("all"); // all | official | mock | fun
  const [typeF, setTypeF] = useState("all");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("recent");
  const [delConfirm, setDelConfirm] = useState(null);

  // flatten everything into one row model
  const rows = useMemo(() => {
    const out = [];
    leagues.forEach((l) => {
      const total = (l.cfg.teams || 12) * l.cfg.rounds;
      out.push({ k: "official", league: l, leagueId: l.id, name: l.name, type: l.cfg.type, teams: l.cfg.teams || 12, rounds: l.cfg.rounds, sf: l.cfg.sf, n: l.picks.length, total, when: l.created, ts: l.id, complete: l.picks.length >= total });
      (l.mocks || []).forEach((m) => out.push({ k: "mock", league: l, leagueId: l.id, mock: m, name: `${l.name} · mock`, type: l.cfg.type, teams: l.cfg.teams || 12, rounds: l.cfg.rounds, sf: l.cfg.sf, n: m.n, total, when: m.ran, ts: +(m.id.split("-")[1] || 0) }));
    });
    funMocks.forEach((m) => { const total = (m.cfg.teams || 12) * m.cfg.rounds; out.push({ k: "fun", fun: m, name: m.name || "Quick mock", type: m.cfg.type, teams: m.cfg.teams || 12, rounds: m.cfg.rounds, sf: m.cfg.sf, n: m.n, total, when: m.ran, ts: +(m.id.split("-")[1] || 0) }); });
    return out;
  }, [leagues, funMocks]);

  const view = useMemo(() => {
    let v = rows.filter((r) => (kind === "all" || r.k === kind) && (typeF === "all" || r.type === typeF) && r.name.toLowerCase().includes(q.toLowerCase()));
    v = v.slice().sort((a, b) => sort === "recent" ? b.ts - a.ts : sort === "name" ? a.name.localeCompare(b.name) : (b.n / b.total) - (a.n / a.total));
    return v;
  }, [rows, kind, typeF, q, sort]);

  const kindBadge = (k) => k === "official" ? ["Official", "var(--gold)"] : k === "mock" ? ["Mock", "var(--green)"] : ["Quick mock", "var(--mut)"];
  const open = (r) => { if (r.k === "official") onOpenLeague(r.leagueId); else if (r.k === "mock") onOpenMock(r.leagueId, r.mock); else onOpenFun(r.fun); };

  return (
    <div>
      <AppHeader user={user} onSignOut={onSignOut} onHome={onHome} onApp={onBack} title="Drafts database" />
      <div style={{ maxWidth: 1000, margin: "0 auto", padding: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 12, flexWrap: "wrap", marginBottom: 4 }}>
          <div>
            <div className="disp" style={{ fontSize: 26, fontWeight: 700, marginBottom: 4 }}>All drafts</div>
            <div className="mut" style={{ fontSize: 13 }}>Every official draft, league mock, and quick mock in one place. Filter, then open any one to review it.</div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {onQuickMock && <button className="btn btn-mini" onClick={() => onQuickMock()} title="Run a standalone mock on simple defaults"><i className="ti ti-bolt" style={{ fontSize: 13, marginRight: 4 }} aria-hidden="true" />Quick mock</button>}
            {onTrendsTime && <button className="btn btn-mini" onClick={() => onTrendsTime()} title="See what your mocks reveal about how you draft"><i className="ti ti-chart-line" style={{ fontSize: 13, marginRight: 4 }} aria-hidden="true" />Trends over time</button>}
          </div>
        </div>
        <div style={{ marginBottom: 16 }} />
        <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ position: "relative", flex: "1 1 200px" }}>
            <i className="ti ti-search" style={{ position: "absolute", left: 9, top: 9, fontSize: 14, color: "var(--mut)" }} aria-hidden="true" />
            <input className="gs" style={{ width: "100%", paddingLeft: 30 }} placeholder="Search by name…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            {[["all","All"],["official","Official"],["mock","Mocks"],["fun","Quick"]].map(([k, l]) => (
              <button key={k} className="btn btn-mini" style={{ borderColor: kind === k ? "var(--gold)" : "var(--line)" }} onClick={() => setKind(k)}>{l}</button>
            ))}
          </div>
          <select className="gs" value={typeF} onChange={(e) => setTypeF(e.target.value)}>
            <option value="all">All formats</option>
            {LEAGUE_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <select className="gs" value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="recent">Most recent</option>
            <option value="name">Name A–Z</option>
            <option value="progress">Most complete</option>
          </select>
        </div>

        {view.length === 0 ? (
          <div className="panel" style={{ padding: 30, textAlign: "center" }}>
            <i className="ti ti-database-off" style={{ fontSize: 26, color: "var(--mut)" }} aria-hidden="true" />
            <div className="mut" style={{ fontSize: 13.5, marginTop: 8 }}>{rows.length === 0 ? "No drafts yet. Run an official draft or a mock and it'll show up here." : "No drafts match your filters."}</div>
            {rows.length > 0 && <button className="btn btn-mini" style={{ marginTop: 12 }} onClick={() => { setKind("all"); setTypeF("all"); setQ(""); }}>Clear filters</button>}
          </div>
        ) : (
          <div className="panel" style={{ overflow: "hidden" }}>
            <div style={{ overflowX: "auto" }}>
              <table className="board" style={{ minWidth: 720 }}>
                <thead><tr>
                  <th>Draft</th><th>Kind</th><th>Format</th><th className="num">Teams</th><th className="num">Progress</th><th>When</th><th></th>
                </tr></thead>
                <tbody>
                  {view.map((r, i) => {
                    const kb = kindBadge(r.k);
                    return (
                      <tr key={i}>
                        <td style={{ fontWeight: 600 }}>{r.name}</td>
                        <td><span style={{ color: kb[1], fontSize: 12 }}>{kb[0]}</span></td>
                        <td className="mut" style={{ fontSize: 12 }}>{LEAGUE_TYPES.find((t) => t[0] === r.type)?.[1] || "Redraft"}{r.sf ? " · SF" : ""}</td>
                        <td className="num">{r.teams}</td>
                        <td className="num">{r.complete ? <span className="gold">complete</span> : `${r.n}/${r.total}`}</td>
                        <td className="mut" style={{ fontSize: 12 }}>{r.when}</td>
                        <td><div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                          <button className="btn btn-mini" onClick={() => open(r)}>open</button>
                          {onDelete && r.k === "official" && (delConfirm === r.leagueId
                            ? <>
                                <button className="btn btn-mini" style={{ borderColor: "var(--red)", color: "var(--red)" }} onClick={() => { onDelete(r.leagueId); setDelConfirm(null); }} title="Confirm delete"><i className="ti ti-check" style={{ fontSize: 12 }} aria-hidden="true" /></button>
                                <button className="btn btn-mini" onClick={() => setDelConfirm(null)} title="Cancel"><i className="ti ti-x" style={{ fontSize: 12 }} aria-hidden="true" /></button>
                              </>
                            : <button className="btn btn-mini" onClick={() => setDelConfirm(r.leagueId)} title="Delete league" style={{ borderColor: "var(--line)", color: "var(--mut)" }}><i className="ti ti-trash" style={{ fontSize: 12 }} aria-hidden="true" /></button>
                          )}
                        </div></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
        <div className="mut" style={{ fontSize: 11.5, marginTop: 14 }}>{view.length} of {rows.length} drafts shown. Mocks stay attached to their league's umbrella; quick mocks stand alone.</div>
      </div>
    </div>
  );
}

function LeagueCard({ l, onUmbrella, onDelete, onOpenMockView, onDeleteMock }) {
  const [showMocks, setShowMocks] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const total = (l.cfg.teams || 12) * l.cfg.rounds;
  const st = l.picks.length >= total ? "complete" : l.picks.length > 0 ? "progress" : "mock";
  const badge = st === "complete" ? ["Complete", "var(--green)"] : st === "progress" ? ["In progress", "var(--gold)"] : ["Not started", "var(--mut)"];
  const mocks = l.mocks || [];
  return (
    <div className="panel" style={{ padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div className="disp" style={{ fontSize: 18, fontWeight: 700 }}>{l.name}</div>
        <span style={{ fontSize: 11, color: badge[1] }}>{badge[0]}</span>
      </div>
      <div style={{ display: "flex", gap: 6, margin: "8px 0", flexWrap: "wrap" }}>
        <span className="chip">{l.cfg.teams || 12} teams</span>
        <span className="chip">{l.cfg.sf ? "Superflex" : "1QB"}{l.cfg.tePremMult > 0 ? ` · TE+${l.cfg.tePremMult}` : ""}</span>
        <span className="chip">{l.cfg.rounds} rds{l.cfg.slot ? ` · slot ${l.cfg.slot}` : " · slot TBD"}</span>
      </div>
      <div className="mut" style={{ fontSize: 12, marginBottom: 6 }}>{st === "complete" ? "Official draft complete" : `${l.picks.length}/${total} picks`} • {LEAGUE_TYPES.find((t) => t[0] === l.cfg.type)?.[1] || "Redraft"}{mocks.length ? ` • ${mocks.length} mock${mocks.length === 1 ? "" : "s"}` : ""} • created {l.created}</div>
      {(l.cfg.keepers || []).length > 0 && <div className="gold" style={{ fontSize: 11, marginBottom: 6 }}><i className="ti ti-lock" style={{ fontSize: 11, marginRight: 4 }} aria-hidden="true" />{(l.cfg.keepers || []).length} keeper{(l.cfg.keepers || []).length > 1 ? "s" : ""} set — applied to the official draft and every mock</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button className="btn btn-gold" style={{ flex: 1 }} onClick={() => onUmbrella(l.id)}><i className="ti ti-layout-dashboard" style={{ fontSize: 13, marginRight: 5 }} aria-hidden="true" />Open league</button>
        {mocks.length > 0 && <button className="btn btn-mini" onClick={() => setShowMocks((s) => !s)} title="Peek at this league's mock history">{showMocks ? "Hide" : `Mocks (${mocks.length})`}</button>}
        <button className="btn btn-mini" onClick={() => setConfirmDel(true)} title="Delete league" style={{ borderColor: "var(--line)", color: "var(--mut)" }}><i className="ti ti-trash" style={{ fontSize: 13 }} aria-hidden="true" /></button>
      </div>
      <div className="mut" style={{ fontSize: 10.5, marginTop: 6 }}>Official draft, mocks, and settings all live in the league hub.</div>
      {confirmDel && (
        <div className="panel" style={{ padding: 12, marginTop: 8, borderColor: "var(--red)", background: "var(--panel2)" }}>
          <div style={{ fontSize: 13, marginBottom: 8 }}>Delete <b>{l.name}</b> and all its mock drafts? This can't be undone.</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-mini" style={{ borderColor: "var(--red)", color: "var(--red)" }} onClick={() => { setConfirmDel(false); onDelete(l.id); }}>Yes, delete</button>
            <button className="btn btn-mini" onClick={() => setConfirmDel(false)}>No, keep it</button>
          </div>
        </div>
      )}
      {showMocks && mocks.length > 0 && (
        <div style={{ marginTop: 10, borderTop: "1px solid var(--line)", paddingTop: 8 }}>
          <div className="disp mut" style={{ fontSize: 11, letterSpacing: ".06em", marginBottom: 6 }}>MOCK DRAFT HISTORY</div>
          <div style={{ maxHeight: 180, overflowY: "auto" }}>
            {mocks.map((m, i) => (
              <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", fontSize: 12 }}>
                <span className="mut num" style={{ width: 20 }}>#{mocks.length - i}</span>
                <span style={{ flex: 1 }}>{m.ran}</span>
                <span className="mut">{m.n}/{total}</span>
                <button className="btn btn-mini" onClick={() => onOpenMockView(l.id, m)} title="Re-open this mock draft">view</button>
                <button className="btn btn-mini" onClick={() => onDeleteMock(l.id, m.id)} title="Delete this mock">✕</button>
              </div>
            ))}
          </div>
          <div className="mut" style={{ fontSize: 10.5, marginTop: 6 }}>Last {Math.min(50, mocks.length)} mocks saved. Mocks never touch your real draft.</div>
          <MockTrendsLazy league={l} />
        </div>
      )}
    </div>
  );
}

function Library({ user, leagues, onNew, onUmbrella, onDelete, onAdmin, onSignOut, onHome, onAccount, onDeleteMock, onOpenMockView, onQuickMock, onDatabase, onTrends, onHelp, funMockCount }) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("date");
  const [filter, setFilter] = useState("all");
  const statusOf = (l) => { const total = (l.cfg.teams || 12) * l.cfg.rounds; if (l.picks.length >= total) return "complete"; if (l.picks.length > 0) return "progress"; return "mock"; };
  const view = useMemo(() => {
    let v = leagues.filter((l) => l.name.toLowerCase().includes(q.toLowerCase()));
    if (filter !== "all") v = v.filter((l) => statusOf(l) === filter);
    v = v.slice().sort((a, b) => sort === "name" ? a.name.localeCompare(b.name) : sort === "date" ? b.id - a.id : (b.picks.length / ((b.cfg.teams || 12) * b.cfg.rounds)) - (a.picks.length / ((a.cfg.teams || 12) * a.cfg.rounds)));
    return v;
  }, [leagues, q, sort, filter]);
  return (
    <div>
      <AppHeader user={user} onAdmin={onAdmin} onSignOut={onSignOut} onHome={onHome} onAccount={onAccount} onHelp={onHelp} onApp={user?.paid ? onHome : undefined} backLabel="Hub" title="League library" />
      <div style={{ maxWidth: 940, margin: "0 auto", padding: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
          <div className="disp" style={{ fontSize: 26, fontWeight: 700 }}>Your leagues</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn" onClick={() => onDatabase()} title="Browse all drafts in a table"><i className="ti ti-database" style={{ fontSize: 13, marginRight: 4 }} aria-hidden="true" />Drafts database</button>
            {onTrends && <button className="btn" onClick={() => onTrends()} title="Recent market trends"><i className="ti ti-rss" style={{ fontSize: 13, marginRight: 4 }} aria-hidden="true" />Recent trends</button>}
            <button className="btn" onClick={() => onQuickMock()} title="Run a standalone mock with simple defaults — not tied to a league"><i className="ti ti-dice" style={{ fontSize: 13, marginRight: 4 }} aria-hidden="true" />Quick mock</button>
            <button className="btn btn-gold" onClick={onNew}>+ New draft</button>
          </div>
        </div>
        {leagues.length > 0 && (
          <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
            <div style={{ position: "relative", flex: "1 1 200px" }}>
              <i className="ti ti-search" style={{ position: "absolute", left: 9, top: 9, fontSize: 14, color: "var(--mut)" }} aria-hidden="true" />
              <input className="gs" style={{ width: "100%", paddingLeft: 30 }} placeholder="Search leagues…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <div style={{ display: "flex", gap: 4 }}>
              {[["all","All"],["progress","In progress"],["complete","Complete"],["mock","Not started"]].map(([k, l]) => (
                <button key={k} className="btn btn-mini" style={{ borderColor: filter === k ? "var(--gold)" : "var(--line)" }} onClick={() => setFilter(k)}>{l}</button>
              ))}
            </div>
            <select className="gs" value={sort} onChange={(e) => setSort(e.target.value)}>
              <option value="date">Newest first</option>
              <option value="name">Name A–Z</option>
              <option value="progress">Most complete</option>
            </select>
          </div>
        )}
        {leagues.length === 0 && (
          <div className="panel" style={{ padding: 30, textAlign: "center" }}>
            <div style={{ display: "flex", justifyContent: "center", marginBottom: 10 }}><Compass size={40} spin /></div>
            <div className="disp" style={{ fontSize: 20, fontWeight: 700, marginBottom: 6 }}>No leagues yet</div>
            <div className="mut" style={{ fontSize: 13.5, marginBottom: 16 }}>Create your first league — pick your settings, then run the draft live or as a mock. Leagues save to your account and persist between sessions.</div>
            <button className="btn btn-gold" onClick={onNew}>Set up a league</button>
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(270px,1fr))", gap: 12 }}>
          {view.map((l) => <LeagueCard key={l.id} l={l} onUmbrella={onUmbrella} onDelete={onDelete} onDeleteMock={onDeleteMock} onOpenMockView={onOpenMockView} />)}
        </div>
        {leagues.length > 0 && view.length === 0 && <div className="mut" style={{ textAlign: "center", padding: 20 }}>No leagues match your search.</div>}
        <div className="mut" style={{ fontSize: 11.5, marginTop: 20 }}>In the full product this library also holds connected Sleeper leagues (auto-imported settings, rosters, live pick sync), keepers, trades, personal ranks, and mock imports per league.</div>
      </div>
    </div>
  );
}

function Account({ user, onUpdate, onBack, onHome, onSignOut, onRankings }) {
  const [email, setEmail] = useState(user.email);
  const [fav, setFav] = useState(user.fav || "");
  const [pw, setPw] = useState("");
  const [saved, setSaved] = useState("");
  const flash = (m) => { setSaved(m); setTimeout(() => setSaved(""), 1500); };
  return (
    <div>
      <AppHeader user={user} onSignOut={onSignOut} onHome={onHome} onApp={onBack} title="Account" />
      <div style={{ maxWidth: 520, margin: "0 auto", padding: "28px 20px" }}>
        <button className="btn btn-mini" onClick={onBack} style={{ marginBottom: 14 }}>← Library</button>
        <div className="panel" style={{ padding: 24 }}>
          <div className="disp" style={{ fontSize: 24, fontWeight: 700, marginBottom: 4 }}>Account settings</div>
          <div className="mut" style={{ fontSize: 12, marginBottom: 18 }}>Simulated in this prototype — production stores these via the managed auth provider; passwords are hashed and never visible to us.</div>
          <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid var(--line)", marginBottom: 14 }}>
            <span className="mut" style={{ fontSize: 13 }}>Membership</span>
            <span style={{ color: user.paid ? "var(--green)" : "var(--gold)" }}>{user.paid ? "Season pass active — valid through Mar 1" : "Free demo"}</span>
          </div>
          <div style={{ marginBottom: 13 }}>
            <label className="mut" style={{ fontSize: 13, display: "block", marginBottom: 4 }}>Email</label>
            <div style={{ display: "flex", gap: 8 }}>
              <input className="gs" style={{ flex: 1 }} value={email} onChange={(e) => setEmail(e.target.value)} />
              <button className="btn" onClick={() => { if (email.includes("@")) { onUpdate({ email }); flash("Email updated"); } }}>Update</button>
            </div>
          </div>
          <div style={{ marginBottom: 13 }}>
            <label className="mut" style={{ fontSize: 13, display: "block", marginBottom: 4 }}>Favorite NFL team</label>
            <div style={{ display: "flex", gap: 8 }}>
              <select className="gs" style={{ flex: 1 }} value={fav} onChange={(e) => setFav(e.target.value)}>
                <option value="">None</option>
                {NFL_TEAMS.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <button className="btn" onClick={() => { onUpdate({ fav }); flash("Favorite team saved"); }}>Save</button>
            </div>
            <div className="mut" style={{ fontSize: 11, marginTop: 3 }}>Used to flag your own homer tendencies in your draft recaps.</div>
          </div>
          <div style={{ marginBottom: 8 }}>
            <label className="mut" style={{ fontSize: 13, display: "block", marginBottom: 4 }}>Change password</label>
            <div style={{ display: "flex", gap: 8 }}>
              <input className="gs" type="password" style={{ flex: 1 }} placeholder="New password" value={pw} onChange={(e) => setPw(e.target.value)} />
              <button className="btn" onClick={() => { if (pw.length >= 4) { setPw(""); flash("Password changed"); } }}>Change</button>
            </div>
          </div>
          {saved && <div style={{ color: "var(--green)", fontSize: 12.5, marginTop: 10 }}>{saved} ✓</div>}
        </div>

        <div className="panel" style={{ padding: 18, marginTop: 14 }}>
          <div className="disp" style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Your player rankings</div>
          <div className="mut" style={{ fontSize: 12.5, marginBottom: 12 }}>Build your own board, work top-down so you never skip a player, and make global injury/news adjustments that ripple across every format.</div>
          {onRankings && <button className="btn btn-gold" onClick={onRankings}><i className="ti ti-list-numbers" style={{ fontSize: 14, marginRight: 5 }} aria-hidden="true" />Open rankings</button>}
        </div>
      </div>
    </div>
  );
}

function RankingsHub({ user, leagues, onUpdate, onBack, onHome, onSignOut, onNewLeague }) {
  const allSets = (user.rankSets) || [];
  const season = user.season || CURRENT_SEASON;
  const [view, setView] = useState("home"); // home | editor
  const [editId, setEditId] = useState(null);
  const [flash, setFlash] = useState("");
  const flashMsg = (m) => { setFlash(m); setTimeout(() => setFlash(""), 1800); };

  // persist the full sets array
  const saveSets = (sets, msg) => { onUpdate({ rankSets: sets }); if (msg) flashMsg(msg); };

  // ----- landing state -----
  const [q, setQ] = useState("");
  const seasonSets = allSets.filter((s) => (s.season || CURRENT_SEASON) === season);
  const shown = q.trim() ? seasonSets.filter((s) => s.name.toLowerCase().includes(q.toLowerCase()) || setSettingsKey(s).toLowerCase().includes(q.toLowerCase())) : seasonSets;
  const leagueName = (id) => { const l = leagues.find((x) => x.id === id); return l ? l.name : null; };

  // ----- create-set form -----
  const [showCreate, setShowCreate] = useState(false);
  const [cName, setCName] = useState("");
  const [cType, setCType] = useState("redraft");
  const [cQb, setCQb] = useState("1QB");
  const [cTe, setCTe] = useState("std");
  const [cLeague, setCLeague] = useState("");
  const matchLeague = (id) => { const l = leagues.find((x) => x.id === id); if (!l) return; setCType(l.cfg.type === "keeper" ? "dynasty" : l.cfg.type === "bestball" ? "bestball" : l.cfg.type === "dynasty" ? "dynasty" : "redraft"); setCQb(((l.cfg.start && l.cfg.start.SUPER > 0) || l.cfg.sf) ? "SF" : "1QB"); setCTe(l.cfg.tePremMult > 0 ? "tep" : "std"); };
  const createSet = (seed) => {
    const id = `rs-${Date.now()}`;
    const set = { id, name: cName.trim() || "Untitled ranks", season, type: cType, qbType: cQb, teType: cTe, leagueId: cLeague || null, list: seed || [], created: new Date().toLocaleDateString() };
    saveSets([set, ...allSets], "Ranking set created");
    setShowCreate(false); setCName(""); setCLeague(""); setEditId(id); setView("editor");
  };

  // ----- import picker -----
  const [showImport, setShowImport] = useState(false);
  const [impQ, setImpQ] = useState("");
  const importInto = null; // set when importing into a new set (we copy list)

  // ----- per-set actions -----
  const duplicateSet = (s) => { const id = `rs-${Date.now()}`; const copy = { ...s, id, name: `${s.name} (copy)`, leagueId: null, created: new Date().toLocaleDateString() }; saveSets([copy, ...allSets], "Duplicated — tweak it for another league"); setEditId(id); setView("editor"); };
  const deleteSet = (id) => saveSets(allSets.filter((s) => s.id !== id), "Ranking set deleted");
  const openSet = (id) => { setEditId(id); setView("editor"); };
  const updateSet = (id, patch) => saveSets(allSets.map((s) => (s.id === id ? { ...s, ...patch, edited: new Date().toLocaleDateString(), editedTs: Date.now() } : s)));

  // ----- season "run it back" -----
  const runItBack = (fromSeason) => {
    const src = allSets.filter((s) => (s.season || CURRENT_SEASON) === fromSeason);
    const copies = src.map((s) => ({ ...s, id: `rs-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, season, created: new Date().toLocaleDateString() }));
    saveSets([...copies, ...allSets], `Copied ${copies.length} set${copies.length === 1 ? "" : "s"} from ${fromSeason} into ${season}`);
  };

  // ---------- EDITOR ----------
  const editing = allSets.find((s) => s.id === editId);
  if (view === "editor" && editing) {
    return <RankSetEditor user={user} set={editing} leagues={leagues} allSets={allSets}
      onBackToList={() => setView("home")} onBack={onBack} onHome={onHome} onSignOut={onSignOut}
      onSaveList={(list) => updateSet(editing.id, { list })}
      onRename={(name) => updateSet(editing.id, { name })}
      onAttach={(leagueId) => updateSet(editing.id, { leagueId })}
      onAdj={(rankAdj) => onUpdate({ rankAdj })}
      onImportList={(list) => updateSet(editing.id, { list })} />;
  }

  // ---------- LANDING ----------
  return (
    <div>
      <AppHeader user={user} onSignOut={onSignOut} onHome={onHome} onApp={onBack} title="Rankings" />
      <div style={{ maxWidth: 860, margin: "0 auto", padding: "24px 20px 50px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", marginBottom: 14 }}>
          <Compass size={40} />
          <div style={{ flex: 1 }}>
            <div className="disp" style={{ fontSize: 26, fontWeight: 700 }}>Your rankings</div>
            <div className="mut" style={{ fontSize: 13 }}>Named boards you can duplicate, attach to a league, and carry across seasons. Each shows as “My ADP” + “Blend” columns in matching drafts.</div>
          </div>
          <select className="gs" value={season} onChange={(e) => onUpdate({ season: +e.target.value })} title="Active season">
            {SEASONS.map((y) => <option key={y} value={y}>{y} season</option>)}
          </select>
        </div>

        {flash && <div style={{ color: "var(--green)", fontSize: 12.5, marginBottom: 10 }}>{flash} ✓</div>}

        <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ position: "relative", flex: "1 1 200px" }}>
            <i className="ti ti-search" style={{ position: "absolute", left: 9, top: 9, fontSize: 14, color: "var(--mut)" }} aria-hidden="true" />
            <input className="gs" style={{ width: "100%", paddingLeft: 30 }} placeholder="Search your ranking sets…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <button className="btn btn-gold" onClick={() => { setShowCreate(true); setCName(""); }}>+ New ranking set</button>
        </div>

        {/* CREATE FORM */}
        {showCreate && (
          <div className="panel" style={{ padding: 18, marginBottom: 14, borderColor: "var(--gold)" }}>
            <div className="disp" style={{ fontSize: 17, fontWeight: 700, marginBottom: 10 }}>New ranking set</div>
            <div style={{ marginBottom: 10 }}>
              <label className="mut" style={{ fontSize: 12, display: "block", marginBottom: 3 }}>Name</label>
              <input className="gs" style={{ width: "100%" }} placeholder="e.g. My 2026 PPR board" value={cName} onChange={(e) => setCName(e.target.value)} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 10 }}>
              <div><label className="mut" style={{ fontSize: 12, display: "block", marginBottom: 3 }}>Type</label>
                <select className="gs" style={{ width: "100%" }} value={cType} onChange={(e) => setCType(e.target.value)}>
                  <option value="redraft">Redraft</option><option value="dynasty">Dynasty / Keeper</option><option value="bestball">Best ball</option>
                </select></div>
              <div><label className="mut" style={{ fontSize: 12, display: "block", marginBottom: 3 }}>QB format</label>
                <select className="gs" style={{ width: "100%" }} value={cQb} onChange={(e) => setCQb(e.target.value)}><option value="1QB">1QB</option><option value="SF">Superflex</option><option value="2QB">2QB</option></select></div>
              <div><label className="mut" style={{ fontSize: 12, display: "block", marginBottom: 3 }}>TE format</label>
                <select className="gs" style={{ width: "100%" }} value={cTe} onChange={(e) => setCTe(e.target.value)}><option value="std">Standard</option><option value="tep">TE premium</option></select></div>
            </div>
            <div style={{ marginBottom: 12 }}>
              <label className="mut" style={{ fontSize: 12, display: "block", marginBottom: 3 }}>Attach to a league (optional — matches its exact settings)</label>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <select className="gs" style={{ flex: 1, minWidth: 180 }} value={cLeague} onChange={(e) => { setCLeague(e.target.value); if (e.target.value) matchLeague(e.target.value); }}>
                  <option value="">Not attached — by settings only</option>
                  {leagues.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
                <button className="btn btn-mini" onClick={() => onNewLeague()} title="Create a league first, then attach">+ New league</button>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button className="btn btn-gold" onClick={() => createSet([])}>Create & start ranking</button>
              {allSets.length > 0 && <button className="btn" onClick={() => setShowImport(true)}>Start from an existing set…</button>}
              <div style={{ flex: 1 }} />
              <button className="btn" onClick={() => setShowCreate(false)}>Cancel</button>
            </div>
          </div>
        )}

        {/* IMPORT PICKER (copy a prior set's list into a new set) */}
        {showImport && (
          <div className="modalbg" onClick={() => setShowImport(false)}>
            <div className="panel" style={{ maxWidth: 520, width: "100%", padding: 18, maxHeight: "80vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
              <div className="disp" style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Import from an existing set</div>
              <div className="mut" style={{ fontSize: 12, marginBottom: 12 }}>Copies that set's player order into your new set — then tweak from there.</div>
              <div style={{ position: "relative", marginBottom: 10 }}>
                <i className="ti ti-search" style={{ position: "absolute", left: 9, top: 9, fontSize: 14, color: "var(--mut)" }} aria-hidden="true" />
                <input className="gs" style={{ width: "100%", paddingLeft: 30 }} placeholder="Search your sets…" value={impQ} onChange={(e) => setImpQ(e.target.value)} />
              </div>
              {allSets.filter((s) => !impQ.trim() || s.name.toLowerCase().includes(impQ.toLowerCase())).map((s) => (
                <button key={s.id} className="btn" style={{ width: "100%", textAlign: "left", marginBottom: 6, display: "flex", alignItems: "center", gap: 8 }} onClick={() => { createSet(s.list || []); setShowImport(false); }}>
                  <i className="ti ti-list-numbers" style={{ fontSize: 15, color: "var(--gold)" }} aria-hidden="true" />
                  <span style={{ flex: 1 }}><b>{s.name}</b> <span className="mut" style={{ fontSize: 11 }}>· {rankSetLabel(setSettingsKey(s))}{s.leagueId ? ` · ${leagueName(s.leagueId) || "league"}` : ""} · {s.season || CURRENT_SEASON}</span></span>
                  <span className="mut" style={{ fontSize: 11 }}>{(s.list || []).length} ranked</span>
                </button>
              ))}
              {allSets.length === 0 && <div className="mut" style={{ fontSize: 13 }}>No prior sets to import.</div>}
            </div>
          </div>
        )}

        {/* SET LIST */}
        {shown.length === 0 ? (
          <div className="panel" style={{ padding: 26, textAlign: "center" }}>
            <div className="mut" style={{ fontSize: 13.5, marginBottom: 12 }}>{seasonSets.length === 0 ? `No ranking sets for the ${season} season yet.` : "No sets match your search."}</div>
            {seasonSets.length === 0 && (
              <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
                <button className="btn btn-gold" onClick={() => setShowCreate(true)}>+ Create your first set</button>
                {allSets.some((s) => (s.season || CURRENT_SEASON) !== season) && SEASONS.filter((y) => y !== season && allSets.some((s) => (s.season || CURRENT_SEASON) === y)).map((y) => (
                  <button key={y} className="btn" onClick={() => runItBack(y)}>Run it back from {y}</button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {shown.map((s) => (
              <div key={s.id} className="panel" style={{ padding: 14, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <i className="ti ti-list-numbers" style={{ fontSize: 22, color: "var(--gold)" }} aria-hidden="true" />
                <div style={{ flex: 1, minWidth: 180 }}>
                  <div style={{ fontWeight: 700, fontSize: 15 }}>{s.name}</div>
                  <div className="mut" style={{ fontSize: 11.5 }}>{rankSetLabel(setSettingsKey(s))}{s.leagueId ? ` · attached to ${leagueName(s.leagueId) || "a league"}` : ""} · {(s.list || []).length} ranked · {s.season || CURRENT_SEASON}</div>
                </div>
                <button className="btn btn-mini btn-gold" onClick={() => openSet(s.id)}>Edit</button>
                <button className="btn btn-mini" onClick={() => duplicateSet(s)} title="Make a copy to tweak for another league">Duplicate</button>
                <button className="btn btn-mini" onClick={() => deleteSet(s.id)} title="Delete this set">✕</button>
              </div>
            ))}
          </div>
        )}

        {/* CROSS-SEASON HELPER */}
        {seasonSets.length > 0 && SEASONS.filter((y) => y !== season && allSets.some((s) => (s.season || CURRENT_SEASON) === y)).length > 0 && (
          <div className="panel" style={{ padding: 14, marginTop: 16, background: "var(--panel2)" }}>
            <div style={{ fontSize: 13, marginBottom: 8 }}><b>Run it back.</b> Carry rankings from a prior season into {season}:</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {SEASONS.filter((y) => y !== season && allSets.some((s) => (s.season || CURRENT_SEASON) === y)).map((y) => (
                <button key={y} className="btn btn-mini" onClick={() => runItBack(y)}>Copy {y} sets → {season}</button>
              ))}
            </div>
          </div>
        )}

        <div className="mut" style={{ fontSize: 11, marginTop: 18 }}>Everything here lives in your account across seasons. The active-season set whose settings match a league (or one you attach directly) powers that league's “My ADP” and “Blend” columns.</div>
      </div>
    </div>
  );
}

function RankSetEditor({ user, set, leagues, allSets, onBackToList, onBack, onHome, onSignOut, onSaveList, onRename, onAttach, onAdj, onImportList }) {
  const [mode, setMode] = useState("list"); // list | board | adjust
  const [flash, setFlash] = useState("");
  const flashMsg = (m) => { setFlash(m); setTimeout(() => setFlash(""), 1600); };
  const cfg = useMemo(() => {
    const qb = set.qbType || "1QB"; const te = set.teType || "std";
    return { rounds: 15, teams: 12, caps: {}, start: { QB: qb === "2QB" ? 2 : 1, RB: 2, WR: 2, TE: 1, FLEX: 1, SUPER: qb === "SF" ? 1 : 0, DST: 0, K: 0 }, sf: qb === "SF" || qb === "2QB", tePremMult: te === "tep" ? 1 : 0, type: set.type };
  }, [set]);
  const players = useMemo(() => { setTeams(12); setSpec(cfg.start); setOrder("snake"); setPickTrades(null); setKeeperAdds({}); return buildPlayers(cfg); }, [cfg]);
  const byId = useMemo(() => { const m = {}; players.forEach((p) => (m[p.id] = p)); return m; }, [players]);
  const byAdp = useMemo(() => players.slice().sort((a, b) => a.adp - b.adp), [players]);

  const [list, setList] = useState(set.list || []);
  const [name, setName] = useState(set.name);
  const [search, setSearch] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [impQ, setImpQ] = useState("");
  useEffect(() => { setList(set.list || []); setName(set.name); }, [set.id]);

  const inList = new Set(list);
  const adj = user.rankAdj || {};
  const results = search.trim() ? players.filter((p) => !inList.has(p.id) && p.name.toLowerCase().includes(search.toLowerCase())).slice(0, 8) : [];
  const add = (id) => { setList((l) => [...l, id]); setSearch(""); };
  const remove = (id) => setList((l) => l.filter((x) => x !== id));
  const move = (i, dir) => setList((l) => { const j = i + dir; if (j < 0 || j >= l.length) return l; const c = l.slice(); [c[i], c[j]] = [c[j], c[i]]; return c; });
  // Drag-and-drop reorder (native HTML5 DnD — no library). dragFrom holds the index being dragged.
  const [dragFrom, setDragFrom] = useState(null);
  const [dragOver, setDragOver] = useState(null);
  const reorder = (from, to) => setList((l) => {
    if (from == null || to == null || from === to || from < 0 || to < 0 || from >= l.length || to >= l.length) return l;
    const c = l.slice(); const [moved] = c.splice(from, 1); c.splice(to, 0, moved); return c;
  });
  // O(1) lookup of a player's position in the list (avoids O(n²) indexOf in the board view).
  const listIndex = useMemo(() => { const m = {}; list.forEach((id, i) => (m[id] = i)); return m; }, [list]);
  // Virtualized scrolling: only render the rows visible in the scroll viewport (+ a buffer). This is
  // what keeps a 200+ player list fast — without it the browser chokes rendering every row at once.
  const ROW_H = 38;          // fixed row height (px)
  const VIEW_H = 380;        // scroll viewport height (px)
  const BUFFER = 6;          // extra rows above/below for smooth scroll
  const [scrollTop, setScrollTop] = useState(0);
  const firstVisible = Math.max(0, Math.floor(scrollTop / ROW_H) - BUFFER);
  const visibleCount = Math.ceil(VIEW_H / ROW_H) + BUFFER * 2;
  const lastVisible = Math.min(list.length, firstVisible + visibleCount);
  // Auto-scroll the list while dragging near its top/bottom edge, so you can drag a player far up or
  // down in one motion instead of dropping, scrolling, and re-grabbing.
  const scrollBoxRef = useRef(null);
  const autoScrollRef = useRef(0); // current scroll speed (px/frame); 0 = idle
  const rafRef = useRef(null);
  const runAutoScroll = () => {
    const el = scrollBoxRef.current;
    if (el && autoScrollRef.current !== 0) {
      el.scrollTop += autoScrollRef.current;
      rafRef.current = requestAnimationFrame(runAutoScroll);
    } else {
      rafRef.current = null;
    }
  };
  const handleDragAutoScroll = (e) => {
    const el = scrollBoxRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const y = e.clientY;
    const EDGE = 48; // px from each edge that triggers scrolling
    let speed = 0;
    if (y < rect.top + EDGE) speed = -Math.ceil((rect.top + EDGE - y) / 4);      // near top → scroll up
    else if (y > rect.bottom - EDGE) speed = Math.ceil((y - (rect.bottom - EDGE)) / 4); // near bottom → down
    autoScrollRef.current = Math.max(-18, Math.min(18, speed));
    if (autoScrollRef.current !== 0 && rafRef.current == null) rafRef.current = requestAnimationFrame(runAutoScroll);
  };
  const stopAutoScroll = () => { autoScrollRef.current = 0; if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; } };
  const prefillTop = (n) => setList(byAdp.slice(0, n).map((p) => p.id));
  const fillRest = () => setList((l) => { const have = new Set(l); return [...l, ...byAdp.filter((p) => !have.has(p.id)).map((p) => p.id)]; });
  const saveList = () => { onSaveList(list); flashMsg("Rankings saved"); };
  const placedSet = new Set(list);

  // adjustments
  const setAdjEntry = (pname, entry) => { const next = { ...(user.rankAdj || {}) }; if (entry) next[pname] = entry; else delete next[pname]; onAdj(next); };
  const [adjSearch, setAdjSearch] = useState("");
  const [adjPick, setAdjPick] = useState(null);
  const [adjKind, setAdjKind] = useState("model");
  const [adjN, setAdjN] = useState("10");
  const [adjRationale, setAdjRationale] = useState("significant");
  const adjResults = adjSearch.trim() ? players.filter((p) => p.name.toLowerCase().includes(adjSearch.toLowerCase())).slice(0, 8) : [];
  const applyAdj = () => {
    if (!adjPick) return;
    const entry = adjKind === "remove" ? { kind: "remove" } : adjKind === "model" ? { kind: "model", rationale: adjRationale } : { kind: adjKind, n: +adjN || 0 };
    setAdjEntry(adjPick.name, { ...entry, ts: new Date().toLocaleDateString() });
    // Physically move the player in YOUR list so the change is visible immediately.
    const pid = adjPick.id;
    setList((l) => {
      const from = l.indexOf(pid);
      if (entry.kind === "remove") return from >= 0 ? l.filter((x) => x !== pid) : l;
      if (from < 0) return l; // not in this list; the global adj still applies elsewhere
      let to = from;
      if (entry.kind === "down-spots") to = from + (entry.n || 0);
      else if (entry.kind === "down-pct") to = from + Math.round(l.length * (entry.n || 0) / 100);
      else if (entry.kind === "model") { const ms = MODEL_SHIFTS[entry.rationale]; if (ms && ms.removed) return l.filter((x) => x !== pid); to = from + Math.round(l.length * ((ms && ms.pct) || 0.15)); }
      to = Math.max(0, Math.min(l.length - 1, to));
      if (to === from) return l;
      const c = l.slice(); c.splice(from, 1); c.splice(to, 0, pid); return c;
    });
    setAdjPick(null); setAdjSearch(""); flashMsg(adjKind === "remove" ? "Removed and adjusted across your rankings" : "Moved and adjusted across your rankings");
  };
  const RATIONALES = [["season-ending","Season-ending injury (remove)"],["significant","Significant injury"],["suspension","Suspension"],["lost-job","Lost starting job"],["playing-time","Playing-time concern"],["minor","Minor injury"]];

  return (
    <div>
      <AppHeader user={user} onSignOut={onSignOut} onHome={onHome} onApp={onBack} title="Rankings" />
      <div style={{ maxWidth: 820, margin: "0 auto", padding: "20px 20px 50px" }}>
        <button className="btn btn-mini" onClick={() => { onSaveList(list); onBackToList(); }} style={{ marginBottom: 12 }}>← All ranking sets</button>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 6 }}>
          <input className="gs disp" style={{ fontSize: 20, fontWeight: 700, flex: "1 1 220px", minWidth: 0 }} value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== set.name && onRename(name.trim())} />
        </div>
        <div className="mut" style={{ fontSize: 12, marginBottom: 6 }}>{rankSetLabel(setSettingsKey(set))} · {set.season || CURRENT_SEASON} season{set.leagueId ? "" : " · not attached to a league"}</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
          <label className="mut" style={{ fontSize: 12 }}>Attached league:</label>
          <select className="gs" value={set.leagueId || ""} onChange={(e) => onAttach(e.target.value || null)}>
            <option value="">None (match by settings)</option>
            {leagues.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          {allSets.length > 1 && <button className="btn btn-mini" onClick={() => setShowImport(true)}>Import from another set</button>}
        </div>

        {showImport && (
          <div className="modalbg" onClick={() => setShowImport(false)}>
            <div className="panel" style={{ maxWidth: 520, width: "100%", padding: 18, maxHeight: "80vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
              <div className="disp" style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Import player order</div>
              <div className="mut" style={{ fontSize: 12, marginBottom: 12 }}>Replaces this set's list with the chosen set's order. You can tweak afterward.</div>
              <div style={{ position: "relative", marginBottom: 10 }}>
                <i className="ti ti-search" style={{ position: "absolute", left: 9, top: 9, fontSize: 14, color: "var(--mut)" }} aria-hidden="true" />
                <input className="gs" style={{ width: "100%", paddingLeft: 30 }} placeholder="Search your sets…" value={impQ} onChange={(e) => setImpQ(e.target.value)} />
              </div>
              {allSets.filter((s) => s.id !== set.id && (!impQ.trim() || s.name.toLowerCase().includes(impQ.toLowerCase()))).map((s) => (
                <button key={s.id} className="btn" style={{ width: "100%", textAlign: "left", marginBottom: 6, display: "flex", alignItems: "center", gap: 8 }} onClick={() => { setList(s.list || []); onImportList(s.list || []); setShowImport(false); flashMsg("Imported"); }}>
                  <i className="ti ti-list-numbers" style={{ fontSize: 15, color: "var(--gold)" }} aria-hidden="true" />
                  <span style={{ flex: 1 }}><b>{s.name}</b> <span className="mut" style={{ fontSize: 11 }}>· {rankSetLabel(setSettingsKey(s))} · {s.season || CURRENT_SEASON}</span></span>
                  <span className="mut" style={{ fontSize: 11 }}>{(s.list || []).length} ranked</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="hairline" style={{ display: "flex", gap: 4, marginBottom: 14, flexWrap: "wrap" }}>
          {[["list","My rankings"],["adjust","Global adjustments"]].map(([k, l]) => (
            <button key={k} onClick={() => setMode(k)} style={{ background: "transparent", border: "none", borderBottom: mode === k ? "2px solid var(--gold)" : "2px solid transparent", color: mode === k ? "var(--gold)" : "var(--mut)", fontWeight: 600, fontSize: 14, padding: "9px 14px", cursor: "pointer", fontFamily: "inherit" }}>{l}{k === "adjust" && Object.keys(adj).length > 0 ? ` (${Object.keys(adj).length})` : ""}</button>
          ))}
        </div>
        {flash && <div style={{ color: "var(--green)", fontSize: 12.5, marginBottom: 10 }}>{flash} ✓</div>}

        {mode === "list" && (
          <div>
            {list.length === 0 && (
              <div className="panel" style={{ padding: 12, marginBottom: 12, background: "var(--panel2)" }}>
                <div className="mut" style={{ fontSize: 12.5, marginBottom: 8 }}>Start from the full consensus board and reorder to taste, or build it up yourself.</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <button className="btn btn-mini btn-gold" onClick={() => prefillTop(byAdp.length)}>Start from consensus board</button>
                  {allSets && allSets.filter((s) => s.id !== set.id && (s.list || []).length).length > 0 && <button className="btn btn-mini" onClick={() => setShowImport(true)}>Start from a saved set</button>}
                </div>
              </div>
            )}
            <div style={{ position: "relative", marginBottom: 10 }}>
              <i className="ti ti-search" style={{ position: "absolute", left: 10, top: 9, fontSize: 14, color: "var(--mut)" }} aria-hidden="true" />
              <input className="gs" style={{ width: "100%", paddingLeft: 30 }} placeholder="Add a player to your ranks…" value={search} onChange={(e) => setSearch(e.target.value)} />
              {results.length > 0 && (
                <div className="panel" style={{ position: "absolute", top: 38, left: 0, right: 0, zIndex: 10, padding: 6, maxHeight: 230, overflowY: "auto" }}>
                  {results.map((p) => (
                    <button key={p.id} className="btn" style={{ width: "100%", textAlign: "left", marginBottom: 4, display: "flex", alignItems: "center", gap: 8 }} onClick={() => add(p.id)}>
                      <Dot pos={p.pos} /><span style={{ flex: 1 }}>{p.name}</span><span className="mut" style={{ fontSize: 11 }}>{p.pos}{p.posRank} · ADP {p.adp.toFixed(1)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            {list.length > 0 && (
              <div ref={scrollBoxRef} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
                onDragOver={(e) => { e.preventDefault(); handleDragAutoScroll(e); }}
                onDrop={stopAutoScroll}
                style={{ height: VIEW_H, overflowY: "auto", marginBottom: 12 }}>
                {/* total-height spacer keeps the scrollbar correct; we only render the visible window */}
                <div style={{ height: list.length * ROW_H, position: "relative" }}>
                  {list.slice(firstVisible, lastVisible).map((id, idx) => { const i = firstVisible + idx; const p = byId[id]; if (!p) return null; const a = adj[p.name];
                    const isDragging = dragFrom === i;
                    const isOver = dragOver === i && dragFrom !== i;
                    return (
                    <div key={id}
                      draggable
                      onDragStart={(e) => { setDragFrom(i); e.dataTransfer.effectAllowed = "move"; }}
                      onDragEnter={(e) => { e.preventDefault(); setDragOver(i); }}
                      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}
                      onDrop={(e) => { e.preventDefault(); reorder(dragFrom, i); setDragFrom(null); setDragOver(null); stopAutoScroll(); }}
                      onDragEnd={() => { setDragFrom(null); setDragOver(null); stopAutoScroll(); }}
                      style={{
                        position: "absolute", top: i * ROW_H, left: 0, right: 0, height: ROW_H,
                        display: "flex", alignItems: "center", gap: 8, padding: "0 6px", fontSize: 13,
                        borderRadius: 7, userSelect: "none", boxSizing: "border-box",
                        background: isDragging ? "rgba(214,170,75,0.18)" : isOver ? "rgba(214,170,75,0.08)" : "transparent",
                        borderTop: isOver ? "2px solid var(--gold)" : "2px solid transparent",
                        opacity: isDragging ? 0.5 : 1, cursor: "grab",
                      }}>
                      <i className="ti ti-grip-vertical" style={{ fontSize: 15, color: "var(--mut)", cursor: "grab" }} aria-hidden="true" title="Drag to reorder" />
                      <span className="num mut" style={{ width: 24 }}>{i + 1}</span>
                      <Dot pos={p.pos} /><span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name} <span className="mut" style={{ fontSize: 11 }}>{p.pos}{p.posRank}</span>{a && <span className="chip" style={{ marginLeft: 6, fontSize: 9, borderColor: "var(--red)", color: "var(--red)" }}>adjusted</span>}</span>
                      <button className="btn btn-mini" onClick={() => move(i, -1)} disabled={i === 0} title="Move up" style={{ padding: "2px 6px" }}><i className="ti ti-chevron-up" style={{ fontSize: 12 }} aria-hidden="true" /></button>
                      <button className="btn btn-mini" onClick={() => move(i, 1)} disabled={i === list.length - 1} title="Move down" style={{ padding: "2px 6px" }}><i className="ti ti-chevron-down" style={{ fontSize: 12 }} aria-hidden="true" /></button>
                      <button className="btn btn-mini" onClick={() => remove(id)} title="Remove" style={{ padding: "2px 6px" }}><i className="ti ti-x" style={{ fontSize: 12 }} aria-hidden="true" /></button>
                    </div>
                  ); })}
                </div>
              </div>
            )}
            <div className="mut" style={{ fontSize: 11, marginBottom: 10, marginTop: -4 }}><i className="ti ti-info-circle" style={{ fontSize: 12, marginRight: 4 }} aria-hidden="true" />Drag the <i className="ti ti-grip-vertical" style={{ fontSize: 11 }} aria-hidden="true" /> handle to reorder, or use the arrows. {list.length > 0 && <b style={{ color: "var(--ink)" }}>{list.length} ranked.</b>}</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <button className="btn btn-gold" onClick={saveList}>Save ranks</button>
              {list.length > 0 && <button className="btn btn-mini" onClick={fillRest} title="Append the rest of the board (by consensus) below what you've already ranked">Fill rest of board</button>}
              {list.length > 0 && <button className="btn btn-mini" onClick={() => setList([])}>Clear all</button>}
            </div>
          </div>
        )}

        {mode === "adjust" && (
          <div>
            <div className="mut" style={{ fontSize: 12.5, marginBottom: 12 }}>Adjust a player once and it ripples across <b style={{ color: "var(--ink)" }}>every</b> ranking set and the consensus board.</div>
            <div className="panel" style={{ padding: 16, marginBottom: 14 }}>
              <div style={{ position: "relative", marginBottom: adjPick ? 12 : 0 }}>
                <i className="ti ti-search" style={{ position: "absolute", left: 10, top: 9, fontSize: 14, color: "var(--mut)" }} aria-hidden="true" />
                <input className="gs" style={{ width: "100%", paddingLeft: 30 }} placeholder="Find the player to adjust…" value={adjPick ? adjPick.name : adjSearch} onChange={(e) => { setAdjPick(null); setAdjSearch(e.target.value); }} />
                {!adjPick && adjResults.length > 0 && (
                  <div className="panel" style={{ position: "absolute", top: 38, left: 0, right: 0, zIndex: 10, padding: 6, maxHeight: 230, overflowY: "auto" }}>
                    {adjResults.map((p) => (
                      <button key={p.id} className="btn" style={{ width: "100%", textAlign: "left", marginBottom: 4, display: "flex", alignItems: "center", gap: 8 }} onClick={() => { setAdjPick(p); setAdjSearch(""); }}>
                        <Dot pos={p.pos} /><span style={{ flex: 1 }}>{p.name}</span><span className="mut" style={{ fontSize: 11 }}>{p.pos}{p.posRank} · ADP {p.adp.toFixed(1)}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {adjPick && (
                <div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
                    {[["model","Let the model decide"],["remove","Remove entirely"],["down-spots","Down N spots"],["down-pct","Down N%"]].map(([k, l]) => (
                      <button key={k} className="btn btn-mini" style={{ borderColor: adjKind === k ? "var(--gold)" : "var(--line)" }} onClick={() => setAdjKind(k)}>{l}</button>
                    ))}
                  </div>
                  {adjKind === "model" && (
                    <select className="gs" style={{ width: "100%", marginBottom: 10 }} value={adjRationale} onChange={(e) => setAdjRationale(e.target.value)}>
                      {RATIONALES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                    </select>
                  )}
                  {(adjKind === "down-spots" || adjKind === "down-pct") && (
                    <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
                      <input className="gs" style={{ width: 90 }} value={adjN} onChange={(e) => setAdjN(e.target.value.replace(/\D/g, ""))} />
                      <span className="mut" style={{ fontSize: 12 }}>{adjKind === "down-spots" ? "spots down" : "% down the board"}</span>
                    </div>
                  )}
                  <button className="btn btn-gold" onClick={applyAdj}>Apply to {adjPick.name} everywhere</button>
                </div>
              )}
            </div>
            {Object.keys(adj).length > 0 ? (
              <div>
                <div className="disp mut" style={{ fontSize: 11, letterSpacing: ".06em", marginBottom: 8 }}>ACTIVE ADJUSTMENTS</div>
                {Object.entries(adj).map(([pname, a]) => (
                  <div key={pname} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 0", borderTop: "1px solid var(--line)", fontSize: 13 }}>
                    <span style={{ flex: 1 }}><b>{pname}</b> <span className="mut" style={{ fontSize: 11.5 }}>— {a.kind === "remove" ? "removed" : a.kind === "model" ? (RATIONALES.find((r) => r[0] === a.rationale)?.[1] || a.rationale) : a.kind === "down-spots" ? `down ${a.n} spots` : `down ${a.n}%`}{a.ts ? ` · ${a.ts}` : ""}</span></span>
                    <button className="btn btn-mini" onClick={() => setAdjEntry(pname, null)}>Undo</button>
                  </div>
                ))}
              </div>
            ) : <div className="mut" style={{ fontSize: 13 }}>No active adjustments.</div>}
          </div>
        )}
      </div>
    </div>
  );
}


const LEAGUE_TYPES = [["redraft","Redraft"],["dynasty","Dynasty"],["bestball","Best ball"],["rookie","Rookie only"]];
const NFL_TEAMS = ["ARI","ATL","BAL","BUF","CAR","CHI","CIN","CLE","DAL","DEN","DET","GB","HOU","IND","JAX","KC","LV","LAC","LAR","MIA","MIN","NE","NO","NYG","NYJ","PHI","PIT","SF","SEA","TB","TEN","WAS"];
const DRAFT_ORDERS = [["snake","Snake"],["linear","Linear (same order each round)"],["3rr","Third-round reversal"]];
// Platforms we can connect to for live sync. Sleeper is supported via its free public API. Other
// platforms either have no usable public draft API or require fragile credentials, so those users
// draft with fast manual entry — which has the exact same engine, advice, and tracking.
const PLATFORMS = [
  { id: "sleeper", name: "Sleeper", field: "Sleeper username", hint: "We read your leagues from Sleeper's free public API and sync your draft live.", icon: "ti-moon" },
];

// League-connect box: pick a platform, provide its credential. Sleeper does a REAL fetch of your
// leagues so you can pick which one to connect (and sync live). Other platforms are still simulated.
function ConnectBox({ connect, onConnect, onClear }) {
  const [open, setOpen] = useState(false);
  // When Sleeper is the only platform, skip the platform picker entirely and go straight to the
  // username step — one fewer click on the path everyone takes.
  const [sel, setSel] = useState(PLATFORMS.length === 1 ? PLATFORMS[0] : null);
  const [val, setVal] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [sleeperLeagues, setSleeperLeagues] = useState(null); // null=not fetched, []=none, [...]=list
  if (connect) {
    const p = PLATFORMS.find((x) => x.id === connect.platform);
    return (
      <div className="panel" style={{ padding: 12, marginBottom: 14, background: "#0E1206", borderColor: "#3A4A1A", display: "flex", alignItems: "center", gap: 10 }}>
        <i className={`ti ${p?.icon || "ti-link"}`} style={{ fontSize: 20, color: "var(--green)" }} aria-hidden="true" />
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, color: "var(--green)" }}>Connected to {p?.name}{connect.leagueName ? ` · ${connect.leagueName}` : ""}</div>
          <div className="mut" style={{ fontSize: 11.5 }}>{connect.platform === "sleeper" ? "Picks sync live during your draft. Settings below are pre-filled from this league — adjust if needed." : "Settings, teams, rosters & live picks sync automatically. Fields below are pre-filled — adjust if needed."}</div>
        </div>
        <button className="btn btn-mini" onClick={onClear}>Disconnect</button>
      </div>
    );
  }
  // Sleeper: fetch the user's leagues so they can choose one.
  const fetchSleeperLeagues = async () => {
    setError(null); setBusy(true); setSleeperLeagues(null);
    try {
      if (!hasBackend) { setError("Connecting a live league needs the backend (you're running locally)."); setBusy(false); return; }
      const r = await api.sleeperLeagues(val.trim());
      setSleeperLeagues(r.leagues || []);
      if (!r.leagues || r.leagues.length === 0) setError("No leagues found for that username this season.");
    } catch (e) { setError(e.data?.error || e.message || "Couldn't reach Sleeper."); }
    finally { setBusy(false); }
  };
  // Pick a specific Sleeper league → pull its draft config + picks, hand up to the league form.
  const pickSleeperLeague = async (lg) => {
    setError(null); setBusy(true);
    try {
      const d = await api.sleeperDraft(lg.league_id, val.trim());
      onConnect({
        platform: "sleeper", credential: val.trim(), username: val.trim(),
        leagueId: lg.league_id, leagueName: lg.name,
        draftId: d.draft_id || lg.draft_id || null,
        cfg: d.cfg || null, picks: d.picks || [], status: d.status || lg.draft_status || null,
        teams: d.teams || null, yourSlot: d.yourSlot || null, slotNames: d.slotNames || null,
        draftType: d.draftType || "snake", tradedPicks: d.tradedPicks || [], keepers: d.keepers || [],
      });
      setOpen(false); setSel(null); setVal(""); setSleeperLeagues(null);
    } catch (e) { setError(e.data?.error || e.message || "Couldn't load that league's draft."); }
    finally { setBusy(false); }
  };
  const doConnect = () => { setBusy(true); setTimeout(() => { setBusy(false); setOpen(false); onConnect({ platform: sel.id, credential: val || "(oauth)" }); setSel(null); setVal(""); }, 800); };
  const statusChip = (s) => {
    if (s === "drafting") return { t: "Drafting now", c: "var(--green)" };
    if (s === "complete") return { t: "Draft complete", c: "var(--mut)" };
    if (s === "pre_draft") return { t: "Pre-draft", c: "var(--gold)" };
    if (s === "paused") return { t: "Paused", c: "var(--gold)" };
    return null;
  };
  return (
    <div style={{ marginBottom: 16 }}>
      {!open ? (
        <button className="btn btn-gold" style={{ width: "100%", padding: 13, fontSize: 14, fontWeight: 700 }} onClick={() => setOpen(true)}>
          <i className="ti ti-brand-sleeper" style={{ fontSize: 16, marginRight: 2 }} aria-hidden="true" /><i className="ti ti-bolt" style={{ fontSize: 15 }} aria-hidden="true" /> Connect your Sleeper league — instant setup & live sync
        </button>
      ) : (
        <div className="panel" style={{ padding: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div className="disp" style={{ fontSize: 15, fontWeight: 700 }}>Connect your league</div>
            <button className="btn btn-mini" onClick={() => { setOpen(false); setSel(PLATFORMS.length === 1 ? PLATFORMS[0] : null); setSleeperLeagues(null); setError(null); }}>Cancel</button>
          </div>
          {!sel ? (
            <div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(150px,1fr))", gap: 8 }}>
                {PLATFORMS.map((p) => (
                  <button key={p.id} className="btn" style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-start", padding: "9px 11px" }} onClick={() => { setSel(p); setVal(""); setSleeperLeagues(null); setError(null); }}>
                    <i className={`ti ${p.icon}`} style={{ fontSize: 17, color: "var(--gold)" }} aria-hidden="true" />{p.name}
                  </button>
                ))}
              </div>
              <div className="panel" style={{ marginTop: 10, padding: "10px 12px", background: "var(--panel2)" }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 3 }}>On another platform (ESPN, Yahoo, CBS, Fantrax, etc.)?</div>
                <div className="mut" style={{ fontSize: 11.5, lineHeight: 1.5 }}>No problem — close this and set the league up by hand. You enter each pick as it happens (it's fast), and you get the <b style={{ color: "var(--ink)" }}>exact same</b> engine: live recommendations, availability odds, cost-of-waiting, and steal/reach grades. Live auto-sync is currently Sleeper-only.</div>
                <button className="btn btn-mini" style={{ marginTop: 8 }} onClick={() => { setOpen(false); setSel(null); setError(null); }}>Set up manually instead</button>
              </div>
            </div>
          ) : (
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <i className={`ti ${sel.icon}`} style={{ fontSize: 18, color: "var(--gold)" }} aria-hidden="true" />
                <b>{sel.name}</b>
                {PLATFORMS.length > 1 && <button className="btn btn-mini" style={{ marginLeft: "auto" }} onClick={() => { setSel(null); setSleeperLeagues(null); setError(null); }}>← Other platform</button>}
              </div>
              <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>{sel.hint}</div>

              {sel.id === "sleeper" ? (
                <div>
                  {/* Step 1: username → fetch leagues */}
                  {sleeperLeagues == null ? (
                    <div>
                      <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>Enter your Sleeper username to pull your leagues</div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <input className="gs" autoFocus style={{ flex: 1 }} placeholder="Sleeper username" value={val} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && val.trim()) fetchSleeperLeagues(); }} />
                        <button className="btn btn-gold" onClick={fetchSleeperLeagues} disabled={busy || !val.trim()}>{busy ? "Finding…" : "Find my leagues"}</button>
                      </div>
                      <div className="mut" style={{ fontSize: 11, marginTop: 6 }}>It's the @username on your Sleeper profile — not your email.</div>
                    </div>
                  ) : (
                    /* Step 2: choose a league */
                    <div>
                      <div className="mut" style={{ fontSize: 12, marginBottom: 8 }}>Pick the league to connect{sleeperLeagues.some((l) => l.draft_status === "drafting") ? " — your live draft is highlighted." : "."}</div>
                      <div style={{ maxHeight: 260, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
                        {sleeperLeagues.map((lg) => { const st = statusChip(lg.draft_status); const live = lg.draft_status === "drafting"; return (
                          <button key={lg.league_id} className="btn" disabled={busy}
                            style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-start", padding: "10px 12px", textAlign: "left", borderColor: live ? "var(--green)" : "var(--line)", background: live ? "rgba(124,217,178,0.07)" : "transparent" }}
                            onClick={() => pickSleeperLeague(lg)}>
                            <i className="ti ti-trophy" style={{ fontSize: 16, color: live ? "var(--green)" : "var(--gold)" }} aria-hidden="true" />
                            <span style={{ flex: 1 }}><b>{lg.name}</b> <span className="mut" style={{ fontSize: 11 }}>· {lg.total_rosters} teams</span></span>
                            {st && <span className="chip" style={{ fontSize: 9, borderColor: st.c, color: st.c }}>{st.t}</span>}
                          </button>
                        ); })}
                      </div>
                      <button className="btn btn-mini" style={{ marginTop: 8 }} onClick={() => { setSleeperLeagues(null); setError(null); }}>← Different username</button>
                    </div>
                  )}
                </div>
              ) : sel.oauth ? (
                <button className="btn btn-gold" style={{ width: "100%", padding: 10 }} onClick={doConnect} disabled={busy}>{busy ? "Connecting…" : `Sign in with ${sel.name}`}</button>
              ) : (
                <div style={{ display: "flex", gap: 8 }}>
                  <input className="gs" style={{ flex: 1 }} placeholder={sel.field} value={val} onChange={(e) => setVal(e.target.value)} />
                  <button className="btn btn-gold" onClick={doConnect} disabled={busy || !val.trim()}>{busy ? "Importing…" : "Connect"}</button>
                </div>
              )}

              {error && <div style={{ color: "var(--red)", fontSize: 12, marginTop: 8 }}>{error}</div>}
              {sel.login && <div className="mut" style={{ fontSize: 11, marginTop: 6 }}>You'll also sign in with your {sel.name} login on the next step.</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Shared config form, used by both Setup (new league) and the in-draft Settings tab.
function DraftOrderTab({ f, upd, ensureNames }) {
  const teamsN = +f.teams;
  const names = (f.teamNames && f.teamNames.length === teamsN) ? f.teamNames : TEAM_NAMES_POOL.slice(0, teamsN);
  const isSet = Array.isArray(f.draftOrder) && f.draftOrder.length === teamsN;
  // current order as array of team indices (default 0..n-1)
  const ord = isSet ? f.draftOrder : Array.from({ length: teamsN }, (_, i) => i);
  const setOrderArr = (arr) => { upd({ draftOrder: arr.slice() }); };
  const move = (pos, dir) => { const j = pos + dir; if (j < 0 || j >= teamsN) return; const a = ord.slice(); [a[pos], a[j]] = [a[j], a[pos]]; setOrderArr(a); };
  const randomize = () => { const a = ord.slice(); for (let i = a.length - 1; i > 0; i--) { const r = Math.floor(Math.random() * (i + 1)); [a[i], a[r]] = [a[r], a[i]]; } setOrderArr(a); };
  const establish = () => { ensureNames(); upd({ draftOrder: Array.from({ length: teamsN }, (_, i) => i) }); };
  const clear = () => upd({ draftOrder: null });
  // your slot is derived from where your team sits in the order. Mark your row to set it.
  const yourPos = f.slot === "" || f.slot == null ? null : (+f.slot - 1);
  const setMine = (pos) => upd({ slot: yourPos === pos ? "" : pos + 1 });

  return (
    <>
      <div className="panel" style={{ padding: 12, marginBottom: 12, background: "var(--panel2)", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <i className={`ti ${isSet ? "ti-circle-check" : "ti-circle-dashed"}`} style={{ fontSize: 17, color: isSet ? "var(--green)" : "var(--gold)" }} aria-hidden="true" />
        <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{isSet ? "Order set" : "Order not set"}</span>
        <span className="mut" style={{ fontSize: 11 }}>Required before the official draft · optional for mocks</span>
        {isSet ? <button className="btn btn-mini" onClick={clear}>Clear</button> : <button className="btn btn-mini btn-gold" onClick={establish}>Set order</button>}
      </div>

      {isSet && (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
            <div className="disp mut" style={{ fontSize: 11, letterSpacing: ".06em" }}>PICK ORDER ({DRAFT_ORDERS.find((o) => o[0] === (f.order || "snake"))?.[1] || "Snake"})</div>
            <button className="btn btn-mini" onClick={randomize}><i className="ti ti-arrows-shuffle" style={{ fontSize: 12, marginRight: 4 }} aria-hidden="true" />Randomize</button>
          </div>
          <div className="mut" style={{ fontSize: 11, marginBottom: 8 }}>Drag with the arrows to set the order. Tap a row to mark it as <b style={{ color: "var(--ink)" }}>your team</b> — that's your draft slot.</div>
          <div style={{ maxHeight: 300, overflowY: "auto", paddingRight: 4 }}>
            {ord.map((teamIdx, pos) => {
              const mine = yourPos === pos;
              return (
              <div key={pos} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 8px", borderRadius: 7, marginBottom: 5, border: `1px solid ${mine ? "var(--gold)" : "var(--line)"}`, background: mine ? "#16140c" : "transparent" }}>
                <span className="gold num disp" style={{ width: 28, fontSize: 15, fontWeight: 700 }}>{pos + 1}</span>
                <button onClick={() => setMine(pos)} className="bigact" style={{ flex: 1, textAlign: "left", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", color: "var(--ink)", fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
                  <i className={`ti ${mine ? "ti-user-check" : "ti-user"}`} style={{ fontSize: 14, color: mine ? "var(--gold)" : "var(--mut)" }} aria-hidden="true" />
                  {names[teamIdx] || `Team ${teamIdx + 1}`}
                  {mine && <span className="chip" style={{ borderColor: "var(--gold)", color: "var(--gold)", fontSize: 9 }}>YOU</span>}
                </button>
                <button className="btn btn-mini" onClick={() => move(pos, -1)} disabled={pos === 0}>▲</button>
                <button className="btn btn-mini" onClick={() => move(pos, 1)} disabled={pos === teamsN - 1}>▼</button>
              </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

function ConfigForm({ initial, onSubmit, submitLabel, onCancel, initialSeg }) {
  const [seg, setSeg] = useState(initialSeg || "basics");
  const [keeperModal, setKeeperModal] = useState(false);
  const [f, setF] = useState(() => ({
    name: "My league", type: "redraft", teams: 12, rounds: 15, slot: "", order: "snake", excludeRookies: false, pickTrading: false, keeper: false, idp: false,
    start: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, SUPER: 0, DST: 0, K: 0, DL: 0, LB: 0, DB: 0, IDPFLEX: 0 },
    caps: { QB: "", RB: "", WR: "", TE: "" },
    scoring: { ...DEFAULT_SCORING },
    teamNames: [], favTeams: [], manual: false, connect: null,
    draftOrder: null, keepers: [], pickTrades: [],
    ...initial,
  }));
  const upd = (patch) => setF((s) => ({ ...s, ...patch }));
  const updStart = (k, v) => setF((s) => ({ ...s, start: { ...s.start, [k]: v } }));
  const updCap = (k, v) => setF((s) => ({ ...s, caps: { ...s.caps, [k]: v.replace(/\D/g, "") } }));
  const updScore = (k, v) => setF((s) => ({ ...s, scoring: { ...s.scoring, [k]: v === "" ? 0 : +v } }));

  // auto-detected formats from roster + scoring (no separate toggles)
  const isSF = f.start.SUPER > 0 || (f.start.QB || 0) >= 2;
  const tePrem = (f.scoring.rec || 0) > 0 && (f.scoring.recTE != null ? f.scoring.recTE > f.scoring.rec : false);

  const ensureNames = () => {
    const n = f.teams; const names = [], favs = [];
    for (let i = 0; i < n; i++) { names.push(f.teamNames[i] || TEAM_NAMES_POOL[i] || `Team ${i + 1}`); favs.push(f.favTeams[i] || ""); }
    upd({ teamNames: names, favTeams: favs });
  };
  // If we open the form directly on the Teams/Pick-trades tab (deep link from the hub), make sure
  // team names exist so those editors render with real names instead of being blank.
  useEffect(() => { if (initialSeg === "trades" || initialSeg === "order") ensureNames(); /* eslint-disable-next-line */ }, []);

  const submit = () => {
    const teRec = f.scoring.recTE != null ? f.scoring.recTE : f.scoring.rec;
    const tePremMult = teRec > f.scoring.rec ? +(teRec - f.scoring.rec).toFixed(2) : 0;
    const cfg = {
      name: f.name || "My league", type: f.type, teams: +f.teams, rounds: +f.rounds,
      slot: f.slot === "" || f.slot == null ? null : +f.slot,
      order: f.order, excludeRookies: !!f.excludeRookies, pickTrading: !!f.pickTrading, keeper: !!f.keeper, idp: !!f.idp,
      sf: f.start.SUPER > 0 || (f.start.QB || 0) >= 2, tePrem: tePremMult > 0, tePremMult,
      start: f.start, caps: f.caps, scoring: f.scoring, connect: f.connect,
      draftOrder: f.draftOrder && f.draftOrder.length === +f.teams ? f.draftOrder : null,
      keepers: f.keepers || [], pickTrades: f.pickTrades || [],
      teamNames: f.manual && f.teamNames.length === +f.teams ? f.teamNames : null,
      favTeams: f.manual && f.favTeams.length === +f.teams ? f.favTeams : null,
    };
    onSubmit(cfg);
  };

  const Row = (label, children, hint) => (
    <div style={{ marginBottom: 13 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <label className="mut" style={{ width: 150, fontSize: 13, flexShrink: 0 }}>{label}</label>
        <div style={{ flex: 1 }}>{children}</div>
      </div>
      {hint && <div style={{ fontSize: 11, marginLeft: 162, marginTop: 3, color: hint.warn ? "var(--gold)" : "var(--mut)" }}>{hint.text || hint}</div>}
    </div>
  );
  const ScoreField = (k, label, note) => (
    <div key={k} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
      <label style={{ fontSize: 12.5, flex: 1 }}>{label}{note && <span className="gold" style={{ fontSize: 10, marginLeft: 5 }}>· {note}</span>}</label>
      <input className="gs" style={{ width: 68, padding: "5px 7px" }} type="number" step="0.05" value={f.scoring[k] ?? 0} onChange={(e) => updScore(k, e.target.value)} />
    </div>
  );

  const SEGS = [["basics","Basics"],["roster","Roster"],["scoring","Scoring"],["order","Teams & order"],["trades","Pick trades"]];

  // players for keeper/trade tabs, built from the current config-in-progress
  const cfgPreview = useMemo(() => ({ teams: +f.teams, rounds: +f.rounds, type: f.type, sf: f.start.SUPER > 0 || (f.start.QB || 0) >= 2, tePremMult: (f.scoring.recTE != null && f.scoring.recTE > f.scoring.rec) ? +(f.scoring.recTE - f.scoring.rec).toFixed(2) : 0, start: f.start, caps: f.caps, scoring: f.scoring, order: f.order, slot: f.slot === "" ? null : +f.slot, teamNames: f.manual ? f.teamNames : null }), [f]);
  const kPlayers = useMemo(() => { try { setTeams(+f.teams); setSpec(f.start); setOrder(f.order || "snake"); setPickTrades(null); setKeeperAdds({}); return buildPlayers(cfgPreview); } catch (e) { return []; } }, [cfgPreview]);

  return (
    <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
      <div style={{ display: "flex", borderBottom: "1px solid var(--line)" }}>
        {SEGS.map(([k, l]) => (
          <button key={k} onClick={() => { if (k === "order" || k === "trades") { ensureNames(); } setSeg(k); }}
            style={{ flex: 1, padding: "12px 6px", background: seg === k ? "var(--panel2)" : "transparent", border: "none", borderBottom: seg === k ? "2px solid var(--gold)" : "2px solid transparent", color: seg === k ? "var(--gold)" : "var(--mut)", fontWeight: 600, fontSize: 12, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>
            {l}
          </button>
        ))}
      </div>
      <div style={{ padding: 22 }}>

      {seg === "basics" && (
        <>
          <ConnectBox connect={f.connect} onConnect={(c) => {
            if (!c) { upd({ connect: null }); return; }
            // Apply settings pulled from the connected league (Sleeper) so the form is pre-filled.
            const patch = { connect: c, name: c.leagueName || `${PLATFORMS.find((p) => p.id === c.platform)?.name} league` };
            if (c.cfg) {
              const k = c.cfg;
              if (k.teams) patch.teams = k.teams;
              if (k.rounds) patch.rounds = k.rounds;
              if (k.type) patch.type = k.type;
              if (k.start) patch.start = { ...f.start, ...k.start };
              if (k.scoringType) {
                const rec = k.scoringType === "ppr" ? 1 : k.scoringType === "half" ? 0.5 : 0;
                patch.scoring = { ...f.scoring, rec, recTE: k.tePrem ? rec + (k.tePremMult || 1) : rec };
              }
            }
            // Your draft slot
            if (c.yourSlot) patch.slot = c.yourSlot;
            // Draft order + team names: build arrays in slot order (1-based slots → 0-based arrays)
            if (c.slotNames && c.teams) {
              const names = [];
              for (let s = 1; s <= c.teams; s++) names.push(c.slotNames[s] || `Team ${s}`);
              patch.teamNames = names; patch.manual = true;
              // Sleeper draft order is already slot order, so draftOrder = identity (slot i → team i)
              patch.draftOrder = Array.from({ length: c.teams }, (_, i) => i);
            }
            if (c.draftType) patch.order = c.draftType === "linear" ? "linear" : c.draftType === "3rr" ? "3rr" : "snake";
            // Traded picks → owner overrides keyed by the ACTUAL overall pick index (accounting for
            // the draft type, incl. 3RR), so picks you traded for are attributed to your team.
            if (Array.isArray(c.tradedPicks) && c.tradedPicks.length && c.teams) {
              const trades = tradesToOwnerOverrides(c.tradedPicks, c.teams, patch.order || f.order || "snake");
              if (trades.length) { patch.pickTrading = true; patch.pickTrades = trades; }
            }
            // Keepers from Sleeper (name + slot). Stored on connect; the draft room resolves names→ids
            // against the live player pool and pre-places them on the right team (no-cost roster adds).
            if (Array.isArray(c.keepers) && c.keepers.length) {
              patch.connect = { ...c, keepers: c.keepers };
            }
            upd(patch);
          }} onClear={() => upd({ connect: null })} />
          {f.connect && f.connect.platform === "sleeper" && (
            <div className="panel" style={{ padding: "14px 16px", marginBottom: 16, marginTop: -6, background: "#0E1206", borderColor: "var(--green)" }}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--green)", marginBottom: 3 }}><i className="ti ti-circle-check" style={{ fontSize: 15, marginRight: 5 }} aria-hidden="true" />Connected to {f.connect.leagueName || "your Sleeper league"}</div>
                  <div className="mut" style={{ fontSize: 11.5, lineHeight: 1.5 }}>Everything's set automatically — teams, scoring, roster, draft order{f.connect.yourSlot ? `, your slot (${f.connect.yourSlot})` : ""}{(f.connect.tradedPicks || []).length ? ", traded picks" : ""}{(f.connect.keepers || []).length ? ", keepers" : ""}. <b style={{ color: "var(--ink)" }}>You don't need to fill in anything below.</b></div>
                </div>
                <button className="btn btn-gold" style={{ padding: "11px 20px", fontSize: 14, fontWeight: 700, alignSelf: "center", flexShrink: 0 }} onClick={submit}>
                  <i className="ti ti-player-play" style={{ fontSize: 15, marginRight: 6 }} aria-hidden="true" />Enter draft room
                </button>
              </div>
              <details style={{ marginTop: 10 }}>
                <summary style={{ fontSize: 11.5, color: "var(--mut)", cursor: "pointer", userSelect: "none" }}>Review or tweak settings (optional)</summary>
                <div className="mut" style={{ fontSize: 11, marginTop: 6, lineHeight: 1.5 }}>The fields below are pre-filled from your league. You can adjust them, but for a connected Sleeper league you normally don't need to — just hit “Enter draft room” above.</div>
              </details>
            </div>
          )}{Row("League name", <input className="gs" style={{ width: "100%" }} value={f.name} onChange={(e) => upd({ name: e.target.value })} />)}
          {Row("League type",
            <select className="gs" style={{ width: "100%" }} value={f.type} onChange={(e) => upd({ type: e.target.value })}>
              {LEAGUE_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          )}
          {Row("Teams", <select className="gs" value={f.teams} onChange={(e) => upd({ teams: +e.target.value })}>{Array.from({ length: 19 }, (_, i) => i + 2).map((n) => <option key={n} value={n}>{n} teams</option>)}</select>)}
          {Row("Rounds", <select className="gs" value={f.rounds} onChange={(e) => upd({ rounds: +e.target.value })}>{Array.from({ length: 49 }, (_, i) => i + 2).map((n) => <option key={n} value={n}>{n} rounds</option>)}</select>, "Up to 50 — deep dynasty startups welcome.")}
          {Row("Draft order",
            <select className="gs" style={{ width: "100%" }} value={f.order} onChange={(e) => upd({ order: e.target.value })}>
              {DRAFT_ORDERS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>,
            "Snake, linear, or third-round reversal. Set who picks where — and your own slot — on the Draft order tab."
          )}
          {f.type !== "rookie" && Row("Include rookies?",
            <button className="btn" onClick={() => upd({ excludeRookies: !f.excludeRookies })}>{f.excludeRookies ? "No — rookies drafted separately" : "Yes — rookies in this draft pool"}</button>,
            { warn: f.excludeRookies, text: f.excludeRookies ? "Rookies are removed from this pool — use this when your league drafts rookies in a separate event." : "Rookies are included in the normal draft pool, alongside veterans." }
          )}
          {f.type !== "rookie" && f.type !== "bestball" && Row("Keeper league?",
            <button className="btn" onClick={() => upd({ keeper: !f.keeper })}>{f.keeper ? "On — some players are kept" : "Off"}</button>,
            f.keeper ? "Players carried over from last season. Set who's kept (and at what pick cost) below." : "Turn on if managers keep players from last season."
          )}
          {f.keeper && (
            <div style={{ marginLeft: 162, marginBottom: 13 }}>
              <button className="btn btn-mini btn-gold" onClick={() => setKeeperModal(true)}><i className="ti ti-lock" style={{ fontSize: 12, marginRight: 5 }} aria-hidden="true" />Set keepers{(f.keepers || []).length > 0 ? ` (${(f.keepers || []).length})` : ""}</button>
            </div>
          )}
          {Row("Draft-pick trading",
            <button className="btn" onClick={() => upd({ pickTrading: !f.pickTrading })}>{f.pickTrading ? "On — trade picks & rookie picks" : "Off"}</button>,
            f.pickTrading ? "Your draft picks (incl. rookie picks) become tradeable assets in the trade tools." : "Turn on if your league allows trading draft picks."
          )}
          {f.type !== "rookie" && Row("IDP (defensive players)?",
            <button className="btn" onClick={() => { const on = !f.idp; const start = { ...f.start }; if (on && !(start.DL || start.LB || start.DB || start.IDPFLEX)) { start.LB = 2; start.DL = 1; start.DB = 1; } upd({ idp: on, start }); }}>{f.idp ? "On — defensive players draftable" : "Off"}</button>,
            f.idp ? "Individual defensive players (DL, LB, DB) join the pool. Set their starting slots on the Roster tab and tune their scoring on the Scoring tab." : "Turn on if your league starts individual defensive players (not just team D/ST)."
          )}
          <div className="mut" style={{ fontSize: 11.5, margin: "6px 0 0" }}>Connecting a league auto-fills all settings from the platform and lets you pick which of your leagues to view.</div>
        </>
      )}

      {seg === "roster" && (
        <>
          <div className="mut" style={{ fontSize: 12.5, marginBottom: 14 }}>Starting lineup on the left; optional per-position maximum on the right. A <b>SUPERFLEX</b> slot turns this into a 2QB/superflex league automatically.</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 6 }}>
            <div className="disp mut" style={{ fontSize: 12, letterSpacing: ".06em" }}>STARTING SLOTS</div>
            <div className="disp mut" style={{ fontSize: 12, letterSpacing: ".06em" }}>ROSTER MAX (optional)</div>
          </div>
          {[["QB","QB"],["RB","RB"],["WR","WR"],["TE","TE"],["FLEX","FLEX (RB/WR/TE)"],["SUPER","SUPERFLEX"],["DST","D/ST"],["K","K"]].map(([k, label]) => (
            <div key={k}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 4, alignItems: "center" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <label style={{ fontSize: 13, width: 130 }}>{label}</label>
                  <input className="gs" style={{ width: 64 }} type="number" min={0} max={6} value={f.start[k]} onChange={(e) => updStart(k, Math.max(0, +e.target.value || 0))} />
                </div>
                <div>{["FLEX","SUPER"].includes(k) ? <span className="mut" style={{ fontSize: 11 }}>—</span> : <input className="gs" style={{ width: 80 }} placeholder="none" value={f.caps[k] ?? ""} onChange={(e) => updCap(k, e.target.value)} />}</div>
              </div>
              {k === "SUPER" && f.start.SUPER > 0 && <div className="gold" style={{ fontSize: 11, marginBottom: 8, marginLeft: 2 }}>⚑ Superflex / 2QB format active — QB values surge across the entire board.</div>}
            </div>
          ))}
          {f.idp && (
            <>
              <div className="disp gold" style={{ fontSize: 12, letterSpacing: ".06em", margin: "16px 0 8px" }}>DEFENSIVE (IDP) SLOTS</div>
              {[["DL","DL (defensive line)"],["LB","LB (linebacker)"],["DB","DB (defensive back)"],["IDPFLEX","IDP FLEX (any defender)"]].map(([k, label]) => (
                <div key={k} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 4, alignItems: "center" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <label style={{ fontSize: 13, width: 130 }}>{label}</label>
                    <input className="gs" style={{ width: 64 }} type="number" min={0} max={6} value={f.start[k] || 0} onChange={(e) => updStart(k, Math.max(0, +e.target.value || 0))} />
                  </div>
                  <div>{k === "IDPFLEX" ? <span className="mut" style={{ fontSize: 11 }}>—</span> : <input className="gs" style={{ width: 80 }} placeholder="none" value={f.caps[k] ?? ""} onChange={(e) => updCap(k, e.target.value)} />}</div>
                </div>
              ))}
              <div className="gold" style={{ fontSize: 11, marginTop: 6 }}>⚑ IDP active — DL/LB/DB enter the draft pool. Tune their scoring on the Scoring tab; tackle-heavy scoring favors linebackers, big-play scoring favors edge rushers.</div>
            </>
          )}
        </>
      )}

      {seg === "scoring" && (
        <>
          <div className="mut" style={{ fontSize: 12.5, marginBottom: 12 }}>Scoring flows straight into projections — change any value and the whole board re-ranks. A TE reception value higher than the base flips on <b>TE-premium</b> automatically.</div>
          {f.idp && <div className="gold" style={{ fontSize: 11.5, marginBottom: 12, padding: "8px 10px", border: "1px solid var(--gold)", borderRadius: 8, background: "rgba(214,170,75,0.08)" }}><i className="ti ti-info-circle" style={{ fontSize: 13, marginRight: 5 }} aria-hidden="true" />IDP scoring is below under “IDP (defensive players).” Set how many DL/LB/DB you start on the <b>Roster</b> tab — that's what determines defensive replacement value.</div>}
          <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
            <button className="btn btn-mini" onClick={() => upd({ scoring: { ...DEFAULT_SCORING } })}>PPR</button>
            <button className="btn btn-mini" onClick={() => upd({ scoring: { ...DEFAULT_SCORING, rec: 0.5 } })}>Half PPR</button>
            <button className="btn btn-mini" onClick={() => upd({ scoring: { ...DEFAULT_SCORING, rec: 0 } })}>Standard</button>
            <button className="btn btn-mini" onClick={() => upd({ scoring: { ...f.scoring, recTE: (f.scoring.rec || 0) + 0.5 } })}>+TE premium</button>
            <button className="btn btn-mini" onClick={() => upd({ scoring: { ...DEFAULT_SCORING, passTD: 6 } })}>6pt pass TD</button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: "0 22px" }}>
            <div>
              <div className="disp gold" style={{ fontSize: 12, letterSpacing: ".06em", margin: "4px 0 7px" }}>PASSING</div>
              {ScoreField("passYd", "Per passing yard")}
              {ScoreField("passTD", "Passing TD")}
              {ScoreField("INT", "Interception")}
              {ScoreField("pass2pt", "2-pt pass")}
              <div className="disp gold" style={{ fontSize: 12, letterSpacing: ".06em", margin: "12px 0 7px" }}>RUSHING</div>
              {ScoreField("rushYd", "Per rushing yard")}
              {ScoreField("rushTD", "Rushing TD")}
              {ScoreField("rushAtt", "Per rush attempt")}
              {ScoreField("rush2pt", "2-pt rush")}
              <div className="disp gold" style={{ fontSize: 12, letterSpacing: ".06em", margin: "12px 0 7px" }}>RECEIVING</div>
              {ScoreField("rec", "Per reception (PPR)")}
              {ScoreField("recTE", "Per reception — TE", tePrem ? "premium on" : null)}
              {ScoreField("recYd", "Per receiving yard")}
              {ScoreField("recTD", "Receiving TD")}
              {ScoreField("rec2pt", "2-pt reception")}
            </div>
            <div>
              <div className="disp gold" style={{ fontSize: 12, letterSpacing: ".06em", margin: "4px 0 7px" }}>BIG-PLAY / MILESTONE</div>
              {ScoreField("bonus100", "100+ yd game bonus")}
              {ScoreField("bonus300pass", "300+ yd pass bonus")}
              {ScoreField("bonusBigRec", "Per 20+ yd reception")}
              {ScoreField("bonusBigRush", "Per 20+ yd run")}
              {ScoreField("bonus40Rec", "Per 40+ yd reception")}
              {ScoreField("bonus40Rush", "Per 40+ yd run")}
              {ScoreField("bonus40PassTD", "Per 40+ yd pass TD")}
              <div className="mut" style={{ fontSize: 10.5, margin: "2px 0 4px" }}>Explosive-play bonuses are modeled from each player's projected yardage distribution.</div>
              <div className="disp gold" style={{ fontSize: 12, letterSpacing: ".06em", margin: "12px 0 7px" }}>MISC</div>
              {ScoreField("fum", "Fumble lost")}
              <div className="disp gold" style={{ fontSize: 12, letterSpacing: ".06em", margin: "12px 0 7px" }}>KICKING</div>
              {ScoreField("fg", "Field goal (base)")}
              {ScoreField("fg50", "FG 50+ bonus")}
              {ScoreField("pat", "Extra point (PAT)")}
              {ScoreField("fgMiss", "Missed FG")}
              <div className="disp gold" style={{ fontSize: 12, letterSpacing: ".06em", margin: "12px 0 7px" }}>DEFENSE / ST</div>
              {ScoreField("sack", "Sack")}
              {ScoreField("dint", "Interception")}
              {ScoreField("dfr", "Fumble recovery")}
              {ScoreField("dtd", "Defensive TD")}
              {ScoreField("paPer", "Pts-allowed factor")}
              {f.idp && (
                <>
                  <div className="disp gold" style={{ fontSize: 12, letterSpacing: ".06em", margin: "12px 0 7px" }}>IDP (DEFENSIVE PLAYERS)</div>
                  {ScoreField("idpSolo", "Solo tackle")}
                  {ScoreField("idpAst", "Assisted tackle")}
                  {ScoreField("idpSack", "Sack")}
                  {ScoreField("idpTFL", "Tackle for loss")}
                  {ScoreField("idpQBH", "QB hit")}
                  {ScoreField("idpInt", "Interception")}
                  {ScoreField("idpPD", "Pass defended")}
                  {ScoreField("idpFF", "Forced fumble")}
                  {ScoreField("idpFR", "Fumble recovery")}
                  {ScoreField("idpDTD", "Defensive TD")}
                  {ScoreField("idpSaf", "Safety")}
                  <div className="mut" style={{ fontSize: 10.5, margin: "4px 0 0" }}>Tackle-weighted scoring favors linebackers; sack/TFL/QB-hit weighting favors edge rushers; INT/PD weighting favors defensive backs.</div>
                </>
              )}
            </div>
          </div>
        </>
      )}

      {seg === "order" && (
        <>
          <div className="disp gold" style={{ fontSize: 12, letterSpacing: ".06em", marginBottom: 4 }}>TEAMS</div>
          <div className="mut" style={{ fontSize: 11.5, marginBottom: 10 }}>Auto-filled when you connect a platform.</div>
          <div style={{ maxHeight: 200, overflowY: "auto", paddingRight: 4, marginBottom: 16 }}>
            {Array.from({ length: +f.teams }, (_, i) => (
              <div key={i} style={{ display: "flex", gap: 8, marginBottom: 7, alignItems: "center" }}>
                <span className="mut num" style={{ width: 22, fontSize: 12 }}>{i + 1}</span>
                <input className="gs" style={{ flex: 1 }} value={f.teamNames[i] || ""} onChange={(e) => { const a = f.teamNames.slice(); a[i] = e.target.value; upd({ teamNames: a, manual: true }); }} placeholder={TEAM_NAMES_POOL[i] || `Team ${i + 1}`} />
                <select className="gs" style={{ width: 110 }} value={f.favTeams[i] || ""} onChange={(e) => { const a = f.favTeams.slice(); a[i] = e.target.value; upd({ favTeams: a, manual: true }); }}>
                  <option value="">No fav</option>
                  {NFL_TEAMS.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
            ))}
          </div>
          <div style={{ borderTop: "1px solid var(--line)", paddingTop: 14 }}>
            <div className="disp gold" style={{ fontSize: 12, letterSpacing: ".06em", marginBottom: 8 }}>DRAFT ORDER & YOUR SLOT</div>
            <DraftOrderTab f={f} upd={upd} ensureNames={ensureNames} />
          </div>
        </>
      )}

      {seg === "trades" && (
        <>
          <div className="mut" style={{ fontSize: 12.5, marginBottom: 6 }}><b style={{ color: "var(--ink)" }}>Traded draft picks are optional.</b> Leave this empty if no picks have changed hands. Anything you set flows into the official draft and every mock, and turns on pick-trading in the trade tools for this league.</div>
          <KeepersEditor cfg={{ ...cfgPreview, keepers: f.keepers, pickTrades: f.pickTrades }} players={kPlayers} embedded section="trades" onChange={(newCfg) => upd({ keepers: newCfg.keepers, pickTrades: newCfg.pickTrades, pickTrading: (newCfg.pickTrades || []).length > 0 ? true : f.pickTrading })} />
        </>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 20, borderTop: "1px solid var(--line)", paddingTop: 16 }}>
        {onCancel && <button className="btn" onClick={onCancel}>Cancel</button>}
        <div style={{ flex: 1 }} />
        <button className="btn btn-gold" onClick={submit}>{submitLabel}</button>
      </div>
      </div>

      {keeperModal && (
        <div className="modalbg" onClick={() => setKeeperModal(false)}>
          <div className="panel" style={{ maxWidth: 600, width: "100%", padding: 20, maxHeight: "85vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 4 }}>
              <div className="disp" style={{ fontSize: 19, fontWeight: 700, flex: 1 }}>Set keepers</div>
              <button className="btn btn-mini" onClick={() => setKeeperModal(false)}>Done</button>
            </div>
            <div className="mut" style={{ fontSize: 12, marginBottom: 14 }}>Add each player a team is keeping, and whether it costs a draft pick. These apply to the official draft and every mock for this league.</div>
            <KeepersEditor cfg={{ ...cfgPreview, keepers: f.keepers, pickTrades: f.pickTrades }} players={kPlayers} embedded section="keepers" onChange={(newCfg) => upd({ keepers: newCfg.keepers, pickTrades: newCfg.pickTrades })} />
          </div>
        </div>
      )}
    </div>
  );
}

function Setup({ onCreate, onBack, backLabel }) {
  return (
    <div style={{ maxWidth: 580, margin: "0 auto", padding: "32px 20px" }}>
      <button className="btn btn-mini" onClick={onBack} style={{ marginBottom: 14 }}>← {backLabel || "Library"}</button>
      <ConfigForm initial={{}} submitLabel="Create league & enter draft room" onSubmit={onCreate} onCancel={onBack} />
    </div>
  );
}

/* ============================================================ ADMIN */
function Admin({ biz, setBiz, user, leagues, feedback, onRespond, onDeleteFeedback, onGrantComp, onRevokeComp, onBack }) {
  const [tab, setTab] = useState("users"); // users | invites | feedback | tools
  const [users, setUsers] = useState(null);
  const [totals, setTotals] = useState(null);
  const [uSearch, setUSearch] = useState("");
  const [invites, setInvites] = useState(null);
  const [fb, setFb] = useState(null);
  const [fbNew, setFbNew] = useState(0);
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
  const setFbStatus = async (id, status) => { try { await api.adminFeedbackStatus(id, status); await loadFeedback(); } catch (e) {} };

  const fmtDate = (d) => d ? new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—";
  const statusOf = (u) => u.disabled ? { t: "Disabled", c: "var(--red)" } : u.active_paid ? { t: u.comp ? "Comped" : "Active pass", c: "var(--green)" } : { t: "Free", c: "var(--gold)" };

  const TABS = [["users", "Users", users ? users.length : null], ["invites", "Free invites", null], ["feedback", "Feedback", fbNew || null], ["tools", "Stripe & analytics", null]];

  return (
    <div>
      <div className="hairline" style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 18px" }}>
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

      {msg && <div style={{ maxWidth: 980, margin: "10px auto 0", padding: "0 18px" }}><div className="panel" style={{ padding: "8px 12px", fontSize: 12.5, borderColor: "var(--gold)", background: "#16140c" }}>{msg}</div></div>}

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
        {tab === "feedback" && (
          <div className="panel" style={{ padding: 16 }}>
            <div className="disp" style={{ fontSize: 17, fontWeight: 700, marginBottom: 10 }}>Feedback inbox</div>
            {!fb ? <div className="mut" style={{ fontSize: 13 }}>Loading…</div> : fb.length === 0 ? <div className="mut" style={{ fontSize: 13 }}>No feedback yet. Messages sent from the site's contact form show up here.</div> : fb.map((f) => (
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
          </div>
        )}
      </div>
    </div>
  );
}

function FeedbackInbox({ feedback, onRespond, onDelete }) {
  const [open, setOpen] = useState(null); // feedback id being replied to
  const [reply, setReply] = useState("");
  const [filter, setFilter] = useState("all");
  const view = feedback.filter((f) => filter === "all" || (filter === "new" ? f.status === "new" : f.status === "answered"));
  const newCount = feedback.filter((f) => f.status === "new").length;
  return (
    <div className="panel" style={{ padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <div className="disp" style={{ fontSize: 17, fontWeight: 700 }}>Feedback inbox</div>
        {newCount > 0 && <span className="chip" style={{ borderColor: "var(--gold)", color: "var(--gold)" }}>{newCount} new</span>}
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", gap: 4 }}>
          {[["all","All"],["new","New"],["answered","Answered"]].map(([k, l]) => (
            <button key={k} className="btn btn-mini" style={{ borderColor: filter === k ? "var(--gold)" : "var(--line)" }} onClick={() => setFilter(k)}>{l}</button>
          ))}
        </div>
      </div>
      {view.length === 0 ? (
        <div className="mut" style={{ fontSize: 13 }}>No {filter === "all" ? "" : filter + " "}messages yet. Submissions from the Help → Contact form land here.</div>
      ) : view.map((f) => (
        <div key={f.id} style={{ borderTop: "1px solid var(--line)", padding: "12px 0" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span className="chip" style={{ fontSize: 11 }}>{f.topic}</span>
            <a href={`mailto:${f.email}`} style={{ color: "var(--gold)", fontSize: 13, textDecoration: "none" }}>{f.email}</a>
            <span className="mut" style={{ fontSize: 11 }}>{f.ts}</span>
            <span style={{ fontSize: 11, color: f.status === "answered" ? "var(--green)" : "var(--gold)" }}>{f.status === "answered" ? "✓ answered" : "● new"}</span>
            <div style={{ flex: 1 }} />
            <button className="btn btn-mini" onClick={() => { setOpen(open === f.id ? null : f.id); setReply(f.reply || ""); }}>{f.status === "answered" ? "View / edit reply" : "Reply"}</button>
            <button className="btn btn-mini" onClick={() => onDelete(f.id)} title="Delete">✕</button>
          </div>
          <div style={{ fontSize: 13, lineHeight: 1.5, margin: "8px 0 0" }}>{f.msg}</div>
          {f.reply && open !== f.id && <div style={{ fontSize: 12.5, lineHeight: 1.5, marginTop: 8, paddingLeft: 10, borderLeft: "2px solid var(--green)", color: "var(--mut)" }}><b style={{ color: "var(--green)" }}>Your reply:</b> {f.reply}</div>}
          {open === f.id && (
            <div style={{ marginTop: 10 }}>
              <textarea className="gs" style={{ width: "100%", minHeight: 90, resize: "vertical", fontFamily: "inherit" }} value={reply} onChange={(e) => setReply(e.target.value)} placeholder={`Reply to ${f.email}…`} />
              <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
                <button className="btn btn-gold btn-mini" onClick={() => { if (reply.trim()) { onRespond(f.id, reply.trim()); setOpen(null); } }}>Send reply to {f.email}</button>
                <a className="btn btn-mini" href={`mailto:${f.email}?subject=${encodeURIComponent("Re: your Fantasy Draft Compass feedback")}&body=${encodeURIComponent(reply)}`}>Open in mail app</a>
                <button className="btn btn-mini" onClick={() => setOpen(null)}>Cancel</button>
              </div>
              <div className="mut" style={{ fontSize: 11, marginTop: 6 }}>Sending marks this answered and (in production) emails your reply to the submitter. "Open in mail app" drafts it in your own email client now.</div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/* ============================================================ DRAFT ROOM */
// Quick pick-trade popover (opens over the hub). Pick two teams, see the picks each currently owns
// (respecting any trades already recorded), check the ones changing hands, and apply. We translate the
// final ownership into the engine's {o,to,from} override list so the board + projections update.
function TradePickModal({ teams, rounds, teamNames, userIdx, ownerOf, naturalOwnerOf, pickLabelOf, existingTrades, onClose, onApply }) {
  const TOTAL = teams * rounds;
  const others = Array.from({ length: teams }, (_, i) => i).filter((i) => i !== userIdx);
  const [teamA, setTeamA] = useState(userIdx);
  const [teamB, setTeamB] = useState(others[0] ?? (userIdx === 0 ? 1 : 0));
  // local working ownership: start from current owner of every pick, then let the user reassign.
  const [owner, setOwner] = useState(() => { const m = {}; for (let o = 0; o < TOTAL; o++) m[o] = ownerOf(o); return m; });
  const [selA, setSelA] = useState(new Set()); // picks (currently A's) to send to B
  const [selB, setSelB] = useState(new Set()); // picks (currently B's) to send to A

  const picksOf = (team) => { const out = []; for (let o = 0; o < TOTAL; o++) if (owner[o] === team) out.push(o); return out; };
  const aPicks = picksOf(teamA);
  const bPicks = picksOf(teamB);
  const toggle = (set, setter, o) => { const n = new Set(set); n.has(o) ? n.delete(o) : n.add(o); setter(n); };

  const applySwap = () => {
    const next = { ...owner };
    selA.forEach((o) => { next[o] = teamB; });
    selB.forEach((o) => { next[o] = teamA; });
    setOwner(next); setSelA(new Set()); setSelB(new Set());
  };

  const submit = () => {
    // Build the override list: any pick whose current owner != its NATURAL owner is a trade.
    const trades = [];
    for (let o = 0; o < TOTAL; o++) {
      const nat = naturalOwnerOf(o);
      if (owner[o] !== nat) trades.push({ o, to: owner[o], from: nat });
    }
    onApply(trades);
  };

  const name = (i) => (i === userIdx ? `${teamNames[i] || "Your team"} (you)` : teamNames[i]);
  const movedCount = (() => { let n = 0; for (let o = 0; o < TOTAL; o++) if (owner[o] !== naturalOwnerOf(o)) n++; return n; })();

  const PickChip = ({ o, checked, onToggle }) => (
    <button className="btn btn-mini" onClick={onToggle}
      style={{ borderColor: checked ? "var(--gold)" : "var(--line)", background: checked ? "rgba(242,182,60,.14)" : "transparent", color: checked ? "var(--gold)" : "var(--ink)", fontWeight: checked ? 700 : 400, padding: "3px 8px" }}>
      {checked ? "✓ " : ""}{pickLabelOf(o)}
    </button>
  );

  return (
    <div className="modalbg" onClick={onClose}>
      <div className="panel" style={{ maxWidth: 560, width: "100%", padding: 20, borderColor: "var(--gold)", maxHeight: "88vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <div className="disp" style={{ fontSize: 19, fontWeight: 700 }}><i className="ti ti-arrows-exchange" style={{ fontSize: 17, marginRight: 6, color: "var(--gold)" }} aria-hidden="true" />Trade picks</div>
          <button className="btn btn-mini" onClick={onClose}>Close</button>
        </div>
        <div className="mut" style={{ fontSize: 12, marginBottom: 14, lineHeight: 1.5 }}>Pick the two teams, check the picks each is sending, and hit Swap. Repeat for multiple swaps, then Apply — the board and projections update instantly.</div>

        {/* team selectors */}
        <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
          <div style={{ flex: 1 }}>
            <div className="mut" style={{ fontSize: 11, marginBottom: 3 }}>Team A</div>
            <select className="gs" style={{ width: "100%" }} value={teamA} onChange={(e) => { setTeamA(+e.target.value); setSelA(new Set()); }}>
              {Array.from({ length: teams }, (_, i) => i).filter((i) => i !== teamB).map((i) => <option key={i} value={i}>{name(i)}</option>)}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <div className="mut" style={{ fontSize: 11, marginBottom: 3 }}>Team B</div>
            <select className="gs" style={{ width: "100%" }} value={teamB} onChange={(e) => { setTeamB(+e.target.value); setSelB(new Set()); }}>
              {Array.from({ length: teams }, (_, i) => i).filter((i) => i !== teamA).map((i) => <option key={i} value={i}>{name(i)}</option>)}
            </select>
          </div>
        </div>

        {/* picks each team owns */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
          <div className="panel" style={{ padding: 10, background: "var(--panel2)" }}>
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, color: teamA === userIdx ? "var(--gold)" : "var(--ink)" }}>{name(teamA)} sends →</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              {aPicks.length ? aPicks.map((o) => <PickChip key={o} o={o} checked={selA.has(o)} onToggle={() => toggle(selA, setSelA, o)} />) : <span className="mut" style={{ fontSize: 11 }}>No remaining picks</span>}
            </div>
          </div>
          <div className="panel" style={{ padding: 10, background: "var(--panel2)" }}>
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, color: teamB === userIdx ? "var(--gold)" : "var(--ink)" }}>{name(teamB)} sends →</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              {bPicks.length ? bPicks.map((o) => <PickChip key={o} o={o} checked={selB.has(o)} onToggle={() => toggle(selB, setSelB, o)} />) : <span className="mut" style={{ fontSize: 11 }}>No remaining picks</span>}
            </div>
          </div>
        </div>

        <button className="btn btn-gold" style={{ width: "100%", marginBottom: 12 }} disabled={selA.size === 0 && selB.size === 0} onClick={applySwap}>
          <i className="ti ti-switch-horizontal" style={{ fontSize: 14, marginRight: 5 }} aria-hidden="true" />Swap selected picks
        </button>

        {movedCount > 0 && (
          <div className="panel" style={{ padding: "8px 10px", marginBottom: 12, background: "#16140c", borderColor: "var(--gold)" }}>
            <div className="gold" style={{ fontSize: 11.5, fontWeight: 600 }}>{movedCount} pick{movedCount === 1 ? "" : "s"} moved from their original owner.</div>
            <div className="mut" style={{ fontSize: 10.5, marginTop: 2 }}>Apply to save these into the draft. Anything you swap by mistake can be swapped back before applying.</div>
          </div>
        )}

        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <div style={{ flex: 1 }} />
          <button className="btn btn-gold" onClick={submit}>Apply trades</button>
        </div>
      </div>
    </div>
  );
}

function KeepersEditor({ cfg, players, onSave, onChange, embedded, section }) {
  const teamsN = cfg.teams || 12;
  const names = (cfg.teamNames && cfg.teamNames.length === teamsN) ? cfg.teamNames : TEAM_NAMES_POOL.slice(0, teamsN);
  const TOTAL = teamsN * cfg.rounds;
  const [keepers, setKeepers] = useState(cfg.keepers || []);
  const [trades, setTrades] = useState(cfg.pickTrades || []);
  // in embedded (setup) mode, push every change straight up to the parent form
  useEffect(() => { if (embedded && onChange) onChange({ ...cfg, keepers, pickTrades: trades }); }, [keepers, trades]);
  const showKeepers = !section || section === "keepers";
  const showTrades = !section || section === "trades";
  // working set for engine helpers below (so owned-pick lists reflect pending trades)
  const ownerOf = (o) => { const t = trades.find((x) => x.o === o); return t ? t.to : naturalOwner(o); };
  const picksOwnedBy = (team) => { const out = []; for (let o = 0; o < TOTAL; o++) if (ownerOf(o) === team) out.push(o); return out; };

  // keeper draft row state
  const [kPlayer, setKPlayer] = useState("");
  const [kTeam, setKTeam] = useState(0);
  const [kMode, setKMode] = useState("pick"); // pick | nocost
  const [kPick, setKPick] = useState("");
  const [pSearch, setPSearch] = useState("");

  const usedPlayerIds = new Set(keepers.map((k) => k.playerId));
  const usedPicks = new Set(keepers.filter((k) => k.o != null).map((k) => k.o));
  const playerOpts = useMemo(() => players.filter((p) => POS.includes(p.pos) && !usedPlayerIds.has(p.id) && (!pSearch || p.name.toLowerCase().includes(pSearch.toLowerCase()))).slice(0, 40), [players, pSearch, keepers]);

  const addKeeper = () => {
    if (kPlayer === "") return;
    const pid = +kPlayer;
    if (kMode === "pick") { if (kPick === "") return; setKeepers((ks) => [...ks, { playerId: pid, team: kTeam, o: +kPick }]); }
    else setKeepers((ks) => [...ks, { playerId: pid, team: kTeam, o: null }]);
    setKPlayer(""); setKPick(""); setPSearch("");
  };
  const removeKeeper = (i) => setKeepers((ks) => ks.filter((_, j) => j !== i));

  const save = () => onSave({ ...cfg, keepers, pickTrades: trades });

  // picks owned by the selected keeper team (respecting trades), minus picks already used as keepers
  const ownedForKeeper = picksOwnedBy(kTeam).filter((o) => !usedPicks.has(o));

  return (
    <div className={embedded ? "" : "panel"} style={embedded ? {} : { padding: 18, marginTop: 14 }}>
      {!embedded && <>
        <div className="disp" style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Keepers & pick trades</div>
        <div className="mut" style={{ fontSize: 12.5, marginBottom: 16 }}>Mostly for manual leagues — set who's kept and any traded picks, and they'll populate the board and feed the projections and value/summary. Editable anytime.</div>
      </>}

      {/* PICK TRADES — a simple per-pick ownership table: each pick shows its original owner
          and a "new owner" dropdown. Changing it records (or clears) a trade automatically. */}
      {showTrades && <>
      <div className="disp gold" style={{ fontSize: 12, letterSpacing: ".06em", marginBottom: 6 }}>WHO OWNS EACH PICK</div>
      <div className="mut" style={{ fontSize: 11.5, marginBottom: 10, lineHeight: 1.5 }}>Every pick starts with its natural owner. If a pick was traded, just change its <b style={{ color: "var(--ink)" }}>owner</b> on the right — the change saves itself. Picks that moved are highlighted.</div>
      <div style={{ maxHeight: 360, overflowY: "auto", paddingRight: 4 }}>
        {Array.from({ length: TOTAL }, (_, o) => o).map((o) => {
          const natural = naturalOwner(o);
          const cur = ownerOf(o);
          const moved = cur !== natural;
          return (
            <div key={o} style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 8px", borderRadius: 6, marginBottom: 3, background: moved ? "#16140c" : "transparent", border: `1px solid ${moved ? "var(--gold)" : "transparent"}` }}>
              <span className="num disp" style={{ width: 42, fontSize: 13, fontWeight: 700 }}>{pickLabel(o)}</span>
              <span className="mut" style={{ width: 96, fontSize: 11.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{names[natural]}</span>
              <span className="mut" style={{ fontSize: 12 }}>→</span>
              <select className="gs" style={{ flex: 1, minWidth: 0 }} value={cur} onChange={(e) => {
                const to = +e.target.value;
                setTrades((ts) => {
                  const rest = ts.filter((t) => t.o !== o);
                  return to === natural ? rest : [...rest, { o, to, from: natural }];
                });
              }}>
                {names.map((n, i) => <option key={i} value={i}>{n}{i === natural ? " (original)" : ""}</option>)}
              </select>
              {moved && <button className="btn btn-mini" style={{ padding: "1px 7px" }} title="Reset to original owner" onClick={() => setTrades((ts) => ts.filter((t) => t.o !== o))}>↺</button>}
            </div>
          );
        })}
      </div>
      {trades.length > 0 && <div className="gold" style={{ fontSize: 11.5, marginTop: 8 }}>{trades.length} pick{trades.length === 1 ? "" : "s"} traded from their original owner.</div>}
      </>}

      {/* KEEPERS */}
      {showKeepers && <>
      <div className="disp gold" style={{ fontSize: 12, letterSpacing: ".06em", margin: showTrades ? "16px 0 6px" : "0 0 6px" }}>KEEPERS</div>
      <div className="mut" style={{ fontSize: 11.5, marginBottom: 10, lineHeight: 1.5 }}>Add each player a team is keeping. A keeper either <b style={{ color: "var(--ink)" }}>uses up a draft pick</b> (that slot is locked to them on the board) or is <b style={{ color: "var(--ink)" }}>free</b> (added as an extra roster spot, no pick spent). Either way they're removed from the available pool.</div>
      <div className="panel" style={{ padding: 12, background: "var(--panel2)", marginBottom: 10 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
          <span className="mut" style={{ fontSize: 12 }}>Team</span>
          <select className="gs" value={kTeam} onChange={(e) => { setKTeam(+e.target.value); setKPick(""); }}>{names.map((n, i) => <option key={i} value={i}>{n}</option>)}</select>
          <span className="mut" style={{ fontSize: 12 }}>keeps</span>
          <input className="gs" style={{ width: 140 }} placeholder="Search player…" value={pSearch} onChange={(e) => setPSearch(e.target.value)} />
          <select className="gs" value={kPlayer} onChange={(e) => setKPlayer(e.target.value)}>
            <option value="">Select player…</option>
            {playerOpts.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.pos})</option>)}
          </select>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <span className="mut" style={{ fontSize: 12 }}>costing</span>
          <select className="gs" value={kMode} onChange={(e) => setKMode(e.target.value)}>
            <option value="pick">a draft pick…</option>
            <option value="nocost">nothing (free keeper)</option>
          </select>
          {kMode === "pick" && (
            <select className="gs" value={kPick} onChange={(e) => setKPick(e.target.value)}>
              <option value="">which pick?</option>
              {ownedForKeeper.map((o) => <option key={o} value={o}>{pickLabel(o)}</option>)}
            </select>
          )}
          <button className="btn btn-mini btn-gold" style={{ marginLeft: "auto" }} onClick={addKeeper} disabled={kPlayer === "" || (kMode === "pick" && kPick === "")}>+ Add keeper</button>
        </div>
        {kMode === "pick" && ownedForKeeper.length === 0 && <div className="mut" style={{ fontSize: 11, marginTop: 6 }}>{names[kTeam]} has no remaining picks — they've traded them away or used them on other keepers. Use “nothing (free keeper)” instead.</div>}
      </div>

      {keepers.length > 0 ? <div>
        <div className="disp mut" style={{ fontSize: 10.5, letterSpacing: ".06em", marginBottom: 4 }}>KEEPERS SET ({keepers.length})</div>
        {keepers.map((k, i) => {
          const p = players[k.playerId];
          return (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, padding: "4px 8px", borderRadius: 6, marginBottom: 3, border: "1px solid var(--line)" }}>
              {p && <Dot pos={p.pos} />}<span style={{ flex: 1 }}>{p ? p.name : "?"} <span className="mut">— {names[k.team]}</span></span>
              <span className="num" style={{ fontSize: 11, color: k.o != null ? "var(--ink)" : "var(--gold)" }}>{k.o != null ? `costs ${pickLabel(k.o)}` : "free"}</span>
              <button className="btn btn-mini" style={{ padding: "1px 7px" }} onClick={() => removeKeeper(i)}>✕</button>
            </div>
          );
        })}
      </div> : <div className="mut" style={{ fontSize: 12 }}>No keepers set yet.</div>}
      </>}

      {!embedded && <button className="btn btn-gold" style={{ marginTop: 14 }} onClick={save}>Save keepers & trades to board</button>}
    </div>
  );
}


function DraftRoom({ league, user, isMock, isDemo, initialTab, onSave, onExit, onBuy, onSettings, onEditRanks, onUseRankSet, onColPrefs }) {
  const cfg = league.cfg;
  // Live per-pick ownership from a connected platform (Sleeper draft_slot). Declared here so it can
  // be applied to the engine's team-assignment BEFORE any roster/sim computation in this render.
  const [liveSlots, setLiveSlots] = useState(null); // { overallPickIndex: teamIndex } or null
  // Real Sleeper clock: { deadlineMs, timerSec, skewMs } from the live draft. skewMs aligns the
  // server's clock to the browser's so the countdown matches Sleeper exactly and survives refreshes.
  const [liveClock, setLiveClock] = useState(null);
  // set active team count + names for this league before any engine call
  setTeams(cfg.teams || 12);
  setSpec(cfg.start);
  setOrder(cfg.order || "snake");
  setPickTrades(cfg.pickTrades);
  // When connected and synced, the real draft_slot of each pick is the source of truth for who made
  // it — this makes 3rd-round-reversal, custom orders, and traded picks all correct automatically.
  setLivePickTeams(liveSlots);
  // Keepers: pick-cost keepers occupy a board slot; no-cost keepers default onto a roster.
  const keepers = cfg.keepers || [];
  const keeperByPick = {}; // overall pick index -> playerId (pick-cost keepers)
  const noCostByTeam = {}; // teamIdx -> [playerId] (no-cost keepers)
  keepers.forEach((k) => {
    if (k.playerId == null) return;
    if (k.o != null) keeperByPick[k.o] = k.playerId;
    else if (k.team != null) (noCostByTeam[k.team] = noCostByTeam[k.team] || []).push(k.playerId);
  });
  setKeeperAdds(noCostByTeam);
  setTeamNames(cfg.teamNames && cfg.teamNames.length === (cfg.teams || 12) ? cfg.teamNames : TEAM_NAMES_POOL.slice(0, cfg.teams || 12));
  const ROUNDS = cfg.rounds;
  const TOTAL = totalOf(cfg);
  const hasSlot = cfg.slot != null && cfg.slot >= 1;
  const userIdx = hasSlot ? cfg.slot - 1 : 0; // fallback for engine; UI nudges user to set it

  const [picks, setPicks] = useState(league.picks || []);
  const [preds, setPreds] = useState(league.preds || []);
  const [paused, setPaused] = useState(false);
  const [fast, setFast] = useState(false);
  // Mocks wait for an explicit Start so you can watch them unfold. Official drafts run immediately.
  // Resuming an in-progress mock (picks already made) counts as already started.
  const [started, setStarted] = useState((!isMock && !isDemo) || (league.picks || []).length > 0);
  // How picks are entered. Mocks AND the demo default to AUTO (engine drafts opponents, stops on
  // your pick) and only ever offer auto/manual — never platform sync. Official drafts: if a platform
  // is connected, adopt it; otherwise ask on arrival (default manual).
  const mockLike = isMock || isDemo;
  const connectedPlatform = cfg.connect && cfg.connect.platform ? cfg.connect.platform : null;
  const defaultOfficialMode = connectedPlatform === "sleeper" ? "sleeper" : connectedPlatform ? connectedPlatform : "manual";
  const [draftMode, setDraftModeRaw] = useState(cfg.draftMode || (mockLike ? "auto" : defaultOfficialMode)); // auto | manual | sleeper | espn | yahoo | ...
  const setDraftMode = (m) => { setDraftModeRaw(m); if (!mockLike && onSettings) onSettings({ ...cfg, draftMode: m }); };
  const autoSim = draftMode === "auto"; // engine fills opponent picks only in auto mode
  // Only prompt an official draft for its mode when we genuinely don't know (no platform connected
  // and the user hasn't already chosen). Mocks and the demo never show the platform prompt.
  const askOfficialMode = !mockLike && !connectedPlatform && !cfg.draftMode;
  const [mockTradingOn, setMockTradingOn] = useState(false); // in-mock trading with CPU teams (opt-in)
  const [tab, setTab] = useState(initialTab || "hub");
  const [tradeModalOpen, setTradeModalOpen] = useState(false); // quick pick-trade popover over the hub
  const [strategy, setStrategy] = useState("balanced");
  const [search, setSearch] = useState("");
  const [posFilter, setPosFilter] = useState("ALL");
  const [sortState, setSortState] = useState({ key: "adp", dir: 1 });
  const [showDrafted, setShowDrafted] = useState(false); // default: show best AVAILABLE; toggle to include drafted
  const [rookieOnly, setRookieOnly] = useState(false);
  const DEFAULT_COLS = { adp: true, consensus: false, edge: true, proj: true, floor: false, ceil: false, vbd: true, rank: true, vbdTier: true, adpTier: false, mockAdp: false, myRank: false, blendAdp: false, age: false, bye: true, avail: true, nextpick: false, passYd: true, passTD: true, rushYd: true, rushTD: true, rec: true, recYd: true, recTD: true, tgt: false };
  const DEFAULT_SECTION_ORDER = ["market", "mine", "value", "demo", "avail", "stat"];
  const savedPrefs = user?.colPrefs || null;
  const [cols, setCols] = useState({ ...DEFAULT_COLS, ...(savedPrefs?.cols || {}) });
  const [boardMode, setBoardMode] = useState(savedPrefs?.boardMode || "info");
  const [sectionOrder, setSectionOrder] = useState(savedPrefs?.sectionOrder || DEFAULT_SECTION_ORDER);
  // Persist column layout to the user so future drafts open the same way (until they change it again).
  useEffect(() => { if (onColPrefs) onColPrefs({ cols, boardMode, sectionOrder }); }, [cols, boardMode, sectionOrder]);
  const [colMenu, setColMenu] = useState(false);
  const [briefOpen, setBriefOpen] = useState(false);
  const [teamView, setTeamView] = useState(-1);
  const [railProj, setRailProj] = useState(true);
  const [teamsProj, setTeamsProj] = useState(false);
  const [boardProj, setBoardProj] = useState(false);
  const [showBoardVal, setShowBoardVal] = useState(false); // toggle pick-value under each name
  const [pastBig, setPastBig] = useState(false);
  const [futureBig, setFutureBig] = useState(false);
  const [tip, setTip] = useState(null);
  const [copied, setCopied] = useState(false);
  const [endConfirm, setEndConfirm] = useState(false);
  const [ranksWarn, setRanksWarn] = useState(false);
  const [needMode, setNeedMode] = useState("strength"); // strength | filled
  const [customPick, setCustomPick] = useState("");
  const [availSort, setAvailSort] = useState("adp"); // "adp" | "vbd" — Availability tab sort
  // Pick lens: how ranked lists are ordered on the pick-decision views (Hub + Availability).
  //  "market"  = how the LEAGUE sees it — ADP order (what others will draft). Best for predicting.
  //  "yourbuild" = how YOUR demographic should value it — VBD/age-adjusted edge (dynasty youth tilt).
  const [pickLens, setPickLens] = useState("market");
  const [sumSort, setSumSort] = useState({ key: "z", dir: -1 });
  const [summaryTeam, setSummaryTeam] = useState(null); // null = you + league-wide; else a team idx
  const [capWarn, setCapWarn] = useState(null);
  const connected = !!cfg.connect;
  const [clock, setClock] = useState(90);

  const players = useMemo(() => buildPlayers(cfg), [cfg]);
  // Resolve keepers pulled from a connected league (Sleeper) — name+slot → engine id+team — and merge
  // them as no-cost roster adds, so each keeper shows on the right team and counts toward strength.
  useMemo(() => {
    const ck = cfg.connect && Array.isArray(cfg.connect.keepers) ? cfg.connect.keepers : [];
    if (!ck.length) return;
    const byName = {}; players.forEach((p) => { byName[normName(p.name)] = p.id; });
    const merged = {};
    Object.entries(KEEPER_ADDS).forEach(([t, ids]) => { merged[t] = [...ids]; });
    ck.forEach((k) => {
      const id = byName[normName(k.name)];
      const team = (k.slot || 0) - 1;
      if (id != null && team >= 0) { (merged[team] = merged[team] || []).push(id); }
    });
    setKeeperAdds(merged);
  }, [cfg, players]);
  // ADP-Mock: average overall pick a player went at across THIS league's stored mocks.
  // Only meaningful in the official draft (mocks belong to this league's umbrella).
  const mockAdp = useMemo(() => {
    const src = (!isMock && league.mocks) ? league.mocks : [];
    const sum = {}, cnt = {};
    src.forEach((m) => { (m.picks || []).forEach((pid, o) => { if (pid == null) return; sum[pid] = (sum[pid] || 0) + (o + 1); cnt[pid] = (cnt[pid] || 0) + 1; }); });
    const avg = {}; Object.keys(sum).forEach((id) => { avg[id] = sum[id] / cnt[id]; });
    return { avg, cnt, n: src.length };
  }, [league, isMock]);
  useEffect(() => { if (mockAdp.n > 0) setCols((c) => (c.mockAdp ? c : { ...c, mockAdp: true })); }, [mockAdp.n]);
  const sortedAdp = useMemo(() => players.slice().sort((a, b) => a.adp - b.adp), [players]);
  // Personal rankings resolved for this league's format (empty if the user has none for it).
  const myRanks = useMemo(() => resolveMyRanks(players, cfg, user, user?.rankAdj, league.mockOf != null ? league.mockOf : league.id), [players, cfg, user, league]);
  useEffect(() => { if (myRanks.has) setCols((c) => (c.myRank && c.blendAdp ? c : { ...c, myRank: true, blendAdp: true })); }, [myRanks.has]);
  const draftedSet = useMemo(() => { const s = new Set(picks); Object.values(noCostByTeam).flat().forEach((id) => s.add(id)); return s; }, [picks, cfg]);
  const done = picks.length >= TOTAL;
  // Demo stops after a limited number of rounds (it's not "complete" — you must purchase to continue).
  const demoCap = isDemo && cfg.demoRounds ? cfg.demoRounds * TEAMS : null;
  const demoCapped = demoCap != null && picks.length >= demoCap && !user?.paid;
  const onClock = !done ? teamAt(picks.length) : -1;
  const round = Math.floor(Math.min(picks.length, TOTAL - 1) / TEAMS) + 1;
  const dem = demand(cfg.sf);

  const userPicksMade = picks.filter((_, o) => teamAt(o) === userIdx).length;
  // Paywall gating. The demo plays its capped rounds, then stops with a purchase prompt (the draft is
  // NOT marked complete — you'd continue if you bought). Non-demo unpaid drafts gate after 5 picks.
  const gated = !user?.paid && (isDemo ? demoCapped : (userPicksMade >= 5 && !done));

  // Auto-place any pick-cost keeper the instant the draft reaches its slot (before normal
  // drafting decides that pick). Runs at start and after every pick, for any team's slot.
  useEffect(() => {
    if (done) return;
    const next = picks.length;
    const kid = keeperByPick[next];
    if (kid != null && !draftedSet.has(kid)) {
      setPreds((pp) => [...pp, null]); // keepers aren't "predicted"
      setPicks((prev) => [...prev, kid]);
    }
  }, [picks.length, done, cfg]);

  // Reconcile keepers set or changed MID-draft: a keeper overrides whatever happened before.
  // For every pick-cost keeper whose slot was already drafted past, force that slot to hold the
  // kept player. If the kept player was taken elsewhere, we SWAP the two slots (always board-safe).
  // If he wasn't on the board yet, the player sitting in the keeper's slot is bumped back to the
  // live pool and that slot becomes the keeper — handled by replacing in place (no re-indexing).
  const keeperSig = JSON.stringify(keepers);
  useEffect(() => {
    const fixes = [];
    Object.entries(keeperByPick).forEach(([oStr, kid]) => {
      const o = +oStr;
      if (o < picks.length && picks[o] !== kid) fixes.push({ o, kid });
    });
    if (!fixes.length) return;
    setPicks((prev) => {
      const next = prev.slice();
      fixes.forEach(({ o, kid }) => {
        const dup = next.indexOf(kid);
        if (dup >= 0) { const bumped = next[o]; next[o] = kid; next[dup] = bumped; } // clean swap
        else { next[o] = kid; } // replace in place; the bumped player re-enters the available pool
      });
      return next;
    });
  }, [keeperSig]);

  /* autosave every 5 picks and on completion */
  useEffect(() => { if (picks.length && (picks.length % 5 === 0 || done)) onSave(picks, preds); }, [picks.length, done]);

  const sims = useMemo(() => (!done ? runSims(players, sortedAdp, picks, userIdx, cfg, strategy, 300) : null), [players, sortedAdp, picks, userIdx, cfg, done, strategy, liveSlots]);
  const customSims = useMemo(() => {
    const n = parseInt(customPick, 10);
    if (!n || n <= picks.length || done) return null;
    return survivalAtPick(players, sortedAdp, picks, n, cfg, 800);
  }, [customPick, players, sortedAdp, picks, cfg, done]);

  const advice = useMemo(() => {
    if (!sims || done) return null;
    const pickNum = picks.length + 1;
    const myCounts = { QB: 0, RB: 0, WR: 0, TE: 0 };
    picks.forEach((pk, o) => { const pl = players[pk]; if (teamAt(o) === userIdx && pl && myCounts[pl.pos] != null) myCounts[pl.pos]++; });
    const bestNow = { QB: null, RB: null, WR: null, TE: null };
    for (const p of sortedAdp) if (!draftedSet.has(p.id) && (!bestNow[p.pos] || p.vbd > bestNow[p.pos].vbd)) bestNow[p.pos] = p;
    const waitCost = {};
    POS.forEach((pos) => { waitCost[pos] = bestNow[pos] ? Math.round((bestNow[pos].vbd - sims.expBest1[pos]) * 10) / 10 : 0; });
    const pool0 = sortedAdp.filter((p) => !draftedSet.has(p.id) && p.adp <= pickNum + 16).slice(0, 40);
    const pool = legalCands(pool0, myCounts, cfg);
    // Use the SAME scoring as the projection so the rail verdict and the projected
    // path agree. Waiting cost nudges within that, but reach penalty (inside userScore)
    // keeps early picks anchored to consensus.
    const scoreOf = (p) => userScore(p, myCounts, dem, strategy, cfg.sf, pickNum) + 0.6 * Math.max(0, waitCost[p.pos]);
    const ranked = pool.slice().sort((a, b) => scoreOf(b) - scoreOf(a));
    const verdict = ranked[0]; const alts = ranked.slice(1, 4);
    const impacts = {};
    [verdict, ...alts].forEach((c) => { if (!c) return; const pr = projectAll(players, sortedAdp, picks, userIdx, cfg, strategy, c.id); impacts[c.id] = { pts: pr.pts[userIdx], rank: pr.rank[userIdx] }; });
    const recent = picks.slice(-8).map((id) => players[id] && players[id].pos).filter(Boolean);
    let run = null;
    POS.forEach((pos) => { const c = recent.filter((x) => x === pos).length; if (c >= 3 && (!run || c > run.count)) run = { pos, count: c }; });
    return { bestNow, waitCost, verdict, alts, impacts, run, myCounts };
  }, [sims, picks, players, sortedAdp, draftedSet, userIdx, cfg, strategy, done, dem]);

  // SELECTIVE insight tags. The whole point is to pull your eye to the few players you should
  // actually be locked into right now — not to label half the board. We build a small, capped set
  // of highlighted players (the recommendation, its alternatives, a real run/scarcity threat you'd
  // want, and genuine standout value within reach), then tag only those. Everything else stays clean.
  const POS_LABEL = { QB: "QB", RB: "RB", WR: "WR", TE: "TE" };
  const highlights = useMemo(() => {
    const out = {}; // id -> { label, color, rank } ; lower rank = higher priority
    if (!advice || done) return out;
    const pickNum = picks.length + 1;
    const add = (id, label, color, rank) => { if (id == null) return; if (!out[id] || rank < out[id].rank) out[id] = { label, color, rank }; };
    const survOf = (id) => (sims && sims.pct[0] ? sims.pct[0][id] : null);
    const needAt = (pos) => advice.myCounts[pos] != null && (dem[pos] || 0) > 0 && advice.myCounts[pos] < (dem[pos] || 0);

    // 1) the model's single best pick right now
    if (advice.verdict) add(advice.verdict.id, "Top pick", "#d6aa4b", 0);
    // 2) the model's next-best alternatives (these ARE the shortlist to consider)
    (advice.alts || []).slice(0, 2).forEach((a) => add(a.id, "Consider", "#d6aa4b", 1));
    // 3) a genuine positional run at a spot you still need to fill — flag the best body there
    if (advice.run && needAt(advice.run.pos) && advice.bestNow[advice.run.pos]) {
      add(advice.bestNow[advice.run.pos].id, `${POS_LABEL[advice.run.pos]} run — act now`, "#EF6A6A", 0.5);
    }
    // 4) scarcity: a clearly-elite player at a need position who likely will NOT survive to your next pick
    POS.forEach((pos) => {
      const b = advice.bestNow[pos];
      if (b && needAt(pos)) { const s = survOf(b.id); if (s != null && s <= 20 && b.adp <= pickNum + 6) add(b.id, "Won't last", "#EF6A6A", 0.7); }
    });
    // 5) standout VALUE within reach. True value = a player whose actual value (VBD rank) is
    // meaningfully better than where he's going (ADP) AND who is a top option available around
    // now — not someone this platform merely over-drafts, and not a deep sleeper out of range.
    // We require BOTH: (a) value rank clearly ahead of ADP, and (b) he's one of the best players
    // still on the board (top of sortedAdp), so we never tag a worse player "value" over a better
    // one sitting right next to him.
    const topAvailIds = new Set(sortedAdp.filter((p) => !draftedSet.has(p.id)).slice(0, 24).map((p) => p.id));
    let valuePicks = sortedAdp
      .filter((p) => !draftedSet.has(p.id) && topAvailIds.has(p.id) && p.valueRank != null
        && p.adp <= pickNum + 8                       // realistically in range
        && (p.adp - p.valueRank) >= 10                // his value clearly beats his draft slot
        && (p.consensus == null || p.adp >= p.consensus - 2)) // not just a local over-draft
      .map((p) => ({ p, val: p.adp - p.valueRank }))
      .sort((a, b) => b.val - a.val)
      .slice(0, 2)
      .map((x) => x.p);
    valuePicks.forEach((p) => add(p.id, "Value", "#5BA8F5", 2));

    // hard cap: keep only the top few by priority so the board stays clean and scannable
    const ranked = Object.entries(out).sort((a, b) => a[1].rank - b[1].rank).slice(0, 5);
    const capped = {};
    ranked.forEach(([id, v]) => { capped[id] = v; });
    return capped;
  }, [advice, sims, picks, draftedSet, sortedAdp, dem, done]);

  const insightTag = (p) => {
    if (done || draftedSet.has(p.id)) return null;
    return highlights[p.id] || null;
  };

  const proj = useMemo(() => projectAll(players, sortedAdp, picks, userIdx, cfg, strategy, advice?.verdict?.id ?? null), [players, sortedAdp, picks, userIdx, cfg, strategy, advice, liveSlots]);
  // League-RELATIVE position strength: score every team's roster at each position (best + depth VBD),
  // then split the league into thirds → green (top third), amber (middle), red (bottom third). This is
  // what makes the Teams tab meaningful: it shows who's actually ahead/behind at each spot, so you
  // don't see every team green. Uses current (drafted-only) or projected rosters to match the toggle.
  const posRel = useMemo(() => {
    const score = {}; // teamIdx -> { QB,RB,WR,TE: number }
    for (let i = 0; i < TEAMS; i++) {
      const ros = teamsProj && proj ? proj.rosters[i] : picks.map((pk, o) => (teamAt(o) === i ? players[pk] : null)).filter(Boolean);
      const byPos = { QB: [], RB: [], WR: [], TE: [] };
      ros.forEach((p) => { if (p && byPos[p.pos]) byPos[p.pos].push(p.vbd != null ? p.vbd : -40); });
      const s = {};
      POS.forEach((pos) => {
        const arr = byPos[pos].sort((a, b) => b - a);
        const req = REQ_F(cfg.sf)[pos] || 1;
        // weight: starters count full, bench depth at a discount; empty starter slots are penalized.
        let v = 0; for (let k = 0; k < Math.max(req, arr.length); k++) { const val = arr[k] != null ? arr[k] : -35; v += val * (k < req ? 1 : 0.25); }
        s[pos] = v;
      });
      score[i] = s;
    }
    // rank teams per position → tercile (0 green / 1 amber / 2 red)
    const level = {}; for (let i = 0; i < TEAMS; i++) level[i] = {};
    POS.forEach((pos) => {
      const order = Array.from({ length: TEAMS }, (_, i) => i).sort((a, b) => score[b][pos] - score[a][pos]);
      order.forEach((teamIdx, rank) => {
        const frac = rank / Math.max(1, TEAMS - 1); // 0 = best, 1 = worst
        level[teamIdx][pos] = frac <= 0.33 ? 0 : frac <= 0.66 ? 1 : 2;
      });
    });
    return level;
  }, [players, picks, cfg, teamsProj, proj, userIdx, liveSlots]);
  const projBoard = useMemo(() => (boardProj ? projectBoard(players, sortedAdp, picks, userIdx, cfg, strategy, advice?.verdict?.id ?? null) : null), [boardProj, players, sortedAdp, picks, userIdx, cfg, strategy, advice]);
  // The user's next few upcoming pick indices (for highlighting on the board).
  const myUpcoming = useMemo(() => {
    const set = new Set(); let n = 0;
    for (let o = picks.length; o < TOTAL && n < 3; o++) { if (teamAt(o) === userIdx) { set.add(o); n++; } }
    return set;
  }, [picks.length, TOTAL, userIdx, cfg, liveSlots]);
  const path = useMemo(() => (!done ? projectPath(players, sortedAdp, picks, userIdx, cfg, strategy, advice?.verdict?.id ?? null, futureBig) : []), [players, sortedAdp, picks, userIdx, cfg, strategy, advice, done, futureBig, liveSlots]);

  const currentPred = !done ? (onClock === userIdx ? advice?.verdict ?? null : path[0]?.p ?? null) : null;
  const currentProb = !done && onClock !== userIdx ? path[0]?.prob : null;

  useEffect(() => {
    if (!autoSim) return; // manual / platform-sync: every pick is entered by the user or the feed
    if (!started || paused || done || onClock === userIdx || gated) return;
    if (keeperByPick[picks.length] != null) return; // keeper effect fills this slot
    const t = setTimeout(() => {
      setPicks((prev) => {
        if (prev.length >= TOTAL || teamAt(prev.length) === userIdx) return prev;
        const drafted = new Set(prev);
        Object.values(noCostByTeam).flat().forEach((id) => drafted.add(id));
        const counts = { QB: 0, RB: 0, WR: 0, TE: 0 };
        prev.forEach((pk, o) => { const pl = players[pk]; if (pl && teamAt(o) === teamAt(prev.length) && counts[pl.pos] != null) counts[pl.pos]++; });
        const recent = prev.slice(-8).map((id) => players[id] && players[id].pos).filter(Boolean);
        const pickNum = prev.length + 1, rd = Math.floor(prev.length / TEAMS) + 1;
        const cands0 = []; for (const p of sortedAdp) { if (!drafted.has(p.id)) { cands0.push(p); if (cands0.length >= 34) break; } }
        const cands = legalCands(cands0, counts, cfg);
        const ws = cands.map((c) => weightFor(c, pickNum, counts, rd, recent, dem, ROUNDS));
        const chosen = cands[sample(cands, ws)];
        setPreds((pp) => [...pp, currentPred ? currentPred.id : null]);
        return [...prev, chosen.id];
      });
    }, fast ? 250 : 950);
    return () => clearTimeout(t);
  }, [started, paused, done, picks, onClock, userIdx, players, sortedAdp, dem, fast, currentPred, gated, cfg, ROUNDS, TOTAL, autoSim]);

  // ---- LIVE SLEEPER SYNC ----------------------------------------------------------------------
  // When this league is connected to Sleeper and we're in "sleeper" mode, poll the draft every few
  // seconds and translate incoming Sleeper picks into engine picks (matched by player name). You make
  // each pick inside Sleeper; the compass reads them in and keeps your board current.
  const nameToId = useMemo(() => { const m = {}; players.forEach((p) => { m[normName(p.name)] = p.id; }); return m; }, [players]);
  const [syncState, setSyncState] = useState({ status: null, lastAt: null, error: null });
  const sleeperLive = connectedPlatform === "sleeper" && draftMode === "sleeper" && !!(cfg.connect && cfg.connect.leagueId) && hasBackend;
  useEffect(() => {
    if (!sleeperLive || done) return;
    let alive = true;
    const pull = async () => {
      try {
        const d = await api.sleeperDraft(cfg.connect.leagueId, cfg.connect.username);
        if (!alive) return;
        // Build the engine pick list from Sleeper's pick order, mapping names→ids and dropping any
        // we can't match (rare). We only grow the list; we never reorder existing picks. We also
        // capture each pick's REAL team (draft_slot-1) so rosters match the actual draft exactly.
        const mapped = [];
        const slotTeam = {}; // overall pick index -> team index (draft_slot - 1)
        for (const pk of (d.picks || [])) {
          const id = nameToId[normName(pk.name)];
          if (id != null) {
            const o = mapped.length; // overall index in our compacted list
            if (pk.draft_slot) slotTeam[o] = pk.draft_slot - 1;
            mapped.push(id);
          }
        }
        setSyncState({ status: d.status, lastAt: Date.now(), error: null });
        setLiveSlots(slotTeam);
        // Capture Sleeper's real clock. serverNowMs lets us correct for any difference between the
        // server's clock and this browser's, so the countdown lines up with what Sleeper shows.
        if (d.pickDeadlineMs && d.serverNowMs) {
          setLiveClock({ deadlineMs: d.pickDeadlineMs, timerSec: d.pickTimerSec || 0, skewMs: Date.now() - d.serverNowMs });
        } else {
          setLiveClock(d.pickTimerSec ? { deadlineMs: null, timerSec: d.pickTimerSec, skewMs: 0 } : null);
        }
        setPicks((prev) => {
          // Only update if Sleeper is ahead of us (more picks) to avoid clobbering local state.
          if (mapped.length > prev.length) return mapped;
          return prev;
        });
        // If a trade happened in the league (traded picks changed), update the league settings so the
        // board's pick ownership stays correct. Compare against what we have stored.
        if (onSettings && Array.isArray(d.tradedPicks)) {
          const incoming = JSON.stringify(d.tradedPicks);
          const have = JSON.stringify(cfg.connect.tradedPicks || []);
          if (incoming !== have) {
            const N = cfg.teams || 12;
            const pickTrades = tradesToOwnerOverrides(d.tradedPicks, N, cfg.order || "snake");
            onSettings({ ...cfg, pickTrading: true, pickTrades, connect: { ...cfg.connect, tradedPicks: d.tradedPicks } });
          }
        }
      } catch (e) {
        if (alive) setSyncState((s) => ({ ...s, error: "Sync paused — retrying…" }));
      }
    };
    pull(); // immediate
    const iv = setInterval(pull, 5000);
    return () => { alive = false; clearInterval(iv); };
  }, [sleeperLive, done, cfg, nameToId]);

  const draftPlayer = (id) => {
    if (done || draftedSet.has(id) || (gated && onClock === userIdx)) return;
    const p = players[id];
    // enforce EXPLICIT per-position caps on manual picks (engine already enforces them in sims)
    if (cfg.caps && cfg.caps[p.pos] != null && cfg.caps[p.pos] !== "" && +cfg.caps[p.pos] > 0) {
      const teamCount = picks.filter((pk, o) => teamAt(o) === onClock && players[pk].pos === p.pos).length;
      if (teamCount >= +cfg.caps[p.pos]) {
        setCapWarn({ pos: p.pos, cap: +cfg.caps[p.pos], team: onClock === userIdx ? "Your team" : TEAM_NAMES[onClock] });
        setTimeout(() => setCapWarn(null), 3200);
        return;
      }
    }
    setCapWarn(null);
    setPreds((pp) => [...pp, currentPred ? currentPred.id : null]);
    setPicks((prev) => [...prev, id]);
    setSearch(""); setTip(null);
  };
  const undo = () => { setPaused(true); setTip(null); setPicks((p) => p.slice(0, -1)); setPreds((p) => p.slice(0, -1)); };
  // Pick clock. For a live Sleeper draft we compute remaining time from Sleeper's REAL deadline
  // (deadlineMs, corrected for server/client clock skew), so it matches the Sleeper app exactly and
  // stays correct across refreshes. For mock/simulated drafts we fall back to a local countdown.
  useEffect(() => {
    if (done) return;
    // Live Sleeper clock: derive remaining seconds from the real deadline, tick every second.
    if (liveClock && liveClock.deadlineMs) {
      const compute = () => {
        const nowAligned = Date.now() - (liveClock.skewMs || 0); // browser time aligned to server
        const remaining = Math.max(0, Math.round((liveClock.deadlineMs - nowAligned) / 1000));
        setClock(remaining);
      };
      compute();
      const t = setInterval(compute, 1000);
      return () => clearInterval(t);
    }
    // Untimed/slow Sleeper draft: no countdown (Sleeper allows hours/days per pick).
    if (liveClock && liveClock.timerSec === 0) { setClock(0); return; }
    // Simulated/mock fallback: local countdown from the per-pick timer (or 90s default).
    if (!connected) return;
    setClock(liveClock?.timerSec || 90);
    if (paused) return;
    const t = setInterval(() => setClock((c) => (c > 0 ? c - 1 : 0)), 1000);
    return () => clearInterval(t);
  }, [connected, done, paused, picks.length, liveClock]);
  const exit = () => { onSave(picks, preds); onExit(); };

  const hits = preds.filter((pr, i) => pr != null && pr === picks[i]).length;
  const posHits = preds.filter((pr, i) => pr != null && picks[i] != null && players[pr].pos === players[picks[i]].pos).length;

  // value accessor per sortable column key
  const colVal = (p, key) => {
    switch (key) {
      case "name": return p.name;
      case "adp": return p.adp;
      case "consensus": return p.consensus;
      case "edge": return p.adp - p.consensus;
      case "pts": case "proj": return p.pts;
      case "floor": return p.floor;
      case "ceil": return p.ceil;
      case "vbd": return p.vbd;
      case "rank": return p.posRank;
      case "vbdTier": return p.vbdTier;
      case "adpTier": return p.adpTier;
      case "mockAdp": return mockAdp.avg[p.id] != null ? mockAdp.avg[p.id] : 999;
      case "myRank": return myRanks.map[p.id] ? myRanks.map[p.id].rank : 9999;
      case "blendAdp": return myRanks.map[p.id] ? myRanks.map[p.id].blend : 9999;
      case "age": return p.age || 99;
      case "bye": return p.bye || 99;
      case "avail": return sims ? (sims.pct[0][p.id] ?? -1) : -1;
      case "nextpick": return sims && sims.pct[1] ? (sims.pct[1][p.id] ?? -1) : -1;
      case "passYd": case "passTD": case "rushYd": case "rushTD": case "rec": case "recYd": case "recTD": case "tgt":
        return p.stats?.[key] || 0;
      default: return p.adp;
    }
  };
  // default sort direction per column (asc for ADP/rank/age/bye/tiers; desc for value/odds)
  const defaultDir = (key) => (["adp", "consensus", "rank", "vbdTier", "adpTier", "age", "bye", "name"].includes(key) ? 1 : -1);
  const setSort = (key) => setSortState((s) => (s.key === key ? { key, dir: -s.dir } : { key, dir: defaultDir(key) }));

  const myCurrent = picks.map((pk, o) => ({ p: players[pk], o })).filter((x) => teamAt(x.o) === userIdx).map((x) => x.p);

  // ---- CONTENTION WINDOW ("Your build" demographics) -----------------------------------------
  // Reads YOUR roster's age lean to infer your window: rebuild (young) / balanced / win-now (old).
  // Crucially it stays UNDECIDED in the early rounds — you haven't committed to a lane until you've
  // made enough picks (you can't tell a build from 2 players). Once decided, the "Your build" lens
  // tilts the board toward players that fit your window. Most meaningful in dynasty, but a mild bias
  // applies in any league. Returns { lane, label, confidence, picksIn, tilt(pos,age)->multiplier }.
  const myWindow = useMemo(() => {
    const isDyn = cfg.type === "dynasty" || cfg.type === "keeper";
    // Weight earlier picks more (they define your core). Use only skill positions with a known age.
    const aged = myCurrent.filter((p) => p.age && ["QB", "RB", "WR", "TE"].includes(p.pos));
    let wsum = 0, asum = 0;
    aged.forEach((p, i) => { const w = 1 / (1 + i * 0.25); wsum += w; asum += w * p.age; });
    const avgAge = wsum ? asum / wsum : null;
    // Don't pick a lane until round ~4 — before that you're just taking value, no window yet.
    const DECIDE_AT = 4;
    const decided = aged.length >= DECIDE_AT && avgAge != null;
    let lane = "undecided", label = "Reading your build…";
    if (decided) {
      // thresholds differ slightly by format; dynasty cares more about youth
      const youngCut = isDyn ? 24.5 : 25.0;
      const oldCut = isDyn ? 27.5 : 28.0;
      if (avgAge <= youngCut) { lane = "rebuild"; label = "Young / rebuild window"; }
      else if (avgAge >= oldCut) { lane = "winnow"; label = "Win-now window"; }
      else { lane = "balanced"; label = "Balanced window"; }
    }
    // confidence grows with how many picks in you are past the decision point
    const confidence = decided ? Math.min(1, (aged.length - DECIDE_AT + 1) / 6) : 0;
    // tilt multiplier for the Your-build lens. For a committed rebuild, an old player should clearly
    // fall behind a younger one of similar value — a small haircut isn't enough, so the tilt is strong
    // and scales with how far the player is from your window's ideal age. Win-now is the mirror image.
    const tilt = (pos, age) => {
      if (!decided || !age || !["QB", "RB", "WR", "TE"].includes(pos)) return 1;
      if (lane === "balanced") return 1;
      // center age by position (rough prime). youthScore > 0 = younger than center, < 0 = older.
      const center = pos === "RB" ? 25 : pos === "WR" ? 26 : pos === "TE" ? 27 : 28;
      const youthScore = (center - age) / 4; // steeper than before (÷4 not ÷6)
      // strength scales with confidence; dynasty tilts hard, redraft only mildly.
      const strength = (isDyn ? 0.42 : 0.10) * confidence;
      const raw = lane === "rebuild" ? 1 + strength * youthScore : 1 - strength * youthScore;
      // clamp so we lift/penalize meaningfully but never invert value entirely
      return Math.max(0.35, Math.min(1.6, raw));
    };
    return { lane, label, confidence, picksIn: aged.length, avgAge, decided, tilt };
  }, [myCurrent, cfg.type]);

  const rows = useMemo(() => {
    let list = players.slice();
    if (posFilter !== "ALL") list = list.filter((p) => p.pos === posFilter);
    if (rookieOnly) list = list.filter((p) => p.rookie);
    if (search) { const q = search.toLowerCase(); list = list.filter((p) => p.name.toLowerCase().includes(q)); }
    if (!showDrafted) list = list.filter((p) => !draftedSet.has(p.id));
    const { key, dir } = sortState;
    // "Your build" lens = sorting by VBD. When you've committed to a contention window (round 4+),
    // tilt the value by how well each player fits your window (younger for a rebuild, proven for
    // win-now). Before you've picked a lane, this is a no-op, so early rounds rank on pure value.
    const buildLens = key === "vbd";
    list.sort((a, b) => {
      if (buildLens && myWindow.decided) {
        const va = (a.vbd ?? -50) * myWindow.tilt(a.pos, a.age);
        const vb = (b.vbd ?? -50) * myWindow.tilt(b.pos, b.age);
        return (va - vb) * dir;
      }
      const va = colVal(a, key), vb = colVal(b, key);
      if (typeof va === "string") return va.localeCompare(vb) * dir;
      return (va - vb) * dir;
    });
    return list.slice(0, 130);
  }, [players, posFilter, search, showDrafted, sortState, draftedSet, sims, rookieOnly, myWindow]);

  // Column registry. group: "draft" (board intelligence) or "stat" (projection inputs).
  // section groups columns under labeled dividers in the table + columns menu.
  const COL_DEFS = [
    // — ADP & market —
    { key: "adp", label: "ADP", group: "draft", section: "market", num: true, sortable: true, tip: "This platform's average draft position." },
    { key: "consensus", label: "Consensus", group: "draft", section: "market", num: true, sortable: true, tip: "Field-wide consensus ADP — the average draft position across many public sources, independent of your platform." },
    { key: "edge", label: "Edge", group: "draft", section: "market", num: true, sortable: true, needsPlatform: true },
    { key: "adpTier", label: "ADP tier", group: "draft", section: "market", num: true, sortable: true, tip: "Tier from gaps in market ADP." },
    { key: "mockAdp", label: "ADP mock", group: "draft", section: "market", num: true, sortable: true, needsMocks: true, tip: "Average pick this player went at across your mock drafts for this league." },
    // — Your board (only when you have ranks matching this league's type + format) —
    { key: "myRank", label: "My ADP", group: "draft", section: "mine", num: true, sortable: true, needsRanks: true, tip: "Your personal rank for this format. Players you didn't rank fall into their consensus spot." },
    { key: "blendAdp", label: "Blend", group: "draft", section: "mine", num: true, sortable: true, needsRanks: true, tip: "Your personal rank blended with public consensus (weighted ~65% toward you) — your opinion, tempered by the market." },
    // — Valuation —
    { key: "proj", label: "Proj", group: "draft", section: "value", num: true, sortable: true, sortKey: "pts", tip: "Projected season points in this scoring." },
    { key: "floor", label: "Floor", group: "draft", section: "value", num: true, sortable: true, tip: "Realistic low-end outcome." },
    { key: "ceil", label: "Ceil", group: "draft", section: "value", num: true, sortable: true, tip: "Realistic high-end outcome." },
    { key: "vbd", label: "VBD", group: "draft", section: "value", num: true, sortable: true },
    { key: "rank", label: "Rank", group: "draft", section: "value", num: true, sortable: true, tip: "Position rank by projected points." },
    { key: "vbdTier", label: "VBD tier", group: "draft", section: "value", num: true, sortable: true, tip: "Overall value tier from gaps in VBD." },
    // — Demographics —
    { key: "age", label: "Age", group: "draft", section: "demo", num: true, sortable: true },
    { key: "bye", label: "Bye", group: "draft", section: "demo", num: true, sortable: true },
    // — Availability —
    { key: "avail", label: "Avail @ next", group: "draft", section: "avail", num: true, sortable: true, tip: "Chance he survives to your next pick." },
    { key: "nextpick", label: "@ pick after", group: "draft", section: "avail", num: true, sortable: true, tip: "Chance he survives to the pick after next." },
    // — Projected stats —
    { key: "passYd", label: "Pass yd", group: "stat", section: "stat", num: true, sortable: true },
    { key: "passTD", label: "Pass TD", group: "stat", section: "stat", num: true, sortable: true },
    { key: "rushYd", label: "Rush yd", group: "stat", section: "stat", num: true, sortable: true },
    { key: "rushTD", label: "Rush TD", group: "stat", section: "stat", num: true, sortable: true },
    { key: "rec", label: "Rec", group: "stat", section: "stat", num: true, sortable: true },
    { key: "tgt", label: "Tgt", group: "stat", section: "stat", num: true, sortable: true },
    { key: "recYd", label: "Rec yd", group: "stat", section: "stat", num: true, sortable: true },
    { key: "recTD", label: "Rec TD", group: "stat", section: "stat", num: true, sortable: true },
  ];
  const SECTION_LABELS = { market: "ADP & market", mine: "Your board", value: "Valuation", demo: "Demographics", avail: "Availability", stat: "Projected stats" };
  const colAvailable = (c) => !(c.needsPlatform && !connected) && !(c.needsMocks && mockAdp.n === 0) && !(c.needsRanks && !myRanks.has);
  // boardMode controls which sections show. The ADP/market group is always visible and always
  // pinned leftmost. "info" = your board + valuation + demographics + availability.
  // "stats" = projected stats only (everything else is hidden).
  const sectionVisible = (sec) => {
    if (sec === "market") return true; // ADP & market always shows, always first
    if (boardMode === "stats") return sec === "stat";
    return sec !== "stat"; // info mode: your board / valuation / demographics / availability
  };
  // market is force-pinned first; the rest follow the user's chosen order.
  const orderedSections = ["market", ...sectionOrder.filter((s) => s !== "market")];
  const activeCols = orderedSections
    .filter(sectionVisible)
    .flatMap((sec) => COL_DEFS.filter((c) => c.section === sec && cols[c.key] && colAvailable(c)));
  // mark the first active column of each section so we can draw a divider line before it
  const sectionStart = {};
  let _prevSec = null;
  activeCols.forEach((c) => { if (c.section !== _prevSec) { sectionStart[c.key] = c.section; _prevSec = c.section; } });
  const arrow = (k) => (sortState.key === k ? (sortState.dir < 0 ? " ▾" : " ▴") : "");
  const cellFor = (p, key, gone) => {
    const av = sims ? sims.pct[0][p.id] : null;
    const av2 = sims && sims.pct[1] ? sims.pct[1][p.id] : null;
    const edge = Math.round(p.adp - p.consensus);
    switch (key) {
      case "adp": return p.adp.toFixed(1);
      case "consensus": return <span className="mut">{p.consensus.toFixed(1)}</span>;
      case "edge": return <span style={{ color: edge > 3 ? "var(--green)" : edge < -3 ? "var(--red)" : "var(--mut)" }}>{edge > 0 ? `+${edge}` : edge}</span>;
      case "proj": return p.pts;
      case "floor": return <span className="mut">{p.floor}</span>;
      case "ceil": return <span className="mut">{p.ceil}</span>;
      case "vbd": return <span style={{ color: p.vbd > 0 ? "var(--ink)" : "var(--mut)" }}>{p.vbd > 0 ? `+${p.vbd.toFixed(0)}` : p.vbd.toFixed(0)}</span>;
      case "rank": return <span style={{ color: POS_COLOR[p.pos] || "var(--mut)" }}>{p.pos}{p.posRank}</span>;
      case "vbdTier": return <span className="mut">T{p.vbdTier}</span>;
      case "adpTier": return <span className="mut">T{p.adpTier}</span>;
      case "mockAdp": { const v = mockAdp.avg[p.id]; return v != null ? <span title={`across ${mockAdp.cnt[p.id]} of ${mockAdp.n} mocks`}>{v.toFixed(1)}</span> : <span className="mut">—</span>; }
      case "myRank": { const r = myRanks.map[p.id]; if (!r) return <span className="mut">—</span>; return r.exact ? <span className="gold" style={{ fontWeight: 700 }} title="Your personal rank">{r.rank}</span> : <span className="mut" title="Consensus spot — you didn't personally rank this player">{r.rank}</span>; }
      case "blendAdp": { const r = myRanks.map[p.id]; if (!r) return <span className="mut">—</span>; return <span style={{ color: "var(--gold2)" }} title="Your rank blended with public consensus">{r.blend.toFixed(1)}</span>; }
      case "age": return p.age || "—";
      case "bye": return p.bye || "—";
      case "avail": return gone ? "—" : av != null ? <span style={{ color: av < 35 ? "var(--red)" : av > 75 ? "var(--green)" : "var(--ink)" }}>{av}%</span> : "…";
      case "nextpick": return gone ? "—" : av2 != null ? <span className="mut">{av2}%</span> : "—";
      default: return <span className="mut">{p.stats?.[key] || "—"}</span>;
    }
  };

  const briefing = useMemo(() => {
    if (!advice || !sims) return null;
    const v = advice.verdict;
    const sec = [];
    if (v) {
      const imp = advice.impacts[v.id];
      // 1. The recommendation headline
      sec.push({ h: "Recommendation", strong: v.name, body: `${v.pos}${v.posRank}${v.rookie ? " (rookie)" : ""}, overall Tier ${v.tier}. The highest-value legal pick for your roster right now.` });
      // 2. Season outlook — the story (this is the part pulled from Sleeper/news in production)
      if (v.outlook) sec.push({ h: "Player outlook", body: v.outlook });
      if (v.teamOutlook) sec.push({ h: "Team outlook", body: v.teamOutlook });
      // 3. Points projection with floor/ceiling
      sec.push({ h: "Points projection", body: `Projected ${v.pts} pts this season — floor ${v.floor}, ceiling ${v.ceil}. ${v.ceil - v.floor > v.pts * 0.42 ? "A wide, high-upside range." : "A fairly stable range."}${imp ? ` Drafting him projects your team ${ordinal(imp.rank)} at ${imp.pts} pts.` : ""}` });
      // 4. VBD trend
      sec.push({ h: "Value (VBD)", body: `${v.vbd > 0 ? "+" : ""}${v.vbd.toFixed(0)} points above replacement at ${v.pos}. ${v.vbd >= 60 ? "Elite, hard-to-replace value." : v.vbd >= 25 ? "Solid starting-caliber value." : "Roster depth more than difference-making value."}` });
      // 5. ADP / market — where he's drafted vs the field, and vs the pick on the clock right now
      const edge = Math.round(v.adp - v.consensus);
      const curPick = picks.length + 1;
      const vsHere = Math.round(v.adp - curPick);
      const hereTxt = vsHere >= 8 ? `He typically goes around pick ${v.adp.toFixed(0)} — about ${vsHere} picks later than where you are now (${curPick}), so taking him here is early relative to his market price.`
        : vsHere <= -8 ? `He typically goes around pick ${v.adp.toFixed(0)} — roughly ${Math.abs(vsHere)} picks before where you are now (${curPick}), so he's a values-here pick that's lasted past his usual cost.`
        : `He typically goes around pick ${v.adp.toFixed(0)}, right about where you are now (${curPick}) — market-priced for this spot.`;
      const edgeTxt = Math.abs(edge) <= 5 ? "Your platform's ADP and the broader field agree on his price."
        : edge > 5 ? `Your platform tends to draft him about ${edge} picks later than the wider field does — a small market inefficiency in your favor if you can wait.`
        : `Your platform tends to draft him about ${Math.abs(edge)} picks earlier than the wider field — others in your league may reach, so don't assume he'll fall.`;
      sec.push({ h: "Market & ADP", body: `${hereTxt} ${edgeTxt}` });
      // 6. Value of waiting
      const wc = Math.max(0, advice.waitCost[v.pos]);
      sec.push({ h: "Cost of waiting", body: wc >= 4 ? `If you pass, the best ${v.pos} expected at your next pick is worth about ${wc.toFixed(0)} fewer points — a real cost to waiting here.` : `The ${v.pos} pool holds up well to your next pick, so waiting is relatively cheap if you'd rather address another spot.` });
    }
    // 7. Run watch
    if (advice.run) sec.push({ h: "Run watch", body: `${advice.run.pos} run underway — ${advice.run.count} of the last 8 picks. Expect it to continue until the tier empties; ${advice.run.pos} costs are climbing.` });
    // 8. Outlook to your next pick + bye overlap
    const safe = POS.filter((pos) => advice.bestNow[pos] && advice.waitCost[pos] < 4);
    const urgent = POS.filter((pos) => advice.waitCost[pos] > 14);
    let outlook = "";
    if (urgent.length) outlook += `Steep drop-off coming at ${urgent.join(", ")} before your next pick. `;
    if (safe.length) outlook += `Safe to wait at ${safe.join(", ")}.`;
    if (outlook) sec.push({ h: "Looking ahead", body: outlook });
    const byeNote = v && myCurrent.find((p) => p.pos === v.pos && p.bye === v.bye);
    if (byeNote) sec.push({ h: "Roster note", body: `${v.name} shares a week-${v.bye} bye with ${byeNote.name}.` });
    return sec;
  }, [advice, sims, myCurrent]);

  const graded = useMemo(() => picks.map((pk, o) => { const p = players[pk]; return { p, o, t: teamAt(o), val: pickValue(p, o, cfg) }; }), [picks, players, cfg]);
  const valByTeam = useMemo(() => Array.from({ length: TEAMS }, (_, i) => graded.filter((g) => g.t === i).reduce((s, g) => s + g.val, 0)), [graded]);
  const grades = useMemo(() => {
    if (!proj) return null;
    const vMean = valByTeam.reduce((a, b) => a + b, 0) / TEAMS;
    const vSd = Math.sqrt(valByTeam.reduce((a, b) => a + (b - vMean) ** 2, 0) / TEAMS) || 1;
    const pMean = proj.pts.reduce((a, b) => a + b, 0) / TEAMS;
    const pSd = Math.sqrt(proj.pts.reduce((a, b) => a + (b - pMean) ** 2, 0) / TEAMS) || 1;
    return Array.from({ length: TEAMS }, (_, i) => {
      const z = 0.55 * ((valByTeam[i] - vMean) / vSd) + 0.45 * ((proj.pts[i] - pMean) / pSd);
      // full A–F spread so a genuinely bad draft reads as a bad draft
      const g = z >= 1.5 ? "A+" : z >= 1.05 ? "A" : z >= 0.7 ? "A−" : z >= 0.4 ? "B+" : z >= 0.12 ? "B" : z >= -0.15 ? "B−" : z >= -0.45 ? "C+" : z >= -0.75 ? "C" : z >= -1.05 ? "C−" : z >= -1.4 ? "D" : "F";
      return { z, g };
    });
  }, [valByTeam, proj]);

  const recap = useMemo(() => {
    if (!proj || !grades || picks.length < 6) return null;
    // seed from the actual draft so the SAME draft is stable but DIFFERENT drafts vary
    let seed = picks.reduce((a, id, i) => (a + id * (i + 7)) % 2147483647, picks.length * 13 + TEAMS);
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
    const steals = graded.slice().sort((a, b) => b.val - a.val);
    const reaches = graded.slice().sort((a, b) => a.val - b.val);
    const bestVal = valByTeam.indexOf(Math.max(...valByTeam));
    const worstVal = valByTeam.indexOf(Math.min(...valByTeam));
    const leader = proj.rank.indexOf(1);
    const cellar = proj.rank.indexOf(TEAMS);
    const nm = (i) => (i === userIdx ? "You" : TEAM_NAMES[i]);
    const isU = (i) => i === userIdx;
    let streak = { pos: null, len: 0 }, cur = { pos: null, len: 0 };
    picks.forEach((pk) => { const pl = players[pk]; if (!pl) return; const pos = pl.pos; if (pos === cur.pos) cur.len++; else cur = { pos, len: 1 }; if (cur.len > streak.len) streak = { ...cur }; });
    const L = [];
    L.push(pick([
      `${nm(leader)} ${isU(leader) ? "sit" : "sits"} on top of the projections at ${proj.pts[leader]} points. ${isU(leader) ? "Soak it in." : "The rest of the room has some explaining to do."}`,
      `Through ${picks.length} picks, the projected crown belongs to ${nm(leader)} (${proj.pts[leader]} pts). ${isU(leader) ? "Don't let it go to your head." : "Someone clearly read the cheat sheet."}`,
      `Pace-setter so far: ${nm(leader)}, ${proj.pts[leader]} projected points and counting. ${isU(leader) ? "Keep your foot down." : "Beatable — but only if you stop reaching."}`,
    ]));
    if (steals[0] && steals[0].val > 3) L.push(pick([
      `Heist of the draft: ${steals[0].p.name} to ${nm(steals[0].t)} at ${pickLabel(steals[0].o)}, roughly ${Math.round((steals[0].o + 1) - steals[0].p.adp)} picks past his price.`,
      `Larceny alert — ${nm(steals[0].t)} got ${steals[0].p.name} at ${pickLabel(steals[0].o)}, ${Math.round((steals[0].o + 1) - steals[0].p.adp)} spots later than the market said. Call the cops.`,
      `${nm(steals[0].t)} let ${steals[0].p.name} fall into their lap at ${pickLabel(steals[0].o)} — a ${Math.round((steals[0].o + 1) - steals[0].p.adp)}-pick discount. Rude.`,
    ]));
    if (reaches[0] && reaches[0].val < -3) L.push(pick([
      `Meanwhile ${nm(reaches[0].t)} saw ${reaches[0].p.name} and couldn't wait — ${Math.round(reaches[0].p.adp - (reaches[0].o + 1))} picks early. We'll generously call it "conviction."`,
      `${nm(reaches[0].t)} reached for ${reaches[0].p.name} a cool ${Math.round(reaches[0].p.adp - (reaches[0].o + 1))} picks ahead of ADP. Bold strategy. Let's see how it plays out.`,
      `Nobody was taking ${reaches[0].p.name} for another ${Math.round(reaches[0].p.adp - (reaches[0].o + 1))} picks, but ${nm(reaches[0].t)} wasn't taking chances. Or value.`,
    ]));
    if (streak.len >= 3) L.push(pick([
      `The room briefly lost it with a ${streak.len}-pick ${streak.pos} run. Panic is, as always, undefeated.`,
      `A ${streak.len}-deep ${streak.pos} run broke out — nothing spreads at a draft faster than positional fear.`,
      `${streak.len} straight ${streak.pos}s came off the board at one point. Herd immunity is not a draft strategy, folks.`,
    ]));
    L.push(pick([
      `Best value of anyone: ${nm(bestVal)} at ${valByTeam[bestVal] > 0 ? "+" : ""}${valByTeam[bestVal]} round-weighted. ${isU(bestVal) ? "Take a bow." : "Homework: clearly done."}`,
      `${nm(bestVal)} squeezed the most value out of the board (${valByTeam[bestVal] > 0 ? "+" : ""}${valByTeam[bestVal]}). ${isU(bestVal) ? "Nicely done." : "Annoyingly efficient."}`,
    ]));
    if (worstVal !== bestVal && valByTeam[worstVal] < -3) L.push(pick([
      `On the other end, ${nm(worstVal)} (${valByTeam[worstVal]}) drafted like ADP was a personal insult.`,
      `${nm(worstVal)} left the most value on the table (${valByTeam[worstVal]}). It happens. To them. A lot.`,
    ]));
    const gr = grades[userIdx].g;
    const bad = ["C+","C","C−","D","F"].includes(gr);
    L.push(pick(bad ? [
      `Your grade so far: ${gr}, projected ${ordinal(proj.rank[userIdx])}. Rough start — but drafts are long and the waiver wire forgives. Mostly.`,
      `Current grade: ${gr}, headed for ${ordinal(proj.rank[userIdx])}. Not pretty. The good news is there's nowhere to go but up.`,
      `You're sitting at a ${gr}, projected ${ordinal(proj.rank[userIdx])}. Time to trust the recommendations a little more, maybe?`,
    ] : [
      `Your grade so far: ${gr}, projected ${ordinal(proj.rank[userIdx])}. ${proj.rank[userIdx] <= 3 ? "Championship-window stuff." : "Right in the mix — one steal from the top tier."}`,
      `Current grade: ${gr}, tracking toward ${ordinal(proj.rank[userIdx])}. ${proj.rank[userIdx] <= 3 ? "The board is bending your way." : "Solid foundation — keep stacking value."}`,
    ]));
    return L;
  }, [proj, grades, graded, valByTeam, picks, players, userIdx]);

  // Constant recap header — the bolded, always-present headline stats (not the prose).
  const recapHead = useMemo(() => {
    if (!proj || !grades || picks.length < 6) return null;
    const nm = (i) => (i === userIdx ? "You" : TEAM_NAMES[i]);
    const steals = graded.slice().sort((a, b) => b.val - a.val);
    const reaches = graded.slice().sort((a, b) => a.val - b.val);
    const bestVal = valByTeam.indexOf(Math.max(...valByTeam));
    const worstVal = valByTeam.indexOf(Math.min(...valByTeam));
    const leader = proj.rank.indexOf(1);
    const cellar = proj.rank.indexOf(TEAMS);
    // your team's positional trend (which positions you've leaned into vs the field)
    const myPos = {}; POS.forEach((p) => (myPos[p] = 0));
    picks.forEach((pk, o) => { const pl = players[pk]; if (teamAt(o) === userIdx && pl && myPos[pl.pos] != null) myPos[pl.pos]++; });
    const leanedInto = Object.entries(myPos).sort((a, b) => b[1] - a[1])[0];
    const myCount = picks.filter((_, o) => teamAt(o) === userIdx).length;
    return {
      winner: leader >= 0 ? `${nm(leader)} — ${proj.pts[leader]} projected pts` : "—",
      loser: cellar >= 0 ? `${nm(cellar)} — ${proj.pts[cellar]} projected pts` : "—",
      steal: steals[0] ? `${steals[0].p.name} → ${nm(steals[0].t)} (${pickLabel(steals[0].o)})` : "—",
      reach: reaches[0] ? `${reaches[0].p.name} → ${nm(reaches[0].t)} (${pickLabel(reaches[0].o)})` : "—",
      bestDraft: bestVal >= 0 ? `${nm(bestVal)} (${valByTeam[bestVal] > 0 ? "+" : ""}${valByTeam[bestVal]} value)` : "—",
      worstDraft: worstVal >= 0 ? `${nm(worstVal)} (${valByTeam[worstVal]} value)` : "—",
      trend: myCount === 0 ? "No picks yet" : `${myCount} picks · leaning ${leanedInto[0]} (${leanedInto[1]}) · grade ${grades[userIdx].g} · projected ${ordinal(proj.rank[userIdx])}`,
    };
  }, [proj, grades, graded, valByTeam, picks, players, userIdx]);

  const showTip = (e, content) => { const x = Math.min(e.clientX + 14, window.innerWidth - 310); const y = Math.min(e.clientY + 10, window.innerHeight - 230); setTip({ x, y, content }); };
  const hideTip = () => setTip(null);

  const depth = useMemo(() => {
    const DEPTH_ORDER = ["QB", "RB", "WR", "TE", "K", "DST"];
    const ord2 = (pos) => { const i = DEPTH_ORDER.indexOf(pos); return i === -1 ? 99 : i; };
    // Keep depth charts tight and relevant: only the meaningful top players per position, not the
    // whole roster of camp bodies. Minimums requested: 2 QB, 4 RB, 6 WR, 3 TE, 1 K (+ 1 DST).
    const POS_CAP = { QB: 2, RB: 4, WR: 6, TE: 3, K: 1, DST: 1 };
    const byTeam = {};
    players.forEach((p) => {
      // Skip free agents / players with no real team, and players with no projected value —
      // they bloat the charts and aren't useful (a real roster, not the whole player universe).
      if (!p.team || p.team === "FA" || p.team === "FA*") return;
      if (!(p.pts > 0)) return;
      (byTeam[p.team] = byTeam[p.team] || []).push(p);
    });
    Object.keys(byTeam).forEach((team) => {
      const arr = byTeam[team].sort((a, b) => ord2(a.pos) - ord2(b.pos) || b.pts - a.pts);
      // take only the top N per position
      const seen = {};
      byTeam[team] = arr.filter((p) => { const c = POS_CAP[p.pos]; if (c == null) return false; seen[p.pos] = (seen[p.pos] || 0) + 1; return seen[p.pos] <= c; });
    });
    return Object.entries(byTeam).sort((a, b) => a[0].localeCompare(b[0]));
  }, [players]);

  const pastPicks = picks.slice(-(pastBig ? 10 : 4)).map((pk, i) => ({ pk, o: picks.length - Math.min(pastBig ? 10 : 4, picks.length) + i }));

  return (
    <div>
      <div className="hairline" style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 16px", flexWrap: "wrap" }}>
        <button className="btn btn-mini" onClick={exit}>← {user ? (user.paid ? "Home" : "Library") : "Home"}</button>
        <div className="disp" style={{ fontSize: 18, fontWeight: 700 }}>{league.name}</div>
        {isMock && <div className="chip" style={{ borderColor: "var(--gold)", background: "#1A1505", color: "var(--gold)" }} title="This is a practice draft — it saves to this league's mock history and never changes your real draft."><i className="ti ti-dice" style={{ fontSize: 12, marginRight: 4 }} aria-hidden="true" />MOCK</div>}
        <div className="chip" style={{ borderColor: "var(--gold)" }}><b className="disp gold" style={{ fontSize: 15 }}>ROUND {Math.min(round, ROUNDS)} of {ROUNDS}</b></div>
        <div className="chip">{cfg.teams} teams · {cfg.sf ? "SF" : "1QB"}{cfg.tePremMult > 0 ? ` · TE+${cfg.tePremMult}` : ""} · {DRAFT_ORDERS.find((o) => o[0] === (cfg.order || "snake"))?.[1].split(" ")[0]}</div>
        <div className="chip" title="How often the engine's #1 projection was the exact pick, and how often it nailed the position.">
          Engine: <b className="num">{hits}</b> exact{preds.length > 0 && <span className="mut num"> ({Math.round((hits / preds.length) * 100)}%)</span>} · <b className="num">{posHits}</b> pos{preds.length > 0 && <span className="mut num"> ({Math.round((posHits / preds.length) * 100)}%)</span>}
        </div>
        <select className="gs" value={strategy} onChange={(e) => setStrategy(e.target.value)} title="Strategy lens — changes your advice and your projected picks, never how opponents are predicted">
          <option value="balanced">Strategy: Balanced</option>
          <option value="value">Strategy: Max value</option>
          <option value="upside">Strategy: Upside / breakout</option>
          <option value="youth">Strategy: Youth (age)</option>
          <option value="wr">Strategy: WR-heavy</option>
          <option value="rb">Strategy: RB-heavy</option>
          <option value="adp">Strategy: Strict ADP</option>
        </select>
        <div style={{ flex: 1 }} />
        {!done && <>
          <button className="btn" onClick={() => setPaused((p) => !p)}>{paused ? "▶ Resume" : "❚❚ Pause"}</button>
          <button className="btn" onClick={() => setFast((f) => !f)}>{fast ? "Fast" : "Normal"}</button>
          {isMock && <button className="btn" style={{ borderColor: mockTradingOn ? "var(--gold)" : "var(--line)", color: mockTradingOn ? "var(--gold)" : "var(--ink)" }} onClick={() => setMockTradingOn((t) => !t)} title="Propose trades to CPU teams mid-mock — they only accept fair, format-aware deals">{mockTradingOn ? "Trading on" : "Trading off"}</button>}
          <button className="btn" onClick={() => setEndConfirm(true)} title="Stop here and jump to the summary & grades for the picks so far" disabled={picks.length < 6}>End draft</button>
        </>}
        <button className="btn" onClick={undo} disabled={!picks.length} title="Undo last pick — test what-if scenarios">Undo</button>
        {user && <button className="btn" onClick={() => { onSave(picks, preds); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>{copied ? "Saved ✓" : "Save"}</button>}
      </div>

      <div style={{ position: "sticky", top: 0, zIndex: 12, background: "var(--bg)" }}>
      {!done && (
        <div className="hairline" style={{ background: "var(--panel2)" }}>
          <div className="ticker">
            <button className="btn btn-mini" style={{ alignSelf: "center", flexShrink: 0 }} onClick={() => setPastBig((b) => !b)}>{pastBig ? "‹ less" : "« history"}</button>
            {pastPicks.map(({ pk, o }) => {
              const p = players[pk];
              const wasHit = preds[o] != null && preds[o] === pk;
              return (
                <div key={o} className="tickcard" style={{ opacity: 0.75 }}>
                  <div className="mut" style={{ fontSize: 11 }}>{pickLabel(o)} • {teamAt(o) === userIdx ? "You" : TEAM_NAMES[teamAt(o)].split(" ")[0]}</div>
                  <div style={{ fontWeight: 600, fontSize: 13 }}><Dot pos={p.pos} />{p.name}</div>
                  <div style={{ fontSize: 10, marginTop: 2, color: wasHit ? "var(--green)" : "var(--mut)" }}>{preds[o] != null ? (wasHit ? "✓ engine called it" : `engine: ${players[preds[o]].name.split(" ").slice(-1)}`) : ""}</div>
                </div>
              );
            })}
            <div className="tickcard clock" style={{ borderColor: onClock === userIdx ? "var(--gold)" : "#33476B" }}>
              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".07em", color: onClock === userIdx ? "var(--gold)" : "var(--mut)" }}>On the clock</div>
              <div className="disp" style={{ fontSize: 17, fontWeight: 700, color: onClock === userIdx ? "var(--gold)" : "var(--ink)" }}>
                {pickLabel(picks.length)} — {onClock === userIdx ? "YOU" : TEAM_NAMES[onClock]}
              </div>
              {connected && (
                <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 3 }}>
                  {liveClock && liveClock.timerSec === 0 && !liveClock.deadlineMs ? (
                    <span className="num" style={{ fontSize: 12, color: "var(--mut)" }}>Slow draft — no per-pick timer</span>
                  ) : clock <= 0 ? (
                    <span className="num" style={{ fontSize: 12, color: "var(--red)", fontWeight: 700 }}><i className="ti ti-clock-exclamation" style={{ fontSize: 12, marginRight: 4 }} aria-hidden="true" />Time expired — pick is overdue</span>
                  ) : (
                    <>
                      <i className="ti ti-clock" style={{ fontSize: 12, color: clock <= 15 ? "var(--red)" : "var(--mut)" }} aria-hidden="true" />
                      <span className="num" style={{ fontSize: 12, color: clock <= 15 ? "var(--red)" : "var(--mut)", fontWeight: clock <= 15 ? 700 : 400 }}>{Math.floor(clock / 60)}:{String(clock % 60).padStart(2, "0")} on the clock{liveClock && liveClock.deadlineMs ? " · live" : ""}</span>
                    </>
                  )}
                </div>
              )}
              {currentPred && (
                <div style={{ fontSize: 11, marginTop: 3 }} className="mut">
                  {onClock === userIdx ? <>rec: <b style={{ color: "var(--gold)" }}>{currentPred.name}</b></> : <>engine expects: <b style={{ color: "var(--ink)" }}>{currentPred.name}</b>{currentProb != null && ` (${currentProb}%)`}</>}
                </div>
              )}
              {currentPred && onClock === userIdx && !gated && (
                <button className="btn btn-gold btn-mini" style={{ marginTop: 6, width: "100%" }} onClick={() => draftPlayer(currentPred.id)}>Draft {currentPred.name.split(" ").slice(-1)}</button>
              )}
            </div>
            {(onClock === userIdx ? path : path.slice(1)).map((step) => step.user ? (
              <div key={step.o} className="tickcard you">
                <div style={{ fontSize: 11, color: "var(--gold)", textTransform: "uppercase", letterSpacing: ".07em" }}>Your pick {pickLabel(step.o)}</div>
                {step.p && <div style={{ fontWeight: 600, fontSize: 13, marginTop: 2 }}><Dot pos={step.p.pos} />{step.p.name}</div>}
                <button className="btn btn-gold btn-mini" style={{ marginTop: 5 }} onClick={() => setBriefOpen(true)}>AI briefing</button>
              </div>
            ) : (
              <div key={step.o} className="tickcard">
                <div className="mut" style={{ fontSize: 11 }}>{pickLabel(step.o)} • {TEAM_NAMES[step.t].split(" ")[0]}</div>
                <div style={{ fontWeight: 600, fontSize: 13 }}><Dot pos={step.p.pos} />{step.p.name}</div>
                <div className="meter"><div style={{ width: `${step.prob}%` }} /></div>
                <div className="mut num" style={{ fontSize: 10, marginTop: 2 }}>{step.prob}% likely</div>
              </div>
            ))}
            <button className="btn btn-mini" style={{ alignSelf: "center", flexShrink: 0 }} onClick={() => setFutureBig((b) => !b)}>{futureBig ? "less ›" : "beyond your pick »"}</button>
          </div>
        </div>
      )}

      <div className="hairline tabbar" style={{ display: "flex", padding: "0 10px", overflowX: "auto", background: "var(--bg)" }}>
        {[["hub","Hub"],["board","Draft board"],["teams","Teams"],["avail","Availability"],["adp","ADP"],["depth","Depth charts"],["trade","Trade"],["summary","Summary"],["settings","Settings"]].map(([k, label]) => (
          <button key={k} className={`tab ${tab === k ? "on" : ""}`} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>
      </div>

      {done && tab === "hub" && (
        <div style={{ padding: 16 }}>
          <div className="panel" style={{ padding: 16, display: "flex", alignItems: "center", gap: 16 }}>
            <div className="disp" style={{ fontSize: 22, fontWeight: 700 }}>Draft complete.</div>
            <button className="btn btn-gold" onClick={() => setTab("summary")}>View summary & grades</button>
          </div>
        </div>
      )}

      {tab === "hub" && !done && (
        <>
        {mockLike && !started && (
          <div style={{ padding: "12px 14px 0" }}>
            <div className="panel" style={{ padding: 16, borderColor: "var(--gold)", background: "#16140c", display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
              <i className="ti ti-player-play" style={{ fontSize: 26, color: "var(--gold)" }} aria-hidden="true" />
              <div style={{ flex: "1 1 260px" }}>
                <div className="disp" style={{ fontSize: 16, fontWeight: 700 }}>{isDemo ? "Ready to start the demo?" : "Ready to run this mock?"}</div>
                <div className="mut" style={{ fontSize: 12.5, lineHeight: 1.5 }}>{autoSim ? `The engine drafts the other teams and stops on your pick so you can choose. ${isDemo ? "This demo runs 3 rounds." : "Pause anytime."}` : "Manual entry — you'll enter every pick yourself. The engine still advises you and tracks the board."}</div>
                <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
                  <span className="mut" style={{ fontSize: 11.5, alignSelf: "center" }}>Picks entered by:</span>
                  {[["auto", "Autodraft", "The engine drafts the other teams and stops on your pick"], ["manual", "Manual entry", "You type every pick as it comes"]].map(([m, lbl, tip]) => (
                    <button key={m} className="btn btn-mini" title={tip} style={{ borderColor: draftMode === m ? "var(--gold)" : "var(--line)", color: draftMode === m ? "var(--gold)" : "var(--ink)", fontWeight: draftMode === m ? 700 : 400 }} onClick={() => setDraftMode(m)}>{lbl}</button>
                  ))}
                </div>
              </div>
              <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                {autoSim && <label className="mut" style={{ fontSize: 11.5, display: "flex", alignItems: "center", gap: 5 }}>
                  <input type="checkbox" checked={fast} onChange={(e) => setFast(e.target.checked)} style={{ accentColor: "var(--gold)" }} /> Fast mode
                </label>}
                <label className="mut" style={{ fontSize: 11.5, display: "flex", alignItems: "center", gap: 5 }} title="Let you propose trades to CPU teams mid-mock. They only accept fair, format-aware deals.">
                  <input type="checkbox" checked={mockTradingOn} onChange={(e) => setMockTradingOn(e.target.checked)} style={{ accentColor: "var(--gold)" }} /> Enable trading
                </label>
                <button className="btn btn-gold" style={{ padding: "10px 22px", fontSize: 14 }} onClick={() => setStarted(true)}><i className="ti ti-player-play" style={{ fontSize: 13, marginRight: 5 }} aria-hidden="true" />Start mock</button>
              </div>
            </div>
          </div>
        )}
        {askOfficialMode && picks.length === 0 && (
          <div style={{ padding: "12px 14px 0" }}>
            <div className="panel" style={{ padding: 16, borderColor: "var(--gold)", background: "#16140c" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
                <i className="ti ti-broadcast" style={{ fontSize: 22, color: "var(--gold)" }} aria-hidden="true" />
                <div>
                  <div className="disp" style={{ fontSize: 16, fontWeight: 700 }}>How are picks coming in?</div>
                  <div className="mut" style={{ fontSize: 12.5, lineHeight: 1.5 }}>This is your real draft, so the engine never picks for the room — choose how each selection gets entered. (Connect a platform on the league and we'll set this for you automatically.)</div>
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 8 }}>
                {[
                  ["manual", "ti-keyboard", "Manual entry", "Type each pick as it happens. Works for any platform or an in-person draft."],
                  ["sleeper", "ti-plug-connected", "Sync from Sleeper", "Picks flow in live from your Sleeper draft. You still select in Sleeper; we read it and advise."],
                  ["espn", "ti-plug-connected", "Other platform", "ESPN, Yahoo, and others: connect to import settings; picks come in via fast manual entry at launch."],
                ].map(([m, icon, lbl, desc]) => (
                  <button key={m} onClick={() => setDraftMode(m)} className="bigact" style={{ textAlign: "left", cursor: "pointer", fontFamily: "inherit", color: "var(--ink)", padding: 12, borderRadius: 10, border: `1.5px solid ${draftMode === m ? "var(--gold)" : "var(--line)"}`, background: draftMode === m ? "rgba(214,170,75,0.10)" : "var(--panel2)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 4 }}>
                      <i className={`ti ${icon}`} style={{ fontSize: 15, color: draftMode === m ? "var(--gold)" : "var(--mut)" }} aria-hidden="true" />
                      <span className="disp" style={{ fontSize: 14, fontWeight: 700, color: draftMode === m ? "var(--gold)" : "var(--ink)" }}>{lbl}</span>
                    </div>
                    <div className="mut" style={{ fontSize: 11, lineHeight: 1.4 }}>{desc}</div>
                  </button>
                ))}
              </div>
              {draftMode !== "manual" && <div className="mut" style={{ fontSize: 11, marginTop: 10, lineHeight: 1.45 }}><i className="ti ti-info-circle" style={{ fontSize: 12, marginRight: 4 }} aria-hidden="true" />{draftMode === "sleeper" && sleeperLive ? "Sleeper sync is live — picks made in your Sleeper draft flow in automatically every few seconds. You can also enter a pick manually if needed." : "Live auto-sync is Sleeper-only. On any other platform, enter each pick here as it happens — the engine advises in real time exactly the same way."}</div>}
            </div>
          </div>
        )}
        {!isMock && connectedPlatform && picks.length === 0 && (
          <div style={{ padding: "12px 14px 0" }}>
            <div className="panel" style={{ padding: 12, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", background: "#0d1410", borderColor: "var(--green)" }}>
              <i className="ti ti-plug-connected" style={{ fontSize: 18, color: "var(--green)" }} aria-hidden="true" />
              <div style={{ flex: "1 1 240px" }}>
                <div style={{ fontWeight: 600, color: "var(--green)" }}>{(PLATFORMS.find((x) => x.id === connectedPlatform)?.name) || "Platform"} connected — picks come in {connectedPlatform === "sleeper" ? "live" : "automatically"}</div>
                <div className="mut" style={{ fontSize: 12, lineHeight: 1.45 }}>{connectedPlatform === "sleeper" ? "We read your Sleeper draft as it happens and advise in real time — you still make each pick inside Sleeper." : "Your league is linked, so selections flow in from the platform. The engine advises; it never picks for the room."} Prefer to type picks yourself instead?</div>
              </div>
              <button className="btn btn-mini" onClick={() => setDraftMode("manual")} style={{ borderColor: draftMode === "manual" ? "var(--gold)" : "var(--line)", color: draftMode === "manual" ? "var(--gold)" : "var(--ink)" }}>{draftMode === "manual" ? "✓ Manual entry" : "Switch to manual"}</button>
            </div>
          </div>
        )}
        {isMock && hasSlot && cfg.slotRandomized && picks.length === 0 && (
          <div style={{ padding: "12px 14px 0" }}>
            <div className="panel" style={{ padding: 12, borderColor: "var(--gold)", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", background: "#16120A" }}>
              <i className="ti ti-dice" style={{ fontSize: 18, color: "var(--gold)" }} aria-hidden="true" />
              <div style={{ flex: "1 1 240px" }}>
                <div style={{ fontWeight: 600, color: "var(--gold)" }}>Mock slot: Pick {cfg.slot}</div>
                <div className="mut" style={{ fontSize: 12 }}>This league has no fixed draft order, so each mock drops you at a random slot — run several from different seats and the trends will show how your results shift. Change it before your first pick if you want a specific seat.</div>
              </div>
              <select className="gs" value={cfg.slot} onChange={(e) => onSettings({ ...cfg, slot: +e.target.value })}>
                {Array.from({ length: cfg.teams }, (_, i) => <option key={i} value={i + 1}>Pick {i + 1}</option>)}
              </select>
              <button className="btn btn-mini" onClick={() => onSettings({ ...cfg, slot: Math.floor(Math.random() * cfg.teams) + 1 })}><i className="ti ti-arrows-shuffle" style={{ fontSize: 12, marginRight: 4 }} aria-hidden="true" />Re-roll</button>
            </div>
          </div>
        )}
        {!hasSlot && (
          <div style={{ padding: "12px 14px 0" }}>
            <div className="panel" style={{ padding: 12, borderColor: "var(--gold)", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", background: "#16120A" }}>
              <i className="ti ti-map-pin" style={{ fontSize: 18, color: "var(--gold)" }} aria-hidden="true" />
              <div style={{ flex: "1 1 240px" }}>
                <div style={{ fontWeight: 600, color: "var(--gold)" }}>Set your draft slot</div>
                <div className="mut" style={{ fontSize: 12 }}>You drafted "decide later." Pick your slot now (or trade into one) and the engine will tailor every projection to your seat. Until then it assumes pick 1.</div>
              </div>
              <select className="gs" defaultValue="" onChange={(e) => { if (e.target.value) onSettings({ ...cfg, slot: +e.target.value }); }}>
                <option value="">Select slot…</option>
                {Array.from({ length: cfg.teams }, (_, i) => <option key={i} value={i + 1}>Pick {i + 1}</option>)}
              </select>
            </div>
          </div>
        )}
        {capWarn && (
          <div style={{ padding: "12px 14px 0" }}>
            <div className="alert">{capWarn.team} is at the league cap of {capWarn.cap} {capWarn.pos}{capWarn.cap > 1 ? "s" : ""} — that pick is blocked. (Caps also reduce opponents' competition for that position in the projections.)</div>
          </div>
        )}
        <div className="cols" style={{ display: "flex", gap: 14, padding: 14, alignItems: "flex-start" }}>
          <div className="panel" style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", gap: 8, padding: 10, flexWrap: "wrap", alignItems: "center", position: "relative" }} className="hairline">
              <input className="gs" style={{ width: 200 }} placeholder="Type a name — Enter drafts top hit"
                value={search} onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { const hit = rows.find((p) => !draftedSet.has(p.id)); if (hit) draftPlayer(hit.id); } }} />
              {["ALL", ...POS].map((p) => (
                <button key={p} className="btn btn-mini" style={{ borderColor: posFilter === p ? "var(--gold)" : "var(--line)" }} onClick={() => setPosFilter(p)}>{p}</button>
              ))}
              <button className="btn btn-mini" style={{ borderColor: rookieOnly ? "var(--gold)" : "var(--line)", color: rookieOnly ? "var(--gold)" : "var(--ink)" }} onClick={() => setRookieOnly((r) => !r)}>Rookies</button>
              <div style={{ display: "inline-flex", border: "1px solid var(--line)", borderRadius: 7, overflow: "hidden" }} title="Market = order the league is likely to draft in (ADP). Your build = your demographic edge — tilts toward players that fit your contention window (young/rebuild vs win-now), once you've committed to a lane around round 4-6.">
                <span className="mut" style={{ fontSize: 10.5, alignSelf: "center", padding: "0 7px" }}>View</span>
                <button className="btn btn-mini" style={{ borderRadius: 0, border: "none", minWidth: 64, textAlign: "center", background: sortState.key === "adp" ? "var(--gold)" : "transparent", color: sortState.key === "adp" ? "#1A1505" : "var(--ink)", fontWeight: sortState.key === "adp" ? 700 : 400 }} onClick={() => setSortState({ key: "adp", dir: 1 })} title="How the league sees it — ADP order">Market</button>
                <button className="btn btn-mini" style={{ borderRadius: 0, border: "none", minWidth: 76, textAlign: "center", background: sortState.key === "vbd" ? "var(--gold)" : "transparent", color: sortState.key === "vbd" ? "#1A1505" : "var(--ink)", fontWeight: sortState.key === "vbd" ? 700 : 400 }} onClick={() => setSortState({ key: "vbd", dir: -1 })} title="Your demographic edge — value tilted to your window">Your build</button>
              </div>
              {sortState.key === "vbd" && (
                <span className="mut" style={{ fontSize: 10.5, alignSelf: "center", display: "inline-flex", alignItems: "center", gap: 4 }} title={myWindow.decided ? `Based on your roster's age lean (avg ~${myWindow.avgAge?.toFixed(1)}). Tilt strengthens as you draft.` : "You haven't committed to a contention window yet — ranking on pure value until ~round 4."}>
                  <i className={`ti ${myWindow.lane === "rebuild" ? "ti-seedling" : myWindow.lane === "winnow" ? "ti-flame" : myWindow.lane === "balanced" ? "ti-scale" : "ti-loader"}`} style={{ fontSize: 12, color: myWindow.decided ? "var(--gold)" : "var(--mut)" }} aria-hidden="true" />
                  {myWindow.label}
                </span>
              )}
              <div style={{ flex: 1 }} />
              <div style={{ display: "inline-flex", border: "1px solid var(--line)", borderRadius: 7, overflow: "hidden" }} title="ADP always shows on the left. This switches the rest of the columns between value/info (rankings, projections, demographics, availability) and projected stats.">
                <button className="btn btn-mini" style={{ borderRadius: 0, border: "none", background: boardMode === "info" ? "var(--gold)" : "transparent", color: boardMode === "info" ? "#1A1505" : "var(--ink)", fontWeight: boardMode === "info" ? 700 : 400 }} onClick={() => setBoardMode("info")} title="Rankings, projections, value, demographics & availability">Value &amp; info</button>
                <button className="btn btn-mini" style={{ borderRadius: 0, border: "none", background: boardMode === "stats" ? "var(--gold)" : "transparent", color: boardMode === "stats" ? "#1A1505" : "var(--ink)", fontWeight: boardMode === "stats" ? 700 : 400 }} onClick={() => setBoardMode("stats")} title="Projected passing / rushing / receiving stat lines">Projected stats</button>
              </div>
              <button className="btn btn-mini" onClick={() => setShowDrafted((s) => !s)} title={showDrafted ? "Currently showing every player — drafted ones are crossed out. Click to hide them." : "Currently hiding drafted players — only those still available show. Click to show everyone."}>
                <i className={`ti ${showDrafted ? "ti-eye" : "ti-eye-off"}`} style={{ fontSize: 13, marginRight: 4 }} aria-hidden="true" />{showDrafted ? "All players" : "Available only"}
              </button>
              <button className="btn btn-mini" onClick={() => setRanksWarn(true)} title="Edit your personal rankings (leaves the draft — it'll auto-save)"><i className="ti ti-list-numbers" style={{ fontSize: 13 }} aria-hidden="true" /> My ranks</button>
              <button className="btn btn-mini" onClick={() => setTradeModalOpen(true)} title="Record a draft-pick trade — who traded which pick to whom. The board updates instantly." style={{ borderColor: (cfg.pickTrades || []).length ? "var(--gold)" : "var(--line)", color: (cfg.pickTrades || []).length ? "var(--gold)" : "var(--ink)" }}><i className="ti ti-arrows-exchange" style={{ fontSize: 13, marginRight: 3 }} aria-hidden="true" /> Trade picks{(cfg.pickTrades || []).length ? ` (${(cfg.pickTrades || []).length})` : ""}</button>
              <button className="btn btn-mini" onClick={() => setColMenu((m) => !m)}><i className="ti ti-columns" style={{ fontSize: 13 }} aria-hidden="true" /> Columns</button>
              {colMenu && (
                <div className="panel" style={{ position: "absolute", right: 10, top: 46, zIndex: 30, padding: 12, width: 252, boxShadow: "0 10px 30px #000C" }}>
                  <div className="mut" style={{ fontSize: 10.5, marginBottom: 8, lineHeight: 1.4 }}>You're editing the <b style={{ color: "var(--gold)" }}>{boardMode === "stats" ? "Stats" : "Value"}</b> view. ADP stays pinned on the left. {boardMode === "stats" ? "Switch to Value (top of board) to edit valuation & demographics." : "Switch to Stats (top of board) to choose projected-stat columns."}</div>
                  {/* group order — market excluded (always first); only the groups visible in this mode */}
                  {orderedSections.filter((s) => s !== "market" && sectionVisible(s)).length > 1 && <>
                    <div className="disp" style={{ fontSize: 9.5, letterSpacing: ".08em", color: "var(--gold)", marginBottom: 4, textTransform: "uppercase" }}>Group order</div>
                    <div style={{ marginBottom: 10 }}>
                      {orderedSections.filter((s) => s !== "market" && sectionVisible(s)).map((sec, i, arr) => (
                        <div key={sec} style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 0", fontSize: 11.5 }}>
                          <span style={{ flex: 1 }}>{SECTION_LABELS[sec]}</span>
                          <button className="btn btn-mini" style={{ padding: "1px 6px" }} disabled={i === 0} onClick={() => { const full = sectionOrder.filter((s) => s !== "market"); const a = full.indexOf(sec); const b = full.indexOf(arr[i - 1]); [full[a], full[b]] = [full[b], full[a]]; setSectionOrder(full); }}>▲</button>
                          <button className="btn btn-mini" style={{ padding: "1px 6px" }} disabled={i === arr.length - 1} onClick={() => { const full = sectionOrder.filter((s) => s !== "market"); const a = full.indexOf(sec); const b = full.indexOf(arr[i + 1]); [full[a], full[b]] = [full[b], full[a]]; setSectionOrder(full); }}>▼</button>
                        </div>
                      ))}
                    </div>
                  </>}
                  <div style={{ maxHeight: 280, overflowY: "auto" }}>
                    {orderedSections.filter(sectionVisible).map((sec) => {
                      const colsInSec = COL_DEFS.filter((c) => c.section === sec);
                      if (colsInSec.length === 0) return null;
                      return (
                      <div key={sec} style={{ marginBottom: 6 }}>
                        <div className="disp" style={{ fontSize: 9.5, letterSpacing: ".08em", color: "var(--gold)", margin: "6px 0 3px", textTransform: "uppercase" }}>{SECTION_LABELS[sec]}{sec === "market" && <span className="mut" style={{ fontSize: 9 }}> · pinned left</span>}</div>
                        {colsInSec.map((c) => {
                          const avail = colAvailable(c);
                          const why = !avail ? (c.needsRanks ? "Set personal rankings for this format to unlock" : c.needsPlatform ? "Connect a platform to unlock" : c.needsMocks ? "Run mocks for this league to unlock" : "Unavailable") : "";
                          return (
                          <label key={c.key} title={avail ? (c.tip || c.label) : why} style={{ display: "flex", alignItems: "center", gap: 7, padding: "3px 0", fontSize: 12.5, cursor: (c.key === "adp" || !avail) ? "default" : "pointer", opacity: !avail ? 0.4 : (c.key === "adp" ? 0.7 : 1) }}>
                            <input type="checkbox" checked={!!cols[c.key] && avail} disabled={c.key === "adp" || !avail} onChange={() => setCols((s) => ({ ...s, [c.key]: !s[c.key] }))} />
                            <span style={{ flex: 1 }}>{c.label}{!avail && <i className="ti ti-lock" style={{ fontSize: 10, marginLeft: 5, color: "var(--mut)" }} aria-hidden="true" />}</span>
                            {c.tip && avail && <i className="ti ti-info-circle" title={c.tip} style={{ fontSize: 12, color: "var(--mut)" }} aria-hidden="true" />}
                          </label>
                          );
                        })}
                      </div>
                      );
                    })}
                  </div>
                  <div style={{ display: "flex", gap: 4, marginTop: 8 }}>
                    <button className="btn btn-mini" style={{ flex: 1 }} onClick={() => { setCols({ ...DEFAULT_COLS }); setSectionOrder(["market", "mine", "value", "demo", "avail", "stat"]); }}>Reset this view</button>
                    <button className="btn btn-mini" onClick={() => setColMenu(false)}>Done</button>
                  </div>
                </div>
              )}
            </div>
            <div style={{ maxHeight: 540, overflow: "auto" }}>
              <table className="board">
                <thead><tr>
                  <th className="frz" onClick={() => setSort("name")} style={{ minWidth: 188 }}>Player{arrow("name")}</th>
                  {activeCols.map((c) => (
                    <th key={c.key} className="num" onClick={() => c.sortable && setSort(c.sortKey || c.key)} title={c.tip || ""} style={sectionStart[c.key] ? { borderLeft: "2px solid var(--line)" } : undefined}>
                      {c.key === "edge" || c.key === "vbd" ? (
                        <span className="info" onMouseEnter={(e) => showTip(e, c.key === "edge" ? [
                          { t: "Value edge", x: "This platform's ADP minus the field consensus. Positive (green) = your platform drafts him later than everyone else, so you can wait or grab a discount." },
                          { t: "Negative (red)", x: "Your platform over-drafts him vs. the field — don't pay the local premium." },
                        ] : [
                          { t: "VBD — value based drafting", x: "Projected points above a replacement-level starter at the position." },
                          { t: "Why it matters", x: "Makes positions comparable: a +60 RB beats a +40 WR even if the WR scores more raw points." },
                        ])} onMouseLeave={hideTip}>{c.label}</span>
                      ) : c.label}{arrow(c.sortKey || c.key)}
                    </th>
                  ))}
                </tr></thead>
                <tbody>
                  {rows.map((p) => {
                    const gone = draftedSet.has(p.id);
                    const injInfo = injuryView(p);
                    return (
                      <tr key={p.id} className={gone ? "struck" : ""}>
                        <td className="frz" style={{ borderLeft: `3px solid ${gone ? "transparent" : (POS_COLOR[p.pos] || "transparent")}` }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                            {!gone
                              ? <button className={`btn btn-mini${onClock === userIdx ? " btn-gold" : ""}`} style={{ flexShrink: 0, border: onClock === userIdx ? "none" : "1.5px solid #fff", fontWeight: 700 }} onClick={() => draftPlayer(p.id)}>{onClock === userIdx ? "Draft" : "Pick"}</button>
                              : <span style={{ width: 38, flexShrink: 0 }} />}
                            <span onMouseEnter={(e) => showTip(e, makeOutlook(p, sims, gone))} onMouseLeave={hideTip} style={{ cursor: "help", whiteSpace: "nowrap" }}>
                              <PosName p={p} /> <span className="mut">{p.team}</span>
                            </span>
                            {injInfo && <span onMouseEnter={(e) => showTip(e, [{ t: `Injury — ${injInfo.label}${injInfo.back ? ` · ${injInfo.back}` : ""}`, x: injInfo.note }])} onMouseLeave={hideTip}
                              style={{ flexShrink: 0, height: 14, borderRadius: 3, background: injInfo.color, color: "#fff", fontSize: 8.5, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "help", padding: "0 4px", letterSpacing: ".02em" }} title="">{injInfo.abbr}</span>}
                            {p.rookie && <span style={{ flexShrink: 0, fontSize: 9, color: "var(--gold)", border: "1px solid var(--gold)", borderRadius: 3, padding: "0 3px" }}>R</span>}
                            {!gone && (() => { const tag = insightTag(p); return tag ? <span style={{ flexShrink: 0, fontSize: 8.5, fontWeight: 700, letterSpacing: ".02em", color: tag.color, border: `1px solid ${tag.color}66`, borderRadius: 4, padding: "0 4px", whiteSpace: "nowrap" }}>{tag.label}</span> : null; })()}
                          </div>
                        </td>
                        {activeCols.map((c) => <td key={c.key} className="num" style={sectionStart[c.key] ? { borderLeft: "2px solid var(--line)" } : undefined}>{cellFor(p, c.key, gone)}</td>)}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="rail" style={{ width: 348, flexShrink: 0, display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="panel" style={{ padding: 12 }}>
              <div className="disp" style={{ fontSize: 14, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--mut)" }}>Recommendation {onClock === userIdx && <span className="gold">— you're up</span>}</div>
              {advice?.verdict ? (
                <>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8, margin: "7px 0 2px" }}>
                    <div className="disp" style={{ fontSize: 24, fontWeight: 700, color: "var(--gold)" }}>{advice.verdict.name}</div>
                    <div className="mut"><Dot pos={advice.verdict.pos} />{advice.verdict.pos}{advice.verdict.posRank}</div>
                  </div>
                  <div className="mut" style={{ fontSize: 12.5 }}>
                    +{advice.verdict.vbd.toFixed(0)} VBD • waiting costs {Math.max(0, advice.waitCost[advice.verdict.pos]).toFixed(0)} pts
                    {advice.impacts[advice.verdict.id] && <> • projects you <b style={{ color: "var(--ink)" }}>{ordinal(advice.impacts[advice.verdict.id].rank)}</b> ({advice.impacts[advice.verdict.id].pts} pts)</>}
                  </div>
                  <button className="btn btn-gold" style={{ width: "100%", marginTop: 9 }} onClick={() => draftPlayer(advice.verdict.id)}>
                    Draft {advice.verdict.name.split(" ").slice(-1)}{onClock !== userIdx ? ` (to ${TEAM_NAMES[onClock].split(" ")[0]})` : ""}
                  </button>
                  <div className="mut" style={{ fontSize: 11.5, margin: "10px 0 4px", textTransform: "uppercase", letterSpacing: ".07em" }}>Alternatives</div>
                  {advice.alts.map((a) => (
                    <div key={a.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6, padding: "3px 0", borderBottom: "1px solid #16203340", fontSize: 12.5 }}>
                      <span onMouseEnter={(e) => showTip(e, makeOutlook(a, sims, false))} onMouseLeave={hideTip} style={{ cursor: "help", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><Dot pos={a.pos} />{a.name}</span>
                      <span style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
                        <span className="mut num">{sims ? `${sims.pct[0][a.id]}%` : ""}{advice.impacts[a.id] ? ` • ${ordinal(advice.impacts[a.id].rank)}` : ""}</span>
                        <button className="btn btn-mini" onClick={() => draftPlayer(a.id)}>Draft</button>
                      </span>
                    </div>
                  ))}
                  <div className="mut" style={{ fontSize: 11.5, margin: "10px 0 4px", textTransform: "uppercase", letterSpacing: ".07em" }}>
                    <span className="info" onMouseEnter={(e) => showTip(e, [
                      { t: "Take now vs. wait", x: "For each position: the best player on the board RIGHT NOW versus the best the simulations expect to survive to YOUR NEXT PICK." },
                      { t: "Reading it", x: "\u201C+72 \u2192 ~+58 (\u221214)\u201D means waiting costs 14 points of value. \u201CSafe to wait\u201D means the pool holds its value until your turn — spend this pick elsewhere." },
                    ])} onMouseLeave={hideTip}>Take now vs. wait ⓘ</span>
                  </div>
                  {POS.map((pos) => advice.bestNow[pos] && (
                    <div key={pos} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, padding: "2.5px 0" }}>
                      <span><Dot pos={pos} />{advice.bestNow[pos].name}</span>
                      <span className="num" style={{ color: advice.waitCost[pos] > 14 ? "var(--red)" : advice.waitCost[pos] < 4 ? "var(--green)" : "var(--ink)" }}>
                        {advice.waitCost[pos] >= 4 ? `+${advice.bestNow[pos].vbd.toFixed(0)} → ~+${(advice.bestNow[pos].vbd - advice.waitCost[pos]).toFixed(0)} (−${advice.waitCost[pos].toFixed(0)})` : "✓ safe to wait"}
                      </span>
                    </div>
                  ))}
                </>
              ) : <div className="mut" style={{ padding: "8px 0" }}>Computing…</div>}
            </div>

            {advice?.run && <div className="alert"><b>{advice.run.pos} run underway</b> — {advice.run.count} of the last 8 picks. Waiting costs at {advice.run.pos} are climbing.</div>}

            <div className="panel" style={{ padding: 12 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
                <select className="gs" style={{ flex: 1 }} value={teamView} onChange={(e) => setTeamView(+e.target.value)}>
                  <option value={-1}>Your team</option>
                  {TEAM_NAMES.map((n, i) => i !== userIdx ? <option key={i} value={i}>{n}</option> : null)}
                </select>
                <button className="btn" onClick={() => setRailProj((t) => !t)}>{railProj ? "Projected" : "Current"}</button>
              </div>
              {proj && (() => {
                const ti = teamView === -1 ? userIdx : teamView;
                const current = picks.map((pk, o) => ({ p: players[pk], o })).filter((x) => teamAt(x.o) === ti).map((x) => x.p);
                const roster = railProj ? proj.rosters[ti] : current;
                const { slots, bench } = lineupSlots(roster, cfg.sf);
                const curSet = new Set(current.map((p) => p.id));
                return (
                  <>
                    <div className="mut" style={{ fontSize: 12, marginBottom: 6 }}>
                      {railProj ? "Projected final" : "Drafted so far"} • <b style={{ color: "var(--ink)" }}>{lineupPts(roster, cfg.sf)} pts</b>
                      {railProj && <> • projected <b style={{ color: "var(--gold)" }}>{ordinal(proj.rank[ti])}</b></>}
                    </div>
                    {slots.map((s, i) => (
                      <div key={i} style={{ fontSize: 12.5, padding: "2.5px 0" }}>
                        <span className="slotlbl">{s.slot}</span>
                        {s.p ? <span style={{ opacity: railProj && !curSet.has(s.p.id) ? 0.5 : 1, color: railProj && !curSet.has(s.p.id) ? "var(--gold)" : "var(--ink)" }}><Dot pos={s.p.pos} />{s.p.name}{railProj && !curSet.has(s.p.id) && <span className="mut"> (proj)</span>}</span> : <span className="mut">—</span>}
                      </div>
                    ))}
                    {bench.length > 0 && <div className="mut" style={{ fontSize: 11.5, marginTop: 6 }}>Bench: {bench.map((b) => b.name).join(", ")}</div>}
                  </>
                );
              })()}
            </div>

            <div className="panel" style={{ padding: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <div className="disp" style={{ fontSize: 14, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--mut)" }}>
                  <span className="info" onMouseEnter={(e) => showTip(e, needMode === "strength" ? [
                    { t: "League needs — strength", x: "Each cell scores a team's position by QUALITY × QUANTITY, not just headcount." },
                    { t: "Colors", x: "Green = strong (enough starters AND real talent). Amber = middle of the pack. Red = weak — thin or below-replacement." },
                    { t: "Tip", x: "This is the version to scout with: a team with two replacement-level RBs still shows amber/red, because bodies aren't the same as quality." },
                  ] : [
                    { t: "League needs — filled", x: "Pure roster-fill status, ignoring quality." },
                    { t: "Colors", x: "Green = starting slots at this position filled. Amber = not filled but not yet urgent. Red = unfilled and critical (running out of picks)." },
                  ])} onMouseLeave={hideTip}>League needs ⓘ</span>
                </div>
                <div style={{ display: "flex", gap: 3 }}>
                  <button className="btn btn-mini" style={{ borderColor: needMode === "strength" ? "var(--gold)" : "var(--line)" }} onClick={() => setNeedMode("strength")}>Strength</button>
                  <button className="btn btn-mini" style={{ borderColor: needMode === "filled" ? "var(--gold)" : "var(--line)" }} onClick={() => setNeedMode("filled")}>Filled</button>
                </div>
              </div>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead><tr>
                  <th style={{ textAlign: "left", color: "var(--mut)", fontWeight: 500, paddingBottom: 4 }}>Team</th>
                  {POS.map((pos) => <th key={pos} style={{ color: POS_COLOR[pos], fontWeight: 600, width: 38, paddingBottom: 4 }}>{pos}</th>)}
                </tr></thead>
                <tbody>
                  {TEAM_NAMES.map((n, i) => {
                    const counts = { QB: 0, RB: 0, WR: 0, TE: 0 };
                    const best = { QB: null, RB: null, WR: null, TE: null };
                    const drafted = picks.filter((pk, o) => teamAt(o) === i).length;
                    picks.forEach((pk, o) => { if (teamAt(o) === i) { const p = players[pk]; if (counts[p.pos] != null) { counts[p.pos]++; if (best[p.pos] == null || p.vbd > best[p.pos]) best[p.pos] = p.vbd; } } });
                    const remaining = ROUNDS - drafted;
                    return (
                      <tr key={i}>
                        <td style={{ padding: "2px 4px 2px 0", color: i === userIdx ? "var(--gold)" : "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 110 }}>{i === userIdx ? (n || "Your team") : n}</td>
                        {POS.map((pos) => {
                          let lvl, tip;
                          if (needMode === "strength") {
                            // League-RELATIVE strength (same as the Teams tab): top third green, middle
                            // amber, bottom third red — so the hub and Teams tab always agree.
                            lvl = posRel[i] ? posRel[i][pos] : 1;
                            tip = lvl === 0 ? `${pos}: top third of the league` : lvl === 1 ? `${pos}: middle of the league` : `${pos}: bottom third of the league`;
                          } else {
                            const req = REQ_F(cfg.sf)[pos] || 0;
                            const short = req - counts[pos];
                            if (short <= 0) { lvl = 0; tip = "Starting slots filled"; }
                            else if (short <= remaining - 1 && remaining > short + 1) { lvl = 1; tip = `${short} short — time remaining`; }
                            else { lvl = 2; tip = `${short} short — running out of picks`; }
                          }
                          const bg = lvl === 0 ? "rgba(124,217,178,0.18)" : lvl === 1 ? "rgba(242,182,60,0.18)" : "rgba(242,101,92,0.22)";
                          const col = lvl === 0 ? "var(--green)" : lvl === 1 ? "var(--gold)" : "var(--red)";
                          return <td key={pos} style={{ padding: 2 }}><div className="needcell num" title={tip} style={{ background: bg, color: col }}>{counts[pos]}</div></td>;
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="mut" style={{ fontSize: 10.5, marginTop: 6 }}>{needMode === "strength" ? "Color = quality × quantity. A full but weak position still shows amber/red." : "Color = whether starting slots are filled, regardless of quality."}</div>
            </div>
          </div>
        </div>
        </>
      )}

      {tab === "board" && (
        <div style={{ padding: 14 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
            <div style={{ display: "inline-flex", border: "1px solid var(--line)", borderRadius: 9, overflow: "hidden" }}>
              <button className="btn" style={{ border: "none", borderRadius: 0, background: !boardProj ? "rgba(242,182,60,.14)" : "transparent", color: !boardProj ? "var(--gold)" : "var(--mut)" }} onClick={() => setBoardProj(false)}>Current</button>
              <button className="btn" style={{ border: "none", borderRadius: 0, background: boardProj ? "rgba(242,182,60,.14)" : "transparent", color: boardProj ? "var(--gold)" : "var(--mut)" }} onClick={() => setBoardProj(true)}>Projected</button>
            </div>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, cursor: "pointer", color: showBoardVal ? "var(--ink)" : "var(--mut)" }}>
              <input type="checkbox" checked={showBoardVal} onChange={(e) => setShowBoardVal(e.target.checked)} style={{ accentColor: "var(--gold)", cursor: "pointer" }} />
              Show pick value
            </label>
            <button className="btn btn-mini" onClick={() => setTradeModalOpen(true)} title="Record a draft-pick trade — the board updates instantly to show picks in their new owners' columns." style={{ borderColor: (cfg.pickTrades || []).length ? "var(--gold)" : "var(--line)", color: (cfg.pickTrades || []).length ? "var(--gold)" : "var(--ink)" }}><i className="ti ti-arrows-exchange" style={{ fontSize: 13, marginRight: 3 }} aria-hidden="true" /> Trade picks{(cfg.pickTrades || []).length ? ` (${(cfg.pickTrades || []).length})` : ""}</button>
            <span className="mut" style={{ fontSize: 11.5, marginLeft: "auto", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span><span style={{ display: "inline-block", width: 9, height: 9, borderRadius: 2, background: "var(--gold)", marginRight: 4, verticalAlign: "middle" }} />Your picks</span>
              <span><i className="ti ti-arrows-exchange" style={{ fontSize: 11, color: "#4FD1A1", marginRight: 2 }} aria-hidden="true" />Traded</span>
              {boardProj && <span><span className="gold">italic</span> = projected</span>}
            </span>
          </div>
          <div className="boardwrap">
            {/* sticky team-name header */}
            <div className="bhead" style={{ gridTemplateColumns: `40px repeat(${TEAMS}, minmax(92px,1fr))`, minWidth: 60 + TEAMS * 96 }}>
              <div className="bteam" style={{ background: "transparent", border: "none" }} />
              {TEAM_NAMES.map((n, i) => (
                <div key={i} className={`bteam${i === userIdx ? " you" : ""}`} title={n}>
                  <div className="nm" style={{ color: i === userIdx ? "var(--gold)" : "var(--ink)" }}>{i === userIdx ? (TEAM_NAMES[i] || "Your team") : n}</div>
                  <div className="sub mut">{i === userIdx ? "you" : `slot ${i + 1}`}</div>
                </div>
              ))}
            </div>
            {/* body grid: a round-number gutter + one cell per team */}
            <div className="bgrid" style={{ gridTemplateColumns: `40px repeat(${TEAMS}, minmax(92px,1fr))`, minWidth: 60 + TEAMS * 96 }}>
              {Array.from({ length: ROUNDS }, (_, r) => (
                <React.Fragment key={r}>
                  <div className="mut num" style={{ display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700 }}>R{r + 1}</div>
                  {Array.from({ length: TEAMS }, (_, col) => {
                    // This column is draft SLOT `col`. Find the overall pick that physically happens at
                    // this slot in this round (its NATURAL owner is this slot), so the grid lays out
                    // like a real draft board — including snake / 3RR. Traded picks stay in the slot
                    // where they physically occur, but are highlighted by who actually OWNS them now.
                    let o = -1;
                    for (let i = 0; i < TEAMS; i++) { const oo = r * TEAMS + i; if (naturalOwner(oo) === col) { o = oo; break; } }
                    if (o < 0) o = r * TEAMS + col;
                    const owner = teamAt(o);              // who owns this pick now (after trades)
                    const traded = owner !== naturalOwner(o); // pick changed hands
                    const ownedByYou = owner === userIdx;  // you own it (natural OR traded-for)
                    const realPk = picks[o];
                    const keeperHere = realPk == null && keeperByPick[o] != null;
                    const isKeeper = (realPk != null && keeperByPick[o] === realPk) || keeperHere;
                    const isProjected = realPk == null && !keeperHere && projBoard && projBoard[o] != null;
                    const pk = realPk != null ? realPk : keeperHere ? keeperByPick[o] : (isProjected ? projBoard[o] : null);
                    const p = pk != null ? players[pk] : null;
                    const v = p && !isProjected && !isKeeper ? pickValue(p, o, cfg) : 0;
                    const isUpcoming = realPk == null && !isKeeper && myUpcoming.has(o);
                    const isOnClock = o === picks.length && !done;
                    // Highlight a cell as "yours" whenever you own that pick — natural or traded-for.
                    const cls = `bcell${ownedByYou ? " you" : ""}${ownedByYou && isOnClock ? " oncl" : ""}${isUpcoming ? " upcoming" : ""}${!p ? " empty" : ""}`;
                    return (
                      <div key={`${r}-${col}`} className={cls}
                        style={{ borderLeft: p ? `3px solid ${POS_COLOR[p.pos]}` : undefined, opacity: p ? (isProjected ? 0.9 : 1) : undefined }}
                        onMouseEnter={p ? (e) => showTip(e, isKeeper ? [
                          { t: "Keeper", x: `${pickLabel(o)} — ${teamAt(o) === userIdx ? "You" : TEAM_NAMES[teamAt(o)]}` },
                          { t: "Kept", x: `${p.name} (${p.pos}${p.posRank}) — kept at this pick, locked to this slot.` },
                        ] : isProjected ? [
                          { t: "Projected pick", x: `${pickLabel(o)} — ${teamAt(o) === userIdx ? "You" : TEAM_NAMES[teamAt(o)]}` },
                          ...(traded ? [{ t: "Traded pick", x: `Originally ${TEAM_NAMES[naturalOwner(o)]}'s pick, now owned by ${teamAt(o) === userIdx ? "you" : TEAM_NAMES[teamAt(o)]}.` }] : []),
                          { t: "Most likely", x: `${p.name} (${p.pos}${p.posRank}, Tier ${p.tier}) — the engine's current projection for this slot.` },
                          { t: "Note", x: "Projection only — updates every time a real pick is made." },
                        ] : [
                          ...boardPickOutlook(
                            p, o, cfg,
                            teamAt(o) === userIdx ? "You" : TEAM_NAMES[teamAt(o)],
                            picks.slice(0, o).map((pk2, o2) => (pk2 != null && teamAt(o2) === teamAt(o)) ? players[pk2] : null).filter(Boolean),
                            REQ_F(isSuperflex(cfg))
                          ),
                          ...(traded ? [{ t: "Traded pick", x: `Originally ${TEAM_NAMES[naturalOwner(o)]}'s pick, now owned by ${teamAt(o) === userIdx ? "you" : TEAM_NAMES[teamAt(o)]}.` }] : []),
                        ]) : undefined}
                        onMouseLeave={hideTip}>
                        <div className="lbl mut">
                          <span className="num">{pickLabel(o)}</span>
                          {isKeeper && <span className="gold" style={{ fontWeight: 800 }}>K</span>}
                          {traded && <i className="ti ti-arrows-exchange" style={{ fontSize: 9, color: ownedByYou ? "var(--gold)" : "#4FD1A1" }} title={`Traded pick — now ${ownedByYou ? "yours" : TEAM_NAMES[owner]}`} aria-hidden="true" />}
                        </div>
                        {/* When a pick was traded, name who owns it now (esp. your acquired picks). */}
                        {traded && <div style={{ fontSize: 8.5, letterSpacing: ".04em", textTransform: "uppercase", color: ownedByYou ? "var(--gold)" : "var(--mut)", marginTop: -1, fontWeight: 700 }}>{ownedByYou ? "YOUR PICK" : `→ ${TEAM_NAMES[owner].split(" ")[0]}`}</div>}
                        {p ? (
                          <>
                            <div className="pl" style={{ color: isKeeper ? "var(--green)" : isProjected ? "var(--gold)" : "var(--ink)", fontStyle: isProjected ? "italic" : "normal" }}>
                              <span className="posdot" style={{ background: POS_COLOR[p.pos] }}>{p.pos}</span> {p.name}
                            </div>
                            {showBoardVal && !isProjected && !isKeeper && Math.abs(v) > 0 && (
                              <div className="val num" style={{ color: v > 0 ? "var(--green)" : "var(--red)" }}>{v > 0 ? `+${v}` : v}</div>
                            )}
                          </>
                        ) : isUpcoming ? (
                          <div className="pl gold" style={{ fontStyle: "italic", opacity: .85 }}>Your pick →</div>
                        ) : (
                          <div className="pl mut">—</div>
                        )}
                      </div>
                    );
                  })}
                </React.Fragment>
              ))}
            </div>
          </div>
        </div>
      )}

      {tab === "teams" && proj && (
        <div style={{ padding: 14 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
            <button className="btn" style={{ borderColor: !teamsProj ? "var(--gold)" : "var(--line)" }} onClick={() => setTeamsProj(false)}>Current (drafted only)</button>
            <button className="btn" style={{ borderColor: teamsProj ? "var(--gold)" : "var(--line)" }} onClick={() => setTeamsProj(true)}>Projected final</button>
            {teamsProj && <span className="mut" style={{ fontSize: 12 }}>Gold dimmed players = projected by the engine, not yet drafted</span>}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(258px,1fr))", gap: 12 }}>
            {TEAM_NAMES.map((n, i) => {
              const current = picks.map((pk, o) => ({ p: players[pk], o })).filter((x) => x.p && teamAt(x.o) === i).map((x) => x.p);
              const roster = teamsProj ? proj.rosters[i] : current;
              const curSet = new Set(current.map((p) => p.id));
              const counts = { QB: 0, RB: 0, WR: 0, TE: 0 };
              const best = { QB: null, RB: null, WR: null, TE: null };
              current.forEach((p) => { if (counts[p.pos] != null) { counts[p.pos]++; if (best[p.pos] == null || p.vbd > best[p.pos]) best[p.pos] = p.vbd; } });
              const teamRemaining = ROUNDS - current.length;
              return (
                <div key={i} className="panel" style={{ padding: 12, borderColor: i === userIdx ? "var(--gold)" : "var(--line)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <div className="disp" style={{ fontSize: 16, fontWeight: 700, color: i === userIdx ? "var(--gold)" : "var(--ink)" }}>{i === userIdx ? (n || "Your team") : n}{i === userIdx && <span className="mut" style={{ fontSize: 10, fontWeight: 600, marginLeft: 6, letterSpacing: ".06em" }}>YOU</span>}</div>
                    <div className="num"><b>{lineupPts(roster, cfg.sf)}</b> <span className="mut">pts{teamsProj && ` • ${ordinal(proj.rank[i])}`}</span></div>
                  </div>
                  <div style={{ display: "flex", gap: 6, margin: "7px 0", flexWrap: "wrap" }}>
                    {POS.map((pos) => {
                      const lvl = posRel[i] ? posRel[i][pos] : 1; // league-relative tercile
                      const col = lvl === 0 ? "var(--green)" : lvl === 1 ? "var(--gold)" : "var(--red)";
                      const bdr = lvl === 0 ? "#2E5C49" : lvl === 1 ? "#5C4A1E" : "#5C2624";
                      const bg = lvl === 0 ? "rgba(124,217,178,0.12)" : lvl === 1 ? "rgba(242,182,60,0.12)" : "rgba(242,101,92,0.14)";
                      const tip = lvl === 0 ? `${pos}: top third of the league here` : lvl === 1 ? `${pos}: middle of the league here` : `${pos}: bottom third of the league here`;
                      return <span key={pos} className="chip" title={tip} style={{ borderColor: bdr, color: col, background: bg, fontWeight: 600 }}>{pos} {counts[pos]}</span>;
                    })}
                  </div>
                  {lineupSlots(roster, cfg.sf).slots.map((s, j) => {
                    const isP = s.p && teamsProj && !curSet.has(s.p.id);
                    return (
                      <div key={j} style={{ fontSize: 12, padding: "2px 0" }}>
                        <span className="slotlbl">{s.slot}</span>
                        {s.p ? <span style={{ opacity: isP ? 0.55 : 1, color: isP ? "var(--gold)" : "var(--ink)" }}><Dot pos={s.p.pos} />{s.p.name}{isP && <span className="mut"> (proj)</span>}</span> : <span className="mut">—</span>}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {tab === "avail" && (
        <div style={{ padding: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
            <div>
              <div className="disp" style={{ fontSize: 19, fontWeight: 700 }}>Availability odds</div>
              <div className="mut" style={{ fontSize: 12 }}>Chance each player survives to your upcoming picks — from live simulations.</div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginLeft: "auto", flexWrap: "wrap" }}>
              <div className="chip" style={{ display: "flex", alignItems: "center" }}>
                Check pick #<input className="gs" style={{ width: 58, padding: "3px 6px", marginLeft: 6 }} type="number" min={picks.length + 1} placeholder="30" value={customPick} onChange={(e) => setCustomPick(e.target.value.replace(/\D/g, ""))} />
                {customPick && <button className="btn btn-mini" style={{ marginLeft: 6 }} onClick={() => setCustomPick("")}>clear</button>}
              </div>
              <div style={{ display: "inline-flex", border: "1px solid var(--line)", borderRadius: 8, overflow: "hidden" }} title="Market = how the league will draft (ADP). Your build = your demographic edge (value, dynasty youth tilt).">
                <span className="mut" style={{ fontSize: 11, alignSelf: "center", padding: "0 8px" }}>View</span>
                {[["adp", "Market"], ["vbd", "Your build"]].map(([k, lbl]) => (
                  <button key={k} className="btn btn-mini" style={{ borderRadius: 0, border: "none", minWidth: 76, textAlign: "center", background: availSort === k ? "var(--gold)" : "transparent", color: availSort === k ? "#1A1505" : "var(--ink)", fontWeight: availSort === k ? 700 : 400 }} onClick={() => setAvailSort(k)}>{lbl}</button>
                ))}
              </div>
            </div>
            <div className="mut" style={{ fontSize: 11.5, marginTop: -4, marginBottom: 6 }}>
              {availSort === "adp" ? "Market view — ordered by ADP, how your league is likely to draft these players." : myWindow.decided ? `Your-build view — value tilted to your ${myWindow.label.toLowerCase()} (avg age ~${myWindow.avgAge?.toFixed(1)}). Where you can out-draft the room for your window.` : "Your-build view — pure value for now. Once you commit to a window (~round 4), this tilts toward players that fit your build."}
            </div>
          </div>
          {(() => {
            const cols = sims ? sims.nexts.length : 0;
            const extra = customSims ? 1 : 0;
            const grid = `minmax(150px,1.6fr) 56px repeat(${cols + extra}, minmax(64px,1fr))`;
            const heatBar = (pct) => pct >= 70 ? "var(--green)" : pct >= 40 ? "var(--gold)" : "var(--red)";
            const rows = players.filter((p) => !draftedSet.has(p.id)).sort((a, b) => {
              if (availSort === "adp") return a.adp - b.adp;
              // Your-build view: VBD tilted by your contention window (once you've picked a lane).
              const va = (a.vbd ?? -50) * (myWindow.decided ? myWindow.tilt(a.pos, a.age) : 1);
              const vb = (b.vbd ?? -50) * (myWindow.decided ? myWindow.tilt(b.pos, b.age) : 1);
              return vb - va;
            }).slice(0, 30);
            return (
              <div style={{ maxWidth: 920 }}>
                <div className="availhead" style={{ gridTemplateColumns: grid }}>
                  <div>Best available</div>
                  <div style={{ textAlign: "center" }}>{availSort === "adp" ? "ADP" : "VBD"}</div>
                  {sims && sims.nexts.map((o, i) => <div key={i} style={{ textAlign: "center" }}>@ {pickLabel(o)}</div>)}
                  {customSims && <div style={{ textAlign: "center", color: "var(--gold)" }}>@ {pickLabel(+customPick - 1)}</div>}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {rows.map((p) => (
                    <div key={p.id} className="availrow" style={{ gridTemplateColumns: grid, borderLeft: `3px solid ${POS_COLOR[p.pos]}` }}
                      onMouseEnter={(e) => showTip(e, makeOutlook(p, sims, false))} onMouseLeave={hideTip}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                        <span className="posbadge" style={{ background: POS_COLOR[p.pos] }}>{p.pos}{p.posRank}</span>
                        <span style={{ minWidth: 0 }}><span className="pname" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", display: "block" }}>{p.name}</span><span className="mut" style={{ fontSize: 10.5 }}>{p.team} · Tier {p.tier}</span></span>
                      </div>
                      <div className="num" style={{ textAlign: "center", fontWeight: 700, color: "var(--mut)" }}>{availSort === "adp" ? p.adp.toFixed(0) : `+${p.vbd.toFixed(0)}`}</div>
                      {sims && sims.nexts.map((_, i) => { const pct = sims.pct[i][p.id]; return (
                        <div key={i} className="availpct"><span className="fill" style={{ width: `${pct}%`, background: heatBar(pct) }} /><span className="txt" style={{ color: pct >= 70 ? "var(--green)" : pct >= 40 ? "var(--gold)" : "var(--red)" }}>{pct}%</span></div>
                      ); })}
                      {customSims && (() => { const pct = customSims[p.id]; return (
                        <div className="availpct" style={{ borderColor: "rgba(242,182,60,.4)" }}><span className="fill" style={{ width: `${pct}%`, background: heatBar(pct) }} /><span className="txt" style={{ color: pct >= 70 ? "var(--green)" : pct >= 40 ? "var(--gold)" : "var(--red)" }}>{pct}%</span></div>
                      ); })()}
                    </div>
                  ))}
                </div>
                <div className="mut" style={{ fontSize: 11, marginTop: 10, display: "flex", gap: 14 }}>
                  <span><span style={{ display: "inline-block", width: 9, height: 9, borderRadius: 2, background: "var(--green)", marginRight: 4 }} />Likely there (≥70%)</span>
                  <span><span style={{ display: "inline-block", width: 9, height: 9, borderRadius: 2, background: "var(--gold)", marginRight: 4 }} />Coin-flip (40–70%)</span>
                  <span><span style={{ display: "inline-block", width: 9, height: 9, borderRadius: 2, background: "var(--red)", marginRight: 4 }} />Likely gone (&lt;40%)</span>
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {tab === "adp" && (
        <div style={{ padding: 14 }}>
          <div className="panel" style={{ padding: "9px 12px", marginBottom: 12, background: "var(--panel2)", display: "flex", alignItems: "center", gap: 8 }}>
            <i className="ti ti-chart-dots" style={{ fontSize: 16, color: "var(--gold)" }} aria-hidden="true" />
            <span style={{ fontSize: 12.5 }} className="mut">ADP for this league's format, built from thousands of real Sleeper drafts — consensus, how it's trending, spread, sample size, and your blended number.</span>
          </div>
          <AdpIntel players={players} cfg={cfg} myRanks={myRanks} draftedSet={draftedSet} />
        </div>
      )}

      {tab === "depth" && (
        <div style={{ padding: 14 }}>
          <div className="panel" style={{ padding: "9px 12px", marginBottom: 12, background: "var(--panel2)", display: "flex", alignItems: "center", gap: 8 }}>            <i className="ti ti-info-circle" style={{ fontSize: 14, color: "var(--gold)" }} aria-hidden="true" />
            <span className="mut" style={{ fontSize: 11.5, lineHeight: 1.45 }}>Depth charts are ordered by projected fantasy points from current Sleeper data. Players with no projected value and free agents are hidden. Updates daily.</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(225px,1fr))", gap: 10 }}>
          {depth.map(([team, arr]) => {
            const avail = arr.filter((p) => !draftedSet.has(p.id)).length;
            return (
              <div key={team} className="panel" style={{ padding: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                  <div className="disp" style={{ fontSize: 15, fontWeight: 700 }}>{team}</div>
                  <div className="mut" style={{ fontSize: 11 }}>{avail} available</div>
                </div>
                {arr.map((p) => (
                  <div key={p.id} className={draftedSet.has(p.id) ? "struck" : ""} style={{ fontSize: 12, padding: "1.5px 0" }}
                    onMouseEnter={(e) => showTip(e, makeOutlook(p, sims, draftedSet.has(p.id)))} onMouseLeave={hideTip}>
                    <Dot pos={p.pos} /><span className="mut" style={{ fontSize: 11 }}>{p.pos}</span> {p.name} <span className="mut num" style={{ fontSize: 11 }}>{p.pts}</span>
                  </div>
                ))}
              </div>
            );
          })}
          </div>
        </div>
      )}

      {tab === "summary" && proj && grades && (
        <div style={{ padding: 14, display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(310px,1fr))", gap: 12, maxWidth: 1250 }}>
          <div className="panel" style={{ padding: "10px 14px", gridColumn: "1 / -1", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span className="mut" style={{ fontSize: 12.5 }}>Focus on</span>
            <select className="gs" style={{ minWidth: 220 }} value={summaryTeam == null ? "" : String(summaryTeam)} onChange={(e) => setSummaryTeam(e.target.value === "" ? null : +e.target.value)}>
              <option value="">Your team + league-wide trends</option>
              {TEAM_NAMES.map((n, i) => <option key={i} value={i}>{i === userIdx ? "Your team" : n}</option>)}
            </select>
            <span className="mut" style={{ fontSize: 11.5 }}>{summaryTeam == null ? "Steals & reaches show the whole league; your roster is highlighted." : `Showing ${summaryTeam === userIdx ? "your" : TEAM_NAMES[summaryTeam] + "'s"} picks, steals & reaches.`}</span>
          </div>
          <div className="panel" style={{ padding: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
              <div className="disp" style={{ fontSize: 18, fontWeight: 700 }}>{done ? "Final grades" : "Live grades"} <span className="mut" style={{ fontSize: 12 }}>value drafted + projected finish</span></div>
              <div style={{ display: "inline-flex", border: "1px solid var(--line)", borderRadius: 8, overflow: "hidden" }}>
                <span className="mut" style={{ fontSize: 11, alignSelf: "center", padding: "0 8px" }}>Sort by</span>
                <button className="btn btn-mini" style={{ borderRadius: 0, border: "none", background: sumSort.key === "z" ? "var(--gold)" : "transparent", color: sumSort.key === "z" ? "#1A1505" : "var(--ink)", fontWeight: sumSort.key === "z" ? 700 : 400 }} onClick={() => setSumSort({ key: "z", dir: -1 })}>Grade</button>
                <button className="btn btn-mini" style={{ borderRadius: 0, border: "none", background: sumSort.key === "val" ? "var(--gold)" : "transparent", color: sumSort.key === "val" ? "#1A1505" : "var(--ink)", fontWeight: sumSort.key === "val" ? 700 : 400 }} onClick={() => setSumSort({ key: "val", dir: -1 })}>Value</button>
              </div>
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead><tr className="mut" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".06em", cursor: "pointer" }}>
                <th style={{ textAlign: "left", paddingBottom: 5 }}>Team</th>
                <th className="num" onClick={() => setSumSort((s) => ({ key: "val", dir: s.key === "val" ? -s.dir : -1 }))}>Value{sumSort.key === "val" ? (sumSort.dir < 0 ? " ▾" : " ▴") : ""}</th>
                <th className="num" onClick={() => setSumSort((s) => ({ key: "pts", dir: s.key === "pts" ? -s.dir : -1 }))}>Proj pts{sumSort.key === "pts" ? (sumSort.dir < 0 ? " ▾" : " ▴") : ""}</th>
                <th className="num" onClick={() => setSumSort((s) => ({ key: "rank", dir: s.key === "rank" ? -s.dir : 1 }))}>Proj{sumSort.key === "rank" ? (sumSort.dir < 0 ? " ▾" : " ▴") : ""}</th>
                <th onClick={() => setSumSort((s) => ({ key: "z", dir: s.key === "z" ? -s.dir : -1 }))}>Grade{sumSort.key === "z" ? (sumSort.dir < 0 ? " ▾" : " ▴") : ""}</th>
              </tr></thead>
              <tbody>
                {Array.from({ length: TEAMS }, (_, i) => i).sort((a, b) => {
                  const k = sumSort.key;
                  const va = k === "val" ? valByTeam[a] : k === "pts" ? proj.pts[a] : k === "rank" ? proj.rank[a] : grades[a].z;
                  const vb = k === "val" ? valByTeam[b] : k === "pts" ? proj.pts[b] : k === "rank" ? proj.rank[b] : grades[b].z;
                  return (va - vb) * sumSort.dir;
                }).map((i) => (
                  <tr key={i} style={{ color: i === userIdx ? "var(--gold)" : "var(--ink)" }}>
                    <td style={{ padding: "3px 0" }}>{i === userIdx ? `${TEAM_NAMES[i] || "Your team"}` : TEAM_NAMES[i]}{i === userIdx && <span className="mut" style={{ fontSize: 9, marginLeft: 5 }}>YOU</span>}</td>
                    <td className="num" style={{ textAlign: "right", background: valBg(valByTeam[i]) }}>{valByTeam[i] > 0 ? `+${valByTeam[i]}` : valByTeam[i]}</td>
                    <td className="num" style={{ textAlign: "right" }}>{proj.pts[i]}</td>
                    <td className="num" style={{ textAlign: "right" }}>{ordinal(proj.rank[i])}</td>
                    <td style={{ textAlign: "center", fontWeight: 700 }}>{grades[i].g}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="panel" style={{ padding: 14 }}>
            <div className="disp" style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Biggest steals <span className="mut" style={{ fontSize: 12 }}>{summaryTeam == null ? "(league-wide, curve-weighted)" : `(${summaryTeam === userIdx ? "your team" : TEAM_NAMES[summaryTeam]})`}</span></div>
            <SummaryTable rows={graded.filter((g) => summaryTeam == null || g.t === summaryTeam).slice().sort((a, b) => b.val - a.val).slice(0, 8).filter((g) => g.val > 0)} userIdx={summaryTeam == null ? userIdx : summaryTeam} />
            <div className="disp" style={{ fontSize: 18, fontWeight: 700, margin: "14px 0 8px" }}>Biggest reaches</div>
            <SummaryTable rows={graded.filter((g) => summaryTeam == null || g.t === summaryTeam).slice().sort((a, b) => a.val - b.val).slice(0, 8).filter((g) => g.val < 0)} userIdx={summaryTeam == null ? userIdx : summaryTeam} />
          </div>

          <div className="panel" style={{ padding: 14 }}>
            <div className="disp" style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>{summaryTeam == null || summaryTeam === userIdx ? "Your team" : `${TEAM_NAMES[summaryTeam]}`} <span className="mut" style={{ fontSize: 12 }}>{done ? "final" : "current + projected"}</span></div>
            {(() => {
              const ti = summaryTeam == null ? userIdx : summaryTeam;
              const teamCurrent = picks.map((pk, o) => ({ p: players[pk], o })).filter((x) => x.p && teamAt(x.o) === ti).map((x) => x.p);
              const curSet = new Set(teamCurrent.map((p) => p.id));
              const roster = done ? teamCurrent : proj.rosters[ti];
              const { slots, bench } = lineupSlots(roster, cfg.sf);
              return (
                <>
                  <div className="mut" style={{ fontSize: 12.5, marginBottom: 8 }}>Optimal lineup <b style={{ color: "var(--ink)" }}>{lineupPts(roster, cfg.sf)} pts</b> • projected <b style={{ color: "var(--gold)" }}>{ordinal(proj.rank[ti])}</b></div>
                  {slots.map((s, i) => (
                    <div key={i} style={{ fontSize: 12.5, padding: "2.5px 0", display: "flex", justifyContent: "space-between" }}>
                      <span><span className="slotlbl">{s.slot}</span>{s.p ? <span style={{ opacity: !done && !curSet.has(s.p.id) ? 0.55 : 1, color: !done && !curSet.has(s.p.id) ? "var(--gold)" : "var(--ink)" }}><Dot pos={s.p.pos} />{s.p.name}{!done && !curSet.has(s.p.id) && " (proj)"}</span> : <span className="mut">—</span>}</span>
                      {s.p && <span className="mut num">{s.p.pts}</span>}
                    </div>
                  ))}
                  {bench.length > 0 && <div className="mut" style={{ fontSize: 11.5, marginTop: 6 }}>Bench: {bench.map((b) => b.name).join(", ")}</div>}
                </>
              );
            })()}
          </div>

          {recap && recapHead && (
            <div className="panel" style={{ padding: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <div className="disp" style={{ fontSize: 18, fontWeight: 700 }}>League recap <span className="mut" style={{ fontSize: 12 }}>AI-style, shareable</span></div>
                <button className="btn btn-mini" onClick={() => {
                  const headTxt = [
                    `Projected Winner: ${recapHead.winner}`,
                    `Projected Loser: ${recapHead.loser}`,
                    `Biggest Steal: ${recapHead.steal}`,
                    `Biggest Reach: ${recapHead.reach}`,
                    `Best value draft: ${recapHead.bestDraft}`,
                    `Least value draft: ${recapHead.worstDraft}`,
                    `Your team trends: ${recapHead.trend}`,
                  ].join("\n");
                  const ok = copyText(`${cfg.name} — draft recap\n\n${headTxt}\n\n${recap.join("\n\n")}`);
                  if (ok !== false) { setCopied(true); setTimeout(() => setCopied(false), 1500); }
                }}>{copied ? "Copied ✓" : "Copy"}</button>
              </div>

              {/* constant headline stats */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: "8px 18px", padding: "10px 12px", background: "var(--panel2)", borderRadius: 8, marginBottom: 12 }}>
                {[
                  ["Projected Winner", recapHead.winner, "var(--green)"],
                  ["Projected Loser", recapHead.loser, "var(--red)"],
                  ["Biggest Steal", recapHead.steal, "var(--green)"],
                  ["Biggest Reach", recapHead.reach, "var(--red)"],
                  ["Best value draft", recapHead.bestDraft, "var(--ink)"],
                  ["Least value draft", recapHead.worstDraft, "var(--ink)"],
                ].map(([label, val, color]) => (
                  <div key={label}>
                    <div className="disp" style={{ fontSize: 11, letterSpacing: ".05em", textTransform: "uppercase", color: "var(--mut)" }}>{label}</div>
                    <div style={{ fontSize: 13, fontWeight: 700, color }}>{val}</div>
                  </div>
                ))}
                <div style={{ gridColumn: "1 / -1", borderTop: "1px solid var(--line)", paddingTop: 8 }}>
                  <div className="disp" style={{ fontSize: 11, letterSpacing: ".05em", textTransform: "uppercase", color: "var(--gold)" }}>Your team trends</div>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{recapHead.trend}</div>
                </div>
              </div>

              {/* funny AI-style prose */}
              {recap.map((s, i) => <p key={i} style={{ fontSize: 13.5, lineHeight: 1.55, margin: "0 0 9px" }}>{s}</p>)}
              <div className="mut" style={{ fontSize: 11.5, marginTop: 4 }}>The headline stats above always reflect the live draft; the commentary is template-generated in this demo. The full version writes the prose with AI over the same engine data — plus what-if rewind and shareable grade cards.</div>
            </div>
          )}
        </div>
      )}

      {tab === "trade" && (
        <TradeCenter players={players} picks={picks} userIdx={userIdx} cfg={cfg} sortedAdp={sortedAdp} draftedSet={draftedSet} showTip={showTip} hideTip={hideTip}
          isMock={isMock} tradingOn={mockTradingOn}
          onExecuteTrade={({ partner, givePlayers, getPlayers }) => {
            // Execute by swapping the contents of the involved board slots between the two teams.
            // Slot ownership is fixed by draft order, so swapping pick contents transfers the players.
            setPicks((prev) => {
              const next = prev.slice();
              const mySlots = givePlayers.map((pid) => prev.indexOf(pid)).filter((o) => o >= 0 && teamAt(o) === userIdx);
              const theirSlots = getPlayers.map((pid) => prev.indexOf(pid)).filter((o) => o >= 0 && teamAt(o) === partner);
              const n = Math.min(mySlots.length, theirSlots.length);
              for (let i = 0; i < n; i++) { const a = mySlots[i], b = theirSlots[i]; const tmp = next[a]; next[a] = next[b]; next[b] = tmp; }
              return next;
            });
          }} />
      )}

      {tab === "settings" && (
        <div style={{ maxWidth: 640, margin: "0 auto", padding: "20px 16px" }}>
          <div className="mut" style={{ fontSize: 12.5, marginBottom: 12 }}>
            Edit any league setting — roster, scoring, draft order, keepers, pick trades, caps, teams. Use the tabs below. Saving recomputes projections and re-grades the board against your picks so far. {hasSlot ? "" : "You haven't set your draft slot yet — set it on the Draft order tab."}
          </div>
          <ConfigForm initial={{ ...cfg, slot: cfg.slot == null ? "" : cfg.slot, scoring: { ...DEFAULT_SCORING, ...(cfg.scoring || {}) } }} submitLabel="Save settings" onSubmit={(newCfg) => { onSettings(newCfg); setTab("hub"); }} onCancel={() => setTab("hub")} />
        </div>
      )}

      {ranksWarn && (() => {
        const lgId = league.mockOf != null ? league.mockOf : league.id;
        const relCfg = { ...cfg, __leagueId: lgId };
        const sets = (user?.rankSets || [])
          .map((set) => ({ set, rel: rankRelevance(set, relCfg) }))
          .filter((x) => x.rel != null)
          .sort((a, b) => (b.rel.score - a.rel.score) || ((b.set.editedTs || 0) - (a.set.editedTs || 0)) || String(b.set.created).localeCompare(String(a.set.created)));
        const active = pickRankSet(user, cfg, lgId);
        return (
        <div className="modalbg" onClick={() => setRanksWarn(false)}>
          <div className="panel" style={{ maxWidth: 520, width: "100%", padding: 22, borderColor: "var(--gold)", maxHeight: "85vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
            <div className="disp" style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>Your rankings for this draft</div>
            <div className="mut" style={{ fontSize: 12.5, lineHeight: 1.5, marginBottom: 14 }}>Pick a saved board to use here, or build a new one. We show every <b style={{ color: "var(--ink)" }}>{typeFamily(cfg.type) === "dynasty" ? "dynasty/keeper" : typeFamily(cfg.type) === "bestball" ? "best ball" : "redraft"}</b> board you've made and flag any that don't perfectly match this league's format.</div>

            {sets.length > 0 ? (
              <div style={{ marginBottom: 16 }}>
                {sets.map(({ set, rel }) => {
                  const isActive = active && active.id === set.id;
                  return (
                    <div key={set.id} title={`Format: ${rankSetLabel(setSettingsKey(set))}${set.leagueId != null ? " · attached to a league" : ""}`}
                      style={{ border: `1px solid ${isActive ? "var(--gold)" : "var(--line)"}`, borderRadius: 9, padding: "10px 12px", marginBottom: 8, background: isActive ? "#16140c" : "transparent" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 700, fontSize: 13.5 }}>{set.name} {rel.exact ? <span className="chip" style={{ marginLeft: 4, borderColor: "var(--green)", color: "var(--green)", fontSize: 9 }}>EXACT MATCH</span> : null}{isActive ? <span className="chip" style={{ marginLeft: 4, borderColor: "var(--gold)", color: "var(--gold)", fontSize: 9 }}>IN USE</span> : null}</div>
                          <div className="mut" style={{ fontSize: 11 }}>{rankSetLabel(setSettingsKey(set))} · {(set.list || []).length} ranked · edited {set.edited || set.created || "—"}</div>
                        </div>
                        <button className="btn btn-mini btn-gold" disabled={isActive} onClick={() => { onUseRankSet && onUseRankSet(set.id, lgId); setRanksWarn(false); }}>{isActive ? "Using" : "Use"}</button>
                      </div>
                      {/* relevance bar */}
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 7 }}>
                        <div style={{ flex: 1, height: 6, borderRadius: 3, background: "#23231C", overflow: "hidden" }}>
                          <div style={{ height: "100%", width: `${rel.score}%`, borderRadius: 3, background: rel.score >= 90 ? "var(--green)" : rel.score >= 55 ? "var(--gold)" : "var(--red)" }} />
                        </div>
                        <span className="mut num" style={{ fontSize: 10.5, width: 64, textAlign: "right" }}>{rel.score}% match</span>
                      </div>
                      {rel.flags.length > 0 && <div className="mut" style={{ fontSize: 10.5, marginTop: 5, color: "var(--gold)" }}>⚑ {rel.flags.join(" · ")}</div>}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="panel" style={{ padding: 14, marginBottom: 16, background: "var(--panel2)", textAlign: "center" }}>
                <div className="mut" style={{ fontSize: 12.5 }}>You haven't built any {typeFamily(cfg.type) === "dynasty" ? "dynasty/keeper" : typeFamily(cfg.type) === "bestball" ? "best ball" : "redraft"} rankings yet. Create one and it'll show as a “My ADP” + “Blend” column here.</div>
              </div>
            )}

            <div style={{ borderTop: "1px solid var(--line)", paddingTop: 14 }}>
              <div className="mut" style={{ fontSize: 12, marginBottom: 10, lineHeight: 1.5 }}>Want to build or edit a board instead? That happens in the Rankings hub — we'll {isMock ? "save this mock" : "save your draft"} and bring you right back.</div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn btn-gold" onClick={() => { setRanksWarn(false); onSave(picks, preds); onEditRanks && onEditRanks(); }}>Build / edit in Rankings hub →</button>
                <div style={{ flex: 1 }} />
                <button className="btn" onClick={() => setRanksWarn(false)}>Stay in the draft</button>
              </div>
            </div>
          </div>
        </div>
        );
      })()}

      {endConfirm && (
        <div className="modalbg" onClick={() => setEndConfirm(false)}>
          <div className="panel" style={{ maxWidth: 440, width: "100%", padding: 22, borderColor: "var(--gold)" }} onClick={(e) => e.stopPropagation()}>
            <div className="disp" style={{ fontSize: 20, fontWeight: 700, marginBottom: 6 }}>End the draft here?</div>
            <div className="mut" style={{ fontSize: 13, lineHeight: 1.55, marginBottom: 16 }}>You've made {picks.length} of {TOTAL} picks. We'll stop the draft and take you to the summary — grades, steals, reaches, and projected standings for everything drafted so far. {isMock ? "This mock stays saved in the league's history." : "You can keep reviewing the board afterward."}</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn-gold" onClick={() => { setEndConfirm(false); setPaused(true); onSave(picks, preds); setTab("summary"); }}>End & view summary</button>
              <div style={{ flex: 1 }} />
              <button className="btn" onClick={() => setEndConfirm(false)}>Keep drafting</button>
            </div>
          </div>
        </div>
      )}

      {tradeModalOpen && (() => {
        return <TradePickModal
          teams={TEAMS} rounds={ROUNDS} teamNames={TEAM_NAMES} userIdx={userIdx}
          ownerOf={(o) => teamAt(o)} naturalOwnerOf={(o) => naturalOwner(o)} pickLabelOf={(o) => pickLabel(o)}
          existingTrades={cfg.pickTrades || []}
          onClose={() => setTradeModalOpen(false)}
          onApply={(newTrades) => { onSettings({ ...cfg, pickTrading: true, pickTrades: newTrades }); setTradeModalOpen(false); }}
        />;
      })()}

      {briefOpen && briefing && (
        <div className="modalbg" onClick={() => setBriefOpen(false)}>
          <div className="panel" style={{ maxWidth: 480, width: "100%", padding: 20 }} onClick={(e) => e.stopPropagation()}>
            <div className="disp" style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>AI briefing <span className="mut" style={{ fontSize: 13, fontWeight: 400 }}>— your pick {sims && pickLabel(sims.nexts[0])}</span></div>
            <div className="mut" style={{ fontSize: 12, marginBottom: 12 }}>What we foresee, for your consideration — not a guarantee.</div>
            {briefing.map((s, i) => (
              <div key={i} style={{ marginBottom: 12 }}>
                <div className="disp" style={{ fontSize: 13, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--gold)", marginBottom: 3 }}>{s.h}</div>
                <div style={{ fontSize: 13.5, lineHeight: 1.5 }}>{s.strong && <b>{s.strong}. </b>}{s.body}</div>
              </div>
            ))}
            <button className="btn" style={{ width: "100%" }} onClick={() => setBriefOpen(false)}>Close</button>
          </div>
        </div>
      )}

      {gated && (
        <div className="modalbg">
          <div className="panel" style={{ maxWidth: 460, width: "100%", padding: 26, borderColor: "var(--gold)", textAlign: "center" }}>
            <div style={{ display: "flex", justifyContent: "center", marginBottom: 8 }}><Compass size={38} /></div>
            <div className="disp" style={{ fontSize: 24, fontWeight: 700 }}>{isDemo ? "End of the free demo" : "Enjoying the demo?"}</div>
            <div className="mut" style={{ fontSize: 13.5, margin: "10px 0 16px", lineHeight: 1.55 }}>
              {isDemo
                ? `The free demo covers the first ${cfg.demoRounds || 3} rounds on the real engine — live projections, availability odds, and steal/reach value, exactly what you'd get on draft night. Unlock the season pass to finish this draft and get unlimited leagues, mock drafts, your own rankings, trade tools, depth charts, and every other feature.`
                : "You've drafted five rounds on the real engine — the projected path, live availability odds, and waiting-cost math are all exactly what you'd get on draft night. The season pass opens the full draft plus unlimited leagues, mock drafts, your own rankings, trade tools, and everything else."}
            </div>
            <button className="btn btn-gold" style={{ width: "100%", padding: 12, fontSize: 15, marginBottom: 8 }} onClick={onBuy}>Get the Season Pass</button>
            <button className="btn" style={{ width: "100%" }} onClick={onExit}>Back to the Homepage</button>
            <div className="mut" style={{ fontSize: 11, marginTop: 10 }}>No card was needed for the demo, and nothing's been charged.</div>
          </div>
        </div>
      )}

      {tip && (
        <div className="tooltip" style={{ left: tip.x, top: tip.y }}>
          <OutlookCard content={tip.content} />
        </div>
      )}
    </div>
  );
}

function SummaryTable({ rows, userIdx }) {
  if (!rows.length) return <div className="mut" style={{ fontSize: 12.5 }}>Nothing notable yet — the board is behaving.</div>;
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
      <thead><tr className="mut" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".06em" }}>
        <th style={{ textAlign: "left", paddingBottom: 4 }}>Player</th><th className="num">Pick</th><th style={{ textAlign: "left", paddingLeft: 8 }}>By</th><th className="num">ADP</th><th className="num">Value</th>
      </tr></thead>
      <tbody>
        {rows.map((g) => {
          return (
          <tr key={g.o}>
            <td style={{ padding: "3px 6px 3px 0" }}><span className="posdot" style={{ background: POS_COLOR[g.p.pos] }} /><b>{g.p.name}</b></td>
            <td className="num" style={{ textAlign: "right" }}>{overallPick(g.o)}<span className="mut" style={{ fontSize: 10.5, marginLeft: 4 }}>({pickLabel(g.o)})</span></td>
            <td style={{ color: g.t === userIdx ? "var(--gold)" : "var(--ink)", paddingLeft: 8 }}>{g.t === userIdx ? "You" : TEAM_NAMES[g.t].split(" ")[0]}</td>
            <td className="num" style={{ textAlign: "right" }}>{g.p.adp.toFixed(1)}</td>
            <td className="num" style={{ textAlign: "right", background: valBg(g.val) }}>{g.val > 0 ? `+${g.val}` : g.val}</td>
          </tr>
        );})}
      </tbody>
    </table>
  );
}

// ---- Trade value layer ----------------------------------------------------------------
// VALUE-SOURCE ABSTRACTION. In this prototype, trade values are COMPUTED by our own engine
// from each player's projection/VBD, adjusted for the league FORMAT (1QB vs Superflex,
// TE-premium, redraft vs dynasty) — so the same player is worth different amounts in
// different leagues, exactly the way live charts (FantasyCalc, FantasyPros, DraftSharks)
// split their values. In production this single function is swapped to read a nightly
// consensus blend from those sources keyed by the same format signature; nothing else in
// the trade UI changes. `formatKey(cfg)` is the cache key that the live feed would use.
function formatKey(cfg) {
  const qb = (cfg.start && cfg.start.SUPER > 0) || cfg.sf ? "SF" : "1QB";
  const te = cfg.tePremMult > 0 ? `TEP${cfg.tePremMult}` : "TEstd";
  const mode = cfg.type === "dynasty" || cfg.type === "keeper" ? "DYN" : cfg.type === "bestball" ? "BB" : "RE";
  return `${mode}-${qb}-${te}`;
}
// Friendly label for a ranking-set key.
function rankSetLabel(key) {
  const [mode, qb, te] = key.split("-");
  const m = mode === "DYN" ? "Dynasty" : mode === "BB" ? "Best ball" : "Redraft";
  const q = qb === "SF" ? "Superflex" : qb === "2QB" ? "2QB" : "1QB";
  return `${m} · ${q} · ${te === "TEstd" ? "standard TE" : "TE premium"}`;
}
// Resolve a player's personal rank for a league. Returns a map playerId -> {rank, exact}.
// Ranked players keep their personal order; everyone the user didn't rank (incl. K/DST)
// is dropped into their consensus (ADP) spot so the board stays complete and ordered.
// Global player adjustments keyed by player NAME so one edit ripples across every ranking
// set and the consensus board. kind: 'remove' | 'down-spots'(n) | 'down-pct'(n) | 'model'(rationale).
// Returns { removed: bool, shift: number-of-spots-down } for a given player + board size.
const MODEL_SHIFTS = {
  "season-ending": { removed: true },
  "significant": { pct: 0.45 },
  "minor": { pct: 0.08 },
  "suspension": { pct: 0.30 },
  "playing-time": { pct: 0.18 },
  "lost-job": { pct: 0.55 },
};
function adjForPlayer(adj, name, baseRank, boardSize) {
  const a = adj && adj[name];
  if (!a) return { removed: false, shift: 0 };
  if (a.kind === "remove") return { removed: true, shift: 0 };
  if (a.kind === "down-spots") return { removed: false, shift: Math.max(0, +a.n || 0) };
  if (a.kind === "down-pct") return { removed: false, shift: Math.round(boardSize * Math.max(0, Math.min(100, +a.n || 0)) / 100) };
  if (a.kind === "model") { const m = MODEL_SHIFTS[a.rationale] || {}; if (m.removed) return { removed: true, shift: 0 }; return { removed: false, shift: Math.round(boardSize * (m.pct || 0.1)) }; }
  return { removed: false, shift: 0 };
}

// Find the best ranking set for a league: prefer one explicitly attached to this league,
// else the active-season set whose settings (type+format) match the league's format key.
function pickRankSet(user, cfg, leagueId) {
  const sets = (user && user.rankSets) || [];
  if (!sets.length) return null;
  const season = (user && user.season) || CURRENT_SEASON;
  const key = formatKey(cfg);
  if (leagueId != null) { const attached = sets.find((s) => s.leagueId === leagueId); if (attached) return attached; }
  // match by settings within the active season, else any season with matching settings
  const inSeason = sets.filter((s) => (s.season || CURRENT_SEASON) === season);
  return inSeason.find((s) => setSettingsKey(s) === key) || sets.find((s) => setSettingsKey(s) === key) || null;
}

function resolveMyRanks(players, cfg, user, rankAdj, leagueId) {
  const key = formatKey(cfg);
  const set = pickRankSet(user, cfg, leagueId);
  const list = set && set.list && set.list.length ? set.list : null;
  const hasAdj = rankAdj && Object.keys(rankAdj).length > 0;
  if ((!list || !list.length) && !hasAdj) return { map: {}, key, has: false, setName: null };
  const byAdp = players.slice().sort((a, b) => a.adp - b.adp);
  const boardSize = players.length;
  // start from the user's order if present, else consensus order
  let ordered;
  if (list && list.length) {
    const rankedSet = new Set(list);
    const ranked = list.map((pid) => players.find((p) => p.id === pid)).filter(Boolean);
    const unranked = byAdp.filter((p) => !rankedSet.has(p.id));
    const slots = new Array(boardSize + ranked.length + 1).fill(null);
    const rankOf = {}; list.forEach((pid, i) => (rankOf[pid] = i + 1));
    ranked.forEach((p) => { const r = rankOf[p.id]; if (slots[r] == null) slots[r] = p; else { let k = r; while (slots[k] != null) k++; slots[k] = p; } });
    let u = 0; for (let i = 1; i < slots.length && u < unranked.length; i++) if (slots[i] == null) slots[i] = unranked[u++];
    ordered = slots.filter(Boolean);
  } else {
    ordered = byAdp.slice();
  }
  const exactSet = new Set(list || []);
  // Apply global adjustments: remove flagged players, then shift the rest down by their spots.
  let working = ordered.filter((p) => !adjForPlayer(rankAdj, p.name, 0, boardSize).removed);
  if (hasAdj) {
    const withShift = working.map((p, i) => ({ p, base: i, shift: adjForPlayer(rankAdj, p.name, i, working.length).shift }));
    // new index = base + shift, then re-sort stably
    withShift.sort((a, b) => (a.base + a.shift) - (b.base + b.shift) || a.base - b.base);
    working = withShift.map((x) => x.p);
  }
  const map = {};
  // Blended ADP: weight your personal rank heavily but temper it with public consensus ADP,
  // so you're not 100% captive to your own board. 65% you / 35% market.
  const W_ME = 0.65;
  working.forEach((p, i) => {
    const myPos = i + 1;
    const cons = p.consensus != null ? p.consensus : p.adp;
    const blend = +(W_ME * myPos + (1 - W_ME) * cons).toFixed(1);
    map[p.id] = { rank: myPos, blend, exact: exactSet.has(p.id), adjusted: !!(rankAdj && rankAdj[p.name]) };
  });
  return { map, key, has: true, setName: set ? set.name : null };
}
function tradeValue(p, cfg) {
  if (!p) return 0;
  cfg = cfg || {};
  const sf = (cfg.start && cfg.start.SUPER > 0) || cfg.sf;
  const dynasty = cfg.type === "dynasty" || cfg.type === "keeper";
  let base = Math.max(0, p.vbd) * 0.9 + Math.max(0, p.pts) * 0.12;
  // positional scarcity (RB/TE harder to replace)
  let mult = p.pos === "RB" ? 1.08 : p.pos === "TE" ? 1.05 : 1.0;
  // FORMAT: superflex hugely inflates QB value; mild lift to elite QBs even in 1QB dynasty
  if (p.pos === "QB") {
    if (sf) mult *= 1.85;            // QBs become premium assets in superflex
    else mult *= dynasty ? 0.72 : 0.6; // streamable in 1QB redraft, a bit more durable in dynasty
  }
  // FORMAT: TE premium lifts every TE's tradeable value
  if (p.pos === "TE" && cfg.tePremMult > 0) mult *= 1 + 0.18 * cfg.tePremMult;
  // FORMAT: dynasty weights youth and long-term outlook; redraft is win-now
  if (dynasty) {
    const age = p.age || 26;
    const youth = age <= 23 ? 1.22 : age <= 25 ? 1.12 : age <= 27 ? 1.0 : age <= 29 ? 0.86 : 0.7;
    base *= youth;
    if (p.rookie) base *= 1.1; // rookie premium in dynasty startups/rookie markets
  }
  return Math.round(base * mult);
}
function ord(n) { return n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`; }
// Draft-pick asset values (round-based; next-year rookie picks discounted for uncertainty).
function pickAssets(cfg) {
  if (!cfg.pickTrading) return [];
  const rounds = Math.min(cfg.rounds, 6);
  const out = [];
  const val = (rd, yr) => Math.round(Math.max(6, 150 / Math.pow(rd, 1.15)) * (yr === "next" ? 0.62 : 1));
  for (let rd = 1; rd <= rounds; rd++) out.push({ pickAsset: true, id: `pk-${rd}`, name: `${ord(rd)}-round pick`, pos: "PICK", value: val(rd, "this") });
  for (let rd = 1; rd <= 3; rd++) out.push({ pickAsset: true, id: `pk-next-${rd}`, name: `${ord(rd)} rookie pick (next yr)`, pos: "PICK", value: val(rd, "next") });
  return out;
}
const assetVal = (a, cfg) => (a ? (a.pickAsset ? a.value : tradeValue(a, cfg)) : 0);
// Bulk / consolidation adjustment so a 5-for-1 is NOT "even": the headliner asset on each
// side carries a scarcity premium, and extra bodies are discounted (only so many starting
// slots; depth is worth less than its raw sum).
function evaluateTrade(giveAssets, getAssets, cfg) {
  const rawGive = giveAssets.reduce((s, a) => s + assetVal(a, cfg), 0);
  const rawGet = getAssets.reduce((s, a) => s + assetVal(a, cfg), 0);
  const bestGive = giveAssets.length ? Math.max(...giveAssets.map((a) => assetVal(a, cfg))) : 0;
  const bestGet = getAssets.length ? Math.max(...getAssets.map((a) => assetVal(a, cfg))) : 0;
  const adj = (assets, raw, best) => {
    const extras = Math.max(0, assets.length - 1);
    const premium = best * 0.18;
    const clutter = (raw - best) * 0.12 * Math.min(1, extras / 2);
    return Math.round(raw + premium - clutter);
  };
  const giveAdj = adj(giveAssets, rawGive, bestGive);
  const getAdj = adj(getAssets, rawGet, bestGet);
  return { rawGive, rawGet, giveAdj, getAdj, net: getAdj - giveAdj, bestGive, bestGet };
}
// Standalone trade tools (toolkit entry) — value chart + evaluator that work off a chosen
// format, no live draft needed. Uses the same tradeValue/evaluateTrade engine as the in-draft
// Trade Center so values are identical to what you'd see inside a league.
// ---- ADP intelligence (prototype) --------------------------------------------------------
// All ADP comes from ONE reliable source: thousands of real Sleeper drafts, harvested and
// tagged by format. We don't scrape third-party sites (those break); Sleeper's API is free,
// official, and stable. The "breakdown" below is that single harvest sliced by draft segment
// (recent vs season-long, and by exact format) — useful context, all from the same source.
// Numbers here are a deterministic sample; production reads the live harvest via /api/adp.
const ADP_SEGMENTS = [
  { id: "recent", name: "Last 7 days", type: "Recent Sleeper drafts", weight: 0.5, note: "Freshest read on where he's going now" },
  { id: "season", name: "Season to date", type: "All Sleeper drafts, this format", weight: 0.35 },
  { id: "early", name: "Early-season drafts", type: "Older Sleeper drafts", weight: 0.15 },
];
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; } return h; }
function adpSources(p, cfg) {
  const base = p.adp;
  const today = new Date();
  // a believable sample size: more drafts for earlier/popular players, fewer for deep ones
  const totalDrafts = Math.max(40, Math.round(2600 - base * 7 + (hashStr("n" + p.id) % 300)));
  let rows = ADP_SEGMENTS.map((seg) => {
    const seed = hashStr(seg.id + "|" + p.id);
    const r1 = ((seed >>> 3) % 1000) / 1000;
    // recent segment hugs the consensus; older segments drift a bit (that drift IS the trend)
    const spread = (seg.id === "recent" ? 1.1 : seg.id === "season" ? 1.8 : 2.6) + base * 0.05;
    const bias = (r1 - 0.5) * 2 * spread;
    const ageDays = seg.id === "recent" ? 1 : seg.id === "season" ? 6 : 20;
    const d = new Date(today.getTime() - ageDays * 864e5);
    const n = Math.max(8, Math.round(totalDrafts * seg.weight));
    return { ...seg, rawVal: base + bias, ageDays, n, date: d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) };
  });
  // Re-center so the weighted mean lands EXACTLY on the canonical ADP (p.adp) shown everywhere else.
  let wsum = 0, vsum = 0;
  rows.forEach((r) => { wsum += r.weight; vsum += r.weight * r.rawVal; });
  const offset = base - (wsum ? vsum / wsum : base);
  rows = rows.map((r) => ({ ...r, val: Math.max(1, +(r.rawVal + offset).toFixed(1)) }));
  const consensus = +base.toFixed(1);
  const vals = rows.map((r) => r.val);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  // trend = recent minus older segment (negative = rising / going earlier)
  const recent = rows.find((r) => r.id === "recent").val;
  const early = rows.find((r) => r.id === "early").val;
  const trend = +(recent - early).toFixed(1);
  return { rows, consensus, lo, hi, trend, totalDrafts, liveN: rows.length, staleN: 0 };
}

// The ADP intelligence view — consensus, per-source breakdown (date/type/weight), spread, trend,
// and your blended number. Used as a toolkit page and as a draft-room tab.
function AdpIntel({ players, cfg, myRanks, compact, draftedSet }) {
  const pool = useMemo(() => players.filter((p) => POS.includes(p.pos) || (idpOn(cfg) && IDP_POS.includes(p.pos))).slice().sort((a, b) => a.adp - b.adp), [players, cfg]);
  const [q, setQ] = useState("");
  const [showDrafted, setShowDrafted] = useState(false); // default: only available
  const hasDrafted = !!(draftedSet && draftedSet.size);
  const [selId, setSelId] = useState(pool[0] ? pool[0].id : null);
  // Filter list by search + (optionally) hide drafted players. The "best available" view is the default.
  const visible = pool.filter((p) => (showDrafted || !draftedSet || !draftedSet.has(p.id)));
  const filtered = q.trim() ? visible.filter((p) => p.name.toLowerCase().includes(q.toLowerCase())).slice(0, 60) : visible.slice(0, 60);
  const sel = pool.find((p) => p.id === selId) || pool[0] || null;
  const data = useMemo(() => (sel ? adpSources(sel, cfg) : null), [sel, cfg]);
  const myAdp = sel && myRanks && myRanks.map && myRanks.map[sel.id] != null ? myRanks.map[sel.id] : null;
  const blend = sel && myAdp != null ? +((data.consensus * 0.65 + myAdp * 0.35)).toFixed(1) : null;

  if (!sel) return <div className="mut" style={{ fontSize: 13 }}>No players to analyze.</div>;
  const maxBar = Math.max(data.hi, data.consensus, myAdp || 0, blend || 0) * 1.05;
  const trendUp = data.trend < -0.3, trendDown = data.trend > 0.3;
  const trendColor = trendUp ? "var(--green)" : trendDown ? "var(--red)" : "var(--mut)";
  const trendLabel = trendUp ? `Rising ${Math.abs(data.trend)} (going earlier)` : trendDown ? `Falling ${Math.abs(data.trend)} (sliding later)` : "Flat";

  return (
    <div className="adp-grid" style={{ display: "grid", gridTemplateColumns: compact ? "1fr" : "240px 1fr", gap: 16, alignItems: "start" }}>
      {/* player list */}
      <div className="panel adp-list" style={{ padding: 10, maxHeight: compact ? 220 : 520, overflow: "auto" }}>
        <div style={{ position: "relative", marginBottom: 8 }}>
          <i className="ti ti-search" style={{ position: "absolute", left: 10, top: 9, fontSize: 13, color: "var(--mut)" }} aria-hidden="true" />
          <input className="gs" style={{ width: "100%", paddingLeft: 30, paddingTop: 7, paddingBottom: 7 }} placeholder="Search a player…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {hasDrafted && (
          <button className="btn btn-mini" style={{ width: "100%", marginBottom: 8, borderColor: showDrafted ? "var(--gold)" : "var(--line)", color: showDrafted ? "var(--gold)" : "var(--ink)" }} onClick={() => setShowDrafted((s) => !s)}>
            <i className={`ti ${showDrafted ? "ti-eye" : "ti-eye-off"}`} style={{ fontSize: 12, marginRight: 4 }} aria-hidden="true" />{showDrafted ? "Showing all players" : "Available only"}
          </button>
        )}
        {filtered.map((p) => { const gone = draftedSet && draftedSet.has(p.id); return (
          <div key={p.id} onClick={() => setSelId(p.id)} style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 7px", borderRadius: 6, cursor: "pointer", background: sel.id === p.id ? "rgba(214,170,75,0.12)" : "transparent", border: `1px solid ${sel.id === p.id ? "var(--gold)" : "transparent"}`, marginBottom: 2, opacity: gone ? 0.5 : 1 }}>
            <span className="posdot" style={{ background: POS_COLOR[p.pos] }} />
            <span style={{ flex: 1, fontSize: 12.5, fontWeight: sel.id === p.id ? 700 : 400, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", textDecoration: gone ? "line-through" : "none" }}>{p.name}</span>
            <span className="mut num" style={{ fontSize: 11 }}>{p.adp.toFixed(1)}</span>
          </div>
        ); })}
      </div>

      {/* detail */}
      <div>
        <div className="panel" style={{ padding: 16, marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              <div className="disp" style={{ fontSize: 20, fontWeight: 700, display: "flex", alignItems: "center", gap: 8 }}>
                <span className="posdot" style={{ background: POS_COLOR[sel.pos] }} />{sel.name}
                <span className="mut" style={{ fontSize: 13, fontWeight: 400 }}>{sel.pos}{sel.posRank} · {sel.team}</span>
              </div>
              <div className="mut" style={{ fontSize: 11.5, marginTop: 2 }}>ADP for <b style={{ color: "var(--ink)" }}>{rankSetLabel(formatKey(cfg))}</b> · from <b style={{ color: "var(--ink)" }}>{data.totalDrafts.toLocaleString()}</b> real Sleeper drafts</div>
            </div>
            <div style={{ textAlign: "center", padding: "4px 14px", borderRadius: 10, background: "var(--panel2)", border: "1px solid var(--gold)" }}>
              <div className="num disp" style={{ fontSize: 26, fontWeight: 700, color: "var(--gold)" }}>{data.consensus}</div>
              <div className="mut" style={{ fontSize: 9.5 }}>consensus ADP</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 16, marginTop: 12, flexWrap: "wrap", fontSize: 12 }}>
            <div><span className="mut">Range </span><b className="num">{data.lo}–{data.hi}</b></div>
            <div><span className="mut">Trend </span><b style={{ color: trendColor }}>{trendLabel}</b></div>
            {myAdp != null && <div><span className="mut">Your rank </span><b className="num" style={{ color: "#d6aa4b" }}>{myAdp.toFixed(1)}</b></div>}
            {blend != null && <div><span className="mut">Blend (65/35) </span><b className="num" style={{ color: "#d6aa4b" }}>{blend}</b></div>}
          </div>
        </div>

        {/* breakdown by draft recency — same Sleeper harvest, sliced by time window */}
        <div className="panel" style={{ padding: 0, overflow: "hidden", marginBottom: 12 }}>
          <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--line)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span className="disp" style={{ fontSize: 13, fontWeight: 700 }}>How it's trending</span>
            <span className="mut" style={{ fontSize: 11 }}>Sleeper drafts, by recency</span>
          </div>
          {data.rows.map((r) => (
            <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 14px", borderTop: "1px solid var(--line)" }}>
              <div style={{ width: 150, flexShrink: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600 }}>{r.name}</div>
                <div className="mut" style={{ fontSize: 10 }}>{r.type}</div>
              </div>
              <div style={{ flex: 1, height: 8, background: "#23231C", borderRadius: 4, position: "relative", overflow: "hidden" }}>
                <div style={{ position: "absolute", left: 0, top: 0, height: "100%", width: `${Math.min(100, (r.val / maxBar) * 100)}%`, background: POS_COLOR[sel.pos], borderRadius: 4 }} />
              </div>
              <div className="num" style={{ width: 42, textAlign: "right", fontSize: 12.5, fontWeight: 600 }}>{r.val}</div>
              <div className="mut num" style={{ width: 56, textAlign: "right", fontSize: 10.5 }} title="Drafts in this window">{r.n.toLocaleString()} drafts</div>
            </div>
          ))}
          {/* consensus marker row */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 14px", borderTop: "2px solid var(--gold)", background: "rgba(214,170,75,0.06)" }}>
            <div style={{ width: 150, flexShrink: 0, fontSize: 12.5, fontWeight: 700, color: "var(--gold)" }}>Consensus</div>
            <div style={{ flex: 1, height: 8, background: "#23231C", borderRadius: 4, position: "relative", overflow: "hidden" }}>
              <div style={{ position: "absolute", left: 0, top: 0, height: "100%", width: `${Math.min(100, (data.consensus / maxBar) * 100)}%`, background: "var(--gold)", borderRadius: 4 }} />
            </div>
            <div className="num" style={{ width: 42, textAlign: "right", fontSize: 12.5, fontWeight: 700, color: "var(--gold)" }}>{data.consensus}</div>
            <div style={{ width: 56 }} />
          </div>
        </div>

        <div className="mut" style={{ fontSize: 10.5, lineHeight: 1.5 }}>
          <i className="ti ti-info-circle" style={{ fontSize: 12, marginRight: 4 }} aria-hidden="true" />Prototype: values are a representative sample. In production this reads live, format-tagged ADP built from thousands of real Sleeper drafts — recent drafts weighted more, so the number always reflects how he's going right now. One reliable source, no fragile third-party feeds.
        </div>
      </div>
    </div>
  );
}

function AdpIntelPage({ user, onBack, onHome, onSignOut }) {
  const [qb, setQb] = useState("1QB"); const [te, setTe] = useState("std"); const [type, setType] = useState("redraft");
  const cfg = useMemo(() => ({ type, teams: 12, rounds: 15, sf: qb === "SF", tePremMult: te === "tep" ? 1 : 0, start: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, SUPER: qb === "SF" ? 1 : 0, DST: 0, K: 0 }, scoring: te === "tep" ? { recTE: 1.5, rec: 1.0 } : {} }), [qb, te, type]);
  const players = useMemo(() => { setTeams(12); setSpec(cfg.start); setOrder("snake"); setPickTrades(null); setKeeperAdds({}); return buildPlayers(cfg); }, [cfg]);
  return (
    <div>
      <AppHeader user={user} onSignOut={onSignOut} onHome={onHome} onApp={onBack} title="ADP Intelligence" />
      <div style={{ maxWidth: 940, margin: "0 auto", padding: "24px 20px 50px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 14, flexWrap: "wrap" }}>
          <div style={{ flexShrink: 0, width: 44, height: 44, borderRadius: 10, background: "#1A1505", border: "1px solid var(--gold)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <i className="ti ti-chart-dots" style={{ fontSize: 22, color: "var(--gold)" }} aria-hidden="true" />
          </div>
          <div style={{ flex: 1 }}>
            <div className="disp" style={{ fontSize: 26, fontWeight: 700 }}>ADP Intelligence</div>
            <div className="mut" style={{ fontSize: 13 }}>Every ADP consideration for a player: the consensus to follow, how it's trending across recent Sleeper drafts, the spread, sample size, and your blended number — all format-aware.</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center", padding: "12px 14px", borderRadius: 12, border: "1px solid var(--line)", background: "var(--panel)", marginBottom: 16 }}>
          <span className="mut" style={{ fontSize: 12, fontWeight: 600 }}>Format:</span>
          {[["qb", qb, setQb, [["1QB", "1QB"], ["SF", "SuperFlex"]]], ["te", te, setTe, [["std", "Standard TE"], ["tep", "TE premium"]]], ["type", type, setType, [["redraft", "Redraft"], ["dynasty", "Dynasty"]]]].map(([key, val, set, opts]) => (
            <div key={key} style={{ display: "flex", gap: 4 }}>
              {opts.map(([v, l]) => <button key={v} className="btn btn-mini" style={{ borderColor: val === v ? "var(--gold)" : "var(--line)", color: val === v ? "var(--gold)" : "var(--ink)" }} onClick={() => set(v)}>{l}</button>)}
            </div>
          ))}
        </div>
        <AdpIntel players={players} cfg={cfg} myRanks={null} />
      </div>
    </div>
  );
}

function TradeToolsPage({ user, onBack, onHome, onSignOut }) {
  const [qb, setQb] = useState("1QB"); // 1QB | SF
  const [te, setTe] = useState("std"); // std | tep
  const [type, setType] = useState("redraft"); // redraft | dynasty
  const [mode, setMode] = useState("chart"); // chart | evaluate
  const cfg = useMemo(() => ({
    type, teams: 12, rounds: 15,
    sf: qb === "SF", tePremMult: te === "tep" ? 1 : 0,
    start: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, SUPER: qb === "SF" ? 1 : 0, DST: 0, K: 0 },
    scoring: te === "tep" ? { recTE: 1.5, rec: 1.0 } : {},
  }), [qb, te, type]);
  const players = useMemo(() => buildPlayers(cfg).filter((p) => POS.includes(p.pos)), [cfg]);
  const ranked = useMemo(() => players.slice().sort((a, b) => tradeValue(b, cfg) - tradeValue(a, cfg)), [players, cfg]);
  const maxV = ranked.length ? tradeValue(ranked[0], cfg) : 1;
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState(false);

  // evaluator: pick players for each side from the pool
  const [give, setGive] = useState([]);
  const [get, setGet] = useState([]);
  const [sideSearch, setSideSearch] = useState("");
  const byId = useMemo(() => { const m = {}; players.forEach((p) => (m[p.id] = p)); return m; }, [players]);
  const giveAssets = give.map((id) => byId[id]).filter(Boolean);
  const getAssets = get.map((id) => byId[id]).filter(Boolean);
  const ev = evaluateTrade(giveAssets, getAssets, cfg);
  const partnerNet = ev.giveAdj - ev.getAdj;
  const accept = Math.max(2, Math.min(98, Math.round(50 + partnerNet * 1.3)));
  const addTo = (side, id) => side === "give" ? setGive((g) => g.includes(id) ? g : [...g, id]) : setGet((g) => g.includes(id) ? g : [...g, id]);
  const rmFrom = (side, id) => side === "give" ? setGive((g) => g.filter((x) => x !== id)) : setGet((g) => g.filter((x) => x !== id));

  const chartShown = ranked.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()));
  const chartList = expanded ? chartShown.slice(0, 80) : chartShown.slice(0, 24);
  const pickList = ranked.filter((p) => p.name.toLowerCase().includes(sideSearch.toLowerCase())).slice(0, 12);

  const verdict = !giveAssets.length || !getAssets.length ? null
    : accept >= 60 ? { t: "They'd likely accept", c: "var(--green)" }
    : accept >= 40 ? { t: "Roughly even — could go either way", c: "var(--gold)" }
    : { t: "They'd likely decline", c: "var(--red)" };

  return (
    <div>
      <AppHeader user={user} onSignOut={onSignOut} onHome={onHome} onApp={onBack} title="Trade Tools" />
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "24px 20px 50px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 14, flexWrap: "wrap" }}>
          <div style={{ flexShrink: 0, width: 44, height: 44, borderRadius: 10, background: "#1A1505", border: "1px solid var(--gold)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <i className="ti ti-arrows-exchange" style={{ fontSize: 22, color: "var(--gold)" }} aria-hidden="true" />
          </div>
          <div style={{ flex: 1 }}>
            <div className="disp" style={{ fontSize: 26, fontWeight: 700 }}>Trade Tools</div>
            <div className="mut" style={{ fontSize: 13 }}>Format-aware trade values and a quick evaluator. Set the format, then weigh any deal — the same engine your draft room uses.</div>
          </div>
        </div>

        {/* FORMAT PICKER — values are format-specific, so this drives everything below */}
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center", padding: "12px 14px", borderRadius: 12, border: "1px solid var(--line)", background: "var(--panel)", marginBottom: 16 }}>
          <span className="mut" style={{ fontSize: 12, fontWeight: 600 }}>Format:</span>
          {[["qb", qb, setQb, [["1QB", "1QB"], ["SF", "SuperFlex"]]], ["te", te, setTe, [["std", "Standard TE"], ["tep", "TE premium"]]], ["type", type, setType, [["redraft", "Redraft"], ["dynasty", "Dynasty"]]]].map(([key, val, set, opts]) => (
            <div key={key} style={{ display: "flex", gap: 4 }}>
              {opts.map(([v, l]) => (
                <button key={v} className="btn btn-mini" style={{ borderColor: val === v ? "var(--gold)" : "var(--line)", color: val === v ? "var(--gold)" : "var(--ink)" }} onClick={() => set(v)}>{l}</button>
              ))}
            </div>
          ))}
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
          {[["chart", "Trade value chart"], ["evaluate", "Evaluate a trade"]].map(([k, l]) => (
            <button key={k} className="btn" style={{ borderColor: mode === k ? "var(--gold)" : "var(--line)" }} onClick={() => setMode(k)}>{l}</button>
          ))}
        </div>

        {mode === "chart" && (
          <div className="panel" style={{ padding: 16 }}>
            <div className="mut" style={{ fontSize: 11.5, marginBottom: 12 }}>Values are set to this league's format: <b style={{ color: "var(--ink)" }}>{rankSetLabel(formatKey(cfg))}</b>. Higher bar = more trade value. QBs surge in SuperFlex; elite TEs rise with TE premium; dynasty weights youth.</div>
            <div style={{ position: "relative", marginBottom: 12 }}>
              <i className="ti ti-search" style={{ position: "absolute", left: 12, top: 10, fontSize: 14, color: "var(--mut)" }} aria-hidden="true" />
              <input className="gs" style={{ width: "100%", paddingLeft: 34, paddingTop: 9, paddingBottom: 9 }} placeholder="Search a player…" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            {chartList.map((p, i) => {
              const v = tradeValue(p, cfg);
              return (
                <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 9, padding: "4px 0" }}>
                  <span className="mut num" style={{ width: 22, fontSize: 11, textAlign: "right" }}>{i + 1}</span>
                  <span className="posdot" style={{ background: POS_COLOR[p.pos] }} />
                  <span style={{ width: 150, fontSize: 12.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name} <span className="mut" style={{ fontSize: 10 }}>{p.pos}</span></span>
                  <div style={{ flex: 1, height: 12, background: "#23231C", borderRadius: 6, overflow: "hidden" }}>
                    <div style={{ width: `${Math.max(3, (v / maxV) * 100)}%`, height: "100%", background: POS_COLOR[p.pos], borderRadius: 6 }} />
                  </div>
                  <span className="num" style={{ width: 38, textAlign: "right", fontSize: 12, fontWeight: 600 }}>{v}</span>
                </div>
              );
            })}
            {chartShown.length > 24 && <button className="btn btn-mini" style={{ marginTop: 10 }} onClick={() => setExpanded((v) => !v)}>{expanded ? "Show top 24" : `Show more (${Math.min(80, chartShown.length)})`}</button>}
          </div>
        )}

        {mode === "evaluate" && (
          <div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
              {[["give", "You give", giveAssets], ["get", "You get", getAssets]].map(([side, label, assets]) => (
                <div key={side} className="panel" style={{ padding: 12 }}>
                  <div className="disp" style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>{label}</div>
                  {assets.length === 0 && <div className="mut" style={{ fontSize: 11.5, marginBottom: 8 }}>Add players below.</div>}
                  {assets.map((a) => (
                    <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, padding: "3px 0" }}>
                      <span className="posdot" style={{ background: POS_COLOR[a.pos] }} />
                      <span style={{ flex: 1 }}>{a.name}</span>
                      <span className="mut num">{tradeValue(a, cfg)}</span>
                      <button className="btn btn-mini" onClick={() => rmFrom(side, a.id)} style={{ padding: "0 6px" }}>✕</button>
                    </div>
                  ))}
                </div>
              ))}
            </div>

            <div className="panel" style={{ padding: 12, marginBottom: 14 }}>
              <div style={{ position: "relative", marginBottom: 8 }}>
                <i className="ti ti-search" style={{ position: "absolute", left: 12, top: 10, fontSize: 14, color: "var(--mut)" }} aria-hidden="true" />
                <input className="gs" style={{ width: "100%", paddingLeft: 34, paddingTop: 9, paddingBottom: 9 }} placeholder="Search a player to add…" value={sideSearch} onChange={(e) => setSideSearch(e.target.value)} />
              </div>
              {sideSearch.trim() && pickList.map((p) => (
                <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, padding: "4px 0", borderTop: "1px solid var(--line)" }}>
                  <span className="posdot" style={{ background: POS_COLOR[p.pos] }} />
                  <span style={{ flex: 1 }}>{p.name} <span className="mut" style={{ fontSize: 10 }}>{p.pos}</span></span>
                  <span className="mut num">{tradeValue(p, cfg)}</span>
                  <button className="btn btn-mini" onClick={() => addTo("give", p.id)}>+ Give</button>
                  <button className="btn btn-mini" onClick={() => addTo("get", p.id)}>+ Get</button>
                </div>
              ))}
              {!sideSearch.trim() && <div className="mut" style={{ fontSize: 11.5 }}>Type a name, then add the player to either side.</div>}
            </div>

            {verdict && (
              <div className="panel" style={{ padding: 16, textAlign: "center", borderColor: verdict.c }}>
                <div style={{ display: "flex", justifyContent: "center", gap: 24, marginBottom: 10 }}>
                  <div><div className="num disp" style={{ fontSize: 22, fontWeight: 700 }}>{ev.giveAdj}</div><div className="mut" style={{ fontSize: 10 }}>value you give</div></div>
                  <div style={{ alignSelf: "center", fontSize: 18, color: "var(--mut)" }}>⇄</div>
                  <div><div className="num disp" style={{ fontSize: 22, fontWeight: 700 }}>{ev.getAdj}</div><div className="mut" style={{ fontSize: 10 }}>value you get</div></div>
                </div>
                <div className="disp" style={{ fontSize: 17, fontWeight: 700, color: verdict.c }}>{verdict.t}</div>
                <div className="mut" style={{ fontSize: 12, marginTop: 4 }}>Estimated acceptance: <b style={{ color: verdict.c }}>{accept}%</b> — based on the value swing in this format, with a small discount for trades that pile on extra bodies.</div>
              </div>
            )}
          </div>
        )}

        <div className="mut" style={{ fontSize: 11, marginTop: 16 }}>Values reflect the format above and the same scarcity/format logic used in your live draft room. Inside a league, the Trade Center adds your real roster, draft picks, and the trade finder.</div>
      </div>
    </div>
  );
}


function TradeCenter({ players, picks, userIdx, cfg, sortedAdp, draftedSet, showTip, hideTip, isMock, onExecuteTrade, tradingOn }) {
  const [mode, setMode] = useState("chart"); // chart | evaluate | finder
  const myRoster = picks.map((pk, o) => ({ p: players[pk], o })).filter((x) => teamAt(x.o) === userIdx).map((x) => x.p);
  const teamRosters = useMemo(() => {
    const r = Array.from({ length: TEAMS }, () => []);
    picks.forEach((pk, o) => r[teamAt(o)].push(players[pk]));
    return r;
  }, [picks, players]);
  const myPicks = useMemo(() => pickAssets(cfg), [cfg]);
  const partnerPicks = useMemo(() => pickAssets(cfg), [cfg]);
  const [partner, setPartner] = useState(userIdx === 0 ? 1 : 0);
  const [give, setGive] = useState([]);
  const [get, setGet] = useState([]);
  const [tradeResult, setTradeResult] = useState(null); // {ok, msg} after a mock proposal
  const toggle = (arr, set, id) => set(arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id]);

  const myAssets = [...myRoster, ...myPicks];
  const partnerAssets = [...teamRosters[partner], ...partnerPicks.map((p) => ({ ...p, id: `their-${p.id}` }))];
  const giveAssets = give.map((id) => myAssets.find((a) => String(a.id) === String(id))).filter(Boolean);
  const getAssets = get.map((id) => partnerAssets.find((a) => String(a.id) === String(id))).filter(Boolean);
  const ev = evaluateTrade(giveAssets, getAssets, cfg);
  const partnerNet = ev.giveAdj - ev.getAdj; // they win if your give is worth more to them
  const accept = Math.max(2, Math.min(98, Math.round(50 + partnerNet * 1.3)));

  const chartPlayers = useMemo(() => players.filter((p) => POS.includes(p.pos)).slice().sort((a, b) => tradeValue(b, cfg) - tradeValue(a, cfg)), [players, cfg]);
  const maxV = chartPlayers.length ? tradeValue(chartPlayers[0], cfg) : 1;
  const [chartSearch, setChartSearch] = useState("");
  const [chartExpanded, setChartExpanded] = useState(false);

  const [findMode, setFindMode] = useState("position");
  const [findPos, setFindPos] = useState("RB");
  const [findPlayerId, setFindPlayerId] = useState(null);
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
      {a.name} <span className="mut num" style={{ marginLeft: "auto" }}>{assetVal(a, cfg)}</span>
    </label>
  );

  return (
    <div style={{ padding: 14, maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        {[["chart","Trade value chart"],["evaluate","Evaluate a trade"],["finder","Trade finder"]].map(([k, l]) => (
          <button key={k} className="btn" style={{ borderColor: mode === k ? "var(--gold)" : "var(--line)" }} onClick={() => setMode(k)}>{l}</button>
        ))}
      </div>

      {mode === "chart" && (
        <div className="panel" style={{ padding: 16 }}>
          <div className="disp" style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Trade value chart</div>
          <div className="panel" style={{ padding: "8px 12px", marginBottom: 10, background: "var(--panel2)", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <i className="ti ti-adjustments" style={{ fontSize: 14, color: "var(--gold)" }} aria-hidden="true" />
            <span className="mut" style={{ fontSize: 11.5 }}>Values are set to this league's format:</span>
            <span style={{ fontSize: 11.5, fontWeight: 600 }}>{rankSetLabel(formatKey(cfg))}{((cfg.start && cfg.start.SUPER > 0) || cfg.sf) ? " · QBs premium" : ""}{(cfg.type === "dynasty" || cfg.type === "keeper") ? " · youth-weighted" : ""}</span>
          </div>
          <div className="mut" style={{ fontSize: 12.5, marginBottom: 14 }}>Values are specific to <i>this</i> league's format — Superflex inflates QBs, TE-premium lifts tight ends, dynasty weights youth — so the same player is worth different amounts in different leagues. In production these blend live consensus from FantasyCalc, FantasyPros, and DraftSharks for your exact format and refresh daily. Hover for the full outlook.</div>
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
                      onMouseEnter={(e) => showTip(e, makeOutlook(p, null, draftedSet.has(p.id)))} onMouseLeave={hideTip}>
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
                      onMouseEnter={(e) => showTip(e, makeOutlook(p, null, draftedSet.has(p.id)))} onMouseLeave={hideTip}>
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
              <span className="mut" style={{ fontSize: 12 }}>Trade with</span>
              <select className="gs" value={partner} onChange={(e) => { setPartner(+e.target.value); setGet([]); }}>
                {TEAM_NAMES.map((n, i) => i !== userIdx ? <option key={i} value={i}>{n}</option> : null)}
              </select>
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
                  <div className="disp gold" style={{ fontSize: 12, letterSpacing: ".06em", marginBottom: 6 }}>YOU GIVE</div>
                  {myRoster.map((p) => <AssetRow key={p.id} a={p} checked={give.includes(p.id)} onToggle={() => toggle(give, setGive, p.id)} />)}
                  {cfg.pickTrading && myPicks.map((a) => <AssetRow key={a.id} a={a} checked={give.includes(a.id)} onToggle={() => toggle(give, setGive, a.id)} />)}
                  {myRoster.length === 0 && !cfg.pickTrading && <div className="mut" style={{ fontSize: 12 }}>You haven't drafted yet.</div>}
                </div>
                <div>
                  <div className="disp gold" style={{ fontSize: 12, letterSpacing: ".06em", marginBottom: 6 }}>YOU GET</div>
                  {teamRosters[partner].length === 0 && !cfg.pickTrading ? <div className="mut" style={{ fontSize: 12 }}>This team hasn't drafted yet.</div> : <>
                    {teamRosters[partner].map((p) => <AssetRow key={p.id} a={p} checked={get.includes(p.id)} onToggle={() => toggle(get, setGet, p.id)} />)}
                    {cfg.pickTrading && partnerPicks.map((a) => { const id = `their-${a.id}`; return <AssetRow key={id} a={{ ...a, id }} checked={get.includes(id)} onToggle={() => toggle(get, setGet, id)} />; })}
                  </>}
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

      {mode === "finder" && (
        <div className="panel" style={{ padding: 16 }}>
          <div className="disp" style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Trade finder</div>
          <div className="mut" style={{ fontSize: 12.5, marginBottom: 12 }}>Find fair, mutually-beneficial deals — by a position you want to improve, or a specific player you're targeting. It respects your roster (it won't fetch a 2nd QB in a 1QB league) and deals from your surplus.</div>
          <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
            <button className="btn btn-mini" style={{ borderColor: findMode === "position" ? "var(--gold)" : "var(--line)" }} onClick={() => setFindMode("position")}>By position</button>
            <button className="btn btn-mini" style={{ borderColor: findMode === "player" ? "var(--gold)" : "var(--line)" }} onClick={() => setFindMode("player")}>By target player</button>
            {findMode === "position" ? (
              <select className="gs" value={findPos} onChange={(e) => setFindPos(e.target.value)}>{POS.map((p) => <option key={p} value={p}>{p}</option>)}</select>
            ) : (
              <select className="gs" value={findPlayerId == null ? "" : findPlayerId} onChange={(e) => setFindPlayerId(e.target.value ? +e.target.value : null)}>
                <option value="">Pick a target…</option>
                {players.filter((p) => draftedSet.has(p.id) && teamAt(picks.indexOf(p.id)) !== userIdx && POS.includes(p.pos))
                  .sort((a, b) => tradeValue(b, cfg) - tradeValue(a, cfg)).slice(0, 60)
                  .map((p) => <option key={p.id} value={p.id}>{p.name} ({p.pos})</option>)}
              </select>
            )}
          </div>
          {(() => {
            // Build my tradeable chips: surplus players + (if enabled) draft-pick assets.
            const surplusPos = POS.filter((p) => myCounts[p] > (req[p] || 0) + 1);
            const myPlayerChips = (surplusPos.length ? myRoster.filter((p) => surplusPos.includes(p.pos)) : myRoster).slice();
            const myChipPool = [...myPlayerChips, ...(cfg.pickTrading ? myPicks : [])];
            // Find the cheapest combo of my chips whose adjusted value lands within a fair band of `tv`.
            const matchChips = (tv) => {
              const pool = myChipPool.slice().sort((a, b) => assetVal(a, cfg) - assetVal(b, cfg));
              // 1) single chip within band
              const single = pool.find((c) => Math.abs(assetVal(c, cfg) - tv) <= Math.max(14, tv * 0.18));
              if (single) return [single];
              // 2) a player + a pick (or two chips) that together reach a fair band
              for (let i = 0; i < pool.length; i++) {
                for (let j = i + 1; j < pool.length; j++) {
                  const sum = assetVal(pool[i], cfg) + assetVal(pool[j], cfg);
                  if (sum >= tv - 14 && sum <= tv + 22) return [pool[i], pool[j]];
                }
              }
              return null;
            };
            const ideas = [];
            const consider = (t, target) => {
              if (!target || target.id == null || !wants(target.pos)) return;
              const ownerCount = teamRosters[t].filter((p) => p.pos === target.pos).length;
              // a team will move a player once they have more than one playable body at that spot
              // (their RB2/WR3/etc.), or any non-premium depth — they won't deal their only starter.
              if (ownerCount <= 1) return;
              const tv = tradeValue(target, cfg);
              const chips = matchChips(tv);
              if (!chips) return;
              const okForPartner = chips.every((c) => c.pickAsset || !(c.pos === "QB" && !superOnly && teamRosters[t].filter((p) => p.pos === "QB").length >= 1));
              const evv = evaluateTrade(chips, [target], cfg);
              if (okForPartner && evv.giveAdj >= evv.getAdj - 6 && ideas.length < 10) ideas.push({ t, give: chips, get: [target] });
            };
            if (findMode === "player" && findPlayerId != null) {
              const target = players[findPlayerId];
              const owner = teamAt(picks.indexOf(findPlayerId));
              if (owner != null && owner !== userIdx) {
                if (!wants(target.pos)) return <div className="mut" style={{ fontSize: 12.5 }}>Your roster doesn't need another {target.pos}{target.pos === "QB" && !superOnly ? " in a 1QB league" : ""} — targeting {target.name} would leave value on your bench.</div>;
                consider(owner, target);
              }
            } else if (findMode === "position") {
              if (!wants(findPos)) return <div className="mut" style={{ fontSize: 12.5 }}>Your roster doesn't need another {findPos}{findPos === "QB" && !superOnly ? " in a 1QB league" : ""} — you're already set there.</div>;
              for (let t = 0; t < TEAMS; t++) {
                if (t === userIdx) continue;
                const theirs = teamRosters[t].filter((p) => p.pos === findPos).sort((a, b) => tradeValue(b, cfg) - tradeValue(a, cfg));
                // their tradeable bodies = everything past their single best at the position
                theirs.slice(1).forEach((tg) => consider(t, tg));
              }
            }
            if (!ideas.length) {
              const hasChips = myChipPool.length > 0;
              return <div className="mut" style={{ fontSize: 12.5 }}>
                {!hasChips ? "You don't have tradeable chips yet — draft a few players" + (cfg.pickTrading ? "" : ", or turn on draft-pick trading in League settings") + " to build trade pieces."
                  : findMode === "player" ? "No fair package for that target right now — their team may need him, or your chips don't line up in value. Try another target or draft more." 
                  : "No clean upgrades at " + findPos + " yet — nobody has tradeable surplus there, or your chips don't match the value. Try another position or draft a few more rounds."}
              </div>;
            }
            const fmtSide = (arr) => arr.map((a, i) => <span key={i}>{a.pickAsset ? null : <Dot pos={a.pos} />}<b>{a.name}</b> <span className="mut num">({assetVal(a, cfg)})</span>{i < arr.length - 1 ? <span className="mut"> + </span> : null}</span>);
            return ideas.map((id, i) => {
              const kind = id.give.every((c) => c.pickAsset) ? "picks for player" : id.give.some((c) => c.pickAsset) ? "player + pick" : "player swap";
              return (
              <div key={i} className="panel" style={{ padding: 10, marginBottom: 8, background: "var(--panel2)", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span className="mut" style={{ fontSize: 12 }}>with {TEAM_NAMES[id.t].split(" ")[0]}:</span>
                <span style={{ fontSize: 12.5 }}>give {fmtSide(id.give)}</span>
                <i className="ti ti-arrows-exchange" style={{ color: "var(--gold)" }} aria-hidden="true" />
                <span style={{ fontSize: 12.5 }}>get {fmtSide(id.get)}</span>
                <span className="chip" style={{ fontSize: 9, marginLeft: "auto" }}>{kind}</span>
                <button className="btn btn-mini" onClick={() => { setMode("evaluate"); setPartner(id.t); setGive(id.give.map((c) => c.id)); setGet(id.get.map((c) => `their-${c.id}`)); }} title="Load this into Evaluate to propose or force it">Load →</button>
              </div>
              );
            });
          })()}
        </div>
      )}
      <div className="mut" style={{ fontSize: 11, marginTop: 10 }}>{cfg.pickTrading ? "Draft picks are valued by round (next-year rookie picks discounted for uncertainty). " : ""}In dynasty/keeper leagues, counterparty acceptance also uses each owner's real transaction history when a league is connected.</div>
    </div>
  );
}
