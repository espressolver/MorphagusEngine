// Engine natives: Actor, Pawn, PlayerPawn, LevelInfo, GameInfo, misc.
import { PHYS, V, add, sub, mul, len, norm, dot } from './physics.js';
import { rotAxes } from '../../uscript/natives_core.js';
import { storageGet, storageSet } from './save.js';
import * as THREE from 'three';
import { bonePos } from './bones.js';
import { skelPlacement, rotatorMatrix } from '../../render/skeletal.js';
import { boxOf, sweepCylinderBox, cylinderOverlapsBox } from './shapes.js';
import { lineTrace } from './collision.js';
import { TRACE } from './physics.js';
import { bspNodeAt } from './bspcol.js';

const storageSetInfo = (k, v) => storageSet('info.' + k.toLowerCase(), v);
const storageGetInfo = k => storageGet('info.' + k.toLowerCase());

const RU = Math.PI / 32768;

// UMesh world placement: Location + PrePivot, Rotation, RotOrigin, Scale x DrawScale, -Origin
function vertexMeshPlacement(a, m) {
  const L = a.Location, pp = a.PrePivot || V(), ds = a.DrawScale ?? 1, ms = m.scale || [1, 1, 1], o = m.origin || [0, 0, 0];
  const t = new THREE.Matrix4();
  return new THREE.Matrix4().makeTranslation(L.X + pp.X, L.Y + pp.Y, L.Z + pp.Z)
    .multiply(rotatorMatrix({ pitch: a.Rotation.Pitch, yaw: a.Rotation.Yaw, roll: a.Rotation.Roll }, t))
    .multiply(rotatorMatrix(m.rotOrigin, new THREE.Matrix4()))
    .multiply(t.makeScale(ms[0] * ds, ms[1] * ds, ms[2] * ds))
    .multiply(new THREE.Matrix4().makeTranslation(-o[0], -o[1], -o[2]));
}
const lc = s => String(s ?? '').toLowerCase();

