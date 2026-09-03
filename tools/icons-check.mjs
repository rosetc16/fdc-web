// Build-time guard: warn loudly if the app references an icon the subset doesn't carry.
// ALWAYS exits 0 — a false positive here must never break a production deploy. The warning is
// enough: a missing icon shows as a blank square, and this names it in the build log.
import fs from 'node:fs';
import { fontIcons, usedIcons } from './icons-scan.mjs';

const FULL = 'node_modules/@tabler/icons-webfont/dist/tabler-icons.min.css';
const SUBSET = 'src/icons.css';
try {
  const shipped = new Set([...fs.readFileSync(SUBSET, 'utf8').matchAll(/\.ti-([a-z0-9-]+):before/g)].map((m) => m[1]));
  // Same two-face view the builder uses, so a legitimately-mapped `x-filled` name isn't flagged.
  const FILLED = 'node_modules/@tabler/icons-webfont/dist/tabler-icons-filled.min.css';
  let known;
  if (fs.existsSync(FULL)) {
    known = new Map(fontIcons(FULL));
    if (fs.existsSync(FILLED)) for (const [n, c] of fontIcons(FILLED)) known.set(n + '-filled', c);
  } else {
    known = new Map([...shipped].map((n) => [n, '']));   // node_modules absent — check against what shipped
  }
  const missing = usedIcons('src', known).filter((n) => !shipped.has(n));
  if (missing.length) {
    /* ⭐ 29ak — THIS EXITS NON-ZERO NOW, AND IT SHOULD ALWAYS HAVE.
       `npm run build` has run this check first for a long time, but it only warned and returned 0, so the
       `&&` chain sailed straight past it. 29ai added the Yahoo and Fantrax connectors to a platform picker
       using ti-brand-yahoo and ti-key — neither of which was in the subset — and shipped a platform chooser
       with blank squares next to two of the five platforms. The warning was printed on every one of those
       builds and scrolled by in the noise above "built in 2.7s".
       A check whose failure does not stop anything is a comment. css-check and screens-check both exit 1;
       so does this. The fix is one command and the message says it. */
    console.error('\n  ✗  ICON SUBSET is missing ' + missing.length + ' icon(s) the app uses:');
    console.error('     ' + missing.join(', '));
    console.error('     These render as blank squares. Fix with:  npm run icons:build\n');
    process.exit(1);
  } else {
    console.log('  ✓ icon subset covers all ' + shipped.size + ' icons in use');
  }
} catch (e) {
  console.warn('  (icon check skipped: ' + e.message + ')');
}
