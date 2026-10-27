// UE1-style physics and actor movement (Unreal units, Z up).
import { readModel, readPolys } from '../../engine/umodel.js';
import { TriMesh, sweepCylinder } from './collision.js';
import { rotAxes, vecRotForward, vecRotInverse } from '../../uscript/natives_core.js';
import { boxOf, sweepCylinderBox, cylinderOverlapsBox, boxTopUnder, orientedFrame, toOriented, fromOriented } from './shapes.js';
import { boxLineCheck, boxOverlaps, bspNodeAt } from './bspcol.js';
import { appRound } from '../../uscript/natives_core.js';
import { vecToRot } from '../../uscript/vm.js';
import { bonePos } from './bones.js';

export const PHYS = { None: 0, Walking: 1, Falling: 2, Swimming: 3, Flying: 4, Rotating: 5, Projectile: 6, Rolling: 7, Interpolating: 8, MovingBrush: 9, Spider: 10, Trailer: 11 };
const V = (X = 0, Y = 0, Z = 0) => ({ X, Y, Z });
const add = (a, b) => V(a.X + b.X, a.Y + b.Y, a.Z + b.Z);
const sub = (a, b) => V(a.X - b.X, a.Y - b.Y, a.Z - b.Z);
const mul = (a, s) => V(a.X * s, a.Y * s, a.Z * s);
const dot = (a, b) => a.X * b.X + a.Y * b.Y + a.Z * b.Z;
const len = a => Math.hypot(a.X, a.Y, a.Z);
const len2d = a => Math.hypot(a.X, a.Y);
const norm = a => { const l = len(a); return l > 1e-8 ? mul(a, 1 / l) : V(); };
const WALKABLE = 0.7;
// UE1 trace flags
export const TRACE = { BlockActors: 1, Movers: 2, Level: 4, ZoneChanges: 8, Others: 16, VisBlocking: 6, AllBlocking: 7, AllColliding: 23 };
const MIN_FLOOR = 1.9, MAX_FLOOR = 2.4;
const RU = Math.PI / 32768;

// UE1 GetPlayerPawn: a PlayerPawn with a viewport
function isPlayer(a) { return !!a.Player && a.Class.isA('PlayerPawn'); }
function isBrush(a) { return !!a.__moverMesh; }

// UE1 UPrimitive::LineCheck of a box (extent r, r, h) moving from s along d against a cylinder at c (radius
// R, half-height H): entry time less 0.001 (clamped to 0..1), 0 when already inside and moving inward, or null
function cylinderLineTime(s, d, r, h, c, R, H) {
  const NX = r + R, NZ = h + H, e = add(s, d);
  if ((s.X >= c.X + NX && e.X >= c.X + NX) || (s.X <= c.X - NX && e.X <= c.X - NX)) return null;
  if ((s.Y >= c.Y + NX && e.Y >= c.Y + NX) || (s.Y <= c.Y - NX && e.Y <= c.Y - NX)) return null;
  const top = c.Z + NZ, bot = c.Z - NZ;
  if ((s.Z >= top && e.Z >= top) || (s.Z <= bot && e.Z <= bot)) return null;
  let t0 = 0, t1 = 1;
  if (s.Z >= top && e.Z < top) t0 = (top - s.Z) / (e.Z - s.Z);
  else if (s.Z < top && e.Z > top) t1 = (top - s.Z) / (e.Z - s.Z);
  if (s.Z <= bot && e.Z > bot) t0 = (bot - s.Z) / (e.Z - s.Z);
  else if (s.Z > bot && e.Z < bot) t1 = (bot - s.Z) / (e.Z - s.Z);
  const kx = s.X - c.X, ky = s.Y - c.Y, A = d.X * d.X + d.Y * d.Y, B = 2 * (kx * d.X + ky * d.Y), C = kx * kx + ky * ky - NX * NX;
  if (C < 1 && s.Z > bot && s.Z < top) return d.X * kx + d.Y * ky < -0.1 ? 0 : null;
  let disc = B * B - 4 * A * C;
  if (disc < 0) return null;
  if (A < 1e-8) { if (C >= 0) return null; }
  else {
    disc = Math.sqrt(disc);
    t1 = Math.min(t1, (disc - B) * 0.5 / A);
    const t = -(disc + B) * 0.5 / A;
    if (t >= t0) t0 = t;
    if (t0 >= t1) return null;
  }
  return Math.min(1, Math.max(0, t0 - 0.001));
}

export class Physics {
  constructor(level) {
    this.level = level;
    this.vm = level.vm;
  }

  // ---------------------------------------------------------------- movers
  setupMover(a) {
    const brush = a.Brush;
    if (!brush || !brush.exp) return;
    const pkg = brush.pkg;
    const model = readModel(pkg, brush.exp);
    if (!model.polysRef) return;
    const polys = readPolys(pkg, pkg.exports[model.polysRef - 1]);
    const tris = [], norms = [], flags = [];
    for (const p of polys) {
      if (p.flags & 0x8) continue; // NotSolid
      for (let k = 1; k + 1 < p.verts.length; k++) { tris.push(...p.verts[0], ...p.verts[k], ...p.verts[k + 1]); norms.push(...p.normal); flags.push(p.flags >>> 0); }
    }
    a.__moverMesh = new TriMesh(new Float32Array(tris), new Float32Array(norms));
    a.__moverMesh.flags = new Uint32Array(flags);
    a.__polys = polys;
    if (model.nodes?.length && model.leafHulls?.length) a.__moverModel = model; // brush BSP for box checks
  }
  // brush local -> world transform for BSP checks against a mover
  moverXf(m) {
    const pp = m.PrePivot || V();
    const dir = v => vecRotForward(v, m.Rotation);
    return { dir, origin: sub(m.Location, dir(pp)), inv: { point: p => this.toLocal(m, p), dir: v => this.dirToLocal(m, v) } };
  }
  // world -> mover local
  toLocal(m, p) {
    const pp = m.PrePivot || V();
    const l = vecRotInverse(sub(p, m.Location), m.Rotation);
    const s = m.MainScale?.Scale || { X: 1, Y: 1, Z: 1 };
    return V(l.X / (s.X || 1) + pp.X, l.Y / (s.Y || 1) + pp.Y, l.Z / (s.Z || 1) + pp.Z);
  }
  dirToLocal(m, d) { return vecRotInverse(d, m.Rotation); }
  dirToWorld(m, d) { return vecRotForward(d, m.Rotation); }

  // ---------------------------------------------------------------- blocking rules
  blocks(a, o) {
    if (o === a || o.__deleted || o.__unhashed || !o.bCollideActors) return false;
    if (isBrush(o)) return !!a.bCollideWorld && (isPlayer(a) ? !!o.bBlockPlayers : !!o.bBlockActors);
    if (isBrush(a)) return !!o.bCollideWorld && (isPlayer(o) ? !!a.bBlockPlayers : !!a.bBlockActors);
    // players and projectiles are stopped by bBlockPlayers, everything else by bBlockActors
    const pl = x => isPlayer(x) || x.Class.isA('Projectile');
    return (pl(a) ? !!o.bBlockPlayers : !!o.bBlockActors) && (pl(o) ? !!a.bBlockPlayers : !!a.bBlockActors);
  }

  // ---------------------------------------------------------------- core sweep
  // Sweep actor a's collision from its location by delta (UE1 MoveActor's check). Level geometry and mover
  // brushes are tested with the actor's extent box against the BSP collision hulls; other actors with
  // their cylinders/boxes. Returns { t, nx,ny,nz, actor, bsp } (bsp: which BSP node/where, for surface lookups)
  // with t already backed off from the surface.
  sweep(a, delta, opts = {}) {
    const r = a.CollisionRadius || 0, h = a.CollisionHeight || 0;
    const ext = { X: r, Y: r, Z: h };
    const p = a.Location, end = add(p, delta), dl = len(delta);
    const res = { t: 1, nx: 0, ny: 0, nz: 0, actor: null, bsp: null };
    const lvl = this.level;
    if (a.bCollideWorld && !opts.noWorld) {
      const hit = boxLineCheck(lvl.model, p, end, ext);
      if (hit && hit.time < res.t) {
        res.t = hit.time; [res.nx, res.ny, res.nz] = hit.normal; res.actor = lvl.levelInfo;
        res.bsp = { model: lvl.model, item: hit.node, loc: hit.location, xf: null };
      }
    }
    if (a.bCollideActors || a.bCollideWorld) {
      for (const o of lvl.actors) {
        if (o === a || o.__deleted || o.__unhashed || !o.bCollideActors) continue;
        if (o === opts.ignore || (a.Owner === o && a.Class.isA('Projectile'))) continue;
        if (!this.blocks(a, o)) continue;
        // riders never block their base; with ignoreBases (being carried) the base doesn't block either
        if (this.isBasedOn(o, a) || (opts.ignoreBases && this.isBasedOn(a, o))) continue;
        if (o.__moverMesh) {
          if (!o.__moverModel) continue;
          const hit = boxLineCheck(o.__moverModel, p, end, ext, res.t, this.moverXf(o));
          if (hit && hit.time < res.t) {
            res.t = hit.time; [res.nx, res.ny, res.nz] = hit.normal; res.actor = o;
            res.bsp = { model: o.__moverModel, item: hit.node, loc: hit.location, xf: this.moverXf(o) };
          }
          continue;
        }
        if (!a.bCollideActors) continue;
        const cr = { t: res.t, nx: 0, ny: 0, nz: 0 };
        const box = boxOf(o), ofr = !box && orientedFrame(o);
        let got = false;
        if (box) got = sweepCylinderBox(p, delta, r, h, box, cr) && cr.t < res.t;
        else if (ofr) {
          const q = toOriented(ofr, p, delta, r, h);
          got = sweepCylinder(q.p, q.d, q.r, q.h, o.Location, o.CollisionRadius || 0, o.CollisionHeight || 0, cr) >= 0 && cr.t < res.t;
          if (got) { const n = fromOriented(ofr, { X: cr.nx, Y: cr.ny, Z: cr.nz }); cr.nx = n.X; cr.ny = n.Y; cr.nz = n.Z; }
        } else got = sweepCylinder(p, delta, r, h, o.Location, o.CollisionRadius || 0, o.CollisionHeight || 0, cr) >= 0 && cr.t < res.t;
        if (got) {
          res.t = dl > 0 ? Math.max(0, cr.t - 0.5 / dl) : cr.t; res.nx = cr.nx; res.ny = cr.ny; res.nz = cr.nz; res.actor = o; res.bsp = null;
        }
      }
    }
    return res;
  }

