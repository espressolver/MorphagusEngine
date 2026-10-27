// Parity tests: behaviour of the physics core against the reference UE1/HP engine rules
// (see docs/engine-parity.md). Cases are written from the rules, not copied from the reference.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engine, tick, skipCutscenes } from './helpers.mjs';

let eng;
const P = async () => { eng ??= await engine('Lev_Tut1'); return eng.level.physics; };
const actor = (o = {}) => ({ bFixedRotationDir: false, bRotateToDesired: true, ...o });

test('fixedTurn: shortest way toward desired, clamped by rate, result in 0..65535', async () => {
  const p = await P();
  assert.equal(p.fixedTurn(actor(), 1000, 3000, 500), 1500);
  assert.equal(p.fixedTurn(actor(), 1000, 1200, 500), 1200);          // doesn't overshoot
  assert.equal(p.fixedTurn(actor(), 65000, 500, 1000), 464);          // wraps forward across 0
  assert.equal(p.fixedTurn(actor(), 500, 65000, 1000), 65036);        // wraps backward
  assert.equal(p.fixedTurn(actor(), 1000, 3000, -500), 1500);         // sign of rate ignored when rotating to desired
  assert.equal(p.fixedTurn(actor(), 70000, 4464, 0), 4464);           // zero rate: just normalise
});

test('fixedTurn: fixed direction', async () => {
  const p = await P();
  assert.equal(p.fixedTurn(actor({ bFixedRotationDir: true, bRotateToDesired: false }), 1000, 0, 300), 1300); // free spin
  assert.equal(p.fixedTurn(actor({ bFixedRotationDir: true }), 3000, 1000, 1000), 4000);  // forward the long way round
  assert.equal(p.fixedTurn(actor({ bFixedRotationDir: true }), 1000, 3000, -1000), 0);    // backward the long way
});

test('twoWallAdjust: tight corner follows the crease, open corner slides along the new wall', async () => {
  const p = await P();
  const d = p.twoWallAdjust({ X: 1, Y: 1, Z: 0 }, { X: 10, Y: 10, Z: 0 }, { X: -1, Y: 0, Z: 0 }, { X: 0, Y: -1, Z: 0 }, 0);
  assert.ok(Math.abs(d.X) < 1e-9 && Math.abs(d.Y) < 1e-9, 'crease is vertical: no horizontal move');
  const e = p.twoWallAdjust({ X: 1, Y: 0, Z: 0 }, { X: 10, Y: 5, Z: 0 }, { X: -0.6, Y: -0.8, Z: 0 }, { X: 0, Y: -1, Z: 0 }, 0.5);
  assert.ok(Math.abs(e.X * -0.6 + e.Y * -0.8) < 1e-9, 'slides along new wall');
  assert.ok(e.X > 0, 'still in desired direction');
});

test('setPhysics: None/Rotating stop movement; falling drops the base', async () => {
  const p = await P(), a = eng.player;
  a.Velocity = { X: 50, Y: 0, Z: 0 }; a.Acceleration = { X: 10, Y: 0, Z: 0 };
  p.setPhysics(a, 0);
  assert.deepEqual([a.Velocity.X, a.Acceleration.X], [0, 0]);
  p.setPhysics(a, 2);
  assert.equal(a.Base, null);
  p.setPhysics(a, 1);
});

test('PostTouch is delivered after physics for a PendingTouch actor', async () => {
  const p = await P(), a = eng.player, vm = eng.vm;
  const other = eng.level.actors.find(x => x.Class.isA('Trigger'));
  let got = null; const orig = vm.event.bind(vm);
  vm.event = (o, n, ...args) => { if (n === 'PostTouch') got = [o, args[0]]; return orig(o, n, ...args); };
  a.PendingTouch = other;
  p.perform(a, 1 / 30);
  vm.event = orig;
  assert.deepEqual(got, [other, a]);
  assert.equal(a.PendingTouch, null);
});

test('pawn MoveTimer counts down every physics step', async () => {
  const p = await P(), a = eng.player;
  a.MoveTimer = 1;
  p.perform(a, 0.25);
  assert.ok(Math.abs(a.MoveTimer - 0.75) < 1e-9);
});

