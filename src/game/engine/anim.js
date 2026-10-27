// UE1 actor animation state machine (script-visible AnimSequence/AnimFrame/AnimRate...).
import { readSkeletalMesh, readAnimation } from '../../engine/umesh.js';
import { Assets } from '../../engine/assets.js';
import { rootLocal, meshDeltaToWorld } from './bones.js';

export class AnimSystem {
  constructor(level) {
    this.level = level;
    this.vm = level.vm;
    this.meshInfo = new Map(); // exp -> { mesh, anim, seqs: Map }
  }

  // Synchronous mesh/animation info for an asset ref
  info(meshRef) {
    if (!meshRef || !meshRef.exp) return null;
    let mi = this.meshInfo.get(meshRef.exp);
    if (mi !== undefined) return mi;
    mi = null;
    try {
      if (meshRef.exp.className === 'SkeletalMesh') {
        const mesh = readSkeletalMesh(meshRef.pkg, meshRef.exp);
        let anim = null;
        if (mesh.defaultAnim) anim = this.animByPath(mesh.defaultAnim);
        mi = { mesh, anim, seqs: new Map(), bones: mesh.refSkeleton.map(b => b.name) };
        if (anim) anim.animSeqs.forEach((s, i) => mi.seqs.set(s.name.toLowerCase(), { ...s, index: i }));
      }
    } catch (e) { console.warn('mesh info', meshRef.Name, e); }
    this.meshInfo.set(meshRef.exp, mi);
    return mi;
  }

  animByPath(path) {
    const parts = path.split('.');
    const pkg = this.vm.assets.loaded.get(parts[0].toLowerCase());
    if (!pkg) return null;
    const exp = Assets.findInPackage(pkg, parts.slice(1).map(s => s.toLowerCase()), 'Animation');
    if (!exp) return null;
    this._animCache ??= new Map();
    let a = this._animCache.get(exp);
    if (!a) { a = readAnimation(pkg, exp); a.name = exp.name; a.seqByName = new Map(a.animSeqs.map((s, i) => [s.name.toLowerCase(), i])); this._animCache.set(exp, a); }
    return a;
  }

  // Override the animation set (e.g. Actor.Anim / SetAnimSet style)
  seq(a, name) {
    const mi = this.info(a.Mesh);
    if (!mi) return null;
    return mi.seqs.get(String(name).toLowerCase()) || null;
  }

  // KnowWonder/UE1 PlayAnim: AnimFrame runs 0..AnimLast while TweenAlpha blends in from the previous pose
  // (TweenRate = 1/TweenTime, 2 when the tween time is left to the engine, none for 0). A loop of the
  // sequence already looping only changes its rate. A whole-skeleton AT_Replace anim stops the aux
  // channels. rootBone 'Move' makes the root bone's motion move the actor (bAnimMove).
  playAnim(a, name, rate = 1, tween = -1, loop = false, minRate = 0, rootBone = null, type = 0) {
    if (rate === undefined || rate === null) rate = 1;
    const move = !!rootBone && String(rootBone).toLowerCase() === 'move';
    a.bAnimMove = move;
    if (type === 0) this.stopChannels(a);
    const none = !name || String(name) === 'None';
    const s = none ? null : this.seq(a, name);
    if (!s && !none) { this.vm.warnOnce('noanim' + name + a.Class.name, 'missing anim', name, 'on', a.Class.name, String(a.Mesh)); return false; }
    if (s) {
      const nf = Math.max(1, s.numFrames);
      if (String(a.AnimSequence).toLowerCase() === s.name.toLowerCase() && loop && a.bAnimLoop && this.isAnimating(a)) {
        a.AnimRate = rate * s.rate / nf;
        a.bAnimFinished = false;
        a.AnimMinRate = minRate ? minRate * (s.rate / nf) : 0;
        return true;
      }
      a.AnimRate = rate * s.rate / nf;
      a.AnimLast = 1 - 1 / nf;
      a.AnimMinRate = minRate ? minRate * (s.rate / nf) : 0;
      a.bAnimNotify = s.notifys.length > 0;
      a.bAnimLoop = !!loop;
    } else { a.AnimLast = 0; a.bAnimLoop = false; }
    a.AnimSequence = s ? s.name : 'None';
    a.bAnimFinished = false;
    a.AnimFrame = 0;
    a.TweenAlpha = 0;
    if (a.AnimLast === 0) { a.AnimMinRate = 0; a.AnimRate = 0; a.bAnimNotify = false; }
    if (tween > 0) a.TweenRate = 1 / tween;
    else if (tween < 0) a.TweenRate = 2;
    else { a.TweenRate = 0; a.TweenAlpha = 1; }
    a.__animStart = (a.__animStart || 0) + 1; // renderer cue: blend in from the pose shown so far
    a.__rootMotion = null;
    if (move && s) {
      const start = rootLocal(this.level, a);
      if (start) a.__rootMotion = { seq: s.name, start, last: start.slice() };
    }
    return true;
  }

