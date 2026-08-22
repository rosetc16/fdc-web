// Shared scan: which Tabler icons does the app actually reference?
// Two passes, because icon names reach the DOM two ways:
//   1. literal class names — className="ti ti-flag-3"
//   2. dynamic ones — className={`ti ti-${busy ? "loader-2" : "refresh"}`}
// The second kind has no "ti-" prefix in the source, so we also intersect every quoted token with the
// real icon list. That over-includes a few words that happen to be icon names, which costs a few hundred
// bytes and cannot break anything — the opposite mistake renders a blank square in production.
import fs from 'node:fs';

export function fontIcons(cssPath) {
  const css = fs.readFileSync(cssPath, 'utf8');
  const out = new Map();
  for (const [, name, cp] of css.matchAll(/\.ti-([a-z0-9-]+):before\{content:"\\([0-9a-fA-F]+)"\}/g)) out.set(name, cp);
  return out;
}

export function usedIcons(srcPath, known) {
  const src = fs.readFileSync(srcPath, 'utf8');
  const used = new Set();
  for (const [, name] of src.matchAll(/\bti-([a-z0-9-]+)\b/g)) if (known.has(name)) used.add(name);
  for (const [, tok] of src.matchAll(/["']([a-z0-9][a-z0-9-]{2,30})["']/g)) if (known.has(tok)) used.add(tok);
  for (const n of ['loader-2', 'cloud-download', 'refresh', 'calendar-event']) if (known.has(n)) used.add(n);
  return [...used].sort();
}
