// Input-only player bot: everything Harry does goes through engine.keyEvent / engine.mouse, exactly
// like a person at the keyboard. The bot may look at the world (positions, states) to decide what to press.
// The only cheat is god mode (Harry can't be hurt), applied by refilling his health each frame.
import { GridNav } from './gridnav.mjs';
import { closedGates } from './gatelib.mjs';
import { cylinderFloor, lineTrace } from '../../src/game/engine/collision.js';

const RU = Math.PI / 32768;
export const yawTo = (from, to) => Math.round(Math.atan2(to.Y - from.Y, to.X - from.X) / RU) & 65535;
export const yawDiff = (a, b) => ((((b - a) & 65535) + 32768) % 65536) - 32768;
export const dist2d = (a, b) => Math.hypot(a.X - b.X, a.Y - b.Y);

// drive a generator to completion synchronously and return its result
export function run(gen) { let r; do r = gen.next(); while (!r.done); return r.value; }

export function cutscenePlaying(eng) {
  return eng.level.actors.some(a => a.bPlaying && a.Class.isA('CutScene')) || !!eng.player?.__state?.name?.startsWith('Cut');
}

export class Bot {
  constructor(eng, opts = {}) {
    this.eng = eng;
    this.dt = opts.dt ?? 1 / 30;
    this.log = opts.log ?? (() => {});
    this.held = new Set();
    this.god = opts.god ?? true;
    this.headless = opts.headless ?? true; // in the browser the page's own loop renders the HUD
    this.time = 0;
  }
  get p() { return this.eng.player; }
  get L() { return this.eng.level; }

  // ---- raw input
  down(k) { if (!this.held.has(k)) { this.held.add(k); this.eng.keyEvent(k, 'press'); } }
  up(k) { if (this.held.has(k)) { this.held.delete(k); this.eng.keyEvent(k, 'release'); } }
  releaseAll() { for (const k of [...this.held]) this.up(k); }
  *tap(k, sec = 0.1) { this.down(k); (yield* this.wait(sec)); this.up(k); }
  mouse(dx, dy = 0) { this.eng.mouse.dx += dx; this.eng.mouse.dy += dy; }

  // ---- time. Every action is a generator that yields once per engine frame: run() drives it to the end
  // synchronously (tests), a browser driver steps it once per rendered frame (recordings).
  frame() {
    const e = this.eng;
    if (this.god && this.p && this.p.lifePotions !== undefined) this.p.lifePotions = Math.max(this.p.lifePotions, 100);
    e.tick(this.dt);
    if (this.headless) { e.preRender(960, 720); e.postRender(960, 720); }
    this.time += this.dt;
    return !!e.pendingTravel;
  }
  // one frame; true when the engine requested a level change
  *step() { const r = this.frame(); yield; return r; }
  *wait(sec, until) {
    for (let t = 0; t < sec; t += this.dt) { if ((yield* this.step())) return 'travel'; if (until?.()) return 'done'; }
    return 'timeout';
  }
  *waitCutscenes(max = 240) {
    this.releaseAll();
    for (let t = 0; t < max && this.busy(); t += this.dt) if ((yield* this.step())) return 'travel';
    return 'ok';
  }
  busy() { return cutscenePlaying(this.eng) || this.eng.hud?.bCutSceneMode || /^Cut/.test(this.p?.__state?.name || ''); }
  canMove() { return /PlayerWalking|playeraiming/i.test(this.p?.__state?.name || '') && !cutscenePlaying(this.eng); }

  // turn Harry with the mouse toward a yaw; one frame of input
  steer(yaw) {
    const err = yawDiff(this.p.Rotation.Yaw, yaw);
    this.mouse(Math.max(-60, Math.min(60, err / 25)));
    return Math.abs(err);
  }
  *face(target, maxSec = 2) {
    const yaw = typeof target === 'number' ? target : yawTo(this.p.Location, target.Location || target);
    for (let t = 0; t < maxSec; t += this.dt) { if (this.steer(yaw) < 600) return true; if ((yield* this.step())) return false; }
    return false;
  }

