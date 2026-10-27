// Parity tests: script VM rules from Core (UnCorSc.cpp, UnMath.cpp, UnString.h) and the HP1 Core.dll
// formats (see docs/engine-parity.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assets, engine, tick } from './helpers.mjs';
import { VM, fmtFloat, vecToRot } from '../src/uscript/vm.js';
import { installCoreNatives } from '../src/uscript/natives_core.js';

let vm;
async function getVM() {
  if (vm) return vm;
  vm = new VM(await assets());
  await vm.loadPackages(['Core', 'Engine', 'HPBase', 'HarryPotter']);
  installCoreNatives(vm);
  vm.indexNatives();
  return vm;
}
const nat = async (i, ...args) => (await getVM()).natives.get(i)(null, args);
const named = async (n, ...args) => (await getVM()).namedNatives.get(n)(null, args);
import { EX } from '../src/uscript/loader.js';

test('string(float) is printf %f; string(rotator) wraps to 0..65535', async () => {
  const v = await getVM();
  assert.equal(fmtFloat(1.5), '1.500000');
  assert.equal(fmtFloat(-0.25), '-0.250000');
  assert.equal(v.convert(EX.VectorToString, { X: 1, Y: 2.5, Z: -3 }), '1.000000,2.500000,-3.000000');
  assert.equal(v.convert(EX.RotatorToString, { Pitch: -1, Yaw: 70000, Roll: 5 }), '65535,4464,5');
});

test('string to bool: True/False by name, otherwise a number', async () => {
  const v = await getVM();
  assert.equal(v.convert(EX.StringToBool, 'TRUE'), true);
  assert.equal(v.convert(EX.StringToBool, 'false'), false);
  assert.equal(v.convert(EX.StringToBool, 'yes'), false);
  assert.equal(v.convert(EX.StringToBool, '2'), true);
});

test('Mid/Left/Right clamp like FString (a negative Mid start gives nothing)', async () => {
  assert.equal(await nat(127, 'abcdef', 2, 3), 'cde');
  assert.equal(await nat(127, 'abcdef', 4), 'ef');
  assert.equal(await nat(127, 'abcdef', -1, 3), '');
  assert.equal(await nat(127, 'abcdef', 2, -1), '');
  assert.equal(await nat(128, 'abc', 5), 'abc');
  assert.equal(await nat(128, 'abc', -2), '');
  assert.equal(await nat(234, 'abc', 2), 'bc');
  assert.equal(await nat(124, 'Abc', 'aBC'), true); // ~= ignores case
  assert.equal(await nat(122, 'Abc', 'aBC'), false); // == does not
});

test('rotator(vector) truncates at MAXWORD/2pi; Normal is zero for tiny vectors; Mirror normalises', async () => {
  assert.deepEqual(vecToRot({ X: 0, Y: 1, Z: 0 }), { Pitch: 0, Yaw: 16383, Roll: 0 });
  assert.deepEqual(vecToRot({ X: -1, Y: -1e-9, Z: 0 }), { Pitch: 0, Yaw: -32767, Roll: 0 });
  assert.deepEqual(await nat(226, { X: 1e-5, Y: 0, Z: 0 }), { X: 0, Y: 0, Z: 0 });
  assert.deepEqual(await nat(300, { X: 1, Y: -1, Z: 0 }, { X: 0, Y: 10, Z: 0 }), { X: 1, Y: 1, Z: 0 });
});

test('division is not guarded: x/0 is infinite for floats, vectors and rotators scale by 1/x', async () => {
  assert.equal(await nat(172, 1, 0), Infinity);
  assert.equal(await nat(145, 7, 0), 0); // ints are guarded
  assert.deepEqual(await nat(289, { Pitch: 100, Yaw: 7, Roll: -7 }, 2), { Pitch: 50, Yaw: 4, Roll: -4 }); // rounded to even (appRound)
});

