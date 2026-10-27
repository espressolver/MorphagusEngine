// Engine-side skeletal pose evaluation for script queries (BonePos): world-space bone positions
// for the actor's current AnimSequence/AnimFrame, using the same placement as the renderer.
import * as THREE from 'three';
import { sampleTrack, skelPlacement } from '../../render/skeletal.js';

const RU = Math.PI / 32768;
const _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _one = new THREE.Vector3(1, 1, 1);

function rotatorMatrix(rot, out) {
  const p = (rot?.Pitch ?? rot?.pitch ?? 0) * RU, y = (rot?.Yaw ?? rot?.yaw ?? 0) * RU, r = (rot?.Roll ?? rot?.roll ?? 0) * RU;
  const SP = Math.sin(p), CP = Math.cos(p), SY = Math.sin(y), CY = Math.cos(y), SR = Math.sin(r), CR = Math.cos(r);
  return out.set(CP * CY, SR * SP * CY - CR * SY, -(CR * SP * CY + SR * SY), 0,
    CP * SY, SR * SP * SY + CR * CY, CY * SR - CR * SP * SY, 0,
    SP, -SR * CP, CR * CP, 0, 0, 0, 0, 1);
}

// Unreal-space actor -> world matrix for a skeletal mesh (matches gamerenderer actorMatrix without the mirror)
function placement(a, mesh) { return skelPlacement(a, mesh); }

// Local bone transforms: reference pose overlaid with the current sequence frame
export function pose(mi, a) {
  const sk = mi.mesh.refSkeleton;
  const local = sk.map((b, i) => {
    const q = new THREE.Quaternion(...b.orient).conjugate(); // every bone, the root too, like the engine
    return { q, p: new THREE.Vector3(...b.pos) };
  });
  const anim = mi.anim, s = mi.seqs.get(String(a.AnimSequence || '').toLowerCase());
  const move = s && anim?.moves[s.index];
  if (move) {
    mi.boneIndex ??= new Map(sk.map((b, i) => [b.name.toLowerCase(), i]));
    const tm = move.__trackMap ??= move.tracks.map((_, ti) => { const rb = anim.refBones[ti]; return rb ? (mi.boneIndex.get(rb.name.toLowerCase()) ?? -1) : -1; });
    const frac = Math.min(1, Math.max(0, a.AnimFrame || 0));
    const t = Math.max(1, s.numFrames) > 1 ? frac * move.trackTime : 0;
    for (let ti = 0; ti < move.tracks.length; ti++) {
      const bi = tm[ti];
      if (bi < 0) continue;
      sampleTrack(move.tracks[ti], t, move.trackTime, !!a.bAnimLoop, _q, _p);
      _q.conjugate();
      local[bi].q.copy(_q);
      if (!(bi === 0 && a.bAnimMove)) local[bi].p.copy(_p); // (bAnimMove: the root keeps its reference position)
    }
  }
  const world = [];
  for (let i = 0; i < sk.length; i++) {
    const L = new THREE.Matrix4().compose(local[i].p, local[i].q, _one);
    world[i] = i === 0 || sk[i].parent === i ? L : world[sk[i].parent].clone().multiply(L);
  }
  return world;
}

// World position of `bone` on actor `a`, or null when the actor has no such bone
export function bonePos(level, a, bone) {
  const mi = level.anim.info(a.Mesh);
  if (!mi?.mesh?.refSkeleton) return null;
  mi.boneIndex ??= new Map(mi.mesh.refSkeleton.map((b, i) => [b.name.toLowerCase(), i]));
  const bi = mi.boneIndex.get(String(bone).toLowerCase());
  if (bi === undefined) return null;
  const w = pose(mi, a)[bi];
  const v = new THREE.Vector3().setFromMatrixPosition(w).applyMatrix4(placement(a, mi.mesh));
  return { X: v.x, Y: v.y, Z: v.z };
}

// Root-bone translation (mesh space) of the actor's current sequence at its current frame
export function rootLocal(level, a) {
  const mi = level.anim.info(a.Mesh);
  const s = mi?.seqs.get(String(a.AnimSequence || '').toLowerCase());
  const move = s && mi.anim?.moves[s.index];
  if (!move?.tracks.length) return null;
  const frac = Math.min(1, Math.max(0, a.AnimFrame || 0));
  const t = Math.max(1, s.numFrames) > 1 ? frac * move.trackTime : 0;
  sampleTrack(move.tracks[0], t, move.trackTime, false, _q, _p);
  return [_p.x, _p.y, _p.z];
}

