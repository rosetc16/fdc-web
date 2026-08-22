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
  const missing = usedIcons('src/App.jsx', known).filter((n) => !shipped.has(n));
  if (missing.length) {
    console.warn('\n  ⚠  ICON SUBSET is missing ' + missing.length + ' icon(s) the app uses:');
    console.warn('     ' + missing.join(', '));
    console.warn('     These will render as blank squares. Run:  npm run icons:build\n');
  } else {
    console.log('  ✓ icon subset covers all ' + shipped.size + ' icons in use');
  }
} catch (e) {
  console.warn('  (icon check skipped: ' + e.message + ')');
}
