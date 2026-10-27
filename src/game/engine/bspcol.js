// Box (extent) traces against the level BSP, with UE1 semantics: the moving box is tested against each
// collision hull (the convex "LeafHulls" volume attached to a BSP node) grown by the box - hull planes pushed
// out by the box's support distance, the hull's bounding box, and bevel planes along hull edges.
// This is what pawns use against the world (GetCylinderExtent() boxes), so steps, ledges and floor
// distances behave like the original game.

const NONE = -1;
const NF_NotCsg = 0x01, NF_IsNew = 0x20;
const CV_XM = 1, CV_XP = 2, CV_YM = 4, CV_YP = 8, CV_ZM = 16, CV_ZP = 32;

const f32 = new Float32Array(1), i32 = new Int32Array(f32.buffer);
const asFloat = v => { i32[0] = v; return f32[0]; };

const pushOut = (n, e) => Math.abs(n[0] * e.X) + Math.abs(n[1] * e.Y) + Math.abs(n[2] * e.Z);
const planeDot = (p, v) => p[0] * v.X + p[1] * v.Y + p[2] * v.Z - p[3];
const isCsg = n => n.numVertices > 0 && !(n.flags & (NF_IsNew | NF_NotCsg));
const childOutside = (n, front, outside) => front ? (outside || isCsg(n)) : (outside && !isCsg(n));

// hull planes + bounds of the collision volume at a node (cached)
function hullOf(model, iNode, xf) {
  if (xf) return transformHull(hullOf(model, iNode), xf);
  model.__hulls ??= new Map();
  let h = model.__hulls.get(iNode);
  if (h) return h;
  const node = model.nodes[iNode], LH = model.leafHulls;
  const planes = [], flags = [], items = [];
  let k = node.iCollisionBound;
  for (; LH[k] !== NONE && planes.length < 64; k++) {
    const ref = LH[k], pn = model.nodes[ref & ~0x40000000].plane;
    const p = (ref & 0x40000000) ? [-pn[0], -pn[1], -pn[2], -pn[3]] : [pn[0], pn[1], pn[2], pn[3]];
    planes.push(p); items.push(ref & ~0x40000000);
    flags.push((p[0] < 0 ? CV_XM : p[0] > 0 ? CV_XP : 0) | (p[1] < 0 ? CV_YM : p[1] > 0 ? CV_YP : 0) | (p[2] < 0 ? CV_ZM : p[2] > 0 ? CV_ZP : 0));
  }
  k++;
  const box = { min: [asFloat(LH[k]), asFloat(LH[k + 1]), asFloat(LH[k + 2])], max: [asFloat(LH[k + 3]), asFloat(LH[k + 4]), asFloat(LH[k + 5])] };
  h = { planes, flags, items, box };
  model.__hulls.set(iNode, h);
  return h;
}

// Planes of a brush owned by an actor (movers) are moved into world space; the box stays world-aligned.
// xf: { dir(v) local->world rotation, origin } ; plane n.x = w maps to (R n).x = w + (R n).origin
function transformPlane(p, xf) {
  const n = xf.dir({ X: p[0], Y: p[1], Z: p[2] });
  return [n.X, n.Y, n.Z, p[3] + n.X * xf.origin.X + n.Y * xf.origin.Y + n.Z * xf.origin.Z];
}
function transformHull(h, xf) {
  const planes = h.planes.map(p => transformPlane(p, xf));
  const flags = planes.map(p => (p[0] < 0 ? CV_XM : p[0] > 0 ? CV_XP : 0) | (p[1] < 0 ? CV_YM : p[1] > 0 ? CV_YP : 0) | (p[2] < 0 ? CV_ZM : p[2] > 0 ? CV_ZP : 0));
  return { planes, flags, items: h.items, box: null };
}

// line of intersection of two planes n1.x = w1, n2.x = w2: a point on it and its direction
function intersectPlanes(a, b) {
  const d = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  const n2xd = [b[1] * d[2] - b[2] * d[1], b[2] * d[0] - b[0] * d[2], b[0] * d[1] - b[1] * d[0]];
  const dxn1 = [d[1] * a[2] - d[2] * a[1], d[2] * a[0] - d[0] * a[2], d[0] * a[1] - d[1] * a[0]];
  const p = [0, 1, 2].map(k => (a[3] * n2xd[k] + b[3] * dxn1[k]) / dd);
  return { point: { X: p[0], Y: p[1], Z: p[2] }, dir: d };
}

