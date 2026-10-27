// Pawn sight (KnowWonder/UE1 APawn::LineOfSightTo, ShowSelf, CheckEnemyVisible) and the per-tick pawn
// timers from AActor::Tick. Ported from the engine's rules, not its code.
import { boxLineCheck } from './bspcol.js';

const ZERO = { X: 0, Y: 0, Z: 0 };
const isPawn = o => !!o?.Class?.isA('Pawn');
const d2 = (a, b) => (a.X - b.X) ** 2 + (a.Y - b.Y) ** 2 + (a.Z - b.Z) ** 2;
const vecRot = v => { const K = 65535 / (2 * Math.PI); return { Pitch: Math.trunc(Math.atan2(v.Z, Math.hypot(v.X, v.Y)) * K), Yaw: Math.trunc(Math.atan2(v.Y, v.X) * K), Roll: 0 }; };
const rotDir = r => { const p = r.Pitch * Math.PI / 32768, y = r.Yaw * Math.PI / 32768; return { X: Math.cos(p) * Math.cos(y), Y: Math.cos(p) * Math.sin(y), Z: Math.sin(p) }; };

export class PawnSense {
  constructor(level) { this.level = level; this.vm = level.vm; }

  // UModel::FastLineCheck: nothing solid in the level geometry between the points
  fastLine(a, b) { return !boxLineCheck(this.level.model, a, b, ZERO); }

  lineOfSightTo(p, o, showSelf = false) {
    if (!o) return false;
    if (o === p.Enemy) showSelf = false;
    if (showSelf) p.bLOSflag = !p.bLOSflag;
    let dist = d2(o.Location, p.Location), max;
    const vis = isPawn(o) ? (o.Visibility ?? 128) : 0;
    if (showSelf) {
      if (isPawn(o)) {
        max = (p.SightRadius || 0) * Math.min(1, vis * 0.0078125);
        max = Math.min(p.bIsPlayer ? 16000000 : 12000000, max * max);
      } else max = (p.SightRadius || 0) ** 2;
      if (dist > max) return false;
      const dl = Math.sqrt(dist) || 1, f = rotDir(p.Rotation);
      let st = ((o.Location.X - p.Location.X) * f.X + (o.Location.Y - p.Location.Y) * f.Y + (o.Location.Z - p.Location.Z) * f.Z) / dl - (p.PeripheralVision || 0);
      st = st > 0 ? 0.8 * st + 0.2 : 0.17 * st + 0.2;
      p.Stimulus = st;
      if (st <= 0) return false;
      const hm = Math.abs(o.Location.Z - p.Location.Z) / Math.max(1, (p.Skill || 0) + 1);
      dist = (dist + hm * hm) / (st * st);
      if (dist > max) return false;
      p.Stimulus = 1;
    } else {
      if (p.bIsPlayer) max = isPawn(o) ? Math.min(25000000, (5000 * Math.min(1, (vis + 16) * 0.015)) ** 2) : 16000000;
      else max = isPawn(o) ? Math.min(16000000, (4000 * Math.min(1, (vis + 16) * 0.015)) ** 2) : 9000000;
      if (dist > max) return false;
    }
    const eye = { X: p.Location.X, Y: p.Location.Y, Z: p.Location.Z + (p.BaseEyeHeight || 0) };
    if (o === p.Enemy) {
      if (this.fastLine(o.Location, eye) || this.fastLine(o.Location, p.Location)) {
        p.LastSeeingPos = { ...p.Location }; p.LastSeenPos = { ...o.Location };
        return true;
      }
      if (dist > 1000000) return false;
    } else if (dist > 1000000) {
      if (isPawn(o)) {
        if (!p.bLOSflag && dist > 0.5 * max) return false;
        if (!p.bIsPlayer && Math.random() < 0.5) return false;
      }
      return this.fastLine(o.Location, eye);
    }
    if (!showSelf || !p.bLOSflag) {
      if (this.fastLine({ ...o.Location, Z: o.Location.Z + (o.CollisionHeight || 0) * 0.8 }, eye)) return true;
    }
    if (dist > 250000 || !isPawn(o)) return false;
    // the two side points of the other's collision square that are neither nearest nor furthest
    const r = o.CollisionRadius || 0, L = o.Location;
    const pts = [{ X: L.X - r, Y: L.Y + r, Z: L.Z }, { X: L.X + r, Y: L.Y + r, Z: L.Z }, { X: L.X - r, Y: L.Y - r, Z: L.Z }, { X: L.X + r, Y: L.Y - r, Z: L.Z }];
    const size = q => q.X * q.X + q.Y * q.Y + q.Z * q.Z;
    let imin = 0, imax = 0, mn = size(pts[0]), mx = mn;
    for (let i = 1; i < 4; i++) { const n = size(pts[i]); if (n > mx) { mx = n; imax = i; } else if (n < mn) { mn = n; imin = i; } }
    let skip = !!p.bLOSflag;
    for (let i = 0; i < 4; i++) {
      if (i === imin || i === imax) continue;
      if (skip && showSelf) skip = false;
      else { skip = true; if (this.fastLine(pts[i], eye)) return true; }
    }
    return false;
  }