  // TweenAnim = PlayAnim at rate 0: blend into the sequence's first frame, AnimEnd when the tween is done
  tweenAnim(a, name, time) { return this.playAnim(a, name, 0, time, false); }

  boneIndex(a, bone) { const mi = this.info(a.Mesh); return mi ? mi.bones.findIndex(b => b.toLowerCase() === String(bone).toLowerCase()) : -1; }
  // bone b2's range (itself and its children) contains bone b1
  isSubset(a, b1, b2) { const sk = this.info(a.Mesh)?.mesh.refSkeleton; return !!sk && b1 >= b2 && b1 < b2 + (sk[b2]?.numChildren || 0); }

  // UE1 CreateAnimChannel: one channel per bone range (an existing one with the same range and transience is
  // reused); AT_Combine puts it first, AT_Replace removes channels inside its range and appends it
  createChannel(a, cls, type, root, transient = false) {
    if (!this.info(a.Mesh) || !root || root === 'None') return null;
    const bone = this.boneIndex(a, root);
    if (bone < 0) return null;
    const list = (a.__channels ??= []).filter(c => !c.__deleted);
    a.__channels = list;
    const same = list.find(c => c.AnimBone === bone && !!c.bAnimTransient === !!transient);
    if (same) return same;
    const ch = this.level.spawn(cls, a, null, a.Location, a.Rotation, { noFit: true });
    if (!ch) return null;
    ch.Mesh = a.Mesh; ch.bHidden = true;
    ch.AnimBone = bone; ch.bAnimTransient = !!transient;
    ch.__channelOf = a; ch.__rootBone = root; ch.__animType = type | 0;
    if (type === 1) list.unshift(ch);
    else {
      for (let i = list.length - 1; i >= 0; i--) if (this.isSubset(a, list[i].AnimBone, bone)) { this.level.destroy(list[i]); list.splice(i, 1); }
      list.push(ch);
    }
    return ch;
  }
  // the channel playing on a bone range (FinishAnim / IsAnimating with a bone), or null
  channelOn(a, root) {
    const bone = this.boneIndex(a, root);
    return bone < 0 ? null : (a.__channels || []).find(c => !c.__deleted && c.AnimBone === bone) || null;
  }
  // PlayAnim/LoopAnim with a root bone: play on a transient channel for that bone range; no sequence
  // stops the channels inside the range
  playOnBone(a, name, rate, tween, loop, minRate, type, root) {
    if (name && name !== 'None') {
      const ch = this.createChannel(a, this.vm.cls('AnimChannel') || this.vm.cls('Actor'), type, root, true);
      return ch ? this.playAnim(ch, name, rate, tween, loop, minRate) : false;
    }
    const bone = this.boneIndex(a, root);
    if (bone < 0) return false;
    a.__channels = (a.__channels || []).filter(c => {
      if (c.__deleted || !this.isSubset(a, c.AnimBone, bone)) return !c.__deleted;
      if (c.bAnimTransient) { this.level.destroy(c); return false; }
      c.AnimSequence = 'None';
      return true;
    });
    return true;
  }

  // AT_Replace on the whole skeleton: transient channels go away, the others stop playing
  stopChannels(a) {
    if (!a.__channels) return;
    a.__channels = a.__channels.filter(ch => {
      if (ch.__deleted) return false;
      if (ch.bAnimTransient) { this.level.destroy(ch); return false; }
      ch.AnimSequence = 'None';
      return true;
    });
  }

  isAnimating(a) { return !!a.AnimSequence && a.AnimSequence !== 'None' && (a.AnimRate !== 0 || a.TweenRate !== 0); }

