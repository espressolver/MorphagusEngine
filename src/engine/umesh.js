// UE1 (UT-style) SkeletalMesh / LodMesh / Animation readers.
import { readProperties } from './uobject.js';

function arr(r, fn) {
  const n = r.idx();
  const a = new Array(n);
  for (let i = 0; i < n; i++) a[i] = fn(r);
  return a;
}
function lazy(r, fn) {
  if (r.pkg.version >= 63) r.i32();
  return arr(r, fn);
}
const quat = r => [r.f32(), r.f32(), r.f32(), r.f32()];
const box = r => ({ min: r.vec(), max: r.vec(), valid: r.u8_() });
const sphere = r => (r.pkg.version > 61 ? [r.f32(), r.f32(), r.f32(), r.f32()] : [r.f32(), r.f32(), r.f32(), 0]);

function readAnimSeq(r) {
  const p = r.pkg;
  return {
    name: p.names[r.idx()],
    group: p.names[r.idx()],
    startFrame: r.i32(),
    numFrames: r.i32(),
    notifys: arr(r, r => ({ time: r.f32(), fn: p.names[r.idx()] })),
    rate: r.f32(),
  };
}

function readMeshBase(r) {
  const p = r.pkg;
  const m = {};
  m.props = readProperties(r);
  m.box = box(r); m.sphere = sphere(r);
  m.verts = lazy(r, r => r.u32());
  m.tris = lazy(r, r => ({ v: [r.u16(), r.u16(), r.u16()], uv: [r.u8_(), r.u8_(), r.u8_(), r.u8_(), r.u8_(), r.u8_()], flags: r.u32(), tex: r.i32() }));
  m.animSeqs = arr(r, readAnimSeq);
  m.connects = lazy(r, r => [r.i32(), r.i32()]);
  m.box2 = box(r); m.sphere2 = sphere(r);
  m.vertLinks = lazy(r, r => r.i32());
  m.textures = arr(r, r => { const ref = r.idx(); return ref ? p.refPath(ref) : null; });
  m.boxes = arr(r, box);
  m.spheres = arr(r, sphere);
  m.frameVerts = r.i32(); m.animFrames = r.i32();
  m.andFlags = r.u32(); m.orFlags = r.u32();
  m.scale = r.vec(); m.origin = r.vec();
  m.rotOrigin = { pitch: r.i32(), yaw: r.i32(), roll: r.i32() };
  m.curPoly = r.i32(); m.curVertex = r.i32();
  if (p.version === 65) r.f32();
  else if (p.version >= 66) m.textureLOD = arr(r, r => r.f32());
  return m;
}

function readLodMesh(r, m) {
  m.collapsePointThus = arr(r, r => r.u16());
  m.faceLevel = arr(r, r => r.u16());
  m.faces = arr(r, r => [r.u16(), r.u16(), r.u16(), r.u16()]);
  m.collapseWedgeThus = arr(r, r => r.u16());
  m.wedges = arr(r, r => ({ v: r.u16(), u: r.u8_(), t: r.u8_() }));
  m.materials = arr(r, r => ({ flags: r.u32(), tex: r.i32() }));
  m.specialFaces = arr(r, r => [r.u16(), r.u16(), r.u16(), r.u16()]);
  m.modelVerts = r.i32(); m.specialVerts = r.i32();
  m.meshScaleMax = r.f32(); m.lodHysteresis = r.f32(); m.lodStrength = r.f32();
  m.lodMinVerts = r.i32(); m.lodMorph = r.f32(); m.lodZDisplace = r.f32(); m.lodHighQuality = r.f32();
  return m;
}

// just the UMesh primitive part (BoundingBox, Scale, Origin, RotOrigin): enough for collision shapes
export function readMeshBounds(pkg, exp) {
  return readMeshBase(pkg.readerFor(exp));
}

export function readLodMesh_(pkg, exp) {
  const r = pkg.readerFor(exp);
  const m = readLodMesh(r, readMeshBase(r));
  // LodMesh vertex animation frames are in m.verts (packed 11/11/10)
  return m;
}