// Swept box from `start` to `end` with half-size `extent` against `model`.
// Returns { time, normal:[x,y,z], node } of the first blocking hull, or null. time is backed off 0.5 units.
export function boxLineCheck(model, start, end, extent, maxTime = 1, xf = null) {
  if (!model?.nodes?.length) return null;
  const V = { X: end.X - start.X, Y: end.Y - start.Y, Z: end.Z - start.Z };
  const dist = Math.hypot(V.X, V.Y, V.Z);
  let bestT = Math.min(2, maxTime + 1e-6), best = null;
  let T0, T1, localHit, localItem;

  const clipTo = (p, item) => {
    const po = pushOut(p, extent);
    const d0 = planeDot(p, start), d1 = planeDot(p, end);
    let adj = d0 - po;
    if (d0 > d1 && adj >= -po && adj < 0) adj = 0; // starting just inside the skin: treat as touching
    const t = adj / (d0 - d1);
    if (d0 - d1 < -0.00001) { if (t < T1) T1 = t; }
    else if (d0 - d1 > 0.00001) { if (t > T0) { T0 = t; localHit = p; if (item >= 0) localItem = item; } }
    else if (d0 > po && d1 > po) return false;
    return T0 < T1;
  };

  const clipHull = (hull, parent) => {
    const { planes, flags, items, box } = hull;
    for (let i = 0; i < planes.length; i++) if (!clipTo(planes[i], items[i])) return false;
    // the hull's bounds (world model only), with a small epsilon so flat floors are the reported surface
    if (box && (!clipTo([0, 0, -1, 0.1 - box.min[2]], NONE) || !clipTo([0, 0, 1, box.max[2] + 0.1], NONE)
      || !clipTo([-1, 0, 0, 0.1 - box.min[0]], NONE) || !clipTo([1, 0, 0, box.max[0] - 0.1], NONE)
      || !clipTo([0, -1, 0, 0.1 - box.min[1]], NONE) || !clipTo([0, 1, 0, box.max[1] - 0.1], NONE))) return false;
    // bevels along hull edges (box corners sweeping past convex edges)
    for (let i = 0; i < planes.length; i++) {
      for (let j = 0; j < i; j++) {
        const or2 = flags[i] | flags[j];
        for (const [ax, mask] of [[[1, 0, 0], CV_XM | CV_XP], [[0, 1, 0], CV_YM | CV_YP], [[0, 0, 1], CV_ZM | CV_ZP]]) {
          if ((or2 & mask) !== mask) continue;
          const a = planes[i], b = planes[j];
          const c1 = [ax[1] * a[2] - ax[2] * a[1], ax[2] * a[0] - ax[0] * a[2], ax[0] * a[1] - ax[1] * a[0]];
          const c2 = [ax[1] * b[2] - ax[2] * b[1], ax[2] * b[0] - ax[0] * b[2], ax[0] * b[1] - ax[1] * b[0]];
          if (c1[0] * c2[0] + c1[1] * c2[1] + c1[2] * c2[2] <= 0.001) continue;
          const { point, dir } = intersectPlanes(a, b);
          let A = [ax[1] * dir[2] - ax[2] * dir[1], ax[2] * dir[0] - ax[0] * dir[2], ax[0] * dir[1] - ax[1] * dir[0]];
          const l = Math.hypot(A[0], A[1], A[2]); if (!l) continue;
          A = A.map(x => x / l);
          if (a[0] * A[0] + a[1] * A[1] + a[2] * A[2] < 0) A = A.map(x => -x);
          if (!clipTo([A[0], A[1], A[2], point.X * A[0] + point.Y * A[1] + point.Z * A[2]], NONE)) return false;
        }
      }
    }
    return true;
  };

  const visit = (iParent, iNode, outside) => {
    while (iNode !== NONE) {
      const node = model.nodes[iNode];
      const p = xf ? transformPlane(node.plane, xf) : node.plane;
      const d0 = planeDot(p, start), d1 = planeDot(p, end);
      const po = pushOut(p, { X: extent.X * 1.1, Y: extent.Y * 1.1, Z: extent.Z * 1.1 });
      const use = [d0 <= po || d1 <= po, d0 >= -po || d1 >= -po];
      const frontFirst = d0 >= d1 ? 1 : 0;
      if (use[frontFirst]) visit(iNode, frontFirst ? node.iFront : node.iBack, childOutside(node, frontFirst, outside));
      if (!use[1 - frontFirst]) return;
      iParent = iNode;
      iNode = frontFirst ? node.iBack : node.iFront;
      outside = childOutside(node, !frontFirst, outside);
    }
    const parent = model.nodes[iParent];
    if (!outside && parent.iCollisionBound !== NONE) {
      T0 = -1; T1 = bestT; localHit = null; localItem = iParent;
      if (clipHull(hullOf(model, iParent, xf), iParent) && T0 > -1 && T0 < T1 && T1 > 0) {
        bestT = T0; best = { normal: [localHit[0], localHit[1], localHit[2]], node: localItem };
      }
    }
  };
  visit(0, 0, !!model.rootOutside);
  if (!best) return null;
  const time = Math.min(1, Math.max(0, bestT - 0.5 / (dist || 1)));
  return { time, normal: best.normal, node: best.node, location: { X: start.X + V.X * time, Y: start.Y + V.Y * time, Z: start.Z + V.Z * time } };
}