  // try to get free: face one of four directions, run and jump
  *unstick(k) {
    this.log(`  unstick ${k} at ${this.p.Location.X | 0},${this.p.Location.Y | 0},${(this.p.Location.Z - this.p.CollisionHeight) | 0}`);
    yield* this.face((this.p.Rotation.Yaw + 16384 * (k + 1)) & 65535, 1);
    this.down('Up');
    for (let t = 0; t < 1; t += this.dt) { if (t > 0.2 && t < 0.25 && (yield* this.tap('Space', this.dt)) === 'travel') return 'travel'; if (yield* this.step()) return 'travel'; }
    this.up('Up');
    return yield* this.wait(0.5);
  }

  // a touch-started cutscene counts as reached once it has started playing (it may move Harry elsewhere)
  cutsceneDone(g) {
    if (!g.Class?.isA('CutScene')) return false;
    if (g.bPlaying) g.__seenPlaying = true;
    return !!g.__seenPlaying || (g.bPlayOnce && g.bCanPlay === false);
  }

  // walk along a planned grid path to `goal` (actor or vector); returns 'arrived'|'travel'|'cutscene'|'stuck'|'nopath'
  *goTo(goal, { radius = 48, timeout = 120, until, nav } = {}) {
    const loc = () => goal.Location || goal;
    nav ??= new GridNav(this.eng);
    let plan = nav.plan(loc(), radius), wi = 1, lastPos = { ...this.p.Location }, stuckT = 0, replans = 0;
    // boxed in (on a ledge, wedged by a prop): hop around a bit like a player would, then plan again
    for (let k = 0; k < 4 && plan.path.length <= 1 && !plan.complete; k++) {
      if ((yield* this.unstick(k)) === 'travel') return 'travel';
      plan = nav.plan(loc(), radius);
    }
    this.log(`  goTo ${goal.Name || ''} path ${plan.path.length} complete=${plan.complete} expanded=${plan.expanded}`);
    for (let t = 0; t < timeout; t += this.dt) {
      if (until?.() || this.cutsceneDone(goal)) { this.up('Up'); return 'done'; }
      if (dist2d(this.p.Location, loc()) < radius && Math.abs(this.p.Location.Z - loc().Z) < 120) { this.up('Up'); return 'arrived'; }
      if (!this.canMove()) {
        this.up('Up');
        if (this.busy()) { this.cutsceneDone(goal); const r = (yield* this.waitCutscenes()); if (r === 'travel') return 'travel'; if (this.cutsceneDone(goal)) return 'done'; plan = nav.plan(loc(), radius); wi = 1; continue; }
        if ((yield* this.step())) return 'travel';
        continue;
      }
      const wp = plan.path[wi];
      if (wp !== this._lastWp) { this._lastWp = wp; if (wi > 2) replans = 0; /* reaching waypoints is progress */ if (this.verbose) this.log(`    wp ${wi}/${plan.path.length} ${wp ? `${wp.x},${wp.y},${wp.z | 0}${wp.climb ? ' climb' : ''}${wp.jump ? ` jump@${wp.jump.X},${wp.jump.Y} d${wp.jump.dx},${wp.jump.dy}` : ''}` : 'goal'} harry ${this.p.Location.X | 0},${this.p.Location.Y | 0},${(this.p.Location.Z - this.p.CollisionHeight) | 0} t=${this.time.toFixed(1)}`); }
      const target = wp ? { X: wp.x, Y: wp.y, Z: wp.z } : loc();
      if (wp && !wp.climb && dist2d(this.p.Location, target) < 20 && Math.abs(this.p.Location.Z - this.p.CollisionHeight - wp.z) < 30) { wi++; continue; }
      // climbing: run square-on into the wall once close; the engine's auto-mount does the rest
      // walk to the exact spot the climb starts from, then push square-on into the wall
      if (wp?.climb && wp.from && !wp._atFrom) { if (dist2d(this.p.Location, wp.from) < 6 || dist2d(this.p.Location, wp.landing) < 40) wp._atFrom = true; }
      const climbing = wp?.climb && (wp.from ? wp._atFrom : dist2d(this.p.Location, wp.landing) < 90);
      // jumping: from the run-up, run straight along the jump direction and press jump at the edge
      const jumping = wp?.jump && (dist2d(this.p.Location, wp.jump) < 40 || this.p.Physics === 2);
      const yaw = climbing ? yawTo({ X: 0, Y: 0 }, wp.climb) : jumping ? yawTo({ X: 0, Y: 0 }, { X: wp.jump.dx, Y: wp.jump.dy })
        : yawTo(this.p.Location, wp?.jump ? wp.jump : wp?.climb && wp.from ? wp.from : target);
      const err = this.steer(yaw);
      if (err < 9000) this.down('Up'); else this.up('Up');
      if (jumping && this.p.Physics === 1 && err < 1800 && this.edgeAhead()) (yield* this.tap('Space', this.dt));
      // ledge out of reach standing: jump at the wall and keep pushing so Harry grabs it in the air
      if (climbing && wp.jumpGrab && err < 1500 && this.p.Physics === 1 && Math.hypot(this.p.Velocity.X, this.p.Velocity.Y) < 40) (yield* this.tap('Space', this.dt));
      // landed on the far side: that's the waypoint done (don't hunt for the exact cell near an edge)
      if (wp?.jump && this.p.Physics === 1 && Math.abs(this.p.Location.Z - this.p.CollisionHeight - wp.z) < 20) {
        const l = Math.hypot(wp.jump.dx, wp.jump.dy), ux = wp.jump.dx / l, uy = wp.jump.dy / l;
        const along = (this.p.Location.X - wp.jump.X) * ux + (this.p.Location.Y - wp.jump.Y) * uy;
        const reach = (target.X - wp.jump.X) * ux + (target.Y - wp.jump.Y) * uy;
        if (along >= reach - 40) { wi++; continue; }
      }
      if (wp?.climb && Math.abs(this.p.Location.Z - (wp.z + this.p.CollisionHeight)) < 10 && dist2d(this.p.Location, wp.landing) < 40) { wi++; continue; }
      if ((yield* this.step())) return 'travel';
      // stuck handling: no progress toward the current waypoint for a while -> jump, then replan
      if (Math.floor(t * 2) !== Math.floor((t - this.dt) * 2)) {
        const d = dist2d(this.p.Location, target) + Math.abs(this.p.Location.Z - target.Z) * 0.5;
        if (this._bestD === undefined || wp !== this._progWp || d < this._bestD - 10) { this._bestD = d; this._progWp = wp; stuckT = 0; }
        else {
          stuckT++;
          if (this.verbose && stuckT % 2 === 0) this.log(`    no progress ${stuckT} at ${this.p.Location.X | 0},${this.p.Location.Y | 0},${(this.p.Location.Z - this.p.CollisionHeight) | 0} state ${this.p.__state?.name}`);
          if (stuckT === 3 || stuckT === 5) (yield* this.tap('Space', this.dt));
          if (stuckT >= 8) {
            if (++replans > 6) { this.up('Up'); return 'stuck'; }
            plan = nav.plan(loc(), radius); wi = 1; stuckT = 0; this._bestD = undefined;
            this.log(`  replan ${plan.path.length} complete=${plan.complete}`);
          }
        }
      }
      // used up an incomplete plan: plan again from here rather than heading blindly for the goal
      if (wi >= plan.path.length && !plan.complete) {
        const before = plan.path.at(-1);
        plan = nav.plan(loc(), radius); wi = 1;
        this.log(`  continue plan ${plan.path.length} complete=${plan.complete}`);
        if (plan.path.length <= 1 || (before && dist2d({ X: before.x, Y: before.y }, { X: plan.path.at(-1).x, Y: plan.path.at(-1).y }) < 30 && !plan.complete)) { this.up('Up'); return 'nopath'; }
      }
    }
    this.up('Up');
    return 'timeout';
  }

