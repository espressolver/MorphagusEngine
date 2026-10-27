// UE1 skeletal meshes -> three.js SkinnedMesh, plus a skeletal animation player.
import * as THREE from 'three';
import { readSkeletalMesh, readAnimation } from '../engine/umesh.js';
import { makeActorMaterial } from './actormaterial.js';

// Mirror matrix: Unreal (x,y,z) -> three (x,z,y)
export const MIRROR = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1);
const R = Math.PI / 32768;

// UE FRotator -> rotation matrix in Unreal space (columns = X,Y,Z axes)
export function rotatorMatrix(rot, out = new THREE.Matrix4()) {
  const p = (rot?.pitch || 0) * R, y = (rot?.yaw || 0) * R, r = (rot?.roll || 0) * R;
  const SP = Math.sin(p), CP = Math.cos(p), SY = Math.sin(y), CY = Math.cos(y), SR = Math.sin(r), CR = Math.cos(r);
  const X = [CP * CY, CP * SY, SP];
  const Yv = [SR * SP * CY - CR * SY, SR * SP * SY + CR * CY, -SR * CP];
  const Z = [-(CR * SP * CY + SR * SY), CY * SR - CR * SP * SY, CR * CP];
  out.set(X[0], Yv[0], Z[0], 0, X[1], Yv[1], Z[1], 0, X[2], Yv[2], Z[2], 0, 0, 0, 0, 1);
  return out;
}

export class MeshCache {
  constructor(ctx) { this.ctx = ctx; this.cache = new Map(); this.anims = new Map(); }

  async get(pkg, ref) {
    const res = await this.ctx.assets.resolve(pkg, ref);
    if (!res) return null;
    return this.fromExport(res.pkg, res.exp);
  }
  async getPath(path) {
    const res = await this.ctx.assets.resolvePath(path, 'SkeletalMesh');
    if (!res) return null;
    return this.fromExport(res.pkg, res.exp);
  }
  fromExport(pkg, exp) {
    let p = this.cache.get(exp);
    if (!p) {
      p = this._load(pkg, exp).catch(e => { console.warn('mesh', exp.name, e); return null; });
      this.cache.set(exp, p);
    }
    return p;
  }

  async anim(pkg, path) {
    let p = this.anims.get(path);
    if (!p) {
      p = (async () => {
        const res = await this.ctx.assets.resolvePath(path, 'Animation');
        if (!res) return null;
        const a = readAnimation(res.pkg, res.exp);
        a.name = res.exp.name;
        a.seqByName = new Map(a.animSeqs.map((s, i) => [s.name.toLowerCase(), i]));
        return a;
      })().catch(e => { console.warn('anim', path, e); return null; });
      this.anims.set(path, p);
    }
    return p;
  }

