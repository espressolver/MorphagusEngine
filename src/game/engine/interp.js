// Path interpolation (KnowWonder/UE1 AInterpolationManager::performPhysics and the AInterpolationPoint
// helpers): an InterpolationManager moves its Owner along a chain of InterpolationPoints on Bezier
// segments, with pauses, speed matching and smoothed turning. Ported from the engine's rules, not its code.
import { rotAxes } from '../../uscript/natives_core.js';
import { appRound } from '../../uscript/natives_core.js';

const V = (X = 0, Y = 0, Z = 0) => ({ X, Y, Z });
const add = (a, b) => V(a.X + b.X, a.Y + b.Y, a.Z + b.Z);
const sub = (a, b) => V(a.X - b.X, a.Y - b.Y, a.Z - b.Z);
const mul = (a, s) => V(a.X * s, a.Y * s, a.Z * s);
const dot = (a, b) => a.X * b.X + a.Y * b.Y + a.Z * b.Z;
const cross = (a, b) => V(a.Y * b.Z - a.Z * b.Y, a.Z * b.X - a.X * b.Z, a.X * b.Y - a.Y * b.X);
const len = a => Math.hypot(a.X, a.Y, a.Z);
const normalize = a => { const q = dot(a, a); return q > 1e-8 ? mul(a, 1 / Math.sqrt(q)) : a; };
const K = 32768 / Math.PI;
// InterpolationManager declares its own PhysRate/PhysAlpha (shadowing Actor's); the native code uses those
const RATE = 'PhysRate@InterpolationManager', ALPHA = 'PhysAlpha@InterpolationManager';

// FVector::Rotation (truncated, MAXWORD/2pi scale)
const vecRot = v => { const k = 65535 / (2 * Math.PI); return { Pitch: Math.trunc(Math.atan2(v.Z, Math.hypot(v.X, v.Y)) * k), Yaw: Math.trunc(Math.atan2(v.Y, v.X) * k), Roll: 0 }; };
// GMath.UnitCoords / Rotator: the rotator's axes
const coordsOf = (r, origin = V()) => { const a = rotAxes(r); return { origin, X: a.X, Y: a.Y, Z: a.Z }; };
// FCoords::OrthoRotation
function orthoRotation(c) {
  const r = { Pitch: Math.trunc(Math.atan2(c.X.Z, Math.hypot(c.X.X, c.X.Y)) * K), Yaw: Math.trunc(Math.atan2(c.X.Y, c.X.X) * K), Roll: 0 };
  const sy = rotAxes(r).Y;
  r.Roll = Math.trunc(Math.atan2(dot(c.Z, sy), dot(c.Y, sy)) * K);
  return r;
}
const rotScale = (r, f) => ({ Pitch: appRound(r.Pitch * f), Yaw: appRound(r.Yaw * f), Roll: appRound(r.Roll * f) });
const rotAdd = (a, b) => ({ Pitch: a.Pitch + b.Pitch, Yaw: a.Yaw + b.Yaw, Roll: a.Roll + b.Roll });
const rotSub = (a, b) => ({ Pitch: a.Pitch - b.Pitch, Yaw: a.Yaw - b.Yaw, Roll: a.Roll - b.Roll });
const bezier = (p0, c0, c1, p1, t) => {
  const r = 1 - t, w0 = r * r * r, w1 = 3 * t * r * r, w2 = 3 * t * t * r, w3 = t * t * t;
  return V(w0 * p0.X + w1 * c0.X + w2 * c1.X + w3 * p1.X, w0 * p0.Y + w1 * c0.Y + w2 * c1.Y + w3 * p1.Y, w0 * p0.Z + w1 * c0.Z + w2 * c1.Z + w3 * p1.Z);
};

export class Interpolation {
  constructor(level) { this.level = level; this.vm = level.vm; }

  isManager(a) { return a.__isIM ?? (a.__isIM = a.Class.isA('InterpolationManager')); }