  // UE1 MoveActor: move by delta up to the first blocking hit; returns { hit, time, normal, actor, bsp }
  // (time > 0 means the actor moved at all). The check looks 2 units further than the move (not for movers),
  // so a pawn stops just short of walls; touches are found along the whole swept path.
  moveActor(a, delta, newRot, opts = {}) {
    if (a.bStatic && !opts.force) return { hit: false, time: 0, normal: V(), actor: null };
    const dl = len(delta);
    // a base carries its riders along first (and turns them with its yaw), even for a pure rotation
    if (!opts.noCarry && (dl >= 1e-4 || (newRot && newRot.Yaw !== a.Rotation.Yaw)) && this.level.actors.some(o => o.Base === a && !o.__deleted)) this.carryRiders(a, delta, newRot);
    if (newRot) a.Rotation = { Pitch: newRot.Pitch | 0, Yaw: newRot.Yaw | 0, Roll: newRot.Roll | 0 };
    if (dl < 1e-4) return { hit: false, time: 1, normal: V(), actor: null };
    const old = { ...a.Location };
    const lookAhead = isBrush(a) ? 0 : 2;
    let res = { t: 1, nx: 0, ny: 0, nz: 0, actor: null };
    const test = mul(delta, (dl + lookAhead) / dl);
    let touchLimit = 1;
    if (!opts.noCollision && (a.bCollideWorld || a.bCollideActors)) {
      res = this.sweep(a, test, opts);
      if (res.t < 1) {
        touchLimit = res.t;
        const t = ((dl + lookAhead) * res.t - lookAhead) / dl;
        if (t <= 1e-4) return { hit: true, time: 0, normal: V(res.nx, res.ny, res.nz), actor: res.actor, bsp: res.bsp };
        res.t = Math.min(1, t);
      }
    }
    // non-pawns may be refused by what they would end up overlapping (CheckEncroachment, EncroachingOn)
    if (!isBrush(a) && !opts.noEncroach && !(a.__isPawn ?? (a.__isPawn = a.Class.isA('Pawn')))
      && (a.bCollideActors || a.bBlockActors || a.bBlockPlayers) && this.checkEncroachment(a, add(old, mul(delta, res.t)), a.Rotation, false)) {
      return { hit: false, time: 0, normal: V(), actor: null };
    }
    a.Location = add(old, mul(delta, res.t));
    const hit = res.t < 1;
    if (hit && res.actor && res.actor !== this.level.levelInfo && !opts.noBump && a.Base !== res.actor && res.actor.Base !== a) {
      this.vm.event(res.actor, 'Bump', a);
      if (!a.__deleted && !res.actor.__deleted) this.vm.event(a, 'Bump', res.actor);
    }
    if (!a.__deleted && !opts.noTouch) this.touchAlong(a, old, test, touchLimit, opts);
    this.level.setActorZone(a);
    return { hit, time: res.t, normal: V(res.nx, res.ny, res.nz), actor: res.actor, bsp: res.bsp };
  }

  // flags of the BSP surface a hit landed on (radius: tolerance around the polygon, UE1 BspSurf)
  hitSurfFlags(hit, radius = 0) {
    const b = hit?.bsp;
    if (!b) return 0;
    const node = bspNodeAt(b.model, b.item, b.loc, hit.normal, radius, b.xf);
    return node ? (b.model.surfs?.[node.iSurf]?.flags >>> 0) || 0 : 0;
  }

  // is the function implemented and currently listening? (UE1 IsProbing)
  isProbing(a, name) {
    const ln = name.toLowerCase();
    return !!this.vm.findFunction(a, ln) && !a.__disabled?.has(ln) && !this.vm.probeIgnored(a, ln);
  }

  // Overlap tests for touching
  overlaps(a, o) {
    if (o.__moverMesh || a.__moverMesh) return false;
    const bo = boxOf(o);
    if (bo) return cylinderOverlapsBox(a.Location, a.CollisionRadius || 0, a.CollisionHeight || 0, bo);
    const ba = boxOf(a);
    if (ba) return cylinderOverlapsBox(o.Location, o.CollisionRadius || 0, o.CollisionHeight || 0, ba);
    for (const [x, y] of [[a, o], [o, a]]) {
      const fr = orientedFrame(y);
      if (!fr) continue;
      const q = toOriented(fr, x.Location, null, x.CollisionRadius || 0, x.CollisionHeight || 0);
      const qx = q.p.X - y.Location.X, qy = q.p.Y - y.Location.Y, R = q.r + (y.CollisionRadius || 0);
      return qx * qx + qy * qy <= R * R && Math.abs(q.p.Z - y.Location.Z) <= q.h + (y.CollisionHeight || 0);
    }
    const dx = a.Location.X - o.Location.X, dy = a.Location.Y - o.Location.Y;
    const R = (a.CollisionRadius || 0) + (o.CollisionRadius || 0);
    if (dx * dx + dy * dy > R * R) return false;
    return Math.abs(a.Location.Z - o.Location.Z) <= (a.CollisionHeight || 0) + (o.CollisionHeight || 0);
  }

  // UE1 MoveActor touches: the non-blocking actors the moving shape runs into along start..start+test
  // (up to the blocking hit, time `limit`), in order; afterwards touched actors no longer overlapping are
  // untouched. An actor overlapped without touching (spawned inside it) is only touched by moving inward.
  touchAlong(a, start, test, limit, opts = {}) {
    if (!a.bCollideActors) return;
    const hits = [];
    for (const o of this.level.actors) {
      if (o === a || o.__deleted || o.__unhashed || !o.bCollideActors || o.__moverMesh) continue;
      if (this.blocks(a, o) || this.isBasedOn(o, a) || (opts.ignoreBases && this.isBasedOn(a, o))) continue;
      if (this.touchSlots(a).includes(o)) continue;
      const t = this.shapeLineTime(a, start, test, o);
      if (t !== null && t < limit) hits.push([t, o]);
    }
    hits.sort((x, y) => x[0] - y[0]);
    for (const [, o] of hits) { if (!o.__deleted && !a.__deleted) this.beginTouch(a, o); }
    this.untouchSeparated(a);
  }
  untouchSeparated(a) {
    for (const o of [...this.touchSlots(a)]) if (o && !a.__deleted && !this.overlaps(a, o)) this.endTouch(a, o);
  }
  isBasedOn(a, o) { for (let b = a; b; b = b.Base) if (b === o) return true; return false; }

  // time the shape of `a` swept from start along d first meets actor o (UE1 UPrimitive::LineCheck for
  // cylinders: entry time minus 0.001, or 0 when already inside and moving inward), or null
  shapeLineTime(a, start, d, o) {
    const r = a.CollisionRadius || 0, h = a.CollisionHeight || 0;
    const box = boxOf(o);
    if (box) {
      if (cylinderOverlapsBox(start, r, h, box)) {
        return d.X * (start.X - box.c.X) + d.Y * (start.Y - box.c.Y) < -0.1 ? 0 : null;
      }
      const cr = { t: 1, nx: 0, ny: 0, nz: 0 };
      return sweepCylinderBox(start, d, r, h, box, cr) && cr.t < 1 ? cr.t : null;
    }
    const fr = orientedFrame(o);
    if (fr) { const q = toOriented(fr, start, d, r, h); return cylinderLineTime(q.p, q.d, q.r, q.h, o.Location, o.CollisionRadius || 0, o.CollisionHeight || 0); }
    return cylinderLineTime(start, d, r, h, o.Location, o.CollisionRadius || 0, o.CollisionHeight || 0);
  }

  touchSlots(a) { return (a.__tslots ??= [null, null, null, null]); }
  syncTouch(a) {
    const s = this.touchSlots(a);
    a.__touching = new Set(s.filter(Boolean));
    if (Array.isArray(a.Touching)) for (let i = 0; i < a.Touching.length; i++) a.Touching[i] = s[i] || null;
  }
  // UE1 TouchTo: take a free slot of the 4-entry Touching list (pruning PHYS_None actors, then non-pawns, then
  // non-players for a pawn/player when full) and send Touch; false if that Touch already undid it
  touchTo(a, o) {
    const s = this.touchSlots(a);
    let avail = -1;
    for (let i = 0; i < 4; i++) { if (!s[i]) avail = i; else if (s[i] === o) return true; }
    if (avail < 0) {
      for (let i = 0; i < 4; i++) if (s[i] && s[i].Physics === PHYS.None) { this.endTouch(a, s[i]); avail = i; }
      if (avail < 0 && o.Class.isA('Pawn')) {
        for (let i = 0; i < 4 && avail < 0; i++) if (s[i] && !s[i].Class.isA('Pawn')) { this.endTouch(a, s[i]); avail = i; }
        if (avail < 0 && o.bIsPlayer) for (let i = 0; i < 4 && avail < 0; i++) if (s[i] && !s[i].bIsPlayer) { this.endTouch(a, s[i]); avail = i; }
      }
    }
    if (avail >= 0) {
      s[avail] = o; this.syncTouch(a);
      this.vm.event(a, 'Touch', o);
      if (s[avail] !== o) return false;
    }
    return true;
  }
  beginTouch(a, o) { if (this.touchTo(a, o)) this.touchTo(o, a); }
  // UE1 EndTouch (noNotifySelf: during destruction only the other actor hears UnTouch)
  endTouch(a, o, noNotifySelf = false) {
    let s = this.touchSlots(a), i = s.indexOf(o);
    if (i >= 0) { s[i] = null; this.syncTouch(a); if (!noNotifySelf) this.vm.event(a, 'UnTouch', o); }
    s = this.touchSlots(o); i = s.indexOf(a);
    if (i >= 0) { s[i] = null; this.syncTouch(o); this.vm.event(o, 'UnTouch', a); }
  }

  // ---------------------------------------------------------------- placement
  // UE1 FindSpot: a spot near loc where a box of the given extent fits in the level geometry, nudging it out
  // of walls along the axes, then the corners; null when it can't be made to fit
  findSpot(ext, loc, assumeFit = false) {
    const model = this.level.model;
    const free = p => !boxOverlaps(model, p, ext);
    if (!ext.X && !ext.Y && !ext.Z) return free(loc) ? { ...loc } : null;
    if (assumeFit && free(loc)) return { ...loc };
    let adj = { ...loc };
    const adjust = (d, l) => {
      const h = this.visLine(adj, add(adj, d));
      if (h) adj = add(adj, mul(h.normal, (1.05 - h.time) * l));
    };
    for (const i of [-1, 1]) { adjust(V(i * ext.X, 0, 0), ext.X); adjust(V(0, i * ext.Y, 0), ext.Y); adjust(V(0, 0, i * ext.Z), ext.Z); }
    if (free(adj)) return adj;
    const tl = len(ext) + 2;
    for (const i of [-1, 1]) for (const j of [-1, 1]) for (const k of [-1, 1]) adjust(V(i * ext.X, j * ext.Y, k * ext.Z), tl);
    const off = sub(adj, loc);
    if (dot(off, off) > 1.5 * dot(ext, ext)) return null;
    return free(adj) ? adj : null;
  }
  // zero-extent trace against the level and movers (TRACE_VisBlocking): { time, normal } or null
  visLine(start, end) {
    const z = V();
    let best = null;
    const take = h => { if (h && (!best || h.time < best.time)) best = { time: h.time, normal: V(...h.normal) }; };
    take(boxLineCheck(this.level.model, start, end, z));
    for (const o of this.level.actors) {
      if (!o.__moverModel || o.__deleted || o.__unhashed || !o.bCollideActors) continue;
      take(boxLineCheck(o.__moverModel, start, end, z, 1, this.moverXf(o)));
    }
    return best;
  }
  extentOf(a) { return V(a.CollisionRadius || 0, a.CollisionRadius || 0, a.CollisionHeight || 0); }

  // UE1 FarMoveActor (SetLocation, teleports): fit the actor at dest, refuse if it encroaches, drop actors
  // based on it, flag the teleport and zero the velocity reference; true on success
  farMoveActor(a, dest, test = false, noCheck = false) {
    if (a.bStatic || a.bMovable === false) return false;
    let loc = { X: dest.X, Y: dest.Y, Z: dest.Z }, ok = true;
    if (!noCheck && (a.bCollideWorld || a.bCollideWhenPlacing)) { const l = this.findSpot(this.extentOf(a), loc); ok = !!l; if (l) loc = l; }
    if (ok && !test && !noCheck) ok = !this.checkEncroachment(a, loc, a.Rotation, true);
    if (ok) {
      if (!test) {
        for (const o of this.level.actors) if (o.Base === a && !o.__deleted) this.setBase(o, null);
        a.bJustTeleported = true;
      }
      a.Location = { ...loc };
      a.OldLocation = { ...loc };
      this.level.setActorZone(a, test);
    }
    return ok;
  }
  setLocation(a, loc) { return this.farMoveActor(a, loc); }