  // Reach `goal`, opening the way like a player: when no route exists, operate the nearest gate action not
  // tried yet (cast at a spell target / walk into a trigger) that can be reached, then try again.
  *goSolve(goal, opts = {}) {
    const tried = new Set(), succeeded = new Set(), movedFrom = new Map(), attempts = new Map();
    let r;
    for (let round = 0; round < (opts.rounds ?? 40); round++) {
      r = yield* this.goTo(goal, opts);
      if (['arrived', 'done', 'travel'].includes(r)) return r;
      const p = this.p.Location, seen = new Set();
      const acts = [];
      for (const g of closedGates(this.L)) for (const a of g.actions) {
        // characters that open things when hit (gnomes) take several hits: keep them repeatable
        const repeat = a.type === 'cast' && a.actor.Class.isA('Pawn');
        if (tried.has(a.actor) || (!repeat && succeeded.has(a.actor)) || seen.has(a.actor) || a.actor.__deleted || (attempts.get(a.actor) || 0) >= (repeat ? 8 : 3)) continue;
        seen.add(a.actor); acts.push({ ...a, door: g.door, movable: repeat });
      }
      // spell-movable things in the way (barrels, crates waiting for Flipendo) count as gates too
      // (they may move one station per spell, so they can be cast at again once they've moved)
      for (const a of this.L.actors) {
        if (a.__deleted || seen.has(a) || !a.bBlockPlayers || !((a.eVulnerableToSpell | 0) > 0) || a.Class.isA('spellTrigger')) continue;
        // props waiting for a spell, or spell-pushed grid blocks (GridMover with bProjTarget only moves when hit)
        const pushable = /waitforspell/i.test(a.__state?.name || '') || (a.Class.isA('GridMover') && a.bProjTarget && !a.bInterpolating);
        if (!pushable || Math.hypot(a.Location.X - p.X, a.Location.Y - p.Y) > 1500) continue;
        const last = movedFrom.get(a);
        if (last && last.n >= 6) continue;
        tried.delete(a); seen.add(a); acts.push({ type: 'cast', actor: a, door: a, movable: true });
      }
      acts.sort((x, y) => Math.hypot(x.actor.Location.X - p.X, x.actor.Location.Y - p.Y, (x.actor.Location.Z - p.Z) * 2) - Math.hypot(y.actor.Location.X - p.X, y.actor.Location.Y - p.Y, (y.actor.Location.Z - p.Z) * 2));
      this.log(`  solve round ${round}: ${r}; candidates ${acts.slice(0, 8).map(a => `${a.type}:${a.actor.Name}`).join(' ')}`);
      let did = false;
      for (const a of acts.slice(0, 8)) {
        tried.add(a.actor); attempts.set(a.actor, (attempts.get(a.actor) || 0) + 1);
        const before = { key: a.door.KeyNum | 0, state: a.actor.__state?.name, X: a.actor.Location.X, Y: a.actor.Location.Y };
        if (a.movable) movedFrom.set(a.actor, { X: a.actor.Location.X, Y: a.actor.Location.Y, n: (movedFrom.get(a.actor)?.n || 0) + 1 });
        this.log(`  solve: ${a.type} ${a.actor.Name} (opens ${a.door.Name}/${a.door.Tag})`);
        const out = a.type === 'cast' && a.actor.Class.isA('GridMover') ? yield* this.pushBlock(a.actor)
          : a.type === 'cast' ? yield* this.cast(a.actor, { tries: 2 })
          : yield* this.goTo(a.actor, { radius: Math.max(16, Math.min(a.actor.CollisionRadius || 20, 60)), timeout: 180 });
        if (out === 'travel') return out;
        yield* this.wait(1.5); // let the door/bridge move
        // did it actually do something? (door moving/opened, the target moved or changed state)
        let effect = (a.door.KeyNum | 0) !== before.key || a.door.bInterpolating || a.actor.__state?.name !== before.state
          || Math.hypot(a.actor.Location.X - before.X, a.actor.Location.Y - before.Y) > 20 || a.actor.__deleted;
        // locked on but nothing happened (the spell hit something on the way): step in closer and try once more
        if (!effect && out === 'done' && a.type === 'cast' && !a.actor.Class.isA('GridMover')) {
          this.log(`    no effect, retrying closer`);
          const again = yield* this.cast(a.actor, { tries: 1, range: 140 });
          if (again === 'travel') return again;
          yield* this.wait(1.5);
        }
        effect = (a.door.KeyNum | 0) !== before.key || a.door.bInterpolating || a.actor.__state?.name !== before.state
          || Math.hypot(a.actor.Location.X - before.X, a.actor.Location.Y - before.Y) > 20 || a.actor.__deleted;
        this.log(`    -> ${out}${effect ? ' (effect)' : ' (no effect)'}; ${a.door.Name} key ${a.door.KeyNum | 0}; harry ${this.p.Location.X | 0},${this.p.Location.Y | 0},${(this.p.Location.Z - this.p.CollisionHeight) | 0}`);
        if ((out === 'done' || out === 'arrived') && (effect || a.type === 'touch')) {
          did = true;
          if (!a.movable) succeeded.add(a.actor); // don't flip a switch back
          tried.clear();                          // the level changed: earlier failures may work now
          yield* this.waitCutscenes(); break;
        }
      }
      if (!did) return r;
    }
    return r;
  }