  async _load(pkg, exp) {
    if (exp.className !== 'SkeletalMesh') return null;
    const m = readSkeletalMesh(pkg, exp);
    m.name = exp.name;
    // per-point bone influences
    const infl = m.points.map(() => []);
    m.boneWeightIdx.forEach(([wi, n], bone) => {
      for (let k = 0; k < n; k++) {
        const [pi, w] = m.boneWeights[wi + k];
        if (infl[pi]) infl[pi].push([bone, w / 65535]);
      }
    });
    // UE1 skins with per-weight LocalPoints (bone space). Rebuild bind-space vertex positions from them;
    // some meshes' Points array is mirrored relative to the skeleton.
    const bindPts = m.points.map(pt => pt.slice());
    if (m.localPoints && m.localPoints.length === m.boneWeights.length) {
      const W = [];
      m.refSkeleton.forEach((b, i) => {
        const q = new THREE.Quaternion(b.orient[0], b.orient[1], b.orient[2], b.orient[3]);
        q.conjugate();
        const L = new THREE.Matrix4().compose(new THREE.Vector3(b.pos[0], b.pos[1], b.pos[2]), q, new THREE.Vector3(1, 1, 1));
        W[i] = i === 0 ? L : W[b.parent].clone().multiply(L);
      });
      const acc = m.points.map(() => [0, 0, 0, 0]);
      const v = new THREE.Vector3();
      m.boneWeightIdx.forEach(([wi, n], bone) => {
        for (let k = 0; k < n; k++) {
          const j = wi + k, [pi, w] = m.boneWeights[j], lp = m.localPoints[j];
          if (!acc[pi] || !lp) continue;
          v.set(lp[0], lp[1], lp[2]).applyMatrix4(W[bone]);
          const f = w / 65535;
          acc[pi][0] += v.x * f; acc[pi][1] += v.y * f; acc[pi][2] += v.z * f; acc[pi][3] += f;
        }
      });
      acc.forEach((a, i) => { if (a[3] > 0) bindPts[i] = [a[0] / a[3], a[1] / a[3], a[2] / a[3]]; });
    }
    const nw = m.wedges.length;
    const pos = new Float32Array(nw * 3), uv = new Float32Array(nw * 2);
    // UE skeletal vertices can have many influences (robes on the Weasley twins reach 13): keep up to 16 in
    // four index/weight sets instead of three.js's usual 4
    const SETS = 4;
    const si = Array.from({ length: SETS }, () => new Uint16Array(nw * 4)), sw = Array.from({ length: SETS }, () => new Float32Array(nw * 4));
    for (let i = 0; i < nw; i++) {
      const w = m.wedges[i];
      const p = bindPts[w.v] || [0, 0, 0];
      pos[i * 3] = p[0]; pos[i * 3 + 1] = p[1]; pos[i * 3 + 2] = p[2];
      uv[i * 2] = w.u / 255; uv[i * 2 + 1] = w.t / 255;
      const inf = (infl[w.v] || []).slice().sort((a, b) => b[1] - a[1]).slice(0, SETS * 4);
      let tot = inf.reduce((s, x) => s + x[1], 0) || 1;
      if (!inf.length) inf.push([0, 1]);
      for (let k = 0; k < inf.length; k++) { si[k >> 2][i * 4 + (k & 3)] = inf[k][0]; sw[k >> 2][i * 4 + (k & 3)] = inf[k][1] / tot; }
    }
    // faces grouped by material
    const byMat = new Map();
    for (const f of m.faces) {
      const mi = f[3];
      if (!byMat.has(mi)) byMat.set(mi, []);
      // reverse winding (UE clockwise)
      byMat.get(mi).push(f[0], f[2], f[1]);
    }
    const index = [];
    const geo = new THREE.BufferGeometry();
    const groups = [];
    for (const [mi, idx] of [...byMat.entries()].sort((a, b) => a[0] - b[0])) {
      groups.push({ start: index.length, count: idx.length, mat: mi });
      index.push(...idx);
    }
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si[0], 4));
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw[0], 4));
    for (let k = 1; k < SETS; k++) {
      geo.setAttribute('skinIndex' + k, new THREE.Float32BufferAttribute(Float32Array.from(si[k]), 4));
      geo.setAttribute('skinWeight' + k, new THREE.Float32BufferAttribute(sw[k], 4));
    }
    geo.setIndex(index);
    groups.forEach((g, i) => geo.addGroup(g.start, g.count, i));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    // textures
    const texPromises = m.textures.map(t => t ? this.ctx.textures.getPath(t) : null);
    const textures = await Promise.all(texPromises);
    const anim = m.defaultAnim ? await this.anim(pkg, m.defaultAnim) : null;
    return { mesh: m, geo, groups, textures, anim, pkg };
  }
}

// Bind-pose local transform of a bone (all bone quats are stored conjugated)
function boneLocal(b, i) {
  const q = new THREE.Quaternion(b.orient[0], b.orient[1], b.orient[2], b.orient[3]);
  q.conjugate(); // (the root too: its rotation is stored the same way as the other bones)
  return { q, p: new THREE.Vector3(b.pos[0], b.pos[1], b.pos[2]) };
}