  // a visible player shows itself to every pawn whose sight counter ran out and listens for SeePlayer
  showSelf(p) {
    for (let o = this.level.levelInfo.PawnList; o; o = o.nextPawn) {
      if (o === p || o.__deleted || !(o.SightCounter < 0)) continue;
      if (this.level.physics.isProbing(o, 'SeePlayer') && this.lineOfSightTo(o, p, true)) this.vm.event(o, 'SeePlayer', p);
    }
  }

  checkEnemyVisible(p) {
    if (!p.Enemy || p.Enemy.__deleted) return;
    if (!this.lineOfSightTo(p, p.Enemy)) this.vm.event(p, 'EnemyNotVisible');
    else p.LastSeenTime = this.level.timeSeconds;
  }

  // ---- latent AI movement (APawn MoveTo / MoveToward / StrafeTo / StrafeFacing / TurnTo / TurnToward)
  // The native sets up the move and steers once; the poll runs every tick until it reports success.
  setMoveTimer(p, size) {
    const P = p.Physics;
    const max = P === 1 || P === 2 || P === 10 ? (p.GroundSpeed || 0) : P === 4 ? (p.AirSpeed || 0) : P === 3 ? (p.WaterSpeed || 0) : 200;
    const ds = p.DesiredSpeed ?? 1;
    p.MoveTimer = ds * max === 0 ? 0.5 : 1 + 1.3 * size / (ds * max);
  }
  // DesiredRotation toward the point (no pitch while walking, unless chasing a pawn); true once the yaw is
  // within 100 units
  rotateToward(p, f) {
    if (p.Physics === 10) return true;
    const r = vecRot({ X: f.X - p.Location.X, Y: f.Y - p.Location.Y, Z: f.Z - p.Location.Z });
    r.Yaw &= 65535;
    if (p.Physics === 1 && !isPawn(p.MoveTarget)) r.Pitch = 0;
    p.DesiredRotation = { ...r, Roll: p.DesiredRotation?.Roll ?? 0 };
    const dy = Math.abs(r.Yaw - (p.Rotation.Yaw & 65535));
    return dy < 100 || dy > 65535 - 100;
  }
  // Acceleration toward the point; true once reached (passed it, or within 4 units when not moving), the
  // move timer ran out, or a pawn target is within melee reach
  moveToward(p, dest) {
    const L = p.Location;
    let dir = { X: dest.X - L.X, Y: dest.Y - L.Y, Z: dest.Z - L.Z };
    const stop = () => { if (p.Physics === 1) p.DesiredRotation = { ...p.DesiredRotation, Yaw: p.Rotation.Yaw }; return true; };
    const accel = p.AccelRate || 0;
    if (p.Physics === 1) dir.Z = 0;
    else if (p.Physics === 2) {
      const zone = p.Region?.Zone, g = zone?.ZoneGravity?.Z ?? -950, g0 = zone?.Class?.defaults?.ZoneGravity?.Z ?? -950;
      if (g > 0.9 * g0) {
        dir.Z = 0;
        const n = Math.hypot(dir.X, dir.Y);
        p.Acceleration = n > 1e-4 ? { X: dir.X / n * accel, Y: dir.Y / n * accel, Z: 0 } : { X: 0, Y: 0, Z: 0 };
        if (p.Velocity.Z < 0 && L.Z + 100 < dest.Z) return stop();
      }
      return false;
    }
    const mt = p.MoveTarget;
    if (mt && !mt.__deleted && mt.Class.isA('Inventory') && Math.abs(L.Z - mt.Location.Z) < p.CollisionHeight
      && (L.X - mt.Location.X) ** 2 + (L.Y - mt.Location.Y) ** 2 < p.CollisionRadius ** 2) this.vm.event(mt, 'Touch', p);
    const dist = Math.hypot(dir.X, dir.Y, dir.Z);
    const glider = !p.bCanStrafe && (p.Physics === 4 || p.Physics === 3);
    const v = p.Velocity, speed = Math.hypot(v.X, v.Y, v.Z);
    const O = p.OldLocation || L, mv = { X: L.X - O.X, Y: L.Y - O.Y, Z: L.Z - O.Z };
    const moving = mv.X !== 0 || mv.Y !== 0 || mv.Z !== 0 || speed === 0;
    const dirSq = dir.X * dir.X + dir.Y * dir.Y, mvSq = mv.X * mv.X + mv.Y * mv.Y;
    const toDest = mv.X * (dest.X - O.X) + mv.Y * (dest.Y - O.Y) + mv.Z * (dest.Z - O.Z), past = mv.X * dir.X + mv.Y * dir.Y + mv.Z * dir.Z;
    if ((moving ? toDest > 0 && past < 0 && dirSq / 9 < mvSq : dirSq < 16) && Math.abs(dir.Z) < Math.max(48, p.CollisionHeight)) {
      if (!glider) p.Acceleration = { X: 0, Y: 0, Z: 0 };
      return stop();
    }
    if (glider) dir = rotDir(p.Rotation);
    else if (dist > 0) dir = { X: dir.X / dist, Y: dir.Y / dist, Z: dir.Z / dist };
    p.Acceleration = { X: dir.X * accel, Y: dir.Y * accel, Z: dir.Z * accel };
    if (!moving) p.MoveTimer = Math.min(0.25, p.MoveTimer);
    if (p.MoveTimer < 0) return stop();
    if (isPawn(mt)) {
      if (dist < p.CollisionRadius + mt.CollisionRadius + 0.8 * (p.MeleeRange || 0)) return stop();
      return false;
    }
    if (!glider && speed > 100) {
      const vd = { X: v.X / speed, Y: v.Y / speed, Z: v.Z / speed }, k = 0.2 * (1 - (dir.X * vd.X + dir.Y * vd.Y + dir.Z * vd.Z)) * speed;
      p.Acceleration = { X: p.Acceleration.X - k * (vd.X - dir.X), Y: p.Acceleration.Y - k * (vd.Y - dir.Y), Z: p.Acceleration.Z - k * (vd.Z - dir.Z) };
    }
    if (dist < 1.4 * (p.AvgPhysicsTime || 0) * speed) {
      if (!p.bReducedSpeed) { p.DesiredSpeed = 0.5 * (p.DesiredSpeed ?? 1); p.bReducedSpeed = true; }
      if (speed > 0) p.DesiredSpeed = Math.min(p.DesiredSpeed, 200 / speed);
      if (glider) return stop();
    }
    return false;
  }
  glide(p) { if (!p.bCanStrafe && (p.Physics === 4 || p.Physics === 3)) { const f = rotDir(p.Rotation), a = p.AccelRate || 0; p.Acceleration = { X: f.X * a, Y: f.Y * a, Z: f.Z * a }; } }

