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
  /* ⚠⚠⚠⚠⚠ b161 — THE CHARACTER WALK IS GONE. IT COULD NOT BE MADE CORRECT, AND IT FAILED SILENTLY.
     ==================================================================================================
     The previous version tracked strings so it would not mistake a quote inside one for code. To do that
     it had to lex JavaScript, and it got three whole classes wrong — each of which DESYNCS THE REST OF
     THE FILE, so a single bad character hundreds of lines earlier decides whether a comment ten thousand
     lines later is scanned as code:

       1. NESTED TEMPLATE LITERALS.  `${on ? `a ${b}` : ""}`  — the inner backtick was read as the outer's
          closer, and every backtick after that meant the opposite of what it should.
       2. AN APOSTROPHE IN JSX TEXT.  <span>DIDN'T LAND</span>  — not a string, but it opened one that ran
          to the next apostrophe, wherever in the file that happened to be.
       3. REGEX LITERALS.  /[",\n]/.test(t)  — the quote inside the character class opened a string. This
          is the one that cannot be fixed by patching: telling a regex from a division needs the parser to
          know whether the previous token was a value, which is the whole of JavaScript's lexical grammar.

     Each showed up as the build failing on an icon that appears nowhere in the UI — `activity`, `code`,
     `map`, `table` — named only by comments explaining that those exact words are dangerous to write. The
     check exits 1 since 29ak, so every one of these is a stopped deploy pointing at nothing you can find.

     ⭐ SO THE SCAN IS SPLIT BY RISK INSTEAD (see usedIcons). Explicit `ti-foo` references are read from
       the RAW source, where the only possible error is over-including an icon a comment mentions — a few
       hundred bytes, and harmless. Only the QUOTED-TOKEN pass, which is the one that generates false
       positives, reads the stripped source. That means this function no longer has to be correct in the
       direction that ships blank squares; it only has to be correct enough not to invent icons.

     ⭐ AND IT IS LINE-ORIENTED, which is the property that matters: state resets at every newline except
       for an open block comment, so NOTHING here can desync the rest of the file. It does not know about
       strings at all, and it does not need to.
     ⚠ THE ONE GUARD IT DOES NEED is `://`, because a URL inside a string would otherwise truncate its
       line. Protocol-relative and path cases are the only `//` inside strings this codebase has. */
  const out = [];
  let inBlock = false;
  for (const line of s.split('\n')) {
    let res = '', i = 0;
    while (i < line.length) {
      if (inBlock) {
        const e = line.indexOf('*/', i);
        if (e < 0) { i = line.length; break; }
        inBlock = false; i = e + 2; continue;
      }
      const b = line.indexOf('/*', i);
      let l = line.indexOf('//', i);
      while (l > 0 && line[l - 1] === ':') l = line.indexOf('//', l + 2);   // https:// is not a comment
      if (b >= 0 && (l < 0 || b < l)) { res += line.slice(i, b); inBlock = true; i = b + 2; continue; }
      if (l >= 0) { res += line.slice(i, l); i = line.length; break; }
      res += line.slice(i); i = line.length;
    }
    out.push(res);
  }
  return out.join('\n');
}

export function usedIcons(srcPath, known) {
  const files = sourceFiles(srcPath).map((f) => fs.readFileSync(f, 'utf8'));
  const raw = files.join('\n');
  const code = files.map(stripComments).join('\n');
  const used = new Set();
  /* ⭐⭐⭐⭐⭐ PASS ONE READS THE RAW SOURCE. An explicit `ti-foo` is unambiguous — nothing else in this
     codebase is spelled that way — so the only thing scanning comments can do here is include an icon a
     comment happens to name. That costs a few hundred bytes in the subset. MISSING one ships a blank
     square, which is the failure this whole file exists to prevent, so this pass never gets to be clever. */
  for (const [, name] of raw.matchAll(/\bti-([a-z0-9-]+)\b/g)) if (known.has(name)) used.add(name);
  /* ⚠ PASS TWO READS THE STRIPPED SOURCE, because this is the pass that invents icons: it intersects
     every quoted lowercase word with a list of five thousand ordinary English words, so a comment saying
     "placeholder" becomes a missing-icon build failure. Comments are not code and must not be scanned
     here. See stripComments for why it is line-oriented. */
  for (const [, tok] of code.matchAll(/["']([a-z0-9][a-z0-9-]{2,30})["']/g)) if (known.has(tok)) used.add(tok);
  for (const n of ['loader-2', 'cloud-download', 'refresh', 'calendar-event']) if (known.has(n)) used.add(n);
  return [...used].sort();
}
export const _stripComments = stripComments;
