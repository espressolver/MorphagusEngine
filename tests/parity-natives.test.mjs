// Parity tests: Actor / Pawn natives (UnScript.cpp, UnPawn.cpp, UnLevAct.cpp line checks) against the
// reference rules (see docs/engine-parity.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engine, tick, skipCutscenes } from './helpers.mjs';

let shared;
const setup = async () => {
  if (!shared) { shared = await engine('Lev_Tut1'); skipCutscenes(shared, 60); tick(shared, 0.5); shared.restoreConsole(); }
  return shared;
};
const ref = v => ({ __ref: true, v, get() { return this.v; }, set(x) { this.v = x; } });
const spawnT = (e, dx, dy = 0, r = 20, h = 40) => {
  const p = e.player, t = e.level.spawn(e.vm.cls('Trigger'), null, null, { X: p.Location.X + dx, Y: p.Location.Y + dy, Z: p.Location.Z });
  t.CollisionRadius = r; t.CollisionHeight = h;
  return t;
};
const nat = (e, i, self, ...args) => e.vm.natives.get(i)(self, args);
const drain = g => [...g];

test('Trace: level/movers only by default for non-colliding tracers; actors when asked; never the tracer or its owners', async () => {
  const e = await setup(), p = e.player;
  const t = spawnT(e, 100);
  t.bBlockActors = false; t.bBlockPlayers = false;
  const hl = ref(null), hn = ref(null), end = { ...p.Location, X: p.Location.X + 200 };
  assert.equal(nat(e, 277, p, hl, hn, end, undefined, false), null, 'VisBlocking: triggers are not hit');
  assert.equal(nat(e, 277, p, hl, hn, end, undefined, true), t, 'tracing actors hits the first colliding one');
  assert.ok(Math.abs(hl.get().X - (p.Location.X + 100 - 20)) < 1.5, 'at its cylinder');
  // default bTraceActors is the tracer's bCollideActors (Harry collides)
  assert.equal(nat(e, 277, p, hl, hn, end), t);
  e.level.setOwner(t, p);
  assert.equal(nat(e, 277, t, hl, hn, { ...p.Location, X: p.Location.X - 300 }, { ...p.Location, X: p.Location.X + 100 }, true), null, 'the owner (Harry) is skipped');
  e.level.destroy(t);
});

test('TraceActors lists actors then the level along the line; RadiusActors adds the collision radius', async () => {
  const e = await setup(), p = e.player, L = e.level;
  const wall = e.level.physics.multiLineCheck(p.Location, { ...p.Location, X: p.Location.X + 3000 }, null, false).find(h => h.actor === L.levelInfo);
  assert.ok(wall, 'a wall to the east');
  const t = spawnT(e, 60);
  const hits = nat(e, 309, p, null, null, null, null, { ...p.Location, X: p.Location.X + 3000 }, { ...p.Location, X: p.Location.X + 20 });
  const names = hits.map(h => h[0]);
  assert.ok(names.indexOf(t) >= 0 && names.indexOf(L.levelInfo) > names.indexOf(t), 'trigger before the level hit');
  const r = drain(nat(e, 310, p, e.vm.cls('Trigger'), null, 45));
  assert.ok(r.includes(t), '60 away < 45 + its radius 20');
  assert.ok(!drain(nat(e, 310, p, e.vm.cls('Trigger'), null, 35)).includes(t));
  L.destroy(t);
});

test('AllActors walks the live list: actors spawned during the loop are visited, destroyed ones skipped', async () => {
  const e = await setup(), L = e.level;
  const a = spawnT(e, 900), b = spawnT(e, 910);
  a.Tag = 'IterT'; b.Tag = 'IterT';
  const g = nat(e, 304, e.player, e.vm.cls('Trigger'), null, 'IterT');
  const seen = [];
  for (let r = g.next(); !r.done; r = g.next()) {
    seen.push(r.value);
    if (r.value === a) { L.destroy(b); const c = spawnT(e, 920); c.Tag = 'IterT'; }
  }
  assert.equal(seen.length, 2);
  assert.equal(seen[0], a);
  assert.ok(seen[1] !== b && seen[1].Tag === 'IterT', 'the new one, not the destroyed one');
  for (const x of seen) L.destroy(x);
});

test('TraceTexture returns the floor texture with its poly flags', async () => {
  const e = await setup(), p = e.player;
  const flags = ref(-1);
  const tex = nat(e, 285, p, { ...p.Location, Z: p.Location.Z - 128 }, p.Location, flags);
  assert.ok(tex && tex.__asset, 'a texture');
  assert.ok(typeof tex.FootstepSound === 'number');
  assert.notEqual(flags.get(), -1);
});

test('colour operators wrap bytes and keep alpha', async () => {
  const e = await setup();
  assert.deepEqual(nat(e, 551, null, { R: 200, G: 10, B: 0, A: 7 }, { R: 100, G: 10, B: 1, A: 99 }), { R: 44, G: 20, B: 1, A: 7 });
  assert.deepEqual(nat(e, 552, null, { R: 100, G: 3, B: 255, A: 9 }, 1.5), { R: 150, G: 4, B: 126, A: 9 });
});

