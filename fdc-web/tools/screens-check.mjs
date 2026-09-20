/* ⭐⭐⭐ 29r — DOES EVERY SPLIT SCREEN HAVE EVERYTHING IT USES?
   ------------------------------------------------------------------------------------------------
   Trey, on production: "Something happened in the last update that won't let me click on the admin tab now…
   `hasBackend is not defined`."

   The 29p split moved four screens into src/screens/*.jsx and worked out their imports from App.jsx's
   top-level DECLARATIONS. `hasBackend` is not declared in App.jsx — it is IMPORTED there from ./api.js — so
   the extractor never saw it, never added it to the screen's import list, and the screen shipped referencing
   a name that does not exist in its module. ⚠ NOTHING ELSE CATCHES THAT: a free identifier is valid
   JavaScript, resolved at run time, so the bundler is happy and the build is clean. The failure only happens
   when a human opens that one screen. It reached production because Admin is the screen I am least likely to
   click.

   So it becomes a build step, and it uses a REAL PARSER. ⚠ THE FIRST CUT OF THIS FILE WAS A REGEX and it
   reported 65 "missing names" on Admin.jsx alone — `the`, `with`, `fontSiz` — because a regex cannot tell
   code from JSX text and chops the last character off an attribute name. A checker that cries wolf 400 times
   gets deleted in a week, which would have left the real bug uncaught a second time. acorn + acorn-jsx are
   already in the tree (Vite pulls them); we walk scopes properly and report only genuinely free identifiers.
   ------------------------------------------------------------------------------------------------ */
import fs from 'node:fs';
import path from 'node:path';

/* ⚠ acorn and acorn-jsx are declared in devDependencies, but they are LOADED DYNAMICALLY on purpose.
   This runs inside `npm run build`, which is what Render executes to deploy. A checker that throws on an
   unresolvable import would turn a tooling hiccup into a failed deploy of an app that is perfectly fine —
   trading the bug it prevents for a worse one. If the parser is not there we say so loudly and stand down.
   Locally it always resolves, which is where the check actually has to bite. */
let JSXParser = null;
try {
  const { Parser } = await import('acorn');
  const jsx = (await import('acorn-jsx')).default;
  JSXParser = Parser.extend(jsx());
} catch (e) {
  console.warn('  ! screens-check: could not load acorn/acorn-jsx — SKIPPING (run `npm i` to restore it)');
  console.warn('    ' + e.message);
  process.exit(0);
}

const DIR = 'src/screens';
if (!fs.existsSync(DIR)) { console.log('  no split screens — nothing to check'); process.exit(0); }

// Names the language and the browser provide. Anything here is legitimately free.
const GLOBALS = new Set([
  'window', 'document', 'navigator', 'location', 'history', 'localStorage', 'sessionStorage', 'console',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame',
  'fetch', 'Promise', 'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Date', 'RegExp',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'Error', 'TypeError', 'RangeError', 'Symbol', 'Intl', 'Blob', 'File',
  'FormData', 'URL', 'URLSearchParams', 'AbortController', 'Image', 'Audio', 'Event', 'CustomEvent',
  'MouseEvent', 'KeyboardEvent', 'IntersectionObserver', 'ResizeObserver', 'MutationObserver', 'performance',
  'crypto', 'structuredClone', 'queueMicrotask', 'isNaN', 'isFinite', 'parseInt', 'parseFloat',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI', 'globalThis', 'undefined', 'NaN',
  'Infinity', 'process', 'HTMLElement', 'Node', 'DOMParser', 'TextEncoder', 'TextDecoder', 'BigInt', 'Proxy',
  'Reflect', 'atob', 'btoa', 'arguments', 'alert', 'confirm', 'prompt', 'getComputedStyle', 'matchMedia',
  'Notification', 'WebSocket', 'EventSource', 'Worker', 'Response', 'Request', 'Headers', 'Function',
]);

