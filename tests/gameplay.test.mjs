// Headless gameplay tests: movement, jumping, casting, spell lessons, save/load, travel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engine, tick, skipCutscenes } from './helpers.mjs';

const speed = p => Math.hypot(p.Velocity.X, p.Velocity.Y);

async function tut1() {
  const eng = await engine('Lev_Tut1');
  skipCutscenes(eng, 60);
  tick(eng, 0.5);
  return eng;
}

test('walking reaches GroundSpeed with a run animation and stays on the floor', async () => {
  const eng = await tut1(), p = eng.player;
  eng.keyEvent('Up', 'press');
  let peak = 0;
  tick(eng, 1.5, 1 / 30, () => { peak = Math.max(peak, speed(p)); });
  assert.ok(Math.abs(peak - p.GroundSpeed) < 5, 'speed ' + peak);
  assert.match(String(p.AnimSequence), /run|walk/i);
  assert.equal(p.Physics, 1); // PHYS_Walking
  eng.keyEvent('Up', 'release');
  tick(eng, 0.5);
  assert.ok(speed(p) < 5, 'nearly stopped after 0.5s (friction decay, no braking)');
  tick(eng, 0.5);
  assert.ok(speed(p) < 1, 'stopped after 1s');
  // standing on a floor: no floating, no sinking (he may have walked up the stairs ahead)
  const f = eng.level.physics.traceShape(p, p.Location, { ...p.Location, Z: p.Location.Z - 10 });
  assert.ok(f, 'floor under Harry');
  assert.ok(f.t * 10 < 3, 'feet on the floor (gap ' + (f.t * 10).toFixed(2) + ')');
  eng.restoreConsole();
  assert.deepEqual(eng.issues, []);
});

for (const key of ['Space', 'Ctrl']) {
  test(`jump with ${key} leaves the ground and lands`, async () => {
    const eng = await tut1(), p = eng.player;
    const z0 = p.Location.Z;
    eng.keyEvent(key, 'press'); tick(eng, 0.05); eng.keyEvent(key, 'release');
    let peak = z0, fell = false;
    tick(eng, 2, 1 / 30, () => { peak = Math.max(peak, p.Location.Z); if (p.Physics === 2) fell = true; });
    assert.ok(fell, 'entered PHYS_Falling');
    assert.ok(peak - z0 > 20, 'jump height ' + (peak - z0));
    assert.equal(p.Physics, 1, 'landed');
    assert.ok(Math.abs(p.Location.Z - z0) < 2, 'lands at same height');
    eng.restoreConsole();
  });
}

test('casting with no learned spell plays the cast and returns to normal', async () => {
  const eng = await tut1(), p = eng.player;
  const st0 = p.__state?.name;
  eng.keyEvent('LeftMouse', 'press'); tick(eng, 0.6); eng.keyEvent('LeftMouse', 'release');
  tick(eng, 2);
  assert.equal(p.__state?.name, st0);
  eng.restoreConsole();
  assert.deepEqual(eng.issues, []);
});

test('Flipendo lesson can be passed by tracing the pattern', async () => {
  const eng = await tut1(), p = eng.player, vm = eng.vm, L = eng.level;
  const t = L.actors.find(a => a.Class.name === 'SpellLearnTrigger');
  vm.event(t, 'Trigger', p, p);
  let held = false, idx = 0, maxLevel = 0;
  tick(eng, 200, 1 / 60, () => {
    maxLevel = Math.max(maxLevel, t.LessonLevel || 0);
    if (t.__state?.name === 'Draw') {
      // follow the pattern densely (the lesson scores coverage of every in-between point too)
      const raw = t.SpellGesture.Points.filter(x => x), pts = [];
      raw.forEach((q, k) => { pts.push(q); const n = raw[k + 1]; if (n) for (let j = 1; j < 8; j++) pts.push({ X: q.X + (n.X - q.X) * j / 8, Y: q.Y + (n.Y - q.Y) * j / 8 }); });
      const tgt = pts[Math.min(pts.length - 1, idx)];
      const dx = tgt.X - (t.WandX + 0.5), dy = tgt.Y - (0.5 - t.WandY);
      if (Math.hypot(dx, dy) < 0.015) idx++;
      if (!held) { eng.keyEvent('LeftMouse', 'press'); held = true; }
      eng.mouse.dx += Math.max(-25, Math.min(25, dx * 900));
      eng.mouse.dy += Math.max(-25, Math.min(25, dy * 900));
    } else if (held) { eng.keyEvent('LeftMouse', 'release'); held = false; idx = 0; }
  });
  assert.ok((p.Weapon.spellList || []).some(s => s && /flip/i.test(s.name)), 'learned flipendo');
  assert.ok(maxLevel >= 4, 'passed all lesson rounds, reached ' + maxLevel);
  assert.equal(p.__state?.name === 'SpellLearning', false, 'lesson finished');
  eng.restoreConsole();
});

