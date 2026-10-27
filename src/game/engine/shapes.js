// HP collision primitives (Actor.CollideType): CT_AlignedCylinder (UE1 default), CT_OrientedCylinder,
// CT_Box (oriented box with half extents CollisionRadius/Width/Height) and CT_Shape (oriented mesh box).
// Non-cylinder shapes are handled as oriented boxes; moving pawns stay vertical cylinders, which are
// tested against a box by growing it with the cylinder's support extents (exact for yaw-only boxes up to
// the rounded corners).
import { rotAxes } from '../../uscript/natives_core.js';
import { readMeshBounds } from '../../engine/umesh.js';

// UMesh::GetCollisionBoundingBox(local): the mesh's BoundingBox scaled by Scale x DrawScale around its Origin
// (no RotOrigin, no PrePivot), in the actor's frame; null when the actor has no mesh
const meshBoundsCache = new Map();
export function shapeBounds(o) {
  const ref = o.Mesh;
  if (!ref?.exp || !ref.pkg) return null;
  let mb = meshBoundsCache.get(ref.exp);
  if (mb === undefined) { try { mb = readMeshBounds(ref.pkg, ref.exp); } catch { mb = null; } meshBoundsCache.set(ref.exp, mb); }
  if (!mb?.box) return null;
  const ds = o.DrawScale ?? 1, sc = mb.scale || [1, 1, 1], org = mb.origin || [0, 0, 0];
  const lo = [0, 1, 2].map(i => sc[i] * ds * (mb.box.min[i] - org[i])), hi = [0, 1, 2].map(i => sc[i] * ds * (mb.box.max[i] - org[i]));
  return { min: lo.map((v, i) => Math.min(v, hi[i])), max: hi.map((v, i) => Math.max(v, lo[i])) };
}
// UBoxPrim::ValidateActor (at load and spawn): collision size from the shape's extents
export function validateShape(o) {
  if ((o.CollideType | 0) !== CT.Shape || o.__moverMesh || o.Brush) return;
  const b = shapeBounds(o);
  if (!b) return;
  o.__shapeBounds = b;
  const ex = Math.max(-b.min[0], b.max[0]), ey = Math.max(-b.min[1], b.max[1]), ez = Math.max(-b.min[2], b.max[2]);
  o.CollisionRadius = o.CollisionWidth = Math.max(ex, ey);
  o.CollisionHeight = ez;
}

export const CT = { AlignedCylinder: 0, OrientedCylinder: 1, Box: 2, Shape: 3 };

// Oriented box of actor o, or null for a plain vertical cylinder
export function boxOf(o) {
  const t = o.CollideType | 0;
  if (t === CT.AlignedCylinder || o.__moverMesh) return null;
  const R = o.CollisionRadius || 0, H = o.CollisionHeight || 0;
  let W = o.CollisionWidth || 0;
  if (W <= 0) W = R;
  const rot = o.Rotation || { Pitch: 0, Yaw: 0, Roll: 0 };
  const L = o.Location;
  const c = o.__box;
  if (c && c.yaw === rot.Yaw && c.pitch === rot.Pitch && c.roll === rot.Roll && c.R === R && c.W === W && c.H === H && c.x === L.X && c.y === L.Y && c.z === L.Z && c.sb === (t === CT.Shape ? o.__shapeBounds : null)) return c;
  if (t === CT.OrientedCylinder) return null; // (see orientedFrame)
  const A = rotAxes(rot), ax = [A.X, A.Y, A.Z]; // local X, Y, Z unit vectors
  // CT_Shape meshes: the (possibly off-centre) mesh bounds in the actor's frame; CT_Box: R x W x H
  let e = [R, t === CT.OrientedCylinder ? R : W, H], ctr = { X: L.X, Y: L.Y, Z: L.Z };
  const sb = t === CT.Shape ? o.__shapeBounds : null;
  if (sb) {
    e = [0, 1, 2].map(i => (sb.max[i] - sb.min[i]) / 2);
    const m = [0, 1, 2].map(i => (sb.max[i] + sb.min[i]) / 2);
    ctr = { X: L.X + ax[0].X * m[0] + ax[1].X * m[1] + ax[2].X * m[2], Y: L.Y + ax[0].Y * m[0] + ax[1].Y * m[1] + ax[2].Y * m[2], Z: L.Z + ax[0].Z * m[0] + ax[1].Z * m[1] + ax[2].Z * m[2] };
  }
  const box = { yaw: rot.Yaw, pitch: rot.Pitch, roll: rot.Roll, R, W, H, x: L.X, y: L.Y, z: L.Z, c: ctr, ax, e, sb };
  o.__box = box;
  return box;
}

const dot = (a, b) => a.X * b.X + a.Y * b.Y + a.Z * b.Z;

