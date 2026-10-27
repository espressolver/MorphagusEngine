// Smoke test: every map loads, the player spawns, and 15 seconds of play run without script/engine errors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assets, engine, tick } from './helpers.mjs';

const maps = (await assets()).manifest.filter(f => f.startsWith('Maps/')).map(f => f.slice(5, -4));
for (const map of maps) {
  test(`map ${map} runs`, async () => {
    const eng = await engine(map);
    assert.ok(eng.player, 'player spawned');
    tick(eng, 15);
    eng.restoreConsole();
    if (!eng.pendingTravel) assert.ok(eng.player.Location && Number.isFinite(eng.player.Location.Z), 'finite location');
    assert.deepEqual([...new Set(eng.issues)].filter(s => !/no state (CutIdle in Harry|Idle in H2Sprout)|pointer/i.test(s)), []);
  });
}
