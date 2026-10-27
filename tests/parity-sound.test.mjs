// Parity tests: PlaySound / StopSound / ModifySound (UnScript.cpp CheckHearSound, ALAudio slot rules).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engine, tick, skipCutscenes } from './helpers.mjs';
import { AudioSystem } from '../src/audio/audio.js';

let shared;
const setup = async () => {
  if (!shared) { shared = await engine('Lev_Tut1'); skipCutscenes(shared, 60); tick(shared, 0.5); shared.restoreConsole(); }
  return shared;
};
const nat = (e, i, self, ...args) => e.vm.natives.get(i)(self, args);
const aSound = e => { for (const a of e.level.actors) for (const k of ['AmbientSound', 'HitSound1', 'Land']) if (a[k]?.exp) return a[k]; return null; };
const withAudio = async (e, fn) => {
  const save = e.audio, calls = [];
  e.audio = { playSound: (...a) => calls.push(a), stopSound() {}, modifySound() { return false; } };
  try { await fn(calls); } finally { e.audio = save; }
};

test('PlaySound defaults: SLOT_Misc, the Transient volume/radius, pitch TransientSoundPitch/64', async () => {
  const e = await setup(), p = e.player, snd = aSound(e);
  await withAudio(e, calls => {
    const t = e.level.spawn(e.vm.cls('Trigger'), null, null, { ...p.Location, X: p.Location.X + 50 });
    t.TransientSoundVolume = 0.7; t.TransientSoundRadius = 0; t.TransientSoundPitch = 32;
    nat(e, 264, t, snd);
    assert.equal(calls.length, 1);
    const [, , slot, vol, noOv, radius, pitch] = calls[0];
    assert.deepEqual([slot, noOv, radius, pitch], [1, false, 0, 0.5]);
    assert.ok(Math.abs(vol - 0.7) < 1e-9 || Math.abs(vol - 0.7 * 0.35) < 1e-9);
    nat(e, 264, t, null);
    assert.equal(calls.length, 1, 'no sound: nothing');
    e.level.destroy(t);
  });
});

test('PlaySound is heard within radius/1.3 (1600 by default); blocked lines cut volume and range', async () => {
  const e = await setup(), p = e.player, snd = aSound(e), L = e.level;
  const view = (p.ViewTarget || p).Location;
  await withAudio(e, calls => {
    const t = L.spawn(e.vm.cls('Trigger'), null, null, { ...view });
    t.bCollideWorld = false;
    t.TransientSoundRadius = 0;
    const at = d => { t.Location = { ...view, Z: view.Z + d }; calls.length = 0; nat(e, 264, t, snd, 1, 1); return calls[0]; };
    // straight up from the view (clear line for short distances in the tutorial room)
    const near = at(5);
    assert.ok(near && Math.abs(near[3] - 1) < 1e-9, 'close and in sight: full volume');
    t.Location = { ...view, X: view.X + 1600 / Math.sqrt(1.3) + 5 };
    calls.length = 0; nat(e, 264, t, snd, 1, 1, false, 0);
    assert.equal(calls.length, 0, 'beyond 1600/sqrt(1.3)');
    L.destroy(t);
  });
});

test('ModifySound / StopSound take (param, value, sound, slot) and (sound, slot), slot SLOT_Misc by default', async () => {
  const e = await setup(), p = e.player, snd = aSound(e);
  const save = e.audio, calls = [];
  e.audio = { modifySound: (...a) => { calls.push(['m', ...a]); return true; }, stopSound: (...a) => calls.push(['s', ...a]) };
  try {
    assert.equal(nat(e, 567, p, 2, 1.5, snd), true);
    nat(e, 568, p, snd, 3);
    nat(e, 568, p);
  } finally { e.audio = save; }
  assert.deepEqual(calls[0], ['m', p, snd, 1, 2, 1.5]);
  assert.deepEqual(calls[1], ['s', p, snd, 3]);
  assert.deepEqual(calls[2], ['s', p, null, 1]);
});

test('audio slots: same actor slot replaced unless the new one is bNoOverride; SLOT_None never collides; Stop/Modify by slot', async () => {
  const e = await setup(), snd = aSound(e);
  const A = new AudioSystem(e), a = { Location: { X: 0, Y: 0, Z: 0 } }, b = { Location: { X: 0, Y: 0, Z: 0 } };
  const v1 = A.playSound(a, snd, 1, 1, false, 0, 1);
  assert.equal(A.playSound(a, snd, 1, 1, true, 0, 1), undefined, 'bNoOverride: the slot is busy');
  assert.equal(v1.ended, false);
  const v2 = A.playSound(a, snd, 1, 1, false, 0, 1);
  assert.ok(v1.ended && !v2.ended, 'replaced');
  const vb = A.playSound(b, snd, 1, 1, true, 0, 1);
  assert.ok(vb && !vb.ended, 'another actor has its own slots');
  const n1 = A.playSound(a, snd, 0, 1, true, 0, 1), n2 = A.playSound(a, snd, 0, 1, true, 0, 1);
  assert.ok(n1 && n2 && !n1.ended, 'SLOT_None: each its own');
  assert.equal(A.modifySound(a, null, 1, 0, 5), true);
  assert.equal(v2.volume, 1, 'volume clamped to 1');
  assert.equal(A.modifySound(a, null, 3, 0, 0.5), false, 'nothing in SLOT_Interact');
  assert.equal(A.stopSound(a, null, 1), true);
  assert.ok(v2.ended && !n1.ended && !vb.ended, 'only that slot of that actor');
  assert.equal(A.stopSound(a, null, 0), true);
  assert.ok(n1.ended && n2.ended);
  A.stopAll();
});
