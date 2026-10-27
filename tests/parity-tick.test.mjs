// Parity tests: the per-frame actor update (UnLevTic.cpp AActor::Tick / ULevel::Tick), animation playback
// (UnScript.cpp PlayAnim, UnSkeletalMesh.cpp) and pawn sight (UnPawn.cpp), against the reference rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engine, tick, skipCutscenes } from './helpers.mjs';
import { boxLineCheck } from '../src/game/engine/bspcol.js';

let shared;
const setup = async () => {
  if (!shared) { shared = await engine('Lev_Tut1'); skipCutscenes(shared, 60); tick(shared, 0.5); shared.restoreConsole(); }
  return shared;
};
const spawnT = (e, dx = 300) => { const p = e.player; return e.level.spawn(e.vm.cls('Trigger'), null, null, { ...p.Location, X: p.Location.X + dx }); };
const watch = (e, actors, names, fn) => {
  const vm = e.vm, orig = vm.event.bind(vm), log = [];
  vm.event = (o, n, ...a) => { if (actors.includes(o) && names.includes(n)) log.push(o.Name + '.' + n); return orig(o, n, ...a); };
  try { fn(); } finally { vm.event = orig; }
  return log;
};

test('timer: a one-shot keeps the remainder and switches off; a loop fires once per tick and carries over', async () => {
  const e = await setup(), L = e.level;
  const t = spawnT(e);
  t.TimerRate = 0.1; t.TimerCounter = 0; t.bTimerLoop = false;
  let n = watch(e, [t], ['Timer'], () => L.tickActor(t, 0.15)).length;
  assert.equal(n, 1); assert.equal(t.TimerRate, 0); assert.ok(Math.abs(t.TimerCounter - 0.05) < 1e-9);
  L.frame++;
  t.TimerRate = 0.1; t.TimerCounter = 0; t.bTimerLoop = true;
  n = watch(e, [t], ['Timer'], () => L.tickActor(t, 0.27)).length;
  assert.equal(n, 1, 'one Timer call even when several periods passed');
  // the counter loses the rounded number of periods (3), so it may go negative
  assert.ok(Math.abs(t.TimerCounter - (0.27 - 0.3)) < 1e-9, 'counter ' + t.TimerCounter);
  assert.equal(t.TimerRate, 0.1);
  L.destroy(t);
});

test('LifeSpan: Expired then destroyed, after the timer of the same tick', async () => {
  const e = await setup(), L = e.level;
  const t = spawnT(e);
  t.LifeSpan = 0.05; t.TimerRate = 0.01; t.TimerCounter = 0;
  L.frame++;
  assert.deepEqual(watch(e, [t], ['Timer', 'Expired', 'Destroyed'], () => L.tickActor(t, 0.1)), [t.Name + '.Timer', t.Name + '.Expired', t.Name + '.Destroyed']);
  assert.ok(t.bDeleteMe);
});

test('level tick: owners tick before what they own, static actors never tick, new actors tick the same frame', async () => {
  const e = await setup(), L = e.level;
  const owned = spawnT(e, 310), owner = spawnT(e, 320);
  L.setOwner(owned, owner);
  // `owner` comes after `owned` in the list but ticks first; an actor spawned during the tick ticks in it
  let late = null;
  const vm = e.vm, ev = vm.event.bind(vm), order = [];
  vm.event = (o, n, ...a) => {
    if ((o === owner || o === owned) && n === 'Tick') order.push(o === owner ? 'owner' : 'owned');
    if (o === owner && n === 'Tick' && !late) late = spawnT(e, 330);
    return ev(o, n, ...a);
  };
  try { e.tick(1 / 30); } finally { vm.event = ev; }
  assert.deepEqual(order, ['owner', 'owned']);
  assert.ok(late && late.__tickFrame === L.frame, 'spawned during the tick, ticked in it');
  const st = L.actors.find(a => a.bStatic && a.Class.isA('Light'));
  assert.notEqual(st.__tickFrame, L.frame);
  for (const a of [owned, owner, late]) L.destroy(a);
});

test('only PlayerPawns with a viewport get player input; a script variable named Player does not count', async () => {
  const e = await setup(), L = e.level;
  const t = spawnT(e);
  t.Player = e.player; // e.g. SpellLearnTrigger's "var baseHarry Player"
  L.frame++;
  const log = watch(e, [t], ['Tick', 'PlayerTick', 'PlayerInput'], () => L.tickActor(t, 1 / 30));
  assert.ok(!log.some(x => /Player/.test(x)));
  L.destroy(t);
});

