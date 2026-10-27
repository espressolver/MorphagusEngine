// ParticleFX simulation (KnowWonder/DreamWorks AParticleFX + UParticle rules): emission from the system's
// script properties, per-particle aging with damping/gravity/wind/attraction/chaos, alpha/colour/size
// transitions, steady-state priming, elastic collisions and the script natives. Ported from the engine's
// rules, not its code.
import { rotAxes } from '../../uscript/natives_core.js';
import { boxLineCheck } from './bspcol.js';
import { meshWorldVerts } from './bones.js';

const MAX_TIMESLICE = 0.06667; // 15 fps
const maxVal = p => (p?.Base || 0) + Math.max(p?.Rand || 0, 0);
const minVal = p => (p?.Base || 0) + Math.min(p?.Rand || 0, 0);
const frand = (lo = 0, hi = 1) => lo + (hi - lo) * Math.random();
const V = (X = 0, Y = 0, Z = 0) => ({ X, Y, Z });
const PARAMS = ['AngularSpreadWidth', 'AngularSpreadHeight', 'SourceWidth', 'SourceDepth', 'SourceHeight', 'Speed', 'Lifetime',
  'AlphaStart', 'AlphaEnd', 'SpinRate', 'DripTime', 'SizeWidth', 'SizeLength', 'SizeEndScale'];
const DIST_UNIFORM = 1, DIST_OWNERMESH = 2, PPRIM_LIQUID = 2, PPRIM_SHARD = 3;

export class ParticleSim {
  constructor(level) { this.level = level; }

  state(a) {
    if (!a.__ps) {
      a.__ps = { list: [] };
      a.LOD = 1; // set by the native constructor (the renderer would lower it with screen size)
      // AParticleFX::InitExecution: systems present at level start (or bPrime) start in their steady state
      a.bSteadyState = (a.ParticlesMax | 0) === 0 && (a.Distribution | 0) !== DIST_UNIFORM;
      if (a.bSteadyState && (a.bPrime || !this.level.timeSeconds) && (a.Age || 0) < maxVal(a.Lifetime)) a.Age = maxVal(a.Lifetime);
      a.ElapsedTime = 0;
    }
    return a.__ps;
  }

  // the parameter source: this system, its parent class defaults, or a blend of both (ParentBlend)
  sysParams(a) {
    const pb = a.ParentBlend || 0;
    if (pb <= 0) return a;
    const parent = a.Class.superClass?.defaults || a;
    if (pb >= 1) return parent;
    const out = Object.create(a), inv = 1 - pb;
    for (const k of [...PARAMS, 'ColorStart', 'ColorEnd']) {
      const s = a[k] || {}, p = parent[k] || {};
      if (k.startsWith('Color')) {
        const bl = (x, y) => ({ R: (x?.R || 0) * inv + (y?.R || 0) * pb, G: (x?.G || 0) * inv + (y?.G || 0) * pb, B: (x?.B || 0) * inv + (y?.B || 0) * pb, A: (x?.A || 0) * inv + (y?.A || 0) * pb });
        out[k] = { Base: bl(s.Base, p.Base), Rand: bl(s.Rand, p.Rand) };
      } else out[k] = { Base: (s.Base || 0) * inv + (p.Base || 0) * pb, Rand: (s.Rand || 0) * inv + (p.Rand || 0) * pb };
    }
    return out;
  }

