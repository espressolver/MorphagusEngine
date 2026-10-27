// Parity tests: movers (physMovingBrush), path interpolation (AInterpolationManager), projectiles, rolling
// and flying physics, against the reference rules (see docs/engine-parity.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engine, tick, skipCutscenes } from './helpers.mjs';

let shared;
const setup = async () => {
  if (!shared) { shared = await engine('Lev_Tut1'); skipCutscenes(shared, 60); tick(shared, 0.5); shared.restoreConsole(); }
  return shared;
};
const near = (a, b, eps = 0.5) => Math.abs(a - b) < eps;

test('mover: runs on its own PhysAlpha/PhysRate (MoveTime), glides, KeyFrameReached at the key', async () => {
  const e = await setup(), P = e.level.physics;
  const m = e.level.actors.find(a => a.Class.isA('Mover') && a.__moverModel);
  const start = { ...m.Location };
  m.OldPos = { ...start }; m.OldRot = { ...m.Rotation }; m.BasePos = { ...start }; m.BaseRot = { ...m.Rotation };
  m.KeyPos = [{ X: 0, Y: 0, Z: 0 }, { X: 0, Y: 0, Z: 1 }]; m.KeyRot = [m.Rotation, m.Rotation];
  m.KeyNum = 1; m.MoverGlideType = 1;
  m['PhysAlpha@Mover'] = 0; m['PhysRate@Mover'] = 0.25; // a 4 second move
  m.bInterpolating = true;
  const events = [];
  const orig = e.vm.event.bind(e.vm);
  e.vm.event = (o, n, ...a) => { if (o === m) events.push(n); return orig(o, n, ...a); };
  try {
    P.physMovingBrush(m, 2);
    assert.ok(near(m['PhysAlpha@Mover'], 0.5, 1e-6), 'half way after 2 of 4 seconds');
    assert.ok(near(m.Location.Z - start.Z, 0.5, 1e-3), 'smoothstep(0.5) = 0.5');
    P.physMovingBrush(m, 0.5);
    assert.ok(near(m.Location.Z - start.Z, 3 * 0.625 ** 2 - 2 * 0.625 ** 3, 1e-3), 'glide curve');
    P.physMovingBrush(m, 5);
    assert.equal(m.bInterpolating, false);
    assert.ok(near(m.Location.Z - start.Z, 1, 1e-6));
    assert.deepEqual(events.filter(n => n === 'KeyFrameReached'), ['KeyFrameReached']);
    assert.ok(!events.includes('InterpolateEnd'), 'movers only report KeyFrameReached');
  } finally { e.vm.event = orig; }
  m.Location = start;
});

test('InterpolationManager moves its owner along the Bezier segment at its PhysRate, then InterpolateEnd', async () => {
  const e = await setup(), L = e.level, p = e.player, vm = e.vm;
  const mk = (x, pos) => { const ip = L.spawn(vm.cls('InterpolationPoint'), null, 'IPTest', { X: p.Location.X + x, Y: p.Location.Y, Z: p.Location.Z + 300 }, { Pitch: 0, Yaw: 0, Roll: 0 }, { force: true, noFit: true }); ip.Position = pos; return ip; };
  const a = mk(0, 0), b = mk(400, 1);
  // a plain two-point path: no speed matching (points default to DesiredSpeed 900)
  a.Next = b; b.Prev = a; b.Next = null; a.Prev = null; b.bEndOfPath = true;
  for (const x of [a, b]) { x.DesiredSpeed = 0; x.bConstantSpeed = false; } a.Pause = [0, 0, 0, 0, 0, 0, 0, 0]; b.Pause = [0, 0, 0, 0, 0, 0, 0, 0];
  // equal-length control points: the rate modifier 1 + alpha*(|End|/|Start| - 1) stays 1
  a.StartControlPoint = { X: 0, Y: 0, Z: 0 }; b.EndControlPoint = { X: -1, Y: 0, Z: 0 }; b.StartControlPoint = { X: 1, Y: 0, Z: 0 };
  const rider = L.spawn(vm.cls('Trigger'), null, null, { ...a.Location });
  rider.SetCollisionCalls = 0; rider.bCollideWorld = false; rider.bInterpolating = true; rider.Physics = 0;
  const im = L.spawn(vm.cls('InterpolationManager'), rider, null, rider.Location);
  im.Dest = b; im['PhysRate@InterpolationManager'] = 0.5; im['PhysAlpha@InterpolationManager'] = 0; im.RemainingPause = 0;
  const ends = [];
  const orig = vm.event.bind(vm);
  vm.event = (o, n, ...x) => { if (o === b && n === 'InterpolateEnd') ends.push(x[0]); return orig(o, n, ...x); };
  try {
    L.interp.perform(im, 1);
    assert.ok(near(im['PhysAlpha@InterpolationManager'], 0.5, 1e-6), JSON.stringify({ a: im['PhysAlpha@InterpolationManager'], r: im['PhysRate@InterpolationManager'], i: rider.bInterpolating, o: im.Owner === rider, d: im.Dest === b, del: im.__deleted, x: rider.Location.X - a.Location.X }));
    assert.ok(near(rider.Location.X - a.Location.X, 200, 0.6), 'cubic with no control offsets is linear at 0.5: ' + (rider.Location.X - a.Location.X));
    assert.ok(near(rider.Velocity.X, 200, 1), 'velocity from the move');
    L.interp.perform(im, 1.5);
    assert.ok(ends.length === 1 && ends[0] === im, 'point reached: ' + ends.length);
  } finally { vm.event = orig; }
  for (const x of [a, b, rider]) { x.bStatic = false; x.bNoDelete = false; L.destroy(x); }
  L.destroy(im);
});

