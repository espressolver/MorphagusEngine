// Save games (UE1 SaveGame / open saveN.usa), stored in browser storage (localStorage).
// A save holds every actor of the level, like the engine's saved level: placed actors as their differences
// from the level as it was at start, actors spawned during play as their differences from the class
// defaults (by name and class), each with its state code position and latent wait (a sleep's time left,
// a move...), disabled probes and touch slots. Loading opens the map, re-creates the spawned actors that
// are missing (no BeginPlay: they come back as saved), removes the ones that no longer exist (no
// Destroyed), and puts every property and state back without re-entering the states.
const PREFIX = 'hpweb.save.';
const VERSION = 2;

function store() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

export function storageGet(key) {
  try { const s = store()?.getItem(PREFIX + key); return s ? JSON.parse(s) : null; } catch { return null; }
}
export function storageSet(key, value) {
  try { store()?.setItem(PREFIX + key, JSON.stringify(value)); return true; } catch (e) { console.warn('save failed', e); return false; }
}
export function storageDelete(key) {
  try { store()?.removeItem(PREFIX + key); } catch { /* ignore */ }
}

// ---- value encoding (object references by name)
const KEEP = Symbol('keep'); // a reference that can't be resolved on load: leave the current value

function enc(v, depth = 0) {
  if (v === null || v === undefined || typeof v !== 'object') return typeof v === 'number' && !Number.isFinite(v) ? 0 : v;
  if (v.__isClass) return { $c: v.name };
  if (v.__asset) return { $a: v.__path };
  if (v.__isUObject) return v.Name ? (v.Location ? { $o: v.Name } : { $u: v.Name }) : null;
  if (depth > 6) return null;
  if (Array.isArray(v)) return v.map(x => enc(x, depth + 1));
  const o = {};
  for (const k in v) if (!k.startsWith('__')) o[k] = enc(v[k], depth + 1);
  return o;
}