  // native start of each latent move; returns the latent record (or null when it doesn't wait)
  startMove(p, kind, a, b) {
    const L = p.Location, size = q => Math.hypot(q.X - L.X, q.Y - L.Y, q.Z - L.Z);
    const ds = speed => { p.bReducedSpeed = false; p.DesiredSpeed = Math.max(0, Math.min(p.MaxDesiredSpeed ?? 1, speed ?? 1)); };
    switch (kind) {
      case 'moveto':
        p.MoveTarget = null; ds(b); this.setMoveTimer(p, size(a));
        p.Destination = { ...a }; p.Focus = { ...a };
        break;
      case 'movetoward':
        if (!a) return null;
        ds(b);
        if (isPawn(a)) p.MoveTimer = 1.2; else this.setMoveTimer(p, size(a.Location));
        p.MoveTarget = a; p.Destination = { ...a.Location }; p.Focus = { ...p.Destination };
        break;
      case 'strafeto': case 'strafefacing':
        if (kind === 'strafefacing' && !b) return null;
        if (kind === 'strafeto') p.MoveTarget = null;
        p.bReducedSpeed = false; p.DesiredSpeed = (p.bIsPlayer ? 1 : 0.8) * (p.MaxDesiredSpeed ?? 1);
        this.setMoveTimer(p, size(a));
        p.Destination = { ...a };
        if (kind === 'strafeto') p.Focus = { ...b }; else { p.FaceTarget = b; p.Focus = { ...b.Location }; }
        break;
      case 'turnto':
        p.MoveTarget = null; p.Focus = { ...a };
        if (p.Physics === 1) p.Focus.Z = L.Z;
        this.glide(p);
        break;
      case 'turntoward':
        if (!a) return null;
        p.FaceTarget = a; this.glide(p); p.Focus = { ...a.Location };
        break;
    }
    this.rotateToward(p, p.Focus);
    if (kind !== 'turnto' && kind !== 'turntoward') this.moveToward(p, p.Destination);
    return { kind: 'ai', ai: kind };
  }

