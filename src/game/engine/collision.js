// Collision against level geometry (triangles in Unreal space) using a BVH and swept spheres.
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

const EPS = 1e-6;

export class TriMesh {
  // tris: Float32Array of xyz triples (Unreal coords), 9 floats per triangle; normals optional (3 per tri)
  constructor(tris, normals) {
    const n = tris.length / 9;
    this.tris = tris;
    this.count = n;
    this.normals = new Float32Array(n * 3);
    this.planeD = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const o = i * 9;
      const ax = tris[o], ay = tris[o + 1], az = tris[o + 2];
      const e1x = tris[o + 3] - ax, e1y = tris[o + 4] - ay, e1z = tris[o + 5] - az;
      const e2x = tris[o + 6] - ax, e2y = tris[o + 7] - ay, e2z = tris[o + 8] - az;
      let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      if (normals) {
        const sx = normals[i * 3], sy = normals[i * 3 + 1], sz = normals[i * 3 + 2];
        if (nx * sx + ny * sy + nz * sz < 0) {
          // swap b/c so winding matches the surface normal
          for (let k = 0; k < 3; k++) { const t = tris[o + 3 + k]; tris[o + 3 + k] = tris[o + 6 + k]; tris[o + 6 + k] = t; }
          nx = -nx; ny = -ny; nz = -nz;
        }
      }
      this.normals[i * 3] = nx; this.normals[i * 3 + 1] = ny; this.normals[i * 3 + 2] = nz;
      this.planeD[i] = -(nx * ax + ny * ay + nz * az);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(tris, 3));
    this.bvh = n ? new MeshBVH(geo, { maxLeafTris: 8 }) : null;
    // MeshBVH reorders triangles via an index buffer: map BVH triangle -> original triangle
    this.remap = new Uint32Array(n);
    if (this.bvh) {
      const idx = geo.index.array;
      for (let i = 0; i < n; i++) this.remap[i] = (idx[i * 3] / 3) | 0;
    }
    this.box = new THREE.Box3();
  }

  // Collect candidate triangle indices overlapping an AABB
  query(minX, minY, minZ, maxX, maxY, maxZ, out) {
    out.length = 0;
    if (!this.bvh) return out;
    this.box.min.set(minX, minY, minZ); this.box.max.set(maxX, maxY, maxZ);
    const box = this.box;
    this.bvh.shapecast({
      intersectsBounds: b => b.intersectsBox(box),
      intersectsTriangle: (tri, idx) => { out.push(this.remap[idx]); return false; },
    });
    return out;
  }
}

// Swept sphere vs triangle (Fauerby). Returns t in [0,1] or -1, writes normal into res.
const tmp = { t: 1, nx: 0, ny: 0, nz: 0 };

