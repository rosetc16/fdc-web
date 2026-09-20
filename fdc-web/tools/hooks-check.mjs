/* ⭐⭐⭐⭐⭐ TWO WAYS TO WRITE VALID JAVASCRIPT THAT BREAKS REACT — b163
   ══════════════════════════════════════════════════════════════════════════════════════════════════
   THE BUG THAT BOUGHT THIS FILE. `const hoverCache = useRef(…)` was declared next to the function that
   uses it, a thousand lines into TeamHub and below the component's four guards — `if (loading) return
   <HubShell><HubLoading/></HubShell>`. On the first render the hub IS loading, that branch fires, and
   the ref is never reached. On the second render it is, the hook count jumps, and React throws #310
   before anything paints. Every league's in-season hub died behind its error boundary.

   ⚠⚠⚠⚠ NOTHING ELSE ON THIS PROJECT CATCHES IT, AND I WANT TO BE PRECISE ABOUT WHY:
     · a conditional hook is perfectly valid JavaScript, so the build is clean and the bundler is happy;
     · css-check, icons-check and screens-check are all about names and text, not control flow;
     · `page.on('pageerror')` DOES NOT SEE IT, because the hub's error boundary catches the throw — the
       suite carries on and reports the sixteen things it could not find, and every one of those
       failures accuses a feature that is perfectly fine;
     · and the screen still renders on a good day. Whether it breaks depends on whether the component
       ever returns early BEFORE reaching the hook, which depends on how fast the network answered.

   WHAT IT CHECKS. In any function whose name starts with a capital or `use`, a call to a hook that
   appears textually after a `return` statement at the function's own top level. That is the exact shape
   of the bug and it is cheap to find with a real parser.

   ⚠ IT IS DELIBERATELY NARROW. Hooks inside a nested callback (an event handler, a `.map`) are somebody
   else's problem and are not flagged, because a checker that cries wolf gets switched off — the lesson
   screens-check.mjs already paid for.

   ──────────────────────────────────────────────────────────────────────────────────────────────────
   RULE 2 — A COMPONENT DECLARED DURING RENDER AND USED AS JSX.
   `const PosGrid = ({ list, kind }) => …` inside TeamHub, used as `<PosGrid list={sends} kind="send"/>`.
   It reads as an ordinary local helper and it is not one: the function is a NEW VALUE on every render,
   so React sees a new component TYPE, and unmounting and remounting its whole subtree is the only thing
   it can do. In the league read that meant EIGHTY chips destroyed and rebuilt on every hover — the
   "slow" half of Trey's report — and it broke the hover plumbing outright, because the element the
   tooltip recorded as its owner no longer existed by the time the pointer left it. The card could not
   be dismissed at all.

   ⚠⚠ AND IT IS INVISIBLE IN REVIEW. The JSX is correct, the props are correct, the output is correct.
     Only the identity of the function changes, and nothing in the language or the toolchain cares.

   The cure is one character of punctuation: declare it lower-case and CALL it — `{posGrid(sends,
   "send")}` — which inlines the elements into the parent and has no identity to change.
   ══════════════════════════════════════════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import path from 'node:path';

let JSXParser = null;
try {
  const { Parser } = await import('acorn');
  const jsx = (await import('acorn-jsx')).default;
  JSXParser = Parser.extend(jsx());
} catch (e) {
  /* Same standing-down rule as screens-check: this runs inside `npm run build`, which is what Render
     executes. A tooling hiccup must not fail the deploy of an app that is fine. */
  console.warn('  ! hooks-check: could not load acorn/acorn-jsx — SKIPPING (run `npm i` to restore it)');
  process.exit(0);
}

const FILES = ['src/App.jsx', ...(fs.existsSync('src/screens')
  ? fs.readdirSync('src/screens').filter((f) => f.endsWith('.jsx')).map((f) => path.join('src/screens', f))
  : [])];

const HOOK = /^use[A-Z]/;
const isComponentName = (n) => !!n && (/^[A-Z]/.test(n) || HOOK.test(n));

let problems = 0, scanned = 0;