// An instance of a skeletal mesh with its own pose + animation state.
export class SkelInstance {
  constructor(data, opts = {}) {
    this.data = data;
    const m = data.mesh;
    this.bones = m.refSkeleton.map((b, i) => {
      const bone = new THREE.Bone();
      bone.name = b.name;
      const L = boneLocal(b, i);
      bone.position.copy(L.p); bone.quaternion.copy(L.q);
      return bone;
    });
    m.refSkeleton.forEach((b, i) => { if (i > 0 && b.parent !== i) this.bones[b.parent].add(this.bones[i]); });
    this.boneIndex = new Map(m.refSkeleton.map((b, i) => [b.name.toLowerCase(), i]));
    this.root = new THREE.Group();          // Unreal-space container
    this.root.matrixAutoUpdate = false;
    this.uniforms = opts.uniforms || makeLightUniforms();
    const mats = data.groups.map(g => {
      const matInfo = m.materials[g.mat] || { flags: 0, tex: g.mat };
      let tex = opts.skins?.[matInfo.tex] || data.textures[matInfo.tex] || opts.skin || data.textures[0];
      return makeActorMaterial(tex, matInfo.flags | (opts.polyFlags || 0), this.uniforms, opts);
    });
    this.materials = mats;
    const sk = new THREE.SkinnedMesh(data.geo, mats);
    sk.frustumCulled = false;
    sk.add(this.bones[0]);
    sk.bind(new THREE.Skeleton(this.bones));
    this.mesh = sk;
    this.root.add(sk);
    // animation state
    this.anim = data.anim;
    this.seq = null; this.frame = 0; this.rate = 1; this.loop = false; this.playing = false;
    this.tweenFrom = null; this.tweenTime = 0; this.tweenDur = 0;
    this.trackMaps = new Map();
    this.onEnd = null;
    this.onNotify = null;
    this.bindPose = m.refSkeleton.map((b, i) => boneLocal(b, i));
  }

  setAnimation(anim) { this.anim = anim; this.trackMaps.clear(); }

  // ULodMesh level of detail (UnMeshRnLOD.h): only faces whose FaceLevel fits the vertex budget, each wedge
  // followed down CollapseWedgeThus until its point is inside the budget
  setLOD(subset) {
    const m = this.data.mesh;
    subset = Math.min(subset, m.modelVerts);
    if (subset === this.lodSubset) return;
    this.lodSubset = subset;
    if (subset >= m.modelVerts || !m.collapseWedgeThus?.length) { this.mesh.geometry = this.data.geo; return; }
    if (!this.lodGeo) {
      this.lodGeo = new THREE.BufferGeometry();
      for (const k in this.data.geo.attributes) this.lodGeo.setAttribute(k, this.data.geo.attributes[k]);
      this.lodGeo.boundingSphere = this.data.geo.boundingSphere;
    }
    const map = w => { let n = 0; while (m.wedges[w].v >= subset && n++ < 65536) w = m.collapseWedgeThus[w]; return w; };
    const byMat = new Map(this.data.groups.map(g => [g.mat, []]));
    m.faces.forEach((f, i) => {
      if (m.faceLevel[i] > subset) return;
      byMat.get(f[3])?.push(map(f[0]), map(f[2]), map(f[1]));
    });
    const index = [];
    this.lodGeo.clearGroups();
    this.data.groups.forEach((g, gi) => { const idx = byMat.get(g.mat); this.lodGeo.addGroup(index.length, idx.length, gi); for (const x of idx) index.push(x); });
    this.lodGeo.setIndex(index);
    this.mesh.geometry = this.lodGeo;
  }

  hasAnim(name) { return !!this.anim?.seqByName.has(String(name).toLowerCase()); }

  // UE-style: PlayAnim(seq, rate, tween) / LoopAnim(seq, rate, tween)
  play(name, rate = 1, tween = 0.1, loop = false) {
    if (!this.anim) return false;
    const idx = this.anim.seqByName.get(String(name).toLowerCase());
    if (idx === undefined) return false;
    if (this.seq === idx && loop && this.loop) { this.rate = rate; return true; }
    if (tween > 0 && this.seq !== null) {
      this.tweenFrom = this.bones.map(b => ({ q: b.quaternion.clone(), p: b.position.clone() }));
      this.tweenTime = 0; this.tweenDur = tween;
    } else this.tweenFrom = null;
    this.seq = idx; this.frame = 0; this.rate = rate; this.loop = loop; this.playing = true;
    this.lastNotifyFrame = -1;
    return true;
  }
  loopAnim(name, rate = 1, tween = 0.1) { return this.play(name, rate, tween, true); }
  get seqName() { return this.seq === null ? null : this.anim.animSeqs[this.seq].name; }

  _trackMap(move) {
    let tm = this.trackMaps.get(move);
    if (!tm) {
      const a = this.anim;
      // One track per animation reference bone (boneIndices is not reliable in HP data)
      tm = move.tracks.map((_, ti) => {
        const rb = a.refBones[ti];
        return rb ? (this.boneIndex.get(rb.name.toLowerCase()) ?? -1) : -1;
      });
      this.trackMaps.set(move, tm);
    }
    return tm;
  }

