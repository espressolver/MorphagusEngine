import { chromium } from 'playwright';
const url = process.argv[2] || 'http://localhost:5173/?map=Lev_Tut1';
const out = process.argv[3] || (await import('os')).tmpdir() + '/shot.png';
const wait = +process.argv[4] || 20000;
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on('console', m => logs.push(m.type() + ': ' + m.text())); page.on('response', r => { if (r.status() >= 400) logs.push('HTTP ' + r.status() + ' ' + r.url()); });
page.on('pageerror', e => logs.push('PAGEERROR: ' + e.stack));
await page.goto(url);
const t0 = Date.now();
while (Date.now() - t0 < wait) {
  const hidden = await page.evaluate(() => document.getElementById('loading').style.display === 'none' || document.getElementById('loadtext').textContent.startsWith('Error'));
  if (hidden) break;
  await page.waitForTimeout(500);
}
if (process.argv[5]) await page.evaluate(process.argv[5]);
await page.waitForTimeout(+process.env.WAIT || 1500);
await page.screenshot({ path: out });
console.log((process.env.ALL ? logs : logs.slice(-30)).join('\n'));
console.log('hud:', await page.evaluate(() => document.getElementById('hud').textContent + ' | ' + document.getElementById('loadtext').textContent));
await browser.close();
