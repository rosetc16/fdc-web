import fs from 'node:fs';
import { Parser } from 'acorn';
import jsx from 'acorn-jsx';
const P = Parser.extend(jsx());
const FILES = ['src/App.jsx','src/screens/GameDay.jsx','src/screens/MyWeek.jsx','src/screens/TradeCenter.jsx'];
for (const f of FILES) {
  const src = fs.readFileSync(f,'utf8');
  const ast = P.parse(src,{ecmaVersion:'latest',sourceType:'module',locations:true});
  const used=new Set();
  const cj=(n)=>{if(!n||typeof n.type!=='string')return;
    if(n.type==='JSXOpeningElement'&&n.name&&n.name.type==='JSXIdentifier'&&/^[A-Z]/.test(n.name.name))used.add(n.name.name);
    for(const k in n){if(k==='loc'||k==='start'||k==='end')continue;const v=n[k];
      if(Array.isArray(v))v.forEach(cj);else if(v&&typeof v.type==='string')cj(v);}};
  cj(ast);
  const out=[];
  const walk=(n,d)=>{if(!n||typeof n.type!=='string')return;
    const isFn=/FunctionDeclaration|FunctionExpression|ArrowFunctionExpression/.test(n.type);
    if(d>0&&n.type==='VariableDeclarator'&&n.id&&n.id.type==='Identifier'&&/^[A-Z]/.test(n.id.name)
      &&n.init&&/FunctionExpression|ArrowFunctionExpression/.test(n.init.type)&&used.has(n.id.name))
      out.push([n.id.name,n.loc.start.line]);
    if(d>0&&n.type==='FunctionDeclaration'&&n.id&&/^[A-Z]/.test(n.id.name)&&used.has(n.id.name))
      out.push([n.id.name,n.loc.start.line]);
    for(const k in n){if(k==='loc'||k==='start'||k==='end')continue;const v=n[k];
      if(Array.isArray(v))v.forEach(c=>walk(c,d+(isFn?1:0)));else if(v&&typeof v.type==='string')walk(v,d+(isFn?1:0));}};
  walk(ast,0);
  out.sort((a,b)=>a[1]-b[1]).forEach(([n,l])=>console.log(`${f}:${l}  ${n}`));
}