function dec(v, ctx) {
  if (v === null || v === undefined || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(x => { const d = dec(x, ctx); return d === KEEP ? null : d; });
  if ('$c' in v) return ctx.vm.cls(v.$c);
  if ('$a' in v) return ctx.vm.findAsset(v.$a) || null;
  if ('$o' in v) return ctx.byName.get(v.$o) || null;
  if ('$u' in v) return KEEP; // non-actor objects (channels' helpers, menu objects) are not saved
  const o = {};
  for (const k in v) { const d = dec(v[k], ctx); o[k] = d === KEEP ? null : d; }
  return o;
}

// engine-maintained or per-session properties
const SKIP = new Set(['Class', 'Level', 'XLevel', 'Region', 'FootRegion', 'HeadRegion', 'Touching', 'Player']);
const isTransient = p => (p.flags & 0x2000) !== 0;

function encodeProps(a) {
  const props = {};
  for (const p of a.Class.props) {
    if (SKIP.has(p.name) || isTransient(p)) continue;
    props[p.key] = JSON.stringify(enc(a[p.key]));
  }
  return props;
}
function defaultProps(cls) {
  if (cls.__saveDefaults) return cls.__saveDefaults;
  const props = {}, d = cls.defaults || {};
  for (const p of cls.props) if (!SKIP.has(p.name) && !isTransient(p)) props[p.key] = JSON.stringify(enc(d[p.key]));
  return (cls.__saveDefaults = props);
}

// where the actor's state code is: the state, which (super)state's code runs and where, the latent wait
function encodeExec(a) {
  const out = { state: a.__state?.name || null };
  const sf = a.__stateFrame;
  if (sf) {
    let depth = 0;
    for (let st = a.__state; st && st !== sf.state; st = st.superState) depth++;
    out.frame = { depth, pc: sf.pc };
  }
  if (a.__latent) out.latent = enc(a.__latent);
  if (a.__disabled?.size) out.disabled = [...a.__disabled];
  const ts = (a.__tslots || []).map(t => (t && !t.__deleted ? t.Name : null));
  if (ts.some(Boolean)) out.touching = ts;
  if (a.__channels?.length) out.channels = a.__channels.filter(c => !c.__deleted).map(c => c.Name);
  return out;
}

// Baseline of every placed actor right after level start; saves store only differences from it.
export function captureBaseline(engine) {
  const base = new Map();
  for (const a of engine.level.actors) if (a.__exp && !a.__deleted) base.set(a, { props: encodeProps(a), state: a.__state?.name || null });
  engine.level.saveBaseline = base;
}

export function snapshotLevel(engine) {
  const lvl = engine.level;
  const base = lvl.saveBaseline || new Map();
  const actors = [];
  for (const a of lvl.actors) {
    if (a.__deleted) continue;
    const b = base.get(a), cur = encodeProps(a), ref = b?.props || defaultProps(a.Class);
    const props = {};
    let n = 0;
    for (const k in cur) if (ref[k] !== cur[k]) { props[k] = JSON.parse(cur[k]); n++; }
    const ex = encodeExec(a);
    // a placed actor just as at level start, with no state code running, needs no entry: loading opens
    // the map with it like that
    if (b && !n && ex.state === b.state && Object.keys(ex).length === 1) continue;
    const entry = { name: a.Name, cls: a.Class.name, props, ...ex };
    if (b) entry.placed = 1;
    actors.push(entry);
  }
  // placed actors that no longer exist (collected pickups, destroyed objects)
  const alive = new Set(lvl.actors.filter(a => !a.__deleted));
  const removed = [...lvl.objMap.values()].filter(a => !alive.has(a) && a.Class && a.Location).map(a => a.Name);
  const p = engine.player;
  return {
    version: VERSION, map: lvl.mapName, time: Date.now(), levelTime: lvl.timeSeconds,
    player: p ? p.Name : null, actors, removed,
  };
}

// take an actor out of the level without any notification (it is simply not in the saved level)
function removeQuietly(lvl, a) {
  if (a.__deleted) return;
  a.__deleted = true; a.bDeleteMe = true; a.__unhashed = true;
  a.__latent = null; a.__stateFrame = null;
  lvl.destroyed.push(a);
  for (const l of lvl.listeners.destroy) l(a);
}

export function restoreLevel(engine, snap) {
  const lvl = engine.level, vm = engine.vm, P = lvl.physics;
  if ((snap.version || 1) < 2) return restoreV1(engine, snap);
  const byName = new Map(lvl.actors.filter(a => !a.__deleted).map(a => [a.Name, a]));
  const saved = new Map(snap.actors.map(s => [s.name, s]));
  // gone since the save: placed ones listed, spawned ones not in the save
  for (const name of snap.removed || []) { const a = byName.get(name); if (a && a !== engine.player) { removeQuietly(lvl, a); byName.delete(name); } }
  for (const a of [...byName.values()]) {
    const s = saved.get(a.Name);
    if (!s || s.cls !== a.Class.name) { if (!a.__exp && a !== lvl.levelInfo) { removeQuietly(lvl, a); byName.delete(a.Name); } }
  }
  // spawned during play and not re-created by the level start: back as they were (no BeginPlay)
  for (const s of snap.actors) {
    if (byName.has(s.name)) continue;
    const cls = vm.cls(s.cls);
    if (!cls) continue;
    const a = lvl.spawn(cls, null, null, null, null, { force: true, noFit: true, noInit: true });
    if (!a) continue;
    a.Name = s.name; a.__path = lvl.mapName + '.' + s.name;
    byName.set(s.name, a);
  }
  const ctx = { vm, byName };
  for (const s of snap.actors) {
    const a = byName.get(s.name);
    if (!a || a.Class.name !== s.cls) continue;
    for (const k in s.props) {
      const v = dec(s.props[k], ctx);
      if (v !== KEEP) a[k] = v;
    }
    // state and where its code is, without EndState / BeginState
    a.__state = s.state ? (a.Class.states.get(String(s.state).toLowerCase()) || a.Class.findState?.(String(s.state).toLowerCase()) || null) : null;
    a.__stateFrame = null;
    if (s.frame && a.__state) {
      let st = a.__state;
      for (let i = 0; i < s.frame.depth && st; i++) st = st.superState;
      if (st) a.__stateFrame = { state: st, pc: s.frame.pc };
    }
    a.__latent = s.latent ? dec(s.latent, ctx) : null;
    if (a.__latent === KEEP) a.__latent = null;
    a.__disabled = s.disabled ? new Set(s.disabled) : null;
    if (s.channels) a.__channels = s.channels.map(n => byName.get(n)).filter(Boolean);
  }
  // touch slots once every actor exists
  for (const s of snap.actors) {
    const a = byName.get(s.name);
    if (!a) continue;
    a.__tslots = s.touching ? s.touching.map(n => (n ? byName.get(n) || null : null)) : null;
    P.syncTouch(a);
  }
  for (const a of lvl.actors) if (!a.__deleted && a.Location) lvl.setActorZone(a, a === lvl.levelInfo);
  const p = snap.player ? byName.get(snap.player) : null;
  if (p && p !== engine.player) engine.player = p;
  if (snap.levelTime !== undefined) { lvl.timeSeconds = snap.levelTime; if (lvl.levelInfo) lvl.levelInfo.TimeSeconds = snap.levelTime; vm.time = snap.levelTime; }
  lvl.cleanupDestroyed();
}

// saves from the first version: placed actors only, states re-entered, the player by its travel data
function restoreV1(engine, snap) {
  const lvl = engine.level, vm = engine.vm;
  const byName = new Map(lvl.actors.map(a => [a.Name, a]));
  const ctx = { vm, byName };
  for (const name of snap.removed || []) { const a = byName.get(name); if (a && a !== engine.player) { a.bStatic = false; a.bNoDelete = false; lvl.destroy(a); } }
  for (const s of snap.actors) {
    const a = byName.get(s.name);
    if (!a || a === engine.player || a.Class.name !== s.cls) continue;
    for (const k in s.props) { const v = dec(s.props[k], ctx); if (v !== KEEP) a[k] = v; }
    if ((s.state || null) !== (a.__state?.name || null)) vm.gotoState(a, s.state || 'None');
  }
  const p = engine.player;
  if (p && snap.player) {
    engine.applyTravel(snap.player.travel);
    lvl.physics.setLocation(p, snap.player.loc);
    p.Rotation = { ...snap.player.rot };
    p.ViewRotation = { ...snap.player.view };
  }
  lvl.cleanupDestroyed();
}