test('save game round-trips player state and removed pickups', async () => {
  const eng = await tut1(), p = eng.player, L = eng.level;
  p.numBeans = 17;
  const bean = L.actors.find(a => /JellyBean/.test(a.Class.name));
  bean.bStatic = false; bean.bNoDelete = false; L.destroy(bean); L.cleanupDestroyed();
  const loc = { ...p.Location };
  eng.exec('SaveGame 1');
  eng.travel('save1.usa');
  const t = eng.pendingTravel; eng.pendingTravel = null;
  await eng.loadMap(t.map, '', t.travel);
  eng.restoreSave(t.restore);
  const p2 = eng.player;
  assert.equal(p2.numBeans, 17);
  assert.ok(Math.hypot(p2.Location.X - loc.X, p2.Location.Y - loc.Y) < 1);
  assert.ok(!eng.level.actors.some(a => a.Name === bean.Name && !a.__deleted));
  tick(eng, 1);
  assert.equal(p2.Physics, 1);
  eng.restoreConsole();
});

test('save game keeps spawned actors and state code positions (Lev_Tut1b: two gnomes stunned, then the third)', async () => {
  const eng = await engine('Lev_Tut1b');
  tick(eng, 1); skipCutscenes(eng); eng.restoreConsole?.();
  const vm = eng.vm, by = n => eng.level.actors.find(a => a.Name === n && !a.__deleted);
  eng.level.physics.farMoveActor(eng.player, { X: -3650, Y: -3990, Z: 970 });
  vm.event(by('Dispatcher14'), 'Trigger', eng.player, eng.player);
  tick(eng, 2);
  const hit = g => { const s = eng.level.spawn(vm.cls('spellFlip'), eng.player, null, { ...eng.player.Location }, eng.player.Rotation); s.Instigator = eng.player; vm.invoke(vm.findFunction(g, 'takespelleffect'), g, [s]); };
  hit(by('Tut1Gnome0')); hit(by('tut1gnome1'));
  tick(eng, 3);
  // a spawned actor and a sleeping state code position
  const marker = eng.level.spawn(vm.cls('JellyBean') || vm.cls('BlueJellyBean'), null, null, { X: -3600, Y: -3990, Z: 960 }, null);
  const g0 = by('Tut1Gnome0'), frame = g0.__stateFrame && { ...g0.__stateFrame }, latent = g0.__latent && { ...g0.__latent };
  const count = eng.level.actors.filter(a => !a.__deleted).length;
  const beganStunned = [];
  const ov = vm.event.bind(vm);
  vm.invoke(vm.findFunction(eng.console, 'dolevelsave'), eng.console, [4]);
  eng.travel('save4.usa');
  const t = eng.pendingTravel; eng.pendingTravel = null;
  await eng.loadMap(t.map, '', t.travel);
  vm.event = (a, n, ...x) => { if (/^(beginstate|postbeginplay)$/i.test(n) && /gnome/i.test(a.Class.name)) beganStunned.push(a.Name + ':' + n); return ov(a, n, ...x); };
  eng.restoreSave(t.restore);
  vm.event = ov;
  assert.equal(eng.level.actors.filter(a => !a.__deleted).length, count, 'same actors');
  assert.ok(marker && by(marker.Name), 'the spawned bean is back');
  assert.deepEqual(['Tut1Gnome0', 'tut1gnome1'].map(n => by(n).__state?.name), ['stunned', 'stunned']);
  assert.equal(by('Counter3').NumToCount, 1);
  const g0b = by('Tut1Gnome0');
  assert.equal(g0b.__stateFrame?.pc, frame?.pc, 'state code resumes where it was');
  assert.equal(g0b.__latent?.kind, latent?.kind);
  assert.deepEqual(beganStunned, [], 'no state re-entered');
  hit(by('tut1gnome2'));
  tick(eng, 4);
  assert.equal(by('Counter3').NumToCount, 0);
  assert.equal(by('Mover62').KeyNum, 1, 'the exit doors open');
  eng.restoreConsole?.();
});

