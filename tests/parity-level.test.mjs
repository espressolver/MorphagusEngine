// Parity tests: actor placement, spawning, destruction, ownership, bases and touching against the reference
// UE1/HP engine rules (UnLevAct.cpp, UnActor.cpp, UnPrim.cpp; see docs/engine-parity.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engine, tick, skipCutscenes } from './helpers.mjs';
import { boxOverlaps } from '../src/game/engine/bspcol.js';

let shared;
const setup = async () => {
  if (!shared) { shared = await engine('Lev_Tut1'); skipCutscenes(shared, 60); tick(shared, 0.5); shared.restoreConsole(); }
  return shared;
};
// record events sent to the given actors while fn runs: [[actorName, event, argName]]
const recording = (e, actors, fn) => {
  const vm = e.vm, orig = vm.event.bind(vm), log = [];
  vm.event = (o, n, ...a) => { if (actors.includes(o)) log.push([o.Name, n, a[0]?.Name ?? a[0]]); return orig(o, n, ...a); };
  try { fn(); } finally { vm.event = orig; }
  return log;
};
const trigger = (e, loc, r = 20, h = 40) => {
  const t = e.level.spawn(e.vm.cls('Trigger'), null, null, loc);
  t.CollisionRadius = r; t.CollisionHeight = h;
  return t;
};

test('FindSpot: a box poking into a wall is pushed out; one buried in solid does not fit', async () => {
  const e = await setup(), P = e.level.physics, p = e.player, model = e.level.model;
  const ext = P.extentOf(p);
  const wall = P.visLine(p.Location, { ...p.Location, X: p.Location.X + 2000 });
  assert.ok(wall, 'a wall to the east');
  const into = { ...p.Location, X: p.Location.X + 2000 * wall.time - ext.X + 6 };
  assert.ok(boxOverlaps(model, into, ext), 'starts overlapping the wall');
  const spot = P.findSpot(ext, into);
  assert.ok(spot && !boxOverlaps(model, spot, ext), 'nudged to a free spot');
  assert.ok(Math.hypot(spot.X - into.X, spot.Y - into.Y, spot.Z - into.Z) < 20);
  const buried = { ...p.Location, Z: p.Location.Z - 400 };
  assert.ok(boxOverlaps(model, buried, ext));
  assert.equal(P.findSpot(ext, buried), null);
  assert.deepEqual(P.findSpot(ext, p.Location, true), p.Location, 'fits already: unchanged');
});

test('SpawnActor: refuses static and abstract classes and world-colliding actors that cannot fit', async () => {
  const e = await setup(), L = e.level, vm = e.vm, p = e.player;
  const n = L.actors.length;
  const fails = (cls, loc) => L.spawn(vm.cls(cls), null, null, loc) === null;
  assert.ok(fails('PlayerStart', p.Location), 'bStatic/bNoDelete class');
  assert.ok(vm.cls('Pickup').flags & 1);
  assert.ok(fails('Pickup', p.Location), 'abstract class');
  assert.ok(fails('BlueJellyBean', { ...p.Location, Z: p.Location.Z - 400 }), 'world-colliding class inside solid');
  assert.equal(L.actors.length, n);
  const ok = L.spawn(vm.cls('SpellWand'), null, null, { ...p.Location, Z: p.Location.Z - 400 });
  assert.ok(ok !== null, 'no world collision: placed anywhere');
  L.destroy(ok);
});

test('Spawn(): no owner by default, Tag from the call (None), Instigator copied from the spawner', async () => {
  const e = await setup(), vm = e.vm, p = e.player;
  const spawn = vm.natives.get(278);
  const a = spawn(p, [vm.cls('Trigger')]);
  assert.equal(a.Owner, null);
  assert.equal(a.Tag, 'None');
  assert.equal(a.Instigator, p.Instigator);
  const b = spawn(p, [vm.cls('Trigger'), p, 'Fred']);
  assert.equal(b.Owner, p);
  assert.equal(b.Tag, 'Fred');
});

test('SetOwner: LostChild to the old owner, GainedChild to the new one', async () => {
  const e = await setup(), L = e.level, vm = e.vm, p = e.player;
  const a = trigger(e, { ...p.Location, X: p.Location.X + 500 }), b = trigger(e, { ...p.Location, X: p.Location.X + 600 });
  const c = trigger(e, { ...p.Location, X: p.Location.X + 700 });
  L.setOwner(c, a);
  const log = recording(e, [a, b], () => L.setOwner(c, b));
  assert.deepEqual(log.map(x => x.slice(0, 2)), [[a.Name, 'LostChild'], [b.Name, 'GainedChild']]);
});