  // pick up items: walk to the nearest remaining one until `done()`; unreachable ones are skipped
  *collect(filter, done, timeout = 900) {
    const skip = new Set(), t0 = this.time;
    while (!done() && this.time - t0 < timeout) {
      const items = this.L.actors.filter(a => !a.__deleted && !skip.has(a) && filter(a));
      if (!items.length) return 'none-left';
      const p = this.p.Location;
      items.sort((a, b) => (Math.hypot(a.Location.X - p.X, a.Location.Y - p.Y) + Math.abs(a.Location.Z - p.Z) * 2) - (Math.hypot(b.Location.X - p.X, b.Location.Y - p.Y) + Math.abs(b.Location.Z - p.Z) * 2));
      const it = items[0];
      // jellybeans are collected when Harry gets within 60 units of them (jellybean.uc), no touch needed
      const r = yield* this.goTo(it, { radius: 30, timeout: 60, until: () => it.__deleted || done() });
      if (r === 'travel') return 'travel';
      if (!it.__deleted) { skip.add(it); this.log(`  skip ${it.Name} (${r})`); }
    }
    return done() ? 'done' : 'timeout';
  }

  // walk into a character (bump): e.g. to buy from a merchant
  *bump(a) {
    const r = (yield* this.goTo(a, { radius: a.CollisionRadius + this.p.CollisionRadius + 20, timeout: 400 }));
    this.log(`  bump approach ${r}: ${a.Name} at ${a.Location.X | 0},${a.Location.Y | 0},${a.Location.Z | 0} state ${a.__state?.name}, harry ${this.p.Location.X | 0},${this.p.Location.Y | 0},${this.p.Location.Z | 0}`);
    if (r === 'travel') return r;
    if (r !== 'arrived' && r !== 'done') return r;
    for (let t = 0; t < 1.5; t += this.dt) {
      this.steer(yawTo(this.p.Location, a.Location)); this.down('Up');
      if ((yield* this.step())) return 'travel';
      if (this.busy()) break;
    }
    this.up('Up');
    return this.busy() ? 'done' : 'ok';
  }