test('door mode: typing alohomora toggles it, then a cast opens the aimed door group (Lev_Tut1b exit doors)', async () => {
  const eng = await engine('Lev_Tut1b');
  tick(eng, 1); skipCutscenes(eng); eng.restoreConsole?.();
  const L = eng.level, p = eng.player, by = n => L.actors.find(a => a.Name === n);
  const place = () => { L.physics.farMoveActor(p, { X: -3760, Y: -3990, Z: 970 }); p.Rotation = { ...p.Rotation, Yaw: 32768 }; p.ViewRotation = { ...p.ViewRotation, Yaw: 32768, Pitch: 0 }; tick(eng, 0.5); };
  const cast = () => { eng.keyEvent('LeftMouse', 'press'); tick(eng, 0.6); eng.keyEvent('LeftMouse', 'release'); tick(eng, 3); };
  const type = w => { for (const c of w) { eng.keyEvent(c.toUpperCase(), 'press'); eng.keyEvent(c.toUpperCase(), 'release'); } };
  place(); cast();
  assert.deepEqual([by('Mover62').KeyNum, by('Mover63').KeyNum], [0, 0], 'a plain cast leaves the locked doors');
  type('alohomora');
  assert.equal(eng.doorMode, true);
  place(); cast();
  assert.deepEqual([by('Mover62').KeyNum, by('Mover63').KeyNum], [1, 1], 'both doors of the pair open');
  // a portcullis (rising bars) seen from the front
  const gate = by('Mover51'), z0 = gate.Location.Z;
  L.physics.farMoveActor(p, { X: 0, Y: -7720, Z: 546 });
  p.Rotation = { ...p.Rotation, Yaw: -16384 }; p.ViewRotation = { ...p.ViewRotation, Yaw: -16384, Pitch: 0 };
  tick(eng, 0.5); cast();
  assert.equal(Math.round(gate.Location.Z - z0), 192, 'the gate rose');
  // a gate the game drops shut (Mover15, by Counter2) behind a pair of doors: the first cast opens the doors
  // in the way, the next raises the gate (raised, it is hidden in the wall above the doorway)
  const m15 = by('Mover15');
  eng.vm.event(m15, 'Trigger', p, p); tick(eng, 3);
  L.physics.farMoveActor(p, { X: -1728, Y: -9070, Z: 420 });
  p.Rotation = { ...p.Rotation, Yaw: 16384 }; p.ViewRotation = { ...p.ViewRotation, Yaw: 16384, Pitch: 0 };
  tick(eng, 0.5);
  assert.equal(m15.KeyNum, 1, 'dropped');
  cast();
  assert.deepEqual([by('Mover0').KeyNum, by('Mover6').KeyNum, m15.KeyNum], [1, 1, 1], 'the doors in front first');
  cast();
  assert.equal(m15.KeyNum, 0, 'then the gate goes back up');
  type('alohomora');
  assert.equal(eng.doorMode, false, 'typing it again turns the mode off');
  eng.restoreConsole?.();
});

test('TriggerChangeLevel carries travel items to the next map', async () => {
  const eng = await engine('Lev2_Inc_B');
  const t = eng.level.actors.find(a => a.Class.isA('TriggerChangeLevel'));
  eng.player.numBeans = 42;
  eng.vm.event(t, 'Trigger', eng.player, eng.player);
  assert.ok(tick(eng, 2), 'travel requested');
  const pt = eng.pendingTravel;
  assert.equal(pt.map.toLowerCase(), String(t.NewMapName).toLowerCase().replace(/\.unr$/, ''));
  const eng2 = await engine(pt.map, { travel: pt.travel });
  assert.equal(eng2.player.numBeans, 42);
  eng.restoreConsole(); eng2.restoreConsole();
});

test('Destroyed() runs when an actor is destroyed', async () => {
  const eng = await engine('Lev_Tut1');
  const L = eng.level, vm = eng.vm;
  const a = L.spawn(vm.cls('SpellWand'), null, null, { ...eng.player.Location });
  let called = false;
  const f = vm.findFunction(a, 'destroyed');
  const orig = vm.invoke.bind(vm);
  vm.invoke = (fn, self, args) => { if (self === a && fn === f) called = true; return orig(fn, self, args); };
  L.destroy(a);
  vm.invoke = orig;
  eng.restoreConsole();
  assert.ok(f, 'wand has Destroyed');
  assert.ok(called, 'Destroyed event fired');
  assert.ok(a.__deleted);
});

