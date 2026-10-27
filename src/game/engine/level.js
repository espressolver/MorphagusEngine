// Runtime level: actor lifecycle, ticking, zones, touching. Unreal coordinates throughout.
import { readLevel, readModel } from '../../engine/umodel.js';
import { TriMesh } from './collision.js';
import { Physics } from './physics.js';
import { AnimSystem } from './anim.js';
import { ParticleSim } from './particles.js';
import { NavGraph } from './nav.js';
import { PawnSense } from './pawn.js';
import { validateShape } from './shapes.js';
import { Interpolation } from './interp.js';
import { appRound } from '../../uscript/natives_core.js';

// a PlayerPawn driven by a viewport (UE1 GetPlayerPawn); some scripts have their own variable named Player
const isPlayerPawn = a => !!a.Player && (a.__isPP ??= a.Class.isA('PlayerPawn'));

export class GameLevel {
  constructor(engine, mapName) {
    this.engine = engine;
    this.vm = engine.vm;
    this.mapName = mapName;
    this.actors = [];
    this.destroyed = [];
    this.timeSeconds = 0;
    this.physics = new Physics(this);
    this.anim = new AnimSystem(this);
    this.particles = new ParticleSim(this);
    this.pawns = new PawnSense(this);
    this.interp = new Interpolation(this);
    this.listeners = { spawn: [], destroy: [] };
  }

  // ------------------------------------------------------------------ load
  async load() {
    const { vm, engine } = this;
    const assets = vm.assets;
    const pkg = await assets.pkg(this.mapName);
    if (!pkg) throw new Error('map not found ' + this.mapName);
    this.pkg = pkg;
    await assets.preloadDeps(pkg);
    await vm.table.loadPackage(this.mapName);
    for (const im of pkg.imports) if (im.package === 0 && im.className === 'Package') {
      const p = assets.loaded.get(im.name.toLowerCase());
      if (p && p.exports.some(e => e.className === 'Class')) await vm.table.loadPackage(im.name);
    }
    const levelExp = pkg.exports.find(e => e.className === 'Level');
    const L = readLevel(pkg, levelExp);
    this.url = L.url;
    this.levelModelRef = L.model;
    this.model = readModel(pkg, pkg.exports[L.model - 1]);
    this.buildCollision();

    // XLevel placeholder object
    this.xlevel = { __isUObject: true, __native: 'Level', Name: 'MyLevel', toString: () => this.mapName + '.MyLevel' };

    // pass 1: create objects
    const objMap = new Map();
    vm.levelObjects = objMap;
    const pending = [];
    for (const ref of L.actors) {
      if (!ref) continue;
      const exp = pkg.exports[ref - 1];
      // one object per export: some maps (Tut3b) list the same actor twice in Level.Actors
      if (objMap.has(exp)) continue;
      // UnrealEd saves its viewport cameras into maps; the game removes them on load
      if (exp.className === 'Camera') continue;
      const cls = vm.cls(exp.className);
      if (!cls) { vm.warnOnce('nocls' + exp.className, 'unknown actor class', exp.className); continue; }
      const o = vm.newObject(cls, exp.name);
      o.__path = this.mapName + '.' + exp.name;
      o.__exp = exp;
      objMap.set(exp, o);
      pending.push(o);
    }
    // pass 2: apply serialized properties
    for (const o of pending) vm.applyExportProps(o, pkg, o.__exp);
    this.levelInfo = pending.find(o => o.Class.isA('LevelInfo'));
    for (const o of pending) {
      o.Level = this.levelInfo;
      o.XLevel = this.xlevel;
      this.actors.push(o);
    }
    this.zoneActors = this.model.zones.map(z => z.zoneActor ? objMap.get(pkg.exports[z.zoneActor - 1]) || null : null);
    vm.levelObjects = null;
    this.objMap = objMap;
    // Pawn list / navigation point list
    this.levelInfo.PawnList = null;
    // brush collision for movers
    for (const a of this.actors) if (a.Class.isA('Mover')) this.physics.setupMover(a);
    // navigation graph
    this.nav = new NavGraph(this, L.reachSpecs);
    this.engine.nav = this.nav;
  }

