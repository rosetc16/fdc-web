import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await b.newPage({ viewport: { width: 1500, height: 1000 } });
await page.goto('http://localhost:4174/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4500);
console.log(await page.evaluate(() => Array.from(document.querySelectorAll('button,[role="button"],a')).map(e=>(e.innerText||'').replace(/\n/g,' / ').slice(0,70)).filter(Boolean)));
await b.close();
