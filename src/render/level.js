// Builds three.js geometry for a UE1 level BSP: textured surfaces with computed lightmaps.
import * as THREE from 'three';
import { PF } from '../engine/upackage.js';
import { readModel } from '../engine/umodel.js';
import { lightFromProps, hsvColor, AtlasPacker, staticLightColor, filterShadow, luxelSpatial, surfLightKind, mergeSurfLight, GlobalRandoms, lightTypeScale } from './lighting.js';
import { makeSurfaceMaterial } from './materials.js';

// Unreal (x, y, z) left-handed Z-up -> three.js (x, z, y) right-handed Y-up (mirror swap)
export const U2T = (x, y, z) => [x, z, y];

function v3(arr, i) { return [arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]]; }
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

// Inverse of 3x3 matrix with rows a,b,c; returns columns as vectors
function invRows(a, b, c) {
  const m = [a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]];
  const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  if (Math.abs(det) < 1e-12) return null;
  const id = 1 / det;
  const inv = [
    (m[4] * m[8] - m[5] * m[7]) * id, (m[2] * m[7] - m[1] * m[8]) * id, (m[1] * m[5] - m[2] * m[4]) * id,
    (m[5] * m[6] - m[3] * m[8]) * id, (m[0] * m[8] - m[2] * m[6]) * id, (m[2] * m[3] - m[0] * m[5]) * id,
    (m[3] * m[7] - m[4] * m[6]) * id, (m[1] * m[6] - m[0] * m[7]) * id, (m[0] * m[4] - m[1] * m[3]) * id,
  ];
  // columns of inv
  return [[inv[0], inv[3], inv[6]], [inv[1], inv[4], inv[7]], [inv[2], inv[5], inv[8]]];
}

// lightmap colour bytes (0..127) into an RGBA atlas at (x, y), doubled like the D3D RGBA7 upload (the
// shader's x2 is the MODULATE2X stage), with a 1px repeated border
function writeLightmap(data, S, x, y, w, h, acc) {
  for (let v = -1; v <= h; v++) for (let u = -1; u <= w; u++) {
    const su = Math.min(w - 1, Math.max(0, u)), sv = Math.min(h - 1, Math.max(0, v));
    const k = (sv * w + su) * 3, o = ((y + v) * S + (x + u)) * 4;
    data[o] = acc[k] * 2; data[o + 1] = acc[k + 1] * 2; data[o + 2] = acc[k + 2] * 2; data[o + 3] = 255;
  }
}

