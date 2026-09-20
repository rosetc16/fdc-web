// ⚠⚠⚠ NO BACKTICKS INSIDE THE STYLESHEET.
//
// src/App.jsx holds the whole stylesheet as a JS TEMPLATE LITERAL (`const css = \`...\``). A backtick
// anywhere inside it — including inside a /* CSS comment */ — terminates the string. Sometimes that is a
// build error naming a line hundreds of lines away; sometimes it PAIRS with a later backtick and the build
// SUCCEEDS while everything between them is silently swallowed, so the app ships with a chunk of its
// stylesheet missing. That second failure mode cost a full debugging round in 29m: `.modalbg` lost
// `position:fixed`, a modal rendered 2000px down the page, and it looked like a React bug.
//
// This has now happened FOUR times across the project's life. It is not a thing to remember; it is a thing
// to check. Runs as part of `npm run build`, and FAILS the build rather than warning — a warning is what
// the icon check does, and a warning is exactly what nobody reads.
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const start = src.indexOf('const css = `');
if (start < 0) {
  console.error('css-check: could not find the stylesheet literal — has it been renamed?');
  process.exit(1);
}
const end = src.indexOf('\n`;', start);
if (end < 0) {
  console.error('css-check: the stylesheet literal is not closed by a line starting with `;');
  process.exit(1);
}

const body = src.slice(start + 'const css = `'.length, end);
const startLine = src.slice(0, start).split('\n').length;
const bad = [];
body.split('\n').forEach((line, i) => {
  if (line.includes('`')) bad.push({ n: startLine + i, line: line.trim() });
});

if (bad.length) {
  console.error(`\n  ✗ ${bad.length} backtick${bad.length === 1 ? '' : 's'} inside the stylesheet — this silently truncates the CSS at runtime:\n`);
  for (const b of bad) console.error(`      src/App.jsx:${b.n}  ${b.line.slice(0, 100)}`);
  console.error('\n    Rewrite the comment without backticks (say "child-combinator selector", not the character).\n');
  process.exit(1);
}

// A second, cheaper sanity check: braces inside the sheet must balance. An unclosed @media block eats every
// rule after it in exactly the same invisible way.
let depth = 0;
for (const ch of body) { if (ch === '{') depth++; else if (ch === '}') depth--; if (depth < 0) break; }
if (depth !== 0) {
  console.error(`\n  ✗ the stylesheet's braces do not balance (depth ${depth}) — an unclosed block swallows every rule after it.\n`);
  process.exit(1);
}

// A third: comment delimiters must nest properly. CSS comments DO NOT NEST, so an editing slip that leaves a
// stray `*/` on its own line — the classic one is inserting a new paragraph after the `*/` that already
// closed the comment you meant to extend — turns the text into garbage tokens and the parser then discards
// everything up to the next recovery point. In 29ac that swallowed the very rule the comment described:
// `.droomhead>.disp` never applied, the mobile header kept its old layout, and both the backtick check and
// the brace check passed because nothing was unbalanced. Same silent-truncation family, so it belongs here.
const marks = [];
for (let i = 0; i < body.length - 1; i++) {
  if (body[i] === '/' && body[i + 1] === '*') { marks.push({ k: 'open', i }); i++; }
  else if (body[i] === '*' && body[i + 1] === '/') { marks.push({ k: 'close', i }); i++; }
}
const lineAt = (i) => startLine + body.slice(0, i).split('\n').length - 1;
let open = false;
for (const m of marks) {
  if (m.k === 'open') {
    if (open) continue; // /* inside a comment is just text
    open = true;
  } else {
    if (!open) {
      console.error(`\n  ✗ a stray */ at src/App.jsx:${lineAt(m.i)} closes a comment that was never opened.\n`);
      console.error('      CSS comments do not nest — the usual cause is text added AFTER the */ that already');
      console.error('      closed the comment. Everything from there to the next recovery point is discarded');
      console.error(`      silently, including whatever rule follows: ${(body.slice(m.i + 2, m.i + 90).split('\n').find((l) => l.trim()) || '').trim()}\n`);
      process.exit(1);
    }
    open = false;
  }
}
if (open) {
  console.error('\n  ✗ the stylesheet ends inside an unterminated /* comment — every rule after it is gone.\n');
  process.exit(1);
}

console.log(`  ✓ stylesheet is clean (${body.split('\n').length} lines, no stray backticks, braces balanced, comments closed)`);