  // UE1 CheckEncroachment for a non-mover: actors overlapping it at loc. A blocking one may veto the move
  // (EncroachingOn); then untouch (at the current spot), EncroachedBy for blocking ones and touch the rest.
  // true = the move is refused
  checkEncroachment(a, loc, rot, touchNotify) {
    if (isBrush(a)) return this.moverEncroaches(a, loc, rot);
    if (!a.bCollideActors && !a.bBlockActors && !a.bBlockPlayers) return false;
    const save = a.Location, saveR = a.Rotation;
    a.Location = loc; a.Rotation = rot;
    const hits = this.level.actors.filter(o => o !== a && !o.__deleted && !o.__unhashed && o.bCollideActors && !isBrush(o) && this.overlaps(a, o));
    a.Location = save; a.Rotation = saveR;
    for (const o of hits) if (this.blocks(a, o) && this.vm.event(a, 'EncroachingOn', o)) return true;
    if (touchNotify) this.untouchSeparated(a);
    for (const o of hits) {
      if (o.__deleted || a.__deleted) continue;
      if (this.blocks(a, o)) this.vm.event(o, 'EncroachedBy', a);
      else if (touchNotify) this.beginTouch(a, o);
    }
    return false;
  }

  // UE1 SetBase: no loops; old base hears Detach, new base Attach (never the level), then BaseChange
  setBase(a, base, notify = true) {
    base = base || null;
    for (let b = base; b; b = b.Base) if (b === a) return;
    if (a.Base === base) return;
    const old = a.Base, LI = this.level.levelInfo;
    if (old && old !== LI && !old.__deleted) { old.StandingCount = (old.StandingCount || 1) - 1; this.vm.event(old, 'Detach', a); }
    a.Base = base;
    if (base) {
      a.__baseOffset = vecRotInverse(sub(a.Location, base.Location), base.Rotation);
      a.__baseYaw = (a.Rotation.Yaw - base.Rotation.Yaw);
    }
    if (base && base !== LI) { base.StandingCount = (base.StandingCount || 0) + 1; this.vm.event(base, 'Attach', a); }
    if (notify) this.vm.event(a, 'BaseChange');
  }

  // UE1 FindBase: whatever is within 8 units below (the level, an actor, or nothing)
  findBase(a) {
    const h = this.traceShape(a, a.Location, add(a.Location, V(0, 0, -8)), this.extentOf(a));
    const base = h ? (h.actor || this.level.levelInfo) : null;
    if (a.Base !== base) this.setBase(a, base);
  }

  // Sweep the actor's own capsule from start to end (no state change)
  traceExtent(a, start, end) {
    const saved = a.Location;
    a.Location = start;
    const res = this.sweep(a, sub(end, start), { noBump: true });
    a.Location = saved;
    if (res.t >= 1) return null;
    return { time: res.t, normal: V(res.nx, res.ny, res.nz), actor: res.actor, location: add(start, mul(sub(end, start), res.t)) };
  }

  // ---------------------------------------------------------------- traces (Actor.Trace)
  // UE1 ULevel::MultiLineCheck: every hit along start..end (extent box), sorted by time. The level BSP hit
  // (actor = LevelInfo) shortens the check to just past the wall; with checkActors every colliding actor
  // counts (cylinders, CT_Box shapes, mover brushes), without it only movers
  multiLineCheck(start, end, extent, checkActors, withLevel = true) {
    const lvl = this.level, ext = extent || V(), hits = [];
    let d = sub(end, start), dil = 1;
    if (withLevel) {
      const h = boxLineCheck(lvl.model, start, end, ext);
      if (h) {
        hits.push({ actor: lvl.levelInfo, time: h.time, location: h.location, normal: V(...h.normal), bsp: { model: lvl.model, item: h.node, loc: h.location, xf: null } });
        const dist = len(sub(h.location, start));
        dil = Math.min(1, h.time * (dist + 5) / (dist + 0.0001));
        d = mul(d, dil);
      }
    }
    const e = add(start, d);
    for (const o of lvl.actors) {
      if (o.__deleted || o.__unhashed || !o.bCollideActors) continue;
      if (o.__moverModel) {
        const xf = this.moverXf(o), h = boxLineCheck(o.__moverModel, start, e, ext, 1, xf);
        if (h) hits.push({ actor: o, time: h.time * dil, location: h.location, normal: V(...h.normal), bsp: { model: o.__moverModel, item: h.node, loc: h.location, xf } });
        continue;
      }
      if (!checkActors) continue;
      const box = boxOf(o);
      let t = null, n = V();
      if (box) { const cr = { t: 1, nx: 0, ny: 0, nz: 0 }; if (sweepCylinderBox(start, d, ext.X || 0, ext.Z || 0, box, cr) && cr.t < 1) { t = cr.t; n = V(cr.nx, cr.ny, cr.nz); } }
      else {
        const fr = orientedFrame(o), q = fr ? toOriented(fr, start, d, ext.X || 0, ext.Z || 0) : { p: start, d, r: ext.X || 0, h: ext.Z || 0 };
        t = cylinderLineTime(q.p, q.d, q.r, q.h, o.Location, o.CollisionRadius || 0, o.CollisionHeight || 0);
        if (t !== null) {
          const p = add(q.p, mul(q.d, t));
          n = V(p.X - o.Location.X, p.Y - o.Location.Y, 0); const l = len(n); n = l > 0 ? mul(n, 1 / l) : V(0, 0, 1);
          if (fr) n = fromOriented(fr, n);
        }
      }
      if (t !== null) hits.push({ actor: o, time: t * dil, location: add(start, mul(d, t)), normal: n });
    }
    hits.sort((a, b) => a.time - b.time);
    return hits;
  }

  // UE1 ULevel::SingleLineCheck: the first hit the trace flags accept, skipping the source and its owners
  singleLineCheck(source, start, end, flags, extent) {
    const hits = this.multiLineCheck(start, end, extent, !!(flags & TRACE.AllColliding & ~TRACE.VisBlocking), !!(flags & TRACE.Level));
    for (const h of hits) {
      if (source && this.isOwnedBy(source, h.actor)) continue;
      const o = h.actor;
      if (o === this.level.levelInfo) { if (flags & TRACE.Level) return h; }
      else if (o.__moverModel || o.Class.isA('Mover')) { if (flags & TRACE.Movers) return h; }
      else if (o.Class.isA('ZoneInfo')) { if (flags & TRACE.ZoneChanges) return h; }
      else if (source && this.blocks(source, o)) { if (flags & TRACE.BlockActors) return h; }
      else if (flags & TRACE.Others) return h;
    }
    return null;
  }
  isOwnedBy(a, o) { for (let x = a; x; x = x.Owner) if (x === o) return true; return false; }

  // Actor.Trace: VisBlocking (level + movers), or everything colliding with bTraceActors
  trace(start, end, extent, traceActors, source) {
    const h = this.singleLineCheck(source, start, end, traceActors ? TRACE.AllColliding : TRACE.VisBlocking, extent);
    return h ? { actor: h.actor, location: h.location, normal: h.normal, time: h.time, bsp: h.bsp } : null;
  }

  // ---------------------------------------------------------------- per-tick physics
  perform(a, dt) {
    if (dt <= 0) return;
    const oldVelocity = a.Velocity ? { ...a.Velocity } : V();
    // UE1 performPhysics: remember where this step starts (scripts compare Location with OldLocation)
    a.OldLocation = { X: a.Location.X, Y: a.Location.Y, Z: a.Location.Z };
    const isPawn = a.Class.isA('Pawn');
    switch (a.Physics) {
      case PHYS.None: break;
      case PHYS.Walking: if (isPawn) this.physWalking(a, dt); break;
      case PHYS.Falling: this.physFalling(a, dt); break;
      case PHYS.Swimming: if (isPawn) this.physSwimming(a, dt); break;
      case PHYS.Flying: if (isPawn) this.physFlying(a, dt); break;
      case PHYS.Rotating: break;
      case PHYS.Projectile: this.physProjectile(a, dt); break;
      case PHYS.Rolling: this.physRolling(a, dt); break;
      case PHYS.Interpolating: break; // moved by its InterpolationManager (interp.js)
      case PHYS.MovingBrush: this.physMovingBrush(a, dt); break;
      case PHYS.Spider: if (isPawn) this.physFlying(a, dt); break;
      case PHYS.Trailer: this.physTrailer(a, dt); break;
    }
    if (a.__deleted) return;
    // rotation: pawns when they are players or turning toward DesiredRotation (or spinning with a fixed
    // direction); other actors whenever they have a RotationRate
    if (isPawn) {
      const r = a.Rotation, d = a.DesiredRotation || r;
      const turning = a.bRotateToDesired && ((r.Pitch - d.Pitch) & 65535 || (r.Yaw - d.Yaw) & 65535 || (r.Roll - d.Roll) & 65535);
      if (a.Physics !== PHYS.Spider && a.Physics !== PHYS.Interpolating && (a.Class.isA('PlayerPawn') || turning || (!a.bRotateToDesired && a.bFixedRotationDir))) this.physicsRotation(a, dt, oldVelocity);
      a.MoveTimer = (a.MoveTimer || 0) - dt;
      a.AvgPhysicsTime = 0.8 * (a.AvgPhysicsTime || 0) + 0.2 * dt;
    } else {
      const rr = a.RotationRate;
      if (rr && (rr.Pitch || rr.Yaw || rr.Roll)) this.physicsRotation(a, dt);
    }
    // an actor touched during the move that asked for a follow-up effect
    if (a.PendingTouch && !a.__deleted) {
      const t = a.PendingTouch;
      this.vm.event(t, 'PostTouch', a);
      if (a.PendingTouch === t) { a.PendingTouch = t.PendingTouch || null; t.PendingTouch = null; }
    }
  }

  // UE1 setPhysics: walking-type modes pick up a base (given floor, else trace for one); others drop it;
  // stopping (None / Rotating) also stops movement
  setPhysics(a, ph, base) {
    if (a.Physics === ph) return;
    a.Physics = ph;
    if (ph === PHYS.Walking || ph === PHYS.None || ph === PHYS.Rolling || ph === PHYS.Rotating || ph === PHYS.Spider) {
      if (base) { if (a.Base !== base) this.setBase(a, base); }
      else this.findBase(a);
    } else if (a.Base) this.setBase(a, null);
    if (ph === PHYS.None || ph === PHYS.Rotating) { a.Velocity = V(); a.Acceleration = V(); }
  }

  // UE1 moveSmooth: move, slide along the wall that was hit (HitWall), and handle a second wall.
  // Returns what the first MoveActor returns: whether the actor moved at all.
  moveSmooth(a, delta) {
    const r = this.moveActor(a, delta);
    const moved = r.time > 0 || len(delta) < 1e-4;
    if (r.time < 1 && !a.__deleted) {
      const n = r.normal;
      let adj = mul(sub(delta, mul(n, dot(delta, n))), 1 - r.time);
      if (dot(delta, adj) >= 0) {
        const desired = norm(delta), oldN = n;
        this.vm.event(a, 'HitWall', n, r.actor);
        if (a.__deleted) return moved;
        const r2 = this.moveActor(a, adj);
        if (r2.time < 1 && !a.__deleted) {
          adj = this.twoWallAdjust(desired, adj, r2.normal, oldN, r2.time);
          this.moveActor(a, adj);
        }
      }
    }
    return moved;
  }