  buildCollision() {
    const m = this.model;
    const tris = [], norms = [], flags = [];
    const PF_NotSolid = 0x8, PF_Portal = 0x4000000;
    for (const node of m.nodes) {
      if (node.numVertices < 3 || node.iSurf < 0) continue;
      const surf = m.surfs[node.iSurf];
      if (surf.flags & (PF_NotSolid | PF_Portal)) continue;
      const pts = [];
      for (let k = 0; k < node.numVertices; k++) {
        const pi = m.verts[node.iVertPool + k].pVertex * 3;
        pts.push([m.points[pi], m.points[pi + 1], m.points[pi + 2]]);
      }
      const n = [m.vectors[surf.vNormal * 3], m.vectors[surf.vNormal * 3 + 1], m.vectors[surf.vNormal * 3 + 2]];
      for (let k = 1; k + 1 < pts.length; k++) {
        tris.push(...pts[0], ...pts[k], ...pts[k + 1]);
        norms.push(...n);
        flags.push(surf.flags >>> 0);
      }
    }
    this.world = new TriMesh(new Float32Array(tris), new Float32Array(norms));
    this.world.flags = new Uint32Array(flags); // surface PolyFlags per triangle (PF_SpecialPoly = climbable)
  }

  // ------------------------------------------------------------------ zones
  zoneNumberAt(x, y, z) {
    const nodes = this.model.nodes;
    if (!nodes.length) return 0;
    let i = 0;
    for (let g = 0; g < 4096; g++) {
      const n = nodes[i];
      const d = n.plane[0] * x + n.plane[1] * y + n.plane[2] * z - n.plane[3];
      const front = d >= 0;
      const next = front ? n.iFront : n.iBack;
      if (next <= 0) return n.iZone[front ? 1 : 0];
      i = next;
    }
    return 0;
  }
  zoneInfoAt(loc) {
    const zn = this.zoneNumberAt(loc.X, loc.Y, loc.Z);
    return { zone: this.zoneActors[zn] || this.levelInfo, number: zn };
  }

  // UE1 ULevel::SetActorZone: the old zone hears ActorLeaving and the actor ZoneChange while it is still in the
  // old zone, then the new zone ActorEntered; pawns also track foot/head zones. A forced refresh starts from
  // the LevelInfo (so a new actor hears about its first real zone).
  setActorZone(a, test = false, force = false) {
    if (!a.Location || a.__deleted) return;
    const LI = this.levelInfo;
    if (a === LI) { a.Region = { Zone: LI, iLeaf: -1, ZoneNumber: 0 }; return; }
    const pawn = a.__isPawn ?? (a.__isPawn = a.Class.isA('Pawn'));
    const none = () => ({ Zone: LI, iLeaf: -1, ZoneNumber: 0 });
    if (force || !a.Region?.Zone) { a.Region = none(); if (pawn) { a.FootRegion = none(); a.HeadRegion = none(); } }
    const { zone, number } = this.zoneInfoAt(a.Location);
    const nr = { Zone: zone, iLeaf: -1, ZoneNumber: number };
    if (zone !== a.Region.Zone) {
      if (!test) {
        this.vm.event(a.Region.Zone, 'ActorLeaving', a);
        this.vm.event(a, 'ZoneChange', zone);
      }
      a.Region = nr;
      if (!test) this.vm.event(a.Region.Zone, 'ActorEntered', a);
    } else a.Region = nr;
    if (pawn && !a.__deleted) {
      const at = dz => { const r = this.zoneInfoAt({ X: a.Location.X, Y: a.Location.Y, Z: a.Location.Z + dz }); return { Zone: r.zone, iLeaf: -1, ZoneNumber: r.number }; };
      const f = at(-(a.CollisionHeight || 0));
      if (f.Zone !== a.FootRegion?.Zone && !test) this.vm.event(a, 'FootZoneChange', f.Zone);
      a.FootRegion = f;
      const h = at(a.EyeHeight || 0);
      if (h.Zone !== a.HeadRegion?.Zone && !test) this.vm.event(a, 'HeadZoneChange', h.Zone);
      a.HeadRegion = h;
    }
  }

