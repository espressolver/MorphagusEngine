// Renders the engine's live level: BSP + actor visuals driven by VM actor state, camera via PlayerCalcView.
import * as THREE from 'three';
import { buildLevelGeometry } from './level.js';
import { MeshCache, SkelInstance, MIRROR, rotatorMatrix, makeLightUniforms, skelPlacement } from './skeletal.js';
import { makeActorMaterial } from './actormaterial.js';
import { lightFromProps, hsvColor, staticLightColor, surfLightKind, GlobalRandoms, lightTypeScale } from './lighting.js';
import { shared, MAX_DYN, MAX_VOL } from './materials.js';
import { PF } from '../engine/upackage.js';
import { ParticleVisual } from './particlerender.js';
import { Portals } from './portals.js';
import { weaponFromBone } from '../game/engine/bones.js';

const _m = new THREE.Matrix4(), _r = new THREE.Matrix4(), _s = new THREE.Matrix4();
const RU = Math.PI / 32768;

// Unreal-space actor -> three matrix (mirror included)
const _w = new THREE.Matrix4(), _w2 = new THREE.Matrix4(), _w3 = new THREE.Matrix4();
function actorMatrix(a, mesh, out) {
  const loc = a.Location, pp = a.PrePivot || { X: 0, Y: 0, Z: 0 };
  out.copy(MIRROR);
  // skeletal meshes: USkeletalMesh::GetMeshCoords (PrePivot and the bottom alignment in the actor's frame)
  if (mesh && mesh.refSkeleton) return out.multiply(skelPlacement(a, mesh, _m));
  // vertex meshes / sprites: Location + PrePivot, Rotation, RotOrigin, Scale, -Origin
  out.multiply(_m.makeTranslation(loc.X + pp.X, loc.Y + pp.Y, loc.Z + pp.Z));
  out.multiply(rotatorMatrix({ pitch: a.Rotation.Pitch, yaw: a.Rotation.Yaw, roll: a.Rotation.Roll }, _r));
  const ds = a.DrawScale ?? 1;
  if (mesh) {
    out.multiply(rotatorMatrix(mesh.rotOrigin, _r));
    const ms = mesh.scale || [1, 1, 1];
    out.multiply(_s.makeScale(ms[0] * ds, ms[1] * ds, ms[2] * ds));
    const o = mesh.origin || [0, 0, 0];
    out.multiply(_m.makeTranslation(-o[0], -o[1], -o[2]));
  } else out.multiply(_s.makeScale(ds, ds, ds));
  return out;
}

function brushMatrix(a, out) {
  const loc = a.Location, pp = a.PrePivot || { X: 0, Y: 0, Z: 0 };
  out.copy(MIRROR);
  out.multiply(_m.makeTranslation(loc.X, loc.Y, loc.Z));
  out.multiply(rotatorMatrix({ pitch: a.Rotation.Pitch, yaw: a.Rotation.Yaw, roll: a.Rotation.Roll }, _r));
  const ms = a.MainScale?.Scale || { X: 1, Y: 1, Z: 1 };
  out.multiply(_s.makeScale(ms.X || 1, ms.Y || 1, ms.Z || 1));
  out.multiply(_m.makeTranslation(-pp.X, -pp.Y, -pp.Z));
  return out;
}

export class GameRenderer {
  constructor(ctx, engine) {
    this.ctx = ctx;
    this.engine = engine;
    this.renderer = ctx.renderer;
    this.meshes = ctx.meshes || (ctx.meshes = new MeshCache(ctx));
    this.camera = new THREE.PerspectiveCamera(90, 1, 4, 65536);
    this.skyCam = new THREE.PerspectiveCamera();
    this.visuals = new Map(); // actor -> visual
    this.weaponVisuals = new Map(); // weapon -> visual of its ThirdPersonMesh
  }

  async setLevel(level) {
    this.dispose();
    this.level = level;
    const pkg = level.pkg;
    // adapter: export ref -> { props } for lighting/zone code
    const byRef = new Map();
    for (const [exp, o] of level.objMap) byRef.set(exp.index + 1, { props: o });
    this.geo = await buildLevelGeometry(this.ctx, pkg, pkg.exports.find(e => e.className === 'Level') ? this.modelRef(pkg) : 0, byRef);
    this.scene = new THREE.Scene();
    this.scene.add(this.geo.root);
    this.portals = new Portals(this.renderer);
    for (const pe of this.geo.portals || []) this.portals.add(pe);
    this.backdropMats = [];
    this.geo.skyBackdrop.traverse(o => { if (o.isMesh) this.backdropMats.push(o.material); });
    this.sky = level.actors.find(a => a.Class.isA('SkyZoneInfo'));
    // the level's fixed lights (moving ones are gathered each frame)
    this.lights = [];
    for (const a of level.actors) {
      if (!a.bStatic && !a.bNoDelete) continue;
      const L = lightFromProps(a, a.Location);
      if (L && L.brightness > 0) { L.actor = a; L.fc = staticLightColor(L, level.levelInfo.Brightness ?? 1); this.lights.push(L); }
    }
    // preload visuals for current actors
    await Promise.all(level.actors.map(a => this.ensureVisual(a)));
  }

  modelRef(pkg) {
    const levelExp = pkg.exports.find(e => e.className === 'Level');
    // readLevel already parsed in GameLevel; recompute model ref quickly
    return this.level.modelRef ?? (this.level.modelRef = pkg.exports.findIndex(e => e === this.level.modelExp) + 1 || this._findModel(pkg, levelExp));
  }
  _findModel(pkg) {
    // the level's Model is the Model export referenced by the Level object; GameLevel stores it
    return this.level.levelModelRef;
  }