test('Normalize and OrthoRotation', async () => {
  assert.deepEqual(await named('object.normalize', { Pitch: 40000, Yaw: -40000, Roll: 65536 }), { Pitch: -25536, Yaw: 25536, Roll: 0 });
  const r = await named('object.orthorotation', { X: 0, Y: 1, Z: 0 }, { X: -1, Y: 0, Z: 0 }, { X: 0, Y: 0, Z: 1 });
  assert.deepEqual(r, { Pitch: 0, Yaw: 16384, Roll: 0 });
});

test('GotoState: same state only jumps to the label (keeps Disable), unknown state leaves the state', async () => {
  const v = await getVM();
  const o = v.newObject(v.cls('spellnone'));
  v.gotoState(o, 'Flying');
  (o.__disabled ??= new Set()).add('tick');
  o.__latent = { kind: 'sleep', t: 5 };
  const ends = [];
  const orig = v.event.bind(v);
  v.event = (x, n, ...a) => { if (x === o) ends.push(n); return orig(x, n, ...a); };
  try {
    v.gotoState(o, 'Flying');
    assert.deepEqual(ends, [], 'no EndState/BeginState for the state it is in');
    assert.ok(o.__disabled.has('tick'));
    assert.equal(o.__latent, null, 'latent action cancelled by the label jump');
    v.gotoState(o, 'NoSuchState');
    assert.equal(o.__state, null, 'left the state');
    assert.ok(ends.includes('EndState'));
  } finally { v.event = orig; }
});

test('GotoLabel finds labels in parent states', async () => {
  const v = await getVM();
  const parent = { name: 'P', labels: new Map([['begin', 0], ['later', 7]]), jumpMap: new Map([[0, 0], [7, 3]]), superState: null };
  const child = { name: 'C', labels: new Map([['begin', 0]]), jumpMap: new Map([[0, 0]]), superState: parent };
  const o = { __state: child, Class: { name: 'X' } };
  assert.equal(v.gotoLabel(o, 'later'), true);
  assert.equal(o.__stateFrame.state, parent);
  assert.equal(o.__stateFrame.pc, 3);
  assert.equal(v.gotoLabel(o, 'missing'), false);
  assert.equal(o.__stateFrame, null);
});

test('array index: fixed arrays clamp, dynamic arrays grow', async () => {
  const v = await getVM();
  const fr = { f: { name: 't' }, self: { Class: { name: 'T' } } };
  const fixed = [1, 2, 3];
  assert.equal(v.arrayIndex(fixed, 7, false, fr), 2);
  assert.equal(v.arrayIndex(fixed, -3, false, fr), 0);
  const dyn = [{ X: 1, Y: 2, Z: 3 }];
  assert.equal(v.arrayIndex(dyn, 3, true, fr), 3);
  assert.equal(dyn.length, 4);
  assert.deepEqual(dyn[3], { X: 0, Y: 0, Z: 0 });
});

test('casts to intrinsic classes (Sound) keep assets of that class: dialog lines are found and played', async () => {
  const e = await engine('Lev_Tut1');
  tick(e, 0.5);
  assert.ok(e.assets.loaded.has('alldialog'), 'the dialog package is loaded before the level runs');
  const played = [];
  const saved = e.audio;
  e.audio = { playSound: (a, ref) => played.push(ref?.Name), duration: () => 2, stopSound() {}, modifySound() {} };
  const narr = e.level.actors.find(a => a.Class.isA('baseNarrator'));
  const o1 = { __ref: true, v: null, get() { return this.v; }, set(x) { this.v = x; } }, o2 = { __ref: true, v: '', get() { return this.v; }, set(x) { this.v = x; } };
  e.vm.invoke(e.vm.findFunction(narr, 'finddialog'), narr, ['DUMBLEDORE_01', o1, o2]);
  assert.equal(String(o1.v?.Name).toLowerCase(), 'dumbledore_01');
  assert.ok(!String(o2.v).startsWith('*'), 'no missing-sound marker on the subtitle');
  const d = e.vm.invoke(e.vm.findFunction(narr, 'deliverdialog'), narr, ['DUMBLEDORE_01']);
  assert.equal(d, 2.5, 'duration from the sound + 0.5');
  assert.deepEqual(played.map(n => String(n).toLowerCase()), ['dumbledore_01']);
  e.audio = saved;
});