function sweepSphereTri(mesh, ti, px, py, pz, dx, dy, dz, r, res) {
  const T = mesh.tris, o = ti * 9;
  const nx = mesh.normals[ti * 3], ny = mesh.normals[ti * 3 + 1], nz = mesh.normals[ti * 3 + 2];
  const d = mesh.planeD[ti];
  const dist0 = nx * px + ny * py + nz * pz + d;
  const nd = nx * dx + ny * dy + nz * dz;
  // one-sided: ignore when behind or moving away
  if (dist0 < -r * 0.5) return false;
  if (nd >= 0 && dist0 >= r) return false;
  let found = false;
  let best = res.t;
  // 1. plane contact inside triangle
  if (nd < -EPS) {
    let t0 = (r - dist0) / nd; // nd negative -> t0 >= 0 when dist0 >= r
    t0 = (dist0 - r) / -nd;
    if (t0 < 0) t0 = 0;
    if (t0 <= best) {
      const cx = px + dx * t0 - nx * r, cy = py + dy * t0 - ny * r, cz = pz + dz * t0 - nz * r;
      // if starting embedded, use projection of start
      if (pointInTri(T, o, nx, ny, nz, cx, cy, cz)) {
        if (dist0 >= r - 0.5 || nd < 0) { best = t0; res.nx = nx; res.ny = ny; res.nz = nz; found = true; }
      }
    }
  }
  if (found && best === 0) { res.t = best; return true; }
  // 2. vertices and edges
  const D2 = dx * dx + dy * dy + dz * dz;
  if (D2 < EPS) {
    if (found) res.t = best;
    return found;
  }
  for (let k = 0; k < 3; k++) {
    const vx = T[o + k * 3], vy = T[o + k * 3 + 1], vz = T[o + k * 3 + 2];
    // vertex: |P + tD - V|^2 = r^2
    const bx = px - vx, by = py - vy, bz = pz - vz;
    const b = 2 * (dx * bx + dy * by + dz * bz);
    const c = bx * bx + by * by + bz * bz - r * r;
    const t = lowestRoot(D2, b, c, best);
    if (t >= 0) {
      const hx = px + dx * t - vx, hy = py + dy * t - vy, hz = pz + dz * t - vz;
      const hl = Math.hypot(hx, hy, hz) || 1;
      if ((hx * dx + hy * dy + hz * dz) < 0) { best = t; res.nx = hx / hl; res.ny = hy / hl; res.nz = hz / hl; found = true; }
    }
    // edge k -> k+1
    const k2 = (k + 1) % 3;
    const wx = T[o + k2 * 3], wy = T[o + k2 * 3 + 1], wz = T[o + k2 * 3 + 2];
    const ex = wx - vx, ey = wy - vy, ez = wz - vz;
    const e2 = ex * ex + ey * ey + ez * ez;
    const eDotD = ex * dx + ey * dy + ez * dz;
    const eDotB = ex * -bx + ey * -by + ez * -bz; // edge . (V - P)
    const bb = -bx, bby = -by, bbz = -bz; // V - P
    const B2 = bb * bb + bby * bby + bbz * bbz;
    const DdotBB = dx * bb + dy * bby + dz * bbz;
    const A = e2 * -D2 + eDotD * eDotD;
    const Bc = e2 * 2 * DdotBB - 2 * eDotD * eDotB;
    const C = e2 * (r * r - B2) + eDotB * eDotB;
    const te = lowestRoot(A, Bc, C, best);
    if (te >= 0) {
      const f = (eDotD * te - eDotB) / e2;
      if (f >= 0 && f <= 1) {
        const qx = vx + ex * f, qy = vy + ey * f, qz = vz + ez * f;
        const hx = px + dx * te - qx, hy = py + dy * te - qy, hz = pz + dz * te - qz;
        const hl = Math.hypot(hx, hy, hz) || 1;
        if ((hx * dx + hy * dy + hz * dz) < 0) { best = te; res.nx = hx / hl; res.ny = hy / hl; res.nz = hz / hl; found = true; }
      }
    }
  }
  if (found) res.t = best;
  return found;
}

function lowestRoot(a, b, c, maxR) {
  if (Math.abs(a) < 1e-12) return -1;
  const det = b * b - 4 * a * c;
  if (det < 0) return -1;
  const s = Math.sqrt(det);
  let r1 = (-b - s) / (2 * a), r2 = (-b + s) / (2 * a);
  if (r1 > r2) { const t = r1; r1 = r2; r2 = t; }
  if (r1 >= 0 && r1 <= maxR) return r1;
  if (r2 >= 0 && r2 <= maxR && r1 < 0 && c > 0) return r2;
  return -1;
}

function pointInTri(T, o, nx, ny, nz, px, py, pz) {
  for (let k = 0; k < 3; k++) {
    const a = o + k * 3, b = o + ((k + 1) % 3) * 3;
    const ex = T[b] - T[a], ey = T[b + 1] - T[a + 1], ez = T[b + 2] - T[a + 2];
    const vx = px - T[a], vy = py - T[a + 1], vz = pz - T[a + 2];
    const cx = ey * vz - ez * vy, cy = ez * vx - ex * vz, cz = ex * vy - ey * vx;
    if (cx * nx + cy * ny + cz * nz < -1e-3) return false;
  }
  return true;
}

// Closest point on triangle (for depenetration)
export function closestOnTri(T, o, px, py, pz, out) {
  const ax = T[o], ay = T[o + 1], az = T[o + 2];
  const bx = T[o + 3], by = T[o + 4], bz = T[o + 5];
  const cx = T[o + 6], cy = T[o + 7], cz = T[o + 8];
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) { out[0] = ax; out[1] = ay; out[2] = az; return; }
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) { out[0] = bx; out[1] = by; out[2] = bz; return; }
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); out[0] = ax + abx * v; out[1] = ay + aby * v; out[2] = az + abz * v; return; }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) { out[0] = cx; out[1] = cy; out[2] = cz; return; }
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); out[0] = ax + acx * w; out[1] = ay + acy * w; out[2] = az + acz * w; return; }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    out[0] = bx + (cx - bx) * w; out[1] = by + (cy - by) * w; out[2] = bz + (cz - bz) * w; return;
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  out[0] = ax + abx * v + acx * w; out[1] = ay + aby * v + acy * w; out[2] = az + abz * v + acz * w;
}

// Sphere offsets (relative to cylinder center) approximating a capsule of radius r, half height h
export function capsuleSpheres(r, h) {
  if (h <= r) return [0];
  const top = h - r, out = [];
  const n = Math.max(1, Math.ceil((2 * top) / r));
  for (let i = 0; i <= n; i++) out.push(-top + (2 * top * i) / n);
  return out;
}