for (const file of FILES) {
  if (!fs.existsSync(file)) continue;
  const src = fs.readFileSync(file, 'utf8');
  let ast;
  try {
    ast = JSXParser.parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
  } catch (e) {
    console.error(`  ✗ hooks-check: could not parse ${file} — ${e.message}`);
    process.exit(1);
  }
  const lineOf = (node) => node.loc.start.line;

  /* Walk to every function that looks like a component or a custom hook, then look only at ITS OWN
     top-level statement list. */
  const visit = (node, fnName) => {
    if (!node || typeof node.type !== 'string') return;
    let name = fnName;
    if (node.type === 'FunctionDeclaration' && node.id) name = node.id.name;
    if ((node.type === 'VariableDeclarator') && node.id && node.id.type === 'Identifier'
      && node.init && /Function|ArrowFunctionExpression/.test(node.init.type)) name = node.id.name;

    const isFn = /FunctionDeclaration|FunctionExpression|ArrowFunctionExpression/.test(node.type);
    if (isFn && isComponentName(name) && node.body && node.body.type === 'BlockStatement') {
      scanned++;
      /* The first `return` at the component's own top level. Everything after it is conditional. */
      let firstReturn = null;
      for (const st of node.body.body) {
        const ret = st.type === 'ReturnStatement' ? st
          : (st.type === 'IfStatement' && st.consequent
            && (st.consequent.type === 'ReturnStatement'
              || (st.consequent.type === 'BlockStatement' && st.consequent.body.some((x) => x.type === 'ReturnStatement')))) ? st
            : null;
        if (ret) { firstReturn = ret; break; }
      }
      if (firstReturn) {
        const cut = lineOf(firstReturn);
        /* ⚠ ONLY THE COMPONENT'S OWN TOP-LEVEL STATEMENTS. A hook inside a nested function after the
           early return is a different (and legal-looking) thing; see the header. */
        for (const st of node.body.body) {
          if (lineOf(st) <= cut) continue;
          const found = [];
          const scan = (n, depth) => {
            if (!n || typeof n.type !== 'string') return;
            if (/FunctionDeclaration|FunctionExpression|ArrowFunctionExpression/.test(n.type)) return; // nested — not ours
            if (n.type === 'CallExpression' && n.callee && n.callee.type === 'Identifier' && HOOK.test(n.callee.name)) {
              found.push({ name: n.callee.name, line: lineOf(n) });
            }
            for (const k in n) {
              const v = n[k];
              if (k === 'loc' || k === 'start' || k === 'end') continue;
              if (Array.isArray(v)) v.forEach((c) => scan(c, depth + 1));
              else if (v && typeof v.type === 'string') scan(v, depth + 1);
            }
          };
          scan(st, 0);
          found.forEach((f) => {
            problems++;
            console.error(`  ✗ ${file}:${f.line} — ${f.name}() in <${name}> sits BELOW an early return on line ${cut}.`);
            console.error('      React throws #310 the moment that guard stops firing. Move the hook up with the others.');
          });
        }
      }
    }

    for (const k in node) {
      const v = node[k];
      if (k === 'loc' || k === 'start' || k === 'end') continue;
      if (Array.isArray(v)) v.forEach((c) => visit(c, name));
      else if (v && typeof v.type === 'string') visit(v, name);
    }
  };
  visit(ast, null);
}

/* ⭐⭐⭐⭐⭐ THE BASELINE IS EMPTY, AND KEEPING IT THAT WAY IS THE POINT — b163.
   Rule 2 found twenty-three of these already in the tree when it was written, so they were recorded here
   and reported as warnings while the gate failed only on new ones. All twenty-three are now gone: every
   one is a plain function that gets CALLED, except `TrendsSection`, which owned `useState` and was
   therefore hoisted to module scope instead — calling that one would have spliced its hook into its
   parent's hook list.
   ⚠ NOTHING GOES BACK IN HERE. An entry is a subtree React rebuilds on every render of its parent; the
     one in the league read was remounting eighty chips per hover and left a tooltip that could not be
     dismissed, because the node the card recorded as its owner no longer existed. If a new one is
     genuinely unavoidable, it needs a comment at the site saying why, not a line in this list. */
const RULE2_BASELINE = new Set([]);

/* ══ RULE 2 ═══════════════════════════════════════════════════════════════════════════════════════
   A capitalised function declared INSIDE another function, and used as a JSX element somewhere in the
   same file. Both halves are required: a capitalised local that is only ever called is fine. */
let carried = 0;
const rule2 = (file, name, line) => {
  if (RULE2_BASELINE.has(`${file}|${name}`)) { carried++; return; }
  problems++;
  console.error(`  ✗ ${file}:${line} — <${name}> is declared inside another function and rendered as JSX.`);
  console.error('      React remounts its entire subtree on every render. Rename it lower-case and CALL it instead.');
};

for (const file of FILES) {
  if (!fs.existsSync(file)) continue;
  const src = fs.readFileSync(file, 'utf8');
  let ast;
  try { ast = JSXParser.parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true }); } catch { continue; }

  const usedAsElement = new Set();
  const collectJsx = (n) => {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'JSXOpeningElement' && n.name && n.name.type === 'JSXIdentifier' && /^[A-Z]/.test(n.name.name)) {
      usedAsElement.add(n.name.name);
    }
    for (const k in n) {
      if (k === 'loc' || k === 'start' || k === 'end') continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach(collectJsx);
      else if (v && typeof v.type === 'string') collectJsx(v);
    }
  };
  collectJsx(ast);

  const walk = (n, depth) => {
    if (!n || typeof n.type !== 'string') return;
    const isFn = /FunctionDeclaration|FunctionExpression|ArrowFunctionExpression/.test(n.type);
    if (depth > 0 && n.type === 'VariableDeclarator' && n.id && n.id.type === 'Identifier'
      && /^[A-Z]/.test(n.id.name) && n.init
      && /FunctionExpression|ArrowFunctionExpression/.test(n.init.type)
      && usedAsElement.has(n.id.name)) {
      rule2(file, n.id.name, n.loc.start.line);
    }
    if (depth > 0 && n.type === 'FunctionDeclaration' && n.id && /^[A-Z]/.test(n.id.name) && usedAsElement.has(n.id.name)) {
      rule2(file, n.id.name, n.loc.start.line);
    }
    for (const k in n) {
      if (k === 'loc' || k === 'start' || k === 'end') continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach((c) => walk(c, depth + (isFn ? 1 : 0)));
      else if (v && typeof v.type === 'string') walk(v, depth + (isFn ? 1 : 0));
    }
  };
  walk(ast, 0);
}

if (problems) {
  console.error(`\n  ${problems} problem${problems === 1 ? '' : 's'} — valid JavaScript that React cannot do the right thing with.\n`);
  process.exit(1);
}
console.log(`  ✓ no conditional hooks, no components declared during render (${scanned} scanned`
  + (carried ? `, ${carried} carried` : '') + ')');