  // AParticleFX::GetParams: one random draw per parameter (both sizes share one draw)
  params(sp) {
    const r = p => (p?.Rand ? (p.Base || 0) + p.Rand * Math.random() : (p?.Base || 0));
    const out = {};
    for (const k of PARAMS) if (k !== 'SizeWidth' && k !== 'SizeLength') out[k] = r(sp[k]);
    const col = c => {
      const b = c?.Base || { R: 0, G: 0, B: 0, A: 0 }, d = c?.Rand;
      if (!d || !(d.R || d.G || d.B || d.A)) return { ...b };
      const f = Math.random(), cl = v => Math.max(0, Math.min(255, Math.round(v)));
      return { R: cl(b.R + d.R * f), G: cl(b.G + d.G * f), B: cl(b.B + d.B * f), A: cl((b.A || 0) + (d.A || 0) * f) };
    };
    out.ColorStart = col(sp.ColorStart); out.ColorEnd = col(sp.ColorEnd);
    const sr = Math.random();
    out.SizeWidth = (sp.SizeWidth?.Base || 0) + sr * (sp.SizeWidth?.Rand || 0);
    out.SizeLength = (sp.SizeLength?.Base || 0) + sr * (sp.SizeLength?.Rand || 0);
    return out;
  }

  // the parts of a new particle common to emission and script AddParticle
  initParticle(a, pt, P, sizeDelay, colorDelay, alphaDelay, alphaEps) {
    pt.Width = pt.WidthFull = P.SizeWidth; pt.Length = pt.LengthFull = P.SizeLength;
    if ((a.SizeGrowPeriod || 0) > 0) pt.Width = pt.Length = 0;
    pt.Lifetime = P.Lifetime;
    pt.DripTimer = P.DripTime;
    if (pt.DripTimer > 0) { pt.WidthDelta = pt.Width / pt.DripTimer; pt.LengthDelta = pt.Length / pt.DripTimer; pt.Width = pt.Length = 0; }
    else if (pt.Lifetime > sizeDelay) {
      pt.WidthDelta = (P.SizeWidth * P.SizeEndScale - P.SizeWidth) / (pt.Lifetime - sizeDelay);
      pt.LengthDelta = (P.SizeLength * P.SizeEndScale - P.SizeLength) / (pt.Lifetime - sizeDelay);
    } else pt.WidthDelta = pt.LengthDelta = 0;
    pt.c = [P.ColorStart.R / 255, P.ColorStart.G / 255, P.ColorStart.B / 255];
    pt.Alpha = pt.AlphaFull = P.AlphaStart;
    if ((a.AlphaGrowPeriod || 0) > 0) pt.Alpha = 0;
    pt.SpinRate = P.SpinRate;
    pt.Spin = (a.RenderPrimitive | 0) === PPRIM_SHARD ? Math.random() * Math.PI * 2 : 0;
    if (pt.Lifetime > colorDelay) {
      const k = 1 / 255 / (pt.Lifetime - colorDelay);
      pt.cd = [(P.ColorEnd.R - P.ColorStart.R) * k, (P.ColorEnd.G - P.ColorStart.G) * k, (P.ColorEnd.B - P.ColorStart.B) * k];
    } else pt.cd = [0, 0, 0];
    pt.AlphaDelta = pt.Lifetime > alphaDelay + alphaEps ? (P.AlphaEnd - P.AlphaStart) / (pt.Lifetime - alphaDelay) : 0;
    pt.ChaosDelay = 0;
    return pt;
  }

