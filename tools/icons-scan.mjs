// Shared scan: which Tabler icons does the app actually reference?
// Two passes, because icon names reach the DOM two ways:
//   1. literal class names — className="ti ti-flag-3"
//   2. dynamic ones — className={`ti ti-${busy ? "loader-2" : "refresh"}`}
// The second kind has no "ti-" prefix in the source, so we also intersect every quoted token with the
// real icon list. That over-includes a few words that happen to be icon names, which costs a few hundred
// bytes and cannot break anything — the opposite mistake renders a blank square in production.
//
// ⚠⚠⚠ 29p — IT SCANS EVERY SOURCE FILE NOW, NOT JUST App.jsx. The moment four screens moved into
// src/screens/*.jsx for code-splitting, the subset dropped from 175 icons to 163 — every icon used ONLY by
// a split screen silently stopped shipping, and a missing glyph renders as a blank square that looks
// exactly like a feature that failed to load. `usedIcons` therefore takes a DIRECTORY and walks it. This is
// the fourth incarnation of the same lesson in this project: a tool that hardcodes where the code lives
// breaks the day the code moves, and it breaks quietly.
import fs from 'node:fs';
import path from 'node:path';

// Every .js/.jsx under a directory, or the single file it is given.
function sourceFiles(p) {
  const st = fs.statSync(p);
  if (!st.isDirectory()) return [p];
  const out = [];
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const full = path.join(p, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(jsx?|tsx?)$/.test(e.name)) out.push(full);
  }
  return out;
}

export function fontIcons(cssPath) {
  const css = fs.readFileSync(cssPath, 'utf8');
  const out = new Map();
  for (const [, name, cp] of css.matchAll(/\.ti-([a-z0-9-]+):before\{content:"\\([0-9a-fA-F]+)"\}/g)) out.set(name, cp);
  return out;
}

/* ⚠⚠⚠ 29an — COMMENTS ARE NOT CODE, AND SCANNING THEM BROKE A BUILD.
   The quoted-token pass intersects EVERY quoted lowercase word with the real icon list, and Tabler ships
   about five thousand icons whose names are ordinary English: check, home, search, user, filter, plus,
   photo, mail — and `placeholder`. So a prose comment containing the word "placeholder" in quotes was read
   as an icon reference, the subset did not carry it, and `npm run build` failed with a missing icon that
   does not exist anywhere in the UI.

   That is not a small annoyance. Since 29ak this check EXITS 1 (rightly — as a warning it let two blank
   platform icons ship), so a false positive now stops a deploy, and the failure names an icon nobody can
   find because it is a word in a sentence. The file this scanner supports opens by saying "a false positive
   here must never break a production deploy"; making the check fatal without making the scan precise put
   those two facts in conflict, and this is where they met.

   Stripping comments first fixes the class, not the instance: no future comment can break the build by
   containing a common word in quotes. The walk is character-by-character rather than a regex because a
   regex for comments eats "https://…" inside a string, which would strip real code and turn a build-
   breaking false positive into a silent false NEGATIVE — a blank square in production, which is the
   expensive direction. */
function stripComments(s) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    const d = s[i + 1];
    if (c === '/' && d === '/') { while (i < n && s[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(s[i] === '*' && s[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      out += c; i++;
      while (i < n) {
        if (s[i] === '\\') { out += s[i] + (s[i + 1] || ''); i += 2; continue; }
        out += s[i];
        if (s[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

export function usedIcons(srcPath, known) {
  const src = sourceFiles(srcPath).map((f) => stripComments(fs.readFileSync(f, 'utf8'))).join('\n');
  const used = new Set();
  for (const [, name] of src.matchAll(/\bti-([a-z0-9-]+)\b/g)) if (known.has(name)) used.add(name);
  for (const [, tok] of src.matchAll(/["']([a-z0-9][a-z0-9-]{2,30})["']/g)) if (known.has(tok)) used.add(tok);
  for (const n of ['loader-2', 'cloud-download', 'refresh', 'calendar-event']) if (known.has(n)) used.add(n);
  return [...used].sort();
}
export const _stripComments = stripComments;