  // the actor with the point's ViewTargetTag[n] (cached in ViewTarget[n])
  viewTarget(pt, n) {
    const tag = pt.ViewTargetTag?.[n];
    if (!tag || tag === 'None') return null;
    pt.ViewTarget ??= [];
    let vt = pt.ViewTarget[n];
    if (!vt || vt.__deleted || String(vt.Tag).toLowerCase() !== String(tag).toLowerCase()) {
      const lt = String(tag).toLowerCase();
      vt = this.level.actors.find(a => !a.__deleted && String(a.Tag).toLowerCase() === lt) || null;
      pt.ViewTarget[n] = vt;
    }
    return vt;
  }

  rotAtPause(pt, n, loc) {
    if (pt.ViewTargetTag?.[n] && pt.ViewTargetTag[n] !== 'None') {
      const vt = this.viewTarget(pt, n);
      return vt ? vecRot(sub(vt.Location, loc)) : { ...pt.Rotation };
    }
    return { ...pt.Rotation };
  }

  rotAtPosition(pt, off, n, loc) {
    const pause = pt.Pause || [];
    if (off < 0) {
      if (n > 0) return this.rotAtPosition(pt, off + 1, n - 1, loc);
      if (pt.bInstantNextPath) return this.rotAtPause(pt, n, loc);
      const prev = pt.Prev;
      if (prev && !prev.bEndOfPath) {
        let i = 0; while (i < 8 && (prev.Pause?.[i] || 0) > 0) i++;
        return this.rotAtPosition(prev, off + 1, i, loc);
      }
      return this.rotAtPause(pt, n, loc);
    }
    if (off === 0) return this.rotAtPause(pt, n, loc);
    while ((pause[n + 1] || 0) > 0 && off > 0) { n++; off--; }
    if (pt.bEndOfPath || off === 0 || pt.Next?.bInstantNextPath || !pt.Next) return this.rotAtPause(pt, n, loc);
    return this.rotAtPosition(pt.Next, off - 1, 0, loc);
  }

  // AInterpolationPoint::GetInterpolatedPosition: Bezier from the previous point (old coords + its start
  // control point) to this one (its end control point), with the facing for this segment
  interpolated(pt, old, startCtl, alpha, n) {
    if (pt.bInstantNextPath) return coordsOf(pt.Rotation, { ...pt.Location });
    const endCtl = pt.EndControlPoint || V();
    const at = t => bezier(old.origin, add(old.origin, startCtl), add(pt.Location, endCtl), pt.Location, t);
    const loc = at(alpha);
    let c;
    if (pt.bFaceMoveDirection) {
      const back = alpha - 0.001;
      if (back <= 0) c = coordsOf(pt.Prev ? pt.Prev.Rotation : pt.Rotation);
      else c = coordsOf(vecRot(sub(loc, at(back))));
    } else if (pt.bNewRotationSmoothing) {
      const a2 = alpha * alpha, a3 = a2 * alpha;
      const A = this.rotAtPosition(pt, -2, n, loc), B = this.rotAtPosition(pt, -1, n, loc), C = this.rotAtPosition(pt, 0, n, loc), D = this.rotAtPosition(pt, 1, n, loc);
      const r = rotAdd(rotAdd(rotAdd(rotScale(B, 2 * a3 - 3 * a2 + 1), rotScale(C, -2 * a3 + 3 * a2)),
        rotScale(rotSub(C, A), (a3 - 2 * a2 + alpha) * 0.5)), rotScale(rotSub(D, B), (a3 - a2) * 0.5));
      c = coordsOf(r);
    } else if (pt.ViewTargetTag?.[n] && pt.ViewTargetTag[n] !== 'None') {
      const vt = this.viewTarget(pt, n);
      c = vt ? coordsOf(vecRot(sub(vt.Location, loc))) : { ...old };
    } else {
      const R = 1 - alpha, turn = pt.bTurnChange ? Math.sqrt(alpha) : alpha, C = coordsOf(pt.Rotation);
      const X = normalize(add(mul(old.X, R), mul(C.X, turn)));
      let Z = add(mul(old.Z, R), mul(C.Z, turn));
      const Y = normalize(cross(Z, X));
      Z = normalize(cross(X, Y));
      c = { X, Y, Z };
    }
    return { ...c, origin: loc };
  }

