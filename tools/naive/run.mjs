// Naive playthrough: complete the game using only keyboard/mouse input (god mode on).
// Each map is a list of steps a player would do; the bot plans routes from the level geometry.
// usage: node tools/naive/run.mjs [firstMap] [lastMap]
// deterministic runs: the game's FRand/Rand go through Math.random (seed with SEED=n)
{
  let x = (+process.env.SEED || 12345) >>> 0;
  Math.random = () => { x = (x + 0x6D2B79F5) >>> 0; let t = x; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
import fs from 'fs';
import os from 'os';
import path from 'path';
import { engine } from '../../tests/helpers.mjs';
import { Bot, run } from './bot.mjs';
import { CHAIN } from './steps.mjs';
import { playSteps, norm } from './play.mjs';

export async function playMap(map, travel, log = console.log) {
  const eng = await engine(map, { travel });
  const bot = new Bot(eng, { log: s => log('    ' + s.trim()) });
  bot.verbose = !!process.env.V;
  const { steps } = run(playSteps(eng, bot, map, log));
  const snapshot = eng.debug.snapshot({ focus: null });
  eng.restoreConsole();
  return {
    map, steps,
    next: eng.pendingTravel ? norm(eng.pendingTravel.map) : null,
    travel: eng.pendingTravel?.travel || eng.exportTravel(),
    issues: [...new Set(eng.issues)],
    simTime: Math.round(bot.time),
    snapshot,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const first = Math.max(0, CHAIN.findIndex(m => norm(m) === norm(process.argv[2] || CHAIN[0])));
  const last = process.argv[3] ? CHAIN.findIndex(m => norm(m) === norm(process.argv[3])) : CHAIN.length - 2;
  let travel = null;
  for (let i = first; i <= last; i++) {
    const t0 = Date.now();
    console.log(`== ${CHAIN[i]}`);
    const r = await playMap(CHAIN[i], travel);
    const ok = r.next === norm(CHAIN[i + 1]);
    console.log(`${ok ? 'PASS' : 'FAIL'} ${CHAIN[i]} -> ${r.next ?? '(no level change)'} (expected ${norm(CHAIN[i + 1])}) sim ${r.simTime}s real ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    for (const s of r.issues.slice(0, 5)) console.log('   issue: ' + s);
    if (!ok) {
      process.exitCode = 1;
      // where it ended up: map, player, nearby actors, the issue log (debug.js snapshot)
      const file = path.join(os.tmpdir(), `hpdebug_${CHAIN[i]}.json`);
      fs.writeFileSync(file, JSON.stringify(r.snapshot, null, 1));
      console.log('   debug snapshot: ' + file);
    }
    if (!ok && !process.env.KEEP_GOING) break;
    travel = r.travel;
  }
}
