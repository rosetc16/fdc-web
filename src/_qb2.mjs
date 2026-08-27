import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const base = { teams: 12, rounds: 15, type: 'redraft', order: 'snake', slot: 6, tePremMult: 0, scoring:{rec:1}, caps:{}, keepers:[], pickTrades:[] };
const S = (o) => ({ QB:1, RB:2, WR:2, TE:1, FLEX:1, SUPER:0, K:0, DST:0, ...o });
for (const [label, cfg] of [
  ['1QB', { ...base, name:'A', sf:false, start:S({}) }],
  ['2QB', { ...base, name:'C', sf:true,  start:S({ QB:2 }) }],
]) {
  const page = await b.newPage({ viewport: { width: 1700, height: 1000 } });
  await page.goto('http://localhost:4174/', { waitUntil: 'domcontentloaded' });
  await page.evaluate((c) => { localStorage.clear(); localStorage.setItem('fdc:token','t');
    localStorage.setItem('fdc:gs-state', JSON.stringify({ user:{email:'t@x.com',paid:true,rankSets:[]}, leagues:[{id:'L1',name:c.name,created:'x',cfg:c,picks:[],preds:[],mocks:[]}], funMocks:[] }));
    sessionStorage.setItem('gs-nav', JSON.stringify({route:'draft',activeId:'L1',hubLeagueId:null})); }, cfg);
  await page.reload({waitUntil:'domcontentloaded'});
  await page.waitForSelector('table.board tbody tr td.frz',{timeout:60000});
  await page.evaluate(()=>{const d=Array.from(document.querySelectorAll('button')).find(e=>/Dismiss/.test(e.innerText||'')); if(d)d.click();});
  await page.waitForTimeout(1500);
  const ver = await page.evaluate(()=>((document.body.innerText.match(/v20\d\d\.[\d.]+\w*/)||[''])[0]));
  await page.evaluate(() => { const btn = Array.from(document.querySelectorAll('button')).find(x => (x.innerText||'').trim() === 'QB'); if (btn) btn.click(); });
  await page.waitForTimeout(1500);
  const rows = await page.evaluate(() => {
    const heads = Array.from(document.querySelectorAll('table.board thead tr')).pop();
    const cols = Array.from(heads.children).map(h => (h.innerText||'').trim());
    const gi = (re) => cols.findIndex(c => re.test(c));
    const vi = gi(/^VBD$/i), pi = gi(/^Proj$/i);
    const out = [];
    for (const r of document.querySelectorAll('table.board tbody tr')) {
      const frz = r.querySelector('td.frz'); if (!frz) continue;
      const t = (frz.innerText||'').replace(/\s+/g,' ').trim();
      const m = t.match(/\bQB\b\s+([A-Za-z'.\-]+(?: [A-Za-z'.\-]+)*?)\s+[A-Z]{2,3}\b/);
      if (!m) continue;
      const tds = r.querySelectorAll('td');
      out.push({ n:m[1], proj: (tds[pi]||{}).innerText, vbd: (tds[vi]||{}).innerText });
    }
    return { cols, out };
  });
  console.log(`\n== ${label} == build ${ver} · cols[VBD,Proj] present: ${rows.cols.filter(c=>/VBD|Proj/i.test(c)).join(',')}`);
  console.log(rows.out.slice(0,30).map(q=>`  ${q.n.padEnd(20)} proj ${q.proj}  vbd ${q.vbd}`).join('\n'));
  console.log('  rows:', rows.out.length);
  await page.close();
}
await b.close();
