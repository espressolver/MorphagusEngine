// UE1 Level / Model (BSP) / Polys readers.
import { readProperties } from './uobject.js';

function arr(r, fn) {
  const n = r.idx();
  const a = new Array(n);
  for (let i = 0; i < n; i++) a[i] = fn(r);
  return a;
}

function readPrimitive(r) {
  const box = { min: r.vec(), max: r.vec(), valid: r.u8_() };
  const sphere = r.pkg.version > 61 ? [r.f32(), r.f32(), r.f32(), r.f32()] : [r.f32(), r.f32(), r.f32(), 0];
  return { box, sphere };
}

export function readPolys(pkg, exp) {
  const r = pkg.readerFor(exp);
  readProperties(r);
  const n = r.i32(); r.i32();
  const polys = [];
  for (let i = 0; i < n; i++) {
    const nv = r.idx();
    const p = {
      base: r.vec(), normal: r.vec(), texU: r.vec(), texV: r.vec(), verts: [],
    };
    for (let k = 0; k < nv; k++) p.verts.push(r.vec());
    p.flags = r.u32();
    p.actor = r.idx();
    p.texture = r.idx();
    p.texturePath = pkg.refPath(p.texture);
    p.itemName = pkg.names[r.idx()];
    p.iLink = r.idx();
    p.iBrushPoly = r.idx();
    p.panU = r.i16(); p.panV = r.i16();
    polys.push(p);
  }
  return polys;
}

export function readModel(pkg, exp) {
  const r = pkg.readerFor(exp);
  readProperties(r);
  const prim = readPrimitive(r);
  const m = { prim };
  m.vectors = readVecArray(r);
  m.points = readVecArray(r);
  m.nodes = arr(r, r => ({
    plane: [r.f32(), r.f32(), r.f32(), r.f32()],
    zoneMask: [r.u32(), r.u32()],
    flags: r.u8_(),
    iVertPool: r.idx(), iSurf: r.idx(), iBack: r.idx(), iFront: r.idx(), iPlane: r.idx(),
    iCollisionBound: r.idx(), iRenderBound: r.idx(),
    iZone: [r.u8_(), r.u8_()],
    numVertices: r.u8_(),
    iLeaf: [r.i32(), r.i32()],
  }));
  m.surfs = arr(r, r => ({
    texture: r.idx(), flags: r.u32(), pBase: r.idx(), vNormal: r.idx(), vTextureU: r.idx(), vTextureV: r.idx(),
    iLightMap: r.idx(), iBrushPoly: r.idx(), panU: r.i16(), panV: r.i16(), actor: r.idx(),
  }));
  for (const s of m.surfs) s.texturePath = pkg.refPath(s.texture);
  m.verts = arr(r, r => ({ pVertex: r.idx(), iSide: r.idx() }));
  m.numSharedSides = r.i32();
  m.numZones = r.i32();
  m.zones = [];
  for (let i = 0; i < m.numZones; i++) {
    m.zones.push({ zoneActor: r.idx(), connectivity: [r.u32(), r.u32()], visibility: [r.u32(), r.u32()] });
  }
  m.polysRef = r.idx();
  // Lightmaps
  m.lightMaps = arr(r, r => ({
    dataOffset: r.i32(), pan: r.vec(), uClamp: r.idx(), vClamp: r.idx(),
    uScale: r.f32(), vScale: r.f32(), iLightActors: r.i32(),
  }));
  {
    const n = r.idx();
    m.lightBits = r.bytes(n);
  }
  m.bounds = arr(r, r => ({ min: r.vec(), max: r.vec(), valid: r.u8_() }));
  m.leafHulls = arr(r, r => r.i32());
  m.leaves = arr(r, r => ({ iZone: r.idx(), iPermeating: r.idx(), iVolumetric: r.idx(), visibleZones: [r.u32(), r.u32()] }));
  m.lights = arr(r, r => r.idx());
  m.rootOutside = r.i32();
  m.linked = r.i32();
  m._end = r.pos; m._expEnd = r.end;
  return m;
}

function readVecArray(r) {
  const n = r.idx();
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i++) a[i] = r.f32();
  return a;
}

export function readLevel(pkg, exp) {
  const r = pkg.readerFor(exp);
  readProperties(r);
  const n = r.i32(); r.i32(); // TTransArray: Num, Max
  const actors = [];
  for (let i = 0; i < n; i++) actors.push(r.idx());
  const url = { protocol: r.str(), host: r.str(), map: r.str() };
  url.op = arr(r, r => r.str());
  url.portal = r.str(); url.port = r.i32(); url.valid = r.i32();
  const model = r.idx();
  // Navigation graph edges
  const reachSpecs = [];
  try {
    const ns = r.idx();
    for (let i = 0; i < ns; i++) {
      reachSpecs.push({ distance: r.i32(), start: r.idx(), end: r.idx(), radius: r.i32(), height: r.i32(), flags: r.i32(), pruned: r.u8_() });
    }
  } catch { /* older maps */ }
  return { actors, url, model, reachSpecs };
}
