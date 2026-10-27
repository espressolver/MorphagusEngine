// Walkability grid built on demand from the level's collision (world BSP + static blockers), for
// planning the bot's routes. The bot only *reads* the world here; it still moves Harry with key/mouse input.
import { cylinderFloor, sweepCapsule, sweepCylinder, lineTrace } from '../../src/game/engine/collision.js';
import { boxOf, sweepCylinderBox, boxTopUnder } from '../../src/game/engine/shapes.js';
import { boxLineCheck } from '../../src/game/engine/bspcol.js';

const G = 24;          // grid spacing (units)
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

export class GridNav {
  constructor(eng, opts = {}) {
    this.eng = eng;
    this.L = eng.level;
    this.p = eng.player;
    this.step = opts.step ?? 30;          // max step-up
    this.drop = opts.drop ?? 160;         // max drop we accept when walking off ledges
    this.jumpUp = opts.jumpUp ?? 0;       // extra climb allowed (jumping onto ledges)
    this.cache = new Map();
  }

  footOf(loc) { return loc.Z - this.p.CollisionHeight; }

  // Floor height under Harry's collision box at (x, y), searched from footZ+up down to footZ-down - the same
  // extent trace the engine uses to keep a walking pawn on the floor (a box partly over an edge still stands).
  floorAt(x, y, footZ, up, down) {
    const p = this.p, r = p.CollisionRadius, h = p.CollisionHeight, ext = { X: r, Y: r, Z: h };
    const start = { X: x, Y: y, Z: footZ + up + h + 2.1 }, end = { X: x, Y: y, Z: footZ - down + h };
    let best = null;
    const take = hit => { if (hit && hit.normal[2] >= 0.7 && (!best || hit.time < best.time)) best = hit; };
    take(boxLineCheck(this.L.model, start, end, ext));
    const P = this.L.physics;
    for (const o of this.solidMovers()) take(boxLineCheck(o.__moverModel, start, end, ext, 1, P.moverXf(o)));
    if (!best) return null;
    // standing height: the box rests 0.5 above the surface after the trace back-off; floors are reported as
    // the surface itself
    return best.location.Z - h - 0.5;
  }

  // is there floor right under the centre of a cell (not just under a corner of Harry's box hanging over an edge)?
  centred(x, y, z) {
    if (this.centreFloor(x, y, z)) return true;
    const P = this.L.physics, zero = { X: 0, Y: 0, Z: 0 };
    return this.solidMovers().some(o => boxLineCheck(o.__moverModel, { X: x, Y: y, Z: z + 4 }, { X: x, Y: y, Z: z - 8 }, zero, 1, P.moverXf(o)));
  }
  centreFloor(x, y, z) { return !!boxLineCheck(this.L.model, { X: x, Y: y, Z: z + 4 }, { X: x, Y: y, Z: z - 8 }, { X: 0, Y: 0, Z: 0 }); }

  // can the player move horizontally from foot position a to b? Same collision as the engine (extent box
  // against the BSP hulls), lifted by the step height like UE1 stepUp (up, across, then settle down).
  clear(ax, ay, az, bx, by, bz) {
    const p = this.p, r = p.CollisionRadius, h = p.CollisionHeight;
    const ext = { X: r, Y: r, Z: h };
    // straight across first (low ceilings), lifted by the step height when that is blocked
    const z0 = Math.max(az, bz) + h + 2.1;
    let z = z0 + this.step;
    if (!boxLineCheck(this.L.model, { X: ax, Y: ay, Z: z0 }, { X: bx, Y: by, Z: z0 }, ext)) z = z0;
    const c = { X: ax, Y: ay, Z: z }, e = { X: bx, Y: by, Z: z };
    if (z !== z0 && boxLineCheck(this.L.model, c, e, ext)) return false;
    const P = this.L.physics, d = { X: bx - ax, Y: by - ay, Z: 0 };
    for (const o of this.solidMovers()) if (boxLineCheck(o.__moverModel, c, e, ext, 1, P.moverXf(o))) return false;
    for (const o of this.blockers()) {
      const cr = { t: 1, nx: 0, ny: 0, nz: 0 };
      const box = boxOf(o);
      if (box) { if (sweepCylinderBox(c, d, r, h, box, cr) && cr.t < 1) return false; continue; }
      if (sweepCylinder(c, d, r, h, o.Location, o.CollisionRadius, o.CollisionHeight, cr) >= 0 && cr.t < 1) return false;
    }
    return true;
  }

  // movers in the way as they are now: everything except doors that open by themselves when walked into
  solidMovers() {
    if (this._movers) return this._movers;
    return (this._movers = this.L.actors.filter(o => o.__moverModel && !o.__deleted && o.bCollideActors && o.bBlockPlayers
      && !/^(BumpOpenTimed|StandOpenTimed|BumpButton)$/.test(o.__state?.name || '')));
  }