// Mesh-space displacement -> world displacement (rotation, mesh orientation and scale; no translation)
export function meshDeltaToWorld(level, a, d) {
  const mi = level.anim.info(a.Mesh);
  if (!mi) return { X: d[0], Y: d[1], Z: d[2] };
  const m = placement(a, mi.mesh);
  m.setPosition(0, 0, 0);
  const v = new THREE.Vector3(d[0], d[1], d[2]).applyMatrix4(m);
  return { X: v.x, Y: v.y, Z: v.z };
}

// USkeletalMesh::GetFrame: world positions of the mesh points in the actor's current pose (each point the
// weighted sum of its per-weight bone-space local points), with the triangles as point indices
export function meshWorldVerts(level, a) {
  const mi = level.anim.info(a.Mesh), m = mi?.mesh;
  if (!m?.refSkeleton || !m.localPoints || m.localPoints.length !== m.boneWeights.length) return null;
  const world = pose(mi, a), place = placement(a, m), v = new THREE.Vector3();
  const acc = new Float64Array(m.points.length * 3);
  m.boneWeightIdx.forEach(([wi, n], bone) => {
    const W = world[bone];
    for (let k = 0; k < n; k++) {
      const j = wi + k, [pi, w] = m.boneWeights[j], lp = m.localPoints[j];
      if (pi >= m.points.length || !lp) continue;
      v.set(lp[0], lp[1], lp[2]).applyMatrix4(W);
      const f = w / 65535;
      acc[pi * 3] += v.x * f; acc[pi * 3 + 1] += v.y * f; acc[pi * 3 + 2] += v.z * f;
    }
  });
  const verts = [];
  for (let i = 0; i < m.points.length; i++) {
    v.set(acc[i * 3], acc[i * 3 + 1], acc[i * 3 + 2]).applyMatrix4(place);
    verts.push({ X: v.x, Y: v.y, Z: v.z });
  }
  m.__triPoints ??= m.faces.map(f => [m.wedges[f[0]].v, m.wedges[f[1]].v, m.wedges[f[2]].v]);
  return { verts, tris: m.__triPoints };
}

// USkeletalMesh::GetFrame weapon coordinates (ClassicWeaponCoords): WeaponAdjust in the weapon bone's frame,
// re-orthogonalised (Y = -(X ^ Z), the mirroring peculiarity). boneWorld: the weapon bone's world matrix
// (Unreal space). Returns the weapon's world matrix (columns = X/Y/Z axes, origin) and the Pawn.WeaponLoc /
// WeaponRot it yields
export function weaponFromBone(boneWorld, adjust) {
  const [o, x, y, z] = adjust || [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]];
  // the adjust coords map bone space -> weapon space (rows = axes); weapon -> bone has them as columns
  const adj = new THREE.Matrix4().set(x[0], y[0], z[0], o[0], x[1], y[1], z[1], o[1], x[2], y[2], z[2], o[2], 0, 0, 0, 1);
  const e = boneWorld.clone().multiply(adj).elements;
  const X = new THREE.Vector3(e[0], e[1], e[2]).normalize(), Z0 = new THREE.Vector3(e[8], e[9], e[10]);
  const Y = new THREE.Vector3().crossVectors(X, Z0).normalize().negate();
  const Z = new THREE.Vector3().crossVectors(X, Y.clone().negate());
  const loc = { X: e[12], Y: e[13], Z: e[14] };
  // FCoords::OrthoRotation
  const yaw = Math.atan2(X.y, X.x), pitch = Math.atan2(X.z, Math.hypot(X.x, X.y));
  const sy = new THREE.Vector3(-Math.sin(yaw), Math.cos(yaw), 0); // the Y axis of (pitch, yaw, 0)
  const roll = Math.atan2(Z.dot(sy), Y.dot(sy));
  const U = v => Math.round(v * 32768 / Math.PI);
  const matrix = new THREE.Matrix4().makeBasis(X, Y, Z).setPosition(loc.X, loc.Y, loc.Z);
  return { loc, rot: { Pitch: U(pitch), Yaw: U(yaw), Roll: U(roll) }, matrix };
}

// the same from the engine-side pose (no HP anim channels): headless runs, or actors not drawn this frame
export function weaponCoords(level, a) {
  const mi = level.anim.info(a.Mesh), m = mi?.mesh;
  const bi = m?.weaponBoneIndex ?? -1;
  if (!m?.refSkeleton || bi < 0 || bi >= m.refSkeleton.length) return null;
  return weaponFromBone(placement(a, m).multiply(pose(mi, a)[bi]), m.weaponAdjust);
}