test('walking keeps the reference floor gap (1.9..2.4 units above the floor)', async () => {
  const e = await engine('Lev_Tut1');
  const p = e.player, P = e.level.physics;
  skipCutscenes(e, 60); tick(e, 0.5);
  P.setLocation(p, { X: -658, Y: -1185, Z: -336 + p.CollisionHeight + 10 });
  tick(e, 1);
  assert.equal(p.Physics, 1, 'walking');
  const r = P.traceShape(p, p.Location, { X: p.Location.X, Y: p.Location.Y, Z: p.Location.Z - 20 });
  e.restoreConsole();
  const gap = r.t * 20;
  assert.ok(gap >= 1.9 && gap <= 2.4 + 0.5, 'floor gap ' + gap); // + the trace's own 0.5 back-off
});

test('calcVelocity: walking players are capped at 30% speed, AI scaled by DesiredSpeed', async () => {
  const p = await P(), a = eng.player;
  Object.assign(a, { Velocity: { X: 0, Y: 0, Z: 0 }, Acceleration: { X: 1000, Y: 0, Z: 0 }, bIsWalking: true });
  for (let i = 0; i < 60; i++) p.calcVelocity(a, { X: 1, Y: 0, Z: 0 }, 1 / 30, 200, 8);
  assert.ok(Math.abs(a.Velocity.X - 60) < 1, 'walking player speed ' + a.Velocity.X);
  a.bIsWalking = false;
  for (let i = 0; i < 60; i++) { a.Acceleration = { X: 1000, Y: 0, Z: 0 }; p.calcVelocity(a, { X: 1, Y: 0, Z: 0 }, 1 / 30, 200, 8); }
  assert.ok(Math.abs(a.Velocity.X - 200) < 1, 'running player speed ' + a.Velocity.X);
  const npc = eng.level.actors.find(x => x.Class.isA('Pawn') && !x.Player);
  Object.assign(npc, { Velocity: { X: 0, Y: 0, Z: 0 }, DesiredSpeed: 0.5, AccelRate: 2000 });
  for (let i = 0; i < 60; i++) { npc.Acceleration = { X: 2000, Y: 0, Z: 0 }; p.calcVelocity(npc, { X: 1, Y: 0, Z: 0 }, 1 / 30, 300, 8); }
  assert.ok(Math.abs(npc.Velocity.X - 150) < 1, 'AI speed ' + npc.Velocity.X);
});

test('calcVelocity: no acceleration and no braking decays speed exponentially with friction', async () => {
  const p = await P(), a = eng.player;
  Object.assign(a, { Velocity: { X: 200, Y: 0, Z: 0 }, Acceleration: { X: 0, Y: 0, Z: 0 }, bIsWalking: false });
  p.calcVelocity(a, { X: 0, Y: 0, Z: 0 }, 0.1, 200, 8);
  assert.ok(Math.abs(a.Velocity.X - 200 * (1 - 0.8)) < 1e-6);
});

test('BSP box trace stops a pawn-sized box 0.5 units short of a wall', async () => {
  const p = await P();
  const { boxLineCheck } = await import('../src/game/engine/bspcol.js');
  const r = boxLineCheck(eng.level.model, { X: 96, Y: -1560, Z: -228 }, { X: 96, Y: -1760, Z: -228 }, { X: 15, Y: 15, Z: 42 });
  assert.ok(r && Math.abs(r.location.Y - (-1640 + 15 + 0.5)) < 0.6, 'stopped at ' + r?.location.Y);
  assert.deepEqual(r.normal.map(v => Math.round(v)), [0, 1, 0]);
});

test('processHitWall: a pawn without a HitWall handler only marks bFromWall', async () => {
  const p = await P();
  const npc = eng.level.actors.find(x => x.Class.isA('Pawn') && !x.Player && !eng.vm.findFunction(x, 'hitwall'));
  if (!npc) return;
  Object.assign(npc, { Acceleration: { X: 100, Y: 0, Z: 0 }, Destination: { X: npc.Location.X + 100, Y: npc.Location.Y, Z: npc.Location.Z }, MinHitWall: -1, bFromWall: false, Physics: 1 });
  p.processHitWall(npc, { X: -1, Y: 0, Z: 0 }, eng.level.levelInfo);
  assert.equal(npc.bFromWall, true);
});

test('MoveActor looks 2 units ahead: a move that would end within 2 units of a wall is cut short', async () => {
  const e = await engine('Lev_Tut1');
  skipCutscenes(e, 60); tick(e, 0.5);
  const p = e.player, P = e.level.physics;
  P.setLocation(p, { X: 96, Y: -1560, Z: -272 + p.CollisionHeight + 2.2 });
  const r = P.moveActor(p, { X: 0, Y: -100, Z: 0 });
  e.restoreConsole();
  assert.ok(r.hit);
  assert.ok(Math.abs(p.Location.Y - (-1640 + p.CollisionRadius + 0.5 + 2)) < 0.6, 'stopped at ' + p.Location.Y);
});