  // static blocking props (not movers, not characters which move around)
  blockers() {
    if (this._blk) return this._blk;
    const P = this.L.physics;
    return (this._blk = this.L.actors.filter(o => !o.__deleted && o !== this.p && !o.__moverMesh && o.bCollideActors && o.bBlockPlayers && !o.Class.isA('Pawn') && o.CollisionRadius > 0));
  }

  key(x, y, z) { return `${Math.round(x / G)},${Math.round(y / G)},${Math.round(z / 16)}`; }

  neighbours(n) {
    let list = this.cache.get(n.k);
    if (list) return list;
    list = [];
    for (const [dx, dy] of DIRS) {
      const x = n.x + dx * G, y = n.y + dy * G;
      const z = this.floorAt(x, y, n.z, this.step, this.drop);
      if (z !== null && this.clear(n.x, n.y, n.z, x, y, z)) {
        // cells only held up by the box's corner over an edge are walkable but a poor place to be
        const solid = this.centred(x, y, z);
        list.push({ x, y, z, k: this.key(x, y, z), cost: Math.hypot(dx, dy) * G + (z < n.z - 40 ? 30 : 0) + (solid ? 0 : 40) });
        // the next cell is only the lip of an edge: a jump may start here
        if (!solid && !(dx && dy)) { const j = this.jump(n, dx, dy); if (j) list.push(j); }
        continue;
      }
      // blocked: would Harry auto-climb here? (same test the engine uses to fire Mount)
      if (!(dx && dy)) { const c = this.climb(n, dx, dy); if (c) { list.push(c); continue; } }
      // an edge with a gap ahead: jump across
      if ((z === null || z < n.z - 60) && !(dx && dy)) { const j = this.jump(n, dx, dy); if (j) list.push(j); } // straight jumps only: diagonal take-offs are unreliable
    }
    this.cache.set(n.k, list);
    return list;
  }

  // Running jump from edge cell n across a gap to a floor 2..6 cells away at about the same height
  // (Harry: JumpZ 245 at 200 u/s clears ~100 units; a short jump still catches the far edge by auto-mounting).
  jump(n, dx, dy) {
    const step = Math.hypot(dx, dy) * G;
    if (!this.centred(n.x, n.y, n.z)) return null; // take off from solid ground, not from a corner overhanging the gap
    for (let k = 2; k <= 8 && step * k <= 175; k++) {
      const x = n.x + dx * G * k, y = n.y + dy * G * k;
      const z = this.floorAt(x, y, n.z, 40, 50);
      if (z === null) continue;
      // there must really be a gap in between (otherwise it's a walk)
      let gap = true;
      for (let m = 1; m < k; m++) { const mx = n.x + dx * G * m, my = n.y + dy * G * m, gz = this.floorAt(mx, my, n.z, 20, 60); if (gz !== null && this.centred(mx, my, gz)) { gap = false; break; } }
      if (!gap) return null;
      // landing must be a proper floor and the arc must be clear
      let room = 0;
      for (const [ddx, ddy] of DIRS.slice(0, 4)) if (this.floorAt(x + ddx * G, y + ddy * G, z, 8, 8) !== null) room++;
      if (room < 2) return null;
      if (!this.clear(n.x, n.y, n.z + 30, x, y, Math.max(z, n.z) + 30)) return null;
      // aim one cell further in when there is floor there, to land clear of the edge
      const x2 = x + dx * G, y2 = y + dy * G, z2 = this.floorAt(x2, y2, z, 8, 8);
      if (z2 !== null && this.clear(x, y, z, x2, y2, z2)) return { x: x2, y: y2, z: z2, k: this.key(x2, y2, z2), cost: step * (k + 1) + 60, jump: { X: n.x, Y: n.y, dx, dy } };
      return { x, y, z, k: this.key(x, y, z), cost: step * k + 60, jump: { X: n.x, Y: n.y, dx, dy } };
    }
    return null;
  }

  climb(n, dx, dy) {
    // try the cell centre first, then shifted along the wall (Harry can stand partly over an edge)
    for (const off of [0, 8, -8, 14, -14]) {
      const c = this.climbFrom(n.x - dy * off, n.y + dx * off, n.z, dx, dy);
      if (c) return c;
    }
    return null;
  }