export function readSkeletalMesh(pkg, exp) {
  const r = pkg.readerFor(exp);
  const p = pkg;
  const m = readLodMesh(r, readMeshBase(r));
  m.extWedges = arr(r, r => ({ v: r.u16(), flags: r.u16(), u: r.f32(), t: r.f32() }));
  // Harry Potter extra array (always empty in shipped data)
  if (r.idx() !== 0) throw new Error('unexpected HP skeletal array');
  m.points = arr(r, r => r.vec());
  m.refSkeleton = arr(r, r => ({
    name: p.names[r.idx()], flags: r.u32(),
    orient: quat(r), pos: r.vec(), length: r.f32(), size: r.vec(),
    numChildren: r.i32(), parent: r.i32(),
  }));
  m.boneWeightIdx = arr(r, r => [r.u16(), r.u16(), r.u16(), r.u16()]);
  m.boneWeights = arr(r, r => [r.u16(), r.u16()]);
  m.localPoints = arr(r, r => r.vec());
  m.skeletalDepth = r.i32();
  { const ref = r.idx(); m.defaultAnim = ref ? p.refPath(ref) : null; }
  m.weaponBoneIndex = r.i32();
  m.weaponAdjust = [r.vec(), r.vec(), r.vec(), r.vec()];
  m._left = r.end - r.pos;
  return m;
}

// Harry Potter Animation: tracks store only key counts; keys are packed after AnimSeqs:
//   Quats: 3 x int16 FAnimVec (ANIM48): q.xyz = sin(v x (pi/2) / 32767), w = sqrt(1 - |xyz|^2)
//   Positions: 3 x int16 scaled by track.posScale/32767
//   Times: 1 byte frame delta per key (first = 0), frame length = track.frameTime
export function readAnimation(pkg, exp) {
  const r = pkg.readerFor(exp);
  const p = pkg;
  const a = {};
  a.props = readProperties(r);
  a.refBones = arr(r, r => ({ name: p.names[r.idx()], flags: r.u32(), parent: r.i32() }));
  a.moves = arr(r, r => ({
    rootSpeed: r.vec(), trackTime: r.f32(), startBone: r.i32(), flags: r.u32(),
    boneIndices: arr(r, r => r.i32()),
    tracks: arr(r, r => ({ flags: r.u32(), nq: r.idx(), np: r.idx(), nt: r.idx(), posScale: r.f32(), frameTime: r.f32() })),
  }));
  a.animSeqs = arr(r, readAnimSeq);
  const nq = r.idx();
  const qraw = new Int16Array(nq * 3);
  for (let i = 0; i < nq * 3; i++) qraw[i] = r.i16();
  const np = r.idx();
  const praw = new Int16Array(np * 3);
  for (let i = 0; i < np * 3; i++) praw[i] = r.i16();
  const nt = r.idx();
  const traw = r.bytes(nt);
  let qi = 0, pi = 0, ti = 0;
  for (const m of a.moves) for (const t of m.tracks) {
    t.keyQuat = new Float32Array(t.nq * 4);
    for (let k = 0; k < t.nq; k++, qi++) {
      // FAnimVec::Quat: components are stored as asin(q) scaled to +-32767
      const sc = Math.PI / 2 / 32767;
      const x = Math.sin(qraw[qi * 3] * sc), y = Math.sin(qraw[qi * 3 + 1] * sc), z = Math.sin(qraw[qi * 3 + 2] * sc);
      t.keyQuat[k * 4] = x; t.keyQuat[k * 4 + 1] = y; t.keyQuat[k * 4 + 2] = z;
      t.keyQuat[k * 4 + 3] = Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z));
    }
    t.keyPos = new Float32Array(t.np * 3);
    const sc = t.posScale / 32767;
    for (let k = 0; k < t.np * 3; k++) t.keyPos[k] = praw[pi * 3 + k] * sc;
    pi += t.np;
    t.keyTime = new Float32Array(t.nt);
    let acc = 0;
    for (let k = 0; k < t.nt; k++, ti++) { acc += traw[ti]; t.keyTime[k] = acc * t.frameTime; }
  }
  a._left = r.end - r.pos;
  return a;
}
