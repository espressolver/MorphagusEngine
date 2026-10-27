// Debug support: an issue log that records where (map, level time, object, location) each script error,
// Accessed None or warning happened, and snapshots of the game state (player, camera, nearby actors, a
// focused actor with all its properties, recent issues, a URL that loads the same spot).

const MAX_ISSUES = 500;
const r1 = v => Math.round(v * 10) / 10;
const vec = v => (v ? { X: r1(v.X), Y: r1(v.Y), Z: r1(v.Z) } : null);
const rot = r => (r ? { Pitch: r.Pitch | 0, Yaw: r.Yaw | 0, Roll: r.Roll | 0 } : null);

// short identity of an actor or object
export function who(o) {
  if (!o || typeof o !== 'object') return null;
  if (o.__asset || o.__isAsset) return { asset: o.__path || o.Name };
  const out = { name: o.Name, class: o.Class?.name };
  if (o.Location) out.loc = vec(o.Location);
  const st = o.__state?.name;
  if (st) out.state = st;
  if (o.__deleted) out.deleted = true;
  return out;
}

// a property value in JSON form (objects by identity, arrays and structs shallow)
function plain(v, depth = 0) {
  if (v === null || v === undefined) return v ?? null;
  if (typeof v === 'number') return Number.isFinite(v) ? r1(v) === v ? v : Math.round(v * 1000) / 1000 : String(v);
  if (typeof v !== 'object') return v;
  if (v.__isClass) return 'class ' + v.name;
  if (v.__isUObject || v.Class) return v.__path ? v.__path : (v.Name ? `${v.Class?.name || ''}'${v.Name}'` : '?');
  if (v.__asset) return v.__path || v.Name;
  if (depth > 2) return '…';
  if (Array.isArray(v)) { const a = v.slice(0, 32).map(x => plain(x, depth + 1)); if (v.length > 32) a.push(`… ${v.length} items`); return a; }
  const o = {};
  for (const k of Object.keys(v)) if (!k.startsWith('__')) o[k] = plain(v[k], depth + 1);
  return o;
}

export class DebugLog {
  constructor(engine) {
    this.engine = engine;
    this.issues = [];
    this.counts = new Map();
    this.total = 0;
  }

  // record an issue; self = the object whose script/code raised it
  add(kind, msg, self = null) {
    const e = this.engine, lvl = e.level, p = e.player;
    const key = kind + '|' + msg;
    this.counts.set(key, (this.counts.get(key) || 0) + 1);
    this.total++;
    const rec = {
      kind, msg: String(msg).slice(0, 500),
      map: lvl?.mapName || null,
      time: lvl ? r1(lvl.timeSeconds || 0) : null,
      frame: e.frameNo ?? null,
      object: who(self),
      player: p?.Location ? vec(p.Location) : null,
      repeat: this.counts.get(key),
    };
    this.issues.push(rec);
    if (this.issues.length > MAX_ISSUES) this.issues.splice(0, this.issues.length - MAX_ISSUES);
    this.onIssue?.(rec);
    return rec;
  }

  // the actor in front of the eye: first colliding actor along the view line (or the nearest visible one
  // to the view axis within 15 degrees)
  focusActor(view, maxDist = 4000) {
    const e = this.engine, lvl = e.level;
    if (!lvl || !view) return null;
    const RU = Math.PI / 32768, y = view.rot.Yaw * RU, pt = view.rot.Pitch * RU;
    const d = { X: Math.cos(pt) * Math.cos(y), Y: Math.cos(pt) * Math.sin(y), Z: Math.sin(pt) };
    const s = view.loc, end = { X: s.X + d.X * maxDist, Y: s.Y + d.Y * maxDist, Z: s.Z + d.Z * maxDist };
    let wall = maxDist, hidden = null;
    try {
      const hits = lvl.physics.multiLineCheck(s, end, null, true);
      for (const h of hits) {
        if (h.actor === lvl.levelInfo) { wall = Math.min(wall, h.time * maxDist); break; }
        if (!h.actor || h.actor === e.player || h.actor === view.actor) continue;
        if (h.actor.bHidden || (h.actor.DrawType ?? 1) === 0) { hidden ??= h.actor; continue; } // (invisible blockers only as a fallback)
        return h.actor;
      }
    } catch { /* no physics yet */ }
    let best = null, bestA = Math.cos(15 * Math.PI / 180);
    for (const a of lvl.actors) {
      if (a.__deleted || a.bHidden || a === e.player || a === view.actor || !a.Location || a.bStatic && !a.Mesh) continue;
      const v = { X: a.Location.X - s.X, Y: a.Location.Y - s.Y, Z: a.Location.Z - s.Z }, l = Math.hypot(v.X, v.Y, v.Z);
      if (l < 1 || l > wall + 50) continue;
      const c = (v.X * d.X + v.Y * d.Y + v.Z * d.Z) / l;
      if (c > bestA) { bestA = c; best = a; }
    }
    return best || hidden;
  }