const cand = [];
// Sweep a capsule (center p, delta d) against a TriMesh. Returns hit {t, normal:[x,y,z]} or null.
export function sweepCapsule(mesh, p, d, r, h, res) {
  if (!mesh.bvh) return false;
  const offs = capsuleSpheres(r, h);
  const minX = Math.min(p.X, p.X + d.X) - r - 1, maxX = Math.max(p.X, p.X + d.X) + r + 1;
  const minY = Math.min(p.Y, p.Y + d.Y) - r - 1, maxY = Math.max(p.Y, p.Y + d.Y) + r + 1;
  const minZ = Math.min(p.Z, p.Z + d.Z) - h - 1, maxZ = Math.max(p.Z, p.Z + d.Z) + h + 1;
  mesh.query(minX, minY, minZ, maxX, maxY, maxZ, cand);
  let hit = false;
  for (const ti of cand) {
    for (const oz of offs) {
      if (sweepSphereTri(mesh, ti, p.X, p.Y, p.Z + oz, d.X, d.Y, d.Z, r, res)) { hit = true; res.tri = ti; }
    }
  }
  return hit;
}

// Push a capsule out of penetrating triangles. Returns displacement {X,Y,Z} (or null).
const cp = [0, 0, 0];
export function depenetrate(mesh, p, r, h) {
  if (!mesh.bvh) return null;
  const offs = capsuleSpheres(r, h);
  mesh.query(p.X - r - 1, p.Y - r - 1, p.Z - h - 1, p.X + r + 1, p.Y + r + 1, p.Z + h + 1, cand);
  let mx = 0, my = 0, mz = 0, any = false;
  for (let iter = 0; iter < 4; iter++) {
    let moved = false;
    for (const ti of cand) {
      const nx = mesh.normals[ti * 3], ny = mesh.normals[ti * 3 + 1], nz = mesh.normals[ti * 3 + 2];
      for (const oz of offs) {
        const sx = p.X + mx, sy = p.Y + my, sz = p.Z + mz + oz;
        const pd = nx * sx + ny * sy + nz * sz + mesh.planeD[ti];
        if (pd < -r * 0.5 || pd > r) continue;
        closestOnTri(mesh.tris, ti * 9, sx, sy, sz, cp);
        const vx = sx - cp[0], vy = sy - cp[1], vz = sz - cp[2];
        const dl = Math.hypot(vx, vy, vz);
        if (dl >= r - 0.01) continue;
        let ux, uy, uz;
        if (dl > 1e-4 && pd > 0) { ux = vx / dl; uy = vy / dl; uz = vz / dl; }
        else { ux = nx; uy = ny; uz = nz; }
        const push = r - dl + 0.05;
        mx += ux * push; my += uy * push; mz += uz * push;
        moved = any = true;
      }
    }
    if (!moved) break;
  }
  return any ? { X: mx, Y: my, Z: mz } : null;
}

// Ray/line trace vs mesh (extent 0): returns {t, normal, tri} or null
const ray = new THREE.Ray();
export function lineTrace(mesh, s, e) {
  if (!mesh.bvh) return null;
  const dx = e.X - s.X, dy = e.Y - s.Y, dz = e.Z - s.Z;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) return null;
  ray.origin.set(s.X, s.Y, s.Z);
  ray.direction.set(dx / len, dy / len, dz / len);
  const hit = mesh.bvh.raycastFirst(ray, THREE.DoubleSide, 0, len);
  if (!hit) return null;
  const ti = mesh.remap[hit.faceIndex];
  let nx = mesh.normals[ti * 3], ny = mesh.normals[ti * 3 + 1], nz = mesh.normals[ti * 3 + 2];
  // ignore back faces (we start inside solid -> treat as hit anyway)
  if (nx * dx + ny * dy + nz * dz > 0) { nx = -nx; ny = -ny; nz = -nz; }
  return { t: hit.distance / len, nx, ny, nz, tri: ti };
}