  // ------------------------------------------------------------------ startup
  beginPlay(options = '') {
    const { vm } = this;
    const LI = this.levelInfo;
    LI.TimeSeconds = 0;
    LI.TimeDilation = LI.TimeDilation || 1;
    LI.NetMode = 0; // NM_Standalone
    LI.bBegunPlay = true;
    LI.bStartup = true;
    // Game info
    const gameClassName = (LI.DefaultGameType && LI.DefaultGameType.name) || this.engine.defaultGame || 'GameInfo';
    const gameCls = LI.DefaultGameType && LI.DefaultGameType.__isClass ? LI.DefaultGameType : vm.cls(gameClassName);
    for (const a of this.actors) { a.__touching = new Set(); a.__tslots = null; }
    for (const a of this.actors) validateShape(a); // AActor::PostLoad: CT_Shape collision size from the mesh
    // GameInfo is spawned like any actor (gets Pre/Begin/PostBeginPlay -> creates BaseMutator)
    // UE1 LoadMap: GameInfo is created before play begins (no spawn events); it receives
    // PreBeginPlay etc. together with all other actors after InitGame.
    this.game = this.spawn(gameCls, null, null, { X: 0, Y: 0, Z: 0 }, { Pitch: 0, Yaw: 0, Roll: 0 }, { force: true, noInit: true });
    LI.Game = this.game;
    // InitGame
    const err = { __ref: true, v: '', get() { return this.v; }, set(x) { this.v = x; } };
    vm.event(this.game, 'InitGame', options, err);
    const list = this.actors.slice(); // actors spawned during startup get their own events
    for (const a of list) if (!a.__deleted) vm.event(a, 'PreBeginPlay');
    for (const a of list) if (!a.__deleted) vm.event(a, 'BeginPlay');
    for (const a of list) if (!a.__deleted) this.setActorZone(a, true, true);
    for (const a of list) if (!a.__deleted) vm.event(a, 'PostBeginPlay');
    for (const a of list) if (!a.__deleted) this.setInitialState(a);
    // bases: an AttachTag puts the actor on the first actor with that Tag; resting props/pawns find their floor
    for (const a of this.actors) {
      if (a.__deleted) continue;
      if (a.AttachTag && a.AttachTag !== 'None' && !a.__moverMesh) { // (Mover has its own AttachTag for its slaves)
        const t = a.AttachTag.toLowerCase(), b = this.actors.find(b => !b.__deleted && b.Tag && b.Tag.toLowerCase() === t);
        if (b) this.physics.setBase(a, b, false);
      } else if (this.restsOnBase(a)) {
        this.physics.findBase(a);
        if (a.Base === LI) this.physics.setBase(a, null, false);
      }
    }
    LI.bStartup = false;
    this.cleanupDestroyed();
  }

  setInitialState(a) {
    const vm = this.vm;
    if (vm.findFunction(a, 'setinitialstate')) vm.event(a, 'SetInitialState');
    else this.defaultInitialState(a);
  }
  defaultInitialState(a) {
    const vm = this.vm;
    const init = a.InitialState && a.InitialState !== 'None' ? a.InitialState : null;
    if (init) vm.gotoState(a, init);
    else {
      // auto state
      if (a.Class.autoState) vm.gotoState(a, a.Class.autoState.name);
    }
  }