  // every property of an actor (script variables and engine state)
  describeActor(a) {
    if (!a) return null;
    const props = {};
    for (const p of a.Class?.props || []) props[p.key] = plain(a[p.key]);
    const out = {
      ...who(a),
      tag: a.Tag, event: a.Event,
      physics: a.Physics, rot: rot(a.Rotation), vel: vec(a.Velocity),
      collision: { r: a.CollisionRadius, h: a.CollisionHeight, actors: !!a.bCollideActors, blockActors: !!a.bBlockActors, blockPlayers: !!a.bBlockPlayers, world: !!a.bCollideWorld },
      base: who(a.Base), owner: who(a.Owner), zone: a.Region?.Zone?.Name || null,
      anim: a.AnimSequence ? { seq: a.AnimSequence, frame: r1(a.AnimFrame || 0), rate: r1(a.AnimRate || 0) } : null,
      latent: a.__latent ? plain(a.__latent) : null,
      timer: a.TimerRate ? { rate: a.TimerRate, counter: r1(a.TimerCounter || 0), loop: !!a.bTimerLoop } : null,
      touching: (a.__tslots || []).filter(Boolean).map(t => t.Name),
      props,
    };
    return out;
  }

  // a snapshot of the game: where we are, what is around, what went wrong lately
  snapshot({ view = null, focus = undefined, radius = 1500, issues = 100 } = {}) {
    const e = this.engine, lvl = e.level, p = e.player;
    view = view || e.lastView || null;
    const loc = view?.loc || p?.Location;
    const near = [];
    if (lvl && loc) {
      for (const a of lvl.actors) {
        if (a.__deleted || !a.Location || a.bStatic && !a.Mesh) continue;
        const dist = Math.hypot(a.Location.X - loc.X, a.Location.Y - loc.Y, a.Location.Z - loc.Z);
        if (dist <= radius) near.push({ dist: Math.round(dist), ...who(a), physics: a.Physics, hidden: !!a.bHidden, anim: a.AnimSequence || undefined, tag: a.Tag !== a.Class?.name ? a.Tag : undefined, event: a.Event && a.Event !== 'None' ? a.Event : undefined });
      }
      near.sort((x, y) => x.dist - y.dist);
    }
    const f = focus === undefined ? this.focusActor(view) : focus;
    const url = lvl && p ? `?map=${lvl.mapName}&debug=1&pos=${Math.round(p.Location.X)},${Math.round(p.Location.Y)},${Math.round(p.Location.Z)}&yaw=${p.Rotation.Yaw | 0}` : null;
    const top = [...this.counts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 30).map(([k, n]) => ({ n, issue: k }));
    return {
      when: new Date().toISOString(),
      map: lvl?.mapName || null, title: lvl?.levelInfo?.Title || null,
      levelTime: lvl ? r1(lvl.timeSeconds || 0) : null, frame: e.frameNo ?? null,
      paused: !!lvl?.paused,
      reproduce: url,
      player: p ? { ...who(p), rot: rot(p.Rotation), viewRot: rot(p.ViewRotation), vel: vec(p.Velocity), physics: p.Physics, zone: p.Region?.Zone?.Name || null, base: who(p.Base), anim: p.AnimSequence, health: p.Health } : null,
      camera: view ? { loc: vec(view.loc), rot: rot(view.rot), viewTarget: who(view.actor) } : null,
      cutscene: (() => { const c = lvl?.actors?.find(a => a.Class?.isA?.('CutScene') && a.__state && a.__state.name !== 'Idle' && /play|run|act/i.test(a.__state.name)); return c ? who(c) : null; })(),
      focus: this.describeActor(f),
      nearby: near.slice(0, 80),
      issueTotals: { total: this.total, distinct: this.counts.size, top },
      issues: this.issues.slice(-issues),
    };
  }
}