  // FinishAnim: a loop finishes at its next end; waits only while the anim plays before its last frame
  finishAnimStart(a) {
    if (a.bAnimLoop) { a.bAnimLoop = false; a.bAnimFinished = false; }
    return this.isAnimating(a) && a.AnimFrame < a.AnimLast;
  }
  finishAnimDone(a) { return !!a.bAnimFinished; }

  // UE1 AActor::Tick animation update: tween and frames advance together, up to 4 passes so notifys and
  // the sequence end split the time; AnimEnd goes to the animating actor (the owner for transient channels)
  tick(a, dt) {
    if (!a.Mesh) return;
    const vm = this.vm;
    const animator = a.AnimBone && a.bAnimTransient && a.Owner ? a.Owner : a;
    let secs = dt;
    for (let it = 0; this.isAnimating(a) && secs > 0 && it < 4; it++) {
      if (a.TweenRate > 0) {
        a.TweenAlpha += a.TweenRate * secs;
        if (a.TweenAlpha >= 1) {
          a.TweenAlpha = 1; a.TweenRate = 0;
          if (a.AnimRate === 0) { a.bAnimFinished = true; vm.event(animator, 'AnimEnd'); if (a.__deleted) return; }
        }
      }
      const old = a.AnimFrame;
      if (a.AnimRate === 0) break;
      if (a.AnimRate >= 0) a.AnimFrame += a.AnimRate * secs;
      else a.AnimFrame += Math.max(a.AnimMinRate || 0, Math.hypot(animator.Velocity.X, animator.Velocity.Y, animator.Velocity.Z) * -a.AnimRate) * secs;
      if (a.bAnimNotify) {
        const s = this.seq(a, a.AnimSequence);
        let best = null;
        for (const n of s?.notifys || []) if (old < n.time && a.AnimFrame >= n.time && (!best || n.time - old < best.time - old)) best = n;
        if (best) {
          secs = secs * (a.AnimFrame - best.time) / (a.AnimFrame - old);
          a.AnimFrame = best.time;
          const fn = vm.findFunction(animator, best.fn.toLowerCase());
          if (fn) vm.invoke(fn, animator, []);
          if (a.__deleted) return;
          continue;
        }
      }
      if (a.AnimFrame < a.AnimLast) break;
      if (a.bAnimLoop) {
        if (a.AnimFrame < 1) secs = 0;
        else { secs = secs * (a.AnimFrame - 1) / (a.AnimFrame - old); a.AnimFrame = 0; }
        if (old < a.AnimLast) {
          if (a.__latent?.kind === 'finishanim' || a.__channelOf?.__latent?.chan === a) a.bAnimFinished = true;
          vm.event(a, 'AnimEnd');
          if (a.__deleted) return;
        }
      } else {
        secs = secs * (a.AnimFrame - a.AnimLast) / (a.AnimFrame - old);
        a.AnimFrame = a.AnimLast;
        a.bAnimFinished = true;
        a.AnimRate = 0;
        vm.event(animator, 'AnimEnd');
        if (a.__deleted) return;
      }
    }
  }

  // bAnimMove (after physics): move by the root bone's motion, sliding along what it hits
  rootMove(a) {
    const rm = a.__rootMotion;
    if (!rm || !a.bAnimMove) return;
    if (String(a.AnimSequence) !== rm.seq) { a.__rootMotion = null; return; }
    const cur = rootLocal(this.level, a);
    if (!cur) return;
    const d = [cur[0] - rm.last[0], cur[1] - rm.last[1], cur[2] - rm.last[2]];
    rm.last = cur;
    if (Math.abs(d[0]) + Math.abs(d[1]) + Math.abs(d[2]) < 1e-4) return;
    const P = this.level.physics;
    const w = meshDeltaToWorld(this.level, a, d);
    const r = P.moveActor(a, w, null);
    if (r.time < 1 && !a.__deleted) {
      const left = { X: w.X * (1 - r.time), Y: w.Y * (1 - r.time), Z: w.Z * (1 - r.time) };
      const n = r.normal, k = left.X * n.X + left.Y * n.Y + left.Z * n.Z;
      P.moveActor(a, { X: left.X - n.X * k, Y: left.Y - n.Y * k, Z: left.Z - n.Z * k }, null);
    }
  }



}