  dispose() {
    if (!this.scene) return;
    this.scene.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    for (const p of this.geo?.pages || []) p.dispose();
    this.visuals.clear();
    this.weaponVisuals.clear();
    this.scene = null;
  }

  wantsVisual(a) {
    if (a.__deleted) return false;
    if (a.__isParticleFX ?? (a.__isParticleFX = a.Class.isA('ParticleFX'))) return true;
    const dt = a.DrawType ?? 1;
    if (dt === 2) return !!a.Mesh;
    if (a.__canvasFrame !== undefined && a.Mesh) return true;
    if (dt === 3) return !!a.Brush && !!a.__moverMesh;
    if (dt === 1 || dt === 7) return !!(a.Texture && !a.bHidden && a.Texture.exp && !isEditorSprite(a));
    return false;
  }

  ensureVisual(a) {
    if (this.visuals.has(a)) return this.visuals.get(a).ready;
    if (!this.wantsVisual(a)) return null;
    const v = { actor: a, obj: null, ready: null, meshRef: null };
    this.visuals.set(a, v);
    v.ready = this.buildVisual(a, v).catch(e => { console.warn('visual', a.Name, e); });
    return v.ready;
  }

  async buildVisual(a, v) {
    if (a.__isParticleFX) {
      v.particles = new ParticleVisual(a, this.ctx.textures, this.ctx.textures.white);
      v.obj = v.particles.group;
      this.scene.add(v.obj);
      return;
    }
    const dt = a.DrawType ?? 1;
    if (dt === 2) {
      const ref = a.Mesh;
      v.meshRef = ref;
      if (!ref.exp) return;
      const data = await this.meshes.fromExport(ref.pkg, ref.exp);
      if (!data || a.__deleted) return;
      const skins = await this.resolveSkins(a);
      const inst = new SkelInstance(data, { skins, style: a.Style ?? 1, unlit: !!a.bUnlit, white: this.ctx.textures.white, envMap: !!a.bMeshEnviroMap, fade: true });
      inst.root.matrixAutoUpdate = false;
      v.obj = inst.root;
      v.inst = inst;
      v.skinKey = this.skinKey(a);
      this.scene.add(inst.root);
    } else if (dt === 3) {
      const root = new THREE.Group();
      root.matrixAutoUpdate = false;
      const uniforms = makeLightUniforms();
      const groups = new Map();
      for (const poly of a.__polys || []) {
        if (poly.flags & (PF.Invisible | PF.Portal)) continue;
        const key = poly.texture + '|' + (poly.flags & (PF.Masked | PF.Translucent | PF.Modulated | PF.TwoSided | PF.Unlit));
        if (!groups.has(key)) groups.set(key, { texRef: poly.texture, flags: poly.flags, polys: [] });
        groups.get(key).polys.push(poly);
      }
      const bpkg = a.Brush.pkg;
      for (const g of groups.values()) {
        const tex = g.texRef ? await this.ctx.textures.get(bpkg, g.texRef) : null;
        const tw = tex?.userData.w || 64, th = tex?.userData.h || 64;
        const pos = [], uv = [], nrm = [];
        for (const poly of g.polys) {
          const vv = poly.verts;
          const emit = pt => {
            const d0 = pt[0] - poly.base[0], d1 = pt[1] - poly.base[1], d2 = pt[2] - poly.base[2];
            pos.push(pt[0], pt[1], pt[2]);
            nrm.push(poly.normal[0], poly.normal[1], poly.normal[2]);
            uv.push((d0 * poly.texU[0] + d1 * poly.texU[1] + d2 * poly.texU[2] + poly.panU) / tw,
              (d0 * poly.texV[0] + d1 * poly.texV[1] + d2 * poly.texV[2] + poly.panV) / th);
          };
          // (Unreal order: the brush matrix mirrors into three's axes and three flips its face test for that)
          for (let k = 1; k + 1 < vv.length; k++) { emit(vv[0]); emit(vv[k]); emit(vv[k + 1]); }
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
        root.add(new THREE.Mesh(geo, makeActorMaterial(tex, g.flags, uniforms, { white: this.ctx.textures.white })));
      }
      v.obj = root;
      v.uniforms = uniforms;
      v.isBrush = true;
      this.scene.add(root);
    } else if (dt === 1 || dt === 7) {
      const tex = await this.ctx.textures.fromExport(a.Texture.pkg, a.Texture.exp);
      if (!tex) return;
      // URender::DrawActorSprite: an unlit tile with colour ScaleGlow (clamped to 1); the actor's style and the
      // texture's own flags pick the blending (translucent ONE / INVSRCCOLOR, modulated DESTCOLOR / SRCCOLOR)
      const tp = tex.userData.props || {};
      const style = a.Style ?? 1;
      const translucent = style === 3 || tp.bTranslucent, modulated = !translucent && (style === 4 || tp.bModulate);
      const masked = !translucent && !modulated && (style === 2 || tp.bMasked);
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: translucent || modulated, depthWrite: !(translucent || modulated) });
      if (translucent) { mat.blending = THREE.CustomBlending; mat.blendSrc = THREE.OneFactor; mat.blendDst = THREE.OneMinusSrcColorFactor; }
      else if (modulated) { mat.blending = THREE.CustomBlending; mat.blendSrc = THREE.DstColorFactor; mat.blendDst = THREE.SrcColorFactor; }
      else if (masked) mat.alphaTest = 0.5;
      const sp = new THREE.Sprite(mat);
      v.obj = sp; v.isSprite = true; v.tex = tex;
      // DT_SpriteAnimOnce: the AnimNext frames, one picked by LifeFraction
      if (dt === 7) {
        v.frames = [tex];
        let cur = tp.AnimNext, pkg = a.Texture.pkg;
        for (let n = 0; n < 64 && cur; n++) {
          const res = await this.ctx.assets.resolve(pkg, cur.ref);
          if (!res) break;
          const f = await this.ctx.textures.fromExport(res.pkg, res.exp);
          if (!f || v.frames.includes(f)) break;
          v.frames.push(f); pkg = res.pkg; cur = f.userData.props.AnimNext;
        }
      }
      this.scene.add(sp);
    }
  }

  skinKey(a) {
    let k = String(a.Skin?.__path || '');
    if (Array.isArray(a.MultiSkins)) for (const m of a.MultiSkins) k += '|' + (m?.__path || '');
    return k;
  }

  async resolveSkins(a) {
    const skins = {};
    const T = this.ctx.textures;
    if (Array.isArray(a.MultiSkins)) {
      for (let i = 0; i < a.MultiSkins.length; i++) {
        const m = a.MultiSkins[i];
        if (m && m.exp) skins[i] = await T.fromExport(m.pkg, m.exp);
      }
    }
    if (a.Skin && a.Skin.exp) skins[0] = await T.fromExport(a.Skin.pkg, a.Skin.exp);
    return skins;
  }

  // ---------------------------------------------------------------- per-frame
  sync(dt) {
    const level = this.engine.level;
    if (!level || !this.scene) return;
    // new actors
    for (const a of level.actors) if (!this.visuals.has(a) && this.wantsVisual(a)) this.ensureVisual(a);
    for (const [w, wv] of this.weaponVisuals) {
      if (wv.obj) wv.obj.visible = false;
      if (w.__deleted) { if (wv.obj) this.scene.remove(wv.obj); this.weaponVisuals.delete(w); }
    }
    for (const [a, v] of this.visuals) {
      if (a.__deleted || (v.meshRef && a.Mesh !== v.meshRef) || ((a.DrawType ?? 1) !== 2 && v.inst)) {
        // rebuild if mesh changed or actor removed
        if (v.obj) this.scene.remove(v.obj);
        this.visuals.delete(a);
        if (!a.__deleted) this.ensureVisual(a);
        continue;
      }
      if (!v.obj) continue;
      if (v.particles) { v.obj.visible = true; v.particles.update(); continue; }
      const forced = a.__canvasFrame !== undefined && a.__canvasFrame >= (this.engine.frameNo || 0) - 1;
      const hidden = !forced && (!!window.__hide?.has(a.Class.name) || !!a.bHidden) || (a.DrawType ?? 1) === 0 || (a === this.engine.player && this.viewActor === a && !this.behindView);
      v.obj.visible = !hidden;
      if (hidden) continue;
      if (v.inst) {
        if (v.skinKey !== this.skinKey(a)) { v.skinKey = this.skinKey(a); this.applySkins(a, v); }
        actorMatrix(a, v.inst.data.mesh, v.obj.matrix);
        v.obj.matrixWorldNeedsUpdate = true;
        this.meshLOD(a, v);
        this.poseFromActor(a, v.inst, dt);
        this.lightActor(a, v.inst.uniforms);
        if ((v.inst.data.mesh.weaponBoneIndex ?? -1) >= 0 && (a.__isPawn ?? (a.__isPawn = a.Class.isA('Pawn')))) this.drawWeapon(a, v);
        v.inst.uniforms.opacity.value = a.Opacity ?? 1;
        // a drawn actor updates its shadow decal (FDynamicSprite: Actor->Shadow->eventUpdate(NULL))
        if (a.Shadow && !a.Shadow.__deleted) this.engine.vm.event(a.Shadow, 'Update', null);
      } else if (v.isBrush) {
        brushMatrix(a, v.obj.matrix);
        v.obj.matrixWorldNeedsUpdate = true;
        this.lightActor(a, v.uniforms);
      } else if (v.isSprite) {
        let tex = v.tex;
        if (v.frames) {
          const life0 = a.Class.defaults?.LifeSpan || 0;
          const frac = life0 ? Math.min(1, Math.max(0, 1 - (a.LifeSpan || 0) / life0)) : 0;
          tex = v.frames[Math.min(v.frames.length - 1, Math.max(0, Math.floor(frac * v.frames.length)))];
          if (v.obj.material.map !== tex) { v.obj.material.map = tex; v.obj.material.needsUpdate = true; }
        }
        // SpriteProjForward: the tile sits that much nearer the eye (same screen size)
        const cam = this.camera.position, loc = new THREE.Vector3(a.Location.X, a.Location.Z, a.Location.Y);
        const toCam = cam.clone().sub(loc), dist = toCam.length(), fwd = Math.min(a.SpriteProjForward ?? 32, Math.max(0, dist - 1));
        const k = dist > 0 ? (dist - fwd) / dist : 1;
        v.obj.position.copy(loc).addScaledVector(toCam, dist > 0 ? fwd / dist : 0);
        const s = (a.DrawScale ?? 1) * (tex.userData.w || 32) * k;
        v.obj.scale.set(s, s * ((tex.userData.h || 32) / (tex.userData.w || 32)), 1);
        const g = Math.min(1, a.ScaleGlow ?? 1);
        v.obj.material.color.setRGB(g, g, g);
        v.obj.material.opacity = 1;
      }
    }
  }

  // After a skeletal pawn is drawn: its weapon coordinates from the drawn pose go to Pawn.WeaponLoc /
  // WeaponRot, and its Weapon's ThirdPersonMesh (unless the weapon is hidden) is drawn there at
  // ThirdPersonScale with no rotation of its own (URender::DrawActorSprite, UnSprite.cpp)
  drawWeapon(a, v) {
    const mesh = v.inst.data.mesh, bone = v.inst.bones[mesh.weaponBoneIndex];
    if (!bone) return;
    v.obj.updateMatrixWorld(true);
    const w = weaponFromBone(_w.copy(MIRROR).multiply(bone.matrixWorld), mesh.weaponAdjust);
    a.WeaponLoc = w.loc; a.WeaponRot = w.rot; a.__weaponDrawn = true;
    const wp = a.Weapon;
    if (!wp || wp.__deleted || !wp.ThirdPersonMesh?.exp || wp.bHidden) return;
    let wv = this.weaponVisuals.get(wp);
    if (!wv || wv.meshRef !== wp.ThirdPersonMesh) {
      if (wv?.obj) this.scene.remove(wv.obj);
      const fake = { Name: wp.Name, Class: wp.Class, Mesh: wp.ThirdPersonMesh, DrawType: 2, Skin: wp.Skin, MultiSkins: wp.MultiSkins, Style: wp.Style, bUnlit: wp.bUnlit, bMeshEnviroMap: wp.bMeshEnviroMap,
        Location: { X: 0, Y: 0, Z: 0 }, Rotation: { Pitch: 0, Yaw: 0, Roll: 0 }, PrePivot: { X: 0, Y: 0, Z: 0 } };
      wv = { actor: fake, obj: null, meshRef: wp.ThirdPersonMesh };
      wv.ready = this.buildVisual(fake, wv).catch(e => console.warn('weapon visual', wp.Name, e));
      this.weaponVisuals.set(wp, wv);
    }
    if (!wv.obj || !wv.inst) return;
    const f = wv.actor;
    f.DrawScale = wp.ThirdPersonScale ?? 1; f.AnimSequence = wp.AnimSequence; f.AnimFrame = wp.AnimFrame; f.bAnimLoop = wp.bAnimLoop;
    actorMatrix(f, wv.inst.data.mesh, _w2);
    // MIRROR x weapon coords x (the mesh's own placement): actorMatrix already starts with MIRROR
    wv.obj.matrix.copy(MIRROR).multiply(w.matrix).multiply(_w3.copy(MIRROR).multiply(_w2));
    wv.obj.matrixWorldNeedsUpdate = true;
    wv.obj.visible = true;
    this.poseFromActor(f, wv.inst, 0);
    this.lightActor(a, wv.inst.uniforms);
    wv.inst.uniforms.opacity.value = a.Opacity ?? 1;
  }

  // LOD vertex budget from the actor's screen box: Bias x max(pixels x 0.04 / ModelVerts, sqrt(pixels) / width x 4)
  meshLOD(a, v) {
    const m = v.inst.data.mesh;
    if (!m.lodStrength || !m.collapsePointThus?.length || !m.box || !this.lastView) return;
    const vr = this.viewRect || { w: innerWidth, h: innerHeight }, cam = this.camera;
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity, behind = false;
    const p = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      p.set(i & 1 ? m.box.max[0] : m.box.min[0], i & 2 ? m.box.max[1] : m.box.min[1], i & 4 ? m.box.max[2] : m.box.min[2]).applyMatrix4(v.obj.matrix);
      p.project(cam);
      if (p.z > 1) behind = true;
      const sx = (p.x * 0.5 + 0.5) * vr.w, sy = (0.5 - p.y * 0.5) * vr.h;
      x1 = Math.min(x1, sx); x2 = Math.max(x2, sx); y1 = Math.min(y1, sy); y2 = Math.max(y2, sy);
    }
    if (behind) { v.inst.setLOD(m.modelVerts); return; }
    x1 = Math.max(0, Math.ceil(x1)); x2 = Math.min(vr.w, Math.ceil(x2)); y1 = Math.max(0, Math.ceil(y1)); y2 = Math.min(vr.h, Math.ceil(y2));
    const pix = Math.max(0, (y2 + 1 - y1) * (x2 + 1 - x1));
    const lod = ((a.LODBias ?? 1) / m.lodStrength) * Math.max(pix * 0.04 / m.modelVerts, Math.sqrt(pix) / vr.w * 4);
    v.inst.setLOD(Math.round(m.lodMinVerts + (m.modelVerts - m.lodMinVerts) * lod));
  }

  // decals (ADecal SurfList): each square clipped to its surfaces' polygons (ClipDecal), raised 1 unit off
  // the surface, UV by the square's edges / DrawScale, colour ScaleGlow/2 + AmbientGlow/256; modulated or
  // translucent by style
  updateDecals() {
    const lvl = this.engine.level;
    this.decals ??= new Map();
    const seen = new Set();
    for (const a of lvl.actors) {
      if (!a.__decals || a.__deleted || !a.Texture?.exp) continue;
      seen.add(a);
      let d = this.decals.get(a);
      if (!d) {
        d = { stamp: -1, mesh: null, tex: null };
        this.decals.set(a, d);
        this.ctx.textures.fromExport(a.Texture.pkg, a.Texture.exp).then(t => { d.tex = t; d.stamp = -1; });
      }
      if (!d.tex || d.stamp === a.__decalStamp) continue;
      d.stamp = a.__decalStamp;
      const pos = [], uv = [], ds = a.DrawScale ?? 1, tw = d.tex.userData.w || 64, th = d.tex.userData.h || 64;
      const m = this.geo.model;
      for (const dc of a.__decals) {
        const surf = m.surfs[dc.surf];
        const N = [m.vectors[surf.vNormal * 3], m.vectors[surf.vNormal * 3 + 1], m.vectors[surf.vNormal * 3 + 2]];
        const nl = Math.hypot(...N) || 1, n = N.map(c => c / nl);
        const V = dc.verts.map(p => [p.X + n[0], p.Y + n[1], p.Z + n[2]]);
        const ex = sub3(V[1], V[0]), ey = sub3(V[3], V[0]), lx = Math.hypot(...ex) || 1, ly = Math.hypot(...ey) || 1;
        for (const poly of this.geo.surfPolys(dc.surf)) {
          let pts = V;
          const cen = poly.reduce((c, q) => [c[0] + q[0] / poly.length, c[1] + q[1] / poly.length, c[2] + q[2] / poly.length], [0, 0, 0]);
          // clip by each edge plane of the (convex) polygon, perpendicular to the surface
          for (let i = 0, prev = poly.length - 1; i < poly.length && pts.length; prev = i++) {
            const e = sub3(poly[i], poly[prev]), pn = cross3(n, e);
            const side = p => dot3(sub3(p, poly[i]), pn);
            const ref = side(cen) >= 0 ? 1 : -1;
            const out = [];
            for (let j = 0; j < pts.length; j++) {
              const p = pts[j], q = pts[(j + 1) % pts.length], dp = side(p) * ref, dq = side(q) * ref;
              if (dp >= 0) out.push(p);
              if ((dp > 0 && dq < 0) || (dp < 0 && dq > 0)) { const t = dp / (dp - dq); out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t]); }
            }
            pts = out;
          }
          if (pts.length < 3) continue;
          const u = p => dot3(sub3(p, V[0]), ex) / lx / ds / tw, w = p => dot3(sub3(p, V[0]), ey) / ly / ds / th;
          for (let k = 1; k + 1 < pts.length; k++) for (const p of [pts[0], pts[k + 1], pts[k]]) { pos.push(p[0], p[2], p[1]); uv.push(u(p), w(p)); }
        }
      }
      if (!d.mesh) {
        const style = a.Style ?? 1;
        const mat = new THREE.MeshBasicMaterial({ map: d.tex, transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
        if (style === 4) { mat.blending = THREE.CustomBlending; mat.blendSrc = THREE.DstColorFactor; mat.blendDst = THREE.SrcColorFactor; }
        else if (style === 3) { mat.blending = THREE.CustomBlending; mat.blendSrc = THREE.OneFactor; mat.blendDst = THREE.OneMinusSrcColorFactor; }
        d.mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
        d.mesh.frustumCulled = false;
        this.scene.add(d.mesh);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      d.mesh.geometry.dispose(); d.mesh.geometry = g;
      const c = (a.Style ?? 1) === 4 ? 1 : Math.min(1, Math.max(0, (a.ScaleGlow ?? 1) * 0.5 + (a.AmbientGlow ?? 0) / 256));
      d.mesh.material.color.setRGB(c, c, c);
    }
    for (const [a, d] of this.decals) {
      if (seen.has(a)) { if (d.mesh) d.mesh.visible = true; continue; }
      if (d.mesh) d.mesh.visible = false;
      if (a.__deleted) { if (d.mesh) { this.scene.remove(d.mesh); d.mesh.geometry.dispose(); } this.decals.delete(a); }
    }
  }

  async applySkins(a, v) {
    const skins = await this.resolveSkins(a);
    const m = v.inst.data.mesh;
    v.inst.data.groups.forEach((g, i) => {
      const mi = m.materials[g.mat] || { tex: g.mat };
      const t = skins[mi.tex] || v.inst.data.textures[mi.tex];
      if (t && v.inst.materials[i]) v.inst.materials[i].uniforms.map.value = t;
    });
  }

  poseFromActor(a, inst, dt) {
    const anim = inst.anim;
    if (!anim) return;
    const seqName = a.AnimSequence;
    if (!seqName || seqName === 'None') return;
    const idx = anim.seqByName.get(String(seqName).toLowerCase());
    if (idx === undefined) return;
    // KnowWonder skeletal tweening: while TweenRate is on, each frame's pose is the animated pose blended
    // with the pose shown last frame by TweenAlpha (UE1 USkeletalMesh::ApplyAnim)
    const tweening = a.TweenRate > 0 && inst.seq !== null && inst.lastPose;
    const prev = tweening ? inst.lastPose : null;
    inst.seq = idx;
    inst._animStart = a.__animStart;
    const s = anim.animSeqs[idx];
    const nf = Math.max(1, s.numFrames);
    const frac = Math.min(1, Math.max(0, a.AnimFrame ?? 0));
    inst.loop = !!a.bAnimLoop;
    inst.frame = Math.min(frac * nf, nf - (inst.loop ? 0.0001 : 1));
    inst.playing = false;
    inst.tweenTime = 0; inst.tweenDur = 0;
    inst.tweenFrom = null;
    inst.update(0);
    // bAnimMove: the root's motion moves the actor, so the root bone keeps its reference-pose position
    // (USkeletalMesh::ApplyAnim reverts it to RefSkeleton's)
    if (a.bAnimMove) inst.bones[0].position.copy(inst.bindPose[0].p);
    if (prev) {
      const w = Math.min(1, Math.max(0, a.TweenAlpha ?? 1));
      for (let i = 0; i < inst.bones.length; i++) {
        const b = inst.bones[i];
        b.quaternion.slerpQuaternions(prev[i].q, b.quaternion.clone(), w);
        b.position.lerpVectors(prev[i].p, b.position, w);
      }
    }
    if (!inst.lastPose) inst.lastPose = inst.bones.map(b => ({ q: b.quaternion.clone(), p: b.position.clone() }));
    else inst.bones.forEach((b, i) => { inst.lastPose[i].q.copy(b.quaternion); inst.lastPose[i].p.copy(b.position); });
    this.applyChannels(a, inst, dt);
  }

  // HP anim channels (e.g. cHarryAnimChannel on 'harry spine1'): override a bone subtree while active
  applyChannels(a, inst, dt) {
    const chans = a.__channels;
    if (!chans || !chans.length) return;
    for (const ch of chans) {
      if (ch.__deleted) continue;
      const st = ch.__state;
      const active = !!st && !(st.raw.stateFlags & 2) && ch.AnimSequence && ch.AnimSequence !== 'None';
      const target = active ? 1 : 0;
      ch.__w = ch.__w ?? 0;
      ch.__w += Math.sign(target - ch.__w) * Math.min(Math.abs(target - ch.__w), dt * 6);
      if (ch.__w <= 0.001) continue;
      const mask = inst.subtree(ch.__rootBone || '');
      if (!mask) continue;
      const idx = inst.anim?.seqByName.get(String(ch.AnimSequence).toLowerCase());
      if (idx === undefined) continue;
      const saved = [];
      for (const bi of mask) saved.push([bi, inst.bones[bi].quaternion.clone(), inst.bones[bi].position.clone()]);
      const nf = Math.max(1, inst.anim.animSeqs[idx].numFrames);
      let frac = ch.AnimFrame ?? 0;
      if (frac < 0) frac = 0;
      inst.applySeq(idx, Math.min(frac, 1 - 1 / nf), !!ch.bAnimLoop, mask);
      if (ch.__w < 1) for (const [bi, q, p] of saved) {
        const b = inst.bones[bi];
        b.quaternion.copy(q.slerp(b.quaternion, ch.__w));
        b.position.lerpVectors(p, b.position, ch.__w);
      }
    }
  }

  // FLightManager::SetupForActor: lights whose radius reaches the actor (same bSpecialLit), by priority
  // (1 - d/R) x brightness; up to 3 visible ones (BSP line from the light, re-checked every 16 frames;
  // non-static movable lights always count), none under 1/8 of the first one's priority; each fades in/out
  // at 768/255 per second; colour = hue/saturation x LightBrightness/255 (x light-type effect) x fade
  lightActor(a, uniforms) {
    const lvl = this.engine.level, li = lvl.levelInfo;
    const z = a.Region?.Zone || li;
    const diffuse = (a.ScaleGlow ?? 1) * 2;
    const ag = (a.AmbientGlow ?? 0) | 0;
    const C = ag !== 255 ? ag / 255 : 0.25 + 0.2 * Math.sin((this.realTime || 0) * 8);
    const amb = hsvColor(z.AmbientHue ?? 0, z.AmbientSaturation ?? 255, z.AmbientBrightness ?? 0);
    uniforms.ambient.value.setRGB(C + amb[0] * diffuse, C + amb[1] * diffuse, C + amb[2] * diffuse);
    uniforms.diffuse.value = diffuse;
    uniforms.fogZone.value = z.bFogZone ? 1 : 0;
    // specular: SpecularGlow x 2, width 170 = cos^2 lobe (SpecMinCos 0), narrower widths raise the floor
    const smc = (1 - (a.SpecularWidth ?? 0) / 170) ** 2;
    uniforms.specMinCos.value = smc;
    uniforms.specular.value = a.SpecularGlow ? a.SpecularGlow * 2 / Math.max(1e-6, (1 - smc) ** 2) : 0;
    const u = Math.min(1, Math.max(0, (a.ScaleGlow ?? 1) * 0.5 + ag / 256));
    uniforms.unlitLight.value.setRGB(u, u, u);
    uniforms.glow.value = a.ScaleGlow ?? 1;
    let used = 0;
    if (!a.bUnlit) {
      const tags = a.__lightTags ??= new Map(), first = !a.__lightSeen;
      a.__lightSeen = true;
      const delta = Math.min(255, Math.max(0, Math.round((this.frameDt || 0) * 768)));
      const cons = [];
      for (const L of this.frameLights || []) {
        const la = L.actor;
        if (la === a || !!la.bSpecialLit !== !!a.bSpecialLit) continue;
        const d = Math.hypot(a.Location.X - L.pos[0], a.Location.Y - L.pos[1], a.Location.Z - L.pos[2]);
        if (d >= L.radius) continue;
        cons.push({ L, tag: Math.round((1 - d / L.radius) * L.brightness * 1024) });
      }
      cons.sort((x, y) => y.tag - x.tag);
      let nStatic = 0, nReal = 0, threshold = -1;
      const lit = [];
      for (const c of cons) {
        const la = c.L.actor;
        let st = tags.get(la) ?? 0, vis;
        if (c.tag < threshold || (la.bStatic ? nStatic : nReal) >= 3) vis = false;
        else if (!la.bStatic && la.bMovable) vis = true;
        else if (first || ((this.frameCount ^ (la.__lightIdx ??= ++this.lightIdx)) & 15) === 0) {
          vis = lvl.pawns.fastLine({ X: c.L.pos[0], Y: c.L.pos[1], Z: c.L.pos[2] }, a.Location);
          if (vis && first) st = 255;
        } else vis = !!(st & 1);
        if (vis) {
          nReal++; if (la.bStatic) nStatic++;
          if (threshold === -1) threshold = c.tag / 8;
          st = Math.min(st + delta, 255) | 1;
          lit.push([c.L, st]);
        } else {
          st = Math.max(st - delta, 0) & ~1;
          if (st > 0) lit.push([c.L, st]);
        }
        tags.set(la, st);
      }
      for (const [L, st] of lit) {
        if (used >= 6) break;
        const k = (L.dark ? -1 : 1) * st / 255, i = used++;
        uniforms.lightPos.value[i].set(L.pos[0], L.pos[2], L.pos[1]);
        uniforms.lightColor.value[i].setRGB(L.fc[0] * k, L.fc[1] * k, L.fc[2] * k);
        uniforms.lightRadius.value[i] = L.radius;
        uniforms.lightRMult.value[i] = 1 / Math.max(1, L.radius - (L.radiusInner || 0));
        uniforms.lightSrc.value[i] = L.source === 1 ? 1 : L.source === 2 ? 2 : 0;
        if (L.source === 1) {
          const yaw = L.rot.yaw * Math.PI / 32768, pitch = L.rot.pitch * Math.PI / 32768;
          uniforms.lightDir.value[i].set(Math.cos(pitch) * Math.cos(yaw), Math.sin(pitch), Math.cos(pitch) * Math.sin(yaw));
        }
      }
    }
    for (let i = used; i < 6; i++) { uniforms.lightColor.value[i].setRGB(0, 0, 0); uniforms.lightRadius.value[i] = 1; }
  }

  // URender::GlobalLighting: the light type's brightness effect at this time (clamped to 0..1 afterwards)
  lightScale(a, t) { return lightTypeScale(a, t, this.frameCount || 0, this.rnd); }

  // Lights carried by non-static actors (spell glows, Lumos, moving torches) light the BSP live
  updateDynamicLights(view) {
    const lvl = this.engine.level;
    if (!lvl) return;
    const t = lvl.timeSeconds;
    const cands = [];
    for (const a of lvl.actors) {
      if (a.__deleted || !(a.LightType > 0) || surfLightKind(a) !== 'moving') continue;
      if ((a.LightBrightness ?? 0) <= 0) continue;
      const d = Math.hypot(a.Location.X - view.loc.X, a.Location.Y - view.loc.Y, a.Location.Z - view.loc.Z);
      cands.push([d, a]);
    }
    cands.sort((x, y) => x[0] - y[0]);
    for (let i = 0; i < MAX_DYN; i++) {
      const a = cands[i]?.[1];
      if (!a) { shared.dynColor.value[i].setRGB(0, 0, 0); shared.dynRadius.value[i] = 1; continue; }
      const L = lightFromProps(a, a.Location);
      const fc = L ? staticLightColor(L, lvl.levelInfo.Brightness ?? 1, this.lightScale(a, t)) : [0, 0, 0];
      const k = L?.dark ? -1 : 1;
      shared.dynPos.value[i].set(a.Location.X, a.Location.Z, a.Location.Y);
      shared.dynColor.value[i].setRGB(fc[0] * k, fc[1] * k, fc[2] * k);
      shared.dynRadius.value[i] = L?.radius || 1;
    }
  }

  // ---------------------------------------------------------------- camera + draw
  computeView() {
    const eng = this.engine, vm = eng.vm, p = eng.player;
    if (!p) return null;
    const out = {
      va: { v: p, __ref: true, get() { return this.v; }, set(x) { this.v = x; } },
      loc: { v: { ...p.Location }, __ref: true, get() { return this.v; }, set(x) { this.v = x; } },
      // (UGameEngine::Draw starts from the player's Location and Rotation before PlayerCalcView)
      rot: { v: { ...p.Rotation }, __ref: true, get() { return this.v; }, set(x) { this.v = x; } },
    };
    if (vm.findFunction(p, 'playercalcview')) vm.event(p, 'PlayerCalcView', out.va, out.loc, out.rot);
    return { actor: out.va.v, loc: out.loc.v, rot: out.rot.v, fov: p.FovAngle || p.DesiredFOV || 90 };
  }

  // the lights actors can be lit by this frame: fixed ones (light-type effects applied) and moving ones
  prepareLights(dt) {
    const lvl = this.engine.level, t = lvl.timeSeconds || 0, lb = lvl.levelInfo.Brightness ?? 1;
    this.frameDt = dt; this.frameCount = (this.frameCount || 0) + 1; this.realTime = (this.realTime || 0) + dt; this.lightIdx ??= 0;
    (this.rnd ??= new GlobalRandoms()).tick(t);
    this.geo?.updateDynamicLightmaps?.(this.renderer, t, this.frameCount, this.rnd);
    const out = [];
    for (const L of this.lights) {
      if (L.actor.__deleted || !(L.actor.LightType > 0)) continue;
      if (L.actor.LightType !== 1) L.fc = staticLightColor(L, lb, this.lightScale(L.actor, t));
      out.push(L);
    }
    for (const a of lvl.actors) {
      if (a.__deleted || a.bStatic || a.bNoDelete || !(a.LightType > 0) || !((a.LightBrightness ?? 0) > 0)) continue;
      const L = lightFromProps(a, a.Location);
      if (!L) continue;
      L.actor = a; L.fc = staticLightColor(L, lb, this.lightScale(a, t));
      out.push(L);
    }
    this.frameLights = out;
    // volumetric lights (VolumeRadius / VolumeBrightness in a fog zone), nearest 8, farthest first
    shared.levelTime.value = t;
    const cam = this.lastView?.loc;
    const vols = [];
    if (cam) for (const a of lvl.actors) {
      if (a.__deleted || !(a.LightType > 0) || !(a.VolumeRadius > 0) || !(a.VolumeBrightness > 0) || !(a.LightBrightness > 0)) continue;
      if (!a.Region?.Zone?.bFogZone) continue;
      const R = 25 * ((a.VolumeRadius | 0) + 1), d = Math.hypot(a.Location.X - cam.X, a.Location.Y - cam.Y, a.Location.Z - cam.Z) - R;
      vols.push({ a, R, d });
    }
    vols.sort((x, y) => x.d - y.d);
    vols.length = Math.min(vols.length, MAX_VOL);
    const rot = this.lastView?.rot, RUv = Math.PI / 32768;
    const fw = rot ? [Math.cos(rot.Pitch * RUv) * Math.cos(rot.Yaw * RUv), Math.cos(rot.Pitch * RUv) * Math.sin(rot.Yaw * RUv), Math.sin(rot.Pitch * RUv)] : [1, 0, 0];
    const depth = a => (a.Location.X - cam.X) * fw[0] + (a.Location.Y - cam.Y) * fw[1] + (a.Location.Z - cam.Z) * fw[2];
    vols.sort((x, y) => depth(y.a) - depth(x.a));
    shared.volCount.value = vols.length;
    vols.forEach(({ a, R }, i) => {
      const L = lightFromProps(a, a.Location), sc = this.lightScale(a, t);
      const bright = Math.min(1, Math.max(0, (a.LightBrightness / 255) * sc));
      const fc = staticLightColor(L, lb, sc);
      shared.volPos.value[i].set(a.Location.X, a.Location.Z, a.Location.Y);
      shared.volColor.value[i].set(fc[0], fc[1], fc[2]);
      shared.volRadius.value[i] = R;
      shared.volBright.value[i] = bright * (a.VolumeBrightness / 64);
      shared.volFog.value[i] = (a.VolumeFog ?? 0) / 255;
      shared.volAmb.value[i] = (a.LightSource | 0) === 2 ? 1 : 0;
    });
  }

  render(dt) {
    if (!this.scene) return;
    this.prepareLights(dt);
    this.sync(dt);
    this.updateDecals();
    const view = this.computeView();
    if (!view) return;
    this.lastView = view;
    this.updateDynamicLights(view);
    this.viewActor = view.actor;
    this.behindView = !!this.engine.player?.bBehindView || view.actor !== this.engine.player;
    const cam = this.camera;
    cam.position.set(view.loc.X, view.loc.Z, view.loc.Y);
    // Unreal yaw (around Z, X->Y) and pitch -> three Euler with mirror (x, z, y)
    const yaw = view.rot.Yaw * RU, pitch = view.rot.Pitch * RU, roll = view.rot.Roll * RU;
    const fwd = new THREE.Vector3(Math.cos(pitch) * Math.cos(yaw), Math.sin(pitch), Math.cos(pitch) * Math.sin(yaw));
    cam.up.set(0, 1, 0);
    cam.lookAt(cam.position.clone().add(fwd));
    if (roll) cam.rotateZ(-roll);
    const vr = this.viewRect || { x: 0, y: 0, w: innerWidth, h: innerHeight };
    cam.aspect = vr.w / vr.h;
    // UE1 FOV is horizontal, for the 4:3 screens the game was framed for: wider views keep that vertical
    // angle and see more at the sides (Hor+), narrower ones keep the horizontal angle
    const hf = (view.fov || 90) * Math.PI / 180;
    cam.fov = 2 * Math.atan(Math.tan(hf / 2) / Math.max(cam.aspect, 4 / 3)) * 180 / Math.PI;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    shared.time.value += dt;
    // zone fog
    const r = this.renderer;
    r.setScissorTest(false);
    r.setViewport(0, 0, innerWidth, innerHeight);
    r.clear();
    r.setViewport(vr.x, innerHeight - vr.y - vr.h, vr.w, vr.h);
    r.setScissor(vr.x, innerHeight - vr.y - vr.h, vr.w, vr.h);
    r.setScissorTest(true);
    // sky portal: the viewer zone's SkyZone (ZoneInfo.PreBeginPlay picks it), seen from its Location with the
    // view turned by its Rotation (HandleSkyWarp)
    const vz = view.actor?.Region?.Zone || this.engine.player?.Region?.Zone;
    const sky = (vz?.SkyZone && !vz.SkyZone.__deleted) ? vz.SkyZone : this.sky;
    if (sky) {
      this.skyCam.copy(cam);
      this.skyCam.position.set(sky.Location.X, sky.Location.Z, sky.Location.Y);
      const sr = sky.Rotation || {};
      if (sr.Pitch || sr.Yaw || sr.Roll) {
        const q = new THREE.Quaternion().setFromRotationMatrix(rotatorMatrix({ pitch: sr.Pitch, yaw: sr.Yaw, roll: sr.Roll }).premultiply(MIRROR).multiply(MIRROR));
        this.skyCam.quaternion.premultiply(q);
      }
      this.skyCam.updateMatrixWorld();
      for (const m of this.backdropMats) m.colorWrite = false;
      r.render(this.scene, this.skyCam);
      r.clearDepth();
    }
    for (const m of this.backdropMats) m.colorWrite = !this.sky;
    if (this.portals?.list.length) { this.portals.render(this.scene, cam, Math.round(vr.w * r.getPixelRatio()), Math.round(vr.h * r.getPixelRatio())); r.setViewport(vr.x, innerHeight - vr.y - vr.h, vr.w, vr.h); }
    r.render(this.scene, cam);
  }
}

const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function isEditorSprite(a) {
  // editor-only sprite textures (Engine.S_*) are hidden in game
  const n = a.Texture?.Name || '';
  return /^S_/.test(n) && a.Texture.pkg?.name === 'Engine';
}