  update(dt) {
    if (!this.anim || this.seq === null) return;
    const s = this.anim.animSeqs[this.seq];
    const move = this.anim.moves[this.seq];
    const frames = Math.max(1, s.numFrames);
    if (this.playing) {
      const prev = this.frame;
      this.frame += dt * s.rate * this.rate;
      // notifies (time is 0..1 fraction)
      if (s.notifys.length && this.onNotify) for (const n of s.notifys) {
        const nf = n.time * frames;
        if (prev <= nf && this.frame > nf) this.onNotify(n.fn, s.name);
      }
      if (this.frame >= frames - (this.loop ? 0 : 1)) {
        if (this.loop) this.frame %= frames;
        else { this.frame = frames - 1; this.playing = false; const cb = this.onEnd; cb?.(s.name); }
      }
    }
    if (!move) return;
    const tt = move.trackTime;
    // AnimFrame fraction f maps to key time f * trackTime (keys at k/rate, last key at (n-1)/rate)
    const t = frames > 1 ? (this.frame / frames) * tt : 0;
    const tm = this._trackMap(move);
    const q = new THREE.Quaternion(), q2 = new THREE.Quaternion();
    for (let ti = 0; ti < move.tracks.length; ti++) {
      const bi = tm[ti];
      if (bi < 0) continue;
      const tr = move.tracks[ti];
      const bone = this.bones[bi];
      sampleTrack(tr, t, tt, this.loop, q, bone.position);
      q.conjugate();
      bone.quaternion.copy(q);
    }
    if (this.tweenFrom) {
      this.tweenTime += dt;
      const k = Math.min(1, this.tweenTime / this.tweenDur);
      for (let i = 0; i < this.bones.length; i++) {
        const f = this.tweenFrom[i];
        q2.copy(f.q).slerp(this.bones[i].quaternion, k);
        this.bones[i].quaternion.copy(q2);
        this.bones[i].position.lerpVectors(f.p, this.bones[i].position, k);
      }
      if (k >= 1) this.tweenFrom = null;
    }
  }
}

// Sample sequence `seqIdx` at fraction `frac` into the instance's bones; `mask` (Set of bone indices) limits
// which bones are written (anim channels / partial-skeleton anims).
SkelInstance.prototype.applySeq = function (seqIdx, frac, loop, mask) {
  const anim = this.anim;
  const s = anim?.animSeqs[seqIdx], move = anim?.moves[seqIdx];
  if (!s || !move) return;
  const tt = move.trackTime;
  const t = Math.max(1, s.numFrames) > 1 ? frac * tt : 0;
  const tm = this._trackMap(move);
  const q = new THREE.Quaternion();
  for (let ti = 0; ti < move.tracks.length; ti++) {
    const bi = tm[ti];
    if (bi < 0 || (mask && !mask.has(bi))) continue;
    const bone = this.bones[bi];
    sampleTrack(move.tracks[ti], t, tt, loop, q, bone.position);
    q.conjugate();
    bone.quaternion.copy(q);
  }
};

// Bone indices of the subtree rooted at bone `name` (case-insensitive)
SkelInstance.prototype.subtree = function (name) {
  this._subtrees ??= new Map();
  const key = String(name).toLowerCase();
  if (this._subtrees.has(key)) return this._subtrees.get(key);
  const root = this.boneIndex.get(key);
  let set = null;
  if (root !== undefined) {
    set = new Set([root]);
    const sk = this.data.mesh.refSkeleton;
    for (let changed = true; changed;) {
      changed = false;
      for (let i = 0; i < sk.length; i++) if (!set.has(i) && set.has(sk[i].parent) && i !== sk[i].parent) { set.add(i); changed = true; }
    }
  }
  this._subtrees.set(key, set);
  return set;
};