  // UParticle::Update; false once it has lived its Lifetime
  updateParticle(a, pt, grav, damp, wind, dt) {
    if (pt.Lifetime > 0 && pt.Age + dt >= pt.Lifetime) return false;
    if (pt.DripTimer > 0) {
      pt.DripTimer -= dt;
      if (pt.DripTimer <= 0) { dt = -pt.DripTimer; pt.DripTimer = 0; pt.WidthDelta = pt.LengthDelta = 0; }
    }
    const last = { ...pt.pos };
    if (pt.DripTimer === 0) {
      pt.Spin += pt.SpinRate * dt;
      const p = pt.pos, v = pt.vel;
      if (damp < 1) {
        const D = a.Damping;
        const w = a.bWindPerParticle ? V() : wind; // (no Wind actors in HP1 maps: GetTotalWind is zero)
        const vf = V(grav.X / D + w.X, grav.Y / D + w.Y, grav.Z / D + w.Z), k = (damp - 1) / D;
        p.X += vf.X * dt + (vf.X - v.X) * k; p.Y += vf.Y * dt + (vf.Y - v.Y) * k; p.Z += vf.Z * dt + (vf.Z - v.Z) * k;
        v.X = vf.X + (v.X - vf.X) * damp; v.Y = vf.Y + (v.Y - vf.Y) * damp; v.Z = vf.Z + (v.Z - vf.Z) * damp;
      } else {
        p.X += (v.X + grav.X * dt * 0.5) * dt; p.Y += (v.Y + grav.Y * dt * 0.5) * dt; p.Z += (v.Z + grav.Z * dt * 0.5) * dt;
        v.X += grav.X * dt; v.Y += grav.Y * dt; v.Z += grav.Z * dt;
      }
      if (a.bSystemRelative) {
        const lu = a.LastUpdateLocation || a.Location, L = a.Location;
        const rel = V(p.X - (lu.X - L.X) - L.X, p.Y - (lu.Y - L.Y) - L.Y, p.Z - (lu.Z - L.Z) - L.Z);
        // into the old system frame, out of the new one
        const o = rotAxes(a.LastUpdateRotation || a.Rotation), n = rotAxes(a.Rotation);
        const lx = rel.X * o.X.X + rel.Y * o.X.Y + rel.Z * o.X.Z, ly = rel.X * o.Y.X + rel.Y * o.Y.Y + rel.Z * o.Y.Z, lz = rel.X * o.Z.X + rel.Y * o.Z.Y + rel.Z * o.Z.Z;
        p.X = L.X + lx * n.X.X + ly * n.Y.X + lz * n.Z.X; p.Y = L.Y + lx * n.X.Y + ly * n.Y.Y + lz * n.Z.Y; p.Z = L.Z + lx * n.X.Z + ly * n.Y.Z + lz * n.Z.Z;
      }
      const at = a.Attraction;
      if (at && (at.X || at.Y || at.Z)) { v.X += at.X * dt * (a.Location.X - p.X); v.Y += at.Y * dt * (a.Location.Y - p.Y); v.Z += at.Z * dt * (a.Location.Z - p.Z); }
      if (pt.ChaosDelay) pt.ChaosDelay = pt.ChaosDelay > dt ? pt.ChaosDelay - dt : 0;
      if (a.Chaos && pt.ChaosDelay <= 0) {
        let c = V(frand(-1, 1), frand(-1, 1), frand(-1, 1));
        const l = Math.hypot(c.X, c.Y, c.Z) || 1;
        v.X += c.X / l * a.Chaos; v.Y += c.Y / l * a.Chaos; v.Z += c.Z / l * a.Chaos;
        pt.ChaosDelay = a.ChaosDelay || 0;
      }
    }
    if (a.bUpdate !== false) {
      const agp = a.AlphaGrowPeriod || 0;
      if (pt.Age < agp * pt.Lifetime) pt.Alpha = Math.min(pt.Alpha + pt.AlphaFull * dt / (agp * pt.Lifetime), pt.AlphaFull);
      else if (pt.Age > (a.AlphaDelay || 0)) pt.Alpha += pt.AlphaDelta * dt;
      if (pt.Alpha < 0.001) pt.Alpha = 0;
      if ((pt.cd[0] || pt.cd[1] || pt.cd[2]) && pt.Age > (a.ColorDelay || 0)) { pt.c[0] += pt.cd[0] * dt; pt.c[1] += pt.cd[1] * dt; pt.c[2] += pt.cd[2] * dt; }
      if ((a.RenderPrimitive | 0) !== PPRIM_LIQUID || pt.DripTimer > 0) {
        const sgp = a.SizeGrowPeriod || 0;
        if (pt.Age < sgp * pt.Lifetime) {
          const st = dt / (sgp * pt.Lifetime);
          pt.Width = Math.min(pt.Width + pt.WidthFull * st, pt.WidthFull); pt.Length = Math.min(pt.Length + pt.LengthFull * st, pt.LengthFull);
        } else if (pt.Age > (a.SizeDelay || 0)) { pt.Width += pt.WidthDelta * dt; pt.Length += pt.LengthDelta * dt; }
      }
    }
    if ((a.Elasticity || 0) > 0) {
      const h = boxLineCheck(this.level.model, last, pt.pos, V());
      if (h) {
        const n = { X: h.normal[0], Y: h.normal[1], Z: h.normal[2] }, v = pt.vel, d = 2 * (v.X * n.X + v.Y * n.Y + v.Z * n.Z);
        pt.vel = V((v.X - d * n.X) * a.Elasticity, (v.Y - d * n.Y) * a.Elasticity, (v.Z - d * n.Z) * a.Elasticity);
        pt.pos = { ...h.location };
      }
    }
    pt.Age += dt;
    return true;
  }