export function installActorNatives(vm, engine) {
  const N = (idx, fn) => vm.natives.set(idx, fn);
  const NN = (name, fn) => vm.namedNatives.set(name.toLowerCase(), fn);
  const L = () => engine.level;
  const P = () => engine.level.physics;
  const A = () => engine.level.anim;

  // ---------------- latent
  N(256, (s, [t]) => { s.__latent = { kind: 'sleep', t: +t || 0 }; });
  // FinishAnim(optional bone): wait on the channel playing on that bone range (no channel: don't wait)
  N(261, (s, [bone]) => {
    const ch = bone && bone !== 'None' ? A().channelOn(s, bone) : s;
    if (ch && A().finishAnimStart(ch)) s.__latent = { kind: 'finishanim', chan: ch };
  });
  N(301, s => { s.__latent = { kind: 'finishinterp' }; }); // wakes once bInterpolating is off
  N(527, s => { s.LatentFloat = 2.5; if (s.Physics === PHYS.Falling) s.__latent = { kind: 'waitlanding' }; });
  // AI latent moves (UnPawn.cpp): set up and steer now, poll every tick
  const ai = (kind, a, b) => s => { const l = L().pawns.startMove(s, kind, a, b); if (l) s.__latent = l; };
  N(500, (s, [dest, speed]) => ai('moveto', dest, speed)(s));
  N(502, (s, [target, speed]) => ai('movetoward', target, speed)(s));
  N(504, (s, [dest, focus]) => ai('strafeto', dest, focus)(s));
  N(506, (s, [dest, target]) => ai('strafefacing', dest, target)(s));
  N(508, (s, [focus]) => ai('turnto', focus)(s));
  N(510, (s, [target]) => ai('turntoward', target)(s));
  NN('pawn.stopwaiting', s => { if (s.__latent && s.__latent.kind === 'sleep') s.__latent.t = -1; }); // wakes on the next poll

  // ---------------- collision / movement
  N(262, (s, [ca, ba, bp]) => {
    if (ca !== undefined) s.bCollideActors = !!ca;
    if (ba !== undefined) s.bBlockActors = !!ba;
    if (bp !== undefined) s.bBlockPlayers = !!bp;
    // UE1 SetCollision only re-hashes the actor: touches change on the next move
  });
  N(283, (s, [r, h]) => { s.CollisionRadius = r; s.CollisionHeight = h; return true; });
  // GetWorldCollisionBox(bVisual): the world box of the collision primitive, or with bVisual of the mesh
  // (USkeletalMesh: BoundingBox placed by GetMeshCoords; UMesh: scaled about Origin, RotOrigin, Rotation,
  // at Location + PrePivot) or the brush
  N(286, (s, [bVisual]) => {
    const aabb = pts => {
      const mn = V(Infinity, Infinity, Infinity), mx = V(-Infinity, -Infinity, -Infinity);
      for (const q of pts) { mn.X = Math.min(mn.X, q.X); mn.Y = Math.min(mn.Y, q.Y); mn.Z = Math.min(mn.Z, q.Z); mx.X = Math.max(mx.X, q.X); mx.Y = Math.max(mx.Y, q.Y); mx.Z = Math.max(mx.Z, q.Z); }
      return { Min: mn, Max: mx, IsValid: 1 };
    };
    if (bVisual) {
      const m = s.Mesh ? A().info(s.Mesh)?.mesh : null;
      if (m?.box) {
        const M = m.refSkeleton ? skelPlacement(s, m, new THREE.Matrix4()) : vertexMeshPlacement(s, m);
        const b = m.box, pts = [];
        for (let i = 0; i < 8; i++) {
          const v = new THREE.Vector3(i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2]).applyMatrix4(M);
          pts.push(V(v.x, v.y, v.z));
        }
        return aabb(pts);
      }
      if (!s.Mesh && s.Brush && s.__polys) { const b = P().moverBounds(s); if (b) return { Min: b.min, Max: b.max, IsValid: 1 }; }
    }
    const bx = boxOf(s);
    if (bx) {
      const pts = [];
      for (let i = 0; i < 8; i++) {
        const k = [i & 1 ? 1 : -1, i & 2 ? 1 : -1, i & 4 ? 1 : -1];
        pts.push(V(bx.c.X + k[0] * bx.e[0] * bx.ax[0].X + k[1] * bx.e[1] * bx.ax[1].X + k[2] * bx.e[2] * bx.ax[2].X,
          bx.c.Y + k[0] * bx.e[0] * bx.ax[0].Y + k[1] * bx.e[1] * bx.ax[1].Y + k[2] * bx.e[2] * bx.ax[2].Y,
          bx.c.Z + k[0] * bx.e[0] * bx.ax[0].Z + k[1] * bx.e[1] * bx.ax[1].Z + k[2] * bx.e[2] * bx.ax[2].Z));
      }
      return aabb(pts);
    }
    const l = s.Location, r = s.CollisionRadius, h = s.CollisionHeight;
    return { Min: V(l.X - r, l.Y - r, l.Z - h), Max: V(l.X + r, l.Y + r, l.Z + h), IsValid: 1 };
  });
  // GetRenderExtent: a skeletal mesh's average animation box (BoundingBoxSum), else the primitive's local box
  N(274, s => {
    const m = s.Mesh ? A().info(s.Mesh)?.mesh : null;
    if (m?.refSkeleton) {
      const bs = m.boxes || [];
      if (!bs.length) return V();
      const mn = [0, 0, 0], mx = [0, 0, 0];
      for (const b of bs) for (let i = 0; i < 3; i++) { mn[i] += b.min[i]; mx[i] += b.max[i]; }
      return V((mx[0] - mn[0]) / bs.length, (mx[1] - mn[1]) / bs.length, (mx[2] - mn[2]) / bs.length);
    }
    if (m?.box) return V(m.box.max[0] - m.box.min[0], m.box.max[1] - m.box.min[1], m.box.max[2] - m.box.min[2]);
    return V(2 * (s.CollisionRadius || 0), 2 * (s.CollisionRadius || 0), 2 * (s.CollisionHeight || 0));
  });
  N(266, (s, [d]) => !P().moveActor(s, d).hit);
  N(3969, (s, [d]) => P().moveSmooth(s, d)); // MoveSmooth: true if the actor moved at all
  N(267, (s, [loc]) => P().farMoveActor(s, loc));
  N(299, (s, [rot]) => { s.Rotation = { Pitch: rot.Pitch | 0, Yaw: rot.Yaw | 0, Roll: rot.Roll | 0 }; return true; });
  N(3971, (s, [dt]) => { engine.playerRanPhysics = true; P().perform(s, dt); });
  N(298, (s, [b]) => P().setBase(s, b || null));
  N(272, (s, [o]) => L().setOwner(s, o));
  N(3970, (s, [ph]) => P().setPhysics(s, ph | 0));
  N(3972, () => engine.saveExists?.() || false);

  // ---------------- animation
  const onBone = r => r && r !== 'None' && String(r).toLowerCase() !== 'move';
  N(259, (s, [seq, rate, tween, type, root]) => onBone(root) ? A().playOnBone(s, seq, rate ?? 1, tween ?? -1, false, 0, type | 0, root)
    : A().playAnim(s, seq, rate ?? 1, tween ?? -1, false, 0, root, type | 0));
  N(260, (s, [seq, rate, tween, minRate, type, root]) => onBone(root) ? A().playOnBone(s, seq, rate ?? 1, tween ?? -1, true, minRate || 0, type | 0, root)
    : A().playAnim(s, seq, rate ?? 1, tween ?? -1, true, minRate || 0, root, type | 0));
  N(294, (s, [seq, time]) => A().tweenAnim(s, seq, time || 0));
  N(282, (s, [bone]) => { if (!bone || bone === 'None') return A().isAnimating(s); const ch = A().channelOn(s, bone); return !!ch && A().isAnimating(ch); });
  N(293, (s, [seq]) => A().seq(s, seq)?.group || 'None');
  N(263, (s, [seq]) => !!A().seq(s, seq));
  N(265, (s, [cls, type, root, transient]) => A().createChannel(s, cls, type | 0, root, !!transient));
  N(268, (s, [bone]) => { const mi = A().info(s.Mesh); return mi ? mi.bones.findIndex(b => lc(b) === lc(bone)) : -1; });
  N(269, (s, [i]) => { const mi = A().info(s.Mesh); return mi?.bones[i] || 'None'; });
  N(257, (s, [bone]) => bonePos(engine.level, s, bone) || { ...s.Location });

  // ---------------- traces
  const opt = (v, d) => (v === undefined || v === null ? d : v);
  // Trace(out HitLocation, out HitNormal, End, optional Start = Location, optional bTraceActors = bCollideActors,
  // optional Extent): first VisBlocking (or, tracing actors, any colliding) hit; None if nothing
  N(277, (s, [hitLoc, hitNorm, end, start, traceActors, extent]) => {
    const h = P().trace(opt(start, s.Location), end, opt(extent, V()), !!opt(traceActors, s.bCollideActors), s);
    hitLoc.set(h ? { ...h.location } : { ...end }); hitNorm.set(h ? { ...h.normal } : V());
    return h ? h.actor : null;
  });
  // UE1 FastTrace / visibility: level geometry (BSP) only, movers and actors don't block
  const worldClear = (a, b) => L().pawns.fastLine(b, a);
  N(548, (s, [end, start]) => worldClear(opt(start, s.Location), end));
  // HP TraceTexture(End, Start, out Flags): texture of the level surface the line hits (and its poly flags)
  N(285, (s, [end, start, flags]) => {
    const h = P().singleLineCheck(s, start, end, TRACE.Level, V());
    flags?.set?.(0);
    if (!h?.bsp) return null;
    const lvl = L(), m = h.bsp.model, node = bspNodeAt(m, h.bsp.item, h.bsp.loc, h.normal, 0, h.bsp.xf);
    const surf = node && m.surfs?.[node.iSurf];
    if (!surf) return null;
    const tex = surf.texture ? vm.assetRef(lvl.pkg, surf.texture) : null;
    flags?.set?.(((surf.flags >>> 0) | ((tex?.PolyFlags >>> 0) || 0)) | 0);
    return tex;
  });

  // ---------------- spawn / destroy / timer
  N(278, (s, [cls, owner, tag, loc, rot]) => {
    if (!cls) return null;
    const useLoc = loc ? loc : s.Location;
    const useRot = rot ? rot : s.Rotation;
    // Spawn(class, optional owner, optional tag, ...): no owner by default, the spawner's Instigator, Tag = tag
    return L().spawn(cls, owner || null, tag || 'None', useLoc, useRot, { instigator: s.Instigator || null });
  });
  N(279, s => L().destroy(s));
  N(280, (s, [rate, loop]) => { s.TimerRate = rate; s.TimerCounter = 0; s.bTimerLoop = !!loop; });

  // ---------------- sound
  // PlaySound: omitted slot is SLOT_Misc, volume/radius/pitch the actor's Transient values (pitch /64);
  // each player pawn hears it within radius/1.3 (1600 when 0) of its view target, and without a clear
  // line at 0.35 volume and (unless it is the instigator) 0.6 of that range squared (CheckHearSound)
  const playSound = (s, [snd, slot, vol, noOverride, radius, pitch]) => {
    if (!snd) return;
    slot = slot ?? 1; vol = vol ?? (s.TransientSoundVolume ?? 1); radius = radius ?? (s.TransientSoundRadius || 0);
    pitch = pitch ?? (s.TransientSoundPitch ?? 64) / 64;
    const rsq = (radius || 1600) ** 2;
    for (let h = L().levelInfo.PawnList; h; h = h.nextPawn) {
      if (!h.bIsPlayer || h.__deleted) continue;
      const src = (h.ViewTarget && !h.ViewTarget.__deleted ? h.ViewTarget : h).Location;
      let r = rsq / 1.3, v = vol;
      const d = sub(src, s.Location), dsq = dot(d, d);
      if (dsq >= r) continue;
      if (!worldClear(src, s.Location)) {
        if (s.Instigator !== h) r *= 0.6;
        v *= 0.35;
        if (dsq > r) continue;
      }
      if (h === engine.player) engine.audio?.playSound(s, snd, slot, v, !!noOverride, radius, pitch);
    }
  };
  N(264, playSound);
  NN('actor.playownedsound', playSound);
  // ModifySound(param, value, optional sound, optional slot = SLOT_Misc): false once it is no longer playing
  N(567, (s, [param, value, snd, slot]) => engine.audio?.modifySound(s, snd || null, slot ?? 1, param | 0, +value || 0) || false);
  // StopSound(optional sound, optional slot = SLOT_Misc): that slot's sounds (SLOT_None: any played in SLOT_None)
  N(568, (s, [snd, slot]) => engine.audio?.stopSound(s, snd || null, slot ?? 1));
  NN('actor.getsoundduration', (s, [snd]) => engine.audio?.duration(snd) || 0);
  N(512, (s, [loud]) => engine.makeNoise?.(s, loud)); // HearNoise: no HP1 script listens (all only ignore it)
  // PlayerCanSeeMe: the local player views it, or it is near enough, in front (or behind view) and in sight
  N(532, s => {
    const v = engine.player;
    if (!v) return false;
    if (v.ViewTarget === s) return true;
    const d = sub(s.Location, v.Location), dsq = dot(d, d), f = rotV(v.ViewRotation || v.Rotation);
    return dsq < 100000 * ((s.CollisionRadius || 0) + 3.6) && (!!v.bBehindView || dot(f, d) ** 2 >= 0.25 * dsq) && L().pawns.lineOfSightTo(v, s);
  });

  // ---------------- misc
  N(233, (s, [msg]) => { vm.warnOnce('err' + msg, 'Error:', s.Name, msg); L().destroy(s); });
  N(547, () => L().mapName);
  N(539, (s, [ending, map, dir]) => map);
  N(545, (s, [prefix, cur, dir, name, desc]) => { name.set(''); desc.set(''); });
  NN('actor.consolecommand', (s, [cmd]) => engine.consoleCommand(String(cmd), s) ?? '');
  NN('playerpawn.consolecommand', (s, [cmd]) => engine.consoleCommand(String(cmd), s) ?? '');
  NN('console.consolecommand', (s, [cmd]) => engine.consoleCommand(String(cmd), s) ?? '');
  NN('actor.getnextintdesc', (s, [cls, num, entry, desc]) => { entry.set(''); desc.set(''); });
  // colour arithmetic on bytes (wrapping, like the engine's BYTE maths); alpha is left alone
  const b8 = v => Math.trunc(v) & 255;
  N(549, (s, [a, b]) => ({ ...a, R: b8(a.R - b.R), G: b8(a.G - b.G), B: b8(a.B - b.B) }));
  N(550, (s, [f, c]) => ({ ...c, R: b8(c.R * f), G: b8(c.G * f), B: b8(c.B * f) }));
  N(551, (s, [a, b]) => ({ ...a, R: b8(a.R + b.R), G: b8(a.G + b.G), B: b8(a.B + b.B) }));
  N(552, (s, [c, f]) => ({ ...c, R: b8(c.R * f), G: b8(c.G * f), B: b8(c.B * f) }));
  N(321, (s, [name, file]) => engine.textureFromBMP?.(name, file) || null);
  N(322, () => engine.screenshotTexture?.() || null);
  N(323, () => true); N(324, () => true);
  // GameSaveInfo objects: store their script properties per slot name
  N(325, (s, [dir, obj]) => {
    if (!obj) return false;
    const props = {};
    for (const p of obj.Class?.props || []) { const v = obj[p.key]; if (v === null || typeof v !== 'object' || (!v.__isUObject && !v.__isClass)) props[p.key] = v; }
    return storageSetInfo(String(dir), props);
  });
  N(326, (s, [dir, obj]) => {
    const props = storageGetInfo(String(dir));
    if (!props || !obj) return false;
    Object.assign(obj, props);
    return true;
  });
  N(327, () => true);

  // ---------------- iterators (return arrays)
  // iterators walk the live actor list (lazily), like the engine's
  const isA = (a, cls) => !cls || a.Class.isChildOf(cls);
  function* walk(test) { const list = L().actors; for (let i = 0; i < list.length; i++) { const a = list[i]; if (!a.__deleted && test(a)) yield a; } }
  N(304, (s, [cls, out, tag]) => { const t = tag && tag !== 'None' ? String(tag).toLowerCase() : null; return walk(a => isA(a, cls) && (!t || String(a.Tag).toLowerCase() === t)); });
  N(305, (s, [cls]) => walk(a => isA(a, cls) && P().isOwnedBy(a, s))); // IsOwnedBy: the actor itself counts
  N(306, (s, [cls]) => walk(a => isA(a, cls) && a.Base === s));
  N(307, function* (s, [cls]) { const slots = P().touchSlots(s); for (let i = 0; i < slots.length; i++) { const a = slots[i]; if (a && !a.__deleted && isA(a, cls)) yield a; } });
  // ZoneInfo.ZoneActors: actors in this zone (an actor whose zone is the LevelInfo counts for every zone)
  N(308, (s, [cls]) => walk(a => isA(a, cls) && (a.Region?.Zone && a.Region.Zone !== L().levelInfo ? a.Region.Zone === s : true)));
  // TraceActors: every hit along the line (actors and the level), sorted
  N(309, (s, [cls, out, hl, hn, end, start, extent]) => P().multiLineCheck(opt(start, s.Location), end, opt(extent, V()), true)
    .filter(h => isA(h.actor, cls)).map(h => [h.actor, h.location, h.normal]));
  // RadiusActors: within Radius of the point plus the actor's own collision radius
  N(310, (s, [cls, out, radius, loc]) => { const c = opt(loc, s.Location); return walk(a => isA(a, cls) && (a.Location.X - c.X) ** 2 + (a.Location.Y - c.Y) ** 2 + (a.Location.Z - c.Z) ** 2 < (radius + (a.CollisionRadius || 0)) ** 2); });
  // VisibleActors: not hidden, within Radius (0 = anywhere), level geometry not in between
  N(311, (s, [cls, out, radius, loc]) => { const c = opt(loc, s.Location); return walk(a => !a.bHidden && isA(a, cls) && (!radius || (a.Location.X - c.X) ** 2 + (a.Location.Y - c.Y) ** 2 + (a.Location.Z - c.Z) ** 2 < radius * radius) && worldClear(c, a.Location)); });
  // VisibleCollidingActors: colliding actors whose centre is within Radius (default 1000), visible
  N(312, (s, [cls, out, radius, loc, ignoreHidden]) => {
    const c = opt(loc, s.Location), r = radius || 1000;
    return L().actors.filter(a => !a.__deleted && !a.__unhashed && a.bCollideActors && (a.Location.X - c.X) ** 2 + (a.Location.Y - c.Y) ** 2 + (a.Location.Z - c.Z) ** 2 < r * r)
      .filter(a => isA(a, cls) && !(ignoreHidden && a.bHidden) && worldClear(c, a.Location));
  });

  // ---------------- Pawn
  N(529, s => {
    const LI = L().levelInfo;
    for (let p = LI.PawnList; p; p = p.nextPawn) if (p === s) return;
    s.nextPawn = LI.PawnList; LI.PawnList = s;
  });
  N(530, s => {
    const LI = L().levelInfo;
    let prev = null;
    for (let p = LI.PawnList; p; p = p.nextPawn) { if (p === s) { if (prev) prev.nextPawn = p.nextPawn; else LI.PawnList = p.nextPawn; return; } prev = p; }
  });
  N(514, (s, [o]) => L().pawns.lineOfSightTo(s, o));
  N(533, (s, [o]) => L().pawns.lineOfSightTo(s, o, true)); // CanSee: sight with field of view (the ShowSelf test)
  N(520, (s, [o]) => !!o && !P().trace(s.Location, o.Location, null, false, s));
  N(521, (s, [pt]) => !P().trace(s.Location, pt, null, false, s));
  N(518, (s, [pt]) => engine.nav?.findPathTo(s, pt) || null);
  N(517, (s, [a]) => a ? (engine.nav?.findPathTo(s, a.Location, a) || null) : null);
  N(553, (s, [start, destClass]) => engine.nav?.findPath(s, start, destClass) || null);
  N(525, s => engine.nav?.randomDest(s) || null);
  N(522, () => {});
  N(523, s => ({ ...(s.Velocity || V()) }));
  N(526, () => false);
  N(524, () => 0);
  N(540, () => null);
  // PickTarget / PickAnyTarget: the pawn (or other projectile target) best lined up with FireDir within 2000
  // units and in sight; bestAim/bestDist are raised as better ones are found
  const pick = (s, list, bestAim, bestDist, dir, from) => {
    let best = null;
    for (const o of list) {
      const d = sub(o.Location, from), aim = dot(dir, d);
      if (aim <= 0) continue;
      const dsq = dot(d, d);
      if (dsq >= 4000000) continue;
      const dist = Math.sqrt(dsq), a = aim / dist;
      if (a > bestAim.get() && L().pawns.lineOfSightTo(s, o)) { best = o; bestAim.set(a); bestDist.set(dist); }
    }
    return best;
  };
  N(531, (s, [bestAim, bestDist, dir, from]) => {
    const list = [];
    for (let o = L().levelInfo.PawnList; o; o = o.nextPawn) if (o !== s && !o.__deleted && o.Health > 0 && o.bProjTarget) list.push(o);
    return pick(s, list, bestAim, bestDist, dir, from);
  });
  N(534, (s, [bestAim, bestDist, dir, from]) => pick(s, L().actors.filter(o => !o.__deleted && o.bProjTarget && !o.Class.isA('Pawn')), bestAim, bestDist, dir, from));

  // ---------------- PlayerPawn
  N(544, () => {});
  N(546, () => {});
  N(542, (s, [v]) => ({ ...v }));
  NN('playerpawn.clienttravel', (s, [url, type, items]) => engine.travel(String(url)));
  NN('playerpawn.getentrylevel', () => L().levelInfo);
  NN('playerpawn.getdefaulturl', (s, [opt]) => '');
  NN('playerpawn.copytoclipboard', () => {});
  NN('playerpawn.pastefromclipboard', () => '');
  NN('playerpawn.getplayernetworkaddress', () => '');
  NN('levelinfo.getlocalurl', () => 'unreal://' + L().mapName);
  NN('levelinfo.getaddressurl', () => '');
  NN('gameinfo.getnetworknumber', () => '');
  NN('gameinfo.parsekillmessage', (s, [k, v, w, m]) => String(m));
  NN('pawn.checkvalidskinpackage', () => true);
  // ADecal AttachDecal: trace back along the rotation to a level surface, lay a square of the texture's size
  // there (oriented by DecalDir projected on the surface), and wrap it onto nearby surfaces less than ~45
  // degrees off (MultiDecalLevel^2 probe traces); the renderer clips it to the surfaces' polygons
  NN('decal.attachdecal', (s, [dist, dir]) => {
    if (!s.Texture) return null;
    const lvl = L(), m = lvl.model;
    if (!m) return null;
    const ml = Math.min(s.MultiDecalLevel | 0, 4);
    const fwd = rotV(s.Rotation), end = add(s.Location, mul(fwd, -(+dist || 0)));
    const surfAt = (a, b) => {
      const h = P().singleLineCheck(s, a, b, TRACE.Level, V());
      if (!h?.bsp || h.bsp.xf) return null;
      const node = bspNodeAt(h.bsp.model, h.bsp.item, h.bsp.loc, h.normal, 0, null);
      return node && node.iSurf >= 0 ? node.iSurf : null;
    };
    const pt = i => V(m.points[i * 3], m.points[i * 3 + 1], m.points[i * 3 + 2]), vc = i => V(m.vectors[i * 3], m.vectors[i * 3 + 1], m.vectors[i * 3 + 2]);
    const linePlane = (a, b, base, n) => { const d = sub(b, a), t = dot(sub(base, a), n) / dot(d, n); return add(a, mul(d, t)); };
    let D = dir && (dir.X || dir.Y || dir.Z) ? { ...dir } : null, rand = !D;
    if (rand) { const r = V(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1); D = norm(r); }
    const iSurf = surfAt(s.Location, end);
    if (iSurf === null) return null;
    const surf = m.surfs[iSurf], N = vc(surf.vNormal), base = pt(surf.pBase);
    if (!dot(fwd, N)) return null;
    if (surf.flags & 0x600) return null; // auto-panning surfaces take no decals
    const center = linePlane(s.Location, end, base, N);
    const tex = s.Texture, usize = tex.USize || tex.props?.USize || 64;
    const diag = Math.sqrt((s.DrawScale ?? 1) ** 2 * usize * usize / 2);
    let v0, v1;
    if (!rand) {
      const main = sub(D, mul(N, dot(D, N)));
      if (len(main) < 1e-4) { D = sub(base, center); rand = true; }
      else { const other = norm(V(main.Y * N.Z - main.Z * N.Y, main.Z * N.X - main.X * N.Z, main.X * N.Y - main.Y * N.X)), mn = norm(main); v0 = add(mn, other); v1 = sub(mn, other); }
    }
    if (rand) { v0 = sub(D, mul(N, dot(D, N))); v1 = V(v0.Y * N.Z - v0.Z * N.Y, v0.Z * N.X - v0.X * N.Z, v0.X * N.Y - v0.Y * N.X); }
    v0 = mul(norm(v0), diag); v1 = mul(norm(v1), diag);
    const main = [add(center, v0), add(center, v1), sub(center, v0), sub(center, v1)];
    const decals = [{ surf: iSurf, verts: main }], list = [iSurf];
    const nn = norm(N), tv = mul(nn, -50), xv = sub(main[1], main[0]), yv = sub(main[3], main[0]);
    for (let X = 0; X < ml; X++) for (let Y = 0; Y < ml; Y++) {
      const tp = add(main[0], add(mul(xv, (X + 1) / ml), mul(yv, (Y + 1) / ml)));
      const si = surfAt(sub(tp, tv), add(tp, tv));
      if (si === null || list.includes(si)) continue;
      const ss = m.surfs[si], sn = vc(ss.vNormal), sbase = pt(ss.pBase);
      if (ss.flags & 0x600) continue;
      const cos = dot(N, sn) / (len(N) * len(sn));
      if (Math.abs(cos) <= 0.7) continue;
      list.push(si);
      decals.push({ surf: si, verts: main.map(vj => {
        const a = linePlane(sub(vj, N), vj, sbase, sn), b = linePlane(sub(vj, sn), vj, sbase, sn);
        const x = len(sub(vj, b)) / cos, h = len(sub(vj, a)) / cos, ab = sub(b, a), l = len(ab);
        return l > 1e-6 ? sub(b, mul(ab, (h - x) / l)) : b;
      }) });
    }
    s.__decals = decals;
    s.__decalStamp = (s.__decalStamp || 0) + 1;
    return surf.texture ? vm.assetRef(lvl.pkg, surf.texture) : null;
  });
  NN('decal.detachdecal', s => { if (s.__decals) { s.__decals = null; s.__decalStamp = (s.__decalStamp || 0) + 1; } });

  // Stats / net: no-ops
  for (const n of ['statlog.logmutator', 'statlog.getmapfilename', 'statlog.initialcheck', 'statlog.getgmtref', 'statlog.executesilentlogbatcher', 'statlog.executeworldlogbatcher',
    'statlogfile.fileflush', 'statlogfile.filelog', 'statlogfile.getchecksum', 'statlogfile.watermark', 'statlogfile.openlog', 'statlogfile.closelog',
    'console.savetimedemo', 'internetlink.validate', 'tcplink.close']) NN(n, () => '');
  // WarpZoneInfo Warp / UnWarp (UnScript.cpp): through WarpCoords transposed (zone-local -> world) or as is
  // (world -> zone-local); the rotation's axes go the way of directions
  const warp = (s, loc, vel, rot, toWorld) => {
    const W = s.WarpCoords;
    if (!W) return;
    const ax = [W.XAxis, W.YAxis, W.ZAxis], O = W.Origin;
    const vec = v => toWorld
      ? { X: ax[0].X * v.X + ax[1].X * v.Y + ax[2].X * v.Z, Y: ax[0].Y * v.X + ax[1].Y * v.Y + ax[2].Y * v.Z, Z: ax[0].Z * v.X + ax[1].Z * v.Y + ax[2].Z * v.Z }
      : { X: dot(v, ax[0]), Y: dot(v, ax[1]), Z: dot(v, ax[2]) };
    const L = loc.get(), V0 = vel.get(), R0 = rot.get();
    loc.set(toWorld ? add(vec(L), O) : vec(sub(L, O)));
    vel.set(vec(V0));
    const A = rotAxes(R0), x = vec(A.X), y = vec(A.Y), z = vec(A.Z);
    const r = { Pitch: (Math.atan2(x.Z, Math.hypot(x.X, x.Y)) * 32768 / Math.PI) | 0, Yaw: (Math.atan2(x.Y, x.X) * 32768 / Math.PI) | 0, Roll: 0 };
    const ay = rotAxes(r).Y;
    r.Roll = (Math.atan2(dot(z, ay), dot(y, ay)) * 32768 / Math.PI) | 0;
    rot.set(r);
  };
  N(314, (s, [loc, vel, rot]) => warp(s, loc, vel, rot, true));
  N(315, (s, [loc, vel, rot]) => warp(s, loc, vel, rot, false));
}

function clampB(v) { return Math.max(0, Math.min(255, Math.round(v))); }
function eye(a) { return V(a.Location.X, a.Location.Y, a.Location.Z + (a.BaseEyeHeight || a.EyeHeight || 0)); }
function rotV(r) { const p = r.Pitch * RU, y = r.Yaw * RU; return V(Math.cos(p) * Math.cos(y), Math.cos(p) * Math.sin(y), Math.sin(p)); }