export async function buildLevelGeometry(ctx, pkg, modelRef, actorsByRef) {
  const { textures } = ctx;
  const model = readModel(pkg, pkg.exports[modelRef - 1]);
  const { points, vectors, nodes, surfs, verts } = model;

  // ---- zone ambient ----
  const zoneAmbient = model.zones.map(z => {
    const a = actorsByRef.get(z.zoneActor);
    const p = a ? a.props : null;
    if (!p) return [0, 0, 0];
    return hsvColor(p.AmbientHue ?? 0, p.AmbientSaturation ?? 255, p.AmbientBrightness ?? 0);
  });

  const zoneProps = z => { const zi = model.zones[z]?.zoneActor; return (zi && actorsByRef.get(zi)?.props) || (li?.props ?? null); };

  // ---- lights ----
  const li = [...actorsByRef.values()].find(a => a.cls === 'LevelInfo' || a.props?.Class?.name === 'LevelInfo');
  const levelBrightness = li?.props?.Brightness ?? 1;
  const lightCache = new Map();
  const getLight = ref => {
    if (lightCache.has(ref)) return lightCache.get(ref);
    const a = actorsByRef.get(ref);
    const L = a ? lightFromProps(a.props, a.props.Location || { x: 0, y: 0, z: 0 }) : null;
    lightCache.set(ref, L);
    return L;
  };

  // ---- lightmaps ----
  const packer = new AtlasPacker(2048);
  const dynPacker = new AtlasPacker(512), DYN_PAGE = 1000;
  const dynamicLightmaps = [], bakeRandoms = new GlobalRandoms();
  bakeRandoms.tick(0);
  const lmInfo = new Map(); // iLightMap -> { page, x, y, w, h }
  const computeLightmap = (iLM, surf, zoneIdx) => {
    if (lmInfo.has(iLM)) return lmInfo.get(iLM);
    const lm = model.lightMaps[iLM];
    const w = lm.uClamp, h = lm.vClamp;
    if (w <= 0 || h <= 0 || w > 1024 || h > 1024) { lmInfo.set(iLM, null); return null; }
    // lightmaps re-merged every frame live in their own small atlas, uploaded once per frame
    let hasDyn = false;
    if (lm.iLightActors >= 0) for (let li = lm.iLightActors; li < model.lights.length && model.lights[li]; li++) { const pr = actorsByRef.get(model.lights[li])?.props; if (pr && surfLightKind(pr) === 'dynamic') hasDyn = true; }
    const pk = hasDyn ? dynPacker : packer, slot = pk.alloc(w, h);
    const N = v3(vectors, surf.vNormal), X = v3(vectors, surf.vTextureU), Y = v3(vectors, surf.vTextureV);
    const O = v3(points, surf.pBase);
    const inv = invRows(X, Y, N);
    // FLightManager::SetupForSurf: the zone ambient (FColor of a quarter of it, on the 0..127 scale), then
    // each static light merged (mergeSurfLight); lights of the 'dynamic' kind are re-merged every frame on
    // top of that (updateDynamicLightmaps), moving lights are left to the surface shader
    const n = w * h;
    const acc = new Uint8Array(n * 3);
    const amb = zoneAmbient[zoneIdx] || [0, 0, 0];
    const ab = amb.map(c => Math.min(255, Math.max(0, Math.floor(c * 0.25 * 256))));
    for (let i = 0; i < n; i++) { acc[i * 3] = ab[0]; acc[i * 3 + 1] = ab[1]; acc[i * 3 + 2] = ab[2]; }
    const dyn = [];
    let pos = null;
    if (inv && lm.iLightActors >= 0) {
      const rowBytes = (w + 7) >> 3;
      pos = new Float32Array(n * 3);
      for (let v = 0; v < h; v++) for (let u = 0; u < w; u++) {
        const tu = lm.pan[0] + u * lm.uScale, tv = lm.pan[1] + v * lm.vScale, k = (v * w + u) * 3;
        for (let c = 0; c < 3; c++) pos[k + c] = O[c] + tu * inv[0][c] + tv * inv[1][c];
      }
      let off = lm.dataOffset;
      for (let li = lm.iLightActors; li < model.lights.length && model.lights[li]; li++) {
        const ref = model.lights[li], props = actorsByRef.get(ref)?.props, L = getLight(ref);
        const kind = props ? surfLightKind(props) : 'static';
        if (L && kind !== 'moving') {
          const shadow = filterShadow(model.lightBits, off, w, h, rowBytes);
          if (kind === 'dynamic') dyn.push({ props, shadow });
          else {
            const planeDot = (L.pos[0] - O[0]) * N[0] + (L.pos[1] - O[1]) * N[1] + (L.pos[2] - O[2]) * N[2];
            mergeSurfLight(acc, n, L, staticLightColor(L, levelBrightness), shadow,
              j => luxelSpatial(L, pos[j * 3] - L.pos[0], pos[j * 3 + 1] - L.pos[1], pos[j * 3 + 2] - L.pos[2], planeDot, N), bakeRandoms);
          }
        }
        off += rowBytes * h;
      }
    }
    writeLightmap(pk.pages[slot.page].data, pk.size, slot.x, slot.y, w, h, acc);
    if (hasDyn) dynamicLightmaps.push({ page: slot.page, x: slot.x, y: slot.y, w, h, base: acc, dyn, pos, N, O });
    const info = { page: hasDyn ? DYN_PAGE + slot.page : slot.page, x: slot.x, y: slot.y, w, h, lm, size: pk.size };
    lmInfo.set(iLM, info);
    return info;
  };

  // ---- gather polygons by material ----
  const groups = new Map(); // key -> { texRef, flags, pos:[], uv:[], uv2:[], nrm:[], page }
  const collision = [];      // flat array of triangles in Unreal coords
  const texSizes = new Map();
  const texPromises = new Map();
  const surfTex = surfs.map(s => {
    if (!s.texture) return null;
    if (!texPromises.has(s.texture)) texPromises.set(s.texture, textures.get(pkg, s.texture));
    return texPromises.get(s.texture);
  });
  const texList = await Promise.all([...texPromises.values()]);
  const texByRef = new Map([...texPromises.keys()].map((k, i) => [k, texList[i]]));

  const SKIP = PF.Invisible | PF.Portal;
  const portalGroups = new Map();
  for (let ni = 0; ni < nodes.length; ni++) {
    const node = nodes[ni];
    if (node.numVertices < 3 || node.iSurf < 0) continue;
    const surf = surfs[node.iSurf];
    const flags = surf.flags;
    const pts = [];
    for (let k = 0; k < node.numVertices; k++) pts.push(v3(points, verts[node.iVertPool + k].pVertex));
    // collision (solid surfaces only)
    if (!(flags & PF.NotSolid) && !(flags & PF.Portal)) {
      for (let k = 1; k + 1 < pts.length; k++) collision.push(pts[0], pts[k], pts[k + 1]);
    }
    // mirrors and warp-zone portals become portal polygons (portals.js); an opaque mirror shows only the
    // reflection, a translucent one is drawn over it
    {
      const N0 = v3(vectors, surf.vNormal);
      let portal = null;
      if (flags & PF.Mirrored) portal = { kind: 'mirror', key: 'm' + node.iSurf, normal: N0 };
      else if (flags & PF.Portal) {
        const zf = zoneProps(node.iZone[1]), zb = zoneProps(node.iZone[0]);
        const isWarp = z => !!z?.Class?.isA?.('WarpZoneInfo');
        if (isWarp(zf) && !isWarp(zb)) portal = { kind: 'warp', key: 'w' + node.iZone[1], zone: zf, normal: N0 };
        else if (isWarp(zb) && !isWarp(zf)) portal = { kind: 'warp', key: 'w' + node.iZone[0], zone: zb, normal: [-N0[0], -N0[1], -N0[2]] };
      }
      if (portal) {
        let pg = portalGroups.get(portal.key);
        if (!pg) { pg = { ...portal, pos: [], point: pts[0] }; portalGroups.set(portal.key, pg); }
        for (let k = 1; k + 1 < pts.length; k++) for (const q of [pts[0], pts[k + 1], pts[k]]) pg.pos.push(q[0], q[2], q[1]);
        if (portal.kind === 'mirror' && !(flags & PF.Translucent)) continue;
      }
    }
    if (flags & SKIP) continue;
    const tex = texByRef.get(surf.texture) || null;
    const tw = tex ? tex.userData.w : 64, th = tex ? tex.userData.h : 64;
    const texScale = tex && tex.userData.props.DrawScale ? tex.userData.props.DrawScale : 1;
    const zone = node.iZone[1];
    const unlit = !!(flags & PF.Unlit) || !!(flags & PF.FakeBackdrop);
    let lmi = null;
    if (!unlit && surf.iLightMap >= 0 && surf.iLightMap < model.lightMaps.length) lmi = computeLightmap(surf.iLightMap, surf, zone);
    const matFlags = flags & (PF.Masked | PF.Translucent | PF.Modulated | PF.TwoSided | PF.FakeBackdrop | PF.AutoUPan | PF.AutoVPan | PF.SmallWavy | PF.Environment | PF.Unlit | PF.Invisible);
    // (surfaces that pan or may be fogged need their zone)
    const zp = zoneProps(zone);
    const needZone = (matFlags & (PF.AutoUPan | PF.AutoVPan)) || zp?.bFogZone;
    const key = `${surf.texture}|${matFlags}|${lmi ? lmi.page : -1}|${needZone ? zone : ''}`;
    let g = groups.get(key);
    if (!g) {
      g = { tex, flags: matFlags, page: lmi ? lmi.page : -1, pos: [], uv: [], uv2: [], nrm: [], zone };
      groups.set(key, g);
    }
    const O = v3(points, surf.pBase), X = v3(vectors, surf.vTextureU), Y = v3(vectors, surf.vTextureV), N = v3(vectors, surf.vNormal);
    const S = lmi ? lmi.size : packer.size;
    const emit = p => {
      const d = sub(p, O);
      const s = dot(d, X), t = dot(d, Y);
      g.pos.push(p[0], p[2], p[1]);
      g.nrm.push(N[0], N[2], N[1]);
      g.uv.push((s + surf.panU) / (tw * texScale), (t + surf.panV) / (th * texScale));
      if (lmi) {
        const lu = (s - lmi.lm.pan[0]) / lmi.lm.uScale + 0.5, lv = (t - lmi.lm.pan[1]) / lmi.lm.vScale + 0.5;
        g.uv2.push((lmi.x + lu) / S, (lmi.y + lv) / S);
      } else g.uv2.push(0, 0);
    };
    // fan triangulation; winding reversed due to handedness mirror
    for (let k = 1; k + 1 < pts.length; k++) { emit(pts[0]); emit(pts[k + 1]); emit(pts[k]); }
  }

  // ---- atlas textures ----
  const mkPage = size => p => {
    const t = new THREE.DataTexture(p.data, size, size, THREE.RGBAFormat);
    t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearFilter;
    t.flipY = false; t.needsUpdate = true;
    return t;
  };
  const pages = packer.pages.map(mkPage(packer.size)), dynPages = dynamicLightmaps.length ? dynPacker.pages.map(mkPage(dynPacker.size)) : [];
  const white = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1, THREE.RGBAFormat);
  white.needsUpdate = true;

  const root = new THREE.Group();
  root.name = 'BSP';
  const skyBackdrop = new THREE.Group();
  for (const g of groups.values()) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(g.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(g.nrm, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(g.uv, 2));
    geo.setAttribute('uv1', new THREE.Float32BufferAttribute(g.uv2, 2));
    geo.computeBoundingSphere();
    const mat = makeSurfaceMaterial(g.tex || textures.white, g.page >= DYN_PAGE ? dynPages[g.page - DYN_PAGE] : g.page >= 0 ? pages[g.page] : white, g.flags, ctx, zoneProps(g.zone));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.matrixAutoUpdate = false;
    mesh.userData.flags = g.flags;
    if (g.flags & PF.FakeBackdrop) { mesh.userData.backdrop = true; skyBackdrop.add(mesh); }
    else root.add(mesh);
  }
  root.add(skyBackdrop);
  // portal polygons (normal: three coords, pointing toward the viewer side for mirrors / into the warp zone)
  const portals = [...portalGroups.values()].map(pg => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pg.pos, 3));
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo);
    mesh.matrixAutoUpdate = false;
    root.add(mesh);
    return { mesh, kind: pg.kind, zone: pg.zone || null, normal: new THREE.Vector3(pg.normal[0], pg.normal[2], pg.normal[1]).normalize(), point: new THREE.Vector3(pg.point[0], pg.point[2], pg.point[1]) };
  });

  // collision triangles in three coords
  const colPos = new Float32Array(collision.length * 3);
  for (let i = 0; i < collision.length; i++) {
    const p = collision[i];
    colPos[i * 3] = p[0]; colPos[i * 3 + 1] = p[2]; colPos[i * 3 + 2] = p[1];
  }
  // re-merge the lightmaps lit by dynamic lights (light-type effects, time-varying and merge-time
  // effects, triggered lights) and copy them into their atlas pages
  const updateDynamicLightmaps = (renderer, t, frame, rnd) => {
    for (const r of dynamicLightmaps) {
      const n = r.w * r.h, acc = r.base.slice();
      for (const d of r.dyn) {
        const p = d.props, L = lightFromProps(p, p.Location || { x: 0, y: 0, z: 0 });
        if (!L || !(L.brightness > 0)) continue;
        const fc = staticLightColor(L, levelBrightness, lightTypeScale(p, t, frame, rnd));
        const planeDot = (L.pos[0] - r.O[0]) * r.N[0] + (L.pos[1] - r.O[1]) * r.N[1] + (L.pos[2] - r.O[2]) * r.N[2], pos = r.pos;
        mergeSurfLight(acc, n, L, fc, d.shadow, j => luxelSpatial(L, pos[j * 3] - L.pos[0], pos[j * 3 + 1] - L.pos[1], pos[j * 3 + 2] - L.pos[2], planeDot, r.N, t), rnd);
      }
      writeLightmap(dynPacker.pages[r.page].data, dynPacker.size, r.x, r.y, r.w, r.h, acc);
    }
    for (const t of dynPages) t.needsUpdate = true;
  };

  // the polygons of a surface (Unreal coordinates), for clipping decals
  let surfPolyMap = null;
  const surfPolys = iSurf => {
    if (!surfPolyMap) {
      surfPolyMap = new Map();
      for (const nd of nodes) {
        if (nd.numVertices < 3 || nd.iSurf < 0) continue;
        const poly = [];
        for (let k = 0; k < nd.numVertices; k++) poly.push(v3(points, verts[nd.iVertPool + k].pVertex));
        if (!surfPolyMap.has(nd.iSurf)) surfPolyMap.set(nd.iSurf, []);
        surfPolyMap.get(nd.iSurf).push(poly);
      }
    }
    return surfPolyMap.get(iSurf) || [];
  };

  return { root, skyBackdrop, model, collision: colPos, pages, zoneAmbient, getLight, dynamicLightmaps, updateDynamicLightmaps, portals, surfPolys };
}