test('AI MoveTo: move timer from distance and speed, accelerate toward the point, stop when passing it', async () => {
  const e = await setup(), S = e.level.pawns;
  const p = { Location: { X: 0, Y: 0, Z: 0 }, OldLocation: { X: 0, Y: 0, Z: 0 }, Velocity: { X: 0, Y: 0, Z: 0 }, Rotation: { Pitch: 0, Yaw: 0, Roll: 0 },
    Physics: 1, GroundSpeed: 200, AccelRate: 500, MaxDesiredSpeed: 1, CollisionHeight: 40, CollisionRadius: 15, Class: { isA: () => false } };
  const l = S.startMove(p, 'moveto', { X: 260, Y: 0, Z: 30 }, 0.5);
  assert.equal(l.ai, 'moveto');
  assert.equal(p.DesiredSpeed, 0.5);
  assert.ok(Math.abs(p.MoveTimer - (1 + 1.3 * Math.hypot(260, 30) / 100)) < 1e-9);
  assert.deepEqual(p.Acceleration, { X: 500, Y: 0, Z: 0 }, 'walking: horizontal only');
  assert.equal(p.DesiredRotation.Pitch, 0);
  // moved past the point this tick
  p.OldLocation = { X: 250, Y: 0, Z: 0 }; p.Location = { X: 262, Y: 0, Z: 0 }; p.Velocity = { X: 150, Y: 0, Z: 0 };
  assert.equal(S.pollMove(p, 'moveto'), true);
  assert.deepEqual(p.Acceleration, { X: 0, Y: 0, Z: 0 });
});

test('AI TurnTo: done once the yaw is within 100 units', async () => {
  const e = await setup(), S = e.level.pawns;
  const p = { Location: { X: 0, Y: 0, Z: 0 }, Rotation: { Pitch: 0, Yaw: 16300, Roll: 0 }, Physics: 1, Class: { isA: () => false } };
  S.startMove(p, 'turnto', { X: 0, Y: 100, Z: 50 });
  assert.equal(p.DesiredRotation.Yaw, 16383); assert.equal(p.Focus.Z, 0, 'walking: turn in the plane');
  assert.equal(S.pollMove(p, 'turnto'), true);
  p.Rotation.Yaw = 0;
  assert.equal(S.pollMove(p, 'turnto'), false);
});

test('WarpZoneInfo UnWarp / Warp: world -> zone-local by WarpCoords, then out through the other side', async () => {
  const e = await setup();
  const z = { WarpCoords: { Origin: { X: 100, Y: 0, Z: 0 }, XAxis: { X: 0, Y: 1, Z: 0 }, YAxis: { X: -1, Y: 0, Z: 0 }, ZAxis: { X: 0, Y: 0, Z: 1 } } };
  const o = { WarpCoords: { Origin: { X: 0, Y: 500, Z: 0 }, XAxis: { X: 1, Y: 0, Z: 0 }, YAxis: { X: 0, Y: 1, Z: 0 }, ZAxis: { X: 0, Y: 0, Z: 1 } } };
  const loc = ref({ X: 110, Y: 0, Z: 5 }), vel = ref({ X: 0, Y: 10, Z: 0 }), rot = ref({ Pitch: 0, Yaw: 16384, Roll: 0 });
  nat(e, 315, z, loc, vel, rot);
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  assert.ok(near(loc.get().X, 0) && near(loc.get().Y, -10) && near(loc.get().Z, 5), JSON.stringify(loc.get()));
  assert.ok(near(vel.get().X, 10) && near(vel.get().Y, 0));
  assert.equal(rot.get().Yaw, 0);
  nat(e, 314, o, loc, vel, rot);
  assert.ok(near(loc.get().X, 0) && near(loc.get().Y, 490), JSON.stringify(loc.get()));
});

test('GetWorldCollisionBox(bVisual): the mesh box placed in the world (Lev_Tut3b chest: the spell shape sits in front of it)', async () => {
  const e = await engine('Lev_Tut3b');
  const L = e.level, p = e.player, P = L.physics;
  tick(e, 1); skipCutscenes(e); e.restoreConsole?.();
  const c = L.actors.find(a => a.Name === 'bronzechest17');
  P.farMoveActor(p, { X: c.Location.X + 200, Y: c.Location.Y, Z: c.Location.Z + 45 });
  p.Rotation = { ...p.Rotation, Yaw: 32768 }; p.ViewRotation = { ...p.ViewRotation, Yaw: 32768, Pitch: 0 };
  tick(e, 0.5);
  e.keyEvent('LeftMouse', 'press');
  tick(e, 0.5);
  const w = p.rectarget?.Winfx;
  e.keyEvent('LeftMouse', 'release');
  assert.ok(w, 'aiming spawned the spell shape');
  // the chest's mesh spans Location.Z .. +48.6 (its Location is at its bottom) and +-31 around it in X
  assert.ok(w.Location.Z > c.Location.Z + 15, 'at the middle of the chest, not its bottom: ' + (w.Location.Z - c.Location.Z).toFixed(1));
  assert.ok(w.Location.X - c.Location.X > 31, 'in front of its near face: ' + (w.Location.X - c.Location.X).toFixed(1));
});
