// World: holds the loaded level, actor instances and per-frame update.
import * as THREE from 'three';
import { PF } from '../engine/upackage.js';
import { readModel, readPolys } from '../engine/umodel.js';
import { MeshCache, SkelInstance, MIRROR, rotatorMatrix, makeLightUniforms } from '../render/skeletal.js';
import { makeActorMaterial } from '../render/actormaterial.js';
import { lightFromProps, hsvColor } from '../render/lighting.js';

const _m = new THREE.Matrix4(), _r = new THREE.Matrix4(), _s = new THREE.Matrix4();

// Unreal-space actor transform as three matrix (includes mirror)
export function actorMatrix(props, mesh, out = new THREE.Matrix4()) {
  const loc = props.Location || { x: 0, y: 0, z: 0 };
  const pp = props.PrePivot || { x: 0, y: 0, z: 0 };
  out.copy(MIRROR);
  out.multiply(_m.makeTranslation(loc.x + pp.x, loc.y + pp.y, loc.z + pp.z));
  out.multiply(rotatorMatrix(props.Rotation, _r));
  if (mesh) {
    out.multiply(rotatorMatrix(mesh.rotOrigin, _r));
    const ds = props.DrawScale ?? 1;
    const ms = mesh.scale || [1, 1, 1];
    out.multiply(_s.makeScale(ms[0] * ds, ms[1] * ds, ms[2] * ds));
    const o = mesh.origin || [0, 0, 0];
    out.multiply(_m.makeTranslation(-o[0], -o[1], -o[2]));
  } else {
    const ds = props.DrawScale ?? 1;
    out.multiply(_s.makeScale(ds, ds, ds));
  }
  return out;
}

export class World {
  constructor(ctx, level) {
    this.ctx = ctx;
    this.level = level;
    this.scene = level.scene;
    this.meshes = ctx.meshes || (ctx.meshes = new MeshCache(ctx));
    this.instances = [];
    this.model = level.geo.model;
    this.lights = [];
    this.time = 0;
    for (const a of level.actors) {
      const L = lightFromProps(a.props, a.props.Location || { x: 0, y: 0, z: 0 });
      if (L && !L.dark) {
        L.tpos = new THREE.Vector3(L.pos[0], L.pos[2], L.pos[1]);
        L.tcolor = new THREE.Color(L.color[0], L.color[1], L.color[2]);
        L.actor = a;
        this.lights.push(L);
      }
    }
  }

  // BSP point query -> zone index (Unreal coords)
  zoneAt(x, y, z) {
    const nodes = this.model.nodes;
    if (!nodes.length) return 0;
    let i = 0, zone = 0;
    for (let g = 0; g < 4096; g++) {
      const n = nodes[i];
      const d = n.plane[0] * x + n.plane[1] * y + n.plane[2] * z - n.plane[3];
      const front = d >= 0;
      const next = front ? n.iFront : n.iBack;
      if (next <= 0 || next === i) { zone = n.iZone[front ? 1 : 0]; break; }
      i = next;
    }
    return zone;
  }

  zoneActor(zone) {
    const z = this.model.zones[zone];
    return z ? this.level.actorsByRef.get(z.zoneActor) : null;
  }

  ambientAt(uloc) {
    const zone = this.zoneAt(uloc.x, uloc.y, uloc.z);
    const za = this.zoneActor(zone) || this.level.levelInfo;
    const p = za?.props || {};
    const c = hsvColor(p.AmbientHue ?? 0, p.AmbientSaturation ?? 255, p.AmbientBrightness ?? 0);
    return c;
  }

  // Fill a light-uniform block with the strongest lights near a three-space point
  pickLights(uniforms, tpos, uloc, scaleGlow = 1, ambientGlow = 0) {
    const cand = [];
    for (const L of this.lights) {
      const d2 = L.tpos.distanceToSquared(tpos);
      const r2 = L.radius * L.radius;
      if (d2 >= r2) continue;
      const s = (1 - d2 / r2) * (L.color[0] + L.color[1] + L.color[2]);
      cand.push([s, L]);
    }
    cand.sort((a, b) => b[0] - a[0]);
    for (let i = 0; i < 6; i++) {
      const L = cand[i]?.[1];
      if (L) {
        uniforms.lightPos.value[i].copy(L.tpos);
        uniforms.lightColor.value[i].copy(L.tcolor);
        uniforms.lightRadius.value[i] = L.radius;
      } else {
        uniforms.lightColor.value[i].setRGB(0, 0, 0);
        uniforms.lightRadius.value[i] = 1;
      }
    }
    const amb = this.ambientAt(uloc);
    const ag = ambientGlow / 255;
    uniforms.ambient.value.setRGB(amb[0] + ag + 0.04, amb[1] + ag + 0.04, amb[2] + ag + 0.04);
    uniforms.glow.value = scaleGlow;
  }