  // UE1 TwoWallAdjust: second wall during a slide - follow the crease of a tight corner, else slide again
  twoWallAdjust(desired, delta, n, oldN, t) {
    if (dot(oldN, n) <= 0) {
      const c = norm(V(n.Y * oldN.Z - n.Z * oldN.Y, n.Z * oldN.X - n.X * oldN.Z, n.X * oldN.Y - n.Y * oldN.X));
      let d = mul(c, dot(delta, c) * (1 - t));
      if (dot(desired, d) < 0) d = mul(d, -1);
      return d;
    }
    const d = mul(sub(delta, mul(n, dot(delta, n))), 1 - t);
    return dot(d, desired) <= 0 ? V() : d;
  }

  // UE1 fixedTurn: advance one rotation axis toward `desired` by `rate` (shortest way, or a fixed direction)
  fixedTurn(a, current, desired, rate) {
    if (rate === 0) return current & 65535;
    let result = current & 65535;
    current = result; desired &= 65535;
    if (a.bFixedRotationDir) {
      if (a.bRotateToDesired) {
        if (rate > 0) { if (current > desired) desired += 65536; result += Math.min(rate, desired - current); }
        else { if (current < desired) current += 65536; result += Math.max(rate, desired - current); }
      } else result += rate;
    } else if (a.bRotateToDesired) {
      const r = Math.abs(rate);
      if (current > desired) result += current - desired < 32768 ? -Math.min(current - desired, r) : Math.min(desired + 65536 - current, r);
      else result += desired - current < 32768 ? Math.min(desired - current, r) : -Math.min(current + 65536 - desired, r);
    }
    return result & 65535;
  }

  // apply a rotation like UE1 does: a zero-length MoveActor with the new rotation
  rotateTo(a, nr) {
    const r = a.Rotation;
    if (nr.Pitch === r.Pitch && nr.Yaw === r.Yaw && nr.Roll === r.Roll) return;
    this.moveActor(a, V(), nr);
  }

  physicsRotation(a, dt, oldVelocity) {
    const isPawn = a.__isPawn ?? (a.__isPawn = a.Class.isA('Pawn'));
    if (isPawn && !(!a.bRotateToDesired && a.bFixedRotationDir)) return this.pawnRotation(a, dt, oldVelocity);
    const rr = a.RotationRate || { Pitch: 0, Yaw: 0, Roll: 0 }, r = a.Rotation, d = a.DesiredRotation || r;
    const same = () => a.Rotation.Pitch === d.Pitch && a.Rotation.Yaw === d.Yaw && a.Rotation.Roll === d.Roll;
    if ((!a.bRotateToDesired && !a.bFixedRotationDir) || (a.bRotateToDesired && same())) return;
    const nr = { Pitch: r.Pitch, Yaw: r.Yaw, Roll: r.Roll };
    for (const k of ['Yaw', 'Pitch', 'Roll']) {
      const delta = Math.round((rr[k] || 0) * dt);
      if (delta !== 0 && (!a.bRotateToDesired || d[k] !== nr[k])) nr[k] = this.fixedTurn(a, nr[k], d[k], delta);
    }
    this.rotateTo(a, nr);
    if (a.bRotateToDesired && same() && !a.__deleted) this.vm.event(a, 'EndedRotation');
  }

  // APawn::physicsRotation: yaw/pitch turn toward DesiredRotation; roll banks with sideways acceleration
  // when the pawn has a RotationRate.Roll, else stays level
  pawnRotation(a, dt, oldVelocity) {
    const rr = a.RotationRate || { Pitch: 0, Yaw: 0, Roll: 0 }, d = a.DesiredRotation || a.Rotation;
    const nr = { Pitch: a.Rotation.Pitch, Yaw: a.Rotation.Yaw, Roll: a.Rotation.Roll };
    if (d.Yaw !== nr.Yaw) nr.Yaw = this.fixedTurn(a, nr.Yaw, d.Yaw, Math.round((rr.Yaw || 0) * dt));
    if (d.Pitch !== nr.Pitch) nr.Pitch = this.fixedTurn(a, nr.Pitch, d.Pitch, Math.round((rr.Pitch || 0) * dt));
    if ((rr.Roll || 0) > 0) {
      const level = () => { const k = Math.min(1, 8 * dt); nr.Roll = nr.Roll < 32768 ? Math.round(nr.Roll * (1 - k)) : Math.round(nr.Roll + (65536 - nr.Roll) * k); };
      const v = a.Velocity || V();
      if (a.Physics === PHYS.Walking && v.X * v.X + v.Y * v.Y + v.Z * v.Z < 40000) level();
      else {
        const ov = oldVelocity || v, acc = mul(sub(v, ov), 1 / dt);
        if (dot(acc, acc) > 10000) {
          const maxRoll = a.Physics === PHYS.Walking ? 4096 : 28000, accelRate = a.AccelRate || 500;
          nr.Roll = 0;
          const side = dot(acc, rotAxes(nr).Y);
          nr.Roll = side > 0 ? Math.min(rr.Roll, Math.round(side * maxRoll / accelRate)) : Math.max(65536 - rr.Roll, Math.round(65536 + side * maxRoll / accelRate));
          let cur = a.Rotation.Roll & 65535;
          if (nr.Roll > 32768) { if (cur < 32768) cur += 65536; } else if (cur > 32768) cur -= 65536;
          const k = Math.min(1, 5 * dt);
          nr.Roll = Math.round(nr.Roll * k + cur * (1 - k));
        } else level();
      }
    } else nr.Roll = 0;
    this.rotateTo(a, nr);
  }


  zoneOf(a) { return a.Region?.Zone || this.level.levelInfo; }
  gravity(a) { const z = this.zoneOf(a); return z.ZoneGravity || V(0, 0, -950); }

  // Pawn velocity update (UE1 calcVelocity): friction turns velocity toward the acceleration direction,
  // acceleration is capped at AccelRate (30% for walking players), speed at maxSpeed (AI: x DesiredSpeed).
  calcVelocity(a, accelDir, dt, maxSpeed, friction, fluid = 0, brake = 0, buoyant = 0) {
    const fr = Math.max(fluid, friction);
    const walkingPlayer = isPlayer(a) && a.bIsWalking;
    const ar = a.AccelRate || 500;
    let vel = a.Velocity || V();
    let acc = a.Acceleration || V();
    if (brake && len(acc) === 0) {
      const old = vel; let sum = V(), rem = dt;
      while (rem > 0.03) { vel = sub(vel, mul(vel, 2 * 0.03 * fr)); if (dot(vel, old) > 0) sum = add(sum, mul(vel, 0.03 / dt)); rem -= 0.03; }
      vel = sub(vel, mul(vel, 2 * rem * fr)); if (dot(vel, old) > 0) sum = add(sum, mul(vel, rem / dt));
      vel = sum;
      if (dot(old, vel) < 0 || dot(vel, vel) < 100) vel = V();
    } else {
      const vs = len(vel);
      if (walkingPlayer) { if (dot(acc, acc) > 0.09 * ar * ar) acc = mul(accelDir, ar * 0.3); }
      else if (dot(acc, acc) > ar * ar) acc = mul(accelDir, ar);
      vel = sub(vel, mul(sub(vel, mul(accelDir, vs)), dt * fr));
    }
    vel = add(mul(vel, 1 - fluid * friction * dt), mul(acc, dt));
    if (!isPlayer(a)) maxSpeed *= (a.DesiredSpeed ?? 1);
    if (buoyant) vel = add(vel, mul(this.gravity(a), dt * (1 - (a.Buoyancy || 0) / (a.Mass || 100))));
    if (walkingPlayer && dot(vel, vel) > 0.09 * maxSpeed * maxSpeed) {
      const sp = len(vel);
      vel = mul(vel, Math.max(0.3 * maxSpeed, sp * (1 - dt * 2 * fr)) / sp);
    } else if (dot(vel, vel) > maxSpeed * maxSpeed) vel = mul(norm(vel), maxSpeed);
    a.Acceleration = acc;
    a.Velocity = vel;
  }

  // extent trace for a's shape from start toward end (TRACE_VisBlocking-like): { t, normal, actor } or null
  traceShape(a, start, end, extent) {
    const save = a.Location, sr = a.CollisionRadius, sh = a.CollisionHeight;
    a.Location = start;
    if (extent) { a.CollisionRadius = extent.X; a.CollisionHeight = extent.Z; }
    try {
      const r = this.sweep(a, sub(end, start), { noBump: true });
      return r.t < 1 ? { t: r.t, normal: V(r.nx, r.ny, r.nz), actor: r.actor, location: add(start, mul(sub(end, start), r.t)) } : null;
    } finally { a.Location = save; a.CollisionRadius = sr; a.CollisionHeight = sh; }
  }
  // zero-extent SingleLineCheck(TRACE_VisBlocking): level BSP and movers; { t, normal, actor } or null
  lineHit(a, start, end) {
    const h = this.singleLineCheck(a, start, end, TRACE.VisBlocking, V());
    return h ? { t: h.time, normal: h.normal, actor: h.actor, location: h.location } : null;
  }