test('SetLocation (FarMoveActor): teleports, zeroes OldLocation, drops riders; fails in solid', async () => {
  const e = await setup(), P = e.level.physics, p = e.player;
  const rider = trigger(e, { ...p.Location, X: p.Location.X + 300 });
  P.setBase(rider, p);
  const to = { ...p.Location, X: p.Location.X + 10 };
  assert.equal(P.farMoveActor(p, to), true);
  assert.deepEqual(p.OldLocation, p.Location);
  assert.equal(p.bJustTeleported, true);
  assert.equal(rider.Base, null);
  const before = { ...p.Location };
  assert.equal(P.farMoveActor(p, { ...p.Location, Z: p.Location.Z - 400 }), false);
  assert.deepEqual(p.Location, before, 'unchanged after a failed move');
});

test('SetBase: Attach/Detach for actor bases (never the level), BaseChange afterwards, no loops', async () => {
  const e = await setup(), P = e.level.physics, p = e.player, LI = e.level.levelInfo;
  const a = trigger(e, { ...p.Location, X: p.Location.X + 400 }), b = trigger(e, { ...p.Location, X: p.Location.X + 450 });
  P.setBase(a, LI);
  let log = recording(e, [a, b, LI], () => P.setBase(a, b));
  assert.deepEqual(log.map(x => x.slice(0, 2)), [[b.Name, 'Attach'], [a.Name, 'BaseChange']]);
  log = recording(e, [a, b, LI], () => P.setBase(a, LI));
  assert.deepEqual(log.map(x => x.slice(0, 2)), [[b.Name, 'Detach'], [a.Name, 'BaseChange']]);
  P.setBase(a, b); P.setBase(b, a);
  assert.equal(b.Base, null, 'would loop: refused');
  P.setBase(a, null);
});

test('touch by moving: entering a cylinder touches; inside one since spawn only moving inward does', async () => {
  const e = await setup(), P = e.level.physics, p = e.player;
  const out = trigger(e, { ...p.Location, Y: p.Location.Y - 60 }, 10, 40);
  assert.deepEqual(recording(e, [out], () => P.moveActor(p, { X: 0, Y: -40, Z: 0 }, null, { noCollision: true })).map(x => x[1]), ['Touch']);
  assert.deepEqual(recording(e, [out], () => P.moveActor(p, { X: 0, Y: 40, Z: 0 }, null, { noCollision: true })).map(x => x[1]), ['UnTouch']);
  e.level.destroy(out);
  // spawned around Harry: not touching; walking out doesn't touch it, walking toward its centre does
  const t = trigger(e, { ...p.Location, X: p.Location.X + 20 }, 60, 60);
  assert.ok(!p.__touching.has(t));
  assert.deepEqual(recording(e, [t], () => P.moveActor(p, { X: -4, Y: 0, Z: 0 }, null, { noCollision: true })), []);
  assert.deepEqual(recording(e, [t], () => P.moveActor(p, { X: 4, Y: 0, Z: 0 }, null, { noCollision: true })).map(x => x[1]), ['Touch']);
  e.level.destroy(t);
});

test('SetCollision does not touch or untouch by itself', async () => {
  const e = await setup(), P = e.level.physics, p = e.player, vm = e.vm;
  const t = trigger(e, { ...p.Location, X: p.Location.X + 5 }, 30, 40);
  t.bCollideActors = false;
  const setCollision = vm.natives.get(262);
  assert.deepEqual(recording(e, [t, p], () => setCollision(t, [true, false, false])), []);
  assert.ok(!p.__touching.has(t));
  e.level.destroy(t);
});

test('Touching holds 4 actors; a pawn displaces a non-pawn when the list is full', async () => {
  const e = await setup(), P = e.level.physics, p = e.player;
  const ts = [0, 1, 2, 3].map(i => trigger(e, { ...p.Location, X: p.Location.X + 500 + i * 3 }));
  for (const t of ts) t.Physics = 2; // not PHYS_None, so no pruning of idle actors
  const hub = trigger(e, { ...p.Location, X: p.Location.X + 500 });
  for (const t of ts) P.beginTouch(hub, t);
  assert.equal(P.touchSlots(hub).filter(Boolean).length, 4);
  P.beginTouch(hub, p);
  assert.ok(P.touchSlots(hub).includes(p), 'pawn got a slot');
  assert.equal(P.touchSlots(hub).filter(Boolean).length, 4);
  for (const t of [...ts, hub]) e.level.destroy(t);
});

test('DestroyActor: EndState, Destroyed, owned actors disowned, toucher hears UnTouch, LostChild on owner', async () => {
  const e = await setup(), L = e.level, P = e.level.physics, p = e.player, vm = e.vm;
  const owner = trigger(e, { ...p.Location, X: p.Location.X + 800 });
  const a = trigger(e, { ...p.Location, X: p.Location.X + 900 }), kid = trigger(e, { ...p.Location, X: p.Location.X + 950 });
  const toucher = trigger(e, { ...p.Location, X: p.Location.X + 905 });
  L.setOwner(a, owner); L.setOwner(kid, a);
  P.beginTouch(toucher, a);
  const log = recording(e, [a, owner, kid, toucher], () => L.destroy(a));
  const names = log.map(x => x[0] + '.' + x[1]);
  assert.ok(names.indexOf(a.Name + '.Destroyed') >= 0);
  assert.ok(names.indexOf(a.Name + '.LostChild') > names.indexOf(a.Name + '.Destroyed'), 'kid disowned after Destroyed');
  assert.ok(names.includes(toucher.Name + '.UnTouch'), 'the toucher is told');
  assert.ok(!names.includes(a.Name + '.UnTouch'), 'the dying actor is not');
  assert.equal(names.at(-1), owner.Name + '.LostChild');
  assert.equal(kid.Owner, null);
  assert.equal(a.bDeleteMe, true);
  for (const t of [owner, kid, toucher]) L.destroy(t);
  vm.flushLog?.();
});