  climbFrom(fx, fy, fz, dx, dy) {
    const p = this.p, P = this.L.physics, h = p.CollisionHeight;
    if (fx !== undefined && this.floorAt(fx, fy, fz, 6, 6) === null) return null;
    const loc = { X: fx, Y: fy, Z: fz + h + 2 };
    const save = p.Location;
    p.Location = loc;
    const hit = P.sweep(p, { X: dx * G * 1.5, Y: dy * G * 1.5, Z: 0 }, { stepOffset: this.step, noBump: true });
    p.Location = save;
    if (hit.t >= 1) return null;
    const at = { X: loc.X + dx * G * 1.5 * Math.max(0, hit.t - 0.02), Y: loc.Y + dy * G * 1.5 * Math.max(0, hit.t - 0.02), Z: loc.Z };
    // the wall face in front (same probe the engine uses when Harry is blocked)
    let face = null;
    for (const dz of [this.step * 0.7, this.step + 8]) {
      const s0 = { X: at.X, Y: at.Y, Z: at.Z - h + dz };
      const lt = lineTrace(this.L.world, s0, { X: s0.X + dx * (p.CollisionRadius + 12), Y: s0.Y + dy * (p.CollisionRadius + 12), Z: s0.Z });
      if (lt && lt.nz > -0.1 && lt.nz < 0.7) {
        // only faces the level designers flagged climbable (PF_SpecialPoly), same as the engine
        if (!((this.L.world.flags?.[lt.tri] ?? 0) & 0x1000)) return null;
        face = { X: lt.nx, Y: lt.ny, Z: lt.nz }; break;
      }
    }
    if (!face) return null;
    let dest = P.mountTarget(p, at, face, false), jumpGrab = false;
    // too high to climb standing: jump and grab it in the air (feet ~28 higher near the top of a jump)
    if (!dest) { dest = P.mountTarget(p, { X: at.X, Y: at.Y, Z: at.Z + 40 }, face, true); jumpGrab = !!dest; }
    if (!dest) return null;
    const z = dest.Z - h - 1.9;
    // snap onto the grid cell containing the landing spot
    const x = Math.round(dest.X / G) * G, y = Math.round(dest.Y / G) * G;
    const lz = this.floorAt(x, y, z, 6, 6);
    if (lz === null || this.floorAt(dest.X, dest.Y, z, 6, 6) === null) return null;
    if (lz < fz + this.step * 0.6) return null; // not actually higher: an ordinary step, not a climb
    // the landing must be a real floor (not a railing top): the cell must have walkable neighbours
    let room = 0;
    for (const [ddx, ddy] of DIRS.slice(0, 4)) if (this.floorAt(x + ddx * G, y + ddy * G, lz, 8, 8) !== null) room++;
    if (room < 2) return null;
    return { x, y, z: lz, k: this.key(x, y, lz), cost: G * (jumpGrab ? 6 : 4), climb: { X: -face.X, Y: -face.Y }, jumpGrab, landing: dest, from: { X: fx, Y: fy } };
  }

  // A* from the player's position to within `radius` of goal; returns [{x,y,z,jump}] or null
  plan(goal, radius = 40, maxExpand = 40000) {
    const p = this.p;
    // the world changes between plans (doors open, props get destroyed)
    this.cache.clear(); this._blk = null; this._movers = null;
    // start at Harry's exact spot, linked to the surrounding grid cells it can walk to
    const sx = p.Location.X, sy = p.Location.Y, sz = this.footOf(p.Location) - 1.9;
    const start = { x: sx, y: sy, z: sz, k: 'start' };
    const links = [];
    const gx = Math.floor(sx / G) * G, gy = Math.floor(sy / G) * G;
    for (const x of [gx - G, gx, gx + G, gx + 2 * G]) for (const y of [gy - G, gy, gy + G, gy + 2 * G]) {
      const z = this.floorAt(x, y, sz, this.step, this.drop);
      if (z !== null && this.clear(sx, sy, sz, x, y, z)) links.push({ x, y, z, k: this.key(x, y, z), cost: Math.hypot(x - sx, y - sy) });
    }
    for (const [dx, dy] of DIRS.slice(0, 4)) { const c = this.climb(start, dx, dy); if (c) links.push(c); }
    this.cache.set('start', links);
    const h = n => Math.hypot(n.x - goal.X, n.y - goal.Y) + Math.abs(n.z - (goal.Z - p.CollisionHeight)) * 0.5;
    const open = new Heap(), g = new Map([[start.k, 0]]), prev = new Map(), nodes = new Map([[start.k, start]]);
    open.push(start, h(start) * 1.3);
    let best = start, bestH = h(start), n = 0;
    while (open.size && n++ < maxExpand) {
      const cur = open.pop();
      if (nodes.get(cur.k) !== cur) continue; // superseded by a cheaper edge into the same cell
      const hc = h(cur);
      if (hc < bestH) { best = cur; bestH = hc; }
      if (Math.hypot(cur.x - goal.X, cur.y - goal.Y) < radius && Math.abs(cur.z - (goal.Z - p.CollisionHeight)) < 120) { best = cur; bestH = 0; break; }
      // the goal itself may sit off the grid (a bean in a narrow gap): step straight to it from nearby cells
      const extra = [];
      if (Math.hypot(cur.x - goal.X, cur.y - goal.Y) < 100 && cur.k !== 'goal') {
        const gz = this.floorAt(goal.X, goal.Y, cur.z, this.step, this.drop);
        if (gz !== null) {
          const gn = { x: goal.X, y: goal.Y, z: gz, k: 'goal', cost: Math.hypot(cur.x - goal.X, cur.y - goal.Y) };
          if (this.clear(cur.x, cur.y, cur.z, gn.x, gn.y, gz) && this.floored(cur, gn)) extra.push(gn);
          // or line up with it first (straight down a narrow gap)
          else if (!cur.k.startsWith('via')) for (const [vx, vy] of [[goal.X, cur.y], [cur.x, goal.Y]]) {
            const vz = this.floorAt(vx, vy, cur.z, this.step, 30), vn = { x: vx, y: vy, z: vz, k: `via${vx | 0},${vy | 0}`, cost: Math.hypot(cur.x - vx, cur.y - vy) };
            if (vz !== null && this.clear(cur.x, cur.y, cur.z, vx, vy, vz) && this.floored(cur, vn)) extra.push(vn);
          }
        }
      }
      for (const nb of [...this.neighbours(cur), ...extra]) {
        const ng = g.get(cur.k) + nb.cost;
        if (ng >= (g.get(nb.k) ?? Infinity)) continue;
        // remember the edge that reached the cell: the same cell can be reached by walking or by a jump/climb
        g.set(nb.k, ng); prev.set(nb.k, cur.k); nodes.set(nb.k, nb);
        open.push(nb, ng + h(nb) * 1.3);
      }
    }
    const path = [];
    for (let k = best.k; k; k = prev.get(k)) path.unshift(nodes.get(k));
    return { path: this.runUps(this.smooth(path)), complete: bestH === 0, expanded: n };
  }