  // ---------------------------------------------------------------- walking (APawn::physWalking)
  physWalking(a, dt, iterations = 0) {
    if (!a.Class.isA('Pawn')) { a.Velocity = V(); return; }
    const zone = this.zoneOf(a);
    if (a.Region && a.Region.ZoneNumber === 0) { this.vm.event(a, 'FellOutOfWorld'); return; }
    const player = isPlayer(a);
    let groundNormal = V(0, 0, 1);
    a.Acceleration = V(a.Acceleration?.X || 0, a.Acceleration?.Y || 0, 0);
    const accelDir = len(a.Acceleration) ? norm(a.Acceleration) : V();
    this.calcVelocity(a, accelDir, dt, a.GroundSpeed ?? 320, a.bNoZoneFriction ? 0 : (zone.ZoneGroundFriction ?? 8));
    let desiredMove = a.Velocity;
    const zv = zone.ZoneVelocity || V();
    if (player || dot(zv, zv) > 90000) desiredMove = add(desiredMove, mul(zv, 25 * dt));
    const gravDir = V(0, 0, (zone.ZoneGravity?.Z || -950) > 0 ? 1 : -1);
    const stepH = a.MaxStepHeight || 25;
    const down = mul(gravDir, stepH + 2);
    const r = a.CollisionRadius || 0, h = a.CollisionHeight || 0;
    const startLoc = { ...a.Location };
    a.OldLocation = { ...a.Location };
    a.bJustTeleported = false;
    let checkedFall = false, mustJump = false, remaining = dt;
    while (remaining > 0 && iterations < 8) {
      iterations++;
      const tick = remaining > 0.05 && (player || dot(desiredMove, desiredMove) * remaining * remaining > 400) ? Math.min(0.05, remaining * 0.5) : remaining;
      remaining -= tick;
      let delta = mul(desiredMove, tick);
      const subLoc = { ...a.Location }, subMove = delta;
      let zeroMove = len(delta) < 1e-4;
      if (zeroMove) { remaining = 0; a.bHitSlopedWall = false; }
      else {
        // walkers (AI, and players holding walk) don't step off ledges
        if ((!player || a.bIsWalking) && !a.bCanFly) {
          const res = this.ledgeCheck(a, delta, accelDir, tick, gravDir, checkedFall);
          if (res) { delta = res.delta; checkedFall = res.checkedFall; mustJump ||= res.mustJump; }
        }
        let hit = this.moveActor(a, delta);
        if (a.__deleted) return;
        if (!(player === false && a.bCanFly)) a.bHitSlopedWall = hit.hit && hit.normal.Z > 0.01 && hit.normal.Z < 0.7;
        if (hit.hit) {
          if (hit.normal.Z > 0.7) groundNormal = hit.normal;
          this.stepUp(a, gravDir, norm(delta), mul(delta, 1 - hit.time), hit);
          if (a.__deleted) return;
          if (a.Physics === PHYS.Falling) {
            const want = len(subMove), got = len2d(sub(a.Location, subLoc));
            remaining += tick * (1 - Math.min(1, want ? got / want : 1));
            this.vm.event(a, 'Falling');
            if (a.Physics === PHYS.Falling) { if (remaining > 0.01) this.physFalling(a, remaining, iterations); }
            else if (a.Physics === PHYS.Flying) { a.Velocity = V(0, 0, a.AirSpeed || 400); a.Acceleration = V(0, 0, a.AccelRate || 500); if (remaining > 0.01) this.physFlying(a, remaining); }
            return;
          }
          if (a.Physics === PHYS.Projectile) return; // mounting a ledge
        }
        if (a.Physics === PHYS.Swimming) return;
      }
      // keep standing on the floor: snap down onto it within the step height, keep a small gap above it
      if (zeroMove) {
        const foot = sub(a.Location, V(0, 0, h));
        const fh = this.lineHit(a, foot, sub(foot, V(0, 0, 20)));
        const fd = fh ? fh.t * 20 : 20;
        zeroMove = !!fh && a.Base === fh.actor && fd <= 4.6 && fd >= 4.1;
      }
      if (!zeroMove) {
        const fl = this.traceShape(a, a.Location, add(a.Location, down));
        const floorDist = fl ? fl.t * (stepH + 2) : stepH + 2;
        let onFloor = null;
        if (fl && fl.normal.Z > 0.7) groundNormal = fl.normal;
        if (fl && (fl.actor !== a.Base || floorDist > 2.4)) {
          const m = this.moveActor(a, down);
          if (a.__deleted) return;
          if (m.actor && m.actor !== a.Base) this.setBase(a, m.actor);
          if (a.Physics === PHYS.Swimming) return;
          onFloor = m.hit ? m : null;
        } else if (fl) {
          if (floorDist < 1.9) this.moveActor(a, V(0, 0, 2.1 - floorDist));
          onFloor = { hit: true, normal: fl.normal, actor: fl.actor };
        }
        if (!mustJump && onFloor && onFloor.normal.Z >= 0.7) {
          // steep-ish slopes with little friction: slide down
          const fr = zone.ZoneGroundFriction ?? 8;
          if (onFloor.normal.Z < 1 && onFloor.normal.Z * fr < 3.3) {
            const slide = mul(this.gravity(a), dt * dt / (2 * Math.max(0.5, fr)));
            const d = sub(slide, mul(onFloor.normal, dot(slide, onFloor.normal)));
            if (dot(d, slide) >= 0) this.moveActor(a, d);
          }
        } else {
          if (!mustJump && a.bCanJump && !checkedFall && this.isProbing(a, 'MayFall')) { checkedFall = true; this.vm.event(a, 'MayFall'); }
          if (!mustJump && (!a.bCanJump || a.bIsWalking)) {
            // not allowed to walk off: undo this move
            a.Velocity = V(); a.Acceleration = V();
            a.Location = { ...a.OldLocation }; this.level.setActorZone(a);
            a.MoveTimer = -1;
            return;
          }
          if (onFloor) a.bHitSlopedWall = true;
          const want = len(subMove), got = len2d(sub(a.Location, subLoc));
          remaining = want === 0 ? 0 : remaining + tick * (1 - Math.min(1, got / want));
          a.Velocity = V(a.Velocity.X, a.Velocity.Y, 0);
          this.vm.event(a, 'Falling');
          if (a.__deleted) return;
          if (a.Physics === PHYS.Walking) this.setPhysics(a, PHYS.Falling);
          if (!mustJump && a.Physics === PHYS.Falling) {
            const vz = a.Velocity.Z;
            if (!a.bJustTeleported && dt > remaining) a.Velocity = mul(sub(a.Location, a.OldLocation), 1 / (dt - remaining));
            a.Velocity = V(a.Velocity.X, a.Velocity.Y, vz);
            if (remaining > 0.01) this.physFalling(a, remaining, iterations);
            return;
          }
          this.moveActor(a, mul(desiredMove, remaining));
          remaining = 0;
        }
      }
    }
    // velocity is what actually happened, along the ground plane, keeping its speed
    if (!a.bJustTeleported) {
      let v = mul(sub(a.Location, startLoc), 1 / dt);
      const sp = len(v);
      if (sp > 0 && groundNormal.Z > 0) {
        v = V(v.X, v.Y, v.Z - dot(groundNormal, v) / groundNormal.Z);
        const sp2 = len(v);
        if (sp2 > 0) v = mul(v, sp / sp2);
      }
      a.Velocity = v;
    }
  }

  // AI / walking-player ledge handling before a walking move (the reference's "found a ledge" logic)
  ledgeCheck(a, delta, accelDir, tick, gravDir, checkedFall) {
    const r = a.CollisionRadius || 0, h = a.CollisionHeight || 0, stepH = a.MaxStepHeight || 25;
    const player = isPlayer(a);
    let fwd = mul(accelDir, r);
    if (!a.bAvoidLedges) fwd = mul(fwd, 0.5);
    let destn = add(add(a.Location, delta), fwd);
    if (this.lineHit(a, a.Location, destn)) return null; // a wall ahead: the move itself will handle it
    const dist = len(delta);
    const testDown = Math.max(4 + stepH + h, 4 + h + r + dist);
    let fh = this.lineHit(a, destn, add(destn, mul(gravDir, testDown)));
    const maxRadius = Math.min(14, 0.5 * r);
    if (!fh || (fh.normal.Z > 0.7 && fh.t * testDown > h + stepH + 4
      && fh.t * testDown > h + 4 + Math.sqrt(1 - fh.normal.Z * fh.normal.Z) * (r + dist) / fh.normal.Z))
      fh = this.traceShape(a, destn, add(destn, mul(gravDir, stepH + 4)), { X: maxRadius, Y: maxRadius, Z: h });
    if (fh) return null; // there is floor ahead
    // a ledge ahead
    const desiredDir = mul(delta, 1 / dist);
    const ledgeDownA = mul(gravDir, h + 6);
    destn = add(add(a.Location, mul(accelDir, dist)), fwd);
    const lh = this.lineHit(a, add(add(a.Location, ledgeDownA), mul(accelDir, -2 * r)), add(destn, ledgeDownA));
    const ledgeDown = mul(gravDir, stepH + 6);
    let moveForward = false, goodMove = false, ledgeDir;
    const speed = a.DesiredSpeed ?? 1, gs = a.GroundSpeed ?? 320;
    if (lh) {
      if (a.bAvoidLedges) {
        ledgeDir = norm(V(lh.normal.X, lh.normal.Y, 0));
        delta = mul(ledgeDir, -speed * gs * tick);
        if (a.bStopAtLedges) a.MoveTimer = -1; else a.MoveTimer = (a.MoveTimer || 0) - 0.25;
      } else {
        ledgeDir = norm(V(lh.normal.Y, -lh.normal.X, 0));
        if (dot(ledgeDir, accelDir) < 0) ledgeDir = mul(ledgeDir, -1);
        const dp = dot(ledgeDir, accelDir);
        moveForward = dp < 0.5 || (a.bCanJump && dp < 0.7);
        delta = mul(ledgeDir, (dp < 0.7 ? Math.min(0.8, speed) : speed) * gs * tick);
      }
    } else {
      ledgeDir = V(desiredDir.Y, -desiredDir.X, 0);
      moveForward = true;
      delta = mul(ledgeDir, Math.min(0.8, speed) * gs * tick);
      const d2 = add(a.Location, delta);
      if (!this.traceShape(a, a.Location, d2)) { if (!this.traceShape(a, d2, add(d2, ledgeDown))) delta = mul(delta, -1); else goodMove = true; }
      else goodMove = true;
    }
    let mustJump = false;
    if (player) {
      moveForward = false;
      if (!goodMove) {
        const d3 = add(add(a.Location, delta), fwd);
        let hh = this.traceShape(a, a.Location, d3);
        if (!hh) hh = this.traceShape(a, d3, add(d3, ledgeDown), { X: maxRadius, Y: maxRadius, Z: h });
        if (!hh) { a.Acceleration = V(); delta = V(); }
      }
    }
    if (a.bCanJump && moveForward) {
      if (!this.isProbing(a, 'MayFall')) delta = mul(accelDir, dist);
      else if (!checkedFall) {
        checkedFall = true; this.vm.event(a, 'MayFall');
        if (a.bCanJump) { mustJump = true; delta = mul(accelDir, dist); }
      }
    }
    return { delta, checkedFall, mustJump };
  }

  // APawn::stepUp: blocked while walking - try to mount, else lift by the step height, move, slide, settle down
  stepUp(a, gravDir, desiredDir, delta, hit) {
    if (this.mount(a, V(-gravDir.X, -gravDir.Y, -gravDir.Z), hit, false)) return;
    const stepH = a.MaxStepHeight || 25;
    const downV = mul(gravDir, stepH), up = mul(downV, -1);
    this.moveActor(a, up);
    let m = this.moveActor(a, delta);
    if (a.__deleted) return;
    if (m.hit) {
      const pushable = isPlayer(a) && m.actor?.Class?.isA('Decoration') && m.actor.bPushable && dot(m.normal, desiredDir) < -0.9;
      if (pushable) {
        a.bJustTeleported = true;
        a.Velocity = mul(a.Velocity, (a.Mass || 100) / ((a.Mass || 100) + (m.actor.Mass || 100)));
        this.processHitWall(a, m.normal, m.actor);
        if (a.Physics === PHYS.Falling) return;
      } else if (Math.abs(m.normal.Z) < 0.2 && m.time * dot(delta, delta) > 144) {
        this.stepUp(a, gravDir, desiredDir, mul(delta, 1 - m.time), m);
        if (a.Physics === PHYS.Falling) return;
      } else {
        this.processHitWall(a, m.normal, m.actor);
        if (a.__deleted) return;
        const orig = delta, oldN = m.normal;
        delta = mul(sub(delta, mul(m.normal, dot(delta, m.normal))), 1 - m.time);
        if (dot(delta, orig) >= 0) {
          m = this.moveActor(a, delta);
          if (m.hit) {
            this.processHitWall(a, m.normal, m.actor);
            if (a.Physics === PHYS.Falling || a.__deleted) return;
            this.moveActor(a, this.twoWallAdjust(desiredDir, delta, m.normal, oldN, m.time));
          }
        }
      }
    }
    m = this.moveActor(a, downV);
    if (m.hit && m.normal.Z < 0.5) {
      const d = mul(sub(downV, mul(m.normal, dot(downV, m.normal))), 1 - m.time);
      if (dot(d, downV) >= 0) this.moveActor(a, d);
    }
  }