  systemForces(a) {
    const zone = a.Region?.Zone || this.level.levelInfo, zg = zone.ZoneGravity || V(0, 0, -950), gm = a.GravityModifier || 0, g = a.Gravity || V();
    return { grav: V(zg.X * gm + g.X, zg.Y * gm + g.Y, zg.Z * gm + g.Z), wind: V() };
  }

  // AParticleFX::UpdateParticles: drop the expired, then step all (in 1/15 s slices with attraction/bounce)
  updateParticles(a, tick) {
    const S = this.state(a);
    const maxLife = maxVal(a.Lifetime);
    if (maxLife > 0 && tick > maxLife) { S.list.length = 0; return; }
    S.list = S.list.filter(p => !(p.Lifetime > 0 && p.Age + tick >= p.Lifetime));
    if (!S.list.length) return;
    const { grav, wind } = this.systemForces(a);
    const at = a.Attraction, slice = (at && (at.X || at.Y || at.Z)) || (a.Elasticity || 0) > 1e-4;
    while (tick > 0) {
      const ts = tick > MAX_TIMESLICE && slice ? MAX_TIMESLICE : tick;
      const damp = (a.Damping || 0) > 0 ? Math.exp(-a.Damping * ts) : 1;
      for (const p of S.list) this.updateParticle(a, p, grav, damp, wind, ts);
      tick -= ts;
    }
  }