test('walking into a wall stops the pawn (velocity follows actual movement)', async () => {
  const eng = await tut1(), p = eng.player;
  eng.keyEvent('Up', 'press');
  let minV = Infinity;
  tick(eng, 12, 1 / 30, () => { minV = Math.min(minV, speed(p)); });
  eng.keyEvent('Up', 'release');
  eng.restoreConsole();
  // running forward for 12s in the tutorial room must hit a wall at some point
  assert.ok(minV < 50, 'min speed ' + minV);
});

test('BonePos follows the skeleton (Fluffy heads sit at their neck bones)', async () => {
  const eng = await engine('Lev5_Fluffy');
  tick(eng, 1);
  eng.restoreConsole();
  const f = eng.level.actors.find(a => a.Class.name === 'Fluffy');
  const hs = f.Heads.map(h => h.Location);
  for (const h of hs) assert.ok(Math.hypot(h.X - f.Location.X, h.Y - f.Location.Y) > 50, 'head away from body origin');
  assert.ok(Math.hypot(hs[0].X - hs[2].X, hs[0].Y - hs[2].Y) > 60, 'left and right heads apart');
});

// place Harry (diagnostic setup for focused physics tests)
async function placed(map, x, y, floorZ, yaw) {
  const eng = await engine(map);
  skipCutscenes(eng, 60); tick(eng, 0.5);
  const p = eng.player, L = eng.level;
  const put = () => { L.physics.setLocation(p, { X: x, Y: y, Z: floorZ + p.CollisionHeight + 2 }); p.Rotation = { ...p.Rotation, Yaw: yaw }; p.ViewRotation = { ...p.ViewRotation, Yaw: yaw }; };
  put(); tick(eng, 0.3); skipCutscenes(eng, 60); put(); tick(eng, 0.2);
  return eng;
}

test('running into a climbable (PF_SpecialPoly) ledge mounts it with root motion', async () => {
  const eng = await placed('Lev_Tut1', -100, -4230, 48, 49152), p = eng.player;
  let states = new Set();
  eng.keyEvent('Up', 'press');
  tick(eng, 4, 1 / 30, () => states.add(p.__state?.name));
  eng.keyEvent('Up', 'release');
  eng.restoreConsole();
  assert.ok(states.has('Mounting') && states.has('MountFinish'), [...states].join(','));
  assert.ok(p.Location.Z - p.CollisionHeight > 140, 'on top of the 92-unit block: feet ' + (p.Location.Z - p.CollisionHeight));
});

test('ledges that are not flagged climbable are not mounted', async () => {
  const eng = await placed('Lev_Tut1', 1760, -3638, 304, 0), p = eng.player;
  let mounted = false;
  eng.keyEvent('Up', 'press');
  tick(eng, 2, 1 / 30, () => { if (/Mount/.test(p.__state?.name || '')) mounted = true; });
  eng.keyEvent('Up', 'release');
  eng.restoreConsole();
  assert.equal(mounted, false);
});

test('jump apex matches JumpZ^2 / 2g (UE1 average-velocity integration)', async () => {
  const eng = await tut1(), p = eng.player;
  const g = Math.abs(eng.level.physics.zoneOf(p).ZoneGravity?.Z || 950);
  const feet0 = p.Location.Z - p.CollisionHeight;
  let peak = feet0;
  eng.keyEvent('Space', 'press'); tick(eng, 0.05); eng.keyEvent('Space', 'release');
  tick(eng, 2, 1 / 30, () => { peak = Math.max(peak, p.Location.Z - p.CollisionHeight); });
  eng.restoreConsole();
  const expect = p.JumpZ * p.JumpZ / (2 * g);
  assert.ok(Math.abs(peak - feet0 - expect) < 2, `apex ${(peak - feet0).toFixed(1)} vs ${expect.toFixed(1)}`);
});

test('OldLocation is the start of the last physics step', async () => {
  const eng = await tut1(), p = eng.player;
  eng.keyEvent('Up', 'press'); tick(eng, 0.5);
  const moved = Math.hypot(p.Location.X - p.OldLocation.X, p.Location.Y - p.OldLocation.Y);
  eng.keyEvent('Up', 'release');
  eng.restoreConsole();
  assert.ok(moved > 2 && moved < 15, 'per-frame displacement ' + moved);
});

test('CT_Box blockers are oriented boxes: the grand staircase between the rails is walkable', async () => {
  const eng = await placed('Lev_Tut1', -700, -1300, -336, 49152), p = eng.player;
  const z0 = p.Location.Z;
  eng.keyEvent('Up', 'press'); tick(eng, 2); eng.keyEvent('Up', 'release');
  eng.restoreConsole();
  assert.ok(p.Location.Z - z0 > 100, 'climbed the stairs by ' + (p.Location.Z - z0));
});
