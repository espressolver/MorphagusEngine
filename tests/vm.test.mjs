// UnrealScript VM tests: class linking, defaults, Core natives, states.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assets } from './helpers.mjs';
import { VM } from '../src/uscript/vm.js';
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
const ref = v => ({ __ref: true, v, get() { return this.v; }, set(x) { this.v = x; } });

test('class hierarchy and defaults', async () => {
  const v = await getVM();
  const h = v.cls('Harry');
  assert.deepEqual(['Harry', 'baseHarry', 'PlayerPawn', 'Pawn', 'Actor', 'Object'], (() => { const r = []; for (let c = h; c; c = c.superClass) r.push(c.name); return r; })());
  assert.equal(h.defaults.GroundSpeed, 200);
  assert.equal(h.defaults.CollisionRadius, 15);
  // shadowed property: Actor.bSinglePlayer stays true for player pawns
  assert.equal(h.defaults.bSinglePlayer, true);
  assert.equal(v.cls('Light').defaults.LightBrightness, 64);
});

test('native parameter order follows declaration order', async () => {
  const v = await getVM();
  assert.deepEqual(v.nativeInfo.get(251).params.map(p => p.name), ['V', 'A', 'B']); // Clamp
});

test('integer, float, string and name operators', async () => {
  assert.equal(await nat(145, 7, 2), 3);           // int /
  assert.equal(await nat(144, 0x7fffffff, 2), -2); // int * wraps
  assert.equal(await nat(172, 1, 0), Infinity);    // float / 0 is not guarded (C float division)
  assert.equal(await nat(112, 'a', 'b'), 'ab');    // $
  assert.equal(await nat(168, 'a', 'b'), 'a b');   // @
  assert.equal(await nat(254, 'Harry', 'harry'), true); // names compare case-insensitively
  assert.equal(await nat(127, 'abcdef', 2, 3), 'cde'); // Mid
  assert.equal(await nat(234, 'abcdef', 2), 'ef');    // Right
  const r = ref(5); assert.equal(await nat(165, r), 5); assert.equal(r.v, 6); // post ++
});

test('vector and rotator operators', async () => {
  const x = await nat(276, { X: 1, Y: 0, Z: 0 }, { Pitch: 0, Yaw: 16384, Roll: 0 }); // vect >> rot
  assert.ok(Math.abs(x.X) < 1e-6 && Math.abs(x.Y - 1) < 1e-6);
  const back = await nat(275, x, { Pitch: 0, Yaw: 16384, Roll: 0 }); // << inverse
  assert.ok(Math.abs(back.X - 1) < 1e-6);
  assert.equal(await nat(225, { X: 3, Y: 4, Z: 0 }), 5); // VSize
  const n = await nat(226, { X: 0, Y: 0, Z: 9 }); assert.equal(n.Z, 1); // Normal
});

test('GotoState enters the auto state and handles empty names', async () => {
  const v = await getVM();
  const o = v.newObject(v.cls('spellnone'));
  v.gotoState(o, 'Auto');
  assert.equal(o.__state?.name, 'Flying');
  v.gotoState(o, '');
  assert.equal(o.__state, null);
});

test('auto state comes from the most-derived class', async () => {
  const v = await getVM();
  await v.loadPackages(['Hub5']);
  assert.equal(v.cls('baseChar').autoState?.name, 'patrol');
  assert.equal(v.cls('Fluffy').autoState?.name, 'awake'); // Fluffy's own 'auto state awake' overrides baseChar's patrol
});

test('Disable() only lasts until the next state change', async () => {
  const v = await getVM();
  const o = v.newObject(v.cls('spellnone'));
  (o.__disabled ??= new Set()).add('tick');
  v.gotoState(o, 'Flying');
  assert.ok(!o.__disabled || !o.__disabled.has('tick'));
});