test('PlayAnim: frame from 0, tween rate 1/time, 2 when unspecified, none for 0; looping the same loop keeps going', async () => {
  const e = await setup(), A = e.level.anim, p = e.player;
  const names = [...A.info(p.Mesh).seqs.values()].filter(s => s.numFrames > 4).map(s => s.name);
  const [s1, s2] = names;
  A.playAnim(p, s1, 1, 0.25);
  assert.equal(p.AnimFrame, 0); assert.equal(p.TweenAlpha, 0); assert.equal(p.TweenRate, 4);
  const seq = A.seq(p, s1);
  assert.ok(Math.abs(p.AnimRate - seq.rate / seq.numFrames) < 1e-9);
  assert.ok(Math.abs(p.AnimLast - (1 - 1 / seq.numFrames)) < 1e-9);
  A.playAnim(p, s2); assert.equal(p.TweenRate, 2);
  A.playAnim(p, s1, 1, 0); assert.equal(p.TweenRate, 0); assert.equal(p.TweenAlpha, 1);
  A.playAnim(p, s1, 1, 0.1, true);
  A.tick(p, 0.05);
  const f = p.AnimFrame;
  A.playAnim(p, s1, 2, 0.1, true, 0.5);
  assert.equal(p.AnimFrame, f, 'already looping: frame kept');
  assert.ok(Math.abs(p.AnimRate - 2 * seq.rate / seq.numFrames) < 1e-9);
  assert.ok(Math.abs(p.AnimMinRate - 0.5 * seq.rate / seq.numFrames) < 1e-9, 'min rate in frames too');
});

const dummy = e => { const d = spawnT(e, 500); d.Mesh = e.player.Mesh; return d; };

test('anim tick: a one-shot stops on its last frame with one AnimEnd; TweenAnim ends when the tween does', async () => {
  const e = await setup(), A = e.level.anim, p = dummy(e);
  const name = [...A.info(p.Mesh).seqs.values()].find(s => s.numFrames > 4 && !s.notifys.length).name;
  A.playAnim(p, name, 1, 0);
  let ends = watch(e, [p], ['AnimEnd'], () => { for (let i = 0; i < 400; i++) A.tick(p, 1 / 30); });
  assert.equal(ends.length, 1);
  assert.equal(p.AnimFrame, p.AnimLast); assert.equal(p.AnimRate, 0); assert.equal(p.bAnimFinished, true);
  assert.equal(A.isAnimating(p), false);
  A.tweenAnim(p, name, 0.2);
  ends = watch(e, [p], ['AnimEnd'], () => A.tick(p, 0.1));
  assert.deepEqual(ends, []); assert.ok(Math.abs(p.TweenAlpha - 0.5) < 1e-9);
  ends = watch(e, [p], ['AnimEnd'], () => A.tick(p, 0.15));
  assert.equal(ends.length, 1); assert.equal(p.TweenAlpha, 1); assert.equal(p.TweenRate, 0);
});

test('anim tick: a loop wraps to 0 with AnimEnd as it passes the last frame', async () => {
  const e = await setup(), A = e.level.anim, p = dummy(e);
  const s = [...A.info(p.Mesh).seqs.values()].find(s => s.numFrames > 4 && !s.notifys.length);
  A.playAnim(p, s.name, 1, 0, true);
  const per = 1 / p.AnimRate; // seconds per full cycle
  let ends = watch(e, [p], ['AnimEnd'], () => A.tick(p, per * (p.AnimLast + 0.5 * (1 - p.AnimLast))));
  assert.equal(ends.length, 1, 'passed the last frame'); assert.ok(p.AnimFrame < 1 && p.AnimFrame >= p.AnimLast, 'stays in the last interval');
  ends = watch(e, [p], ['AnimEnd'], () => A.tick(p, per * 0.25));
  assert.deepEqual(ends, []); assert.ok(p.AnimFrame < 0.25, 'wrapped');
});

test('Sleep wakes within half a frame of its time; FinishInterpolation waits for bInterpolating', async () => {
  const e = await setup(), L = e.level;
  const t = spawnT(e);
  t.__latent = { kind: 'sleep', t: 0.1 };
  L.processLatent(t, 0.06); assert.ok(t.__latent);
  L.processLatent(t, 0.06); assert.equal(t.__latent, null, '-0.02 < 0.03');
  e.vm.natives.get(301)(t, []);
  t.bInterpolating = true; L.processLatent(t, 0.03); assert.ok(t.__latent);
  t.bInterpolating = false; L.processLatent(t, 0.03); assert.equal(t.__latent, null);
  L.destroy(t);
});

test('LineOfSightTo: seen across open floor, not through solid geometry', async () => {
  const e = await setup(), L = e.level, p = e.player, S = L.pawns;
  const t = spawnT(e, 120);
  assert.equal(S.lineOfSightTo(p, t), true);
  const wall = boxLineCheck(L.model, p.Location, { ...p.Location, X: p.Location.X + 2000 }, { X: 0, Y: 0, Z: 0 }); // level geometry only
  const behind = L.spawn(e.vm.cls('Trigger'), null, null, { ...p.Location, X: p.Location.X + 2000 * wall.time + 200 });
  assert.equal(S.lineOfSightTo(p, behind), false, 'behind the wall');
  L.destroy(t); L.destroy(behind);
});