// Swept cylinder (moving: p,d,R1,H1) vs static cylinder (q,R2,H2). Returns t or -1, normal in res.
export function sweepCylinder(p, d, r1, h1, q, r2, h2, res) {
  const R = r1 + r2, H = h1 + h2;
  const ox = p.X - q.X, oy = p.Y - q.Y, oz = p.Z - q.Z;
  // xy interval
  const a = d.X * d.X + d.Y * d.Y;
  const b = 2 * (ox * d.X + oy * d.Y);
  const c = ox * ox + oy * oy - R * R;
  let tx0, tx1;
  if (a < 1e-9) { if (c > 0) return -1; tx0 = -Infinity; tx1 = Infinity; }
  else {
    const det = b * b - 4 * a * c;
    if (det < 0) return -1;
    const s = Math.sqrt(det);
    tx0 = (-b - s) / (2 * a); tx1 = (-b + s) / (2 * a);
  }
  // z interval |oz + d.Z t| <= H
  let tz0, tz1;
  if (Math.abs(d.Z) < 1e-9) { if (Math.abs(oz) > H) return -1; tz0 = -Infinity; tz1 = Infinity; }
  else {
    const t1 = (-H - oz) / d.Z, t2 = (H - oz) / d.Z;
    tz0 = Math.min(t1, t2); tz1 = Math.max(t1, t2);
  }
  const t0 = Math.max(tx0, tz0), t1 = Math.min(tx1, tz1);
  if (t0 > t1 || t1 < 0 || t0 > res.t) return -1;
  if (t0 < -1e-3) {
    // already overlapping: only block if moving further in
    const inXY = c < 0, inZ = Math.abs(oz) < H;
    if (!(inXY && inZ)) return -1;
    if (tx0 >= tz0) { // xy contact dominant
      if (b >= 0) return -1;
    } else if (oz * d.Z >= 0) return -1;
    res.t = 0;
  } else res.t = Math.max(0, t0);
  if (tx0 >= tz0) {
    const hx = ox + d.X * res.t, hy = oy + d.Y * res.t, l = Math.hypot(hx, hy) || 1;
    res.nx = hx / l; res.ny = hy / l; res.nz = 0;
  } else { res.nx = 0; res.ny = 0; res.nz = oz > 0 ? 1 : -1; }
  return res.t;
}

// Highest walkable surface under a vertical cylinder (flat bottom, radius r) between zLow and zHigh.
// Exact for planar triangles: the max of a plane over (triangle ∩ disc) lies at a triangle vertex inside
// the disc, an edge/circle intersection, or the disc rim point in the uphill direction.
const fq = [];
export function cylinderFloor(mesh, cx, cy, r, zLow, zHigh, minNz = 0.7) {
  if (!mesh.bvh) return null;
  mesh.query(cx - r, cy - r, zLow - 1, cx + r, cy + r, zHigh + 1, fq);
  let best = null;
  const T = mesh.tris, r2 = r * r;
  for (const ti of fq) {
    const nx = mesh.normals[ti * 3], ny = mesh.normals[ti * 3 + 1], nz = mesh.normals[ti * 3 + 2];
    if (nz < minNz) continue;
    const d = mesh.planeD[ti];
    const zAt = (x, y) => -(nx * x + ny * y + d) / nz;
    const o = ti * 9;
    const vx = [T[o], T[o + 3], T[o + 6]], vy = [T[o + 1], T[o + 4], T[o + 7]];
    const inTri = (x, y) => {
      let s = 0;
      for (let k = 0; k < 3; k++) {
        const k2 = (k + 1) % 3;
        const c = (vx[k2] - vx[k]) * (y - vy[k]) - (vy[k2] - vy[k]) * (x - vx[k]);
        if (Math.abs(c) < 1e-6) continue;
        const sg = c > 0 ? 1 : -1;
        if (s === 0) s = sg; else if (s !== sg) return false;
      }
      return true;
    };
    let zmax = -Infinity;
    const consider = (x, y) => { const z = zAt(x, y); if (z > zmax) zmax = z; };
    for (let k = 0; k < 3; k++) {
      const dx = vx[k] - cx, dy = vy[k] - cy;
      if (dx * dx + dy * dy <= r2) consider(vx[k], vy[k]);
      // edge-circle intersections
      const k2 = (k + 1) % 3;
      const ex = vx[k2] - vx[k], ey = vy[k2] - vy[k];
      const a = ex * ex + ey * ey;
      if (a < 1e-9) continue;
      const b = 2 * (ex * dx + ey * dy), c = dx * dx + dy * dy - r2;
      const det = b * b - 4 * a * c;
      if (det >= 0) {
        const s = Math.sqrt(det);
        for (const t of [(-b - s) / (2 * a), (-b + s) / (2 * a)]) if (t >= 0 && t <= 1) consider(vx[k] + ex * t, vy[k] + ey * t);
      }
    }
    // uphill rim point and center
    const gx = -nx / nz, gy = -ny / nz, gl = Math.hypot(gx, gy);
    const ux = gl > 1e-6 ? cx + (gx / gl) * r : cx, uy = gl > 1e-6 ? cy + (gy / gl) * r : cy;
    if (inTri(ux, uy)) consider(ux, uy);
    if (inTri(cx, cy)) consider(cx, cy);
    if (zmax === -Infinity || zmax < zLow || zmax > zHigh) continue;
    if (!best || zmax > best.z) best = { z: zmax, nx, ny, nz, tri: ti };
  }
  return best;
}