  // spell lesson: wait for the drawing phase, then trace the template with the mouse while holding the button
  *lesson(t, timeout = 400) {
    if (!t) return 'missing';
    let held = false, idx = 0;
    for (let s = 0; s < timeout && !t.__deleted; s += this.dt) {
      if (t.__state?.name === 'Draw') {
        const pts = (t.SpellGesture?.Points || []).filter(x => x);
        const tgt = pts[Math.min(pts.length - 1, idx)];
        const dx = tgt.X - (t.WandX + 0.5), dy = tgt.Y - (0.5 - t.WandY);
        if (Math.hypot(dx, dy) < 0.02) idx++;
        this.down('LeftMouse'); held = true;
        this.mouse(Math.max(-25, Math.min(25, dx * 900)), Math.max(-25, Math.min(25, dy * 900)));
      } else if (held) { this.up('LeftMouse'); held = false; idx = 0; }
      if ((yield* this.step())) return 'travel';
    }
    this.up('LeftMouse');
    return t.__deleted ? 'done' : 'timeout';
  }

  // no floor just in front of Harry's feet (the moment a player presses jump at a ledge)
  edgeAhead() {
    const p = this.p, y = p.Rotation.Yaw * RU, d = p.CollisionRadius + 6;
    const feet = p.Location.Z - p.CollisionHeight;
    return !cylinderFloor(this.L.world, p.Location.X + Math.cos(y) * d, p.Location.Y + Math.sin(y) * d, 3, feet - 30, feet + 10);
  }