test('touches are found along the swept path, not only at the end position', async () => {
  const e = await engine('Lev_Tut1');
  skipCutscenes(e, 60); tick(e, 0.5);
  const p = e.player, P = e.level.physics, vm = e.vm;
  const t = e.level.spawn(vm.cls('Trigger'), null, null, { X: p.Location.X, Y: p.Location.Y - 60, Z: p.Location.Z });
  t.CollisionRadius = 10; t.CollisionHeight = 40; t.bCollideActors = true;
  const touched = [];
  const orig = vm.event.bind(vm);
  vm.event = (o, n, ...a) => { if (n === 'Touch' && o === t) touched.push(a[0]); return orig(o, n, ...a); };
  P.moveActor(p, { X: 0, Y: -120, Z: 0 }, null, { noCollision: true }); // passes clean through the trigger
  vm.event = orig;
  e.restoreConsole();
  assert.deepEqual(touched, [p]);
  assert.ok(!p.__touching.has(t), 'no longer touching at the end');
});

test('hit surface lookup finds the climbable wall face from a box hit', async () => {
  const e = await engine('Lev_Tut1');
  skipCutscenes(e, 60); tick(e, 0.5);
  const p = e.player, P = e.level.physics;
  P.setLocation(p, { X: -100, Y: -4230, Z: 48 + p.CollisionHeight + 2.2 });
  const r = P.moveActor(p, { X: 0, Y: -100, Z: 0 }, null, { noBump: true });
  e.restoreConsole();
  assert.ok(r.hit);
  assert.ok(P.hitSurfFlags(r, Math.max(p.CollisionRadius, p.CollisionHeight)) & 0x1000, 'PF_SpecialPoly');
});

test('turning movers never push pawns (HP1 CheckEncroachment pushes by translation only): Lev_Tut3 Harry walks through the double doors', async () => {
  const e = await engine('Lev_Tut3');
  const p = e.player, dest = e.level.actors.find(a => a.Name === 'CutMark32');
  let minX = Infinity, arrivedAt = null;
  for (let i = 0; i < 70; i++) {
    const x0 = p.Location.X;
    tick(e, 0.05);
    if (p.__state?.name === 'CutMovingTo' && p.Location.X < x0 - 1) minX = Math.min(minX, p.Location.X);
    if (arrivedAt === null && p.bCutArrived) arrivedAt = e.level.timeSeconds;
  }
  assert.equal(minX, Infinity, 'Harry was pushed back by the closing doors');
  assert.ok(arrivedAt !== null && arrivedAt < 3.5, 'walked to the cut mark (no timeout teleport): ' + arrivedAt);
  assert.ok(Math.hypot(p.Location.X - dest.Location.X, p.Location.Y - dest.Location.Y) < 5);
});

test('a world-colliding mover sweeps its brush box (Lev3_Dungeon GridMover14 slides only along its groove, then drops into the pit)', async () => {
  const e = await engine('Lev3_Dungeon');
  const L = e.level, p = e.player, P = L.physics;
  tick(e, 1);
  skipCutscenes(e);
  const g = L.actors.find(a => a.Name === 'GridMover14');
  const shoot = dir => {
    const c = g.Location, [dx, dy, yaw] = { '+X': [-150, 0, 0], '-Y': [0, 150, -16384] }[dir];
    P.farMoveActor(p, { X: c.X + dx, Y: c.Y + dy, Z: -2259 });
    const s = L.spawn(e.vm.cls('spellFlip'), p, null, { X: c.X + dx, Y: c.Y + dy, Z: -2230 }, { Pitch: 0, Yaw: yaw, Roll: 0 });
    s.Instigator = p;
    tick(e, 4);
    return [Math.round(g.Location.X), Math.round(g.Location.Y), Math.round(g.Location.Z)];
  };
  assert.deepEqual(shoot('+X'), [368, -5008, -2224], 'the step out of the groove stops it');
  assert.deepEqual(shoot('-Y'), [368, -5104, -2224]);
  assert.deepEqual(shoot('-Y'), [368, -5200, -2224]);
  assert.deepEqual(shoot('+X'), [464, -5200, -2224]);
  const [x, y, z] = shoot('+X');
  assert.deepEqual([x, y], [560, -5200]);
  assert.ok(z < -2400 && z > -2450, 'fell into the pit and rests on its floor: ' + z);
});