  // ------------------------------------------------------------------ spawn/destroy
  // UE1 SpawnActor: refuses abstract and static/no-delete classes and actors that don't fit at the spot
  // (FindSpot for world-colliding classes); Spawned, PreBeginPlay, BeginPlay, zone, PostBeginPlay, then an
  // encroachment check that may destroy it again, SetInitialState and the base of resting props/pawns.
  // opts: force (engine spawns of static classes), noFit (skip placement and encroachment), noInit
  spawn(cls, owner, tag, loc, rot, opts = {}) {
    const vm = this.vm;
    if (!cls) return null;
    if (!cls.linked) vm.table.link(cls);
    if (!opts.force) {
      if (cls.flags & 1) { vm.warnOnce('spawnabstract' + cls.name, 'spawn of abstract class', cls.name); return null; }
      if (cls.defaults.bStatic || cls.defaults.bNoDelete) { vm.warnOnce('spawnstatic' + cls.name, 'spawn of static class', cls.name); return null; }
    }
    let at = loc ? { X: loc.X, Y: loc.Y, Z: loc.Z } : { X: 0, Y: 0, Z: 0 };
    const d = cls.defaults;
    if ((d.bCollideWorld || d.bCollideWhenPlacing) && !opts.noFit) {
      const ext = { X: d.CollisionRadius || 0, Y: d.CollisionRadius || 0, Z: d.CollisionHeight || 0 };
      const fit = this.physics.findSpot(ext, at, true);
      if (!fit) { if (!opts.force) return null; } else at = fit;
    }
    const a = vm.newObject(cls);
    a.Name = cls.name + (this.actors.length + this.destroyed.length);
    a.__path = this.mapName + '.' + a.Name;
    a.Level = this.levelInfo;
    a.XLevel = this.xlevel;
    a.Location = at;
    a.Rotation = rot ? { ...rot } : { Pitch: 0, Yaw: 0, Roll: 0 };
    a.OldLocation = { ...a.Location };
    a.Tag = tag == null ? cls.name : tag; // script spawns pass their tag (None by default)
    a.__touching = new Set(); a.__tslots = null;
    this.actors.push(a);
    a.TimeSeconds = 0;
    if (owner) this.setOwner(a, owner);
    a.Instigator = opts.instigator !== undefined ? opts.instigator : (owner?.Class.isA('Pawn') ? owner : owner?.Instigator ?? null);
    if (opts.noInit) return a;
    return this.initSpawned(a, opts);
  }

  initSpawned(a, opts = {}) {
    const vm = this.vm;
    this.setActorZone(a, true);
    validateShape(a); // AActor::Spawned
    vm.event(a, 'Spawned');
    vm.event(a, 'PreBeginPlay');
    vm.event(a, 'BeginPlay');
    if (a.__deleted) return null;
    this.setActorZone(a, a === this.levelInfo, true);
    vm.event(a, 'PostBeginPlay');
    if (a.__deleted) return null;
    if (!opts.noFit) {
      a.__unhashed = true;
      const refused = this.physics.checkEncroachment(a, a.Location, a.Rotation, false);
      a.__unhashed = false;
      if (refused) { this.destroy(a); return null; }
    }
    this.setInitialState(a);
    if (a.__deleted) return null;
    if (this.restsOnBase(a)) this.physics.findBase(a);
    for (const l of this.listeners.spawn) l(a);
    return a;
  }
  // props, pickups and pawns that are placed (not moving under physics) find what they stand on
  restsOnBase(a) {
    return !a.__deleted && !a.Base && a.bCollideWorld && (a.Physics === 0 || a.Physics === 5)
      && (a.Class.isA('Decoration') || a.Class.isA('Inventory') || a.Class.isA('Pawn'));
  }

  setOwner(a, owner) {
    owner = owner || null;
    if (a.Owner && !a.Owner.__deleted) this.vm.event(a.Owner, 'LostChild', a);
    a.Owner = owner;
    if (owner) this.vm.event(owner, 'GainedChild', a);
    if (!owner) a.AnimBone = 0;
  }