const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();
// USkeletalMesh GetPlace: the keys around FrameTime (key B = the first whose time exceeds it; past the last
// key it wraps to key 0 at TrackTime, looping or not), quaternions slerped, positions lerped with the same
// keys (a single position key holds for the whole track)
export function sampleTrack(tr, t, trackTime, loop, outQ, outP) {
  const n = tr.nq, T = tr.keyTime;
  let kA = 0, kB = 0, alpha = 0;
  if (n > 1) {
    let tA = 0, tB = 0;
    for (kB = 1; kB < n; kB++) { tB = T[kB]; if (tB > t) break; tA = tB; }
    kA = kB - 1;
    if (tA === t) kB = kA;
    else if (kB >= n) { kB = 0; tB = trackTime; kA = n - 1; }
    if (kA !== kB && tB > tA) alpha = (t - tA) / (tB - tA);
  }
  _qa.set(tr.keyQuat[kA * 4], tr.keyQuat[kA * 4 + 1], tr.keyQuat[kA * 4 + 2], tr.keyQuat[kA * 4 + 3]);
  if (kA === kB) outQ.copy(_qa);
  else {
    _qb.set(tr.keyQuat[kB * 4], tr.keyQuat[kB * 4 + 1], tr.keyQuat[kB * 4 + 2], tr.keyQuat[kB * 4 + 3]);
    outQ.copy(_qa).slerp(_qb, alpha);
  }
  if (tr.np <= 1) outP.set(tr.keyPos[0], tr.keyPos[1], tr.keyPos[2]);
  else {
    const a = Math.min(kA, tr.np - 1), b = Math.min(kB, tr.np - 1), f = kA === kB ? 0 : alpha;
    outP.set(
      tr.keyPos[a * 3] + (tr.keyPos[b * 3] - tr.keyPos[a * 3]) * f,
      tr.keyPos[a * 3 + 1] + (tr.keyPos[b * 3 + 1] - tr.keyPos[a * 3 + 1]) * f,
      tr.keyPos[a * 3 + 2] + (tr.keyPos[b * 3 + 2] - tr.keyPos[a * 3 + 2]) * f,
    );
  }
}

export function makeLightUniforms() {
  const six = f => [0, 1, 2, 3, 4, 5].map(f);
  return {
    ambient: { value: new THREE.Color(0.2, 0.2, 0.2) },
    lightPos: { value: six(() => new THREE.Vector3()) },
    lightColor: { value: six(() => new THREE.Color(0, 0, 0)) },
    lightRadius: { value: six(() => 1) },
    lightRMult: { value: six(() => 1) },
    lightSrc: { value: six(() => 0) },
    lightDir: { value: six(() => new THREE.Vector3(0, 0, 1)) },
    diffuse: { value: 2 },
    fogZone: { value: 0 },
    specular: { value: 0 },
    specMinCos: { value: 0 },
    unlitLight: { value: new THREE.Color(0.5, 0.5, 0.5) },
    glow: { value: 1 },
    opacity: { value: 1 },
  };
}

// USkeletalMesh::GetMeshCoords as a matrix (Unreal space): -Origin, Scale x DrawScale (XY also x Wideness/128,
// Y negated), RotOrigin, then PrePivot + MeshAdjust in the actor's frame, Rotation, Location. MeshAdjust
// (bAlignBottom on a world-colliding, moving, non-CT_Shape actor) puts the mesh's lowest bind point 2.5 below
// the bottom of the collision cylinder.
const _pm = new THREE.Matrix4(), _pt = new THREE.Matrix4();
export function skelPlacement(a, mesh, out = new THREE.Matrix4()) {
  const L = a.Location, pp = a.PrePivot || { X: 0, Y: 0, Z: 0 }, ds = a.DrawScale ?? 1, ms = mesh.scale || [1, 1, 1], o = mesh.origin || [0, 0, 0];
  const wide = (a.Wideness ?? 128) / 128;
  let adj = 0;
  if (a.bAlignBottom && a.bCollideWorld && (a.Physics | 0) !== 0 && (a.CollideType | 0) !== 3) {
    const minZ = mesh.box?.min?.[2] ?? 0;
    adj = -(a.CollisionHeight || 0) - 2.5 + (o[2] - minZ) * ms[2] * ds;
  }
  out.makeTranslation(L.X, L.Y, L.Z);
  out.multiply(rotatorMatrix({ pitch: a.Rotation.Pitch, yaw: a.Rotation.Yaw, roll: a.Rotation.Roll }, _pt));
  out.multiply(_pt.makeTranslation(pp.X, pp.Y, pp.Z + adj));
  out.multiply(rotatorMatrix(mesh.rotOrigin, _pt));
  out.multiply(_pt.makeScale(ms[0] * ds * wide, -ms[1] * ds * wide, ms[2] * ds)); // (Y negated: "Unreal coord peculiarity")
  out.multiply(_pt.makeTranslation(-o[0], -o[1], -o[2]));
  return out;
}