  // AParticleFX::EmitParticles: how many particles are due (rate x time, or per distance moved for uniform
  // systems, or along the pattern), each placed back in time across the interval and pre-aged
  emit(a, tick) {
    const S = this.state(a), sp = this.sysParams(a);
    a.EmitDelay = (a.EmitDelay || 0) + tick;
    const L = a.Location, le = a.LastEmitLocation || L, emitDelta = V(le.X - L.X, le.Y - L.Y, le.Z - L.Z);
    const parent = a.Class.superClass?.defaults;
    let em = (a.ParticlesPerSec?.Base || 0) + Math.random() * (a.ParticlesPerSec?.Rand || 0);
    if (a.ParentBlend && parent) em += ((parent.ParticlesPerSec?.Base || 0) + Math.random() * (parent.ParticlesPerSec?.Rand || 0) - em) * a.ParentBlend;
    const pts = (a.Pattern?.Points || []).filter(Boolean);
    const dist = a.Distribution | 0;
    if (dist !== DIST_UNIFORM) em *= Math.min(1, Math.max(0.1, (a.LOD ?? 1) * 3)) * a.EmitDelay;
    else if (a.Pattern && pts.length > 1) {
      const F = ((a.Period?.Base || 0) + (a.Period?.Rand || 0) * 0.5) * (pts.length - 1), N = Math.min(Math.trunc(F), pts.length - 2);
      const d = Math.hypot(pts[N].X - pts[N + 1].X, pts[N].Y - pts[N + 1].Y, (pts[N].Z || 0) - (pts[N + 1].Z || 0));
      em = d * (a.DrawScale ?? 1) * (a.Period?.Rand || 0) * (pts.length - 1) / em;
    } else em = Math.hypot(emitDelta.X, emitDelta.Y, emitDelta.Z) / em;
    if (!Number.isFinite(em)) em = 0;
    em += a.EmissionResidue || 0;
    let emitStart = -a.EmitDelay;
    const emitted = a.ParticlesEmitted || 0;
    if (a.ParticlesMax > 0 && em >= a.ParticlesMax - emitted) { a.EmitDelay *= (a.ParticlesMax - emitted) / em; em = a.ParticlesMax - emitted; }
    const maxLife = maxVal(a.Lifetime);
    if (emitStart < -maxLife) { const nd = a.EmitDelay + emitStart + maxLife; em *= nd / a.EmitDelay; a.EmitDelay = nd; emitStart = -maxLife; }
    let n = Math.trunc(em);
    a.EmissionResidue = em - n;
    if (n <= 0) return 0;
    if (a.ParticlesAlive > 0 && n + S.list.length > a.ParticlesAlive) {
      if (n > a.ParticlesAlive) n = a.ParticlesAlive;
      S.list.splice(0, n + S.list.length - a.ParticlesAlive);
    }
    const ax = rotAxes(a.Rotation), toWorld = (x, y, z) => V(ax.X.X * x + ax.Y.X * y + ax.Z.X * z, ax.X.Y * x + ax.Y.Y * y + ax.Z.Y * z, ax.X.Z * x + ax.Y.Z * y + ax.Z.Z * z);
    const { grav, wind } = this.systemForces(a);
    const at = a.Attraction, slice = (at && (at.X || at.Y || at.Z)) || (a.Elasticity || 0) > 1e-4;
    let ownerMesh = null;
    for (let i = 0; i < n; i++) {
      const P = this.params(sp);
      const delta = dist === DIST_UNIFORM ? (em > 0 ? (i + 1) / em : 0) : Math.random();
      let timeDelta = -emitStart - a.EmitDelay * delta;
      if (timeDelta >= P.Lifetime) continue;
      let pos, dir;
      if (dist === DIST_OWNERMESH && a.Owner?.Mesh) {
        // a random point of a random triangle of the owner's mesh in its current pose, heading along the
        // triangle normal
        ownerMesh ??= meshWorldVerts(this.level, a.Owner) || { tris: [] };
        const T = ownerMesh.tris, V3 = ownerMesh.verts;
        if (!T.length) { pos = { ...a.Owner.Location }; dir = V(0, 0, 1); }
        else {
          const tri = T[Math.min(T.length - 1, Math.floor(Math.random() * T.length))];
          const v0 = V3[tri[0]], v1 = V3[tri[1]], v2 = V3[tri[2]], U = Math.random(), W = Math.random();
          const k0 = 1 - U, k1 = U * (1 - W), k2 = U * W;
          pos = V(v0.X * k0 + v1.X * k1 + v2.X * k2, v0.Y * k0 + v1.Y * k1 + v2.Y * k2, v0.Z * k0 + v1.Z * k1 + v2.Z * k2);
          const e1 = V(v1.X - v0.X, v1.Y - v0.Y, v1.Z - v0.Z), e2 = V(v2.X - v0.X, v2.Y - v0.Y, v2.Z - v0.Z);
          const c = V(e1.Y * e2.Z - e1.Z * e2.Y, e1.Z * e2.X - e1.X * e2.Z, e1.X * e2.Y - e1.Y * e2.X), l = Math.hypot(c.X, c.Y, c.Z);
          dir = l > 1e-8 ? V(c.X / l, c.Y / l, c.Z / l) : V(0, 0, 0);
        }
      } else {
        if (a.Pattern && pts.length > 1) {
          let F = ((a.Period?.Base || 0) + delta * (a.Period?.Rand || 0)) * (pts.length - 1);
          const N = Math.min(Math.trunc(F), pts.length - 2);
          F -= N;
          const q = { X: pts[N].X * (1 - F) + pts[N + 1].X * F, Y: pts[N].Y * (1 - F) + pts[N + 1].Y * F };
          const ds = a.DrawScale ?? 1, w = toWorld(0, (q.X - 0.5) * ds, (0.5 - q.Y) * ds);
          pos = V(L.X + w.X, L.Y + w.Y, L.Z + w.Z);
        } else pos = { ...L };
        const wt = P.AngularSpreadWidth * Math.PI / 180, ht = P.AngularSpreadHeight * Math.PI / 180;
        const wv = frand(-wt, wt), hv = frand(-ht, ht), ch = Math.cos(hv);
        dir = toWorld(Math.cos(wv) * ch, Math.sin(wv) * ch, Math.sin(hv));
      }
      const off = toWorld(frand(-P.SourceDepth * 0.5, P.SourceDepth * 0.5), frand(-P.SourceWidth * 0.5, P.SourceWidth * 0.5), frand(-P.SourceHeight * 0.5, P.SourceHeight * 0.5));
      pos = V(pos.X + off.X + emitDelta.X * (1 - delta), pos.Y + off.Y + emitDelta.Y * (1 - delta), pos.Z + off.Z + emitDelta.Z * (1 - delta));
      const pt = this.initParticle(a, { Id: -1, Age: 0, pos, vel: V(dir.X * P.Speed, dir.Y * P.Speed, dir.Z * P.Speed) }, P, a.SizeDelay || 0, a.ColorDelay || 0, a.AlphaDelay || 0, 0);
      if (a.bVelocityRelative && a.Owner?.Velocity) { pt.vel.X += a.Owner.Velocity.X; pt.vel.Y += a.Owner.Velocity.Y; pt.vel.Z += a.Owner.Velocity.Z; }
      while (timeDelta > 0) {
        const ts = timeDelta > MAX_TIMESLICE && slice ? MAX_TIMESLICE : timeDelta;
        const damp = (a.Damping || 0) > 0 ? Math.exp(-a.Damping * ts) : 1;
        this.updateParticle(a, pt, grav, damp, wind, ts);
        timeDelta -= ts;
      }
      S.list.push(pt);
    }
    a.EmitDelay = 0;
    a.LastEmitLocation = { ...L };
    a.ParticlesEmitted = emitted + n;
    return n;
  }