  // UE1 DestroyActor: EndState, off its base (and its riders off it), out of collision, Destroyed, owned
  // actors disowned / touchers untouched, LostChild on the owner; then it is gone
  destroy(a) {
    if (!a || a.__deleted || a.bDeleteMe) return true;
    if (a.__destroying) return true;
    const vm = this.vm, P = this.physics;
    if ((a.bStatic || a.bNoDelete) && !this.engine.allowStaticDestroy) return false;
    a.__destroying = true;
    const gone = () => a.__deleted;
    if (a.__state && vm.findFunction(a, 'endstate') && P.isProbing(a, 'EndState')) { vm.event(a, 'EndState'); if (gone()) return true; }
    if (a.Base) { P.setBase(a, null); if (gone()) return true; }
    for (const o of this.actors) if (o.Base === a && !o.__deleted) P.setBase(o, null);
    a.__unhashed = true;
    vm.event(a, 'Destroyed');
    if (gone()) return true;
    for (const o of this.actors) {
      if (o === a || o.__deleted) continue;
      if (o.Owner === a) { this.setOwner(o, null); if (gone()) return true; }
      else if (P.touchSlots(o).includes(a)) { P.endTouch(a, o, true); if (gone()) return true; }
    }
    if (a.Owner && !a.Owner.__deleted) { vm.event(a.Owner, 'LostChild', a); if (gone()) return true; }
    a.__deleted = true;
    a.bDeleteMe = true;
    this.destroyed.push(a);
    a.__latent = null; a.__stateFrame = null;
    for (const l of this.listeners.destroy) l(a);
    return true;
  }

  cleanupDestroyed() {
    if (!this.destroyed.length) return;
    const dead = new Set(this.destroyed);
    this.actors = this.actors.filter(a => !dead.has(a));
    // null out references to destroyed actors
    for (const a of this.actors) {
      for (const k in a) {
        const v = a[k];
        if (v && typeof v === 'object') {
          if (v.__isUObject && dead.has(v)) a[k] = null;
          else if (Array.isArray(v)) for (let i = 0; i < v.length; i++) if (v[i] && dead.has(v[i])) v[i] = null;
        }
      }
    }
    for (const c of this.engine.extraObjects || []) for (const k in c) { const v = c[k]; if (v && v.__isUObject && dead.has(v)) c[k] = null; }
    // pawn list fix-up
    let prev = null;
    for (let p = this.levelInfo.PawnList; p; p = p.nextPawn) {
      if (dead.has(p)) { if (prev) prev.nextPawn = p.nextPawn; else this.levelInfo.PawnList = p.nextPawn; }
      else prev = p;
    }
    this.destroyed.length = 0;
  }

  // ------------------------------------------------------------------ tick
  // UE1 ULevel::Tick: frame time clamped to 10..200 fps and scaled by TimeDilation; non-static actors tick
  // in list order (owners before what they own), actors spawned during the tick tick in it too. While paused
  // only the player reads input and bAlwaysTick actors run; bPlayersOnly ticks the rest for animation only.
  tick(dt) {
    const LI = this.levelInfo;
    dt = Math.min(0.1, Math.max(0.005, dt)) * (LI.TimeDilation || 1);
    this.timeSeconds += dt;
    LI.TimeSeconds = this.timeSeconds;
    this.vm.time = this.timeSeconds;
    this.frame = (this.frame || 0) + 1;
    if (LI.Pauser && LI.Pauser !== '') {
      for (const a of this.actors.slice()) {
        if (a.__deleted || a.bStatic) continue;
        if (isPlayerPawn(a)) { this.engine.playerTick(a, dt); for (const p of a.Class.props) if ((p.flags & 0x4) && p.kind === 'FloatProperty') a[p.name] = 0; }
        else if (a.bAlwaysTick) this.tickActor(a, dt, false);
      }
    } else {
      const playersOnly = !!LI.bPlayersOnly;
      let list = this.actors.slice();
      while (list.length) {
        const n = this.actors.length;
        for (const a of list) if (!a.__deleted && !a.bStatic) this.tickActor(a, dt, playersOnly);
        list = this.actors.slice(n).filter(a => a.__tickFrame !== this.frame);
      }
    }
    this.cleanupDestroyed();
    // UE1 ULevel::Tick: perform pending server travel requested by script (LevelInfo.ServerTravel)
    if (LI.NextURL) {
      LI.NextSwitchCountdown = (LI.NextSwitchCountdown || 0) - dt;
      if (LI.NextSwitchCountdown <= 0) {
        const url = LI.NextURL;
        LI.NextURL = '';
        this.engine.travel(url, !!LI.bNextItems);
      }
    }
  }