  // Cast at `target` like a player: get within range with a clear view, hold the cast button (aim), steer
  // the crosshair onto it with the mouse (yaw by turning, pitch by moving the mouse up/down) until the wand
  // locks on, then release. The wand picks the spell the target needs.
  *cast(target, { tries = 3, range = 300 } = {}) {
    for (let k = 0; k < tries; k++) {
      if (!this.canSee(target) || dist2d(this.p.Location, target.Location) > range) {
        // no clear line where the walk ended (a wall corner in between): come closer and look again
        for (const rad of [range * 0.6, range * 0.3, 70]) {
          const r = yield* this.goTo(target, { radius: rad, timeout: 240, until: () => this.canSee(target) && dist2d(this.p.Location, target.Location) < range * 0.8 });
          if (r === 'travel') return r;
          if (this.canSee(target) || (r !== 'arrived' && r !== 'done')) break;
        }
        if (!this.canSee(target) || dist2d(this.p.Location, target.Location) > range) return 'unreachable';
      }
      yield* this.face(target, 2);
      this.down('LeftMouse');
      let locked = 0;
      for (let t = 0; t < 4 && locked < 6; t += this.dt) {
        const rt = this.p.rectarget;
        this.steer(yawTo(this.p.Location, target.Location));
        if (rt) {
          this._lastVictim = rt.Victim;
          const d = { X: target.Location.X - this.p.Location.X, Y: target.Location.Y - this.p.Location.Y, Z: target.Location.Z - this.p.Location.Z };
          const want = Math.atan2(d.Z, Math.hypot(d.X, d.Y)) / RU;
          const err = want - (rt.TargetPitch || 0);
          if (Math.abs(err) > 300) this.mouse(0, -Math.max(-12, Math.min(12, err / 40)));
          locked = rt.Victim === target ? locked + 1 : 0;
        }
        if (yield* this.step()) return 'travel';
      }
      this.up('LeftMouse');
      const before = target.__state?.name;
      for (let t = 0; t < 2.5; t += this.dt) if (yield* this.step()) return 'travel';
      if (locked >= 6) return 'done';
      const rt = this.p.rectarget, d = { X: target.Location.X - this.p.Location.X, Y: target.Location.Y - this.p.Location.Y, Z: target.Location.Z - this.p.Location.Z };
      this.log(`  cast at ${target.Name}: no lock (try ${k + 1}) dist ${Math.hypot(d.X, d.Y, d.Z) | 0} see ${this.canSee(target)} wantPitch ${(Math.atan2(d.Z, Math.hypot(d.X, d.Y)) / RU) | 0} harry ${this.p.Location.X | 0},${this.p.Location.Y | 0},${this.p.Location.Z | 0} state ${this.p.__state?.name} lastVictim ${this._lastVictim?.Name}`);
    }
    return 'nolock';
  }

  // clear line of fire to `a`: centre and both sides of a spell-sized tube must be free of level geometry
  // Flipendo a grid block from the floor beside it (not from on top): try each side, nearest first
  *pushBlock(m) {
    const r = (m.CollisionRadius || 48) + 50, base = m.Location.Z - (m.CollisionHeight || 48);
    const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => ({ X: m.Location.X + dx * r, Y: m.Location.Y + dy * r, Z: base + this.p.CollisionHeight }));
    sides.sort((a, b) => dist2d(a, this.p.Location) - dist2d(b, this.p.Location));
    const start = { X: m.Location.X, Y: m.Location.Y };
    for (const spot of sides) {
      const g = yield* this.goTo(spot, { radius: 20, timeout: 60 });
      if (g === 'travel') return g;
      if (g !== 'arrived' || this.p.Location.Z - this.p.CollisionHeight > base + 20) continue; // not beside it on the floor
      const c = yield* this.cast(m, { tries: 2, range: 240 });
      if (c === 'travel') return c;
      if (Math.hypot(m.Location.X - start.X, m.Location.Y - start.Y) > 20 || m.bInterpolating) return 'done';
    }
    return 'unreachable';
  }

  canSee(a) {
    const p = this.p.Location, t = a.Location;
    const dx = t.X - p.X, dy = t.Y - p.Y, l = Math.hypot(dx, dy) || 1, ox = -dy / l * 10, oy = dx / l * 10;
    for (const s of [0, 1, -1]) {
      if (lineTrace(this.L.world, { X: p.X + ox * s, Y: p.Y + oy * s, Z: p.Z + 20 }, { X: t.X + ox * s, Y: t.Y + oy * s, Z: t.Z })) return false;
    }
    return true;
  }
}
