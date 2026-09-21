/* ═══════════════════════════════════════════════════════════════════════════════════════════════════
   NO UNDECLARED NAMES IN THE MAIN BUNDLE — tools/globals-check.mjs, 29bc
   ───────────────────────────────────────────────────────────────────────────────────────────────────
   The second time this app has shipped a name nobody declared, and both times it took the site down:
     · 29r  — `hasBackend is not defined` on the Admin tab (a split screen; screens-check was written for it)
     · 29bc — `injuries is not defined` on the HOME PAGE, for every signed-in user. 29bb wired the home
              page's Power column to the injury map and read `injuries` inside `PaidHub`, where it is not
              in scope — it is `App`'s state and was never passed down.
   ⚠ WHY NOTHING CAUGHT IT: an undeclared name is legal JavaScript. The bundler emits it, the build is
     clean, and it only throws when that line RUNS. screens-check does the scope walk, but only over
     src/screens/*.jsx — App.jsx, where 43,000 of the app's lines live, was never scanned, because the
     acorn walker takes minutes on a file that size. The node suites import App.jsx through a library
     build and never render `PaidHub`, so they could not see it either.
   ⭐ THIS USES BABEL'S OWN SCOPE ANALYSIS (`@babel/parser` + `@babel/traverse`, already installed by the
     React plugin), which records every reference that resolves to no binding as a program-level global.
     A few seconds for the whole of src/, JSX included. What is left after subtracting real browser and
     JS globals is a name the code expects to exist and does not.
   ⚠ LOADED DYNAMICALLY, WARN AND EXIT 0 IF MISSING — same rule as screens-check: a build gate must never
     fail a deploy of a working app because a tool could not load.
   ══════════════════════════════════════════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SRC = path.join(ROOT, 'src');

let parse, traverse;
try {
  ({ parse } = await import('@babel/parser'));
  const t = await import('@babel/traverse');
  traverse = t.default && t.default.default ? t.default.default : (t.default || t);
} catch (e) {
  console.warn(`  ⚠ globals-check skipped — could not load @babel/parser / @babel/traverse (${e.message})`);
  process.exit(0);
}

/* Names that genuinely exist at runtime without a declaration: everything on the JS global object, plus
   the browser and Vite globals this app uses. ⚠ KEEP THIS LIST SHORT AND LITERAL — adding a name here to
   silence a report is exactly how the next "is not defined" ships. */
const BROWSER = [
  'window', 'document', 'navigator', 'location', 'history', 'localStorage', 'sessionStorage', 'fetch',
  'Request', 'Response', 'Headers', 'FormData', 'Blob', 'File', 'FileReader', 'URL', 'URLSearchParams',
  'Image', 'Audio', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent',
  'getComputedStyle', 'matchMedia', 'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback',
  'cancelIdleCallback', 'alert', 'confirm', 'prompt', 'open', 'close', 'print', 'scrollTo', 'screen',
  'innerWidth', 'innerHeight', 'devicePixelRatio', 'performance', 'crypto', 'IntersectionObserver',
  'ResizeObserver', 'MutationObserver', 'BroadcastChannel', 'Worker', 'indexedDB', 'caches', 'self',
  'DOMParser', 'XMLSerializer', 'TextEncoder', 'TextDecoder', 'AbortController', 'AbortSignal',
  'CSS', 'ClipboardItem', 'Notification', 'visualViewport', 'origin', 'btoa', 'atob', 'structuredClone',
  'queueMicrotask', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'console',
  'HTMLCanvasElement', 'CanvasRenderingContext2D', 'Path2D', 'SVGElement', 'DOMRect', 'PointerEvent',
  'TouchEvent', 'WheelEvent', 'FocusEvent', 'InputEvent', 'ClipboardEvent', 'DataTransfer', 'EventSource',
  'WebSocket', 'XMLHttpRequest', 'Intl', 'process', 'import', 'undefined', 'arguments', 'globalThis',
];
const ALLOWED = new Set([...Object.getOwnPropertyNames(globalThis), ...BROWSER]);

const files = [];
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
  const f = path.join(d, e.name);
  if (e.isDirectory()) walk(f);
  else if (/\.(jsx?|mjs)$/.test(e.name)) files.push(f);
});
walk(SRC);

let bad = 0;
for (const file of files.sort()) {
  let ast;
  try {
    ast = parse(fs.readFileSync(file, 'utf8'), { sourceType: 'module', plugins: ['jsx'], errorRecovery: false });
  } catch (e) {
    console.error(`  ✖ ${path.relative(ROOT, file)} does not parse: ${e.message}`);
    bad++; continue;
  }
  const found = new Map();
  traverse(ast, {
    /* ⚠ ReferencedIdentifier covers plain identifiers AND JSX names (<Foo />), and skips property keys,
       member properties and declarations — so `obj.injuries` and `{ injuries: x }` are not reports. */
    ReferencedIdentifier(p) {
      const name = p.node.name;
      if (!name || ALLOWED.has(name)) return;
      if (p.isJSXIdentifier() && /^[a-z]/.test(name)) return;          // <div>, <span>: intrinsic elements
      if (p.scope.hasBinding(name, true)) return;
      /* `typeof x` on an undeclared name is the one legal read — it is how feature detection works. */
      if (p.parentPath && p.parentPath.isUnaryExpression({ operator: 'typeof' })) return;
      if (!found.has(name)) found.set(name, p.node.loc ? p.node.loc.start.line : 0);
    },
  });
  if (found.size) {
    bad += found.size;
    console.error(`  ✖ ${path.relative(ROOT, file)} uses ${found.size} name${found.size === 1 ? '' : 's'} that nothing declares:`);
    for (const [n, line] of [...found].sort((a, b) => a[1] - b[1])) console.error(`      ${n}   (line ${line})`);
  } else {
    console.log(`  ✓ ${path.relative(ROOT, file)}`);
  }
}

if (bad) {
  console.error('\n  A name that nothing declares builds CLEAN and throws the moment its line runs — which is how');
  console.error('  "injuries is not defined" took the home page down in 29bc. Declare it, import it, or pass it');
  console.error('  in as a prop. Do not add it to the allow-list unless it is genuinely a browser global.');
  process.exit(1);
}
console.log(`  ✓ no undeclared names across ${files.length} source files`);