  // UE1 AActor::Tick: owner first; animation; Tick (or the player's input and PlayerTick); state code and
  // latent actions; timer; LifeSpan; physics; pawn sight and timers; root motion
  tickActor(a, dt, playersOnly = false) {
    const vm = this.vm;
    if (a.Owner && !a.Owner.__deleted && a.Owner.__tickFrame !== this.frame && !a.Owner.bStatic) this.tickActor(a.Owner, dt, playersOnly);
    if (a.__tickFrame === this.frame || a.__deleted) return;
    a.__tickFrame = this.frame;
    this.anim.tick(a, dt);
    if (a.__deleted) return;
    if (!isPlayerPawn(a)) {
      if (playersOnly) return;
      vm.event(a, 'Tick', dt);
    } else this.engine.playerTick(a, dt);
    if (a.__deleted) return;
    this.processLatent(a, dt);
    if (a.__deleted) return;
    vm.runState(a);
    if (a.__deleted) return;
    if (a.TimerRate > 0 && (a.TimerCounter = (a.TimerCounter || 0) + dt) >= a.TimerRate) {
      const n = appRound(a.TimerCounter / a.TimerRate);
      a.TimerCounter -= a.TimerRate * n;
      if (n && !a.bTimerLoop) a.TimerRate = 0;
      vm.event(a, 'Timer');
      if (a.__deleted) return;
    }
    if (a.LifeSpan) {
      a.LifeSpan -= dt;
      if (a.LifeSpan <= 0.0001) { vm.event(a, 'Expired'); this.destroy(a); return; }
    }
    // physics (players run AutonomousPhysics from script)
    if (a.Physics && this.interp.isManager(a)) this.interp.perform(a, dt); // native InterpolationManager physics
    else if (a.Physics && (!isPlayerPawn(a) || !this.engine.playerRanPhysics)) this.physics.perform(a, dt);
    if (a.__deleted) return;
    if (a.__isPawn ?? (a.__isPawn = a.Class.isA('Pawn'))) { this.pawns.tick(a, dt, playersOnly); if (a.__deleted) return; }
    if (a.bAnimMove) this.anim.rootMove(a);
    // native particle systems
    if (a.__isParticleFX ?? (a.__isParticleFX = a.Class.isA('ParticleFX'))) this.particles.update(a, dt);
  }

  processLatent(a, dt) {
    const L = a.__latent;
    if (!L) return;
    switch (L.kind) {
      case 'sleep':
        L.t -= dt;
        if (L.t < 0.5 * dt) a.__latent = null; // UE1 wakes within half a frame of the time
        break;
      case 'finishanim':
        if (this.anim.finishAnimDone(L.chan && !L.chan.__deleted ? L.chan : a)) a.__latent = null;
        break;
      case 'finishinterp':
        if (!a.bInterpolating) a.__latent = null;
        break;
      case 'ai':
        if (this.pawns.pollMove(a, L.ai)) a.__latent = null;
        break;
      case 'waitlanding':
        if (a.Physics !== 2) a.__latent = null;
        else if ((a.LatentFloat = (a.LatentFloat ?? 2.5) - dt) < 0) this.vm.event(a, 'LongFall');
        break;
      default:
        a.__latent = null;
    }
  }

  // ------------------------------------------------------------------ queries
  allActors(cls, tag) {
    const out = [];
    const ltag = tag && tag !== 'None' ? tag.toLowerCase() : null;
    for (const a of this.actors) {
      if (a.__deleted) continue;
      if (cls && !a.Class.isChildOf(cls)) continue;
      if (ltag && (!a.Tag || a.Tag.toLowerCase() !== ltag)) continue;
      out.push(a);
    }
    return out;
  }
}
