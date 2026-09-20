// BUILD BOTH PREVIEW BUNDLES, WITH THE RIGHT BACKEND BAKED INTO EACH.
//
// ⚠ WHY THIS EXISTS. Vite bakes `VITE_API_URL` in AT BUILD TIME, and the two preview bundles the browser
// suites drive need DIFFERENT values:
//
//   dist  → :4173 → NO backend at all.  The suites that read this one (avoidpage, avoidscope, hubviews,
//                                       hubpanel, prepmodals, navback) seed localStorage directly. Give
//                                       this bundle a backend and it merges the seed against the stub's
//                                       empty server state, the seeded league loses, and every assertion
//                                       afterwards runs against a blank app.
//   distb → :4174 → http://localhost:5055, the CHAOS PROXY, which forwards to the stub on :5056 and can be
//                                       flipped into its failure modes at runtime by dnight.mjs without a
//                                       rebuild.
//
// Getting this wrong does not look like a config mistake. It looks like FIVE PRODUCT BUGS: a draft seat
// that won't correct itself, injury notes with no body part, a clipped player name. That happened in 29n
// and cost a full debugging round, so the knowledge lives in a script now instead of in someone's head.
//
//   npm run build:test          both bundles
//   npm run build:test -- dist  just the one
//
// The plain `npm run build` is still what ships to Render — it reads whatever VITE_API_URL the environment
// gives it, which in production is the real backend.
import { spawnSync } from "child_process";

const TARGETS = {
  dist: { outDir: "dist", api: "", why: "no backend — suites seed localStorage and must not be merged against an empty server" },
  distb: { outDir: "distb", api: "http://localhost:5055", why: "the chaos proxy, which forwards to the stub on :5056" },
};

const asked = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const names = asked.length ? asked : Object.keys(TARGETS);

for (const n of names) {
  const t = TARGETS[n];
  if (!t) {
    console.error(`\n  ✗ unknown target "${n}" — expected one of: ${Object.keys(TARGETS).join(", ")}\n`);
    process.exit(1);
  }
  console.log(`\n  → ${t.outDir}  VITE_API_URL=${t.api || "(unset)"}  — ${t.why}`);
  // An EMPTY string and an ABSENT variable are the same thing to src/api.js (`hasBackend = !!API`), but they
  // are not the same thing to the shell, so delete the key rather than setting it blank — an inherited
  // VITE_API_URL from the parent environment would otherwise leak into the no-backend bundle.
  const env = { ...process.env };
  if (t.api) env.VITE_API_URL = t.api; else delete env.VITE_API_URL;
  const r = spawnSync("npx", ["vite", "build", "--outDir", t.outDir], { stdio: "inherit", env, shell: false });
  if (r.status !== 0) {
    console.error(`\n  ✗ ${t.outDir} failed to build\n`);
    process.exit(r.status || 1);
  }
}

console.log(`\n  ✓ ${names.length === 1 ? names[0] : "both preview bundles"} rebuilt — restart nothing, vite preview serves from disk\n`);