  // AParticleFX::Tick (Age, end of a finite system) and the per-frame Update(0)
  update(a, dt) {
    const S = this.state(a);
    if (S.list.length > 0 || maxVal(a.ParticlesPerSec) > 0) {
      a.Age = (a.Age || 0) + dt;
      if (a.ParticlesMax > 0 && (a.ParticlesPerSec?.Base || 0) > 0 && a.Age > a.ParticlesMax / a.ParticlesPerSec.Base + maxVal(a.Lifetime)) { this.level.destroy(a); return; }
    }
    if (!a.ElapsedTime) { a.LastUpdateLocation = { ...a.Location }; a.LastEmitLocation = { ...a.Location }; a.LastUpdateRotation = { ...a.Rotation }; }
    let step = (a.Age || 0) - (a.ElapsedTime || 0);
    a.ElapsedTime = (a.ElapsedTime || 0) + step;
    const lu = a.LastUpdateLocation;
    if (a.bSteadyState && lu.X === a.Location.X && lu.Y === a.Location.Y && lu.Z === a.Location.Z && step > MAX_TIMESLICE) {
      const maxLife = maxVal(a.Lifetime);
      let maxN = maxVal(a.ParticlesPerSec) * maxLife;
      if (a.ParticlesAlive > 0) maxN = Math.min(maxN, a.ParticlesAlive);
      const maxStep = Math.max((maxN - S.list.length) / minVal(a.ParticlesPerSec), MAX_TIMESLICE);
      step = Math.min(step, maxLife, maxStep);
    }
    if (step <= 0 && !a.bShellOnly) return;
    if (a.bShellOnly) step = 0.1;
    this.updateParticles(a, step);
    if (!(a.ParticlesMax > 0) || (a.ParticlesEmitted || 0) < a.ParticlesMax) {
      if (a.bEmit) this.emit(a, step); else a.LastEmitLocation = { ...a.Location };
    } else if (!S.list.length) { this.level.destroy(a); return; }
    a.LastUpdateLocation = { ...a.Location };
    a.LastUpdateRotation = { ...a.Rotation };
  }