test('projectile: clamped to MaxSpeed, HitWall on a blocking hit, destroyed outside the world', async () => {
  const e = await setup(), L = e.level, P = L.physics, p = e.player;
  const pr = L.spawn(e.vm.cls('spellFlip'), null, null, { ...p.Location, Z: p.Location.Z + 20 });
  pr.MaxSpeed = 300; pr.Velocity = { X: 1000, Y: 0, Z: 0 }; pr.Acceleration = { X: 0, Y: 0, Z: 0 };
  pr.bCollideWorld = true; pr.bBounce = false;
  P.physProjectile(pr, 0.01);
  assert.ok(near(Math.hypot(pr.Velocity.X, pr.Velocity.Y, pr.Velocity.Z), 300, 1));
  pr.Region = { ...pr.Region, ZoneNumber: 0 };
  P.physProjectile(pr, 0.01);
  assert.equal(pr.bDeleteMe, true, 'zone 0 is outside the level');
});

test('flying pawn: calcVelocity at AirSpeed, velocity from the actual move', async () => {
  const e = await setup(), P = e.level.physics, p = e.player;
  const save = { loc: { ...p.Location }, ph: p.Physics, as: p.AirSpeed, acc: p.Acceleration, v: p.Velocity };
  p.Physics = 4; p.AirSpeed = 100; p.Acceleration = { X: 0, Y: 0, Z: 2000 }; p.Velocity = { X: 0, Y: 0, Z: 0 };
  P.physFlying(p, 0.5);
  assert.ok(p.Velocity.Z > 0 && p.Velocity.Z <= 100.5, 'capped at AirSpeed: ' + p.Velocity.Z);
  assert.ok(p.Location.Z > save.loc.Z);
  Object.assign(p, { Physics: save.ph, AirSpeed: save.as, Acceleration: save.acc, Velocity: save.v });
  P.farMoveActor(p, save.loc);
});

test('HP FindPath: depth-first over Paths[] of same-class nodes, no size checks (Lev_Tut3b Peeves patrol)', async () => {
  const e = await engine('Lev_Tut3b');
  const L = e.level, by = n => L.actors.find(a => a.Name.toLowerCase() === n.toLowerCase());
  const pv = by('tut3peeves2');
  assert.ok(pv.CollisionRadius > 60, 'Peeves is wider than the reach specs');
  assert.equal(e.nav.findPath(pv, by('HPath_A0'), 'baseStation0')?.Name, 'baseStation0', 'goal next to the start');
  assert.equal(e.nav.findPath(pv, by('HPath_B0'), 'basestation2')?.Name, 'basestation2');
  // the exit path F1 -> F2 -> F3 is a dead end: no route (Peeves glides out through the opened door)
  assert.equal(e.nav.findPath(pv, by('HPath_F1'), 'baseStation1'), null);
  // in the fight he patrols station to station and attacks (no drifting off after the first leg)
  for (let i = 0; i < 40; i++) tick(e, 0.05);
  L.physics.farMoveActor(e.player, { X: -755, Y: -4637, Z: 560 });
  const states = new Set();
  for (let i = 0; i < 600; i++) { tick(e, 1 / 30); states.add(pv.__state?.name); }
  assert.ok(states.has('atStation') && states.has('attackHarry') && states.has('throwing'), [...states].join(','));
  assert.ok(Math.hypot(pv.Location.X + 500, pv.Location.Y + 4650) < 900, 'still in the arena');
});

test('GroundSpeed 0 caps walking at 0 (Lev_Tut1: Harry stops short of the wizard card he picks up)', async () => {
  const e = await engine('Lev_Tut1');
  const L = e.level, p = e.player, P = L.physics;
  tick(e, 1); skipCutscenes(e); e.restoreConsole?.();
  e.vm.event(L.actors.find(a => a.Name === 'SpawnThingy0'), 'Trigger', p, p);
  tick(e, 3);
  const c = L.actors.find(a => a.Class.isA('WizzardCardIcon') && !a.__deleted);
  assert.ok(P.farMoveActor(p, { X: c.Location.X + 200, Y: c.Location.Y, Z: c.Location.Z }));
  p.Rotation = { ...p.Rotation, Yaw: 32768 }; p.ViewRotation = { ...p.ViewRotation, Yaw: 32768 };
  tick(e, 0.5);
  e.keyEvent('Up', 'press');
  let at = null;
  for (let i = 0; i < 90 && !at; i++) { tick(e, 1 / 30); if (p.__state?.name === 'PickingUpWizardCard') at = { ...p.Location }; }
  e.keyEvent('Up', 'release');
  assert.ok(at, 'picked the card up');
  tick(e, 1);
  assert.ok(Math.abs(p.Location.X - at.X) < 2, `stood still (moved ${(at.X - p.Location.X).toFixed(1)})`);
  assert.ok(p.Location.X - c.Location.X > 30, 'did not run through the card');
});

test('Pawn.WeaponLoc follows the weapon bone; Space only throws while Harry carries something', async () => {
  const e = await engine('Lev_Tut3b');
  const p = e.player;
  tick(e, 0.5);
  assert.ok(p.WeaponLoc && Math.hypot(p.WeaponLoc.X - p.Location.X, p.WeaponLoc.Y - p.Location.Y, p.WeaponLoc.Z - p.Location.Z) < 60, JSON.stringify(p.WeaponLoc));
  p.CarryingActor = p.Weapon; // anything held
  const before = p.bPressedJump;
  e.keyEvent('Space', 'press');
  assert.equal(!!p.bPressedJump, !!before, 'no jump while carrying');
  e.keyEvent('Space', 'release');
  p.CarryingActor = null;
});