// ---- binding collection ------------------------------------------------------------------------------
// Every shape a name can be introduced by. Missing one here produces a FALSE POSITIVE, which is the failure
// mode that gets a checker switched off, so this is deliberately exhaustive.
function bindPattern(node, add) {
  if (!node) return;
  switch (node.type) {
    case 'Identifier': add(node.name); break;
    case 'ObjectPattern': node.properties.forEach((p) => bindPattern(p.type === 'RestElement' ? p.argument : p.value, add)); break;
    case 'ArrayPattern': node.elements.forEach((e) => bindPattern(e, add)); break;
    case 'AssignmentPattern': bindPattern(node.left, add); break;
    case 'RestElement': bindPattern(node.argument, add); break;
    default: break;
  }
}

const FN = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const SCOPED = new Set([...FN, 'Program', 'BlockStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement',
  'CatchClause', 'ClassDeclaration', 'ClassExpression', 'StaticBlock']);

function childNodes(node) {
  const out = [];
  for (const k of Object.keys(node)) {
    if (k === 'type' || k === 'start' || k === 'end' || k === 'loc' || k === 'range') continue;
    const v = node[k];
    if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') out.push(c); }
    else if (v && typeof v.type === 'string') out.push(v);
  }
  return out;
}

// Names declared directly inside a scope node (not descending into nested function scopes for `var`
// hoisting — we hoist `var` and function declarations up to the nearest function/program scope).
function collectBindings(scopeNode, add) {
  const walkForVars = (n, insideNestedFn) => {
    for (const c of childNodes(n)) {
      if (FN.has(c.type)) { walkForVars(c, true); continue; }
      if (c.type === 'VariableDeclaration' && c.kind === 'var' && !insideNestedFn) c.declarations.forEach((d) => bindPattern(d.id, add));
      if (c.type === 'FunctionDeclaration' && !insideNestedFn && c.id) add(c.id.name);
      if (!FN.has(c.type)) walkForVars(c, insideNestedFn);
    }
  };

  if (FN.has(scopeNode.type)) {
    if (scopeNode.id) add(scopeNode.id.name);
    scopeNode.params.forEach((p) => bindPattern(p, add));
  }
  if (scopeNode.type === 'CatchClause' && scopeNode.param) bindPattern(scopeNode.param, add);
  if (scopeNode.type === 'ClassDeclaration' || scopeNode.type === 'ClassExpression') { if (scopeNode.id) add(scopeNode.id.name); }

  // let/const/class/import in the immediate statement list; var + function hoisted to function scope.
  const body = scopeNode.type === 'Program' ? scopeNode.body
    : FN.has(scopeNode.type) ? (scopeNode.body && scopeNode.body.type === 'BlockStatement' ? scopeNode.body.body : [])
    : scopeNode.type === 'BlockStatement' ? scopeNode.body
    : scopeNode.type === 'CatchClause' ? (scopeNode.body ? scopeNode.body.body : [])
    : [];
  for (const st of body) {
    if (st.type === 'VariableDeclaration') st.declarations.forEach((d) => bindPattern(d.id, add));
    else if (st.type === 'FunctionDeclaration' && st.id) add(st.id.name);
    else if (st.type === 'ClassDeclaration' && st.id) add(st.id.name);
    else if (st.type === 'ImportDeclaration') st.specifiers.forEach((s) => add(s.local.name));
    else if (st.type === 'ExportNamedDeclaration' && st.declaration) {
      const d = st.declaration;
      if (d.type === 'VariableDeclaration') d.declarations.forEach((x) => bindPattern(x.id, add));
      else if (d.id) add(d.id.name);
    } else if (st.type === 'ExportDefaultDeclaration' && st.declaration && st.declaration.id) add(st.declaration.id.name);
  }
  // for (let x …) / for (const x of …)
  if (scopeNode.type.startsWith('For')) {
    const init = scopeNode.init || scopeNode.left;
    if (init && init.type === 'VariableDeclaration') init.declarations.forEach((d) => bindPattern(d.id, add));
  }
  if (scopeNode.type === 'Program' || FN.has(scopeNode.type)) walkForVars(scopeNode, false);
}