  // AInterpolationManager::performPhysics
  perform(im, dt) {
    const vm = this.vm, L = this.level, P = L.physics;
    const owner = im.Owner;
    if (!owner || owner.__deleted) { L.destroy(im); return; }
    const oldLocation = { ...owner.Location }, oldVelocity = { ...(owner.Velocity || V()) };
    let remaining = dt, desiredSpeed = 0;
    const gone = () => !im.Owner || im.Owner.__deleted || im.__deleted;
    while (im[RATE] && owner.bInterpolating && remaining > 0) {
      let segStart = { ...owner.Location };
      const dest = im.Dest && !im.Dest.__deleted ? im.Dest : null;
      let rateMod = 1;
      if (dest) {
        if (owner.IPSpeed) desiredSpeed = owner.IPSpeed;
        else if (dest.Next) {
          const cur = dest.DesiredSpeed > 0 ? dest.DesiredSpeed : len(owner.Velocity || V());
          if (dest.Next.DesiredSpeed > 0) desiredSpeed = cur * (1 - im[ALPHA]) + dest.Next.DesiredSpeed * im[ALPHA];
          else desiredSpeed = dest.DesiredSpeed > 0 ? dest.DesiredSpeed : 0;
        }
        if (desiredSpeed > 0) { if (dest.PathDist > 0) rateMod = desiredSpeed / dest.PathDist; }
        else {
          const es = len(dest.EndControlPoint || V()), ss = len(dest.StartControlPoint || V());
          rateMod = 1 + im[ALPHA] * (es / ss - 1);
          if (!Number.isFinite(rateMod)) rateMod = 1;
        }
      }
      const oldAlpha = im[ALPHA];
      let destAlpha = im[ALPHA] + im[RATE] * rateMod * remaining;
      im[ALPHA] = Math.min(1, Math.max(0, destAlpha));
      let done = false, actualTime = remaining;
      if (destAlpha > 1 && im.RemainingPause <= 0) actualTime = im[RATE] * rateMod * remaining - destAlpha + 1;
      let newLoc = { ...owner.Location }, desired = null;
      if (!dest) done = true;
      else {
        if (im.RemainingPause > 0) {
          desiredSpeed = 0; im[ALPHA] = 0; destAlpha = 0;
          im.RemainingPause -= remaining;
          if (im.RemainingPause < 0) { im.RemainingPause = 0; remaining = 0; done = true; } // (the engine zeroes the pause before taking the overshoot)
          vm.event(im, 'UpdateCamera', (im.StartPause - im.RemainingPause) / im.StartPause);
          if (gone()) return;
          const vt = this.viewTarget(dest, im.PauseNum | 0);
          desired = vt ? coordsOf(vecRot(sub(vt.Location, owner.Location))) : coordsOf(owner.Rotation);
          desired.origin = { ...owner.Location };
        } else {
          vm.event(im, 'UpdateCamera', oldAlpha);
          if (gone()) return;
          let old, startCtl;
          if (dest.Prev) { old = coordsOf(dest.Prev.Rotation, { ...dest.Prev.Location }); startCtl = dest.Prev.StartControlPoint || V(); }
          else { old = coordsOf(dest.Rotation, { ...owner.Location }); startCtl = V(); }
          desired = this.interpolated(dest, old, startCtl, im[ALPHA], im.PauseNum | 0);
          newLoc = desired.origin;
          if (dest.bConstantSpeed && desiredSpeed > 0 && im[ALPHA] < 1 && !dest.bInstantNextPath) {
            const sp = len(sub(newLoc, segStart)) / actualTime;
            if (Math.abs(sp - desiredSpeed) > 0.05 * desiredSpeed) {
              destAlpha = oldAlpha + im[RATE] * rateMod * actualTime * desiredSpeed / sp;
              im[ALPHA] = Math.min(1, Math.max(0, destAlpha));
              desired = this.interpolated(dest, old, startCtl, im[ALPHA], im.PauseNum | 0);
              newLoc = desired.origin;
              if (destAlpha > 1 && im.RemainingPause <= 0) actualTime = im[RATE] * rateMod * remaining - destAlpha + 1;
            }
          }
          if (dest.bFaceMoveDirection) { desired = coordsOf(vecRot(sub(desired.origin, owner.Location))); desired.origin = newLoc; }
        }
        // smoothed turning
        if (!dest.bNewRotationSmoothing) {
          const cur = coordsOf(owner.Rotation);
          im.OldDesiredX ??= V(); im.OldDesiredZ ??= V(); im.TurnRateX ??= V(); im.TurnRateZ ??= V();
          let rateX = mul(sub(desired.X, im.OldDesiredX), 1 / actualTime), rateZ = mul(sub(desired.Z, im.OldDesiredZ), 1 / actualTime);
          im.OldDesiredX = { ...desired.X }; im.OldDesiredZ = { ...desired.Z };
          let smooth = 1;
          if (dest.Prev) smooth = dest.Prev.Smoothing === 0 ? 0 : 1 / dest.Prev.Smoothing;
          const sX = mul(sub(desired.X, cur.X), 1 / smooth), sZ = mul(sub(desired.Z, cur.Z), 1 / smooth);
          if (dot(sX, rateX) <= 0) rateX = sX;
          if (dot(sZ, rateZ) <= 0) rateZ = sZ;
          if (smooth !== 0) {
            const k = smooth * actualTime;
            im.TurnRateX = add(mul(rateX, k), mul(im.TurnRateX, 1 - k));
            im.TurnRateZ = add(mul(rateZ, k), mul(im.TurnRateZ, 1 - k));
            const X = normalize(add(cur.X, mul(im.TurnRateX, actualTime)));
            let Z = normalize(add(cur.Z, mul(im.TurnRateZ, actualTime)));
            const Y = normalize(cross(Z, X));
            Z = normalize(cross(X, Y));
            desired = { ...desired, X, Y, Z };
          }
          im.TurnRateX = mul(sub(desired.X, cur.X), 1 / actualTime);
          im.TurnRateZ = mul(sub(desired.Z, cur.Z), 1 / actualTime);
        }
        P.moveActor(owner, sub(newLoc, owner.Location), owner.bInterpolating_IgnoreRot ? owner.Rotation : orthoRotation(desired), { force: true });
        if (gone()) return;
      }
      // past the end of the segment: notify and go on with the time left
      const forward = im[RATE] > 0;
      if (forward && destAlpha > 1) { im[ALPHA] = 0; remaining *= (destAlpha - 1) / (destAlpha - oldAlpha); done = true; }
      else if (!forward && destAlpha < 0) { im[ALPHA] = 1; remaining *= (0 - destAlpha) / (oldAlpha - destAlpha); done = true; }
      if (done) {
        if (dest) vm.event(dest, 'InterpolateEnd', im, forward);
        else vm.event(im, 'FinishedInterpolation', null);
        if (gone()) return;
        if (im.bInstantMove) { im.bInstantMove = false; Object.assign(oldLocation, owner.Location); segStart = { ...owner.Location }; }
        owner.Velocity = mul(sub(owner.Location, segStart), 1 / dt);
        if (len(owner.Velocity) >= desiredSpeed) remaining = 0;
      } else remaining = 0;
    }
    owner.Velocity = mul(sub(owner.Location, oldLocation), 1 / dt);
    const sp = len(owner.Velocity);
    if (desiredSpeed > 0 && sp > 1.05 * desiredSpeed) {
      // too fast (can happen across point changes): pull back
      const want = add(mul(sub(owner.Location, oldLocation), desiredSpeed / sp), oldLocation);
      P.moveActor(owner, sub(want, owner.Location), owner.Rotation, { force: true });
      if (gone()) return;
      owner.Velocity = mul(sub(owner.Location, oldLocation), 1 / dt);
    }
    owner.Acceleration = mul(sub(owner.Velocity, oldVelocity), 1 / dt);
  }
}