  // insert a run-up point behind each jump's take-off cell so Harry arrives square-on at full speed
  runUps(path) {
    const out = [];
    for (let i = 0; i < path.length; i++) {
      const q = path[i];
      if (q.jump && i > 0) {
        const { X, Y, dx, dy } = q.jump, l = Math.hypot(dx, dy);
        const rx = X - dx / l * 48, ry = Y - dy / l * 48;
        const prev = out.at(-1);
        const rz = this.floorAt(rx, ry, prev.z, 10, 10);
        if (rz !== null && this.clear(rx, ry, rz, X, Y, prev.z) && Math.hypot(prev.x - rx, prev.y - ry) > 10) {
          const ru = { x: rx, y: ry, z: rz, k: 'runup' + i, cost: 0 };
          // the take-off cell itself may already be the previous point: run up to it from behind
          // (unless that point is itself the landing of a jump or climb: then back up from it and return)
          if (Math.hypot(prev.x - X, prev.y - Y) <= 4) {
            if (prev.jump || prev.climb) out.push(ru, { x: X, y: Y, z: prev.z, k: 'takeoff' + i, cost: 0 });
            else out.splice(out.length - 1, 0, ru);
          } else out.push(ru);
        }
      }
      out.push(q);
    }
    return out;
  }

  // floor all along the straight line a -> b (no gap to fall into), sampled every half cell
  floored(a, b) {
    const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (G / 2));
    for (let m = 1; m < n; m++) {
      const t = m / n, z = a.z + (b.z - a.z) * t;
      if (this.floorAt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, z, this.step, 30) === null) return false;
    }
    return true;
  }

  // drop intermediate points that have a clear, floored straight line (keeps jump points)
  smooth(path) {
    if (path.length < 3) return path;
    const out = [path[0]];
    let i = 0;
    while (i < path.length - 1) {
      let j = Math.min(path.length - 1, i + 12);
      for (; j > i + 1; j--) {
        if (path.slice(i + 1, j + 1).some(q => q.climb || q.jump) || Math.abs(path[j].z - path[i].z) > 40) continue;
        if (this.clear(path[i].x, path[i].y, path[i].z, path[j].x, path[j].y, path[j].z) && this.floored(path[i], path[j])) break;
      }
      // keep the cell just before a climb, so Harry walks up to the wall square-on
      if ((path[j + 1]?.climb || path[j + 1]?.jump) && j > i + 1 && out.at(-1) !== path[j]) { out.push(path[j]); i = j; continue; }
      out.push(path[j]); i = j;
    }
    return out;
  }
}

class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(v, pr) {
    const a = this.a; a.push([pr, v]);
    for (let i = a.length - 1; i > 0;) { const j = (i - 1) >> 1; if (a[j][0] <= a[i][0]) break; [a[i], a[j]] = [a[j], a[i]]; i = j; }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      for (let i = 0; ;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r; if (m === i) break; [a[i], a[m]] = [a[m], a[i]]; i = m; }
    }
    return top[1];
  }
}