  async spawnVisual(a) {
    const p = a.props;
    if (p.bHidden) return null;
    const drawType = p.DrawType ?? 1;
    if (drawType === 2 && p.Mesh) {
      const data = await this.meshes.get(p.Mesh.pkg, p.Mesh.ref);
      if (!data) return null;
      const skins = {};
      if (p.MultiSkins) for (const k in p.MultiSkins) if (k !== '__arr' && p.MultiSkins[k]) skins[k] = await this.ctx.textures.get(p.MultiSkins[k].pkg, p.MultiSkins[k].ref);
      const skin = p.Skin ? await this.ctx.textures.get(p.Skin.pkg, p.Skin.ref) : null;
      if (skin) skins[0] = skin;
      const inst = new SkelInstance(data, {
        skins, style: p.Style ?? 1, unlit: !!p.bUnlit, white: this.ctx.textures.white,
        envMap: !!p.bMeshEnviroMap,
      });
      inst.actor = a;
      a.visual = inst;
      this.scene.add(inst.root);
      actorMatrix(p, data.mesh, inst.root.matrix);
      inst.root.matrixWorldNeedsUpdate = true;
      const animSeq = p.AnimSequence;
      if (animSeq && animSeq !== 'None' && inst.hasAnim(animSeq)) {
        if (p.bAnimLoop !== false || (p.AnimRate ?? 0) > 0) inst.loopAnim(animSeq, 1, 0);
        else inst.play(animSeq, 1, 0);
        inst.frame = (p.AnimFrame || 0) * (data.anim?.animSeqs[inst.seq]?.numFrames || 1);
      } else if (data.anim?.animSeqs.length) {
        // default to an idle-like loop if present
        const idle = data.anim.animSeqs.find(s => /^(idle|breathe|loop)/i.test(s.name));
        if (idle) inst.loopAnim(idle.name, 1, 0);
        else { inst.play(data.anim.animSeqs[0].name, 0, 0); }
      }
      this.updateLighting(a);
      this.instances.push(inst);
      return inst;
    }
    if (drawType === 3 && p.Brush) {
      return this.spawnBrush(a);
    }
    return null;
  }

  async spawnBrush(a) {
    const p = a.props;
    const res = await this.ctx.assets.resolve(p.Brush.pkg, p.Brush.ref);
    if (!res) return null;
    const model = readModel(res.pkg, res.exp);
    if (!model.polysRef) return null;
    const polys = readPolys(res.pkg, res.pkg.exports[model.polysRef - 1]);
    const groups = new Map();
    for (const poly of polys) {
      if (poly.flags & (PF.Invisible | PF.Portal)) continue;
      const key = poly.texture + '|' + (poly.flags & (PF.Masked | PF.Translucent | PF.Modulated | PF.TwoSided | PF.Unlit));
      if (!groups.has(key)) groups.set(key, { texRef: poly.texture, flags: poly.flags, polys: [] });
      groups.get(key).polys.push(poly);
    }
    const root = new THREE.Group();
    root.matrixAutoUpdate = false;
    const uniforms = makeLightUniforms();
    for (const g of groups.values()) {
      const tex = g.texRef ? await this.ctx.textures.get(res.pkg, g.texRef) : null;
      const tw = tex?.userData.w || 64, th = tex?.userData.h || 64;
      const pos = [], uv = [], nrm = [];
      for (const poly of g.polys) {
        const v = poly.verts;
        const emit = pt => {
          const d = [pt[0] - poly.base[0], pt[1] - poly.base[1], pt[2] - poly.base[2]];
          pos.push(pt[0], pt[1], pt[2]);
          nrm.push(poly.normal[0], poly.normal[1], poly.normal[2]);
          uv.push((d[0] * poly.texU[0] + d[1] * poly.texU[1] + d[2] * poly.texU[2] + poly.panU) / tw,
            (d[0] * poly.texV[0] + d[1] * poly.texV[1] + d[2] * poly.texV[2] + poly.panV) / th);
        };
        for (let k = 1; k + 1 < v.length; k++) { emit(v[0]); emit(v[k + 1]); emit(v[k]); }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      const mat = makeActorMaterial(tex, g.flags, uniforms, { white: this.ctx.textures.white });
      root.add(new THREE.Mesh(geo, mat));
    }
    const inst = { root, uniforms, actor: a, isBrush: true, polys };
    a.visual = inst;
    this.brushMatrix(a, root.matrix);
    root.matrixWorldNeedsUpdate = true;
    this.scene.add(root);
    this.updateLighting(a);
    return inst;
  }

  brushMatrix(a, out) {
    const p = a.props;
    const loc = p.Location || { x: 0, y: 0, z: 0 };
    const pp = p.PrePivot || { x: 0, y: 0, z: 0 };
    out.copy(MIRROR);
    out.multiply(_m.makeTranslation(loc.x, loc.y, loc.z));
    out.multiply(rotatorMatrix(p.Rotation, _r));
    const ms = p.MainScale?.x !== undefined ? p.MainScale : { x: 1, y: 1, z: 1 };
    out.multiply(_s.makeScale(ms.x || 1, ms.y || 1, ms.z || 1));
    out.multiply(_m.makeTranslation(-pp.x, -pp.y, -pp.z));
    return out;
  }

  updateLighting(a) {
    const v = a.visual;
    if (!v) return;
    const loc = a.props.Location || { x: 0, y: 0, z: 0 };
    const tpos = new THREE.Vector3(loc.x, loc.z, loc.y);
    this.pickLights(v.uniforms, tpos, loc, a.props.ScaleGlow ?? 1, a.props.AmbientGlow ?? 0);
  }

  // Reposition visual after actor moved
  syncVisual(a) {
    const v = a.visual;
    if (!v) return;
    if (v.isBrush) this.brushMatrix(a, v.root.matrix);
    else actorMatrix(a.props, v.data.mesh, v.root.matrix);
    v.root.matrixWorldNeedsUpdate = true;
  }

  update(dt) {
    this.time += dt;
    for (const inst of this.instances) inst.update(dt);
  }
}