// ---- reference collection ----------------------------------------------------------------------------
// A node is a REFERENCE if it is an Identifier in value position. Everything below is the exhaustive list
// of places an Identifier appears WITHOUT being a reference; get one wrong and we report a phantom.
function isReference(node, parent, key) {
  if (node.type === 'JSXIdentifier') {
    // <Foo>, <Foo.Bar> — a capitalised or dotted JSX name resolves to a binding. Lowercase is an HTML tag.
    if (parent && parent.type === 'JSXOpeningElement' && key === 'name') return /^[A-Z]/.test(node.name);
    if (parent && parent.type === 'JSXClosingElement') return false;
    if (parent && parent.type === 'JSXMemberExpression') return key === 'object' && /^[A-Z]/.test(node.name);
    if (parent && parent.type === 'JSXAttribute' && key === 'name') return false;   // className, onClick…
    if (parent && parent.type === 'JSXNamespacedName') return false;
    return false;
  }
  if (node.type !== 'Identifier') return false;
  if (!parent) return true;
  switch (parent.type) {
    case 'MemberExpression': return key === 'object' || parent.computed;
    case 'Property': return !(key === 'key' && !parent.computed);
    case 'PropertyDefinition': case 'MethodDefinition': return !(key === 'key' && !parent.computed);
    case 'VariableDeclarator': return key === 'init';
    case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression':
      return key !== 'id' && key !== 'params';
    case 'ClassDeclaration': case 'ClassExpression': return key !== 'id';
    case 'ImportSpecifier': case 'ImportDefaultSpecifier': case 'ImportNamespaceSpecifier':
    case 'ExportSpecifier': return false;
    case 'LabeledStatement': case 'BreakStatement': case 'ContinueStatement': return false;
    case 'ObjectPattern': case 'ArrayPattern': case 'RestElement': return false;
    case 'AssignmentPattern': return key === 'right';
    case 'CatchClause': return key !== 'param';
    case 'MetaProperty': return false;
    default: return true;
  }
}

// ---- the walk ----------------------------------------------------------------------------------------
function freeNames(ast) {
  const free = new Map();   // name → first line seen
  const walk = (node, parent, key, chain) => {
    let scope = chain;
    if (SCOPED.has(node.type)) {
      const s = new Set();
      collectBindings(node, (n) => s.add(n));
      scope = chain.concat([s]);
    }
    if (isReference(node, parent, key)) {
      const name = node.name;
      if (!GLOBALS.has(name) && !scope.some((s) => s.has(name)) && !free.has(name)) {
        free.set(name, node.loc ? node.loc.start.line : 0);
      }
    }
    for (const k of Object.keys(node)) {
      if (k === 'type' || k === 'start' || k === 'end' || k === 'loc' || k === 'range') continue;
      const v = node[k];
      if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') walk(c, node, k, scope); }
      else if (v && typeof v.type === 'string') walk(v, node, k, scope);
    }
  };
  walk(ast, null, null, []);
  return free;
}

// ---- run ---------------------------------------------------------------------------------------------
let bad = 0;
for (const f of fs.readdirSync(DIR).filter((n) => /\.jsx?$/.test(n)).sort()) {
  const file = path.join(DIR, f);
  let ast;
  try {
    ast = JSXParser.parse(fs.readFileSync(file, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module', locations: true });
  } catch (e) {
    console.error(`  ✖ ${file} does not parse: ${e.message}`);
    bad++; continue;
  }
  const free = freeNames(ast);
  if (free.size) {
    bad += free.size;
    console.error(`  ✖ ${file} references ${free.size} name${free.size === 1 ? '' : 's'} it never imported:`);
    for (const [n, line] of [...free].sort((a, b) => a[1] - b[1])) console.error(`      ${n}   (first used line ${line})`);
  } else {
    console.log(`  ✓ ${file}`);
  }
}

if (bad) {
  console.error('\n  A split screen references a name it never imported. That builds CLEAN and throws the');
  console.error('  moment somebody opens the screen — which is how "hasBackend is not defined" reached');
  console.error('  production on the Admin tab. Add the name to the screen\'s import from ../App.jsx');
  console.error('  (exporting it there if needed), or import it from its real home.');
  process.exit(1);
}
console.log('  ✓ every split screen has everything it references');
