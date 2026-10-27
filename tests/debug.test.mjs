// Debug log / snapshot (src/game/engine/debug.js)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engine, tick, skipCutscenes } from './helpers.mjs';

test('script issues are logged with map, time and the object running script; snapshots describe the scene', async () => {
  const e = await engine('Lev_Tut1');
  skipCutscenes(e, 30); tick(e, 0.5);
  const t = e.level.spawn(e.vm.cls('Trigger'), null, null, { ...e.player.Location, X: e.player.Location.X + 50 });
  e.vm.curSelf = t;
  e.vm.warnOnce('test-key', 'Accessed None in Trigger.Touch', '(Foo)');
  e.vm.curSelf = null;
  const rec = e.debug.issues.at(-1);
  assert.equal(rec.map, 'Lev_Tut1');
  assert.equal(rec.object.name, t.Name);
  assert.ok(rec.object.loc && rec.player);
  const snap = e.debug.snapshot({ view: { loc: e.player.Location, rot: e.player.Rotation, actor: e.player } });
  assert.equal(snap.map, 'Lev_Tut1');
  assert.ok(snap.reproduce.includes('pos='));
  assert.ok(snap.nearby.some(n => n.name === t.Name), 'the trigger is listed nearby');
  assert.ok(snap.issues.length > 0 && snap.issueTotals.total >= 1);
  const d = e.debug.describeActor(t);
  assert.equal(d.class, 'Trigger');
  assert.ok('CollisionRadius' in d.props);
  e.restoreConsole();
});