  // the per-tick poll; true when the latent action is over
  pollMove(p, kind) {
    switch (kind) {
      case 'moveto': case 'strafeto':
        this.rotateToward(p, p.Focus);
        return this.moveToward(p, p.Destination);
      case 'movetoward': {
        const t = p.MoveTarget;
        if (!t || t.__deleted) return true;
        p.Destination = { ...t.Location };
        if (p.Physics === 4 && isPawn(t)) p.Destination.Z += 0.7 * t.CollisionHeight;
        p.Focus = { ...p.Destination };
        this.rotateToward(p, p.Focus);
        const oldDS = p.DesiredSpeed;
        if (p.bAdvancedTactics && p.Physics === 1) this.vm.event(p, 'AlterDestination');
        const done = this.moveToward(p, p.Destination);
        if (p.bAdvancedTactics && p.Physics === 1) p.Destination = { ...t.Location };
        if (isPawn(t)) { p.DesiredSpeed = oldDS; if (!p.bCanSwim && t.Region?.Zone?.bWaterZone) p.MoveTimer = -1; }
        return done;
      }
      case 'strafefacing': {
        const t = p.FaceTarget;
        if (!t || t.__deleted) return true;
        p.Focus = { ...t.Location };
        const real = { ...p.Destination };
        this.rotateToward(p, p.Focus);
        if (p.bAdvancedTactics && p.Physics === 1) this.vm.event(p, 'AlterDestination');
        const done = this.moveToward(p, p.Destination);
        p.Destination = real;
        return done;
      }
      case 'turnto':
        this.glide(p);
        return this.rotateToward(p, p.Focus);
      case 'turntoward': {
        const t = p.FaceTarget;
        if (!t || t.__deleted) return true;
        this.glide(p);
        p.Focus = { ...t.Location };
        return this.rotateToward(p, p.Focus);
      }
    }
    return true;
  }

  // end of AActor::Tick for pawns: eye height / view rotation, weapon follows, sight, pain and speech timers
  tick(p, dt, playersOnly) {
    const vm = this.vm;
    if (p.bIsPlayer) {
      if (p.bViewTarget) vm.event(p, 'UpdateEyeHeight', dt);
      else p.ViewRotation = { ...p.Rotation };
    }
    if (p.Weapon && !p.Weapon.__deleted) this.level.physics.farMoveActor(p.Weapon, p.Location);
    if (playersOnly || p.__deleted) return;
    if (p.SightCounter < 0) p.SightCounter += 0.2;
    p.SightCounter = (p.SightCounter || 0) - dt;
    if (p.bIsPlayer && !p.bHidden) this.showSelf(p);
    if (p.SightCounter < 0 && this.level.physics.isProbing(p, 'EnemyNotVisible')) { this.checkEnemyVisible(p); p.SightCounter = 0.1; }
    if (p.PainTime > 0) { p.PainTime -= dt; if (p.PainTime < 0.001) { p.PainTime = 0; vm.event(p, 'PainTimer'); if (p.__deleted) return; } }
    if (p.SpeechTime > 0) { p.SpeechTime -= dt; if (p.SpeechTime < 0.001) { p.SpeechTime = 0; vm.event(p, 'SpeechTimer'); if (p.__deleted) return; } }
    if (p.bAdvancedTactics) vm.event(p, 'UpdateTactics', dt);
  }
}
