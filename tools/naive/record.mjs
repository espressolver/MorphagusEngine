// Record the naive (input-only) playthrough of one map as a video using the real browser renderer.
// usage: node tools/naive/record.mjs Lev_Tut1 out.webm [framesPerRender]
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';

const [map = 'Lev_Tut1', out = 'naive.webm', fpr = '2'] = process.argv.slice(2);
const dir = path.join(path.dirname(path.resolve(out)), 'video-tmp-' + Date.now());
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir, size: { width: 1280, height: 720 } } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { const t = m.text(); if (t.startsWith('[bot]')) console.log(t.slice(6)); });
await page.goto(`http://localhost:5173/?map=${map}`);
await page.waitForFunction(() => window.__engine?.player && document.getElementById('loading').style.display === 'none', null, { timeout: 120000 });
await page.evaluate(async ([m, n, v]) => { const mod = await import('/tools/naive/browser.mjs'); mod.start(window.__engine, m, { framesPerRender: n, verbose: v }); }, [map, +fpr, !!process.env.V]);
const t0 = Date.now();
await page.waitForFunction(() => window.__botDone, null, { timeout: 0, polling: 1000 });
await page.waitForTimeout(4000); // show the level change
const done = await page.evaluate(() => window.__botDone);
console.log('done', JSON.stringify(done).slice(0, 300), 'real', ((Date.now() - t0) / 1000).toFixed(0) + 's', errors.length ? 'page errors: ' + errors.slice(0, 3).join(' | ') : '');
const video = page.video();
await ctx.close();
fs.renameSync(await video.path(), out);
fs.rmSync(dir, { recursive: true, force: true });
await browser.close();
console.log('saved', out);
