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

export function usedIcons(srcPath, known) {
  const src = sourceFiles(srcPath).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const used = new Set();
  for (const [, name] of src.matchAll(/\bti-([a-z0-9-]+)\b/g)) if (known.has(name)) used.add(name);
  for (const [, tok] of src.matchAll(/["']([a-z0-9][a-z0-9-]{2,30})["']/g)) if (known.has(tok)) used.add(tok);
  for (const n of ['loader-2', 'cloud-download', 'refresh', 'calendar-event']) if (known.has(n)) used.add(n);
  return [...used].sort();
}