// Does a box at `p` (half-size extent) overlap solid level geometry? (UE1 PointCheck with an extent)
export function boxOverlaps(model, p, extent, xf = null) {
  if (!model?.nodes?.length) return false;
  const inside = (hull) => {
    for (const pl of hull.planes) if (planeDot(pl, p) - pushOut(pl, extent) >= 0) return false;
    const b = hull.box;
    if (!b) return true;
    return p.X + extent.X > b.min[0] && p.X - extent.X < b.max[0] && p.Y + extent.Y > b.min[1] && p.Y - extent.Y < b.max[1]
      && p.Z + extent.Z > b.min[2] && p.Z - extent.Z < b.max[2];
  };
  let hit = false;
  const visit = (iParent, iNode, outside) => {
    while (iNode !== NONE && !hit) {
      const node = model.nodes[iNode];
      const pl = xf ? transformPlane(node.plane, xf) : node.plane;
      const d = planeDot(pl, p), po = pushOut(pl, extent);
      if (d < po) visit(iNode, node.iBack, childOutside(node, 0, outside)); // box reaches behind
      if (d <= -po) return;                                                // entirely behind
      iParent = iNode; outside = childOutside(node, 1, outside); iNode = node.iFront;
    }
    if (hit) return;
    const parent = model.nodes[iParent];
    if (!outside && parent.iCollisionBound !== NONE && inside(hullOf(model, iParent, xf))) hit = true;
  };
  visit(0, 0, !!model.rootOutside);
  return hit;
}

// Which BSP surface was hit (UE1 FCheckResult::BspNode/BspSurf): walk the coplanar node chain from the hit
// item and pick the polygon facing the hit normal that contains the hit location (within `radius`);
// with radius 0, fall back to any facing coplanar polygon. Returns the node or null.
export function bspNodeAt(model, item, loc, normal, radius = 0, xf = null) {
  if (item === undefined || item === NONE || !model?.nodes) return null;
  let L = loc, N = normal;
  if (xf) { // into brush space for movers
    const inv = xf.inv;
    L = inv.point(loc); N = inv.dir(normal);
  }
  const P = model.points, VP = model.verts;
  let any = null;
  for (let iNode = item, guard = 0; iNode !== NONE && guard < 256; guard++) {
    const node = model.nodes[iNode];
    if (node.numVertices > 0 && node.plane[0] * N.X + node.plane[1] * N.Y + node.plane[2] * N.Z >= 0.99) {
      any = node;
      const pt = k => { const i = VP[node.iVertPool + k].pVertex * 3; return { X: P[i], Y: P[i + 1], Z: P[i + 2] }; };
      let prev = pt(node.numVertices - 1), sense = 1, i = 0;
      for (; i < node.numVertices; i++) {
        const v = pt(i), e = { X: v.X - prev.X, Y: v.Y - prev.Y, Z: v.Z - prev.Z };
        const pn = node.plane;
        let c = { X: pn[1] * e.Z - pn[2] * e.Y, Y: pn[2] * e.X - pn[0] * e.Z, Z: pn[0] * e.Y - pn[1] * e.X };
        const cl = Math.hypot(c.X, c.Y, c.Z) || 1; c = { X: c.X / cl, Y: c.Y / cl, Z: c.Z / cl };
        const d = (L.X - v.X) * c.X + (L.Y - v.Y) * c.Y + (L.Z - v.Z) * c.Z;
        if (d * sense < -radius) { if (i === 0) sense = -1; else break; }
        prev = v;
      }
      if (i === node.numVertices) return node;
    }
    iNode = node.iPlane;
  }
  return radius !== 0 ? null : any;
}