  // HP APawn::Mount: a pawn with MaxMountHeight running or jumping into a wall face marked PF_SpecialPoly
  // (designer-flagged climbable), while facing it, gets Mount(Delta) if there is a resting spot on top
  // within MaxMountHeight and room to get there (up, then over).
  mount(a, mountDir, hit, falling) {
    if (!(a.MaxMountHeight > 0) || !hit) return false;
    const n = hit.normal;
    if (!(n.Z > -0.1 && n.Z < 0.7)) return false;
    const yaw = (a.Rotation?.Yaw || 0) * RU, pitch = (a.Rotation?.Pitch || 0) * RU;
    const facing = V(Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch));
    if (dot(n, facing) >= 0) return false;
    if (!(this.hitSurfFlags(hit, Math.max(a.CollisionRadius || 0, a.CollisionHeight || 0)) & 0x1000)) return false; // PF_SpecialPoly
    const dest = this.mountTarget(a, a.Location, n, falling, mountDir);
    if (!dest) return false;
    if (hit.actor !== a.Base) this.setBase(a, hit.actor);
    this.vm.event(a, 'Mount', sub(dest, a.Location));
    return true;
  }

  // resting spot for a mount: up MaxMountHeight, forward past the wall (two radii, more for sloped walls),
  // then down onto whatever is there; the climb up and over must be clear
  mountTarget(a, loc, n, falling, mountDir = V(0, 0, 1)) {
    const maxH = a.MaxMountHeight || 0, r = a.CollisionRadius || 0;
    const md = norm(V(-n.X, -n.Y, 0));
    const L1 = add(loc, mul(mountDir, maxH));
    const L2 = add(L1, mul(md, 2 * r + n.Z * maxH));
    const L3 = sub(sub(L2, mul(mountDir, maxH)), mul(md, n.Z * maxH));
    const restHit = this.traceShape(a, L2, L3);
    if (!restHit) return null;
    if (restHit.location.Z - loc.Z < (falling ? 0 : (a.MaxStepHeight || 25))) return null;
    const dest = add(restHit.location, V(0, 0, 2));
    const up = V(L1.X, L1.Y, dest.Z);
    if (this.traceShape(a, loc, up) || this.traceShape(a, up, dest)) return null;
    return dest;
  }

  // sweep a's collision shape from an arbitrary start (no side effects)
  sweepFrom(a, start, delta) {
    const save = a.Location;
    a.Location = start;
    try { return this.sweep(a, delta, { noBump: true }); } finally { a.Location = save; }
  }

  // AActor::processHitWall: pawns only get HitWall when moving toward their destination into the wall
  processHitWall(a, normal, actor) {
    if (actor?.Class?.isA('Pawn')) return;
    if (a.Class.isA('Pawn')) {
      if (!len(a.Acceleration || V())) return;
      let dir = norm(sub(a.Destination || a.Location, a.Location)), n = normal;
      if (a.Physics === PHYS.Walking) { n = V(n.X, n.Y, 0); dir = V(dir.X, dir.Y, 0); }
      if ((a.MinHitWall ?? -1) < dot(dir, n)) return;
      if (!this.isProbing(a, 'HitWall') && a.Physics !== PHYS.Falling) { a.bFromWall = true; return; }
    } else if (!this.isProbing(a, 'HitWall')) return;
    this.vm.event(a, 'HitWall', normal, actor);
  }

  // AActor::processLanded
  processLanded(a, normal, hitActor, remaining, iterations = 0) {
    const zone = this.zoneOf(a), isPawn = a.Class.isA('Pawn');
    if (!isPawn && zone.bBounceVelocity && len(zone.ZoneVelocity || V())) { a.Velocity = add(zone.ZoneVelocity, V(0, 0, 80)); return; }
    if (a.Class.isA('Decoration')) {
      // decorations landing on an edge tip over the side they hang across (up to 5 times)
      if ((a.numLandings | 0) < 5) {
        const r = a.CollisionRadius || 0, h = a.CollisionHeight || 0;
        const under = this.lineHit(a, sub(a.Location, V(0, 0, 0.8 * h)), sub(a.Location, V(0, 0, h + r + 8)));
        if (!under) {
          const part = { X: 0.5 * r, Y: 0.5 * r, Z: h };
          const q = [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([sx, sy]) => {
            const c = add(a.Location, V(sx * 0.5 * r, sy * 0.5 * r, 0));
            return this.traceShape(a, c, sub(c, V(0, 0, 8)), part) ? 0 : 1;
          });
          if (q[0] + q[1] + q[2] + q[3] > 1 && q[0] + q[2] !== 0 && q[1] + q[3] !== 0) {
            a.numLandings = (a.numLandings | 0) + 1;
            const k = 2 * Math.min(Math.max(-a.Velocity.Z, 30), 30 + r);
            a.Velocity = mul(V(q[0] + q[3] - q[1] - q[2], q[0] + q[1] - q[2] - q[3], 0.5), k);
            return;
          }
        }
        a.numLandings = 0;
      } else a.numLandings = 0;
    }
    this.vm.event(a, 'Landed', normal);
    if (a.__deleted) return;
    if (a.Physics === PHYS.Falling) {
      if (isPawn) this.setPhysics(a, PHYS.Walking, hitActor);
      else { this.setPhysics(a, PHYS.None, hitActor); a.Velocity = V(); }
    }
    if (a.Physics === PHYS.Walking && isPawn) {
      a.Acceleration = norm(a.Acceleration || V());
      if (remaining > 0.01) this.physWalking(a, remaining, iterations);
    }
  }

  // ---------------------------------------------------------------- falling (AActor::physFalling)
  physFalling(a, dt, iterations = 0) {
    const zone = this.zoneOf(a), isPawn = a.Class.isA('Pawn');
    if (a.Region && a.Region.ZoneNumber === 0) {
      if (isPawn || a.Class.isA('Inventory') || a.Class.isA('Decoration')) this.vm.event(a, 'FellOutOfWorld');
      return;
    }
    const g = zone.ZoneGravity || V(0, 0, -950);
    let boundSpeed = 0;
    const realAccel = { ...(a.Acceleration || V()) };
    let accel = V(realAccel.X, realAccel.Y, realAccel.Z);
    if (isPawn) {
      let air = a.AirControl ?? 0.05;
      const ar = a.AccelRate || 500;
      if (air > 0.15) {
        // strong air control is dropped near walls
        const test = mul(add(mul(norm(accel), air * ar), a.Velocity || V()), dt);
        if (this.traceShape(a, a.Location, add(a.Location, V(test.X, test.Y, 0)))) air = 0.05;
      }
      let maxAccel = ar * air;
      const v2 = len2d(a.Velocity || V());
      accel = V(accel.X, accel.Y, 0);
      if (v2 < 10) maxAccel += (10 - v2) / dt;      // allow an initial burst
      else if (v2 >= (a.GroundSpeed ?? 320)) { if (air <= 0.05) maxAccel = 1; else boundSpeed = v2; }
      if (dot(accel, accel) > maxAccel * maxAccel) accel = mul(norm(accel), maxAccel);
    }
    a.Acceleration = accel;
    let remaining = dt, tick = 0.1, bounces = 0, adjustApex = false;
    const water = !!zone.bWaterZone;
    const stepVel = (old, t) => water
      ? add(mul(old, 1 - 2 * (zone.ZoneFluidFriction ?? 1.2) * t), mul(add(accel, mul(g, 1 - (a.Buoyancy || 0) / Math.max(1, a.Mass || 100))), 0.5 * t))
      : add(old, mul(add(accel, (a.Class.isA('Decoration') && a.bBobbing) ? mul(g, 0.5) : g), 0.5 * t));
    while (remaining > 0 && iterations < 8) {
      iterations++;
      tick = remaining > 0.1 ? Math.min(0.1, remaining * 0.5) : remaining;
      remaining -= tick;
      a.OldLocation = { ...a.Location };
      a.bJustTeleported = false;
      let oldVel = { ...(a.Velocity || V()) };
      a.Velocity = stepVel(oldVel, tick); // average velocity over this tick
      // split the tick at the top of the arc so the apex height comes out exact
      if (!adjustApex && (oldVel.Z > 0) !== (a.Velocity.Z > 0) && Math.abs(oldVel.Z) > 5 && Math.abs(a.Velocity.Z) > 5) {
        adjustApex = true;
        const part = Math.abs(oldVel.Z) / (Math.abs(oldVel.Z) + Math.abs(a.Velocity.Z));
        if (part * tick > 0.015 && (1 - part) * tick > 0.015) {
          remaining += tick * (1 - part); tick *= part;
          a.Velocity = stepVel(oldVel, tick);
        }
      } else adjustApex = false;
      if (boundSpeed) {
        const v2 = V(a.Velocity.X, a.Velocity.Y, 0);
        if (dot(v2, v2) > boundSpeed * boundSpeed) { const b = mul(norm(v2), boundSpeed); a.Velocity = V(b.X, b.Y, a.Velocity.Z); }
      }
      const zv = (!isPawn || isPlayer(a) || dot(zone.ZoneVelocity || V(), zone.ZoneVelocity || V()) > 40000) ? (zone.ZoneVelocity || V()) : V();
      const adjusted = mul(add(a.Velocity, zv), tick);
      const hit = this.moveActor(a, adjusted);
      if (a.__deleted) return;
      if (isPawn && a.Physics === PHYS.Swimming) return;
      if (hit.hit) {
        if (a.Class.isA('Decoration') && hit.actor?.Class?.isA('PlayerPawn')) a.numLandings = Math.max(0, (a.numLandings | 0) - 1);
        if (a.bBounce && !hit.actor?.__moverMesh) {
          this.vm.event(a, 'HitWall', hit.normal, hit.actor);
          if (a.Physics === PHYS.None || a.__deleted) return;
          if (bounces < 2) remaining += tick * (1 - hit.time);
          bounces++;
        } else if (hit.normal.Z > 0.7) {
          remaining += tick * (1 - hit.time);
          if (!a.bJustTeleported && hit.time > 0.1 && hit.time * tick > 0.003) a.Velocity = mul(sub(a.Location, a.OldLocation), 1 / (tick * hit.time));
          this.processLanded(a, hit.normal, hit.actor, remaining, iterations);
          return;
        } else {
          if (isPawn) this.mount(a, V(0, 0, 1), hit, true); // falling keeps sliding down the wall either way
          this.processHitWall(a, hit.normal, hit.actor);
          if (a.__deleted || a.Physics !== PHYS.Falling) { if (!a.__deleted && a.Physics !== PHYS.Falling) a.Acceleration = realAccel; return; }
          const oldN = hit.normal;
          let d = mul(sub(adjusted, mul(hit.normal, dot(adjusted, hit.normal))), 1 - hit.time);
          if (dot(d, adjusted) >= 0) {
            let h2 = this.moveActor(a, d);
            if (h2.hit) {
              if (h2.normal.Z > 0.7) { this.processLanded(a, h2.normal, h2.actor, 0, iterations); return; }
              this.processHitWall(a, h2.normal, h2.actor);
              if (a.__deleted) return;
              d = this.twoWallAdjust(norm(adjusted), d, h2.normal, oldN, h2.time);
              const ditch = oldN.Z > 0 && h2.normal.Z > 0 && d.Z === 0 && dot(h2.normal, oldN) < 0;
              h2 = this.moveActor(a, d);
              if (ditch || h2.normal.Z > 0.7) { this.processLanded(a, h2.normal, h2.actor, 0, iterations); return; }
            }
          }
          const oz = oldVel.Z;
          oldVel = mul(sub(a.Location, a.OldLocation), 1 / tick); oldVel.Z = oz;
        }
      }
      if (!a.bBounce && !a.bJustTeleported) {
        let v = sub(mul(sub(a.Location, a.OldLocation), 1 / tick), zv);   // actual average velocity
        if (v.Z < oldVel.Z || oldVel.Z >= 0) v = sub(mul(v, 2), oldVel);  // end velocity
        const term = zone.ZoneTerminalVelocity || 2500;
        if (dot(v, v) > term * term) v = mul(norm(v), term);
        a.Velocity = v;
      }
    }
    a.Acceleration = realAccel;
  }

  // move with step-up along low walls when moving level, else slide and handle a second wall (UE1 flying /
  // swimming shared part); mover(d) performs a move and returns the hit
  airMove(a, adjusted, mover) {
    const zone = this.zoneOf(a);
    let hit = mover(adjusted);
    if (a.__deleted || !(hit.time < 1)) return hit;
    const grav = V(0, 0, (zone.ZoneGravity?.Z ?? -950) > 0 ? 1 : -1);
    const desired = norm(adjusted), upDown = dot(grav, norm(a.Velocity || V()));
    if (Math.abs(hit.normal.Z) < 0.2 && upDown < 0.5 && upDown > -0.2) {
      const stepZ = a.Location.Z;
      this.stepUp(a, grav, desired, mul(adjusted, 1 - hit.time), hit);
      a.OldLocation = { ...a.OldLocation, Z: a.Location.Z + (a.OldLocation.Z - stepZ) };
      return hit;
    }
    this.processHitWall(a, hit.normal, hit.actor);
    if (a.__deleted) return hit;
    const oldN = hit.normal;
    let delta = mul(sub(adjusted, mul(hit.normal, dot(adjusted, hit.normal))), 1 - hit.time);
    if (dot(delta, adjusted) >= 0) {
      hit = mover(delta);
      if (hit.time < 1 && !a.__deleted) {
        this.processHitWall(a, hit.normal, hit.actor);
        if (a.__deleted) return hit;
        delta = this.twoWallAdjust(desired, delta, hit.normal, oldN, hit.time);
        hit = mover(delta);
      }
    }
    return hit;
  }

  // UE1 APawn::physFlying: out of the world -> gone (non-players); calcVelocity at AirSpeed with fluid
  // friction; zone velocity for players or strong currents; move (step up / slide / second wall)
  physFlying(a, dt) {
    if (a.bCollideWorld && (a.Region?.ZoneNumber ?? 1) === 0) { if (!a.bIsPlayer) this.level.destroy(a); return; }
    const zone = this.zoneOf(a);
    this.calcVelocity(a, norm(a.Acceleration || V()), dt, a.AirSpeed || 0, zone.ZoneFluidFriction ?? 1.2, 1, 0, 0);
    a.OldLocation = { ...a.Location };
    a.bJustTeleported = false;
    const zv = zone.ZoneVelocity || V();
    const useZv = isPlayer(a) || a.Class.isA('PlayerPawn') || dot(zv, zv) > 90000;
    const adjusted = mul(add(a.Velocity, useZv ? zv : V()), dt);
    this.airMove(a, adjusted, d => this.moveActor(a, d, a.Rotation));
    if (!a.bJustTeleported && !a.__deleted) a.Velocity = mul(sub(a.Location, a.OldLocation), 1 / dt);
  }

  // APawn::Swim: a move that stops at the water line when it leaves the water; returns the share of the move
  // spent out of the water
  swim(a, delta) {
    const start = { ...a.Location };
    const hit = this.moveActor(a, delta, a.Rotation);
    let air = 0;
    if (!this.zoneOf(a).bWaterZone && !a.__deleted) {
      let s0 = start, e = { ...a.Location };
      // findWaterLine: bisect toward the water line, staying on the dry side
      while (dot(sub(e, s0), sub(e, s0)) >= 1) {
        const m = mul(add(s0, e), 0.5);
        if (!!this.level.zoneInfoAt(m).zone?.bWaterZone !== !!this.zoneOf(a).bWaterZone) s0 = m; else e = m;
      }
      if (e.X !== a.Location.X || e.Y !== a.Location.Y || e.Z !== a.Location.Z) {
        air = len(sub(e, a.Location)) / (len(delta) || 1);
        this.moveActor(a, sub(e, a.Location), a.Rotation);
      }
    }
    hit.air = air;
    return hit;
  }

  // UE1 APawn::physSwimming: damped climb out of water, buoyant calcVelocity at WaterSpeed, swim moves (step
  // up / slide / second wall), velocity from the move (keeping a script water jump); leaving the water falls
  physSwimming(a, dt) {
    let zone = this.zoneOf(a);
    if (!a.HeadRegion?.Zone?.bWaterZone && a.Velocity.Z > 100) a.Velocity.Z *= 1 - dt;
    a.OldLocation = { ...a.Location };
    a.bJustTeleported = false;
    this.calcVelocity(a, norm(a.Acceleration || V()), dt, a.WaterSpeed || 0, zone.ZoneFluidFriction ?? 1.2, 1, 0, 1);
    let velZ = a.Velocity.Z;
    const zv = zone.ZoneVelocity || V();
    const useZv = a.Class.isA('PlayerPawn') || dot(zv, zv) > 90000;
    const adjusted = mul(add(a.Velocity, useZv ? mul(zv, 25 * dt) : V()), dt);
    let remaining = dt;
    let first = true;
    this.airMove(a, adjusted, d => { const h = this.swim(a, d); remaining = first ? dt * h.air : remaining * (1 - h.time) * h.air; first = false; return h; });
    if (a.__deleted) return;
    if (!a.bJustTeleported && remaining < dt) {
      const jump = velZ !== a.Velocity.Z;
      if (jump) velZ = a.Velocity.Z;
      a.Velocity = mul(sub(a.Location, a.OldLocation), 1 / (dt - remaining));
      if (jump) a.Velocity.Z = velZ;
    }
    zone = this.zoneOf(a);
    if (!zone.bWaterZone) {
      if (a.Physics === PHYS.Swimming) this.setPhysics(a, PHYS.Falling);
      if (a.Velocity.Z < 160 && a.Velocity.Z > 0) a.Velocity.Z = 40 + Math.hypot(a.Velocity.X, a.Velocity.Y) * 0.4;
    }
    if (remaining > 0.01) {
      if (a.Physics === PHYS.Falling) this.physFalling(a, remaining);
      else if (a.Physics === PHYS.Flying) this.physFlying(a, remaining);
    }
  }

  // UE1 AActor::physProjectile: gone once outside the world; fluid friction, acceleration, Projectile.MaxSpeed;
  // a blocking hit is HitWall (a bouncing projectile carries on with the time left, at most twice); velocity is
  // the distance actually moved unless bouncing
  physProjectile(a, dt) {
    if ((a.Region?.ZoneNumber ?? 1) === 0) { this.level.destroy(a); return; }
    const old = { ...a.Location };
    a.bJustTeleported = false;
    let remaining = dt, bounces = 0, it = 0;
    const isProj = a.__isProj ?? (a.__isProj = a.Class.isA('Projectile'));
    while (remaining > 0 && it < 8) {
      it++;
      const zone = a.Region?.Zone;
      a.Velocity ??= V();
      if (zone?.bWaterZone) a.Velocity = mul(a.Velocity, 1 - 0.2 * (zone.ZoneFluidFriction || 0) * remaining);
      a.Velocity = add(a.Velocity, mul(a.Acceleration || V(), remaining));
      const tick = remaining;
      remaining = 0;
      if (isProj && dot(a.Velocity, a.Velocity) > (a.MaxSpeed || 0) ** 2) a.Velocity = mul(norm(a.Velocity), a.MaxSpeed || 0);
      const r = this.moveActor(a, mul(a.Velocity, dt), a.Rotation);
      if (r.time < 1 && r.hit && !a.__deleted && !a.bJustTeleported) {
        this.vm.event(a, 'HitWall', r.normal, r.actor);
        if (a.__deleted) return;
        if (a.bBounce && !(r.actor && (r.actor.__moverMesh || r.actor.Class?.isA('Mover')))) {
          if (bounces < 2) remaining = tick * (1 - r.time);
          bounces++;
          if (a.Physics === PHYS.Falling) { this.physFalling(a, remaining); remaining = 0; }
        }
      }
    }
    if (!a.bBounce && !a.bJustTeleported && !a.__deleted) a.Velocity = mul(sub(a.Location, old), 1 / dt);
  }

  // UE1 AActor::physRolling (non-pawns rolling/sliding on a floor): ground friction turns velocity toward the
  // acceleration, fluid friction; 0.1 s steps: move (HitWall, bounce or slide + second wall), drop up to 16 to
  // the floor, slide down slopes; no floor (or too steep): Falling (unless the script changed it)
  physRolling(a, dt) {
    const zone = a.Region?.Zone || {}, gf = zone.ZoneGroundFriction ?? 8, ff = zone.ZoneFluidFriction ?? 1.2;
    a.Velocity ??= V(); a.Acceleration ??= V();
    const vd = norm(a.Velocity), ad = norm(a.Acceleration);
    a.Velocity = sub(a.Velocity, mul(sub(vd, ad), len(a.Velocity) * dt * gf));
    a.Velocity = add(mul(a.Velocity, 1 - ff * dt), mul(a.Acceleration, dt));
    const want = add(a.Velocity, zone.ZoneVelocity || V());
    const old = { ...a.Location };
    a.bJustTeleported = false;
    const down = V(0, 0, (zone.ZoneGravity?.Z ?? -950) > 0 ? 16 : -16);
    let remaining = dt, it = 0, bounces = 0;
    while (remaining > 0 && it < 8) {
      it++;
      const tick = remaining > 0.1 ? Math.min(0.1, remaining * 0.5) : remaining;
      remaining -= tick;
      let delta = mul(want, tick);
      const subMove = delta, subLoc = { ...a.Location };
      if (len(delta) > 1e-4) {
        let r = this.moveActor(a, delta, a.Rotation);
        if (a.__deleted) return;
        if (r.time < 1 && r.hit) {
          this.vm.event(a, 'HitWall', r.normal, r.actor);
          if (a.__deleted) return;
          if (a.bBounce && !(r.actor?.__moverMesh)) { if (bounces < 2) remaining += tick * (1 - r.time); bounces++; }
          else {
            const orig = delta, oldN = r.normal;
            delta = mul(sub(delta, mul(r.normal, dot(delta, r.normal))), 1 - r.time);
            if (dot(delta, orig) >= 0) {
              r = this.moveActor(a, delta, a.Rotation);
              if (r.time < 1 && r.hit && !a.__deleted) {
                this.vm.event(a, 'HitWall', r.normal, r.actor);
                if (a.__deleted) return;
                delta = this.twoWallAdjust(norm(want), delta, r.normal, oldN, r.time);
                this.moveActor(a, delta, a.Rotation);
              }
            }
          }
        }
      }
      if (a.__deleted) return;
      let h = this.moveActor(a, down, a.Rotation);
      const dropTime = h.time; let dropZ = h.normal.Z;
      if (dropTime < 1 && h.normal.Z < 1 && h.normal.Z * gf < 3.3) {
        const g = zone.ZoneGravity || V(0, 0, -950);
        const slide = mul(g, dt * dt / (2 * Math.max(0.5, gf)));
        const d = sub(slide, mul(h.normal, dot(slide, h.normal)));
        if (dot(d, slide) >= 0) { const s2 = this.moveActor(a, d, a.Rotation); dropZ = Math.max(dropZ, s2.normal.Z); }
      }
      if (dropTime === 1 || dropZ < 0.7) {
        this.moveActor(a, mul(down, -dropTime), a.Rotation);
        const want2 = len(subMove), got = Math.hypot(a.Location.X - subLoc.X, a.Location.Y - subLoc.Y);
        remaining += tick * (1 - Math.min(1, want2 > 0 ? got / want2 : 1));
        this.vm.event(a, 'Falling');
        if (a.__deleted) return;
        if (a.Physics === PHYS.Rolling) this.setPhysics(a, PHYS.Falling);
        if (a.Physics === PHYS.Falling) {
          if (!a.bJustTeleported && dt > remaining) a.Velocity = mul(sub(a.Location, old), 1 / (dt - remaining));
          a.Velocity.Z = 0;
          if (remaining > 0.005) this.physFalling(a, remaining);
          return;
        }
        this.moveActor(a, mul(want, remaining), a.Rotation);
      } else { const b = h.hit ? (h.actor || this.level.levelInfo) : null; if (b !== a.Base) this.setBase(a, b); }
    }
    if (!a.bJustTeleported) a.Velocity = mul(sub(a.Location, old), 1 / dt);
  }


  // UE1 AActor::physTrailer: follow the owner (sprites jump there; meshes ride at the owner, its bone when
  // AnimBone is set, the PrePivot offset in the owner's frame), facing the owner's way or against its motion
  physTrailer(a, dt) {
    const o = a.Owner;
    if (!o || o.__deleted) return;
    if ((a.DrawType | 0) === 1) {
      const to = a.bTrailerPrePivot ? add(o.Location, a.PrePivot || V())
        : a.bTrailerSameRotation ? sub(o.Location, mul(vecRotForward(V(1, 0, 0), o.Rotation), a.Mass || 0)) : o.Location;
      this.farMoveActor(a, to, false, true);
      return;
    }
    let loc = { ...o.Location }, rot;
    if (a.AnimBone && o.Mesh) {
      const mi = this.level.anim.info(o.Mesh), bn = mi?.bones?.[a.AnimBone - 1];
      const bp = bn ? bonePos(this.level, o, bn) : null;
      if (bp) loc = bp;
      rot = { ...o.Rotation };
    } else {
      if (a.bTrailerPrePivot || a.bTrailerSameRotation) loc = add(loc, vecRotForward(a.PrePivot || V(), o.Rotation));
      const v = o.Velocity || V();
      rot = a.bTrailerSameRotation ? { ...o.Rotation } : (dot(v, v) < 1e-8 ? { Pitch: 16384, Yaw: 0, Roll: 0 } : vecToRot(mul(v, -1)));
    }
    if (!a.bBlockActors && !a.bCollideWorld) this.moveActor(a, sub(loc, a.Location), rot, { force: true });
    else { this.farMoveActor(a, loc, false, true); this.moveActor(a, V(0.01, 0, 0), rot, { force: true }); }
  }


  // UE1 AActor::physMovingBrush: run PhysAlpha (Mover's own PhysAlpha/PhysRate, which shadow Actor's) toward
  // 1 at PhysRate, place the brush between OldPos/OldRot and the key (glide = smoothstep), carrying riders;
  // a refused (encroaching) move retries next tick; KeyFrameReached when the key is reached
  physMovingBrush(a, dt) {
    const AL = 'PhysAlpha@Mover', RT = 'PhysRate@Mover';
    const k = Math.max(0, Math.min(7, a.KeyNum | 0));
    a.KeyPos ??= []; a.KeyRot ??= [];
    while (a.bInterpolating && dt > 0) {
      let fell = false;
      const zone = a.Region?.Zone;
      if (a.bCollideWorld && zone && zone.ZoneGravity) {
        const g = zone.ZoneGravity, gg = dot(g, g) || 1;
        const fv = mul(g, dot(a.Velocity || V(), g) / gg), fall = add(mul(fv, dt), mul(g, dt * dt * 0.5));
        a.Velocity = add(a.Velocity || V(), mul(g, dt));
        const old = { ...a.Location }, r = this.moverMove(a, add(a.Location, fall), a.Rotation);
        if (r.time > 0) { const d = sub(a.Location, old); a.KeyPos[k] = add(a.KeyPos[k] || V(), d); a.OldPos = add(a.OldPos || old, d); fell = true; }
        else this.findBase(a);
      }
      const alpha = a[AL] || 0;
      let na = alpha + dt * (a[RT] || 0);
      if (na > 1) { dt = alpha < 1 ? dt * (na - 1) / (na - alpha) : 0; na = 1; } else dt = 0;
      const ra = (a.MoverGlideType ?? 1) === 1 ? 3 * na * na - 2 * na * na * na : na;
      const op = a.OldPos || a.Location, or = a.OldRot || a.Rotation;
      const kp = a.KeyPos[k] || V(), kr = a.KeyRot[k] || { Pitch: 0, Yaw: 0, Roll: 0 };
      const bp = a.BasePos || V(), br = a.BaseRot || { Pitch: 0, Yaw: 0, Roll: 0 };
      const newLoc = add(op, mul(sub(add(bp, kp), op), ra));
      const dr = { Pitch: br.Pitch + kr.Pitch - or.Pitch, Yaw: br.Yaw + kr.Yaw - or.Yaw, Roll: br.Roll + kr.Roll - or.Roll };
      const newRot = { Pitch: or.Pitch + appRound(dr.Pitch * ra), Yaw: or.Yaw + appRound(dr.Yaw * ra), Roll: or.Roll + appRound(dr.Roll * ra) };
      const r = this.moverMove(a, newLoc, newRot);
      if (r.moved) a[AL] = alpha + r.time * (na - alpha);
      if (a.__deleted) return;
      if (!fell) {
        if (r.time < 1) { a.bInterpolating = false; a.HitPosition = { ...a.Location }; }
        else if (a[AL] >= 1) { a.bInterpolating = false; this.vm.event(a, 'KeyFrameReached'); }
      }
    }
  }
  // a mover's MoveActor: encroachment first (it may push or be refused), then move and carry its riders
  // A colliding brush first sweeps its bounding box (less the 0.51 trace margin, no look-ahead) along the
  // move: the first thing that blocks it (the level when bCollideWorld, blocking actors and brushes) cuts
  // the move short and both hear Bump; a hit at the start refuses the move (time 0).
  moverMove(m, newLoc, newRot) {
    let delta = sub(newLoc, m.Location), time = 1, hitActor = null;
    if ((m.bCollideActors || m.bCollideWorld) && len(delta) > 0) {
      const box = this.moverBounds(m);
      if (box) {
        const c = mul(add(box.min, box.max), 0.5);
        const ext = V(Math.max(0, (box.max.X - box.min.X) / 2 - 0.51), Math.max(0, (box.max.Y - box.min.Y) / 2 - 0.51), Math.max(0, (box.max.Z - box.min.Z) / 2 - 0.51));
        for (const h of this.multiLineCheck(c, add(c, delta), ext, !!m.bCollideActors, !!m.bCollideWorld)) {
          const o = h.actor;
          if (o === m || this.isBasedOn(o, m)) continue; // (riders never block their base)
          if (o === this.level.levelInfo ? !m.bCollideWorld : !this.blocks(m, o)) continue;
          time = h.time; hitActor = o;
          break;
        }
        if (time < 1) {
          if (time <= 1e-4) return { moved: false, time: 0 };
          delta = mul(delta, time);
        }
      }
    }
    newLoc = add(m.Location, delta);
    this.carryRiders(m, delta, newRot);
    if (this.moverEncroaches(m, newLoc, newRot)) return { moved: false, time: 1 };
    m.Location = newLoc; m.Rotation = newRot;
    if (!m.__deleted) this.level.setActorZone(m);
    if (hitActor && hitActor !== this.level.levelInfo && !m.__deleted) {
      this.vm.event(hitActor, 'Bump', m);
      if (!m.__deleted && !hitActor.__deleted) this.vm.event(m, 'Bump', hitActor);
    }
    return { moved: true, time };
  }
  // world bounding box of a mover's brush polygons at its current place
  moverBounds(m) {
    if (!m.__polys?.length) return null;
    const pp = m.PrePivot || V(), s = m.MainScale?.Scale || { X: 1, Y: 1, Z: 1 };
    const min = V(Infinity, Infinity, Infinity), max = V(-Infinity, -Infinity, -Infinity);
    for (const p of m.__polys) for (const v of p.verts) {
      const w = add(m.Location, vecRotForward(V((v[0] - pp.X) * (s.X ?? 1), (v[1] - pp.Y) * (s.Y ?? 1), (v[2] - pp.Z) * (s.Z ?? 1)), m.Rotation));
      min.X = Math.min(min.X, w.X); min.Y = Math.min(min.Y, w.Y); min.Z = Math.min(min.Z, w.Z);
      max.X = Math.max(max.X, w.X); max.Y = Math.max(max.Y, w.Y); max.Z = Math.max(max.Z, w.Z);
    }
    return { min, max };
  }

  // UE1 CheckEncroachment for a moving brush: actors whose box overlaps the brush at its new place. A blocked
  // one is first pushed along the brush's translation with moveSmooth (HP1's Engine.dll uses TestLocation -
  // Location only; HP2 added 10x the motion the rotation causes there, so turning doors don't push in HP1); if it still overlaps it is pushed back and the mover's EncroachingOn decides (true refuses the
  // move). Blocked overlapped actors then hear EncroachedBy. true = the move is refused.
  moverEncroaches(m, newLoc, newRot) {
    if (!m.__moverModel) return false;
    const overlapping = (loc, rot) => {
      const sl = m.Location, sr = m.Rotation; m.Location = loc; m.Rotation = rot;
      const xf = this.moverXf(m);
      const hits = this.level.actors.filter(o => o !== m && !o.__deleted && !o.__unhashed && o.bCollideActors && !o.__moverModel
        && boxOverlaps(m.__moverModel, o.Location, this.extentOf(o), xf));
      m.Location = sl; m.Rotation = sr;
      return hits;
    };
    const first = overlapping(newLoc, newRot);
    for (const o of first) {
      if (!this.blocks(m, o) || o.__deleted) continue;
      const dir = sub(newLoc, m.Location);
      const savedM = m.bCollideActors; m.bCollideActors = false;
      this.moveSmooth(o, dir);
      m.bCollideActors = savedM;
      if (!overlapping(newLoc, newRot).includes(o)) continue;
      const realLoc = m.Location; m.Location = newLoc;
      this.moveSmooth(o, mul(dir, -1));
      m.Location = realLoc;
      if (this.vm.event(m, 'EncroachingOn', o)) return true;
    }
    for (const o of first) if (!o.__deleted && this.blocks(m, o)) this.vm.event(o, 'EncroachedBy', m);
    return false;
  }

  // After a mover/base moved, carry based actors along
  // UE1 MoveActor for an actor others stand on: before it moves, each rider moves by the same delta plus the
  // swing of the yaw change about the base (only yaw turns riders), ignoring its base while doing so
  carryRiders(m, delta, newRot) {
    const dYaw = ((newRot?.Yaw ?? m.Rotation.Yaw) - m.Rotation.Yaw) | 0;
    const ry = ((((newRot?.Yaw ?? 0) & 65535) - (m.Rotation.Yaw & 65535)) | 0);
    for (const o of this.level.actors) {
      if (o.Base !== m || o === m || o.__deleted) continue;
      let rot = V();
      if (dYaw) {
        const ptr = sub(m.Location, o.Location);
        rot = sub(ptr, vecRotForward(ptr, { Pitch: 0, Yaw: ry, Roll: 0 }));
      }
      this.moveActor(o, add(delta, rot), dYaw ? { ...o.Rotation, Yaw: o.Rotation.Yaw + dYaw } : null, { ignoreBases: true });
      if (dYaw && o.Class.isA('Pawn') && o.ViewRotation) o.ViewRotation = { ...o.ViewRotation, Yaw: o.ViewRotation.Yaw + dYaw };
    }
  }

  // ---------------------------------------------------------------- AI latent movement

}

export { V, add, sub, mul, dot, len, norm };