// UOrientedCylinder: the tester is taken into the actor's frame (points rotated about its Location, the
// extent by TransformExtent) and checked against the upright cylinder there; null for unrotated ones
export function orientedFrame(o) {
  if ((o.CollideType | 0) !== CT.OrientedCylinder || o.__moverMesh) return null;
  const r = o.Rotation || {};
  if (!(r.Pitch & 65535) && !(r.Yaw & 65535) && !(r.Roll & 65535)) return null;
  const A = rotAxes(r);
  return { L: o.Location, ax: [A.X, A.Y, A.Z] };
}
export function toOriented(fr, p, d, r, h) {
  const rel = { X: p.X - fr.L.X, Y: p.Y - fr.L.Y, Z: p.Z - fr.L.Z }, [a0, a1, a2] = fr.ax;
  const ext = a => r * (Math.abs(a.X) + Math.abs(a.Y)) + h * Math.abs(a.Z);
  return {
    p: { X: fr.L.X + dot(rel, a0), Y: fr.L.Y + dot(rel, a1), Z: fr.L.Z + dot(rel, a2) },
    d: d && { X: dot(d, a0), Y: dot(d, a1), Z: dot(d, a2) },
    r: ext(a0), h: ext(a2),
  };
}
export function fromOriented(fr, n) {
  const [a0, a1, a2] = fr.ax;
  return { X: n.X * a0.X + n.Y * a1.X + n.Z * a2.X, Y: n.X * a0.Y + n.Y * a1.Y + n.Z * a2.Y, Z: n.X * a0.Z + n.Y * a1.Z + n.Z * a2.Z };
}

// extents of the box grown by the mover's (r, r, h) extent taken into the box's frame as an axis-aligned
// box around the rotated one (UE1 TransformExtent), so a turned box acts larger along its diagonal
function grown(box, r, h) {
  return box.e.map((e, i) => { const a = box.ax[i]; return e + r * (Math.abs(a.X) + Math.abs(a.Y)) + h * Math.abs(a.Z); });
}
// how deep (least penetration over the axes) a point sits inside the grown box, or -1 when outside
function depth(rel, box, g) {
  let m = Infinity;
  for (let i = 0; i < 3; i++) { const p = g[i] - Math.abs(dot(rel, box.ax[i])); if (p <= 0) return -1; m = Math.min(m, p); }
  return m;
}

// Sweep a vertical cylinder centred at p by d against the box. Fills res {t,nx,ny,nz} when hit before res.t.
export function sweepCylinderBox(p, d, r, h, box, res) {
  const g = grown(box, r, h);
  const rel = { X: p.X - box.c.X, Y: p.Y - box.c.Y, Z: p.Z - box.c.Z };
  let tmin = -Infinity, tmax = Infinity, axis = -1, sign = 1;
  for (let i = 0; i < 3; i++) {
    const o = dot(rel, box.ax[i]), v = dot(d, box.ax[i]);
    if (Math.abs(v) < 1e-9) { if (o < -g[i] || o > g[i]) return false; continue; }
    let t1 = (-g[i] - o) / v, t2 = (g[i] - o) / v, s = -1;
    if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; s = 1; }
    if (t1 > tmin) { tmin = t1; axis = i; sign = s; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return false;
  }
  if (tmax < 0 || tmin > 1 || axis < 0) return false;
  if (tmin < 0) {
    // already inside: a hit (at time 0) only when the end is deeper inside than the start (UE1 box LineCheck)
    const d0 = depth(rel, box, g), d1 = depth({ X: rel.X + d.X, Y: rel.Y + d.Y, Z: rel.Z + d.Z }, box, g);
    if (!(d0 >= 0 && d1 >= 0 && d1 > d0) || !(res.t > 0)) return false;
    let best = 0, bd = Infinity;
    for (let i = 0; i < 3; i++) { const pen = g[i] - Math.abs(dot(rel, box.ax[i])); if (pen < bd) { bd = pen; best = i; } }
    const n = box.ax[best], s = dot(rel, n) >= 0 ? 1 : -1;
    res.t = 0; res.nx = n.X * s; res.ny = n.Y * s; res.nz = n.Z * s;
    return true;
  }
  if (tmin >= res.t) return false;
  const n = box.ax[axis];
  res.t = tmin; res.nx = n.X * sign; res.ny = n.Y * sign; res.nz = n.Z * sign;
  return true;
}

// does a vertical cylinder at p overlap the box?
export function cylinderOverlapsBox(p, r, h, box) {
  const g = grown(box, r, h);
  const rel = { X: p.X - box.c.X, Y: p.Y - box.c.Y, Z: p.Z - box.c.Z };
  for (let i = 0; i < 3; i++) if (Math.abs(dot(rel, box.ax[i])) > g[i]) return false;
  return true;
}

// Highest point of the box's top face under a disc (x, y, radius r), or null; only for (nearly) upright boxes
export function boxTopUnder(box, x, y, r) {
  if (box.ax[2].Z < 0.95) return null;
  const rel = { X: x - box.c.X, Y: y - box.c.Y, Z: 0 };
  const lx = dot(rel, box.ax[0]), ly = dot(rel, box.ax[1]);
  if (Math.abs(lx) > box.e[0] + r || Math.abs(ly) > box.e[1] + r) return null;
  return box.c.Z + box.e[2] / box.ax[2].Z;
}
