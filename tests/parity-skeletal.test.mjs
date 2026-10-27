// Parity tests: skeletal animation data and placement (UnSkeletalMesh.cpp).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { engine, tick } from './helpers.mjs';
import { sampleTrack, skelPlacement } from '../src/render/skeletal.js';

let shared;
const setup = async () => { if (!shared) { shared = await engine('Lev_Tut1'); tick(shared, 0.3); shared.restoreConsole(); } return shared; };

test('FAnimVec quaternions: q.xyz = sin(v x pi/2 / 32767) — the knight idle pose equals its reference skeleton', async () => {
  const e = await setup();
  const k = e.level.actors.find(a => a.Name === 'Knight0'), mi = e.level.anim.info(k.Mesh);
  const mv = mi.anim.moves[mi.seqs.get('idle').index];
  const q = new THREE.Quaternion(), p = new THREE.Vector3();
  for (let ti = 0; ti < mv.tracks.length; ti++) {
    sampleTrack(mv.tracks[ti], 0, mv.trackTime, false, q, p);
    const r = new THREE.Quaternion(...mi.mesh.refSkeleton[ti].orient);
    assert.ok(Math.abs(q.dot(r)) > 0.9999, `${mi.anim.refBones[ti].name}: ${q.toArray()} vs ${r.toArray()}`);
  }
});

test('GetPlace: past the last key the pose wraps toward key 0 at TrackTime', async () => {
  const tr = { nq: 2, np: 2, nt: 2, keyTime: new Float32Array([0, 1]), keyQuat: new Float32Array([0, 0, 0, 1, 0, 0, Math.SQRT1_2, Math.SQRT1_2]), keyPos: new Float32Array([0, 0, 0, 10, 0, 0]) };
  const q = new THREE.Quaternion(), p = new THREE.Vector3();
  sampleTrack(tr, 1.5, 2, false, q, p);
  assert.ok(Math.abs(p.x - 5) < 1e-6, 'half way from key 1 back to key 0: ' + p.x);
  sampleTrack(tr, 0.5, 2, false, q, p);
  assert.ok(Math.abs(p.x - 5) < 1e-6);
});

test('GetMeshCoords: Y is negated (Unreal coord peculiarity) — a mesh +Y point lands on the actor -Y side', async () => {
  const a = { Location: { X: 0, Y: 0, Z: 0 }, Rotation: { Pitch: 0, Yaw: 0, Roll: 0 }, DrawScale: 1 };
  const m = skelPlacement(a, { scale: [1, 1, 1], origin: [0, 0, 0], rotOrigin: { pitch: 0, yaw: 0, roll: 0 } });
  const v = new THREE.Vector3(0, 10, 0).applyMatrix4(m);
  assert.ok(Math.abs(v.y + 10) < 1e-6, String(v.y));
});

test('bAnimMove: the actor moves by the root motion and the root bone keeps its reference position', async () => {
  const e = await engine('Lev_Tut1b'); tick(e, 0.5);
  const c = e.level.actors.find(a => a.Name === 'bronzecauldron1'), z0 = c.Location.Z;
  e.vm.gotoState(c, 'turnover');
  tick(e, 4);
  assert.ok(c.bAnimMove && c.AnimSequence === 'tipped');
  assert.ok(Math.abs(c.Location.Z - z0 - 19.5 * 1.6) < 1.5, 'moved by the root motion: ' + (c.Location.Z - z0));
  const { pose } = await import('../src/game/engine/bones.js');
  const mi = e.level.anim.info(c.Mesh), w = pose(mi, c);
  const rp = new THREE.Vector3().setFromMatrixPosition(w[0]);
  assert.ok(rp.distanceTo(new THREE.Vector3(...mi.mesh.refSkeleton[0].pos)) < 1e-4, 'root at its reference position');
  e.restoreConsole();
});

test('one object per export: an actor listed twice in Level.Actors (Tut3b) is loaded once', async () => {
  const e = await engine('Lev_Tut3b');
  const names = new Map();
  for (const a of e.level.actors) names.set(a.Name, (names.get(a.Name) || 0) + 1);
  assert.deepEqual([...names].filter(([, n]) => n > 1), []);
  e.restoreConsole();
});