  // AParticleFX::AddParticle (script): a particle at Loc aimed along the system's rotation
  addParticle(a, id, loc) {
    const S = this.state(a);
    a.bSteadyState = false;
    const P = this.params(this.sysParams(a));
    const ax = rotAxes(a.Rotation);
    const wt = P.AngularSpreadWidth * 0.01745, ht = P.AngularSpreadHeight * 0.01745, wv = frand(-wt, wt), hv = frand(-ht, ht), ch = Math.cos(hv);
    const l = [Math.cos(wv) * ch, Math.sin(wv) * ch, Math.sin(hv)];
    const dir = V(ax.X.X * l[0] + ax.Y.X * l[1] + ax.Z.X * l[2], ax.X.Y * l[0] + ax.Y.Y * l[1] + ax.Z.Y * l[2], ax.X.Z * l[0] + ax.Y.Z * l[1] + ax.Z.Z * l[2]);
    const pt = this.initParticle(a, { Id: id, Age: 0, pos: { ...loc }, vel: V(dir.X * P.Speed, dir.Y * P.Speed, dir.Z * P.Speed) }, P, 0, a.ColorDelay || 0, a.AlphaDelay || 0, 0.001);
    if (pt.Lifetime <= 0.01) pt.WidthDelta = pt.LengthDelta = 0;
    S.list.push(pt);
    return true;
  }
}

export function installParticleNatives(vm, engine) {
  const N = (idx, fn) => vm.natives.set(idx, fn);
  const P = () => engine.level.particles;
  const find = (s, id) => P().state(s).list.find(x => x.Id === id) || null;
  N(431, s => P().state(s).list.length);
  N(432, (s, [id, loc]) => P().addParticle(s, id | 0, loc || s.Location));
  N(433, (s, [id, params]) => {
    const p = find(s, id);
    if (!p || !params) return false;
    Object.assign(params, {
      Position: { ...p.pos }, Velocity: { ...p.vel }, Lifetime: p.Lifetime, Alpha: p.Alpha,
      Color: { R: Math.round(p.c[0] * 255), G: Math.round(p.c[1] * 255), B: Math.round(p.c[2] * 255), A: 0 },
      Width: p.Width, Length: p.Length, DripTimer: p.DripTimer, SpinRate: p.SpinRate,
    });
    return true;
  });
  N(434, (s, [id, params]) => {
    s.bSteadyState = false;
    const p = find(s, id);
    if (!p || !params) return false;
    p.pos = { ...params.Position }; p.vel = { ...params.Velocity }; p.Lifetime = params.Lifetime; p.Alpha = params.Alpha;
    p.c = [(params.Color?.R || 0) / 255, (params.Color?.G || 0) / 255, (params.Color?.B || 0) / 255];
    p.Width = params.Width; p.Length = params.Length; p.DripTimer = params.DripTimer; p.SpinRate = params.SpinRate;
    return true;
  });
  // RecomputeDeltas: re-aim the colour/alpha/size transitions at the end values over the remaining life
  N(435, (s, [id]) => {
    if (s.ColorPalette) return false;
    const p = find(s, id);
    if (!p) return false;
    const left = p.Lifetime - p.Age;
    if (left <= 0) return false;
    const k = 1 / left, ce = s.ColorEnd?.Base || { R: 0, G: 0, B: 0 };
    // (the engine mixes units here: end colour in 0..255 minus the current 0..1 colour)
    p.cd = [(ce.R - p.c[0]) / 255 * k, (ce.G - p.c[1]) / 255 * k, (ce.B - p.c[2]) / 255 * k];
    p.AlphaDelta = ((s.AlphaEnd?.Base || 0) - p.Alpha) * k;
    p.WidthDelta = ((s.SizeEndScale?.Base || 0) * p.Width - p.Width) * k;
    p.LengthDelta = ((s.SizeEndScale?.Base || 0) * p.Length - p.Length) * k;
    return true;
  });
}
