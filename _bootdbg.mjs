import { chromium } from 'playwright';
const TEAMS=12, ROUNDS=16, SLOT=8;
const lastRoundO = 15*TEAMS + (TEAMS-SLOT);
const CFG={name:'Pierogi Punishers',teams:TEAMS,rounds:ROUNDS,type:'redraft',order:'snake',slot:SLOT,sf:false,tePremMult:0,
  start:{QB:1,RB:2,WR:2,TE:1,FLEX:1,SUPER:0,K:1,DST:1},scoring:{rec:1},caps:{},keepers:[],
  pickTrades:[{o:lastRoundO,to:(SLOT%TEAMS),round:16}]};
const picks = Array.from({length: 14*TEAMS + (TEAMS-SLOT)}, (_,i)=>i);
const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'});
const page=await b.newPage({viewport:{width:1600,height:1050}});
page.on('pageerror',e=>console.log('PAGEERROR',String(e).slice(0,160)));
await page.goto('http://localhost:4173/',{waitUntil:'domcontentloaded'});
await page.evaluate(()=>{localStorage.clear();sessionStorage.clear();});
const lg={id:'L1',name:CFG.name,created:'x',cfg:CFG,picks,preds:[],mocks:[]};
await fetch('http://localhost:5056/api/state',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({state:{leagues:[lg],funMocks:[],feedback:[]}})}).catch(()=>{});
await page.evaluate(l=>{localStorage.clear();localStorage.setItem('fdc:token','t');localStorage.setItem('fdcTourSeen','1');
  localStorage.setItem('fdc:gs-state',JSON.stringify({user:{email:'t@x.com',paid:true,rankSets:[]},leagues:[l],funMocks:[]}));
  sessionStorage.setItem('gs-nav',JSON.stringify({route:'draft',activeId:'L1',hubLeagueId:null}));},lg);
await page.reload({waitUntil:'domcontentloaded'});
for (const ms of [300,900,2000,4000]) {
  await page.waitForTimeout(ms===300?300:ms-(ms===900?300:ms===2000?900:2000));
  const st=await page.evaluate(()=>{
    const t=document.body.innerText||'';
    const raw=JSON.parse(localStorage.getItem('fdc:gs-state')||'{}');
    const l=(raw.leagues||[])[0]||{};
    return {round:(t.match(/ROUND\s+\d+\s+of\s+\d+/i)||[])[0]||null, storedPicks:(l.picks||[]).filter(x=>x!=null).length, splash:/Charting your board/i.test(t)};
  });
  console.log(ms+'ms', JSON.stringify(st));
}
await b.close();