test('CT_Box: the mover extent is taken into the box frame as a box (bigger along a turned box diagonal); inside only blocks going deeper', async () => {
  const { boxOf, sweepCylinderBox } = await import('../src/game/engine/shapes.js');
  const mk = yaw => ({ CollideType: 2, CollisionRadius: 10, CollisionWidth: 10, CollisionHeight: 10, Location: { X: 0, Y: 0, Z: 0 }, Rotation: { Pitch: 0, Yaw: yaw, Roll: 0 } });
  const hit = (b, from, d) => { const r = { t: 1, nx: 0, ny: 0, nz: 0 }; return sweepCylinderBox(from, d, 5, 5, b, r) ? r.t : null; };
  // straight box: contact at 10 + 5 = 15 from the centre
  const t0 = hit(boxOf(mk(0)), { X: -50, Y: 0, Z: 0 }, { X: 100, Y: 0, Z: 0 });
  assert.ok(Math.abs(t0 * 100 - 35) < 1e-6);
  // turned 45 degrees: the extent becomes 5 * (cos + sin) = 7.07 along each box axis
  const t45 = hit(boxOf(mk(8192)), { X: -50, Y: -50, Z: 0 }, { X: 100, Y: 100, Z: 0 });
  assert.ok(Math.abs(t45 * Math.hypot(100, 100) - (Math.hypot(50, 50) - (10 + 5 * Math.SQRT2))) < 0.01, 'diagonal contact ' + t45);
  // starting inside: outward movement is free, inward is blocked at once
  const b = boxOf(mk(0));
  assert.equal(hit(b, { X: 8, Y: 0, Z: 0 }, { X: 10, Y: 0, Z: 0 }), null);
  assert.equal(hit(b, { X: 8, Y: 0, Z: 0 }, { X: -3, Y: 0, Z: 0 }), 0);
});

test('CT_Shape: the collision box is the mesh bounds (off-centre) and sets the collision size', async () => {
  const e = await setup();
  const bench = e.level.actors.find(a => (a.CollideType | 0) === 3 && a.Mesh && !a.__moverMesh && a.__shapeBounds) || null;
  if (!bench) return; // (no mesh shape in this map)
  const b = bench.__shapeBounds;
  assert.equal(bench.CollisionRadius, Math.max(-b.min[0], b.max[0], -b.min[1], b.max[1]));
  assert.equal(bench.CollisionHeight, Math.max(-b.min[2], b.max[2]));
});

test('CT_OrientedCylinder: tester taken into the actor frame (TransformExtent), then the upright cylinder check', async () => {
  const { orientedFrame, toOriented } = await import('../src/game/engine/shapes.js');
  const e = await setup(), P = e.level.physics, p = e.player;
  const t = e.level.spawn(e.vm.cls('Trigger'), null, null, { X: p.Location.X + 300, Y: p.Location.Y + 300, Z: p.Location.Z });
  Object.assign(t, { CollideType: 1, CollisionRadius: 10, CollisionHeight: 50, bBlockActors: true, bBlockPlayers: true, Rotation: { Pitch: 0, Yaw: 0, Roll: 16384 } });
  // rolled 90 degrees: the cylinder lies along X... its axis is the world Y axis, length 2x50
  const fr = orientedFrame(t);
  assert.ok(fr);
  const start = { X: t.Location.X, Y: t.Location.Y + 45, Z: t.Location.Z + 100 };
  const time = P.shapeLineTime({ CollisionRadius: 5, CollisionHeight: 5 }, start, { X: 0, Y: 0, Z: -200 }, t);
  assert.ok(time !== null && Math.abs(time * 200 - (100 - 15)) < 0.5, 'hits the lying cylinder from above at its side: ' + time);
  const miss = P.shapeLineTime({ CollisionRadius: 5, CollisionHeight: 5 }, { ...start, Y: t.Location.Y + 60 }, { X: 0, Y: 0, Z: -200 }, t);
  assert.equal(miss, null, 'beyond its end cap');
  // yaw only: the box extent turned 45 degrees is r*sqrt2 wide
  t.Rotation = { Pitch: 0, Yaw: 8192, Roll: 0 };
  const q = toOriented(orientedFrame(t), t.Location, null, 5, 5);
  assert.ok(Math.abs(q.r - 5 * Math.SQRT2) < 1e-6);
  e.level.destroy(t);
});
